'use strict';

const { projectOzonPosting, projectOzonProductOrders, mergeProductOrders, aggregate, merge } = require('../../buyer-order-segments.cjs');

const DAY = 86400000;
const UUID_DAY = /^\d{4}-\d{2}-\d{2}$/u;

class BuyerCollectorError extends Error {
  constructor(code, message) { super(message); this.name = 'BuyerCollectorError'; this.code = code; }
}
const fail = (code, message) => { throw new BuyerCollectorError(code, message); };
function validDay(value) {
  if (typeof value !== 'string' || !UUID_DAY.test(value)) return false;
  const parsed = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
function dayWindow(date) {
  if (!validDay(date)) fail('INVALID_ARGUMENT', 'Buyer collection date is invalid');
  const start = Date.parse(date + 'T00:00:00+03:00');
  return { from: date, to: date, start, end: start + DAY, fromIso: new Date(start).toISOString(), toIso: new Date(start + DAY - 1).toISOString() };
}
function assertPeriod(rows, field, window) {
  for (const row of rows) {
    const stamp = Date.parse(row?.[field]);
    if (!Number.isFinite(stamp) || stamp < window.start || stamp >= window.end) fail('OUT_OF_PERIOD', 'Buyer source returned rows outside the requested day');
  }
}
const sourceKey = value => [value?.market, value?.storeId, value?.scheme].join('\u001f');
function validateCollected(document, targetIds, now = Date.now()) {
  const date = document?.period?.from, window = dayWindow(date), targets = [...targetIds].sort();
  if (document?.period?.to !== date || document?.report?.period?.from !== date || document?.report?.period?.to !== date ||
      document?.status !== 'collected' || document?.scope !== 'all-ozon-stores' ||
      !Array.isArray(document.records) || !Array.isArray(document.productOrders) ||
      !Array.isArray(document.report?.coverage?.sources) || !Array.isArray(document.errors) || document.errors.length || date > new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)))
    fail('INCOMPLETE_SOURCE', 'Buyer snapshot is not a complete one-day source');
  assertPeriod(document.records, 'createdAt', window);
  assertPeriod(document.productOrders, 'orderedAt', window);
  const expected = targets.flatMap(storeId => ['FBO', 'FBS'].map(scheme => `Ozon\u001f${storeId}\u001f${scheme}`)).sort();
  const actual = document.report.coverage.sources.map(sourceKey).sort(), expectedSet = new Set(expected);
  if (!expected.length || actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) ||
      document.report.coverage.sources.some(source => source.available !== true || (source.requested?.from || source.from) !== date || (source.requested?.to || source.to) !== date))
    fail('INCOMPLETE_SOURCE', 'Buyer snapshot does not cover every captured Ozon source');
  for (const row of [...document.records, ...document.productOrders]) if (!expectedSet.has(sourceKey(row)) || !Number.isSafeInteger(row.units) || row.units <= 0) fail('INCOMPLETE_SOURCE', 'Buyer snapshot contains invalid source rows');
  for (const key of expected) {
    const recordUnits = document.records.filter(row => sourceKey(row) === key).reduce((sum, row) => sum + row.units, 0);
    const productUnits = document.productOrders.filter(row => sourceKey(row) === key).reduce((sum, row) => sum + row.units, 0);
    if (!Number.isSafeInteger(recordUnits) || recordUnits !== productUnits) fail('INCOMPLETE_SOURCE', 'Buyer product rows do not match order units');
  }
  return true;
}
function validateComplete(document, targetIds, now = Date.now()) {
  validateCollected(document, targetIds, now);
  if (document.report.coverage.complete !== true || !document.records.length || !document.productOrders.length || document.report.coverage.sources.some(source => source.complete !== true))
    fail('INCOMPLETE_SOURCE', 'Buyer snapshot is not a complete one-day source');
  return true;
}

