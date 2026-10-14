import type { GameState } from './engine';
let lastPage = '', lastPageAt = 0;
export function trackEvent(type:string,data:Record<string,unknown>={}) {
  if(type==='page_view') {const now=Date.now();if(data.page===lastPage&&now-lastPageAt<1000)return;lastPage=String(data.page);lastPageAt=now;}
  try {void fetch('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),type,data}),credentials:'same-origin',keepalive:true}).catch(()=>{});}catch{/* 单机模式下统计不可用，不阻碍游戏。 */}
}
export function trackTransition(previous:GameState,next:GameState) {
  const balance={coins:next.coins-previous.coins,dust:next.dust-previous.dust};
  if(next.run&&next.run.id!==previous.run?.id) trackEvent('run_start',{runId:next.run.id,cards:next.lineup});
  if(previous.run&&next.run?.id===previous.run.id&&next.run.logs.length>previous.run.logs.length) {
    const log=next.run.logs.at(-1)!;trackEvent('turn_complete',{runId:next.run.id,score:log.score,turn:log.turn,combo:log.combo??''});
  }
  if(previous.run&&next.run?.id===previous.run.id&&next.run.talents.length>previous.run.talents.length)trackEvent('talent_pick',{runId:next.run.id,talent:next.run.talents.at(-1)});
  const result=next.results[0];
  if(result&&!previous.results.some(r=>r.id===result.id))trackEvent('run_complete',{runId:result.id,score:result.score,grade:result.grade,...balance});
  else if(previous.run&&previous.run.phase!=='complete'&&!next.run)trackEvent('run_abandon',{runId:previous.run.id,turn:previous.run.turn});
  else if(next.cards.length===previous.cards.length+3&&next.lastSummon!==previous.lastSummon)trackEvent('summon',{cards:next.lastSummon,count:3,...balance});
  else if(next.cards.length===previous.cards.length+1)trackEvent('craft',{card:next.cards.at(-1)?.defId,...balance});
  else {
    const raised=next.cards.find(c=>{const old=previous.cards.find(o=>o.uid===c.uid);return old&&c.rank>old.rank;});
    if(raised)trackEvent('strengthen',{card:raised.defId,rank:raised.rank,...balance});
    else if(next.cards.length<previous.cards.length&&balance.dust>0)trackEvent('recycle',{count:previous.cards.length-next.cards.length,...balance});
  }
}
