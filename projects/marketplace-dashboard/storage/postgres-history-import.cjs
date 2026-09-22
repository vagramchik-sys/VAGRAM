'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const schemaSql = require('./postgres-history-schema.cjs');

const MAX_BATCH = 1000;
const MAX_PARAMETERS = 60000;
const q = value => `"${String(value).replaceAll('"', '""')}"`;
const tableName = name => `pult_history.${q(name)}`;

function stable(value) {
  if (value === null) return 'null';
  if (Buffer.isBuffer(value)) return `{"$bytea":${JSON.stringify(value.toString('hex'))}}`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw Error('Non-finite number in history source');
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  return JSON.stringify(value);
}

function canonicalValue(value, type) {
  if (value === null || value === undefined) return null;
  if (type === 'int') return String(value);
  if (type === 'bool') return value === true || value === 1 || value === 1n || value === '1' ? 1 : 0;
  if (type === 'json') return String(value);
  if (type === 'float') return Number(value);
  return String(value);
}

function canonicalRow(row, spec) {
  const result = {};
  for (const column of spec.sourceColumns) result[column.name] = canonicalValue(row[column.name], column.type);
  if (spec.canonicalExtra) Object.assign(result, spec.canonicalExtra(row));
  return result;
}

const col = (name, type = 'text') => ({ name, type });
const direct = (columns, extra = {}) => {
  const targetColumns = [], targetSelect = [];
  for (const column of columns) {
    if (column.type === 'json') {
      targetColumns.push(column.name, `${column.name}_text`);
      targetSelect.push(`${q(`${column.name}_text`)} AS ${q(column.name)}`);
    } else {
      targetColumns.push(column.name);
      targetSelect.push(`${q(column.name)} AS ${q(column.name)}`);
    }
  }
  return {
    targetColumns,
    mapRow: row => columns.flatMap(column => {
      const value = row[column.name];
      if (column.type === 'json') { JSON.parse(value); return [value, value]; }
      return [typeof value === 'bigint' ? value.toString() : value];
    }),
    targetSelect,
    ...extra
  };
};
const timestamped = (columns, timestampMap, extra = {}) => {
  const targetColumns = [], targetSelect = [];
  for (const column of columns) {
    const target = extra.rename?.[column.name] || column.name;
    if (timestampMap[column.name]) {
      targetColumns.push(target, `${target}_text`);
      targetSelect.push(`${q(`${target}_text`)} AS ${q(column.name)}`);
    } else if (column.type === 'bool') {
      targetColumns.push(target);
      targetSelect.push(`CASE WHEN ${q(target)} THEN 1 ELSE 0 END AS ${q(column.name)}`);
    } else if (column.type === 'date') {
      targetColumns.push(target);
      targetSelect.push(`to_char(${q(target)}, 'YYYY-MM-DD') AS ${q(column.name)}`);
    } else if (column.type === 'json') {
      targetColumns.push(target, `${target}_text`);
      targetSelect.push(`${q(`${target}_text`)} AS ${q(column.name)}`);
    } else {
      targetColumns.push(target);
      targetSelect.push(`${q(target)} AS ${q(column.name)}`);
    }
  }
  return {
    targetColumns,
    mapRow(row) {
      const values = [];
      for (const column of columns) {
        const value = row[column.name];
        if (timestampMap[column.name]) values.push(value, value);
        else if (column.type === 'bool') values.push(Boolean(value));
        else if (column.type === 'json') { JSON.parse(value); values.push(value, value); }
        else values.push(typeof value === 'bigint' ? value.toString() : value);
      }
      return values;
    },
    targetSelect,
    ...extra
  };
};

