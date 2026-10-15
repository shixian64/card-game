import {randomUUID} from 'node:crypto';
import {CARD_MAP,unitShopPrice,QUALITY,LEGACY_RARITY,LEGACY_ECONOMY} from '../src/data.ts';
import {createBattle,actBattle,getCombatStats} from '../src/battle.ts';

// 局内金币采用 10 倍刻度，与永久星币完全独立、互不兑换。
// v3（2026-10 经济改版）：取消卡种稀有度；招募价只由品质决定（10/11/13/15/17）；
// 开局池按“每个已拥有卡种的最高品质”向下投影 Q1..maxQ；单位出售按累计 basis 结算；
// 奖励只有星币（80 + 20×胜场，参与度与每日配额可配）。v1/v2 存量对局按冻结规则结束。
export const MATCH_RULES=Object.freeze({version:3,rounds:8,planningMs:40000,combatMs:35000,durationMs:600000,
  initialGold:120,rerollCost:20,xpCost:40,xpGain:4,maxRoster:15,
  baseIncome:50,interestPer:100,interestStep:10,interestMax:50,streakBonus:10,streakBonusBig:20,winBonus:10,
  // 对局奖励（推荐默认，未经用户最终确认；集中在此可整体调整）。
  reward:Object.freeze({base:80,perWin:20,minActivityRounds:4,minDistinctDefs:3,dailyFull:6,dailyHalf:6})});
