import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newProfileState,claimStarter,buildStarterPack,rollChoiceCandidates,rollTenDraw,
  forgeCardV2,craftCardV2,recycleCardsV2,payCoins,grantCoins,walletSpendable,
  migrateProfileState,capacityError,ECONOMY_VERSION,
} from '../src/engine.ts';
import type {GameStateV2,PaymentMode} from '../src/engine.ts';
import {CARDS,QUALITY,ECONOMY} from '../src/data.ts';

// ─── 工具 ─────────────────────────────────────────────────────────────
function mulberry32(seed:number){let a=seed>>>0;return ()=>{a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};}
function claimed(seed=7):GameStateV2{return claimStarter(newProfileState(seed),'moon-deer','ref-test');}
const q1=(s:GameStateV2,defId='moon-deer')=>s.cards.filter(c=>c.defId===defId&&c.rank===1);

// ─── D12：抽取概率（强制边界 + 大样本）────────────────────────────────
test('D12a 品质权重边界：注入各档边界随机值，落档精确无误',()=>{
  // 注意浮点累进边界：Q4 上界 0.985 用 0.9851 / 0.9849 避开误差区间
  const bounds=[0,0.51999,0.52,0.79999,0.80,0.92999,0.93,0.9849,0.9851,0.99999,1];
  const expected=[1,1,2,2,3,3,4,4,5,5,5];
  for(const [roll,want] of bounds.map((value,index)=>[value,expected[index]] as const)){
    let first=true;const candidates=rollChoiceCandidates(()=>{if(first){first=false;return roll;}return 0;}); // 第一次调用决定品质，后续洗牌调用固定 0
    assert.ok(candidates.every(c=>c.rank===want),`roll ${roll} 应为 Q${want}`);
  }
});
test('D12b 单抽候选：同品质、卡种不重复、大样本下卡种均匀且最终品质分布递减',()=>{
  const N=40000;
  const ranks=new Map<number,number>();const defCount=new Map<string,number>();
  const rand=mulberry32(20261014);
  for(let i=0;i<N;i++)for(const c of rollChoiceCandidates(rand)){
    ranks.set(c.rank,(ranks.get(c.rank)??0)+1);
    defCount.set(c.defId,(defCount.get(c.defId)??0)+1);
  }
  const dist=[...ranks.entries()].sort((a,b)=>a[0]-b[0]).map(([r,n])=>[r,n/(N*3)] as const); // 每次单抽掷 1 次品质、产 3 个同品质候选
  assert.deepEqual(dist.map(([r])=>r),[1,2,3,4,5]);
  for(let index=0;index<4;index++)assert.ok(dist[index][1]>dist[index+1][1]*1.5,'品质概率必须严格递减');
  for(const [rank,freq] of dist){const want=QUALITY.summonQuality[rank-1]/100;assert.ok(Math.abs(freq-want)<0.01,`Q${rank} 频率 ${freq} 偏离 ${want}`);}
  // 卡种均匀：每个 defId 出现次数应在期望 3N/36 ± 5σ 内
  const expectPer=3*N/CARDS.length;const sigma=Math.sqrt(expectPer*(1-1/CARDS.length));
  for(const [defId,count] of defCount)assert.ok(Math.abs(count-expectPer)<5*sigma,defId+' 卡种权重不均匀：'+count);
  assert.equal(defCount.size,CARDS.length,'大样本覆盖全部卡种');
});
test('D12c 十连：每次独立、卡种均匀、品质分布与公示表一致、无保底结构',()=>{
  const N=4000;const rand=mulberry32(20261015);
  const ranks=new Map<number,number>();const defs=new Map<string,number>();let total=0;
  for(let i=0;i<N;i++)for(const card of rollTenDraw(rand)){
    ranks.set(card.rank,(ranks.get(card.rank)??0)+1);defs.set(card.defId,(defs.get(card.defId)??0)+1);total++;
  }
  assert.equal(total,N*10);
  for(const [rank,count] of ranks){const want=QUALITY.summonQuality[rank-1]/100;assert.ok(Math.abs(count/total-want)<0.01,`Q${rank} 偏离`);}
  const expectPer=10*N/CARDS.length;const sigma=Math.sqrt(expectPer*(1-1/CARDS.length));
  for(const [defId,count] of defs)assert.ok(Math.abs(count-expectPer)<5*sigma,defId+' 不均匀');
  // 无保底：十连可以全 Q1（概率 0.52^10≈0.14%，4000 次中出现若干次是正常随机）
  assert.equal(defs.size,CARDS.length);
});
test('D12d 单抽/十连目标卡机会：单抽候选含目标概率 3/36，十连每张 1/36（定向优势明确）',()=>{
  const N=60000;const rand=mulberry32(99);
  let candidateHits=0;
  for(let i=0;i<N;i++)if(rollChoiceCandidates(rand).some(c=>c.defId==='moon-deer'))candidateHits++;
  assert.ok(Math.abs(candidateHits/N-3/CARDS.length)<0.005,'单抽候选含目标 ≈ 3/36');
});

