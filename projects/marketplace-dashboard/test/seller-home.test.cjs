'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../dist/seller-home-model.js');
const now = new Date('2026-09-21T12:00:00Z');
function report() {
  return { current: { from: '2026-09-14', to: '2026-09-20' }, days: 7,
    coverage: { orders: true, previousOrders: true, finance: true, previousFinance: true },
    metrics: { orderedRevenue: { current: 120, previous: 100 }, orderedUnits: { current: 0, previous: 0 }, realized: { current: 80, previous: 100 }, net: { current: -5, previous: 0 }, ads: { current: 3 }, stocks: { current: null } },
    daily: Array.from({ length: 7 }, (_, index) => ({
      date: `2026-09-${14 + index}`, orderedRevenue: index === 0 ? 120 : 0,
      orderedUnits: 0, realized: index === 0 ? 80 : 0
    })),
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
  assert.equal(model.daily[1].orderedRevenue, 0);
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
test('declared coverage cannot turn a missing daily range or inconsistent total into zero', () => {
  const missing = report();
  missing.metrics.orderedRevenue.current = 0;
  missing.metrics.orderedUnits.current = 0;
  missing.daily = [missing.daily[0], missing.daily[2]];
  const partial = build({ state: 'ready', report: missing }, now);
  assert.equal(partial.metrics.orderedRevenue.value, null);
  assert.equal(partial.metrics.orderedRevenue.comparison, 'Нет полного периода');
  assert.equal(partial.coverageState, 'partial');
  assert.equal(partial.daily.length, 7);
  assert.equal(partial.daily[0].orderedRevenue, 120);
  assert.equal(partial.daily[1].orderedRevenue, null);
  assert.equal(partial.daily[2].orderedRevenue, 0);
  const inconsistent = report();
  inconsistent.metrics.orderedRevenue.current = 0;
  assert.equal(build({ state: 'ready', report: inconsistent }, now).metrics.orderedRevenue.value, null);
});
test('a fully evidenced zero period remains a real zero and may be compared', () => {
  const data = report();
  data.metrics.orderedRevenue.current = 0;
  data.metrics.orderedRevenue.previous = 0;
  data.metrics.realized.current = 0;
  data.daily.forEach(day => { day.orderedRevenue = 0; day.realized = 0; });
  const model = build({ state: 'ready', report: data }, now);
  assert.equal(model.metrics.orderedRevenue.value, 0);
  assert.equal(model.metrics.orderedRevenue.comparison, 'Без изменений к прошлому периоду');
  assert.equal(model.metrics.realized.value, 0);
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
test('attention count deduplicates overlapping signals and leaders use only positive SKU realization', () => {
  const data = report();
  data.products.push({ storeId: 'a', sku: 2, name: 'Второй товар', realized: 20, net: 15, quantity: 5, cost: 5, logistics: 2 });
  data.products.push({ storeId: 'a', sku: 3, name: 'Корректировка', realized: -10, net: 0, logistics: 0 });
  const model = build({ state: 'ready', report: data }, now);
  assert.equal(model.attentionCount, 1);
  assert.equal(model.alerts.filter(a => a.count > 0).length, 3);
  assert.deepEqual(model.leaders.map(p => p.sku), ['1', '2']);
  assert.deepEqual(model.leaders.map(p => p.share), [80, 20]);
  assert.equal(model.coverageState, 'complete');
  data.coverage.finance = false;
  const incomplete = build({ state: 'ready', report: data }, now);
  assert.equal(incomplete.attentionCount, null);
  assert.deepEqual(incomplete.leaders, []);
  assert.equal(incomplete.coverageState, 'partial');
});
test('unit chart keeps confirmed zero separate from missing and does not borrow amounts', () => {
  const data = report();
  data.daily[0].orderedUnits = 0;
  data.daily[1].orderedUnits = null;
  assert.deepEqual(build({ state: 'ready', report: data }, now).daily.map(d => d.orderedUnits), [0, null, 0, 0, 0, 0, 0]);
  data.coverage.orders = false;
  const partial = build({ state: 'ready', report: data }, now);
  assert.equal(partial.metrics.orderedUnits.value, null);
  assert.ok(partial.daily.every(d => d.orderedUnits === null));
});
test('view keeps graph gaps and escapes imported names without exposing an old report in error states', () => {
  const view = require('../dist/seller-home-view.js');
  const data = report();
  data.stores[0].name = '<img src=x onerror=alert(1)>';
  data.daily[1].orderedRevenue = null; data.daily[1].realized = null;
  data.daily.push({ date: '2026-09-16', orderedRevenue: 50, realized: -10 });
  const model = build({ state: 'ready', report: data, store: 'a' }, now);
  const html = view.render(model);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  const graphs = html.match(/<svg class="sh-chart [\s\S]*?<\/svg>/g);
  assert.equal(graphs.length, 2);
  for (const graph of graphs) {
    assert.equal((graph.match(/class="sh-line sh-line-ordered"/g) || []).length, 2);
    assert.equal((graph.match(/class="sh-line sh-line-realized"/g) || []).length, 2);
  }
  assert.doesNotMatch(html, /(?:NaN|Infinity)/);
  for (const state of ['loading', 'error', 'unsupported']) {
    const other = view.render({ ...model, state });
    assert.doesNotMatch(other, /sh-finance-value|sh-chart|sh-task-list/);
  }
});
test('chart mode selects the correct units and day without putting monetary values on the unit scale', () => {
  const view = require('../dist/seller-home-view.js');
  const data = report(); data.daily[0].orderedUnits = 0;
  const model = build({ state: 'ready', report: data }, now);
  const unitsHtml = view.render(model, { chartMode: 'units', dayIndex: 0 });
  const readout = unitsHtml.slice(unitsHtml.indexOf('data-home-readout'), unitsHtml.indexOf('<div data-home-chart-region>'));
  assert.match(readout, /14 сентября 2026/);
  assert.match(readout, /0 шт\./);
  assert.doesNotMatch(readout, /₽|Реализовано/);
  for (const graph of unitsHtml.match(/<svg class="sh-chart [\s\S]*?<\/svg>/g)) assert.doesNotMatch(graph, /sh-line-realized|Суммы.*рублях/);
  data.daily[1].orderedRevenue = null; data.daily[1].realized = null;
  const modelWithGap = build({ state: 'ready', report: data }, now);
  const absentDay = view.render(modelWithGap, { chartMode: 'amount', dayIndex: 1 });
  const absentReadout = absentDay.slice(absentDay.indexOf('data-home-readout'), absentDay.indexOf('<div data-home-chart-region>'));
  assert.match(absentReadout, /15 сентября 2026/);
  assert.match(absentReadout, /<strong>—<\/strong>/);
});

test('cumulative chart, readout and table use the selected date without changing period KPIs', () => {
  const view = require('../dist/seller-home-view.js');
  const data = report();
  data.daily = [
    { date: '2026-09-14', orderedRevenue: 120, orderedUnits: 2, realized: 80 },
    { date: '2026-09-15', orderedRevenue: 30, orderedUnits: 3, realized: -10 }
  ];
  const model = build({ state: 'ready', report: data }, now);
  const html = view.render(model, { chartAggregation: 'cumulative', dayIndex: 1 });
  const readout = html.slice(html.indexOf('data-home-readout'), html.indexOf('<div data-home-chart-region>'));
  assert.match(readout, /Итог к/);
  assert.match(readout, /15 сентября 2026/);
  assert.match(readout, /150 ₽/);
  assert.match(readout, /70 ₽/);
  assert.match(html, /data-home-aggregation="cumulative" aria-pressed="true"/);
  assert.match(html, /Накопительные итоги таблицей/);
  assert.match(html, /Заказано и реализовано накопительно/);
  const daily = view.render(model, { dayIndex: 1 });
  assert.match(daily.slice(daily.indexOf('data-home-readout'), daily.indexOf('<div data-home-chart-region>')), /30 ₽/);
  const totals = markup => markup.slice(markup.indexOf('<div class="sh-totals">'), markup.indexOf('<div class="sh-chart-tools">'));
  assert.equal(totals(html), totals(daily));
  const units = view.render(model, { chartAggregation: 'cumulative', chartMode: 'units', dayIndex: 1 });
  const unitReadout = units.slice(units.indexOf('data-home-readout'), units.indexOf('<div data-home-chart-region>'));
  assert.match(unitReadout, /5 шт\./);
  assert.doesNotMatch(unitReadout, /₽/);
});

test('cumulative view keeps an unknown selected tail visible and explains absent prefixes', () => {
  const view = require('../dist/seller-home-view.js');
  const data = report();
  data.daily.push({ date: '2026-09-16', orderedRevenue: 40, orderedUnits: 2, realized: 10 });
  const model = build({ state: 'ready', report: data }, now);
  const html = view.render(model, { chartAggregation: 'cumulative', dayIndex: 2 });
  const readout = html.slice(html.indexOf('data-home-readout'), html.indexOf('<div data-home-chart-region>'));
  assert.match(readout, /16 сентября 2026/);
  assert.equal((readout.match(/<strong>—<\/strong>/g) || []).length, 2);
  assert.match(html, /После пропуска данных итог не рассчитывается/);
  data.daily = data.daily.slice(2);
  const absent = view.render(build({ state: 'ready', report: data }, now), { chartAggregation: 'cumulative' });
  assert.match(absent, /нет полных данных с начала периода/);
  assert.match(absent, /data-home-day-slider/);
  assert.doesNotMatch(absent, /NaN|Infinity/);
});
