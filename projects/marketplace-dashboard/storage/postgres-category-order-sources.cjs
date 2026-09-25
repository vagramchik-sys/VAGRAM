'use strict';

// Match getSnapshots exactly: overlapping base and partial documents, no retries.
const PATH_PATTERN = '^buyer-order-segments-([0-9]{4}-[0-9]{2}-[0-9]{2})_([0-9]{4}-[0-9]{2}-[0-9]{2})(\\.partial)?\\.json$';
const RECORD_FIELDS = ['market', 'storeId', 'scheme', 'createdAt'];
const PRODUCT_FIELDS = ['market', 'storeId', 'scheme', 'postingId', 'orderId', 'productId', 'orderedAt', 'updatedAt', 'units', 'amountRub'];
const tuple = fields => `json_build_array(${fields.map(field => `f.value->'${field}'`).join(',')})`;
const SQL = `WITH candidates AS MATERIALIZED (
 SELECT h.store_id,h.domain,h.metadata,h.revision,h.source_metadata->>'sourcePath' AS source_path,
 regexp_match(h.source_metadata->>'sourcePath',$3) AS parts
 FROM pult_live.heads h WHERE h.domain='buyers' AND h.source_metadata->>'sourcePath' ~ $3
), selected AS MATERIALIZED (
 SELECT * FROM candidates WHERE parts[1] <= $2 AND parts[2] >= $1
)
SELECT s.source_path,s.revision::text AS revision,s.metadata->'generatedAt' AS generated_at,
 CASE WHEN $4::jsonb->>s.source_path = s.revision::text THEN NULL ELSE COALESCE((SELECT json_agg(r.row) FROM (SELECT ${tuple(RECORD_FIELDS)} AS row
  FROM pult_live.facts f WHERE f.store_id=s.store_id AND f.domain=s.domain AND f.entity_type='records'
  ORDER BY f.source_order) r),'[]'::json) END AS records,
 CASE WHEN $4::jsonb->>s.source_path = s.revision::text THEN NULL ELSE COALESCE((SELECT json_agg(r.row) FROM (SELECT ${tuple(PRODUCT_FIELDS)} AS row
  FROM pult_live.facts f WHERE f.store_id=s.store_id AND f.domain=s.domain AND f.entity_type='productOrders'
  ORDER BY f.source_order) r),'[]'::json) END AS products,
 CASE WHEN $4::jsonb->>s.source_path = s.revision::text THEN NULL ELSE COALESCE((SELECT json_agg(r.value) FROM (SELECT f.value
  FROM pult_live.facts f WHERE f.store_id=s.store_id AND f.domain=s.domain AND f.entity_type='report.coverage.sources'
  ORDER BY f.source_order) r),'[]'::json) END AS sources
FROM selected s`;

function createCategoryOrderSources({pool} = {}) {
 if (typeof pool?.query !== 'function') throw new TypeError('PostgreSQL pool is required');
 const cache = new Map(); let cachedRows = 0;
 return async function getSnapshots({from,to} = {}) {
  const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0,10) === value;
  if (!valid(from) || !valid(to) || from > to) throw Error('Buyer source period is invalid');
  // Retain the same bounded, revision-validated source reuse as the full source
  // provider. Filter switches read fresh heads but skip unchanged fact rows.
  const known = new Map(cache), revisions = Object.fromEntries([...known].map(([path,item]) => [path,item.revision]));
  const {rows} = await pool.query(SQL,[from,to,PATH_PATTERN,JSON.stringify(revisions)]);
  // localeCompare is intentional: this is also the order of the original source
  // provider. The JS reducer retains its exact tie, date, overflow and tombstone
  // semantics. Never filter product rows by date before selecting their winner.
  return rows.sort((a,b) => a.source_path.localeCompare(b.source_path)).map(row => {
   if (typeof row.revision !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(row.revision)) throw Error('Invalid category source revision');
   const previous = known.get(row.source_path);
   if (row.records === null) {
    if (!previous || previous.revision !== row.revision) throw Error('Invalid category source revision');
    return previous.value;
   }
   const value = {
   generatedAt: row.generated_at,
   records: row.records.map(([market,storeId,scheme,createdAt]) => ({market,storeId,scheme,createdAt})),
   productOrders: row.products.map(([market,storeId,scheme,postingId,orderId,productId,orderedAt,updatedAt,units,amountRub]) => ({market,storeId,scheme,postingId,orderId,productId,orderedAt,updatedAt,units,amountRub})),
   report: {coverage: {sources: row.sources}}
   };
   const cost = value.records.length + value.productOrders.length;
   if (cost <= 500000) {
    const existing = cache.get(row.source_path);
    if (existing) {cachedRows -= existing.cost; cache.delete(row.source_path);}
    cache.set(row.source_path,{revision:row.revision,value,cost}); cachedRows += cost;
    while (cache.size > 8 || cachedRows > 500000) {
     const oldest = cache.keys().next().value; cachedRows -= cache.get(oldest).cost; cache.delete(oldest);
    }
   }
   return value;
  });
 };
}

module.exports = {createCategoryOrderSources,SQL,PATH_PATTERN,RECORD_FIELDS,PRODUCT_FIELDS};
