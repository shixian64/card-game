import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUGMENTS, AUGMENT_MAP, AUGMENT_ROUNDS, AUGMENT_TIERS, AUGMENT_MAX, augmentTierForRound,
  aggregateAugmentEffects, applyAugmentTraitBonuses,
} from '../src/augments.ts';
import { getSynergies } from '../src/battle.ts';
import { simulateDuel } from '../src/duel-sim.ts';
import type { DuelCardUnitInput, DuelSimInput, DuelSimResult } from '../src/duel-sim.ts';
import { validateEquip } from '../src/equipment.ts';

function unit(defId: string, quality = 1, stars: 1 | 2 | 3 = 1, items: string[] = [], unitId = defId): DuelCardUnitInput {
  return { unitId, defId, quality, stars, itemDefIds: items };
}
function duel(seed: number, sideA: DuelCardUnitInput[], sideB: DuelCardUnitInput[], augmentsA: string[] = [], augmentsB: string[] = []): DuelSimResult {
  const slots = [1, 3, 5, 8, 10, 12, 2];
  const input: DuelSimInput = {
    roundNumber: 1, combatSeed: seed, rulesVersion: 2,
    sideA: { units: sideA, formation: sideA.map((u, i) => ({ unitId: u.unitId, localSlot: slots[i] })), augments: augmentsA },
    sideB: { units: sideB, formation: sideB.map((u, i) => ({ unitId: u.unitId, localSlot: slots[i] })), augments: augmentsB },
  };
  return simulateDuel(input);
}
function sideUnit(result: DuelSimResult, side: 'A' | 'B', defId: string) {
  const first = result.frames[0];
  return (side === 'A' ? first.sideA : first.sideB).find(u => u.defId === defId)!;
}

test('星契数据：20 张、三档、三个固定时点、id 唯一且描述非空', () => {
  assert.equal(AUGMENTS.length, 20);
  assert.equal(new Set(AUGMENTS.map(a => a.id)).size, AUGMENTS.length);
  assert.deepEqual(AUGMENT_ROUNDS.map(r => [r.round, r.tier]), [[2, 1], [5, 2], [8, 3]]);
  for (const tier of [1, 2, 3] as const) {
    const pool = AUGMENTS.filter(a => a.tier === tier);
    assert.ok(pool.length >= 6, '每档至少 6 张，三选一才不易重复');
    assert.ok(pool.every(a => a.description.length >= 8), '描述必须能独立读懂');
    assert.ok(pool.every(a => a.name.length > 0));
  }
  assert.equal(augmentTierForRound(2), 1);
  assert.equal(augmentTierForRound(5), 2);
  assert.equal(augmentTierForRound(8), 3);
  assert.equal(augmentTierForRound(3), null);
  assert.equal(AUGMENT_MAX, 3);
  assert.equal(AUGMENT_TIERS[3].name, '星冕星契');
  assert.ok(AUGMENT_MAP['t3_sixth_seat']);
});

test('星契聚合：同类百分比相加、装备强化封顶 +50%、羁绊徽记保留', () => {
  const effects = aggregateAugmentEffects(['t2_item_master', 't3_item_overflow', 't3_star_pact']);
  assert.equal(effects.itemPowerPct, 0.4);
  assert.equal(effects.itemSlotBonus, 2);
  assert.equal(effects.hpPct, 0.12);
  assert.equal(effects.attackPct, 0.1);
  assert.equal(aggregateAugmentEffects([]).itemPowerPct, 0);
  // 重复装备强化仍不能越过 +50% 上限。
  assert.equal(aggregateAugmentEffects(['t2_item_master', 't3_item_overflow', 't2_item_master']).itemPowerPct, 0.5);
  const emblem = aggregateAugmentEffects(['t2_moon_emblem']);
  assert.deepEqual(emblem.traitBonuses, [{ kind: 'affinity', id: 'moon', amount: 1 }]);
  assert.equal(aggregateAugmentEffects(['t2_free_reroll']).grantFreeRerolls, 3);
  assert.throws(() => aggregateAugmentEffects(['not_augment']), /未知星契/);
});

