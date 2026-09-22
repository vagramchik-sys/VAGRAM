'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createPostgresFinanceDocumentRoutes } = require('../storage/domains/postgres-finance-document-routes.cjs');
const { start } = require('../server-postgres.cjs');

const COMMAND = '11111111-1111-4111-8111-111111111111';
const TIME = '2026-09-22T12:00:00.000Z';
const PDF = Buffer.from('%PDF-synthetic finance route');

function request(bytes = PDF, headers = {}) {
  return Object.assign(Readable.from([bytes]), { method: 'POST', headers: {
    'content-type': 'application/pdf', 'x-file-name': 'contract.pdf',
    'x-pult-command-id': COMMAND, 'x-pult-command-timestamp': TIME, ...headers,
  } });
}
function response() {
  return { status: null, headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers || {}; return this; }, end(value) { this.body = value ? JSON.parse(value) : null; } };
}

test('route reads raw bytes, requires stable headers, and coalesces concurrent identical commands', async () => {
  let uploads = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const documents = { async drafts() { return [{ id: 'synthetic' }]; }, async upload(input) { uploads++; if (uploads === 1) { assert.deepEqual(input.exactBytes, PDF); await gate; } return { id: 'synthetic', replayed: false }; } };
  const routes = createPostgresFinanceDocumentRoutes({ documents, authorize: async () => true });
  const url = new URL('http://local/api/finance/contracts'), a = response(), b = response();
  const first = routes.handle(request(), a, url), second = routes.handle(request(), b, url);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(uploads, 1);
  const conflict = response(); await routes.handle(request(Buffer.from('%PDF-changed')), conflict, url); assert.equal(conflict.status, 409); assert.equal(uploads, 1);
  release();
  await Promise.all([first, second]); assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(uploads, 1);
  const changed = response(); await routes.handle(request(Buffer.from('%PDF-changed')), changed, url); assert.equal(changed.status, 200, 'after completion durable adapter decides replay identity');
  const get = request(); get.method = 'GET'; get.headers = {}; const listed = response(); await routes.handle(get, listed, url); assert.deepEqual(listed.body, { drafts: [{ id: 'synthetic' }] });
});

test('route rejects unauthorized, JSON, invalid command headers, and oversized announced streams before upload', async () => {
  let calls = 0; const documents = { drafts: async () => [], upload: async () => { calls++; } };
  const url = new URL('http://local/api/finance/contracts');
  let routes = createPostgresFinanceDocumentRoutes({ documents, authorize: async () => false }), res = response();
  await routes.handle(request(), res, url); assert.equal(res.status, 403);
  routes = createPostgresFinanceDocumentRoutes({ documents, authorize: async () => true });
  res = response(); await routes.handle(request(PDF, { 'content-type': 'application/json' }), res, url); assert.equal(res.status, 415);
  res = response(); await routes.handle(request(PDF, { 'x-pult-command-id': 'random' }), res, url); assert.equal(res.status, 400);
  res = response(); await routes.handle(request(PDF, { 'content-length': String(20 * 1024 * 1024 + 1) }), res, url); assert.equal(res.status, 413);
  assert.equal(calls, 0);
});

async function assets(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-finance-http-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html>'); return dir;
}
function leasePool() {
  class Client extends EventEmitter { async query(sql) { return { rows: [{ [sql.includes('unlock') ? 'unlocked' : 'acquired']: true }] }; } release() {} }
  return { connect: async () => new Client() };
}

test('actual server grants binary auth only to the exact trusted finance upload route', async t => {
  const dir = await assets(t), seen = [];
  const routes = createPostgresFinanceDocumentRoutes({ documents: { drafts: async () => [], async upload(input) { seen.push(input); return { id: 'ok' }; } }, authorize: async () => true });
  const runtime = await start({ pool: leasePool(), core: { ready() {}, publicStores: async () => [], publicSnapshot() {}, hasStore: async () => false },
    ownerRoutesFactory: async () => ({ handle: async () => false }), otherHandlers: [routes], staticDir: dir, staticFiles: ['index.html'],
    readiness: async () => ({ ready: true, missingAdapters: [] }) });
  t.after(() => runtime.close());
  const page = await fetch(runtime.origin), cookie = page.headers.get('set-cookie').split(';', 1)[0];
  const headers = { cookie, origin: runtime.origin, 'content-type': 'application/pdf', 'x-file-name': 'contract.pdf', 'x-pult-command-id': COMMAND, 'x-pult-command-timestamp': TIME };
  assert.equal((await fetch(runtime.origin + '/api/finance/contracts', { method: 'POST', headers, body: PDF })).status, 200);
  assert.equal((await fetch(runtime.origin + '/api/not-finance', { method: 'POST', headers, body: PDF })).status, 403);
  assert.equal((await fetch(runtime.origin + '/api/finance/contracts', { method: 'POST', headers: { ...headers, origin: 'http://evil.invalid' }, body: PDF })).status, 403);
  assert.equal(seen.length, 1);
});

