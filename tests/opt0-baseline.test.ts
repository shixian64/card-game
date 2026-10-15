import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CARDS } from '../src/data.ts';
import { simulateDuel } from '../src/duel-sim.ts';
import { openStore } from '../server/store.mjs';
import { createGameService } from '../server/game.mjs';
import { createDuelService } from '../server/duel.mjs';
import { BASELINE_ARCHETYPES, BASELINE_VARIANTS, validateArchetype, sampleFormations, makeSide, pairedInputs, summarizeSamples, buildBaseline } from '../scripts/opt0-baseline.mjs';

test('O0：五个 v1 代理阵容均有八个不同卡种、前排与远程，六人均来自牌组', () => {
  assert.equal(BASELINE_ARCHETYPES.length, 5);
  for (const archetype of BASELINE_ARCHETYPES) {
    validateArchetype(archetype);
    assert.equal(archetype.loadout.length, 8);
    assert.equal(new Set(archetype.loadout).size, 8);
    assert.equal(archetype.deployed.length, 6);
  }
  const first = BASELINE_ARCHETYPES[0];
  assert.throws(() => validateArchetype({ ...first, loadout: first.loadout.slice(0, 6) }));
  assert.throws(() => validateArchetype({ ...first, loadout: Array(8).fill('moon-deer') }));
  const moons = CARDS.filter(c => c.affinity === 'moon').slice(0, 8).map(c => c.id);
  assert.throws(() => validateArchetype({ ...first, loadout: moons, deployed: moons.slice(0, 6) }), /远程/);
});

test('O0：站位采样可复现，二十组互异、合法、无重叠，不使用 Math.random', () => {
  for (const archetype of BASELINE_ARCHETYPES) {
    const a = sampleFormations(archetype, 20, 42);
    assert.deepEqual(a, sampleFormations(archetype, 20, 42));
    assert.equal(new Set(a.map(slots => JSON.stringify(slots))).size, 20);
    assert.notDeepEqual(a, sampleFormations(archetype, 20, 43));
    for (const slots of a) {
      assert.equal(slots.length, 6);
      assert.equal(new Set(slots).size, 6);
      assert.ok(slots.every(slot => Number.isInteger(slot) && slot >= 0 && slot < 28));
    }
  }
  assert.throws(() => sampleFormations(BASELINE_ARCHETYPES[0], 0, 42));
});

test('O0：八卡组通过真实房间服务的拥有/品质/前排/远程校验（仅内存夹具）', () => {
  for (const archetype of BASELINE_ARCHETYPES) {
    const store = openStore(':memory:');
    try {
      const game = createGameService(store.db);
      const duel = createDuelService(store.db, { now: () => 1000, secureRandom: () => .5 });
      const user = store.login({ issuer: 'opt0-fixture', clientId: 'opt0', subject: archetype.id, name: archetype.name }).user;
      game.ensureProfile(user);
      const state = JSON.parse(store.db.prepare('SELECT state FROM profiles WHERE user_id=?').get(user.id).state);
      state.cards = archetype.loadout.map((defId, i) => ({ uid: 'c' + (i + 1), defId, rank: 5, best: 0,
        transferPolicy: 'free', originKind: 'draw', originRef: 'opt0-memory-fixture', createdEconomyVersion: 2 }));
      state.nextId = 9;
      const save = () => store.db.prepare('UPDATE profiles SET state=? WHERE user_id=?').run(JSON.stringify(state), user.id);
      save();
      const room = duel.create(user);
      const input = { defs: archetype.loadout.map(defId => ({ defId, battleQuality: 3 })), starters: archetype.deployed.slice(0, 2) };
      assert.equal(duel.loadout(user, room.roomId, input).ok, true);
      state.cards.pop(); save();
      assert.throws(() => duel.loadout(user, room.roomId, input), (error: any) => error.code === 'QUALITY_NOT_OWNED');
    } finally { store.db.close(); }
  }
});

test('O0：每个站位块覆盖两种先手奇偶和两次换边，阵容/装备随玩家一起交换', () => {
  const left = makeSide(BASELINE_ARCHETYPES[0], BASELINE_VARIANTS[0], [1, 3, 5, 22, 24, 26], { item: 'edge_sigil' });
  const right = makeSide(BASELINE_ARCHETYPES[1], BASELINE_VARIANTS[1], [0, 2, 4, 21, 23, 25]);
  const inputs = pairedInputs(left, right, 5);
  assert.equal(inputs.length, 4);
  assert.deepEqual(inputs.map(c => [c.swapped, c.input.combatSeed % 2]), [[false, 0], [false, 1], [true, 0], [true, 1]]);
  assert.deepEqual(inputs[2].input.sideA, right);
  assert.deepEqual(inputs[2].input.sideB, left);
  const before = JSON.stringify(inputs);
  for (const c of inputs) simulateDuel(c.input);
  assert.equal(JSON.stringify(inputs), before, '模拟不得修改基线输入');
});

