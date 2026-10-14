import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,timingSafeEqual} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify} from 'jose';
import {createGameService} from './game.mjs';
import {createSocialService} from './social.mjs';
import {openStore,randomToken,hash,validateEvent,summary} from './store.mjs';

const ISSUER='https://auth.openai.com';
const loopback=v=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(v);
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function verifyOpenAiIdentity(idToken,jwks,clientId,nonce) {
  const {payload}=await jwtVerify(idToken,jwks,{issuer:ISSUER,audience:clientId,algorithms:['RS256','ES256'],requiredClaims:['sub','exp','iat'],clockTolerance:5});
  if(!equal(payload.nonce,nonce)||typeof payload.sub!=='string'||!payload.sub||payload.iat>Date.now()/1000+5)throw new Error('身份校验失败');
  if(Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==clientId)throw new Error('授权对象不匹配');
  return payload;
}
export function configFromEnv(env=process.env) {
  const production=env.NODE_ENV==='production';
  const origin=new URL(env.APP_ORIGIN||'http://127.0.0.1:3000');
  if(origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error('APP_ORIGIN 必须是无路径的站点来源');
  if(production&&origin.protocol!=='https:')throw new Error('生产 APP_ORIGIN 必须使用 HTTPS');
  const local=['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
  const devLogin=env.ALLOW_DEV_LOGIN==='1';
  if(devLogin&&(production||!local))throw new Error('本地开发登录只能在非生产、loopback 来源启用');
  const method=env.OPENAI_TOKEN_AUTH_METHOD||'none';
  if(!['none','client_secret_basic'].includes(method))throw new Error('不支持的 OAuth token 认证方式');
  if(method==='client_secret_basic'&&!env.OPENAI_CLIENT_SECRET)throw new Error('缺少 OPENAI_CLIENT_SECRET');
  return {production,origin:origin.origin,secure:origin.protocol==='https:',devLogin,
    host:devLogin?'127.0.0.1':(env.HOST||'127.0.0.1'),port:Number(env.PORT||3000),
    clientId:env.OPENAI_CLIENT_ID||'',secret:env.OPENAI_CLIENT_SECRET||'',method,
    admins:new Set((env.ADMIN_OPENAI_SUBJECTS||'').split(',').map(s=>s.trim()).filter(Boolean)),
    database:env.DATABASE_PATH||resolve('data/asteria.sqlite'),dist:resolve('dist'),
  };
}
function cookies(req) {return Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split(/=(.*)/s)).filter(p=>p.length>=2).map(p=>[p[0],p[1]]));}
function send(res,status,value) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function redirect(res,url) {res.writeHead(302,{Location:url,'Cache-Control':'no-store'});res.end();}
function cookie(res,name,value,secure,maxAge=28800) {const entry=name+'='+value+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+maxAge+(secure?'; Secure':'');res.setHeader('Set-Cookie',[...(res.getHeader('Set-Cookie')||[]),entry]);}
async function json(req) {let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>16384){const e=new Error('请求过大');e.status=413;throw e;}chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{const e=new Error('JSON 格式不正确');e.status=400;throw e;}}
export function createApp(config=configFromEnv(),options={}) {
  const store=options.store??openStore(config.database);store.clean();
  const game=createGameService(store.db,{now:options.now}),social=createSocialService(store.db);
  const sessionName=config.secure?'__Host-asteria-session':'asteria-session';
  const transactionName=config.secure?'__Host-asteria-transaction':'asteria-transaction';
  const visitorName=config.secure?'__Host-asteria-visitor':'asteria-visitor';
  let discoveryPromise;const rates=new Map();let lastClean=Date.now();
  const isAdmin=user=>!!user&&(user.issuer===ISSUER&&user.client_id===config.clientId&&config.admins.has(user.subject)||config.devLogin&&user.issuer==='local-development'&&user.subject==='local-admin');
  async function discovery() {
    discoveryPromise??=(async()=>{
      const response=await fetch(ISSUER+'/.well-known/openid-configuration',{signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('登录服务暂不可用');
      const d=await response.json();
      if(d.issuer!==ISSUER)throw new Error('登录服务 issuer 不匹配');
      for(const key of ['authorization_endpoint','token_endpoint','jwks_uri'])if(new URL(d[key]).origin!==ISSUER)throw new Error('登录服务端点不匹配');
      return {...d,jwks:createRemoteJWKSet(new URL(d.jwks_uri))};
    })().catch(e=>{discoveryPromise=null;throw e;});
    return discoveryPromise;
  }
  function limited(key,max) {
    const now=Date.now();let record=rates.get(key);if(!record||record.until<now){record={until:now+60000,count:0};rates.set(key,record);}record.count++;
    if(rates.size>5000)for(const [k,v] of rates)if(v.until<now)rates.delete(k);
    return record.count>max;
  }
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(config.secure)res.setHeader('Strict-Transport-Security','max-age=31536000');
    let path='/';
    try {
    const url=new URL(req.url||'/',config.origin);path=url.pathname;
    const jar=cookies(req),user=store.user(jar[sessionName]);
    let visitor=jar[visitorName];
    if(!/^[a-f0-9]{64}$/.test(visitor??'')){visitor=hash(randomToken());cookie(res,visitorName,visitor,config.secure,90*86400);}
    if(Date.now()-lastClean>3600000){store.clean();lastClean=Date.now();}
      if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&req.headers.origin!==config.origin)return send(res,403,{error:'来源校验失败'});
      if(req.method==='GET'&&path==='/api/health')return send(res,200,{ok:true});
      if(req.method==='GET'&&path==='/api/auth/me')return send(res,200,{user:user?{id:user.id,name:user.name,subject:user.subject,admin:isAdmin(user),development:user.issuer==='local-development'}:null,loginEnabled:!!config.clientId,devLogin:config.devLogin,analytics:true});
      if(req.method==='POST'&&path==='/api/auth/logout'){store.logout(jar[sessionName]);cookie(res,sessionName,'',config.secure,0);return send(res,200,{ok:true});}
      if(req.method==='POST'&&path==='/api/auth/dev-login') {
        if(!config.devLogin||!loopback(req.socket.remoteAddress))return send(res,404,{error:'未启用'});
        const body=req.headers['content-length']&&req.headers['content-length']!=='0'?await json(req):{};
        const profiles={admin:{subject:'local-admin',name:'本地玩家 A · 管理员'},playerB:{subject:'local-player-b',name:'本地玩家 B'},playerC:{subject:'local-player-c',name:'本地玩家 C'}};
        const selected=Object.hasOwn(profiles,body.profile||'admin')?profiles[body.profile||'admin']:null;if(!selected)return send(res,400,{error:'开发账号不存在'});
        store.logout(jar[sessionName]);const session=store.login({issuer:'local-development',clientId:'local-only',...selected});game.ensureProfile(session.user);
        cookie(res,sessionName,session.token,config.secure);return send(res,200,{ok:true});
      }
      if(req.method==='GET'&&path==='/auth/openai') {
        if(!config.clientId)return redirect(res,'/?auth_error=not_configured');
        if(limited('auth:'+req.socket.remoteAddress,15))return send(res,429,{error:'登录尝试过多，请稍后重试'});
        const d=await discovery(),token=randomToken(),transaction={state:randomToken(),verifier:randomToken(),nonce:randomToken()};
        if(jar[transactionName])store.consumeTransaction(jar[transactionName]);
        store.transaction(token,transaction);cookie(res,transactionName,token,config.secure,600);
        const auth=new URL(d.authorization_endpoint);
        auth.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.origin+'/auth/openai/callback',response_type:'code',scope:'openid profile email',state:transaction.state,nonce:transaction.nonce,code_challenge:createHash('sha256').update(transaction.verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
        return redirect(res,auth.toString());
      }
      if(req.method==='GET'&&path==='/auth/openai/callback') {
        const token=jar[transactionName],transaction=token?store.consumeTransaction(token):null;
        cookie(res,transactionName,'',config.secure,0);
        try {
          if(!config.clientId||!transaction||transaction.expires_at<Date.now()||!equal(transaction.state,url.searchParams.get('state'))||url.searchParams.has('error')||!url.searchParams.get('code'))throw new Error('无效登录回调');
          const d=await discovery(),body=new URLSearchParams({grant_type:'authorization_code',client_id:config.clientId,redirect_uri:config.origin+'/auth/openai/callback',code:url.searchParams.get('code'),code_verifier:transaction.verifier});
          const headers={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
          if(config.method==='client_secret_basic'){
            const encode=value=>new URLSearchParams({value}).toString().slice(6);
            headers.Authorization='Basic '+Buffer.from(encode(config.clientId)+':'+encode(config.secret)).toString('base64');
          }
          const exchange=await fetch(d.token_endpoint,{method:'POST',headers,body,signal:AbortSignal.timeout(10000)});
          if(!exchange.ok)throw new Error('登录令牌交换失败');
          const tokens=await exchange.json();if(typeof tokens.id_token!=='string')throw new Error('缺少 ID token');
          const payload=await verifyOpenAiIdentity(tokens.id_token,d.jwks,config.clientId,transaction.nonce);
          store.logout(jar[sessionName]);
          const session=store.login({issuer:ISSUER,clientId:config.clientId,subject:payload.sub,name:typeof payload.name==='string'?payload.name:'星序玩家'});
          cookie(res,sessionName,session.token,config.secure);return redirect(res,'/?login=success');
        } catch {return redirect(res,'/?auth_error=failed');}
      }
      if(req.method==='POST'&&path==='/api/events') {
        if(limited('event:'+req.socket.remoteAddress,600)||limited('visitor:'+visitor,120))return send(res,429,{error:'事件发送过于频繁'});
        let event;try{event=validateEvent(await json(req));}catch(e){return send(res,e.status||400,{error:e.message});}
        const added=store.event(visitor,user,event);return send(res,200,{ok:true,duplicate:!added});
      }
      if(req.method==='GET'&&path==='/api/admin/summary') {
        if(!user)return send(res,401,{error:'请先登录'});
        if(!isAdmin(user))return send(res,403,{error:'当前账号没有管理员权限'});
        const days=Number(url.searchParams.get('days')||7);if(![1,7,30].includes(days))return send(res,400,{error:'仅支持 1、7、30 天'});
        return send(res,200,summary(store,days,url.searchParams.get('includeDev')==='1'));
      }
      if(path==='/api/game'||path.startsWith('/api/game/')||path.startsWith('/api/market')||path.startsWith('/api/social')||path==='/api/chat'||path==='/api/admin/economy'){
        if(!user)return send(res,401,{error:'请先登录账号'});
        if(req.headers['x-asteria-user']&&req.headers['x-asteria-user']!==user.id)return send(res,409,{error:'账号已切换，请刷新游戏'});
        game.ensureProfile(user);
        if(req.method==='GET'&&path==='/api/game')return send(res,200,game.snapshot(user));
        if(req.method==='GET'&&path==='/api/market')return send(res,200,game.marketSnapshot(user,Object.fromEntries(url.searchParams)));
        if(req.method==='GET'&&path==='/api/social')return send(res,200,social.snapshot(user));
        if(req.method==='GET'&&path==='/api/chat')return send(res,200,{messages:social.messages(user,url.searchParams.get('channel')||'world')});
        if(req.method==='GET'&&path==='/api/admin/economy'){
          if(!isAdmin(user))return send(res,403,{error:'没有管理员权限'});
          const days=Number(url.searchParams.get('days')||7);if(![1,7,30].includes(days))return send(res,400,{error:'不支持的统计周期'});
          return send(res,200,{...game.adminSummary(days),social:social.adminStats()});
        }
        if(req.method==='POST'){
          if(limited('command:'+user.id,120))return send(res,429,{error:'操作太快，请稍后再试'});
          const input=await json(req);
          if(!input||typeof input!=='object'||Array.isArray(input))return send(res,400,{error:'请求格式错误'});
          try {
            if(path.startsWith('/api/game/battle.'))return send(res,410,{error:'单场试玩已停用，请开始 10 分钟对局'});
            if(path.startsWith('/api/game/'))return send(res,200,game.game(user,path.slice('/api/game/'.length),input));
            if(path.startsWith('/api/market/'))return send(res,200,game.market(user,path.slice('/api/market/'.length),input));
            if(path.startsWith('/api/social/'))return send(res,200,social.execute(user,path.slice('/api/social/'.length),input));
          }catch(e){return send(res,e.status||400,{error:e.message||'操作失败'});}
        }
      }
      if(path.startsWith('/api/')||path.startsWith('/auth/'))return send(res,404,{error:'接口不存在'});
      if(!['GET','HEAD'].includes(req.method))return send(res,405,{error:'不支持的请求方法'});
      let file;
      try {const decoded=decodeURIComponent(path);if(decoded.includes('..')||decoded.includes('\\')||decoded.includes('\0'))return send(res,400,{error:'路径不正确'});file=resolve(config.dist,'.'+decoded);if(file!==config.dist&&!file.startsWith(config.dist+sep))return send(res,403,{error:'禁止访问'});if((await stat(file)).isDirectory())file=resolve(file,'index.html');}
      catch {if(!extname(path))file=resolve(config.dist,'index.html');else return send(res,404,{error:'资源不存在'});}
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2'};
      const content=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':extname(file)==='.html'?'no-cache':path.startsWith('/assets/')?'public, max-age=31536000, immutable':'public, max-age=3600'});res.end(req.method==='HEAD'?undefined:content);
    } catch(e) {if(!res.headersSent)send(res,Number.isInteger(e.status)&&e.status>=400&&e.status<500?e.status:500,{error:e.status?e.message:'服务暂不可用，请稍后重试'});else res.end();console.error('Request failed:',path,e.code||e.name);}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,store,game,social,isAdmin,close:()=>new Promise(resolve=>server.close(()=>{store.db.close();resolve();}))};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  const config=configFromEnv(),app=createApp(config);
  app.server.listen(config.port,config.host,()=>console.log('星序本地服务：http://'+config.host+':'+config.port+' · 管理后台 /admin'+(config.devLogin?' · 本地开发登录已启用':'')));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{app.close().then(()=>process.exit(0));});
}
