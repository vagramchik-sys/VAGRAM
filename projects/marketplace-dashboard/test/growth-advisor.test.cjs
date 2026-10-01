'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {adviseProduct, calculateCommercialPlan, adviseGrowthDecision} = require('../optimizer/growth-advisor.cjs');
const NOW = '2026-10-01T12:00:00Z';
function item() {
  return {product: {id: '1', storeId: '2'}, price: {sellerPrice: 1000, currency: 'RUB', observedAt: NOW},
    cost: {unitCost: 400, status: 'filled', currency: 'RUB', observedAt: NOW},
    stock: {quantity: 500, days: 30, observedAt: NOW}, advertising: {spend: 999999, orders: 99999, cvrPct: 95},
    economics: {economicsStatus: 'complete', contributionBeforeAds: 30000, contributionAfterAds: 20000,
      contributionBeforeAdsPerOrder: 300, contributionPerOrder: 200},
    optimizer: {state: 'BLOCKED', action: 'NONE', blockers: ['ATTRIBUTION_MISMATCH']},
    analysisBasis: {financeComplete: true, financeObservedAt: NOW, periodFrom: '2026-09-01', periodTo: '2026-09-30',
      units: 100, realizedRevenue: 100000, commission: 20000, acquiring: 2000, advertising: 10000,
      logistics: 3000, marketplaceServices: 1000, compensation: 1000, orderBasis: 'unit', scope: 'seller_sku'}};
}
function market() {
  return {source: 'manual', comparable: true, observedAt: NOW, region: 'Москва', query: 'товар', ownBuyerPrice: 100, ownUnitCount: 2, ownPosition: 7,
    competitors: [{id: 'a', name: 'Аналог', url: 'https://example.com/a', buyerPrice: 60, unitCount: 1, position: 4}]};
}
const run = (value = item(), options = {}) => adviseProduct(value, {now: NOW, ...options});
const scenario = (value, id) => value.scenarios.find(row => row.id === id);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('price scenarios use realized-unit contribution and expose volume thresholds without overriding optimizer', () => {
  const value = item(), before = structuredClone(value), result = run(value);
  const up = scenario(result, 'price_up'), down = scenario(result, 'price_down');
  assert.equal(result.status, 'review');
  assert.equal(up.status, 'conditional');
  near(up.metrics[0].value, 1020);
  near(up.metrics[1].value, 215.6);
  near(up.metrics[2].value, (1 - 200 / 215.6) * 100);
  near(down.metrics[0].value, 980);
  near(down.metrics[1].value, 184.4);
  near(down.metrics[2].value, (200 / 184.4 - 1) * 100);
  assert.ok(up.assumptions.some(text => text.includes('не прогноз')));
  assert.deepEqual(result.coverage.optimizerBlockers, ['ATTRIBUTION_MISMATCH']);
  assert.equal(result.coverage.automaticChanges, false);
  assert.deepEqual(value, before);
});

test('ad scenario uses ledger spend once and does not use Performance CVR or attributed orders', () => {
  const value = item(), result = scenario(run(value), 'ad_up');
  near(result.metrics[0].value, 500);
  near(result.metrics[1].value, 500 / 300);
  value.advertising = {spend: 1, orders: 0, cvrPct: null};
  assert.deepEqual(scenario(run(value), 'ad_up'), result);
});

test('missing, string, nonfinite and negative fees are distinct from confirmed zero', () => {
  for (const field of ['commission', 'acquiring', 'advertising']) for (const invalid of [undefined, null, '0', NaN, Infinity, -1]) {
    const value = item(); value.analysisBasis[field] = invalid;
    const result = run(value);
    assert.equal(result.status, 'data_needed', `${field}: ${String(invalid)}`);
    assert.equal(scenario(result, 'price_up').status, 'unavailable');
    assert.equal(scenario(result, 'ad_up').status, 'unavailable');
  }
  const value = item(); value.analysisBasis.commission = 0; value.analysisBasis.acquiring = 0;
  near(scenario(run(value), 'price_up').metrics[1].value, 220);
});

