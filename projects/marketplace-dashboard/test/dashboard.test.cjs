const test=require('node:test'),assert=require('node:assert/strict');
const {summarize}=require('../summary.cjs');
const model=require('../dist/dashboard-model.js');
test('financial groups and days preserve amounts, currencies and counts',()=>{
 const raw={operations:[{date:'2026-09-01',amount:0.1,operation_type:'A',total_amount:{currency:'RUB'}},{date:'2026-09-01',amount:0.2,operation_type:'A',total_amount:{currency:'RUB'}},{date:'2026-09-02',amount:-5,operation_type:'A',total_amount:{currency:'USD'}}],products:[],stocks:[]};
 const s=summarize(raw,null);assert.equal(s.operationCount,3);assert.equal(s.operations[0].amount,0.3);assert.equal(s.operations[0].record_count,2);assert.equal(s.daily.length,2);assert.equal(s.daily[1].currency,'USD');assert.equal(s.daily[1].amount,-5);
});
test('WB records never become a fictitious financial total',()=>{
 const s=summarize({market:'WB',financeAmountKnown:false,operations:[{sellerOperName:'Продажа',forPay:'100',rrDate:'2026-09-01'}],products:[]},null);
 assert.equal(s.financeAmountKnown,false);assert.equal(s.operationCount,1);assert.equal(s.daily.length,0);
});
test('missing stock is distinct from zero and cost filter excludes unmatched WB',()=>{
 const stores=[{id:'1',name:'Ozon'},{id:'wb-1',name:'WB'}],snapshots=new Map([
 ['1',{sections:{stocks:{ok:true}},products:[{product_id:1,name:'A',cost:{status:'zero'}},{product_id:2,name:'B',cost:{status:'filled',unitCost:20}}],stocks:[{product_id:1,stocks:[{present:0}]}]}],
 ['wb-1',{market:'WB',sections:{stocks:{ok:true}},products:[{product_id:3,name:'C'}],stocks:[]}]
 ]);
 const rows=model.rowsFor(stores,snapshots),filter={store:'',market:'',query:'',issue:'zero',sort:'name'};
 assert.equal(model.filterRows(rows,filter).length,1);
 assert.equal(model.filterRows(rows,{...filter,issue:'unknown'}).length,2);
 assert.deepEqual(model.filterRows(rows,{...filter,issue:'cost'}).map(r=>r.product_id),[1]);
 assert.equal(model.filterRows(rows,{...filter,issue:'',market:'WB'}).length,1);
 snapshots.get('1').sections.stocks.ok=false;
 assert.equal(model.rowsFor(stores,snapshots)[0].quantity,null);
});
test('CSV exports all supplied rows and escapes spreadsheet formulas and quotes',()=>{
 const csv=model.csv([{name:'=1+1',offer_id:'A"B',storeName:'Store',quantity:null},{name:'\t@SUM(A1)',quantity:0}]);
 assert.ok(csv.startsWith('\ufeff'));assert.ok(csv.includes('"\'=1+1"'));assert.ok(csv.includes('"A""B"'));assert.ok(csv.includes("'\t@SUM(A1)"));assert.equal(csv.split('\r\n').length,3);
});
test('inactive filter preserves ready products and unknown WB statuses and is reversible',()=>{
 const rows=[
  {market:'Ozon',name:'A',salesStatus:'Не продается'},
  {market:'Ozon',name:'B',salesStatus:'Не продаётся'},
  {market:'Ozon',name:'C',salesStatus:'Готов к продаже'},
  {market:'Ozon',name:'D',salesStatus:'Продается'},
  {market:'Ozon',name:'E',archived:true},
  {market:'WB',name:'F'},
  {market:'Ozon',name:'G'}
 ];
 const f={query:'',sort:'name',hideInactive:true};
 assert.deepEqual(model.filterRows(rows,f).map(p=>p.name),['C','D','F','G']);
 assert.equal(model.filterRows(rows,{...f,hideInactive:false}).length,7);
});
