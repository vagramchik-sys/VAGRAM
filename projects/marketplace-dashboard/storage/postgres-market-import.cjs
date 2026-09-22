'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireMutationFence } = require('./postgres-write-fence.cjs');

const BATCH_SIZE = 1000;
const DATA_FILE = /^data-((?:wb-)?[0-9]+)\.json$/u;
const ARRAY_SPECS = Object.freeze([
  { source: 'categoryTree', table: 'category_tree_rows', columns: ['category_id'], typed: row => [key(row?.description_category_id)] },
  { source: 'operations', table: 'finance_operations', columns: ['operation_id', 'operation_day', 'operation_type'], typed: operationFields },
  { source: 'products', table: 'products', columns: ['product_id', 'sku', 'offer_id'], typed: productFields },
  { source: 'stockRows', table: 'stock_rows', columns: ['product_id', 'sku', 'warehouse_id'], typed: stockRowFields },
  { source: 'stocks', table: 'stocks', columns: ['product_id', 'offer_id'], typed: row => [key(row?.product_id), key(row?.offer_id)] }
]);

class MarketImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketImportError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new MarketImportError(code, message); };
const sha256 = value => crypto.createHash('sha256').update(value).digest();
const equal = (left, right) => Buffer.from(left).equals(Buffer.from(right));
function key(value) {
  if (typeof value === 'string' && value.length) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}
function day(value) {
  if (typeof value !== 'string') return null;
  const result = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(result)) return null;
  const parsed = new Date(`${result}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === result ? result : null;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`;
}
const rowHash = row => sha256(Buffer.from(canonical(row), 'utf8'));
function productFields(row) {
  return [key(row?.product_id ?? row?.id), key(row?.sku ?? row?.sources?.[0]?.sku ?? row?.nmId), key(row?.offer_id ?? row?.vendorCode)];
}
function operationFields(row) {
  let id = key(row?.operation_id ?? row?.accrual_id);
  if (!id && key(row?.rrdId)) id = key(row?.reportId) ? `${key(row.reportId)}:${key(row.rrdId)}` : key(row.rrdId);
  return [id, day(row?.date ?? row?.rrDate), key(row?.operation_type ?? row?.sellerOperName ?? row?.docTypeName)];
}
function stockRowFields(row) {
  const product = key(row?.product_id ?? row?.nmId);
  return [product, key(row?.sku ?? row?.nmId), key(row?.warehouseId ?? row?.warehouseName)];
}
function metadata(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).filter(([, value]) => !Array.isArray(value)));
}
function expectedCounts(snapshot) {
  const counts = Object.fromEntries(ARRAY_SPECS.map(spec => [spec.source, Array.isArray(snapshot[spec.source]) ? snapshot[spec.source].length : 0]));
  counts.stockItems = (snapshot.stocks || []).reduce((sum, row) => sum + (Array.isArray(row?.stocks) ? row.stocks.length : 0), 0);
  counts.financeOperationSkus = (snapshot.operations || []).reduce((sum, row) => sum + operationSkuRows(row).length, 0);
  return counts;
}
function aggregateDigestStart() { return crypto.createHash('sha256'); }
function digestRow(hash, kind, index, digest) {
  hash.update(kind).update('\0').update(String(index)).update('\0').update(digest);
}
function safeProgress(callback, value) {
  if (callback) callback(Object.freeze(value));
}
function placeholders(rows, width, start = 1) {
  return rows.map((_, row) => `(${Array.from({ length: width }, (__, column) => `$${start + row * width + column}`).join(',')})`).join(',');
}
function databaseError(error) {
  if (error instanceof MarketImportError) return error;
  if (error?.code === '40001') return new MarketImportError('SERIALIZATION_RETRY', 'Serialization conflict; retry the same import source');
  return new MarketImportError('DATABASE_ERROR', 'PostgreSQL market import failed');
}

async function exactDocument(client, logicalName, bytes, digest) {
  const result = await client.query(
    `INSERT INTO pult_market.source_documents(logical_name,sha256,exact_bytes,byte_length)
     VALUES($1,$2,$3,$4) ON CONFLICT(logical_name,sha256) DO UPDATE SET logical_name=EXCLUDED.logical_name
     RETURNING source_document_id,sha256,byte_length::text AS byte_length,exact_bytes`,
    [logicalName, digest, bytes, String(bytes.length)]
  );
  const row = result.rows[0];
  if (!row || !equal(row.sha256, digest) || String(row.byte_length) !== String(bytes.length) || !equal(sha256(Buffer.from(row.exact_bytes)), digest))
    fail('SOURCE_DOCUMENT_CONFLICT', 'Stored source document does not match the import source');
  return String(row.source_document_id);
}

