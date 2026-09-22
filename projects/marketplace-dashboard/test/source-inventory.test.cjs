'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { classify, inspectPrivateDirectory } = require('../storage/source-inventory.cjs');

test('all formerly unarchived primary registries and opaque connections are migration sources', () => {
  for (const name of ['procurement.json', 'supplier-portals.json', 'partner-workspace.json', 'b2b-agent/queue.json', 'stores.json', 'b2b-agent/connection.dpapi', 'pult-atlas-sync-state.json']) {
    assert.equal(classify(name).kind, 'runtime', name);
  }
  assert.equal(classify('truestats-wb-link.json').target, 'sql-state');
  assert.equal(classify('b2b-agent/connection.dpapi').target, 'sql-ciphertext-and-settings');
});

test('partial checkpoints and originals remain migration sources; WAL is not a standalone import', () => {
  assert.equal(classify('buyer-order-segments-2026-01-01_2026-01-02-retry-10.partial.json').kind, 'runtime');
  assert.equal(classify('loan-contracts/synthetic.pdf').target, 'sql-blob-and-metadata');
  assert.equal(classify('history/products.sqlite-wal').target, 'consistent-sqlite-backup');
  assert.equal(classify('stock-history-imports/source.json').kind, 'source-evidence');
});

test('known audit evidence and quarantined candidates are preserved as SQL artifacts', () => {
  assert.deepEqual(classify('sql-source-classification-20260922.json'), { kind: 'runtime', domain: 'audit-evidence', target: 'sql-artifact-and-metadata' });
  assert.equal(classify('product-category-audit/validation-1789904111299/report.json').kind, 'runtime');
  assert.equal(classify('candidates/buyer-order-segments-2026-09-20_2026-09-20-2026-09-21T121111267Z-49516.candidate.json').target, 'sql-quarantine-artifact');
  assert.equal(classify('stock-history-imports/dry-run.json').target, 'sql-artifact-and-metadata');
  assert.equal(classify('stock-history-imports/' + 'a'.repeat(64) + '/stock-audit/synthetic-run.jsonl').kind, 'runtime');
  assert.equal(classify('stock-history-imports/' + 'a'.repeat(64) + '/unexpected.exe').kind, 'source-evidence');
});

test('only exact setup and bootstrap paths receive a protected local exclusion', () => {
  for (const name of [
    'postgres-setup/edb-binaries.html', 'postgres-setup/postgresql-18.6-windows-x64.zip',
    'postgres-setup/admin.dpapi', 'postgres-setup/admin-failed-20260922-101239.dpapi',
    'control-sql-restore/SK_Control-20260921.bak', 'control-sql-restore/en-US/SqlLocalDB.msi'
  ]) assert.equal(classify(name).target, 'protected-local-exclusion', name);
  assert.equal(classify('postgres-setup/admin-failed-latest.dpapi').kind, 'review');
  assert.equal(classify('control-sql-restore/unreviewed.bak').kind, 'review');
});

test('unknown business files block completeness without reading secret contents', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-inventory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'b2b-agent'));
  const secret = 'synthetic opaque bytes that must never appear in the report';
  await fs.writeFile(path.join(root, 'b2b-agent/connection.dpapi'), secret);
  await fs.writeFile(path.join(root, 'new-business-state.json'), '{invalid JSON is intentionally not parsed');
  const report = await inspectPrivateDirectory(root);
  assert.equal(report.classificationComplete, false);
  assert.equal(report.migrationReady, false);
  assert.equal(report.totals.runtime.files, 1);
  assert.equal(report.totals.review.files, 1);
  assert.deepEqual(report.blockers, [{ path: 'new-business-state.json', code: 'CLASSIFICATION_REQUIRED' }]);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('links cannot bring files outside the source root into an inventory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-inventory-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), outside = path.join(root, 'outside');
  await fs.mkdir(source); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'stores.json'), '{}');
  await fs.symlink(outside, path.join(source, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  const report = await inspectPrivateDirectory(source);
  assert.equal(report.entries.length, 0);
  assert.deepEqual(report.blockers, [{ path: 'external', code: 'LINK_NOT_FOLLOWED' }]);
});

test('reject absolute/traversal paths and distinguish backup from an active data source', () => {
  for (const key of ['../stores.json', '/stores.json', 'C:/stores.json', 'nested\\stores.json', 'a/../stores.json']) {
    assert.throws(() => classify(key), TypeError);
  }
  assert.equal(classify('backups/stores.json').kind, 'backup');
  assert.equal(classify('control-sql-restore/SK_Control-20260921.bak').kind, 'candidate-source');
  assert.equal(classify('control-sql-restore/external.bak').kind, 'review');
});
