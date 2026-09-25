'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPostgresBuyerSnapshot, sourcePath } = require('../storage/acquisition/postgres-buyer-snapshot.cjs');
const { createOzonBuyerOrdersCollector } = require('../storage/acquisition/postgres-buyer-orders-collector.cjs');
const { sourceKey } = require('../storage/postgres-document-import.cjs');

const DAY = '2026-09-21', TIME = '2026-09-22T08:00:00.000Z', COMMAND = '11111111-1111-4111-8111-111111111111';
const operation = (overrides = {}) => ({ date: DAY, commandId: COMMAND, timestamp: TIME, expectedRevision: '0', ...overrides });
function document() {
  const sources = ['FBO', 'FBS'].map(scheme => ({ market: 'Ozon', scheme, storeId: '1', name: 'Synthetic', from: DAY, to: DAY, available: true, complete: true, fetchedAt: TIME, rows: 1, pages: 1, limitation: null }));
  const records = sources.map(source => ({ id: `Ozon:${source.scheme}:p-${source.scheme}`, orderKey: `p-${source.scheme}`, market: 'Ozon', scheme: source.scheme, storeId: '1', storeName: 'Synthetic', createdAt: DAY + 'T10:00:00.000Z', units: 1, buyerType: 'legal', classificationField: 'analytics_data.is_legal', classificationReliable: true, cancelled: false }));
  const productOrders = sources.map(source => ({ market: 'Ozon', scheme: source.scheme, storeId: '1', orderId: `o-${source.scheme}`, postingId: `p-${source.scheme}`, productId: source.scheme, orderedAt: DAY + 'T10:00:00.000Z', units: 1, amountRub: null, currency: null, cancelled: false, updatedAt: TIME, buyerType: 'legal' }));
  const totals = { legal: { units: 2, orders: 2, cancelledUnits: 0, cancelledOrders: 0, notCancelledUnits: 2, notCancelledOrders: 2, cancellationUnknownUnits: 0, cancellationUnknownOrders: 0 }, individual: { units: 0, orders: 0, cancelledUnits: 0, cancelledOrders: 0, notCancelledUnits: 0, notCancelledOrders: 0, cancellationUnknownUnits: 0, cancellationUnknownOrders: 0 }, unknown: { units: 0, orders: 0, cancelledUnits: 0, cancelledOrders: 0, notCancelledUnits: 0, notCancelledOrders: 0, cancellationUnknownUnits: 0, cancellationUnknownOrders: 0 } };
  return { version: 2, period: { from: DAY, to: DAY }, scope: 'all-ozon-stores', status: 'collected', generatedAt: TIME, records, productOrders, report: { status: 'ready', period: { from: DAY, to: DAY }, totals, byStore: [], coverage: { complete: true, includedRecords: 2, invalidRecords: 0, duplicateRecords: 0, sources }, source: {} }, errors: [] };
}
function memory({ unknownFinal = false, mutateAfterPrepare = false } = {}) {
  let revision = 0, current = null, writes = 0, reads = 0; const commands = new Map();
  const repository = { async read() { return current?{revision:String(revision),deleted:false,value:structuredClone(current)}:null; }, async readCommand(id) { return commands.get(id) || null; }, async compareAndSet(value, options) { writes++; const actual = String(revision); if (actual !== options.expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' }); const before = current ? { revision: actual, deleted: false, value: structuredClone(current) } : { revision: '0', absent: true, deleted: false, value: null }; revision++; current = structuredClone(value); const after = { revision: String(revision), deleted: false, value: structuredClone(current) }; commands.set(options.commandId, { before, after }); if (unknownFinal && value.status === 'collected') { unknownFinal = false; throw Object.assign(Error('unknown'), { code: 'OUTCOME_UNKNOWN' }); } return { revision: String(revision), replayed: false }; } };
  const base = { '1': { name: 'Synthetic', clientId: '1', key: 'ciphertext', connectedAt: TIME } }, storesRepository = { async read() { reads++; const value = structuredClone(base); if (mutateAfterPrepare && reads > 1) value['1'].key = 'changed-ciphertext'; return value; } };
  return { repository, storesRepository, get writes() { return writes; }, get current() { return current; }, commands };
}

test('durable pending receipt precedes API and exact replay after later registry changes does not recollect', async () => {
  const state = memory(), calls = [], service = createPostgresBuyerSnapshot({ stateStore: {}, storesRepository: state.storesRepository, decrypt: async () => 'clear', collector: { collect: async input => { calls.push(input); assert.equal(state.current.status, 'pending'); return document(); } }, repositoryFactory: options => { assert.equal(options.sourcePath, sourcePath(DAY)); assert.equal(options.logicalKey, sourceKey(sourcePath(DAY))); return state.repository; }, now: () => new Date(TIME) });
  const first = await service.run(operation()); assert.equal(first.revision, '2'); assert.equal(state.writes, 2); assert.equal(calls.length, 1);
  state.storesRepository.read = async () => ({ '2': { name: 'Later', clientId: '2', key: 'other', connectedAt: TIME } });
  const replay = await service.run(operation()); assert.equal(replay.replayed, true); assert.equal(replay.revision, '2'); assert.equal(calls.length, 1);
  await assert.rejects(service.run(operation({ timestamp: '2026-09-22T08:01:00.000Z' })), { code: 'COMMAND_ID_REUSED' });
  await assert.rejects(service.run(operation({ expectedRevision: '1' })), { code: 'COMMAND_ID_REUSED' });
});

test('unknown final commit resolves from journal and changed credentials or incomplete collection never publish complete', async () => {
  const unknown = memory({ unknownFinal: true }); let calls = 0;
  const retryable = createPostgresBuyerSnapshot({ stateStore: {}, storesRepository: unknown.storesRepository, decrypt: async () => 'clear', collector: { collect: async () => (calls++, document()) }, repositoryFactory: () => unknown.repository, now: () => new Date(TIME) });
  await assert.rejects(retryable.run(operation()), { code: 'OUTCOME_UNKNOWN' }); const replay = await retryable.run(operation()); assert.equal(replay.replayed, true); assert.equal(calls, 1);
  const changed = memory({ mutateAfterPrepare: true }); let effects = 0;
  const changedService = createPostgresBuyerSnapshot({ stateStore: {}, storesRepository: changed.storesRepository, decrypt: async () => { effects++; }, collector: { collect: async () => { effects++; return document(); } }, repositoryFactory: () => changed.repository, now: () => new Date(TIME) });
  await assert.rejects(changedService.run(operation()), { code: 'SOURCE_CHANGED' }); assert.equal(effects, 0); assert.equal(changed.current.status, 'pending');
  const incomplete = memory(), incompleteService = createPostgresBuyerSnapshot({ stateStore: {}, storesRepository: incomplete.storesRepository, decrypt: async () => 'clear', collector: { collect: async () => ({ ...document(), status: 'partial' }) }, repositoryFactory: () => incomplete.repository, now: () => new Date(TIME) });
  await assert.rejects(incompleteService.run(operation()), { code: 'INCOMPLETE_SOURCE' }); assert.equal(incomplete.current.status, 'pending');
});

test('verified partial snapshot publishes, replays, and cannot replace a complete day',async()=>{
  const partial=document();partial.report.status='partial';partial.report.coverage.complete=false;partial.report.coverage.sources[0].complete=false;partial.report.coverage.sources[0].limitation='Processing-time filter does not prove created-day completeness';
  const state=memory();let calls=0;const service=createPostgresBuyerSnapshot({stateStore:{},storesRepository:state.storesRepository,decrypt:async()=> 'clear',collector:{collect:async()=>{calls++;return structuredClone(partial)}},repositoryFactory:()=>state.repository,now:()=>new Date(TIME)});
  const first=await service.run(operation());assert.equal(first.revision,'2');assert.equal(state.current.report.coverage.complete,false);
  const replay=await service.run(operation());assert.equal(replay.replayed,true);assert.equal(calls,1);
  const complete=memory();await complete.repository.compareAndSet(document(),{expectedRevision:'0',commandId:'22222222-2222-4222-8222-222222222222'});
  const protectedService=createPostgresBuyerSnapshot({stateStore:{},storesRepository:complete.storesRepository,decrypt:async()=> 'clear',collector:{collect:async()=>partial},repositoryFactory:()=>complete.repository,now:()=>new Date(TIME)});
  await assert.rejects(protectedService.run(operation({expectedRevision:'1'})),{code:'COMPLETE_SOURCE_EXISTS'});assert.equal(complete.current.report.coverage.complete,true);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL journal atomically maps pending then complete snapshot and replays without API', { skip: !integrationUrl }, async t => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /^pult_test_/u);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl }), schema = `buyer_${crypto.randomBytes(6).toString('hex')}`; let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  await pool.query(require('../storage/postgres-schema.cjs').replace(/\bpult\b/gu, schema)); await pool.query(require('../storage/postgres-document-schema.cjs').replace(/\bpult\b/gu, schema)); owned = true;
  const { createStateStore } = require('../storage/postgres-state.cjs'), createStores = require('../storage/domains/postgres-stores.cjs'), stateStore = createStateStore({ pool, schema }), stores = createStores({ stateStore });
  await stores.compareAndSet({ '1': { name: 'Synthetic', clientId: '1', key: 'ciphertext', connectedAt: TIME } }, { expectedRevision: '0', commandId: '22222222-2222-4222-8222-222222222222' });
  let apiCalls = 0; const collector = createOzonBuyerOrdersCollector({ api: async (_store, key, route) => { apiCalls++; assert.equal(key, 'clear'); const scheme = route.includes('/fbs/') ? 'FBS' : 'FBO'; return { result: { postings: [{ posting_number: `p-${scheme}`, order_number: `o-${scheme}`, created_at: DAY + 'T10:00:00Z', status: 'awaiting_deliver', analytics_data: { is_legal: true }, products: [{ sku: scheme, quantity: 1 }] }], has_next: false } }; }, now: () => new Date(TIME) });
  const service = createPostgresBuyerSnapshot({ stateStore, storesRepository: stores, decrypt: async () => 'clear', collector, now: () => new Date(TIME) });
  const first = await service.run(operation()); assert.equal(first.revision, '2'); assert.equal(apiCalls, 2); const replay = await service.run(operation()); assert.equal(replay.replayed, true); assert.equal(apiCalls, 2);
  const pathValue = sourcePath(DAY), mapping = (await pool.query(`SELECT baseline_present,source_bytes::text AS bytes FROM "${schema}".source_files WHERE source_path=$1`, [pathValue])).rows[0]; assert.equal(mapping.baseline_present, false); assert.equal(mapping.bytes, '0');
  const count = (await pool.query(`SELECT count(*)::int AS count FROM "${schema}".commands WHERE logical_key=$1`, [sourceKey(pathValue)])).rows[0].count; assert.equal(count, 2);
});



