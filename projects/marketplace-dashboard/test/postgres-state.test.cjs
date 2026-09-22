'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStateStore, PostgresStateError, requestHash } = require('../storage/postgres-state.cjs');

const COMMAND = '11111111-1111-4111-8111-111111111111';
const COMMAND_2 = '22222222-2222-4222-8222-222222222222';

function fakePool(handler) {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return handler ? handler(text, values, calls) : { rows: [] };
    },
    release(destroy = false) { calls.push(destroy ? { release: true, destroy: true } : { release: true }); }
  };
  return {
    calls,
    client,
    async query(text, values) { return client.query(text, values); },
    async connect() { calls.push({ connect: true }); return client; }
  };
}

test('write uses one serializable transaction, ordered advisory locks, CAS and an atomic journal', async () => {
  const content = Buffer.from([0, 255, 12, 128]);
  const pool = fakePool(text => {
    if (text.includes('FROM "pult"."commands"')) return { rows: [] };
    if (text.includes('FROM "pult"."document_states"') && text.includes('FOR UPDATE'))
      return { rows: [{ revision: '7', media_type: 'old/format', content: Buffer.from('before'), sha256: Buffer.alloc(32, 1), deleted: false }] };
    return { rows: [] };
  });
  const result = await createStateStore({ pool }).write('settings/account', content, {
    expectedRevision: '7', commandId: COMMAND, mediaType: 'opaque/dpapi'
  });

  assert.deepEqual(result, { revision: '8', replayed: false });
  assert.equal(pool.calls[1].text, 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  const lockCalls = pool.calls.filter(call => call.text?.includes('pg_advisory_xact_lock('));
  assert.equal(pool.calls.filter(call => call.text?.includes('pg_advisory_xact_lock_shared')).length, 1);
  assert.deepEqual(lockCalls.map(call => call.values[0]), [`command:${COMMAND}`, 'key:settings/account'].sort());
  const stateWrite = pool.calls.find(call => call.text?.includes('INSERT INTO "pult"."document_states"'));
  assert.deepEqual(stateWrite.values[2], content);
  assert.equal(stateWrite.values[4], '8');
  const journal = pool.calls.find(call => call.text?.includes('INSERT INTO "pult"."commands"'));
  assert.equal(journal.values[4], '7');
  assert.equal(journal.values[5], '8');
  assert.equal(journal.values[7], 'old/format');
  assert.deepEqual(journal.values[8], Buffer.from('before'));
  assert.deepEqual(journal.values[11], content);
  assert.equal(pool.calls.at(-2).text, 'COMMIT');
  assert.deepEqual(pool.calls.at(-1), { release: true });
});

test('same command and canonical request replays its committed revision', async () => {
  const body = Buffer.from('same bytes');
  const fingerprint = requestHash('write', 'registry/items', '2', 'application/json', body);
  const pool = fakePool(text => text.includes('FROM "pult"."commands"')
    ? { rows: [{ request_hash: fingerprint, after_revision: '3' }] }
    : { rows: [] });
  const result = await createStateStore({ pool }).write('registry/items', body, {
    expectedRevision: '2', commandId: COMMAND, mediaType: 'application/json'
  });
  assert.deepEqual(result, { revision: '3', replayed: true });
  assert.equal(pool.calls.some(call => call.text?.includes('INSERT INTO "pult"."document_states"')), false);
});

test('readCommand exposes durable before and after images and rejects key or operation reuse', async () => {
  const before = Buffer.from('before'), after = Buffer.from('after');
  const pool = fakePool(text => text.includes('FROM "pult"."commands"') ? { rows: [{
    command_id: COMMAND, operation: 'write', logical_key: 'registry/items', request_hash: Buffer.alloc(32, 7),
    before_revision: '4', after_revision: '5', media_type: 'new/type', before_media_type: 'old/type',
    before_content: before, before_sha256: Buffer.alloc(32, 1), before_deleted: false,
    after_content: after, after_sha256: Buffer.alloc(32, 2), after_deleted: false, committed_at: new Date(0)
  }] } : { rows: [] });
  const store = createStateStore({ pool }), result = await store.readCommand('registry/items', COMMAND, { operation: 'write' });
  assert.equal(result.before.mediaType, 'old/type');
  assert.equal(result.after.mediaType, 'new/type');
  assert.deepEqual(result.before.content, before);
  assert.notEqual(result.before.content, before);
  await assert.rejects(store.readCommand('registry/other', COMMAND, { operation: 'write' }), error => error.code === 'COMMAND_ID_REUSED');
  await assert.rejects(store.readCommand('registry/items', COMMAND, { operation: 'delete' }), error => error.code === 'COMMAND_ID_REUSED');
});

test('command reuse and CAS conflicts roll back without journaling', async () => {
  const reused = fakePool(text => text.includes('FROM "pult"."commands"')
    ? { rows: [{ request_hash: Buffer.alloc(32, 9), after_revision: '4' }] }
    : { rows: [] });
  await assert.rejects(
    createStateStore({ pool: reused }).write('registry/items', Buffer.from('different'), {
      expectedRevision: '3', commandId: COMMAND, mediaType: 'application/json'
    }), error => error.code === 'COMMAND_ID_REUSED'
  );
  assert.equal(reused.calls.some(call => call.text === 'ROLLBACK'), true);

  const conflict = fakePool(text => {
    if (text.includes('FROM "pult"."commands"')) return { rows: [] };
    if (text.includes('FOR UPDATE')) return { rows: [{ revision: '12', deleted: false }] };
    return { rows: [] };
  });
  await assert.rejects(
    createStateStore({ pool: conflict }).remove('checkpoints/import', { expectedRevision: '11', commandId: COMMAND_2 }),
    error => error.code === 'REVISION_CONFLICT'
  );
  assert.equal(conflict.calls.some(call => call.text?.includes('INSERT INTO "pult"."commands"')), false);
});

test('delete creates a tombstone while retaining before content in the journal', async () => {
  const before = Buffer.from('opaque ciphertext');
  const pool = fakePool(text => {
    if (text.includes('FROM "pult"."commands"')) return { rows: [] };
    if (text.includes('FOR UPDATE')) return { rows: [{ revision: '1', content: before, sha256: Buffer.alloc(32, 4), deleted: false }] };
    return { rows: [] };
  });
  assert.deepEqual(await createStateStore({ pool }).remove('settings/secret', {
    expectedRevision: '1', commandId: COMMAND
  }), { revision: '2', replayed: false });
  const stateWrite = pool.calls.find(call => call.text?.includes('INSERT INTO "pult"."document_states"'));
  assert.equal(stateWrite.values[2], null);
  assert.equal(stateWrite.values[5], true);
  const journal = pool.calls.find(call => call.text?.includes('INSERT INTO "pult"."commands"'));
  assert.deepEqual(journal.values[8], before);
  assert.equal(journal.values[11], null);
  assert.equal(journal.values[13], true);
});

test('validation requires portable keys, UUID commands, decimal bigint and the payload floor', async () => {
  const store = createStateStore({ pool: fakePool() });
  await assert.rejects(store.read('C:\\state\\file'), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(store.read('one-segment'), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(store.write('ok/key', Buffer.alloc(0), { expectedRevision: 1, commandId: COMMAND }), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(store.write('ok/key', Buffer.alloc(0), { expectedRevision: '0', commandId: 'not-a-uuid' }), error => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => createStateStore({ pool: fakePool(), maxPayloadBytes: 1024 }), error => error.code === 'INVALID_ARGUMENT');
});

test('request hash is canonical, length-framed and byte-sensitive', () => {
  const a = requestHash('write', 'a/b', '0', 'x/y', Buffer.from([0, 1]));
  assert.equal(a.length, 32);
  assert.deepEqual(a, requestHash('write', 'a/b', '0', 'x/y', Buffer.from([0, 1])));
  assert.notDeepEqual(a, requestHash('write', 'a/b', '0', 'x/y', Buffer.from([0, 2])));
  assert.notDeepEqual(a, requestHash('write', 'a/b', '0', 'x/z', Buffer.from([0, 1])));
});

test('trusted SQL effect is atomic, durable and never reruns for a duplicate command', async () => {
  let effects = 0;
  const pool = fakePool(text => {
    if (text.includes('FROM "pult"."commands"')) return { rows: [] };
    if (text.includes('FROM "pult"."document_states"') && text.includes('FOR UPDATE')) return { rows: [] };
    return { rows: [] };
  });
  const result = await createStateStore({ pool }).writeWithEffect('history/source', Buffer.from('{"schemaVersion":1}'), {
    expectedRevision: '0', commandId: COMMAND, mediaType: 'application/vnd.pult.history-command+json'
  }, async client => { effects++; await client.query('INSERT INTO normalized_fact VALUES (1)'); return { facts: 1, ingestionId: 'synthetic' }; });
  assert.deepEqual(result, { revision: '1', replayed: false, result: { facts: 1, ingestionId: 'synthetic' } });
  assert.equal(effects, 1);
  const effectIndex = pool.calls.findIndex(call => call.text === 'INSERT INTO normalized_fact VALUES (1)');
  const stateIndex = pool.calls.findIndex(call => call.text?.includes('INSERT INTO "pult"."document_states"'));
  assert.equal(effectIndex < stateIndex, true);
  const journal = pool.calls.find(call => call.text?.includes('INSERT INTO "pult"."commands"'));
  assert.equal(journal.values[14], JSON.stringify({ facts: 1, ingestionId: 'synthetic' }));

  let duplicateEffects = 0;
  const duplicate = fakePool(text => text.includes('FROM "pult"."commands"')
    ? { rows: [{ request_hash: requestHash('write-effect', 'history/source', '0', 'application/vnd.pult.history-command+json', Buffer.from('{"schemaVersion":1}')), after_revision: '1', result_json: { ingestionId: 'synthetic', facts: 1 } }] }
    : { rows: [] });
  assert.deepEqual(await createStateStore({ pool: duplicate }).writeWithEffect('history/source', Buffer.from('{"schemaVersion":1}'), {
    expectedRevision: '0', commandId: COMMAND, mediaType: 'application/vnd.pult.history-command+json'
  }, async () => { duplicateEffects++; return { facts: 2 }; }), { revision: '1', replayed: true, result: { facts: 1, ingestionId: 'synthetic' } });
  assert.equal(duplicateEffects, 0);

  const failed = fakePool(text => {
    if (text.includes('FROM "pult"."commands"') || text.includes('FROM "pult"."document_states"')) return { rows: [] };
    return { rows: [] };
  });
  await assert.rejects(createStateStore({ pool: failed }).writeWithEffect('history/source', Buffer.from('{}'), {
    expectedRevision: '0', commandId: COMMAND_2, mediaType: 'application/vnd.pult.history-command+json'
  }, async client => { await client.query('INSERT INTO normalized_fact VALUES (2)'); throw Error('private failure'); }),
  error => error.code === 'DATABASE_ERROR' && !error.message.includes('private'));
  assert.equal(failed.calls.some(call => call.text?.includes('INSERT INTO "pult"."commands"')), false);
  assert.equal(failed.calls.some(call => call.text?.includes('INSERT INTO "pult"."document_states"')), false);
  assert.equal(failed.calls.some(call => call.text === 'ROLLBACK'), true);
});

test('trusted SQL effect rejects lossy JSON results and preserves JSON __proto__ data', async () => {
  const invalidResults = [];
  const sparse = new Array(1); invalidResults.push(sparse);
  const extra = []; extra.extra = 1; invalidResults.push(extra);
  const hidden = []; Object.defineProperty(hidden, 'hidden', { value: 1 }); invalidResults.push(hidden);
  const accessor = {}; Object.defineProperty(accessor, 'value', { enumerable: true, get() { throw Error('getter ran'); } }); invalidResults.push(accessor);
  const symbol = { count: 1 }; symbol[Symbol('hidden')] = 2; invalidResults.push(symbol);
  for (const [index, bad] of invalidResults.entries()) {
    const pool = fakePool(text => text.includes('FROM "pult"."commands"') || text.includes('FROM "pult"."document_states"')
      ? { rows: [] } : { rows: [] });
    await assert.rejects(createStateStore({ pool }).writeWithEffect('history/source', Buffer.from(`{"case":${index}}`), {
      expectedRevision: '0', commandId: crypto.randomUUID(), mediaType: 'application/vnd.pult.history-command+json'
    }, async () => ({ bad })), error => error.code === 'INVALID_EFFECT_RESULT');
    assert.equal(pool.calls.some(call => call.text?.includes('INSERT INTO "pult"."commands"')), false);
    assert.equal(pool.calls.some(call => call.text === 'ROLLBACK'), true);
  }

  const protoData = JSON.parse('{"__proto__":{"safe":true},"count":1}');
  const pool = fakePool(text => text.includes('FROM "pult"."commands"') || text.includes('FROM "pult"."document_states"')
    ? { rows: [] } : { rows: [] });
  const result = await createStateStore({ pool }).writeWithEffect('history/source', Buffer.from('{"valid":true}'), {
    expectedRevision: '0', commandId: crypto.randomUUID(), mediaType: 'application/vnd.pult.history-command+json'
  }, async () => protoData);
  assert.equal(Object.hasOwn(result.result, '__proto__'), true);
  assert.deepEqual(result.result.__proto__, { safe: true });
});

test('40001 is a same-command retry signal and database errors do not leak values', async () => {
  const serialization = fakePool(text => {
    if (text.startsWith('SELECT pg_advisory')) return Promise.reject(Object.assign(new Error('detail'), { code: '40001' }));
    return { rows: [] };
  });
  await assert.rejects(
    createStateStore({ pool: serialization }).remove('state/item', { expectedRevision: '0', commandId: COMMAND }),
    error => error.code === 'SERIALIZATION_RETRY' && /same commandId/u.test(error.message)
  );

  const secret = 'secret/value';
  const broken = fakePool(() => { throw new Error(`database exposed ${secret}`); });
  await assert.rejects(createStateStore({ pool: broken }).read(secret), error => {
    assert.equal(error instanceof PostgresStateError, true);
    assert.equal(error.code, 'DATABASE_ERROR');
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('runtime source mapping is inserted atomically once and an imported baseline stays immutable', async () => {
  const sourcePath = 'ideas.json';
  const logicalKey = 'file/' + crypto.createHash('sha256').update(sourcePath).digest('hex');
  const sourceMapping = { sourcePath, logicalKey, domain: 'business-state', mediaType: 'application/json' };
  const absent = fakePool(text => {
    if (text.includes('FROM "pult"."commands"')) return { rows: [] };
    if (text.includes('FROM "pult"."document_states"')) return { rows: [] };
    if (text.includes('FROM "pult"."source_files"')) return { rows: [] };
    return { rows: [] };
  });
  await createStateStore({ pool: absent }).write(logicalKey, Buffer.from('{}'), {
    expectedRevision: '0', commandId: COMMAND, mediaType: 'application/json', sourceMapping
  });
  const inserted = absent.calls.find(call => call.text?.includes('INSERT INTO "pult"."source_files"'));
  assert.equal(absent.calls.filter(call => call.text?.includes('FROM "pult"."source_files"')).every(call => !call.text.includes('FOR UPDATE')), true);
  assert.deepEqual(inserted.values.slice(0, 4), [sourcePath, logicalKey, 'business-state', 'application/json']);
  assert.equal(inserted.values[4].length, 32);
  assert.deepEqual(inserted.values[4], crypto.createHash('sha256').update(Buffer.alloc(0)).digest());

  const baseline = fakePool(text => {
    if (text.includes('FROM "pult"."commands"')) return { rows: [] };
    if (text.includes('FROM "pult"."document_states"')) return { rows: [{ revision: '1', media_type: 'application/json', content: Buffer.from('{}'), sha256: Buffer.alloc(32), deleted: false }] };
    if (text.includes('FROM "pult"."source_files"')) return { rows: [{ source_path: sourcePath, logical_key: logicalKey, domain: 'business-state', media_type: 'application/json', baseline_present: true }] };
    return { rows: [] };
  });
  await createStateStore({ pool: baseline }).write(logicalKey, Buffer.from('{"a":1}'), {
    expectedRevision: '1', commandId: COMMAND_2, mediaType: 'application/json', sourceMapping
  });
  assert.equal(baseline.calls.some(call => call.text?.includes('INSERT INTO "pult"."source_files"')), false);
  assert.equal(baseline.calls.some(call => /UPDATE\s+"pult"\."source_files"/u.test(call.text || '')), false);
});

test('market projection is restricted to mapped data snapshots and runs after the document write', async () => {
  const sourcePath = 'data-1.json';
  const logicalKey = 'file/' + crypto.createHash('sha256').update(sourcePath).digest('hex');
  const sourceMapping = { sourcePath, logicalKey, domain: 'market-snapshots', mediaType: 'application/json' };
  const pool = fakePool(text => {
    if (text.includes('FROM "pult"."commands"') || text.includes('FROM "pult"."document_states"') || text.includes('FROM "pult"."source_files"')) return { rows: [] };
    return { rows: [] };
  });
  const input = Buffer.from('{"clientId":"1"}'); let effectCalls = 0;
  const result = await createStateStore({ pool }).writeWithProjection(logicalKey, input, {
    expectedRevision: '0', commandId: COMMAND, mediaType: 'application/json', sourceMapping
  }, async (client, context) => {
    effectCalls++; input.fill(0);
    assert.equal(context.before, null); assert.equal(context.afterRevision, '1');
    assert.equal(context.content.toString(), '{"clientId":"1"}');
    const stateIndex = pool.calls.findIndex(call => call.text?.includes('INSERT INTO "pult"."document_states"'));
    const mappingIndex = pool.calls.findIndex(call => call.text?.includes('INSERT INTO "pult"."source_files"'));
    assert.ok(stateIndex >= 0 && mappingIndex > stateIndex); assert.equal(client, pool.client);
    return { snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  });
  assert.deepEqual(result, { revision: '1', replayed: false, result: { snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
  assert.equal(effectCalls, 1);

  await assert.rejects(createStateStore({ pool }).writeWithProjection(logicalKey, Buffer.from('{}'), {
    expectedRevision: '0', commandId: COMMAND_2, mediaType: 'application/json', sourceMapping: { ...sourceMapping, sourcePath: 'costs-1.json' }
  }, async () => ({})), error => error.code === 'INVALID_ARGUMENT');
});

test('source mapping failure rolls back state and an existing unmapped document fails closed', async () => {
  const sourcePath = 'ideas.json';
  const logicalKey = 'file/' + crypto.createHash('sha256').update(sourcePath).digest('hex');
  const sourceMapping = { sourcePath, logicalKey, domain: 'business-state', mediaType: 'application/json' };
  const insertFailure = fakePool(text => {
    if (text.includes('FROM "pult"."commands"') || text.includes('FROM "pult"."document_states"') || text.includes('FROM "pult"."source_files"')) return { rows: [] };
    if (text.includes('INSERT INTO "pult"."source_files"')) throw new Error('mapping insert failed');
    return { rows: [] };
  });
  await assert.rejects(createStateStore({ pool: insertFailure }).write(logicalKey, Buffer.from('{}'), {
    expectedRevision: '0', commandId: COMMAND, mediaType: 'application/json', sourceMapping
  }), error => error.code === 'DATABASE_ERROR');
  assert.equal(insertFailure.calls.some(call => call.text === 'ROLLBACK'), true);
  assert.equal(insertFailure.calls.some(call => call.text?.includes('INSERT INTO "pult"."commands"')), false);
  assert.deepEqual(insertFailure.calls.at(-1), { release: true });

  const unmapped = fakePool(text => {
    if (text.includes('FROM "pult"."commands"')) return { rows: [] };
    if (text.includes('FROM "pult"."document_states"')) return { rows: [{ revision: '1', media_type: 'application/json', content: Buffer.from('{}'), sha256: Buffer.alloc(32), deleted: false }] };
    return { rows: [] };
  });
  await assert.rejects(createStateStore({ pool: unmapped }).write(logicalKey, Buffer.from('{}'), {
    expectedRevision: '1', commandId: COMMAND_2, mediaType: 'application/json', sourceMapping
  }), error => error.code === 'SOURCE_MAPPING_MISSING');
});

test('failed rollback or uncertain commit destroys the client without masking the original outcome', async () => {
  const rollbackFailure = fakePool(text => {
    if (text === 'ROLLBACK') throw new Error('rollback failed');
    if (text.includes('pg_advisory_xact_lock_shared')) throw Object.assign(new Error('serialization'), { code: '40001' });
    return { rows: [] };
  });
  await assert.rejects(createStateStore({ pool: rollbackFailure }).remove('state/item', {
    expectedRevision: '0', commandId: COMMAND
  }), error => error.code === 'SERIALIZATION_RETRY');
  assert.deepEqual(rollbackFailure.calls.at(-1), { release: true, destroy: true });

  const uncertain = fakePool(text => {
    if (text.includes('FROM "pult"."commands"') || text.includes('FROM "pult"."document_states"')) return { rows: [] };
    if (text === 'COMMIT') throw new Error('connection lost');
    return { rows: [] };
  });
  uncertain.client.release = destroy => { uncertain.calls.push({ release: true, destroy }); throw new Error('release failed'); };
  await assert.rejects(createStateStore({ pool: uncertain }).write('state/item', Buffer.from('x'), {
    expectedRevision: '0', commandId: COMMAND
  }), error => error.code === 'OUTCOME_UNKNOWN');
  assert.deepEqual(uncertain.calls.at(-1), { release: true, destroy: true });
});

test('read preserves bigint and bytea fidelity and hides tombstones by default', async () => {
  const content = Buffer.from([3, 2, 1, 0, 255]);
  const pool = fakePool(() => ({ rows: [{ logical_key: 'state/item', media_type: 'opaque/dpapi', content, sha256: Buffer.alloc(32, 5), revision: '9007199254740993', deleted: false, modified_at: new Date(0) }] }));
  const row = await createStateStore({ pool }).read('state/item');
  assert.equal(row.revision, '9007199254740993');
  assert.deepEqual(row.content, content);
  assert.notEqual(row.content, content);

  pool.client.query = async () => ({ rows: [{ logical_key: 'state/item', revision: '2', deleted: true }] });
  assert.equal(await createStateStore({ pool }).read('state/item'), null);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
const restrictedUrl = process.env.PULT_TEST_RESTRICTED_DATABASE_URL;
test('PostgreSQL restricted role: mapped write and replay need no source_files UPDATE', { skip: !integrationUrl || !restrictedUrl }, async () => {
  const {Pool}=require('pg'),owner=new Pool({connectionString:integrationUrl}),restricted=new Pool({connectionString:restrictedUrl}),schema=`restricted_${crypto.randomBytes(8).toString('hex')}`,role=(await restricted.query('SELECT current_user AS role')).rows[0].role;
  try{await owner.query(require('../storage/postgres-schema.cjs').replaceAll('pult',schema));await owner.query(require('../storage/postgres-document-schema.cjs').replaceAll('pult',schema));await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"; GRANT SELECT,INSERT,UPDATE ON "${schema}".document_states,"${schema}".commands TO "${role}"; GRANT SELECT,INSERT ON "${schema}".source_files TO "${role}"; REVOKE UPDATE,DELETE ON "${schema}".source_files FROM "${role}"`);const store=createStateStore({pool:restricted,schema}),sourcePath='ideas.json',logicalKey='file/'+crypto.createHash('sha256').update(sourcePath).digest('hex'),options={expectedRevision:'0',commandId:COMMAND,mediaType:'application/json',sourceMapping:{sourcePath,logicalKey,domain:'business-state',mediaType:'application/json'}};assert.deepEqual(await store.write(logicalKey,Buffer.from('{}'),options),{revision:'1',replayed:false});assert.deepEqual(await store.write(logicalKey,Buffer.from('{}'),options),{revision:'1',replayed:true});}finally{await restricted.end();await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await owner.end();}
});
test('PostgreSQL integration: schema, CAS, replay, tombstone and exact bytes', { skip: !integrationUrl }, async () => {
  const parsed = new URL(integrationUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  assert.match(databaseName, /test/iu, 'PULT_TEST_DATABASE_URL must name an explicit test database');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: integrationUrl, max: 4 });
  const schema = `pult_test_${crypto.randomBytes(8).toString('hex')}`;
  const schemaSql = require('../storage/postgres-schema.cjs').replace(/\bpult\b/gu, schema);
  try {
    await pool.query(schemaSql);
    await pool.query(schemaSql);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='commands' AND column_name='before_media_type'`, [schema])).rows[0].n, 1);
    const store = createStateStore({ pool, schema });
    const exact = Buffer.from([0, 255, 17, 128, 0]);
    assert.deepEqual(await store.write('integration/state', exact, {
      expectedRevision: '0', commandId: COMMAND, mediaType: 'opaque/dpapi'
    }), { revision: '1', replayed: false });
    assert.deepEqual((await store.read('integration/state')).content, exact);
    assert.deepEqual(await store.write('integration/state', exact, {
      expectedRevision: '0', commandId: COMMAND, mediaType: 'opaque/dpapi'
    }), { revision: '1', replayed: true });
    const firstCommand = await store.readCommand('integration/state', COMMAND, { operation: 'write' });
    assert.equal(firstCommand.before.mediaType, null);
    assert.equal(firstCommand.after.mediaType, 'opaque/dpapi');
    await assert.rejects(
      store.remove('integration/state', { expectedRevision: '0', commandId: COMMAND_2 }),
      error => error.code === 'REVISION_CONFLICT'
    );
    assert.deepEqual(await store.remove('integration/state', { expectedRevision: '1', commandId: COMMAND_2 }), { revision: '2', replayed: false });
    const deleteCommand = await store.readCommand('integration/state', COMMAND_2, { operation: 'delete' });
    assert.equal(deleteCommand.before.mediaType, 'opaque/dpapi');
    assert.equal(await store.read('integration/state'), null);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});
