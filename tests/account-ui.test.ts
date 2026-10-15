import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import ts from 'typescript';

const account=readFileSync(new URL('../src/AccountMenu.tsx',import.meta.url),'utf8');
const admin=readFileSync(new URL('../src/Admin.tsx',import.meta.url),'utf8');

test('AuthState 类型显式更新：新增 linuxdoLoginEnabled 与 provider，保留 loginEnabled 旧语义',()=>{
  const type=account.slice(account.indexOf('export interface AuthState'),account.indexOf('export async function readAuth'));
  assert.match(type,/loginEnabled:boolean/);
  assert.match(type,/linuxdoLoginEnabled:boolean/);
  assert.match(type,/provider:string/);
});
test('未登录菜单提供 LINUX DO 主入口，说明自动注册，缺配置时不伪造登录',()=>{
  assert.match(account,/href="\/auth\/linuxdo"/);
  assert.match(account,/使用 LINUX DO 登录 \/ 注册/);
  assert.match(account,/首次登录自动创建游戏账号，无需另设密码/);
  assert.match(account,/LINUX DO 登录暂未配置/);
  // OpenAI 入口仍由自身 loginEnabled 控制，不受 Linux DO 开关影响
  assert.match(account,/\{auth\?\.loginEnabled&&<a className="chatgpt-login" href="\/auth\/openai">/);
});
test('登录后显示昵称与登录方式，管理员链接仅依据服务器返回的 admin 字段',()=>{
  assert.match(account,/登录方式：\{providerLabel\(auth\.user\.provider\)\}/);
  assert.match(account,/href="\/admin"/);
  assert.ok(!account.includes('isAdmin(')&&!account.includes('trust_level'));
});
test('authErrorText 按 provider 区分中英文案，未知错误码统一提示',()=>{
  const source=account.slice(account.indexOf('export function authErrorText'),account.indexOf('export function providerLabel')).replace(/^export /,'');
  const context=createContext({});
  runInContext(ts.transpile(source+'\nglobalThis.api={authErrorText};',{target:ts.ScriptTarget.ES2022}),context);
  const api=context.api as {authErrorText(error:string|null,provider:string|null):string};
  assert.ok(api.authErrorText('not_configured','linuxdo').includes('LINUX DO 登录暂未配置'));
  assert.ok(api.authErrorText('not_configured',null).includes('ChatGPT'));
  assert.ok(!api.authErrorText('not_configured',null).includes('LINUX DO'));
  assert.equal(api.authErrorText('failed','linuxdo'),'LINUX DO 登录未完成，请重试');
  assert.equal(api.authErrorText('failed','openai'),'登录未完成，请重试');
  assert.equal(api.authErrorText('unknown-code','linuxdo'),'登录未完成，请重试');
  assert.equal(api.authErrorText(null,'linuxdo'),'');
});
test('退出登录继续复用本站接口，不调用提供者端点',()=>{
  assert.match(account,/action\('\/api\/auth\/logout'\)/);
  assert.ok(!account.includes('/auth/linuxdo/logout'));
});
test('管理后台登录门支持 LINUX DO，不再把 OpenAI 缺配置当作唯一入口提示',()=>{
  assert.match(admin,/href="\/auth\/linuxdo"/);
  assert.match(admin,/href="\/auth\/openai"/);
  assert.ok(!admin.includes('ChatGPT 登录待配置'));
  assert.match(admin,/正式登录入口尚未配置/);
});
