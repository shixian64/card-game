import assert from 'node:assert/strict';
import { initialState, startRun, preview, resolveTurn, chooseTalent, parseSave } from '../src/engine.ts';
import type { GameState, Run } from '../src/engine.ts';
export const DATE='2026-10-11T12:00:00.000Z';
export function fresh(seed=1234567):GameState {return initialState(seed);}
export function fixture(defs:string[],options:Partial<Run>={}):Run {
  const run=startRun(fresh()).run!;
  return {...run,conditions:Array(6).fill('forest'),hand:defs.map((defId,i)=>({key:'p'+i,defId,rank:1})),...options};
}
export function keys(run:Run):string[] {return run.hand.map(c=>c.key);}
export function roundTrip(state:GameState):GameState {
  const parsed=parseSave(JSON.stringify(state));assert.deepEqual(parsed,state);return parsed;
}
export function bestKeys(run:Run):string[] {
  let best:string[]=[];let score=-1;
  function visit(chosen:string[]):void {
    if(chosen.length){const p=preview(run,chosen);if(p.valid&&p.score>score){best=[...chosen];score=p.score;}}
    if(chosen.length===3)return;
    for(const card of run.hand)if(!chosen.includes(card.key))visit([...chosen,card.key]);
  }
  visit([]);assert.ok(best.length);return best;
}
export function finish(state:GameState=fresh(),verify=false):GameState {
  let next=state.run&&state.run.phase!=='complete'?state:startRun(state);
  while(next.run!.phase!=='complete'){
    if(next.run!.phase==='talent')next=chooseTalent(next,next.run!.offers[0]);
    else next=resolveTurn(next,bestKeys(next.run!),DATE);
    if(verify)next=roundTrip(next);
  }
  return next;
}
export function mutateSave(state:GameState,mutate:(data:any)=>void):string {const data=structuredClone(state);mutate(data);return JSON.stringify(data);}
export function funded():GameState {return {...fresh(),coins:100000,dust:100000};}
