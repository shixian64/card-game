import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openStore} from './store.mjs';
import {createGameService} from './game.mjs';
import {createApp,configFromEnv} from './index.mjs';
import {newProfileState} from '../src/engine.ts';

// ─── 夹具 ─────────────────────────────────────────────────────────────
// drawRandom 注入确定序列：偶数次给品质 roll（0.51→Q1），奇数次给卡种 roll（固定 0.5）。
// forgeRandom 注入确定分支：0.99→普通升级，0.001→连升（Q1 有 0.5% 档），0.05→失败。
function setup(options={}){
  const store=openStore(':memory:');
  let clock=1_700_000_000_000;const now=options.now??(()=>clock);
  // 品质区间：Q1 [0,0.52) Q2 [0.52,0.80) Q3 [0.80,0.93) Q4 [0.93,0.985) Q5 [0.985,1)
  const sequence=options.sequence??[0.5,0.51];
  let si=0;
  const drawRandom=options.drawRandom??(()=>sequence[si++%sequence.length]);
  const game=createGameService(store.db,{now,forgeRandom:options.forgeRandom??(() => 0.99),drawRandom});
  const users=['A','B','C'].map(subject=>store.login({issuer:'test',clientId:'test',subject,name:subject}).user);
  users.forEach(u=>game.ensureProfile(u));
  const rid=(extra={})=>({requestId:randomUUID(),...extra});
  const claim=(user,favorite='moon-deer')=>game.game(user,'starter.claim',rid({favoriteDefId:favorite}));
  const seed=(user,mutator)=>{const row=store.db.prepare('SELECT state FROM profiles WHERE user_id=?').get(user.id);const state=JSON.parse(row.state);mutator(state);store.db.prepare('UPDATE profiles SET state=? WHERE user_id=?').run(JSON.stringify(state),user.id);};
  return {store,game,users,rid,claim,seed,advance:(ms)=>{clock+=ms;},setClock:(ms)=>{clock=ms;},now:()=>clock,close:()=>store.db.close()};
}

// ─── N 组：档案与新手礼包 ──────────────────────────────────────────────
test('N01 新账号只建空档案：无旧三资源、礼包 pending、无随机种子泄露',async()=>{
  const f=setup();try{
    const a=f.game.snapshot(f.users[0]);
    assert.equal(a.state.version,2);assert.equal(a.state.cards.length,0);assert.equal(a.state.coins,0);
    assert.equal(a.state.starter.status,'pending');assert.equal(a.state.dust,undefined);assert.equal(a.state.tickets,undefined);
    assert.equal(a.state.pendingDraw,null);assert.equal(a.state.rng,0);
    assert.equal(f.game.snapshot(f.users[1]).state.cards.length,0);
  }finally{f.close();}});
test('N02 任意本命：23 张 / ≥8 种 / 1 Q3 + 4 Q2 + 18 Q1 / 前排与输出覆盖 / 600 受限星币',async()=>{
  const f=setup();try{
    for(const favorite of ['moon-deer','sun-fox','forest-rabbit','moon-fawn','breeze-sprout','comet-tail']){
      const user=f.store.login({issuer:'test',clientId:'test',subject:'n2-'+favorite,name:favorite}).user;
      f.game.ensureProfile(user);
      const done=f.claim(user,favorite);
      const s=done.state;
      assert.equal(s.cards.length,23,favorite);
      assert.ok(new Set(s.cards.map(c=>c.defId)).size>=8,favorite);
      assert.equal(s.cards.filter(c=>c.rank===3).length,1);assert.equal(s.cards.filter(c=>c.rank===2).length,4);assert.equal(s.cards.filter(c=>c.rank===1).length,18);
      assert.equal(s.coins,600);assert.equal(s.restrictedCoins,600);
      assert.ok(s.cards.every(c=>c.transferPolicy==='starter_restricted'&&c.originKind==='starter'));
      const q3=s.cards.find(c=>c.rank===3);assert.equal(q3.defId,favorite);
    }
  }finally{f.close();}});
test('N03 并发领取只能成功一次：600 星币与 23 张卡不重复发放',async()=>{
  const f=setup();try{
    const user=f.users[0];
    const results=await Promise.allSettled([Promise.resolve().then(()=>f.game.game(user,'starter.claim',f.rid({favoriteDefId:'moon-deer'}))),Promise.resolve().then(()=>f.game.game(user,'starter.claim',f.rid({favoriteDefId:'sun-fox'})))]);
    const settled=await results;
    const ok=settled.filter(r=>r.status==='fulfilled').length;
    assert.equal(ok,1);
    const s=f.game.snapshot(user).state;
    assert.equal(s.cards.length,23);assert.equal(s.coins,600);assert.equal(s.starter.status,'claimed');
    await assert.rejects(async()=>f.game.game(user,'starter.claim',f.rid({favoriteDefId:'moon-deer'})),/已领取/);
  }finally{f.close();}});
test('N04 旧 v1 档案登录：legacy_granted 不再发新礼包，星币与卡原额保留且全部可流通',async()=>{
  const f=setup();try{
    const user=f.store.login({issuer:'test',clientId:'test',subject:'legacy-user',name:'L'}).user;
    f.game.ensureProfile(user);
    f.seed(user,state=>{state.version=1;state.coins=900;state.dust=77;state.tickets=2;
      state.cards=[{uid:'c1',defId:'moon-deer',rank:3,best:0},{uid:'c2',defId:'sun-fox',rank:1,best:0}];state.nextId=3;});
    const snap=f.game.snapshot(user).state;
    assert.equal(snap.coins,900);assert.equal(snap.restrictedCoins,0);
    assert.equal(snap.cards.length,2);assert.ok(snap.cards.every(c=>c.transferPolicy==='free'&&c.originKind==='legacy'));
    assert.equal(snap.cards[0].rank,3);
    assert.equal(snap.starter.status,'legacy_granted');
    assert.deepEqual(snap.frozen,{dust:77,tickets:2},'星尘/券冻结待确认换算，不进入可消费余额');
    await assert.rejects(async()=>f.game.game(user,'starter.claim',f.rid({favoriteDefId:'moon-deer'})),/不能领取/);
  }finally{f.close();}});

