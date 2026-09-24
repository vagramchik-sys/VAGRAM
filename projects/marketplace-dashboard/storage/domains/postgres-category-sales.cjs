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
    const catalogRead = Promise.all([getProducts(), getCategories(), typeof productTypes?.read === 'function' ? productTypes.read() : null]);
    // Store validation can finish first; keep an early catalog failure handled
    // until the validated request joins both read branches below.
    catalogRead.catch(() => {});
    const stores = await getStores();
    if (!Array.isArray(stores)) throw Error('Invalid category sales SQL provider contract');
    for (const store of stores) if (!store || typeof store.id !== 'string' || !['Ozon', 'WB'].includes(store.market)) throw Error('Invalid store provider row');
    const selected = stores.filter(store => (!options.store || store.id === options.store) && (!options.market || options.market === 'all' || store.market === options.market));
    const factsRead = Promise.all(selected.map(async store => [store.id, await (store.market === 'WB' ? getWbFinance(store.id) : getOzonLedger(store.id))]));
    const [[products, categories, registry], factRows] = await Promise.all([catalogRead, factsRead]);
    if (!Array.isArray(products) || !Array.isArray(categories)) throw Error('Invalid category sales SQL provider contract');
    const productsByStore = new Map();
    for (const product of products) if (product && typeof product.storeId === 'string') {
      const scoped = productsByStore.get(product.storeId);
      if (scoped) scoped.push(product); else productsByStore.set(product.storeId, [product]);
    }
    const facts = new Map(factRows);
    const rows = stores.map(store => {
      const scoped = productsByStore.get(store.id) || [], value = facts.get(store.id);
      return store.market === 'WB' ? { ...store, products: scoped, ledger: null, finance: value || null } : { ...store, products: scoped, ledger: ledgerData(value), finance: null };
    });
    return build(rows, categories, { ...options, productTypes: registry });
  }
  return Object.freeze({ read });
};
