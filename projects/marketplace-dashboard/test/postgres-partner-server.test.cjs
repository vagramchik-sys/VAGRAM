'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { start, cookieName } = require('../storage/domains/postgres-partner-server.cjs');
const createWorkspace = require('../storage/domains/postgres-partner-workspace.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');
const protect = async (value, decrypt) => decrypt ? Buffer.from(value.slice(6), 'base64').toString() : 'dpapi:' + Buffer.from(value).toString('base64');
async function staticDir(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'partner-sql-static-')); await Promise.all(['partner.html', 'partner.js', 'partner.css'].map(name => fs.writeFile(path.join(dir, name), name))); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
async function launch(t, workspace) { const server = await start({ workspace, staticDir: await staticDir(t), port: 0 }); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })); return { server, origin: server.partnerOrigin }; }
async function post(origin, route, value, headers = {}) { return fetch(origin + route, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) }); }
async function login(origin, credential) { const response = await post(origin, '/api/partner/login', { credential }); assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0]; }

test('loopback server preserves origin, cookie, headers, allowlist and passes actual session', async t => {
  const credential = 'x'.repeat(43), auth = { partnerId: 'p', credentialVersion: 2 }; let passed;
  const workspace = { async authenticateCredential(value) { return value === credential ? auth : null; }, async authorizeSession(session) { return session.partnerId === 'p' && session.credentialVersion === 2; }, async snapshotForPartner(id, session) { passed = session; return { partner: { id }, products: [] }; } };
  const { origin } = await launch(t, workspace), cookie = await login(origin, credential);
  const response = await fetch(origin + '/api/partner/dashboard', { headers: { cookie } }); assert.equal(response.status, 200); assert.equal(passed.partnerId, 'p'); assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal((await post(origin, '/api/partner/login', { credential }, { origin: 'http://attacker.invalid' })).status, 403);
  assert.equal((await fetch(origin + '/api/partners/state', { headers: { cookie } })).status, 404);
  await assert.rejects(start({ workspace, host: '0.0.0.0' }), /127\.0\.0\.1/u);
});

test('fresh authorization before and after await denies revoked sessions and redacts dependency errors', async t => {
  const credential = 'y'.repeat(43); let valid = true, checks = 0;
  const workspace = { async authenticateCredential() { return { partnerId: 'p', credentialVersion: 1 }; }, async authorizeSession() { checks++; if (checks === 2) valid = false; return valid; }, async snapshotForPartner() { throw Error('secret-canary'); } };
  const { origin } = await launch(t, workspace), cookie = await login(origin, credential);
  const denied = await fetch(origin + '/api/partner/dashboard', { headers: { cookie } }); assert.equal(denied.status, 401); assert.equal((await denied.text()).includes('secret-canary'), false);
  assert.equal((await fetch(origin + '/api/partner/dashboard', { headers: { cookie: `${cookieName}=bad` } })).status, 401);
});

test('dependency cannot disclose a canary by forging public status fields', async t => {
  const canary = 'dependency-secret-canary';
  const workspace = { async authenticateCredential() { throw Object.assign(Error(canary), { public: true, status: 400 }); }, async authorizeSession() { return false; }, async snapshotForPartner() {} };
  const { origin } = await launch(t, workspace), response = await post(origin, '/api/partner/login', { credential: 'z'.repeat(43) });
  assert.equal(response.status, 503); assert.equal((await response.text()).includes(canary), false);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL HTTP integration authenticates fresh state and revocation closes an existing cookie', { skip: !integrationUrl }, async t => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /^pult_test_/u);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 4 }), schema = `partner_server_${crypto.randomBytes(8).toString('hex')}`; let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  await pool.query(require('../storage/postgres-schema.cjs').replace(/\bpult\b/gu, schema)); owned = true; await pool.query(require('../storage/postgres-document-schema.cjs').replace(/\bpult\b/gu, schema));
  const stateStore = createStateStore({ pool, schema }), workspace = createWorkspace({ stateStore, getProducts: async () => [{ key: 'a:1', market: 'Ozon', name: 'A' }], protect });
  let partner = await workspace.savePartner({ name: 'SQL', productKeys: ['a:1'], active: true }, { commandId: crypto.randomUUID(), timestamp: '2026-09-22T12:00:00Z' });
  const issued = await workspace.issueCredential({ id: partner.id, version: partner.version }, { commandId: crypto.randomUUID(), timestamp: '2026-09-22T12:00:01Z' });
  const { origin } = await launch(t, workspace), cookie = await login(origin, issued.credential);
  const dashboard = await fetch(origin + '/api/partner/dashboard', { headers: { cookie } }); assert.equal(dashboard.status, 200); const value = await dashboard.json(); assert.deepEqual(value.products.map(row => row.key), ['a:1']); assert.equal(JSON.stringify(value).includes('credential'), false);
  partner = await workspace.revokeCredential({ id: partner.id, version: issued.partner.version }, { commandId: crypto.randomUUID(), timestamp: '2026-09-22T12:00:02Z' });
  assert.equal((await fetch(origin + '/api/partner/dashboard', { headers: { cookie } })).status, 401);
});
