'use strict';

const crypto = require('node:crypto');
const { createJsonDocumentRepository } = require('../postgres-json-repository.cjs');
const { sourceKey } = require('../postgres-document-import.cjs');
const { validDay, validateCollected } = require('./postgres-buyer-orders-collector.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVISION = /^(?:0|[1-9][0-9]*)$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 320 * 1024 * 1024;

class BuyerSnapshotError extends Error {
  constructor(code, message) { super(message); this.name = 'BuyerSnapshotError'; this.code = code; }
}
const fail = (code, message) => { throw new BuyerSnapshotError(code, message); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
function stableUuid(value) {
  const bytes = crypto.createHash('sha256').update(`pult:buyer-snapshot:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function sourcePath(date) { return `buyer-order-segments-${date}_${date}.json`; }
function validTarget(value) {
  return object(value) && /^\d+$/u.test(value.storeId || '') && String(value.clientId) === value.storeId &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 160 && HASH.test(value.credentialHash || '');
}
function validDocument(value) {
  if (!object(value) || value.version !== 2 || !validDay(value.period?.from) || value.period?.to !== value.period.from ||
      value.scope !== 'all-ozon-stores' || !['pending', 'collected'].includes(value.status) ||
      typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)) || !Array.isArray(value.records) ||
      !Array.isArray(value.productOrders) || !object(value.report) || !Array.isArray(value.report?.coverage?.sources) || !Array.isArray(value.errors)) return false;
  if (value.status === 'pending') {
    const receipt = value._sqlAcquisition;
    return value.records.length === 0 && value.productOrders.length === 0 && object(receipt) && receipt.version === 1 &&
      receipt.date === value.period.from && receipt.timestamp === value.generatedAt && UUID.test(receipt.publishCommandId || '') &&
      Array.isArray(receipt.targets) && receipt.targets.length > 0 && receipt.targets.every((target, index) => validTarget(target) && (!index || receipt.targets[index - 1].storeId.localeCompare(target.storeId) < 0));
  }
  return !Object.hasOwn(value, '_sqlAcquisition') && value.errors.length === 0;
}
function publicResult(row, replayed) {
  return { revision: row.revision, replayed, status: 'collected', date: row.value.period.from, records: row.value.records.length, productOrders: row.value.productOrders.length, targets: row.value.report.coverage.sources.filter(source => source.scheme === 'FBO').map(source => source.storeId).sort() };
}

function createPostgresBuyerSnapshot({ stateStore, storesRepository, decrypt, collector, repositoryFactory = createJsonDocumentRepository, now = () => new Date() } = {}) {
  if (!stateStore || typeof storesRepository?.read !== 'function' || typeof decrypt !== 'function' || typeof collector?.collect !== 'function' || typeof repositoryFactory !== 'function' || typeof now !== 'function') throw new TypeError('Complete buyer snapshot dependencies are required');
  const repo = date => repositoryFactory({ stateStore, logicalKey: sourceKey(sourcePath(date)), sourcePath: sourcePath(date), validate: validDocument, maxBytes: MAX_BYTES });
  function metadata(input) {
    if (!object(input) || !validDay(input.date) || input.date > new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now()) ||
        !UUID.test(input.commandId || '') || typeof input.timestamp !== 'string' || !Number.isFinite(Date.parse(input.timestamp)) || !REVISION.test(input.expectedRevision || '')) fail('INVALID_ARGUMENT', 'Buyer snapshot command is invalid');
    return { date: input.date, commandId: input.commandId.toLowerCase(), timestamp: input.timestamp, expectedRevision: input.expectedRevision };
  }
  function verifyReceipt(command, op, publishCommandId) {
    const receipt = command?.after?.value?._sqlAcquisition;
    if (command.before.revision !== op.expectedRevision || command.after.value?.status !== 'pending' || command.after.value?.generatedAt !== op.timestamp ||
        !receipt || receipt.date !== op.date || receipt.timestamp !== op.timestamp || receipt.publishCommandId !== publishCommandId) fail('COMMAND_ID_REUSED', 'Buyer snapshot command intent differs');
    return { revision: command.after.revision, targets: structuredClone(receipt.targets) };
  }
  async function prepare(repository, op, publishCommandId) {
    const prior = await repository.readCommand(op.commandId);
    if (prior) return verifyReceipt(prior, op, publishCommandId);
    const current = await repository.read();
    if (current?.value?.status === 'collected' && current.value.report?.coverage?.complete === true) fail('COMPLETE_SOURCE_EXISTS', 'A complete buyer snapshot already exists for this day');
    const stores = await storesRepository.read(), targets = Object.entries(stores).filter(([id, store]) => store?.market !== 'WB' && !id.startsWith('wb-')).map(([id, store]) => {
      if (!/^\d+$/u.test(id) || String(store?.clientId) !== id || typeof store?.name !== 'string' || !store.name || typeof store?.key !== 'string' || !store.key) fail('SOURCE_INTEGRITY', 'Protected Ozon store registry is invalid');
      return { storeId: id, clientId: id, name: store.name, credentialHash: crypto.createHash('sha256').update(store.key, 'utf8').digest('hex') };
    }).sort((a, b) => a.storeId.localeCompare(b.storeId));
    if (!targets.length) fail('STORE_MISSING', 'No connected Ozon stores are available');
    const sources = targets.flatMap(target => ['FBO', 'FBS'].map(scheme => ({ market: 'Ozon', scheme, storeId: target.storeId, name: target.name, from: op.date, to: op.date, available: false, complete: false, fetchedAt: null, limitation: 'collection_pending' })));
    const pending = { version: 2, period: { from: op.date, to: op.date }, scope: 'all-ozon-stores', status: 'pending', generatedAt: op.timestamp, records: [], productOrders: [], report: { period: { from: op.date, to: op.date }, status: 'unavailable', coverage: { complete: false, sources } }, errors: [], _sqlAcquisition: { version: 1, date: op.date, timestamp: op.timestamp, publishCommandId, targets } };
    const result = await repository.compareAndSet(pending, { expectedRevision: op.expectedRevision, commandId: op.commandId });
    return { revision: result.revision, targets };
  }
  async function credentials(targets) {
    const stores = await storesRepository.read(), result = [];
    for (const target of targets) {
      const store = stores[target.storeId];
      if (!store || store.market === 'WB' || String(store.clientId) !== target.clientId || store.name !== target.name || typeof store.key !== 'string' || crypto.createHash('sha256').update(store.key, 'utf8').digest('hex') !== target.credentialHash) fail('SOURCE_CHANGED', 'Captured Ozon store credentials changed before collection');
      let key;
      try { key = await decrypt(store.key); } catch { fail('CREDENTIAL_UNAVAILABLE', 'Protected Ozon credential is unavailable'); }
      if (typeof key !== 'string' || !key) fail('CREDENTIAL_UNAVAILABLE', 'Protected Ozon credential is unavailable');
      result.push({ storeId: target.storeId, clientId: target.clientId, name: target.name, key });
    }
    return result;
  }
  async function run(input) {
    const op = metadata(structuredClone(input)), repository = repo(op.date), publishCommandId = stableUuid(`publish:${op.commandId}`), receipt = await prepare(repository, op, publishCommandId);
    const published = await repository.readCommand(publishCommandId);
    if (published) {
      if (published.before.revision !== receipt.revision || published.after.value?.generatedAt !== op.timestamp || !validateCollected(published.after.value, receipt.targets.map(target => target.storeId), now().valueOf())) fail('COMMAND_ID_REUSED', 'Buyer snapshot publish intent differs');
      return publicResult(published.after, true);
    }
    let targets;
    try {
      targets = await credentials(receipt.targets);
      const document = await collector.collect({ date: op.date, timestamp: op.timestamp, targets });
      validateCollected(document, receipt.targets.map(target => target.storeId), now().valueOf());
      const result = await repository.compareAndSet(document, { expectedRevision: receipt.revision, commandId: publishCommandId });
      return { revision: result.revision, replayed: result.replayed, status: 'collected', date: op.date, records: document.records.length, productOrders: document.productOrders.length, targets: receipt.targets.map(target => target.storeId) };
    } finally {
      if (targets) for (const target of targets) target.key = null;
    }
  }
  return Object.freeze({ run });
}

module.exports = { createPostgresBuyerSnapshot, BuyerSnapshotError, stableUuid, sourcePath, validDocument, MAX_BYTES };



