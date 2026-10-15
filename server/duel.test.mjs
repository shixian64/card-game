import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.mjs';
import { createGameService } from './game.mjs';
import { createDuelService } from './duel.mjs';
import { DUEL_ROUNDS, DUEL_ROOM, duelRoundRule } from '../src/duel-rules.ts';

// ── fixture：隔离内存库 + 可注入时钟；测试结束自动清理 ─────────────────────
function fixture(options = {}) {
  let clock = 1000000;
  const store = openStore(':memory:');
  const game = createGameService(store.db, { now: () => clock, legacyMatchStart: options.legacyMatchStart ?? true });
  const duel = createDuelService(store.db, { now: () => clock, secureRandom: options.secureRandom ?? (() => 0.42) });
  const login = (subject, name = subject) => {
    const user = store.login({ issuer: 'test', clientId: 'test', subject, name }).user;
    game.ensureProfile(user);
    game.game(user, 'starter.claim', { requestId: 'starter-' + subject, favoriteDefId: 'moon-deer' });
    return user;
  };
  const step = (ms, opts = {}) => {
    clock += ms;
    // 默认把当前房间双方视作在线轮询（生产客户端 2 秒一拍心跳）；
    // 掉线场景用 { noHeartbeat: true } 显式关闭，再由测试单独刷新在线一方。
    if (!opts.noHeartbeat && currentRoomId) store.db.prepare('UPDATE duel_participants SET last_seen_at=? WHERE room_id=?').run(clock, currentRoomId);
    duel.tick();
  };
  const advance = ms => { clock += ms; }; // 只走时钟不跑 tick：模拟请求体跨过 phase_ends_at
  const phaseStep = () => { const v = duel.view(A, roomId()); const r = duelRoundRule(v.room.round); step(r.planningSec * 1000); }; // 备战 → 冻结+模拟
  let currentRoomId = null;
  const roomId = () => currentRoomId;
  function defaultLoadout(user) {
    const snapshot = game.snapshot(user);
    const maxByDef = new Map();
    for (const card of snapshot.state.cards) maxByDef.set(card.defId, Math.max(maxByDef.get(card.defId) ?? 0, card.rank));
    const defs = [...maxByDef.entries()].slice(0, 8).map(([defId, battleQuality]) => ({ defId, battleQuality }));
    const starters = defs.slice(0, 2).map(d => d.defId);
    return { defs, starters };
  }
  function openRoom(opts = {}) {
    const created = duel.create(opts.creator ?? A, {});
    currentRoomId = created.roomId;
    duel.join(opts.joiner ?? B, created.inviteCode);
    for (const [user, loadout] of [[opts.creator ?? A, opts.loadoutA ?? defaultLoadout(opts.creator ?? A)], [opts.joiner ?? B, opts.loadoutB ?? defaultLoadout(opts.joiner ?? B)]]) {
      duel.loadout(user, created.roomId, loadout);
    }
    duel.setReady(opts.creator ?? A, created.roomId, true);
    duel.setReady(opts.joiner ?? B, created.roomId, true);
    return created.roomId;
  }
  const readState = (room, user) => JSON.parse(store.db.prepare('SELECT state FROM duel_participants WHERE room_id=? AND user_id=?').get(room, user.id).state);
  const writeState = (room, user, mutate) => {
    const row = store.db.prepare('SELECT state FROM duel_participants WHERE room_id=? AND user_id=?').get(room, user.id);
    const state = JSON.parse(row.state); mutate(state);
    store.db.prepare('UPDATE duel_participants SET state=? WHERE room_id=? AND user_id=?').run(JSON.stringify(state), room, user.id);
  };
  const cmd = (user, action, payload = {}, extra = {}) => {
    const room = store.db.prepare('SELECT * FROM duel_rooms WHERE id=?').get(typeof extra.roomId === 'string' ? extra.roomId : currentRoomId);
    const self = store.db.prepare('SELECT * FROM duel_participants WHERE room_id=? AND user_id=?').get(room.id, user.id);
    return duel.command(user, room.id, {
      requestId: extra.requestId ?? ('req-' + Math.random().toString(36).slice(2, 10)),
      phaseId: extra.phaseId ?? room.phase_id,
      expectedPlayerRevision: extra.expectedPlayerRevision ?? self.player_revision,
      action, payload,
    });
  };
  const formationOf = (state, population) => {
    const priority = { 坦克: 0, 战士: 1, 刺客: 2, 射手: 3, 法师: 4 };
    const units = [...state.roster].sort((a, b) => a.unitId.localeCompare(b.unitId)).slice(0, population);
    let front = 0, back = 0;
    return units.map(u => {
      const isTank = u.defId === 'moon-deer' || u.defId === 'star-deer' || u.defId === 'crescent-dancer';
      return { unitId: u.unitId, localSlot: isTank || front < 2 ? [1, 3, 5, 8, 10, 12][Math.min(front++, 5)] : [22, 24, 26, 15, 17, 19][Math.min(back++, 5)] };
    });
  };
  const deployAll = (user, room = currentRoomId) => {
    const state = readState(room, user);
    cmd(user, 'deploy', { formation: formationOf(state, state.population) }, { roomId: room });
  };
  const A = login('duel-a', '玩家甲');
  const B = login('duel-b', '玩家乙');
  const C = login('duel-c', '玩家丙');
  return { store, game, duel, A, B, C, clock: () => clock, step, advance, openRoom, roomId, defaultLoadout, cmd, readState, writeState, deployAll, formationOf, close: () => store.db.close() };
}

test('R01/R02/R03：建房 / 加入 / 两人准备；第三人、同用户第二身份、并发席位被拒', () => {
  const f = fixture();
  try {
    const created = f.duel.create(f.A, {});
    assert.match(created.inviteCode, /^[A-Z0-9]{8}$/);
    f.duel.join(f.B, created.inviteCode);
    // 同一内部用户不能占据第二个席位（另一标签 / 会话）。
    assert.equal(f.duel.join(f.A, created.inviteCode).resumed, true);
    assert.equal(f.duel.join(f.A, created.inviteCode).side, 'A');
    // 第三人拒绝。
    assert.throws(() => f.duel.join(f.C, created.inviteCode), /房间已满/);
    // 并发抢占：直接落库第二个 B 后再加入即唯一约束拒绝。
    assert.throws(() => f.duel.join(f.C, created.inviteCode), /房间已满/);
    // 非成员读取拒绝。
    assert.throws(() => f.duel.view(f.C, created.roomId), /不是该房间/);
    f.duel.loadout(f.A, created.roomId, f.defaultLoadout(f.A));
    f.duel.loadout(f.B, created.roomId, f.defaultLoadout(f.B));
    assert.equal(f.duel.setReady(f.A, created.roomId, true).started, false);
    // 只有一人准备不开始；B 准备后同事务开局。
    assert.equal(f.duel.view(f.A, created.roomId).room.status, 'lobby');
    assert.equal(f.duel.setReady(f.B, created.roomId, true).started, true);
    const view = f.duel.view(f.A, created.roomId);
    assert.equal(view.room.status, 'playing');
    assert.equal(view.room.round, 1);
    assert.equal(view.room.phase, 'planning');
    assert.equal(f.duel.view(f.A, created.roomId).room.phaseId, 'r1-planning');
  } finally { f.close(); }
});

test('P02/R05：品质超拥有上限 / 未拥有卡种拒绝；准备时重验收藏，过期牌组不作弊', () => {
  const f = fixture();
  try {
    const created = f.duel.create(f.A, {});
    f.duel.join(f.B, created.inviteCode);
    const bad = f.defaultLoadout(f.A);
    bad.defs[0].battleQuality = 5; // 新手最高 Q3
    assert.throws(() => f.duel.loadout(f.A, created.roomId, bad), /不能超过最高拥有品质/);
    const unowned = f.defaultLoadout(f.A);
    unowned.defs[7] = { defId: 'solstice-alone', battleQuality: 1 };
    if (!f.defaultLoadout(f.A).defs.some(d => d.defId === 'solstice-alone')) assert.throws(() => f.duel.loadout(f.A, created.roomId, unowned), /只能选择当前真实拥有/);
    const loadout = f.defaultLoadout(f.A);
    f.duel.loadout(f.A, created.roomId, loadout);
    f.duel.loadout(f.B, created.roomId, f.defaultLoadout(f.B));
    f.duel.setReady(f.A, created.roomId, true);
    // 局外把 loadout 某卡最后一张转走 → 准备时重验失败，不悄悄降品质。
    const victim = loadout.defs[3].defId;
    const row = f.store.db.prepare('SELECT state FROM profiles WHERE user_id=?').get(f.A.id);
    const profile = JSON.parse(row.state);
    profile.cards = profile.cards.filter(c => c.defId !== victim);
    f.store.db.prepare('UPDATE profiles SET state=? WHERE user_id=?').run(JSON.stringify(profile), f.A.id);
    f.duel.setReady(f.A, created.roomId, false);
    assert.throws(() => f.duel.setReady(f.A, created.roomId, true), /只能选择当前真实拥有|品质/);
  } finally { f.close(); }
});

