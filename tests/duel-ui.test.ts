import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// 静态接线检查（无浏览器；实机 UI 验证未执行，见交付说明）。
const duelText = readFileSync(new URL('../src/DuelArena.tsx', import.meta.url), 'utf8');
const appText = readFileSync(new URL('../src/CombatApp.tsx', import.meta.url), 'utf8');
const sessionText = readFileSync(new URL('../src/duel-session.ts', import.meta.url), 'utf8');

test('主对战入口切换：battle 页默认渲染 DuelArena，无独自练习并列入口', () => {
  assert.ok(appText.includes('DuelArena'), 'CombatApp 必须接入 DuelArena');
  assert.ok(appText.includes("snapshot?.match?.status==='playing'"), '旧 MatchArena 只在存局进行中渲染');
  // 不新增“独自练习 / 单人练习”类并列模式文案。
  assert.ok(!duelText.includes('单人模式') && !duelText.includes('练习模式') && !appText.includes('单人模式'));
});

test('B 端视角：客户端只做 180° 显示旋转，不重新模拟', () => {
  assert.ok(duelText.includes('rotate180'), 'B 端显示必须用 rotate180（己方在下）');
  assert.ok(!duelText.includes('simulateDuel'), '客户端不得运行战斗模拟（服务器权威）');
  assert.ok(duelText.includes("self.side === 'A'"), '视角转换依据服务端下发的 side');
});

test('隐私与轮询：2 秒快照轮询 + 回放按 battleId 单独请求', () => {
  assert.ok(/setInterval\([\s\S]*?,\s*2000\)/.test(duelText), '2 秒状态轮询');
  assert.ok(duelText.includes('/battles/'), '回放按 battleId 单独请求（轮询只带摘要）');
});

test('命令契约：requestId / phaseId / expectedPlayerRevision 随命令提交', () => {
  assert.ok(duelText.includes('requestId: makeRequestId()'));
  assert.ok(duelText.includes('expectedPlayerRevision'));
  assert.ok(duelText.includes('phaseId'));
  // 服务器时钟偏移估算，不用本地 setInterval 计数决定阶段。
  assert.ok(duelText.includes('serverNow'));
});

test('装备与商店 UI：三选一、两槽穿戴、免费卸下、买格不补格提示', () => {
  assert.ok(duelText.includes('item.select'));
  assert.ok(duelText.includes('item.equip'));
  assert.ok(duelText.includes('item.unequip'));
  assert.ok(duelText.includes('买一格不补格'));
  assert.ok(duelText.includes('不自动穿戴'), '到期自动入背包不自动穿戴的说明');
});

test('星契 UI：三选一、自动选择说明、双方已选公开、动态商店格 / 刷新价', () => {
  assert.ok(duelText.includes("command('augment.select'"), '星契选择必须走服务端命令');
  assert.ok(duelText.includes('pendingAugmentOffer'), '消费服务端待选星契');
  assert.ok(duelText.includes('本阶段结束前未选将按候选顺序自动选第一项'));
  assert.ok(duelText.includes('对方星契'), '已选星契对对手公开');
  assert.ok(duelText.includes('self.shopSlots') && duelText.includes('self.rerollCost'), '商店格 / 刷新价读服务端');
  assert.ok(duelText.includes('self.freeRerolls'), '免费刷新按服务端剩余次数');
});

test('羁绊面板：与战斗内核同源计数，星契徽记追加后显示', () => {
  assert.ok(duelText.includes('getSynergies'), '羁绊面板复用战斗内核 getSynergies');
  assert.ok(duelText.includes('applyAugmentTraitBonuses'), '星契徽记在面板中追加计数');
  assert.ok(duelText.includes('duel-synergies'), '羁绊面板可被样式与测试定位');
  assert.ok(duelText.includes('按不同卡种计数'), '面板说明不让人误解为重复卡凑羁绊');
});

