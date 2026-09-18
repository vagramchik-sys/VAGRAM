'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildForecasts } = require('../supplier-forecast.cjs');
const { buildLedger } = require('../ledger.cjs');
const now = '2026-09-18T12:00:00Z';
const money = amount => ({ amount: String(amount), currency: 'RUB' });
function sale(sku, units, date = '2026-09-17') {
  return { date, total_amount: money(units * 10), posting: { products: [{ sku,
    commission: { sale_amount: money(units * 10), seller_price: money(10) } }] } };
}
function store(operations = [sale(10, 28)], products = [{ key: 'a:1', sku: 10, skus: [10, '10'], quantity: 5 }]) {
  return { id: 'a', market: 'Ozon', products, ledger: buildLedger({
    period: { from: '2026-08-21', to: '2026-09-18' }, completedAt: '2026-09-18T11:00:00Z',
    sections: { finance: { ok: true } }, operations
  }) };
}
const forecast = (s, options = {}) => buildForecasts([s], { now, ...options }).get(s.products[0].key);
function unavailable(s, code) {
  const value = forecast(s);
  assert.equal(value.status, 'unavailable'); assert.equal(value.reasonCode, code);
  for (const key of ['averageDailyUnits', 'projectedUnits', 'requiredUnits', 'daysOfStock']) assert.equal(value[key], null, key);
  assert.ok(value.reason); return value;
}

test('45-day baseline uses 28 completed Moscow days and excludes current-day and old activity', () => {
  const s = store([sale(10, 28), sale(10, 1000, '2026-09-18'), sale(10, 1000, '2026-08-20')]);
  const f = forecast(s);
  assert.equal(f.status, 'available'); assert.equal(f.averageDailyUnits, 1);
  assert.equal(f.projectedUnits, 45); assert.equal(f.requiredUnits, 40); assert.equal(f.daysOfStock, 5);
  assert.equal(f.label, 'Ориентировочный прогноз потребности на 45 дней');
  assert.equal(f.historyStart, '2026-08-21'); assert.equal(f.historyEnd, '2026-09-17');
  assert.match(f.caveat, /не по заказам/); assert.match(f.caveat, /сезонность/);
});

test('primary SKU and duplicate mixed-type aliases are combined exactly once and isolated by store', () => {
  const a = store([sale(10, 28), sale('11', 28), sale(11, -14)], [{ key: 'a:1', sku: 10, skus: [11, '11', 10], quantity: 8 }]);
  const b = store([sale(10, 56)], [{ key: 'b:1', sku: '10', quantity: 1 }]); b.id = 'b';
  const all = buildForecasts([a, b], { now });
  assert.equal(all.get('a:1').averageDailyUnits, 1.5); assert.equal(all.get('a:1').projectedUnits, 68);
  assert.equal(all.get('a:1').requiredUnits, 60); assert.equal(all.get('b:1').requiredUnits, 89);
});

test('unknown or invalid stock never becomes zero; known zero stock remains a valid observation', () => {
  for (const quantity of [null, undefined, NaN, Infinity, -1, '5', 1.5]) {
    const s = store(); s.products[0].quantity = quantity;
    assert.equal(unavailable(s, 'unknown_stock').stockUnits, null);
  }
  const s = store(); s.products[0].quantity = 0;
  assert.equal(forecast(s).requiredUnits, 45); assert.equal(forecast(s).daysOfStock, 0);
});

test('partial, short, foreign and legacy ledgers fail closed', () => {
  const mutations = [s => s.ledger.complete = false, s => s.ledger.period.from = '2026-08-22',
    s => s.ledger.period.to = '2026-09-16', s => s.ledger.version = 2, s => s.ledger.foreignRecords = 1,
    s => s.ledger.period.from = '2026-02-30', s => delete s.ledger.daily];
  for (const mutate of mutations) { const s = store(); mutate(s); unavailable(s, 'incomplete_history'); }
});

