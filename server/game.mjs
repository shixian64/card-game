import {randomBytes,randomUUID} from 'node:crypto';
import {initialState,summon,strengthen,craft,recycle} from '../src/engine.ts';
import {createBattle,actBattle} from '../src/battle.ts';
import {createMarketQuery} from './market-query.mjs';
import {createMatch,advanceMatch,actMatch,publicMatch} from './match.mjs';

function fail(message,status=400){const e=new Error(message);e.status=status;throw e;}
const parse=JSON.parse;
const balance=(n)=>{if(!Number.isSafeInteger(n)||n<0||n>1000000000)fail('资源数量超出范围');return n;};
export function createGameService(db,options={}){
  const now=options.now??Date.now;let inTransaction=false;
  function transaction(fn){if(inTransaction)return fn();db.exec('BEGIN IMMEDIATE');inTransaction=true;try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}finally{inTransaction=false;}}
  db.exec(`CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY REFERENCES users(id),code TEXT UNIQUE NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS battles(user_id TEXT PRIMARY KEY REFERENCES users(id),state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS matches(user_id TEXT PRIMARY KEY REFERENCES users(id),state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS listings(id TEXT PRIMARY KEY,seller_id TEXT NOT NULL REFERENCES users(id),card TEXT NOT NULL,price INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,buyer_id TEXT,closed_at INTEGER);
  CREATE INDEX IF NOT EXISTS listings_active ON listings(status,created_at);
  CREATE TABLE IF NOT EXISTS operations(user_id TEXT NOT NULL,request_id TEXT NOT NULL,kind TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,request_id));
  CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,coins INTEGER NOT NULL,dust INTEGER NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS ledger_time ON ledger(created_at);
  `);
  function ensureProfile(user){
    let row=db.prepare('SELECT * FROM profiles WHERE user_id=?').get(user.id);
    if(!row){const state=initialState(randomBytes(4).readUInt32LE());state.run=null;state.results=[];state.lineup=[];
      db.prepare('INSERT OR IGNORE INTO profiles(user_id,code,state) VALUES(?,?,?)').run(user.id,'AST-'+randomBytes(4).toString('hex').toUpperCase(),JSON.stringify(state));row=db.prepare('SELECT * FROM profiles WHERE user_id=?').get(user.id);}
    return row;
  }
  function state(userId){const row=db.prepare('SELECT * FROM profiles WHERE user_id=?').get(userId);if(!row)fail('玩家资料不存在',404);return parse(row.state);}
  function battle(userId){const row=db.prepare('SELECT state FROM battles WHERE user_id=?').get(userId);const saved=row?parse(row.state):null;return saved?.version===2&&[...saved.player,...saved.enemy].every(unit=>Number.isInteger(unit.row)&&Number.isInteger(unit.col)&&Number.isInteger(unit.range)&&[1,2,3].includes(unit.stars)&&['坦克','战士','射手','法师','刺客'].includes(unit.role))?saved:null;}
  function currentMatch(userId){const row=db.prepare('SELECT state FROM matches WHERE user_id=?').get(userId);return row?parse(row.state):null;}
  function writeMatch(userId,match){db.prepare('INSERT OR REPLACE INTO matches VALUES(?,?)').run(userId,JSON.stringify(match));}
  function syncMatch(userId){return transaction(()=>{const previous=currentMatch(userId);const progress=advanceMatch(previous,now());if(!progress.changed)return previous;writeMatch(userId,progress.match);const before=state(userId),next=structuredClone(before);if(progress.reward){next.coins+=progress.reward.coins;next.dust+=progress.reward.dust;}save(userId,next);for(const round of progress.match.history.slice(previous.history.length))log(userId,'match.round',before,before,round);if(progress.reward)log(userId,'match.finish',before,next,{matchId:progress.match.id,wins:progress.match.wins,losses:progress.match.losses});return progress.match;});}
  function snapshot(user){ensureProfile(user);const match=syncMatch(user.id);const row=db.prepare('SELECT * FROM profiles WHERE user_id=?').get(user.id);return {state:{...parse(row.state),rng:0},battle:battle(user.id),match:publicMatch(match,now()),revision:row.revision,code:row.code};}
  function save(userId,next){balance(next.coins);balance(next.dust);if(next.cards.length>10000)fail('卡牌数量达到上限');db.prepare('UPDATE profiles SET state=?,revision=revision+1 WHERE user_id=?').run(JSON.stringify(next),userId);}
  function log(userId,kind,before,after,data={}){db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)').run(randomUUID(),userId,kind,after.coins-before.coins,after.dust-before.dust,JSON.stringify(data),Date.now());}
  function findCard(s,uid){const c=s.cards.find(c=>c.uid===uid);if(!c)fail('你不再拥有这张卡',409);return c;}
  function checkUnlocked(userId,uid){const b=battle(userId);if(b?.status==='playing'&&b.player.some(c=>c.cardUid===uid))fail('这张卡正在战斗，结束后再操作',409);}
  function remove(s,uid){const c=findCard(s,uid);s.cards=s.cards.filter(x=>x.uid!==uid);if(!s.cards.some(x=>x.defId===c.defId))s.lineup=s.lineup.filter(x=>x!==c.defId);return c;}
  function receive(s,card){if(s.cards.length>=10000)fail('对方卡牌数量达到上限',409);const uid='c'+s.nextId++;if(!Number.isSafeInteger(s.nextId))fail('卡牌编号达到上限');s.cards.push({...card,uid});return uid;}
  function atomic(user,kind,input,fn){
    ensureProfile(user);const requestId=input?.requestId;
    if(typeof requestId!=='string'||!/^[-a-zA-Z0-9]{8,80}$/.test(requestId))fail('缺少有效的操作编号');
    const payload=JSON.stringify(input);
    return transaction(()=>{
      const prior=db.prepare('SELECT * FROM operations WHERE user_id=? AND request_id=?').get(user.id,requestId);
      if(prior){if(prior.kind!==kind||prior.input!==payload)fail('操作编号已被其他请求使用',409);return snapshot(user);}
      syncMatch(user.id);fn();const result=snapshot(user);
      db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(user.id,requestId,kind,payload,JSON.stringify({ok:true}),now());
      return result;
    });
  }  function game(user,action,input={}){
    return atomic(user,'game.'+action,input,()=>{
      let before=state(user.id),next=before;let detail={};
      if(action.startsWith('match.')){
        const operation=action.slice(6),current=currentMatch(user.id);
        if(operation==='start'){
          if(current?.status==='playing')fail('请先完成或退出当前对局',409);
          const match=createMatch(before.cards,randomBytes(4).readUInt32LE(),now());writeMatch(user.id,match);detail={matchId:match.id};
        }else{const match=actMatch(current,operation,input,now());writeMatch(user.id,match);detail={matchId:match.id,round:match.round,gold:match.gold};}
      }else if(action==='summon')next=summon(before);
      else if(['strengthen','craft','recycle'].includes(action)){
        if(typeof input.defId!=='string')fail('请选择卡牌');
        if(action!=='craft')for(const c of before.cards.filter(c=>c.defId===input.defId))checkUnlocked(user.id,c.uid);
        next=action==='strengthen'?strengthen(before,input.defId):action==='craft'?craft(before,input.defId):recycle(before,input.defId);
        detail={card:input.defId};
      }else if(action==='battle.start'){
        const current=battle(user.id);if(current?.status==='playing')fail('请先完成当前战斗',409);
        if(!Array.isArray(input.uids)||input.uids.length!==6||new Set(input.uids).size!==6)fail('请选择 6 张不同的卡牌');
        const team=input.uids.map(uid=>findCard(before,uid));
        const b=createBattle(team,randomBytes(4).readUInt32LE(),input.slots);
        db.prepare('INSERT OR REPLACE INTO battles VALUES(?,?)').run(user.id,JSON.stringify(b));detail={battleId:b.id,team:team.map(c=>c.defId)};
      }else if(action==='battle.act'){
        const current=battle(user.id);if(!current||current.status!=='playing')fail('没有进行中的战斗',409);
        const b=actBattle(current,input.action);db.prepare('UPDATE battles SET state=? WHERE user_id=?').run(JSON.stringify(b),user.id);
        detail={battleId:b.id,status:b.status,round:b.round};
        if(b.status!=='playing'){next=structuredClone(before);next.coins+=b.status==='won'?120:30;next.dust+=b.status==='won'?20:5;}
      }else if(action==='battle.abandon'){
        const current=battle(user.id);if(!current)fail('没有可调整的战斗',409);
        db.prepare('DELETE FROM battles WHERE user_id=?').run(user.id);detail={battleId:current.id};
      }else fail('不支持的游戏操作',404);
      save(user.id,next);log(user.id,action,before,next,action==='summon'?{cards:next.lastSummon}:detail);
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
        checkUnlocked(user.id,input.uid);const card=remove(next,input.uid);
        db.prepare('INSERT INTO listings VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),user.id,JSON.stringify(card),input.price,'active',Date.now(),null,null);
        save(user.id,next);log(user.id,'market.list',before,next,{card:card.defId,price:input.price});
      }else if(action==='buy'){
        if(typeof input.listingId!=='string')fail('请选择市场挂单');
        const listing=db.prepare("SELECT * FROM listings WHERE id=? AND status='active'").get(input.listingId);if(!listing)fail('商品已售出或已下架',409);
        if(listing.seller_id===user.id)fail('不能购买自己的卡牌');
        if(next.coins<listing.price)fail('星币不足');const sellerBefore=state(listing.seller_id),seller=structuredClone(sellerBefore),card=parse(listing.card);
        next.coins-=listing.price;const fee=Math.floor(listing.price*.05);seller.coins=balance(seller.coins+listing.price-fee);
        const uid=receive(next,card);
        db.prepare("UPDATE listings SET status='sold',buyer_id=?,closed_at=? WHERE id=? AND status='active'").run(user.id,Date.now(),listing.id);
        save(user.id,next);save(listing.seller_id,seller);log(user.id,'market.buy',before,next,{listingId:listing.id,card:card.defId,uid,price:listing.price,fee});log(listing.seller_id,'market.sell',sellerBefore,seller,{listingId:listing.id,card:card.defId,price:listing.price,fee});
      }else if(action==='cancel'){
        if(typeof input.listingId!=='string')fail('请选择市场挂单');
        const listing=db.prepare("SELECT * FROM listings WHERE id=? AND status='active' AND seller_id=?").get(input.listingId,user.id);if(!listing)fail('商品不存在或不是你的挂单',409);
        const card=parse(listing.card);receive(next,card);save(user.id,next);
        db.prepare("UPDATE listings SET status='cancelled',closed_at=? WHERE id=?").run(Date.now(),listing.id);log(user.id,'market.cancel',before,next,{card:card.defId,listingId:listing.id});
      }else if(action==='gift'){
        if(typeof input.toCode!=='string')fail('请输入对方玩家编号');const receiver=db.prepare('SELECT user_id FROM profiles WHERE code=?').get(input.toCode.trim().toUpperCase());
        if(!receiver)fail('没有找到该玩家',404);if(receiver.user_id===user.id)fail('不能赠送给自己');
        checkUnlocked(user.id,input.uid);const card=remove(next,input.uid),otherBefore=state(receiver.user_id),other=structuredClone(otherBefore);
        const uid=receive(other,card);save(user.id,next);save(receiver.user_id,other);
        log(user.id,'gift.send',before,next,{card:card.defId,to:receiver.user_id});log(receiver.user_id,'gift.receive',otherBefore,other,{card:card.defId,uid,from:user.id});
      }else fail('不支持的市场操作',404);
    });
  }
  function adminSummary(days=7){
    const since=Math.floor((Date.now()+8*3600000)/86400000)*86400000-8*3600000-(days-1)*86400000;
    const rows=db.prepare('SELECT l.*,u.name FROM ledger l JOIN users u ON u.id=l.user_id WHERE l.created_at>=? ORDER BY l.created_at DESC').all(since);
    const kinds=Object.create(null),resources={coinsIn:0,coinsOut:0,dustIn:0,dustOut:0};let volume=0,fees=0,wins=0,losses=0;
    for(const r of rows){kinds[r.kind]=(kinds[r.kind]??0)+1;for(const k of ['coins','dust'])resources[k+(r[k]>=0?'In':'Out')]+=Math.abs(r[k]);const d=parse(r.data);if(r.kind==='market.buy'){volume+=d.price;fees+=d.fee;}if(r.kind==='battle.act'||r.kind==='match.round'){if(d.status==='won')wins++;if(d.status==='lost')losses++;}}
    return {source:'server-authoritative',days,generatedAt:new Date().toISOString(),players:db.prepare('SELECT COUNT(*) n FROM profiles').get().n,activePlayers:new Set(rows.map(r=>r.user_id)).size,activeListings:db.prepare("SELECT COUNT(*) n FROM listings WHERE status='active'").get().n,transactions:kinds['market.buy']??0,gifts:kinds['gift.send']??0,battles:(kinds['battle.start']??0)+(kinds['match.start']??0),wins,losses,volume,fees,resources,kinds,recent:rows.slice(0,40).map(r=>({id:r.id,user:r.name,kind:r.kind,coins:r.coins,dust:r.dust,data:parse(r.data),at:new Date(r.created_at).toISOString()}))};
  }
  return {ensureProfile,snapshot,game,market,marketSnapshot,adminSummary};
}
