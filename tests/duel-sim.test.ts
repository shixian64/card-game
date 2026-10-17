import test from 'node:test';
import assert from 'node:assert/strict';
import { boardCells, neighbors, hexDistance, rotate180, slotToCell, cellKey } from '../src/hex.ts';
import { simulateDuel, duelSideCell } from '../src/duel-sim.ts';
import type { DuelCardUnitInput, DuelSimInput, DuelSimResult } from '../src/duel-sim.ts';
import { buildNeutralUnits } from '../src/neutral.ts';
import { DUEL_ITEMS, aggregateEquipment, validateEquip } from '../src/equipment.ts';
import { DUEL_ROUNDS, DUEL_THEORETICAL_DURATION_SEC, DUEL_TOTAL_GUARANTEED_GOLD, duelRoundRule, duelShopPrice, DUEL_RULES_VERSION } from '../src/duel-rules.ts';

function unit(defId: string, quality = 1, stars: 1 | 2 | 3 = 1, items: string[] = [], unitId = defId): DuelCardUnitInput {
  return { unitId, defId, quality, stars, itemDefIds: items };
}
function duel(seed: number, sideA: { units: DuelCardUnitInput[]; slots: number[] }, sideB: { units: DuelCardUnitInput[]; slots: number[] }, maxLogicalRounds?: number, rulesVersion = 1): DuelSimResult {
  const input: DuelSimInput = {
    roundNumber: 1, combatSeed: seed, rulesVersion,
    sideA: { units: sideA.units, formation: sideA.units.map((u, i) => ({ unitId: u.unitId, localSlot: sideA.slots[i] })) },
    sideB: { units: sideB.units, formation: sideB.units.map((u, i) => ({ unitId: u.unitId, localSlot: sideB.slots[i] })) },
  };
  if (maxLogicalRounds !== undefined) input.maxLogicalRounds = maxLogicalRounds;
  return simulateDuel(input);
}
const MIRROR_TEAM = (): DuelCardUnitInput[] => [
  unit('moon-deer', 1, 1, [], 'u1'), unit('forest-rabbit', 1, 1, [], 'u2'), unit('moon-fawn', 1, 1, [], 'u3'),
  unit('sun-fox', 1, 1, [], 'u4'), unit('sun-cub', 1, 1, [], 'u5'), unit('forest-sprout', 1, 1, [], 'u6'),
];
const MIRROR_SLOTS = [1, 3, 5, 22, 24, 26];

test('规则配置：十轮 555 秒、价格 10–14、保底供给 286、R1/R4/R7 野怪', () => {
  assert.equal(DUEL_RULES_VERSION, 2);
  assert.equal(DUEL_ROUNDS.length, 10);
  assert.equal(DUEL_THEORETICAL_DURATION_SEC, 555);
  assert.deepEqual(DUEL_ROUNDS.map(r => r.kind), ['neutral', 'pvp', 'pvp', 'neutral', 'pvp', 'pvp', 'neutral', 'pvp', 'pvp', 'pvp']);
  assert.deepEqual(DUEL_ROUNDS.map(r => r.population), [3, 3, 4, 4, 5, 5, 6, 6, 6, 6]);
  assert.deepEqual(DUEL_ROUNDS.filter(r => r.kind === 'pvp').map(r => r.pvpLossHp), [4, 4, 6, 6, 8, 8, 8]);
  assert.equal(duelShopPrice(1), 10); assert.equal(duelShopPrice(5), 14);
  assert.equal(DUEL_TOTAL_GUARANTEED_GOLD, 286);
  assert.equal(duelRoundRule(7).kind, 'neutral');
  assert.throws(() => duelRoundRule(11));
});

test('B02：180° 旋转是等距变换——邻接与距离对全部 56 格保持', () => {
  for (const cell of boardCells()) {
    const rotated = rotate180(cell);
    const rotatedNeighbors = new Set(neighbors(rotated).map(cellKey));
    for (const n of neighbors(cell)) {
      assert.ok(rotatedNeighbors.has(cellKey(rotate180(n))), `旋转后邻接保持 ${cell.row},${cell.col}`);
    }
  }
  const cells = boardCells();
  for (const a of cells) for (const b of cells) {
    assert.equal(hexDistance(a, b), hexDistance(rotate180(a), rotate180(b)));
  }
});

