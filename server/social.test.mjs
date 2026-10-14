import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from './store.mjs';
import {createSocialService} from './social.mjs';

function fixture(t,count=4){
  const {db}=openStore(':memory:');
  db.exec("CREATE TABLE profiles(user_id TEXT PRIMARY KEY REFERENCES users(id),code TEXT UNIQUE,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0)");
  const users=[];
  for(let n=1;n<=count;n++){
    const user={id:'u'+n,name:'玩家'+n};
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(user.id,'test','test',user.id,user.name,1,1);
    db.prepare('INSERT INTO profiles VALUES(?,?,?,0)').run(user.id,'AST-'+n.toString(16).padStart(8,'0').toUpperCase(),'{"unchanged":true}');
    users.push(user);
  }
  let time=1700000000000;
  const service=createSocialService(db,{now:()=>time});
  t.after(()=>db.close());
  const tick=(ms=3100)=>{time+=ms;};
  const befriend=(a,b)=>{service.execute(a,'friend.request',{code:service.snapshot(b).self.code});service.execute(b,'friend.accept',{userId:a.id});tick();};
  return {db,service,users,tick,befriend};
}
function error(status){return value=>{assert.equal(value.status,status);assert.ok(value.message);return true;};}

test('snapshot exposes self and social peers, never all accounts or profile state',t=>{
  const {service,users}=fixture(t);
  assert.deepEqual(service.snapshot(users[0]),{self:{id:'u1',name:'玩家1',code:'AST-00000001'},friends:[],incoming:[],outgoing:[]});
  assert.throws(()=>service.snapshot(null),error(401));
  assert.throws(()=>service.snapshot({id:'missing'}),error(409));
});
test('friend codes are trimmed and normalized, exact lookup only',t=>{
  const {service,users,tick}=fixture(t,12);
  service.execute(users[0],'friend.request',{code:' ast-0000000a '});
  assert.deepEqual(service.snapshot(users[0]).outgoing,[{id:'u10',name:'玩家10',code:'AST-0000000A'}]);
  assert.deepEqual(service.snapshot(users[9]).incoming,[{id:'u1',name:'玩家1',code:'AST-00000001'}]);
  for(const code of ['AST-','%','AST-00000001 OR 1=1','AST-00000000']){tick();assert.throws(()=>service.execute(users[0],'friend.request',{code}),error(404));}
});
test('self, duplicate, crossed and unauthorized friend actions are denied',t=>{
  const {service,users,tick}=fixture(t);
  assert.throws(()=>service.execute(users[0],'friend.request',{code:'AST-00000001'}),error(400));
  service.execute(users[0],'friend.request',{code:'AST-00000002'});
  tick();
  assert.throws(()=>service.execute(users[0],'friend.request',{code:'AST-00000002'}),error(409));
  assert.throws(()=>service.execute(users[1],'friend.request',{code:'AST-00000001'}),error(409));
  assert.throws(()=>service.execute(users[2],'friend.accept',{userId:'u1'}),error(404));
  assert.throws(()=>service.execute(users[0],'friend.accept',{userId:'u2'}),error(404));
});
test('accept creates both edges, clears pending requests and preserves game state',t=>{
  const {service,users,db,befriend}=fixture(t);
  befriend(users[0],users[1]);
  assert.deepEqual(service.snapshot(users[0]).friends,[{id:'u2',name:'玩家2',code:'AST-00000002'}]);
  assert.deepEqual(service.snapshot(users[1]).friends,[{id:'u1',name:'玩家1',code:'AST-00000001'}]);
  assert.equal(service.snapshot(users[0]).outgoing.length,0);
  assert.equal(service.snapshot(users[1]).incoming.length,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM friendships').get().n,2);
  assert.equal(db.prepare('SELECT state FROM profiles WHERE user_id=?').get('u1').state,'{"unchanged":true}');
  assert.throws(()=>service.execute(users[0],'friend.request',{code:'AST-00000002'}),error(409));
});
test('decline removes request without creating friendship',t=>{
  const {service,users}=fixture(t);
  service.execute(users[0],'friend.request',{code:'AST-00000002'});
  assert.deepEqual(service.execute(users[1],'friend.decline',{userId:'u1'}),{ok:true});
  assert.equal(service.snapshot(users[0]).outgoing.length,0);
  assert.equal(service.snapshot(users[1]).friends.length,0);
});
test('world text remains plain text and Unicode limit counts characters',t=>{
  const {service,users,tick}=fixture(t);
  const message=service.execute(users[0],'chat.send',{channel:'world',text:' <script>alert(1)</script>\n你好 '}).message;
  assert.equal(message.text,'<script>alert(1)</script>\n你好');
  assert.equal(message.senderId,'u1');
  assert.equal(message.at,1700000000000);
  assert.deepEqual(service.messages(users[1],'world'),[message]);
  tick();
  service.execute(users[0],'chat.send',{channel:'world',text:'🌙'.repeat(300)});
  assert.equal([...service.messages(users[1],'world')[1].text].length,300);
});
test('empty, oversized, nontext and control character messages are rejected',t=>{
  const {service,users}=fixture(t);
  for(const text of ['', ' \n ', '月'.repeat(301), '🌙'.repeat(301), 42, {}, 'a\u0000b', 'a\u007fb'])
    assert.throws(()=>service.execute(users[0],'chat.send',{channel:'world',text}),error(400));
  assert.equal(service.messages(users[0]).length,0);
  service.execute(users[0],'chat.send',{channel:'world',text:'合法消息'});
  assert.equal(service.messages(users[0]).length,1);
});
test('private messages are visible only to both participants',t=>{
  const {service,users,befriend,tick}=fixture(t);
  befriend(users[0],users[1]);befriend(users[0],users[2]);
  service.execute(users[0],'chat.send',{channel:'u2',text:'只给二号的消息'});
  tick();service.execute(users[1],'chat.send',{channel:'u1',text:'收到'});
  assert.equal(service.messages(users[0],'u2').length,2);
  assert.equal(service.messages(users[1],'u1').length,2);
  assert.equal(service.messages(users[2],'u1').length,0);
  assert.equal(service.messages(users[3],'world').length,0);
  assert.throws(()=>service.messages(users[2],'u2'),error(403));
  assert.throws(()=>service.execute(users[3],'chat.send',{channel:'u1',text:'绕过好友'}),error(403));
  assert.throws(()=>service.messages(users[0],'u1'),error(400));
});
test('one-sided relationship is not friendship and cannot authorize private messages',t=>{
  const {service,users,db}=fixture(t);
  db.prepare('INSERT INTO friendships VALUES(?,?,?)').run('u1','u2',1);
  assert.equal(service.snapshot(users[0]).friends.length,0);
  assert.equal(service.snapshot(users[1]).friends.length,0);
  assert.throws(()=>service.messages(users[0],'u2'),error(403));
  assert.throws(()=>service.execute(users[1],'chat.send',{channel:'u1',text:'test'}),error(403));
  assert.equal(service.adminStats().friendships,0);
});
test('removing a friend removes both edges and revokes private history access',t=>{
  const {service,users,befriend,db}=fixture(t);
  befriend(users[0],users[1]);
  service.execute(users[0],'chat.send',{channel:'u2',text:'之前的消息'});
  service.execute(users[1],'friend.remove',{userId:'u1'});
  assert.equal(service.snapshot(users[0]).friends.length,0);
  assert.equal(service.snapshot(users[1]).friends.length,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM friendships').get().n,0);
  assert.throws(()=>service.messages(users[0],'u2'),error(403));
  assert.throws(()=>service.execute(users[1],'chat.send',{channel:'u1',text:'之后的消息'}),error(403));
});
test('messages returns latest 50 in chronological order',t=>{
  const {service,users,tick}=fixture(t);
  for(let n=1;n<=60;n++){service.execute(users[0],'chat.send',{channel:'world',text:'消息'+n});tick();}
  const messages=service.messages(users[1]);
  assert.equal(messages.length,50);
  assert.equal(messages[0].text,'消息11');
  assert.equal(messages[49].text,'消息60');
  assert.ok(messages.every((m,i)=>i===0||m.at>messages[i-1].at));
});
test('message rate limiting persists across service instances',t=>{
  const {service,users,db,tick}=fixture(t);
  service.execute(users[0],'chat.send',{channel:'world',text:'1'});
  assert.throws(()=>service.execute(users[0],'chat.send',{channel:'world',text:'2'}),error(429));
  for(let n=2;n<=20;n++){tick(1200);service.execute(users[0],'chat.send',{channel:'world',text:String(n)});}
  tick(1200);
  assert.throws(()=>service.execute(users[0],'chat.send',{channel:'world',text:'21'}),error(429));
  const next=createSocialService(db,{now:()=>1700000024000});
  assert.throws(()=>next.execute(users[0],'chat.send',{channel:'world',text:'reloaded'}),error(429));
  tick(60000);
  service.execute(users[0],'chat.send',{channel:'world',text:'new window'});
  assert.equal(service.messages(users[0]).length,21);
});
test('friend requests have a minimum interval and a per-minute cap',t=>{
  const {service,users,tick}=fixture(t,13);
  service.execute(users[0],'friend.request',{code:'AST-00000002'});
  assert.throws(()=>service.execute(users[0],'friend.request',{code:'AST-00000003'}),error(429));
  for(let n=3;n<=11;n++){tick(3000);service.execute(users[0],'friend.request',{code:'AST-'+n.toString(16).padStart(8,'0').toUpperCase()});}
  tick(3000);
  assert.throws(()=>service.execute(users[0],'friend.request',{code:'AST-0000000C'}),error(429));
  assert.equal(service.snapshot(users[0]).outgoing.length,10);
  tick(60000);
  service.execute(users[0],'friend.request',{code:'AST-0000000C'});
});
test('invalid requests do not consume successful send allowance',t=>{
  const {service,users}=fixture(t);
  assert.throws(()=>service.execute(users[0],'chat.send',{channel:'u2',text:'not a friend'}),error(403));
  assert.throws(()=>service.execute(users[0],'friend.request',{code:'missing'}),error(404));
  service.execute(users[0],'chat.send',{channel:'world',text:'valid'});
  service.execute(users[0],'friend.request',{code:'AST-00000002'});
  assert.equal(service.messages(users[0]).length,1);
  assert.equal(service.snapshot(users[0]).outgoing.length,1);
});
test('admin counts are aggregate only, with pairs counted once',t=>{
  const {service,users,befriend,tick}=fixture(t);
  befriend(users[0],users[1]);
  service.execute(users[2],'friend.request',{code:'AST-00000004'});
  service.execute(users[0],'chat.send',{channel:'world',text:'public'});
  tick();service.execute(users[0],'chat.send',{channel:'u2',text:'secret'});
  assert.deepEqual(service.adminStats(),{friendships:1,worldMessages:1,privateMessages:1,pendingRequests:1});
  assert.equal(JSON.stringify(service.adminStats()).includes('secret'),false);
});
test('malformed operations fail without modifying social tables',t=>{
  const {service,users}=fixture(t);
  for(const input of [null,[],42])assert.throws(()=>service.execute(users[0],'friend.request',input),error(400));
  assert.throws(()=>service.execute(users[0],'unknown',{}),error(400));
  for(const channel of ['',null,42,'x'.repeat(161)])assert.throws(()=>service.messages(users[0],channel),error(400));
  assert.deepEqual(service.adminStats(),{friendships:0,worldMessages:0,privateMessages:0,pendingRequests:0});
});

test('forged message sender fields cannot impersonate another player',t=>{
  const {service,users,db}=fixture(t);
  const result=service.execute(users[0],'chat.send',{channel:'world',text:'hello',userId:'u2',senderId:'u2',senderName:'伪造玩家'});
  assert.equal(result.message.senderId,'u1');
  assert.equal(result.message.senderName,'玩家1');
  assert.equal(db.prepare('SELECT sender_id FROM social_messages').get().sender_id,'u1');
});
test('friend acceptance cannot be redirected by forged recipient fields',t=>{
  const {service,users}=fixture(t);
  service.execute(users[0],'friend.request',{code:'AST-00000002'});
  assert.throws(()=>service.execute(users[2],'friend.accept',{userId:'u1',recipientId:'u2',recipient_id:'u2'}),error(404));
  assert.equal(service.snapshot(users[1]).incoming.length,1);
  assert.equal(service.snapshot(users[2]).friends.length,0);
});

// Exercise the real frontend request/selection helpers without a browser or extra
// DOM dependencies. React and CSS are not evaluated by these pure helper tests.
async function communityHelpers(fetchImpl){
  const [{readFile},{runInNewContext},ts]=await Promise.all([import('node:fs/promises'),import('node:vm'),import('typescript')]);
  const source=await readFile(new URL('../src/Community.tsx',import.meta.url),'utf8');
  const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}});
  const exports={};
  runInNewContext(outputText,{exports,require:()=>({}),fetch:fetchImpl,AbortController,DOMException,URLSearchParams,setTimeout,clearTimeout,console});
  return exports;
}
test('community GET and POST bind the expected account in the same request',async()=>{
  const requests=[];
  const {communityRequest}=await communityHelpers(async(path,init)=>{requests.push({path,init});return {ok:true,status:200,json:async()=>({ok:true})};});
  await communityRequest('/api/chat?channel=u2','u1');
  await communityRequest('/api/market/buy','u1',{listingId:'listing-1',requestId:'stable-request-id'});
  assert.equal(requests[0].init.headers['X-Asteria-User'],'u1');
  assert.equal(requests[1].init.headers['X-Asteria-User'],'u1');
  assert.equal(requests[0].init.method,'GET');
  assert.equal(requests[1].init.method,'POST');
  assert.equal(requests[1].init.headers['Content-Type'],'application/json');
  assert.equal(requests[1].init.credentials,'same-origin');
});
test('market retry keeps the original idempotency key and body',async()=>{
  const requests=[];
  const {communityRequest}=await communityHelpers(async(path,init)=>{requests.push(init.body);return {ok:true,status:200,json:async()=>({ok:true})};});
  const input={listingId:'listing-1',requestId:'stable-request-id'};
  await communityRequest('/api/market/buy','u1',input);
  await communityRequest('/api/market/buy','u1',input);
  assert.equal(requests[0],requests[1]);
  assert.equal(JSON.parse(requests[1]).requestId,'stable-request-id');
  assert.deepEqual(input,{listingId:'listing-1',requestId:'stable-request-id'});
});
test('changed-account conflict surfaces instead of reporting success',async()=>{
  const {communityRequest}=await communityHelpers(async()=>({ok:false,status:409,json:async()=>({error:'账号已切换，请刷新游戏'})}));
  await assert.rejects(communityRequest('/api/social','u1'),/账号已切换/);
});
test('an aborted late response is discarded even if transport still resolves',async()=>{
  const controller=new AbortController();
  const {communityRequest}=await communityHelpers(async()=>({ok:true,status:200,json:async()=>{controller.abort();return {messages:[{text:'old secret'}]};}}));
  await assert.rejects(communityRequest('/api/chat?channel=u2','u1',undefined,controller.signal),caught=>caught.name==='AbortError');
});
test('private message and market views never reuse another account or channel snapshot',async()=>{
  const {selectChatMessages,selectMarketSnapshot}=await communityHelpers();
  const messages=[{id:'m1',senderId:'u2',senderName:'玩家2',text:'secret',at:1}];
  const chat={actor:'u1',channel:'u2',messages};
  assert.equal(selectChatMessages(chat,'u1','u2'),messages);
  assert.equal(selectChatMessages(chat,'u3','u2').length,0);
  assert.equal(selectChatMessages(chat,'u1','world').length,0);
  assert.equal(selectChatMessages(chat,'u1','u3').length,0);
  assert.equal(selectChatMessages(null,'u1','u2').length,0);
  const market={actor:'u1',value:{listings:[],mine:[{id:'private-listing'}]}};
  assert.equal(selectMarketSnapshot(market,'u1'),market.value);
  assert.equal(selectMarketSnapshot(market,'u2').mine.length,0);
});

