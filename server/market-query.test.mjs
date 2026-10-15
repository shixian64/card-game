import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openStore} from './store.mjs';
import {createGameService} from './game.mjs';
import {createMarketQuery} from './market-query.mjs';
const input=(x={})=>({requestId:randomUUID(),...x});
async function fixture(options={}){const store=openStore(':memory:'),game=createGameService(store.db,{forgeRandom:()=>0.99,...options});const users=['seller','buyer','third'].map(subject=>store.login({issuer:'test',clientId:'test',subject,name:subject}).user);users.forEach(u=>game.ensureProfile(u));
  // 直接写入 v2 档案种子卡（free 来源），聚焦查询层行为；发卡链路由 game.test.mjs 覆盖。
  const seedCards=(user,entries)=>{const row=store.db.prepare('SELECT state FROM profiles WHERE user_id=?').get(user.id);const state=JSON.parse(row.state);let id=state.nextId;for(const [defId,rank] of entries)state.cards.push({uid:'c'+(id++),defId,rank,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1});state.nextId=id;state.coins=Math.max(state.coins,100000);store.db.prepare('UPDATE profiles SET state=? WHERE user_id=?').run(JSON.stringify(state),user.id);};
  const CARDS=(await import('../src/data.ts')).CARDS;
  for(const user of users)seedCards(user,[...CARDS.map(def=>[def.id,1]),['moon-fawn',1],['moon-fawn',1],['moon-fawn',1],['sun-fox',1],['sun-fox',1],['sun-cub',1],['sun-cub',1],['sun-cub',1]]);
  const list=(seller,defId,price)=>{const uid=game.snapshot(seller).state.cards.find(c=>c.defId===defId).uid;game.market(seller,'list',input({uid,price}));return game.marketSnapshot(seller).mine.find(l=>l.card.uid===uid);};
  return {store,game,users,list,seedCards,close:()=>store.db.close()};}