async function importRegistry(pool, sourceDir) {
  const file = path.join(sourceDir, 'stores.json');
  let stat;
  try { stat = await fs.lstat(file); } catch { fail('SOURCE_MISSING', 'stores.json is required'); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_SOURCE', 'stores.json must be a regular file');
  const bytes = await fs.readFile(file);
  let registry;
  try { registry = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_SOURCE', 'stores.json is not valid JSON'); }
  if (!registry || Array.isArray(registry) || typeof registry !== 'object') fail('INVALID_SOURCE', 'stores.json must contain an object registry');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await acquireMutationFence(client);
    const documentId = await exactDocument(client, 'stores.json', bytes, sha256(bytes));
    for (const [storeId, row] of Object.entries(registry)) {
      if (!/^(?:wb-)?[0-9]+$/u.test(storeId) || !row || Array.isArray(row) || typeof row !== 'object')
        fail('INVALID_SOURCE', 'stores.json contains an invalid store entry');
      const market = storeId.startsWith('wb-') ? 'WB' : 'Ozon';
      const existing = (await client.query('SELECT market FROM pult_market.stores WHERE store_id=$1 FOR UPDATE', [storeId])).rows[0];
      if (existing && existing.market !== market) fail('STORE_CONFLICT', 'Existing store market conflicts with the registry');
      await client.query(
        `INSERT INTO pult_market.stores(store_id,market,display_name,registry_row,registry_source_document_id)
         VALUES($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT(store_id) DO UPDATE SET display_name=EXCLUDED.display_name,registry_row=EXCLUDED.registry_row,
           registry_source_document_id=EXCLUDED.registry_source_document_id,updated_at=clock_timestamp()`,
        [storeId, market, typeof row.name === 'string' ? row.name : null, JSON.stringify(row), documentId]
      );
    }
    await client.query('COMMIT');
    return new Set(Object.keys(registry));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw databaseError(error);
  } finally { client.release(); }
}

async function insertRows(client, snapshotId, storeId, spec, rows, progress) {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const width = 5 + spec.columns.length;
    const columns = ['snapshot_id', 'store_id', 'source_index', ...spec.columns, 'row_sha256', 'raw_row'];
    const values = [];
    batch.forEach((row, localIndex) => {
      const index = offset + localIndex;
      values.push(snapshotId, storeId, index, ...spec.typed(row), rowHash(row), JSON.stringify(row));
    });
    const inserted = await client.query(
      `INSERT INTO pult_market.${spec.table}(${columns.join(',')}) VALUES ${placeholders(batch, width)}`, values
    );
    if (inserted.rowCount !== batch.length) fail('ROW_CONFLICT', 'Source row insert count does not match the batch');
    safeProgress(progress, { stage: 'rows', count: Math.min(offset + batch.length, rows.length), total: rows.length });
  }
}

function operationSkuRows(operation) {
  const result = [];
  const add = (sku, raw) => { const normalized = key(sku); if (normalized) result.push({ sku: normalized, raw }); };
  add(operation?.nmId, null);
  for (const item of operation?.posting?.products || []) add(item?.sku, item);
  for (const item of operation?.item_fees?.fees || []) add(item?.sku, item);
  return result;
}
function stockItemRows(snapshot) {
  const result = [];
  (snapshot.stocks || []).forEach((row, sourceIndex) => (row?.stocks || []).forEach((item, itemIndex) => result.push({
    sourceIndex, itemIndex, sku: key(item?.sku ?? row?.product_id),
    warehouse: key(item?.warehouse ?? item?.warehouse_ids?.[0]), raw: item
  })));
  return result;
}
async function insertDerived(client, snapshotId, storeId, snapshot, progress) {
  const stockItems = stockItemRows(snapshot).map(item => [
    snapshotId, storeId, item.sourceIndex, item.itemIndex, item.sku, item.warehouse, JSON.stringify(item.raw)
  ]);
  for (let offset = 0; offset < stockItems.length; offset += BATCH_SIZE) {
    const batch = stockItems.slice(offset, offset + BATCH_SIZE);
    await client.query(`INSERT INTO pult_market.stock_items(snapshot_id,store_id,stock_source_index,item_index,sku,warehouse,raw_row)
      VALUES ${placeholders(batch, 7)}`, batch.flat());
  }
  const operations = snapshot.operations || [];
  for (let offset = 0; offset < operations.length; offset += BATCH_SIZE) {
    const values = [];
    for (let sourceIndex = offset; sourceIndex < Math.min(offset + BATCH_SIZE, operations.length); sourceIndex++) {
      operationSkuRows(operations[sourceIndex]).forEach((item, itemIndex) => values.push([
        snapshotId, storeId, sourceIndex, itemIndex, item.sku, operationFields(operations[sourceIndex])[1], item.raw == null ? null : JSON.stringify(item.raw)
      ]));
    }
    for (let itemOffset = 0; itemOffset < values.length; itemOffset += BATCH_SIZE) {
      const batch = values.slice(itemOffset, itemOffset + BATCH_SIZE);
      await client.query(`INSERT INTO pult_market.finance_operation_skus
        (snapshot_id,store_id,operation_source_index,item_index,sku,operation_day,raw_item)
        VALUES ${placeholders(batch, 7)}`, batch.flat());
    }
    safeProgress(progress, { stage: 'derived-rows', count: Math.min(offset + BATCH_SIZE, operations.length), total: operations.length });
  }
}

