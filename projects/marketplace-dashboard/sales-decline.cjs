'use strict';

const {shift}=require('./insights-sync.cjs');
const {isInactive}=require('./dist/dashboard-model.js');
const within=(date,period)=>date>=period.from&&date<=period.to;
const covers=(ledger,period)=>ledger?.period?.from<=period.from&&ledger?.period?.to>=period.to;
const money=cents=>cents/100;
const formatMoney=cents=>money(cents).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽';
function validPeriod(period){
 return !!period&&['from','to'].every(key=>typeof period[key]==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(period[key])&&Number.isFinite(Date.parse(period[key]))&&shift(period[key],0)===period[key])&&period.from<=period.to;
}
function catalogFor(products){
 const catalog=new Map();
 for(const [index,product]of products.entries()){
  // A catalog key joins aliases only within this store. Missing keys use object identity.
  const identity=product.key?String(product.key):'catalog-index:'+index;
  for(const sku of new Set([product.sku,...(product.skus||[])].filter(value=>value!==undefined&&value!==null&&String(value)!=='').map(String))){
   const existing=catalog.get(sku);
   if(!existing)catalog.set(sku,{identity,product,ambiguous:false});
   else if(existing.identity!==identity)existing.ambiguous=true;
  }
 }
 return catalog;
}
function bucket(){return {realized:0,reversal:0,ads:0,hasAds:false}}
function analyze(stores,current,previous,{now=new Date(),hideInactive=true}={}){
 if(!validPeriod(current)||!validPeriod(previous))throw Error('Проверьте даты сравнения реализации');
 if(current.to>=previous.from&&previous.to>=current.from)throw Error('Периоды сравнения не должны пересекаться');
 current={...current};previous={...previous};
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const notes=['Сравнивается сумма финансовой реализации с учётом возвратов и сторно в рублях. Это не количество заказов или проданных единиц.','Сигналы помогают проверить гипотезы; сами по себе они не доказывают причину снижения.'];
 let reason='Сравнение финансовой реализации за два полных периода.';
 if(within(today,current)){
  current={from:shift(today,-7),to:shift(today,-1)};
  previous={from:shift(today,-14),to:shift(today,-8)};
  reason='Выбранный период включает сегодня: сравниваются последние 7 полных дней с предыдущими 7 по московскому времени.';
  notes.push(reason+' Незавершённый сегодняшний день исключён.');
 }
 const rows=[],excludedStores=[];
 for(const store of stores){
  const ledger=store.ledger;
  let exclusion=null;
  if(current.to>=today||previous.to>=today)exclusion='Периоды содержат незавершённые или будущие дни.';
  else if(!ledger?.complete)exclusion='Финансовые данные отсутствуют или загружены не полностью.';
  else if(ledger.foreignRecords)exclusion='В финансовой загрузке есть операции в другой валюте.';
  else if(!covers(ledger,current)||!covers(ledger,previous))exclusion='Нет полного покрытия обоих периодов финансовыми данными.';
  else if(!Array.isArray(ledger.skuDaily))exclusion='Нет финансовой детализации по SKU.';
  if(exclusion){excludedStores.push({id:store.id,storeId:store.id,name:store.name,storeName:store.name,reason:exclusion});continue}
  const catalog=catalogFor(store.products||[]),groups=new Map();
  // Read the union of both periods, including products with no current sales.
  for(const day of ledger.skuDaily){
   const period=within(day.date,current)?'current':within(day.date,previous)?'previous':null;
   if(!period||day.sku===undefined||day.sku===null)continue;
   const sku=String(day.sku),entry=catalog.get(sku),product=entry&&!entry.ambiguous?entry.product:null;
   if(product&&hideInactive&&isInactive(product))continue;
   const groupKey=product?'product:'+entry.identity:'sku:'+sku;
   if(!groups.has(groupKey))groups.set(groupKey,{sku,product,ambiguous:!!entry?.ambiguous,current:bucket(),previous:bucket()});
   const target=groups.get(groupKey)[period],values=day.values||{};
   target.realized+=values.realized||0;target.reversal+=values.reversal||0;
   if(Object.hasOwn(values,'ads')){target.ads+=values.ads;target.hasAds=true}
  }
  for(const [groupKey,group]of groups){
   const c=group.current,p=group.previous,product=group.product;
   if(p.realized<=0||c.realized>=p.realized)continue;
   const quantity=Number.isFinite(product?.quantity)?product.quantity:null,signals=[];
   if(quantity===0)signals.push({code:'stock_zero',title:'Сейчас нулевой остаток',evidence:'Текущий остаток: 0 шт. Истории остатков за периоды нет; прошлое отсутствие товара не подтверждено.',action:'Проверьте историю доступности и даты пополнения товара.'});
   if(c.reversal>p.reversal)signals.push({code:'returns_up',title:'Выросли возвраты и сторно реализации',evidence:'Возвраты и сторно: '+formatMoney(p.reversal)+' → '+formatMoney(c.reversal)+'. Их рост на '+formatMoney(c.reversal-p.reversal)+' уменьшает финансовую реализацию, но не доказывает падение спроса.',action:'Проверьте операции возвратов, сторно и даты исходных продаж.'});
   if(product&&c.hasAds&&p.hasAds&&p.ads<0&&c.ads>p.ads)signals.push({code:'ads_down',title:'Снизились рекламные начисления по SKU',evidence:'Расходы по привязанным к товару рекламным начислениям: '+formatMoney(-p.ads)+' → '+formatMoney(-c.ads)+'. Начисления не подтверждают даты показов или остановку кампании.',action:'Сверьте рекламный кабинет: показы, клики, расходы и даты работы кампаний.'});
   if(!product)signals.push({code:group.ambiguous?'catalog_ambiguous':'catalog_missing',title:group.ambiguous?'Неоднозначная привязка SKU':'Нет карточки в текущем каталоге',evidence:group.ambiguous?'SKU связан с несколькими карточками. Остаток и реклама карточки не приписаны этому SKU.':'Историческая реализация сохранена по SKU; текущие данные карточки недоступны.',action:'Проверьте соответствие SKU карточке товара.'});
   signals.push({code:'unverified',title:'Причина снижения не подтверждена',evidence:'Нет сопоставимой истории цены, трафика, конверсии и наличия по товару. Финансовые начисления могут относиться к продажам других дат.',action:'Сравните цену, показы, посещения, конверсию, доступность и сроки доставки за оба периода.'});
   rows.push({id:JSON.stringify([store.id,groupKey]),storeId:store.id,storeName:store.name,key:product?.key||null,sku:group.sku,name:product?.name||'SKU '+group.sku,offer_id:product?.offer_id||'',current:money(c.realized),previous:money(p.realized),drop:money(p.realized-c.realized),dropPercent:(p.realized-c.realized)/p.realized*100,quantity,signals,adsCurrent:c.hasAds?money(-c.ads):null,adsPrevious:p.hasAds?money(-p.ads):null,returnsCurrent:money(c.reversal),returnsPrevious:money(p.reversal)});
  }
 }
 rows.sort((a,b)=>b.drop-a.drop||a.id.localeCompare(b.id));
 if(excludedStores.length)notes.push('Магазины без полного сопоставимого покрытия исключены; отсутствие данных не заменяется нулевыми продажами.');
 const status=stores.length>excludedStores.length?'ready':'unavailable';
 if(status==='unavailable')reason='Нет магазинов с полными сопоставимыми финансовыми данными за оба периода.';
 return {status,reason,current,previous,rows,excludedStores,notes};
}
module.exports={analyze};
