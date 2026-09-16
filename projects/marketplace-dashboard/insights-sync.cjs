'use strict';
const fs=require('fs'),path=require('path');
const day=(date=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const shift=(date,days)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
module.exports=function({stores,protect,api,privateDir}){
  const jobs=new Map();
  function file(id){return path.join(privateDir,'insights-'+id+'.json')}
  function read(id){return fs.existsSync(file(id))?JSON.parse(fs.readFileSync(file(id),'utf8')):null}
  async function sync(id){
    const store=stores[id],previousJob=jobs.get(id);if(!store||store.market==='WB'||previousJob?.status==='running'||Date.now()-Date.parse(previousJob?.startedAt)<61000)return;
    const job={status:'running',stage:'Справочник услуг Ozon',startedAt:new Date().toISOString()};jobs.set(id,job);
    const previous=read(id),out={...previous,startedAt:job.startedAt,errors:[],sections:{...previous?.sections}},to=day(),from=shift(to,-59);let key;
    const save=()=>{fs.writeFileSync(file(id)+'.tmp',JSON.stringify(out));fs.renameSync(file(id)+'.tmp',file(id))};
    try{
      key=await protect(store.key,true);
      try{const result=await api(store,key,'/v1/finance/accrual/types',{});if(!Array.isArray(result.accrual_types))throw Error('Ozon: неизвестный формат справочника');out.types=result.accrual_types;out.sections.types={ok:true,updatedAt:new Date().toISOString()};save()}catch(e){out.errors.push('Справочник: '+e.message);out.sections.types={ok:false,error:e.message,lastSuccessAt:previous?.sections?.types?.updatedAt};}
      job.stage='Заказы по дням за 60 дней';
      try{
        const values=[],seen=new Set();
        for(let offset=0;offset<10000;offset+=1000){
          const r=await api(store,key,'/v1/analytics/data',{date_from:from,date_to:to,metrics:['revenue','ordered_units'],dimension:['day'],filters:[],sort:[{key:'revenue',order:'DESC'}],limit:1000,offset});
          if(!Array.isArray(r.result?.data))throw Error('Ozon: неизвестный формат аналитики заказов');
          for(const row of r.result.data){const date=row.dimensions?.[0]?.id;if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||seen.has(date)||!Array.isArray(row.metrics)||row.metrics.length!==2||!row.metrics.every(Number.isFinite))throw Error('Ozon: проверьте структуру ежедневной аналитики');seen.add(date);values.push({date,revenue:row.metrics[0],units:row.metrics[1]})}
          if(r.result.data.length<1000)break;if(offset===9000)throw Error('Ozon: аналитика загружена не полностью');await pause(61000);
        }
        out.orders={period:{from,to},daily:values.sort((a,b)=>a.date.localeCompare(b.date)),updatedAt:new Date().toISOString(),source:'/v1/analytics/data · revenue, ordered_units'};out.sections.orders={ok:true,updatedAt:out.orders.updatedAt};
      }catch(e){out.errors.push('Заказы: '+e.message);out.sections.orders={ok:false,error:e.message,lastSuccessAt:previous?.orders?.updatedAt};}
      out.completedAt=new Date().toISOString();save();job.status=out.errors.length?'partial':'done';job.stage=out.errors.length?'Не все разделы обновлены':'Аналитика обновлена';job.errors=out.errors;
    }catch(e){job.status='error';job.stage='Не удалось обновить аналитику Ozon';}finally{key=null;job.finishedAt=new Date().toISOString()}
  }
  function ensure(){for(const [id,s] of Object.entries(stores)){if(s.market==='WB')continue;const snapshot=read(id),job=jobs.get(id);if(job?.status==='running')continue;const lastAttempt=Date.parse(job?.finishedAt||snapshot?.completedAt||0);if(!lastAttempt||Date.now()-lastAttempt>6*3600000)void sync(id)}}
  return {sync,ensure,read,status:()=>Object.fromEntries(jobs)};
};
module.exports.shift=shift;