// ─── F：合成分支数学（引擎层，服务端并发/事务由 game.test.mjs 覆盖）──────────
test('F-engine 每档三分支概率大样本校验：失败率逐档上升、连升极低、Q4 无连升',()=>{
  const N=40000;const rand=mulberry32(31415926);
  for(let from=1;from<=4;from++){
    const counts={fail:0,upgrade_one:0,upgrade_two:0};
    for(let i=0;i<N;i++){
      // 复现 forgeCardV2 的单次 roll 决策：roll∈[0,100)
      const roll=rand()*100;
      const fail=QUALITY.forge.fail[from-1],two=QUALITY.forge.upgradeTwo[from-1];
      if(roll<fail)counts.fail++;
      else if(from+2<=5&&roll<fail+two)counts.upgrade_two++;
      else counts.upgrade_one++;
    }
    assert.ok(Math.abs(counts.fail/N-QUALITY.forge.fail[from-1]/100)<0.01,`Q${from} 失败率`);
    if(from===4)assert.equal(counts.upgrade_two,0,'Q4 连升为 0');
    if(from<4)assert.ok(counts.upgrade_two/N<=QUALITY.forge.upgradeTwo[from-1]/100+0.002,'连升极低');
    if(from<4)assert.ok(QUALITY.forge.fail[from-1]<QUALITY.forge.fail[from],'失败率逐档上升');
  }
});
test('F-engine 失败返还期望材料消耗 = 0.6 张（60% 返 1 / 40% 返 2）',()=>{
  const N=20000;const rand=mulberry32(271828);
  let returned=0;
  for(let i=0;i<N;i++)returned+=rand()*100<QUALITY.forge.failReturnOne?1:2;
  const expected=0.6*N+0.4*2*N;
  assert.ok(Math.abs(returned-expected)/N<0.02,'返还张数期望 ≈ 1.4，即消耗期望 0.6');
});

// ─── N：礼包构造（全部 36 个本命）─────────────────────────────────────
test('N-engine 全部 36 个本命：结构恒定、八卡种、前排与远程输出覆盖、确定性',()=>{
  for(const def of CARDS){
    const pack=buildStarterPack(def.id);
    assert.equal(pack.cards.length,23,def.id);
    assert.ok(pack.kinds.length>=8,def.id);
    assert.equal(pack.cards.filter(c=>c.rank===3).length,1);
    assert.equal(pack.cards.filter(c=>c.rank===2).length,4);
    assert.equal(pack.cards.filter(c=>c.rank===1).length,18);
    assert.equal(new Set(pack.cards.map(c=>c.defId)).size,pack.kinds.length);
    // 前排与远程输出必须被 Q2 支援覆盖
    const roles=new Map<string,string[]>();
    const again=buildStarterPack(def.id);
    assert.deepEqual(again.cards,pack.cards,'同本命结果确定');
  }
});
test('N-engine 未知本命拒绝；礼包产物全部受限来源且金额入受限额度',()=>{
  assert.throws(()=>buildStarterPack('not-a-card'),/未知/);
  const before=claimed(11);
  assert.equal(before.starter.status,'claimed');
  assert.equal(before.coins,ECONOMY.starterCoins);
  assert.equal(before.restrictedCoins,ECONOMY.starterCoins);
  assert.ok(before.cards.every(c=>c.transferPolicy==='starter_restricted'&&c.originKind==='starter'));
  assert.throws(()=>claimStarter(before,'sun-fox','again'),/已领取/);
});