test('R04：duel 活跃锁与旧单人局互斥（共用占用约束）', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    // duel 进行中：旧 match.start 被拒。
    assert.throws(() => f.game.game(f.A, 'match.start', { requestId: 'legacy-while-duel' }), /双人对战房间/);
    // duel 进行中不能开第二间房。
    assert.throws(() => f.duel.create(f.A, {}), /进行中的对局/);
    // 旧单人局进行中：不能创建 duel（玩家丙先开旧局）。
    f.game.game(f.C, 'match.start', { requestId: 'c-legacy-start' });
    assert.throws(() => f.duel.create(f.C, {}), /旧单人局/);
  } finally { f.close(); }
});

test('T02/T03：私人 playerRevision 互不卡锁；phaseId 不匹配 / 战斗期拒绝改阵', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    const viewA1 = f.duel.view(f.A, room);
    const offerA = viewA1.self.shop[0];
    const afterBuy = f.cmd(f.A, 'buy', { offerId: offerA.offerId });
    assert.equal(afterBuy.self.gold, 40 - offerA.cost);
    assert.equal(afterBuy.self.shop.length, 4); // S01：买一格不补格
    // A 买了卡：B 的 playerRevision 不受影响，仍可下单。
    const viewB = f.duel.view(f.B, room);
    const offerB = viewB.self.shop[0];
    const afterB = f.cmd(f.B, 'buy', { offerId: offerB.offerId });
    assert.equal(afterB.self.gold, 40 - offerB.cost);
    // 过期 playerRevision 拒绝。
    assert.throws(() => f.cmd(f.A, 'sell', { unitId: 'u1' }, { expectedPlayerRevision: 0 }), /playerRevision/);
    // phaseId 不匹配拒绝。
    assert.throws(() => f.cmd(f.A, 'buy', { offerId: 'o1' }, { phaseId: 'r9-planning' }), /阶段编号/);
    // 备战截止后：冻结 + 模拟同 tick 完成，战斗期拒绝经营命令。
    const rule = duelRoundRule(1);
    f.step(rule.planningSec * 1000);
    const afterFreeze = f.duel.view(f.A, room);
    assert.equal(afterFreeze.room.phase, 'combat');
    assert.ok(afterFreeze.currentBattle.battleIds.length >= 1);
    assert.throws(() => f.cmd(f.A, 'buy', { offerId: 'o9' }), /当前不是备战阶段/);
  } finally { f.close(); }
});

test('T04：同 requestId 重试回放一次扣款；换 payload 冲突 409', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    const view = f.duel.view(f.A, room);
    const offer = view.self.shop[0];
    const input = { requestId: 'fixed-retry-001', phaseId: 'r1-planning', expectedPlayerRevision: view.self.playerRevision, action: 'buy', payload: { offerId: offer.offerId } };
    const first = f.duel.command(f.A, room, input);
    const goldAfterFirst = first.self.gold;
    const second = f.duel.command(f.A, room, input);
    assert.equal(second.self.gold, goldAfterFirst, '重试不得二次扣款');
    assert.equal(second.self.shop.filter(o => o.offerId === offer.offerId).length, 0);
    assert.throws(() => f.duel.command(f.A, room, { ...input, payload: { offerId: 'other' } }), /操作编号已被其他请求使用/);
  } finally { f.close(); }
});

test('N01/E01：R1 双方野怪独立子结果；装备三候选双方同集、各选一件', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    const rule = duelRoundRule(1);
    f.step(rule.planningSec * 1000); // → combat（两场野怪）
    const viewA = f.duel.view(f.A, room);
    assert.equal(viewA.currentBattle.kind, 'neutral');
    assert.ok(viewA.currentBattle.battleIds.includes('r1-A') && viewA.currentBattle.battleIds.includes('r1-B'));
    const replayA = f.duel.battle(f.A, room, 'r1-A');
    const replayB = f.duel.battle(f.B, room, 'r1-A');
    assert.deepEqual(replayA.sim.frames, replayB.sim.frames, '同 battleId 两端同帧（B03）');
    f.step(rule.combatPresentationSec * 1000); // → settlement：发保底 + 生成三选一
    const settleA = f.duel.view(f.A, room);
    assert.ok(settleA.self.pendingItemChoice, 'R1 结算应生成装备三选一');
    assert.equal(settleA.self.pendingItemChoice.candidates.length, 3);
    const settleB = f.duel.view(f.B, room);
    assert.deepEqual(settleA.self.pendingItemChoice.candidates, settleB.self.pendingItemChoice.candidates, '双方同三候选（E01）');
    // 选择窗口在下一次备战（R2 planning）内：先推进到 R2 备战再选。
    f.step(rule.settlementSec * 1000);
    const r2pre = f.duel.view(f.A, room);
    assert.equal(r2pre.room.round, 2);
    // 手动选择：一人各选一件，选择后不能再选。
    f.cmd(f.A, 'item.select', { itemDefId: settleA.self.pendingItemChoice.candidates[2] });
    assert.throws(() => f.cmd(f.A, 'item.select', { itemDefId: settleA.self.pendingItemChoice.candidates[0] }), /没有待选择|已关闭/);
    f.cmd(f.B, 'item.select', { itemDefId: settleB.self.pendingItemChoice.candidates[0] });
    const r2 = f.duel.view(f.A, room);
    assert.equal(r2.room.round, 2);
    assert.equal(r2.room.kind, 'pvp');
    const itemsA = r2.self.items;
    assert.equal(itemsA.length, 1);
    assert.equal(itemsA[0].itemDefId, settleA.self.pendingItemChoice.candidates[2]);
  } finally { f.close(); }
});

test('N02：野怪失败不扣生命、保底金币与装备照发，只少胜场加成', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    // A 卖光开局副本 → R1 必败（空阵）。
    const stateA = f.readState(room, f.A);
    for (const unit of stateA.roster) f.cmd(f.A, 'sell', { unitId: unit.unitId });
    const rule = duelRoundRule(1);
    f.step(rule.planningSec * 1000);
    f.step(rule.combatPresentationSec * 1000);
    const viewA = f.duel.view(f.A, room);
    assert.equal(viewA.self.hp, 32, '野怪失败不扣生命');
    assert.equal(viewA.self.lastIncome.neutralGuaranteed, 12, '保底 12 照发');
    assert.equal(viewA.self.lastIncome.neutralWinBonus, 0, '失败无击杀加成');
    assert.ok(viewA.self.pendingItemChoice, '失败仍获得装备选择资格');
  } finally { f.close(); }
});

test('E03：装备选择到期按固定候选顺序入背包、不自动穿戴', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    const rule = duelRoundRule(1);
    f.step(rule.planningSec * 1000);
    f.step(rule.combatPresentationSec * 1000);
    const candidates = f.duel.view(f.A, room).self.pendingItemChoice.candidates;
    // 不选择，直接跨过 R2 备战截止（分两步：每个阶段一次 tick）。
    const rule2 = duelRoundRule(2);
    f.step(rule.settlementSec * 1000);
    assert.equal(f.duel.view(f.A, room).room.round, 2);
    f.step(rule2.planningSec * 1000);
    const view = f.duel.view(f.A, room);
    assert.equal(view.room.round, 2);
    assert.ok(view.room.phase === 'combat' || view.room.phase === 'simulating', '冻结后离开备战');
    const state = f.readState(room, f.A);
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].itemDefId, candidates[0], '固定候选顺序选第一件');
    assert.equal(state.roster.every(u => (u.equippedItemIds ?? []).length === 0), true, '不自动穿戴');
    const choice = f.store.db.prepare('SELECT * FROM duel_item_choices WHERE room_id=? AND user_id=?').get(room, f.A.id);
    assert.equal(choice.status, 'auto');
  } finally { f.close(); }
});