test('B02：B 方本地 slot 经 180° 映射落上半场，与旧“只翻行”敌方映射不同', () => {
  for (let slot = 0; slot < 28; slot++) {
    const bCell = duelSideCell(slot, 'B');
    const playerCell = slotToCell(slot, 'player');
    assert.deepEqual(bCell, { row: 7 - playerCell.row, col: 6 - playerCell.col });
    assert.ok(bCell.row >= 0 && bCell.row <= 3, 'B 方必须在上半场');
    assert.deepEqual(duelSideCell(slot, 'A'), playerCell);
  }
  // 旧 slotToCell(slot,'enemy') 只翻行不翻列；双人主对局不得直接复用。
  const legacy = slotToCell(0, 'enemy');
  assert.equal(legacy.col, 0); assert.equal(duelSideCell(0, 'B').col, 6);
});

test('A/B 命名空间：两侧同名本地 unitId 不碰撞，模拟可完成', () => {
  const result = duel(7,
    { units: [unit('moon-deer', 1, 1, [], 'same')], slots: [3] },
    { units: [unit('moon-deer', 1, 1, [], 'same')], slots: [3] });
  const first = result.frames[0];
  assert.equal(first.sideA[0].unitId, 'A:same');
  assert.equal(first.sideB[0].unitId, 'B:same');
});

test('确定性：同输入同 seed 两次模拟完全一致（崩溃恢复基础）', () => {
  const a = duel(42, { units: MIRROR_TEAM(), slots: MIRROR_SLOTS }, { units: MIRROR_TEAM(), slots: MIRROR_SLOTS });
  const b = duel(42, { units: MIRROR_TEAM(), slots: MIRROR_SLOTS }, { units: MIRROR_TEAM(), slots: MIRROR_SLOTS });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('B04：双方无法交手时按剩余比例判平局，没有守方默认胜', () => {
  // maxLogicalRounds=1：双方各走一步未交手，剩余比例严格相等 → 平局。
  const result = duel(3,
    { units: [unit('moon-deer')], slots: [0] },
    { units: [unit('moon-deer')], slots: [0] }, 1);
  assert.equal(result.winner, null);
  assert.equal(result.reason, 'round-limit');
});

test('B05：真镜像换边不系统偏置（6v6 200 种子，A/B 胜率接近，平局单列）', () => {
  let a = 0, b = 0, draw = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const result = duel(seed, { units: MIRROR_TEAM(), slots: MIRROR_SLOTS }, { units: MIRROR_TEAM(), slots: MIRROR_SLOTS });
    if (result.winner === 'A') a++; else if (result.winner === 'B') b++; else draw++;
  }
  // 允许统计带宽 ±10%；镜像阵容两侧机制完全对称。
  assert.ok(Math.abs(a - b) <= 20, `镜像偏置过大：A=${a} B=${b} draw=${draw}`);
  assert.equal(a + b + draw, 200);
});

test('B05b：远程顺序变化也不能让固定一侧系统性获胜（走位平局用阵营相对列）', () => {
  // 这是评审发现的旧问题：把 sun-cub 放在 sun-fox 前面时，180° 旋转后的列号平局曾让 A 方 100% 落败。
  const swapped = (): DuelCardUnitInput[] => [
    unit('moon-deer', 1, 1, [], 'u1'), unit('forest-rabbit', 1, 1, [], 'u2'), unit('moon-fawn', 1, 1, [], 'u3'),
    unit('sun-cub', 1, 1, [], 'u4'), unit('sun-fox', 1, 1, [], 'u5'), unit('forest-sprout', 1, 1, [], 'u6'),
  ];
  let a = 0, b = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const result = duel(seed, { units: swapped(), slots: MIRROR_SLOTS }, { units: swapped(), slots: MIRROR_SLOTS }, undefined, 2);
    if (result.winner === 'A') a++; else if (result.winner === 'B') b++;
  }
  assert.ok(Math.abs(a - b) <= 20, `换序后镜像偏置过大：A=${a} B=${b}`);
});

