'use strict';

const path = require('node:path');
const { acquireMutationFence } = require('./postgres-write-fence.cjs');

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_REPORT_DAYS = 3660;
const INSERT_BATCH = 1000;
const METRICS = {
  units: { column: 'units', sources: ['ozon-orders', 'wb-orders'] },
  revenue: { column: 'revenue', sources: ['ozon-orders', 'wb-orders'] },
  soldUnits: { column: 'sold_units', sources: ['ozon-finance'] },
  returnedUnits: { column: 'returned_units', sources: ['ozon-finance'] },
  realized: { column: 'realized', sources: ['ozon-finance'] },
  ads: { column: 'ads', sources: ['ozon-finance'] }
};
const LIMITATIONS = [
  'Сравнение будней и выходных использует только подтверждённые полные дни; текущие и частичные снимки исключены.',
  'Пустой подтверждённый день входит в знаменатель как ноль.',
  'unknownUnitRows больше нуля означает, что количество является нижней границей, а не полным подтверждённым итогом.',
  'Время Ozon SKU — время наблюдения, а не час заказа; реальные часы доступны только для WB.'
];

class HistoryRepositoryError extends Error {
  constructor(code, message) { super(message); this.name = 'HistoryRepositoryError'; this.code = code; }
}

const databaseError = () => new HistoryRepositoryError('DATABASE_ERROR', 'База истории временно недоступна. Повторите запрос позже.');
const outcomeUnknown = () => new HistoryRepositoryError('OUTCOME_UNKNOWN', 'Результат фиксации истории неизвестен. Не запускайте автоматический повтор; для ручной сверки и повтора используйте ту же пару sourceFile и contentHash.');
async function connectDatabase(pool) { try { return await pool.connect(); } catch { throw databaseError(); } }
async function queryDatabase(target, text, values, { commitOutcome = false } = {}) { try { return await target.query(text, values); } catch { throw commitOutcome ? outcomeUnknown() : databaseError(); } }
function releaseDatabase(client) { try { client.release(); } catch {} }

const ident = value => {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new TypeError('schema must be a PostgreSQL identifier');
  return `"${value}"`;
};
const mskDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
function validDay(value) { if (!DAY.test(value || '')) return false; const parsed = new Date(value + 'T00:00:00Z'); return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value; }
function days(from, to) { if (!validDay(from) || !validDay(to) || from > to) throw Error('Некорректный календарный период'); const out = []; for (let at = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z'); at <= end; at += 86400000) out.push(new Date(at).toISOString().slice(0, 10)); return out; }
function finiteNumber(value, label, { integer = false, min } = {}) { if (value === null || value === undefined || value === '' || !Number.isFinite(value) || integer && !Number.isSafeInteger(value) || min !== undefined && value < min) throw Error('Некорректное значение ' + label); if (!Number.isSafeInteger(Math.round(value * 100))) throw Error('Слишком большое значение ' + label); return value; }
const optionalUnits = (value, label) => value === undefined ? 0 : finiteNumber(value, label, { integer: true, min: 0 });
const optionalCents = (value, label) => value === undefined ? 0 : finiteNumber(value, label, { integer: true }) / 100;
function requiredTime(value, label) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw Error('Некорректное время ' + label); return value; }
function storeFrom(file, prefix, pattern = '\\d+') { const name = path.basename(String(file || '')), match = name.match(new RegExp('^' + prefix + '-(' + pattern + ')\\.json$')); if (!match) throw Error('Неподдерживаемое имя файла источника'); return match[1]; }
const safeInteger = value => { const number = Number(value); return Number.isSafeInteger(number) ? number : String(value); };
const countNumber = value => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw Error('Некорректный счётчик истории'); return number; };

function sourceSpec(sourceFile) {
  const base = path.basename(String(sourceFile || ''));
  if (/^insights-\d+\.json$/u.test(base)) return { base, kind: 'ozon-orders', storeId: storeFrom(base, 'insights') };
  if (/^ledger-\d+\.json$/u.test(base)) return { base, kind: 'ozon-finance', storeId: storeFrom(base, 'ledger') };
  if (/^wb-orders-wb-\d+\.json$/u.test(base)) return { base, kind: 'wb-orders', storeId: storeFrom(base, 'wb-orders', 'wb-\\d+') };
  if (/^order-category-catalog-(?:wb-)?\d+\.json$/u.test(base)) return { base, kind: 'catalog', storeId: storeFrom(base, 'order-category-catalog', '(?:wb-)?\\d+') };
  throw Error('Неподдерживаемое имя файла источника');
}

