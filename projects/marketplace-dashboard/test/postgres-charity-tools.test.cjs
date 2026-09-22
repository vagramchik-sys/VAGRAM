'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createTools = require('../storage/domains/postgres-charity-tools.cjs');
const COMMAND = '11111111-1111-4111-8111-111111111111', TIME = '2026-09-22T12:00:00Z';
async function serve(t, workspace) { const tools = createTools({ workspace, authorize: async req => req.headers.cookie === 'owner=yes' }), server = http.createServer(async (req, res) => { if (!await tools.handle(req, res, new URL(req.url, 'http://127.0.0.1'))) res.writeHead(404).end(); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve))); return `http://127.0.0.1:${server.address().port}`; }
test('owner ACL, filters, awaited import and stable command envelope are preserved', async t => {
  let call; const workspace = { async read(filters) { return { filters }; }, async importRecords(value, op) { call = { value, op }; return { ok: true }; } }, base = await serve(t, workspace);
  assert.equal((await fetch(base + '/api/charity')).status, 403); const read = await fetch(base + '/api/charity?store=s&status=completed', { headers: { cookie: 'owner=yes' } }); assert.deepEqual((await read.json()).filters, { storeId: 's', status: 'completed' });
  const response = await fetch(base + '/api/charity/import', { method: 'POST', headers: { cookie: 'owner=yes', 'content-type': 'application/json', 'x-pult-command-id': COMMAND, 'x-pult-command-timestamp': TIME }, body: JSON.stringify({ version: 0 }) }); assert.equal(response.status, 200); assert.deepEqual(call, { value: { version: 0 }, op: { commandId: COMMAND, timestamp: TIME } });
  assert.equal((await fetch(base + '/api/charity?store=a&store=b', { headers: { cookie: 'owner=yes' } })).status, 400);
});
test('dependency errors including forged public messages are redacted and unknown outcome has retry guidance', async t => {
  const canary = 'private-db-canary', base = await serve(t, { async read() { throw Object.assign(Error(canary), { public: true, status: 400 }); }, async importRecords() { throw Object.assign(Error(canary), { code: 'OUTCOME_UNKNOWN' }); } }); const failed = await fetch(base + '/api/charity', { headers: { cookie: 'owner=yes' } }); assert.equal(failed.status, 503); assert.equal((await failed.text()).includes(canary), false); const uncertain = await fetch(base + '/api/charity/import', { method: 'POST', headers: { cookie: 'owner=yes', 'content-type': 'application/json', 'x-pult-command-id': COMMAND, 'x-pult-command-timestamp': TIME }, body: '{}' }); assert.equal(uncertain.status, 503); assert.match((await uncertain.text()), /теми же commandId/u);
});
