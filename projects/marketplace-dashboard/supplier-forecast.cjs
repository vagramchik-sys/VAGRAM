'use strict';

const DAY = 86400000;
const MOSCOW_OFFSET = 3 * 60 * 60 * 1000;
const CAVEAT = 'Ориентир по чистой реализации за завершённые дни, а не по заказам. Возвраты вычтены; сезонность, срок поставки и товар в пути не учтены. Отсутствие продаж из-за нулевого остатка может занижать потребность.';
const REASONS = {
  unsupported_market: 'Нет подтверждённой истории реализации по SKU для этой площадки.',
  incomplete_history: 'Нет полной истории за последние завершённые дни.',
  stale_history: 'История не обновлена после окончания расчётного периода.',
  invalid_history: 'Количественные данные истории некорректны или неоднозначны.',
  unknown_units: 'В истории есть реализация с неизвестным количеством единиц.',
  unmapped_units: 'Часть реализации магазина не привязана к SKU.',
  ambiguous_sku: 'Один SKU связан с несколькими товарами магазина.',
  insufficient_history: 'Нет подтверждённых наблюдений реализации этого товара за период.',
  unknown_stock: 'Текущий остаток неизвестен; потребность рассчитать нельзя.'
};

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validCount(value) { return Number.isSafeInteger(value) && value >= 0; }
function skuOf(value) { return value === undefined || value === null ? '' : String(value).trim(); }
function aliases(product) { return new Set([product.sku, ...(product.skus || [])].map(skuOf).filter(Boolean)); }
function counts(values) {
  if (!values || typeof values !== 'object') return null;
  const result = {};
  for (const name of ['soldUnits', 'returnedUnits', 'unknownUnitRows', 'salesRows']) {
    const value = values[name] === undefined ? 0 : values[name];
    if (!validCount(value)) return null;
    result[name] = value;
  }
  // A v3 sales row must contain either exact units or an explicit unknown marker.
  if (result.salesRows > 0 && result.soldUnits + result.returnedUnits + result.unknownUnitRows === 0) return null;
  return result;
}
function addCounts(total, row) {
  for (const key of Object.keys(total)) {
    total[key] += row[key];
    if (!Number.isSafeInteger(total[key])) return false;
  }
  return true;
}
const emptyCounts = () => ({ soldUnits: 0, returnedUnits: 0, unknownUnitRows: 0, salesRows: 0 });

