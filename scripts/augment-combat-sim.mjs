#!/usr/bin/env node
// 星契战斗强度体检（起测证据，不是正式平衡结论）：同一镜像阵容，A 方带一张星契，
// B 方不带，跑固定种子集合，报告 A 的胜率 / 平局率。经济类星契没有战斗效果，应接近 50%。
// 用法：node --experimental-strip-types scripts/augment-combat-sim.mjs
import { simulateDuel } from '../src/duel-sim.ts';
import { AUGMENTS, aggregateAugmentEffects } from '../src/augments.ts';

const TEAM = [
  ['moon-deer', 'u1'], ['forest-rabbit', 'u2'], ['moon-fawn', 'u3'],
  ['sun-fox', 'u4'], ['sun-cub', 'u5'], ['forest-sprout', 'u6'],
];
const SLOTS = [1, 3, 5, 22, 24, 26];
const SEEDS = 300;
function duel(seed, augmentIds) {
  const units = TEAM.map(([defId, unitId]) => ({ unitId, defId, quality: 1, stars: 1, itemDefIds: [] }));
  const formation = units.map((unit, index) => ({ unitId: unit.unitId, localSlot: SLOTS[index] }));
  return simulateDuel({
    roundNumber: 1, combatSeed: seed, rulesVersion: 2,
    sideA: { units, formation, augments: augmentIds },
    sideB: { units, formation, augments: [] },
  });
}
function measure(augmentIds) {
  let a = 0, b = 0, draw = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const result = duel(seed, augmentIds);
    if (result.winner === 'A') a++; else if (result.winner === 'B') b++; else draw++;
  }
  return { a, b, draw, winRate: (a / SEEDS * 100).toFixed(1) };
}
const rows = [];
for (const augment of AUGMENTS) {
  const effects = aggregateAugmentEffects([augment.id]);
  const hasCombat = effects.hpPct || effects.attackPct || effects.openingShieldPct || effects.armorFlat
    || Object.values(effects.roleHpPct).some(Boolean) || Object.values(effects.roleAttackPct).some(Boolean)
    || effects.traitBonuses.length;
  const result = measure([augment.id]);
  rows.push({ id: augment.id, name: augment.name, tier: augment.tier, category: augment.category, combat: !!hasCombat, ...result });
}
rows.sort((x, y) => Number(y.winRate) - Number(x.winRate));
console.log('星契战斗体检：镜像 6v6，A 带星契 vs B 不带，' + SEEDS + ' 种子（起测证据，非正式平衡）');
console.log('档位 | 类别 | 星契 | 战斗效果 | A 胜率 | 平局');
for (const row of rows) {
  console.log(`${row.tier} | ${row.category} | ${row.name} | ${row.combat ? '有' : '无'} | ${row.winRate}% | ${row.draw}`);
}
console.log('基线（双方都不带）:', measure([]).winRate + '%');
