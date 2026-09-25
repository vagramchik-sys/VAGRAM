'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { wbBuyerType, ozonBuyerType, projectWbOrder, projectOzonPosting, projectOzonProductOrders, mergeProductOrders, aggregate, merge, create, moscowDay } = require('../buyer-order-segments.cjs');

test('WB classification requires the scheme-specific explicit boolean and protects historical false', () => {
  assert.equal(wbBuyerType({ options: { isB2B: true } }, 'FBS', '2026-09-01T00:00:00.000Z').buyerType, 'legal');
  assert.equal(wbBuyerType({ options: { isB2B: false } }, 'FBS', '2026-09-01T00:00:00.000Z').buyerType, 'individual');
  assert.equal(wbBuyerType({ options: {} }, 'FBS', '2026-09-01T00:00:00.000Z').buyerType, 'unknown');
  assert.equal(wbBuyerType({ options: { isB2B: false } }, 'FBS', '2025-02-25T23:59:59.000Z').buyerType, 'unknown');
  assert.equal(wbBuyerType({ options: { isB2b: true } }, 'DBS', '2026-09-01T00:00:00.000Z').buyerType, 'legal');
});

test('WB assembly order is one unit and persists no buyer or product details', () => {
  const record = projectWbOrder({ id: 123, createdAt: '2026-09-01T10:00:00Z', options: { isB2B: true }, address: { fullAddress: 'secret' }, article: 'private' }, { scheme: 'FBS', status: { supplierStatus: 'cancel', wbStatus: 'cancelled' } });
  assert.deepEqual(record, { id: 'WB:FBS:123', orderKey: '123', market: 'WB', scheme: 'FBS', storeId: null, storeName: null, createdAt: '2026-09-01T10:00:00.000Z', units: 1, buyerType: 'legal', classificationField: 'options.isB2B', classificationReliable: true, cancelled: true });
  assert.doesNotMatch(JSON.stringify(record), /secret|private/);
});

test('Ozon sums product quantities and missing legal flag stays unknown', () => {
  const posting = { posting_number: '100-1', created_at: '2026-09-02T00:00:00Z', products: [{ quantity: 2 }, { quantity: '3' }], analytics_data: { is_legal: false }, status: 'awaiting_deliver' };
  assert.equal(projectOzonPosting(posting, { scheme: 'FBO' }).units, 5);
  assert.equal(projectOzonPosting(posting, { scheme: 'FBO' }).buyerType, 'individual');
  assert.equal(ozonBuyerType({ analytics_data: {} }).buyerType, 'unknown');
  assert.equal(ozonBuyerType({ analytics_data: { is_legal: 0 } }).buyerType, 'unknown');
});

test('aggregation keeps gross ordered units and cancellation status separate', () => {
  const records = [
    projectWbOrder({ id: 1, createdAt: '2026-09-01T00:00:00Z', options: { isB2B: true } }, { status: { supplierStatus: 'cancel', wbStatus: 'cancelled' } }),
    projectWbOrder({ id: 2, createdAt: '2026-09-02T00:00:00Z', options: { isB2B: false } }, { status: { supplierStatus: 'complete', wbStatus: 'sold' } }),
    projectWbOrder({ id: 3, createdAt: '2026-09-03T00:00:00Z', options: {} }),
    projectWbOrder({ id: 4, createdAt: '2026-08-01T00:00:00Z', options: { isB2B: true } })
  ];
  const result = aggregate([...records, records[0]], { from: '2026-09-01', to: '2026-09-30', sources: [{ market: 'WB', scheme: 'FBS', available: true, complete: true, from: '2026-09-01', to: '2026-09-30' }] });
  assert.deepEqual(result.totals.legal, { units: 1, orders: 1, cancelledUnits: 1, cancelledOrders: 1, notCancelledUnits: 0, notCancelledOrders: 0, cancellationUnknownUnits: 0, cancellationUnknownOrders: 0 });
  assert.deepEqual(result.totals.individual, { units: 1, orders: 1, cancelledUnits: 0, cancelledOrders: 0, notCancelledUnits: 1, notCancelledOrders: 1, cancellationUnknownUnits: 0, cancellationUnknownOrders: 0 });
  assert.deepEqual(result.totals.unknown, { units: 1, orders: 1, cancelledUnits: 0, cancelledOrders: 0, notCancelledUnits: 0, notCancelledOrders: 0, cancellationUnknownUnits: 1, cancellationUnknownOrders: 1 });
  assert.equal(result.coverage.duplicateRecords, 1);
  assert.equal(result.coverage.complete, true);
});

test('coverage is incomplete when a scheme is absent or a record is invalid', () => {
  const result = aggregate([{ bad: true }], { from: '2026-09-01', to: '2026-09-30', sources: [{ market: 'WB', scheme: 'FBS', available: false, complete: false, limitation: 'scope missing' }] });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.invalidRecords, 1);
});

test('merge is stable and idempotent', () => {
  const a = projectWbOrder({ id: 2, createdAt: '2026-09-02T00:00:00Z', options: {} });
  const b = projectWbOrder({ id: 1, createdAt: '2026-09-01T00:00:00Z', options: {} });
  assert.deepEqual(merge([a, a, b]).map(record => record.id), ['WB:FBS:1', 'WB:FBS:2']);
});

