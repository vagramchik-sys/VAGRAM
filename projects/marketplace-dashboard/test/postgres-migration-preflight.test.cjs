'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assessMigrationPreflight } = require('../storage/postgres-migration-preflight.cjs');

const MODEL = Object.freeze({
  staging: [10000, 12000], sql: [8000, 18000], indexes: [2000, 9000],
  wal: [10000, 25000], backup: [5000, 15000], restore: [15000, 30000],
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'history', 'snapshots', 'aa'), { recursive: true });
  await fs.mkdir(path.join(root, 'loan-contracts'));
  await fs.writeFile(path.join(root, 'stores.json'), Buffer.alloc(11));
  await fs.writeFile(path.join(root, 'history', 'products.sqlite'), Buffer.alloc(23));
  await fs.writeFile(path.join(root, 'history', 'products.sqlite-wal'), Buffer.alloc(7));
  await fs.writeFile(path.join(root, 'history', 'snapshots', 'aa', `${'a'.repeat(64)}.json.gz`), Buffer.alloc(41));
  await fs.writeFile(path.join(root, 'loan-contracts', 'synthetic.pdf'), Buffer.alloc(13));
  return root;
}

function evidence(root) {
  return {
    sourceRoot: root, estimateModelBps: MODEL,
    capacityTargets: ['staging', 'postgres', 'backup', 'restore'].map(role => ({ role, path: root })),
    frozenSnapshot: { verified: true, writersStopped: true, sourceFingerprintVerified: true, atomic: true },
    bootstrapRoles: [{ purpose: 'application', available: true, attributesVerified: true }],
    schemaReadiness: { checked: true, versionsMatched: true, driftDetected: false, invalidIndexes: 0, unvalidatedConstraints: 0 },
    backupRestore: { backupVerified: true, distinctRestoreVerified: true },
    importValidation: { completed: true, idempotent: true, differencesExplained: true },
    rollbackRehearsal: { completed: true, postCheckpointCoverage: true },
  };
}

test('reports a ready admission only from complete measured and supplied evidence', async t => {
  const root = await fixture(t);
  const report = await assessMigrationPreflight(evidence(root));
  assert.equal(report.publicReport.admission, 'ready');
  assert.equal(report.publicReport.gates.capacity.status, 'ready');
  assert.equal(report.privateMeasurements.sourceBytes, '95');
  assert.equal(report.privateMeasurements.sqliteBytes, '23');
  assert.equal(report.privateMeasurements.sqliteWalBytes, '7');
  assert.equal(report.privateMeasurements.archiveBytes, '41');
  assert.equal(report.privateMeasurements.documentBytes, '13');
  assert.deepEqual(report.publicReport.largestRemainingUnboundedPath, {
    status: 'identified', code: 'archive-gzip-payloads', basis: 'file-metadata-proxy'
  });
  assert.equal(JSON.stringify(report.publicReport).match(/[0-9]{2,}/g), null, 'public report must not expose byte totals');
});

test('keeps unverified criteria unknown and confirmed classification failures missing', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'unknown-business.json'), Buffer.alloc(3));
  const report = await assessMigrationPreflight({ sourceRoot: root });
  assert.equal(report.publicReport.admission, 'blocked');
  assert.equal(report.publicReport.gates.runtimeInventory.status, 'missing');
  assert.equal(report.publicReport.gates.capacity.status, 'unknown');
  assert.equal(report.publicReport.gates.frozenSnapshot.status, 'unknown');
  assert.equal(report.privateMeasurements.classificationBlockerCount, 1);
});

test('does not turn estimates into policy when target paths or model are absent', async t => {
  const root = await fixture(t);
  const report = await assessMigrationPreflight({ ...evidence(root), estimateModelBps: undefined, capacityTargets: undefined });
  assert.equal(report.publicReport.gates.capacity.status, 'unknown');
  assert.equal(report.privateMeasurements.estimates, null);
});

test('rejects secret-bearing bootstrap input before reading inventory', async t => {
  const root = await fixture(t);
  await assert.rejects(
    assessMigrationPreflight({ sourceRoot: root, bootstrapRoles: [{ purpose: 'app', available: true, password: 'do-not-read' }] }),
    error => error.code === 'SECRET_INPUT_REJECTED' && !error.message.includes('do-not-read')
  );
});

test('groups requirements sharing one filesystem and detects insufficient upper bound', async t => {
  const root = await fixture(t);
  const huge = 9_000_000_000_000_000n;
  const options = evidence(root);
  options.capacityTargets = options.capacityTargets.map(target => ({ ...target, reserveBytes: huge.toString() }));
  const report = await assessMigrationPreflight(options);
  assert.equal(report.publicReport.gates.capacity.status, 'missing');
  assert.equal(report.publicReport.gates.capacity.code, 'ESTIMATED_UPPER_BOUND_EXCEEDS_FREE_SPACE');
});

test('an explicitly failed atomic snapshot or schema check blocks admission', async t => {
  const root = await fixture(t);
  const options = evidence(root);
  options.frozenSnapshot.atomic = false;
  options.schemaReadiness.driftDetected = true;
  const report = await assessMigrationPreflight(options);
  assert.equal(report.publicReport.gates.frozenSnapshot.status, 'missing');
  assert.equal(report.publicReport.gates.schemaReadiness.status, 'missing');
  assert.equal(report.publicReport.admission, 'blocked');
});
