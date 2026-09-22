'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPostgresB2BQueue } = require('../storage/postgres-b2b-queue.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');
const { createPostgresB2BRunner, stableCommandId } = require('../storage/domains/postgres-b2b-runner.cjs');
const { prepareCase, buildDraft, digest } = require('../b2b-agent/core.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest();
const config = { categoryId: '6', newStageId: 'C6:NEW', leadsEnabled: false, sendEnabled: true, sender: 'sales@example.test', model: 'synthetic' };
const deal = { ID: '12', TITLE: 'Synthetic', CATEGORY_ID: '6', STAGE_ID: 'C6:NEW', CLOSED: 'N' };
const mail = { id: 42, direction: 'incoming', createdAt: '2026-09-18T11:00:00Z', updatedAt: '2026-09-18T11:00:00Z', body: 'Synthetic request', subject: 'Request', files: [], communications: [{ type: 'EMAIL', value: 'buyer@example.test' }] };
const parsed = { intent: 'clarification', summary: 'Synthetic', items: [], missing: ['quantity'], needsHuman: false };
const command = value => `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;

function memoryState(initial) {
  let current = null;
  const commands = new Map();
  if (initial) {
    const content = Buffer.from(JSON.stringify(initial));
    current = { revision: '1', deleted: false, mediaType: 'application/json', content, sha256: hash(content) };
  }
  return {
    async read() { return current; },
    async write(key, content, options) {
      const request = JSON.stringify([key, options.expectedRevision, content.toString('base64')]), prior = commands.get(options.commandId);
      if (prior) {
        if (prior.request !== request) throw Object.assign(Error('reused'), { code: 'COMMAND_ID_REUSED' });
        return { revision: prior.revision, replayed: true };
      }
      if ((current?.revision || '0') !== options.expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' });
      const revision = String(BigInt(options.expectedRevision) + 1n);
      current = { revision, deleted: false, mediaType: options.mediaType, content: Buffer.from(content), sha256: hash(content) };
      commands.set(options.commandId, { request, revision });
      return { revision, replayed: false };
    },
    async remove() { throw Error('unused'); }
  };
}

const baseQueue = cases => ({ version: 1, cases, events: [], lastScan: null });
function approvedRow() {
  const prepared = prepareCase({ deal, activities: [mail], config });
  const draft = buildDraft(parsed);
  const row = { ...prepared, status: 'approved', mailMessageId: '55', threadVerified: true, draft };
  delete row.responsibleId;
  row.approvedFingerprint = digest([row.fingerprint, row.draft.body, row.recipient, row.mailMessageId]);
  return row;
}
function crm() {
  return {
    async readDeal() { return deal; }, async readEmailActivities() { return [mail]; },
    async readCandidates() { return [deal]; }, async readLeadCandidates() { return []; },
    async readMailMessage(id) { return { id }; }
  };
}
const create = (queue, overrides = {}) => createPostgresB2BRunner({ queue, config, crm: crm(), extractImpl: async () => parsed, ...overrides });

test('initialization durably recovers sending before any send can run', async () => {
  const state = memoryState(baseQueue({ '12': { ...approvedRow(), status: 'sending', attemptId: 'old' } }));
  const queue = createPostgresB2BQueue({ stateStore: state }); let sends = 0;
  const runner = await create(queue, { replyEmail: async () => { sends++; return { success: true }; } });
  assert.equal((await queue.load()).value.cases['12'].status, 'uncertain');
  await assert.rejects(runner.send('12'));
  assert.equal(sends, 0);
});

test('command identifiers are stable for one logical transition and differ across transitions', () => {
  assert.equal(stableCommandId('sending', '2', '12', 'attempt'), stableCommandId('sending', '2', '12', 'attempt'));
  assert.notEqual(stableCommandId('sending', '2', '12', 'attempt'), stableCommandId('sent', '2', '12', 'attempt'));
  assert.match(stableCommandId('sending', '2', '12', 'attempt'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});

test('sending and claim are durable before callback; success stores sent and event in one CAS', async () => {
  const state = memoryState(baseQueue({ '12': approvedRow() })), queue = createPostgresB2BQueue({ stateStore: state });
  let sends = 0;
  const runner = await create(queue, { replyEmail: async () => {
    sends++;
    const during = await queue.load();
    assert.equal(during.value.cases['12'].status, 'sending');
    assert.deepEqual(during.value.messageClaims['42'], { ownerId: '12', status: 'sending' });
    return { success: true };
  } });
  assert.equal((await runner.send('12')).status, 'sent');
  const after = await queue.load();
  assert.equal(after.value.cases['12'].status, 'sent');
  assert.equal(after.value.events[0].kind, 'sent');
  assert.deepEqual(after.value.messageClaims['42'], { ownerId: '12', status: 'sent' });
  assert.equal(sends, 1);
});

test('ambiguous callback becomes durable uncertain and is never automatically sent again', async () => {
  const state = memoryState(baseQueue({ '12': approvedRow() })), queue = createPostgresB2BQueue({ stateStore: state }); let sends = 0;
  const runner = await create(queue, { replyEmail: async () => { sends++; throw Error('synthetic timeout'); } });
  assert.equal((await runner.send('12')).status, 'uncertain');
  const after = await queue.load();
  assert.equal(after.value.events[0].kind, 'uncertain');
  await assert.rejects(runner.send('12'));
  assert.equal(sends, 1);
});

test('two initialized runners racing the same case permit exactly one external send', async () => {
  const state = memoryState(baseQueue({ '12': approvedRow() })), queueA = createPostgresB2BQueue({ stateStore: state }), queueB = createPostgresB2BQueue({ stateStore: state });
  let sends = 0;
  const replyEmail = async () => { sends++; await new Promise(resolve => setImmediate(resolve)); return { success: true }; };
  const [a, b] = await Promise.all([create(queueA, { replyEmail }), create(queueB, { replyEmail })]);
  const results = await Promise.allSettled([a.send('12'), b.send('12')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(sends, 1);
  assert.equal((await queueA.load()).value.cases['12'].status, 'sent');
});

test('failed durable claim prevents callback and is not automatically retried', async () => {
  const state = memoryState(baseQueue({ '12': approvedRow() })), realQueue = createPostgresB2BQueue({ stateStore: state }); let sends = 0;
  const queue = { ...realQueue, async updateCase(snapshot, options) { if (options.value.status === 'sending') throw Object.assign(Error('unknown'), { code: 'OUTCOME_UNKNOWN' }); return realQueue.updateCase(snapshot, options); } };
  const runner = await create(queue, { replyEmail: async () => { sends++; return { success: true }; } });
  await assert.rejects(runner.send('12'), error => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(sends, 0);
});

test('draft failure is durably stopped before it is reported to the caller', async () => {
  const row = { ...prepareCase({ deal, activities: [mail], config }), body: mail.body };
  const state = memoryState(baseQueue({ '12': row })), queue = createPostgresB2BQueue({ stateStore: state });
  const runner = await createPostgresB2BRunner({ queue, config, crm: crm(), extractImpl: async () => { throw Error('synthetic model failure'); } });
  await assert.rejects(runner.draft('12'), /synthetic model failure/u);
  const after = await queue.load();
  assert.equal(after.value.cases['12'].status, 'needs_data');
  assert.equal(after.value.events[0].kind, 'draft_error');
});

test('disabled leads and missing CRM fail before extraction or other external calls', async () => {
  const lead = { id: 'lead:9', entityType: 'lead', entityId: '9', status: 'queued', body: 'Synthetic', recipient: 'buyer@example.test', fingerprint: 'lead-fingerprint' };
  const state = memoryState(baseQueue({ 'lead:9': lead })), queue = createPostgresB2BQueue({ stateStore: state });
  let extracts = 0, crmReads = 0;
  const runner = await createPostgresB2BRunner({ queue, config, crm: { async readLead() { crmReads++; return {}; }, async readLeadEmailActivities() { crmReads++; return []; } }, extractImpl: async () => { extracts++; return parsed; } });
  await assert.rejects(runner.draft('lead:9'), error => error.code === 'LEADS_DISABLED');
  assert.deepEqual({ extracts, crmReads }, { extracts: 0, crmReads: 0 });
  const withoutCrm = await createPostgresB2BRunner({ queue, config, extractImpl: async () => { extracts++; return parsed; } });
  await assert.rejects(withoutCrm.processBatch(), error => error.code === 'CRM_UNAVAILABLE');
  assert.equal(extracts, 0);
});

test('successful manual retry leaves needs_data and persists exact parsed extraction', async () => {
  const row = { ...prepareCase({ deal, activities: [mail], config }), status: 'needs_data', reasons: ['Synthetic previous failure'] };
  const state = memoryState(baseQueue({ '12': row })), queue = createPostgresB2BQueue({ stateStore: state });
  const runner = await create(queue);
  const result = await runner.draft('12');
  assert.equal(result.status, 'draft');
  assert.deepEqual(result.extraction, parsed);
});

test('invalid protected claim is rejected during initialization before external callbacks', async () => {
  const value = baseQueue({ '12': { ...approvedRow(), status: 'sent', incomingId: '42' } });
  value.messageClaims = { '42': { ownerId: '99', status: 'sent' } };
  const queue = createPostgresB2BQueue({ stateStore: memoryState(value) });
  let external = 0;
  await assert.rejects(createPostgresB2BRunner({ queue, config, crm: { async readDeal() { external++; } }, extractImpl: async () => { external++; }, replyEmail: async () => { external++; } }), error => error.code === 'MESSAGE_CLAIMED');
  assert.equal(external, 0);
});

test('scan, draft, processBatch and bindThread retain practical async interfaces', async () => {
  const state = memoryState(baseQueue({})), queue = createPostgresB2BQueue({ stateStore: state });
  const runner = await create(queue);
  const scan = await runner.scan();
  assert.equal(scan.read, 1);
  const loaded = await queue.load();
  assert.equal(loaded.value.cases['12'].status, 'queued');
  assert.equal((await runner.draft('12')).status, 'draft');
  assert.deepEqual(await runner.bindThread('12', '77'), { message: { id: '77' }, caseId: '12', mailMessageId: '77' });
  const batch = await runner.processBatch({ limit: 1 });
  assert.equal(typeof batch.at, 'string');
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: two runners race one claim and unknown commit is never sent', { skip: !integrationUrl }, async t => {
  const parsedUrl = new URL(integrationUrl), databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\//u, ''));
  assert.match(databaseName, /^pult_test_[a-z0-9]+$/u, 'PULT_TEST_DATABASE_URL must name a disposable pult_test database');
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 6 });
  const schema = `b2b_runner_test_${crypto.randomBytes(8).toString('hex')}`;
  let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  const existing = await pool.query('SELECT to_regnamespace($1)::text AS namespace', [schema]);
  assert.equal(existing.rows[0].namespace, null);
  await pool.query(require('../storage/postgres-schema.cjs').replace(/\bpult\b/gu, schema)); owned = true;
  await pool.query(require('../storage/postgres-document-schema.cjs').replace(/\bpult\b/gu, schema));
  const stateStore = createStateStore({ pool, schema });
  const seed = createPostgresB2BQueue({ stateStore });
  await seed.updateCase(await seed.load(), { caseId: '12', value: approvedRow(), commandId: command('d') });

  let waiting = 0, releaseRace;
  const race = new Promise(resolve => { releaseRace = resolve; });
  const wrapRace = queue => ({ ...queue, async updateCase(snapshot, options) {
    if (options.value.status === 'sending') { waiting++; if (waiting === 2) releaseRace(); await race; }
    return queue.updateCase(snapshot, options);
  } });
  let sends = 0;
  const replyEmail = async () => { sends++; return { success: true }; };
  const [runnerA, runnerB] = await Promise.all([
    create(wrapRace(createPostgresB2BQueue({ stateStore })), { replyEmail }),
    create(wrapRace(createPostgresB2BQueue({ stateStore })), { replyEmail })
  ]);
  const raced = await Promise.allSettled([runnerA.send('12'), runnerB.send('12')]);
  assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(sends, 1);
  const durable = await seed.load();
  assert.equal(durable.value.cases['12'].status, 'sent');
  assert.deepEqual(durable.value.messageClaims['42'], { ownerId: '12', status: 'sent' });

  const row13 = { ...approvedRow(), id: '13', entityId: '13', incomingId: '43' };
  await seed.updateCase(durable, { caseId: '13', value: row13, commandId: command('e') });
  const realQueue = createPostgresB2BQueue({ stateStore });
  const uncertainCommit = { ...realQueue, async updateCase(snapshot, options) {
    if (options.value.status === 'sending') throw Object.assign(Error('synthetic hidden detail'), { code: 'OUTCOME_UNKNOWN' });
    return realQueue.updateCase(snapshot, options);
  } };
  const unknownRunner = await create(uncertainCommit, { replyEmail: async () => { sends++; return { success: true }; } });
  await assert.rejects(unknownRunner.send('13'), error => error.code === 'OUTCOME_UNKNOWN');
  await assert.rejects(unknownRunner.send('13'), error => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(sends, 1);
  assert.equal((await seed.load()).value.cases['13'].status, 'approved');
});
