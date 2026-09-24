'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateRecommendedBid, calculateRecommendedPrice, qualityGate,
  confidence, optimizerDecision, DEFAULT_SETTINGS } = require('../optimizer/decision.cjs');

function fixture() {
  const period = { periodFrom: '2026-09-10', periodTo: '2026-09-23', scope: 'sku', orderBasis: 'order', attributionModel: 'click', complete: true };
  const observedAt = '2026-09-24T08:30:00.000Z';
  return {
    now: '2026-09-24T09:00:00.000Z', skuLinkStatus: 'matched',
    product: { id: 'product-one', storeId: 'store-one', sku: 'sku-one', active: true },
    price: { sellerPrice: 1000, currency: 'RUB', priceIncrement: 1, observedAt },
    cost: { unitCost: 400, currency: 'RUB', status: 'filled', observedAt },
    stock: { quantity: 500, days: 30, observedAt },
    finance: { ...period, realizedRevenue: 140000, cost: 56000, commission: 14000,
      logistics: 7000, acquiring: 1400, marketplaceServices: 2100, compensation: 700,
      advertising: 7000, orders: 140, observedAt },
    ads: { ...period, connected: true, model: 'CPC', unit: 'RUB_PER_CLICK',
      currentBid: 10, competitiveBid: 25, minimumBid: 1, bidIncrement: 0.01,
      impressions: 28000, clicks: 1400, orders: 140, spend: 7000, revenue: 140000, observedAt },
    settings: { mode: 'RECOMMEND', targetProfitPerOrder: 200 },
    history: { state: 'BASELINE', activeExperiment: null, lastActionAt: null,
      baseline: { contributionAfterAds: 53200, orders: 140, periodDays: 14, complete: true },
      current: null, priceTestPassed: false },
  };
}

function withExperiment(dimension = 'PRICE') {
  const input = fixture();
  input.history.activeExperiment = { id: 'experiment-one', dimension,
    beforeValue: dimension === 'PRICE' ? 1000 : 10,
    afterValue: dimension === 'PRICE' ? 1050 : 11,
    startedAt: '2026-09-10T08:00:00.000Z', observeUntil: '2026-09-17T08:00:00.000Z', status: 'observing' };
  if (dimension === 'PRICE') input.price.sellerPrice = 1050;
  else input.ads.currentBid = 11;
  input.history.current = { contributionAfterAds: 40000, orders: 140, periodDays: 14, complete: true };
  return input;
}

function bid(overrides = {}) {
  return calculateRecommendedBid({ currentBid: 10, competitiveBid: 25, minimumBid: 1,
    maxProfitableBid: 17, competitiveBuffer: 1, bidStepPct: 0.1, bidIncrement: 0.01, ...overrides });
}

test('bid grows at most 10%, respects the economic cap and treats competitive as a ceiling', () => {
  assert.equal(bid(), 11);
  assert.equal(bid({ currentBid: 16 }), 17);
  assert.equal(bid({ competitiveBid: 10.5 }), 10.5);
  assert.equal(bid({ competitiveBid: 10, competitiveBuffer: 0.95 }), 9.5);
  assert.equal(bid({ minimumBid: 18 }), null);
  assert.equal(bid({ maxProfitableBid: 0 }), null);
});

test('bid rounds down to documented increments, including decimal division boundaries', () => {
  assert.equal(bid({ currentBid: 16, maxProfitableBid: 17.005 }), 17);
  assert.equal(bid({ currentBid: 0.29, competitiveBid: 0.29, maxProfitableBid: 0.29, minimumBid: 0.01 }), 0.29);
  assert.equal(bid({ currentBid: 16, minimumBid: 16.999, bidIncrement: 0.03 }), null);
  assert.equal(bid({ currentBid: 16, maxProfitableBid: 17.002, bidIncrement: 0.03 }), 16.98);
  assert.equal(bid({ bidIncrement: null }), null);
  assert.equal(bid({ bidIncrement: 1e-30 }), null);
});