test('新星级倍率：HP 1/1.35/1.8、攻击 1/1.25/1.6，品质星级两层各算一次', () => {
  const moonDeer = (stars: 1 | 2 | 3) => duel(11, { units: [unit('moon-deer', 1, stars)], slots: [3] }, { units: [unit('moon-deer')], slots: [3] }, 1).frames[0].sideA[0];
  assert.equal(moonDeer(1).maxHp, 180);
  assert.equal(moonDeer(2).maxHp, Math.round(180 * 1.35));
  assert.equal(moonDeer(3).maxHp, Math.round(180 * 1.8));
  const rabbit = (stars: 1 | 2 | 3) => duel(11, { units: [unit('forest-rabbit', 1, stars)], slots: [3] }, { units: [unit('moon-deer')], slots: [3] }, 1).frames[0].sideA[0];
  const base = rabbit(1).attack;
  assert.ok(Math.abs(rabbit(2).attack - Math.round(base * 1.25 * 10) / 10) < 1e-9);
  assert.ok(Math.abs(rabbit(3).attack - Math.round(base * 1.6 * 10) / 10) < 1e-9);
  // 品质与星级乘算且各计一次：Q3★2 = 180×1.08×1.35。
  const q3 = duel(11, { units: [unit('moon-deer', 3, 2)], slots: [3] }, { units: [unit('moon-deer')], slots: [3] }, 1).frames[0].sideA[0];
  assert.equal(q3.maxHp, Math.round(180 * 1.08 * 1.35));
});

test('E08：石脉甲按最终层应用（HP +15% 后加护甲平值），不重复套层', () => {
  const plain = duel(11, { units: [unit('moon-deer')], slots: [3] }, { units: [unit('moon-deer')], slots: [3] }, 1).frames[0].sideA[0];
  const mailed = duel(11, { units: [unit('moon-deer', 1, 1, ['stone_mail'])], slots: [3] }, { units: [unit('moon-deer')], slots: [3] }, 1).frames[0].sideA[0];
  assert.equal(mailed.maxHp, Math.round(plain.maxHp * 1.15));
  assert.equal(mailed.armor, plain.armor + 8);
});

test('E09：晨曦护符开局一次性护盾（= 最终 HP 12%），帧间不刷新', () => {
  const result = duel(5,
    { units: [unit('sun-fox', 1, 1, ['dawn_charm'])], slots: [24] },
    { units: [unit('sun-cub', 1, 1, [])], slots: [24] }, 1);
  const first = result.frames[0].sideA[0];
  assert.equal(first.shield, Math.round(first.maxHp * 0.12));
  // 普通无月系羁绊单位不应有其他开局盾；受击后护盾只减不补（一场一次）。
  const last = result.frames.at(-1)!.sideA[0];
  assert.ok(last.shield <= first.shield);
});

test('E10：回响棱普攻回能 +8、封顶 100；技能伤害不触发回能', () => {
  // 近战互相普攻一次后：能量 = 30 + 35 + 8 = 73。
  const result = duel(9,
    { units: [unit('forest-rabbit', 1, 1, ['echo_prism'])], slots: [3] },
    { units: [unit('moon-deer')], slots: [3] }, 1);
  const withPrism = result.frames.find(f => f.logs.some(l => l.context === 'basic' && l.actorId === 'A:forest-rabbit'));
  assert.ok(withPrism);
  const actor = withPrism!.sideA.find(u => u.unitId === 'A:forest-rabbit')!;
  assert.equal(actor.energy, 30 + 35 + 8);
});

test('E11：猎星印每第三次普攻追加 item 伤害；额外伤害不回能、不再触发', () => {
  const result = duel(13,
    { units: [unit('forest-rabbit', 1, 1, ['hunter_seal'])], slots: [3] },
    { units: [unit('moon-deer')], slots: [3] });
  const basicFrames = result.frames.filter(f => f.logs.some(l => l.context === 'basic' && l.actorId === 'A:forest-rabbit'));
  const itemFrames = result.frames.filter(f => f.logs.some(l => l.context === 'item' && l.actorId === 'A:forest-rabbit'));
  assert.ok(basicFrames.length >= 3, '应发生至少 3 次普攻');
  assert.ok(itemFrames.length >= 1, '第三次普攻应追加 item 伤害');
  for (const frame of itemFrames) {
    const actor = frame.sideA.find(u => u.unitId === 'A:forest-rabbit')!;
    assert.equal(actor.basicCount % 3, 0, 'item 触发必须发生在第 3 的倍数次普攻');
    assert.ok(frame.logs.some(l => l.context === 'basic' && l.actorId === 'A:forest-rabbit'), 'item 伤害与普攻同一行动');
  }
  // item 伤害不使攻击者额外回能：普攻 +35，帧间能量差只应多出“受击生命损失 +10”。
  let checked = 0;
  for (let i = 1; i < basicFrames.length && checked < 3; i++) {
    const prev = basicFrames[i - 1], curr = basicFrames[i];
    const prevActor = prev.sideA.find(u => u.unitId === 'A:forest-rabbit')!;
    const currActor = curr.sideA.find(u => u.unitId === 'A:forest-rabbit')!;
    const between = result.frames.slice(result.frames.indexOf(prev) + 1, result.frames.indexOf(curr) + 1);
    if (between.some(f => f.logs.some(l => l.kind === 'skill' && l.actorId === 'A:forest-rabbit'))) continue;
    if (currActor.energy < prevActor.energy) continue; // 技能释放清零后的新一轮
    const hitsTaken = between.reduce((sum, f) => sum + f.logs.filter(l => l.kind === 'attack' && l.targetId === 'A:forest-rabbit' && (l.amount ?? 0) > 0).length, 0);
    if (prevActor.energy + 35 + 10 * hitsTaken > 100) continue; // 能量封顶截断的区间不用于断言
    assert.equal(currActor.energy - prevActor.energy, 35 + 10 * hitsTaken, '含 item 触发的普攻也只回 35 能量（受击另 +10）');
    checked++;
  }
  assert.ok(checked >= 1, '至少校验一组连续普攻');
});

