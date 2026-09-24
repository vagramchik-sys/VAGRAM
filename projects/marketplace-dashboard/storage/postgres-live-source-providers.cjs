'use strict';

const codecs = require('./postgres-live-codecs.cjs');

class LiveSourceProviderError extends Error {
  constructor(code, message) { super(message); this.name = 'LiveSourceProviderError'; this.code = code; }
}

const fail = (code, message) => { throw new LiveSourceProviderError(code, message); };
const STORE = /^(?:wb-)?[0-9]+$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const BUYER = /^buyer-(order-segments|product-segments)-(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})(?:-retry-(\d+))?(\.partial)?\.json$/u;
const MAX_SNAPSHOT_CACHE_ROWS = 500000;
const MAX_SNAPSHOT_CACHE_ENTRIES = 8;
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
  const inFlight = new Map(), bulkWaiters = [], snapshotCache = new Map();
  let bulkActive = 0;
  let snapshotCacheRows = 0;
  function freezeSnapshot(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freezeSnapshot(child);
      Object.freeze(value);
    }
    return value;
  }
  function cacheSnapshot(sourcePath, row) {
    const revision = String(row.revision ?? '');
    if (!/^(?:0|[1-9][0-9]*)$/u.test(revision)) fail('CORRUPT_SOURCE', 'Live buyer source revision is invalid');
    const value = row.value;
    const cost = (Array.isArray(value.records) ? value.records.length : 0) +
      (Array.isArray(value.productOrders) ? value.productOrders.length : 0);
    if (cost > MAX_SNAPSHOT_CACHE_ROWS) return value;
    const previous = snapshotCache.get(sourcePath);
    if (previous) { snapshotCacheRows -= previous.cost; snapshotCache.delete(sourcePath); }
    const immutable = freezeSnapshot(value);
    snapshotCache.set(sourcePath, {revision, value: immutable, cost});
    snapshotCacheRows += cost;
    while (snapshotCache.size > MAX_SNAPSHOT_CACHE_ENTRIES || snapshotCacheRows > MAX_SNAPSHOT_CACHE_ROWS) {
      const oldest = snapshotCache.keys().next().value, removed = snapshotCache.get(oldest);
      snapshotCacheRows -= removed.cost;
      snapshotCache.delete(oldest);
    }
    return immutable;
  }
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

  async function acquireBulkRead() {
    if (bulkActive < 4) { bulkActive++; return; }
    await new Promise(resolve => bulkWaiters.push(resolve));
  }
  function releaseBulkRead() {
    const next = bulkWaiters.shift();
    if (next) next();
    else bulkActive--;
  }

  async function readMany(paths, entities, reader = read) {
    const rows = new Array(paths.length);
    let next = 0;
    async function worker() {
      while (next < paths.length) {
        const index = next++;
        await acquireBulkRead();
        try { rows[index] = await reader(paths[index], entities); }
        finally { releaseBulkRead(); }
      }
    }
    await Promise.all(Array.from({length: Math.min(4, paths.length)}, worker));
    return rows;
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
    const result = [], rows = await readMany(selected, entities);
    for (let index = 0; index < selected.length; index++) {
      const sourcePath = selected[index], row = rows[index];
      if (row) result.push(map(sourcePath, clone(row.value)));
    }
    return result;
  }
  const getCatalogs = () => listed('order-category-catalog-', /^order-category-catalog-(?:wb-)?[0-9]+\.json$/u, ['products'], (path, value) => {
    const storeId = path.slice(23, -5);
    if (!Array.isArray(value.products)) fail('CORRUPT_SOURCE', 'Order category catalog shape is invalid');
    return {...value, storeId, market: storeId.startsWith('wb-') ? 'WB' : 'Ozon'};
  });
  // Shared by category charts and financial reports: omitting daily rows would
  // synthesize zero sales, and omitting types would invalidate the ledger hash.
  const getInsights = () => listed('insights-', /^insights-[0-9]+\.json$/u, ['orders.daily', 'orders.skuDaily', 'orders.skuCoverage', 'types', 'errors'], (path, value) => ({storeId: path.slice(9, -5), value}));
  const getOrderInsights = () => listed('insights-', /^insights-[0-9]+\.json$/u, ['orders.daily', 'errors'], (path, value) => ({storeId: path.slice(9, -5), value}));
  const getCategoryInsights = () => listed('insights-', /^insights-[0-9]+\.json$/u, ['orders.skuDaily', 'orders.skuCoverage'], (path, value) => ({storeId: path.slice(9, -5), value}));
  const getWbOrders = () => listed('wb-orders-', /^wb-orders-wb-[0-9]+\.json$/u, ['points', 'orders'], (path, value) => ({storeId: path.slice(10, -5), value}));
  async function getOrderCategoryState(targetDay) {
    if (!validDay(targetDay)) fail('INVALID_PERIOD', 'Category state day is invalid');
    const sourcePath = 'order-category-intraday.json', entry = (await names()).find(row => row.sourcePath === sourcePath);
    if (!entry) return {version: 1, points: []};
    const revision = String(entry.head?.revision ?? '');
    if (!/^(?:0|[1-9][0-9]*)$/u.test(revision)) fail('CORRUPT_SOURCE', 'Live category state revision is invalid');
    if (typeof sources.repository?.listRows !== 'function') {
      const row = await read(sourcePath, ['points']), value = row?.value;
      if (!value || ![1, 2].includes(value.version) || !Array.isArray(value.points)) fail('CORRUPT_SOURCE', 'Live category state is invalid');
      return {version: value.version, points: clone(value.points.filter(point => point?.date === targetDay))};
    }
    let metadata;
    try { metadata = codecs.decodeMetadata(sourcePath, entry.head.metadata); } catch { fail('CORRUPT_SOURCE', 'Live category state metadata is invalid'); }
    if (![1, 2].includes(metadata?.version)) fail('CORRUPT_SOURCE', 'Live category state metadata is invalid');
    const identity = sources.identity(sourcePath), points = [];
    for (let offset = 0; ; offset += 10000) {
      let page;
      try { page = await sources.repository.listRows({...identity, entityType: 'points', fromDay: targetDay, toDay: targetDay, expectedRevision: Number(revision), limit: 10000, offset, includeTotal: true}); }
      catch { fail('DATABASE_ERROR', 'Live category state is unavailable'); }
      if (!page || !Array.isArray(page.rows) || !Number.isSafeInteger(page.total) || page.total < 0) fail('CORRUPT_SOURCE', 'Live category state rows are invalid');
      for (const row of page.rows) {
        if (row.entityType !== 'points' || row.businessDay !== targetDay || !row.value || typeof row.value !== 'object' || Array.isArray(row.value)) fail('CORRUPT_SOURCE', 'Live category state rows are invalid');
        points.push(clone(row.value));
      }
      if (points.length >= page.total) break;
      if (!page.rows.length || points.length > page.total) fail('CORRUPT_SOURCE', 'Live category state rows are incomplete');
    }
    return {version: metadata.version, points};
  }

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
    const {from, to} = period(options), latest = new Map(), partials = [];
    const entries = await names();
    for (const entry of entries) {
      const sourcePath = entry.sourcePath;
      const match = BUYER.exec(sourcePath);
      if (!match || match[1] !== 'order-segments' || match[2] > to || match[3] < from) continue;
      if (match[5]) { if (options.includePartial === true) partials.push(entry); continue; }
      const key = match[2] + '_' + match[3], retry = Number(match[4] || 0), previous = latest.get(key);
      if (!previous || retry > previous.retry || retry === previous.retry && sourcePath.localeCompare(previous.sourcePath) > 0) latest.set(key, {...entry, retry});
    }
    const selected = [...latest.values(), ...partials].sort((a,b) => a.sourcePath.localeCompare(b.sourcePath));
    const values = await readMany(selected, undefined, cachedBuyerRows);
    return values.flatMap((value,index) => value ? [BUYER.exec(selected[index].sourcePath)[5] ? Object.freeze({...value, _partialSource:true}) : value] : []);
  }

  async function cachedBuyerRows(entry) {
    const revision = String(entry.head?.revision ?? '');
    if (!/^(?:0|[1-9][0-9]*)$/u.test(revision)) fail('CORRUPT_SOURCE', 'Live buyer source revision is invalid');
    const cached = snapshotCache.get(entry.sourcePath);
    if (cached?.revision === revision) {
      snapshotCache.delete(entry.sourcePath); snapshotCache.set(entry.sourcePath, cached);
      return cached.value;
    }
    const row = await read(entry.sourcePath, ['records', 'productOrders', 'report.coverage.sources']);
    return row ? cacheSnapshot(entry.sourcePath, row) : null;
  }

  async function getSnapshots(options = {}) {
    const ranged = options.from !== undefined || options.to !== undefined, requested = ranged ? period(options) : null, result = [];
    const selected = (await names()).filter(row => {
      const match = BUYER.exec(row.sourcePath);
      return match && match[1] === 'order-segments' && match[4] === undefined && (!requested || match[2] <= requested.to && match[3] >= requested.from);
    }).sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
    const rows = await readMany(selected, undefined, cachedBuyerRows);
    for (const value of rows) if (value) result.push(value);
    return result;
  }

  async function categoryRevision(options = {}) {
    const {from, to} = period(options), today = options.today == null ? null : validDay(options.today) ? options.today : fail('INVALID_PERIOD', 'Category current day is invalid'), includesToday = today === null || from <= today && to >= today, selectedStore = options.store || options.storeId || null, selectedMarket = options.market === 'Ozon' || options.market === 'WB' ? options.market : 'all', selected = [];
    for (const row of await names()) {
      const sourcePath = row.sourcePath, buyer = BUYER.exec(sourcePath);
      let storeId = null, market = null, relevant = false;
      if (/^order-category-catalog-(?:wb-)?[0-9]+\.json$/u.test(sourcePath)) { storeId = sourcePath.slice(23, -5); market = storeId.startsWith('wb-') ? 'WB' : 'Ozon'; relevant = true; }
      else if (includesToday && /^insights-[0-9]+\.json$/u.test(sourcePath)) { storeId = sourcePath.slice(9, -5); market = 'Ozon'; relevant = true; }
      else if (includesToday && /^wb-orders-wb-[0-9]+\.json$/u.test(sourcePath)) { storeId = sourcePath.slice(10, -5); market = 'WB'; relevant = true; }
      else if (buyer && buyer[1] === 'order-segments' && buyer[4] === undefined && buyer[2] <= to && buyer[3] >= from) relevant = true;
      if (!relevant || storeId !== null && (selectedStore && storeId !== String(selectedStore) || selectedMarket !== 'all' && market !== selectedMarket)) continue;
      const revision = String(row.head?.revision ?? '');
      if (!/^(?:0|[1-9][0-9]*)$/u.test(revision)) fail('CORRUPT_SOURCE', 'Live category source revision is invalid');
      selected.push([sourcePath, revision]);
    }
    selected.sort(([left], [right]) => left.localeCompare(right));
    for (let index = 1; index < selected.length; index++) if (selected[index - 1][0] === selected[index][0]) fail('CORRUPT_SOURCE', 'Live category source revision is ambiguous');
    return JSON.stringify(selected);
  }

  return Object.freeze({exact, getMarketSnapshot, getReportCatalog, getProducts, getCatalog, getAllProducts, getOzonFunnel, getOzonLedger, getWbFinance, getCatalogs, getInsights, getOrderInsights, getCategoryInsights, getWbOrders, getOrderCategoryState, getBuyerOrderSnapshot, getBuyerProductSnapshot, getBuyerOrderSnapshots, getSnapshots, categoryRevision});
}

module.exports = {createLiveSourceProviders, LiveSourceProviderError};
