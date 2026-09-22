'use strict';
const loadCostsDefault = require('../../costs.cjs');
const { loadWbPrices: loadWbPricesDefault } = require('../../pricing.cjs');
const { createJsonDocumentRepository } = require('../postgres-json-repository.cjs');
const { sourceKey } = require('../postgres-document-import.cjs');
class CostsPricesError extends Error { constructor(code, message) { super(message); this.name = 'CostsPricesError'; this.code = code; } }
const safeCodes = new Set(['REVISION_CONFLICT', 'COMMAND_ID_REUSED', 'SERIALIZATION_RETRY', 'OUTCOME_UNKNOWN', 'DATABASE_ERROR']);
function createCostsPricesAcquisition({ stateStore, storesRepository, decrypt, ozonApi, fetchFn, loadCosts = loadCostsDefault, loadWbPrices = loadWbPricesDefault, repositoryFactory = createJsonDocumentRepository } = {}) {
  if (!stateStore || !storesRepository?.protectedStore || typeof decrypt !== 'function' || typeof ozonApi !== 'function' || typeof fetchFn !== 'function') throw new TypeError('Complete costs/prices dependencies are required');
  const repository = sourcePath => repositoryFactory({ stateStore, logicalKey: sourceKey(sourcePath), sourcePath, validate: value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.importedAt === 'string' && Array.isArray(value.items) });
  async function refresh({ storeId, expectedRevision, commandId } = {}) {
    if (typeof storeId !== 'string' || !/^(?:wb-)?[0-9]+$/u.test(storeId)) throw new CostsPricesError('INVALID_ARGUMENT', 'Store is invalid');
    const sourcePath = `${storeId.startsWith('wb-') ? 'prices' : 'costs'}-${storeId}.json`, repo = repository(sourcePath);
    const prior = await repo.readCommand(commandId); if (prior) { if (prior.before.revision !== String(expectedRevision)) throw new CostsPricesError('COMMAND_ID_REUSED', 'Acquisition command revision differs'); return { revision: prior.after.revision, replayed: true, sourcePath, count: prior.after.value.items.length }; }
    const store = await storesRepository.protectedStore(storeId); if (!store) throw new CostsPricesError('STORE_MISSING', 'Store is not connected');
    let key;
    try { key = await decrypt(store.key); if (typeof key !== 'string' || !key) throw Error('credential'); const value = storeId.startsWith('wb-') ? await loadWbPrices(key, (url, options) => fetchFn(url, { ...options, redirect: 'error' })) : await loadCosts({ ...store, clientId: storeId }, key, ozonApi); const result = await repo.compareAndSet(value, { expectedRevision, commandId }); return { ...result, sourcePath, count: value.items.length }; }
    catch (error) { if (safeCodes.has(error?.code)) throw error; throw new CostsPricesError('ACQUISITION_FAILED', 'Costs/prices acquisition failed'); }
    finally { key = null; }
  }
  return Object.freeze({ refresh });
}
module.exports = { createCostsPricesAcquisition, CostsPricesError };
