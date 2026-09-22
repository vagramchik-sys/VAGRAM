'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createStockHistoryWriter,prepare,validateEnvelope}=require('../storage/postgres-stock-history-writer.cjs');
const {createStateStore}=require('../storage/postgres-state.cjs');
const {postgresStockInventory,legacyStockInventory,compareStockInventories}=require('../storage/postgres-stock-history-parity.cjs');
const {ingest:legacyIngest}=require('../stock-history.cjs');
const C1='11111111-1111-4111-8111-111111111111',C2='22222222-2222-4222-8222-222222222222',C3='33333333-3333-4333-8333-333333333333',C4='44444444-4444-4444-8444-444444444444',IM='a'.repeat(64),AT='2026-09-22T12:00:00.000Z';
const row=(more={})=>({day:'2026-09-07',observedAt:'2026-09-07T07:44:15.694Z',source:'daily-total',storeId:'11',storeName:'Synthetic',sku:'00123',article:'=TEST',name:'Item',warehouse:null,warehouseId:null,cluster:null,totalStock:20,available:null,inTransit:0,reserved:null,quality:'fixture',details:{z:1,a:'x'},sourceFile:'fixture.json',sourceRow:0,...more});
const input=(more={})=>({schemaVersion:1,kind:'stock-history.ingest',commandId:C1,expectedRevision:'0',importId:IM,importedAt:AT,manifest:[{file:'fixture.json',sha256:'b'.repeat(64),bytes:12}],issues:[],rows:[row()],...more});

test('writer copies and authenticates a versioned legacy-compatible envelope before SQL',async()=>{
 let captured;const stateStore={async writeWithEffect(key,envelope,options,effect){captured={key,envelope:Buffer.from(envelope),options};await Promise.resolve();return effect({query:async()=>({rows:[]})})}};
 const writer=createStockHistoryWriter({stateStore}),command=input();const pending=writer.ingest(command);command.rows[0].sku='changed';
 await assert.rejects(pending); // The fake SQL client intentionally cannot emulate RETURNING/state comparison.
 const value=JSON.parse(captured.envelope);assert.equal(value.rows[0].sku,'00123');assert.match(value.rows[0].id,/^[a-f0-9]{64}$/);assert.equal(captured.key,`history/stock-import/${IM}`);assert.equal(value.kind,'stock-history.ingest');
 const corrupt=structuredClone(value);corrupt.rows[0].id='f'.repeat(64);assert.throws(()=>validateEnvelope(corrupt),error=>error.code==='INVALID_COMMAND');
 for(const bad of [input({schemaVersion:2}),input({kind:'unknown'}),input({rows:[row({totalStock:-1})]})])await assert.rejects(writer.ingest(bad));
 assert.throws(()=>prepare(input({rows:[row({details:{bad:undefined}})]})),error=>error.code==='INVALID_COMMAND');
});

const url=process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: stock import, origins, state and command are atomic and match legacy SQLite',{skip:!url,timeout:30000},async()=>{
 assert.match(decodeURIComponent(new URL(url).pathname.slice(1)),/^pult_test_[a-f0-9]+$/u);const {Pool}=require('pg'),pool=new Pool({connectionString:url,max:4}),temp=fs.mkdtempSync(path.join(os.tmpdir(),'pult-stock-writer-')),dbFile=path.join(temp,'stocks.sqlite');let owned=false;
 try{assert.equal((await pool.query("SELECT count(*)::int n FROM pg_namespace WHERE nspname IN ('pult','pult_history')")).rows[0].n,0);owned=true;await pool.query(require('../storage/postgres-schema.cjs'));await pool.query(require('../storage/postgres-history-schema.cjs'));
  const state=createStateStore({pool}),writer=createStockHistoryWriter({stateStore:state}),firstInput=input({rows:[row(),row({sourceRow:1,sku:'00999',totalStock:0,details:{source:'second'}})]}),legacyRows=firstInput.rows.map(x=>({...x,details:JSON.parse(JSON.stringify(x.details))}));
  legacyIngest({dbFile,importId:IM,manifest:firstInput.manifest,issues:firstInput.issues,rows:legacyRows,now:AT});const first=await writer.ingest(firstInput);assert.equal(first.replayed,false);assert.deepEqual(first.result,{duplicate:false,inserted:2,provided:2,issues:0});
  assert.deepEqual(await writer.ingest(firstInput),{...first,replayed:true});{const pg=await postgresStockInventory(pool),sq=legacyStockInventory({dbFile});assert.deepEqual(pg.imports,sq.imports);compareStockInventories(pg,sq)}
  const duplicate=await writer.ingest({...firstInput,commandId:C4,expectedRevision:'1'});assert.deepEqual(duplicate.result,{duplicate:true,inserted:0});
  await assert.rejects(writer.ingest({...firstInput,commandId:crypto.randomUUID(),expectedRevision:'2',rows:[row({sku:'changed'})]}),{code:'DATABASE_ERROR'});
  const secondImport='c'.repeat(64),secondInput=input({commandId:C2,importId:secondImport,rows:[row({sourceFile:'other.json',sourceRow:5})]});legacyIngest({dbFile,importId:secondImport,manifest:secondInput.manifest,issues:[],rows:secondInput.rows,now:AT});const second=await writer.ingest(secondInput);assert.deepEqual(second.result,{duplicate:false,inserted:0,provided:1,issues:0});compareStockInventories(await postgresStockInventory(pool),legacyStockInventory({dbFile}));
  const before=(await pool.query(`SELECT (SELECT count(*)::int FROM pult_history.stock_imports) imports,(SELECT count(*)::int FROM pult_history.stock_origins) origins,(SELECT count(*)::int FROM pult.commands) commands`)).rows[0];await pool.query(`CREATE FUNCTION pult.reject_stock_command() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic';END$$;CREATE TRIGGER reject_stock_command BEFORE INSERT ON pult.commands FOR EACH ROW EXECUTE FUNCTION pult.reject_stock_command()`);
  const failed=input({commandId:C3,importId:'d'.repeat(64),rows:[row({sku:'fail'})]});await assert.rejects(writer.ingest(failed),{code:'DATABASE_ERROR'});assert.deepEqual((await pool.query(`SELECT (SELECT count(*)::int FROM pult_history.stock_imports) imports,(SELECT count(*)::int FROM pult_history.stock_origins) origins,(SELECT count(*)::int FROM pult.commands) commands`)).rows[0],before);await pool.query('DROP TRIGGER reject_stock_command ON pult.commands;DROP FUNCTION pult.reject_stock_command()');assert.equal((await writer.ingest(failed)).revision,'1');
 }finally{if(owned)await pool.query('DROP SCHEMA IF EXISTS pult_history,pult CASCADE').catch(()=>{});await pool.end();fs.rmSync(temp,{recursive:true,force:true})}
});