test('invalid settings, strings and unknown bid inputs never generate money', () => {
  for (const field of ['currentBid', 'competitiveBid', 'minimumBid', 'maxProfitableBid', 'competitiveBuffer', 'bidIncrement']) {
    for (const value of [null, undefined, '1', NaN, Infinity, -1]) assert.equal(bid({ [field]: value }), null, field);
  }
  assert.equal(bid({ bidStepPct: 0.11 }), null);
  assert.equal(bid({ bidStepPct: null }), null);
  assert.equal(calculateRecommendedBid(null), null);
});

test('price is an allowed controlled 5% experiment using a supplied increment', () => {
  const input = { sellerPrice: 1000, priceStepPct: 0.05, allowed: true, priceIncrement: 1 };
  assert.equal(calculateRecommendedPrice(input), 1050);
  assert.equal(calculateRecommendedPrice({ ...input, sellerPrice: 999, priceIncrement: 10 }), 1040);
  for (const allowed of [false, undefined, null, 'true']) assert.equal(calculateRecommendedPrice({ ...input, allowed }), null);
  assert.equal(calculateRecommendedPrice({ ...input, priceIncrement: null }), null);
  assert.equal(calculateRecommendedPrice({ ...input, priceStepPct: 0.051 }), null);
  assert.equal(calculateRecommendedPrice({ ...input, priceStepPct: 0 }), null);
});

test('full valid inputs clear gates and produce only a PRICE recommendation', () => {
  const input = fixture();
  assert.deepEqual(qualityGate(input), []);
  const result = optimizerDecision(input);
  assert.equal(result.state, 'PRICE_UP');
  assert.equal(result.action, 'PRICE');
  assert.equal(result.recommendedPrice, 1050);
  assert.equal(result.recommendedBid, null);
  assert.ok(Math.abs(result.maxProfitableBid - 18.4) < 1e-12);
  assert.equal(result.confidence, 'MEDIUM');
});

test('successful price test opens profitable reach with at most one BID recommendation', () => {
  const input = fixture(); input.history.priceTestPassed = true;
  const result = optimizerDecision(input);
  assert.equal(result.state, 'BID_UP');
  assert.equal(result.action, 'BID');
  assert.equal(result.recommendedPrice, null);
  assert.equal(result.recommendedBid, 11);
  assert.ok(result.recommendedBid <= result.maxProfitableBid);
  assert.ok(result.reasonCodes.includes('MAX_PROFITABLE_LIMIT'));
});

test('confirmed baseline can support BID without price test when price experiments are disabled', () => {
  const input = fixture(); input.settings.priceStepPct = 0;
  assert.equal(optimizerDecision(input).state, 'BID_UP');
});

