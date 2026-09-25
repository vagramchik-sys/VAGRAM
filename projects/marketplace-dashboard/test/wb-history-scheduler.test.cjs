'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWbHistoryScheduler } = require('../storage/acquisition/postgres-wb-history-scheduler.cjs');

test('daily WB history waits until 04:30 Moscow and runs once under a database lock', async () => {
 let current = Date.parse('2026-09-25T01:29:00Z'), locks = 0, runs = 0, releases = 0;
 const pool = { async connect() { return { async query(sql, params) {
  if (sql.includes('pg_try_advisory_lock')) { locks++; return { rows: [{ acquired: true }] }; }
  if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
  assert.deepEqual(params[0], ['wb-1']);assert.equal(params[1], '2026-09-24');
  return { rows: [{ stores: 0 }] };
 }, release() { releases++; } }; } };
 const scheduler = createWbHistoryScheduler({ pool,
  storesRepository: { async read() { return { 'wb-1': { market: 'WB' } }; } },
  backfill: { async run(options) { runs++;assert.deepEqual({ days: options.days, refreshLastDays: options.refreshLastDays }, { days: 2, refreshLastDays: 2 }); } },
  now: () => current
 });
 assert.equal(await scheduler.tick(), false);assert.equal(locks, 0);
 current = Date.parse('2026-09-25T01:31:00Z');
 assert.equal(await scheduler.tick(), true);assert.equal(await scheduler.tick(), false);
 assert.equal(runs, 1);assert.equal(locks, 1);assert.equal(releases, 1);
 await scheduler.close();
});

test('already refreshed day is skipped and another runner holding the lock prevents duplicate work', async () => {
 let acquired = false, runs = 0, timer;
 const scheduler = createWbHistoryScheduler({
  pool: { async connect() { return { async query(sql) { return { rows: sql.includes('pg_try_advisory_lock') ? [{ acquired }] : [{ stores: 1 }] }; }, release() {} }; } },
  storesRepository: { async read() { return { 'wb-1': { market: 'WB' } }; } },
  backfill: { async run() { runs++; } },
  now: () => Date.parse('2026-09-25T09:00:00Z'),
  setIntervalFn: fn => { timer = { fn, unref() {} }; return timer; }, clearIntervalFn: () => {}
 });
 assert.equal(await scheduler.tick(), false);assert.equal(runs, 0);
 acquired = true; assert.equal(await scheduler.tick(), false);assert.equal(runs, 0);
 await scheduler.close();
});
