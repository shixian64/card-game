// 「星契」：借鉴金铲铲 / TFT 的海克斯强化（Augment）结构，为本项目双人短局
// 提供的三选一长期增益。设计边界见 docs/AUGMENT_GAME_SYSTEM_DESIGN.md：
// - 每局固定三个时点：R2 / R5 / R8（对应原作的 2-1 / 3-2 / 4-2），双方候选相同；
// - 仅本局生效，不进入永久收藏、不交易、不换星币；
// - 效果分为经济 / 商店 / 战斗 / 羁绊 / 装备 / 人口六类，全部由本文件的数值表驱动；
// - 这里只做数据与纯函数聚合，服务端负责发放 / 校验 / 持久化，战斗内核只读取聚合结果。
import type { Affinity } from './data.ts';
import type { CombatRole, Synergy } from './battle.ts';
import { ROLE_SYNERGY_IDS } from './battle.ts';

export type AugmentTier = 1 | 2 | 3;
export type AugmentCategory = 'economy' | 'shop' | 'combat' | 'trait' | 'item' | 'tempo';
export interface AugmentTraitBonus {
  /** affinity：只加某个属性；role：只加某个职业；all：全部羁绊。 */
  kind: 'affinity' | 'role' | 'all';
  id?: Affinity | CombatRole;
  amount: number;
}
export interface AugmentEffects {
  // 经济
  goldPerRound?: number;
  interestCapBonus?: number;
  neutralGoldPct?: number;
  mergeGold?: number;
  // 商店 / 节奏
  rerollCostDelta?: number;
  freeRerollsPerRound?: number;
  grantFreeRerolls?: number;
  shopSlotBonus?: number;
  populationBonus?: number;
  // 装备
  itemSlotBonus?: number;
  itemCandidateBonus?: number;
  grantRandomItems?: number;
  itemPowerPct?: number;
  // 战斗（同类百分比在强化层先相加，再乘基础层）
  hpPct?: number;
  attackPct?: number;
  armorFlat?: number;
  resistanceFlat?: number;
  openingShieldPct?: number;
  roleHpPct?: Partial<Record<CombatRole, number>>;
  roleAttackPct?: Partial<Record<CombatRole, number>>;
  traitBonuses?: ReadonlyArray<AugmentTraitBonus>;
}
export interface AugmentDef {
  id: string;
  name: string;
  tier: AugmentTier;
  category: AugmentCategory;
  description: string;
  effects: AugmentEffects;
}

export const AUGMENT_TIERS: Readonly<Record<AugmentTier, { name: string; color: string }>> = Object.freeze({
  1: Object.freeze({ name: '微光星契', color: '#9aa3b2' }),
  2: Object.freeze({ name: '星辉星契', color: '#8f6bd0' }),
  3: Object.freeze({ name: '星冕星契', color: '#c9a13b' }),
});
export const AUGMENT_CATEGORY_NAMES: Readonly<Record<AugmentCategory, string>> = Object.freeze({
  economy: '经济', shop: '商店', combat: '战斗', trait: '羁绊', item: '装备', tempo: '节奏',
});
/** 每局三个固定时点；R2 对应第一次野怪之后，R5 / R8 分别在中盘与末盘。 */
export const AUGMENT_ROUNDS: ReadonlyArray<{ round: number; tier: AugmentTier }> = Object.freeze([
  Object.freeze({ round: 2, tier: 1 }),
  Object.freeze({ round: 5, tier: 2 }),
  Object.freeze({ round: 8, tier: 3 }),
]);
export const AUGMENT_CHOICES = 3;
export const AUGMENT_MAX = AUGMENT_ROUNDS.length;
export function augmentTierForRound(round: number): AugmentTier | null {
  return AUGMENT_ROUNDS.find(entry => entry.round === round)?.tier ?? null;
}
export function augmentPool(tier: AugmentTier): ReadonlyArray<AugmentDef> {
  return AUGMENTS.filter(augment => augment.tier === tier);
}

