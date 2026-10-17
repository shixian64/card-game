import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Coins, Heart, Info, LoaderCircle, Sparkles, Swords, Trophy, Users, X } from 'lucide-react';
import { CARDS, CARD_MAP, AFFINITIES, QUALITY_TIERS, qualityName } from './data';
import type { OwnedCardV2 } from './engine';
import { getCombatStats, getSynergies } from './battle';
import { rotate180, cellCenter } from './hex';
import { DUEL_ITEMS } from './equipment';
import type { ItemDef } from './equipment';
import {
  AUGMENT_MAP, AUGMENT_TIERS, AUGMENT_CATEGORY_NAMES, aggregateAugmentEffects, applyAugmentTraitBonuses,
} from './augments';
import { createDuelHeartbeat } from './duel-session';
import './duel-arena.css';

// 双人短局主对局 UI（DUEL-RULES-1）。这是唯一主玩法入口：不再并列任何
// 独自练习入口；旧单人局只在“进行中”时由 CombatApp 继续用 MatchArena 冻结收尾。
// 视角：服务端只下发一份权威视图 / 回放；B 端展示时把物理棋盘 180° 旋转到己方在下，
// 不重新模拟、不改结果。

export interface DuelItemInstance { itemId: string; itemDefId: string; kind: 'complete' }
export interface DuelShopOffer { offerId: string; defId: string; quality: number; cost: number }
export interface DuelRosterUnit { unitId: string; defId: string; quality: number; stars: 1 | 2 | 3; basis: number; equippedItemIds: string[] }
export interface DuelFormationEntry { unitId: string; localSlot: number }
export interface DuelLoadout { defs: { defId: string; battleQuality: number }[]; starters: string[] }
export interface DuelPlayerView {
  side: 'A' | 'B'; ready: boolean; playerRevision: number; name: string; loadout: DuelLoadout | null;
  hp: number; gold: number; population: number; shop: DuelShopOffer[]; shopLocked: boolean;
  roster: DuelRosterUnit[]; formation: DuelFormationEntry[]; items: DuelItemInstance[];
  lastIncome: { interest: number; neutralGuaranteed: number; neutralWinBonus: number; pvpSupply: number; total: number } | null;
  pendingItemChoice: { round: number; candidates: string[]; expiresPhaseId: string; status: string } | null;
  augments: string[];
  pendingAugmentOffer: { round: number; tier: 1 | 2 | 3; candidates: string[]; expiresPhaseId: string } | null;
  rerollCost: number; freeRerolls: number; shopSlots: number; itemSlots: number; populationBonus: number;
  reward?: { base: number; factor: number; actualCoins: number; reason: string } | null;
}
export interface DuelRoomView {
  id: string; inviteCode?: string; status: string; rulesVersion: number; round: number; kind: 'pvp' | 'neutral' | null;
  phase: string; phaseId: string; phaseEndsAt: number; serverNow: number; revision: number; startedAt?: number;
  outcome?: 'A' | 'B' | null; finishReason?: string; population: number;
}
export interface DuelScout { round: number; side: 'A' | 'B'; units: { unitId: string; defId: string; quality: number; stars: number; itemDefIds: string[] }[]; formation: { unitId: string; localSlot: number }[] }
export interface DuelView {
  room: DuelRoomView;
  self: DuelPlayerView;
  opponent: { side: 'A' | 'B'; name: string; ready: boolean; loadout: DuelLoadout | null; hp: number; population: number; augments: string[] } | null;
  scout: DuelScout | null;
  currentBattle: { round: number; kind: string; status: string; summary: Record<string, unknown> | null; battleIds: string[] } | null;
}
interface DuelReplayUnit { unitId: string; side: 'A' | 'B'; kind: string; defId?: string; name: string; hp: number; maxHp: number; shield: number; row: number; col: number; stars?: number; quality?: number; itemDefIds?: string[] }
interface DuelReplayFrame { tick: number; round: number; sideA: DuelReplayUnit[]; sideB: DuelReplayUnit[]; logs: { text: string }[] }
interface DuelReplay { battleId: string; round: number; kind: string; sim: { winner: 'A' | 'B' | null; reason: string; frames: DuelReplayFrame[] } }

