'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createOzonPriceWriteTransport, money, READ_PATH, WRITE_PATH} = require('../storage/acquisition/ozon-price-write.cjs');

const auth = {clientId: '123', apiKey: 'test-secret'};
function fixture({initial = '100.00', failWrite = false, rejectItem = false, staleRead = false} = {}) {
  const calls = []; let current = initial;
  const fetchFn = async (url, options) => {
    const path = new URL(url).pathname, body = JSON.parse(options.body);
    calls.push({path, body, headers: options.headers});
    if (path === READ_PATH) return Response.json({cursor: '', total: 1, items: [{offer_id: 'A-1', price: {currency_code: 'RUB', price: Number(current)}}]});
    assert.equal(path, WRITE_PATH);
    if (failWrite) { if (!staleRead) current = body.prices[0].price; throw Error('connection lost'); }
    if (!rejectItem) current = body.prices[0].price;
    return Response.json({result: [{offer_id: 'A-1', product_id: 1, updated: !rejectItem, errors: rejectItem ? [{code: 'LIMIT'}] : []}]});
  };
  return {transport: createOzonPriceWriteTransport({fetchFn}), calls, current: () => current};
}

test('money values are canonical and reject rounding or unsafe syntax', () => {
  assert.equal(money('102'), '102.00');
  assert.equal(money('102.5'), '102.50');
  for (const value of ['0', '-1', '1.001', '1e2', '01', 'NaN', null, undefined]) assert.equal(money(value), null);
});

test('one matching seller price is written once, then verified with v5 readback', async () => {
  const {transport, calls} = fixture();
  const result = await transport.writeOnce(auth, {offerId: 'A-1', expectedPrice: '100', desiredPrice: '102'});
  assert.deepEqual(result, {status: 'VERIFIED', applied: true, offerId: 'A-1', price: '102.00'});
  assert.deepEqual(calls.map(call => call.path), [READ_PATH, WRITE_PATH, READ_PATH]);
  assert.deepEqual(calls[1].body, {prices: [{offer_id: 'A-1', price: '102.00', currency_code: 'RUB'}]});
  assert.deepEqual(calls[0].body.filter, {offer_id: ['A-1'], visibility: 'ALL'});
  assert.equal(calls[1].headers['Api-Key'], auth.apiKey);
});

test('changed current price blocks the write and replay of desired state is harmless', async () => {
  const changed = fixture({initial: '101.00'});
  assert.deepEqual(await changed.transport.writeOnce(auth, {offerId: 'A-1', expectedPrice: '100', desiredPrice: '102'}), {status: 'HOLD', reason: 'PRICE_CHANGED', offerId: 'A-1', price: '101.00'});
  assert.deepEqual(changed.calls.map(call => call.path), [READ_PATH]);
  const applied = fixture({initial: '102.00'});
  assert.deepEqual(await applied.transport.writeOnce(auth, {offerId: 'A-1', expectedPrice: '100', desiredPrice: '102'}), {status: 'VERIFIED', applied: false, offerId: 'A-1', price: '102.00'});
  assert.deepEqual(applied.calls.map(call => call.path), [READ_PATH]);
});

test('lost response is resolved by readback, while rejected or ambiguous writes are never blindly retried', async () => {
  const applied = fixture({failWrite: true});
  assert.equal((await applied.transport.writeOnce(auth, {offerId: 'A-1', expectedPrice: '100', desiredPrice: '102'})).status, 'VERIFIED');
  assert.deepEqual(applied.calls.map(call => call.path), [READ_PATH, WRITE_PATH, READ_PATH]);
  for (const options of [{failWrite: true, staleRead: true}, {rejectItem: true}]) {
    const {transport, calls} = fixture(options);
    const result = await transport.writeOnce(auth, {offerId: 'A-1', expectedPrice: '100', desiredPrice: '102'});
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(calls.filter(call => call.path === WRITE_PATH).length, 1);
  }
});

test('ambiguous readback and unsupported currency stop before write', async () => {
  const transport = createOzonPriceWriteTransport({fetchFn: async () => Response.json({cursor: '', total: 2, items: [{offer_id: 'A-1', price: {price: 100, currency_code: 'RUB'}}]})});
  await assert.rejects(transport.writeOnce(auth, {offerId: 'A-1', expectedPrice: '100', desiredPrice: '102'}), {code: 'INVALID_RESPONSE'});
  await assert.rejects(transport.writeOnce(auth, {offerId: 'A-1', expectedPrice: '100', desiredPrice: '100'}), {code: 'INVALID_ARGUMENT'});
});