test('O0：统计按被观察玩家归一化胜负，平局和 round-limit 分开计数', () => {
  const row = summarizeSamples([
    { winner: 'A', swapped: false, reason: 'elimination', rounds: 5, frames: 10, elapsedMs: 1, bytes: 100, skills: 2, blockedMoves: 0, damage: {} },
    { winner: 'B', swapped: true, reason: 'round-limit', rounds: 24, frames: 20, elapsedMs: 3, bytes: 200, skills: 4, blockedMoves: 1, damage: {} },
    { winner: null, swapped: true, reason: 'round-limit', rounds: 24, frames: 30, elapsedMs: 2, bytes: 300, skills: 0, blockedMoves: 2, damage: {} },
  ]);
  assert.equal(row.wins, 2); assert.equal(row.losses, 0); assert.equal(row.draws, 1);
  assert.equal(row.timeouts, 2); assert.equal(row.n, 3);
  assert.equal(row.winRate, 2 / 3);
  assert.equal(row.meanRounds, 53 / 3);
  assert.equal(row.performanceMs.p95, 3);
});

test('O0：小样本报告结构完整、成本口径相同、矩阵互补且不宣称已平衡', () => {
  const report = buildBaseline({ positionCount: 2, fixedSeedCount: 2 });
  assert.equal(report.rulesVersion, 1);
  assert.equal(report.methodology.independentSeedSamples, false);
  assert.equal(report.matrix.length, 3);
  for (const variant of report.matrix) {
    assert.equal(variant.matchups.length, 15);
    for (const row of variant.matchups) {
      assert.equal(row.leftCost, row.rightCost);
      assert.equal(row.n, 8);
      assert.equal(row.wins + row.losses + row.draws, row.n);
    }
  }
  assert.equal(report.neutrals.length, 35);
  assert.equal(report.items.length, 35);
  assert.equal(report.qualityFixedLineup.length, 5);
  assert.ok(report.goldenCases.length > 0);
  assert.ok(report.provenance.files['src/duel-sim.ts']);
});

const baselineUrl = new URL('../docs/references/opt0-v1-baseline-20261015.json', import.meta.url);
test('O0：持久化 v1 golden 输入重算保持胜负、最终生命和完整回放哈希', () => {
  const report = JSON.parse(readFileSync(baselineUrl, 'utf8'));
  assert.ok(report.goldenCases.length >= 200, '至少记录二百个不同输入，不以重复 seed 凑数');
  for (const golden of report.goldenCases) {
    const result = simulateDuel(golden.input);
    assert.equal(result.winner, golden.winner);
    assert.equal(result.reason, golden.reason);
    assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), golden.resultHash);
    const last = result.frames.at(-1)!;
    assert.deepEqual({ A: last.sideA.map(u => u.hp), B: last.sideB.map(u => u.hp) }, golden.finalHp);
  }
});

test('O0：命令行拒绝覆盖已有基线，不破坏原始证据', () => {
  const before = readFileSync(baselineUrl);
  assert.throws(() => execFileSync(process.execPath, ['--experimental-strip-types',
    fileURLToPath(new URL('../scripts/opt0-baseline.mjs', import.meta.url)), '--out', fileURLToPath(baselineUrl)],
  { stdio: 'pipe' }), /拒绝覆盖已有报告/);
  assert.deepEqual(readFileSync(baselineUrl), before);
});

test('O0：已记录的 v1 换边反例可复现，不能把镜像公平误报为已通过', () => {
  const counterexample = JSON.parse(readFileSync(new URL('../docs/references/opt0-v1-mirror-counterexample-20261015.json', import.meta.url), 'utf8'));
  const winners = counterexample.cases.map((c: any) => {
    const result = simulateDuel(c.input);
    assert.equal(result.winner, c.winner);
    assert.deepEqual(result.summary, c.summary);
    return result.winner === (c.swapped ? 'B' : 'A') ? 'left' : 'right';
  });
  assert.notEqual(winners[0], winners[1]);
});