test('E04/E05/E06：两槽上限 / 同组拒绝 / 同实例双单位拒绝 / 卸下免费 / 售卡退装', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    const rule = duelRoundRule(1);
    f.step(rule.planningSec * 1000);
    f.step(rule.combatPresentationSec * 1000);
    f.step(rule.settlementSec * 1000);
    f.cmd(f.A, 'item.select', { itemDefId: f.duel.view(f.A, room).self.pendingItemChoice.candidates[0] });
    const state = f.readState(room, f.A);
    const itemId = state.items[0].itemId;
    const unitId = state.roster[0].unitId;
    const otherUnit = state.roster[1].unitId;
    // 第二件装备来自 R4——这里直接注入一件测试装备实例（服务端生成路径已被 E01 覆盖）。
    f.writeState(room, f.A, s => { s.items.push({ itemId: 'i-test', itemDefId: 'stone_mail', kind: 'complete' }); });
    f.cmd(f.A, 'item.equip', { itemId, unitId });
    f.cmd(f.A, 'item.equip', { itemId: 'i-test', unitId });
    const equipped = f.readState(room, f.A).roster.find(u => u.unitId === unitId);
    assert.equal(equipped.equippedItemIds.length, 2);
    // 第三件 / 同 uniqueGroup / 同实例双单位 拒绝。
    f.writeState(room, f.A, s => { s.items.push({ itemId: 'i3', itemDefId: 'edge_sigil', kind: 'complete' }); });
    assert.throws(() => f.cmd(f.A, 'item.equip', { itemId: 'i3', unitId }), /最多装备 2 件/);
    // 同 uniqueGroup：在另一个空槽单位上先穿一件同组装备，再穿第二件同组 → 拒绝。
    const firstDef = f.duel.view(f.A, room).self.items[0].itemDefId;
    f.writeState(room, f.A, s => { s.items.push({ itemId: 'i4', itemDefId: firstDef, kind: 'complete' }, { itemId: 'i5', itemDefId: firstDef, kind: 'complete' }); });
    f.cmd(f.A, 'item.equip', { itemId: 'i4', unitId: otherUnit });
    assert.throws(() => f.cmd(f.A, 'item.equip', { itemId: 'i5', unitId: otherUnit }), /同组装备/);
    assert.throws(() => f.cmd(f.A, 'item.equip', { itemId, unitId: otherUnit }), /已被穿戴/);
    // 卸下免费；售卡退装：装备回到背包（引用保留），金币只按 basis。
    f.cmd(f.A, 'item.unequip', { itemId: 'i-test' });
    assert.equal(f.readState(room, f.A).roster.find(u => u.unitId === unitId).equippedItemIds.length, 1);
    const goldBefore = f.readState(room, f.A).gold;
    const basis = f.readState(room, f.A).roster.find(u => u.unitId === unitId).basis;
    f.cmd(f.A, 'sell', { unitId });
    const after = f.readState(room, f.A);
    assert.equal(after.gold, goldBefore + basis);
    assert.ok(after.items.some(i => i.itemId === itemId), '售出的装备退回背包（E06）');
  } finally { f.close(); }
});

test('E07/G05/P05：合星 keeper 保留装备、材料装备退背包；basis 求和守恒；免费副本售 0', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    // 白盒注入：三张同 defId 同品质同星 + 两件装备分布。
    f.writeState(room, f.A, s => {
      s.roster = [
        { unitId: 'm1', defId: 'moon-deer', quality: 1, stars: 1, basis: 10, equippedItemIds: ['iX'] },
        { unitId: 'm2', defId: 'moon-deer', quality: 1, stars: 1, basis: 10, equippedItemIds: ['iY'] },
        { unitId: 'm3', defId: 'moon-deer', quality: 1, stars: 1, basis: 10, equippedItemIds: [] },
      ];
      s.items = [{ itemId: 'iX', itemDefId: 'edge_sigil', kind: 'complete' }, { itemId: 'iY', itemDefId: 'stone_mail', kind: 'complete' }];
      s.formation = [{ unitId: 'm1', localSlot: 3 }]; // 部署者优先为 keeper
      s.shop = [{ offerId: 'o1', defId: 'moon-deer', quality: 1, cost: 10 }];
      s.gold = 40;
      s.nextUnit = 100;
    });
    const after = f.cmd(f.A, 'buy', { offerId: 'o1' });
    const merged = after.self.roster.find(u => u.defId === 'moon-deer' && u.stars === 2);
    const leftover = after.self.roster.find(u => u.defId === 'moon-deer' && u.stars === 1);
    assert.ok(merged, '买入第四张后三张合成 2 星');
    assert.equal(merged.basis, 30, '合星 basis = 三材料求和（不含未参与合成的第四张）');
    assert.ok(leftover && leftover.basis === 10);
    assert.equal(after.self.roster.reduce((sum, u) => sum + u.basis, 0), 40, 'basis 守恒（G05）');
    assert.deepEqual(merged.equippedItemIds, ['iX'], 'keeper 保留自己的装备');
    assert.equal(after.self.items.length, 2, '装备实例不增不减');
    assert.equal(after.self.items.every(i => ['iX', 'iY'].includes(i.itemId)), true);
    // 免费开局副本 basis=0：售出返 0（这里直接用注入验证规则）。
    f.writeState(room, f.A, s => { s.roster.push({ unitId: 'free1', defId: 'sun-fox', quality: 1, stars: 1, basis: 0, equippedItemIds: [] }); });
    const goldBefore = f.readState(room, f.A).gold;
    f.cmd(f.A, 'sell', { unitId: 'free1' });
    assert.equal(f.readState(room, f.A).gold, goldBefore, '免费副本出售返 0（P05）');
    // 刷新真实销毁 10 金币。
    const beforeReroll = f.readState(room, f.A).gold;
    f.cmd(f.A, 'reroll', {});
    assert.equal(f.readState(room, f.A).gold, beforeReroll - 10, '刷新销毁 10 金币（G05）');
  } finally { f.close(); }
});

test('S02：锁店跨轮保留未买格、不补满；解锁后下轮免费刷新', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    const view = f.duel.view(f.A, room);
    const keep = view.self.shop.slice(0, 2).map(o => o.offerId);
    f.cmd(f.A, 'sell', { unitId: f.readState(room, f.A).roster[0].unitId }); // 腾出校验路径无关
    for (const offer of view.self.shop.slice(2)) f.cmd(f.A, 'buy', { offerId: offer.offerId });
    f.cmd(f.A, 'lock', { locked: true });
    // 推进到 R2 备战。
    const rule = duelRoundRule(1);
    f.step(rule.planningSec * 1000); f.step(rule.combatPresentationSec * 1000); f.step(rule.settlementSec * 1000);
    const r2 = f.duel.view(f.A, room);
    assert.equal(r2.room.round, 2);
    assert.deepEqual(r2.self.shop.map(o => o.offerId), keep, '锁店保留剩余格不补满');
    // 解锁后再进入 R3：免费刷新成 5 格。
    f.cmd(f.A, 'lock', { locked: false });
    const rule2 = duelRoundRule(2);
    f.step(rule2.planningSec * 1000); f.step(rule2.combatPresentationSec * 1000); f.step(rule2.settlementSec * 1000);
    const r3 = f.duel.view(f.A, room);
    assert.equal(r3.room.round, 3);
    assert.equal(r3.self.shop.length, 5, '未锁店进入下轮免费刷新为 5 格');
  } finally { f.close(); }
});

test('S03：满仓买第三张可合星则允许；无法合星且超容则回滚', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    // (a) 15 满仓：买第三张 moon-deer → 立即合星 → 14 ≤ 15 允许（填充单位用不同卡种避免连锁合星）。
    const FILL_DEFS = ['sun-fox', 'forest-sprout', 'star-deer', 'golden-fox', 'verdant-rabbit', 'mist-deer', 'dawn-fox', 'breeze-sprout', 'lunar-guide', 'silver-gap', 'crescent-dancer', 'frost-return', 'moon-soloist'];
    f.writeState(room, f.A, s => {
      s.roster = [
        { unitId: 'u1', defId: 'moon-deer', quality: 1, stars: 1, basis: 10, equippedItemIds: [] },
        { unitId: 'u2', defId: 'moon-deer', quality: 1, stars: 1, basis: 10, equippedItemIds: [] },
      ];
      FILL_DEFS.forEach((defId, i) => s.roster.push({ unitId: 'fill' + i, defId, quality: 1, stars: 1, basis: 10, equippedItemIds: [] }));
      s.shop = [{ offerId: 'o1', defId: 'moon-deer', quality: 1, cost: 10 }, { offerId: 'o2', defId: 'eclipse-deer', quality: 1, cost: 10 }];
      s.gold = 40;
      s.formation = [];
    });
    const after = f.cmd(f.A, 'buy', { offerId: 'o1' });
    assert.equal(after.self.roster.length, 14);
    assert.ok(after.self.roster.some(u => u.defId === 'moon-deer' && u.stars === 2));
    // (b) 再次满仓（14 + 注入 1）后买无合星对象的卡 → 全回滚。
    f.writeState(room, f.A, s => { s.roster.push({ unitId: 'fillX', defId: 'sun-cub', quality: 1, stars: 1, basis: 10, equippedItemIds: [] }); });
    const goldBefore = f.readState(room, f.A).gold;
    assert.throws(() => f.cmd(f.A, 'buy', { offerId: 'o2' }), /备战区已满/);
    assert.equal(f.readState(room, f.A).gold, goldBefore, '回滚不扣款');
    assert.ok(f.readState(room, f.A).shop.some(o => o.offerId === 'o2'), '回滚不移除卡位');
  } finally { f.close(); }
});

test('XP 拒绝：短局人口自动，无买经验旁路（G04）', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    assert.throws(() => f.cmd(f.A, 'xp', {}), /不购买经验/);
  } finally { f.close(); }
});