test('market query delegates filtering, sort and pagination to the server',async()=>{
  const {marketQueryString}=await communityHelpers();
  const filters={search:' 月纱 ',affinity:'moon',role:'守护',rarity:'SSR',rank:'2',minPrice:' 100 ',maxPrice:'1000'};
  const params=new URLSearchParams(marketQueryString(filters,'mine','level',3));
  assert.equal(params.get('search'),'月纱');
  assert.equal(params.get('affinity'),'moon');
  assert.equal(params.get('role'),'守护');
  assert.equal(params.get('rarity'),'SSR');
  assert.equal(params.get('rank'),'2');
  assert.equal(params.get('minPrice'),'100');
  assert.equal(params.get('maxPrice'),'1000');
  assert.equal(params.get('scope'),'mine');
  assert.equal(params.get('sort'),'level');
  assert.equal(params.get('page'),'3');
});
test('empty market filters are omitted and personal history does not invent a server scope',async()=>{
  const {marketQueryString}=await communityHelpers();
  const empty={search:' ',affinity:'',role:'',rarity:'',rank:'',minPrice:'',maxPrice:''};
  const params=new URLSearchParams(marketQueryString(empty,'history','newest',2));
  assert.deepEqual(Object.fromEntries(params),{scope:'all',sort:'newest',page:'1'});
});
test('sell tool quotes match the exact definition and level, not shared artwork',async()=>{
  const {selectCardQuote}=await communityHelpers();
  const row={defId:'moon-deer',rank:2,activeCount:0,lowestPrice:null,lastPrice:120,medianPrice7d:110.5,sales7d:2};
  const snapshot={listings:[],mine:[],quotes:[{...row,rank:1,lowestPrice:40,activeCount:4},row,{...row,defId:'star-deer',lowestPrice:80}]};
  assert.equal(selectCardQuote(snapshot,{uid:'c1',defId:'moon-deer',rank:2,best:0}),row);
  assert.equal(selectCardQuote(snapshot,{uid:'c1',defId:'moon-deer',rank:3,best:0}),undefined);
  assert.equal(selectCardQuote(snapshot,undefined),undefined);
  assert.equal(selectCardQuote({listings:[],mine:[]},{uid:'c1',defId:'moon-deer',rank:2,best:0}),undefined);
  assert.equal(row.lowestPrice,null);
  assert.equal(row.activeCount,0);
});
