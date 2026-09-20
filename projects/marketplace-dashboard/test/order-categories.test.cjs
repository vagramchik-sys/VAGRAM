'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create,broadCategory,canonicalCategory,productIndex,ozonTotals,wbSeries,UNMATCHED}=require('../order-categories.cjs');
const DAY='2026-09-20',AT='2026-09-20T09:00:00.000Z';
function fixture(t){const privateDir=fs.mkdtempSync(path.join(os.tmpdir(),'order-categories-'));t.after(()=>fs.rmSync(privateDir,{recursive:true,force:true}));return {privateDir}}
function stores(){return [
 {id:'1',market:'Ozon',categoryTree:[{description_category_id:12,category_name:'Строительство',children:[{description_category_id:13,category_name:'Крепёжные изделия',children:[{type_id:14,type_name:'Саморезы'}]}]}],products:[{product_id:1,sku:101,description_category_id:13,type_id:14},{product_id:2,sku:102,description_category_id:999,type_id:999}],orders:{skuDailyCoverage:true,skuUpdatedAt:AT,skuDaily:[{date:DAY,sku:'101',revenue:120,units:2},{date:DAY,sku:'102',revenue:30,units:1}]}},
 {id:'wb-1',market:'WB',products:[{nmID:201,title:'Перчатки хозяйственные',vendorCode:'WB-201',subjectName:'Перчатки хозяйственные'}],orders:{complete:true,day:DAY,orders:[{at:'2026-09-20T08:30:00.000Z',amount:50,nmId:'201',category:'Хозяйственные товары',subject:'Перчатки хозяйственные'},{at:'2026-09-20T09:15:00.000Z',amount:70,nmId:'999',category:'Строительные материалы',subject:'Тенты'}]}}
 ]}
