import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import type {CSSProperties,ReactNode} from 'react';
import {ArrowRight,ArrowUp,BookOpen,Check,ChevronDown,Coins,Compass,FlaskConical,Heart,Info,Leaf,LoaderCircle,Lock,Menu,Moon,Recycle,RefreshCw,Search,Shield,Sparkles,Swords,Users,Volume2,VolumeX,X} from 'lucide-react';
import {AFFINITIES,CARDS,CARD_MAP,ECONOMY,QUALITY,QUALITY_TIERS,qualityName} from './data';
import type {Affinity,CardDef} from './data';
import type {GameStateV2,OwnedCardV2,ForgeOutcomeV2,DrawCandidate} from './engine';
import {forgeOddsV2,buildStarterPack} from './engine';
import {getCombatStats} from './battle';
import type {BattleState} from './battle';
import MatchArena from './MatchArena';
import type {MatchState} from './MatchArena';
import DuelArena from './DuelArena';
import {startDuelHomeProbe} from './duel-session';
import Community from './Community';
import {AccountMenu,readAuth} from './AccountMenu';
import type {AuthState} from './AccountMenu';
import {isSoundEnabled,playSound,setSoundEnabled} from './audio';
import type {SoundCue} from './audio';
import './style.css';
import './combat-app.css';
import './immersive-battle.css';