test('zero advertising does not invent a pilot budget', () => {
  const value = item(); value.analysisBasis.advertising = 0;
  value.economics.contributionAfterAds = 30000; value.economics.contributionPerOrder = 300;
  const result = run(value);
  assert.equal(scenario(result, 'price_up').status, 'conditional');
  assert.equal(scenario(result, 'ad_up').status, 'unavailable');
  assert.match(scenario(result, 'ad_up').summary, /равны нулю/u);
});

test('stale and future finance or price observations disable actionable arithmetic', () => {
  for (const timestamp of ['2026-09-30T11:59:59Z', '2026-10-01T12:00:01Z', null, 'invalid']) {
    for (const source of ['finance', 'price']) {
      const value = item();
      if (source === 'finance') value.analysisBasis.financeObservedAt = timestamp;
      else value.price.observedAt = timestamp;
      const result = run(value);
      assert.equal(result.status, 'data_needed');
      assert.equal(scenario(result, 'price_up').status, 'unavailable');
      assert.equal(scenario(result, 'ad_up').status, 'unavailable');
    }
  }
  const value = item(); value.analysisBasis.financeObservedAt = '2026-09-30T12:00:00Z';
  assert.equal(scenario(run(value), 'price_up').status, 'conditional');
});

test('incomplete, unclosed or invalid financial periods cannot produce scenarios', () => {
  for (const changes of [{financeComplete: false}, {periodTo: '2026-10-01'}, {periodTo: '2026-09-31'},
    {periodFrom: '2026-10-01'}, {scope: 'campaign_sku'}, {orderBasis: 'attributed_order'}, {units: 0}, {units: null}]) {
    const value = item(); Object.assign(value.analysisBasis, changes);
    const result = run(value);
    assert.equal(result.status, 'data_needed');
    assert.equal(scenario(result, 'price_down').status, 'unavailable');
    if (changes.units === 0) assert.ok(result.missingEvidence.some(row => row.code === 'NO_REALIZED_UNITS'));
  }
});

test('fee ratios at or above 100 percent and inconsistent contributions disable scenarios', () => {
  for (const commission of [98000, 100000, Number.MAX_SAFE_INTEGER]) {
    const value = item(); value.analysisBasis.commission = commission;
    assert.ok(run(value).missingEvidence.some(row => row.code === 'FEES_RATIO_UNUSABLE'));
    assert.equal(scenario(run(value), 'price_up').status, 'unavailable');
  }
  const value = item(); value.economics.contributionAfterAds = 21000;
  assert.ok(run(value).missingEvidence.some(row => row.code === 'CONTRIBUTION_INCONSISTENT'));
});

test('nonpositive contribution is a review priority and cannot justify expansion', () => {
  for (const after of [-1000, 0]) {
    const value = item();
    Object.assign(value.economics, {contributionAfterAds: after, contributionPerOrder: after / 100,
      contributionBeforeAds: after + 10000, contributionBeforeAdsPerOrder: (after + 10000) / 100});
    const result = run(value);
    assert.equal(result.status, 'review');
    assert.equal(result.priority, 100);
    assert.equal(scenario(result, 'ad_up').status, 'unavailable');
    assert.equal(scenario(result, 'price_down').status, 'unavailable');
  }
});

test('price cut that destroys positive contribution has no finite volume target', () => {
  const value = item(); Object.assign(value.economics, {contributionAfterAds: 1000, contributionPerOrder: 10,
    contributionBeforeAds: 11000, contributionBeforeAdsPerOrder: 110});
  const result = run(value);
  assert.equal(scenario(result, 'price_up').status, 'conditional');
  assert.equal(scenario(result, 'price_down').status, 'unavailable');
});