const gateCases = [
  ['MISSING_COST', input => { input.cost.unitCost = null; }],
  ['MISSING_COST', input => { input.cost.status = 'missing'; }],
  ['INACTIVE_PRODUCT', input => { input.product.active = false; }],
  ['UNKNOWN_PRODUCT_STATUS', input => { delete input.product.active; }],
  ['MISSING_PRICE', input => { input.price.sellerPrice = '1000'; }],
  ['STALE_PRICE', input => { input.price.observedAt = '2026-09-22T09:00:00Z'; }],
  ['INVALID_PRICE_TIMESTAMP', input => { input.price.observedAt = '2026-09-25T09:00:00Z'; }],
  ['LOW_STOCK', input => { input.stock.quantity = 4; }],
  ['LOW_STOCK', input => { input.stock.days = 6; }],
  ['UNKNOWN_STOCK', input => { input.stock.quantity = null; }],
  ['UNKNOWN_STOCK', input => { input.stock.days = null; }],
  ['STALE_STOCK', input => { input.stock.observedAt = '2026-09-22T09:00:00Z'; }],
  ['INSUFFICIENT_DATA', input => { input.finance.commission = null; }],
  ['ECONOMICS_INCOMPLETE', input => { input.finance.advertising = null; }],
  ['NEGATIVE_CONTRIBUTION', input => { input.finance.advertising = 100000; }],
  ['PROFIT_FLOOR_VIOLATED', input => { input.settings.targetProfitPerOrder = 400; }],
  ['FINANCE_PERIOD_INCOMPLETE', input => { input.finance.complete = false; }],
  ['FINANCE_PERIOD_INCOMPLETE', input => { input.finance.periodTo = '2026-09-24'; }],
  ['FINANCE_PERIOD_INCOMPLETE', input => { input.finance.periodFrom = '2026-02-30'; }],
  ['STALE_FINANCE', input => { input.finance.observedAt = '2026-09-22T09:00:00Z'; }],
  ['INSUFFICIENT_ORDERS', input => { input.finance.orders = 0; }],
  ['PERFORMANCE_NOT_CONNECTED', input => { input.ads.connected = false; }],
  ['ADS_INCOMPLETE', input => { input.ads.complete = false; }],
  ['STALE_ADS', input => { input.ads.observedAt = '2026-09-24T06:59:59Z'; }],
  ['UNSUPPORTED_AD_MODEL', input => { input.ads.model = 'CPM'; }],
  ['UNSUPPORTED_BID_UNIT', input => { input.ads.unit = 'MILLIONTHS_RUB'; }],
  ['UNSUPPORTED_CURRENCY', input => { input.price.currency = 'USD'; }],
  ['UNSUPPORTED_CURRENCY', input => { input.finance.currency = 'USD'; }],
  ['INVALID_ADVERTISING_DATA', input => { input.ads.clicks = 1.5; }],
  ['INVALID_ADVERTISING_DATA', input => { input.ads.orders = 1500; }],
  ['INVALID_ADVERTISING_DATA', input => { input.ads.impressions = 1; }],
  ['INVALID_ADVERTISING_DATA', input => { input.ads.spend = -1; }],
  ['INVALID_ADVERTISING_DATA', input => { input.ads.observedCVR = 0.99; }],
  ['PERIOD_MISMATCH', input => { input.ads.periodFrom = '2026-09-09'; }],
  ['ORDER_BASIS_MISMATCH', input => { input.ads.orderBasis = 'unit'; }],
  ['ORDER_BASIS_MISMATCH', input => { input.ads.orderBasis = null; }],
  ['SCOPE_MISMATCH', input => { input.ads.scope = 'campaign_sku'; }],
  ['SCOPE_MISMATCH', input => { delete input.finance.scope; }],
  ['ATTRIBUTION_MISMATCH', input => { input.ads.attributionModel = 'click'; input.finance.attributionModel = 'view'; }],
  ['ATTRIBUTION_MISMATCH', input => { delete input.finance.attributionModel; }],
  ['STORE_SCOPE_MISMATCH', input => { input.ads.storeId = 'another-store'; }],
  ['PRODUCT_SCOPE_MISMATCH', input => { input.finance.productId = 'another-product'; }],
  ['KILL_SWITCH', input => { input.settings.killSwitch = true; }],
  ['COOLDOWN_ACTIVE', input => { input.history.lastActionAt = '2026-09-23T09:00:00Z'; }],
  ['INVALID_HISTORY', input => { input.history.lastActionAt = 'tomorrow'; }],
  ['INVALID_SETTINGS', input => { input.settings.priceStepPct = 0.2; }],
  ['INVALID_SETTINGS', input => { input.settings.bidStepPct = 10; }],
  ['INVALID_SETTINGS', input => { input.settings.targetProfitPerOrder = null; }],
  ['AUTO_DISABLED', input => { input.settings.mode = 'AUTO'; }],
  ['INVALID_NOW', input => { delete input.now; }],
];
for (const [code, mutate] of gateCases) {
  test(`quality gate blocks ${code} (${gateCases.findIndex(row => row[1] === mutate)})`, () => {
    const input = fixture(); mutate(input);
    assert.ok(qualityGate(input).includes(code));
    const result = optimizerDecision(input);
    assert.equal(result.state, 'BLOCKED');
    assert.equal(result.action, 'NONE');
    assert.ok(result.blockers.includes(code));
    assert.equal(result.recommendedBid, null);
    assert.equal(result.recommendedPrice, null);
  });
}

