// 短局 1v1 主对局房间服务（DUEL-RULES-1）：两位真实玩家共享一个房间，
// 同 round / phase / deadline；野怪轮两人各打同一营地；PvP 一份权威结果。
// 事务边界（设计文档 13.3）：
//   冻结(短事务) → 事务外模拟 → 结果事务(条件更新) → 结算事务(共同截止) → 终局事务。
// 任何阶段崩溃都能从持久化的 frozen_input + combat_seed 恢复，不重新 roll。
// 隐私过滤在序列化层完成：对方商店 / 背包 / 修改中的站位不出现在任何响应里。
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { grantCoins, migrateProfileState } from '../src/engine.ts';
import { CARD_MAP } from '../src/data.ts';
import { getCombatStats } from '../src/battle.ts';
import { simulateDuel } from '../src/duel-sim.ts';
import { buildNeutralUnits } from '../src/neutral.ts';
import { validateEquip, duelItemDef, DUEL_ITEMS, DUEL_EQUIPMENT } from '../src/equipment.ts';
import {
  AUGMENTS, AUGMENT_MAP, AUGMENT_CHOICES, AUGMENT_MAX, augmentTierForRound,
  aggregateAugmentEffects,
} from '../src/augments.ts';
import {
  DUEL_RULES_VERSION, DUEL_ROUNDS, duelRoundRule, duelShopPrice, DUEL_LOADOUT, DUEL_GOLD,
  DUEL_STARS, DUEL_NEUTRAL_CAMPS, duelNeutralCamp, DUEL_REWARD, DUEL_ROOM,
} from '../src/duel-rules.ts';

const SECONDS = 1000;
function fail(message, status = 400, code) { const e = new Error(message); e.status = status; if (code) e.code = code; throw e; }
const parse = JSON.parse;
function xorshift(s) { let x = s >>> 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; }
function nextRandom(state) { state.rng = xorshift(state.rng || 0x9e3779b9); return state.rng / 4294967296; }
function hashInput(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function inviteCode() { const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const bytes = randomBytes(8); let code = ''; for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length]; return code; }
const FRONT_ROLES = ['坦克', '战士'];
const RANGED_ROLES = ['射手', '法师'];
const ABORT_REASONS = new Set(['tick_failure', 'service_interrupted', 'disconnect_abort', 'lobby_expired']);

