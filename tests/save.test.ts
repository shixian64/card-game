import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSave, startRun, resolveTurn, chooseTalent, redraw } from '../src/engine.ts';
import { DATE, fresh, finish, mutateSave, bestKeys, roundTrip } from './helpers.ts';
const active=startRun(fresh(37));
const complete=finish(fresh(37));
let talent=resolveTurn(active,bestKeys(active.run!),DATE);talent=resolveTurn(talent,bestKeys(talent.run!),DATE);
const afterTalent=chooseTalent(talent,talent.run!.offers[0]);

test('所有合法阶段、重抽状态与 JSON 字段顺序变化均可读取',()=>{
  for(const s of [fresh(),active,redraw(active),talent,afterTalent,complete])roundTrip(s);
  const ordered=JSON.stringify(complete,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value);assert.deepEqual(parseSave(ordered),complete);
});
test('拒绝非 JSON、错误根类型、空数据与超过大小限制的文件',()=>{
  for(const raw of ['','{','null','[]','1','true','"save"','{}',' '.repeat(2_000_001)])assert.throws(()=>parseSave(raw));
});
const basics:[string,(s:any)=>void][]=[
 ['未知版本',s=>s.version=2],['缺失资源',s=>delete s.coins],['负金币',s=>s.coins=-1],['小数星尘',s=>s.dust=1.5],['字符串票券',s=>s.tickets='3'],['超安全整数',s=>s.coins=Number.MAX_SAFE_INTEGER+1],['负随机种子',s=>s.rng=-1],['过大随机种子',s=>s.rng=0x100000000],['零实例计数',s=>s.nextId=0],['回退实例计数',s=>s.nextId=3],['缺失培育字段',s=>delete s.run],['错误培育根类型',s=>s.run=[]],
 ['卡牌非数组',s=>s.cards={}],['收藏数量不足',s=>s.cards=s.cards.slice(0,5)],['卡牌空对象',s=>s.cards[0]={}],['卡牌空值',s=>s.cards[0]=null],['重复卡牌实例',s=>s.cards[1].uid=s.cards[0].uid],['卡牌非字符串编号',s=>s.cards[0].uid=1],['卡牌空编号',s=>s.cards[0].uid=''],['卡牌编号非法前缀',s=>s.cards[0].uid='run1'],['卡牌编号前导零',s=>s.cards[0].uid='c01'],['卡牌编号超安全整数',s=>s.cards[0].uid='c9007199254740992'],['卡牌编号撞后续计数',s=>s.cards[0].uid='c'+s.nextId],['未知卡牌',s=>s.cards[0].defId='missing'],['原型属性伪卡牌',s=>s.cards[0].defId='toString'],['非法阶位',s=>s.cards[0].rank=6],['字符串阶位',s=>s.cards[0].rank='1'],['负纪录',s=>s.cards[0].best=-1],['小数纪录',s=>s.cards[0].best=.1],
 ['重复阵容',s=>s.lineup[1]=s.lineup[0]],['超长阵容',s=>s.lineup.push('star-deer')],['未拥有阵容',s=>s.lineup[0]='breeze-sprout'],['错误阵容结构',s=>s.lineup={}],['重复发现',s=>s.discoveries=['mono','mono']],['未知发现',s=>s.discoveries=['unknown']],['缺失图鉴',s=>delete s.discoveries],['错误召唤长度',s=>s.lastSummon=['moon-deer']],['未知召唤结果',s=>s.lastSummon=['moon-deer','sun-fox','constructor']],['非法召唤品质',s=>s.lastSummon=[{defId:'moon-deer',quality:6},{defId:'moon-deer',quality:1},{defId:'moon-deer',quality:1}]],['非法合成分支',s=>s.lastForge={defId:'moon-deer',mainUid:'c1',from:1,to:2,branch:'luck',returnedUids:[],coins:60}],['错误手记结构',s=>s.results={}],
];
for(const [name,change] of basics)test('存档基础结构拒绝：'+name,()=>assert.throws(()=>parseSave(mutateSave(fresh(),change))));
const histories:[string,(s:any)=>void][]=[
 ['缺少手记字段',s=>delete s.results[0].id],['手记 id 类型',s=>s.results[0].id=2],['重复手记 id',s=>s.results.push(structuredClone(s.results[0]))],['手记与卡牌共享序号',s=>{s.run=null;s.results[0].id='run1';}],['手记超后续编号',s=>{s.run=null;s.results[0].id='run'+s.nextId;}],['缺少成长键',s=>s.results[0].growth={}],['负成长',s=>s.results[0].growth.bond=-1],['额外成长维度',s=>s.results[0].growth.fake=4],['字符串分数',s=>s.results[0].score='300'],['负分数',s=>s.results[0].score=-1],['小数分数',s=>s.results[0].score=.5],['评级不符',s=>s.results[0].grade='SSSS'],['未知称号',s=>s.results[0].title='fake'],['非法主灵',s=>s.results[0].leader='__proto__'],['缺少日期',s=>delete s.results[0].date],['无效日期',s=>s.results[0].date='not-a-date'],['奖励金币不符',s=>s.results[0].coins++],['奖励星尘不符',s=>s.results[0].dust++],['缺少结果 seed',s=>delete s.results[0].seed],['结果 seed 非整数',s=>s.results[0].seed=.1],['天赋少于两次',s=>s.results[0].talents.pop()],['天赋重复',s=>s.results[0].talents[1]=s.results[0].talents[0]],['未知天赋',s=>s.results[0].talents[0]='unknown'],['未知组合',s=>s.results[0].combos=['unknown']],['组合重复',s=>s.results[0].combos=['mono','mono']],['图鉴遗漏已发现组合',s=>s.discoveries=[]],
];
for(const [name,change] of histories)test('存档手记结构拒绝：'+name,()=>assert.throws(()=>parseSave(mutateSave(complete,change))));
const running:[string,(s:any)=>void][]=[
 ['未识别阶段',s=>s.run.phase='claim'],['不存在 id',s=>delete s.run.id],['非法 id',s=>s.run.id='c24'],['实例号撞卡牌',s=>s.run.id='run1'],['实例号超未来',s=>s.run.id='run'+s.nextId],['缺失 seed',s=>delete s.run.seed],['负 rng',s=>s.run.rng=-1],['过大 rng',s=>s.run.rng=0x100000000],['第零回合',s=>s.run.turn=0],['第七回合',s=>s.run.turn=7],['非整数回合',s=>s.run.turn=1.5],['负累计分',s=>s.run.score=-1],['空局凭空加分',s=>s.run.score=100],['空局凭空成长',s=>s.run.growth.bond=1],['成长缺字段',s=>delete s.run.growth.focus],['两次重抽',s=>s.run.redraws=2],['阵容少于六',s=>s.run.deck.pop()],['阵容含空对象',s=>s.run.deck[0]={}],['阵容实例重复',s=>s.run.deck[1]=structuredClone(s.run.deck[0])],['阵容卡种重复',s=>s.run.deck[1].defId=s.run.deck[0].defId],['活跃实例丢失',s=>s.cards=s.cards.filter((c:any)=>c.uid!==s.run.deck[0].uid)],['活跃实例被强化',s=>s.cards.find((c:any)=>c.uid===s.run.deck[0].uid).rank=2],['活跃实例纪录被改写',s=>s.cards.find((c:any)=>c.uid===s.run.deck[0].uid).best=1],['运行时阵容改序',s=>s.lineup.reverse()],['手牌少于五',s=>s.run.hand.pop()],['手牌投影重复',s=>s.run.hand[1]=structuredClone(s.run.hand[0])],['手牌空值',s=>s.run.hand[0]=null],['手牌 key 伪造',s=>s.run.hand[0].key='fake'],['手牌 rank 偏离快照',s=>s.run.hand[0].rank=3],['手牌 def 偏离实例',s=>s.run.hand[0].defId='breeze-sprout'],['环境少于六',s=>s.run.conditions.pop()],['环境重复',s=>s.run.conditions[1]=s.run.conditions[0]],['未知环境',s=>s.run.conditions[0]='unknown'],['开局已有天赋',s=>s.run.talents=['prism']],['未知天赋',s=>s.run.talents=['toString']],['游戏阶段带候选天赋',s=>s.run.offers=['prism']],['首回合伪装天赋选择',s=>{s.run.phase='talent';s.run.offers=['prism','echo','energy'];}],['首回合伪装完成',s=>s.run.phase='complete'],['开局伪造日志',s=>s.run.logs=[{turn:1,cards:['moon-fawn'],score:9,combo:null,condition:s.run.conditions[0]}]],
];
for(const [name,change] of running)test('活跃培育结构拒绝：'+name,()=>assert.throws(()=>parseSave(mutateSave(active,change))));