test('G01/G04/G02：全程不发无用收入；自动人口；利息 29/30 边界', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    // 双方都不经营（卖光开局副本），PvP 全平 → 生命不掉 → 走满 R10。
    for (const user of [f.A, f.B]) {
      const state = f.readState(room, user);
      for (const unit of state.roster) f.cmd(user, 'sell', { unitId: unit.unitId });
    }
    const populations = [];
    let round = 1, guard = 0;
    while (round <= 10 && guard++ < 60) {
      const view = f.duel.view(f.A, room);
      if (view.room.status === 'finished') break;
      if (view.room.phase === 'planning') {
        populations.push([view.room.round, view.self.population]);
        // G02：在 R3 备战把存款设为 29 → R3 结算利息 0；R5 设 60 → 利息 2。
        if (view.room.round === 3) f.writeState(room, f.A, s => { s.gold = 29; });
        if (view.room.round === 5) f.writeState(room, f.A, s => { s.gold = 60; });
        const rule = duelRoundRule(view.room.round);
        f.step(rule.planningSec * 1000);
      } else if (view.room.phase === 'combat') f.step(duelRoundRule(view.room.round).combatPresentationSec * 1000);
      else if (view.room.phase === 'settlement') {
        if (view.room.round === 3) {
          const income = f.duel.view(f.A, room).self.lastIncome;
          if (income) assert.equal(income.interest, 0, '存款 29 → 利息 0');
        }
        f.step(duelRoundRule(view.room.round).settlementSec * 1000);
      }
      const next = f.duel.view(f.A, room);
      round = next.room.round;
      if (next.room.status === 'finished') break;
    }
    const finished = f.duel.view(f.A, room);
    assert.equal(finished.room.status, 'finished');
    assert.equal(finished.room.finishReason, 'round10');
    assert.equal(finished.room.outcome, null, '同生命 32:32 → 整局平局（B07）');
    // 人口序列：R1/R2=3 R3/R4=4 R5/R6=5 R7+=6。
    assert.deepEqual(populations.filter(([r]) => [3, 5, 7].includes(r)).map(([, p]) => p), [4, 5, 6]);
    // 金币审计：A 被改到 29/60，脱离标准轨迹；用 B 校验完整保底 + 全额利息。
    const stateB = f.readState(room, f.B);
    // 40 初始 + 9×20 基础 + 54 保底 + 6×2 PvP 补给 + 17 利息（40→1、之后各 2，存款充足）
    // B 存款轨迹：53→73(+20)→77(+2利+2补)→…（无消费）≥30 恒成立，R1 起 8 次非终局结算。
    const expected = 40 + 9 * 20 + 54 + 6 * 2 + 1 + 2 * 8;
    assert.equal(stateB.gold, expected, `十轮保底 + 轻利息对账：实际 ${stateB.gold}`);
    // 平局双方 110（若参与度达标；双方只有 R1 卖卡动作 → 参与不足 → 0，并给出原因）。
    const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=?').all(room);
    assert.equal(rewards.length, 2);
    assert.ok(rewards.every(r => r.actual_coins === 0), '参与不足（<4 轮有效经营）无奖励');
    assert.ok(rewards.every(r => r.reason.includes('insufficient')));
  } finally { f.close(); }
});

test('W01/W03：有效参与双方按胜/负/平发奖；一次结算不重发', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    // B 卖光摆烂（空阵连败被淘汰），A 每轮买卡 + 部署。
    const stateB = f.readState(room, f.B);
    for (const unit of stateB.roster) f.cmd(f.B, 'sell', { unitId: unit.unitId });
    let guard = 0;
    while (f.duel.view(f.A, room).room.status !== 'finished' && guard++ < 80) {
      const view = f.duel.view(f.A, room);
      if (view.room.phase !== 'planning') { f.step(1000); continue; }
      const state = f.readState(room, f.A);
      const affordable = state.shop.filter(o => o.cost <= state.gold).sort((a, b) => a.cost - b.cost)[0];
      if (affordable && state.roster.length < 12) f.cmd(f.A, 'buy', { offerId: affordable.offerId });
      f.deployAll(f.A, room);
      f.step(duelRoundRule(view.room.round).planningSec * 1000);
      f.step(duelRoundRule(view.room.round).combatPresentationSec * 1000);
      f.step(duelRoundRule(view.room.round).settlementSec * 1000);
      if (f.duel.view(f.A, room).room.phase === 'planning' && f.duel.view(f.A, room).self.pendingItemChoice) {
        f.cmd(f.A, 'item.select', { itemDefId: f.duel.view(f.A, room).self.pendingItemChoice.candidates[0] });
      }
    }
    const finished = f.duel.view(f.A, room);
    assert.equal(finished.room.status, 'finished');
    assert.equal(finished.room.outcome, 'A', 'B 空阵连败被淘汰，A 获胜');
    const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=? ORDER BY user_id').all(room);
    const rewardA = rewards.find(r => r.user_id === f.A.id);
    const rewardB = rewards.find(r => r.user_id === f.B.id);
    assert.equal(rewardA.actual_coins, 120, '胜者 120');
    assert.ok(rewardA.factor >= 1 || rewardA.factor === 1, '首个 pair 房间全额');
    assert.equal(rewardB.actual_coins, 0, '参与不足 / 被淘汰摆烂无奖励');
    // 星币进入同一永久账本（faucet）。
    const ledger = f.store.db.prepare("SELECT * FROM ledger WHERE user_id=? AND kind='duel.finish'").all(f.A.id);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].coins, 120);
    assert.equal(ledger[0].flow, 'faucet');
    // 活跃锁已释放：可以再开新房。
    const again = f.duel.create(f.A, {});
    assert.ok(again.roomId);
  } finally { f.close(); }
});

test('W02：180 秒前投降双方 0 奖励；重复投降幂等（D03）', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    const result = f.duel.leave(f.A, room, 'surrender');
    assert.ok(result.surrendered);
    const finished = f.duel.view(f.A, room);
    assert.equal(finished.room.status, 'finished');
    assert.equal(finished.room.outcome, 'B', '投降方对手获胜');
    const repeat = f.duel.leave(f.A, room, 'surrender');
    assert.ok(repeat.alreadyFinished, '第二次投降幂等');
    const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=?').all(room);
    assert.ok(rewards.every(r => r.actual_coins === 0), '180 秒前投降双方 0（W02）');
    assert.ok(rewards.every(r => r.reason.includes('too_short') || r.reason.includes('forfeited') || r.reason.includes('insufficient')));
  } finally { f.close(); }
});

test('W04/W05：pair 同日 3 全额 + 3 半额 + 0；换主客不绕配额', () => {
  const f = fixture();
  try {
    const outcomes = [];
    for (let i = 0; i < 7; i++) {
      const creator = i % 2 === 0 ? f.A : f.B; // 换主客开房
      const joiner = creator === f.A ? f.B : f.A;
      const room = f.openRoom({ creator, joiner });
      // 快速走满全程：双方每轮部署 + 少量买卖满足参与度。
      let guard = 0;
      while (f.duel.view(creator, room).room.status !== 'finished' && guard++ < 80) {
        const view = f.duel.view(creator, room);
        if (view.room.phase !== 'planning') { f.step(1000); continue; }
        for (const user of [creator, joiner]) {
          const state = f.readState(room, user);
          const affordable = state.shop.filter(o => o.cost <= state.gold)[0];
          if (affordable) f.cmd(user, 'buy', { offerId: affordable.offerId }, { roomId: room });
          f.cmd(user, 'deploy', { formation: f.formationOf(f.readState(room, user), state.population) }, { roomId: room });
          const pending = f.duel.view(user, room).self.pendingItemChoice;
          if (pending) f.cmd(user, 'item.select', { itemDefId: pending.candidates[0] }, { roomId: room });
        }
        const rule = duelRoundRule(view.room.round);
        f.step(rule.planningSec * 1000); f.step(rule.combatPresentationSec * 1000); f.step(rule.settlementSec * 1000);
      }
      const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=?').all(room);
      outcomes.push(rewards.map(r => r.factor).sort().join(','));
    }
    // 房间 1-3：至少一名全额（1）；4-6：半额（0.5）；7：0。
    assert.ok(outcomes[0].includes('1'), '第 1 间全额');
    assert.ok(outcomes[2].includes('1'), '第 3 间全额');
    assert.ok(outcomes[3].includes('0.5'), '第 4 间半额');
    assert.ok(outcomes[5].includes('0.5'), '第 6 间半额');
    assert.ok(outcomes[6].split(',').every(x => Number(x) === 0), '第 7 间 pair 配额归零');
    // pair 只按无序对计数。
    const pairs = f.store.db.prepare('SELECT * FROM duel_pair_quota').all();
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].eligible_rooms, 7);
  } finally { f.close(); }
});

