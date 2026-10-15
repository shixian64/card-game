import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {configFromEnv,createApp} from './index.mjs';
import {openStore,randomToken,hash} from './store.mjs';
import {LINUXDO_ISSUER,parseLinuxdoConfig,verifyLinuxDoIdentity,createLinuxdoProvider,displayName} from './linuxdo.mjs';

// 全程使用内存生成的密钥与模拟上游（discovery / JWKS / Token / UserInfo），不访问 connect.linux.do，
// 不依赖真实账号或 Secret；本文件通过不代表真实联调成功。
const CLIENT='linuxdo-test-client',SECRET='linuxdo-test-secret',SUB='linuxdo-sub-1',ADMIN_SUB='linuxdo-admin-sub';
const [keys,otherKeys,ecKeys]=await Promise.all([generateKeyPair('RS256'),generateKeyPair('RS256'),generateKeyPair('ES256')]);
const jwk={...await exportJWK(keys.publicKey),alg:'RS256',kid:'test-kid-1'};
const DISCOVERY={issuer:LINUXDO_ISSUER,authorization_endpoint:'https://connect.linux.do/oauth2/authorize',token_endpoint:'https://connect.linux.do/oauth2/token',userinfo_endpoint:'https://connect.linux.do/api/user',jwks_uri:'https://connect.linux.do/.well-known/jwks.json'};
function claims(overrides={}) {
  const now=Math.floor(Date.now()/1000);
  return {iss:LINUXDO_ISSUER,aud:CLIENT,sub:SUB,name:'论坛昵称',username:'forum_user',iat:now,exp:now+3600,nonce:'test-nonce',...overrides};
}
async function sign(payload,key=keys.privateKey,alg='RS256') {return new SignJWT(payload).setProtectedHeader({alg,typ:'JWT',kid:jwk.kid}).sign(key);}

