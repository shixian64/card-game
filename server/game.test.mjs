import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openStore} from './store.mjs';
import {createGameService} from './game.mjs';
import {createApp,configFromEnv} from './index.mjs';
function setup(){const store=openStore(':memory:'),game=createGameService(store.db);const users=['A','B','C'].map(subject=>store.login({issuer:'test',clientId:'test',subject,name:subject}).user);users.forEach(u=>game.ensureProfile(u));return {store,game,users,close:()=>store.db.close()};}
const request=(other={})=>({requestId:randomUUID(),...other});
test('账户资产由服务端创建且隔离，客户端快照不泄露抽卡随机种子',()=>{const f=setup();try{const a=f.game.snapshot(f.users[0]),b=f.game.snapshot(f.users[1]);assert.equal(a.state.cards.length,23);assert.notEqual(a.code,b.code);assert.equal(a.state.rng,0);f.game.game(f.users[0],'summon',request());assert.equal(f.game.snapshot(f.users[0]).state.cards.length,26);assert.equal(f.game.snapshot(f.users[1]).state.cards.length,23);}finally{f.close();}});
test('重复抽卡请求只扣一次券，复用请求编号改变操作会失败',()=>{const f=setup();try{const args=request();f.game.game(f.users[0],'summon',args);f.game.game(f.users[0],'summon',args);const a=f.game.snapshot(f.users[0]);assert.equal(a.state.tickets,2);assert.equal(a.state.cards.length,26);assert.throws(()=>f.game.game(f.users[0],'craft',args),/操作编号/);}finally{f.close();}});
test('上架托管、购买到账、手续费销毁和交易审计为同一事务',()=>{const f=setup();try{const [seller,buyer]=f.users,a=f.game.snapshot(seller),b=f.game.snapshot(buyer);const uid=a.state.cards[0].uid;f.game.market(seller,'list',request({uid,price:100}));assert.equal(f.game.snapshot(seller).state.cards.length,a.state.cards.length-1);const listing=f.game.marketSnapshot(buyer).listings[0];f.game.market(buyer,'buy',request({listingId:listing.id}));const sa=f.game.snapshot(seller).state,sb=f.game.snapshot(buyer).state;assert.equal(sa.coins,a.state.coins+95);assert.equal(sb.coins,b.state.coins-100);assert.equal(sb.cards.length,b.state.cards.length+1);assert.equal(new Set(sb.cards.map(c=>c.uid)).size,sb.cards.length);assert.equal(f.game.marketSnapshot(seller).listings.length,0);assert.equal(f.game.adminSummary().fees,5);assert.equal(f.game.adminSummary().transactions,1);}finally{f.close();}});
test('余额不足、买自己的卡、撤销他人挂单不会产生副作用',()=>{const f=setup();try{const [a,b]=f.users;f.game.market(a,'list',request({uid:f.game.snapshot(a).state.cards[0].uid,price:100000}));const listing=f.game.marketSnapshot(a).listings[0];const before=JSON.stringify(f.game.snapshot(b));assert.throws(()=>f.game.market(b,'buy',request({listingId:listing.id})),/不足/);assert.equal(JSON.stringify(f.game.snapshot(b)),before);assert.throws(()=>f.game.market(a,'buy',request({listingId:listing.id})),/自己/);assert.throws(()=>f.game.market(b,'cancel',request({listingId:listing.id})),/挂单/);assert.equal(f.game.marketSnapshot(a).listings.length,1);}finally{f.close();}});
test('撤单归还原等级卡且重试不重复归还',()=>{const f=setup();try{const a=f.users[0];f.game.game(a,'strengthen',request({defId:'moon-fawn'}));const c=f.game.snapshot(a).state.cards.find(c=>c.defId==='moon-fawn'&&c.rank===2);const n=f.game.snapshot(a).state.cards.length;f.game.market(a,'list',request({uid:c.uid,price:80}));const id=f.game.marketSnapshot(a).mine[0].id,args=request({listingId:id});f.game.market(a,'cancel',args);f.game.market(a,'cancel',args);const s=f.game.snapshot(a).state;assert.equal(s.cards.length,n);assert.equal(s.cards.filter(c=>c.defId==='moon-fawn'&&c.rank===2).length,1);}finally{f.close();}});
test('赠送真实转移且保留强化等级，错误收件人不会扣卡',()=>{const f=setup();try{const [a,b]=f.users;f.game.game(a,'strengthen',request({defId:'moon-fawn'}));const c=f.game.snapshot(a).state.cards.find(c=>c.rank===2),count=f.game.snapshot(a).state.cards.length;assert.throws(()=>f.game.market(a,'gift',request({uid:c.uid,toCode:'UNKNOWN'})),/找到/);assert.equal(f.game.snapshot(a).state.cards.length,count);const args=request({uid:c.uid,toCode:f.game.snapshot(b).code});f.game.market(a,'gift',args);f.game.market(a,'gift',args);assert.equal(f.game.snapshot(a).state.cards.length,count-1);assert.equal(f.game.snapshot(b).state.cards.filter(c=>c.rank===2).length,1);assert.equal(f.game.adminSummary().gifts,1);}finally{f.close();}});
test('价格、请求编号、虚构卡牌以及自己赠送均被拒绝',()=>{const f=setup();try{const a=f.users[0],uid=f.game.snapshot(a).state.cards[0].uid;for(const price of [-1,0,9,10.5,100001,'100'])assert.throws(()=>f.game.market(a,'list',request({uid,price})));assert.throws(()=>f.game.market(a,'list',{uid,price:100}));assert.throws(()=>f.game.market(a,'list',request({uid:'not-mine',price:100})));assert.throws(()=>f.game.market(a,'gift',request({uid,toCode:f.game.snapshot(a).code})));assert.equal(f.game.snapshot(a).state.cards.length,23);}finally{f.close();}});
test('战斗队伍锁定不能上架/送出/强化，放弃后解锁',()=>{const f=setup();try{const [a,b]=f.users,s=f.game.snapshot(a).state;const team=['moon-deer','sun-fox','forest-rabbit','moon-fawn','sun-cub','forest-sprout'].map(id=>s.cards.find(c=>c.defId===id).uid);f.game.game(a,'battle.start',request({uids:team}));assert.throws(()=>f.game.market(a,'list',request({uid:team[0],price:100})),/战斗/);assert.throws(()=>f.game.market(a,'gift',request({uid:team[0],toCode:f.game.snapshot(b).code})),/战斗/);assert.throws(()=>f.game.game(a,'strengthen',request({defId:'forest-rabbit'})),/战斗/);f.game.game(a,'battle.abandon',request());f.game.market(a,'list',request({uid:team[0],price:100}));assert.equal(f.game.marketSnapshot(a).mine.length,1);}finally{f.close();}});
test('自走棋服务端预计算，回放结算只发一次奖励且客户端不能伪造胜负',()=>{
 const f=setup();try{
  const a=f.users[0],initial=f.game.snapshot(a).state;
  const uids=['moon-deer','sun-fox','forest-rabbit','moon-fawn','sun-cub','forest-sprout'].map(id=>initial.cards.find(c=>c.defId===id).uid);
  const slots=[0,2,4,22,24,26];
  const running=f.game.game(a,'battle.start',request({uids,slots}));
  assert.equal(running.battle.version,2);assert.equal(running.battle.status,'playing');assert.ok(running.battle.frames.length>0);
  assert.deepEqual(running.battle.player.map(u=>u.slot),slots);assert.equal(running.state.coins,initial.coins);
  assert.throws(()=>f.game.game(a,'battle.act',request({action:{type:'kill-all'}})));
  assert.throws(()=>f.game.game(a,'battle.act',request({action:{type:'resolve',outcome:'won',coins:999999}})));
  const args=request({action:{type:'resolve'}});
  const settled=f.game.game(a,'battle.act',args);assert.equal(settled.battle.status,running.battle.outcome);
  assert.equal(settled.state.coins,initial.coins+(running.battle.outcome==='won'?120:30));
  assert.equal(f.game.game(a,'battle.act',args).state.coins,settled.state.coins);
  assert.throws(()=>f.game.game(a,'battle.act',request({action:{type:'resolve'}})),/进行中/);
  f.game.game(a,'battle.abandon',request());assert.equal(f.game.snapshot(a).battle,null);
 }finally{f.close();}
});
test('两个HTTP买家同时购买同一挂单，恰有一个成交',async()=>{const app=createApp(configFromEnv({APP_ORIGIN:'http://127.0.0.1:3000',DATABASE_PATH:':memory:'}));await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));try{const people=['seller','buyer1','buyer2'].map(subject=>app.store.login({issuer:'test',clientId:'test',subject,name:subject}));people.forEach(p=>app.game.ensureProfile(p.user));const [seller,...buyers]=people;app.game.market(seller.user,'list',request({uid:app.game.snapshot(seller.user).state.cards[0].uid,price:100}));const id=app.game.marketSnapshot(seller.user).mine[0].id,base='http://127.0.0.1:'+app.server.address().port;const responses=await Promise.all(buyers.map(b=>fetch(base+'/api/market/buy',{method:'POST',headers:{Origin:'http://127.0.0.1:3000','Content-Type':'application/json',Cookie:'asteria-session='+b.token},body:JSON.stringify(request({listingId:id}))})));assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(app.game.adminSummary().transactions,1);assert.equal(app.game.snapshot(seller.user).state.coins,1375);}finally{await app.close();}});

