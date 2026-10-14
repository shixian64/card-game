import {randomUUID} from 'node:crypto';
import {CARD_MAP} from '../src/data.ts';
import {createBattle,actBattle,getCombatStats} from '../src/battle.ts';

export const MATCH_RULES=Object.freeze({rounds:8,planningMs:40000,combatMs:35000,durationMs:600000,initialGold:12,rerollCost:2,xpCost:4,xpGain:4,maxRoster:15});
const XP={3:6,4:10,5:14};
const COST={R:1,SR:2,SSR:3};
function fail(message,status=400){const e=new Error(message);e.status=status;throw e;}
function rng(s){let x=s.rng||0x9e3779b9;x^=x<<13;x^=x>>>17;x^=x<<5;s.rng=x>>>0;return s.rng/4294967296;}
function nextId(s){return 'm'+s.nextId++;}
function newShop(s){const weights={3:[60,32,8],4:[45,40,15],5:[30,45,25],6:[20,45,35]}[s.level];return Array.from({length:5},()=>{const p=rng(s)*100;const tier=p<weights[0]?'R':p<weights[0]+weights[1]?'SR':'SSR';const pool=s.pool.filter(c=>CARD_MAP[c.defId].rarity===tier);const choices=pool.length?pool:s.pool;const card=choices[Math.floor(rng(s)*choices.length)];return {id:nextId(s),defId:card.defId,rank:card.rank,cost:COST[CARD_MAP[card.defId].rarity]};});}
function addXp(s,amount){s.xp+=amount;while(s.level<6&&s.xp>=XP[s.level]){s.xp-=XP[s.level];s.level++;}if(s.level===6)s.xp=0;s.xpToNext=XP[s.level]??null;}
function placement(roster,limit){const priority={坦克:0,战士:1,刺客:2,射手:3,法师:4};const units=[...roster].sort((a,b)=>(priority[getCombatStats(a).role]??5)-(priority[getCombatStats(b).role]??5)||b.stars-a.stars).slice(0,limit);let front=0,back=0;return units.map(c=>{const role=getCombatStats(c).role;const melee=['坦克','战士','刺客'].includes(role);const slot=melee?[1,3,5,8,10,12][front++]:[22,24,26,15,17,19][back++];return {uid:c.uid,slot};});}
function projection(s,card){return {uid:nextId(s),defId:card.defId,rank:card.rank,best:0,stars:1};}
export function createMatch(cards,seed,now=Date.now()){
 if(!Array.isArray(cards)||!cards.length)fail('至少拥有一张卡牌才能开启对局');
 const pool=[...new Map([...cards].sort((a,b)=>a.rank-b.rank).map(c=>[c.defId,{defId:c.defId,rank:c.rank}])).values()];
 const s={version:1,id:randomUUID(),status:'playing',startedAt:now,endsAt:now+MATCH_RULES.durationMs,serverNow:now,round:1,phase:'planning',phaseEndsAt:now+MATCH_RULES.planningMs,gold:12,level:3,xp:0,xpToNext:6,shop:[],locked:false,roster:[],formation:[],battle:null,wins:0,losses:0,streak:0,history:[],pool,rng:seed>>>0,nextId:1,revision:0};
 const starter=[...pool].sort((a,b)=>{const roleA=getCombatStats({uid:'preview',best:0,...a}).role,roleB=getCombatStats({uid:'preview',best:0,...b}).role;const order={坦克:0,射手:1,战士:2,法师:3,刺客:4};return order[roleA]-order[roleB];});
 const first=starter[0];const firstRole=getCombatStats({uid:'preview',best:0,...first}).role;const second=starter.find(c=>getCombatStats({uid:'preview',best:0,...c}).role!==firstRole)??starter[1];s.roster=[first,...(second?[second]:[])].map(card=>projection(s,card));s.formation=placement(s.roster,s.level);s.shop=newShop(s);return s;
}
function merge(s){for(let stars=1;stars<3;stars++){for(const defId of new Set(s.roster.map(c=>c.defId))){let copies=s.roster.filter(c=>c.defId===defId&&c.stars===stars);while(copies.length>=3){copies.sort((a,b)=>Number(s.formation.some(p=>p.uid===b.uid))-Number(s.formation.some(p=>p.uid===a.uid)));const group=copies.slice(0,3),keeper=group[0],removed=new Set(group.slice(1).map(c=>c.uid));keeper.stars++;s.roster=s.roster.filter(c=>!removed.has(c.uid));s.formation=s.formation.filter(p=>!removed.has(p.uid));copies=s.roster.filter(c=>c.defId===defId&&c.stars===stars);}}}}
export function advanceMatch(original,now=Date.now()){
 if(!original||original.status!=='playing')return {match:original,changed:false,reward:null};
 if(now<original.phaseEndsAt)return {match:original,changed:false,reward:null};
 const s=structuredClone(original);let reward=null;
 while(s.status==='playing'&&now>=s.phaseEndsAt){
  if(s.phase==='planning'){
   s.formation=s.formation.filter(p=>s.roster.some(c=>c.uid===p.uid)).slice(0,s.level);
   if(!s.formation.length&&s.roster.length)s.formation=placement(s.roster,s.level);
   const team=s.formation.map(p=>s.roster.find(c=>c.uid===p.uid));
   s.battle=team.length?createBattle(team,Math.floor(rng(s)*0x100000000),s.formation.map(p=>p.slot),{enemyCount:Math.min(6,3+Math.floor((s.round-1)/3))}):null;
   s.phase='combat';s.phaseEndsAt=s.startedAt+s.round*75000;
  }else{
   if(s.battle)s.battle=actBattle(s.battle,{type:'resolve'});
   const won=s.battle?.status==='won';s[won?'wins':'losses']++;
   s.streak=won?(s.streak>0?s.streak+1:1):(s.streak<0?s.streak-1:-1);
   const income={base:5,interest:Math.min(5,Math.floor(s.gold/10)),streak:Math.abs(s.streak)>=4?2:Math.abs(s.streak)>=2?1:0,win:won?1:0,total:0};income.total=income.base+income.interest+income.streak+income.win;s.gold+=income.total;s.lastIncome=income;
   s.history.push({round:s.round,status:won?'won':'lost',gold:income.total});
   if(s.round===8){s.status='finished';s.phase='finished';s.phaseEndsAt=s.endsAt;reward={coins:80+s.wins*20,dust:20+s.wins*5};s.reward=reward;}
   else{s.round++;s.phase='planning';s.phaseEndsAt=s.startedAt+(s.round-1)*75000+40000;s.battle=null;addXp(s,2);if(!s.locked)s.shop=newShop(s);}
  }
  s.revision++;
 }
 s.serverNow=now;return {match:s,changed:true,reward};
}
export function actMatch(original,action,input={},now=Date.now()){
 if(!original||original.status!=='playing')fail('没有进行中的对局',409);
 const s=structuredClone(original);
 if(action==='abandon'){s.status='finished';s.phase='finished';s.phaseEndsAt=now;s.endsAt=now;s.abandoned=true;s.reward={coins:0,dust:0};s.revision++;return s;}
 if(s.phase!=='planning'||now>=s.phaseEndsAt)fail('当前不是经营阶段，请等待下一回合',409);
 const pay=cost=>{if(s.gold<cost)fail('局内金币不足',409);s.gold-=cost;};
 if(action==='buy'){
  const index=s.shop.findIndex(o=>o.id===input.offerId);if(index<0)fail('这张商店卡牌已被购买或刷新',409);
  const offer=s.shop[index];pay(offer.cost);s.roster.push(projection(s,offer));s.shop.splice(index,1);merge(s);if(s.roster.length>15)fail('备战区已满，请先卖出卡牌',409);
 }else if(action==='sell'){
  const card=s.roster.find(c=>c.uid===input.uid);if(!card)fail('没有这张局内卡牌',409);
  s.gold+=COST[CARD_MAP[card.defId].rarity]*3**(card.stars-1);s.roster=s.roster.filter(c=>c.uid!==card.uid);s.formation=s.formation.filter(p=>p.uid!==card.uid);
 }else if(action==='reroll'){pay(2);s.shop=newShop(s);
 }else if(action==='xp'){if(s.level>=6)fail('人口已满级');pay(4);addXp(s,4);
 }else if(action==='lock'){if(typeof input.locked!=='boolean')fail('锁店状态不合法');s.locked=input.locked;
 }else if(action==='deploy'){
  const formation=input.formation;if(!Array.isArray(formation)||formation.length>s.level)fail('上阵数量超过当前人口');
  if(formation.some(p=>!p||typeof p.uid!=='string'||!s.roster.some(c=>c.uid===p.uid)||!Number.isInteger(p.slot)||p.slot<0||p.slot>27)||new Set(formation.map(p=>p.uid)).size!==formation.length||new Set(formation.map(p=>p.slot)).size!==formation.length)fail('阵容或站位不合法');
  s.formation=formation.map(({uid,slot})=>({uid,slot}));
 }else fail('不支持的对局操作',404);
 s.revision++;s.serverNow=now;return s;
}
export function publicMatch(s,now=Date.now()){if(!s)return null;const {pool,rng,nextId,...view}=s;return {...view,serverNow:now};}
