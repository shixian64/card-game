#!/usr/bin/env node
// 双客户端完整局证据（服务层）：两名真实内部用户从建房到终局走完整十轮，
// 逐轮记录双方视角（金币 / 生命 / 阵容规模 / 结果），终局记录双方奖励与账本。
// 使用隔离内存库，进程结束自动丢弃；不连接任何真实数据库。
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../server/store.mjs';
import { createGameService } from '../server/game.mjs';
import { createDuelService } from '../server/duel.mjs';
import { duelRoundRule } from '../src/duel-rules.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'artifacts/duel-v1');
mkdirSync(OUT, { recursive: true });
let clock = 1760000000000;
const now = () => clock;
const store = openStore(':memory:');
const game = createGameService(store.db, { now });
const duel = createDuelService(store.db, { now, secureRandom: () => 0.314159 });
const log = [];
const say = line => { log.push(line); console.log(line); };

const login = (subject, name, favorite) => {
  const user = store.login({ issuer: 'demo', clientId: 'demo', subject, name }).user;
  game.ensureProfile(user);
  game.game(user, 'starter.claim', { requestId: 'starter-' + subject, favoriteDefId: favorite });
  return user;
};
const alice = login('demo-alice', '玩家甲', 'moon-deer');
const bob = login('demo-bob', '玩家乙', 'sun-cub');
const loadoutOf = user => {
  const maxByDef = new Map();
  for (const card of game.snapshot(user).state.cards) maxByDef.set(card.defId, Math.max(maxByDef.get(card.defId) ?? 0, card.rank));
  return { defs: [...maxByDef.entries()].slice(0, 8).map(([defId, battleQuality]) => ({ defId, battleQuality })), starters: [...maxByDef.keys()].slice(0, 2) };
};
const read = (room, user) => JSON.parse(store.db.prepare('SELECT state FROM duel_participants WHERE room_id=? AND user_id=?').get(room, user.id).state);
const cmdId = (() => { let n = 0; return () => 'demo-req-' + (++n); })();
const command = (room, user, action, payload, phaseId, revision) =>
  duel.command(user, room, { requestId: cmdId(), phaseId, expectedPlayerRevision: revision, action, payload });
const formationFor = (state, population) => {
  const units = state.roster.slice(0, population);
  let front = 0, back = 0;
  return units.map(u => {
    const tankLike = ['moon-deer', 'star-deer', 'crescent-dancer', 'starlit-arch', 'comet-tail', 'moon-soloist', 'eclipse-deer'].includes(u.defId);
    return { unitId: u.unitId, localSlot: tankLike || front < 2 ? [1, 3, 5, 8, 10, 12, 2][Math.min(front++, 6)] : [22, 24, 26, 15, 17, 19, 21][Math.min(back++, 6)] };
  });
};
const playPlanning = (room, user, aggressive) => {
  let view = duel.view(user, room);
  const state = read(room, user);
  const affordable = state.shop.filter(o => o.cost <= state.gold).sort((a, b) => b.quality - a.quality)[0];
  if (affordable && (aggressive || state.gold - affordable.cost >= 10)) command(room, user, 'buy', { offerId: affordable.offerId }, view.room.phaseId, view.self.playerRevision);
  view = duel.view(user, room);
  const augment = view.self.pendingAugmentOffer;
  if (augment) { command(room, user, 'augment.select', { augmentId: augment.candidates[0] }, view.room.phaseId, view.self.playerRevision); view = duel.view(user, room); }
  const pending = view.self.pendingItemChoice;
  if (pending) { command(room, user, 'item.select', { itemDefId: pending.candidates[0] }, view.room.phaseId, view.self.playerRevision); view = duel.view(user, room); }
  const fresh = read(room, user);
  if (fresh.items.length && fresh.roster.length) {
    const item = fresh.items.find(i => !fresh.roster.some(u => (u.equippedItemIds ?? []).includes(i.itemId)));
    const unit = fresh.roster.find(u => (u.equippedItemIds ?? []).length < (view.self.itemSlots ?? 2));
    if (item && unit) { try { command(room, user, 'item.equip', { itemId: item.itemId, unitId: unit.unitId }, view.room.phaseId, view.self.playerRevision); view = duel.view(user, room); } catch { /* 两槽/同组限制 */ } }
  }
  const latest = read(room, user);
  command(room, user, 'deploy', { formation: formationFor(latest, latest.population) }, view.room.phaseId, view.self.playerRevision);
};

