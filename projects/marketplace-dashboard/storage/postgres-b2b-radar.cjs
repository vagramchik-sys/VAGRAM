'use strict';

const SOURCE_PATTERN='^buyer-(order-segments)-([0-9]{4}-[0-9]{2}-[0-9]{2})_([0-9]{4}-[0-9]{2}-[0-9]{2})(-retry-([0-9]+))?(\\.partial)?\\.json$';
const MAX_PRODUCTS=5000;
const MAX_DAILY_PRODUCTS=200;

// One read-only statement selects the applicable source revisions, de-duplicates
// product/order rows and aggregates both comparison windows. No order row leaves
// PostgreSQL. Catalog enrichment is part of the same statement, so store count
// does not turn into N+1 reads.
const RADAR_SQL=`WITH RECURSIVE
 params AS (SELECT $1::date AS current_from,$2::date AS current_to,$3::date AS previous_from,$4::date AS previous_to,$5::text AS market,$6::text AS store_id,$7::text AS source_pattern,$8::integer AS product_limit,$9::integer AS daily_product_limit),
 heads0 AS MATERIALIZED (
  SELECT h.store_id,h.domain,h.metadata,h.source_metadata->>'sourcePath' AS source_path,
   regexp_match(h.source_metadata->>'sourcePath',(SELECT source_pattern FROM params)) AS match
  FROM pult_live.heads h
  WHERE h.domain='buyers' AND h.source_metadata->>'sourcePath' ~ (SELECT source_pattern FROM params)
 ), candidates AS MATERIALIZED (
  SELECT h.*,h.match[2]::date AS range_from,h.match[3]::date AS range_to,COALESCE(NULLIF(h.match[5],''),'0')::integer AS retry,
   h.match[6] IS NOT NULL AS partial,COALESCE(h.metadata->>'generatedAt','') AS generated_at
  FROM heads0 h,params p WHERE h.match[2]::date<=p.current_to AND h.match[3]::date>=p.previous_from
 ), selected AS MATERIALIZED (
 SELECT * FROM (SELECT c.*,row_number() OVER(PARTITION BY range_from,range_to ORDER BY retry DESC,source_path DESC) AS choice FROM candidates c WHERE NOT partial) ranked WHERE choice=1
  UNION ALL SELECT c.*,1 FROM candidates c WHERE partial
 ), product_base AS MATERIALIZED (
  SELECT f.value->>'market' AS market,f.value->>'storeId' AS store_id,f.value->>'scheme' AS scheme,
   f.value->>'orderId' AS order_id,f.value->>'productId' AS product_id,f.value->>'buyerType' AS buyer_type,
   f.value->'cancelled' AS cancelled,f.value->'units' AS units,f.value->'amountRub' AS amount_rub,
   f.value->>'orderedAt' AS ordered_at,COALESCE(f.value->>'updatedAt',s.generated_at) AS updated_at,
   s.source_path,f.source_order
  FROM selected s JOIN pult_live.facts f ON f.store_id=s.store_id AND f.domain=s.domain AND f.entity_type='productOrders',params p
  WHERE (p.market='all' OR f.value->>'market'=p.market) AND (p.store_id IS NULL OR f.value->>'storeId'=p.store_id)
   AND left(f.value->>'orderedAt',10) BETWEEN (p.previous_from-1)::text AND (p.current_to+1)::text
 ), product_candidates AS MATERIALIZED (
  SELECT DISTINCT ON (p.market,p.store_id,p.scheme,p.order_id,p.product_id) p.*
  FROM product_base p ORDER BY p.market,p.store_id,p.scheme,p.order_id,p.product_id,p.updated_at DESC,p.source_path DESC,p.source_order DESC
 ), valid_products AS MATERIALIZED (
  SELECT market,store_id,scheme,order_id,product_id,
   CASE WHEN buyer_type IN ('legal','individual') THEN buyer_type ELSE 'unknown' END AS buyer_type,
   CASE WHEN jsonb_typeof(cancelled)='boolean' THEN (cancelled#>>'{}')::boolean ELSE NULL END AS cancelled,
   (units#>>'{}')::numeric AS units,
   CASE WHEN jsonb_typeof(amount_rub)='number' AND (amount_rub#>>'{}')::numeric>=0 THEN round((amount_rub#>>'{}')::numeric,2) ELSE NULL END AS amount_rub,
   (ordered_at::timestamptz AT TIME ZONE 'Europe/Moscow')::date AS order_day
  FROM product_candidates
  WHERE market IN ('Ozon','WB') AND NULLIF(store_id,'') IS NOT NULL AND NULLIF(scheme,'') IS NOT NULL
   AND NULLIF(order_id,'') IS NOT NULL AND NULLIF(product_id,'') IS NOT NULL
   AND jsonb_typeof(units)='number' AND units#>>'{}' ~ '^[0-9]+(?:\\.0+)?$' AND (units#>>'{}')::numeric>0 AND (units#>>'{}')::numeric<=9007199254740991
   AND ordered_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
 ), scoped AS MATERIALIZED (
  SELECT v.*,CASE WHEN v.order_day BETWEEN p.current_from AND p.current_to THEN 'current' WHEN v.order_day BETWEEN p.previous_from AND p.previous_to THEN 'previous' END AS period
  FROM valid_products v,params p WHERE v.order_day BETWEEN p.previous_from AND p.current_to
 ), product_catalog AS MATERIALIZED (
  SELECT DISTINCT ON (f.store_id,identifier) f.store_id,identifier,
   COALESCE(NULLIF(f.value->>'sku',''),NULLIF(f.value->>'nmID',''),NULLIF(f.value->>'product_id',''),identifier) AS sku,
   COALESCE(NULLIF(f.value->>'name',''),NULLIF(f.value->>'title',''),NULLIF(f.value->>'product_name','')) AS name,
   COALESCE(NULLIF(f.value->>'description_category_id',''),NULLIF(f.value->>'category_id','')) AS category_id
  FROM pult_live.facts f
  CROSS JOIN LATERAL jsonb_array_elements_text(jsonb_strip_nulls(jsonb_build_array(f.value->'product_id',f.value->'sku',f.value->'nmID',f.value->'offer_id',f.value->'vendorCode'))) ids(identifier)
  WHERE f.domain='market' AND f.entity_type='products' AND ((SELECT store_id FROM params) IS NULL OR f.store_id=(SELECT store_id FROM params))
  ORDER BY f.store_id,identifier,f.source_order DESC
 ), category_nodes(store_id,value) AS (
  SELECT f.store_id,f.value FROM pult_live.facts f WHERE f.domain='market' AND f.entity_type='categoryTree' AND ((SELECT store_id FROM params) IS NULL OR f.store_id=(SELECT store_id FROM params))
  UNION ALL
  SELECT node.store_id,child.value FROM category_nodes node CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(node.value->'children')='array' THEN node.value->'children' ELSE '[]'::jsonb END) child(value)
 ), category_names AS MATERIALIZED (
  SELECT DISTINCT ON (store_id,category_id) store_id,category_id,category
  FROM (SELECT store_id,COALESCE(NULLIF(value->>'description_category_id',''),NULLIF(value->>'category_id',''),NULLIF(value->>'id','')) AS category_id,
   COALESCE(NULLIF(value->>'category_name',''),NULLIF(value->>'name','')) AS category FROM category_nodes) names
  WHERE category_id IS NOT NULL AND category IS NOT NULL ORDER BY store_id,category_id,category
 ), catalog AS MATERIALIZED (
  SELECT p.store_id,p.identifier,p.sku,p.name,c.category FROM product_catalog p LEFT JOIN category_names c ON c.store_id=p.store_id AND c.category_id=p.category_id
 ), daily AS MATERIALIZED (
  SELECT period,market,store_id,product_id,order_day,
   sum(units)::text AS gross_units,sum(units) FILTER(WHERE cancelled=false)::text AS not_cancelled_units,
   sum(units) FILTER(WHERE buyer_type='legal')::text AS legal_units,sum(units) FILTER(WHERE buyer_type='legal' AND cancelled=false)::text AS legal_not_cancelled_units,
   sum(units) FILTER(WHERE buyer_type='individual')::text AS individual_units,sum(units) FILTER(WHERE buyer_type='individual' AND cancelled=false)::text AS individual_not_cancelled_units,
   sum(units) FILTER(WHERE buyer_type='unknown')::text AS unknown_units,sum(units) FILTER(WHERE buyer_type='unknown' AND cancelled=false)::text AS unknown_not_cancelled_units,
   count(DISTINCT (scheme,order_id)) FILTER(WHERE cancelled=false)::text AS order_count,
   count(DISTINCT (scheme,order_id)) FILTER(WHERE buyer_type='legal' AND cancelled=false)::text AS legal_order_count,
   COALESCE(sum(units) FILTER(WHERE cancelled=true),0)::text AS cancelled_units,COALESCE(sum(units) FILTER(WHERE cancelled IS NULL),0)::text AS cancellation_unknown_units,
   CASE WHEN count(*) FILTER(WHERE amount_rub IS NULL)>0 THEN NULL ELSE COALESCE(sum(amount_rub),0)::text END AS amount_rub,
   CASE WHEN count(*) FILTER(WHERE cancelled=false AND amount_rub IS NULL)>0 THEN NULL ELSE COALESCE(sum(amount_rub) FILTER(WHERE cancelled=false),0)::text END AS not_cancelled_amount_rub,
   CASE WHEN count(*) FILTER(WHERE buyer_type='legal' AND amount_rub IS NULL)>0 THEN NULL ELSE COALESCE(sum(amount_rub) FILTER(WHERE buyer_type='legal'),0)::text END AS legal_amount_rub,
   CASE WHEN count(*) FILTER(WHERE buyer_type='individual' AND amount_rub IS NULL)>0 THEN NULL ELSE COALESCE(sum(amount_rub) FILTER(WHERE buyer_type='individual'),0)::text END AS individual_amount_rub,
   CASE WHEN count(*) FILTER(WHERE buyer_type='unknown' AND amount_rub IS NULL)>0 THEN NULL ELSE COALESCE(sum(amount_rub) FILTER(WHERE buyer_type='unknown'),0)::text END AS unknown_amount_rub,
   CASE WHEN count(*) FILTER(WHERE buyer_type='legal' AND cancelled=false AND amount_rub IS NULL)>0 THEN NULL ELSE COALESCE(sum(amount_rub) FILTER(WHERE buyer_type='legal' AND cancelled=false),0)::text END AS legal_not_cancelled_amount_rub,
   CASE WHEN count(*) FILTER(WHERE buyer_type='individual' AND cancelled=false AND amount_rub IS NULL)>0 THEN NULL ELSE COALESCE(sum(amount_rub) FILTER(WHERE buyer_type='individual' AND cancelled=false),0)::text END AS individual_not_cancelled_amount_rub,
   CASE WHEN count(*) FILTER(WHERE buyer_type='unknown' AND cancelled=false AND amount_rub IS NULL)>0 THEN NULL ELSE COALESCE(sum(amount_rub) FILTER(WHERE buyer_type='unknown' AND cancelled=false),0)::text END AS unknown_not_cancelled_amount_rub
  FROM scoped WHERE period IS NOT NULL GROUP BY period,market,store_id,product_id,order_day
 ), product_totals AS MATERIALIZED (
  SELECT period,market,store_id,product_id,sum(gross_units::numeric) AS gross_units FROM daily GROUP BY period,market,store_id,product_id
 ), ranked_products AS MATERIALIZED (
 SELECT market,store_id,product_id,sum(gross_units) AS gross_units,row_number() OVER(ORDER BY sum(gross_units) DESC,market,store_id,product_id) AS rank,count(*) OVER() AS product_count
  FROM product_totals GROUP BY market,store_id,product_id
 ), product_period AS MATERIALIZED (
  SELECT d.period,d.market,d.store_id,d.product_id,
   sum(d.gross_units::numeric)::text AS gross_units,sum(d.not_cancelled_units::numeric)::text AS not_cancelled_units,sum(d.legal_units::numeric)::text AS legal_units,
   sum(d.legal_not_cancelled_units::numeric)::text AS legal_not_cancelled_units,sum(d.individual_units::numeric)::text AS individual_units,sum(d.individual_not_cancelled_units::numeric)::text AS individual_not_cancelled_units,
   sum(d.unknown_units::numeric)::text AS unknown_units,sum(d.unknown_not_cancelled_units::numeric)::text AS unknown_not_cancelled_units,
   sum(d.order_count::numeric)::text AS order_count,sum(d.legal_order_count::numeric)::text AS legal_order_count,sum(d.cancelled_units::numeric)::text AS cancelled_units,sum(d.cancellation_unknown_units::numeric)::text AS cancellation_unknown_units,
   CASE WHEN count(*) FILTER(WHERE d.amount_rub IS NULL)>0 THEN NULL ELSE sum(d.amount_rub::numeric)::text END AS amount_rub,
   CASE WHEN count(*) FILTER(WHERE d.not_cancelled_amount_rub IS NULL)>0 THEN NULL ELSE sum(d.not_cancelled_amount_rub::numeric)::text END AS not_cancelled_amount_rub,
   CASE WHEN count(*) FILTER(WHERE d.legal_amount_rub IS NULL)>0 THEN NULL ELSE sum(d.legal_amount_rub::numeric)::text END AS legal_amount_rub,
   CASE WHEN count(*) FILTER(WHERE d.individual_amount_rub IS NULL)>0 THEN NULL ELSE sum(d.individual_amount_rub::numeric)::text END AS individual_amount_rub,
   CASE WHEN count(*) FILTER(WHERE d.unknown_amount_rub IS NULL)>0 THEN NULL ELSE sum(d.unknown_amount_rub::numeric)::text END AS unknown_amount_rub,
   CASE WHEN count(*) FILTER(WHERE d.legal_not_cancelled_amount_rub IS NULL)>0 THEN NULL ELSE sum(d.legal_not_cancelled_amount_rub::numeric)::text END AS legal_not_cancelled_amount_rub,
   CASE WHEN count(*) FILTER(WHERE d.individual_not_cancelled_amount_rub IS NULL)>0 THEN NULL ELSE sum(d.individual_not_cancelled_amount_rub::numeric)::text END AS individual_not_cancelled_amount_rub,
   CASE WHEN count(*) FILTER(WHERE d.unknown_not_cancelled_amount_rub IS NULL)>0 THEN NULL ELSE sum(d.unknown_not_cancelled_amount_rub::numeric)::text END AS unknown_not_cancelled_amount_rub,
   COALESCE(json_agg(json_build_object('date',d.order_day::text,'grossUnits',d.gross_units,'notCancelledUnits',d.not_cancelled_units,'legalUnits',d.legal_units,'legalNotCancelledUnits',d.legal_not_cancelled_units,'individualUnits',d.individual_units,'individualNotCancelledUnits',d.individual_not_cancelled_units,'unknownUnits',d.unknown_units,'unknownNotCancelledUnits',d.unknown_not_cancelled_units,'orderCount',d.order_count,'legalOrderCount',d.legal_order_count,'cancelledUnits',d.cancelled_units,'cancellationUnknownUnits',d.cancellation_unknown_units,'amountRub',d.amount_rub,'notCancelledAmountRub',d.not_cancelled_amount_rub,'legalAmountRub',d.legal_amount_rub,'individualAmountRub',d.individual_amount_rub,'unknownAmountRub',d.unknown_amount_rub,'legalNotCancelledAmountRub',d.legal_not_cancelled_amount_rub,'individualNotCancelledAmountRub',d.individual_not_cancelled_amount_rub,'unknownNotCancelledAmountRub',d.unknown_not_cancelled_amount_rub) ORDER BY d.order_day) FILTER(WHERE r.rank<=(SELECT daily_product_limit FROM params)),'[]'::json) AS daily
  FROM daily d JOIN ranked_products r USING(market,store_id,product_id) GROUP BY d.period,d.market,d.store_id,d.product_id
 ), product_rows AS (
  SELECT 'product'::text AS kind,json_build_object('market',r.market,'storeId',r.store_id,'productId',r.product_id,'sku',COALESCE(c.sku,r.product_id),'name',c.name,'category',c.category,
   'period',d.period,'grossUnits',d.gross_units,'notCancelledUnits',COALESCE(d.not_cancelled_units,'0'),'legalUnits',COALESCE(d.legal_units,'0'),
   'legalNotCancelledUnits',COALESCE(d.legal_not_cancelled_units,'0'),'individualUnits',COALESCE(d.individual_units,'0'),'individualNotCancelledUnits',COALESCE(d.individual_not_cancelled_units,'0'),'unknownUnits',COALESCE(d.unknown_units,'0'),'unknownNotCancelledUnits',COALESCE(d.unknown_not_cancelled_units,'0'),
   'orderCount',d.order_count,'legalOrderCount',d.legal_order_count,'cancelledUnits',d.cancelled_units,'cancellationUnknownUnits',d.cancellation_unknown_units,
   'amountRub',d.amount_rub,'notCancelledAmountRub',d.not_cancelled_amount_rub,'legalAmountRub',d.legal_amount_rub,'individualAmountRub',d.individual_amount_rub,'unknownAmountRub',d.unknown_amount_rub,
   'legalNotCancelledAmountRub',d.legal_not_cancelled_amount_rub,'individualNotCancelledAmountRub',d.individual_not_cancelled_amount_rub,'unknownNotCancelledAmountRub',d.unknown_not_cancelled_amount_rub,'daily',d.daily,'productCount',r.product_count) AS payload
  FROM ranked_products r JOIN product_period d USING(market,store_id,product_id) LEFT JOIN catalog c ON c.store_id=r.store_id AND c.identifier=r.product_id
  WHERE r.rank<=(SELECT product_limit FROM params)
 ), source_rows AS (
  SELECT 'source'::text AS kind,json_build_object('sourcePath',s.source_path,'partial',s.partial,'generatedAt',s.generated_at,'value',f.value) AS payload
  FROM selected s JOIN pult_live.facts f ON f.store_id=s.store_id AND f.domain=s.domain AND f.entity_type='report.coverage.sources',params p
  WHERE (p.market='all' OR f.value->>'market'=p.market) AND (p.store_id IS NULL OR f.value->>'storeId'=p.store_id)
 ), order_counts AS MATERIALIZED (
  SELECT period,order_day,
   count(DISTINCT (market,store_id,scheme,order_id)) FILTER(WHERE cancelled=false)::text AS order_count,
   count(DISTINCT (market,store_id,scheme,order_id)) FILTER(WHERE buyer_type='legal' AND cancelled=false)::text AS legal_order_count
  FROM scoped WHERE period IS NOT NULL GROUP BY GROUPING SETS ((period,order_day),(period))
 ), summary_daily AS MATERIALIZED (
  SELECT d.period,d.order_day,sum(d.gross_units::numeric)::text AS gross_units,sum(d.not_cancelled_units::numeric)::text AS not_cancelled_units,
   sum(d.legal_units::numeric)::text AS legal_units,sum(d.legal_not_cancelled_units::numeric)::text AS legal_not_cancelled_units,
   sum(d.individual_units::numeric)::text AS individual_units,sum(d.individual_not_cancelled_units::numeric)::text AS individual_not_cancelled_units,
   sum(d.unknown_units::numeric)::text AS unknown_units,sum(d.unknown_not_cancelled_units::numeric)::text AS unknown_not_cancelled_units,
   o.order_count,o.legal_order_count,sum(d.cancelled_units::numeric)::text AS cancelled_units,sum(d.cancellation_unknown_units::numeric)::text AS cancellation_unknown_units,
   CASE WHEN count(*) FILTER(WHERE d.amount_rub IS NULL)>0 THEN NULL ELSE COALESCE(sum(d.amount_rub::numeric),0)::text END AS amount_rub,
   CASE WHEN count(*) FILTER(WHERE d.not_cancelled_amount_rub IS NULL)>0 THEN NULL ELSE COALESCE(sum(d.not_cancelled_amount_rub::numeric),0)::text END AS not_cancelled_amount_rub,
   CASE WHEN count(*) FILTER(WHERE d.legal_not_cancelled_amount_rub IS NULL)>0 THEN NULL ELSE COALESCE(sum(d.legal_not_cancelled_amount_rub::numeric),0)::text END AS legal_not_cancelled_amount_rub,
   CASE WHEN count(*) FILTER(WHERE d.individual_not_cancelled_amount_rub IS NULL)>0 THEN NULL ELSE COALESCE(sum(d.individual_not_cancelled_amount_rub::numeric),0)::text END AS individual_not_cancelled_amount_rub
  FROM daily d JOIN order_counts o ON o.period=d.period AND o.order_day=d.order_day
  GROUP BY d.period,d.order_day,o.order_count,o.legal_order_count
 ), global_orders AS MATERIALIZED (
  SELECT period,order_count,legal_order_count FROM order_counts WHERE order_day IS NULL
 ), summary_rows AS (
  SELECT 'summary'::text AS kind,json_build_object('period',g.period,'orderCount',g.order_count,'legalOrderCount',g.legal_order_count,
   'daily',COALESCE(json_agg(json_build_object('date',d.order_day::text,'grossUnits',d.gross_units,'notCancelledUnits',d.not_cancelled_units,'legalUnits',d.legal_units,'legalNotCancelledUnits',d.legal_not_cancelled_units,'individualUnits',d.individual_units,'individualNotCancelledUnits',d.individual_not_cancelled_units,'unknownUnits',d.unknown_units,'unknownNotCancelledUnits',d.unknown_not_cancelled_units,'orderCount',d.order_count,'legalOrderCount',d.legal_order_count,'cancelledUnits',d.cancelled_units,'cancellationUnknownUnits',d.cancellation_unknown_units,'amountRub',d.amount_rub,'notCancelledAmountRub',d.not_cancelled_amount_rub,'legalNotCancelledAmountRub',d.legal_not_cancelled_amount_rub,'individualNotCancelledAmountRub',d.individual_not_cancelled_amount_rub) ORDER BY d.order_day) FILTER(WHERE d.order_day IS NOT NULL),'[]'::json)) AS payload
  FROM global_orders g LEFT JOIN summary_daily d USING(period) GROUP BY g.period,g.order_count,g.legal_order_count
 ), count_row AS (
  SELECT 'count'::text AS kind,json_build_object('productCount',COALESCE(max(product_count),0)) AS payload FROM ranked_products
 )
 SELECT kind,payload FROM product_rows UNION ALL SELECT kind,payload FROM source_rows UNION ALL SELECT kind,payload FROM summary_rows UNION ALL SELECT kind,payload FROM count_row`;

