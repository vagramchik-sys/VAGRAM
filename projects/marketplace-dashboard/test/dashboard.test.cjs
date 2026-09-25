const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
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
test('pre-aggregated finance summary is passed through without raw operations',()=>{
 const raw={store:'S',clientId:'1',financeAmountKnown:true,operationSummary:{operationCount:2,operations:[{operation_type_name:'Sale',currency:'RUB',amount:3,record_count:2}],daily:[{date:'2026-09-22',currency:'RUB',amount:3,records:2}]}};
 const value=summarize(raw,null,null);assert.equal(value.operationCount,2);assert.deepEqual(value.operations,raw.operationSummary.operations);assert.deepEqual(value.daily,raw.operationSummary.daily);
});
test('pre-aggregated WB finance with unknown amounts does not expose fictitious money',()=>{
 const raw={market:'WB',financeAmountKnown:false,operationSummary:{operationCount:2,operations:[{operation_type_name:'Sale',currency:'RUB',amount:300,record_count:2}],daily:[{date:'2026-09-22',currency:'RUB',amount:300,records:2}]}};
 const value=summarize(raw,null,null);assert.equal(value.operationCount,2);assert.deepEqual(value.operations,[{operation_type_name:'Sale',currency:'RUB',amount:0,record_count:2}]);assert.deepEqual(value.daily,[]);
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
test('stock rows keep present and reserved separate with strict numeric values',()=>{
 const stores=[{id:'1',name:'Ozon'}],snapshots=new Map([['1',{sections:{stocks:{ok:true}},products:[{product_id:1,name:'A'}],stocks:[{product_id:1,stocks:[
  {type:'fbo',present:'4',reserved:'2'}, {warehouse_id:7,type:'fbs',present:3,reserved:1}
 ]}]}]]);
 const row=model.rowsFor(stores,snapshots)[0];
 assert.equal(row.quantity,7);assert.equal(row.reservedQuantity,3);
 assert.deepEqual(row.stockBreakdown,{rows:[
  {name:'FBO',kind:'type',present:4,reserved:2},
  {name:'7 · FBS',kind:'warehouse',present:3,reserved:1}
 ],complete:true,reason:null});
});
test('grouped stock objects normalize without mutating the source',()=>{
 const source={fbo:[{present:2,reserved:1}],fbs:{present:'3',reserved:'0'}};
 const before=structuredClone(source),breakdown=model.stockBreakdown(source);
 assert.deepEqual(source,before);
 assert.deepEqual(breakdown.rows.map(row=>[row.name,row.kind,row.present,row.reserved]),[
  ['FBO','type',2,1],['FBS','type',3,0]
 ]);
 assert.equal(breakdown.complete,true);
});
test('empty, malformed and duplicate stock records stay unknown while a real zero is known',()=>{
 assert.equal(model.stockBreakdown([]).reason,'missing_stock_rows');
 for(const present of [null,undefined,'',-1,1.5,Infinity,false]) {
  const value=model.stockBreakdown([{present,reserved:0}]);
  assert.equal(value.complete,false);assert.equal(value.reason,'invalid_present');
 }
 const overflow=model.stockBreakdown([{present:Number.MAX_SAFE_INTEGER,reserved:0},{present:1,reserved:0}]);
 assert.equal(overflow.complete,false);assert.equal(overflow.reason,'stock_total_out_of_range');
 const stores=[{id:'1',name:'Ozon'}],base={sections:{stocks:{ok:true}},products:[{product_id:1,name:'A'}]};
 const zero=model.rowsFor(stores,new Map([['1',{...base,stocks:[{product_id:1,stocks:[{present:0,reserved:0}]}]}]]))[0];
 assert.equal(zero.quantity,0);assert.equal(zero.reservedQuantity,0);assert.equal(zero.stockBreakdown.complete,true);
 const duplicate=model.rowsFor(stores,new Map([['1',{...base,stocks:[
  {product_id:1,stocks:[{present:2,reserved:0}]},{product_id:1,stocks:[{present:3,reserved:0}]}
 ]}]]))[0];
 assert.equal(duplicate.quantity,null);assert.equal(duplicate.reservedQuantity,null);
 assert.equal(duplicate.stockBreakdown.reason,'duplicate_product_record');
});
test('malformed rows never turn a partial stock sum into a complete result',()=>{
 const stores=[{id:'1',name:'Ozon'}];
 for(const stocks of [[{present:5,reserved:1},null],[{present:5,reserved:1},false],{fbo:[{present:5,reserved:1},'bad']},{fbo:{present:5,reserved:1},fbs:null}]){
  const row=model.rowsFor(stores,new Map([['1',{sections:{stocks:{ok:true}},products:[{product_id:1}],stocks:[{product_id:1,stocks}]}]]))[0];
  assert.equal(row.quantity,null);assert.equal(row.reservedQuantity,null);assert.equal(row.stockBreakdown.complete,false);
 }
});

test('missing section invalidates both totals while missing reserve preserves a known present total',()=>{
 const stores=[{id:'1',name:'Ozon'}],snapshot={products:[{product_id:1}],stocks:[{product_id:1,stocks:[{present:5,reserved:2},{present:7}]}]};
 const read=()=>model.rowsFor(stores,new Map([['1',snapshot]]))[0];
 assert.equal(read().quantity,null);assert.equal(read().reservedQuantity,null);
 assert.equal(read().stockBreakdown.reason,'stock_section_unavailable');
 snapshot.sections={stocks:{ok:false}};
 assert.equal(read().quantity,null);assert.equal(read().reservedQuantity,null);
 snapshot.sections.stocks.ok=true;
 assert.equal(read().quantity,12);assert.equal(read().reservedQuantity,null);
 assert.equal(read().stockBreakdown.reason,'invalid_reserved');
});

test('CSV exports all supplied rows and escapes spreadsheet formulas and quotes',()=>{
 const csv=model.csv([{name:'=1+1',offer_id:'A"B',storeName:'Store',quantity:null,reservedQuantity:null},{name:'\t@SUM(A1)',quantity:0,reservedQuantity:2}]);
 assert.ok(csv.startsWith('\ufeff'));assert.ok(csv.includes('"\'=1+1"'));assert.ok(csv.includes('"A""B"'));assert.ok(csv.includes("'\t@SUM(A1)"));assert.equal(csv.split('\r\n').length,3);
 assert.ok(csv.includes('"Зарезервировано"'));assert.ok(csv.includes('"2"'));
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

test('dashboard defers full store snapshots outside catalog, finance and store sections',()=>{
 const source=fs.readFileSync(require.resolve('../dist/dashboard.js'),'utf8');
 assert.match(source,/snapshotSections=new Set\(\['products','finance','stores'\]\)/);
 assert.match(source,/document\.body\.dataset\.pultView\|\|url\.searchParams\.get\('view'\)/);
 assert.match(source,/window\.addEventListener\('pult:view-change',nav\)/);
 assert.match(source,/const need=loadSnapshots\?stores\.filter/);
 assert.match(source,/setInterval\(\(\)=>\{if\(!document\.hidden&&snapshotSection\(\)\)void refresh\(false,false\)\},30000\)/);
 assert.match(source,/Каталог загружается только при открытии этого раздела/);
 assert.match(source,/Загрузятся при открытии финансов/);
 assert.doesNotMatch(source,/setInterval\(\(\)=>\{if\(!document\.hidden\)void refresh\(\)\}/);
 assert.match(source,/api\('\/api\/stores',null,force\?\{cache:'reload'\}:undefined\)/);
});

test('dashboard coalesces duplicate navigation refreshes',async()=>{
 const source=fs.readFileSync(require.resolve('../dist/dashboard.js'),'utf8').split("try{$('hide-inactive')")[0];
 const nodes=new Map(),element=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,disabled:false,className:'',textContent:'',innerHTML:'',options:[]});return nodes.get(id)};
 let resolveStores,calls=0;
 const context={
  console,URL,Intl,Date,Map,Set,Promise,
  location:{href:'http://pult.local/#products',hash:'#products'},
  document:{body:{dataset:{}},getElementById:element,querySelectorAll:()=>[]},
  PultModel:{rowsFor:()=>[],isInactive:()=>false,filterRows:()=>[]},
  fetch:()=>{calls++;return new Promise(resolve=>{resolveStores=()=>resolve({ok:true,json:async()=>[]})})}
 };
 vm.runInNewContext(source+';globalThis.testRefresh=refresh',context);
 const first=context.testRefresh(false,true),duplicate=context.testRefresh(false,true);
 assert.equal(calls,1,'the duplicate view event reuses the active refresh');
 resolveStores();await Promise.all([first,duplicate]);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,1,'no trailing duplicate /api/stores request is queued');
});
