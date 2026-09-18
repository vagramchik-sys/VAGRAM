'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const TTL=30*60*1000,DAY=86400000,BASE='https://api.truestats.ru';
const ROUTES=new Set(['/rnp-report/v2/filter-values','/rnp-report/v2/grouped']);
const clone=value=>JSON.parse(JSON.stringify(value));
const shift=(value,n)=>new Date(Date.parse(value+'T12:00:00Z')+n*DAY).toISOString().slice(0,10);
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&shift(value,0)===value;
const today=time=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
const fail=(code,message)=>Object.assign(new Error(message),{code});
const safeText=value=>typeof value==='string'?value.replace(/[\x00-\x1f]/g,' ').slice(0,240):'';
function choosePeriods(range,todayDate){
 if(!date(range?.minDate)||!date(range?.maxDate)||range.minDate>range.maxDate)throw fail('range','TrueStats не подтвердил доступный диапазон дат.');
 const to=range.maxDate<shift(todayDate,-1)?range.maxDate:shift(todayDate,-1),available=Math.floor((Date.parse(to)-Date.parse(range.minDate))/DAY)+1;
 const days=available>=14?7:available>=12?6:0;
 if(!days)throw fail('history','Недостаточно истории: нужны хотя бы 12 завершённых дней для двух полных периодов.');
 return {current:{from:shift(to,1-days),to},previous:{from:shift(to,1-days*2),to:shift(to,-days)},days,shortened:days===6,endsBeforeYesterday:to<shift(todayDate,-1),availableRange:{from:range.minDate,to:range.maxDate}};
}
function count(value){if(value===null||value===undefined)return null;if(!Number.isSafeInteger(value)||value<0)throw fail('counts','TrueStats вернул неподдерживаемое количество событий.');return value;}
const ratio=(a,b)=>a!==null&&b!==null&&b>0?a/b*100:null;
function metrics(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw fail('schema','Не подтверждена структура периода воронки.');
 const visits=count(raw.transitions),carts=count(raw.added_to_cart),orders=count(raw.order_count);
 const cartConversionPct=ratio(carts,visits),cartToOrderPct=ratio(orders,carts);
 // Contract verified against the RNP response. Recompute from period totals;
 // never average daily percentages, and never turn a zero denominator into 0%.
 for(const [field,value]of [['added_to_cart_percent',cartConversionPct],['added_to_order_percent',cartToOrderPct]])if(raw[field]!=null&&(!Number.isFinite(raw[field])||(value!==null&&Math.abs(raw[field]-value)>.02)))throw fail('ratios','Конверсия TrueStats не совпала с отношением событий за период.');
 return {visits,carts,orders,cartConversionPct,cartToOrderPct};
}
function catalogFor(products){
 const map=new Map();
 for(const product of products){const nm=String(product.sku??product.nmId??product.product_id??'');if(!/^\d+$/.test(nm))continue;if(map.has(nm))throw fail('catalog','В локальном каталоге неоднозначный nmId. Привязка воронки остановлена.');map.set(nm,product);}
 return map;
}
function analyzeRows(items,{store,accountId,articles,products}){
 const catalog=catalogFor(products),allowed=new Map(),seen=new Set(),rows=[];
 for(const a of articles){if(a.accountId!==accountId)continue;const nm=String(a.nmId??'');if(!/^\d+$/.test(nm)||allowed.has(nm))throw fail('scope','TrueStats вернул неоднозначный список товаров кабинета.');allowed.set(nm,a);}
 for(const item of items){
  const nm=String(item.nmId??'');
  if(item.accountId!==accountId||item.marketplaceId!==0||!/^\d+$/.test(nm)||!allowed.has(nm)||seen.has(nm)||!Number.isSafeInteger(item.articleId)||item.articleId<=0)throw fail('scope','Не подтверждена однозначная привязка товаров к выбранному кабинету WB.');
  seen.add(nm);const product=catalog.get(nm);
  if(!product)continue;
  // The pinned account plus exact nmId is authoritative. A conflicting vendor
  // code is not silently assigned to a local product.
  if(item.vendorCode&&product.offer_id&&String(item.vendorCode)!==String(product.offer_id))throw fail('scope','Артикул TrueStats не совпал с локальной карточкой WB.');
  const current=metrics(item.totals),previous=metrics(item.prevTotals),declining=current.orders!==null&&previous.orders!==null&&current.orders<previous.orders;
  const lowSample=[current,previous].some(v=>v.visits===null||v.visits<100||v.carts===null||v.carts<20||v.orders===null||v.orders<10);
  const signals=[];
  if(declining){
   if(current.visits!==null&&previous.visits!==null&&current.visits<previous.visits)signals.push({code:'traffic_down',title:'Снизились переходы в карточку',previous:previous.visits,current:current.visits,unit:'events',action:'Проверьте динамику показов, поисковые позиции и работу рекламы.'});
   if(current.cartConversionPct!==null&&previous.cartConversionPct!==null&&current.cartConversionPct<previous.cartConversionPct)signals.push({code:'cart_conversion_down',title:'Снизилась конверсия в корзину',previous:previous.cartConversionPct,current:current.cartConversionPct,unit:'percent',action:'Проверьте изменения цены, содержания карточки и отзывов; эти причины пока не подтверждены.'});
   if(current.cartToOrderPct!==null&&previous.cartToOrderPct!==null&&current.cartToOrderPct<previous.cartToOrderPct)signals.push({code:'order_conversion_down',title:'Снизилось отношение заказов к корзинам',previous:previous.cartToOrderPct,current:current.cartToOrderPct,unit:'percent',action:'Проверьте стоимость и сроки доставки, наличие вариантов и итоговую цену; эти причины пока не подтверждены.'});
  }
  rows.push({id:JSON.stringify([store.id,nm]),storeId:store.id,storeName:store.name,market:'WB',sku:nm,key:product.key||store.id+':'+String(product.product_id??nm),offer_id:safeText(product.offer_id||item.vendorCode),name:safeText(product.name||item.name)||'Товар WB',current,previous,declining,drop:declining?previous.orders-current.orders:0,dropPercent:declining&&previous.orders>0?(previous.orders-current.orders)/previous.orders*100:null,lowSample,signals,comparisonComplete:[current,previous].every(v=>v.visits!==null&&v.carts!==null&&v.orders!==null),hypothesisNote:'Изменения трафика и конверсии — наблюдаемые сигналы. Цена, карточка, реклама и доставка требуют отдельной проверки; причина падения не доказана.'});
 }
 rows.sort((a,b)=>b.drop-a.drop||a.name.localeCompare(b.name,'ru'));
 return {rows,coverage:{tracked:items.length,mapped:rows.length,catalog:products.length,unmapped:items.length-rows.length,declining:rows.filter(r=>r.declining).length,comparable:rows.filter(r=>r.comparisonComplete).length}};
}
function analyzeOzon(snapshot,{store,products,day,status='ready'}){
 if(snapshot?.storeId!=null&&String(snapshot.storeId)!==store.id)throw fail('scope','Снимок Ozon относится к другому магазину.');
 if(snapshot?.version!==1||snapshot.complete!==true||!Array.isArray(snapshot.currentRows)||!Array.isArray(snapshot.previousRows)||!date(snapshot.current?.from)||!date(snapshot.current?.to)||!date(snapshot.previous?.from)||!date(snapshot.previous?.to)||typeof snapshot.updatedAt!=='string'||!Number.isFinite(Date.parse(snapshot.updatedAt)))throw fail('ozon_incomplete','Воронка Ozon загружена не полностью. Нули не подставлены.');
 if(snapshot.current.to>=day||snapshot.previous.to>=snapshot.current.from||shift(snapshot.current.from,6)!==snapshot.current.to||shift(snapshot.previous.from,6)!==snapshot.previous.to||shift(snapshot.previous.to,1)!==snapshot.current.from)throw fail('ozon_period','Периоды воронки Ozon не являются двумя последовательными завершёнными неделями.');
 const aliases=new Map(),identities=new Set(),catalog=new Map();
 for(const [index,p]of products.entries()){
  if(p.storeId!=null&&String(p.storeId)!==store.id)throw fail('scope','Каталог Ozon содержит товар другого магазина.');
  const identity=p.key||store.id+':'+String(p.product_id??index);if(identities.has(identity))throw fail('catalog','В каталоге Ozon повторяется карточка товара.');identities.add(identity);catalog.set(identity,p);
  const skus=new Set([p.sku,...(Array.isArray(p.skus)?p.skus:[]),...(Array.isArray(p.sources)?p.sources.map(s=>s.sku):[])].filter(v=>v!=null&&String(v)!=='').map(String));
  for(const sku of skus){if(!/^\d+$/.test(sku))continue;if(aliases.has(sku)&&aliases.get(sku)!==identity)throw fail('catalog','Один SKU Ozon связан с несколькими карточками. Конверсия не приписана товару.');aliases.set(sku,identity);}
 }
 const byPeriod={};
 for(const period of ['current','previous']){
  const map=new Map();for(const row of snapshot[period+'Rows']){const sku=String(row?.sku??'');if(!/^\d+$/.test(sku)||map.has(sku))throw fail('ozon_schema','Ozon вернул неоднозначные строки SKU.');if(row.storeId!=null&&String(row.storeId)!==store.id)throw fail('scope','Аналитика SKU относится к другому магазину.');map.set(sku,{orders:count(row.orderedUnits),visits:count(row.views),carts:count(row.cartAdds)});}byPeriod[period]=map;
 }
 const union=new Set([...byPeriod.current.keys(),...byPeriod.previous.keys()]),groups=new Map();let unmapped=0;
 for(const sku of union){const identity=aliases.get(sku);if(!identity){unmapped++;continue;}if(!groups.has(identity))groups.set(identity,{skus:[],current:{visits:0,carts:0,orders:0},previous:{visits:0,carts:0,orders:0}});const group=groups.get(identity);group.skus.push(sku);
  for(const period of ['current','previous']){const values=byPeriod[period].get(sku)||{visits:0,carts:0,orders:0};for(const key of ['visits','carts','orders']){group[period][key]=group[period][key]===null||values[key]===null?null:group[period][key]+values[key];if(group[period][key]!==null&&!Number.isSafeInteger(group[period][key]))throw fail('counts','Сумма событий Ozon выходит за допустимый диапазон.');}}
 }
 const rows=[];
 for(const [identity,group]of groups){
  const p=catalog.get(identity),current={...group.current,cartConversionPct:ratio(group.current.carts,group.current.visits),cartToOrderPct:null},previous={...group.previous,cartConversionPct:ratio(group.previous.carts,group.previous.visits),cartToOrderPct:null};
  const declining=current.orders!==null&&previous.orders!==null&&current.orders<previous.orders,signals=[];
  if(declining&&current.visits!==null&&previous.visits!==null&&current.visits<previous.visits)signals.push({code:'traffic_down',title:'Снизились просмотры карточки',previous:previous.visits,current:current.visits,unit:'events',action:'Проверьте показы, поисковые позиции и работу рекламы. Просмотры не равны уникальным посетителям.'});
  if(declining&&current.cartConversionPct!==null&&previous.cartConversionPct!==null&&current.cartConversionPct<previous.cartConversionPct)signals.push({code:'cart_conversion_down',title:'Меньше добавлений в корзину на 100 просмотров',previous:previous.cartConversionPct,current:current.cartConversionPct,unit:'per100',action:'Проверьте изменения цены, содержания карточки и отзывов; причина снижения пока не подтверждена.'});
  rows.push({id:JSON.stringify([store.id,identity]),storeId:store.id,storeName:store.name,market:'Ozon',sku:group.skus.join(', '),skus:group.skus,key:p.key||identity,offer_id:safeText(p.offer_id),name:safeText(p.name)||'Товар Ozon',current,previous,declining,drop:declining?previous.orders-current.orders:0,dropPercent:declining&&previous.orders>0?(previous.orders-current.orders)/previous.orders*100:null,lowSample:[current,previous].some(v=>v.visits===null||v.visits<100||v.carts===null||v.carts<20||v.orders===null||v.orders<10),signals,comparisonComplete:[current,previous].every(v=>v.visits!==null&&v.carts!==null&&v.orders!==null),hypothesisNote:'Ozon: просмотры и добавления в корзину из карточки — события, а не уникальные покупатели. Заказы могут приходить из поиска; отношение заказов к корзинам здесь не рассчитывается. Наблюдаемые изменения не доказывают причину падения.'});
 }
 rows.sort((a,b)=>b.drop-a.drop||a.name.localeCompare(b.name,'ru'));
 const stale=snapshot.current.to!==shift(day,-1)||status!=='ready';
 return {rows,current:snapshot.current,previous:snapshot.previous,days:7,shortened:false,source:'Ozon Seller API',fetchedAt:snapshot.updatedAt,status:!rows.length?'unavailable':stale?'stale':rows.every(r=>r.comparisonComplete)?'ready':'partial',stale,scopeVerified:true,coverage:{tracked:union.size,mapped:rows.length,catalog:products.length,unmapped,declining:rows.filter(r=>r.declining).length,comparable:rows.filter(r=>r.comparisonComplete).length},reason:!rows.length?'Нет SKU воронки, однозначно сопоставленных с локальным каталогом.':stale?'Показан сохранённый снимок Ozon. Его даты и время загрузки указаны явно; обновление ещё не подтверждено.':'Сравниваются заказы и события в карточке за два полных периода по 7 дней.'};
}
function create({privateDir,protect,stores,getProducts,getOzonFunnel,fetchImpl=fetch,now=Date.now}){
 if(!privateDir||typeof protect!=='function'||!stores||typeof getProducts!=='function')throw Error('Conversion requires private storage, stores and product catalog');
 const cache=new Map(),pending=new Map();let activeFingerprint=null;
 const time=()=>Number(new Date(now()));
 function configuration(){
  let config,link;try{config=JSON.parse(fs.readFileSync(path.join(privateDir,'truestats.json'),'utf8').replace(/^\uFEFF/,''));link=JSON.parse(fs.readFileSync(path.join(privateDir,'truestats-wb-link.json'),'utf8').replace(/^\uFEFF/,''));}catch{throw fail('not_connected','Для воронки WB требуется сохранённое подключение TrueStats и привязка кабинета.');}
  if(config.version!==1||typeof config.encryptedKey!=='string'||!config.encryptedKey||typeof link.storeId!=='string'||!Number.isSafeInteger(link.accountId)||link.accountId<=0)throw fail('configuration','Подключение TrueStats или привязка WB не подтверждены.');
  return {config,link,fingerprint:createHash('sha256').update(JSON.stringify([config,link])).digest('hex')};
 }
 function check(snapshot){let actual;try{actual=configuration().fingerprint}catch{throw fail('changed','Подключение TrueStats изменилось. Обновите воронку.');}if(actual!==snapshot.fingerprint)throw fail('changed','Подключение TrueStats изменилось. Обновите воронку.');}
 async function request(key,route,body){
  if(!ROUTES.has(route))throw fail('route','Недопустимый метод воронки.');
  let response;try{response=await fetchImpl(BASE+route,{method:body===undefined?'GET':'POST',headers:{'X-Api-Token':key,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(45000)});}catch{throw fail('network','TrueStats временно недоступен.');}
  if(!response.ok)throw fail(response.status===429?'rate_limit':'upstream',response.status===401?'TrueStats отклонил сохранённый ключ.':response.status===403?'Нет доступа к воронке TrueStats по этому тарифу или ключу.':response.status===429?'TrueStats ограничил частоту запросов. Повторная загрузка отложена.':'Не удалось загрузить воронку TrueStats.');
  try{const text=await response.text();if(text.length>12*1024*1024)throw Error();return JSON.parse(text);}catch{throw fail('schema','TrueStats вернул неподдерживаемый ответ воронки.');}
 }
 const unavailable=(store,reason,code='unavailable')=>({id:store.id,name:store.name,market:store.market,status:'unavailable',code,reason,rows:[],coverage:{tracked:0,mapped:0,catalog:null,unmapped:0,declining:0,comparable:0},fetchedAt:null});
 async function load(store,snapshot,day){
  let key=null;
  try{
   try{key=await protect(snapshot.config.encryptedKey,true)}catch{throw fail('storage','Не удалось открыть защищённое подключение TrueStats.');}
   check(snapshot);
   const filters=await request(key,'/rnp-report/v2/filter-values');check(snapshot);
   if(!Array.isArray(filters?.accounts)||!Array.isArray(filters.articles)||filters.accounts.filter(a=>a.id===snapshot.link.accountId).length!==1)throw fail('rnp_unavailable','Привязанный кабинет WB недоступен в РНП TrueStats. Отсутствие данных не означает нулевые заказы.');
   const periods=choosePeriods(filters.dates,day),items=[],ids=new Set();let total=null;
   for(let page=1;page<=100;page++){
    const value=await request(key,'/rnp-report/v2/grouped',{dateFrom:periods.current.from,dateTo:periods.current.to,compareDateFrom:periods.previous.from,compareDateTo:periods.previous.to,groupBy:'nm_id',compare:true,filters:{accounts:[snapshot.link.accountId]},page,limit:100,aggregationPeriod:'week'});check(snapshot);
    if(value?.isCalculationInProgress===true)throw fail('calculating','TrueStats ещё пересчитывает РНП. Предыдущее сравнение не считается новым.');
    const p=value?.pagination;
    if(value?.isCalculationInProgress!==false||!Array.isArray(value.items)||!p||!Number.isSafeInteger(p.total)||p.total<0||p.total>10000||p.page!==page||p.limit!==100||(total!==null&&p.total!==total)||value.items.length>100)throw fail('pagination','Не подтверждена полная загрузка воронки TrueStats.');
    total=p.total;
    for(const item of value.items){const id=String(item?.id??'');if(!id||ids.has(id))throw fail('duplicate','TrueStats повторил товар при загрузке страниц.');ids.add(id);items.push(item);}
    if(items.length===total)break;
    if(items.length>total||value.items.length!==100||page===100)throw fail('pagination','Воронка TrueStats загружена не полностью.');
   }
   if(!items.length)throw fail('rnp_empty','РНП не вернул товары. Возможны ограничения подписки или отслеживания; нулевые заказы не подставлены.');
   const products=await getProducts(store.id);if(!Array.isArray(products))throw fail('catalog','Локальный каталог WB недоступен.');
   const analyzed=analyzeRows(items,{store,accountId:snapshot.link.accountId,articles:filters.articles,products});check(snapshot);
   if(!analyzed.rows.length)throw fail('catalog','Товары РНП не сопоставились с локальным каталогом WB.');
   return {...unavailable(store,''),...periods,...analyzed,status:analyzed.rows.every(r=>r.comparisonComplete)?'ready':'partial',code:null,reason:periods.shortened?'Истории меньше 14 завершённых дней: сравниваются два полных периода по 6 дней.':'Сравниваются два полных периода по 7 завершённых дней.',accountId:snapshot.link.accountId,fetchedAt:new Date(time()).toISOString(),source:'TrueStats RNP',scopeVerified:true,sourceLag:periods.endsBeforeYesterday};
  }finally{key=null;}
 }
 async function storeReport(store,day){
  let snapshot;try{snapshot=configuration()}catch(e){cache.clear();pending.clear();activeFingerprint=null;return unavailable(store,e.message,e.code)}
  if(activeFingerprint!==snapshot.fingerprint){cache.clear();pending.clear();activeFingerprint=snapshot.fingerprint;}
  if(snapshot.link.storeId!==store.id)return unavailable(store,'Этот магазин WB не связан с кабинетом TrueStats.','link');
  const cacheKey=JSON.stringify([snapshot.fingerprint,day,store.id]),old=cache.get(cacheKey),stamp=time();
  if(old&&stamp<old.nextAt)return clone({...old.value,cached:true,nextAt:new Date(old.nextAt).toISOString()});
  if(pending.has(cacheKey))return clone(await pending.get(cacheKey));
  const work=(async()=>{
   let value;
   try{value=await load(store,snapshot,day)}catch(e){
    if(e.code==='changed'){cache.delete(cacheKey);return unavailable(store,e.message,e.code);}
    // Only preserve an already verified result for this exact account, config
    // and Moscow date. Failure never refreshes its source timestamp.
    const known=old?.value?.rows?.length?old.value:null;
    value=known?{...known,status:'stale',reason:e.code?e.message:'Не удалось обновить воронку.',errorCode:e.code||'error',stale:true}:unavailable(store,e.code?e.message:'Не удалось загрузить воронку.',e.code||'error');
   }
   try{check(snapshot)}catch(e){return unavailable(store,e.message,e.code)}
   const nextAt=time()+TTL;value={...value,cached:false,nextAt:new Date(nextAt).toISOString()};cache.set(cacheKey,{value:clone(value),nextAt});return value;
  })();pending.set(cacheKey,work);
  try{return clone(await work)}finally{if(pending.get(cacheKey)===work)pending.delete(cacheKey)}
 }
 async function read({storeId,store,market='all'}={}){
  const selectedId=storeId||store||'',normalizedMarket=market||'all';
  if(!['all','Ozon','WB'].includes(normalizedMarket))throw Error('Выберите все площадки, Ozon или WB.');
  const selected=Object.entries(stores).map(([id,s])=>({id,name:safeText(s.name)||id,market:s.market==='WB'?'WB':'Ozon'})).filter(s=>(!selectedId||s.id===String(selectedId))&&(normalizedMarket==='all'||s.market===normalizedMarket));
  if(!selected.length)throw Error('Выберите подключённый магазин для анализа конверсии.');
  const day=today(time()),reports=[];
  for(const s of selected){
   if(s.market==='WB'){reports.push(await storeReport(s,day));continue;}
   if(typeof getOzonFunnel!=='function'){reports.push(unavailable(s,'Воронка Ozon пока не подключена к этому разделу. Отсутствие данных не означает нулевые заказы.','ozon_unavailable'));continue;}
   try{const source=await getOzonFunnel(s.id);if(!source?.snapshot){reports.push(unavailable(s,source?.status==='pending'?'Воронка Ozon загружается в общей очереди аналитики.':'Нет полного снимка воронки Ozon. Доступность метрик и ограничения API ещё не подтверждены.',source?.status==='pending'?'pending':'ozon_unavailable'));continue;}
    const products=await getProducts(s.id);if(!Array.isArray(products))throw fail('catalog','Локальный каталог Ozon недоступен.');const report=analyzeOzon(source.snapshot,{store:s,products,day,status:source.status});reports.push({...unavailable(s,''),...report,...(source.retryAt?{nextAt:source.retryAt}:{})});
   }catch(e){reports.push(unavailable(s,e.code?e.message:'Не удалось прочитать воронку Ozon.',e.code||'error'));}
  }
  const available=reports.filter(s=>s.rows.length),rows=available.flatMap(s=>s.rows),status=!available.length?'unavailable':reports.some(s=>s.status==='stale')?'stale':reports.some(s=>s.status!=='ready')?'partial':'ready';
  return {status,source:'TrueStats RNP / Ozon Seller API',generatedAt:new Date(time()).toISOString(),scope:{storeId:String(selectedId),market:normalizedMarket},stores:reports,rows,coverage:{selectedStores:reports.length,availableStores:available.length,mapped:rows.length,declining:rows.filter(r=>r.declining).length},refresh:{intervalMinutes:30},notes:['WB: переходы, добавления в корзину и заказы — события за период, а не отслеживание одних и тех же покупателей. Конверсия в корзину = корзины / переходы × 100%; отношение заказов к корзинам = заказы / корзины × 100%.','Ozon: добавления в корзину из карточки на 100 просмотров карточки = cartAdds / views × 100. Это не вероятность покупки и не доля уникальных посетителей. Отношение заказов к корзинам Ozon не рассчитывается.','Проценты считаются из итоговых событий, не усредняются по дням или SKU. При нулевом знаменателе или отсутствующих событиях показатель не рассчитывается. Отношения событий могут превышать 100%.','Малая выборка: хотя бы в одном периоде менее 100 переходов/просмотров, 20 корзин или 10 заказанных единиц, либо часть событий отсутствует. Это ориентир надёжности, не статистический тест.']};
 }
 return {read};
}
module.exports={create,choosePeriods,analyzeRows,analyzeOzon,metrics};
