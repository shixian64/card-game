import { CARDS, CARD_MAP, COMBOS, TALENTS, CONDITIONS, ECONOMY } from './data.ts';
import type { Rarity } from './data.ts';
export interface OwnedCard { uid:string; defId:string; rank:number; best:number }
export interface Projection { key:string; defId:string; rank:number }
export interface Growth { insight:number; bond:number; focus:number }
export interface ScoreLine { label:string; value:number }
export interface Preview { score:number; cost:number; budget:number; combo:string|null; lines:ScoreLine[]; growth:Growth; valid:boolean; reason:string }
export interface TurnLog { turn:number; cards:string[]; score:number; combo:string|null; condition:string }
export interface Run {
  id:string; seed:number; rng:number; turn:number; deck:OwnedCard[]; hand:Projection[]; score:number;
  growth:Growth; talents:string[]; offers:string[]; conditions:string[];
  phase:'playing'|'talent'|'complete'; redraws:number; logs:TurnLog[];
}
export interface Result { id:string; score:number; grade:string; title:string; growth:Growth; leader:string; talents:string[]; combos:string[]; date:string; coins:number; dust:number; seed:number }
export interface GameState {
  version:1; coins:number; dust:number; tickets:number; rng:number; nextId:number;
  cards:OwnedCard[]; lineup:string[]; results:Result[]; discoveries:string[]; run:Run|null; lastSummon:string[];
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
export function strengthen(state:GameState,defId:string):GameState {
  card(defId); const list=owned(state,defId); const main=list[0];
  ensure(main,'尚未拥有该星灵'); ensure(main.rank<3,'已达到最高突破阶位');
  ensure(!state.run||state.run.phase==='complete'||!state.run.deck.some(c=>c.uid===main.uid),'该星灵正在培育，请先完成本次培育');
  const needed=main.rank+1; const coins=main.rank*90; const active=activeCardIds(state);
  const material=list.filter(c=>c.uid!==main.uid&&c.rank===1&&!active.has(c.uid)).slice(0,needed);
  ensure(material.length===needed,`需要 ${needed} 张未强化的同名重复卡`); ensure(state.coins>=coins,'星币不足');
  const next=clone(state);const ids=new Set(material.map(c=>c.uid));
  next.cards=next.cards.filter(c=>!ids.has(c.uid)); next.cards.find(c=>c.uid===main.uid)!.rank++;
  next.coins-=coins;return next;
}
export function recycle(state:GameState,defId:string,amount=1):GameState {
  card(defId);ensure(Number.isInteger(amount)&&amount>0,'分解数量不合法');
  const list=owned(state,defId); const active=activeCardIds(state);
  const extras=list.slice(1).filter(c=>c.rank===1&&!active.has(c.uid));
  ensure(extras.length>=amount,'保留最后一张及已强化、培育中的星灵，仅可分解多余卡');
  const ids=new Set(extras.slice(0,amount).map(c=>c.uid));const next=clone(state);
  next.cards=next.cards.filter(c=>!ids.has(c.uid)); next.dust+=ECONOMY.recycle[CARD_MAP[defId].rarity]*amount;safeBalance(next.dust);return next;
}
export function craft(state:GameState,defId:string):GameState {
  const d=card(defId);ensure(state.cards.length<MAX_CARDS,'收藏已达 10000 张上限，请先整理重复卡');availableIds(state,1);
  const cost=ECONOMY.craft[d.rarity];ensure(state.dust>=cost,'星尘不足，试试分解重复卡或完成培育');
  const next=clone(state);next.dust-=cost;next.cards.push({uid:'c'+next.nextId++,defId,rank:1,best:0});return next;
}
export function summon(state:GameState):GameState {
  ensure(state.cards.length+3<=MAX_CARDS,'收藏空间不足，请先整理重复卡');availableIds(state,3);
  ensure(state.tickets>0||state.coins>=ECONOMY.packCost,'观星券和星币不足');
  const next=clone(state); if(next.tickets>0)next.tickets--;else next.coins-=ECONOMY.packCost;
  const drawn:string[]=[];
  for(let i=0;i<3;i++){
    let roll:number; [roll,next.rng]=random(next.rng);
    let rarity:Rarity=roll<0.1?'SSR':roll<0.4?'SR':'R';
    if(i===2&&drawn.every(id=>CARD_MAP[id].rarity==='R')&&rarity==='R')rarity='SR';
    const pool=CARDS.filter(c=>c.rarity===rarity);[roll,next.rng]=random(next.rng);
    const defId=pool[Math.floor(roll*pool.length)].id;drawn.push(defId);
    next.cards.push({uid:'c'+next.nextId++,defId,rank:1,best:0});
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
  if(defs.length)lines.push({label:'星灵基础共鸣',value:projections.reduce((sum,c)=>sum+CARD_MAP[c.defId].base+(c.rank-1)*2+(run.talents.includes('growth')?3:0),0)});
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
    if(value)lines.push({label:d.traitName,value});
  });
  const condition=CONDITIONS.find(c=>c.id===run.conditions[run.turn-1])!;
  let bonus=0;
  if(condition.affinity)bonus=a.filter(x=>x===condition.affinity).length*4;
  if(condition.id==='quiet')bonus=Math.max(0,budget-cost)*3;
  if(condition.id==='trio'&&combo==='trio')bonus=10;
  if(condition.id==='mirror'&&combo==='mirror')bonus=12;
  if(bonus&&defs.length)lines.push({label:condition.name,value:bonus});
  if(run.talents.includes('harmony')&&combo==='mono')lines.push({label:'纯粹之心',value:18});
  if(run.talents.includes('echo')&&combo==='mirror')lines.push({label:'回声之环',value:16});
  if(run.talents.includes('focus')&&budget>cost&&defs.length)lines.push({label:'留白之美',value:(budget-cost)*4});
  const subtotal=lines.reduce((sum,l)=>sum+l.value,0);
  if(run.talents.includes('prism')&&combo==='trio')lines.push({label:'三色棱镜 ×1.3',value:Math.round(subtotal*.3)});
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
  return record(value)&&instanceId(value.uid,'c')&&knownCard(value.defId)&&[1,2,3].includes(value.rank as number)&&whole(value.best);
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
  ensure(Array.isArray(s.lastSummon)&&(s.lastSummon.length===0||s.lastSummon.length===3)&&s.lastSummon.every(knownCard),'观星记录损坏');
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
