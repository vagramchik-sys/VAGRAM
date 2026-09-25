'use strict';

const crypto = require('node:crypto');
const {TextDecoder} = require('node:util');
const {encodeJson} = require('./postgres-json-repository.cjs');
const {decodeMetadata} = require('./postgres-live-codecs.cjs');

const STORE = /^(?:wb-)?[0-9]+$/u;
const SUMMARY_OPERATION_FIELDS = Object.freeze(['operation_type_name','operation_type','sellerOperName','docTypeName','currency','amount','date','rrDate','saleDt']);
const SUMMARY_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const OPERATION_SUMMARY_SQL = `WITH base AS (
  SELECT source_order,
    COALESCE(NULLIF(value->>'operation_type_name',''),NULLIF(value->>'operation_type',''),NULLIF(value->>'sellerOperName',''),NULLIF(value->>'docTypeName',''),'Прочее') AS name,
    COALESCE(NULLIF(value#>>'{total_amount,currency}',''),NULLIF(value->>'currency',''),'RUB') AS currency,
    CASE
      WHEN NOT value ? 'amount' OR value->'amount'='null'::jsonb OR value->'amount'='false'::jsonb OR jsonb_typeof(value->'amount')='string' AND btrim(value->>'amount')='' THEN 0::double precision
      WHEN value->'amount'='true'::jsonb THEN 100::double precision
      WHEN jsonb_typeof(value->'amount')='number' OR jsonb_typeof(value->'amount')='string' AND btrim(value->>'amount')~'^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$' THEN floor((value->>'amount')::double precision*100+0.5)
      ELSE NULL::double precision
    END AS cents,
    left(COALESCE(NULLIF(value->>'date',''),NULLIF(value->>'rrDate',''),NULLIF(value->>'saleDt',''),''),10) AS day
  FROM pult_live.facts WHERE store_id=$1 AND domain='market' AND entity_type='operations'
)
SELECT CASE WHEN GROUPING(name)=0 THEN 'group' WHEN GROUPING(day)=0 THEN 'day' ELSE 'total' END AS kind,
  name,day,currency,sum(cents) AS cents,count(*)::text AS records,min(source_order) AS first_order,bool_and(cents IS NOT NULL) AS safe
FROM base GROUP BY GROUPING SETS ((name,currency),(day,currency),())`;

class LiveMarketError extends Error {
  constructor(code, message) { super(message); this.name = 'LiveMarketError'; this.code = code; }
}
const fail = (code, message) => { throw new LiveMarketError(code, message); };
const clone = value => value == null ? value : structuredClone(value);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const store = value => STORE.test(String(value)) ? String(value) : fail('INVALID_ARGUMENT', 'Store id is invalid');
const pathFor = value => `data-${store(value)}.json`;

function snapshotId(storeId, revision) { return `live:${storeId}:${revision}`; }
function summaryOperation(row) {
  const value = {};
  for (const key of SUMMARY_OPERATION_FIELDS) if (Object.hasOwn(row, key)) value[key] = clone(row[key]);
  if (Object.hasOwn(row, 'total_amount')) {
    const total = row.total_amount;
    value.total_amount = total && typeof total === 'object' && !Array.isArray(total) ? (Object.hasOwn(total, 'currency') ? {currency: clone(total.currency)} : {}) : clone(total);
  }
  return value;
}
function validateSnapshot(storeId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SNAPSHOT', 'Market snapshot must be an object');
  const clients = storeId.startsWith('wb-') ? new Set([storeId, storeId.slice(3)]) : new Set([storeId]);
  if (!clients.has(String(value.clientId ?? '')) || (storeId.startsWith('wb-') ? value.market !== 'WB' : value.market === 'WB')) fail('STORE_MISMATCH', 'Market snapshot belongs to another store');
  for (const name of ['products','stocks','operations','stockRows','categoryTree']) if (value[name] !== undefined && !Array.isArray(value[name])) fail('INVALID_SNAPSHOT', 'Market collection has an invalid shape');
  for (const row of value.stocks || []) if (row?.stocks !== undefined && !Array.isArray(row.stocks)) fail('INVALID_SNAPSHOT', 'Nested stocks have an invalid shape');
  for (const row of value.operations || []) if (row?.posting?.products !== undefined && !Array.isArray(row.posting.products) || row?.item_fees?.fees !== undefined && !Array.isArray(row.item_fees.fees)) fail('INVALID_SNAPSHOT', 'Nested finance rows have an invalid shape');
  return true;
}
function parse(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('INVALID_ARGUMENT', 'exactBytes must be a Buffer');
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(bytes))); }
  catch { fail('INVALID_SNAPSHOT', 'Market snapshot is not valid UTF-8 JSON'); }
}

