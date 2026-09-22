'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createLiveHistoryCapture } = require('../storage/postgres-live-history-capture.cjs');
const { createLiveSources } = require('../storage/postgres-live-sources.cjs');
const { createPostgresLiveRepository } = require('../storage/postgres-live-repository.cjs');
const { ensurePostgresLiveSchema } = require('../storage/postgres-live-schema.cjs');
const { createMarketHistoryRepository } = require('../storage/postgres-history-repository.cjs');
const historySchema = require('../storage/postgres-history-schema.cjs');
const timestamp = '2026-09-22T12:00:00.000Z';
const payload = refs => ({ mode: 'live', intraday: [{ storeId: '1', sources: refs }], category: { stores: [{ id: '1', sources: refs }], evidence: refs } });
const request = refs => ({ payload: payload(refs), timestamp, commandId: crypto.randomUUID() });
const ref = (sourcePath, revision = '1', sha256 = 'a'.repeat(64)) => ({ sourcePath, revision, sha256 });
const hasCode = code => error => error.code === code;
const store = () => BigInt('0x' + crypto.randomBytes(8).toString('hex')).toString();

test('history capture uses only pinned narrow facts and deduplicates evidence', async () => {
  const read = [], ingested = [], refs = [ref('data-1.json'), ref('insights-1.json'), ref('ledger-1.json'), ref('wb-orders-wb-1.json'), ref('order-category-catalog-1.json')];
  const capture = createLiveHistoryCapture({ sources: { async record(sourcePath, options) { read.push({ sourcePath, options }); return { revision: '1', deleted: false, value: { selected: sourcePath }, head: { sourceMetadata: { sourcePath, sourceSha256: 'a'.repeat(64) } } }; } },
    historyFacts: { async ingest(value) { ingested.push(value); return { duplicate: false, snapshotCount: 1, factCount: 2 }; } } });
  const result = await capture.capture(request(refs));
  assert.equal(read.length, 4); assert.equal(ingested.length, 4); assert.equal(result.sourceCount, 4); assert.equal(result.factCount, 8);
  assert.deepEqual(read.find(row => row.sourcePath === 'insights-1.json').options, { revision: '1', entities: ['orders.skuDaily', 'orders.skuCoverage'] });
  assert.deepEqual(read.find(row => row.sourcePath === 'ledger-1.json').options.entities, ['data.skuDaily']);
  assert.equal(ingested.every(row => Object.keys(row).sort().join(',') === 'capturedAt,contentHash,data,sourceFile'), true);
  assert.equal(JSON.stringify(result).includes('selected'), false);
});

test('conflicting refs and source SHA mismatches fail closed before ingestion', async () => {
  let writes = 0;
  const capture = createLiveHistoryCapture({ sources: { async record() { return { revision: '2', head: { sourceMetadata: { sourceSha256: 'b'.repeat(64) } } }; } }, historyFacts: { async ingest() { writes++; } } });
  await assert.rejects(capture.capture(request([ref('insights-1.json'), ref('insights-1.json', '2')])), hasCode('CONFLICTING_HISTORY_EVIDENCE'));
  await assert.rejects(capture.capture(request([ref('insights-1.json')])), hasCode('HISTORY_SOURCE_CHANGED'));
  assert.equal(writes, 0);
});

