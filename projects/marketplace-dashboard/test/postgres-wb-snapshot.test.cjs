'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createWbSnapshotCollector } = require('../storage/acquisition/postgres-wb-snapshot.cjs');
const response = (status, value, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: name => headers[name] ?? null }, async json() { return value; } });
const fixed = () => new Date('2026-09-22T10:00:00.000Z');

test('WB collector detects repeated cursors and keeps other sections explicit', async () => {
  let cardCalls = 0;
  const fetchFn = async url => {
    if (url.includes('/cards/list')) { cardCalls++; return response(200, { cards: Array.from({ length: 100 }, (_, i) => ({ nmID: i, title: 'P' })), cursor: { updatedAt: 'x', nmID: 1 } }); }
    if (url.includes('/stocks-report/')) return response(200, []);
    return response(200, []);
  };
  const result = await createWbSnapshotCollector({ fetchFn, sleep: async () => {}, now: fixed }).collect({ store: { name: 'WB', clientId: 'wb-20' }, key: 'plain-wb-secret' });
  assert.equal(cardCalls, 2); assert.equal(result.status, 'partial'); assert.equal(result.snapshot.sections.products.ok, false);
  assert.equal(result.snapshot.sections.stocks.ok, true); assert.equal(result.snapshot.sections.finance.ok, true);
  assert.equal(JSON.stringify(result).includes('plain-wb-secret'), false);
});

test('WB retries throttled transport with bounded server cooldown', async () => {
  let first = true; const waits = [];
  const fetchFn = async url => { if (first) { first = false; return response(429, {}, { 'Retry-After': '3' }); } if (url.includes('/cards/list')) return response(200, { cards: [] }); return response(200, []); };
  const result = await createWbSnapshotCollector({ fetchFn, sleep: async ms => waits.push(ms), now: fixed }).collect({ store: { name: 'WB', clientId: 'wb-20' }, key: 'secret' });
  assert.equal(result.status, 'done'); assert.equal(waits[0], 3000);
});
