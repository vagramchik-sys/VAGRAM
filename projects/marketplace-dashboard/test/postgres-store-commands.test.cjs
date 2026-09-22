'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPostgresStoreCommands, KEY, WB_ID, derivedCommandId } = require('../storage/domains/postgres-store-commands.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
const C1 = '11111111-1111-4111-8111-111111111111', C2 = '22222222-2222-4222-8222-222222222222';
function memory({ unknown } = {}) { let record = null; const commands = new Map(); return { commands, async read() { return record; }, async readCommand(_key, id) { return commands.get(id) || null; }, async writeStoreRegistry(key, content, options) { assert.equal(key, KEY); const prior = commands.get(options.commandId); if (prior) return { revision: prior.after.revision, replayed: true, result: prior.result }; const actual = record?.revision || '0'; if (actual !== options.expectedRevision) throw Object.assign(Error(), { code: 'REVISION_CONFLICT' }); const before = record || { revision: '0', content: null, mediaType: null, deleted: null }, after = { revision: String(BigInt(actual) + 1n), content: Buffer.from(content), mediaType: 'application/json', sha256: digest(content), deleted: false }; const result = { ...options.intent }; record = after; commands.set(options.commandId, { before, after, result }); if (unknown === options.commandId) { unknown = null; throw Object.assign(Error('canary'), { code: 'OUTCOME_UNKNOWN' }); } return { revision: after.revision, replayed: false, result }; } }; }
function fixture(options = {}) { const state = memory(options), calls = [], api = createPostgresStoreCommands({ stateStore: state, protect: async (value, decrypt) => { calls.push(['protect', decrypt]); return decrypt ? value.slice(4) : `enc:${value}`; }, ozonApi: async (...args) => calls.push(['ozon', ...args]), wbApi: async (...args) => calls.push(['wb', ...args]), scheduleSync: async value => calls.push(['schedule', value]) }); return { state, calls, api }; }
const op = (commandId, expectedRevision, timestamp = '2026-09-22T10:00:00.000Z') => ({ commandId, expectedRevision, timestamp });

test('provisional SQL connection receives protected key and persists only after verification',async()=>{
 const state=memory(),order=[],ozonApi=Object.assign(async()=>{assert.fail('ordinary Node transport forbidden')},{verifyConnection:async(store,key)=>{order.push('verify');assert.equal(store.clientId,'1');assert.equal(key,'protected-opaque')}});
 const api=createPostgresStoreCommands({stateStore:state,protect:async()=>{order.push('protect');return'protected-opaque'},ozonApi,wbApi:async()=>{},scheduleSync:async()=>order.push('schedule')});
 await api.connectOzon({name:'SK',clientId:'1',key:'synthetic-credential-12345'},op(C1,'0'));
 assert.deepEqual(order,['protect','verify','schedule']);assert.equal(state.commands.size,1);
 const rejected=memory();ozonApi.verifyConnection=async()=>{throw Error('rejected')};
 const bad=createPostgresStoreCommands({stateStore:rejected,protect:async()=> 'protected-opaque',ozonApi,wbApi:async()=>{}});
 await assert.rejects(bad.connectOzon({name:'SK',clientId:'1',key:'synthetic-credential-12345'},op(C2,'0')),{code:'UPSTREAM_REJECTED'});assert.equal(rejected.commands.size,0);
});

test('Ozon connect protects the credential and exact replay survives later registry writes', async () => { const f = fixture(), key = 'synthetic-credential-12345'; const first = await f.api.connectOzon({ name: 'SK', clientId: '1', key }, op(C1, '0')); assert.equal(first.storeId, '1'); assert.equal(first.revision, '1'); assert.equal(JSON.stringify(f.state.commands.get(C1)).includes(key), false); assert.equal(f.calls.find(row => row[0] === 'schedule')[1].commandId, derivedCommandId(C1)); assert.notEqual(derivedCommandId(C1), C1); await f.api.sync({ storeId: '1' }, op(C2, '1', '2026-09-22T10:01:00.000Z')); const external = f.calls.filter(row => row[0] === 'ozon').length, replay = await f.api.connectOzon({ name: 'SK', clientId: '1', key }, op(C1, '0')); assert.equal(replay.replayed, true); assert.equal(replay.revision, '1'); assert.equal(f.calls.filter(row => row[0] === 'ozon').length, external); await assert.rejects(f.api.connectOzon({ name: 'SK', clientId: '1', key: `${key}x` }, op(C1, '0')), { code: 'COMMAND_ID_REUSED' }); await assert.rejects(f.api.connectOzon({ name: 'СтальКрепеж', clientId: '1', key }, op(C1, '0')), { code: 'COMMAND_ID_REUSED' }); });

