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
  const sa=(await call(a,'/api/game')).data,sb=(await call(b,'/api/game')).data;
  const uid=sa.state.cards[0].uid;assert.equal((await call(a,'/api/market/list',request({uid,price:100}))).status,200);
  const market=(await call(b,'/api/market?rarity=SSR&sort=low')).data;assert.equal(market.total,1);
  const buy=request({listingId:market.listings[0].id});assert.equal((await call(b,'/api/market/buy',buy)).status,200);assert.equal((await call(b,'/api/market/buy',buy)).status,200);
  assert.equal((await call(a,'/api/game')).data.state.coins,1375);assert.equal((await call(b,'/api/game')).data.state.coins,1180);
  const giftUid=(await call(a,'/api/game')).data.state.cards.find(x=>x.defId==='moon-fawn').uid;
  assert.equal((await call(a,'/api/market/gift',request({uid:giftUid,toCode:sb.code}))).status,200);
  assert.equal((await call(b,'/api/game')).data.state.cards.length,25);
  assert.equal((await call(b,'/api/social/friend.request',{code:sa.code})).status,200);
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
