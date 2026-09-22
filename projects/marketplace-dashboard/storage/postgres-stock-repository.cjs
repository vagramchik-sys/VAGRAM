'use strict';

const LABELS = {
  'daily-total': 'Дневная история — товары',
  'daily-warehouse': 'Дневная история — склады',
  'cabinet-total': 'Снимок кабинета — товары',
  'cabinet-warehouse': 'Снимок кабинета — склады',
  'seller-warehouse': 'Архив Seller API — склады',
  'cluster-warehouse': 'Сохранённый API — склады и кластеры',
  'audit-total': 'Внутридневная история — товары',
  'audit-warehouse': 'Внутридневная история — склады',
  'diagnostic-warehouse': 'Архив API за август — неполные выборки'
};
const LIMITATIONS = [
  'Это сохранённая история Control Seller. Дата наблюдения может отличаться от даты дневной записи; актуальные остатки Пульта не заменены.',
  'Источники и даты не складываются между собой. «Остаток источника» может включать недоступные товары и отличается от «Доступно».',
  'Импортированы файловые снимки. Более полная история из резервной SQL-базы пока не перенесена.',
  'Отсутствие записи или неизвестное значение не означает нулевой остаток.'
];
const FIELDS = ['day', 'observedAt', 'source', 'storeId', 'storeName', 'sku', 'article', 'name', 'warehouse', 'warehouseId', 'cluster', 'totalStock', 'available', 'inTransit', 'reserved', 'quality'];
const CSV_HEAD = ['Дата записи', 'Дата наблюдения', 'Источник', 'ID магазина', 'Магазин', 'SKU', 'Артикул', 'Товар', 'Склад', 'ID склада', 'Кластер', 'Остаток источника', 'Доступно', 'В пути', 'Резерв', 'Качество данных'];
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

class StockRepositoryError extends Error {
  constructor(code, message, isPublic = false) {
    super(message);
    this.name = 'StockRepositoryError';
    this.code = code;
    if (isPublic) this.public = true;
  }
}