test('only platform category fields and explicit assignments form broad deterministic categories',()=>{
 assert.equal(broadCategory(['Крепёжные изделия','Саморезы']),'Крепёж');assert.equal(broadCategory(['Расходные материалы','Термоэтикетки']),'Термоэтикетки');assert.equal(broadCategory([]),UNMATCHED);
 const index=productIndex(stores(),[{name:'Приоритет владельца',productKeys:['1:1']}]);assert.equal(index.get('1').get('101'),'Приоритет владельца');assert.equal(index.get('1').get('102'),UNMATCHED);assert.equal(index.get('wb-1').get('201'),'Перчатки');
});
test('Ozon category totals fail closed without full SKU coverage and retain unknown as unmatched',()=>{
 const input=stores(),index=productIndex(input,[]),value=ozonTotals(input,index,DAY);assert.equal(value.complete,true);assert.deepEqual(value.totals.get('Крепёж'),{orderedRevenue:120,orderedUnits:2});assert.deepEqual(value.totals.get(UNMATCHED),{orderedRevenue:30,orderedUnits:1});
 input[0].orders.skuDailyCoverage=false;assert.equal(ozonTotals(input,index,DAY).complete,false);
});
test('WB category curves use actual Moscow-day order timestamps and never merge amount bases',()=>{
 const input=stores(),value=wbSeries(input,productIndex(input,[]),DAY);assert.equal(value.complete,true);assert.equal(value.series.length,2);const tent=value.series.find(s=>s.category==='Тенты');assert.equal(tent.amountBasis,'priceWithDisc');assert.deepEqual(tent.points,[{at:'2026-09-20T09:15:00.000Z',orderedRevenue:70,orderedUnits:1}]);
 input[1].orders.orders[0].at='2026-09-19T20:59:59.000Z';assert.equal(wbSeries(input,productIndex(input,[]),DAY).complete,false);
});
test('repeated Ozon capture is idempotent and report exposes separate marketplace series and limitations',t=>{
 const f=fixture(t),service=create(f),input=stores();service.captureOzon(input,[]);service.captureOzon(input,[]);assert.equal(service.read().points.length,1);
 const report=service.report({stores:input,categories:[],date:DAY});assert.deepEqual(report.categories,[UNMATCHED,'Крепёж','Перчатки','Тенты'].sort((a,b)=>a===UNMATCHED?1:b===UNMATCHED?-1:a.localeCompare(b,'ru')));assert.ok(report.series.some(s=>s.market==='Ozon'&&s.category==='Крепёж'));assert.ok(report.series.some(s=>s.market==='WB'&&s.category==='Тенты'));assert.match(report.limitations.join(' '),/не складываются/);
});
test('capture preserves category history older than a year without duplicating the current point',t=>{
 const f=fixture(t),file=path.join(f.privateDir,'order-category-intraday.json'),old={date:'2024-01-01',at:'2024-01-01T09:00:00.000Z',values:{Крепёж:{orderedRevenue:1,orderedUnits:1}}};
 fs.writeFileSync(file,JSON.stringify({version:1,points:[old]}));const service=create(f),input=stores();service.captureOzon(input,[]);service.captureOzon(input,[]);
 assert.deepEqual(service.read().points,[old,{date:DAY,at:AT,values:{Крепёж:{orderedRevenue:120,orderedUnits:2},'Не сопоставлено':{orderedRevenue:30,orderedUnits:1}}}]);
});
test('reviewed Ozon and WB aliases preserve intentionally separate categories',()=>{
 const fixtures=[
  ['Ozon','Клейкая лента канцелярская','Клейкие ленты'],['Ozon','Малярная лента','Клейкие ленты'],['Ozon','Монтажная лента','Клейкие ленты'],['Ozon','Краги сварщика','Перчатки'],['Ozon','Талреп','Крепёж'],['Ozon','Сетка строительная','Сетки строительные'],
  ['WB','Болты','Крепёж'],['WB','Гвозди','Крепёж'],['WB','Дюбели','Крепёж'],['WB','Саморезы кровельные','Крепёж'],['WB','Саморезы по дереву','Крепёж'],['WB','Саморезы универсальные','Крепёж'],['WB','Уголки крепежные','Крепёж'],['WB','Шайбы крепежные','Крепёж'],['WB','Перчатки рабочие','Перчатки'],['WB','Тенты универсальные','Тенты'],
  ['Ozon','Круг отрезной','Круг отрезной'],['WB','Диски для УШМ','Диски для УШМ'],['Ozon','Мешки для мусора','Мешки для мусора'],['WB','Мешки строительные','Мешки строительные'],['Ozon','Алюминиевая лента','Алюминиевая лента']
 ];
 for(const [market,source,expected] of fixtures)assert.equal(canonicalCategory(market,[source]),expected,market+' '+source);
});
test('historical Ozon aliases merge at read time without rewriting stored points',t=>{
 const f=fixture(t),file=path.join(f.privateDir,'order-category-intraday.json');
 const original={version:1,points:[{date:DAY,at:AT,values:{'Клейкая лента канцелярская':{orderedRevenue:10.25,orderedUnits:1},'Малярная лента':{orderedRevenue:20.75,orderedUnits:2},'Круг отрезной':{orderedRevenue:7,orderedUnits:1}}}]};
 fs.writeFileSync(file,JSON.stringify(original));
 const service=create(f),input=stores();input[0].orders.skuUpdatedAt='2026-09-19T09:00:00.000Z';
 const report=service.report({stores:input,categories:[],date:DAY}),tapes=report.series.find(s=>s.market==='Ozon'&&s.category==='Клейкие ленты'),disc=report.series.find(s=>s.market==='Ozon'&&s.category==='Круг отрезной');
 assert.deepEqual(tapes.points,[{at:AT,orderedRevenue:31,orderedUnits:3}]);assert.deepEqual(disc.points,[{at:AT,orderedRevenue:7,orderedUnits:1}]);
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),original);
});
test('corrupt history fails closed and capture never overwrites it',t=>{
 const f=fixture(t),file=path.join(f.privateDir,'order-category-intraday.json'),broken='{not json';
 fs.writeFileSync(file,broken);
 const service=create(f);
 assert.throws(()=>service.captureOzon(stores(),[]),/повреждена/);
 assert.equal(fs.readFileSync(file,'utf8'),broken);
});
test('historical points with missing amounts are rejected instead of becoming zero',t=>{
 const f=fixture(t),file=path.join(f.privateDir,'order-category-intraday.json');
 const original={version:1,points:[{date:DAY,at:AT,values:{Крепёж:{orderedUnits:1}}}]};
 fs.writeFileSync(file,JSON.stringify(original));
 const input=stores();input[0].orders.skuUpdatedAt='2026-09-19T09:00:00.000Z';
 assert.throws(()=>create(f).report({stores:input,categories:[],date:DAY}),/неполные суммы/);
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),original);
});
test('reviewed hierarchy joins identical final types across markets and aggregates parents once',t=>{
 const f=fixture(t),file=path.join(f.privateDir,'order-category-intraday.json'),input=stores();
 input[0].products[0].name='Сетка от грызунов';input[0].products[1].name='Сетка штукатурная';input[1].products.push({nmID:999,title:'Сетка штукатурная',vendorCode:'WB-999'});
 fs.writeFileSync(file,JSON.stringify({version:1,points:[{date:DAY,at:'2026-09-20T08:00:00.000Z',values:{'Старая категория':{orderedRevenue:999,orderedUnits:9}}}]}));
 const registry={available:true,revision:'types-1',types:[{id:'mesh',parentId:null,name:'Сетки'},{id:'rodent-mesh',parentId:'mesh',name:'Сетка от грызунов'},{id:'plaster-mesh',parentId:'mesh',name:'Сетка штукатурная'}],assignments:{'1:1':{typeId:'rodent-mesh',source:'reviewed',evidence:null},'1:2':{typeId:'plaster-mesh',source:'reviewed',evidence:null},'wb-1:201':{typeId:'rodent-mesh',source:'reviewed',evidence:null},'wb-1:999':{typeId:'plaster-mesh',source:'reviewed',evidence:null}},rules:[]};
 const service=create({...f,productTypes:{read:()=>registry},now:()=>Date.parse('2026-09-20T10:00:00.000Z')}),report=service.report({stores:input,categories:[],date:DAY});
 const ozon=report.series.find(row=>row.market==='Ozon'&&row.typeId==='mesh'),wb=report.series.find(row=>row.market==='WB'&&row.typeId==='mesh');
 assert.deepEqual(ozon.points,[{at:AT,orderedRevenue:150,orderedUnits:3}]);assert.deepEqual(wb.points.at(-1),{at:'2026-09-20T09:15:00.000Z',orderedRevenue:120,orderedUnits:2});
 assert.equal(report.taxonomyBoundary.sourceAt,AT);assert.equal(report.taxonomyBoundary.classifiedAt,'2026-09-20T10:00:00.000Z');assert.equal(report.taxonomyBoundary.legacyPoints,1);assert.ok(!report.series.some(row=>row.category==='Старая категория'));
});
test('active hierarchy keeps an unknown Ozon SKU under the stable unmatched id',t=>{
 const f=fixture(t),input=stores();input[0].orders.skuDaily.push({date:DAY,sku:'999',revenue:11,units:1});
 const registry={available:true,revision:'types-unknown',types:[{id:'fasteners',parentId:null,name:'Крепёж'}],assignments:{'1:1':{typeId:'fasteners',source:'reviewed',evidence:null},'1:2':{typeId:'fasteners',source:'reviewed',evidence:null}},rules:[]};
 const report=create({...f,productTypes:{read:()=>registry},now:()=>Date.parse('2026-09-20T10:00:00.000Z')}).report({stores:input,categories:[],date:DAY}),unmatched=report.series.find(row=>row.market==='Ozon'&&row.typeId==='unmatched');
 assert.deepEqual(unmatched.points,[{at:AT,orderedRevenue:11,orderedUnits:1}]);
});
test('taxonomy revision creates a new honest point without rewriting prior revisions',t=>{
 const f=fixture(t),input=stores(),base={available:true,types:[{id:'fasteners',parentId:null,name:'Крепёж'}],assignments:{'1:1':{typeId:'fasteners',source:'reviewed',evidence:null},'1:2':{typeId:'fasteners',source:'reviewed',evidence:null},'wb-1:201':{typeId:'fasteners',source:'reviewed',evidence:null}},rules:[]};let revision='types-1',clock=Date.parse('2026-09-20T10:00:00.000Z');
 const service=create({...f,productTypes:{read:()=>({...base,revision})},now:()=>clock});service.report({stores:input,categories:[],date:DAY});revision='types-2';clock+=60000;service.report({stores:input,categories:[],date:DAY});
 const points=service.read().points;assert.deepEqual(points.map(point=>point.taxonomyRevision),['types-1','types-2']);assert.deepEqual(points.map(point=>point.at),[AT,AT]);assert.deepEqual(points.map(point=>point.classifiedAt),['2026-09-20T10:00:00.000Z','2026-09-20T10:01:00.000Z']);
});
