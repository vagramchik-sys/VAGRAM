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
// Build transport envelopes as JSON: nested JSONB aggregates repeatedly rebuild
// large binary documents that are immediately serialized for the pg driver.
// Stored values remain JSONB; row order and the JS number parsing are unchanged.
const ORDER_SQL=`WITH${selection(PATH_PATTERN)},
 document_rows AS (
  SELECT s.source_path,s.generated_at,s.partial,
   COALESCE(json_agg(f.value ORDER BY f.source_order) FILTER(WHERE f.entity_type='records'),'[]'::json) AS records,
   COALESCE(json_agg(f.value ORDER BY f.source_order) FILTER(WHERE f.entity_type='report.coverage.sources'),'[]'::json) AS sources
  FROM selected s LEFT JOIN pult_live.facts f ON f.store_id=s.store_id AND f.domain=s.domain
   AND f.entity_type IN ('records','report.coverage.sources')
  GROUP BY s.source_path,s.generated_at,s.partial
 )
 SELECT json_build_object('documents',COALESCE(json_agg(json_build_object(
  '_sourcePath',source_path,'generatedAt',generated_at,'_partialSource',partial,'records',records,
  'report',json_build_object('coverage',json_build_object('sources',sources))) ORDER BY source_path),'[]'::json)) AS payload
 FROM document_rows`;

// Keep original product rows and their source order. The existing JS reducer rounds
// after every row; a SQL SUM (including a sum of rounded rows) is not equivalent.
// Original order identities also prevent compact rows from different days colliding.
const PRODUCT_SQL=`WITH${selection(PRODUCT_PATH_PATTERN)},
 document_rows AS (
  SELECT s.source_path,s.generated_at,s.partial,
   COALESCE(json_agg(f.value ORDER BY f.source_order) FILTER(WHERE f.entity_type='records'),'[]'::json) AS records,
   COALESCE(json_agg(f.value ORDER BY f.source_order) FILTER(WHERE f.entity_type='productOrders'),'[]'::json) AS products,
   COALESCE(json_agg(f.value ORDER BY f.source_order) FILTER(WHERE f.entity_type='report.coverage.sources'),'[]'::json) AS sources
  FROM selected s LEFT JOIN pult_live.facts f ON f.store_id=s.store_id AND f.domain=s.domain
   AND f.entity_type IN ('records','productOrders','report.coverage.sources')
  GROUP BY s.source_path,s.generated_at,s.partial
 )
 SELECT json_build_object('documents',COALESCE(json_agg(json_build_object(
  '_sourcePath',source_path,'generatedAt',generated_at,'_partialSource',partial,'records',records,'productOrders',products,
  'report',json_build_object('coverage',json_build_object('sources',sources))) ORDER BY source_path),'[]'::json)) AS payload
 FROM document_rows`;

function createPostgresBuyerAggregates({pool}={}){
 if(!pool||typeof pool.query!=='function')throw new TypeError('PostgreSQL pool is required');
 async function run(sql,{from,to}={}){const result=await pool.query(sql,[from,to,PATH_PATTERN]),payload=result.rows[0]?.payload||null;if(Array.isArray(payload?.documents))payload.documents.sort((a,b)=>String(a._sourcePath||'').localeCompare(String(b._sourcePath||'')));return payload}
 return Object.freeze({order:options=>run(ORDER_SQL,options),product:options=>run(PRODUCT_SQL,options)});
}

module.exports={createPostgresBuyerAggregates,ORDER_SQL,PRODUCT_SQL,TYPES};
