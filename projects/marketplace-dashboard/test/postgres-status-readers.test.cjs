'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createStatusReaders}=require('../storage/postgres-status-readers.cjs');
const {sourceKey}=require('../storage/postgres-document-import.cjs');
const time='2026-09-22T10:00:00.000Z';
const job={kind:'market',storeId:'1',state:'done',count:1,timestamp:time,nextDueAt:time};
test('concurrent status readers share a query, detach results and never cache completion',async()=>{
 let calls=0,release;const pool={query:async()=>{calls++;if(calls===1)await new Promise(resolve=>{release=resolve});return{rows:[{deleted:false,valid:true,version:1,jobs:{'market:1':job}}]}}};
 const reader=createStatusReaders({pool}),first=reader.statusJobs(),second=reader.statusJobs();release();
 const [a,b]=await Promise.all([first,second]);assert.equal(calls,1);a['market:1'].count=8;assert.equal(b['market:1'].count,1);
 await reader.statusJobs();assert.equal(calls,2);
});
test('status and normalized market reads reject invalid evidence and preserve tombstones',async()=>{
 let row={deleted:false,valid:false,version:1,jobs:{'market:1':job}};const reader=createStatusReaders({pool:{query:async()=>({rows:[row]})}});
 await assert.rejects(reader.statusJobs(),{code:'SOURCE_INTEGRITY'});
 row={revision:'7',deleted:true};assert.deepEqual(await reader.marketDocument('1'),{revision:'7',value:null});
 row={revision:'8',deleted:false,media_type:'application/json',complete:true,matched:false,source_metadata:{completedAt:time}};
 await assert.rejects(reader.marketDocument('1'),{code:'SOURCE_INTEGRITY'});
 row.matched=true;assert.equal((await reader.marketDocument('1')).value.completedAt,time);
});
test('PostgreSQL projects validated scheduler metadata without its durable payload',{skip:!process.env.PULT_TEST_DATABASE_URL},async t=>{
 const url=process.env.PULT_TEST_DATABASE_URL;assert.match(decodeURIComponent(new URL(url).pathname.slice(1)),/^pult_test_/u);
 const {Pool}=require('pg'),pool=new Pool({connectionString:url}),schema='status_'+crypto.randomBytes(6).toString('hex');let made=false;
 t.after(async()=>{if(made)await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await pool.end()});
 await pool.query(require('../storage/postgres-schema.cjs').replaceAll('pult',schema));made=true;
 const bytes=Buffer.from(JSON.stringify({version:1,jobs:{'market:1':{...job,payload:{rows:'x'.repeat(1024*1024)}}}}));
 await pool.query(`INSERT INTO "${schema}".document_states(logical_key,revision,media_type,content,sha256,deleted) VALUES($1,1,'application/json',$2,$3,false)`,[sourceKey('runtime-schedules.json'),bytes,crypto.createHash('sha256').update(bytes).digest()]);
 const reader=createStatusReaders({pool,stateSchema:schema}),jobs=await reader.statusJobs();assert.deepEqual(jobs,{'market:1':job});assert.ok(Buffer.byteLength(JSON.stringify(jobs))<1024);
 await pool.query(`UPDATE "${schema}".document_states SET sha256=$1`,[Buffer.alloc(32)]);await assert.rejects(reader.statusJobs(),{code:'SOURCE_INTEGRITY'});
});
