'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const serverFile = path.join(__dirname, '../server.cjs');
const { validateState } = require('../projects-model.cjs');
const tmp = fs.mkdtempSync(path.join(__dirname, 'project-test-'));
const password = 'project center password';
const oldState = {
  products: [{ id: 'p1', name: 'Existing Ozon product', sku: 'OLD-1', cost: 10, price: 20, stock: 5 }],
  sales: [{ id: 's1', productId: 'p1', date: '2026-09-01', quantity: 1, price: 20, commission: 1, logistics: 2 }],
  expenses: [{ id: 'e1', date: '2026-09-01', category: 'Other', amount: 3, note: '' }]
};
const legacy = { state: oldState, version: 7, users: ['admin', 'editor', 'viewer'].map(role => {
  const salt = crypto.randomBytes(16).toString('hex');
  return { username: role, role, salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}) };
fs.writeFileSync(path.join(tmp, 'store.json'), JSON.stringify(legacy));
const state = {
  items: [{ id: 'project1', name: 'Общий центр', description: 'Проект команды', status: 'active', owner: 'Иван', dueDate: '2028-02-29' }],
  tasks: [{ id: 'task1', projectId: 'project1', title: 'Подготовить план', owner: '', status: 'doing', priority: 'high', dueDate: '' }]
};
assert.equal(validateState(state).ok, true);
assert.equal(validateState({ items: [], tasks: [] }).ok, true);
const invalidCases = [
  s => { s.items[0].name = ''; },
  s => { s.items[0].name = 'x'.repeat(201); },
  s => { s.items[0].description = 'x'.repeat(5001); },
  s => { s.items[0].description = null; },
  s => { s.items[0].owner = 'x'.repeat(121); },
  s => { s.items[0].dueDate = '2026-02-29'; },
  s => { s.items[0].dueDate = '2026-04-31'; },
  s => { s.items[0].dueDate = '0000-01-01'; },
  s => { s.items[0].dueDate = '2026-1-01'; },
  s => { s.items[0].status = 'todo'; },
  s => { s.items[0].id = ' padded '; },
  s => { s.items[0].id = 'x'.repeat(129); },
  s => { s.items.push({ ...s.items[0] }); },
  s => { s.tasks.push({ ...s.tasks[0] }); },
  s => { s.tasks[0].projectId = 'missing'; },
  s => { s.items = []; },
  s => { s.tasks[0].title = ' '; },
  s => { s.tasks[0].priority = 'urgent'; },
  s => { s.tasks[0].status = 'active'; },
  s => { s.tasks[0].dueDate = 123; },
  s => { delete s.tasks[0].owner; },
  s => { s.tasks[0].extra = true; },
  s => { s.extra = true; },
  s => { s.items[0] = null; },
  s => { s.tasks = {}; }
];
for (const mutate of invalidCases) { const bad = structuredClone(state); mutate(bad); assert.equal(validateState(bad).ok, false, mutate.toString()); }
for (const bad of [null, [], {}, 1]) assert.equal(validateState(bad).ok, false);
let child, base;
async function start() {
  child = spawn(process.execPath, [serverFile], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', OZON_DATA_DIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const timeout = setTimeout(() => child.kill(), 15000);
  try { await new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error('Server exited: ' + code)));
    child.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { base = match[0]; resolve(); } });
  }); } finally { clearTimeout(timeout); }
}
async function stop() { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
async function request(url, method = 'GET', data, cookie, origin = base) {
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = cookie;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), redirect: 'manual' });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function auth(username) { const result = await request('/api/login', 'POST', { username, password }); assert.equal(result.status, 200); return result.cookie; }
(async () => {
  await start();
  const migrated = JSON.parse(fs.readFileSync(path.join(tmp, 'store.json'), 'utf8'));
  assert.deepEqual(migrated.users, legacy.users);
  assert.deepEqual(migrated.state, oldState);
  assert.equal(migrated.version, 7);
  assert.deepEqual(migrated.projects, { items: [], tasks: [] });
  assert.equal(migrated.projectsVersion, 0);
  assert.equal((await request('/api/projects')).status, 401);
  assert.equal((await request('/')).headers.get('location'), '/login.html');
  assert.equal((await request('/projects.html')).headers.get('location'), '/login.html');
  assert.equal((await request('/projects.js')).status, 401);
  const admin = await auth('admin');
  const editor = await auth('editor');
  const viewer = await auth('viewer');
  assert.equal((await request('/', 'GET', undefined, admin)).headers.get('location'), '/projects.html');
  assert.equal((await request('/index.html', 'GET', undefined, admin)).status, 200);
  assert.equal((await request('/projects-model.cjs', 'GET', undefined, admin)).status, 404);
  for (const file of ['projects.html', 'projects.js', 'projects.css']) if (fs.existsSync(path.join(path.dirname(serverFile), file))) assert.equal((await request('/' + file, 'GET', undefined, admin)).status, 200);
  const initial = await request('/api/projects', 'GET', undefined, viewer);
  assert.equal(initial.json.user.role, 'viewer');
  assert.equal(initial.json.version, 0);
  assert.equal((await request('/api/projects', 'PUT', { state, version: 0 }, viewer)).status, 403);
  assert.equal((await request('/api/projects', 'PUT', { state, version: 0 }, editor, 'http://evil.example')).status, 403);
  assert.equal((await request('/api/projects', 'PUT', { state, version: '0' }, editor)).status, 400);
  assert.equal((await request('/api/projects', 'PUT', { state, version: 0 }, editor)).json.version, 1);
  assert.equal((await request('/api/projects', 'PUT', { state, version: 0 }, admin)).status, 409);
  for (const mutate of invalidCases) {
    const bad = structuredClone(state); mutate(bad);
    assert.equal((await request('/api/projects', 'PUT', { state: bad, version: 1 }, admin)).status, 400);
  }
  assert.deepEqual((await request('/api/projects', 'GET', undefined, viewer)).json.state, state);
  const changedOzon = structuredClone(oldState);
  changedOzon.products[0].stock = 99;
  const changedProjects = structuredClone(state);
  changedProjects.tasks[0].status = 'done';
  const writes = await Promise.all([
    request('/api/state', 'PUT', { state: changedOzon, version: 7 }, admin),
    request('/api/projects', 'PUT', { state: changedProjects, version: 1 }, editor)
  ]);
  assert.deepEqual(writes.map(result => result.status), [200, 200]);
  assert.deepEqual(writes.map(result => result.json.version), [8, 2]);
  const racing = await Promise.all([
    request('/api/projects', 'PUT', { state: changedProjects, version: 2 }, admin),
    request('/api/projects', 'PUT', { state: changedProjects, version: 2 }, editor)
  ]);
  assert.deepEqual(racing.map(result => result.status).sort(), [200, 409]);
  await stop();
  await start();
  const newAdmin = await auth('admin');
  const ozon = (await request('/api/state', 'GET', undefined, newAdmin)).json;
  const projects = (await request('/api/projects', 'GET', undefined, newAdmin)).json;
  assert.deepEqual(ozon.state, changedOzon);
  assert.equal(ozon.version, 8);
  assert.deepEqual(projects.state, changedProjects);
  assert.equal(projects.version, 3);
  assert.equal((await request('/api/users', 'GET', undefined, newAdmin)).json.users.length, 3);
  console.log('Project tests passed: strict schema, bounds/dates/IDs/FK, legacy migration preserving Ozon/users, separate versions, roles/origin, concurrent writes/conflicts, restart persistence, root routing/static protection.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
