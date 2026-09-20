(function(){'use strict';
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const num=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}),integer=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
 const short=v=>new Date(v+'T12:00:00Z').toLocaleDateString('ru-RU',{day:'2-digit',month:'short'}),time=v=>new Date(v).toLocaleTimeString('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});
 const colors=['var(--chart-store-1, #158b78)','var(--chart-store-2, #9270cc)','var(--chart-store-3, #d28532)','var(--chart-store-4, #378fbd)'];
 window.createPultStoreChart=function({api,metricTitle}){
  let report=null,catalog=[],selected=new Set(['']),cache=new Map(),version=0,catalogError=null,inspected=null,mode='stores',categoryReport=null,selectedCategories=new Set(),categoryRequests=new Map();
  $('ins-chart').closest('.panel').id='business-chart';
  $('ins-chart').insertAdjacentHTML('afterend','<p class="chart-interaction-hint" id="chart-interaction-hint" hidden>Выберите точку мышью или касанием. С клавиатуры: Tab к графику, затем ← →.</p><div class="chart-inspector" id="chart-inspector" hidden><div id="chart-point-label" aria-live="polite"></div><div id="chart-point-value" aria-live="polite"></div><div class="chart-inspector-buttons"><button class="button secondary" id="chart-point-prev" type="button" aria-label="Предыдущая точка графика">←</button><button class="button secondary" id="chart-point-next" type="button" aria-label="Следующая точка графика">→</button></div></div>');
  $('ins-chart').insertAdjacentHTML('beforebegin','<style>#chart-category-search{width:100%;margin:10px 0;padding:9px 11px;border:1px solid var(--line,#dbe3ef);border-radius:9px}#chart-category-options details{margin:4px 0}#chart-category-options summary{cursor:pointer;list-style-position:outside}#chart-category-options .category-children{padding-left:22px}#chart-category-options label{display:flex;gap:8px;align-items:center;padding:5px 0}</style><div id="chart-mode" class="chart-compare-controls" role="group" aria-label="Разрез графика"><button type="button" data-mode="stores" aria-pressed="true">По магазинам</button><button type="button" data-mode="categories" aria-pressed="false">По категориям</button></div><div class="chart-store-picker" id="chart-store-picker"><div class="chart-store-picker-title"><span>Магазины на графике</span><div><button id="chart-only-total" type="button">Только общий</button><button id="chart-all-stores" type="button">Все линии</button></div></div><div id="chart-store-options" role="group" aria-label="Магазины на графике"></div><p>Выбор действует только на график. Общий — все подключённые магазины Ozon.</p></div><div class="chart-store-picker" id="chart-category-picker" hidden><div class="chart-store-picker-title"><span>Категории на графике</span><div><button id="chart-all-categories" type="button">Все верхние категории</button><button id="chart-no-categories" type="button">Снять выбор</button></div></div><input id="chart-category-search" type="search" placeholder="Найти тип товара"><div id="chart-category-options" role="group" aria-label="Категории на графике"></div><p>Сначала выберите нужные категории. Родитель объединяет подтипы; Ozon и WB показаны отдельными линиями.</p></div><div id="chart-store-status" role="status" aria-live="polite"></div>');
  const ready=api('/api/stores').then(list=>{catalog=list.filter(s=>!s.id.startsWith('wb-'));renderOptions()}).catch(()=>{catalogError='Не удалось получить список магазинов. Обновите страницу.'});
  function options(){return [{id:'',name:'Общий · все Ozon',color:'var(--chart-total, #315efb)'},...catalog.map((s,i)=>({id:s.id,name:s.name,color:colors[i%colors.length]}))]}
  function renderOptions(){$('chart-store-options').innerHTML=options().map(s=>'<label style="--series-color:'+s.color+'"><input type="checkbox" value="'+esc(s.id)+'" '+(selected.has(s.id)?'checked':'')+'><i></i><span>'+esc(s.name)+'</span></label>').join('')}
  function typeMap(){return new Map((categoryReport?.types||[]).map(type=>[type.id,type]))}
  function ancestors(id,map=typeMap()){const out=[];let node=map.get(id);while(node?.parentId){out.push(node.parentId);node=map.get(node.parentId)}return out}
  function descendants(id,types=categoryReport?.types||[]){const out=[];for(const child of types.filter(type=>type.parentId===id)){out.push(child.id,...descendants(child.id,types))}return out}
  function selectCategory(id,checked){const map=typeMap();if(!map.size){checked?selectedCategories.add(id):selectedCategories.delete(id);return}if(checked){for(const parent of ancestors(id,map))selectedCategories.delete(parent);for(const child of descendants(id))selectedCategories.delete(child);selectedCategories.add(id)}else selectedCategories.delete(id)}
  function renderCategoryOptions(){const types=categoryReport?.types||[],query=$('chart-category-search').value.trim().toLocaleLowerCase('ru-RU');if(!types.length){const names=categoryReport?.categories||[];$('chart-category-options').innerHTML=names.filter(name=>!query||name.toLocaleLowerCase('ru-RU').includes(query)).map((name,i)=>'<label style="--series-color:'+colors[i%colors.length]+'"><input type="checkbox" value="'+esc(name)+'" '+(selectedCategories.has(name)?'checked':'')+'><i></i><span>'+esc(name)+'</span></label>').join('');return}const byParent=new Map();for(const type of types){const list=byParent.get(type.parentId)||[];list.push(type);byParent.set(type.parentId,list)}const matches=id=>{const type=types.find(item=>item.id===id);return !query||type.name.toLocaleLowerCase('ru-RU').includes(query)||(byParent.get(id)||[]).some(child=>matches(child.id))};const node=type=>{if(!matches(type.id))return '';const children=byParent.get(type.id)||[],label='<label><input type="checkbox" value="'+esc(type.id)+'" '+(selectedCategories.has(type.id)?'checked':'')+'><span>'+esc(type.name)+'</span></label>';return children.length?'<details open><summary>'+label+'</summary><div class="category-children">'+children.map(child=>node(child)).join('')+'</div></details>':label};$('chart-category-options').innerHTML=(byParent.get(null)||[]).map(type=>node(type)).join('')}
  $('chart-store-options').onchange=e=>{if(e.target.type!=='checkbox')return;e.target.checked?selected.add(e.target.value):selected.delete(e.target.value);void render()};
  $('chart-only-total').onclick=()=>{selected=new Set(['']);renderOptions();void render()};
  $('chart-all-stores').onclick=()=>{selected=new Set(options().map(s=>s.id));renderOptions();void render()};
   $('chart-mode').onclick=e=>{const button=e.target.closest('[data-mode]');if(!button||button.dataset.mode===mode)return;mode=button.dataset.mode;$('chart-mode').querySelectorAll('[data-mode]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));$('chart-store-picker').hidden=mode!=='stores';$('chart-category-picker').hidden=mode!=='categories';void render()};
   $('chart-category-options').onchange=e=>{if(e.target.type!=='checkbox')return;selectCategory(e.target.value,e.target.checked);renderCategoryOptions();void render()};
   $('chart-all-categories').onclick=()=>{const types=categoryReport?.types||[];selectedCategories=new Set(types.length?types.filter(type=>type.parentId===null).map(type=>type.id):categoryReport?.categories||[]);renderCategoryOptions();void render()};
   $('chart-no-categories').onclick=()=>{selectedCategories.clear();renderCategoryOptions();void render()};
   $('chart-category-search').oninput=()=>renderCategoryOptions();
  const comparisons=[{id:'yesterday',days:-1,name:'Вчера',dash:'7 5',color:'#e78cb5'},{id:'week',days:-7,name:'Неделю назад',dash:'2 5',color:'#6bcfdf'}];
  $('chart-store-status').insertAdjacentHTML('beforebegin','<div id="chart-compare-controls" class="chart-compare-controls" role="group" aria-label="Сравнить сегодняшний день" hidden><span>Сравнить с</span>'+comparisons.map(c=>'<label><input type="checkbox" value="'+c.id+'" checked><i class="compare-line '+c.id+'"></i>'+c.name+'</label>').join('')+'<small>Сегодня — сплошная линия</small></div>');
  $('chart-compare-controls').onchange=()=>{void render()};
  $('chart-store-status').insertAdjacentHTML('beforebegin','<div id="chart-forecast-controls" class="chart-compare-controls" hidden><label><input id="chart-forecast-enabled" type="checkbox" checked>Прогноз до конца дня</label></div>');
  $('chart-forecast-enabled').onchange=()=>{void render()};
  const cacheKey=(id,period)=>id+':'+period.from+':'+period.to;
  function getReport(id,period=report.current){const key=cacheKey(id,period);if(cache.has(key))return Promise.resolve(cache.get(key));const query=new URLSearchParams({from:period.from,to:period.to,store:id,hideInactive:String($('hide-inactive').checked)}),request=api('/api/insights?'+query);cache.set(key,request);return request}
  function getCategoryReport(date){const requests=categoryRequests;if(requests.has(date))return requests.get(date);const request=Promise.resolve().then(()=>api('/api/order-categories?'+new URLSearchParams({date}))).catch(error=>{if(requests.get(date)===request)requests.delete(date);throw error});requests.set(date,request);return request}
  async function render(){
   if(!report)return;const current=report,seq=++version,key=$('ins-chart-metric').value,title=metricTitle(key),oneDay=current.days===1,ratio=key==='ourMargin'||key==='ourRoi',format=v=>v===null?'—':ratio?num.format(v)+' %':key==='orderedUnits'?integer.format(v)+' шт.':num.format(v)+' ₽';
   const formatDelta=v=>ratio?(v===null?'—':num.format(v)+' п.п.'):format(v);
   const isToday=oneDay&&current.current.from===new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
   $('ins-chart-title').textContent=oneDay?(isToday?'Динамика за сегодня':'Динамика за '+short(current.current.from)):'Динамика бизнеса';
   $('chart-compare-controls').hidden=mode!=='stores'||!isToday;
   const forecastEligible=isToday&&(key==='orderedRevenue'||key==='orderedUnits'),forecastEnabled=forecastEligible&&$('chart-forecast-enabled').checked;
   $('chart-forecast-controls').hidden=!forecastEligible;
   $('ins-chart-caption').textContent=title+' · '+(oneDay?'накопительно с начала дня · время МСК':short(current.current.from)+' — '+short(current.current.to));
   $('chart-store-status').textContent='Загружаем выбранные линии…';$('ins-chart').setAttribute('aria-busy','true');$('ins-chart').innerHTML='';$('ins-chart-details').hidden=true;$('chart-inspector').hidden=true;$('chart-interaction-hint').hidden=true;
   await ready;if(seq!==version)return;
   if(mode==='categories'){await renderCategories({current,seq,key,title,oneDay,isToday,format});return}
   if(catalogError){$('chart-store-status').textContent=catalogError;$('ins-chart').removeAttribute('aria-busy');return}
   const chosen=options().filter(s=>selected.has(s.id));
   if(!chosen.length){$('chart-store-status').textContent='Выберите общий показатель или нужные магазины.';$('ins-chart').removeAttribute('aria-busy');return}
   const enabled=isToday?comparisons.filter(c=>$('chart-compare-controls').querySelector('input[value="'+c.id+'"]').checked).map(c=>({...c,date:PultStoreChart.shiftDate(current.current.from,c.days)})):[];
   const requests=chosen.flatMap(s=>[{store:s,compare:null,period:current.current},...enabled.map(c=>({store:s,compare:c,period:{from:c.date,to:c.date}}))]);
   if(forecastEnabled)for(const s of chosen)requests.push({store:s,forecastHistory:true,period:{from:PultStoreChart.shiftDate(current.current.from,-21),to:PultStoreChart.shiftDate(current.current.from,-1)}});
   const results=await Promise.allSettled(requests.map(r=>getReport(r.store.id,r.period)));if(seq!==version)return;
   const loaded=requests.map((r,i)=>({...r,report:results[i].status==='fulfilled'?results[i].value:null,error:results[i].status==='rejected'}));
   const series=loaded.filter(r=>!r.compare&&!r.forecastHistory).map(r=>r.report?{...r.store,report:r.report,points:PultStoreChart.points(r.report,key),total:PultStoreChart.totals(r.report,key)}:{...r.store,points:[],total:null,error:true});
   const historical=loaded.filter(r=>r.compare).map(r=>{
    const fullDay=r.report?PultStoreChart.totals(r.report,key):null,points=r.report?PultStoreChart.alignedPoints(r.report,key,current.current.from):[],reference=!points.some(p=>p.value!==null)&&fullDay!==null;
    return {...r.store,id:(r.store.id||'total')+'@'+r.compare.id,name:r.store.name+' · '+r.compare.name,color:r.compare.color,date:r.compare.date,dash:r.compare.dash,reference,error:r.error,points:reference?[{time:Date.parse(current.current.from+'T00:00:00+03:00')+86400000,label:r.compare.date,value:fullDay}]:points};
   });
   const forecastColors=['#ba9af2','#f3ad70','#80c6e8','#b9d982','#eab6cf'];
   const forecasts=forecastEnabled?series.map((s,i)=>{const history=loaded.find(r=>r.forecastHistory&&r.store.id===s.id),value=PultStoreChart.orderForecast(s.report,history?.report,key);return {...s,id:(s.id||'total')+'@forecast',name:s.name+' · прогноз',forecast:true,color:forecastColors[i%forecastColors.length],dash:'5 5',...value}}):[];
   const failed=series.filter(s=>s.error).map(s=>s.name),empty=series.filter(s=>!s.error&&!s.points.some(p=>p.value!==null)).map(s=>s.name);
   const historyFailed=historical.filter(s=>s.error).map(s=>s.name),historyMissing=historical.filter(s=>!s.error&&!s.reference&&!s.points.some(p=>p.value!==null)).map(s=>s.name);
   $('chart-store-status').textContent=[failed.length?'Не удалось загрузить: '+failed.join(', '):'',empty.length?'Нет точек за период: '+empty.join(', '):'',historyFailed.length?'Не удалось загрузить сравнение: '+historyFailed.join(', '):'',historyMissing.length?'Нет данных для сравнения: '+historyMissing.join(', '):'',historical.some(s=>s.reference)?'Для прошлых дней без почасовой истории пунктиром показаны уровни итогов за весь день. Это не оборот на текущее время.':''].filter(Boolean).join(' · ');$('ins-chart').removeAttribute('aria-busy');
   if(ratio&&empty.length){$('chart-store-status').textContent+=' · Для расчёта нужны полные начисления, количество проданных единиц и себестоимость всех продаж. История внутри дня начинается с новых снимков; прежние точки не пересчитываются задним числом.';}
   draw([...series,...historical,...forecasts.filter(s=>s.status==='available')],current,oneDay,title,format,formatDelta,ratio);
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
    details.insertAdjacentHTML('beforeend','<p class="comparison-method">Процент изменения считается только по снимкам на сопоставимое время: прошлый снимок не позднее сегодняшнего и отстаёт не больше интервала обновления: 5 минут для заказов, 30 минут для финансов. Итоги полных дней приведены отдельно; пропуски не заменяются нулями.</p>');
   }
   if(forecastEnabled)details.insertAdjacentHTML('beforeend','<div class="chart-forecast-summary"><p><b>Ориентировочный прогноз до 24:00 МСК</b> · сплошная линия — факты сегодня; цветной пунктир — ориентир. Точки видны при наведении или выборе с клавиатуры.</p>'+forecasts.map(s=>'<p><span style="color:'+s.color+'">●</span> <b>'+esc(s.name)+'</b>: '+(s.status==='available'?format(s.endValue)+' к 24:00 · среднее трёх таких же дней недели: '+format(s.average)+'<br><small>'+s.basis.map(b=>short(b.date)+': '+format(b.value)).join(' · ')+'</small>':'Недоступен: '+esc(s.reason))+'</p>').join('')+'<p>Ориентировочный прогноз: среднее того же дня недели за последние три недели, не ниже уже заказанного. Например, пятница сравнивается только с тремя предыдущими пятницами. Это ориентир: темп текущего дня, акции и праздники не учтены. Пунктир соединяет последний факт с ориентиром на конец дня; промежуточные точки не являются отдельным почасовым прогнозом. Прогноз не включён в фактические итоги.</p></div>');
   if(oneDay){const rows=series.flatMap(s=>s.points.filter(p=>p.value!==null).slice(-8).map(p=>({name:s.name,...p}))).sort((a,b)=>b.time-a.time);details.insertAdjacentHTML('beforeend','<details><summary>История загрузок</summary><div class="table-wrap"><table><thead><tr><th>Магазин</th><th>Время МСК</th><th class="numeric">Итог дня</th></tr></thead><tbody>'+rows.map(p=>'<tr><td>'+esc(p.name)+'</td><td>'+time(p.time)+'</td><td class="numeric">'+format(p.value)+'</td></tr>').join('')+'</tbody></table></div></details>')}
  }
  async function renderCategories({current,seq,key,title,oneDay,isToday,format}){
   $('chart-forecast-controls').hidden=true;
   if(!oneDay||!isToday){$('chart-store-status').textContent='Категории доступны для сегодняшних заказов по МСК.';$('ins-chart').removeAttribute('aria-busy');$('ins-chart').innerHTML='<div class="empty">Выберите период «Сегодня», чтобы увидеть категории заказов.</div>';return}
   if(!['orderedRevenue','orderedUnits'].includes(key)){$('chart-store-status').textContent='По категориям доступны показатели «Заказано на сумму» и «Заказано товаров».';$('ins-chart').removeAttribute('aria-busy');$('ins-chart').innerHTML='<div class="empty">Для этого показателя нет сопоставимого источника заказов по категориям.</div>';return}
   try{const loaded=await getCategoryReport(current.current.from);if(seq!==version)return;categoryReport=loaded}catch{if(seq!==version)return;$('chart-store-status').textContent='Не удалось загрузить категории заказов.';$('ins-chart').removeAttribute('aria-busy');return}
   const valid=new Set(categoryReport.types?.length?categoryReport.types.map(type=>type.id):categoryReport.categories);for(const name of [...selectedCategories])if(!valid.has(name))selectedCategories.delete(name);renderCategoryOptions();
   if(!selectedCategories.size){$('chart-store-status').textContent=['Выберите хотя бы одну категорию.',...(categoryReport.limitations||[])].filter(Boolean).join(' · ');$('ins-chart').removeAttribute('aria-busy');$('ins-chart').innerHTML='<div class="empty">Выберите хотя бы одну категорию.</div>';return}
   const keys=categoryReport.types?.length?categoryReport.types.map(type=>type.id):categoryReport.categories,palette=new Map(keys.map((name,i)=>[name,colors[i%colors.length]])),series=categoryReport.series.filter(item=>selectedCategories.has(item.typeId||item.category)).map(item=>{const id=item.typeId||item.category;return {id:item.market+':'+id,name:item.category+' · '+item.market+(item.aggregate?' · включает '+item.leafCount+' типов':''),market:item.market,color:palette.get(id),dash:item.market==='WB'?'6 4':null,points:(item.points||[]).map(point=>({time:Date.parse(point.at),value:point[key]})).filter(point=>Number.isFinite(point.time)&&Number.isFinite(point.value)),total:null,amountBasis:item.amountBasis,timeBasis:item.timeBasis}});
   $('chart-store-status').textContent=(categoryReport.limitations||[]).join(' · ');$('ins-chart').removeAttribute('aria-busy');draw(series,current,true,title,format,value=>format(value),false);
   const details=$('ins-chart-details');details.hidden=false;details.innerHTML='<div class="chart-series-totals">'+series.map(item=>{const last=item.points.at(-1);return '<div style="--series-color:'+item.color+'"><span><i></i>'+esc(item.name)+'</span><strong>'+format(last?.value??null)+'</strong><small>'+(last?'На '+time(last.time)+' МСК · '+esc(item.timeBasis):'Нет полного наблюдения')+'</small></div>'}).join('')+'</div><p><b>Время:</b> WB построен по времени создания каждого заказа. Ozon Seller API отдаёт суточный итог по SKU, поэтому линия меняется только при сохранении нового снимка.</p><p><b>Суммы:</b> Ozon использует revenue, WB — priceWithDisc. Линии площадок не складываются. Позиции без доказуемой связи показаны как «Не сопоставлено».</p>';
  }
  function draw(series,current,oneDay,title,format,formatDelta,ratio){
   if(!series.some(s=>s.points.some(p=>p.value!==null))){$('ins-chart').innerHTML='<div class="empty">График появится после загрузки данных для выбранных магазинов.</div>';return}
   const W=760,H=240,L=70,R=22,T=16,B=38,{min,max}=PultStoreChart.domain(series),start=Date.parse(current.current.from+(oneDay?'T00:00:00+03:00':'T12:00:00Z')),end=oneDay?start+86400000:Date.parse(current.current.to+'T12:00:00Z'),x=t=>L+(W-L-R)*(end===start?.5:(t-start)/(end-start)),y=v=>T+(max-v)/(max-min)*(H-T-B);
   const observations=[];
   let svg='<svg class="'+(oneDay?'chart-intraday':'chart-daily')+'" viewBox="0 0 '+W+' '+H+'" role="group" aria-label="'+esc(title)+' · '+esc(series.map(s=>s.name).join(', '))+'">';
   for(let i=0;i<4;i++){const v=min+(max-min)*i/3,yy=y(v);svg+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" stroke="#eaf0f8"/><text x="'+(L-10)+'" y="'+(yy+4)+'" text-anchor="end">'+num.format(Math.abs(v)>=1e6?v/1e6:Math.abs(v)>=1000?v/1000:v)+(Math.abs(v)>=1e6?'м':Math.abs(v)>=1000?'к':'')+(ratio?' %':'')+'</text>'}
   if(oneDay){for(let h=0;h<=24;h+=4)svg+='<text x="'+x(start+h*3600000)+'" y="'+(H-10)+'" text-anchor="middle">'+String(h).padStart(2,'0')+':00</text>'}
   else for(let i=0;i<current.days;i++)if(i===0||i===current.days-1||i%Math.max(1,Math.ceil(current.days/6))===0){const t=start+i*86400000;svg+='<text x="'+x(t)+'" y="'+(H-10)+'" text-anchor="middle">'+short(new Date(t).toISOString().slice(0,10))+'</text>'}
   for(const s of series){
    const dash=s.dash?' stroke-dasharray="'+s.dash+'"':'';
    if(s.reference)svg+='<path data-series="'+esc(s.id)+'" d="M'+L+','+y(s.points[0].value)+'H'+(W-R)+'" fill="none" stroke="'+s.color+'" stroke-width="2"'+dash+'><title>'+esc(s.name)+' · итог полного дня: '+format(s.points[0].value)+'</title></path>';
    else for(const segment of PultStoreChart.segments(s.points))if(segment.length>1)svg+='<path data-series="'+esc(s.id||'total')+'" d="'+segment.map((p,i)=>(i?'L':'M')+x(p.time)+','+y(p.value)).join(' ')+'" fill="none" stroke="'+s.color+'" stroke-width="'+(oneDay?(s.id?1.6:2.2):(s.id?2.5:3.5))+'" stroke-linejoin="round" stroke-linecap="round"'+dash+'/>';
    s.points.forEach((p,index)=>{
     if(s.forecast&&index===0)return;
     const detail=PultStoreChart.observation(s.points,index);if(!detail)return;
     const pointIndex=observations.push({series:s,...detail})-1,label=s.name+' · '+(s.reference?'Итог полного дня '+short(s.date):oneDay?(p.time===end?'24:00':time(p.time))+' МСК':short(p.label))+(s.forecast?' · ориентир':'')+': '+format(p.value);
     svg+='<circle class="chart-point'+(s.forecast?' chart-forecast-point':'')+'" data-point="'+pointIndex+'" data-series="'+esc(s.id||'total')+'" role="button" tabindex="-1" aria-pressed="false" aria-label="'+esc(label)+'" cx="'+x(p.time)+'" cy="'+y(p.value)+'" r="3.5" fill="'+s.color+'"/>';
    });
   }
   $('ins-chart').innerHTML=svg+'<line class="chart-crosshair" x1="0" x2="0" y1="'+T+'" y2="'+(H-B)+'" visibility="hidden"/></svg><div class="chart-hover-tooltip" role="tooltip" hidden></div>';
   const host=$('ins-chart'),svgNode=host.querySelector('svg'),crosshair=host.querySelector('.chart-crosshair'),tooltip=host.querySelector('.chart-hover-tooltip'),dots=[...host.querySelectorAll('[data-point]')],box=$('chart-inspector');
   const tolerance=(['orderedRevenue','orderedUnits'].includes($('ins-chart-metric').value)?5:30)*60000;
   let active=-1,tooltipIndex=-1,pointerInside=false;
   function show(index,focus=false){
    if(!observations[index])return;
    if(active===index){if(focus)dots[index].focus({preventScroll:true});return}
    active=index;const {series:s,point,previous,delta}=observations[index];inspected={id:s.id,time:point.time};
    box.hidden=false;$('chart-interaction-hint').hidden=false;box.style.setProperty('--series-color',s.color);
    $('chart-point-label').innerHTML='<span class="chart-point-kicker">'+(s.reference?'Уровень полного дня':s.forecast?'Ориентир · не фактическая загрузка':'Выбранная точка')+'</span><b>'+esc(s.name)+'</b><span>'+(s.reference?'Итог за '+short(s.date):oneDay?(s.date?short(s.date)+' · ':'')+(s.forecast?'Ориентир на ':'Загрузка ')+(point.time===end?'24:00':time(point.time))+' МСК':short(point.label))+' · '+esc(title)+'</span>';
    $('chart-point-value').innerHTML='<strong>'+esc(format(point.value))+'</strong><small>'+(s.forecast?'Пунктир к ориентиру на конец дня; не отдельный почасовой прогноз':s.reference?'Почасовая история отсутствует':delta===null?'Нет предыдущей точки для сравнения':(delta>0?'+':'')+formatDelta(delta)+(oneDay?' с '+time(previous.time):' к '+short(previous.label)))+'</small>';
    dots.forEach((dot,i)=>{dot.setAttribute('aria-pressed',String(i===index));dot.setAttribute('tabindex',i===index?'0':'-1')});
    $('chart-point-prev').disabled=index===0;$('chart-point-next').disabled=index===observations.length-1;
    if(focus)dots[index].focus({preventScroll:true});
   }
   function hideHover(){tooltip.hidden=true;tooltipIndex=-1;crosshair.setAttribute('visibility','hidden');dots.forEach(dot=>dot.classList.remove('chart-hover-visible'))}
   function hover(index,clientX,clientY){
    const item=observations[index];if(!item)return;
    if(tooltipIndex!==index){
     tooltipIndex=index;const at=item.point.time,matched=[];
     const rows=series.map(s=>{
      let p=s.reference?s.points[0]:s===item.series?item.point:s.forecast?s.points.find(p=>p.time===at):oneDay?s.points.filter(p=>p.time<=at&&at-p.time<=tolerance).at(-1):s.points.find(p=>p.time===at);
      if(!Number.isFinite(p?.value))p=null;
      if(p&&!s.reference){const i=observations.findIndex(o=>o.series===s&&o.point===p);if(i>=0)matched.push(i)}
      const note=s.reference?'итог полного дня · '+short(s.date):s.forecast?'ориентир':p?oneDay?(p.time===end?'24:00':time(p.originalTime??p.time))+' МСК'+(s.date?' · '+short(s.date):''):'':oneDay?'нет снимка на сопоставимое время':'нет данных';
      return '<div class="chart-tooltip-row"><i style="background:'+s.color+'"></i><span>'+esc(s.name)+'<small>'+esc(note)+'</small></span><b>'+esc(format(p?.value??null))+'</b></div>';
     });
     const stamp=item.series.reference?'Итоги полных дней':oneDay?short(current.current.from)+' · '+(at===end?'24:00':time(at))+' МСК':short(item.point.label);
     tooltip.innerHTML='<div class="chart-tooltip-date">'+esc(stamp)+'</div>'+rows.join('');
     dots.forEach((dot,i)=>dot.classList.toggle('chart-hover-visible',matched.includes(i)));
     crosshair.setAttribute('x1',x(at));crosshair.setAttribute('x2',x(at));crosshair.setAttribute('visibility','visible');
    }
    tooltip.hidden=false;
    const bounds=tooltip.getBoundingClientRect(),margin=10;
    tooltip.style.left=Math.max(margin,Math.min(clientX+16,window.innerWidth-bounds.width-margin))+'px';
    tooltip.style.top=Math.max(margin,Math.min(clientY+16,window.innerHeight-bounds.height-margin))+'px';
   }
   function nearest(event){
    if(!host.contains(svgNode))return -1;
    const rect=svgNode.getBoundingClientRect(),px=(event.clientX-rect.left)/rect.width*W,py=(event.clientY-rect.top)/rect.height*H;
    if(px<L||px>W-R||py<T||py>H-B)return -1;
    const candidates=observations.map((item,index)=>({item,index})).filter(({item})=>!item.series.reference);
    return (candidates.length?candidates:observations.map((item,index)=>({item,index}))).reduce((best,row)=>{const distance=Math.abs(x(row.item.point.time)-px)*4+Math.abs(y(row.item.point.value)-py);return !best||distance<best.distance?{index:row.index,distance}:best},null)?.index??-1;
   }
   host.onpointerover=null;
   host.onpointermove=e=>{pointerInside=true;const index=nearest(e);if(index<0){hideHover();return}show(index);hover(index,e.clientX,e.clientY)};
   host.onpointerleave=()=>{pointerInside=false;hideHover()};
   host.onfocusin=e=>{const dot=e.target.closest('[data-point]');if(!dot)return;const index=Number(dot.dataset.point),rect=dot.getBoundingClientRect();show(index);hover(index,rect.left,rect.top)};
   host.onfocusout=e=>{if(!host.contains(e.relatedTarget)&&!pointerInside)hideHover()};
   host.onclick=e=>{const dot=e.target.closest('[data-point]'),index=dot?Number(dot.dataset.point):nearest(e);if(index>=0){show(index,true);hover(index,e.clientX,e.clientY)}};
   $('ins-chart').onkeydown=e=>{
    const dot=e.target.closest('[data-point]');if(!dot||!['ArrowLeft','ArrowRight','Home','End','Enter',' '].includes(e.key))return;
    e.preventDefault();const index=Number(dot.dataset.point),next=e.key==='Home'?0:e.key==='End'?observations.length-1:e.key==='ArrowLeft'?Math.max(0,index-1):e.key==='ArrowRight'?Math.min(observations.length-1,index+1):index;show(next,true);
   };
   $('chart-point-prev').onclick=()=>show(active-1,true);$('chart-point-next').onclick=()=>show(active+1,true);
   const restored=inspected?observations.findIndex(p=>p.series.id===inspected.id&&p.point.time===inspected.time):-1;
   show(restored>=0?restored:observations.findLastIndex(p=>p.series.id===observations[0]?.series.id));
  }
  return {update(value,storeId){report=value;categoryRequests=new Map();cache=new Map([[cacheKey(storeId||'',value.current),value]]);void render()},render};
 };
})();
