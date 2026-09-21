'use strict';

const fs = require('node:fs');

const CONTRACTS = Object.freeze({
  wbFbs: Object.freeze({
    market: 'WB', scheme: 'FBS', unitBasis: 'one assembly order = one item unit',
    route: '/api/v3/orders', dateField: 'createdAt', classificationField: 'options.isB2B',
    reliableFalseFrom: '2025-02-26', sourceUrl: 'https://dev.wildberries.ru/docs/openapi/orders-fbs'
  }),
  wbDbs: Object.freeze({
    market: 'WB', scheme: 'DBS', unitBasis: 'one assembly order = one item unit',
    route: '/api/v3/dbs/orders', dateField: 'createdAt', classificationField: 'options.isB2b',
    reliableFalseFrom: '2025-02-26', sourceUrl: 'https://dev.wildberries.ru/openapi/orders-dbs'
  }),
  ozonFbo: Object.freeze({
    market: 'Ozon', scheme: 'FBO', unitBasis: 'sum products.quantity',
    route: '/v3/posting/fbo/list', dateField: 'created_at', classificationField: 'analytics_data.is_legal',
    sourceUrl: 'https://docs.ozon.ru/api/seller/'
  }),
  ozonFbs: Object.freeze({
    market: 'Ozon', scheme: 'FBS', unitBasis: 'sum products.quantity',
    route: '/v4/posting/fbs/list', dateField: 'created_at or in_process_at', classificationField: 'analytics_data.is_legal',
    sourceUrl: 'https://docs.ozon.ru/api/seller/'
  })
});

function isoInstant(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}
const moscowFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
function moscowDay(value) { const instant = isoInstant(value); return instant ? moscowFormatter.format(new Date(instant)) : null; }

