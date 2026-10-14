export type Affinity = 'moon' | 'sun' | 'forest';
export type Rarity = 'R' | 'SR' | 'SSR';
export interface CardDef {
  id: string; name: string; subtitle: string; affinity: Affinity; rarity: Rarity;
  art: string; cost: number; base: number; trait: string; traitName: string; description: string;
}
export const AFFINITIES: Record<Affinity, { name: string; color: string }> = {
  moon: { name: '月', color: '#7784ab' }, sun: { name: '日', color: '#bb8246' }, forest: { name: '森', color: '#6f8870' },
};
export const CARDS: CardDef[] = [
  { id:'moon-deer', name:'月纱灵鹿', subtitle:'月光织就的温柔', affinity:'moon', rarity:'SSR', art:'moon-deer', cost:3, base:9, trait:'echo', traitName:'夹心加分', description:'触发夹心，+12 分。' },
  { id:'sun-fox', name:'烛羽灵狐', subtitle:'温暖而明亮的相遇', affinity:'sun', rarity:'SSR', art:'sun-fox', cost:3, base:10, trait:'flare', traitName:'末位加分', description:'放在第 3 张，+10 分。' },
  { id:'forest-rabbit', name:'苔冠旅者', subtitle:'在林间听见生长', affinity:'forest', rarity:'SR', art:'forest-rabbit', cost:2, base:7, trait:'bloom', traitName:'三色加分', description:'触发三异色，+10 分。' },
  { id:'moon-fawn', name:'银角初醒', subtitle:'第一缕安静的月光', affinity:'moon', rarity:'R', art:'moon-fawn', cost:1, base:4, trait:'quiet', traitName:'首位加分', description:'放在第 1 张，+5 分。' },
  { id:'sun-cub', name:'晨光使者', subtitle:'把今天点亮一点', affinity:'sun', rarity:'R', art:'sun-cub', cost:1, base:5, trait:'lead', traitName:'接日加分', description:'下一张是日系，+8 分。' },
  { id:'forest-sprout', name:'林间回响', subtitle:'小小的新生奇迹', affinity:'forest', rarity:'R', art:'forest-sprout', cost:1, base:4, trait:'root', traitName:'省点加分', description:'每剩 1 点行动，+2 分。' },
  { id:'star-deer', name:'星河守望', subtitle:'漫长星夜的陪伴', affinity:'moon', rarity:'SR', art:'moon-deer', cost:2, base:7, trait:'tidal', traitName:'跟月加分', description:'上一张是月系，+9 分。' },
  { id:'golden-fox', name:'金焰巡游', subtitle:'穿过森林的暖风', affinity:'sun', rarity:'SR', art:'sun-fox', cost:2, base:7, trait:'duet', traitName:'跟森加分', description:'上一张是森系，+10 分。' },
  { id:'verdant-rabbit', name:'翡翠梦境', subtitle:'万千新芽的拥抱', affinity:'forest', rarity:'SSR', art:'forest-rabbit', cost:3, base:8, trait:'weave', traitName:'组合加分', description:'三同色或三异色，+12 分。' },
  { id:'mist-deer', name:'薄雾来信', subtitle:'还记得上次的约定', affinity:'moon', rarity:'R', art:'moon-fawn', cost:1, base:4, trait:'memory', traitName:'重复组合', description:'连续两回合组合相同，+9 分。' },
  { id:'dawn-fox', name:'曙色跃动', subtitle:'不留余力地闪耀', affinity:'sun', rarity:'R', art:'sun-cub', cost:2, base:6, trait:'rush', traitName:'用尽加分', description:'刚好用完行动点，+12 分。' },
  { id:'breeze-sprout', name:'风铃新芽', subtitle:'为不一样的世界好奇', affinity:'forest', rarity:'SR', art:'forest-sprout', cost:2, base:7, trait:'wander', traitName:'三色居中', description:'触发三异色且在第 2 张，+14 分。' },
  // 图鉴变体复用六幅基础插画；差异来自颜色、行动消耗与技能，而非新增美术。
  { id:'lunar-guide', name:'雾灯引路', subtitle:'图鉴变体 · 月系接日', affinity:'moon', rarity:'R', art:'moon-fawn', cost:1, base:4, trait:'lead', traitName:'接日加分', description:'下一张是日系，+8 分。' },
  { id:'silver-gap', name:'霜叶余白', subtitle:'图鉴变体 · 月系省点', affinity:'moon', rarity:'R', art:'moon-fawn', cost:1, base:3, trait:'root', traitName:'省点加分', description:'每剩 1 点行动，+2 分。' },
  { id:'crescent-dancer', name:'弦月舞步', subtitle:'图鉴变体 · 月系中位', affinity:'moon', rarity:'SR', art:'moon-deer', cost:2, base:6, trait:'center', traitName:'中位加分', description:'放在第 2 张，+8 分。' },
  { id:'frost-return', name:'霜桥回音', subtitle:'图鉴变体 · 月系异色接力', affinity:'moon', rarity:'SR', art:'moon-fawn', cost:2, base:6, trait:'contrast', traitName:'异色接力', description:'上一张颜色不同，+7 分。' },
  { id:'moon-soloist', name:'静夜独奏', subtitle:'图鉴变体 · 月系单张', affinity:'moon', rarity:'SR', art:'moon-deer', cost:2, base:7, trait:'solo', traitName:'单张加分', description:'本回合只出这 1 张，+16 分。' },
  { id:'eclipse-deer', name:'月蚀织梦', subtitle:'图鉴变体 · 月系组合', affinity:'moon', rarity:'SSR', art:'moon-deer', cost:3, base:8, trait:'weave', traitName:'组合加分', description:'三同色或三异色，+12 分。' },
  { id:'starlit-arch', name:'群星领唱', subtitle:'图鉴变体 · 月系三色', affinity:'moon', rarity:'SSR', art:'moon-deer', cost:3, base:8, trait:'bloom', traitName:'三色加分', description:'触发三异色，+10 分。' },
  { id:'comet-tail', name:'彗尾落幕', subtitle:'图鉴变体 · 月系末位', affinity:'moon', rarity:'SSR', art:'moon-deer', cost:3, base:9, trait:'flare', traitName:'末位加分', description:'放在第 3 张，+10 分。' },
  { id:'amber-pause', name:'琥珀留白', subtitle:'图鉴变体 · 日系省点', affinity:'sun', rarity:'R', art:'sun-cub', cost:1, base:3, trait:'root', traitName:'省点加分', description:'每剩 1 点行动，+2 分。' },
  { id:'sun-first', name:'旭日先声', subtitle:'图鉴变体 · 日系首位', affinity:'sun', rarity:'R', art:'sun-cub', cost:1, base:4, trait:'quiet', traitName:'首位加分', description:'放在第 1 张，+5 分。' },
  { id:'sun-center', name:'日环圆舞', subtitle:'图鉴变体 · 日系中位', affinity:'sun', rarity:'SR', art:'sun-fox', cost:2, base:6, trait:'center', traitName:'中位加分', description:'放在第 2 张，+8 分。' },
  { id:'sundial-memory', name:'日晷留声', subtitle:'图鉴变体 · 日系重复组合', affinity:'sun', rarity:'SR', art:'sun-cub', cost:2, base:6, trait:'memory', traitName:'重复组合', description:'连续两回合组合相同，+9 分。' },
  { id:'sun-change', name:'彩霞变奏', subtitle:'图鉴变体 · 日系变换组合', affinity:'sun', rarity:'SR', art:'sun-fox', cost:2, base:6, trait:'shift', traitName:'变换组合', description:'连续两回合组合不同，+11 分。' },
  { id:'solar-prism', name:'曜石万彩', subtitle:'图鉴变体 · 日系三色', affinity:'sun', rarity:'SSR', art:'sun-fox', cost:3, base:8, trait:'bloom', traitName:'三色加分', description:'触发三异色，+10 分。' },
  { id:'gold-mirror', name:'金镜双生', subtitle:'图鉴变体 · 日系夹心', affinity:'sun', rarity:'SSR', art:'sun-fox', cost:3, base:9, trait:'echo', traitName:'夹心加分', description:'触发夹心，+12 分。' },
  { id:'solstice-alone', name:'至日独照', subtitle:'图鉴变体 · 日系单张', affinity:'sun', rarity:'SSR', art:'sun-fox', cost:3, base:9, trait:'solo', traitName:'单张加分', description:'本回合只出这 1 张，+16 分。' },
  { id:'fern-opener', name:'蕨叶先声', subtitle:'图鉴变体 · 森系首位', affinity:'forest', rarity:'R', art:'forest-sprout', cost:1, base:4, trait:'quiet', traitName:'首位加分', description:'放在第 1 张，+5 分。' },
  { id:'moss-tide', name:'苔溪逐月', subtitle:'图鉴变体 · 森系跟月', affinity:'forest', rarity:'R', art:'forest-sprout', cost:2, base:5, trait:'tidal', traitName:'跟月加分', description:'上一张是月系，+9 分。' },
  { id:'twig-change', name:'新枝变奏', subtitle:'图鉴变体 · 森系变换组合', affinity:'forest', rarity:'R', art:'forest-sprout', cost:2, base:5, trait:'shift', traitName:'变换组合', description:'连续两回合组合不同，+11 分。' },
  { id:'clover-step', name:'三叶踏歌', subtitle:'图鉴变体 · 森系异色接力', affinity:'forest', rarity:'SR', art:'forest-rabbit', cost:2, base:6, trait:'contrast', traitName:'异色接力', description:'上一张颜色不同，+7 分。' },
  { id:'seed-center', name:'种子圆舞', subtitle:'图鉴变体 · 森系中位', affinity:'forest', rarity:'SR', art:'forest-sprout', cost:2, base:6, trait:'center', traitName:'中位加分', description:'放在第 2 张，+8 分。' },
  { id:'canopy-coda', name:'树冠终曲', subtitle:'图鉴变体 · 森系末位', affinity:'forest', rarity:'SSR', art:'forest-rabbit', cost:3, base:9, trait:'flare', traitName:'末位加分', description:'放在第 3 张，+10 分。' },
  { id:'emerald-mirror', name:'翠镜回环', subtitle:'图鉴变体 · 森系夹心', affinity:'forest', rarity:'SSR', art:'forest-rabbit', cost:3, base:9, trait:'echo', traitName:'夹心加分', description:'触发夹心，+12 分。' },
  { id:'bough-embrace', name:'连枝合唱', subtitle:'图鉴变体 · 森系接力', affinity:'forest', rarity:'SSR', art:'forest-rabbit', cost:3, base:8, trait:'duet', traitName:'跟森加分', description:'上一张是森系，+10 分。' },
];
export const CARD_ART_NOTE = `${CARDS.length} 种玩法配置，共用 6 幅基础插画；新增 24 种为图鉴变体。`;
export const CARD_MAP = Object.fromEntries(CARDS.map(c=>[c.id,c])) as Record<string,CardDef>;
export const ECONOMY = { packCost:180, craft:{R:60,SR:180,SSR:480}, recycle:{R:10,SR:30,SSR:80} };
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
