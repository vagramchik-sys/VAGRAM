'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const createTools = require('../charity-tools.cjs');
test('charity HTTP handler routes exact endpoints behind caller guards and validates import and filters', async t => {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-charity-tools-test-')), tools = createTools({ privateDir });
  const server = http.createServer(async (req, res) => {
    // Same ordering required in the main owner server: auth and Origin before the handler.
    if (req.headers.cookie !== 'owner=fixture') { res.writeHead(401); res.end(); return; }
    if (req.method === 'POST' && req.headers.origin !== origin) { res.writeHead(403); res.end(); return; }
    if (!await tools.handle(req, res, new URL(req.url, origin))) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); const target = path.resolve(privateDir); if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('pult-charity-tools-test-')) throw Error('Unsafe cleanup'); fs.rmSync(target, { recursive: true, force: true }); });
  const headers = { cookie: 'owner=fixture' }, post = body => fetch(origin + '/api/charity/import', { method: 'POST', headers: { ...headers, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(origin + '/api/charity')).status, 401);
  assert.equal((await fetch(origin + '/api/charity/import', { method: 'POST', headers })).status, 403);
  const unloaded = await fetch(origin + '/api/charity', { headers }); assert.equal((await unloaded.json()).counts, null);
  assert.equal((await fetch(origin + '/api/charity/private', { headers })).status, 404);
  assert.equal((await fetch(origin + '/api/charity/import', { headers })).status, 405);
  const data = { version: 0, source: 'Fixture', asOf: '2026-09-20', coverage: { from: '2026-09-01', to: '2026-09-20', complete: false }, records: [{ date: '2026-09-10', programOrRecipient: 'Test', amount: '0.10', currency: 'RUB', status: 'executed', sourceDocument: { label: 'Fixture' }, storeId: '1' }] };
  const imported = await post(data); assert.equal(imported.status, 200); assert.equal((await imported.json()).importResult.inserted, 1);
  const filtered = await fetch(origin + '/api/charity?store=1&status=executed', { headers }); assert.equal((await filtered.json()).records.length, 1);
  for (const query of ['?store=1&store=2', '?owner=other', '?status=invalid']) assert.equal((await fetch(origin + '/api/charity' + query, { headers })).status, 400);
  assert.equal((await post(data)).status, 409);
  assert.equal((await fetch(origin + '/api/charity/import', { method: 'POST', headers: { ...headers, origin, 'content-type': 'text/csv' }, body: 'amount,currency' })).status, 415);
  assert.equal((await fetch(origin + '/api/charity/import', { method: 'POST', headers: { ...headers, origin, 'content-type': 'application/json' }, body: '{broken' })).status, 400);
});
