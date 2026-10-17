import { CARDS, CARD_MAP, QUALITY, QUALITY_MAX } from './data.ts';
import type { Affinity } from './data.ts';
import type { OwnedCard } from './engine.ts';
import { hexDistance, slotToCell, neighbors as hexNeighbors, boardCells, HEX_COLS } from './hex.ts';

export type BattleCard = OwnedCard & {stars?:1|2|3};
export type CombatRole = '坦克'|'战士'|'射手'|'法师'|'刺客';
export type CombatEffect = 'slash'|'projectile'|'blast'|'shield'|'dash';
export interface CombatUnit {
  id:string;cardUid:string;defId:string;name:string;affinity:Affinity;art:string;rank:number;stars:1|2|3;
  role:CombatRole;maxHp:number;hp:number;attack:number;shield:number;cooldown:number;
  skillName:string;skillDescription:string;skillPower:number;skillSecondary:number;slot:number;energy:number;speed:number;
  row:number;col:number;range:number;armor:number;resistance:number;effect:CombatEffect;
}
export interface BattleLog {
  id:number;round:number;side:'player'|'enemy'|'system';
  kind:'attack'|'skill'|'heal'|'shield'|'defeat'|'round'|'result'|'move';text:string;
  actorId?:string;targetId?:string;amount?:number;damageType?:'physical'|'magic';movement?:'walk'|'blink';
}
export interface Synergy {id:string;name:string;count:number;threshold:number;active:boolean;description:string}
export interface BattleFrame {tick:number;round:number;player:CombatUnit[];enemy:CombatUnit[];logs:BattleLog[]}
export interface BattleState {
  version:2|3;id:string;status:'playing'|'won'|'lost';round:number;maxRounds:number;
  player:CombatUnit[];enemy:CombatUnit[];logs:BattleLog[];seed:number;rng:number;revision:number;
  reason?:'elimination'|'round-limit';frames:BattleFrame[];outcome:'won'|'lost';
  synergies:{player:Synergy[];enemy:Synergy[]};
}
export type BattleAction = {type:'resolve'};
export interface BattleOptions {enemyCount?:number;enemyRank?:number;enemyTeam?:BattleCard[]}
interface RoleDef {role:CombatRole;hp:number;attack:number;speed:number;range:number;armor:number;resistance:number;effect:CombatEffect}
export interface CombatStats extends RoleDef {skillName:string;skillDescription:string;skillPower:number;skillSecondary:number}
export interface CardCombatDef {skillName:string;power:number;secondary:number;range?:number;armor?:number;resistance?:number}
const ROLES:Record<string,RoleDef> = {
  'moon-deer':{role:'坦克',hp:180,attack:14,armor:45,resistance:35,range:1,speed:40,effect:'shield'},
  'forest-rabbit':{role:'战士',hp:145,attack:23,armor:28,resistance:20,range:1,speed:55,effect:'slash'},
  'sun-cub':{role:'射手',hp:100,attack:24,armor:12,resistance:15,range:4,speed:78,effect:'projectile'},
  'sun-fox':{role:'法师',hp:95,attack:22,armor:12,resistance:25,range:3,speed:50,effect:'blast'},
  'forest-sprout':{role:'法师',hp:95,attack:22,armor:12,resistance:25,range:3,speed:50,effect:'blast'},
  'moon-fawn':{role:'刺客',hp:105,attack:28,armor:15,resistance:15,range:1,speed:90,effect:'dash'},
};
// Unique names and small coefficient / range / defense variants; rarity itself adds no multiplier.
const CARD_COMBAT:Record<string,CardCombatDef> = {
  'moon-deer':{skillName:'月纱护阵',power:.195,secondary:0},
  'sun-fox':{skillName:'烛羽焰潮',power:1.30,secondary:.55},
  'forest-rabbit':{skillName:'苔冠横扫',power:1.35,secondary:.65},
  'moon-fawn':{skillName:'银角突袭',power:1.80,secondary:0},
  'sun-cub':{skillName:'晨光双矢',power:.85,secondary:0},
  'forest-sprout':{skillName:'林间爆芽',power:1.20,secondary:.65},
  'star-deer':{skillName:'星河帷幕',power:.1885,secondary:0,resistance:39},
  'golden-fox':{skillName:'金焰爆破',power:1.45,secondary:.45,range:2,armor:14},
  'verdant-rabbit':{skillName:'翡翠旋斩',power:1.25,secondary:.80,resistance:23},
  'mist-deer':{skillName:'薄雾追影',power:1.85,secondary:0,armor:13,resistance:18},
  'dawn-fox':{skillName:'曙色追猎',power:.95,secondary:0,range:3,armor:14},
  'breeze-sprout':{skillName:'风铃震波',power:1.15,secondary:.55,range:4},
  'lunar-guide':{skillName:'雾灯掠影',power:1.75,secondary:0,resistance:20},
  'silver-gap':{skillName:'霜叶瞬斩',power:1.95,secondary:0,armor:12},
  'crescent-dancer':{skillName:'弦月护身',power:.182,secondary:0,armor:49,resistance:32},
  'frost-return':{skillName:'霜桥回刃',power:1.80,secondary:0,armor:18,resistance:13},
  'moon-soloist':{skillName:'静夜铁壁',power:.221,secondary:0,armor:42},
  'eclipse-deer':{skillName:'月蚀长壁',power:.2015,secondary:0,resistance:33},
  'starlit-arch':{skillName:'群星坚守',power:.1885,secondary:0,armor:47,resistance:38},
  'comet-tail':{skillName:'彗尾折光',power:.195,secondary:0,armor:43,resistance:40},
  'amber-pause':{skillName:'琥珀穿光',power:.80,secondary:0,resistance:20},
  'sun-first':{skillName:'旭日连星',power:.90,secondary:0,range:3,armor:16},
  'sun-center':{skillName:'日环涟漪',power:1.15,secondary:.70},
  'sundial-memory':{skillName:'日晷回射',power:.82,secondary:0,armor:15,resistance:17},
  'sun-change':{skillName:'彩霞扩散',power:1.20,secondary:.70,range:2,armor:16},
  'solar-prism':{skillName:'曜石虹爆',power:1.10,secondary:.80,resistance:28},
  'gold-mirror':{skillName:'金镜灼流',power:1.35,secondary:.45,armor:15},
  'solstice-alone':{skillName:'至日聚焦',power:1.70,secondary:.20,range:2},
  'fern-opener':{skillName:'蕨叶穿刺',power:1.35,secondary:.60,range:2,armor:15},
  'moss-tide':{skillName:'苔溪涌动',power:1.20,secondary:.70,resistance:29},
  'twig-change':{skillName:'新枝裂空',power:1.10,secondary:.60,range:4},
  'clover-step':{skillName:'三叶长锋',power:1.20,secondary:.65,range:2,armor:25},
  'seed-center':{skillName:'种子爆裂',power:1.25,secondary:.75,range:2},
  'canopy-coda':{skillName:'树冠重斩',power:1.65,secondary:.35,armor:25},
  'emerald-mirror':{skillName:'翠镜回锋',power:1.15,secondary:.80,range:2,armor:30},
  'bough-embrace':{skillName:'连枝环斩',power:1.25,secondary:.75,armor:31},
};
// 基础职业表与卡种技能变体：duel-sim 复用同一份配置计算双人局属性（倍率另传），
// 只读不改；旧局行为完全不受影响。
export const ROLE_BASE_STATS: Readonly<Record<string,RoleDef>> = ROLES;
export const CARD_COMBAT_DEFS: Readonly<Record<string,CardCombatDef>> = CARD_COMBAT;
export const DEFAULT_BATTLE_SLOTS:ReadonlyArray<number> = Object.freeze([1,3,5,22,24,26]);
const ROLE_IDS:Record<CombatRole,string> = {坦克:'tank',战士:'warrior',射手:'marksman',法师:'mage',刺客:'assassin'};
// 星契的羁绊强化需要稳定的 id 映射；导出只读别名，避免 UI / 战斗 / 星契各写一份。
export const ROLE_SYNERGY_IDS:Readonly<Record<CombatRole,string>> = ROLE_IDS;
const ROLE_TEXT:Record<CombatRole,string> = {坦克:'坦克最大生命 +8%。',战士:'战士攻击 +12%。',射手:'射手每次普攻额外获得 10 能量。',法师:'法师技能伤害 +15%。',刺客:'刺客技能伤害 +15%。'};
const AFFINITY_TEXT:Record<Affinity,[string,string]> = {
  moon:['月系开场获得最大生命 12% 的护盾。','月系开场获得最大生命 25% 的护盾，替代 2 月效果。'],
  sun:['日系攻击 +8%。','日系攻击 +18%，替代 2 日效果。'],
  forest:['森系最大生命 +10%。','森系最大生命 +22%，替代 2 森效果。'],
};
const AFFINITY_NAMES:Record<Affinity,string> = {moon:'月',sun:'日',forest:'森'};
function ensure(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}
function checkCard(card:BattleCard):void {
  ensure(card&&typeof card.uid==='string'&&card.uid.length>0&&card.uid.length<=128,'卡牌实例不合法');
  ensure(typeof card.defId==='string'&&Object.hasOwn(CARD_MAP,card.defId)&&Object.hasOwn(CARD_COMBAT,card.defId),'未知战斗卡牌');
  ensure(Number.isInteger(card.rank)&&card.rank>=1&&card.rank<=QUALITY_MAX,'永久品质不合法');
  ensure(card.stars===undefined||[1,2,3].includes(card.stars),'局内星级不合法');
}
function decimal(value:number):number {return Math.round(value*10)/10;}
function qualitySkill(base:number,rank:number):number {return Number((base*(1+(rank-1)*QUALITY.growth.skill/100)).toFixed(4));}
function skillText(role:CombatRole,_card:CardCombatDef,power:number,secondary:number):string {
  const main=Number((power*100).toFixed(2)),extra=Number((secondary*100).toFixed(2));
  if(role==='坦克')return '获得最大生命 '+main+'% 的护盾；有盾时优先吸引 2 格内敌人。';
  if(role==='战士')return '目标受到 '+main+'% 物理伤害，身旁 1 格其他敌人受到 '+extra+'% 物理伤害。';
  if(role==='射手')return '连射两次，每次 '+main+'% 物理伤害；后排部署可狙击后排，仍需进入射程。';
  if(role==='法师')return '目标受到 '+main+'% 法术伤害，目标周围 1 格敌人受到 '+extra+'% 法术伤害。';
  return '开场突入后排空格；技能造成 '+main+'% 单体物理伤害。';
}
export function getCombatStats(card:BattleCard):CombatStats {
  checkCard(card);const base=ROLES[CARD_MAP[card.defId].art],variant=CARD_COMBAT[card.defId],stars=card.stars??1,quality=card.rank;
  ensure(base,'该卡牌尚未配置战斗职业');
  const skillPower=qualitySkill(variant.power,quality),skillSecondary=qualitySkill(variant.secondary,quality);
  return {...base,hp:Math.round(base.hp*(1+(quality-1)*QUALITY.growth.hp/100)*(1+(stars-1)*.12)),attack:decimal(base.attack*(1+(quality-1)*QUALITY.growth.attack/100)*(1+(stars-1)*.08)),
    skillPower,skillSecondary,skillName:variant.skillName,skillDescription:skillText(base.role,variant,skillPower,skillSecondary),range:variant.range??base.range,armor:variant.armor??base.armor,resistance:variant.resistance??base.resistance};
}
/** Distinct definitions, not repeated copies, activate bonds. maxUnits 供双人局「第六席」放宽到 7，旧局默认 6。 */
export function getSynergies(team:BattleCard[],maxUnits=6):Synergy[] {
  ensure(Array.isArray(team)&&team.length<=maxUnits,'阵容最多 '+maxUnits+' 张卡牌');for(const card of team)checkCard(card);
  const distinct=[...new Map(team.map(card=>[card.defId,card])).values()],result:Synergy[]=[];
  for(const affinity of ['moon','sun','forest'] as const){
    const count=distinct.filter(card=>CARD_MAP[card.defId].affinity===affinity).length;
    for(const [index,threshold] of [2,4].entries())result.push({id:'affinity-'+affinity+'-'+threshold,name:threshold+' '+AFFINITY_NAMES[affinity],count,threshold,active:count>=threshold,description:AFFINITY_TEXT[affinity][index]});
  }
  for(const role of Object.keys(ROLE_IDS) as CombatRole[]){
    const count=distinct.filter(card=>getCombatStats(card).role===role).length;
    result.push({id:'role-'+ROLE_IDS[role],name:'双'+role,count,threshold:2,active:count>=2,description:ROLE_TEXT[role]});
  }
  return result;
}
function active(synergies:Synergy[],id:string):boolean {return synergies.some(s=>s.id===id&&s.active);}
function roleBond(synergies:Synergy[],role:CombatRole):boolean {return active(synergies,'role-'+ROLE_IDS[role]);}
type Side = 'player'|'enemy';
function unit(card:BattleCard,id:string,slot:number,side:Side,synergies:Synergy[]):CombatUnit {
  const stats=getCombatStats(card),def=CARD_MAP[card.defId];let hp=stats.hp,attack=stats.attack;
  if(def.affinity==='forest')hp=Math.round(hp*(active(synergies,'affinity-forest-4')?1.22:active(synergies,'affinity-forest-2')?1.1:1));
  if(stats.role==='坦克'&&roleBond(synergies,'坦克'))hp=Math.round(hp*1.08);
  if(def.affinity==='sun')attack=decimal(attack*(active(synergies,'affinity-sun-4')?1.18:active(synergies,'affinity-sun-2')?1.08:1));
  if(stats.role==='战士'&&roleBond(synergies,'战士'))attack=decimal(attack*1.12);
  const shield=def.affinity==='moon'?Math.round(hp*(active(synergies,'affinity-moon-4')?.25:active(synergies,'affinity-moon-2')?.12:0)):0;
  const cell=slotToCell(slot,side);
  return {id,cardUid:card.uid,defId:card.defId,name:def.name,affinity:def.affinity,art:def.art,rank:card.rank,stars:card.stars??1,...stats,hp,maxHp:hp,attack,shield,cooldown:0,slot,energy:30,
    row:cell.row,col:cell.col};
}
function random(state:{rng:number}):number {
  let x=state.rng||0x9e3779b9;x^=x<<13;x^=x>>>17;x^=x<<5;state.rng=x>>>0;return state.rng/4294967296;
}
function fingerprint(value:string):string {
  let hash=2166136261;for(const ch of value){hash^=ch.charCodeAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0).toString(36);
}
function alive(units:CombatUnit[]):CombatUnit[] {return units.filter(u=>u.hp>0);}
/** 六边形步数距离（相邻为 1）；保留 combatDistance 名称供既有调用与测试使用。 */
export function combatDistance(a:{row:number;col:number},b:{row:number;col:number}):number {return hexDistance(a,b);}
export function affinityMultiplier(attacker:Affinity,defender:Affinity):number {
  if(attacker===defender)return 1;return {moon:'sun',sun:'forest',forest:'moon'}[attacker]===defender?1.25:.85;
}
/** Round 17 begins overtime; modifiers are additive against the ordinary base values. */
export function getOvertimeModifiers(round:number):{damage:number;shield:number} {
  ensure(Number.isSafeInteger(round)&&round>=1,'战斗轮数不合法');
  const steps=Math.max(0,round-16);
  return {damage:Number((1+steps*.08).toFixed(4)),shield:Number(Math.max(.2,1-steps*.05).toFixed(4))};
}
function targetFor(actor:CombatUnit,enemies:CombatUnit[],snipe=false,bypassTank=false):CombatUnit {
  let live=alive(enemies);
  if(snipe&&live.some(u=>u.slot>=14))live=live.filter(u=>u.slot>=14);
  else if(!bypassTank){
    const tanks=live.filter(u=>u.role==='坦克'&&u.shield>0&&combatDistance(actor,u)<=2);if(tanks.length)live=tanks;
  }
  return [...live].sort((a,b)=>combatDistance(actor,a)-combatDistance(actor,b)||Math.floor(a.slot/7)-Math.floor(b.slot/7)||a.hp/a.maxHp-b.hp/b.maxHp||a.slot-b.slot)[0];
}
interface Simulation {player:CombatUnit[];enemy:CombatUnit[];round:number;logs:BattleLog[];nextLog:number;synergies:{player:Synergy[];enemy:Synergy[]}}
function log(state:Simulation,entry:Omit<BattleLog,'id'|'round'>):void {state.logs.push({id:state.nextLog++,round:state.round,...entry});}
function hit(state:Simulation,actor:CombatUnit,target:CombatUnit,power:number,side:Side,damageType:'physical'|'magic'):void {
  const advantage=affinityMultiplier(actor.affinity,target.affinity),defense=damageType==='physical'?target.armor:target.resistance;
  const damage=Math.max(1,Math.round(actor.attack*power*advantage*100/(100+defense)*getOvertimeModifiers(state.round).damage));
  const blocked=Math.min(target.shield,damage),loss=Math.min(target.hp,damage-blocked);
  target.shield-=blocked;target.hp-=loss;if(loss>0)target.energy=Math.min(100,target.energy+10);
  log(state,{side,kind:'attack',actorId:actor.id,targetId:target.id,amount:loss,damageType,text:actor.name+' → '+target.name+'：'+(damageType==='physical'?'物理':'法术')+' '+(blocked?'护盾 −'+blocked+'，':'')+'生命 −'+loss+(advantage>1?'（克制）':'')});
  if(target.hp===0){target.shield=0;log(state,{side,kind:'defeat',actorId:actor.id,targetId:target.id,text:target.name+' 已退场。'});}
}
function skill(state:Simulation,actor:CombatUnit,enemies:CombatUnit[],side:Side,target:CombatUnit):void {
  actor.energy=0;
  log(state,{side,kind:'skill',actorId:actor.id,text:actor.name+' 使用「'+actor.skillName+'」。'});
  if(actor.role==='坦克'){
    const gained=Math.min(actor.maxHp-actor.shield,Math.round(actor.maxHp*actor.skillPower*getOvertimeModifiers(state.round).shield));actor.shield+=gained;
    log(state,{side,kind:'shield',actorId:actor.id,targetId:actor.id,amount:gained,text:actor.name+' 获得 '+gained+' 护盾，吸引附近敌人。'});
  }else if(actor.role==='法师'){
    const factor=roleBond(state.synergies[side],'法师')?1.15:1,adjacent=alive(enemies).filter(u=>u.id!==target.id&&combatDistance(target,u)<=1);
    hit(state,actor,target,actor.skillPower*factor,side,'magic');
    for(const other of adjacent)hit(state,actor,other,actor.skillSecondary*factor,side,'magic');
  }else if(actor.role==='射手'){
    hit(state,actor,target,actor.skillPower,side,'physical');if(target.hp>0)hit(state,actor,target,actor.skillPower,side,'physical');
  }else if(actor.role==='战士'){
    const adjacent=alive(enemies).filter(u=>u.id!==target.id&&combatDistance(actor,u)<=1);
    hit(state,actor,target,actor.skillPower,side,'physical');
    for(const other of adjacent)hit(state,actor,other,actor.skillSecondary,side,'physical');
  }else hit(state,actor,target,actor.skillPower*(roleBond(state.synergies[side],'刺客')?1.15:1),side,'physical');
}
/** Assassins blink once, on their first action, into an empty cell near the opposing rear. */
function openingBlink(state:Simulation,actor:CombatUnit,enemies:CombatUnit[],side:Side):void {
  const live=alive(enemies),rear=[...live].sort((a,b)=>(side==='player'?a.row-b.row:b.row-a.row)||a.slot-b.slot)[0];
  const occupied=new Set([...alive(state.player),...alive(state.enemy)].filter(u=>u.id!==actor.id).map(u=>u.row*HEX_COLS+u.col));
  const cells=boardCells()
    .filter(cell=>!occupied.has(cell.row*HEX_COLS+cell.col))
    .sort((a,b)=>combatDistance(a,rear)-combatDistance(b,rear)||(side==='player'?a.row-b.row:b.row-a.row)||Math.abs(a.col-actor.col)-Math.abs(b.col-actor.col)||a.col-b.col);
  const destination=cells[0],distance=combatDistance(actor,destination);
  if(distance===0)return;actor.row=destination.row;actor.col=destination.col;
  log(state,{side,kind:'move',movement:'blink',actorId:actor.id,targetId:rear.id,amount:distance,text:actor.name+' 突入敌方后排。'});
}
/** A shortest collision-free path ends in real attack range; walking advances only one cell. */
function moveToward(state:Simulation,actor:CombatUnit,target:CombatUnit,side:Side):void {
  const occupied=new Set([...alive(state.player),...alive(state.enemy)].filter(u=>u.id!==actor.id).map(u=>u.row*HEX_COLS+u.col));
  const start=actor.row*HEX_COLS+actor.col,seen=new Set([start]),queue=[{row:actor.row,col:actor.col,first:-1}];
  let destination:{row:number;col:number}|undefined;
  for(let index=0;index<queue.length;index++){
    const current=queue[index];
    if(current.first!==-1&&combatDistance(current,target)<=actor.range){destination={row:Math.floor(current.first/HEX_COLS),col:current.first%HEX_COLS};break;}
    // 平局规则与阵营无关（先按到目标距离，再按到目标列的横向距离，最后按列号），
    // 避免绝对行号偏好给某一方系统性寻路优势。
    const steps=hexNeighbors(current)
      .sort((a,b)=>combatDistance(a,target)-combatDistance(b,target)||Math.abs(a.col-target.col)-Math.abs(b.col-target.col)||a.col-b.col);
    for(const next of steps){
      const key=next.row*HEX_COLS+next.col;if(seen.has(key)||occupied.has(key))continue;
      seen.add(key);queue.push({...next,first:current.first===-1?key:current.first});
    }
  }
  if(destination){
    actor.row=destination.row;actor.col=destination.col;
    log(state,{side,kind:'move',movement:'walk',actorId:actor.id,targetId:target.id,amount:1,text:actor.name+' 移动 1 格，接近 '+target.name+'。'});
  }else log(state,{side,kind:'move',movement:'walk',actorId:actor.id,targetId:target.id,amount:0,text:actor.name+' 前路被占据，等待空位。'});
}
function ratio(units:CombatUnit[]):number {return units.reduce((sum,u)=>sum+u.hp,0)/units.reduce((sum,u)=>sum+u.maxHp,0);}
function simulate(opening:BattleState):{frames:BattleFrame[];outcome:'won'|'lost';reason:'elimination'|'round-limit'} {
  const state:Simulation={player:structuredClone(opening.player),enemy:structuredClone(opening.enemy),round:1,logs:[],nextLog:2,synergies:opening.synergies};
  const frames:BattleFrame[]=[],jumped=new Set<string>();let outcome:'won'|'lost'='lost',reason:'elimination'|'round-limit'='round-limit';
  for(let round=1;round<=opening.maxRounds;round++){
    state.round=round;const preferred:Side=(opening.seed+round)%2===0?'player':'enemy';
    const order=[...alive(state.player).map(u=>({unit:u,side:'player' as Side})),...alive(state.enemy).map(u=>({unit:u,side:'enemy' as Side}))]
      .sort((a,b)=>b.unit.speed-a.unit.speed||a.unit.slot-b.unit.slot||(a.side===b.side?0:a.side===preferred?-1:1));
    let first=true;
    for(let index=0;index<order.length;index++){
      const {unit:actor,side}=order[index];if(actor.hp<=0)continue;state.logs=[];
      if(first){
        log(state,{side:'system',kind:'round',text:'第 '+round+' 轮：按速度与站位自动行动。'});
        if(round>=17){const modifiers=getOvertimeModifiers(round);log(state,{side:'system',kind:'round',text:'决战：伤害 +'+Math.round((modifiers.damage-1)*100)+'%，新护盾 −'+Math.round((1-modifiers.shield)*100)+'%。'});}
        first=false;
      }
      const enemies=state[side==='player'?'enemy':'player'];
      if(actor.role==='刺客'&&!jumped.has(actor.id)){openingBlink(state,actor,enemies,side);jumped.add(actor.id);}
      const ready=actor.energy===100,target=targetFor(actor,enemies,ready&&actor.role==='射手'&&actor.slot>=14,ready&&actor.role==='刺客');
      if(ready&&actor.role==='坦克')skill(state,actor,enemies,side,target);
      else if(combatDistance(actor,target)>actor.range)moveToward(state,actor,target,side);
      else if(ready)skill(state,actor,enemies,side,target);
      else{
        hit(state,actor,target,1,side,'physical');actor.energy=Math.min(100,actor.energy+35+(actor.role==='射手'&&roleBond(state.synergies[side],'射手')?10:0));
      }
      const eliminated=!alive(state.player).length||!alive(state.enemy).length;
      const lastAction=!order.slice(index+1).some(entry=>entry.unit.hp>0),limited=round===opening.maxRounds&&lastAction;
      if(eliminated||limited){
        reason=eliminated?'elimination':'round-limit';
        outcome=eliminated?(alive(state.player).length?'won':'lost'):(ratio(state.player)>ratio(state.enemy)?'won':'lost');
        log(state,{side:'system',kind:'result',text:eliminated?(outcome==='won'?'胜利！敌方全部退场。':'本场战败，我方全部退场。'):opening.maxRounds+' 轮结束，剩余生命：我方 '+Math.round(ratio(state.player)*100)+'%，对方 '+Math.round(ratio(state.enemy)*100)+'%。'+(outcome==='won'?'我方获胜。':'守方获胜（同值由守方获胜）。')});
      }
      frames.push({tick:frames.length+1,round,player:structuredClone(state.player),enemy:structuredClone(state.enemy),logs:structuredClone(state.logs)});
      if(eliminated||limited)return {frames,outcome,reason};
    }
  }
  return {frames,outcome,reason};
}
/** 1–6 instances on a 4×7 deployment board; duplicate definitions are allowed but never duplicate uids. */
export function createBattle(team:BattleCard[],seed:number,slots?:readonly number[],options:BattleOptions={}):BattleState {
  ensure(Array.isArray(team)&&team.length>=1&&team.length<=6,'请选择 1–6 张卡牌出战');for(const card of team)checkCard(card);
  ensure(new Set(team.map(c=>c.uid)).size===team.length,'同一卡牌实例不能重复上阵');
  ensure(Number.isInteger(seed)&&seed>=0&&seed<=0xffffffff,'战斗种子不合法');
  ensure(options&&typeof options==='object'&&!Array.isArray(options)&&Object.keys(options).every(key=>key==='enemyCount'||key==='enemyRank'||key==='enemyTeam'),'对手配置不合法');
  const enemyCount=options.enemyCount===undefined?team.length:options.enemyCount;
  ensure(Number.isInteger(enemyCount)&&enemyCount>=1&&enemyCount<=6,'敌方人数必须为 1–6');
  // enemyRank / enemyTeam 仅供测试与平衡脚本固定敌阵；PvE 默认随机敌阵、品质取玩家平均四舍五入。
  const rank=options.enemyRank===undefined?Math.round(team.reduce((sum,c)=>sum+c.rank,0)/team.length):options.enemyRank;
  ensure(Number.isInteger(rank)&&rank>=1&&rank<=QUALITY_MAX,'敌方品质不合法');
  const positions=slots===undefined?DEFAULT_BATTLE_SLOTS.slice(0,team.length):slots;
  ensure(Array.isArray(positions)&&positions.length===team.length&&new Set(positions).size===positions.length&&Array.from(positions).every(slot=>Number.isInteger(slot)&&slot>=0&&slot<28),'站位必须与上阵人数相同且为不同的 0–27 格位');
  const rng={rng:seed},pool=[...CARDS],enemies:BattleCard[]=[];
  if(options.enemyTeam!==undefined){
    ensure(Array.isArray(options.enemyTeam)&&options.enemyTeam.length===enemyCount&&options.enemyTeam.every(card=>{try{checkCard(card);return true;}catch{return false;}}),'敌方阵容必须为 1–6 张合法卡牌');
    ensure(new Set(options.enemyTeam.map(card=>card.defId)).size===options.enemyTeam.length,'敌方卡牌定义不能重复');
    enemies.push(...options.enemyTeam.map(card=>({uid:'opponent-'+card.defId,defId:card.defId,rank:card.rank,best:0,stars:card.stars??1})));
  }else for(let index=0;index<enemyCount;index++){
    const def=pool.splice(Math.floor(random(rng)*pool.length),1)[0];enemies.push({uid:'opponent-'+index,defId:def.id,rank,stars:1,best:0});
  }
  const frontWeight:Record<CombatRole,number>={坦克:5,战士:4,刺客:3,法师:2,射手:1};
  enemies.sort((a,b)=>frontWeight[getCombatStats(b).role]-frontWeight[getCombatStats(a).role]);
  const synergies={player:getSynergies(team),enemy:getSynergies(enemies)};
  const state:BattleState={
    version:3,id:'battle-hex3-'+seed.toString(36)+'-'+fingerprint(team.map((c,i)=>c.uid+':'+c.defId+':'+c.rank+':'+(c.stars??1)+':'+positions[i]).join('|')+'|enemies:'+enemyCount+(options.enemyTeam?':'+options.enemyTeam.map(c=>c.defId+':'+c.rank+':'+(c.stars??1)).join(','):'')),
    status:'playing',round:1,maxRounds:32,player:team.map((card,index)=>unit(card,'player-'+index,positions[index],'player',synergies.player)),
    enemy:enemies.map((card,index)=>unit(card,'enemy-'+index,DEFAULT_BATTLE_SLOTS[index],'enemy',synergies.enemy)),
    logs:[{id:1,round:1,side:'system',kind:'round',text:'战斗开始：进入射程才攻击，满 100 能量自动释放技能。'}],
    seed,rng:rng.rng,revision:0,frames:[],outcome:'lost',synergies,
  };
  const result=simulate(state);state.frames=result.frames;state.outcome=result.outcome;state.reason=result.reason;return state;
}
export function actBattle(battle:BattleState,action:BattleAction):BattleState {
  ensure(battle&&(battle.version===2||battle.version===3)&&battle.status==='playing','本场战斗已结束或版本不兼容');
  ensure(action&&typeof action==='object'&&action.type==='resolve'&&Object.keys(action).length===1,'只接受自动战斗结算指令');
  ensure(battle.frames.length>0&&battle.frames.length<=400&&(battle.outcome==='won'||battle.outcome==='lost'),'战斗回放不完整');
  const next=structuredClone(battle),last=next.frames.at(-1)!;
  next.player=structuredClone(last.player);next.enemy=structuredClone(last.enemy);next.logs=structuredClone(last.logs);
  next.round=last.round;next.status=next.outcome;next.revision++;return next;
}