test('BID also requires unambiguous SKU mapping, minimum/current/competitive bid and documented increment', () => {
  const cases = [
    ['AMBIGUOUS_SKU', input => { input.skuLinkStatus = 'ambiguous'; }],
    ['UNMAPPED_SKU', input => { delete input.skuLinkStatus; }],
    ['MISSING_CURRENT_BID', input => { input.ads.currentBid = null; }],
    ['MISSING_COMPETITIVE_BID', input => { input.ads.competitiveBid = null; }],
    ['MISSING_MINIMUM_BID', input => { input.ads.minimumBid = null; }],
    ['MISSING_BID_INCREMENT', input => { input.ads.bidIncrement = null; }],
    ['MIN_BID_EXCEEDS_PROFIT_CAP', input => { input.ads.minimumBid = 20; }],
  ];
  for (const [code, mutate] of cases) {
    const input = fixture(); input.history.priceTestPassed = true; mutate(input);
    const result = optimizerDecision(input);
    assert.equal(result.state, 'BLOCKED'); assert.ok(result.blockers.includes(code), code);
    assert.equal(result.recommendedBid, null);
  }
  const input = fixture(); delete input.skuLinkStatus; input.ads.skuLinkStatus = 'matched';
  assert.deepEqual(qualityGate(input), []);
});

test('no history means BASELINE; a recommendation never creates its own experiment', () => {
  const input = fixture(); delete input.history;
  assert.equal(optimizerDecision(input).state, 'BASELINE');
  const observed = fixture(), before = structuredClone(observed);
  assert.deepEqual(optimizerDecision(observed), optimizerDecision(observed));
  assert.deepEqual(observed, before);
  assert.equal(observed.history.activeExperiment, null);
});

test('missing/incomplete baseline and inadequate observations cannot escalate risk', () => {
  for (const baseline of [null, { complete: false }, { contributionAfterAds: 1000, orders: 1, periodDays: 1, complete: true }]) {
    const input = fixture(); input.history.baseline = baseline;
    assert.equal(optimizerDecision(input).state, 'BASELINE');
  }
  const input = fixture(); input.ads.clicks = 1; input.ads.orders = 1; input.ads.impressions = 1;
  assert.equal(confidence(input), 'LOW');
  assert.equal(optimizerDecision(input).state, 'HOLD');
  assert.ok(optimizerDecision(input).reasonCodes.includes('LOW_CONFIDENCE'));
});

test('zero clicks/orders never create CVR, Infinity or a profitable cap', () => {
  const input = fixture(); Object.assign(input.ads, { clicks: 0, orders: 0, spend: 0, revenue: 0 });
  const result = optimizerDecision(input);
  assert.equal(result.state, 'HOLD');
  assert.equal(result.maxProfitableBid, null);
  assert.equal(result.action, 'NONE');
});

test('confidence needs sample counts, full windows and observed day-to-day stability', () => {
  const input = fixture();
  assert.equal(confidence(input), 'MEDIUM');
  input.ads.daily = Array.from({ length: 14 }, (_, index) => ({
    date: `2026-09-${10 + index}`, impressions: 2000, clicks: 100, orders: 10, complete: true,
  }));
  assert.equal(confidence(input), 'HIGH');
  input.ads.daily[0].orders = 19; input.ads.daily[1].orders = 1;
  assert.equal(confidence(input), 'LOW');
  assert.equal(optimizerDecision(input).state, 'HOLD');
});

