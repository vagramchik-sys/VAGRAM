'use strict';
const fs=require('node:fs'),path=require('node:path');
const INTERVAL=30*60*1000,HOST='https://statistics-api.wildberries.ru',ROUTE='/api/v1/supplier/orders';
const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
function instant(value){
 if(typeof value!=='string')return NaN;
 if(/[zZ]|[+-]\d\d:\d\d$/.test(value))return Date.parse(value);
 const match=value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/);
 return match?Date.parse(match[1]+(match[2]?'.'+match[2].slice(0,3):'')+'+03:00'):NaN;
}
function normalize(rows,targetDay,{fetchedAt=new Date().toISOString()}={}){
 if(!Array.isArray(rows))throw Error('WB вернул неизвестный формат заказов.');
 const unique=new Map();let invalid=0;
 for(const raw of rows){
  const at=instant(raw?.date),id=typeof raw?.srid==='string'?raw.srid.trim():'',changed=instant(raw?.lastChangeDate),hasAmount=raw?.priceWithDisc!==null&&raw?.priceWithDisc!==undefined&&raw?.priceWithDisc!=='',amount=Number(raw?.priceWithDisc);
  if(!id||!Number.isFinite(at)||day(at)!==targetDay||!hasAmount||!Number.isFinite(amount)||amount<0){invalid++;continue}
  const nmId=raw?.nmId??raw?.nmID,item={id,at,changed:Number.isFinite(changed)?changed:at,amount:Math.round(amount*100)/100,cancelled:raw.isCancel===true,nmId:nmId===null||nmId===undefined?null:String(nmId),category:typeof raw?.category==='string'?raw.category.trim():null,subject:typeof raw?.subject==='string'?raw.subject.trim():null};
  const previous=unique.get(id);if(!previous||item.changed>=previous.changed)unique.set(id,item);
 }
 if(invalid)throw Error('WB вернул неполные поля заказов; итог не рассчитан.');
 const active=[...unique.values()].filter(item=>!item.cancelled).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
 let orderedRevenue=0,orderedUnits=0;const points=[];
 for(const item of active){orderedRevenue=Math.round((orderedRevenue+item.amount)*100)/100;orderedUnits++;const previous=points.at(-1);if(previous?.time===item.at){previous.orderedRevenue=orderedRevenue;previous.orderedUnits=orderedUnits}else points.push({time:item.at,orderedRevenue,orderedUnits})}
 const fetched=Date.parse(fetchedAt),last=points.at(-1);
 if(!last||Number.isFinite(fetched)&&fetched>last.time)points.push({time:fetched,orderedRevenue,orderedUnits});
 return {day:targetDay,fetchedAt,complete:true,orderedRevenue,orderedUnits,points:points.map(point=>({at:new Date(point.time).toISOString(),orderedRevenue:point.orderedRevenue,orderedUnits:point.orderedUnits})),orders:active.map(item=>({at:new Date(item.at).toISOString(),amount:item.amount,nmId:item.nmId,category:item.category,subject:item.subject})),orderRows:unique.size,activeRows:active.length,cancelledRows:[...unique.values()].filter(item=>item.cancelled).length,currency:'RUB',amountBasis:'priceWithDisc'};
}
function create({stores,privateDir,protect,fetchImpl=fetch,now=()=>Date.now(),intervalMs=INTERVAL}){
 const running=new Map(),file=id=>path.join(privateDir,'wb-orders-'+id+'.json');
 function readState(id){try{return JSON.parse(fs.readFileSync(file(id),'utf8').replace(/^\uFEFF/,''))}catch{return null}}
 function writeState(id,value){const target=file(id),temporary=target+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value));fs.renameSync(temporary,target)}
 function schedule(id){const state=readState(id),attempt=Date.parse(state?.attemptAt||0),retry=Date.parse(state?.retryAt||0),next=Math.max(Number.isFinite(attempt)?attempt+intervalMs:0,Number.isFinite(retry)?retry:0);return {attemptAt:state?.attemptAt||null,nextAt:next?new Date(next).toISOString():null,running:running.has(id),errorCode:state?.errorCode||null,error:state?.error||null}}
 async function sync(id){
  if(running.has(id))return running.get(id);const store=stores[id];if(!store||store.market!=='WB')throw Error('Выберите магазин Wildberries.');
  const task=(async()=>{const previous=readState(id)||{},attemptAt=new Date(now()).toISOString(),targetDay=day(now());writeState(id,{...previous,attemptAt});let key;
   try{key=await protect(store.key,true);const query=new URLSearchParams({dateFrom:targetDay,flag:'1'}),response=await fetchImpl(HOST+ROUTE+'?'+query,{headers:{Authorization:key},signal:AbortSignal.timeout(120000)});
    if(response.status===401||response.status===403)throw Object.assign(Error('Токен WB не даёт доступ к категории Statistics для отчёта заказов.'),{code:'statistics_scope'});
    if(response.status===429){const raw=response.headers?.get?.('Retry-After')||response.headers?.get?.('X-Ratelimit-Retry'),seconds=Number(raw),retryAfterMs=Number.isFinite(seconds)&&seconds>0?seconds*1000:3*60*60*1000;throw Object.assign(Error('WB ограничил частоту отчёта заказов; сохранён последний успешный снимок.'),{code:'rate_limit',retryAfterMs})}
    if(!response.ok)throw Object.assign(Error('WB временно не отдал отчёт заказов ('+response.status+').'),{code:'upstream'});
    const snapshot=normalize(await response.json(),targetDay,{fetchedAt:new Date(now()).toISOString()}),state={...snapshot,attemptAt,error:null,errorCode:null,retryAt:null,source:ROUTE,intervalMinutes:intervalMs/60000};writeState(id,state);return state;
   }catch(error){const state={...previous,attemptAt,error:error.message,errorCode:error.code||'unavailable',retryAt:error.retryAfterMs?new Date(now()+error.retryAfterMs).toISOString():null};writeState(id,state);return state}finally{key=null}
  })();running.set(id,task);try{return await task}finally{running.delete(id)}}
 async function refresh(id){const state=readState(id),attempt=Date.parse(state?.attemptAt||0),retry=Date.parse(state?.retryAt||0);return (!Number.isFinite(attempt)||now()-attempt>=intervalMs)&&(!Number.isFinite(retry)||now()>=retry)?sync(id):state}
 function ensure(){for(const [id,store] of Object.entries(stores))if(store.market==='WB')void refresh(id)}
 async function report({storeId,date}={}){
  const store=stores[storeId];if(!store||store.market!=='WB')throw Error('Выберите магазин Wildberries.');const targetDay=date||day(now()),state=await refresh(storeId),available=state?.complete===true&&state.day===targetDay;
  return {days:1,current:{from:targetDay,to:targetDay},metrics:{orderedRevenue:{current:available?state.orderedRevenue:null},orderedUnits:{current:available?state.orderedUnits:null}},intraday:{orders:available?state.points:[],ordersIntervalMinutes:intervalMs/60000},coverage:{orders:available},source:ROUTE,market:'WB',currency:'RUB',amountBasis:'priceWithDisc',fetchedAt:available?state.fetchedAt:null,error:available?null:state?.error||'Нет полного снимка заказов WB за выбранный день.',errorCode:available?null:state?.errorCode||'unavailable',warning:available?state?.error||null:null,refresh:{intervalMinutes:intervalMs/60000,...schedule(storeId)}};
 }
 return {ensure,sync,report,schedule,readState};
}
module.exports={create,normalize,instant,day,INTERVAL,HOST,ROUTE};