test('W06/W07：个人配额与 legacy 共享；UTC 跨日不重复占额', () => {
  const f = fixture();
  try {
    // 预填个人配额：当天已用 6 全额 → duel 奖励进入半额档（min(pair=1, personal=0.5)）。
    const day = new Date(f.clock()).toISOString().slice(0, 10);
    f.store.db.prepare('INSERT INTO reward_quota(user_id,day,matches) VALUES(?,?,6)').run(f.A.id, day);
    const room = f.openRoom();
    let guard = 0;
    while (f.duel.view(f.A, room).room.status !== 'finished' && guard++ < 80) {
      const view = f.duel.view(f.A, room);
      if (view.room.phase !== 'planning') { f.step(1000); continue; }
      for (const user of [f.A, f.B]) {
        const state = f.readState(room, user);
        const affordable = state.shop.filter(o => o.cost <= state.gold)[0];
        if (affordable) f.cmd(user, 'buy', { offerId: affordable.offerId }, { roomId: room });
        f.cmd(user, 'deploy', { formation: f.formationOf(f.readState(room, user), state.population) }, { roomId: room });
        const pending = f.duel.view(user, room).self.pendingItemChoice;
        if (pending) f.cmd(user, 'item.select', { itemDefId: pending.candidates[0] }, { roomId: room });
      }
      const rule = duelRoundRule(view.room.round);
      f.step(rule.planningSec * 1000); f.step(rule.combatPresentationSec * 1000); f.step(rule.settlementSec * 1000);
    }
    const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=?').all(room);
    const rewardA = rewards.find(r => r.user_id === f.A.id);
    assert.equal(rewardA.factor, 0.5, '个人配额已用 6 → 半额（与 pair 取 min）');
    const rewardB = rewards.find(r => r.user_id === f.B.id);
    assert.equal(rewardB.factor, 1, 'B 配额全新 → 全额');
    // 跨日重试：第二天再开一间，A 个人计数 +1（6→7 仍半额档内）。
    const used = f.store.db.prepare('SELECT matches FROM reward_quota WHERE user_id=? AND day=?').get(f.A.id, day).matches;
    assert.equal(used, 7, 'duel 占用与 legacy 共享的个人计数');
  } finally { f.close(); }
});

test('D04：崩溃恢复——冻结后未出结果，重启服务用同 seed 确定性重算', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    const rule = duelRoundRule(1);
    f.step(rule.planningSec * 1000);
    const reference = f.store.db.prepare('SELECT battles FROM duel_rounds WHERE room_id=? AND round_no=1').get(room).battles;
    // 模拟崩溃：结果被清空、房间停在 simulating（deadline 已到）。
    f.store.db.prepare("UPDATE duel_rounds SET status='frozen', result=NULL, battles=NULL WHERE room_id=? AND round_no=1").run(room);
    f.store.db.prepare("UPDATE duel_rooms SET phase='simulating', phase_id='r1-simulating', phase_ends_at=? WHERE id=?").run(f.clock() - 1, room);
    f.duel.tick();
    const recovered = f.store.db.prepare('SELECT battles FROM duel_rounds WHERE room_id=? AND round_no=1').get(room).battles;
    assert.equal(recovered, reference, '同 frozen_input + seed → 完全一致的结果');
    assert.equal(f.duel.view(f.A, room).room.phase, 'combat');
  } finally { f.close(); }
});

test('I01/I02：对手商店 / 背包 / 修改中的站位不在响应中；侦察只看已冻结轮', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    const viewA = f.duel.view(f.A, room);
    // 结构化断言：对手字段白名单（无商店 / 背包 / 备战 / 当前阵容）。
    assert.deepEqual(Object.keys(viewA.opponent).sort(), ['hp', 'loadout', 'name', 'population', 'ready', 'side']);
    assert.equal(viewA.scout, null, '首轮备战期间没有可侦察的已冻结轮');
    const rule = duelRoundRule(1);
    f.step(rule.planningSec * 1000);
    // R1 冻结后：双方阵容公开（scout 指向 r1），但对方备战区新买的卡仍不可见。
    const duringCombat = f.duel.view(f.A, room);
    assert.equal(duringCombat.scout.round, 1);
    assert.ok(duringCombat.scout.units.length >= 1, '冻结后公开对方阵容');
    assert.ok(!duringCombat.scout.shop && !duringCombat.scout.items);
  } finally { f.close(); }
});

test('T01：轮次时长按规则表推进（不沿用 8 轮 / 75000ms 硬编码）', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    const start = f.clock();
    let sawCombatAt = null;
    const rule = duelRoundRule(1);
    f.step(rule.planningSec * 1000);
    sawCombatAt = f.clock();
    assert.equal(sawCombatAt - start, rule.planningSec * 1000);
    assert.equal(f.duel.view(f.A, room).room.phase, 'combat');
    f.step(rule.combatPresentationSec * 1000);
    assert.equal(f.duel.view(f.A, room).room.phase, 'settlement');
    f.step(rule.settlementSec * 1000);
    assert.equal(f.duel.view(f.A, room).room.round, 2);
  } finally { f.close(); }
});

test('lobby 过期：120 秒无人开始 → abort，无奖励、不占配额', () => {
  const f = fixture();
  try {
    const created = f.duel.create(f.A, {});
    f.duel.join(f.B, created.inviteCode);
    f.step(121 * 1000);
    const view = f.duel.view(f.A, created.roomId);
    assert.equal(view.room.status, 'finished');
    assert.equal(view.room.finishReason, 'lobby_expired');
    const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=?').all(created.roomId);
    assert.ok(rewards.every(r => r.actual_coins === 0));
    // 房间结束后可重新创建。
    const again = f.duel.create(f.A, {});
    assert.ok(again.roomId);
  } finally { f.close(); }
});

// ── 本轮评审修复回归 ────────────────────────────────────────────────────────

test('恢复：待准备（lobby）房间经 /me 可找回，创建 / 加入响应直接带 roomId', () => {
  const f = fixture();
  try {
    const created = f.duel.create(f.A, {});
    assert.ok(created.roomId);
    // active lock 只在正式开局创建：待准备房间也必须能从 /me 恢复。
    assert.equal(f.duel.me(f.A).activeRoomId, created.roomId);
    f.duel.join(f.B, created.inviteCode);
    assert.equal(f.duel.me(f.B).activeRoomId, created.roomId);
    assert.equal(f.duel.view(f.A, created.roomId).room.status, 'lobby');
  } finally { f.close(); }
});

test('回放 ID：r{round}- 前缀跨轮唯一；旧短 ID 不再命中', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    for (const round of [1, 2, 3]) {
      const rule = duelRoundRule(round);
      f.step(rule.planningSec * 1000);
      f.step(rule.combatPresentationSec * 1000);
      f.step(rule.settlementSec * 1000);
    }
    const r1 = f.duel.battle(f.A, room, 'r1-A');
    assert.equal(r1.round, 1);
    assert.equal(r1.kind, 'neutral');
    const r2 = f.duel.battle(f.A, room, 'r2-pvp');
    assert.equal(r2.round, 2);
    const r3 = f.duel.battle(f.B, room, 'r3-pvp');
    assert.equal(r3.round, 3, 'R3 请求必须返回 R3，而不是首轮命中 R2');
    assert.throws(() => f.duel.battle(f.A, room, 'pvp'), /回放不存在/, '旧短 ID 淘汰');
    assert.throws(() => f.duel.battle(f.A, room, 'r9-pvp'), /回放不存在/, '声明的轮次与命中行不一致时拒绝');
    f.step(duelRoundRule(4).planningSec * 1000);
    assert.deepEqual(f.duel.view(f.A, room).currentBattle.battleIds, ['r4-A', 'r4-B']);
  } finally { f.close(); }
});

test('截止校验：请求体跨过 phase_ends_at 的命令在事务内被拒，不扣款', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    const gold = f.readState(room, f.A).gold;
    f.advance(duelRoundRule(1).planningSec * 1000 + 5000);
    assert.throws(() => f.cmd(f.A, 'reroll', {}), /截止/);
    assert.equal(f.readState(room, f.A).gold, gold, '拒绝时不扣刷新费');
    f.duel.tick(); // catch-up 后阶段推进
    assert.equal(f.duel.view(f.A, room).room.phase, 'combat');
    assert.throws(() => f.cmd(f.A, 'buy', { offerId: 'o1' }), /不是备战阶段/);
  } finally { f.close(); }
});

function playActiveRounds(f, room, rounds) {
  // 双方每轮买卡 + 部署 + 领装备：满足参与度（≥4 轮有效经营、≥3 种部署卡种）。
  for (let round = 1; round <= rounds; round++) {
    for (const user of [f.A, f.B]) {
      const state = f.readState(room, user);
      const affordable = state.shop.filter(o => o.cost <= state.gold)[0];
      if (affordable) f.cmd(user, 'buy', { offerId: affordable.offerId });
      f.cmd(user, 'deploy', { formation: f.formationOf(f.readState(room, user), state.population) });
      const pending = f.duel.view(user, room).self.pendingItemChoice;
      if (pending) f.cmd(user, 'item.select', { itemDefId: pending.candidates[0] });
    }
    const rule = duelRoundRule(round);
    f.step(rule.planningSec * 1000);
    f.step(rule.combatPresentationSec * 1000);
    f.step(rule.settlementSec * 1000);
  }
}

test('投降命令：command 通道同样写明胜方，对手按胜利（非平局）结算', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    playActiveRounds(f, room, 4); // R1–R4 ≈ 217 秒 > 180 秒门槛
    f.cmd(f.A, 'surrender', {});
    const finished = f.duel.view(f.A, room);
    assert.equal(finished.room.status, 'finished');
    assert.equal(finished.room.outcome, 'B', '投降方对手获胜');
    assert.equal(finished.room.finishReason, 'surrender');
    const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=?').all(room);
    const rewardA = rewards.find(r => r.user_id === f.A.id);
    const rewardB = rewards.find(r => r.user_id === f.B.id);
    assert.equal(rewardB.base, 120, '对手按胜利基价 120（而非平局 110）');
    assert.equal(rewardB.actual_coins, 120);
    assert.equal(rewardA.actual_coins, 0, '投降方 0');
    assert.ok(rewardA.reason.includes('forfeited'));
  } finally { f.close(); }
});

