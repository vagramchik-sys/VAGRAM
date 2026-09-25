'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { LIVE_SCHEMA_SQL, ensurePostgresLiveSchema } = require('../storage/postgres-live-schema.cjs');
const { createPostgresLiveRepository, LiveRepositoryError } = require('../storage/postgres-live-repository.cjs');

const id = () => ({ storeId: 'live-test:' + crypto.randomUUID(), domain: 'market' });
const record = (entityKey, businessDay, value, sourceOrder) => ({ entityKey, businessDay, value, ...(sourceOrder == null ? {} : { sourceOrder }) });
const all = (rows, entityType = 'operations') => ({ entityType, scope: { kind: 'all' }, rows });
const days = (rows, fromDay, toDay = fromDay, entityType = 'operations') => ({ entityType, scope: { kind: 'days', fromDay, toDay }, rows });
const command = (identity, commandId, expectedRevision, partitions, extra = {}) => ({ ...identity, commandId, expectedRevision, partitions, ...extra });
const code = expected => error => error instanceof LiveRepositoryError && error.code === expected && error.message === expected && !error.cause;

test('native schema contains individual facts, bounded heads and immutable row journal', () => {
  assert.match(LIVE_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS pult_live\.facts/u);
  assert.match(LIVE_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS pult_live\.daily_sales_targets/u);
  assert.match(LIVE_SCHEMA_SQL, /PRIMARY KEY\(business_day,scope_type,scope_id\)/u);
  assert.match(LIVE_SCHEMA_SQL, /amount_cents bigint NOT NULL CHECK\(amount_cents>=0/u);
  assert.match(LIVE_SCHEMA_SQL, /time_zone text NOT NULL DEFAULT 'Europe\/Moscow'/u);
  assert.match(LIVE_SCHEMA_SQL, /GRANT SELECT,INSERT,UPDATE ON pult_live\.daily_sales_targets TO pult_app/u);
  assert.match(LIVE_SCHEMA_SQL, /GRANT SELECT,INSERT,UPDATE,DELETE ON pult_live\.daily_sales_targets TO pult_importer/u);
  assert.match(LIVE_SCHEMA_SQL, /business_day date/u);
  assert.match(LIVE_SCHEMA_SQL, /BEFORE UPDATE OR DELETE ON pult_live\.commands/u);
  assert.match(LIVE_SCHEMA_SQL, /BEFORE UPDATE OR DELETE ON pult_live\.record_journal/u);
  assert.doesNotMatch(LIVE_SCHEMA_SQL, /bytea|snapshot_id|exact_bytes|generation_id|source_documents/u);
  assert.match(LIVE_SCHEMA_SQL, /REVOKE ALL ON SCHEMA pult_live FROM PUBLIC/u);
});

test('invalid or lossy command values fail before connecting', async () => {
  let connects = 0;
  const repo = createPostgresLiveRepository({ pool: { async connect() { connects++; throw new Error('must not connect'); } } });
  const base = command(id(), 'first', 0, [all([record('x', null, { price: 0 })])]);
  const cases = [
    [{ ...base, storeId: 'bad\u0000id' }, 'INVALID_ARGUMENT'],
    [{ ...base, domain: 'unsupported' }, 'INVALID_ARGUMENT'],
    [{ ...base, expectedRevision: -1 }, 'INVALID_ARGUMENT'],
    [{ ...base, commandId: '' }, 'INVALID_ARGUMENT'],
    [{ ...base, metadata: { rows: [] } }, 'INVALID_ARGUMENT'],
    [{ ...base, metadata: { tooLarge: 'x'.repeat(65536) } }, 'METADATA_TOO_LARGE'],
    [{ ...base, sourceMetadata: { tooLarge: 'x'.repeat(16384) } }, 'METADATA_TOO_LARGE'],
    [{ ...base, partitions: [all([record('x', null, { value: undefined })])] }, 'INVALID_ARGUMENT'],
    [{ ...base, partitions: [all([record('x', null, { value: NaN })])] }, 'INVALID_ARGUMENT'],
    [{ ...base, partitions: [all([record('x', null, { value: new Date() })])] }, 'INVALID_ARGUMENT'],
    [{ ...base, partitions: [all([record('x', '2026-02-30', {})])] }, 'INVALID_ARGUMENT'],
    [{ ...base, partitions: [all([{ ...record('x', null, {}), occurrence: 0 }, { ...record('x', null, {}), occurrence: 0 }])] }, 'DUPLICATE_ENTITY'],
    [{ ...base, partitions: [all([record('x', null, {}, 0), record('y', null, {}, 0)])] }, 'DUPLICATE_SOURCE_ORDER'],
    [{ ...base, partitions: [all([]), all([])] }, 'DUPLICATE_PARTITION'],
    [{ ...base, partitions: [days([record('x', '2026-01-01', {})], '2026-01-02')] }, 'ROW_OUTSIDE_PARTITION']
  ];
  for (const [value, error] of cases) await assert.rejects(repo.publish(value), code(error));
  await assert.rejects(repo.importComplete({ ...base, expectedRevision: 1 }), code('INVALID_MIGRATION'));
  await assert.rejects(repo.importComplete({ ...base, partitions: [days([], '2026-01-01')] }), code('INVALID_ARGUMENT'));
  for (const options of [{includeTotal:'false'},{after:{}},{after:{sourceOrder:0,entityType:'operations',entityKey:'a',occurrence:-1}},{offset:1,after:{sourceOrder:0,entityType:'operations',entityKey:'a',occurrence:0}},{entityType:'products',after:{sourceOrder:0,entityType:'operations',entityKey:'a',occurrence:0}}]) await assert.rejects(repo.listRows({...id(),...options}),code('INVALID_ARGUMENT'));
  for (const entityTypes of [null, 'operations', ['operations', 'operations'], ['bad type']]) await assert.rejects(repo.readCurrentCollections({...id(),entityTypes}),code('INVALID_ARGUMENT'));
  for (const bundles of [null, [], [{...id(),entityTypes:null}], [{...id(),entityTypes:['operations','operations']}], [{...id(),entityTypes:['bad type']}], [{storeId:'same',domain:'market',entityTypes:[]},{storeId:'same',domain:'market',entityTypes:[]}]]) await assert.rejects(repo.readCurrentBundles(bundles),code('INVALID_ARGUMENT'));
  assert.equal(connects, 0);
});

test('database failures have sanitized messages and release transactions', async () => {
  const statements = [], client = { async query(sql) { statements.push(sql); if (sql.startsWith('SELECT')) throw new Error('password=secret private SQL payload'); return { rows: [] }; }, release() { statements.push('release'); } };
  const repo = createPostgresLiveRepository({ pool: { async connect() { return client; } } });
  await assert.rejects(repo.getHead(id()), code('DATABASE_ERROR'));
  assert.deepEqual(statements.slice(-2), ['ROLLBACK', 'release']);
  const failing = createPostgresLiveRepository({ pool: { async connect() { throw new Error('credentials'); } } });
  await assert.rejects(failing.getHead(id()), code('DATABASE_ERROR'));
});

test('native repository uses a disposable PostgreSQL database', { skip: !process.env.PULT_TEST_DATABASE_URL }, async t => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.PULT_TEST_DATABASE_URL, max: 5 });
  t.after(() => pool.end());
  await ensurePostgresLiveSchema(pool);
  await ensurePostgresLiveSchema(pool);
  const repo = createPostgresLiveRepository({ pool });

  await t.test('keyset pages retain every ordering tie and duplicate occurrence without totals', async () => {
    const identity=id();
    await repo.importComplete(command(identity,'keyset',0,[all([record('dup','2026-01-01',{n:1},0)]),all([record('a',null,{n:4},0)],'products')]));
    // Separate day publications can legitimately have the same source position.
    await repo.publish(command(identity,'keyset-day2',1,[days([{...record('dup','2026-01-02',{n:2},0),occurrence:1}],'2026-01-02')]));
    await repo.publish(command(identity,'keyset-day3',2,[days([record('z','2026-01-03',{n:3},0)],'2026-01-03')]));
    for (const entityType of [undefined,'operations']) {
      const expected=await repo.listRows({...identity,entityType}),actual=[];let after;
      for (let i=0;i<=expected.total;i++) {
        const page=await repo.listRows({...identity,entityType,limit:1,after,includeTotal:false,expectedRevision:3});
        assert.equal(page.total,null);
        if(!page.rows.length)break;
        actual.push(...page.rows);const row=page.rows[0];after={sourceOrder:row.sourceOrder,entityType:row.entityType,entityKey:row.entityKey,occurrence:row.occurrence};
      }
      assert.deepEqual(actual,expected.rows);
      assert.equal((await repo.listRows({...identity,entityType,after})).total,expected.total);
    }
    const first=(await repo.listRows({...identity,limit:1})).rows[0];
    await repo.publish(command(identity,'advanced',3,[]));
    await assert.rejects(repo.listRows({...identity,after:first,includeTotal:false,expectedRevision:3}),code('REVISION_CONFLICT'));
  });

  await t.test('complete import preserves exact duplicates, source ordering and nested record values', async () => {
    const identity = id(), rows = [record('dup', '2026-01-01', { sku: '1', total: 0, items: [{ qty: 0 }], unknown: null }, 2), record('dup', '2026-01-01', { sku: '1', total: 0, items: [{ qty: 0 }], unknown: null }, 0), record('other', null, { sku: '2' }, 1)];
    assert.equal(await repo.getHead(identity), null);
    const input = command(identity, 'import', 0, [all(rows)], { metadata: { arrays: { operations: { present: true } }, unknown: null }, sourceMetadata: { sourceRevision: 4 } });
    const receipt = await repo.importComplete(input);
    assert.equal(receipt.revision, 1); assert.equal(receipt.beforeHead, null);
    assert.deepEqual(receipt.counts, { inserted: 3, updated: 0, deleted: 0, unchanged: 0 });
    assert.deepEqual(receipt.entityCounts, { operations: 3 });
    assert.ok(Object.isFrozen(receipt.metadata.arrays.operations));
    const loaded = await repo.listRows(identity);
    assert.deepEqual(loaded.rows.map(row => row.value), [rows[1].value, rows[2].value, rows[0].value]);
    assert.deepEqual(loaded.rows.map(row => row.occurrence), [1, 0, 0]);
    assert.equal(loaded.total, 3);
    const page = await repo.listRows({ ...identity, limit: 1, offset: 1, expectedRevision: 1 });
    assert.equal(page.rows[0].entityKey, 'other');
    const filtered = await repo.listRows({ ...identity, fromDay: '2026-01-01', toDay: '2026-01-01' });
    assert.equal(filtered.total, 2);
    assert.deepEqual(await repo.readCommand({ ...identity, commandId: 'import' }), receipt);
    assert.deepEqual(await repo.importComplete(input), receipt);
    const asOf = await repo.readAtRevision({ ...identity, revision: 1 });
    assert.deepEqual(asOf.rows, loaded.rows);
    assert.equal((await repo.listHeads({ domain: 'market' })).some(head => head.storeId === identity.storeId), true);
    const shapes = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='pult_live'");
    assert.equal(shapes.rows.some(row => /snapshot|exact_bytes|generation/u.test(row.column_name)), false);
    const commandRow = await pool.query('SELECT receipt FROM pult_live.commands WHERE store_id=$1', [identity.storeId]);
    assert.equal(JSON.stringify(commandRow.rows).includes('"items"'), false);
  });

  await t.test('day partition publication preserves outside history and exact as-of states', async () => {
    const identity = id();
    const oldRows = [record('jan1', '2026-01-01', { amount: 1 }, 0), record('jan2a', '2026-01-02', { amount: 2 }, 1), record('jan2b', '2026-01-02', { amount: 3 }, 2), record('jan3', '2026-01-03', { amount: 4 }, 3)];
    const first = await repo.importComplete(command(identity, 'initial', 0, [all(oldRows)], { metadata: { status: 'old' } }));
    const secondInput = command(identity, 'correct-day', 1, [days([record('jan2a', '2026-01-02', { amount: 20 }, 1), record('jan2c', '2026-01-02', { amount: 5 }, 2)], '2026-01-02')], { metadata: { status: 'corrected' } });
    const second = await repo.publish(secondInput);
    assert.deepEqual(second.counts, { inserted: 1, updated: 1, deleted: 1, unchanged: 0 });
    assert.deepEqual(second.beforeHead, first.afterHead);
    const current = await repo.listRows(identity);
    assert.deepEqual(current.rows.map(row => row.value.amount), [1, 20, 5, 4]);
    assert.deepEqual((await repo.readAtRevision({ ...identity, revision: 1 })).rows.map(row => row.value), oldRows.map(row => row.value));
    assert.deepEqual((await repo.readAtRevision({ ...identity, revision: 2 })).rows, current.rows);
    assert.equal((await repo.readAtRevision({ ...identity, revision: 1 })).head.metadata.status, 'old');
    const correctionHistory = await repo.listJournal({ ...identity, entityKey: 'jan2a' });
    assert.deepEqual(correctionHistory.map(event => [event.action, event.value.amount]), [['insert', 2], ['update', 20]]);
    const deletedHistory = await repo.listJournal({ ...identity, entityKey: 'jan2b' });
    assert.deepEqual(deletedHistory.map(event => [event.action, event.value.amount]), [['insert', 3], ['delete', 3]]);
    assert.deepEqual(await repo.publish(secondInput), second);
    await assert.rejects(repo.publish({ ...secondInput, metadata: { status: 'altered' } }), code('COMMAND_INTENT_CONFLICT'));
    await assert.rejects(repo.listRows({ ...identity, expectedRevision: 1 }), code('REVISION_CONFLICT'));
    await assert.rejects(repo.publish(command(identity, 'stale', 1, [])), code('REVISION_CONFLICT'));
    await assert.rejects(repo.readAtRevision({ ...identity, revision: 9 }), code('REVISION_NOT_FOUND'));
    const empty = await repo.readAtRevision({ ...identity, revision: 0 }); assert.equal(empty.head, null); assert.deepEqual(empty.rows, []);
    const noop = await repo.publish(command(identity, 'noop', 2, secondInput.partitions));
    assert.deepEqual(noop.counts, { inserted: 0, updated: 0, deleted: 0, unchanged: 2 });
    assert.equal((await repo.listJournal({ ...identity, afterRevision: 2 })).length, 0);
    assert.deepEqual((await repo.readAtRevision({ ...identity, revision: 3 })).rows, current.rows);
    assert.deepEqual(await repo.publish(secondInput), second, 'old replay survives later revisions');
  });

  await t.test('cross-range identity collisions roll back every partition and leave no receipt', async () => {
    const identity = id();
    await repo.importComplete(command(identity, 'initial', 0, [all([record('keep', '2026-01-01', { amount: 1 })]), all([record('p', null, { title: 'old' })], 'products')]));
    const invalid = command(identity, 'bad-update', 1, [all([record('p', null, { title: 'new' })], 'products'), days([record('keep', '2026-01-02', { amount: 2 })], '2026-01-02')]);
    await assert.rejects(repo.publish(invalid), code('ENTITY_OUTSIDE_PARTITION'));
    assert.equal((await repo.getHead(identity)).revision, 1);
    assert.equal((await repo.listRows({ ...identity, entityType: 'products' })).rows[0].value.title, 'old');
    assert.equal(await repo.readCommand({ ...identity, commandId: 'bad-update' }), null);
    assert.equal((await repo.listJournal({ ...identity, afterRevision: 1 })).length, 0);
  });

  await t.test('concurrent same-command replay and CAS writers serialize without double events', async () => {
    const identity = id(), input = command(identity, 'same', 0, [all([record('a', null, { a: 1 })])]);
    const receipts = await Promise.all([repo.publish(input), repo.publish(input)]);
    assert.deepEqual(receipts[0], receipts[1]);
    assert.equal((await repo.listJournal(identity)).length, 1);
    const results = await Promise.allSettled([repo.publish(command(identity, 'a', 1, [all([record('a', null, { a: 2 })])])), repo.publish(command(identity, 'b', 1, [all([record('a', null, { a: 3 })])]))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
    assert.equal((await repo.getHead(identity)).revision, 2);
  });

  await t.test('publication detaches caller intent before asynchronous connection', async () => {
    let ready;
    const gate = new Promise(resolve => { ready = resolve; });
    const delayed = createPostgresLiveRepository({ pool: { async connect() { await gate; return pool.connect(); } } });
    const identity = id(), input = command(identity, 'detached', 0, [all([record('a', null, { nested: { amount: 1 } })])], { metadata: { phase: 'original' } });
    const pending = delayed.publish(input);
    input.metadata.phase = 'mutated'; input.partitions[0].rows[0].value.nested.amount = 99; input.partitions.push(all([], 'products'));
    ready();
    const receipt = await pending;
    assert.equal(receipt.metadata.phase, 'original');
    assert.equal((await repo.listRows(identity)).rows[0].value.nested.amount, 1);
  });

  await t.test('canonical intent accepts object key order only and detects row tampering', async () => {
    const identity = id();
    const receipt = await repo.publish(command(identity, 'canonical', 0, [all([record('a', null, { x: 1, y: 2 })])]));
    const replay = await repo.publish(command(identity, 'canonical', 0, [all([record('a', null, { y: 2, x: 1 })])]));
    assert.deepEqual(replay, receipt);
    await pool.query("UPDATE pult_live.facts SET value='{}'::jsonb WHERE store_id=$1", [identity.storeId]);
    await assert.rejects(repo.listRows(identity), code('DATA_INTEGRITY'));
    assert.equal((await repo.readAtRevision({ ...identity, revision: 1 })).rows[0].value.x, 1);
    await assert.rejects(pool.query('UPDATE pult_live.commands SET revision=revision WHERE store_id=$1', [identity.storeId]), error => error.code === '55000');
    await assert.rejects(pool.query('DELETE FROM pult_live.record_journal WHERE store_id=$1', [identity.storeId]), error => error.code === '55000');
  });

  await t.test('bounded UTF-8 batches atomically replace a complete partition and leave no working rows', async () => {
    const identity = id(), batches = [], singleRows = [];
    const watchedPool = { async connect() {
      const client = await pool.connect();
      return { release: () => client.release(), async query(sql, values) {
        if (sql.startsWith('INSERT INTO pult_live.incoming_rows')) {
          if (sql.includes('jsonb_to_recordset')) batches.push(Buffer.byteLength(values[4]));
          else singleRows.push(values[4]);
        }
        return client.query(sql, values);
      } };
    } };
    const batched = createPostgresLiveRepository({ pool: watchedPool, writeBatchBytes: 1024 });
    await batched.importComplete(command(identity, 'initial', 0, [all([record('old', null, { amount: 1 })])]));
    batches.length = 0;
    const rows = Array.from({ length: 24 }, (_, index) => record('row-' + index, '2026-01-02', { id: index, label: 'я'.repeat(150) }, index));
    rows.push(record('large-single', '2026-01-02', { detail: 'x'.repeat(2000) }, rows.length));
    const input = command(identity, 'many-batches', 1, [all(rows)]), receipt = await batched.publish(input);
    assert.ok(batches.length > 2); assert.ok(batches.every(bytes => bytes <= 1024));
    assert.deepEqual(singleRows, ['large-single']);
    assert.deepEqual(receipt.counts, { inserted: 25, updated: 0, deleted: 1, unchanged: 0 });
    assert.deepEqual((await batched.listRows(identity)).rows.map(row => row.value), rows.map(row => row.value));
    assert.equal((await pool.query('SELECT count(*) AS count FROM pult_live.incoming_rows')).rows[0].count, '0');
    const stagedBeforeReplay = batches.length;
    assert.deepEqual(await batched.publish(input), receipt);
    assert.equal(batches.length, stagedBeforeReplay, 'replay never restages records');
    assert.deepEqual((await batched.readAtRevision({ ...identity, revision: 1 })).rows.map(row => row.value), [{ amount: 1 }]);
  });

  await t.test('failure in a later input batch rolls back earlier partitions and every staged record', async () => {
    const identity = id();
    await repo.importComplete(command(identity, 'initial', 0, [all([record('p', null, { name: 'old' })], 'products'), all([record('keep', null, { amount: 1 })])]));
    let stageCalls = 0;
    const failing = createPostgresLiveRepository({ writeBatchBytes: 1024, pool: { async connect() {
      const client = await pool.connect();
      return { release: () => client.release(), async query(sql, values) {
        if (sql.startsWith('INSERT INTO pult_live.incoming_rows') && ++stageCalls === 4) throw new Error('synthetic batch failure');
        return client.query(sql, values);
      } };
    } } });
    const rows = Array.from({ length: 12 }, (_, index) => record('new-' + index, null, { label: 'x'.repeat(350) }, index));
    await assert.rejects(failing.publish(command(identity, 'late-failure', 1, [all([record('p', null, { name: 'new' })], 'products'), all(rows)])), code('DATABASE_ERROR'));
    assert.equal(stageCalls, 4);
    assert.equal((await repo.getHead(identity)).revision, 1);
    assert.equal((await repo.listRows({ ...identity, entityType: 'products' })).rows[0].value.name, 'old');
    assert.equal((await repo.listRows({ ...identity, entityType: 'operations' })).rows[0].entityKey, 'keep');
    assert.equal(await repo.readCommand({ ...identity, commandId: 'late-failure' }), null);
    assert.deepEqual(await repo.listJournal({ ...identity, afterRevision: 1 }), []);
    assert.equal((await pool.query('SELECT count(*) AS count FROM pult_live.incoming_rows')).rows[0].count, '0');
  });

  await t.test('explicit restricted-role grants permit reads and publication without old schemas', { skip: !process.env.PULT_TEST_RESTRICTED_DATABASE_URL }, async () => {
    const restricted = new Pool({ connectionString: process.env.PULT_TEST_RESTRICTED_DATABASE_URL, max: 1 });
    try {
      const role = (await restricted.query('SELECT current_user AS role')).rows[0].role;
      assert.match(role, /^pult_test_[a-f0-9]+_app$/u);
      const restrictedRepo = createPostgresLiveRepository({ pool: restricted });
      await assert.rejects(restrictedRepo.getHead(id()), code('DATABASE_ERROR'));
      await pool.query(`GRANT USAGE ON SCHEMA pult_live TO "${role}"`);
      await pool.query(`GRANT SELECT ON pult_live.heads,pult_live.facts,pult_live.commands,pult_live.record_journal TO "${role}"`);
      await pool.query(`GRANT INSERT,UPDATE ON pult_live.heads,pult_live.facts TO "${role}"`);
      await pool.query(`GRANT DELETE ON pult_live.facts TO "${role}"`);
      await pool.query(`GRANT INSERT ON pult_live.commands,pult_live.record_journal TO "${role}"`);
      await pool.query(`GRANT SELECT,INSERT,DELETE ON pult_live.incoming_rows TO "${role}"`);
      await pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA pult_live TO "${role}"`);
      const identity = id();
      const receipt = await restrictedRepo.publish(command(identity, 'restricted', 0, [all([record('x', null, { amount: 1 })])]));
      assert.equal(receipt.revision, 1);
      assert.equal((await restrictedRepo.listRows(identity)).rows[0].value.amount, 1);
      await restrictedRepo.publish(command(identity, 'restricted-next', 1, [all([])]));
      assert.equal((await restrictedRepo.listRows(identity)).total, 0);
      await assert.rejects(restricted.query('DELETE FROM pult_live.commands WHERE store_id=$1', [identity.storeId]), error => error.code === '42501');
    } finally { await restricted.end(); }
  });
});

test('buyer acquisition receipt collection passes validation before SQL', async () => {
 let connects=0; const repo=createPostgresLiveRepository({pool:{async connect(){connects++;throw Error('offline')}}});
 await assert.rejects(repo.publish(command({...id(),domain:'buyers'},'buyer-pending',0,[all([record('target',null,{storeId:'1'})],'_sqlAcquisition.targets')])),code('DATABASE_ERROR'));
 assert.equal(connects,1);
 await assert.rejects(repo.publish(command(id(),'bad',0,[all([],'_unknown')])),code('INVALID_ARGUMENT'));
 assert.equal(connects,1);
});
