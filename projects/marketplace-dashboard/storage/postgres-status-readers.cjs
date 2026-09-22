'use strict';
const {sourceKey}=require('./postgres-document-import.cjs');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const identifier=value=>{if(!/^[a-z][a-z0-9_]{0,62}$/u.test(value||''))throw new TypeError('Invalid SQL schema');return '"'+value+'"'};
const fail=()=>{throw Object.assign(Error('SQL status evidence is invalid'),{code:'SOURCE_INTEGRITY'})};
function createStatusReaders({pool,stateSchema='pult',marketSchema='pult_market'}={}){
 if(typeof pool?.query!=='function')throw new TypeError('PostgreSQL pool is required');
 const state=identifier(stateSchema),market=identifier(marketSchema);
 let pendingJobs=null;
 async function statusJobs(){
  // Coalesce only concurrent requests. Never retain a completed status as a cache.
  if(!pendingJobs){const promise=pool.query(`WITH source AS MATERIALIZED (
    SELECT deleted,media_type='application/json' AND sha256(content)=sha256 AS valid,
      CASE WHEN NOT deleted AND media_type='application/json' AND sha256(content)=sha256 THEN convert_from(content,'UTF8')::jsonb END AS value
    FROM ${state}.document_states WHERE logical_key=$1)
    SELECT deleted,valid,value->'version' AS version,
      CASE WHEN jsonb_typeof(value->'jobs')='object' THEN (SELECT COALESCE(jsonb_object_agg(key,value-'payload'),'{}'::jsonb) FROM jsonb_each(source.value->'jobs')) END AS jobs
    FROM source`,[sourceKey('runtime-schedules.json')]);
   pendingJobs=promise;promise.finally(()=>{if(pendingJobs===promise)pendingJobs=null}).catch(()=>{});
  }
  const rows=(await pendingJobs).rows;if(!rows.length||rows[0].deleted)return{};
  const row=rows[0];if(rows.length!==1||row.valid!==true||row.version!==1||!object(row.jobs))fail();
  for(const [key,job]of Object.entries(row.jobs))if(!object(job)||key!==`${job.kind}:${job.storeId}`||!['queued','running','partial','done','error','unknown'].includes(job.state)||!Number.isFinite(Date.parse(job.timestamp))||!Number.isFinite(Date.parse(job.nextDueAt))||!Number.isSafeInteger(job.count)||job.count<0||Object.hasOwn(job,'payload'))fail();
  return structuredClone(row.jobs);
 }
 async function marketDocument(storeId){
  if(!/^(?:wb-)?[0-9]+$/u.test(storeId||''))throw new TypeError('Invalid store');
  const rows=(await pool.query(`SELECT d.revision::text,d.deleted,d.media_type,
    v.source_metadata,v.complete,d.sha256=v.source_sha256 AS matched
    FROM ${state}.document_states d
    LEFT JOIN ${market}.current_snapshots c ON c.store_id=$1
    LEFT JOIN ${market}.snapshot_versions v ON v.snapshot_id=c.snapshot_id AND v.store_id=c.store_id
    WHERE d.logical_key=$2`,[storeId,sourceKey(`data-${storeId}.json`)])).rows;
  if(!rows.length)return{revision:'0',value:null};const row=rows[0];
  if(rows.length!==1||!/^\d+$/u.test(row.revision||''))fail();
  if(row.deleted)return{revision:row.revision,value:null};
  if(row.media_type!=='application/json'||row.complete!==true||row.matched!==true||!object(row.source_metadata))fail();
  return{revision:row.revision,value:structuredClone(row.source_metadata)};
 }
 return Object.freeze({statusJobs,marketDocument});
}
module.exports={createStatusReaders};
