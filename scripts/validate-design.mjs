import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../design/content.v0.1.json', import.meta.url), 'utf8'));
const items = new Set(config.items.map(item => item.id));
const recipes = new Map(config.recipes.map(recipe => [recipe.id, recipe]));
const cards = new Map(config.cards.map(card => [card.id, card]));
const checks = [];

function test(name, run) {
  run();
  checks.push(name);
  console.log('[PASS] ' + name);
}

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, label + ' 必须唯一');
}

function validAmounts(amounts, allowZero = false) {
  assert.ok(amounts && typeof amounts === 'object' && !Array.isArray(amounts));
  for (const [itemId, quantity] of Object.entries(amounts)) {
    assert.ok(items.has(itemId), '未知物品 ' + itemId);
    assert.ok(Number.isSafeInteger(quantity), '数量必须是安全整数');
    assert.ok(quantity >= (allowZero ? 0 : 1), '数量不合法');
  }
}

function validateRegistry() {
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.status, 'DESIGN_ONLY');
  unique(config.items.map(item => item.id), '物品 ID');
  unique(config.recipes.map(recipe => recipe.id), '配方 ID');
  unique(config.cards.map(card => card.id), '卡牌 ID');
  unique(config.cards.flatMap(card => card.branches.map(branch => branch.id)), '分支 ID');
  assert.equal(config.items.length, 6);
  assert.equal(config.cards.length, 6);
  assert.equal(config.recipes.length, 6);
  assert.equal(config.rules.sameRoundOutputConsumption, false);
  assert.equal(config.rules.maxRecipeExecutionsPerCardPerRound, 1);
  for (const recipe of config.recipes) {
    validAmounts(recipe.inputs);
    validAmounts(recipe.outputs);
    assert.ok(Object.keys(recipe.outputs).length > 0, '配方必须产出物品');
  }
  for (const card of config.cards) {
    assert.ok(recipes.has(card.baseRecipeId), '卡牌必须引用已知配方');
    assert.equal(card.branches.length, 2);
    assert.ok(['C', 'R'].includes(card.rarity));
  }
  assert.equal(config.cards.filter(card => card.starter).length, 4);
  unique(config.pack.entries.map(entry => entry.cardId), '卡池条目');
  assert.equal(config.pack.entries.length, cards.size);
  for (const entry of config.pack.entries) {
    assert.ok(cards.has(entry.cardId), '未知卡池卡牌');
    assert.ok(Number.isSafeInteger(entry.weight) && entry.weight > 0);
  }
  assert.equal(config.pack.entries.reduce((sum, entry) => sum + entry.weight, 0), 10000);
  assert.equal(config.pack.entries.filter(entry => cards.get(entry.cardId).rarity === 'C')
    .reduce((sum, entry) => sum + entry.weight, 0), 8000);
  unique(config.goalTemplates.map(goal => goal.id), '目标 ID');
  for (const goal of config.goalTemplates) validAmounts(goal.target);
}

function validateRecipeGraph() {
  const graph = new Map([...items].map(id => [id, new Set()]));
  for (const recipe of config.recipes) {
    for (const input of Object.keys(recipe.inputs)) {
      for (const output of Object.keys(recipe.outputs)) graph.get(input).add(output);
    }
  }
  const marks = new Map();
  function visit(id) {
    assert.notEqual(marks.get(id), 'visiting', '基础配方图不能含循环');
    if (marks.get(id) === 'done') return;
    marks.set(id, 'visiting');
    for (const next of graph.get(id)) visit(next);
    marks.set(id, 'done');
  }
  for (const id of items) visit(id);
}

function validateBoard(board, priority) {
  assert.equal(board.length, config.rules.rows * config.rules.columns);
  const active = board.filter(id => id !== null);
  assert.ok(active.length > 0 && active.length <= config.rules.maxActiveCards);
  unique(active, '示例工位卡牌');
  for (const id of active) assert.ok(cards.has(id), '工位引用未知卡牌');
  unique(priority, '加工优先级');
  assert.deepEqual([...priority].sort(), [...active].sort(), '优先级必须恰好包含所有在岗卡牌');
}

function simulateRound(initialStock, board, priority) {
  validateBoard(board, priority);
  validAmounts(initialStock, true);
  const available = Object.fromEntries([...items].map(id => [id, initialStock[id] ?? 0]));
  const pending = Object.fromEntries([...items].map(id => [id, 0]));
  const executed = [];
  for (const cardId of priority) {
    const recipe = recipes.get(cards.get(cardId).baseRecipeId);
    const canExecute = Object.entries(recipe.inputs).every(([id, quantity]) => available[id] >= quantity);
    if (!canExecute) continue;
    for (const [id, quantity] of Object.entries(recipe.inputs)) available[id] -= quantity;
    for (const [id, quantity] of Object.entries(recipe.outputs)) pending[id] += quantity;
    executed.push(cardId);
  }
  const stock = Object.fromEntries([...items].map(id => [id, available[id] + pending[id]]));
  validAmounts(stock, true);
  return { stock, executed };
}

