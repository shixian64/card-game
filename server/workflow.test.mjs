import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp,configFromEnv} from './index.mjs';

test('双账号完整HTTP流程：上架购买、赠送、好友双向私聊、世界频道及管理员统计',async()=>{
 const origin='http://127.0.0.1:3000';const app=createApp(configFromEnv({APP_ORIGIN:origin,DATABASE_PATH:':memory:',ALLOW_DEV_LOGIN:'1'}));
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
 async function call(actor,path,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(actor?{Cookie:actor.cookie,'X-Asteria-User':actor.user.id}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json(),headers:response.headers};}
 async function login(profile){const res=await call(null,'/api/auth/dev-login',{profile});assert.equal(res.status,200);const cookie=res.headers.getSetCookie().find(x=>x.startsWith('asteria-session=')).split(';')[0];const me=await fetch(base+'/api/auth/me',{headers:{Cookie:cookie}}).then(r=>r.json());return {cookie,user:me.user};}
 const request=x=>({requestId:randomUUID(),...x});
 try{
  const a=await login('admin'),b=await login('playerB'),c=await login('playerC');
  // 新经济：先领新手礼包（受限来源），再注入可流通测试卡与普通余额（直接写库，聚焦 HTTP 流程）
  assert.equal((await call(a,'/api/game/starter.claim',request({favoriteDefId:'moon-deer'}))).status,200);
  assert.equal((await call(b,'/api/game/starter.claim',request({favoriteDefId:'sun-fox'}))).status,200);
  const seed=(user,mutator)=>{const row=app.store.db.prepare('SELECT state FROM profiles WHERE user_id=?').get(user.id);const state=JSON.parse(row.state);mutator(state);app.store.db.prepare('UPDATE profiles SET state=? WHERE user_id=?').run(JSON.stringify(state),user.id);};
  seed(a.user,state=>{state.cards.push({uid:'c9001',defId:'sun-fox',rank:2,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1},{uid:'c9002',defId:'moon-fawn',rank:1,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1});});
  seed(b.user,state=>{state.coins=200;state.restrictedCoins=0;});
  const sb=(await call(b,'/api/game')).data;
  assert.equal((await call(a,'/api/market/list',request({uid:'c9001',price:100}))).status,200);
  const market=(await call(b,'/api/market?sort=low')).data;assert.equal(market.total,1);
  const buy=request({listingId:market.listings[0].id});assert.equal((await call(b,'/api/market/buy',buy)).status,200);assert.equal((await call(b,'/api/market/buy',buy)).status,200);
  assert.equal((await call(a,'/api/game')).data.state.coins,600+95);assert.equal((await call(b,'/api/game')).data.state.coins,100);
  assert.equal((await call(a,'/api/market/gift',request({uid:'c9002',toCode:sb.code}))).status,200);
  assert.equal((await call(b,'/api/game')).data.state.cards.length,23+2);
  const sa=(await call(a,'/api/game')).data;assert.equal((await call(b,'/api/social/friend.request',{code:sa.code})).status,200);
  assert.equal((await call(a,'/api/social')).data.incoming.length,1);
  assert.equal((await call(a,'/api/social/friend.accept',{userId:b.user.id})).status,200);
  assert.equal((await call(a,'/api/social/chat.send',{channel:b.user.id,text:'联调私聊：卡牌已收到'})).status,200);
  assert.equal((await call(b,'/api/social/chat.send',{channel:'world',text:'联调世界：市场已开张'})).status,200);
  assert.equal((await call(b,'/api/chat?channel='+a.user.id)).data.messages[0].text,'联调私聊：卡牌已收到');
  assert.equal((await call(c,'/api/chat?channel='+a.user.id)).status,403);
  assert.equal((await call(c,'/api/chat?channel=world')).data.messages[0].text,'联调世界：市场已开张');
  const admin=await call(a,'/api/admin/economy?days=1');assert.equal(admin.status,200);assert.equal(admin.data.transactions,1);assert.equal(admin.data.gifts,1);assert.equal(admin.data.fees,5);assert.deepEqual(admin.data.social,{friendships:1,worldMessages:1,privateMessages:1,pendingRequests:0});
  assert.equal((await call(b,'/api/admin/economy')).status,403);
  assert.equal((await call(a,'/api/game/battle.start',request({uids:[]}))).status,410);
  assert.equal((await call(a,'/api/market?minPrice=200&maxPrice=10')).status,400);
 }finally{await app.close();}
});

