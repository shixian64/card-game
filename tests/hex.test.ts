import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEX_ROWS, HEX_COLS, BOARD_CELLS, DEPLOY_SLOTS,
  slotToCell, cellToPlayerSlot, inBoard, cellKey, keyToCell,
  neighbors, hexDistance, boardCells, cellCenter, pointToCell,
} from '../src/hex.ts';

test('棋盘规格：8×7 共 56 格，单方 28 个部署位',()=>{
  assert.equal(HEX_ROWS*HEX_COLS,56);assert.equal(BOARD_CELLS,56);assert.equal(DEPLOY_SLOTS,28);
  assert.equal(boardCells().length,56);
});

test('slot 映射：我方 rows 4–7、敌方 rows 3–0，28 个 slot 双射到下半场',()=>{
  const playerCells=new Set<number>(),enemyCells=new Set<number>();
  for(let slot=0;slot<28;slot++){
    const player=slotToCell(slot,'player'),enemy=slotToCell(slot,'enemy');
    assert.ok(inBoard(player)&&inBoard(enemy));
    assert.ok(player.row>=4&&player.row<=7,'我方必须在下半场');
    assert.ok(enemy.row>=0&&enemy.row<=3,'敌方必须在上半场');
    assert.equal(player.col,slot%7);assert.equal(enemy.col,slot%7);
    playerCells.add(cellKey(player));enemyCells.add(cellKey(enemy));
    assert.equal(cellToPlayerSlot(player),slot,'我方 slot 可逆');
    assert.equal(cellToPlayerSlot(enemy),null,'敌方格不属于我方部署位');
  }
  assert.equal(playerCells.size,28);assert.equal(enemyCells.size,28);
  for(const cell of boardCells())if(cell.row<4)assert.equal(cellToPlayerSlot(cell),null);
  assert.throws(()=>slotToCell(-1,'player'));assert.throws(()=>slotToCell(28,'player'));
  assert.throws(()=>slotToCell(1.5,'player'));
});

test('邻接：内部格恰有 6 个邻居，关系对称，边界按行奇偶截断',()=>{
  for(const cell of boardCells()){
    const list=neighbors(cell);
    assert.ok(list.length>=2&&list.length<=6);
    assert.equal(new Set(list.map(cellKey)).size,list.length);
    for(const other of list){
      assert.ok(inBoard(other));
      assert.equal(hexDistance(cell,other),1,'邻居必须相邻');
      assert.ok(neighbors(other).some(n=>cellKey(n)===cellKey(cell)),'邻接关系必须对称');
    }
  }
  // 中心格 (4,3) 恰好六个邻居。
  const center=neighbors({row:4,col:3});
  assert.equal(center.length,6);
  // 错列验证：偶数行 (4,c) 的左上邻居是 (3,c-1)；奇数行 (3,c) 的左上邻居是 (2,c)。
  assert.ok(center.some(n=>n.row===3&&n.col===2));
  const odd=neighbors({row:3,col:3});
  assert.ok(odd.some(n=>n.row===2&&n.col===3));
  // 边角截断：左上角 (0,0) 只有两个邻居。
  const corner=neighbors({row:0,col:0});
  assert.equal(corner.length,2);
});

test('距离：度量性质成立，相邻为 1，跨奇偶行最短路正确且对称',()=>{
  for(const a of boardCells())for(const b of boardCells()){
    const d=hexDistance(a,b);
    assert.ok(Number.isInteger(d)&&d>=0);
    assert.equal(d,hexDistance(b,a),'距离必须对称');
    assert.ok(d<=10,'8×7 棋盘上的最大六边形距离是 10');
    if(a.row===b.row&&a.col===b.col)assert.equal(d,0);
    if(d===1)assert.ok(neighbors(a).some(n=>cellKey(n)===cellKey(b)),'距离 1 必为邻居');
  }
  assert.equal(hexDistance({row:4,col:3},{row:3,col:3}),1);
  assert.equal(hexDistance({row:4,col:3},{row:3,col:2}),1);
  assert.equal(hexDistance({row:4,col:3},{row:2,col:3}),2);
  assert.equal(hexDistance({row:4,col:3},{row:4,col:5}),2);
  // 三角不等式抽样。
  for(const a of boardCells())for(const b of boardCells()){
    const mid=boardCells()[(cellKey(a)*7+cellKey(b))%56];
    assert.ok(hexDistance(a,b)<=hexDistance(a,mid)+hexDistance(mid,b));
  }
});

test('cellKey / keyToCell 互逆且覆盖 56 格',()=>{
  for(const cell of boardCells())assert.deepEqual(keyToCell(cellKey(cell)),cell);
  assert.deepEqual([...new Set(boardCells().map(cellKey))].sort((a,b)=>a-b),Array.from({length:56},(_,i)=>i));
});

test('投影与命中逆映射：格心在容器内，pointToCell 与 cellCenter 互逆',()=>{
  for(const cell of boardCells()){
    const center=cellCenter(cell);
    assert.ok(center.x>0&&center.x<1&&center.y>0&&center.y<1,'格心必须落在棋盘容器内');
    assert.deepEqual(pointToCell(center),cell,'格心的逆映射必须回到原格');
  }
  assert.deepEqual(pointToCell({x:0,y:0}),{row:0,col:0});
  assert.deepEqual(pointToCell({x:1,y:1}),{row:7,col:6});
  assert.deepEqual(pointToCell({x:0.5,y:0.5}),pointToCell({x:0.5,y:0.5}));
});

test('阻挡绕行：满阻挡直线时六邻接 BFS 能取道侧向空格',()=>{
  // (4,3) 与 (2,3) 之间的 (3,2)/(3,3)/(3,4) 全被占时，仍可从 (3,1) 或 (4,x) 绕行。
  const blocked=new Set([cellKey({row:3,col:2}),cellKey({row:3,col:3}),cellKey({row:3,col:4})]);
  const start={row:4,col:3},goal={row:2,col:3};
  const seen=new Set([cellKey(start)]);const queue=[{cell:start,dist:0}];
  for(let index=0;index<queue.length;index++){
    const {cell,dist}=queue[index];
    if(cell.row===goal.row&&cell.col===goal.col){assert.ok(dist>=2);return;}
    for(const next of neighbors(cell)){
      const key=cellKey(next);if(seen.has(key)||blocked.has(key))continue;
      seen.add(key);queue.push({cell:next,dist:dist+1});
    }
  }
  assert.fail('应存在绕行路径');
});
