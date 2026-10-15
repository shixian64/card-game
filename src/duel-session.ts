// 不依赖 React 的会话生命周期；定时器可注入，直接验证迟到响应与断网重试。
type Schedule = (callback: () => void, delayMs: number) => () => void;
interface RoomStatus { room: { status: string } }
export interface DuelHome { activeRoomId: string | null }

const every: Schedule = (callback, delayMs) => {
  const timer = setInterval(callback, delayMs);
  return () => clearInterval(timer);
};
const later: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export function createDuelHeartbeat(
  readRoom: (userId: string, roomId: string) => Promise<RoomStatus>,
  schedule: Schedule = every,
) {
  let current: { owner: string; cancel: () => void } | null = null;
  const stop = () => {
    const previous = current;
    current = null;
    previous?.cancel();
  };
  const sync = (userId: string, roomId: string) => {
    const owner = userId + '/' + roomId;
    if (current?.owner === owner) return;
    stop();
    const heartbeat = { owner, cancel: () => {} };
    current = heartbeat;
    heartbeat.cancel = schedule(() => {
      if (current !== heartbeat) return;
      void readRoom(userId, roomId)
        .then(next => {
          // 比较实例而非 owner 字符串，避免同房离开后重进的 ABA 竞态。
          if (current === heartbeat && next.room.status === 'finished') stop();
        })
        .catch((cause: unknown) => {
          const status = (cause as { status?: number } | null)?.status;
          if (current === heartbeat && typeof status === 'number' && status >= 400 && status < 500 && status !== 429) stop();
        });
    }, 12000);
  };
  return { sync, stop };
}

export function startDuelHomeProbe(
  readHome: (signal: AbortSignal) => Promise<DuelHome>,
  onResolved: (home: DuelHome) => void,
  schedule: Schedule = later,
) {
  let cancelled = false;
  let controller: AbortController | null = null;
  let cancelRetry: (() => void) | null = null;
  const attempt = async () => {
    if (cancelled) return;
    controller = new AbortController();
    try {
      const home = await readHome(controller.signal);
      if (!cancelled) onResolved(home);
    } catch {
      if (!cancelled) cancelRetry = schedule(() => { cancelRetry = null; void attempt(); }, 3000);
    }
  };
  void attempt();
  return () => {
    cancelled = true;
    controller?.abort();
    cancelRetry?.();
  };
}
