'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const createStores = require('../storage/domains/postgres-stores.cjs');
const createCore = require('../storage/domains/postgres-core.cjs');
const { summarize } = require('../summary.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
function memoryState() {
  const documents = new Map(), commands = new Map();
  return {
    async read(key) { return documents.get(key) || null; },
    async readCommand(key, commandId) { const item = commands.get(commandId); return item?.key === key ? item.command : null; },
    async write(key, content, options) {
      const request = JSON.stringify([key, options.expectedRevision, options.mediaType, content.toString('base64')]), old = commands.get(options.commandId);
      if (old) { if (old.request !== request) throw Object.assign(Error('reuse'), { code: 'COMMAND_ID_REUSED' }); return { revision: old.revision, replayed: true }; }
      const before = documents.get(key); if ((before?.revision || '0') !== options.expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' });
      const revision = String(BigInt(options.expectedRevision) + 1n), after = { revision, deleted: false, mediaType: options.mediaType, content: Buffer.from(content), sha256: digest(content) };
      documents.set(key, after); commands.set(options.commandId, { key, request, revision, command: { commandId: options.commandId, before: before || { revision: '0', mediaType: null, content: null, sha256: null, deleted: null }, after } }); return { revision, replayed: false };
    }, async remove() { throw Error('unused'); }
  };
}
const C1 = '11111111-1111-4111-8111-111111111111', C2 = '22222222-2222-4222-8222-222222222222';
const storesValue = updatedAt => ({ '1': { name: 'SK', clientId: '1', key: 'opaque-dpapi-ciphertext', connectedAt: '2026-09-01T00:00:00.000Z', ...(updatedAt ? { updatedAt } : {}) } });
const raw = { store: 'SK', clientId: '1', startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T01:00:00Z', period: { from: '2026-09-01', to: '2026-09-01' }, sections: { finance: { ok: true } }, products: [{ product_id: 10, name: 'Болт', offer_id: 'A' }], stocks: [], operations: [], stockRows: [], categoryTree: [] };

test('stores registry preserves ciphertext but public projections never expose it', async () => {
  const stateStore = memoryState(), stores = createStores({ stateStore });
  await stores.compareAndSet(storesValue(), { expectedRevision: '0', commandId: C1 });
  assert.equal((await stores.protectedStore('1')).key, 'opaque-dpapi-ciphertext');
  const core = createCore({ storesRepository: stores, stateStore, marketRepository: { getSnapshot: async id => id === '1' ? raw : null } });
  assert.deepEqual(await core.ready(), { ready: false, coreReady: true, missingAdapters: ['runtime-wiring'], passive: true });
  const publicRows = await core.publicStores(); assert.equal(publicRows[0].id, '1'); assert.equal(JSON.stringify(publicRows).includes('opaque-dpapi'), false); assert.equal('key' in publicRows[0], false);
  assert.deepEqual(await core.publicSnapshot('1'), summarize(raw, null, null));
  assert.equal((await core.supplierProducts())[0].storeId, '1');
});

test('core reads fresh SQL state after CAS and rejects unknown stores without fallback', async () => {
  const stateStore = memoryState(), stores = createStores({ stateStore }), market = { getSnapshot: async id => id === '1' ? raw : null };
  await stores.compareAndSet(storesValue(), { expectedRevision: '0', commandId: C1 });
  const core = createCore({ storesRepository: stores, stateStore, marketRepository: market });
  assert.equal((await core.publicStores())[0].updatedAt, null);
  await stores.compareAndSet(storesValue('2026-09-22T00:00:00.000Z'), { expectedRevision: '1', commandId: C2 });
  assert.equal((await core.publicStores())[0].updatedAt, '2026-09-22T00:00:00.000Z');
  assert.equal(await core.publicSnapshot('2'), null); assert.equal(await core.hasStore('2'), false);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: imported normalized snapshot and CAS registry are read fresh', { skip: !integrationUrl }, async t => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /test/iu);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 3 });
  const schema = `core_test_${crypto.randomBytes(8).toString('hex')}`, directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-core-import-')); let owned = false, marketOwned = false;
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  try {
    assert.equal((await pool.query("SELECT to_regnamespace('pult_market') AS name")).rows[0].name, null);
    await pool.query(require('../storage/postgres-market-schema.cjs')); marketOwned = true;
    await pool.query(require('../storage/postgres-schema.cjs').replaceAll('pult', schema)); owned = true;
    await pool.query(require('../storage/postgres-document-schema.cjs').replaceAll('pult', schema));
    await fs.writeFile(path.join(directory, 'stores.json'), JSON.stringify(storesValue()));
    await fs.writeFile(path.join(directory, 'data-1.json'), JSON.stringify(raw));
    await require('../storage/postgres-market-import.cjs').importMarket({ pool, sourceDir: directory });
    const stateStore = require('../storage/postgres-state.cjs').createStateStore({ pool, schema }), stores = createStores({ stateStore });
    await stores.compareAndSet(storesValue(), { expectedRevision: '0', commandId: C1 });
    const market = require('../storage/postgres-market-repository.cjs').createMarketRepository({ pool });
    const core = createCore({ storesRepository: stores, marketRepository: market, stateStore });
    assert.equal((await core.publicSnapshot('1')).products[0].name, 'Болт');
    await stores.compareAndSet(storesValue('2026-09-22T00:00:00.000Z'), { expectedRevision: '1', commandId: C2 });
    assert.equal((await core.publicStores())[0].updatedAt, '2026-09-22T00:00:00.000Z');
  } finally {
    if (marketOwned) await pool.query('DROP SCHEMA pult_market CASCADE');
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
