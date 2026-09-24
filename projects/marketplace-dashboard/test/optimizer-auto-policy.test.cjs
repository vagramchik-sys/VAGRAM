'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {evaluateAutoPrice, evaluateAutoBid} = require('../optimizer/auto-policy.cjs');

const now = '2026-09-24T09:00:00Z';
function priceFixture() {
  return {autoEnabled: true, killSwitch: false, now, profitFloorPerOrder: 100,
    decision: {state: 'PRICE_UP', action: 'PRICE', confidence: 'HIGH', recommendedPrice: 1020, blockers: [], reasonCodes: ['PROFIT_BUFFER_AVAILABLE']},
    price: {sellerPrice: 1000, currency: 'RUB'}, stock: {quantity: 100, days: 20},
    finance: {complete: true, contributionAfterAds: 20000, orders: 100},
    history: {activeExperiment: null, lastPriceActionAt: null},
    evidence: {minimumStepVerified: true, minimumStepSource: 'ozon_api', minimumStepObservedAt: now, minimumAcceptedStepPct: 0.02,
      priceIndex: {verified: true, withinCorridor: true, fresh: true, evaluatedSellerPrice: 1020},
      customerPriceCorridor: {verified: true, withinCorridor: true, fresh: true, evaluatedSellerPrice: 1020},
      conversionRisk: {verified: true, acceptable: true, sampleComplete: true, evaluatedSellerPrice: 1020}}};
}
function bidFixture() {
  return {autoEnabled: true, killSwitch: false, now, profitFloorPerOrder: 100,
    decision: {state: 'BID_UP', action: 'BID', confidence: 'HIGH', recommendedBid: 10.5, maxProfitableBid: 15, blockers: [], reasonCodes: ['PROFIT_BUFFER_AVAILABLE', 'BID_BELOW_COMPETITIVE']},
    ads: {model: 'CPC', unit: 'RUB_PER_CLICK', currentBid: 10, competitiveBid: 20},
    finance: {complete: true, periodFrom: '2026-08-25', periodTo: '2026-09-23', realizedRevenue: 100000, advertising: 12000, contributionAfterAds: 20000, orders: 100},
    history: {lastBidActionAt: '2026-09-23T18:00:00Z', previousBidStep: {
      actionAt: '2026-09-23T18:00:00Z', observedFrom: '2026-09-23T18:00:00Z', observedTo: '2026-09-24T08:00:00Z',
      evaluated: true, complete: true, baselineComparable: true, profitDidNotDecline: true,
      clicks: 120, orders: 12}},
    spendGuard: {enforced: true, scope: 'sku', windowDays: 30, maxShare: 0.15}};
}

test('price AUTO allows the owner 2% only with verified independent evidence', () => {
  assert.deepEqual(evaluateAutoPrice(priceFixture()), {state: 'READY', allowed: true, dimension: 'PRICE', value: 1020, reasonCodes: []});
  const missing = priceFixture(); delete missing.evidence.customerPriceCorridor;
  assert.equal(evaluateAutoPrice(missing).state, 'HOLD');
  assert.ok(evaluateAutoPrice(missing).reasonCodes.includes('CUSTOMER_PRICE_CORRIDOR_UNVERIFIED'));
});

test('5% price fallback needs a confirmed Ozon minimum and every guardrail; unknown minimum is HOLD', () => {
  const input = priceFixture(); input.evidence.minimumAcceptedStepPct = 0.05; input.evidence.minimumAcceptedPrice = 1050;
  for (const key of ['priceIndex', 'customerPriceCorridor', 'conversionRisk']) input.evidence[key].evaluatedSellerPrice = 1050;
  assert.deepEqual(evaluateAutoPrice(input), {state: 'READY', allowed: true, dimension: 'PRICE', value: 1050, reasonCodes: []});
  input.evidence.priceIndex.evaluatedSellerPrice = 1020;
  assert.ok(evaluateAutoPrice(input).reasonCodes.includes('PRICE_INDEX_UNVERIFIED'));
  input.evidence.priceIndex.evaluatedSellerPrice = 1050;
  input.evidence.minimumStepVerified = false;
  assert.ok(evaluateAutoPrice(input).reasonCodes.includes('OZON_MINIMUM_STEP_UNKNOWN'));
  input.evidence.minimumStepVerified = true; input.evidence.conversionRisk.acceptable = false;
  assert.ok(evaluateAutoPrice(input).reasonCodes.includes('CONVERSION_RISK_UNVERIFIED'));
  input.evidence.conversionRisk.acceptable = true; input.evidence.minimumAcceptedPrice = 1050.01;
  assert.ok(evaluateAutoPrice(input).reasonCodes.includes('PRICE_STEP_OUT_OF_BOUNDS'));
  delete input.evidence.minimumAcceptedPrice;
  assert.ok(evaluateAutoPrice(input).reasonCodes.includes('PRICE_FALLBACK_PRICE_UNVERIFIED'));
});

