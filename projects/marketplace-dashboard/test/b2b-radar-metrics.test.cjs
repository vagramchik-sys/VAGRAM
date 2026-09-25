'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeB2BRadar, LOW_DATA } = require('../b2b-radar-metrics.cjs');

const periods = { currentPeriod: { from: '2026-09-01', to: '2026-09-07' }, previousPeriod: { from: '2026-08-25', to: '2026-08-31' } };
const complete = { classification: 'complete', amounts: 'complete', daily: 'complete', current: { complete: true }, previous: { complete: true }, compatibleWithPrevious: true };
const snapshot = (legalUnits, totalUnits, extra = {}) => ({ legalUnits, individualUnits: totalUnits - legalUnits, unknownUnits: 0, totalUnits, orderCount: legalUnits ? 1 : 0, amountRub: totalUnits * 100, legalAmountRub: legalUnits * 100, individualAmountRub: (totalUnits - legalUnits) * 100, cancelledUnits: 0, ...extra });
const row = (id, current, previous, extra = {}) => ({ market: 'Ozon', storeId: 's1', productId: id, sku: id, name: 'Товар ' + id, category: 'Крепёж', metrics: { current, previous }, ...extra });
const analyze = (rows, overrides = {}, config) => analyzeB2BRadar({ rows, ...periods, coverage: complete, ...overrides }, config);

test('calculates B2B share, growth and average order without changing input', () => {
  const rows = [row('a', snapshot(6, 10, { orderCount: 2 }), snapshot(3, 10))];
  const before = structuredClone(rows), result = analyze(rows);
  assert.equal(result.products[0].current.b2bShare.value, 0.6);
  assert.equal(result.products[0].growth.value, 1);
  assert.equal(result.products[0].current.avgOrderUnits.value, 3);
  assert.equal(result.kpis.previousB2bShare.value, 0.3);
  assert.deepEqual(rows, before);
});

test('score is deterministic, bounded and resistant to a single volume outlier', () => {
  const scored = (legal, total) => snapshot(legal, total, { legalOrderCount: 5, daily: [
    { date: '2026-09-01', ...snapshot(legal / 3, total / 3) },
    { date: '2026-09-02', ...snapshot(legal / 3, total / 3) },
    { date: '2026-09-03', ...snapshot(legal / 3, total / 3) }
  ] });
  const rows = [row('a', scored(40, 100), snapshot(20, 100)), row('b', scored(80, 100), snapshot(70, 100)), row('c', scored(50, 100), snapshot(50, 100)), row('huge', scored(1000000, 1000000), snapshot(20, 40))];
  const first = analyze(rows), second = analyze(rows);
  assert.deepEqual(first, second);
  assert.ok(first.products.every(value => typeof value.score === 'number' && value.score >= 0 && value.score <= 100));
  assert.deepEqual(Object.keys(first.products[0].components), ['share', 'amountShare', 'avgOrder', 'growth', 'stability', 'amount']);
  for (const product of first.products) {
    const c = product.components;
    assert.equal(product.score, Number((c.share * .25 + c.amountShare * .20 + c.avgOrder * .15 + c.growth * .20 + c.stability * .10 + c.amount * .10).toFixed(2)));
  }
  assert.deepEqual(Object.keys(first.zones.thresholds), ['share', 'growth']);
  assert.ok(first.quality.outliersCapped > 0);
});

test('high-score KPI counts all analyzed products and marks truncation or partial coverage', () => {
  const scored = (legal, total) => snapshot(legal, total, { legalOrderCount: 5, daily: [
    { date: '2026-09-01', ...snapshot(legal / 3, total / 3) },
    { date: '2026-09-02', ...snapshot(legal / 3, total / 3) },
    { date: '2026-09-03', ...snapshot(legal / 3, total / 3) }
  ] });
  const rows = [row('a', scored(40, 100), snapshot(20, 100)), row('b', scored(80, 100), snapshot(70, 100)), row('c', scored(50, 100), snapshot(50, 100)), row('d', scored(95, 100), snapshot(40, 100))];
  const completeResult = analyze(rows);
  const expected = completeResult.products.filter(value => value.scoreStatus === 'ok' && value.score > 80).length;
  assert.ok(expected > 0);
  assert.deepEqual(completeResult.kpis.highScoreCount, { value: expected, status: 'available' });
  assert.deepEqual(completeResult.kpis.scoreOver80, completeResult.kpis.highScoreCount);
  assert.deepEqual(completeResult.meta, { total: 4, analyzed: 4, truncated: false });

  const truncated = analyze(rows, { productCount: 9 });
  assert.equal(truncated.meta.total, 9);
  assert.equal(truncated.meta.analyzed, 4);
  assert.equal(truncated.meta.truncated, true);
  assert.equal(truncated.kpis.highScoreCount.value, expected);
  assert.equal(truncated.kpis.highScoreCount.status, 'partial');
  assert.match(truncated.kpis.highScoreCount.reason, /загруженной части/);

  const partial = analyze(rows, { coverage: { ...complete, amounts: 'partial' } });
  assert.equal(partial.kpis.highScoreCount.status, 'partial');
});

