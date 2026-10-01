'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const {Readable} = require('node:stream');
const {createGrowthCenter, createGrowthRoutes, normalizeObservation, parseOptions} = require('../storage/domains/postgres-growth.cjs');
const NOW = Date.parse('2026-10-01T09:00:00Z');
const observation = () => ({observedAt:'2026-10-01T08:00:00Z', comparable:true, region:'Москва', query:'саморезы', ownBuyerPrice:1000, ownUnitCount:100, ownPosition:12, competitors:[{name:'Аналог',url:'https://www.ozon.ru/product/samorezy-123456/?from=test',buyerPrice:900,unitCount:100,position:5}]});
function fixture(overrides = {}) {
  const rows = new Map(), commands = new Map(); let writes = 0;
  const stateStore = {
    async read(key) { return rows.get(key) || null; }, async remove() { throw Error('Unexpected remove'); },
    async readCommand(key,id) { return commands.get(key+':'+id) || null; },
    async write(key,content,op) {
      const before=rows.get(key)||{revision:'0',deleted:null,mediaType:null,content:null,sha256:null};
      if(before.revision!==op.expectedRevision)throw Object.assign(Error('conflict'),{code:'REVISION_CONFLICT'});
      const after={revision:String(BigInt(before.revision)+1n),deleted:false,mediaType:op.mediaType,content,sha256:crypto.createHash('sha256').update(content).digest()};
      rows.set(key,after);commands.set(key+':'+op.commandId,{commandId:op.commandId,before,after});writes++;return{revision:after.revision};
    }
  };
  const calls=[];const item={product:{id:'22',storeId:'11'},price:{},stock:{},economics:{},advertising:{}};
  const optimizer={async prices(options){calls.push(options);return{items:options.productId&&options.productId!=='22'?[]:[item],total:1,limit:50,offset:0};}};
  const center=createGrowthCenter({optimizer,stateStore,storesRepository:{async read(){return{'11':{name:'Test',market:'OZON'},'wb-1':{name:'WB',market:'WB'}};}},now:()=>NOW,...overrides});
  return{center,stateStore,calls,rows,writes:()=>writes};
}
test('observation uses comparable buyer prices and canonical Ozon product URLs',()=>{
  const data=normalizeObservation(observation(),NOW);assert.equal(data.competitors[0].url,'https://www.ozon.ru/product/123456/');assert.equal(data.source,'manual');
  for(const edit of [{comparable:false},{observedAt:'2026-10-02T08:00:00Z'},{ownBuyerPrice:null},{ownUnitCount:0}])assert.throws(()=>normalizeObservation({...observation(),...edit},NOW));
  for(const url of ['https://ozon.ru.evil.example/product/123/','http://www.ozon.ru/product/123/','https://user:secret@ozon.ru/product/123/']){
    const value=observation();value.competitors[0].url=url;assert.throws(()=>normalizeObservation(value,NOW));
  }
});
test('duplicate product aliases cannot inflate the comparison sample',()=>{
  const value=observation();value.competitors.push({...value.competitors[0],url:'https://ozon.ru/product/123456/'});assert.throws(()=>normalizeObservation(value,NOW));
});
test('observations persist locally and identical command replay survives canonical JSON encoding',async()=>{
  const f=fixture(),input={storeId:'11',productId:'22',expectedRevision:'0',commandId:crypto.randomUUID(),observation:observation()};
  const first=await f.center.saveEvidence(input);assert.equal(first.revision,'1');assert.equal(first.latest.competitors[0].id,'123456');
  const second=await f.center.saveEvidence(input);assert.equal(second.replayed,true);assert.equal(f.writes(),1);
  await assert.rejects(f.center.saveEvidence({...input,observation:{...observation(),ownBuyerPrice:1100}}),{code:'COMMAND_ID_REUSED'});
  await assert.rejects(f.center.saveEvidence({...input,commandId:crypto.randomUUID()}),{code:'REVISION_CONFLICT'});
});
test('store and product ownership are verified before writing evidence',async()=>{
  const f=fixture(),base={storeId:'11',productId:'33',expectedRevision:'0',commandId:crypto.randomUUID(),observation:observation()};
  await assert.rejects(f.center.saveEvidence(base),{code:'NOT_FOUND'});
  await assert.rejects(f.center.saveEvidence({...base,storeId:'99'}),{code:'NOT_FOUND'});assert.equal(f.writes(),0);
});
test('list shares existing optimizer pagination and never presents complete competitor monitoring',async()=>{
  const f=fixture(),result=await f.center.list(new URLSearchParams({store:'11',offset:'50',objective:'sales'}));
  assert.equal(f.calls[0].offset,50);assert.equal(result.coverage.competitorMonitoring,false);assert.equal(result.capabilities.auto,false);assert.equal(result.items[0].marketEvidence.latest,null);assert.equal(result.items[0].advisory.status,'data_needed');
});
test('period filters use completed Moscow dates and reject impossible or oversized requests',()=>{
  assert.equal(parseOptions(new URLSearchParams(),NOW).to,'2026-09-30');
  for(const value of [{from:'2026-02-30'},{to:'2026-10-01'},{limit:'101'},{objective:'AUTO'}])assert.throws(()=>parseOptions(new URLSearchParams(value),NOW));
});
test('HTTP authentication is checked before reading or storing any evidence',async()=>{
  let calls=0;const route=createGrowthRoutes({center:{async list(){calls++;}},authorize:async()=>false});
  const res={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
  await route.handle(Readable.from([]),res,new URL('http://localhost/api/growth'));assert.equal(res.status,403);assert.equal(calls,0);
});

test('commercial terms are private global settings, canonical and idempotent',async()=>{
  const f=fixture();assert.equal((await f.center.terms()).terms,null);
  const input={expectedRevision:'0',commandId:crypto.randomUUID(),terms:{commissionPct:21,advertisingPct:12,priceBasis:'seller_price',application:'planning_reserve'}};
  assert.equal((await f.center.saveTerms(input)).revision,'1');
  assert.equal((await f.center.saveTerms(input)).replayed,true);assert.equal(f.writes(),1);
  const list=await f.center.list(new URLSearchParams({store:'11'}));assert.equal(list.commercialTerms.terms.commissionPct,21);assert.equal(list.items[0].commercialPlan.status,'unavailable');
  await assert.rejects(f.center.saveTerms({...input,terms:{...input.terms,advertisingPct:13}}),{code:'COMMAND_ID_REUSED'});
  await assert.rejects(f.center.saveTerms({...input,commandId:crypto.randomUUID()}),{code:'REVISION_CONFLICT'});
  for(const terms of [{...input.terms,commissionPct:-1},{...input.terms,commissionPct:90},{...input.terms,advertisingPct:'12'},{...input.terms,priceBasis:'buyer_price'}]) await assert.rejects(f.center.saveTerms({...input,commandId:crypto.randomUUID(),terms}),{code:'INVALID_ARGUMENT'});
});

test('market index read preserves unknown values and cannot invent a competitor list',async()=>{
  const calls=[];const f=fixture({readMarket:async(...args)=>{calls.push(args);return{items:[{product_id:22,price_indexes:{color_index:'GREEN',ozon_index_data:{minimal_price:'912.50',minimal_price_currency:'RUB',price_index_value:1.02},external_index_data:{minimal_price:0,price_index_value:'NaN'}}}]};}});
  const value=await f.center.market({storeId:'11',productId:'22'});
  assert.deepEqual(calls,[['11','22']]);assert.equal(value.priceIndex.ozon.minimumPrice,912.5);assert.equal(value.priceIndex.external.minimumPrice,null);assert.equal(value.priceIndex.external.index,null);assert.equal(value.competitors,undefined);
  await assert.rejects(f.center.market({storeId:'99',productId:'22'}),{code:'NOT_FOUND'});assert.equal(calls.length,1);
  await assert.rejects(f.center.market({storeId:'11',productId:'33'}),{code:'NOT_FOUND'});
});

test('concurrent terms retries recover the committed receipt despite different server timestamps',async()=>{
  let tick=NOW;const f=fixture({now:()=>tick++});
  const input={expectedRevision:'0',commandId:crypto.randomUUID(),terms:{commissionPct:21,advertisingPct:12,priceBasis:'seller_price',application:'planning_reserve'}};
  const results=await Promise.all([f.center.saveTerms(input),f.center.saveTerms(input)]);
  assert.equal(f.writes(),1);assert.equal(results[0].observedAt,results[1].observedAt);assert.ok(results.some(r=>r.replayed));
});

test('terms HTTP writes require authorization, size limits and valid JSON',async()=>{
  const f=fixture();const reply=()=>({writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}});
  const denied=createGrowthRoutes({center:f.center,authorize:async()=>false});let req=Readable.from(['{}']);req.method='POST';let res=reply();await denied.handle(req,res,new URL('http://localhost/api/growth/terms'));assert.equal(res.status,403);assert.equal(f.writes(),0);
  const route=createGrowthRoutes({center:f.center,authorize:async()=>true});
  for(const [body,status] of [['{',400],['x'.repeat(32769),413]]){req=Readable.from([body]);req.method='POST';res=reply();await route.handle(req,res,new URL('http://localhost/api/growth/terms'));assert.equal(res.status,status);}
});