test('羁绊徽记：单个月系单位 +1 计数即可激活 2 月；万相共鸣连职业计数一起加', () => {
  const base = getSynergies([{ uid: 'u1', defId: 'moon-deer', rank: 1, best: 0 }]);
  const moon = applyAugmentTraitBonuses(base, [{ kind: 'affinity', id: 'moon', amount: 1 }]);
  assert.equal(moon.find(s => s.id === 'affinity-moon-2')!.count, 2);
  assert.equal(moon.find(s => s.id === 'affinity-moon-2')!.active, true);
  assert.equal(moon.find(s => s.id === 'affinity-sun-2')!.count, 0);
  const all = applyAugmentTraitBonuses(base, [{ kind: 'all', amount: 1 }]);
  assert.equal(all.find(s => s.id === 'role-tank')!.count, 2);
  assert.equal(all.find(s => s.id === 'role-tank')!.active, true);
});

test('战斗星契：星冕盟约同时提高生命与攻击，前列 / 后排操典只加对应职业', () => {
  const team = [unit('moon-deer', 1, 1, [], 'u1'), unit('sun-cub', 1, 1, [], 'u2')];
  const plain = duel(11, team, team);
  const pact = duel(11, team, team, ['t3_star_pact']);
  assert.ok(sideUnit(pact, 'A', 'moon-deer').maxHp > sideUnit(plain, 'A', 'moon-deer').maxHp);
  assert.ok(sideUnit(pact, 'A', 'moon-deer').attack > sideUnit(plain, 'A', 'moon-deer').attack);
  const front = duel(11, team, team, ['t1_front_drill']);
  const back = duel(11, team, team, ['t1_back_drill']);
  assert.ok(sideUnit(front, 'A', 'moon-deer').maxHp > sideUnit(plain, 'A', 'moon-deer').maxHp);
  assert.equal(sideUnit(front, 'A', 'sun-cub').maxHp, sideUnit(plain, 'A', 'sun-cub').maxHp);
  assert.ok(sideUnit(back, 'A', 'sun-cub').attack > sideUnit(plain, 'A', 'sun-cub').attack);
  assert.equal(sideUnit(back, 'A', 'moon-deer').attack, sideUnit(plain, 'A', 'moon-deer').attack);
});

test('装备精通：锋刃符 12% → 15%；不落之盾给开局护盾（单月单位不触发月羁绊）', () => {
  const itemTeam = [unit('moon-deer', 1, 1, ['edge_sigil'], 'u1')];
  const plain = duel(12, itemTeam, itemTeam);
  const master = duel(12, itemTeam, itemTeam, ['t2_item_master']);
  assert.ok(sideUnit(master, 'A', 'moon-deer').attack > sideUnit(plain, 'A', 'moon-deer').attack);
  const shield = duel(12, itemTeam, itemTeam, ['t3_aegis']);
  const unitWithShield = sideUnit(shield, 'A', 'moon-deer');
  assert.ok(unitWithShield.shield >= Math.round(unitWithShield.maxHp * 0.15) - 1);
  assert.equal(sideUnit(plain, 'A', 'moon-deer').shield, 0);
});

test('羁绊徽记在真实战斗里生效：A 方单月单位获得 2 月护盾，B 方没有', () => {
  const team = [unit('moon-deer', 1, 1, [], 'u1')];
  const result = duel(13, team, team, ['t2_moon_emblem']);
  assert.equal(result.synergies.A.find(s => s.id === 'affinity-moon-2')!.active, true);
  assert.equal(result.synergies.B.find(s => s.id === 'affinity-moon-2')!.active, false);
  assert.ok(sideUnit(result, 'A', 'moon-deer').shield > 0);
  assert.equal(sideUnit(result, 'B', 'moon-deer').shield, 0);
});

test('第六席：双方各 7 个单位仍可完成模拟；装备槽 3 的校验按星契生效', () => {
  const seven = ['moon-deer', 'forest-rabbit', 'moon-fawn', 'sun-fox', 'sun-cub', 'forest-sprout', 'star-deer']
    .map((defId, i) => unit(defId, 1, 1, [], 'u' + i));
  const result = duel(14, seven, seven, ['t3_sixth_seat']);
  assert.equal(result.frames[0].sideA.length, 7);
  assert.equal(result.frames[0].sideB.length, 7);
  assert.ok(['A', 'B'].includes(result.winner ?? 'A'));
  validateEquip(['edge_sigil', 'astral_lens'], 'stone_mail', 3);
  assert.throws(() => validateEquip(['edge_sigil', 'astral_lens', 'stone_mail'], 'dawn_charm', 3), /最多装备 3 件/);
});
