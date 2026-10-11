import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, CARD_MAP, COMBOS, TALENTS, CONDITIONS, ECONOMY } from '../src/data.ts';
import { initialState, random, owned, setLineup, strengthen, recycle, craft, summon, startRun, abandonRun, redraw, preview, chooseTalent, resolveTurn } from '../src/engine.ts';
import { DATE, fresh, funded, fixture, keys, roundTrip, bestKeys, finish } from './helpers.ts';

test('内容表的编号、成本、组合与回收价格完整',()=>{
  for(const list of [CARDS,COMBOS,TALENTS,CONDITIONS])assert.equal(new Set(list.map(c=>c.id)).size,list.length);
  for(const c of CARDS){assert.equal(CARD_MAP[c.id],c);assert.ok(c.cost>0&&c.cost<=7);assert.ok(c.base>0);assert.ok(ECONOMY.craft[c.rarity]>ECONOMY.recycle[c.rarity]);}
  assert.equal(CONDITIONS.length,6);assert.equal(COMBO_IDS().length,3);
});
function COMBO_IDS(){return COMBOS.map(c=>c.id);}
test('初始存档可往返且相同种子生成相同数据',()=>{
  const a=initialState(77),b=initialState(77);assert.deepEqual(a,b);roundTrip(a);
  assert.equal(a.lineup.length,6);assert.equal(new Set(a.cards.map(c=>c.uid)).size,a.cards.length);
  assert.equal(a.tickets,3);assert.ok(a.cards.some(c=>owned(a,c.defId).length>1));
});
test('随机数可复现、状态与取值有界',()=>{
  for(const seed of [0,1,42,1234567,0xffffffff]){assert.deepEqual(random(seed),random(seed));let s=seed;for(let i=0;i<100;i++){const [value,next]=random(s);assert.ok(value>=0&&value<1);assert.ok(Number.isInteger(next)&&next>=0&&next<=0xffffffff);s=next;}}
});
const patterns:[string[],string|null][]=[
  [['moon-fawn'],null],[['moon-fawn','star-deer'],null],
  [['moon-fawn','star-deer','mist-deer'],'mono'],
  [['moon-fawn','forest-rabbit','sun-cub'],'trio'],
  [['moon-deer','sun-cub','moon-fawn'],'mirror'],
  [['moon-fawn','moon-deer','sun-cub'],null],
  [['sun-cub','moon-fawn','moon-deer'],null],
];
for(const [defs,combo] of patterns)test('组合分类：'+defs.join(' → '),()=>{const r=fixture(defs);assert.equal(preview(r,keys(r)).combo,combo);});
test('出牌顺序改变特性得分，且即时预览不改写运行状态',()=>{
  const r=fixture(['moon-deer','sun-cub','moon-fawn']);const before=structuredClone(r);
  assert.equal(preview(r,keys(r)).score,42);assert.equal(preview(r,keys(r).reverse()).score,47);
  assert.deepEqual(r,before);
});
test('预算、空选、多选、重复投影和过期投影均无有效分数',()=>{
  const r=fixture(['moon-deer','sun-fox','forest-rabbit']);
  for(const selected of [[],keys(r),['p0','p0'],['missing'],['p0','p1','p2','missing']]){const p=preview(r,selected);assert.equal(p.valid,false);assert.equal(p.score,0);assert.ok(p.reason);}
  const boosted={...r,talents:['energy']};assert.equal(preview(boosted,keys(r)).cost,8);assert.equal(preview(boosted,keys(r)).budget,8);assert.equal(preview(boosted,keys(r)).valid,true);
});
test('同相、三相与成长点的计分可独立复核',()=>{
  const mono=fixture(['moon-fawn','star-deer','mist-deer']);const p=preview(mono,keys(mono));assert.equal(p.score,49);assert.deepEqual(p.growth,{insight:2,bond:12,focus:6});
  const trio=fixture(['moon-fawn','forest-rabbit','sun-cub']);const q=preview(trio,keys(trio));assert.equal(q.score,53);assert.deepEqual(q.growth,{insight:12,bond:2,focus:6});
});
const traits:[string,string[],number][]=[
 ['echo',['moon-deer','sun-cub','moon-fawn'],12],['flare',['moon-fawn','sun-cub','sun-fox'],10],
 ['bloom',['moon-fawn','forest-rabbit','sun-cub'],10],['quiet',['moon-fawn'],5],
 ['lead',['sun-cub','sun-fox'],8],['root',['forest-sprout'],12],
 ['tidal',['moon-fawn','star-deer'],9],['duet',['forest-sprout','golden-fox'],10],
 ['weave',['moon-fawn','sun-cub','verdant-rabbit'],12],['rush',['moon-deer','dawn-fox','golden-fox'],12],
 ['wander',['moon-fawn','breeze-sprout','sun-cub'],14],
];
for(const [trait,defs,value] of traits)test('星灵特性：'+trait,()=>{const r=fixture(defs);const d=CARDS.find(c=>c.trait===trait)!;assert.equal(preview(r,keys(r)).lines.find(l=>l.label===d.traitName)?.value,value);});
test('记忆特性仅在连续组合相同时触发',()=>{
 const r=fixture(['mist-deer','sun-cub','moon-fawn']);const log={turn:1,cards:['moon-fawn'],score:0,combo:'mirror',condition:'forest'};
 const p=preview({...r,logs:[log]},keys(r));assert.equal(p.lines.find(l=>l.label==='昨日回声')?.value,9);
 assert.ok(!preview({...r,logs:[{...log,combo:'mono'}]},keys(r)).lines.some(l=>l.label==='昨日回声'));
});
test('天赋按规则叠加，三色倍率在所有固定加分之后取整',()=>{
  const r=fixture(['moon-fawn','forest-rabbit','sun-cub']);const plain=preview(r,keys(r));
  const p=preview({...r,talents:['growth','prism']},keys(r));assert.equal(p.score,Math.round((plain.score+9)*1.3));
  const mono=fixture(['moon-fawn','star-deer','mist-deer']);assert.equal(preview({...mono,talents:['harmony']},keys(mono)).score-preview(mono,keys(mono)).score,18);
  const mirror=fixture(['moon-deer','sun-cub','moon-fawn']);assert.equal(preview({...mirror,talents:['echo']},keys(mirror)).score-preview(mirror,keys(mirror)).score,16);
  assert.equal(preview({...r,talents:['focus']},keys(r)).score-plain.score,(7-plain.cost)*4);
});
test('永久强化只按主实例阶位增加基础分',()=>{
  const r=fixture(['moon-fawn']);const p=preview(r,keys(r));r.hand[0].rank=3;assert.equal(preview(r,keys(r)).score-p.score,4);
});
test('特定环境只为匹配星相或组合加分',()=>{
  const r=fixture(['moon-deer','sun-cub','moon-fawn']);const base=preview(r,keys(r)).score;
  assert.equal(preview({...r,conditions:Array(6).fill('moon')},keys(r)).score-base,8);
  assert.equal(preview({...r,conditions:Array(6).fill('mirror')},keys(r)).score-base,12);
  assert.equal(preview({...r,conditions:Array(6).fill('quiet')},keys(r)).score-base,6);
  assert.equal(preview({...r,conditions:Array(6).fill('trio')},keys(r)).score-base,0);
});

