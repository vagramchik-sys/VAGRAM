'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWbHistoryBackfill, HISTORY_SQL, previousDates } = require('../storage/acquisition/postgres-wb-history-backfill.cjs');

test('WB history backfill imports each prior Moscow day once from one rate-limited bulk feed', async () => {
 const saved = [], urls = [], waits = [], current = Date.parse('2026-09-25T09:00:00Z');
 const pages = [[{ date: '2026-09-24T11:05:00', lastChangeDate: '2026-09-24T11:06:00',
  srid: 'one', priceWithDisc: 50, nmId: 42, isCancel: false }], []];
 const backfill = createWbHistoryBackfill({
  pool: { async query(sql, params) { assert.equal(sql, HISTORY_SQL); assert.deepEqual(params, ['wb-1', '2026-09-23', '2026-09-24']); return { rows: [] }; } },
  storesRepository: { async read() { return { 'wb-1': { market: 'WB', key: 'protected' } }; } },
  decrypt: async value => { assert.equal(value, 'protected'); return 'token'; },
  history: { async ingest(input) { saved.push(input); return { duplicate: false }; } },
  fetchFn: async (url, options) => { urls.push(url); assert.equal(options.headers.Authorization, 'token');
   return { ok: true, status: 200, json: async () => pages.shift() }; },
  now: () => current, sleep: async ms => waits.push(ms), minGapMs: 61000
 });
 assert.deepEqual(previousDates('2026-09-25', 2), ['2026-09-23', '2026-09-24']);
 assert.deepEqual(await backfill.run({ days: 2 }), [{ storeId: 'wb-1', imported: 2, skipped: 0 }]);
 assert.equal(urls.length, 2);assert.match(urls[0], /dateFrom=2026-09-23&flag=0/u);
 assert.deepEqual(waits, [61000]);
 assert.deepEqual(saved.map(row => row.data.day), ['2026-09-23', '2026-09-24']);
 assert.deepEqual(saved.map(row => row.data.orderedUnits), [0, 1]);
 assert.equal(saved[0].sourceFile, 'wb-orders-wb-1.json');
 assert.match(saved[0].contentHash, /^[a-f0-9]{64}$/u);
});

test('closed WB days need no API request and a malformed response never writes fake zeros', async () => {
 let called = 0, written = 0;
 const base = {
  storesRepository: { async read() { return { 'wb-1': { market: 'WB', key: 'protected' } }; } },
  decrypt: async () => 'token', history: { async ingest() { written++; return { duplicate: false }; } },
  fetchFn: async () => { called++; return { ok: true, status: 200, json: async () => [{ date: 'invalid' }] }; },
  now: () => Date.parse('2026-09-25T09:00:00Z'), minGapMs: 0
 };
 const closed = createWbHistoryBackfill({ ...base, pool: { async query() { return { rows: [{ day: '2026-09-24' }] }; } } });
 assert.deepEqual(await closed.run({ days: 1 }), [{ storeId: 'wb-1', imported: 0, skipped: 1 }]);
 assert.equal(called, 0);
 const invalid = createWbHistoryBackfill({ ...base, pool: { async query() { return { rows: [] }; } } });
 await assert.rejects(invalid.run({ days: 1 }), { code: 'SOURCE_INVALID' });
 assert.equal(written, 0);
});

test('daily reconciliation revisits recent closed days without inserting an unchanged duplicate', async () => {
 let fetched = 0, ingested = 0;
 const backfill = createWbHistoryBackfill({
  pool: { async query() { return { rows: [{ day: '2026-09-23' }, { day: '2026-09-24' }] }; } },
  storesRepository: { async read() { return { 'wb-1': { market: 'WB', key: 'protected' } }; } },
  decrypt: async () => 'token',
  history: { async ingest() { ingested++; return { duplicate: true }; } },
  fetchFn: async () => { fetched++; return { ok: true, status: 200, json: async () => [] }; },
  now: () => Date.parse('2026-09-25T09:00:00Z'), minGapMs: 0
 });
 assert.deepEqual(await backfill.run({ days: 2, refreshLastDays: 2 }),
  [{ storeId: 'wb-1', imported: 0, skipped: 2 }]);
 assert.equal(fetched, 1); assert.equal(ingested, 2);
});
