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
 function observationHourly(day,metric,at){
  if(day?.basis!=='observation')return null;
  const dayStart=start(day.date),points=(day._points||normalized(day)).filter(point=>point.at>=dayStart&&point.at<dayStart+DAY&&point.at<=at&&point.complete===true&&finite(valueOf(point,metric))),last=points.at(-1);
  if(!last||at-last.at>45*60000)return null;
  const previous=points.slice(0,-1).filter(point=>last.at-point.at>=30*60000&&last.at-point.at<=90*60000).sort((a,b)=>Math.abs(last.at-a.at-3600000)-Math.abs(last.at-b.at-3600000))[0];
  if(!previous)return null;
  const delta=valueOf(last,metric)-valueOf(previous,metric);
  return delta>=0?{value:delta*3600000/(last.at-previous.at),from:iso(previous.at),to:iso(last.at)}:null;
 }
 function forecastSample(day,offset){
  if(!day||!finite(offset)||offset<0||offset>DAY)return null;
  if(day.basis==='order-time')return sample(day,offset,{exact:true});
  if(day.basis!=='observation')return null;
  const target=start(day.date)+offset,point=(day._points||normalized(day)).findLast(row=>row.at<=target);
  return point&&point.complete===true&&target-point.at<=2*STEP?point:null;
 }
 function forecastCombined(stores,date,offset,metric){
  const rows=stores.map(store=>{const day=dayFor(store,date),point=forecastSample(day,offset);return {store,day,point}}),valid=rows.filter(row=>finite(valueOf(row.point,metric)));
  const complete=rows.length>0&&new Set(rows.map(row=>row.day?.basis)).size===1&&rows.every(row=>row.day?.complete===true&&row.point?.complete===true&&finite(valueOf(row.point,metric)));
  const components=add(valid.map(row=>row.point));
  return {value:valueOf(components,metric),...components,complete,rows};
 }
 const sumTail=(rows,count)=>rows.length>=count&&rows.slice(-count).every(row=>row.complete&&finite(row.value))?rows.slice(-count).reduce((sum,row)=>sum+row.value,0):null;
 function targetFor(payload,{date,metric,stores,allStores}){
  const candidate=payload?.target;if(!candidate||typeof candidate!=='object')return null;
  const amount=Number(candidate.amountCents),scope=candidate.scope,stamp=Date.parse(candidate.updatedAt);
  if(candidate.date!==date||metric!=='orderedRevenue'||!Number.isSafeInteger(amount)||amount<=0||candidate.currency!=='RUB'||candidate.timeZone!=='Europe/Moscow'||!finite(stamp)||!scope||typeof scope!=='object')return null;
  const ids=stores.map(store=>String(store.id)).sort(),allIds=allStores.map(store=>String(store.id)).sort(),sameAll=ids.length===allIds.length&&ids.every((id,index)=>id===allIds[index]);
  if(scope.type==='all'){if(!sameAll)return null;}
  else if(scope.type==='marketplace'){if(!['Ozon','WB'].includes(scope.marketplace)||!sameAll||stores.some(store=>store.market!==scope.marketplace))return null;}
  else if(scope.type==='store'){if(!sameAll||ids.length!==1||ids[0]!==String(scope.storeId))return null;}
  else return null;
  return amount/100;
 }
 function qualityFor(stores,date,at,offset,metric){
  function inspect(rows){
   const current=finite(offset)?combined(rows,date,offset,metric,{exact:true}):{complete:false},previous=finite(offset)?combined(rows,shift(date,-1),offset,metric,{exact:true,fullDay:true}):{complete:false};
   const comparable=current.complete&&previous.complete&&sameBasis(rows,date,shift(date,-1));
   const issues=[],codes=new Set(),addIssue=(code,severity,message)=>{if(!codes.has(code)){codes.add(code);issues.push({code,severity,message})}},failed=rows.filter(store=>(store.sources||[]).some(source=>source?.error===true)),missing=rows.filter(store=>!dayFor(store,date)?._points?.length);
   if(!rows.length)addIssue('NO_STORES','error','Нет выбранных магазинов.');
   if(failed.length)addIssue('SOURCE_ERROR','error','Источник сообщил ошибку последнего обновления.');
   if(missing.some(store=>!failed.includes(store)))addIssue('MISSING_CURRENT','error','Нет текущих точек по части магазинов.');
   if(rows.length&&!current.complete)addIssue('PARTIAL_CURRENT','warning','Текущий общий срез неполный.');
   if(rows.some(store=>!failed.includes(store)&&(()=>{const stamp=Date.parse(store.updatedAt);return !finite(stamp)||stamp>at||at-stamp>45*60000})()))addIssue('STALE_SOURCE','warning','Источник не обновлялся более 45 минут.');
   if(rows.some(store=>store.market==='Ozon'&&dayFor(store,date)?.basis!=='order-time'))addIssue('NO_ORDER_TIME','info','Ozon не передал подтверждённые времена заказов по 15-минутным интервалам.');
   if(rows.length&&!comparable)addIssue('NO_EXACT_COMPARISON','info','Нет точного сопоставимого среза вчера.');
   if(rows.length&&finite(offset)&&Array.from({length:7},(_,i)=>shift(date,-i-1)).some(target=>{const historical=combined(rows,target,offset,metric,{exact:true,fullDay:true});return !historical.complete||!sameBasis(rows,date,target)}))addIssue('HISTORY_GAPS','info','Нет семи полных сопоставимых исторических дней.');
   const penalty={error:35,warning:20,info:10};
   return {score:Math.max(0,100-issues.reduce((sum,issue)=>sum+penalty[issue.severity],0)),issues};
  }
  const overall=inspect(stores),byMarket={};
  for(const market of ['Ozon','WB']){const rows=stores.filter(store=>store.market===market);if(rows.length)byMarket[market]=inspect(rows)}
  return {...overall,byMarket};
 }
 function forecast(stores,date,offset,current,metric,velocityRatio){
  const unavailable=reason=>({value:null,available:false,reason,sampleSize:0,points:[]});
  if(!metrics[metric]?.additive)return unavailable('Прогноз отношения требует отдельных подтверждённых компонентов.');
  if(!current.complete||!(current.value>0)||offset<2*3600000||offset>=DAY)return unavailable('Недостаточно сопоставимых текущих данных для прогноза.');
  let history=[];
  for(let n=1;n<=28;n++){
   const target=shift(date,-n),partial=forecastCombined(stores,target,offset,metric),days=stores.map(store=>dayFor(store,target));
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
   const samples=history.map(row=>{const p=forecastCombined(stores,row.date,next,metric);return p.complete?{share:p.value/row.final,weight:row.weight}:null});
   if(samples.some(row=>!row||row.share<share||row.share>1))continue;
   const progress=samples.reduce((sum,row)=>sum+row.share*row.weight,0)/weight;
   points.push({at:iso(start(date)+next),cumulative:current.value+(value-current.value)*(progress-share)/(1-share)});
  }
  points.push({at:iso(start(date)+DAY),cumulative:value});
  const projections=history.map(row=>current.value/row.share),projectionCenter=median(projections),spread=projectionCenter>0?(Math.max(...projections)-Math.min(...projections))/projectionCenter:null;
  return {value,available:true,sampleSize:history.length,spread,points,method:'historical-share',reason:null};
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
  // A WB fetch can end inside a 15-minute bucket. Keep that newer known total
  // for Today, but compare and forecast at the last fully observed bucket.
  const lastCompleteOffset=allEvents?offsets.filter(t=>combined(stores,date,t,metric,{exact:true}).complete).at(-1):offset;
  const comparisonOffset=allEvents&&finite(offset)&&finite(lastCompleteOffset)&&offset-lastCompleteOffset<=STEP?lastCompleteOffset:offset;
  const comparisonCurrent=finite(comparisonOffset)?combined(stores,date,comparisonOffset,metric,{exact:true}):{value:null,complete:false};
  for(const t of offsets){const row=combined(stores,date,t,metric),exact=combined(stores,date,t,metric,{exact:true}),previous=combined(stores,shift(date,-1),t,metric,{exact:true,fullDay:true}),comparable=exact.complete&&previous.complete&&sameBasis(stores,date,shift(date,-1));today.push({at:iso(base+t),cumulative:row.allStoresKnown?row.value:null,complete:exact.complete,basis:allEvents?'order-time':'observation',last15:intervalValue(stores,date,t-STEP,t,metric),orders:row.orderCount,units:row.orderedUnits,avgCheck:row.orderCount>0&&finite(row.orderedRevenue)?row.orderedRevenue/row.orderCount:null,ozon:row.ozon,wb:row.wb,yesterday:comparable?previous.value:null,vsYesterdayPct:comparable?percent(row.value,previous.value):null});}
  // A staggered aggregate is explicitly a known subtotal, not an exact-time total.
  // KPI may show a labelled subtotal. The curve must never connect different store compositions.
  const value=finite(offset)?combined(stores,date,offset,metric).value:null;
  const chartUnavailableReason=finite(value)&&!today.some(point=>finite(point.cumulative))?'Общий график появится, когда будут данные всех выбранных магазинов. Известная часть показана в карточке.':null;
  const baseline=finite(comparisonOffset)?combined(stores,shift(date,-1),comparisonOffset,metric,{exact:true,fullDay:true}):{complete:false};
  const prior=finite(comparisonOffset)?dates.map(target=>combined(stores,target,comparisonOffset,metric,{exact:true,fullDay:true})):[];
  const comparable=comparisonCurrent.complete&&baseline.complete&&sameBasis(stores,date,shift(date,-1)),avgComplete=comparisonCurrent.complete&&prior.length===7&&prior.every((row,i)=>row.complete&&sameBasis(stores,date,dates[i])),average=avgComplete?meanMetric(prior,metric):null;
  const yesterday=[],avg7d=[];
  if(finite(offset)){
   for(let t=STEP;t<=DAY;t+=STEP){const previous=combined(stores,shift(date,-1),t,metric,{exact:true,fullDay:true});if(previous.complete&&sameBasis(stores,date,shift(date,-1)))yesterday.push({at:iso(base+t),cumulative:previous.value});}
   for(const t of [...new Set([...Array.from({length:Math.floor(offset/STEP)},(_,i)=>(i+1)*STEP),offset])]){const history=dates.map(target=>combined(stores,target,t,metric,{exact:true,fullDay:true})),currentPoint=combined(stores,date,t,metric,{exact:true});avg7d.push({at:iso(base+t),cumulative:currentPoint.complete&&history.every((row,i)=>row.complete&&sameBasis(stores,date,dates[i]))?meanMetric(history,metric):null});}
  }
  const velocity=[];
  if(finite(offset)&&allEvents&&metadata.additive)for(let to=STEP;to<=offset;to+=STEP){const amount=intervalValue(stores,date,to-STEP,to,metric);velocity.push({from:iso(base+to-STEP),to:iso(base+to),value:amount,complete:finite(amount)})}
  let hour=null,usualHour=null;
  if(velocity.length>=4){const last=velocity.slice(-4),end=Date.parse(last.at(-1).to)-base,vals=dates.map(target=>Array.from({length:4},(_,i)=>intervalValue(stores,target,end-(i+1)*STEP,end-i*STEP,metric)));if(last.every(row=>row.complete)&&vals.every(rows=>rows.every(finite))){hour=last.reduce((sum,row)=>sum+row.value,0);usualHour=vals.reduce((sum,rows)=>sum+rows.reduce((s,v)=>s+v,0),0)/7;}}
  const prediction=date===new Date(at+10800000).toISOString().slice(0,10)?forecast(stores,date,comparisonOffset,comparisonCurrent,metric,usualHour>0?hour/usualHour:null):{value:null,available:false,reason:'Прогноз доступен только для сегодня.',sampleSize:0,points:[]};
  if(!stores.length)notices.push('Выберите магазины.');
  if(finite(value)&&today.some(point=>!finite(point.cumulative)))notices.push('Общая линия начинается только после появления данных всех выбранных магазинов. Ранние частичные суммы не соединяются с общим итогом.');
  if(stores.length&&!current.complete)notices.push(comparable?'Последний интервал ещё не завершён. Сравнение и прогноз используют предыдущий полный 15-минутный срез.':'Показаны известные значения. Полнота или единое время всех выбранных магазинов не подтверждены; сравнение отключено.');
  if(!allEvents&&stores.length)notices.push('Ozon: накопительные наблюдения на время загрузки. Продажи за 15 минут нельзя вычислить из разницы загрузок.');
  if(!comparable)notices.push('Нет подтверждённых данных вчера на точно такой же момент и по тем же магазинам.');
  const historyDays=prior.filter(row=>row.complete).length;
  if(!avgComplete)notices.push('Сопоставимая история: '+historyDays+' из 7 предыдущих дней. Среднее недоступно.');
  for(const store of stores){const d=dayFor(store,date);if(d?.reason)notices.push(store.name+': '+d.reason);}
  const types=new Set(['price','bid','advertising-enabled','advertising-disabled','budget','promotion','stockout','restock','logistics','commission','manager']);
  const events=(payload?.events||[]).filter(event=>types.has(event.kind)&&Date.parse(event.at)>=base&&Date.parse(event.at)<base+DAY&&Date.parse(event.at)<=at&&(!event.storeId||stores.some(store=>String(store.id)===String(event.storeId))));
  const last15m=allEvents&&metadata.additive?sumTail(velocity,1):null,last60m=allEvents&&metadata.additive?sumTail(velocity,4):null,last3h=allEvents&&metadata.additive?sumTail(velocity,12):null;
  const previousHour=allEvents&&metadata.additive&&velocity.length>=8?velocity.slice(-8,-4):[],previousHourValue=previousHour.length===4&&previousHour.every(row=>row.complete&&finite(row.value))?previousHour.reduce((sum,row)=>sum+row.value,0):null,previousHourChange=percent(last60m,previousHourValue);
  const forecastConfidence=!prediction.available?'unavailable':prediction.sampleSize>=14&&prediction.spread<=.15?'high':prediction.sampleSize>=10&&prediction.spread<=.3?'medium':'low';
  const confirmedTarget=targetFor(payload,{date,metric,stores,allStores:unique}),targetCompletion=finite(confirmedTarget)&&prediction.available?prediction.value/confirmedTarget*100:null,remaining=finite(confirmedTarget)&&current.complete&&finite(value)?Math.max(0,confirmedTarget-value):null,hoursLeft=finite(offset)?Math.max(0,(DAY-offset)/3600000):null,requiredHourly=finite(remaining)&&hoursLeft>0?remaining/hoursLeft:null;
  const executiveStores=stores.map(store=>{const d=dayFor(store,date),latest=(d?._points||[]).filter(point=>point.at<=at&&finite(valueOf(point,metric))).at(-1),latestComplete=(d?._points||[]).filter(point=>point.at<=at&&point.complete===true).at(-1),part=valueOf(latest,metric),storeOffset=d?.basis==='order-time'&&finite(latestComplete?.at)&&finite(latest?.at)&&latest.at-latestComplete.at<=STEP?latestComplete.at-base:offset,commonPoint=finite(storeOffset)?sample(d,storeOffset,{exact:true}):null,commonPart=valueOf(commonPoint,metric),past=finite(storeOffset)?combined([store],shift(date,-1),storeOffset,metric,{exact:true,fullDay:true}):{complete:false},commonConfirmed=commonPoint?.complete===true&&finite(commonPart),storeComparable=commonConfirmed&&past.complete&&sameBasis([store],date,shift(date,-1)),exactVelocity=d?.basis==='order-time'&&metadata.additive&&finite(latestComplete?.at)&&at-latestComplete.at<=45*60000&&(latestComplete.at-base)%STEP===0?sumTail(Array.from({length:Math.floor((latestComplete.at-base)/STEP)},(_,i)=>({value:intervalValue([store],date,i*STEP,(i+1)*STEP,metric),complete:true})),4):null,observedVelocity=metadata.additive?observationHourly(d,metric,at):null,storeVelocity=finite(exactVelocity)?exactVelocity:observedVelocity?.value;return {id:store.id,name:store.name,market:store.market,value:finite(part)?part:null,asOf:finite(latest?.at)?iso(latest.at):null,complete:latest?.complete===true,staggered:latest?.complete===true&&(!commonConfirmed||latest.at!==base+offset),share:null,comparisonToday:storeComparable?commonPart:null,comparisonAsOf:storeComparable?iso(base+storeOffset):null,yesterdaySameTime:storeComparable?past.value:null,changePct:storeComparable?percent(commonPart,past.value):null,velocity:finite(storeVelocity)?storeVelocity:null,...(observedVelocity?{velocityEstimate:true}:{})}});
  const knownStores=executiveStores.filter(store=>finite(store.value)),knownTotal=valueOf(add(knownStores.map(store=>({[metric]:store.value}))),metric);
  if(metadata.additive&&knownTotal>0)for(const store of knownStores)store.share=store.value/knownTotal*100;
  const marketplaces=['Ozon','WB'].map(market=>{
   const marketStores=stores.filter(store=>store.market===market),known=knownStores.filter(store=>store.market===market),marketValue=valueOf(add(known.map(store=>({[metric]:store.value}))),metric);
   const marketOffset=market==='WB'?executiveStores.filter(store=>store.market===market&&store.comparisonAsOf).map(store=>Date.parse(store.comparisonAsOf)-base).sort((a,b)=>a-b)[0]:offset;
   const exact=finite(marketOffset)?combined(marketStores,date,marketOffset,metric,{exact:true}):{complete:false},past=finite(marketOffset)?combined(marketStores,shift(date,-1),marketOffset,metric,{exact:true,fullDay:true}):{complete:false};
   const marketComparable=exact.complete&&past.complete&&sameBasis(marketStores,date,shift(date,-1));
   const marketPaces=executiveStores.filter(store=>store.market===market),marketVelocity=metadata.additive&&marketPaces.length===marketStores.length&&marketPaces.every(store=>finite(store.velocity))?marketPaces.reduce((sum,store)=>sum+store.velocity,0):null;
   return {market,value:marketValue,share:metadata.additive&&knownTotal>0&&finite(marketValue)?marketValue/knownTotal*100:null,changePct:marketComparable?percent(exact.value,past.value):null,velocity:finite(marketVelocity)?marketVelocity:null,...(!exact.complete||known.length!==marketStores.length?{partial:true}:{})};
  }).filter(row=>stores.some(store=>store.market===row.market));
  const dataQuality=qualityFor(stores,date,at,comparisonOffset,metric),insights=[],signedPct=number=>{const value=Math.abs(number).toFixed(1).replace('.',',');return (number>0?'+':number<0?'−':'')+value+'%'};
  const expectedIntervals=Math.min(96,Math.max(0,Math.floor((Math.min(at,base+DAY)-base)/STEP)));
  const sourceStatus=stores.map(store=>{
   const d=dayFor(store,date),source=(store.sources||[])[0]||{},points=d?._points||[];
   const observedIntervals=d?.basis==='order-time'?points.filter(point=>point.complete===true).length:new Set(points.filter(point=>point.complete===true).map(point=>Math.floor((point.at-base)/STEP))).size;
   const storeComparisonAt=executiveStores.find(row=>row.id===store.id)?.comparisonAsOf;
   const storeCutoff=storeComparisonAt?Date.parse(storeComparisonAt)-base:comparisonOffset;
   const historyCompleteDays=Array.from({length:28},(_,i)=>shift(date,-i-1)).filter(target=>{
    const past=dayFor(store,target),sampled=forecastSample(past,storeCutoff);
    return past?.complete===true&&past.basis===d?.basis&&sampled?.complete===true&&finite(valueOf(sampled,metric));
   }).length;
   return {id:store.id,name:store.name,market:store.market,basis:d?.basis||'unavailable',lastSuccessAt:store.updatedAt||null,expectedNextAt:source.expectedNextAt||null,observedIntervals,expectedIntervals,missingIntervals:Math.max(0,expectedIntervals-observedIntervals),yesterdayComparable:executiveStores.some(row=>row.id===store.id&&finite(row.yesterdaySameTime)),historyCompleteDays,error:source.error===true};
  });
  const overallChange=comparable?percent(comparisonCurrent.value,baseline.value):null;
  if(finite(overallChange))insights.push({id:'change-vs-yesterday',kind:'fact',value:overallChange,message:(metadata.label||'Показатель')+': '+signedPct(overallChange)+' к тому же времени вчера'+(comparisonOffset!==offset?' (последний полный 15-минутный срез)':'')+'.'});
  const comparableStores=executiveStores.filter(store=>finite(store.changePct)),growing=comparableStores.filter(store=>store.changePct>0).sort((a,b)=>b.changePct-a.changePct||String(a.name).localeCompare(String(b.name),'ru'))[0],lagging=comparableStores.filter(store=>store.changePct<0).sort((a,b)=>a.changePct-b.changePct||String(a.name).localeCompare(String(b.name),'ru'))[0];
  if(growing)insights.push({id:'strongest-growing-store',kind:'fact',value:growing.changePct,message:growing.name+': '+signedPct(growing.changePct)+' к тому же времени вчера — максимальный сопоставимый рост.'});
  if(lagging)insights.push({id:'strongest-lagging-store',kind:'fact',value:lagging.changePct,message:lagging.name+': '+signedPct(lagging.changePct)+' к тому же времени вчера — максимальное сопоставимое снижение.'});
  const forecastVsTarget=prediction.available&&finite(confirmedTarget)?percent(prediction.value,confirmedTarget):null;
  if(finite(forecastVsTarget))insights.push({id:'forecast-vs-target',kind:'fact',value:forecastVsTarget,message:'Прогноз к 24:00: '+signedPct(forecastVsTarget)+' к подтверждённой цели.'});
  if(!insights.length){const reasons=dataQuality.issues.slice(0,2).map(issue=>issue.message).join(' ');insights.push({id:'data-quality',kind:'quality',value:dataQuality.score,message:'Сопоставимый вывод пока недоступен.'+(reasons?' '+reasons:'')});}
  if(insights.length>4)insights.length=4;
  const currentPaceHourly=metadata.additive&&executiveStores.length&&executiveStores.every(store=>finite(store.velocity))?executiveStores.reduce((sum,store)=>sum+store.velocity,0):null,paceEstimated=finite(currentPaceHourly)&&executiveStores.some(store=>store.velocityEstimate===true);
  const executive={today:value,comparisonToday:comparable?comparisonCurrent.value:null,comparisonAsOf:comparable?iso(base+comparisonOffset):null,yesterdaySameTime:comparable?baseline.value:null,changePct:overallChange,last15m,last60m,last3h,currentPaceHourly,paceEstimated,previousHourChange,forecastConfidence,target:confirmedTarget,targetCompletion,remaining,requiredHourly,marketplaces,stores:executiveStores,dataQuality,sourceStatus,insights};
  return {state:!finite(value)?'empty':current.complete?'ready':'partial',chartUnavailableReason,chartCaption:allEvents?'Факт показан только до общего среза данных':'Накопительные значения на время загрузки · одинаковый состав магазинов',date,asOf:finite(offset)?iso(base+offset):null,updatedAt,timezone:'Europe/Moscow',metric:metadata,kpis:{today:{value,subtitle:current.complete?'Подтверждённый срез':allEvents&&comparisonCurrent.complete?'Данные на время загрузки · текущий интервал ещё не закрыт':'Известная часть · покрытие не подтверждено'},yesterdayAtSameTime:{value:comparable?baseline.value:null,reason:comparable?null:'Нет сопоставимого среза'},pace:{value:overallChange,reason:baseline.value===0?'Вчерашняя база равна нулю':null},forecast:prediction},series:{today,yesterday,avg7d,forecast:prediction.points},velocity,velocityComparison:{value:percent(hour,usualHour),reason:usualHour===null?'Нет полного часа и 7 сопоставимых исторических интервалов.':null},stores:stores.map(store=>{const d=dayFor(store,date),last=d?._points?.filter(point=>point.at<=at).at(-1);return{id:store.id,name:store.name,market:store.market,value:valueOf(last,metric),complete:last?.complete===true,updatedAt:store.updatedAt}}),executive,events,notices:[...new Set(notices)],historyAvailable:avgComplete,comparisonLabel:'Среднее ровно за предыдущие 7 дней · на тот же момент МСК',forecastLabel:prediction.available?'Исторический профиль '+prediction.sampleSize+' дней из последних 28; тот же день недели имеет двойной вес'+(comparisonOffset!==offset?' · последний полный интервал':'')+'.':prediction.reason,comparison:{avg7dSameTime:average,vsAvg7dPct:percent(comparisonCurrent.value,average),sampleSize:historyDays}};
 }
 const api={build,normalized,sample,combined,intervalValue,observationHourly,forecast,shift,start,percent,metrics};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PultBusinessDynamicsModel=api;
})(typeof window==='undefined'?{}:window);