test('编队只能包含六种以内已拥有星灵，活跃培育锁定编队',()=>{
  const s=fresh(),before=structuredClone(s);
  assert.throws(()=>setLineup(s,[s.lineup[0],s.lineup[0]]));assert.throws(()=>setLineup(s,['breeze-sprout']));assert.throws(()=>setLineup(s,CARDS.slice(0,7).map(c=>c.id)));
  const empty=setLineup(s,[]);assert.deepEqual(empty.lineup,[]);assert.throws(()=>startRun(empty));
  const active=startRun(s);assert.throws(()=>setLineup(active,[]),/锁定/);assert.throws(()=>startRun(active));
  assert.deepEqual(setLineup(abandonRun(active),[]).lineup,[]);assert.deepEqual(s,before);
});
test('拥有实例以阶位和最佳纪录选择主卡，排序不改变原数组',()=>{
  const s=fresh();const cards=s.cards.filter(c=>c.defId==='forest-sprout');cards[1].best=77;cards[2].rank=2;
  const before=structuredClone(s);assert.equal(owned(s,'forest-sprout')[0].uid,cards[2].uid);assert.equal(owned(s,'forest-sprout')[1].uid,cards[1].uid);assert.deepEqual(s,before);
});
test('同卡强化保留主实例及纪录，精确消耗材料和星币，最高三阶',()=>{
  let s=funded();const main=owned(s,'forest-sprout')[0];main.best=91;const uid=main.uid;
  const before=structuredClone(s);s=strengthen(s,'forest-sprout');assert.equal(s.coins,before.coins-90);assert.equal(s.cards.length,before.cards.length-2);assert.equal(owned(s,'forest-sprout')[0].uid,uid);assert.equal(owned(s,'forest-sprout')[0].best,91);assert.equal(owned(s,'forest-sprout')[0].rank,2);assert.equal(before.cards.find(c=>c.uid===uid)!.rank,1);
  s=craft(craft(s,'forest-sprout'),'forest-sprout');const coins=s.coins;s=strengthen(s,'forest-sprout');assert.equal(s.coins,coins-180);assert.equal(owned(s,'forest-sprout').length,1);assert.deepEqual(owned(s,'forest-sprout')[0],{uid,defId:'forest-sprout',rank:3,best:91});assert.throws(()=>strengthen(s,'forest-sprout'),/最高/);roundTrip(s);
});
test('材料、星币不足与活跃主卡均不能强化且不改写输入',()=>{
  for(const state of [fresh(),{...funded(),coins:0},startRun(funded())]){const id=state.coins===0?'forest-rabbit':'moon-deer';const before=structuredClone(state);assert.throws(()=>strengthen(state,id));assert.deepEqual(state,before);}
  assert.throws(()=>strengthen(fresh(),'breeze-sprout'),/尚未拥有/);
});
test('新的同名主实例出现后，旧的培育实例仍不能成为强化材料',()=>{
  let s=startRun(funded());const locked=s.run!.deck.find(c=>c.defId==='forest-rabbit')!.uid;
  while(s.nextId<100)s=craft(s,'moon-fawn');s=craft(s,'forest-rabbit');assert.equal(owned(s,'forest-rabbit')[0].uid,'c100');
  s=strengthen(s,'forest-rabbit');assert.ok(s.cards.some(c=>c.uid===locked&&c.rank===1));assert.equal(owned(s,'forest-rabbit')[0].rank,2);roundTrip(s);
});
test('分解只消耗未强化重复卡，保留最后一张和最高纪录',()=>{
  const s=fresh();const main=owned(s,'forest-sprout')[0];main.best=99;const after=recycle(s,'forest-sprout',3);
  assert.equal(after.cards.length,s.cards.length-3);assert.equal(after.dust,s.dust+30);assert.equal(after.coins,s.coins);assert.deepEqual(owned(after,'forest-sprout'),[main]);assert.throws(()=>recycle(after,'forest-sprout'),/最后一张/);roundTrip(after);
  const strengthened=strengthen(funded(),'forest-sprout');const last=recycle(strengthened,'forest-sprout');assert.equal(owned(last,'forest-sprout')[0].rank,2);assert.throws(()=>recycle(last,'forest-sprout'));
});
test('分解保护活跃实例，并拒绝非正整数数量',()=>{
  let s=startRun(funded());const locked=s.run!.deck.find(c=>c.defId==='forest-rabbit')!.uid;
  while(s.nextId<100)s=craft(s,'moon-fawn');s=craft(s,'forest-rabbit');s=recycle(s,'forest-rabbit',2);assert.ok(s.cards.some(c=>c.uid===locked));assert.throws(()=>recycle(s,'forest-rabbit'));roundTrip(s);
  for(const amount of [0,-1,1.5,NaN,Infinity])assert.throws(()=>recycle(fresh(),'moon-fawn',amount));
});
test('所有稀有度的定向制作再分解都有净损耗',()=>{
  for(const rarity of ['R','SR','SSR'] as const){const id=CARDS.find(c=>c.rarity===rarity)!.id;const s=funded();const made=craft(s,id);assert.equal(made.cards.length,s.cards.length+1);assert.equal(made.cards.at(-1)!.defId,id);assert.equal(made.dust,s.dust-ECONOMY.craft[rarity]);assert.equal(made.cards.at(-1)!.rank,1);const recovered=recycle(made,id);assert.equal(recovered.cards.length,s.cards.length);assert.equal(recovered.dust,s.dust-ECONOMY.craft[rarity]+ECONOMY.recycle[rarity]);assert.ok(recovered.dust<s.dust);roundTrip(recovered);}
  assert.throws(()=>craft({...fresh(),dust:0},'sun-fox'),/星尘不足/);
});
test('未知与原型属性名不可以作为卡牌编号',()=>{
  for(const id of ['missing','toString','constructor','__proto__'])for(const action of [craft,recycle,strengthen])assert.throws(()=>action(funded(),id),/未知星灵/);
});
test('召唤优先使用券，随后精确扣币且保留三张结果',()=>{
  const s=fresh();const a=summon(s);assert.equal(a.tickets,s.tickets-1);assert.equal(a.coins,s.coins);assert.equal(a.cards.length,s.cards.length+3);assert.equal(a.lastSummon.length,3);assert.deepEqual(a.cards.slice(-3).map(c=>c.defId),a.lastSummon);roundTrip(a);
  const b=summon({...s,tickets:0});assert.equal(b.coins,s.coins-ECONOMY.packCost);assert.equal(b.tickets,0);assert.throws(()=>summon({...s,tickets:0,coins:ECONOMY.packCost-1}));assert.deepEqual(summon(fresh(52)),summon(fresh(52)));
});
test('跨 500 个 seed 的三连均至少包含 SR，实例编号不重复',()=>{
  for(let index=1;index<=500;index++){const seed=Math.imul(index,0x9e3779b9)>>>0;const s=summon(fresh(seed));assert.ok(s.lastSummon.some(id=>CARD_MAP[id].rarity!=='R'),'seed '+seed);assert.equal(new Set(s.cards.map(c=>c.uid)).size,s.cards.length);}
});
test('库存和安全整数边界不会生成无法导出的存档',()=>{
  const s=funded();s.cards=Array.from({length:10000},(_,i)=>({uid:'c'+(i+1),defId:'moon-fawn',rank:1,best:0}));s.nextId=10001;
  assert.throws(()=>craft(s,'moon-fawn'),/上限/);assert.throws(()=>summon(s),/空间不足/);
  assert.throws(()=>craft({...funded(),nextId:Number.MAX_SAFE_INTEGER},'moon-fawn'),/上限/);
  const rich={...fresh(),dust:Number.MAX_SAFE_INTEGER};const before=structuredClone(rich);assert.throws(()=>recycle(rich,'moon-fawn'),/安全范围/);assert.deepEqual(rich,before);
});
test('开局创建固定六种环境和五张唯一投影，收藏卡不被消耗',()=>{
  const s=fresh();const started=startRun(s);assert.deepEqual(started,startRun(s));assert.deepEqual(started.cards,s.cards);assert.equal(started.run!.turn,1);assert.equal(started.run!.phase,'playing');assert.equal(started.run!.deck.length,6);assert.equal(started.run!.hand.length,5);assert.equal(new Set(keys(started.run!)).size,5);assert.equal(new Set(started.run!.conditions).size,6);
  for(const p of started.run!.hand)assert.ok(started.run!.hand.filter(other=>other.defId===p.defId).length<=2);roundTrip(started);
});
test('每回合只能重新感应一次，旧投影不能用于新手牌',()=>{
  const s=startRun(fresh());const old=keys(s.run!);const changed=redraw(s);assert.equal(changed.run!.redraws,0);assert.equal(changed.run!.score,0);assert.ok(keys(changed.run!).every(k=>!old.includes(k)));assert.throws(()=>redraw(changed));assert.throws(()=>resolveTurn(changed,[old[0]],DATE));roundTrip(changed);assert.equal(s.run!.redraws,1);
});

