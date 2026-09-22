'use strict';

const crypto = require('node:crypto');
const {createLedgerBuilder, buildLedger, typesHash} = require('../../ledger.cjs');

const STORE = /^[0-9]+$/u, HASH = /^[a-f0-9]{64}$/u, LEGACY_STAMP = /^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,9})?:[a-f0-9]{64}$/u;
class LiveLedgerRefreshError extends Error {
  constructor(code, message) { super(message); this.name = 'LiveLedgerRefreshError'; this.code = code; }
}
const fail = (code, message) => { throw new LiveLedgerRefreshError(code, message); };
const same = (a, b) => a?.snapshotId === b?.snapshotId && a?.marketRevision === b?.marketRevision && a?.marketSha256 === b?.marketSha256 && a?.typesSha256 === b?.typesSha256;
const sameMarket = (a, b) => a?.snapshotId === b?.snapshotId && a?.marketRevision === String(b?.marketRevision ?? '') && a?.marketSha256 === (b?.sourceSha256 ?? b?.marketSha256);
const currentWrapper = (value, current) => same(value?.source, current.source) && value?.source?.sourceKind === 'native-sql-rows' && value?.data?.completedAt === current.metadata.completedAt && value?.data?.period?.from === current.metadata.period?.from && value?.data?.period?.to === current.metadata.period?.to;
function validWrapper(value) {
  const source = value?.source;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.data?.version !== 3 || typeof value.stamp !== 'string') return false;
  if (source === undefined) return LEGACY_STAMP.test(value.stamp) || Number.isFinite(Date.parse(value.stamp));
  return !!source&&typeof source==='object'&&!Array.isArray(source)&&Number.isFinite(Date.parse(value.stamp)) && (source.sourceKind===undefined||source.sourceKind==='native-sql-rows') && typeof source.snapshotId === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(source.marketRevision || '') && HASH.test(source.marketSha256 || '') && HASH.test(source.typesSha256 || '');
}
function commandId(source, expectedRevision = '0') {
  const bytes = crypto.createHash('sha256').update(`pult:live-ledger:${source.snapshotId}:${source.marketRevision}:${source.marketSha256}:${source.typesSha256}:${expectedRevision}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80; const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function createPostgresLiveLedgerRefresh({liveSources, pageSize = 1000} = {}) {
  if (!liveSources?.record || !liveSources?.document || !liveSources?.repository?.listRows || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 5000) throw new TypeError('Complete live ledger dependencies are required');

  async function evidence(storeId) {
    const market = await liveSources.record(`data-${storeId}.json`, {entities: []});
    if (!market?.head) fail('SOURCE_CHANGED', 'Current market snapshot is unavailable');
    const marketSha256 = market.head.sourceMetadata?.sourceSha256, marketRevision = String(market.revision);
    if (!HASH.test(marketSha256 || '') || !/^(?:0|[1-9][0-9]*)$/u.test(marketRevision)) fail('SOURCE_INTEGRITY', 'Current market evidence is invalid');
    const insights = await liveSources.record(`insights-${storeId}.json`, {entities: ['types']});
    const types = insights?.value?.types ?? [];
    if (!Array.isArray(types)) fail('SOURCE_INTEGRITY', 'Insights type evidence is invalid');
    return {
      source: {sourceKind: 'native-sql-rows', snapshotId: `live:${storeId}:${marketRevision}`, marketRevision, marketSha256, typesSha256: typesHash(types)},
      metadata: market.value,
      operationCount: Number(market.head.entityCounts?.operations ?? 0),
      types
    };
  }

  async function streamed(storeId, current) {
    const builder = createLedgerBuilder(current.metadata, current.types), identity = {storeId, domain: 'market'};
    let count = 0, after;
    for (;;) {
      const page = await liveSources.repository.listRows({...identity, entityType: 'operations', expectedRevision: Number(current.source.marketRevision), limit: pageSize, after, includeTotal: false});
      for (const row of page.rows) builder.add(row.value);
      count += page.rows.length;
      if (count > current.operationCount) fail('SOURCE_INTEGRITY', 'Finance operation count exceeds source evidence');
      if (page.rows.length < pageSize) break;
      const last = page.rows[page.rows.length - 1];
      after = {sourceOrder:last.sourceOrder,entityType:last.entityType,entityKey:last.entityKey,occurrence:last.occurrence};
    }
    if (count !== current.operationCount) fail('SOURCE_INTEGRITY', 'Finance operation count is incomplete');
    return builder.finish();
  }

  async function ensure({storeId, snapshot = null, expectedSource = null} = {}) {
    storeId = String(storeId || '');
    if (!STORE.test(storeId) || snapshot !== null && (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))) fail('INVALID_ARGUMENT', 'Ledger refresh input is invalid');
    const repository = liveSources.document(`ledger-${storeId}.json`, {validate: validWrapper});
    for (let retry = 0; retry < 3; retry++) {
      const current = await evidence(storeId), saved = await repository.read();
      if (saved && currentWrapper(saved.value, current)) return {revision: String(saved.revision), replayed: true, source: current.source};
      let ledger;
      if (snapshot && expectedSource && sameMarket(current.source, expectedSource)) ledger = buildLedger(snapshot, current.types);
      else { snapshot = null; ledger = await streamed(storeId, current); }
      if (ledger.completedAt !== current.metadata.completedAt || ledger.period?.from !== current.metadata.period?.from || ledger.period?.to !== current.metadata.period?.to) fail('SOURCE_INTEGRITY', 'Ledger metadata differs from current market snapshot');
      if (!same((await evidence(storeId)).source, current.source)) continue;
      const wrapper = {stamp: ledger.completedAt, source: current.source, data: ledger}, expectedRevision = String(saved?.revision ?? '0'), child = commandId(current.source, expectedRevision);
      const recorded = await repository.readCommand(child); let written;
      if (recorded) {
        if (String(recorded.before.revision) !== expectedRevision || !currentWrapper(recorded.after.value, current)) fail('COMMAND_ID_REUSED', 'Ledger command evidence differs');
        written = {revision: String(recorded.after.revision), replayed: true};
      } else {
        try { const value = await repository.compareAndSet(wrapper, {expectedRevision, commandId: child}); written = {...value, revision: String(value.revision)}; }
        catch (error) {
          const recovered = await repository.readCommand(child);
          if (recovered && String(recovered.before.revision) === expectedRevision && currentWrapper(recovered.after.value, current)) written = {revision: String(recovered.after.revision), replayed: true};
          else if (error?.code === 'REVISION_CONFLICT') continue;
          else if (error?.code === 'COMMAND_INTENT_CONFLICT') fail('COMMAND_ID_REUSED', 'Ledger command evidence differs');
          else throw error;
        }
      }
      const actual = await repository.read();
      if (!actual || String(actual.revision) !== written.revision || !currentWrapper(actual.value, current)) continue;
      if (same((await evidence(storeId)).source, current.source)) return {...written, source: current.source};
    }
    fail('SOURCE_CHANGED', 'Ledger source changed repeatedly');
  }
  return Object.freeze({ensure});
}

module.exports = {createPostgresLiveLedgerRefresh, LiveLedgerRefreshError, commandId};
