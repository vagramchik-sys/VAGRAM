'use strict';

const MARKETS=new Set(['all','Ozon','WB']);
const SCHEMES={Ozon:['FBO','FBS'],WB:['FBS','DBS']};
const MAX_DAYS=92;
const MAX_PAGE_SIZE=500;
const DAY_MS=86400000;

function validDay(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(value))return false;
 const parsed=Date.parse(value+'T00:00:00Z');return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===value;
}
const shift=(value,days)=>new Date(Date.parse(value+'T00:00:00Z')+days*DAY_MS).toISOString().slice(0,10);
function periods(from,to){
 if(!validDay(from)||!validDay(to)||from>to)throw Object.assign(Error('Проверьте период B2B Radar'),{code:'INVALID_PERIOD'});
 const days=Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/DAY_MS)+1;
 if(days>MAX_DAYS)throw Object.assign(Error(`Период B2B Radar не должен превышать ${MAX_DAYS} дней`),{code:'INVALID_PERIOD'});
 return {current:{from,to},previous:{from:shift(from,-days),to:shift(from,-1)}};
}
function marketOf(id,store){return store?.market==='WB'||String(id).startsWith('wb-')?'WB':'Ozon';}
function sourceRange(value){const from=value?.requested?.from||value?.from,to=value?.requested?.to||value?.to;return validDay(from)&&validDay(to)&&from<=to?{from,to}:null;}
function overlap(range,period){return range&&range.from<=period.to&&range.to>=period.from;}
function covers(intervals,period){let cursor=period.from;for(const interval of intervals.sort((a,b)=>a.from.localeCompare(b.from)||b.to.localeCompare(a.to))){if(interval.to<cursor)continue;if(interval.from>cursor)return false;if(interval.to>=period.to)return true;cursor=shift(interval.to,1);}return false;}
function coverageFor(rawSources,period,expected){
 const groups=new Map();
 for(const wrapper of rawSources){const source=wrapper?.value,range=sourceRange(source);if(!range||!overlap(range,period))continue;const key=[source?.market,source?.storeId||'',source?.scheme].join('\u001f');if(!expected.has(key))continue;
  const group=groups.get(key)||{market:source.market,storeId:source.storeId||null,scheme:source.scheme,name:null,available:false,intervals:[],fetched:[],limitations:[]};
  if(typeof source.name==='string'&&source.name)group.name=source.name;if(source.available===true)group.available=true;
  if(typeof source.fetchedAt==='string'&&Number.isFinite(Date.parse(source.fetchedAt)))group.fetched.push(new Date(source.fetchedAt).toISOString());
  if(typeof source.limitation==='string'&&source.limitation)group.limitations.push(source.limitation);
  if(wrapper.partial!==true&&source.available===true&&source.complete===true)group.intervals.push({from:range.from<period.from?period.from:range.from,to:range.to>period.to?period.to:range.to});
  groups.set(key,group);
 }
 const sources=[];
 for(const key of expected){const group=groups.get(key),[market,storeId,scheme]=key.split('\u001f');if(!group){sources.push({market,storeId,scheme,available:false,complete:false,requested:{...period},fetchedAt:null,limitation:'Источник за выбранный период ещё не подготовлен.'});continue;}
  const complete=covers(group.intervals,period);sources.push({market:group.market,storeId:group.storeId,scheme:group.scheme,name:group.name,available:group.available,complete,requested:{...period},fetchedAt:group.fetched.sort()[0]||null,limitation:complete?null:group.limitations[0]||'Источник не покрывает весь выбранный период.'});
 }
 const available=sources.some(source=>source.available),complete=available&&sources.length>0&&sources.every(source=>source.available&&source.complete);
 return {complete,available,sources};
}
function sumRows(rows,period,key){let value=0;for(const row of rows){const bucket=row.metrics?.[period];if(bucket)value+=Number(bucket[key]||0);}return value;}
function amountState(rows,period,periodCoverage){
 if(!periodCoverage.available)return 'unknown';
 if(!periodCoverage.complete)return 'partial';
 const hasUnits=sumRows(rows,period,'grossUnits')>0,missing=rows.some(row=>Number(row.metrics?.[period]?.grossUnits||0)>0&&row.metrics?.[period]?.amountRub==null);
 return hasUnits&&missing?'partial':'complete';
}
function buildCoverage(rows,rawSources,scope,currentPeriod,previousPeriod){
 const expected=new Set(scope.flatMap(([id,store])=>SCHEMES[marketOf(id,store)].map(scheme=>[marketOf(id,store),id,scheme].join('\u001f'))));
 const current=coverageFor(rawSources,currentPeriod,expected),previous=coverageFor(rawSources,previousPeriod,expected),hasRows=rows.length>0;
 const unknown=sumRows(rows,'current','unknownUnits')+sumRows(rows,'previous','unknownUnits'),classification=!current.available&&!previous.available&&!hasRows?'unknown':current.complete&&previous.complete&&unknown===0?'complete':'partial';
 const daily=!current.available&&!previous.available&&!hasRows?'unknown':current.complete&&previous.complete?'complete':'partial';
 const currentKeys=new Set(current.sources.filter(item=>item.available).map(item=>[item.market,item.storeId,item.scheme].join('\u001f'))),previousKeys=new Set(previous.sources.filter(item=>item.available).map(item=>[item.market,item.storeId,item.scheme].join('\u001f')));
 const compatibleWithPrevious=current.complete&&previous.complete&&currentKeys.size===previousKeys.size&&[...currentKeys].every(key=>previousKeys.has(key));
 const limitations=[];if(!current.complete)limitations.push('Текущий период покрыт источниками не полностью.');if(!previous.complete)limitations.push('Предыдущий период покрыт источниками не полностью.');if(unknown>0)limitations.push('Часть заказов не имеет надёжного признака типа покупателя.');
 const amounts=[amountState(rows,'current',current),amountState(rows,'previous',previous)].every(value=>value==='complete')?'complete':!current.available&&!previous.available?'unknown':'partial';
 if(amounts!=='complete')limitations.push('Сумма заказов доступна только для строк с подтверждённой суммой в RUB; WB её не предоставляет.');
 if(rows.some(row=>Number(row.metrics?.current?.cancellationUnknownUnits||0)+Number(row.metrics?.previous?.cancellationUnknownUnits||0)>0))limitations.push('Для части строк статус отмены не определён.');
 return {classification,amounts,daily,compatibleWithPrevious,current,previous,limitations};
}