async function verifySnapshot(client, snapshotId, storeId, snapshot) {
  const expected = expectedCounts(snapshot);
  const verified = {};
  const sourceAggregate = aggregateDigestStart();
  const sqlAggregate = aggregateDigestStart();
  for (const spec of ARRAY_SPECS) {
    const rows = Array.isArray(snapshot[spec.source]) ? snapshot[spec.source] : [];
    rows.forEach((row, index) => digestRow(sourceAggregate, spec.source, index, rowHash({ raw: row, typed: spec.typed(row) })));
    const count = await client.query(`SELECT count(*)::text AS count FROM pult_market.${spec.table} WHERE snapshot_id=$1`, [snapshotId]);
    verified[spec.source] = Number(count.rows[0].count);
    if (verified[spec.source] !== expected[spec.source]) fail('VERIFY_COUNT_MISMATCH', 'Imported row count does not match source');
    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const result = await client.query(
        `SELECT store_id,source_index,${spec.columns.map(column => column === 'operation_day' ? 'operation_day::text AS operation_day' : column).join(',')}${spec.columns.length ? ',' : ''}row_sha256,raw_row FROM pult_market.${spec.table}
          WHERE snapshot_id=$1 AND source_index >= $2 ORDER BY source_index LIMIT $3`, [snapshotId, offset, BATCH_SIZE]
      );
      if (result.rows.length !== Math.min(BATCH_SIZE, rows.length - offset)) fail('VERIFY_COUNT_MISMATCH', 'Source verification page is incomplete');
      for (const row of result.rows) {
        if (row.store_id !== storeId) fail('VERIFY_TYPED_MISMATCH', 'Stored row is assigned to the wrong store');
        const index = Number(row.source_index), rawDigest = rowHash(row.raw_row);
        if (!equal(rawDigest, row.row_sha256)) fail('VERIFY_DIGEST_MISMATCH', 'Stored source row hash does not match JSON');
        // A business date has no timezone; DATE must arrive as SQL text, not a local-midnight JS Date.
        const typed = spec.columns.map(column => row[column] == null ? null : String(row[column]));
        if (canonical(typed) !== canonical(spec.typed(rows[index]))) fail('VERIFY_TYPED_MISMATCH', 'Typed source projection does not match JSON');
        digestRow(sqlAggregate, spec.source, index, rowHash({ raw: row.raw_row, typed }));
      }
    }
  }
  const expectedStockItems = stockItemRows(snapshot);
  const stockCount = await client.query('SELECT count(*)::text AS count FROM pult_market.stock_items WHERE snapshot_id=$1', [snapshotId]);
  verified.stockItems = Number(stockCount.rows[0].count);
  if (verified.stockItems !== expected.stockItems) fail('VERIFY_COUNT_MISMATCH', 'Derived stock row count does not match source');
  for (let offset = 0; offset < expectedStockItems.length; offset += BATCH_SIZE) {
    const result = await client.query(`SELECT store_id,stock_source_index,item_index,sku,warehouse,raw_row
      FROM pult_market.stock_items WHERE snapshot_id=$1 ORDER BY stock_source_index,item_index OFFSET $2 LIMIT $3`, [snapshotId, offset, BATCH_SIZE]);
    if (result.rows.length !== Math.min(BATCH_SIZE, expectedStockItems.length - offset)) fail('VERIFY_COUNT_MISMATCH', 'Stock verification page is incomplete');
    result.rows.forEach((row, index) => {
      if (row.store_id !== storeId) fail('VERIFY_DERIVED_MISMATCH', 'Derived stock row is assigned to the wrong store');
      const wanted = expectedStockItems[offset + index];
      const actual = { sourceIndex: Number(row.stock_source_index), itemIndex: Number(row.item_index), sku: row.sku, warehouse: row.warehouse, raw: row.raw_row };
      if (canonical(actual) !== canonical(wanted)) fail('VERIFY_DERIVED_MISMATCH', 'Derived stock projection does not match source');
    });
  }
  const expectedOperationSkus = [];
  (snapshot.operations || []).forEach((operation, sourceIndex) => operationSkuRows(operation).forEach((item, itemIndex) => expectedOperationSkus.push({
    sourceIndex, itemIndex, sku: item.sku, operationDay: operationFields(operation)[1], raw: item.raw
  })));
  const skuCount = await client.query('SELECT count(*)::text AS count FROM pult_market.finance_operation_skus WHERE snapshot_id=$1', [snapshotId]);
  verified.financeOperationSkus = Number(skuCount.rows[0].count);
  if (verified.financeOperationSkus !== expected.financeOperationSkus) fail('VERIFY_COUNT_MISMATCH', 'Derived operation SKU count does not match source');
  for (let offset = 0; offset < expectedOperationSkus.length; offset += BATCH_SIZE) {
    const result = await client.query(`SELECT store_id,operation_source_index,item_index,sku,operation_day::text AS operation_day,raw_item
      FROM pult_market.finance_operation_skus WHERE snapshot_id=$1 ORDER BY operation_source_index,item_index,sku OFFSET $2 LIMIT $3`, [snapshotId, offset, BATCH_SIZE]);
    if (result.rows.length !== Math.min(BATCH_SIZE, expectedOperationSkus.length - offset)) fail('VERIFY_COUNT_MISMATCH', 'Operation verification page is incomplete');
    result.rows.forEach((row, index) => {
      if (row.store_id !== storeId) fail('VERIFY_DERIVED_MISMATCH', 'Derived operation row is assigned to the wrong store');
      const wanted = expectedOperationSkus[offset + index];
      const actual = { sourceIndex: Number(row.operation_source_index), itemIndex: Number(row.item_index), sku: row.sku,
        operationDay: row.operation_day, raw: row.raw_item };
      if (canonical(actual) !== canonical(wanted)) fail('VERIFY_DERIVED_MISMATCH', 'Derived operation SKU projection does not match source');
    });
  }
  const sourceDigest = sourceAggregate.digest();
  const storedDigest = sqlAggregate.digest();
  if (!equal(sourceDigest, storedDigest)) fail('VERIFY_DIGEST_MISMATCH', 'Imported row digest does not match source');
  return { counts: verified, digest: sourceDigest };
}

