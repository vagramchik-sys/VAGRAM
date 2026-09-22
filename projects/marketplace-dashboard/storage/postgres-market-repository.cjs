'use strict';

const ARRAY_TABLES = Object.freeze({
  products: 'products',
  stocks: 'stocks',
  operations: 'finance_operations',
  stockRows: 'stock_rows',
  categoryTree: 'category_tree_rows'
});
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

class MarketRepositoryError extends Error {
  constructor(code, message, isPublic = false) {
    super(message);
    this.name = 'MarketRepositoryError';
    this.code = code;
    if (isPublic) this.public = true;
  }
}

const invalid = message => new MarketRepositoryError('INVALID_ARGUMENT', message, true);
const databaseError = () => new MarketRepositoryError('DATABASE_ERROR', 'Данные маркетплейса временно недоступны.');
const integrityError = () => new MarketRepositoryError('DATA_INTEGRITY', 'Текущий снимок маркетплейса не прошёл проверку целостности.');
const incompleteError = () => new MarketRepositoryError('INCOMPLETE_SNAPSHOT', 'Для текущего снимка не сохранена полная карта исходных массивов. Требуется повторный импорт.');
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new TypeError('schema must be a PostgreSQL identifier');
  return `"${value}"`;
}
function validDay(value) {
  if (!DAY.test(value || '')) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
}
function requiredStore(value) {
  if (value === undefined || value === null || String(value).length === 0 || String(value).length > 100) throw invalid('Укажите корректный магазин');
  return String(value);
}
function optionalText(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const result = String(value);
  if (result.length > 200) throw invalid(`Слишком длинный фильтр ${label}`);
  return result;
}
function page(options) {
  const limit = options.limit == null ? 100 : Number(options.limit), offset = options.offset == null ? 0 : Number(options.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw invalid('Некорректная страница данных');
  return { limit, offset };
}
function safeCount(value) {
  const exact = BigInt(String(value));
  if (exact < 0n) throw integrityError();
  return exact <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : exact.toString();
}
function sourceCount(metadata, arrayName) {
  const value = metadata.expected_counts?.[arrayName];
  if (!Number.isSafeInteger(value) || value < 0) throw integrityError();
  return value;
}
function sourcePresence(metadata, arrayName) {
  const map = metadata.source_array_presence;
  if (!map || Array.isArray(map) || typeof map !== 'object' || !Object.keys(ARRAY_TABLES).every(name => typeof map[name] === 'boolean')) throw incompleteError();
  return map[arrayName];
}
function coverage(metadata, arrayName, matched) {
  const sourceRows = sourceCount(metadata, arrayName);
  const verified = metadata.verified_counts?.[arrayName];
  if (!Number.isSafeInteger(verified) || verified !== sourceRows) throw integrityError();
  const present = sourcePresence(metadata, arrayName);
  if (!present && sourceRows > 0) throw incompleteError();
  return { complete: true, sourceRows, present, matched };
}

function createMarketRepository({ pool, schema = 'pult_market' } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');
  const prefix = identifier(schema), table = name => `${prefix}."${name}"`;
  async function query(target, text, values = []) {
    try { return await target.query(text, values); } catch (error) {
      if (error instanceof MarketRepositoryError) throw error;
      throw databaseError();
    }
  }
  async function read(work) {
    let client;
    try { client = await pool.connect(); } catch { throw databaseError(); }
    try {
      await query(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await work(client);
      await query(client, 'COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      try { client.release(); } catch {}
    }
  }
  async function current(client, storeId) {
    const result = await query(client, `SELECT v.snapshot_id,v.source_metadata,v.source_array_presence,v.expected_counts,v.verified_counts
      FROM ${table('current_snapshots')} c
      JOIN ${table('snapshot_versions')} v ON v.snapshot_id=c.snapshot_id AND v.store_id=c.store_id AND v.complete=true
      WHERE c.store_id=$1`, [storeId]);
    return result.rows[0] || null;
  }
  async function getSnapshot(storeId) {
    storeId = requiredStore(storeId);
    return read(async client => {
      const metadata = await current(client, storeId);
      if (!metadata) return null;
      const snapshot = { ...metadata.source_metadata };
      for (const [arrayName, tableName] of Object.entries(ARRAY_TABLES)) {
        const result = await query(client, `SELECT raw_row FROM ${table(tableName)} WHERE snapshot_id=$1 ORDER BY source_index ASC`, [metadata.snapshot_id]);
        const arrayCoverage = coverage(metadata, arrayName, result.rows.length);
        if (result.rows.length !== arrayCoverage.sourceRows) throw integrityError();
        if (!arrayCoverage.present && result.rows.length) throw incompleteError();
        if (arrayCoverage.present) snapshot[arrayName] = result.rows.map(row => row.raw_row);
      }
      return snapshot;
    });
  }
  async function list(arrayName, options, configure) {
    options ||= {};
    const storeId = requiredStore(options.storeId), pagination = page(options);
    return read(async client => {
      const metadata = await current(client, storeId);
      if (!metadata) return { rows: [], total: null, limit: pagination.limit, offset: pagination.offset, coverage: { complete: false, reason: 'NO_CURRENT_SNAPSHOT' } };
      const values = [metadata.snapshot_id], clauses = ['r.snapshot_id=$1'];
      configure({ values, clauses, options, alias: 'r' });
      const where = clauses.join(' AND '), relation = table(ARRAY_TABLES[arrayName]);
      const actual = await query(client, `SELECT count(*)::text AS source_count FROM ${relation} WHERE snapshot_id=$1`, [metadata.snapshot_id]);
      const sourceRows = sourceCount(metadata, arrayName), actualRows = safeCount(actual.rows[0].source_count);
      if (actualRows !== sourceRows) throw integrityError();
      if (!sourcePresence(metadata, arrayName) && actualRows !== 0) throw incompleteError();
      const count = await query(client, `SELECT count(*)::text AS count FROM ${relation} r WHERE ${where}`, values);
      const total = safeCount(count.rows[0].count), rowValues = [...values, pagination.limit, pagination.offset];
      const rows = await query(client, `SELECT r.raw_row FROM ${relation} r WHERE ${where} ORDER BY r.source_index ASC LIMIT $${rowValues.length - 1} OFFSET $${rowValues.length}`, rowValues);
      return { rows: rows.rows.map(row => row.raw_row), total, limit: pagination.limit, offset: pagination.offset, coverage: coverage(metadata, arrayName, total) };
    });
  }
  function addText({ values, clauses }, column, value, label) {
    value = optionalText(value, label);
    if (value === null) return;
    values.push(value); clauses.push(`r.${column}=$${values.length}`);
  }
  async function products(options = {}) {
    return list('products', options, state => {
      addText(state, 'product_id', options.productId, 'productId');
      addText(state, 'sku', options.sku, 'sku');
      addText(state, 'offer_id', options.offerId, 'offerId');
    });
  }
  async function stocks(options = {}) {
    return list('stocks', options, state => {
      addText(state, 'product_id', options.productId, 'productId');
      addText(state, 'offer_id', options.offerId, 'offerId');
      const sku = optionalText(options.sku, 'sku');
      if (sku !== null) {
        state.values.push(sku);
        state.clauses.push(`EXISTS(SELECT 1 FROM ${table('stock_items')} si WHERE si.snapshot_id=r.snapshot_id AND si.stock_source_index=r.source_index AND si.sku=$${state.values.length})`);
      }
      const warehouse = optionalText(options.warehouse, 'warehouse');
      if (warehouse !== null) {
        state.values.push(warehouse);
        state.clauses.push(`EXISTS(SELECT 1 FROM ${table('stock_items')} wi WHERE wi.snapshot_id=r.snapshot_id AND wi.stock_source_index=r.source_index AND wi.warehouse=$${state.values.length})`);
      }
    });
  }
  async function operations(options = {}) {
    for (const key of ['from', 'to']) if (options[key] && !validDay(options[key])) throw invalid('Проверьте даты периода');
    if (options.from && options.to && options.from > options.to) throw invalid('Начало периода позже окончания');
    return list('operations', options, state => {
      addText(state, 'operation_id', options.operationId, 'operationId');
      addText(state, 'operation_type', options.operationType, 'operationType');
      for (const [key, operator] of [['from', '>='], ['to', '<=']]) if (options[key]) {
        state.values.push(String(options[key])); state.clauses.push(`r.operation_day${operator}$${state.values.length}::date`);
      }
      const sku = optionalText(options.sku, 'sku');
      if (sku !== null) {
        state.values.push(sku);
        state.clauses.push(`EXISTS(SELECT 1 FROM ${table('finance_operation_skus')} os WHERE os.snapshot_id=r.snapshot_id AND os.operation_source_index=r.source_index AND os.sku=$${state.values.length})`);
      }
    });
  }

  return { getSnapshot, products, stocks, operations, async close() {} };
}

module.exports = { createMarketRepository, MarketRepositoryError, ARRAY_TABLES };
