#!/usr/bin/env node
// 双人短局主对局数值验证（DUEL-RULES-1 起测参数；可复现：seed 固定、样本量注明）。
// 输出 artifacts/duel-v1/balance-report.json + balance-report.txt。
// 实验组（设计文档 17.1）：
//   A 品质组：固定敌阵（Q3 混编 ★1）× 同阵容 Q1..Q5 —— 固定阵容比品质。
//   B 价格组：同预算（102 金）下 10/11/13/15/17 与 10/11/12/13/14 两套价格的最优采购对照。
//   C 星级组：新倍率（duel-sim）与旧倍率（battle.ts 旧内核）的 ★1→★2→★3 提升幅度。
//   D 利息组：全十轮经济模拟 spend-all vs save-to-30。
//   E 全十轮经营模拟：即时补阵 / 适度存钱 / 重押本命 三策略真实对局（含野怪与 PvP）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateDuel } from '../src/duel-sim.ts';
import { buildNeutralUnits } from '../src/neutral.ts';
import { createBattle } from '../src/battle.ts';
import { duelRoundRule, DUEL_ROUNDS, DUEL_QUALITY, DUEL_STARS, DUEL_GOLD, duelNeutralCamp, DUEL_RULES_VERSION } from '../src/duel-rules.ts';
import { getCombatStats } from '../src/battle.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'artifacts/duel-v1');
mkdirSync(OUT, { recursive: true });
const report = { generatedAt: new Date().toISOString(), rulesVersion: 'DUEL-RULES-1', samples: {}, experiments: {} };

// 标准六人混编（坦克/战士/刺客/法师/射手×2），沿用 duel-sim.test 的镜像阵容。
const STANDARD_TEAM = ['moon-deer', 'forest-rabbit', 'moon-fawn', 'sun-fox', 'sun-cub', 'forest-sprout'];
const SLOTS = [1, 3, 5, 22, 24, 26];
function teamUnits(defs, quality, stars = 1, items = []) {
  return defs.map((defId, i) => ({ unitId: 'u' + i, defId, quality, stars, itemDefIds: items.length ? [items[i % items.length]] : [] }));
}
function sideOf(units) { return { units, formation: units.map((u, i) => ({ unitId: u.unitId, localSlot: SLOTS[i] })) }; }
function fight(teamA, teamB, seeds, maxRounds) {
  let a = 0, b = 0, draw = 0;
  for (const seed of seeds) {
    const sim = simulateDuel({ roundNumber: 5, combatSeed: seed, rulesVersion: DUEL_RULES_VERSION, sideA: sideOf(teamA), sideB: sideOf(teamB), ...(maxRounds ? { maxLogicalRounds: maxRounds } : {}) });
    if (sim.winner === 'A') a++; else if (sim.winner === 'B') b++; else draw++;
  }
  return { a, b, draw, aRate: +(a / seeds.length).toFixed(4), n: seeds.length };
}
const seedsOf = (n, base = 1) => Array.from({ length: n }, (_, i) => (base + i * 7919) >>> 0);

// ── A 品质组：固定敌阵（Q3 ★1 混编）───────────────────────────────────────
const fixedEnemy = teamUnits(STANDARD_TEAM, 3);
const qualityRows = {};
for (const q of [1, 2, 3, 4, 5]) {
  qualityRows['Q' + q] = fight(teamUnits(STANDARD_TEAM, q), fixedEnemy, seedsOf(300));
  qualityRows['Q' + q].cost = DUEL_QUALITY.shopGold[q - 1] * 6;
}
report.experiments.qualityFixedEnemy = qualityRows;

