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
  assert.equal(classify('control-sql-restore/external.bak').kind, 'candidate-source');
});
