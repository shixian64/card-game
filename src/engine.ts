import { CARDS, CARD_MAP, COMBOS, TALENTS, CONDITIONS, LEGACY_ECONOMY, LEGACY_RARITY, ECONOMY, QUALITY, QUALITY_MAX, qualityName } from './data.ts';
import type { LegacyRarity, ForgeBranch } from './data.ts';
import { getCombatStats } from './battle.ts';
export interface OwnedCard { uid:string; defId:string; rank:number; best:number }
export interface Projection { key:string; defId:string; rank:number }
export interface Growth { insight:number; bond:number; focus:number }
export interface ScoreLine { label:string; value:number }
export interface Preview { score:number; cost:number; budget:number; combo:string|null; lines:ScoreLine[]; growth:Growth; valid:boolean; reason:string }
export interface TurnLog { turn:number; cards:string[]; score:number; combo:string|null; condition:string }
export interface SummonDraw { defId:string; quality:number }
export interface ForgeOutcome { defId:string; mainUid:string; from:number; to:number; branch:ForgeBranch; returnedUids:string[]; coins:number }
export interface Run {
  id:string; seed:number; rng:number; turn:number; deck:OwnedCard[]; hand:Projection[]; score:number;
  growth:Growth; talents:string[]; offers:string[]; conditions:string[];
  phase:'playing'|'talent'|'complete'; redraws:number; logs:TurnLog[];
}
export interface Result { id:string; score:number; grade:string; title:string; growth:Growth; leader:string; talents:string[]; combos:string[]; date:string; coins:number; dust:number; seed:number }
export interface GameState {
  version:1; coins:number; dust:number; tickets:number; rng:number; nextId:number;
  cards:OwnedCard[]; lineup:string[]; results:Result[]; discoveries:string[]; run:Run|null;
  lastSummon:SummonDraw[]; lastForge?:ForgeOutcome|null;
}
export function random(seed:number):[number,number] {
  let x=seed||0x9e3779b9; x^=x<<13; x^=x>>>17; x^=x<<5;
  return [(x>>>0)/4294967296,x>>>0];
}
function shuffle<T>(array:T[],seed:number):[T[],number] {
  const a=[...array]; let r:number;
  for(let i=a.length-1;i>0;i--){[r,seed]=random(seed); const j=Math.floor(r*(i+1)); [a[i],a[j]]=[a[j],a[i]];}
  return [a,seed];
}
export function initialState(seed=Date.now()>>>0):GameState {
  const copies=[2,2,3,4,4,4,2,2];
  const cards:OwnedCard[]=[]; let nextId=1;
  copies.forEach((n,i)=>{for(let j=0;j<n;j++)cards.push({uid:'c'+nextId++,defId:CARDS[i].id,rank:1,best:0});});
  return {version:1,coins:1280,dust:360,tickets:3,rng:(seed>>>0)||42,nextId,cards,lineup:CARDS.slice(0,6).map(c=>c.id),results:[],discoveries:[],run:null,lastSummon:[]};
}
export function owned(state:GameState,defId:string) { return state.cards.filter(c=>c.defId===defId).sort((a,b)=>b.rank-a.rank||b.best-a.best||a.uid.localeCompare(b.uid)); }
function ensure(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}
function clone(s:GameState):GameState{return structuredClone(s);}
const MAX_CARDS=10000;
function knownCard(value:unknown):value is string {return typeof value==='string'&&Object.hasOwn(CARD_MAP,value);}
function card(defId:string){ensure(knownCard(defId),'未知星灵');return CARD_MAP[defId];}
function activeCardIds(state:GameState):Set<string> {return new Set(state.run&&state.run.phase!=='complete'?state.run.deck.map(c=>c.uid):[]);}
function availableIds(state:GameState,count:number):void {ensure(Number.isSafeInteger(state.nextId+count),'存档实例编号已达上限');}
function safeBalance(amount:number):void {ensure(Number.isSafeInteger(amount)&&amount>=0,'资源数量超出安全范围');}
function grade(score:number):string {return score>=420?'S':score>=330?'A':score>=240?'B':'C';}
function rewards(score:number):{coins:number;dust:number} {return {coins:80+Math.floor(score/3),dust:15+Math.floor(score/20)};}
function makeResult(run:Run,date:string):Result {
  const combos=run.logs.map(l=>l.combo).filter((x):x is string=>!!x);
  const dominant=COMBOS.map(c=>({id:c.id,count:combos.filter(x=>x===c.id).length})).sort((a,b)=>b.count-a.count)[0];
  const titles:Record<string,string>={mono:'纯色奏鸣',trio:'万象交响',mirror:'月下回声'};
  return {id:run.id,score:run.score,grade:grade(run.score),title:dominant.count>=3?titles[dominant.id]:'自由生长',growth:{...run.growth},leader:run.deck[0].defId,talents:[...run.talents],combos:[...new Set(combos)],date,...rewards(run.score),seed:run.seed};
}
export function setLineup(state:GameState,lineup:string[]):GameState {
  ensure(!state.run||state.run.phase==='complete','培育中的阵容已锁定，请先完成或结束本次培育');
  ensure(lineup.length<=6&&new Set(lineup).size===lineup.length,'阵容最多 6 种不同星灵');
  ensure(lineup.every(id=>owned(state,id).length),'只能加入已拥有的星灵');
  return {...state,lineup:[...lineup]};
}
const QUALITY_LEVELS=Array.from({length:QUALITY_MAX},(_,index)=>index+1);
export interface ForgeOptions { mainUid?:string; materialUids?:string[]; random?:(state:{rng:number})=>number }
/** 同卡品质合成：主卡 + 2 张同品质材料；单次均匀随机定 fail / upgrade_two / upgrade_one。 */
export function forge(state:GameState,defId:string,options:ForgeOptions={}):{state:GameState;result:ForgeOutcome} {
  card(defId);const list=owned(state,defId);ensure(list.length,'尚未拥有该星灵');
  const active=activeCardIds(state);
  const main=options.mainUid!==undefined?list.find(card=>card.uid===options.mainUid):list[0];
  ensure(main,'指定的主卡不存在');ensure(main.rank<QUALITY_MAX,`${qualityName(QUALITY_MAX)}已是最高品质，无法继续合成`);
  ensure(!active.has(main.uid),'该星灵正在培育，请先完成本次培育');
  const sameQuality=list.filter(card=>card.uid!==main.uid&&card.rank===main.rank&&!active.has(card.uid));
  let material:OwnedCard[];
  if(options.materialUids!==undefined){
    ensure(Array.isArray(options.materialUids)&&options.materialUids.length===QUALITY.forge.materials,`需要恰好 ${QUALITY.forge.materials} 张材料`);
    material=options.materialUids.map(uid=>{const found=sameQuality.find(card=>card.uid===uid);ensure(found,'材料必须是同品质、未锁定的同名卡');return found;});
    ensure(new Set(material.map(card=>card.uid)).size===material.length,'材料不能重复');
  }else material=sameQuality.slice(0,QUALITY.forge.materials);
  ensure(material.length===QUALITY.forge.materials,`还需要 ${QUALITY.forge.materials-material.length} 张 ${qualityName(main.rank)} 品质的同名材料`);
  const coins=QUALITY.forge.coins[main.rank-1];ensure(state.coins>=coins,'星币不足');
  const next=clone(state);
  const draw=options.random??((source:{rng:number})=>{let value:number;[value,source.rng]=random(source.rng);return value;});
  const fail=QUALITY.forge.fail[main.rank-1],twoUp=QUALITY.forge.upgradeTwo[main.rank-1];
  const roll=draw(next)*100;
  let branch:ForgeBranch,to=main.rank;
  if(roll<fail)branch='fail';
  else if(main.rank+2<=QUALITY_MAX&&roll<fail+twoUp){branch='upgrade_two';to=main.rank+2;}
  else{branch='upgrade_one';to=Math.min(main.rank+1,QUALITY_MAX);}
  next.coins-=coins;
  let returnedUids:string[]=[];
  if(branch==='fail'){
    // 失败：主卡保留、品质不降；材料按公示概率随机返还 1～2 张，其余消失。
    const returnCount=draw(next)*100<QUALITY.forge.failReturnOne?1:material.length;
    const shuffled=[...material];
    for(let index=shuffled.length-1;index>0;index--){const swap=Math.floor(draw(next)*(index+1));[shuffled[index],shuffled[swap]]=[shuffled[swap],shuffled[index]];}
    const kept=shuffled.slice(0,returnCount);
    const removedIds=new Set(shuffled.slice(returnCount).map(card=>card.uid));
    next.cards=next.cards.filter(card=>!removedIds.has(card.uid));
    returnedUids=kept.map(card=>card.uid);
  }else{
    next.cards.find(card=>card.uid===main.uid)!.rank=to;
    const removedIds=new Set(material.map(card=>card.uid));
    next.cards=next.cards.filter(card=>!removedIds.has(card.uid));
  }
  next.lastForge={defId,mainUid:main.uid,from:main.rank,to:branch==='fail'?main.rank:to,branch,returnedUids,coins};
  return {state:next,result:next.lastForge};
}
export function forgeOdds(from:number):{fail:number;upgradeOne:number;upgradeTwo:number} {
  ensure(QUALITY_LEVELS.includes(from)&&from<QUALITY_MAX,'该品质无法继续合成');
  const fail=QUALITY.forge.fail[from-1],twoUp=from+2<=QUALITY_MAX?QUALITY.forge.upgradeTwo[from-1]:0;
  return {fail,upgradeOne:100-fail-twoUp,upgradeTwo:twoUp};
}
export function recycle(state:GameState,defId:string,amount=1):GameState {
  card(defId);ensure(Number.isInteger(amount)&&amount>0,'分解数量不合法');
  const list=owned(state,defId); const active=activeCardIds(state);
  const extras=list.slice(1).filter(c=>c.rank===1&&!active.has(c.uid));
  ensure(extras.length>=amount,'保留最后一张及已强化、培育中的星灵，仅可分解多余卡');
  const ids=new Set(extras.slice(0,amount).map(c=>c.uid));const next=clone(state);
  next.cards=next.cards.filter(c=>!ids.has(c.uid)); next.dust+=LEGACY_ECONOMY.recycle[LEGACY_RARITY[defId]]*amount;safeBalance(next.dust);return next;
}
export function craft(state:GameState,defId:string):GameState {
  card(defId);ensure(state.cards.length<MAX_CARDS,'收藏已达 10000 张上限，请先整理重复卡');availableIds(state,1);
  const cost=LEGACY_ECONOMY.craft[LEGACY_RARITY[defId]];ensure(state.dust>=cost,'星尘不足，试试分解重复卡或完成培育');
  const next=clone(state);next.dust-=cost;next.cards.push({uid:'c'+next.nextId++,defId,rank:1,best:0});return next;
}
function rollQuality(roll:number):number {
  let bound=0;
  for(let index=0;index<QUALITY.summonQuality.length;index++){bound+=QUALITY.summonQuality[index]/100;if(roll<bound)return index+1;}
  return QUALITY.summonQuality.length;
}
export function summon(state:GameState):GameState {
  ensure(state.cards.length+3<=MAX_CARDS,'收藏空间不足，请先整理重复卡');availableIds(state,3);
  ensure(state.tickets>0||state.coins>=LEGACY_ECONOMY.packCost,'观星券和星币不足');
  const next=clone(state); if(next.tickets>0)next.tickets--;else next.coins-=LEGACY_ECONOMY.packCost;
  const drawn:SummonDraw[]=[];
  for(let i=0;i<3;i++){
    let roll:number; [roll,next.rng]=random(next.rng);
    let quality=rollQuality(roll);
    // 包内保底：前两张都是 Q1 且第三张仍掷出 Q1 时，升为 Q2（每包至少一张 Q2+）。
    if(i===2&&drawn.every(card=>card.quality===1)&&quality===1)quality=2;
    [roll,next.rng]=random(next.rng);
    // 历史三张包已停用：卡种权重只存在于 legacy 冻结映射（本地历史模式），服务端不再提供该接口。
    const rarity:LegacyRarity=roll<0.1?'SSR':roll<0.4?'SR':'R';
    const pool=CARDS.filter(c=>LEGACY_RARITY[c.id]===rarity);[roll,next.rng]=random(next.rng);
    const defId=pool[Math.floor(roll*pool.length)].id;drawn.push({defId,quality});
    next.cards.push({uid:'c'+next.nextId++,defId,rank:quality,best:0});
  }
  next.lastSummon=drawn;return next;
}
function drawHand(run:Run):void {
  const pool=run.deck.flatMap(c=>[0,1].map(n=>({key:run.id+'-'+run.turn+'-'+run.redraws+'-'+c.uid+'-'+n,defId:c.defId,rank:c.rank})));
  const [shuffled,seed]=shuffle(pool,run.rng);run.hand=shuffled.slice(0,5);run.rng=seed;
}
export function startRun(state:GameState):GameState {
  ensure(!state.run||state.run.phase==='complete','已有进行中的培育，请继续或结束后重开');
  ensure(state.lineup.length===6&&new Set(state.lineup).size===6,'请先选择 6 种星灵组成培育阵容');
  availableIds(state,1);
  ensure(state.lineup.every(id=>owned(state,id).length),'阵容中存在未拥有的星灵');
  ensure(!state.results.some(r=>r.id==='run'+state.nextId),'存档实例编号冲突');
  const next=clone(state); const [,seed]=random(next.rng); next.rng=seed;
  const [conditions,rng]=shuffle(CONDITIONS.map(c=>c.id),seed);
  const run:Run={id:'run'+next.nextId++,seed,rng,turn:1,deck:next.lineup.map(id=>({...owned(next,id)[0]})),hand:[],score:0,growth:{insight:0,bond:0,focus:0},talents:[],offers:[],conditions,phase:'playing',redraws:1,logs:[]};
  drawHand(run);next.run=run;return next;
}
export function abandonRun(state:GameState):GameState {return {...state,run:null};}
export function redraw(state:GameState):GameState {
  ensure(state.run?.phase==='playing','当前不能重新感应');ensure(state.run.redraws>0,'本回合的重新感应已使用');
  const next=clone(state);next.run!.redraws--;drawHand(next.run!);return next;
}
export function preview(run:Run,keys:string[]):Preview {
  const budget=7+(run.talents.includes('energy')?1:0);
  const projections=keys.map(key=>run.hand.find(c=>c.key===key)).filter((c):c is Projection=>!!c);
  const defs=projections.map(c=>CARD_MAP[c.defId]);
  const cost=defs.reduce((sum,d)=>sum+d.cost,0);
  const invalid=keys.length===0?'选择 1 至 3 张星灵':keys.length>3?'最多选择 3 张星灵':new Set(keys).size!==keys.length?'不能重复选择同一投影':projections.length!==keys.length?'投影已不在本回合手牌中':cost>budget?'行动力不足，尝试低消耗星灵':'';
  const lines:ScoreLine[]=[];let combo:string|null=null;
  const a=defs.map(d=>d.affinity);const kinds=new Set(a).size;
  if(a.length===3) {if(kinds===1)combo='mono';else if(kinds===3)combo='trio';else if(a[0]===a[2])combo='mirror';}
  if(defs.length)lines.push({label:'基础分',value:projections.reduce((sum,c)=>sum+CARD_MAP[c.defId].base+(c.rank-1)*2+(run.talents.includes('growth')?3:0),0)});
  if(combo)lines.push({label:COMBOS.find(c=>c.id===combo)!.name,value:COMBOS.find(c=>c.id===combo)!.bonus});
  defs.forEach((d,i)=>{
    let value=0;
    if(d.trait==='echo'&&combo==='mirror')value=12;
    if(d.trait==='flare'&&i===2)value=10;
    if(d.trait==='bloom'&&combo==='trio')value=10;
    if(d.trait==='quiet'&&i===0)value=5;
    if(d.trait==='lead'&&a[i+1]==='sun')value=8;
    if(d.trait==='root')value=Math.max(0,budget-cost)*2;
    if(d.trait==='tidal'&&a[i-1]==='moon')value=9;
    if(d.trait==='duet'&&a[i-1]==='forest')value=10;
    if(d.trait==='weave'&&(combo==='mono'||combo==='trio'))value=12;
    if(d.trait==='memory'&&combo&&run.logs.at(-1)?.combo===combo)value=9;
    if(d.trait==='rush'&&cost===budget)value=12;
    if(d.trait==='wander'&&combo==='trio'&&i===1)value=14;
    if(d.trait==='center'&&i===1)value=8;
    if(d.trait==='contrast'&&i>0&&a[i-1]!==d.affinity)value=7;
    if(d.trait==='solo'&&defs.length===1)value=16;
    if(d.trait==='shift'&&combo&&run.logs.at(-1)?.combo&&run.logs.at(-1)!.combo!==combo)value=11;
    if(value)lines.push({label:d.traitName,value});
  });
  const condition=CONDITIONS.find(c=>c.id===run.conditions[run.turn-1])!;
  let bonus=0;
  if(condition.affinity)bonus=a.filter(x=>x===condition.affinity).length*4;
  if(condition.id==='quiet')bonus=Math.max(0,budget-cost)*3;
  if(condition.id==='trio'&&combo==='trio')bonus=10;
  if(condition.id==='mirror'&&combo==='mirror')bonus=12;
  if(bonus&&defs.length)lines.push({label:condition.name,value:bonus});
  if(run.talents.includes('harmony')&&combo==='mono')lines.push({label:TALENTS.find(t=>t.id==='harmony')!.name,value:18});
  if(run.talents.includes('echo')&&combo==='mirror')lines.push({label:TALENTS.find(t=>t.id==='echo')!.name,value:16});
  if(run.talents.includes('focus')&&budget>cost&&defs.length)lines.push({label:TALENTS.find(t=>t.id==='focus')!.name,value:(budget-cost)*4});
  const subtotal=lines.reduce((sum,l)=>sum+l.value,0);
  if(run.talents.includes('prism')&&combo==='trio')lines.push({label:TALENTS.find(t=>t.id==='prism')!.name+' ×1.3',value:Math.round(subtotal*.3)});
  const maxAffinity=Math.max(0,...['moon','sun','forest'].map(x=>a.filter(y=>x===y).length));
  return {score:invalid?0:lines.reduce((sum,l)=>sum+l.value,0),cost,budget,combo,lines,growth:{insight:kinds*2+(combo==='trio'?6:0),bond:maxAffinity*2+(combo==='mono'?6:combo==='mirror'?4:0),focus:Math.max(0,budget-cost)+3},valid:!invalid,reason:invalid};
}
export function chooseTalent(state:GameState,id:string):GameState {
  ensure(state.run?.phase==='talent','当前没有可选择的天赋');ensure(state.run.offers.includes(id),'该天赋不在本次候选中');ensure(!state.run.talents.includes(id),'不能重复选择天赋');
  const next=clone(state);const run=next.run!;run.talents.push(id);run.offers=[];run.phase='playing';return next;
}
export function resolveTurn(state:GameState,keys:string[],date=new Date().toISOString()):GameState {
  ensure(state.run?.phase==='playing','当前回合已结算或需要先选择天赋');
  ensure(!state.results.some(r=>r.id===state.run!.id),'本次培育已领取奖励');
  ensure(typeof date==='string'&&date.length<=64&&Number.isFinite(Date.parse(date)),'培育日期不合法');
  const p=preview(state.run,keys);ensure(p.valid,p.reason);const next=clone(state);const run=next.run!;
  run.score+=p.score;for(const key of ['insight','bond','focus'] as const)run.growth[key]+=p.growth[key];
  run.logs.push({turn:run.turn,cards:keys.map(k=>run.hand.find(c=>c.key===k)!.defId),score:p.score,combo:p.combo,condition:run.conditions[run.turn-1]});
  if(p.combo&&!next.discoveries.includes(p.combo))next.discoveries.push(p.combo);
  if(run.turn===6) {
    run.phase='complete'; const result=makeResult(run,date);
    next.results=[result,...next.results].slice(0,50);next.coins+=result.coins;next.dust+=result.dust;
    safeBalance(next.coins);safeBalance(next.dust);
    const leader=next.cards.find(c=>c.uid===run.deck[0].uid);if(leader)leader.best=Math.max(leader.best,run.score);
  } else {
    run.turn++;run.redraws=1;drawHand(run);
    if(run.turn===3||run.turn===5){const [offers,rng]=shuffle(TALENTS.filter(t=>!run.talents.includes(t.id)).map(t=>t.id),run.rng);run.rng=rng;run.offers=offers.slice(0,3);run.phase='talent';}
  }
  return next;
}
export const SAVE_KEY='asteria.save.v1';
function record(value:unknown):value is Record<string,unknown> {return !!value&&typeof value==='object'&&!Array.isArray(value);}
function whole(value:unknown):value is number {return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
function uint(value:unknown):value is number {return whole(value)&&value<=0xffffffff;}
function instanceId(value:unknown,prefix:'c'|'run'):value is string {
  if(typeof value!=='string'||!new RegExp('^'+prefix+'[1-9][0-9]*$').test(value))return false;
  return Number.isSafeInteger(Number(value.slice(prefix.length)));
}
function growthData(value:unknown):value is Growth {
  return record(value)&&Object.keys(value).length===3&&whole(value.insight)&&whole(value.bond)&&whole(value.focus);
}
function cardData(value:unknown):value is OwnedCard {
  return record(value)&&instanceId(value.uid,'c')&&knownCard(value.defId)&&QUALITY_LEVELS.includes(value.rank as number)&&whole(value.best);
}
function summonDraw(value:unknown):value is SummonDraw {
  return record(value)&&knownCard(value.defId)&&QUALITY_LEVELS.includes(value.quality as number);
}
function forgeOutcome(value:unknown):value is ForgeOutcome {
  return record(value)&&knownCard(value.defId)&&instanceId(value.mainUid,'c')
    &&QUALITY_LEVELS.includes(value.from as number)&&QUALITY_LEVELS.includes(value.to as number)
    &&['upgrade_one','upgrade_two','fail'].includes(value.branch as string)
    &&Array.isArray(value.returnedUids)&&value.returnedUids.every((uid:unknown)=>instanceId(uid,'c'))
    &&whole(value.coins);
}
function ids(value:unknown,allowed:string[],max:number,min=0):value is string[] {
  return Array.isArray(value)&&value.length>=min&&value.length<=max&&new Set(value).size===value.length&&value.every(id=>typeof id==='string'&&allowed.includes(id));
}
function sameArray(a:string[],b:string[]):boolean {return a.length===b.length&&a.every((value,i)=>value===b[i]);}
function sameGrowth(a:Growth,b:Growth):boolean {return a.insight===b.insight&&a.bond===b.bond&&a.focus===b.focus;}
const TALENT_IDS=TALENTS.map(t=>t.id);
const COMBO_IDS=COMBOS.map(c=>c.id);
const CONDITION_IDS=CONDITIONS.map(c=>c.id);
function validateResult(value:unknown):asserts value is Result {
  ensure(record(value)&&instanceId(value.id,'run')&&whole(value.score)&&knownCard(value.leader)&&uint(value.seed),'培育手记基础数据损坏');
  ensure(growthData(value.growth)&&ids(value.talents,TALENT_IDS,2,2)&&ids(value.combos,COMBO_IDS,3),'培育手记成长数据损坏');
  ensure(typeof value.date==='string'&&value.date.length<=64&&Number.isFinite(Date.parse(value.date)),'培育手记日期损坏');
  const reward=rewards(value.score);
  ensure(value.grade===grade(value.score)&&value.coins===reward.coins&&value.dust===reward.dust,'培育手记奖励或评级损坏');
  const titles:Record<string,string>={'纯色奏鸣':'mono','万象交响':'trio','月下回声':'mirror'};
  ensure(value.title==='自由生长'||(typeof value.title==='string'&&Object.hasOwn(titles,value.title)&&value.combos.includes(titles[value.title])),'培育手记称号损坏');
}
export function parseSave(raw:string):GameState {
  ensure(typeof raw==='string'&&raw.length<=2_000_000,'存档文件不能超过 2 MB');
  let parsed:unknown;
  try {parsed=JSON.parse(raw);}catch {throw new Error('存档不是有效的 JSON 文件');}
  ensure(record(parsed)&&parsed.version===1,'存档版本不兼容');
  const s=parsed as unknown as GameState;
  for(const k of ['coins','dust','tickets','nextId'] as const)ensure(whole(s[k]),'存档资源数据损坏');
  ensure(s.nextId>0&&uint(s.rng),'存档编号或随机状态损坏');
  ensure(Array.isArray(s.cards)&&s.cards.length<=MAX_CARDS&&s.cards.length>=6&&s.cards.every(cardData),'存档星灵数据损坏');
  ensure(new Set(s.cards.map(c=>c.uid)).size===s.cards.length,'存档实例重复');
  ensure(ids(s.lineup,CARDS.map(c=>c.id),6)&&s.lineup.every(id=>s.cards.some(c=>c.defId===id)),'存档阵容损坏');
  ensure(ids(s.discoveries,COMBO_IDS,3),'图鉴进度损坏');
  ensure(Array.isArray(s.lastSummon)&&(s.lastSummon.length===0||s.lastSummon.length===3)&&s.lastSummon.every(entry=>typeof entry==='string'?knownCard(entry):summonDraw(entry)),'观星记录损坏');
  ensure(s.lastForge===undefined||s.lastForge===null||forgeOutcome(s.lastForge),'合成记录损坏');
  ensure(Array.isArray(s.results)&&s.results.length<=50,'培育手记损坏');
  s.results.forEach(validateResult);
  ensure(new Set(s.results.map(r=>r.id)).size===s.results.length,'培育手记重复');
  ensure(s.results.every(r=>r.combos.every(id=>s.discoveries.includes(id))),'培育手记与图鉴不一致');
  const serials=s.cards.map(c=>Number(c.uid.slice(1)));
  for(const r of s.results){const serial=Number(r.id.slice(3));ensure(!serials.includes(serial),'存档实例编号冲突');serials.push(serial);}
  ensure(s.run===null||record(s.run),'培育进度损坏');
  if(s.run){
    const r=s.run;
    ensure(instanceId(r.id,'run')&&uint(r.seed)&&uint(r.rng)&&whole(r.score),'培育记录损坏');
    ensure(['playing','talent','complete'].includes(r.phase)&&Number.isInteger(r.turn)&&r.turn>=1&&r.turn<=6&&[0,1].includes(r.redraws),'培育阶段损坏');
    ensure(Array.isArray(r.deck)&&r.deck.length===6&&r.deck.every(cardData)&&new Set(r.deck.map(c=>c.uid)).size===6&&new Set(r.deck.map(c=>c.defId)).size===6,'培育阵容损坏');
    ensure(ids(r.conditions,CONDITION_IDS,6,6),'环境记录损坏');
    ensure(growthData(r.growth)&&ids(r.talents,TALENT_IDS,2)&&ids(r.offers,TALENT_IDS,3),'天赋或成长记录损坏');
    if(r.phase==='talent'){
      ensure((r.turn===3||r.turn===5)&&r.talents.length===(r.turn===3?0:1)&&r.offers.length===3&&r.offers.every(id=>!r.talents.includes(id)),'天赋选择阶段不一致');
    }else{
      ensure(r.offers.length===0&&r.talents.length===Math.floor((r.turn-1)/2),'天赋进度不一致');
    }
    ensure(r.phase!=='complete'||r.turn===6,'完成态回合不一致');
    const deckByDef=new Map(r.deck.map(c=>[c.defId,c]));
    const projectionKeys=new Map(r.deck.flatMap(c=>[0,1].map(n=>[r.id+'-'+r.turn+'-'+r.redraws+'-'+c.uid+'-'+n,c] as const)));
    ensure(Array.isArray(r.hand)&&r.hand.length===5&&r.hand.every(p=>record(p)&&typeof p.key==='string'&&projectionKeys.has(p.key)&&projectionKeys.get(p.key)!.defId===p.defId&&projectionKeys.get(p.key)!.rank===p.rank)&&new Set(r.hand.map(p=>p.key)).size===5,'培育手牌损坏');
    const logCount=r.phase==='complete'?6:r.turn-1;
    ensure(Array.isArray(r.logs)&&r.logs.length===logCount,'培育回合记录不完整');
    const totalGrowth:Growth={insight:0,bond:0,focus:0};let totalScore=0;
    r.logs.forEach((log,index)=>{
      ensure(record(log)&&log.turn===index+1&&log.condition===r.conditions[index]&&Array.isArray(log.cards)&&log.cards.length>=1&&log.cards.length<=3&&log.cards.every(id=>knownCard(id)&&deckByDef.has(id))&&whole(log.score)&&(log.combo===null||COMBO_IDS.includes(log.combo)),'培育回合内容损坏');
      ensure(log.cards.every(id=>log.cards.filter(other=>other===id).length<=2),'同一种星灵最多出现两道投影');
      const hand=log.cards.map((defId,i)=>({key:'verify-'+i,defId,rank:deckByDef.get(defId)!.rank}));
      const replay:Run={...r,phase:'playing',turn:index+1,hand,talents:r.talents.slice(0,Math.floor(index/2)),logs:r.logs.slice(0,index)};
      const expected=preview(replay,hand.map(p=>p.key));
      ensure(expected.valid&&expected.score===log.score&&expected.combo===log.combo,'培育计分记录不一致');
      totalScore+=expected.score;
      totalGrowth.insight+=expected.growth.insight;totalGrowth.bond+=expected.growth.bond;totalGrowth.focus+=expected.growth.focus;
      ensure(log.combo===null||s.discoveries.includes(log.combo),'培育组合与图鉴不一致');
    });
    ensure(totalScore===r.score&&sameGrowth(totalGrowth,r.growth),'培育累计成果不一致');
    const recorded=s.results.find(result=>result.id===r.id);
    if(r.phase==='complete'){
      ensure(recorded&&s.results[0].id===r.id,'已完成培育缺少对应成果');
      const expected=makeResult(r,recorded.date);
      ensure(recorded.score===expected.score&&recorded.grade===expected.grade&&recorded.title===expected.title&&recorded.leader===expected.leader&&recorded.seed===expected.seed&&recorded.coins===expected.coins&&recorded.dust===expected.dust&&sameGrowth(recorded.growth,expected.growth)&&sameArray(recorded.talents,expected.talents)&&sameArray(recorded.combos,expected.combos),'完成态与培育成果不一致');
    }else{
      ensure(!recorded,'进行中的培育不能已领取成果');
      ensure(sameArray(s.lineup,r.deck.map(c=>c.defId)),'培育中的阵容已锁定');
      ensure(r.deck.every(c=>s.cards.some(ownedCard=>ownedCard.uid===c.uid&&ownedCard.defId===c.defId&&ownedCard.rank===c.rank&&ownedCard.best===c.best)),'培育中的星灵实例已被修改或移除');
      const serial=Number(r.id.slice(3));ensure(!serials.includes(serial),'培育实例编号冲突');serials.push(serial);
    }
    const runSerial=Number(r.id.slice(3));
    ensure(r.deck.every(c=>Number(c.uid.slice(1))<runSerial),'培育实例顺序损坏');
  }
  ensure(serials.every(serial=>serial<s.nextId),'后续实例编号与已有实例冲突');
  return s;
}

// ══════════════════════════════════════════════════════════════════════════
// v2 单星币经济（服务端权威 · 2026-10 规格）
// 规则来源 docs/CARD_PROGRESSION_ECONOMY_DESIGN.md；上面 v1 段是历史算分本地模式，
// 与服务端资产无关。局内金币（gold）见 server/match.mjs，与星币永不互通。
// ══════════════════════════════════════════════════════════════════════════
export type TransferPolicy='free'|'starter_restricted';
export type OriginKind='starter'|'draw'|'craft'|'forge'|'market'|'gift'|'legacy';
export interface OwnedCardV2 {
  uid:string; defId:string; rank:number; best:number;
  transferPolicy:TransferPolicy; originKind:OriginKind; originRef?:string; createdEconomyVersion:number;
}
export interface StarterState { version:number; status:'pending'|'claimed'|'legacy_granted'; favoriteDefId?:string; claimRef?:string }
export interface ForgeOutcomeV2 {
  defId:string; mainUid:string; from:number; to:number; branch:ForgeBranch;
  returnedUids:string[]; coins:number; restricted:boolean;
}
export type DrawCandidate={candidateId:string; defId:string; rank:number};
export interface DrawnCard { defId:string; rank:number }
export interface DrawSummary {
  mode:'choice_one'|'ten';
  cards:{uid?:string; defId:string; rank:number; restricted:boolean}[];
  orderId?:string; candidateId?:string;
}
export interface GameStateV2 {
  version:2; economyVersion:number;
  coins:number;                  // 唯一星币总额（不维护第二份可写余额）
  restrictedCoins:number;        // 总额内的受限子额度（新手赠送来源），0 ≤ restricted ≤ coins
  starter:StarterState;
  cards:OwnedCardV2[]; nextId:number; rng:number;
  frozen?:{dust:number;tickets:number};  // 旧多货币余额冻结待用户确认换算；任何消费路径都不读取
  lastForge?:ForgeOutcomeV2|null;
  lastDraw?:DrawSummary|null;
}
export const ECONOMY_VERSION=2;
export type PaymentMode='normal_only'|'allow_restricted';
export interface PaymentResult { coinsSpent:number; restrictedSpent:number; transferable:boolean }
export type SecureRandom=()=>number;

function ensureV2(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}
function wholeV2(value:unknown,label:string):number {ensureV2(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=1_000_000_000,label+'数据损坏');return value;}
export function newProfileState(seed=Date.now()>>>0):GameStateV2 {
  return {version:2,economyVersion:ECONOMY_VERSION,coins:0,restrictedCoins:0,starter:{version:1,status:'pending'},cards:[],nextId:1,rng:(seed>>>0)||42};
}
function cardDataV2(value:unknown):value is OwnedCardV2 {
  return record(value)&&instanceId(value.uid,'c')&&knownCard(value.defId)&&QUALITY_LEVELS.includes(value.rank as number)
    &&whole(value.best)&&['free','starter_restricted'].includes(value.transferPolicy as string)
    &&['starter','draw','craft','forge','market','gift','legacy'].includes(value.originKind as string)
    &&Number.isSafeInteger(value.createdEconomyVersion);
}
/** 档案读取器：v2 校验不变量后原样返回；v1 历史档案迁移为 v2（星币原额保留，星尘/券冻结待确认，旧卡全部视为可流通 legacy）。 */
export function migrateProfileState(raw:unknown):GameStateV2 {
  ensureV2(!!raw&&typeof raw==='object'&&!Array.isArray(raw),'玩家档案损坏');
  const source=raw as Record<string,unknown>;
  if(source.version===2){
    const migrated=source as unknown as GameStateV2;
    const cards=migrated.cards;
    wholeV2(migrated.coins,'星币');wholeV2(migrated.restrictedCoins,'受限星币');
    ensureV2(migrated.restrictedCoins<=migrated.coins,'受限子额度超过总额');
    ensureV2(Array.isArray(cards)&&cards.length<=MAX_CARDS&&cards.every(cardDataV2),'收藏数据损坏');
    ensureV2(new Set(cards.map(c=>c.uid)).size===cards.length,'收藏实例重复');
    ensureV2(Number.isSafeInteger(migrated.nextId)&&migrated.nextId>0,'实例计数损坏');
    ensureV2(['pending','claimed','legacy_granted'].includes(migrated.starter?.status),'礼包状态损坏');
    if(migrated.frozen){wholeV2(migrated.frozen.dust,'冻结星尘');wholeV2(migrated.frozen.tickets,'冻结券');}
    return migrated;
  }
  // v1（历史服务端档案）：run/results/lineup 在服务端恒为空，直接丢弃；余额与卡全量保留。
  const coins=wholeV2(source.coins,'星币');
  const cards=Array.isArray(source.cards)?source.cards:[];
  ensureV2(cards.length<=MAX_CARDS&&cards.every(cardData),'收藏数据损坏');
  return {
    version:2,economyVersion:ECONOMY_VERSION,coins,restrictedCoins:0,
    starter:{version:1,status:'legacy_granted'},
    cards:cards.map(c=>({uid:c.uid,defId:c.defId,rank:c.rank,best:c.best,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:1})),
    nextId:wholeV2(source.nextId,'实例计数')||1,rng:uint(source.rng)?(source.rng as number):42,
    frozen:{dust:wholeV2(source.dust,'星尘'),tickets:wholeV2(source.tickets,'券')},
  };
}

// ─── 钱包：唯一总额 + 受限子额度 ───────────────────────────────────────────
export function walletSpendable(s:GameStateV2):number {return s.coins-s.restrictedCoins;}
/** 扣款：normal_only 只动普通额度；allow_restricted 先普通后受限。产物可交易性由实际受限支出决定。 */
export function payCoins(s:GameStateV2,amount:number,mode:PaymentMode):PaymentResult {
  ensureV2(Number.isSafeInteger(amount)&&amount>0,'扣款金额不合法');
  if(mode==='normal_only')ensureV2(walletSpendable(s)>=amount,s.coins>=amount?'普通星币不足（赠送额度需显式允许才能使用）':'星币不足');
  else ensureV2(s.coins>=amount,'星币不足');
  const restrictedSpent=mode==='allow_restricted'?Math.max(0,amount-walletSpendable(s)):0;
  s.coins-=amount;s.restrictedCoins-=restrictedSpent;
  ensureV2(s.coins>=0&&s.restrictedCoins>=0&&s.restrictedCoins<=s.coins,'钱包不变量被破坏');
  return {coinsSpent:amount,restrictedSpent,transferable:restrictedSpent===0};
}
export function grantCoins(s:GameStateV2,amount:number,restricted:boolean):void {
  ensureV2(Number.isSafeInteger(amount)&&amount>0&&s.coins+amount<=1_000_000_000,'星币数量超出范围');
  s.coins+=amount;if(restricted)s.restrictedCoins+=amount;
  ensureV2(s.restrictedCoins<=s.coins,'钱包不变量被破坏');
}
/** 发卡统一容量校验：实际收藏 + 市场托管挂单 + 待选预留 + 本次新增不得超过上限。 */
export function capacityError(cardCount:number,escrowCount:number,pendingReserve:number,newCards:number):string|null {
  return cardCount+escrowCount+pendingReserve+newCards>MAX_CARDS?'收藏空间不足（含托管与待选预留），请先整理重复卡':null;
}
export function nextCardUid(s:GameStateV2):string {
  ensureV2(Number.isSafeInteger(s.nextId+1),'卡牌编号达到上限');
  return 'c'+s.nextId++;
}
function issueCard(s:GameStateV2,defId:string,rank:number,restricted:boolean,originKind:OriginKind,originRef:string):OwnedCardV2 {
  const card:OwnedCardV2={uid:nextCardUid(s),defId,rank,best:0,transferPolicy:restricted?'starter_restricted':'free',originKind,originRef,createdEconomyVersion:ECONOMY_VERSION};
  s.cards.push(card);return card;
}
export function ownedV2(s:GameStateV2,defId:string):OwnedCardV2[] {
  return s.cards.filter(c=>c.defId===defId).sort((a,b)=>b.rank-a.rank||b.best-a.best||a.uid.localeCompare(b.uid));
}

// ─── 抽卡：三选一候选 / 十连（纯随机生成；服务端用安全随机源调用，测试可注入）───
function weightedQuality(roll:number,weights:number[]):number {
  ensureV2(weights.length===QUALITY_MAX&&Math.abs(weights.reduce((sum,w)=>sum+w,0)-100)<1e-9,'品质权重不合法');
  let bound=0;
  for(let index=0;index<weights.length;index++){bound+=weights[index]/100;if(roll<bound)return index+1;}
  return weights.length;
}
/** 单抽：先抽共同品质，再无放回均匀取 3 个不同卡种；三候选同品质，最终品质分布保持递减。 */
export function rollChoiceCandidates(rand:SecureRandom):DrawCandidate[] {
  ensureV2(CARDS.length>=3,'卡池不足三种卡，无法创建三选一');
  const rank=weightedQuality(rand(),QUALITY.summonQuality);
  const pool=[...CARDS];
  for(let i=pool.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
  return pool.slice(0,3).map((def,index)=>({candidateId:'d'+(index+1),defId:def.id,rank}));
}
/** 十连：10 次独立抽取（卡种全池均匀有放回 + 独立品质），同名可重复，无保底。 */
export function rollTenDraw(rand:SecureRandom):DrawnCard[] {
  return Array.from({length:10},()=>({defId:CARDS[Math.floor(rand()*CARDS.length)].id,rank:weightedQuality(rand(),QUALITY.summonQuality)}));
}

// ─── 新手礼包：23 张 / ≥8 种（1 Q3 本命 + 4 Q2 支援 + 18 Q1 素材）+ 600 受限星币 ──
export interface StarterPack { cards:DrawnCard[]; coins:number; kinds:string[] }
/** 支援与素材按卡目录稳定顺序挑选（同本命结果恒定，不随预览重抽）；职业覆盖前排与远程输出。 */
export function buildStarterPack(favoriteDefId:string):StarterPack {
  ensureV2(knownCard(favoriteDefId),'未知星灵');
  const roleOf=(id:string)=>getCombatStats({uid:'starter',defId:id,rank:1,best:0}).role;
  const used=new Set<string>([favoriteDefId]);
  const pick=(predicate:(id:string)=>boolean):string=>{
    const found=CARDS.map(c=>c.id).find(id=>!used.has(id)&&predicate(id));
    ensureV2(found,'卡池无法满足新手礼包配置');
    used.add(found);return found;
  };
  const favorite=favoriteDefId;
  const supportB=pick(id=>['坦克','战士'].includes(roleOf(id)));
  const supportC=pick(id=>['射手','法师'].includes(roleOf(id)));
  const covered=new Set([roleOf(favorite),roleOf(supportB),roleOf(supportC)]);
  const supportD=pick(id=>!covered.has(roleOf(id)));
  covered.add(roleOf(supportD));
  const supportE=pick(id=>!covered.has(roleOf(id)));
  const materialF=pick(()=>true),materialG=pick(()=>true),materialH=pick(()=>true);
  const cards:DrawnCard[]=[
    {defId:favorite,rank:3},
    {defId:supportB,rank:2},{defId:supportC,rank:2},{defId:supportD,rank:2},{defId:supportE,rank:2},
    ...[favorite,supportB,supportC,materialF,materialG,materialH].flatMap(defId=>[{defId,rank:1},{defId,rank:1},{defId,rank:1}]),
  ];
  const kinds=[...new Set(cards.map(c=>c.defId))];
  ensureV2(cards.length===23&&kinds.length>=8,'新手礼包配置数量错误');
  ensureV2(cards.filter(c=>c.rank===3).length===1&&cards.filter(c=>c.rank===2).length===4&&cards.filter(c=>c.rank===1).length===18,'新手礼包品质构成错误');
  return {cards,coins:ECONOMY.starterCoins,kinds};
}
/** 领取新手礼包：pending → claimed，一次事务由服务端保证；全部产物为自用（受限）来源。 */
export function claimStarter(s:GameStateV2,favoriteDefId:string,claimRef:string):GameStateV2 {
  ensureV2(s.starter.status==='pending',s.starter.status==='claimed'?'新手礼包已领取过':'当前账号不能领取新手礼包');
  ensureV2(!capacityError(s.cards.length,0,0,23),'收藏空间不足，无法领取新手礼包');
  const pack=buildStarterPack(favoriteDefId);
  const next=structuredClone(s);
  for(const card of pack.cards)issueCard(next,card.defId,card.rank,true,'starter',claimRef);
  grantCoins(next,pack.coins,true);
  next.starter={version:1,status:'claimed',favoriteDefId,claimRef};
  return next;
}

// ─── 定向制作 / 回收（星币）───────────────────────────────────────────────
export function craftCardV2(s:GameStateV2,defId:string,paymentMode:PaymentMode,opRef:string):{state:GameStateV2;card:OwnedCardV2} {
  ensureV2(knownCard(defId),'未知星灵');
  ensureV2(s.cards.some(c=>c.defId===defId),'只能制作当前已拥有的卡种');
  ensureV2(!capacityError(s.cards.length,0,0,1),'收藏空间不足');
  const next=structuredClone(s);
  const payment=payCoins(next,ECONOMY.craftCost,paymentMode);
  const card=issueCard(next,defId,1,!payment.transferable,'craft',opRef);
  return {state:next,card};
}
/** 回收：逐张 uid 明确指定；仅多余 Q1（保留每卡种最后一张），返币按来源进入对应额度。 */
export function recycleCardsV2(s:GameStateV2,uids:string[]):{state:GameStateV2;coins:number;restrictedCoins:number;recycled:OwnedCardV2[]} {
  ensureV2(Array.isArray(uids)&&uids.length>0&&uids.length<=500,'回收列表不合法');
  ensureV2(new Set(uids).size===uids.length&&uids.every(uid=>typeof uid==='string'&&instanceId(uid,'c')),'回收实例编号不合法');
  const next=structuredClone(s);
  const targets=uids.map(uid=>{const card=next.cards.find(c=>c.uid===uid);ensureV2(card,'找不到要回收的卡牌：'+uid);return card;});
  const removed=new Set(targets.map(c=>c.uid));
  for(const defId of new Set(targets.map(c=>c.defId))){
    const remaining=next.cards.filter(c=>c.defId===defId&&!removed.has(c.uid));
    ensureV2(remaining.length>0,'必须保留每个卡种的最后一张：'+CARD_MAP[defId].name);
  }
  for(const card of targets)ensureV2(card.rank===1,'仅支持回收微光（Q1）品质的多余卡');
  next.cards=next.cards.filter(c=>!removed.has(c.uid));
  let coins=0,restricted=0;
  for(const card of targets){if(card.transferPolicy==='starter_restricted')restricted+=ECONOMY.recycleReturn;else coins+=ECONOMY.recycleReturn;}
  if(coins)grantCoins(next,coins,false);
  if(restricted)grantCoins(next,restricted,true);
  return {state:next,coins,restrictedCoins:restricted,recycled:targets};
}

// ─── 同名卡概率合成（v2：费用走星币钱包，结果保守继承来源限制）──────────────
export interface ForgeOptionsV2 { mainUid?:string; materialUids?:string[]; paymentMode?:PaymentMode; opRef?:string; random?:(state:{rng:number})=>number }
export function forgeCardV2(s:GameStateV2,defId:string,options:ForgeOptionsV2={}):{state:GameStateV2;result:ForgeOutcomeV2} {
  ensureV2(knownCard(defId),'未知星灵');
  const list=ownedV2(s,defId);ensureV2(list.length,'尚未拥有该星灵');
  const main=options.mainUid!==undefined?list.find(card=>card.uid===options.mainUid):list[0];
  ensureV2(main,'指定的主卡不存在');
  ensureV2(main.rank<QUALITY_MAX,`${qualityName(QUALITY_MAX)}已是最高品质，无法继续合成`);
  const sameQuality=list.filter(card=>card.uid!==main.uid&&card.rank===main.rank);
  let material:OwnedCardV2[];
  if(options.materialUids!==undefined){
    ensureV2(Array.isArray(options.materialUids)&&options.materialUids.length===QUALITY.forge.materials,`需要恰好 ${QUALITY.forge.materials} 张材料`);
    material=options.materialUids.map(uid=>{const found=sameQuality.find(card=>card.uid===uid);ensureV2(found,'材料必须是同品质的同名卡');return found;});
    ensureV2(new Set(material.map(card=>card.uid)).size===material.length,'材料不能重复');
  }else material=sameQuality.slice(0,QUALITY.forge.materials);
  ensureV2(material.length===QUALITY.forge.materials,`还需要 ${QUALITY.forge.materials-material.length} 张 ${qualityName(main.rank)} 品质的同名材料`);
  const next=structuredClone(s);
  const draw=options.random??((source:{rng:number})=>{let value:number;[value,source.rng]=random(source.rng);return value;});
  const payment=payCoins(next,QUALITY.forge.coins[main.rank-1],options.paymentMode??'allow_restricted');
  // 保守继承：任一受限投入（受限费用 / 受限主卡 / 受限材料）→ 成功结果不可交易；失败不改变主卡来源。
  const restricted=!payment.transferable||main.transferPolicy==='starter_restricted'||material.some(card=>card.transferPolicy==='starter_restricted');
  const fail=QUALITY.forge.fail[main.rank-1],twoUp=QUALITY.forge.upgradeTwo[main.rank-1];
  const roll=draw(next)*100;
  let branch:ForgeBranch,to=main.rank;
  if(roll<fail)branch='fail';
  else if(main.rank+2<=QUALITY_MAX&&roll<fail+twoUp){branch='upgrade_two';to=main.rank+2;}
  else{branch='upgrade_one';to=Math.min(main.rank+1,QUALITY_MAX);}
  let returnedUids:string[]=[];
  if(branch==='fail'){
    // 失败：主卡原样保留（uid/品质/来源都不变）；材料按公示概率返 1～2 张，原 uid 原来源，其余消失。
    const returnCount=draw(next)*100<QUALITY.forge.failReturnOne?1:material.length;
    const shuffled=[...material];
    for(let index=shuffled.length-1;index>0;index--){const swap=Math.floor(draw(next)*(index+1));[shuffled[index],shuffled[swap]]=[shuffled[swap],shuffled[index]];}
    const kept=shuffled.slice(0,returnCount);
    const removedIds=new Set(shuffled.slice(returnCount).map(card=>card.uid));
    next.cards=next.cards.filter(card=>!removedIds.has(card.uid));
    returnedUids=kept.map(card=>card.uid);
  }else{
    const upgraded=next.cards.find(card=>card.uid===main.uid)!;
    upgraded.rank=to;upgraded.transferPolicy=restricted?'starter_restricted':'free';
    upgraded.originKind='forge';upgraded.originRef=options.opRef;
    const removedIds=new Set(material.map(card=>card.uid));
    next.cards=next.cards.filter(card=>!removedIds.has(card.uid));
  }
  const result:ForgeOutcomeV2={defId,mainUid:main.uid,from:main.rank,to:branch==='fail'?main.rank:to,branch,returnedUids,coins:payment.coinsSpent,restricted:branch!=='fail'&&restricted};
  next.lastForge=result;
  return {state:next,result};
}
export {forgeOdds as forgeOddsV2};