test('period uses Moscow day and rejects impossible calendar dates', () => {
  assert.equal(moscowDay('2026-09-01T21:00:00.000Z'), '2026-09-02');
  const record = projectWbOrder({ id: 8, createdAt: '2026-09-01T21:00:00Z', options: { isB2B: true } });
  assert.equal(aggregate([record], { from: '2026-09-02', to: '2026-09-02', sources: [{ market: 'WB', scheme: 'FBS', available: true, complete: true, from: '2026-09-01', to: '2026-09-30' }] }).totals.legal.units, 1);
  assert.throws(() => aggregate([], { from: '2026-02-30', to: '2026-03-01' }), /Некорректный период/);
});

test('same upstream ids in different stores stay separate', () => {
  const base = { id: 9, orderUid: 'shared', createdAt: '2026-09-01T00:00:00Z', options: { isB2B: false } };
  const records = [projectWbOrder(base, { storeId: 'one', storeName: 'One' }), projectWbOrder(base, { storeId: 'two', storeName: 'Two' })];
  const result = aggregate(records, { from: '2026-09-01', to: '2026-09-01', sources: [{ market: 'WB', scheme: 'FBS', storeId: 'one', available: true, complete: true }, { market: 'WB', scheme: 'FBS', storeId: 'two', available: true, complete: true, from: '2026-09-01', to: '2026-09-30' }] });
  assert.equal(result.totals.individual.units, 2);
  assert.equal(result.totals.individual.orders, 2);
  assert.equal(result.byStore.length, 2);
  assert.equal(merge(records).length, 2);
});

test('reader never stretches a TODAY snapshot over another period', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buyer-orders-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'snapshot.json'), fetchedAt = '2026-09-20T12:00:00.000Z';
  const source = { market: 'Ozon', scheme: 'FBO', storeId: 'one', name: 'Store', available: true, complete: true, requested: { from: '2026-09-20', to: '2026-09-20' }, fetchedAt };
  fs.writeFileSync(file, JSON.stringify({ records: [], report: { coverage: { sources: [source] } } }));
  const service = create({ snapshotFile: file });
  const today = service.read({ from: '2026-09-20', to: '2026-09-20', market: 'all' });
  assert.equal(today.status, 'ready'); assert.equal(today.byStore.length, 1); assert.equal(today.byStore[0].totals.legal.units, 0);
  const yesterday = service.read({ from: '2026-09-19', to: '2026-09-19', market: '' });
  assert.equal(yesterday.status, 'unavailable'); assert.equal(yesterday.totals, null); assert.equal(yesterday.byStore[0].totals, null); assert.equal(yesterday.coverage.sources[0].coversRequested, false);
  assert.throws(() => service.read({ from: '2026-09-20', to: '2026-09-20', market: 'invalid' }), /маркетплейс/);
});

test('an unavailable loaded store remains visible with null totals', () => {
  const result = aggregate([], { from: '2026-09-20', to: '2026-09-20', sources: [{ market: 'WB', scheme: 'FBS', storeId: 'wb', name: 'WB', available: false, complete: false, from: '2026-09-20', to: '2026-09-20' }] });
  assert.equal(result.status, 'unavailable'); assert.equal(result.byStore.length, 1); assert.equal(result.byStore[0].totals, null);
});

test('product order projection aggregates repeated SKU without buyer data or invented money', () => {
  const posting = { posting_number: 'p1', order_number: 'o1', created_at: '2026-09-20T10:00:00Z', status: 'awaiting_deliver', products: [{ sku: 5, quantity: 2, price: '10.50', currency: 'RUB', name: 'secret' }, { sku: 5, quantity: 3, price: '10.50', currency: 'RUB' }, { sku: 6, quantity: 1, price: '9.00' }] };
  const rows = projectOzonProductOrders(posting, { scheme: 'FBO', storeId: 'one', updatedAt: '2026-09-20T11:00:00Z' });
  assert.equal(rows.length, 2); assert.equal(rows[0].units, 5); assert.equal(rows[0].amountRub, 52.5); assert.equal(rows[1].amountRub, null);
  assert.doesNotMatch(JSON.stringify(rows), /secret/);
  const merged = mergeProductOrders([...rows, { ...rows[0], postingId: 'p2', units: 1, amountRub: 10.5 }]);
  assert.equal(merged.find(row => row.productId === '5').units, 6);
});

test('FBS product time remains unavailable when created_at is absent', () => {
  const rows = projectOzonProductOrders({ posting_number: 'p', order_number: 'o', in_process_at: '2026-09-20T10:00:00Z', products: [{ sku: 1, quantity: 1 }] }, { scheme: 'FBS', storeId: 'one' });
  assert.equal(rows[0].orderedAt, null);
});

test('new Ozon price amount/currency objects retain confirmed rubles without guessing missing currency', () => {
 const {projectOzonProductOrders}=require('../buyer-order-segments.cjs');
 const base={posting_number:'new-price',order_number:'order',created_at:'2026-09-24T10:00:00Z',products:[]};
 const amount=price=>projectOzonProductOrders({...base,products:[{sku:1,quantity:2,price}]},{scheme:'FBO',storeId:'1'})[0].amountRub;
 assert.equal(amount({amount:'10.50',currency:'RUB'}),21);
 assert.equal(amount({amount:0,currency:'RUB'}),0);
 for(const price of [{amount:'10.50'},{amount:'10.50',currency:'USD'},{amount:'oops',currency:'RUB'},{amount:-1,currency:'RUB'}])assert.equal(amount(price),null);
});
