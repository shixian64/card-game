// 双人主对局的对称战斗内核：双方（或玩家 vs 中立营地）以完整阵容 / 站位 / 品质 /
// 星级 / 装备输入，产出唯一 winner:'A'|'B'|null（允许平局）与统一回放帧。
// - 不是对两人各跑一次 createBattle，也不是旧 player/enemy 内核换皮；旧 PvE
//   （battle.ts createBattle）保持冻结语义，本模块复用其基表 / 羁绊 / 克制 /
//   决战函数，但节奏与判定独立版本化（DUEL-RULES-1）。
// - A 方本地 slot 经 slotToCell(slot,'player') 落下半场；B / 中立方经 rotate180
//   同一映射落上半场（180° 等距旋转，六邻接 / 距离保持）。
// - 单位 id 带所属方命名空间（A: / B:），两人永久 uid 同为 c1 也不会碰撞。
// - 同速先后由 (seed+round)%2 交替决定先手方，可复现且不固定偏向 A 或守方；
//   超时按剩余生命比例交叉相乘比较，严格相等为平局，没有“守方默认赢”。
import { CARD_MAP, QUALITY_MAX } from './data.ts';
import type { Affinity } from './data.ts';
import { ROLE_BASE_STATS, CARD_COMBAT_DEFS, getSynergies, affinityMultiplier, getOvertimeModifiers } from './battle.ts';
import type { CombatRole, Synergy } from './battle.ts';
import { hexDistance, slotToCell, rotate180, neighbors as hexNeighbors, boardCells, HEX_COLS } from './hex.ts';
import { aggregateEquipment } from './equipment.ts';
import type { NeutralUnitSpec } from './neutral.ts';
import { DUEL_COMBAT, DUEL_QUALITY, DUEL_STARS } from './duel-rules.ts';

export type DuelSideId = 'A' | 'B';
export type DamageContext = 'basic' | 'skill' | 'item' | 'neutral';

export interface DuelCardUnitInput {
  kind?: 'card';
  unitId: string;          // 房间内实例 id（服务端生成，不含 A:/B: 前缀）
  defId: string;
  quality: number;         // 本局冻结品质 battleQuality
  stars: 1 | 2 | 3;
  itemDefIds?: ReadonlyArray<string>; // 已穿戴装备的定义 id（引用原实例，不复制）
}
export type DuelSideUnit = DuelCardUnitInput | ({ kind: 'neutral' } & NeutralUnitSpec);
export interface DuelSideInput {
  units: ReadonlyArray<DuelSideUnit>;
  formation: ReadonlyArray<{ unitId: string; localSlot: number }>; // 该方本地 0–27，全部单位都必须有站位
}
export interface DuelLog {
  id: number; round: number; side: DuelSideId | 'system';
  kind: 'attack' | 'skill' | 'shield' | 'defeat' | 'round' | 'result' | 'move';
  actorId?: string; targetId?: string; amount?: number; damageType?: 'physical' | 'magic';
  context?: DamageContext; movement?: 'walk' | 'blink'; text: string;
}
export interface DuelResultUnit {
  unitId: string; side: DuelSideId; kind: 'card' | 'neutral';
  defId?: string; name: string; role?: CombatRole; quality?: number; stars?: number;
  itemDefIds?: string[];
  maxHp: number; hp: number; shield: number; attack: number; armor: number; resistance: number;
  range: number; speed: number; energy: number; localSlot: number; row: number; col: number;
  skillName?: string; affinity?: Affinity; damageDealt: number; basicCount: number;
}
export interface DuelFrame { tick: number; round: number; sideA: DuelResultUnit[]; sideB: DuelResultUnit[]; logs: DuelLog[] }
export interface DuelSimResult {
  version: 1;
  winner: DuelSideId | null;          // null = 平局
  reason: 'elimination' | 'round-limit';
  frames: DuelFrame[];
  synergies: { A: Synergy[]; B: Synergy[] };
  summary: { rounds: number; frames: number; hpRatioA: number; hpRatioB: number };
}
export interface DuelSimInput {
  roundNumber: number;               // 房间轮次（1–10），用于校验与结果标注
  combatSeed: number;                // 冻结时一次性生成并持久化；崩溃恢复同 seed 重算
  sideA: DuelSideInput;
  sideB: DuelSideInput;
  maxLogicalRounds?: number;         // 默认 DUEL_COMBAT.logicalRoundLimit=24
}