const invalid = message => new StockRepositoryError('INVALID_ARGUMENT', message, true);
const databaseError = () => new StockRepositoryError('DATABASE_ERROR', 'История остатков временно недоступна.');
const quoteSchema = value => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new TypeError('schema must be a PostgreSQL identifier');
  return `"${value}"`;
};
function validDay(value) {
  if (!DAY.test(value || '')) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
}
function safeInteger(value) {
  if (value === null || value === undefined) return null;
  const exact = typeof value === 'bigint' ? value : BigInt(String(value));
  return exact <= BigInt(Number.MAX_SAFE_INTEGER) && exact >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(exact) : exact.toString();
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function createStockHistoryRepository({ pool, schema = 'pult_history' } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');
  const prefix = quoteSchema(schema), rowsTable = `${prefix}."stock_rows"`, importsTable = `${prefix}."stock_imports"`;
  const projection = `to_char(day,'YYYY-MM-DD') AS "day",observed_at_text AS "observedAt",source AS "source",store_id AS "storeId",store_name AS "storeName",sku AS "sku",article AS "article",name AS "name",warehouse AS "warehouse",warehouse_id AS "warehouseId",cluster AS "cluster",total_stock::text AS "totalStock",available::text AS "available",in_transit::text AS "inTransit",reserved::text AS "reserved",quality AS "quality"`;
  const order = `day DESC NULLS LAST,observed_at DESC NULLS LAST,store_name COLLATE "C" ASC NULLS FIRST,sku COLLATE "C" ASC NULLS FIRST,warehouse_id COLLATE "C" ASC NULLS FIRST,id COLLATE "C" ASC NULLS FIRST`;

  async function query(target, text, values = []) {
    try { return await target.query(text, values); } catch { throw databaseError(); }
  }
  async function readTransaction(work) {
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
  function scope(options = {}) {
    const source = options.source || 'daily-total';
    if (!Object.hasOwn(LABELS, source)) throw invalid('Выберите источник истории');
    for (const key of ['from', 'to']) if (options[key] && !validDay(options[key])) throw invalid('Проверьте даты периода');
    if (options.from && options.to && options.from > options.to) throw invalid('Начало периода позже окончания');
    const clauses = ['source=$1'], values = [source];
    for (const [key, column, operator] of [['store', 'store_id', '='], ['sku', 'sku', '='], ['from', 'day', '>='], ['to', 'day', '<=']]) {
      if (!options[key]) continue;
      const value = String(options[key]);
      if (value.length > 100) throw invalid('Слишком длинный фильтр');
      values.push(value); clauses.push(`${column}${operator}$${values.length}${key === 'from' || key === 'to' ? '::date' : ''}`);
    }
    if (options.q) {
      if (String(options.q).length > 200) throw invalid('Слишком длинный поиск');
      const value = '%' + String(options.q).replace(/[\\%_]/gu, '\\$&') + '%';
      values.push(value);
      const parameter = '$' + values.length;
      const folded = column => `translate(${column} COLLATE "C",'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') LIKE translate(${parameter}::text COLLATE "C",'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') ESCAPE '\\'`;
      clauses.push(`(${folded('name')} OR ${folded('article')} OR ${folded('sku')})`);
    }
    return { source, sql: clauses.join(' AND '), values };
  }
  function page(options) {
    const limit = options.limit == null ? 100 : Number(options.limit), offset = options.offset == null ? 0 : Number(options.offset);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw invalid('Некорректная страница истории');
    return { limit, offset };
  }
  function mapRow(row) {
    const result = { ...row };
    for (const key of ['totalStock', 'available', 'inTransit', 'reserved']) result[key] = safeInteger(result[key]);
    return result;
  }

  async function status() {
    const result = await readTransaction(async client => {
      const counts = await query(client, `SELECT count(*)::text AS records,to_char(min(day),'YYYY-MM-DD') AS "from",to_char(max(day),'YYYY-MM-DD') AS "to" FROM ${rowsTable}`);
      const products = await query(client, `SELECT count(*)::text AS n FROM (SELECT DISTINCT store_id,sku FROM ${rowsTable}) products`);
      const sources = await query(client, `SELECT source AS id,count(*)::text AS records,to_char(min(day),'YYYY-MM-DD') AS "from",to_char(max(day),'YYYY-MM-DD') AS "to" FROM ${rowsTable} GROUP BY source ORDER BY source ASC NULLS FIRST`);
      const stores = await query(client, `SELECT store_id AS id,max(store_name COLLATE "C") AS name FROM ${rowsTable} GROUP BY store_id ORDER BY max(store_name COLLATE "C") ASC NULLS FIRST,store_id COLLATE "C" ASC NULLS FIRST`);
      const last = await query(client, `SELECT imported_at_text FROM ${importsTable} ORDER BY imported_at DESC NULLS LAST,id ASC NULLS FIRST LIMIT 1`);
      return { counts: counts.rows[0], products: products.rows[0], sources: sources.rows, stores: stores.rows, last: last.rows[0] };
    });
    return {
      records: safeInteger(result.counts.records),
      from: result.counts.from || null,
      to: result.counts.to || null,
      products: safeInteger(result.products.n),
      stores: result.stores,
      sources: result.sources.map(row => ({ ...row, records: safeInteger(row.records), label: LABELS[row.id] })),
      importedAt: result.last?.imported_at_text || null,
      limitations: LIMITATIONS
    };
  }

  async function report(options = {}) {
    const filter = scope(options), { limit, offset } = page(options);
    const result = await readTransaction(async client => {
      const total = await query(client, `SELECT count(*)::text AS n FROM ${rowsTable} WHERE ${filter.sql}`, filter.values);
      const values = [...filter.values, limit, offset];
      const rows = await query(client, `SELECT ${projection} FROM ${rowsTable} WHERE ${filter.sql} ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
      return { total: total.rows[0].n, rows: rows.rows };
    });
    return { rows: result.rows.map(row => ({ ...mapRow(row), sourceLabel: LABELS[row.source] })), total: safeInteger(result.total), limit, offset, source: filter.source, from: options.from || null, to: options.to || null, limitations: LIMITATIONS };
  }

  async function csv(options = {}) {
    const filter = scope(options);
    const rows = await readTransaction(async client => (await query(client, `SELECT ${projection} FROM ${rowsTable} WHERE ${filter.sql} ORDER BY ${order}`, filter.values)).rows);
    const lines = [CSV_HEAD.map(csvCell).join(';')];
    for (const sourceRow of rows) {
      const row = mapRow(sourceRow);
      lines.push(FIELDS.map(key => csvCell(key === 'source' ? LABELS[row.source] : row[key])).join(';'));
    }
    return '\ufeff' + lines.join('\r\n');
  }

  return { status, report, csv, async close() {} };
}

module.exports = { createStockHistoryRepository, StockRepositoryError, LABELS, LIMITATIONS };