test('potential is a conservative category benchmark estimate only with complete compatible confirmed data', () => {
  const current = (legal, total) => snapshot(legal, total, { daily: [{ date: '2026-09-01', ...snapshot(legal, total) }] });
  const rows = [row('a', current(1, 10), snapshot(1, 10)), row('b', current(5, 10), snapshot(4, 10)), row('c', current(8, 10), snapshot(7, 10))];
  const scoring = { minProductUnits: 1, minProductOrders: 1, minObservedDays: 1 };
  const ready = analyze(rows, {}, scoring), candidate = ready.products.find(value => value.productId === 'a');
  assert.equal(candidate.potentialRub.status, 'available');
  assert.equal(candidate.potentialRub.kind, 'estimated_benchmark');
  assert.equal(candidate.potentialRub.benchmarkShare, 0.65);
  assert.equal(candidate.potentialRub.value, 550);
  const partial = analyze(rows, { coverage: { ...complete, amounts: 'partial' } }, scoring);
  assert.equal(partial.products[0].potentialRub.value, null);
  assert.equal(partial.products[0].potentialRub.status, 'unavailable');
});

test('partial classification labels legal metrics and withholds exact growth and potential', () => {
  const result = analyze([row('a', snapshot(4, 10), snapshot(2, 10))], { coverage: { ...complete, classification: 'partial' } });
  assert.equal(result.products[0].current.b2bShare.status, 'partial');
  assert.equal(result.products[0].growth.status, 'unavailable');
  assert.equal(result.kpis.potentialRub.value, null);
});

test('explicitly partial period cannot expose exact buyer or money metrics', () => {
  const result = analyze([row('a', snapshot(4, 10), snapshot(2, 10))], { coverage: { ...complete, current: { complete: false } } });
  assert.equal(result.products[0].current.b2bUnits.status, 'partial');
  assert.equal(result.products[0].current.amountRub.status, 'partial');
  assert.equal(result.products[0].score, null);
  assert.equal(result.products[0].scoreStatus, LOW_DATA);
});

test('period mismatch prevents comparison and is reported in quality', () => {
  const result = analyze([row('a', snapshot(4, 10), snapshot(2, 10))], { previousPeriod: { from: '2026-08-24', to: '2026-08-31' } });
  assert.equal(result.products[0].growth.value, null);
  assert.ok(result.quality.flags.includes('PERIOD_LENGTH_MISMATCH'));
});

test('invalid periods fail closed', () => {
  assert.throws(() => analyzeB2BRadar({ rows: [], currentPeriod: { from: 'bad', to: '2026-09-07' }, previousPeriod: periods.previousPeriod, coverage: complete }), /период/);
});

test('zero demand, no B2B and only B2B produce finite explicit shares', () => {
  const result = analyze([
    row('zero', snapshot(0, 0, { amountRub: 0 }), snapshot(0, 0, { amountRub: 0 })),
    row('consumer', snapshot(0, 10), snapshot(0, 10)),
    row('business', snapshot(10, 10), snapshot(5, 5))
  ]);
  assert.equal(result.products.find(value => value.productId === 'zero').current.b2bShare.value, 0);
  assert.equal(result.products.find(value => value.productId === 'consumer').current.b2bShare.value, 0);
  assert.equal(result.products.find(value => value.productId === 'business').current.b2bShare.value, 1);
  assert.equal(result.products.find(value => value.productId === 'zero').growth.value, 0);
});

test('new demand is labelled without infinite growth or a fabricated percentage', () => {
  const result = analyze([row('a', snapshot(4, 10), snapshot(0, 10))]);
  assert.equal(result.products[0].growth.value, null);
  assert.equal(result.products[0].growth.kind, 'new_demand');
  assert.match(result.products[0].growth.reason, /Новый спрос/);
});

