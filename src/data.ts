export type Affinity = 'moon' | 'sun' | 'forest';
// 卡种稀有度已按用户要求完全取消：新规则不存在 R/SR/SSR，也不再有隐藏基价。
// CardDef 不再有 rarity 字段；旧枚举只作为 LEGACY_RARITY 冻结映射保留，
// 仅供历史读取器 / 迁移工具 / 存量对局冻结价表使用（见 docs/CARD_PROGRESSION_ECONOMY_DESIGN.md 第 3 节）。
export type LegacyRarity = 'R' | 'SR' | 'SSR';
export interface CardDef {
  id: string; name: string; subtitle: string; affinity: Affinity;
  art: string; cost: number; base: number; trait: string; traitName: string; description: string;
}
export const AFFINITIES: Record<Affinity, { name: string; color: string }> = {
  moon: { name: '月', color: '#7784ab' }, sun: { name: '日', color: '#bb8246' }, forest: { name: '森', color: '#6f8870' },
};
export const CARDS: CardDef[] = [
  { id:'moon-deer', name:'月纱灵鹿', subtitle:'月光织就的温柔', affinity:'moon', art:'moon-deer', cost:3, base:9, trait:'echo', traitName:'夹心加分', description:'触发夹心，+12 分。' },
  { id:'sun-fox', name:'烛羽灵狐', subtitle:'温暖而明亮的相遇', affinity:'sun', art:'sun-fox', cost:3, base:10, trait:'flare', traitName:'末位加分', description:'放在第 3 张，+10 分。' },
  { id:'forest-rabbit', name:'苔冠旅者', subtitle:'在林间听见生长', affinity:'forest', art:'forest-rabbit', cost:2, base:7, trait:'bloom', traitName:'三色加分', description:'触发三异色，+10 分。' },
  { id:'moon-fawn', name:'银角初醒', subtitle:'第一缕安静的月光', affinity:'moon', art:'moon-fawn', cost:1, base:4, trait:'quiet', traitName:'首位加分', description:'放在第 1 张，+5 分。' },
  { id:'sun-cub', name:'晨光使者', subtitle:'把今天点亮一点', affinity:'sun', art:'sun-cub', cost:1, base:5, trait:'lead', traitName:'接日加分', description:'下一张是日系，+8 分。' },
  { id:'forest-sprout', name:'林间回响', subtitle:'小小的新生奇迹', affinity:'forest', art:'forest-sprout', cost:1, base:4, trait:'root', traitName:'省点加分', description:'每剩 1 点行动，+2 分。' },
  { id:'star-deer', name:'星河守望', subtitle:'漫长星夜的陪伴', affinity:'moon', art:'moon-deer', cost:2, base:7, trait:'tidal', traitName:'跟月加分', description:'上一张是月系，+9 分。' },
  { id:'golden-fox', name:'金焰巡游', subtitle:'穿过森林的暖风', affinity:'sun', art:'sun-fox', cost:2, base:7, trait:'duet', traitName:'跟森加分', description:'上一张是森系，+10 分。' },
  { id:'verdant-rabbit', name:'翡翠梦境', subtitle:'万千新芽的拥抱', affinity:'forest', art:'forest-rabbit', cost:3, base:8, trait:'weave', traitName:'组合加分', description:'三同色或三异色，+12 分。' },
  { id:'mist-deer', name:'薄雾来信', subtitle:'还记得上次的约定', affinity:'moon', art:'moon-fawn', cost:1, base:4, trait:'memory', traitName:'重复组合', description:'连续两回合组合相同，+9 分。' },
  { id:'dawn-fox', name:'曙色跃动', subtitle:'不留余力地闪耀', affinity:'sun', art:'sun-cub', cost:2, base:6, trait:'rush', traitName:'用尽加分', description:'刚好用完行动点，+12 分。' },
  { id:'breeze-sprout', name:'风铃新芽', subtitle:'为不一样的世界好奇', affinity:'forest', art:'forest-sprout', cost:2, base:7, trait:'wander', traitName:'三色居中', description:'触发三异色且在第 2 张，+14 分。' },
  // 图鉴变体复用六幅基础插画；差异来自颜色、行动消耗与技能，而非新增美术。
  { id:'lunar-guide', name:'雾灯引路', subtitle:'图鉴变体 · 月系接日', affinity:'moon', art:'moon-fawn', cost:1, base:4, trait:'lead', traitName:'接日加分', description:'下一张是日系，+8 分。' },
  { id:'silver-gap', name:'霜叶余白', subtitle:'图鉴变体 · 月系省点', affinity:'moon', art:'moon-fawn', cost:1, base:3, trait:'root', traitName:'省点加分', description:'每剩 1 点行动，+2 分。' },
  { id:'crescent-dancer', name:'弦月舞步', subtitle:'图鉴变体 · 月系中位', affinity:'moon', art:'moon-deer', cost:2, base:6, trait:'center', traitName:'中位加分', description:'放在第 2 张，+8 分。' },
  { id:'frost-return', name:'霜桥回音', subtitle:'图鉴变体 · 月系异色接力', affinity:'moon', art:'moon-fawn', cost:2, base:6, trait:'contrast', traitName:'异色接力', description:'上一张颜色不同，+7 分。' },
  { id:'moon-soloist', name:'静夜独奏', subtitle:'图鉴变体 · 月系单张', affinity:'moon', art:'moon-deer', cost:2, base:7, trait:'solo', traitName:'单张加分', description:'本回合只出这 1 张，+16 分。' },
  { id:'eclipse-deer', name:'月蚀织梦', subtitle:'图鉴变体 · 月系组合', affinity:'moon', art:'moon-deer', cost:3, base:8, trait:'weave', traitName:'组合加分', description:'三同色或三异色，+12 分。' },
  { id:'starlit-arch', name:'群星领唱', subtitle:'图鉴变体 · 月系三色', affinity:'moon', art:'moon-deer', cost:3, base:8, trait:'bloom', traitName:'三色加分', description:'触发三异色，+10 分。' },
  { id:'comet-tail', name:'彗尾落幕', subtitle:'图鉴变体 · 月系末位', affinity:'moon', art:'moon-deer', cost:3, base:9, trait:'flare', traitName:'末位加分', description:'放在第 3 张，+10 分。' },
  { id:'amber-pause', name:'琥珀留白', subtitle:'图鉴变体 · 日系省点', affinity:'sun', art:'sun-cub', cost:1, base:3, trait:'root', traitName:'省点加分', description:'每剩 1 点行动，+2 分。' },
  { id:'sun-first', name:'旭日先声', subtitle:'图鉴变体 · 日系首位', affinity:'sun', art:'sun-cub', cost:1, base:4, trait:'quiet', traitName:'首位加分', description:'放在第 1 张，+5 分。' },
  { id:'sun-center', name:'日环圆舞', subtitle:'图鉴变体 · 日系中位', affinity:'sun', art:'sun-fox', cost:2, base:6, trait:'center', traitName:'中位加分', description:'放在第 2 张，+8 分。' },
  { id:'sundial-memory', name:'日晷留声', subtitle:'图鉴变体 · 日系重复组合', affinity:'sun', art:'sun-cub', cost:2, base:6, trait:'memory', traitName:'重复组合', description:'连续两回合组合相同，+9 分。' },
  { id:'sun-change', name:'彩霞变奏', subtitle:'图鉴变体 · 日系变换组合', affinity:'sun', art:'sun-fox', cost:2, base:6, trait:'shift', traitName:'变换组合', description:'连续两回合组合不同，+11 分。' },
  { id:'solar-prism', name:'曜石万彩', subtitle:'图鉴变体 · 日系三色', affinity:'sun', art:'sun-fox', cost:3, base:8, trait:'bloom', traitName:'三色加分', description:'触发三异色，+10 分。' },
  { id:'gold-mirror', name:'金镜双生', subtitle:'图鉴变体 · 日系夹心', affinity:'sun', art:'sun-fox', cost:3, base:9, trait:'echo', traitName:'夹心加分', description:'触发夹心，+12 分。' },
  { id:'solstice-alone', name:'至日独照', subtitle:'图鉴变体 · 日系单张', affinity:'sun', art:'sun-fox', cost:3, base:9, trait:'solo', traitName:'单张加分', description:'本回合只出这 1 张，+16 分。' },
  { id:'fern-opener', name:'蕨叶先声', subtitle:'图鉴变体 · 森系首位', affinity:'forest', art:'forest-sprout', cost:1, base:4, trait:'quiet', traitName:'首位加分', description:'放在第 1 张，+5 分。' },
  { id:'moss-tide', name:'苔溪逐月', subtitle:'图鉴变体 · 森系跟月', affinity:'forest', art:'forest-sprout', cost:2, base:5, trait:'tidal', traitName:'跟月加分', description:'上一张是月系，+9 分。' },
  { id:'twig-change', name:'新枝变奏', subtitle:'图鉴变体 · 森系变换组合', affinity:'forest', art:'forest-sprout', cost:2, base:5, trait:'shift', traitName:'变换组合', description:'连续两回合组合不同，+11 分。' },
  { id:'clover-step', name:'三叶踏歌', subtitle:'图鉴变体 · 森系异色接力', affinity:'forest', art:'forest-rabbit', cost:2, base:6, trait:'contrast', traitName:'异色接力', description:'上一张颜色不同，+7 分。' },
  { id:'seed-center', name:'种子圆舞', subtitle:'图鉴变体 · 森系中位', affinity:'forest', art:'forest-sprout', cost:2, base:6, trait:'center', traitName:'中位加分', description:'放在第 2 张，+8 分。' },
  { id:'canopy-coda', name:'树冠终曲', subtitle:'图鉴变体 · 森系末位', affinity:'forest', art:'forest-rabbit', cost:3, base:9, trait:'flare', traitName:'末位加分', description:'放在第 3 张，+10 分。' },
  { id:'emerald-mirror', name:'翠镜回环', subtitle:'图鉴变体 · 森系夹心', affinity:'forest', art:'forest-rabbit', cost:3, base:9, trait:'echo', traitName:'夹心加分', description:'触发夹心，+12 分。' },
  { id:'bough-embrace', name:'连枝合唱', subtitle:'图鉴变体 · 森系接力', affinity:'forest', art:'forest-rabbit', cost:3, base:8, trait:'duet', traitName:'跟森加分', description:'上一张是森系，+10 分。' },
];
export const CARD_ART_NOTE = `${CARDS.length} 种玩法配置，共用 6 幅基础插画；新增 24 种为图鉴变体。`;
export const CARD_MAP = Object.fromEntries(CARDS.map(c=>[c.id,c])) as Record<string,CardDef>;

