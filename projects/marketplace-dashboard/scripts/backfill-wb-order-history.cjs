'use strict';

// Run separately from the web server. This reads the last 28 complete WB days
// and stores only normalized history, respecting the Statistics API rate limit.
const path = require('node:path');
const { createApplicationPool } = require('../storage/postgres-connection.cjs');
const { createLiveComposition } = require('../storage/postgres-live-composition.cjs');
const { createPostgresStores } = require('../storage/domains/postgres-stores.cjs');
const { createMarketHistoryRepository } = require('../storage/postgres-history-repository.cjs');
const { createWbHistoryBackfill } = require('../storage/acquisition/postgres-wb-history-backfill.cjs');
const { protect } = require('../storage/windows-dpapi.cjs');

async function main() {
 if (process.argv.length !== 3 || process.argv[2] !== 'apply') throw Error('USAGE_APPLY');
 const pool = await createApplicationPool({ bootstrapFile: path.resolve(__dirname, '../.private/postgres-setup/application.dpapi') });
 let lease, locked = false;
 try {
  lease = await pool.connect();
  locked = (await lease.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
   ['pult:wb-history-backfill'])).rows[0]?.acquired === true;
  if (!locked) throw Error('BACKFILL_ALREADY_RUNNING');
  const live = await createLiveComposition({ pool });
  const storesRepository = createPostgresStores({ stateStore: live.stateStore });
  const history = createMarketHistoryRepository({ pool });
  const backfill = createWbHistoryBackfill({ pool, storesRepository,
   decrypt: value => protect(value, true), history });
  console.log(JSON.stringify({ phase: 'started', days: 28 }));
  const result = await backfill.run({ onProgress: row => console.log(JSON.stringify({ phase: 'day', ...row })) });
  console.log(JSON.stringify({ phase: 'complete', result }));
 } finally {
  if (locked) await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',
   ['pult:wb-history-backfill']).catch(() => {});
  lease?.release();
  await pool.end();
 }
}

if (require.main === module) main().catch(error => {
 console.error(JSON.stringify({ phase: 'error', code: /^[A-Z0-9_]+$/u.test(error?.code || error?.message || '')
  ? error.code || error.message : 'WB_HISTORY_BACKFILL_FAILED' }));
 process.exitCode = 1;
});

module.exports = { main };
