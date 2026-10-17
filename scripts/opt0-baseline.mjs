#!/usr/bin/env node
// O0 只观测 DUEL-RULES-1；不调参、不启动业务服务、不读取真实数据库。
// Windows: node --experimental-strip-types scripts/opt0-baseline.mjs --out <新 JSON 路径>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { CARDS, CARD_MAP } from '../src/data.ts';
import { getCombatStats } from '../src/battle.ts';
import { simulateDuel } from '../src/duel-sim.ts';
import { buildNeutralUnits } from '../src/neutral.ts';
import { DUEL_ITEMS } from '../src/equipment.ts';
import { DUEL_RULES_VERSION, DUEL_LOADOUT, DUEL_STARS, duelShopPrice, duelRoundRule } from '../src/duel-rules.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 此脚本只重放 / 生成 v1 黄金基线；产品规则可以继续升版，但 v1 证据不覆盖。
const BASELINE_RULES_VERSION = 1;
const sha = value => createHash('sha256').update(value).digest('hex');
const roleOf = defId => getCombatStats({ uid: 'audit', defId, rank: 1, best: 0 }).role;
const front = role => ['坦克', '战士'].includes(role);
const ranged = role => ['射手', '法师'].includes(role);

// 仅是当前 v1 的代理阵容；日系没有灼烧，月系没有控制，不能验证 v2 克制环。
export const BASELINE_ARCHETYPES = [
  { id: 'moon_shield', name: '月盾混编', deployed: ['moon-deer', 'sun-cub', 'star-deer', 'moon-fawn', 'mist-deer', 'sun-fox'], reserves: ['crescent-dancer', 'lunar-guide'] },
  { id: 'sun_damage', name: '日系火力', deployed: ['moon-deer', 'sun-cub', 'sun-fox', 'golden-fox', 'dawn-fox', 'solar-prism'], reserves: ['amber-pause', 'sun-first'] },
  { id: 'forest_frontline', name: '森林前排', deployed: ['forest-rabbit', 'forest-sprout', 'verdant-rabbit', 'clover-step', 'emerald-mirror', 'breeze-sprout'], reserves: ['moss-tide', 'bough-embrace'] },
  { id: 'ranged_wall', name: '远程双坦', deployed: ['moon-deer', 'sun-cub', 'star-deer', 'dawn-fox', 'sun-fox', 'breeze-sprout'], reserves: ['fern-opener', 'twig-change'] },
  { id: 'assassin_dive', name: '刺客切后', deployed: ['moon-deer', 'sun-cub', 'moon-fawn', 'mist-deer', 'lunar-guide', 'silver-gap'], reserves: ['sun-fox', 'star-deer'] },
].map(a => ({ ...a, loadout: [...a.deployed, ...a.reserves] }));
export const BASELINE_VARIANTS = [
  { id: 'q1_s1', name: 'Q1 全一星', quality: 1, coreStars: 1 },
  { id: 'q3_s1', name: 'Q3 全一星', quality: 3, coreStars: 1 },
  { id: 'q1_core2', name: 'Q1 前排核心二星', quality: 1, coreStars: 2 },
];

export function validateArchetype(a) {
  assert.equal(a.loadout.length, DUEL_LOADOUT.definitionCount, '牌组必须恰好八卡种');
  assert.equal(new Set(a.loadout).size, a.loadout.length, '牌组不得重复');
  assert.ok(a.loadout.every(id => Object.hasOwn(CARD_MAP, id)), '未知卡种');
  const roles = a.loadout.map(roleOf);
  assert.ok(roles.some(front), '牌组缺少前排');
  assert.ok(roles.some(ranged), '牌组缺少远程');
  assert.equal(a.deployed.length, 6);
  assert.equal(new Set(a.deployed).size, 6);
  assert.ok(a.deployed.every(id => a.loadout.includes(id)), '部署单位必须来自牌组');
}

