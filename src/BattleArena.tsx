import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowRight, ArrowRightLeft, Check, ChevronDown, Crosshair, Heart, Leaf, LoaderCircle, Moon, Pause, Play, Plus, RotateCcw, Search, Shield, SkipForward, Sparkles, Sun, Sword, Trophy, Users, WandSparkles, X, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AFFINITIES, CARD_MAP, qualityName } from './data';
import { slotToCell, cellCenter, hexDistance } from './hex';
import type { Affinity } from './data';
import type { OwnedCard } from './engine';
import { getCombatStats, getSynergies } from './battle';
import type { BattleAction, BattleLog, BattleState, CombatRole, CombatUnit } from './battle';
import { playSound } from './audio';
import './battle.css';

export type ArenaCard = OwnedCard & { stars?: 1 | 2 | 3 };
export interface BattleArenaProps {
  cards: ArenaCard[];
  formation?: {uid: string; slot: number}[];
  onFormationChange?: (formation: {uid: string; slot: number}[]) => void;
  maxUnits?: number;
  startLabel?: string;
  startDisabled?: boolean;
  replayOnly?: boolean;
  replayDurationMs?: number;
  embedded?: boolean;
  rosterMode?: 'collection' | 'match';
  onSellUnit?: (uid: string) => void;
  battle: BattleState | null;
  busy: boolean;
  onStart: (uids: string[], slots?: number[]) => void | Promise<void | boolean>;
  onAction: (action: BattleAction) => void | Promise<void | boolean>;
  onAbandon: () => void | Promise<void | boolean>;
}
const ROLE_ICONS: Record<CombatRole, LucideIcon> = { 坦克: Shield, 战士: Sword, 射手: Crosshair, 法师: Sparkles, 刺客: Zap };
const EMPTY_SLOTS: (string | null)[] = Array.from({ length: 28 }, () => null);
const FRONT_ORDER: Record<CombatRole, number> = { 坦克: 0, 战士: 1, 刺客: 2, 射手: 3, 法师: 4 };