function create({repository,getStores,analyze}={}){
 if(typeof repository?.read!=='function'||typeof getStores!=='function'||typeof analyze!=='function')throw new TypeError('B2B Radar SQL dependencies are required');
 const inFlight=new Map();
 async function load({from,to,market='all',storeId,limit=100,offset=0}={}){
  const requested=periods(from,to);market=market||'all';if(!MARKETS.has(market))throw Object.assign(Error('Проверьте площадку B2B Radar'),{code:'INVALID_MARKET'});
  if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_PAGE_SIZE||!Number.isSafeInteger(offset)||offset<0||offset>5000)throw Object.assign(Error('Проверьте страницу B2B Radar'),{code:'INVALID_ARGUMENT'});
  const stores=await getStores();if(!stores||typeof stores!=='object'||Array.isArray(stores))throw Object.assign(Error('Некорректный каталог магазинов SQL'),{code:'CORRUPT_SOURCE'});
  if(storeId&&!Object.hasOwn(stores,storeId))throw Object.assign(Error('Проверьте магазин B2B Radar'),{code:'INVALID_STORE'});
  if(storeId&&market!=='all'&&marketOf(storeId,stores[storeId])!==market)throw Object.assign(Error('Магазин не относится к выбранной площадке'),{code:'INVALID_STORE'});
  const scope=Object.entries(stores).filter(([id,store])=>(!storeId||id===storeId)&&(market==='all'||marketOf(id,store)===market));
  const aggregate=await repository.read({currentPeriod:requested.current,previousPeriod:requested.previous,market,storeId});
  const analyzedCount=Array.isArray(aggregate.rows)?aggregate.rows.length:0,productCount=Number.isSafeInteger(aggregate.productCount)&&aggregate.productCount>=analyzedCount?aggregate.productCount:analyzedCount;
  if(offset>0&&offset>=analyzedCount)throw Object.assign(Error('Запрошенная страница выходит за пределы проанализированного набора B2B Radar'),{code:'INVALID_ARGUMENT'});
  const coverage=buildCoverage(aggregate.rows,aggregate.sources,scope,requested.current,requested.previous);
  const analyzed=analyze({rows:aggregate.rows,summary:aggregate.summary,productCount,currentPeriod:requested.current,previousPeriod:requested.previous,coverage,filters:{market,storeId:storeId||null}}),products=analyzed.products.slice(offset,offset+limit);
  return {...analyzed,status:!coverage.current.available&&!coverage.previous.available?'unavailable':coverage.classification==='complete'&&coverage.daily==='complete'?'ready':'partial',filters:{market,storeId:storeId||null},coverage:{...analyzed.coverage,current:coverage.current,previous:coverage.previous,limitations:coverage.limitations},meta:{...analyzed.meta,total:productCount,analyzed:analyzedCount,truncated:productCount>analyzedCount||analyzed.meta?.truncated===true,limit,offset,returned:products.length,categoryTotal:analyzed.categories.length},products,categories:analyzed.categories.slice(0,MAX_PAGE_SIZE),opportunities:analyzed.opportunities.slice(0,100)};
 }
 async function read(options={}){const key=JSON.stringify(options),active=inFlight.get(key);if(active)return active;const pending=load(options);inFlight.set(key,pending);try{return await pending;}finally{if(inFlight.get(key)===pending)inFlight.delete(key);}}
 return Object.freeze({read});
}

module.exports={create,validDay,periods,coverageFor,buildCoverage,MAX_DAYS,MAX_PAGE_SIZE};
