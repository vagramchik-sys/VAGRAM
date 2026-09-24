'use strict';

// Inputs are normalized RUB amounts. Expenses are signed net charges: a
// refund/reversal can be negative. This module never guesses missing charges.
const BEFORE_FIELDS = Object.freeze([
  'realizedRevenue', 'cost', 'commission', 'logistics', 'acquiring',
  'marketplaceServices', 'compensation',
]);

function amount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function safe(value) {
  return amount(value) ? (Object.is(value, -0) ? 0 : value) : null;
}

function calculateContributionEconomics(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  const missingFields = BEFORE_FIELDS.filter(field => !amount(input[field]));
  const before = missingFields.length ? null : safe(
    input.realizedRevenue - input.cost - input.commission - input.logistics
    - input.acquiring - input.marketplaceServices + input.compensation,
  );
  if (!missingFields.length && before === null) missingFields.push('calculation');
  if (!amount(input.advertising)) missingFields.push('advertising');
  const validOrders = Number.isSafeInteger(input.orders) && input.orders >= 0;
  if (!validOrders) missingFields.push('orders');
  if (input.complete !== true) missingFields.push('complete');
  const after = before !== null && amount(input.advertising)
    ? safe(before - input.advertising) : null;
  if (before !== null && amount(input.advertising) && after === null) missingFields.push('calculation');
  const divide = value => value !== null && validOrders && input.orders > 0
    ? safe(value / input.orders) : null;
  const marginPct = after !== null && amount(input.realizedRevenue) && input.realizedRevenue > 0
    ? safe(after / input.realizedRevenue * 100) : null;
  if (after !== null && input.realizedRevenue > 0 && marginPct === null) missingFields.push('calculation');
  return {
    contributionBeforeAds: before,
    contributionAfterAds: after,
    contributionBeforeAdsPerOrder: divide(before),
    contributionPerOrder: divide(after),
    marginPct,
    economicsStatus: before === null ? 'insufficient' : missingFields.length ? 'partial' : 'complete',
    missingFields: [...new Set(missingFields)],
  };
}

function calculateMaxAdSpendPerOrder(input = {}) {
  const { contributionBeforeAdsPerOrder, targetProfitPerOrder } = input || {};
  if (!amount(contributionBeforeAdsPerOrder) || !amount(targetProfitPerOrder) || targetProfitPerOrder < 0) return null;
  return safe(Math.max(0, contributionBeforeAdsPerOrder - targetProfitPerOrder));
}

function calculateMaxCpc(input = {}) {
  const { maxAdSpendPerOrder, observedCVR, safetyFactor } = input || {};
  if (!amount(maxAdSpendPerOrder) || maxAdSpendPerOrder < 0
    || !amount(observedCVR) || observedCVR < 0 || observedCVR > 1
    || !amount(safetyFactor) || safetyFactor < 0 || safetyFactor > 1) return null;
  return safe(maxAdSpendPerOrder * observedCVR * safetyFactor);
}

module.exports = {
  calculateContributionEconomics,
  calculateMaxAdSpendPerOrder,
  calculateMaxCpc,
};
