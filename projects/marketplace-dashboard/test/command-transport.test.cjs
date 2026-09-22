'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createTransport, STORAGE_KEY } = require('../dist/command-transport.js');
const baseURL = 'http://127.0.0.1:4317/';
const ok = value => Response.json(value || { ok: true });
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function memoryStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}
function setup(fetch, storage = memoryStorage()) {
  return { storage, run: createTransport({ fetch, baseURL, crypto: crypto.webcrypto, storage, enabled: true, now: () => new Date('2026-09-22T12:00:00.000Z') }) };
}
test('legacy backend remains untouched until the registry advertises PostgreSQL command support', async () => {
  const calls = [], options = post({ value: 1 }), storage = memoryStorage();
  const run = createTransport({ baseURL, crypto: crypto.webcrypto, storage, fetch: async (...args) => {
    calls.push(args); return Response.json([]);
  } });
  await run('/api/ideas/add', options);
  assert.equal(calls[0][0].method, 'GET');
  assert.deepEqual(calls[1], ['/api/ideas/add', options]);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});
test('ordinary GET and other origins keep their original request options', async () => {
  const calls = [];
  const { run } = setup(async (...args) => { calls.push(args); return ok(); });
  const options = post({ value: 1 });
  await run('/api/ideas'); await run('https://example.invalid/api/ideas', options);
  assert.deepEqual(calls, [['/api/ideas', undefined], ['https://example.invalid/api/ideas', options]]);
});
test('JSON writes get canonical command headers while the payload is unchanged', async () => {
  let request;
  const { run, storage } = setup(async value => { request = value; return ok(); });
  const payload = { title: 'Задача', value: 1 };
  assert.equal((await run('/api/ideas/add', post(payload))).status, 200);
  assert.match(request.headers.get('x-pult-command-id'), /^[a-f0-9-]{36}$/);
  assert.equal(request.headers.get('x-pult-command-timestamp'), '2026-09-22T12:00:00.000Z');
  assert.deepEqual(await request.json(), payload);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), {});
});
test('lost store response survives reload with the same command and original revision, without persisting credentials', async () => {
  const sent = []; let reads = 0;
  const storage = memoryStorage();
  const first = setup(async request => {
    if (request.method === 'GET') { reads++; return new Response('[]', { headers: { 'X-Pult-Registry-Revision': '7' } }); }
    sent.push(request); throw Error('connection lost after commit');
  }, storage);
  const body = { name: 'Тест', clientId: '1', key: 'DO_NOT_PERSIST_THIS_SECRET' };
  assert.equal((await first.run('/api/connect', post(body))).status, 503);
  assert.doesNotMatch(storage.getItem(STORAGE_KEY), /DO_NOT_PERSIST|clientId|Тест/);
  const retry = setup(async request => { sent.push(request); return ok(); }, storage);
  assert.equal((await retry.run('/api/connect', post(body))).status, 200);
  assert.equal(reads, 1);
  for (const header of ['x-pult-command-id', 'x-pult-command-timestamp', 'x-pult-expected-revision']) assert.equal(sent[0].headers.get(header), sent[1].headers.get(header));
  assert.equal(sent[1].headers.get('x-pult-expected-revision'), '7');
});
test('unknown outcome blocks a different payload and permits the original retry', async () => {
  let writes = 0;
  const { run } = setup(async () => { writes++; return Response.json({ error: 'unknown' }, { status: 503 }); });
  await run('/api/finance/loan', post({ value: 1 }));
  await assert.rejects(run('/api/finance/loan', post({ value: 2 })), /прежними данными/);
  assert.equal(writes, 1);
  await run('/api/finance/loan', post({ value: 1 }));
  assert.equal(writes, 2);
});
test('binary uploads retain exact bytes and retry identity; changed filename is a different request', async () => {
  const requests = [];
  const { run, storage } = setup(async request => { requests.push(request); return requests.length === 1 ? new Response('', { status: 503 }) : ok(); });
  const upload = name => ({ method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-File-Name': name }, body: new Uint8Array([37,80,68,70,0,255]) });
  await run('/api/finance/contracts', upload('one.pdf'));
  await assert.rejects(run('/api/finance/contracts', upload('two.pdf')), /прежними данными/);
  await run('/api/finance/contracts', upload('one.pdf'));
  assert.deepEqual(Buffer.from(await requests[1].arrayBuffer()), Buffer.from([37,80,68,70,0,255]));
  assert.equal(requests[0].headers.get('x-pult-command-id'), requests[1].headers.get('x-pult-command-id'));
  assert.doesNotMatch(storage.getItem(STORAGE_KEY), /one\.pdf|PDF/);
});
test('concurrent identical submissions share one request and return separately readable responses', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { run } = setup(async () => { calls++; entered(); return response; });
  const first = run('/api/ideas/add', post({ title: 'x' }));
  await started;
  const second = run('/api/ideas/add', post({ title: 'x' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  release(ok({ id: 'one' }));
  assert.equal(calls, 1);
  assert.deepEqual(await (await first).json(), { id: 'one' });
  assert.deepEqual(await (await second).json(), { id: 'one' });
});
test('definitive rejection clears pending state and the next user action gets a new identity', async () => {
  const ids = [];
  const { run, storage } = setup(async request => { ids.push(request.headers.get('x-pult-command-id')); return Response.json({ error: 'conflict' }, { status: 409 }); });
  await run('/api/manage/note', post({ note: 'one' }));
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), {});
  await run('/api/manage/note', post({ note: 'two' }));
  assert.notEqual(ids[0], ids[1]);
});
test('unavailable pending storage prevents sending a mutation; malformed success remains pending', async () => {
  let calls = 0;
  const blocked = setup(async () => { calls++; return ok(); }, { getItem: () => null, setItem() { throw Error('blocked'); } });
  await assert.rejects(blocked.run('/api/ideas/add', post({ title: 'x' })), /Браузер/);
  assert.equal(calls, 0);
  const { run, storage } = setup(async () => new Response('invalid JSON'));
  assert.equal((await run('/api/ideas/add', post({ title: 'x' }))).status, 503);
  assert.equal(Object.keys(JSON.parse(storage.getItem(STORAGE_KEY))).length, 1);
});