function simulate(priorities, initialStock = config.scenario.initialStock, board = config.scenario.board) {
  assert.equal(priorities.length, config.rules.rounds);
  const trace = [];
  let stock = { ...initialStock };
  for (let i = 0; i < priorities.length; i++) {
    // 本验证器只测试“整条优先级重排”这一种调整。每轮至多一次。
    const adjustments = i === 0 || JSON.stringify(priorities[i]) === JSON.stringify(priorities[i - 1]) ? 0 : 1;
    if (i > 0) assert.ok(adjustments <= config.rules.adjustmentsPerRoundAfterFirst);
    const result = simulateRound(stock, board, priorities[i]);
    stock = result.stock;
    trace.push({ round: i + 1, stock: { ...stock }, executed: result.executed });
  }
  return { stock, trace };
}

function meets(stock, target) {
  return Object.entries(target).every(([itemId, quantity]) => (stock[itemId] ?? 0) >= quantity);
}

const resinFirst = ['moss_sprite', 'dew_sprite', 'ember_moth', 'ink_snail'];
const inkFirst = ['moss_sprite', 'dew_sprite', 'ink_snail', 'ember_moth'];
const fixed = priority => Array.from({ length: config.rules.rounds }, () => [...priority]);
const plans = {
  alternating_priority: config.scenario.witnessPriorities,
  resin_first: fixed(resinFirst),
  ink_first: fixed(inkFirst)
};

test('内容引用、数量与卡池权重合法', validateRegistry);
test('基础配方依赖图无循环', validateRecipeGraph);

test('当轮产物不能被当轮加工消耗', () => {
  const first = simulateRound({}, config.scenario.board, resinFirst);
  assert.equal(first.stock.fiber, 2);
  assert.equal(first.stock.dew, 2);
  assert.equal(first.stock.resin, 0);
  assert.equal(first.stock.ink, 0);
});

test('原料不足不发生部分扣料', () => {
  const result = simulateRound({ fiber: 1 }, ['ink_snail', null, null, null, null, null], ['ink_snail']);
  assert.equal(result.stock.fiber, 1);
  assert.equal(result.stock.ink, 0);
  assert.deepEqual(result.executed, []);
});

test('模拟不修改输入状态', () => {
  const input = { fiber: 4, dew: 3 };
  const before = JSON.stringify(input);
  simulateRound(input, config.scenario.board, resinFirst);
  assert.equal(JSON.stringify(input), before);
});

test('拒绝重复卡牌与重复加工优先级', () => {
  assert.throws(() => simulateRound({}, ['moss_sprite', 'moss_sprite', null, null, null, null], ['moss_sprite']));
  assert.throws(() => simulateRound({}, config.scenario.board, ['moss_sprite', 'dew_sprite', 'ember_moth', 'ember_moth']));
});

test('拒绝负数、非整数与未知库存', () => {
  for (const input of [{ fiber: -1 }, { fiber: 0.5 }, { missing: 1 }]) {
    assert.throws(() => simulateRound(input, config.scenario.board, resinFirst));
  }
});

test('拒绝超出同时工作卡位的配置', () => {
  const board = config.cards.map(card => card.id);
  assert.throws(() => simulateRound({}, board, [...board]));
});

test('平衡目标有可达路径，固定两种优先级均失败', () => {
  assert.ok(meets(simulate(plans.alternating_priority).stock, config.scenario.target));
  assert.ok(!meets(simulate(plans.resin_first).stock, config.scenario.target));
  assert.ok(!meets(simulate(plans.ink_first).stock, config.scenario.target));
});

for (const goal of config.goalTemplates) {
  test('目标模板可达：' + goal.id, () => {
    assert.ok(plans[goal.witness], '目标缺少验证方案');
    assert.ok(meets(simulate(plans[goal.witness]).stock, goal.target));
  });
}

const balanced = simulate(plans.alternating_priority);
console.log('\n平衡目标的逐轮库存：');
for (const row of balanced.trace) {
  console.log('第 ' + row.round + ' 轮：' + JSON.stringify(row.stock));
}
console.log('\n通过 ' + checks.length + ' 项设计校验。');
console.log('边界：未实现网页、专精效果、真实资产、订单预算或交易；未验证长期经济平衡。');

