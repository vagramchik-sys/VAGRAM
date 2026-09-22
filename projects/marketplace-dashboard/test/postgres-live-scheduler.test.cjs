'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPostgresLiveScheduler, schemaSql } = require('../storage/acquisition/postgres-live-scheduler.cjs');
const { withWriteFence } = require('../storage/postgres-write-fence.cjs');

const C1 = '11111111-1111-4111-8111-111111111111', C2 = '22222222-2222-4222-8222-222222222222', C3 = '33333333-3333-4333-8333-333333333333';
const A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', A2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const job = (overrides = {}) => ({ kind: 'market', storeId: '1', expectedRevision: '0', commandId: C1, attemptId: A1, timestamp: '2026-09-22T10:00:00.000Z', nextDueAt: '2026-09-22T10:10:00.000Z', state: 'queued', stage: 'Queued', count: 0, errorCodes: [], documentRevision: '1', runnerId: null, ...overrides });

test('DDL is idempotent-shaped and identifiers plus invalid commands fail before SQL', async () => {
  const sql = schemaSql('live_test'); assert.match(sql, /CREATE TABLE IF NOT EXISTS "live_test"\.scheduler_jobs/u); assert.match(sql, /payload jsonb/u); assert.match(sql, /scheduler_commands/u); assert.throws(() => schemaSql('bad;drop'), TypeError);
  let calls = 0; const pool = { connect: async () => { calls++; }, query: async () => { calls++; } }, scheduler = createPostgresLiveScheduler({ pool, schema: 'live_test' });
  await assert.rejects(scheduler.transition(job({ commandId: 'bad' })), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(scheduler.captureRequest({ commandId: C1, timestamp: 'bad', targets: [] }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls, 0);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('live scheduler preserves CAS, exact command replay, unknown hold and lightweight status rows', { skip: !integrationUrl }, async t => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /^pult_test_/u);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl }), schema = `live_${crypto.randomBytes(6).toString('hex')}`; let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  await pool.query(schemaSql(schema)); owned = true; const scheduler = createPostgresLiveScheduler({ pool, schema });
  const payload = { intraday: [], category: { stores: [], categories: [], registry: { available: false }, date: '2026-09-22', evidence: [] }, archives: [] };
  const firstInput = job({ kind: 'derived-capture', storeId: '0', payload, payloadHash: crypto.createHash('sha256').update(Buffer.from(JSON.stringify(payload))).digest('hex') });
  const first = await scheduler.transition(firstInput); assert.equal(first.revision, '1'); assert.equal(first.replayed, false);
  const second = await scheduler.transition(job({ expectedRevision: '1', commandId: C2 })); assert.equal(second.revision, '2');
  const replay = await scheduler.transition(firstInput); assert.equal(replay.replayed, true); assert.equal(replay.revision, '1'); assert.deepEqual(replay.job.payload, payload);
  await assert.rejects(scheduler.transition({ ...firstInput, stage: 'Changed' }), { code: 'COMMAND_ID_REUSED' });
  const loaded = await scheduler.load(); assert.equal(loaded.revision, '2'); assert.deepEqual(loaded.value.jobs['derived-capture:0'].payload, payload);
  const light = await scheduler.load({ includePayload: false }); assert.equal(Object.hasOwn(light.value.jobs['derived-capture:0'], 'payload'), false);
  assert.deepEqual(await scheduler.getPayload('derived-capture', '0', A1), { payload, payloadHash: firstInput.payloadHash });
  await assert.rejects(scheduler.getPayload('derived-capture', '0', A2), { code: 'JOB_CONFLICT' });
  const status = await scheduler.statusJobs(); assert.equal(Object.hasOwn(status['derived-capture:0'], 'payload'), false); assert.equal((await scheduler.jobsProvider())['1'].status, 'queued');
  await scheduler.transition(job({ expectedRevision: '2', commandId: C3, attemptId: A2, state: 'unknown', expectedAttemptId: A1, expectedState: 'queued', expectedRunnerId: null }));
  await assert.rejects(scheduler.transition(job({ expectedRevision: '3', commandId: '44444444-4444-4444-8444-444444444444', attemptId: A2, state: 'running', expectedAttemptId: A2, expectedState: 'unknown', expectedRunnerId: null })), { code: 'UNKNOWN_OUTCOME_HOLD' });
  const resolved = await scheduler.transition(job({ expectedRevision: '3', commandId: '55555555-5555-4555-8555-555555555555', attemptId: A1, state: 'queued', expectedAttemptId: A2, expectedState: 'unknown', expectedRunnerId: null, resolution: { attemptId: A2, outcome: 'not-committed' } })); assert.equal(resolved.revision, '4');
});