test('native history capture preserves existing reports and history without source archives', { skip: !process.env.PULT_TEST_DATABASE_URL }, async t => {
  const { Pool } = require('pg'), pool = new Pool({ connectionString: process.env.PULT_TEST_DATABASE_URL, max: 3 });
  t.after(() => pool.end()); await ensurePostgresLiveSchema(pool); await pool.query(historySchema);
  const repository = createPostgresLiveRepository({ pool }), sources = createLiveSources({ repository }), history = createMarketHistoryRepository({ pool });
  const projector = createLiveHistoryCapture({ sources, historyFacts: history });
  const id = store(), path = `insights-${id}.json`, doc = sources.document(path);
  const first = { orders: { period: { from: '2026-09-18', to: '2026-09-19' }, skuUpdatedAt: '2026-09-20T12:00:00.000Z', skuDailyCoverage: true, skuCoverage: ['2026-09-18', '2026-09-19'], skuDaily: [{ date: '2026-09-18', sku: 'sku-1', units: 2, revenue: 20 }] } };
  const second = { orders: { ...first.orders, skuUpdatedAt: '2026-09-21T12:00:00.000Z', skuDaily: [{ date: '2026-09-18', sku: 'sku-1', units: 3, revenue: 30 }] } };
  const baseline = await pool.query('SELECT count(*) AS count FROM pult_history.archive_versions');
  await doc.compareAndSet(first, { expectedRevision: '0', commandId: crypto.randomUUID() });
  const initial = await sources.record(path), original = ref(path, initial.revision, initial.head.sourceMetadata.sourceSha256), captureRequest = request([original]);
  await doc.compareAndSet(second, { expectedRevision: '1', commandId: crypto.randomUUID() });
  const projected = await projector.capture(captureRequest);
  assert.equal(projected.ingested, 1); assert.equal(projected.snapshotCount, 2); assert.equal(projected.factCount, 1);
  let report = await history.report({ from: '2026-09-18', to: '2026-09-19', storeId: id, metric: 'revenue' });
  assert.equal(report.rows[0].totals.revenue, 20, 'pinned revision remains exact after current source changed');
  assert.equal(report.coverage.confirmedStoreDays, 2); assert.equal(report.rows[0].weekend.days, 1); assert.equal(report.rows[0].weekend.value, 0);
  assert.equal((await projector.capture(captureRequest)).duplicates, 1);
  const current = await sources.record(path);
  await projector.capture(request([ref(path, current.revision, current.head.sourceMetadata.sourceSha256)]));
  report = await history.report({ from: '2026-09-18', to: '2026-09-19', storeId: id, metric: 'revenue' });
  assert.equal(report.rows[0].totals.revenue, 30);
  const versions = await pool.query('SELECT count(*) AS count FROM pult_history.snapshots WHERE store_id=$1', [id]);
  assert.equal(Number(versions.rows[0].count), 4, 'both per-day observations remain in normalized history');
  const archive = await pool.query('SELECT count(*) AS count FROM pult_history.archive_versions');
  assert.equal(archive.rows[0].count, baseline.rows[0].count);
  const bytes = await pool.query("SELECT count(*) AS count FROM information_schema.columns WHERE table_schema='pult_live' AND data_type='bytea'");
  assert.equal(Number(bytes.rows[0].count), 0);

  const ledgerPath = `ledger-${id}.json`, ledger = { data: { period: { from: '2026-09-18', to: '2026-09-19' }, completedAt: '2026-09-20T12:00:00.000Z', complete: true, skuDaily: [{ date: '2026-09-18', sku: 'sku-1', values: { soldUnits: 2, realized: 2000, ads: 100, unknownUnitRows: 1 } }] } };
  await sources.document(ledgerPath).compareAndSet(ledger, { expectedRevision: '0', commandId: crypto.randomUUID() });
  const ledgerRecord = await sources.record(ledgerPath);
  await projector.capture(request([ref(ledgerPath, ledgerRecord.revision, ledgerRecord.head.sourceMetadata.sourceSha256)]));
  const finance = await history.report({ from: '2026-09-18', to: '2026-09-19', storeId: id, metric: 'realized' });
  assert.equal(finance.rows[0].totals.realized, 20); assert.equal(finance.rows[0].totals.unitsComplete, false);

  const wbId = 'wb-' + store(), wbPath = `wb-orders-${wbId}.json`;
  await sources.document(wbPath).compareAndSet({ day: '2026-09-18', fetchedAt: '2026-09-20T12:00:00.000Z', complete: true, orders: [{ nmId: 'nm-1', at: '2026-09-18T12:00:00.000Z', amount: 7 }] }, { expectedRevision: '0', commandId: crypto.randomUUID() });
  const wb = await sources.record(wbPath);
  await projector.capture(request([ref(wbPath, wb.revision, wb.head.sourceMetadata.sourceSha256)]));
  const wbReport = await history.report({ from: '2026-09-18', to: '2026-09-19', storeId: wbId, market: 'WB', metric: 'units' });
  assert.equal(wbReport.rows[0].totals.units, 1);
  const events = await pool.query('SELECT count(*) AS count FROM pult_history.order_events e JOIN pult_history.snapshots s ON s.id=e.snapshot_id WHERE s.store_id=$1', [wbId]);
  assert.equal(Number(events.rows[0].count), 1);
});
