'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {bidToRubles, storedBidToRubles, MICRO_RUB, RUB} = require('../optimizer/bid-units.cjs');

test('all Ozon raw bids use one explicit micro-ruble conversion', () => {
  for (const [raw, rubles] of [['130000000', 130], ['200000000', 200], ['3500000', 3.5], ['0', 0], ['1', 0.000001]]) {
    assert.equal(bidToRubles(raw, MICRO_RUB), rubles);
    assert.equal(storedBidToRubles(null, null, raw), rubles);
    assert.equal(storedBidToRubles(rubles, RUB, raw), rubles);
  }
});
test('RUB recommendations and profit ceilings are never divided twice', () => {
  for (const value of [130, 136.5, 180, 200]) assert.equal(bidToRubles(value, RUB), value);
  assert.equal(storedBidToRubles(130, RUB, '130000000'), 130);
  assert.equal(storedBidToRubles(130, 'UNKNOWN', '130000000'), null);
});
test('missing, malformed, negative and unsafe bids remain unknown', () => {
  for (const value of [null, undefined, '', ' ', false, 'NaN', Infinity, -1, '1e6', {}, '9007199254740992'])
    assert.equal(bidToRubles(value, MICRO_RUB), null);
  assert.equal(bidToRubles(130, 'UNKNOWN'), null);
});
