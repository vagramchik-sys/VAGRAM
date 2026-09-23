'use strict';
const { build } = require('../../category-sales.cjs');
function ledgerData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.hasOwn(value, 'data')) return value.data && typeof value.data === 'object' && !Array.isArray(value.data) && value.data.version === 3 ? value.data : null;
  return value.version === 3 ? value : null;
}
module.exports = function createPostgresCategorySales({ getStores, getProducts, getCategories, getOzonLedger, getWbFinance, productTypes } = {}) {
  if ([getStores, getProducts, getCategories, getOzonLedger, getWbFinance].some(value => typeof value !== 'function')) throw new TypeError('explicit SQL providers are required');
  async function read(options = {}) {
    const [stores, products, categories, registry] = await Promise.all([getStores(), getProducts(), getCategories(), typeof productTypes?.read === 'function' ? productTypes.read() : null]);
    if (!Array.isArray(stores) || !Array.isArray(products) || !Array.isArray(categories)) throw Error('Invalid category sales SQL provider contract');
    const rows = await Promise.all(stores.map(async store => {
      if (!store || typeof store.id !== 'string' || !['Ozon', 'WB'].includes(store.market)) throw Error('Invalid store provider row');
      const scoped = products.filter(product => product?.storeId === store.id);
      return store.market === 'WB' ? { ...store, products: scoped, ledger: null, finance: await getWbFinance(store.id) } : { ...store, products: scoped, ledger: ledgerData(await getOzonLedger(store.id)), finance: null };
    }));
    return build(rows, categories, { ...options, productTypes: registry });
  }
  return Object.freeze({ read });
};