// ── B 价格组：同预算 102 金（= 旧价 6×Q5）最优采购对照 ─────────────────────
// 采购器：固定 6 编制；贪心把预算花在“更高品质”与“给核心升星（3 张合成）”上。
function bestTeamUnderBudget(prices, budget) {
  // 先决定全队品质档 q（6 张 × 价格 ≤ 预算的最大 q），再用余额给 1 个核心买 2 张冲 2 星。
  let q = 5;
  while (q > 1 && prices[q - 1] * 6 > budget) q--;
  let spent = prices[q - 1] * 6;
  let coreStars = 1, coreQuality = q;
  // 升级路径：把核心换到更高品质（3 张）优先，其次 2 星（再买 2 张）。
  if (spent + prices[q - 1] * 2 <= budget) { coreStars = 2; spent += prices[q - 1] * 2; }
  let upgraded = false;
  if (q < 5 && spent + prices[q] * 3 <= budget) { coreQuality = q + 1; coreStars = 1; spent += prices[q] * 3; }
  const units = STANDARD_TEAM.map((defId, i) => i === 0
    ? { unitId: 'core', defId, quality: coreQuality, stars: coreStars, itemDefIds: [] }
    : { unitId: 'u' + i, defId, quality: q, stars: 1, itemDefIds: [] });
  return { units, spent, avgQuality: +(units.reduce((s, u) => s + u.quality, 0) / 6).toFixed(2) };
}
const OLD_PRICES = [10, 11, 13, 15, 17], NEW_PRICES = DUEL_QUALITY.shopGold;
const priceRows = {};
for (const budget of [60, 72, 84, 102]) {
  for (const [name, prices] of [['old_10_11_13_15_17', OLD_PRICES], ['new_10_11_12_13_14', NEW_PRICES]]) {
    const built = bestTeamUnderBudget(prices, budget);
    priceRows[`budget${budget}_${name}`] = { ...built, vsFixedQ3: fight(built.units, fixedEnemy, seedsOf(300)), priceTable: prices, budget };
  }
}
report.experiments.sameBudgetPriceTables = priceRows;

// ── C 星级组：新倍率（本内核）vs 旧倍率（battle.ts 旧内核）的提升幅度 ────────
function duelStarUplift(stars) {
  return fight(teamUnits(STANDARD_TEAM, 1, stars), fixedEnemy, seedsOf(300)).aRate;
}
function legacyStarUplift(stars) {
  // 旧内核：createBattle + enemyTeam（旧星级 HP×1.12/攻×1.08、技能不随星级）。
  const mk = q => STANDARD_TEAM.map((defId, i) => ({ uid: 'p' + i, defId, rank: q, best: 0, stars }));
  let won = 0;
  const seeds = seedsOf(300);
  for (const seed of seeds) {
    const battle = createBattle(mk(1), seed, SLOTS, { enemyTeam: mk(3).map(c => ({ ...c, stars: 1 })) });
    if (battle.outcome === 'won') won++;
  }
  return +(won / seeds.length).toFixed(4);
}
const starRows = { newMultipliers: {}, oldMultipliersLegacyEngine: {} };
for (const stars of [1, 2, 3]) starRows.newMultipliers['star' + stars] = duelStarUplift(stars);
for (const stars of [1, 2, 3]) starRows.oldMultipliersLegacyEngine['star' + stars] = legacyStarUplift(stars);
starRows.newMultipliers.cost3xQ1 = 3 * 10; // 2★ 成本 30；3★ 90
report.experiments.starMultipliers = starRows;

