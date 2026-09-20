'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Readable}=require('node:stream');
const factory=require('../workspace-tools.cjs');
function temporary(){return fs.mkdtempSync(path.join(os.tmpdir(),'pult-workspace-test-'));}
function remove(dir){const full=path.resolve(dir),base=path.resolve(os.tmpdir());assert.ok(full.startsWith(base+path.sep)&&path.basename(full).startsWith('pult-workspace-test-'));fs.rmSync(full,{recursive:true,force:true});}
async function call(app,method,route,data,chunks){const req=Readable.from(chunks||[JSON.stringify(data??{})]);req.method=method;const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(value){this.value=JSON.parse(value);}};const handled=await app.handle(req,res,new URL(route,'http://127.0.0.1'));return {handled,status:res.status,value:res.value};}

test('ideas API persists title, description and transitions, retaining exactly one seed across reopening',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-20T10:00:00.000Z')});
 const dir=temporary();try{
  let app=factory({privateDir:dir});let state=(await call(app,'GET','/api/ideas')).value;
  assert.equal(state.ideas.length,1);assert.equal(state.ideas[0].status,'deferred');assert.equal(state.ideas[0].direction,'Закупки');
  const seed=structuredClone(state.ideas[0]);
  const requestId='46dfc9a4-27f2-4fab-bda8-2a1778eaeed2';
  const input={version:state.version,title:'Учебная мысль',clientRequestId:requestId};
  const bytes=Buffer.from(JSON.stringify(input)),letter=bytes.indexOf(Buffer.from('У'));
  const created=await call(app,'POST','/api/ideas/create',null,[bytes.subarray(0,letter+1),bytes.subarray(letter+1)]);
  assert.equal(created.status,200);state=created.value;
  assert.equal(state.ideas.length,2);
  const idea=state.ideas.find(x=>x.id!==seed.id);assert.ok(idea);
  assert.equal(idea.title,'Учебная мысль');assert.equal(idea.createdAt,seed.createdAt);
  const id=idea.id;
  const retried=await call(app,'POST','/api/ideas/create',input);
  assert.equal(retried.status,200);assert.deepEqual(retried.value,state);
  const activated=await call(app,'POST','/api/ideas/update',{version:state.version,id,description:'Уточнение',status:'active'});
  assert.equal(activated.status,200);state=activated.value;assert.equal(state.ideas.find(x=>x.id===id).status,'active');
  assert.equal((await call(app,'POST','/api/ideas/update',{version:0,id,status:'done'})).status,409);
  const completed=await call(app,'POST','/api/ideas/update',{version:state.version,id,status:'done'});
  assert.equal(completed.status,200);state=completed.value;assert.equal(state.ideas.find(x=>x.id===id).status,'done');
  app=factory({privateDir:dir});state=(await call(app,'GET','/api/ideas')).value;
  assert.equal(state.ideas.length,2);assert.equal(state.ideas.find(x=>x.id===id).status,'done');assert.equal(state.ideas.find(x=>x.id===id).description,'Уточнение');
  assert.deepEqual(state.ideas.find(x=>x.id===seed.id),seed);
 }finally{remove(dir);}
});

test('workspace routes reject malformed and oversized requests without persisting data',async()=>{
 const dir=temporary();try{const app=factory({privateDir:dir});
  assert.equal((await call(app,'POST','/api/ideas/create',null,['{bad'])).status,400);
  assert.equal((await call(app,'POST','/api/ideas/create',null,['x'.repeat(1500001)])).status,413);
  assert.equal((await call(app,'PUT','/api/ideas',{})).status,405);
  assert.equal((await call(app,'GET','/api/unrelated')).handled,false);
  assert.equal((await call(app,'GET','/api/ideas')).value.ideas.length,1);
 }finally{remove(dir);}
});

