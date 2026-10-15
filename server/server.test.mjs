import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnv, createApp } from './index.mjs';
import { openStore, randomToken, hash } from './store.mjs';

const ISSUER='https://auth.openai.com';
const CLIENT='test-client-only';
const ADMIN='test-admin-subject';
const VISITOR='a'.repeat(64);
async function fixture(t,env={},remoteAddress) {
  const config=configFromEnv({NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1:3000',DATABASE_PATH:':memory:',...env});
  const store=openStore(':memory:');const app=createApp(config,{store});
  if(remoteAddress)app.server.prependListener('request',req=>Object.defineProperty(req.socket,'remoteAddress',{value:remoteAddress,configurable:true}));
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+app.server.address().port;
  if(!config.secure)config.origin=base;
  t.after(async()=>{app.server.closeAllConnections();await app.close();});
  const sessionName=config.secure?'__Host-asteria-session':'asteria-session';
  const visitorName=config.secure?'__Host-asteria-visitor':'asteria-visitor';
  const transactionName=config.secure?'__Host-asteria-transaction':'asteria-transaction';
  async function request(path,{method='GET',body,raw,cookie,origin,headers={}}={}) {
    headers={...headers};if(cookie)headers.Cookie=cookie;
    if(['POST','PUT','PATCH','DELETE'].includes(method)&&origin!==null)headers.Origin=origin??config.origin;
    if(body!==undefined||raw!==undefined)headers['Content-Type']='application/json';
    return fetch(base+path,{method,headers,body:raw??(body===undefined?undefined:JSON.stringify(body)),redirect:'manual'});
  }
  function login({issuer=ISSUER,clientId=CLIENT,subject='ordinary-player',name='测试账号'}={}) {
    const session=store.login({issuer,clientId,subject,name});return {...session,cookie:sessionName+'='+session.token+'; '+visitorName+'='+VISITOR};
  }
  return {app,config,store,base,request,login,sessionName,transactionName,visitorName};
}
const adminConfig={OPENAI_CLIENT_ID:CLIENT,ADMIN_OPENAI_SUBJECTS:ADMIN};
function cookieHeader(response){return response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');}

test('HTTP：未拥有或未知卡种制作返回 400，拒绝不写资产、流水或幂等记录',async t=>{
  const f=await fixture(t),account=f.login();
  await f.request('/api/game',{cookie:account.cookie});
  const before=f.store.db.prepare('SELECT state,revision FROM profiles WHERE user_id=?').get(account.user.id);
  for(const [defId,code] of [['moon-deer','CARD_NOT_OWNED'],['not-a-card','CARD_UNKNOWN']]){
    const response=await f.request('/api/game/craft',{method:'POST',cookie:account.cookie,
      body:{requestId:'craft-rejected-'+defId,defId,paymentMode:'normal_only'}});
    assert.equal(response.status,400);
    assert.equal((await response.json()).code,code);
    assert.deepEqual(f.store.db.prepare('SELECT state,revision FROM profiles WHERE user_id=?').get(account.user.id),before);
    for(const table of ['operations','ledger'])assert.equal(f.store.db.prepare('SELECT count(*) n FROM '+table+' WHERE user_id=?').get(account.user.id).n,0);
  }
});

test('game/duel HTTP 错误：未知异常为 500，合法业务错误保留状态，5xx 不泄露内部消息',async t=>{
  const f=await fixture(t),account=f.login();
  t.mock.method(console,'error',()=>{});
  const cases=[
    [new TypeError('private implementation detail'),500,'操作未完成，请稍后重试'],
    [null,500,'操作未完成，请稍后重试'],
    ...[0,200,600,400.5,'409',NaN].map(status=>[Object.assign(new Error('private detail'),{status,code:'INTERNAL_CODE'}),500,'操作未完成，请稍后重试']),
    [Object.assign(new Error('请先完成当前对局'),{status:409,code:'ACTIVE_GAME_EXISTS'}),409,'请先完成当前对局'],
    [Object.assign(new Error('private upstream detail'),{status:503,code:'INTERNAL_CODE'}),503,'操作未完成，请稍后重试'],
  ];
  for(const [error,status,message] of cases){
    f.app.game.game=()=>{throw error;};f.app.duel.view=()=>{throw error;};
    for(const [path,options] of [
      ['/api/game/recycle',{method:'POST',body:{requestId:'http-error-fixture'}}],
      ['/api/duel/error-fixture',{}],
    ]){
      const response=await f.request(path,{...options,cookie:account.cookie});
      assert.equal(response.status,status,path);
      const payload=await response.json();assert.equal(payload.error,message);
      if(status>=500)assert.equal(payload.code,undefined,'内部错误码也不能外泄');
      else assert.equal(payload.code,'ACTIVE_GAME_EXISTS');
    }
  }
});

test('HTTP：异常取消房间即使 JSON 损坏也可恢复为明确的零奖励终局',async t=>{
  const f=await fixture(t),account=f.login(),room=f.app.duel.create(account.user);
  f.store.db.prepare("UPDATE duel_rooms SET status='finished',phase='finished',phase_id='finished',finish_reason='tick_failure',finished_at=? WHERE id=?").run(Date.now(),room.roomId);
  f.store.db.prepare("UPDATE duel_participants SET state='{bad json',loadout='{bad loadout' WHERE room_id=?").run(room.roomId);
  const me=await(await f.request('/api/duel/me',{cookie:account.cookie})).json();
  assert.equal(me.lastFinishedRoomId,room.roomId);
  const response=await f.request('/api/duel/'+me.lastFinishedRoomId,{cookie:account.cookie});
  assert.equal(response.status,200);
  const view=await response.json();
  assert.equal(view.room.finishReason,'tick_failure');assert.equal(view.room.outcome,null);
  assert.deepEqual(view.self.reward,{base:0,factor:0,actualCoins:0,reason:'service_abort'});
  assert.equal(view.currentBattle,null);
});

// 所有账号均通过内存仓库建立测试会话；本文件不测试、不冒充真实 OpenAI 登录成功。
test('未登录不能读取管理后台',async t=>{
  const f=await fixture(t,adminConfig);const response=await f.request('/api/admin/summary');assert.equal(response.status,401);assert.match((await response.json()).error,/登录/);
});
for(const [name,identity,status] of [
 ['普通账号',{subject:'ordinary-player'},403],
 ['白名单 subject 但不同 client',{subject:ADMIN,clientId:'other-client'},403],
 ['白名单 subject 但不同 issuer',{subject:ADMIN,issuer:'https://different.example'},403],
 ['相同 issuer/client 的白名单管理员',{subject:ADMIN},200],
])test('管理权限：'+name,async t=>{
  const f=await fixture(t,adminConfig);const account=f.login(identity);const response=await f.request('/api/admin/summary',{cookie:account.cookie});assert.equal(response.status,status);
  const me=await(await f.request('/api/auth/me',{cookie:account.cookie})).json();assert.equal(me.user.admin,status===200);assert.equal(me.user.development,false);
});
test('管理统计只接受 1、7、30 天',async t=>{
  const f=await fixture(t,adminConfig);const account=f.login({subject:ADMIN});for(const days of [0,2,31,'NaN'])assert.equal((await f.request('/api/admin/summary?days='+days,{cookie:account.cookie})).status,400);
  for(const days of [1,7,30]){const res=await f.request('/api/admin/summary?days='+days,{cookie:account.cookie});assert.equal(res.status,200);assert.equal((await res.json()).timeline.length,days);}
});
test('开发登录默认关闭，开启后只能建立显式标记的本地测试身份',async t=>{
  const off=await fixture(t);assert.equal((await off.request('/api/auth/dev-login',{method:'POST'})).status,404);
  const on=await fixture(t,{ALLOW_DEV_LOGIN:'1'});const response=await on.request('/api/auth/dev-login',{method:'POST'});assert.equal(response.status,200);const cookie=cookieHeader(response);
  const session=response.headers.getSetCookie().find(value=>value.startsWith('asteria-session='));assert.match(session,/HttpOnly/);assert.match(session,/SameSite=Lax/);assert.ok(session.includes('Path=/'));assert.doesNotMatch(session,/; Secure/);
  const me=await(await on.request('/api/auth/me',{cookie})).json();assert.equal(me.user.admin,true);assert.equal(me.user.development,true);assert.equal(me.loginEnabled,false);assert.equal((await on.request('/api/admin/summary',{cookie})).status,200);
});
test('开发登录拒绝模拟非 loopback socket，不采信伪造的转发地址',async t=>{
  const f=await fixture(t,{ALLOW_DEV_LOGIN:'1'},'203.0.113.9');const response=await f.request('/api/auth/dev-login',{method:'POST',headers:{'X-Forwarded-For':'127.0.0.1'}});assert.equal(response.status,404);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
});
test('所有写接口拒绝缺失或错误 Origin，且不产生副作用',async t=>{
  const f=await fixture(t,{ALLOW_DEV_LOGIN:'1'});const account=f.login();
  for(const path of ['/api/auth/dev-login','/api/auth/logout','/api/events'])for(const origin of [null,'https://wrong.example'])assert.equal((await f.request(path,{method:'POST',origin,cookie:account.cookie,body:{id:'event-origin-1',type:'page_view'}})).status,403);
  assert.ok(f.store.user(account.token));assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM events').get().n,0);
});
test('注销删除服务端会话并清除 cookie，旧 token 不能继续读取后台',async t=>{
  const f=await fixture(t,adminConfig);const account=f.login({subject:ADMIN});const response=await f.request('/api/auth/logout',{method:'POST',cookie:account.cookie});assert.equal(response.status,200);assert.ok(response.headers.getSetCookie().some(value=>value.startsWith('asteria-session=;')&&value.includes('Max-Age=0')));assert.equal(f.store.user(account.token),undefined);
  assert.equal((await f.request('/api/admin/summary',{cookie:account.cookie})).status,401);assert.equal((await(await f.request('/api/auth/me',{cookie:account.cookie})).json()).user,null);
});
test('未配置 OAuth 时只跳本站错误页，不跳外部登录地址',async t=>{
  const f=await fixture(t);const response=await f.request('/auth/openai');assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/?auth_error=not_configured');assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM transactions').get().n,0);
});

test('事件格式校验拒绝未知类型、非法编号、数组、标识和过大数值',async t=>{
  const f=await fixture(t);const base={id:'event-format-1',type:'page_view',data:{page:'collection'}};
  for(const value of [null,[],{}, {...base,id:'bad'}, {...base,type:'unknown'}, {...base,data:[]}, {...base,data:{score:1.2}}, {...base,data:{coins:1000001}}, {...base,data:{rank:-1}}, {...base,data:{count:-1}}, {...base,data:{turn:-1}}, {...base,data:{score:-1}}, {...base,data:{card:'<script>'}}, {...base,data:{cards:['bad/card']}}, {...base,data:{cards:Array(7).fill('moon-deer')}}]){
    const response=await f.request('/api/events',{method:'POST',body:value});assert.equal(response.status,400,JSON.stringify(value));
  }
  const invalidJson=await f.request('/api/events',{method:'POST',raw:'{broken'});assert.equal(invalidJson.status,400);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM events').get().n,0);
});
test('原型属性标识不会污染组合统计，所有计数都是有限数字',async t=>{
  const f=await fixture(t,adminConfig),admin=f.login({subject:ADMIN});
  for(const id of ['constructor','__proto__','prototype']){
    const response=await f.request('/api/events',{method:'POST',body:{id:'reserved-'+id.replaceAll('_','a'),type:'turn_complete',data:{combo:id}}});assert.equal(response.status,200,id);
  }
  const report=await(await f.request('/api/admin/summary',{cookie:admin.cookie})).json();assert.equal(report.combos.length,3);for(const combo of report.combos)assert.equal(combo.count,1);
});
test('事件去重以访问者及事件 id 为键，重复请求不会重记资源',async t=>{
  const f=await fixture(t,adminConfig),admin=f.login({subject:ADMIN});const body={id:'event-dedupe-1',type:'craft',data:{dust:-60,card:'moon-fawn'}};
  const first=await f.request('/api/events',{method:'POST',cookie:f.visitorName+'='+VISITOR,body});assert.equal(first.status,200);assert.equal((await first.json()).duplicate,false);
  const second=await f.request('/api/events',{method:'POST',cookie:f.visitorName+'='+VISITOR,body:{...body,data:{dust:-999}}});assert.equal((await second.json()).duplicate,true);
  const third=await f.request('/api/events',{method:'POST',cookie:f.visitorName+'='+'b'.repeat(64),body});assert.equal((await third.json()).duplicate,false);
  const report=await(await f.request('/api/admin/summary',{cookie:admin.cookie})).json();assert.equal(report.totals.events,2);assert.equal(report.totals.visitors,2);assert.equal(report.resources.dustOut,120);
});
test('真实 HTTP 事件生成完成率、分数、卡牌组合和资源收支统计',async t=>{
  const f=await fixture(t,adminConfig),player=f.login(),admin=f.login({subject:ADMIN});
  const events=[
    ['run_start',{runId:'run-one',cards:['moon-deer','sun-fox','forest-rabbit']}],
    ['turn_complete',{runId:'run-one',turn:1,score:52,combo:'mirror'}],
    ['run_complete',{runId:'run-one',score:300,coins:180,dust:30,grade:'B'}],
    ['summon',{coins:-180,count:3}],['craft',{dust:-60,card:'moon-fawn'}],
    ['recycle',{dust:10,card:'moon-fawn',count:1}],['strengthen',{coins:-90,rank:2,card:'moon-fawn'}],['page_view',{page:'collection'}],
  ];
  for(let i=0;i<events.length;i++){const [type,data]=events[i];const response=await f.request('/api/events',{method:'POST',cookie:player.cookie,body:{id:'metric-event-'+i,type,data}});assert.equal(response.status,200);}
  const report=await(await f.request('/api/admin/summary',{cookie:admin.cookie})).json();assert.equal(report.source,'client-reported');assert.equal(report.timezone,'Asia/Shanghai');assert.equal(report.totals.events,events.length);assert.equal(report.totals.visitors,1);assert.equal(report.totals.accounts,1);assert.equal(report.totals.starts,1);assert.equal(report.totals.completed,1);assert.equal(report.totals.completionRate,100);assert.equal(report.totals.averageScore,300);assert.equal(report.totals.summons,1);assert.equal(report.grades.B,1);
  assert.deepEqual(report.resources,{coinsIn:180,coinsOut:270,dustIn:40,dustOut:60});assert.deepEqual(report.combos,[{id:'mirror',count:1}]);assert.equal(report.cards.length,3);assert.ok(report.cards.every(c=>c.count===1));assert.equal(report.timeline.reduce((sum,day)=>sum+day.events,0),events.length);
});
test('开发账号事件默认不计入统计，可由管理员显式查看',async t=>{
  const f=await fixture(t,{ALLOW_DEV_LOGIN:'1'});const logged=await f.request('/api/auth/dev-login',{method:'POST'});const cookie=cookieHeader(logged);
  assert.equal((await f.request('/api/events',{method:'POST',cookie,body:{id:'development-event',type:'page_view',data:{page:'admin'}}})).status,200);
  const normal=await(await f.request('/api/admin/summary',{cookie})).json();const included=await(await f.request('/api/admin/summary?includeDev=1',{cookie})).json();assert.equal(normal.totals.events,0);assert.equal(included.totals.events,1);assert.equal(included.recent[0].dev,true);
});
for(const failure of ['missing-cookie','missing-state','wrong-state','expired','missing-code','provider-error'])test('OAuth 回调拒绝 '+failure+'，事务一次性消费且不建立会话',async t=>{
  const f=await fixture(t,adminConfig);const token=randomToken(),state=randomToken();f.store.transaction(token,{state,verifier:randomToken(),nonce:randomToken()});
  if(failure==='expired')f.store.db.prepare('UPDATE transactions SET expires_at=? WHERE token_hash=?').run(Date.now()-1000,hash(token));
  const params=new URLSearchParams({state,code:'synthetic-code-never-exchanged'});
  if(failure==='missing-state')params.delete('state');if(failure==='wrong-state')params.set('state','wrong');if(failure==='missing-code')params.delete('code');if(failure==='provider-error')params.set('error','access_denied');
  const cookie=failure==='missing-cookie'?undefined:f.transactionName+'='+token;
  const response=await f.request('/auth/openai/callback?'+params,{cookie});assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/?auth_error=failed');assert.ok(response.headers.getSetCookie().some(value=>value.startsWith(f.transactionName+'=;')&&value.includes('Max-Age=0')));assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
  if(failure!=='missing-cookie'){
    const again=await f.request('/auth/openai/callback?'+new URLSearchParams({state,code:'synthetic-code-never-exchanged'}),{cookie});assert.equal(again.headers.get('location'),'/?auth_error=failed');assert.equal(f.store.consumeTransaction(token),undefined);
  }
});
test('生产环境强制 HTTPS 且禁止开发登录，开发登录强制绑定 loopback',()=>{
  assert.throws(()=>configFromEnv({NODE_ENV:'production',APP_ORIGIN:'http://127.0.0.1:3000'}),/HTTPS/);
  assert.throws(()=>configFromEnv({NODE_ENV:'production',APP_ORIGIN:'https://game.example',ALLOW_DEV_LOGIN:'1'}),/非生产|loopback/);
  assert.throws(()=>configFromEnv({APP_ORIGIN:'http://public.example',ALLOW_DEV_LOGIN:'1'}),/loopback/);
  assert.throws(()=>configFromEnv({APP_ORIGIN:'https://game.example/path'}),/无路径/);
  const local=configFromEnv({APP_ORIGIN:'http://localhost:3000',ALLOW_DEV_LOGIN:'1',HOST:'0.0.0.0'});assert.equal(local.host,'127.0.0.1');assert.equal(local.devLogin,true);
  const prod=configFromEnv({NODE_ENV:'production',APP_ORIGIN:'https://game.example'});assert.equal(prod.secure,true);assert.equal(prod.devLogin,false);
});
test('生产模式设置安全响应头和 __Host cookie，开发登录保持关闭',async t=>{
  const f=await fixture(t,{NODE_ENV:'production',APP_ORIGIN:'https://game.example'});const response=await f.request('/api/health');assert.equal(response.status,200);assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('x-frame-options'),'DENY');assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(response.headers.get('strict-transport-security'),/max-age/);
  const visitor=response.headers.getSetCookie().find(value=>value.startsWith('__Host-asteria-visitor='));assert.match(visitor,/; Secure/);assert.match(visitor,/; HttpOnly/);assert.doesNotMatch(visitor,/Domain=/);assert.equal((await f.request('/api/auth/dev-login',{method:'POST'})).status,404);
});
