'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const model=require('../dist/data-updates-model.js');

test('status model distinguishes work, waiting, delay, safe error and confirmed readiness',()=>{
 const now=Date.parse('2026-09-23T12:00:00Z');
 assert.equal(model.state({status:'running'},now).key,'running');
 assert.equal(model.state({status:'queued'},now).key,'waiting');
 assert.equal(model.state({status:'done',lastSuccessAt:'2026-09-23T11:00:00Z',nextDueAt:'2026-09-23T11:30:00Z'},now).key,'delayed');
 assert.equal(model.state({status:'done',lastSuccessAt:'2026-09-23T11:50:00Z',nextDueAt:'2026-09-23T12:20:00Z'},now).key,'ready');
 assert.equal(model.state({status:'done',errorCodes:['DATABASE_ERROR']},now).key,'error');
 assert.equal(model.state({status:'idle',nextDueKind:'manual',lastSuccessAt:'2026-09-23T11:50:00Z'},now).label,'По запросу');
 assert.equal(model.state({status:'idle'},now).label,'Ожидает данные');
});

test('rows sort actionable states first and preserve missing timestamps',()=>{const rows=model.rows({jobs:[{kind:'market',storeName:'Б',status:'done',lastSuccessAt:'2026-09-23T11:00:00Z',nextDueAt:'2026-09-23T13:00:00Z'},{kind:'wb-orders',storeName:'А',status:'error',lastSuccessAt:null,nextDueAt:null}]},Date.parse('2026-09-23T12:00:00Z'));assert.equal(rows[0].kind,'wb-orders');assert.equal(rows[0].lastSuccessAt,null);assert.equal(rows[1].title,'Данные магазина')});

test('polling is visible-only and never overlaps an active status request',async()=>{
 const source=fs.readFileSync(require.resolve('../dist/data-updates.js'),'utf8'),nodes=new Map(),listeners={},intervals=[];for(const id of ['data-update-summary','data-update-rows','data-update-checked','data-update-state','data-update-refresh'])nodes.set(id,{innerHTML:'',textContent:'',className:'',disabled:false,onclick:null});
 let resolveFetch,calls=0,hidden=false;const context={window:{PultDataUpdatesModel:model},document:{get hidden(){return hidden},getElementById:id=>nodes.get(id),addEventListener:(name,fn)=>{listeners[name]=fn},removeEventListener(){}},fetch(){calls++;return new Promise(resolve=>{resolveFetch=resolve})},setInterval(fn){intervals.push(fn);return intervals.length},clearInterval(){},setTimeout(){return 1},clearTimeout(){},AbortController,Intl,Date,console};vm.runInNewContext(source,context,{filename:'data-updates.js'});assert.equal(calls,1);intervals[0]();assert.equal(calls,1);
 resolveFetch({ok:true,async json(){return{checkedAt:'2026-09-23T12:00:00Z',jobs:[]}}});await new Promise(resolve=>setImmediate(resolve));intervals[0]();assert.equal(calls,2);hidden=true;resolveFetch({ok:true,async json(){return{checkedAt:'2026-09-23T12:00:30Z',jobs:[]}}});await new Promise(resolve=>setImmediate(resolve));intervals[0]();assert.equal(calls,2);context.window.PultDataUpdates.destroy();
});
