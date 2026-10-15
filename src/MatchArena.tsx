import {useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowLeft,ArrowRight,Check,Clock3,Coins,Gem,Info,Lock,LogOut,Maximize2,Minimize2,RefreshCw,ShoppingBag,Sparkles,TrendingUp,Trophy,Unlock,Users,X} from 'lucide-react';
import {AFFINITIES,CARD_MAP,QUALITY,LEGACY_ECONOMY,LEGACY_RARITY,legacyUnitPrice,unitShopPrice,qualityName} from './data';
import type {OwnedCard} from './engine';
import {getCombatStats} from './battle';
import type {BattleState} from './battle';
import BattleArena from './BattleArena';
import './match.css';

export type MatchUnit=OwnedCard&{stars:1|2|3;basis?:number};
export type ShopOffer={id:string;defId:string;cost:number;rank:number};
export type MatchFormation={uid:string;slot:number};
export type RoundResult={round:number;status:'won'|'lost';gold:number};
export interface MatchState {
  version:1|2|3;id:string;status:'playing'|'finished';startedAt:number;endsAt:number;serverNow:number;
  round:number;phase:'planning'|'combat'|'finished';phaseEndsAt:number;
  gold:number;level:number;xp:number;xpToNext:number|null;shop:ShopOffer[];locked:boolean;
  roster:MatchUnit[];formation:MatchFormation[];battle:BattleState|null;
  wins:number;losses:number;streak:number;history:RoundResult[];
  legacyPricing?:boolean;
  lastIncome?:{base:number;interest:number;streak:number;win:number;total:number};
  // v3 只发星币（含 base/factor/reason）；星尘仅 v1/v2 存续局沿用旧公式。
  reward?:{coins:number;dust?:number;base?:number;factor?:number;reason?:string};
}
export interface MatchArenaProps {
  match:MatchState|null;busy:boolean;cards:OwnedCard[];
  onCommand:(action:string,args?:Record<string,unknown>)=>Promise<boolean>;
  onRefresh:()=>void|Promise<void>;
  onBack?:()=>void;
}
type Confirmation={kind:'abandon'}|{kind:'back'}|{kind:'sell';card:MatchUnit;value:number};
const SHOP_ODDS:Record<number,number[]>={3:[60,32,8],4:[45,40,15],5:[30,45,25],6:[20,45,35]};
const EMPTY_FORMATION:MatchFormation[]=[];
export function matchInterest(gold:number):number{return Math.min(50,Math.floor(gold/100)*10);}
export function shopMergeCopies(roster:MatchUnit[],defId:string,rank:number):number{return roster.filter(unit=>unit.defId===defId&&unit.rank===rank&&unit.stars===1).length;}
export function formatMatchClock(milliseconds:number){const seconds=Math.max(0,Math.ceil(milliseconds/1000));return Math.floor(seconds/60).toString().padStart(2,'0')+':'+(seconds%60).toString().padStart(2,'0');}
export function matchFormationKey(formation:MatchFormation[]){return [...formation].sort((a,b)=>a.slot-b.slot||a.uid.localeCompare(b.uid)).map(item=>item.uid+'@'+item.slot).join('|');}
export function cleanMatchFormation(formation:MatchFormation[],roster:MatchUnit[],population:number){
  const allowed=new Set(roster.map(unit=>unit.uid));const units=new Set<string>();const slots=new Set<number>();
  return formation.filter(item=>{if(!allowed.has(item.uid)||units.has(item.uid)||slots.has(item.slot)||!Number.isInteger(item.slot)||item.slot<0||item.slot>27||units.size>=population)return false;units.add(item.uid);slots.add(item.slot);return true;});
}
// 与服务端 actMatch('sell') 同口径：basis 优先；迁移存局（legacyPricing）按旧稀有度
// 基价冻结（不乘品质系数）；其余无 basis 的异常 / 测试单位按本局版本回退
// （v3 品质价 / v1v2 旧稀有度价），预览不得与服务端实际返还脱节。
function saleValue(unit:MatchUnit,version:number=3,legacyPricing=false){
  if(unit.basis!==undefined)return unit.basis;
  if(legacyPricing)return (LEGACY_ECONOMY.sellBase[LEGACY_RARITY[unit.defId]??'R']??10)*3**(unit.stars-1);
  return (version>=3?unitShopPrice(unit.rank):legacyUnitPrice(unit.defId,unit.rank))*3**(unit.stars-1);
}
function MatchConfirm({value,pending,onClose,onConfirm}:{value:Confirmation;pending:boolean;onClose:()=>void;onConfirm:()=>void}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current;if(!dialog)return;dialog.showModal();return()=>{if(dialog.open)dialog.close();};},[]);
  const card=value.kind==='sell'?CARD_MAP[value.card.defId]:null;
  return createPortal(<dialog ref={ref} className="match-confirm" aria-labelledby="match-confirm-title" onCancel={event=>{event.preventDefault();if(!pending)onClose();}}>
    <button className="match-confirm-close" aria-label="关闭确认" onClick={onClose} disabled={pending}><X size={18}/></button>
    <h2 id="match-confirm-title">{value.kind==='sell'?'出售这张局内卡？':value.kind==='back'?'返回大厅？':'退出本局？'}</h2>
    {value.kind==='sell'&&card?<><div className="match-sale-preview"><img src={'/art/'+card.art+'.png'} alt=""/><div><strong>{card.name}</strong><span>{'★'.repeat(value.card.stars)} · 永久 {qualityName(value.card.rank)}品质</span><b><Coins size={16}/>返还 {value.value} 局内金币</b></div></div><p>只出售本局副本，不影响永久收藏。已上阵的卡牌会同时离场。</p></>:value.kind==='back'?<p>本局会继续计时。未保存的站位不会生效，稍后可从对战入口返回。</p>:<p>本局金币和星级不会保留，退出没有终局奖励。永久收藏不受影响。</p>}
    <div className="match-confirm-actions"><button onClick={onClose} disabled={pending}>取消</button><button className="primary" onClick={onConfirm} disabled={pending}>{pending?'处理中…':value.kind==='sell'?'确认出售':value.kind==='back'?'返回大厅':'退出本局'}</button></div>
  </dialog>,document.body);
}
function RoundTrack({match}:{match:MatchState}){
  return <ol className="match-round-track" aria-label="八轮对局进度">{Array.from({length:8},(_,index)=>{const round=index+1;const result=match.history.find(item=>item.round===round);const current=match.status==='playing'&&match.round===round;return <li key={round} className={(result?.status??'')+(current?' current':'')} aria-current={current?'step':undefined} title={'第 '+round+' 轮'+(result?(result.status==='won'?' · 胜利':' · 战败')+' · 收入 '+result.gold+' 金币':current?' · 进行中':' · 未开始')}><span>{result?.status==='won'?<Check size={13}/>:result?.status==='lost'?<X size={12}/>:round}</span><small>{result?(result.status==='won'?'胜':'负'):current?'当前':'第 '+round+' 轮'}</small></li>;})}</ol>;
}
function EconomyRules({level=3,version=3,expanded=false}:{level?:number;version?:number;expanded?:boolean}){
  const odds=SHOP_ODDS[level]??SHOP_ODDS[3];
  const v3=version>=3;
  return <details className="match-rules" open={expanded}><summary><Info size={14}/>金币、升级与合星规则</summary><div>
    <p><b>金币收入</b>每轮基础 +50，利息每存 100 金 +10（最多 +50）；2 连胜或连败 +10，4 连起 +20；胜利额外 +10。</p>
    <p><b>升级人口</b>花 40 金购买 4 经验，每轮自然获得 2 经验。Lv.3 → 4 需 6 XP，→ 5 需 10 XP，→ 6 需 14 XP。</p>
    <p><b>局内合星</b>3 张同名、同品质、同星级的卡自动合成，最高三星；每升一星增加 12% 生命、8% 攻击。永久品质是另一套受控强化（每档 +4% 生命 / +3% 攻击与技能）。</p>
    {v3
      ? <p><b>商店与出售</b>购买价按品质定价（{QUALITY.shop.price.map(p=>p+' 金').join(' / ')}）；刷新花 20 金，新回合免费换店。锁店持续保留；出售返还购买价 × 3<sup>星级 − 1</sup>。</p>
      : <p><b>商店与出售</b>本局为存续旧局：招募价按旧稀有度基价（R 10 / SR 20 / SSR 30 金）× 品质系数（×1～×1.7）冻结；无 basis 的单位出售按旧基价 × 3<sup>星级 − 1</sup>（不乘品质系数）。刷新花 20 金。</p>}
    {v3
      ? <p><b>商店品质</b>每格先从本局收藏卡种中均匀抽一种，再按固定权重抽本局品质（Q1–Q5 权重 52 / 28 / 13 / 5.5 / 1.5，且不超过该卡收藏最高品质）；人口只决定上阵数量，不再解锁稀有度档位。</p>
      : <p><b>当前人口概率</b>（按卡种稀有度）R {odds[0]}% · SR {odds[1]}% · SSR {odds[2]}%。只招募已收藏的（卡种 × 品质）；缺少某档收藏时，会从整个已收藏卡池补位。</p>}
    {v3
      ? <p><b>10 分钟结束</b>8 轮，每轮 40 秒经营 + 35 秒战斗。正常完成按 80 + 胜场 × 20 星币结算，受每日配额影响（全模式共享：前 6 局全额、再 6 局半额）；有效参与不足（少于 4 个经营轮或上阵不足 3 种卡）无奖励，退出不奖励。</p>
      : <p><b>10 分钟结束</b>8 轮，每轮 40 秒经营 + 35 秒战斗。终局获得 80 + 胜场 × 20 星币、20 + 胜场 × 5 星尘；局内金币不兑换永久资产。</p>}
  </div></details>;
}