const TABLES = [
  { name: 'ingestions', db: 'products', sourceColumns: [col('id', 'int'), col('source_file'), col('content_hash'), col('captured_at'), col('source_kind')], pk: ['id'], ...timestamped([col('id', 'int'), col('source_file'), col('content_hash'), col('captured_at'), col('source_kind')], { captured_at: true }) },
  { name: 'snapshots', db: 'products', sourceColumns: [col('id', 'int'), col('ingestion_id', 'int'), col('source_kind'), col('market'), col('store_id'), col('day', 'date'), col('source_actual_at'), col('closed_confirmed', 'bool'), col('partial_reason')], pk: ['id'], ...timestamped([col('id', 'int'), col('ingestion_id', 'int'), col('source_kind'), col('market'), col('store_id'), col('day', 'date'), col('source_actual_at'), col('closed_confirmed', 'bool'), col('partial_reason')], { source_actual_at: true }) },
  { name: 'facts', db: 'products', sourceColumns: [col('id', 'int'), col('snapshot_id', 'int'), col('product_id'), col('observed_at'), col('units', 'float'), col('revenue', 'float'), col('sold_units', 'float'), col('returned_units', 'float'), col('realized', 'float'), col('ads', 'float'), col('unknown_unit_rows', 'int')], pk: ['id'], ...timestamped([col('id', 'int'), col('snapshot_id', 'int'), col('product_id'), col('observed_at'), col('units', 'float'), col('revenue', 'float'), col('sold_units', 'float'), col('returned_units', 'float'), col('realized', 'float'), col('ads', 'float'), col('unknown_unit_rows', 'int')], { observed_at: true }) },
  { name: 'order_events', db: 'products', sourceColumns: [col('id', 'int'), col('snapshot_id', 'int'), col('product_id'), col('occurred_at'), col('amount', 'float')], pk: ['id'], ...timestamped([col('id', 'int'), col('snapshot_id', 'int'), col('product_id'), col('occurred_at'), col('amount', 'float')], { occurred_at: true }) },
  { name: 'product_names', db: 'products', sourceColumns: [col('market'), col('store_id'), col('product_id'), col('name'), col('source_actual_at')], pk: ['market', 'store_id', 'product_id'], ...timestamped([col('market'), col('store_id'), col('product_id'), col('name'), col('source_actual_at')], { source_actual_at: true }) },
  { name: 'product_aliases', db: 'products', sourceColumns: [col('market'), col('store_id'), col('alias'), col('product_id'), col('source_actual_at')], pk: ['market', 'store_id', 'alias'], ...timestamped([col('market'), col('store_id'), col('alias'), col('product_id'), col('source_actual_at')], { source_actual_at: true }) },
  { name: 'archive_versions', sourceTable: 'versions', db: 'archive', sourceColumns: [col('source_file'), col('content_hash'), col('captured_at'), col('source_mtime', 'float'), col('source_bytes', 'int'), col('archive_bytes', 'int'), col('object_path'), col('facts_status')], pk: ['source_file', 'content_hash'], ...timestamped([col('source_file'), col('content_hash'), col('captured_at'), col('source_mtime', 'float'), col('source_bytes', 'int'), col('archive_bytes', 'int'), col('object_path'), col('facts_status')], { captured_at: true }, { batchSize: 1, canonicalExtra: row => { const payloadHash = row.__archive_payload ? crypto.createHash('sha256').update(row.__archive_payload).digest('hex') : row.__archive_gzip_hash; if (payloadHash !== row.__archive_gzip_hash) throw Object.assign(Error('Stored archive payload hash mismatch'), { code: 'ARCHIVE_TARGET_HASH_MISMATCH' }); return { archive_gzip_hash: payloadHash }; } }) },
  { name: 'archive_latest', sourceTable: 'latest', db: 'archive', sourceColumns: [col('source_file'), col('stamp'), col('content_hash')], pk: ['source_file'], ...direct([col('source_file'), col('stamp'), col('content_hash')]) },
  { name: 'archive_state', sourceTable: 'state', db: 'archive', sourceColumns: [col('key'), col('value')], pk: ['key'], ...direct([col('key'), col('value')]) },
  { name: 'stock_imports', sourceTable: 'imports', db: 'stocks', sourceColumns: [col('id'), col('imported_at'), col('manifest', 'json'), col('issues', 'json')], pk: ['id'], ...timestamped([col('id'), col('imported_at'), col('manifest', 'json'), col('issues', 'json')], { imported_at: true }) },
  { name: 'stock_rows', db: 'stocks', sourceColumns: [col('id'), col('day', 'date'), col('observedAt'), col('source'), col('storeId'), col('storeName'), col('sku'), col('article'), col('name'), col('warehouse'), col('warehouseId'), col('cluster'), col('totalStock', 'int'), col('available', 'int'), col('inTransit', 'int'), col('reserved', 'int'), col('quality'), col('details', 'json')], pk: ['id'], ...timestamped([col('id'), col('day', 'date'), col('observedAt'), col('source'), col('storeId'), col('storeName'), col('sku'), col('article'), col('name'), col('warehouse'), col('warehouseId'), col('cluster'), col('totalStock', 'int'), col('available', 'int'), col('inTransit', 'int'), col('reserved', 'int'), col('quality'), col('details', 'json')], { observedAt: true }, { rename: { observedAt: 'observed_at', storeId: 'store_id', storeName: 'store_name', warehouseId: 'warehouse_id', totalStock: 'total_stock', inTransit: 'in_transit' } }) },
  { name: 'stock_origins', sourceTable: 'origins', db: 'stocks', sourceColumns: [col('row_id'), col('import_id'), col('source_file'), col('source_row')], pk: ['row_id', 'import_id', 'source_file', 'source_row'], ...direct([col('row_id'), col('import_id'), col('source_file'), col('source_row')]) }
];

