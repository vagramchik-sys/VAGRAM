'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createOzonAdManagementTransport, toMicroRubles} = require('../storage/acquisition/ozon-ad-management-transport.cjs');
const credentials = {storeId: '7', clientId: 'fixture-client', clientSecret: 'fixture-only-secret'};
function fixture(reply) {
  const calls = [];
  const transport = createOzonAdManagementTransport({getCredentials: async () => credentials, fetchFn: async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/api/client/token') return Response.json({access_token: 'fixture-only-access-token', expires_in: 3600});
    calls.push({path, method: options.method, body: options.body && JSON.parse(options.body)});
    return reply(path, options);
  }});
  return {transport, calls};
}
test('weekly budgets are exact micro-rubles, invalid precision never reaches Ozon', async () => {
  assert.equal(toMicroRubles(5000.01), '5000010000');
  for (const value of [0, -1, NaN, Infinity, '5000', 1.001, 100000001]) assert.throws(() => toMicroRubles(value), {code: 'INVALID_ARGUMENT'});
  const {transport, calls} = fixture(() => new Response(null, {status: 204}));
  await transport.updateWeeklyBudget('7', '9', 5000.01);
  assert.deepEqual(calls, [{path: '/api/client/campaign/9', method: 'PATCH', body: {weeklyBudget: '5000010000'}}]);
  assert.throws(() => transport.updateWeeklyBudget('7', '9', 1.001));
  assert.equal(calls.length, 1);
});
test('state commands use only explicit activation endpoints and empty bodies', async () => {
  const {transport, calls} = fixture(() => Response.json({state: 'UNKNOWN'}));
  await transport.setCampaignActive('7', '9', false);
  await transport.setCampaignActive('7', '9', true);
  assert.deepEqual(calls, [
    {path: '/api/client/campaign/9/deactivate', method: 'POST', body: {}},
    {path: '/api/client/campaign/9/activate', method: 'POST', body: {}}
  ]);
  assert.throws(() => transport.setCampaignActive('7', '9', 'false'), {code: 'INVALID_ARGUMENT'});
});
test('uncertain mutation is sent once, with no automatic retries', async () => {
  for (const result of ['disconnect', 500, 503, 408]) {
    const {transport, calls} = fixture(() => {if (result === 'disconnect') throw Error('network'); return new Response('{}', {status: result});});
    await assert.rejects(transport.updateWeeklyBudget('7', '9', 100), {code: 'WRITE_OUTCOME_UNKNOWN'});
    assert.equal(calls.length, 1);
  }
});
test('definite rejection does not retry or expose upstream response text', async () => {
  for (const status of [400, 401, 403, 429]) {
    const {transport, calls} = fixture(() => new Response(credentials.clientSecret, {status}));
    await assert.rejects(transport.setCampaignActive('7', '9', false), error => error.code === 'MUTATION_REJECTED' && error.status === status && !error.message.includes(credentials.clientSecret));
    assert.equal(calls.length, 1);
  }
});
test('bid changes stay disabled even when called without the UI', async () => {
  const {transport, calls} = fixture(() => assert.fail('must never dispatch'));
  assert.equal(transport.getManagementCapabilities().bidWrite, false);
  await assert.rejects(transport.updateProductBid('7', '9', '123', 20), {code: 'BID_WRITE_DISABLED'});
  assert.equal(calls.length, 0);
});
test('tokens are scoped to the selected store and invalid campaign ids never dispatch', async () => {
  const {transport, calls} = fixture(() => assert.fail('must never dispatch'));
  await assert.rejects(transport.listCampaigns('8'), {code: 'MISSING_CREDENTIALS'});
  await assert.rejects(transport.setCampaignActive('7', '../9', true), {code: 'INVALID_ARGUMENT'});
  assert.equal(calls.length, 0);
});
test('campaign reads preserve raw values and never issue write methods', async () => {
  const {transport, calls} = fixture(path => Response.json(path.endsWith('/products') ? {products: [{sku: '12', bid: '13000000'}]} : {list: [{id: '9', weeklyBudget: '5000000000', state: 'RUNNING'}]}));
  const campaigns = await transport.listCampaigns('7');
  assert.equal(campaigns[0].weeklyBudget, '5000000000');
  assert.equal((await transport.listCampaignProducts('7', '9'))[0].bid, '13000000');
  assert.equal(calls.every(call => call.method === 'GET'), true);
});