test('LINUX DO 配置：双空禁用、缺一报错、方法校验、默认 basic 与管理员名单',()=>{
  const disabled=parseLinuxdoConfig({});
  assert.equal(disabled.enabled,false);assert.equal(disabled.clientId,'');
  const enabled=parseLinuxdoConfig({LINUXDO_CLIENT_ID:CLIENT,LINUXDO_CLIENT_SECRET:SECRET});
  assert.equal(enabled.enabled,true);assert.equal(enabled.method,'client_secret_basic');
  assert.equal(parseLinuxdoConfig({LINUXDO_CLIENT_ID:CLIENT,LINUXDO_CLIENT_SECRET:SECRET,LINUXDO_TOKEN_AUTH_METHOD:'client_secret_post'}).method,'client_secret_post');
  assert.throws(()=>parseLinuxdoConfig({LINUXDO_CLIENT_ID:CLIENT}),/必须同时配置或同时留空/);
  assert.throws(()=>parseLinuxdoConfig({LINUXDO_CLIENT_SECRET:SECRET}),/必须同时配置或同时留空/);
  assert.throws(()=>parseLinuxdoConfig({LINUXDO_CLIENT_ID:CLIENT,LINUXDO_CLIENT_SECRET:SECRET,LINUXDO_TOKEN_AUTH_METHOD:'none'}),/认证方式/);
  assert.deepEqual([...parseLinuxdoConfig({LINUXDO_CLIENT_ID:CLIENT,LINUXDO_CLIENT_SECRET:SECRET,ADMIN_LINUXDO_SUBJECTS:' a , b '}).admins],['a','b']);
  const config=configFromEnv({NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1:3000',LINUXDO_CLIENT_ID:CLIENT,LINUXDO_CLIENT_SECRET:SECRET});
  assert.equal(config.linuxdo.enabled,true);assert.equal(config.linuxdo.clientId,CLIENT);
  assert.throws(()=>configFromEnv({NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1:3000',LINUXDO_CLIENT_ID:CLIENT}),/必须同时配置或同时留空/);
});
test('displayName 依次取资料昵称、用户名、ID Token 声明，缺失用默认玩家名',()=>{
  assert.equal(displayName({name:'甲'},{name:'乙'}),'乙');
  assert.equal(displayName({name:'甲'},{username:'user-b'}),'user-b');
  assert.equal(displayName({username:'user-a'},{}),'user-a');
  assert.equal(displayName({},{name:'  '}),'星序玩家');
  assert.equal(displayName({},null),'星序玩家');
});

const verify=jwt=>verifyLinuxDoIdentity(jwt,keys.publicKey,CLIENT,'test-nonce');
for(const [name,payload,key,alg] of [
  ['错误签名密钥',claims(),otherKeys.privateKey],
  ['issuer 少尾部斜杠',claims({iss:'https://connect.linux.do'})],
  ['issuer 不匹配',claims({iss:'https://different.example'})],
  ['audience 不匹配',claims({aud:'different-client'})],
  ['过期且超时钟容差',claims({iat:Math.floor(Date.now()/1000)-120,exp:Math.floor(Date.now()/1000)-60})],
  ['nonce 不匹配',claims({nonce:'wrong-nonce'})],
  ['nonce 缺失',(()=>{const c=claims();delete c.nonce;return c;})()],
  ['sub 为空字符串',claims({sub:''})],
  ['sub 缺失',(()=>{const c=claims();delete c.sub;return c;})()],
  ['未来签发且超五秒容差',claims({iat:Math.floor(Date.now()/1000)+60})],
  ['nbf 在未来且超容差',claims({nbf:Math.floor(Date.now()/1000)+120})],
  ['多 audience 缺 azp',claims({aud:[CLIENT,'other']})],
  ['多 audience azp 错误',claims({aud:[CLIENT,'other'],azp:'wrong'})],
  ['账号 active=false',claims({active:false})],
  ['ES256 签名',claims(),ecKeys.privateKey,'ES256'],
])test('LINUX DO ID Token 校验拒绝：'+name,async()=>{await assert.rejects(verify(await sign(payload,key,alg)));});
for(const [name,payload] of [
  ['标准声明',claims()],
  ['nbf 已过期',claims({nbf:Math.floor(Date.now()/1000)-10})],
  ['多 audience 且 azp 正确',claims({aud:[CLIENT,'other'],azp:CLIENT})],
  ['active=true',claims({active:true})],
])test('LINUX DO ID Token 校验通过：'+name,async()=>{await verify(await sign(payload));});

function createUpstream() {
  const state={
    discovery:DISCOVERY,jwks:{keys:[jwk]},jwksResponse:null,userinfoResponse:null,
    nonce:'test-nonce',claims:{},key:undefined,alg:'RS256',
    userinfo:{sub:SUB,name:'论坛昵称'},
    tokenBodies:[],calls:[],
  };
  state.tokens=async body=>{const code=new URLSearchParams(body).get('code');return {access_token:'test-access-token',token_type:'Bearer',id_token:await sign({...claims(),...state.claims,nonce:(state.nonceByCode&&state.nonceByCode[code])??state.nonce},state.key,state.alg)};};
  const fetchImpl=async(url,init={})=>{
    state.calls.push({url:String(url),method:init.method||'GET',init});
    const respond=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body,text:async()=>typeof body==='string'?body:JSON.stringify(body)});
    const target=String(url);
    if(target===LINUXDO_ISSUER+'.well-known/openid-configuration')return state.discoveryResponse??respond(200,state.discovery);
    if(target===DISCOVERY.jwks_uri)return state.jwksResponse??respond(200,state.jwks);
    if(target===DISCOVERY.token_endpoint){const result=await state.tokens(String(init.body));state.tokenBodies.push(String(init.body));return 'status' in result&&'text' in result?result:respond(200,result);}
    if(target===DISCOVERY.userinfo_endpoint)return state.userinfoResponse??respond(200,state.userinfo);
    return respond(404,{});
  };
  return {state,fetchImpl};
}
async function fixture(t,env={}) {
  const upstream=createUpstream();
  const config=configFromEnv({NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1:3000',DATABASE_PATH:':memory:',LINUXDO_CLIENT_ID:CLIENT,LINUXDO_CLIENT_SECRET:SECRET,ADMIN_LINUXDO_SUBJECTS:ADMIN_SUB,...env});
  const store=openStore(':memory:');const app=createApp(config,{store,fetch:upstream.fetchImpl});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+app.server.address().port;
  if(!config.secure)config.origin=base;
  t.after(async()=>{app.server.closeAllConnections();await app.close();});
  const sessionName=config.secure?'__Host-asteria-session':'asteria-session';
  const txName=config.secure?'__Host-asteria-linuxdo-transaction':'asteria-linuxdo-transaction';
  async function request(path,{method='GET',body,cookie,headers={}}={}) {
    headers={...headers};if(cookie)headers.Cookie=cookie;
    if(['POST','PUT','PATCH','DELETE'].includes(method))headers.Origin=config.origin;
    if(body!==undefined)headers['Content-Type']='application/json';
    return fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  }
  async function startLogin(extraCookie) {
    const response=await request('/auth/linuxdo',{cookie:extraCookie});
    const entry=response.headers.getSetCookie().find(value=>value.startsWith(txName+'='));
    return {response,location:new URL(response.headers.get('location')||'/','http://local.invalid'),txCookie:entry?entry.split(';')[0]:null};
  }
  const rowOf=txCookie=>store.db.prepare('SELECT * FROM linuxdo_transactions WHERE token_hash=?').get(hash(txCookie.split('=')[1]));
  function arm(flow,overrides={}) { // 把回调所需的 nonce / 声明按 code 写入模拟上游
    const row=rowOf(flow.txCookie),code=overrides.code??'auth-code-1';
    upstream.state.nonce=overrides.nonce??row.nonce;
    upstream.state.nonceByCode={...(upstream.state.nonceByCode??{}),[code]:upstream.state.nonce};
    upstream.state.claims=overrides.claims??{};
    if(overrides.userinfo)upstream.state.userinfo=overrides.userinfo;
    if(overrides.key)upstream.state.key=overrides.key;
    if(overrides.alg)upstream.state.alg=overrides.alg;
    return row;
  }
  async function callback(flow,{state,code='auth-code-1',error,cookie}={}) {
    const params=new URLSearchParams({state:state??flow.location.searchParams.get('state'),code});
    if(error)params.set('error',error);
    return request('/auth/linuxdo/callback?'+params,{cookie:cookie===undefined?flow.txCookie:cookie});
  }
  async function login(overrides={}) {
    const flow=await startLogin();assert.equal(flow.response.status,302,'/auth/linuxdo 应跳转授权页');
    const row=arm(flow,overrides);
    const response=await callback(flow,{state:row.state,code:overrides.code});
    const entry=response.headers.getSetCookie().find(value=>value.startsWith(sessionName+'='));
    return {response,flow,row,sessionCookie:entry?entry.split(';')[0]:null};
  }
  return {app,config,store,base,upstream,request,startLogin,rowOf,arm,callback,login,sessionName,txName};
}

test('未配置时 /auth/linuxdo 跳固定错误码且不建事务、不访问上游',async t=>{
  const f=await fixture(t,{LINUXDO_CLIENT_ID:'',LINUXDO_CLIENT_SECRET:''});
  const {response}=await f.startLogin();
  assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/?auth_error=not_configured&provider=linuxdo');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM linuxdo_transactions').get().n,0);
  assert.equal(f.upstream.state.calls.length,0);
  const me=await(await f.request('/api/auth/me')).json();
  assert.equal(me.linuxdoLoginEnabled,false);assert.equal(me.loginEnabled,false);assert.equal(me.user,null);
});
test('loginEnabled 保持 OpenAI 旧语义，Linux DO 单独开关',async t=>{
  const f=await fixture(t);
  const me=await(await f.request('/api/auth/me')).json();
  assert.equal(me.loginEnabled,false);assert.equal(me.linuxdoLoginEnabled,true);
});
test('授权请求携带精确端点、scope、PKCE S256 与精确回调，事务只存哈希不存明文 verifier 到 Cookie',async t=>{
  const f=await fixture(t);
  const flow=await f.startLogin();
  assert.equal(flow.location.origin+flow.location.pathname,'https://connect.linux.do/oauth2/authorize');
  const query=flow.location.searchParams;
  assert.equal(query.get('client_id'),CLIENT);
  assert.equal(query.get('redirect_uri'),f.config.origin+'/auth/linuxdo/callback');
  assert.equal(query.get('response_type'),'code');
  assert.equal(query.get('scope'),'openid profile');
  assert.equal(query.get('code_challenge_method'),'S256');
  const row=f.rowOf(flow.txCookie);
  assert.ok(row);assert.equal(query.get('state'),row.state);assert.equal(query.get('nonce'),row.nonce);
  assert.equal(query.get('code_challenge'),createHash('sha256').update(row.verifier).digest('base64url'));
  const cookieEntry=flow.response.headers.getSetCookie().find(value=>value.startsWith(f.txName+'='));
  assert.match(cookieEntry,/HttpOnly/);assert.match(cookieEntry,/SameSite=Lax/);assert.match(cookieEntry,/Max-Age=600/);assert.ok(cookieEntry.includes('Path=/'));
  assert.equal(row.client_id,CLIENT);assert.equal(row.redirect_uri,f.config.origin+'/auth/linuxdo/callback');
});
test('正常首次登录：自动注册、初始资产只发一次、建立会话、Token 请求凭据只在 Authorization 头',async t=>{
  const f=await fixture(t);
  const done=await f.login();
  assert.equal(done.response.status,302);
  assert.equal(done.response.headers.get('location'),'/?login=success&provider=linuxdo');
  assert.equal(done.response.headers.get('cache-control'),'no-store');
  const exchange=f.upstream.state.calls.find(call=>call.url===DISCOVERY.token_endpoint);
  assert.equal(exchange.method,'POST');
  const expected='Basic '+Buffer.from(CLIENT+':'+SECRET).toString('base64');
  assert.equal(exchange.init.headers.Authorization,expected);
  const form=new URLSearchParams(f.upstream.state.tokenBodies[0]);
  assert.equal(form.get('grant_type'),'authorization_code');
  assert.equal(form.get('code'),'auth-code-1');
  assert.equal(form.get('redirect_uri'),f.config.origin+'/auth/linuxdo/callback');
  assert.ok(form.get('code_verifier'));
  assert.equal(form.get('client_secret'),null);assert.equal(form.get('client_id'),null);
  assert.equal(exchange.url,DISCOVERY.token_endpoint); // 凭据不进 URL
  const userinfoCall=f.upstream.state.calls.find(call=>call.url===DISCOVERY.userinfo_endpoint);
  assert.equal(userinfoCall.init.headers.Authorization,'Bearer test-access-token');
  const user=f.store.db.prepare('SELECT * FROM users').get();
  assert.equal(user.issuer,LINUXDO_ISSUER);assert.equal(user.client_id,CLIENT);assert.equal(user.subject,SUB);assert.equal(user.name,'论坛昵称');
  const profile=f.store.db.prepare('SELECT * FROM profiles WHERE user_id=?').get(user.id);
  const state=JSON.parse(profile.state);
  // 新经济：注册只建空档案 + starter=pending，不再发旧 1280/360/3 礼包。
  assert.equal(state.coins,0);assert.equal(state.cards.length,0);assert.equal(state.starter.status,'pending');assert.equal(state.version,2);
  const me=await(await f.request('/api/auth/me',{cookie:done.sessionCookie})).json();
  assert.equal(me.user.provider,'linuxdo');assert.equal(me.user.admin,false);assert.equal(me.user.development,false);
  assert.equal(me.linuxdoLoginEnabled,true);
});
test('上游请求统一携带超时与 redirect:error，不跟随异常重定向',async t=>{
  const f=await fixture(t);
  await f.login();
  for(const call of f.upstream.state.calls) {
    assert.ok(call.init.signal,'请求必须带超时信号');
    assert.equal(call.init.redirect,'error','上游请求禁止跟随重定向');
  }
});
test('显式配置 client_secret_post 时凭据放表单且不发 Authorization 头',async t=>{
  const f=await fixture(t,{LINUXDO_TOKEN_AUTH_METHOD:'client_secret_post'});
  const done=await f.login();
  assert.equal(done.response.headers.get('location'),'/?login=success&provider=linuxdo');
  const exchange=f.upstream.state.calls.find(call=>call.url===DISCOVERY.token_endpoint);
  assert.equal(exchange.init.headers.Authorization,undefined);
  const form=new URLSearchParams(f.upstream.state.tokenBodies[0]);
  assert.equal(form.get('client_id'),CLIENT);assert.equal(form.get('client_secret'),SECRET);
});
for(const failure of ['missing-cookie','missing-state','wrong-state','expired','missing-code','provider-denied','wrong-client','wrong-redirect'])test('回调拒绝 '+failure+'：无注册无会话，事务一次性消费',async t=>{
  const f=await fixture(t);
  const flow=await f.startLogin();const row=f.rowOf(flow.txCookie);assert.ok(row);
  if(failure==='expired')f.store.db.prepare('UPDATE linuxdo_transactions SET expires_at=? WHERE token_hash=?').run(Date.now()-1000,row.token_hash);
  if(failure==='wrong-client')f.store.db.prepare('UPDATE linuxdo_transactions SET client_id=? WHERE token_hash=?').run('other-client',row.token_hash);
  if(failure==='wrong-redirect')f.store.db.prepare('UPDATE linuxdo_transactions SET redirect_uri=? WHERE token_hash=?').run('https://elsewhere.example/callback',row.token_hash);
  const params=new URLSearchParams({state:failure==='wrong-state'?'wrong':row.state,code:'auth-code-1'});
  if(failure==='missing-state')params.delete('state');
  if(failure==='missing-code')params.delete('code');
  if(failure==='provider-denied')params.set('error','access_denied');
  const response=await f.request('/auth/linuxdo/callback?'+params,{cookie:failure==='missing-cookie'?undefined:flow.txCookie});
  assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/?auth_error=failed&provider=linuxdo');
  assert.ok(response.headers.getSetCookie().some(value=>value.startsWith(f.txName+'=;')&&value.includes('Max-Age=0')));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM users').get().n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM profiles').get().n,0);
  const again=await f.request('/auth/linuxdo/callback?'+new URLSearchParams({state:row.state,code:'auth-code-1'}),{cookie:flow.txCookie});
  assert.equal(again.headers.get('location'),'/?auth_error=failed&provider=linuxdo'); // 重放：事务已被消费
});
for(const [name,prepare] of [
  ['Token 端点 500',f=>{f.upstream.state.tokens=async()=>({ok:false,status:500,text:async()=>'Internal Server Error'});}],
  ['Token 端点非 JSON',f=>{f.upstream.state.tokens=async()=>({ok:true,status:200,text:async()=>'not json at all'});}],
  ['Token 响应过大',f=>{f.upstream.state.tokens=async()=>({ok:true,status:200,text:async()=>'x'.repeat(300000)});}],
  ['缺少 id_token',f=>{f.upstream.state.tokens=async()=>({access_token:'a',token_type:'Bearer'});}],
  ['JWKS 端点失败',f=>{f.upstream.state.jwksResponse={ok:false,status:500,text:async()=>'nope'};}],
  ['JWKS 非 JSON',f=>{f.upstream.state.jwksResponse={ok:true,status:200,text:async()=>'broken'};}],
  ['错误签名密钥',f=>{f.upstream.state.key=otherKeys.privateKey;}],
  ['ID Token nonce 不匹配',f=>{f.upstream.state.nonceByCode=undefined;f.upstream.state.nonce='wrong-nonce-for-tx';}],
  ['ID Token issuer 缺尾部斜杠',f=>{f.upstream.state.claims={iss:'https://connect.linux.do'};}],
  ['ID Token audience 不匹配',f=>{f.upstream.state.claims={aud:'other-client'};}],
  ['ID Token 过期',f=>{const now=Math.floor(Date.now()/1000);f.upstream.state.claims={iat:now-120,exp:now-60};}],
  ['ID Token active=false',f=>{f.upstream.state.claims={active:false};}],
  ['ES256 签名',f=>{f.upstream.state.key=ecKeys.privateKey;f.upstream.state.alg='ES256';}],
])test('上游或令牌校验失败拒绝登录：'+name,async t=>{
  const f=await fixture(t);
  const flow=await f.startLogin();const row=f.arm(flow);prepare(f);
  const response=await f.callback(flow,{state:row.state});
  assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/?auth_error=failed&provider=linuxdo');
  assert.ok(!response.headers.get('location').includes(SECRET));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM users').get().n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
});
test('discovery 不可用时开始登录返回 5xx，不跳授权页、不建事务',async t=>{
  const f=await fixture(t);
  f.upstream.state.discoveryResponse={ok:false,status:503,text:async()=>'unavailable'};
  const flow=await f.startLogin();
  assert.equal(flow.response.status,500);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM linuxdo_transactions').get().n,0);
});
test('UserInfo：sub 不一致不采信其资料；active=false 拒绝；资料失败仍可登录',async t=>{
  const sub='userinfo-check-sub';
  const a=await fixture(t);a.upstream.state.userinfo={sub:'different-sub',name:'冒名昵称'};
  const first=await a.login({claims:{sub,name:'令牌昵称'}});
  assert.equal(first.response.headers.get('location'),'/?login=success&provider=linuxdo');
  assert.equal(a.store.db.prepare('SELECT name FROM users').get().name,'令牌昵称');
  const b=await fixture(t);b.upstream.state.userinfo={sub,active:false};
  const second=await b.login({claims:{sub}});
  assert.equal(second.response.headers.get('location'),'/?auth_error=failed&provider=linuxdo');
  assert.equal(b.store.db.prepare('SELECT count(*) AS n FROM users').get().n,0);
  const c=await fixture(t);c.upstream.state.userinfoResponse={ok:false,status:503,text:async()=>'down'};
  const third=await c.login({claims:{sub,name:'',username:'fallback-user'}});
  assert.equal(third.response.headers.get('location'),'/?login=success&provider=linuxdo');
  assert.equal(c.store.db.prepare('SELECT name FROM users').get().name,'fallback-user');
});
test('再次登录同 sub 复用同一内部用户与玩家编号，资产不重置、不重发初始资源',async t=>{
  const f=await fixture(t);
  const first=await f.login();
  const before=f.store.db.prepare('SELECT * FROM users').get();
  const profileBefore=f.store.db.prepare('SELECT * FROM profiles').get();
  const claim=await f.request('/api/game/starter.claim',{method:'POST',cookie:first.sessionCookie,headers:{'X-Asteria-User':before.id},body:{requestId:'starter-once-0001',favoriteDefId:'moon-deer'}});
  assert.equal(claim.status,200);assert.equal((await claim.json()).state.coins,600);
  const second=await f.login({claims:{name:'新昵称'},userinfo:{sub:SUB,name:'新昵称'}});
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM users').get().n,1);
  const after=f.store.db.prepare('SELECT * FROM users').get();
  assert.equal(after.id,before.id);assert.equal(after.name,'新昵称');
  const profileAfter=f.store.db.prepare('SELECT * FROM profiles').get();
  assert.equal(profileAfter.code,profileBefore.code);assert.equal(profileAfter.revision,profileBefore.revision+1);
  const game=await(await f.request('/api/game',{cookie:second.sessionCookie,headers:{'X-Asteria-User':after.id}})).json();
  assert.equal(game.state.starter.status,'claimed');assert.equal(game.state.coins,600);assert.equal(game.state.cards.length,23);
});
test('并发重复回调只初始化一次：两个事务并发登录同一 sub 仍只有一个账号',async t=>{
  const f=await fixture(t);
  const results=await Promise.all([f.login(),f.login({code:'auth-code-2'})]);
  for(const result of results)assert.equal(result.response.headers.get('location'),'/?login=success&provider=linuxdo');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM users').get().n,1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM profiles').get().n,1);
  assert.equal(JSON.parse(f.store.db.prepare('SELECT state FROM profiles').get().state).starter.status,'pending');
});
test('同名不同 sub、同 sub 不同 issuer / client 不合并身份',async t=>{
  const f=await fixture(t);
  await f.login({claims:{sub:'sub-a',name:'同名玩家'}});
  await f.login({claims:{sub:'sub-b',name:'同名玩家'}});
  const rows=f.store.db.prepare('SELECT * FROM users').all();
  assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.id)).size,2);
  const direct=openStore(':memory:');
  const make=identity=>direct.shortTransaction(()=>direct.login(identity));
  const ids=new Set([make({issuer:LINUXDO_ISSUER,clientId:CLIENT,subject:'same-sub',name:'甲'}).user.id,
    make({issuer:'https://other.example',clientId:CLIENT,subject:'same-sub',name:'甲'}).user.id,
    make({issuer:LINUXDO_ISSUER,clientId:'other-client',subject:'same-sub',name:'甲'}).user.id]);
  assert.equal(ids.size,3);
});
test('提供者事务隔离：Linux DO 事务不能在 OpenAI 回调使用，反之亦然',async t=>{
  const f=await fixture(t,{OPENAI_CLIENT_ID:'openai-client'});
  const flow=await f.startLogin();
  const linuxdoOnOpenai=await f.request('/auth/openai/callback?state=x&code=y',{cookie:flow.txCookie});
  assert.equal(linuxdoOnOpenai.headers.get('location'),'/?auth_error=failed');
  const openaiToken=randomToken();f.store.transaction(openaiToken,{state:'s',verifier:'v',nonce:'n'});
  const openaiCookie=(f.config.secure?'__Host-asteria-transaction':'asteria-transaction')+'='+openaiToken;
  const openaiOnLinuxdo=await f.request('/auth/linuxdo/callback?state=s&code=y',{cookie:openaiCookie});
  assert.equal(openaiOnLinuxdo.headers.get('location'),'/?auth_error=failed&provider=linuxdo');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM users').get().n,0);
});
test('开始新的 Linux DO 登录使同浏览器旧事务失效',async t=>{
  const f=await fixture(t);
  const first=await f.startLogin();
  const second=await f.startLogin(first.txCookie);
  assert.equal(f.rowOf(first.txCookie),undefined);
  assert.ok(f.rowOf(second.txCookie));
});
test('登录失败保留原会话与资产；登录成功后旋转会话',async t=>{
  const f=await fixture(t);
  const initial=await f.login({claims:{sub:'old-sub'}});
  const failed=await f.callback(await f.startLogin(),{state:'wrong'});
  assert.equal(failed.headers.get('location'),'/?auth_error=failed&provider=linuxdo');
  const still=await(await f.request('/api/auth/me',{cookie:initial.sessionCookie})).json();
  assert.equal(still.user.subject,'old-sub');
  const flow=await f.startLogin();const row=f.arm(flow,{claims:{sub:'new-sub'}});
  const switched=await f.callback(flow,{state:row.state,cookie:flow.txCookie+'; '+initial.sessionCookie});
  assert.equal(switched.headers.get('location'),'/?login=success&provider=linuxdo');
  assert.equal((await(await f.request('/api/auth/me',{cookie:initial.sessionCookie})).json()).user,null);
  const fresh=switched.headers.getSetCookie().find(value=>value.startsWith(f.sessionName+'='));
  assert.equal((await(await f.request('/api/auth/me',{cookie:fresh.split(';')[0]})).json()).user.subject,'new-sub');
});
test('管理员只按已验证 subject 白名单：普通 403，高信任等级不自动提权，OpenAI 名单不跨界',async t=>{
  const f=await fixture(t,{ADMIN_OPENAI_SUBJECTS:ADMIN_SUB});
  const player=await f.login({claims:{sub:'ordinary',trust_level:4}});
  const playerMe=await(await f.request('/api/auth/me',{cookie:player.sessionCookie})).json();
  assert.equal(playerMe.user.admin,false);
  assert.equal((await f.request('/api/admin/summary',{cookie:player.sessionCookie})).status,403);
  const admin=await f.login({claims:{sub:ADMIN_SUB}});
  const adminMe=await(await f.request('/api/auth/me',{cookie:admin.sessionCookie})).json();
  assert.equal(adminMe.user.admin,true);assert.equal(adminMe.user.provider,'linuxdo');
  assert.equal((await f.request('/api/admin/summary',{cookie:admin.sessionCookie})).status,200);
});
test('最短业务闭环：登录→抽卡→退出→再登录，资源变化保持、初始资产不重发',async t=>{
  const f=await fixture(t);
  const first=await f.login({claims:{sub:'loop-sub'}});
  const user=f.store.db.prepare('SELECT * FROM users').get();
  const start=await(await f.request('/api/game',{cookie:first.sessionCookie,headers:{'X-Asteria-User':user.id}})).json();
  assert.equal(start.state.starter.status,'pending');
  const craft=await f.request('/api/game/craft',{method:'POST',cookie:first.sessionCookie,headers:{'X-Asteria-User':user.id},body:{requestId:'loop-craft-001',defId:'moon-deer',paymentMode:'normal_only'}});
  assert.equal(craft.status,400,'未领礼包前未拥有任何卡，制作被拒且不扣费');
  const logout=await f.request('/api/auth/logout',{method:'POST',cookie:first.sessionCookie});
  assert.equal(logout.status,200);
  assert.equal((await(await f.request('/api/auth/me',{cookie:first.sessionCookie})).json()).user,null);
  const again=await f.login({claims:{sub:'loop-sub'}});
  const before=await(await f.request('/api/game',{cookie:again.sessionCookie,headers:{'X-Asteria-User':user.id}})).json();
  assert.equal(before.state.starter.status,'pending','退出重登不自动发礼包');
  const claim2=await f.request('/api/game/starter.claim',{method:'POST',cookie:again.sessionCookie,headers:{'X-Asteria-User':user.id},body:{requestId:'loop-claim-001',favoriteDefId:'sun-fox'}});
  assert.equal(claim2.status,200);
  const resume=await(await f.request('/api/game',{cookie:again.sessionCookie,headers:{'X-Asteria-User':user.id}})).json();
  assert.equal(resume.code,start.code);assert.equal(resume.state.cards.length,23);assert.equal(resume.state.coins,600);assert.equal(resume.state.starter.status,'claimed');
});
test('旧入口回归：开发登录、OpenAI 字段与本地事务语义不受影响',async t=>{
  const f=await fixture(t,{ALLOW_DEV_LOGIN:'1'});
  const dev=await f.request('/api/auth/dev-login',{method:'POST'});
  assert.equal(dev.status,200);
  const me=await(await f.request('/api/auth/me',{cookie:dev.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')})).json();
  assert.equal(me.user.development,true);assert.equal(me.user.provider,'development');assert.equal(me.user.admin,true);
  assert.equal(me.linuxdoLoginEnabled,true);
  await f.startLogin();
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM transactions').get().n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM linuxdo_transactions').get().n,1);
});
test('授权入口限频：超过阈值返回 429，不跳外部地址',async t=>{
  const f=await fixture(t);
  for(let i=0;i<15;i++){const r=await f.startLogin();assert.equal(r.response.status,302);}
  const extra=await f.request('/auth/linuxdo');
  assert.equal(extra.status,429);assert.equal(extra.headers.get('location'),null);
});
test('createLinuxdoProvider 在未配置时拒绝构造',()=>{
  assert.throws(()=>createLinuxdoProvider({config:{enabled:false}}),/未配置/);
});