interface RuntimeUnit extends DuelResultUnit {
  skillPower: number; skillSecondary: number; effect: string;
  energyOnBasic: number; everyNBasic: number | null; extraPhysicalAttackRatio: number;
  jumped: boolean; alive: boolean;
}
interface SimState {
  A: RuntimeUnit[]; B: RuntimeUnit[];
  round: number; logs: DuelLog[]; nextLog: number;
  synergies: { A: Synergy[]; B: Synergy[] };
}
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function decimal(value: number): number { return Math.round(value * 10) / 10; }
// A 方在下半场（行大在后），B 方在上半场（行小在后）；按行动方决定朝对方后排的方向。
const ACTOR_ROW_ASC: Record<DuelSideId, boolean> = { A: true, B: false };

function other(side: DuelSideId): DuelSideId { return side === 'A' ? 'B' : 'A'; }
function combatDistance(a: { row: number; col: number }, b: { row: number; col: number }): number { return hexDistance(a, b); }

/** 各方本地 slot → 物理格：A 走 slotToCell(player)；B / 中立方再经 180° 旋转到上半场。 */
export function duelSideCell(localSlot: number, side: DuelSideId): { row: number; col: number } {
  const cell = slotToCell(localSlot, 'player');
  return side === 'A' ? cell : rotate180(cell);
}