function makeRequestId() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'r' + Date.now() + '-' + Math.random().toString(36).slice(2, 10); }
interface DuelHttpError extends Error { status?: number }
async function callDuel<T>(userId: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body ? {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Asteria-User': userId }, body: JSON.stringify(body),
  } : { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Asteria-User': userId } });
  const payload = await response.json().catch(() => ({ error: '服务器返回了无法读取的内容' }));
  if (!response.ok) {
    // 带上 HTTP 状态：调用方据此区分“服务器说房间没了”（回大厅）与网络 / 5xx（保留重试）。
    const error = new Error((payload as { error?: string }).error || '请求未完成，请重试') as DuelHttpError;
    error.status = response.status;
    throw error;
  }
  return payload as T;
}
// 模块级保活心跳：DuelArena 卸载（返回收藏 / 切页）后仍低频上报 last_seen，
// 兑现“离开本页不算投降”的承诺；服务端 60 秒宽限，12 秒一拍留足余量。
const duelHeartbeat = createDuelHeartbeat((userId, roomId) => callDuel<DuelView>(userId, '/api/duel/' + roomId));
function stopDuelHeartbeat() { duelHeartbeat.stop(); }
function syncDuelHeartbeat(userId: string, roomId: string) {
  duelHeartbeat.sync(userId, roomId);
}
const FRONT_SLOTS = [1, 3, 5, 8, 10, 12, 2];
const BACK_SLOTS = [22, 24, 26, 15, 17, 19, 21];
function roleOf(defId: string): string { return getCombatStats({ uid: 'x', defId, rank: 1, best: 0 }).role; }
function isMelee(defId: string): boolean { return ['坦克', '战士', '刺客'].includes(roleOf(defId)); }
/** 本人视角的推荐布阵（与服务器 autoPlacement 同规则：近战前排、远程后排）。 */
function suggestFormation(roster: DuelRosterUnit[], population: number): DuelFormationEntry[] {
  const priority: Record<string, number> = { 坦克: 0, 战士: 1, 刺客: 2, 射手: 3, 法师: 4 };
  const units = [...roster].sort((a, b) => (priority[roleOf(a.defId)] ?? 5) - (priority[roleOf(b.defId)] ?? 5) || b.stars - a.stars).slice(0, population);
  let front = 0, back = 0;
  return units.map(unit => ({ unitId: unit.unitId, localSlot: isMelee(unit.defId) ? FRONT_SLOTS[front++] ?? 12 : BACK_SLOTS[back++] ?? 19 }));
}
function itemDefOf(id: string): ItemDef { return DUEL_ITEMS.find(item => item.id === id) ?? DUEL_ITEMS[0]; }
/** 羁绊显示名：getSynergies 的 name 是「2 月 / 双坦克」，面板里改成「月 / 坦克」。 */
function synergyLabel(id: string, name: string): string {
  if (id.startsWith('affinity-')) {
    const key = id.split('-')[1] as keyof typeof AFFINITIES;
    return AFFINITIES[key]?.name ?? name;
  }
  if (id.startsWith('role-')) return name.replace(/^双/, '');
  return name;
}
// 无奖励 / 衰减原因（服务端 eligibility 的 reason 集合）：终局必须明说原因，不能只说“无奖励”（12.2）。
const REWARD_REASON_LABELS: Record<string, string> = {
  forfeited: '主动投降或长期掉线判负，本局无奖励',
  insufficient_activity_rounds: '有效经营轮次不足（按本局实际完成轮数判定），本局无奖励',
  insufficient_deployed_defs: '上阵卡种不足三种，本局无奖励',
  room_too_short: '对局未满 180 秒，双方无奖励',
  service_abort: '等待超时或服务异常导致对局取消，本局无奖励',
  personal_quota: '当日个人奖励配额衰减（前 6 局全额、再 6 局半额）',
  pair_quota: '与该对手的每日配额衰减（前 3 局全额、再 3 局半额）',
};
function rewardReasonText(reason: string): string {
  if (!reason) return '';
  return reason.split(',').map(part => REWARD_REASON_LABELS[part.trim()] ?? part).join('；');
}

export default function DuelArena({ userId, cards, onRewardClaimed, onBack }: { userId: string; cards: OwnedCardV2[]; onRewardClaimed: () => void; onBack?: () => void }) {
  const [view, setView] = useState<DuelView | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [draft, setDraft] = useState<{ defs: string[]; qualities: Record<string, number>; starters: string[] } | null>(null);
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null);
  const [formationDraft, setFormationDraft] = useState<DuelFormationEntry[] | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'dirty'>('saved');
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [replay, setReplay] = useState<DuelReplay | null>(null);
  const [replayTick, setReplayTick] = useState(0);
  const [nowBase, setNowBase] = useState({ server: 0, local: 0 });
  const roomRef = useRef<string | null>(null);
  const [roomProbe, setRoomProbe] = useState(0);
  // 4xx 被踢回大厅后自增：让 /me 恢复 effect 以全新 settled 状态复查一次，
  // 避免停留在过期的“房间不存在”报错上（可能已换房 / 已恢复）。
  const [recoverProbe, setRecoverProbe] = useState(0);
  const lastKickRef = useRef(0);
  const requestSeq = useRef(0);
  const mountedRef = useRef(true);
  const lastPollRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; requestSeq.current++; };
  }, []);
  // roomRef 变化时同步 bump state，让轮询 effect 依赖能感知“进房 / 离房”。
  const applyRoomId = useCallback((id: string | null) => {
    if (roomRef.current === id) return;
    roomRef.current = id;
    setRoomProbe(value => value + 1);
  }, []);

  const maxByDef = useMemo(() => {
    const map = new Map<string, number>();
    for (const card of cards) map.set(card.defId, Math.max(map.get(card.defId) ?? 0, card.rank));
    return map;
  }, [cards]);

  const loadView = useCallback(async (roomId: string) => {
    if (!mountedRef.current) return;
    const seq = ++requestSeq.current;
    try {
      const next = await callDuel<DuelView>(userId, '/api/duel/' + roomId);
      if (!mountedRef.current || seq !== requestSeq.current) return;
      setView(next); setError('');
      setNowBase({ server: next.room.serverNow, local: Date.now() });
      applyRoomId(roomId);
      if (next.room.status !== 'finished') syncDuelHeartbeat(userId, roomId);
      else stopDuelHeartbeat();
    } catch (cause) {
      if (!mountedRef.current || seq !== requestSeq.current) return;
      const status = cause instanceof Error ? (cause as DuelHttpError).status : undefined;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
        // 服务器明确说房间不可读（不存在 / 非成员）：回大厅。
        applyRoomId(null); setView(null); stopDuelHeartbeat();
        setError(cause instanceof Error ? cause.message : '房间读取失败');
        // 节流触发 /me 复查（可能已进入新房间）；不节流会形成 4xx→复查→4xx 紧密循环。
        if (Date.now() - lastKickRef.current > 10000) { lastKickRef.current = Date.now(); setRecoverProbe(value => value + 1); }
        return;
      }
      // 网络失败 / 5xx / 限流：保留房间 ID 与现有视图，轮询继续重试，
      // 不能把一次瞬断当作房间不存在把进行中的玩家丢回大厅。
      setError(cause instanceof Error ? cause.message : '房间读取失败，正在重试');
    }
  }, [userId, applyRoomId]);

  // 初始 /me 恢复：网络失败时 3 秒重试直到拿到确定结果（含“无房间”）。
  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const attempt = async () => {
      if (cancelled || settled || roomRef.current) return;
      try {
        const me = await callDuel<{ activeRoomId: string | null; lastFinishedRoomId: string | null }>(userId, '/api/duel/me');
        if (cancelled) return;
        if (me.activeRoomId) {
          // settled 只有在房间真正落定（roomRef 写入）后才置位：详情请求网络瞬断时
          // 3 秒后重试，避免卡在“有进行中房间、却无轮询”的大厅假死状态。
          await loadView(me.activeRoomId);
          if (!cancelled && roomRef.current === me.activeRoomId) settled = true;
        } else {
          settled = true;
          setError(''); // 复查确认无房间时清掉被踢回大厅时留下的过期报错
          if (me.lastFinishedRoomId) await loadView(me.lastFinishedRoomId);
        }
      } catch { /* 网络恢复后由下一次重试接手 */ }
    };
    void attempt();
    const timer = setInterval(() => void attempt(), 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [userId, loadView, recoverProbe]);

  // 2 秒状态轮询：命令后立即刷新；页面隐藏时降为 15 秒心跳（服务端按 60 秒宽限判掉线，
  // 后台标签不能完全静默）；服务端定时器推进阶段，不依赖本轮询。
  useEffect(() => {
    if (!roomRef.current) return;
    const timer = setInterval(() => {
      if (busy) return;
      if (document.visibilityState === 'hidden' && Date.now() - lastPollRef.current < 15000) return;
      lastPollRef.current = Date.now();
      void loadView(roomRef.current!);
    }, 2000);
    return () => clearInterval(timer);
  }, [roomProbe, view?.room.id, busy, loadView]);

  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3600); return () => clearTimeout(timer); }, [notice]);

  // 终局到账同步：第一次看到某房间 finished 就刷新大厅星币余额（每房间只触发一次）。
  const rewardSyncedRoom = useRef<string | null>(null);
  useEffect(() => {
    if (view?.room.status !== 'finished') return;
    if (rewardSyncedRoom.current === view.room.id) return;
    rewardSyncedRoom.current = view.room.id;
    onRewardClaimed();
  }, [view?.room.status, view?.room.id, onRewardClaimed]);

  const command = useCallback(async (action: string, payload: Record<string, unknown> = {}, phaseId?: string, expectedRevision?: number) => {
    if (!roomRef.current || busy) return false;
    setBusy(true);
    try {
      const next = await callDuel<DuelView>(userId, '/api/duel/' + roomRef.current + '/command', {
        requestId: makeRequestId(), phaseId: phaseId ?? view?.room.phaseId, expectedPlayerRevision: expectedRevision ?? view?.self.playerRevision, action, payload,
      });
      setView(next); setNowBase({ server: next.room.serverNow, local: Date.now() });
      if (action === 'deploy') { setFormationDraft(null); setSaveState('saved'); }
      setSelectedUnit(null);
      return true;
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '操作失败');
      await loadView(roomRef.current);
      return false;
    } finally { setBusy(false); }
  }, [userId, view?.room.phaseId, view?.self.playerRevision, busy, loadView]);

  // 提交类接口：成功时把响应体返回给调用方（create / join 的 roomId 由响应携带）。
  const post = useCallback(async <T,>(path: string, body: unknown): Promise<T | null> => {
    setBusy(true);
    try { return await callDuel<T>(userId, path, body); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : '操作失败'); return null; }
    finally { setBusy(false); }
  }, [userId]);

  // 战斗回放：按 battleId 拉取（轮询只带摘要）。回放 ID 含轮次前缀 r{round}-pvp / -A / -B；
  // 兼容无前缀的旧数据（pvp / A / B）。
  const ownBattleId = useMemo(() => {
    if (!view?.currentBattle?.battleIds?.length) return null;
    const battle = view.currentBattle;
    const suffix = battle.kind === 'pvp' ? 'pvp' : view.self.side;
    const wanted = 'r' + battle.round + '-' + suffix;
    return battle.battleIds.includes(wanted)
      ? wanted
      : battle.battleIds.find(id => id === suffix || id.endsWith('-' + suffix)) ?? battle.battleIds[0];
  }, [view]);
  useEffect(() => {
    if (!ownBattleId) { setReplay(null); return; }
    if (!roomRef.current || !view || !['combat', 'settlement', 'finished'].includes(view.room.phase)) return;
    if (replay?.battleId === ownBattleId) return; // 同一场回放不因阶段变化重新加载
    let cancelled = false;
    (async () => {
      try {
        const data = await callDuel<DuelReplay>(userId, '/api/duel/' + roomRef.current + '/battles/' + ownBattleId);
        if (!cancelled) { setReplay(data); setReplayTick(0); }
      } catch { /* 回放缺失不阻塞 */ }
    })();
    return () => { cancelled = true; };
  }, [ownBattleId, userId]);
  // 播放进度映射到战斗阶段剩余时间：恰好演完不早于截止；帧数多于剩余秒数时自动加速。
  // 阶段离开 combat 后停在最末帧（settlement / finished 不重置回开头）。
  useEffect(() => {
    if (!replay) return;
    const total = replay.sim.frames.length;
    if (!total) return;
    if (view?.room.phase !== 'combat') { setReplayTick(total - 1); return; }
    if (replayTick >= total - 1) return;
    const offset = nowBase.server ? nowBase.local - nowBase.server : 0;
    const remainingMs = Math.max(0, view.room.phaseEndsAt - (Date.now() - offset));
    // 帧间隔按剩余时间映射（40–600ms）；放不下时降低单帧间隔到 40ms 并一拍多帧
    // （抽帧加速）。合法镜像阵容可到 289+ 帧，固定下限 80ms 会在展示期结束前
    // 被截断跳末帧；此算法保证恰好在截止前播完，末帧定格展示交给 settlement。
    const framesLeft = total - 1 - replayTick;
    const interval = Math.max(40, Math.min(600, Math.floor(remainingMs / framesLeft)));
    const ticksLeft = Math.max(1, Math.floor(remainingMs / interval));
    const framesPerTick = Math.max(1, Math.ceil(framesLeft / ticksLeft));
    const timer = setTimeout(() => setReplayTick(value => Math.min(value + framesPerTick, total - 1)), interval);
    return () => clearTimeout(timer);
  }, [replay, replayTick, view?.room.phase, view?.room.phaseEndsAt, nowBase]);

  const clockOffset = nowBase.server ? nowBase.local - nowBase.server : 0;
  const secondsLeft = view ? Math.max(0, Math.ceil((view.room.phaseEndsAt - (Date.now() - clockOffset)) / 1000)) : 0;

  const effectiveFormation = formationDraft ?? view?.self.formation ?? [];
  const deployedIds = new Set(effectiveFormation.map(entry => entry.unitId));

  // 默认牌组与准备页展示同源：首次点击卡牌即从默认值初始化草稿，
  // 修复“初始 draft 为 null 时点击卡牌无响应”的问题。
  const defaultDraft = () => {
    const defs = [...maxByDef.keys()].slice(0, 8);
    return {
      defs,
      qualities: Object.fromEntries(defs.map(defId => [defId, maxByDef.get(defId) ?? 1])),
      starters: defs.slice(0, 2),
    };
  };
  function toggleLoadoutDef(defId: string) {
    setDraft(current => {
      const base = current ?? defaultDraft();
      const defs = base.defs.includes(defId) ? base.defs.filter(id => id !== defId) : base.defs.length >= 8 ? base.defs : [...base.defs, defId];
      const qualities = { ...base.qualities }; delete qualities[defId];
      qualities[defId] = maxByDef.get(defId) ?? 1;
      let starters = base.starters.filter(id => defs.includes(id));
      if (starters.length < 2 && defs.includes(defId) && !starters.includes(defId)) starters = [...starters, defId].slice(0, 2);
      return { defs, qualities, starters };
    });
  }

  // ── 大厅（无房间 / 未开始）──────────────────────────────────────────────
  if (!view) {
    return <section className="duel-lobby" role="region" aria-label="双人对战大厅">
      <div className="duel-lobby-copy">
        <span className="eyebrow">SHORT DUEL · 双人短局</span>
        <h1>与一位好友，九分钟定胜负</h1>
        <p>10 轮约 9 分 15 秒：3 轮野怪补给 + 7 轮交锋。开局选 8 张本命卡组与两个免费副本，人口自动成长，野怪送临时装备；生命归零或十轮后比较生命定胜局。</p>
        {error && <p className="duel-error" role="alert"><Info size={14}/> {error}</p>}
        <div className="duel-lobby-actions">
          <button className="gold-button" disabled={busy} onClick={async () => {
            // active lock 只在正式开局时创建：待准备房间必须直接用响应里的 roomId 进入。
            const created = await post<{ roomId: string }>('/api/duel/create', { requestId: makeRequestId() });
            if (created?.roomId) { applyRoomId(created.roomId); await loadView(created.roomId); }
          }}>创建对战房间</button>
          <form className="duel-join" onSubmit={async event => {
            event.preventDefault();
            if (!/^[A-Za-z0-9]{8}$/.test(joinCode.trim())) { setNotice('房间码是 8 位字母 / 数字'); return; }
            const joined = await post<{ roomId: string }>('/api/duel/join', { requestId: makeRequestId(), code: joinCode.trim().toUpperCase() });
            if (joined?.roomId) { applyRoomId(joined.roomId); await loadView(joined.roomId); }
          }}>
            <input value={joinCode} onChange={event => setJoinCode(event.target.value.toUpperCase())} placeholder="输入好友房间码" aria-label="房间码" maxLength={8}/>
            <button className="secondary-button" disabled={busy || joinCode.length !== 8}>加入房间</button>
          </form>
          {onBack && <button className="text-button" onClick={onBack}>返回收藏</button>}
        </div>
        {notice && <p className="duel-notice"><Info size={14}/> {notice}</p>}
        <p className="fineprint">两人房 · 邀请码进入 · 服务器权威计时与结算；局内金币与装备均为本局临时资产。</p>
      </div>
    </section>;
  }

  const room = view.room;
  const self = view.self;
  const opponent = view.opponent;
  // 与战斗内核同一套计数 + 星契徽记：面板不是另算一份预览。
  const synergyCards = effectiveFormation.flatMap(entry => {
    const unit = self.roster.find(item => item.unitId === entry.unitId);
    return unit ? [{ uid: unit.unitId, defId: unit.defId, rank: unit.quality, best: 0, stars: unit.stars }] : [];
  });
  const synergyList = applyAugmentTraitBonuses(
    synergyCards.length ? getSynergies(synergyCards, 7) : [],
    aggregateAugmentEffects((self.augments ?? []).filter(id => AUGMENT_MAP[id])).traitBonuses,
  ).filter(synergy => synergy.count > 0)
    .sort((a, b) => Number(b.active) - Number(a.active) || b.count - a.count || a.threshold - b.threshold || a.id.localeCompare(b.id));

  // ── 房间准备页（lobby：牌组 / 品质 / 开局副本 / 双方准备）─────────────────
  if (room.status === 'lobby') {
    const effectiveDraft = draft ?? defaultDraft();
    const roles = effectiveDraft.defs.map(defId => roleOf(defId));
    const hasFront = roles.some(r => ['坦克', '战士'].includes(r));
    const hasRanged = roles.some(r => ['射手', '法师'].includes(r));
    const loadoutValid = effectiveDraft.defs.length === 8 && effectiveDraft.starters.length === 2 && hasFront && hasRanged;
    const qualities = effectiveDraft.defs.map(defId => effectiveDraft.qualities[defId] ?? 1);
    const avgQuality = qualities.reduce((s, q) => s + q, 0) / (qualities.length || 1);
    return <section className="duel-lobby-room" aria-label="对战准备">
      <header className="duel-room-head">
        <h2>对战准备{room.inviteCode ? <span className="duel-invite">房间码 <b>{room.inviteCode}</b></span> : null}</h2>
        <div className="duel-room-status">
          <span><Users size={14}/> {self.name}（你{self.side === 'A' ? '·先手侧 A' : '·侧 B'}）{self.ready ? '已准备' : '未准备'}</span>
          {opponent && <span>{opponent.name}{opponent.ready ? ' 已准备' : ' 未准备'}</span>}
          {!opponent && <span className="duel-waiting">等待对方加入…（邀请码 {room.inviteCode}）</span>}
        </div>
      </header>
      <div className="duel-loadout">
        <p className="fineprint">从真实拥有的卡中选 <b>8 种</b>（至少 1 前排坦克 / 战士与 1 远程射手 / 法师）；每种锁定一个<b>本局品质</b>（默认最高，可降阶省钱），整局不变。再提名 <b>2 个开局副本</b>（免费，basis=0）。</p>
        <div className="duel-loadout-grid">
          {CARDS.filter(def => maxByDef.has(def.id)).map(def => {
            const picked = effectiveDraft.defs.includes(def.id);
            const maxQ = maxByDef.get(def.id) ?? 1;
            const q = effectiveDraft.qualities[def.id] ?? maxQ;
            return <div key={def.id} className={'duel-loadout-card' + (picked ? ' picked' : '')}>
              <button type="button" className="duel-loadout-pick" aria-pressed={picked} onClick={() => toggleLoadoutDef(def.id)}>
                <img src={'/art/' + def.art + '.png'} alt="" loading="lazy"/>
                <span>{def.name}</span><small>{roleOf(def.id)} · 拥有最高 {qualityName(maxQ)}</small>
              </button>
              {picked && <label className="duel-quality">本局品质
                <select value={q} onChange={event => setDraft({ ...effectiveDraft, qualities: { ...effectiveDraft.qualities, [def.id]: Number(event.target.value) } })}>
                  {QUALITY_TIERS.slice(0, maxQ).map(tier => <option key={tier.level} value={tier.level}>{tier.name} · {[10, 11, 12, 13, 14][tier.level - 1]} 金</option>)}
                </select></label>}
              {picked && <button type="button" className={'duel-starter' + (effectiveDraft.starters.includes(def.id) ? ' on' : '')}
                onClick={() => setDraft({ ...effectiveDraft, starters: effectiveDraft.starters.includes(def.id) ? effectiveDraft.starters.filter(id => id !== def.id) : [...effectiveDraft.starters, def.id].slice(-2) })}
                aria-pressed={effectiveDraft.starters.includes(def.id)}>{effectiveDraft.starters.includes(def.id) ? '开局副本 ✓' : '设为开局副本'}</button>}
            </div>;
          })}
        </div>
        <p className="duel-loadout-summary">已选 {effectiveDraft.defs.length}/8 · 开局副本 {effectiveDraft.starters.length}/2 · 平均本局品质 {avgQuality.toFixed(1)} · 预计招募价 {qualities.reduce((s, q) => s + [10, 11, 12, 13, 14][q - 1], 0)} 金/5 格</p>
        {!hasFront && <p className="duel-error">牌组需要至少一名前排（坦克 / 战士）。</p>}
        {!hasRanged && <p className="duel-error">牌组需要至少一名远程（射手 / 法师）。</p>}
        {opponent?.loadout && <p className="fineprint">对方已确认牌组：平均品质 {(opponent.loadout.defs.reduce((s, d) => s + d.battleQuality, 0) / 8).toFixed(1)}；高品质更强也更贵，价格联动用于预算取舍。</p>}
        <div className="duel-ready-row">
          <button className="secondary-button" disabled={busy} onClick={async () => {
            if (!loadoutValid) { setNotice('牌组还不满足要求'); return; }
            // 后端契约：defs 是 {defId,battleQuality} 数组；本地草稿的 defs 只是卡种 ID 串，
            // 品质在独立 qualities 表里，直接展开提交会被判“未知卡种”。
            const payload = {
              requestId: makeRequestId(),
              defs: effectiveDraft.defs.map(defId => ({ defId, battleQuality: effectiveDraft.qualities[defId] ?? 1 })),
              starters: effectiveDraft.starters,
            };
            if (await post('/api/duel/' + room.id + '/loadout', payload)) setNotice('牌组已提交');
          }}>保存牌组</button>
          <button className="gold-button" disabled={busy || !self.loadout} onClick={async () => {
            if (!self.loadout && !loadoutValid) { setNotice('请先保存牌组'); return; }
            if (await post('/api/duel/' + room.id + '/ready', { requestId: makeRequestId(), ready: !self.ready })) setNotice(self.ready ? '已取消准备' : '已准备');
          }}>{self.ready ? '取消准备' : '准备开战'}</button>
          <button className="text-button" disabled={busy} onClick={async () => { if (await post('/api/duel/' + room.id + '/leave', { requestId: makeRequestId(), action: 'leave' })) { stopDuelHeartbeat(); applyRoomId(null); setView(null); } }}>离开房间</button>
          {onBack && <button className="text-button" onClick={onBack} title="房间保留在等待，可随时从对战页回来">返回收藏</button>}
        </div>
        {notice && <p className="duel-notice"><Info size={14}/> {notice}</p>}
      </div>
    </section>;
  }

  // ── 终局 ────────────────────────────────────────────────────────────────
  if (room.status === 'finished') {
    const aborted = ['tick_failure', 'service_interrupted', 'disconnect_abort', 'lobby_expired'].includes(room.finishReason ?? '');
    const myOutcome = room.outcome === null ? 'draw' : room.outcome === self.side ? 'win' : 'loss';
    return <section className="duel-finished" aria-label="对战结束">
      <Trophy size={40}/>
      <h1>{aborted ? '对局已取消' : myOutcome === 'win' ? '胜利' : myOutcome === 'loss' ? '惜败' : '平局'}</h1>
      {!aborted && <p className="duel-final-hp">最终生命：{self.name} {self.hp} <Swords size={13}/> {opponent?.name} {opponent?.hp}</p>}
      <p className="fineprint">{room.finishReason === 'lobby_expired' ? '房间等待过期' : aborted ? '服务异常，本局已取消' : room.finishReason === 'surrender' ? '一方投降结束' : room.finishReason === 'disconnect_forfeit' ? '一方长期掉线自动判负' : room.finishReason === 'round10' ? '十轮结束比较生命' : room.finishReason === 'hp_zero' ? '生命归零' : '对局结束'}；局内金币、星级与装备全部清零，不带入永久资产。</p>
      {self.reward
        ? <>
            <p className="duel-final-reward" aria-label="本局星币结算">
              本局星币结算：<b className={self.reward.actualCoins > 0 ? 'duel-win' : 'duel-zero'}>{self.reward.actualCoins > 0 ? '+' : ''}{self.reward.actualCoins}</b> 星币
              {self.reward.actualCoins > 0 && self.reward.factor < 1 ? `（基础 ${self.reward.base} × 配额系数 ${self.reward.factor}）` : ''}
            </p>
            {rewardReasonText(self.reward.reason) && <p className="fineprint">{rewardReasonText(self.reward.reason)}。</p>}
          </>
        : <p className="fineprint">星币奖励与配额以服务器结算为准（胜 120 / 负 100 / 平 110 起测；同对手每日前 3 局全额、再 3 局半额）。</p>}
      <div className="duel-finished-actions">
        <button className="gold-button" onClick={() => { stopDuelHeartbeat(); onRewardClaimed(); applyRoomId(null); setView(null); }}>返回对战大厅</button>
        {onBack && <button className="secondary-button" onClick={onBack}>返回收藏</button>}
      </div>
    </section>;
  }

  const inPlanning = room.phase === 'planning';
  const frame = replay?.sim.frames[Math.min(replayTick, replay.sim.frames.length - 1)] ?? null;

  return <section className={'duel-arena phase-' + room.phase} aria-label="双人对战">
    <header className="duel-hud">
      <div className="duel-hud-side me"><b>{self.name}（你）</b><span className="duel-hp"><Heart size={14}/>{self.hp}</span><span className="duel-gold"><Coins size={14}/>{self.gold} 金币</span></div>
      <div className="duel-hud-mid">
        <span className="duel-round">R{room.round}/10 · {room.kind === 'neutral' ? '野怪补给' : '双方交锋'}</span>
        <span className="duel-timer">{inPlanning || room.phase === 'combat' ? secondsLeft + 's' : room.phase === 'simulating' ? '战斗演算中…' : '结算中…'}</span>
        <span className="duel-pop">人口 {self.population}{room.round < 10 ? ` → 下轮 ${[3, 3, 4, 4, 5, 5, 6, 6, 6, 6][room.round] + (self.populationBonus ?? 0)}` : ''}</span>
      </div>
      <div className="duel-hud-side foe"><b>{opponent?.name ?? '对手'}</b><span className="duel-hp"><Heart size={14}/>{opponent?.hp ?? '—'}</span></div>
    </header>
    {notice && <div className="duel-notice" role="status"><Info size={14}/>{notice}<button onClick={() => setNotice('')} aria-label="关闭"><X size={12}/></button></div>}
    {/* 星契对双方公开：对手已选的强化是侦察信息的一部分，未选候选不泄露。 */}
    {(self.augments.length > 0 || (opponent?.augments.length ?? 0) > 0) && <div className="duel-augment-strip" aria-label="本局星契">
      <div className="mine"><b>我方星契</b>{self.augments.map(id => {
        const augment = AUGMENT_MAP[id];
        return augment ? <span key={id} className="duel-augment-chip" data-tier={augment.tier} title={augment.description}>{augment.name}</span> : null;
      })}{!self.augments.length && <span className="fineprint">尚未选择</span>}</div>
      <div className="foe"><b>对方星契</b>{(opponent?.augments ?? []).map(id => {
        const augment = AUGMENT_MAP[id];
        return augment ? <span key={id} className="duel-augment-chip" data-tier={augment.tier} title={augment.description}>{augment.name}</span> : null;
      })}{!(opponent?.augments ?? []).length && <span className="fineprint">尚未选择</span>}</div>
    </div>}

    <div className="duel-main">
      <div className="duel-board-wrap">
        {/* 棋盘：8×7 六边形；B 端显示时整体 180° 旋转到己方在下（仅显示坐标变换）。 */}
        <div className="duel-board" aria-label="战场棋盘">
          {Array.from({ length: 8 }, (_, row) => Array.from({ length: 7 }, (_, col) => {
            // 显示、部署匹配与点击逆映射统一走 display 坐标：A 端 display=physical，
            // B 端 display=rotate180(physical)（cellCenter(rotate180) 恰为整体 180° 旋转后的
            // 格心，棋盘等距）。display 恒满足“己方半场 rows 4–7、slot=(row-4)*7+col”，
            // 与服务器 duelSideCell 的物理落位互为逆映射；回放帧仍按 physical 匹配。
            const physical = { row, col };
            const display = self.side === 'A' ? physical : rotate180(physical);
            const center = cellCenter(display);
            const inMyHalf = display.row >= 4;
            const isDeployable = inPlanning && inMyHalf;
            const placed = inPlanning
              ? effectiveFormation.find(entry => display.row === 4 + Math.floor(entry.localSlot / 7) && display.col === entry.localSlot % 7)
              : null;
            const unit = placed ? self.roster.find(u => u.unitId === placed.unitId) : null;
            const replayUnitHere = frame ? [...frame.sideA, ...frame.sideB].find(u => u.row === physical.row && u.col === physical.col) : null;
            return <button key={row + '-' + col} type="button"
              className={'duel-cell' + (inMyHalf ? ' mine' : '') + (unit ? ' occupied' : '') + (replayUnitHere ? ' combat' : '')}
              style={{ left: (center.x * 100) + '%', top: (center.y * 100) + '%' }}
              disabled={!isDeployable && !unit}
              aria-label={unit ? unit.defId + ' 星级' + unit.stars : isDeployable ? '部署格' : '战场格'}
              onClick={() => {
                if (!inPlanning) return;
                if (unit) { setSelectedUnit(unit.unitId); setFormationDraft(current => (current ?? self.formation).filter(entry => entry.unitId !== unit.unitId)); setSaveState('dirty'); return; }
                if (!selectedUnit) return;
                const localSlot = (display.row - 4) * 7 + display.col;
                const base = formationDraft ?? self.formation;
                const without = base.filter(entry => entry.unitId !== selectedUnit && entry.localSlot !== localSlot);
                setFormationDraft([...without, { unitId: selectedUnit, localSlot }]);
                setSaveState('dirty');
              }}>
              {unit && <span className="duel-chip" data-stars={unit.stars}>{CARD_MAP[unit.defId]?.name?.slice(0, 2)}{unit.stars > 1 ? '★' + unit.stars : ''}{unit.equippedItemIds?.length ? '装备' + unit.equippedItemIds.length : ''}</span>}
              {replayUnitHere && <span className={'duel-combat-chip ' + (replayUnitHere.side === self.side ? 'mine' : 'foe')} title={replayUnitHere.name}> {replayUnitHere.name.slice(0, 2)} {Math.round(replayUnitHere.hp / Math.max(1, replayUnitHere.maxHp) * 100)}%</span>}
            </button>;
          }))}
        </div>
        <div className="duel-board-tools">
          {inPlanning ? <>
            <button className="secondary-button" disabled={busy || !self.roster.length} onClick={() => { setFormationDraft(suggestFormation(self.roster, self.population)); setSaveState('dirty'); }}>推荐布阵</button>
            <button className={saveState === 'dirty' ? 'gold-button' : 'secondary-button'} disabled={busy || saveState !== 'dirty'} onClick={() => void command('deploy', { formation: formationDraft ?? self.formation })}>
              {saveState === 'dirty' ? '保存阵容' : '阵容已保存'}
            </button>
          </> : <span className="fineprint">{room.phase === 'combat' ? '战斗回放中（结果以服务器结算为准，跳过动画不改变截止时间）' : '等待阶段推进…'}</span>}
          <button className="text-button duel-surrender" disabled={busy} onClick={async () => {
            if (window.confirm('确认投降？本局将立即结束，对手获胜。')) { if (await post('/api/duel/' + room.id + '/leave', { requestId: makeRequestId(), action: 'surrender' })) await loadView(room.id); }
          }}>投降</button>
          {onBack && <button className="text-button" onClick={onBack} title="只是离开本页，对局继续按服务器时钟推进，不算投降">返回收藏</button>}
        </div>
        {view.scout && inPlanning && <div className="duel-scout" aria-label="侦察情报">
          <b>对手上一轮阵容（R{view.scout.round} 公开情报）</b>
          <div>{view.scout.units.map(u => <span key={u.unitId} className="duel-scout-unit">{CARD_MAP[u.defId]?.name ?? u.defId} {qualityName(u.quality)}{u.stars > 1 ? '★' + u.stars : ''}{u.itemDefIds?.length ? '·装备' + u.itemDefIds.length : ''}</span>)}</div>
        </div>}
      </div>

      <aside className="duel-side">
        {self.pendingAugmentOffer && inPlanning && <div className="duel-augment-choice" data-tier={self.pendingAugmentOffer.tier} aria-label="星契三选一">
          <b><Sparkles size={14}/> {AUGMENT_TIERS[self.pendingAugmentOffer.tier].name}：三选一</b>
          <p className="fineprint">仅本局有效；已选星契对对手公开，未选候选不公开。本阶段结束前未选将按候选顺序自动选第一项。</p>
          <div className="duel-augment-candidates">
            {self.pendingAugmentOffer.candidates.map(id => {
              const augment = AUGMENT_MAP[id];
              if (!augment) return null;
              return <button key={id} disabled={busy} onClick={() => void command('augment.select', { augmentId: id })}>
                <span className="duel-augment-tier" data-tier={augment.tier}>{AUGMENT_TIERS[augment.tier].name} · {AUGMENT_CATEGORY_NAMES[augment.category]}</span>
                <b>{augment.name}</b>
                <small>{augment.description}</small>
              </button>;
            })}
          </div>
        </div>}
        {self.pendingItemChoice && inPlanning && <div className="duel-item-choice" aria-label="装备三选一">
          <b><Sparkles size={14}/> 野怪补给：选择一件临时装备</b>
          <p className="fineprint">免费、仅本局有效；本阶段结束时未选将按固定顺序自动放入背包（不自动穿戴）。</p>
          <div className="duel-item-candidates">
            {self.pendingItemChoice.candidates.map(defId => {
              const def = itemDefOf(defId);
              return <button key={defId} disabled={busy} onClick={() => void command('item.select', { itemDefId: defId })}>
                <b>{def.name}</b><small>{def.description}</small>
              </button>;
            })}
          </div>
        </div>}
        {inPlanning && <>
          <div className="duel-synergies" aria-label="当前羁绊">
            <b>羁绊（按不同卡种计数）</b>
            <div className="duel-synergy-list">
              {synergyList.map(synergy => <span key={synergy.id} className={'duel-synergy' + (synergy.active ? ' active' : '')} title={synergy.description}>
                {synergyLabel(synergy.id, synergy.name)} <b>{synergy.count}/{synergy.threshold}</b>{synergy.active ? ' ✓' : ''}
              </span>)}
              {!synergyList.length && <span className="fineprint">上阵后显示羁绊进度；星契徽记会追加计数。</span>}
            </div>
          </div>
          <div className="duel-shop" aria-label="商店">
            <div className="duel-shop-head">
              <b>商店（{self.shop.length}/{self.shopSlots} 格）</b>
              <button className="secondary-button" disabled={busy || (self.freeRerolls <= 0 && self.gold < self.rerollCost)} onClick={() => void command('reroll', {})}>
                {self.freeRerolls > 0 ? `免费刷新（${self.freeRerolls}）` : `刷新 ${self.rerollCost} 金`}
              </button>
              <button className={self.shopLocked ? 'gold-button' : 'secondary-button'} disabled={busy} onClick={() => void command('lock', { locked: !self.shopLocked })}>{self.shopLocked ? '已锁店' : '锁店'}</button>
            </div>
            {self.shop.map(offer => <button key={offer.offerId} className="duel-offer" disabled={busy || self.gold < offer.cost} onClick={() => void command('buy', { offerId: offer.offerId })}>
              <img src={'/art/' + (CARD_MAP[offer.defId]?.art ?? 'moon-fawn') + '.png'} alt=""/>
              <span><b>{CARD_MAP[offer.defId]?.name ?? offer.defId}</b><small>{qualityName(offer.quality)} · 本局固定品质</small></span>
              <em>{offer.cost} 金</em>
            </button>)}
            {!self.shop.length && <p className="fineprint">货架已空：买一格不补格，可刷新或锁店保留到下轮。</p>}
          </div>
          <div className="duel-roster" aria-label="备战区">
            <b>备战区 {self.roster.length}/15（上阵 {effectiveFormation.length}/{self.population}）</b>
            {self.roster.map(unit => <div key={unit.unitId} className={'duel-unit' + (selectedUnit === unit.unitId ? ' selected' : '') + (deployedIds.has(unit.unitId) ? ' deployed' : '')}>
              <button onClick={() => setSelectedUnit(selectedUnit === unit.unitId ? null : unit.unitId)}>
                <b>{CARD_MAP[unit.defId]?.name ?? unit.defId}</b>
                <small>{qualityName(unit.quality)}{unit.stars > 1 ? ' · ★' + unit.stars : ''}{unit.equippedItemIds.length ? ' · 装备' + unit.equippedItemIds.length : ''}</small>
              </button>
              <span className="duel-unit-basis">{unit.basis} 金</span>
              <button className="duel-unit-sell" disabled={busy} title={'出售返还 basis ' + unit.basis + ' 金（装备先退回背包）'} onClick={() => void command('sell', { unitId: unit.unitId })}>售</button>
            </div>)}
          </div>
          <div className="duel-items" aria-label="装备背包">
            <b>装备背包（含穿戴中 {self.items.length}）· {self.itemSlots} 槽 / 单位</b>
            <div className="duel-item-list">
              {self.items.map(item => {
                const equippedBy = self.roster.find(u => u.equippedItemIds.includes(item.itemId));
                const def = itemDefOf(item.itemDefId);
                return <div key={item.itemId} className={'duel-item' + (selectedItem === item.itemId ? ' selected' : '') + (equippedBy ? ' equipped' : '')}>
                  <button onClick={() => setSelectedItem(selectedItem === item.itemId ? null : item.itemId)} title={def.description}>
                    <b>{def.name}</b><small>{equippedBy ? '穿戴于 ' + (CARD_MAP[equippedBy.defId]?.name ?? equippedBy.defId) : '背包中'}</small>
                  </button>
                  {selectedItem === item.itemId && selectedUnit && !equippedBy && <button className="gold-button" disabled={busy} onClick={() => { void command('item.equip', { itemId: item.itemId, unitId: selectedUnit }); setSelectedItem(null); }}>穿给选中单位</button>}
                  {equippedBy && <button className="secondary-button" disabled={busy} onClick={() => void command('item.unequip', { itemId: item.itemId })}>卸下</button>}
                </div>;
              })}
              {!self.items.length && <p className="fineprint">野怪补给的三选一装备会出现在这里；{self.itemSlots} 槽 / 单位，同组不重复，拆卸免费。</p>}
            </div>
          </div>
        </>}
        {!inPlanning && replay && <div className="duel-replay-panel" aria-label="战斗结果">
          <b>{replay.kind === 'pvp' ? '本轮交锋' : '野怪战斗'} · 帧 {Math.min(replayTick + 1, replay.sim.frames.length)}/{replay.sim.frames.length}</b>
          <p className={replay.sim.winner === null ? '' : replay.sim.winner === self.side ? 'duel-win' : 'duel-loss'}>
            {replay.sim.winner === null ? '平局' : replay.sim.winner === self.side ? '我方获胜' : '我方战败'}（{replay.sim.reason === 'elimination' ? '全灭' : '轮次上限比剩余生命'}）
          </p>
          <div className="duel-replay-log">{frame?.logs.map((entry, index) => <span key={index}>{entry.text}</span>)}</div>
          <div className="duel-replay-controls">
            <button className="secondary-button" onClick={() => setReplayTick(value => Math.max(0, value - 5))}>后退</button>
            <button className="secondary-button" onClick={() => setReplayTick(replay.sim.frames.length - 1)}>跳到结尾</button>
          </div>
        </div>}
        {!inPlanning && !replay && <div className="duel-replay-panel"><LoaderCircle className="combat-spin" size={18}/> 正在载入战斗结果…</div>}
        {self.lastIncome && <div className="duel-income fineprint" aria-label="上轮收入">
          上轮收入：利息 {self.lastIncome.interest} + 野怪保底 {self.lastIncome.neutralGuaranteed}{self.lastIncome.neutralWinBonus ? '（击杀 +' + self.lastIncome.neutralWinBonus + '）' : ''} + 交锋补给 {self.lastIncome.pvpSupply} = {self.lastIncome.total} 金
        </div>}
      </aside>
    </div>
  </section>;
}
