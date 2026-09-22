'use strict';

// Read-only admission report. This module never freezes writers, creates a
// snapshot, changes PostgreSQL, or treats an estimate as a measured value.
const fs = require('node:fs/promises');
const path = require('node:path');
const { inspectPrivateDirectory } = require('./source-inventory.cjs');

const CAPACITY_ROLES = Object.freeze(['staging', 'postgres', 'backup', 'restore']);
const ESTIMATE_PARTS = Object.freeze(['staging', 'sql', 'indexes', 'wal', 'backup', 'restore']);
const SECRET_KEYS = /(?:password|secret|token|credential|connectionstring|databaseurl|uri|url)$/i;

class MigrationPreflightError extends Error {
  constructor(code, message) { super(message); this.name = 'MigrationPreflightError'; this.code = code; }
}

function assertNoSecrets(value, trail = '') {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (SECRET_KEYS.test(key)) throw new MigrationPreflightError('SECRET_INPUT_REJECTED', `Secret-bearing field is not accepted at ${trail || 'input'}`);
    assertNoSecrets(value[key], `${trail}.${key}`);
  }
}

function gate(status, code) { return Object.freeze({ status, code }); }
function evidenceGate(value, ready, missingCode, unknownCode) {
  if (value == null) return gate('unknown', unknownCode);
  return ready(value) ? gate('ready', 'VERIFIED') : gate('missing', missingCode);
}
function decimal(value, label) {
  try {
    const result = BigInt(value);
    if (result < 0n) throw new Error();
    return result;
  } catch { throw new MigrationPreflightError('INVALID_CAPACITY_INPUT', `${label} must be a non-negative integer`); }
}
function multiplyBps(bytes, bps) { return (bytes * BigInt(bps) + 9999n) / 10000n; }

function validateEstimateModel(model) {
  if (model == null) return null;
  const result = {};
  for (const part of ESTIMATE_PARTS) {
    const range = model[part];
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) ||
        range[0] < 0 || range[1] < range[0]) {
      throw new MigrationPreflightError('INVALID_ESTIMATE_MODEL', `${part} must be an ordered [min,max] basis-point range`);
    }
    result[part] = range.slice();
  }
  return result;
}