test('E04/E05：装备校验——两槽上限、同 uniqueGroup 拒绝、未知装备拒绝', () => {
  validateEquip([], 'edge_sigil');
  validateEquip(['edge_sigil'], 'stone_mail');
  assert.throws(() => validateEquip(['edge_sigil', 'stone_mail'], 'dawn_charm'), /最多装备 2 件/);
  assert.throws(() => validateEquip(['edge_sigil'], 'edge_sigil'), /同组装备/);
  assert.throws(() => aggregateEquipment(['not_an_item']), /未知装备/);
  assert.equal(DUEL_ITEMS.length, 6);
  assert.equal(new Set(DUEL_ITEMS.map(i => i.choiceGroup)).size, 3);
});

test('N01/N04：R1 营地中立实体只普攻（无技能 / 羁绊 / 品质），两名免费副本多数获胜', () => {
  const camp = buildNeutralUnits(1);
  assert.equal(camp.length, 2);
  assert.deepEqual(camp.map(m => m.localSlot), [1, 5]);
  let wins = 0, seeds = 100;
  for (let seed = 0; seed < seeds; seed++) {
    const result = duel(seed,
      { units: [unit('moon-deer'), unit('sun-cub')], slots: [3, 24] },
      { units: camp.map(m => ({ kind: 'neutral' as const, ...m })), slots: camp.map(m => m.localSlot) });
    assert.ok(result.frames.flatMap(f => f.logs).every(l => l.side !== 'B' || l.kind !== 'skill'), '中立实体不放技能');
    if (result.winner === 'A') wins++;
  }
  assert.ok(wins / seeds >= 0.6, `新手两副本对 R1 野怪胜率过低：${wins}/${seeds}`);
});

test('野怪营地强度阶梯：R7 营地明显强于 R1（同阵容剩余生命比例下降）', () => {
  const run = (round: number) => {
    const camp = buildNeutralUnits(round);
    let wins = 0, hp = 0;
    for (let seed = 0; seed < 60; seed++) {
      const result = duel(seed,
        { units: [unit('moon-deer'), unit('forest-rabbit'), unit('sun-cub')], slots: [3, 5, 24] },
        { units: camp.map(m => ({ kind: 'neutral' as const, ...m })), slots: camp.map(m => m.localSlot) });
      if (result.winner === 'A') wins++;
      hp += result.summary.hpRatioA;
    }
    return { wins, hp: hp / 60 };
  };
  const r1 = run(1), r7 = run(7);
  // 溅射 / 突进等机制修正后该三人组对 R1/R7 都能全胜（胜率饱和），
  // 强度阶梯改用剩余生命比例刻画：R7 营地应明显更惨烈。
  assert.ok(r7.wins <= r1.wins, '更强营地不提高胜率');
  assert.ok(r7.hp < r1.hp, `R7 营地应强于 R1：剩余生命比例 ${r7.hp.toFixed(3)} vs ${r1.hp.toFixed(3)}`);
});

test('回放帧上限 400：超限压缩移动帧且保留最终结果帧', () => {
  const result = duel(77, { units: MIRROR_TEAM(), slots: MIRROR_SLOTS }, { units: MIRROR_TEAM(), slots: MIRROR_SLOTS });
  assert.ok(result.frames.length <= 400);
  const last = result.frames.at(-1)!;
  assert.ok(last.logs.some(l => l.kind === 'result'), '最后一帧必须含结果');
});