test('one anomalous day cannot masquerade as a stable two-week aggregate', () => {
  const input = fixture();
  input.ads.daily = Array.from({ length: 14 }, (_, index) => ({
    date: `2026-09-${10 + index}`, impressions: index ? 0 : 28000,
    clicks: index ? 0 : 1400, orders: index ? 0 : 140, complete: true,
  }));
  assert.equal(confidence(input), 'LOW');
  input.ads.daily = [{ date: '2026-09-10', impressions: 28000, clicks: 1400, orders: 140, complete: true }];
  assert.equal(confidence(input), 'LOW');
});

test('OBSERVE suppresses actionable recommendations and AUTO is permanently disabled', () => {
  const input = fixture(); delete input.settings;
  assert.equal(DEFAULT_SETTINGS.mode, 'OBSERVE');
  assert.equal(optimizerDecision(input).state, 'HOLD');
  assert.equal(optimizerDecision(input).action, 'NONE');
  input.settings = { mode: 'AUTO' };
  assert.equal(optimizerDecision(input).state, 'BLOCKED');
  const rollback = withExperiment(); rollback.settings.mode = 'OBSERVE';
  assert.equal(optimizerDecision(rollback).action, 'NONE');
});

for (const dimension of ['PRICE', 'BID']) {
  test(`active ${dimension} experiment waits for mature observations then rolls back its own dimension`, () => {
    const input = withExperiment(dimension);
    input.history.activeExperiment.observeUntil = '2026-09-25T08:00:00Z';
    assert.ok(qualityGate(input).includes('WAITING_FOR_EXPERIMENT'));
    let result = optimizerDecision(input);
    assert.equal(result.state, dimension === 'PRICE' ? 'WAIT_PRICE' : 'WAIT_ADS');
    assert.equal(result.action, 'NONE');
    input.history.activeExperiment.observeUntil = '2026-09-17T08:00:00Z';
    result = optimizerDecision(input);
    assert.equal(result.state, 'ROLLBACK');
    assert.equal(result.action, dimension);
    assert.equal(result.recommendedPrice, dimension === 'PRICE' ? 1000 : null);
    assert.equal(result.recommendedBid, dimension === 'BID' ? 10 : null);
  });
}

test('mature experiment with incomplete results keeps waiting and never invents failure', () => {
  const input = withExperiment(); input.history.current.complete = false;
  assert.equal(optimizerDecision(input).state, 'WAIT_PRICE');
  input.history.current = null;
  assert.equal(optimizerDecision(input).action, 'NONE');
});

test('rollback ignores cooldown but respects kill switch and still requires a safe confirmed prior value', () => {
  const input = withExperiment('BID'); input.history.lastActionAt = '2026-09-23T09:00:00Z';
  assert.equal(optimizerDecision(input).state, 'ROLLBACK');
  input.settings.killSwitch = true;
  assert.equal(optimizerDecision(input).state, 'BLOCKED');
  input.settings.killSwitch = false; input.history.activeExperiment.beforeValue = 20;
  assert.equal(optimizerDecision(input).state, 'BLOCKED');
  assert.ok(optimizerDecision(input).blockers.includes('UNSAFE_ROLLBACK'));
});

test('rollback cannot overwrite a later value or return to a bid above the current profit cap', () => {
  const input = withExperiment(); input.price.sellerPrice = 1030;
  assert.ok(optimizerDecision(input).blockers.includes('EXPERIMENT_VALUE_MISMATCH'));
  const bidInput = withExperiment('BID'); bidInput.settings.targetProfitPerOrder = 350;
  assert.ok(optimizerDecision(bidInput).blockers.includes('UNSAFE_ROLLBACK'));
});