async function measureTarget(target) {
  if (!target || typeof target.path !== 'string' || !path.isAbsolute(target.path)) {
    return { role: target && target.role, status: 'unknown', code: 'ABSOLUTE_CAPACITY_PATH_REQUIRED' };
  }
  try {
    const stat = await fs.lstat(target.path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { role: target.role, status: 'missing', code: 'CAPACITY_PATH_NOT_REAL_DIRECTORY' };
    const space = await fs.statfs(target.path, { bigint: true });
    return {
      role: target.role, status: 'measured', device: String(stat.dev),
      freeBytes: space.bavail * space.bsize,
      reserveBytes: target.reserveBytes == null ? 0n : decimal(target.reserveBytes, `${target.role}.reserveBytes`),
    };
  } catch (error) {
    return { role: target.role, status: error && error.code === 'ENOENT' ? 'missing' : 'unknown', code: 'CAPACITY_PATH_UNAVAILABLE' };
  }
}

function sourceMeasurements(inventory) {
  const byDomain = new Map();
  let sourceBytes = 0n, sqliteBytes = 0n, sqliteWalBytes = 0n, archiveBytes = 0n, documentBytes = 0n;
  for (const entry of inventory.entries) {
    const bytes = BigInt(entry.bytes);
    if (entry.kind === 'runtime' || entry.kind === 'sqlite-sidecar') sourceBytes += bytes;
    if (entry.domain === 'history' && entry.kind === 'runtime') sqliteBytes += bytes;
    if (entry.kind === 'sqlite-sidecar') sqliteWalBytes += bytes;
    if (entry.domain === 'archive-content') archiveBytes += bytes;
    if (entry.domain === 'documents') documentBytes += bytes;
    if (entry.kind === 'runtime') byDomain.set(entry.domain, (byDomain.get(entry.domain) || 0n) + bytes);
  }
  const candidates = [
    ['archive-gzip-payloads', archiveBytes], ['document-blob-payloads', documentBytes],
    ['sqlite-history-input', sqliteBytes + sqliteWalBytes],
  ].sort((a, b) => a[1] === b[1] ? a[0].localeCompare(b[0]) : (a[1] > b[1] ? -1 : 1));
  return { sourceBytes, sqliteBytes, sqliteWalBytes, archiveBytes, documentBytes, byDomain, dominant: candidates[0] };
}

function calculateEstimates(base, model) {
  if (!model) return null;
  const result = {};
  for (const part of ESTIMATE_PARTS) result[part] = model[part].map(value => multiplyBps(base, value));
  return result;
}

function requirementForRole(role, estimates) {
  if (role === 'staging') return estimates.staging;
  if (role === 'postgres') return [estimates.sql[0] + estimates.indexes[0] + estimates.wal[0], estimates.sql[1] + estimates.indexes[1] + estimates.wal[1]];
  return estimates[role];
}

async function assessMigrationPreflight(options) {
  if (!options || typeof options !== 'object') throw new TypeError('Preflight options are required');
  assertNoSecrets(options);
  if (typeof options.sourceRoot !== 'string' || !path.isAbsolute(options.sourceRoot)) throw new TypeError('An absolute sourceRoot is required');
  const inventory = await inspectPrivateDirectory(options.sourceRoot);
  const measured = sourceMeasurements(inventory);
  const estimateModel = validateEstimateModel(options.estimateModelBps);
  const estimates = calculateEstimates(measured.sourceBytes, estimateModel);

  const targetByRole = new Map();
  for (const target of options.capacityTargets || []) {
    if (!target || !CAPACITY_ROLES.includes(target.role) || targetByRole.has(target.role)) {
      throw new MigrationPreflightError('INVALID_CAPACITY_TARGET', 'Capacity targets require unique supported roles');
    }
    targetByRole.set(target.role, target);
  }
  const targetMeasurements = await Promise.all(CAPACITY_ROLES.map(role => measureTarget(targetByRole.get(role) || { role })));
  let capacityGate;
  if (!estimates || targetMeasurements.some(item => item.status === 'unknown')) capacityGate = gate('unknown', 'CAPACITY_ESTIMATE_OR_MEASUREMENT_INCOMPLETE');
  else if (targetMeasurements.some(item => item.status === 'missing')) capacityGate = gate('missing', 'CAPACITY_PATH_MISSING');
  else {
    const devices = new Map();
    for (const item of targetMeasurements) {
      const needed = requirementForRole(item.role, estimates)[1] + item.reserveBytes;
      const current = devices.get(item.device) || { freeBytes: item.freeBytes, requiredBytes: 0n };
      current.freeBytes = current.freeBytes < item.freeBytes ? current.freeBytes : item.freeBytes;
      current.requiredBytes += needed;
      devices.set(item.device, current);
    }
    capacityGate = [...devices.values()].every(item => item.freeBytes >= item.requiredBytes)
      ? gate('ready', 'MEASURED_FREE_SPACE_COVERS_ESTIMATED_UPPER_BOUND')
      : gate('missing', 'ESTIMATED_UPPER_BOUND_EXCEEDS_FREE_SPACE');
  }

  const roles = options.bootstrapRoles;
  const schema = options.schemaReadiness;
  const snapshot = options.frozenSnapshot;
  const gates = {
    runtimeInventory: inventory.classificationComplete ? gate('ready', 'CLASSIFICATION_COMPLETE') : gate('missing', 'CLASSIFICATION_BLOCKERS'),
    sourceVolumes: gate('ready', 'FILE_METADATA_MEASURED'),
    capacity: capacityGate,
    frozenSnapshot: evidenceGate(snapshot,
      value => value.verified === true && value.writersStopped === true && value.sourceFingerprintVerified === true && value.atomic === true,
      'FROZEN_SNAPSHOT_NOT_VERIFIED', 'FROZEN_SNAPSHOT_NOT_CHECKED'),
    bootstrapRoles: evidenceGate(roles,
      value => Array.isArray(value) && value.length > 0 && value.every(role => role && typeof role.purpose === 'string' && role.available === true && role.attributesVerified === true),
      'BOOTSTRAP_ROLE_REQUIREMENT_FAILED', 'BOOTSTRAP_ROLES_NOT_CHECKED'),
    schemaReadiness: evidenceGate(schema,
      value => value.checked === true && value.versionsMatched === true && value.driftDetected === false && value.invalidIndexes === 0 && value.unvalidatedConstraints === 0,
      'SCHEMA_DRIFT_OR_INVALID_OBJECTS', 'SCHEMA_READINESS_NOT_CHECKED'),
    backupRestore: evidenceGate(options.backupRestore,
      value => value.backupVerified === true && value.distinctRestoreVerified === true,
      'BACKUP_RESTORE_NOT_VERIFIED', 'BACKUP_RESTORE_NOT_CHECKED'),
    importValidation: evidenceGate(options.importValidation,
      value => value.completed === true && value.idempotent === true && value.differencesExplained === true,
      'IMPORT_VALIDATION_INCOMPLETE', 'IMPORT_VALIDATION_NOT_CHECKED'),
    rollbackRehearsal: evidenceGate(options.rollbackRehearsal,
      value => value.completed === true && value.postCheckpointCoverage === true,
      'ROLLBACK_REHEARSAL_INCOMPLETE', 'ROLLBACK_REHEARSAL_NOT_CHECKED'),
  };
  const statuses = Object.values(gates).map(value => value.status);
  const admission = statuses.includes('missing') ? 'blocked' : statuses.includes('unknown') ? 'incomplete' : 'ready';
  const publicReport = {
    schemaVersion: 1, mode: 'read-only-preflight', admission, gates,
    largestRemainingUnboundedPath: measured.dominant[1] > 0n
      ? { status: 'identified', code: measured.dominant[0], basis: 'file-metadata-proxy' }
      : { status: 'unknown', code: 'NO_MEASURABLE_SOURCE', basis: 'file-metadata-proxy' },
  };
  const privateMeasurements = {
    sourceBytes: measured.sourceBytes.toString(), sqliteBytes: measured.sqliteBytes.toString(),
    sqliteWalBytes: measured.sqliteWalBytes.toString(), archiveBytes: measured.archiveBytes.toString(),
    documentBytes: measured.documentBytes.toString(),
    estimates: estimates && Object.fromEntries(Object.entries(estimates).map(([key, range]) => [key, range.map(String)])),
    capacity: targetMeasurements.map(item => ({
      role: item.role, status: item.status, code: item.code,
      ...(item.freeBytes == null ? {} : { freeBytes: item.freeBytes.toString(), reserveBytes: item.reserveBytes.toString() }),
    })),
    classificationBlockerCount: inventory.blockers.length,
  };
  return { publicReport, privateMeasurements };
}

module.exports = { assessMigrationPreflight, MigrationPreflightError };
