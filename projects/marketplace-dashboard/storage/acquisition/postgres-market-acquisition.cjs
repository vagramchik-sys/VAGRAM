'use strict';

class MarketAcquisitionError extends Error { constructor(code, message) { super(message); this.name = 'MarketAcquisitionError'; this.code = code; } }
const SAFE_CODES = new Set(['NETWORK_ERROR', 'RATE_LIMITED', 'AUTH_FAILED', 'HTTP_ERROR', 'INVALID_RESPONSE', 'PAGINATION_FAILED', 'SECTION_FAILED', 'REVISION_CONFLICT', 'COMMAND_ID_REUSED', 'SERIALIZATION_RETRY', 'OUTCOME_UNKNOWN', 'DATABASE_ERROR', 'PROJECTION_CONFLICT', 'VERIFY_FAILED']);
function sanitized(error) {
  if (error instanceof MarketAcquisitionError) return error;
  const code = SAFE_CODES.has(error?.code) ? error.code : 'ACQUISITION_FAILED';
  const message = code === 'OUTCOME_UNKNOWN' || code === 'SERIALIZATION_RETRY' ? 'Retry only with the same commandId and request' : code === 'REVISION_CONFLICT' || code === 'COMMAND_ID_REUSED' ? 'Acquisition command conflict' : 'Marketplace acquisition failed';
  return new MarketAcquisitionError(code, message);
}
function createMarketAcquisition({ storesRepository, marketRepository, marketWriter, ozonCollector, wbCollector, decrypt } = {}) {
  if (!storesRepository || typeof storesRepository.protectedStore !== 'function' || !marketRepository || typeof marketRepository.getSnapshot !== 'function' || !marketWriter || typeof marketWriter.publish !== 'function' || typeof marketWriter.readCommand !== 'function' || !ozonCollector?.collect || !wbCollector?.collect || typeof decrypt !== 'function') throw new TypeError('Complete acquisition dependencies are required');
  async function acquire({ storeId, expectedRevision, commandId, onProgress } = {}) {
    if (typeof storeId !== 'string' || !/^(?:wb-)?[0-9]+$/u.test(storeId) || typeof onProgress !== 'undefined' && typeof onProgress !== 'function') throw new MarketAcquisitionError('INVALID_ARGUMENT', 'Acquisition arguments are invalid');
    const committed = await marketWriter.readCommand({ storeId, commandId });
    if (committed) { if (committed.beforeRevision !== String(expectedRevision)) throw new MarketAcquisitionError('COMMAND_ID_REUSED', 'Acquisition command revision differs'); let snapshot; try { snapshot = JSON.parse(committed.exactBytes.toString('utf8')); } catch { throw new MarketAcquisitionError('DATABASE_ERROR', 'Committed acquisition payload is invalid'); } return { revision: committed.revision, replayed: true, snapshotId: committed.snapshotId, status: Object.values(snapshot.sections || {}).some(value => value?.ok === false) ? 'partial' : 'done', errors: [], completedAt: snapshot.completedAt }; }
    const store = await storesRepository.protectedStore(storeId); if (!store) throw new MarketAcquisitionError('STORE_MISSING', 'Store is not connected');
    let key;
    try {
      try { key = await decrypt(store.key); } catch { throw new MarketAcquisitionError('CREDENTIAL_UNAVAILABLE', 'Protected store credential is unavailable'); }
      if (typeof key !== 'string' || !key) throw new MarketAcquisitionError('CREDENTIAL_UNAVAILABLE', 'Protected store credential is unavailable');
      const collector = storeId.startsWith('wb-') ? wbCollector : ozonCollector;
      const previousSnapshot = storeId.startsWith('wb-') ? null : await marketRepository.getSnapshot(storeId);
      const collected = await collector.collect({ store: { name: store.name, market: store.market, clientId: storeId }, key, previousSnapshot, onProgress });
      const exactBytes = Buffer.from(JSON.stringify(collected.snapshot), 'utf8');
      const published = await marketWriter.publish({ storeId, exactBytes, expectedRevision, commandId });
      return { ...published, status: collected.status, errors: collected.errors.slice(), completedAt: collected.snapshot.completedAt };
    } catch (error) {
      throw sanitized(error);
    } finally { key = null; }
  }
  return Object.freeze({ acquire });
}
module.exports = { createMarketAcquisition, MarketAcquisitionError };