/** Only the strongest owned copy of each definition is eligible for the bench. */
function bestCopies(cards: ArenaCard[]): ArenaCard[] {
  const best = new Map<string, ArenaCard>();
  for (const card of cards) {
    const old = best.get(card.defId);
    if (!old || card.rank > old.rank || (card.rank === old.rank && card.uid.localeCompare(old.uid) < 0)) best.set(card.defId, card);
  }
  return [...best.values()].sort((a, b) => b.rank - a.rank || FRONT_ORDER[getCombatStats(a).role] - FRONT_ORDER[getCombatStats(b).role] || a.defId.localeCompare(b.defId));
}
function recommend(cards: ArenaCard[], limit = 6, matchMode = false): (string | null)[] {
  const available = matchMode ? [...cards].sort((a, b) => (b.stars ?? 1) - (a.stars ?? 1) || b.rank - a.rank) : bestCopies(cards);
  const picked: ArenaCard[] = [];
  for (const role of ['坦克', '战士', '射手', '法师', '刺客'] as CombatRole[]) {
    const card = available.find(item => getCombatStats(item).role === role && !picked.some(pick => pick.uid === item.uid));
    if (card && picked.length < limit) picked.push(card);
  }
  for (const card of available) if (picked.length < limit && !picked.some(item => item.uid === card.uid)) picked.push(card);
  const slots: (string | null)[] = [...EMPTY_SLOTS];
  for (const card of picked) {
    const role = getCombatStats(card).role;
    const order = role === '坦克' || role === '战士' ? [1, 3, 5, 8, 10, 12] : role === '刺客' ? [7, 13, 0, 6, 8, 12] : [22, 24, 26, 15, 17, 19];
    const slot = order.find(index => !slots[index]) ?? slots.findIndex(uid => !uid);
    slots[slot] = card.uid;
  }
  return slots;
}
function AffinityMark({ affinity }: { affinity: Affinity }) {
  const Icon = affinity === 'moon' ? Moon : affinity === 'sun' ? Sun : Leaf;
  return <><Icon size={12} aria-hidden="true" />{AFFINITIES[affinity].name}</>;
}
function SlotCard({ card, slot, selected, canPlace, busy, onClick, onRemove, onPreview, onPreviewEnd }: {
  card?: ArenaCard; slot: number; selected: boolean; canPlace: boolean; busy: boolean;
  onClick: () => void; onRemove: () => void;
  onPreview?: (card: ArenaCard, element: HTMLElement) => void; onPreviewEnd?: () => void;
}) {
  const def = card ? CARD_MAP[card.defId] : null;
  const stats = card ? getCombatStats(card) : null;
  const Icon = stats ? ROLE_ICONS[stats.role] : Plus;
  return <div className={'battle-slot ' + (card ? 'filled ' : 'empty ') + (selected ? 'selected ' : '') + (canPlace ? 'can-place' : '')} data-rank={card?.rank} data-slot={slot}>
    <button type="button" className="battle-slot-main" onClick={onClick} onMouseEnter={event=>{if(card)onPreview?.(card,event.currentTarget);}} onMouseLeave={onPreviewEnd} onFocus={event=>{if(card)onPreview?.(card,event.currentTarget);}} onBlur={onPreviewEnd} disabled={busy} draggable={!!card && !busy} onDragStart={event => { if (card) { event.dataTransfer.setData('text/asteria-unit', card.uid); event.dataTransfer.effectAllowed = 'move'; } }} aria-pressed={selected}
      aria-label={'第 ' + (Math.floor(slot / 7) + 1) + ' 排第 ' + ((slot % 7) + 1) + ' 格' + (def ? '，' + def.name + '，点击选择换位' : '，空位，点击放置')}>
      {def && card && stats ? <>
        <img src={'/art/' + def.art + '.png'} alt="" draggable={false} />
        <span className="battle-slot-affinity"><AffinityMark affinity={def.affinity} /></span>
        <span className="battle-slot-level">{card.stars ? '★'.repeat(card.stars) : qualityName(card.rank)}</span>
        <span className="battle-slot-caption"><strong>{def.name}</strong><span><Icon size={12} />{stats.role}<i><Heart size={11} />{stats.hp}</i></span></span>
        {selected && <span className="battle-slot-selected"><ArrowRightLeft size={13} />点击另一格换位</span>}
      </> : <><span className="battle-slot-number">{String(slot + 1).padStart(2, '0')}</span><Plus size={17} /><span>{canPlace ? '落位' : '空位'}</span></>}
    </button>
    {card && <button className="battle-slot-remove" onClick={onRemove} disabled={busy} aria-label={'移除 ' + def!.name}><X size={13} /></button>}
  </div>;
}
function Synergies({ cards, compact = false }: { cards: OwnedCard[]; compact?: boolean }) {
  const list = getSynergies(cards);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = list.find(item => item.id === detailId);
  const active = list.filter(item => item.active).length;
  return <aside className={'battle-synergies ' + (compact ? 'compact' : '')}>
    <div className="battle-panel-heading"><div><Sparkles size={16} /><h2>阵容羁绊</h2></div><span>{active} 已激活</span></div>
    <p>不同星灵按属性或职业组成羁绊，同名不重复计数。</p>
    <div className="battle-synergy-list">{list.map(item => <button type="button" key={item.id} title={item.description} onClick={() => setDetailId(value => value === item.id ? null : item.id)} aria-pressed={detailId === item.id} aria-label={item.name + '，' + item.count + '/' + item.threshold + '，' + item.description} className={'battle-synergy ' + (item.active ? 'active' : '')}>
      <span className="battle-synergy-count">{item.active ? <Check size={13} /> : <>{item.count}<i>/{item.threshold}</i></>}</span>
      <span><b>{item.name}</b><small>{item.description}</small></span>
      <em>{item.active ? '已激活' : '差 ' + Math.max(0, item.threshold - item.count) + ' 张'}</em>
    </button>)}</div><p className="battle-synergy-explain" role="status">{detail ? <><b>{detail.name}</b>{detail.description}</> : '点击羁绊查看具体加成。'}</p>
  </aside>;
}
type Impact = { hp: number; shield: number };
function LiveUnit({ unit, previous, logs, tick, onPreview, onPreviewEnd }: { unit: CombatUnit; previous?: CombatUnit; logs: BattleLog[]; tick: number; onPreview?: (card: ArenaCard, element: HTMLElement, unit?: CombatUnit)=>void; onPreviewEnd?:()=>void }) {
  const Icon = ROLE_ICONS[unit.role];
  const impact: Impact = { hp: previous ? unit.hp - previous.hp : 0, shield: previous ? unit.shield - previous.shield : 0 };
  const actor = logs.some(log => log.actorId === unit.id && (log.kind === 'attack' || log.kind === 'skill'));
  const blinking = logs.some(log => log.actorId === unit.id && log.kind === 'move' && log.movement === 'blink');
  return <article className={'battle-live-unit ' + (unit.hp <= 0 ? 'is-fallen ' : '') + (actor ? 'is-acting ' : '') + (impact.hp < 0 ? 'is-hit ' : '') + (blinking ? 'is-blinking' : '')}
    onMouseEnter={event=>onPreview?.({uid:unit.cardUid,defId:unit.defId,rank:unit.rank,stars:unit.stars,best:0},event.currentTarget,unit)} onMouseLeave={onPreviewEnd} data-rank={unit.rank} style={{ left: (cellCenter({ row: unit.row, col: unit.col }).x * 100) + '%', top: (cellCenter({ row: unit.row, col: unit.col }).y * 100) + '%' }} title={unit.name + ' · ' + unit.role + ' · 普攻 ' + unit.attack + ' · 射程 ' + unit.range + ' · 护甲 ' + unit.armor + ' · 法抗 ' + unit.resistance + ' · ' + unit.skillName + '：' + unit.skillDescription} aria-label={unit.name + '，' + unit.role + '，生命 ' + unit.hp + '/' + unit.maxHp + '，能量 ' + unit.energy}>
    <div className="battle-live-art"><img src={'/art/' + unit.art + '.png'} alt="" draggable={false} /><span className="battle-live-rank">{unit.stars > 1 ? '★'.repeat(unit.stars) : qualityName(unit.rank)}</span>{unit.hp <= 0 && <span className="battle-fallen">退场</span>}</div>
    <div className="battle-live-info"><strong>{unit.name}</strong><span className="battle-live-role"><Icon size={11} />{unit.role}<i><AffinityMark affinity={unit.affinity} /></i></span>
      <div className="battle-hp-label"><span><Heart size={10} />{unit.hp}<small>/{unit.maxHp}</small></span>{unit.shield > 0 && <b><Shield size={10} />{unit.shield}</b>}</div>
      <div className="battle-health" role="progressbar" aria-label={unit.name + '生命'} aria-valuenow={unit.hp} aria-valuemin={0} aria-valuemax={unit.maxHp}><span style={{ width: unit.hp / unit.maxHp * 100 + '%' }} /></div>
      <div className={'battle-energy ' + (unit.energy >= 100 ? 'ready' : '')} role="progressbar" aria-label={unit.name + '能量'} aria-valuenow={unit.energy} aria-valuemin={0} aria-valuemax={100}><span style={{ width: unit.energy + '%' }} /></div>
      <span className="battle-energy-label"><Zap size={9} />{unit.energy >= 100 ? '技能就绪' : unit.energy + ' / 100'}</span>
    </div>
    {actor && <span className="battle-action-glint" key={'act-' + tick} aria-hidden="true" />}
    {(impact.hp !== 0 || impact.shield !== 0) && <div className="battle-impact" key={'impact-' + tick} aria-hidden="true">
      {impact.hp !== 0 && <b className={impact.hp > 0 ? 'heal' : 'damage'}>{impact.hp > 0 ? '+' : '−'}{Math.abs(impact.hp)}</b>}
      {impact.shield !== 0 && <span className="shield"><Shield size={13} />{impact.shield > 0 ? '+' : '−'}{Math.abs(impact.shield)}</span>}
    </div>}
  </article>;
}
function BattleEffects({ current, logs, tick }: { current: Pick<BattleState, 'player' | 'enemy'>; logs: BattleLog[]; tick: number }) {
  const units = [...current.player, ...current.enemy];
  const isSkill = logs.some(log => log.kind === 'skill');
  const impacts = logs.filter(log => ['attack', 'heal', 'shield'].includes(log.kind) && log.targetId);
  return <svg className="battle-effects" viewBox="0 0 700 800" preserveAspectRatio="none" aria-hidden="true" key={tick}>
    {impacts.map((log, index) => {
      const actor = units.find(unit => unit.id === log.actorId);
      const target = units.find(unit => unit.id === log.targetId);
      if (!actor || !target) return null;
      const ax = cellCenter({ row: actor.row, col: actor.col }).x * 700, ay = cellCenter({ row: actor.row, col: actor.col }).y * 800;
      const tx = cellCenter({ row: target.row, col: target.col }).x * 700, ty = cellCenter({ row: target.row, col: target.col }).y * 800;
      const effect = log.kind === 'heal' ? 'heal' : log.kind === 'shield' ? 'shield' : isSkill ? actor.effect : actor.range > 1 ? 'projectile' : 'slash';
      return <g className={'battle-effect effect-' + effect + ' rank-' + actor.rank} key={log.id + ':' + index}>
        {(effect === 'projectile' || effect === 'blast') && <><path className="battle-shot-trail" d={'M ' + ax + ' ' + ay + ' L ' + tx + ' ' + ty} /><path className="battle-shot" pathLength="100" d={'M ' + ax + ' ' + ay + ' L ' + tx + ' ' + ty} /></>}
        {(effect === 'slash' || effect === 'dash') && <g className="battle-slash" style={{ transformOrigin: tx + 'px ' + ty + 'px' }}><path d={'M ' + (tx - 26) + ' ' + (ty + 24) + ' Q ' + (tx + 12) + ' ' + (ty + 6) + ' ' + (tx + 28) + ' ' + (ty - 25)} /><path d={'M ' + (tx - 14) + ' ' + (ty + 27) + ' L ' + (tx + 31) + ' ' + (ty - 14)} /></g>}
        {effect === 'blast' && <circle className="battle-blast" cx={tx} cy={ty} r="66" style={{ transformOrigin: tx + 'px ' + ty + 'px' }} />}
        {effect === 'heal' && <g className="battle-heal-effect"><circle cx={tx} cy={ty} r="33" /><path d={'M ' + (tx - 11) + ' ' + ty + ' H ' + (tx + 11) + ' M ' + tx + ' ' + (ty - 11) + ' V ' + (ty + 11)} /></g>}
        {effect === 'shield' && <path className="battle-shield-effect" d={'M ' + tx + ' ' + (ty - 38) + ' L ' + (tx + 30) + ' ' + (ty - 22) + ' V ' + (ty + 4) + ' Q ' + (tx + 28) + ' ' + (ty + 29) + ' ' + tx + ' ' + (ty + 42) + ' Q ' + (tx - 28) + ' ' + (ty + 29) + ' ' + (tx - 30) + ' ' + (ty + 4) + ' V ' + (ty - 22) + ' Z'} />}
        {actor.rank >= 3 && isSkill && <g className="battle-rank-spark" style={{ transformOrigin: tx + 'px ' + ty + 'px' }}><path d={'M ' + (tx - 46) + ' ' + ty + ' H ' + (tx - 37) + ' M ' + (tx + 37) + ' ' + ty + ' H ' + (tx + 46) + ' M ' + tx + ' ' + (ty - 46) + ' V ' + (ty - 37) + ' M ' + tx + ' ' + (ty + 37) + ' V ' + (ty + 46)} /></g>}
      </g>;
    })}
  </svg>;
}
function DamageRanking({ battle }: { battle: BattleState }) {
  const totals = new Map<string, number>();
  for (const frame of battle.frames) for (const log of frame.logs) if (log.side === 'player' && log.kind === 'attack' && log.actorId) totals.set(log.actorId, (totals.get(log.actorId) ?? 0) + (log.amount ?? 0));
  const ranked = [...battle.player].map(unit => ({ unit, damage: totals.get(unit.id) ?? 0 })).sort((a, b) => b.damage - a.damage);
  const max = Math.max(1, ...ranked.map(item => item.damage));
  return <div className="battle-ranking"><div className="battle-panel-heading"><div><Sword size={16} /><h2>伤害排行</h2></div><span>我方</span></div>
    <ol>{ranked.map(({ unit, damage }, index) => <li key={unit.id}><span className="battle-ranking-place">{String(index + 1).padStart(2, '0')}</span><img src={'/art/' + unit.art + '.png'} alt="" /><span className="battle-ranking-name"><strong>{unit.name}</strong><span><i style={{ width: damage / max * 100 + '%' }} /></span></span><b>{damage}</b></li>)}</ol>
    <p>统计实际造成的生命伤害，不含被护盾吸收部分。</p>
  </div>;
}