// ─── 新经济（单星币，推荐默认参数；用户拍板后只改 ECONOMY / QUALITY）──────────────
// 局外只有星币：抽卡 / 制作 / 回收 / 交易 / 奖励全部使用它；局内金币独立，不互通。
export const ECONOMY = {
  // 单抽三选一 60 星币（更适合定向）；十连 600 星币（省操作，无折扣、无额外保底）。
  singleDrawCost: 60,
  tenDrawCost: 600,
  // 定向制作：180 星币 → 一张已拥有卡种的 Q1；多余 Q1 回收每张 10 星币。
  craftCost: 180,
  recycleReturn: 10,
  // 新手礼包：600 星币（受限来源），23 张卡 / 至少 8 种（生成算法见 engine.ts claimStarter）。
  starterCoins: 600,
} as const;

// ─── legacy 冻结映射（allowlist：仅历史算分本地模式、迁移工具与存量对局读取）──────
// 旧星尘定价与旧三张包属于被否定的历史机制；除下列读者外不得再引用。
export const LEGACY_RARITY: Readonly<Record<string, LegacyRarity>> = Object.freeze(Object.fromEntries([
  ['moon-deer','SSR'],['sun-fox','SSR'],['forest-rabbit','SR'],['moon-fawn','R'],['sun-cub','R'],['forest-sprout','R'],
  ['star-deer','SR'],['golden-fox','SR'],['verdant-rabbit','SSR'],['mist-deer','R'],['dawn-fox','R'],['breeze-sprout','SR'],
  ['lunar-guide','R'],['silver-gap','R'],['crescent-dancer','SR'],['frost-return','SR'],['moon-soloist','SR'],['eclipse-deer','SSR'],
  ['starlit-arch','SSR'],['comet-tail','SSR'],['amber-pause','R'],['sun-first','R'],['sun-center','SR'],['sundial-memory','SR'],
  ['sun-change','SR'],['solar-prism','SSR'],['gold-mirror','SSR'],['solstice-alone','SSR'],['fern-opener','R'],['moss-tide','R'],
  ['twig-change','R'],['clover-step','SR'],['seed-center','SR'],['canopy-coda','SSR'],['emerald-mirror','SSR'],['bough-embrace','SSR'],
] as Array<[string, LegacyRarity]>));
// 旧三张包 / 星尘制作分解价：仅历史本地模式与迁移 dry-run 展示用，不再是可用接口。
export const LEGACY_ECONOMY = Object.freeze({
  packCost: 180,
  dustPerTicket: 180, // 旧券折算讨论草案：1 券 = 180 星币（未获确认，不自动执行）
  dustPerDust: 1,     // 旧星尘折算讨论草案：1 星尘 = 1 星币（未获确认，不自动执行）
  craft: Object.freeze({ R: 60, SR: 180, SSR: 480 } as Record<LegacyRarity, number>),
  recycle: Object.freeze({ R: 10, SR: 30, SSR: 80 } as Record<LegacyRarity, number>),
  // 旧对局（迁移窗口）出售价冻结：按旧稀有度基价 ×10，低于任何新品质价，杜绝低买高卖。
  sellBase: Object.freeze({ R: 10, SR: 20, SSR: 30 } as Record<LegacyRarity, number>),
});

