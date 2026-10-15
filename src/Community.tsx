import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,Coins,Copy,Gift,Globe,LoaderCircle,MessageCircle,Plus,RefreshCw,Search,Send,ShoppingBag,Users,X} from 'lucide-react';
import {AFFINITIES,CARD_MAP,qualityName,QUALITY_TIERS} from './data';
import type {OwnedCardV2 as OwnedCard} from './engine';
import {getCombatStats} from './battle';
import './community.css';

type Person={id:string;code:string;name:string};
type SocialSnapshot={self:Person;friends:Person[];incoming:Person[];outgoing:Person[]};
type ChatMessage={id:string;senderId:string;senderName:string;text:string;at:number};
type Listing={id:string;sellerId:string;sellerName:string;card:OwnedCard;price:number;createdAt:string};
type RecentTrade={id:string;card:OwnedCard;price:number;closedAt:string};
type MarketHistory={id:string;type:'buy'|'sell'|'cancel';card:OwnedCard;price:number;fee:number;at:string};
type CardQuote={defId:string;rank:number;activeCount:number;lowestPrice:number|null;lastPrice:number|null;medianPrice7d:number|null;sales7d:number};
type MarketSnapshot={listings:Listing[];mine:Listing[];page?:number;pageSize?:number;total?:number;feePercent?:number;stats?:{activeListings:number;sellers:number;trades24h:number;volume24h:number};quote?:{lowestPrice:number|null;medianPrice24h:number|null;lastPrice:number|null;sales24h:number};recentTrades?:RecentTrade[];history?:MarketHistory[];quotes?:CardQuote[]};
type MarketFilters={search:string;affinity:string;role:string;rank:string;minPrice:string;maxPrice:string};
const CLEAR_FILTERS:MarketFilters={search:'',affinity:'',role:'',rank:'',minPrice:'',maxPrice:''};
export function selectCardQuote(snapshot:MarketSnapshot,card:OwnedCard|undefined){return card?snapshot.quotes?.find(quote=>quote.defId===card.defId&&quote.rank===card.rank):undefined;}
export function marketQueryString(filters:MarketFilters,scope:string,sort:string,page:number){const params=new URLSearchParams();for(const [key,value] of Object.entries(filters)){const clean=value.trim();if(clean)params.set(key,clean);}params.set('scope',scope==='mine'?'mine':'all');params.set('sort',sort);params.set('page',String(scope==='history'?1:page));return params.toString();}
type AccountMarketSnapshot={actor:string;value:MarketSnapshot};
type ChatSnapshot={actor:string;channel:string;messages:ChatMessage[]};
const EMPTY_MESSAGES:ChatMessage[]=[];
const EMPTY_MARKET:MarketSnapshot={listings:[],mine:[]};
export function selectChatMessages(snapshot:ChatSnapshot|null,actor:string,channel:string){return snapshot?.actor===actor&&snapshot.channel===channel?snapshot.messages:EMPTY_MESSAGES;}
export function selectMarketSnapshot(snapshot:AccountMarketSnapshot|null,actor:string){return snapshot?.actor===actor?snapshot.value:EMPTY_MARKET;}
type CommunityTab='market'|'gift'|'friends'|'chat';
type Confirmation={
  title:string;label:string;description:string;path:string;input:Record<string,unknown>;
  success:string;asset:boolean;card?:OwnedCard;details?:[string,string][];
};
export interface CommunityProps {userId:string;cards:OwnedCard[];coins:number;restrictedCoins:number;onRefresh:()=>void|Promise<void>}

const TABS=[{id:'market',name:'市场',Icon:ShoppingBag},{id:'gift',name:'赠送',Icon:Gift},{id:'friends',name:'好友',Icon:Users},{id:'chat',name:'聊天',Icon:MessageCircle}] as const;
const number=(value:number)=>value.toLocaleString('zh-CN');
const cardName=(card:OwnedCard)=>CARD_MAP[card.defId]?.name??'未知卡牌';
const marketValue=(value:number|null|undefined)=>value==null?'—':number(value);
const marketTime=(value:string)=>new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function cardRole(card:OwnedCard){try{return getCombatStats(card).role;}catch{return '—';}}
function requestId(){if(typeof crypto.randomUUID==='function')return crypto.randomUUID();return Array.from(crypto.getRandomValues(new Uint8Array(20)),value=>value.toString(16).padStart(2,'0')).join('');}
function messageOf(error:unknown){return error instanceof Error?error.message:'操作未完成，请重试';}
export async function communityRequest<T>(path:string,actorId:string,body?:Record<string,unknown>,signal?:AbortSignal):Promise<T>{
  const controller=new AbortController();let timedOut=false;
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)controller.abort();
  const timeout=setTimeout(()=>{timedOut=true;controller.abort();},12000);
  try{
    const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',signal:controller.signal,headers:{'X-Asteria-User':actorId,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json().catch(()=>{throw new Error('服务器响应无法读取，请刷新确认结果');});
    if(controller.signal.aborted)throw new DOMException('请求已取消','AbortError');
    if(!response.ok)throw new Error(response.status===401?'登录已过期，请重新登录':typeof data.error==='string'?data.error:'请求未完成，请重试');
    return data as T;
  }catch(error){
    if(signal?.aborted)throw error;
    if(timedOut)throw new Error('连接超时，请刷新确认结果，再决定是否重试');
    if(error instanceof TypeError)throw new Error('网络连接中断，请刷新确认结果');
    throw error;
  }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}

