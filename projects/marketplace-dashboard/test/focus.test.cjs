const test=require('node:test'),assert=require('node:assert/strict'),{build,filter}=require('../dist/focus-model.js');
const product=(sku,amount,extra={})=>({storeId:'1',sku,key:'1:'+sku,name:'Товар '+sku,offer_id:'A'+sku,storeName:'Тест',realized:amount,net:amount*.6,commission:amount*.2,logistics:amount*.1,quantity:5,cost:2,...extra});
const report=products=>({coverage:{finance:true},products,stores:[{id:'1',name:'Тест',complete:true,realized:100,net:60,commission:20,logistics:10,ads:10}]});
test('ABC covers threshold crossing items and excludes nonpositive corrections from its denominator',()=>{
 const m=build(report([product(1,60),product(2,25),product(3,10),product(4,5),product(5,-20),product(6,0)]));
 assert.deepEqual(m.products.map(p=>p.abc),['A','A','B','C','—','—']);assert.equal(m.positiveRealized,100);assert.equal(m.groups[0].share,85);assert.equal(m.groups.reduce((v,g)=>v+g.share,0),100);
});
test('a dominant first SKU remains in A, with a stable id distinct across stores',()=>{
 const m=build(report([product(1,99),product(2,1),product(1,0,{storeId:'2'})]));assert.equal(m.products[0].abc,'A');assert.equal(m.products[1].abc,'C');assert.notEqual(m.products[0].focusId,m.products[2].focusId);
});
test('unknown inventory is not zero; archive and missing catalog do not trigger inventory actions',()=>{
 const m=build(report([product(1,100,{quantity:0,cost:null}),product(2,100,{quantity:null,cost:5}),product(3,100,{quantity:0,cost:null,archived:true}),product(4,100,{quantity:0,cost:null,key:null})]));
 assert.equal(m.alerts.stockout,1);assert.equal(m.alerts.cost,1);assert.equal(m.products[2].abc!=='—',true);
});
test('negative accruals and high logistics are explicit checks, without inferring profit',()=>{
 const m=build(report([product(1,100,{net:-10,logistics:30}),product(2,0,{net:-20,logistics:50})]));assert.equal(m.alerts.negative,2);assert.equal(m.alerts.logistics,1);assert.equal(m.stores[0].per100.net,60);
});
test('partial financial periods suppress analyses and zero or negative realization disables per100',()=>{
 const r=report([product(1,100)]);r.coverage.finance=false;r.stores[0].realized=0;const m=build(r);assert.equal(m.products.length,0);assert.equal(m.alerts.stockout,null);assert.equal(m.stores[0].share,null);assert.equal(m.stores[0].per100,null);
});
test('filters combine search, favorites, risk and sorting without mutating source rows',()=>{
 const m=build(report([product(1,100,{quantity:0}),product(2,80,{quantity:null}),product(3,20,{quantity:1,net:-2})])),favorites=new Set(['1:2']);
 assert.deepEqual(filter(m.products,{filter:'favorites',favorites}).map(p=>p.sku),[2]);assert.equal(filter(m.products,{filter:'stockout',query:'Тест'}).length,1);assert.equal(filter(m.products,{sort:'netAsc'})[0].sku,3);assert.equal(filter(m.products,{sort:'stock'}).at(-1).sku,2);assert.equal(m.products[0].sku,1);
});
