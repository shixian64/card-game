import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { verifyOpenAiIdentity } from './index.mjs';

// 仅使用内存生成的测试密钥；不访问 JWKS/OAuth 外网，也不代表真实 OpenAI 登录成功。
const CLIENT='identity-test-client';
const NONCE='identity-test-nonce';
const ISSUER='https://auth.openai.com';
const [rsa,otherRsa,ec]=await Promise.all([generateKeyPair('RS256'),generateKeyPair('RS256'),generateKeyPair('ES256')]);
function claims(overrides={}) {
  const now=Math.floor(Date.now()/1000);
  return {iss:ISSUER,aud:CLIENT,sub:'synthetic-test-subject',name:'测试身份',iat:now,exp:now+3600,nonce:NONCE,...overrides};
}
async function token(payload=claims(),key=rsa.privateKey,alg='RS256') {
  return new SignJWT(payload).setProtectedHeader({alg,typ:'JWT'}).sign(key);
}
const verify=(jwt,key=rsa.publicKey)=>verifyOpenAiIdentity(jwt,key,CLIENT,NONCE);

test('合法 RS256 与 ES256 签名及身份声明可通过本地验证',async()=>{
  for(const [alg,pair] of [['RS256',rsa],['ES256',ec]]){
    const payload=claims();const actual=await verify(await token(payload,pair.privateKey,alg),pair.publicKey);
    assert.equal(actual.sub,payload.sub);assert.equal(actual.iss,ISSUER);assert.equal(actual.aud,CLIENT);assert.equal(actual.nonce,NONCE);
  }
});
test('错误签名不能通过公钥校验',async()=>{
  await assert.rejects(verify(await token(claims(),otherRsa.privateKey)));
});
test('issuer 不匹配时拒绝身份',async()=>{
  await assert.rejects(verify(await token(claims({iss:'https://different.example'}))));
});
test('audience 不匹配时拒绝身份',async()=>{
  await assert.rejects(verify(await token(claims({aud:'different-client'}))));
});
test('已过期且超出时钟容差的 token 被拒绝',async()=>{
  const now=Math.floor(Date.now()/1000);await assert.rejects(verify(await token(claims({iat:now-120,exp:now-60}))));
});
test('nonce 不匹配或缺失时拒绝身份',async()=>{
  await assert.rejects(verify(await token(claims({nonce:'wrong-nonce'}))));
  const payload=claims();delete payload.nonce;await assert.rejects(verify(await token(payload)));
});
test('未来签发且超出五秒容差的 token 被拒绝',async()=>{
  await assert.rejects(verify(await token(claims({iat:Math.floor(Date.now()/1000)+60}))));
});
test('必须存在 sub、exp、iat 三个声明',async()=>{
  for(const key of ['sub','exp','iat']){const payload=claims();delete payload[key];await assert.rejects(verify(await token(payload)),key+' is required');}
});
test('多个 audience 时 azp 错误或缺失均被拒绝',async()=>{
  const aud=[CLIENT,'another-audience'];
  await assert.rejects(verify(await token(claims({aud,azp:'wrong-client'}))));
  await assert.rejects(verify(await token(claims({aud}))));
});
test('多个 audience 包含本客户端且 azp 正确时通过',async()=>{
  const payload=await verify(await token(claims({aud:[CLIENT,'another-audience'],azp:CLIENT})));
  assert.equal(payload.azp,CLIENT);assert.ok(payload.aud.includes(CLIENT));
});
