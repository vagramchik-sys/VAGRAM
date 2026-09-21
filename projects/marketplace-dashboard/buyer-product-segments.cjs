'use strict';

const fs = require('node:fs');
const { mergeProductOrders, moscowDay } = require('./buyer-order-segments.cjs');

const TYPES = ['legal', 'individual', 'unknown'];
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}
function tuple(value, orderField = 'orderId') {
  if (!value || !value.market || !value.storeId || !value.scheme || !value[orderField]) return null;
  return [value.market, value.storeId, value.scheme, value[orderField]].join('\u001f');
}
function normalizeType(value) { return TYPES.includes(value) ? value : 'unknown'; }

function enrichBuyerTypes(productOrders, records) {
  const byOrder = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const key = tuple(record, 'orderKey');
    if (!key) continue;
    const type = normalizeType(record.buyerType), previous = byOrder.get(key);
    byOrder.set(key, previous === undefined ? type : previous === type ? type : 'unknown');
  }
  return mergeProductOrders(productOrders).map(row => {
    const direct = normalizeType(row.buyerType), joined = byOrder.get(tuple(row));
    if (direct !== 'unknown') return { ...row, buyerType: direct };
    return { ...row, buyerType: joined === 'legal' || joined === 'individual' ? joined : 'unknown', classificationField: joined === 'legal' || joined === 'individual' ? 'joined-order-record' : row.classificationField || null };
  });
}

function empty() {
  return { units: 0, orders: 0, amountRub: 0, amountKnown: true, cancelledUnits: 0, cancelledOrders: 0, cancellationUnknownUnits: 0, cancellationUnknownOrders: 0, _orders: new Set(), _cancelled: new Set(), _unknownCancellation: new Set() };
}
function add(bucket, row) {
  if (!Number.isSafeInteger(bucket.units + row.units)) throw new Error('Слишком большое количество товаров');
  bucket.units += row.units;
  const orderKey = tuple(row) + '\u001f' + row.productId;
  bucket._orders.add(orderKey);
  if (typeof row.amountRub === 'number' && Number.isFinite(row.amountRub) && row.amountRub >= 0) bucket.amountRub = Math.round((bucket.amountRub + row.amountRub) * 100) / 100;
  else bucket.amountKnown = false;
  if (row.cancelled === true) { bucket.cancelledUnits += row.units; bucket._cancelled.add(orderKey); }
  else if (row.cancelled === null || row.cancelled === undefined) { bucket.cancellationUnknownUnits += row.units; bucket._unknownCancellation.add(orderKey); }
}
function finish(bucket) {
  bucket.orders = bucket._orders.size; bucket.cancelledOrders = bucket._cancelled.size; bucket.cancellationUnknownOrders = bucket._unknownCancellation.size;
  if (!bucket.amountKnown) bucket.amountRub = null;
  delete bucket._orders; delete bucket._cancelled; delete bucket._unknownCancellation;
  return bucket;
}

function summarize(productOrders, { records = [], sources = [], from, to, market = null, storeId = null } = {}) {
  from = day(from); to = day(to);
  if (!from || !to || from > to) throw new Error('Некорректный период товарных сегментов');
  market = market === '' || market === 'all' || market == null ? null : market;
  if (market && !['Ozon', 'WB'].includes(market)) throw new Error('Неизвестный маркетплейс');
  const matches = value => (!market || value.market === market) && (!storeId || value.storeId === storeId);
  const rows = enrichBuyerTypes((Array.isArray(productOrders) ? productOrders : []).filter(matches), (Array.isArray(records) ? records : []).filter(matches));
  const totals = Object.fromEntries(TYPES.map(type => [type, empty()])), products = new Map();
  let missingTimeRows = 0, includedRows = 0;
  for (const row of rows) {
    if (!row.orderedAt) { missingTimeRows++; continue; }
    const orderedDay = moscowDay(row.orderedAt);
    if (!orderedDay) { missingTimeRows++; continue; }
    if (orderedDay < from || orderedDay > to) continue;
    const buyerType = normalizeType(row.buyerType);
    const productKey = [row.market, row.storeId, row.productId].join('\u001f');
    if (!products.has(productKey)) products.set(productKey, { market: row.market, storeId: row.storeId, productId: row.productId, segments: Object.fromEntries(TYPES.map(type => [type, empty()])) });
    add(totals[buyerType], row); add(products.get(productKey).segments[buyerType], row); includedRows++;
  }
  for (const type of TYPES) finish(totals[type]);
  const ranked = [...products.values()].map(({ market: productMarket, storeId: productStoreId, productId, segments }) => {
    for (const type of TYPES) finish(segments[type]);
    const knownUnits = segments.legal.units + segments.individual.units;
    return { market: productMarket, storeId: productStoreId, productId, segments, legalShare: knownUnits ? segments.legal.units / knownUnits : null, knownUnits };
  }).sort((a, b) => b.segments.legal.units - a.segments.legal.units || (b.legalShare ?? -1) - (a.legalShare ?? -1) || (a.market + ':' + a.storeId + ':' + a.productId).localeCompare(b.market + ':' + b.storeId + ':' + b.productId));
  const coverageSources = (Array.isArray(sources) ? sources : []).filter(matches).map(source => {
    const actualFrom = day(source.requested?.from) || day(source.from), actualTo = day(source.requested?.to) || day(source.to);
    const coversRequested = !!(actualFrom && actualTo && from >= actualFrom && to <= actualTo);
    const overlapsRequested = !!(actualFrom && actualTo && actualFrom <= to && actualTo >= from);
    return { market: source.market, storeId: source.storeId || null, name: source.name || null, scheme: source.scheme, available: source.available === true, complete: source.complete === true && coversRequested, coversRequested, overlapsRequested, requested: { from: actualFrom, to: actualTo }, fetchedAt: source.fetchedAt || null, limitation: !coversRequested ? 'Снимок покрывает только часть выбранного периода.' : source.limitation || null };
  });
  const usable = coverageSources.filter(source => source.available && source.overlapsRequested);
  const status = usable.length === 0 ? 'unavailable' : missingTimeRows === 0 && coverageSources.length > 0 && coverageSources.every(source => source.complete) ? 'ready' : 'partial';
  return {
    status, period: { from, to }, totals: status === 'unavailable' ? null : totals, products: status === 'unavailable' ? [] : ranked,
    coverage: { complete: status === 'ready', includedRows, missingTimeRows, classifiedRows: rows.filter(row => row.buyerType === 'legal' || row.buyerType === 'individual').length, unknownRows: rows.filter(row => row.buyerType === 'unknown').length, sources: coverageSources },
    source: { metric: 'gross_ordered_product_units_by_buyer_type', amountRule: 'amountRub указан только при подтверждённой валюте RUB', ranking: 'legal units desc' }
  };
}

function create({ snapshotFile }) {
  if (typeof snapshotFile !== 'string') throw new Error('Укажите снимок заказов');
  let mtime = -1, snapshot = null;
  function load() {
    if (!fs.existsSync(snapshotFile)) return null;
    const next = fs.statSync(snapshotFile).mtimeMs;
    if (next !== mtime) { snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')); mtime = next; }
    return snapshot;
  }
  return { read(query = {}) { const value = load(); return summarize(value?.productOrders || [], { ...query, records: value?.records || [], sources: value?.report?.coverage?.sources || [] }); } };
}

module.exports = { enrichBuyerTypes, summarize, create };
