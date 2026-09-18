(function(){
 'use strict';
 const CACHE_MS=30*60*1000,DAY=86400000;
 const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const amount=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
 const compact=new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1});
 const dateLabel=value=>new Date(value+'T12:00:00Z').toLocaleDateString('ru-RU',{day:'numeric',month:'short',timeZone:'UTC'});
 const money=value=>Number.isFinite(value)?amount.format(value)+' ₽':'—';
 const shift=(value,days)=>new Date(Date.parse(value+'T12:00:00Z')+days*DAY).toISOString().slice(0,10);
 const moscowToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const palette=['var(--chart-store-1, #58d8b4)','var(--chart-store-2, #ba9aff)','var(--chart-store-3, #f1b564)','var(--chart-store-4, #65c5eb)','#ee8fb9'];

 window.createPultNetProfit=function(options={}){
  const overview=document.getElementById('overview');
  if(!overview)return null;
  window.__pultNetProfit?.destroy?.();
  document.getElementById('net-profit-chart')?.remove();
  const request=typeof options.api==='function'?options.api:async url=>{
   const response=await fetch(url);
   let value;try{value=await response.json()}catch{throw Error('Сервер вернул ответ неизвестного формата')}
   if(!response.ok)throw Error(value?.error||'Не удалось загрузить чистую прибыль');
   return value;
  };
  const panel=document.createElement('section');
  panel.id='net-profit-chart';panel.className='panel net-profit-panel anchor';
  panel.innerHTML=`<div class="net-profit-heading"><div><span class="eyebrow">ЧИСТАЯ ПРИБЫЛЬ</span><h2>Прибыль всех магазинов по дням</h2><p id="net-profit-caption">Последние 7 завершённых дней · TrueStats</p></div><label class="net-profit-period">Период<select id="net-profit-days"><option value="7">7 дней</option><option value="14">14 дней</option><option value="30">30 дней</option><option value="90">90 дней</option></select></label></div>
   <div class="net-profit-picker"><div><strong>Линии на графике</strong><span><button type="button" id="net-profit-only-total">Только итог</button><button type="button" id="net-profit-all-lines">Все линии</button></span></div><div id="net-profit-options" class="net-profit-options" role="group" aria-label="Линии чистой прибыли"></div></div>
   <div id="net-profit-state" class="net-profit-state" role="status" aria-live="polite"></div>
   <div id="net-profit-plot" class="net-profit-plot" aria-busy="true"><div class="loading">Загружаем чистую прибыль…</div></div>
   <p id="net-profit-hint" class="net-profit-hint" hidden>Выберите точку мышью или касанием. С клавиатуры: Tab, затем ← →.</p>
   <div id="net-profit-inspector" class="net-profit-inspector" hidden><div id="net-profit-point"></div><div id="net-profit-value"></div><div class="net-profit-inspector-buttons"><button type="button" class="button secondary" id="net-profit-prev" aria-label="Предыдущая точка">←</button><button type="button" class="button secondary" id="net-profit-next" aria-label="Следующая точка">→</button></div></div>
   <div id="net-profit-totals" class="net-profit-totals"></div>
   <p id="net-profit-source" class="net-profit-source"></p><details class="net-profit-source"><summary>Что входит в прибыль и как проверяется итог</summary><div id="net-profit-method"></div></details>`;
  const before=overview.querySelector('.overview-grid');
  before?before.before(panel):overview.append(panel);
  const $=id=>panel.querySelector('#'+id);
  const globalMarket=document.getElementById('market'),globalStore=document.getElementById('store'),refreshButton=document.getElementById('refresh-view'),resetButton=document.getElementById('reset');
  const cache=new Map();
  let result=null,version=0,selected=null,series=[],observations=[],active=0,lastPoint=null,destroyed=false;

  function period(){const to=shift(moscowToday(),-1),days=Number($('net-profit-days').value)||7;return {from:shift(to,1-days),to,days}}
  function scope(){return {market:globalMarket?.value||'all',store:globalStore?.value||''}}
  function key(){const p=period(),s=scope();return [p.from,p.to,s.store,s.market].join(':')}
  function query(){const p=period(),s=scope(),params=new URLSearchParams({from:p.from,to:p.to,market:s.market});if(s.store)params.set('store',s.store);return '/api/profit-series?'+params}
  function scopeText(){const s=scope(),market=s.market==='all'?'Ozon + Wildberries':s.market,store=globalStore?.selectedOptions?.[0]?.textContent||'';return store&&s.store?market+' · '+store:market+' · все выбранные магазины'}
  function statuses(data){
   if(data.status==='pending')return 'TrueStats ещё формирует данные за часть периода.';
   if(data.status==='unavailable')return 'Данные TrueStats за выбранный период недоступны.';
   if(data.status==='partial')return 'Период загружен частично: пропуски на графике не заменены нулями.';
   return '';
  }
  function buildSeries(data){
   const total={id:'total',name:'Все магазины',market:'all',color:'var(--chart-total, #91acff)',complete:data.complete===true,total:data.totalProfit,known:data.knownProfit,points:(data.daily||[]).map(point=>({date:point.date,value:point.complete===true&&Number.isFinite(point.profit)?point.profit:null,complete:point.complete===true,status:point.status,knownStores:point.knownStores,totalStores:point.totalStores}))};
   const stores=(data.stores||[]).map((store,index)=>({id:String(store.id),name:store.name||String(store.id),market:store.market,color:palette[index%palette.length],complete:store.complete===true,total:store.totalProfit,known:store.knownProfit,status:store.status,reason:store.reason,points:(store.points||[]).map(point=>({date:point.date,value:point.status==='ready'&&Number.isFinite(point.profit)?point.profit:null,complete:point.status==='ready',status:point.status,reason:point.reason}))}));
   return [total,...stores];
  }
  function renderOptions(){
   if(!selected)selected=new Set(series.map(item=>item.id));
   else{const ids=new Set(series.map(item=>item.id));selected=new Set([...selected].filter(id=>ids.has(id)));if(!selected.size)selected.add('total')}
   $('net-profit-options').innerHTML=series.map(item=>`<label style="--series-color:${item.color}"><input type="checkbox" value="${esc(item.id)}" ${selected.has(item.id)?'checked':''}><i></i><span>${esc(item.name)}${item.market&&item.market!=='all'?'<small>'+esc(item.market)+'</small>':''}</span></label>`).join('');
  }
  function segments(points){const values=[];let current=[];for(const point of points){if(Number.isFinite(point.value)){current.push(point)}else{if(current.length)values.push(current);current=[]}}if(current.length)values.push(current);return values}
  function renderChart(){
   const chosen=series.filter(item=>selected.has(item.id));
   observations=[];
   if(!chosen.length){$('net-profit-plot').innerHTML='<div class="empty">Выберите итог или хотя бы один магазин.</div>';$('net-profit-inspector').hidden=true;$('net-profit-hint').hidden=true;return}
   const values=chosen.flatMap(item=>item.points.filter(point=>Number.isFinite(point.value)).map(point=>point.value));
   if(!values.length){$('net-profit-plot').innerHTML='<div class="empty">Нет подтверждённых дневных значений за этот период. Пропуски не считаются нулевой прибылью.</div>';$('net-profit-inspector').hidden=true;$('net-profit-hint').hidden=true;return}
   let min=Math.min(0,...values),max=Math.max(0,...values);if(min===max){const pad=Math.max(1,Math.abs(max)*.1);min-=pad;max+=pad}
   const W=920,H=286,L=76,R=24,T=18,B=42,range=max-min,p=period(),start=Date.parse(p.from+'T12:00:00Z'),end=Date.parse(p.to+'T12:00:00Z'),x=date=>L+(W-L-R)*(end===start?.5:(Date.parse(date+'T12:00:00Z')-start)/(end-start)),y=value=>T+(max-value)/range*(H-T-B);
   let svg=`<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Чистая прибыль по дням, ${esc(scopeText())}, ${esc(dateLabel(p.from))} — ${esc(dateLabel(p.to))}">`;
   for(let i=0;i<5;i++){const value=min+range*i/4,cy=y(value);svg+=`<line x1="${L}" x2="${W-R}" y1="${cy}" y2="${cy}"/><text x="${L-10}" y="${cy+4}" text-anchor="end">${esc(compact.format(value))}</text>`}
   if(min<0&&max>0)svg+=`<line class="net-profit-zero" x1="${L}" x2="${W-R}" y1="${y(0)}" y2="${y(0)}"/>`;
   const labelEvery=Math.max(1,Math.ceil(p.days/7));
   for(let i=0;i<p.days;i++)if(i===0||i===p.days-1||i%labelEvery===0){const day=shift(p.from,i);svg+=`<text x="${x(day)}" y="${H-10}" text-anchor="middle">${esc(dateLabel(day))}</text>`}
   for(const item of chosen){
    for(const part of segments(item.points))if(part.length>1)svg+=`<path d="${part.map((point,index)=>(index?'L':'M')+x(point.date)+','+y(point.value)).join(' ')}" fill="none" stroke="${item.color}" stroke-width="${item.id==='total'?3.5:2.5}" stroke-linecap="round" stroke-linejoin="round"/>`;
    item.points.forEach((point,index)=>{if(!Number.isFinite(point.value))return;const previous=item.points.slice(0,index).findLast(candidate=>Number.isFinite(candidate.value))||null,label=item.name+' · '+dateLabel(point.date)+': '+money(point.value),pointIndex=observations.push({series:item,point,previous})-1;svg+=`<circle class="net-profit-point" data-point="${pointIndex}" tabindex="-1" role="button" aria-pressed="false" aria-label="${esc(label)}" cx="${x(point.date)}" cy="${y(point.value)}" r="4.5" fill="${item.color}"><title>${esc(label)}</title></circle>`});
   }
   $('net-profit-plot').innerHTML=svg+'</svg>';
   bindInspector();
  }
  function bindInspector(){
   const dots=[...$('net-profit-plot').querySelectorAll('[data-point]')];
   function show(index,focus=false){
    const current=observations[index];if(!current)return;active=index;lastPoint={id:current.series.id,date:current.point.date};
    const delta=current.previous?current.point.value-current.previous.value:null,sum=current.series.complete&&Number.isFinite(current.series.total)?money(current.series.total):'—';
    $('net-profit-inspector').hidden=false;$('net-profit-hint').hidden=false;$('net-profit-inspector').style.setProperty('--series-color',current.series.color);
    $('net-profit-point').innerHTML=`<span>Выбранный день</span><b>${esc(current.series.name)}</b><small>${esc(dateLabel(current.point.date))} · сумма за полный период: ${esc(sum)}</small>`;
    $('net-profit-value').innerHTML=`<strong>${esc(money(current.point.value))}</strong><small>${delta===null?'Нет предыдущего подтверждённого дня':(delta>0?'+':'')+esc(money(delta))+' к '+esc(dateLabel(current.previous.date))}</small>`;
    dots.forEach(dot=>{const on=Number(dot.dataset.point)===index;dot.setAttribute('aria-pressed',String(on));dot.setAttribute('tabindex',on?'0':'-1')});
    $('net-profit-prev').disabled=index===0;$('net-profit-next').disabled=index===observations.length-1;
    if(focus)dots.find(dot=>Number(dot.dataset.point)===index)?.focus({preventScroll:true});
   }
   $('net-profit-plot').onpointerover=event=>{const dot=event.target.closest('[data-point]');if(dot)show(Number(dot.dataset.point))};
   $('net-profit-plot').onfocusin=event=>{const dot=event.target.closest('[data-point]');if(dot)show(Number(dot.dataset.point))};
   $('net-profit-plot').onclick=event=>{const dot=event.target.closest('[data-point]');if(dot)show(Number(dot.dataset.point),true)};
   $('net-profit-plot').onkeydown=event=>{const dot=event.target.closest('[data-point]');if(!dot||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=Number(dot.dataset.point),next=event.key==='Home'?0:event.key==='End'?observations.length-1:event.key==='ArrowLeft'?Math.max(0,index-1):Math.min(observations.length-1,index+1);show(next,true)};
   $('net-profit-prev').onclick=()=>show(active-1,true);$('net-profit-next').onclick=()=>show(active+1,true);
   const restored=lastPoint?observations.findIndex(item=>item.series.id===lastPoint.id&&item.point.date===lastPoint.date):-1;
   const initial=restored>=0?restored:observations.findLastIndex(item=>item.series.id==='total');show(initial>=0?initial:observations.length-1);
  }
  function renderTotals(){
   const chosen=series.filter(item=>selected.has(item.id));
   $('net-profit-totals').innerHTML=chosen.map(item=>{const complete=item.complete&&Number.isFinite(item.total),partial=!complete&&Number.isFinite(item.known);return `<div style="--series-color:${item.color}"><span><i></i>${esc(item.name)}</span><strong>${complete?esc(money(item.total)):'—'}</strong><small>${complete?'Сумма за весь период':partial?'Неполные данные · известная часть '+esc(money(item.known)):'Нет полного периода'}</small></div>`}).join('');
  }
  function render(){
   if(!result)return;
   const p=period(),gaps=series.map(item=>{const dates=item.points.filter(point=>!Number.isFinite(point.value)).map(point=>point.date);return dates.length?item.name+': '+dates.slice(0,2).map(dateLabel).join(', ')+(dates.length>2?' и ещё '+(dates.length-2):''):''}).filter(Boolean),reasons=series.map(item=>item.reason).filter(Boolean),warnings=[statuses(result),result.reason,...reasons,gaps.length?'Пропуски — '+gaps.join('; '):''].filter(Boolean);
   $('net-profit-method').innerHTML=(result.warnings||[]).map(note=>'<p>'+esc(note)+'</p>').join('');
   $('net-profit-caption').textContent=dateLabel(p.from)+' — '+dateLabel(p.to)+' · '+scopeText();
   $('net-profit-state').className='net-profit-state'+(result.status==='unavailable'?' is-error':result.status==='partial'||result.status==='pending'?' is-warning':'');
   $('net-profit-state').textContent=[...new Set(warnings)].join(' · ')||'Все дневные значения подтверждены.';
   $('net-profit-source').textContent=(result.source||'TrueStats API')+' · управленческая чистая прибыль в рублях · текущий день не включён. Итоги показываются только за полный период; известная часть неполного периода не считается итогом.';
   const fetched=(result.stores||[]).map(store=>store.fetchedAt).filter(Boolean).sort()[0];if(fetched)$('net-profit-source').textContent+=' Проверено: '+new Date(fetched).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' МСК. Обновление отчёта — раз в 30 минут.';
   renderOptions();renderChart();renderTotals();$('net-profit-plot').removeAttribute('aria-busy');
  }
  async function load({force=false}={}){
   const seq=++version,cacheKey=key(),saved=cache.get(cacheKey);
   if(!force&&saved&&Date.now()-saved.at<CACHE_MS){result=saved.value;series=buildSeries(result);render();return result}
   result=null;series=[];observations=[];$('net-profit-caption').textContent=dateLabel(period().from)+' — '+dateLabel(period().to)+' · '+scopeText();$('net-profit-plot').setAttribute('aria-busy','true');$('net-profit-plot').innerHTML='<div class="loading">Загружаем чистую прибыль…</div>';$('net-profit-inspector').hidden=true;$('net-profit-hint').hidden=true;$('net-profit-totals').innerHTML='';$('net-profit-state').className='net-profit-state';$('net-profit-state').textContent='Загружаем подтверждённые значения TrueStats…';
   try{
    const value=await request(query());if(seq!==version||destroyed)return null;
    if(!value||!value.period||!Array.isArray(value.daily)||!Array.isArray(value.stores))throw Error('Сервер вернул неполный ряд чистой прибыли');
    const p=period();if(value.period.from!==p.from||value.period.to!==p.to)throw Error('Период в ответе не совпадает с выбранным');
    const s=scope(),wrongStore=s.store&&value.stores.some(store=>String(store.id)!==s.store),wrongMarket=s.market!=='all'&&value.stores.some(store=>store.market!==s.market);if(wrongStore||wrongMarket)throw Error('Состав магазинов в ответе не совпадает с выбранным фильтром');
    result=value;series=buildSeries(value);cache.set(cacheKey,{at:Date.now(),value});render();return value;
   }catch(error){
    if(seq!==version||destroyed)return null;
    cache.delete(cacheKey);result=null;series=[];observations=[];$('net-profit-plot').removeAttribute('aria-busy');$('net-profit-plot').innerHTML='<div class="empty">График очищен: актуальные данные не загружены.</div>';$('net-profit-inspector').hidden=true;$('net-profit-hint').hidden=true;$('net-profit-totals').innerHTML='';$('net-profit-state').className='net-profit-state is-error';$('net-profit-state').textContent=(error?.message||'Не удалось загрузить чистую прибыль')+' · Ранее показанные значения скрыты.';return null;
   }
  }
  function reloadScope(){selected=null;lastPoint=null;void load()}
  $('net-profit-days').addEventListener('change',reloadScope);
  $('net-profit-options').addEventListener('change',event=>{if(event.target.type!=='checkbox')return;event.target.checked?selected.add(event.target.value):selected.delete(event.target.value);renderChart();renderTotals()});
  $('net-profit-only-total').onclick=()=>{selected=new Set(['total']);renderOptions();renderChart();renderTotals()};
  $('net-profit-all-lines').onclick=()=>{selected=new Set(series.map(item=>item.id));renderOptions();renderChart();renderTotals()};
  globalMarket?.addEventListener('change',reloadScope);globalStore?.addEventListener('change',reloadScope);
  const resetScope=()=>setTimeout(reloadScope);resetButton?.addEventListener('click',resetScope);
  const forceRefresh=()=>void load({force:true});refreshButton?.addEventListener('click',forceRefresh);
  const timer=setInterval(()=>{if(!document.hidden)void load()},60*1000);
  const visibility=()=>{if(!document.hidden)void load()};document.addEventListener('visibilitychange',visibility);
  void load();
  const controller={element:panel,refresh:force=>load({force:Boolean(force)}),destroy(){destroyed=true;version++;clearInterval(timer);document.removeEventListener('visibilitychange',visibility);globalMarket?.removeEventListener('change',reloadScope);globalStore?.removeEventListener('change',reloadScope);resetButton?.removeEventListener('click',resetScope);refreshButton?.removeEventListener('click',forceRefresh);panel.remove();if(window.__pultNetProfit===controller)delete window.__pultNetProfit}};window.__pultNetProfit=controller;return controller;
 };
})();
