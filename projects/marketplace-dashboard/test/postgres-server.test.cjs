'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { start } = require('../server-postgres.cjs');
const STATIC_FILES = ['index.html', 'app.js'];

async function assets() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-pg-server-'));
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>SQL</title>');
  await fs.writeFile(path.join(dir, 'app.js'), 'window.ready=true');
  await fs.writeFile(path.join(dir, 'secret.txt'), 'blocked');
  return dir;
}

function fakePool(events = [], acquired = true) {
  class Client extends EventEmitter {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) { events.push('lease'); return { rows: [{ acquired }] }; }
      if (sql.includes('pg_advisory_unlock')) { events.push('unlock'); return { rows: [{ unlocked: true }] }; }
      throw new Error('unexpected SQL');
    }
    release(destroy) { events.push(destroy ? 'destroy' : 'release'); }
  }
  return { connect: async () => { events.push('connect'); return new Client(); } };
}

function response(handler) {
  return async (req, res, url) => {
    if (!handler || !await handler(req, res, url)) return false;
    return true;
  };
}

async function request(origin, pathname, { cookie, method = 'GET', body, headers = {} } = {}) {
  const value = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(origin + pathname, { method, headers: { ...(cookie ? { cookie } : {}), ...(value === undefined ? {} : { 'content-type': 'application/json', origin, ...headers }) }, body: value });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

test('readiness gate runs before lease and rejects incomplete wiring', async t => {
  const dir = await assets(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const events = [];
  await assert.rejects(start({
    pool: fakePool(events), staticDir: dir, staticFiles: STATIC_FILES, port: 0,
    core: { ready() {}, publicStores() {}, publicSnapshot() {}, hasStore() {} },
    ownerRoutesFactory: async () => ({ handle: async () => false }),
    readiness: async () => ({ ready: false, missingAdapters: ['supplierPortals'] })
  }), error => error.code === 'RUNTIME_NOT_READY' && error.missingAdapters[0] === 'supplierPortals');
  assert.deepEqual(events, []);
});

test('loopback server awaits fresh reads, enforces session/origin, validates stores and drains', async t => {
  const dir = await assets(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const events = [], calls = [];
  let stores = [{ id: '1', name: 'One' }], finishSlow, enterSlow;
  const slow = new Promise(resolve => { finishSlow = resolve; });
  const slowEntered = new Promise(resolve => { enterSlow = resolve; });
  const core = {
    async ready() { events.push('ready'); return { ready: true, missingAdapters: [] }; },
    async publicStores() { calls.push('stores'); return stores; },
    async publicSnapshot(id) { calls.push(`snapshot:${id}`); return { id, exact: true }; },
    async hasStore(id) { calls.push(`has:${id}`); return stores.some(store => store.id === id); }
  };
  let capturedAuthorize;
  const ownerRoutesFactory = async ({ authorize, core: wiredCore }) => {
    capturedAuthorize = authorize; assert.equal(wiredCore, core); events.push('owner');
    return { handle: response(async (req, res, url) => {
      if (url.pathname === '/api/echo' && req.method === 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return true; }
      return false;
    }) };
  };
  const background = { async start() { events.push('background-start'); }, async close() { events.push('background-close'); } };
  const otherHandlers = [{ handle: response(async (req, res, url) => {
    if (url.pathname !== '/api/slow') return false;
    enterSlow(); await slow; res.writeHead(200).end('done'); return true;
  }) }];
  const runtime = await start({ pool: fakePool(events), core, ownerRoutesFactory, otherHandlers, background: [background], staticDir: dir, staticFiles: STATIC_FILES, port: 0,
    readiness: async () => { const passive = await core.ready(); assert.equal(passive.ready, true); return { ready: true, missingAdapters: [] }; } });
  assert.deepEqual(events.slice(0, 5), ['ready', 'connect', 'lease', 'owner', 'background-start']);
  t.after(() => runtime.close());

  assert.equal((await request(runtime.origin, '/api/stores')).status, 403);
  const page = await request(runtime.origin, '/');
  const cookie = page.headers.get('set-cookie').split(';', 1)[0];
  assert.match(cookie, /^pult_session=[a-f0-9]{64}$/u);
  assert.deepEqual((await request(runtime.origin, '/api/stores', { cookie })).body, stores);
  stores = [{ id: '2', name: 'Fresh' }];
  assert.deepEqual((await request(runtime.origin, '/api/stores', { cookie })).body, stores);
  assert.deepEqual((await request(runtime.origin, '/api/data?id=2', { cookie })).body, { id: '2', exact: true });
  assert.equal((await request(runtime.origin, '/api/data?id=1', { cookie })).status, 404);
  assert.equal((await request(runtime.origin, '/api/market-history/report?store=1', { cookie })).status, 400);
  assert.equal((await request(runtime.origin, '/api/stock-history/export?store=1', { cookie })).status, 400);
  assert.equal((await request(runtime.origin, '/secret.txt', { cookie })).status, 404);
  assert.equal((await request(runtime.origin, '/api/echo', { cookie, method: 'POST', body: {}, headers: { origin: 'http://evil.invalid' } })).status, 403);
  assert.equal((await request(runtime.origin, '/api/echo', { cookie, method: 'POST', body: {} })).status, 200);
  assert.equal(await capturedAuthorize({ method: 'GET', headers: { host: new URL(runtime.origin).host, cookie } }), true);

  const pending = request(runtime.origin, '/api/slow', { cookie });
  await slowEntered;
  let closed = false; const closing = runtime.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, false);
  finishSlow(); assert.equal((await pending).status, 200); await closing;
  assert.deepEqual(events.slice(-3), ['background-close', 'unlock', 'release']);
  await runtime.close();
});

test('failed background startup closes earlier tasks and destroys the lease', async t => {
  const dir = await assets(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const events = [];
  const core = { async ready() { return { ready: true, missingAdapters: [] }; }, publicStores() {}, publicSnapshot() {}, hasStore() {} };
  await assert.rejects(start({
    pool: fakePool(events), core, staticDir: dir, staticFiles: STATIC_FILES, port: 0,
    ownerRoutesFactory: async () => ({ handle: async () => false }),
    readiness: async () => ({ ready: true, missingAdapters: [] }),
    background: [
      { async start() { events.push('first-start'); }, async close() { events.push('first-close'); } },
      { async start() { events.push('second-start'); throw new Error('canary secret'); }, async close() { events.push('second-close'); } }
    ]
  }), /canary secret/u);
  assert.deepEqual(events.slice(-3), ['first-close', 'second-close', 'destroy']);
});

test('static allowlist rejects a symlink escaping the public root', async t => {
  const dir = await assets(), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-pg-outside-'));
  t.after(() => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const target = path.join(outside, 'canary.js'), link = path.join(dir, 'escape.js'); await fs.writeFile(target, 'secret-canary');
  try { await fs.symlink(target, link, 'file'); } catch (error) { if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) { t.skip('symlink privilege unavailable'); return; } throw error; }
  const core = { ready() {}, publicStores() {}, publicSnapshot() {}, hasStore() {} };
  const runtime = await start({ pool: fakePool(), core, staticDir: dir, staticFiles: [...STATIC_FILES, 'escape.js'], port: 0,
    readiness: async () => ({ ready: true, missingAdapters: [] }), ownerRoutesFactory: async () => ({ handle: async () => false }) });
  t.after(() => runtime.close());
  assert.equal((await request(runtime.origin, '/escape.js')).status, 404);
});
