'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createMarketWriter } = require('../storage/postgres-market-writer.cjs');
const { sourceKey } = require('../storage/postgres-document-import.cjs');

const C1 = '11111111-1111-4111-8111-111111111111', C2 = '22222222-2222-4222-8222-222222222222', C3 = '33333333-3333-4333-8333-333333333333';
const snapshot = (name, quantity = 1) => ({
  store: 'Synthetic', clientId: '1', completedAt: '2026-09-22T10:00:00.000Z', sections: { stocks: { ok: true } },
  products: [{ product_id: 10, sku: 20, offer_id: 'A', name }],
  stocks: [{ product_id: 10, stocks: [{ sku: 20, warehouse: 'W', present: quantity, reserved: 0 }] }],
  operations: [{ operation_id: 30, date: '2026-09-22', operation_type: 'Sale', posting: { products: [{ sku: 20, quantity }] } }],
  stockRows: [], categoryTree: []
});

test('writer validates identity before SQL and copies caller bytes before the first await', async () => {
  let captured;
  const stateStore = { async writeWithProjection(key, bytes, options) { captured = { key, bytes, options }; return { revision: '1', replayed: true, result: { snapshotId: C1 } }; } };
  const writer = createMarketWriter({ stateStore }), bytes = Buffer.from(JSON.stringify(snapshot('A')));
  const pending = writer.publish({ storeId: '1', exactBytes: bytes, expectedRevision: '0', commandId: C1 }); bytes.fill(0);
  assert.equal((await pending).snapshotId, C1); assert.equal(captured.bytes[0], 123);
  assert.equal(captured.key, sourceKey('data-1.json')); assert.equal(captured.options.sourceMapping.domain, 'market-snapshots');
  await assert.rejects(writer.publish({ storeId: '2', exactBytes: Buffer.from(JSON.stringify(snapshot('A'))), expectedRevision: '0', commandId: C2 }), { code: 'STORE_MISMATCH' });
  await assert.rejects(writer.publish({ storeId: '1', exactBytes: Buffer.from('{"clientId":"1","unknown":[]}'), expectedRevision: '0', commandId: C2 }), { code: 'UNHANDLED_SOURCE_ARRAY' });
});

