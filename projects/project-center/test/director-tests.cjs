'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const tmp = fs.mkdtempSync(path.join(__dirname, 'director-test-'));
const serverFile = path.join(__dirname, '../server.cjs');
const preload = path.join(tmp, 'adapter-preload.cjs');
fs.writeFileSync(preload, `
const Module = require('node:module'), fs = require('node:fs'), path = require('node:path');
const load = Module._load;
Module._load = function(request, parent, main) {
  if (request === './ai-directors.cjs' && parent.filename.endsWith('server.cjs')) return {
    getStatus() { return {available: !fs.existsSync(path.join(__dirname, 'offline')), provider:'test',message:'Isolated test adapter'}; },
    async generate(input) {
      fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(input)+'\\n');
      while(fs.existsSync(path.join(__dirname,'hold'))) await new Promise(resolve=>setTimeout(resolve,10));
      if(input.history.at(-1).text==='fail') throw new Error('PRIVATE_PROVIDER_ERROR');
      if(input.history.at(-1).text==='timeout') throw Object.assign(new Error('PRIVATE_PROVIDER_ERROR'), {code:'AI_TIMEOUT'});
      return 'Test response: '+input.history.at(-1).text;
    }
  };
  return load.apply(this, arguments);
};
`);
const password = 'directors testing password';
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
const history = Array.from({ length: 198 }, (_, i) => ({ id: crypto.randomUUID(), role: i % 2 ? 'assistant' : 'user', text: 'old ' + i, createdAt: new Date().toISOString(), projectId: '' }));
const state = { products: [], sales: [], expenses: [] };
const projects = { items: [
  { id: 'p1', name: 'Selected', description: 'Selected context', status: 'active', owner: 'admin', dueDate: '' },
  { id: 'p2', name: 'Private other project', description: 'NOT_SENT_TO_AI', status: 'active', owner: '', dueDate: '' }
], tasks: Array.from({ length: 35 }, (_, i) => ({ id: 't' + i, projectId: 'p1', title: 'Task ' + i, status: 'todo', priority: 'medium', owner: '', dueDate: '' })) };
fs.writeFileSync(path.join(tmp, 'store.json'), JSON.stringify({ state, version: 0, projects, projectsVersion: 0,
  users: ['admin', 'editor', 'viewer'].map(role => ({ username: role, role, salt, hash })),
  directorConversations: { [JSON.stringify(['admin', 'general'])]: { messages: history, requests: [] } }
}));
let child, base;
async function start() {
  child = spawn(process.execPath, ['--require', preload, serverFile], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', OZON_DATA_DIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  return { status: res.status, json, text, headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function auth(username) { const result = await request('/api/login', 'POST', { username, password }); assert.equal(result.status, 200); return result.cookie; }
const get = (id, cookie) => request('/api/directors/' + id, 'GET', undefined, cookie);
const send = (id, data, cookie) => request('/api/directors/' + id + '/messages', 'POST', data, cookie);
const message = (text, projectId = '') => ({ text, projectId, requestId: crypto.randomUUID() });
const calls = () => fs.existsSync(path.join(tmp, 'calls.jsonl')) ? fs.readFileSync(path.join(tmp, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function done(id, cookie) {
  for (let i = 0; i < 100; i++) { const result = await get(id, cookie); if (!result.json.busy) return result.json; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Reply did not complete');
}
(async () => {
  await start();
  let admin = await auth('admin');
  const editor = await auth('editor');
  const viewer = await auth('viewer');
  assert.equal((await request('/api/directors')).status, 401);
  const catalog = await request('/api/directors', 'GET', undefined, admin);
  assert.equal(catalog.json.directors.length, 10);
  assert.equal(catalog.text.includes('prompt'), false);
  assert.equal(catalog.json.connection.available, true);
  assert.deepEqual(catalog.json.projects, [{ id: 'p1', name: 'Selected' }, { id: 'p2', name: 'Private other project' }]);
  assert.equal((await get('general', editor)).json.messages.length, 0);
  assert.equal((await get('general', viewer)).status, 200);
  assert.equal((await get('missing', admin)).status, 404);
  assert.equal((await send('general', message('hello'), viewer)).status, 403);
  for (const bad of [message(''), message('x'.repeat(6001)), message('test', 'missing'), { ...message('x'), requestId: '__proto__' }]) assert.equal((await send('general', bad, admin)).status, 400);
  assert.equal((await request('/api/directors/general/messages', 'POST', message('x'), admin, 'http://evil.example')).status, 403);
  fs.writeFileSync(path.join(tmp, 'offline'), '1');
  assert.equal((await send('general', message('not stored'), admin)).status, 503);
  assert.equal((await get('general', admin)).json.messages.length, 198);
  fs.unlinkSync(path.join(tmp, 'offline'));
  fs.writeFileSync(path.join(tmp, 'hold'), '1');
  const first = message('Plan selected project', 'p1');
  assert.equal((await send('general', first, admin)).status, 202);
  assert.equal((await get('general', admin)).json.busy, true);
  assert.equal((await send('general', first, admin)).status, 202);
  assert.equal((await send('general', { ...first, text: 'different' }, admin)).status, 409);
  assert.equal((await send('general', message('busy'), admin)).status, 409);
  assert.equal((await send('general', message('Editor separate private chat'), editor)).status, 202);
  assert.equal((await send('finance', message('over capacity'), admin)).status, 429);
  const changed = structuredClone(projects); changed.items[0].name = 'Edited during generation';
  assert.equal((await request('/api/projects', 'PUT', { state: changed, version: 0 }, admin)).status, 200);
  assert.equal((await request('/api/state', 'PUT', { state, version: 0 }, admin)).status, 200);
  fs.unlinkSync(path.join(tmp, 'hold'));
  const result = await done('general', admin);
  await done('general', editor);
  assert.equal(result.messages.length, 200);
  assert.equal(result.messages.at(-1).role, 'assistant');
  assert.equal(result.messages.at(-1).projectId, 'p1');
  assert.equal(calls().length, 2);
  assert.equal(calls()[0].history.length, 20);
  assert.equal(calls()[0].project.tasks.length, 30);
  assert.equal(calls()[0].project.name, 'Selected');
  assert.equal(JSON.stringify(calls()[0]).includes('NOT_SENT_TO_AI'), false);
  assert.equal((await get('general', editor)).json.messages.length, 2);
  assert.equal((await get('general', viewer)).json.messages.length, 0);
  assert.equal((await request('/api/projects', 'GET', undefined, admin)).json.state.items[0].name, 'Edited during generation');
  assert.equal((await request('/api/state', 'GET', undefined, admin)).json.version, 1);
  assert.equal((await send('general', first, admin)).status, 202);
  assert.equal(calls().length, 2);
  assert.equal((await send('quality', message('fail'), admin)).status, 202);
  const failure = await done('quality', admin);
  assert.equal(failure.messages.at(-1).role, 'system');
  assert.equal(JSON.stringify(failure).includes('PRIVATE_PROVIDER_ERROR'), false);
  assert.equal((await send('quality', message('timeout'), admin)).status, 202);
  const timeoutFailure = await done('quality', admin);
  assert.match(timeoutFailure.messages.at(-1).text, /AI_TIMEOUT/);
  assert.match(timeoutFailure.messages.at(-1).text, /две минуты/);
  assert.equal(JSON.stringify(timeoutFailure).includes('PRIVATE_PROVIDER_ERROR'), false);
  for (const file of ['directors-catalog.cjs', 'ai-directors.cjs', 'data/store.json']) assert.equal((await request('/' + file, 'GET', undefined, admin)).status, 404);
  assert.equal((await request('/directors.html')).headers.get('location'), '/login.html');
  assert.equal((await request('/directors.js')).status, 401);
  fs.writeFileSync(path.join(tmp, 'hold'), '1');
  const pending = message('Interrupted request');
  assert.equal((await send('development', pending, admin)).status, 202);
  await stop();
  fs.unlinkSync(path.join(tmp, 'hold'));
  await start();
  admin = await auth('admin');
  const interrupted = await get('development', admin);
  assert.equal(interrupted.json.busy, false);
  assert.equal(interrupted.json.messages.at(-1).role, 'system');
  assert.match(interrupted.json.messages.at(-1).text, /перезапущен/);
  const count = calls().length;
  assert.equal((await send('development', pending, admin)).status, 202);
  assert.equal(calls().length, count);
  const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'store.json'), 'utf8'));
  assert.equal(disk.directorConversations[JSON.stringify(['admin', 'development'])].requests[0].status, 'failed');
  assert.equal(disk.projectsVersion, 1);
  assert.equal(disk.version, 1);
  console.log('Director tests passed: private histories/catalog, auth/roles/origin, input bounds, unavailable provider, immediate async reply, idempotency, busy/global cap, selected context limits, safe failure, bounded history, current-store preservation, restart recovery and protected files.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
