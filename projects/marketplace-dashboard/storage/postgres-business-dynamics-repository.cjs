'use strict';

// A single MVCC statement reads small heads and date-scoped normalized facts.
// Existing live_facts_day_idx/entity_order_idx cover the live access paths.
// Historical WB order timestamps come from one latest normalized snapshot per day;
// older snapshots of the same day must never be added together.
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
), wb_history AS MATERIALIZED (
 SELECT DISTINCT ON (s.store_id,s.day)
  s.id,s.store_id,s.day,s.source_actual_at
 FROM pult_history.snapshots s
 WHERE s.market='WB' AND s.source_kind='wb-orders'
  AND s.store_id=ANY($1::text[]) AND s.day BETWEEN $2::date AND $3::date
 ORDER BY s.store_id,s.day,s.source_actual_at DESC,s.id DESC
), wb_history_intervals AS MATERIALIZED (
 SELECT s.id,s.store_id,s.day,
  floor(extract(epoch FROM e.occurred_at)/900)*900 AS bucket,
  count(*)::integer AS units,
  round(sum(e.amount)::numeric,2) AS revenue,
  min(e.occurred_at) AS first_at,max(e.occurred_at) AS last_at
 FROM wb_history s JOIN pult_history.order_events e ON e.snapshot_id=s.id
 GROUP BY s.id,s.store_id,s.day,bucket
), wb_history_totals AS (
 SELECT s.id,s.store_id,s.day,s.source_actual_at,
  coalesce(sum(i.units),0)::integer AS units,
  coalesce(sum(i.revenue),0)::numeric AS revenue
 FROM wb_history s LEFT JOIN wb_history_intervals i ON i.id=s.id
 GROUP BY s.id,s.store_id,s.day,s.source_actual_at
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
 'orderedUnits',units,'orderedRevenue',revenue,'firstAt',first_at,'lastAt',last_at) FROM wb
UNION ALL SELECT 'wb-history-head',store_id,'wb-orders',jsonb_build_object(
 'day',day,'fetchedAt',source_actual_at,'complete',true,
 'orderedRevenue',revenue,'orderedUnits',units,
 'orderRowsPresent',true,'orderRowsCount',units) FROM wb_history_totals
UNION ALL SELECT 'wb-history-interval',store_id,'wb-orders',jsonb_build_object(
 'day',day,
 'from',to_char(to_timestamp(bucket) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000Z"'),
 'orderedUnits',units,'orderedRevenue',revenue,
 'firstAt',first_at,'lastAt',last_at) FROM wb_history_intervals`;

const TARGET_SQL = `SELECT business_day::text,scope_type,scope_id,amount_cents::text,currency,time_zone,updated_at
 FROM pult_live.daily_sales_targets
 WHERE business_day=$1::date AND scope_type=$2 AND scope_id=$3`;
const SAVE_TARGET_SQL = `INSERT INTO pult_live.daily_sales_targets(business_day,scope_type,scope_id,amount_cents,currency,time_zone,updated_at)
 VALUES ($1::date,'all','',$2::bigint,'RUB','Europe/Moscow',clock_timestamp())
 ON CONFLICT (business_day,scope_type,scope_id) DO UPDATE
 SET amount_cents=EXCLUDED.amount_cents,updated_at=clock_timestamp()
 RETURNING business_day::text,scope_type,scope_id,amount_cents::text,currency,time_zone,updated_at`;

function createBusinessDynamicsRepository({pool,writePool=pool}={}) {
 if(typeof pool?.query!=='function')throw new TypeError('SQL read pool is required');
 const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
 return Object.freeze({async read({storeIds,from,to}) {
  if(!Array.isArray(storeIds)||storeIds.length>100||storeIds.some(id=>typeof id!=='string'||!/^(?:wb-)?[0-9]+$/.test(id))||new Set(storeIds).size!==storeIds.length)throw new TypeError('Invalid store scope');
  if(!validDate(from)||!validDate(to)||Date.parse(to)-Date.parse(from)!==28*86400000)throw new TypeError('Expected a bounded 29-day window');
  if(!storeIds.length)return [];
  return (await pool.query(SQL,[storeIds,from,to])).rows;
 },async readTarget({date,scopeType,scopeId}) {
  const validScope=scopeType==='all'&&scopeId===''||scopeType==='marketplace'&&['Ozon','WB'].includes(scopeId)||scopeType==='store'&&typeof scopeId==='string'&&/^(?:wb-)?[0-9]+$/.test(scopeId);
  if(!validDate(date)||!validScope)throw new TypeError('Invalid sales target scope');
  let rows;
  try { rows=(await pool.query(TARGET_SQL,[date,scopeType,scopeId])).rows; }
  catch(error) {
   // The additive target migration may be applied after the web code rolls out.
   // An absent plan must not make the sales dashboard unavailable.
   if(error?.code==='42P01')return null;
   throw error;
  }
  if(rows.length!==1)return null;
  const row=rows[0],amount=Number(row.amount_cents),updated=Date.parse(row.updated_at);
  if(!Number.isSafeInteger(amount)||amount<0||row.currency!=='RUB'||row.time_zone!=='Europe/Moscow'||!Number.isFinite(updated))throw new TypeError('Invalid sales target row');
  const scope=scopeType==='all'?{type:'all'}:scopeType==='marketplace'?{type:'marketplace',marketplace:scopeId}:{type:'store',storeId:scopeId};
  return {date:row.business_day,scope,amountCents:amount,currency:'RUB',timeZone:'Europe/Moscow',updatedAt:new Date(updated).toISOString()};
 },async saveTarget({date,amountCents}) {
  if(!validDate(date)||!Number.isSafeInteger(amountCents)||amountCents<=0||typeof writePool?.query!=='function')throw new TypeError('Invalid sales target');
  const rows=(await writePool.query(SAVE_TARGET_SQL,[date,String(amountCents)])).rows;
  if(rows.length!==1)throw new TypeError('Sales target write returned no row');
  const row=rows[0];
  return {date:row.business_day,scope:{type:'all'},amountCents:Number(row.amount_cents),currency:row.currency,timeZone:row.time_zone,updatedAt:new Date(row.updated_at).toISOString()};
 }});
}
module.exports={createBusinessDynamicsRepository,SQL,TARGET_SQL,SAVE_TARGET_SQL};