test('跨标签账号变更时，带旧身份的读写请求全部拒绝且不产生副作用',async()=>{
 const app=createApp(configFromEnv({APP_ORIGIN:'http://localhost:3001',DATABASE_PATH:':memory:'}));
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 try{
  const [a,b]=['A','B'].map(subject=>app.store.login({issuer:'test',clientId:'test',subject,name:subject}));
  app.game.ensureProfile(a.user);app.game.ensureProfile(b.user);
  const base='http://127.0.0.1:'+app.server.address().port;
  const headers={'X-Asteria-User':a.user.id,Cookie:'asteria-session='+b.token,Origin:'http://localhost:3001','Content-Type':'application/json'};
  for(const path of ['/api/game','/api/market','/api/social','/api/chat?channel=world'])assert.equal((await fetch(base+path,{headers})).status,409);
  for(const path of ['/api/game/summon','/api/market/list','/api/social/chat.send'])assert.equal((await fetch(base+path,{method:'POST',headers,body:JSON.stringify(request({channel:'world',text:'must not send'}))})).status,409);
  assert.equal(app.game.snapshot(b.user).state.cards.length,23);
  assert.equal(app.social.messages(b.user,'world').length,0);
  assert.equal((await fetch(base+'/api/game',{headers:{...headers,'X-Asteria-User':b.user.id}})).status,200);
 }finally{await app.close();}
});
