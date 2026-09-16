const test=require('node:test'),assert=require('node:assert/strict');
const {buildLedger}=require('../ledger.cjs'),{economics}=require('../economics.cjs');
const period={from:'2026-09-01',to:'2026-09-16'},m=(amount,currency='RUB')=>({amount:String(amount),currency});
function sale(sku,amount,price,fee=-20){return {date:period.to,total_amount:m(amount+fee),posting:{products:[{sku,commission:{sale_amount:m(amount),seller_price:price===null?undefined:m(price),commission:m(fee),bonus:m(35),coinvestment:m(10)}}]}}}
function store(ops=[sale(10,200,100)],products=[{key:'1:1',sku:10,skus:[10,11],name:'Товар',archived:true,cost:{status:'filled',currency:'RUB',unitCost:30}}]){return {id:'1',name:'Магазин',products,ledger:buildLedger({period,sections:{finance:{ok:true}},operations:ops})}}
test('profit uses sold units and returns, includes common expenses once and never adds bonuses twice',()=>{
 const s=store([sale(10,200,100,-40),sale(11,-100,-100,20),{date:period.to,total_amount:m(-10),non_item_fee:{type_id:7,accrued:m(-10)}}]);
 const e=economics([s],period);assert.equal(e.complete,true);assert.equal(e.soldUnits,2);assert.equal(e.returnedUnits,1);assert.equal(e.realized,100);assert.equal(e.net,70);assert.equal(e.cogs,30);assert.equal(e.profit,40);assert.equal(e.margin,40);assert.equal(e.sharedNet,-10);assert.equal(e.knownContribution,50);assert.equal(e.products.find(p=>p.sku==='10').perUnit,50);assert.equal(e.products.find(p=>p.sku==='11').margin,null);
});
test('nonintegral, missing and non-RUB unit prices cannot create fictitious quantity or profit',()=>{
 const foreign=sale(13,100,100);foreign.posting.products[0].commission.seller_price=m(100,'USD');const s=store([sale(10,100,100),sale(11,260.4,210),sale(12,100,null),foreign]);const e=economics([s],period);
 assert.equal(e.unknownUnitRows,3);assert.equal(e.complete,false);assert.equal(e.profit,null);assert.equal(e.cogs,null);assert.equal(e.knownContribution,50);assert.equal(e.products.find(p=>p.sku==='11').profit,null);assert.equal(e.soldUnits,1);
});
test('missing costs preserve the known subtotal and do not masquerade as zero purchase costs',()=>{
 const e=economics([store([sale(10,100,100),sale(99,200,100)])],period);assert.equal(e.missingCostSkus,1);assert.equal(e.profit,null);assert.equal(e.knownCogs,30);assert.equal(e.knownContribution,50);assert.equal(e.products.find(p=>p.sku==='99').unitCost,null);
});
test('no sales need no costs; complete empty periods produce zero and incomplete periods stay unavailable',()=>{
 const s=store([]);let e=economics([s],period);assert.equal(e.profit,0);assert.equal(e.margin,null);s.ledger.complete=false;e=economics([s],period);assert.equal(e.profit,null);assert.equal(e.knownContribution,null);assert.equal(economics([],period).profit,null);
 const old=store();old.ledger.version=2;assert.equal(economics([old],period).covered,false);assert.equal(economics([store()],{from:'2026-08-01',to:period.to}).profit,null);
});
test('SKU costs remain isolated by store; archived products still contribute to historical profit',()=>{
 const first=store([sale(10,100,100)]),second=store([sale(10,100,100)]);second.id='2';second.products[0].key='2:1';second.products[0].cost.unitCost=50;
 const e=economics([first,second],period);assert.equal(e.profit,80);assert.equal(e.calculatedSkus,2);assert.deepEqual(e.stores.map(s=>s.profit),[50,30]);
});
test('SKU ambiguity, invalid costs and sales without a SKU prevent a misleading full total',()=>{
 const s=store([sale(10,100,100)]);s.products.push({...s.products[0],key:'1:2'});assert.equal(economics([s],period).profit,null);
 for(const unitCost of [0,NaN,Infinity,1e20]){const s=store();s.products[0].cost.unitCost=unitCost;assert.equal(economics([s],period).profit,null)}
 const e=economics([store([sale(undefined,100,100)])],period);assert.equal(e.unmappedSaleRows,1);assert.equal(e.profit,null);
});
test('SKU service-only expenses and credit adjustments reconcile without assigning arbitrary purchase costs',()=>{
 const s=store([{date:period.to,total_amount:m(-5),item_fees:{fees:[{sku:99,fees:[{type_id:1,accrued:m(-5)}]}]}},{date:period.to,total_amount:m(2)}],[]);const e=economics([s],period);
 assert.equal(e.profit,-3);assert.equal(e.knownContribution,-5);assert.equal(e.sharedNet,2);assert.equal(e.cogs,0);assert.equal(e.margin,null);assert.equal(e.products[0].unitCost,null);assert.equal(e.products[0].perUnit,null);
});
test('foreign finance records make the full store economy unavailable',()=>{
 const s=store([{date:period.to,total_amount:m(100,'USD')}]);assert.equal(economics([s],period).covered,false);assert.equal(economics([s],period).profit,null);
});

