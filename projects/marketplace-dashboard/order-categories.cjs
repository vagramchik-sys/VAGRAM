'use strict';
const fs=require('node:fs'),path=require('node:path');
const UNMATCHED='Не сопоставлено';
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
function productIndex(stores,categories){
 const manual=manualIndex(categories),byStore=new Map();
 for(const store of stores){const map=new Map(),tree=treeIndex(store.categoryTree),market=store.market;
  for(const product of Array.isArray(store.products)?store.products:[]){
   const key=store.id+':'+String(product.product_id),explicit=manual.get(key);let category=explicit;
   if(!category&&market==='Ozon')category=canonicalCategory('Ozon',tree.types.get(String(product.type_id))||tree.descriptions.get(String(product.description_category_id))||[]);
   if(!category&&market==='WB')category=canonicalCategory('WB',[product.category,product.subjectName]);
   for(const alias of [product.sku,product.product_id,product.nmID])if(alias!==null&&alias!==undefined&&String(alias))map.set(String(alias),category||UNMATCHED);
  }byStore.set(store.id,map);
 }return byStore;
}
function ozonTotals(stores,index,targetDay){
 const totals=new Map();let at=0;
 for(const store of stores.filter(s=>s.market==='Ozon')){
  const orders=store.orders;if(orders?.skuDailyCoverage!==true||!Array.isArray(orders.skuDaily)||!orders.skuUpdatedAt)return {complete:false,reason:'Ozon: детализация заказов по SKU ещё не получена для всех магазинов.'};
  const stamp=Date.parse(orders.skuUpdatedAt);if(!Number.isFinite(stamp)||day(stamp)!==targetDay)return {complete:false,reason:'Ozon: нет свежего полного снимка категорий за выбранный день.'};at=Math.max(at,stamp);
  const map=index.get(store.id)||new Map();
  for(const row of orders.skuDaily.filter(row=>row.date===targetDay)){
   if(!Number.isFinite(row.revenue)||!Number.isSafeInteger(row.units)||row.units<0)return {complete:false,reason:'Ozon: в детализации заказов нет сопоставимой суммы или количества.'};
   const category=map.get(String(row.sku))||UNMATCHED,current=totals.get(category)||{orderedRevenue:0,orderedUnits:0};current.orderedRevenue=Math.round((current.orderedRevenue+row.revenue)*100)/100;current.orderedUnits+=row.units;totals.set(category,current);
  }
 }
 return {complete:true,at,totals};
}
function wbSeries(stores,index,targetDay){
 const events=[];for(const store of stores.filter(s=>s.market==='WB')){
  const state=store.orders;if(state?.complete!==true||state.day!==targetDay||!Array.isArray(state.orders))return {complete:false,reason:'WB: нет полного снимка заказов с категориями за выбранный день.',series:[]};
  const map=index.get(store.id)||new Map();
  for(const row of state.orders){const at=Date.parse(row.at),amount=Number(row.amount);if(!Number.isFinite(at)||day(at)!==targetDay||!Number.isFinite(amount)||amount<0)return {complete:false,reason:'WB: в заказах нет сопоставимой суммы или времени.',series:[]};events.push({at,amount,category:map.get(String(row.nmId))||canonicalCategory('WB',[row.category,row.subject])})}
 }
 const categories=new Set(events.map(e=>e.category)),series=[];
 for(const category of categories){let orderedRevenue=0,orderedUnits=0;const points=[];for(const event of events.filter(e=>e.category===category).sort((a,b)=>a.at-b.at)){orderedRevenue=Math.round((orderedRevenue+event.amount)*100)/100;orderedUnits++;const last=points.at(-1);if(last?.time===event.at)Object.assign(last,{orderedRevenue,orderedUnits});else points.push({time:event.at,at:new Date(event.at).toISOString(),orderedRevenue,orderedUnits})}series.push({category,market:'WB',amountBasis:'priceWithDisc',timeBasis:'Время создания заказа WB',points:points.map(({time,...p})=>p)})}
 return {complete:true,series};
}
function create({privateDir}){
 const file=path.join(privateDir,'order-category-intraday.json');
 const read=()=>{try{const value=JSON.parse(fs.readFileSync(file,'utf8'));if(!value||typeof value!=='object'||!Array.isArray(value.points))throw Error('История категорий Ozon повреждена. Восстановите последний исправный файл.');return value}catch(error){if(error?.code==='ENOENT')return {version:1,points:[]};if(error instanceof SyntaxError)throw Error('История категорий Ozon повреждена. Восстановите последний исправный файл.');throw error}};
 function write(value){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file)}
 function captureOzon(stores,categories,targetDay=day(Date.now()),index=productIndex(stores,categories)){const value=ozonTotals(stores,index,targetDay);if(!value.complete)return value;const state=read(),at=new Date(value.at).toISOString();if(!state.points.some(p=>p.date===targetDay&&p.at===at)){state.points.push({date:targetDay,at,values:Object.fromEntries(value.totals)});state.points=state.points.filter(p=>value.at-Date.parse(p.at)<=32*86400000).sort((a,b)=>a.at.localeCompare(b.at));write(state)}return value}
 function report({stores,categories,date:targetDay=day(Date.now())}){
   const index=productIndex(stores,categories),ozon=captureOzon(stores,categories,targetDay,index),state=read(),ozonNames=new Set();
   const points=state.points.filter(p=>p.date===targetDay).map(point=>{if(!point||typeof point!=='object'||typeof point.at!=='string'||!point.values||typeof point.values!=='object'||Array.isArray(point.values))throw Error('История категорий Ozon содержит неполную точку.');const values={};for(const [name,value] of Object.entries(point.values)){if(!value||!Number.isFinite(value.orderedRevenue)||!Number.isSafeInteger(value.orderedUnits)||value.orderedUnits<0)throw Error('История категорий Ozon содержит неполные суммы или количество.');const category=canonicalCategory('Ozon',[name]),current=values[category]||{orderedRevenue:0,orderedUnits:0};current.orderedRevenue=Math.round((current.orderedRevenue+value.orderedRevenue)*100)/100;current.orderedUnits+=value.orderedUnits;values[category]=current;ozonNames.add(category)}return {...point,values}});
  const series=[...ozonNames].map(category=>({category,market:'Ozon',amountBasis:'revenue',timeBasis:'Время снимка аналитики Ozon',points:points.filter(p=>Object.hasOwn(p.values,category)).map(p=>({at:p.at,...p.values[category]}))}));
  const wb=wbSeries(stores,index,targetDay);series.push(...wb.series);
  const names=[...new Set(series.map(s=>s.category))].sort((a,b)=>a===UNMATCHED?1:b===UNMATCHED?-1:a.localeCompare(b,'ru'));
  return {date:targetDay,categories:names,series,coverage:{Ozon:ozon.complete,WB:wb.complete},limitations:[!ozon.complete?ozon.reason:'',!wb.complete?wb.reason:'','Суммы площадок показаны отдельными линиями: Ozon revenue и WB priceWithDisc не складываются.','История Ozon начинается с первого SKU-снимка; прежние общие точки по категориям не восстанавливаются.'].filter(Boolean)};
 }
 return {report,captureOzon,read};
}
module.exports={create,broadCategory,canonicalCategory,treeIndex,productIndex,ozonTotals,wbSeries,UNMATCHED,day};

