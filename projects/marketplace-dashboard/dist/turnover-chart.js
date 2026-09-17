(function(){'use strict';
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const num=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}),integer=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
 const short=v=>new Date(v+'T12:00:00Z').toLocaleDateString('ru-RU',{day:'2-digit',month:'short'}),time=v=>new Date(v).toLocaleTimeString('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});
 const colors=['var(--chart-store-1, #158b78)','var(--chart-store-2, #9270cc)','var(--chart-store-3, #d28532)','var(--chart-store-4, #378fbd)'];
 window.createPultStoreChart=function({api,metricTitle}){
  let report=null,catalog=[],selected=new Set(['']),cache=new Map(),version=0,catalogError=null,inspected=null;
  $('ins-chart').closest('.panel').id='business-chart';
  $('ins-chart').insertAdjacentHTML('afterend','<p class="chart-interaction-hint" id="chart-interaction-hint" hidden>Выберите точку мышью или касанием. С клавиатуры: Tab к графику, затем ← →.</p><div class="chart-inspector" id="chart-inspector" hidden><div id="chart-point-label" aria-live="polite"></div><div id="chart-point-value" aria-live="polite"></div><div class="chart-inspector-buttons"><button class="button secondary" id="chart-point-prev" type="button" aria-label="Предыдущая точка графика">←</button><button class="button secondary" id="chart-point-next" type="button" aria-label="Следующая точка графика">→</button></div></div>');
  $('ins-chart').insertAdjacentHTML('beforebegin','<div class="chart-store-picker"><div class="chart-store-picker-title"><span>Магазины на графике</span><div><button id="chart-only-total" type="button">Только общий</button><button id="chart-all-stores" type="button">Все линии</button></div></div><div id="chart-store-options" role="group" aria-label="Магазины на графике"></div><p>Выбор действует только на график. Общий — все подключённые магазины Ozon.</p></div><div id="chart-store-status" role="status" aria-live="polite"></div>');
  const ready=api('/api/stores').then(list=>{catalog=list.filter(s=>!s.id.startsWith('wb-'));renderOptions()}).catch(()=>{catalogError='Не удалось получить список магазинов. Обновите страницу.'});
  function options(){return [{id:'',name:'Общий · все Ozon',color:'var(--chart-total, #315efb)'},...catalog.map((s,i)=>({id:s.id,name:s.name,color:colors[i%colors.length]}))]}
  function renderOptions(){$('chart-store-options').innerHTML=options().map(s=>'<label style="--series-color:'+s.color+'"><input type="checkbox" value="'+esc(s.id)+'" '+(selected.has(s.id)?'checked':'')+'><i></i><span>'+esc(s.name)+'</span></label>').join('')}
  $('chart-store-options').onchange=e=>{if(e.target.type!=='checkbox')return;e.target.checked?selected.add(e.target.value):selected.delete(e.target.value);void render()};
  $('chart-only-total').onclick=()=>{selected=new Set(['']);renderOptions();void render()};
  $('chart-all-stores').onclick=()=>{selected=new Set(options().map(s=>s.id));renderOptions();void render()};
  const comparisons=[{id:'yesterday',days:-1,name:'Вчера',dash:'7 5'},{id:'week',days:-7,name:'Неделю назад',dash:'2 5'}];
  $('chart-store-status').insertAdjacentHTML('beforebegin','<div id="chart-compare-controls" class="chart-compare-controls" role="group" aria-label="Сравнить сегодняшний день" hidden><span>Сравнить с</span>'+comparisons.map(c=>'<label><input type="checkbox" value="'+c.id+'" checked><i class="compare-line '+c.id+'"></i>'+c.name+'</label>').join('')+'<small>Сегодня — сплошная линия</small></div>');
  $('chart-compare-controls').onchange=()=>{void render()};
  const cacheKey=(id,period)=>id+':'+period.from+':'+period.to;
  function getReport(id,period=report.current){const key=cacheKey(id,period);if(cache.has(key))return Promise.resolve(cache.get(key));const query=new URLSearchParams({from:period.from,to:period.to,store:id,hideInactive:String($('hide-inactive').checked)}),request=api('/api/insights?'+query);cache.set(key,request);return request}
  async function render(){
   if(!report)return;const current=report,seq=++version,key=$('ins-chart-metric').value,title=metricTitle(key),oneDay=current.days===1,ratio=key==='ourMargin'||key==='ourRoi',format=v=>v===null?'—':ratio?num.format(v)+' %':key==='orderedUnits'?integer.format(v)+' шт.':num.format(v)+' ₽';
   const formatDelta=v=>ratio?(v===null?'—':num.format(v)+' п.п.'):format(v);
   const isToday=oneDay&&current.current.from===new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
   $('ins-chart-title').textContent=oneDay?(isToday?'Динамика за сегодня':'Динамика за '+short(current.current.from)):'Динамика бизнеса';
   $('chart-compare-controls').hidden=!isToday;
   $('ins-chart-caption').textContent=title+' · '+(oneDay?'накопительно с начала дня · время МСК':short(current.current.from)+' — '+short(current.current.to));
   $('chart-store-status').textContent='Загружаем выбранные линии…';$('ins-chart').setAttribute('aria-busy','true');$('ins-chart').innerHTML='';$('ins-chart-details').hidden=true;$('chart-inspector').hidden=true;$('chart-interaction-hint').hidden=true;
   await ready;if(seq!==version)return;
   if(catalogError){$('chart-store-status').textContent=catalogError;$('ins-chart').removeAttribute('aria-busy');return}
   const chosen=options().filter(s=>selected.has(s.id));
   if(!chosen.length){$('chart-store-status').textContent='Выберите общий показатель или нужные магазины.';$('ins-chart').removeAttribute('aria-busy');return}
   const enabled=isToday?comparisons.filter(c=>$('chart-compare-controls').querySelector('input[value="'+c.id+'"]').checked).map(c=>({...c,date:PultStoreChart.shiftDate(current.current.from,c.days)})):[];
   const requests=chosen.flatMap(s=>[{store:s,compare:null,period:current.current},...enabled.map(c=>({store:s,compare:c,period:{from:c.date,to:c.date}}))]);
   const results=await Promise.allSettled(requests.map(r=>getReport(r.store.id,r.period)));if(seq!==version)return;
   const loaded=requests.map((r,i)=>({...r,report:results[i].status==='fulfilled'?results[i].value:null,error:results[i].status==='rejected'}));
   const series=loaded.filter(r=>!r.compare).map(r=>r.report?{...r.store,report:r.report,points:PultStoreChart.points(r.report,key),total:PultStoreChart.totals(r.report,key)}:{...r.store,points:[],total:null,error:true});
   const historical=loaded.filter(r=>r.compare).map(r=>{
    const fullDay=r.report?PultStoreChart.totals(r.report,key):null,points=r.report?PultStoreChart.alignedPoints(r.report,key,current.current.from):[],reference=!points.some(p=>p.value!==null)&&fullDay!==null;
    return {...r.store,id:(r.store.id||'total')+'@'+r.compare.id,name:r.store.name+' · '+r.compare.name,date:r.compare.date,dash:r.compare.dash,reference,error:r.error,points:reference?[{time:Date.parse(current.current.from+'T00:00:00+03:00')+86400000,label:r.compare.date,value:fullDay}]:points};
   });
   const failed=series.filter(s=>s.error).map(s=>s.name),empty=series.filter(s=>!s.error&&!s.points.some(p=>p.value!==null)).map(s=>s.name);
   const historyFailed=historical.filter(s=>s.error).map(s=>s.name),historyMissing=historical.filter(s=>!s.error&&!s.reference&&!s.points.some(p=>p.value!==null)).map(s=>s.name);
   $('chart-store-status').textContent=[failed.length?'Не удалось загрузить: '+failed.join(', '):'',empty.length?'Нет точек за период: '+empty.join(', '):'',historyFailed.length?'Не удалось загрузить сравнение: '+historyFailed.join(', '):'',historyMissing.length?'Нет данных для сравнения: '+historyMissing.join(', '):'',historical.some(s=>s.reference)?'Для прошлых дней без почасовой истории пунктиром показаны уровни итогов за весь день. Это не оборот на текущее время.':''].filter(Boolean).join(' · ');$('ins-chart').removeAttribute('aria-busy');
   if(ratio&&empty.length){$('chart-store-status').textContent+=' · Для расчёта нужны полные начисления, количество проданных единиц и себестоимость всех продаж. История внутри дня начинается с новых снимков; прежние точки не пересчитываются задним числом.';}
   draw([...series,...historical],current,oneDay,title,format,formatDelta,ratio);
   const details=$('ins-chart-details');details.hidden=false;
   details.innerHTML='<div class="chart-series-totals">'+series.map(s=>{const actual=s.points.filter(p=>p.value!==null),last=actual.at(-1),previous=actual.at(-2),delta=previous?last.value-previous.value:null;return '<div style="--series-color:'+s.color+'"><span><i></i>'+esc(s.name)+'</span><strong>'+format(oneDay?last?.value??null:s.total)+'</strong><small>'+(oneDay&&last?'На '+time(last.time)+(delta===null?' · первая точка':' · '+(delta>0?'+':'')+formatDelta(delta)+' с '+time(previous.time)):s.error?'Ошибка загрузки':s.total===null?'Нет полного периода':'За выбранный период')+'</small></div>'}).join('')+'</div><p>'+ (oneDay?'Точки — накопительные итоги дня на время загрузки. Изменения включают корректировки Ozon. История до первого снимка не восстанавливается.':'Каждая линия показывает выбранный показатель по дням.')+' Общая линия уже включает магазины — складывать её с отдельными линиями не нужно.</p>';
   if(ratio){const gaps=series.filter(s=>s.report?.economics&&!s.report.economics.complete).map(s=>{const e=s.report.economics;return esc(s.name)+': '+[!e.covered?'неполный финансовый период':'',e.missingCostSkus?'нет себестоимости у '+integer.format(e.missingCostSkus)+' SKU':'',e.unknownUnitRows?'не определено количество в '+integer.format(e.unknownUnitRows)+' операциях':'',e.unmappedSaleRows?'продажи без привязки к SKU: '+integer.format(e.unmappedSaleRows):''].filter(Boolean).join(', ')});if(gaps.length)details.insertAdjacentHTML('beforeend','<p><b>Почему нет полного итога:</b> '+gaps.join(' · ')+'. <a href="#economics">Проверить экономику →</a></p>');}
   if(ratio)details.insertAdjacentHTML('beforeend','<p><b>Наш расчёт:</b> прибыль = начисления Ozon после удержаний − себестоимость проданного с учётом возвратов. Маржинальность = прибыль / реализация; ROI = прибыль / себестоимость × 100%. Общий показатель взвешен по суммам, проценты товаров не усредняются. Расчёт по текущей себестоимости, до налогов и внешних расходов. Если данных недостаточно, остаётся пропуск. Данные за сегодня предварительные.</p>');
   if(enabled.length){
    details.querySelector('.chart-series-totals').outerHTML='<div class="chart-comparisons">'+series.map(s=>{
     const today=s.points.filter(p=>p.value!==null).at(-1);
     return '<section class="chart-comparison" style="--series-color:'+s.color+'"><h3>'+esc(s.name)+'</h3><div class="comparison-days"><div class="comparison-today"><span>Сегодня · '+short(current.current.from)+'</span><strong>'+format(today?.value??null)+'</strong><small>'+(today?'На '+time(today.time)+' МСК':'Нет точки загрузки')+'</small></div>'+enabled.map(c=>{
      const past=loaded.find(r=>r.store.id===s.id&&r.compare?.id===c.id),result=PultStoreChart.comparison(s.report||{},past?.report||{},key);
      const value=result.mode==='same-time'?result.previous.value:result.fullDay;
      let note=past?.error?'Не удалось загрузить данные':result.mode==='same-time'?'На '+time(result.previous.time)+' МСК · сегодня '+(result.delta>0?'+':'')+formatDelta(result.delta)+(ratio?'':result.percent===null?' · % не рассчитывается':' ('+(result.percent>0?'+':'')+num.format(result.percent)+'%)'):result.fullDay!==null?'За весь день · сравнение по времени недоступно':'Нет полного дня и сопоставимой точки';
      return '<div><span><i class="compare-line '+c.id+'"></i>'+c.name+' · '+short(c.date)+'</span><strong>'+format(value)+'</strong><small>'+note+'</small>'+(result.mode==='same-time'&&result.fullDay!==null?'<small>За весь день: '+format(result.fullDay)+'</small>':'')+'</div>';
     }).join('')+'</div></section>';
    }).join('')+'</div>';
    details.insertAdjacentHTML('beforeend','<p class="comparison-method">Процент изменения считается только по снимкам на сопоставимое время: прошлый снимок не позднее сегодняшнего и отстаёт не больше чем на 30 минут. Итоги полных дней приведены отдельно; пропуски не заменяются нулями.</p>');
   }
   if(oneDay){const rows=series.flatMap(s=>s.points.filter(p=>p.value!==null).slice(-8).map(p=>({name:s.name,...p}))).sort((a,b)=>b.time-a.time);details.insertAdjacentHTML('beforeend','<details><summary>История загрузок</summary><div class="table-wrap"><table><thead><tr><th>Магазин</th><th>Время МСК</th><th class="numeric">Итог дня</th></tr></thead><tbody>'+rows.map(p=>'<tr><td>'+esc(p.name)+'</td><td>'+time(p.time)+'</td><td class="numeric">'+format(p.value)+'</td></tr>').join('')+'</tbody></table></div></details>')}
  }
  function draw(series,current,oneDay,title,format,formatDelta,ratio){
   if(!series.some(s=>s.points.some(p=>p.value!==null))){$('ins-chart').innerHTML='<div class="empty">График появится после загрузки данных для выбранных магазинов.</div>';return}
   const W=760,H=240,L=70,R=22,T=16,B=38,{min,max}=PultStoreChart.domain(series),start=Date.parse(current.current.from+(oneDay?'T00:00:00+03:00':'T12:00:00Z')),end=oneDay?start+86400000:Date.parse(current.current.to+'T12:00:00Z'),x=t=>L+(W-L-R)*(end===start?.5:(t-start)/(end-start)),y=v=>T+(max-v)/(max-min)*(H-T-B);
   const observations=[];
   let svg='<svg viewBox="0 0 '+W+' '+H+'" role="group" aria-label="'+esc(title)+' · '+esc(series.map(s=>s.name).join(', '))+'">';
   for(let i=0;i<4;i++){const v=min+(max-min)*i/3,yy=y(v);svg+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" stroke="#eaf0f8"/><text x="'+(L-10)+'" y="'+(yy+4)+'" text-anchor="end">'+num.format(Math.abs(v)>=1e6?v/1e6:Math.abs(v)>=1000?v/1000:v)+(Math.abs(v)>=1e6?'м':Math.abs(v)>=1000?'к':'')+(ratio?' %':'')+'</text>'}
   if(oneDay){for(let h=0;h<=24;h+=4)svg+='<text x="'+x(start+h*3600000)+'" y="'+(H-10)+'" text-anchor="middle">'+String(h).padStart(2,'0')+':00</text>'}
   else for(let i=0;i<current.days;i++)if(i===0||i===current.days-1||i%Math.max(1,Math.ceil(current.days/6))===0){const t=start+i*86400000;svg+='<text x="'+x(t)+'" y="'+(H-10)+'" text-anchor="middle">'+short(new Date(t).toISOString().slice(0,10))+'</text>'}
   for(const s of series){
    const dash=s.dash?' stroke-dasharray="'+s.dash+'"':'';
    if(s.reference)svg+='<path data-series="'+esc(s.id)+'" d="M'+L+','+y(s.points[0].value)+'H'+(W-R)+'" fill="none" stroke="'+s.color+'" stroke-width="2"'+dash+'><title>'+esc(s.name)+' · итог полного дня: '+format(s.points[0].value)+'</title></path>';
    else for(const segment of PultStoreChart.segments(s.points))if(segment.length>1)svg+='<path data-series="'+esc(s.id||'total')+'" d="'+segment.map((p,i)=>(i?'L':'M')+x(p.time)+','+y(p.value)).join(' ')+'" fill="none" stroke="'+s.color+'" stroke-width="'+(s.id?2.5:3.5)+'" stroke-linejoin="round"'+dash+'/>';
    s.points.forEach((p,index)=>{
     const detail=PultStoreChart.observation(s.points,index);if(!detail)return;
     const pointIndex=observations.push({series:s,...detail})-1,label=s.name+' · '+(s.reference?'Итог полного дня '+short(s.date):oneDay?time(p.time)+' МСК':short(p.label))+': '+format(p.value);
     svg+='<circle class="chart-point" data-point="'+pointIndex+'" data-series="'+esc(s.id||'total')+'" role="button" tabindex="-1" aria-pressed="false" aria-label="'+esc(label)+'" cx="'+x(p.time)+'" cy="'+y(p.value)+'" r="4.5" fill="'+s.color+'"><title>'+esc(label)+'</title></circle>';
    });
   }
   $('ins-chart').innerHTML=svg+'</svg>';
   const dots=[...$('ins-chart').querySelectorAll('[data-point]')],box=$('chart-inspector');
   let active=0;
   function show(index,focus=false){
    if(!observations[index])return;
    active=index;const {series:s,point,previous,delta}=observations[index];inspected={id:s.id,time:point.time};
    box.hidden=false;$('chart-interaction-hint').hidden=false;box.style.setProperty('--series-color',s.color);
    $('chart-point-label').innerHTML='<span class="chart-point-kicker">'+(s.reference?'Уровень полного дня':'Выбранная точка')+'</span><b>'+esc(s.name)+'</b><span>'+(s.reference?'Итог за '+short(s.date):oneDay?(s.date?short(s.date)+' · ':'')+'Загрузка '+time(point.time)+' МСК':short(point.label))+' · '+esc(title)+'</span>';
    $('chart-point-value').innerHTML='<strong>'+format(point.value)+'</strong><small>'+(s.reference?'Почасовая история отсутствует':delta===null?'Нет предыдущей точки для сравнения':(delta>0?'+':'')+formatDelta(delta)+(oneDay?' с '+time(previous.time):' к '+short(previous.label)))+'</small>';
    dots.forEach((dot,i)=>{dot.setAttribute('aria-pressed',String(i===index));dot.setAttribute('tabindex',i===index?'0':'-1')});
    $('chart-point-prev').disabled=index===0;$('chart-point-next').disabled=index===observations.length-1;
    if(focus)dots[index].focus({preventScroll:true});
   }
   $('ins-chart').onpointerover=e=>{const dot=e.target.closest('[data-point]');if(dot)show(Number(dot.dataset.point))};
   $('ins-chart').onfocusin=e=>{const dot=e.target.closest('[data-point]');if(dot)show(Number(dot.dataset.point))};
   $('ins-chart').onclick=e=>{const dot=e.target.closest('[data-point]');if(dot)show(Number(dot.dataset.point),true)};
   $('ins-chart').onkeydown=e=>{
    const dot=e.target.closest('[data-point]');if(!dot||!['ArrowLeft','ArrowRight','Home','End','Enter',' '].includes(e.key))return;
    e.preventDefault();const index=Number(dot.dataset.point),next=e.key==='Home'?0:e.key==='End'?observations.length-1:e.key==='ArrowLeft'?Math.max(0,index-1):e.key==='ArrowRight'?Math.min(observations.length-1,index+1):index;show(next,true);
   };
   $('chart-point-prev').onclick=()=>show(active-1);$('chart-point-next').onclick=()=>show(active+1);
   const restored=inspected?observations.findIndex(p=>p.series.id===inspected.id&&p.point.time===inspected.time):-1;
   show(restored>=0?restored:observations.findLastIndex(p=>p.series.id===observations[0]?.series.id));
  }
  return {update(value,storeId){report=value;cache=new Map([[cacheKey(storeId||'',value.current),value]]);void render()},render};
 };
})();
