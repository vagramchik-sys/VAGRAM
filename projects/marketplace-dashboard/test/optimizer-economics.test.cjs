'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateContributionEconomics: economics, calculateMaxAdSpendPerOrder: maxSpend,
  calculateMaxCpc: maxCpc } = require('../optimizer/economics.cjs');

function finance(overrides = {}) {
  return { realizedRevenue: 20000, cost: 8000, commission: 2000, logistics: 1000,
    acquiring: 200, marketplaceServices: 300, compensation: 100,
    advertising: 2000, orders: 100, complete: true, ...overrides };
}

test('contribution includes every charge and compensation exactly once in RUB', () => {
  assert.deepEqual(economics(finance()), {
    contributionBeforeAds: 8600, contributionAfterAds: 6600,
    contributionBeforeAdsPerOrder: 86, contributionPerOrder: 66,
    marginPct: 33, economicsStatus: 'complete', missingFields: [],
  });
});

test('unknown and invalid charges never become zero or a complete profit', () => {
  for (const field of ['realizedRevenue', 'cost', 'commission', 'logistics', 'acquiring', 'marketplaceServices', 'compensation']) {
    for (const value of [undefined, null, '0', NaN, Infinity, -Infinity, 1e20]) {
      const result = economics(finance({ [field]: value }));
      assert.equal(result.economicsStatus, 'insufficient', `${field} ${String(value)}`);
      assert.equal(result.contributionBeforeAds, null);
      assert.equal(result.contributionAfterAds, null);
      assert.ok(result.missingFields.includes(field));
    }
  }
});

test('missing advertising preserves before-ads profit but never claims after-ads profit', () => {
  for (const advertising of [null, undefined, '0', NaN]) {
    const result = economics(finance({ advertising }));
    assert.equal(result.contributionBeforeAds, 8600);
    assert.equal(result.contributionBeforeAdsPerOrder, 86);
    assert.equal(result.contributionAfterAds, null);
    assert.equal(result.contributionPerOrder, null);
    assert.equal(result.marginPct, null);
    assert.equal(result.economicsStatus, 'partial');
  }
});

test('confirmed zero components and zero-sale periods are distinct from missing data', () => {
  const input = finance(Object.fromEntries(Object.keys(finance()).filter(key => key !== 'complete').map(key => [key, 0])));
  const result = economics(input);
  assert.equal(result.economicsStatus, 'complete');
  assert.equal(result.contributionBeforeAds, 0);
  assert.equal(result.contributionAfterAds, 0);
  assert.equal(result.contributionPerOrder, null);
  assert.equal(result.contributionBeforeAdsPerOrder, null);
  assert.equal(result.marginPct, null);
  assert.equal(economics(finance({ advertising: 0 })).contributionAfterAds, 8600);
});

test('signed returns and fee reversals retain their accounting meaning', () => {
  const result = economics(finance({ realizedRevenue: -1000, cost: -400, commission: -150,
    logistics: 100, acquiring: -10, marketplaceServices: 20, compensation: 50,
    advertising: -30, orders: 2 }));
  assert.equal(result.contributionBeforeAds, -510);
  assert.equal(result.contributionAfterAds, -480);
  assert.equal(result.contributionPerOrder, -240);
  assert.equal(result.marginPct, null);
  assert.equal(result.economicsStatus, 'complete');
});

test('incomplete periods preserve known figures but never become complete', () => {
  for (const complete of [false, undefined, null, 'true', 1]) {
    const result = economics(finance({ complete }));
    assert.equal(result.contributionAfterAds, 6600);
    assert.equal(result.economicsStatus, 'partial');
    assert.ok(result.missingFields.includes('complete'));
  }
});

test('invalid order denominators cannot create per-order profit', () => {
  for (const orders of [null, undefined, '100', -1, 0.5, NaN, Infinity, 1e20]) {
    const result = economics(finance({ orders }));
    assert.equal(result.contributionPerOrder, null);
    assert.equal(result.contributionBeforeAdsPerOrder, null);
    assert.equal(result.economicsStatus, 'partial');
  }
});

test('unsafe arithmetic is unavailable rather than Infinity or an unsafe recommendation', () => {
  const result = economics(finance({ realizedRevenue: Number.MAX_SAFE_INTEGER, cost: -Number.MAX_SAFE_INTEGER }));
  assert.equal(result.contributionBeforeAds, null);
  assert.equal(result.economicsStatus, 'insufficient');
  assert.ok(result.missingFields.includes('calculation'));
  assert.equal(economics(null).economicsStatus, 'insufficient');
});

test('ad allowance uses contribution per order, never the entire period', () => {
  const e = economics(finance());
  const allowance = maxSpend({ contributionBeforeAdsPerOrder: e.contributionBeforeAdsPerOrder, targetProfitPerOrder: 40 });
  assert.equal(allowance, 46);
  assert.ok(Math.abs(maxCpc({ maxAdSpendPerOrder: allowance, observedCVR: 0.1, safetyFactor: 0.8 }) - 3.68) < 1e-12);
  assert.equal(maxSpend({ contributionBeforeAdsPerOrder: 30, targetProfitPerOrder: 40 }), 0);
  assert.equal(maxSpend({ contributionBeforeAdsPerOrder: -30, targetProfitPerOrder: 0 }), 0);
});

test('profit floor and CVR/safety inputs are mandatory, finite and bounded', () => {
  for (const targetProfitPerOrder of [null, undefined, -1, '40', Infinity]) {
    assert.equal(maxSpend({ contributionBeforeAdsPerOrder: 100, targetProfitPerOrder }), null);
  }
  for (const contributionBeforeAdsPerOrder of [null, undefined, '100', NaN, 1e20]) {
    assert.equal(maxSpend({ contributionBeforeAdsPerOrder, targetProfitPerOrder: 0 }), null);
  }
  for (const observedCVR of [null, undefined, '0.1', -0.1, 1.1, NaN, Infinity]) {
    assert.equal(maxCpc({ maxAdSpendPerOrder: 100, observedCVR, safetyFactor: 0.8 }), null);
  }
  for (const safetyFactor of [null, undefined, '0.8', -0.1, 1.1, Infinity]) {
    assert.equal(maxCpc({ maxAdSpendPerOrder: 100, observedCVR: 0.1, safetyFactor }), null);
  }
  assert.equal(maxCpc({ maxAdSpendPerOrder: 100, observedCVR: 0, safetyFactor: 0.8 }), 0);
  assert.equal(maxCpc({ maxAdSpendPerOrder: 100, observedCVR: 0.1, safetyFactor: 0 }), 0);
  assert.equal(maxCpc({ maxAdSpendPerOrder: 100, observedCVR: 0.1, safetyFactor: 1 }), 10);
  assert.equal(maxSpend(null), null);
  assert.equal(maxCpc(null), null);
});