function rowsForIngestion(kind, storeId, data) {
  if (kind === 'catalog') return { products: data?.products || data?.data?.products };
  if (kind === 'ozon-orders') {
    const orders = data.orders;
    if (!orders || !orders.period) throw Error('Некорректный снимок заказов Ozon');
    const periodDays = days(orders.period.from, orders.period.to), periodSet = new Set(periodDays), actual = requiredTime(orders.skuUpdatedAt || orders.updatedAt, 'заказов Ozon'), byDay = new Map();
    if (!Array.isArray(orders.skuDaily)) throw Error('Некорректный skuDaily');
    for (const row of orders.skuDaily) {
      if (!validDay(row.date) || !periodSet.has(row.date) || row.sku === undefined || row.sku === null || String(row.sku) === '') throw Error('Некорректная строка заказов Ozon');
      const list = byDay.get(row.date) || [];
      list.push({ productId: String(row.sku), observedAt: actual, units: finiteNumber(row.units, 'units', { integer: true, min: 0 }), revenue: finiteNumber(row.revenue, 'revenue') });
      byDay.set(row.date, list);
    }
    let covered;
    if (Array.isArray(orders.skuCoverage)) covered = new Set(orders.skuCoverage);
    else if (orders.skuPeriod) covered = new Set(days(orders.skuPeriod.from, orders.skuPeriod.to));
    else covered = new Set([orders.todayDate || mskDay(actual)]);
    for (const day of covered) if (!validDay(day) || !periodSet.has(day)) throw Error('Некорректное покрытие SKU');
    return { snapshots: [...new Set([...byDay.keys(), ...covered])].map(day => ({ sourceKind: kind, market: 'Ozon', storeId, day, actual, closed: orders.skuDailyCoverage === true && covered.has(day) && mskDay(actual) > day, reason: orders.skuDailyCoverage === true && covered.has(day) && mskDay(actual) > day ? null : 'Покрытие SKU или закрытие дня не подтверждено', rows: byDay.get(day) || [] })) };
  }
  if (kind === 'ozon-finance') {
    const ledger = data.data || data, period = ledger.period, actual = requiredTime(ledger.completedAt || data.stamp, 'финансов Ozon');
    if (!period || !Array.isArray(ledger.skuDaily)) throw Error('Некорректный ledger');
    const periodDays = days(period.from, period.to), periodSet = new Set(periodDays), byDay = new Map();
    for (const row of ledger.skuDaily) {
      if (!validDay(row.date) || !periodSet.has(row.date) || row.sku === undefined || row.sku === null || String(row.sku) === '' || !row.values) throw Error('Некорректная финансовая строка');
      const values = row.values, list = byDay.get(row.date) || [], unknown = values.unknownUnitRows === undefined ? 0 : finiteNumber(values.unknownUnitRows, 'unknownUnitRows', { integer: true, min: 0 });
      list.push({ productId: String(row.sku), observedAt: actual, soldUnits: optionalUnits(values.soldUnits, 'soldUnits'), returnedUnits: optionalUnits(values.returnedUnits, 'returnedUnits'), realized: optionalCents(values.realized, 'realized'), ads: optionalCents(values.ads, 'ads'), unknownUnitRows: unknown });
      byDay.set(row.date, list);
    }
    return { snapshots: periodDays.map(day => ({ sourceKind: kind, market: 'Ozon', storeId, day, actual, closed: ledger.complete === true && mskDay(actual) > day, reason: ledger.complete === true && mskDay(actual) > day ? null : 'Финансы неполны или день ещё открыт', rows: byDay.get(day) || [] })) };
  }
  const day = data.day, actual = requiredTime(data.fetchedAt, 'WB');
  if (!validDay(day) || !Array.isArray(data.orders)) throw Error('Некорректный снимок заказов WB');
  const grouped = new Map();
  for (const order of data.orders) {
    if (order.nmId === undefined || order.nmId === null || String(order.nmId) === '' || !order.at) throw Error('Некорректная строка заказа WB');
    const occurredAt = requiredTime(order.at, 'заказа WB');
    if (mskDay(occurredAt) !== day) throw Error('Дата заказа WB не совпадает с днём снимка');
    const amount = finiteNumber(order.amount, 'amount WB'), id = String(order.nmId), row = grouped.get(id) || { productId: id, units: 0, revenue: 0, events: [] };
    row.units++; row.revenue += amount;
    if (!Number.isSafeInteger(Math.round(row.revenue * 100))) throw Error('Слишком большая сумма WB');
    row.events.push({ occurredAt, amount }); grouped.set(id, row);
  }
  const rows = [...grouped.values()], closed = data.complete === true && mskDay(actual) > day;
  return { snapshots: [{ sourceKind: kind, market: 'WB', storeId, day, actual, closed, reason: closed ? null : 'Снимок WB неполон или день ещё открыт', rows }] };
}

