'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPartnerSales } = require('../partner-data.cjs');
const { buildLedger } = require('../ledger.cjs');
const now = '2026-09-18T12:00:00Z';
const money = value => ({ amount: String(value), currency: 'RUB' });
function sale(sku, units, date = '2026-09-17') {
  return { date, total_amount: money(units * 10), posting: { products: [{ sku, commission: { sale_amount: money(units * 10), seller_price: money(10) } }] } };
}
function store(operations = [sale(10, 28), sale(10, -3)], id = 'a') {
  return { id, market: 'Ozon', products: [{ key: id + ':1', product_id: 1, storeId: id, sku: 10, skus: ['10', 10], quantity: null }], ledger: buildLedger({
    period: { from: '2026-08-21', to: '2026-09-18' }, completedAt: '2026-09-18T11:00:00Z', sections: { finance: { ok: true } }, operations
  }) };
}
const read = (s, options = {}) => buildPartnerSales([s], { now, productKeys: ['a:1'], ...options })[0];
function unknown(s, pattern) {
  const value = read(s);
  assert.equal(value.sold, null); assert.equal(value.returned, null); assert.match(value.reason, pattern);
  return value;
}

test('real gross sales and returns cover exactly 28 completed Moscow days regardless of stock', () => {
  const s = store([sale(10, 28), sale(10, -3), sale(10, 999, '2026-09-18'), sale(10, 999, '2026-08-20')]);
  const row = read(s);
  assert.equal(row.sold, 28); assert.equal(row.returned, 3); assert.equal(row.reason, null);
  assert.deepEqual(row.period, { from: '2026-08-21', to: '2026-09-17' });
  s.ledger.completedAt = '2026-09-17T21:00:00Z';
  assert.deepEqual(read(s, { now: '2026-09-17T21:00:00Z' }).period, row.period);
  assert.equal(read(s, { now: '2026-09-17T21:00:00Z' }).sold, 28);
});

test('requires explicit selection, emits a strict allowlist, and never mutates source data', () => {
  const s = store(); s.products[0].cost = { unitCost: 333 }; s.products[0].ownerCommission = 25;
  s.products.push({ key: 'a:2', product_id: 2, storeId: 'a', sku: 20, secret: 'excluded' });
  const before = structuredClone(s);
  assert.deepEqual(buildPartnerSales([s], { now }), []);
  const rows = buildPartnerSales([s], { now, productKeys: ['a:1', 'a:1'] });
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['productKey', 'sold', 'returned', 'period', 'source', 'reason'].sort());
  assert.equal(JSON.stringify(rows).includes('333'), false); assert.equal(JSON.stringify(rows).includes('excluded'), false);
  assert.deepEqual(s, before);
});

test('aliases combine once and the same SKU remains isolated by store', () => {
  const a = store([sale(10, 28), sale(11, 5), sale(11, -2)]), b = store([sale(10, 50)], 'b');
  a.products[0].skus.push(11, '11');
  const rows = buildPartnerSales([a, b], { now, productKeys: ['a:1', 'b:1'] });
  assert.deepEqual(rows.map(row => [row.sold, row.returned]), [[33, 2], [50, 0]]);
});

test('full catalogs detect duplicate aliases, product keys and store identities', () => {
  const ambiguous = store(); ambiguous.products.push({ key: 'a:2', storeId: 'a', sku: 10 }); unknown(ambiguous, /привязки/);
  const duplicate = store(); duplicate.products.push({ ...duplicate.products[0] }); unknown(duplicate, /привязки/);
  const a = store(), other = store([], 'a'); other.products = [];
  assert.equal(buildPartnerSales([a, other], { now, productKeys: ['a:1'] })[0].sold, null);
});

test('missing and mismatched store binding cannot attribute another store sales', () => {
  for (const mutate of [s => delete s.products[0].storeId, s => s.products[0].storeId = 'b', s => s.products[0].product_id = 2, s => s.id = 'b', s => { delete s.products[0].sku; s.products[0].skus = []; }]) {
    const s = store(); mutate(s); unknown(s, /привязки/);
  }
  const missing = read(store(), { productKeys: ['a:missing'] });
  assert.equal(missing.sold, null); assert.match(missing.reason, /привязки/);
});

test('partial, legacy, foreign and uncovered history fail closed', () => {
  for (const mutate of [s => s.ledger.complete = false, s => s.ledger.version = 2, s => s.ledger.foreignRecords = 1,
    s => delete s.ledger.foreignRecords, s => s.ledger.period.from = '2026-08-22', s => s.ledger.period.to = '2026-09-16',
    s => s.ledger.period.from = '2026-02-30', s => delete s.ledger.daily, s => delete s.ledger.skuDaily]) {
    const s = store(); mutate(s); unknown(s, /полной истории/);
  }
  const unsupported = store(); unsupported.market = 'WB'; unknown(unsupported, /площадки/);
});

test('refresh must cover the finished Moscow window and cannot be in the future', () => {
  for (const timestamp of [undefined, 'invalid', '2026-09-17T20:59:59Z', '2026-09-19T00:00:00Z']) {
    const s = store(); s.ledger.completedAt = timestamp; unknown(s, /обновлен/);
  }
});

test('empty or service-only history is unknown; an observed return yields confirmed zero sales', () => {
  unknown(store([]), /наблюдений/);
  unknown(store([{ date: '2026-09-17', total_amount: money(-1), item_fees: { fees: [{ sku: 10, fees: [{ type_id: 1, accrued: money(-1) }] }] } }]), /наблюдений/);
  const row = read(store([sale(10, -2)])); assert.equal(row.sold, 0); assert.equal(row.returned, 2);
});

test('unknown quantities remain unknown but other known SKUs do not contaminate selected sales', () => {
  const unknownSale = sale(10, 1); delete unknownSale.posting.products[0].commission.seller_price;
  unknown(store([unknownSale]), /неизвестным количеством/);
  unknownSale.posting.products[0].sku = 99;
  assert.equal(read(store([sale(10, 28), unknownSale])).sold, 28);
  unknown(store([sale(undefined, 1), sale(10, 28)]), /не привязана/);
});

test('invalid counts, duplicate rows, totals mismatches and integer overflow fail closed', () => {
  for (const value of [-1, 1.5, '28', null, Infinity, Number.MAX_SAFE_INTEGER]) {
    const s = store(); s.ledger.skuDaily[0].values.soldUnits = value; unknown(s, /некорректны|не привязана/);
  }
  for (const mutate of [s => s.ledger.skuDaily.push(structuredClone(s.ledger.skuDaily[0])),
    s => s.ledger.daily.push(structuredClone(s.ledger.daily[0])),
    s => s.ledger.skuDaily[0].date = '2026-09-16',
    s => delete s.ledger.skuDaily[0].values.salesRows,
    s => s.ledger.skuDaily[0].values.unknownUnitRows = 99,
    s => s.ledger.skuDaily[0].date = '2026-02-30']) {
    const s = store(); mutate(s); unknown(s, /некорректны|не привязана/);
  }
});

test('bad public inputs fail explicitly', () => {
  assert.throws(() => buildPartnerSales(null), TypeError);
  assert.throws(() => read(store(), { productKeys: 'a:1' }), TypeError);
  for (const value of [null, {}, 'invalid']) assert.throws(() => read(store(), { now: value }), TypeError);
  assert.throws(() => buildPartnerSales([{ products: [] }], { now }), TypeError);
});