function buildCardUnit(input: DuelCardUnitInput, side: DuelSideId, localSlot: number, synergies: Synergy[]): RuntimeUnit {
  ensure(CARD_MAP[input.defId] && CARD_COMBAT_DEFS[input.defId], '未知战斗卡牌：' + input.defId);
  ensure(Number.isInteger(input.quality) && input.quality >= 1 && input.quality <= QUALITY_MAX, '本局品质不合法');
  ensure(input.stars >= 1 && input.stars <= DUEL_STARS.maxStars, '局内星级不合法');
  const def = CARD_MAP[input.defId], base = ROLE_BASE_STATS[def.art], variant = CARD_COMBAT_DEFS[input.defId];
  const equip = aggregateEquipment([...(input.itemDefIds ?? [])]);
  // 应用顺序（设计文档 9.3）：基础 → 品质 → 星级 → 装备（同类百分比先相加）→ 羁绊 → 一次性护盾。
  let hp = Math.round(base.hp * DUEL_QUALITY.hpMultiplier[input.quality - 1] * DUEL_STARS.hpMultiplier[input.stars - 1] * (1 + equip.maxHpPct));
  let attack = decimal(base.attack * DUEL_QUALITY.attackMultiplier[input.quality - 1] * DUEL_STARS.attackMultiplier[input.stars - 1] * (1 + equip.attackPct));
  const skillFactor = DUEL_QUALITY.skillCoefficientMultiplier[input.quality - 1] * DUEL_STARS.skillCoefficientMultiplier[input.stars - 1] * (1 + equip.skillCoefficientPct);
  const skillPower = Number((variant.power * skillFactor).toFixed(4));
  const skillSecondary = Number((variant.secondary * skillFactor).toFixed(4));
  const active = (id: string) => synergies.some(s => s.id === id && s.active);
  if (def.affinity === 'forest') hp = Math.round(hp * (active('affinity-forest-4') ? 1.22 : active('affinity-forest-2') ? 1.1 : 1));
  if (base.role === '坦克' && active('role-tank')) hp = Math.round(hp * 1.08);
  if (def.affinity === 'sun') attack = decimal(attack * (active('affinity-sun-4') ? 1.18 : active('affinity-sun-2') ? 1.08 : 1));
  if (base.role === '战士' && active('role-warrior')) attack = decimal(attack * 1.12);
  let shield = def.affinity === 'moon' ? Math.round(hp * (active('affinity-moon-4') ? 0.25 : active('affinity-moon-2') ? 0.12 : 0)) : 0;
  // 装备开局护盾：一次性（一场一次）；总量上限已在 aggregateEquipment 内按最终 HP 25% 截断。
  shield += Math.round(hp * equip.openingShieldMaxHpPct);
  const cell = duelSideCell(localSlot, side);
  return {
    unitId: side + ':' + input.unitId, side, kind: 'card', defId: input.defId, name: def.name, role: base.role,
    quality: input.quality, stars: input.stars, itemDefIds: [...(input.itemDefIds ?? [])],
    maxHp: hp, hp, shield, attack, armor: (variant.armor ?? base.armor) + equip.armorFlat,
    resistance: variant.resistance ?? base.resistance, range: variant.range ?? base.range, speed: base.speed,
    energy: 30, localSlot, row: cell.row, col: cell.col,
    skillName: variant.skillName, affinity: def.affinity, damageDealt: 0, basicCount: 0,
    skillPower, skillSecondary, effect: base.effect,
    energyOnBasic: equip.energyOnBasic, everyNBasic: equip.everyNBasic, extraPhysicalAttackRatio: equip.extraPhysicalAttackRatio,
    jumped: false, alive: true,
  };
}
function buildNeutralUnit(spec: NeutralUnitSpec, side: DuelSideId): RuntimeUnit {
  ensure(Number.isInteger(spec.localSlot) && spec.localSlot >= 0 && spec.localSlot <= 27, '中立站位不合法');
  const cell = duelSideCell(spec.localSlot, side);
  return {
    unitId: side + ':' + spec.unitId, side, kind: 'neutral', name: spec.name,
    maxHp: spec.hp, hp: spec.hp, shield: 0, attack: spec.attack, armor: spec.armor, resistance: spec.resistance,
    range: spec.range, speed: spec.speed, energy: 0, localSlot: spec.localSlot, row: cell.row, col: cell.col,
    damageDealt: 0, basicCount: 0,
    skillPower: 0, skillSecondary: 0, effect: 'neutral',
    energyOnBasic: 0, everyNBasic: null, extraPhysicalAttackRatio: 0,
    jumped: false, alive: true,
  };
}
interface ValidatedSide { specs: Array<{ id: string; slot: number; unit: DuelSideUnit }> }
/** 在 DuelSideUnit 联合上判别：中立方与卡牌单位都带 unitId，但只有后者参与羁绊。 */
function isCardUnit(unit: DuelSideUnit): unit is DuelCardUnitInput { return unit.kind !== 'neutral'; }
function validateSide(side: DuelSideInput, label: string, maxUnits: number): ValidatedSide {
  // 允许 0 个单位（空阵）：单边空 → 非空方直接获胜；双边空 → 平局（B04）。
  ensure(side && Array.isArray(side.units) && side.units.length >= 0 && side.units.length <= maxUnits, label + '阵容最多 ' + maxUnits + ' 个单位');
  const specs: ValidatedSide['specs'] = [];
  const seenId = new Set<string>(), seenSlot = new Set<number>();
  const byId = new Map<string, DuelSideUnit>();
  for (const unit of side.units) {
    const id = unit.unitId;
    ensure(typeof id === 'string' && id.length > 0 && !id.startsWith('A:') && !id.startsWith('B:'), label + '单位 id 不合法');
    ensure(!seenId.has(id), label + '单位 id 重复');
    seenId.add(id); byId.set(id, unit);
  }
  for (const entry of side.formation) {
    ensure(entry && typeof entry.unitId === 'string' && byId.has(entry.unitId), label + '站位引用了不存在的单位');
    ensure(Number.isInteger(entry.localSlot) && entry.localSlot >= 0 && entry.localSlot <= 27, label + '站位必须在 0–27');
    ensure(!seenSlot.has(entry.localSlot), label + '站位格位重复');
    seenSlot.add(entry.localSlot);
    specs.push({ id: entry.unitId, slot: entry.localSlot, unit: byId.get(entry.unitId)! });
  }
  ensure(specs.length === side.units.length, label + '每个单位都必须有且仅有一个站位');
  return { specs };
}
function log(state: SimState, entry: Omit<DuelLog, 'id' | 'round'>): void { state.logs.push({ id: state.nextLog++, round: state.round, ...entry }); }
function aliveUnits(units: RuntimeUnit[]): RuntimeUnit[] { return units.filter(u => u.alive && u.hp > 0); }
function targetFor(actor: RuntimeUnit, enemies: RuntimeUnit[]): RuntimeUnit | undefined {
  let live = aliveUnits(enemies);
  if (!live.length) return undefined;
  const ready = actor.energy >= 100;
  // 后排狙击 / 刺客绕坦按各方“本地 slot”判定后排，不按物理行。
  if (ready && actor.role === '射手' && actor.localSlot >= 14 && live.some(u => u.localSlot >= 14)) live = live.filter(u => u.localSlot >= 14);
  else if (!(ready && actor.role === '刺客')) {
    const tanks = live.filter(u => u.role === '坦克' && u.shield > 0 && combatDistance(actor, u) <= 2);
    if (tanks.length) live = tanks;
  }
  return [...live].sort((a, b) => combatDistance(actor, a) - combatDistance(actor, b)
    || Math.floor(a.localSlot / 7) - Math.floor(b.localSlot / 7)
    || a.hp / a.maxHp - b.hp / b.maxHp
    || a.localSlot - b.localSlot)[0];
}
/** 伤害统一入口：区分 basic / skill / item / neutral 上下文；受击回能只按生命损失。 */
function hit(state: SimState, actor: RuntimeUnit, target: RuntimeUnit, power: number, context: DamageContext, damageType: 'physical' | 'magic'): void {
  const advantage = actor.affinity && target.affinity ? affinityMultiplier(actor.affinity, target.affinity) : 1;
  const defense = damageType === 'physical' ? target.armor : target.resistance;
  const damage = Math.max(1, Math.round(actor.attack * power * advantage * 100 / (100 + defense) * getOvertimeModifiers(state.round).damage));
  const blocked = Math.min(target.shield, damage), loss = Math.min(target.hp, damage - blocked);
  target.shield -= blocked; target.hp -= loss;
  if (loss > 0) target.energy = Math.min(100, target.energy + 10); // 受击回能：仅生命损失；护盾吸收不回能
  actor.damageDealt += loss;
  log(state, { side: actor.side, kind: 'attack', actorId: actor.unitId, targetId: target.unitId, amount: loss, damageType, context,
    text: actor.name + ' → ' + target.name + '：' + (damageType === 'physical' ? '物理' : '法术') + ' ' + (blocked ? '护盾 −' + blocked + '，' : '') + '生命 −' + loss + (advantage > 1 ? '（克制）' : '') });
  if (target.hp <= 0) { target.alive = false; target.shield = 0; log(state, { side: actor.side, kind: 'defeat', actorId: actor.unitId, targetId: target.unitId, text: target.name + ' 已退场。' }); }
}
function roleBondActive(state: SimState, side: DuelSideId, roleId: string): boolean {
  return state.synergies[side].some(s => s.id === 'role-' + roleId && s.active);
}
function skill(state: SimState, actor: RuntimeUnit, enemies: RuntimeUnit[], target: RuntimeUnit): void {
  actor.energy = 0;
  log(state, { side: actor.side, kind: 'skill', actorId: actor.unitId, text: actor.name + ' 使用「' + actor.skillName + '」。' });
  if (actor.role === '坦克') {
    const gained = Math.min(actor.maxHp - actor.shield, Math.round(actor.maxHp * actor.skillPower * getOvertimeModifiers(state.round).shield));
    actor.shield += gained;
    log(state, { side: actor.side, kind: 'shield', actorId: actor.unitId, targetId: actor.unitId, amount: gained, text: actor.name + ' 获得 ' + gained + ' 护盾，吸引附近敌人。' });
  } else if (actor.role === '法师') {
    const factor = roleBondActive(state, actor.side, 'mage') ? 1.15 : 1;
    hit(state, actor, target, actor.skillPower * factor, 'skill', 'magic');
    for (const other of aliveUnits(enemies).filter(u => u.unitId !== target.unitId && combatDistance(target, u) <= 1)) hit(state, actor, other, actor.skillSecondary * factor, 'skill', 'magic');
  } else if (actor.role === '射手') {
    // 连射两次是一次技能动作，不是两次普攻（不计猎星印计数、不触发回响棱）。
    hit(state, actor, target, actor.skillPower, 'skill', 'physical');
    if (target.hp > 0) hit(state, actor, target, actor.skillPower, 'skill', 'physical');
  } else if (actor.role === '战士') {
    hit(state, actor, target, actor.skillPower, 'skill', 'physical');
    for (const other of aliveUnits(enemies).filter(u => u.unitId !== target.unitId && combatDistance(actor, u) <= 1)) hit(state, actor, other, actor.skillSecondary, 'skill', 'physical');
  } else {
    hit(state, actor, target, actor.skillPower * (roleBondActive(state, actor.side, 'assassin') ? 1.15 : 1), 'skill', 'physical');
  }
}
function openingBlink(state: SimState, actor: RuntimeUnit, enemies: RuntimeUnit[]): void {
  const live = aliveUnits(enemies);
  const rear = [...live].sort((a, b) => (ACTOR_ROW_ASC[actor.side] ? a.row - b.row : b.row - a.row) || a.localSlot - b.localSlot)[0];
  const occupied = new Set([...aliveUnits(state.A), ...aliveUnits(state.B)].filter(u => u.unitId !== actor.unitId).map(u => u.row * HEX_COLS + u.col));
  const cells = boardCells()
    .filter(cell => !occupied.has(cell.row * HEX_COLS + cell.col))
    .sort((a, b) => combatDistance(a, rear) - combatDistance(b, rear)
      || (ACTOR_ROW_ASC[actor.side] ? a.row - b.row : b.row - a.row)
      || Math.abs(a.col - actor.col) - Math.abs(b.col - actor.col) || a.col - b.col);
  const destination = cells[0], distance = combatDistance(actor, destination);
  if (distance === 0) return;
  actor.row = destination.row; actor.col = destination.col;
  log(state, { side: actor.side, kind: 'move', movement: 'blink', actorId: actor.unitId, amount: distance, text: actor.name + ' 突入敌方后排。' });
}
function moveToward(state: SimState, actor: RuntimeUnit, target: RuntimeUnit): void {
  const occupied = new Set([...aliveUnits(state.A), ...aliveUnits(state.B)].filter(u => u.unitId !== actor.unitId).map(u => u.row * HEX_COLS + u.col));
  const start = actor.row * HEX_COLS + actor.col, seen = new Set([start]), queue = [{ row: actor.row, col: actor.col, first: -1 }];
  let destination: { row: number; col: number } | undefined;
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current.first !== -1 && combatDistance(current, target) <= actor.range) { destination = { row: Math.floor(current.first / HEX_COLS), col: current.first % HEX_COLS }; break; }
    // 平局规则与阵营无关：先到目标距离，再横向列距，最后列号。
    const steps = hexNeighbors(current)
      .sort((a, b) => combatDistance(a, target) - combatDistance(b, target) || Math.abs(a.col - target.col) - Math.abs(b.col - target.col) || a.col - b.col);
    for (const next of steps) {
      const key = next.row * HEX_COLS + next.col;
      if (seen.has(key) || occupied.has(key)) continue;
      seen.add(key); queue.push({ ...next, first: current.first === -1 ? key : current.first });
    }
  }
  if (destination) {
    actor.row = destination.row; actor.col = destination.col;
    log(state, { side: actor.side, kind: 'move', movement: 'walk', actorId: actor.unitId, amount: 1, text: actor.name + ' 移动 1 格，接近 ' + target.name + '。' });
  } else log(state, { side: actor.side, kind: 'move', movement: 'walk', actorId: actor.unitId, amount: 0, text: actor.name + ' 前路被占据，等待空位。' });
}
function hpRatio(units: RuntimeUnit[]): number { return aliveUnits(units).reduce((sum, u) => sum + u.hp, 0) / units.reduce((sum, u) => sum + u.maxHp, 0); }
function snapshot(units: RuntimeUnit[]): DuelResultUnit[] {
  return units.map(({ skillPower: _p, skillSecondary: _s, effect: _e, energyOnBasic: _b, everyNBasic: _n, extraPhysicalAttackRatio: _r, jumped: _j, alive: _a, ...rest }) =>
    ({ ...rest, hp: Math.max(0, rest.hp) }));
}
function thinFrames(frames: DuelFrame[], limit: number): DuelFrame[] {
  if (frames.length <= limit) return frames;
  // 超限时从中段丢弃纯移动帧（不丢关键结果 / 最后帧），确定性压缩。
  const movable = frames.map((f, i) => ({ f, i })).filter(e => e.f.logs.length === 1 && e.f.logs[0].kind === 'move' && e.i !== frames.length - 1);
  let drop = frames.length - limit;
  const skip = new Set<number>();
  const stride = Math.max(1, Math.floor(movable.length / drop));
  for (let k = movable.length - 1; k >= 0 && drop > 0; k -= stride) { skip.add(movable[k].i); drop--; }
  const kept = frames.filter((_, i) => !skip.has(i));
  return kept.length > limit ? kept.slice(kept.length - limit) : kept;
}