test('空市场不编造价格与成交数据',async()=>{const f=await fixture();try{const m=f.game.marketSnapshot(f.users[0]);assert.equal(m.total,0);assert.equal(m.stats.trades24h,0);assert.equal(m.quote.lowestPrice,null);assert.equal(m.quote.medianPrice24h,null);assert.equal(m.quote.lastPrice,null);assert.deepEqual(m.quotes,[]);}finally{f.close();}});
test('市场组合筛选、价格排序与个人挂单范围由服务端执行',async()=>{const f=await fixture();try{const [a,b]=f.users;f.list(a,'moon-deer',300);f.list(b,'sun-fox',80);f.list(a,'moon-fawn',60);f.list(b,'sun-fox',120);assert.deepEqual(f.game.marketSnapshot(a,{affinity:'sun',role:'法师',rank:'1',minPrice:'70',maxPrice:'150',sort:'low'}).listings.map(l=>l.price),[80,120]);assert.deepEqual(f.game.marketSnapshot(a,{sort:'high'}).listings.map(l=>l.price),[300,120,80,60]);assert.equal(f.game.marketSnapshot(a,{scope:'mine'}).total,2);assert.equal(f.game.marketSnapshot(a,{search:'银角'}).listings[0].card.defId,'moon-fawn');assert.equal(f.game.marketSnapshot(a,{search:"' OR 1=1 --"}).total,0);assert.equal(f.game.marketSnapshot(a,{affinity:'forest'}).total,0);}finally{f.close();}});
test('稀有度筛选已取消：非空 rarity 参数返回明确 400，不再静默筛选',async()=>{const f=await fixture();try{for(const value of ['R','SR','SSR','UR'])assert.throws(()=>f.game.marketSnapshot(f.users[0],{rarity:value}),error=>error.status===400&&error.message.includes('稀有度'));assert.doesNotThrow(()=>f.game.marketSnapshot(f.users[0],{rarity:''}));}finally{f.close();}});
test('统计只计真实成交，撤单不算成交；同卡同等级报价与中位价正确',async()=>{const f=await fixture();try{const [a,b]=f.users;const one=f.list(a,'moon-fawn',100);f.game.market(b,'buy',input({listingId:one.id}));const two=f.list(a,'moon-fawn',300);f.game.market(b,'buy',input({listingId:two.id}));const open=f.list(a,'moon-fawn',250);const cancelled=f.list(a,'sun-cub',500);f.game.market(a,'cancel',input({listingId:cancelled.id}));const m=f.game.marketSnapshot(a,{search:'银角',rank:'1'});assert.equal(m.quote.medianPrice24h,200);assert.equal(m.quote.lastPrice,300);assert.equal(m.quote.lowestPrice,250);assert.equal(m.stats.trades24h,2);assert.equal(m.stats.volume24h,400);assert.equal(m.stats.activeListings,1);assert.equal(m.stats.sellers,1);const q=m.quotes.find(q=>q.defId==='moon-fawn'&&q.rank===1);assert.deepEqual({count:q.activeCount,lowest:q.lowestPrice,median:q.medianPrice7d,sales:q.sales7d},{count:1,lowest:250,median:200,sales:2});assert.equal(m.recentTrades.length,2);assert.ok(m.history.some(x=>x.type==='cancel'));assert.equal(m.history.filter(x=>x.type==='sell').reduce((n,x)=>n+x.fee,0),20);assert.equal(f.game.marketSnapshot(b).history.every(x=>x.type==='buy'),true);assert.equal(f.game.marketSnapshot(f.users[2]).history.length,0);assert.equal(open.price,250);}finally{f.close();}});
test('新挂单冻结 ceil 手续费：10/19/20/21 星币的单笔 fee 与历史读值一致',async()=>{const f=await fixture();try{const [a,b]=f.users;const fees=[];for(const [defId,price] of [['moon-deer',10],['sun-fox',19],['moon-fawn',20],['sun-cub',21]]){const listing=f.list(a,defId,price);const row=f.store.db.prepare('SELECT fee FROM listings WHERE id=?').get(listing.id);fees.push(row.fee);}assert.deepEqual(fees,[1,1,1,2]);const bought=f.list(a,'forest-rabbit',19);const sellerBefore=f.game.snapshot(a).state.coins;f.game.market(b,'buy',input({listingId:bought.id}));const sellerGain=f.game.snapshot(a).state.coins-sellerBefore;assert.equal(sellerGain,19-1,'旧 floor 规则会得 0，新规则 ceil 至少 1');assert.equal(f.game.marketSnapshot(a).history.find(x=>x.price===19&&x.type==='sell').fee,1);}finally{f.close();}});
test('不同等级不能混用行情，过期成交不计24小时或7天',async()=>{const f=await fixture();try{const [a,b]=f.users;const one=f.list(a,'moon-fawn',111);f.game.market(b,'buy',input({listingId:one.id}));f.store.db.prepare('UPDATE listings SET closed_at=? WHERE id=?').run(Date.now()-8*86400000,one.id);f.game.game(a,'forge',input({defId:'sun-cub'}));const upgraded=f.game.snapshot(a).state.cards.find(c=>c.defId==='sun-cub'&&c.rank===2);f.game.market(a,'list',input({uid:upgraded.uid,price:999}));const m=f.game.marketSnapshot(b,{rank:'2'});assert.equal(m.total,1);assert.equal(m.quote.lastPrice,null);assert.equal(m.stats.trades24h,0);const q=m.quotes.find(q=>q.defId==='moon-fawn');assert.equal(q.lastPrice,111);assert.equal(q.medianPrice7d,null);assert.equal(q.sales7d,0);}finally{f.close();}});
test('超过20挂单时真实分页不丢数据，稳定排序，页码越界回末页',async()=>{const f=await fixture();try{const [a,b]=f.users;let n=0;for(const user of [a,b]){for(const card of f.game.snapshot(user).state.cards.slice(0,15))f.game.market(user,'list',input({uid:card.uid,price:100+(n++)}));}const first=f.game.marketSnapshot(a,{sort:'low'}),second=f.game.marketSnapshot(a,{sort:'low',page:'2'}),overflow=f.game.marketSnapshot(a,{sort:'low',page:'999'});assert.equal(first.total,30);assert.equal(first.listings.length,20);assert.equal(second.listings.length,10);assert.equal(new Set([...first.listings,...second.listings].map(l=>l.id)).size,30);assert.equal(overflow.page,2);assert.equal(first.mine.length,15);assert.equal(first.listings[0].price,100);assert.equal(second.listings.at(-1).price,129);}finally{f.close();}});
test('非法筛选不能进入SQL或默默扩大范围',async()=>{const f=await fixture();try{for(const query of [{sort:'random'},{page:'0'},{page:'-2'},{rank:'6'},{rarity:'UR'},{role:'evil'},{minPrice:'1.5'},{maxPrice:'100001'},{minPrice:'100',maxPrice:'50'},{search:'x'.repeat(81)}])assert.throws(()=>f.game.marketSnapshot(f.users[0],query),error=>error.status===400);}finally{f.close();}});