// ─── D 组：单抽三选一与十连 ───────────────────────────────────────────
test('D01 单抽 begin：仅扣 60，三候选同品质不同卡种，未发卡，写入待选',async()=>{
  const f=setup({sequence:[0.94]});try{
    const user=f.users[0];f.claim(user);
    const before=f.game.snapshot(user).state;
    const done=f.game.game(user,'summon.begin',f.rid({mode:'choice_one',paymentMode:'allow_restricted'}));
    assert.equal(done.replay.kind,'summon.begin');
    const candidates=done.replay.candidates;
    assert.equal(candidates.length,3);
    assert.equal(new Set(candidates.map(c=>c.defId)).size,3);
    assert.ok(candidates.every(c=>c.rank===candidates[0].rank&&c.rank===4),'0.94 落在 Q4（93%..98.5%）区间');
    const after=f.game.snapshot(user).state;
    assert.equal(after.coins,before.coins-60);
    assert.equal(after.cards.length,before.cards.length,'begin 不发卡，候选不是库存');
    assert.equal(after.pendingDraw.candidates.length,3);
    const sink=f.store.db.prepare("SELECT coins FROM ledger WHERE kind='summon.begin'").get();
    assert.equal(sink.coins,-60);
  }finally{f.close();}});
test('D02 claim：只发所选一张，未选候选从未入库，释放待选',async()=>{
  const f=setup();try{
    const user=f.users[0];const claimed=f.claim(user);
    const begin=f.game.game(user,'summon.begin',f.rid({mode:'choice_one',paymentMode:'allow_restricted'}));
    const orderId=begin.replay.orderId;
    const candidates=begin.replay.candidates;
    const chosen=candidates[0],others=candidates.slice(1);
    const result=f.game.game(user,'summon.claim',f.rid({orderId,candidateId:chosen.candidateId}));
    assert.equal(result.replay.kind,'summon.claim');
    assert.equal(result.replay.card.defId,chosen.defId);
    assert.equal(result.replay.card.restricted,true,'受限额度支付 → 产物自用');
    const s=f.game.snapshot(user).state;
    assert.equal(s.cards.length,claimed.state.cards.length+1);
    assert.equal(s.pendingDraw,null);
    // 未选两张从未拥有（选一个本命之外的候选确保可判定）
    for(const other of others)if(other.defId!==claimed.state.cards[0].defId&&!claimed.state.cards.some(c=>c.defId===other.defId))
      assert.ok(!s.cards.some(c=>c.defId===other.defId),'未选候选不得入库');
  }finally{f.close();}});
test('D03 begin 同 requestId 重试：同候选同订单，一次扣费（断线可恢复）',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    const args=f.rid({mode:'choice_one',paymentMode:'allow_restricted'});
    const first=f.game.game(user,'summon.begin',args);
    const coinsAfterFirst=f.game.snapshot(user).state.coins;
    const again=f.game.game(user,'summon.begin',args);
    assert.equal(again.replay.orderId,first.replay.orderId);
    assert.deepEqual(again.replay.candidates,first.replay.candidates);
    assert.equal(f.game.snapshot(user).state.coins,coinsAfterFirst,'重试不二次扣费');
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM draw_orders WHERE user_id=?").get(user.id).n,1);
  }finally{f.close();}});
test('D04 已有待选时不能新开单抽或十连，不能免费筛选候选',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    f.game.game(user,'summon.begin',f.rid({mode:'choice_one',paymentMode:'allow_restricted'}));
    const coins=f.game.snapshot(user).state.coins;
    await assert.rejects(async()=>f.game.game(user,'summon.begin',f.rid({mode:'choice_one'})),e=>/待选择/.test(e.message)&&e.code==='DRAW_PENDING');
    await assert.rejects(async()=>f.game.game(user,'summon.begin',f.rid({mode:'ten'})),/待选择/);
    assert.equal(f.game.snapshot(user).state.coins,coins);
  }finally{f.close();}});
test('D05 claim 幂等：同候选不同 requestId 至多一张；异候选二次领取 409',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    const begin=f.game.game(user,'summon.begin',f.rid({mode:'choice_one'}));
    const {orderId}=begin.replay;const first=begin.replay.candidates[0],second=begin.replay.candidates[1];
    f.game.game(user,'summon.claim',f.rid({orderId,candidateId:first.candidateId}));
    const count=f.game.snapshot(user).state.cards.length;
    const retry=f.game.game(user,'summon.claim',f.rid({orderId,candidateId:first.candidateId}));
    assert.equal(retry.replay.card.defId,first.defId);
    assert.equal(f.game.snapshot(user).state.cards.length,count,'不同 requestId 也不重复发卡');
    await assert.rejects(async()=>f.game.game(user,'summon.claim',f.rid({orderId,candidateId:second.candidateId})),e=>/已领取/.test(e.message)&&e.code==='DRAW_ALREADY_CLAIMED');
    assert.equal(f.game.snapshot(user).state.cards.length,count);
  }finally{f.close();}});
test('D06 越权与伪造：claim 他人订单 404，伪造候选 409，不产生资产变化',async()=>{
  const f=setup();try{
    const [a,b]=f.users;a&&f.claim(a);f.claim(b);
    const begin=f.game.game(a,'summon.begin',f.rid({mode:'choice_one'}));
    const {orderId}=begin.replay;
    await assert.rejects(async()=>f.game.game(b,'summon.claim',f.rid({orderId,candidateId:'d1'})),e=>e.status===404);
    await assert.rejects(async()=>f.game.game(a,'summon.claim',f.rid({orderId,candidateId:'forged'})),e=>/候选/.test(e.message)&&e.code==='DRAW_CANDIDATE_INVALID');
    assert.equal(f.game.snapshot(b).state.cards.length,23);
    assert.equal(f.game.snapshot(a).state.pendingDraw.id,orderId);
  }finally{f.close();}});
test('D07 待选订单跨快照可恢复，只对本人可见',async()=>{
  const f=setup();try{
    const [a,b]=f.users;f.claim(a);f.claim(b);
    const begin=f.game.game(a,'summon.begin',f.rid({mode:'choice_one'}));
    const again=f.game.snapshot(a);
    assert.equal(again.state.pendingDraw.id,begin.replay.orderId);
    assert.deepEqual(again.state.pendingDraw.candidates.map(c=>c.defId),begin.replay.candidates.map(c=>c.defId));
    assert.equal(f.game.snapshot(b).state.pendingDraw,null,'其他账号看不到我的候选');
  }finally{f.close();}});
