// 错列六边形棋盘几何（odd-r：奇数行向右错开半格）。
// 全场 8 行 × 7 列 = 56 个逻辑格；我方下半场 rows 4–7（slot 0–27 稳定部署标识），
// 敌方上半场 rows 0–3。本模块是唯一几何权威：邻接、距离、寻路、屏幕投影与
// 命中逆映射共用同一套坐标，前后端不得各自实现。
export const HEX_ROWS = 8;
export const HEX_COLS = 7;
export const BOARD_CELLS = HEX_ROWS * HEX_COLS;
export const DEPLOY_SLOTS = HEX_ROWS / 2 * HEX_COLS; // 28

export interface Cell { row: number; col: number }
export type Side = 'player' | 'enemy';

function ensureInt(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new Error(name + ' 必须是整数');
}

/** slot 0–6 是该方最前排；我方落在 rows 4–7，敌方镜像落在 rows 3–0。 */
export function slotToCell(slot: number, side: Side): Cell {
  ensureInt(slot, '格位');
  if (slot < 0 || slot >= DEPLOY_SLOTS) throw new Error('格位必须在 0–27 之间');
  const band = Math.floor(slot / HEX_COLS), col = slot % HEX_COLS;
  return side === 'player' ? { row: 4 + band, col } : { row: 3 - band, col };
}

/** 仅对我方半场可逆：cell → slot；不在下半场时返回 null。 */
export function cellToPlayerSlot(cell: Cell): number | null {
  if (!inBoard(cell) || cell.row < 4) return null;
  return (cell.row - 4) * HEX_COLS + cell.col;
}

/**
 * 8×7 odd-r 棋盘的 180° 点对称旋转：(row,col) → (7−row, 6−col)。
 * 已验证为该网格的等距变换（六邻接与步数距离保持），双人主对局用它把
 * B 方本地部署位映射到上半场；旧 slotToCell(slot,'enemy') 的“只翻行”映射
 * 属于旧局 / 旧回放语义，不得混用。
 */
export function rotate180(cell: Cell): Cell {
  if (!inBoard(cell)) throw new Error('格位不在棋盘内');
  return { row: HEX_ROWS - 1 - cell.row, col: HEX_COLS - 1 - cell.col };
}

export function inBoard(cell: Cell): boolean {
  return Number.isInteger(cell.row) && Number.isInteger(cell.col)
    && cell.row >= 0 && cell.row < HEX_ROWS && cell.col >= 0 && cell.col < HEX_COLS;
}

export function cellKey(cell: Cell): number { return cell.row * HEX_COLS + cell.col; }
export function keyToCell(key: number): Cell { return { row: Math.floor(key / HEX_COLS), col: key % HEX_COLS }; }

/** odd-r 的六邻居（未裁剪越界）。 */
export function rawNeighbors(cell: Cell): Cell[] {
  const odd = ((cell.row % 2) + 2) % 2 === 1;
  const deltas = odd
    ? [[-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0], [1, 1]]
    : [[-1, -1], [-1, 0], [0, -1], [0, 1], [1, -1], [1, 0]];
  return deltas.map(([dr, dc]) => ({ row: cell.row + dr, col: cell.col + dc }));
}

/** 板内六邻居；内部格恰好 6 个，边界按行奇偶被截断。 */
export function neighbors(cell: Cell): Cell[] {
  if (!inBoard(cell)) throw new Error('格位不在棋盘内');
  return rawNeighbors(cell).filter(inBoard);
}

function toAxial(cell: Cell): { q: number; r: number } {
  return { q: cell.col - (cell.row - (cell.row & 1)) / 2, r: cell.row };
}

/** 六边形步数距离：度量函数，相邻为 1，与行奇偶无关且对称。 */
export function hexDistance(a: Cell, b: Cell): number {
  const pa = toAxial(a), pb = toAxial(b);
  const dq = pa.q - pb.q, dr = pa.r - pb.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function boardCells(): Cell[] {
  const cells: Cell[] = [];
  for (let row = 0; row < HEX_ROWS; row++) for (let col = 0; col < HEX_COLS; col++) cells.push({ row, col });
  return cells;
}

/**
 * 格心在棋盘容器内的归一化坐标（0–1）。奇数行向右偏半格，最后一列奇数行
 * 伸出半格，因此 x 以 7.5 列宽归一，保证所有格心都落在容器内。
 * 战斗单位定位、弹道坐标与命中测试共用本投影。
 */
export function cellCenter(cell: Cell): { x: number; y: number } {
  if (!inBoard(cell)) throw new Error('格位不在棋盘内');
  return {
    x: (cell.col + 0.5 + (cell.row % 2) * 0.5) / (HEX_COLS + 0.5),
    y: (cell.row + 0.5) / HEX_ROWS,
  };
}

/** 点 → 最近格心（命中逆映射）。point 为容器内归一化坐标。 */
export function pointToCell(point: { x: number; y: number }): Cell {
  let best: Cell = { row: 0, col: 0 }, bestDistance = Infinity;
  for (const cell of boardCells()) {
    const center = cellCenter(cell);
    const distance = (center.x - point.x) ** 2 + (center.y - point.y) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = cell; }
  }
  return best;
}
