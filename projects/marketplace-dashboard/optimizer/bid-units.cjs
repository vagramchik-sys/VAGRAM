'use strict';

const MICRO_RUB = 'MICRO_RUB_PER_CLICK';
const RUB = 'RUB_PER_CLICK';

// Explicit source units prevent already-normalized recommendations/caps from
// being divided a second time. Raw Ozon values stay in separate storage fields.
function bidToRubles(value, unit) {
  if (value === null || value === undefined || value === '' ||
      !['number', 'string'].includes(typeof value) ||
      !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(String(value))) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) return null;
  if (unit === RUB) return amount;
  if (unit === MICRO_RUB) return amount / 1_000_000;
  return null;
}

function storedBidToRubles(value, unit, raw) {
  return value !== null && value !== undefined
    ? bidToRubles(value, unit)
    : bidToRubles(raw, MICRO_RUB);
}

module.exports = {bidToRubles, storedBidToRubles, MICRO_RUB, RUB};