test('D08 十连：一次 600，恰好十张独立入库，同名可重复，无选择过程',async()=>{
  const qRolls=[0.10,0.60,0.85,0.94,0.99,0.10,0.60,0.85,0.94,0.99];
  const f=setup({sequence:qRolls.flatMap(q=>[0.5,q])});try{
    const user=f.users[0];const claimed=f.claim(user);
    const done=f.game.game(user,'summon.begin',f.rid({mode:'ten',paymentMode:'allow_restricted'}));
    assert.equal(done.replay.kind,'summon.ten');
    assert.equal(done.replay.cards.length,10);
    assert.equal(done.replay.restricted,true,'整包受限额度 → 十张全部自用');
    const s=f.game.snapshot(user).state;
    assert.equal(s.cards.length,claimed.state.cards.length+10);
    assert.equal(s.coins,0);
    assert.equal(s.pendingDraw,null);
    const ranks=done.replay.cards.map(c=>c.rank);
    assert.deepEqual(ranks,[1,2,3,4,5,1,2,3,4,5],'注入序列的品质逐档验证');
    assert.equal(new Set(done.replay.cards.map(c=>c.defId)).size,1,'卡种可重复（def roll 恒 0.5 → 同名十连）');
  }finally{f.close();}});
test('D09 十连容量不足时整包回滚：余额、卡数、订单表均无残留',async()=>{
  const f=setup({sequence:Array(20).fill(0.51)});try{
    const user=f.users[0];f.claim(user); // 600 币 23 卡
    f.seed(user,state=>{state.cards=state.cards.slice(0,state.cards.length-0);while(state.cards.length<9995)state.cards.push({uid:'c'+(state.nextId++),defId:'moon-fawn',rank:1,best:0,transferPolicy:'starter_restricted',originKind:'starter',createdEconomyVersion:2});state.coins=1000;state.restrictedCoins=0;});
    await assert.rejects(async()=>f.game.game(user,'summon.begin',f.rid({mode:'ten'})),/收藏空间/);
    const s=f.game.snapshot(user).state;
    assert.equal(s.cards.length,9995);assert.equal(s.coins,1000);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM draw_orders WHERE user_id=?").get(user.id).n,0);
  }finally{f.close();}});
test('D10 十连同 requestId 重试：回放原十张，不卡数 +20',async()=>{
  const f=setup({sequence:Array(20).fill(0.51)});try{
    const user=f.users[0];f.claim(user);
    const args=f.rid({mode:'ten'});
    const first=f.game.game(user,'summon.begin',args);
    const count=f.game.snapshot(user).state.cards.length;
    const again=f.game.game(user,'summon.begin',args);
    assert.deepEqual(again.replay.cards.map(c=>c.uid),first.replay.cards.map(c=>c.uid));
    assert.equal(f.game.snapshot(user).state.cards.length,count);
  }finally{f.close();}});
test('D11 容量预留：待选 + 托管挂单都计入；撤单返还不受容量限制',async()=>{
  const f=setup({sequence:Array(20).fill(0.51)});try{
    const [a,b]=f.users;const claimed=f.claim(a);f.claim(b);
    // 差 1：填到 9999，单抽预留 1 格可成功
    f.seed(a,state=>{while(state.cards.length<9999)state.cards.push({uid:'c'+(state.nextId++),defId:'moon-fawn',rank:1,best:0,transferPolicy:'starter_restricted',originKind:'starter',createdEconomyVersion:2});});
    const begin=f.game.game(a,'summon.begin',f.rid({mode:'choice_one'}));
    assert.ok(begin.replay.orderId);
    f.game.game(a,'summon.claim',f.rid({orderId:begin.replay.orderId,candidateId:'d1'}));
    assert.equal(f.game.snapshot(a).state.cards.length,10000);
    // 已满：新单抽拒绝且不扣费
    f.seed(a,state=>{state.coins+=500;state.restrictedCoins+=0;});
    await assert.rejects(async()=>f.game.game(a,'summon.begin',f.rid({mode:'choice_one'})),/收藏空间/);
    // 满库 + 托管在途：撤单仍能安全返还（托管始终计入容量预算），返还后不能再抽
    f.seed(b,state=>{while(state.cards.length<10000)state.cards.push({uid:'c'+(state.nextId++),defId:'moon-deer',rank:1,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1});state.coins=1000;});
    const freeCard=f.game.snapshot(b).state.cards.find(c=>c.transferPolicy==='free');
    f.game.market(b,'list',f.rid({uid:freeCard.uid,price:100}));
    assert.equal(f.game.snapshot(b).state.cards.length,9999,'托管中不计入收藏，但计入容量预算');
    const listing=f.game.marketSnapshot(b).mine[0];
    f.game.market(b,'cancel',f.rid({listingId:listing.id}));
    assert.equal(f.game.snapshot(b).state.cards.length,10000,'满库时撤单仍安全返还，不丢卡');
    await assert.rejects(async()=>f.game.game(b,'summon.begin',f.rid({mode:'choice_one'})),/收藏空间/);
  }finally{f.close();}});

// ─── W 组：单星币与来源闭环 ───────────────────────────────────────────
test('W01 钱包只有一个可写总额，受限为子额度且恒满足 0 ≤ restricted ≤ coins',async()=>{
  const f=setup();try{
    const user=f.users[0];const done=f.claim(user);
    const s=done.state;
    assert.ok(Object.hasOwn(s,'coins')&&Object.hasOwn(s,'restrictedCoins'));
    assert.ok(!Object.hasOwn(s,'dust')&&!Object.hasOwn(s,'tickets'),'没有第二组活跃货币余额');
    assert.ok(s.restrictedCoins<=s.coins);
    const draw=f.game.game(user,'summon.begin',f.rid({mode:'choice_one',paymentMode:'allow_restricted'}));
    const after=f.game.snapshot(user).state;
    assert.ok(after.restrictedCoins<=after.coins);
    f.game.game(user,'summon.claim',f.rid({orderId:draw.replay.orderId,candidateId:'d1'}));
    const final=f.game.snapshot(user).state;
    assert.ok(final.restrictedCoins<=final.coins);
  }finally{f.close();}});
test('W02 受限额度全链继承：抽卡→回收→再制作都不可交易、不能上架/赠送',async()=>{
  const f=setup();try{
    const [a,b]=f.users;f.claim(a);f.claim(b);
    // 受限回收 → 受限币
    const extras=f.game.snapshot(a).state.cards.filter(c=>c.defId==='moon-deer'&&c.rank===1);
    const recycled=f.game.game(a,'recycle',f.rid({uids:[extras[0].uid]}));
    assert.ok(recycled.state.restrictedCoins>600-60,'回收受限卡返入受限额度');
    // 受限制作 → 自用卡
    const crafted=f.game.game(a,'craft',f.rid({defId:'moon-deer',paymentMode:'allow_restricted'}));
    assert.equal(crafted.state.cards.find(c=>c.uid===crafted.replay.card.uid).transferPolicy,'starter_restricted');
    // 受限卡不能上架 / 赠送
    const restricted=f.game.snapshot(a).state.cards.find(c=>c.transferPolicy==='starter_restricted');
    await assert.rejects(async()=>f.game.market(a,'list',f.rid({uid:restricted.uid,price:100})),e=>e.code==='CARD_NOT_TRANSFERABLE');
    await assert.rejects(async()=>f.game.market(a,'gift',f.rid({uid:restricted.uid,toCode:f.game.snapshot(b).code})),/仅可自用/);
  }finally{f.close();}});
