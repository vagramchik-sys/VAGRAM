'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichBuyerTypes, summarize } = require('../buyer-product-segments.cjs');

const source = (overrides = {}) => ({ market: 'Ozon', storeId: 's1', name: 'Store 1', scheme: 'FBO', available: true, complete: true, from: '2026-09-01', to: '2026-09-30', fetchedAt: '2026-09-20T12:00:00Z', ...overrides });
const row = (overrides = {}) => ({ market: 'Ozon', storeId: 's1', scheme: 'FBO', orderId: 'o1', postingId: 'p1', productId: 'sku1', orderedAt: '2026-09-10T10:00:00Z', units: 2, amountRub: 200, cancelled: false, updatedAt: '2026-09-20T12:00:00Z', ...overrides });
const record = (overrides = {}) => ({ market: 'Ozon', storeId: 's1', scheme: 'FBO', orderKey: 'o1', buyerType: 'legal', ...overrides });

test('joins buyer type only by market, store, scheme and order', () => {
  const rows = enrichBuyerTypes([row(), row({ storeId: 's2', orderId: 'o1', productId: 'sku2' })], [record(), record({ storeId: 's2', buyerType: 'individual' })]);
  assert.equal(rows.find(value => value.storeId === 's1').buyerType, 'legal');
  assert.equal(rows.find(value => value.storeId === 's2').buyerType, 'individual');
});

test('conflicting or missing classifications stay unknown', () => {
  const rows = enrichBuyerTypes([row()], [record({ buyerType: 'legal' }), record({ buyerType: 'individual' })]);
  assert.equal(rows[0].buyerType, 'unknown');
  assert.equal(enrichBuyerTypes([row({ orderId: 'missing' })], [record()])[0].buyerType, 'unknown');
});

test('ranks products by legal units and reports share and cancellations separately', () => {
  const rows = [
    row(), row({ orderId: 'o2', postingId: 'p2', units: 3, amountRub: 300, cancelled: true }),
    row({ orderId: 'o3', postingId: 'p3', productId: 'sku2', units: 4, amountRub: 400 }),
    row({ orderId: 'o4', postingId: 'p4', productId: 'sku2', units: 6, amountRub: null }),
    row({ orderId: 'o5', postingId: 'p5', productId: 'sku3', units: 5, amountRub: 500 })
  ];
  const records = [record(), record({ orderKey: 'o2' }), record({ orderKey: 'o3' }), record({ orderKey: 'o4', buyerType: 'individual' }), record({ orderKey: 'o5', buyerType: 'unknown' })];
  const result = summarize(rows, { records, sources: [source()], from: '2026-09-01', to: '2026-09-30' });
  assert.equal(result.products[0].productId, 'sku1');
  assert.equal(result.products[0].segments.legal.units, 5);
  assert.equal(result.products[0].segments.legal.cancelledUnits, 3);
  assert.equal(result.products.find(value => value.productId === 'sku2').legalShare, 0.4);
  assert.equal(result.products.find(value => value.productId === 'sku2').segments.individual.amountRub, null);
  assert.equal(result.totals.unknown.units, 5);
});

test('filters exact source/store combinations and does not invent unavailable zero', () => {
  const sources = [source(), source({ storeId: 's2', name: 'Store 2', available: false, complete: false, limitation: 'missing' })];
  const unavailable = summarize([], { records: [], sources, from: '2026-09-01', to: '2026-09-30', storeId: 's2' });
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.totals, null); assert.equal(unavailable.coverage.sources.length, 1);
  const available = summarize([row()], { records: [record()], sources, from: '2026-09-01', to: '2026-09-30', storeId: 's1', market: 'Ozon' });
  assert.equal(available.status, 'ready'); assert.equal(available.totals.legal.units, 2);
});

test('missing order time is reported and never assigned to a day', () => {
  const result = summarize([row({ orderedAt: null })], { records: [record()], sources: [source()], from: '2026-09-01', to: '2026-09-30' });
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.missingTimeRows, 1); assert.equal(result.products.length, 0);
});

test('keeps identical product ids separate by marketplace and store', () => {
  const rows = [row({ productId: 'shared' }), row({ storeId: 's2', productId: 'shared', orderId: 'o2', postingId: 'p2', units: 3 })];
  const records = [record(), record({ storeId: 's2', orderKey: 'o2' })];
  const result = summarize(rows, { records, sources: [source(), source({ storeId: 's2' })], from: '2026-09-01', to: '2026-09-30' });
  assert.equal(result.products.length, 2);
  assert.deepEqual(result.products.map(value => [value.storeId, value.segments.legal.units]).sort(), [['s1', 2], ['s2', 3]]);
});

test('returns overlapping saved coverage as partial instead of unavailable', () => {
  const result = summarize([row()], { records: [record()], sources: [source({ from: '2026-09-01', to: '2026-09-19' })], from: '2026-09-01', to: '2026-09-20' });
  assert.equal(result.status, 'partial');
  assert.equal(result.products[0].segments.legal.units, 2);
  assert.equal(result.coverage.sources[0].coversRequested, false);
});