function randomSource(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
function shuffle(values, random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
export function sampleFormations(a, count = 20, seed = 0x41535445) {
  validateArchetype(a);
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 100, '站位样本数量必须为 1–100');
  const random = randomSource(seed), result = [], seen = new Set();
  for (let attempt = 0; result.length < count && attempt < count * 100; attempt++) {
    const used = new Set();
    const slots = a.deployed.map(defId => {
      // 2/3 样本前后排分区，1/3 完全散布；只表示测试采样，不表示推荐站位。
      const choices = Array.from({ length: 28 }, (_, i) => i).filter(i => !used.has(i)
        && (attempt % 3 === 2 || (ranged(roleOf(defId)) ? i >= 14 : i < 14)));
      const slot = shuffle(choices, random)[0]; used.add(slot); return slot;
    });
    const key = JSON.stringify(slots);
    if (!seen.has(key)) { seen.add(key); result.push(slots); }
  }
  assert.equal(result.length, count, '未能生成足够互异站位');
  return result;
}

export function makeSide(a, variant, slots, options = {}) {
  const count = options.count ?? 6;
  const units = a.deployed.slice(0, count).map((defId, i) => ({ unitId: 'u' + i, defId,
    quality: variant.quality, stars: i === 0 ? variant.coreStars : 1, itemDefIds: [] }));
  for (const item of options.items ?? (options.item ? [options.item] : [])) {
    assert.ok(DUEL_ITEMS.some(d => d.id === item), '未知测试装备');
    let holder = 0;
    if (!['stone_mail', 'dawn_charm'].includes(item)) {
      const preferred = item === 'astral_lens' ? '法师' : '射手';
      holder = Math.max(0, units.findIndex(u => roleOf(u.defId) === preferred));
    }
    assert.ok(units[holder].itemDefIds.length < 2, '装备不得超过两槽');
    assert.ok(!units[holder].itemDefIds.includes(item), '同组装备不得重复');
    units[holder].itemDefIds.push(item);
  }
  return { units, formation: units.map((u, i) => ({ unitId: u.unitId, localSlot: slots[i] })) };
}
const sideCost = side => side.units.reduce((sum, u) => sum + duelShopPrice(u.quality) * DUEL_STARS.requiredCopies ** (u.stars - 1), 0);
export function pairedInputs(left, right, roundNumber) {
  return [false, true].flatMap(swapped => [0, 1].map(combatSeed => ({ swapped,
    input: { roundNumber, combatSeed, sideA: swapped ? right : left, sideB: swapped ? left : right } })));
}
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0; };
const observedWinner = sample => sample.winner === null ? null : sample.winner === (sample.swapped ? 'B' : 'A') ? 'left' : 'right';
export function summarizeSamples(samples) {
  assert.ok(samples.length > 0);
  const n = samples.length, wins = samples.filter(s => observedWinner(s) === 'left').length;
  const draws = samples.filter(s => s.winner === null).length;
  const sum = key => samples.reduce((total, s) => total + s[key], 0);
  const damage = {};
  for (const s of samples) for (const [id, value] of Object.entries(s.damage)) damage[id] = (damage[id] ?? 0) + value / n;
  return { n, wins, losses: n - wins - draws, draws, winRate: wins / n, drawRate: draws / n,
    timeouts: samples.filter(s => s.reason === 'round-limit').length,
    timeoutRate: samples.filter(s => s.reason === 'round-limit').length / n,
    meanRounds: sum('rounds') / n, roundsP95: percentile(samples.map(s => s.rounds), .95),
    meanFrames: sum('frames') / n, meanReplayBytes: sum('bytes') / n,
    meanSkillCastsBothSides: sum('skills') / n, meanBlockedMovesBothSides: sum('blockedMoves') / n,
    meanHpDamageByLeftUnit: damage,
    performanceMs: { p50: percentile(samples.map(s => s.elapsedMs), .5), p95: percentile(samples.map(s => s.elapsedMs), .95) } };
}