test('终局与投降：一次结算视图、局内资产不带出说明', () => {
  assert.ok(duelText.includes('投降'));
  assert.ok(duelText.includes('不带入永久资产') || duelText.includes('全部清零'));
  assert.ok(duelText.includes('胜 120 / 负 100 / 平 110'), '奖励口径展示为起测默认值');
});

test('DuelArena 样式与既有 CSS 体系并存', () => {
  const cssText = readFileSync(new URL('../src/duel-arena.css', import.meta.url), 'utf8');
  assert.ok(cssText.includes('.duel-arena') && cssText.includes('.duel-board'));
});

test('TSX 源码语法可解析（仅解析诊断，非编译；构建未获授权未执行）', () => {
  for (const file of ['DuelArena.tsx', 'CombatApp.tsx']) {
    const text = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const diagnostics = (source as unknown as { parseDiagnostics: { messageText?: unknown }[] }).parseDiagnostics ?? [];
    assert.equal(diagnostics.length, 0, file + ' 存在语法错误：' + (diagnostics[0]?.messageText ?? ''));
  }
});

// ── 评审修复回归（静态接线；语义由 server/duel.test.mjs 覆盖）─────────────────

test('修复：创建 / 加入直接使用响应 roomId，不再依赖 /me 的 activeRoomId', () => {
  assert.ok(duelText.includes("post<{ roomId: string }>('/api/duel/create'"), '创建读取响应 roomId');
  assert.ok(duelText.includes("post<{ roomId: string }>('/api/duel/join'"), '加入读取响应 roomId');
  assert.ok(!duelText.includes("callDuel<{ activeRoomId: string }>(userId, '/api/duel/me')"), '不得再用 /me 拿 activeRoomId 进房');
});

test('修复：牌组按后端契约 {defId,battleQuality} 提交，不展开本地草稿', () => {
  assert.ok(duelText.includes('defs: effectiveDraft.defs.map(defId => ({ defId, battleQuality: effectiveDraft.qualities[defId] ?? 1 }))'));
  assert.ok(!duelText.includes('...effectiveDraft }'), '禁止直接展开 defs 字符串数组');
});

test('修复：B 端显示、棋子匹配与点击逆映射统一走 display 坐标', () => {
  assert.ok(duelText.includes('const center = cellCenter(display)'), '格心定位用 display');
  assert.ok(duelText.includes('display.row === 4 + Math.floor(entry.localSlot / 7) && display.col === entry.localSlot % 7'), '上阵匹配用 display');
  assert.ok(duelText.includes('const localSlot = (display.row - 4) * 7 + display.col;'), '点击逆映射用 display（A/B 同式）');
  assert.ok(duelText.includes('u.row === physical.row && u.col === physical.col'), '回放帧按 physical 匹配');
});

test('修复：轮询 / 初始化失败保留房间并重试；隐藏页保心跳', () => {
  assert.ok(duelText.includes('服务器明确说房间不可读'), '只有服务器 4xx 才清空房间回大厅');
  assert.ok(duelText.includes('保留房间 ID 与现有视图，轮询继续重试'), '网络失败保留 roomRef 重试');
  assert.ok(duelText.includes('setInterval(() => void attempt(), 3000)'), '/me 网络失败 3 秒重试');
  assert.ok(duelText.includes('15000'), '隐藏标签降频心跳（服务端 60 秒宽限判掉线）');
});

test('修复：回放 ID 含轮次前缀、进度映射阶段剩余时间、阶段变化不重置', () => {
  assert.ok(duelText.includes("'r' + battle.round + '-' + suffix"), '回放 ID 前缀拼接');
  assert.ok(duelText.includes('Math.floor(remainingMs / framesLeft)'), '帧间隔按剩余时间映射');
  // 长回放（289+ 帧）在剩余时间内放不下时：下限降到 40ms，仍不够则一拍多帧抽帧加速，
  // 不得被阶段切换截断直接跳末帧（评审修复 P2）。
  assert.ok(duelText.includes('const framesPerTick = Math.max(1, Math.ceil(framesLeft / ticksLeft))'), '一拍多帧抽帧加速');
  assert.ok(duelText.includes('value + framesPerTick'), '推进按每拍帧数前进');
  assert.ok(duelText.includes('if (replay?.battleId === ownBattleId) return'), '同场回放不因阶段变化重载归零');
});

