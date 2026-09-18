(function(root){'use strict';
 function points(report,key){
  if(report.days===1){const source=key==='orderedRevenue'||key==='orderedUnits'?'orders':'finance';return (report.intraday?.[source]||[]).map(p=>({time:Date.parse(p.at),label:p.at,value:Number.isFinite(p[key])?p[key]:null})).filter(p=>Number.isFinite(p.time)).sort((a,b)=>a.time-b.time)}
  return (report.daily||[]).map(p=>({time:Date.parse(p.date+'T12:00:00Z'),label:p.date,value:Number.isFinite(p[key])?p[key]:null}));
 }
 function totals(report,key){const value=report.metrics?.[key]?.current;return Number.isFinite(value)?value:null}
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
  const from=shiftDate(today,-7),to=shiftDate(today,-1),expected=Array.from({length:7},(_,i)=>shiftDate(from,i));
  if(history?.coverage?.orders!==true||history.days!==7||history.current?.from!==from||history.current?.to!==to||!Array.isArray(history.daily)||history.daily.length!==7)return unavailable('Нет полной истории заказов за 7 завершённых дней.');
  const dates=new Map();
  for(const row of history.daily){if(!expected.includes(row.date)||dates.has(row.date)||!Number.isFinite(row[key])||row[key]<0)return unavailable('Нет полных количественных данных за все 7 дней.');dates.set(row.date,row[key])}
  const sum=[...dates.values()].reduce((a,b)=>a+b,0),average=sum/7;
  if(!Number.isFinite(average))return unavailable('Некорректная история заказов.');
  const start=dayStart(today),end=start+86400000;
  const actual=points(current,key).filter(p=>p.time>=start&&p.time<end&&p.time<=instant).at(-1);
  if(!actual||actual.value===null||actual.value<0)return unavailable('Нет актуальной фактической точки заказов за сегодня.');
  const endValue=Math.max(actual.value,average),projected=[{...actual,forecast:true}];
  for(let at=Math.floor((actual.time-start)/3600000+1)*3600000+start;at<end;at+=3600000)projected.push({time:at,label:new Date(at).toISOString(),value:actual.value+(endValue-actual.value)*(at-actual.time)/(end-actual.time),forecast:true});
  projected.push({time:end,label:'24:00 МСК',value:endValue,forecast:true});
  return {status:'available',reason:null,points:projected,average,endValue};
 }
 const model={points,totals,segments,domain,observation,shiftDate,alignedPoints,comparison,orderForecast};if(typeof module!=='undefined'&&module.exports)module.exports=model;else root.PultStoreChart=model;
})(typeof window==='undefined'?{}:window);
