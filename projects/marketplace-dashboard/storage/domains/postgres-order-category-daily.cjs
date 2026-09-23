'use strict';
const { build, moscowDay } = require('../../order-category-daily.cjs');
const { validate: validateRegistry } = require('../../product-type-registry.cjs');
module.exports = function createPostgresOrderCategoryDaily({ productTypes, getCatalogs, getSnapshots, getInsights, getWbOrders, getStores = async () => ({}), categoryRevision, now = () => Date.now() } = {}) {
  if (typeof productTypes?.read !== 'function' || [getCatalogs, getSnapshots, getInsights, getWbOrders, getStores].some(value => typeof value !== 'function')) throw new TypeError('explicit SQL providers are required');
  if (categoryRevision !== undefined && typeof categoryRevision !== 'function') throw new TypeError('category revision provider must be a function');
  const pending = new Map(), completed = new Map();
  const checkedRevision = value => typeof value === 'string' && value.length > 0 && value.length <= 1000000 ? value : (() => { throw Error('Invalid category revision provider contract'); })();
  const checkedStores = stores => stores && typeof stores === 'object' && !Array.isArray(stores) ? stores : (() => { throw Error('Invalid category SQL provider contract'); })();
  const storeRevision = stores => JSON.stringify(Object.entries(stores).sort(([left], [right]) => left.localeCompare(right)).map(([id, store]) => [id, typeof store?.name === 'string' ? store.name : null, store?.market === 'WB' ? 'WB' : 'Ozon']));
  const requestOptions = (options, effectiveNow) => ({ from: options.from, to: options.to, market: options.market || 'all', store: options.store || options.storeId || null, today: moscowDay(effectiveNow), classifiedAt: options.classifiedAt || null });
  async function buildReport(options, prepared) {
    const loaded = await Promise.all([getCatalogs(), getSnapshots({ from: options.from, to: options.to }), getInsights(), getWbOrders(), ...(prepared ? [] : [productTypes.read(), getStores()])]);
    const [catalogsRaw, snapshots, insightsRaw, wbRaw] = loaded, {registry, stores} = prepared || {registry: loaded[4], stores: loaded[5]};
    if (!Array.isArray(catalogsRaw) || !Array.isArray(snapshots) || !Array.isArray(insightsRaw) || !Array.isArray(wbRaw) || !stores || typeof stores !== 'object') throw Error('Invalid category SQL provider contract');
    const catalogs = catalogsRaw.map(item => ({ ...item, name: typeof stores[item.storeId]?.name === 'string' ? stores[item.storeId].name : item.name || null }));
    const entries = (rows, label) => Object.fromEntries(rows.map(row => { if (!row || typeof row.storeId !== 'string' || !Object.hasOwn(row, 'value')) throw Error(`Invalid ${label} provider row`); return [row.storeId, row.value]; }));
    return build({ registry, catalogs, snapshots, insights: entries(insightsRaw, 'insights'), wbOrders: entries(wbRaw, 'WB orders') }, { ...options, now: options.now || now() });
  }
  async function cachedReport(options, effectiveNow) {
    if (!categoryRevision) return buildReport({...options, now: effectiveNow});
    const [sourceRevision, registryRaw, storesRaw] = await Promise.all([categoryRevision(options), productTypes.read(), getStores()]);
    const registry = validateRegistry(registryRaw), stores = checkedStores(storesRaw), cacheKey = JSON.stringify([checkedRevision(sourceRevision), JSON.stringify(registry), storeRevision(stores), requestOptions(options, effectiveNow)]);
    if (completed.has(cacheKey)) { const value = completed.get(cacheKey); completed.delete(cacheKey); completed.set(cacheKey, value); return value; }
    const report = await buildReport({...options, now: effectiveNow}, {registry, stores}), finalRevision = checkedRevision(await categoryRevision(options));
    if (finalRevision === sourceRevision) { if (completed.size >= 4) completed.delete(completed.keys().next().value); completed.set(cacheKey, report); }
    return report;
  }
  function read(options = {}) {
    const effectiveNow = options.now || now(), key = JSON.stringify(requestOptions(options, effectiveNow));
    if (pending.has(key)) return pending.get(key).then(value => structuredClone(value));
    const request = cachedReport(options, effectiveNow).finally(() => { if (pending.get(key) === request) pending.delete(key); });
    pending.set(key, request);
    return request.then(value => structuredClone(value));
  }
  return Object.freeze({ read });
};