test('market comparison normalizes buyer prices per unit and never compares seller price', () => {
  const evidence = market(), value = item(), result = run(value, {marketEvidence: evidence});
  assert.equal(result.coverage.market.ownPricePerUnit, 50);
  assert.equal(result.coverage.market.competitorMinPricePerUnit, 60);
  assert.equal(result.coverage.market.completeMarketCoverage, false);
  assert.ok(result.signals.some(row => row.text.includes('ниже диапазона')));
  assert.ok(result.signals.some(row => row.text.includes('Позиция 7')));
  value.price.sellerPrice = 1;
  assert.deepEqual(run(value, {marketEvidence: evidence}).coverage.market, result.coverage.market);
  evidence.ownUnitCount = 1;
  assert.ok(run(value, {marketEvidence: evidence}).signals.some(row => row.text.includes('выше диапазона')));
});

test('stale, future, missing units and seller-only market observations remain unavailable', () => {
  const evidence = market();
  for (const changes of [{observedAt: '2026-09-29T12:00:00Z'}, {observedAt: '2026-10-02T12:00:00Z'},
    {ownUnitCount: null}, {ownBuyerPrice: null, sellerPrice: 100}, {region: ''}, {source: 'unknown'}, {comparable: false}, {comparable: undefined}]) {
    const result = run(item(), {marketEvidence: {...evidence, ...changes}});
    assert.equal(result.coverage.market.available, false);
    assert.ok(result.missingEvidence.some(row => row.code === 'MARKET_OBSERVATION_NEEDED'));
  }
  evidence.competitors[0].unitCount = 0;
  assert.equal(run(item(), {marketEvidence: evidence}).coverage.market.available, false);
});

test('low stock holds demand expansion while unknown stock cannot become zero or a candidate', () => {
  const value = item(); value.stock.quantity = 1;
  assert.equal(run(value).status, 'hold');
  value.stock.quantity = null;
  assert.equal(run(value).status, 'review');
  assert.ok(run(value).missingEvidence.some(row => row.code === 'STOCK_UNVERIFIED'));
});

test('candidate status still requires the existing optimizer and verified supporting observations', () => {
  const value = item();
  assert.equal(run(value, {marketEvidence: market()}).status, 'review');
  value.optimizer = {state: 'PRICE_UP', action: 'PRICE', blockers: []};
  assert.equal(run(value, {marketEvidence: market()}).status, 'test_candidate');
  assert.equal(run(value).status, 'review');
  assert.equal(run(value, {priceStepPct: 0.06}).status, 'data_needed');
});

test('sales and position objectives keep conditional arithmetic and disclose missing effect evidence', () => {
  for (const objective of ['sales', 'position']) {
    const result = run(item(), {objective});
    assert.equal(scenario(result, 'price_up').status, 'conditional');
    assert.equal(result.status, 'review');
    assert.ok(!result.missingEvidence.some(row => row.code === 'INVALID_SCENARIO_SETTINGS'));
    assert.ok(result.missingEvidence.some(row => row.code === (objective === 'sales' ? 'SALES_EFFECT_UNVERIFIED' : 'POSITION_EFFECT_UNVERIFIED')));
    assert.match(result.nextStep, objective === 'sales' ? /критерий роста/u : /ряд наблюдений/u);
  }
  assert.equal(run(item(), {objective: 'unknown'}).status, 'data_needed');
});

test('unverified, stale and mismatched cost status block advisory scenarios', () => {
  for (const changes of [{status: 'missing'}, {status: 'partial'}, {status: 'invalid'}, {status: 'zero'},
    {unitCost: 0}, {unitCost: null}, {unitCost: '400'}, {unitCost: -1}, {currency: 'USD'},
    {observedAt: '2026-09-29T12:00:00Z'}, {observedAt: '2026-10-01T12:00:01Z'}]) {
    const value = item(); Object.assign(value.cost, changes);
    const result = run(value);
    assert.equal(result.status, 'data_needed');
    assert.ok(result.missingEvidence.some(row => row.code === 'COST_UNVERIFIED'));
    assert.equal(scenario(result, 'price_up').status, 'unavailable');
    assert.equal(scenario(result, 'ad_up').status, 'unavailable');
  }
  const value = item(); delete value.cost;
  assert.equal(run(value).status, 'data_needed');
  value.cost = {unitCost: 0, status: 'zero', currency: 'RUB', observedAt: NOW};
  assert.equal(scenario(run(value), 'price_up').status, 'conditional');
});