test('writer preserves OUTCOME_UNKNOWN and never performs a hidden retry', async () => {
  let calls = 0;
  const writer = createMarketWriter({ stateStore: { async writeWithProjection() { calls++; throw Object.assign(Error('safe'), { code: 'OUTCOME_UNKNOWN' }); } } });
  await assert.rejects(writer.publish({ storeId: '1', exactBytes: Buffer.from(JSON.stringify(snapshot('A'))), expectedRevision: '0', commandId: C1 }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(calls, 1);
});

test('command receipt exposes the durable before revision for acquisition replay checks', async () => {
  const bytes = Buffer.from(JSON.stringify(snapshot('Committed'))), writer = createMarketWriter({ stateStore: { async readCommand() { return { before: { revision: '7' }, after: { revision: '8', content: bytes }, result: { snapshotId: C1 } }; }, async writeWithProjection() { throw Error('unused'); } } });
  const receipt = await writer.readCommand({ storeId: '1', commandId: C1 }); assert.equal(receipt.beforeRevision, '7'); assert.equal(receipt.revision, '8'); assert.deepEqual(receipt.exactBytes, bytes);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
const restrictedUrl = process.env.PULT_TEST_RESTRICTED_DATABASE_URL;
test('PostgreSQL restricted role: projection and replay use source_files SELECT/INSERT only', { skip: !integrationUrl || !restrictedUrl }, async () => {
  const {Pool}=require('pg'),owner=new Pool({connectionString:integrationUrl}),restricted=new Pool({connectionString:restrictedUrl}),stateSchema=`writer_restricted_${crypto.randomBytes(8).toString('hex')}`,marketSchema=`market_restricted_${crypto.randomBytes(8).toString('hex')}`,role=(await restricted.query('SELECT current_user AS role')).rows[0].role;
  try{await owner.query(require('../storage/postgres-schema.cjs').replaceAll('pult',stateSchema));await owner.query(require('../storage/postgres-document-schema.cjs').replaceAll('pult',stateSchema));await owner.query(require('../storage/postgres-market-schema.cjs').replaceAll('pult_market',marketSchema));await owner.query(`INSERT INTO "${marketSchema}".stores(store_id,market,display_name) VALUES('1','Ozon','Synthetic')`);await owner.query(`GRANT USAGE ON SCHEMA "${stateSchema}","${marketSchema}" TO "${role}"; GRANT SELECT,INSERT,UPDATE ON "${stateSchema}".document_states,"${stateSchema}".commands TO "${role}"; GRANT SELECT,INSERT ON "${stateSchema}".source_files TO "${role}"; REVOKE UPDATE,DELETE ON "${stateSchema}".source_files FROM "${role}"; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA "${marketSchema}" TO "${role}"; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${marketSchema}" TO "${role}"`);const stateStore=require('../storage/postgres-state.cjs').createStateStore({pool:restricted,schema:stateSchema}),writer=createMarketWriter({stateStore,schema:marketSchema}),bytes=Buffer.from(JSON.stringify(snapshot('Restricted'))),first=await writer.publish({storeId:'1',exactBytes:bytes,expectedRevision:'0',commandId:C1});assert.equal(first.replayed,false);assert.deepEqual(await writer.publish({storeId:'1',exactBytes:bytes,expectedRevision:'0',commandId:C1}),{...first,replayed:true});}finally{await restricted.end();await owner.query(`DROP SCHEMA IF EXISTS "${marketSchema}" CASCADE; DROP SCHEMA IF EXISTS "${stateSchema}" CASCADE`);await owner.end();}
});
test('PostgreSQL integration: document command and normalized current pointer commit atomically', { skip: !integrationUrl }, async () => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /test/iu);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 4 });
  const stateSchema = `writer_${crypto.randomBytes(8).toString('hex')}`; let marketOwned = false, stateOwned = false;
  try {
    assert.equal((await pool.query("SELECT to_regnamespace('pult_market') AS name")).rows[0].name, null);
    await pool.query(require('../storage/postgres-market-schema.cjs')); marketOwned = true;
    await pool.query(require('../storage/postgres-schema.cjs').replaceAll('pult', stateSchema)); stateOwned = true;
    await pool.query(require('../storage/postgres-document-schema.cjs').replaceAll('pult', stateSchema));
    await pool.query(`INSERT INTO pult_market.stores(store_id,market,display_name) VALUES('1','Ozon','Synthetic')`);
    const stateStore = require('../storage/postgres-state.cjs').createStateStore({ pool, schema: stateSchema });
    const writer = createMarketWriter({ stateStore }), firstBytes = Buffer.from(JSON.stringify(snapshot('First'))), secondBytes = Buffer.from(JSON.stringify(snapshot('Second', 2)));
    const first = await writer.publish({ storeId: '1', exactBytes: firstBytes, expectedRevision: '0', commandId: C1 });
    assert.equal(first.revision, '1'); assert.equal(first.replayed, false);
    const document = await stateStore.read(sourceKey('data-1.json')); assert.deepEqual(document.content, firstBytes);
    const mapping = (await pool.query(`SELECT baseline_present FROM "${stateSchema}".source_files WHERE source_path='data-1.json'`)).rows[0]; assert.equal(mapping.baseline_present, false);
    const market = require('../storage/postgres-market-repository.cjs').createMarketRepository({ pool });
    assert.deepEqual(await market.getSnapshot('1'), snapshot('First'));

    const second = await writer.publish({ storeId: '1', exactBytes: secondBytes, expectedRevision: '1', commandId: C2 });
    assert.equal(second.revision, '2'); assert.notEqual(second.snapshotId, first.snapshotId); assert.deepEqual(await market.getSnapshot('1'), snapshot('Second', 2));
    assert.deepEqual(await writer.publish({ storeId: '1', exactBytes: firstBytes, expectedRevision: '0', commandId: C1 }), { revision: '1', replayed: true, snapshotId: first.snapshotId });
    await assert.rejects(writer.publish({ storeId: '1', exactBytes: secondBytes, expectedRevision: '0', commandId: C1 }), { code: 'COMMAND_ID_REUSED' });
    const thirdBytes = Buffer.from(JSON.stringify(snapshot('Third')));
    await assert.rejects(writer.publish({ storeId: '1', exactBytes: thirdBytes, expectedRevision: '1', commandId: C3 }), { code: 'REVISION_CONFLICT' });

    await pool.query('UPDATE pult_market.current_snapshots SET snapshot_id=$1 WHERE store_id=$2', [first.snapshotId, '1']);
    await assert.rejects(writer.publish({ storeId: '1', exactBytes: thirdBytes, expectedRevision: '2', commandId: C3 }), { code: 'DATABASE_ERROR' });
    assert.equal((await stateStore.read(sourceKey('data-1.json'))).revision, '2');
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM "${stateSchema}".commands`)).rows[0].count, 2);
    await pool.query('UPDATE pult_market.current_snapshots SET snapshot_id=$1 WHERE store_id=$2', [second.snapshotId, '1']);
    const third = await writer.publish({ storeId: '1', exactBytes: thirdBytes, expectedRevision: '2', commandId: C3 });
    assert.equal(third.revision, '3'); assert.deepEqual(await market.getSnapshot('1'), snapshot('Third'));
  } finally {
    if (marketOwned) await pool.query('DROP SCHEMA pult_market CASCADE');
    if (stateOwned) await pool.query(`DROP SCHEMA "${stateSchema}" CASCADE`);
    await pool.end();
  }
});