test('修复：沉浸对战页提供返回收藏导航（不投降 / 不暂停房间）', () => {
  assert.ok(appText.includes("onRewardClaimed={()=>void refreshGame(duelUser.id)} onBack={()=>go('collection')}"), 'CombatApp 给 DuelArena 传 onBack');
  assert.ok(duelText.includes('返回收藏'), 'DuelArena 提供返回收藏按钮');
  assert.ok(duelText.includes('不算投降'), '返回收藏不触发投降的说明');
});

// ── 交互修复回归（2026-10-15 UX 审查；语义验证见 server/duel.test.mjs）────────

test('修复：返回收藏后模块级心跳保活，离开本页不再被判掉线', () => {
  assert.ok(duelText.includes('function syncDuelHeartbeat'), '模块级保活心跳');
  assert.ok(duelText.includes('createDuelHeartbeat'), '接入可验证的心跳生命周期控制器');
  assert.ok(sessionText.includes(', 12000)'), '低频心跳间隔（服务端 60 秒宽限）');
  assert.ok(duelText.includes('stopDuelHeartbeat(); onRewardClaimed()'), '终局返回大厅停心跳');
  assert.ok(/leave'[^]*?stopDuelHeartbeat\(\)/.test(duelText), '主动离开房间停心跳');
});

test('修复：恢复链路 settled 以房间落定为准，被踢回大厅后节流复查 /me', () => {
  assert.ok(duelText.includes('roomRef.current === me.activeRoomId'), 'settled 只在 roomRef 写入后置位');
  assert.ok(duelText.includes('setRecoverProbe'), '4xx 被踢回大厅触发 /me 复查');
  assert.ok(duelText.includes('lastKickRef.current > 10000'), '复查有节流，不形成紧密循环');
});

test('修复：准备页首点卡牌即从默认牌组初始化草稿', () => {
  assert.ok(duelText.includes('const base = current ?? defaultDraft();'), '首点从默认草稿初始化');
  assert.ok(duelText.includes('const effectiveDraft = draft ?? defaultDraft();'), '展示与草稿同源');
  assert.ok(!duelText.includes('if (!current) return current;'), '不再静默吞掉首次点击');
});

test('修复：新号首登导向新手礼包页；刷新后自动回到进行中对局', () => {
  assert.ok(appText.includes("snapshot.state.starter?.status==='pending'"), '新手礼包未领时切到抽卡页');
  assert.ok(appText.includes("starterDirected.current===userId"), '每账号只导向一次');
  assert.ok(appText.includes("me.activeRoomId)setPage('battle')"), '有进行中决斗房间时回对战页');
});

test('修复：本命选择前可查看技能详情；aria 动作与实际行为一致', () => {
  assert.ok(appText.includes('starter-preview'), '本命候选技能预览面板');
  assert.ok(appText.includes('actionLabel="选为本命候选"'), '本命候选 aria 动作准确');
  assert.ok(appText.includes('actionLabel="选择这张卡"'), '三选一候选 aria 动作准确');
  assert.ok(appText.includes('背包还是空的'), '空收藏空状态给新手明确去向');
});

test('异常取消终局不冒充胜负，不显示占位生命；恢复请求随身份生命周期取消', () => {
  assert.ok(duelText.includes("aborted ? '对局已取消'"));
  assert.ok(duelText.includes('!aborted && <p className="duel-final-hp">'));
  assert.ok(duelText.includes('服务异常，本局已取消'));
  assert.ok(appText.includes('return startDuelHomeProbe('));
  assert.ok(appText.includes('},[duelProbeUserId])'));
  assert.ok(appText.includes('if(identityRef.current!==userId)return;'));
});
