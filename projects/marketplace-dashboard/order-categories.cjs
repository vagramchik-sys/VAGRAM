'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const UNMATCHED='Не сопоставлено';
const UNMATCHED_ID='unmatched';
const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const clean=value=>typeof value==='string'?value.trim().replace(/\s+/g,' '):'';
const REVIEWED_ALIASES={
 Ozon:new Map(Object.entries({
  'Алюминиевая лента':'Алюминиевая лента','Емкость строительная':'Емкость строительная','Заглушка декоративная':'Заглушка декоративная','Клейкая лента канцелярская':'Клейкие ленты','Коробка для хранения':'Коробка для хранения','Краги сварщика':'Перчатки','Крепёж':'Крепёж','Круг отрезной':'Круг отрезной','Лопата':'Лопата','Малярная лента':'Клейкие ленты','Малярный стеклохолст':'Малярный стеклохолст','Мешки для мусора':'Мешки для мусора','Монтажная лента':'Клейкие ленты','Не сопоставлено':'Не сопоставлено','Перчатки':'Перчатки','Сварочные электроды':'Сварочные электроды','Светоотражающий жилет':'Светоотражающий жилет','Сетка строительная':'Сетки строительные','Силовой кабель':'Силовой кабель','Талреп':'Крепёж','Тенты':'Тенты','Термоэтикетки':'Термоэтикетки','Укрывной материал для ремонта':'Укрывной материал для ремонта','Упаковочная пленка':'Упаковочная пленка'
 })),
 WB:new Map(Object.entries({
  'Болты':'Крепёж','Гвозди':'Крепёж','Диски для УШМ':'Диски для УШМ','Дюбели':'Крепёж','Клейкие ленты':'Клейкие ленты','Мешки строительные':'Мешки строительные','Перчатки рабочие':'Перчатки','Саморезы кровельные':'Крепёж','Саморезы по дереву':'Крепёж','Саморезы универсальные':'Крепёж','Сетки строительные':'Сетки строительные','Средства от грызунов':'Средства от грызунов','Тенты универсальные':'Тенты','Уголки крепежные':'Крепёж','Шайбы крепежные':'Крепёж'
 }))
};
function broadCategory(labels){
 const values=labels.map(clean).filter(Boolean),text=values.join(' ').toLocaleLowerCase('ru-RU');
 if(/саморез|шуруп|болт|гайк|шайб|шпильк|дюбел|анкер|гвозд|креп[её]ж/.test(text))return 'Крепёж';
 if(/перчат/.test(text))return 'Перчатки';
 if(/тент|брезент/.test(text))return 'Тенты';
 if(/термо.?этик|этикетк/.test(text))return 'Термоэтикетки';
 return values.at(-1)||UNMATCHED;
}
function canonicalCategory(market,labels){
 const values=labels.map(clean).filter(Boolean),aliases=REVIEWED_ALIASES[market];
 if(aliases)for(let index=values.length-1;index>=0;index--)if(aliases.has(values[index]))return aliases.get(values[index]);
 return broadCategory(values);
}
function treeIndex(tree){
 const descriptions=new Map(),types=new Map();
 function visit(nodes,path=[]){for(const node of Array.isArray(nodes)?nodes:[]){
  const category=clean(node.category_name),next=category?[...path,category]:path;
  if(Number.isSafeInteger(Number(node.description_category_id))&&Number(node.description_category_id)>0)descriptions.set(String(node.description_category_id),next);
  if(Number.isSafeInteger(Number(node.type_id))&&Number(node.type_id)>0)types.set(String(node.type_id),[...next,clean(node.type_name)].filter(Boolean));
  visit(node.children,next);
 }}
 visit(tree);return {descriptions,types};
}
function manualIndex(categories){const out=new Map();for(const category of Array.isArray(categories)?categories:[])for(const key of Array.isArray(category.productKeys)?category.productKeys:[])if(typeof key==='string'&&clean(category.name))out.set(key,clean(category.name));return out}
function stableProductId(product){for(const value of [product?.product_id,product?.nmID])if(value!==null&&value!==undefined&&String(value).trim())return String(value);return ''}
function stableProductKey(storeId,product){const id=stableProductId(product);return id?storeId+':'+id:''}
function productIndex(stores,categories){
 const manual=manualIndex(categories),byStore=new Map();
 for(const store of stores){const map=new Map(),tree=treeIndex(store.categoryTree),market=store.market;
  for(const product of Array.isArray(store.products)?store.products:[]){
   const key=stableProductKey(store.id,product),explicit=key?manual.get(key):undefined;let category=explicit;
   if(!category&&market==='Ozon')category=canonicalCategory('Ozon',tree.types.get(String(product.type_id))||tree.descriptions.get(String(product.description_category_id))||[]);
   if(!category&&market==='WB')category=canonicalCategory('WB',[product.category,product.subjectName]);
   for(const alias of [product.sku,product.product_id,product.nmID])if(alias!==null&&alias!==undefined&&String(alias))map.set(String(alias),category||UNMATCHED);
  }byStore.set(store.id,map);
 }return byStore;
}
function manualTypeId(name){return 'manual-'+crypto.createHash('sha256').update(name).digest('hex').slice(0,12)}
function hierarchyIndex(stores,categories,registry){
 const manual=manualIndex(categories),types=registry.types.map(type=>({...type})),byName=new Map(types.map(type=>[clean(type.name).toLocaleLowerCase('ru-RU'),type.id])),known=new Set(types.map(type=>type.id)),byStore=new Map();
 if(!known.has(UNMATCHED_ID)){types.push({id:UNMATCHED_ID,parentId:null,name:UNMATCHED});known.add(UNMATCHED_ID)}
 for(const store of stores){const map=new Map();
  for(const product of Array.isArray(store.products)?store.products:[]){
   const productKey=stableProductKey(store.id,product),manualName=productKey?manual.get(productKey):undefined;let typeId;
   if(manualName){typeId=byName.get(clean(manualName).toLocaleLowerCase('ru-RU'));if(!typeId){typeId=manualTypeId(manualName);if(!known.has(typeId)){types.push({id:typeId,parentId:null,name:manualName,manual:true});known.add(typeId)}}}
   if(!typeId)typeId=(productKey?require('./product-type-registry.cjs').classify(registry,productKey,product):null)?.typeId||UNMATCHED_ID;
   for(const alias of [product.sku,product.product_id,product.nmID])if(alias!==null&&alias!==undefined&&String(alias))map.set(String(alias),typeId);
  }byStore.set(store.id,map);
 }
 return {active:true,revision:registry.revision,types,byStore};
}
function ozonTotals(stores,index,targetDay,{fallback=UNMATCHED}={}){
 const totals=new Map();let at=0;
 for(const store of stores.filter(s=>s.market==='Ozon')){
  const orders=store.orders;if(orders?.skuDailyCoverage!==true||!Array.isArray(orders.skuDaily)||!orders.skuUpdatedAt)return {complete:false,reason:'Ozon: детализация заказов по SKU ещё не получена для всех магазинов.'};
  const stamp=Date.parse(orders.skuUpdatedAt);if(!Number.isFinite(stamp)||day(stamp)!==targetDay)return {complete:false,reason:'Ozon: нет свежего полного снимка категорий за выбранный день.'};at=Math.max(at,stamp);
  const map=index.get(store.id)||new Map();
  for(const row of orders.skuDaily.filter(row=>row.date===targetDay)){
   if(!Number.isFinite(row.revenue)||!Number.isSafeInteger(row.units)||row.units<0)return {complete:false,reason:'Ozon: в детализации заказов нет сопоставимой суммы или количества.'};
   const category=map.get(String(row.sku))||fallback,current=totals.get(category)||{orderedRevenue:0,orderedUnits:0};current.orderedRevenue=Math.round((current.orderedRevenue+row.revenue)*100)/100;current.orderedUnits+=row.units;totals.set(category,current);
  }
 }
 return {complete:true,at,totals};
}
function wbSeries(stores,index,targetDay,{fallback=true}={}){
 const events=[];for(const store of stores.filter(s=>s.market==='WB')){
  const state=store.orders;if(state?.complete!==true||state.day!==targetDay||!Array.isArray(state.orders))return {complete:false,reason:'WB: нет полного снимка заказов с категориями за выбранный день.',series:[]};
  const map=index.get(store.id)||new Map();
   for(const row of state.orders){const at=Date.parse(row.at),amount=Number(row.amount);if(!Number.isFinite(at)||day(at)!==targetDay||!Number.isFinite(amount)||amount<0)return {complete:false,reason:'WB: в заказах нет сопоставимой суммы или времени.',series:[]};events.push({at,amount,category:map.get(String(row.nmId))||(fallback?canonicalCategory('WB',[row.category,row.subject]):UNMATCHED_ID)})}
 }
 const categories=new Set(events.map(e=>e.category)),series=[];
  for(const category of categories){let orderedRevenue=0,orderedUnits=0;const points=[];for(const event of events.filter(e=>e.category===category).sort((a,b)=>a.at-b.at)){orderedRevenue=Math.round((orderedRevenue+event.amount)*100)/100;orderedUnits++;const last=points.at(-1);if(last?.time===event.at)Object.assign(last,{orderedRevenue,orderedUnits});else points.push({time:event.at,at:new Date(event.at).toISOString(),orderedRevenue,orderedUnits})}series.push({category,typeId:category,market:'WB',amountBasis:'priceWithDisc',timeBasis:'Время создания заказа WB',points:points.map(({time,...p})=>p)})}
 return {complete:true,series};
}
function descendants(types,parentId){const children=new Map();for(const type of types){const list=children.get(type.parentId)||[];list.push(type.id);children.set(type.parentId,list)}const out=[];function visit(id){const next=children.get(id)||[];if(!next.length){out.push(id);return}for(const child of next)visit(child)}visit(parentId);return out}
function sumSeries(items,type,market){
 const times=[...new Set(items.flatMap(item=>item.points.map(point=>Date.parse(point.at))).filter(Number.isFinite))].sort((a,b)=>a-b),points=[];
 for(const at of times){let orderedRevenue=0,orderedUnits=0,observed=false;for(const item of items){const point=item.points.filter(row=>Date.parse(row.at)<=at).at(-1);if(point){observed=true;orderedRevenue+=point.orderedRevenue;orderedUnits+=point.orderedUnits}}if(observed)points.push({at:new Date(at).toISOString(),orderedRevenue:Math.round(orderedRevenue*100)/100,orderedUnits})}
 return {category:type.name,typeId:type.id,market,aggregate:true,leafCount:items.length,amountBasis:market==='Ozon'?'revenue':'priceWithDisc',timeBasis:market==='Ozon'?'Время снимка аналитики Ozon':'Время создания заказа WB',points};
}
function withParents(series,types){
 const parents=new Set(types.map(type=>type.parentId).filter(Boolean)),out=[...series];
 for(const id of parents){const type=types.find(item=>item.id===id),leaves=new Set(descendants(types,id));for(const market of ['Ozon','WB']){const items=series.filter(item=>item.market===market&&leaves.has(item.typeId));if(items.length)out.push(sumSeries(items,type,market))}}
 return out;
}
function create({privateDir,productTypes,now=()=>Date.now()}){
 const file=path.join(privateDir,'order-category-intraday.json');
 const read=()=>{try{const value=JSON.parse(fs.readFileSync(file,'utf8'));if(!value||typeof value!=='object'||!Array.isArray(value.points))throw Error('История категорий Ozon повреждена. Восстановите последний исправный файл.');return value}catch(error){if(error?.code==='ENOENT')return {version:1,points:[]};if(error instanceof SyntaxError)throw Error('История категорий Ozon повреждена. Восстановите последний исправный файл.');throw error}};
 function write(value){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file)}
 function classification(stores,categories){const registry=productTypes?.read?.();return registry?.available?hierarchyIndex(stores,categories,registry):{active:false,revision:'legacy',types:[],byStore:productIndex(stores,categories)}}
 function captureOzon(stores,categories,targetDay=day(now()),current=classification(stores,categories)){const value=ozonTotals(stores,current.byStore,targetDay,{fallback:current.active?UNMATCHED_ID:UNMATCHED});if(!value.complete)return value;const state=read(),at=new Date(value.at).toISOString(),same=point=>point.date===targetDay&&point.at===at&&(current.active?point.taxonomyRevision===current.revision:!point.taxonomyRevision);if(!state.points.some(same)){const point={date:targetDay,at,values:Object.fromEntries(value.totals)};if(current.active)Object.assign(point,{taxonomyRevision:current.revision,classifiedAt:new Date(now()).toISOString(),types:current.types.map(type=>({id:type.id,parentId:type.parentId,name:type.name}))});state.version=current.active?2:state.version||1;state.points.push(point);state.points=state.points.sort((a,b)=>a.at.localeCompare(b.at));write(state)}return value}
 function report({stores,categories,date:targetDay=day(Date.now())}){
   const current=classification(stores,categories),ozon=captureOzon(stores,categories,targetDay,current),state=read(),ozonNames=new Set();
   if(current.active){
    const legacy=state.points.filter(point=>point.date===targetDay&&point.taxonomyRevision!==current.revision),active=state.points.filter(point=>point.date===targetDay&&point.taxonomyRevision===current.revision),typeById=new Map(current.types.map(type=>[type.id,type]));
    const points=active.map(point=>{if(!point.values||typeof point.values!=='object')throw Error('История категорий Ozon содержит неполную точку.');const values={};for(const [typeId,value] of Object.entries(point.values)){if(!typeById.has(typeId)||!value||!Number.isFinite(value.orderedRevenue)||!Number.isSafeInteger(value.orderedUnits)||value.orderedUnits<0)throw Error('История категорий Ozon содержит неполные суммы, количество или тип.');values[typeId]=value;ozonNames.add(typeId)}return {...point,values}});
    let series=[...ozonNames].map(typeId=>({category:typeById.get(typeId).name,typeId,market:'Ozon',amountBasis:'revenue',timeBasis:'Время снимка аналитики Ozon',points:points.map(point=>({at:point.at,...(point.values[typeId]||{orderedRevenue:0,orderedUnits:0})}))}));
    const wb=wbSeries(stores,current.byStore,targetDay,{fallback:false});series.push(...wb.series.map(item=>({...item,category:typeById.get(item.typeId)?.name||UNMATCHED})));series=withParents(series,current.types);
    const boundary=active.length?{taxonomyRevision:current.revision,classifiedAt:active.map(point=>point.classifiedAt).filter(Boolean).sort()[0]||null,sourceAt:active.map(point=>point.at).sort()[0],legacyPoints:legacy.length}:null;
    return {date:targetDay,categories:current.types.map(type=>type.name),types:current.types.map(type=>({...type,leaf:!current.types.some(child=>child.parentId===type.id)})),taxonomyRevision:current.revision,taxonomyBoundary:boundary,series,coverage:{Ozon:ozon.complete,WB:wb.complete},limitations:[!ozon.complete?ozon.reason:'',!wb.complete?wb.reason:'',legacy.length?'Новая классификация действует только для новых точек; '+legacy.length+' прежних точек сохранены и не включены в текущие агрегаты.':'','Суммы площадок показаны отдельными линиями: Ozon revenue и WB priceWithDisc не складываются.'].filter(Boolean)};
   }
   const index=current.byStore;
   const points=state.points.filter(p=>p.date===targetDay).map(point=>{if(!point||typeof point!=='object'||typeof point.at!=='string'||!point.values||typeof point.values!=='object'||Array.isArray(point.values))throw Error('История категорий Ozon содержит неполную точку.');const values={};for(const [name,value] of Object.entries(point.values)){if(!value||!Number.isFinite(value.orderedRevenue)||!Number.isSafeInteger(value.orderedUnits)||value.orderedUnits<0)throw Error('История категорий Ozon содержит неполные суммы или количество.');const category=canonicalCategory('Ozon',[name]),current=values[category]||{orderedRevenue:0,orderedUnits:0};current.orderedRevenue=Math.round((current.orderedRevenue+value.orderedRevenue)*100)/100;current.orderedUnits+=value.orderedUnits;values[category]=current;ozonNames.add(category)}return {...point,values}});
  const series=[...ozonNames].map(category=>({category,market:'Ozon',amountBasis:'revenue',timeBasis:'Время снимка аналитики Ozon',points:points.filter(p=>Object.hasOwn(p.values,category)).map(p=>({at:p.at,...p.values[category]}))}));
  const wb=wbSeries(stores,index,targetDay);series.push(...wb.series);
  const names=[...new Set(series.map(s=>s.category))].sort((a,b)=>a===UNMATCHED?1:b===UNMATCHED?-1:a.localeCompare(b,'ru'));
  return {date:targetDay,categories:names,series,coverage:{Ozon:ozon.complete,WB:wb.complete},limitations:[!ozon.complete?ozon.reason:'',!wb.complete?wb.reason:'','Суммы площадок показаны отдельными линиями: Ozon revenue и WB priceWithDisc не складываются.','История Ozon начинается с первого SKU-снимка; прежние общие точки по категориям не восстанавливаются.'].filter(Boolean)};
 }
 return {report,captureOzon,read};
}
module.exports={create,broadCategory,canonicalCategory,treeIndex,productIndex,hierarchyIndex,descendants,withParents,ozonTotals,wbSeries,UNMATCHED,UNMATCHED_ID,day};
