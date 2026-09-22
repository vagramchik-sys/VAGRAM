'use strict';

const { createJsonDocumentRepository } = require('../postgres-json-repository.cjs');
const { sourceKey } = require('../postgres-document-import.cjs');

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
function validStores(value) {
  return object(value) && Object.entries(value).every(([id, store]) => /^(?:wb-)?\d+$/u.test(id) && object(store) &&
    typeof store.name === 'string' && store.name.length > 0 && store.name.length <= 160 && String(store.clientId) === id &&
    typeof store.key === 'string' && store.key.length > 0 && store.key.length <= 65536 &&
    typeof store.connectedAt === 'string' && Number.isFinite(Date.parse(store.connectedAt)) &&
    (store.market === undefined || ['Ozon', 'WB'].includes(store.market)) &&
    (store.updatedAt === undefined || typeof store.updatedAt === 'string' && Number.isFinite(Date.parse(store.updatedAt))) &&
    (store.syncAttemptAt === undefined || typeof store.syncAttemptAt === 'string' && Number.isFinite(Date.parse(store.syncAttemptAt))));
}
function createPostgresStores({ stateStore } = {}) {
  const repository = createJsonDocumentRepository({ stateStore, logicalKey: sourceKey('stores.json'), sourcePath: 'stores.json', validate: validStores });
  async function record() { const row = await repository.read(); return row && !row.deleted ? row : null; }
  async function read() { return structuredClone((await record())?.value || {}); }
  async function protectedStore(id) { const stores = await read(); return Object.hasOwn(stores, id) ? stores[id] : null; }
  async function compareAndSet(stores, options) { return repository.compareAndSet(stores, options); }
  async function readCommand(commandId) { return repository.readCommand(commandId); }
  return Object.freeze({ read, record, protectedStore, compareAndSet, readCommand });
}

module.exports = createPostgresStores;
module.exports.createPostgresStores = createPostgresStores;