/** 主入口：一次双边模拟，一份权威结果。双方输入均视为服务端冻结快照。 */
export function simulateDuel(input: DuelSimInput): DuelSimResult {
  ensure(input && Number.isInteger(input.roundNumber) && input.roundNumber >= 1, '轮次不合法');
  ensure(Number.isInteger(input.combatSeed) && input.combatSeed >= 0 && input.combatSeed <= 0xffffffff, '战斗种子不合法');
  const maxRounds = input.maxLogicalRounds ?? DUEL_COMBAT.logicalRoundLimit;
  const sideA = validateSide(input.sideA, 'A 方', 6), sideB = validateSide(input.sideB, 'B 方', 6);
  // 羁绊只按不同 defId 计数；中立方无羁绊。
  const synergyCards = (side: ValidatedSide): Synergy[] => {
    const cards = side.specs.map(s => s.unit).filter(isCardUnit);
    return cards.length ? getSynergies(cards.map(c => ({ uid: c.unitId, defId: c.defId, rank: c.quality, best: 0, stars: c.stars }))) : [];
  };
  const synergies = { A: synergyCards(sideA), B: synergyCards(sideB) };
  const build = (side: ValidatedSide, id: DuelSideId): RuntimeUnit[] => side.specs.map(spec =>
    spec.unit.kind === 'neutral'
      ? buildNeutralUnit(spec.unit, id)
      : buildCardUnit(spec.unit, id, spec.slot, synergies[id]));
  const state: SimState = { A: build(sideA, 'A'), B: build(sideB, 'B'), round: 1, logs: [], nextLog: 2, synergies };
  const frames: DuelFrame[] = [];
  let winner: DuelSideId | null = null, reason: DuelSimResult['reason'] = 'round-limit';
  if (state.A.length === 0 || state.B.length === 0) {
    // 空阵：单边空 → 非空方胜；双边空 → 平局。不生成随机替补。
    reason = 'elimination';
    winner = state.A.length === 0 && state.B.length === 0 ? null : state.A.length > 0 ? 'A' : 'B';
    state.logs = [];
    log(state, { side: 'system', kind: 'result', text: winner === null ? '双方均未上阵：平局。' : winner === 'A' ? 'B 方未上阵：A 方获胜。' : 'A 方未上阵：B 方获胜。' });
    frames.push({ tick: 1, round: 1, sideA: snapshot(state.A), sideB: snapshot(state.B), logs: structuredClone(state.logs) });
    return { version: 1, winner, reason, frames, synergies, summary: { rounds: 1, frames: 1, hpRatioA: 0, hpRatioB: 0 } };
  }
  for (let round = 1; round <= maxRounds && winner === null; round++) {
    state.round = round;
    const preferred: DuelSideId = (input.combatSeed + round) % 2 === 0 ? 'A' : 'B';
    const order = [...aliveUnits(state.A).map(u => ({ unit: u, side: 'A' as DuelSideId })), ...aliveUnits(state.B).map(u => ({ unit: u, side: 'B' as DuelSideId }))]
      .sort((a, b) => b.unit.speed - a.unit.speed || a.unit.localSlot - b.unit.localSlot || (a.side === b.side ? 0 : a.side === preferred ? -1 : 1));
    let first = true;
    for (let index = 0; index < order.length; index++) {
      const { unit: actor, side } = order[index];
      if (!actor.alive || actor.hp <= 0) continue;
      const enemies = state[other(side)];
      if (!aliveUnits(enemies).length) break;
      state.logs = [];
      if (first) {
        log(state, { side: 'system', kind: 'round', text: '第 ' + round + ' 轮：按速度与站位自动行动。' });
        if (round >= 17) { const m = getOvertimeModifiers(round); log(state, { side: 'system', kind: 'round', text: '决战：伤害 +' + Math.round((m.damage - 1) * 100) + '%，新护盾 −' + Math.round((1 - m.shield) * 100) + '%。' }); }
        first = false;
      }
      if (actor.role === '刺客' && !actor.jumped) { openingBlink(state, actor, enemies); actor.jumped = true; }
      const ready = actor.energy >= 100 && actor.kind === 'card';
      const target = targetFor(actor, enemies);
      if (target === undefined) break;
      if (ready && actor.role === '坦克') skill(state, actor, enemies, target);
      else if (combatDistance(actor, target) > actor.range) moveToward(state, actor, target);
      else if (ready) skill(state, actor, enemies, target);
      else {
        hit(state, actor, target, 1, actor.kind === 'neutral' ? 'neutral' : 'basic', 'physical');
        actor.basicCount++;
        if (actor.kind === 'card') {
          // 普攻回能：基础 35 + 射手羁绊 10 + 回响棱 8，封顶 100；技能 / 装备额外伤害不回能。
          const bonus = actor.role === '射手' && roleBondActive(state, side, 'marksman') ? 10 : 0;
          actor.energy = Math.min(100, actor.energy + 35 + bonus + actor.energyOnBasic);
          // 猎星印：按普攻动作计数（射手连射技能不算）；第三次普攻追加 item 伤害，不触发自身、不回能。
          if (actor.everyNBasic !== null && actor.basicCount % actor.everyNBasic === 0 && target.alive) {
            hit(state, actor, target, actor.extraPhysicalAttackRatio, 'item', 'physical');
          }
        }
      }
      frames.push({ tick: frames.length + 1, round, sideA: snapshot(state.A), sideB: snapshot(state.B), logs: structuredClone(state.logs) });
    }
    const aliveA = aliveUnits(state.A).length, aliveB = aliveUnits(state.B).length;
    if (aliveA === 0 || aliveB === 0) {
      reason = 'elimination';
      winner = aliveA === 0 && aliveB === 0 ? null : aliveA > 0 ? 'A' : 'B';
      state.logs = [];
      log(state, { side: 'system', kind: 'result', text: winner === null ? '双方同时退场：平局。' : winner === 'A' ? '战斗结束：A 方获胜。' : '战斗结束：B 方获胜。' });
      frames.push({ tick: frames.length + 1, round, sideA: snapshot(state.A), sideB: snapshot(state.B), logs: structuredClone(state.logs) });
    }
  }
  if (winner === null) {
    reason = 'round-limit';
    // 超时：sum(hp)/sum(maxHp) 交叉相乘比较，严格相等为平局（无守方默认胜）。
    const aliveA = aliveUnits(state.A), aliveB = aliveUnits(state.B);
    const totalA = state.A.reduce((sum, u) => sum + u.maxHp, 0), totalB = state.B.reduce((sum, u) => sum + u.maxHp, 0);
    const leftA = aliveA.reduce((sum, u) => sum + u.hp, 0), leftB = aliveB.reduce((sum, u) => sum + u.hp, 0);
    if (aliveA.length === 0 && aliveB.length === 0) winner = null;
    else if (aliveB.length === 0) winner = 'A';
    else if (aliveA.length === 0) winner = 'B';
    else winner = leftA * totalB > leftB * totalA ? 'A' : leftA * totalB < leftB * totalA ? 'B' : null;
    state.logs = [];
    log(state, { side: 'system', kind: 'result', text: maxRounds + ' 轮结束，剩余生命：A 方 ' + Math.round((totalA ? leftA / totalA : 0) * 100) + '%，B 方 ' + Math.round((totalB ? leftB / totalB : 0) * 100) + '%。' + (winner === null ? '严格相等：平局。' : winner === 'A' ? 'A 方获胜。' : 'B 方获胜。') });
    frames.push({ tick: frames.length + 1, round: state.round, sideA: snapshot(state.A), sideB: snapshot(state.B), logs: structuredClone(state.logs) });
  }
  return {
    version: 1, winner, reason, frames: thinFrames(frames, 400), synergies,
    summary: { rounds: state.round, frames: frames.length, hpRatioA: hpRatio(state.A), hpRatioB: hpRatio(state.B) },
  };
}
