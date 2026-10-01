'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const {createOzonAdControlRoutes} = require('../storage/domains/ozon-ad-control-routes.cjs');
const {OzonAdControlError} = require('../storage/ozon-ad-control.cjs');

function fixture() {
  const calls = [], auth = [];
  const control = Object.fromEntries(['overview', 'campaigns', 'campaign', 'preview', 'apply', 'reconcile'].map(name => [name, async value => { calls.push({name, value}); return {name}; }]));
  let allowed = true;
  const routes = createOzonAdControlRoutes({control, authorize: async (req, url) => { auth.push({method: req.method, path: url.pathname}); return allowed; }});
  async function request(path, method = 'GET', payload, headers = {}) {
    const text = typeof payload === 'string' ? payload : payload === undefined ? '' : JSON.stringify(payload);
    const req = Readable.from([text]); req.method = method; req.headers = headers;
    const result = {};
    const res = {writeHead: (status, values) => { result.status = status; result.headers = values; }, end: value => { result.body = JSON.parse(value); }};
    result.handled = await routes.handle(req, res, new URL(path, 'http://localhost'));
    return result;
  }
  return {calls, auth, control, request, deny: () => { allowed = false; }};
}

test('routes require authorization and pass the real URL contract', async () => {
  const f = fixture();
  assert.equal((await f.request('/unrelated')).handled, false);
  f.deny(); assert.equal((await f.request('/api/ad-control')).status, 403); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.auth, [{method: 'GET', path: '/api/ad-control'}]);
});

test('GET paths are read-only and mutation paths require POST', async () => {
  const f = fixture();
  for (const path of ['/api/ad-control', '/api/ad-control/campaigns?store=1', '/api/ad-control/campaign?store=1&campaign=7']) assert.equal((await f.request(path)).status, 200);
  assert.deepEqual(f.calls.map(row => row.name), ['overview', 'campaigns', 'campaign']);
  assert.deepEqual(f.calls[2].value, {storeId: '1', campaignId: '7'});
  assert.equal((await f.request('/api/ad-control/apply')).status, 405);
  assert.equal((await f.request('/api/ad-control/campaign', 'PUT', {})).status, 405);
});

test('POST routes forward only parsed JSON and check conflicting command headers', async () => {
  const f = fixture();
  for (const name of ['preview', 'apply', 'reconcile']) assert.equal((await f.request('/api/ad-control/' + name, 'POST', {token: 'test'})).status, 200);
  assert.equal((await f.request('/api/ad-control/apply', 'POST', {commandId: 'a'}, {'x-pult-command-id': 'b'})).status, 400);
  assert.equal((await f.request('/api/ad-control/preview', 'POST', '{bad')).status, 400);
  assert.equal((await f.request('/api/ad-control/preview', 'POST', 'x'.repeat(16385))).status, 413);
});

test('unknown outcomes are explicit and arbitrary upstream errors never leak secrets', async () => {
  const f = fixture();
  f.control.apply = async () => { throw new OzonAdControlError('OUTCOME_UNKNOWN', 'Нужна сверка.', 503); };
  let result = await f.request('/api/ad-control/apply', 'POST', {});
  assert.equal(result.status, 503); assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  f.control.apply = async () => { throw Error('plaintext-secret'); };
  result = await f.request('/api/ad-control/apply', 'POST', {});
  assert.equal(result.status, 503); assert.equal(JSON.stringify(result).includes('plaintext-secret'), false);
});
