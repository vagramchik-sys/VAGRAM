'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const createWorkspaceTools = require('../storage/domains/postgres-workspace-tools.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
function memoryStore() {
  const documents = new Map(), commands = new Map(); let uncertain = false;
  return {
    failNextCommit() { uncertain = true; },
    async read(key) { return documents.get(key) || null; },
    async readCommand(key, commandId, { operation }) { const item = commands.get(commandId); if (!item) return null; if (item.key !== key || operation !== 'write') throw Object.assign(Error('reuse'), { code: 'COMMAND_ID_REUSED' }); return item.command; },
    async write(key, content, options) {
      const request = JSON.stringify([key, options.expectedRevision, options.mediaType, content.toString('base64')]), prior = commands.get(options.commandId);
      if (prior) { if (prior.request !== request) throw Object.assign(Error('reuse'), { code: 'COMMAND_ID_REUSED' }); return { revision: prior.revision, replayed: true }; }
      const current = documents.get(key); if ((current?.revision || '0') !== options.expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' });
      const revision = (BigInt(options.expectedRevision) + 1n).toString(), before = current;
      const after = { revision, deleted: false, mediaType: options.mediaType, content: Buffer.from(content), sha256: digest(content) }; documents.set(key, after);
      commands.set(options.commandId, { key, request, revision, command: { commandId: options.commandId, before: before ? { ...before } : { revision: '0', mediaType: null, content: null, sha256: null, deleted: null }, after: { ...after } } });
      if (uncertain) { uncertain = false; throw Object.assign(Error('uncertain'), { code: 'OUTCOME_UNKNOWN' }); }
      return { revision, replayed: false };
    },
    async remove() { throw Error('unused'); }
  };
}
async function call(app, method, route, value, headers = {}) {
  const req = Readable.from([JSON.stringify(value === undefined ? {} : value)]); req.method = method; req.headers = headers;
  const res = { writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; }, end(raw) { this.value = JSON.parse(raw); } };
  const handled = await app.handle(req, res, new URL(route, 'http://127.0.0.1'));
  return { handled, status: res.status, value: res.value };
}
const C1 = '11111111-1111-4111-8111-111111111111', C2 = '22222222-2222-4222-8222-222222222222', C3 = '33333333-3333-4333-8333-333333333333';
const T1 = '2026-09-22T10:00:00.000Z', T2 = '2026-09-22T10:01:00.000Z', T3 = '2026-09-22T10:02:00.000Z';

test('router performs no automatic seed and requires a stable mutation envelope', async () => {
  const app = createWorkspaceTools({ stateStore: memoryStore() });
  assert.deepEqual((await call(app, 'GET', '/api/ideas')).value, { version: 0, ideas: [] });
  assert.equal((await call(app, 'POST', '/api/ideas/create', { version: 0, title: 'Без команды' })).status, 400);
  for (const invalid of [null, [], 'text', 1]) assert.equal((await call(app, 'POST', '/api/ideas/create', invalid)).status, 400);
  await app.seedIdeas({ commandId: C1, timestamp: T1 });
  const seeded = await call(app, 'GET', '/api/ideas'); assert.equal(seeded.value.ideas.length, 1);
  assert.equal((await call(app, 'PUT', '/api/ideas')).status, 405);
  assert.equal((await call(app, 'GET', '/api/unrelated')).handled, false);
});

test('body or matching headers carry stable commands; stale writes and uncertain commits never return 200', async () => {
  const store = memoryStore(), app = createWorkspaceTools({ stateStore: store });
  const input = { version: 0, title: 'SQL идея', commandId: C1, timestamp: T1 };
  store.failNextCommit();
  assert.equal((await call(app, 'POST', '/api/ideas/create', input)).status, 500);
  const resolved = await call(app, 'POST', '/api/ideas/create', input); assert.equal(resolved.status, 200); assert.equal(resolved.value.ideas.length, 1);
  const updated = await call(app, 'POST', '/api/ideas/update', { version: 1, id: C1, status: 'done' }, { 'x-pult-command-id': C2, 'x-pult-command-timestamp': T2 });
  assert.equal(updated.status, 200);
  assert.equal((await call(app, 'POST', '/api/ideas/update', { version: 0, id: C1, status: 'active', commandId: crypto.randomUUID(), timestamp: T2 })).status, 409);
  const replay = await call(app, 'POST', '/api/ideas/create', input); assert.equal(replay.status, 200); assert.deepEqual(replay.value, resolved.value);
  assert.equal((await call(app, 'POST', '/api/ideas/create', { ...input, title: 'Другой payload' })).status, 500);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: HTTP writes survive a fresh router instance', { skip: !integrationUrl }, async () => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /test/iu);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 2 });
  const schema = `workspace_tools_test_${crypto.randomBytes(8).toString('hex')}`; let owned = false;
  try {
    assert.equal((await pool.query('SELECT to_regnamespace($1) AS name', [schema])).rows[0].name, null);
    await pool.query(require('../storage/postgres-schema.cjs').replaceAll('pult', schema)); owned = true;
    await pool.query(require('../storage/postgres-document-schema.cjs').replaceAll('pult', schema));
    const { createStateStore } = require('../storage/postgres-state.cjs');
    let app = createWorkspaceTools({ stateStore: createStateStore({ pool, schema }) });
    assert.equal((await call(app, 'POST', '/api/ideas/create', { version: 0, title: 'Persisted', commandId: C1, timestamp: T1 })).status, 200);
    app = createWorkspaceTools({ stateStore: createStateStore({ pool, schema }) });
    assert.equal((await call(app, 'GET', '/api/ideas')).value.ideas[0].title, 'Persisted');
    const request = await call(app, 'POST', '/api/procurement/request', { version: 0, title: 'Болты', items: [{ name: 'Болт', article: 'A-1', quantity: 2, unit: 'шт' }], commandId: C2, timestamp: T2 });
    assert.equal(request.status, 200);
    const requestId = request.value.id;
    const imported = await call(app, 'POST', '/api/procurement/import', { version: 1, supplierName: 'Поставщик', sourceName: 'fixture.csv', vatBasis: 'included', text: 'Артикул;Наименование;Цена;Остаток;Единица\nA-1;Болт;10;5;шт', commandId: C3, timestamp: T3 });
    assert.equal(imported.status, 200);
    app = createWorkspaceTools({ stateStore: createStateStore({ pool, schema }) });
    const compared = await call(app, 'GET', '/api/procurement/compare?id=' + encodeURIComponent(requestId));
    assert.equal(compared.status, 200); assert.equal(compared.value.items[0].offers[0].price, 10);
  } finally { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
});