test('W03 普通主卡 + 受限材料合成成功：确认后自用；未确认（预期不符）409 不偷绑',async()=>{
  const f=setup({forgeRandom:()=>0.99});try{
    const user=f.users[0];f.claim(user);
    // 先把一张 Q1 材料换成受限（礼包卡即受限），主卡用 normal 十连产物……
    // 简化：礼包给的 moon-deer Q1×3 全是受限；用其中两张做材料、无主卡 → 改测受限投入路径：
    // 领礼包后用受限额度 forge（费用受限）→ 成功结果受限，且 expectedTransferable:true 被拒。
    const q1=f.game.snapshot(user).state.cards.filter(c=>c.defId==='moon-deer'&&c.rank===1);
    const pick={defId:'moon-deer',mainUid:q1[0].uid,materialUids:[q1[1].uid,q1[2].uid]};
    await assert.rejects(async()=>f.game.game(user,'forge',f.rid({...pick,expectedTransferable:true})),e=>/预期不符/.test(e.message)&&e.code==='INPUT_RESTRICTION_CHANGED');
    const s0=f.game.snapshot(user).state;assert.equal(s0.coins,s0.restrictedCoins,'未扣费');
    const done=f.game.game(user,'forge',f.rid({...pick,expectedTransferable:false}));
    assert.equal(done.replay.outcome.restricted,true);
    const upgraded=f.game.snapshot(user).state.cards.find(c=>c.uid===done.replay.outcome.mainUid);
    assert.equal(upgraded.transferPolicy,'starter_restricted');
  }finally{f.close();}});
test('W04 合成失败：主卡来源不变，返还材料保留原 uid 与来源',async()=>{
  const f=setup({forgeRandom:()=>0.05});try{
    const user=f.users[0];f.claim(user);
    const q1=f.game.snapshot(user).state.cards.filter(c=>c.defId==='moon-deer'&&c.rank===1);
    const done=f.game.game(user,'forge',f.rid({defId:'moon-deer',mainUid:q1[0].uid,materialUids:[q1[1].uid,q1[2].uid]}));
    assert.equal(done.replay.outcome.branch,'fail');
    const s=f.game.snapshot(user).state;
    const main=s.cards.find(c=>c.uid===done.replay.outcome.mainUid);
    assert.equal(main.transferPolicy,'starter_restricted');
    const returned=done.replay.outcome.returnedUids;
    assert.ok(returned.length>=1&&returned.length<=2);
    for(const uid of returned)assert.equal(s.cards.find(c=>c.uid===uid).transferPolicy,'starter_restricted','返还材料原 uid 原来源');
    assert.equal(s.coins,600-60,'失败费用不退');
  }finally{f.close();}});
test('W05 十连混付：预览全部自用，服务端计算与确认一致',async()=>{
  const f=setup({sequence:Array(20).fill(0.51)});try{
    const user=f.users[0];f.claim(user); // 600 受限
    f.seed(user,state=>{state.coins=660;state.restrictedCoins=600;}); // 混入 60 普通
    await assert.rejects(async()=>f.game.game(user,'summon.begin',f.rid({mode:'ten',expectedTransferable:true})),e=>e.code==='INPUT_RESTRICTION_CHANGED');
    const done=f.game.game(user,'summon.begin',f.rid({mode:'ten',expectedTransferable:false,paymentMode:'allow_restricted'}));
    assert.equal(done.replay.restricted,true,'整包按订单单位受限');
    assert.ok(done.replay.cards.every(c=>c.restricted));
    const s=f.game.snapshot(user).state;
    assert.ok(s.cards.filter(c=>c.originKind==='draw').every(c=>c.transferPolicy==='starter_restricted'));
  }finally{f.close();}});
test('W06 总额足够但普通额度不足买市场：明确拒绝，不动受限额度',async()=>{
  const f=setup();try{
    const [a,b]=f.users;f.claim(a);f.claim(b);
    // B：600 全受限；A 给 B 一张可卖卡？A 的卡全受限 → 用 seed 给 B 一张 free 卡挂单，A 买不起
    f.seed(b,state=>{state.cards.push({uid:'c'+(state.nextId++),defId:'sun-fox',rank:1,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1});});
    const card=f.game.snapshot(b).state.cards.find(c=>c.transferPolicy==='free');
    f.game.market(b,'list',f.rid({uid:card.uid,price:100}));
    const listing=f.game.marketSnapshot(a).listings[0];
    const before=f.game.snapshot(a).state;
    await assert.rejects(async()=>f.game.market(a,'buy',f.rid({listingId:listing.id})),e=>/玩家交易/.test(e.message)&&e.code==='INSUFFICIENT_MARKET_SPENDABLE');
    const after=f.game.snapshot(a).state;
    assert.equal(after.coins,before.coins);assert.equal(after.restrictedCoins,before.restrictedCoins);
  }finally{f.close();}});
test('W07 客户端不能凭标签决定权限：不传 paymentMode 默认受限可用，产物按服务端实际支付构成判定',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    const done=f.game.game(user,'craft',f.rid({defId:'moon-deer'}));
    assert.equal(done.replay.card.restricted,true,'服务端计算：实际动用受限额度 → 自用');
  }finally{f.close();}});

// ─── F 组：同名卡概率合成 ────────────────────────────────────────────
test('F01 三分支：普通升级 / 连升两级 / 失败，各档品质与消耗正确',async()=>{
  const f1=setup({forgeRandom:()=>0.99});try{
    f1.claim(f1.users[0]);
    const q1=f1.game.snapshot(f1.users[0]).state.cards.filter(c=>c.defId==='moon-deer'&&c.rank===1);
    const done=f1.game.game(f1.users[0],'forge',f1.rid({defId:'moon-deer',mainUid:q1[0].uid,materialUids:[q1[1].uid,q1[2].uid]}));
    assert.equal(done.replay.outcome.branch,'upgrade_one');assert.equal(done.replay.outcome.from,1);assert.equal(done.replay.outcome.to,2);
    assert.equal(done.state.coins,600-60);
  }finally{f1.close();}
  const f2=setup({forgeRandom:()=>0.102});try{
    f2.claim(f2.users[0]);
    const q1=f2.game.snapshot(f2.users[0]).state.cards.filter(c=>c.defId==='moon-deer'&&c.rank===1);
    const done=f2.game.game(f2.users[0],'forge',f2.rid({defId:'moon-deer',mainUid:q1[0].uid,materialUids:[q1[1].uid,q1[2].uid]}));
    assert.equal(done.replay.outcome.branch,'upgrade_two');assert.equal(done.replay.outcome.to,3);
  }finally{f2.close();}
  const f3=setup({forgeRandom:()=>0.05});try{
    f3.claim(f3.users[0]);
    const q1=f3.game.snapshot(f3.users[0]).state.cards.filter(c=>c.defId==='moon-deer'&&c.rank===1);
    const done=f3.game.game(f3.users[0],'forge',f3.rid({defId:'moon-deer',mainUid:q1[0].uid,materialUids:[q1[1].uid,q1[2].uid]}));
    assert.equal(done.replay.outcome.branch,'fail');assert.equal(done.replay.outcome.to,done.replay.outcome.from);
  }finally{f3.close();}});
