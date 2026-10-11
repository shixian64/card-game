export type Affinity = 'moon' | 'sun' | 'forest';
export type Rarity = 'R' | 'SR' | 'SSR';
export interface CardDef {
  id: string; name: string; subtitle: string; affinity: Affinity; rarity: Rarity;
  art: string; cost: number; base: number; trait: string; traitName: string; description: string;
}
export const AFFINITIES: Record<Affinity, { name: string; color: string }> = {
  moon: { name: '月影', color: '#7784ab' }, sun: { name: '辉光', color: '#bb8246' }, forest: { name: '森息', color: '#6f8870' },
};
export const CARDS: CardDef[] = [
  { id:'moon-deer', name:'月纱灵鹿', subtitle:'月光织就的温柔', affinity:'moon', rarity:'SSR', art:'moon-deer', cost:3, base:9, trait:'echo', traitName:'月之回响', description:'触发首尾呼应时，额外获得 12 点共鸣。' },
  { id:'sun-fox', name:'烛羽灵狐', subtitle:'温暖而明亮的相遇', affinity:'sun', rarity:'SSR', art:'sun-fox', cost:3, base:10, trait:'flare', traitName:'终章焰羽', description:'放在第 3 位时，额外获得 10 点共鸣。' },
  { id:'forest-rabbit', name:'苔冠旅者', subtitle:'在林间听见生长', affinity:'forest', rarity:'SR', art:'forest-rabbit', cost:2, base:7, trait:'bloom', traitName:'万物相知', description:'触发三相轮转时，额外获得 10 点共鸣。' },
  { id:'moon-fawn', name:'银角初醒', subtitle:'第一缕安静的月光', affinity:'moon', rarity:'R', art:'moon-fawn', cost:1, base:4, trait:'quiet', traitName:'月序开篇', description:'放在第 1 位时，额外获得 5 点共鸣。' },
  { id:'sun-cub', name:'晨光使者', subtitle:'把今天点亮一点', affinity:'sun', rarity:'R', art:'sun-cub', cost:1, base:5, trait:'lead', traitName:'微光引路', description:'下一张为辉光星灵时，额外获得 8 点共鸣。' },
  { id:'forest-sprout', name:'林间回响', subtitle:'小小的新生奇迹', affinity:'forest', rarity:'R', art:'forest-sprout', cost:1, base:4, trait:'root', traitName:'留白生长', description:'每剩余 1 点行动力，额外获得 2 点共鸣。' },
  { id:'star-deer', name:'星河守望', subtitle:'漫长星夜的陪伴', affinity:'moon', rarity:'SR', art:'moon-deer', cost:2, base:7, trait:'tidal', traitName:'月影相随', description:'上一张为月影星灵时，额外获得 9 点共鸣。' },
  { id:'golden-fox', name:'金焰巡游', subtitle:'穿过森林的暖风', affinity:'sun', rarity:'SR', art:'sun-fox', cost:2, base:7, trait:'duet', traitName:'林火协奏', description:'上一张为森息星灵时，额外获得 10 点共鸣。' },
  { id:'verdant-rabbit', name:'翡翠梦境', subtitle:'万千新芽的拥抱', affinity:'forest', rarity:'SSR', art:'forest-rabbit', cost:3, base:8, trait:'weave', traitName:'灵织之梦', description:'触发同相共鸣或三相轮转时，额外获得 12 点共鸣。' },
  { id:'mist-deer', name:'薄雾来信', subtitle:'还记得上次的约定', affinity:'moon', rarity:'R', art:'moon-fawn', cost:1, base:4, trait:'memory', traitName:'昨日回声', description:'本回合组合与上回合相同时，额外获得 9 点共鸣。' },
  { id:'dawn-fox', name:'曙色跃动', subtitle:'不留余力地闪耀', affinity:'sun', rarity:'R', art:'sun-cub', cost:2, base:6, trait:'rush', traitName:'尽兴一刻', description:'刚好用尽行动力时，额外获得 12 点共鸣。' },
  { id:'breeze-sprout', name:'风铃新芽', subtitle:'为不一样的世界好奇', affinity:'forest', rarity:'SR', art:'forest-sprout', cost:2, base:7, trait:'wander', traitName:'三相漫游', description:'触发三相轮转且位于中间时，额外获得 14 点共鸣。' },
];
export const CARD_MAP = Object.fromEntries(CARDS.map(c=>[c.id,c])) as Record<string,CardDef>;
export const ECONOMY = { packCost:180, craft:{R:60,SR:180,SSR:480}, recycle:{R:10,SR:30,SSR:80} };
export const COMBOS = [
  { id:'mono', name:'同相共鸣', pattern:'A · A · A', detail:'三张同星相，组合 +20', bonus:20 },
  { id:'trio', name:'三相轮转', pattern:'A · B · C', detail:'三种不同星相，组合 +18', bonus:18 },
  { id:'mirror', name:'首尾呼应', pattern:'A · B · A', detail:'首尾同相、中间异相，组合 +12', bonus:12 },
];
export const TALENTS = [
  { id:'prism', name:'三色棱镜', title:'让每一种不同都闪光', description:'三相轮转的最终共鸣 ×1.3。', icon:'prism' },
  { id:'harmony', name:'纯粹之心', title:'专注于同一种声音', description:'同相共鸣额外 +18。', icon:'heart' },
  { id:'echo', name:'回声之环', title:'首尾相遇，余音不散', description:'首尾呼应额外 +16。', icon:'moon' },
  { id:'energy', name:'从容呼吸', title:'留出更多可能', description:'每回合行动力上限 +1。', icon:'leaf' },
  { id:'focus', name:'留白之美', title:'不必填满每个瞬间', description:'每剩余 1 点行动力，额外 +4。', icon:'sparkle' },
  { id:'growth', name:'熟能生巧', title:'耐心也会留下痕迹', description:'所有星灵基础共鸣 +3。', icon:'star' },
];
export const CONDITIONS = [
  { id:'sun', name:'向阳而生', description:'本回合每张辉光星灵 +4', affinity:'sun' },
  { id:'quiet', name:'静谧时分', description:'每剩余 1 点行动力 +3', affinity:null },
  { id:'trio', name:'万物交汇', description:'三相轮转额外 +10', affinity:null },
  { id:'moon', name:'月光正好', description:'本回合每张月影星灵 +4', affinity:'moon' },
  { id:'mirror', name:'一期一会', description:'首尾呼应额外 +12', affinity:null },
  { id:'forest', name:'生长季节', description:'本回合每张森息星灵 +4', affinity:'forest' },
];
