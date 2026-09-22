'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const createTools = require('../storage/domains/postgres-partner-tools.cjs');
const createWorkspace = require('../storage/domains/postgres-partner-workspace.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');
const COMMAND = '11111111-1111-4111-8111-111111111111', TIME = '2026-09-22T12:00:00Z';
const protect = async (value, decrypt) => decrypt ? Buffer.from(value.slice(6), 'base64').toString() : 'dpapi:' + Buffer.from(value).toString('base64');
async function serve(t, tools) { const server = http.createServer(async (req, res) => { if (!await tools.handle(req, res, new URL(req.url, 'http://127.0.0.1'))) res.writeHead(404).end(); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve))); return `http://127.0.0.1:${server.address().port}`; }
async function request(base, route, { method = 'GET', value, auth = true, commandId = COMMAND, timestamp = TIME } = {}) { const response = await fetch(base + route, { method, headers: { ...(auth ? { 'x-owner': 'yes' } : {}), ...(value ? { 'content-type': 'application/json', 'x-pult-command-id': commandId, 'x-pult-command-timestamp': timestamp } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) }); return { status: response.status, body: await response.json() }; }

test('owner authorization precedes awaited reads and mutations require stable caller commands', async t => {
  let calls = 0; const workspace = { async ownerState() { calls++; return { partners: [], capabilities: {} }; }, async savePartner(value, op) { return { ...value, op }; }, async issueCredential() {}, async revokeCredential() {} };
  const base = await serve(t, createTools({ workspace, authorize: async req => req.headers['x-owner'] === 'yes', getAvailability: async () => true }));
  assert.equal((await request(base, '/api/partners/state', { auth: false })).status, 403); assert.equal(calls, 0);
  const state = await request(base, '/api/partners/state'); assert.equal(state.body.capabilities.localListenerAvailable, true);
  assert.equal((await request(base, '/api/partners/save', { method: 'POST', value: { name: 'A', productKeys: [] }, commandId: '' })).status, 400);
  const saved = await request(base, '/api/partners/save', { method: 'POST', value: { name: 'A', productKeys: [] } }); assert.equal(saved.body.op.commandId, COMMAND);
});

test('owner issue is the only response allowed to contain plaintext credential; failures are redacted', async t => {
  const secret = 'credential-plaintext', canary = 'database-canary';
  const workspace = { async ownerState() { throw Error(canary); }, async savePartner() {}, async issueCredential() { return { partner: { id: 'p' }, credential: secret }; }, async revokeCredential() {} };
  const base = await serve(t, createTools({ workspace, authorize: async () => true }));
  const issued = await request(base, '/api/partners/issue-credential', { method: 'POST', value: { id: 'p', version: 1 } }); assert.equal(issued.body.credential, secret); assert.equal(JSON.stringify(issued.body).includes('credentialHash'), false);
  const failed = await request(base, '/api/partners/state'); assert.equal(failed.status, 503); assert.equal(JSON.stringify(failed.body).includes(canary), false);
});

test('tools reject forged public dependency errors without leaking their message', async t => {
  const canary = 'forged-public-secret', workspace = { async ownerState() { throw Object.assign(Error(canary), { public: true, status: 400 }); }, async savePartner() {}, async issueCredential() {}, async revokeCredential() {} };
  const base = await serve(t, createTools({ workspace, authorize: async () => true })), failed = await request(base, '/api/partners/state');
  assert.equal(failed.status, 503); assert.equal(JSON.stringify(failed.body).includes(canary), false);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL tools integration keeps command replay exact and commercial metadata compatible', { skip: !integrationUrl }, async t => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /^pult_test_/u);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 4 }), schema = `partner_tools_${crypto.randomBytes(8).toString('hex')}`; let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  await pool.query(require('../storage/postgres-schema.cjs').replace(/\bpult\b/gu, schema)); owned = true; await pool.query(require('../storage/postgres-document-schema.cjs').replace(/\bpult\b/gu, schema));
  const stateStore = createStateStore({ pool, schema }), workspace = createWorkspace({ stateStore, getProducts: async () => [], protect });
  const base = await serve(t, createTools({ workspace, authorize: async req => req.headers['x-owner'] === 'yes' }));
  const first = await request(base, '/api/partners/save', { method: 'POST', value: { name: 'SQL', productKeys: [] } }); assert.equal(first.status, 200);
  const replay = await request(base, '/api/partners/save', { method: 'POST', value: { name: 'SQL', productKeys: [] } }); assert.deepEqual(replay.body, first.body);
  const changed = await request(base, '/api/partners/save', { method: 'POST', value: { name: 'Changed', productKeys: [] } }); assert.equal(changed.status, 409);
});