// ── D/E 全十轮经营模拟（真实规则：商店/价格/合星/人口/野怪/PvP 同内核）──────
function xorshift(s) { let x = s >>> 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; }
class Player {
  constructor(name, strategy, seed) {
    this.name = name; this.strategy = strategy; this.rng = seed >>> 0;
    this.gold = 40; this.hp = 32; this.roster = []; this.formation = [];
    this.population = 3; this.shop = []; this.shopLocked = false;
    this.nextId = 1; this.items = []; this.history = [];
    this.defs = STANDARD_TEAM.slice(0, 8).map((defId, i) => ({ defId, quality: i < 2 ? 3 : i < 5 ? 2 : 1 })); // 混合品质 8 卡池
    this.rollShop();
    // 两张免费开局副本（basis 0）
    for (const defId of [this.defs[0].defId, this.defs[3].defId]) this.roster.push({ unitId: 'u' + this.nextId++, defId, quality: this.defs.find(d => d.defId === defId).quality, stars: 1, basis: 0, equippedItemIds: [] });
    this.autoDeploy();
  }
  rand() { this.rng = xorshift(this.rng || 1); return this.rng / 4294967296; }
  rollShop() {
    this.shop = Array.from({ length: 5 }, () => {
      const def = this.defs[Math.floor(this.rand() * this.defs.length)];
      return { offerId: 'o' + (this.nextId++), defId: def.defId, quality: def.quality, cost: NEW_PRICES[def.quality - 1] };
    });
  }
  role(unit) { return getCombatStats({ uid: 'x', defId: unit.defId, rank: unit.quality, best: 0 }).role; }
  autoDeploy() {
    const melee = { 坦克: 0, 战士: 1, 刺客: 2 };
    const units = [...this.roster].sort((a, b) => (melee[this.role(a)] ?? 9) - (melee[this.role(b)] ?? 9) || b.stars - a.stars).slice(0, this.population);
    let front = 0, back = 0;
    this.formation = units.map(u => ({ unitId: u.unitId, localSlot: melee[this.role(u)] !== undefined ? [1, 3, 5, 8, 10, 12][front++] : [22, 24, 26, 15, 17, 19][back++] }));
  }
  merge() {
    for (let stars = 1; stars < 3; stars++) for (const key of new Set(this.roster.map(u => u.defId + ':' + u.quality))) {
      let copies = this.roster.filter(u => u.defId + ':' + u.quality === key && u.stars === stars);
      while (copies.length >= 3) {
        copies.sort((a, b) => Number(this.formation.some(p => p.unitId === b.unitId)) - Number(this.formation.some(p => p.unitId === a.unitId)) || (a.unitId < b.unitId ? -1 : 1));
        const group = copies.slice(0, 3), keeper = group[0], removed = new Set(group.slice(1).map(u => u.unitId));
        keeper.stars++; keeper.basis = group.reduce((s, u) => s + u.basis, 0);
        this.roster = this.roster.filter(u => !removed.has(u.unitId));
        this.formation = this.formation.filter(p => !removed.has(p.unitId));
        copies = this.roster.filter(u => u.defId + ':' + u.quality === key && u.stars === stars);
      }
    }
  }
  buy(offer) { if (this.gold < offer.cost) return false; this.gold -= offer.cost; this.roster.push({ unitId: 'u' + this.nextId++, defId: offer.defId, quality: offer.quality, stars: 1, basis: offer.cost, equippedItemIds: [] }); this.shop = this.shop.filter(o => o.offerId !== offer.offerId); this.merge(); return true; }
  deployBest() { this.autoDeploy(); }
  sideInput() {
    return {
      units: this.formation.map(p => ({ ...this.roster.find(u => u.unitId === p.unitId), itemDefIds: [] })).map(({ unitId, defId, quality, stars, itemDefIds }) => ({ unitId, defId, quality, stars, itemDefIds })),
      formation: this.formation.map(p => ({ unitId: p.unitId, localSlot: p.localSlot })),
    };
  }
}
const STRATEGIES = {
  instant_fill: (p, round) => { // 即时补阵：能买就买（优先阵容内卡种），买不起再刷新
    for (let pass = 0; pass < 6; pass++) {
      const affordable = p.shop.filter(o => o.cost <= p.gold).sort((a, b) => b.quality - a.quality)[0];
      if (affordable && p.roster.length < 14) { p.buy(affordable); continue; }
      if (p.gold >= 10 + NEW_PRICES[0]) { p.gold -= 10; p.rollShop(); continue; }
      break;
    }
    p.deployBest();
  },
  save_to_30: (p, round) => { // 适度存钱：R6 前保 ≥30 拿利息，只买阵容缺口
    const reserve = round >= 6 ? 0 : 30;
    for (let pass = 0; pass < 4; pass++) {
      const useful = p.shop.filter(o => o.cost + reserve <= p.gold && p.roster.filter(u => u.defId === o.defId).length >= 1 || o.cost <= p.gold - reserve && p.roster.length < 8);
      const pick = useful.sort((a, b) => b.quality - a.quality)[0];
      if (pick) { p.buy(pick); continue; }
      break;
    }
    p.deployBest();
  },
  allin_core: (p, round) => { // 重押本命：疯狂刷新买核心卡（moon-deer）冲 3 星
    const core = 'moon-deer';
    for (let pass = 0; pass < 8; pass++) {
      const coreOffer = p.shop.find(o => o.defId === core && o.cost <= p.gold);
      if (coreOffer && p.roster.filter(u => u.defId === core).length < 9) { p.buy(coreOffer); continue; }
      const anyCore = p.shop.filter(o => o.cost <= p.gold).sort((a, b) => (a.defId === core ? 1 : 0) - (b.defId === core ? 1 : 0) || b.quality - a.quality)[0];
      if (anyCore && p.roster.length < 13 && p.gold > 30) { p.buy(anyCore); continue; }
      if (p.gold >= 20) { p.gold -= 10; p.rollShop(); continue; }
      break;
    }
    p.deployBest();
  },
};
function runMatch(strategyA, strategyB, baseSeed, options = {}) {
  if (!Number.isInteger(baseSeed) || baseSeed <= 0) throw new Error('baseSeed 必须是正整数（防止 NaN→0 造成假重复样本）');
  const interestCap = options.interest === false ? 0 : DUEL_GOLD.interest.cap;
  const a = new Player('A', STRATEGIES[strategyA], (baseSeed * 2654435761) >>> 0);
  const b = new Player('B', STRATEGIES[strategyB], (baseSeed * 40503) >>> 0);
  const trace = [];
  let combatSeed = (baseSeed * 97) >>> 0;
  for (let round = 1; round <= 10; round++) {
    const rule = duelRoundRule(round);
    a.population = b.population = rule.population;
    if (round >= 2) { a.gold += 20; b.gold += 20; }
    if (!a.shopLocked) a.rollShop(); if (!b.shopLocked) b.rollShop();
    a.strategy(a, round); b.strategy(b, round);
    combatSeed = xorshift(combatSeed);
    let outcome;
    if (rule.kind === 'neutral') {
      const camp = buildNeutralUnits(round);
      const neutralSide = { units: camp.map(m => ({ kind: 'neutral', ...m })), formation: camp.map(m => ({ unitId: m.unitId, localSlot: m.localSlot })) };
      const simA = simulateDuel({ roundNumber: round, combatSeed, rulesVersion: DUEL_RULES_VERSION, sideA: a.sideInput(), sideB: neutralSide });
      const simB = simulateDuel({ roundNumber: round, combatSeed: xorshift(combatSeed), rulesVersion: DUEL_RULES_VERSION, sideA: b.sideInput(), sideB: neutralSide });
      const camp2 = duelNeutralCamp(round);
      for (const [p, sim] of [[a, simA], [b, simB]]) { p.gold += camp2.guaranteedGold; if (sim.winner === 'A') p.gold += camp2.winBonusGold; }
      outcome = { kind: 'neutral', aWon: simA.winner === 'A', bWon: simB.winner === 'B' };
    } else {
      const sim = simulateDuel({ roundNumber: round, combatSeed, rulesVersion: DUEL_RULES_VERSION, sideA: a.sideInput(), sideB: b.sideInput() });
      if (sim.winner === 'A') b.hp = Math.max(0, b.hp - rule.pvpLossHp);
      else if (sim.winner === 'B') a.hp = Math.max(0, a.hp - rule.pvpLossHp);
      if (round < 10) { a.gold += 2; b.gold += 2; }
      outcome = { kind: 'pvp', winner: sim.winner };
    }
    if (round < 10) { for (const p of [a, b]) p.gold += Math.min(interestCap, Math.floor(p.gold / 30)); }
    trace.push({ round, kind: rule.kind, outcome, aGold: a.gold, bGold: b.gold, aHp: a.hp, bHp: b.hp, aTwo: a.roster.filter(u => u.stars >= 2).length, bTwo: b.roster.filter(u => u.stars >= 2).length, aThree: a.roster.filter(u => u.stars === 3).length, bThree: b.roster.filter(u => u.stars === 3).length });
    if (a.hp <= 0 || b.hp <= 0) break;
  }
  const winner = a.hp <= 0 && b.hp <= 0 ? null : a.hp <= 0 ? 'B' : b.hp <= 0 ? 'A' : a.hp > b.hp ? 'A' : b.hp > a.hp ? 'B' : null;
  const formRound = trace.find(t => t.aTwo >= 4)?.round ?? null;
  return { winner, rounds: trace.length, aFinalGold: a.gold, bFinalGold: b.gold, aHp: a.hp, bHp: b.hp, formRoundA: formRound, aThree: a.roster.filter(u => u.stars === 3).length, trace };
}
function pairExperiment(nameA, nameB, n, runner) {
  const run = runner ?? ((s1, s2, seed) => runMatch(s1, s2, seed));
  let a = 0, b = 0, draw = 0;
  const formRounds = [], finals = [], threes = [];
  let neutralWinA = [0, 0, 0], neutralRuns = [0, 0, 0]; // R1/R4/R7
  for (let i = 0; i < n; i++) {
    const result = run(nameA, nameB, 1000 + i * 131);
    if (result.winner === 'A') a++; else if (result.winner === 'B') b++; else draw++;
    if (result.formRoundA) formRounds.push(result.formRoundA);
    finals.push(result.aFinalGold); threes.push(result.aThree);
    result.trace.filter(t => t.kind === 'neutral').forEach((t, idx) => { neutralRuns[idx]++; if (t.outcome.aWon) neutralWinA[idx]++; });
  }
  const sorted = [...formRounds].sort((x, y) => x - y);
  const pct = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
  return { n, a, b, draw, aRate: +(a / n).toFixed(3), formRoundP50: pct(0.5), formRoundP90: pct(0.9), unformedRate: +(1 - formRounds.length / n).toFixed(3), threeStarRate: +(threes.filter(x => x > 0).length / n).toFixed(3), avgFinalGoldA: +(finals.reduce((s, x) => s + x, 0) / n).toFixed(1), neutralWinRateA: neutralWinA.map((w, i) => +(w / (neutralRuns[i] || 1)).toFixed(3)) };
}
report.experiments.fullMatch = {
  instant_vs_save: pairExperiment('instant_fill', 'save_to_30', 120),
  instant_vs_allin: pairExperiment('instant_fill', 'allin_core', 120),
  save_vs_allin: pairExperiment('save_to_30', 'allin_core', 120),
  instant_mirror: pairExperiment('instant_fill', 'instant_fill', 120),
};
// D 利息组：轻利息 cap=2 vs 无利息，其他参数完全相同（同种子配对）。
report.experiments.interestComparison = (() => {
  const n = 120;
  const withInterest = pairExperiment('save_to_30', 'instant_fill', n, (s1, s2, seed) => runMatch(s1, s2, seed));
  const noInterest = pairExperiment('save_to_30', 'instant_fill', n, (s1, s2, seed) => runMatch(s1, s2, seed, { interest: false }));
  return { note: '同种子配对：save_to_30 策略在 cap=2 与 cap=0 下的终局差异', withInterest, noInterest };
})();
report.samples = { fixedEnemySeeds: 300, fullMatchPairs: 120 };