function numeric(value,name){
 if(value==null)return null;
 const number=Number(value);
 if(!Number.isSafeInteger(number)||number<0)throw Object.assign(Error(`Invalid SQL ${name}`),{code:'CORRUPT_SOURCE'});
 return number;
}
function money(value,name){
 if(value==null)return null;
 const number=Number(value);
 if(!Number.isFinite(number)||number<0)throw Object.assign(Error(`Invalid SQL ${name}`),{code:'CORRUPT_SOURCE'});
 return Math.round(number*100)/100;
}
function bucket(row){return {
 grossUnits:numeric(row.grossUnits,'grossUnits')??0,totalUnits:numeric(row.grossUnits,'grossUnits')??0,notCancelledUnits:numeric(row.notCancelledUnits,'notCancelledUnits')??0,
 legalUnits:numeric(row.legalUnits,'legalUnits')??0,legalNotCancelledUnits:numeric(row.legalNotCancelledUnits,'legalNotCancelledUnits')??0,individualUnits:numeric(row.individualUnits,'individualUnits')??0,individualNotCancelledUnits:numeric(row.individualNotCancelledUnits,'individualNotCancelledUnits')??0,unknownUnits:numeric(row.unknownUnits,'unknownUnits')??0,unknownNotCancelledUnits:numeric(row.unknownNotCancelledUnits,'unknownNotCancelledUnits')??0,
 orderCount:numeric(row.orderCount,'orderCount')??0,legalOrderCount:numeric(row.legalOrderCount,'legalOrderCount')??0,cancelledUnits:numeric(row.cancelledUnits,'cancelledUnits')??0,cancellationUnknownUnits:numeric(row.cancellationUnknownUnits,'cancellationUnknownUnits')??0,
 amountRub:money(row.amountRub,'amountRub'),notCancelledAmountRub:money(row.notCancelledAmountRub,'notCancelledAmountRub'),legalAmountRub:money(row.legalAmountRub,'legalAmountRub'),individualAmountRub:money(row.individualAmountRub,'individualAmountRub'),unknownAmountRub:money(row.unknownAmountRub,'unknownAmountRub'),legalNotCancelledAmountRub:money(row.legalNotCancelledAmountRub,'legalNotCancelledAmountRub'),individualNotCancelledAmountRub:money(row.individualNotCancelledAmountRub,'individualNotCancelledAmountRub'),unknownNotCancelledAmountRub:money(row.unknownNotCancelledAmountRub,'unknownNotCancelledAmountRub'),currency:row.amountRub==null?null:'RUB'
};}
function emptyBucket(){return {grossUnits:0,totalUnits:0,notCancelledUnits:0,legalUnits:0,legalNotCancelledUnits:0,individualUnits:0,individualNotCancelledUnits:0,unknownUnits:0,unknownNotCancelledUnits:0,orderCount:0,legalOrderCount:0,cancelledUnits:0,cancellationUnknownUnits:0,amountRub:0,notCancelledAmountRub:0,legalAmountRub:0,individualAmountRub:0,unknownAmountRub:0,legalNotCancelledAmountRub:0,individualNotCancelledAmountRub:0,unknownNotCancelledAmountRub:0,currency:'RUB',daily:[]};}

