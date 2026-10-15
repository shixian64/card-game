import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuelHeartbeat, startDuelHomeProbe } from '../src/duel-session.ts';

function scheduler(repeat = false) {
  let nextId = 0;
  const tasks = new Map<number, { callback: () => void; delayMs: number }>();
  const schedule = (callback: () => void, delayMs: number) => {
    const id = ++nextId;
    tasks.set(id, { callback, delayMs });
    return () => { tasks.delete(id); };
  };
  const fire = (id = [...tasks.keys()][0]) => {
    const task = tasks.get(id);
    assert.ok(task, '必须存在待执行的定时器');
    if (!repeat) tasks.delete(id);
    task.callback();
  };
  return { tasks, schedule, fire };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

for (const result of ['finished', 401, 403, 404]) {
  test('旧房间迟到的心跳响应不能停止新房间：' + result, async () => {
    const timers = scheduler(true);
    const old = deferred<{ room: { status: string } }>();
    const requests: string[] = [];
    const heartbeat = createDuelHeartbeat(async (user, room) => {
      requests.push(user + '/' + room);
      return room === 'old' ? old.promise : { room: { status: 'playing' } };
    }, timers.schedule);
    heartbeat.sync('a', 'old'); timers.fire();
    heartbeat.sync('b', 'new');
    if (result === 'finished') old.resolve({ room: { status: result } });
    else old.reject(Object.assign(new Error('旧请求失败'), { status: result }));
    await flush();
    assert.equal(timers.tasks.size, 1);
    assert.equal([...timers.tasks.values()][0].delayMs, 12000);
    timers.fire(); await flush();
    assert.deepEqual(requests, ['a/old', 'b/new']);
    heartbeat.stop(); assert.equal(timers.tasks.size, 0);
  });
}

test('同一账号同一房间离开后重进：旧实例的迟到响应也不能停掉新实例', async () => {
  const timers = scheduler(true), old = deferred<{ room: { status: string } }>();
  const heartbeat = createDuelHeartbeat(() => old.promise, timers.schedule);
  heartbeat.sync('a', 'same'); timers.fire();
  heartbeat.stop(); heartbeat.sync('a', 'same');
  old.resolve({ room: { status: 'finished' } }); await flush();
  assert.equal(timers.tasks.size, 1);
  heartbeat.stop();
});

for (const status of [401, 403, 404, 429, 500, undefined]) {
  test('当前心跳按 HTTP 状态决定停止或保留：' + status, async () => {
    const timers = scheduler(true);
    const heartbeat = createDuelHeartbeat(async () => { throw Object.assign(new Error('模拟失败'), { status }); }, timers.schedule);
    heartbeat.sync('a', 'room'); timers.fire(); await flush();
    assert.equal(timers.tasks.size, status !== undefined && status < 429 ? 0 : 1);
    heartbeat.stop();
  });
}

test('当前房间结束停跳；单次慢请求不阻断后续心跳；显式停止后迟到响应不重启', async () => {
  const timers = scheduler(true), request = deferred<{ room: { status: string } }>();
  let calls = 0;
  const heartbeat = createDuelHeartbeat(() => { calls++; return request.promise; }, timers.schedule);
  heartbeat.sync('a', 'room'); heartbeat.sync('a', 'room');
  assert.equal(timers.tasks.size, 1);
  timers.fire(); timers.fire(); assert.equal(calls, 2);
  request.resolve({ room: { status: 'finished' } }); await flush();
  assert.equal(timers.tasks.size, 0);
  heartbeat.sync('a', 'room'); timers.fire(); heartbeat.stop(); await flush();
  assert.equal(timers.tasks.size, 0);
});

test('自动回局首次断网/5xx 后每 3 秒重试，成功后不再重复探测', async () => {
  const timers = scheduler(), results: (string | null)[] = [];
  let calls = 0;
  const stop = startDuelHomeProbe(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('暂不可用'), { status: calls === 2 ? 503 : undefined });
    return { activeRoomId: 'recovered-room' };
  }, home => results.push(home.activeRoomId), timers.schedule);
  await flush();
  assert.equal(calls, 1); assert.equal([...timers.tasks.values()][0].delayMs, 3000);
  timers.fire(); await flush(); assert.equal(calls, 2);
  timers.fire(); await flush();
  assert.equal(calls, 3); assert.deepEqual(results, ['recovered-room']); assert.equal(timers.tasks.size, 0);
  stop();
});

test('自动回局确认无房间即完成，不循环重试', async () => {
  const timers = scheduler(), results: (string | null)[] = [];
  const stop = startDuelHomeProbe(async () => ({ activeRoomId: null }), home => results.push(home.activeRoomId), timers.schedule);
  await flush(); assert.deepEqual(results, [null]); assert.equal(timers.tasks.size, 0); stop();
});

test('切账号/卸载取消在途恢复请求，忽略不遵守 abort 的旧响应', async () => {
  const timers = scheduler(), old = deferred<{ activeRoomId: string | null }>();
  let signal: AbortSignal | undefined, navigations = 0;
  const stop = startDuelHomeProbe(async value => { signal = value; return old.promise; }, () => { navigations++; }, timers.schedule);
  stop(); assert.equal(signal?.aborted, true);
  old.resolve({ activeRoomId: 'other-account-room' }); await flush();
  assert.equal(navigations, 0); assert.equal(timers.tasks.size, 0);
});

test('切账号/卸载会清除恢复重试定时器，也不会因迟到失败再调度', async () => {
  const timers = scheduler(); let calls = 0;
  const stop = startDuelHomeProbe(async () => { calls++; throw new Error('断网'); }, () => assert.fail('不能跳转'), timers.schedule);
  await flush(); assert.equal(timers.tasks.size, 1); stop(); assert.equal(timers.tasks.size, 0); assert.equal(calls, 1);
  const old = deferred<{ activeRoomId: string | null }>();
  const stopPending = startDuelHomeProbe(() => old.promise, () => assert.fail('不能跳转'), timers.schedule);
  stopPending(); old.reject(new Error('迟到失败')); await flush(); assert.equal(timers.tasks.size, 0);
});
