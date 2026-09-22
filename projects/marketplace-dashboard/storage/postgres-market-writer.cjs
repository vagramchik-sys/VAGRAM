'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { sourceKey } = require('./postgres-document-import.cjs');

const BATCH = 1000;
const SPECS = Object.freeze([
  { source: 'categoryTree', table: 'category_tree_rows', columns: ['category_id'], typed: row => [key(row?.description_category_id)] },
  { source: 'operations', table: 'finance_operations', columns: ['operation_id', 'operation_day', 'operation_type'], typed: operationFields },
  { source: 'products', table: 'products', columns: ['product_id', 'sku', 'offer_id'], typed: productFields },
  { source: 'stockRows', table: 'stock_rows', columns: ['product_id', 'sku', 'warehouse_id'], typed: stockRowFields },
  { source: 'stocks', table: 'stocks', columns: ['product_id', 'offer_id'], typed: row => [key(row?.product_id), key(row?.offer_id)] }
]);

class MarketWriterError extends Error { constructor(code, message) { super(message); this.name = 'MarketWriterError'; this.code = code; } }
const fail = (code, message) => { throw new MarketWriterError(code, message); };
const quote = value => `"${value.replace(/"/gu, '""')}"`;
function schemaName(value) { if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(value)) fail('INVALID_ARGUMENT', 'schema is invalid'); return quote(value); }
function key(value) { return typeof value === 'string' && value ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'bigint' ? value.toString() : null; }
function day(value) { if (typeof value !== 'string') return null; const result = value.slice(0, 10), parsed = new Date(`${result}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/u.test(result) && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === result ? result : null; }
function operationFields(row) { let id = key(row?.operation_id ?? row?.accrual_id); if (!id && key(row?.rrdId)) id = key(row?.reportId) ? `${key(row.reportId)}:${key(row.rrdId)}` : key(row.rrdId); return [id, day(row?.date ?? row?.rrDate), key(row?.operation_type ?? row?.sellerOperName ?? row?.docTypeName)]; }
function productFields(row) { return [key(row?.product_id ?? row?.id), key(row?.sku ?? row?.sources?.[0]?.sku ?? row?.nmId), key(row?.offer_id ?? row?.vendorCode)]; }
function stockRowFields(row) { return [key(row?.product_id ?? row?.nmId), key(row?.sku ?? row?.nmId), key(row?.warehouseId ?? row?.warehouseName)]; }
function canonical(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`; }
const digest = value => crypto.createHash('sha256').update(value).digest();
const rowHash = row => digest(Buffer.from(canonical(row), 'utf8'));
const equal = (a, b) => Buffer.from(a || []).equals(Buffer.from(b || []));
const metadata = value => Object.fromEntries(Object.entries(value).filter(([, child]) => !Array.isArray(child)));
const presence = value => Object.fromEntries(SPECS.map(spec => [spec.source, Object.hasOwn(value, spec.source)]));
function operationSkus(operation) { const rows = [], add = (sku, raw) => { sku = key(sku); if (sku) rows.push({ sku, raw }); }; add(operation?.nmId, null); for (const row of operation?.posting?.products || []) add(row?.sku, row); for (const row of operation?.item_fees?.fees || []) add(row?.sku, row); return rows; }
function stockItems(snapshot) { const rows = []; (snapshot.stocks || []).forEach((stock, sourceIndex) => (stock?.stocks || []).forEach((raw, itemIndex) => rows.push({ sourceIndex, itemIndex, sku: key(raw?.sku ?? stock?.product_id), warehouse: key(raw?.warehouse ?? raw?.warehouse_ids?.[0]), raw }))); return rows; }
function counts(snapshot) { const value = Object.fromEntries(SPECS.map(spec => [spec.source, (snapshot[spec.source] || []).length])); value.stockItems = stockItems(snapshot).length; value.financeOperationSkus = (snapshot.operations || []).reduce((sum, row) => sum + operationSkus(row).length, 0); return value; }
function validateSnapshot(storeId, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('INVALID_SNAPSHOT', 'Snapshot root must be an object');
  const clientIds = storeId.startsWith('wb-') ? new Set([storeId, storeId.slice(3)]) : new Set([storeId]);
  if (!clientIds.has(String(snapshot.clientId ?? '')) || (storeId.startsWith('wb-') ? snapshot.market !== 'WB' : snapshot.market === 'WB')) fail('STORE_MISMATCH', 'Snapshot does not belong to the requested store');
  const allowed = new Set(SPECS.map(spec => spec.source));
  for (const [name, value] of Object.entries(snapshot)) if (Array.isArray(value) && !allowed.has(name)) fail('UNHANDLED_SOURCE_ARRAY', 'Snapshot contains an unhandled top-level array');
  for (const spec of SPECS) if (snapshot[spec.source] !== undefined && !Array.isArray(snapshot[spec.source])) fail('INVALID_SNAPSHOT', 'Snapshot array has an invalid shape');
  for (const row of snapshot.stocks || []) if (row?.stocks !== undefined && !Array.isArray(row.stocks)) fail('INVALID_SNAPSHOT', 'Nested stocks must be an array');
  for (const row of snapshot.operations || []) if (row?.posting?.products !== undefined && !Array.isArray(row.posting.products) || row?.item_fees?.fees !== undefined && !Array.isArray(row.item_fees.fees)) fail('INVALID_SNAPSHOT', 'Nested operation rows must be arrays');
}
const placeholders = (rows, width) => rows.map((_, r) => `(${Array.from({ length: width }, (__, c) => `$${r * width + c + 1}`).join(',')})`).join(',');
async function insertRows(client, ns, snapshotId, storeId, spec, rows) {
  for (let offset = 0; offset < rows.length; offset += BATCH) {
    const batch = rows.slice(offset, offset + BATCH), width = 5 + spec.columns.length, values = [];
    batch.forEach((row, index) => values.push(snapshotId, storeId, offset + index, ...spec.typed(row), rowHash(row), JSON.stringify(row)));
    await client.query(`INSERT INTO ${ns}.${quote(spec.table)}(${['snapshot_id', 'store_id', 'source_index', ...spec.columns, 'row_sha256', 'raw_row'].map(quote).join(',')}) VALUES ${placeholders(batch, width)}`, values);
  }
}
async function insertDerived(client, ns, snapshotId, storeId, snapshot) {
  const stocks = stockItems(snapshot).map(row => [snapshotId, storeId, row.sourceIndex, row.itemIndex, row.sku, row.warehouse, JSON.stringify(row.raw)]);
  for (let offset = 0; offset < stocks.length; offset += BATCH) { const batch = stocks.slice(offset, offset + BATCH); await client.query(`INSERT INTO ${ns}."stock_items"(snapshot_id,store_id,stock_source_index,item_index,sku,warehouse,raw_row) VALUES ${placeholders(batch, 7)}`, batch.flat()); }
  const operations = [];
  (snapshot.operations || []).forEach((row, sourceIndex) => operationSkus(row).forEach((item, itemIndex) => operations.push([snapshotId, storeId, sourceIndex, itemIndex, item.sku, operationFields(row)[1], item.raw == null ? null : JSON.stringify(item.raw)])));
  for (let offset = 0; offset < operations.length; offset += BATCH) { const batch = operations.slice(offset, offset + BATCH); await client.query(`INSERT INTO ${ns}."finance_operation_skus"(snapshot_id,store_id,operation_source_index,item_index,sku,operation_day,raw_item) VALUES ${placeholders(batch, 7)}`, batch.flat()); }
}
async function verify(client, ns, snapshotId, storeId, snapshot) {
  const aggregate = crypto.createHash('sha256'), actual = {};
  for (const spec of SPECS) {
    const source = snapshot[spec.source] || [];
    actual[spec.source] = Number((await client.query(`SELECT count(*)::text AS count FROM ${ns}.${quote(spec.table)} WHERE snapshot_id=$1`, [snapshotId])).rows[0].count);
    if (actual[spec.source] !== source.length) fail('VERIFY_FAILED', 'Normalized row count differs from snapshot');
    for (let offset = 0; offset < source.length; offset += BATCH) {
      const result = await client.query(`SELECT store_id,source_index,${spec.columns.map(column => column === 'operation_day' ? 'operation_day::text AS operation_day' : quote(column)).join(',')}${spec.columns.length ? ',' : ''}row_sha256,raw_row FROM ${ns}.${quote(spec.table)} WHERE snapshot_id=$1 AND source_index >= $2 ORDER BY source_index LIMIT $3`, [snapshotId, offset, BATCH]);
      if (result.rows.length !== Math.min(BATCH, source.length - offset)) fail('VERIFY_FAILED', 'Normalized verification page is incomplete');
      result.rows.forEach((row, localIndex) => { const index = offset + localIndex, typed = spec.columns.map(column => row[column] == null ? null : String(row[column])); if (row.store_id !== storeId || Number(row.source_index) !== index || !equal(row.row_sha256, rowHash(row.raw_row)) || canonical(typed) !== canonical(spec.typed(source[index])) || canonical(row.raw_row) !== canonical(source[index])) fail('VERIFY_FAILED', 'Normalized row differs from snapshot'); aggregate.update(spec.source).update('\0').update(String(index)).update('\0').update(rowHash({ raw: row.raw_row, typed })); });
    }
  }
  const expected = counts(snapshot), expectedStocks = stockItems(snapshot);
  actual.stockItems = Number((await client.query(`SELECT count(*)::text AS count FROM ${ns}."stock_items" WHERE snapshot_id=$1`, [snapshotId])).rows[0].count); if (actual.stockItems !== expectedStocks.length) fail('VERIFY_FAILED', 'Derived stock count differs from snapshot');
  for (let offset = 0; offset < expectedStocks.length; offset += BATCH) { const storedStocks = (await client.query(`SELECT store_id,stock_source_index,item_index,sku,warehouse,raw_row FROM ${ns}."stock_items" WHERE snapshot_id=$1 ORDER BY stock_source_index,item_index OFFSET $2 LIMIT $3`, [snapshotId, offset, BATCH])).rows; storedStocks.forEach((row, index) => { const wanted = expectedStocks[offset + index], got = { sourceIndex: Number(row.stock_source_index), itemIndex: Number(row.item_index), sku: row.sku, warehouse: row.warehouse, raw: row.raw_row }; if (row.store_id !== storeId || canonical(got) !== canonical(wanted)) fail('VERIFY_FAILED', 'Derived stock row differs from snapshot'); }); }
  const expectedSkus = []; (snapshot.operations || []).forEach((operation, sourceIndex) => operationSkus(operation).forEach((item, itemIndex) => expectedSkus.push({ sourceIndex, itemIndex, sku: item.sku, operationDay: operationFields(operation)[1], raw: item.raw })));
  actual.financeOperationSkus = Number((await client.query(`SELECT count(*)::text AS count FROM ${ns}."finance_operation_skus" WHERE snapshot_id=$1`, [snapshotId])).rows[0].count); if (actual.financeOperationSkus !== expectedSkus.length) fail('VERIFY_FAILED', 'Derived operation count differs from snapshot');
  for (let offset = 0; offset < expectedSkus.length; offset += BATCH) { const storedSkus = (await client.query(`SELECT store_id,operation_source_index,item_index,sku,operation_day::text AS operation_day,raw_item FROM ${ns}."finance_operation_skus" WHERE snapshot_id=$1 ORDER BY operation_source_index,item_index,sku OFFSET $2 LIMIT $3`, [snapshotId, offset, BATCH])).rows; storedSkus.forEach((row, index) => { const wanted = expectedSkus[offset + index], got = { sourceIndex: Number(row.operation_source_index), itemIndex: Number(row.item_index), sku: row.sku, operationDay: row.operation_day, raw: row.raw_item }; if (row.store_id !== storeId || canonical(got) !== canonical(wanted)) fail('VERIFY_FAILED', 'Derived operation row differs from snapshot'); }); }
  return { counts: actual, digest: aggregate.digest() };
}

function createMarketWriter({ stateStore, schema = 'pult_market' } = {}) {
  if (!stateStore || typeof stateStore.writeWithProjection !== 'function') fail('INVALID_ARGUMENT', 'stateStore with writeWithProjection is required');
  const ns = schemaName(schema);
  async function readCommand({ storeId, commandId } = {}) {
    if (typeof storeId !== 'string' || !/^(?:wb-)?[0-9]+$/u.test(storeId)) fail('INVALID_ARGUMENT', 'storeId is invalid');
    const sourcePath = `data-${storeId}.json`, logicalKey = sourceKey(sourcePath);
    const row = await stateStore.readCommand(logicalKey, commandId, { operation: 'write', sourceMapping: { sourcePath, logicalKey, domain: 'market-snapshots', mediaType: 'application/json' } });
    if (!row) return null;
    if (!row.result?.snapshotId || !row.after?.content) fail('PROJECTION_CONFLICT', 'Committed market command has no durable projection result');
    return { revision: row.after.revision, replayed: true, snapshotId: row.result.snapshotId, exactBytes: Buffer.from(row.after.content) };
  }
  async function publish({ storeId, exactBytes, expectedRevision, commandId } = {}) {
    if (typeof storeId !== 'string' || !/^(?:wb-)?[0-9]+$/u.test(storeId) || !Buffer.isBuffer(exactBytes)) fail('INVALID_ARGUMENT', 'storeId and exactBytes are required');
    const body = Buffer.from(exactBytes), sourcePath = `data-${storeId}.json`, logicalKey = sourceKey(sourcePath);
    let snapshot; try { snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { fail('INVALID_SNAPSHOT', 'Snapshot must be strict UTF-8 JSON'); }
    validateSnapshot(storeId, snapshot);
    const sourceSha = digest(body), mapping = { sourcePath, logicalKey, domain: 'market-snapshots', mediaType: 'application/json' };
    const saved = await stateStore.writeWithProjection(logicalKey, body, { expectedRevision, commandId, mediaType: 'application/json', sourceMapping: mapping }, async (client, context) => {
      const store = (await client.query(`SELECT market FROM ${ns}."stores" WHERE store_id=$1`, [storeId])).rows[0];
      if (!store || store.market !== (storeId.startsWith('wb-') ? 'WB' : 'Ozon')) fail('STORE_MISSING', 'Store is absent from normalized registry');
      const current = (await client.query(`SELECT v.snapshot_id,d.exact_bytes,d.sha256 FROM ${ns}."current_snapshots" c JOIN ${ns}."snapshot_versions" v USING(snapshot_id) JOIN ${ns}."source_documents" d USING(source_document_id) WHERE c.store_id=$1 FOR UPDATE OF c`, [storeId])).rows[0];
      if (!context.before || context.before.deleted) { if (current) fail('PROJECTION_CONFLICT', 'Normalized current snapshot has no matching document'); }
      else if (!current || !context.before.content || !equal(current.exact_bytes, context.before.content) || !equal(current.sha256, context.before.sha256)) fail('PROJECTION_CONFLICT', 'Normalized current snapshot differs from the document before-image');
      const existing = (await client.query(`SELECT v.snapshot_id,v.complete,v.source_byte_length::text AS bytes,v.source_metadata,v.source_array_presence,v.expected_counts,v.row_digest,d.exact_bytes,d.sha256 FROM ${ns}."snapshot_versions" v JOIN ${ns}."source_documents" d USING(source_document_id) WHERE v.store_id=$1 AND v.source_sha256=$2`, [storeId, sourceSha])).rows[0];
      let snapshotId = existing?.snapshot_id;
      if (existing) {
        if (!existing.complete || existing.bytes !== String(body.length) || !equal(existing.exact_bytes, body) || !equal(existing.sha256, sourceSha) || canonical(existing.source_metadata) !== canonical(metadata(snapshot)) || canonical(existing.source_array_presence) !== canonical(presence(snapshot)) || canonical(existing.expected_counts) !== canonical(counts(snapshot))) fail('PROJECTION_CONFLICT', 'Existing normalized snapshot conflicts with exact source');
        const checked = await verify(client, ns, snapshotId, storeId, snapshot);
        if (!existing.row_digest || !equal(existing.row_digest, checked.digest)) fail('PROJECTION_CONFLICT', 'Existing normalized snapshot digest conflicts with exact source');
      } else {
        const document = (await client.query(`INSERT INTO ${ns}."source_documents"(logical_name,sha256,exact_bytes,byte_length) VALUES($1,$2,$3,$4) ON CONFLICT(logical_name,sha256) DO UPDATE SET logical_name=EXCLUDED.logical_name RETURNING source_document_id,exact_bytes`, [sourcePath, sourceSha, body, String(body.length)])).rows[0];
        if (!document || !equal(document.exact_bytes, body)) fail('PROJECTION_CONFLICT', 'Stored exact snapshot bytes conflict');
        snapshotId = crypto.randomUUID(); const expected = counts(snapshot);
        await client.query(`INSERT INTO ${ns}."snapshot_versions"(snapshot_id,store_id,source_document_id,source_sha256,source_byte_length,source_metadata,source_array_presence,expected_counts) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)`, [snapshotId, storeId, document.source_document_id, sourceSha, String(body.length), JSON.stringify(metadata(snapshot)), JSON.stringify(presence(snapshot)), JSON.stringify(expected)]);
        for (const spec of SPECS) await insertRows(client, ns, snapshotId, storeId, spec, snapshot[spec.source] || []);
        await insertDerived(client, ns, snapshotId, storeId, snapshot);
        const checked = await verify(client, ns, snapshotId, storeId, snapshot);
        await client.query(`UPDATE ${ns}."snapshot_versions" SET verified_counts=$2::jsonb,row_digest=$3,complete=true,completed_at=clock_timestamp() WHERE snapshot_id=$1 AND NOT complete`, [snapshotId, JSON.stringify(checked.counts), checked.digest]);
      }
      await client.query(`INSERT INTO ${ns}."current_snapshots"(store_id,snapshot_id) VALUES($1,$2) ON CONFLICT(store_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,switched_at=clock_timestamp()`, [storeId, snapshotId]);
      return { snapshotId: String(snapshotId), sourceSha256: sourceSha.toString('hex') };
    });
    return { revision: saved.revision, replayed: saved.replayed, snapshotId: saved.result.snapshotId };
  }
  return Object.freeze({ publish, readCommand });
}

module.exports = { createMarketWriter, MarketWriterError };