async function batchInsert(client, table, columns, rows, batchSize = INSERT_BATCH) {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize), values = [];
    const tuples = batch.map(row => `(${columns.map(column => { values.push(row[column] ?? null); return '$' + values.length; }).join(',')})`).join(',');
    await queryDatabase(client, `INSERT INTO ${table} (${columns.map(column => `"${column}"`).join(',')}) VALUES ${tuples}`, values);
  }
}

function createMarketHistoryRepository({ pool, schema = 'pult_history', now = Date.now } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') throw new TypeError('pool is required');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const prefix = ident(schema), table = name => `${prefix}."${name}"`;

  async function addSnapshot(client, ingestionId, snapshot) {
    const inserted = await queryDatabase(client, `INSERT INTO ${table('snapshots')}(ingestion_id,source_kind,market,store_id,day,source_actual_at,source_actual_at_text,closed_confirmed,partial_reason) VALUES($1,$2,$3,$4,$5::date,$6::text::timestamptz,$6::text,$7,$8) RETURNING id`, [ingestionId, snapshot.sourceKind, snapshot.market, String(snapshot.storeId), snapshot.day, snapshot.actual, snapshot.closed, snapshot.reason || null]);
    const snapshotId = inserted.rows[0].id;
    const facts = snapshot.rows.map(row => ({ snapshot_id: snapshotId, product_id: String(row.productId), observed_at: row.observedAt || null, observed_at_text: row.observedAt || null, units: row.units ?? null, revenue: row.revenue ?? null, sold_units: row.soldUnits ?? null, returned_units: row.returnedUnits ?? null, realized: row.realized ?? null, ads: row.ads ?? null, unknown_unit_rows: row.unknownUnitRows || 0 }));
    await batchInsert(client, table('facts'), ['snapshot_id', 'product_id', 'observed_at', 'observed_at_text', 'units', 'revenue', 'sold_units', 'returned_units', 'realized', 'ads', 'unknown_unit_rows'], facts);
    return snapshotId;
  }

  function prepareIngestion({ sourceFile, contentHash, data, capturedAt } = {}) {
    if (!sourceFile || !contentHash || !data || typeof data !== 'object') throw Error('Не указаны sourceFile, contentHash или data');
    capturedAt = requiredTime(capturedAt || new Date(now()).toISOString(), 'capturedAt');
    return { ...sourceSpec(sourceFile), contentHash: String(contentHash), data, capturedAt };
  }

  async function ingestPrepared({ base, kind, storeId, contentHash, data, capturedAt }, client) {
    const inserted = await queryDatabase(client, `INSERT INTO ${table('ingestions')}(source_file,content_hash,captured_at,captured_at_text,source_kind) VALUES($1,$2,$3::text::timestamptz,$3::text,$4) ON CONFLICT(source_file,content_hash) DO NOTHING RETURNING id`, [base, contentHash, capturedAt, kind]);
      if (!inserted.rowCount) return { duplicate: true };
      const ingestionId = inserted.rows[0].id, prepared = rowsForIngestion(kind, storeId, data);
      let snapshotCount = 0, factCount = 0;
      if (kind === 'catalog') {
        if (!Array.isArray(prepared.products)) throw Error('Некорректный каталог товаров');
        for (const item of prepared.products) {
          const id = item.sku ?? item.product_id ?? item.nmID;
          if (id === undefined || id === null || String(id) === '') continue;
          const market = String(item.market || data.market || (String(storeId).startsWith('wb-') ? 'WB' : 'Ozon')), name = String(item.name ?? item.title ?? item.offer_id ?? item.vendorCode ?? id);
          if (!['Ozon', 'WB'].includes(market)) throw Error('Некорректная площадка каталога');
        await queryDatabase(client, `INSERT INTO ${table('product_names')} AS existing_row(market,store_id,product_id,name,source_actual_at,source_actual_at_text) VALUES($1,$2,$3,$4,$5::text::timestamptz,$5::text) ON CONFLICT(market,store_id,product_id) DO UPDATE SET name=EXCLUDED.name,source_actual_at=EXCLUDED.source_actual_at,source_actual_at_text=EXCLUDED.source_actual_at_text WHERE EXCLUDED.source_actual_at>=existing_row.source_actual_at`, [market, String(storeId), String(id), name, capturedAt]);
        for (const alias of [item.sku, item.product_id, item.nmID, item.offer_id, item.vendorCode]) if (alias !== undefined && alias !== null && String(alias) !== String(id)) await queryDatabase(client, `INSERT INTO ${table('product_aliases')} AS existing_row(market,store_id,alias,product_id,source_actual_at,source_actual_at_text) VALUES($1,$2,$3,$4,$5::text::timestamptz,$5::text) ON CONFLICT(market,store_id,alias) DO UPDATE SET product_id=EXCLUDED.product_id,source_actual_at=EXCLUDED.source_actual_at,source_actual_at_text=EXCLUDED.source_actual_at_text WHERE EXCLUDED.source_actual_at>=existing_row.source_actual_at`, [market, String(storeId), String(alias), String(id), capturedAt]);
        }
        factCount = prepared.products.length;
      } else {
        for (const snapshot of prepared.snapshots) {
          const snapshotId = await addSnapshot(client, ingestionId, snapshot);
          snapshotCount++; factCount += snapshot.rows.length;
          if (kind === 'wb-orders') {
            const events = snapshot.rows.flatMap(row => row.events.map(event => ({ snapshot_id: snapshotId, product_id: row.productId, occurred_at: event.occurredAt, occurred_at_text: event.occurredAt, amount: event.amount })));
            await batchInsert(client, table('order_events'), ['snapshot_id', 'product_id', 'occurred_at', 'occurred_at_text', 'amount'], events);
          }
        }
      }
      return { duplicate: false, ingestionId: safeInteger(ingestionId), snapshotCount, factCount };
  }

  async function ingestInTransaction(input, client) {
    if (!client || typeof client.query !== 'function') throw new TypeError('transaction client is required');
    return ingestPrepared(prepareIngestion(input), client);
  }

  async function ingest(input) {
    const prepared = prepareIngestion(input), client = await connectDatabase(pool);
    try {
      await queryDatabase(client, 'BEGIN');
      await acquireMutationFence(client);
      const result = await ingestPrepared(prepared, client);
      await queryDatabase(client, 'COMMIT', undefined, { commitOutcome: true });
      return result;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { releaseDatabase(client); }
  }

  async function status() {
    const result = await queryDatabase(pool, `SELECT (SELECT count(*) FROM ${table('ingestions')}) AS ingestions,(SELECT count(*) FROM ${table('snapshots')}) AS snapshots,(SELECT count(*) FROM ${table('facts')}) AS facts,(SELECT count(*) FROM ${table('order_events')}) AS events,(SELECT json_build_object('captured_at',captured_at_text,'source_kind',source_kind) FROM ${table('ingestions')} ORDER BY id DESC LIMIT 1) AS last_import`);
    const row = result.rows[0];
    return { ingestions: countNumber(row.ingestions), snapshots: countNumber(row.snapshots), facts: countNumber(row.facts), events: countNumber(row.events), lastImport: row.last_import || null, retention: 'unbounded' };
  }

  async function report({ from, to, market, storeId, productId, metric = 'revenue' } = {}) {
    const range = days(from, to);
    if (range.length > MAX_REPORT_DAYS) throw Error('Период отчёта превышает 3660 дней; хранение базы при этом бессрочное');
    if (market === undefined || market === null || market === '' || String(market).toLowerCase() === 'all') market = null;
    else if (!['Ozon', 'WB'].includes(String(market))) throw Error('Неизвестная площадка');
    const metricSpec = METRICS[metric]; if (!metricSpec) throw Error('Неизвестная метрика');
    const client = await connectDatabase(pool);
    try {
      await queryDatabase(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const baseValues = [from, to, metricSpec.sources], coverageFilters = [], rowFilters = [];
      if (market) { baseValues.push(String(market)); coverageFilters.push(`market=$${baseValues.length}`); rowFilters.push(`r.market=$${baseValues.length}`); }
      if (storeId) { baseValues.push(String(storeId)); coverageFilters.push(`store_id=$${baseValues.length}`); rowFilters.push(`r.store_id=$${baseValues.length}`); }
      const ranked = `WITH ranked AS (SELECT s.*,row_number() OVER(PARTITION BY source_kind,market,store_id,day ORDER BY source_actual_at DESC,id DESC) rn FROM ${table('snapshots')} s WHERE closed_confirmed=true AND day BETWEEN $1::date AND $2::date AND source_kind=ANY($3::text[]))`;
      const coverageResult = await queryDatabase(client, `${ranked} SELECT market,store_id,to_char(day,'YYYY-MM-DD') AS "day" FROM ranked WHERE rn=1${coverageFilters.length ? ' AND ' + coverageFilters.join(' AND ') : ''}`, baseValues);
      const factValues = [...baseValues], factFilters = [...rowFilters];
      if (productId) { factValues.push(String(productId)); factFilters.push(`f.product_id=$${factValues.length}`); }
      const factsResult = await queryDatabase(client, `${ranked} SELECT r.market,r.store_id,to_char(r.day,'YYYY-MM-DD') AS "day",f.product_id,f.${metricSpec.column} value,f.unknown_unit_rows,p.name FROM ranked r JOIN ${table('facts')} f ON f.snapshot_id=r.id LEFT JOIN ${table('product_aliases')} a ON a.market=r.market AND a.store_id=r.store_id AND a.alias=f.product_id LEFT JOIN ${table('product_names')} p ON p.market=r.market AND p.store_id=r.store_id AND p.product_id=coalesce(a.product_id,f.product_id) WHERE r.rn=1${factFilters.length ? ' AND ' + factFilters.join(' AND ') : ''}`, factValues);
      await queryDatabase(client, 'COMMIT');
      const coverageMap = new Map();
      for (const row of coverageResult.rows) { const key = row.market + '\0' + row.store_id, list = coverageMap.get(key) || []; list.push(row.day); coverageMap.set(key, list); }
      const grouped = new Map();
      for (const row of factsResult.rows) {
        const key = [row.market, row.store_id, row.product_id].join('\0'), item = grouped.get(key) || { market: row.market, storeId: row.store_id, productId: row.product_id, name: row.name || null, values: new Map(), unknownUnitRows: 0 };
        item.values.set(row.day, (item.values.get(row.day) || 0) + (row.value == null ? 0 : Number(row.value)));
        item.unknownUnitRows += Number(row.unknown_unit_rows || 0); grouped.set(key, item);
      }
      const isWeekend = day => [0, 6].includes(new Date(day + 'T12:00:00Z').getUTCDay()), rows = [];
      for (const item of grouped.values()) {
        const covered = coverageMap.get(item.market + '\0' + item.storeId) || [], parts = { weekday: { days: 0, value: 0 }, weekend: { days: 0, value: 0 } };
        for (const day of covered) { const part = isWeekend(day) ? parts.weekend : parts.weekday; part.days++; part.value += item.values.get(day) || 0; }
        for (const part of Object.values(parts)) part.averagePerDay = part.days ? part.value / part.days : null;
        const value = parts.weekday.value + parts.weekend.value;
        rows.push({ market: item.market, storeId: item.storeId, productId: item.productId, name: item.name, totals: { value, [metric]: value, unknownUnitRows: item.unknownUnitRows, unitsComplete: item.unknownUnitRows === 0 }, weekday: parts.weekday, weekend: parts.weekend });
      }
      rows.sort((a, b) => b.totals.value - a.totals.value || a.storeId.localeCompare(b.storeId) || a.productId.localeCompare(b.productId));
      const confirmedDays = new Set(coverageResult.rows.map(row => row.market + '\0' + row.store_id + '\0' + row.day));
      return { period: { from, to, timeZone: 'Europe/Moscow' }, metric, rows, coverage: { requestedDays: range.length, confirmedStoreDays: confirmedDays.size, excludedPartialOrOpen: true }, limitations: [...LIMITATIONS] };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { releaseDatabase(client); }
  }

  return { ingest, ingestInTransaction, status, report, async close() {} };
}

module.exports = { createMarketHistoryRepository, HistoryRepositoryError, MAX_REPORT_DAYS };
