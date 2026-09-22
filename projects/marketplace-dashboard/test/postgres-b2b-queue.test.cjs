'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sourceKey } = require('../storage/postgres-document-import.cjs');
const { createPostgresB2BQueue, validateQueue, LOGICAL_KEY, RECOVERY_REASON } = require('../storage/postgres-b2b-queue.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
const command = value => `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;
const event = (kind = 'test', caseId = '1') => ({ kind, caseId, message: 'Синтетическое событие', at: '2026-09-22T10:00:00Z' });
const queue = (cases = {}) => ({ version: 1, cases, events: [], lastScan: null });

function memoryStore(initialValue = null, revision = '0') {
  let current = initialValue === null ? null : record(initialValue, revision), writes = 0;
  const commands = new Map(), calls = [];
  function record(value, rev) {
    const content = Buffer.from(JSON.stringify(value));
    return { revision: rev, deleted: false, mediaType: 'application/json', content, sha256: digest(content) };
  }
  return {
    calls,
    replace(value, rev) { current = record(value, rev); },
    get writes() { return writes; },
    async read(key, options) { calls.push({ action: 'read', key, options }); return current; },
    async write(key, content, options) {
      calls.push({ action: 'write', key, content: Buffer.from(content), options }); writes++;
      const request = JSON.stringify([key, options.expectedRevision, content.toString('base64')]);
      const prior = commands.get(options.commandId);
      if (prior) {
        if (prior.request !== request) throw Object.assign(Error('reused'), { code: 'COMMAND_ID_REUSED' });
        return { revision: prior.revision, replayed: true };
      }
      if ((current?.revision || '0') !== options.expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' });
      const nextRevision = (BigInt(options.expectedRevision) + 1n).toString();
      current = { revision: nextRevision, deleted: false, mediaType: options.mediaType, content: Buffer.from(content), sha256: digest(content) };
      commands.set(options.commandId, { request, revision: nextRevision });
      return { revision: nextRevision, replayed: false };
    },
    async remove() { throw Error('not used'); }
  };
}

test('uses the migration source key and every load is a fresh SQL read without a RAM master', async () => {
  const store = memoryStore(queue({ '1': { id: '1', status: 'queued' } }), '4');
  const repository = createPostgresB2BQueue({ stateStore: store });
  assert.equal(repository.logicalKey, sourceKey('b2b-agent/queue.json'));
  assert.equal(LOGICAL_KEY, repository.logicalKey);
  assert.equal((await repository.load()).value.cases['1'].status, 'queued');
  store.replace(queue({ '1': { id: '1', status: 'sent' } }), '5');
  assert.equal((await repository.load()).value.cases['1'].status, 'sent');
  assert.equal(store.calls.filter(call => call.action === 'read').length, 2);
});

test('restart recovery durably changes sending to uncertain and never queues it', async () => {
  const initial = queue({ '1': { id: '1', incomingId: 'mail-1', status: 'sending', reasons: [] } });
  initial.events.push(event('before'));
  const store = memoryStore(initial, '7'), repository = createPostgresB2BQueue({ stateStore: store });
  const loaded = await repository.load();
  const result = await repository.recover(loaded, { commandId: command('1') });
  assert.equal(result.changed, true);
  assert.equal(result.value.cases['1'].status, 'uncertain');
  assert.deepEqual(result.value.cases['1'].reasons, [RECOVERY_REASON]);
  assert.deepEqual(result.value.messageClaims['mail-1'], { ownerId: '1', status: 'uncertain' });
  assert.deepEqual(result.value.events, initial.events);
  const restarted = createPostgresB2BQueue({ stateStore: store }), after = await restarted.load();
  assert.equal(after.value.cases['1'].status, 'uncertain');
  assert.equal((await restarted.recover(after)).changed, false);
  assert.equal(store.writes, 1);
});

test('sending claim commits before any caller can perform an external send', async () => {
  const store = memoryStore(queue({ '1': { id: '1', incomingId: 'mail-1', status: 'draft' } }), '2');
  const repository = createPostgresB2BQueue({ stateStore: store }), loaded = await repository.load();
  let externalSends = 0;
  const pending = repository.updateCase(loaded, { caseId: '1', value: { ...loaded.value.cases['1'], status: 'sending', attemptId: 'attempt-1' }, commandId: command('2') });
  assert.equal(externalSends, 0);
  const committed = await pending;
  assert.equal(committed.value.cases['1'].status, 'sending');
  assert.deepEqual(committed.value.messageClaims['mail-1'], { ownerId: '1', status: 'sending' });
  assert.equal(externalSends, 0);
});

test('concurrent stale updates cannot lose uncertain or sent state and protected claims', async () => {
  const initial = queue({ '1': { id: '1', incomingId: 'mail-1', status: 'sending' } });
  const store = memoryStore(initial, '3'), a = createPostgresB2BQueue({ stateStore: store }), b = createPostgresB2BQueue({ stateStore: store });
  const left = await a.load(), right = await b.load();
  await a.updateCase(left, { caseId: '1', value: { ...left.value.cases['1'], status: 'sent', sentAt: '2026-09-22T10:00:00Z' }, event: event('sent'), commandId: command('3') });
  await assert.rejects(b.updateCase(right, { caseId: '1', value: { ...right.value.cases['1'], status: 'uncertain' }, commandId: command('4') }), error => error.code === 'REVISION_CONFLICT');
  const final = await a.load();
  assert.equal(final.value.cases['1'].status, 'sent');
  assert.deepEqual(final.value.messageClaims['mail-1'], { ownerId: '1', status: 'sent' });
  await assert.rejects(a.updateCase(final, { caseId: '1', value: { ...final.value.cases['1'], status: 'ready' }, commandId: command('5') }), error => error.code === 'TERMINAL_STATUS');
});

test('terminal states cannot be downgraded through intermediate statuses and claims cannot contradict cases', async () => {
  for (const status of ['uncertain', 'sent', 'answered']) {
    const current = { revision: '1', value: queue({ '1': { id: '1', incomingId: 'mail-1', status } }), exists: true };
    const repository = createPostgresB2BQueue({ stateStore: memoryStore(current.value, '1') });
    await assert.rejects(repository.updateCase(current, { caseId: '1', value: { ...current.value.cases['1'], status: 'draft' }, commandId: command(status[0]) }), error => error.code === 'TERMINAL_STATUS');
  }
  const value = queue({ '1': { id: '1', incomingId: 'mail-1', status: 'draft' } });
  const repository = createPostgresB2BQueue({ stateStore: memoryStore(value, '2') });
  await assert.rejects(repository.updateCase({ revision: '2', value }, { caseId: '1', value: { ...value.cases['1'], status: 'sending' }, claim: { ownerId: '1', status: 'queued' }, commandId: command('9') }), error => error.code === 'INVALID_CLAIM');
});

test('common commit guards also cover whole-document mutations', async () => {
  const initial = queue({ '1': { id: '1', incomingId: 'mail-1', status: 'uncertain', attemptId: 'attempt-1' } });
  initial.messageClaims = { 'mail-1': { ownerId: '1', status: 'uncertain' } };
  const repository = createPostgresB2BQueue({ stateStore: memoryStore(initial, '2') });
  const current = await repository.load();
  const downgraded = structuredClone(current.value); downgraded.cases['1'].status = 'draft';
  await assert.rejects(repository.updateDocument(current, { value: downgraded, commandId: command('b') }), error => error.code === 'TERMINAL_STATUS');
  const stolen = structuredClone(current.value); stolen.messageClaims['mail-1'].ownerId = '2';
  await assert.rejects(repository.updateDocument(current, { value: stolen, commandId: command('c') }), error => error.code === 'INVALID_CLAIM' || error.code === 'MESSAGE_CLAIMED');
});

test('whole-document mutation cannot reopen an in-flight attempt or alter protected identity', async () => {
  const sending = queue({ '1': { id: '1', incomingId: 'mail-1', recipient: 'buyer@example.test', draft: { body: 'Exact body' }, status: 'sending', attemptId: 'attempt-1' } });
  sending.messageClaims = { 'mail-1': { ownerId: '1', status: 'sending' } };
  const sendingRepository = createPostgresB2BQueue({ stateStore: memoryStore(sending, '2') }), current = await sendingRepository.load();
  const reopened = structuredClone(current.value); reopened.cases['1'].status = 'queued';
  await assert.rejects(sendingRepository.updateDocument(current, { value: reopened, commandId: command('d') }), error => error.code === 'TERMINAL_STATUS');

  const sent = structuredClone(sending); sent.cases['1'].status = 'sent'; sent.messageClaims['mail-1'].status = 'sent';
  const sentRepository = createPostgresB2BQueue({ stateStore: memoryStore(sent, '3') }), sentCurrent = await sentRepository.load();
  const changedIdentity = structuredClone(sentCurrent.value);
  changedIdentity.cases['1'].incomingId = 'mail-2'; changedIdentity.messageClaims['mail-1'].status = 'queued';
  await assert.rejects(sentRepository.updateDocument(sentCurrent, { value: changedIdentity, commandId: command('e') }), error => ['TERMINAL_STATUS', 'INVALID_CLAIM'].includes(error.code));
});

test('recovery refuses to steal an existing message claim', async () => {
  const value = queue({ '1': { id: '1', incomingId: 'mail-1', status: 'sending' } });
  value.messageClaims = { 'mail-1': { ownerId: '2', status: 'sent' } };
  const repository = createPostgresB2BQueue({ stateStore: memoryStore(value, '2') });
  await assert.rejects(repository.recover({ revision: '2', value }, { commandId: command('a') }), error => error.code === 'MESSAGE_CLAIMED');
});

test('wrong revision fails CAS and same snapshot plus command is an exact journal replay', async () => {
  const store = memoryStore(queue(), '5'), repository = createPostgresB2BQueue({ stateStore: store });
  const stale = { revision: '4', value: queue(), exists: true };
  await assert.rejects(repository.updateEvent(stale, { event: event(), commandId: command('6') }), error => error.code === 'REVISION_CONFLICT');
  const loaded = await repository.load(), options = { event: event('audit'), commandId: command('7') };
  const first = await repository.updateEvent(loaded, options), retry = await repository.updateEvent(loaded, options);
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.equal(retry.revision, first.revision);
});

test('event updates preserve the 500 newest entries and perform no external action', async () => {
  const value = queue();
  value.events = Array.from({ length: 500 }, (_, index) => event('old-' + index));
  const store = memoryStore(value, '1'), repository = createPostgresB2BQueue({ stateStore: store });
  const result = await repository.updateEvent(await repository.load(), { event: event('new'), commandId: command('8') });
  assert.equal(result.value.events.length, 500);
  assert.equal(result.value.events[0].kind, 'new');
  assert.equal(result.value.events.some(row => row.kind === 'old-499'), false);
  assert.deepEqual(Object.keys(repository).sort(), ['assertReady', 'load', 'logicalKey', 'recover', 'updateCase', 'updateDocument', 'updateEvent']);
});

test('invalid version, cases, events and lastScan fail closed', () => {
  for (const value of [null, { version: 2, cases: {}, events: [], lastScan: null }, { version: 1, cases: [], events: [], lastScan: null }, { version: 1, cases: {}, events: {}, lastScan: null }, { version: 1, cases: {}, events: [] }, { version: 1, cases: {}, events: [], lastScan: 'today' }]) assert.equal(validateQueue(value), false);
  assert.equal(validateQueue(queue()), true);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: durable claim, restart recovery, CAS and exact journal replay', { skip: !integrationUrl }, async t => {
  const parsed = new URL(integrationUrl), databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  assert.match(databaseName, /^pult_test_[a-z0-9]+$/u, 'PULT_TEST_DATABASE_URL must name a disposable pult_test database');
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 4 });
  const schema = `b2b_queue_test_${crypto.randomBytes(8).toString('hex')}`;
  let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  const existing = await pool.query('SELECT to_regnamespace($1)::text AS namespace', [schema]);
  assert.equal(existing.rows[0].namespace, null);
  await pool.query(require('../storage/postgres-schema.cjs').replace(/\bpult\b/gu, schema)); owned = true;
  await pool.query(require('../storage/postgres-document-schema.cjs').replace(/\bpult\b/gu, schema));
  const stateStore = createStateStore({ pool, schema });
  const firstStore = createPostgresB2BQueue({ stateStore }), secondStore = createPostgresB2BQueue({ stateStore });
  const absent = await firstStore.load();
  assert.deepEqual({ revision: absent.revision, exists: absent.exists, key: firstStore.logicalKey }, { revision: '0', exists: false, key: sourceKey('b2b-agent/queue.json') });
  const created = await firstStore.updateCase(absent, { caseId: '1', value: { id: '1', incomingId: 'mail-1', status: 'draft' }, commandId: command('1') });
  assert.equal(created.revision, '1');
  const freshA = await firstStore.load(), freshB = await secondStore.load();
  assert.deepEqual(freshA, freshB);
  const sending = await firstStore.updateCase(freshA, { caseId: '1', value: { ...freshA.value.cases['1'], status: 'sending', attemptId: 'attempt-1' }, commandId: command('2') });
  assert.equal(sending.revision, '2');
  const storedSending = await pool.query(`SELECT logical_key,revision::text AS revision,content FROM "${schema}".document_states WHERE logical_key=$1`, [LOGICAL_KEY]);
  assert.equal(storedSending.rows[0].logical_key, LOGICAL_KEY);
  assert.equal(storedSending.rows[0].revision, '2');
  assert.equal(JSON.parse(storedSending.rows[0].content).messageClaims['mail-1'].status, 'sending');
  const restarted = createPostgresB2BQueue({ stateStore }), beforeRecovery = await restarted.load();
  const recovered = await restarted.recover(beforeRecovery, { commandId: command('3') });
  assert.equal(recovered.revision, '3');
  assert.equal((await restarted.load()).value.cases['1'].status, 'uncertain');
  await assert.rejects(secondStore.updateCase(freshB, { caseId: '1', value: { ...freshB.value.cases['1'], status: 'sending' }, commandId: command('4') }), error => error.code === 'REVISION_CONFLICT');
  const recoverySnapshot = await restarted.load(), auditRequest = { event: event('recovered'), commandId: command('5') };
  const audited = await restarted.updateEvent(recoverySnapshot, auditRequest), replay = await restarted.updateEvent(recoverySnapshot, auditRequest);
  assert.deepEqual({ revision: audited.revision, replayed: audited.replayed }, { revision: '4', replayed: false });
  assert.deepEqual({ revision: replay.revision, replayed: replay.replayed }, { revision: '4', replayed: true });
  const commands = await pool.query(`SELECT command_id::text AS command_id,logical_key,before_revision::text AS before_revision,after_revision::text AS after_revision FROM "${schema}".commands ORDER BY sequence`);
  assert.deepEqual(commands.rows, [
    [command('1'), '0', '1'], [command('2'), '1', '2'], [command('3'), '2', '3'], [command('5'), '3', '4']
  ].map(([commandId, beforeRevision, afterRevision]) => ({ command_id: commandId, logical_key: LOGICAL_KEY, before_revision: beforeRevision, after_revision: afterRevision })));
});