type HoverCard = {card:ArenaCard;x:number;y:number;unit?:CombatUnit};
function CardHoverPreview({hover}:{hover:HoverCard|null}) {
  if(!hover)return null;
  const def=CARD_MAP[hover.card.defId], base=getCombatStats(hover.card);
  const stats=hover.unit?{...base,hp:hover.unit.maxHp,attack:hover.unit.attack,armor:hover.unit.armor,resistance:hover.unit.resistance}:base;
  return <aside className="arena-card-peek" role="tooltip" style={{left:hover.x,top:hover.y}}><img src={'/art/'+def.art+'.png'} alt=""/><div><h3>{def.name}</h3><span>{stats.role} · {AFFINITIES[def.affinity].name} · {qualityName(hover.card.rank)}品质{hover.card.stars?' · '+'★'.repeat(hover.card.stars):''}</span><dl><div><dt>生命</dt><dd>{stats.hp}</dd></div><div><dt>普攻</dt><dd>{stats.attack}</dd></div><div><dt>射程</dt><dd>{stats.range} 格</dd></div><div><dt>护甲</dt><dd>{stats.armor}</dd></div><div><dt>法抗</dt><dd>{stats.resistance}</dd></div><div><dt>先手</dt><dd>{stats.speed}</dd></div></dl><p><b>{stats.skillName}</b>{stats.skillDescription}</p></div></aside>;
}

