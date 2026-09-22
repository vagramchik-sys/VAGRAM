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
  'runtime-schedules.json',
  'truestats-runtime-state.json',
]);
const CONNECTIONS = new Set([
  'stores.json', 'truestats.json', 'pult-atlas-credential.json', 'b2b-agent/connection.dpapi',
]);
const MARKET = /^(data|insights|intraday|wb-orders|costs|prices|ozon-funnel|ledger|order-category-catalog)-(?:wb-)?[0-9]+\.json$/;
const BUYER = /^buyer-(?:order-segments|product-segments|segments-wb-[0-9]+)-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}-[0-9]{2}-[0-9]{2}(?:-retry-[0-9]+)?(?:\.partial)?\.json$/;
const PRIVATE_AUDIT_CODE = new Set([
  'atlas-ozon-export.cjs', 'collect-buyer-order-segments.cjs', 'collect-buyer-order-segments.test.cjs',
  'collect-wb-buyer-segments.cjs', 'conversion-rnp-audit.cjs', 'conversion-validate.cjs',
  'procurement-smoke.cjs',
]);
const PRIVATE_AUDIT_EXACT = new Set([
  'atlas-ozon-export.json', 'partner-terms-draft.md',
]);
const SETUP_EXCLUSIONS = new Set([
  'postgres-setup/edb-binaries.html', 'postgres-setup/postgresql-18.6-windows-x64.zip',
  'postgres-setup/admin.dpapi', 'postgres-setup/application.dpapi', 'postgres-setup/migrator.dpapi',
  'postgres-setup/importer.dpapi', 'postgres-setup/provisioning.json', 'control-sql-restore/NEXT-STEPS.md',
  'control-sql-restore/SK_Control-20260921.bak', 'control-sql-restore/SQL2025-Express-Setup.exe',
  'control-sql-restore/en-US/SqlLocalDB.msi',
]);

function auditArtifact(relativePath) {
  if (PRIVATE_AUDIT_CODE.has(relativePath)) return { kind: 'runtime', domain: 'audit-reproducibility', target: 'sql-artifact-and-metadata' };
  if (PRIVATE_AUDIT_EXACT.has(relativePath) ||
      /^(?:category-day-recovery|charity-seller-evidence)-[0-9]{4}-[0-9]{2}-[0-9]{2}\.(?:md|json)$/.test(relativePath) ||
      /^truestats-audit-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$/.test(relativePath) ||
      /^sql-(?:capacity-preflight|migration-preflight|source-classification)-[0-9]{8}\.json$/.test(relativePath)) {
    return { kind: 'runtime', domain: 'audit-evidence', target: 'sql-artifact-and-metadata' };
  }
  if (/^candidates\/buyer-order-segments-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{9}Z-[0-9]+\.candidate\.json$/.test(relativePath)) {
    return { kind: 'runtime', domain: 'quarantined-business-candidate', target: 'sql-quarantine-artifact' };
  }
  if (/^product-category-audit\/(?:[a-z0-9-]+\.(?:json|cjs)|llm-batches\/[0-9]{2}-[a-z0-9-]+\.json|validation-[0-9]+\/(?:order-category-intraday|report)\.json)$/.test(relativePath)) {
    return { kind: 'runtime', domain: 'category-audit-evidence', target: 'sql-artifact-and-metadata' };
  }
  return null;
}

function stockEvidence(relativePath) {
  if (/^stock-history-imports\/(?:dry-run|result|store-map)\.json$/.test(relativePath) ||
      /^stock-history-imports\/[a-f0-9]{64}\/(?:cluster-supply-last-good|manifest|ozon-cabinet-stock-core|ozon-product-daily-snapshots|ozon-seller-stock-core)\.json$/.test(relativePath) ||
      /^stock-history-imports\/[a-f0-9]{64}\/stock-api-diagnostics\/[A-Za-z0-9._-]+\.json$/.test(relativePath) ||
      /^stock-history-imports\/[a-f0-9]{64}\/stock-audit\/[A-Za-z0-9._-]+\.jsonl$/.test(relativePath)) {
    return { kind: 'runtime', domain: 'stock-provenance', target: 'sql-artifact-and-metadata' };
  }
  return null;
}

function classify(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') ||
      relativePath.startsWith('/') || relativePath.includes(':') ||
      relativePath.split('/').some(s => !s || s === '.' || s === '..')) {
    throw new TypeError('Expected a canonical relative inventory path');
  }
  const audit = auditArtifact(relativePath);
  if (audit) return audit;
  const evidence = stockEvidence(relativePath);
  if (evidence) return evidence;
  if (SETUP_EXCLUSIONS.has(relativePath) || /^postgres-setup\/admin-failed-[0-9]{8}-[0-9]{6}\.dpapi$/.test(relativePath)) {
    return { kind: 'candidate-source', domain: relativePath.endsWith('.dpapi') ? 'protected-bootstrap' : 'migration-tooling', target: 'protected-local-exclusion' };
  }
  if (CONNECTIONS.has(relativePath)) return { kind: 'runtime', domain: 'protected-connections', target: 'sql-ciphertext-and-settings' };
  if (REGISTERS.has(relativePath)) return { kind: 'runtime', domain: 'business-state', target: 'sql-state' };
  if (relativePath === 'b2b-agent/queue.json') return { kind: 'runtime', domain: 'b2b-state', target: 'sql-state' };
  if (MARKET.test(relativePath) || BUYER.test(relativePath)) return { kind: 'runtime', domain: 'market-snapshots', target: 'sql-snapshots' };
  if (/^history\/(products|archive|stocks)\.sqlite$/.test(relativePath)) return { kind: 'runtime', domain: 'history', target: 'sql-tables', backupRequirement: 'sqlite-online-backup' };
  if (/^history\/(products|archive|stocks)\.sqlite-(wal|shm)$/.test(relativePath)) return { kind: 'sqlite-sidecar', domain: 'history', target: 'consistent-sqlite-backup' };
  if (/^history\/snapshots\/[a-f0-9]{2}\/[a-f0-9]{64}\.json\.gz$/.test(relativePath)) return { kind: 'runtime', domain: 'archive-content', target: 'sql-blob' };
  if (/^loan-contracts\/[^/]+\.(json|pdf|docx|png|jpe?g)$/i.test(relativePath)) return { kind: 'runtime', domain: 'documents', target: 'sql-blob-and-metadata' };
  if (relativePath.startsWith('stock-history-imports/')) return { kind: 'source-evidence', domain: 'stock-provenance', target: 'manual-classification' };
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