test('quantity derives from integer kopecks for fractional ruble prices and either price sign',()=>{
 const s=store([sale(10,0.87,0.29,0),sale(10,-0.58,0.29,0),sale(11,0.58,-0.29,0)]);
 s.products[0].cost.unitCost=0.11;
 const e=economics([s],period);
 assert.equal(e.soldUnits,5);assert.equal(e.returnedUnits,2);assert.equal(e.cogs,0.33);assert.equal(e.realized,0.87);assert.equal(e.profit,0.54);assert.equal(e.unknownUnitRows,0);
});

test('even a one-kopeck remainder is unknown, never rounded to a sale unit',()=>{
 const e=economics([store([sale(10,199.99,100),sale(11,-200.01,100)])],period);
 assert.equal(e.soldUnits,0);assert.equal(e.returnedUnits,0);assert.equal(e.unknownUnitRows,2);assert.equal(e.profit,null);assert.equal(e.cogs,null);
});

test('primary SKU and aliases use the same current cost even when aliases omit primary',()=>{
 const s=store([sale(10,100,100),sale('11',200,100)]);s.products[0].skus=[11,'11'];
 const e=economics([s],period);assert.equal(e.complete,true);assert.equal(e.cogs,90);assert.equal(e.profit,170);assert.equal(e.missingCostSkus,0);
 assert.deepEqual(e.products.map(p=>p.key),['1:1','1:1']);
});

test('separate catalog entries without product keys cannot silently share one SKU cost',()=>{
 const s=store();delete s.products[0].key;
 s.products.push({sku:10,cost:{status:'filled',currency:'RUB',unitCost:90}});
 const e=economics([s],period);assert.equal(e.complete,false);assert.equal(e.profit,null);assert.equal(e.missingCostSkus,1);
});

test('legacy ledgers cannot publish profits or known subtotals with zero invented COGS',()=>{
 const s=store();s.ledger.version=2;
 for(const day of [...s.ledger.daily,...s.ledger.skuDaily]){delete day.values.soldUnits;delete day.values.salesRows;}
 const e=economics([s],period);assert.equal(e.covered,false);assert.equal(e.profit,null);assert.equal(e.cogs,null);assert.equal(e.knownContribution,null);assert.equal(e.products[0].profit,null);
});

test('current cost updates change a historical return estimate; archived status does not remove it',()=>{
 const s=store([sale(11,-100,100,20)]);
 let e=economics([s],period);assert.equal(e.cogs,-30);assert.equal(e.profit,-50);
 s.products[0].cost.unitCost=45;e=economics([s],period);assert.equal(e.cogs,-45);assert.equal(e.profit,-35);assert.equal(e.basis,'current-cost');
});
