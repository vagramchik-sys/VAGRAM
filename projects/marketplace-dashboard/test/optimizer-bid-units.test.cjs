'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {bidToRubles, storedBidToRubles, MICRO_RUB, RUB} = require('../optimizer/bid-units.cjs');

test('known micro-ruble bids use an explicit source unit', () => {
  for (const [raw, rubles] of [['130000000', 130], ['200000000', 200], ['3500000', 3.5], ['0', 0], ['1', 0.000001]]) {
    assert.equal(bidToRubles(raw, MICRO_RUB), rubles);
    assert.equal(storedBidToRubles(null, null, raw, MICRO_RUB), rubles);
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

const {advertisingShape} = require('../storage/domains/postgres-optimizer.cjs');

test('stored bids convert raw values only with an explicit supported source unit', () => {
  assert.equal(storedBidToRubles(null, null, '12500000', MICRO_RUB), 12.5);
  assert.equal(storedBidToRubles(undefined, null, '3.5', RUB), 3.5);
  for (const unit of [undefined, null, '', 'OZON_CPC_BID_UNSPECIFIED', 'OZON_CPC_MIN_BID_UNSPECIFIED']) {
    assert.equal(storedBidToRubles(null, null, '12500000', unit), null);
    assert.equal(storedBidToRubles(undefined, MICRO_RUB, '3.5', unit), null);
  }
});

test('stored normalized values retain their own unit and are never scaled twice', () => {
  assert.equal(storedBidToRubles('12.5', RUB, '12500000', MICRO_RUB), 12.5);
  assert.equal(storedBidToRubles('12500000', MICRO_RUB, '12.5', RUB), 12.5);
  assert.equal(storedBidToRubles(0, RUB, '12500000', MICRO_RUB), 0);
  assert.equal(storedBidToRubles('12.5', null, '12500000', MICRO_RUB), null);
});

test('advertising uses the independent declared raw unit of each bid field', () => {
  const input = {
    current_bid_raw: '12500000', current_bid_raw_unit: MICRO_RUB,
    competitive_bid_raw: '13.75', competitive_bid_raw_unit: RUB,
    minimum_bid_raw: '3.5', minimum_bid_raw_unit: RUB
  };
  const row = advertisingShape(input);
  assert.equal(row.currentBid, 12.5);
  assert.equal(row.competitiveBid, 13.75);
  assert.equal(row.minimumBid, 3.5);
  for (const [field, output] of [['current', 'currentBid'], ['competitive', 'competitiveBid'], ['minimum', 'minimumBid']]) {
    for (const unit of [undefined, null, 'OZON_CPC_BID_UNSPECIFIED', 'OZON_CPC_MIN_BID_UNSPECIFIED']) {
      const changed = advertisingShape({...input, [field + '_bid_raw_unit']: unit});
      assert.equal(changed[output], null, field + ' must remain unknown without a supported unit');
      assert.equal(changed[output + 'Raw'], input[field + '_bid_raw']);
      assert.equal(changed[output + 'RawUnit'], unit ?? null);
    }
  }
});