test('unknown buyer units stay visible and prevent an exact B2B share claim', () => {
  const result = analyze([row('a', snapshot(4, 10, { individualUnits: 3, unknownUnits: 3 }), snapshot(2, 10))]);
  assert.equal(result.products[0].current.b2bShareDenominator.value, 10);
  assert.equal(result.products[0].current.unknownUnits.value, 3);
  assert.equal(result.products[0].current.b2bShare.status, 'partial');
});

test('LOW_DATA is explicit for too few peers and never creates an opportunity', () => {
  const result = analyze([row('a', snapshot(5, 10), snapshot(4, 10))]);
  assert.equal(result.products[0].scoreStatus, LOW_DATA);
  assert.equal(result.products[0].zone, LOW_DATA);
  assert.deepEqual(result.opportunities, []);
});

test('cancelled gross units are removed and unresolved buyer split is never exact', () => {
  const result = analyze([row('a', snapshot(8, 10, { cancelledUnits: 4 }), snapshot(4, 10))]);
  const product = result.products[0];
  assert.equal(product.current.totalUnits.value, 6);
  assert.equal(product.current.b2bShare.status, 'partial');
  assert.ok(product.flags.includes('HAS_CANCELLATIONS'));
  assert.ok(product.flags.includes('CANCELLATION_SPLIT_UNKNOWN'));
});

test('explicit non-cancelled buyer fields preserve exact cancelled-period metrics', () => {
  const current = snapshot(8, 10, { cancelledUnits: 4, notCancelledUnits: 6, legalNotCancelledUnits: 4, notCancelledAmountRub: 600 });
  const result = analyze([row('a', current, snapshot(4, 10))]);
  assert.equal(result.products[0].current.b2bUnits.value, 4);
  assert.equal(result.products[0].current.b2bShare.value, 0.6667);
  assert.equal(result.products[0].current.b2bShare.status, 'available');
});

test('gross amount is withheld when active units exclude cancellations', () => {
  const result = analyze([row('a', snapshot(8, 10, { cancelledUnits: 4, notCancelledUnits: 6, legalNotCancelledUnits: 4 }), snapshot(4, 10))]);
  assert.equal(result.products[0].current.amountRub.value, null);
  assert.equal(result.products[0].current.amountRub.status, 'unavailable');
});

test('global KPI uses a distinct legal order summary instead of summing per-SKU orders', () => {
  const rows = [row('a', snapshot(3, 6, { legalOrderCount: 2 }), snapshot(2, 6)), row('b', snapshot(4, 8, { legalOrderCount: 2 }), snapshot(3, 8))];
  const result = analyze(rows, { summary: { current: snapshot(7, 14, { legalOrderCount: 2 }), previous: snapshot(5, 14, { legalOrderCount: 2 }) } });
  assert.equal(result.kpis.orderCount.value, 2);
  assert.equal(result.kpis.avgOrderUnits.value, 3.5);
  assert.equal(result.categories[0].avgOrderUnits, undefined);
  assert.equal(result.categories[0].current.avgOrderUnits.status, 'unavailable');
});

test('global trend and KPIs use all-SKU summary instead of top-product rows', () => {
  const rows = [row('top', snapshot(2, 4, { daily: [{ date: '2026-09-01', ...snapshot(2, 4) }] }), snapshot(1, 4))];
  const current = snapshot(10, 20, { legalOrderCount: 5, daily: [{ date: '2026-09-01', ...snapshot(10, 20) }] });
  const previous = snapshot(5, 20, { legalOrderCount: 4 });
  const result = analyze(rows, { summary: { current, previous } });
  assert.equal(result.kpis.b2bUnits.value, 10);
  assert.equal(result.trend[0].b2bUnits, 10);
});

