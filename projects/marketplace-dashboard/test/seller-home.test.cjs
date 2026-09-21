'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../dist/seller-home-model.js');
const now = new Date('2026-09-21T12:00:00Z');
function report() {
  return { current: { from: '2026-09-14', to: '2026-09-20' }, days: 7,
    coverage: { orders: true, previousOrders: true, finance: true, previousFinance: true },
    metrics: { orderedRevenue: { current: 120, previous: 100 }, orderedUnits: { current: 0, previous: 0 }, realized: { current: 80, previous: 100 }, net: { current: -5, previous: 0 }, ads: { current: 3 }, stocks: { current: null } },
    daily: [{ date: '2026-09-14', orderedRevenue: 120, realized: 80 }, { date: '2026-09-15', orderedRevenue: null, realized: null }],
    sources: [{ id: 'a', ordersAt: '2026-09-21T11:00:00Z', ordersHistoryAt: '2026-09-20T11:00:00Z', financeAt: '2026-09-20T10:00:00Z' }],
    stores: [{ id: 'a', name: 'Тестовый магазин', complete: true, realized: 80 }],
    products: [{ key: 'a:1', storeId: 'a', sku: 1, realized: 80, net: -5, quantity: 0, cost: null, logistics: 0 }]
  };
}
test('homepage preserves zero, negative accruals, missing days and meaningful comparisons', () => {
  const model = build({ state: 'ready', report: report(), store: 'a', range: '7' }, now);
  assert.equal(model.metrics.orderedUnits.value, 0);
  assert.equal(model.metrics.net.value, -5);
  assert.equal(model.metrics.stocks.value, null);
  assert.equal(model.metrics.orderedRevenue.comparison, '+20% к прошлому периоду');
  assert.equal(model.metrics.net.comparison, 'В прошлом периоде: 0');
  assert.equal(model.daily[1].orderedRevenue, null);
  assert.equal(model.alerts.find(a => a.id === 'stockout').count, 1);
  assert.equal(model.scope, 'Ozon · Тестовый магазин');
});
test('incomplete coverage cannot become totals or zero task counts', () => {
  const data = report(); data.coverage.finance = false; data.coverage.orders = false;
  const model = build({ state: 'ready', report: data }, now);
  assert.equal(model.metrics.net.value, null);
  assert.equal(model.metrics.orderedRevenue.value, null);
  assert.ok(model.daily.every(d => d.realized === null && d.orderedRevenue === null));
  assert.ok(model.alerts.every(a => a.count === null));
  assert.match(model.coverageNote, /не за весь период/);
});
test('unfinished Moscow day never compares with a completed previous period', () => {
  const data = report(); data.current.to = '2026-09-21';
  const model = build({ state: 'ready', report: data }, new Date('2026-09-20T22:00:00Z'));
  assert.equal(model.period.open, true);
  assert.doesNotMatch(model.metrics.orderedRevenue.comparison, /20%/);
  assert.equal(model.metrics.orderedRevenue.tone, '');
});
test('loading, errors and WB selection never show a previous Ozon report', () => {
  for (const input of [{ state: 'loading' }, { state: 'error' }, { state: 'ready', market: 'WB' }, { state: 'ready', store: 'wb-test' }]) {
    const model = build({ report: report(), ...input }, now);
    assert.equal(model.metrics.orderedRevenue.value, null);
    assert.equal(model.daily.length, 0);
    assert.equal(model.stores, 0);
  }
});
test('all-platform scope identifies Ozon and the oldest available history freshness', () => {
  const data = report(); data.sources.push({ ordersHistoryAt: '2026-09-19T09:00:00Z', financeAt: null });
  const model = build({ state: 'ready', report: data }, now);
  assert.match(model.scope, /Ozon.*WB отдельно/);
  assert.match(model.freshness, /19 сент/);
  assert.match(model.freshness, /Начисления: нет полного снимка/);
});
test('view keeps graph gaps and escapes imported names without exposing an old report in error states', () => {
  const view = require('../dist/seller-home-view.js');
  const data = report();
  data.stores[0].name = '<img src=x onerror=alert(1)>';
  data.daily.push({ date: '2026-09-16', orderedRevenue: 50, realized: -10 });
  const model = build({ state: 'ready', report: data, store: 'a' }, now);
  const html = view.render(model);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.equal((html.match(/class="sh-line sh-line-ordered"/g) || []).length, 2);
  assert.equal((html.match(/class="sh-line sh-line-realized"/g) || []).length, 2);
  assert.doesNotMatch(html, /(?:NaN|Infinity)/);
  for (const state of ['loading', 'error', 'unsupported']) {
    const other = view.render({ ...model, state });
    assert.doesNotMatch(other, /sh-finance-value|sh-chart|sh-task-list/);
  }
});