export function buildBaseline({ positionCount = 20, fixedSeedCount = 300 } = {}) {
  assert.equal(BASELINE_RULES_VERSION, 1, '此基线脚本仅用于 v1；v2 应另建对照，不覆盖 v1');
  assert.ok(DUEL_RULES_VERSION >= BASELINE_RULES_VERSION, '产品规则版本不能低于 v1');
  assert.ok(Number.isInteger(fixedSeedCount) && fixedSeedCount >= 2 && fixedSeedCount <= 1000);
  for (const a of BASELINE_ARCHETYPES) validateArchetype(a);
  const formations = BASELINE_ARCHETYPES.map((a, i) => sampleFormations(a, positionCount, 0x41535445 + i * 7919));
  const allSamples = [], goldens = new Map();
  function run(input, swapped, golden = false) {
    const started = performance.now(), result = simulateDuel({ ...input, rulesVersion: BASELINE_RULES_VERSION }), elapsedMs = performance.now() - started;
    const serialized = JSON.stringify(result), resultHash = sha(serialized);
    const logs = result.frames.flatMap(f => f.logs), last = result.frames.at(-1);
    const damage = Object.fromEntries((swapped ? last.sideB : last.sideA).map(u => [u.defId ?? u.unitId, u.damageDealt]));
    const sample = { winner: result.winner, swapped, reason: result.reason, rounds: result.summary.rounds,
      frames: result.frames.length, elapsedMs, bytes: Buffer.byteLength(serialized),
      skills: logs.filter(l => l.kind === 'skill').length, blockedMoves: logs.filter(l => l.kind === 'move' && l.amount === 0).length,
      damage, resultHash };
    allSamples.push(sample);
    if (golden) goldens.set(sha(JSON.stringify(input)), { input, resultHash, winner: result.winner, reason: result.reason,
      finalHp: { A: last.sideA.map(u => u.hp), B: last.sideB.map(u => u.hp) } });
    return sample;
  }
  function paired(leftAt, rightAt, roundNumber) {
    const samples = [], blocks = [];
    let pairedWinnerMismatches = 0;
    for (let i = 0; i < positionCount; i++) {
      const block = pairedInputs(leftAt(i), rightAt(i), roundNumber).map(c => run(c.input, c.swapped, i === 0));
      // 相同战况旋转换边时还须翻转先手奇偶；只审计胜负，不假定当前寻路已严格镜像。
      pairedWinnerMismatches += Number(observedWinner(block[0]) !== observedWinner(block[3]));
      pairedWinnerMismatches += Number(observedWinner(block[1]) !== observedWinner(block[2]));
      samples.push(...block); blocks.push(summarizeSamples(block).winRate);
    }
    return { ...summarizeSamples(samples), positionBlocks: positionCount,
      positionBlockWinRateRange: [Math.min(...blocks), Math.max(...blocks)],
      pairedWinnerMismatches, pairedWinnerComparisons: positionCount * 2 };
  }

  const matrix = BASELINE_VARIANTS.map(variant => {
    const matchups = [];
    for (let i = 0; i < BASELINE_ARCHETYPES.length; i++) for (let j = i; j < BASELINE_ARCHETYPES.length; j++) {
      const leftAt = k => makeSide(BASELINE_ARCHETYPES[i], variant, formations[i][k]);
      const rightAt = k => makeSide(BASELINE_ARCHETYPES[j], variant, formations[j][(k + 1) % positionCount]);
      const leftCost = sideCost(leftAt(0)), rightCost = sideCost(rightAt(0));
      assert.equal(leftCost, rightCost, '同一预算层的双方成本必须相同');
      matchups.push({ left: BASELINE_ARCHETYPES[i].id, right: BASELINE_ARCHETYPES[j].id,
        leftCost, rightCost, ...paired(leftAt, rightAt, 8) });
    }
    return { ...variant, matchups };
  });

  // 保留旧报告的固定阵容实验，仅用于证明 seed 重复与报告漂移，不算独立统计样本。
  const standard = { deployed: ['moon-deer', 'forest-rabbit', 'moon-fawn', 'sun-fox', 'sun-cub', 'forest-sprout'] };
  const fixedSlots = [1, 3, 5, 22, 24, 26], fixedEnemy = makeSide(standard, BASELINE_VARIANTS[1], fixedSlots);
  const qualityFixedLineup = [1, 2, 3, 4, 5].map(quality => {
    const side = makeSide(standard, { quality, coreStars: 1 }, fixedSlots);
    const samples = Array.from({ length: fixedSeedCount }, (_, i) => run({ roundNumber: 5,
      combatSeed: (1 + i * 7919) >>> 0, sideA: side, sideB: fixedEnemy }, false, i < 2));
    return { quality, leftCost: sideCost(side), rightCost: sideCost(fixedEnemy),
      uniqueReplayHashes: new Set(samples.map(s => s.resultHash)).size, ...summarizeSamples(samples) };
  });
  const standardFormations = sampleFormations({ ...standard, loadout: [...standard.deployed, 'star-deer', 'dawn-fox'] }, positionCount, 20261015);
  const starSensitivity = [1, 2, 3].map(coreStars => {
    const leftAt = i => makeSide(standard, { quality: 3, coreStars }, standardFormations[i]);
    const rightAt = i => makeSide(standard, BASELINE_VARIANTS[1], standardFormations[(i + 1) % positionCount]);
    return { coreStars, leftCost: sideCost(leftAt(0)), rightCost: sideCost(rightAt(0)), ...paired(leftAt, rightAt, 8) };
  });

  const neutrals = [];
  for (const [i, a] of BASELINE_ARCHETYPES.entries()) {
    for (const round of [1, 4, 7]) for (const profile of ['low_investment', 'developed']) {
      const camp = buildNeutralUnits(round);
      const enemy = { units: camp.map(u => ({ kind: 'neutral', ...u })), formation: camp.map(u => ({ unitId: u.unitId, localSlot: u.localSlot })) };
      const items = profile === 'developed' ? (round === 1 ? [] : round === 4 ? ['dawn_charm'] : ['dawn_charm', 'edge_sigil']) : [];
      const variant = profile === 'developed' ? { quality: 3, coreStars: round === 1 ? 1 : 2 } : BASELINE_VARIANTS[0];
      const playerAt = k => makeSide(a, variant, formations[i][k], { count: duelRoundRule(round).population, items });
      neutrals.push({ archetype: a.id, round, profile, player: playerAt(0).units, grossCost: sideCost(playerAt(0)),
        ...paired(playerAt, () => enemy, round) });
    }
    const camp = buildNeutralUnits(1);
    const enemy = { units: camp.map(u => ({ kind: 'neutral', ...u })), formation: camp.map(u => ({ unitId: u.unitId, localSlot: u.localSlot })) };
    neutrals.push({ archetype: a.id, round: 1, profile: 'two_free_q1', grossCost: 0,
      player: makeSide(a, BASELINE_VARIANTS[0], formations[i][0], { count: 2 }).units,
      ...paired(k => makeSide(a, BASELINE_VARIANTS[0], formations[i][k], { count: 2 }), () => enemy, 1) });
  }
  const items = [];
  for (const [i, a] of BASELINE_ARCHETYPES.entries()) for (const item of [null, ...DUEL_ITEMS.map(d => d.id)]) {
    const playerAt = k => makeSide(a, BASELINE_VARIANTS[1], formations[i][k], { item });
    const enemyAt = k => makeSide(BASELINE_ARCHETYPES[3], BASELINE_VARIANTS[1], formations[3][(k + 1) % positionCount]);
    const result = paired(playerAt, enemyAt, 8);
    const base = item === null ? result.winRate : items.find(r => r.archetype === a.id && r.item === null).winRate;
    items.push({ archetype: a.id, item, holder: playerAt(0).units.find(u => u.itemDefIds.length)?.defId ?? null,
      winRateDelta: result.winRate - base, ...result });
  }
  const roleCounts = {}, byAffinity = {};
  for (const card of CARDS) {
    const role = roleOf(card.id); roleCounts[role] = (roleCounts[role] ?? 0) + 1;
    byAffinity[card.affinity] ??= {}; byAffinity[card.affinity][role] = (byAffinity[card.affinity][role] ?? 0) + 1;
  }
  const files = Object.fromEntries(['src/data.ts', 'src/battle.ts', 'src/duel-sim.ts', 'src/duel-rules.ts', 'src/equipment.ts',
    'src/neutral.ts', 'src/hex.ts', 'server/duel.mjs', 'scripts/opt0-baseline.mjs'].map(path => [path, sha(readFileSync(resolve(ROOT, path)))]));
  let gitHead = null;
  try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* 文件哈希仍可复核。 */ }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), userDate: '2026-10-15', rulesVersion: BASELINE_RULES_VERSION,
    provenance: { node: process.version, gitHead, files, note: '文件哈希对应运行时工作树，不仅是 HEAD；耗时受机器与并发负载影响。' },
    methodology: { positionCount, parityCases: [0, 1], swapSeats: true, independentSeedSamples: false,
      matrixEquipment: 'none_controlled', ownershipAssumption: '离线夹具假定拥有八卡种且最高 Q5，非真实用户收藏',
      budget: '采购总成本=价格×3^(星级−1)，不扣免费副本；同预算只在同矩阵层比较。品质/星级敏感性并非同预算实验。',
      caveats: ['v1 代理阵容，不验证 v2 克制环', '站位块是设计采样而非真人总体随机抽样，不报告伪独立 seed 置信区间',
        '野怪是独立轮次快照，不声称经过十轮真实商店可达', '装备单件对远程双坦敏感性，不代表全阵容最优分配',
        '伤害贡献仅统计实际生命损失，不含护盾吸收；回放体积按 JSON UTF-8 未压缩字节', '换边胜负不一致只记录，不修改 v1 寻路'] },
    catalog: { count: CARDS.length, roleCounts, byAffinity }, archetypes: BASELINE_ARCHETYPES,
    formations, matrix, qualityFixedLineup, starSensitivity, neutrals, items,
    aggregate: summarizeSamples(allSamples), goldenCases: [...goldens.values()] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--out', '--positions', '--fixed-seeds'].includes(args[i]) && args[i + 1], '参数仅支持 --out / --positions / --fixed-seeds');
    assert.ok(!Object.hasOwn(options, args[i]), '参数不能重复'); options[args[i]] = args[i + 1];
  }
  const output = resolve(ROOT, options['--out'] ?? ('artifacts/opt0/' + new Date().toISOString().replace(/[:.]/g, '-') + '/baseline.json'));
  assert.ok(!existsSync(output), '拒绝覆盖已有报告，请指定新路径：' + output);
  const report = buildBaseline({ positionCount: Number(options['--positions'] ?? 20), fixedSeedCount: Number(options['--fixed-seeds'] ?? 300) });
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, simulations: report.aggregate.n, goldenCases: report.goldenCases.length,
    timeoutRate: report.aggregate.timeoutRate, meanRounds: report.aggregate.meanRounds, performanceMs: report.aggregate.performanceMs }, null, 2));
}