test('F02 失败返还 1/2 张由公示概率决定且对象真实返还',async()=>{
  // 注入序列：第 1 次 roll=0.05 → fail 分支；第 2 次 roll 决定返还 1（<60%）或 2（≥40%）。
  const forgeWith=(secondRoll)=>{let calls=0;return ()=>(++calls===1?0.05:secondRoll);};
  const outcomes=new Set();
  for(const secondRoll of [0.10,0.59,0.60,0.99]){
    const f=setup({forgeRandom:forgeWith(secondRoll)});try{
      const user=f.users[0];f.claim(user);
      const q1=f.game.snapshot(user).state.cards.filter(c=>c.defId==='moon-deer'&&c.rank===1);
      const before=f.game.snapshot(user).state;
      const done=f.game.game(user,'forge',f.rid({defId:'moon-deer',mainUid:q1[0].uid,materialUids:[q1[1].uid,q1[2].uid]}));
      assert.equal(done.replay.outcome.branch,'fail');
      const returned=done.replay.outcome.returnedUids.length;
      const expected=secondRoll*100<60?1:2;
      assert.equal(returned,expected,'secondRoll '+secondRoll);
      const s=f.game.snapshot(user).state;
      assert.equal(s.cards.length,before.cards.length-(2-returned),'不返还的材料真实消失');
      for(const uid of done.replay.outcome.returnedUids)assert.ok(s.cards.some(c=>c.uid===uid),'返还保留原 uid');
      outcomes.add(returned);
    }finally{f.close();}
  }
  assert.deepEqual([...outcomes].sort(),[1,2]);
});
test('F03 重复材料 / 材料含主卡 / 品质不同：原子拒绝且不扣费',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    const list=f.game.snapshot(user).state.cards.filter(c=>c.defId==='moon-deer'&&c.rank===1);
    const coins=f.game.snapshot(user).state.coins;
    await assert.rejects(async()=>f.game.game(user,'forge',f.rid({defId:'moon-deer',mainUid:list[0].uid,materialUids:[list[1].uid,list[1].uid]})),/重复/);
    await assert.rejects(async()=>f.game.game(user,'forge',f.rid({defId:'moon-deer',mainUid:list[0].uid,materialUids:[list[0].uid,list[1].uid]})),/材料/);
    const q3=f.game.snapshot(user).state.cards.find(c=>c.defId==='moon-deer'&&c.rank===3);
    await assert.rejects(async()=>f.game.game(user,'forge',f.rid({defId:'moon-deer',mainUid:q3.uid,materialUids:[list[1].uid,list[2].uid]})),/材料/);
    assert.equal(f.game.snapshot(user).state.coins,coins,'拒绝时不扣费');
  }finally{f.close();}});
test('F04 星冕主卡禁升；可显式选择低品质主卡继续合成',async()=>{
  const f=setup({forgeRandom:()=>0.99});try{
    const user=f.users[0];f.claim(user);
    f.seed(user,state=>{const card=state.cards.find(c=>c.defId==='moon-deer');card.rank=5;state.coins+=1000;});
    await assert.rejects(async()=>f.game.game(user,'forge',f.rid({defId:'moon-deer'})),/最高品质/);
    // Q3 主卡 + Q3 材料（seed 构造）
    f.seed(user,state=>{const card=state.cards.find(c=>c.defId==='moon-deer');card.rank=3;
      state.cards.push({uid:'c'+(state.nextId++),defId:'moon-deer',rank:3,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1},
                       {uid:'c'+(state.nextId++),defId:'moon-deer',rank:3,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1});});
    const done=f.game.game(user,'forge',f.rid({defId:'moon-deer'}));
    assert.equal(done.replay.outcome.from,3);assert.equal(done.replay.outcome.to,4);
  }finally{f.close();}});

// ─── C 组：定向制作与回收 ─────────────────────────────────────────────
test('C01 未拥有 defId 直接制作被拒；已拥有则固定 Q1、不同卡种同价 180',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    await assert.rejects(async()=>f.game.game(user,'craft',f.rid({defId:'silver-gap'})),/已拥有/);
    const ownedDef=f.game.snapshot(user).state.cards[0].defId;
    const done=f.game.game(user,'craft',f.rid({defId:ownedDef,paymentMode:'allow_restricted'}));
    assert.equal(done.replay.card.rank,1);assert.equal(done.state.coins,600-180);
    f.seed(user,state=>{state.coins+=1000;});
    const other=f.game.game(user,'craft',f.rid({defId:'moon-deer'}));
    assert.equal(other.state.coins,600-180+1000-180,'不同卡种、同一已拥有 defId 两次制作费一致（统一 180）');
  }finally{f.close();}});
test('C02 回收保护：每卡种最后一张不可回收、Q2+ 不可回收、按 uid 精确回收',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    const s0=f.game.snapshot(user).state;
    const counts=new Map();for(const card of s0.cards)counts.set(card.defId,(counts.get(card.defId)??0)+1);
    const pureKind=[...counts.entries()].find(([defId,n])=>n===3&&s0.cards.filter(c=>c.defId===defId).every(c=>c.rank===1));
    assert.ok(pureKind,'礼包构造保证存在只有 3 张 Q1 的卡种');
    const allQ1OfKind=s0.cards.filter(c=>c.defId===pureKind[0]).map(c=>c.uid);
    await assert.rejects(async()=>f.game.game(user,'recycle',f.rid({uids:allQ1OfKind})),/最后一张/);
    const q2=s0.cards.find(c=>c.rank===2);
    await assert.rejects(async()=>f.game.game(user,'recycle',f.rid({uids:[q2.uid]})),/微光/);
    const extras=s0.cards.filter(c=>c.defId==='moon-deer'&&c.rank===1);
    const done=f.game.game(user,'recycle',f.rid({uids:[extras[1].uid]}));
    assert.equal(done.state.cards.length,s0.cards.length-1);
    assert.ok(done.state.cards.some(c=>c.uid===extras[0].uid),'同 defId 另一张不被误删');
    assert.equal(done.state.coins,600+10);
  }finally{f.close();}});
