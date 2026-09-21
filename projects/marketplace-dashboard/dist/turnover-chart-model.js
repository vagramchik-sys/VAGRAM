(function(root){'use strict';
 function points(report,key){
  if(report.days===1){const source=key==='orderedRevenue'||key==='orderedUnits'?'orders':'finance';return (report.intraday?.[source]||[]).map(p=>({time:Date.parse(p.at),label:p.at,value:Number.isFinite(p[key])?p[key]:null})).filter(p=>Number.isFinite(p.time)).sort((a,b)=>a.time-b.time)}
  return (report.daily||[]).map(p=>({time:Date.parse(p.date+'T12:00:00Z'),label:p.date,value:Number.isFinite(p[key])?p[key]:null}));
 }
 function totals(report,key){const value=report.metrics?.[key]?.current;return Number.isFinite(value)?value:null}
 function categoryDailyLine(items,key,from,to,expectedDays){
  const dates=[];for(let at=Date.parse(from+'T12:00:00Z'),last=Date.parse(to+'T12:00:00Z');at<=last;at+=86400000)dates.push(new Date(at).toISOString().slice(0,10));
  const points=dates.map(date=>{const matches=items.map(item=>(item.points||[]).find(point=>point.date===date)).filter(Boolean),values=matches.map(point=>point[key]).filter(Number.isFinite);return {time:Date.parse(date+'T12:00:00Z'),label:date,value:values.length?values.reduce((sum,value)=>sum+value,0):null,partial:matches.some(point=>point.complete!==true)}});
  const knownValues=points.filter(point=>Number.isFinite(point.value)).map(point=>point.value),known=knownValues.length?knownValues.reduce((sum,value)=>sum+value,0):null,complete=points.length===expectedDays&&points.every(point=>Number.isFinite(point.value)&&!point.partial);
  return {points,total:complete?known:null,known,complete};
 }
 function segments(values){const out=[];let current=[];for(const p of values){if(p.value===null){if(current.length)out.push(current);current=[]}else current.push(p)}if(current.length)out.push(current);return out}
 function domain(series){const values=series.flatMap(s=>s.points.filter(p=>p.value!==null).map(p=>p.value));return {min:Math.min(0,...values),max:Math.max(1,...values)}}
 function observation(values,index){
  const point=values[index];if(!point||!Number.isFinite(point.value))return null;
  const before=values[index-1],previous=before&&Number.isFinite(before.value)?before:null;
  return {point,previous,delta:previous?point.value-previous.value:null};
 }
 const dayStart=date=>Date.parse(date+'T00:00:00+03:00');
 function shiftDate(date,days){return new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10)}
 function alignedPoints(report,key,targetDate){
  if(report.days!==1)return [];
  const start=dayStart(report.current.from),target=dayStart(targetDate);
  return points(report,key).filter(p=>p.time>=start&&p.time<start+86400000).map(p=>({...p,originalTime:p.time,time:target+p.time-start}));
 }
 function comparison(current,baseline,key){
  const today=points(current,key).filter(p=>p.value!==null).at(-1)||null,fullDay=totals(baseline,key);
  const cutoff=today?dayStart(baseline.current?.from)+today.time-dayStart(current.current?.from):NaN;
  // Use an earlier observation within one refresh interval; never a later one or interpolation.
  const interval=(key==='orderedRevenue'||key==='orderedUnits'?current.intraday?.ordersIntervalMinutes:current.intraday?.financeIntervalMinutes)||30;
  const previous=points(baseline,key).filter(p=>p.time<=cutoff&&cutoff-p.time<=interval*60000).at(-1);
  const matched=today&&previous&&previous.value!==null?previous:null;
  const delta=matched?today.value-matched.value:null;
  return {today,previous:matched,fullDay,mode:matched?'same-time':fullDay!==null?'full-day':'unavailable',delta,percent:matched&&matched.value>0?delta/matched.value*100:null};
 }
 function orderForecast(current,history,key,{now=Date.now()}={}){
  const instant=new Date(now).getTime(),unavailable=reason=>({status:'unavailable',reason,points:[],average:null,endValue:null});
  if(!Number.isFinite(instant))return unavailable('Неизвестно текущее время.');
  const today=new Date(instant+10800000).toISOString().slice(0,10);
  if(!['orderedRevenue','orderedUnits'].includes(key)||current?.days!==1||current.current?.from!==today||current.current?.to!==today)return unavailable('Прогноз доступен только для заказов за сегодня.');
  const from=shiftDate(today,-21),to=shiftDate(today,-1),expected=[21,14,7].map(days=>shiftDate(today,-days));
  if(history?.coverage?.orders!==true||history.days!==21||history.current?.from!==from||history.current?.to!==to||!Array.isArray(history.daily))return unavailable('Нет полной истории за три предыдущих таких же дня недели.');
  const dates=new Map();
  for(const row of history.daily){if(!expected.includes(row.date))continue;if(dates.has(row.date)||!Number.isFinite(row[key])||row[key]<0)return unavailable('Нет достоверных заказов за все три сопоставимых дня недели.');dates.set(row.date,row[key])}
  if(dates.size!==3)return unavailable('Нужны все три предыдущих таких же дня недели; пропуск не считается нулём.');
  const basis=expected.map(date=>({date,value:dates.get(date)})),sum=[...dates.values()].reduce((a,b)=>a+b,0),average=sum/3;
  if(!Number.isFinite(average))return unavailable('Некорректная история заказов.');
  const start=dayStart(today),end=start+86400000;
  const actual=points(current,key).filter(p=>p.time>=start&&p.time<end&&p.time<=instant).at(-1);
  if(!actual||actual.value===null||actual.value<0)return unavailable('Нет актуальной фактической точки заказов за сегодня.');
  const endValue=Math.max(actual.value,average),projected=[{...actual,forecast:true}];
  for(let at=Math.floor((actual.time-start)/3600000+1)*3600000+start;at<end;at+=3600000)projected.push({time:at,label:new Date(at).toISOString(),value:actual.value+(endValue-actual.value)*(at-actual.time)/(end-actual.time),forecast:true});
  projected.push({time:end,label:'24:00 МСК',value:endValue,forecast:true});
  return {status:'available',reason:null,points:projected,average,endValue,basis,method:'same-weekday-three-weeks'};
 }
 const model={points,totals,categoryDailyLine,segments,domain,observation,shiftDate,alignedPoints,comparison,orderForecast};if(typeof module!=='undefined'&&module.exports)module.exports=model;else root.PultStoreChart=model;
})(typeof window==='undefined'?{}:window);
