'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeAudit} = require('../stock-history-audit-import.cjs');
const file = 'stock-audit/test.jsonl';
const storeMap = {shop:{id:'pult-shop',name:'Магазин'}};
function fixture() {
  const states = Object.fromEntries(['K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','AA','mainTotal'].map(k => [k,k === 'K' || k === 'mainTotal' ? 5 : 0]));
  const common = {runId:'run-1',storeId:'shop'};
  return [
    {...common,event:'start',at:'2026-09-21T01:00:00Z'},
    {...common,event:'page',at:'2026-09-21T01:00:01Z',attempt:1,page:1,pages:1,expected:1,records:[{itemId:'sku-1',cabinetItemCode:'internal-code',productId:null,warehouseId:null,granularity:'sku-all-warehouses',states}]},
    {...common,event:'committed',at:'2026-09-21T01:00:02Z',uniqueCount:1,rawCount:1,pages:1,pagesCaptured:1,duplicates:0,rowTotals:{...states},serverResidualQty:0}
  ];
}
function audit(data) { return normalizeAudit({files:{[file]:data},storeMap}); }

test('audit day follows Moscow calendar rather than UTC',()=>{
 const data=fixture();data[1].at='2026-09-20T23:30:00Z';data[2].at='2026-09-20T23:30:01Z';const r=audit(data);assert.equal(r.rows[0].day,'2026-09-21');assert.equal(r.rows[0].observedAt,'2026-09-20T23:30:00.000Z');
});
test('committed run preserves identities, observations and raw states without guessing semantics', () => {
  const input=fixture(), before=JSON.stringify(input), result=audit(input), row=result.rows[0];
  assert.equal(result.rows.length,1); assert.equal(result.issues.length,0);
  assert.equal(row.sku,'sku-1'); assert.equal(row.article,null); assert.equal(row.totalStock,5);
  assert.equal(row.available,null); assert.equal(row.inTransit,null); assert.equal(row.reserved,null);
  assert.equal(row.observedAt,'2026-09-21T01:00:01.000Z'); assert.equal(row.storeId,'pult-shop');
  assert.equal(row.sourceFile,file); assert.equal(row.sourceRow,'1.records[0]');
  assert.deepEqual(row.details.states,input[1].records[0].states);
  assert.equal(JSON.stringify(input),before); assert.deepEqual(audit(input),result);
});
test('previous failed attempts do not contaminate committed quantities', () => {
  const input=fixture(), old=structuredClone(input[1]); old.records[0].states.mainTotal=999;
  input[1].attempt=2;
  input.splice(1,0,old,{runId:'run-1',storeId:'shop',event:'attempt_rejected',attempt:1});
  const result=audit(input); assert.equal(result.rows.length,1); assert.equal(result.rows[0].totalStock,5); assert.equal(result.rows[0].details.attempt,2);
});
test('uncommitted, partial, duplicate and mismatched runs are rejected as a whole', () => {
  const variants=[
    a=>a.pop(),
    a=>a[1].pages=2,
    a=>a[1].records.push(structuredClone(a[1].records[0])),
    a=>a[1].records[0].states.K=4,
    a=>a[1].records[0].states.mainTotal=null,
    a=>a[1].at='2026-09-21T01:00:03Z',
    a=>a[1].records[0].granularity='unknown',
    a=>a[1].records[0].itemId=null
  ];
  for(const mutate of variants){const input=fixture();mutate(input);const r=audit(input);assert.equal(r.rows.length,0);assert.ok(r.issues.length);}
  assert.equal(normalizeAudit({files:{[file]:fixture()},storeMap:{}}).rows.length,0);
});
test('server residual remains visible rather than forcing reconciled totals', () => {
  const input=fixture(); input[2].serverResidualQty=3; input[2].controlResidual={AA:{rows:0,server:3}};
  const result=audit(input); assert.equal(result.rows[0].totalStock,5);
  assert.equal(result.rows[0].details.serverResidualQty,3); assert.equal(result.issues[0].code,'committed_server_residual');
});
test('diagnostic imports only raw analytics rows and never pretends full inventory', () => {
  const item={sku:'sku-2',warehouse_id:123,offer_id:'article',available_stock_count:0,transit_stock_count:7,valid_stock_count:10};
  const data={generatedAt:'2026-08-12T23:30:00+03:00',stores:[{storeId:'shop',probes:[
    {ok:true,endpoint:'/v1/analytics/stocks',raw:{items:[item]}},
    {ok:false,endpoint:'/v1/analytics/stocks',raw:{items:[item]}},
    {ok:true,endpoint:'SK Control API candidate',raw:{items:[item]}},
    {ok:true,endpoint:'/v3/posting/fbo/list',raw:{items:[item]}}
  ]}]};
  const name='stock-api-diagnostics/example.json';
  const result=normalizeAudit({files:{[name]:data},storeMap});assert.equal(result.rows.length,1);
  const row=result.rows[0];assert.equal(row.available,0);assert.equal(row.inTransit,7);assert.equal(row.totalStock,null);assert.equal(row.reserved,null);
  assert.equal(row.warehouseId,'123');assert.equal(row.observedAt,'2026-08-12T20:30:00.000Z');assert.equal(row.source,'diagnostic-warehouse');
  assert.equal(row.details.completeness,'unknown-diagnostic-sample');assert.deepEqual(row.details.stockCounts,{available_stock_count:0,transit_stock_count:7,valid_stock_count:10});
  data.generatedAt=null;assert.equal(normalizeAudit({files:{[name]:data},storeMap}).rows.length,0);
});
test('malformed diagnostic counts become null and do not fabricate zeros', () => {
  const data={generatedAt:'2026-08-12T11:00:00Z',stores:[{storeId:'shop',probes:[{ok:true,endpoint:'/v1/analytics/stocks',raw:{items:[{sku:1,warehouse_id:1,available_stock_count:'2',transit_stock_count:null,valid_stock_count:5}]}}]}]};
  const result=normalizeAudit({files:{'stock-api-diagnostics/test.json':data},storeMap});
  assert.equal(result.rows[0].available,null);assert.equal(result.rows[0].inTransit,null);assert.equal(result.issues[0].code,'invalid_diagnostic_counts');
});
