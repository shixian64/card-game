import {randomBytes,randomUUID} from 'node:crypto';
import {
  newProfileState,migrateProfileState,claimStarter,forgeCardV2,craftCardV2,recycleCardsV2,
  rollChoiceCandidates,rollTenDraw,payCoins,grantCoins,walletSpendable,ownedV2,capacityError,ECONOMY_VERSION,
} from '../src/engine.ts';
import {CARD_MAP,ECONOMY,QUALITY} from '../src/data.ts';
import {createBattle,actBattle} from '../src/battle.ts';
import {createMarketQuery} from './market-query.mjs';
import {createMatch,advanceMatch,actMatch,publicMatch,migrateMatch,MATCH_RULES} from './match.mjs';

function fail(message,status=400,code){const e=new Error(message);e.status=status;if(code)e.code=code;throw e;}
const parse=JSON.parse;
const balance=(n)=>{if(!Number.isSafeInteger(n)||n<0||n>1000000000)fail('资源数量超出范围');return n;};
export function createGameService(db,options={}){
  const now=options.now??Date.now;const forgeRandom=options.forgeRandom;const drawRandom=options.drawRandom;
  // 旧单人局新建开关：默认允许（存续兼容与服务层测试）；正式切换由 index.mjs 传 env
  // LEGACY_MATCH_STARTS=0 关闭——存量局继续按冻结规则结束，不再新开旧 PvE（C03）。
  const legacyMatchStart=options.legacyMatchStart??true;
  const secureRandom=drawRandom??(()=>randomBytes(4).readUInt32LE(0)/4294967296);
  let inTransaction=false;
  function transaction(fn){if(inTransaction)return fn();db.exec('BEGIN IMMEDIATE');inTransaction=true;try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}finally{inTransaction=false;}}
  db.exec(`CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY REFERENCES users(id),code TEXT UNIQUE NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS battles(user_id TEXT PRIMARY KEY REFERENCES users(id),state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS matches(user_id TEXT PRIMARY KEY REFERENCES users(id),state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS active_game_locks(user_id TEXT PRIMARY KEY,kind TEXT NOT NULL,ref_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS listings(id TEXT PRIMARY KEY,seller_id TEXT NOT NULL REFERENCES users(id),card TEXT NOT NULL,price INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,buyer_id TEXT,closed_at INTEGER,fee INTEGER);
  CREATE INDEX IF NOT EXISTS listings_active ON listings(status,created_at);
  CREATE TABLE IF NOT EXISTS operations(user_id TEXT NOT NULL,request_id TEXT NOT NULL,kind TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,request_id));
  CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,coins INTEGER NOT NULL,dust INTEGER NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,flow TEXT);
  CREATE INDEX IF NOT EXISTS ledger_time ON ledger(created_at);
  CREATE TABLE IF NOT EXISTS draw_orders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),mode TEXT NOT NULL,status TEXT NOT NULL,economy_version INTEGER NOT NULL,cost_coins INTEGER NOT NULL,restricted_spent INTEGER NOT NULL,candidates TEXT,chosen_candidate TEXT,result TEXT,created_at INTEGER NOT NULL,claimed_at INTEGER);
  CREATE UNIQUE INDEX IF NOT EXISTS draw_orders_pending ON draw_orders(user_id) WHERE status='pending_choice';
  CREATE TABLE IF NOT EXISTS reward_quota(user_id TEXT NOT NULL REFERENCES users(id),day TEXT NOT NULL,matches INTEGER NOT NULL,PRIMARY KEY(user_id,day));
  `);
  // 旧库缺列时补齐（不重算任何历史值；旧挂单 fee 为空 → 读取端按旧 floor 规则）。
  for(const [table,column,definition] of [['ledger','flow','TEXT'],['listings','fee','INTEGER']]){
    const columns=db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map(row=>row.name);
    if(!columns.includes(column))db.exec('ALTER TABLE '+table+' ADD COLUMN '+column+' '+definition);
  }
  function ensureProfile(user){
    let row=db.prepare('SELECT * FROM profiles WHERE user_id=?').get(user.id);
    if(!row){
      // 新账号：空档案 + starter=pending；不再发旧 1280/360/3 礼包（旧账号由 migrateProfileState 标 legacy_granted）。
      const state=newProfileState(randomBytes(4).readUInt32LE());
      db.prepare('INSERT OR IGNORE INTO profiles(user_id,code,state) VALUES(?,?,?)').run(user.id,'AST-'+randomBytes(4).toString('hex').toUpperCase(),JSON.stringify(state));row=db.prepare('SELECT * FROM profiles WHERE user_id=?').get(user.id);}
    return row;
  }
  function state(userId){const row=db.prepare('SELECT * FROM profiles WHERE user_id=?').get(userId);if(!row)fail('玩家资料不存在',404);
    let parsed;try{parsed=migrateProfileState(parse(row.state));}catch{fail('玩家档案数据损坏',409);}
    return parsed;}
  function battle(userId){const row=db.prepare('SELECT state FROM battles WHERE user_id=?').get(userId);const saved=row?parse(row.state):null;return (saved?.version===2||saved?.version===3)&&[...saved.player,...saved.enemy].every(unit=>Number.isInteger(unit.row)&&Number.isInteger(unit.col)&&Number.isInteger(unit.range)&&[1,2,3].includes(unit.stars)&&['坦克','战士','射手','法师','刺客'].includes(unit.role))?saved:null;}
  function currentMatch(userId){const row=db.prepare('SELECT state FROM matches WHERE user_id=?').get(userId);return row?migrateMatch(parse(row.state)):null;}
  function writeMatch(userId,match){db.prepare('INSERT OR REPLACE INTO matches VALUES(?,?)').run(userId,JSON.stringify(match));}
  function escrowCount(userId){return db.prepare("SELECT COUNT(*) n FROM listings WHERE seller_id=? AND status='active'").get(userId).n;}
  function pendingOrder(userId){return db.prepare("SELECT * FROM draw_orders WHERE user_id=? AND status='pending_choice'").get(userId)??null;}
  function freeCapacity(userId,s,extra){const error=capacityError(s.cards.length,escrowCount(userId),pendingOrder(userId)?1:0,extra);if(error)fail(error,409,'CARD_CAPACITY');}
  // 每日奖励配额：结算时按服务器 UTC 日期在事务内占额，每局只占一次。
  function matchQuota(userId){
    return match=>{
      const day=new Date(now()).toISOString().slice(0,10);
      const count=db.prepare('SELECT matches n FROM reward_quota WHERE user_id=? AND day=?').get(userId,day)?.n??0;
      const {dailyFull,dailyHalf}=MATCH_RULES.reward;
      const factor=count<dailyFull?1:count<dailyFull+dailyHalf?0.5:0;
      const tier=factor===1?'full':factor===0.5?'half':'exhausted';
      if(factor>0)db.prepare('INSERT INTO reward_quota(user_id,day,matches) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET matches=matches+1').run(userId,day);
      return {factor,tier,day,used:count};
    };
  }
  function syncMatch(userId){return transaction(()=>{const previous=currentMatch(userId);const progress=advanceMatch(previous,now(),{rewardQuota:matchQuota(userId)});
    if(!progress.changed)return previous;
    writeMatch(userId,progress.match);const before=state(userId),next=structuredClone(before);
    if(progress.reward){
      if(progress.reward.coins)grantCoins(next,progress.reward.coins,false);
      if(progress.reward.dust){next.frozen??={dust:0,tickets:0};next.frozen.dust+=progress.reward.dust;} // legacy 存局星尘冻结，不可消费
    }
    save(userId,next);for(const round of progress.match.history.slice(previous.history.length))log(userId,'match.round',before,before,round);
    if(progress.reward)log(userId,'match.finish',before,next,{matchId:progress.match.id,wins:progress.match.wins,losses:progress.match.losses,reward:progress.reward},progress.reward.coins>0?'faucet':'transfer');
    return progress.match;});}
  function snapshot(user){ensureProfile(user);const match=syncMatch(user.id);const row=db.prepare('SELECT * FROM profiles WHERE user_id=?').get(user.id);
    const s=state(user.id); // 统一走迁移读取器：损坏档案在此被 409 隔离，不产生半截快照
    const pending=pendingOrder(user.id);
    return {state:{...s,rng:0,pendingDraw:pending?{id:pending.id,mode:pending.mode,candidates:parse(pending.candidates)}:null},battle:battle(user.id),match:publicMatch(match,now()),revision:row.revision,code:row.code};}
  function save(userId,next){balance(next.coins);balance(next.restrictedCoins);if(next.restrictedCoins>next.coins)fail('钱包数据异常');if(next.cards.length>10000)fail('卡牌数量达到上限');
    db.prepare('UPDATE profiles SET state=?,revision=revision+1 WHERE user_id=?').run(JSON.stringify(next),userId);}
  function log(userId,kind,before,after,data={},flow='transfer'){
    const dustDelta=(after.frozen?.dust??0)-(before.frozen?.dust??0);
    db.prepare('INSERT INTO ledger(id,user_id,kind,coins,dust,data,created_at,flow) VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(),userId,kind,after.coins-before.coins,dustDelta,JSON.stringify(data),now(),flow);}
  function findCard(s,uid){const c=s.cards.find(c=>c.uid===uid);if(!c)fail('你不再拥有这张卡',409);return c;}
  function checkUnlocked(userId,uid){const b=battle(userId);if(b?.status==='playing'&&b.player.some(c=>c.cardUid===uid))fail('这张卡正在战斗，结束后再操作',409);}
  function remove(s,uid){const c=findCard(s,uid);s.cards=s.cards.filter(x=>x.uid!==uid);return c;}
  function receive(userId,s,card){freeCapacity(userId,s,1);const uid='c'+s.nextId++;if(!Number.isSafeInteger(s.nextId))fail('卡牌编号达到上限');s.cards.push({...card,uid});return uid;}
  function paymentPreview(s,amount,mode){const restrictedSpent=mode==='allow_restricted'?Math.max(0,amount-walletSpendable(s)):0;return {restrictedSpent,transferable:restrictedSpent===0};}
  function expectTransferable(input,actual){if(input.expectedTransferable!==undefined&&input.expectedTransferable!==actual)fail('支付构成与预期不符：结果将变为自用（不可交易），请重新确认',409,'INPUT_RESTRICTION_CHANGED');}
  function paymentMode(input){return input.paymentMode==='normal_only'?'normal_only':'allow_restricted';}
  function atomic(user,kind,input,fn){
    ensureProfile(user);const requestId=input?.requestId;
    if(typeof requestId!=='string'||!/^[-a-zA-Z0-9]{8,80}$/.test(requestId))fail('缺少有效的操作编号');
    const payload=JSON.stringify(input);
    return transaction(()=>{
      const prior=db.prepare('SELECT * FROM operations WHERE user_id=? AND request_id=?').get(user.id,requestId);
      // 同 requestId 重试：复用已落库的同一次随机结果（不重抽 / 不重扣），只回放记录。
      if(prior){if(prior.kind!==kind||prior.input!==payload)fail('操作编号已被其他请求使用',409);const recorded=parse(prior.result);const current=snapshot(user);return recorded?.replay?{...current,replay:recorded.replay}:current;}
      syncMatch(user.id);const outcome=fn()||{};const result=snapshot(user);
      db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(user.id,requestId,kind,payload,JSON.stringify({ok:true,replay:outcome.replay??null}),now());
      return outcome.replay?{...result,replay:outcome.replay}:result;
    });
  }
  // ─── 抽卡：单抽三选一（begin → pending_choice → claim）与十连一次发十张 ───────
  function beginDraw(user,input){
    const mode=input.mode==='ten'?'ten':input.mode==='choice_one'?'choice_one':null;
    if(!mode)fail('抽卡模式不合法');
    const before=state(user.id);
    if(pendingOrder(user.id))fail('已有待选择的单抽订单，请先完成选择',409,'DRAW_PENDING');
    const cost=mode==='ten'?ECONOMY.tenDrawCost:ECONOMY.singleDrawCost;
    const payMode=paymentMode(input);
    const preview=paymentPreview(before,cost,payMode);
    if(mode==='ten')expectTransferable(input,preview.transferable);
    freeCapacity(user.id,before,mode==='ten'?10:1);
    const next=structuredClone(before);
    const payment=payCoins(next,cost,payMode);
    const orderId=randomUUID();const createdAt=now();
    if(mode==='choice_one'){
      const candidates=rollChoiceCandidates(secureRandom);
      try{db.prepare('INSERT INTO draw_orders(id,user_id,mode,status,economy_version,cost_coins,restricted_spent,candidates,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(orderId,user.id,'choice_one','pending_choice',ECONOMY_VERSION,cost,payment.restrictedSpent,JSON.stringify(candidates),createdAt);}
      catch{fail('已有待选择的单抽订单，请先完成选择',409,'DRAW_PENDING');}
      next.lastDraw={mode:'choice_one',cards:[],orderId};
      return {state:next,replay:{kind:'summon.begin',orderId,candidates,restricted:!payment.transferable},detail:{orderId,mode},flow:'sink'};
    }
    const drawn=rollTenDraw(secureRandom);
    const restricted=!payment.transferable;
    const cards=drawn.map(card=>{const uid='c'+next.nextId++;next.cards.push({uid,defId:card.defId,rank:card.rank,best:0,transferPolicy:restricted?'starter_restricted':'free',originKind:'draw',originRef:orderId,createdEconomyVersion:ECONOMY_VERSION});return {uid,defId:card.defId,rank:card.rank,restricted};});
    db.prepare('INSERT INTO draw_orders(id,user_id,mode,status,economy_version,cost_coins,restricted_spent,result,created_at,claimed_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(orderId,user.id,'ten','claimed',ECONOMY_VERSION,cost,payment.restrictedSpent,JSON.stringify({cards}),createdAt,createdAt);
    next.lastDraw={mode:'ten',cards};
    return {state:next,replay:{kind:'summon.ten',cards,restricted},detail:{orderId,mode:'ten'},flow:'sink'};
  }
  function claimDraw(user,input){
    if(typeof input.orderId!=='string'||typeof input.candidateId!=='string')fail('请指定订单与候选');
    const order=db.prepare('SELECT * FROM draw_orders WHERE id=? AND user_id=?').get(input.orderId,user.id);
    if(!order)fail('订单不存在',404);
    const candidates=order.candidates?parse(order.candidates):[];
    if(order.status==='claimed'){
      // 幂等：同订单同候选的重试只回放原结果，不再发卡；异候选二次领取拒绝。
      if(order.chosen_candidate===input.candidateId)return {state:null,replay:{kind:'summon.claim',card:parse(order.result).card,alreadyClaimed:true},detail:{alreadyClaimed:true},flow:null};
      fail('该订单已领取过，不能选择另一个候选',409,'DRAW_ALREADY_CLAIMED');
    }
    const candidate=candidates.find(entry=>entry.candidateId===input.candidateId);
    if(!candidate)fail('候选无效',409,'DRAW_CANDIDATE_INVALID');
    const before=state(user.id);
    const next=structuredClone(before);
    const restricted=order.restricted_spent>0;
    const uid='c'+next.nextId++;
    next.cards.push({uid,defId:candidate.defId,rank:candidate.rank,best:0,transferPolicy:restricted?'starter_restricted':'free',originKind:'draw',originRef:order.id,createdEconomyVersion:ECONOMY_VERSION});
    const card={uid,defId:candidate.defId,rank:candidate.rank,restricted};
    db.prepare('UPDATE draw_orders SET status=\'claimed\',chosen_candidate=?,result=?,claimed_at=? WHERE id=? AND status=\'pending_choice\'').run(input.candidateId,JSON.stringify({card}),now(),order.id);
    next.lastDraw={mode:'choice_one',cards:[card],orderId:order.id,candidateId:input.candidateId};
    return {state:next,replay:{kind:'summon.claim',card},detail:{orderId:order.id,candidateId:input.candidateId},flow:null};
  }
  function game(user,action,input={}){
    return atomic(user,'game.'+action,input,()=>{
      let before=state(user.id),next=before;let detail={};let replay=null;let flow='transfer';
      if(action.startsWith('match.')){
        const operation=action.slice(6),current=currentMatch(user.id);
        if(operation==='start'){
          if(!legacyMatchStart)fail('旧单人局已停止创建：主玩法已切换为双人对战房间',409,'LEGACY_MATCH_DISABLED');
          const lock=db.prepare('SELECT * FROM active_game_locks WHERE user_id=?').get(user.id);
          if(lock)fail(lock.kind==='duel'?'你有一个进行中的双人对战房间，请先完成':'请先完成当前进行中的对局',409,'ACTIVE_GAME_EXISTS');
          if(current?.status==='playing')fail('请先完成或退出当前对局',409);
          if(!before.cards.length)fail('还没有卡牌：请先领取新手礼包或抽卡',409);
          const match=createMatch(before.cards,randomBytes(4).readUInt32LE(),now());writeMatch(user.id,match);detail={matchId:match.id};
        }else{const match=actMatch(current,operation,input,now());writeMatch(user.id,match);detail={matchId:match.id,round:match.round,gold:match.gold};}
      }else if(action==='starter.claim'){
        if(typeof input.favoriteDefId!=='string'||!input.favoriteDefId)fail('请选择本命星灵');
        next=claimStarter(before,input.favoriteDefId,input.requestId);
        detail={cards:next.cards.length,coins:ECONOMY.starterCoins,favoriteDefId:input.favoriteDefId};
        replay={kind:'starter',favoriteDefId:input.favoriteDefId};flow='faucet';
      }else if(action==='summon.begin'||action==='summon.claim'){
        const outcome=action==='summon.begin'?beginDraw(user,input):claimDraw(user,input);
        if(outcome.state===null){replay=outcome.replay;return {replay};} // 幂等回放：不改资产
        next=outcome.state;detail=outcome.detail;replay=outcome.replay;flow=outcome.flow??'transfer';
      }else if(action==='summon'){
        fail('旧三张包抽卡已停用：请使用单抽三选一或十连',410);
      }else if(action==='forge'){
        if(typeof input.defId!=='string')fail('请选择卡牌');
        const list=ownedV2(before,input.defId);
        const main=input.mainUid!==undefined?list.find(card=>card.uid===input.mainUid):list[0];
        if(!main)fail('指定的主卡不存在');
        const materialUids=Array.isArray(input.materialUids)?input.materialUids:list.filter(card=>card.uid!==main.uid&&card.rank===main.rank).slice(0,QUALITY.forge.materials).map(card=>card.uid);
        for(const uid of [main.uid,...materialUids])checkUnlocked(user.id,uid);
        const cost=QUALITY.forge.coins[main.rank-1];
        const payMode=paymentMode(input);
        const spendPreview=paymentPreview(before,cost,payMode);
        const inputsRestricted=main.transferPolicy==='starter_restricted'||materialUids.some(uid=>findCard(before,uid).transferPolicy==='starter_restricted');
        expectTransferable(input,spendPreview.transferable&&!inputsRestricted);
        const forged=forgeCardV2(before,input.defId,{mainUid:input.mainUid,materialUids:input.materialUids,paymentMode:payMode,opRef:input.requestId,random:forgeRandom});
        next=forged.state;
        detail={card:forged.result.defId,branch:forged.result.branch,from:forged.result.from,to:forged.result.to,returned:forged.result.returnedUids.length,restricted:forged.result.restricted};
        replay={kind:'forge',outcome:forged.result};flow='sink';
      }else if(action==='craft'){
        if(typeof input.defId!=='string')fail('请选择卡牌');
        if(!Object.hasOwn(CARD_MAP,input.defId))fail('未知星灵',400,'CARD_UNKNOWN');
        if(!before.cards.some(card=>card.defId===input.defId))fail('只能制作当前已拥有的卡种',400,'CARD_NOT_OWNED');
        const payMode=paymentMode(input);
        expectTransferable(input,paymentPreview(before,ECONOMY.craftCost,payMode).transferable);
        const crafted=craftCardV2(before,input.defId,payMode,input.requestId);
        next=crafted.state;detail={card:input.defId,uid:crafted.card.uid,restricted:crafted.card.transferPolicy==='starter_restricted'};
        replay={kind:'craft',card:{uid:crafted.card.uid,defId:input.defId,rank:1,restricted:crafted.card.transferPolicy==='starter_restricted'}};flow='sink';
      }else if(action==='recycle'){
        if(!Array.isArray(input.uids)||!input.uids.length)fail('请选择要回收的卡牌实例');
        for(const uid of input.uids)checkUnlocked(user.id,uid);
        const outcome=recycleCardsV2(before,input.uids);
        next=outcome.state;detail={count:outcome.recycled.length,coins:outcome.coins,restrictedCoins:outcome.restrictedCoins};
        replay={kind:'recycle',uids:outcome.recycled.map(card=>card.uid),coins:outcome.coins+outcome.restrictedCoins};flow='faucet';
      }else if(action==='battle.start'||action==='battle.act'||action==='battle.abandon'){
        fail('单场试玩已停用',410); // HTTP 层已 410；防御性兜底，不再提供旧秒结算旁路
      }else fail('不支持的游戏操作',404);
      save(user.id,next);log(user.id,action,before,next,detail,flow);
      return {replay};
    });
  }
  const queryMarket=createMarketQuery(db);
  function marketSnapshot(user,query={}){ensureProfile(user);return queryMarket(user,query);}
  function market(user,action,input={}){
    return atomic(user,'market.'+action,input,()=>{
      const before=state(user.id),next=structuredClone(before);
      if(action==='list'){
        if(!Number.isSafeInteger(input.price)||input.price<10||input.price>100000)fail('售价必须是 10 到 100000 的整数');
        if(db.prepare("SELECT COUNT(*) n FROM listings WHERE seller_id=? AND status='active'").get(user.id).n>=20)fail('最多同时上架 20 张');
        const card=next.cards.find(c=>c.uid===input.uid);if(!card)fail('你不再拥有这张卡',409);
        if(card.transferPolicy!=='free')fail('新手赠送来源的卡仅可自用，不能上架交易',403,'CARD_NOT_TRANSFERABLE');
        checkUnlocked(user.id,input.uid);remove(next,input.uid);
        // 手续费在挂牌时冻结：新挂单 ceil(5%) 且最少 1；旧挂单（无 fee 列值）成交时按旧 floor 规则。
        const fee=Math.max(1,Math.ceil(input.price*0.05));
        db.prepare('INSERT INTO listings(id,seller_id,card,price,status,created_at,buyer_id,closed_at,fee) VALUES(?,?,?,?,?,?,NULL,NULL,?)').run(randomUUID(),user.id,JSON.stringify(card),input.price,'active',now(),fee);
        save(user.id,next);log(user.id,'market.list',before,next,{card:card.defId,price:input.price,fee}, 'transfer');
      }else if(action==='buy'){
        if(typeof input.listingId!=='string')fail('请选择市场挂单');
        const listing=db.prepare("SELECT * FROM listings WHERE id=? AND status='active'").get(input.listingId);if(!listing)fail('商品已售出或已下架',409);
        if(listing.seller_id===user.id)fail('不能购买自己的卡牌');
        // 市场只能用普通额度付款：受限子额度不可购买玩家挂单（反搬运）。
        if(walletSpendable(next)<listing.price)fail(next.coins>=listing.price?'可用于玩家交易的星币不足（赠送额度不能购买挂单）':'星币不足',409,'INSUFFICIENT_MARKET_SPENDABLE');
        const sellerBefore=state(listing.seller_id),seller=structuredClone(sellerBefore),card=parse(listing.card);
        next.coins-=listing.price;next.restrictedCoins=Math.min(next.restrictedCoins,next.coins);
        const fee=listing.fee??Math.floor(listing.price*.05);
        seller.coins=balance(seller.coins+listing.price-fee);
        const uid=receive(user.id,next,card);
        db.prepare("UPDATE listings SET status='sold',buyer_id=?,closed_at=? WHERE id=? AND status='active'").run(user.id,now(),listing.id);
        save(user.id,next);save(listing.seller_id,seller);
        log(user.id,'market.buy',before,next,{listingId:listing.id,card:card.defId,uid,price:listing.price,fee},'transfer');
        log(listing.seller_id,'market.sell',sellerBefore,seller,{listingId:listing.id,card:card.defId,price:listing.price,fee},'transfer');
      }else if(action==='cancel'){
        if(typeof input.listingId!=='string')fail('请选择市场挂单');
        const listing=db.prepare("SELECT * FROM listings WHERE id=? AND status='active' AND seller_id=?").get(input.listingId,user.id);if(!listing)fail('商品不存在或不是你的挂单',409);
        const card=parse(listing.card);
        // 托管卡始终计入容量预算，撤单返还不设额外容量检查（不能因收藏满而丢卡）。
        const uid='c'+next.nextId++;next.cards.push({...card,uid});
        save(user.id,next);
        db.prepare("UPDATE listings SET status='cancelled',closed_at=? WHERE id=?").run(now(),listing.id);log(user.id,'market.cancel',before,next,{card:card.defId,listingId:listing.id,uid},'transfer');
      }else if(action==='gift'){
        if(typeof input.toCode!=='string')fail('请输入对方玩家编号');const receiver=db.prepare('SELECT user_id FROM profiles WHERE code=?').get(input.toCode.trim().toUpperCase());
        if(!receiver)fail('没有找到该玩家',404);if(receiver.user_id===user.id)fail('不能赠送给自己');
        const card=next.cards.find(c=>c.uid===input.uid);if(!card)fail('你不再拥有这张卡',409);
        if(card.transferPolicy!=='free')fail('新手赠送来源的卡仅可自用，不能赠送',403,'CARD_NOT_TRANSFERABLE');
        checkUnlocked(user.id,input.uid);remove(next,input.uid);
        const otherBefore=state(receiver.user_id),other=structuredClone(otherBefore);
        const uid=receive(receiver.user_id,other,card);
        save(user.id,next);save(receiver.user_id,other);
        log(user.id,'gift.send',before,next,{card:card.defId,to:receiver.user_id},'transfer');
        log(receiver.user_id,'gift.receive',otherBefore,other,{card:card.defId,uid,from:user.id},'transfer');
      }else fail('不支持的市场操作',404);
    });
  }
  // ─── 后台：单星币口径，faucet / sink / transfer / migration 分开，玩家成交额不是回收 ───
  const FAUCET_KINDS=new Set(['match.finish','duel.finish','starter.claim','recycle']);
  const SINK_KINDS=new Set(['summon.begin','craft','forge']);
  function adminSummary(days=7){
    const since=Math.floor((now()+8*3600000)/86400000)*86400000-8*3600000-(days-1)*86400000;
    const rows=db.prepare('SELECT l.*,u.name FROM ledger l JOIN users u ON u.id=l.user_id WHERE l.created_at>=? ORDER BY l.created_at DESC').all(since);
    const kinds=Object.create(null);const flows={faucet:{coins:0,count:0},sink:{coins:0,count:0},transfer:{coins:0,count:0},migration:{coins:0,count:0}};
    let volume=0,fees=0,wins=0,losses=0;
    for(const r of rows){
      kinds[r.kind]=(kinds[r.kind]??0)+1;
      const flow=r.flow||(FAUCET_KINDS.has(r.kind)?'faucet':SINK_KINDS.has(r.kind)?'sink':'transfer');
      const bucket=flows[flow]??{coins:0,count:0};bucket.coins+=r.coins;bucket.count++;
      const d=parse(r.data);
      if(r.kind==='market.buy'){volume+=d.price;fees+=d.fee;}
      if(r.kind==='battle.act'||r.kind==='match.round'){if(d.status==='won')wins++;if(d.status==='lost')losses++;}
    }
    let duelRooms=0;
    try{
      const duelStats=db.prepare('SELECT r.outcome,p.side FROM duel_rewards w JOIN duel_rooms r ON r.id=w.room_id JOIN duel_participants p ON p.room_id=w.room_id AND p.user_id=w.user_id WHERE w.created_at>=?').all(since);
      for(const row of duelStats){if(row.outcome===row.side)wins++;else if(row.outcome&&row.outcome!==row.side)losses++;}
      duelRooms=db.prepare("SELECT COUNT(*) n FROM duel_rooms WHERE status='finished' AND finished_at>=?").get(since)?.n??0;
    }catch{/* 单测仅实例化 game 服务时无 duel 表 */}
    // 全服存量（开发规模全量读取；正式运营需换聚合表）。
    let coinsTotal=0,restrictedTotal=0;const cardsByRank=[0,0,0,0,0];let cardsFree=0,cardsRestricted=0;
    for(const row of db.prepare('SELECT state FROM profiles').all()){
      try{const s=migrateProfileState(parse(row.state));coinsTotal+=s.coins;restrictedTotal+=s.restrictedCoins;
        for(const card of s.cards){cardsByRank[card.rank-1]++;if(card.transferPolicy==='free')cardsFree++;else cardsRestricted++;}}catch{/* 损坏档案不计入，dry-run 工具另行报告 */}
    }
    let escrowCards=0;for(const row of db.prepare("SELECT card FROM listings WHERE status='active'").all())escrowCards++;
    const pendingDraws=db.prepare("SELECT COUNT(*) n FROM draw_orders WHERE status='pending_choice'").get().n;
    // 净发行 = 全部流水之和：市场手续费销毁体现在买家/卖家转移行差额中（买家 −100、卖家 +95 → 转移桶 −5）。
    const netMint=flows.faucet.coins+flows.sink.coins+flows.transfer.coins+flows.migration.coins;
    return {source:'server-authoritative',days,generatedAt:new Date().toISOString(),
      players:db.prepare('SELECT COUNT(*) n FROM profiles').get().n,activePlayers:new Set(rows.map(r=>r.user_id)).size,
      activeListings:escrowCards,transactions:kinds['market.buy']??0,gifts:kinds['gift.send']??0,
      battles:(kinds['battle.start']??0)+(kinds['match.start']??0)+duelRooms,wins,losses,volume,fees,
      economy:{coinsTotal,restrictedTotal,flows,netMint,cards:{byRank:cardsByRank,free:cardsFree,restricted:cardsRestricted,escrow:escrowCards},pendingDraws},
      kinds,recent:rows.slice(0,40).map(r=>({id:r.id,user:r.name,kind:r.kind,coins:r.coins,dust:r.dust,flow:r.flow,data:parse(r.data),at:new Date(r.created_at).toISOString()}))};
  }
  return {ensureProfile,snapshot,game,market,marketSnapshot,adminSummary};
}
