// 2026-10 单星币经济可复现模拟：
//  Part 1 本命 Q1→Q5 升阶成本蒙特卡洛（三种获取策略 × N 次模拟，输出 P50/P90/P99 与均值）
//  Part 2 完整八轮经营模拟（贪婪策略，统计闲置金币 / 招募 / 刷新 / XP / 合星 / 胜场 / 终局品质构成）
// 用法：node --experimental-strip-types scripts/economy-forge-sim.mjs [次数]
// 随机源：mulberry32(seed)，与测试同构；不含市场补料（无价格模型，见报告局限）。
import { rollTenDraw } from '../src/engine.ts';
import { QUALITY, ECONOMY, CARDS } from '../src/data.ts';
import { createMatch, actMatch, advanceMatch } from '../server/match.mjs';

function mulberry32(seed){let a=seed>>>0;return ()=>{a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};}
const percentile=(sorted,p)=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];
const stats=(values,label,unit)=>{
  const sorted=[...values].sort((a,b)=>a-b);
  const mean=sorted.reduce((s,v)=>s+v,0)/sorted.length;
  return `${label}：均值 ${mean.toFixed(0)}${unit} · P50 ${percentile(sorted,.5).toFixed(0)} · P90 ${percentile(sorted,.9).toFixed(0)} · P99 ${percentile(sorted,.99).toFixed(0)}${unit}`;
};

// ─── Part 1：升阶蒙特卡洛 ─────────────────────────────────────────────
// 合成状态机与 forgeCardV2 同规则：单 roll 定分支；失败 60%/40% 返 1/2 张材料。
function attemptForge(counts,rank,rand){
  const fail=QUALITY.forge.fail[rank-1],two=QUALITY.forge.upgradeTwo[rank-1];
  const roll=rand()*100;
  counts[rank-1]-=3;
  if(roll<fail){
    const back=rand()*100<QUALITY.forge.failReturnOne?1:2;
    counts[rank-1]+=back;
    return {coins:QUALITY.forge.coins[rank-1],branch:'fail'};
  }
  const to=(rank+2<=5&&roll<fail+two)?rank+2:rank+1;
  counts[to-1]+=1;
  return {coins:QUALITY.forge.coins[rank-1],branch:to-rank===2?'two':'one'};
}
function runStrategy(rand,acquire){
  const counts=[0,0,0,0,0];let coins=0,attempts=0;
  while(!counts[4]&&coins<=2_000_000){
    const rank=[1,2,3,4].find(r=>counts[r-1]>=3);
    if(rank){coins+=attemptForge(counts,rank,rand).coins;attempts++;}
    else coins+=acquire(counts,rand);
  }
  return {coins,attempts};
}
const strategies=[
  ['策略 A｜纯定向制作 180/张',(counts)=>{counts[0]+=1;return ECONOMY.craftCost;}],
  ['策略 B｜十连补料（本命 1/36）',(counts,rand)=>{
    let refund=0;
    for(const card of rollTenDraw(rand)){
      if(card.defId!=='moon-deer'){if(card.rank===1)refund+=ECONOMY.recycleReturn;continue;} // 非本命 Q1 回收 +10；Q2+ 暂无出口（保守计 0）
      counts[card.rank-1]+=1;
    }
    return ECONOMY.tenDrawCost-refund;}],
  ['策略 C｜单抽定向（候选含本命 3/36）',(counts,rand)=>{
    if(rand()<3/36)counts[qualityRoll(rand)-1]+=1;
    return ECONOMY.singleDrawCost;}], // 未中即沉没（单抽无副产物）
];
function qualityRoll(rand){let bound=0;for(let i=0;i<QUALITY.summonQuality.length;i++){bound+=QUALITY.summonQuality[i]/100;if(rand()<bound)return i+1;}return 5;}