export function BattleArena({ cards, battle, busy, onStart, onAction, onAbandon, formation, onFormationChange, maxUnits = 6, startLabel = '开始对战', startDisabled = false, replayOnly = false, replayDurationMs = 30000, embedded = false, rosterMode = 'collection', onSellUnit }: BattleArenaProps) {
  const [localSlots, setLocalSlots] = useState<(string | null)[]>(() => [...EMPTY_SLOTS]);
  const matchMode = rosterMode === 'match';
  const slots = formation ? Array.from({length: 28}, (_, slot) => formation.find(item => item.slot === slot)?.uid ?? null) : localSlots;
  function setSlots(value: (string | null)[] | ((previous: (string | null)[]) => (string | null)[])) {
    const next = typeof value === 'function' ? value(slots) : value;
    if (next.every((uid, index) => uid === slots[index])) return;
    if (formation) onFormationChange?.(next.flatMap((uid, slot) => uid ? [{uid, slot}] : []));
    else setLocalSlots(next);
  }
  const [selectedPool, setSelectedPool] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [showInspector, setShowInspector] = useState(false);
  const [hoveredCard, setHoveredCard] = useState<HoverCard|null>(null);
  function preview(card:ArenaCard,element:HTMLElement,unit?:CombatUnit){
    if(!embedded)return;
    const rect=element.getBoundingClientRect(), width=228;
    const x=rect.right+width+16<window.innerWidth?rect.right+12:Math.max(8,rect.left-width-12);
    const y=Math.max(8,Math.min(rect.top-10,window.innerHeight-390));
    setHoveredCard({card,x,y,unit});
  }
  const [search, setSearch] = useState('');
  const [hint, setHint] = useState('点击下方卡牌，再点击棋盘空格。也可以一键推荐布阵。');
  const [frameIndex, setFrameIndex] = useState(-1);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const [settling, setSettling] = useState(false);
  const [settleFailed, setSettleFailed] = useState(false);
  const resolutionRequested = useRef<string | null>(null);
  const resolutionPending = useRef(false);
  const currentBattleId = useRef<string | null>(battle?.id ?? null);
  currentBattleId.current = battle?.id ?? null;
  const lastSound = useRef('');
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const choices = useMemo(() => matchMode ? [...cards].sort((a, b) => (b.stars ?? 1) - (a.stars ?? 1) || b.rank - a.rank || a.uid.localeCompare(b.uid)) : bestCopies(cards), [cards, matchMode]);
  const cardMap = useMemo(() => new Map(cards.map(card => [card.uid, card])), [cards]);
  const chosenCards = slots.map(uid => uid ? cardMap.get(uid) : undefined).filter((card): card is ArenaCard => !!card);
  const filtered = choices.filter(card => CARD_MAP[card.defId].name.includes(search) || getCombatStats(card).role.includes(search) || AFFINITIES[CARD_MAP[card.defId].affinity].name.includes(search));
  const selectedCard = selectedPool ? cardMap.get(selectedPool) : selectedSlot !== null && slots[selectedSlot] ? cardMap.get(slots[selectedSlot]!) : undefined;
  const selectedStats = selectedCard ? getCombatStats(selectedCard) : undefined;
  function isInRange(slot: number) {
    return selectedSlot !== null && !!selectedStats && hexDistance(slotToCell(slot, 'player'), slotToCell(selectedSlot, 'player')) <= selectedStats.range;
  }
  // 部署半场（rows 4–7）内的格心投影：x 用全场 7.5 列宽归一，y 压缩到下半场四行。
  const deployCenter = (slot: number) => { const cell = slotToCell(slot, 'player'); return { x: cellCenter(cell).x, y: (cell.row - 4 + 0.5) / 4 }; };
  const hasBattle = !!battle;
  const playing = battle?.status === 'playing';
  const frameCount = battle?.frames.length ?? 0;
  const finishedPlayback = playing && frameIndex >= frameCount - 1 && frameIndex >= 0;

  // Preserve placement when assets refresh, and promote a definition to its highest copy.
  useEffect(() => {
    if (hasBattle || formation) return;
    setSlots(current => {
      const seen = new Set<string>();
      const next = current.map(uid => {
        const old = uid ? cardMap.get(uid) : undefined;
        const best = old ? choices.find(card => card.defId === old.defId) : undefined;
        if (!best || seen.has(best.defId)) return null;
        seen.add(best.defId);
        return best.uid;
      });
      return next.every((uid, index) => uid === current[index]) ? current : next;
    });
    if (selectedPool && !choices.some(card => card.uid === selectedPool)) setSelectedPool(null);
  }, [cardMap, choices, hasBattle, selectedPool]);

  useEffect(() => {
    if (selectedPool && !cardMap.has(selectedPool)) setSelectedPool(null);
    if (selectedSlot !== null && slots[selectedSlot] && !cardMap.has(slots[selectedSlot]!)) setSelectedSlot(null);
  }, [cardMap, selectedPool, selectedSlot]);

  // Snapshot polling must never rewind playback; only a new battle ID resets it.
  useEffect(() => {
    setFrameIndex(-1);
    setPaused(false);
    setSettling(false);
    setSettleFailed(false);
    resolutionRequested.current = null;
    resolutionPending.current = false;
    lastSound.current = '';
    if (battle && !formation) {
      setSlots(Array.from({ length: 28 }, (_, index) => battle.player.find(unit => unit.slot === index)?.cardUid ?? null));
      setSelectedPool(null);
      setSelectedSlot(null);
    }
  }, [battle?.id]);

  async function resolve(force = false) {
    if (replayOnly || !battle || battle.status !== 'playing' || busy || resolutionPending.current) return;
    if (!force && resolutionRequested.current === battle.id) return;
    const id = battle.id;
    resolutionRequested.current = id;
    resolutionPending.current = true;
    setSettling(true);
    setSettleFailed(false);
    try {
      const ok = await onActionRef.current({ type: 'resolve' });
      if (currentBattleId.current === id && ok === false) setSettleFailed(true);
    } catch {
      if (currentBattleId.current === id) setSettleFailed(true);
    } finally {
      if (currentBattleId.current === id) {
        resolutionPending.current = false;
        setSettling(false);
      }
    }
  }
  useEffect(() => {
    if (!playing || paused || busy || settling || frameIndex >= frameCount - 1) return;
    const currentFrame = battle?.frames[frameIndex];
    const hasSkill = currentFrame?.logs.some(log => log.kind === 'skill');
    const normalDelay = frameIndex < 0 ? 650 : hasSkill ? 680 : 500;
    const delay = replayOnly ? Math.min(normalDelay, replayDurationMs / Math.max(1, frameCount)) : normalDelay;
    const timer = window.setTimeout(() => setFrameIndex(index => Math.min(index + 1, frameCount - 1)), delay / speed);
    return () => window.clearTimeout(timer);
  }, [battle?.id, playing, paused, busy, settling, frameIndex, frameCount, speed, replayOnly, replayDurationMs]);
  useEffect(() => {
    if (!replayOnly && playing && (finishedPlayback || frameCount === 0) && !busy && !settling && resolutionRequested.current !== battle?.id) void resolve();
  }, [battle?.id, playing, finishedPlayback, frameCount, busy, settling]);
  useEffect(() => {
    if (!battle || !playing || frameIndex < 0) return;
    const frame = battle.frames[frameIndex];
    if (!frame) return;
    const key = battle.id + ':' + frame.tick;
    if (lastSound.current === key) return;
    lastSound.current = key;
    if (frame.logs.some(log => log.kind === 'skill')) playSound('combo');
    else if (frame.logs.some(log => log.kind === 'attack')) playSound('move');
  }, [battle?.id, playing, frameIndex]);
  useEffect(() => {
    if (battle && battle.status !== 'playing') playSound(battle.status === 'won' ? 'success' : 'confirm');
  }, [battle?.id, battle?.status]);

  function pick(card: ArenaCard) {
    if (busy) return;
    playSound('select');
    const slot = slots.indexOf(card.uid);
    if (slot >= 0) {
      setSelectedSlot(slot); setSelectedPool(null);
      setHint('已选择 ' + CARD_MAP[card.defId].name + '，点击另一格交换位置。');
    } else {
      setSelectedPool(card.uid); setSelectedSlot(null);
      setHint('已选择 ' + CARD_MAP[card.defId].name + '，点击空格上阵，或点击已有卡牌替换。');
    }
  }
  function place(index: number) {
    if (busy) return;
    if (selectedPool) {
      if (!slots[index] && chosenCards.length >= maxUnits) { setHint('最多上阵 ' + maxUnits + ' 张星灵，点击已有卡牌替换，或先移除一张。'); return; }
      const card = cardMap.get(selectedPool);
      if (!card) return;
      setSlots(current => current.map((uid, i) => i === index ? selectedPool : uid === selectedPool || (!matchMode && uid && cardMap.get(uid)?.defId === card.defId) ? null : uid));
      setSelectedPool(null); setSelectedSlot(null); playSound('move');
      setHint('已上阵。点击棋盘上的卡牌，再点击另一格即可换位。');
    } else if (selectedSlot !== null) {
      if (selectedSlot !== index) {
        setSlots(current => { const next = [...current]; [next[index], next[selectedSlot]] = [next[selectedSlot], next[index]]; return next; });
        playSound('move'); setHint('已交换位置。前排承受攻击，后排保护射手与法师。');
      }
      setSelectedSlot(null);
    } else if (slots[index]) {
      setSelectedSlot(index); playSound('select'); setHint('点击另一格交换位置，也可以移到空格。');
    } else setHint('先从下方选择一张卡牌，再点击这个空格。');
  }
  function dropCard(uid: string, index: number) {
    if (busy || !cardMap.has(uid)) return;
    const from = slots.indexOf(uid);
    if (from >= 0) {
      setSlots(current => { const next = [...current]; [next[index], next[from]] = [next[from], next[index]]; return next; });
    } else {
      if (!slots[index] && chosenCards.length >= maxUnits) { setHint('人口已满，拖到已上阵卡牌上可以替换。'); return; }
      const card = cardMap.get(uid)!;
      setSlots(current => current.map((value, slot) => slot === index ? uid : !matchMode && value && cardMap.get(value)?.defId === card.defId ? null : value));
    }
    setSelectedPool(null); setSelectedSlot(null); playSound('move'); setHint('站位已更新。');
  }
  function remove(index: number) {
    if (busy) return;
    setSlots(current => current.map((uid, i) => i === index ? null : uid));
    setSelectedSlot(null); playSound('select'); setHint('已移回卡池，卡牌不会丢失。');
  }
  function autoPlace() {
    if (busy) return;
    setSlots(recommend(cards, maxUnits, matchMode)); setSelectedPool(null); setSelectedSlot(null);
    setHint('已推荐布阵。前排坦克与战士，后排射手与法师，可自由点击换位。');
    playSound('shuffle');
  }
  function begin() {
    if (busy || startDisabled || chosenCards.length > maxUnits || (!formation && chosenCards.length !== maxUnits) || (!matchMode && new Set(chosenCards.map(card => card.defId)).size !== chosenCards.length)) return;
    playSound('confirm');
    void onStart(slots.filter((uid): uid is string => !!uid), slots.flatMap((uid, index) => uid ? [index] : []));
  }
  function skip() {
    if (!battle || busy || settling) return;
    setFrameIndex(Math.max(0, battle.frames.length - 1)); setPaused(true);
    playSound('confirm');
    if (!replayOnly) void resolve(true);
  }

  if (!battle) return <section className={'battle-arena battle-deploy ' + (embedded ? 'embedded' : '')} aria-busy={busy}>
    <header className="battle-heading"><div><span className="battle-kicker">FORMATION · AUTO BATTLE</span><h1>布置你的阵容</h1><p>28 格布阵，最多上阵 {maxUnits} 张星灵。卡牌自动移动、攻击并释放技能。</p></div><span className="battle-mode-label"><Users size={15} />站位自走棋</span></header>
    <div className="battle-builder-layout">
      <div className="battle-deployment">
        <div className="battle-board-top"><span><Sword size={15} />敌方方向</span><button onClick={autoPlace} disabled={busy || choices.length === 0}><WandSparkles size={15} />推荐布阵</button></div>
        <div className="battle-deploy-field">
        <div className="battle-deploy-ghost-grid" aria-hidden="true">{Array.from({length:28},(_,slot)=>{const ghost=slotToCell(slot,'enemy');const center=cellCenter(ghost);return <span key={slot} style={{left:center.x*100+'%',top:((ghost.row+0.5)/4)*100+'%'}}/>;})}</div>
        <div className="battle-deploy-labels"><span>前排 · 靠近敌方</span><small>点击卡牌 → 点击格子 · 已上阵卡可互换</small></div>
        <div className="battle-deploy-board">{Array.from({ length: 28 }, (_, slot) => { const center = deployCenter(slot); return <div className={'battle-deploy-cell ' + (isInRange(slot) ? 'in-range' : '')} key={slot} data-slot={slot} data-row={Math.floor(slot / 7)} style={{ left: center.x * 100 + '%', top: center.y * 100 + '%' }} onDragOver={event => { if (!busy) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={event => { event.preventDefault(); dropCard(event.dataTransfer.getData('text/asteria-unit'), slot); }}>
          <SlotCard card={slots[slot] ? cardMap.get(slots[slot]!) : undefined} slot={slot} selected={selectedSlot === slot} canPlace={!!selectedPool || selectedSlot !== null} busy={busy || (!slots[slot] && chosenCards.length >= maxUnits && selectedSlot === null && !!selectedPool)} onClick={() => place(slot)} onRemove={() => remove(slot)} onPreview={preview} onPreviewEnd={()=>setHoveredCard(null)} />
        </div>; })}</div>
        </div>
        <div className="battle-deploy-labels bottom"><span>后排 · 保护核心输出</span><small>{selectedSlot !== null && selectedStats ? '金色格：普攻射程 ' + selectedStats.range + ' 格' : matchMode ? '棋盘可放置 ' + maxUnits + ' 张星灵' : '同名星灵仅能上阵一张'}</small></div>
        <div className="battle-board-hint" role="status"><ArrowRightLeft size={14} /><span>{hint}</span></div>
        <div className="battle-deploy-actions"><span>已上阵 <b>{chosenCards.length}</b> / {maxUnits}<button className="battle-clear" disabled={busy || !chosenCards.length} onClick={() => { setSlots([...EMPTY_SLOTS]); setSelectedPool(null); setSelectedSlot(null); setHint('阵容已清空，从下方选择卡牌重新布阵。'); }}>清空</button></span><button className="battle-primary" disabled={busy || startDisabled || chosenCards.length > maxUnits || (!formation && chosenCards.length !== maxUnits)} onClick={begin}>{busy ? <LoaderCircle size={17} className="battle-spin" /> : <Sword size={17} />}{startLabel}<ArrowRight size={17} /></button></div>
      </div>
      <button type="button" className="battle-inspector-toggle" aria-expanded={showInspector} onClick={()=>setShowInspector(value=>!value)}>卡牌详情与羁绊 {showInspector?'收起':'展开'}</button>
      <div className={'battle-builder-inspector '+(showInspector?'is-open':'')}>
        {selectedCard && selectedStats ? <div className="battle-card-detail">
          <div className="battle-detail-top"><img src={'/art/' + CARD_MAP[selectedCard.defId].art + '.png'} alt="" /><div><span>{matchMode ? '永久 ' : ''}{qualityName(selectedCard.rank)}品质{matchMode && <i className="battle-detail-stars">局内 {'★'.repeat(selectedCard.stars ?? 1)}</i>}</span><h2>{CARD_MAP[selectedCard.defId].name}</h2><p>{selectedStats.role} · {AFFINITIES[CARD_MAP[selectedCard.defId].affinity].name}</p></div></div>
          <dl className="battle-stat-grid"><div><dt>生命</dt><dd>{selectedStats.hp}</dd></div><div><dt>普攻</dt><dd>{selectedStats.attack}</dd></div><div><dt>射程</dt><dd>{selectedStats.range}<small> 格</small></dd></div><div><dt>护甲</dt><dd>{selectedStats.armor}</dd></div><div><dt>法抗</dt><dd>{selectedStats.resistance}</dd></div><div><dt>先手</dt><dd>{selectedStats.speed}</dd></div></dl>
          <p className="battle-detail-skill"><b><Sparkles size={13} />{selectedStats.skillName}</b>{selectedStats.skillDescription}</p>
          <span className="battle-detail-note">错列六边形距离判定射程（相邻格距离 1），能量满 100 自动施放技能。</span>
        </div> : <div className="battle-inspect-hint"><Crosshair size={24} /><p>选择一张卡牌</p><span>查看普攻、射程、防御与技能</span></div>}
        <Synergies cards={chosenCards} compact />
      </div>
    </div>
    <div className="battle-roster-toolbar"><div><h2>{matchMode ? '本局备战区' : '我的卡池'} <span>{choices.length}{matchMode ? ' / 15' : ''}</span></h2><p>{matchMode ? '相同星级的 3 张同名卡会自动合星；未上阵卡保留在备战区。' : '每种星灵只显示最高等级；同名卡只能上阵一张。'}</p></div><label><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="名称 / 职业 / 属性" aria-label="搜索出战卡牌" />{search && <button onClick={() => setSearch('')} aria-label="清除搜索"><X size={13} /></button>}</label></div>
    <div className="battle-roster">{filtered.map(card => {
      const def = CARD_MAP[card.defId], stats = getCombatStats(card), Icon = ROLE_ICONS[stats.role], placed = slots.includes(card.uid), selected = selectedPool === card.uid || (selectedSlot !== null && slots[selectedSlot] === card.uid);
      return <div className="battle-bench-card" key={card.uid}><button type="button" className={'battle-pick ' + (placed ? 'placed ' : '') + (selected ? 'selected' : '')} data-rank={card.rank} draggable={!busy} onDragStart={event => { event.dataTransfer.setData('text/asteria-unit', card.uid); event.dataTransfer.effectAllowed = 'move'; }} onClick={() => pick(card)} onMouseEnter={event=>preview(card,event.currentTarget)} onMouseLeave={()=>setHoveredCard(null)} onFocus={event=>preview(card,event.currentTarget)} onBlur={()=>setHoveredCard(null)} disabled={busy} aria-pressed={selected} aria-label={def.name + '，' + qualityName(card.rank) + '品质，' + stats.role + (placed ? '，已上阵，点击换位' : '，点击选择')}>
        <div className="battle-pick-art"><img src={'/art/' + def.art + '.png'} alt="" loading="lazy" draggable={false} /><span className="battle-pick-rank">{qualityName(card.rank)}</span>{matchMode && <span className="battle-pick-stars" aria-label={'局内 ' + (card.stars ?? 1) + ' 星'}>{'★'.repeat(card.stars ?? 1)}</span>}<span className="battle-pick-affinity"><AffinityMark affinity={def.affinity} /></span>{placed && <span className="battle-pick-status"><Check size={12} />已上阵</span>}</div>
        <div className="battle-pick-copy"><strong>{def.name}</strong><span><Icon size={12} />{stats.role}<small><Heart size={11} />{stats.hp}<Sword size={11} />{stats.attack}</small></span><p>{stats.skillName}</p></div>
      </button>{onSellUnit && <button className="battle-sell-unit" disabled={busy} onClick={() => onSellUnit(card.uid)} aria-label={'出售 ' + def.name}><span>出售</span><small>{(card.stars ?? 1) === 3 ? '三星' : (card.stars ?? 1) === 2 ? '二星' : '一星'}</small></button>}</div>;
    })}</div>
    {!filtered.length && <p className="battle-empty">{choices.length ? '没有找到符合条件的卡牌。' : matchMode ? '备战区为空，在本局商店招募星灵。' : '还没有可上阵的星灵，先去抽卡扩充收藏。'}</p>}
    {!matchMode && choices.length < maxUnits && <p className="battle-footnote">还需拥有 {maxUnits - choices.length} 种不同星灵才能开始。抽卡、市场交易与好友赠送都能扩充卡池。</p>}
    <details className="battle-rules"><summary>站位与自动战斗说明<ChevronDown size={13} /></summary><div><p><b>前排与后排</b>　每方 4 排 × 7 列错列六边形格，按人口上限自由放置星灵。卡牌沿六边形邻接移动靠近射程内的敌人，不会隔着棋盘凭空攻击。</p><p><b>能量与技能</b>　攻击和受击积攒能量，达到 100 后下一次行动自动释放技能。</p><p><b>属性克制</b>　月克日，日克森，森克月。品质每升一档增加 4% 生命、3% 攻击与 3% 技能系数；高品质卡在局内商店更贵。</p></div></details>
    <CardHoverPreview hover={hoveredCard}/>
  </section>;

  const frame = playing && frameIndex >= 0 ? battle.frames[frameIndex] : undefined;
  const current = frame ?? battle;
  const previous = frameIndex > 0 ? battle.frames[frameIndex - 1] : battle;
  const previousUnits = new Map([...previous.player, ...previous.enemy].map(unit => [unit.id, unit]));
  const logs = frame?.logs ?? (playing ? [] : battle.frames.at(-1)?.logs ?? []);
  const tick = frame?.tick ?? -1;
  const actor = logs.find(log => log.kind === 'skill')?.actorId;
  const skillUnit = actor ? [...current.player, ...current.enemy].find(unit => unit.id === actor) : undefined;
  const displayLogs = playing ? battle.frames.slice(0, frameIndex + 1).flatMap(item => item.logs).slice(-6) : battle.logs.slice(-8);
  const teamForSynergies = battle.player.map(unit => ({ uid: unit.cardUid, defId: unit.defId, rank: unit.rank, best: 0, stars: unit.stars }));
  const progress = playing ? Math.max(0, (frameIndex + 1) / Math.max(1, frameCount)) : 1;
  return <section className={'battle-arena battle-live ' + (embedded ? 'embedded' : '')} aria-busy={busy}>
    <header className="battle-heading"><div><span className="battle-kicker">AUTO BATTLE · POSITIONING</span><h1>{playing ? finishedPlayback ? replayOnly ? '本轮回放完成' : '等待战果结算' : paused ? '回放已暂停' : '战斗进行中' : battle.status === 'won' ? '战斗胜利' : '本场战败'}</h1><p>{playing ? '星灵自动选择目标，积攒能量并释放技能。' : '卡牌与站位都已保留，调整阵容再试一次。'}</p></div><div className="battle-round"><span>ROUND</span><strong>{String(current.round).padStart(2, '0')}<small> / {battle.maxRounds}</small></strong></div></header>
    <div className="battle-live-layout"><div>
      <div className="battle-field">
        <div className="battle-side-label"><span>对方阵容</span><small>{current.enemy.filter(unit => unit.hp > 0).length} / {current.enemy.length} 存活</small></div>
        <div className="battle-tactics-board" data-speed={speed} style={{'--move-duration': Math.min(speed === 2 ? 210 : 390, replayOnly ? replayDurationMs / Math.max(1, frameCount) / speed * .85 : 390) + 'ms'} as CSSProperties}>
          <div className="battle-board-grid" aria-hidden="true">{Array.from({ length: 56 }, (_, index) => { const row = Math.floor(index / 7), col = index % 7, center = cellCenter({ row, col }); return <span key={index} className={(row < 4 ? 'enemy-cell' : 'player-cell') + (row === 3 ? ' battle-midline' : '')} style={{ left: center.x * 100 + '%', top: center.y * 100 + '%' }} />; })}</div>
          <span className="battle-midline-divider" aria-hidden="true" />
          <span className="battle-field-watermark enemy">OPPONENT</span><span className="battle-field-watermark player">YOUR TEAM</span>
          {[...current.enemy, ...current.player].map(unit => <LiveUnit key={unit.id} unit={unit} previous={playing ? previousUnits.get(unit.id) : undefined} logs={logs} tick={tick} onPreview={preview} onPreviewEnd={()=>setHoveredCard(null)} />)}
          {playing && <BattleEffects current={current} logs={logs} tick={tick} />}
        </div>
        <div className="battle-side-label own"><span>我方阵容</span><small>{current.player.filter(unit => unit.hp > 0).length} / {current.player.length} 存活</small></div>
        {skillUnit && playing && <div className="battle-skill-banner" key={tick} role="status"><Sparkles size={17} /><span>{skillUnit.name}<b>{skillUnit.skillName}</b></span></div>}
      </div>
      {replayOnly && finishedPlayback && <div className={'battle-round-result ' + (battle.outcome === 'won' ? 'is-won' : 'is-lost')} role="status"><Trophy size={22} /><div><strong>{battle.outcome === 'won' ? '本轮胜利' : '本轮战败'}</strong><span>{battle.outcome === 'won' ? '阵容守住了这一轮。' : '下一轮调整站位或补强阵容。'}等待阶段计时结束后结算。</span></div></div>}
      {playing ? <div className="battle-playback"><div className="battle-playback-progress"><span style={{ width: progress * 100 + '%' }} /></div><div className="battle-playback-controls"><span className="battle-playback-caption">{finishedPlayback ? replayOnly ? '本轮回放完成，等待下一阶段' : settling || busy ? '正在保存战果…' : settleFailed ? '结算未完成，请重试' : '正在确认战果' : '第 ' + Math.max(0, frameIndex + 1) + ' / ' + frameCount + ' 次行动'}</span><div>
        <button className={'battle-speed ' + (speed === 2 ? 'active' : '')} onClick={() => { setSpeed(value => value === 1 ? 2 : 1); playSound('select'); }} disabled={finishedPlayback} aria-label={'当前 ' + speed + ' 倍速，点击切换'}>{speed}×</button>
        <button className="battle-control" onClick={() => { setPaused(value => !value); playSound('select'); }} disabled={finishedPlayback || busy || settling} aria-label={paused ? '继续回放' : '暂停回放'}>{paused ? <Play size={16} /> : <Pause size={16} />}<span>{paused ? '继续' : '暂停'}</span></button>
        <button className="battle-skip" onClick={skip} disabled={busy || settling || (replayOnly && finishedPlayback)}>{busy || settling ? <LoaderCircle size={15} className="battle-spin" /> : <SkipForward size={15} />}<span>{replayOnly ? finishedPlayback ? '回放完成' : '跳过动画' : finishedPlayback ? '重试结算' : '跳过并结算'}</span></button>
      </div></div></div> : <div className={'battle-outcome ' + (battle.status === 'won' ? 'is-won' : 'is-lost')} role="status"><Trophy size={30} /><div><h2>{battle.status === 'won' ? '你的阵容拿下了这一场。' : '换个站位，再来一次。'}</h2><p>{battle.reason === 'round-limit' ? '达到回合上限，按剩余生命比例判定。' : battle.status === 'won' ? '对方星灵全部退场。' : '我方星灵全部退场。'}战果已由服务器保存。</p></div>{!replayOnly && <button className="battle-primary" onClick={() => { playSound('select'); void onAbandon(); }} disabled={busy}><RotateCcw size={16} />调整阵容</button>}</div>}
    </div><div className="battle-live-sidebar">{!playing || (replayOnly && finishedPlayback) ? <DamageRanking battle={battle} /> : <Synergies cards={teamForSynergies} compact />}
      <div className="battle-events"><div className="battle-panel-heading"><div><Zap size={15} /><h2>战斗动态</h2></div><span>{paused && playing ? '已暂停' : playing ? '实时回放' : '已结束'}</span></div><ol>{displayLogs.length ? displayLogs.map(log => <li key={log.id} data-kind={log.kind} data-side={log.side}><i>{log.side === 'player' ? '我方' : log.side === 'enemy' ? '对方' : '战况'}</i><span>{log.text}</span></li>) : <li className="battle-events-empty">双方已就位，即将开始交锋。</li>}</ol></div>
      {playing && !replayOnly && <button className="battle-abandon" disabled={busy || settling} onClick={() => void onAbandon()}>结束本场对战</button>}
    </div></div>
    <CardHoverPreview hover={hoveredCard}/>
  </section>;
}
export default BattleArena;
