'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const BASE='https://api.truestats.ru';
const TTL=30*60*1000;
// Official contract: https://api.truestats.ru/api/public/doc (2026-09-16).
// All POST routes below retrieve reports; no import, settings or export routes.
const ROUTES=new Set(['/reporting/facets','/reporting/main/stats','/reporting/aggregated-view/day','/product-metrics','/v1/data-readiness']);
const METRICS=['profit','realized','cogs','tax','operatingExpenses','marketplaceDeductions','margin','profitBeforeTaxAndOpex','ads','sales','adsBonus','adsTotal','adShare','adShareTotal','adShareOrders','adShareSales','roi'];
const emptyMetrics=()=>Object.fromEntries(METRICS.map(key=>[key,null]));
function failure(code,message){return Object.assign(new Error(message),{code,public:true,status:400});}
function numeric(value){
 if(typeof value!=='number'&&!(typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value)))return null;
 const n=Number(value);return Number.isFinite(n)&&Math.abs(n)<=Number.MAX_SAFE_INTEGER/100?n:null;
}
function rounded(value){
 const n=numeric(value);if(n===null)return null;
 // Decimal cents, including negative half-cent values; no binary float tie errors.
 const [mantissa,exponent='0']=String(value).toLowerCase().replace(/^-/,'').split('e'),[whole,fraction='']=mantissa.split('.');
 const digits=BigInt(whole+fraction),shift=Number(exponent)+2-fraction.length;
 const divisor=shift<0?10n**BigInt(-shift):1n;
 const cents=shift<0?(digits+divisor/2n)/divisor:digits*10n**BigInt(shift);
 return Number(cents)<=Number.MAX_SAFE_INTEGER?(Math.sign(n)*Number(cents)/100||0):null;
}
function date(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
function text(value,key){return typeof value==='string'?value.replaceAll(key||'\0','[скрыто]').replace(/<[^>]*>/g,'').replace(/[\x00-\x1f]/g,' ').slice(0,240):'';}
const label=value=>value.toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/\s+/g,' ').trim();
const LABELS={realized:['реализация'],cogs:['себестоимость продаж','себестоимость реализованных товаров'],tax:['налог','налоги'],operatingExpenses:['операционные расходы'],marketplaceDeductions:['удержания маркетплейса'],margin:['маржинальность','маржинальность, %','марж-cть'],ads:['реклама'],sales:['продажи'],adsBonus:['расходы на рекламу с бонусов'],adsTotal:['общие расходы на рекламу'],adShare:['дрр'],adShareTotal:['общая дрр'],adShareOrders:['реклама/дррз']};
const PERCENT_METRICS=new Set(['margin','adShare','adShareTotal','adShareOrders']);
// Lookup uses the API's metric dictionary, never an inferred JSON property name.
function normalize(report,catalog,key){
 if(!report||typeof report.stats!=='object'||Array.isArray(report.stats)||report.financialMod!==false)throw failure('report_schema','TrueStats вернул неподдерживаемый формат отчёта.');
 const metrics=emptyMetrics(),rawMetrics=[],details=[];
 metrics.profit=rounded(report.stats.profit); // Explicitly documented in StatsReportingResponseDto.
 for(const entry of Array.isArray(catalog)?catalog:[]){
  if(!entry||typeof entry.id!=='string'||entry.id===key||typeof entry.header!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(entry.id))continue;
  const suffix=typeof entry.meta?.suffix==='string'?entry.meta.suffix.trim():'';
  if(!['₽','руб.','руб','%'].includes(suffix))continue;
  const value=rounded(report.stats[entry.id]);
  rawMetrics.push({id:entry.id,label:text(entry.header,key),unit:suffix,value});
 }
 for(const [metric,names] of Object.entries(LABELS)){
  const matches=rawMetrics.filter(item=>names.includes(label(item.label))&&(PERCENT_METRICS.has(metric)?item.unit==='%':item.unit!=='%'));
  if(matches.length===1)metrics[metric]=matches[0].value;
 }
 for(const item of Array.isArray(report.profitDetalization)?report.profitDetalization:[]){
  if(typeof item?.title!=='string')continue;
  details.push({title:text(item.title,key),amount:rounded(item.amount)});
 }
 // The official breakdown defines expense amounts as negative contributions.
 for(const [metric,names] of Object.entries({...LABELS,cogs:[...LABELS.cogs,'себестоимость']})){
  if(PERCENT_METRICS.has(metric)||metrics[metric]!==null)continue;
  const matches=details.filter(item=>names.includes(label(item.title)));
  if(matches.length===1&&matches[0].amount!==null)metrics[metric]=['realized','sales'].includes(metric)?matches[0].amount:rounded(-matches[0].amount);
 }
 if(metrics.adShare===null&&metrics.ads!==null&&metrics.realized>0)metrics.adShare=rounded(metrics.ads/metrics.realized*100);
 if(metrics.profit!==null&&metrics.cogs>0)metrics.roi=rounded(metrics.profit/metrics.cogs*100);
 if(metrics.ads!==null&&metrics.sales>0)metrics.adShareSales=rounded(metrics.ads/metrics.sales*100);
 if([metrics.profit,metrics.tax,metrics.operatingExpenses].every(v=>v!==null))metrics.profitBeforeTaxAndOpex=rounded(metrics.profit+metrics.tax+metrics.operatingExpenses);
 const detailComplete=details.length>0&&details.every(v=>v.amount!==null),detailSum=detailComplete?details.reduce((sum,item)=>sum+Math.round(item.amount*100),0):null;
 const reconciled=detailSum!==null&&metrics.profit!==null?Math.abs(detailSum-Math.round(metrics.profit*100))<=details.length:null;
 if(reconciled&&[metrics.realized,metrics.cogs,metrics.tax,metrics.operatingExpenses,metrics.profit].every(v=>v!==null))metrics.marketplaceDeductions=(Math.round(metrics.realized*100)-Math.round(metrics.cogs*100)-Math.round(metrics.tax*100)-Math.round(metrics.operatingExpenses*100)-Math.round(metrics.profit*100))/100;
 return {metrics,rawMetrics,details,breakdownReconciled:reconciled};
}
function schemaMetadata(value,secret){
 // Types and safe field names only; never include values or arbitrary free text.
 const fields=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.entries(v).filter(([k])=>k!==secret&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(k)&&!/token|secret|key|password|auth/i.test(k)).slice(0,200).map(([name,v])=>({name,type:v===null?'null':Array.isArray(v)?'array':typeof v})):[];
 return {fields:fields(value),statsFields:fields(value?.stats),summaryFields:fields(value?.summary)};
}
function daysInPeriod(period){
 if(!date(period?.from)||!date(period?.to)||period.from>period.to||(Date.parse(period.to)-Date.parse(period.from))/86400000>=90)throw failure('period','Проверьте даты отчёта: период не больше 90 дней.');
 const result=[];for(let ms=Date.parse(period.from);ms<=Date.parse(period.to);ms+=86400000)result.push(new Date(ms).toISOString().slice(0,10));return result;
}
function sumMoney(values){return values.every(value=>numeric(value)!==null)?values.reduce((sum,value)=>sum+Math.round(Number(value)*100),0)/100:null;}
// Daily row.date was verified against the official API on 2026-09-18. The
// catalog identifies profit as "Чистая прибыль"; no inferred expense formula.
function normalizeDaily(day,stats,catalog,{period,accountId,readiness,today,key}={}){
 const dates=daysInPeriod(period);
 if(day?.financialMod!==false||!Array.isArray(day.result)||!Array.isArray(day.accountIdsFilter)||day.accountIdsFilter.length!==1||day.accountIdsFilter[0]!==accountId)throw failure('scope_response','TrueStats не подтвердил точный магазин в дневном отчёте.');
 const profitDefinition=(Array.isArray(catalog)?catalog:[]).filter(item=>item?.id==='profit'&&label(item.header||'')==='чистая прибыль'&&['₽','руб.','руб'].includes(item.meta?.suffix?.trim()));
 if(profitDefinition.length!==1)throw failure('daily_schema','TrueStats не подтвердил определение чистой прибыли.');
 const rows=new Map();for(const row of day.result){if(!date(row?.date)||row.date<period.from||row.date>period.to||rows.has(row.date))throw failure('daily_schema','TrueStats вернул неоднозначные даты дневного отчёта.');rows.set(row.date,row);}
 const summary=normalize({financialMod:false,stats:day.summary},catalog,key),total=normalize(stats,catalog,key);
 const rawProfits=dates.map(d=>rounded(rows.get(d)?.profit)),rawSum=sumMoney(rawProfits);
 const tolerance=dates.length/100;
 // Missing dates prevent a full-row sum check, but never excuse an explicit
 // disagreement between the period reports or its signed expense breakdown.
 if(total.breakdownReconciled===false||(summary.metrics.profit!==null&&total.metrics.profit!==null&&Math.abs(summary.metrics.profit-total.metrics.profit)>tolerance+1e-8))throw failure('reconciliation','Дневная прибыль TrueStats не совпала с итоговым отчётом. График не показан до сверки.');
 const consistent=rawSum!==null&&summary.metrics.profit!==null&&total.metrics.profit!==null&&Math.abs(rawSum-summary.metrics.profit)<=tolerance+1e-8&&Math.abs(rawSum-total.metrics.profit)<=tolerance+1e-8&&total.breakdownReconciled!==false;
 // A period mismatch invalidates the curve: operating expenses must not vanish
 // between daily and total reports. Missing days remain individual gaps.
 if(rawSum!==null&&!consistent)throw failure('reconciliation','Дневная прибыль TrueStats не совпала с итоговым отчётом. График не показан до сверки.');
 const points=dates.map(d=>{
  const row=rows.get(d),normalized=row?normalize({financialMod:false,stats:row},catalog,key).metrics:emptyMetrics();
  let reason=null,status='ready';
  if(d>=today){status='pending';reason='День ещё не закрыт: чистая прибыль будет доступна после получения финансовых данных.';}
  else if(!readiness||!date(readiness.lastDataDate)){status='pending';reason='TrueStats не подтвердил дату готовности финансовых данных.';}
  else if(d>readiness.lastDataDate||(readiness.checkedDate===d&&readiness.status!=='complete')){status='pending';reason='TrueStats ещё не подтвердил финансовые данные за этот день.';}
  else if(!row||normalized.profit===null){status='unavailable';reason='В дневном отчёте TrueStats нет прибыли за этот день.';}
  return {date:d,profit:status==='ready'?normalized.profit:null,status,reason,tax:status==='ready'?normalized.tax:null,operatingExpenses:status==='ready'?normalized.operatingExpenses:null};
 });
 const complete=points.every(point=>point.status==='ready'),known=points.filter(point=>point.status==='ready').map(point=>point.profit);
 return {points,complete,totalProfit:complete&&consistent?sumMoney(known):null,knownProfit:known.length?sumMoney(known):null,status:complete?'ready':known.length?'partial':points.some(point=>point.status==='pending')?'pending':'unavailable',reconciled:consistent,breakdownReconciled:total.breakdownReconciled};
}
function create({privateDir,protect,fetchImpl=fetch,now=()=>Date.now()}){
 if(!privateDir||typeof protect!=='function')throw Error('TrueStats requires protected private storage');
 const file=path.join(privateDir,'truestats.json'),cache=new Map(),pending=new Map();
 let config=null,storageError=false,revision=0,connectQueue=Promise.resolve(),retryAt=0;
 try{if(fs.existsSync(file)){const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.version!==1||typeof saved.encryptedKey!=='string'||!saved.encryptedKey)throw Error();config=saved;}}catch{storageError=true;}
 const timestamp=()=>Number(new Date(now()));
 const status=()=>({connected:!!config,connectedAt:config?.connectedAt||null,source:'TrueStats API',mode:'management',error:storageError?'Защищённое подключение TrueStats недоступно.':null,retryAt:retryAt>timestamp()?new Date(retryAt).toISOString():null});
 async function request(key,route,body,query=''){
  if(!ROUTES.has(route))throw failure('route','Метод TrueStats недоступен.');
  if(retryAt>timestamp()){const error=failure('rate_limit','TrueStats ограничил частоту запросов. Повторная загрузка отложена.');error.retryAt=new Date(retryAt).toISOString();throw error;}
  let response;
  try{response=await fetchImpl(BASE+route+(query?'?'+query:''),{method:body===undefined?'GET':'POST',headers:{'X-Api-Token':key,'Accept':'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(25000)});}catch{throw failure('network','TrueStats недоступен. Повторите запрос позже.');}
  if(response.status===429){const raw=response.headers.get('Retry-After'),seconds=Number(raw),dateValue=Date.parse(raw),delay=raw&&Number.isFinite(seconds)?seconds*1000:Number.isFinite(dateValue)?dateValue-timestamp():30*60*1000;retryAt=Math.max(retryAt,timestamp()+Math.max(5*60*1000,delay));const error=failure('rate_limit','TrueStats ограничил частоту запросов. Повторная загрузка отложена.');error.retryAt=new Date(retryAt).toISOString();throw error;}
  if(!response.ok)throw failure(response.status===401?'unauthorized':response.status===403?'forbidden':'upstream',response.status===401?'Ключ TrueStats отклонён. Подключите новый ключ.':response.status===403?'TrueStats не разрешает доступ к отчёту для этого ключа или тарифа.':'Не удалось получить отчёт TrueStats (HTTP '+Number(response.status)+').');
  try{const bodyText=await response.text();if(bodyText.length>4*1024*1024)throw Error();return JSON.parse(bodyText);}catch{throw failure('response_schema','TrueStats вернул неподдерживаемый ответ.');}
 }
 async function accounts(key){
  const result=await request(key,'/reporting/facets',{_dimensions:['accounts']});
  if(!Array.isArray(result?.accounts)||result.accounts.some(a=>!Number.isSafeInteger(a?.id)||a.id<=0||typeof a.name!=='string'||![0,1,2].includes(a.accountType)))throw failure('accounts_schema','TrueStats вернул неподдерживаемый список магазинов.');
  return result.accounts.map(a=>({id:a.id,name:text(a.name,key),accountType:a.accountType}));
 }
 function connect(key){
  const operation=connectQueue.then(async()=>{
   if(typeof key!=='string'||key.trim()!==key||key.length<16||key.length>4096||/[\s\x00-\x1f]/.test(key))throw failure('key_format','Проверьте ключ TrueStats.');
   await accounts(key);
   let encryptedKey;
   try{encryptedKey=await protect(key,false);if(typeof encryptedKey!=='string'||!encryptedKey||encryptedKey===key)throw Error();}catch{throw failure('storage','Не удалось сохранить ключ в защищённом хранилище Windows.');}
   const next={version:1,encryptedKey,connectedAt:new Date(timestamp()).toISOString()},tmp=file+'.'+randomUUID()+'.tmp';
   try{fs.mkdirSync(privateDir,{recursive:true});fs.writeFileSync(tmp,JSON.stringify(next),{mode:0o600});fs.renameSync(tmp,file);}catch{try{fs.unlinkSync(tmp);}catch{}throw failure('storage','Не удалось сохранить защищённое подключение TrueStats.');}
   config=next;storageError=false;revision++;cache.clear();return status();
  });
  connectQueue=operation.catch(()=>{});return operation;
 }
 async function compare({period,stores,market='Ozon'}={}){
  const accountType=market==='WB'?0:1,readinessType=market==='WB'?'wb_report':'ozon_report';
  const base={status:'unavailable',reason:null,period:period?{from:period.from,to:period.to}:null,fetchedAt:null,source:'TrueStats API',mode:'management',accounts:[],metrics:emptyMetrics(),rawMetrics:[],details:[],warnings:['Прибыль TrueStats включает его налоги, себестоимость и настройки расходов; наш расчёт использует текущую себестоимость и прибыль до налогов.']};
  if(market==='WB')base.warnings=['Прибыль и себестоимость получены из управленческого отчёта вашего магазина WB в TrueStats. ROI рассчитан как прибыль / себестоимость реализованных товаров × 100%. Полнота внешних расходов зависит от настроек кабинета.'];
  const unavailable=(code,reason)=>({...base,code,reason});
  if(!date(period?.from)||!date(period?.to)||period.from>period.to)return unavailable('period','Выберите корректный период отчёта.');
  if(!Array.isArray(stores)||!stores.length||stores.some(s=>!s||!['string','number'].includes(typeof s.id)||typeof s.name!=='string'||!s.name||(market!=='WB'&&s.market==='WB')||(market==='WB'&&!Number.isSafeInteger(s.trueStatsAccountId)))||new Set(stores.map(s=>String(s.id))).size!==stores.length||new Set(stores.map(s=>s.name)).size!==stores.length)return unavailable('scope','Нужен однозначный список сопоставленных магазинов.');
  if(!config)return {...unavailable(storageError?'storage':'not_connected',storageError?'Защищённое подключение TrueStats недоступно.':'Подключите API TrueStats для второго расчёта.'),status:'not_connected'};
  const startRevision=revision,saved=config,scope=stores.map(s=>({id:String(s.id),name:s.name,...(market==='WB'?{trueStatsAccountId:s.trueStatsAccountId}:{})})).sort((a,b)=>a.id.localeCompare(b.id));
  const cacheKey=JSON.stringify([startRevision,market,period.from,period.to,scope]),cached=cache.get(cacheKey),time=timestamp();
  if(cached&&time>=cached.at&&time-cached.at<TTL)return structuredClone({...cached.value,cached:true});
  if(pending.has(cacheKey))return structuredClone(await pending.get(cacheKey));
  const work=(async()=>{
   try{
    let key;try{key=await protect(saved.encryptedKey,true);}catch{throw failure('storage','Не удалось открыть защищённый ключ TrueStats.');}
    const available=await accounts(key),matched=[];
    for(const store of scope){const options=available.filter(a=>a.accountType===accountType&&(market==='WB'?a.id===store.trueStatsAccountId:a.name===store.name));if(options.length!==1)throw failure('scope',options.length?'Магазин TrueStats сопоставлен неоднозначно.':'Не все выбранные магазины найдены в TrueStats по заданной привязке.');matched.push({id:options[0].id,name:store.name,localStoreId:store.id});}
    const ids=matched.map(a=>a.id).sort((a,b)=>a-b);if(new Set(ids).size!==ids.length)throw failure('scope','Магазины TrueStats сопоставлены неоднозначно.');
    const body={dateFrom:period.from,dateTo:period.to,filters:{accountTypes:[accountType],accounts:ids},financialMod:false};
    // This endpoint echoes effective access scope, unlike KPI stats.
    const day=await request(key,'/reporting/aggregated-view/day',body);
    if(day?.financialMod!==false||!Array.isArray(day.accountIdsFilter)||JSON.stringify([...day.accountIdsFilter].sort((a,b)=>a-b))!==JSON.stringify(ids))throw failure('scope_response','TrueStats не подтвердил точный состав магазинов в отчёте.');
    const readinessQuery=new URLSearchParams();ids.forEach(id=>readinessQuery.append('accounts[]',String(id)));readinessQuery.append('dataTypes[]',readinessType);
    const results=await Promise.allSettled([request(key,'/reporting/main/stats',body),request(key,'/product-metrics'),request(key,'/v1/data-readiness',undefined,readinessQuery.toString())]);
    if(results[0].status==='rejected')throw results[0].reason;
    const catalog=results[1].status==='fulfilled'?results[1].value:[],normalized=normalize(results[0].value,catalog,key);
    if(revision!==startRevision)throw failure('connection_changed','Подключение TrueStats изменилось. Обновите отчёт.');
    const value={...base,...normalized,status:normalized.metrics.profit===null?'partial':'ready',reason:normalized.metrics.profit===null?'TrueStats не вернул распознаваемую чистую прибыль.':null,accounts:matched,fetchedAt:new Date(timestamp()).toISOString(),cached:false,scopeVerified:true,missingMetrics:METRICS.filter(k=>normalized.metrics[k]===null),schema:schemaMetadata(results[0].value,key)};
    value.warnings.push('Свежесть и полнота учёта зависят от загрузки данных в TrueStats; время получения отчёта не означает закрытие периода.');
    if(results[1].status==='rejected')value.warnings.push('Справочник метрик TrueStats недоступен; часть показателей не распознана.');
    if(normalized.breakdownReconciled===false){value.status='partial';value.warnings.push('Детализация TrueStats не сходится с его итоговой прибылью.');}
    const readinessItems=results[2].status==='fulfilled'&&Array.isArray(results[2].value?.items)?results[2].value.items:[];
    value.readiness=readinessItems.filter(item=>ids.includes(item?.accountId)&&item.dataType===readinessType).map(item=>({accountId:item.accountId,status:['pending','complete','incomplete'].includes(item.status)?item.status:'unknown',checkedDate:date(item.checkedDate)?item.checkedDate:null,lastDataDate:date(item.lastDataDate)?item.lastDataDate:null}));
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(timestamp()));
    const zeroToday=period.to>=today&&normalized.metrics.profit===0&&normalized.metrics.realized===0;
    const delayed=value.readiness.some(item=>(item.lastDataDate&&item.lastDataDate<period.to)||(item.checkedDate===period.to&&item.status!=='complete'));
    if(delayed||zeroToday){value.status='pending';value.reason='TrueStats ещё не подтвердил финансовые данные за весь выбранный период. Нулевой или неполный отчёт не считается окончательной прибылью.';value.metrics=emptyMetrics();}
    else if(value.readiness.length!==ids.length)value.warnings.push('TrueStats не сообщил готовность финансовых данных по всем выбранным магазинам.');
    cache.set(cacheKey,{at:timestamp(),value});while(cache.size>30)cache.delete(cache.keys().next().value);
    return value;
   }catch(error){cache.delete(cacheKey);return {...unavailable(error.public?error.code:'unavailable',error.public?error.message:'Не удалось получить отчёт TrueStats.'),...(error.retryAt?{retryAt:error.retryAt}:{})};}
  })();
  pending.set(cacheKey,work);try{return structuredClone(await work);}finally{pending.delete(cacheKey);}
 }
 async function daily({period,store,market='Ozon'}={}){
  const base={period:period?{from:period.from,to:period.to}:null,status:'unavailable',reason:null,points:[],totalProfit:null,knownProfit:null,complete:false,fetchedAt:null,readiness:null,source:'TrueStats API',mode:'management'};
  const unavailable=(code,reason)=>({...base,code,reason});
  let dates;try{dates=daysInPeriod(period);}catch(error){return unavailable(error.code,error.message);}
  base.points=dates.map(d=>({date:d,profit:null,status:'unavailable',reason:null,tax:null,operatingExpenses:null}));
  if(!store||!['string','number'].includes(typeof store.id)||typeof store.name!=='string'||!store.name||!['Ozon','WB'].includes(market)||(market==='WB'&&!Number.isSafeInteger(store.trueStatsAccountId)))return unavailable('scope','Нужна однозначная привязка магазина к TrueStats.');
  if(!config)return unavailable(storageError?'storage':'not_connected',storageError?'Защищённое подключение TrueStats недоступно.':'Подключите API TrueStats для графика чистой прибыли.');
  const startRevision=revision,saved=config,cacheKey=JSON.stringify(['daily',startRevision,market,period.from,period.to,String(store.id),store.name,store.trueStatsAccountId||null]),time=timestamp(),cached=cache.get(cacheKey);
  if(cached&&time>=cached.at&&time-cached.at<TTL)return structuredClone({...cached.value,cached:true});
  if(pending.has(cacheKey))return structuredClone(await pending.get(cacheKey));
  const work=(async()=>{try{
   let key;try{key=await protect(saved.encryptedKey,true);}catch{throw failure('storage','Не удалось открыть защищённый ключ TrueStats.');}
   const accountType=market==='WB'?0:1,readinessType=market==='WB'?'wb_report':'ozon_report',available=await accounts(key),matched=available.filter(a=>a.accountType===accountType&&(market==='WB'?a.id===store.trueStatsAccountId:a.name===store.name));
   if(matched.length!==1)throw failure('scope','Не удалось однозначно сопоставить магазин с TrueStats.');
   const accountId=matched[0].id,body={dateFrom:period.from,dateTo:period.to,filters:{accountTypes:[accountType],accounts:[accountId]},financialMod:false};
   const day=await request(key,'/reporting/aggregated-view/day',body);
   if(day?.financialMod!==false||!Array.isArray(day.accountIdsFilter)||day.accountIdsFilter.length!==1||day.accountIdsFilter[0]!==accountId)throw failure('scope_response','TrueStats не подтвердил точный магазин в дневном отчёте.');
   const query=new URLSearchParams();query.append('accounts[]',String(accountId));query.append('dataTypes[]',readinessType);
   const results=await Promise.allSettled([request(key,'/reporting/main/stats',body),request(key,'/product-metrics'),request(key,'/v1/data-readiness',undefined,query.toString())]);
   if(results[0].status==='rejected')throw results[0].reason;if(results[1].status==='rejected')throw results[1].reason;
   const readyItems=results[2].status==='fulfilled'&&Array.isArray(results[2].value?.items)?results[2].value.items.filter(item=>item?.accountId===accountId&&item.dataType===readinessType):[];
   const item=readyItems.length===1?readyItems[0]:null,readiness=item?{status:['pending','complete','incomplete'].includes(item.status)?item.status:'unknown',checkedDate:date(item.checkedDate)?item.checkedDate:null,lastDataDate:date(item.lastDataDate)?item.lastDataDate:null}:null;
   const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(timestamp()));
   const normalized=normalizeDaily(day,results[0].value,results[1].value,{period,accountId,readiness,today,key});
   if(revision!==startRevision)throw failure('connection_changed','Подключение TrueStats изменилось. Обновите отчёт.');
   const value={...base,...normalized,accountId,readiness,fetchedAt:new Date(timestamp()).toISOString(),scopeVerified:true,cached:false};cache.set(cacheKey,{at:timestamp(),value});while(cache.size>60)cache.delete(cache.keys().next().value);return value;
  }catch(error){return {...unavailable(error.public?error.code:'unavailable',error.public?error.message:'Не удалось получить дневную прибыль TrueStats.'),...(error.retryAt?{retryAt:error.retryAt}:{})};}})();
  pending.set(cacheKey,work);try{return structuredClone(await work);}finally{pending.delete(cacheKey);}
 }
 return {status,connect,compare,daily};
}
module.exports={create,normalize,schemaMetadata,normalizeDaily,daysInPeriod};
