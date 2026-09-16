'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const tmp = fs.mkdtempSync(path.join(__dirname, 'server-test-'));
const serverFile = path.join(__dirname, '../server.cjs');
let child;
let base;
async function start() {
  child = spawn(process.execPath, [serverFile], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', OZON_DATA_DIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', data => process.stderr.write(data));
  const timeout = setTimeout(() => child.kill(), 15000);
  await new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error('Server exited: ' + code)));
    child.stdout.on('data', data => { const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { base = match[0]; resolve(); } });
  });
  clearTimeout(timeout);
}
async function stop() { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
async function request(url, method = 'GET', data, cookie, origin = base) {
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = cookie;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + url, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), redirect: 'manual' });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
}
(async () => {
  await start();
  assert.equal((await request('/api/setup-status')).json.needsSetup, true);
  assert.equal((await request('/')).status, 302);
  assert.equal((await request('/app.js')).status, 401);
  assert.equal((await request('/style.css')).status, 200);
  assert.equal((await request('/api/state')).status, 401);
  const adminData = { username: 'admin', password: 'correct horse battery' };
  assert.equal((await request('/api/setup', 'POST', adminData, null, 'http://evil.example')).status, 403);
  assert.equal((await request('/api/setup', 'POST', { ...adminData, password: 'short' })).status, 400);
  const setup = await request('/api/setup', 'POST', adminData);
  assert.equal(setup.status, 201);
  const admin = setup.cookie;
  assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await request('/api/setup', 'POST', adminData)).status, 409);
  assert.equal((await request('/api/setup-status')).json.needsSetup, false);
  assert.equal((await request('/', 'GET', undefined, admin)).status, 302);
  assert.equal((await request('/data/store.json', 'GET', undefined, admin)).status, 404);
  assert.equal((await request('/server.cjs', 'GET', undefined, admin)).status, 404);
  assert.equal((await request('/api/users', 'POST', { username: 'viewer', password: adminData.password, role: 'viewer' }, admin)).status, 201);
  assert.equal((await request('/api/users', 'POST', { username: 'editor', password: adminData.password, role: 'editor' }, admin)).status, 201);
  const viewer = (await request('/api/login', 'POST', { ...adminData, username: 'viewer' })).cookie;
  const editor = (await request('/api/login', 'POST', { ...adminData, username: 'editor' })).cookie;
  assert.equal((await request('/api/users', 'GET', undefined, viewer)).status, 403);
  assert.equal((await request('/api/users', 'POST', { ...adminData, username: 'new', role: 'admin' }, editor)).status, 403);
  const state = { products: [{ id: 'p1', sku: 'sku1', name: 'Товар', cost: 5, stock: 4, price: 10 }], sales: [], expenses: [] };
  assert.equal((await request('/api/state', 'PUT', { state, version: 0 }, viewer)).status, 403);
  assert.equal((await request('/api/state', 'PUT', { state, version: 0 }, editor, 'http://evil.example')).status, 403);
  assert.equal((await request('/api/state', 'PUT', { state, version: 0 }, editor)).json.version, 1);
  assert.equal((await request('/api/state', 'PUT', { state, version: 0 }, admin)).status, 409);
  assert.equal((await request('/api/state', 'PUT', { state: {}, version: 1 }, admin)).status, 400);
  const bad = structuredClone(state);
  bad.sales.push({ id: 's1', productId: 'p1', date: '2026-09-01', quantity: 2, price: 1e308, commission: 0, logistics: 0 });
  assert.equal((await request('/api/state', 'PUT', { state: bad, version: 1 }, admin)).status, 400);
  const duplicate = structuredClone(state);
  duplicate.products.push({ ...state.products[0], id: 'p2', sku: ' SKU1 ' });
  assert.equal((await request('/api/state', 'PUT', { state: duplicate, version: 1 }, admin)).status, 400);
  assert.equal((await request('/api/state', 'PUT', { state, version: 1, padding: 'x'.repeat(2 * 1024 * 1024) }, admin)).status, 413);
  const fetched = await request('/api/state', 'GET', undefined, viewer);
  assert.deepEqual(fetched.json.state, state);
  assert.equal(fetched.json.version, 1);
  assert.equal(fetched.json.user.role, 'viewer');
  const disk = fs.readFileSync(path.join(tmp, 'store.json'), 'utf8');
  assert.equal(disk.includes(adminData.password), false);
  const users = await request('/api/users', 'GET', undefined, admin);
  assert.equal(users.json.users.length, 3);
  assert.equal(users.text.includes('hash'), false);
  assert.equal((await request('/api/logout', 'POST', {}, viewer)).status, 200);
  assert.equal((await request('/api/state', 'GET', undefined, viewer)).status, 401);
  await stop();
  await start();
  assert.equal((await request('/api/state', 'GET', undefined, admin)).status, 401);
  const relogin = await request('/api/login', 'POST', adminData);
  assert.equal(relogin.status, 200);
  assert.equal((await request('/api/state', 'GET', undefined, relogin.cookie)).json.version, 1);
  let last;
  for (let i = 0; i < 11; i++) last = await request('/api/login', 'POST', { ...adminData, password: 'incorrect password' });
  assert.equal(last.status, 429);
  console.log('Server tests passed: setup/auth, hashed passwords, cookies, roles, origin, conflicts, validation/overflow, body limit, protected static/data, persistence, logout, restart and login throttling.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

