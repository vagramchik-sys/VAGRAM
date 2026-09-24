'use strict';

// A single MVCC statement reads small heads and date-scoped normalized facts.
// Existing live_facts_day_idx/entity_order_idx cover these access paths. Historical
// WB events are deliberately not joined: they lack a snapshot-leading index.
const SQL = `WITH heads AS MATERIALIZED (
 SELECT store_id,domain,metadata,entity_counts FROM pult_live.heads
 WHERE store_id=ANY($1::text[]) AND domain IN ('insights','intraday','wb-orders')
), observations AS (
 SELECT DISTINCT ON (f.store_id,f.business_day,left(f.value->>'at',14),
   floor(substring(f.value->>'at',15,2)::numeric/15))
  f.store_id,f.value
 FROM heads h JOIN pult_live.facts f ON f.store_id=h.store_id AND f.domain=h.domain
 WHERE h.domain='intraday' AND f.entity_type='points'
  AND f.business_day BETWEEN $2::date AND $3::date AND f.value->>'source'='orders'
  AND f.value->>'at' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}([.]\\d+)?Z$'
 ORDER BY f.store_id,f.business_day,left(f.value->>'at',14),
  floor(substring(f.value->>'at',15,2)::numeric/15),f.value->>'at' DESC,f.source_order DESC
), wb AS (
 SELECT f.store_id, floor(extract(epoch FROM (f.value->>'at')::timestamptz)/900)*900 AS bucket,
  count(*)::integer AS units,
  CASE WHEN bool_and(jsonb_typeof(f.value->'amount')='number' AND (f.value->>'amount')::numeric>=0)
    THEN sum(round((f.value->>'amount')::numeric*100))/100 END AS revenue,
  min(f.value->>'at') AS first_at,max(f.value->>'at') AS last_at
 FROM heads h JOIN pult_live.facts f ON f.store_id=h.store_id AND f.domain=h.domain
 WHERE h.domain='wb-orders' AND f.entity_type='orders'
  AND h.metadata->>'day' BETWEEN $2::text AND $3::text
 GROUP BY f.store_id,bucket
)
SELECT 'head' AS kind,store_id,domain,jsonb_build_object(
 'orders',CASE WHEN domain='insights' THEN metadata->'orders' ELSE NULL END,
 'orderSection',metadata#>'{sections,orders}',
 'day',metadata->'day','fetchedAt',metadata->'fetchedAt','complete',metadata->'complete',
 'orderedRevenue',metadata->'orderedRevenue','orderedUnits',metadata->'orderedUnits',
 'orderRowsPresent',metadata ? 'orders','orderRowsCount',entity_counts->'orders',
 'errorCode',metadata->'errorCode') AS value FROM heads
UNION ALL
SELECT 'daily',f.store_id,f.domain,f.value FROM heads h
 JOIN pult_live.facts f ON f.store_id=h.store_id AND f.domain=h.domain
 WHERE h.domain='insights' AND f.entity_type='orders.daily'
  AND f.business_day BETWEEN $2::date AND $3::date
UNION ALL SELECT 'observation',store_id,'intraday',value FROM observations
UNION ALL SELECT 'wb-interval',store_id,'wb-orders',jsonb_build_object(
 'from',to_char(to_timestamp(bucket) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000Z"'),
 'orderedUnits',units,'orderedRevenue',revenue,'firstAt',first_at,'lastAt',last_at) FROM wb`;

function createBusinessDynamicsRepository({pool}={}) {
 if(typeof pool?.query!=='function')throw new TypeError('SQL read pool is required');
 return Object.freeze({async read({storeIds,from,to}) {
  if(!Array.isArray(storeIds)||storeIds.length>100||storeIds.some(id=>typeof id!=='string'||!/^(?:wb-)?[0-9]+$/.test(id))||new Set(storeIds).size!==storeIds.length)throw new TypeError('Invalid store scope');
  const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
  if(!validDate(from)||!validDate(to)||Date.parse(to)-Date.parse(from)!==28*86400000)throw new TypeError('Expected a bounded 29-day window');
  if(!storeIds.length)return [];
  return (await pool.query(SQL,[storeIds,from,to])).rows;
 }});
}
module.exports={createBusinessDynamicsRepository,SQL};