export function createDuelService(db, options = {}) {
  const now = options.now ?? Date.now;
  const secureRandom = options.secureRandom ?? (() => randomBytes(4).readUInt32LE(0) / 4294967296);
  // 星契默认开启；关闭仅用于既有全量回归的固定基线 / 隔离测试，不是产品模式。
  const augmentsEnabled = options.augmentsEnabled ?? true;
  let inTransaction = false;
  function transaction(fn) {
    if (inTransaction) return fn();
    db.exec('BEGIN IMMEDIATE'); inTransaction = true;
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } finally { inTransaction = false; }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS duel_rooms(
      id TEXT PRIMARY KEY, invite_code TEXT UNIQUE NOT NULL, status TEXT NOT NULL,
      rules_version INTEGER NOT NULL, round_no INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL, phase_id TEXT NOT NULL,
      phase_ends_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, rng INTEGER NOT NULL,
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, finish_reason TEXT, outcome TEXT);
    CREATE INDEX IF NOT EXISTS duel_rooms_due ON duel_rooms(status, phase_ends_at);
    CREATE TABLE IF NOT EXISTS duel_participants(
      room_id TEXT NOT NULL REFERENCES duel_rooms(id), user_id TEXT NOT NULL REFERENCES users(id),
      side TEXT NOT NULL, name TEXT NOT NULL, loadout TEXT, state TEXT NOT NULL,
      player_revision INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER,
      UNIQUE(room_id, user_id), UNIQUE(room_id, side));
    CREATE INDEX IF NOT EXISTS duel_participant_user ON duel_participants(user_id);
    CREATE TABLE IF NOT EXISTS active_game_locks(user_id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS duel_rounds(
      room_id TEXT NOT NULL, round_no INTEGER NOT NULL, kind TEXT NOT NULL, frozen_input TEXT NOT NULL,
      input_hash TEXT NOT NULL, combat_seed INTEGER NOT NULL, status TEXT NOT NULL, result TEXT, battles TEXT,
      applied_at INTEGER, PRIMARY KEY(room_id, round_no));
    CREATE TABLE IF NOT EXISTS duel_item_choices(
      room_id TEXT NOT NULL, round_no INTEGER NOT NULL, user_id TEXT NOT NULL, candidates TEXT NOT NULL,
      selected_id TEXT, result_item_id TEXT, status TEXT NOT NULL, expires_phase_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(room_id, round_no, user_id));
    CREATE TABLE IF NOT EXISTS duel_pair_quota(
      day TEXT NOT NULL, user_a TEXT NOT NULL, user_b TEXT NOT NULL, eligible_rooms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, user_a, user_b));
    CREATE TABLE IF NOT EXISTS duel_rewards(
      room_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, base INTEGER NOT NULL,
      factor REAL NOT NULL, actual_coins INTEGER NOT NULL, reason TEXT, data TEXT, created_at INTEGER NOT NULL,
      UNIQUE(room_id, user_id, kind));
  `);
  // duel 服务直接依赖 game.mjs 的三张表；此处幂等补建（同一 DDL）。
  db.exec(`CREATE TABLE IF NOT EXISTS operations(user_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_id));
    CREATE TABLE IF NOT EXISTS reward_quota(user_id TEXT NOT NULL, day TEXT NOT NULL, matches INTEGER NOT NULL, PRIMARY KEY(user_id,day));`);

  // ── 读取辅助 ─────────────────────────────────────────────────────────────
  const roomRow = id => db.prepare('SELECT * FROM duel_rooms WHERE id=?').get(id);
  const participants = id => db.prepare('SELECT * FROM duel_participants WHERE room_id=? ORDER BY side').all(id);
  const participant = (id, userId) => db.prepare('SELECT * FROM duel_participants WHERE room_id=? AND user_id=?').get(id, userId);
  const playerState = row => parse(row.state);
  const writeParticipant = (row, state, extra = {}) => {
    // last_seen_at 只由玩家真实动作（view / 命令 / 准备 / 牌组）推进；服务端阶段写回
    // （冻结 / 结算 / 人口推进）不得刷新心跳，否则长期掉线判负永远不触发。
    db.prepare('UPDATE duel_participants SET state=?, player_revision=player_revision+1, ready=?, last_seen_at=COALESCE(?,last_seen_at), loadout=? WHERE room_id=? AND user_id=?')
      .run(JSON.stringify(state), extra.ready ?? row.ready, extra.lastSeenAt ?? null, extra.loadout ?? row.loadout ?? null, row.room_id, row.user_id);
  };
  function requireMember(room, user) {
    const row = participant(room.id, user.id);
    if (!row) fail('你不是该房间的成员', 403, 'ROOM_NOT_MEMBER');
    return row;
  }
  function activeLock(userId) { return db.prepare('SELECT * FROM active_game_locks WHERE user_id=?').get(userId) ?? null; }
  function legacyMatchPlaying(userId) {
    const row = db.prepare('SELECT state FROM matches WHERE user_id=?').get(userId);
    if (!row) return false;
    try { return parse(row.state)?.status === 'playing'; } catch { return false; }
  }
  function profileState(userId) {
    const row = db.prepare('SELECT * FROM profiles WHERE user_id=?').get(userId);
    if (!row) fail('玩家资料不存在', 404);
    return migrateProfileState(parse(row.state));
  }
  function saveProfile(userId, next) {
    if (next.cards.length > 10000) fail('卡牌数量达到上限');
    db.prepare('UPDATE profiles SET state=?, revision=revision+1 WHERE user_id=?').run(JSON.stringify(next), userId);
  }
  function ledger(userId, kind, coinsDelta, data, flow = 'transfer') {
    db.prepare('INSERT INTO ledger(id,user_id,kind,coins,dust,data,created_at,flow) VALUES(?,?,?,?,0,?,?,?)')
      .run(randomUUID(), userId, kind, coinsDelta, JSON.stringify(data), now(), flow);
  }

  // 旧库曾按固定 B 座写入产生同侧重复行。迁移按房间状态分流（须在读取辅助定义
  // 之后执行）：未开局 / 已结束的房间只需保留每组最早行；进行中的坏房间（同座
  // 重复已开局）必须原子终止并释放全部相关锁——只删参与者会留下孤儿
  // active_game_locks，被删者既进不了房也开不了新房，且房间因成员残缺无法终局。
  const duplicatedSides = db.prepare('SELECT DISTINCT room_id FROM duel_participants GROUP BY room_id, side HAVING COUNT(*)>1').all();
  for (const { room_id } of duplicatedSides) {
    const room = roomRow(room_id);
    if (room?.status === 'playing') finishRoom(room, { reason: 'service_interrupted', winner: null });
    else if (room?.status === 'lobby') {
      // 去重会移除成员：留守方准备状态必须失效（与 leave 同口径），否则新加入者
      // 一准备就绕过留守方再确认直接开局。
      db.prepare('UPDATE duel_participants SET ready=0 WHERE room_id=?').run(room_id);
      db.prepare('UPDATE duel_rooms SET revision=revision+1 WHERE id=?').run(room_id);
    }
  }
  db.exec(`DELETE FROM duel_participants WHERE rowid NOT IN (SELECT MIN(rowid) FROM duel_participants GROUP BY room_id, side);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_duel_participants_room_side ON duel_participants(room_id, side);`);

  // ── 初始玩家状态 / 商店 / 站位推荐 ───────────────────────────────────────
  function freshPlayerState(loadout) {
    return {
      hp: 32, gold: DUEL_GOLD.initial, population: duelRoundRule(1).population,
      shop: [], shopLocked: false, roster: [], formation: [], items: [],
      nextUnit: 1, nextItem: 1, rng: Math.floor(secureRandom() * 4294967296) >>> 0,
      activity: { meaningfulRounds: [], deployedDefIds: [] }, lastIncome: null, pendingItemChoiceId: null,
      // 星契（仅本局）：已选、待选三选一、本轮免费刷新次数、人口加成。
      augments: [], pendingAugmentOffer: null, freeRerolls: 0, populationBonus: 0,
    };
  }
  // 星契聚合只读 state，最多三个 id；所有派生值都从同一张表计算，避免 UI / 服务端口径分叉。
  function augmentEffectsOf(state) { return aggregateAugmentEffects(state.augments ?? []); }
  function effectiveShopSlots(state) { return DUEL_LOADOUT.shopSlots + augmentEffectsOf(state).shopSlotBonus; }
  function effectiveRerollCost(state) { return Math.max(0, DUEL_GOLD.rerollCost + augmentEffectsOf(state).rerollCostDelta); }
  function effectiveItemSlots(state) { return DUEL_EQUIPMENT.slotsPerUnit + augmentEffectsOf(state).itemSlotBonus; }
  function mergeGainOf(state) { return augmentEffectsOf(state).mergeGold; }
  const battleQualityOf = (loadout, defId) => loadout.defs.find(d => d.defId === defId)?.battleQuality;
  function rollShop(state, loadout) {
    const defs = loadout.defs;
    return Array.from({ length: effectiveShopSlots(state) }, () => {
      const def = defs[Math.floor(nextRandom(state) * defs.length)];
      const quality = def.battleQuality;
      return { offerId: 'o' + (state.nextOffer = (state.nextOffer ?? 0) + 1), defId: def.defId, quality, cost: duelShopPrice(quality) };
    });
  }
  function autoPlacement(state, limit) {
    const priority = { 坦克: 0, 战士: 1, 刺客: 2, 射手: 3, 法师: 4 };
    const units = [...state.roster].sort((a, b) => (priority[roleOf(a)] ?? 5) - (priority[roleOf(b)] ?? 5) || b.stars - a.stars).slice(0, limit);
    let front = 0, back = 0;
    return units.map(unit => {
      const melee = FRONT_ROLES.includes(roleOf(unit)) || roleOf(unit) === '刺客';
      const slot = melee ? [1, 3, 5, 8, 10, 12, 2][front++] : [22, 24, 26, 15, 17, 19, 21][back++];
      return { unitId: unit.unitId, localSlot: slot };
    });
  }
  function roleOf(unitLike) { return getCombatStats({ uid: 'x', defId: unitLike.defId, rank: unitLike.quality ?? 1, best: 0 }).role; }
  function markActivity(state, room, kind) {
    // 有效参与：真实改变状态的经营 / 部署 / 装备动作（同请求重放不重复执行到此处）。
    if (!state.activity.meaningfulRounds.includes(room.round_no)) state.activity.meaningfulRounds.push(room.round_no);
  }
  // 装备实例清单 items 含穿戴中的全部实例（引用模型）；退背包只是清掉单位引用，不新增实例。
  function returnItemsToInventory(state, unit) { unit.equippedItemIds = []; }
  // 局内合星：三同 defId + 同本局品质 + 同星 → 高一星；keeper 保留装备，材料装备退背包；basis 求和。
  function mergeUnits(state) {
    let merges = 0;
    for (let stars = 1; stars < DUEL_STARS.maxStars; stars++) {
      for (const key of new Set(state.roster.map(u => u.defId + ':' + u.quality))) {
        let copies = state.roster.filter(u => u.defId + ':' + u.quality === key && u.stars === stars);
        while (copies.length >= DUEL_STARS.requiredCopies) {
          copies.sort((a, b) => Number(state.formation.some(p => p.unitId === b.unitId)) - Number(state.formation.some(p => p.unitId === a.unitId)) || (a.unitId < b.unitId ? -1 : 1));
          const group = copies.slice(0, DUEL_STARS.requiredCopies), keeper = group[0];
          const removed = new Set(group.slice(1).map(u => u.unitId));
          for (const material of group.slice(1)) returnItemsToInventory(state, material);
          keeper.stars++;
          keeper.basis = group.reduce((sum, u) => sum + (u.basis ?? 0), 0);
          state.roster = state.roster.filter(u => !removed.has(u.unitId));
          state.formation = state.formation.filter(p => !removed.has(p.unitId));
          copies = state.roster.filter(u => u.defId + ':' + u.quality === key && u.stars === stars);
          merges++;
        }
      }
    }
    return merges;
  }

  // 星契选择：校验由命令层完成；这里只做一次性应用（人口、免费刷新、随机装备、聚合效果）。
  function applyAugment(state, augmentId, round) {
    const def = AUGMENT_MAP[augmentId];
    if (!def) fail('未知星契', 400, 'AUGMENT_INVALID');
    const owned = state.augments ?? [];
    if (owned.includes(augmentId)) fail('已经拥有这张星契', 409, 'AUGMENT_OWNED');
    if (owned.length >= AUGMENT_MAX) fail('星契数量已达上限', 409, 'AUGMENT_LIMIT');
    state.augments = [...owned, augmentId];
    const effects = aggregateAugmentEffects(state.augments);
    state.populationBonus = effects.populationBonus;
    state.population = duelRoundRule(round).population + state.populationBonus;
    state.freeRerolls = (state.freeRerolls ?? 0) + effects.grantFreeRerolls;
    if (effects.freeRerollsPerRound > 0) state.freeRerolls = Math.max(state.freeRerolls, effects.freeRerollsPerRound);
    let granted = 0;
    for (let index = 0; index < effects.grantRandomItems; index++) {
      if (state.items.length >= DUEL_EQUIPMENT.totalInstanceLimit) break;
      const itemDef = DUEL_ITEMS[Math.floor(nextRandom(state) * DUEL_ITEMS.length)];
      state.items.push({ itemId: 'i' + state.nextItem++, itemDefId: itemDef.id, kind: 'complete' });
      granted++;
    }
    state.pendingAugmentOffer = null;
    return { effects, granted };
  }
  // 同一轮双方共用一组候选（公平 / 可复盘）；候选与过期阶段一并持久化，重开浏览器不重抽。
  function offerAugments(room, nextRound) {
    // v1 存续房间不生成星契：规则版本隔离，不能把新玩法塞进旧局。
    const tier = augmentsEnabled && room.rules_version >= 2 ? augmentTierForRound(nextRound) : null;
    if (!tier) return null;
    const remaining = AUGMENTS.filter(augment => augment.tier === tier);
    const candidates = [];
    const roomState = { rng: room.rng };
    for (let index = 0; index < AUGMENT_CHOICES && remaining.length; index++) {
      const pick = Math.floor(nextRandom(roomState) * remaining.length);
      candidates.push(remaining[pick].id);
      remaining.splice(pick, 1);
    }
    db.prepare('UPDATE duel_rooms SET rng=? WHERE id=?').run(roomState.rng, room.id);
    return { round: nextRound, tier, candidates, expiresPhaseId: 'r' + nextRound + '-planning' };
  }

  // ── 房间创建 / 加入 / 准备 ───────────────────────────────────────────────
  function expireOwnLobbies(userId) {
    const expired=db.prepare("SELECT r.id FROM duel_rooms r JOIN duel_participants p ON p.room_id=r.id WHERE p.user_id=? AND r.status='lobby' AND r.phase_ends_at<=?").all(userId,now());
    for(const {id} of expired)abortLobby(roomRow(id),'lobby_expired');
  }
  function create(user, input = {}) {
    expireOwnLobbies(user.id);
    return transaction(() => {
      if (activeLock(user.id)) fail('请先完成当前进行中的对局', 409, 'ACTIVE_GAME_EXISTS');
      if (legacyMatchPlaying(user.id)) fail('你有一局进行中的旧单人局，请先完成或退出', 409, 'ACTIVE_GAME_EXISTS');
      const existingLobby = db.prepare("SELECT r.* FROM duel_rooms r JOIN duel_participants p ON p.room_id=r.id WHERE p.user_id=? AND r.status='lobby'").get(user.id);
      if (existingLobby) return { roomId: existingLobby.id, inviteCode: existingLobby.invite_code, resumed: true };
      const id = randomUUID();
      let code = inviteCode(), attempts = 0;
      while (db.prepare('SELECT 1 FROM duel_rooms WHERE invite_code=?').get(code) && attempts++ < 8) code = inviteCode();
      db.prepare('INSERT INTO duel_rooms(id,invite_code,status,rules_version,round_no,phase,phase_id,phase_ends_at,rng,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, code, 'lobby', DUEL_RULES_VERSION, 0, 'lobby', 'lobby', now() + DUEL_ROOM.lobbyExpiresSec * SECONDS, Math.floor(secureRandom() * 4294967296) >>> 0, now());
      db.prepare('INSERT INTO duel_participants(room_id,user_id,side,name,state,last_seen_at) VALUES(?,?,?,?,?,?)')
        .run(id, user.id, 'A', (user.name || '玩家').slice(0, 40), JSON.stringify(freshPlayerState(null)), now());
      return { roomId: id, inviteCode: code, resumed: false };
    });
  }
  function join(user, code) {
    if(typeof code!=='string'||!/^[A-Z0-9]{8}$/.test(code.trim().toUpperCase()))fail('房间码格式不正确');
    // 过期收口先独立提交；不能先取消再在同一事务内抛错，把取消也回滚掉。
    const candidate=db.prepare('SELECT * FROM duel_rooms WHERE invite_code=?').get(code.trim().toUpperCase());
    if(candidate?.status==='lobby'&&now()>=candidate.phase_ends_at){abortLobby(candidate,'lobby_expired');fail('房间等待已过期',409,'ROOM_FINISHED');}
    expireOwnLobbies(user.id);
    return transaction(() => {
      if (typeof code !== 'string' || !/^[A-Z0-9]{8}$/.test(code.trim().toUpperCase())) fail('房间码格式不正确');
      const room = db.prepare('SELECT * FROM duel_rooms WHERE invite_code=?').get(code.trim().toUpperCase());
      if (!room) fail('房间不存在', 404);
      if (room.status !== 'lobby' || room.phase !== 'lobby') fail('该房间已开始或已结束', 409, 'ROOM_FINISHED');
      if (now() >= room.phase_ends_at) fail('房间等待已过期', 409, 'ROOM_FINISHED');
      const self = participant(room.id, user.id);
      if (self) return { roomId: room.id, side: self.side, resumed: true };
      if (activeLock(user.id)) fail('请先完成当前进行中的对局', 409, 'ACTIVE_GAME_EXISTS');
      if (legacyMatchPlaying(user.id)) fail('你有一局进行中的旧单人局，请先完成或退出', 409, 'ACTIVE_GAME_EXISTS');
      const waiting=db.prepare("SELECT r.id FROM duel_rooms r JOIN duel_participants p ON p.room_id=r.id WHERE p.user_id=? AND r.status='lobby' AND r.id<>? LIMIT 1").get(user.id,room.id);
      if(waiting)fail('你已有一个等待中的房间，请先离开或等待结束',409,'LOBBY_EXISTS');
      const members = participants(room.id);
      if (members.length >= 2) fail('房间已满（每房间两名玩家）', 409, 'ROOM_FULL');
      // 动态补位：房主 A 离开后新加入者接手空缺的 A 座，不再固定写 B（评审修复）。
      const taken = new Set(members.map(m => m.side));
      const side = !taken.has('A') ? 'A' : !taken.has('B') ? 'B' : fail('房间已满（每房间两名玩家）', 409, 'ROOM_FULL');
      // 唯一约束兜底并发抢占最后席位：插入失败即 ROOM_FULL。
      try {
        db.prepare('INSERT INTO duel_participants(room_id,user_id,side,name,state,last_seen_at) VALUES(?,?,?,?,?,?)')
          .run(room.id, user.id, side, (user.name || '玩家').slice(0, 40), JSON.stringify(freshPlayerState(null)), now());
      } catch { fail('房间已满（每房间两名玩家）', 409, 'ROOM_FULL'); }
      return { roomId: room.id, side, resumed: false };
    });
  }
  function validateLoadout(cards, input) {
    const defs = input?.defs;
    if (!Array.isArray(defs) || defs.length !== DUEL_LOADOUT.definitionCount) fail('出战牌组必须恰好 8 个卡种', 400, 'LOADOUT_INVALID');
    const maxByDef = new Map();
    for (const card of cards) maxByDef.set(card.defId, Math.max(maxByDef.get(card.defId) ?? 0, card.rank));
    const seen = new Set();
    for (const entry of defs) {
      if (!entry || typeof entry.defId !== 'string' || !CARD_MAP[entry.defId]) fail('未知卡种', 400, 'LOADOUT_INVALID');
      if (seen.has(entry.defId)) fail('牌组卡种不能重复', 400, 'LOADOUT_INVALID');
      seen.add(entry.defId);
      const owned = maxByDef.get(entry.defId);
      if (!owned) fail('只能选择当前真实拥有的卡种：' + entry.defId, 400, 'QUALITY_NOT_OWNED');
      const q = entry.battleQuality;
      if (!Number.isInteger(q) || q < 1 || q > 5) fail('本局品质不合法', 400, 'LOADOUT_INVALID');
      if (q > owned) fail('本局品质不能超过最高拥有品质：' + entry.defId, 400, 'QUALITY_NOT_OWNED');
    }
    const roles = [...seen].map(defId => getCombatStats({ uid: 'x', defId, rank: 1, best: 0 }).role);
    if (!roles.some(r => FRONT_ROLES.includes(r))) fail('牌组至少需要一名前排（坦克 / 战士）', 400, 'LOADOUT_INVALID');
    if (!roles.some(r => RANGED_ROLES.includes(r))) fail('牌组至少需要一名远程（射手 / 法师）', 400, 'LOADOUT_INVALID');
    const starters = input?.starters;
    if (!Array.isArray(starters) || starters.length !== DUEL_LOADOUT.starterCopies || new Set(starters).size !== DUEL_LOADOUT.starterCopies) fail('需要两个不同的开局副本卡种', 400, 'LOADOUT_INVALID');
    for (const defId of starters) if (!seen.has(defId)) fail('开局副本必须来自出战牌组', 400, 'LOADOUT_INVALID');
    return { defs: defs.map(d => ({ defId: d.defId, battleQuality: d.battleQuality })), starters: [...starters] };
  }
  function loadout(user, roomId, input) {
    return transaction(() => {
      const room = roomRow(roomId);
      if (!room) fail('房间不存在', 404);
      const self = requireMember(room, user);
      if (room.status !== 'lobby' || room.phase !== 'lobby') fail('房间已开始，不能再修改牌组', 409, 'PHASE_CLOSED');
      if (self.ready) fail('已准备，请先取消准备再修改牌组', 409, 'PHASE_CLOSED');
      const snapshotLoadout = validateLoadout(profileState(user.id).cards, input);
      db.prepare('UPDATE duel_participants SET loadout=?, last_seen_at=? WHERE room_id=? AND user_id=?')
        .run(JSON.stringify(snapshotLoadout), now(), roomId, user.id);
      return { ok: true };
    });
  }
  function setReady(user, roomId, ready) {
    return transaction(() => {
      const room = roomRow(roomId);
      if (!room) fail('房间不存在', 404);
      const self = requireMember(room, user);
      if (room.status !== 'lobby' || room.phase !== 'lobby') fail('房间已开始', 409, 'PHASE_CLOSED');
      const members = participants(roomId);
      if (ready) {
        if (!self.loadout) fail('请先提交 8 卡种牌组与开局副本', 400, 'LOADOUT_INVALID');
        // 准备时重新校验当前真实收藏；期间卖卡导致不满足则要求重新确认，不悄悄降品质。
        validateLoadout(profileState(user.id).cards, parse(self.loadout));
      }
      db.prepare('UPDATE duel_participants SET ready=?, last_seen_at=? WHERE room_id=? AND user_id=?').run(ready ? 1 : 0, now(), roomId, user.id);
      const updated = participants(roomId);
      let started = false;
      if (ready && updated.length === 2 && updated.every(m => m.ready)) {
        startRoom(room, updated);
        started = true;
      }
      return { ok: true, started };
    });
  }
  function startRoom(room, members) {
    // 同事务：重验收藏、冻结 loadout 快照、发 40 金币 + 两免费副本（basis=0）、生成商店、上锁。
    const prepared = members.map(row => {
      const loadoutSnapshot = parse(row.loadout);
      validateLoadout(profileState(row.user_id).cards, loadoutSnapshot);
      return { row, loadout: loadoutSnapshot };
    });
    for (const { row } of prepared) {
      if (activeLock(row.user_id)) fail('有玩家正处于另一局对局中，无法开始', 409, 'ACTIVE_GAME_EXISTS');
      if (legacyMatchPlaying(row.user_id)) fail('有玩家正处于旧单人局中，无法开始', 409, 'ACTIVE_GAME_EXISTS');
    }
    for (const { row, loadout } of prepared) {
      const state = freshPlayerState(loadout);
      for (const defId of loadout.starters) {
        state.roster.push({ unitId: 'u' + state.nextUnit++, defId, quality: battleQualityOf(loadout, defId), stars: 1, basis: DUEL_LOADOUT.starterBasis, equippedItemIds: [] });
      }
      state.formation = autoPlacement(state, state.population);
      state.shop = rollShop(state, loadout);
      writeParticipant(row, state, { loadout: JSON.stringify(loadout), ready: 1 });
      db.prepare('INSERT OR REPLACE INTO active_game_locks(user_id,kind,ref_id) VALUES(?,?,?)').run(row.user_id, 'duel', room.id);
    }
    const rule = duelRoundRule(1);
    db.prepare("UPDATE duel_rooms SET status='playing', round_no=1, phase='planning', phase_id=?, phase_ends_at=?, started_at=?, revision=revision+1 WHERE id=? AND status='lobby'")
      .run('r1-planning', now() + rule.planningSec * SECONDS, now(), room.id);
  }

  // ── 命令（仅备战阶段；phaseId + 本人 playerRevision 校验）─────────────────
  function command(user, roomId, input) {
    const action = input?.action;
    const requestId = input?.requestId;
    if (typeof requestId !== 'string' || !/^[-a-zA-Z0-9]{8,80}$/.test(requestId)) fail('缺少有效的操作编号');
    const kind = 'duel.' + action;
    const payload = JSON.stringify(input);
    return transaction(() => {
      const prior = db.prepare('SELECT * FROM operations WHERE user_id=? AND request_id=?').get(user.id, requestId);
      if (prior) {
        if (prior.kind !== kind || prior.input !== payload) fail('操作编号已被其他请求使用', 409);
        const room = roomRow(roomId);
        return room && participant(room.id, user.id) ? view(user, room.id) : { error: 'ROOM_FINISHED', roomId };
      }
      const outcome = applyCommand(user, roomId, action, input);
      db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(user.id, requestId, kind, payload, JSON.stringify({ ok: true, roomId, summary: outcome?.summary ?? null }), now());
      return view(user, roomId);
    });
  }
  function applyCommand(user, roomId, action, input) {
    const room = roomRow(roomId);
    if (!room) fail('房间不存在', 404);
    const self = requireMember(room, user);
    if (room.status !== 'playing') fail('房间已结束', 409, 'ROOM_FINISHED');
    // 投降与 leave/surrender 共用胜负口径：显式写明对手获胜（finishRoom 不推导）。
    if (action === 'surrender') return finishRoom(room, { reason: 'surrender', loser: self.side, winner: self.side === 'A' ? 'B' : 'A' });
    if (action === 'xp') fail('短局对战不购买经验：人口按轮次自动提升', 400);
    if (room.phase !== 'planning') fail('当前不是备战阶段', 409, 'PHASE_CLOSED');
    // 事务内二次校验服务端截止时间：HTTP 入口的 catch-up tick 发生在读取请求体之前，
    // 请求体跨过 phase_ends_at 时仍可能到达这里，不能只信 phase/revision。
    if (now() >= room.phase_ends_at) fail('本阶段已到截止时间，等待服务器推进', 409, 'PHASE_CLOSED');
    if (input?.phaseId !== room.phase_id) fail('阶段编号不匹配，请刷新后重试', 409, 'PHASE_CLOSED');
    if (input?.expectedPlayerRevision === undefined || input.expectedPlayerRevision !== self.player_revision)
      fail('本地状态已过期（playerRevision 不匹配）', 409, 'STALE_PLAYER_REVISION');
    const loadout = parse(self.loadout);
    const state = playerState(self);
    const pay = cost => { if (state.gold < cost) fail('局内金币不足', 409, 'INSUFFICIENT_GOLD'); state.gold -= cost; };
    let summary = {};
    if (action === 'buy') {
      const index = state.shop.findIndex(o => o.offerId === input.payload?.offerId);
      if (index < 0) fail('这个商店卡位已被购买或刷新', 409, 'OFFER_UNAVAILABLE');
      const offer = state.shop[index];
      pay(offer.cost);
      state.roster.push({ unitId: 'u' + state.nextUnit++, defId: offer.defId, quality: offer.quality, stars: 1, basis: offer.cost, equippedItemIds: [] });
      state.shop.splice(index, 1); // 买一格只移走该格，不免费补格（S01）
      const merges = mergeUnits(state);
      const mergeGold = mergeGainOf(state);
      if (merges && mergeGold) state.gold += merges * mergeGold;
      if (state.roster.length > DUEL_LOADOUT.rosterLimit) fail('备战区已满，请先卖出或合星', 409, 'ROSTER_FULL');
      markActivity(state, room); summary = { bought: offer.defId, merged: merges, mergeGold: merges * mergeGold };
    } else if (action === 'sell') {
      const unit = state.roster.find(u => u.unitId === input.payload?.unitId);
      if (!unit) fail('没有这个局内单位', 409);
      returnItemsToInventory(state, unit); // 出售单位先退回全部装备（E06）
      state.gold += unit.basis ?? 0;
      state.roster = state.roster.filter(u => u.unitId !== unit.unitId);
      state.formation = state.formation.filter(p => p.unitId !== unit.unitId);
      markActivity(state, room); summary = { sold: unit.defId, refunded: unit.basis ?? 0 };
    } else if (action === 'reroll') {
      // 「免费重掷」星契先消耗本轮免费次数，不扣金币；折扣价最低 0。
      const free = (state.freeRerolls ?? 0) > 0;
      if (free) state.freeRerolls -= 1; else pay(effectiveRerollCost(state));
      state.shop = rollShop(state, loadout);
      markActivity(state, room); summary = { rerolled: true, free, cost: free ? 0 : effectiveRerollCost(state) };
    } else if (action === 'lock') {
      if (typeof input.payload?.locked !== 'boolean') fail('锁店状态不合法');
      state.shopLocked = input.payload.locked;
    } else if (action === 'augment.select') {
      if (!augmentsEnabled) fail('本局没有启用星契', 400, 'AUGMENT_DISABLED');
      const offer = state.pendingAugmentOffer;
      if (!offer) fail('当前没有待选择的星契', 409, 'AUGMENT_CHOICE_CLOSED');
      if (offer.expiresPhaseId !== room.phase_id) fail('星契选择窗口已关闭', 409, 'AUGMENT_CHOICE_CLOSED');
      const augmentId = input.payload?.augmentId;
      if (typeof augmentId !== 'string' || !offer.candidates.includes(augmentId)) fail('候选中没有这张星契', 400, 'AUGMENT_INVALID');
      const applied = applyAugment(state, augmentId, room.round_no);
      markActivity(state, room);
      summary = { augment: augmentId, grantedItems: applied.granted, population: state.population };
    } else if (action === 'deploy') {
      const formation = input.payload?.formation;
      if (!Array.isArray(formation) || formation.length > state.population) fail('上阵数量超过当前人口');
      if (formation.some(p => !p || typeof p.unitId !== 'string' || !state.roster.some(u => u.unitId === p.unitId) || !Number.isInteger(p.localSlot) || p.localSlot < 0 || p.localSlot > 27)
        || new Set(formation.map(p => p.unitId)).size !== formation.length || new Set(formation.map(p => p.localSlot)).size !== formation.length) fail('阵容或站位不合法');
      const changed = JSON.stringify(state.formation) !== JSON.stringify(formation.map(({ unitId, localSlot }) => ({ unitId, localSlot })));
      state.formation = formation.map(({ unitId, localSlot }) => ({ unitId, localSlot }));
      if (changed) markActivity(state, room); // 无变化的重复部署不计有效参与（W03）
      summary = { deployed: formation.length };
    } else if (action === 'item.select') {
      const itemDefId = input.payload?.itemDefId;
      const choice = db.prepare("SELECT * FROM duel_item_choices WHERE room_id=? AND user_id=? AND status='pending' ORDER BY round_no DESC LIMIT 1").get(room.id, user.id);
      if (!choice) fail('当前没有待选择的装备', 409, 'ITEM_CHOICE_CLOSED');
      if (choice.expires_phase_id !== room.phase_id) fail('装备选择窗口已关闭', 409, 'ITEM_CHOICE_CLOSED');
      const candidates = parse(choice.candidates);
      if (!candidates.includes(itemDefId)) fail('候选中没有这件装备', 400, 'ITEM_NOT_OWNED');
      if (state.items.length >= DUEL_EQUIPMENT.totalInstanceLimit) fail('装备背包已满', 409, 'ITEM_SLOT_FULL');
      const itemId = 'i' + state.nextItem++;
      state.items.push({ itemId, itemDefId, kind: 'complete' });
      state.pendingItemChoiceId = null;
      const updated = db.prepare("UPDATE duel_item_choices SET status='selected', selected_id=?, result_item_id=? WHERE room_id=? AND round_no=? AND user_id=? AND status='pending'")
        .run(itemDefId, itemId, room.id, choice.round_no, user.id);
      if (!updated.changes) fail('装备选择已被处理', 409, 'ITEM_CHOICE_CLOSED');
      markActivity(state, room); summary = { selected: itemDefId, itemId };
    } else if (action === 'item.equip') {
      const item = state.items.find(i => i.itemId === input.payload?.itemId);
      if (!item) fail('不拥有这件装备', 409, 'ITEM_NOT_OWNED');
      if (state.roster.some(u => (u.equippedItemIds ?? []).includes(item.itemId))) fail('该装备已被穿戴', 409, 'ITEM_NOT_OWNED');
      const unit = state.roster.find(u => u.unitId === input.payload?.unitId);
      if (!unit) fail('没有这个局内单位', 409);
      validateEquip((unit.equippedItemIds ?? []).map(id => state.items.find(i => i.itemId === id)?.itemDefId).filter(Boolean), item.itemDefId, effectiveItemSlots(state));
      (unit.equippedItemIds ??= []).push(item.itemId);
      markActivity(state, room); summary = { equipped: item.itemDefId, unitId: unit.unitId };
    } else if (action === 'item.unequip') {
      const unit = state.roster.find(u => (u.equippedItemIds ?? []).includes(input.payload?.itemId));
      if (!unit) fail('该装备没有被穿戴', 409);
      unit.equippedItemIds = unit.equippedItemIds.filter(id => id !== input.payload.itemId);
      markActivity(state, room); summary = { unequipped: input.payload.itemId };
    } else fail('不支持的对战操作', 404);
    writeParticipant(self, state, { lastSeenAt: now() });
    db.prepare('UPDATE duel_rooms SET revision=revision+1 WHERE id=?').run(room.id);
    return { summary };
  }

  // ── 冻结 → 模拟 → 结果 → 结算（服务端时钟推进，不依赖浏览器轮询）──────────
  function sideInputFrom(state, loadout) {
    const deployed = state.formation.map(p => ({ p, unit: state.roster.find(u => u.unitId === p.unitId) })).filter(e => e.unit);
    return {
      units: deployed.map(({ unit }) => ({
        unitId: unit.unitId, defId: unit.defId, quality: unit.quality, stars: unit.stars,
        itemDefIds: (unit.equippedItemIds ?? []).map(id => state.items.find(i => i.itemId === id)?.itemDefId).filter(Boolean),
      })),
      formation: deployed.map(({ p }) => ({ unitId: p.unitId, localSlot: p.localSlot })),
      augments: [...(state.augments ?? [])],
    };
  }
  function expireItemChoices(room) {
    // 备战截止时处理到期免费装备选择：固定候选顺序选第一件入背包，不自动穿戴（E03）。
    const pending = db.prepare("SELECT * FROM duel_item_choices WHERE room_id=? AND status='pending' AND expires_phase_id=?").all(room.id, room.phase_id);
    for (const choice of pending) {
      const row = participant(room.id, choice.user_id);
      const state = playerState(row);
      const candidates = parse(choice.candidates);
      const chosen = candidates[0];
      if (state.items.length < DUEL_EQUIPMENT.totalInstanceLimit) {
        const itemId = 'i' + state.nextItem++;
        state.items.push({ itemId, itemDefId: chosen, kind: 'complete' });
        state.pendingItemChoiceId = null;
        writeParticipant(row, state);
        db.prepare("UPDATE duel_item_choices SET status='auto', selected_id=?, result_item_id=? WHERE room_id=? AND round_no=? AND user_id=? AND status='pending'")
          .run(chosen, itemId, room.id, choice.round_no, choice.user_id);
      } else {
        db.prepare("UPDATE duel_item_choices SET status='auto', selected_id=? WHERE room_id=? AND round_no=? AND user_id=? AND status='pending'")
          .run(chosen, room.id, choice.round_no, choice.user_id);
      }
    }
  }
  function freezeRound(room) {
    const rule = duelRoundRule(room.round_no);
    expireItemChoices(room);
    const members = participants(room.id);
    const sides = {};
    for (const row of members) {
      const state = playerState(row);
      // 星契到期未选：按固定候选顺序自动选第一项（与装备 E03 同口径），不额外拖长阶段。
      if (augmentsEnabled && state.pendingAugmentOffer) {
        const candidate = state.pendingAugmentOffer.candidates[0];
        if ((state.augments ?? []).length < AUGMENT_MAX && !(state.augments ?? []).includes(candidate)) {
          applyAugment(state, candidate, room.round_no);
        } else {
          state.pendingAugmentOffer = null; // 迁移 / 异常数据不阻断 tick
        }
      }
      // 回退到双方最后合法阵容：过滤已售单位、截断超人口、空阵但有库存时自动补位。
      state.formation = state.formation.filter(p => state.roster.some(u => u.unitId === p.unitId)).slice(0, state.population);
      if (!state.formation.length && state.roster.length) state.formation = autoPlacement(state, state.population);
      state.activity.deployedDefIds = [...new Set([...state.activity.deployedDefIds, ...state.formation.map(p => state.roster.find(u => u.unitId === p.unitId)?.defId).filter(Boolean)])];
      sides[row.side] = sideInputFrom(state, parse(row.loadout));
      writeParticipant(row, state);
    }
    const roomState = { rng: room.rng };
    nextRandom(roomState);
    const combatSeed = roomState.rng;
    const frozenInput = { roundNumber: room.round_no, kind: rule.kind, rulesVersion: room.rules_version, sides };
    const inputHash = hashInput(frozenInput);
    db.prepare('INSERT INTO duel_rounds(room_id,round_no,kind,frozen_input,input_hash,combat_seed,status) VALUES(?,?,?,?,?,?,?)')
      .run(room.id, room.round_no, rule.kind, JSON.stringify(frozenInput), inputHash, combatSeed, 'frozen');
    db.prepare("UPDATE duel_rooms SET phase='simulating', phase_id=?, phase_ends_at=?, rng=?, revision=revision+1 WHERE id=? AND phase='planning'")
      .run('r' + room.round_no + '-simulating', now() + 2 * SECONDS, roomState.rng, room.id);
    return { round: room.round_no, kind: rule.kind, frozenInput, combatSeed };
  }
  function runSimulation(frozen, combatSeed) {
    const seedB = (combatSeed ^ 0x5bf03635) >>> 0;
    // 回放 ID 必须含轮次前缀（r{round}-pvp / r{round}-A / r{round}-B）：
    // 每轮复用 'pvp'/'A'/'B' 会让按轮次升序的回放查询永远命中旧轮。
    if (frozen.kind === 'pvp') {
      const sim = simulateDuel({ roundNumber: frozen.roundNumber, combatSeed, rulesVersion: frozen.rulesVersion ?? 1, sideA: frozen.sides.A, sideB: frozen.sides.B });
      return {
        kind: 'pvp', winner: sim.winner,
        battles: { ['r' + frozen.roundNumber + '-pvp']: sim },
        summary: { pvp: { winner: sim.winner, reason: sim.reason } },
      };
    }
    const camp = buildNeutralUnits(frozen.roundNumber);
    const neutralSide = { units: camp.map(m => ({ kind: 'neutral', ...m })), formation: camp.map(m => ({ unitId: m.unitId, localSlot: m.localSlot })) };
    const simA = simulateDuel({ roundNumber: frozen.roundNumber, combatSeed, rulesVersion: frozen.rulesVersion ?? 1, sideA: frozen.sides.A, sideB: neutralSide });
    const simB = simulateDuel({ roundNumber: frozen.roundNumber, combatSeed: seedB, rulesVersion: frozen.rulesVersion ?? 1, sideA: frozen.sides.B, sideB: neutralSide });
    return {
      kind: 'neutral',
      battles: { ['r' + frozen.roundNumber + '-A']: simA, ['r' + frozen.roundNumber + '-B']: simB },
      summary: { neutral: { A: simA.winner === 'A', B: simB.winner === 'A' } }, // true = 该玩家击败营地
    };
  }
  function storeResult(room) {
    const row = db.prepare('SELECT * FROM duel_rounds WHERE room_id=? AND round_no=?').get(room.id, room.round_no);
    if (!row || row.status !== 'frozen') return false;
    const frozen = parse(row.frozen_input);
    const outcome = runSimulation(frozen, row.combat_seed); // 重模拟在 SQLite 写锁外完成
    const rule = duelRoundRule(room.round_no);
    return transaction(() => {
      // 条件更新：重复 worker / GET / 重启只复用已写结果，不二次应用。
      const applied = db.prepare("UPDATE duel_rounds SET status='resolved', result=?, battles=? WHERE room_id=? AND round_no=? AND status='frozen'")
        .run(JSON.stringify(outcome.summary), JSON.stringify(outcome.battles), room.id, room.round_no);
      if (!applied.changes) return false;
      db.prepare("UPDATE duel_rooms SET phase='combat', phase_id=?, phase_ends_at=?, revision=revision+1 WHERE id=? AND status='playing' AND phase='simulating'")
        .run('r' + room.round_no + '-combat', now() + rule.combatPresentationSec * SECONDS, room.id);
      return true;
    });
  }
  function settleRound(room) {
    const rule = duelRoundRule(room.round_no);
    const roundRow = db.prepare('SELECT * FROM duel_rounds WHERE room_id=? AND round_no=?').get(room.id, room.round_no);
    if (!roundRow || roundRow.status !== 'resolved') return;
    const summary = parse(roundRow.result);
    const members = participants(room.id);
    const terminal = room.round_no === DUEL_ROUNDS.length;
    let decided = null, decidedReason = null;
    for (const row of members) {
      const state = playerState(row);
      const effects = augmentEffectsOf(state);
      const income = { interest: 0, neutralGuaranteed: 0, neutralWinBonus: 0, pvpSupply: 0, total: 0 };
      if (!terminal) {
        // 利息基数 = 本轮战斗前已冻结存款（战斗期禁止消费，与冻结值一致）。
        income.interest = Math.min(DUEL_GOLD.interest.cap + effects.interestCapBonus, Math.floor(state.gold / DUEL_GOLD.interest.per) * DUEL_GOLD.interest.step);
      }
      if (rule.kind === 'pvp') {
        const winner = summary.pvp?.winner ?? null;
        if (winner && winner !== row.side && rule.pvpLossHp > 0) state.hp = Math.max(0, state.hp - rule.pvpLossHp);
        if (!terminal) income.pvpSupply = DUEL_GOLD.pvpSupplyPerPlayer; // 与胜负无关（G03）
        if (state.hp <= 0) { decided = decided ?? (row.side === 'A' ? 'B' : 'A'); decidedReason = 'hp_zero'; }
      } else {
        const camp = duelNeutralCamp(room.round_no);
        // 野怪金币是保底供给；「战利品风暴」只放大这一份，不改变失败照发规则。
        income.neutralGuaranteed = Math.round(camp.guaranteedGold * (1 + effects.neutralGoldPct));
        const won = row.side === 'A' ? summary.neutral?.A : summary.neutral?.B;
        if (won) income.neutralWinBonus = Math.round(camp.winBonusGold * (1 + effects.neutralGoldPct));
        if (camp.guaranteedEquipmentChoice) state.pendingItemChoiceId = room.id + ':r' + room.round_no;
      }
      income.total = income.interest + income.neutralGuaranteed + income.neutralWinBonus + income.pvpSupply;
      state.gold += income.total;
      state.lastIncome = income;
      writeParticipant(row, state);
    }
    if (rule.kind === 'neutral') createItemChoices(room);
    db.prepare('UPDATE duel_rounds SET applied_at=? WHERE room_id=? AND round_no=?').run(now(), room.id, room.round_no);
    if (decided || terminal) {
      // R10 比较 life 决定胜负；同生命为整局平局（B07）。进入短暂结算展示后终局。
      if (terminal && !decided) {
        const [a, b] = ['A', 'B'].map(side => playerState(participants(room.id).find(m => m.side === side)));
        decided = a.hp > b.hp ? 'A' : b.hp > a.hp ? 'B' : null;
        decidedReason = 'round10';
      }
      db.prepare("UPDATE duel_rooms SET phase='settlement', phase_id=?, phase_ends_at=?, outcome=COALESCE(?,outcome), finish_reason=COALESCE(?,finish_reason), revision=revision+1 WHERE id=? AND status='playing'")
        .run('r' + room.round_no + '-final', now() + rule.settlementSec * SECONDS, decided, decidedReason, room.id);
    } else {
      db.prepare("UPDATE duel_rooms SET phase='settlement', phase_id=?, phase_ends_at=?, revision=revision+1 WHERE id=? AND status='playing'")
        .run('r' + room.round_no + '-settlement', now() + rule.settlementSec * SECONDS, room.id);
    }
  }
  function createItemChoices(room) {
    // 基础三候选（进攻 / 防御 / 功能各一件）双方同集；星契的「战利品」只给本人追加候选。
    const roomState = { rng: room.rng };
    const byGroup = {};
    for (const group of ['offense', 'defense', 'utility']) {
      const pool = DUEL_ITEMS.filter(i => i.choiceGroup === group);
      byGroup[group] = pool[Math.floor(nextRandom(roomState) * pool.length)].id;
    }
    const base = [byGroup.offense, byGroup.defense, byGroup.utility];
    const nextPhaseId = 'r' + (room.round_no + 1) + '-planning';
    for (const row of participants(room.id)) {
      const state = playerState(row);
      const extra = augmentEffectsOf(state).itemCandidateBonus;
      const candidates = [...base];
      if (extra > 0) {
        const remaining = DUEL_ITEMS.filter(item => !candidates.includes(item.id));
        for (let index = 0; index < extra && remaining.length; index++) {
          const pick = Math.floor(nextRandom(roomState) * remaining.length);
          candidates.push(remaining[pick].id);
          remaining.splice(pick, 1);
        }
      }
      db.prepare('INSERT OR IGNORE INTO duel_item_choices(room_id,round_no,user_id,candidates,status,expires_phase_id,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(room.id, room.round_no, row.user_id, JSON.stringify(candidates), 'pending', nextPhaseId, now());
    }
    db.prepare('UPDATE duel_rooms SET rng=? WHERE id=?').run(roomState.rng, room.id);
  }
  function nextPlanning(room) {
    const nextRound = room.round_no + 1;
    const rule = duelRoundRule(nextRound);
    const offer = offerAugments(room, nextRound);
    for (const row of participants(room.id)) {
      const state = playerState(row);
      const effects = augmentEffectsOf(state);
      state.population = rule.population + effects.populationBonus; // 人口按轮次自动 3→4→5→6 + 星契加成（G04）
      if (nextRound >= DUEL_GOLD.baseFromRound) state.gold += DUEL_GOLD.basePerRound + effects.goldPerRound;
      state.freeRerolls = effects.freeRerollsPerRound > 0 ? effects.freeRerollsPerRound : (state.freeRerolls ?? 0); // 每轮刷新不累计；一次性赠送可跨轮保留
      const hasTier = offer && (state.augments ?? []).some(id => AUGMENT_MAP[id]?.tier === offer.tier);
      state.pendingAugmentOffer = offer && !hasTier ? { ...offer } : null;
      if (!state.shopLocked) state.shop = rollShop(state, parse(row.loadout)); // 备战开始免费刷新一次；锁店保留剩余格不补满（S02）
      writeParticipant(row, state);
    }
    db.prepare("UPDATE duel_rooms SET round_no=?, phase='planning', phase_id=?, phase_ends_at=?, revision=revision+1 WHERE id=? AND status='playing'")
      .run(nextRound, 'r' + nextRound + '-planning', now() + rule.planningSec * SECONDS, room.id);
  }

  // ── 终局：奖励 / 配额 / ledger / 锁释放同事务（一次结算）──────────────────
  function eligibility(state, room, side, forfeited, elapsedRounds) {
    const reasons = [];
    if (forfeited) reasons.push('forfeited');
    // 非投降方按实际完成轮数判定（2026-10-15 产品确认）：对手在第 N 轮提前投降 /
    // 掉线时赢家无法控制被截断的轮次，有效备战轮门槛取 min(4, 已完成轮数)。
    const requiredRounds = forfeited
      ? DUEL_REWARD.minMeaningfulPlanningRounds
      : Math.min(DUEL_REWARD.minMeaningfulPlanningRounds, elapsedRounds);
    if (new Set(state.activity.meaningfulRounds).size < requiredRounds) reasons.push('insufficient_activity_rounds');
    if (new Set(state.activity.deployedDefIds).size < DUEL_REWARD.minDistinctEverDeployed) reasons.push('insufficient_deployed_defs');
    if (room.started_at && now() - room.started_at < DUEL_REWARD.minimumForfeitOpponentSec * SECONDS) reasons.push('room_too_short');
    return { eligible: reasons.length === 0, reasons };
  }
  function quotaFactors(room, members) {
    const day = new Date(now()).toISOString().slice(0, 10); // UTC 日界（W07）
    const sorted = [...members].sort((a, b) => (a.user_id < b.user_id ? -1 : 1));
    const personalOf = member => {
      const used = db.prepare('SELECT matches n FROM reward_quota WHERE user_id=? AND day=?').get(member.user_id, day)?.n ?? 0;
      const { full, half } = DUEL_REWARD.personalQuota;
      const factor = used < full ? 1 : used < full + half ? 0.5 : 0;
      return { member, used, factor };
    };
    // 防御：终局时不足两人（迁移清理 / 异常数据）不适用 pair 配额，只按个人配额，不再抛错。
    if (sorted.length < 2) return { day, userA: sorted[0], userB: sorted[0], pairUsed: 0, pairFactor: 1, personal: sorted.map(personalOf) };
    const [userA, userB] = sorted;
    const pairRow = db.prepare('SELECT * FROM duel_pair_quota WHERE day=? AND user_a=? AND user_b=?').get(day, userA.user_id, userB.user_id);
    const pairUsed = pairRow?.eligible_rooms ?? 0;
    const pairFactor = pairUsed < DUEL_REWARD.pairQuota.full ? 1 : pairUsed < DUEL_REWARD.pairQuota.full + DUEL_REWARD.pairQuota.half ? 0.5 : 0;
    return { day, userA, userB, pairUsed, pairFactor, personal: sorted.map(personalOf) };
  }
  function finishRoom(room, opts = {}) {
    // 终局整体事务：房间置 finished、发币、配额、ledger 与锁释放必须一并发提交或回滚。
    // tick / leave / command 三条入口都可能在没有外层事务时到达这里；隔离故障注入已复现
    // “A 到账、B 未到账但房间已结束、重试无法补齐”，故收口在此而不是依赖调用方。
    return transaction(() => finishRoomOnce(room, opts));
  }
  function finishRoomOnce(room, opts = {}) {
    // 结束时刻的已完成轮数必须在 claim 前读取：claim 更新会立刻把 phase 覆写成
    // finished；备战期被截断视为只完成前 N-1 轮（本轮备战未走满，不苛求赢家参与）。
    const current = roomRow(room.id) ?? room;
    const elapsedRounds = Math.max(0, current.phase === 'planning' ? current.round_no - 1 : current.round_no);
    // 幂等：只有 status='playing' 的房间能结算一次（并发投降 / timer / 重启互斥）。
    const claimed = db.prepare("UPDATE duel_rooms SET status='finished', phase='finished', phase_id='finished', phase_ends_at=?, finished_at=?, outcome=CASE WHEN ? THEN NULL ELSE COALESCE(?,outcome) END, finish_reason=COALESCE(?,finish_reason), revision=revision+1 WHERE id=? AND status IN ('playing','lobby')")
      .run(now(), now(), ABORT_REASONS.has(opts.reason) ? 1 : 0, opts.winner ?? null, opts.reason ?? null, room.id);
    if (!claimed.changes) return { alreadyFinished: true };
    const finished = roomRow(room.id);
    const members = participants(room.id);
    // 按房间清理全部 duel 锁，而不是只遍历现存成员：参与者行可能已残缺
    // （迁移 / 异常数据删除成员），遗留被删者的锁会令其永远无法开新房
    // （评审修复：tick 不会清理已结束房间，终局事务是唯一收口点）。
    db.prepare("DELETE FROM active_game_locks WHERE kind='duel' AND ref_id=?").run(room.id);
    const quotas = quotaFactors(finished, members);
    let pairCounted = false;
    for (const row of members) {
      const state = playerState(row);
      // 主动投降与长期掉线判负同口径：被判定方 0 奖励（12.2）。
      const forfeited = (opts.reason === 'surrender' || opts.reason === 'disconnect_forfeit') && opts.loser === row.side;
      const serviceAbort = ABORT_REASONS.has(opts.reason);
      const check = eligibility(state, finished, row.side, forfeited, elapsedRounds);
      let base = 0, factor = 0, coins = 0, reason = '';
      if (serviceAbort) { reason = 'service_abort'; }
      else if (forfeited) { reason = 'forfeited'; }
      else if (!check.eligible) { reason = check.reasons.join(','); }
      else {
        const outcome = finished.outcome;
        base = outcome === null ? DUEL_REWARD.base.draw : outcome === row.side ? DUEL_REWARD.base.win : DUEL_REWARD.base.loss;
        const personal = quotas.personal.find(p => p.member.user_id === row.user_id);
        factor = Math.min(personal.factor, quotas.pairFactor); // 取 min，不相乘（W05）
        coins = Math.floor(base * factor);
        reason = factor < 1 ? (personal.factor < quotas.pairFactor ? 'personal_quota' : 'pair_quota') : '';
        if (!pairCounted) {
          db.prepare('INSERT INTO duel_pair_quota(day,user_a,user_b,eligible_rooms) VALUES(?,?,?,1) ON CONFLICT(day,user_a,user_b) DO UPDATE SET eligible_rooms=eligible_rooms+1')
            .run(quotas.day, quotas.userA.user_id, quotas.userB.user_id);
          pairCounted = true; // 一次房间只占一个 pair 次数
        }
        // 有资格即占一次个人次数（配额为 0 也记录完成、不发币）。
        db.prepare('INSERT INTO reward_quota(user_id,day,matches) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET matches=matches+1').run(row.user_id, quotas.day);
        if (coins > 0) {
          const profile = profileState(row.user_id);
          grantCoins(profile, coins, false);
          saveProfile(row.user_id, profile);
          ledger(row.user_id, 'duel.finish', coins, { roomId: room.id, outcome: finished.outcome, base, factor, reason }, 'faucet');
        }
      }
      db.prepare('INSERT OR IGNORE INTO duel_rewards(room_id,user_id,kind,base,factor,actual_coins,reason,data,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(room.id, row.user_id, 'match', base, factor, coins, reason, JSON.stringify({ outcome: finished.outcome, finishReason: finished.finish_reason, quota: { pair: quotas.pairFactor, personal: quotas.personal.find(p => p.member.user_id === row.user_id)?.factor } }), now());
    }
    return { finished: true };
  }
  function abortLobby(room, reason) {
    // 大厅没有比赛奖励：取消不经过配额/资格/战斗状态解析，单人或坏 JSON 也能收口。
    return transaction(()=>{
      const changed=db.prepare("UPDATE duel_rooms SET status='finished',phase='finished',phase_id='finished',phase_ends_at=?,finished_at=?,finish_reason=?,outcome=NULL,revision=revision+1 WHERE id=? AND status='lobby'").run(now(),now(),reason,room.id);
      if(!changed.changes)return {alreadyFinished:true};
      db.prepare("DELETE FROM active_game_locks WHERE kind='duel' AND ref_id=?").run(room.id);
      db.prepare("INSERT OR IGNORE INTO duel_rewards(room_id,user_id,kind,base,factor,actual_coins,reason,data,created_at) SELECT room_id,user_id,'match',0,0,0,'service_abort',?,? FROM duel_participants WHERE room_id=?")
        .run(JSON.stringify({outcome:null,finishReason:reason}),now(),room.id);
      return {finished:true};
    });
  }
  // 单方长期失联判定（11.4）：恰好一方超过宽限（disconnectGraceSec）无心跳、
  // 另一方仍在线才判负；双方同时失联不在此收口——房间继续按服务器时钟推进，
  // 由 10 分钟长期中断保护按 service_interrupted 无奖励 abort。
  function disconnectedSide(room) {
    const members = participants(room.id);
    if (members.length !== 2) return null;
    const stale = members.filter(m => m.last_seen_at == null || now() - m.last_seen_at > DUEL_ROOM.disconnectGraceSec * SECONDS);
    return stale.length === 1 ? stale[0].side : null;
  }

  // ── 调度器：推进所有到期房间（服务端时钟，~1s 扫描）──────────────────────
  // 连续失败计数：due 批次按 phase_ends_at 升序且 LIMIT 50，异常房间若永不收口，
  // 会一直占据批次头部把后面的正常对局饿死；连续失败达到阈值必须强制终结。
  const tickFailures = new Map();
  function tick() {
    // 正式对局和大厅清理各有独立预算；大量过期大厅不再挤占正式对局的 50 个名额。
    const due = [
      ...db.prepare("SELECT id FROM duel_rooms WHERE status='playing' AND phase_ends_at<=? ORDER BY phase_ends_at,id LIMIT 50").all(now()),
      ...db.prepare("SELECT id FROM duel_rooms WHERE status='lobby' AND phase_ends_at<=? ORDER BY phase_ends_at,id LIMIT 50").all(now()),
    ];
    for (const { id } of due) {
      let room = roomRow(id);
      if (!room) continue;
      let ok = true;
      try {
        if (room.status === 'lobby') {
          if (now() >= room.phase_ends_at) abortLobby(room, 'lobby_expired');
          continue;
        }
        // 长期中断保护：房间到期超过 10 分钟仍未推进按 service_interrupted 结束（D05）。
        if (now() - room.phase_ends_at > 10 * 60 * SECONDS) { finishRoom(room, { reason: 'service_interrupted', winner: null }); continue; }
        // 长期掉线自动判负（11.4）：单方超宽限未心跳且对方在线 → 掉线方判负、对手获胜。
        const disconnected = disconnectedSide(room);
        if (disconnected) { finishRoom(room, { reason: 'disconnect_forfeit', loser: disconnected, winner: disconnected === 'A' ? 'B' : 'A' }); continue; }
        if (room.phase === 'planning') {
          const frozen = transaction(() => {
            const fresh = roomRow(id);
            if (!fresh || fresh.status !== 'playing' || fresh.phase !== 'planning' || now() < fresh.phase_ends_at) return null;
            return freezeRound(fresh);
          });
          if (frozen) storeResult(roomRow(id));
          room = roomRow(id);
        }
        if (room && room.status === 'playing' && room.phase === 'simulating') {
          // 冻结输入 + seed 已持久化：本 tick 立即出结果；崩溃后由这里确定性重算。
          storeResult(room);
          room = roomRow(id);
        }
        if (room && room.status === 'playing' && room.phase === 'combat' && now() >= room.phase_ends_at) {
          transaction(() => {
            const fresh = roomRow(id);
            if (!fresh || fresh.status !== 'playing' || fresh.phase !== 'combat' || now() < fresh.phase_ends_at) return;
            settleRound(fresh);
          });
          room = roomRow(id);
        }
        if (room && room.status === 'playing' && room.phase === 'settlement' && now() >= room.phase_ends_at) {
          const fresh = roomRow(id);
          if (!fresh) continue;
          if (fresh.finish_reason || fresh.round_no >= DUEL_ROUNDS.length) finishRoom(fresh, { reason: fresh.finish_reason ?? 'round10', winner: fresh.outcome ?? null });
          else transaction(() => { const again = roomRow(id); if (again && again.status === 'playing' && again.phase === 'settlement' && now() >= again.phase_ends_at) nextPlanning(again); });
        }
      } catch (error) {
        ok = false;
        // 单房间故障不阻塞调度；持续失败由长期中断保护收口为 abort。
        console.error('duel tick failed for room', id, error?.message || error);
        const failures = (tickFailures.get(id) ?? 0) + 1;
        tickFailures.set(id, failures);
        if (failures >= 5) forceCloseRoom(id, room);
      } finally {
        if (ok) tickFailures.delete(id);
      }
    }
    return due.length;
  }
  // 兜底收口：正常结算管线自身崩溃时强制终结房间并释放锁，保证它离开 due 批次。
  // 正常管线也失败时，不解析损坏状态，原子写入取消原因、零奖励与锁释放。
  function forceCloseRoom(id, room) {
    try {
      finishRoom(roomRow(id) ?? room, { reason: 'service_interrupted', winner: null });
    } catch (fatal) {
      console.error('duel tick force-close fallback', id, fatal?.message || fatal);
      try {
        transaction(() => {
          const previous = roomRow(id) ?? room;
          const changed = db.prepare("UPDATE duel_rooms SET status='finished', phase='finished', phase_id='finished', phase_ends_at=?, finished_at=?, finish_reason='tick_failure', outcome=NULL, revision=revision+1 WHERE id=? AND status IN ('playing','lobby')").run(now(), now(), id);
          if (!changed.changes) return;
          db.prepare("DELETE FROM active_game_locks WHERE kind='duel' AND ref_id=?").run(id);
          const data = JSON.stringify({ outcome: null, finishReason: 'tick_failure', previousOutcome: previous.outcome, previousFinishReason: previous.finish_reason });
          db.prepare("INSERT OR IGNORE INTO duel_rewards(room_id,user_id,kind,base,factor,actual_coins,reason,data,created_at) SELECT room_id,user_id,'match',0,0,0,'service_abort',?,? FROM duel_participants WHERE room_id=?")
            .run(data, now(), id);
        });
      } catch (raw) { console.error('duel tick force-close raw failed', id, raw?.message || raw); }
    } finally {
      tickFailures.delete(id);
    }
  }

  // ── 视图（隐私过滤在服务端序列化层完成）──────────────────────────────────
  function battleIdsOf(room) {
    const row = db.prepare('SELECT * FROM duel_rounds WHERE room_id=? AND round_no=?').get(room.id, room.round_no);
    if (!row || !row.battles) return [];
    return Object.keys(parse(row.battles));
  }
  function abortedRoomView(room, self) {
    // 只读取关系字段与奖励标量，不解析 state/loadout/回放 JSON；原始坏数据留存排查。
    const opponent = participants(room.id).find(row => row.user_id !== self.user_id);
    const reward = db.prepare("SELECT base, factor, actual_coins, reason FROM duel_rewards WHERE room_id=? AND user_id=? AND kind='match'").get(room.id, self.user_id);
    const round = Number.isInteger(room.round_no) && room.round_no >= 1 && room.round_no <= DUEL_ROUNDS.length ? room.round_no : 0;
    return {
      room: {
        id: room.id, status: 'finished', rulesVersion: room.rules_version, round,
        kind: round ? duelRoundRule(round).kind : null, phase: 'finished', phaseId: 'finished',
        phaseEndsAt: room.phase_ends_at, serverNow: now(), revision: room.revision, startedAt: room.started_at,
        outcome: null, finishReason: room.finish_reason, population: 0,
      },
      self: {
        side: self.side, ready: false, playerRevision: self.player_revision, name: self.name, loadout: null,
        // 取消对局不展示战斗统计；这些空值仅用于保持视图结构，不冒充真实最终生命。
        hp: 0, gold: 0, population: 0, shop: [], shopLocked: false, roster: [], formation: [], items: [],
        lastIncome: null, activity: { meaningfulRounds: [], deployedDefIds: [] }, pendingItemChoice: null,
        augments: [], pendingAugmentOffer: null, rerollCost: DUEL_GOLD.rerollCost, freeRerolls: 0,
        shopSlots: DUEL_LOADOUT.shopSlots, itemSlots: DUEL_EQUIPMENT.slotsPerUnit, populationBonus: 0,
        reward: reward ? { base: reward.base, factor: reward.factor, actualCoins: reward.actual_coins, reason: reward.reason }
          : { base: 0, factor: 0, actualCoins: 0, reason: 'service_abort' },
      },
      opponent: opponent ? { side: opponent.side, name: opponent.name, ready: false, loadout: null, hp: 0, population: 0, augments: [] } : null,
      scout: null, currentBattle: null,
    };
  }
  function view(user, roomId) {
    const room = roomRow(roomId);
    if (!room) fail('房间不存在', 404);
    const self = requireMember(room, user);
    db.prepare('UPDATE duel_participants SET last_seen_at=? WHERE room_id=? AND user_id=?').run(now(), roomId, user.id);
    if (room.status === 'finished' && ABORT_REASONS.has(room.finish_reason)) return abortedRoomView(room, self);
    const others = participants(roomId).filter(m => m.user_id !== user.id);
    const state = playerState(self);
    const loadout = self.loadout ? parse(self.loadout) : null;
    // 侦察：仅最近一次已冻结公开的阵容（战斗/结算期=当轮，备战期=上一轮）；
    // 对方当前商店 / 背包 / 修改中的站位不发送（I01/I02）。
    let opponentScout = null;
    const publicRound = db.prepare('SELECT * FROM duel_rounds WHERE room_id=? AND battles IS NOT NULL ORDER BY round_no DESC LIMIT 1').get(roomId);
    if (publicRound) {
      const frozen = parse(publicRound.frozen_input);
      const opponentSide = others[0]?.side;
      if (opponentSide && frozen.sides?.[opponentSide]) opponentScout = { round: publicRound.round_no, side: opponentSide, ...frozen.sides[opponentSide] };
    }
    const roundRow = db.prepare('SELECT * FROM duel_rounds WHERE room_id=? AND round_no=?').get(roomId, room.round_no);
    const pendingChoice = db.prepare("SELECT * FROM duel_item_choices WHERE room_id=? AND user_id=? AND status='pending' ORDER BY round_no DESC LIMIT 1").get(roomId, user.id);
    // 终局奖励详情（12.2 / 15.4）：前端展示实际到账与无奖励原因的唯一数据来源。
    const rewardRow = room.status === 'finished'
      ? db.prepare("SELECT base, factor, actual_coins, reason FROM duel_rewards WHERE room_id=? AND user_id=? AND kind='match'").get(roomId, user.id)
      : null;
    return {
      room: {
        id: room.id, inviteCode: room.status === 'lobby' ? room.invite_code : undefined,
        status: room.status, rulesVersion: room.rules_version, round: room.round_no,
        kind: room.round_no >= 1 ? duelRoundRule(room.round_no).kind : null,
        phase: room.phase, phaseId: room.phase_id, phaseEndsAt: room.phase_ends_at,
        serverNow: now(), revision: room.revision, startedAt: room.started_at,
        outcome: room.status === 'finished' ? room.outcome : undefined,
        finishReason: room.status === 'finished' ? room.finish_reason : undefined,
        population: room.round_no >= 1 ? duelRoundRule(room.round_no).population : 3,
      },
      self: {
        side: self.side, ready: !!self.ready, playerRevision: self.player_revision, name: self.name,
        loadout, hp: state.hp, gold: state.gold, population: state.population,
        shop: state.shop, shopLocked: state.shopLocked, roster: state.roster, formation: state.formation,
        items: state.items, lastIncome: state.lastIncome, activity: { meaningfulRounds: state.activity.meaningfulRounds, deployedDefIds: state.activity.deployedDefIds },
        pendingItemChoice: pendingChoice ? { round: pendingChoice.round_no, candidates: parse(pendingChoice.candidates), expiresPhaseId: pendingChoice.expires_phase_id, status: pendingChoice.status } : null,
        augments: state.augments ?? [], pendingAugmentOffer: state.pendingAugmentOffer ?? null,
        rerollCost: effectiveRerollCost(state), freeRerolls: state.freeRerolls ?? 0,
        shopSlots: effectiveShopSlots(state), itemSlots: effectiveItemSlots(state), populationBonus: state.populationBonus ?? 0,
        reward: rewardRow ? { base: rewardRow.base, factor: rewardRow.factor, actualCoins: rewardRow.actual_coins, reason: rewardRow.reason } : null,
      },
      opponent: others.map(m => {
        const opponentState = playerState(m);
        return {
          side: m.side, name: m.name, ready: !!m.ready, loadout: m.ready && m.loadout ? parse(m.loadout) : null,
          hp: opponentState.hp, population: opponentState.population, augments: opponentState.augments ?? [],
        };
      })[0] ?? null,
      scout: opponentScout,
      currentBattle: roundRow && roundRow.status !== 'frozen' ? {
        round: roundRow.round_no, kind: roundRow.kind, status: roundRow.status,
        summary: roundRow.result ? parse(roundRow.result) : null, battleIds: battleIdsOf(room),
      } : null,
    };
  }
  function battle(user, roomId, battleId) {
    const room = roomRow(roomId);
    if (!room) fail('房间不存在', 404);
    requireMember(room, user); // 非成员不能读回放（R06）
    const all = db.prepare('SELECT * FROM duel_rounds WHERE room_id=? ORDER BY round_no').all(roomId);
    // 新回放 ID 自带轮次前缀 r{round}-…：命中行的轮次必须与 ID 声明一致（防跨轮串台）。
    const declaredRound = /^r(\d+)-/.exec(String(battleId));
    for (const roundRow of all) {
      if (!roundRow.battles) continue;
      if (declaredRound && Number(declaredRound[1]) !== roundRow.round_no) continue;
      const battles = parse(roundRow.battles);
      if (battles[battleId]) return { battleId, round: roundRow.round_no, kind: roundRow.kind, sim: battles[battleId] };
    }
    fail('回放不存在', 404);
  }
  function me(user) {
    const lock = activeLock(user.id);
    const active = lock?.kind === 'duel' ? roomRow(lock.ref_id) : null;
    // 待准备（lobby）房间也参与恢复：active lock 只在正式开局时创建，
    // 刷新后必须能找回自己创建 / 加入但还没开打的房间。
    const lobby = active ? null : db.prepare("SELECT r.* FROM duel_rooms r JOIN duel_participants p ON p.room_id=r.id WHERE p.user_id=? AND r.status='lobby' ORDER BY r.created_at DESC LIMIT 1").get(user.id) ?? null;
    const current = active ?? lobby;
    const lastFinished = db.prepare("SELECT r.id, r.outcome, r.finish_reason, r.finished_at FROM duel_rooms r JOIN duel_participants p ON p.room_id=r.id WHERE p.user_id=? AND r.status='finished' ORDER BY r.finished_at DESC LIMIT 1").get(user.id);
    return { activeRoomId: current?.id ?? null, activeStatus: current ? { status: current.status, round: current.round_no, phase: current.phase } : null, lastFinishedRoomId: lastFinished?.id ?? null };
  }
  function leave(user, roomId, action) {
    const room = roomRow(roomId);
    if (!room) fail('房间不存在', 404);
    const self = requireMember(room, user);
    if (room.status === 'lobby' && action === 'leave') {
      db.prepare('DELETE FROM duel_participants WHERE room_id=? AND user_id=?').run(roomId, user.id);
      const remaining = participants(roomId);
      if (remaining.length === 0) db.prepare("DELETE FROM duel_rooms WHERE id=? AND status='lobby'").run(roomId);
      else {
        // 留守方准备状态失效：有人离开后不得与新加入者直接触发开局（评审修复）。
        db.prepare('UPDATE duel_participants SET ready=0 WHERE room_id=?').run(roomId);
        db.prepare('UPDATE duel_rooms SET revision=revision+1 WHERE id=?').run(roomId);
      }
      return { left: true };
    }
    if (action === 'surrender') {
      if (room.status === 'finished') return { surrendered: false, alreadyFinished: true };
      const result = finishRoom(room, { reason: 'surrender', loser: self.side, winner: self.side === 'A' ? 'B' : 'A' });
      return { surrendered: true, alreadyFinished: result.alreadyFinished ?? false };
    }
    fail('当前阶段不能执行该操作', 409, 'PHASE_CLOSED');
  }
  // command 里的投降走 applyCommand → finishRoom；HTTP leave/surrender 走这里。
  return { create, join, loadout, setReady, command, view, battle, me, leave, tick, tables: 'duel' };
}
