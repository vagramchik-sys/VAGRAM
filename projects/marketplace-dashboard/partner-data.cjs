'use strict';

const DAY = 86400000, MOSCOW_OFFSET = 3 * 60 * 60 * 1000;
const SOURCE = 'Ozon: подтверждённая реализация по SKU, ledger v3';
const REASONS = {
  binding: 'Нет однозначной привязки товара к магазину и SKU.',
  unsupported: 'Нет подтверждённой истории реализации по SKU этой площадки.',
  incomplete: 'Нет полной истории за последние 28 завершённых дней.',
  stale: 'История не обновлена после окончания периода или дата обновления некорректна.',
  invalid: 'Количественные данные истории некорректны или неоднозначны.',
  unmapped: 'Часть реализации магазина не привязана к SKU.',
  unknown: 'Есть реализация товара с неизвестным количеством единиц.',
  insufficient: 'Нет подтверждённых наблюдений реализации товара за период.'
};
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const skuOf = value => typeof value === 'string' ? value.trim() : Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
const aliases = product => new Set([product.sku, ...(Array.isArray(product.skus) ? product.skus : [])].map(skuOf).filter(Boolean));
const zero = () => ({ soldUnits: 0, returnedUnits: 0, unknownUnitRows: 0, salesRows: 0 });
function counts(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  const result = zero();
  for (const key of Object.keys(result)) {
    result[key] = values[key] === undefined ? 0 : values[key];
    if (!validCount(result[key])) return null;
  }
  const units = result.soldUnits + result.returnedUnits;
  if (!Number.isSafeInteger(units) || result.unknownUnitRows > result.salesRows ||
      result.salesRows - result.unknownUnitRows > units || (units > 0 && result.salesRows === 0)) return null;
  return result;
}
function add(target, values) {
  for (const key of Object.keys(target)) {
    target[key] += values[key];
    if (!Number.isSafeInteger(target[key])) return false;
  }
  return true;
}
function readHistory(ledger, period, instant, coveredUntil) {
  const bySku = new Map();
  if (ledger?.version !== 3 || ledger.complete !== true || ledger.foreignRecords !== 0 ||
      !validDate(ledger.period?.from) || !validDate(ledger.period?.to) || ledger.period.from > period.from ||
      ledger.period.to < period.to || !Array.isArray(ledger.daily) || !Array.isArray(ledger.skuDaily)) return { reason: 'incomplete' };
  const refreshed = typeof ledger.completedAt === 'string' ? Date.parse(ledger.completedAt) : NaN;
  if (!Number.isFinite(refreshed) || refreshed < coveredUntil || refreshed > instant) return { reason: 'stale' };
  const totals = [new Map(), new Map()];
  for (const [index, rows] of [ledger.daily, ledger.skuDaily].entries()) {
    const seen = new Set();
    for (const row of rows) {
      if (!row || !validDate(row.date)) return { reason: 'invalid' };
      if (row.date < period.from || row.date > period.to) continue;
      const sku = index ? skuOf(row.sku) : '', identity = JSON.stringify([row.date, sku]);
      const values = counts(row.values);
      if (!values || seen.has(identity) || (index && !sku)) return { reason: 'invalid' };
      seen.add(identity);
      if (!totals[index].has(row.date)) totals[index].set(row.date, zero());
      if (!add(totals[index].get(row.date), values)) return { reason: 'invalid' };
      if (index) {
        if (!bySku.has(sku)) bySku.set(sku, zero());
        if (!add(bySku.get(sku), values)) return { reason: 'invalid' };
      }
    }
  }
  for (const date of new Set([...totals[0].keys(), ...totals[1].keys()])) {
    const daily = totals[0].get(date) || zero(), sku = totals[1].get(date) || zero();
    if (Object.keys(daily).some(key => daily[key] < sku[key])) return { reason: 'invalid' };
    if (Object.keys(daily).some(key => daily[key] > sku[key])) return { reason: 'unmapped' };
  }
  return { bySku };
}

/** Read-only projection. Pass full store catalogs for uniqueness checks and explicit selected keys. */
function buildPartnerSales(stores, { now = new Date(), productKeys = [] } = {}) {
  if (!Array.isArray(stores) || !Array.isArray(productKeys) || productKeys.some(key => typeof key !== 'string' || !key)) throw new TypeError('stores and explicit productKeys must be arrays');
  const instant = now instanceof Date ? now.getTime() : typeof now === 'string' || typeof now === 'number' ? new Date(now).getTime() : NaN;
  if (!Number.isFinite(instant)) throw new TypeError('now must be a valid date');
  const today = new Date(instant + MOSCOW_OFFSET).toISOString().slice(0, 10), dayStart = Date.parse(today);
  const period = { from: new Date(dayStart - 28 * DAY).toISOString().slice(0, 10), to: new Date(dayStart - DAY).toISOString().slice(0, 10) };
  const selected = new Set(productKeys), references = new Map(), storeIds = new Map(), prepared = new Map();
  for (const store of stores) {
    if (!store || typeof store.id !== 'string' || !store.id || !Array.isArray(store.products)) throw new TypeError('Each store needs an id and full products array');
    storeIds.set(store.id, (storeIds.get(store.id) || 0) + 1);
    const catalog = new Map();
    for (const product of store.products) {
      if (!product || typeof product.key !== 'string' || (product.skus !== undefined && !Array.isArray(product.skus))) throw new TypeError('Invalid product catalog');
      for (const sku of aliases(product)) catalog.set(sku, (catalog.get(sku) || 0) + 1);
      if (selected.has(product.key)) {
        if (!references.has(product.key)) references.set(product.key, []);
        references.get(product.key).push({ store, product });
      }
    }
    prepared.set(store, { catalog });
  }
  return [...selected].map(productKey => {
    const row = { productKey, sold: null, returned: null, period: { ...period }, source: SOURCE, reason: null };
    const matches = references.get(productKey) || [];
    let reason = matches.length === 1 ? null : 'binding';
    if (!reason) {
      const { store, product } = matches[0], { catalog } = prepared.get(store), skus = aliases(product);
      if (storeIds.get(store.id) !== 1 || product.storeId !== store.id || !product.key.startsWith(store.id + ':') ||
          product.key.length <= store.id.length + 1 || (product.product_id !== undefined && product.key !== store.id + ':' + product.product_id) ||
          !skus.size || [...skus].some(sku => catalog.get(sku) !== 1)) reason = 'binding';
      else if (store.market !== 'Ozon' || (product.market !== undefined && product.market !== 'Ozon')) reason = 'unsupported';
      else {
        const context = prepared.get(store);
        if (!context.history) context.history = readHistory(store.ledger, period, instant, dayStart - MOSCOW_OFFSET);
        const history = context.history, total = zero();
        reason = history.reason;
        if (!reason) for (const sku of skus) {
          const values = history.bySku.get(sku);
          if (values && !add(total, values)) { reason = 'invalid'; break; }
        }
        if (!reason && total.unknownUnitRows) reason = 'unknown';
        if (!reason && !total.salesRows) reason = 'insufficient';
        if (!reason) { row.sold = total.soldUnits; row.returned = total.returnedUnits; }
      }
    }
    row.reason = reason ? REASONS[reason] : null;
    return row;
  });
}

module.exports = { buildPartnerSales };
