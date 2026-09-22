'use strict';

// Project pinned native records into the existing normalized history tables.
// The history ingester persists day coverage, product facts and order events;
// this path creates neither archive objects nor full-document command images.
const { encodeJson } = require('./postgres-json-repository.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function selection(sourcePath) {
  if (/^insights-[0-9]+\.json$/u.test(sourcePath)) return ['orders.skuDaily', 'orders.skuCoverage'];
  if (/^ledger-[0-9]+\.json$/u.test(sourcePath)) return ['data.skuDaily'];
  if (/^wb-orders-wb-[0-9]+\.json$/u.test(sourcePath)) return ['orders'];
  if (/^order-category-catalog-(?:wb-)?[0-9]+\.json$/u.test(sourcePath)) return ['products'];
  return null;
}
function prepare({ payload, timestamp, commandId } = {}) {
  if (!payload || payload.mode !== 'live' || !Array.isArray(payload.intraday) || !Array.isArray(payload.category?.stores) || !Array.isArray(payload.category?.evidence) ||
      typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)) || !UUID.test(commandId || '')) fail('INVALID_HISTORY_CAPTURE');
  const references = [];
  for (const row of [...payload.intraday, ...payload.category.stores]) {
    if (!row || !Array.isArray(row.sources)) fail('INVALID_HISTORY_CAPTURE');
    references.push(...row.sources);
  }
  references.push(...payload.category.evidence);
  // Only the small evidence list is detached. No source document is serialized.
  let detached;
  try { detached = JSON.parse(encodeJson(references, 1024 * 1024).toString('utf8')); } catch { fail('INVALID_HISTORY_CAPTURE'); }
  const unique = new Map();
  for (const ref of detached) {
    if (!ref || typeof ref.sourcePath !== 'string' || typeof ref.revision !== 'string' || !/^[1-9][0-9]*$/u.test(ref.revision) || !Number.isSafeInteger(Number(ref.revision)) || !HASH.test(ref.sha256 || '')) fail('INVALID_HISTORY_CAPTURE');
    const previous = unique.get(ref.sourcePath);
    if (previous && (previous.revision !== ref.revision || previous.sha256 !== ref.sha256)) fail('CONFLICTING_HISTORY_EVIDENCE');
    unique.set(ref.sourcePath, Object.freeze({ sourcePath: ref.sourcePath, revision: ref.revision, sha256: ref.sha256 }));
  }
  return { commandId: commandId.toLowerCase(), timestamp, refs: [...unique.values()].filter(ref => selection(ref.sourcePath)).sort((a, b) => a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0) };
}

function createLiveHistoryCapture({ sources, historyFacts } = {}) {
  if (typeof sources?.record !== 'function' || typeof historyFacts?.ingest !== 'function') throw new TypeError('Native sources and normalized history ingester are required');
  async function capture(input) {
    const request = prepare(input), results = [];
    let ingested = 0, duplicates = 0, snapshotCount = 0, factCount = 0;
    for (const ref of request.refs) {
      const record = await sources.record(ref.sourcePath, { revision: ref.revision, entities: selection(ref.sourcePath) });
      if (!record || record.deleted || String(record.revision) !== ref.revision || record.head?.sourceMetadata?.sourcePath !== ref.sourcePath || record.head.sourceMetadata.sourceSha256 !== ref.sha256) fail('HISTORY_SOURCE_CHANGED');
      let result;
      try {
        // The composite source/hash identity is already durable and idempotent in
        // pult_history.ingestions. Retrying after a partial job uses the same key.
        result = await historyFacts.ingest({ sourceFile: ref.sourcePath, contentHash: ref.sha256, capturedAt: request.timestamp, data: record.value });
      } catch (error) {
        if (['DATABASE_ERROR', 'OUTCOME_UNKNOWN'].includes(error?.code)) throw error;
        fail('HISTORY_CAPTURE_FAILED');
      }
      if (!result || typeof result.duplicate !== 'boolean') fail('HISTORY_CAPTURE_FAILED');
      if (result.duplicate) duplicates++;
      else {
        ingested++;
        for (const key of ['snapshotCount', 'factCount']) if (!Number.isSafeInteger(result[key]) || result[key] < 0) fail('HISTORY_CAPTURE_FAILED');
        snapshotCount += result.snapshotCount; factCount += result.factCount;
      }
      results.push({ sourcePath: ref.sourcePath, revision: ref.revision, duplicate: result.duplicate });
    }
    return { commandId: request.commandId, sourceCount: results.length, ingested, duplicates, snapshotCount, factCount, sources: results };
  }
  return Object.freeze({ capture });
}

module.exports = { createLiveHistoryCapture };