function shape(result,limit){
 const products=new Map(),sources=[],summary={current:{legalOrderCount:0},previous:{legalOrderCount:0}};let productCount=0;
 for(const item of result?.rows||[]){
  if(item.kind==='source'){sources.push(item.payload);continue;}
  if(item.kind==='summary'&&(item.payload?.period==='current'||item.payload?.period==='previous')){summary[item.payload.period]={orderCount:numeric(item.payload.orderCount,'orderCount')||0,legalOrderCount:numeric(item.payload.legalOrderCount,'legalOrderCount')||0,daily:(Array.isArray(item.payload.daily)?item.payload.daily:[]).map(day=>({date:day.date,...bucket(day)}))};continue;}
  if(item.kind==='count'){productCount=numeric(item.payload?.productCount,'productCount')||0;continue;}
  if(item.kind!=='product'||!item.payload)continue;
  const row=item.payload,key=[row.market,row.storeId,row.productId].join('\u001f');
  if(!products.has(key))products.set(key,{market:row.market,storeId:row.storeId,productId:row.productId,sku:String(row.sku??row.productId),name:typeof row.name==='string'?row.name:null,category:typeof row.category==='string'?row.category:null,metrics:{current:emptyBucket(),previous:emptyBucket()}});
  const period=row.period;if(period!=='current'&&period!=='previous')continue;const total=bucket(row);
  total.daily=(Array.isArray(row.daily)?row.daily:[]).map(day=>({date:day.date,...bucket(day)}));products.get(key).metrics[period]=total;
 }
 for(const product of products.values())for(const period of ['current','previous'])product.metrics[period].daily.sort((a,b)=>a.date.localeCompare(b.date));
 return {rows:[...products.values()],sources,summary,productCount};
}

