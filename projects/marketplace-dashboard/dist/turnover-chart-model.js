(function(root){'use strict';
 function points(report,key){
  if(report.days===1){const source=key==='orderedRevenue'||key==='orderedUnits'?'orders':'finance';return (report.intraday?.[source]||[]).map(p=>({time:Date.parse(p.at),label:p.at,value:Number.isFinite(p[key])?p[key]:null,...(p.staggered?{staggered:true,sourceFromAt:p.sourceFromAt,sourceToAt:p.sourceToAt}: {})})).filter(p=>Number.isFinite(p.time)).sort((a,b)=>a.time-b.time)}
  return (report.daily||[]).map(p=>({time:Date.parse(p.date+'T12:00:00Z'),label:p.date,value:Number.isFinite(p[key])?p[key]:null}));
 }
 function totals(report,key){const value=report.metrics?.[key]?.current;return Number.isFinite(value)?value:null}
 function categoryDailyLine(items,key,from,to,expectedDays){
  const dates=[];for(let at=Date.parse(from+'T12:00:00Z'),last=Date.parse(to+'T12:00:00Z');at<=last;at+=86400000)dates.push(new Date(at).toISOString().slice(0,10));
  const points=dates.map(date=>{const matches=items.map(item=>(item.points||[]).find(point=>point.date===date)).filter(Boolean),values=matches.filter(point=>point.observed!==false).map(point=>point[key]).filter(Number.isFinite);return {time:Date.parse(date+'T12:00:00Z'),label:date,value:values.length?values.reduce((sum,value)=>sum+value,0):null,partial:matches.length!==items.length||values.length!==items.length||matches.some(point=>point.complete!==true)}});
  const knownValues=points.filter(point=>Number.isFinite(point.value)).map(point=>point.value),known=knownValues.length?knownValues.reduce((sum,value)=>sum+value,0):null,complete=points.length===expectedDays&&points.every(point=>Number.isFinite(point.value)&&!point.partial);
  return {points,total:complete?known:null,known,complete};
 }
 function combineMarketplaceLines(lines,{days=1,metric,maxSkewMs=30*60000}={}){
  const empty={points:[],total:null,complete:false,includedIds:[],missingIds:[]};
  if(!Array.isArray(lines)||!['orderedRevenue','orderedUnits'].includes(metric)||!Number.isFinite(maxSkewMs)||maxSkewMs<0)return empty;
  const ozon=lines.find(line=>line?.market==='Ozon'&&line.id===''),seenWb=new Set(),wb=lines.filter(line=>{if(line?.market!=='WB'||seenWb.has(line.id))return false;seenWb.add(line.id);return true}),selected=[...(ozon?[ozon]:[]),...wb],id=line=>line.id||'ozon-total',includedIds=selected.map(id),covered=line=>line&&!line.error&&!line.unavailable&&line.coverage!==false&&line.report?.coverage?.orders!==false;
  const missingIds=selected.filter(line=>!covered(line)||!Array.isArray(line.points)||!line.points.some(point=>Number.isFinite(point?.value))).map(id);
  if(!selected.length)return empty;
  if(days!==1){
   const dates=[...new Set(selected.flatMap(line=>(line.points||[]).map(point=>point.label).filter(label=>/^\d{4}-\d{2}-\d{2}$/u.test(label))))].sort(),maps=selected.map(line=>new Map((line.points||[]).map(point=>[point.label,point])));
   const combined=dates.map(date=>{const source=selected.map((line,index)=>({id:id(line),point:maps[index].get(date)})),complete=source.every(({id:sourceId,point})=>!missingIds.includes(sourceId)&&Number.isFinite(point?.value)&&point.partial!==true),value=complete?source.reduce((sum,row)=>sum+row.point.value,0):null;return{time:Date.parse(date+'T12:00:00Z'),label:date,value:metric==='orderedRevenue'&&value!==null?Math.round(value*100)/100:value,partial:!complete,sources:source.filter(row=>row.point).map(row=>({id:row.id,date}))}}),complete=missingIds.length===0&&combined.length>0&&combined.every(point=>!point.partial);
   return{points:combined,total:complete?combined.reduce((sum,point)=>sum+point.value,0):null,complete,includedIds,missingIds};
  }
  const normalized=selected.map(line=>(line.points||[]).filter(point=>Number.isFinite(point?.time)).slice().sort((a,b)=>a.time-b.time)),events=[...new Set(normalized.flatMap(value=>value.map(point=>point.time)))].sort((a,b)=>a-b),indexes=normalized.map(()=>0),latest=normalized.map(()=>null),combined=[];
  for(const time of events){
   for(let index=0;index<normalized.length;index++)while(indexes[index]<normalized[index].length&&normalized[index][indexes[index]].time<=time)latest[index]=normalized[index][indexes[index]++];
   const source=latest.map((point,index)=>{const from=Number.isFinite(Date.parse(point?.sourceFromAt))?Date.parse(point.sourceFromAt):point?.time,to=Number.isFinite(Date.parse(point?.sourceToAt))?Date.parse(point.sourceToAt):point?.time;return{id:id(selected[index]),point,from,to}}),known=source.every(row=>!missingIds.includes(row.id)&&Number.isFinite(row.point?.value)&&row.point.partial!==true&&Number.isFinite(row.from)&&Number.isFinite(row.to)),from=known?Math.min(...source.map(row=>row.from)):null,to=known?Math.max(...source.map(row=>row.to)):null,skew=known?to-from:null,complete=known&&skew<=maxSkewMs,value=complete?source.reduce((sum,row)=>sum+row.point.value,0):null,point={time:to??time,label:new Date(to??time).toISOString(),value:metric==='orderedRevenue'&&value!==null?Math.round(value*100)/100:value,partial:!complete,sourceFromAt:from===null?null:new Date(from).toISOString(),sourceToAt:to===null?null:new Date(to).toISOString(),sourceSkewMs:skew,staggered:complete&&skew>0,sources:source.filter(row=>row.point).map(row=>({id:row.id,at:new Date(row.point.time).toISOString(),sourceFromAt:Number.isFinite(row.from)?new Date(row.from).toISOString():null,sourceToAt:Number.isFinite(row.to)?new Date(row.to).toISOString():null}))};
   if(combined.at(-1)?.time===point.time)combined[combined.length-1]=point;else combined.push(point);
  }
  const latestPoint=combined.at(-1),complete=missingIds.length===0&&Number.isFinite(latestPoint?.value);
  return{points:combined,total:complete?latestPoint.value:null,complete,includedIds,missingIds};
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
 const model={points,totals,categoryDailyLine,combineMarketplaceLines,segments,domain,observation,shiftDate,alignedPoints,comparison,orderForecast};if(typeof module!=='undefined'&&module.exports)module.exports=model;else root.PultStoreChart=model;
})(typeof window==='undefined'?{}:window);