async function archivePayload(historyDir, row) {
  const root = path.resolve(historyDir);
  const file = path.resolve(root, row.object_path);
  if (file !== root && !file.startsWith(root + path.sep)) throw Object.assign(Error('Archive object escapes source directory'), { code: 'INVALID_ARCHIVE_PATH' });
  let cursor = root;
  for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || (cursor === file && !stat.isFile())) throw Object.assign(Error('Archive object must be a regular non-link file'), { code: 'INVALID_ARCHIVE_PATH' });
  }
  const real = fs.realpathSync(file);
  if (!real.startsWith(fs.realpathSync(root) + path.sep)) throw Object.assign(Error('Archive object escapes source directory'), { code: 'INVALID_ARCHIVE_PATH' });
  const before = fs.statSync(real);
  const compressed = crypto.createHash('sha256'), raw = crypto.createHash('sha256'), chunks = [];
  let rawBytes = 0;
  await pipeline(
    fs.createReadStream(file),
    new Transform({ transform(chunk, encoding, callback) { compressed.update(chunk); chunks.push(Buffer.from(chunk)); callback(null, chunk); } }),
    createGunzip(),
    new Writable({ write(chunk, encoding, callback) { raw.update(chunk); rawBytes += chunk.length; callback(); } })
  );
  const payload = Buffer.concat(chunks), gzipHash = compressed.digest();
  const after = fs.statSync(real);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Object.assign(Error('Archive object changed during import'), { code: 'ARCHIVE_CHANGED' });
  if (String(payload.length) !== String(row.archive_bytes)) throw Object.assign(Error('Archive byte count mismatch'), { code: 'ARCHIVE_SIZE_MISMATCH' });
  if (String(rawBytes) !== String(row.source_bytes)) throw Object.assign(Error('Archive source byte count mismatch'), { code: 'ARCHIVE_SOURCE_SIZE_MISMATCH' });
  if (raw.digest('hex') !== row.content_hash) throw Object.assign(Error('Archive source hash mismatch'), { code: 'ARCHIVE_HASH_MISMATCH' });
  return { payload, gzipHash };
}

function sourceQuery(spec) {
  return `SELECT ${spec.sourceColumns.map(column => q(column.name)).join(',')} FROM ${q(spec.sourceTable || spec.name)} ORDER BY ${spec.pk.map(q).join(',')} LIMIT ? OFFSET ?`;
}

function conflictSql(spec) {
  const target = tableName(spec.name), columns = spec.targetColumns.map(q), pk = spec.pk.map(name => q(spec.rename?.[name] || name));
  const compare = columns.filter(column => !pk.includes(column)).map(column => `${target}.${column} IS NOT DISTINCT FROM EXCLUDED.${column}`).join(' AND ') || 'true';
  return { target, columns, pk, compare };
}