const HEADS_REVISION_SQL="SELECT COALESCE(string_agg(domain || '/' || store_id || '/' || revision::text,'|' ORDER BY domain,store_id),'') AS revision_key FROM pult_live.heads WHERE domain IN ('buyers','market')";
const CACHE_ENTRIES=4;

function createPostgresB2BRadarRepository({pool,maxProducts=MAX_PRODUCTS}={}){
 if(!pool||typeof pool.query!=='function')throw new TypeError('PostgreSQL pool is required');
 if(!Number.isSafeInteger(maxProducts)||maxProducts<1||maxProducts>MAX_PRODUCTS)throw new TypeError('Invalid B2B radar product limit');
 const cache=new Map();
 async function read({currentPeriod,previousPeriod,market='all',storeId}={}){
  const revision=await pool.query(HEADS_REVISION_SQL);
  const key=JSON.stringify([revision.rows[0]?.revision_key,currentPeriod.from,currentPeriod.to,previousPeriod.from,previousPeriod.to,market,storeId||null,maxProducts]);
  const cached=cache.get(key);
  if(cached)return cached;
  const pending=(async()=>shape(await pool.query(RADAR_SQL,[currentPeriod.from,currentPeriod.to,previousPeriod.from,previousPeriod.to,market,storeId||null,SOURCE_PATTERN,maxProducts,MAX_DAILY_PRODUCTS]),maxProducts))();
  cache.set(key,pending);
  if(cache.size>CACHE_ENTRIES)cache.delete(cache.keys().next().value);
  try{return await pending;}catch(error){if(cache.get(key)===pending)cache.delete(key);throw error;}
 }
 return Object.freeze({read});
}

module.exports={createPostgresB2BRadarRepository,RADAR_SQL,HEADS_REVISION_SQL,SOURCE_PATTERN,MAX_PRODUCTS,MAX_DAILY_PRODUCTS,shape};
