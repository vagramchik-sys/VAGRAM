'use strict';

// Read-only migration preflight. Classification is not permission to delete files.
// No file contents, credentials or DPAPI plaintext are read by this module.
const fs = require('node:fs/promises');
const path = require('node:path');

const REGISTERS = new Set([
  'ideas.json', 'procurement.json', 'supplier-portals.json', 'partner-workspace.json',
  'partner-commercial-model.json', 'finance-register.json', 'management.json',
  'charity.json', 'charity-plan.json', 'company-impact.json', 'product-type-registry.json',
  'order-category-intraday.json', 'truestats-wb-link.json', 'pult-atlas-sync-state.json',
]);
const CONNECTIONS = new Set([
  'stores.json', 'truestats.json', 'pult-atlas-credential.json', 'b2b-agent/connection.dpapi',
]);
const MARKET = /^(data|insights|intraday|wb-orders|costs|prices|ozon-funnel|ledger|order-category-catalog)-(?:wb-)?[0-9]+\.json$/;
const BUYER = /^buyer-(?:order-segments|product-segments|segments-wb-[0-9]+)-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}-[0-9]{2}-[0-9]{2}(?:-retry-[0-9]+)?(?:\.partial)?\.json$/;

function classify(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') ||
      relativePath.startsWith('/') || relativePath.includes(':') ||
      relativePath.split('/').some(s => !s || s === '.' || s === '..')) {
    throw new TypeError('Expected a canonical relative inventory path');
  }
  if (CONNECTIONS.has(relativePath)) return { kind: 'runtime', domain: 'protected-connections', target: 'sql-ciphertext-and-settings' };
  if (REGISTERS.has(relativePath)) return { kind: 'runtime', domain: 'business-state', target: 'sql-state' };
  if (relativePath === 'b2b-agent/queue.json') return { kind: 'runtime', domain: 'b2b-state', target: 'sql-state' };
  if (MARKET.test(relativePath) || BUYER.test(relativePath)) return { kind: 'runtime', domain: 'market-snapshots', target: 'sql-snapshots' };
  if (/^history\/(products|archive|stocks)\.sqlite$/.test(relativePath)) return { kind: 'runtime', domain: 'history', target: 'sql-tables', backupRequirement: 'sqlite-online-backup' };
  if (/^history\/(products|archive|stocks)\.sqlite-(wal|shm)$/.test(relativePath)) return { kind: 'sqlite-sidecar', domain: 'history', target: 'consistent-sqlite-backup' };
  if (/^history\/snapshots\/[a-f0-9]{2}\/[a-f0-9]{64}\.json\.gz$/.test(relativePath)) return { kind: 'runtime', domain: 'archive-content', target: 'sql-blob' };
  if (/^loan-contracts\/[^/]+\.(json|pdf|docx|png|jpe?g)$/i.test(relativePath)) return { kind: 'runtime', domain: 'documents', target: 'sql-blob-and-metadata' };
  if (relativePath.startsWith('stock-history-imports/')) return { kind: 'source-evidence', domain: 'stock-provenance', target: 'review-for-sql-blob' };
  if (relativePath.startsWith('control-sql-restore/')) return { kind: 'candidate-source', domain: 'external-sql-backup-and-media', target: 'isolated-review' };
  if (relativePath.startsWith('backups/') || relativePath.startsWith('ui-before-seller-reference/')) return { kind: 'backup', domain: 'backup', target: 'protected-backup' };
  if (/^(b2b-agent\/process|pult-atlas-export)\.lock$/.test(relativePath)) return { kind: 'ephemeral', domain: 'process-lock', target: 'local' };
  if (/\.log$/.test(relativePath)) return { kind: 'diagnostic', domain: 'log', target: 'protected-diagnostics' };
  // Unknown JSON/DPAPI/documents are deliberately never silently omitted.
  return { kind: 'review', domain: 'unclassified', target: 'manual-classification' };
}

async function inspectPrivateDirectory(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('An absolute private directory is required');
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Inventory root must be a real directory');
  const realRoot = await fs.realpath(root);
  const entries = [], blockers = [];
  async function walk(folder, prefix = '') {
    const children = await fs.readdir(folder, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const key = prefix + child.name;
      const file = path.join(folder, child.name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) { blockers.push({ path: key, code: 'LINK_NOT_FOLLOWED' }); continue; }
      const resolved = await fs.realpath(file), rel = path.relative(realRoot, resolved);
      if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) {
        blockers.push({ path: key, code: 'OUTSIDE_ROOT' }); continue;
      }
      if (stat.isDirectory()) { await walk(file, key + '/'); continue; }
      if (!stat.isFile()) { blockers.push({ path: key, code: 'UNSUPPORTED_FILE_TYPE' }); continue; }
      let type;
      try { type = classify(key); } catch { blockers.push({ path: key, code: 'INVALID_PATH' }); continue; }
      entries.push({ path: key, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), ...type });
      if (type.kind === 'review' || type.kind === 'source-evidence') blockers.push({ path: key, code: 'CLASSIFICATION_REQUIRED' });
    }
  }
  await walk(realRoot);
  const totals = {};
  for (const entry of entries) {
    const group = totals[entry.kind] ||= { files: 0, bytes: 0 };
    group.files++; group.bytes += entry.bytes;
  }
  return {
    schemaVersion: 1, observedAt: new Date().toISOString(),
    mode: 'read-only file metadata; not a consistent backup or content verification',
    entries, totals, blockers, classificationComplete: blockers.length === 0,
    migrationReady: false, // Readiness always needs verified backup/restore/report checks.
  };
}

module.exports = { classify, inspectPrivateDirectory };
