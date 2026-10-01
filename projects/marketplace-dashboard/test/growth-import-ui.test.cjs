'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {captureContext, sameContext, confirmedPeriod, mergeRows, makePayload, stableSubmission, MAX_BYTES} = require('../dist/growth-import.js');
const observedAt = '2026-10-01T10:00:00.000Z';
const metrics = {periodFrom: '2026-08-01', periodTo: '2026-08-31', observedAt: '2026-09-01T10:00:00.000Z', averagePrice: 600, minimumPrice: 550, orderedUnits: 10, drrPct: 8};
const row = id => ({id: String(id), url: `https://www.ozon.ru/product/${id}/`, name: `Product ${id}`, seller: 'Seller', brand: 'Brand', historical: {averagePrice: 700, minimumPrice: 650, orderedUnits: 20, drrPct: 9}});
const existing = () => ({id: '31', url: 'https://www.ozon.ru/product/31/', name: 'Reviewed product', matchStatus: 'confirmed', matchNotes: 'Same package', unitCount: 5, source: 'ozon_seller_analytics', metrics: structuredClone(metrics)});
const current = () => ({selected: {product: {storeId: '11', id: '22', sku: '23', skus: ['23', '24'], name: 'Our product'}}, watchlist: {revision: '7', competitors: [existing()]}});
const context = () => captureContext(current());

test('opening captures store, product, SKU aliases and revision without sharing mutable records', () => {
  const value = current(), captured = captureContext(value); value.watchlist.competitors[0].unitCount = 99;
  assert.equal(captured.competitors[0].unitCount, 5); assert.equal(captured.revision, '7');
  assert.deepEqual(captured.ownIds, ['22', '23', '24']);
  assert.equal(sameContext(captured, current()), true);
  value.selected.product.storeId = '12'; assert.equal(sameContext(captured, value), false);
  value.selected.product.storeId = '11'; value.selected.product.id = '99'; assert.equal(sameContext(captured, value), false);
  assert.throws(() => captureContext({selected: value.selected}), /дождитесь/u);
});

test('blank or unconfirmed period preserves historical metrics and adds new cards without metrics', () => {
  assert.equal(confirmedPeriod({}, observedAt), null);
  assert.equal(confirmedPeriod({from: '09/01/26', to: '09/30/26', confirmed: false}, observedAt), null);
  const result = mergeRows(context(), [row(31), row(32)], ['31', '32'], confirmedPeriod({}, observedAt));
  assert.deepEqual(result[0], existing()); assert.equal(result[1].metrics, null);
  assert.equal(result[1].matchStatus, 'candidate'); assert.equal(result[1].unitCount, null); assert.equal(result[1].source, 'ozon_seller_analytics');
});

test('only explicit valid ISO dates permit replacement of historical metrics', () => {
  const period = confirmedPeriod({from: '2026-09-01', to: '2026-09-30', confirmed: true}, observedAt);
  const result = mergeRows(context(), [row(31)], ['31'], period)[0];
  assert.equal(result.metrics.periodFrom, '2026-09-01'); assert.equal(result.metrics.averagePrice, 700);
  assert.equal(result.matchStatus, 'confirmed'); assert.equal(result.matchNotes, 'Same package'); assert.equal(result.unitCount, 5); assert.equal(result.name, 'Reviewed product');
  for (const fields of [{from: '', to: ''}, {from: '090126', to: '093026'}, {from: '2026-09-31', to: '2026-10-01'}, {from: '2026-09-30', to: '2026-09-01'}, {from: '2026-10-01', to: '2026-10-02'}]) assert.throws(() => confirmedPeriod({...fields, confirmed: true}, observedAt));
});

test('merge retains unselected existing competitors, deduplicates and excludes every own SKU', () => {
  const result = mergeRows(context(), [row(22), row(23), row(24), row(32), row(32)], ['22', '23', '24', '32']);
  assert.deepEqual(result.map(value => value.id), ['31', '32']);
  assert.deepEqual(result[0], existing());
  assert.throws(() => mergeRows(context(), [row(22), row(23)], ['22', '23']), /кроме своего/u);
});

test('combined maximum counts existing and new cards without counting duplicate updates', () => {
  const captured = context(); captured.competitors = Array.from({length: 50}, (_, index) => ({...existing(), id: String(100 + index), url: `https://www.ozon.ru/product/${100 + index}/`}));
  assert.equal(mergeRows(captured, [row(100)], ['100']).length, 50);
  assert.throws(() => mergeRows(captured, [row(200)], ['200']), /51 карточек/u);
  assert.equal(MAX_BYTES, 8 * 1024 * 1024);
});

test('payload retry preserves identical UUID, revision, captured identity and body despite changed inputs', () => {
  const holder = {}, captured = context(); let calls = 0;
  const first = stableSubmission(holder, () => { calls++; return makePayload(captured, [row(32)], ['32'], {}, observedAt, '11111111-1111-4111-8111-111111111111'); });
  captured.revision = '9'; captured.storeId = '12';
  const second = stableSubmission(holder, () => { calls++; throw Error('must not rebuild uncertain command'); });
  assert.deepEqual(second, first); assert.equal(calls, 1); assert.equal(second.storeId, '11'); assert.equal(second.expectedRevision, '7');
  first.competitors.pop(); assert.equal(stableSubmission(holder, () => null).competitors.length, 2);
});

test('unsafe report URLs cannot become candidate links', () => {
  for (const url of ['javascript:alert(1)', 'https://attacker.example/product/32/', 'https://user@ozon.ru/product/32/', 'https://ozon.ru/product/99/']) assert.throws(() => mergeRows(context(), [{...row(32), url}], ['32']));
});