export const AUGMENTS: ReadonlyArray<AugmentDef> = Object.freeze([
  // ── 微光星契（R2）──────────────────────────────────────────────────────
  Object.freeze({ id: 't1_coin_purse', name: '私房钱袋', tier: 1, category: 'economy',
    description: '从下一轮开始，每轮开始额外获得 3 金币。', effects: { goldPerRound: 3 } }),
  Object.freeze({ id: 't1_light_reroll', name: '轻装刷新', tier: 1, category: 'shop',
    description: '刷新商店的费用 −2（最低 0 金）。', effects: { rerollCostDelta: -2 } }),
  Object.freeze({ id: 't1_wide_shelf', name: '加宽货架', tier: 1, category: 'shop',
    description: '商店多 1 格；下一次刷新 / 下一轮起生效。', effects: { shopSlotBonus: 1 } }),
  Object.freeze({ id: 't1_compound', name: '细水长流', tier: 1, category: 'economy',
    description: '利息上限 +1（每存 30 金仍得 1 金，最多 3 金）。', effects: { interestCapBonus: 1 } }),
  Object.freeze({ id: 't1_front_drill', name: '前列操典', tier: 1, category: 'combat',
    description: '坦克与战士最大生命 +10%。', effects: { roleHpPct: { 坦克: 0.10, 战士: 0.10 } } }),
  Object.freeze({ id: 't1_back_drill', name: '后排操典', tier: 1, category: 'combat',
    description: '射手与法师攻击 +8%。', effects: { roleAttackPct: { 射手: 0.08, 法师: 0.08 } } }),

  // ── 星辉星契（R5）─────────────────────────────────────────────────────
  Object.freeze({ id: 't2_moon_emblem', name: '月之徽', tier: 2, category: 'trait',
    description: '月系羁绊计数 +1；按不同卡种计数后追加。', effects: { traitBonuses: [{ kind: 'affinity', id: 'moon', amount: 1 }] } }),
  Object.freeze({ id: 't2_sun_emblem', name: '日之徽', tier: 2, category: 'trait',
    description: '日系羁绊计数 +1；按不同卡种计数后追加。', effects: { traitBonuses: [{ kind: 'affinity', id: 'sun', amount: 1 }] } }),
  Object.freeze({ id: 't2_forest_emblem', name: '森之徽', tier: 2, category: 'trait',
    description: '森系羁绊计数 +1；按不同卡种计数后追加。', effects: { traitBonuses: [{ kind: 'affinity', id: 'forest', amount: 1 }] } }),
  Object.freeze({ id: 't2_item_master', name: '装备精通', tier: 2, category: 'item',
    description: '装备的百分比效果 +25%，护甲平值同步提高。', effects: { itemPowerPct: 0.25 } }),
  Object.freeze({ id: 't2_third_slot', name: '第三装备槽', tier: 2, category: 'item',
    description: '每个单位可装备 3 件；同组装备仍不可重复。', effects: { itemSlotBonus: 1 } }),
  Object.freeze({ id: 't2_merge_bounty', name: '升星赏金', tier: 2, category: 'economy',
    description: '每次合星额外获得 6 金币。', effects: { mergeGold: 6 } }),
  Object.freeze({ id: 't2_free_reroll', name: '免费重掷', tier: 2, category: 'shop',
    description: '立即获得 3 次免费刷新，可跨轮保留。', effects: { grantFreeRerolls: 3 } }),

  // ── 星冕星契（R8）─────────────────────────────────────────────────────
  Object.freeze({ id: 't3_star_pact', name: '星冕盟约', tier: 3, category: 'combat',
    description: '全体最大生命 +12%、攻击 +10%。', effects: { hpPct: 0.12, attackPct: 0.10 } }),
  Object.freeze({ id: 't3_resonance', name: '万相共鸣', tier: 3, category: 'trait',
    description: '所有羁绊计数 +1（月 / 日 / 森与五职业）。', effects: { traitBonuses: [{ kind: 'all', amount: 1 }] } }),
  Object.freeze({ id: 't3_sixth_seat', name: '第六席', tier: 3, category: 'tempo',
    description: '人口上限 +1，最多 7 人上阵。', effects: { populationBonus: 1 } }),
  Object.freeze({ id: 't3_golden_age', name: '黄金时代', tier: 3, category: 'economy',
    description: '从下一轮开始，每轮开始额外获得 8 金币；利息上限 +1。', effects: { goldPerRound: 8, interestCapBonus: 1 } }),
  Object.freeze({ id: 't3_item_overflow', name: '装备洪流', tier: 3, category: 'item',
    description: '每个单位可装备 4 件，装备百分比效果 +15%。', effects: { itemSlotBonus: 2, itemPowerPct: 0.15 } }),
  Object.freeze({ id: 't3_aegis', name: '不落之盾', tier: 3, category: 'combat',
    description: '全体开局获得最大生命 15% 的护盾；与装备护盾合计最多 25%。', effects: { openingShieldPct: 0.15 } }),
  Object.freeze({ id: 't3_lootstorm', name: '战利品风暴', tier: 3, category: 'item',
    description: '立即获得 1 件随机装备；野怪金币 +100%，野怪装备候选 +1。', effects: { grantRandomItems: 1, neutralGoldPct: 1, itemCandidateBonus: 1 } }),
]);
export const AUGMENT_MAP: Readonly<Record<string, AugmentDef>> = Object.freeze(
  Object.fromEntries(AUGMENTS.map(augment => [augment.id, augment])),
);
export function augmentDef(id: string): AugmentDef {
  const def = AUGMENT_MAP[id];
  if (!def) throw new Error('未知星契：' + id);
  return def;
}