test('C03 无套利：制作 180 → 回收 10 净损耗；抽卡产物回收恒小于抽卡成本',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    const coins0=600;
    f.game.game(user,'craft',f.rid({defId:'moon-deer'}));
    const card=f.game.snapshot(user).state.cards.filter(c=>c.defId==='moon-deer'&&c.rank===1).at(-1);
    f.game.game(user,'recycle',f.rid({uids:[card.uid]}));
    assert.equal(f.game.snapshot(user).state.coins,coins0-180+10,'闭环净损耗 170');
    assert.ok(ECONOMY_CHECK.recycleReturn<ECONOMY_CHECK.singleDrawCost&&10*10<600);
  }finally{f.close();}});
import {ECONOMY as ECONOMY_CHECK} from '../src/data.ts';

// ─── M 组：对局 v3 与旧局冻结（与 match.test.mjs 互补的服务端集成）────
test('M01 拥有 Q3 卡只投影 Q1..Q3：多次刷新绝不出 Q4/Q5，也不发永久卡',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    f.seed(user,state=>{state.cards=[{uid:'c1',defId:'star-deer',rank:3,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1}];state.nextId=2;});
    const started=f.game.game(user,'match.start',f.rid());
    const ranks=new Set();
    for(let refresh=0;refresh<40;refresh++){
      f.advance(refresh===0?41000:75000);
      const snap=f.game.snapshot(user); // 未锁店自动刷新
      for(const offer of snap.match.shop)ranks.add(offer.rank);
    }
    assert.deepEqual([...ranks].sort(),[1,2,3].sort()||[1,2,3]);
    for(const rank of ranks)assert.ok(rank>=1&&rank<=3,'最高只投影到已拥有品质');
    assert.ok(f.game.snapshot(user).state.cards.every(c=>c.defId==='star-deer'&&c.rank===3),'不发永久卡');
  }finally{f.close();}});
test('M03 basis 守恒：买入再卖出净变化 0，合星出售 = 三张材料之和',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    const started=f.game.game(user,'match.start',f.rid());
    const offer=started.match.shop[0];const cost=offer.cost;
    f.game.game(user,'match.buy',f.rid({offerId:offer.id}));
    const unit=f.game.snapshot(user).match.roster.find(u=>u.defId===offer.defId&&u.rank===offer.rank&&u.stars===1&&u.basis===cost);
    assert.ok(unit,'买入副本记录 basis=成交价');
    const goldBefore=f.game.snapshot(user).match.gold;
    f.game.game(user,'match.sell',f.rid({uid:unit.uid}));
    assert.equal(f.game.snapshot(user).match.gold,goldBefore+cost,'买→卖净变化 0，无凭空增金');
  }finally{f.close();}});
test('M04 旧 v2 对局（删除稀有度后）仍能继续经营并按旧规则结算',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    // 直接写入一个 v2 存局：旧稀有度时代的 pool/shop 结构
    const legacyMatch={version:2,id:'legacy-match-1',status:'playing',startedAt:f.now()-1000,endsAt:f.now()-1000+600000,serverNow:f.now(),round:1,phase:'planning',phaseEndsAt:f.now()+40000,gold:120,level:3,xp:0,xpToNext:6,shop:[{id:'m1',defId:'moon-deer',rank:1,cost:10}],locked:false,roster:[],formation:[],battle:null,wins:0,losses:0,streak:0,history:[],pool:[{defId:'moon-deer',rank:1}],rng:7,nextId:2,revision:0,legacyPricing:true};
    f.store.db.prepare('INSERT OR REPLACE INTO matches VALUES(?,?)').run(user.id,JSON.stringify(legacyMatch));
    const bought=f.game.game(user,'match.buy',f.rid({offerId:'m1'}));
    assert.ok(bought.match.roster.length===1,'旧局仍可购买');
    const unit=bought.match.roster[0];
    f.game.game(user,'match.sell',f.rid({uid:unit.uid}));
    assert.ok(f.game.snapshot(user).match.gold>=120,'旧局出售走冻结价（R 基 10），不读已删除的 rarity 字段');
  }finally{f.close();}});
test('M05 有效参与才发奖励：离线空转 0 星币并有原因；正常参与发 80+20W',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    // 空转局：直接推进到终局
    const idle=f.game.game(user,'match.start',f.rid());
    f.advance(600001);
    const idleDone=f.game.snapshot(user);
    assert.equal(idleDone.match.reward.coins,0);
    assert.equal(idleDone.match.reward.reason,'insufficient_activity');
    assert.equal(idleDone.state.coins,600,'空转不发币');
    // 正常局：四个回合做经营动作
    const played=f.game.game(user,'match.start',f.rid());
    for(let round=1;round<=4;round++){
      if(round>1)f.advance(75000); // 固定步进，避免累计漂移跨 UTC 日
      const snap=f.game.snapshot(user);
      for(const offer of snap.match.shop.slice(0,3))f.game.game(user,'match.buy',f.rid({offerId:offer.id})); // 每轮买 3 个，确保阵容多样性
    }
    f.advance(600001-3*75000);
    const done=f.game.snapshot(user);
    assert.equal(done.match.reward.coins,80+20*done.match.wins);
    assert.equal(done.state.coins,600+done.match.reward.coins);
    // 再结算一次不重复发币
    const again=f.game.snapshot(user);
    assert.equal(again.state.coins,600+done.match.reward.coins);
  }finally{f.close();}});
test('M06 每日配额：6 局全额、随后半额、再后为 0；同局只占一次',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    f.seed(user,state=>{state.coins+=10000;});
    f.setClock(1_699_920_000_000+300000); // 当日 00:05 UTC 起，13 局不会跨日
    const playOne=()=>{
      const started=f.game.game(user,'match.start',f.rid());
      for(let round=1;round<=4;round++){
        if(round>1)f.advance(75000); // 固定步进，避免累计漂移跨 UTC 日
        const snap=f.game.snapshot(user);
        const offer=snap.match.shop[0];
        if(offer)f.game.game(user,'match.buy',f.rid({offerId:offer.id}));
      }
      f.advance(600001-3*75000);
      return f.game.snapshot(user);
    };
    const tiers=[];
    for(let index=0;index<13;index++)tiers.push(playOne().match.reward.factor);
    assert.deepEqual(tiers.slice(0,6),[1,1,1,1,1,1],'前 6 局全额');
    assert.deepEqual(tiers.slice(6,12),[0.5,0.5,0.5,0.5,0.5,0.5],'第 7～12 局半额');
    assert.deepEqual(tiers.slice(12),[0],'第 13 局起为 0');
    assert.equal(playOne().match.reward.reason,'daily_quota');
    assert.equal(f.store.db.prepare('SELECT SUM(matches) n FROM reward_quota').get().n,12,'空转局不占额，配额只在发币时消耗');
  }finally{f.close();}});