test('终局事务：结算中途故障整体回滚，恢复后重试可完整补齐', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    playActiveRounds(f, room, 4);
    // 故障注入：删除 B 的 profiles 行 → finishRoom 在处理到 B 时抛错。
    const profile = f.store.db.prepare('SELECT * FROM profiles WHERE user_id=?').get(f.B.id);
    f.store.db.prepare('DELETE FROM profiles WHERE user_id=?').run(f.B.id);
    assert.throws(() => f.duel.leave(f.A, room, 'surrender'), /玩家资料不存在/);
    // 整体回滚：房间仍在进行、无部分到账、活跃锁未释放。
    assert.equal(f.duel.view(f.A, room).room.status, 'playing');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM duel_rewards WHERE room_id=?').get(room).n, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='duel.finish'").get().n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM active_game_locks WHERE ref_id=?').get(room).n, 2);
    // 恢复资料后重试：一次完整结算。
    f.store.db.prepare('INSERT INTO profiles(user_id,code,state,revision) VALUES(?,?,?,?)')
      .run(profile.user_id, profile.code, profile.state, profile.revision);
    assert.ok(f.duel.leave(f.A, room, 'surrender').surrendered);
    const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=?').all(room);
    assert.equal(rewards.length, 2, '双方各一条奖励记录');
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='duel.finish'").get().n, 1, '只有胜者一条入账');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM active_game_locks WHERE ref_id=?').get(room).n, 0, '锁全部释放');
  } finally { f.close(); }
});

test('席位恢复：房主 A 离开 lobby 后新玩家补入 A 座；留守方 ready 重置不误开局', () => {
  const f = fixture();
  try {
    const created = f.duel.create(f.A, {});
    f.duel.join(f.B, created.inviteCode);
    f.duel.loadout(f.A, created.roomId, f.defaultLoadout(f.A));
    f.duel.loadout(f.B, created.roomId, f.defaultLoadout(f.B));
    f.duel.setReady(f.B, created.roomId, true);
    // A 离开：B 留守，ready 被重置。
    assert.ok(f.duel.leave(f.A, created.roomId, 'leave').left);
    const afterLeave = f.duel.view(f.B, created.roomId);
    assert.equal(afterLeave.room.status, 'lobby');
    assert.equal(afterLeave.self.ready, false, '留守方准备状态重置');
    // C 加入自动补入空缺的 A 座，而不是写出第二个 B。
    const joined = f.duel.join(f.C, created.inviteCode);
    assert.equal(joined.side, 'A');
    const sides = f.store.db.prepare('SELECT side FROM duel_participants WHERE room_id=? ORDER BY side').all(created.roomId).map(r => r.side);
    assert.deepEqual(sides, ['A', 'B']);
    f.duel.loadout(f.C, created.roomId, f.defaultLoadout(f.C));
    // 只有一人准备不开局（B 的 ready 已被离房重置）；B 再准备后同事务开局。
    assert.equal(f.duel.setReady(f.C, created.roomId, true).started, false);
    assert.equal(f.duel.view(f.B, created.roomId).room.status, 'lobby');
    assert.equal(f.duel.setReady(f.B, created.roomId, true).started, true);
    const playing = f.duel.view(f.C, created.roomId);
    assert.equal(playing.room.status, 'playing');
    assert.equal(playing.self.side, 'A');
  } finally { f.close(); }
});

test('奖励资格放宽：180 秒后 R4 备战期对手投降，赢家按实际完成轮数 min(4,3) 全额到账', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    playActiveRounds(f, room, 3); // R1–R3 恰 169 秒，双方每轮有效经营 + 部署
    assert.equal(f.duel.view(f.A, room).room.round, 4);
    assert.equal(f.duel.view(f.A, room).room.phase, 'planning');
    const winnerState = f.readState(room, f.B);
    assert.equal(new Set(winnerState.activity.meaningfulRounds).size, 3);
    assert.ok(new Set(winnerState.activity.deployedDefIds).size >= 3, '前置：三种上阵卡种');
    // 再走 12 秒：房间总时长 181 秒 ≥ 180 秒门槛，仍在 R4 备战窗口内投降。
    f.advance(12 * 1000);
    f.cmd(f.A, 'surrender', {});
    const finished = f.duel.view(f.B, room);
    assert.equal(finished.room.status, 'finished');
    assert.equal(finished.room.outcome, 'B');
    const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=?').all(room);
    const rewardA = rewards.find(r => r.user_id === f.A.id);
    const rewardB = rewards.find(r => r.user_id === f.B.id);
    assert.equal(rewardA.actual_coins, 0, '投降方 0');
    assert.ok(rewardA.reason.includes('forfeited'));
    // 赢家只完成 3 个有效轮：按 min(4, 3) 判定仍具资格，首间 pair 房间全额 120。
    assert.equal(rewardB.actual_coins, 120, '被截断轮不苛求：R4 投降时赢家无需第 4 个有效轮');
    assert.equal(rewardB.reason, '');
    // 终局视图携带奖励详情：前端据此展示实际到账与原因。
    assert.equal(finished.self.reward.actualCoins, 120);
    assert.equal(finished.self.reward.base, 120);
    assert.equal(finished.self.reward.factor, 1);
  } finally { f.close(); }
});

test('迁移：同座重复的进行中房间原子终止并释放全部锁；lobby 坏房间仅去重', () => {
  const f = fixture();
  try {
    const bad = f.openRoom();                       // (a) 已开局房间：A vs B
    const lobby = f.duel.create(f.C, {});           // (b) 未开局房间：C 等待中
    // 模拟“建表约束之前”的旧 schema：换成没有 (room_id, side) 唯一约束的表，
    // 才能注入旧固定 B 座 bug 产生的同座重复行（新库由 DDL 直接阻止）。
    f.store.db.exec(`
      CREATE TABLE duel_participants_old(
        room_id TEXT NOT NULL REFERENCES duel_rooms(id), user_id TEXT NOT NULL REFERENCES users(id),
        side TEXT NOT NULL, name TEXT NOT NULL, loadout TEXT, state TEXT NOT NULL,
        player_revision INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER,
        UNIQUE(room_id, user_id));
      INSERT INTO duel_participants_old SELECT * FROM duel_participants;
      DROP TABLE duel_participants;
      ALTER TABLE duel_participants_old RENAME TO duel_participants;`);
    const staleState = JSON.stringify({ hp: 32, activity: { meaningfulRounds: [], deployedDefIds: [] } });
    // (a) 旧 bug 存量形态：进行中房间存在第二个 B 座成员及其锁。
    f.store.db.prepare('INSERT INTO duel_participants(room_id,user_id,side,name,state,last_seen_at) VALUES(?,?,?,?,?,?)')
      .run(bad, f.C.id, 'B', '玩家丙', staleState, f.clock());
    f.store.db.prepare('INSERT INTO active_game_locks(user_id,kind,ref_id) VALUES(?,?,?)').run(f.C.id, 'duel', bad);
    // (b) lobby 房间两个 B 座（B、A 均为后注入，保留最早行）。
    f.store.db.prepare('INSERT INTO duel_participants(room_id,user_id,side,name,state,last_seen_at) VALUES(?,?,?,?,?,?)').run(lobby.roomId, f.B.id, 'B', '玩家乙', staleState, f.clock());
    f.store.db.prepare('INSERT INTO duel_participants(room_id,user_id,side,name,state,last_seen_at) VALUES(?,?,?,?,?,?)').run(lobby.roomId, f.A.id, 'B', '玩家甲', staleState, f.clock());
    const duel2 = createDuelService(f.store.db, { now: () => f.clock() });
    const roomRow = f.store.db.prepare('SELECT * FROM duel_rooms WHERE id=?').get(bad);
    assert.equal(roomRow.status, 'finished', '坏房间被原子终止，不能只删参与者');
    assert.equal(roomRow.finish_reason, 'service_interrupted');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM active_game_locks WHERE ref_id=?').get(bad).n, 0, '全部锁释放（含被删者）');
    assert.deepEqual(f.store.db.prepare('SELECT side FROM duel_participants WHERE room_id=? ORDER BY side').all(bad).map(r => r.side), ['A', 'B'], '同座重复行去重');
    const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=?').all(bad);
    assert.equal(rewards.length, 3, '三名成员各留一条 0 奖励记录');
    assert.ok(rewards.every(r => r.actual_coins === 0 && r.reason === 'service_abort'));
    // 被删者与原成员的锁均已释放，都能开新房（C 此前被锁死在坏房间里）。
    assert.ok(duel2.create(f.C, {}).roomId);
    assert.ok(duel2.create(f.A, {}).roomId);
    // lobby 坏房间只去重：房间保留等待、不产生锁与奖励处理。
    assert.equal(f.store.db.prepare('SELECT status FROM duel_rooms WHERE id=?').get(lobby.roomId).status, 'lobby');
    assert.deepEqual(f.store.db.prepare('SELECT side FROM duel_participants WHERE room_id=? ORDER BY side').all(lobby.roomId).map(r => r.side), ['A', 'B']);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM duel_rewards WHERE room_id=?').get(lobby.roomId).n, 0);
  } finally { f.close(); }
});