function seedListing(f,{id=randomUUID(),status='sold',price=100,closedAt=Date.now()}={}){
 const card={uid:'c-fixture',defId:'moon-fawn',rank:1,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1};
 f.store.db.prepare('INSERT INTO listings(id,seller_id,card,price,status,created_at,buyer_id,closed_at,fee) VALUES(?,?,?,?,?,?,?,?,?)').run(id,f.users[0].id,JSON.stringify(card),price,status,Date.now(),status==='sold'?f.users[1].id:null,status==='sold'?closedAt:null,5);
 return id;
}
test('公开行情缓存跨账号/排序/页码复用；心跳等无关写入不失效；本人数据不共享',async()=>{
 const f=await fixture();try{
  seedListing(f);seedListing(f,{status:'active',price:250});const query=createMarketQuery(f.store.db);
  const prepare=f.store.db.prepare.bind(f.store.db);let scans=0,medians=0;
  f.store.db.prepare=sql=>{if(sql.includes('ROW_NUMBER()'))scans++;if(sql.includes('SELECT AVG(price) value FROM (SELECT price'))medians++;return prepare(sql);};
  const a=query(f.users[0]);
  f.store.db.prepare('UPDATE users SET last_login=last_login+1 WHERE id=?').run(f.users[1].id);
  const b=query(f.users[1],{sort:'low',page:'2',minPrice:'10'});
  assert.equal(scans,1,'历史聚合只能执行一次');assert.equal(medians,1,'同卡集合的中位价不能每次重新计算');
  assert.equal(a.mine.length,1);assert.equal(b.mine.length,0);assert.equal(a.history[0].type,'sell');assert.equal(b.history[0].type,'buy');
  assert.equal(query(f.users[2]).history.length,0);
  a.quotes.find(q=>q.defId==='moon-fawn').lastPrice=999;a.recentTrades[0].card.defId='tampered';a.stats.trades24h=999;
  const again=query(f.users[1]);assert.equal(again.quotes.find(q=>q.defId==='moon-fawn').lastPrice,100);assert.equal(again.recentTrades[0].card.defId,'moon-fawn');assert.equal(again.stats.trades24h,1);
 }finally{f.close();}
});
test('挂单新增/成交/撤单/删除立即使公开行情失效；事务回滚不能污染缓存',async()=>{
 const f=await fixture();try{
  const id=seedListing(f,{status:'active'}),query=createMarketQuery(f.store.db);
  assert.equal(query(f.users[0]).stats.trades24h,0);
  f.store.db.prepare("UPDATE listings SET status='sold',buyer_id=?,closed_at=? WHERE id=?").run(f.users[1].id,Date.now(),id);
  assert.equal(query(f.users[0]).quote.lastPrice,100);
  f.store.db.exec('BEGIN');f.store.db.prepare('UPDATE listings SET price=999 WHERE id=?').run(id);
  assert.equal(query(f.users[0]).quote.lastPrice,999,'事务内读取自己的未提交变更');f.store.db.exec('ROLLBACK');
  assert.equal(query(f.users[1]).quote.lastPrice,100,'回滚后不能复用未提交行情');
  f.store.db.prepare('UPDATE listings SET price=222 WHERE id=?').run(id);
  assert.equal(query(f.users[1]).quote.lastPrice,222,'不能命中回滚交易留下的同 revision 缓存');
  const open=seedListing(f,{status:'active',price:300});assert.equal(query(f.users[0]).stats.activeListings,1);
  f.store.db.prepare("UPDATE listings SET status='cancelled',closed_at=? WHERE id=?").run(Date.now(),open);assert.equal(query(f.users[0]).stats.activeListings,0);
  f.store.db.prepare('DELETE FROM listings WHERE id=?').run(id);assert.equal(query(f.users[0]).quote.lastPrice,null);
 }finally{f.close();}
});
test('没有写入时公开缓存仍在 5 秒到期，24h/7d 窗口按服务器时间滚动',async()=>{
 const f=await fixture();try{
  let clock=Date.now();seedListing(f,{closedAt:clock-86400000+1000});seedListing(f,{price:300,closedAt:clock-7*86400000+1000});
  const query=createMarketQuery(f.store.db,{now:()=>clock});
  const before=query(f.users[0]);assert.equal(before.stats.trades24h,1);assert.equal(before.quotes[0].sales7d,2);
  clock+=5001;const after=query(f.users[0]);assert.equal(after.stats.trades24h,0);assert.equal(after.quote.medianPrice24h,null);assert.equal(after.quotes[0].sales7d,1);assert.equal(after.quotes[0].medianPrice7d,100);
 }finally{f.close();}
});