test('refresh timestamp must cover the completed window and not claim a future refresh', () => {
  for (const completedAt of [undefined, 'invalid', '2026-09-17T20:59:59Z', '2026-09-19T00:00:00Z']) {
    const s = store(); s.ledger.completedAt = completedAt; unavailable(s, 'stale_history');
  }
  const s = store(); s.ledger.completedAt = '2026-09-17T21:00:00Z';
  assert.equal(forecast(s).status, 'available');
  const f = forecast(s, { now: '2026-09-17T21:00:00Z' });
  assert.equal(f.historyEnd, '2026-09-17');
});

test('returns and corrections reduce net baseline to a floor of zero, never to negative demand', () => {
  for (const returned of [28, 30]) {
    const f = forecast(store([sale(10, 28), sale(10, -returned)]));
    assert.equal(f.status, 'available'); assert.equal(f.averageDailyUnits, 0);
    assert.equal(f.requiredUnits, 0); assert.equal(f.projectedUnits, 0); assert.equal(f.daysOfStock, null);
  }
  const s = store(); s.ledger.skuDaily[0].values.soldUnits = -1;
  unavailable(s, 'invalid_history');
});

test('empty and service-only product histories are insufficient, not asserted zero sales', () => {
  unavailable(store([]), 'insufficient_history');
  const s = store(); s.products.push({ key: 'a:new', sku: 99, quantity: 2 });
  const f = buildForecasts([s], { now }).get('a:new');
  assert.equal(f.status, 'unavailable'); assert.equal(f.reasonCode, 'insufficient_history');
  const service = store([{ date: '2026-09-17', total_amount: money(-1), item_fees: { fees: [{ sku: 10, fees: [{ type_id: 1, accrued: money(-1) }] }] } }]);
  unavailable(service, 'insufficient_history');
});

test('unknown units, unmapped unit rows, duplicate rows and ambiguous catalog cannot produce demand', () => {
  const op = sale(10, 1); delete op.posting.products[0].commission.seller_price;
  unavailable(store([op]), 'unknown_units');
  unavailable(store([sale(undefined, 1), sale(10, 28)]), 'unmapped_units');
  const ambiguous = store(); ambiguous.products.push({ key: 'a:2', sku: 11, skus: [10], quantity: 5 });
  unavailable(ambiguous, 'ambiguous_sku');
  const duplicate = store(); duplicate.ledger.skuDaily.push(structuredClone(duplicate.ledger.skuDaily[0]));
  unavailable(duplicate, 'invalid_history');
  const old = store(); delete old.ledger.skuDaily[0].values.soldUnits;
  unavailable(old, 'invalid_history');
});

test('unknown quantities on another known SKU do not contaminate exact product history', () => {
  const unknown = sale(99, 1); delete unknown.posting.products[0].commission.seller_price;
  const s = store([sale(10, 28), unknown]); assert.equal(forecast(s).requiredUnits, 40);
});

test('WB remains unavailable and output has a strict finance-free shape without mutating inputs', () => {
  const s = store(); s.market = 'WB'; s.ledger = null; unavailable(s, 'unsupported_market');
  const input = store(); input.products[0].price = 123; input.products[0].cost = { unitCost: 45 };
  const before = structuredClone(input), f = forecast(input);
  assert.deepEqual(input, before);
  assert.deepEqual(Object.keys(f).sort(), ['label', 'horizonDays', 'historyDays', 'historyStart', 'historyEnd',
    'status', 'reason', 'reasonCode', 'stockUnits', 'averageDailyUnits', 'projectedUnits', 'requiredUnits', 'daysOfStock', 'caveat'].sort());
});

test('invalid public options and duplicate product keys fail explicitly', () => {
  assert.throws(() => buildForecasts(null), TypeError);
  for (const value of [0, -1, 1.2, '45', 367, Infinity]) {
    assert.throws(() => forecast(store(), { horizonDays: value }), RangeError);
    assert.throws(() => forecast(store(), { historyDays: value }), RangeError);
  }
  for (const value of [null, {}, 'invalid']) assert.throws(() => forecast(store(), { now: value }), TypeError);
  assert.throws(() => buildForecasts([{ products: null }], { now }), TypeError);
  const s = store(); s.products.push({ ...s.products[0] });
  assert.throws(() => forecast(s), /Duplicate product key/);
  assert.equal(buildForecasts([], { now }).size, 0);
});
