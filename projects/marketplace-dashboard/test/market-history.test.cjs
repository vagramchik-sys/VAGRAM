'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create}=require('../market-history.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'market-history-')),dbFile=path.join(dir,'history.sqlite'),history=create({dbFile,now:()=>Date.parse('2026-09-21T09:00:00Z')});t.after(()=>{history.close();fs.rmSync(dir,{recursive:true,force:true})});return history}
const insights=(actual,rows,extra={})=>({orders:{period:{from:'2026-09-18',to:'2026-09-20'},skuPeriod:{from:'2026-09-18',to:'2026-09-20'},skuDaily:rows,skuUpdatedAt:actual,skuDailyCoverage:true,...extra}});
const ingest=(h,file,hash,data,capturedAt='2026-09-21T09:00:00Z')=>h.ingest({sourceFile:file,contentHash:hash,data,capturedAt});

test('ingest is atomic, idempotent and does not expose source filenames in status',t=>{
 const h=fixture(t),data=insights('2026-09-21T08:00:00Z',[{date:'2026-09-18',sku:'A',units:2,revenue:100}]);
 assert.equal(ingest(h,'insights-1.json','hash-1',data).duplicate,false);assert.equal(ingest(h,'insights-1.json','hash-1',data).duplicate,true);assert.equal(h.status().ingestions,1);assert.equal(JSON.stringify(h.status()).includes('insights-1'),false);
 assert.throws(()=>ingest(h,'insights-1.json','bad',{orders:{period:{from:'bad',to:'bad'},skuDaily:[],skuUpdatedAt:'bad'}}));assert.equal(h.status().ingestions,1);
 assert.throws(()=>ingest(h,'ledger-1.json','bad-ledger',{data:{period:{from:'2026-09-18',to:'2026-09-18'},completedAt:'2026-09-19T08:00:00Z',complete:true,skuDaily:[{date:'2026-09-18',sku:'A',values:{soldUnits:null}}]}}),/soldUnits/);assert.equal(h.status().ingestions,1);
 assert.throws(()=>ingest(h,'insights-1.json','bad-number',insights('2026-09-21T08:00:00Z',[{date:'2026-09-18',sku:'A',units:1,revenue:null}])));assert.equal(h.status().ingestions,1);
});

test('source time chooses corrections, partial data cannot replace complete, and a complete empty snapshot clears the day',t=>{
 const h=fixture(t);ingest(h,'insights-1.json','newer-import-first',insights('2026-09-21T08:00:00Z',[{date:'2026-09-18',sku:'A',units:2,revenue:200}]));
 ingest(h,'insights-1.json','older-source-later',insights('2026-09-21T07:00:00Z',[{date:'2026-09-18',sku:'A',units:9,revenue:900}]));
 ingest(h,'insights-1.json','partial',insights('2026-09-22T08:00:00Z',[{date:'2026-09-18',sku:'A',units:8,revenue:800}],{skuDailyCoverage:false}));
 let report=h.report({from:'2026-09-18',to:'2026-09-18',metric:'revenue'});assert.equal(report.rows[0].totals.value,200);
 ingest(h,'insights-1.json','empty-correction',insights('2026-09-23T08:00:00Z',[]));report=h.report({from:'2026-09-18',to:'2026-09-18',metric:'revenue'});assert.equal(report.rows.length,0);assert.equal(report.coverage.confirmedStoreDays,1);
});

test('today Ozon observations are not closed merely because coverage exists',t=>{
 const h=fixture(t),data=insights('2026-09-20T18:00:00Z',[{date:'2026-09-20',sku:'A',units:2,revenue:100}],{todayDate:'2026-09-20'});delete data.orders.skuPeriod;ingest(h,'insights-1.json','today',data);
 const report=h.report({from:'2026-09-20',to:'2026-09-20',metric:'revenue'});assert.equal(report.rows.length,0);assert.equal(report.coverage.confirmedStoreDays,0);assert.equal(report.coverage.excludedPartialOrOpen,true);
});

test('default 60-day Ozon period confirms only todayDate and never invents historical SKU zero days',t=>{
 const h=fixture(t),data={orders:{period:{from:'2026-07-23',to:'2026-09-20'},todayDate:'2026-09-20',skuDaily:[{date:'2026-09-20',sku:'A',units:2,revenue:100}],skuUpdatedAt:'2026-09-21T08:00:00Z',skuDailyCoverage:true}};ingest(h,'insights-1.json','default-coverage',data);const all=h.report({from:'2026-07-23',to:'2026-09-20',metric:'revenue'});assert.equal(all.coverage.confirmedStoreDays,1);assert.equal(all.rows[0].totals.value,100);const old=h.report({from:'2026-07-23',to:'2026-09-19',metric:'revenue'});assert.equal(old.coverage.confirmedStoreDays,0);assert.equal(old.rows.length,0);
});

test('finance metrics stay independent and preserve unknown unit rows without treating net as gross',t=>{
 const h=fixture(t),data={stamp:'2026-09-21T08:00:00Z',data:{period:{from:'2026-09-18',to:'2026-09-18'},completedAt:'2026-09-21T08:00:00Z',complete:true,skuDaily:[{date:'2026-09-18',sku:'A',values:{soldUnits:3,returnedUnits:1,realized:500,net:320,ads:40,unknownUnitRows:2}}]}};ingest(h,'ledger-1.json','ledger',data);
 assert.equal(h.report({from:'2026-09-18',to:'2026-09-18',metric:'realized'}).rows[0].totals.value,5);const units=h.report({from:'2026-09-18',to:'2026-09-18',metric:'soldUnits'}).rows[0];assert.equal(units.totals.value,3);assert.equal(units.totals.unknownUnitRows,2);assert.equal(units.totals.unitsComplete,false);
});