test('absolute contribution is normalized by window duration, not ranked by margin', () => {
  const input = withExperiment();
  input.history.baseline = { contributionAfterAds: 50000, orders: 100, periodDays: 14, complete: true, marginPct: 80 };
  input.history.current = { contributionAfterAds: 60000, orders: 250, periodDays: 14, complete: true, marginPct: 30 };
  assert.equal(optimizerDecision(input).state, 'HOLD');
  assert.ok(optimizerDecision(input).reasonCodes.includes('EXPERIMENT_PASSED'));
  input.history.current = { contributionAfterAds: 30000, orders: 100, periodDays: 7, complete: true, marginPct: 20 };
  assert.equal(optimizerDecision(input).state, 'HOLD');
  input.history.current = { contributionAfterAds: 40000, orders: 50, periodDays: 14, complete: true, marginPct: 95 };
  assert.equal(optimizerDecision(input).state, 'ROLLBACK');
});

test('larger absolute profit never overrides an explicit minimum profit per order', () => {
  const input = withExperiment('BID');
  input.history.current = { contributionAfterAds: 60000, orders: 1000, periodDays: 14, complete: true };
  const result = optimizerDecision(input);
  assert.equal(result.state, 'ROLLBACK');
  assert.ok(result.reasonCodes.includes('PROFIT_FLOOR_VIOLATED'));
});

test('a historical baseline must independently support the profit floor and comparable order basis', () => {
  const input = fixture(); input.history.baseline.contributionAfterAds = 1000;
  assert.ok(optimizerDecision(input).blockers.includes('BASELINE_PROFIT_FLOOR_VIOLATED'));
  const experiment = withExperiment();
  experiment.history.baseline.orderBasis = 'order'; experiment.history.current.orderBasis = 'unit';
  assert.ok(optimizerDecision(experiment).blockers.includes('EXPERIMENT_BASIS_MISMATCH'));
});

test('a successful historical window cannot hide a currently violated profit floor', () => {
  const input = withExperiment();
  input.history.current.contributionAfterAds = 60000;
  input.finance.advertising = 50000;
  const result = optimizerDecision(input);
  assert.equal(result.state, 'HOLD');
  assert.ok(result.reasonCodes.includes('PROFIT_FLOOR_VIOLATED'));
  assert.ok(!result.reasonCodes.includes('EXPERIMENT_PASSED'));
});

test('blocked decisions explain the concrete cause to the owner', () => {
  const input = fixture(); input.stock.quantity = 1;
  assert.match(optimizerDecision(input).humanReason, /Остаток/);
  input.stock.quantity = 500; input.ads.unit = 'UNKNOWN';
  assert.match(optimizerDecision(input).humanReason, /рубли за клик/);
});

test('at or above the profit cap, competitive targets cannot force a bid increase', () => {
  const input = fixture(); input.history.priceTestPassed = true; input.ads.competitiveBid = 100000;
  input.ads.currentBid = 18.4;
  assert.equal(optimizerDecision(input).state, 'HOLD');
  input.ads.currentBid = 50;
  assert.equal(optimizerDecision(input).state, 'HOLD');
  assert.equal(optimizerDecision(input).recommendedBid, null);
  assert.ok(optimizerDecision(input).reasonCodes.includes('CURRENT_BID_ABOVE_PROFIT_CAP'));
});

test('profit floor, zero safety budget and competitive saturation result in HOLD', () => {
  const input = fixture(); input.settings.targetProfitPerOrder = 380;
  assert.equal(optimizerDecision(input).state, 'HOLD');
  input.settings.targetProfitPerOrder = 200; input.settings.safetyFactor = 0;
  assert.equal(optimizerDecision(input).state, 'HOLD');
  input.settings.safetyFactor = 0.8; input.history.priceTestPassed = true; input.ads.competitiveBid = 10;
  assert.equal(optimizerDecision(input).state, 'HOLD');
});