const ownerUrl = process.env.PULT_TEST_DATABASE_URL, restrictedUrl = process.env.PULT_TEST_RESTRICTED_DATABASE_URL;
test('restricted PostgreSQL upload through actual HTTP server resolves unknown commit with same command', { skip: !ownerUrl || !restrictedUrl }, async t => {
  const { Pool } = require('pg'), owner = new Pool({ connectionString: ownerUrl }), app = new Pool({ connectionString: restrictedUrl });
  const schema = `finance_http_${crypto.randomBytes(8).toString('hex')}`, dir = await assets(t), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-finance-http-extract-')); let made = false, runtime;
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  try {
    await owner.query(require('../storage/postgres-schema.cjs').replaceAll('pult', schema));
    await owner.query(require('../storage/postgres-document-schema.cjs').replaceAll('pult', schema)); made = true;
    const role = (await app.query('SELECT current_user name')).rows[0].name, qrole = '"' + role.replaceAll('"', '""') + '"', qs = '"' + schema + '"';
    await owner.query(`GRANT USAGE ON SCHEMA ${qs} TO ${qrole}; GRANT SELECT,INSERT,UPDATE ON ${qs}.document_states TO ${qrole}; GRANT SELECT,INSERT ON ${qs}.commands,${qs}.source_files TO ${qrole}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${qs} TO ${qrole}`);
    const state = require('../storage/postgres-state.cjs').createStateStore({ pool: app, schema });
    const baseBatch = require('../storage/postgres-state-batch.cjs').createStateBatch({ pool: app, schema }); let unknown = true, extracts = 0;
    const batch = { ...baseBatch, async writeDocuments(input) { const result = await baseBatch.writeDocuments(input); if (unknown) { unknown = false; throw Object.assign(Error('lost response'), { code: 'OUTCOME_UNKNOWN' }); } return result; } };
    const routes = createPostgresFinanceDocumentRoutes({ stateStore: state, batch, tempRoot: temp, authorize: async () => true,
      extractFile: async () => { extracts++; return { pages: [{ page: 1, text: 'Synthetic contract without business values' }], warnings: [] }; } });
    runtime = await start({ pool: leasePool(), core: { ready() {}, publicStores: async () => [], publicSnapshot() {}, hasStore: async () => false },
      ownerRoutesFactory: async () => ({ handle: async () => false }), otherHandlers: [routes], staticDir: dir, staticFiles: ['index.html'], readiness: async () => ({ ready: true, missingAdapters: [] }) });
    const cookie = (await fetch(runtime.origin)).headers.get('set-cookie').split(';', 1)[0], headers = { cookie, origin: runtime.origin, 'content-type': 'application/pdf', 'x-file-name': 'contract.pdf', 'x-pult-command-id': COMMAND, 'x-pult-command-timestamp': TIME };
    const [first, concurrent] = await Promise.all([
      fetch(runtime.origin + '/api/finance/contracts', { method: 'POST', headers, body: PDF }),
      fetch(runtime.origin + '/api/finance/contracts', { method: 'POST', headers, body: PDF }),
    ]);
    assert.equal(first.status, 200); assert.equal(concurrent.status, 200); assert.equal(extracts, 1);
    assert.deepEqual(await first.json(), await concurrent.json());
    const retry = await fetch(runtime.origin + '/api/finance/contracts', { method: 'POST', headers, body: PDF }); assert.equal(retry.status, 200); assert.equal((await retry.json()).replayed, true); assert.equal(extracts, 1);
    assert.equal((await owner.query(`SELECT count(*)::int n FROM ${qs}.commands`)).rows[0].n, 2);
  } finally { if (runtime) await runtime.close(); if (made) await owner.query(`DROP SCHEMA "${schema}" CASCADE`); await app.end(); await owner.end(); }
});