function createOzonBuyerOrdersCollector({ api, now = () => new Date() } = {}) {
  if (typeof api !== 'function' || typeof now !== 'function') throw new TypeError('Ozon API and clock are required');
  async function collectScheme(target, scheme, window) {
    const route = scheme === 'FBO' ? '/v3/posting/fbo/list' : '/v4/posting/fbs/list';
    const records = [], productOrders = [], cursors = new Set(); let cursor = '', pages = 0, rawRows = 0, skippedOutside = 0, rejectedRows = 0;
    const updatedAt = now().toISOString();
    for (;;) {
      const value = await api({ name: target.name, clientId: target.clientId }, target.key, route, {
        cursor, filter: { since: window.fromIso, to: window.toIso, status: [] }, limit: 100, sort_dir: 'asc', translit: false,
        with: { analytics_data: true, financial_data: false, legal_info: false, ...(scheme === 'FBS' ? { barcodes: false, translit: false } : {}) }
      });
      const container = Array.isArray(value?.postings) ? value : value?.result && Array.isArray(value.result.postings) ? value.result : null;
      if (!container) fail('SOURCE_SCHEMA', 'Ozon buyer response shape is invalid');
      pages++; rawRows += container.postings.length;
      for (const posting of container.postings) {
        const createdAt = Date.parse(posting?.created_at);
        if (!Number.isFinite(createdAt)) fail('SOURCE_SCHEMA', 'Ozon buyer row has an invalid created_at');
        if (createdAt < window.start || createdAt >= window.end) {
          const processedAt = Date.parse(posting?.in_process_at);
          if (scheme === 'FBO' && Number.isFinite(processedAt) && processedAt >= window.start && processedAt < window.end) { skippedOutside++; continue; }
          fail('OUT_OF_PERIOD', 'Buyer source returned rows outside the requested day');
        }
        const record = projectOzonPosting(posting, { scheme, storeId: target.storeId, storeName: target.name });
        const products = projectOzonProductOrders(posting, { scheme, storeId: target.storeId, updatedAt });
        if (!record || !products.length) { rejectedRows++; continue; }
        records.push(record); productOrders.push(...products);
      }
      if (container.has_next !== true) break;
      if (typeof container.cursor !== 'string' || !container.cursor || cursors.has(container.cursor)) fail('SOURCE_PAGINATION', 'Ozon buyer pagination is unstable');
      cursors.add(container.cursor); cursor = container.cursor;
      if (pages >= 10000) fail('SOURCE_PAGINATION', 'Ozon buyer pagination exceeds the supported limit');
    }
    assertPeriod(records, 'createdAt', window); assertPeriod(productOrders, 'orderedAt', window);
    const limitations=[];
    if(scheme==='FBO')limitations.push('Ozon FBO фильтрует выдачу по времени обработки; полнота по дате создания заказа не подтверждена.');
    if(skippedOutside)limitations.push('Строки с created_at вне выбранного дня исключены.');
    if(rejectedRows)limitations.push('Часть отправлений не прошла безопасную проекцию.');
    return { records, productOrders, source: { market: 'Ozon', scheme, storeId: target.storeId, name: target.name, from: window.from, to: window.to, available: true, complete: scheme !== 'FBO' && !skippedOutside && !rejectedRows && records.length === rawRows, fetchedAt: now().toISOString(), rows: rawRows, pages, limitation: limitations.join(' ') || null } };
  }
  async function collect({ date, timestamp, targets } = {}) {
    const window = dayWindow(date);
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)) || !Array.isArray(targets) || !targets.length || targets.some((target, index) =>
      !target || !/^\d+$/u.test(target.storeId || '') || String(target.clientId) !== target.storeId || typeof target.name !== 'string' || !target.name || typeof target.key !== 'string' || !target.key || index && targets[index - 1].storeId.localeCompare(target.storeId) >= 0)) fail('INVALID_ARGUMENT', 'Buyer collection scope is invalid');
    const parts = await Promise.all(targets.flatMap(target => ['FBO', 'FBS'].map(scheme => collectScheme(target, scheme, window))));
    const records = merge(parts.flatMap(value => value.records)), productOrders = mergeProductOrders(parts.flatMap(value => value.productOrders)), sources = parts.map(value => value.source);
    const document = { version: 2, period: { from: date, to: date }, scope: 'all-ozon-stores', status: 'collected', generatedAt: timestamp, records, productOrders, report: aggregate(records, { from: date, to: date, sources }), errors: [] };
    validateCollected(document, targets.map(target => target.storeId), now().valueOf());
    return document;
  }
  return Object.freeze({ collect });
}

module.exports = { createOzonBuyerOrdersCollector, BuyerCollectorError, validDay, dayWindow, validateCollected, validateComplete };