function CardPreview({card,compact=false}:{card:OwnedCard;compact?:boolean}){
  const def=CARD_MAP[card.defId];
  return <div className={'community-card-preview'+(compact?' compact':'')}>
    {def?<img src={'/art/'+def.art+'.png'} alt="" loading="lazy"/>:<span className="community-card-placeholder">?</span>}
    {card.transferPolicy==='starter_restricted'&&<span className="community-card-rarity">仅自用</span>}
    <span className="community-card-level">{qualityName(card.rank)}</span>
    <div className="community-card-caption"><strong>{cardName(card)}</strong><span>{def?AFFINITIES[def.affinity].name+'系':''} <i>·</i> {qualityName(card.rank)}品质</span></div>
  </div>;
}
function CardSelect({cards,value,onChange,id}:{cards:OwnedCard[];value:string;onChange:(value:string)=>void;id:string}){
  return <select id={id} value={value} onChange={event=>onChange(event.target.value)} disabled={!cards.length}>
    <option value="">选择一张卡牌</option>
    {cards.map(card=><option key={card.uid} value={card.uid}>{cardName(card)} · {qualityName(card.rank)}{card.transferPolicy==='starter_restricted'?' · 仅自用':''} · #{card.uid.slice(-6)}</option>)}
  </select>;
}
function MarketCardIdentity({card}:{card:OwnedCard}){const def=CARD_MAP[card.defId];return <div className="community-market-identity">{def&&<img src={'/art/'+def.art+'.png'} alt="" loading="lazy"/>}<span><strong>{cardName(card)}</strong><small>{def?AFFINITIES[def.affinity].name+'系':'—'} · {cardRole(card)}</small></span></div>;}
function ConfirmDialog({value,busy,error,onClose,onConfirm}:{value:Confirmation;busy:boolean;error:string;onClose:()=>void;onConfirm:()=>void}){
  const ref=useRef<HTMLDivElement>(null);const title=useId();const desc=useId();const closeRef=useRef(onClose);const busyRef=useRef(busy);
  closeRef.current=onClose;busyRef.current=busy;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;const root=document.getElementById('root');const previousInert=root?.inert??false;
    const overflow=document.body.style.overflow;if(root)root.inert=true;document.body.style.overflow='hidden';
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();if(!busyRef.current)closeRef.current();}
      if(event.key==='Tab'){
        const nodes=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),[href],input:not(:disabled),[tabindex="0"]')??[]);
        if(!nodes.length){event.preventDefault();ref.current?.focus();return;}
        if(event.shiftKey&&(!ref.current?.contains(document.activeElement)||document.activeElement===nodes[0])){event.preventDefault();nodes.at(-1)?.focus();}
        else if(!event.shiftKey&&(!ref.current?.contains(document.activeElement)||document.activeElement===nodes.at(-1))){event.preventDefault();nodes[0].focus();}
      }
    };
    document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('keydown',key);if(root)root.inert=previousInert;document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus();};
  },[]);
  return createPortal(<div className="community-modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}>
    <div className="community-modal" role="dialog" aria-modal="true" aria-labelledby={title} aria-describedby={desc} ref={ref} tabIndex={-1}>
      <button className="community-modal-close" aria-label="关闭确认" onClick={onClose} disabled={busy}><X size={20}/></button>
      <h2 id={title}>{value.title}</h2>
      {value.card&&<CardPreview card={value.card} compact/>}
      <p id={desc}>{value.description}</p>
      {!!value.details?.length&&<dl className="community-confirm-details">{value.details.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      {error&&<p className="community-error" role="alert">{error}</p>}
      <div className="community-modal-actions"><button className="community-button" disabled={busy} onClick={onClose}>取消</button><button className="community-button primary" disabled={busy} onClick={onConfirm}>{busy?<LoaderCircle size={16} className="community-spin"/>:null}{busy?'处理中…':value.label}</button></div>
    </div>
  </div>,document.body);
}

export function Community({userId,cards,coins,restrictedCoins,onRefresh}:CommunityProps){
  const [tab,setTab]=useState<CommunityTab>('market');
  const [social,setSocial]=useState<SocialSnapshot|null>(null);
  const [marketSnapshot,setMarketSnapshot]=useState<AccountMarketSnapshot|null>(null);
  const [chatSnapshot,setChatSnapshot]=useState<ChatSnapshot|null>(null);
  const [channel,setChannel]=useState('world');
  const [drafts,setDrafts]=useState<Record<string,string>>({});
  const [loading,setLoading]=useState(true);const [pollError,setPollError]=useState('');const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);const busyRef=useRef(false);
  const [nonce,setNonce]=useState(0);const mounted=useRef(true);
  const identityRef=useRef({userId});if(identityRef.current.userId!==userId)identityRef.current={userId};
  const identity=identityRef.current;const isCurrent=()=>mounted.current&&identityRef.current===identity;
  const [filters,setFilters]=useState<MarketFilters>(CLEAR_FILTERS);const [queryFilters,setQueryFilters]=useState<MarketFilters>(CLEAR_FILTERS);
  const [scope,setScope]=useState<'all'|'mine'|'history'>('all');const [sort,setSort]=useState('newest');
  const [marketView,setMarketView]=useState<'list'|'cards'>('list');const [page,setPage]=useState(1);
  const [listingUid,setListingUid]=useState('');const [price,setPrice]=useState('100');
  const [giftUid,setGiftUid]=useState('');const [giftCode,setGiftCode]=useState('');const [friendCode,setFriendCode]=useState('');
  const [confirm,setConfirm]=useState<Confirmation|null>(null);const [confirmError,setConfirmError]=useState('');
  const scrollRef=useRef<HTMLDivElement>(null);const stickBottom=useRef(true);const composerRef=useRef<HTMLTextAreaElement>(null);
  const prefix=useId();const refreshRef=useRef(onRefresh);refreshRef.current=onRefresh;
  const ownSocial=social?.self.id===userId?social:null;
  const market=selectMarketSnapshot(marketSnapshot,userId);
  const messages=selectChatMessages(chatSnapshot,userId,channel);
  const draft=drafts[channel]??'';
  const available=useMemo(()=>[...cards].sort((a,b)=>cardName(a).localeCompare(cardName(b),'zh-CN')||b.rank-a.rank||a.uid.localeCompare(b.uid)),[cards]);
  const tradable=useMemo(()=>available.filter(card=>card.transferPolicy!=='starter_restricted'),[available]);
  const spendable=Math.max(0,coins-restrictedCoins);
  const listingCard=cards.find(card=>card.uid===listingUid);
  const giftCard=cards.find(card=>card.uid===giftUid);
  const priceValue=Number(price);const validPrice=/^\d+$/.test(price)&&Number.isSafeInteger(priceValue)&&priceValue>=10&&priceValue<=100000;
  const listings=market.listings;
  const marketQuery=marketQueryString(queryFilters,scope,sort,page);
  const selectedQuote=selectCardQuote(market,listingCard);
  const history=market.history??[];const pageSize=market.pageSize??20;
  const total=scope==='history'?history.length:(market.total??listings.length);
  const pages=Math.max(1,Math.ceil(total/pageSize));
  const currentPage=scope==='history'?Math.min(page,pages):(market.page??page);
  const historyPage=history.slice((currentPage-1)*pageSize,currentPage*pageSize);
  const filterCount=Object.values(filters).filter(value=>value.trim()).length;
  function filterChange(key:keyof MarketFilters,value:string){setFilters(current=>({...current,[key]:value}));setPage(1);}
  function changeScope(next:'all'|'mine'|'history'){setScope(next);setPage(1);}
  useEffect(()=>{const timer=setTimeout(()=>setQueryFilters(filters),220);return()=>clearTimeout(timer);},[filters]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setSocial(null);setMarketSnapshot(null);setChatSnapshot(null);setDrafts({});setChannel('world');setConfirm(null);setError('');setNotice('');busyRef.current=false;setBusy(false);},[userId]);
  useEffect(()=>{if(listingUid&&!cards.some(card=>card.uid===listingUid))setListingUid('');if(giftUid&&!cards.some(card=>card.uid===giftUid))setGiftUid('');},[cards,listingUid,giftUid]);
  useEffect(()=>{
    let disposed=false;let running=false;let timer:ReturnType<typeof setTimeout>|undefined;let controller:AbortController|undefined;
    setLoading(true);setPollError('');
    const poll=async()=>{
      if(disposed||running||document.visibilityState!=='visible')return;
      running=true;controller=new AbortController();
      try{
        const snapshot=await communityRequest<SocialSnapshot>('/api/social',userId,undefined,controller.signal);
        if(disposed||controller.signal.aborted||!isCurrent())return;
        if(snapshot.self.id!==userId){setSocial(null);setMarketSnapshot(null);setChatSnapshot(null);throw new Error('账号已切换，请刷新游戏');}
        setSocial(snapshot);
        if(channel!=='world'&&!snapshot.friends.some(friend=>friend.id===channel)){setChannel('world');setChatSnapshot(null);return;}
        if(tab==='market'){
          const next=await communityRequest<MarketSnapshot>('/api/market?'+marketQuery,userId,undefined,controller.signal);
          if(!disposed&&!controller.signal.aborted&&isCurrent())setMarketSnapshot({actor:userId,value:next});
        }else if(tab==='chat'){
          const next=await communityRequest<{messages:ChatMessage[]}>('/api/chat?channel='+encodeURIComponent(channel),userId,undefined,controller.signal);
          if(!disposed&&!controller.signal.aborted&&isCurrent())setChatSnapshot({actor:userId,channel,messages:next.messages});
        }
        if(!disposed&&isCurrent())setPollError('');
      }catch(caught){if(!disposed&&!controller.signal.aborted&&isCurrent()){setPollError(messageOf(caught));setChatSnapshot(null);}}
      finally{running=false;if(!disposed&&isCurrent()){setLoading(false);if(document.visibilityState==='visible')timer=setTimeout(poll,3000);}}
    };
    const visibility=()=>{if(document.visibilityState==='visible')void poll();else{if(timer)clearTimeout(timer);controller?.abort();}};
    void poll();document.addEventListener('visibilitychange',visibility);
    return()=>{disposed=true;if(timer)clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visibility);};
  },[userId,tab,channel,nonce,marketQuery]);
  useEffect(()=>{stickBottom.current=true;setChatSnapshot(null);},[channel]);
  useEffect(()=>{const node=scrollRef.current;if(tab==='chat'&&node&&stickBottom.current)node.scrollTop=node.scrollHeight;},[messages,tab]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),6500);return()=>clearTimeout(timer);},[notice]);

  function changeTab(next:CommunityTab){setTab(next);setError('');setNotice('');}
  function openConfirmation(value:Confirmation){if(busyRef.current)return;setConfirmError('');setError('');setConfirm(value);}
  function begin(){if(busyRef.current||!isCurrent())return false;busyRef.current=true;setBusy(true);setError('');setNotice('');return true;}
  function end(){if(!isCurrent())return;busyRef.current=false;setBusy(false);}
  async function mutation(path:string,input:Record<string,unknown>,success:string,asset=false){
    if(!begin())return false;
    try{
      await communityRequest(path,userId,input);
      if(isCurrent()){setNotice(success);setNonce(value=>value+1);}
      if(asset&&isCurrent())try{await refreshRef.current();}catch{if(isCurrent())setError('操作已成功，但背包未刷新。请点击刷新，不要重复操作。');}
      return isCurrent();
    }catch(caught){if(isCurrent())setError(messageOf(caught));return false;}
    finally{end();}
  }
  async function confirmAction(){
    if(!confirm||!begin())return;setConfirmError('');
    const action=confirm;
    try{
      await communityRequest(action.path,userId,action.input);
      if(isCurrent()){setConfirm(null);setNotice(action.success);setNonce(value=>value+1);}
      if(action.asset&&isCurrent())try{await refreshRef.current();}catch{if(isCurrent())setError('操作已成功，但背包未刷新。请点击刷新，不要重复操作。');}
    }catch(caught){if(isCurrent())setConfirmError(messageOf(caught));}
    finally{end();}
  }
  function buy(listing:Listing){
    openConfirmation({title:'购买这张卡牌？',label:'确认购买',description:'付款后，卡牌会直接进入你的背包。',path:'/api/market/buy',input:{listingId:listing.id,requestId:requestId()},success:'购买成功，卡牌已进入背包',asset:true,card:listing.card,details:[['卖家',listing.sellerName],['支付',number(listing.price)+' 星币（仅普通额度）'],['购买后可用余额',number(spendable-listing.price)+' 星币']]});
  }
  function cancel(listing:Listing){
    openConfirmation({title:'撤下这张卡牌？',label:'确认撤单',description:'卡牌会按当前品质返回你的背包，不收取手续费。',path:'/api/market/cancel',input:{listingId:listing.id,requestId:requestId()},success:'已撤单，卡牌已返回背包',asset:true,card:listing.card});
  }
  function listCard(){
    if(!listingCard||!validPrice)return;
    if(listingCard.transferPolicy==='starter_restricted'){setError('新手赠送来源的卡仅可自用，不能上架交易');return;}
    openConfirmation({title:'上架这张卡牌？',label:'确认上架',description:'上架后由市场保管，售出前可以撤单。',path:'/api/market/list',input:{uid:listingCard.uid,price:priceValue,requestId:requestId()},success:'上架成功，卡牌已交给市场保管',asset:true,card:listingCard,details:[['售价',number(priceValue)+' 星币'],['成交手续费（5% 向上取整，至少 1）',number(Math.max(1,Math.ceil(priceValue*.05)))+' 星币'],['售出后到账',number(priceValue-Math.max(1,Math.ceil(priceValue*.05)))+' 星币']]});
  }
  function gift(){
    const code=giftCode.trim().toUpperCase();if(!giftCard||!/^AST-[A-F0-9]{8}$/.test(code))return;
    if(giftCard.transferPolicy==='starter_restricted'){setError('新手赠送来源的卡仅可自用，不能赠送');return;}
    const target=ownSocial?.friends.find(friend=>friend.code===code);
    openConfirmation({title:'确认赠送？',label:'确认送出',description:'赠送成功后不能撤回，请核对好友码。卡牌的品质会保留。',path:'/api/market/gift',input:{uid:giftCard.uid,toCode:code,requestId:requestId()},success:'赠送成功，卡牌已送到对方背包',asset:true,card:giftCard,details:[['接收玩家',target?.name??'以好友码为准'],['好友码',code]]});
  }
  function removeFriend(friend:Person){openConfirmation({title:'移除这位好友？',label:'移除好友',description:'移除后，双方将无法继续私聊。',path:'/api/social/friend.remove',input:{userId:friend.id},success:'已移除好友',asset:false,details:[['玩家',friend.name],['好友码',friend.code]]});}
  function chatWith(friend:Person){setChannel(friend.id);changeTab('chat');}
  async function sendMessage(){
    const text=draft.trim();const target=channel;if(!text||[...text].length>300)return;
    const success=await mutation('/api/social/chat.send',{channel:target,text},'');
    if(success&&isCurrent()){setDrafts(current=>current[target]===draft?{...current,[target]:''}:current);stickBottom.current=true;composerRef.current?.focus();}
  }
  async function copyCode(){if(!ownSocial)return;try{await navigator.clipboard.writeText(ownSocial.self.code);if(isCurrent())setNotice('好友码已复制');}catch{if(isCurrent())setError('无法自动复制，请长按或选中好友码复制');}}
  async function refresh(){
    setNonce(value=>value+1);setError('');
    try{await refreshRef.current();}catch(caught){if(isCurrent())setError(messageOf(caught));}
  }

  return <section className="community-panel" aria-labelledby={prefix+'-title'}>
    <header className="community-heading"><div><h1 id={prefix+'-title'}>{tab==='market'?'交易大厅':'社区'}</h1><p>{tab==='market'?'查看行情，找到合适的卡牌。':'交易卡牌，认识一起玩的朋友。'}</p></div><button className="community-button subtle" onClick={()=>void refresh()} disabled={busy} aria-label="刷新社区和背包"><RefreshCw size={15} className={loading?'community-spin':''}/><span>刷新</span></button></header>
    <nav className="community-tabs" aria-label="社区页面">{TABS.map(({id,name,Icon})=><button key={id} className={tab===id?'active':''} aria-pressed={tab===id} onClick={()=>changeTab(id)}><Icon size={17}/>{name}{id==='friends'&&!!ownSocial?.incoming.length&&<span className="community-count">{ownSocial.incoming.length}</span>}</button>)}</nav>
    {(error||pollError)&&<div className="community-error" role="alert">{error||pollError}</div>}
    {notice&&<div className="community-notice" role="status"><Check size={16}/>{notice}</div>}

    {tab==='market'&&<>
      <dl className="community-market-stats" aria-label="全市场实时数据">
        <div><dt>在售挂单</dt><dd>{marketValue(market.stats?.activeListings)}<small>张</small></dd></div>
        <div><dt>在售玩家</dt><dd>{marketValue(market.stats?.sellers)}<small>人</small></dd></div>
        <div><dt>24 小时成交</dt><dd>{marketValue(market.stats?.trades24h)}<small>笔</small></dd></div>
        <div><dt>24 小时成交额</dt><dd>{marketValue(market.stats?.volume24h)}<small>星币</small></dd></div>
      </dl>
      <div className="community-market-layout">
        <div className="community-market-main">
          <div className="community-market-tools"><div className="community-segment" aria-label="市场记录">
            <button aria-pressed={scope==='all'} className={scope==='all'?'active':''} onClick={()=>changeScope('all')}>全部挂单</button>
            <button aria-pressed={scope==='mine'} className={scope==='mine'?'active':''} onClick={()=>changeScope('mine')}>我的挂单 <span>{market.mine.length}/20</span></button>
            <button aria-pressed={scope==='history'} className={scope==='history'?'active':''} onClick={()=>changeScope('history')}>成交记录</button>
          </div><span className="community-balance" title={'星币 '+number(coins)+(restrictedCoins>0?'，其中 '+number(restrictedCoins)+' 为新手赠送额度（仅可自用，不能购买玩家挂单）':'')}><Coins size={16}/>{number(coins)}</span></div>

          {scope!=='history'&&<>
            <div className="community-market-filters" aria-label="市场筛选">
              <label className="community-search market-name"><Search size={15}/><input aria-label="搜索市场卡牌" maxLength={80} placeholder="搜索卡牌名称" value={filters.search} onChange={event=>filterChange('search',event.target.value)}/></label>
              <select aria-label="筛选属性" value={filters.affinity} onChange={event=>filterChange('affinity',event.target.value)}><option value="">全部属性</option><option value="moon">月系</option><option value="sun">日系</option><option value="forest">森系</option></select>
              <select aria-label="筛选职业" value={filters.role} onChange={event=>filterChange('role',event.target.value)}><option value="">全部职业</option>{['坦克','战士','射手','法师','刺客'].map(role=><option key={role} value={role}>{role}</option>)}</select>
              <select aria-label="筛选强化等级" value={filters.rank} onChange={event=>filterChange('rank',event.target.value)}><option value="">全部品质</option>{QUALITY_TIERS.map(tier=><option key={tier.level} value={String(tier.level)}>{tier.name}（Q{tier.level}）</option>)}</select>
              <label className="community-price-range"><span className="community-sr-only">最低价格</span><input aria-label="最低价格" inputMode="numeric" type="number" min="0" max="100000" placeholder="最低价" value={filters.minPrice} onChange={event=>filterChange('minPrice',event.target.value)}/><i>—</i><input aria-label="最高价格" inputMode="numeric" type="number" min="0" max="100000" placeholder="最高价" value={filters.maxPrice} onChange={event=>filterChange('maxPrice',event.target.value)}/></label>
              <button className="community-button subtle" onClick={()=>{setFilters(CLEAR_FILTERS);setPage(1);}} disabled={!filterCount}>清空筛选{filterCount?' · '+filterCount:''}</button>
            </div>
            <div className="community-market-quote-strip" aria-label="全市场同类卡牌报价，不受价格区间限制" title="按当前卡牌条件统计全市场，不受价格区间和我的挂单限制">
              <span>全市场同类行情</span><span>最低挂牌 <b>{marketValue(market.quote?.lowestPrice)}</b></span><span>最近成交 <b>{marketValue(market.quote?.lastPrice)}</b></span><span>24h 中位价 <b>{marketValue(market.quote?.medianPrice24h)}</b></span>
            </div>
          </>}
          <div className="community-market-results">
            <span>{scope==='history'?'个人最近 30 条交易 / 撤单记录':loading?'正在更新…':'共 '+number(total)+' 条挂单'}</span>
            {scope!=='history'&&<div><select aria-label="市场排序" value={sort} onChange={event=>{setSort(event.target.value);setPage(1);}}><option value="newest">最新上架</option><option value="oldest">挂牌最久</option><option value="low">价格从低到高</option><option value="high">价格从高到低</option><option value="level">品质从高到低</option></select><div className="community-view-switch" aria-label="展示方式"><button aria-pressed={marketView==='list'} className={marketView==='list'?'active':''} onClick={()=>setMarketView('list')}>列表</button><button aria-pressed={marketView==='cards'} className={marketView==='cards'?'active':''} onClick={()=>setMarketView('cards')}>卡片</button></div></div>}
          </div>
          {scope==='mine'&&<p className="community-hint">挂单由市场保管，撤单后返回背包；只有成交才收取 5% 卖家手续费。</p>}

          {scope==='history'?(historyPage.length?<div className="community-table-scroll" tabIndex={0}><table className="community-market-table"><caption className="community-sr-only">我的成交和撤单记录</caption><thead><tr><th>卡牌</th><th>类型</th><th>品质</th><th className="numeric">成交价</th><th className="numeric">手续费</th><th>时间</th></tr></thead><tbody>{historyPage.map(entry=><tr key={entry.id}><td><MarketCardIdentity card={entry.card}/></td><td><span className={'community-trade-kind '+entry.type}>{entry.type==='buy'?'买入':entry.type==='sell'?'卖出':'撤单'}</span></td><td><span className="community-table-level">{qualityName(entry.card.rank)}</span></td><td className="numeric"><strong>{entry.type==='cancel'?'—':number(entry.price)}</strong></td><td className="numeric">{entry.type==='sell'?number(entry.fee):'—'}</td><td className="community-table-time">{marketTime(entry.at)}</td></tr>)}</tbody></table></div>:<div className="community-empty"><ShoppingBag size={30}/><h3>还没有成交记录</h3><p>你的买入、卖出与撤单记录会显示在这里。</p></div>):listings.length?marketView==='list'?<div className="community-table-scroll" tabIndex={0} aria-busy={loading}><table className="community-market-table"><caption className="community-sr-only">{scope==='mine'?'我的在售卡牌':'市场在售卡牌'}</caption><thead><tr><th>卡牌 / 属性 / 职业</th><th>品质</th><th>卖家</th><th className="numeric">售价</th><th>挂牌时间</th><th className="action">操作</th></tr></thead><tbody>{listings.map(listing=><tr key={listing.id}><td><MarketCardIdentity card={listing.card}/></td><td><span className="community-table-level">{qualityName(listing.card.rank)}</span></td><td><span className="community-table-seller" title={listing.sellerName}>{listing.sellerId===userId?'我 · ':''}{listing.sellerName}</span></td><td className="numeric"><strong className="community-table-price">{number(listing.price)}</strong></td><td className="community-table-time">{marketTime(listing.createdAt)}</td><td className="action">{listing.sellerId===userId?<button className="community-button small" onClick={()=>cancel(listing)} disabled={busy}>撤单</button>:<button className="community-button primary small" disabled={busy||spendable<listing.price} onClick={()=>buy(listing)}>{spendable<listing.price?'交易余额不足':'买入'}</button>}</td></tr>)}</tbody></table></div>:<div className="community-listings compact-market" aria-busy={loading}>{listings.map(listing=><article className="community-listing" key={listing.id}><CardPreview card={listing.card}/><div className="community-listing-info"><p className="community-seller">卖家 <strong title={listing.sellerName}>{listing.sellerName}</strong>{listing.sellerId===userId&&<small>我</small>}</p><div className="community-card-market-meta"><span>{cardRole(listing.card)}</span><time>{marketTime(listing.createdAt)}</time></div><div className="community-listing-bottom"><span className="community-price"><Coins size={15}/>{number(listing.price)}</span>{listing.sellerId===userId?<button className="community-button small" onClick={()=>cancel(listing)} disabled={busy}>撤单</button>:<button className="community-button primary small" disabled={busy||spendable<listing.price} onClick={()=>buy(listing)}>{spendable<listing.price?'交易余额不足':'买入'}</button>}</div></div></article>)}</div>:<div className="community-empty"><ShoppingBag size={30}/><h3>{loading?'正在读取市场…':filterCount?'没有符合条件的挂单':'还没有挂单'}</h3><p>{filterCount?'试试放宽筛选条件。':scope==='mine'?'选择一张卡牌，设置价格后上架。':'上架你的卡牌，等待其他玩家购买。'}</p>{!!filterCount&&<button className="community-button" onClick={()=>{setFilters(CLEAR_FILTERS);setPage(1);}}>清空筛选</button>}</div>}

          <div className="community-pagination" aria-label="市场分页"><span>{number(total)} 条{scope==='history'?'记录':'结果'} · 每页 {pageSize} 条</span><div><button className="community-button small" disabled={loading||currentPage<=1} onClick={()=>setPage(currentPage-1)}>上一页</button><span>{currentPage} / {pages}</span><button className="community-button small" disabled={loading||currentPage>=pages} onClick={()=>setPage(currentPage+1)}>下一页</button></div></div>
          {scope!=='history'&&<section className="community-recent-trades"><div><h3>最近成交</h3><span>匹配当前卡牌筛选，不受价格区间限制</span></div>{market.recentTrades?.length?<div className="community-recent-trade-list">{market.recentTrades.slice(0,5).map(trade=><div key={trade.id}><span>{cardName(trade.card)} <small>{qualityName(trade.card.rank)}</small></span><strong>{number(trade.price)} <small>星币</small></strong><time>{marketTime(trade.closedAt)}</time></div>)}</div>:<p>暂无匹配的成交数据</p>}</section>}
          <p className="community-hint community-market-footnote">每 3 秒同步服务器。报价只来自真实挂单和成交，无记录时显示「—」。</p>
        </div>

        <aside className="community-trade-form">
          <div className="community-sell-heading"><h2>卖出卡牌</h2><span>{market.mine.length} / 20 挂单</span></div>
          <p className="community-hint">选卡、参考行情，再设置你的价格。新手赠送来源的卡仅可自用，不能上架。</p>
          <form onSubmit={event=>{event.preventDefault();listCard();}}>
            <label htmlFor={prefix+'-list-card'}>选择卡牌</label><CardSelect cards={tradable} value={listingUid} onChange={setListingUid} id={prefix+'-list-card'}/>
            {listingCard&&<><CardPreview card={listingCard} compact/><section className="community-sell-quote" aria-label="同卡同等级行情"><h3>同卡 · 同品质行情 <small>{qualityName(listingCard.rank)}（Q{listingCard.rank}）</small></h3><dl><div><dt>在售数量</dt><dd>{selectedQuote?number(selectedQuote.activeCount):'—'}</dd></div><div><dt>最低挂牌</dt><dd>{marketValue(selectedQuote?.lowestPrice)}</dd></div><div><dt>最近成交</dt><dd>{marketValue(selectedQuote?.lastPrice)}</dd></div><div><dt>7 天成交中位价</dt><dd>{marketValue(selectedQuote?.medianPrice7d)}</dd></div><div><dt>7 天成交笔数</dt><dd>{selectedQuote?number(selectedQuote.sales7d):'—'}</dd></div></dl>{!selectedQuote&&<p>这张卡暂时没有报价或成交记录。</p>}{selectedQuote?.lowestPrice!=null&&<button type="button" className="community-button subtle small" onClick={()=>setPrice(String(selectedQuote.lowestPrice))}>按最低挂牌价填入</button>}</section></>}
            <label htmlFor={prefix+'-price'}>售价 <span>10–100,000 星币</span></label><div className="community-price-input"><Coins size={17}/><input id={prefix+'-price'} type="number" min="10" max="100000" step="1" inputMode="numeric" required value={price} onChange={event=>setPrice(event.target.value)}/></div>
            <div className="community-sell-fees"><span>卖家手续费（5% 向上取整，至少 1）<b>{validPrice?number(Math.max(1,Math.ceil(priceValue*.05))):'—'}</b></span><span>预计净到账<strong>{validPrice?number(priceValue-Math.max(1,Math.ceil(priceValue*.05))):'—'} <small>星币</small></strong></span></div>
            <button className="community-button primary full" type="submit" disabled={busy||!listingCard||!validPrice||market.mine.length>=20}><Plus size={16}/>{market.mine.length>=20?'已达到 20 条挂单上限':'确认上架'}</button>
            <p className="community-hint">{cards.length?'上架后卡牌由市场保管；出售永久卡，不影响本局已招募的副本。':'背包里还没有可出售的卡牌。'}</p>
          </form>
        </aside>
      </div>
    </>}

    {tab==='gift'&&<div className="community-gift-layout">
      <div className="community-gift-preview">{giftCard?<CardPreview card={giftCard}/>:<><Gift size={56}/><h2>送一张卡给朋友</h2><p>品质保留，直接到达对方背包。</p></>}</div>
      <form className="community-gift-form" onSubmit={event=>{event.preventDefault();gift();}}>
        <h2>赠送卡牌</h2><label htmlFor={prefix+'-gift-card'}>送出哪张卡？</label><CardSelect cards={tradable} value={giftUid} onChange={setGiftUid} id={prefix+'-gift-card'}/>
        {!!ownSocial?.friends.length&&<><label htmlFor={prefix+'-gift-friend'}>从好友中选择</label><select id={prefix+'-gift-friend'} value={ownSocial.friends.some(friend=>friend.code===giftCode)?giftCode:''} onChange={event=>setGiftCode(event.target.value)}><option value="">选择好友，或直接输入好友码</option>{ownSocial.friends.map(friend=><option key={friend.id} value={friend.code}>{friend.name} · {friend.code}</option>)}</select></>}
        <label htmlFor={prefix+'-gift-code'}>对方好友码</label><input id={prefix+'-gift-code'} placeholder="AST-XXXXXXXX" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={12} required value={giftCode} onChange={event=>setGiftCode(event.target.value.toUpperCase())}/>
        <p className="community-hint">赠送不能撤回。新手赠送来源的卡仅可自用，不能赠送；本局已招募的副本不受影响。</p>
        <button className="community-button primary full" type="submit" disabled={busy||!giftCard||!/^AST-[A-F0-9]{8}$/.test(giftCode.trim())||giftCode.trim()===ownSocial?.self.code}><Gift size={16}/>核对并赠送</button>
        {!cards.length&&<p className="community-hint">背包里还没有可以赠送的卡牌。</p>}
      </form>
    </div>}

    {tab==='friends'&&<div className="community-friends-layout">
      <aside className="community-friend-tools"><h2>我的好友码</h2><p className="community-hint">把这串编号发给朋友，让对方添加你。</p><div className="community-own-code"><code>{ownSocial?.self.code??'读取中…'}</code><button className="community-button subtle" disabled={!ownSocial} onClick={()=>void copyCode()} aria-label="复制我的好友码"><Copy size={17}/></button></div>
        <form onSubmit={async event=>{event.preventDefault();if(await mutation('/api/social/friend.request',{code:friendCode.trim().toUpperCase()},'好友申请已发送'))setFriendCode('');}}><label htmlFor={prefix+'-friend-code'}>添加好友</label><input id={prefix+'-friend-code'} value={friendCode} onChange={event=>setFriendCode(event.target.value.toUpperCase())} placeholder="AST-XXXXXXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={12} required/><button className="community-button primary full" type="submit" disabled={busy||!/^AST-[A-F0-9]{8}$/.test(friendCode.trim())}><Plus size={16}/>发送申请</button></form>
      </aside>
      <div className="community-friend-lists">
        {!!ownSocial?.incoming.length&&<section><h2>收到的申请 <small>{ownSocial.incoming.length}</small></h2>{ownSocial.incoming.map(person=><div className="community-person" key={person.id}><span className="community-avatar">{person.name.slice(0,1)}</span><div><strong>{person.name}</strong><code>{person.code}</code></div><div className="community-person-actions"><button className="community-button primary small" disabled={busy} onClick={()=>void mutation('/api/social/friend.accept',{userId:person.id},'已成为好友')}>接受</button><button className="community-button small" disabled={busy} onClick={()=>void mutation('/api/social/friend.decline',{userId:person.id},'已忽略申请')}>忽略</button></div></div>)}</section>}
        <section><h2>我的好友 <small>{ownSocial?.friends.length??0}/200</small></h2>{ownSocial?.friends.length?ownSocial.friends.map(person=><div className="community-person" key={person.id}><span className="community-avatar">{person.name.slice(0,1)}</span><div><strong>{person.name}</strong><code>{person.code}</code></div><div className="community-person-actions"><button className="community-button small" onClick={()=>chatWith(person)}><MessageCircle size={14}/>私聊</button><button className="community-button small" onClick={()=>{setGiftCode(person.code);changeTab('gift');}}>赠送</button><button className="community-button subtle small" aria-label={'移除好友 '+person.name} onClick={()=>removeFriend(person)} disabled={busy}><X size={15}/></button></div></div>):<div className="community-empty compact"><Users size={28}/><p>{loading&&!ownSocial?'正在读取好友…':'还没有好友，输入对方好友码试试。'}</p></div>}</section>
        {!!ownSocial?.outgoing.length&&<section><h2>发出的申请 <small>{ownSocial.outgoing.length}</small></h2>{ownSocial.outgoing.map(person=><div className="community-person" key={person.id}><span className="community-avatar">{person.name.slice(0,1)}</span><div><strong>{person.name}</strong><code>{person.code}</code></div><span className="community-pending">等待对方接受</span></div>)}</section>}
      </div>
    </div>}

    {tab==='chat'&&<div className="community-chat-layout">
      <aside className="community-channel-list" aria-label="聊天频道"><button className={channel==='world'?'active':''} aria-pressed={channel==='world'} onClick={()=>setChannel('world')}><Globe size={18}/><span>世界频道<small>所有玩家可见</small></span></button><h3>好友私聊</h3>{ownSocial?.friends.map(person=><button key={person.id} className={channel===person.id?'active':''} aria-pressed={channel===person.id} onClick={()=>setChannel(person.id)}><span className="community-avatar">{person.name.slice(0,1)}</span><span>{person.name}</span></button>)}{!ownSocial?.friends.length&&<p className="community-hint">添加好友后即可私聊。</p>}</aside>
      <div className="community-chat-main">
        <header className="community-chat-heading"><div><h2>{channel==='world'?'世界频道':ownSocial?.friends.find(friend=>friend.id===channel)?.name??'好友私聊'}</h2><p>{channel==='world'?'公开聊天，请勿发送个人隐私。':'仅你和这位好友可以查看。'}</p></div><small>最近 50 条</small></header>
        <div className="community-messages" ref={scrollRef} role="log" aria-label="聊天记录" aria-live="off" onScroll={event=>{const node=event.currentTarget;stickBottom.current=node.scrollHeight-node.scrollTop-node.clientHeight<70;}}>
          {messages.length?messages.map(message=><article key={message.id} className={'community-message'+(message.senderId===userId?' own':'')}><div className="community-message-meta"><strong>{message.senderName}{message.senderId===userId?'（我）':''}</strong><time dateTime={new Date(message.at).toISOString()}>{new Date(message.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time></div><p>{message.text}</p></article>):<div className="community-empty compact"><MessageCircle size={30}/><p>{loading?'正在读取消息…':'还没有消息，打个招呼吧。'}</p></div>}
        </div>
        <form className="community-composer" onSubmit={event=>{event.preventDefault();void sendMessage();}}>
          <label className="community-sr-only" htmlFor={prefix+'-message'}>发送到{channel==='world'?'世界频道':'好友私聊'}</label>
          <textarea ref={composerRef} id={prefix+'-message'} rows={3} placeholder="输入消息…" value={draft} onChange={event=>setDrafts(current=>({...current,[channel]:event.target.value}))} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();if(!busy)void sendMessage();}}}/>
          <div><small className={[...draft].length>300?'over-limit':''}><span>Enter 发送 · Shift + Enter 换行</span>{[...draft].length}/300</small><button className="community-button primary" type="submit" disabled={busy||!draft.trim()||[...draft.trim()].length>300}><Send size={15}/>{busy?'发送中…':'发送'}</button></div>
        </form>
      </div>
    </div>}
    {confirm&&<ConfirmDialog value={confirm} busy={busy} error={confirmError} onClose={()=>{if(!busyRef.current)setConfirm(null);}} onConfirm={()=>void confirmAction()}/>}
  </section>;
}
export default Community;