const XP={3:6,4:10,5:14};
function fail(message,status=400,code){const e=new Error(message);e.status=status;if(code)e.code=code;throw e;}
function rng(s){let x=s.rng||0x9e3779b9;x^=x<<13;x^=x>>>17;x^=x<<5;s.rng=x>>>0;return s.rng/4294967296;}
function nextId(s){return 'm'+s.nextId++;}
// ── legacy 冻结价表（仅 version<3 存量对局使用；新局禁止读取）──────────────────
const LEGACY_SHOP_MULTIPLIER=[1,1.1,1.25,1.45,1.7];
const LEGACY_TIER_WEIGHTS={3:[60,32,8],4:[45,40,15],5:[30,45,25],6:[20,45,35]};
function legacyUnitPrice(defId,quality){return Math.round(LEGACY_ECONOMY.sellBase[LEGACY_RARITY[defId]]*LEGACY_SHOP_MULTIPLIER[quality-1]);}
/** 加权品质：把 shopQuality 前 maxRank 档截断并归一化（投影上限内逐档递减）。 */
function rollQuality(s,maxRank){
  const weights=QUALITY.shopQuality.slice(0,maxRank);
  const total=weights.reduce((sum,w)=>sum+w,0);
  const roll=rng(s)*total;let bound=0;
  for(let index=0;index<weights.length;index++){bound+=weights[index];if(roll<bound)return index+1;}
  return weights.length;
}
function unitPrice(defId,quality,version){return version>=MATCH_RULES.version?unitShopPrice(quality):legacyUnitPrice(defId,quality);}
// v3 商店：每格先在开局拥有的不同 defId 中均匀选一种，再按截断品质权重投影 Q1..maxQ；
// 人口不再解锁稀有档（只影响部署上限）；五格之间可重复。
function newShop(s){
 if(s.version>=MATCH_RULES.version){
  const defs=s.pool.map(entry=>entry.defId);
  return Array.from({length:5},()=>{const defId=defs[Math.floor(rng(s)*defs.length)];const entry=s.pool.find(e=>e.defId===defId);const rank=rollQuality(s,entry.maxRank);return {id:nextId(s),defId,rank,cost:unitShopPrice(rank)};});
 }
 // legacy：按旧 R/SR/SSR 人口选档 + 冻结稀有度映射（仅存续局）。
 const weights=LEGACY_TIER_WEIGHTS[s.level];return Array.from({length:5},()=>{const p=rng(s)*100;const tier=p<weights[0]?'R':p<weights[0]+weights[1]?'SR':'SSR';const pool=s.pool.filter(c=>LEGACY_RARITY[c.defId]===tier);const choices=pool.length?pool:s.pool;const card=choices[Math.floor(rng(s)*choices.length)];return {id:nextId(s),defId:card.defId,rank:card.rank,cost:legacyUnitPrice(card.defId,card.rank)};});
}
function addXp(s,amount){s.xp+=amount;while(s.level<6&&s.xp>=XP[s.level]){s.xp-=XP[s.level];s.level++;}if(s.level===6)s.xp=0;s.xpToNext=XP[s.level]??null;}
function placement(roster,limit){const priority={坦克:0,战士:1,刺客:2,射手:3,法师:4};const units=[...roster].sort((a,b)=>(priority[getCombatStats(a).role]??5)-(priority[getCombatStats(b).role]??5)||b.stars-a.stars).slice(0,limit);let front=0,back=0;return units.map(c=>{const role=getCombatStats(c).role;const melee=['坦克','战士','刺客'].includes(role);const slot=melee?[1,3,5,8,10,12][front++]:[22,24,26,15,17,19][back++];return {uid:c.uid,slot};});}
// 局内副本记录出售基价 basis：买入 = 成交价；开局免费副本 = 该品质标准价（可售价值计入开局预算，不反复发放）。
function projection(s,card){return {uid:nextId(s),defId:card.defId,rank:card.rank,best:0,stars:1,basis:unitPrice(card.defId,card.rank,s.version)};}
export function createMatch(cards,seed,now=Date.now()){
 if(!Array.isArray(cards)||!cards.length)fail('至少拥有一张卡牌才能开启对局');
 // 开局池快照：每个已拥有 defId 记录当时的最高品质；局外交易 / 合成不回写本局。
 // 局内可招募该卡 Q1..maxQ 的降阶投影（不产生永久卡）；卖出最后一张后，下次开局不再进入池。
 const maxByDef=new Map();
 for(const card of cards){const current=maxByDef.get(card.defId);if(!current||card.rank>current)maxByDef.set(card.defId,card.rank);}
 const pool=[...maxByDef].map(([defId,maxRank])=>({defId,maxRank}));
 const s={version:MATCH_RULES.version,id:randomUUID(),status:'playing',startedAt:now,endsAt:now+MATCH_RULES.durationMs,serverNow:now,round:1,phase:'planning',phaseEndsAt:now+MATCH_RULES.planningMs,gold:MATCH_RULES.initialGold,level:3,xp:0,xpToNext:6,shop:[],locked:false,roster:[],formation:[],battle:null,wins:0,losses:0,streak:0,history:[],pool,rng:seed>>>0,nextId:1,revision:0,activity:[]};
 const bestByDef=[...maxByDef].map(([defId,rank])=>({defId,rank})).sort((a,b)=>{const roleA=getCombatStats({uid:'preview',best:0,...a}).role,roleB=getCombatStats({uid:'preview',best:0,...b}).role;const order={坦克:0,射手:1,战士:2,法师:3,刺客:4};return order[roleA]-order[roleB];});
 const first=bestByDef[0];const firstRole=getCombatStats({uid:'preview',best:0,...first}).role;const second=bestByDef.find(c=>getCombatStats({uid:'preview',best:0,...c}).role!==firstRole)??bestByDef[1];
 s.roster=[first,...(second?[second]:[])].map(card=>projection(s,card));s.formation=placement(s.roster,s.level);s.shop=newShop(s);return s;
}
// 局内合星：同 defId + 同品质 + 同星的 3 张自动合成高一星；品质不变，basis 求和（出售 = 完整合星成本，无套利）。
function merge(s){for(let stars=1;stars<3;stars++){for(const key of new Set(s.roster.map(c=>c.defId+':'+c.rank))){let copies=s.roster.filter(c=>c.defId+':'+c.rank===key&&c.stars===stars);while(copies.length>=3){copies.sort((a,b)=>Number(s.formation.some(p=>p.uid===b.uid))-Number(s.formation.some(p=>p.uid===a.uid)));const group=copies.slice(0,3),keeper=group[0],removed=new Set(group.slice(1).map(c=>c.uid));keeper.stars++;keeper.basis=group.reduce((sum,c)=>sum+(c.basis??0),0);s.roster=s.roster.filter(c=>!removed.has(c.uid));s.formation=s.formation.filter(p=>!removed.has(p.uid));copies=s.roster.filter(c=>c.defId+':'+c.rank===key&&c.stars===stars);}}}}
export function migrateMatch(state){
 if(!state||state.version!==1)return state; // v3 新局与 v2 存局原样返回（v2 按冻结规则结束）
 const s=structuredClone(state);
 // 旧 ×1 金币刻度 → ×10；商店报价换算成旧品质价（= 出售价），避免低买高卖。
 s.gold*=10;
 if(Array.isArray(s.shop))s.shop=s.shop.map(offer=>({...offer,cost:legacyUnitPrice(offer.defId,offer.rank)}));
 if(s.lastIncome&&typeof s.lastIncome==='object')for(const key of ['base','interest','streak','win','total'])if(Number.isFinite(s.lastIncome[key]))s.lastIncome[key]*=10;
 if(Array.isArray(s.history))s.history=s.history.map(entry=>({...entry,gold:entry.gold*10}));
 s.version=2;s.legacyPricing=true; // 迁移前入队的单位按冻结旧价出售；仅存续到本局结束。
 return s;
}
// 结算奖励（v3）：正常完成八轮才发；参与度不足发 0 并给原因；配额由调用方注入（同事务内占额）。
function finishReward(s,quota){
 const reward=MATCH_RULES.reward;
 const distinctDefs=new Set(s.roster.map(c=>c.defId)).size;
 const activityRounds=new Set(s.activity).size;
 if(activityRounds<reward.minActivityRounds||distinctDefs<reward.minDistinctDefs){
  return {coins:0,base:0,factor:0,reason:'insufficient_activity',activityRounds,distinctDefs};
 }
 const base=reward.base+s.wins*reward.perWin;
 const outcome=quota?quota(s):{factor:1};
 const coins=Math.floor(base*outcome.factor);
 return {coins,base,factor:outcome.factor,reason:outcome.factor<1?'daily_quota':'',quotaTier:outcome.tier,activityRounds,distinctDefs};
}
export function advanceMatch(original,now=Date.now(),options={}){
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
   const income={base:MATCH_RULES.baseIncome,interest:Math.min(MATCH_RULES.interestMax,Math.floor(s.gold/MATCH_RULES.interestPer)*MATCH_RULES.interestStep),streak:Math.abs(s.streak)>=4?MATCH_RULES.streakBonusBig:Math.abs(s.streak)>=2?MATCH_RULES.streakBonus:0,win:won?MATCH_RULES.winBonus:0,total:0};income.total=income.base+income.interest+income.streak+income.win;s.gold+=income.total;s.lastIncome=income;
   s.history.push({round:s.round,status:won?'won':'lost',gold:income.total});
   if(s.round===8){
    s.status='finished';s.phase='finished';s.phaseEndsAt=s.endsAt;
    // v3：只发星币；legacy（v1/v2 存局）沿用旧公式（含星尘部分，由 game.mjs 冻结处理）。
    reward=s.version>=MATCH_RULES.version?finishReward(s,options.rewardQuota):{coins:80+s.wins*20,dust:20+s.wins*5,legacy:true};
    s.reward=reward;
   }
   else{s.round++;s.phase='planning';s.phaseEndsAt=s.startedAt+(s.round-1)*75000+40000;s.battle=null;addXp(s,2);if(!s.locked)s.shop=newShop(s);}
  }
  s.revision++;
 }
 s.serverNow=now;return {match:s,changed:true,reward};
}
export function actMatch(original,action,input={},now=Date.now()){
 if(!original||original.status!=='playing')fail('没有进行中的对局',409);
 const s=structuredClone(original);
 if(action==='abandon'){s.status='finished';s.phase='finished';s.phaseEndsAt=now;s.endsAt=now;s.abandoned=true;s.reward={coins:0,factor:0,reason:'abandoned'};s.revision++;return s;}
 if(s.phase!=='planning'||now>=s.phaseEndsAt)fail('当前不是经营阶段，请等待下一回合',409);
 const pay=cost=>{if(s.gold<cost)fail('局内金币不足',409);s.gold-=cost;};
 const markActivity=()=>{if(s.version>=MATCH_RULES.version&&!s.activity.includes(s.round))s.activity.push(s.round);};
 if(action==='buy'){
  const index=s.shop.findIndex(o=>o.id===input.offerId);if(index<0)fail('这张商店卡牌已被购买或刷新',409);
  const offer=s.shop[index];pay(offer.cost);const unit=projection(s,offer);unit.basis=offer.cost;s.roster.push(unit);s.shop.splice(index,1);merge(s);if(s.roster.length>MATCH_RULES.maxRoster)fail('备战区已满，请先卖出卡牌',409);markActivity();
 }else if(action==='sell'){
  const card=s.roster.find(c=>c.uid===input.uid);if(!card)fail('没有这张局内卡牌',409);
  // 出售按该单位累计 basis 返还（合星 = 三张材料 basis 求和），不按未来全局配置重算。
  // 无 basis 的异常/测试构造单位按本局版本回退：v3 品质价；legacy 存局冻结旧价，杜绝迁移窗口低买高卖。
  const fallbackPrice=s.version>=MATCH_RULES.version?unitShopPrice(card.rank):legacyUnitPrice(card.defId,card.rank);
  const salePrice=card.basis!==undefined?card.basis:(s.legacyPricing?(LEGACY_ECONOMY.sellBase[LEGACY_RARITY[card.defId]]??10)*3**(card.stars-1):fallbackPrice*3**(card.stars-1));
  s.gold+=salePrice;s.roster=s.roster.filter(c=>c.uid!==card.uid);s.formation=s.formation.filter(p=>p.uid!==card.uid);markActivity();
 }else if(action==='reroll'){pay(MATCH_RULES.rerollCost);s.shop=newShop(s);markActivity();
 }else if(action==='xp'){if(s.level>=6)fail('人口已满级');pay(MATCH_RULES.xpCost);addXp(s,MATCH_RULES.xpGain);markActivity();
 }else if(action==='lock'){if(typeof input.locked!=='boolean')fail('锁店状态不合法');s.locked=input.locked;
 }else if(action==='deploy'){
  const formation=input.formation;if(!Array.isArray(formation)||formation.length>s.level)fail('上阵数量超过当前人口');
  if(formation.some(p=>!p||typeof p.uid!=='string'||!s.roster.some(c=>c.uid===p.uid)||!Number.isInteger(p.slot)||p.slot<0||p.slot>27)||new Set(formation.map(p=>p.uid)).size!==formation.length||new Set(formation.map(p=>p.slot)).size!==formation.length)fail('阵容或站位不合法');
  s.formation=formation.map(({uid,slot})=>({uid,slot}));markActivity();
 }else fail('不支持的对局操作',404);
 s.revision++;s.serverNow=now;return s;
}
export function publicMatch(s,now=Date.now()){if(!s)return null;const {pool,rng,nextId,...view}=s;return {...view,serverNow:now};}