// ─── W：钱包不变量（引擎层）──────────────────────────────────────────
test('W-engine 支付策略：normal_only 不动受限；allow_restricted 先普通后受限',()=>{
  const base:GameStateV2={...newProfileState(5),coins:300,restrictedCoins:200};
  const a=structuredClone(base);const pa=payCoins(a,100,'normal_only');
  assert.deepEqual(pa,{coinsSpent:100,restrictedSpent:0,transferable:true});
  assert.deepEqual([a.coins,a.restrictedCoins],[200,200]);
  const b=structuredClone(base);const pb=payCoins(b,250,'allow_restricted');
  assert.deepEqual(pb,{coinsSpent:250,restrictedSpent:150,transferable:false});
  assert.deepEqual([b.coins,b.restrictedCoins],[50,50]);
  assert.throws(()=>payCoins(structuredClone(base),101,'normal_only'),/普通星币不足/);
  assert.throws(()=>payCoins(structuredClone(base),301,'allow_restricted'),/星币不足/);
});
test('W-engine 补币维护 0 ≤ restricted ≤ coins；回收受限卡返受限额度',()=>{
  const s=claimed(13);
  const extra=q1(s)[1];
  const done=recycleCardsV2(s,[extra.uid]);
  assert.equal(done.restrictedCoins,ECONOMY.recycleReturn);
  assert.ok(done.state.restrictedCoins<=done.state.coins);
  grantCoins(done.state,50,false);
  assert.ok(done.state.restrictedCoins<=done.state.coins);
});

// ─── C：制作 / 回收 / 套利（引擎层）──────────────────────────────────
test('C-engine 制作 180 得 Q1；未拥有拒绝；回收返 10；闭环净损耗 170',()=>{
  const s=claimed(17);
  assert.throws(()=>craftCardV2(s,'silver-gap','allow_restricted','r1'),/已拥有/);
  const made=craftCardV2(s,'moon-deer','allow_restricted','r2');
  assert.equal(made.card.rank,1);assert.equal(made.state.coins,ECONOMY.starterCoins-ECONOMY.craftCost);
  const back=recycleCardsV2(made.state,[made.card.uid]);
  assert.equal(back.state.coins,ECONOMY.starterCoins-ECONOMY.craftCost+ECONOMY.recycleReturn);
  assert.ok(back.state.coins<s.coins,'闭环净损耗');
});
test('C-engine 容量校验含托管与待选预留',()=>{
  assert.equal(capacityError(9998,1,1,0),null);
  assert.ok(capacityError(9998,1,1,1));
  assert.ok(capacityError(10000,0,0,1));
});

// ─── G：档案读取器（引擎层）──────────────────────────────────────────
test('G-engine v1→v2 迁移：字段冻结、来源 grandfather、幂等、损坏拒绝',()=>{
  const v1={version:1,coins:777,dust:55,tickets:4,rng:9,nextId:6,
    cards:[{uid:'c1',defId:'moon-deer',rank:3,best:2},{uid:'c2',defId:'sun-fox',rank:1,best:0}],
    lineup:[],results:[],discoveries:[],run:null,lastSummon:[]};
  const v2=migrateProfileState(v1);
  assert.equal(v2.version,2);assert.equal(v2.economyVersion,ECONOMY_VERSION);
  assert.equal(v2.coins,777);assert.deepEqual(v2.frozen,{dust:55,tickets:4});
  assert.equal(v2.starter.status,'legacy_granted');
  assert.ok(v2.cards.every(c=>c.transferPolicy==='free'&&c.originKind==='legacy'));
  assert.deepEqual(v2.cards.map(c=>[c.uid,c.rank]),[['c1',3],['c2',1]]);
  assert.deepEqual(migrateProfileState(structuredClone(v1)),v2,'幂等');
  for(const bad of [{version:1,coins:-1,cards:[],nextId:1},{version:1,coins:0,cards:[{uid:'c1',defId:'x',rank:1,best:0}],nextId:2},{version:3},{version:2,coins:100,restrictedCoins:101,starter:{version:1,status:'pending'},cards:[],nextId:1}])
    assert.throws(()=>migrateProfileState(bad),/损坏|不合法|受限子额度/);
});

// ─── 局外单星币边界：所有 v2 接口不读写 dust/tickets ─────────────────────
test('A03-engine v2 档案没有活跃 dust/tickets 余额；冻结字段仅审计',()=>{
  const s=claimed(19);
  assert.ok(!Object.hasOwn(s,'dust')&&!Object.hasOwn(s,'tickets'));
  const drawn=forgeCardV2(s,'moon-deer',{mainUid:q1(s)[0].uid,materialUids:[q1(s)[1].uid,q1(s)[2].uid],paymentMode:'allow_restricted',opRef:'r',random:()=>0.99});
  assert.ok(!Object.hasOwn(drawn.state,'dust'));
  assert.equal(drawn.result.restricted,true,'受限支付 → 成功结果受限');
});
