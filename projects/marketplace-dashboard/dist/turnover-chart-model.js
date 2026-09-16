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
  const previous=points(baseline,key).filter(p=>p.time<=cutoff&&cutoff-p.time<=30*60000).at(-1);
  const matched=today&&previous&&previous.value!==null?previous:null;
  const delta=matched?today.value-matched.value:null;
  return {today,previous:matched,fullDay,mode:matched?'same-time':fullDay!==null?'full-day':'unavailable',delta,percent:matched&&matched.value>0?delta/matched.value*100:null};
 }
 const model={points,totals,segments,domain,observation,shiftDate,alignedPoints,comparison};if(typeof module!=='undefined'&&module.exports)module.exports=model;else root.PultStoreChart=model;
})(typeof window==='undefined'?{}:window);