function createLiveMarketRepository({liveSources,pool=null} = {}) {
  if (!liveSources?.record || !liveSources?.repository?.listRows || !liveSources?.repository?.getHead) throw new TypeError('Live SQL sources are required');
  if(pool!==null&&typeof pool?.connect!=='function')throw new TypeError('pool must support connect');

  async function getSnapshot(storeId) { return clone((await liveSources.record(pathFor(storeId)))?.value ?? null); }
  async function getSummarySnapshot(storeId) {
    storeId = store(storeId);
    if(pool)return sqlSummary(storeId);
    const row = await liveSources.record(pathFor(storeId), {entities: ['products','stocks','operations']});
    if (!row) return null;
    const value = clone(row.value);
    if (Array.isArray(value.operations)) value.operations = value.operations.map(summaryOperation);
    return value;
  }
  async function sqlSummary(storeId){
    let client,open=false;
    try{
      client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');open=true;
      const head=(await client.query("SELECT revision,metadata,entity_counts FROM pult_live.heads WHERE store_id=$1 AND domain='market'",[storeId])).rows[0];
      if(!head){await client.query('COMMIT');open=false;return null}
      const value=decodeMetadata(pathFor(storeId),head.metadata),collections=await client.query("SELECT entity_type,value FROM pult_live.facts WHERE store_id=$1 AND domain='market' AND entity_type=ANY($2::text[]) ORDER BY source_order,entity_type,entity_key,occurrence",[storeId,['products','stocks']]);
      let operations=await client.query(OPERATION_SUMMARY_SQL,[storeId]),operationSummary=null;
      const total=operations.rows.find(row=>row.kind==='total'),operationCount=Number(total?.records);
      if(total?.safe===true&&Number.isSafeInteger(operationCount)&&operationCount>=0){
        const groups=operations.rows.filter(row=>row.kind==='group').sort((a,b)=>Number(a.first_order)-Number(b.first_order));
        const daily=operations.rows.filter(row=>row.kind==='day'&&SUMMARY_DAY.test(row.day)).sort((a,b)=>a.day.localeCompare(b.day)||Number(a.first_order)-Number(b.first_order));
        operationSummary={operationCount,operations:groups.map(row=>({operation_type_name:row.name,currency:row.currency,record_count:Number(row.records),amount:Number(row.cents)/100})),daily:daily.map(row=>({date:row.day,currency:row.currency,records:Number(row.records),amount:Number(row.cents)/100}))};
      }else{
        const operationFields=SUMMARY_OPERATION_FIELDS.map(key=>`CASE WHEN value ? '${key}' THEN jsonb_build_object('${key}',value->'${key}') ELSE '{}'::jsonb END`).join(' || ');
        operations=await client.query(`SELECT (${operationFields} || CASE WHEN NOT value ? 'total_amount' THEN '{}'::jsonb WHEN jsonb_typeof(value->'total_amount')='object' THEN jsonb_build_object('total_amount',CASE WHEN value->'total_amount' ? 'currency' THEN jsonb_build_object('currency',value->'total_amount'->'currency') ELSE '{}'::jsonb END) AS value FROM pult_live.facts WHERE store_id=$1 AND domain='market' AND entity_type='operations' ORDER BY source_order,entity_key,occurrence`,[storeId]);
      }
      const grouped={products:[],stocks:[]};for(const row of collections.rows)grouped[row.entity_type].push(row.value);
      for(const name of ['products','stocks']){const count=Number(head.entity_counts?.[name]??0);if(!Number.isSafeInteger(count)||count!==grouped[name].length)fail('DATA_INTEGRITY','Live market row count differs from its head');if(Object.hasOwn(value,name))value[name]=grouped[name]}
      const expectedOperations=Number(head.entity_counts?.operations??0),actualOperations=operationSummary?.operationCount??operations.rows.length;if(!Number.isSafeInteger(expectedOperations)||expectedOperations!==actualOperations)fail('DATA_INTEGRITY','Live finance row count differs from its head');if(Object.hasOwn(value,'operations')){if(operationSummary){delete value.operations;value.operationSummary=operationSummary}else value.operations=operations.rows.map(row=>row.value)}
      await client.query('COMMIT');open=false;return value;
    }catch(error){if(open)try{await client.query('ROLLBACK')}catch{}if(error instanceof LiveMarketError||error?.code==='INVALID_ENCODED'||error?.code==='METADATA_TOO_LARGE')throw error;fail('DATABASE_ERROR','Live market summary is unavailable')}finally{try{client?.release()}catch{}}
  }
  async function list(entityType, options = {}, matches = () => true) {
    const storeId = store(options.storeId), identity = {domain: 'market', storeId}, head = await liveSources.repository.getHead(identity);
    const limit = options.limit == null ? 100 : Number(options.limit), offset = options.offset == null ? 0 : Number(options.offset);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) fail('INVALID_ARGUMENT', 'Page is invalid');
    if (!head) return {rows: [], total: null, limit, offset, coverage: {complete: false, reason: 'NO_CURRENT_SNAPSHOT'}};
    const all = [];
    for (let page = 0;; page += 10000) {
      const result = await liveSources.repository.listRows({...identity, entityType, expectedRevision: head.revision, limit: 10000, offset: page});
      all.push(...result.rows.map(row => row.value));
      if (page + result.rows.length >= result.total) break;
    }
    const filtered = all.filter(matches), rows = filtered.slice(offset, offset + limit).map(clone), present = Object.hasOwn(head.entityCounts || {}, entityType);
    return {rows, total: filtered.length, limit, offset, coverage: {complete: true, sourceRows: all.length, present, matched: filtered.length}};
  }
  const same = (actual, wanted) => wanted == null || wanted === '' || String(actual ?? '') === String(wanted);
  const products = options => list('products', options, row => same(row?.product_id, options.productId) && same(row?.sku, options.sku) && same(row?.offer_id, options.offerId));
  const stocks = options => list('stocks', options, row => same(row?.product_id, options.productId) && same(row?.offer_id, options.offerId) && (options.sku == null || (row?.stocks || []).some(item => same(item?.sku, options.sku))) && (options.warehouse == null || (row?.stocks || []).some(item => same(item?.warehouse ?? item?.warehouse_ids?.[0], options.warehouse))));
  const operations = (options = {}) => {
    for (const name of ['from','to']) if (options[name] != null && !/^\d{4}-\d{2}-\d{2}$/u.test(options[name])) fail('INVALID_ARGUMENT', 'Operation period is invalid');
    if (options.from && options.to && options.from > options.to) fail('INVALID_ARGUMENT', 'Operation period is invalid');
    return list('operations', options, row => {
    const date = String(row?.date ?? row?.rrDate ?? '').slice(0, 10), id = row?.operation_id ?? row?.accrual_id ?? row?.rrdId, type = row?.operation_type ?? row?.sellerOperName ?? row?.docTypeName;
    const skus = [row?.nmId, ...(row?.posting?.products || []).map(item => item?.sku), ...(row?.item_fees?.fees || []).map(item => item?.sku)].filter(value => value != null).map(String);
    return same(id, options.operationId) && same(type, options.operationType) && (!options.from || date >= options.from) && (!options.to || date <= options.to) && (options.sku == null || skus.includes(String(options.sku)));
    });
  };
  return Object.freeze({getSnapshot, getSummarySnapshot, products, stocks, operations, async close() {}});
}