test('筛选行情 LRU 最多保留 128 项，搜索变体与分页不产生独立行情键',async()=>{
 const f=await fixture();try{
  const query=createMarketQuery(f.store.db,{cacheTtlMs:600000}),prepare=f.store.db.prepare.bind(f.store.db);let loads=0;
  f.store.db.prepare=sql=>{if(sql.startsWith('SELECT price FROM listings l WHERE'))loads++;return prepare(sql);};
  const {CARDS}=await import('../src/data.ts'),first={search:CARDS[0].name,rank:'1'};
  query(f.users[0],first);query(f.users[1],{...first,search:' '+first.search+' ',sort:'low',page:'999'});assert.equal(loads,1);
  for(const card of CARDS)for(let rank=1;rank<=5;rank++)query(f.users[0],{search:card.name,rank:String(rank)});
  const before=loads;query(f.users[0],first);assert.equal(loads,before+1,'超过上限后最老的筛选键应被淘汰');
 }finally{f.close();}
});
test('个人历史分别按买卖索引取最近 30 条，合并顺序正确且兼容异常自成交去重',async()=>{
 const f=await fixture();try{
  const at=Date.now();for(let i=0;i<40;i++){const id=seedListing(f,{price:100+i,closedAt:at+i});if(i%2)f.store.db.prepare('UPDATE listings SET seller_id=?,buyer_id=? WHERE id=?').run(f.users[2].id,f.users[0].id,id);}
  const own=seedListing(f,{price:999,closedAt:at+100});f.store.db.prepare('UPDATE listings SET buyer_id=seller_id WHERE id=?').run(own);
  const history=f.game.marketSnapshot(f.users[0]).history;assert.equal(history.length,30);assert.equal(new Set(history.map(h=>h.id)).size,30);assert.equal(history[0].id,own);
  assert.deepEqual(history.map(h=>h.price),[999,...Array.from({length:29},(_,i)=>139-i)]);
 }finally{f.close();}
});

test('免费上架/撤单不能击穿历史聚合，且在售刷新不会延长成交窗口缓存寿命',async()=>{
 const f=await fixture();try{
  let clock=Date.now();seedListing(f,{closedAt:clock-86400000+1000});const query=createMarketQuery(f.store.db,{now:()=>clock}),prepare=f.store.db.prepare.bind(f.store.db);let scans=0;
  f.store.db.prepare=sql=>{if(sql.includes('ROW_NUMBER()'))scans++;return prepare(sql);};
  assert.equal(query(f.users[0]).stats.trades24h,1);assert.equal(scans,1);
  clock+=4000;
  for(let i=0;i<3;i++){const id=seedListing(f,{status:'active',price:200+i});const open=query(f.users[0]);assert.equal(open.stats.activeListings,1);assert.equal(open.quote.lowestPrice,200+i);f.store.db.prepare("UPDATE listings SET status='cancelled' WHERE id=?").run(id);assert.equal(query(f.users[0]).stats.activeListings,0);}
  assert.equal(scans,1,'免费挂单变动不能触发七天历史重聚合');
  clock+=1001;assert.equal(query(f.users[0]).stats.trades24h,0);assert.equal(scans,2,'成交缓存仍按原来的 5 秒窗口到期');
 }finally{f.close();}
});
