// 短局 1v1 主对局规则配置（DUEL-RULES-1，起测默认值，未经用户最终确认）。
// 来源：docs/references/duel-rules-draft-20261014.json / docs/SHORT_DUEL_GAME_SYSTEM_DESIGN.md。
// 本文件是双人主对局的唯一规则数值来源：房间节奏、品质价格、星级倍率、金币供给、
// 野怪营地与永久奖励全部集中在此；旧单人局（server/match.mjs MATCH_RULES v3）不读取本表，
// 旧局价格 / 星级 / 回合不受影响。
export const DUEL_RULES_VERSION = 1;

export type RoundKind = 'neutral' | 'pvp';
export interface DuelRoundRule {
  round: number;
  kind: RoundKind;
  planningSec: number;
  combatPresentationSec: number;
  settlementSec: number;
  population: number;
  pvpLossHp: number;
}
export const DUEL_ROUNDS: ReadonlyArray<DuelRoundRule> = Object.freeze([
  { round: 1, kind: 'neutral', planningSec: 30, combatPresentationSec: 20, settlementSec: 3, population: 3, pvpLossHp: 0 },
  { round: 2, kind: 'pvp', planningSec: 35, combatPresentationSec: 25, settlementSec: 3, population: 3, pvpLossHp: 4 },
  { round: 3, kind: 'pvp', planningSec: 25, combatPresentationSec: 25, settlementSec: 3, population: 4, pvpLossHp: 4 },
  { round: 4, kind: 'neutral', planningSec: 25, combatPresentationSec: 20, settlementSec: 3, population: 4, pvpLossHp: 0 },
  { round: 5, kind: 'pvp', planningSec: 35, combatPresentationSec: 25, settlementSec: 3, population: 5, pvpLossHp: 6 },
  { round: 6, kind: 'pvp', planningSec: 25, combatPresentationSec: 25, settlementSec: 3, population: 5, pvpLossHp: 6 },
  { round: 7, kind: 'neutral', planningSec: 25, combatPresentationSec: 25, settlementSec: 3, population: 6, pvpLossHp: 0 },
  { round: 8, kind: 'pvp', planningSec: 35, combatPresentationSec: 25, settlementSec: 3, population: 6, pvpLossHp: 8 },
  { round: 9, kind: 'pvp', planningSec: 25, combatPresentationSec: 25, settlementSec: 3, population: 6, pvpLossHp: 8 },
  { round: 10, kind: 'pvp', planningSec: 25, combatPresentationSec: 25, settlementSec: 3, population: 6, pvpLossHp: 8 },
]);
export const DUEL_ROUND_COUNT = DUEL_ROUNDS.length;
export function duelRoundRule(round: number): DuelRoundRule {
  const rule = DUEL_ROUNDS[round - 1];
  if (!rule) throw new Error('轮次不在 1–10 内');
  return rule;
}
// 理论总时长 555 秒（备战 285 + 展示 240 + 结算 30），不含等人 / 登录 / 赛前编辑。
export const DUEL_THEORETICAL_DURATION_SEC = DUEL_ROUNDS.reduce(
  (sum, r) => sum + r.planningSec + r.combatPresentationSec + r.settlementSec, 0);

export const DUEL_ROOM = Object.freeze({
  lobbyExpiresSec: 120,
  disconnectGraceSec: 60,
  pollIntervalMs: 2000,
  schedulerTickMs: 1000,
});

// ── 战斗判定 ───────────────────────────────────────────────────────────────
export const DUEL_COMBAT = Object.freeze({
  initialPlayerHp: 32,
  logicalRoundLimit: 24,
  drawAllowed: true,
  // 超时按 sum(hp)/sum(maxHp) 交叉相乘比较，严格相等为平局；无守方默认胜。
  timeoutCompare: 'remaining_total_hp_ratio',
  survivorExtraPlayerDamage: false,
});

// ── 牌组与商店 ─────────────────────────────────────────────────────────────
export const DUEL_LOADOUT = Object.freeze({
  definitionCount: 8,
  distinctDefinitions: true,
  requireOwned: true,
  requireFrontline: true,
  requireRanged: true,
  // 每种卡在开局冻结一个本局品质 battleQuality ≤ 最高拥有品质，默认最高可降阶；整局不变。
  qualitySelection: 'fixed_per_definition_at_start',
  qualityMayProjectDown: true,
  shopSlots: 5,
  definitionSampling: 'uniform_with_replacement',
  randomQualityPerOffer: false,
  rosterLimit: 15,
  starterCopies: 2,
  starterDifferentDefinitions: true,
  starterBasis: 0,
});

// ── 品质：价格与成长（成长幅度沿用现有克制阶梯，价格改为 10/11/12/13/14）──────
export const DUEL_QUALITY = Object.freeze({
  shopGold: Object.freeze([10, 11, 12, 13, 14]),
  hpMultiplier: Object.freeze([1, 1.04, 1.08, 1.12, 1.16]),
  attackMultiplier: Object.freeze([1, 1.03, 1.06, 1.09, 1.12]),
  skillCoefficientMultiplier: Object.freeze([1, 1.03, 1.06, 1.09, 1.12]),
});
export function duelShopPrice(quality: number): number {
  const price = DUEL_QUALITY.shopGold[quality - 1];
  if (!price) throw new Error('品质不合法');
  return price;
}

// ── 局内星级（新倍率候选，与旧局 1.12/0.08 隔离；技能系数首次随星级缩放）──────
export const DUEL_STARS = Object.freeze({
  requiredCopies: 3,
  maxStars: 3,
  hpMultiplier: Object.freeze([1, 1.35, 1.8]),
  attackMultiplier: Object.freeze([1, 1.25, 1.6]),
  skillCoefficientMultiplier: Object.freeze([1, 1.1, 1.2]),
  basisMerge: 'sum_inputs',
});