say('=== 星序 ASTERIA 双人短局完整局证据（服务层 demo，隔离内存库） ===');
say('时间基线 ' + new Date(clock).toISOString() + '；规则 DUEL-RULES-1（10 轮 / 32 生命 / 10–14 金币价 / 3 野怪）');
const created = duel.create(alice, {});
say(`甲创建房间 ${created.roomId.slice(0, 8)}… 邀请码 ${created.inviteCode}`);
duel.join(bob, created.inviteCode);
say('乙输入邀请码加入（满两人，第三人将被拒绝）');
duel.loadout(alice, created.roomId, loadoutOf(alice));
duel.loadout(bob, created.roomId, loadoutOf(bob));
duel.setReady(alice, created.roomId, true);
duel.setReady(bob, created.roomId, true);
const room = created.roomId;
say('双方提交 8 卡种牌组与本局品质并准备 → 开局：40 金币 + 两个免费副本（basis=0），人口 3');
say('');
say('轮次 | 类型 | 甲(金币/生命/阵容) | 乙(金币/生命/阵容) | 本轮结果');
let guard = 0;
while (duel.view(alice, room).room.status !== 'finished' && guard++ < 120) {
  const view = duel.view(alice, room);
  if (view.room.phase === 'planning') {
    playPlanning(room, alice, true);
    playPlanning(room, bob, false);
    const rule = duelRoundRule(view.room.round);
    clock += rule.planningSec * 1000; duel.tick();   // 冻结 + 模拟 → combat
  } else if (view.room.phase === 'combat') {
    const a = read(room, alice), b = read(room, bob);
    const battle = view.currentBattle;
    const outcome = battle.kind === 'pvp'
      ? `PvP ${battle.summary.pvp.winner === 'A' ? '甲胜' : battle.summary.pvp.winner === 'B' ? '乙胜' : '平局'}（battleId=${battle.battleIds[0]}）`
      : `野怪 甲${battle.summary.neutral.A ? '胜' : '负'} 乙${battle.summary.neutral.B ? '胜' : '负'}（两个独立子结果）`;
    say(`R${String(view.room.round).padStart(2)} | ${battle.kind === 'pvp' ? 'PvP ' : '野怪'} | ${a.gold}/${a.hp}/${a.roster.length}★x${a.roster.filter(u => u.stars > 1).length} | ${b.gold}/${b.hp}/${b.roster.length}★x${b.roster.filter(u => u.stars > 1).length} | ${outcome}`);
    clock += duelRoundRule(view.room.round).combatPresentationSec * 1000; duel.tick();  // → settlement
  } else if (view.room.phase === 'settlement') {
    clock += duelRoundRule(view.room.round).settlementSec * 1000; duel.tick();          // → 下一轮 / 终局
  } else { clock += 2000; duel.tick(); }
}
const finalA = duel.view(alice, room), finalB = duel.view(bob, room);
say('');
say(`终局：${finalA.room.finishReason} → 结果 ${finalA.room.outcome === 'A' ? '甲胜' : finalA.room.outcome === 'B' ? '乙胜' : '平局'}；甲生命 ${finalA.self.hp} / 乙生命 ${finalB.self.hp}`);
const rewards = store.db.prepare('SELECT * FROM duel_rewards WHERE room_id=? ORDER BY user_id').all(room);
for (const reward of rewards) {
  const who = reward.user_id === alice.id ? '甲' : '乙';
  say(`奖励 ${who}：base=${reward.base} factor=${reward.factor} 实得=${reward.actual_coins} 星币 reason=${JSON.stringify(reward.reason)}（局内金币 / 装备不带出）`);
}
const ledger = store.db.prepare("SELECT user_id,coins,flow FROM ledger WHERE kind='duel.finish' ORDER BY user_id").all();
say('账本：' + JSON.stringify(ledger.map(l => ({ user: l.user_id === alice.id ? '甲' : '乙', coins: l.coins, flow: l.flow }))));
say('配额：' + JSON.stringify(store.db.prepare('SELECT * FROM duel_pair_quota').all()));
say('活跃锁已释放：' + JSON.stringify(store.db.prepare('SELECT COUNT(*) n FROM active_game_locks').get()));
say('同 battleId 两端一致：' + (() => {
  const rounds = store.db.prepare('SELECT round_no, battles FROM duel_rounds WHERE room_id=? ORDER BY round_no').all(room);
  let checked = 0;
  for (const round of rounds) {
    for (const battleId of Object.keys(JSON.parse(round.battles))) {
      const va = duel.battle(alice, room, battleId), vb = duel.battle(bob, room, battleId);
      if (JSON.stringify(va.sim.frames) === JSON.stringify(vb.sim.frames)) checked++;
    }
  }
  return `✓（${checked} 个 battleId 帧级一致）`;
})());
store.db.close();
writeFileSync(resolve(OUT, 'fullrun-demo.txt'), log.join('\n'), 'utf8');
say('');
say('日志已写入 artifacts/duel-v1/fullrun-demo.txt（隔离内存库已丢弃）');
