import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS } from '../src/data.ts';
import { startRun, chooseTalent, redraw, resolveTurn, preview, craft, strengthen, summon, recycle } from '../src/engine.ts';
import { DATE, fresh, funded, roundTrip, bestKeys } from './helpers.ts';

test('160 种 seed 的不同策略可完成六回合，所有中间存档均可重载',()=>{
  for(let seed=1;seed<=160;seed++){
    let s=fresh(Math.imul(seed,0x9e3779b9)>>>0);if(seed%3===0)s=strengthen(s,'forest-sprout');
    if(seed%4===0){s=craft({...s,dust:1000},'breeze-sprout');s.lineup=[...s.lineup.slice(0,5),'breeze-sprout'];}
    s=startRun(s);const coins=s.coins,dust=s.dust;let actions=0;
    while(s.run!.phase!=='complete'){
      const before=structuredClone(s);let next;
      if(s.run!.phase==='talent')next=chooseTalent(s,s.run!.offers[(seed+actions)%3]);
      else if(s.run!.redraws&&((seed+s.run!.turn)%3===0))next=redraw(s);
      else {const selected=seed%5===0?[s.run!.hand[seed%s.run!.hand.length].key]:bestKeys(s.run!);assert.ok(preview(s.run!,selected).valid);next=resolveTurn(s,selected,DATE);}
      assert.deepEqual(s,before,'mutation for seed '+seed);s=roundTrip(next);actions++;assert.ok(actions<=14);
    }
    assert.equal(s.run!.logs.length,6);assert.equal(s.run!.talents.length,2);assert.equal(s.results.length,1);assert.equal(s.results[0].score,s.run!.logs.reduce((n,l)=>n+l.score,0));assert.equal(s.coins,coins+s.results[0].coins);assert.equal(s.dust,dust+s.results[0].dust);assert.ok(s.results[0].score>0);assert.equal(new Set(s.cards.map(c=>c.uid)).size,s.cards.length);
  }
});
test('全部星灵定向制作与混合资产操作保持不可重号、可往返存档',()=>{
  let s=funded();for(const c of CARDS){s=craft(s,c.id);s=roundTrip(s);}
  for(let i=0;i<120;i++){
    if(i%3===0)s=summon(s);
    else {const id=CARDS[i%CARDS.length].id;if(i%3===1)s=craft(s,id);else {try{s=recycle(s,id);}catch {s=craft(s,id);}}}
    s=roundTrip(s);assert.ok(s.coins>=0&&s.dust>=0&&s.tickets>=0);assert.equal(new Set(s.cards.map(c=>c.uid)).size,s.cards.length);
  }
});