writeFileSync(resolve(OUT, 'balance-report.json'), JSON.stringify(report, null, 2));
// 可读文本摘要
const lines = [];
lines.push('星序 ASTERIA｜双人短局 DUEL-RULES-1 数值验证报告（起测参数，非平衡定论）');
lines.push('生成时间 ' + report.generatedAt + '｜样本：固定敌阵 300 种子 / 策略对 120 局');
lines.push('');
lines.push('A 品质组（固定 Q3 ★1 敌阵，同阵容全队同品质）：');
for (const q of [1, 2, 3, 4, 5]) lines.push(`  Q${q}（6 张花费 ${qualityRows['Q' + q].cost} 金）胜率 ${(qualityRows['Q' + q].aRate * 100).toFixed(1)}%（draw ${qualityRows['Q' + q].draw}）`);
lines.push('');
lines.push('B 价格组（同预算最优采购 vs 固定 Q3 敌阵，多预算扫描）：');
for (const budget of [60, 72, 84, 102]) {
  const oldRow = priceRows[`budget${budget}_old_10_11_13_15_17`], newRow = priceRows[`budget${budget}_new_10_11_12_13_14`];
  lines.push(`  预算 ${budget} 金：旧价表 → 花费 ${oldRow.spent} / 均品质 ${oldRow.avgQuality} / 胜率 ${(oldRow.vsFixedQ3.aRate * 100).toFixed(1)}%｜新价表 → 花费 ${newRow.spent} / 均品质 ${newRow.avgQuality} / 胜率 ${(newRow.vsFixedQ3.aRate * 100).toFixed(1)}%`);
}
lines.push('');
lines.push('C 星级组（★1 阵容 vs 固定 Q3 ★1 敌阵的胜率提升）：');
lines.push('  新倍率 HP1/1.35/1.8 攻1/1.25/1.6 技能1/1.1/1.2：' + [1, 2, 3].map(s => `★${s} ${(starRows.newMultipliers['star' + s] * 100).toFixed(1)}%`).join(' → '));
lines.push('  旧倍率(旧内核) HP×1.12/星 攻×1.08/星 技能不变：' + [1, 2, 3].map(s => `★${s} ${(starRows.oldMultipliersLegacyEngine['star' + s] * 100).toFixed(1)}%`).join(' → '));
lines.push('  参考成本：Q1 2★=30 金、3★=90 金（三/九张）。');
lines.push('');
lines.push('D 利息组（同种子配对：save_to_30 vs instant_fill，cap=2 vs cap=0）：');
{
  const w = report.experiments.interestComparison.withInterest, n0 = report.experiments.interestComparison.noInterest;
  lines.push(`  有利息：A 胜率 ${(w.aRate * 100).toFixed(1)}%｜A 平均终局金币 ${w.avgFinalGoldA}｜A 3★ 出现率 ${(w.threeStarRate * 100).toFixed(0)}%`);
  lines.push(`  无利息：A 胜率 ${(n0.aRate * 100).toFixed(1)}%｜A 平均终局金币 ${n0.avgFinalGoldA}｜A 3★ 出现率 ${(n0.threeStarRate * 100).toFixed(0)}%`);
}
lines.push('');
lines.push('E 全十轮经营模拟（真实商店/价格/合星/人口/野怪/PvP，120 局/组）：');
for (const [name, row] of Object.entries(report.experiments.fullMatch)) {
  lines.push(`  ${name}：A 胜率 ${(row.aRate * 100).toFixed(1)}%（A=${row.a} B=${row.b} 平=${row.draw}）｜A 4×2★ 成型轮 P50=${row.formRoundP50} P90=${row.formRoundP90} 未成型 ${(row.unformedRate * 100).toFixed(0)}%｜A 3★ 出现率 ${(row.threeStarRate * 100).toFixed(0)}%｜A 平均终局金币 ${row.avgFinalGoldA}`);
  lines.push(`    A 野怪 R1/R4/R7 胜率：${row.neutralWinRateA.map(x => (x * 100).toFixed(0) + '%').join(' / ')}`);
}
lines.push('');
lines.push('说明：全部为可复现离线模拟（种子固定），不是实机对战数据；策略为简单脚本策略，');
lines.push('不覆盖真人站位 / 卖卡 / 装备分配维度；结论用于发现过价 / 失衡风险，不作为已平衡声明。');
writeFileSync(resolve(OUT, 'balance-report.txt'), lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
console.log('\n写入 ' + OUT);