test('WB keeps real event time and later complete active-order snapshot can clear cancellations',t=>{
 const h=fixture(t),first={day:'2026-09-18',fetchedAt:'2026-09-19T01:00:00Z',complete:true,orders:[{at:'2026-09-18T10:15:00Z',amount:150,nmId:77}]};ingest(h,'wb-orders-wb-2.json','wb-1',first);assert.equal(h.report({from:'2026-09-18',to:'2026-09-18',market:'WB',metric:'revenue'}).rows[0].totals.value,150);
 ingest(h,'wb-orders-wb-2.json','wb-empty',{...first,fetchedAt:'2026-09-19T02:00:00Z',orders:[]});const report=h.report({from:'2026-09-18',to:'2026-09-18',market:'WB',metric:'revenue'});assert.equal(report.rows.length,0);assert.equal(report.coverage.confirmedStoreDays,1);assert.equal(h.status().events,1);assert.throws(()=>ingest(h,'wb-orders-wb-2.json','bad-day',{...first,orders:[{at:'2026-09-17T10:00:00Z',amount:1,nmId:77}]}),/не совпадает/);
});

test('catalog names and aliases are isolated by store',t=>{
 const h=fixture(t);ingest(h,'order-category-catalog-1.json','cat-1',{products:[{sku:'A',offer_id:'SHARED',name:'Первый'}]});ingest(h,'order-category-catalog-2.json','cat-2',{products:[{sku:'A',offer_id:'SHARED',name:'Второй'}]});
 ingest(h,'insights-1.json','s1',insights('2026-09-21T08:00:00Z',[{date:'2026-09-18',sku:'SHARED',units:1,revenue:10}]));ingest(h,'insights-2.json','s2',insights('2026-09-21T08:00:00Z',[{date:'2026-09-18',sku:'SHARED',units:1,revenue:20}]));const rows=h.report({from:'2026-09-18',to:'2026-09-18',metric:'revenue'}).rows;assert.deepEqual(rows.map(row=>[row.storeId,row.name]).sort(),[['1','Первый'],['2','Второй']]);
});

test('WB catalog uses wb-prefixed store id and resolves names only inside that store',t=>{
 const h=fixture(t);ingest(h,'order-category-catalog-wb-2.json','wb-cat',{products:[{nmID:77,vendorCode:'WB-X',title:'Товар WB'}]});ingest(h,'wb-orders-wb-2.json','wb-row',{day:'2026-09-18',fetchedAt:'2026-09-19T01:00:00Z',complete:true,orders:[{at:'2026-09-18T10:15:00Z',amount:150,nmId:77}]});const row=h.report({from:'2026-09-18',to:'2026-09-18',market:'WB',storeId:'wb-2',metric:'revenue'}).rows[0];assert.equal(row.name,'Товар WB');assert.equal(row.storeId,'wb-2');
});

test('unbounded history retains year-old facts and weekday/weekend averages count full zero days',t=>{
 const h=fixture(t),old={orders:{period:{from:'2025-01-01',to:'2025-01-01'},skuPeriod:{from:'2025-01-01',to:'2025-01-01'},skuDaily:[{date:'2025-01-01',sku:'OLD',units:1,revenue:5}],skuUpdatedAt:'2025-01-02T08:00:00Z',skuDailyCoverage:true}};ingest(h,'insights-1.json','old',old,'2025-01-02T09:00:00Z');assert.equal(h.report({from:'2025-01-01',to:'2025-01-01',metric:'revenue'}).rows[0].totals.value,5);
 const data={orders:{period:{from:'2026-09-18',to:'2026-09-20'},skuPeriod:{from:'2026-09-18',to:'2026-09-20'},skuDaily:[{date:'2026-09-18',sku:'A',units:1,revenue:100},{date:'2026-09-19',sku:'A',units:1,revenue:60}],skuUpdatedAt:'2026-09-21T08:00:00Z',skuDailyCoverage:true}};ingest(h,'insights-1.json','week',data);const row=h.report({from:'2026-09-18',to:'2026-09-20',metric:'revenue',productId:'A'}).rows[0];assert.deepEqual(row.weekday,{days:1,value:100,averagePerDay:100});assert.deepEqual(row.weekend,{days:2,value:60,averagePerDay:30});assert.match(h.report({from:'2026-09-18',to:'2026-09-20',metric:'revenue'}).limitations.join(' '),/нол/);
});

test('report rejects invalid dates, unsupported metrics and overly broad reads while retention stays unbounded',t=>{
 const h=fixture(t);assert.throws(()=>h.report({from:'2026-02-30',to:'2026-03-01',metric:'revenue'}),/календар/);assert.throws(()=>h.report({from:'2026-01-01',to:'2026-01-02',metric:'net'}),/метрик/);assert.throws(()=>h.report({from:'2026-01-01',to:'2026-01-02',market:'Other',metric:'revenue'}),/площадк/);assert.doesNotThrow(()=>h.report({from:'2026-01-01',to:'2026-01-02',market:'all',metric:'revenue'}));assert.throws(()=>h.report({from:'2010-01-01',to:'2026-01-01',metric:'revenue'}),/3660/);assert.equal(h.status().retention,'unbounded');
});
