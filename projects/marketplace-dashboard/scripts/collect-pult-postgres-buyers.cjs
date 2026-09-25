'use strict';

const path = require('node:path');
const { createApplicationPool } = require('../storage/postgres-connection.cjs');
const { createLiveComposition } = require('../storage/postgres-live-composition.cjs');
const createStores = require('../storage/domains/postgres-stores.cjs');
const { protect } = require('../storage/windows-dpapi.cjs');
const { createOzonApi } = require('../storage/acquisition/postgres-marketplace-transport.cjs');
const { createOzonBuyerOrdersCollector } = require('../storage/acquisition/postgres-buyer-orders-collector.cjs');
const { createPostgresBuyerSnapshot, sourcePath } = require('../storage/acquisition/postgres-buyer-snapshot.cjs');

const ROOT = path.resolve(__dirname, '..');
const fail = code => { throw Object.assign(new Error(code), { code }); };
function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!['--date', '--command-id', '--timestamp', '--expected-revision'].includes(name) || result[name.slice(2)] !== undefined || args[index + 1] === undefined) fail('INVALID_OPTIONS');
    result[name.slice(2)] = args[++index];
  }
  if (Object.keys(result).length !== 4) fail('INVALID_OPTIONS');
  return { date: result.date, commandId: result['command-id'], timestamp: result.timestamp, expectedRevision: result['expected-revision'] };
}

async function execute(input, { poolFactory = createApplicationPool, bootstrapFile = path.join(ROOT, '.private/postgres-setup/application.dpapi'), fetchFn = globalThis.fetch, compositionFactory = createLiveComposition, protectFn = protect, collectorFactory = createOzonBuyerOrdersCollector, snapshotFactory = createPostgresBuyerSnapshot } = {}) {
  const pool = await poolFactory({ bootstrapFile, profile: 'runtime' });
  try {
    const live = await compositionFactory({ pool }), stateStore = live.stateStore;
    stateStore.learn(sourcePath(input.date));
    const storesRepository = createStores({ stateStore }), collector = collectorFactory({ api: createOzonApi({ fetchFn }) });
    return await snapshotFactory({ stateStore, storesRepository, decrypt: value => protectFn(value, true), collector }).run(input);
  } finally { await pool.end(); }
}
async function main() {
  const result = await execute(options(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = { options, execute };
if (require.main === module) main().catch(error => {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : 'BUYER_COLLECTION_FAILED';
  process.stderr.write(code + '\n'); process.exitCode = 1;
});



