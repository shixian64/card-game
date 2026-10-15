import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AFFINITIES, CARDS, CARD_MAP, CARD_ART_NOTE, COMBOS, TALENTS, CONDITIONS, LEGACY_RARITY } from '../src/data.ts';
import { craft, summon, setLineup, startRun, resolveTurn, preview, parseSave } from '../src/engine.ts';
import type { GameState, Run } from '../src/engine.ts';
import { DATE, fresh, funded, finish, fixture, keys, roundTrip } from './helpers.ts';
const LEGACY_IDS=['moon-deer','sun-fox','forest-rabbit','moon-fawn','sun-cub','forest-sprout','star-deer','golden-fox','verdant-rabbit','mist-deer','dawn-fox','breeze-sprout'];
const variants=CARDS.filter(c=>!LEGACY_IDS.includes(c.id));

test('扩容为 36 种，每系与每稀有度数量均衡，旧编号与顺序不变',()=>{
  assert.equal(CARDS.length,36);assert.deepEqual(CARDS.slice(0,LEGACY_IDS.length).map(c=>c.id),LEGACY_IDS);assert.equal(new Set(CARDS.map(c=>c.name)).size,CARDS.length);
  for(const affinity of Object.keys(AFFINITIES)){
    const group=CARDS.filter(c=>c.affinity===affinity);assert.equal(group.length,CARDS.length/3);
    for(const rarity of ['R','SR','SSR'])assert.equal(group.filter(c=>LEGACY_RARITY[c.id]===rarity).length,group.length/3);
  assert.ok(CARDS.every(c=>!Object.hasOwn(c,'rarity')),'新规则 CardDef 不再有 rarity 字段');
  }
  assert.equal(new Set(CARDS.map(c=>[c.affinity,c.cost,c.base,c.trait].join('/'))).size,CARDS.length);
  assert.ok(CARDS.every(c=>c.base<=10&&c.cost<=3));
});
test('24 张新增卡明确标识图鉴变体，仅复用六幅原插画',()=>{
  const art=new Set(CARDS.slice(0,LEGACY_IDS.length).map(c=>c.art));assert.equal(art.size,6);assert.equal(variants.length,24);
  for(const c of variants){assert.ok(c.subtitle.includes('图鉴变体'));assert.ok(art.has(c.art));assert.ok(c.description.length<=32);}
  assert.match(CARD_ART_NOTE,/共用 6 幅/);assert.match(CARD_ART_NOTE,/24 种为图鉴变体/);
});
test('规则与效果文案简短，组合编号和分数维持兼容',()=>{
  assert.deepEqual(COMBOS.map(c=>[c.id,c.name,c.bonus]),[['mono','三同色',20],['trio','三异色',18],['mirror','夹心',12]]);
  assert.deepEqual(Object.values(AFFINITIES).map(a=>a.name),['月','日','森']);
  for(const row of [...CARDS,...TALENTS,...CONDITIONS]){assert.ok(row.description.length<=32);assert.doesNotMatch(row.description,/共鸣|首尾呼应|星相|三相轮转/);}
});
test('四份扩容前真实 v1 存档仍可原样导入，旧局计分不变',()=>{
  const snapshots=JSON.parse(readFileSync(new URL('./fixtures/legacy-v1.json',import.meta.url),'utf8')) as GameState[];
  assert.equal(snapshots.length,4);
  for(const snapshot of snapshots){const loaded=parseSave(JSON.stringify(snapshot));assert.deepEqual(loaded,snapshot);if(loaded.run?.phase==='talent')roundTrip(finish(loaded));}
});
test('所有星灵均能从同一个三连卡池抽取，包括新增 24 种',()=>{
  const seen=new Set<string>();
  for(let i=1;i<=4000&&seen.size<CARDS.length;i++){const s=summon(fresh(Math.imul(i,0x9e3779b9)>>>0));for(const draw of s.lastSummon)seen.add(draw.defId);}
  assert.deepEqual([...seen].sort(),CARDS.map(c=>c.id).sort());
});
for(const card of variants)test('新增星灵可制作、上阵、实际出牌并完成培育：'+card.name,()=>{
  const base=craft(funded(),card.id);assert.ok(base.cards.some(c=>c.defId===card.id));
  const ready=setLineup(base,[card.id,'moon-fawn','sun-cub','forest-sprout','forest-rabbit','moon-deer']);let active:GameState|undefined;
  for(let i=1;i<=64;i++){const candidate=startRun({...ready,rng:Math.imul(i,0x9e3779b9)>>>0});if(candidate.run!.hand.some(p=>p.defId===card.id)){active=candidate;break;}}
  assert.ok(active);const p=active.run!.hand.find(p=>p.defId===card.id)!;const played=resolveTurn(active,[p.key],DATE);assert.equal(played.run!.logs[0].cards[0],card.id);roundTrip(played);
  const finished=finish(played,true);assert.equal(finished.results[0].leader,card.id);assert.equal(finished.run!.logs.length,6);assert.equal(finished.run!.talents.length,2);assert.ok(finished.results[0].score>0);
});
function skillBonus(run:Run,id:string):number {return preview(run,keys(run)).lines.find(line=>line.label===CARD_MAP[id].traitName)?.value??0;}
test('新技能：第 2 张加分，只看位置而不要求凑三张',()=>{
  assert.equal(skillBonus(fixture(['moon-fawn','crescent-dancer']),'crescent-dancer'),8);
  assert.equal(skillBonus(fixture(['crescent-dancer','moon-fawn']),'crescent-dancer'),0);
});
test('新技能：异色接力必须有上一张，且颜色不同',()=>{
  assert.equal(skillBonus(fixture(['sun-cub','frost-return']),'frost-return'),7);
  assert.equal(skillBonus(fixture(['moon-fawn','frost-return']),'frost-return'),0);
  assert.equal(skillBonus(fixture(['frost-return']),'frost-return'),0);
});
test('新技能：单张加分不能在两张或三张中触发',()=>{
  assert.equal(skillBonus(fixture(['moon-soloist']),'moon-soloist'),16);
  assert.equal(skillBonus(fixture(['moon-soloist','sun-cub']),'moon-soloist'),0);
});
test('新技能：换组合要求前后两回合都触发组合，且不同',()=>{
  const run=fixture(['moon-fawn','sun-change','forest-rabbit']);
  const log={turn:1,cards:['moon-fawn'],score:0,combo:'mono',condition:'forest'};
  assert.equal(skillBonus({...run,logs:[log]},'sun-change'),11);
  assert.equal(skillBonus({...run,logs:[{...log,combo:'trio'}]},'sun-change'),0);
  assert.equal(skillBonus({...run,logs:[{...log,combo:null}]},'sun-change'),0);
  assert.equal(skillBonus(run,'sun-change'),0);
  assert.equal(skillBonus(fixture(['sun-change','moon-fawn'],{logs:[log]}),'sun-change'),0);
});
