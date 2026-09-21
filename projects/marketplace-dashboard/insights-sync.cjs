'use strict';
const fs=require('fs'),path=require('path');
const refresh=require('./refresh-policy.cjs');
const day=(date=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const shift=(date,days)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// Shared by the full and today-only jobs; retain the existing conservative API spacing.
const ANALYTICS_GAP=61000;
module.exports=function({stores,protect,api,privateDir,now=Date.now,sleep=pause,funnel=null}){
  const jobs=new Map(),iso=()=>new Date(now()).toISOString();
  function file(id){return path.join(privateDir,'insights-'+id+'.json')}
  function read(id){return fs.existsSync(file(id))?JSON.parse(fs.readFileSync(file(id),'utf8')):null}
  async function write(id,out){
    fs.writeFileSync(file(id)+'.tmp',JSON.stringify(out));
    // Windows scanners can briefly hold the destination open. Keep the old snapshot
    // intact and the store's job locked while retrying the atomic replacement.
    for(let attempt=0;;attempt++)try{fs.renameSync(file(id)+'.tmp',file(id));return}catch(e){
      if(!['EPERM','EBUSY','EACCES'].includes(e.code)||attempt>=4)throw e;
      await pause(25*2**attempt);
    }
  }
  function attempt(snapshot,source){return source==='full'?snapshot?.fullAttemptAt||snapshot?.startedAt:snapshot?.ordersAttemptAt||snapshot?.startedAt}
  function gate(snapshot){return Math.max((Date.parse(snapshot?.analyticsAttemptAt)||0)+ANALYTICS_GAP,Date.parse(snapshot?.analyticsRetryAt)||0)}
  function state(id,source,snapshot=read(id)){
    const job=jobs.get(id);
    return {job:job?.status==='running'?{status:'running'}:undefined,attemptAt:attempt(snapshot,source),snapshotAt:source==='full'?snapshot?.completedAt:snapshot?.orders?.updatedAt};
  }
  async function run(id,full){
    const store=stores[id],previous=read(id),previousJob=jobs.get(id);
    if(!store||store.market==='WB'||previousJob?.status==='running'||now()<gate(previous)||now()-Date.parse(previousJob?.startedAt)<ANALYTICS_GAP)return;
    const to=day(new Date(now()));
    // A today-only merge must never advertise an unfetched gap as covered history.
    if(!full&&(!previous?.orders?.period||previous.orders.period.to<shift(to,-1)||previous.orders.period.from>to))full=true;
    const from=full?shift(to,-59):to,startedAt=iso();
    const job={status:'running',mode:full?'full':'today',stage:full?'Справочник услуг Ozon':'Заказы за сегодня',startedAt};jobs.set(id,job);
    const out={...previous,ordersAttemptAt:startedAt,sections:{...previous?.sections}};
    if(full){out.startedAt=startedAt;out.fullAttemptAt=startedAt}
    const save=()=>write(id,out);
    const errors=()=>Object.entries(out.sections).filter(([,s])=>s?.ok===false).map(([name,s])=>(name==='types'?'Справочник: ':'Заказы: ')+s.error);
    let key;
    try{
      // Persist even a failed credential/API attempt so a restart does not cause a retry burst.
      await save();key=await protect(store.key,true);
      if(full)try{
        const result=await api(store,key,'/v1/finance/accrual/types',{});
        if(!Array.isArray(result.accrual_types))throw Error('Ozon: неизвестный формат справочника');
        out.types=result.accrual_types;out.sections.types={ok:true,updatedAt:iso()};await save();
      }catch(e){out.sections.types={ok:false,error:e.message,lastSuccessAt:previous?.sections?.types?.updatedAt||previous?.sections?.types?.lastSuccessAt}}
      job.stage=full?'Заказы по дням за 60 дней':'Заказы за сегодня';
      const values=[],skuValues=[],seen=new Set(),detail=!full;
      for(let offset=0;offset<10000;offset+=1000){
        const wait=gate(out)-now();if(wait>0)await sleep(wait);
        out.analyticsAttemptAt=iso();await save();
        const r=await api(store,key,'/v1/analytics/data',{date_from:from,date_to:to,metrics:['revenue','ordered_units'],dimension:detail?['sku','day']:['day'],filters:[],sort:[{key:'revenue',order:'DESC'}],limit:1000,offset});
        if(!Array.isArray(r.result?.data))throw Error('Ozon: неизвестный формат аналитики заказов');
        for(const row of r.result.data){
          const dimensions=Array.isArray(row.dimensions)?row.dimensions:[],date=dimensions.map(v=>String(v?.id??'')).find(v=>/^\d{4}-\d{2}-\d{2}$/.test(v)),sku=detail?dimensions.map(v=>String(v?.id??'')).find(v=>v!==date&&/^\d+$/.test(v)):null,key=detail?date+':'+sku:date;
          if(!date||(detail&&!sku)||date<from||date>to||shift(date,0)!==date||seen.has(key)||!Array.isArray(row.metrics)||row.metrics.length!==2||!row.metrics.every(Number.isFinite)||!Number.isSafeInteger(row.metrics[1])||row.metrics[1]<0)throw Error('Ozon: проверьте структуру аналитики заказов'+(detail?' по SKU':''));
          seen.add(key);(detail?skuValues:values).push(detail?{date,sku,revenue:row.metrics[0],units:row.metrics[1]}:{date,revenue:row.metrics[0],units:row.metrics[1]});
        }
        if(r.result.data.length<1000)break;
        if(offset===9000)throw Error('Ozon: аналитика загружена не полностью');
      }
      if(detail){const aggregate=new Map();for(const row of skuValues){const value=aggregate.get(row.date)||{date:row.date,revenue:0,units:0};value.revenue=Math.round((value.revenue+row.revenue)*100)/100;value.units+=row.units;aggregate.set(row.date,value)}values.push(...aggregate.values())}
      const updatedAt=iso(),daily=full?values:[...(previous?.orders?.daily||[]).filter(row=>row.date!==to),...values],skuDaily=detail?[...(previous?.orders?.skuDaily||[]).filter(row=>row.date!==to),...skuValues]:(previous?.orders?.todayDate===to?previous?.orders?.skuDaily||[]:[]),skuDailyCoverage=detail||previous?.orders?.todayDate===to&&previous?.orders?.skuDailyCoverage===true;
      out.orders={period:{from:full?from:previous?.orders?.period?.from||from,to},daily:daily.sort((a,b)=>a.date.localeCompare(b.date)),skuDaily:skuDaily.sort((a,b)=>a.date.localeCompare(b.date)||String(a.sku).localeCompare(String(b.sku))),skuDailyCoverage,skuUpdatedAt:detail?updatedAt:previous?.orders?.skuUpdatedAt||null,updatedAt,historyUpdatedAt:full?updatedAt:previous?.orders?.historyUpdatedAt||previous?.orders?.updatedAt,todayUpdatedAt:updatedAt,todayDate:to,source:'/v1/analytics/data · revenue, ordered_units'+(skuDailyCoverage?' · today by sku':'')};
      out.sections.orders={ok:true,updatedAt};delete out.analyticsRetryAt;
      out.errors=errors();if(full)out.completedAt=updatedAt;
      await save();job.status=out.errors.length?'partial':'done';job.stage=out.errors.length?'Не все разделы обновлены':full?'Аналитика обновлена':'Заказы за сегодня обновлены';job.errors=out.errors;
    }catch(e){
      if(e.status===429||/\b429\b/.test(e.message||''))out.analyticsRetryAt=new Date(Math.max(now()+refresh.ORDERS_INTERVAL,now()+(Number(e.retryAfterMs)||0),Date.parse(e.retryAt)||0)).toISOString();
      out.sections.orders={ok:false,error:e.message,lastSuccessAt:previous?.orders?.updatedAt};out.errors=errors();
      job.stage='Не удалось обновить заказы Ozon';job.errors=out.errors;
      try{await save()}catch{job.errors=['Не удалось сохранить результат обновления аналитики']}
      job.status='error';
    }finally{key=null;job.finishedAt=iso()}
  }
  const sync=id=>run(id,true),syncToday=id=>run(id,false);
  async function syncFunnel(id){
    const store=stores[id],snapshot=read(id);
    if(!funnel||!store||store.market==='WB'||jobs.get(id)?.status==='running'||now()<gate(snapshot))return;
    // Supplemental analytics never take a slot already due for either orders job.
    if(refresh.due(state(id,'full',snapshot),now())||refresh.due(state(id,'orders',snapshot),now(),refresh.ORDERS_INTERVAL)||!funnel.due(id))return;
    // Reserve the next slot when orders are due within one API spacing interval.
    // Otherwise a supplemental request immediately before the ten-minute refresh would defer orders.
    if(Date.parse(refresh.nextAt(state(id,'orders',snapshot),now(),refresh.ORDERS_INTERVAL))<now()+ANALYTICS_GAP)return;
    const job={status:'running',mode:'funnel',stage:'Воронка Ozon по SKU',startedAt:iso()};jobs.set(id,job);
    const out={...snapshot};let key;
    try{
      const payload=funnel.request(id);if(!payload){job.status='done';return}
      // One page per job: persist the same gate orders use, before any request.
      out.analyticsAttemptAt=iso();await write(id,out);key=await protect(store.key,true);
      const result=await api(store,key,'/v1/analytics/data',payload);
      funnel.accept(id,result);delete out.analyticsRetryAt;await write(id,out);
      job.status='done';job.stage='Страница воронки Ozon получена';
    }catch(e){
      const status=Number(e.status)||Number(/\b(400|403|429)\b/.exec(e.message||'')?.[1])||0;
      if(status===429)out.analyticsRetryAt=new Date(Math.max(now()+refresh.ORDERS_INTERVAL,now()+(Number(e.retryAfterMs)||0),Date.parse(e.retryAt)||0)).toISOString();
      try{funnel.fail(id,{status,retryAfterMs:e.retryAfterMs,retryAt:e.retryAt});await write(id,out)}catch{}
      job.status='error';job.stage='Воронка Ozon временно недоступна';job.errors=['Не удалось получить полную воронку Ozon'];
    }finally{key=null;job.finishedAt=iso()}
  }
  function ensure(){for(const [id,s] of Object.entries(stores))if(s.market!=='WB'){
    const snapshot=read(id);if(now()<gate(snapshot)||jobs.get(id)?.status==='running')continue;
    if(refresh.due(state(id,'full',snapshot),now()))void sync(id);
    else if(refresh.due(state(id,'orders',snapshot),now(),refresh.ORDERS_INTERVAL))void syncToday(id);
    else if(funnel?.due(id))void syncFunnel(id);
  }}
  function schedule(id){
    const snapshot=read(id),result={};
    for(const [source,interval] of [['orders',refresh.ORDERS_INTERVAL],['full',refresh.INTERVAL]]){
      const lastSuccessAt=source==='orders'?snapshot?.orders?.updatedAt:snapshot?.orders?.historyUpdatedAt||snapshot?.completedAt;
      result[source]={intervalMinutes:interval/60000,nextAt:new Date(Math.max(Date.parse(refresh.nextAt(state(id,source,snapshot),now(),interval)),gate(snapshot))).toISOString(),lastAttemptAt:attempt(snapshot,source)||null,lastSuccessAt:lastSuccessAt||null};
    }
    return result;
  }
  function next(id){return Object.values(schedule(id)).map(s=>s.nextAt).sort()[0]}
  return {sync,syncToday,syncFunnel,ensure,read,next,schedule,status:()=>Object.fromEntries(jobs)};
};
module.exports.shift=shift;
