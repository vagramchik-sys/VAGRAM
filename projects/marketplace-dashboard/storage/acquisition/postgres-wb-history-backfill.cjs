'use strict';

// One bounded, resumable historical import. It never runs in an HTTP request.
const crypto = require('node:crypto');
const { day, instant, normalize, HOST, ROUTE } = require('../../wb-orders.cjs');

const DAY_MS = 86400000;
const MAX_PAGES = 20;
const MAX_ROWS = 1000000;
const HISTORY_SQL = `SELECT DISTINCT day::text AS day FROM pult_history.snapshots
 WHERE market='WB' AND source_kind='wb-orders' AND store_id=$1
  AND closed_confirmed=true AND day BETWEEN $2::date AND $3::date`;
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason || Error('ABORTED')); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});
const previousDates = (today, count) => Array.from({ length: count }, (_, index) =>
  new Date(Date.parse(today + 'T00:00:00Z') - (count - index) * DAY_MS).toISOString().slice(0, 10));

function createWbHistoryBackfill({ pool, storesRepository, decrypt, history, fetchFn = globalThis.fetch,
  now = Date.now, sleep = delay, minGapMs = 61000 } = {}) {
 if (!pool?.query || !storesRepository?.read || typeof decrypt !== 'function' ||
     typeof history?.ingest !== 'function' || typeof fetchFn !== 'function' ||
     !Number.isSafeInteger(minGapMs) || minGapMs < 0) throw new TypeError('WB history backfill dependencies are required');

 async function run({ days = 28, refreshLastDays = 0, onProgress = () => {}, signal } = {}) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 89 || !Number.isSafeInteger(refreshLastDays) || refreshLastDays < 0 || refreshLastDays > days || typeof onProgress !== 'function')
   throw new TypeError('WB history window is invalid');
  const dates = previousDates(day(now()), days), directory = await storesRepository.read();
  const results = [];
  for (const [storeId, store] of Object.entries(directory)) {
   if (store.market !== 'WB' || !/^wb-\d+$/u.test(storeId)) continue;
   const existing = new Set((await pool.query(HISTORY_SQL, [storeId, dates[0], dates.at(-1)])).rows.map(row => row.day));
   const missing = dates.filter((date, index) => !existing.has(date) || index >= dates.length - refreshLastDays);
   if (!missing.length) { results.push({ storeId, imported: 0, skipped: dates.length }); continue; }
   let token, cursor = missing[0], lastRequestAt = null, all = [], completed = false;
   try {
    token = await decrypt(store.key);
    if (typeof token !== 'string' || !token) throw Object.assign(Error('WB token unavailable'), { code: 'TOKEN_UNAVAILABLE' });
    for (let page = 0; page < MAX_PAGES; page++) {
     let rows;
     for (let retry = 0; retry < 4; retry++) {
      signal?.throwIfAborted();
      if (lastRequestAt !== null) await sleep(Math.max(0, lastRequestAt + minGapMs - now()), signal);
      lastRequestAt = now();
      const response = await fetchFn(`${HOST}${ROUTE}?${new URLSearchParams({ dateFrom: cursor, flag: '0' })}`,
       { headers: { Authorization: token }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
      if (response.status === 429) {
       const retryAfter = Number(response.headers?.get?.('Retry-After'));
       lastRequestAt = now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : minGapMs);
       if (retry === 3) throw Object.assign(Error('WB rate limit'), { code: 'RATE_LIMIT' });
       continue;
      }
      if (response.status === 401 || response.status === 403) throw Object.assign(Error('WB Statistics access denied'), { code: 'STATISTICS_SCOPE' });
      if (!response.ok) throw Object.assign(Error('WB history unavailable'), { code: 'UPSTREAM' });
      rows = await response.json();
      if (!Array.isArray(rows)) throw Object.assign(Error('WB history format invalid'), { code: 'SOURCE_INVALID' });
      break;
     }
     if (!rows) throw Object.assign(Error('WB history unavailable'), { code: 'UPSTREAM' });
     if (!rows.length) { completed = true; break; }
     all.push(...rows);
     if (all.length > MAX_ROWS) throw Object.assign(Error('WB history exceeds safe bound'), { code: 'SOURCE_TOO_LARGE' });
     const last = instant(rows.at(-1)?.lastChangeDate);
     if (!Number.isFinite(last)) throw Object.assign(Error('WB cursor invalid'), { code: 'SOURCE_INVALID' });
     // The API's inclusive cursor repeats its final row. A millisecond advance
     // is safe only below the documented approximate 80k-row page boundary.
     const next = new Date(last + (rows.length < 75000 ? 1 : 0) + 3 * 3600000).toISOString().slice(0, 23);
     if (cursor !== missing[0] && instant(next) <= instant(cursor))
      throw Object.assign(Error('WB cursor did not advance'), { code: 'SOURCE_INCOMPLETE' });
     cursor = next;
    }
    if (!completed) throw Object.assign(Error('WB history pagination incomplete'), { code: 'SOURCE_INCOMPLETE' });
    const byDate = new Map(dates.map(date => [date, []]));
    for (const row of all) {
     const at = instant(row?.date);
     if (!Number.isFinite(at)) throw Object.assign(Error('WB order timestamp invalid'), { code: 'SOURCE_INVALID' });
     const date = day(at);
     if (byDate.has(date)) byDate.get(date).push(row);
    }
    let imported = 0;
    for (const date of missing) {
     signal?.throwIfAborted();
     const snapshot = normalize(byDate.get(date), date, { fetchedAt: new Date(now()).toISOString() });
     if (snapshot.orders.some(order => !order.nmId)) throw Object.assign(Error('WB product id missing'), { code: 'SOURCE_INVALID' });
     const hash = crypto.createHash('sha256').update(JSON.stringify({ day: date, orders: snapshot.orders })).digest('hex');
     const result = await history.ingest({ sourceFile: `wb-orders-${storeId}.json`, contentHash: hash,
      capturedAt: snapshot.fetchedAt, data: snapshot });
     if (!result?.duplicate) imported++;
     onProgress({ storeId, date, imported: !result?.duplicate });
    }
    results.push({ storeId, imported, skipped: dates.length - imported });
   } finally { token = null; all = []; }
  }
  return results;
 }
 return Object.freeze({ run });
}

module.exports = { createWbHistoryBackfill, HISTORY_SQL, previousDates };