test('recommendations never contain both dimensions and every bid respects every hard ceiling', () => {
  for (const currentBid of [1, 5, 10, 16, 18.4, 50]) {
    for (const competitiveBid of [0.5, 10, 25, 100000]) {
      for (const priceTestPassed of [false, true]) {
        const input = fixture(); Object.assign(input.ads, { currentBid, competitiveBid }); input.history.priceTestPassed = priceTestPassed;
        const result = optimizerDecision(input);
        assert.ok(result.recommendedPrice === null || result.recommendedBid === null);
        if (result.action === 'NONE') assert.equal(result.recommendedPrice ?? result.recommendedBid, null);
        if (result.action === 'BID') {
          assert.ok(result.recommendedBid <= result.maxProfitableBid);
          assert.ok(result.recommendedBid <= currentBid * 1.1);
          assert.ok(result.recommendedBid <= competitiveBid);
          assert.ok(result.recommendedBid >= input.ads.minimumBid);
        }
      }
    }
  }
});

test('missing objects fail closed and pure decision does not read the wall clock', () => {
  for (const input of [undefined, null, {}, { now: '2026-09-24T09:00:00Z' }]) {
    const result = optimizerDecision(input);
    assert.equal(result.state, 'BLOCKED');
    assert.equal(result.action, 'NONE');
    assert.equal(result.maxProfitableBid, null);
  }
  const input = fixture(); delete input.now;
  assert.ok(optimizerDecision(input).blockers.includes('INVALID_NOW'));
});

test('unknown attribution cannot turn realized-sales economics into an attributed conversion cap', () => {
  for (const attributionModel of [undefined, null, '', '   ']) {
    const input = fixture();
    input.ads.attributionModel = attributionModel;
    input.finance.attributionModel = attributionModel;
    const result = optimizerDecision(input);
    assert.equal(result.state, 'BLOCKED');
    assert.equal(result.maxProfitableBid, null);
    assert.ok(result.blockers.includes('ATTRIBUTION_MISMATCH'));
  }
});

test('large ad sample cannot hide a small realized finance sample', () => {
  for (const priceTestPassed of [false, true]) {
    const input = fixture();
    input.finance.orders = 1;
    input.history.priceTestPassed = priceTestPassed;
    assert.equal(confidence(input), 'LOW');
    const result = optimizerDecision(input);
    assert.equal(result.state, 'HOLD');
    assert.equal(result.action, 'NONE');
    assert.ok(result.reasonCodes.includes('LOW_CONFIDENCE'));
  }
});

test('waiting history without its matching active experiment never starts another dimension', () => {
  for (const state of ['WAIT_PRICE', 'WAIT_ADS']) {
    const input = fixture();
    input.history.state = state;
    input.history.priceTestPassed = true;
    assert.ok(optimizerDecision(input).blockers.includes('INVALID_HISTORY'));
    input.history.activeExperiment = withExperiment(state === 'WAIT_PRICE' ? 'BID' : 'PRICE').history.activeExperiment;
    assert.ok(optimizerDecision(input).blockers.includes('INVALID_HISTORY'));
  }
});

test('manual value drift cannot pass an otherwise profitable experiment or silently continue observation', () => {
  for (const dimension of ['PRICE', 'BID']) {
    for (const observing of [true, false]) {
      const input = withExperiment(dimension);
      input.history.current.contributionAfterAds = 60000;
      if (observing) input.history.activeExperiment.observeUntil = '2026-09-25T08:00:00Z';
      if (dimension === 'PRICE') input.price.sellerPrice = 1060;
      else input.ads.currentBid = 12;
      const result = optimizerDecision(input);
      assert.equal(result.state, 'BLOCKED');
      assert.equal(result.action, 'NONE');
      assert.ok(result.blockers.includes('EXPERIMENT_VALUE_MISMATCH'));
      assert.ok(!result.reasonCodes.includes('EXPERIMENT_PASSED'));
    }
  }
});