test('price AUTO blocks low stock, loss, active experiment and insufficient confidence', () => {
  for (const mutate of [
    input => { input.stock.days = null; },
    input => { input.finance.contributionAfterAds = 1000; },
    input => { input.history.activeExperiment = {dimension: 'PRICE'}; },
    input => { input.decision.confidence = 'MEDIUM'; },
  ]) { const input = priceFixture(); mutate(input); assert.equal(evaluateAutoPrice(input).state, 'HOLD'); }
});

test('bid AUTO enforces 5%, profit cap, 12-hour cooldown, 30-day SKU share and assessed previous step', () => {
  assert.equal(evaluateAutoBid(bidFixture()).state, 'READY');
  const cases = [
    [input => { input.decision.recommendedBid = 10.51; }, 'BID_STEP_OUT_OF_BOUNDS'],
    [input => { input.decision.maxProfitableBid = 10; }, 'PROFITABLE_BID_CAP_UNVERIFIED'],
    [input => { input.finance.advertising = 15001; }, 'SKU_30D_AD_SHARE_UNVERIFIED'],
    [input => { input.finance.contributionAfterAds = 9999; }, 'PROFIT_FLOOR_UNVERIFIED'],
    [input => { input.spendGuard.enforced = false; }, 'SPEND_LIMIT_NOT_ENFORCED'],
    [input => { input.history.lastBidActionAt = null; input.history.previousBidStep = null; input.history.baselineValidated = true; }, 'PREVIOUS_BID_STEP_UNEVALUATED_OR_COOLDOWN'],
    [input => { input.history.lastBidActionAt = '2026-09-24T01:00:00Z'; input.history.previousBidStep.actionAt = input.history.lastBidActionAt; }, 'PREVIOUS_BID_STEP_UNEVALUATED_OR_COOLDOWN'],
    [input => { input.history.previousBidStep.clicks = 99; }, 'PREVIOUS_BID_STEP_UNEVALUATED_OR_COOLDOWN'],
    [input => { input.history.previousBidStep.orders = 9; }, 'PREVIOUS_BID_STEP_UNEVALUATED_OR_COOLDOWN'],
    [input => { input.history.previousBidStep.profitDidNotDecline = false; }, 'PREVIOUS_BID_STEP_UNEVALUATED_OR_COOLDOWN'],
    [input => { input.history.previousBidStep.observedTo = '2026-09-24T05:00:00Z'; }, 'PREVIOUS_BID_STEP_UNEVALUATED_OR_COOLDOWN'],
    [input => { input.finance.periodTo = '2026-09-22'; }, 'SKU_30D_AD_SHARE_UNVERIFIED'],
  ];
  for (const [mutate, code] of cases) { const input = bidFixture(); mutate(input); assert.ok(evaluateAutoBid(input).reasonCodes.includes(code), code); }
});

test('a competitor bid alone never authorizes an increase', () => {
  const input = bidFixture(); input.ads.competitiveBid = 1000; input.decision.reasonCodes = ['BID_BELOW_COMPETITIVE'];
  assert.ok(evaluateAutoBid(input).reasonCodes.includes('NO_PROFIT_EVIDENCE'));
  input.decision.reasonCodes = ['PROFIT_BUFFER_AVAILABLE']; input.decision.maxProfitableBid = 10;
  assert.ok(evaluateAutoBid(input).reasonCodes.includes('PROFITABLE_BID_CAP_UNVERIFIED'));
});