test('WB validation matches legacy identity and unknown commit resolves with the same command', async () => { const f = fixture({ unknown: C1 }), key = 'w'.repeat(60); await assert.rejects(f.api.connectWb({ key }, op(C1, '0')), { code: 'OUTCOME_UNKNOWN' }); const before = f.calls.filter(row => row[0] === 'wb').length, result = await f.api.connectWb({ key }, op(C1, '0')); assert.equal(result.storeId, WB_ID); assert.equal(result.replayed, true); assert.equal(f.calls.filter(row => row[0] === 'wb').length, before); });

test('disconnect removes only the active registry entry and stale CAS fails', async () => { const f = fixture(), key = 'synthetic-credential-12345'; await f.api.connectOzon({ name: 'SK', clientId: '1', key }, op(C1, '0')); await assert.rejects(f.api.disconnect({ storeId: '1' }, op(C2, '0')), { code: 'REVISION_CONFLICT' }); const result = await f.api.disconnect({ storeId: '1' }, op(C2, '1')); assert.equal(result.operation, 'disconnect'); const registry = JSON.parse(f.state.commands.get(C2).after.content); assert.equal(Object.hasOwn(registry, '1'), false); });
test('concurrent same-command calls serialize before credential protection', async () => { let release; const gate = new Promise(resolve => { release = resolve; }), state = memory(), calls = []; const api = createPostgresStoreCommands({ stateStore: state, protect: async (value, decrypt) => decrypt ? value.slice(4) : `enc:${value}`, ozonApi: async () => { calls.push('api'); await gate; }, wbApi: async () => {}, scheduleSync: async () => {} }), input = { name: 'SK', clientId: '1', key: 'synthetic-credential-12345' }, first = api.connectOzon(input, op(C1, '0')), second = api.connectOzon(input, op(C1, '0')); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 1); release(); const values = await Promise.all([first, second]); assert.equal(values[1].replayed, true); assert.equal(calls.length, 1); });

test('registry bytes are verified before API, credential protection, or writes', async () => {
  for (const record of [
    { revision: '1', mediaType: 'application/json', content: Buffer.from('{}'), sha256: Buffer.alloc(32) },
    { revision: '1', mediaType: 'application/json', content: Buffer.from([0xc3, 0x28]), sha256: digest(Buffer.from([0xc3, 0x28])) }
  ]) {
    const calls = [], stateStore = { read: async () => record, readCommand: async () => null, writeStoreRegistry: async () => { calls.push('write'); } };
    const api = createPostgresStoreCommands({ stateStore, protect: async () => { calls.push('protect'); }, ozonApi: async () => { calls.push('api'); }, wbApi: async () => {}, scheduleSync: async () => {} });
    await assert.rejects(api.sync({ storeId: '1' }, op(C1, '1')), { code: 'DATA_INTEGRITY' });
    assert.deepEqual(calls, []);
  }
});

test('journal after-image is verified before replay credential decryption', async () => {
  const calls = [], content = Buffer.from(JSON.stringify({ '1': { name: 'SK', clientId: '1', key: 'enc:synthetic-credential-12345' } }));
  const stateStore = { read: async () => null, readCommand: async () => ({ before: { revision: '0' }, after: { revision: '1', mediaType: 'application/json', content, sha256: Buffer.alloc(32) }, result: { operation: 'connect-ozon', storeId: '1', timestamp: '2026-09-22T10:00:00.000Z' } }), writeStoreRegistry: async () => { calls.push('write'); } };
  const api = createPostgresStoreCommands({ stateStore, protect: async () => { calls.push('protect'); }, ozonApi: async () => { calls.push('api'); }, wbApi: async () => {}, scheduleSync: async () => {} });
  await assert.rejects(api.connectOzon({ name: 'SK', clientId: '1', key: 'synthetic-credential-12345' }, op(C1, '0')), { code: 'DATA_INTEGRITY' });
  assert.deepEqual(calls, []);
});

test('queued commands detach caller input and metadata synchronously', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }), state = memory(), seen = [];
  const api = createPostgresStoreCommands({ stateStore: state, protect: async (value, decrypt) => decrypt ? value.slice(4) : `enc:${value}`, ozonApi: async ({ clientId }) => { seen.push(clientId); if (clientId === '1') await gate; }, wbApi: async () => {}, scheduleSync: async () => {} });
  const first = api.connectOzon({ name: 'SK', clientId: '1', key: 'synthetic-credential-12345' }, op(C1, '0'));
  const input = { name: 'SK', clientId: '1', key: 'synthetic-credential-12345' }, meta = op(C1, '0');
  const second = api.connectOzon(input, meta); input.key = 'changed-after-call-credential'; meta.expectedRevision = '999';
  await new Promise(resolve => setImmediate(resolve)); release();
  const [, replay] = await Promise.all([first, second]); assert.equal(replay.replayed, true); assert.deepEqual(seen, ['1']);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL, restrictedUrl = process.env.PULT_TEST_RESTRICTED_DATABASE_URL;
