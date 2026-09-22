'use strict';
const { build } = require('../../order-category-daily.cjs');
module.exports = function createPostgresOrderCategoryDaily({ productTypes, getCatalogs, getSnapshots, getInsights, getWbOrders, getStores = async () => ({}), now = () => Date.now() } = {}) {
  if (typeof productTypes?.read !== 'function' || [getCatalogs, getSnapshots, getInsights, getWbOrders, getStores].some(value => typeof value !== 'function')) throw new TypeError('explicit SQL providers are required');
  async function read(options = {}) {
    const [registry, catalogsRaw, snapshots, insightsRaw, wbRaw, stores] = await Promise.all([productTypes.read(), getCatalogs(), getSnapshots(), getInsights(), getWbOrders(), getStores()]);
    if (!Array.isArray(catalogsRaw) || !Array.isArray(snapshots) || !Array.isArray(insightsRaw) || !Array.isArray(wbRaw) || !stores || typeof stores !== 'object') throw Error('Invalid category SQL provider contract');
    const catalogs = catalogsRaw.map(item => ({ ...item, name: typeof stores[item.storeId]?.name === 'string' ? stores[item.storeId].name : item.name || null }));
    const entries = (rows, label) => Object.fromEntries(rows.map(row => { if (!row || typeof row.storeId !== 'string' || !Object.hasOwn(row, 'value')) throw Error(`Invalid ${label} provider row`); return [row.storeId, row.value]; }));
    return build({ registry, catalogs, snapshots, insights: entries(insightsRaw, 'insights'), wbOrders: entries(wbRaw, 'WB orders') }, { ...options, now: options.now || now() });
  }
  return Object.freeze({ read });
};
