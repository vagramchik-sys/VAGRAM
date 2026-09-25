'use strict';

// A small daily background task. PostgreSQL remains the source of truth;
// the advisory lock prevents a manual backfill and this task from overlapping.
const { day } = require('../../wb-orders.cjs');
const { previousDates } = require('./postgres-wb-history-backfill.cjs');

const LOCK = 'pult:wb-history-backfill';
const CLOSED_TODAY_SQL = `SELECT count(DISTINCT store_id)::integer AS stores
 FROM pult_history.snapshots
 WHERE market='WB' AND source_kind='wb-orders' AND closed_confirmed=true
  AND store_id=ANY($1::text[]) AND day=$2::date AND source_actual_at>=$3::timestamptz`;

function createWbHistoryScheduler({ pool, storesRepository, backfill, now = Date.now,
  intervalMs = 30 * 60000, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  onError = () => {} } = {}) {
 if (!pool?.connect || !storesRepository?.read || !backfill?.run ||
     !Number.isSafeInteger(intervalMs) || intervalMs < 60000 ||
     typeof now !== 'function' || typeof setIntervalFn !== 'function' ||
     typeof clearIntervalFn !== 'function' || typeof onError !== 'function')
  throw new TypeError('WB history scheduler dependencies are required');
 let timer = null, running = false, closed = false, ranDay = null, controller = null;

 async function tick() {
  if (closed || running) return false;
  const timestamp = Number(now()), today = day(timestamp);
  // 04:30 Moscow: allow WB Statistics time to settle after midnight.
  const boundary = Date.parse(today + 'T01:30:00.000Z');
  if (!Number.isFinite(timestamp) || timestamp < boundary || ranDay === today) return false;
  running = true;
  let lease, locked = false;
  controller = new AbortController();
  try {
   lease = await pool.connect();
   locked = (await lease.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [LOCK])).rows[0]?.acquired === true;
   if (!locked || closed) return false;
   const stores = await storesRepository.read(), ids = Object.entries(stores)
    .filter(([id, store]) => store.market === 'WB' && /^wb-\d+$/u.test(id)).map(([id]) => id);
   if (!ids.length) { ranDay = today; return false; }
   const yesterday = previousDates(today, 1)[0];
   const already = (await lease.query(CLOSED_TODAY_SQL, [ids, yesterday, new Date(boundary).toISOString()])).rows[0]?.stores;
   if (already === ids.length) { ranDay = today; return false; }
   await backfill.run({ days: 2, refreshLastDays: 2, signal: controller.signal });
   ranDay = today;
   return true;
  } catch (error) {
   if (!closed) onError({ code: /^[A-Z0-9_]+$/u.test(error?.code || '') ? error.code : 'WB_HISTORY_REFRESH_FAILED' });
   return false;
  } finally {
   if (locked) await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [LOCK]).catch(() => {});
   lease?.release();
   controller = null;
   running = false;
  }
 }

 async function start() {
  if (timer || closed) throw Error('WB history scheduler cannot start twice');
  const report = error => { if (!closed) try { onError({ code: /^[A-Z0-9_]+$/u.test(error?.code || '') ? error.code : 'WB_HISTORY_REFRESH_FAILED' }); } catch {} };
  timer = setIntervalFn(() => { void tick().catch(report); }, intervalMs);
  timer.unref?.();
  void tick().catch(report);
 }
 async function close() {
  closed = true;
  if (timer) { clearIntervalFn(timer); timer = null; }
  controller?.abort();
  while (running) await new Promise(resolve => setTimeout(resolve, 5));
 }
 return Object.freeze({ start, close, tick });
}

module.exports = { createWbHistoryScheduler, CLOSED_TODAY_SQL };