function id(value) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 160) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function count(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function explicitBoolean(container, field) {
  return container && Object.prototype.hasOwnProperty.call(container, field) && typeof container[field] === 'boolean' ? container[field] : null;
}

function wbBuyerType(order, scheme, createdAt) {
  const field = scheme === 'DBS' ? 'isB2b' : 'isB2B';
  const flag = explicitBoolean(order?.options, field);
  if (flag === true) return { buyerType: 'legal', classificationField: 'options.' + field, reliable: true };
  const day = createdAt?.slice(0, 10);
  if (flag === false && day && day >= CONTRACTS.wbFbs.reliableFalseFrom) return { buyerType: 'individual', classificationField: 'options.' + field, reliable: true };
  return { buyerType: 'unknown', classificationField: flag === null ? null : 'options.' + field, reliable: false };
}

function cancellation(status) {
  if (!status || typeof status !== 'object') return null;
  if (status.supplierStatus === 'cancel' || status.supplierStatus === 'cancel_carrier') return true;
  if (typeof status.supplierStatus === 'string' && typeof status.wbStatus === 'string') return false;
  if (status.market === 'Ozon' && typeof status.value === 'string') return status.value === 'cancelled';
  return null;
}

function projectWbOrder(order, { scheme = 'FBS', status = null } = {}) {
  if (!order || typeof order !== 'object' || !['FBS', 'DBS'].includes(scheme)) return null;
  const orderId = id(order.id), createdAt = isoInstant(order.createdAt);
  if (!orderId || !createdAt) return null;
  const segment = wbBuyerType(order, scheme, createdAt);
  const options = arguments[1] || {};
  return {
    id: 'WB:' + scheme + ':' + orderId,
    orderKey: id(order.orderUid) || orderId,
    market: 'WB', scheme, storeId: id(options.storeId) || null, storeName: typeof options.storeName === 'string' ? options.storeName : null, createdAt, units: 1,
    buyerType: segment.buyerType,
    classificationField: segment.classificationField,
    classificationReliable: segment.reliable,
    cancelled: cancellation(status)
  };
}

function ozonBuyerType(posting) {
  const flag = explicitBoolean(posting?.analytics_data, 'is_legal');
  if (flag === true) return { buyerType: 'legal', classificationField: 'analytics_data.is_legal' };
  if (flag === false) return { buyerType: 'individual', classificationField: 'analytics_data.is_legal' };
  return { buyerType: 'unknown', classificationField: null };
}

function projectOzonPosting(posting, { scheme = 'FBO' } = {}) {
  if (!posting || typeof posting !== 'object' || !['FBO', 'FBS'].includes(scheme)) return null;
  const postingId = id(posting.posting_number), createdAt = isoInstant(posting.created_at || posting.in_process_at);
  if (!postingId || !createdAt || !Array.isArray(posting.products) || !posting.products.length) return null;
  let units = 0;
  for (const product of posting.products) {
    const quantity = count(product?.quantity);
    if (quantity === null) return null;
    units += quantity;
    if (!Number.isSafeInteger(units)) return null;
  }
  const segment = ozonBuyerType(posting);
  const options = arguments[1] || {};
  return {
    id: 'Ozon:' + scheme + ':' + postingId,
    orderKey: id(posting.order_number) || postingId,
    market: 'Ozon', scheme, storeId: id(options.storeId) || null, storeName: typeof options.storeName === 'string' ? options.storeName : null, createdAt, units,
    buyerType: segment.buyerType,
    classificationField: segment.classificationField,
    classificationReliable: segment.buyerType !== 'unknown',
    cancelled: typeof posting.status === 'string' ? cancellation({ market: 'Ozon', value: posting.status }) : null
  };
}

function rubUnitPrice(product) {
  const price = product?.price;
  if (price && typeof price === 'object' && price.currency_code === 'RUB' && /^-?\d+$/.test(String(price.units ?? '')) && Number.isInteger(Number(price.nanos || 0))) {
    const value = Number(price.units) + Number(price.nanos || 0) / 1e9;
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (product?.currency !== 'RUB' || (typeof price !== 'number' && (typeof price !== 'string' || !/^\d+(?:\.\d+)?$/.test(price)))) return null;
  const value = Number(price);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function projectOzonProductOrders(posting, { scheme = 'FBO', storeId = null, updatedAt = null } = {}) {
  if (!posting || typeof posting !== 'object' || !Array.isArray(posting.products)) return [];
  const orderId = id(posting.order_number) || id(posting.posting_number), postingId = id(posting.posting_number);
  if (!orderId || !postingId) return [];
  const orderedAt = isoInstant(posting.created_at), fetchedAt = isoInstant(updatedAt);
  const cancelled = typeof posting.status === 'string' ? cancellation({ market: 'Ozon', value: posting.status }) : null;
  const segment = ozonBuyerType(posting);
  const grouped = new Map();
  for (const product of posting.products) {
    const productId = id(product?.sku), units = count(product?.quantity);
    if (!productId || units === null) continue;
    const unitPrice = rubUnitPrice(product), amountRub = unitPrice === null ? null : Math.round(unitPrice * units * 100) / 100;
    const previous = grouped.get(productId);
    if (!previous) grouped.set(productId, { market: 'Ozon', storeId: id(storeId), scheme, orderId, postingId, productId, orderedAt, units, amountRub, buyerType: segment.buyerType, classificationField: segment.classificationField, cancelled, updatedAt: fetchedAt, source: CONTRACTS[scheme === 'FBO' ? 'ozonFbo' : 'ozonFbs'].route });
    else {
      previous.units += units;
      previous.amountRub = previous.amountRub === null || amountRub === null ? null : Math.round((previous.amountRub + amountRub) * 100) / 100;
    }
  }
  return [...grouped.values()];
}

function projectWbProductOrder(order, { scheme = 'FBS', storeId = null, status = null, updatedAt = null } = {}) {
  const orderId = id(order?.orderUid) || id(order?.id), productId = id(order?.nmId), orderedAt = isoInstant(order?.createdAt);
  if (!orderId || !productId || !orderedAt) return null;
  const segment = wbBuyerType(order, scheme, orderedAt);
  return { market: 'WB', storeId: id(storeId), scheme, orderId, postingId: id(order.id), productId, orderedAt, units: 1, amountRub: null, buyerType: segment.buyerType, classificationField: segment.classificationField, cancelled: cancellation(status), updatedAt: isoInstant(updatedAt), source: CONTRACTS[scheme === 'DBS' ? 'wbDbs' : 'wbFbs'].route };
}

function mergeProductOrders(rows) {
  const merged = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.market || !row.storeId || !row.scheme || !row.orderId || !row.productId || count(row.units) === null) continue;
    const key = [row.market, row.storeId, row.scheme, row.orderId, row.productId].join(':');
    const previous = merged.get(key);
    if (!previous) merged.set(key, { ...row });
    else {
      if (!Number.isSafeInteger(previous.units + row.units)) continue;
      previous.units += row.units;
      previous.amountRub = previous.amountRub === null || row.amountRub === null ? null : Math.round((previous.amountRub + row.amountRub) * 100) / 100;
      previous.buyerType = previous.buyerType === row.buyerType ? previous.buyerType : 'unknown';
      previous.classificationField = previous.classificationField === row.classificationField ? previous.classificationField : null;
      previous.cancelled = previous.cancelled === false || row.cancelled === false ? false : previous.cancelled === null || row.cancelled === null ? null : true;
      if (!previous.orderedAt && row.orderedAt) previous.orderedAt = row.orderedAt;
      if (row.updatedAt && (!previous.updatedAt || row.updatedAt > previous.updatedAt)) previous.updatedAt = row.updatedAt;
    }
  }
  return [...merged.values()].sort((a, b) => String(a.orderedAt || '').localeCompare(String(b.orderedAt || '')) || a.orderId.localeCompare(b.orderId) || a.productId.localeCompare(b.productId));
}

function aggregate(records, { from, to, sources = [] } = {}) {
  from = validDay(from); to = validDay(to);
  if (!from || !to || from > to) throw new Error('Некорректный период заказов');
  const empty = () => ({ units: 0, orders: 0, cancelledUnits: 0, cancelledOrders: 0, notCancelledUnits: 0, notCancelledOrders: 0, cancellationUnknownUnits: 0, cancellationUnknownOrders: 0 });
  const totals = Object.fromEntries(['legal', 'individual', 'unknown'].map(key => [key, empty()]));
  const stores = new Map();
  const orderStates = new Map();
  const seen = new Set();
  let invalidRecords = 0, duplicateRecords = 0, includedRecords = 0;
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record.id !== 'string' || typeof record.orderKey !== 'string' || !['legal', 'individual', 'unknown'].includes(record.buyerType) || count(record.units) === null || !isoInstant(record.createdAt)) { invalidRecords++; continue; }
    const uniqueId = record.market + ':' + (record.storeId || 'unknown') + ':' + record.id;
    if (seen.has(uniqueId)) { duplicateRecords++; continue; }
    seen.add(uniqueId);
    const day = moscowDay(record.createdAt);
    if (day < from || day > to) continue;
    const storeKey = record.market + ':' + (record.storeId || 'unknown');
    if (!stores.has(storeKey)) stores.set(storeKey, { storeId: record.storeId, name: record.storeName, market: record.market, totals: Object.fromEntries(['legal', 'individual', 'unknown'].map(key => [key, empty()])) });
    const targets = [['total:' + record.buyerType, totals[record.buyerType]], ['store:' + storeKey + ':' + record.buyerType, stores.get(storeKey).totals[record.buyerType]]];
    if (targets.some(([, segment]) => !Number.isSafeInteger(segment.units + record.units))) { invalidRecords++; continue; }
    includedRecords++;
    for (const [bucketKey, segment] of targets) {
      segment.units += record.units;
      if (record.cancelled === true) segment.cancelledUnits += record.units;
      else if (record.cancelled === false) segment.notCancelledUnits += record.units;
      else segment.cancellationUnknownUnits += record.units;
      const key = bucketKey + ':' + record.market + ':' + (record.storeId || 'unknown') + ':' + record.orderKey;
      const previous = orderStates.get(key);
      orderStates.set(key, previous === false || record.cancelled === false ? false : previous === null || record.cancelled === null ? null : true);
    }
  }
  for (const [key, state] of orderStates) {
    let segment;
    if (key.startsWith('total:')) segment = totals[key.split(':')[1]];
    else {
      const parts = key.split(':'), buyerType = parts[3], storeKey = parts[1] + ':' + parts[2];
      segment = stores.get(storeKey).totals[buyerType];
    }
    segment.orders++;
    if (state === true) segment.cancelledOrders++;
    else if (state === false) segment.notCancelledOrders++;
    else segment.cancellationUnknownOrders++;
  }
  const coverageSources = sources.map(source => {
    const actualFrom = validDay(source.requested?.from) || validDay(source.from), actualTo = validDay(source.requested?.to) || validDay(source.to);
    const coversRequested = !!(actualFrom && actualTo && from >= actualFrom && to <= actualTo);
    const available = source.available === true;
    return {
      market: source.market, scheme: source.scheme, storeId: source.storeId || null,
      name: typeof source.name === 'string' ? source.name : null,
      complete: source.complete === true && coversRequested,
      available, coversRequested,
      requested: { from: actualFrom, to: actualTo },
      fetchedAt: isoInstant(source.fetchedAt),
      limitation: !coversRequested ? 'Снимок не покрывает выбранный период.' : typeof source.limitation === 'string' ? source.limitation : null
    };
  });
  for (const source of coverageSources) {
    if (!source.storeId) continue;
    const storeKey = source.market + ':' + source.storeId;
    if (!stores.has(storeKey)) stores.set(storeKey, { storeId: source.storeId, name: source.name, market: source.market, totals: source.available && source.coversRequested ? Object.fromEntries(['legal', 'individual', 'unknown'].map(key => [key, empty()])) : null });
    else {
      if (!stores.get(storeKey).name && source.name) stores.get(storeKey).name = source.name;
      if (stores.get(storeKey).totals === null && source.available && source.coversRequested) stores.get(storeKey).totals = Object.fromEntries(['legal', 'individual', 'unknown'].map(key => [key, empty()]));
    }
  }
  const availableSources = coverageSources.filter(source => source.available && source.coversRequested);
  const freshness = availableSources.map(source => source.fetchedAt).filter(Boolean).sort();
  const commonFreshnessAt = freshness[0] || null, newestSourceAt = freshness.at(-1) || null;
  for (const store of stores.values()) {
    const own = coverageSources.filter(source => source.market === store.market && source.storeId === store.storeId && source.available && source.coversRequested).map(source => source.fetchedAt).filter(Boolean).sort();
    store.lastUpdated = own[0] || null;
  }
  const status = availableSources.length === 0 ? 'unavailable' : invalidRecords === 0 && coverageSources.length > 0 && coverageSources.every(source => source.complete) ? 'ready' : 'partial';
  return {
    status, period: { from, to }, totals: status === 'unavailable' ? null : totals, byStore: [...stores.values()].sort((a, b) => (a.market + ':' + (a.name || '')).localeCompare(b.market + ':' + (b.name || ''), 'ru')),
    coverage: {
      complete: status === 'ready',
      includedRecords, invalidRecords, duplicateRecords, sources: coverageSources
    },
    source: { metric: 'gross_ordered_item_units', contracts: CONTRACTS, commonFreshnessAt, newestSourceAt },
    limitations: [
      'Это заказанные единицы товара, а не реализованные продажи.',
      'Отмены показаны отдельно и не вычитаются из gross ordered.',
      'Отсутствующий или исторически ненадёжный признак юрлица относится к «Не определено».',
      'WB FBS/DBS не подтверждает покрытие заказов со склада WB (FBW/FBO).'
    ]
  };
}