const terms = () => ({commissionPct: 26, advertisingPct: 14, priceBasis: 'seller_price', application: 'planning_reserve'});
const plan = (value = item(), overrides = {}) => calculateCommercialPlan(value, {...terms(), ...overrides}, {now: NOW});

test('commercial plan reserves terms once, preserves source facts and computes conditional break-even thresholds', () => {
  const value = item(), before = structuredClone(value), result = plan(value);
  assert.equal(result.status, 'complete');
  assert.equal(result.retainedRevenue, 600);
  assert.equal(result.unitCost, 400);
  assert.equal(result.otherCostsPerUnit, 50);
  assert.equal(result.contributionPerUnit, 150);
  assert.equal(result.minPrice, 750);
  near(scenario(result, 'price_up').metrics[1].value, 162);
  near(scenario(result, 'price_up').metrics[2].value, (1 - 150 / 162) * 100);
  near(scenario(result, 'price_down').metrics[1].value, 138);
  near(scenario(result, 'price_down').metrics[2].value, (150 / 138 - 1) * 100);
  assert.equal(scenario(result, 'ad_up').status, 'unavailable');
  value.analysisBasis.commission = 999999;
  value.analysisBasis.advertising = 999999;
  value.advertising.spend = 9999999;
  assert.deepEqual(plan(value), result);
  assert.deepEqual(before, item());
});

test('commercial planning rates are generic and zero is a valid confirmed rate', () => {
  assert.equal(plan(item(), {commissionPct: 10, advertisingPct: 5}).contributionPerUnit, 400);
  assert.equal(plan(item(), {commissionPct: 0, advertisingPct: 0}).contributionPerUnit, 550);
  for (const overrides of [{commissionPct: null}, {advertisingPct: '14'}, {commissionPct: -1},
    {advertisingPct: Infinity}, {commissionPct: 86}, {priceBasis: 'buyer_price'}, {application: 'actual'}]) {
    const result = plan(item(), overrides);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.contributionPerUnit, null);
    assert.equal(result.minPrice, null);
  }
});

test('missing or unverified other costs yield a partial plan without invented profit', () => {
  for (const changes of [{logistics: null}, {acquiring: undefined}, {marketplaceServices: '1000'}, {compensation: NaN},
    {financeComplete: false}, {financeObservedAt: '2026-09-29T12:00:00Z'}, {financeObservedAt: '2026-10-02T12:00:00Z'},
    {periodTo: '2026-10-01'}, {periodTo: '2026-09-31'}, {units: 0}, {units: null}, {scope: 'campaign_sku'}, {orderBasis: 'order'}]) {
    const value = item(); Object.assign(value.analysisBasis, changes);
    const result = plan(value);
    assert.equal(result.status, 'partial');
    assert.equal(result.retainedRevenue, 600);
    assert.equal(result.unitCost, 400);
    assert.equal(result.otherCostsPerUnit, null);
    assert.equal(result.contributionPerUnit, null);
    assert.equal(result.minPrice, null);
    assert.ok(result.scenarios.every(row => row.status === 'unavailable'));
  }
});

test('commercial plan distinguishes confirmed zero cost from invalid cost and stale price', () => {
  const value = item(); value.cost.unitCost = 0; value.cost.status = 'zero';
  assert.equal(plan(value).contributionPerUnit, 550);
  for (const changes of [{status: 'filled'}, {currency: 'USD'}, {observedAt: '2026-10-02T12:00:00Z'}, {observedAt: null}]) {
    const changed = structuredClone(value); Object.assign(changed.cost, changes);
    assert.equal(plan(changed).status, 'unavailable');
    assert.equal(plan(changed).contributionPerUnit, null);
  }
  value.price.observedAt = '2026-09-29T12:00:00Z';
  assert.equal(plan(value).status, 'unavailable');
  assert.equal(plan(value).retainedRevenue, null);
});

