'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const service=require('../market-history-service.cjs');
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('history worker scans sources, reports unbounded facts and survives a malformed source',async t=>{
 const privateDir=fs.mkdtempSync(path.join(os.tmpdir(),'market-history-service-'));
 fs.writeFileSync(path.join(privateDir,'order-category-catalog-1.json'),JSON.stringify({products:[{sku:'A',name:'Тестовый товар'}]}));
 fs.writeFileSync(path.join(privateDir,'insights-1.json'),JSON.stringify({orders:{period:{from:'2026-09-18',to:'2026-09-18'},todayDate:'2026-09-18',skuDaily:[{date:'2026-09-18',sku:'A',units:2,revenue:100}],skuUpdatedAt:'2026-09-19T08:00:00Z',skuDailyCoverage:true}}));
 fs.writeFileSync(path.join(privateDir,'insights-2.json'),'{malformed');
 const client=service.create({privateDir});t.after(async()=>{await client.close();fs.rmSync(privateDir,{recursive:true,force:true})});
 let status;for(let i=0;i<100;i++){status=await client.status();if(status.archive.sources>=3&&status.archive.pendingFacts>=1)break;await tick(20)}
 assert.equal(status.facts.retention,'unbounded');assert.equal(status.facts.ingestions,2);assert.ok(status.archive.sources>=3);assert.ok(status.archive.lastError);assert.equal('dbFile' in status.facts,false);assert.equal('path' in status.facts,false);
 const report=await client.report({from:'2026-09-18',to:'2026-09-18',market:'Ozon',metric:'revenue'});assert.equal(report.rows.length,1);assert.equal(report.rows[0].name,'Тестовый товар');assert.equal(report.rows[0].totals.value,100);
 const alive=await client.status();assert.equal(alive.facts.ingestions,2);assert.ok(alive.archive.pendingFacts>=1);
});