test('六回合必须经过两次天赋选择，结算只发放一次奖励',()=>{
  let s=startRun(fresh());const coins=s.coins,dust=s.dust;let talentChoices=0;const scores:number[]=[];
  while(s.run!.phase!=='complete'){
    const before=structuredClone(s);
    if(s.run!.phase==='talent'){
      assert.ok([3,5].includes(s.run!.turn));assert.equal(s.run!.offers.length,3);assert.equal(new Set(s.run!.offers).size,3);assert.ok(s.run!.offers.every(id=>!s.run!.talents.includes(id)));
      assert.throws(()=>resolveTurn(s,bestKeys(s.run!),DATE));assert.throws(()=>redraw(s));assert.throws(()=>chooseTalent(s,'missing'));
      const chosen=s.run!.offers[0];s=chooseTalent(s,chosen);talentChoices++;assert.ok(s.run!.talents.includes(chosen));assert.equal(s.run!.offers.length,0);assert.throws(()=>chooseTalent(s,chosen));
    }else{
      const picked=bestKeys(s.run!);scores.push(preview(s.run!,picked).score);s=resolveTurn(s,picked,DATE);assert.throws(()=>resolveTurn(s,picked,DATE));
    }
    assert.notEqual(s,before);s=roundTrip(s);
  }
  assert.equal(talentChoices,2);assert.equal(s.run!.turn,6);assert.equal(s.run!.logs.length,6);assert.equal(s.results.length,1);assert.equal(s.results[0].score,scores.reduce((a,b)=>a+b,0));assert.equal(s.results[0].id,s.run!.id);assert.equal(s.results[0].date,DATE);assert.equal(s.coins,coins+s.results[0].coins);assert.equal(s.dust,dust+s.results[0].dust);assert.equal(s.cards.find(c=>c.uid===s.run!.deck[0].uid)!.best,s.run!.score);
  const paid=structuredClone(s);assert.throws(()=>resolveTurn(s,keys(s.run!).slice(0,1),DATE));assert.throws(()=>redraw(s));assert.deepEqual(s,paid);
  const reverted=structuredClone(s);reverted.run!.phase='playing';assert.throws(()=>resolveTurn(reverted,keys(reverted.run!).slice(0,1),DATE),/已领取/);
  roundTrip(s);
});
test('无效出牌及非法日期不改变资源、回合或发现',()=>{
  const s=startRun(fresh()),before=structuredClone(s);assert.throws(()=>resolveTurn(s,[],DATE));assert.throws(()=>resolveTurn(s,[s.run!.hand[0].key,s.run!.hand[0].key],DATE));assert.throws(()=>resolveTurn(s,bestKeys(s.run!),'not-a-date'));assert.deepEqual(s,before);
});
test('结束未完成培育不授奖，并可开始新实例',()=>{
  let s=startRun(fresh());s=resolveTurn(s,bestKeys(s.run!),DATE);const abandoned=abandonRun(s);assert.equal(abandoned.run,null);assert.equal(abandoned.results.length,0);assert.equal(abandoned.coins,s.coins);assert.equal(abandoned.dust,s.dust);assert.deepEqual(abandoned.cards,s.cards);assert.notEqual(startRun(abandoned).run!.id,s.run!.id);roundTrip(abandoned);
});
test('完成后解锁编队与强化，旧成果保持原始快照',()=>{
  const s=finish(funded(),true);const result=structuredClone(s.results[0]);let next=setLineup(s,[...s.lineup].reverse());next=strengthen(next,'forest-rabbit');assert.deepEqual(next.results[0],result);roundTrip(next);const again=startRun(next);assert.notEqual(again.run!.id,s.run!.id);assert.equal(again.results.length,1);roundTrip(again);
});
test('完成后的最高纪录只提高不下降，手记最多保留五十次',()=>{
  let s=fresh(512);let best=0;
  for(let i=0;i<52;i++){s=finish(s);best=Math.max(best,s.run!.score);assert.equal(s.cards.find(c=>c.uid===s.run!.deck[0].uid)!.best,best);s=roundTrip(s);}
  assert.equal(s.results.length,50);assert.equal(new Set(s.results.map(r=>r.id)).size,50);assert.equal(s.results[0].id,s.run!.id);
});

test('三张基础结果都是 R 时，第三张保底替换为 SR',()=>{
  const seed=1013904242;let rng=seed;
  for(let i=0;i<3;i++){let roll:number;[roll,rng]=random(rng);assert.ok(roll>=.4);[,rng]=random(rng);}
  const s=summon(fresh(seed));assert.deepEqual(s.lastSummon.map(id=>CARD_MAP[id].rarity),['R','R','SR']);assert.equal(s.rng,rng);
});
test('初始化 seed 统一转换为有效的非零 32 位随机状态',()=>{
  assert.equal(initialState(-1).rng,0xffffffff);for(const seed of [NaN,Infinity,0,0x100000000]){const s=initialState(seed);assert.equal(s.rng,42);roundTrip(s);}
});