function create({ snapshotFile }) {
  if (typeof snapshotFile !== 'string') throw new Error('Укажите компактный снимок сегментов заказов');
  let cachedMtime = -1, cached = null;
  function load() {
    if (!fs.existsSync(snapshotFile)) return null;
    const mtime = fs.statSync(snapshotFile).mtimeMs;
    if (mtime !== cachedMtime) { cached = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')); cachedMtime = mtime; }
    return cached;
  }
  return { read({ from, to, market, storeId } = {}) {
    market = market === '' || market === 'all' || market == null ? null : market;
    if (market && !['WB', 'Ozon'].includes(market)) throw new Error('Неизвестный маркетплейс');
    const snapshot = load();
    if (!snapshot || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.report?.coverage?.sources)) return aggregate([], { from, to, sources: [] });
    const matches = value => (!market || value.market === market) && (!storeId || value.storeId === storeId);
    return aggregate(snapshot.records.filter(matches), { from, to, sources: snapshot.report.coverage.sources.filter(matches) });
  } };
}

function merge(records) {
  const result = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const key = record && typeof record.id === 'string' ? record.market + ':' + (record.storeId || 'unknown') + ':' + record.id : null;
    if (key && !result.has(key)) result.set(key, record);
  }
  return [...result.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

module.exports = { CONTRACTS, wbBuyerType, ozonBuyerType, projectWbOrder, projectOzonPosting, projectOzonProductOrders, projectWbProductOrder, mergeProductOrders, aggregate, merge, create, moscowDay };
