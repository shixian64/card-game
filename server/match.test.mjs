import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initialState} from '../src/engine.ts';
import {getCombatStats} from '../src/battle.ts';
import {createMatch,actMatch,advanceMatch,publicMatch,MATCH_RULES,migrateMatch} from './match.mjs';
import {unitShopPrice} from '../src/data.ts';
import {openStore} from './store.mjs';
import {createGameService} from './game.mjs';
const start=()=>createMatch(initialState(42).cards,1234,100000);
const req=x=>({requestId:randomUUID(),...x});
function fixture(){let clock=100000;const store=openStore(':memory:'),game=createGameService(store.db,{now:()=>clock});const user=store.login({issuer:'test',clientId:'test',subject:'match',name:'Match Tester'}).user;game.ensureProfile(user);game.game(user,'starter.claim',{requestId:'fixture-starter-claim',favoriteDefId:'moon-deer'});return {store,game,user,time(value){clock=value;},close:()=>store.db.close()};}
test('10分钟固定8回合，初始金币/人口/投影/商店与永久资产分离',()=>{const cards=initialState(42).cards,copy=structuredClone(cards),s=createMatch(cards,1,100000);assert.equal(s.endsAt-s.startedAt,600000);assert.equal(s.phaseEndsAt-s.startedAt,40000);assert.equal(s.level,3);assert.equal(s.gold,120);assert.equal(s.shop.length,5);assert.equal(s.roster.length,2);assert.ok(s.roster.every(c=>c.uid.startsWith('m')&&c.stars===1));assert.deepEqual(cards,copy);assert.equal(MATCH_RULES.rounds,8);assert.equal(publicMatch(s).pool,undefined);assert.equal(publicMatch(s).rng,undefined);});
test('商店仅来自已有收藏，重复买入请求不会重复扣款',()=>{const f=fixture();try{let s=f.game.game(f.user,'match.start',req()).match;const owned=new Set(f.game.snapshot(f.user).state.cards.map(c=>c.defId));assert.ok(s.shop.every(o=>owned.has(o.defId)));const offer=s.shop[0],args=req({offerId:offer.id});const after=f.game.game(f.user,'match.buy',args);assert.equal(after.match.gold,120-offer.cost);const repeat=f.game.game(f.user,'match.buy',args);assert.equal(repeat.match.gold,after.match.gold);assert.equal(repeat.match.roster.length,after.match.roster.length);assert.throws(()=>f.game.game(f.user,'match.buy',req({offerId:offer.id})),/购买或刷新/);assert.equal(repeat.state.coins,600);assert.equal(repeat.state.cards.length,23);}finally{f.close();}});
test('刷新2金币、买经验4金币4XP、锁店不收费，输入不能伪造金币',()=>{let s=start();const before=structuredClone(s);s=actMatch(s,'reroll',{gold:9999},100000);assert.equal(s.gold,100);assert.notDeepEqual(s.shop,before.shop);s=actMatch(s,'xp',{},100000);assert.equal(s.gold,60);assert.equal(s.xp,4);s=actMatch(s,'xp',{},100000);assert.equal(s.gold,20);assert.equal(s.level,4);assert.equal(s.xp,2);assert.equal(s.xpToNext,10);const copy=structuredClone(s);assert.throws(()=>actMatch(s,'xp',{},100000),/不足/);assert.deepEqual(s,copy);s=actMatch(s,'lock',{locked:true},100000);assert.equal(s.locked,true);assert.equal(s.gold,20);});
test('三同名同星自动合星且保留已上阵实例，不改变永久等级',()=>{let s=start();s.roster=[];s.formation=[];s.shop=[0,1,2].map(i=>({id:'offer-'+i,defId:'sun-cub',rank:2,cost:unitShopPrice(2)}));s=actMatch(s,'buy',{offerId:'offer-0'},100000);const uid=s.roster[0].uid;s=actMatch(s,'deploy',{formation:[{uid,slot:25}]},100000);s=actMatch(s,'buy',{offerId:'offer-1'},100000);s=actMatch(s,'buy',{offerId:'offer-2'},100000);assert.equal(s.roster.length,1);assert.equal(s.roster[0].stars,2);assert.equal(s.roster[0].rank,2);assert.equal(s.roster[0].uid,uid);assert.equal(s.formation[0].uid,uid);const base=getCombatStats({...s.roster[0],stars:1}),up=getCombatStats(s.roster[0]);assert.ok(up.hp>base.hp&&up.attack>base.attack);assert.equal(s.gold,120-unitShopPrice(2)*3);});
test('满15格可通过购买三合腾位置，无法合并的购买原子拒绝',()=>{let s=start();s.roster=Array.from({length:13},(_,i)=>({uid:'max-'+i,defId:'sun-fox',rank:1,best:0,stars:3}));s.roster.push(...[0,1].map(i=>({uid:'pair-'+i,defId:'sun-cub',rank:1,best:0,stars:1})));s.formation=[];s.shop=[{id:'merge',defId:'sun-cub',rank:1,cost:10}];s=actMatch(s,'buy',{offerId:'merge'},100000);assert.equal(s.roster.length,14);s.roster.push({uid:'filler',defId:'moon-deer',rank:1,best:0,stars:3});s.shop=[{id:'overflow',defId:'moon-fawn',rank:1,cost:10}];const before=structuredClone(s);assert.throws(()=>actMatch(s,'buy',{offerId:'overflow'},100000),/已满/);assert.deepEqual(s,before);});
test('卖出投影按合成成本返还，出售同时离开棋盘',()=>{let s=start();s.roster=[{uid:'two-star',defId:'sun-cub',rank:1,best:0,stars:2}];s.formation=[{uid:'two-star',slot:1}];s=actMatch(s,'sell',{uid:'two-star'},100000);assert.equal(s.gold,120+unitShopPrice(1)*3);assert.equal(s.roster.length,0);assert.equal(s.formation.length,0);assert.throws(()=>actMatch(s,'sell',{uid:'two-star'},100000));});
test('部署按人口及实例校验，站位不能越界/重叠，允许不同实例同名',()=>{let s=start();s.roster=[0,1,2,3].map(i=>({uid:'same-'+i,defId:'sun-cub',rank:1,best:0,stars:1}));for(const formation of [[{uid:'unknown',slot:1}],[{uid:'same-0',slot:28}],[{uid:'same-0',slot:1},{uid:'same-1',slot:1}],[{uid:'same-0',slot:1},{uid:'same-0',slot:2}],s.roster.map((c,i)=>({uid:c.uid,slot:i}))])assert.throws(()=>actMatch(s,'deploy',{formation},100000));s=actMatch(s,'deploy',{formation:[{uid:'same-0',slot:1},{uid:'same-1',slot:2}]},100000);assert.equal(s.formation.length,2);});
test('服务器40秒自动进入战斗、75秒下一回合，战斗期间不可改经济',()=>{const f=fixture();try{f.game.game(f.user,'match.start',req());f.time(139999);assert.equal(f.game.snapshot(f.user).match.phase,'planning');f.time(140000);const combat=f.game.snapshot(f.user).match;assert.equal(combat.phase,'combat');assert.ok(combat.battle.frames.length);assert.equal(combat.battle.enemy.length,3);assert.equal(combat.phaseEndsAt,175000);assert.throws(()=>f.game.game(f.user,'match.reroll',req()),/不是经营/);f.time(175000);const next=f.game.snapshot(f.user).match;assert.equal(next.round,2);assert.equal(next.phase,'planning');assert.equal(next.xp,2);assert.equal(next.history.length,1);assert.ok(next.lastIncome.total>=60);assert.equal(f.game.snapshot(f.user).state.coins,600);}finally{f.close();}});
test('利息按结算前持币每10给1上限5，锁店跨回合保留',()=>{let s=start();s.gold=500;s.locked=true;const shop=structuredClone(s.shop);s=advanceMatch(s,175000).match;assert.equal(s.lastIncome.interest,50);assert.equal(s.lastIncome.base,50);assert.deepEqual(s.shop,shop);assert.equal(s.locked,true);assert.ok(s.gold>=600);});
test('连续空阵容败局给连败奖励，无法伪造终局胜利',()=>{let s=start();s.roster=[];s.formation=[];s=advanceMatch(s,250000).match;assert.equal(s.losses,2);assert.equal(s.streak,-2);assert.equal(s.lastIncome.streak,10);assert.throws(()=>actMatch(s,'finish',{wins:8},250000),/不支持/);});
test('离线后按服务器时间补完8回合，终局奖励在事务中只结算一次',()=>{const f=fixture();try{f.game.game(f.user,'match.start',req());for(let round=1;round<=4;round++){f.time(100000+(round-1)*75000+1000);const snap=f.game.snapshot(f.user);for(const offer of snap.match.shop.slice(0,3))f.game.game(f.user,'match.buy',req({offerId:offer.id}));}f.time(700000);const done=f.game.snapshot(f.user);assert.equal(done.match.status,'finished');assert.equal(done.match.history.length,8);assert.equal(done.match.wins+done.match.losses,8);assert.equal(done.match.endsAt,700000);assert.equal(done.state.coins,600+80+20*done.match.wins);assert.equal(done.state.frozen,undefined,'新对局不再产生星尘');assert.equal(f.game.snapshot(f.user).state.coins,done.state.coins);const reloaded=createGameService(f.store.db,{now:()=>800000});assert.equal(reloaded.snapshot(f.user).state.coins,done.state.coins);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='match.finish'").get().n,1);}finally{f.close();}});
test('退出无终局奖励且之后可开新局',()=>{const f=fixture();try{f.game.game(f.user,'match.start',req());const ended=f.game.game(f.user,'match.abandon',req());assert.equal(ended.match.status,'finished');assert.deepEqual(ended.match.reward,{coins:0,factor:0,reason:'abandoned'});f.time(800000);assert.equal(f.game.snapshot(f.user).state.coins,600);assert.equal(f.game.game(f.user,'match.start',req()).match.status,'playing');}finally{f.close();}});
test('局内卡牌是投影，永久卡能交易且不会带走本局单位',()=>{const f=fixture();try{const before=f.game.snapshot(f.user).state;const started=f.game.game(f.user,'match.start',req());const unit=started.match.roster[0];assert.throws(()=>f.game.market(f.user,'list',req({uid:before.cards[0].uid,price:200})),/仅可自用/,'礼包卡受限不能上架，但不影响本局副本');const row=f.store.db.prepare('SELECT state FROM profiles WHERE user_id=?').get(f.user.id);const seeded=JSON.parse(row.state);seeded.cards.push({uid:'c9001',defId:'silver-gap',rank:1,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1});f.store.db.prepare('UPDATE profiles SET state=? WHERE user_id=?').run(JSON.stringify(seeded),f.user.id);f.game.market(f.user,'list',req({uid:'c9001',price:200}));const after=f.game.snapshot(f.user);assert.ok(after.match.roster.some(c=>c.uid===unit.uid));assert.equal(after.state.cards.length,23);assert.equal(after.match.gold,120);}finally{f.close();}});

test('旧 v1 对局按 10 倍刻度迁移到 v2，数值完整且可继续经营',()=>{
  const legacy={version:1,id:'legacy',status:'playing',startedAt:100000,endsAt:700000,serverNow:100000,round:2,phase:'planning',phaseEndsAt:180000,gold:9,level:3,xp:2,xpToNext:6,shop:[{id:'o1',defId:'sun-cub',rank:1,cost:1}],locked:false,roster:[],formation:[],battle:null,wins:1,losses:0,streak:1,history:[{round:1,status:'won',gold:7}],lastIncome:{base:5,interest:0,streak:1,win:1,total:7},pool:[{defId:'sun-cub',rank:1},{defId:'moon-deer',rank:1}],rng:1,nextId:1,revision:3};
  const migrated=migrateMatch(legacy);
  assert.equal(migrated.version,2);assert.equal(migrated.gold,90);assert.equal(migrated.shop[0].cost,10);
  assert.equal(migrated.history[0].gold,70);assert.deepEqual(migrated.lastIncome,{base:50,interest:0,streak:10,win:10,total:70});
  assert.equal(legacy.version,1,'迁移不得改写原对象');
  assert.equal(migrateMatch(migrated),migrated,'v2 不重复迁移');
  const acted=actMatch(migrated,'reroll',{},110000);assert.equal(acted.gold,70);assert.equal(acted.version,2);
});
test('开局池包含同卡多品质组合，同品质才合星，购买价与品质联动',()=>{
  const cards=[{uid:'a1',defId:'sun-cub',rank:1,best:0},{uid:'a2',defId:'sun-cub',rank:3,best:0},{uid:'a3',defId:'sun-cub',rank:3,best:0},{uid:'a4',defId:'sun-cub',rank:3,best:0},{uid:'b1',defId:'moon-deer',rank:1,best:0}];
  const s=createMatch(cards,7,100000);
  // v3 池按“每个 defId 的最高品质”投影 Q1..maxQ，不保留低品质组合。
  const poolMap=new Map(s.pool.map(entry=>[entry.defId,entry.maxRank]));
  assert.deepEqual([...poolMap.entries()].sort(),[['moon-deer',1],['sun-cub',3]]);
  assert.ok(s.gold>=120-unitShopPrice(3),'初始金币足够买一张本池最高品质卡');
  const staged=structuredClone(s);staged.roster=[];staged.formation=[];
  staged.shop=[1,2,3].map(i=>({id:'m'+i,defId:'sun-cub',rank:3,cost:unitShopPrice(3)}));
  let merged=staged;
  for(const offer of [...staged.shop])merged=actMatch(merged,'buy',{offerId:offer.id},100000);
  assert.equal(merged.roster.length,1);assert.equal(merged.roster[0].stars,2);assert.equal(merged.roster[0].rank,3);
  const mixed=createMatch(cards,9,100000);mixed.roster=[{uid:'q1a',defId:'sun-cub',rank:1,best:0,stars:1},{uid:'q1b',defId:'sun-cub',rank:1,best:0,stars:1},{uid:'q3a',defId:'sun-cub',rank:3,best:0,stars:1}];
  const noMerge=actMatch(mixed,'lock',{locked:true},100000);
  assert.equal(noMerge.roster.length,3,'不同品质不得合星');
});

test('迁移对局买卖不凭空增金：商店报价换算为品质价，旧 roster 按旧价出售',()=>{
  // 旧 v1 对局：Q3 的 R 卡报价 1 金；roster 里有一张迁移前买入的 Q3 SSR 单位。
  const legacy={version:1,id:'arb',status:'playing',startedAt:100000,endsAt:700000,serverNow:100000,round:1,phase:'planning',phaseEndsAt:140000,gold:120,level:3,xp:0,xpToNext:6,shop:[{id:'offer-q3',defId:'sun-cub',rank:3,cost:1}],locked:false,roster:[{uid:'old-ssr-q3',defId:'sun-fox',rank:3,best:0,stars:1}],formation:[],battle:null,wins:0,losses:0,streak:0,history:[],pool:[{defId:'sun-cub',rank:3},{defId:'sun-fox',rank:3}],rng:1,nextId:1,revision:1};
  const migrated=migrateMatch(legacy);
  assert.equal(migrated.legacyPricing,true);
  const offerCost=migrated.shop[0].cost;
  assert.equal(offerCost,13,'迁移报价等于旧品质价（R 基 10 × 1.25 = 13，= 出售价）');
  // 买入再卖出：净变化不得为正（legacy 出售价 ≤ 新品质价；此处为 -3 损耗）。
  const preBuy=migrated.gold;
  let s2=actMatch(migrated,'buy',{offerId:'offer-q3'},100000);
  assert.equal(s2.gold,preBuy-offerCost,'按新品质价扣费');
  s2=actMatch(s2,'sell',{uid:s2.roster.find(c=>c.uid!=='old-ssr-q3'&&c.defId==='sun-cub').uid},100000);
  assert.ok(s2.gold<=preBuy,'买→卖往返不得增金');
  assert.equal(s2.gold,preBuy,'迁移后买入的单位按 basis（=成交价 13）出售，往返净变化 0');
  // 迁移前入队的 Q3 SSR：旧价 30（非品质价 38），避免迁移窗口套利。
  const goldBefore=s2.gold;
  s2=actMatch(s2,'sell',{uid:'old-ssr-q3'},100000);
  assert.equal(s2.gold,goldBefore+30,'旧 roster 单位按旧稀有度价 ×10 出售');
  // 新开对局无 legacyPricing，正常品质价出售。
  const fresh=createMatch([{uid:'a',defId:'sun-cub',rank:3,best:0},{uid:'b',defId:'moon-deer',rank:1,best:0}],5,100000);
  assert.equal(fresh.legacyPricing,undefined);
  const sold=actMatch({...fresh,roster:[{uid:'x',defId:'sun-cub',rank:3,best:0,stars:1}],formation:[]},'sell',{uid:'x'},100000);
  assert.equal(sold.gold,fresh.gold+unitShopPrice(3),'新局无 basis 单位回退品质价');
});