async function importSnapshot(pool, sourceDir, name, knownStores, progress) {
  const match = DATA_FILE.exec(name);
  const storeId = match[1];
  if (!knownStores.has(storeId)) fail('STORE_MISSING', 'Snapshot store is absent from stores.json');
  const file = path.join(sourceDir, name);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_SOURCE', 'Snapshot must be a regular file');
  const bytes = await fs.readFile(file), sourceHash = sha256(bytes);
  let snapshot;
  try { snapshot = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_SOURCE', 'Snapshot is not valid JSON'); }
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== 'object') fail('INVALID_SOURCE', 'Snapshot root must be an object');
  const handledArrays = new Set(ARRAY_SPECS.map(spec => spec.source));
  for (const [field, value] of Object.entries(snapshot)) if (Array.isArray(value) && !handledArrays.has(field))
    fail('UNHANDLED_SOURCE_ARRAY', 'Snapshot contains an unhandled top-level array');
  for (const spec of ARRAY_SPECS) if (snapshot[spec.source] !== undefined && !Array.isArray(snapshot[spec.source]))
    fail('INVALID_SOURCE', 'Snapshot array has an invalid shape');
  for (const row of snapshot.stocks || []) if (row?.stocks !== undefined && !Array.isArray(row.stocks))
    fail('INVALID_SOURCE', 'Nested stock rows must be an array');
  for (const row of snapshot.operations || []) {
    if (row?.posting?.products !== undefined && !Array.isArray(row.posting.products)) fail('INVALID_SOURCE', 'Posting products must be an array');
    if (row?.item_fees?.fees !== undefined && !Array.isArray(row.item_fees.fees)) fail('INVALID_SOURCE', 'Item fees must be an array');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await acquireMutationFence(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`market:${storeId}`]);
    const existing = (await client.query(
      `SELECT v.snapshot_id,v.complete,v.source_byte_length::text AS source_byte_length,v.row_digest,
              d.exact_bytes,d.sha256 AS document_sha256,d.byte_length::text AS document_byte_length
         FROM pult_market.snapshot_versions v JOIN pult_market.source_documents d USING(source_document_id)
        WHERE v.store_id=$1 AND v.source_sha256=$2`,
      [storeId, sourceHash]
    )).rows[0];
    if (existing) {
      const storedBytes = Buffer.from(existing.exact_bytes || []);
      if (!existing.complete || String(existing.source_byte_length) !== String(bytes.length) ||
          String(existing.document_byte_length) !== String(bytes.length) || !equal(existing.document_sha256, sourceHash) ||
          !equal(sha256(storedBytes), sourceHash))
        fail('SNAPSHOT_CONFLICT', 'Existing snapshot identity is incomplete or conflicting');
      const verified = await verifySnapshot(client, existing.snapshot_id, storeId, snapshot);
      if (!existing.row_digest || !equal(existing.row_digest, verified.digest))
        fail('SNAPSHOT_CONFLICT', 'Existing snapshot verification digest conflicts with source');
      await client.query('COMMIT');
      return { imported: false, verified: true, snapshotId: existing.snapshot_id };
    }
    const documentId = await exactDocument(client, name, bytes, sourceHash);
    const snapshotId = crypto.randomUUID();
    const counts = expectedCounts(snapshot);
    await client.query(
      `INSERT INTO pult_market.snapshot_versions(snapshot_id,store_id,source_document_id,source_sha256,source_byte_length,source_metadata,expected_counts)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [snapshotId, storeId, documentId, sourceHash, String(bytes.length), JSON.stringify(metadata(snapshot)), JSON.stringify(counts)]
    );
    for (const spec of ARRAY_SPECS) await insertRows(client, snapshotId, storeId, spec, snapshot[spec.source] || [], progress);
    await insertDerived(client, snapshotId, storeId, snapshot, progress);
    const verified = await verifySnapshot(client, snapshotId, storeId, snapshot);
    await client.query(
      `UPDATE pult_market.snapshot_versions SET verified_counts=$2::jsonb,row_digest=$3,complete=true,completed_at=clock_timestamp()
        WHERE snapshot_id=$1 AND NOT complete`, [snapshotId, JSON.stringify(verified.counts), verified.digest]
    );
    await client.query(
      `INSERT INTO pult_market.current_snapshots(store_id,snapshot_id) VALUES($1,$2)
       ON CONFLICT(store_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,switched_at=clock_timestamp()`, [storeId, snapshotId]
    );
    await client.query('COMMIT');
    return { imported: true, verified: true, snapshotId };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw databaseError(error);
  } finally { client.release(); }
}

async function importMarket({ pool, sourceDir, onProgress } = {}) {
  if (!pool || typeof pool.connect !== 'function') fail('INVALID_ARGUMENT', 'pool must provide connect');
  if (typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir)) fail('INVALID_ARGUMENT', 'sourceDir must be absolute');
  if (onProgress !== undefined && typeof onProgress !== 'function') fail('INVALID_ARGUMENT', 'onProgress must be a function');
  const root = await fs.lstat(sourceDir).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) fail('INVALID_SOURCE', 'sourceDir must be a real directory');
  const knownStores = await importRegistry(pool, sourceDir);
  const names = (await fs.readdir(sourceDir)).filter(name => DATA_FILE.test(name)).sort();
  const result = { stores: knownStores.size, imported: 0, reused: 0, verified: 0 };
  for (const name of names) {
    safeProgress(onProgress, { stage: 'snapshot', count: result.imported + result.reused, total: names.length });
    const item = await importSnapshot(pool, sourceDir, name, knownStores, onProgress);
    if (item.imported) result.imported++; else result.reused++;
    if (item.verified) result.verified++;
  }
  safeProgress(onProgress, { stage: 'complete', count: names.length, total: names.length });
  return result;
}

module.exports = { importMarket, MarketImportError, BATCH_SIZE, canonical, requestRowHash: rowHash };
