(function(root){'use strict';
 const KINDS={market:'Данные магазина','costs-prices':'Себестоимость и цены','insights-full':'История заказов','insights-today':'Заказы сегодня','insights-funnel':'Воронка Ozon','wb-orders':'Заказы Wildberries','derived-capture':'Внутренняя история'};
 const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
 function state(job,now=Date.now()){
  const current=job?.status||'idle',due=validTime(job?.nextDueAt)?Date.parse(job.nextDueAt):null;
  if(current==='running')return{key:'running',label:'В работе'};
  if(current==='queued')return{key:'waiting',label:'Ожидает запуска'};
  if(current==='error'||current==='unknown'||(job?.errorCodes||[]).length)return{key:'error',label:'Ошибка'};
  if(current==='partial')return{key:'error',label:'Частично'};
  if(job?.nextDueKind==='manual')return{key:'manual',label:'По запросу'};
  if(due!==null&&Number(now)>due+60000)return{key:'delayed',label:'Задержка'};
  if(validTime(job?.lastSuccessAt))return{key:'ready',label:'По расписанию'};
  return{key:'waiting',label:'Ожидает данные'};
 }
 function rows(value,now=Date.now()){
  const priority={error:0,delayed:1,running:2,waiting:3,ready:4,manual:5};
  return (Array.isArray(value?.jobs)?value.jobs:[]).map(job=>({...job,title:KINDS[job.kind]||'Обновление данных',view:state(job,now)})).sort((a,b)=>priority[a.view.key]-priority[b.view.key]||String(a.storeName||'Общие данные').localeCompare(String(b.storeName||'Общие данные'),'ru')||a.title.localeCompare(b.title,'ru'));
 }
 const model={KINDS,state,rows,validTime};if(typeof module!=='undefined'&&module.exports)module.exports=model;else root.PultDataUpdatesModel=model;
})(typeof window==='undefined'?{}:window);