test('negative planned contribution remains visible without invalid volume promises', () => {
  const value = item(); value.cost.unitCost = 700;
  const result = plan(value);
  assert.equal(result.status, 'complete');
  assert.equal(result.contributionPerUnit, -150);
  assert.equal(result.minPrice, 1250);
  assert.equal(scenario(result, 'price_up').metrics.length, 2);
  assert.equal(scenario(result, 'price_down').metrics.length, 2);
  assert.match(scenario(result, 'price_up').summary, /не определён/u);
});

const decision = (value = item(), options = {}) => adviseGrowthDecision(value, {now: NOW, terms: terms(), marketEvidence: market(), ...options});
test('unified decision uses configured reserves once and does not substitute actual ads or commission', () => {
  const value = item(), before = structuredClone(value), result = decision(value);
  assert.equal(result.direction, 'price_up'); assert.equal(result.status, 'review');
  assert.equal(result.calculation.contributionPerUnit, 150); assert.equal(result.suggestedPrice, 1020);
  assert.equal(scenario(result, 'price_up').metrics[1].value, 162);
  assert.deepEqual(value, before);
  value.analysisBasis.commission = 999999; value.analysisBasis.advertising = 999999; value.advertising.spend = 999999;
  assert.deepEqual(decision(value), result);
  assert.equal(decision(value, {terms: {...terms(), commissionPct: 10, advertisingPct: 5}}).calculation.contributionPerUnit, 400);
  assert.equal(result.coverage.automaticChanges, false);
});

test('above-market buyer price proposes conditional cut with correct volume threshold, never guaranteed growth', () => {
  const value = item(), evidence = market(); evidence.ownUnitCount = 1;
  value.optimizer.blockers = [];
  const result = decision(value, {marketEvidence: evidence});
  assert.equal(result.status, 'test_candidate'); assert.equal(result.direction, 'price_down'); assert.equal(result.suggestedPrice, 980);
  near(scenario(result, 'price_down').metrics[2].value, (150 / 138 - 1) * 100);
  assert.match(result.nextStep, /перенос изменения цены продавца/u);
  assert.equal(result.coverage.market.ownPricePerUnit, 100); assert.equal(result.coverage.market.competitorMaxPricePerUnit, 60);
  evidence.ownBuyerPrice = 60;
  assert.equal(decision(value, {marketEvidence: evidence}).suggestedPrice, null);
});

test('partial plans preserve useful known arithmetic without inventing final profit or expansion', () => {
  const value = item(); value.analysisBasis.financeComplete = false;
  let result = decision(value);
  assert.equal(result.status, 'data_needed'); assert.equal(result.direction, 'hold');
  assert.equal(result.calculation.remainderBeforeOtherCosts, 200); assert.equal(result.calculation.contributionPerUnit, null);
  assert.match(result.summary, /не является прибылью/u); assert.match(result.nextStep, /логистику, эквайринг/u);
  for (const cost of [600, 700]) {
    value.cost.unitCost = cost; result = decision(value);
    assert.equal(result.status, 'hold'); assert.equal(result.priority, 100); assert.equal(result.suggestedPrice, null);
    assert.equal(result.calculation.remainderBeforeOtherCosts, 600 - cost);
    assert.match(result.summary, /до прочих расходов/u); assert.match(result.summary, /Итоговый вклад неизвестен/u);
  }
});

test('complete loss, insufficient stock, stale price and unavailable market preserve fences', () => {
  const value = item(); value.optimizer.blockers = [];
  value.cost.unitCost = 700; assert.equal(decision(value).status, 'hold'); assert.equal(decision(value).suggestedPrice, null);
  value.cost.unitCost = 400; value.stock.quantity = 1; assert.equal(decision(value).status, 'hold');
  value.stock.quantity = 500; value.stock.days = null; assert.equal(decision(value).status, 'review');
  value.stock.days = 30; value.price.observedAt = '2026-09-29T12:00:00Z'; assert.equal(decision(value).status, 'data_needed');
  value.price.observedAt = NOW;
  const missingMarket = decision(value, {marketEvidence: null});
  assert.equal(missingMarket.direction, 'hold'); assert.equal(missingMarket.suggestedPrice, null);
  for (const objective of ['sales', 'position']) assert.equal(decision(value, {objective}).status, 'review');
});