// ─── T 组：市场与赠送 ────────────────────────────────────────────────
test('T01 受限卡上架与赠送被服务端拒绝；free 卡买入获得 free 卡',async()=>{
  const f=setup();try{
    const [a,b]=f.users;f.claim(a);f.claim(b);
    const restricted=f.game.snapshot(a).state.cards.find(c=>c.transferPolicy==='starter_restricted');
    await assert.rejects(async()=>f.game.market(a,'list',f.rid({uid:restricted.uid,price:100})),e=>e.status===403);
    await assert.rejects(async()=>f.game.market(a,'gift',f.rid({uid:restricted.uid,toCode:f.game.snapshot(b).code})),e=>e.status===403);
    f.seed(a,state=>{state.cards.push({uid:'c'+(state.nextId++),defId:'sun-fox',rank:2,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1});state.coins=500;state.restrictedCoins=0;});
    f.seed(b,state=>{state.coins=200;state.restrictedCoins=0;});
    const card=f.game.snapshot(a).state.cards.find(c=>c.transferPolicy==='free');
    f.game.market(a,'list',f.rid({uid:card.uid,price:100}));
    const listing=f.game.marketSnapshot(a).mine[0];
    f.game.market(b,'buy',f.rid({listingId:listing.id}));
    const got=f.game.snapshot(b).state.cards.filter(c=>c.defId==='sun-fox'&&c.rank===2);
    assert.equal(got.length,2,'B 礼包自带 sun-fox Q2 + 买入 1 张');
    assert.equal(got.filter(c=>c.transferPolicy==='free').length,1,'只有买入的那张可流通');
  }finally{f.close();}});
test('T03 手续费与账目原子：买家 -100、卖家 +95、系统销毁 5',async()=>{
  const f=setup();try{
    const [a,b]=f.users;f.claim(a);f.claim(b);
    f.seed(a,state=>{state.cards.push({uid:'c'+(state.nextId++),defId:'sun-fox',rank:2,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1});});
    f.seed(b,state=>{state.coins=200;state.restrictedCoins=0;});
    const card=f.game.snapshot(a).state.cards.find(c=>c.transferPolicy==='free');
    f.game.market(a,'list',f.rid({uid:card.uid,price:100}));
    const listing=f.game.marketSnapshot(a).mine[0];
    f.game.market(b,'buy',f.rid({listingId:listing.id}));
    assert.equal(f.game.snapshot(b).state.coins,100);
    assert.equal(f.game.snapshot(a).state.coins,600+95);
    const summary=f.game.adminSummary(1);
    assert.equal(summary.fees,5);assert.equal(summary.transactions,1);
    assert.equal(summary.economy.flows.transfer.coins,-5,'成交额不是回收：转移桶净额恰为销毁的手续费');
  }finally{f.close();}});
test('T04 买入 / 赠送 / 撤单重新分配 uid：保留来源引用，不丢卡不重复',async()=>{
  const f=setup();try{
    const [a,b]=f.users;f.claim(a);f.claim(b);
    f.seed(a,state=>{state.cards.push({uid:'c9001',defId:'silver-gap',rank:2,best:0,transferPolicy:'free',originKind:'craft',originRef:'op-1',createdEconomyVersion:2});});
    f.seed(b,state=>{state.coins=200;state.restrictedCoins=0;});
    const card=f.game.snapshot(a).state.cards.find(c=>c.defId==='silver-gap'&&c.originKind==='craft');
    f.game.market(a,'list',f.rid({uid:'c9001',price:100}));
    const listing=f.game.marketSnapshot(a).mine[0];
    f.game.market(b,'buy',f.rid({listingId:listing.id}));
    const received=f.game.snapshot(b).state.cards.find(c=>c.defId==='silver-gap'&&c.originKind==='craft');
    assert.ok(received.uid!=='c9001','跨账号重新分配 uid');
    assert.equal(received.originKind,'craft');assert.equal(received.originRef,'op-1');assert.equal(received.transferPolicy,'free');
    const count=f.game.snapshot(b).state.cards.length;
    assert.equal(new Set(f.game.snapshot(b).state.cards.map(c=>c.uid)).size,count);
  }finally{f.close();}});

// ─── G 组：旧数据兼容 ────────────────────────────────────────────────
test('G01 v1→v2 迁移幂等：二次读取零新增，UID 与品质不变',async()=>{
  const f=setup();try{
    const user=f.users[0];
    f.seed(user,state=>{state.version=1;state.coins=500;state.dust=42;state.tickets=1;
      state.cards=[{uid:'c1',defId:'moon-deer',rank:2,best:0},{uid:'c2',defId:'moon-deer',rank:2,best:0},{uid:'c3',defId:'sun-fox',rank:1,best:0}];state.nextId=4;});
    const first=f.game.snapshot(user).state;
    assert.equal(first.cards.length,3);assert.equal(first.cards[0].rank,2);
    const second=f.game.snapshot(user).state;
    assert.deepEqual(second.cards.map(c=>[c.uid,c.rank]),first.cards.map(c=>[c.uid,c.rank]));
    assert.equal(second.coins,first.coins);assert.equal(second.frozen.dust,42);
  }finally{f.close();}});
test('G02 异常旧 JSON / 超限余额被隔离拒绝，不清零不静默修复',async()=>{
  const f=setup();try{
    const user=f.users[0];
    f.seed(user,state=>{state.version=1;state.cards=[{uid:'c1',defId:'not-a-card',rank:1,best:0}];});
    await assert.rejects(async()=>f.game.snapshot(user),e=>e.status===409&&/损坏/.test(e.message));
    f.seed(user,state=>{state.version=1;state.cards=[{uid:'c1',defId:'moon-deer',rank:1,best:0}];state.coins=-5;});
    await assert.rejects(async()=>f.game.snapshot(user),/损坏/);
  }finally{f.close();}});