function createLiveMarketWriter({liveSources} = {}) {
  if (!liveSources?.document||typeof liveSources?.repository?.readCommand!=='function') throw new TypeError('Live SQL sources are required');
  const document = storeId => liveSources.document(pathFor(storeId), {validate: value => { validateSnapshot(storeId, value); return true; }});
  const result = (storeId, revision, replayed, sourceSha256, sha256 = sourceSha256) => ({revision: String(revision), replayed: replayed === true, snapshotId: snapshotId(storeId, revision), sha256, sourceSha256});
  async function publish({storeId, exactBytes, expectedRevision, commandId} = {}) {
    storeId = store(storeId); const copied = Buffer.from(exactBytes || []), value = parse(copied); validateSnapshot(storeId, value);
    let saved;try{saved=await document(storeId).compareAndSet(value,{expectedRevision,commandId});}catch(error){if(error?.code==='COMMAND_INTENT_CONFLICT')fail('COMMAND_ID_REUSED','Market command intent differs');throw error}
    const receipt=await liveSources.repository.readCommand({storeId,domain:'market',commandId}),sourceSha256=receipt?.afterHead?.sourceMetadata?.sourceSha256;
    if(!receipt||String(receipt.afterHead?.revision)!==String(saved.revision)||!/^[a-f0-9]{64}$/u.test(sourceSha256||''))fail('OUTCOME_UNKNOWN','Market publication outcome is unavailable');
    return result(storeId,saved.revision,saved.replayed,sourceSha256,hash(copied));
  }
  async function readCommand({storeId, commandId} = {}) {
    storeId = store(storeId); const receipt = await document(storeId).readCommand(commandId);
    if (!receipt) return null;
    const exactBytes = encodeJson(receipt.after.value, 480 * 1024 * 1024), revision = String(receipt.after.revision);
    return {...result(storeId, revision, true, receipt.after.sha256), beforeRevision: String(receipt.before.revision), exactBytes};
  }
  return Object.freeze({publish, readCommand});
}

module.exports = {createLiveMarketRepository, createLiveMarketWriter, LiveMarketError, SUMMARY_OPERATION_FIELDS, OPERATION_SUMMARY_SQL};
