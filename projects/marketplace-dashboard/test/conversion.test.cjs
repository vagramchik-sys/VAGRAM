'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create,choosePeriods,analyzeRows,analyzeOzon,metrics}=require('../conversion.cjs');
const TOKEN='fixture-only-not-a-real-token',WB='wb-1',accountId=42;
const totals=(visits=200,carts=40,orders=20)=>({transitions:visits,added_to_cart:carts,order_count:orders,added_to_cart_percent:visits>0?carts/visits*100:0,added_to_order_percent:carts>0?orders/carts*100:0});
const product=n=>({product_id:n,sku:n,name:'Товар '+n,offer_id:'offer-'+n});
const item=(n=10)=>({id:String(n+1000),articleId:n+1000,accountId,marketplaceId:0,nmId:String(n),vendorCode:'offer-'+n,name:'Товар '+n,totals:totals(100,15,5),prevTotals:totals()});
const article=n=>({id:n+1000,articleId:n+1000,accountId,nmId:n});
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'conversion-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const save=(name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value));save('truestats.json',{version:1,encryptedKey:'encrypted-fixture'});save('truestats-wb-link.json',{storeId:WB,accountId});
 const state={time:Date.parse('2026-09-18T12:00:00Z'),calls:[],range:{minDate:'2026-09-05',maxDate:'2026-09-18',isTodayIncluded:false},items:[item()],products:[product(10),product(20)],fail:false,calculating:false};
 const fetchImpl=async(url,request)=>{
  assert.equal(request.headers['X-Api-Token'],TOKEN);assert.equal(request.redirect,'error');const route=new URL(url).pathname,body=request.body?JSON.parse(request.body):null;state.calls.push({route,body});
  if(options.before)await options.before(route,state,save);
  if(state.fail)return new Response(JSON.stringify({secret:TOKEN,message:TOKEN}),{status:500});
  if(route==='/rnp-report/v2/filter-values')return new Response(JSON.stringify({accounts:[{id:accountId,name:'WB remote'}],articles:state.items.map(i=>article(Number(i.nmId))),dates:state.range}));
  assert.equal(route,'/rnp-report/v2/grouped');assert.deepEqual(body.filters,{accounts:[accountId]});
  const items=state.items.slice((body.page-1)*body.limit,body.page*body.limit),value={items,pagination:{page:body.page,limit:body.limit,total:state.items.length},isCalculationInProgress:state.calculating};
  if(options.changeResponse)options.changeResponse(value,body,state);
  return new Response(JSON.stringify(value));
 };
 const service=create({privateDir:dir,protect:async(value,decrypt)=>{assert.equal(decrypt,true);return TOKEN},stores:{[WB]:{name:'Local WB',market:'WB'},ozon:{name:'Local Ozon',market:'Ozon'}},getProducts:()=>state.products,fetchImpl,now:()=>state.time});
 return {service,state,save};
}
test('uses two full six-day windows inside short history, seven when available, and never today',()=>{
 const p=choosePeriods({minDate:'2026-09-05',maxDate:'2026-09-18'},'2026-09-18');assert.equal(p.days,6);assert.deepEqual(p.current,{from:'2026-09-12',to:'2026-09-17'});assert.deepEqual(p.previous,{from:'2026-09-06',to:'2026-09-11'});assert.equal(p.shortened,true);
 assert.equal(choosePeriods({minDate:'2026-09-04',maxDate:'2026-09-18'},'2026-09-18').days,7);
 assert.throws(()=>choosePeriods({minDate:'2026-09-07',maxDate:'2026-09-18'},'2026-09-18'),/12/);
 const lag=choosePeriods({minDate:'2026-08-01',maxDate:'2026-09-15'},'2026-09-18');assert.equal(lag.current.to,'2026-09-15');assert.equal(lag.endsBeforeYesterday,true);
 assert.throws(()=>choosePeriods({minDate:'2026-02-30',maxDate:'2026-09-18'},'2026-09-18'));
});
test('nulls and zero denominators remain unknown; counts must be nonnegative integers',()=>{
 assert.deepEqual(metrics({transitions:null,added_to_cart:0,order_count:null}),{visits:null,carts:0,orders:null,cartConversionPct:null,cartToOrderPct:null});
 const zero=metrics(totals(0,0,0));assert.equal(zero.orders,0);assert.equal(zero.cartConversionPct,null);assert.equal(zero.cartToOrderPct,null);
 for(const value of [-1,1.5,'10',Infinity])assert.throws(()=>metrics({transitions:value}),/количество/);
 assert.throws(()=>metrics({...totals(),added_to_cart_percent:5}),/не совпала/);
});
test('signals explain observed declines without claiming price or delivery causes',()=>{
 const report=analyzeRows([item()],{store:{id:WB,name:'WB'},accountId,articles:[article(10)],products:[product(10),product(20)]}),r=report.rows[0];
 assert.deepEqual(r.signals.map(s=>s.code),['traffic_down','cart_conversion_down','order_conversion_down']);assert.equal(r.drop,15);assert.equal(r.dropPercent,75);assert.equal(r.current.cartToOrderPct,5/15*100);assert.equal(r.lowSample,true);assert.match(r.hypothesisNote,/причина падения не доказана/);assert.deepEqual(report.coverage,{tracked:1,mapped:1,catalog:2,unmapped:0,declining:1,comparable:1});
});
test('foreign accounts, duplicate nmIds and conflicting local mappings fail closed',()=>{
 const params={store:{id:WB,name:'WB'},accountId,articles:[article(10)],products:[product(10)]};
 for(const mutate of [r=>r.accountId++,r=>r.marketplaceId=1,r=>r.vendorCode='another',r=>r.nmId='99']){const r=item();mutate(r);assert.throws(()=>analyzeRows([r],params));}
 assert.throws(()=>analyzeRows([item(),item()],params));assert.throws(()=>analyzeRows([item()],{...params,products:[product(10),product(10)]}));
});
test('mapped coverage excludes missing local products without inventing zero activity',()=>{
 const r=analyzeRows([item(10),item(20)],{store:{id:WB,name:'WB'},accountId,articles:[article(10),article(20)],products:[product(10)]});assert.equal(r.rows.length,1);assert.equal(r.coverage.unmapped,1);assert.equal(r.coverage.tracked,2);
 const noVisits=item();noVisits.totals.transitions=null;noVisits.totals.added_to_cart_percent=null;const row=analyzeRows([noVisits],{store:{id:WB,name:'WB'},accountId,articles:[article(10)],products:[product(10)]}).rows[0];assert.equal(row.current.cartConversionPct,null);assert.equal(row.comparisonComplete,false);assert.ok(!row.signals.some(s=>s.code==='traffic_down'||s.code==='cart_conversion_down'));
});
test('service scopes WB via pinned account, marks Ozon unavailable and caches/deduplicates for 30 minutes',async t=>{
 const {service,state}=fixture(t);const [a,b]=await Promise.all([service.read(),service.read()]);assert.equal(state.calls.length,2);assert.equal(a.status,'partial');assert.equal(a.stores.find(s=>s.market==='Ozon').code,'ozon_unavailable');assert.equal(b.rows.length,1);assert.equal(a.rows[0].current.orders,5);assert.equal(a.stores[0].days,6);assert.equal(a.stores[0].coverage.catalog,2);assert.ok(!JSON.stringify(a).includes(TOKEN));
 a.rows[0].name='mutated';const c=await service.read({market:'WB'});assert.notEqual(c.rows[0].name,'mutated');assert.equal(state.calls.length,2);assert.equal(c.stores[0].cached,true);
 state.time+=30*60*1000;await service.read({storeId:WB});assert.equal(state.calls.length,4);
 assert.equal((await service.read({market:'Ozon'})).status,'unavailable');assert.equal(state.calls.length,4);
 await assert.rejects(service.read({storeId:'missing'}));
});
test('paginates all rows and rejects a repeated or incomplete page',async t=>{
 const {service,state}=fixture(t);state.items=Array.from({length:101},(_,i)=>item(i+1));state.products=state.items.map(i=>product(Number(i.nmId)));const r=await service.read({market:'WB'});assert.equal(r.rows.length,101);assert.equal(state.calls.filter(c=>c.route.endsWith('/grouped')).length,2);
 const bad=fixture(t,{changeResponse(value,body,state){if(body.page===2)value.items=[state.items[0]];}});bad.state.items=state.items;bad.state.products=state.products;const b=await bad.service.read({market:'WB'});assert.equal(b.status,'unavailable');assert.equal(b.stores[0].code,'duplicate');assert.equal(b.rows.length,0);
 const short=fixture(t,{changeResponse(value){value.pagination.total=200;}});const s=await short.service.read({market:'WB'});assert.equal(s.stores[0].code,'pagination');
});
test('calculating and empty RNP results are unavailable rather than zero orders',async t=>{
 const f=fixture(t);f.state.calculating=true;const r=await f.service.read({market:'WB'});assert.equal(r.status,'unavailable');assert.equal(r.stores[0].code,'calculating');assert.equal(r.rows.length,0);
 const empty=fixture(t);empty.state.items=[];const e=await empty.service.read({market:'WB'});assert.equal(e.stores[0].code,'rnp_empty');assert.equal(e.rows.length,0);
});
test('upstream failure keeps dated verified snapshot stale and does not leak server error bodies',async t=>{
 const f=fixture(t),first=await f.service.read({market:'WB'});f.state.time+=30*60*1000;f.state.fail=true;const stale=await f.service.read({market:'WB'});assert.equal(stale.status,'stale');assert.equal(stale.rows.length,1);assert.equal(stale.stores[0].fetchedAt,first.stores[0].fetchedAt);assert.ok(!JSON.stringify(stale).includes(TOKEN));const calls=f.state.calls.length;await f.service.read({market:'WB'});assert.equal(f.state.calls.length,calls);
 f.state.time+=DAY;const nextDay=await f.service.read({market:'WB'});assert.equal(nextDay.status,'unavailable');assert.equal(nextDay.rows.length,0);
});
const DAY=86400000;
test('changed credentials invalidate cache; changed configuration during a request cannot publish old data',async t=>{
 const f=fixture(t);await f.service.read({market:'WB'});f.save('truestats.json',{version:1,encryptedKey:'replacement'});f.state.fail=true;const r=await f.service.read({market:'WB'});assert.equal(r.status,'unavailable');assert.equal(r.rows.length,0);assert.equal(f.state.calls.length,3);
 let changed=false;const racing=fixture(t,{before(route,state,save){if(route.endsWith('/grouped')&&!changed){changed=true;save('truestats-wb-link.json',{storeId:WB,accountId:99});}}});const race=await racing.service.read({market:'WB'});assert.equal(race.rows.length,0);assert.equal(race.stores[0].code,'changed');
});
test('insufficient history prevents grouped requests and partial metrics remain partial',async t=>{
 const f=fixture(t);f.state.range.minDate='2026-09-10';const r=await f.service.read({market:'WB'});assert.equal(r.stores[0].code,'history');assert.equal(f.state.calls.length,1);
 const partial=fixture(t);partial.state.items[0].totals.transitions=null;partial.state.items[0].totals.added_to_cart_percent=null;const p=await partial.service.read({market:'WB'});assert.equal(p.status,'partial');assert.equal(p.rows[0].current.cartConversionPct,null);
});
function ozonFixture(){return {snapshot:{version:1,complete:true,current:{from:'2026-09-11',to:'2026-09-17'},previous:{from:'2026-09-04',to:'2026-09-10'},updatedAt:'2026-09-18T10:00:00Z',currentRows:[{sku:'10',views:100,cartAdds:20,orderedUnits:10},{sku:'11',views:900,cartAdds:90,orderedUnits:20}],previousRows:[{sku:'10',views:200,cartAdds:80,orderedUnits:30},{sku:'11',views:1000,cartAdds:200,orderedUnits:100}]},options:{store:{id:'ozon',name:'Ozon'},day:'2026-09-18',status:'ready',products:[{key:'ozon:1',storeId:'ozon',product_id:1,sku:10,skus:[10,11],offer_id:'a',name:'Product'}]}};}
test('Ozon SKU aliases aggregate event numerators and denominators, never average percentages or orders/cart',()=>{
 const f=ozonFixture(),r=analyzeOzon(f.snapshot,f.options),row=r.rows[0];assert.equal(r.status,'ready');assert.equal(r.rows.length,1);assert.equal(row.current.visits,1000);assert.equal(row.current.carts,110);assert.equal(row.current.cartConversionPct,11);assert.equal(row.current.orders,30);assert.equal(row.current.cartToOrderPct,null);assert.equal(row.drop,100);assert.equal(row.market,'Ozon');assert.ok(row.signals.every(s=>s.code!=='order_conversion_down'));assert.equal(r.coverage.tracked,2);assert.equal(r.coverage.mapped,1);
});
test('Ozon alias collisions and explicit cross-store snapshots/rows/catalog fail closed',()=>{
 for(const change of [f=>f.options.products.push({...f.options.products[0],key:'ozon:2',product_id:2}),f=>f.options.products[0].storeId='another',f=>f.snapshot.storeId='another',f=>f.snapshot.currentRows[0].storeId='another',f=>f.snapshot.currentRows.push({...f.snapshot.currentRows[0]})]){const f=ozonFixture();change(f);assert.throws(()=>analyzeOzon(f.snapshot,f.options));}
});
test('Ozon only zero-fills a SKU missing from one complete window; unknown catalog stays unmapped',()=>{
 const f=ozonFixture();f.snapshot.currentRows=[];f.snapshot.previousRows.push({sku:'99',views:10,cartAdds:2,orderedUnits:1});const r=analyzeOzon(f.snapshot,f.options);assert.equal(r.rows.length,1);assert.equal(r.rows[0].current.orders,0);assert.equal(r.rows[0].current.cartConversionPct,null);assert.equal(r.coverage.unmapped,1);assert.equal(r.rows[0].previous.orders,130);
 const missing=ozonFixture();delete missing.snapshot.currentRows;assert.throws(()=>analyzeOzon(missing.snapshot,missing.options),/полностью/);const partial=ozonFixture();partial.snapshot.complete=false;assert.throws(()=>analyzeOzon(partial.snapshot,partial.options),/полностью/);
});
test('Ozon null or zero views cannot become 0% and old/errored snapshots are explicitly stale',()=>{
 const f=ozonFixture();f.snapshot.currentRows.forEach(r=>r.views=0);const zero=analyzeOzon(f.snapshot,f.options);assert.equal(zero.rows[0].current.cartConversionPct,null);
 f.snapshot.currentRows[0].views=null;const unknown=analyzeOzon(f.snapshot,f.options);assert.equal(unknown.rows[0].current.visits,null);assert.equal(unknown.rows[0].current.cartConversionPct,null);assert.equal(unknown.status,'partial');
 const old=ozonFixture();old.options.day='2026-09-19';assert.equal(analyzeOzon(old.snapshot,old.options).status,'stale');const error=ozonFixture();error.options.status='error';assert.equal(analyzeOzon(error.snapshot,error.options).status,'stale');
 const future=ozonFixture();future.options.day='2026-09-17';assert.throws(()=>analyzeOzon(future.snapshot,future.options),/завершёнными/);
});
test('Ozon callback reads the requested local store without private TrueStats calls',async()=>{
 const f=ozonFixture(),requested=[];const service=create({privateDir:'unused',protect:async()=>{throw Error('must not decrypt')},stores:{ozon:{name:'Ozon'},other:{name:'Other'}},getProducts:id=>{assert.equal(id,'ozon');return f.options.products},getOzonFunnel:id=>{requested.push(id);return {status:'ready',snapshot:f.snapshot}},fetchImpl:async()=>{throw Error('must not fetch')},now:()=>Date.parse('2026-09-18T12:00:00Z')});const r=await service.read({market:'Ozon',storeId:'ozon'});assert.deepEqual(requested,['ozon']);assert.equal(r.status,'ready');assert.equal(r.rows.length,1);assert.equal(r.rows[0].market,'Ozon');
});