const COMBAT_ROLES: ReadonlyArray<CombatRole> = ['坦克', '战士', '射手', '法师', '刺客'];
export interface AggregatedAugmentEffects {
  goldPerRound: number; interestCapBonus: number; neutralGoldPct: number; mergeGold: number;
  rerollCostDelta: number; freeRerollsPerRound: number; grantFreeRerolls: number; shopSlotBonus: number; populationBonus: number;
  itemCandidateBonus: number; grantRandomItems: number; itemPowerPct: number;
  itemSlotBonus: number;
  hpPct: number; attackPct: number; armorFlat: number; resistanceFlat: number; openingShieldPct: number;
  roleHpPct: Record<CombatRole, number>; roleAttackPct: Record<CombatRole, number>;
  traitBonuses: ReadonlyArray<AugmentTraitBonus>;
}
export function emptyAugmentEffects(): AggregatedAugmentEffects {
  return {
    goldPerRound: 0, interestCapBonus: 0, neutralGoldPct: 0, mergeGold: 0,
    rerollCostDelta: 0, freeRerollsPerRound: 0, grantFreeRerolls: 0, shopSlotBonus: 0, populationBonus: 0,
    itemCandidateBonus: 0, grantRandomItems: 0, itemPowerPct: 0, itemSlotBonus: 0,
    hpPct: 0, attackPct: 0, armorFlat: 0, resistanceFlat: 0, openingShieldPct: 0,
    roleHpPct: { 坦克: 0, 战士: 0, 射手: 0, 法师: 0, 刺客: 0 },
    roleAttackPct: { 坦克: 0, 战士: 0, 射手: 0, 法师: 0, 刺客: 0 },
    traitBonuses: [],
  };
}
/** 把本局已选星契聚合成一层可读效果；未知 id 直接拒绝，不让脏数据静默生效。 */
export function aggregateAugmentEffects(ids: ReadonlyArray<string>): AggregatedAugmentEffects {
  const total = emptyAugmentEffects();
  const bonuses: AugmentTraitBonus[] = [];
  for (const id of ids) {
    const effects = augmentDef(id).effects;
    total.goldPerRound += effects.goldPerRound ?? 0;
    total.interestCapBonus += effects.interestCapBonus ?? 0;
    total.neutralGoldPct += effects.neutralGoldPct ?? 0;
    total.mergeGold += effects.mergeGold ?? 0;
    total.rerollCostDelta += effects.rerollCostDelta ?? 0;
    total.freeRerollsPerRound += effects.freeRerollsPerRound ?? 0;
    total.grantFreeRerolls += effects.grantFreeRerolls ?? 0;
    total.shopSlotBonus += effects.shopSlotBonus ?? 0;
    total.populationBonus += effects.populationBonus ?? 0;
    total.itemSlotBonus += effects.itemSlotBonus ?? 0;
    total.itemCandidateBonus += effects.itemCandidateBonus ?? 0;
    total.grantRandomItems += effects.grantRandomItems ?? 0;
    total.itemPowerPct += effects.itemPowerPct ?? 0;
    total.hpPct += effects.hpPct ?? 0;
    total.attackPct += effects.attackPct ?? 0;
    total.armorFlat += effects.armorFlat ?? 0;
    total.resistanceFlat += effects.resistanceFlat ?? 0;
    total.openingShieldPct += effects.openingShieldPct ?? 0;
    if (effects.roleHpPct) for (const role of COMBAT_ROLES) total.roleHpPct[role] += effects.roleHpPct[role] ?? 0;
    if (effects.roleAttackPct) for (const role of COMBAT_ROLES) total.roleAttackPct[role] += effects.roleAttackPct[role] ?? 0;
    if (effects.traitBonuses) bonuses.push(...effects.traitBonuses);
  }
  // 叠加上限：装备百分比最多 +50%，避免多个装备强化互相叠成不可读数值。
  total.itemPowerPct = Math.min(0.5, total.itemPowerPct);
  total.traitBonuses = bonuses;
  return total;
}
/** 把星契的羁绊计数加到 getSynergies 的结果上，并重算 active；不改写基础定义。 */
export function applyAugmentTraitBonuses(
  synergies: ReadonlyArray<Synergy>,
  bonuses: ReadonlyArray<AugmentTraitBonus>,
): Synergy[] {
  if (!bonuses.length) return synergies.map(synergy => ({ ...synergy }));
  return synergies.map(synergy => {
    let amount = 0;
    for (const bonus of bonuses) {
      if (bonus.kind === 'all') amount += bonus.amount;
      else if (bonus.kind === 'affinity' && synergy.id.startsWith('affinity-' + bonus.id + '-')) amount += bonus.amount;
      else if (bonus.kind === 'role' && bonus.id && synergy.id === 'role-' + ROLE_SYNERGY_IDS[bonus.id as CombatRole]) amount += bonus.amount;
    }
    if (!amount) return { ...synergy };
    const count = synergy.count + amount;
    return { ...synergy, count, active: count >= synergy.threshold };
  });
}

// 便于 UI / 文档遍历的分类顺序。
export const AUGMENT_CATEGORIES: ReadonlyArray<AugmentCategory> = Object.freeze(['economy', 'shop', 'combat', 'trait', 'item', 'tempo']);