test('watchlist routes preserve candidates separately from fresh market evidence',async()=>{
  const f=fixture(),route=createGrowthRoutes({center:f.center,authorize:async()=>true});
  const payload={storeId:'11',productId:'22',expectedRevision:'0',commandId:crypto.randomUUID(),competitors:[{name:'Аналог',url:'https://ozon.ru/product/123/',matchStatus:'candidate',matchNotes:'Проверить фасовку',unitCount:null,source:'ozon_seller_analytics',metrics:null}]};
  const res={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
  let req=Readable.from([JSON.stringify(payload)]);req.method='POST';await route.handle(req,res,new URL('http://localhost/api/growth/watchlist'));assert.equal(res.status,200);assert.equal(res.body.revision,'1');
  const list=await f.center.list(new URLSearchParams({store:'11'}));assert.equal(list.items[0].watchlist.competitors.length,1);assert.equal(list.items[0].marketEvidence.latest,null);assert.equal(list.items[0].advisory.coverage.competitors,false);
  req=Readable.from([JSON.stringify({...payload,competitors:[{...payload.competitors[0],url:'https://evil.example/product/123/'}]})]);req.method='POST';await route.handle(req,res,new URL('http://localhost/api/growth/watchlist'));assert.equal(res.status,400);assert.equal(res.body.code,'INVALID_ARGUMENT');
});
