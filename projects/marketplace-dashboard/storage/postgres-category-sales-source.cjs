'use strict';

const codecs = require('./postgres-live-codecs.cjs');

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const STORE = /^(?:wb-)?[0-9]+$/u;
const CATEGORY_SALES_REVISION_SQL = String.raw`
SELECT h.store_id,h.domain,h.revision::text
FROM pult_live.heads h
WHERE (h.domain='market' AND h.store_id=ANY($1::text[]))
 OR (h.domain='ledger' AND h.store_id=ANY($2::text[]))
ORDER BY h.store_id COLLATE "C",h.domain COLLATE "C"`;

const CATEGORY_SALES_SQL = String.raw`
WITH selected AS MATERIALIZED (
 SELECT store_id,market,selected
 FROM jsonb_to_recordset($1::jsonb) AS value(store_id text,market text,selected boolean)
), source_heads AS MATERIALIZED (
 SELECT s.store_id,s.market,s.selected,m.metadata AS market_metadata,m.source_metadata AS market_source_metadata,
  f.metadata AS finance_metadata,f.source_metadata AS finance_source_metadata
 FROM selected s
 LEFT JOIN pult_live.heads m ON m.store_id=s.store_id AND m.domain='market'
 LEFT JOIN pult_live.heads f ON f.store_id=s.store_id AND f.domain='ledger'
)
SELECT h.store_id,h.market,h.selected,h.market_metadata,h.market_source_metadata,h.finance_metadata,h.finance_source_metadata,
 COALESCE((SELECT json_agg(rows.value ORDER BY rows.source_order)
  FROM (SELECT p.source_order,p.value FROM pult_live.facts p
   WHERE p.store_id=h.store_id AND p.domain='market' AND p.entity_type='products') rows),'[]'::json) AS products,
 CASE WHEN NOT h.selected THEN '[]'::json
  WHEN h.market='Ozon' THEN COALESCE((SELECT json_agg(rows.value ORDER BY rows.source_order)
   FROM (SELECT l.source_order,l.value FROM pult_live.facts l
    WHERE l.store_id=h.store_id AND l.domain='ledger'
     AND l.entity_type=CASE WHEN $4::boolean THEN 'data.daily' ELSE 'data.skuDaily' END
     AND (l.business_day BETWEEN $2::date AND $3::date OR l.business_day IS NULL)) rows),'[]'::json)
  ELSE '[]'::json END AS finance_rows,
 wb.invalid_date AS wb_invalid_date,wb.observed_to::text AS wb_observed_to,COALESCE(wb.daily,'[]'::json) AS wb_daily
FROM source_heads h
LEFT JOIN LATERAL (
 WITH base AS MATERIALIZED (
  SELECT o.source_order,
   CASE WHEN jsonb_typeof(o.value->'rrDate')='string' AND substring(o.value->>'rrDate',1,10) ~ '^\d{4}-\d{2}-\d{2}$'
    AND pg_input_is_valid(substring(o.value->>'rrDate',1,10),'date') THEN substring(o.value->>'rrDate',1,10)::date ELSE NULL END AS operation_day,
   o.value->>'sellerOperName' AS operation_type,o.value->>'nmId' AS nm_id,
   CASE
    WHEN jsonb_typeof(o.value->'rrdId')='string' AND o.value->>'rrdId' ~ '^\d+$'
     THEN CASE WHEN o.value->'reportId' IS NULL OR jsonb_typeof(o.value->'reportId')='null' THEN '' WHEN jsonb_typeof(o.value->'reportId') IN ('object','array') THEN '[object Object]' ELSE o.value->>'reportId' END||':'||(o.value->>'rrdId')
    WHEN jsonb_typeof(o.value->'rrdId')='number' AND o.value->>'rrdId' ~ '^-?\d+(?:\.0+)?$'
     AND (o.value->>'rrdId')::numeric BETWEEN -9007199254740991 AND 9007199254740991
     THEN CASE WHEN o.value->'reportId' IS NULL OR jsonb_typeof(o.value->'reportId')='null' THEN '' WHEN jsonb_typeof(o.value->'reportId') IN ('object','array') THEN '[object Object]' ELSE o.value->>'reportId' END||':'||trunc((o.value->>'rrdId')::numeric)::text
    ELSE '@'||o.source_order::text END AS identity,
   CASE
    WHEN jsonb_typeof(o.value->'quantity')='number' AND o.value->>'quantity' ~ '^\d+(?:\.0+)?$'
     AND (o.value->>'quantity')::numeric <= 9007199254740991 THEN (o.value->>'quantity')::numeric
    WHEN jsonb_typeof(o.value->'quantity')='string' AND btrim(o.value->>'quantity') ~ '^\d+(?:\.0+)?$'
     AND btrim(o.value->>'quantity')::numeric <= 9007199254740991 THEN btrim(o.value->>'quantity')::numeric
    ELSE NULL END AS quantity
  FROM pult_live.facts o WHERE o.store_id=h.store_id AND o.domain='market' AND o.entity_type='operations'
 ), period_rows AS MATERIALIZED (
  SELECT * FROM base WHERE operation_day BETWEEN $2::date AND $3::date AND operation_type IN ('Продажа','Возврат')
 ), dedup AS MATERIALIZED (
  SELECT *,row_number() OVER(PARTITION BY identity ORDER BY source_order) AS duplicate_rank FROM period_rows
 ), grouped AS (
  SELECT operation_day,nm_id,operation_type,min(source_order) AS source_order,
   bool_and(quantity IS NOT NULL) AS quantity_known,sum(quantity) AS quantity
  FROM dedup WHERE duplicate_rank=1
  GROUP BY operation_day,nm_id,operation_type
 )
 SELECT COALESCE(bool_or(operation_day IS NULL),false) AS invalid_date,max(operation_day) AS observed_to,
  (SELECT json_agg(json_build_object('date',g.operation_day::text,'nmId',g.nm_id,'sellerOperName',g.operation_type,
    'quantity',CASE WHEN g.quantity_known THEN g.quantity ELSE NULL END,'quantityKnown',g.quantity_known) ORDER BY g.source_order) FROM grouped g) AS daily
 FROM base
) wb ON h.selected AND h.market='WB'
ORDER BY h.store_id COLLATE "C"`;