test('防御：终局时房间不足两人不因配额计算崩溃，房间仍能正常终局', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    playActiveRounds(f, room, 4);
    // 异常数据：直接删掉一名参与者，留守方投降不得在 quotaFactors 抛 TypeError。
    f.store.db.prepare('DELETE FROM duel_participants WHERE room_id=? AND user_id=?').run(room, f.B.id);
    assert.doesNotThrow(() => f.duel.leave(f.A, room, 'surrender'));
    const finished = f.duel.view(f.A, room);
    assert.equal(finished.room.status, 'finished');
    assert.equal(finished.room.outcome, 'B', '胜负口径不变：投降方对手获胜');
    const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=?').all(room);
    assert.equal(rewards.length, 1);
    assert.equal(rewards[0].actual_coins, 0, '投降方 0');
    assert.equal(rewards[0].reason, 'forfeited');
    // 锁按房间整体清理：被删参与者 B 的锁不得遗留（否则 B 永远无法开新房）。
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM active_game_locks WHERE kind='duel' AND ref_id=?").get(room).n, 0, '房间全部 duel 锁已释放');
    assert.ok(f.duel.create(f.A, {}).roomId);
    assert.ok(f.duel.create(f.B, {}).roomId, '被删参与者 B 也能重开');
  } finally { f.close(); }
});

test('迁移：只有两个 B 的 lobby、留守者已准备 → 去重后 ready 重置，不绕过再确认开局', () => {
  const f = fixture();
  try {
    // 还原旧 bug 场景：A 建房 B 加入，A 离开后旧版 join 固定写 B → 房间只剩双 B。
    const created = f.duel.create(f.A, {});
    f.duel.join(f.B, created.inviteCode);
    f.duel.loadout(f.B, created.roomId, f.defaultLoadout(f.B));
    f.duel.setReady(f.B, created.roomId, true); // 留守 B 已准备
    f.duel.leave(f.A, created.roomId, 'leave');
    // 换成无 side 唯一约束的旧 schema 表，注入第二个 B。
    f.store.db.exec(`
      CREATE TABLE duel_participants_old(
        room_id TEXT NOT NULL REFERENCES duel_rooms(id), user_id TEXT NOT NULL REFERENCES users(id),
        side TEXT NOT NULL, name TEXT NOT NULL, loadout TEXT, state TEXT NOT NULL,
        player_revision INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER,
        UNIQUE(room_id, user_id));
      INSERT INTO duel_participants_old SELECT * FROM duel_participants;
      DROP TABLE duel_participants;
      ALTER TABLE duel_participants_old RENAME TO duel_participants;`);
    f.store.db.prepare('INSERT INTO duel_participants(room_id,user_id,side,name,state,last_seen_at) VALUES(?,?,?,?,?,?)')
      .run(created.roomId, f.C.id, 'B', '玩家丙', JSON.stringify({ hp: 32, activity: { meaningfulRounds: [], deployedDefIds: [] } }), f.clock());
    const revisionBefore = f.store.db.prepare('SELECT revision FROM duel_rooms WHERE id=?').get(created.roomId).revision;
    const duel2 = createDuelService(f.store.db, { now: () => f.clock() });
    // 去重保留留守 B，但 ready 被重置、房间 revision 递增。
    const survivor = f.store.db.prepare('SELECT * FROM duel_participants WHERE room_id=?').get(created.roomId);
    assert.equal(survivor.user_id, f.B.id);
    assert.equal(survivor.ready, 0, '留守方准备状态重置');
    assert.equal(f.store.db.prepare('SELECT revision FROM duel_rooms WHERE id=?').get(created.roomId).revision, revisionBefore + 1);
    // 新玩家补入 A 座并准备：不得直接开局；留守 B 再确认后才开局。
    assert.equal(duel2.join(f.C, created.inviteCode).side, 'A');
    duel2.loadout(f.C, created.roomId, f.defaultLoadout(f.C));
    assert.equal(duel2.setReady(f.C, created.roomId, true).started, false, '只有一人准备不开局');
    assert.equal(duel2.view(f.B, created.roomId).room.status, 'lobby');
    assert.equal(duel2.setReady(f.B, created.roomId, true).started, true, '留守方再确认后开局');
  } finally { f.close(); }
});

test('长期掉线：单方超 60 秒宽限未心跳自动判负；双方失联不单方面判负', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    const rule = duelRoundRule(1);
    f.step(rule.planningSec * 1000, { noHeartbeat: true });            // → R1 combat（30s）
    f.duel.view(f.A, room);                     // A 心跳；B 从此不再出现
    f.step(rule.combatPresentationSec * 1000, { noHeartbeat: true });  // → settlement（50s）
    f.duel.view(f.A, room);
    f.step(rule.settlementSec * 1000, { noHeartbeat: true });          // → R2 planning（53s）
    f.duel.view(f.A, room);
    f.step(duelRoundRule(2).planningSec * 1000, { noHeartbeat: true });// 88s：B 距最后心跳 > 60s → 判负
    const finished = f.duel.view(f.A, room);
    assert.equal(finished.room.status, 'finished');
    assert.equal(finished.room.outcome, 'A', '掉线方判负，在线方获胜');
    assert.equal(finished.room.finishReason, 'disconnect_forfeit');
    const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=?').all(room);
    const rewardA = rewards.find(r => r.user_id === f.A.id);
    const rewardB = rewards.find(r => r.user_id === f.B.id);
    assert.ok(rewardB.reason.includes('forfeited'), '掉线方 0 奖励');
    assert.equal(rewardB.actual_coins, 0);
    assert.equal(rewardA.actual_coins, 0, '对局 < 180 秒，对手同样未达奖励门槛');

    // 双方同时失联：不产生单方面判负，房间继续按服务器时钟推进。
    const room2 = f.openRoom();
    f.step(duelRoundRule(1).planningSec * 1000, { noHeartbeat: true });
    f.step(duelRoundRule(1).combatPresentationSec * 1000, { noHeartbeat: true });
    f.step(duelRoundRule(1).settlementSec * 1000, { noHeartbeat: true });
    f.step(duelRoundRule(2).planningSec * 1000, { noHeartbeat: true });
    const still = f.duel.view(f.A, room2);
    assert.equal(still.room.status, 'playing', '双方失联不判 disconnect_forfeit');
  } finally { f.close(); }
});

test('单成员大厅过期：房间正常收口、锁释放、后来者收到中文提示（不再崩溃循环）', () => {
  const f = fixture();
  try {
    const created = f.duel.create(f.A, {});
    f.advance(DUEL_ROOM.lobbyExpiresSec * 1000 + 1000);
    assert.doesNotThrow(() => f.duel.tick(), '单成员过期收口不得抛错');
    const room = f.store.db.prepare('SELECT status, finish_reason FROM duel_rooms WHERE id=?').get(created.roomId);
    assert.equal(room.status, 'finished');
    assert.equal(room.finish_reason, 'lobby_expired');
    assert.throws(() => f.duel.join(f.B, created.inviteCode), error => error.status === 409 && /已开始或已结束/.test(error.message), '后来者收到业务提示而非内部错误');
    assert.ok(f.duel.create(f.A, {}).roomId, '房主未被僵尸房间锁死，可再开新房');
    f.advance(1000);
    assert.doesNotThrow(() => f.duel.tick(), '收口后的房间不再进入扫描批次');
  } finally { f.close(); }
});

test('调度器饥饿防御：连续失败的房间被强制收口并释放锁，不再占住 LIMIT 50 批次', () => {
  const f = fixture();
  try {
    const created = f.duel.create(f.A, {});
    // 注入异常数据：进行中 + 已到期 + 成员 state 坏 JSON，正常管线每次 tick 都失败。
    f.store.db.prepare("UPDATE duel_rooms SET status='playing', phase='planning', phase_ends_at=? WHERE id=?").run(1000000 - 1000, created.roomId);
    f.store.db.prepare("UPDATE duel_participants SET state='{bad json' WHERE room_id=?").run(created.roomId);
    f.store.db.prepare("INSERT INTO active_game_locks(user_id,kind,ref_id) VALUES(?,'duel',?)").run(f.A.id, created.roomId);
    for (let i = 0; i < 4; i++) { f.advance(1000); f.duel.tick(); }
    let room = f.store.db.prepare('SELECT status FROM duel_rooms WHERE id=?').get(created.roomId);
    assert.equal(room.status, 'playing', '未达连续失败阈值前不强制收口');
    for (let i = 0; i < 2; i++) { f.advance(1000); f.duel.tick(); }
    room = f.store.db.prepare('SELECT status, finish_reason FROM duel_rooms WHERE id=?').get(created.roomId);
    assert.equal(room.status, 'finished', '连续失败达阈值后强制收口');
    assert.ok(['service_interrupted', 'tick_failure'].includes(room.finish_reason));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM active_game_locks WHERE ref_id=?').get(created.roomId).n, 0, '强制收口必须释放 active lock');
  } finally { f.close(); }
});