test('PostgreSQL restricted role atomically projects registry and disconnect preserves snapshot history', { skip: !integrationUrl || !restrictedUrl }, async t => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /^pult_test_/u);
  const { Pool } = require('pg'), owner = new Pool({ connectionString: integrationUrl }), restricted = new Pool({ connectionString: restrictedUrl }), suffix = crypto.randomBytes(6).toString('hex'), stateSchema = `stores_state_${suffix}`, marketSchema = `stores_market_${suffix}`, role = decodeURIComponent(new URL(restrictedUrl).username); let owned = false;
  t.after(async () => { await restricted.end(); if (owned) { await owner.query(`DROP SCHEMA IF EXISTS "${marketSchema}" CASCADE`); await owner.query(`DROP SCHEMA IF EXISTS "${stateSchema}" CASCADE`); } await owner.end(); });
  await owner.query(require('../storage/postgres-schema.cjs').replaceAll('pult', stateSchema)); await owner.query(require('../storage/postgres-document-schema.cjs').replaceAll('pult', stateSchema)); const marketSql = require('../storage/postgres-market-schema.cjs').replaceAll('pult_market', marketSchema); await owner.query(marketSql); await owner.query(marketSql); owned = true;
  await owner.query(`GRANT USAGE ON SCHEMA "${stateSchema}","${marketSchema}" TO "${role}"; GRANT SELECT,INSERT,UPDATE ON "${stateSchema}".document_states,"${stateSchema}".commands TO "${role}"; GRANT SELECT,INSERT ON "${stateSchema}".source_files TO "${role}"; REVOKE UPDATE,DELETE ON "${stateSchema}".source_files FROM "${role}"; GRANT SELECT,INSERT,UPDATE ON "${marketSchema}".stores TO "${role}"; REVOKE DELETE ON "${marketSchema}".stores FROM "${role}"`);
  const stateStore = require('../storage/postgres-state.cjs').createStateStore({ pool: restricted, schema: stateSchema, marketSchema }), calls = [], service = createPostgresStoreCommands({ stateStore, protect: async (value, decrypt) => decrypt ? value.slice(4) : `enc:${value}`, ozonApi: async () => calls.push('ozon'), wbApi: async () => {}, scheduleSync: async () => {} }), key = 'synthetic-credential-12345';
  const first = await service.connectOzon({ name: 'SK', clientId: '1', key }, op(C1, '0')); assert.equal(first.revision, '1');
  let normalized = (await owner.query(`SELECT connected,registry_row,registry_revision::text AS revision FROM "${marketSchema}".stores WHERE store_id='1'`)).rows[0]; assert.equal(normalized.connected, true); assert.equal(normalized.revision, '1'); assert.equal(JSON.stringify(normalized.registry_row).includes('key'), false); assert.equal(JSON.stringify(normalized.registry_row).includes('enc:'), false);
  const doc = (await owner.query(`INSERT INTO "${marketSchema}".source_documents(logical_name,sha256,exact_bytes,byte_length) VALUES('fixture',decode(repeat('00',32),'hex'),'{}',2) RETURNING source_document_id`)).rows[0]; await owner.query(`INSERT INTO "${marketSchema}".snapshot_versions(snapshot_id,store_id,source_document_id,source_sha256,source_byte_length,source_metadata,source_array_presence,expected_counts,complete) VALUES($1,'1',$2,decode(repeat('00',32),'hex'),2,'{}','{}','{}',true)`, [crypto.randomUUID(), doc.source_document_id]);
  await service.disconnect({ storeId: '1' }, op(C2, '1')); normalized = (await owner.query(`SELECT connected,registry_row FROM "${marketSchema}".stores WHERE store_id='1'`)).rows[0]; assert.equal(normalized.connected, false); assert.deepEqual(normalized.registry_row, { clientId: '1', market: 'Ozon' }); assert.equal((await owner.query(`SELECT count(*)::int AS count FROM "${marketSchema}".snapshot_versions WHERE store_id='1'`)).rows[0].count, 1);
  const replay = await service.connectOzon({ name: 'SK', clientId: '1', key }, op(C1, '0')); assert.equal(replay.replayed, true); assert.equal(calls.length, 1);
  await owner.query(`CREATE FUNCTION "${marketSchema}".reject_store() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.display_name='СтальКрепеж' THEN RAISE EXCEPTION 'projection canary'; END IF; RETURN NEW; END$$; CREATE TRIGGER reject_store BEFORE INSERT OR UPDATE ON "${marketSchema}".stores FOR EACH ROW EXECUTE FUNCTION "${marketSchema}".reject_store()`);
  await assert.rejects(service.connectOzon({ name: 'СтальКрепеж', clientId: '2', key }, op(crypto.randomUUID(), '2')), error => error.code === 'DATABASE_ERROR'); const record = await stateStore.read(KEY); assert.equal(record.revision, '2'); assert.equal((await owner.query(`SELECT count(*)::int AS count FROM "${marketSchema}".stores WHERE store_id='2'`)).rows[0].count, 0);
});