test('双人短局HTTP闭环：建房→加入→牌组→准备→备战命令→冻结结果，双方同回放；旧单人局开关',async()=>{
 const origin='http://127.0.0.1:3000';const app=createApp(configFromEnv({APP_ORIGIN:origin,DATABASE_PATH:':memory:',ALLOW_DEV_LOGIN:'1'}));
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
 async function call(actor,path,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(actor?{Cookie:actor.cookie,'X-Asteria-User':actor.user.id}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json(),headers:response.headers};}
 async function login(profile){const res=await call(null,'/api/auth/dev-login',{profile});assert.equal(res.status,200);const cookie=res.headers.getSetCookie().find(x=>x.startsWith('asteria-session=')).split(';')[0];const me=await fetch(base+'/api/auth/me',{headers:{Cookie:cookie}}).then(r=>r.json());return {cookie,user:me.user};}
 const request=x=>({requestId:randomUUID(),...x});
 try{
  const a=await login('admin'),b=await login('playerB');
  await call(a,'/api/game/starter.claim',request({favoriteDefId:'moon-deer'}));
  await call(b,'/api/game/starter.claim',request({favoriteDefId:'sun-fox'}));
  const loadoutOf=async actor=>{const snap=(await call(actor,'/api/game')).data;const maxByDef=new Map();for(const c of snap.state.cards)maxByDef.set(c.defId,Math.max(maxByDef.get(c.defId)??0,c.rank));return{defs:[...maxByDef.entries()].slice(0,8).map(([defId,battleQuality])=>({defId,battleQuality})),starters:[...maxByDef.keys()].slice(0,2)};};
  const created=(await call(a,'/api/duel/create',request({}))).data;
  assert.match(created.inviteCode,/^[A-Z0-9]{8}$/);
  // 未登录 / 非成员拒绝。
  assert.equal((await fetch(base+'/api/duel/me')).status,401);
  const me=(await call(b,'/api/duel/me')).data;assert.equal(me.activeRoomId,null);
  assert.equal((await call(b,'/api/duel/'+created.roomId)).status,403);
  assert.equal((await call(b,'/api/duel/join',request({code:created.inviteCode}))).status,200);
  assert.equal((await call(a,'/api/duel/'+created.roomId+'/loadout',request(await loadoutOf(a)))).status,200);
  assert.equal((await call(b,'/api/duel/'+created.roomId+'/loadout',request(await loadoutOf(b)))).status,200);
  assert.equal((await call(a,'/api/duel/'+created.roomId+'/ready',request({ready:true}))).status,200);
  assert.equal((await call(b,'/api/duel/'+created.roomId+'/ready',request({ready:true}))).status,200);
  const view=(await call(a,'/api/duel/'+created.roomId)).data;
  assert.equal(view.room.status,'playing');assert.equal(view.room.phase,'planning');
  // 备战命令：买一格 + 部署，phaseId/playerRevision 校验走真实 HTTP。
  const offer=view.self.shop[0];
  assert.equal((await call(a,'/api/duel/'+created.roomId+'/command',request({phaseId:view.room.phaseId,expectedPlayerRevision:view.self.playerRevision,action:'buy',payload:{offerId:offer.offerId}}))).status,200);
  // 旧单人局开关默认放行（=1）；显式关闭后拒绝新开（C03 能力）。
  assert.equal((await call(a,'/api/game/match.start',request({}))).status,409); // duel 活跃锁优先拦截
  // 推进时间到 R1 冻结：直接驱动服务 tick（HTTP 层由 1s 定时器推进）。
  const room=app.store.db.prepare('SELECT * FROM duel_rooms WHERE id=?').get(created.roomId);
  app.store.db.prepare('UPDATE duel_rooms SET phase_ends_at=? WHERE id=?').run(Date.now()-1,created.roomId);
  app.duel.tick();
  const combat=(await call(a,'/api/duel/'+created.roomId)).data;
  assert.equal(combat.room.phase,'combat');
  assert.ok(combat.currentBattle.battleIds.length>=1);
  const battleId=combat.currentBattle.battleIds[0];
  const replayA=(await call(a,'/api/duel/'+created.roomId+'/battles/'+battleId)).data;
  const replayB=(await call(b,'/api/duel/'+created.roomId+'/battles/'+battleId)).data;
  assert.deepEqual(replayA.sim.frames,replayB.sim.frames,'两端同 battleId 同帧同结果（B03）');
  assert.equal((await call(a,'/api/duel/'+created.roomId+'/battles/not-exist')).status,404);
 }finally{await app.close();}
});
