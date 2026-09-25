'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {OPTIMIZER_REQUIRED_COLUMNS,optimizerSchemaReadiness,optimizerRuntimeReadiness}=require('../storage/postgres-optimizer-schema.cjs');
const {apply,REQUIRED}=require('../scripts/migrate-price-ads-optimizer.cjs');

const columnRows=()=>Object.entries(OPTIMIZER_REQUIRED_COLUMNS).flatMap(([table,columns])=>columns.map(column=>({table_name:table,column_name:column})));

test('optimizer schema readiness requires every runtime column',async()=>{
 assert.deepEqual(OPTIMIZER_REQUIRED_COLUMNS.statistics_coverage,['store_id','stat_date','status','error_code','observed_at','source_revision']);
 const ready=await optimizerSchemaReadiness({query:async()=>({rows:columnRows()})});
 assert.deepEqual(ready,{ready:true,code:null,missing:[]});
 const rows=columnRows().filter(row=>!(row.table_name==='settings'&&row.column_name==='revision'));
 const missing=await optimizerSchemaReadiness({query:async()=>({rows})});
 assert.equal(missing.ready,false);assert.equal(missing.code,'OPTIMIZER_SCHEMA_MISSING');assert.deepEqual(missing.missing,['settings.revision']);
});

test('optimizer runtime readiness checks required grants and immutable commands',async()=>{
 const queries=[];const queryable={async query(sql){queries.push(sql);return sql.includes('information_schema.columns')?{rows:columnRows()}:{rows:[{schema_usage:true,settings_write:true,commands_append:true,commands_rewrite:false}]}}};
 assert.equal((await optimizerRuntimeReadiness(queryable)).ready,true);assert.equal(queries.length,2);
 queryable.query=async sql=>sql.includes('information_schema.columns')?{rows:columnRows()}:{rows:[{schema_usage:true,settings_write:true,commands_append:true,commands_rewrite:true}]};
 assert.deepEqual(await optimizerRuntimeReadiness(queryable),{ready:false,code:'OPTIMIZER_PRIVILEGES_INVALID',missing:[]});
});

function migrationFixture({missing=false,privileges=true}={}){
 const calls=[];let released=false;
 const client={async query(sql){calls.push(sql);if(sql.includes('information_schema.columns'))return{rows:missing?columnRows().slice(1):columnRows()};if(sql.includes('has_schema_privilege'))return{rows:[{schema_usage:privileges,settings_write:privileges,commands_append:privileges,commands_rewrite:false,excessive_runtime:false}]};return{rows:[]}},release(){released=true}};
 return{pool:{connect:async()=>client},calls,released:()=>released};
}

test('optimizer migration validates columns and least-privilege runtime access before commit',async()=>{
 const fixture=migrationFixture(),result=await apply(fixture.pool);
 assert.deepEqual(result,{schema:'pult_optimizer',tables:REQUIRED.length,runtimeAccess:'bounded DML; immutable commands'});
 assert.ok(fixture.calls.some(sql=>sql.includes('REVOKE DELETE ON pult_optimizer.credentials')));
 assert.ok(fixture.calls.some(sql=>sql.includes('has_schema_privilege')));
 assert.equal(fixture.calls.at(-1),'COMMIT');assert.equal(fixture.released(),true);
});

test('optimizer migration rolls back an incompatible pre-existing schema',async()=>{
 const fixture=migrationFixture({missing:true});
 await assert.rejects(apply(fixture.pool),/OPTIMIZER_SCHEMA_INCOMPLETE/u);
 assert.equal(fixture.calls.at(-1),'ROLLBACK');assert.equal(fixture.released(),true);
});

test('optimizer migration rolls back invalid runtime grants',async()=>{
 const fixture=migrationFixture({privileges:false});
 await assert.rejects(apply(fixture.pool),/OPTIMIZER_PRIVILEGES_INVALID/u);
 assert.equal(fixture.calls.at(-1),'ROLLBACK');assert.equal(fixture.released(),true);
});
