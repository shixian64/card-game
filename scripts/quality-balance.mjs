// 同预算 / 同敌阵品质平衡对照：固定敌阵与站位，跨种子比较多套阵容的胜率。
// 2026-10 v3：招募价只由品质决定（10/11/13/15/17），与卡种无关；敌阵固定、品质固定，
// 不随玩家品质提升（真实对局的“敌方品质跟随玩家平均”会掩盖养成收益，必须用本对照）。
// 用法：node --experimental-strip-types scripts/quality-balance.mjs [种子数]
import { createBattle } from '../src/battle.ts';
import { unitShopPrice, QUALITY } from '../src/data.ts';

const unit = (defId, rank, uid = defId) => ({ uid, defId, rank, best: 0, stars: 1 });
const cost = (team) => team.reduce((sum, c) => sum + unitShopPrice(c.rank), 0);
const SLOTS = [1, 3, 5, 22, 24, 26];
// 与 createBattle 的敌方布阵同序（前排近战 → 后排远程），保证公平检查是真正的镜像对局。
const TEAM_ORDER = ['moon-fawn', 'amber-pause', 'fern-opener', 'moss-tide', 'sun-cub', 'sun-first'];

function run(label, team, enemyRank, seeds) {
  let wins = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const battle = createBattle(team, (Math.imul(seed, 0x9e3779b9) >>> 0), SLOTS.slice(0, team.length), { enemyCount: 6, enemyRank });
    if (battle.outcome === 'won') wins++;
  }
  const rate = wins / seeds;
  console.log(`${label.padEnd(26)} 预算 ${String(cost(team)).padStart(3)} 金 · 胜率 ${(rate * 100).toFixed(1)}%（${wins}/${seeds}）`);
  return rate;
}

const seeds = Number(process.argv[2] ?? 300);
console.log(`品质价目（金币）Q1..Q5：${QUALITY.shop.price.join('/')}；玩家种子 1..${seeds}；敌阵固定 6 单位。`);
// 真镜像公平检查（与 tests/quality-balance.test.ts 同源用例：含坦克的常规 6v6 阵容）
const mirror=['moon-deer','forest-rabbit','moon-fawn','mist-deer','sun-fox','sun-cub'].map(d=>unit(d,1));
let mirrorWins=0;
for(let seed=1;seed<=seeds;seed++){if(createBattle(mirror,Math.imul(seed,0x9e3779b9)>>>0,SLOTS,{enemyCount:6,enemyTeam:mirror}).outcome==='won')mirrorWins++;}
const fair=mirrorWins/seeds;
const low = run('敌 Q3｜全微光 Q1×6', TEAM_ORDER.map(d => unit(d, 1)), 3, seeds);
const mid = run('敌 Q3｜全星辉 Q3×6', TEAM_ORDER.map(d => unit(d, 3)), 3, seeds);
const high = run('敌 Q3｜全星冕 Q5×6', TEAM_ORDER.map(d => unit(d, 5)), 3, seeds);
const fewer = run('敌 Q3｜星冕 Q5×4（弃数量）', TEAM_ORDER.slice(0, 4).map(d => unit(d, 5)), 3, seeds);
const mixed = run('敌 Q3｜混合 Q3×2 + Q1×4', [...TEAM_ORDER.slice(0, 2).map(d => unit(d, 3)), ...TEAM_ORDER.slice(2).map(d => unit(d, 1))], 3, seeds);
console.log(`
同敌阵对照：Q1→Q3 胜率 +${((mid - low) * 100).toFixed(1)} 点（预算 +30%）；Q1→Q5 +${((high - low) * 100).toFixed(1)} 点（预算 +70%）`);
console.log(`同预算近似对照：Q5×4（${cost(TEAM_ORDER.slice(0, 4).map(d => unit(d, 5)))} 金）vs Q1×6（${cost(TEAM_ORDER.map(d => unit(d, 1)))} 金）：${(fewer * 100).toFixed(1)}% vs ${(low * 100).toFixed(1)}%`);
console.log(`镜像公平性：${(fair * 100).toFixed(1)}%（50%±2 合格）；混合阵容（预算 92 金）胜率 ${(mixed * 100).toFixed(1)}%`);