function MatchRulesDialog({level,version,onClose}:{level:number;version?:number;onClose:()=>void}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current;if(!dialog)return;dialog.showModal();return()=>{if(dialog.open)dialog.close();};},[]);
  return createPortal(<dialog className="match-rules-dialog" ref={ref} aria-labelledby="match-rules-title" onCancel={event=>{event.preventDefault();onClose();}}><button className="match-confirm-close" onClick={onClose} aria-label="关闭规则"><X size={18}/></button><h2 id="match-rules-title">本局规则</h2><EconomyRules level={level} version={version} expanded/></dialog>,document.body);
}

export function MatchArena({match,busy,cards,onCommand,onRefresh,onBack}:MatchArenaProps){
  const [clock,setClock]=useState(Date.now);
  const [anchor,setAnchor]=useState(()=>({server:match?.serverNow??Date.now(),client:Date.now()}));
  const [draft,setDraft]=useState<MatchFormation[]>(()=>match?.formation.map(item=>({...item}))??[]);
  const [pending,setPending]=useState(false);const pendingRef=useRef(false);
  const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [confirmation,setConfirmation]=useState<Confirmation|null>(null);
  const [rulesOpen,setRulesOpen]=useState(false);
  const [fullscreen,setFullscreen]=useState(()=>!!document.fullscreenElement);
  const refreshRef=useRef(onRefresh);refreshRef.current=onRefresh;
  const mounted=useRef(true);const currentId=useRef(match?.id??null);currentId.current=match?.id??null;
  const serverTime=anchor.server+clock-anchor.client;
  const phaseRemaining=match?Math.min(match.phase==='planning'?40000:35000,Math.max(0,match.phaseEndsAt-serverTime)):0;
  const totalRemaining=match?Math.min(600000,Math.max(0,match.endsAt-serverTime)):600000;
  const active=match?.status==='playing';
  const planning=active&&match.phase==='planning';
  const canPlan=!!planning&&phaseRemaining>0&&!busy&&!pending;
  const formationKey=matchFormationKey(match?.formation??EMPTY_FORMATION);
  const rosterKey=match?.roster.map(unit=>unit.uid+':'+unit.stars).join('|')??'';
  const draftKey=matchFormationKey(draft);
  const dirty=!!planning&&draftKey!==formationKey;
  const lastSync=useRef({stage:'',formation:''});
  const deadlineSeen=useRef('');
  const replayTiming=useRef({id:'',duration:30000});
  const battleId=match?.battle?.id??'';
  if(battleId!==replayTiming.current.id)replayTiming.current={id:battleId,duration:Math.max(1000,Math.min(30000,(match?.phaseEndsAt??0)-(match?.serverNow??0)-1500))};
  const uniqueCards=useMemo(()=>{const seen=new Map<string,OwnedCard>();for(const card of cards){const old=seen.get(card.defId);if(!old||card.rank>old.rank)seen.set(card.defId,card);}return [...seen.values()];},[cards]);

  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{const sync=()=>setFullscreen(!!document.fullscreenElement);document.addEventListener('fullscreenchange',sync);return()=>document.removeEventListener('fullscreenchange',sync);},[]);
  useEffect(()=>{if(match){const client=Date.now();setAnchor({server:match.serverNow,client});setClock(client);}},[match?.id,match?.serverNow]);
  useEffect(()=>{
    const update=()=>{if(document.visibilityState==='visible')setClock(Date.now());};
    const timer=setInterval(update,1000);document.addEventListener('visibilitychange',update);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',update);};
  },[]);
  useEffect(()=>{
    if(!active)return;
    const refresh=()=>{if(document.visibilityState==='visible')try{void Promise.resolve(refreshRef.current()).catch(()=>{});}catch{/* parent owns request errors */}};
    const timer=setInterval(refresh,5000);document.addEventListener('visibilitychange',refresh);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[active,match?.id]);
  useEffect(()=>{
    if(!active||!match||serverTime<match.phaseEndsAt||document.visibilityState!=='visible')return;
    const key=match.id+':'+match.round+':'+match.phase+':'+match.phaseEndsAt;
    if(deadlineSeen.current===key)return;deadlineSeen.current=key;
    try{void Promise.resolve(refreshRef.current()).catch(()=>{});}catch{/* visible retry occurs every five seconds */}
  },[active,match?.id,match?.round,match?.phase,match?.phaseEndsAt,serverTime]);
  useEffect(()=>{
    if(!match){setDraft([]);lastSync.current={stage:'',formation:''};return;}
    const stage=match.id+':'+match.round+':'+match.phase;const previous=lastSync.current;
    setDraft(current=>{
      if(previous.stage!==stage||matchFormationKey(current)===previous.formation)return match.formation.map(item=>({...item}));
      const next=cleanMatchFormation(current,match.roster,match.level);
      return matchFormationKey(next)===matchFormationKey(current)?current:next;
    });
    lastSync.current={stage,formation:formationKey};
  },[match?.id,match?.round,match?.phase,match?.level,formationKey,rosterKey]);
  useEffect(()=>{setConfirmation(null);setError('');setNotice('');},[match?.id]);
  useEffect(()=>{
    if(confirmation?.kind!=='sell')return;
    const current=match?.roster.find(unit=>unit.uid===confirmation.card.uid);
    if(!planning||!current||current.stars!==confirmation.card.stars){setConfirmation(null);setError(!planning?'经营阶段已结束。':'卡牌状态已变化，请重新选择。');}
  },[confirmation,planning,rosterKey]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),3500);return()=>clearTimeout(timer);},[notice]);

  async function command(action:string,args:Record<string,unknown>={},success=''){
    if(busy||pendingRef.current)return false;
    const id=currentId.current;pendingRef.current=true;setPending(true);setError('');setNotice('');
    try{
      const ok=await onCommand(action,args);
      if(mounted.current&&(id===currentId.current||action==='match.start')){
        if(ok&&success)setNotice(success);
        if(!ok)setError('操作未完成，请查看提示后重试。');
      }
      return ok;
    }catch(caught){if(mounted.current&&id===currentId.current)setError(caught instanceof Error?caught.message:'操作未完成，请重试。');return false;}
    finally{pendingRef.current=false;if(mounted.current)setPending(false);}
  }
  async function saveFormation(uids:string[],slots?:number[]){
    if(!canPlan)return false;
    return command('match.deploy',{formation:uids.map((uid,index)=>({uid,slot:slots?.[index]??index}))},'阵容已保存');
  }
  function sellUnit(uid:string){if(!canPlan||!match)return;const card=match.roster.find(unit=>unit.uid===uid);if(card)setConfirmation({kind:'sell',card:{...card},value:saleValue(card,match.version,match.legacyPricing)});}
  async function confirmAction(){
    if(!confirmation)return;
    if(confirmation.kind==='back'){setConfirmation(null);onBack?.();return;}
    if(confirmation.kind==='sell'&&!canPlan)return;
    const ok=await command(confirmation.kind==='sell'?'match.sell':'match.abandon',confirmation.kind==='sell'?{uid:confirmation.card.uid}:{},confirmation.kind==='sell'?'已出售局内卡牌':'');
    if(ok&&mounted.current)setConfirmation(null);
  }
  async function toggleFullscreen(){
    setError('');
    try{
      if(document.fullscreenElement)await document.exitFullscreen();
      else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();
      else throw new Error('浏览器不支持全屏，请使用浏览器的全屏功能。');
    }catch{if(mounted.current)setError('浏览器未允许系统全屏，仍可使用当前沉浸视图。');}
  }
  function goBack(){if(!onBack)return;if(active&&dirty)setConfirmation({kind:'back'});else onBack();}
  const controls=<nav className="match-screen-controls" aria-label="对局菜单">
    {onBack&&<button className="match-back" onClick={goBack} title={active?'返回大厅，本局仍会继续计时':'返回大厅'}><ArrowLeft size={17}/><span>大厅</span></button>}
    <button onClick={()=>setRulesOpen(true)} aria-label="查看对局规则" title="对局规则"><Info size={17}/></button>
    <button onClick={()=>void toggleFullscreen()} aria-label={fullscreen?'退出全屏':'进入全屏'} title={fullscreen?'退出全屏':'进入全屏'}>{fullscreen?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button>
    {active&&<button className="match-exit" onClick={()=>setConfirmation({kind:'abandon'})} disabled={busy||pending} aria-label="退出本局" title="退出本局，无终局奖励"><LogOut size={16}/></button>}
  </nav>;
  const overlays=<>{confirmation&&<MatchConfirm value={confirmation} pending={busy||pending} onClose={()=>{if(!pendingRef.current&&!busy)setConfirmation(null);}} onConfirm={()=>void confirmAction()}/>} {rulesOpen&&<MatchRulesDialog level={match?.level??3} version={match?.version} onClose={()=>setRulesOpen(false)}/>}</>;
  const feedback=<div className="match-feedback" aria-live="polite">{error&&<p className="match-error" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭错误提示"><X size={14}/></button></p>}{notice&&<p className="match-notice" role="status"><Check size={14}/>{notice}</p>}</div>;

  if(!match)return <section className="match-arena match-immersive immersive-battle match-lobby full-lobbydark">
    {controls}<div className="match-lobby-copy"><span className="match-eyebrow">星序 · 林境弈场</span><h1>10 分钟对局</h1><p className="match-lobby-lead">买牌、攒利息、升人口。用你的收藏组成阵容。</p>
      <ol className="match-lobby-steps"><li><ShoppingBag size={18}/><span><b>40 秒经营</b>买牌、合星、升人口</span></li><li><Users size={18}/><span><b>28 格布阵</b>最多上阵 6 张卡</span></li><li><Trophy size={18}/><span><b>35 秒自动战斗</b>8 轮后结算奖励</span></li></ol>
      <button className="match-primary match-start" disabled={busy||pending||!cards.length} onClick={()=>void command('match.start')}>{busy||pending?<RefreshCw size={18} className="match-spin"/>:<Clock3 size={18}/>}开启对局<ArrowRight size={17}/></button>
      <p className="match-lobby-note">{cards.length?uniqueCards.length+' 种收藏进入招募池 · 本局副本不消耗永久卡':'先抽卡或购买一张卡牌，再开启对局。'}</p>
    </div>
    <div className="match-lobby-art" aria-hidden="true">{uniqueCards.slice(0,3).map((card,index)=><div key={card.uid} className={'match-lobby-card card-'+index}><img src={'/art/'+CARD_MAP[card.defId].art+'.png'} alt=""/><span>{CARD_MAP[card.defId].name}</span></div>)}<div className="match-lobby-clock"><strong>10:00</strong><small>8 轮 · 经营 / 对战</small></div></div>
    {feedback}{overlays}
  </section>;

  if(match.status==='finished'){
    const endedEarly=match.history.length<8;
    return <section className="match-arena match-immersive immersive-battle match-finished full-lobbydark">
      {controls}<div className="match-finished-panel"><Trophy size={42}/><span className="match-eyebrow">{endedEarly?'本局提前结束':'八轮对局完成'}</span><h1>{endedEarly?'已退出本局':match.wins>=5?'对局胜利':'对局完成'}</h1><p className="match-final-score"><strong>{match.wins}</strong> 胜 <i>·</i> <strong>{match.losses}</strong> 负</p>
        <RoundTrack match={match}/><div className="match-final-rewards"><span>{endedEarly?'提前退出，无终局奖励':'服务器已结算到账'}</span><b><Coins size={21}/>{match.reward?.coins??0}<small>星币</small></b>{match.reward?.dust!==undefined&&<b><Gem size={21}/>{match.reward.dust}<small>星尘</small></b>}</div>
        <button className="match-primary" disabled={busy||pending||!cards.length} onClick={()=>void command('match.start')}><RefreshCw size={17} className={pending?'match-spin':''}/>再开一局<ArrowRight size={16}/></button><p className="match-lobby-note">局内金币与星级不保留，永久收藏不会损失。</p>
      </div>{feedback}{overlays}
    </section>;
  }

  const interest=matchInterest(match.gold);const streak=Math.abs(match.streak);
  const remainingLabel=phaseRemaining<=0?'正在切换阶段':planning?'经营结束自动开战':'计时结束进入下轮';
  const incomeTitle=match.lastIncome?'上轮收入 '+match.lastIncome.total+'：基础 '+match.lastIncome.base+'，利息 '+match.lastIncome.interest+'，连胜/败 '+match.lastIncome.streak+'，胜利 '+match.lastIncome.win:'每轮基础收入 50，利息最多 50';
  return <section className={'match-arena match-running match-immersive immersive-battle '+(planning?'phase-planning is-planning':'phase-combat is-combat')} aria-label="十分钟对局">
    <header className="match-hud-top">{controls}<div className="match-stage-hud"><span className="match-round-number">第 <b>{match.round}</b> 轮<small>/ 8</small></span><div className="match-stage-timing"><span>{planning?'经营布阵':'自动对战'}</span><strong className={phaseRemaining<10000?'urgent':''}>{formatMatchClock(phaseRemaining)}</strong></div><span className="match-total-clock"><Clock3 size={12}/>{formatMatchClock(totalRemaining)}</span><i className="match-phase-progress"><span style={{width:Math.min(100,phaseRemaining/(planning?40000:35000)*100)+'%'}}/></i></div></header>
    <aside className="match-round-rail" aria-label="本局真实战况"><div className="match-rail-heading"><h2>本局战况</h2><span>电脑对战</span></div><RoundTrack match={match}/><div className="match-win-loss"><span><b>{match.wins}</b> 胜 <i>·</i> <b>{match.losses}</b> 负</span><small>{streak?streak+' 连'+(match.streak>0?'胜':'败'):'尚未开战'}</small></div></aside>
    <div className={'match-stage-note match-deploy-status '+(dirty?'unsaved':'')} role="status"><span>{dirty?<Info size={13}/>:planning?<Check size={13}/>:<Clock3 size={13}/>}<b>{dirty?'站位未保存':planning?'阵容已保存':'战斗回放'}</b>{dirty?'调整后点击保存':planning?remainingLabel:'暂停或跳过不会提前结算'}</span></div>
    <div className="match-board-wrap immersive-arena-main">
      {planning?<BattleArena key={match.id+':planning:'+match.round} cards={match.roster} battle={null} busy={!canPlan} formation={draft} onFormationChange={setDraft} maxUnits={match.level} rosterMode="match" embedded startLabel="保存阵容" onStart={saveFormation} onAction={()=>{}} onAbandon={()=>{}} onSellUnit={sellUnit}/>:match.battle?<BattleArena key={match.battle.id} cards={match.roster} battle={match.battle} busy={false} maxUnits={match.level} rosterMode="match" embedded replayOnly replayDurationMs={replayTiming.current.duration} onStart={()=>{}} onAction={()=>{}} onAbandon={()=>{}}/>:<div className="match-no-battle"><Users size={35}/><h2>本轮没有上阵单位</h2><p>本轮按战败结算，下一轮可重新招募。</p><strong>{formatMatchClock(phaseRemaining)}</strong></div>}
    </div>
    <div className={'match-bottom-dock '+(!planning?'is-readonly':'')}>
      <section className="match-economy-controls" aria-label="局内经济与商店操作">
        <div className="match-wallet" title={incomeTitle}><Coins size={20}/><strong>{match.gold}</strong><span>局内金币<small>利息 +{interest}</small></span><i>{Array.from({length:5},(_,index)=><em key={index} className={index*10<interest?'active':''}/>)}</i></div>
        <div className="match-level-line"><b>Lv.{match.level}</b><span>{match.xpToNext===null?'人口满级':match.xp+' / '+match.xpToNext+' XP'}</span><small>{draft.length}/{match.level} 上阵</small></div>
        <div className="match-xp-meter" aria-label={match.xpToNext===null?'人口满级':'经验 '+match.xp+' / '+match.xpToNext}><span style={{width:(match.xpToNext?Math.min(100,match.xp/match.xpToNext*100):100)+'%'}}/></div>
        <div className="match-economy-actions"><button disabled={!canPlan||match.gold<40||match.level>=6} onClick={()=>void command('match.xp',{},'已购买 4 经验')} title="40 局内金币购买 4 经验"><TrendingUp size={15}/><span>{match.level>=6?'人口已满':'买经验'}</span><b>40</b></button><button disabled={!canPlan||match.gold<20} onClick={()=>void command('match.reroll')} title="20 局内金币刷新商店"><RefreshCw size={14} className={pending?'match-spin':''}/><span>刷新</span><b>20</b></button></div>
        <button className={'match-lock-shop '+(match.locked?'locked':'')} disabled={!canPlan} aria-pressed={match.locked} onClick={()=>void command('match.lock',{locked:!match.locked},match.locked?'商店已解锁':'商店将跨回合保留')} title="锁定后，下轮不会自动刷新">{match.locked?<Lock size={13}/>:<Unlock size={13}/>}<span>{match.locked?'已锁定商店':'锁定商店'}</span><small>{!planning?'战斗中不可经营':match.locked?'跨回合保留':'下轮免费刷新'}</small></button>
      </section>
      <section className="match-shop" aria-labelledby="match-shop-title"><div className="match-shop-heading"><h2 id="match-shop-title"><ShoppingBag size={13}/>{planning?'本轮商店':'商店 · 战斗中只读'}</h2><span>{match.locked?'已锁店':'下轮免费刷新'} · 三同卡自动合星</span><small>本局单位 {match.roster.length}/15</small></div>
        <div className="match-shop-grid">{Array.from({length:5},(_,index)=>{
          const offer=match.shop[index];if(!offer)return <div className="match-shop-empty" key={'empty-'+index}><Check size={18}/><span>已招募</span></div>;
          const def=CARD_MAP[offer.defId];const stats=getCombatStats({uid:offer.id,defId:offer.defId,rank:offer.rank,best:0});const copies=shopMergeCopies(match.roster,offer.defId,offer.rank);
          return <button type="button" key={offer.id} className={'match-shop-card '+(copies>=2?'can-merge':'')} disabled={!canPlan||match.gold<offer.cost} onClick={()=>void command('match.buy',{offerId:offer.id})} aria-label={'招募 '+def.name+'，'+stats.role+'，'+offer.cost+' 局内金币'+(copies>=2?'，可自动合星':'')} title={stats.skillName+'：'+stats.skillDescription}>
            <div className="match-shop-art"><img src={'/art/'+def.art+'.png'} alt="" draggable={false}/><span className="match-shop-permanent">{qualityName(offer.rank)}</span>{copies>=2&&<span className="match-merge-tag"><Sparkles size={11}/>合星</span>}</div>
            <div className="match-shop-copy"><strong>{def.name}</strong><span>{AFFINITIES[def.affinity].name} · {stats.role}</span><div><small>{copies?'一星 '+copies+'/3':'一星副本'}</small><b><Coins size={13}/>{offer.cost}</b></div></div>
          </button>;
        })}</div>
      </section>
    </div>
    {active&&onBack&&<span className="match-back-reminder">返回大厅不暂停本局</span>}{feedback}{overlays}
  </section>;
}
export default MatchArena;
