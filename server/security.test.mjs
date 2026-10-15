import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp,configFromEnv} from './index.mjs';
import {openStore} from './store.mjs';
const discovery={issuer:'https://connect.linux.do/',authorization_endpoint:'https://connect.linux.do/oauth2/authorize',token_endpoint:'https://connect.linux.do/oauth2/token',jwks_uri:'https://connect.linux.do/.well-known/jwks.json'};
async function fixture(t,env={},peer='172.30.0.2',now){
 const config=configFromEnv({NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1:3000',DATABASE_PATH:':memory:',TRUSTED_PROXIES:'172.30.0.2',LINUXDO_CLIENT_ID:'fixture-client',LINUXDO_CLIENT_SECRET:'fixture-secret',...env});
 const store=openStore(':memory:');const app=createApp(config,{store,now,fetch:async()=>new Response(JSON.stringify(discovery),{headers:{'Content-Type':'application/json'}})});
 app.server.prependListener('request',req=>Object.defineProperty(req.socket,'remoteAddress',{value:peer,configurable:true}));
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;config.origin=base;
 t.after(async()=>{app.server.closeAllConnections();await app.close();});
 const rawRequest=(path,ip='198.51.100.1',options={})=>fetch(base+path,{...options,redirect:'manual',headers:{'X-Forwarded-For':ip,...options.headers}});
 const request=async(...args)=>{const r=await rawRequest(...args);await r.text();return r.status;};
 const login=subject=>{const s=store.login({issuer:'fixture',clientId:'fixture',subject,name:subject});return 'asteria-session='+s.token;};
 return {config,store,app,request,rawRequest,login};
}
test('真实 HTTP：同一可信代理后的登录限流按客户端分桶，两个 OAuth 入口共用额度',async t=>{
 const f=await fixture(t,{OPENAI_CLIENT_ID:'fixture-openai'},'::ffff:172.30.0.2');
 for(let i=0;i<15;i++)assert.equal(await f.request('/auth/linuxdo'),302);
 assert.equal(await f.request('/auth/linuxdo'),429);
 assert.equal(await f.request('/auth/openai'),429);
 assert.equal(await f.request('/auth/linuxdo','198.51.100.2'),302);
});
test('真实 HTTP：未配置信任时轮换 X-Forwarded-For 不能绕过 socket 限流',async t=>{
 const f=await fixture(t,{TRUSTED_PROXIES:''});
 for(let i=0;i<15;i++)assert.equal(await f.request('/auth/linuxdo','198.51.100.'+(i+1)),302);
 assert.equal(await f.request('/auth/linuxdo','203.0.113.9'),429);
});
test('真实 HTTP：信任限流代理也不信任开发登录的伪造 loopback 地址',async t=>{
 const f=await fixture(t,{ALLOW_DEV_LOGIN:'1'});
 assert.equal(await f.request('/api/auth/dev-login','127.0.0.1',{method:'POST',headers:{Origin:f.config.origin}}),404);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM sessions').get().n,0);
});
test('真实 HTTP：代理后事件限流按客户端分桶，访客轮换不能突破 IP 额度',async t=>{
 const f=await fixture(t);
 const event=(i,ip)=>f.request('/api/events',ip,{method:'POST',headers:{Origin:f.config.origin,'Content-Type':'application/json',Cookie:'asteria-visitor='+(i%6).toString(16).padStart(64,'0')},body:JSON.stringify({id:'security-event-'+i,type:'page_view'})});
 for(let i=0;i<600;i++)assert.equal(await event(i,'198.51.100.1'),200);
 assert.equal(await event(600,'198.51.100.1'),429);
 assert.equal(await event(601,'198.51.100.2'),200);
});
test('真实 HTTP：市场读取按账号限频，轮换 IP/筛选/会话不能绕过，其他账号不受影响',async t=>{
 const f=await fixture(t),cookie=f.login('market-a');
 for(let i=0;i<60;i++)assert.equal(await f.request('/api/market?page='+(i+1),'198.51.100.1',{headers:{Cookie:cookie}}),200);
 assert.equal(await f.request('/api/market?sort=low','198.51.100.2',{headers:{Cookie:f.login('market-a')}}),429);
 assert.equal(await f.request('/api/market','198.51.100.2',{headers:{Cookie:f.login('market-b')}}),200);
});
test('真实 HTTP：轮换账号仍受市场客户端 IP 总额度约束',async t=>{
 const f=await fixture(t);
 for(let u=0;u<5;u++){const cookie=f.login('market-'+u);for(let i=0;i<60;i++)assert.equal(await f.request('/api/market','198.51.100.1',{headers:{Cookie:cookie}}),200);}
 const cookie=f.login('market-next');
 assert.equal(await f.request('/api/market','198.51.100.1',{headers:{Cookie:cookie}}),429);
 assert.equal(await f.request('/api/market','198.51.100.2',{headers:{Cookie:cookie}}),200);
});

test('真实 HTTP：已有等待房间的账号不能加入第二个房间',async t=>{
 const f=await fixture(t),a=f.login('lobby-a'),b=f.login('lobby-b');
 const options=(cookie,body)=>({method:'POST',headers:{Origin:f.config.origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
 const create=await f.rawRequest('/api/duel/create',undefined,options(a,{}));assert.equal(create.status,200);const room=await create.json();
 assert.equal(await f.request('/api/duel/create',undefined,options(b,{})),200);
 const join=await f.rawRequest('/api/duel/join',undefined,options(b,{code:room.inviteCode}));assert.equal(join.status,409);assert.equal((await join.json()).code,'LOBBY_EXISTS');
});
test('真实 HTTP：一次正常轮询同时推进正式对局并清理 50 个更早到期的大厅',async t=>{
 let clock=1000000;const f=await fixture(t,{DUEL_SCHEDULER_TICK_MS:'3600000'},'172.30.0.2',()=>clock);
 const call=async(path,cookie,body)=>{
  const r=await f.rawRequest(path,undefined,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{Origin:f.config.origin,'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;
 };
 // 合法请求构造固定积压，不伪造截止时间，不将该负载夹具当作攻击吞吐率证明。
 for(let i=0;i<50;i++)await call('/api/duel/create',f.login('backlog-'+i),{});
 clock+=100000;const a=f.login('playing-a'),b=f.login('playing-b');
 for(const [cookie,ref] of [[a,'playing-a'],[b,'playing-b']])await call('/api/game/starter.claim',cookie,{requestId:'starter-'+ref,favoriteDefId:'moon-deer'});
 const room=await call('/api/duel/create',a,{});await call('/api/duel/join',b,{code:room.inviteCode});
 for(const cookie of [a,b]){
  const snapshot=await call('/api/game',cookie),max=new Map();for(const card of snapshot.state.cards)max.set(card.defId,Math.max(max.get(card.defId)||0,card.rank));
  const defs=[...max].slice(0,8).map(([defId,battleQuality])=>({defId,battleQuality}));
  await call('/api/duel/'+room.roomId+'/loadout',cookie,{defs,starters:defs.slice(0,2).map(d=>d.defId)});await call('/api/duel/'+room.roomId+'/ready',cookie,{ready:true});
 }
 clock+=31000;const view=await call('/api/duel/'+room.roomId,a);assert.equal(view.room.phase,'combat');
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM duel_rooms WHERE status='lobby'").get().n,0);
});
