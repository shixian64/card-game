import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, CARD_MAP, COMBOS, TALENTS, CONDITIONS, LEGACY_ECONOMY, LEGACY_RARITY, ECONOMY, QUALITY, QUALITY_MAX, qualityName } from '../src/data.ts';
import { initialState, random, owned, setLineup, forge, forgeOdds, recycle, craft, summon, startRun, abandonRun, redraw, preview, chooseTalent, resolveTurn } from '../src/engine.ts';
import type { GameState } from '../src/engine.ts';
import { DATE, fresh, funded, fixture, keys, roundTrip, bestKeys, finish } from './helpers.ts';

test('内容表的编号、成本、组合与回收价格完整',()=>{
  for(const list of [CARDS,COMBOS,TALENTS,CONDITIONS])assert.equal(new Set(list.map(c=>c.id)).size,list.length);
  for(const c of CARDS){assert.equal(CARD_MAP[c.id],c);assert.ok(c.cost>0&&c.cost<=7);assert.ok(c.base>0);assert.ok(LEGACY_ECONOMY.craft[LEGACY_RARITY[c.id]]>LEGACY_ECONOMY.recycle[LEGACY_RARITY[c.id]]);assert.ok(ECONOMY.craftCost>ECONOMY.recycleReturn,'新经济：制作 180 > 回收 10');}
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
 const p=preview({...r,logs:[log]},keys(r));assert.equal(p.lines.find(l=>l.label===CARD_MAP['mist-deer'].traitName)?.value,9);
 assert.ok(!preview({...r,logs:[{...log,combo:'mono'}]},keys(r)).lines.some(l=>l.label===CARD_MAP['mist-deer'].traitName));
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
function copiesState(defId:string,...qualities:number[]):GameState {
  const s=funded();const keep=s.cards.filter(c=>c.defId!==defId);
  const made=qualities.map((rank,index)=>({uid:'c'+(900+index),defId,rank,best:0}));
  s.cards=[...keep,...made];s.nextId=Math.max(s.nextId,910);return s;
}
const queued=(values:number[])=>{let index=0;return ()=>values[Math.min(index++,values.length-1)];};
test('同卡合成普通成功：保留主实例与纪录，精确消耗同品质材料和星币',()=>{
  let s=copiesState('forest-sprout',1,1,1,1);const main=owned(s,'forest-sprout')[0];main.best=91;const uid=main.uid;
  const before=structuredClone(s);const {state:next,result}=forge(s,'forest-sprout',{random:queued([0.99])});
  assert.equal(result.branch,'upgrade_one');assert.equal(result.from,1);assert.equal(result.to,2);
  assert.equal(next.coins,before.coins-QUALITY.forge.coins[0]);assert.equal(next.cards.length,before.cards.length-2);
  assert.equal(owned(next,'forest-sprout')[0].uid,uid);assert.equal(owned(next,'forest-sprout')[0].rank,2);
  assert.equal(owned(next,'forest-sprout')[0].best,91);assert.deepEqual(next.lastForge,result);roundTrip(next);
});
test('极低概率连升恰好跨两级，近顶级连升并入普通成功',()=>{
  const early=forge(copiesState('forest-sprout',1,1,1,1),'forest-sprout',{random:queued([0.101])});
  assert.equal(early.result.branch,'upgrade_two');assert.equal(early.result.to,3);
  assert.equal(owned(early.state,'forest-sprout')[0].rank,3);
  const top=forge(copiesState('forest-sprout',3,3,3),'forest-sprout',{random:queued([0.352])});
  assert.equal(top.result.branch,'upgrade_two');assert.equal(top.result.to,5);assert.equal(top.result.from,3);
  const mergedFail=forge(copiesState('forest-sprout',4,4,4),'forest-sprout',{random:queued([0.497])});
  assert.equal(mergedFail.result.branch,'fail');
  const mergedSuccess=forge(copiesState('forest-sprout',4,4,4),'forest-sprout',{random:queued([0.5])});
  assert.equal(mergedSuccess.result.branch,'upgrade_one');assert.equal(mergedSuccess.result.to,5);
  assert.deepEqual(forgeOdds(4),{fail:49.8,upgradeOne:50.2,upgradeTwo:0});
});
test('失败必定保留主卡且品质不降，材料随机返还一到两张且星币不退',()=>{
  const one=forge(copiesState('forest-sprout',1,1,1,1),'forest-sprout',{random:queued([0.05,0.5,0.9,0.9])});
  assert.equal(one.result.branch,'fail');assert.equal(one.result.returnedUids.length,1);
  assert.equal(one.state.cards.filter(c=>c.defId==='forest-sprout').length,3);
  assert.equal(one.state.coins,funded().coins-QUALITY.forge.coins[0]);
  assert.equal(owned(one.state,'forest-sprout')[0].rank,1);
  assert.ok(one.state.cards.some(c=>c.uid===one.result.mainUid&&c.rank===1));
  const all=forge(copiesState('forest-sprout',1,1,1,1),'forest-sprout',{random:queued([0.05,0.7])});
  assert.equal(all.result.branch,'fail');assert.equal(all.result.returnedUids.length,2);
  assert.equal(all.state.cards.filter(c=>c.defId==='forest-sprout').length,4);
  assert.equal(all.state.coins,funded().coins-QUALITY.forge.coins[0]);
  roundTrip(one.state);roundTrip(all.state);
});
test('星冕封顶、材料品质不符、材料重复、包含主卡、星币不足与培育锁定均拒绝且不改写输入',()=>{
  const top=copiesState('forest-sprout',5,5,5);
  assert.throws(()=>forge(top,'forest-sprout',{random:queued([0.5])}),/最高品质/);
  const mixed=copiesState('forest-sprout',2,2,1);
  assert.throws(()=>forge(mixed,'forest-sprout',{random:queued([0.5])}),/还需要 1 张 流光/);
  const wrongQuality=mixed.cards.find(c=>c.defId==='forest-sprout'&&c.rank===1)!;
  assert.throws(()=>forge(mixed,'forest-sprout',{materialUids:[wrongQuality.uid,wrongQuality.uid],random:queued([0.5])}),/同品质/);
  const enough=copiesState('forest-sprout',1,1,1,1);
  assert.throws(()=>forge(enough,'forest-sprout',{materialUids:['c901','c901'],random:queued([0.5])}),/重复/);
  assert.throws(()=>forge(enough,'forest-sprout',{mainUid:'missing',random:queued([0.5])}),/主卡/);
  assert.throws(()=>forge(enough,'forest-sprout',{mainUid:'c900',materialUids:['c900','c901'],random:queued([0.5])}),/材料/);
  assert.throws(()=>forge(enough,'forest-sprout',{materialUids:['c901','c902','c903'],random:queued([0.5])}),/恰好 2 张/);
  const broke={...copiesState('forest-sprout',1,1,1,1),coins:QUALITY.forge.coins[0]-1};
  const before=structuredClone(broke);assert.throws(()=>forge(broke,'forest-sprout',{random:queued([0.5])}),/星币不足/);
  assert.deepEqual(broke,before);
  const running=startRun(copiesState('forest-sprout',1,1,1,1));
  assert.throws(()=>forge(running,'forest-sprout',{mainUid:running.cards.find(c=>c.defId==='forest-sprout'&&c.rank===1)!.uid,random:queued([0.5])}),/培育/);
  assert.throws(()=>forge(funded(),'breeze-sprout',{random:queued([0.5])}),/尚未拥有/);
});
test('培育中的同名实例不能成为主卡或材料，合成只消耗指定材料',()=>{
  let s=startRun(funded());
  const locked=s.run!.deck.find(c=>c.defId==='forest-rabbit')!.uid;
  s=craft(s,'forest-rabbit');
  const {state:next,result}=forge(s,'forest-rabbit',{mainUid:nextMainUid(s,'forest-rabbit'),materialUids:s.cards.filter(c=>c.defId==='forest-rabbit'&&c.rank===1&&!s.run!.deck.some(d=>d.uid===c.uid)&&c.uid!==nextMainUid(s,'forest-rabbit')).map(c=>c.uid),random:queued([0.99])});
  assert.ok(next.cards.some(c=>c.uid===locked&&c.rank===1));
  assert.equal(next.cards.filter(c=>c.defId==='forest-rabbit').length,2);
  assert.equal(owned(next,'forest-rabbit')[0].rank,2);
  assert.deepEqual(result.returnedUids,[]);roundTrip(next);
  assert.throws(()=>forge(s,'forest-rabbit',{mainUid:locked,random:queued([0.5])}),/培育/);
});
function nextMainUid(state:GameState,defId:string):string {
  const active=new Set(state.run?.deck.map(c=>c.uid)??[]);
  return owned(state,defId).find(c=>!active.has(c.uid))!.uid;
}
test('分解只消耗未强化重复卡，保留最后一张和最高纪录',()=>{
  const s=fresh();const main=owned(s,'forest-sprout')[0];main.best=99;const after=recycle(s,'forest-sprout',3);
  assert.equal(after.cards.length,s.cards.length-3);assert.equal(after.dust,s.dust+30);assert.equal(after.coins,s.coins);assert.deepEqual(owned(after,'forest-sprout'),[main]);assert.throws(()=>recycle(after,'forest-sprout'),/最后一张/);roundTrip(after);
  const upgraded=copiesState('forest-sprout',2,1,1,1);const last=recycle(upgraded,'forest-sprout',3);assert.equal(owned(last,'forest-sprout')[0].rank,2);assert.throws(()=>recycle(last,'forest-sprout'));roundTrip(last);
});
test('分解保护活跃实例，并拒绝非正整数数量',()=>{
  let s=startRun(funded());const locked=s.run!.deck.find(c=>c.defId==='forest-rabbit')!.uid;
  while(s.nextId<100)s=craft(s,'moon-fawn');s=craft(s,'forest-rabbit');s=recycle(s,'forest-rabbit',2);assert.ok(s.cards.some(c=>c.uid===locked));assert.throws(()=>recycle(s,'forest-rabbit'));roundTrip(s);
  for(const amount of [0,-1,1.5,NaN,Infinity])assert.throws(()=>recycle(fresh(),'moon-fawn',amount));
});
test('历史模式：所有稀有度的定向制作再分解都有净损耗（legacy 星尘口径）',()=>{
  for(const rarity of ['R','SR','SSR'] as const){const id=CARDS.find(c=>LEGACY_RARITY[c.id]===rarity)!.id;const s=funded();const made=craft(s,id);assert.equal(made.cards.length,s.cards.length+1);assert.equal(made.cards.at(-1)!.defId,id);assert.equal(made.dust,s.dust-LEGACY_ECONOMY.craft[rarity]);assert.equal(made.cards.at(-1)!.rank,1);const recovered=recycle(made,id);assert.equal(recovered.cards.length,s.cards.length);assert.equal(recovered.dust,s.dust-LEGACY_ECONOMY.craft[rarity]+LEGACY_ECONOMY.recycle[rarity]);assert.ok(recovered.dust<s.dust);roundTrip(recovered);}
  assert.throws(()=>craft({...fresh(),dust:0},'sun-fox'),/星尘不足/);
});
test('未知与原型属性名不可以作为卡牌编号',()=>{
  for(const id of ['missing','toString','constructor','__proto__'])for(const action of [craft,recycle,(state:GameState,defId:string)=>forge(state,defId,{random:queued([0.5])})])assert.throws(()=>action(funded(),id),/未知星灵/);
});
test('历史模式召唤优先使用券，随后精确扣币且保留三张带品质的结果（legacy）',()=>{
  const s=fresh();const a=summon(s);assert.equal(a.tickets,s.tickets-1);assert.equal(a.coins,s.coins);assert.equal(a.cards.length,s.cards.length+3);assert.equal(a.lastSummon.length,3);
  assert.deepEqual(a.cards.slice(-3).map(c=>({defId:c.defId,quality:c.rank})),a.lastSummon);roundTrip(a);
  const b=summon({...s,tickets:0});assert.equal(b.coins,s.coins-LEGACY_ECONOMY.packCost);assert.equal(b.tickets,0);assert.throws(()=>summon({...s,tickets:0,coins:LEGACY_ECONOMY.packCost-1}));assert.deepEqual(summon(fresh(52)),summon(fresh(52)));
});
test('跨 800 个 seed：每包含至少一张 Q2+，前两张 Q1 时第三张保底 Q2，编号不重复',()=>{
  for(let index=1;index<=800;index++){const seed=Math.imul(index,0x9e3779b9)>>>0;const s=summon(fresh(seed));
    assert.ok(s.lastSummon.some(draw=>draw.quality>=2),'seed '+seed);
    if(s.lastSummon[0].quality===1&&s.lastSummon[1].quality===1)assert.ok(s.lastSummon[2].quality>=2,'seed '+seed);
    assert.equal(new Set(s.cards.map(c=>c.uid)).size,s.cards.length);}
});
test('品质频率随档位严格递减且概率表归一',()=>{
  const total=QUALITY.summonQuality.reduce((sum,value)=>sum+value,0);
  assert.ok(Math.abs(total-100)<1e-9);
  for(let index=1;index<QUALITY.summonQuality.length;index++)assert.ok(QUALITY.summonQuality[index]<QUALITY.summonQuality[index-1]);
  const counts=new Array(QUALITY.summonQuality.length).fill(0);let draws=0;
  for(let index=1;index<=1500;index++){const s=summon(fresh(Math.imul(index,0x9e3779b9)>>>0));for(const draw of s.lastSummon)counts[draw.quality-1]++;draws+=3;}
  for(let index=1;index<counts.length;index++)assert.ok(counts[index]<counts[index-1],'档位 '+qualityName(index+1)+' 未严格递减');
  assert.ok(counts[0]/draws>0.45&&counts[0]/draws<0.6,'Q1 频率 '+counts[0]/draws);
  assert.ok(counts[4]/draws>0.008&&counts[4]/draws<0.025,'Q5 频率 '+counts[4]/draws);
});
test('合成概率表：每档互斥三分支和为 100，失败率逐档上升，连升并入近顶级',()=>{
  for(let from=1;from<QUALITY_MAX;from++){const odds=forgeOdds(from);
    assert.ok(Math.abs(odds.fail+odds.upgradeOne+odds.upgradeTwo-100)<1e-9,'档位 '+from);
    if(from>1)assert.ok(odds.fail>forgeOdds(from-1).fail,'失败率未递增 '+from);}
  assert.equal(forgeOdds(4).upgradeTwo,0);assert.equal(forgeOdds(4).upgradeOne,50.2);
});
test('召唤恰好消耗九次随机数，种子链完全确定',()=>{
  const seed=987654321;let chain=seed;for(let i=0;i<9;i++)[,chain]=random(chain);
  assert.equal(summon(fresh(seed)).rng,chain);
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
test('完成后解锁编队与合成，旧成果保持原始快照',()=>{
  const s=finish(funded(),true);const result=structuredClone(s.results[0]);let next=setLineup(s,[...s.lineup.reverse()]);
  next=forge(next,'forest-rabbit',{random:queued([0.99])}).state;assert.deepEqual(next.results[0],result);roundTrip(next);const again=startRun(next);assert.notEqual(again.run!.id,s.run!.id);assert.equal(again.results.length,1);roundTrip(again);
});
test('完成后的最高纪录只提高不下降，手记最多保留五十次',()=>{
  let s=fresh(512);let best=0;
  for(let i=0;i<52;i++){s=finish(s);best=Math.max(best,s.run!.score);assert.equal(s.cards.find(c=>c.uid===s.run!.deck[0].uid)!.best,best);s=roundTrip(s);}
  assert.equal(s.results.length,50);assert.equal(new Set(s.results.map(r=>r.id)).size,50);assert.equal(s.results[0].id,s.run!.id);
});

test('初始化 seed 统一转换为有效的非零 32 位随机状态',()=>{
  assert.equal(initialState(-1).rng,0xffffffff);for(const seed of [NaN,Infinity,0,0x100000000]){const s=initialState(seed);assert.equal(s.rng,42);roundTrip(s);}
});