async function insertBatch(client, spec, rows) {
  if (!rows.length) return;
  const mapped = [];
  for (const row of rows) {
    const values = await spec.mapRow(row);
    if (spec.name === 'archive_versions') {
      const blob = await archivePayload(spec.historyDir, row);
      values.push(blob.payload, blob.gzipHash);
      row.__archive_gzip_hash = blob.gzipHash.toString('hex');
      row.__archive_payload = blob.payload;
    }
    mapped.push(values);
  }
  const targetColumns = spec.name === 'archive_versions' ? [...spec.targetColumns, 'archive_payload', 'archive_gzip_hash'] : spec.targetColumns;
  const effective = { ...spec, targetColumns };
  const { target, columns, pk, compare } = conflictSql(effective);
  const values = mapped.flat(), tuples = mapped.map((row, rowIndex) => `(${row.map((unused, columnIndex) => `$${rowIndex * row.length + columnIndex + 1}`).join(',')})`).join(',');
  const sql = `INSERT INTO ${target} (${columns.join(',')}) VALUES ${tuples} ON CONFLICT (${pk.join(',')}) DO UPDATE SET ${pk[0]}=EXCLUDED.${pk[0]} WHERE ${compare} RETURNING ${pk.join(',')}`;
  const result = await client.query(sql, values);
  if (result.rowCount !== rows.length) throw Object.assign(Error(`Conflicting data in ${spec.name}`), { code: 'HISTORY_CONFLICT', table: spec.name });
}

