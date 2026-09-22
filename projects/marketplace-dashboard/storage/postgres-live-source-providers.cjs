'use strict';

class LiveSourceProviderError extends Error {
  constructor(code, message) { super(message); this.name = 'LiveSourceProviderError'; this.code = code; }
}

const fail = (code, message) => { throw new LiveSourceProviderError(code, message); };
const STORE = /^(?:wb-)?[0-9]+$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const BUYER = /^buyer-(order-segments|product-segments)-(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})(?:-retry-(\d+))?(\.partial)?\.json$/u;
const clone = value => value == null ? value : structuredClone(value);
const validDay = value => {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};
const store = value => STORE.test(String(value)) ? String(value) : fail('INVALID_STORE', 'Store id is invalid');
const period = ({from, to} = {}) => validDay(from) && validDay(to) && from <= to ? {from, to} : fail('INVALID_PERIOD', 'Buyer source period is invalid');

function createLiveSourceProviders({sources} = {}) {
  if (!sources || typeof sources.record !== 'function' || typeof sources.listSources !== 'function' || typeof sources.identity !== 'function') {
    throw new TypeError('Live SQL sources are required');
  }

  // Share only active reads. A later request always observes a fresh SQL head.
  const inFlight = new Map();
  async function shared(key, read) {
    let pending = inFlight.get(key);
    if (!pending) {
      pending = Promise.resolve().then(read);
      inFlight.set(key, pending);
    }
    try { return await pending; }
    finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
  }

  async function names() {
    let rows;
    try { rows = await shared('catalog', () => sources.listSources()); }
    catch { fail('DATABASE_ERROR', 'Live SQL source catalog is unavailable'); }
    if (!Array.isArray(rows)) fail('CORRUPT_SOURCE', 'Live source catalog is invalid');
    return rows.filter(row => row && typeof row.sourcePath === 'string');
  }

  async function read(sourcePath, entities) {
    try { sources.identity(sourcePath); } catch { fail('INVALID_SOURCE', 'Source path is invalid'); }
    let row;
    try { row = await shared(JSON.stringify([sourcePath, entities || null]), () => sources.record(sourcePath, entities ? {entities} : undefined)); }
    catch (error) {
      if (error instanceof LiveSourceProviderError) throw error;
      fail(error?.code === 'CORRUPT_DOCUMENT' ? 'CORRUPT_SOURCE' : 'DATABASE_ERROR', 'Live SQL source is unavailable');
    }
    if (row == null) return null;
    if (!row || typeof row !== 'object' || !row.value || typeof row.value !== 'object' || Array.isArray(row.value)) fail('CORRUPT_SOURCE', 'Live SQL source shape is invalid');
    return row;
  }

  async function exact(sourcePath) {
    if (/^(?:costs-wb-[0-9]+|prices-[0-9]+|ledger-wb-[0-9]+)\.json$/u.test(String(sourcePath))) return null;
    return clone((await read(sourcePath))?.value ?? null);
  }
  async function getMarketSnapshot(storeId) { return exact(`data-${store(storeId)}.json`); }

  async function getProducts(storeId) {
    storeId = store(storeId);
    const row = await read(`data-${storeId}.json`, ['products']);
    if (!row) return [];
    if (!Array.isArray(row.value.products)) fail('CORRUPT_SOURCE', 'Live product collection is invalid');
    return row.value.products.map(product => ({...clone(product), storeId, key: storeId + ':' + String(product.product_id ?? product.nmID ?? product.sku ?? '')}));
  }

  async function getCatalog(storeId) {
    const row = await read(`data-${store(storeId)}.json`, ['products', 'categoryTree']);
    return clone(row?.value ?? null);
  }

  async function getReportCatalog(storeId) {
    storeId = store(storeId);
    const row = await read(`data-${storeId}.json`, ['products', 'stocks']);
    if (!row) return null;
    const revision = String(row.revision ?? row.head?.revision ?? '');
    const sourceSha256 = row.head?.sourceMetadata?.sourceSha256;
    if (!/^\d+$/u.test(revision) || !HASH.test(sourceSha256 || '') || !Array.isArray(row.value.products) || !Array.isArray(row.value.stocks)) {
      fail('CORRUPT_SOURCE', 'Live report catalog integrity check failed');
    }
    return {...clone(row.value), _source: {snapshotId: `live:${storeId}:${revision}`, marketRevision: revision, marketSha256: sourceSha256}};
  }

  async function getAllProducts() {
    const paths = (await names()).map(row => row.sourcePath).filter(path => /^data-(?:wb-)?[0-9]+\.json$/u.test(path)).sort();
    const result = [];
    for (const path of paths) {
      const storeId = path.slice(5, -5), row = await read(path, ['products']);
      if (!row) continue;
      if (!Array.isArray(row.value.products)) fail('CORRUPT_SOURCE', 'Live product collection is invalid');
      for (const product of row.value.products) result.push({...clone(product), storeId, key: storeId + ':' + String(product.product_id ?? product.nmID ?? product.sku ?? '')});
    }
    return result;
  }

  async function getOzonFunnel(storeId) {
    const value = await exact(`ozon-funnel-${store(storeId)}.json`);
    if (!value) return {snapshot: null, status: 'unavailable', retryAt: null, lastAttemptAt: null, error: null};
    if (!Object.hasOwn(value, 'snapshot') || typeof value.status !== 'string') fail('CORRUPT_SOURCE', 'Ozon funnel wrapper shape is invalid');
    return value;
  }
  const getOzonLedger = storeId => { storeId=store(storeId); return storeId.startsWith('wb-')?null:exact(`ledger-${storeId}.json`); };
  async function getWbFinance(storeId) {
    storeId = store(storeId);
    if (!storeId.startsWith('wb-')) fail('INVALID_STORE', 'WB store id is invalid');
    return clone((await read(`data-${storeId}.json`, ['operations']))?.value ?? null);
  }

  async function listed(prefix, pattern, entities, map) {
    const selected = (await names()).map(row => row.sourcePath).filter(path => path.startsWith(prefix) && pattern.test(path)).sort();
    const result = [];
    for (const sourcePath of selected) {
      const row = await read(sourcePath, entities);
      if (row) result.push(map(sourcePath, clone(row.value)));
    }
    return result;
  }
  const getCatalogs = () => listed('order-category-catalog-', /^order-category-catalog-(?:wb-)?[0-9]+\.json$/u, ['products', 'categoryTree'], (path, value) => {
    const storeId = path.slice(23, -5);
    if (!Array.isArray(value.products)) fail('CORRUPT_SOURCE', 'Order category catalog shape is invalid');
    return {...value, storeId, market: storeId.startsWith('wb-') ? 'WB' : 'Ozon'};
  });
  const getInsights = () => listed('insights-', /^insights-[0-9]+\.json$/u, ['orders.daily', 'orders.skuDaily', 'orders.skuCoverage', 'types', 'errors'], (path, value) => ({storeId: path.slice(9, -5), value}));
  const getWbOrders = () => listed('wb-orders-', /^wb-orders-wb-[0-9]+\.json$/u, ['points', 'orders', 'rows'], (path, value) => ({storeId: path.slice(10, -5), value}));

  async function buyerNames(kind) {
    return (await names()).map(row => row.sourcePath).filter(path => {
      const match = BUYER.exec(path);
      return match && match[1] === kind;
    });
  }
  async function buyer(kind, options) {
    const {from, to} = period(options), candidates = (await buyerNames(kind)).filter(path => {
      const match = BUYER.exec(path);
      return match[2] === from && match[3] === to && !match[5];
    });
    candidates.sort((a, b) => Number(BUYER.exec(b)?.[4] || 0) - Number(BUYER.exec(a)?.[4] || 0) || b.localeCompare(a));
    if (!candidates.length) return null;
    return clone((await read(candidates[0]))?.value ?? null);
  }
  const getBuyerOrderSnapshot = options => buyer('order-segments', options);
  const getBuyerProductSnapshot = options => buyer('product-segments', options);

  async function getBuyerOrderSnapshots(options) {
    const {from, to} = period(options), latest = new Map();
    for (const sourcePath of await buyerNames('order-segments')) {
      const match = BUYER.exec(sourcePath);
      if (match[2] > to || match[3] < from || match[5]) continue;
      const key = match[2] + '_' + match[3], retry = Number(match[4] || 0), previous = latest.get(key);
      if (!previous || retry > previous.retry || retry === previous.retry && sourcePath.localeCompare(previous.sourcePath) > 0) latest.set(key, {retry, sourcePath});
    }
    const paths = [...latest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry.sourcePath), result = [];
    for (const path of paths) { const row = await read(path); if (row) result.push(clone(row.value)); }
    return result;
  }

  async function getSnapshots(options = {}) {
    const ranged = options.from !== undefined || options.to !== undefined, requested = ranged ? period(options) : null, result = [];
    const paths = (await buyerNames('order-segments')).filter(path => {
      const match = BUYER.exec(path);
      return match[4] === undefined && (!requested || match[2] <= requested.to && match[3] >= requested.from);
    }).sort();
    for (const path of paths) { const row = await read(path); if (row) result.push(clone(row.value)); }
    return result;
  }

  return Object.freeze({exact, getMarketSnapshot, getReportCatalog, getProducts, getCatalog, getAllProducts, getOzonFunnel, getOzonLedger, getWbFinance, getCatalogs, getInsights, getWbOrders, getBuyerOrderSnapshot, getBuyerProductSnapshot, getBuyerOrderSnapshots, getSnapshots});
}

module.exports = {createLiveSourceProviders, LiveSourceProviderError};
