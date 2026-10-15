import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattle } from '../src/battle.ts';
import { unitShopPrice, QUALITY } from '../src/data.ts';

// 同预算 / 同敌阵品质平衡对照（固定敌阵 6 单位，跨 300 个种子）。
// 阵容与 scripts/quality-balance.mjs 一致；带宽数据来自实测 ±3σ，防止未来改动
// 让高品质变成支配策略（>95%）或完全不值（≤低品质）。
// 2026-10 v3 价格：招募价只由品质决定（10/11/13/15/17），与卡种无关。
const unit = (defId: string, rank: number) => ({ uid: defId, defId, rank, best: 0, stars: 1 });
const ORDER = ['moon-fawn', 'amber-pause', 'fern-opener', 'moss-tide', 'sun-cub', 'sun-first'];
const SLOTS = [1, 3, 5, 22, 24, 26];
const budget = (rank: number) => ORDER.reduce((sum, defId) => sum + unitShopPrice(rank), 0);
function winRate(rank: number, enemyRank: number, units = ORDER) {
  let wins = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const battle = createBattle(units.map(defId => unit(defId, rank)), Math.imul(seed, 0x9e3779b9) >>> 0, SLOTS.slice(0, units.length), { enemyCount: 6, enemyRank });
    if (battle.outcome === 'won') wins++;
  }
  return wins / 300;
}

test('品质价格表：价格只由品质决定（10/11/13/15/17），Q3/Q5 预算比分别为 1.30 / 1.70',()=>{
  assert.deepEqual(QUALITY.shop.price,[10,11,13,15,17]);
  for(let rank=1;rank<=5;rank++)assert.equal(unitShopPrice(rank),[10,11,13,15,17][rank-1]);
  assert.ok(Math.abs(budget(3)/budget(1)-1.3)<0.01);
  assert.ok(Math.abs(budget(5)/budget(1)-1.7)<0.01);
  for(let rank=1;rank<5;rank++)assert.ok(unitShopPrice(rank+1)>unitShopPrice(rank),'品质越高必须越贵');
});

test('同敌阵对照：品质提升胜率单调上升，幅度与价格相称且不形成支配',()=>{
  const low=winRate(1,3),mid=winRate(3,3),high=winRate(5,3);
  assert.ok(low>=0.04&&low<=0.15,'Q1 基线超出带宽：'+low);
  assert.ok(mid>=0.18&&mid<=0.32,'Q3 胜率超出带宽：'+mid);
  assert.ok(high>=0.40&&high<=0.58,'Q5 胜率超出带宽：'+high);
  assert.ok(mid>low+0.05,'Q3 相对 Q1 无足够收益');
  assert.ok(high>mid+0.10,'Q5 相对 Q3 无足够收益');
  assert.ok(high<0.95,'高品质不得成为必选支配策略');
});

test('六边形两方公平性：真镜像 1v1 与常规 6v6 阵容胜率都在 50% 附近',()=>{
  for(const defId of ['moon-deer','forest-rabbit','sun-cub','sun-fox','moon-fawn']){
    let wins=0;
    for(let seed=1;seed<=200;seed++){
      const battle=createBattle([unit(defId,1)],seed,[1],{enemyCount:1,enemyTeam:[unit(defId,1)]});
      if(battle.outcome==='won')wins++;
    }
    assert.ok(Math.abs(wins/200-0.5)<=0.02,defId+' 镜像 1v1 胜率偏离 50%：'+wins/200);
  }
  const comp=['moon-deer','forest-rabbit','moon-fawn','mist-deer','sun-fox','sun-cub'];
  let wins=0;
  for(let seed=1;seed<=300;seed++){
    const battle=createBattle(comp.map(defId=>unit(defId,1)),Math.imul(seed,0x9e3779b9)>>>0,[1,3,5,22,24,26],{enemyCount:6,enemyTeam:comp.map(defId=>unit(defId,1))});
    if(battle.outcome==='won')wins++;
  }
  assert.ok(Math.abs(wins/300-0.5)<=0.05,'常规阵容镜像胜率偏离 50%：'+wins/300);
});

test('同预算对照：纯高品质少人阵容不能替代数量优势',()=>{
  const low=winRate(1,3);
  const fewer=winRate(5,3,ORDER.slice(0,4));
  assert.ok(fewer<=low+0.05,'4×Q5（68 金）不应强于 6×Q1（60 金）：'+fewer);
});
