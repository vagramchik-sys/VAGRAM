(function(root){'use strict';
 const DAY=86400000,STEP=900000,finite=Number.isFinite;
 const start=date=>Date.parse(date+'T00:00:00+03:00');
 const shift=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*DAY).toISOString().slice(0,10);
 const iso=at=>finite(at)?new Date(at).toISOString():null;
 const fields=['orderedRevenue','orderedUnits','orderCount'];
 const metrics={orderedRevenue:{key:'orderedRevenue',label:'Заказано на сумму',unit:'rub',additive:true},orderedUnits:{key:'orderedUnits',label:'Количество единиц',unit:'units',additive:true},orderCount:{key:'orderCount',label:'Количество заказов',unit:'orders',additive:true},avgCheck:{key:'avgCheck',label:'Средний чек',unit:'rub',additive:false}};
 const percent=(value,base)=>finite(value)&&finite(base)&&base>0?(value/base-1)*100:null;
 const median=values=>{const a=values.slice().sort((a,b)=>a-b),i=Math.floor(a.length/2);return a.length?(a.length%2?a[i]:(a[i-1]+a[i])/2):null};
 const valueOf=(values,key)=>key==='avgCheck'?(finite(values?.orderedRevenue)&&values?.orderCount>0?values.orderedRevenue/values.orderCount:null):finite(values?.[key])?values[key]:null;
 const dayFor=(store,date)=>(store.days||[]).find(day=>day.date===date);
 function add(rows){return Object.fromEntries(fields.map(key=>[key,rows.length&&rows.every(row=>finite(row?.[key]))?rows.reduce((sum,row)=>sum+row[key],0):null]))}
 const meanMetric=(rows,key)=>key==='avgCheck'?valueOf(add(rows),key):rows.reduce((sum,row)=>sum+row.value,0)/rows.length;
 const sameBasis=(stores,a,b)=>stores.every(store=>dayFor(store,a)?.basis===dayFor(store,b)?.basis);
 function normalized(day){
  if(!day)return [];
  if(day.basis==='order-time'){
   const intervals=(day.intervals||[]).slice().sort((a,b)=>Date.parse(a.to)-Date.parse(b.to));let expected=start(day.date),running={orderedRevenue:0,orderedUnits:0,orderCount:0},complete=true;
   return intervals.map(row=>{const from=Date.parse(row.from),end=Date.parse(row.to),cutoff=Date.parse(day.coverage?.to);const at=row.complete===true?end:finite(cutoff)&&cutoff>=from&&cutoff<=end?cutoff:NaN;complete=complete&&from===expected&&end-from===STEP&&row.complete===true;expected=end;running=add([running,row]);return {at,...running,complete:complete&&fields.slice(0,2).every(key=>finite(running[key])),basis:day.basis}}).filter(point=>finite(point.at));
  }
  return (day.observations||[]).map(row=>({...row,at:Date.parse(row.at),complete:row.complete===true,basis:'observation'})).filter(row=>finite(row.at)).sort((a,b)=>a.at-b.at);
 }
 function sample(day,offset,{exact=false}={}){
  if(!day||!finite(offset)||offset<0||offset>DAY)return null;
  const at=start(day.date)+offset,rows=day._points||normalized(day),point=rows.findLast(row=>row.at<=at);
  // Observation time is not order time. Never interpolate it into an exact comparison.
  if(!point||exact&&point.at!==at)return null;
  return point;
 }
 function prepare(stores){return stores.map(store=>({...store,days:(store.days||[]).map(day=>({...day,_points:normalized(day)}))}))}
 function combined(stores,date,offset,metric,{exact=false,fullDay=false}={}){
  const rows=stores.map(store=>{const day=dayFor(store,date),point=sample(day,offset,{exact});return {store,day,point}}),valid=rows.filter(row=>finite(valueOf(row.point,metric)));
  const complete=rows.length>0&&new Set(rows.map(row=>row.day?.basis)).size===1&&rows.every(row=>row.point?.complete===true&&finite(valueOf(row.point,metric))&&(!fullDay||row.day.complete===true));
  const components=add(valid.map(row=>row.point));
  return {value:valueOf(components,metric),...components,complete,allStoresKnown:rows.length>0&&valid.length===rows.length,rows,ozon:valueOf(add(valid.filter(row=>row.store.market==='Ozon').map(row=>row.point)),metric),wb:valueOf(add(valid.filter(row=>row.store.market==='WB').map(row=>row.point)),metric)};
 }
 function intervalValue(stores,date,fromOffset,toOffset,metric){
  if(!stores.length||toOffset-fromOffset!==STEP)return null;
  const rows=stores.map(store=>{const day=dayFor(store,date);return day?.basis==='order-time'?(day.intervals||[]).find(row=>Date.parse(row.from)===start(date)+fromOffset&&Date.parse(row.to)===start(date)+toOffset&&row.complete===true):null});
  return rows.every(Boolean)?valueOf(add(rows),metric):null;
 }
 function forecast(stores,date,offset,current,metric,velocityRatio){
  const unavailable=reason=>({value:null,available:false,reason,sampleSize:0,points:[]});
  if(!metrics[metric]?.additive)return unavailable('Прогноз отношения требует отдельных подтверждённых компонентов.');
  if(!current.complete||!(current.value>0)||offset<2*3600000||offset>=DAY)return unavailable('Недостаточно сопоставимых текущих данных для прогноза.');
  let history=[];
  for(let n=1;n<=28;n++){
   const target=shift(date,-n),partial=combined(stores,target,offset,metric,{exact:true,fullDay:true}),days=stores.map(store=>dayFor(store,target));
   if(!partial.complete||!sameBasis(stores,date,target)||!days.every(day=>day?.complete===true))continue;
   const final=valueOf(add(days.map(day=>day.totals)),metric),share=partial.value/final;
   if(!(final>0)||!(share>=.05&&share<=1)||partial.value<0)continue;
   history.push({date:target,final,share,weight:n%7===0?2:1});
  }
  if(history.length<7)return unavailable('Нужно не менее 7 полных сопоставимых дней с внутридневной историей за последние 28 дней.');
  const center=median(history.map(row=>row.share)),mad=median(history.map(row=>Math.abs(row.share-center))),dailyCenter=median(history.map(row=>row.final));
  history=history.filter(row=>Math.abs(row.share-center)<=Math.max(.08,3*mad)&&row.final>=dailyCenter*.25&&row.final<=dailyCenter*4);
  if(history.length<7)return unavailable('После исключения выбросов недостаточно истории.');
  const weight=history.reduce((sum,row)=>sum+row.weight,0),share=history.reduce((sum,row)=>sum+row.share*row.weight,0)/weight;
  if(!(share>=.05&&share<1))return unavailable('Историческая доля дня ненадёжна.');
  const base=current.value/share,adjust=finite(velocityRatio)?Math.max(.9,Math.min(1.1,1+(velocityRatio-1)*.2)):1;
  const value=current.value+(base-current.value)*adjust,points=[{at:iso(start(date)+offset),cumulative:current.value}];
  // Shape the remaining curve with the actual historical profile, not elapsed time.
  for(let next=Math.ceil((offset+1)/STEP)*STEP;next<DAY;next+=STEP){
   const samples=history.map(row=>{const p=combined(stores,row.date,next,metric,{exact:true,fullDay:true});return p.complete?{share:p.value/row.final,weight:row.weight}:null});
   if(samples.some(row=>!row||row.share<share||row.share>1))continue;
   const progress=samples.reduce((sum,row)=>sum+row.share*row.weight,0)/weight;
   points.push({at:iso(start(date)+next),cumulative:current.value+(value-current.value)*(progress-share)/(1-share)});
  }
  points.push({at:iso(start(date)+DAY),cumulative:value});
  return {value,available:true,sampleSize:history.length,points,method:'historical-share',reason:null};
 }
 function build(payload,{date=payload?.period?.to,metric='orderedRevenue',selectedIds=[''],now=Date.now()}={}){
  const at=Number(now),base=start(date),metadata=metrics[metric]||{key:metric,label:'Показатель недоступен',unit:'rub',additive:false};
  const unique=[...new Map((payload?.stores||[]).map(store=>[String(store.id),store])).values()],ids=new Set(selectedIds),stores=prepare(unique.filter(store=>ids.has('')||ids.has(String(store.id))));
  const notices=[],offsetLimit=Math.min(DAY,Math.max(0,at-base)),dates=Array.from({length:7},(_,i)=>shift(date,-i-1));
  const timestamps=stores.map(store=>Date.parse(store.updatedAt)).filter(value=>finite(value)&&value<=at),updatedAt=stores.length&&timestamps.length===stores.length?iso(Math.min(...timestamps)):null;
  let offsets=[...new Set(stores.flatMap(store=>(dayFor(store,date)?._points||[]).map(point=>point.at-base).filter(offset=>offset>=0&&offset<=offsetLimit)))].sort((a,b)=>a-b);
  const allEvents=stores.length>0&&stores.every(store=>dayFor(store,date)?.basis==='order-time');
  if(allEvents){const ends=stores.map(store=>dayFor(store,date)?._points?.filter(point=>point.at<=at).at(-1)?.at).filter(finite);if(ends.length===stores.length)offsets=offsets.filter(offset=>base+offset<=Math.min(...ends));}
  const offset=offsets.at(-1),current=finite(offset)?combined(stores,date,offset,metric,{exact:true}):{value:null,complete:false},today=[];
  for(const t of offsets){const row=combined(stores,date,t,metric),exact=combined(stores,date,t,metric,{exact:true}),previous=combined(stores,shift(date,-1),t,metric,{exact:true,fullDay:true}),comparable=exact.complete&&previous.complete&&sameBasis(stores,date,shift(date,-1));today.push({at:iso(base+t),cumulative:row.allStoresKnown?row.value:null,complete:exact.complete,basis:allEvents?'order-time':'observation',last15:intervalValue(stores,date,t-STEP,t,metric),orders:row.orderCount,units:row.orderedUnits,avgCheck:row.orderCount>0&&finite(row.orderedRevenue)?row.orderedRevenue/row.orderCount:null,ozon:row.ozon,wb:row.wb,yesterday:comparable?previous.value:null,vsYesterdayPct:comparable?percent(row.value,previous.value):null});}
  // A staggered aggregate is explicitly a known subtotal, not an exact-time total.
  // KPI may show a labelled subtotal. The curve must never connect different store compositions.
  const value=finite(offset)?combined(stores,date,offset,metric).value:null;
  const chartUnavailableReason=finite(value)&&!today.some(point=>finite(point.cumulative))?'Общий график появится, когда будут данные всех выбранных магазинов. Известная часть показана в карточке.':null;
  const baseline=finite(offset)?combined(stores,shift(date,-1),offset,metric,{exact:true,fullDay:true}):{complete:false};
  const prior=finite(offset)?dates.map(target=>combined(stores,target,offset,metric,{exact:true,fullDay:true})):[];
  const comparable=current.complete&&baseline.complete&&sameBasis(stores,date,shift(date,-1)),avgComplete=current.complete&&prior.length===7&&prior.every((row,i)=>row.complete&&sameBasis(stores,date,dates[i])),average=avgComplete?meanMetric(prior,metric):null;
  const yesterday=[],avg7d=[];
  if(finite(offset))for(const t of [...new Set([...Array.from({length:Math.floor(offset/STEP)},(_,i)=>(i+1)*STEP),offset])]){const previous=combined(stores,shift(date,-1),t,metric,{exact:true,fullDay:true}),history=dates.map(target=>combined(stores,target,t,metric,{exact:true,fullDay:true}));yesterday.push({at:iso(base+t),cumulative:current.complete&&previous.complete&&sameBasis(stores,date,shift(date,-1))?previous.value:null});avg7d.push({at:iso(base+t),cumulative:current.complete&&history.every((row,i)=>row.complete&&sameBasis(stores,date,dates[i]))?meanMetric(history,metric):null});}
  const velocity=[];
  if(finite(offset)&&allEvents&&metadata.additive)for(let to=STEP;to<=offset;to+=STEP){const amount=intervalValue(stores,date,to-STEP,to,metric);velocity.push({from:iso(base+to-STEP),to:iso(base+to),value:amount,complete:finite(amount)})}
  let hour=null,usualHour=null;
  if(velocity.length>=4){const last=velocity.slice(-4),end=Date.parse(last.at(-1).to)-base,vals=dates.map(target=>Array.from({length:4},(_,i)=>intervalValue(stores,target,end-(i+1)*STEP,end-i*STEP,metric)));if(last.every(row=>row.complete)&&vals.every(rows=>rows.every(finite))){hour=last.reduce((sum,row)=>sum+row.value,0);usualHour=vals.reduce((sum,rows)=>sum+rows.reduce((s,v)=>s+v,0),0)/7;}}
  const prediction=date===new Date(at+10800000).toISOString().slice(0,10)?forecast(stores,date,offset,current,metric,usualHour>0?hour/usualHour:null):{value:null,available:false,reason:'Прогноз доступен только для сегодня.',sampleSize:0,points:[]};
  if(!stores.length)notices.push('Выберите магазины.');
  if(finite(value)&&today.some(point=>!finite(point.cumulative)))notices.push('Общая линия начинается только после появления данных всех выбранных магазинов. Ранние частичные суммы не соединяются с общим итогом.');
  if(stores.length&&!current.complete)notices.push('Показаны известные значения. Полнота или единое время всех выбранных магазинов не подтверждены; сравнение отключено.');
  if(!allEvents&&stores.length)notices.push('Ozon: накопительные наблюдения на время загрузки. Продажи за 15 минут нельзя вычислить из разницы загрузок.');
  if(!comparable)notices.push('Нет подтверждённых данных вчера на точно такой же момент и по тем же магазинам.');
  const historyDays=prior.filter(row=>row.complete).length;
  if(!avgComplete)notices.push('Сопоставимая история: '+historyDays+' из 7 предыдущих дней. Среднее недоступно.');
  for(const store of stores){const d=dayFor(store,date);if(d?.reason)notices.push(store.name+': '+d.reason);}
  const types=new Set(['price','bid','advertising-enabled','advertising-disabled','budget','promotion','stockout','restock','logistics','commission','manager']);
  const events=(payload?.events||[]).filter(event=>types.has(event.kind)&&Date.parse(event.at)>=base&&Date.parse(event.at)<base+DAY&&Date.parse(event.at)<=at&&(!event.storeId||stores.some(store=>String(store.id)===String(event.storeId))));
  return {state:!finite(value)?'empty':current.complete?'ready':'partial',chartUnavailableReason,chartCaption:allEvents?'Факт показан только до общего среза данных':'Накопительные значения на время загрузки · одинаковый состав магазинов',date,asOf:finite(offset)?iso(base+offset):null,updatedAt,timezone:'Europe/Moscow',metric:metadata,kpis:{today:{value,subtitle:current.complete?'Подтверждённый срез':'Известная часть · покрытие не подтверждено'},yesterdayAtSameTime:{value:comparable?baseline.value:null,reason:comparable?null:'Нет сопоставимого среза'},pace:{value:comparable?percent(value,baseline.value):null,reason:baseline.value===0?'Вчерашняя база равна нулю':null},forecast:prediction},series:{today,yesterday,avg7d,forecast:prediction.points},velocity,velocityComparison:{value:percent(hour,usualHour),reason:usualHour===null?'Нет полного часа и 7 сопоставимых исторических интервалов.':null},stores:stores.map(store=>{const d=dayFor(store,date),last=d?._points?.filter(point=>point.at<=at).at(-1);return{id:store.id,name:store.name,market:store.market,value:valueOf(last,metric),complete:last?.complete===true,updatedAt:store.updatedAt}}),events,notices:[...new Set(notices)],historyAvailable:avgComplete,comparisonLabel:'Среднее ровно за предыдущие 7 дней · на тот же момент МСК',forecastLabel:prediction.available?'Исторический профиль '+prediction.sampleSize+' дней из последних 28; тот же день недели имеет двойной вес.':prediction.reason,comparison:{avg7dSameTime:average,vsAvg7dPct:percent(value,average),sampleSize:historyDays}};
 }
 const api={build,normalized,sample,combined,intervalValue,forecast,shift,start,percent,metrics};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PultBusinessDynamicsModel=api;
})(typeof window==='undefined'?{}:window);