// ─── Part 2：八轮经营贪婪策略模拟 ──────────────────────────────────────
const STARTER_DEFS=CARDS.slice(0,8).map(c=>c.id);
function weightedRank(rand){ // 新手常态：8 种卡最高品质按 52/28/13 截断到 ≤Q3
  const roll=rand()*93;return roll<52?1:roll<80?2:3;
}
function greedyMatch(seed){
  const rand=mulberry32(seed*7919+13);
  const owned=STARTER_DEFS.map(defId=>({defId,rank:weightedRank(rand)}));
  let match=createMatch(owned,seed,0);
  let spentBuy=0,spentReroll=0,spentXp=0;
  const starsBeforeBuy=()=>match.roster.reduce((s,u)=>s+u.stars,0);
  let merges=0;
  for(let round=1;round<=8&&match.status==='playing';round++){
    // 经营阶段（推进到本轮经营窗内最后一刻）
    let progress=advanceMatch(match,match.startedAt+(round-1)*75000+39000);
    if(progress.changed)match=progress.match;
    if(match.phase!=='planning')continue;
    let bought=0;const before=starsBeforeBuy();
    for(const offer of [...match.shop])if(match.gold>=offer.cost&&match.roster.length<15){match=actMatch(match,'buy',{offerId:offer.id},match.startedAt+(round-1)*75000+39000);spentBuy+=offer.cost;bought++;}
    if(bought===0&&match.gold>=20&&match.roster.length<15){match=actMatch(match,'reroll',{},match.startedAt+(round-1)*75000+39000);spentReroll+=20;
      for(const offer of [...match.shop])if(match.gold>=offer.cost&&match.roster.length<15){match=actMatch(match,'buy',{offerId:offer.id},match.startedAt+(round-1)*75000+39000);spentBuy+=offer.cost;}}
    if(round>=4&&match.level<6&&match.gold>=60){match=actMatch(match,'xp',{},match.startedAt+(round-1)*75000+39000);spentXp+=40;}
    merges+=starsBeforeBuy()-before;
    progress=advanceMatch(match,match.startedAt+round*75000+1000);
    if(progress.changed)match=progress.match;
  }
  const finish=advanceMatch(match,match.startedAt+600001);
  const m=finish.match;
  return {idleGold:m.gold,spentBuy,spentReroll,spentXp,merges,wins:m.wins,rosterSize:m.roster.length,
    qualityMix:m.roster.reduce((acc,u)=>{acc[u.rank-1]=(acc[u.rank-1]??0)+1;return acc;},[0,0,0,0,0]),
    reward:m.reward?.coins??0,activity:m.activity?.length??0};
}

// ─── 输出 ─────────────────────────────────────────────────────────────
const N=Number(process.argv[2]??4000);
console.log(`本命 Q1→Q5 升阶蒙特卡洛：N=${N}，mulberry32(20261014+seed)，合成规则=当前 QUALITY.forge（失败 60%/40% 返 1/2），不含市场补料与对局奖励。`);
for(const [label,acquire] of strategies){
  const coins=[],attempts=[];
  for(let seed=1;seed<=N;seed++){const rand=mulberry32(20261014+seed);const r=runStrategy(rand,acquire);coins.push(r.coins);attempts.push(r.attempts);}
  console.log(stats(coins,label.split('｜')[1],' 星币'));
  console.log(stats(attempts,'  其中合成尝试',' 次'));
}
console.log(`\n完整八轮经营模拟（贪婪策略，N=${Math.min(N,600)}）：开局 8 种卡（最高 ≤Q3），每轮买光可负担报价、无货时刷新一次、第 4 轮起有余钱升人口。`);
const M=Math.min(N,600);const runs=[];for(let seed=1;seed<=M;seed++)runs.push(greedyMatch(seed));
console.log(stats(runs.map(r=>r.idleGold),'终局闲置金币',''));
console.log(stats(runs.map(r=>r.spentBuy),'招募花费',''));
console.log(stats(runs.map(r=>r.spentReroll),'刷新花费',''));
console.log(stats(runs.map(r=>r.spentXp),'经验花费',''));
console.log(stats(runs.map(r=>r.merges),'合星次数',''));
console.log(stats(runs.map(r=>r.wins),'胜场（/8）',''));
console.log(stats(runs.map(r=>r.reward),'结算星币奖励（80+20W，未含参与度过滤）',''));
const mix=[0,0,0,0,0];for(const r of runs)for(let i=0;i<5;i++)mix[i]+=r.qualityMix[i]??0;
console.log(`终局阵容品质构成 Q1..Q5：${mix.map(n=>(n/M).toFixed(1)).join(' / ')}（均值每局张数）`);
console.log(`有效参与达标率（≥4 回合动作 且 终局 ≥3 种）：${(runs.filter(r=>r.activity>=4&&new Set([r.rosterSize]).size>=1&&r.rosterSize>=3).length/M*100).toFixed(1)}%`);
