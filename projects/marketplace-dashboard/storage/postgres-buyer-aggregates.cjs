'use strict';

const PATH_PATTERN='^buyer-(order-segments)-([0-9]{4}-[0-9]{2}-[0-9]{2})_([0-9]{4}-[0-9]{2}-[0-9]{2})(-retry-([0-9]+))?(\\.partial)?\\.json$';
const PRODUCT_PATH_PATTERN=PATH_PATTERN;
const TYPES=['legal','individual','unknown'];

function selection(pattern){return `
 heads0 AS MATERIALIZED (
  SELECT h.store_id,h.domain,h.metadata,h.source_metadata->>'sourcePath' AS source_path,
   regexp_match(h.source_metadata->>'sourcePath',$3) AS match
  FROM pult_live.heads h
  WHERE h.domain='buyers' AND h.source_metadata->>'sourcePath' ~ $3
 ), candidates AS MATERIALIZED (
  SELECT *,match[2] AS range_from,match[3] AS range_to,COALESCE(NULLIF(match[5],''),'0')::integer AS retry,
   match[6] IS NOT NULL AS partial,COALESCE(metadata->>'generatedAt','') AS generated_at
  FROM heads0 WHERE match[2] <= $2 AND match[3] >= $1
 ), selected AS MATERIALIZED (
  SELECT * FROM (
   SELECT c.*,row_number() OVER(PARTITION BY range_from,range_to ORDER BY retry DESC,source_path DESC) AS choice
   FROM candidates c WHERE NOT partial
  ) ranked WHERE choice=1
  UNION ALL SELECT c.*,1 FROM candidates c WHERE partial
 )`}

// Validation, Date.parse and sequential safe-integer overflow handling remain
// in the original JS reducer. SQL only selects and transports original records.
// Aggregate each entity collection independently so PostgreSQL can read it in
// source_order from live_facts_entity_order_idx. A single filtered aggregate over
// every entity forced a 100-190 MB external merge sort for each buyer request.
// Return one row per document; wrapping all documents in another JSON aggregate
// only adds a second serialization/parse pass in PostgreSQL and the pg driver.
const ORDER_SQL=`WITH${selection(PATH_PATTERN)}
 SELECT s.source_path,s.generated_at,s.partial,
  COALESCE((SELECT json_agg(ordered.value) FROM (SELECT f.value FROM pult_live.facts f
   WHERE f.store_id=s.store_id AND f.domain=s.domain AND f.entity_type='records' ORDER BY f.source_order) ordered),'[]'::json) AS records,
  COALESCE((SELECT json_agg(ordered.value) FROM (SELECT f.value FROM pult_live.facts f
   WHERE f.store_id=s.store_id AND f.domain=s.domain AND f.entity_type='report.coverage.sources' ORDER BY f.source_order) ordered),'[]'::json) AS sources
 FROM selected s`;

// Keep original product rows and their source order. The existing JS reducer rounds
// after every row; a SQL SUM (including a sum of rounded rows) is not equivalent.
// Original order identities also prevent compact rows from different days colliding.
const PRODUCT_SQL=`WITH${selection(PRODUCT_PATH_PATTERN)}
 SELECT s.source_path,s.generated_at,s.partial,
  COALESCE((SELECT json_agg(ordered.value) FROM (SELECT f.value FROM pult_live.facts f
   WHERE f.store_id=s.store_id AND f.domain=s.domain AND f.entity_type='records' ORDER BY f.source_order) ordered),'[]'::json) AS records,
  COALESCE((SELECT json_agg(ordered.value) FROM (SELECT f.value FROM pult_live.facts f
   WHERE f.store_id=s.store_id AND f.domain=s.domain AND f.entity_type='productOrders' ORDER BY f.source_order) ordered),'[]'::json) AS products,
  COALESCE((SELECT json_agg(ordered.value) FROM (SELECT f.value FROM pult_live.facts f
   WHERE f.store_id=s.store_id AND f.domain=s.domain AND f.entity_type='report.coverage.sources' ORDER BY f.source_order) ordered),'[]'::json) AS sources
 FROM selected s`;

// Resolve only products present in the selected buyer result. Previously the
// endpoint opened every complete market document independently (four SQL calls
// per store), although it only needed names for a few hundred product ids.
const PRODUCT_CATALOG_SQL=`SELECT f.store_id,f.value
FROM pult_live.facts f
WHERE f.domain='market' AND f.entity_type='products' AND f.store_id=ANY($1::text[])
ORDER BY f.store_id,f.source_order`;

// Any buyer snapshot or market catalog revision invalidates the small in-process
// projection cache. PostgreSQL remains the source of truth and no TTL can serve
// stale data after a committed sync.
const PRODUCT_REVISION_SQL=`SELECT COALESCE(jsonb_agg(jsonb_build_array(domain,store_id,revision) ORDER BY domain,store_id),'[]'::jsonb)::text AS revision,
 COALESCE(bool_or(domain='buyers' AND source_metadata->>'sourcePath' ~ ('^buyer-product-segments-'||$1::text||'_'||$2::text||'(?:-retry-[0-9]+)?\\.json$')),false) AS prepared
FROM pult_live.heads WHERE domain IN ('buyers','market')`;

function createPostgresBuyerAggregates({pool}={}){
 if(!pool||typeof pool.query!=='function')throw new TypeError('PostgreSQL pool is required');
 async function run(sql,{from,to}={},products=false){
  const result=await pool.query(sql,[from,to,PATH_PATTERN]);
  const rows=result.rows.slice().sort((a,b)=>String(a.source_path||'').localeCompare(String(b.source_path||'')));
  return {documents:rows.map(row=>({_sourcePath:row.source_path,generatedAt:row.generated_at,_partialSource:row.partial,records:row.records,...(products?{productOrders:row.products}:{}),report:{coverage:{sources:row.sources}}}))};
 }
 const product=options=>run(PRODUCT_SQL,options,true);
 product.revision=async({from,to}={})=>{const row=(await pool.query(PRODUCT_REVISION_SQL,[from,to])).rows[0];return{key:String(row?.revision||'[]'),prepared:row?.prepared===true}};
 product.catalogs=async({storeIds=[],productIds=[]}={})=>{
  const ids=new Set(productIds.map(String)),selectedStores=[...new Set(storeIds.map(String))],catalogs=new Map(selectedStores.map(id=>[id,{products:[]} ]));
  if(!ids.size||!selectedStores.length)return catalogs;
  const result=await pool.query(PRODUCT_CATALOG_SQL,[selectedStores]);
  for(const row of result.rows){
   const value=row.value,matches=['sku','product_id','nmID','offer_id','vendorCode'].some(field=>value?.[field]!==undefined&&value?.[field]!==null&&ids.has(String(value[field])));
   if(!matches)continue;
   const storeId=String(row.store_id),catalog=catalogs.get(storeId)||{products:[]};catalog.products.push(value);catalogs.set(storeId,catalog);
  }
  return catalogs;
 };
 return Object.freeze({order:options=>run(ORDER_SQL,options),product});
}

module.exports={createPostgresBuyerAggregates,ORDER_SQL,PRODUCT_SQL,PRODUCT_CATALOG_SQL,PRODUCT_REVISION_SQL,TYPES};