const talentCases:[string,(s:any)=>void][]=[
 ['少于三候选',s=>s.run.offers.pop()],['重复候选',s=>s.run.offers[1]=s.run.offers[0]],['候选未知',s=>s.run.offers[0]='missing'],['提前学习天赋',s=>s.run.talents=[s.run.offers[0]]],['跳过选择',s=>{s.run.phase='playing';s.run.offers=[];}],['回合日志遗漏',s=>s.run.logs.pop()],['日志多余',s=>s.run.logs.push(structuredClone(s.run.logs[0]))],['日志空值',s=>s.run.logs[0]=null],['日志回合不连续',s=>s.run.logs[0].turn=2],['日志环境错序',s=>s.run.logs[0].condition=s.run.conditions[1]],['日志卡牌空',s=>s.run.logs[0].cards=[]],['日志未知星灵',s=>s.run.logs[0].cards=['toString']],['日志非本阵容星灵',s=>s.run.logs[0].cards=['breeze-sprout']],['日志超过三张',s=>s.run.logs[0].cards=['moon-fawn','moon-fawn','sun-cub','sun-cub']],['日志同种三投影',s=>s.run.logs[0].cards=['moon-fawn','moon-fawn','moon-fawn']],['日志超预算',s=>s.run.logs[0].cards=['moon-deer','moon-deer','sun-fox']],['日志计分变化',s=>s.run.logs[0].score++],['日志组合变化',s=>s.run.logs[0].combo='not-a-combo'],['日志累计分不符',s=>s.run.score++],['日志累计成长不符',s=>s.run.growth.insight++],
];
for(const [name,change] of talentCases)test('阶段与日志重算拒绝：'+name,()=>assert.throws(()=>parseSave(mutateSave(talent,change))));
const terminalCases:[string,(s:any)=>void][]=[
 ['完成态没有结果',s=>s.results=[]],['完成态关联错误结果 id',s=>s.results[0].id='run999'],['完成态未达六回合',s=>s.run.turn=5],['完成态漏结算日志',s=>s.run.logs.pop()],['完成态重复天赋',s=>s.run.talents[1]=s.run.talents[0]],['完成态有天赋候选',s=>s.run.offers=['prism']],['完成态主灵不一致',s=>s.results[0].leader='sun-fox'],['完成态 seed 不一致',s=>s.results[0].seed++],['完成态成长不一致',s=>s.results[0].growth.bond++],['完成态天赋顺序不一致',s=>s.results[0].talents.reverse()],['领取后回退游戏阶段',s=>{s.run.phase='playing';s.run.logs.pop();}],
];
for(const [name,change] of terminalCases)test('完成态一致性拒绝：'+name,()=>assert.throws(()=>parseSave(mutateSave(complete,change))));
test('即使历史结果自身结构正确，也不能把奖励结果嫁接给活跃培育',()=>{
  const s=structuredClone(active);s.results=[{...complete.results[0]}];s.discoveries=[...complete.discoveries];assert.throws(()=>parseSave(JSON.stringify(s)),/不能已领取/);
});
test('合法旧手记允许保留，但已完成运行必须对应最近一篇',()=>{
  const second=finish(complete);const swapped=structuredClone(second);swapped.results.reverse();assert.throws(()=>parseSave(JSON.stringify(swapped)),/缺少对应成果/);
});
test('过多收藏与过多手记必须被拒绝',()=>{
 const tooManyCards=mutateSave(fresh(),s=>{s.cards=Array.from({length:10001},(_,i)=>({uid:'c'+(i+1),defId:'moon-fawn',rank:1,best:0}));s.nextId=10002;});assert.throws(()=>parseSave(tooManyCards),/星灵数据/);
 assert.throws(()=>parseSave(mutateSave(complete,s=>s.results=Array.from({length:51},()=>s.results[0]))),/手记/);
});
test('存档校验不更改输入对象且加载结果独立于原对象',()=>{
 const before=structuredClone(complete);const loaded=parseSave(JSON.stringify(complete));loaded.coins=0;assert.deepEqual(complete,before);
});
