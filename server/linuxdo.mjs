import {createHash,timingSafeEqual} from 'node:crypto';
import {importJWK,jwtVerify} from 'jose';

export const LINUXDO_ISSUER='https://connect.linux.do/';
const LINUXDO_ORIGIN='https://connect.linux.do';
const AUTH_METHODS=new Set(['client_secret_basic','client_secret_post']);
const UPSTREAM_TIMEOUT=10000,MAX_BODY=262144,JWKS_CACHE_MS=86400000,JWKS_REFRESH_COOLDOWN=30000;
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

export function parseLinuxdoConfig(env=process.env) {
  const clientId=(env.LINUXDO_CLIENT_ID||'').trim(),secret=(env.LINUXDO_CLIENT_SECRET||'').trim();
  if(clientId?!secret:!!secret)throw new Error('LINUXDO_CLIENT_ID 与 LINUXDO_CLIENT_SECRET 必须同时配置或同时留空');
  const method=env.LINUXDO_TOKEN_AUTH_METHOD||'client_secret_basic';
  if(!AUTH_METHODS.has(method))throw new Error('不支持的 LINUX DO Token 认证方式');
  return {enabled:!!clientId&&!!secret,clientId,secret,method,
    admins:new Set((env.ADMIN_LINUXDO_SUBJECTS||'').split(',').map(s=>s.trim()).filter(Boolean))};
}

export async function verifyLinuxDoIdentity(idToken,jwks,clientId,nonce) {
  const {payload}=await jwtVerify(idToken,jwks,{issuer:LINUXDO_ISSUER,audience:clientId,algorithms:['RS256'],requiredClaims:['sub','exp','iat'],clockTolerance:5});
  if(!equal(payload.nonce,nonce)||typeof payload.sub!=='string'||!payload.sub||payload.iat>Date.now()/1000+5)throw new Error('LINUX DO 身份校验失败');
  if(Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==clientId)throw new Error('授权对象不匹配');
  if(payload.active===false)throw new Error('该 LINUX DO 账号当前不可用');
  return payload;
}

async function readJson(response) {
  const text=await response.text();
  if(text.length>MAX_BODY)throw new Error('上游响应过大');
  try{return JSON.parse(text);}catch{throw new Error('上游响应不是有效 JSON');}
}
export function displayName(payload,profile) {
  for(const source of [profile,payload])for(const key of ['name','username']) {
    const value=source?.[key];
    if(typeof value==='string'&&value.trim())return value.trim();
  }
  return '星序玩家';
}

export function createLinuxdoProvider({config,fetchImpl=fetch}={}) {
  if(!config?.enabled)throw new Error('LINUX DO 登录未配置');
  const upstream=(url,init={})=>fetchImpl(url,{...init,redirect:'error',signal:AbortSignal.timeout(UPSTREAM_TIMEOUT)});
  let discoveryPromise,document=null,jwksDocument=null,jwksAt=0,jwksRefreshAt=0;
  async function discovery() {
    discoveryPromise??=(async()=>{
      const response=await upstream(LINUXDO_ISSUER+'.well-known/openid-configuration',{headers:{Accept:'application/json'}});
      if(!response.ok)throw new Error('登录服务暂不可用');
      const value=await readJson(response);
      if(value?.issuer!==LINUXDO_ISSUER)throw new Error('登录服务 issuer 不匹配');
      for(const key of ['authorization_endpoint','token_endpoint','jwks_uri'])if(typeof value[key]!=='string'||new URL(value[key]).origin!==LINUXDO_ORIGIN)throw new Error('登录服务端点不匹配');
      if(value.userinfo_endpoint!==undefined&&(typeof value.userinfo_endpoint!=='string'||new URL(value.userinfo_endpoint).origin!==LINUXDO_ORIGIN))throw new Error('登录服务端点不匹配');
      document=value;return value;
    })().catch(e=>{discoveryPromise=null;throw e;});
    return discoveryPromise;
  }
  async function loadJwks() {
    const d=await discovery();
    const response=await upstream(d.jwks_uri,{headers:{Accept:'application/json'}});
    if(!response.ok)throw new Error('登录公钥暂不可用');
    const value=await readJson(response);
    if(!value||!Array.isArray(value.keys)||!value.keys.length)throw new Error('登录公钥格式不正确');
    jwksDocument=value;jwksAt=Date.now();return value;
  }
  // 可信 JWKS 验签：缓存一天，未知 kid 受控刷新一次并带冷却，避免刷爆上游。
  async function jwksKey(protectedHeader) {
    const kid=protectedHeader?.kid;
    const pick=doc=>doc.keys.find(k=>k.kid===kid&&(k.alg==='RS256'||k.alg===undefined&&k.kty==='RSA'&&k.use==='sig'));
    const doc=jwksDocument&&Date.now()-jwksAt<JWKS_CACHE_MS?jwksDocument:await loadJwks();
    let key=pick(doc);
    if(!key) {
      if(Date.now()-jwksRefreshAt<JWKS_REFRESH_COOLDOWN)throw new Error('未知签名密钥');
      jwksRefreshAt=Date.now();key=pick(await loadJwks());
    }
    if(!key)throw new Error('未知签名密钥');
    return importJWK(key,'RS256');
  }
  async function authorizeUrl(transaction) {
    const d=await discovery(),url=new URL(d.authorization_endpoint);
    url.search=new URLSearchParams({client_id:config.clientId,redirect_uri:transaction.redirectUri,response_type:'code',scope:'openid profile',state:transaction.state,nonce:transaction.nonce,code_challenge:createHash('sha256').update(transaction.verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
    return url.toString();
  }
  async function exchange({code,verifier,redirectUri}) {
    const d=await discovery();
    const body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirectUri,code_verifier:verifier});
    const headers={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
    if(config.method==='client_secret_basic') {
      const encode=value=>new URLSearchParams({value}).toString().slice(6);
      headers.Authorization='Basic '+Buffer.from(encode(config.clientId)+':'+encode(config.secret)).toString('base64');
    }else{body.set('client_id',config.clientId);body.set('client_secret',config.secret);}
    const response=await upstream(d.token_endpoint,{method:'POST',headers,body});
    if(!response.ok)throw new Error('登录令牌交换失败');
    const tokens=await readJson(response);
    if(!tokens||typeof tokens.id_token!=='string')throw new Error('缺少 ID Token');
    return tokens;
  }
  async function userinfo(accessToken) {
    const d=await discovery();
    if(typeof d.userinfo_endpoint!=='string')return null;
    const response=await upstream(d.userinfo_endpoint,{headers:{Authorization:'Bearer '+accessToken,Accept:'application/json'}});
    if(!response.ok)throw new Error('用户资料获取失败');
    const value=await readJson(response);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('用户资料格式不正确');
    return value;
  }
  return {discovery,jwksKey,authorizeUrl,exchange,userinfo};
}