// ── 金币：保底供给、轻利息、无连胜连败 / XP ─────────────────────────────────
export const DUEL_GOLD = Object.freeze({
  initial: 40,
  baseFromRound: 2,
  basePerRound: 20,
  rerollCost: 10,
  interest: Object.freeze({ per: 30, step: 1, cap: 2, basis: 'frozen_pre_reward_gold' }),
  pvpSupplyPerPlayer: 2,
  pvpSupplyIndependentOfOutcome: true,
  streakBonus: 0,
  winGoldBonus: 0,
  xpPurchases: false,
  refund: 'unit_basis',
  terminalFutureIncome: false,
  convertToPermanentCoins: false,
});

// ── 野怪营地（中立实体；不随玩家品质变强）──────────────────────────────────
export interface NeutralMonsterStats { hp: number; attack: number; armor: number; resistance: number; range: number; initiative: number }
export interface NeutralMonsterDef { id: string; name: string; count: number; stats: NeutralMonsterStats; behavior: 'basic_only'; neutralLocalSlots: ReadonlyArray<number> }
export interface NeutralCampDef { round: number; id: string; name: string; guaranteedGold: number; winBonusGold: number; guaranteedEquipmentChoice: boolean; playerHpLossOnFailure: 0; monsters: ReadonlyArray<NeutralMonsterDef> }
export const DUEL_NEUTRAL_CAMPS: ReadonlyArray<NeutralCampDef> = Object.freeze([
  Object.freeze({ round: 1, id: 'forest_sentry', name: '林间巡哨', guaranteedGold: 12, winBonusGold: 2, guaranteedEquipmentChoice: true, playerHpLossOnFailure: 0,
    monsters: Object.freeze([Object.freeze({ id: 'young_spirit', name: '幼灵兽', count: 2, stats: Object.freeze({ hp: 80, attack: 8, armor: 5, resistance: 5, range: 1, initiative: 45 }), behavior: 'basic_only', neutralLocalSlots: Object.freeze([1, 5]) })]) }),
  Object.freeze({ round: 4, id: 'stone_guard', name: '石林守卫', guaranteedGold: 18, winBonusGold: 3, guaranteedEquipmentChoice: true, playerHpLossOnFailure: 0,
    monsters: Object.freeze([
      Object.freeze({ id: 'stone_guard', name: '石甲守卫', count: 1, stats: Object.freeze({ hp: 260, attack: 18, armor: 30, resistance: 10, range: 1, initiative: 40 }), behavior: 'basic_only', neutralLocalSlots: Object.freeze([3]) }),
      Object.freeze({ id: 'crystal_thrower', name: '晶刺投手', count: 1, stats: Object.freeze({ hp: 110, attack: 16, armor: 5, resistance: 10, range: 3, initiative: 60 }), behavior: 'basic_only', neutralLocalSlots: Object.freeze([17]) }),
    ]) }),
  Object.freeze({ round: 7, id: 'star_nest', name: '星潮巢穴', guaranteedGold: 24, winBonusGold: 4, guaranteedEquipmentChoice: true, playerHpLossOnFailure: 0,
    monsters: Object.freeze([
      Object.freeze({ id: 'star_beast', name: '星噬兽', count: 1, stats: Object.freeze({ hp: 600, attack: 30, armor: 20, resistance: 20, range: 1, initiative: 45 }), behavior: 'basic_only', neutralLocalSlots: Object.freeze([3]) }),
      Object.freeze({ id: 'nest_guard', name: '巢穴卫兽', count: 2, stats: Object.freeze({ hp: 130, attack: 14, armor: 10, resistance: 10, range: 1, initiative: 55 }), behavior: 'basic_only', neutralLocalSlots: Object.freeze([1, 5]) }),
    ]) }),
]);
export function duelNeutralCamp(round: number): NeutralCampDef {
  const camp = DUEL_NEUTRAL_CAMPS.find(c => c.round === round);
  if (!camp) throw new Error('该轮次没有野怪营地');
  return camp;
}

// ── 永久奖励与反互刷配额（起测值；同事务一次结算）──────────────────────────
export const DUEL_REWARD = Object.freeze({
  base: Object.freeze({ win: 120, loss: 100, draw: 110 }),
  minimumForfeitOpponentSec: 180,
  minMeaningfulPlanningRounds: 4,
  minDistinctEverDeployed: 3,
  forfeiterCoins: 0,
  serviceAbortCoins: 0,
  pairQuota: Object.freeze({ dayBoundary: 'UTC', full: 3, half: 3, thenFactor: 0, key: 'unordered_internal_user_pair' }),
  personalQuota: Object.freeze({ sharedAcrossFormalModes: true, full: 6, half: 6 }),
  factorCombination: 'minimum',
  oncePerRoomPerUser: true,
});

// 十轮保底供给审计：40 + 9×20 + (12+18+24) + 6×2 = 286；利息独立上界 17 → 312。
export const DUEL_TOTAL_GUARANTEED_GOLD = DUEL_GOLD.initial
  + (DUEL_ROUND_COUNT - 1) * DUEL_GOLD.basePerRound
  + DUEL_NEUTRAL_CAMPS.reduce((sum, c) => sum + c.guaranteedGold, 0)
  + (DUEL_ROUND_COUNT - 1 - DUEL_NEUTRAL_CAMPS.length - /* 终局 R10 */ 0) * DUEL_GOLD.pvpSupplyPerPlayer;