function createPostgresCategorySalesSource({pool} = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  const cache = new Map();
  async function read({stores, selectedIds, from, to, allProducts} = {}) {
    if (!Array.isArray(stores) || stores.some(store => !store || !STORE.test(store.id) || !['Ozon', 'WB'].includes(store.market))) throw new TypeError('Valid category stores are required');
    if (!(selectedIds instanceof Set) || !DAY.test(from || '') || !DAY.test(to || '') || from > to || typeof allProducts !== 'boolean') throw new TypeError('Valid category sales scope is required');
    const scope = stores.map(store => ({store_id: store.id, market: store.market, selected: selectedIds.has(store.id)}));
    if (!scope.length) return {products: [], facts: []};
    const ledgerIds=stores.filter(store=>selectedIds.has(store.id)&&store.market==='Ozon').map(store=>store.id);
    const revisions=await pool.query(CATEGORY_SALES_REVISION_SQL,[stores.map(store=>store.id),ledgerIds]);
    if(!revisions||!Array.isArray(revisions.rows))throw Error('Invalid category sales revision source');
    const cacheKey=JSON.stringify([scope,from,to,allProducts,revisions.rows.map(row=>[row.store_id,row.domain,row.revision])]);
    if(cache.has(cacheKey)){const value=cache.get(cacheKey);cache.delete(cacheKey);cache.set(cacheKey,value);return structuredClone(value)}
    const result = await pool.query(CATEGORY_SALES_SQL, [JSON.stringify(scope), from, to, allProducts]);
    if (!result || !Array.isArray(result.rows) || result.rows.length !== stores.length) throw Error('Invalid category sales SQL source');
    const products = [], facts = [];
    for (const row of result.rows) {
      if (!row || !STORE.test(String(row.store_id)) || !['Ozon', 'WB'].includes(row.market) || !Array.isArray(row.products) || !Array.isArray(row.finance_rows)) throw Error('Invalid category sales SQL row');
      const storeId = String(row.store_id);
      for (const product of row.products) products.push({...structuredClone(product), storeId, key: storeId + ':' + String(product?.product_id ?? product?.nmID ?? product?.sku ?? '')});
      if (row.selected !== true) continue;
      if (row.market === 'Ozon') {
        if (row.finance_metadata == null) { facts.push([storeId, null]); continue; }
        const sourcePath = `ledger-${storeId}.json`;
        if (row.finance_source_metadata?.sourcePath !== sourcePath) throw Error('Invalid category sales ledger metadata');
        const value = codecs.decodeMetadata(sourcePath, row.finance_metadata);
        if (!value?.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw Error('Invalid category sales ledger metadata');
        value.data[allProducts ? 'daily' : 'skuDaily'] = structuredClone(row.finance_rows);
        facts.push([storeId, value]);
      } else {
        if (row.market_metadata == null) { facts.push([storeId, null]); continue; }
        const sourcePath = `data-${storeId}.json`;
        if (row.market_source_metadata?.sourcePath !== sourcePath) throw Error('Invalid category sales market metadata');
        const value = codecs.decodeMetadata(sourcePath, row.market_metadata);
        value.operations = [];
        value._categorySales = {invalidDate: row.wb_invalid_date === true, observedTo: typeof row.wb_observed_to === 'string' ? row.wb_observed_to : null, rows: structuredClone(row.wb_daily)};
        facts.push([storeId, value]);
      }
    }
    const value={products,facts,revision:cacheKey};if(cache.size>=4)cache.delete(cache.keys().next().value);cache.set(cacheKey,structuredClone(value));return value;
  }
  return Object.freeze({read});
}

module.exports = {createPostgresCategorySalesSource, CATEGORY_SALES_SQL, CATEGORY_SALES_REVISION_SQL};
