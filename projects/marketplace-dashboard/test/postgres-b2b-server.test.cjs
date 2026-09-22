'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { startPostgresB2BServer, LOGICAL_KEY, SOURCE_MAPPING, MEDIA_TYPE } = require('../storage/domains/postgres-b2b-server.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');

const command = value => `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;
function protection() {
  let encryptions = 0;
  return { get encryptions() { return encryptions; }, async protect(value, decrypt = false) {
    if (decrypt) return Buffer.from(String(value).slice(4), 'base64').toString('utf8');
    encryptions++; return 'enc:' + Buffer.from(value).toString('base64');
  } };
}
function stateFixture(initial = null, { unknownOnce = false } = {}) {
  const withHash = value => value && !value.deleted ? { ...value, sha256: crypto.createHash('sha256').update(value.content).digest() } : value;
  let record = withHash(initial), uncertain = unknownOnce; const commands = new Map(), writes = [], writeOptions = [];
  return { writes, writeOptions, replace(value) { record = withHash(value); }, async read(key, options) { assert.equal(key, LOGICAL_KEY); assert.deepEqual(options, { includeDeleted: true }); return record; }, async readCommand(key, id, options) { assert.equal(key, LOGICAL_KEY); assert.deepEqual(options.sourceMapping, SOURCE_MAPPING); return commands.get(id) || null; },
    async write(key, content, options) {
      assert.equal(key, LOGICAL_KEY); assert.equal(options.mediaType, MEDIA_TYPE); assert.deepEqual(options.sourceMapping, SOURCE_MAPPING);
      const before = record ? { ...record } : { revision: '0', mediaType: null, content: null, deleted: null };
      record = withHash({ revision: String(BigInt(options.expectedRevision) + 1n), mediaType: MEDIA_TYPE, content: Buffer.from(content), deleted: false });
      commands.set(options.commandId, { before, after: { ...record } }); writes.push(Buffer.from(content)); writeOptions.push(options);
      if (uncertain) { uncertain = false; throw Object.assign(Error('secret database detail'), { code: 'OUTCOME_UNKNOWN' }); }
      return { revision: record.revision, replayed: false };
    }
  };
}
function poolFixture(order) {
  const client = new EventEmitter(); client.destroyed = false;
  client.query = async sql => { order.push(sql.includes('unlock') ? 'unlock' : 'lock'); return { rows: [{ [sql.includes('unlock') ? 'unlocked' : 'acquired']: true }] }; };
  client.release = destroy => { client.destroyed = destroy === true; order.push('release'); };
  return { client, async connect() { order.push('connect'); return client; } };
}
function queueFixture() {
  const value = { version: 1, cases: {}, events: [], lastScan: null };
  return { async load() { return { revision: '0', value, exists: false }; }, assertReady() { return true; }, async updateEvent() {} };
}
function dependencies({ state = stateFixture(), protect = protection(), runnerOrder = [], poolOrder = [], crmCalls = [] } = {}) {
  const pool = poolFixture(poolOrder), queue = queueFixture();
  const createRunner = async config => { runnerOrder.push({ ...config }); return { busy: false, async scan() { return { read: 0 }; }, async draft() {}, async processBatch() { return { processed: 0 }; } }; };
  return { state, protect, poolOrder, runnerOrder, crmCalls, options: { port: 0, pool, stateStore: state, queue, createRunner, protect: protect.protect.bind(protect), createCrm() { return { async listDealStages() { crmCalls.push('stages'); return [{ STATUS_ID: 'C6:NEW', NAME: 'New' }]; } }; }, createOneC() { return {}; }, modelStatus: async () => ({ available: false, models: [] }), extract: async () => ({ intent: 'other', summary: '', items: [], missing: [], needsHuman: false }), buildDraft: value => value } };
}
async function request(app, pathname, { method = 'GET', data, commandId, token = app.nonce, origin = app.origin, host } = {}) {
  const target = new URL(pathname, app.origin), body = data === undefined ? null : JSON.stringify(data);
  const headers = { host: host || target.host };
  if (method === 'POST') { headers.origin = origin; headers['x-b2b-token'] = token; headers['content-type'] = 'application/json'; if (commandId) headers['x-b2b-command-id'] = commandId; }
  if (body) headers['content-length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const req = http.request(target, { method, headers }, response => { let raw = ''; response.setEncoding('utf8'); response.on('data', chunk => { raw += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(raw) })); });
    req.on('error', reject); req.end(body);
  });
}

test('lease and encrypted config recovery complete before listen; startup is passive', async t => {
  const p = protection();
  const clear = { categoryId: '9', webhook: 'synthetic-secret', pollEnabled: true, sendEnabled: true };
  const encrypted = Buffer.from(await p.protect(JSON.stringify(clear)));
  const d = dependencies({ protect: p, state: stateFixture({ revision: '3', mediaType: MEDIA_TYPE, content: encrypted, deleted: false }) });
  const app = await startPostgresB2BServer(d.options); t.after(() => app.close());
  assert.deepEqual(d.poolOrder.slice(0, 2), ['connect', 'lock']);
  assert.equal(d.runnerOrder[0].pollEnabled, false); assert.equal(d.runnerOrder[0].sendEnabled, false);
  const view = await request(app, '/api/state');
  assert.equal(view.status, 200); assert.equal(view.body.config.pollEnabled, false); assert.equal(view.body.config.sendEnabled, false);
  assert.equal(JSON.stringify(view.body).includes('synthetic-secret'), false);
  assert.equal((await request(app, '/api/leads', { method: 'POST', data: { enabled: false }, commandId: command('c') })).status, 200);
  assert.equal(d.runnerOrder.at(-1).pollEnabled, false);
});

test('same-origin and nonce checks remain closed and there is no send route', async t => {
  const d = dependencies(), app = await startPostgresB2BServer(d.options); t.after(() => app.close());
  assert.equal((await request(app, '/api/scan', { method: 'POST', data: {}, origin: 'http://example.test' })).status, 403);
  assert.equal((await request(app, '/api/scan', { method: 'POST', data: {}, token: 'wrong' })).status, 403);
  assert.equal((await request(app, '/api/send', { method: 'POST', data: {} })).status, 404);
  assert.equal((await request(app, '/api/state', { host: 'localhost' })).status, 403);
  assert.equal((await request(app, '/api/scan', { method: 'POST', data: null })).status, 400);
  assert.equal((await request(app, '/api/scan', { method: 'POST', data: [] })).status, 400);
});

test('unrelated mutation preserves fresher SQL settings while session polling stays passive', async t => {
  const p = protection(), state = stateFixture(), d = dependencies({ protect: p, state });
  const app = await startPostgresB2BServer(d.options); t.after(() => app.close());
  const external = { categoryId: '6', newStageId: 'C6:NEW', newLeadStatusId: 'NEW', leadsEnabled: true, autoDraftEnabled: true, model: 'external-model', sendEnabled: false, pollEnabled: true, pollMinutes: 7, webhook: 'synthetic' };
  const bytes = Buffer.from(await p.protect(JSON.stringify(external)));
  state.replace({ revision: '9', mediaType: MEDIA_TYPE, content: bytes, deleted: false });
  assert.equal((await request(app, '/api/processing', { method: 'POST', data: { enabled: false }, commandId: command('7') })).status, 200);
  const active = await request(app, '/api/state');
  assert.equal(active.body.config.model, 'external-model'); assert.equal(active.body.config.autoDraftEnabled, false); assert.equal(active.body.config.pollEnabled, false);
  const persisted = JSON.parse(await p.protect(state.writes.at(-1).toString('utf8'), true));
  assert.equal(persisted.model, 'external-model'); assert.equal(persisted.pollEnabled, true);
  assert.equal((await request(app, '/api/poll', { method: 'POST', data: { enabled: true }, commandId: command('6') })).status, 200);
  assert.equal((await request(app, '/api/state')).body.config.pollEnabled, true);
});

test('settings commit exact ciphertext before activation and same command replays without re-encryption', async t => {
  const d = dependencies(), app = await startPostgresB2BServer(d.options); t.after(() => app.close());
  const id = command('a'), data = { webhook: 'synthetic-webhook', categoryId: '6', newStageId: 'C6:NEW', model: 'synthetic' };
  const first = await request(app, '/api/connect', { method: 'POST', data, commandId: id });
  assert.equal(first.status, 200); assert.equal(d.state.writes.length, 1); assert.equal(d.protect.encryptions, 1);
  assert.equal(d.runnerOrder.at(-1).webhook, 'synthetic-webhook');
  const exact = Buffer.from(d.state.writes[0]);
  const replay = await request(app, '/api/connect', { method: 'POST', data, commandId: id });
  assert.equal(replay.status, 200); assert.equal(d.state.writes.length, 1); assert.equal(d.protect.encryptions, 1); assert.deepEqual(d.state.writes[0], exact);
  assert.equal((await request(app, '/api/processing', { method: 'POST', data: { enabled: false }, commandId: command('d') })).status, 200);
  assert.equal((await request(app, '/api/connect', { method: 'POST', data, commandId: id })).status, 200);
  const current = await request(app, '/api/state'); assert.equal(current.body.config.autoDraftEnabled, false);
  assert.equal(d.crmCalls.length, 1, 'committed connect replay skips external CRM validation');
});

test('unknown commit is redacted and retry uses journal without encrypting or sending twice', async t => {
  const d = dependencies({ state: stateFixture(null, { unknownOnce: true }) }), app = await startPostgresB2BServer(d.options); t.after(() => app.close());
  const id = command('b'), data = { enabled: false };
  const first = await request(app, '/api/leads', { method: 'POST', data, commandId: id });
  assert.equal(first.status, 400); assert.match(first.body.error, /неизвестен/u); assert.equal(JSON.stringify(first.body).includes('secret'), false);
  const replay = await request(app, '/api/leads', { method: 'POST', data, commandId: id });
  assert.equal(replay.status, 200); assert.equal(d.state.writes.length, 1); assert.equal(d.protect.encryptions, 1);
});

test('lease is destroyed on initialization failure and normally unlocked on close', async () => {
  const failed = dependencies(); failed.options.createRunner = async () => { throw Error('synthetic recovery failure'); };
  await assert.rejects(startPostgresB2BServer(failed.options), /synthetic recovery failure/u);
  assert.equal(failed.options.pool.client.destroyed, true);
  const normal = dependencies(), app = await startPostgresB2BServer(normal.options); await app.close();
  assert.deepEqual(normal.poolOrder.slice(-2), ['unlock', 'release']); assert.equal(normal.options.pool.client.destroyed, false);
});

test('dependency errors never expose arbitrary messages and lease loss stops accepting requests', async () => {
  const secret = 'https://secret.invalid/token-value', d = dependencies();
  d.options.extract = async () => { throw Error(secret); };
  const app = await startPostgresB2BServer(d.options);
  const failed = await request(app, '/api/demo', { method: 'POST', data: {} });
  assert.equal(failed.status, 400); assert.equal(JSON.stringify(failed.body).includes(secret), false); assert.equal(failed.body.error, 'Операция не выполнена');
  d.options.pool.client.emit('error', Error(secret));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.server.listening, false);
  await app.close(); assert.equal(d.options.pool.client.destroyed, true);
});

test('lease loss during an awaited poll drains the cycle and writes no later error event', async () => {
  const p = protection(), initialConfig = { categoryId: '6', newStageId: 'C6:NEW', newLeadStatusId: 'NEW', leadsEnabled: true, autoDraftEnabled: true, model: 'm', sendEnabled: false, pollEnabled: false, pollMinutes: 5, webhook: 'synthetic' };
  const bytes = Buffer.from(await p.protect(JSON.stringify(initialConfig))), state = stateFixture({ revision: '1', mediaType: MEDIA_TYPE, content: bytes, deleted: false });
  const d = dependencies({ protect: p, state }); let tick, entered, resolveScan, events = 0, processed = 0;
  const scanEntered = new Promise(resolve => { entered = resolve; });
  d.options.setInterval = callback => { tick = callback; return { unref() {} }; }; d.options.clearInterval = () => {};
  d.options.queue.updateEvent = async () => { events++; };
  d.options.createRunner = async () => ({ busy: false, async scan() { entered(); return new Promise(resolve => { resolveScan = resolve; }); }, async processBatch() { processed++; }, async draft() {} });
  const app = await startPostgresB2BServer(d.options);
  assert.equal((await request(app, '/api/poll', { method: 'POST', data: { enabled: true }, commandId: command('5') })).status, 200);
  const cycle = tick(); await scanEntered; d.options.pool.client.emit('error', Error('lost lease'));
  let closed = false; const closing = app.close().then(() => { closed = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  resolveScan(); await cycle; await closing;
  assert.equal(processed, 0); assert.equal(events, 0); assert.equal(d.options.pool.client.destroyed, true);
});

test('lease loss while loading an error snapshot prevents the event mutation', async () => {
  const p = protection(), initialConfig = { categoryId: '6', newStageId: 'C6:NEW', newLeadStatusId: 'NEW', leadsEnabled: true, autoDraftEnabled: true, model: 'm', sendEnabled: false, pollEnabled: false, pollMinutes: 5, webhook: 'synthetic' };
  const bytes = Buffer.from(await p.protect(JSON.stringify(initialConfig))), d = dependencies({ protect: p, state: stateFixture({ revision: '1', mediaType: MEDIA_TYPE, content: bytes, deleted: false }) });
  let tick, loadEntered, resolveLoad, events = 0; const entered = new Promise(resolve => { loadEntered = resolve; });
  d.options.setInterval = callback => { tick = callback; return { unref() {} }; }; d.options.clearInterval = () => {};
  d.options.queue.load = async () => { loadEntered(); return new Promise(resolve => { resolveLoad = () => resolve({ revision: '0', value: { version: 1, cases: {}, events: [], lastScan: null } }); }); };
  d.options.queue.updateEvent = async () => { events++; };
  d.options.createRunner = async () => ({ busy: false, async scan() { throw Error('synthetic'); }, async processBatch() {}, async draft() {} });
  const app = await startPostgresB2BServer(d.options);
  assert.equal((await request(app, '/api/poll', { method: 'POST', data: { enabled: true }, commandId: command('4') })).status, 200);
  const cycle = tick(); await entered; d.options.pool.client.emit('error', Error('lost lease')); resolveLoad(); await cycle; await app.close();
  assert.equal(events, 0);
});

test('deleted configuration keeps its SQL revision and corrupt ciphertext fails before listen', async () => {
  const tombstone = stateFixture({ revision: '7', mediaType: MEDIA_TYPE, content: null, sha256: null, deleted: true });
  const d = dependencies({ state: tombstone }), app = await startPostgresB2BServer(d.options);
  assert.equal((await request(app, '/api/leads', { method: 'POST', data: { enabled: false }, commandId: command('f') })).status, 200);
  assert.equal(tombstone.writeOptions[0].expectedRevision, '7'); await app.close();
  const corrupt = stateFixture({ revision: '1', mediaType: MEDIA_TYPE, content: Buffer.from([0xff]), deleted: false });
  corrupt.read = async () => ({ revision: '1', mediaType: MEDIA_TYPE, content: Buffer.from([0xff]), sha256: crypto.createHash('sha256').update(Buffer.from([0xff])).digest(), deleted: false });
  await assert.rejects(startPostgresB2BServer(dependencies({ state: corrupt }).options), error => error.code === 'INVALID_CONFIG');
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL HTTP integration: lease, ciphertext journal, replay authority and failed mutations', { skip: !integrationUrl }, async t => {
  const parsed = new URL(integrationUrl), databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  assert.match(databaseName, /^pult_test_[a-z0-9]+$/u);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 8 });
  const schema = `b2b_server_test_${crypto.randomBytes(8).toString('hex')}`; let owned = false, app;
  t.after(async () => { if (app) await app.close(); if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  assert.equal((await pool.query('SELECT to_regnamespace($1)::text AS namespace', [schema])).rows[0].namespace, null);
  await pool.query(require('../storage/postgres-schema.cjs').replace(/\bpult\b/gu, schema)); owned = true;
  await pool.query(require('../storage/postgres-document-schema.cjs').replace(/\bpult\b/gu, schema));
  const realState = createStateStore({ pool, schema }), p = protection(), queue = queueFixture();
  const unknown = command('8'), stale = command('9');
  const stateStore = { ...realState, async write(key, content, options) {
    if (options.commandId === stale) throw Object.assign(Error('postgres secret detail'), { code: 'REVISION_CONFLICT' });
    const result = await realState.write(key, content, options);
    if (options.commandId === unknown) throw Object.assign(Error('postgres secret detail'), { code: 'OUTCOME_UNKNOWN' });
    return result;
  } };
  let crmCalls = 0;
  const options = { port: 0, pool, stateStore, queue, protect: p.protect.bind(p),
    createRunner: async config => ({ busy: false, config, async scan() {}, async draft() {}, async processBatch() {} }),
    createCrm: webhook => ({ async listDealStages() { crmCalls++; if (webhook.includes('canary')) throw Error(webhook); return [{ STATUS_ID: 'C6:NEW', NAME: 'New' }]; } }),
    createOneC: () => ({}), modelStatus: async () => ({ available: false, models: [] }), extract: async () => ({}), buildDraft: value => value };
  app = await startPostgresB2BServer(options);
  await assert.rejects(startPostgresB2BServer(options), error => error.code === 'ALREADY_RUNNING');
  const connectId = command('1'), connectData = { webhook: 'https://synthetic.invalid/hook', categoryId: '6', newStageId: 'C6:NEW' };
  assert.equal((await request(app, '/api/connect', { method: 'POST', data: connectData, commandId: connectId })).status, 200);
  const stored = await pool.query(`SELECT d.content,s.source_path,c.command_id::text FROM "${schema}".document_states d JOIN "${schema}".source_files s USING(logical_key) JOIN "${schema}".commands c USING(logical_key) WHERE d.logical_key=$1`, [LOGICAL_KEY]);
  const journal = await realState.readCommand(LOGICAL_KEY, connectId, { operation: 'write', sourceMapping: SOURCE_MAPPING });
  assert.equal(stored.rowCount, 1); assert.deepEqual(Buffer.from(stored.rows[0].content), journal.after.content);
  assert.equal(stored.rows[0].source_path, 'b2b-agent/connection.dpapi'); assert.equal(stored.rows[0].command_id, connectId);
  assert.equal((await request(app, '/api/processing', { method: 'POST', data: { enabled: false }, commandId: command('2') })).status, 200);
  assert.equal((await request(app, '/api/connect', { method: 'POST', data: connectData, commandId: connectId })).status, 200);
  assert.equal((await request(app, '/api/state')).body.config.autoDraftEnabled, false); assert.equal(crmCalls, 1);
  const unknownResponse = await request(app, '/api/poll', { method: 'POST', data: { enabled: true }, commandId: unknown });
  assert.equal(unknownResponse.status, 400); assert.equal((await request(app, '/api/state')).body.config.pollEnabled, false);
  const staleResponse = await request(app, '/api/processing', { method: 'POST', data: { enabled: true }, commandId: stale });
  assert.equal(staleResponse.status, 400); assert.equal(JSON.stringify(staleResponse.body).includes('postgres secret'), false);
  const canary = 'https://canary.invalid/raw-token';
  const rejected = await request(app, '/api/connect', { method: 'POST', data: { ...connectData, webhook: canary }, commandId: command('3') });
  assert.equal(rejected.status, 400); assert.equal(JSON.stringify(rejected.body).includes(canary), false);
});
