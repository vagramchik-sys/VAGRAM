'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {analyze}=require('../sales-decline.cjs');
const current={from:'2026-09-09',to:'2026-09-15'},previous={from:'2026-09-02',to:'2026-09-08'},now=new Date('2026-09-16T12:00:00Z');
const day=(date,sku,realized,rest={})=>({date,sku,values:{realized,...rest}});
function store(id='a',skuDaily=[day('2026-09-08',10,10000),day('2026-09-15',10,5000)]){return {id,name:'Магазин '+id,ledger:{complete:true,foreignRecords:0,period:{from:'2026-09-01',to:'2026-09-16'},skuDaily},products:[{key:id+':1',sku:10,skus:[10,11],name:'Товар',offer_id:'offer',market:'Ozon',quantity:5}]}}
const run=(stores,options={})=>analyze(stores,current,previous,{now,...options});
test('uses the last seven complete Moscow days when selection includes today',()=>{
 const s=store();s.ledger.skuDaily.push(day('2026-09-16',10,900000));
 const result=analyze([s],{from:'2026-09-16',to:'2026-09-16'},{from:'2026-09-15',to:'2026-09-15'},{now:new Date('2026-09-15T21:30:00Z')});
 assert.deepEqual(result.current,current);assert.deepEqual(result.previous,previous);assert.equal(result.rows[0].current,50);assert.match(result.reason,/7 полных/);assert.match(result.notes.join(' '),/сегодняшний день исключён/);
});
test('prior-only products remain visible, declines use signed realization instead of net or units',()=>{
 const result=run([store('a',[day('2026-09-08',10,10000,{net:100,soldUnits:80})])]);
 assert.equal(result.status,'ready');assert.equal(result.rows[0].current,0);assert.equal(result.rows[0].previous,100);assert.equal(result.rows[0].drop,100);assert.equal(result.rows[0].dropPercent,100);assert.equal(result.rows[0].adsCurrent,null);
});
test('joins aliases once and isolates same SKU in different stores',()=>{
 const a=store('a',[day('2026-09-08',10,10000),day('2026-09-08',11,20000),day('2026-09-15',11,15000)]);
 const b=store('b',[day('2026-09-08',10,9000),day('2026-09-15',10,8000)]);
 const r=run([a,b]);assert.equal(r.rows.length,2);assert.equal(r.rows[0].previous,300);assert.equal(r.rows[0].current,150);assert.equal(r.rows[0].key,'a:1');assert.equal(r.rows[1].drop,10);assert.notEqual(r.rows[0].id,r.rows[1].id);
});
test('ambiguous SKU and missing cards retain history without assigning stock or advertising explanations',()=>{
 const s=store();s.products[0].quantity=0;s.products.push({...s.products[0],key:'a:2'});
 s.ledger.skuDaily[0].values.ads=-200;s.ledger.skuDaily[1].values.ads=-100;
 let row=run([s]).rows[0];assert.equal(row.key,null);assert.equal(row.quantity,null);assert.equal(row.name,'SKU 10');assert.ok(row.signals.some(s=>s.code==='catalog_ambiguous'));assert.ok(!row.signals.some(s=>['stock_zero','ads_down'].includes(s.code)));
 s.products=[];row=run([s]).rows[0];assert.ok(row.signals.some(s=>s.code==='catalog_missing'));
});
test('uncovered, failed, absent, foreign and undetailed ledgers are excluded instead of fabricated zero sales',()=>{
 for(const mutate of [s=>s.ledger.period.from='2026-09-09',s=>s.ledger.complete=false,s=>s.ledger=null,s=>s.ledger.foreignRecords=1,s=>delete s.ledger.skuDaily]){
  const bad=store('bad');mutate(bad);let r=run([bad]);assert.equal(r.status,'unavailable');assert.deepEqual(r.rows,[]);assert.equal(r.excludedStores.length,1);
  r=run([bad,store('good')]);assert.equal(r.status,'ready');assert.equal(r.rows.length,1);assert.equal(r.rows[0].storeId,'good');
 }
 assert.equal(run([]).status,'unavailable');
});
test('stock and returns are factual signals, with current stock explicitly distinct from historical availability',()=>{
 const s=store('a',[day('2026-09-08',10,10000,{reversal:1000}),day('2026-09-15',10,-5000,{reversal:16000})]);s.products[0].quantity=0;
 const row=run([s]).rows[0];assert.equal(row.drop,150);assert.equal(row.dropPercent,150);assert.equal(row.returnsCurrent,160);
 assert.match(row.signals.find(s=>s.code==='stock_zero').evidence,/прошлое отсутствие товара не подтверждено/);
 assert.match(row.signals.find(s=>s.code==='returns_up').evidence,/не доказывает падение спроса/);
 assert.ok(row.signals.some(s=>s.code==='unverified'));
});
test('lower advertising requires attributable records in both periods; missing records do not mean ads stopped',()=>{
 const s=store();s.ledger.skuDaily[0].values.ads=-10000;
 let row=run([s]).rows[0];assert.equal(row.adsCurrent,null);assert.ok(!row.signals.some(s=>s.code==='ads_down'));
 s.ledger.skuDaily[1].values.ads=-5000;row=run([s]).rows[0];assert.equal(row.adsPrevious,100);assert.equal(row.adsCurrent,50);assert.ok(row.signals.some(s=>s.code==='ads_down'));
});
test('only genuine declines with positive prior realization are ranked; complete empty periods are ready',()=>{
 const s=store('a',[day('2026-09-08',10,-10000),day('2026-09-15',10,-20000),day('2026-09-15',20,10000),day('2026-09-08',30,10000),day('2026-09-15',30,10000)]);
 assert.deepEqual(run([s]).rows,[]);assert.equal(run([store('empty',[])]).status,'ready');
});
test('inactive cards obey visibility filter and unknown stock remains unknown',()=>{
 const s=store();s.products[0].archived=true;assert.equal(run([s]).rows.length,0);assert.equal(run([s],{hideInactive:false}).rows.length,1);
 s.products[0].archived=false;s.products[0].quantity=null;const row=run([s]).rows[0];assert.equal(row.quantity,null);assert.ok(!row.signals.some(s=>s.code==='stock_zero'));
});
test('bad or overlapping ranges are rejected and future days never become a decline',()=>{
 assert.throws(()=>analyze([],{from:'2026-02-30',to:'2026-03-01'},previous,{now}));
 assert.throws(()=>analyze([],current,current,{now}));
 assert.equal(analyze([store()],{from:'2026-09-17',to:'2026-09-18'},previous,{now}).status,'unavailable');
});