test('real SQL summary shape aggregates daily totals with distinct orders and nullable amounts', () => {
  const day = (date, values) => ({ date, cancellationUnknownUnits: 0, unknownUnits: 0, ...values });
  const summary = {
    current: {
      orderCount: 5, legalOrderCount: 4,
      daily: [
        day('2026-09-01', { grossUnits: 10, totalUnits: 10, notCancelledUnits: 8, legalUnits: 6, legalNotCancelledUnits: 5, individualUnits: 4, individualNotCancelledUnits: 3, order_count: 4, legal_order_count: 2, cancelledUnits: 2, amountRub: 1000, notCancelledAmountRub: 800, legalNotCancelledAmountRub: 500, individualNotCancelledAmountRub: 300 }),
        day('2026-09-02', { grossUnits: 5, totalUnits: 5, notCancelledUnits: 5, legalUnits: 3, legalNotCancelledUnits: 3, individualUnits: 2, individualNotCancelledUnits: 2, order_count: 3, legal_order_count: 2, cancelledUnits: 0, amountRub: 500, notCancelledAmountRub: 500, legalNotCancelledAmountRub: 300, individualNotCancelledAmountRub: 200 })
      ]
    },
    previous: {
      orderCount: 6, legalOrderCount: 3,
      daily: [
        day('2026-08-25', { grossUnits: 10, totalUnits: 10, notCancelledUnits: 10, legalUnits: 5, legalNotCancelledUnits: 5, individualUnits: 5, individualNotCancelledUnits: 5, orderCount: 4, legalOrderCount: 2, cancelledUnits: 0, amountRub: 1000, notCancelledAmountRub: 1000, legalNotCancelledAmountRub: 500, individualNotCancelledAmountRub: 500 }),
        day('2026-08-26', { grossUnits: 4, totalUnits: 4, notCancelledUnits: 4, legalUnits: 2, legalNotCancelledUnits: 2, individualUnits: 2, individualNotCancelledUnits: 2, orderCount: 2, legalOrderCount: 1, cancelledUnits: 0, amountRub: 400, notCancelledAmountRub: 400, legalNotCancelledAmountRub: 200, individualNotCancelledAmountRub: 200 })
      ]
    }
  };
  const result = analyze([row('top-only', snapshot(1, 2), snapshot(1, 2))], { summary });
  assert.equal(result.kpis.totalUnits.value, 13);
  assert.equal(result.kpis.b2bUnits.value, 8);
  assert.equal(result.kpis.b2bShare.value, 0.6154);
  assert.equal(result.kpis.b2bShareDenominator.value, 13);
  assert.equal(result.kpis.orderCount.value, 4);
  assert.equal(result.kpis.avgOrderUnits.value, 2);
  assert.equal(result.kpis.amountRub.value, 1300);
  assert.equal(result.kpis.b2bAmountRub.value, 800);
  assert.equal(result.kpis.b2bAmountShare.value, 0.6154);
  assert.equal(result.kpis.cancelledUnits.value, 2);
  assert.equal(result.kpis.previousB2bShare.value, 0.5);
  assert.equal(result.kpis.b2bGrowth.value, 0.1429);
  assert.deepEqual(result.trend.map(value => [value.date, value.totalUnits, value.b2bUnits, value.b2bAmountRub]), [
    ['2026-09-01', 8, 5, 500], ['2026-09-02', 5, 3, 300]
  ]);
  assert.deepEqual(result.trend.map(value => [value.orderCount, value.b2bOrders]), [[4, 2], [3, 2]]);

  summary.current.daily[1].notCancelledAmountRub = null;
  const missing = analyze([row('top-only', snapshot(1, 2), snapshot(1, 2))], { summary });
  assert.equal(missing.kpis.amountRub.value, null);
  assert.equal(missing.kpis.amountRub.status, 'unavailable');
});

test('daily and category trends aggregate deterministically', () => {
  const daily = [
    { date: '2026-09-02', totalUnits: 4, legalUnits: 2, individualUnits: 2, amountRub: 400, legalAmountRub: 200, individualAmountRub: 200 },
    { date: '2026-09-01', totalUnits: 2, legalUnits: 1, individualUnits: 1, amountRub: 200, legalAmountRub: 100, individualAmountRub: 100 }
  ];
  const result = analyze([row('a', snapshot(3, 6, { daily }), snapshot(2, 6)), row('b', snapshot(2, 4, { daily: [{ date: '2026-09-01', ...snapshot(2, 2) }] }), snapshot(1, 4)), row('c', snapshot(1, 2), snapshot(1, 2))]);
  assert.deepEqual(result.trend.map(value => value.date), ['2026-09-01', '2026-09-02']);
  assert.equal(result.trend[0].b2bUnits, 3);
  assert.equal(result.trend[0].b2bAmountRub, 300);
  assert.equal(result.trend[0].b2bAmountStatus, 'available');
  assert.equal(result.categories[0].current.b2bUnits.value, 6);
});

test('accepts separate flat current and previous row arrays', () => {
  const currentRows = [{ market: 'WB', storeId: 'w1', productId: '1', sku: '1', name: 'A', category: 'X', ...snapshot(3, 6) }];
  const previousRows = [{ market: 'WB', storeId: 'w1', productId: '1', ...snapshot(2, 5) }];
  const result = analyzeB2BRadar({ currentRows, previousRows, ...periods, coverage: complete });
  assert.equal(result.products[0].current.b2bShare.value, 0.5);
  assert.equal(result.products[0].growth.value, 0.5);
});
