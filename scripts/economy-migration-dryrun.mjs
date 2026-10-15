// v1→v2 单星币经济迁移 dry-run（只读，不写库、不执行换算）。
// 用法：node --experimental-strip-types scripts/economy-migration-dryrun.mjs [数据库路径]
// 默认路径 data/asteria.sqlite；输出：档案分布、旧余额、换算草案（1 星尘→1 星币、1 券→180 星币，未获确认）、
// 异常档案清单、托管与进行中对局。正式迁移必须先获用户确认并备份。
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrateProfileState } from '../src/engine.ts';
import { LEGACY_ECONOMY } from '../src/data.ts';

const path=process.argv[2]??resolve('data/asteria.sqlite');
if(!existsSync(path)){console.log('数据库不存在（没有需要迁移的真实数据）：'+path);process.exit(0);}
const db=new DatabaseSync(path,{readOnly:true});

const profiles=db.prepare('SELECT user_id,code,state,revision FROM profiles').all();
const listings=db.prepare("SELECT id,seller_id,card,status FROM listings WHERE status='active'").all();
const matches=db.prepare('SELECT user_id,state FROM matches').all();
const battles=db.prepare('SELECT user_id,state FROM battles').all();

let totalCoins=0,totalDust=0,totalTickets=0,restricted=0;
const byRank=[0,0,0,0,0];let cardsTotal=0,legacyCards=0,v2Profiles=0;
const broken=[];const converting=[];
for(const row of profiles){
  let state;
  try{state=JSON.parse(row.state);}catch{broken.push({user:row.code,problem:'JSON 解析失败'});continue;}
  if(state?.version===2){
    v2Profiles++;
    totalCoins+=state.coins??0;restricted+=state.restrictedCoins??0;
    for(const card of state.cards??[]){cardsTotal++;byRank[card.rank-1]??=0;byRank[card.rank-1]++;}
    continue;
  }
  // v1：换算草案（1 星尘→1 星币、1 券→180 星币；未获确认，仅展示）
  const dust=state?.dust??0,tickets=state?.tickets??0,coins=state?.coins??0;
  totalCoins+=coins;totalDust+=dust;totalTickets+=tickets;
  converting.push({user:row.code,coins,dust,tickets,proposed:coins+dust*LEGACY_ECONOMY.dustPerDust+tickets*LEGACY_ECONOMY.dustPerTicket});
  for(const card of state?.cards??[]){
    if(!Number.isInteger(card?.rank)||card.rank<1||card.rank>5){broken.push({user:row.code,problem:'卡品质超范围 '+card?.rank});continue;}
    cardsTotal++;legacyCards++;byRank[card.rank-1]++;
  }
  if(!Number.isSafeInteger(coins)||coins<0)broken.push({user:row.code,problem:'星币超范围 '+coins});
}

const escrowByRank=[0,0,0,0,0];let escrowBroken=0;
for(const listing of listings){
  try{const card=JSON.parse(listing.card);if(card.rank>=1&&card.rank<=5)escrowByRank[card.rank-1]++;else escrowBroken++;}catch{escrowBroken++;}
}
const playing=matches.filter(row=>{try{return JSON.parse(row.state).status==='playing';}catch{return false;}});
const legacyPlaying=playing.filter(row=>{try{const m=JSON.parse(row.state);return m.version===1||m.version===2;}catch{return false;}});
const legacyBattles=battles.filter(row=>{try{const b=JSON.parse(row.state);return b.status==='playing';}catch{return false;}});

const mint=converting.reduce((sum,entry)=>sum+entry.proposed-entry.coins,0);
console.log(`数据库：${path}`);
console.log(`档案：${profiles.length} 个（v2 新经济 ${v2Profiles} / v1 待迁移 ${converting.length} / 解析失败 ${broken.length}）`);
console.log(`旧余额（v1）：星币 ${totalCoins} · 星尘 ${totalDust} · 抽卡券 ${totalTickets}`);
console.log(`换算草案（未获用户确认，不会执行）：星尘 1→1 星币 + 券 1→${LEGACY_ECONOMY.dustPerTicket} 星币`);
console.log(`  换算后新增发行 ${converting.reduce((s,e)=>s+e.dust,0)} + ${totalTickets*LEGACY_ECONOMY.dustPerTicket} = ${converting.reduce((s,e)=>s+e.dust,0)+totalTickets*LEGACY_ECONOMY.dustPerTicket} 星币；v1 总余额 ${totalCoins} → ${totalCoins+mint}`);
console.log(`卡牌库存：${cardsTotal} 张（v1 legacy ${legacyCards}，全部 grandfather 为可流通）· 品质 Q1..Q5：${byRank.join('/')}`);
console.log(`市场托管：${listings.length} 张（${escrowByRank.join('/')}），异常 ${escrowBroken}`);
console.log(`进行中对局：${playing.length} 局（v1/v2 冻结结算 ${legacyPlaying.length}）；遗留 playing 单场战斗锁卡 ${legacyBattles.length} 张`);
if(broken.length){console.log('异常档案（迁移时需人工隔离，不清零不静默修复）：');for(const item of broken.slice(0,20))console.log('  - '+item.user+'：'+item.problem);}
if(converting.length){console.log('换算样例（最多 5 个）：');for(const entry of converting.slice(0,5))console.log(`  - ${entry.user}：${entry.coins}+${entry.dust}尘+${entry.tickets}券 → ${entry.proposed} 星币`);}
console.log('\n注意：本工具只读；正式迁移前需备份该文件、获用户确认换算比例，并停写窗口。回滚需考虑新订单与受限余额，不能只 revert 代码。');
