'use strict';
const { build } = require('../../category-sales.cjs');
module.exports = function createPostgresCategorySales({ getStores, getProducts, getCategories, getOzonLedger, getWbFinance } = {}) {
  if ([getStores, getProducts, getCategories, getOzonLedger, getWbFinance].some(value => typeof value !== 'function')) throw new TypeError('explicit SQL providers are required');
  async function read(options = {}) {
    const [stores, products, categories] = await Promise.all([getStores(), getProducts(), getCategories()]);
    if (!Array.isArray(stores) || !Array.isArray(products) || !Array.isArray(categories)) throw Error('Invalid category sales SQL provider contract');
    const rows = await Promise.all(stores.map(async store => {
      if (!store || typeof store.id !== 'string' || !['Ozon', 'WB'].includes(store.market)) throw Error('Invalid store provider row');
      const scoped = products.filter(product => product?.storeId === store.id);
      return store.market === 'WB' ? { ...store, products: scoped, ledger: null, finance: await getWbFinance(store.id) } : { ...store, products: scoped, ledger: await getOzonLedger(store.id), finance: null };
    }));
    return build(rows, categories, options);
  }
  return Object.freeze({ read });
};