type Page='collection'|'battle'|'summon'|'forge'|'community';
type GameState=GameStateV2&{pendingDraw?:{id:string;mode:'choice_one'|'ten';candidates:DrawCandidate[]}|null};
type GameSnapshot={state:GameState;battle:BattleState|null;match?:MatchState|null;revision:number;code?:string;replay?:{kind:string;cards?:{uid?:string;defId:string;rank:number;restricted:boolean}[];card?:{uid:string;defId:string;rank:number;restricted:boolean};candidates?:DrawCandidate[];orderId?:string;outcome?:ForgeOutcomeV2}|null};
type Dialog={title:string;content:ReactNode;label?:string;action?:()=>Promise<boolean>};
type DrawView={mode:'choice_one'|'ten';cards:{uid?:string;defId:string;rank:number;restricted:boolean}[]};
const QUALITY_ODDS_NOTE=QUALITY_TIERS.map(tier=>tier.name+' '+QUALITY.summonQuality[tier.level-1]+'%').join(' / ');
const NAV=[
  {id:'collection' as Page,label:'我的卡牌',en:'COLLECTION',icon:BookOpen},
  {id:'battle' as Page,label:'对战',en:'BATTLE',icon:Swords},
  {id:'summon' as Page,label:'抽卡',en:'SUMMON',icon:Compass},
  {id:'forge' as Page,label:'制作回收',en:'CRAFTING',icon:FlaskConical},
  {id:'community' as Page,label:'社区',en:'COMMUNITY',icon:Users},
];
function Crest({small=false}:{small?:boolean}){
  return <svg className={small?'crest small':'crest'} viewBox="0 0 80 80" fill="none" aria-hidden="true"><circle cx="40" cy="40" r="27" stroke="currentColor" strokeWidth=".8"/><circle cx="40" cy="40" r="23" stroke="currentColor" strokeWidth=".4"/><path d="M40 3 46 33 77 40 46 47 40 77 34 47 3 40 34 33Z" stroke="currentColor" fill="currentColor" fillOpacity=".16"/><path d="m40 17 3 20 20 3-20 3-3 20-3-20-20-3 20-3Z" fill="currentColor"/><path d="m19 19 42 42m0-42L19 61" stroke="currentColor" strokeWidth=".6"/></svg>;
}
function ElementIcon({affinity,size=16}:{affinity:Affinity;size?:number}){const Icon=affinity==='moon'?Moon:affinity==='forest'?Leaf:Sparkles;return <Icon size={size} aria-hidden="true"/>;}
function copiesOf(cards:OwnedCardV2[],defId:string){return cards.filter(card=>card.defId===defId).sort((a,b)=>b.rank-a.rank||a.uid.localeCompare(b.uid));}
function previewCard(defId:string,rank=1):OwnedCardV2{return {uid:'preview-'+defId,defId,rank,best:0,transferPolicy:'free',originKind:'legacy',createdEconomyVersion:2};}
function Card({def,card,selected=false,onClick,locked=false,actionLabel="查看卡牌"}:{def:CardDef;card?:OwnedCardV2;selected?:boolean;onClick:()=>void;locked?:boolean;actionLabel?:string}){
  const rank=card?.rank??1;const stats=getCombatStats(card??previewCard(def.id));
  return <button type="button" className={'spirit-card combat-card'+(selected?' selected':'')+(locked?' locked':'')} data-rank={rank} style={{'--affinity':AFFINITIES[def.affinity].color} as CSSProperties} onClick={onClick} aria-label={def.name+'，'+(locked?'未拥有':'品质 '+qualityName(rank))+'，'+actionLabel} aria-pressed={selected}>
    <img src={'/art/'+def.art+'.png'} alt="" loading="lazy" draggable={false}/><span className="card-edge" aria-hidden="true"/>{selected&&<span className="card-selected"><Check size={13}/></span>}{locked&&<span className="card-lock"><Lock size={21}/></span>}<span className="card-caption"><span className="card-title">{def.name}</span><span className="card-sub"><span><Heart size={10}/>{stats.hp}</span><span>{stats.role}</span><span><Swords size={10}/>{stats.attack}</span></span></span>
  </button>;
}
function Confirmation({dialog,busy,onClose}:{dialog:Dialog;busy:boolean;onClose:()=>void}){
  const ref=useRef<HTMLDivElement>(null);const closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(()=>{const before=document.activeElement as HTMLElement|null;const oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';const first=()=>ref.current?.querySelector<HTMLElement>('button:not(:disabled)');first()?.focus();
    const handler=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();closeRef.current();}if(event.key==='Tab'){const nodes=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]')??[]);if(!nodes.length)return;if(event.shiftKey&&document.activeElement===nodes[0]){event.preventDefault();nodes.at(-1)?.focus();}else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0]?.focus();}}};
    document.addEventListener('keydown',handler);return()=>{document.removeEventListener('keydown',handler);document.body.style.overflow=oldOverflow;before?.isConnected&&before.focus();};},[]);
  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="combat-dialog-title" ref={ref}><button className="icon-button close-modal" onClick={onClose} disabled={busy} aria-label="关闭"><X size={19}/></button><Crest small/><h2 id="combat-dialog-title">{dialog.title}</h2><div className="modal-body">{dialog.content}</div>{dialog.action?<div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={busy}>取消</button><button className="gold-button" disabled={busy} onClick={async()=>{if(await dialog.action!())onClose();}}>{busy?<LoaderCircle className="combat-spin" size={16}/>:null}{dialog.label??'确认'}</button></div>:<button className="dark-button modal-done" onClick={onClose}>知道了<Check size={15}/></button>}</div></div>;
}
function makeRequestId(){if(typeof crypto.randomUUID==='function')return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const value=Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');return value.slice(0,8)+'-'+value.slice(8,12)+'-'+value.slice(12,16)+'-'+value.slice(16,20)+'-'+value.slice(20);}
async function responseData(response:Response){const payload=await response.json().catch(()=>({error:'服务器返回了无法读取的内容'}));if(!response.ok){const detail=typeof payload.error==='string'?payload.error:payload.message;throw new Error(response.status===401?'请先登录账号':detail||'请求未完成，请重试');}return payload;}

export default function CombatApp(){
  const [auth,setAuth]=useState<AuthState|null>(null);const [authLoading,setAuthLoading]=useState(true);const [snapshot,setSnapshot]=useState<GameSnapshot|null>(null);const [loading,setLoading]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [toast,setToast]=useState('');
  const [page,setPage]=useState<Page>('collection');const [mobileNav,setMobileNav]=useState(false);const [selected,setSelected]=useState(CARDS[0].id);const [affinity,setAffinity]=useState<Affinity|'all'>('all');const [search,setSearch]=useState('');const [showAll,setShowAll]=useState(false);const [sort,setSort]=useState<'default'|'rank'>('default');const [forgeMode,setForgeMode]=useState<'quality'|'craft'|'recycle'>('quality');const [dialog,setDialog]=useState<Dialog|null>(null);const [sound,setSound]=useState(isSoundEnabled);const [revealing,setRevealing]=useState(false);const [revealKey,setRevealKey]=useState(0);const [upgradePulse,setUpgradePulse]=useState(false);const [forgeOutcome,setForgeOutcome]=useState<ForgeOutcomeV2|null>(null);
  const [forgeMainRank,setForgeMainRank]=useState<number|null>(null);const [allowRestricted,setAllowRestricted]=useState(true);const [drawView,setDrawView]=useState<DrawView|null>(null);const [starterPick,setStarterPick]=useState<string|null>(null);
  const identityRef=useRef<string|null>(null);const snapshotRef=useRef<GameSnapshot|null>(null);const authRequestRef=useRef(0);const gameRequestRef=useRef(0);const operationRef=useRef(0);const busyRef=useRef(false);const revealTimer=useRef<ReturnType<typeof setTimeout>|null>(null);const pulseTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const accept=useCallback((next:GameSnapshot,userId:string)=>{if(identityRef.current!==userId)return;if(!next.state||!Array.isArray(next.state.cards)||!Number.isSafeInteger(next.revision))throw new Error('账户数据不完整，请刷新重试');if(snapshotRef.current&&next.revision<snapshotRef.current.revision)return;snapshotRef.current=next;setSnapshot(next);setError('');},[]);
  const refreshGame=useCallback(async(userId=identityRef.current)=>{if(!userId)return;const request=++gameRequestRef.current;setLoading(true);try{const response=await fetch('/api/game',{credentials:'same-origin',cache:'no-store',headers:{'X-Asteria-User':userId}});if(response.status===409){if(identityRef.current===userId&&request===gameRequestRef.current){setError('账号已切换，正在同步');window.dispatchEvent(new Event('asteria-auth-changed'));}return;}if(response.status===401&&identityRef.current===userId){identityRef.current=null;snapshotRef.current=null;setSnapshot(null);setAuth(current=>current?{...current,user:null}:current);setLoading(false);operationRef.current++;busyRef.current=false;setBusy(false);setPage('collection');setError('请登录后继续');return;}const next=await responseData(response);if(identityRef.current===userId&&request===gameRequestRef.current)accept(next,userId);}catch(cause){if(identityRef.current===userId&&request===gameRequestRef.current)setError(cause instanceof Error?cause.message:'账户读取失败');}finally{if(identityRef.current===userId&&request===gameRequestRef.current)setLoading(false);}},[accept]);
  const refreshAuth=useCallback(async()=>{const request=++authRequestRef.current;setAuthLoading(true);try{const next=await readAuth();if(request!==authRequestRef.current)return;const id=next.user?.id??null;setAuth(next);if(id!==identityRef.current){identityRef.current=id;snapshotRef.current=null;setSnapshot(null);setDialog(null);setToast('');setError('');setPage('collection');setSelected(CARDS[0].id);operationRef.current++;busyRef.current=false;setBusy(false);gameRequestRef.current++;setLoading(false);setRevealing(false);setDrawView(null);setStarterPick(null);}if(id)await refreshGame(id);}catch(cause){if(request===authRequestRef.current){setError(cause instanceof Error?cause.message:'无法连接账号服务');setAuth(null);identityRef.current=null;snapshotRef.current=null;setSnapshot(null);}}finally{if(request===authRequestRef.current)setAuthLoading(false);}},[refreshGame]);
  useEffect(()=>{void refreshAuth();const changed=()=>{void refreshAuth();};window.addEventListener('asteria-auth-changed',changed);return()=>{authRequestRef.current++;window.removeEventListener('asteria-auth-changed',changed);};},[refreshAuth]);
  useEffect(()=>{let lastCheck=0;const sync=()=>{const now=Date.now();if(document.visibilityState==='hidden'||busyRef.current||!identityRef.current||now-lastCheck<500)return;lastCheck=now;void refreshGame();};const timer=setInterval(sync,15000);window.addEventListener('focus',sync);document.addEventListener('visibilitychange',sync);return()=>{clearInterval(timer);window.removeEventListener('focus',sync);document.removeEventListener('visibilitychange',sync);};},[refreshGame]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),4300);return()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{document.title='星序 · '+NAV.find(item=>item.id===page)!.label;},[page]);
  useEffect(()=>()=>{if(revealTimer.current)clearTimeout(revealTimer.current);if(pulseTimer.current)clearTimeout(pulseTimer.current);},[]);
  useEffect(()=>{if(!mobileNav)return;const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setMobileNav(false);};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[mobileNav]);
  // 新号首登：新手礼包未领时直接落到抽卡页的“选择本命”流程，不再停在空收藏页。
  const starterDirected=useRef<string|null>(null);
  useEffect(()=>{
    const userId=identityRef.current;
    if(!snapshot?.state||!userId||starterDirected.current===userId)return;
    starterDirected.current=userId;
    if(snapshot.state.starter?.status==='pending')setPage('summon');
  },[snapshot]);
  // 刷新 / 断线重连：有进行中的决斗房间就直接回到对战页，不要求玩家记得路径。
  const duelHomeProbed=useRef<string|null>(null);
  const duelProbeUserId=snapshot&&auth?.user&&auth.user.id===identityRef.current?auth.user.id:null;
  useEffect(()=>{
    const userId=duelProbeUserId;
    if(!userId){duelHomeProbed.current=null;return;}
    if(duelHomeProbed.current===userId)return;
    return startDuelHomeProbe(async signal=>{
      const response=await fetch('/api/duel/me',{credentials:'same-origin',cache:'no-store',headers:{'X-Asteria-User':userId},signal});
      const me=await responseData(response) as {activeRoomId:string|null};
      if(me.activeRoomId!==null&&typeof me.activeRoomId!=='string')throw new Error('对战恢复数据不完整');
      return me;
    },me=>{
      if(identityRef.current!==userId)return;
      duelHomeProbed.current=userId; // 只有确定结果才完成探测；失败由 helper 重试。
      if(me.activeRoomId)setPage('battle');
    });
  },[duelProbeUserId]);

  async function command(action:string,args:Record<string,unknown>={},cue:SoundCue='success',message=''):Promise<GameSnapshot|false>{
    const userId=identityRef.current;if(!userId){setToast('请先登录账号');return false;}if(busyRef.current)return false;const operation=++operationRef.current;busyRef.current=true;setBusy(true);playSound('select');
    try{const body=JSON.stringify({...args,requestId:makeRequestId()});const execute=()=>fetch('/api/game/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Asteria-User':userId},body});let response:Response;try{response=await execute();}catch{response=await execute();}const next=await responseData(response);if(identityRef.current!==userId||operation!==operationRef.current)return false;
      accept(next,userId);playSound(cue);if(message)setToast(message);return next;}
    catch(cause){if(identityRef.current===userId&&operation===operationRef.current){setToast(cause instanceof Error?cause.message:'操作失败，请重试');playSound('error');await refreshGame(userId);}return false;}
    finally{if(operation===operationRef.current){busyRef.current=false;setBusy(false);}}
  }
  const game=snapshot?.state;const cards=game?.cards??[];const battle=snapshot?.battle??null;const activeUids=new Set(battle?.status==='playing'?battle.player.map(unit=>unit.cardUid):[]);const selectedDef=CARD_MAP[selected]??CARDS[0];const selectedCopies=copiesOf(cards,selectedDef.id);const main=selectedCopies[0];const stats=getCombatStats(main??previewCard(selectedDef.id));const ownedKinds=new Set(cards.map(card=>card.defId)).size;
  const spendable=game?Math.max(0,game.coins-game.restrictedCoins):0;
  const paymentMode=allowRestricted?'allow_restricted':'normal_only';
  const paymentPreview=(cost:number)=>allowRestricted&&spendable<cost; // true = 本次会动用赠送额度 → 产物仅可自用
  const selectedLocked=!!main&&activeUids.has(main.uid);
  // 回收保护口径：每卡种保留最后一张（跨品质合计），仅多余 Q1 可回收。
  const q1Available=selectedCopies.filter(card=>card.rank===1&&!activeUids.has(card.uid));
  const onlyQ1Left=selectedCopies.length>0&&selectedCopies.every(card=>card.rank===1);
  const recyclableCount=Math.max(0,q1Available.length-(onlyQ1Left?1:0));
  const recyclablePick=q1Available[onlyQ1Left?1:0];
  const visibleCards=useMemo(()=>CARDS.filter(def=>{
    const list=copiesOf(cards,def.id);if(affinity!=='all'&&def.affinity!==affinity)return false;if(search&&!def.name.includes(search)&&!getCombatStats(list[0]??previewCard(def.id)).role.includes(search))return false;
    if(page==='forge'&&forgeMode==='recycle')return Math.max(0,list.filter(card=>card.rank===1&&!activeUids.has(card.uid)).length-(list.length>0&&list.every(card=>card.rank===1)?1:0))>0;if(page==='forge')return list.length>0;return showAll||list.length>0;
  }).sort((a,b)=>sort==='rank'?(copiesOf(cards,b.id)[0]?.rank??0)-(copiesOf(cards,a.id)[0]?.rank??0):CARDS.indexOf(a)-CARDS.indexOf(b)),[cards,affinity,search,page,forgeMode,showAll,sort,battle]);
  useEffect(()=>{if(page==='forge'&&visibleCards.length&&!visibleCards.some(def=>def.id===selected))setSelected(visibleCards[0].id);},[page,visibleCards,selected]);
  useEffect(()=>{setForgeMainRank(null);},[selected]);
  const showInspector=page==='collection'||(selectedCopies.length>0&&visibleCards.some(def=>def.id===selectedDef.id));
  const go=(next:Page)=>{if(page==='battle'&&next!=='battle'&&document.fullscreenElement)void document.exitFullscreen().catch(()=>{});setPage(next);setMobileNav(false);setDialog(null);window.scrollTo({top:0,behavior:'instant'});playSound('select');};
  function inspect(id:string){setSelected(id);setPage('collection');setAffinity('all');setSearch('');setShowAll(true);playSound('select');}
  function confirmForge(){
    if(!main||!forgeMain||forgeRank>=QUALITY_TIERS.length)return;
    const odds=forgeOddsV2(forgeRank);const cost=QUALITY.forge.coins[forgeRank-1];
    const materials=selectedCopies.filter(card=>card.rank===forgeRank&&!activeUids.has(card.uid)&&card.uid!==forgeMain.uid).slice(0,QUALITY.forge.materials);
    const inputsRestricted=forgeMain.transferPolicy==='starter_restricted'||materials.some(card=>card.transferPolicy==='starter_restricted');
    const outcomeRestricted=inputsRestricted||paymentPreview(cost);
    setDialog({title:'品质合成 · '+selectedDef.name,label:'确认合成',content:<>
      <div className="combat-confirm-card"><img src={'/art/'+selectedDef.art+'.png'} alt=""/><div><b>{qualityName(forgeRank)} <ArrowRight size={14}/> {qualityName(Math.min(forgeRank+2,QUALITY_TIERS.length))}</b><span>生命 {getCombatStats(forgeMain).hp} → {getCombatStats({...forgeMain,rank:forgeMain.rank+1}).hp}</span><span>攻击 {getCombatStats(forgeMain).attack} → {getCombatStats({...forgeMain,rank:forgeMain.rank+1}).attack}</span></div></div>
      <p>消耗主卡之外的 <b>2 张 {qualityName(forgeRank)} 品质同名卡</b> 和 <b>{cost} 星币</b>。</p>
      <div className="odds"><span>升一级 <b>{odds.upgradeOne}%</b></span>{odds.upgradeTwo>0&&<span>连升两级 <b>{odds.upgradeTwo}%</b></span>}<span>失败 <b>{odds.fail}%</b></span></div>
      {outcomeRestricted&&<p className="fineprint">⚠ 本次投入含新手赠送来源（费用或材料），<b>成功结果将不可交易</b>；失败时主卡与返还材料保持原来源。</p>}
      <p className="fineprint">失败不销毁主卡、品质不降；材料随机返还 1～2 张，星币不退。结果以服务器结算为准。</p>
    </>,action:async()=>{
      const result=await command('forge',{defId:selectedDef.id,mainUid:forgeMain.uid,paymentMode,expectedTransferable:!outcomeRestricted},'upgrade');
      if(result){const outcome=result.replay?.kind==='forge'?result.replay.outcome??null:null;if(outcome){setForgeOutcome(outcome);setUpgradePulse(true);if(pulseTimer.current)clearTimeout(pulseTimer.current);pulseTimer.current=setTimeout(()=>setUpgradePulse(false),680);}}
      return !!result;
    }});
  }
  function confirmRecycle(){const extra=recyclablePick;if(!extra)return;
    setDialog({title:'回收重复卡',label:'确认回收',content:<><p>回收 1 张 <b>{selectedDef.name}</b>（#{extra.uid}），获得 <b>{ECONOMY.recycleReturn} 星币</b>{extra.transferPolicy==='starter_restricted'?'（进入赠送受限额度）':''}。</p><p className="fineprint">仅可回收多余的微光（Q1）卡，每卡种保留最后一张。回收后无法撤销。</p></>,action:async()=>!!(await command('recycle',{uids:[extra.uid]},'craft','已回收，星币已到账'))});
  }
  function confirmCraft(){if(!main){setToast('这里只能制作已拥有的卡牌');return;}
    const outcomeRestricted=paymentPreview(ECONOMY.craftCost);
    setDialog({title:'定向制作 '+selectedDef.name,label:'确认制作',content:<><div className="combat-confirm-card"><img src={'/art/'+selectedDef.art+'.png'} alt=""/><div><b>{selectedDef.name}</b><span>{stats.role} · {AFFINITIES[selectedDef.affinity].name}系</span></div></div><p>消耗 <b>{ECONOMY.craftCost} 星币</b>，获得 1 张微光（Q1）品质卡牌。</p>{outcomeRestricted&&<p className="fineprint">⚠ 将动用新手赠送额度，<b>制作产物仅可自用</b>。</p>}<p className="fineprint">定向制作不随机；高品质需通过同名卡合成升阶。</p></>,action:async()=>!!(await command('craft',{defId:selectedDef.id,paymentMode,expectedTransferable:!outcomeRestricted},'craft','制作成功，已加入收藏'))});
  }
  async function doSingleDraw(){
    if(revealing||!game)return;
    const outcomeRestricted=paymentPreview(ECONOMY.singleDrawCost);
    const result=await command('summon.begin',{mode:'choice_one',paymentMode,expectedTransferable:!outcomeRestricted},'summon');
    if(result)setDrawView(null);
  }
  async function doClaimDraw(candidateId:string){
    if(!game?.pendingDraw)return;
    const candidate=game.pendingDraw.candidates.find(entry=>entry.candidateId===candidateId);
    const outcomeRestricted=game.pendingDraw.candidates.length>0; // 领取结果是否受限由订单支付构成决定，服务端权威
    const result=await command('summon.claim',{orderId:game.pendingDraw.id,candidateId},'summon','已加入收藏');
    if(result&&result.replay?.kind==='summon.claim'&&result.replay.card)setDrawView({mode:'choice_one',cards:[result.replay.card]});
    else if(candidate)setDrawView({mode:'choice_one',cards:[{defId:candidate.defId,rank:candidate.rank,restricted:outcomeRestricted}]});
  }
  async function doTenDraw(){
    if(revealing||!game)return;
    const outcomeRestricted=paymentPreview(ECONOMY.tenDrawCost);
    const result=await command('summon.begin',{mode:'ten',paymentMode,expectedTransferable:!outcomeRestricted},'summon');
    if(result){const shown=result.replay?.kind==='summon.ten'&&result.replay.cards?result.replay.cards:result.state.lastDraw?.mode==='ten'?result.state.lastDraw.cards:[];setDrawView({mode:'ten',cards:shown});setRevealKey(value=>value+1);setRevealing(true);if(revealTimer.current)clearTimeout(revealTimer.current);revealTimer.current=setTimeout(()=>setRevealing(false),930);}
  }
  function confirmStarter(defId:string){
    let pack;try{pack=buildStarterPack(defId);}catch{setToast('当前卡池无法生成新手礼包');return;}
    const byKind=new Map<string,number>();for(const card of pack.cards)byKind.set(card.defId,(byKind.get(card.defId)??0)+1);
    setDialog({title:'选择本命星灵',label:'领取新手礼包',content:<>
      <div className="combat-confirm-card"><img src={'/art/'+(CARD_MAP[defId]?.art??'moon-fawn')+'.png'} alt=""/><div><b>{CARD_MAP[defId]?.name}</b><span>本命 Q3 ×1 + 支援 Q2 ×4 + 同名素材 Q1 ×18</span></div></div>
      <p>共 <b>23 张卡、{byKind.size} 种</b>，并获得 <b>{ECONOMY.starterCoins} 星币</b>。</p>
      <p className="fineprint">礼包星币与卡均为新手赠送来源：<b>可用于抽卡 / 制作 / 合成，不能购买玩家挂单或交易</b>。每个账号只能领取一次。</p>
    </>,action:async()=>!!(await command('starter.claim',{favoriteDefId:defId},'craft','新手礼包已到账，开始你的星序之旅'))});
  }
  const help=()=>setDialog({title:'开始你的第一场对战',content:<div className="help-copy"><p><b>星币与金币</b><br/>星币是永久资产，用于抽卡 / 制作 / 合成与玩家交易；金币只在单局对局内使用，局末清零，两者不能互转。</p><p><b>双人对战</b><br/>创建房间并把 8 位房间码发给好友。每局约 9 分钟、共 10 轮：R1/R4/R7 打野怪拿保底金币并三选一临时装备，其余 7 轮与对手交锋。开局选 8 种本命卡组（每种锁定一个本局品质）和 2 个免费副本；人口按轮次自动 3→6，不买经验；三同名卡自动合星。失败只扣生命，野怪输了不掉装备。</p><p><b>收集与养成</b><br/>单抽三选一更容易定向，十连快速积累；同名同品质卡可合成升阶，失败不伤主卡、随机返还材料。多余微光卡可回收成星币。</p><p className="fineprint">账号资产由服务器保存。没有真实充值。</p></div>});
  const nav=NAV.find(item=>item.id===page)!;
  // 主卡可从任一拥有的品质档中指定（默认最高档），低品质重复卡同样能合成升阶。
  const forgeRankOptions=QUALITY_TIERS.filter(tier=>selectedCopies.some(card=>card.rank===tier.level));
  const forgeRank=forgeMainRank!==null&&forgeRankOptions.some(tier=>tier.level===forgeMainRank)?forgeMainRank:(forgeRankOptions.at(-1)?.level??1);
  const forgeMain=selectedCopies.find(card=>card.rank===forgeRank)??main;
  const need=QUALITY.forge.materials;
  const eligibleMaterials=selectedCopies.filter(card=>card.rank===forgeRank&&!activeUids.has(card.uid)&&card.uid!==forgeMain?.uid).length;
  const forgeCost=forgeRank<QUALITY_TIERS.length?QUALITY.forge.coins[forgeRank-1]:0;
  const forgeMainLocked=!!forgeMain&&activeUids.has(forgeMain.uid);
  const forgeReason=!main?'尚未拥有':forgeRank>=QUALITY_TIERS.length?'星冕已是最高品质':forgeMainLocked?'该卡正在对战':eligibleMaterials<need?`还需 ${need-eligibleMaterials} 张${qualityName(forgeRank)}同名材料`:(game?.coins??0)<forgeCost?'星币不足':'';
  const forgeQualitySelector=forgeRankOptions.length>1?<label className="forge-main-select">主卡品质
    <select value={forgeRank} onChange={event=>setForgeMainRank(Number(event.target.value))} aria-label="选择合成主卡品质">
      {forgeRankOptions.map(tier=><option key={tier.level} value={tier.level}>{tier.name}（{selectedCopies.filter(card=>card.rank===tier.level).length} 张）</option>)}
    </select></label>:null;

  const immersive = page === 'battle' && !!snapshot;
  const duelUser=auth?.user??null;
  useEffect(() => {
    if (!immersive) return;
    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => { document.body.style.overflow = bodyOverflow; document.documentElement.style.overflow = htmlOverflow; };
  }, [immersive]);

  const starterPending=game?.starter.status==='pending';
  const pendingDraw=game?.pendingDraw??null;
  const drawResults=drawView?.cards??[];

  return <div className={'app-shell combat-app' + (immersive ? ' is-battle-immersive' : '')}><aside className={'sidebar '+(mobileNav?'mobile-open':'')} inert={!!dialog}><button className="brand" onClick={()=>go('collection')} aria-label="星序首页"><Crest/><span className="brand-cn">星 序</span><span className="brand-en">A S T E R I A</span></button><span className="nav-caption">收集 · 对战 · 相遇</span><nav aria-label="主导航">{NAV.map(item=><button key={item.id} className={'nav-item '+(page===item.id?'active':'')} onClick={()=>go(item.id)} aria-current={page===item.id?'page':undefined}><item.icon size={22}/><span>{item.label}<small>{item.en}</small></span>{item.id==='battle'&&snapshot?.match?.status==='playing'&&<span className="activity-dot"/>}</button>)}</nav><div className="sidebar-bottom"><div className="sidebar-quote"><span>与星灵同行</span><span>与朋友相遇</span><i>— ASTERIA —</i></div><div className="profile combat-profile"><img src="/art/moon-fawn.png" alt=""/><span><b>{auth?.user?.name??'尚未登录'}</b><small><i/>{snapshot?.code?'玩家码 '+snapshot.code:auth?.user?'服务器已连接':'登录后保存进度'}</small></span></div><span className="build-label">COLLECT · BATTLE · CONNECT</span></div></aside>{mobileNav&&<button className="mobile-shade" onClick={()=>setMobileNav(false)} aria-label="收起导航"/>}
    <div className="app-body"><header className="topbar" inert={!!dialog}><div className="breadcrumb"><button className="mobile-brand icon-button" onClick={()=>setMobileNav(!mobileNav)} aria-label="打开导航" aria-expanded={mobileNav}><Menu size={21}/></button><Sparkles size={17}/><span>星序</span><i>/</i><strong>{nav.label}</strong></div><div className="currencies"><button onClick={()=>go('summon')} title={game&&game.restrictedCoins>0?'星币 '+game.coins.toLocaleString()+'，其中 '+game.restrictedCoins.toLocaleString()+' 为新手赠送额度（仅可自用）':'星币余额'}><Coins size={19}/><b>{game?game.coins.toLocaleString():'—'}</b>{game&&game.restrictedCoins>0&&<small className="restricted-note">含赠送 {game.restrictedCoins.toLocaleString()}</small>}</button><button className="sound-toggle" aria-label={sound?'关闭音效':'开启音效'} aria-pressed={sound} onClick={()=>{const next=!sound;setSound(next);setSoundEnabled(next);if(next)playSound('select');}}>{sound?<Volume2 size={18}/>:<VolumeX size={18}/>}<span>音效</span></button><AccountMenu/><button className="help-button" onClick={help} aria-label="玩法说明"><Info size={19}/></button></div></header>
    {immersive&&<div className="combat-battle-tools" inert={!!dialog} aria-label="对战设置"><button className="combat-battle-sound" aria-label={sound?'关闭音效':'开启音效'} aria-pressed={sound} onClick={()=>{const next=!sound;setSound(next);setSoundEnabled(next);if(next)playSound('select');}}>{sound?<Volume2 size={17}/>:<VolumeX size={17}/>}</button><AccountMenu/><button className="combat-battle-help" onClick={help} aria-label="玩法说明"><Info size={17}/></button></div>}
    <main className={'workspace combat-workspace combat-page-'+page+(page==='summon'&&snapshot?' page-summon':'')} inert={!!dialog||mobileNav}>
      {error&&<div className="combat-connection-error" role="alert"><Info size={16}/><span>{error}</span><button onClick={()=>void refreshAuth()} disabled={authLoading||loading}><RefreshCw size={14}/>重试</button></div>}
      {!snapshot?(authLoading||loading?<section className="combat-loading" role="status"><Crest/><LoaderCircle className="combat-spin" size={22}/><h2>正在连接你的收藏</h2><p>读取服务器进度…</p></section>:!auth?.user?<section className="combat-login"><div className="combat-login-art"><img src="/art/moon-deer.png" alt="月纱灵鹿"/></div><div className="combat-login-copy"><span className="eyebrow">WELCOME TO ASTERIA</span><h1>收集你的星灵。<br/>开启下一场对战。</h1><p>登录后即可抽卡、组队对战，<br/>与朋友交易、赠送和聊天。</p><AccountMenu/><span className="combat-login-note"><Shield size={15}/>卡牌与资源由服务器保存</span>{auth?.devLogin&&<small>当前为开发环境，可在账号菜单选择测试账号。</small>}</div></section>:<section className="combat-loading"><Info size={29}/><h2>暂时无法读取收藏</h2><p>请检查服务器连接后重试。</p><button className="gold-button" onClick={()=>void refreshGame()}>重新连接<RefreshCw size={16}/></button></section>):<>
      {(page==='collection'||page==='forge')&&<div className="collection-shell"><section className="collection-main"><div className="section-heading"><div><span className="eyebrow">{page==='collection'?'SPIRIT COLLECTION':'THE CELESTIAL ATELIER'}</span><h1>{page==='collection'?'我的卡牌':'制作回收'}<span className="heading-diamond">✧</span></h1></div><span className="collection-count">已收集 <b>{ownedKinds}</b><em>/ {CARDS.length}</em></span></div>
      {page==='forge'&&<div className="forge-tabs"><button className={forgeMode==='quality'?'active':''} aria-pressed={forgeMode==='quality'} onClick={()=>setForgeMode('quality')}><ArrowUp size={15}/>品质合成</button><button className={forgeMode==='craft'?'active':''} aria-pressed={forgeMode==='craft'} onClick={()=>setForgeMode('craft')}><FlaskConical size={15}/>定向制作</button><button className={forgeMode==='recycle'?'active':''} aria-pressed={forgeMode==='recycle'} onClick={()=>setForgeMode('recycle')}><Recycle size={15}/>回收多余卡</button><span>{forgeMode==='quality'?'同名同品质卡合成升阶，有失败概率。':forgeMode==='craft'?'180 星币制作一张已拥有的卡（微光品质）。':'多余微光卡换成星币。'}</span></div>}
      <div className="filter-bar"><div className="affinity-tabs" role="group" aria-label="属性筛选"><button className={affinity==='all'?'active':''} aria-pressed={affinity==='all'} onClick={()=>setAffinity('all')}><Sparkles size={15}/><span>全部属性</span></button>{(['sun','moon','forest'] as Affinity[]).map(value=><button key={value} className={affinity===value?'active':''} aria-pressed={affinity===value} onClick={()=>setAffinity(value)}><ElementIcon affinity={value}/><span>{AFFINITIES[value].name}</span></button>)}</div><label className="search-field"><Search size={15}/><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="名称 / 职业" aria-label="搜索卡牌名称或职业"/>{search&&<button aria-label="清除搜索" onClick={()=>setSearch('')}><X size={13}/></button>}</label></div>
      <div className="collection-controls"><label className="sort-control">排序<select value={sort} onChange={event=>setSort(event.target.value as typeof sort)} aria-label="卡牌排序"><option value="default">默认</option><option value="rank">品质</option></select></label><label className="sort-control payment-toggle" title="允许动用新手赠送额度时，抽卡 / 制作 / 合成产物将不可交易"><input type="checkbox" checked={allowRestricted} onChange={event=>setAllowRestricted(event.target.checked)}/>允许使用赠送额度</label></div>
      <div className="collection-meta"><span>{cards.length} 张卡牌 · {visibleCards.length} 种符合筛选</span>{page==='collection'&&<label><input type="checkbox" checked={showAll} onChange={event=>setShowAll(event.target.checked)}/>显示未拥有</label>}</div>
      <div className="cards-scroll"><div className="card-grid">{visibleCards.map((def,index)=>{const list=copiesOf(cards,def.id);return <div className="card-item" key={def.id} style={{'--delay':index%12*25+'ms'} as CSSProperties}><Card def={def} card={list[0]} locked={!list.length} selected={selected===def.id} onClick={()=>{setSelected(def.id);playSound('select');}}/><div className="card-meta">{page==='forge'&&forgeMode==='craft'?<><Coins size={12}/><b>{ECONOMY.craftCost}</b><span>星币</span></>:page==='forge'&&forgeMode==='recycle'?<><Recycle size={12}/><b>{Math.max(0,list.filter(card=>card.rank===1&&!activeUids.has(card.uid)).length-(list.length>0&&list.every(card=>card.rank===1)?1:0))}</b><span>可回收</span></>:<><span>{list.length?'已拥有':'未拥有'}</span>{list.length>0&&<b>{list.length}</b>}</>}</div></div>;})}</div>{!visibleCards.length&&<div className="empty-state compact-empty">{!cards.length&&page==='collection'?<><Compass size={31}/><h3>背包还是空的</h3><p>先领取新手礼包，选出你的第一张本命星灵。</p><button className="gold-button" onClick={()=>go('summon')}>去抽卡<ArrowRight size={16}/></button></>:<><Search size={31}/><h3>{page==='forge'&&forgeMode==='recycle'?'没有可回收的重复卡':'没有找到卡牌'}</h3><p>{page==='forge'&&forgeMode==='craft'?'这里只显示已拥有的卡牌。':'每卡种最后一张与对战中的卡牌会保留。'}</p><button className="text-button" onClick={()=>{setSearch('');setAffinity('all');}}>清除筛选</button></>}</div>}</div>
      <div className="combat-collection-footer"><span><Shield size={15}/>服务器保存 · <b>{cards.length}</b> 张收藏</span><button className="gold-button" onClick={()=>go(page==='forge'?'community':'battle')}>{page==='forge'?'去市场看看':'组队对战'}<ArrowRight size={17}/></button></div></section>
      {showInspector&&<aside className="inspector"><div className="inspector-heading"><h2>卡牌详情</h2><span>No. {String(CARDS.indexOf(selectedDef)+1).padStart(3,'0')}</span></div><div className={'portrait-frame '+(upgradePulse?'upgrade-pulse':'')} data-rank={main?.rank??1} key={selectedDef.id}><img src={'/art/'+selectedDef.art+'.png'} alt={selectedDef.name}/></div><div className="inspector-title"><h2>{selectedDef.name}</h2><span className="detail-level"><small>品质</small><strong>{main?qualityName(main.rank):'未拥有'}</strong></span></div><div className="tags"><span><ElementIcon affinity={selectedDef.affinity} size={13}/>{AFFINITIES[selectedDef.affinity].name}</span><span>{stats.role}</span><span>拥有 {selectedCopies.length} 张</span>{main&&<span className={main.transferPolicy==='free'?'tag-free':'tag-restricted'}>{main.transferPolicy==='free'?'可交易':'新手赠送 · 仅自用'}</span>}</div>
      <div className="combat-attributes"><div><Heart size={18}/><span>生命</span><b>{stats.hp}</b></div><div><Swords size={18}/><span>攻击</span><b>{stats.attack}</b></div></div><dl className="combat-detail-stats"><div><dt>普攻射程</dt><dd>{stats.range} 格</dd></div><div><dt>护甲</dt><dd>{stats.armor}</dd></div><div><dt>法术抗性</dt><dd>{stats.resistance}</dd></div><div><dt>先手</dt><dd>{stats.speed}</dd></div><div><dt>双人局招募价</dt><dd>{[10,11,12,13,14][(main?.rank??1)-1]} 金币</dd></div></dl><div className="combat-skill"><strong><Sparkles size={14}/>{stats.skillName}</strong><p>{stats.skillDescription}</p></div>
      {page!=='forge'?<>{forgeQualitySelector}<div className="minor-actions"><button className="secondary-button" onClick={confirmForge} disabled={busy||!!forgeReason} title={forgeReason||'同名同品质卡合成升阶'}><ArrowUp size={16}/>品质合成</button><button className="secondary-button" onClick={confirmRecycle} disabled={busy||recyclableCount<1||selectedLocked} title="回收多余的微光（Q1）卡"><Recycle size={16}/>回收</button></div>{forgeReason&&main&&<p className="fineprint centered">{forgeReason}</p>}<button className="dark-button" onClick={()=>go(main?'battle':'summon')}>{main?'前往组队':'前往抽卡'}<ArrowRight size={16}/></button><button className="text-button combat-trade-link" onClick={()=>go('community')}>市场交易 / 赠送好友<Users size={13}/></button></>:forgeMode==='quality'?<>{forgeQualitySelector}<div className="craft-cost"><span>合成消耗</span><strong><Coins size={18}/>{forgeCost}<small>星币 + 2 张{main?qualityName(forgeRank):'同名'}材料</small></strong></div><div className="minor-actions"><button className="gold-button" onClick={confirmForge} disabled={busy||!!forgeReason} title={forgeReason||'同名同品质卡合成升阶'}><ArrowUp size={16}/>{main&&main.rank>=QUALITY_TIERS.length?'已到最高品质':'品质合成'}<ArrowRight size={16}/></button></div>{forgeReason&&main&&<p className="fineprint centered">{forgeReason}</p>}</>:<><div className="craft-cost"><span>{forgeMode==='craft'?'制作消耗':'回收获得'}</span><strong><Coins size={20}/>{forgeMode==='craft'?ECONOMY.craftCost:ECONOMY.recycleReturn}</strong><small>{forgeMode==='craft'?'获得 1 张微光（Q1）卡牌':'回收 1 张多余微光卡'}</small></div><button className="gold-button" disabled={busy||(forgeMode==='craft'?(game!.coins<ECONOMY.craftCost||!main):recyclableCount<1||selectedLocked)} onClick={forgeMode==='craft'?confirmCraft:confirmRecycle}>{forgeMode==='craft'?'制作这张卡':'回收多余卡'}<ArrowRight size={16}/></button></>}
      </aside>}</div>}
      {page==='battle'&&(snapshot?.match?.status==='playing'
        // 存续兼容：仅有“进行中”的旧单人局继续用旧界面按冻结规则收尾；
        // 不再从 UI 新开旧 PvE——主对战入口直接进入双人对战房间（无模式选择器）。
        ? <MatchArena key={auth?.user?.id} match={snapshot?.match??null} busy={busy} cards={cards} onCommand={async(action,args)=>!!(await command(action,args))} onRefresh={()=>refreshGame()} onBack={()=>go('collection')}/>
        // onBack：battle 沉浸页隐藏侧栏 / 顶栏，双人对战页必须有返回收藏的出口（不投降、不暂停房间）。
        : duelUser&&<DuelArena key={duelUser.id} userId={duelUser.id} cards={cards} onRewardClaimed={()=>void refreshGame(duelUser.id)} onBack={()=>go('collection')}/>)}
      {page==='community'&&auth?.user&&<Community key={auth.user.id} userId={auth.user.id} cards={cards} coins={game!.coins} restrictedCoins={game!.restrictedCoins} onRefresh={()=>refreshGame()}/>}
      {page==='summon'&&game&&<section className="summon-screen"><div className="summon-scenery"/><div className="summon-heading"><span className="eyebrow">PERMANENT SUMMON · 常驻卡池</span><h1>星野初逢</h1><p>{pendingDraw?'完成这次三选一，再开始下一次抽取。':drawResults.length?(drawView!.mode==='ten'?'十连完成，十张卡已入库。':'已加入收藏。'):'下一位伙伴，就在这片星光里。'}</p></div>
      {starterPending?<div className="starter-picker"><h2>选择你的本命星灵</h2><p className="fineprint">领取 23 张新手礼包（本命 Q3 ×1 + 支援 Q2 ×4 + 素材 Q1 ×18）与 {ECONOMY.starterCoins} 星币；每账号仅一次。</p><div className="card-grid starter-grid">{CARDS.map(def=><div className="card-item" key={def.id}><Card def={def} card={previewCard(def.id)} selected={starterPick===def.id} actionLabel="选为本命候选" onClick={()=>{setStarterPick(def.id);playSound('select');}}/><div className="card-meta"><span>本命候选</span></div></div>)}</div>
        {starterPick&&(()=>{const pick=CARD_MAP[starterPick];const pickStats=getCombatStats(previewCard(starterPick));return <div className="starter-preview" aria-label="本命候选详情"><div><b>{pick.name}</b><span>{pickStats.role} · {AFFINITIES[pick.affinity].name}系 · 生命 {pickStats.hp} · 攻击 {pickStats.attack} · 射程 {pickStats.range} 格</span></div><p><b>{pickStats.skillName}</b>{pickStats.skillDescription}</p></div>;})()}
        {starterPick&&<button className="gold-button summon-button" onClick={()=>confirmStarter(starterPick)}><span>以 {CARD_MAP[starterPick]?.name} 为本命领取<small>23 张卡 + {ECONOMY.starterCoins} 星币（自用来源）</small></span><ArrowRight size={20}/></button>}</div>
      :pendingDraw?<div className={'summon-stage has-results'}><div className="summon-note choice-note"><Sparkles size={15}/><span>三选一：三位候选品质相同（{qualityName(pendingDraw.candidates[0]?.rank??1)}），最终只会获得你选择的一张</span></div>{pendingDraw.candidates.map(candidate=><div key={candidate.candidateId} className="summon-result"><Card def={CARD_MAP[candidate.defId]} card={previewCard(candidate.defId,candidate.rank)} actionLabel="选择这张卡" onClick={()=>{setDialog({title:'选择这张卡？',label:'确认获得',content:<><div className="combat-confirm-card"><img src={'/art/'+(CARD_MAP[candidate.defId]?.art??'moon-fawn')+'.png'} alt=""/><div><b>{CARD_MAP[candidate.defId]?.name??candidate.defId}</b><span>{qualityName(candidate.rank)}品质 · 未选的两位候选不会入库</span></div></div><p className="fineprint">订单已扣费，选择后立即生效；刷新页面不会丢失这次选择。</p></>,action:async()=>{await doClaimDraw(candidate.candidateId);return true;}});}}/><span className="summon-result-quality" data-quality={candidate.rank}>{qualityName(candidate.rank)}</span><span className="summon-result-label">候选 · 点击选择</span></div>)}</div>
      :drawResults.length?<div className={'summon-stage has-results'} key={revealKey}>{drawResults.map((draw,index)=><div key={index} className={'summon-result '+(revealing?'revealing':'')} style={{'--delay':index*90+'ms'} as CSSProperties}><Card def={CARD_MAP[draw.defId]??CARDS[0]} card={previewCard(draw.defId,draw.rank)} onClick={()=>inspect(draw.defId)}/><span className="summon-result-quality" data-quality={draw.rank}>{qualityName(draw.rank)}</span><span className="summon-result-label">{draw.restricted?'已入库 · 仅自用':'已加入收藏'}</span></div>)}</div>
      :<div className="summon-stage"><div className="featured-side left"><img src="/art/forest-rabbit.png" alt=""/></div><div className="featured-main"><Card def={CARDS[0]} card={previewCard(CARDS[0].id)} onClick={()=>inspect(CARDS[0].id)}/><span className="featured-label">星序常驻卡池</span></div><div className="featured-side right"><img src="/art/sun-fox.png" alt=""/></div></div>}
      {!starterPending&&!pendingDraw&&<div className="summon-bottom"><div className="summon-actions"><button className="gold-button summon-button" onClick={()=>void doSingleDraw()} disabled={busy||revealing||game.coins<ECONOMY.singleDrawCost}><Compass size={22}/><span>单抽 · 三选一<small>{ECONOMY.singleDrawCost} 星币 · 更容易找到喜欢的卡</small></span><ArrowRight size={20}/></button><button className="gold-button summon-button ten" onClick={()=>void doTenDraw()} disabled={busy||revealing||game.coins<ECONOMY.tenDrawCost}><Sparkles size={22}/><span>十连 · 直接十张<small>{ECONOMY.tenDrawCost} 星币 · 快速积累，无折扣无保底</small></span><ArrowRight size={20}/></button></div><div className="summon-note"><Sparkles size={15}/><span>{paymentPreview(ECONOMY.singleDrawCost)?'⚠ 当前设置会动用赠送额度：抽到的卡仅可自用':'品质概率每张相同：'+QUALITY_ODDS_NOTE}</span><label className="payment-toggle" title="允许动用新手赠送额度时，产物将不可交易"><input type="checkbox" checked={allowRestricted} onChange={event=>setAllowRestricted(event.target.checked)}/>允许使用赠送额度</label></div><button className="text-button" onClick={()=>setDialog({title:'卡池与规则',content:<div className="help-copy"><p>单抽 {ECONOMY.singleDrawCost} 星币：先抽一个品质，再给 3 个同品质不同卡种候选，最终只获得你选择的一张——更适合定向收集。十连 {ECONOMY.tenDrawCost} 星币：一次直接获得 10 张（卡种全池均匀、品质独立），没有额外折扣或保底。同单位价格下连续单抽更容易找到指定卡。</p><p>品质概率（每张）</p><div className="odds">{QUALITY_TIERS.map(tier=><span key={tier.level}>{tier.name} <b>{QUALITY.summonQuality[tier.level-1]}%</b></span>)}</div><p>所有卡种没有稀有度之分，获得概率完全相同；区别只在职业、技能与属性。</p><p className="fineprint">服务器抽取，无真实充值。待选订单断线可恢复，不会因刷新丢失。</p></div>})}>卡池与规则说明<ChevronDown size={12}/></button></div>}
      </section>}
      </>}
    </main></div>{toast&&<div className="toast" role="status" aria-live="polite"><Sparkles size={16}/><span>{toast}</span><button onClick={()=>setToast('')} aria-label="关闭提示"><X size={14}/></button></div>}
    {forgeOutcome&&<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setForgeOutcome(null);}}><div className="modal forge-result" role="dialog" aria-modal="true" aria-label="品质合成结果">
      <button className="icon-button close-modal" onClick={()=>setForgeOutcome(null)} aria-label="关闭"><X size={19}/></button>
      <Crest small/>
      <h2>{forgeOutcome.branch==='upgrade_two'?'罕见的飞跃！':forgeOutcome.branch==='upgrade_one'?'品质提升成功':'合成失败'}</h2>
      <div className="modal-body">
        <div className="combat-confirm-card" data-quality={forgeOutcome.to}><img src={'/art/'+(CARD_MAP[forgeOutcome.defId]?.art??'moon-fawn')+'.png'} alt=""/><div>
          <b>{forgeOutcome.branch==='fail'?qualityName(forgeOutcome.from)+'（未降级）':<>{qualityName(forgeOutcome.from)} <ArrowRight size={14}/> {qualityName(forgeOutcome.to)}</>}</b>
          <span>{CARD_MAP[forgeOutcome.defId]?.name??forgeOutcome.defId}</span>
          {forgeOutcome.branch==='fail'&&<span>随机返还 {forgeOutcome.returnedUids.length} 张材料卡（保留原卡与来源）</span>}
          {forgeOutcome.branch!=='fail'&&<span>消耗 2 张材料 · {forgeOutcome.coins} 星币{forgeOutcome.restricted?' · 结果仅可自用':''}</span>}
        </div></div>
        <p className="fineprint">{forgeOutcome.branch==='upgrade_two'?'一次连升两个品质，星野眷顾。':forgeOutcome.branch==='upgrade_one'?'主卡品质提升，材料已消耗。':'主卡保留、品质与来源不变；材料按规则随机返还，星币不退。结果已由服务器记录，重试不会重抽。'}</p>
      </div>
      <button className="dark-button modal-done" onClick={()=>setForgeOutcome(null)}>知道了<Check size={15}/></button>
    </div></div>}
    {dialog&&<Confirmation dialog={dialog} busy={busy} onClose={()=>{if(!busy)setDialog(null);}}/>}
  </div>;
}
