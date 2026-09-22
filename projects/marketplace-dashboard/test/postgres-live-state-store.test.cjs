'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createLiveStateStore } = require('../storage/postgres-live-state-store.cjs');
const { createLiveSources } = require('../storage/postgres-live-sources.cjs');
const { createPostgresLiveRepository } = require('../storage/postgres-live-repository.cjs');
const { ensurePostgresLiveSchema } = require('../storage/postgres-live-schema.cjs');
const { createJsonDocumentRepository, encodeJson } = require('../storage/postgres-json-repository.cjs');
const { sourceKey } = require('../storage/postgres-document-import.cjs');
const { classify } = require('../storage/source-inventory.cjs');
const { requestHash } = require('../storage/postgres-state.cjs');
const store = () => BigInt('0x' + crypto.randomBytes(8).toString('hex')).toString();
const hasCode = code => error => error.code === code;
function legacy() {
  const calls = [], result = { revision: 'legacy' };
  const state = Object.fromEntries(['read', 'write', 'readCommand', 'remove', 'writeWithEffect', 'writeWithProjection', 'writeStoreRegistry'].map(method => [method, async (...args) => { calls.push({ method, args }); return result; }]));
  state.list = async options => { calls.push({ method: 'list', args: [options] }); return []; };
  return { ...state, calls, result };
}

test('known missing native sources never fall back and non-market registries delegate', async () => {
  const old = legacy(), sourcePath = 'costs-17.json';
  const sources = { document() {}, record: async () => null, listSources: async () => [], repository: { readCommand() {} } };
  const state = createLiveStateStore({ legacyStateStore: old, sources, sourcePaths: [sourcePath, 'stores.json'] });
  assert.equal(await state.read(sourceKey(sourcePath)), null); assert.equal(old.calls.length, 0);
  assert.equal(await state.read(sourceKey('stores.json')), old.result);
  const options = { commandId: 'legacy-command' };
  assert.equal(await state.remove('business/registry', options), old.result);
  assert.equal(old.calls.at(-1).args[1], options);
  await assert.rejects(state.remove(sourceKey(sourcePath), options), hasCode('UNSUPPORTED_LIVE_OPERATION'));
  await assert.rejects(state.writeWithProjection(sourceKey(sourcePath), Buffer.from('{}'), options, () => {}), hasCode('UNSUPPORTED_LIVE_OPERATION'));
});

test('state compatibility bridge works through real native SQL without legacy marketplace bytes', { skip: !process.env.PULT_TEST_DATABASE_URL }, async t => {
  const { Pool } = require('pg'), pool = new Pool({ connectionString: process.env.PULT_TEST_DATABASE_URL, max: 3 });
  t.after(() => pool.end()); await ensurePostgresLiveSchema(pool);
  const repository = createPostgresLiveRepository({ pool }), sources = createLiveSources({ repository });

  await t.test('existing JSON repository gets string revisions, verified transient buffers and exact historical replay', async () => {
    const old = legacy(), sourcePath = `costs-${store()}.json`, logicalKey = sourceKey(sourcePath), state = createLiveStateStore({ legacyStateStore: old, sources, sourcePaths: [sourcePath] });
    const doc = createJsonDocumentRepository({ stateStore: state, logicalKey, sourcePath, validate: value => Array.isArray(value.items) });
    const first = { items: [{ product_id: 1, cost: 0 }] }, second = { items: [{ product_id: 2, cost: 20 }] }, firstId = crypto.randomUUID(), secondId = crypto.randomUUID();
    assert.equal(await doc.read(), null);
    assert.deepEqual(await doc.compareAndSet(first, { expectedRevision: '0', commandId: firstId }), { revision: '1', replayed: false });
    assert.deepEqual((await doc.read()).value, first);
    await doc.compareAndSet(second, { expectedRevision: '1', commandId: secondId });
    assert.deepEqual(await doc.compareAndSet(first, { expectedRevision: '0', commandId: firstId }), { revision: '1', replayed: true });
    const historical = await doc.readCommand(firstId);
    assert.equal(historical.before.absent, true); assert.deepEqual(historical.after.value, first);
    const secondCommand = await doc.readCommand(secondId); assert.deepEqual(secondCommand.before.value, first); assert.deepEqual(secondCommand.after.value, second);
    const raw = await state.read(logicalKey); assert.ok(Buffer.isBuffer(raw.content)); assert.ok(Buffer.isBuffer(raw.sha256)); assert.equal(raw.revision, '2');
    assert.equal(raw.sha256.toString('hex'), crypto.createHash('sha256').update(raw.content).digest('hex'));
    assert.equal(old.calls.length, 0);
    const restarted = createLiveStateStore({ legacyStateStore: old, sources });
    assert.deepEqual(JSON.parse((await restarted.read(logicalKey)).content), second);
    assert.equal(old.calls.length, 0);
  });

  await t.test('write learns explicit mapping and fingerprints original bytes while returns canonical bytes', async () => {
    const old = legacy(), sourcePath = `costs-${store()}.json`, key = sourceKey(sourcePath), state = createLiveStateStore({ legacyStateStore: old, sources });
    const content = Buffer.from('{ "items" : [ {"cost":0,"product_id":7} ] }');
    const options = { expectedRevision: '0', commandId: crypto.randomUUID(), mediaType: 'application/json', sourceMapping: { sourcePath, logicalKey: key, domain: classify(sourcePath).domain, mediaType: 'application/json' } };
    await state.write(key, content, options);
    const recorded = await state.readCommand(key, options.commandId, { operation: 'write' });
    assert.ok(recorded.requestHash.equals(requestHash('write', key, '0', 'application/json', content)));
    assert.ok(recorded.after.content.equals(encodeJson(JSON.parse(content))));
    assert.equal(recorded.before.deleted, null); assert.equal(recorded.before.mediaType, null);
    assert.deepEqual(await state.write(key, content, options), { revision: '1', replayed: true });
    await assert.rejects(state.write(key, encodeJson(JSON.parse(content)), options), hasCode('COMMAND_ID_REUSED'));
    assert.equal(old.calls.length, 0);
  });

  await t.test('listing filters old marketplace identities before loading legacy content', async () => {
    const old = legacy(), sourcePath = `costs-${store()}.json`, key = sourceKey(sourcePath), registryKey = sourceKey('ideas.json');
    await sources.document(sourcePath).compareAndSet({ items: [] }, { expectedRevision: '0', commandId: crypto.randomUUID() });
    old.list = async options => { assert.equal(options.includeContent, false); return [{ logicalKey: key }, { logicalKey: registryKey, revision: '1' }]; };
    old.read = async requested => { old.calls.push({ method: 'read', requested }); assert.equal(requested, registryKey); return { logicalKey: requested, revision: '1', content: Buffer.from('{}') }; };
    // Other suites deliberately corrupt their own rows; this list fixture owns
    // only the source under test and must not repair or consume their data.
    const scopedSources = { ...sources, listSources: async () => (await sources.listSources()).filter(row => row.sourcePath === sourcePath) };
    const state = createLiveStateStore({ legacyStateStore: old, sources: scopedSources, sourcePaths: [sourcePath, 'ideas.json'] });
    const metadata = await state.list({ includeContent: false });
    assert.equal(metadata.filter(row => row.logicalKey === key).length, 1); assert.equal(old.calls.length, 0);
    const listed = await state.list();
    assert.equal(listed.filter(row => row.logicalKey === key).length, 1); assert.equal(old.calls.length, 1);
  });
});
