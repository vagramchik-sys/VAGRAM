'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../model.js'), 'utf8'), sandbox);
const { summarize, validateState } = sandbox.window.OzonModel;
const state = {
  products: [{ id: 'p1', sku: 'SKU-1', name: 'Товар', cost: 30, stock: 10, price: 100 }],
  sales: [
    { id: 's1', date: '2026-09-01', productId: 'p1', quantity: 2, price: 100, commission: 20, logistics: 10 },
    { id: 's2', date: '2026-09-02', productId: 'p1', quantity: 1, price: 120, commission: 12, logistics: 8 }
  ],
  expenses: [
    { id: 'e1', date: '2026-09-01', category: 'Реклама', amount: 15, note: '' },
    { id: 'e2', date: '2026-09-03', category: 'Сервис', amount: 5, note: '' }
  ]
};
const json = value => JSON.parse(JSON.stringify(value));
assert.equal(validateState(state).ok, true);
const before = JSON.stringify(state);
const total = summarize(state);
assert.deepEqual(json(total), {
  revenue: 320, cogs: 90, commission: 32, logistics: 18, expenses: 20, profit: 160, units: 3, margin: 50,
  byProduct: [{ id: 'p1', name: 'Товар', sku: 'SKU-1', units: 3, revenue: 320, profit: 180 }],
  byDay: [{ date: '2026-09-01', revenue: 200, profit: 95 }, { date: '2026-09-02', revenue: 120, profit: 70 }, { date: '2026-09-03', revenue: 0, profit: -5 }]
});
assert.equal(JSON.stringify(state), before, 'Calculations must not mutate state');
assert.equal(summarize(state, '2026-09-01', '2026-09-01').profit, 95);
assert.equal(summarize(state, undefined, '2026-09-01').revenue, 200);
assert.equal(summarize(state, '2026-09-03').profit, -5);
assert.equal(summarize(state, '2026-09-03').margin, 0);
assert.equal(summarize(state, '2027-01-01').byDay.length, 0);
assert.equal(summarize({ products: [], sales: [], expenses: [] }).profit, 0);
const changedCost = json(state);
changedCost.products[0].cost = 40;
assert.equal(summarize(changedCost).cogs, 120);
const cases = [
  s => { s.products.push({ ...s.products[0], id: 'p2', sku: ' sku-1 ' }); },
  s => { s.products[0].cost = -1; },
  s => { s.products[0].cost = Infinity; },
  s => { s.products[0].price = NaN; },
  s => { s.products[0].stock = 0.5; },
  s => { s.products[0].id = ''; },
  s => { s.sales[0].quantity = 0; },
  s => { s.sales[0].quantity = 1.5; },
  s => { s.sales[0].quantity = '2'; },
  s => { s.sales[0].price = '100'; },
  s => { s.sales[0].commission = -1; },
  s => { s.sales[0].productId = 'missing'; },
  s => { s.sales[1].id = s.sales[0].id; },
  s => { s.sales[0].date = '2026-02-29'; },
  s => { s.sales[0].date = '2026-04-31'; },
  s => { s.sales[0].date = '2026-1-01'; },
  s => { s.expenses[0].amount = null; },
  s => { s.expenses[0].note = 0; },
  s => { s.expenses = {}; },
  s => { s.products[0] = null; }
];
for (const mutate of cases) {
  const invalid = json(state);
  mutate(invalid);
  assert.equal(validateState(invalid).ok, false, mutate.toString());
  assert.throws(() => summarize(invalid));
}
for (const invalid of [null, [], undefined, {}, 42]) assert.equal(validateState(invalid).ok, false);
const leapYear = json(state);
leapYear.sales[0].date = '2024-02-29';
assert.equal(validateState(leapYear).ok, true);
assert.throws(() => summarize(state, '2026-02-30'));
assert.throws(() => summarize(state, '2026-09-02', '2026-09-01'));
const overflow = json(state);
overflow.sales[0].price = Number.MAX_VALUE;
assert.throws(() => summarize(overflow), /Слишком большие/);
console.log('Model tests passed: totals, per-unit prices, per-sale fees, filters, current cost, daily expenses, immutability, invalid inputs, leap dates and overflow.');