// 旧对局（v1/v2 存续局）冻结招募价：旧稀有度基价 × 品质系数，与服务端
// server/match.mjs legacyUnitPrice 同表；前端出售预览必须与后端口径一致。
export const LEGACY_SHOP_MULTIPLIER: ReadonlyArray<number> = Object.freeze([1, 1.1, 1.25, 1.45, 1.7]);
export function legacyUnitPrice(defId: string, quality: number): number {
  return Math.round((LEGACY_ECONOMY.sellBase[LEGACY_RARITY[defId] ?? 'R'] ?? 10) * (LEGACY_SHOP_MULTIPLIER[quality - 1] ?? 1));
}

// ─── 统一品质体系（待确认默认参数；用户拍板后只改这一个表）──────────────────
// 永久品质记录在卡实例 rank 字段（1..5）；所有卡种使用同一品质阶梯与上限。
export interface QualityTier { level:number; name:string; hint:string; color:string }
export type ForgeBranch='upgrade_one'|'upgrade_two'|'fail';
export const QUALITY_MAX=5;
export const QUALITY_TIERS:QualityTier[]=[
  {level:1,name:'微光',hint:'初始品质',color:'#9aa3b2'},
  {level:2,name:'流光',hint:'一次升阶',color:'#5f9e6e'},
  {level:3,name:'星辉',hint:'旧 Lv.3 对应档',color:'#4d7fc4'},
  {level:4,name:'星芒',hint:'新增高档',color:'#8f6bd0'},
  {level:5,name:'星冕',hint:'当前最高品质',color:'#c9a13b'},
];
export function qualityTier(rank:number):QualityTier{const tier=QUALITY_TIERS[rank-1];if(!tier)throw new Error('未知品质');return tier;}
export function qualityName(rank:number):string{return QUALITY_TIERS[rank-1]?.name??('Q'+rank);}
export const QUALITY={
  // 抽卡品质概率（每张，严格递减、总和 100%）。单抽：先抽品质，再给 3 个同品质不同卡种候选；
  // 十连：10 次独立抽取（卡种全池均匀有放回），无保底、无折扣。
  summonQuality:[52,28,13,5.5,1.5],
  // 局内商店品质权重（与抽卡共用初值但字段分开，调整互不影响）。
  shopQuality:[52,28,13,5.5,1.5],
  // 同卡合成：主卡 + 2 张同 defId、同品质材料 + 星币；单次均匀随机数定分支，
  // fail / upgrade_two / upgrade_one 三者互斥且和为 100%（two 为 0 时并入 one）。
  forge:{materials:2,coins:[60,120,240,480],fail:[10,20,35,49.8],upgradeTwo:[0.5,0.4,0.3,0],
    // 失败返还：主卡必定保留、品质不降、不销毁；星币不退；
    // 2 张材料随机返还 1 张（60%）或 2 张（40%），不返还的作为失败代价消失。
    failReturnOne:60},
  // 局内成长：每档 HP +4%、ATK +3%、技能系数 +3%（加法式，Q5 = +16%/+12%/+12%）；
  // 护甲 / 魔抗 / 射程 / 先手不变；局内星级 stars 公式独立相乘。
  growth:{hp:4,attack:3,skill:3},
  // 局内购买价只由品质决定（金币刻度 ×10：初始 120、基础收入 50、利息每 100 金 +10 上限 50、
  // 刷新 20、买经验 40）；出售 = 该单位累计 basis（正常价 = 购买价 × 3^(星级−1)）。
  shop:{price:[10,11,13,15,17]},
};
/** 新规则招募价：只接受品质，不读取任何卡种差异；旧 cost 是历史算分行动消耗，不是基价。 */
export function unitShopPrice(quality:number):number{
  const price=QUALITY.shop.price[quality-1];
  if(!price)throw new Error('品质不合法');
  return price;
}
export const COMBOS = [
  { id:'mono', name:'三同色', pattern:'A · A · A', detail:'3 张同色，+20 分。', bonus:20 },
  { id:'trio', name:'三异色', pattern:'A · B · C', detail:'3 张颜色各不同，+18 分。', bonus:18 },
  { id:'mirror', name:'夹心', pattern:'A · B · A', detail:'同色夹异色，+12 分。', bonus:12 },
];
export const TALENTS = [
  { id:'prism', name:'三色倍率', title:'三异色得分更高', description:'三异色的本回合总分 ×1.3。', icon:'prism' },
  { id:'harmony', name:'同色加分', title:'专攻三同色', description:'三同色额外 +18 分。', icon:'heart' },
  { id:'echo', name:'夹心加分', title:'专攻夹心', description:'夹心额外 +16 分。', icon:'moon' },
  { id:'energy', name:'行动点 +1', title:'每回合多 1 点', description:'每回合行动点上限 +1。', icon:'leaf' },
  { id:'focus', name:'省点加分', title:'少花点，多加分', description:'每剩 1 点行动，+4 分。', icon:'sparkle' },
  { id:'growth', name:'基础分 +3', title:'每张牌都加分', description:'每张牌基础分 +3。', icon:'star' },
];
export const CONDITIONS = [
  { id:'sun', name:'日系加分', description:'每张日系牌 +4 分。', affinity:'sun' },
  { id:'quiet', name:'节省行动', description:'每剩 1 点行动，+3 分。', affinity:null },
  { id:'trio', name:'三异色加分', description:'三异色额外 +10 分。', affinity:null },
  { id:'moon', name:'月系加分', description:'每张月系牌 +4 分。', affinity:'moon' },
  { id:'mirror', name:'夹心加分', description:'夹心额外 +12 分。', affinity:null },
  { id:'forest', name:'森系加分', description:'每张森系牌 +4 分。', affinity:'forest' },
];
