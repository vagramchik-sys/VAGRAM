'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { sourceKey } = require('../postgres-document-import.cjs');
const { summarize } = require('../../summary.cjs');
const { buildLedger } = require('../../ledger.cjs');
const dashboard = require('../../dist/dashboard-model.js');

class PostgresCoreError extends Error { constructor(code, message) { super(message); this.name = 'PostgresCoreError'; this.code = code; } }
const fail = (code, message) => { throw new PostgresCoreError(code, message); };
const STORE_ID = /^(?:wb-)?\d+$/u;
function createPostgresCore({ storesRepository, marketRepository, stateStore, jobsProvider = async () => new Map() } = {}) {
  if (!storesRepository || !['read', 'record', 'protectedStore'].every(name => typeof storesRepository[name] === 'function')) throw new TypeError('storesRepository is required');
  if (!marketRepository || typeof marketRepository.getSnapshot !== 'function') throw new TypeError('marketRepository is required');
  if (!stateStore || typeof stateStore.read !== 'function') throw new TypeError('stateStore is required');
  if (typeof jobsProvider !== 'function') throw new TypeError('jobsProvider must be a function');
  const idOf = value => { if (typeof value !== 'string' || !STORE_ID.test(value)) fail('INVALID_STORE', 'Некорректный магазин'); return value; };
  async function sourceJson(sourcePath) {
    const row = await stateStore.read(sourceKey(sourcePath), { includeDeleted: true });
    if (!row || row.deleted) return { value: null, revision: '0' };
    if (row.mediaType !== 'application/json' || !Buffer.isBuffer(row.content) || !Buffer.isBuffer(row.sha256) || row.sha256.length !== 32 || !crypto.createHash('sha256').update(row.content).digest().equals(row.sha256)) fail('DATA_INTEGRITY', 'SQL-документ не прошёл проверку целостности');
    let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(row.content)); } catch { fail('DATA_INTEGRITY', 'SQL-документ содержит некорректный JSON'); }
    return { value, revision: row.revision };
  }
  async function storeMap() { return storesRepository.read(); }
  async function publicStores() {
    const stores = await storeMap(), jobs = await jobsProvider();
    return Promise.all(Object.entries(stores).map(async ([id, store]) => {
      const [costs, prices] = await Promise.all([sourceJson(`costs-${id}.json`), sourceJson(`prices-${id}.json`)]);
      const job = jobs instanceof Map ? jobs.get(id) : jobs?.[id];
      return { id, name: store.name, clientId: store.clientId, connectedAt: store.connectedAt, job: job || null, updatedAt: store.updatedAt || null, revision: `${store.updatedAt || ''}:${costs.revision}:${prices.revision}` };
    }));
  }
  async function hasStore(id) { id = idOf(id); return Object.hasOwn(await storeMap(), id); }
  async function protectedStore(id) { return storesRepository.protectedStore(idOf(id)); }
  async function publicSnapshot(id) {
    id = idOf(id); if (!await hasStore(id)) return null;
    const [raw, costs, prices] = await Promise.all([marketRepository.getSnapshot(id), sourceJson(`costs-${id}.json`), sourceJson(`prices-${id}.json`)]);
    return raw ? summarize(raw, costs.value, prices.value) : null;
  }
  async function supplierProducts() {
    const stores = await publicStores(), snapshots = new Map(await Promise.all(stores.map(async store => [store.id, await publicSnapshot(store.id)])));
    return dashboard.rowsFor(stores, snapshots);
  }
  async function ledgerFor(id) {
    id = idOf(id); if (!await hasStore(id)) return null;
    const saved = await sourceJson(`ledger-${id}.json`);
    if (saved.value?.data?.version === 3) return saved.value.data;
    if (saved.value?.version === 3) return saved.value;
    const [raw, insights] = await Promise.all([marketRepository.getSnapshot(id), sourceJson(`insights-${id}.json`)]);
    return raw ? buildLedger(raw, insights.value?.types || []) : null;
  }
  async function financeStores() {
    const raw = await storeMap(), stores = await publicStores();
    return Promise.all(stores.filter(store => raw[store.id]?.market !== 'WB').map(async store => ({ ...store, ledger: await ledgerFor(store.id) })));
  }
  async function ready() {
    await storesRepository.read();
    return { ready: false, coreReady: true, missingAdapters: ['runtime-wiring'], passive: true };
  }
  return Object.freeze({ ready, publicStores, publicSnapshot, supplierProducts, ledgerFor, financeStores, hasStore, protectedStore, sourceJson });
}

module.exports = createPostgresCore;
module.exports.createPostgresCore = createPostgresCore;
module.exports.PostgresCoreError = PostgresCoreError;
