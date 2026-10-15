// 首版六件临时成装（DUEL-RULES-1 起测效果）。装备仅存在于本局：不进永久收藏、
// 不上玩家市场、不可卖金币；野怪补给三选一（进攻 / 防御 / 功能各一）免费获得。
// 组件配方仅预留结构（componentsEnabled=false），首版不做组件与额外货币。
export type ItemChoiceGroup = 'offense' | 'defense' | 'utility';
export interface ItemEffects {
  /** 攻击属性 +%（普攻与攻击型技能共享；以最终攻击参与现有公式，不改攻击频率）。 */
  attackPct?: number;
  /** 技能伤害 / 技能护盾系数 +%。 */
  skillCoefficientPct?: number;
  /** 最大生命 +%（生成满血单位时以最终 maxHp 生效）。 */
  maxHpPct?: number;
  /** 护甲平值（最后加一次）。 */
  armorFlat?: number;
  /** 开局获得最终最大生命 N% 的一次性护盾（一场一次，不每帧刷新）。 */
  openingShieldMaxHpPct?: number;
  /** 普攻后额外能量（不在技能 / 装备额外伤害后触发；封顶 100）。 */
  energyOnBasic?: number;
  /** 每第 N 次合法普攻追加 60% 当前攻击的物理伤害（额外伤害不触发自身、不回能）。 */
  everyNBasic?: number;
  extraPhysicalAttackRatio?: number;
}
export interface ItemDef {
  id: string; name: string; choiceGroup: ItemChoiceGroup; uniqueGroup: string;
  description: string; effects: ItemEffects;
}
export const DUEL_ITEMS: ReadonlyArray<ItemDef> = Object.freeze([
  Object.freeze({ id: 'edge_sigil', name: '锋刃符', choiceGroup: 'offense', uniqueGroup: 'edge_sigil', effects: { attackPct: 0.12 },
    description: '攻击属性 +12%（普攻与攻击型技能共享；不改变攻击频率）。' }),
  Object.freeze({ id: 'astral_lens', name: '织星镜', choiceGroup: 'offense', uniqueGroup: 'astral_lens', effects: { skillCoefficientPct: 0.12 },
    description: '技能伤害 / 技能护盾系数 +12%。' }),
  Object.freeze({ id: 'stone_mail', name: '石脉甲', choiceGroup: 'defense', uniqueGroup: 'stone_mail', effects: { maxHpPct: 0.15, armorFlat: 8 },
    description: '最大生命 +15%、护甲 +8。' }),
  Object.freeze({ id: 'dawn_charm', name: '晨曦护符', choiceGroup: 'defense', uniqueGroup: 'dawn_charm', effects: { openingShieldMaxHpPct: 0.12 },
    description: '开局获得最终最大生命 12% 的护盾（一场一次）。' }),
  Object.freeze({ id: 'echo_prism', name: '回响棱', choiceGroup: 'utility', uniqueGroup: 'echo_prism', effects: { energyOnBasic: 8 },
    description: '普攻后额外获得 8 能量。' }),
  Object.freeze({ id: 'hunter_seal', name: '猎星印', choiceGroup: 'utility', uniqueGroup: 'hunter_seal', effects: { everyNBasic: 3, extraPhysicalAttackRatio: 0.6 },
    description: '每第三次合法普攻追加 60% 当前攻击的物理伤害（额外伤害不回能、不再触发自身）。' }),
]);
export const DUEL_ITEM_MAP: Readonly<Record<string, ItemDef>> = Object.freeze(Object.fromEntries(DUEL_ITEMS.map(item => [item.id, item])));
export const DUEL_EQUIPMENT = Object.freeze({
  temporary: true,
  slotsPerUnit: 2,
  totalInstanceLimit: 12,
  guaranteedCompleteItemsPerFullMatch: 3,
  choiceGroups: Object.freeze(['offense', 'defense', 'utility']),
  sameChoicesBothPlayers: true,
  claimWindow: 'next_planning_phase',
  timeoutAction: 'fixed_candidate_order_first_into_inventory',
  autoEquipOnTimeout: false,
  unequipCost: 0,
  canSell: false,
  returnOnUnitSell: true,
  mergePolicy: 'keeper_keeps_other_items_return',
  // 装备新增的开局护盾总量上限为最终 HP 的 25%。
  addedOpeningShieldHpPctCap: 0.25,
  componentsEnabled: false,
  // 预留组件 / 配方结构（第二阶段；首版不实现组件 UI 与合成）。
  componentKind: 'component' as const,
  recipeVersion: 0,
});
export function duelItemDef(id: string): ItemDef {
  const def = DUEL_ITEM_MAP[id];
  if (!def) throw new Error('未知装备：' + id);
  return def;
}
/** 装备层聚合：同类百分比先相加再乘基础层；平值护甲最后加一次（应用顺序见设计文档 9.3）。 */
export interface EquipmentAggregate {
  attackPct: number; skillCoefficientPct: number; maxHpPct: number; armorFlat: number;
  openingShieldMaxHpPct: number; energyOnBasic: number; everyNBasic: number | null; extraPhysicalAttackRatio: number;
}
export function aggregateEquipment(itemIds: ReadonlyArray<string>): EquipmentAggregate {
  const agg: EquipmentAggregate = { attackPct: 0, skillCoefficientPct: 0, maxHpPct: 0, armorFlat: 0, openingShieldMaxHpPct: 0, energyOnBasic: 0, everyNBasic: null, extraPhysicalAttackRatio: 0 };
  for (const id of itemIds) {
    const def = duelItemDef(id), e = def.effects;
    agg.attackPct += e.attackPct ?? 0;
    agg.skillCoefficientPct += e.skillCoefficientPct ?? 0;
    agg.maxHpPct += e.maxHpPct ?? 0;
    agg.armorFlat += e.armorFlat ?? 0;
    agg.openingShieldMaxHpPct += e.openingShieldMaxHpPct ?? 0;
    agg.energyOnBasic += e.energyOnBasic ?? 0;
    if (e.everyNBasic !== undefined) {
      agg.everyNBasic = agg.everyNBasic === null ? e.everyNBasic : Math.min(agg.everyNBasic, e.everyNBasic);
      agg.extraPhysicalAttackRatio += e.extraPhysicalAttackRatio ?? 0;
    }
  }
  if (agg.openingShieldMaxHpPct > DUEL_EQUIPMENT.addedOpeningShieldHpPctCap) agg.openingShieldMaxHpPct = DUEL_EQUIPMENT.addedOpeningShieldHpPctCap;
  return agg;
}
/**
 * 穿戴校验：两槽 / 单位；同 uniqueGroup 一单位不得重复（背包可以存重复）。
 * 入参是装备定义 id（实例归属由房间服务校验），非法定义直接抛错。
 */
export function validateEquip(equippedDefIds: ReadonlyArray<string>, newItemDefId: string): void {
  const def = duelItemDef(newItemDefId);
  if (equippedDefIds.length >= DUEL_EQUIPMENT.slotsPerUnit) throw new Error('每个单位最多装备 2 件');
  if (equippedDefIds.some(id => duelItemDef(id).uniqueGroup === def.uniqueGroup)) throw new Error('同组装备不能重复穿戴在同一单位');
}