test('conditional cut that eliminates positive reserve contribution is held', () => {
  const value = item(), evidence = market(); evidence.ownUnitCount = 1; value.cost.unitCost = 545;
  const result = decision(value, {marketEvidence: evidence});
  assert.equal(result.calculation.contributionPerUnit, 5); assert.equal(result.direction, 'hold'); assert.equal(result.status, 'hold'); assert.equal(result.suggestedPrice, null);
});

test('rounded executable price and volume arithmetic describe the same cents', () => {
  const value = item(); value.price.sellerPrice = 1000.01;
  const result = decision(value), up = scenario(result, 'price_up');
  assert.equal(result.suggestedPrice, 1020.01); assert.equal(up.metrics[0].value, result.suggestedPrice);
  near(up.metrics[1].value, result.suggestedPrice * .6 - 450);
  near(up.metrics[2].value, (1 - result.calculation.contributionPerUnit / up.metrics[1].value) * 100);
});

function withAdPilot() {
  const value = item(); value.optimizer.blockers = [];
  value.advertising = {connected: true, complete: true, model: 'CPC', skuLinkStatus: 'matched', attributionModel: 'ozon_performance', orderBasis: 'attributed_order', scope: 'seller_sku',
    observedAt: NOW, periodFrom: '2026-09-24', periodTo: '2026-09-30', impressions: 1000, clicks: 40, orders: 4,
    previousPeriod: {complete: true, observedAt: NOW, scope: 'seller_sku', attributionModel: 'ozon_performance', periodFrom: '2026-09-17', periodTo: '2026-09-23', impressions: 2000, clicks: 80, orders: 8},
    pilotBasis: {confirmed: true, observedAt: NOW, days: 7, maxAdditionalSpendRub: 1000, stopLossRub: 500, incrementalSalesMeasurement: true}};
  return value;
}
const within = () => ({...market(), ownBuyerPrice: 120});
test('ad pilot requires comparable declining traffic, observed conversion and explicit bounded pilot evidence', () => {
  const value = withAdPilot(), result = decision(value, {marketEvidence: within()});
  assert.equal(result.direction, 'ad_pilot'); assert.equal(result.status, 'test_candidate'); assert.equal(result.suggestedPrice, null);
  assert.equal(result.coverage.trafficDeclined, true); assert.equal(result.calculation.contributionPerUnit, 150);
  assert.match(result.summary, /не гарантирует/u); assert.equal(scenario(result, 'ad_up').status, 'conditional');
  assert.deepEqual(scenario(result, 'ad_up').metrics.map(row => row.value), [1000, 7, 500]);
  for (const mutate of [v => { delete v.advertising.pilotBasis; }, v => { delete v.advertising.previousPeriod; }, v => { v.advertising.orders = 0; },
    v => { v.advertising.observedAt = '2026-09-01T12:00:00Z'; }, v => { v.advertising.previousPeriod.periodTo = '2026-09-30'; },
    v => { v.advertising.previousPeriod.clicks = 20; }, v => { v.advertising.clicks = 2000; }, v => { v.advertising.pilotBasis.incrementalSalesMeasurement = false; }]) {
    const changed = withAdPilot(); mutate(changed);
    assert.equal(decision(changed, {marketEvidence: within()}).direction, 'hold');
  }
});

test('existing aggregate data cannot invent a budget or call one traffic sample low', () => {
  const value = item(), result = decision(value, {marketEvidence: within()});
  assert.equal(result.direction, 'hold'); assert.equal(result.coverage.trafficDeclined, false);
  for (const code of ['AD_FUNNEL_UNVERIFIED', 'TRAFFIC_BASELINE_NEEDED', 'AD_PILOT_BASIS_NEEDED']) assert.ok(result.missingEvidence.some(row => row.code === code));
  assert.equal(scenario(result, 'ad_up').status, 'unavailable');
});
