'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const tmp = fs.mkdtempSync(path.join(__dirname, 'user-test-'));
const serverFile = path.join(__dirname, '../server.cjs');
let child, base;
const oldPassword = 'correct horse battery';
const newPassword = 'updated horse battery';
async function start() {
  child = spawn(process.execPath, [serverFile], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', OZON_DATA_DIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    await new Promise((resolve, reject) => {
      child.once('exit', code => reject(new Error('Server exited: ' + code)));
      child.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { base = match[0]; resolve(); } });
    });
  } finally { clearTimeout(timeout); }
}
async function stop() { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
async function request(url, method = 'GET', data, cookie, origin = base) {
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = cookie;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + url, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), redirect: 'manual' });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
}
const auth = (username, password = oldPassword) => request('/api/login', 'POST', { username, password });
const patch = (data, cookie) => request('/api/users', 'PATCH', data, cookie);
(async () => {
  await start();
  const setup = await request('/api/setup', 'POST', { username: 'admin', password: oldPassword });
  assert.equal(setup.status, 201);
  assert.equal(setup.json.user.disabled, false);
  let admin = setup.cookie;
  for (const [username, role] of [['editor', 'editor'], ['viewer', 'viewer'], ['admin2', 'admin']]) {
    assert.equal((await request('/api/users', 'POST', { username, role, password: oldPassword }, admin)).status, 201);
  }
  const editor1 = (await auth('editor')).cookie;
  const editor2 = (await auth('editor')).cookie;
  assert.equal((await patch({ username: 'editor', role: 'admin' })).status, 401);
  assert.equal((await patch({ username: 'editor', role: 'admin' }, editor1)).status, 403);
  assert.equal((await patch({ username: 'admin', disabled: true }, admin)).status, 403);
  assert.equal((await patch({ username: 'admin', role: 'editor' }, admin)).status, 403);
  assert.equal((await patch({ username: 'missing', disabled: true }, admin)).status, 404);
  assert.equal((await patch({ username: 'editor', disabled: 'true' }, admin)).status, 400);
  assert.equal((await patch({ username: 'editor', role: 'owner' }, admin)).status, 400);
  assert.equal((await patch({ username: 'editor' }, admin)).status, 400);
  assert.equal((await request('/api/users', 'PATCH', { username: 'editor', disabled: true }, admin, 'http://evil.example')).status, 403);
  assert.equal((await patch({ username: 'editor', role: 'editor', disabled: false }, admin)).status, 200);
  assert.equal((await request('/api/state', 'GET', undefined, editor1)).status, 200, 'No-op preserves sessions');
  assert.equal((await patch({ username: 'editor', disabled: true }, admin)).json.user.disabled, true);
  for (const cookie of [editor1, editor2]) assert.equal((await request('/api/state', 'GET', undefined, cookie)).status, 401);
  assert.equal((await auth('editor')).status, 401);
  const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'store.json'), 'utf8'));
  assert.equal(disk.users.find(user => user.username === 'editor').disabled, true);
  assert.equal((await patch({ username: 'editor', disabled: false }, admin)).status, 200);
  const editor3 = (await auth('editor')).cookie;
  assert.equal((await patch({ username: 'editor', role: 'viewer' }, admin)).json.user.role, 'viewer');
  assert.equal((await request('/api/state', 'GET', undefined, editor3)).status, 401);
  assert.equal((await auth('editor')).json.user.role, 'viewer');
  assert.equal((await patch({ username: 'admin2', disabled: true }, admin)).status, 200);
  assert.equal((await patch({ username: 'admin', role: 'viewer' }, admin)).status, 403, 'Last active administrator cannot demote self');
  const users = (await request('/api/users', 'GET', undefined, admin)).json.users;
  assert.equal(users.filter(user => user.role === 'admin' && !user.disabled).length, 1);
  for (const user of users) assert.deepEqual(Object.keys(user).sort(), ['disabled', 'role', 'username']);
  await stop();
  await start();
  admin = (await auth('admin')).cookie;
  const session2 = (await auth('admin')).cookie;
  const change = { currentPassword: oldPassword, newPassword };
  assert.equal((await request('/api/password', 'POST', change)).status, 401);
  assert.equal((await request('/api/password', 'POST', change, admin, 'http://evil.example')).status, 403);
  assert.equal((await request('/api/password', 'POST', { ...change, currentPassword: 'wrong password' }, admin)).status, 401);
  assert.equal((await request('/api/password', 'POST', { ...change, newPassword: 'short' }, admin)).status, 400);
  assert.equal((await request('/api/password', 'POST', { ...change, newPassword: 'x'.repeat(1025) }, admin)).status, 400);
  const changed = await request('/api/password', 'POST', change, admin);
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.json, { ok: true });
  assert.match(changed.headers.get('set-cookie'), /Max-Age=0/);
  for (const cookie of [admin, session2]) assert.equal((await request('/api/state', 'GET', undefined, cookie)).status, 401);
  assert.equal((await auth('admin')).status, 401);
  const renewed = await auth('admin', newPassword);
  assert.equal(renewed.status, 200);
  const persisted = fs.readFileSync(path.join(tmp, 'store.json'), 'utf8');
  assert.equal(persisted.includes(newPassword), false);
  assert.equal(JSON.parse(persisted).users.find(user => user.username === 'admin').hash === disk.users.find(user => user.username === 'admin').hash, false);
  const viewer = (await auth('viewer')).cookie;
  assert.equal((await request('/api/password', 'POST', change, viewer)).status, 200, 'Viewer may change own password');
  assert.equal((await request('/api/state', 'GET', undefined, renewed.cookie)).status, 200, 'Other account sessions survive');
  assert.equal((await request('/reports.js')).status, 401);
  assert.equal((await request('/admin.js')).status, 401);
  for (const name of ['reports.js', 'admin.js']) if (fs.existsSync(path.join(path.dirname(serverFile), name))) assert.equal((await request('/' + name, 'GET', undefined, renewed.cookie)).status, 200);
  await stop();
  await start();
  assert.equal((await auth('admin', newPassword)).status, 200);
  assert.equal((await auth('admin2')).status, 401, 'Disabled status survives restart');
  console.log('User tests passed: admin patch, strict validation, self/last-admin protection, disable/enable, all-session revocation, role changes, password verification/rotation/persistence, viewer self-service, static allowlist.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