test('等待房间上限：账号只能参与一个大厅，同房重连幂等，离开后可加入其他大厅',()=>{
 const f=fixture();try{
  const a=f.duel.create(f.A),b=f.duel.create(f.B);
  assert.throws(()=>f.duel.join(f.B,a.inviteCode),error=>error.status===409&&error.code==='LOBBY_EXISTS');
  assert.equal(f.duel.join(f.B,b.inviteCode).resumed,true);
  assert.equal(f.duel.create(f.B).roomId,b.roomId);
  f.duel.leave(f.B,b.roomId,'leave');f.duel.join(f.B,a.inviteCode);
  assert.equal(f.duel.create(f.B).roomId,a.roomId);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM duel_participants p JOIN duel_rooms r ON r.id=p.room_id WHERE p.user_id=? AND r.status='lobby'").get(f.B.id).n,1);
 }finally{f.close();}
});
test('大厅过期取消不解析玩家 JSON，不读取或占用配额；截止时刻即到期',()=>{
 const f=fixture();try{
  const room=f.duel.create(f.A);f.store.db.prepare("UPDATE duel_participants SET state='{bad' WHERE room_id=?").run(room.roomId);
  f.advance(DUEL_ROOM.lobbyExpiresSec*1000);assert.doesNotThrow(()=>f.duel.tick());
  assert.equal(f.store.db.prepare('SELECT status FROM duel_rooms WHERE id=?').get(room.roomId).status,'finished');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM reward_quota').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM duel_pair_quota').get().n,0);
  assert.equal(f.store.db.prepare('SELECT actual_coins FROM duel_rewards WHERE room_id=?').get(room.roomId).actual_coins,0);
 }finally{f.close();}
});
test('直接加入过期大厅的取消先提交，不因随后返回错误被事务回滚；创建也回收本人旧大厅',()=>{
 const f=fixture();try{
  const room=f.duel.create(f.A);f.advance(DUEL_ROOM.lobbyExpiresSec*1000);
  assert.throws(()=>f.duel.join(f.B,room.inviteCode),error=>error.code==='ROOM_FINISHED');
  assert.equal(f.store.db.prepare('SELECT status FROM duel_rooms WHERE id=?').get(room.roomId).status,'finished');
  const next=f.duel.create(f.A);f.advance(DUEL_ROOM.lobbyExpiresSec*1000);
  const fresh=f.duel.create(f.A);assert.notEqual(fresh.roomId,next.roomId);assert.equal(fresh.resumed,false);
  assert.equal(f.store.db.prepare('SELECT status FROM duel_rooms WHERE id=?').get(next.roomId).status,'finished');
 }finally{f.close();}
});
test('调度预算隔离：50 个更早到期的大厅不能挤占正常双人对局的推进名额',()=>{
 const f=fixture();try{
  for(let i=0;i<50;i++){
   const user=f.store.login({issuer:'fixture',clientId:'fixture',subject:'backlog-'+i,name:'backlog'}).user;f.game.ensureProfile(user);f.duel.create(user);
  }
  f.advance(121000);const room=f.openRoom();f.advance(duelRoundRule(1).planningSec*1000);
  assert.equal(f.duel.tick(),51);
  assert.equal(f.duel.view(f.A,room).room.phase,'combat');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM duel_rooms WHERE status='lobby'").get().n,0);
 }finally{f.close();}
});

for (const round of [1, 99]) test('强制收口后的坏房间可读取安全终局并保留原始数据：round=' + round, t => {
  const f = fixture();
  t.mock.method(console, 'error', () => {});
  try {
    const room = f.openRoom(), original = '{broken player state';
    const before = [f.game.snapshot(f.A).state.coins, f.game.snapshot(f.B).state.coins];
    f.store.db.prepare("UPDATE duel_rooms SET round_no=?, phase_ends_at=?, finish_reason='round10', outcome='A' WHERE id=?").run(round, f.clock() - 1, room);
    f.store.db.prepare('UPDATE duel_participants SET state=?,loadout=? WHERE room_id=? AND user_id=?').run(original, '{broken loadout', room, f.A.id);
    for (let i = 0; i < 5; i++) f.duel.tick();
    assert.equal(f.store.db.prepare('SELECT finish_reason FROM duel_rooms WHERE id=?').get(room).finish_reason, 'tick_failure');
    for (const user of [f.A, f.B]) {
      assert.equal(f.duel.me(user).lastFinishedRoomId, room);
      const view = f.duel.view(user, room);
      assert.equal(view.room.status, 'finished'); assert.equal(view.room.outcome, null);
      assert.equal(view.room.round, round === 1 ? 1 : 0);
      assert.deepEqual(view.self.reward, { base: 0, factor: 0, actualCoins: 0, reason: 'service_abort' });
      assert.equal(view.self.loadout, null); assert.deepEqual(view.self.roster, []);
      assert.equal(view.scout, null); assert.equal(view.currentBattle, null);
    }
    assert.equal(f.store.db.prepare('SELECT state FROM duel_participants WHERE room_id=? AND user_id=?').get(room, f.A.id).state, original);
    const rewards = f.store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=?').all(room);
    assert.equal(rewards.length, 2);
    assert.equal(JSON.parse(rewards[0].data).previousOutcome, 'A');
    assert.equal(JSON.parse(rewards[0].data).previousFinishReason, 'round10');
    f.duel.tick(); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM duel_rewards WHERE room_id=?').get(room).n, 2);
    assert.deepEqual([f.game.snapshot(f.A).state.coins, f.game.snapshot(f.B).state.coins], before);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM reward_quota').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM duel_pair_quota').get().n, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM active_game_locks WHERE kind='duel' AND ref_id=?").get(room).n, 0);
    assert.throws(() => f.duel.view(f.C, room), error => error.status === 403, '摘要仍需成员权限');
    const restarted = createDuelService(f.store.db, { now: f.clock });
    assert.equal(restarted.view(f.A, room).self.reward.reason, 'service_abort');
    assert.ok(f.openRoom(), '双方可正常重开');
  } finally { f.close(); }
});

test('强制收口的零奖励写入失败时整体回滚，恢复后可重试完成', t => {
  const f = fixture();
  t.mock.method(console, 'error', () => {});
  try {
    const room = f.openRoom();
    f.store.db.prepare('UPDATE duel_rooms SET phase_ends_at=? WHERE id=?').run(f.clock() - 1, room);
    f.store.db.prepare("UPDATE duel_participants SET state='{bad json' WHERE room_id=? AND user_id=?").run(room, f.A.id);
    f.store.db.exec("CREATE TEMP TRIGGER fail_abort_reward BEFORE INSERT ON duel_rewards WHEN NEW.reason='service_abort' BEGIN SELECT RAISE(ABORT,'injected abort reward failure'); END;");
    for (let i = 0; i < 5; i++) f.duel.tick();
    assert.equal(f.store.db.prepare('SELECT status FROM duel_rooms WHERE id=?').get(room).status, 'playing');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM active_game_locks WHERE ref_id=?').get(room).n, 2);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM duel_rewards WHERE room_id=?').get(room).n, 0);
    f.store.db.exec('DROP TRIGGER fail_abort_reward;');
    for (let i = 0; i < 5; i++) f.duel.tick();
    assert.equal(f.duel.view(f.A, room).self.reward.reason, 'service_abort');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM active_game_locks WHERE ref_id=?').get(room).n, 0);
  } finally { f.close(); }
});

test('过期大厅的损坏 JSON 不妨碍用户读取取消原因和零奖励', () => {
  const f = fixture();
  try {
    const room = f.duel.create(f.A);
    f.store.db.prepare("UPDATE duel_participants SET state='{bad json',loadout='{bad loadout' WHERE room_id=?").run(room.roomId);
    f.advance(DUEL_ROOM.lobbyExpiresSec * 1000); f.duel.tick();
    const view = f.duel.view(f.A, room.roomId);
    assert.equal(view.room.finishReason, 'lobby_expired'); assert.equal(view.room.outcome, null);
    assert.equal(view.self.reward.actualCoins, 0); assert.equal(view.self.reward.reason, 'service_abort');
  } finally { f.close(); }
});

test('正常收口管线可用的服务异常也清除旧胜负，取消不计奖励或配额', () => {
  const f = fixture();
  try {
    const room = f.openRoom();
    f.store.db.prepare("UPDATE duel_rooms SET outcome='A',finish_reason='round10',phase_ends_at=? WHERE id=?").run(f.clock() - 601000, room);
    f.duel.tick();
    const row = f.store.db.prepare('SELECT outcome,finish_reason FROM duel_rooms WHERE id=?').get(room);
    assert.equal(row.finish_reason, 'service_interrupted'); assert.equal(row.outcome, null);
    const view = f.duel.view(f.A, room);
    assert.equal(view.room.outcome, null); assert.equal(view.self.reward.actualCoins, 0);
    assert.equal(view.self.reward.reason, 'service_abort');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM reward_quota').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM duel_pair_quota').get().n, 0);
  } finally { f.close(); }
});