/** Read-only baseline. Complete ledger periods are authoritative; sparse absent days are zero activity. */
function buildForecasts(stores, { now = new Date(), horizonDays = 45, historyDays = 28 } = {}) {
  if (!Array.isArray(stores)) throw new TypeError('stores must be an array');
  for (const [name, value] of Object.entries({ horizonDays, historyDays })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 366) throw new RangeError(name + ' must be an integer from 1 to 366');
  }
  const instant = now instanceof Date ? now.getTime() : typeof now === 'string' || typeof now === 'number' ? new Date(now).getTime() : NaN;
  if (!Number.isFinite(instant)) throw new TypeError('now must be a valid date');
  const today = new Date(instant + MOSCOW_OFFSET).toISOString().slice(0, 10);
  const dayStart = Date.parse(today);
  const historyStart = new Date(dayStart - historyDays * DAY).toISOString().slice(0, 10);
  const historyEnd = new Date(dayStart - DAY).toISOString().slice(0, 10);
  const coveredUntil = dayStart - MOSCOW_OFFSET;
  const within = row => row.date >= historyStart && row.date <= historyEnd;
  const result = new Map();

  for (const store of stores) {
    if (!store || !Array.isArray(store.products)) throw new TypeError('Each store must contain products');
    const catalog = new Map();
    for (const product of store.products) {
      if (!product || typeof product.key !== 'string' || !product.key || (product.skus !== undefined && !Array.isArray(product.skus))) throw new TypeError('Each product needs a key and an optional SKU array');
      if (result.has(product.key)) throw new TypeError('Duplicate product key: ' + product.key);
      const stockUnits = validCount(product.quantity) ? product.quantity : null;
      result.set(product.key, {
        label: `Ориентировочный прогноз потребности на ${horizonDays} дней`,
        horizonDays, historyDays, historyStart, historyEnd, status: 'unavailable', reason: null, reasonCode: null,
        stockUnits, averageDailyUnits: null, projectedUnits: null, requiredUnits: null, daysOfStock: null,
        caveat: CAVEAT
      });
      for (const sku of aliases(product)) {
        if (!catalog.has(sku)) catalog.set(sku, new Set());
        catalog.get(sku).add(product.key);
      }
    }
    const ledger = store.ledger;
    let problem = null;
    if (ledger?.version !== 3 || ledger.complete !== true || ledger.foreignRecords || !validDate(ledger.period?.from) || !validDate(ledger.period?.to) || ledger.period.from > historyStart || ledger.period.to < historyEnd || !Array.isArray(ledger.daily) || !Array.isArray(ledger.skuDaily)) problem = 'incomplete_history';
    if (!problem && (!Number.isFinite(Date.parse(ledger.completedAt)) || Date.parse(ledger.completedAt) < coveredUntil || Date.parse(ledger.completedAt) > instant)) problem = 'stale_history';
    const bySku = new Map(), dailyTotal = emptyCounts(), skuTotal = emptyCounts();
    if (!problem) {
      for (const [rows, skuRows] of [[ledger.daily, false], [ledger.skuDaily, true]]) {
        const seen = new Set();
        for (const row of rows) {
          if (!row || !validDate(row.date)) { problem = 'invalid_history'; break; }
          if (!within(row)) continue;
          const sku = skuOf(row.sku), identity = skuRows ? row.date + ':' + sku : row.date;
          const values = counts(row.values);
          if (!values || seen.has(identity) || (skuRows && !sku)) { problem = 'invalid_history'; break; }
          seen.add(identity);
          if (!addCounts(skuRows ? skuTotal : dailyTotal, values)) { problem = 'invalid_history'; break; }
          if (skuRows) {
            if (!bySku.has(sku)) bySku.set(sku, emptyCounts());
            if (!addCounts(bySku.get(sku), values)) { problem = 'invalid_history'; break; }
          }
        }
        if (problem) break;
      }
      if (!problem && Object.keys(dailyTotal).some(key => dailyTotal[key] < skuTotal[key])) problem = 'invalid_history';
      if (!problem && Object.keys(dailyTotal).some(key => dailyTotal[key] > skuTotal[key])) problem = 'unmapped_units';
    }

    for (const product of store.products) {
      const forecast = result.get(product.key), productAliases = aliases(product), total = emptyCounts();
      let reason = (product.market || store.market || 'Ozon') !== 'Ozon' ? 'unsupported_market' : problem;
      if (!reason && [...productAliases].some(sku => catalog.get(sku).size > 1)) reason = 'ambiguous_sku';
      if (!reason) {
        for (const sku of productAliases) {
          const values = bySku.get(sku);
          if (values && !addCounts(total, values)) { reason = 'invalid_history'; break; }
        }
      }
      if (!reason && total.unknownUnitRows) reason = 'unknown_units';
      if (!reason && total.salesRows === 0 && total.soldUnits === 0 && total.returnedUnits === 0) reason = 'insufficient_history';
      if (!reason && forecast.stockUnits === null) reason = 'unknown_stock';
      if (!reason) {
        const averageDailyUnits = Math.max(0, total.soldUnits - total.returnedUnits) / historyDays;
        const projectedUnits = Math.ceil(averageDailyUnits * horizonDays);
        if (!Number.isSafeInteger(projectedUnits)) reason = 'invalid_history';
        else Object.assign(forecast, { status: 'available', averageDailyUnits, projectedUnits,
          requiredUnits: Math.max(0, projectedUnits - forecast.stockUnits),
          daysOfStock: averageDailyUnits > 0 ? forecast.stockUnits / averageDailyUnits : null });
      }
      if (reason) { forecast.reasonCode = reason; forecast.reason = REASONS[reason]; }
    }
  }
  return result;
}

module.exports = { buildForecasts };