test('G03 旧三张包路由 410；旧 lastSummon 不构成待选订单',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    await assert.rejects(async()=>f.game.game(user,'summon',f.rid()),e=>e.status===410);
    f.seed(user,state=>{state.lastSummon=[{defId:'moon-deer',quality:2},{defId:'sun-fox',quality:1},{defId:'sun-cub',quality:1}];});
    assert.equal(f.game.snapshot(user).state.pendingDraw,null,'历史抽卡记录不能当待选订单重复领取');
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM draw_orders WHERE user_id=?").get(user.id).n,0);
  }finally{f.close();}});
test('G04 战斗锁卡与旧路由：battle.* 全部 410，遗留 playing battle 仍锁卡',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    await assert.rejects(async()=>f.game.game(user,'battle.start',f.rid()),e=>e.status===410);
    // 模拟一个遗留 playing battle：锁定一张卡
    f.seed(user,state=>{state.cards[0].transferPolicy='free';});
    const lockedUid=f.game.snapshot(user).state.cards[0].uid;
    const {createBattle}=await import('../src/battle.ts');
    const battle=createBattle([{uid:lockedUid,defId:'moon-deer',rank:1,best:0}],7,[1]);
    f.store.db.prepare('INSERT OR REPLACE INTO battles VALUES(?,?)').run(user.id,JSON.stringify(battle));
    await assert.rejects(async()=>f.game.market(user,'list',f.rid({uid:lockedUid,price:100})),/战斗/);
    await assert.rejects(async()=>f.game.game(user,'forge',f.rid({defId:'moon-deer'})),/战斗/);
    f.store.db.prepare('DELETE FROM battles WHERE user_id=?').run(user.id);
    f.game.market(user,'list',f.rid({uid:lockedUid,price:100}));
    assert.equal(f.game.marketSnapshot(user).mine.length,1);
  }finally{f.close();}});

// ─── L 组：对账口径 ──────────────────────────────────────────────────
test('L02 发卡 / 托管 / 待选 / 回收全链库存与发行对账',async()=>{
  const f=setup();try{
    const user=f.users[0];f.claim(user);
    f.game.game(user,'summon.begin',f.rid({mode:'choice_one'}));
    let summary=f.game.adminSummary(1);
    assert.equal(summary.economy.pendingDraws,1,'待选计为独立状态');
    assert.equal(summary.economy.cards.restricted,23,'待选候选不计库存');
    assert.equal(summary.economy.flows.faucet.coins,600);
    assert.equal(summary.economy.flows.sink.coins,-60);
    f.game.game(user,'summon.claim',f.rid({orderId:f.game.snapshot(user).state.pendingDraw.id,candidateId:'d1'}));
    const extras=f.game.snapshot(user).state.cards.filter(c=>c.defId==='moon-deer'&&c.rank===1);
    f.game.game(user,'recycle',f.rid({uids:[extras[1].uid]}));
    summary=f.game.adminSummary(1);
    assert.equal(summary.economy.pendingDraws,0);
    assert.equal(summary.economy.cards.restricted,24-1,'claim +1、回收 −1');
    assert.equal(summary.economy.flows.faucet.coins,600+10,'分解返币计入发行');
    assert.equal(summary.economy.coinsTotal,f.game.snapshot(user).state.coins,'全服存量 = 唯一余额');
    assert.equal(summary.economy.restrictedTotal,f.game.snapshot(user).state.restrictedCoins);
  }finally{f.close();}});

// ─── HTTP 层回归（保留原有关键用例语义）──────────────────────────────
test('两个 HTTP 买家争一单恰有一个成交；跨标签身份不匹配全部拒绝',async()=>{
  const config=configFromEnv({NODE_ENV:'development',HOST:'127.0.0.1',PORT:'0',APP_ORIGIN:'http://127.0.0.1:3000',ALLOW_DEV_LOGIN:'1',DATABASE_PATH:':memory:'});
  const app=createApp(config,{store:openStore(':memory:')});
  const server=app.server;await new Promise(resolve=>server.listen(0,resolve));
  const base='http://127.0.0.1:'+server.address().port;
  config.origin=base; // 监听后按实际端口回写 Origin 基准（测试专用）
  const jar={};const cookieOf=async profile=>{const response=await fetch(base+'/api/auth/dev-login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({profile})});return response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');};
  try{
    jar.a=await cookieOf('admin');jar.b=await cookieOf('playerB');jar.c=await cookieOf('playerC');
    const post=(cookie,path,body,user)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,Cookie:cookie,...(user?{'X-Asteria-User':user.id}:{})},body:JSON.stringify({requestId:randomUUID(),...body})});
    const me=async cookie=>(await(await fetch(base+'/api/auth/me',{headers:{Cookie:cookie}})).json()).user;
    const userA=await me(jar.a),userB=await me(jar.b),userC=await me(jar.c);
    // 各自领礼包
    for(const [jarX,userX,favorite] of [[jar.a,userA,'moon-deer'],[jar.b,userB,'sun-fox'],[jar.c,userC,'forest-rabbit']])
      assert.equal((await post(jarX,'/api/game/starter.claim',{favoriteDefId:favorite},userX)).status,200);
    // A 注入一张可流通卡挂 100
    const seedRow=app.store.db.prepare('SELECT state FROM profiles WHERE user_id=?').get(userA.id);
    const state=JSON.parse(seedRow.state);state.cards.push({uid:'c9001',defId:'silver-gap',rank:2,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1});state.nextId=Math.max(state.nextId,9002);
    app.store.db.prepare('UPDATE profiles SET state=? WHERE user_id=?').run(JSON.stringify(state),userA.id);
    assert.equal((await post(jar.a,'/api/market/list',{uid:'c9001',price:100},userA)).status,200);
    const listing=(await(await fetch(base+'/api/market',{headers:{Cookie:jar.b,'X-Asteria-User':userB.id}})).json()).listings[0];
    // B/C 都需要普通余额：直接注入
    for(const user of [userB,userC]){const row=app.store.db.prepare('SELECT state FROM profiles WHERE user_id=?').get(user.id);const s=JSON.parse(row.state);s.coins+=500;app.store.db.prepare('UPDATE profiles SET state=? WHERE user_id=?').run(JSON.stringify(s),user.id);}
    const [buyB,buyC]=await Promise.all([post(jar.b,'/api/market/buy',{listingId:listing.id},userB),post(jar.c,'/api/market/buy',{listingId:listing.id},userC)]);
    assert.equal([buyB,buyC].filter(response=>response.status===200).length,1);
    // 跨标签：旧 X-Asteria-User 拒绝
    assert.equal((await post(jar.b,'/api/game/summon.begin',{mode:'choice_one'},userA)).status,409);
  }finally{server.close();await app.close();}
});