test('procurement API parses, stores, imports and compares with an identified source after reload',async()=>{
 const dir=temporary();try{let app=factory({privateDir:dir});
  let state=(await call(app,'GET','/api/procurement')).value;
  const parsed=await call(app,'POST','/api/procurement/parse',{text:'Артикул;Наименование;Количество;Единица\nTEST-BOLT;Учебный болт;5;шт'});assert.equal(parsed.status,200);
  state=(await call(app,'POST','/api/procurement/request',{version:state.version,title:'Учебная заявка',items:parsed.value.items})).value;const id=state.requests[0].id;
  const saved=await call(app,'POST','/api/procurement/import',{version:state.version,supplierName:'Учебный поставщик',sourceName:'test.csv',currency:'RUB',vatBasis:'included',text:'Артикул;Наименование;Цена;Остаток;Единица\nTEST-BOLT;Учебный болт;12,50;20;шт'});assert.equal(saved.status,200);
  app=factory({privateDir:dir});const compared=await call(app,'GET','/api/procurement/compare?id='+encodeURIComponent(id));assert.equal(compared.status,200);assert.equal(compared.value.items.length,1);
  const offer=compared.value.items[0].offers[0];assert.ok(offer);assert.equal(offer.price,12.5);assert.match(JSON.stringify(offer),/test.csv/);assert.match(JSON.stringify(offer),/Учебный поставщик/);
 }finally{remove(dir);}
});

test('reported dotted-article example matches imported CSV by SKU and reconciles to 650 RUB',async()=>{
 const dir=temporary();try{
  let app=factory({privateDir:dir});
  const parsed=await call(app,'POST','/api/procurement/parse',{text:'Тестовый кабель, арт. TC-A-137352, 2 шт\nТестовый выключатель, арт. TC-B-137352, 3 шт'});
  assert.equal(parsed.status,200);
  assert.deepEqual(parsed.value.items.map(x=>[x.name,x.article,x.quantity,x.unit]),[
   ['Тестовый кабель','TC-A-137352',2,'шт'],['Тестовый выключатель','TC-B-137352',3,'шт']
  ]);
  let state=(await call(app,'GET','/api/procurement')).value;
  const saved=await call(app,'POST','/api/procurement/request',{version:state.version,title:'Синтетическая проверка артикула',items:parsed.value.items});
  assert.equal(saved.status,200);state=saved.value;
  const id=state.id;
  const imported=await call(app,'POST','/api/procurement/import',{
   version:state.version,supplierName:'Синтетический поставщик',sourceName:'fixture.csv',currency:'RUB',
   text:'артикул;наименование;цена;остаток;ед.изм.;НДС\nTC-A-137352;Кабель из прайса;100;2;шт;с НДС\nTC-B-137352;Выключатель из прайса;150;3;шт;с НДС'
  });
  assert.equal(imported.status,200);
  app=factory({privateDir:dir});
  const compared=await call(app,'GET','/api/procurement/compare?id='+encodeURIComponent(id));
  assert.equal(compared.status,200);
  const items=compared.value.items;assert.equal(items.length,2);
  for(const item of items){
   assert.equal(item.offers.length,1);const offer=item.offers[0];
   assert.equal(offer.match,'article');assert.equal(offer.article,item.article);
   assert.equal(offer.comparable,true);assert.equal(offer.currency,'RUB');
   assert.equal(offer.unit,item.unit);assert.equal(offer.vatBasis,'included');
   assert.equal(offer.stock,item.quantity);assert.equal(offer.source.sourceName,'fixture.csv');
  }
  assert.deepEqual(items.map(x=>x.offers[0].price),[100,150]);
  assert.deepEqual(items.map(x=>x.offers[0].source.row),[2,3]);
  // Reconcile actual API values, not a UI total: the product has no order-total feature.
  const lineMinor=items.map(x=>x.quantity*Math.round(x.offers[0].price*100));
  assert.deepEqual(lineMinor,[20000,45000]);
  assert.equal(lineMinor.reduce((sum,value)=>sum+value,0),65000);
 }finally{remove(dir);}
});