async function importTable(client, db, spec, onProgress) {
  const requested = Math.min(spec.batchSize || MAX_BATCH, Math.floor(MAX_PARAMETERS / (spec.targetColumns.length + (spec.name === 'archive_versions' ? 2 : 0))));
  const statement = db.prepare(sourceQuery(spec));
  if (typeof statement.setReadBigInts === 'function') statement.setReadBigInts(true);
  const hash = crypto.createHash('sha256');
  let count = 0;
  for (;;) {
    const rows = statement.all(requested, count);
    if (!rows.length) break;
    await client.query('BEGIN');
    try { await insertBatch(client, spec, rows); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    for (const row of rows) hash.update(stable(canonicalRow(row, spec)) + '\n');
    count += rows.length;
    if (onProgress) await onProgress({ phase: 'import', table: spec.name, rows: count });
  }
  return { count, hash: hash.digest('hex') };
}

function targetQuery(spec) {
  const selects = [...spec.targetSelect];
  if (spec.name === 'archive_versions') selects.push(`encode(archive_gzip_hash, 'hex') AS "__archive_gzip_hash"`, `archive_payload AS "__archive_payload"`);
  const order = spec.pk.map(name => q(spec.rename?.[name] || name)).join(',');
  return `SELECT ${selects.join(',')} FROM ${tableName(spec.name)} ORDER BY ${order} LIMIT $1 OFFSET $2`;
}

async function verifyTarget(client, spec) {
  const hash = crypto.createHash('sha256');
  const batchSize = spec.batchSize || MAX_BATCH;
  let count = 0;
  for (;;) {
    const result = await client.query(targetQuery(spec), [batchSize, count]);
    if (!result.rows.length) break;
    for (const row of result.rows) hash.update(stable(canonicalRow(row, spec)) + '\n');
    count += result.rows.length;
  }
  return { count, hash: hash.digest('hex') };
}

async function resetIdentities(client) {
  for (const table of ['ingestions', 'snapshots', 'facts', 'order_events']) {
    await client.query(`SELECT setval(pg_get_serial_sequence($1, 'id')::regclass, COALESCE((SELECT max(id) FROM ${tableName(table)}), 1), EXISTS (SELECT 1 FROM ${tableName(table)}))`, [`pult_history.${table}`]);
  }
}

async function importHistory({ pool, sourceDir, onProgress } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect is required');
  if (typeof sourceDir !== 'string' || !sourceDir) throw new TypeError('sourceDir is required');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function');
  const requestedDir = path.resolve(sourceDir), livePath = path.resolve(__dirname, '..', '.private', 'history');
  if (requestedDir === livePath) throw Object.assign(Error('Live history directory cannot be imported'), { code: 'LIVE_SOURCE_FORBIDDEN' });
  const requestedStat = fs.lstatSync(requestedDir);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) throw Object.assign(Error('History source must be a regular backup directory'), { code: 'INVALID_SOURCE_DIRECTORY' });
  const historyDir = fs.realpathSync(requestedDir);
  const live = fs.existsSync(livePath) ? fs.realpathSync(livePath) : livePath;
  if (historyDir === live) throw Object.assign(Error('Live history directory cannot be imported'), { code: 'LIVE_SOURCE_FORBIDDEN' });
  const files = { products: path.join(historyDir, 'products.sqlite'), archive: path.join(historyDir, 'archive.sqlite'), stocks: path.join(historyDir, 'stocks.sqlite') };
  for (const file of Object.values(files)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(fs.realpathSync(file)) !== historyDir) throw Object.assign(Error('History backup is incomplete or contains links'), { code: 'INVALID_SOURCE_DATABASE' });
  }

  const dbs = {}, runId = crypto.randomUUID(), counts = {}, hashes = {};
  let client = null, locked = false, sourceTransactions = false;
  try {
    for (const [key, file] of Object.entries(files)) dbs[key] = new DatabaseSync(file, { readOnly: true });
    for (const db of Object.values(dbs)) {
      db.exec('BEGIN');
      db.prepare('SELECT name FROM sqlite_master ORDER BY name LIMIT 1').get();
    }
    sourceTransactions = true;
    client = await pool.connect();
    const lock = await client.query(`SELECT pg_try_advisory_lock(hashtext('pult_history.import')) AS acquired`);
    if (!lock.rows[0]?.acquired) throw Object.assign(Error('Another history import is running'), { code: 'HISTORY_IMPORT_BUSY' });
    locked = true;
    await client.query(schemaSql);
    await client.query('INSERT INTO pult_history.import_runs(run_id,status) VALUES($1,$2)', [runId, 'running']);
    for (const base of TABLES) {
      const spec = { ...base, historyDir };
      const result = await importTable(client, dbs[spec.db], spec, onProgress);
      counts[spec.name] = result.count; hashes[spec.name] = result.hash;
    }

    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      for (const base of TABLES) {
        const target = await verifyTarget(client, base);
        if (target.count !== counts[base.name] || target.hash !== hashes[base.name]) throw Object.assign(Error(`Verification failed for ${base.name}`), { code: 'HISTORY_VERIFICATION_FAILED', table: base.name });
      }
      await resetIdentities(client);
      const sourceFingerprint = crypto.createHash('sha256').update(stable({ counts, hashes })).digest();
      await client.query(`UPDATE pult_history.import_runs SET source_fingerprint=$2,status='complete',completed_at=clock_timestamp(),table_counts=$3::jsonb,table_hashes=$4::jsonb WHERE run_id=$1`, [runId, sourceFingerprint, JSON.stringify(counts), JSON.stringify(hashes)]);
      await client.query(`INSERT INTO pult_history.import_state(singleton,completed_run_id,source_fingerprint,table_counts,table_hashes,completed_at) VALUES(true,$1,$2,$3::jsonb,$4::jsonb,clock_timestamp()) ON CONFLICT(singleton) DO UPDATE SET completed_run_id=EXCLUDED.completed_run_id,source_fingerprint=EXCLUDED.source_fingerprint,table_counts=EXCLUDED.table_counts,table_hashes=EXCLUDED.table_hashes,completed_at=EXCLUDED.completed_at`, [runId, sourceFingerprint, JSON.stringify(counts), JSON.stringify(hashes)]);
      for (const db of Object.values(dbs)) db.exec('COMMIT');
      sourceTransactions = false;
      await client.query('COMMIT');
      if (onProgress) await onProgress({ phase: 'complete', runId, counts: { ...counts }, hashes: { ...hashes } });
      return { runId, counts, hashes, sourceFingerprint: sourceFingerprint.toString('hex') };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  } catch (error) {
    try { if (client) await client.query('ROLLBACK'); } catch {}
    try { if (client) await client.query(`UPDATE pult_history.import_runs SET status='failed',error_code=$2 WHERE run_id=$1 AND status='running'`, [runId, String(error.code || 'IMPORT_FAILED').slice(0, 120)]); } catch {}
    throw error;
  } finally {
    if (sourceTransactions) for (const db of Object.values(dbs)) try { db.exec('ROLLBACK'); } catch {}
    for (const db of Object.values(dbs)) db.close();
    if (locked) try { await client.query(`SELECT pg_advisory_unlock(hashtext('pult_history.import'))`); } catch {}
    if (client) client.release();
  }
}

module.exports = { importHistory, _test: { archivePayload, stable } };