test('request capture and transition receipts stay immutable after later writes', { skip: !integrationUrl }, async t => {
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl }), schema = `live_req_${crypto.randomBytes(6).toString('hex')}`; let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  await pool.query(schemaSql(schema)); owned = true; const scheduler = createPostgresLiveScheduler({ pool, schema }), request = { commandId: C1, timestamp: '2026-09-22T10:00:00.000Z', kind: 'insights-full', targets: [{ storeId: '2', documentRevision: '8' }, { storeId: '1', documentRevision: '7' }] };
  const captured = await scheduler.captureRequest(request); assert.deepEqual(captured.targets, [{ storeId: '1', documentRevision: '7' }, { storeId: '2', documentRevision: '8' }]);
  await scheduler.transition(job({ expectedRevision: '1', commandId: C2 }));
  const replay = await scheduler.captureRequest({ ...request, targets: [{ storeId: '9', documentRevision: '9' }] }); assert.equal(replay.replayed, true); assert.deepEqual(replay.targets, captured.targets); assert.equal(replay.revision, '1');
  await assert.rejects(scheduler.captureRequest({ ...request, timestamp: '2026-09-22T10:01:00.000Z' }), { code: 'COMMAND_ID_REUSED' });
  const receipt = await scheduler.transitionReceipt({ commandId: C2, kind: 'market', storeId: '1', timestamp: job().timestamp }); assert.equal(receipt.commandId, C2); assert.equal(receipt.attemptId, A1); assert.equal(receipt.state, 'queued');
  await assert.rejects(scheduler.transition(job({ expectedRevision: '2', commandId: C1 })), { code: 'COMMAND_ID_REUSED' });
});

test('legacy import succeeds only once into empty tables and retains payload plus request targets', { skip: !integrationUrl }, async t => {
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl }), schema = `live_import_${crypto.randomBytes(6).toString('hex')}`; let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  await pool.query(schemaSql(schema)); owned = true; const scheduler = createPostgresLiveScheduler({ pool, schema }), payload = { evidence: [] }, importedJob = job({ kind: 'derived-capture', storeId: '0', state: 'unknown', payload, payloadHash: crypto.createHash('sha256').update(Buffer.from(JSON.stringify(payload))).digest('hex') }), terminalJob=job({kind:'derived-capture',storeId:'1',state:'done',commandId:C3,attemptId:A2}), request = { commandId: C2, timestamp: '2026-09-22T09:00:00.000Z', kind: 'insights-full', targets: [{ storeId: '1', documentRevision: '3' }] }, value = { version: 1, jobs: { 'derived-capture:0': Object.fromEntries(Object.entries(importedJob).filter(([key]) => !['expectedRevision','resolution'].includes(key))), 'derived-capture:1':Object.fromEntries(Object.entries(terminalJob).filter(([key])=>!['expectedRevision','resolution'].includes(key))) }, requests: { [C2]: request } };
  const result = await scheduler.importLegacy(value, { revision: '7' }); assert.deepEqual(result, { revision: '7', jobs: 2, requests: 1 }); const loaded = await scheduler.load(); assert.equal(loaded.revision, '7'); assert.deepEqual(loaded.value.jobs['derived-capture:0'].payload, payload);assert.equal(Object.hasOwn(loaded.value.jobs['derived-capture:1'],'payload'),false); assert.deepEqual(loaded.value.requests[C2].targets, request.targets);
  await assert.rejects(scheduler.importLegacy(value, { revision: '7' }), { code: 'IMPORT_CONFLICT' });
});

test('metadata-only derived transitions preserve the immutable payload', { skip: !integrationUrl }, async t => {
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl }), schema = `live_payload_${crypto.randomBytes(6).toString('hex')}`; let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  await pool.query(schemaSql(schema)); owned = true; const scheduler = createPostgresLiveScheduler({ pool, schema }), payload = { mode: 'live', evidence: [{ revision: '1' }] }, payloadHash = crypto.createHash('sha256').update(Buffer.from(JSON.stringify(payload))).digest('hex');
  await scheduler.transition(job({ kind: 'derived-capture', storeId: '0', payload, payloadHash }));
  const light = (await scheduler.load({includePayload:false})).value.jobs['derived-capture:0'];
  await scheduler.transition({...light, expectedRevision:'1', expectedAttemptId:A1, expectedState:'queued', expectedRunnerId:null, commandId:C2, state:'running', runnerId:'runner'});
  assert.deepEqual(await scheduler.getPayload('derived-capture','0',A1),{payload,payloadHash});
  const stored=(await scheduler.load()).value.jobs['derived-capture:0'];assert.deepEqual(stored.payload,payload);assert.equal(stored.runnerId,'runner');
  await assert.rejects(scheduler.transition(job({kind:'derived-capture',storeId:'0',expectedRevision:'2',commandId:C3,attemptId:A2,state:'queued'})),{code:'INVALID_ARGUMENT'});
});

test('native scheduler writes wait behind the database backup fence', { skip: !integrationUrl }, async t => {
  const {Pool}=require('pg'),pool=new Pool({connectionString:integrationUrl,max:3}),schema=`live_fence_${crypto.randomBytes(6).toString('hex')}`;let owned=false,release,entered,settled=false;const hold=new Promise(resolve=>{release=resolve}),locked=new Promise(resolve=>{entered=resolve});
  t.after(async()=>{if(owned)await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await pool.end()});await pool.query(schemaSql(schema));owned=true;const scheduler=createPostgresLiveScheduler({pool,schema});
  const fence=withWriteFence({pool,timeoutMs:5000},async()=>{entered();await hold});await locked;const pending=scheduler.transition(job()).then(value=>{settled=true;return value});await new Promise(resolve=>setTimeout(resolve,75));assert.equal(settled,false);release();await fence;
  assert.equal((await pending).revision,'1');assert.equal(settled,true);
});
