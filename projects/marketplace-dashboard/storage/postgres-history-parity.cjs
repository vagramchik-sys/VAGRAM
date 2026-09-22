'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { encodeJson } = require('./postgres-json-repository.cjs');

class HistoryParityError extends Error { constructor(code, message) { super(message); this.name = 'HistoryParityError'; this.code = code; } }
const fail = (code, message) => { throw new HistoryParityError(code, message); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const scalar = value => typeof value === 'bigint' ? value.toString() : value;
const number = value => { const result = Number(value); if (!Number.isSafeInteger(result)) fail('PARITY_INVALID', 'History count exceeds safe integer range'); return result; };
const canonical = value => encodeJson(value, 320 * 1024 * 1024);
function sorted(rows) { return rows.sort((a, b) => Buffer.compare(canonical(a), canonical(b))); }
function identity(row) { return { sourceFile: row.source_file, contentHash: row.content_hash }; }

async function postgresHistoryInventory(client) {
  if (!client?.query) fail('INVALID_ARGUMENT', 'PostgreSQL query client is required');
  const ingestions = (await client.query(`SELECT source_file,content_hash,captured_at_text,source_kind FROM pult_history.ingestions`)).rows.map(row => ({ ...identity(row), capturedAt: row.captured_at_text, sourceKind: row.source_kind }));
  const snapshots = (await client.query(`SELECT i.source_file,i.content_hash,s.source_kind,s.market,s.store_id,s.day::text,s.source_actual_at_text,s.closed_confirmed,s.partial_reason FROM pult_history.snapshots s JOIN pult_history.ingestions i ON i.id=s.ingestion_id`)).rows.map(row => ({ ...identity(row), sourceKind: row.source_kind, market: row.market, storeId: row.store_id, day: row.day, sourceActualAt: row.source_actual_at_text, closed: row.closed_confirmed, partialReason: row.partial_reason }));
  const facts = (await client.query(`SELECT i.source_file,i.content_hash,s.source_kind,s.store_id,s.day::text,f.product_id,f.observed_at_text,f.units,f.revenue,f.sold_units,f.returned_units,f.realized,f.ads,f.unknown_unit_rows::text FROM pult_history.facts f JOIN pult_history.snapshots s ON s.id=f.snapshot_id JOIN pult_history.ingestions i ON i.id=s.ingestion_id`)).rows.map(row => ({ ...identity(row), sourceKind: row.source_kind, storeId: row.store_id, day: row.day, productId: row.product_id, observedAt: row.observed_at_text, units: row.units, revenue: row.revenue, soldUnits: row.sold_units, returnedUnits: row.returned_units, realized: row.realized, ads: row.ads, unknownUnitRows: number(row.unknown_unit_rows) }));
  const events = (await client.query(`SELECT i.source_file,i.content_hash,s.source_kind,s.store_id,s.day::text,e.product_id,e.occurred_at_text,e.amount FROM pult_history.order_events e JOIN pult_history.snapshots s ON s.id=e.snapshot_id JOIN pult_history.ingestions i ON i.id=s.ingestion_id`)).rows.map(row => ({ ...identity(row), sourceKind: row.source_kind, storeId: row.store_id, day: row.day, productId: row.product_id, occurredAt: row.occurred_at_text, amount: row.amount }));
  const names = (await client.query(`SELECT market,store_id,product_id,name,source_actual_at_text FROM pult_history.product_names`)).rows.map(row => ({ market: row.market, storeId: row.store_id, productId: row.product_id, name: row.name, sourceActualAt: row.source_actual_at_text }));
  const aliases = (await client.query(`SELECT market,store_id,alias,product_id,source_actual_at_text FROM pult_history.product_aliases`)).rows.map(row => ({ market: row.market, storeId: row.store_id, alias: row.alias, productId: row.product_id, sourceActualAt: row.source_actual_at_text }));
  const versions = (await client.query(`SELECT source_file,content_hash,captured_at_text,source_mtime,source_bytes::text,archive_bytes::text,facts_status,encode(archive_gzip_hash,'hex') gzip_hash FROM pult_history.archive_versions`)).rows.map(row => ({ ...identity(row), capturedAt: row.captured_at_text, sourceMtime: row.source_mtime, sourceBytes: row.source_bytes, archiveBytes: row.archive_bytes, factsStatus: row.facts_status, gzipHash: row.gzip_hash }));
  const latest = (await client.query(`SELECT source_file,stamp,content_hash FROM pult_history.archive_latest`)).rows.map(row => ({ sourceFile: row.source_file, stamp: row.stamp, contentHash: row.content_hash }));
  const state = (await client.query(`SELECT key,value FROM pult_history.archive_state`)).rows.map(row => ({ key: row.key, value: row.value }));
  return Object.fromEntries(Object.entries({ ingestions, snapshots, facts, events, names, aliases, versions, latest, state }).map(([key, rows]) => [key, sorted(rows)]));
}

async function legacyHistoryInventory({ productsFile, archiveFile, historyRoot } = {}) {
  for (const file of [productsFile, archiveFile]) if (typeof file !== 'string' || !path.isAbsolute(file)) fail('INVALID_ARGUMENT', 'Legacy SQLite paths must be absolute');
  if (typeof historyRoot !== 'string' || !path.isAbsolute(historyRoot)) fail('INVALID_ARGUMENT', 'historyRoot must be absolute');
  const products = new DatabaseSync(productsFile, { readOnly: true }), archive = new DatabaseSync(archiveFile, { readOnly: true });
  try {
    const ingestions = products.prepare('SELECT source_file,content_hash,captured_at,source_kind FROM ingestions').all().map(row => ({ ...identity(row), capturedAt: row.captured_at, sourceKind: row.source_kind }));
    const snapshots = products.prepare('SELECT i.source_file,i.content_hash,s.source_kind,s.market,s.store_id,s.day,s.source_actual_at,s.closed_confirmed,s.partial_reason FROM snapshots s JOIN ingestions i ON i.id=s.ingestion_id').all().map(row => ({ ...identity(row), sourceKind: row.source_kind, market: row.market, storeId: row.store_id, day: row.day, sourceActualAt: row.source_actual_at, closed: Boolean(row.closed_confirmed), partialReason: row.partial_reason }));
    const facts = products.prepare('SELECT i.source_file,i.content_hash,s.source_kind,s.store_id,s.day,f.product_id,f.observed_at,f.units,f.revenue,f.sold_units,f.returned_units,f.realized,f.ads,f.unknown_unit_rows FROM facts f JOIN snapshots s ON s.id=f.snapshot_id JOIN ingestions i ON i.id=s.ingestion_id').all().map(row => ({ ...identity(row), sourceKind: row.source_kind, storeId: row.store_id, day: row.day, productId: row.product_id, observedAt: row.observed_at, units: row.units, revenue: row.revenue, soldUnits: row.sold_units, returnedUnits: row.returned_units, realized: row.realized, ads: row.ads, unknownUnitRows: number(row.unknown_unit_rows) }));
    const events = products.prepare('SELECT i.source_file,i.content_hash,s.source_kind,s.store_id,s.day,e.product_id,e.occurred_at,e.amount FROM order_events e JOIN snapshots s ON s.id=e.snapshot_id JOIN ingestions i ON i.id=s.ingestion_id').all().map(row => ({ ...identity(row), sourceKind: row.source_kind, storeId: row.store_id, day: row.day, productId: row.product_id, occurredAt: row.occurred_at, amount: row.amount }));
    const names = products.prepare('SELECT market,store_id,product_id,name,source_actual_at FROM product_names').all().map(row => ({ market: row.market, storeId: row.store_id, productId: row.product_id, name: row.name, sourceActualAt: row.source_actual_at }));
    const aliases = products.prepare('SELECT market,store_id,alias,product_id,source_actual_at FROM product_aliases').all().map(row => ({ market: row.market, storeId: row.store_id, alias: row.alias, productId: row.product_id, sourceActualAt: row.source_actual_at }));
    const versions = [];
    for (const row of archive.prepare('SELECT source_file,content_hash,captured_at,source_mtime,source_bytes,archive_bytes,object_path,facts_status FROM versions').iterate()) {
      const file = path.resolve(historyRoot, row.object_path), relative = path.relative(historyRoot, file);
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('PARITY_INVALID', 'Archive object path escapes history root');
      const stat = await fs.lstat(file).catch(() => null); if (!stat?.isFile() || stat.isSymbolicLink()) fail('PARITY_INVALID', 'Archive object is missing or unsafe');
      const gzip = await fs.readFile(file); if (String(gzip.length) !== String(row.archive_bytes)) fail('PARITY_INVALID', 'Archive byte count differs');
      versions.push({ ...identity(row), capturedAt: row.captured_at, sourceMtime: row.source_mtime, sourceBytes: String(row.source_bytes), archiveBytes: String(row.archive_bytes), factsStatus: row.facts_status, gzipHash: digest(gzip) });
    }
    const latest = archive.prepare('SELECT source_file,stamp,content_hash FROM latest').all().map(row => ({ sourceFile: row.source_file, stamp: row.stamp, contentHash: row.content_hash }));
    const state = archive.prepare('SELECT key,value FROM state').all().map(row => ({ key: row.key, value: row.value }));
    return Object.fromEntries(Object.entries({ ingestions, snapshots, facts, events, names, aliases, versions, latest, state }).map(([key, rows]) => [key, sorted(rows)]));
  } finally { products.close(); archive.close(); }
}

function compareHistoryInventories(expected, actual) {
  let equal = false; try { equal = canonical(expected).equals(canonical(actual)); } catch {}
  if (!equal) fail('PARITY_MISMATCH', 'Staged legacy history differs from the PostgreSQL business inventory');
  return { matched: true, sha256: digest(canonical(expected)), sections: Object.fromEntries(Object.entries(expected).map(([key, rows]) => [key, rows.length])) };
}

function summarizeHistoryInventory(inventory) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) fail('PARITY_INVALID', 'History inventory is invalid');
  return Object.fromEntries(Object.entries(inventory).map(([key, rows]) => {
    if (!Array.isArray(rows)) fail('PARITY_INVALID', 'History inventory section is invalid');
    return [key, { count: String(rows.length), sha256: digest(canonical(rows)) }];
  }));
}

function compareHistorySummary(expected, inventory) {
  const actual = summarizeHistoryInventory(inventory);
  let equal = false; try { equal = canonical(expected).equals(canonical(actual)); } catch {}
  if (!equal) fail('PARITY_MISMATCH', 'Staged legacy history differs from the PostgreSQL business summary');
  return { matched: true, expected, actual };
}

module.exports = { postgresHistoryInventory, legacyHistoryInventory, summarizeHistoryInventory, compareHistoryInventories, compareHistorySummary, HistoryParityError };
