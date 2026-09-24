'use strict';
const $=id=>document.getElementById(id),view=document.body.dataset.view||'prices';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rub=v=>Number.isFinite(Number(v))?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(Number(v))+' ₽':'—';
const num=v=>Number.isFinite(Number(v))?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(Number(v)):'—';
const percent=v=>Number.isFinite(Number(v))?num(v)+'%':'—';
let stores=[],storeId='',report=null,status=null;
async function api(url,body){const r=await fetch(url,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});let d={};try{d=await r.json()}catch{}if(!r.ok)throw Error(d.error||'Не удалось выполнить запрос');return d}
function notice(text,type=''){const el=$('pa-notice');if(!el)return;el.textContent=text||'';el.className='pa-notice '+type;el.hidden=!text}
function decision(row){return row.decision||{status:'hold',reasons:['Нет решения']}}
function reason(row){const d=decision(row);return [...(d.blocks||[]),...(d.reasons||[]),...(d.warnings||[])].filter(Boolean).join(' · ')||'—'}
function modeLabel(v){return{observe:'Наблюдение',recommend:'Рекомендации',auto:'Авто'}[v]||v}
function actionLabel(d){if(!d)return'—';return{price_up:'↑ Цена',bid_up:'↑ Ставка',price_rollback:'↩ Цена',bid_rollback:'↩ Ставка',rollback:'Откат',blocked:'Заблокировано',observe:'Наблюдение',hold:'Держать'}[d.action?.type||d.status]||d.status}
function renderMetrics(rows){
 const actions=rows.filter(r=>decision(r).action).length,blocked=rows.filter(r=>decision(r).status==='blocked').length,profit=rows.filter(r=>Number.isFinite(Number(decision(r).profitAfterAdsPerOrder))).reduce((s,r)=>s+Number(decision(r).profitAfterAdsPerOrder),0);
 $('pa-metrics').innerHTML=[
  ['SKU',rows.length],['Следующий шаг',actions],['Заблокировано',blocked],['Режим',modeLabel(report?.config?.mode)],['Снимок',report?.updatedAt?new Date(report.updatedAt).toLocaleString('ru-RU'):'нет']
 ].map(x=>'<div class="pa-metric"><small>'+esc(x[0])+'</small><strong>'+esc(x[1])+'</strong></div>').join('');
}
function filtered(rows){const q=($('pa-search')?.value||'').trim().toLowerCase(),only=$('pa-only')?.value||'';return rows.filter(r=>(!q||[r.name,r.offerId,r.sku,r.campaignTitle].join(' ').toLowerCase().includes(q))&&(!only||decision(r).status===only))}
function renderPrices(){
 const rows=filtered(report?.rows||[]);renderMetrics(rows);
 $('pa-table-body').innerHTML=rows.length?rows.map(r=>{const d=decision(r),discount=Number(r.sellerPrice)>0&&Number(r.customerPrice)>0?(Number(r.sellerPrice)-Number(r.customerPrice))/Number(r.sellerPrice)*100:null;
  return '<tr><td class="pa-product"><strong>'+esc(r.name)+'</strong><small>'+esc(r.offerId)+' · SKU '+esc(r.sku)+'</small></td><td>'+esc(r.storeName)+'</td><td class="num">'+rub(r.unitCost)+'</td><td class="num">'+rub(r.sellerPrice)+'</td><td class="num">'+rub(r.customerPrice)+'<div class="pa-subtle">'+esc(r.customerPriceSource||'нет источника')+'</div></td><td class="num">'+percent(discount)+'</td><td class="num">'+(r.marketPriceIndex==null?'—':num(r.marketPriceIndex))+'</td><td class="num">'+rub(d.profitAfterAdsPerOrder)+'</td><td class="num">'+rub(d.recommendedPrice)+'</td><td><span class="pa-pill '+esc(d.status)+'">'+esc(actionLabel(d))+'</span></td><td class="pa-reason">'+esc(reason(r))+'</td></tr>';
 }).join(''):'<tr><td colspan="11" class="pa-empty">Нет данных. Нажмите «Обновить данные».</td></tr>';
}
function renderAds(){
 const rows=filtered(report?.adRows||[]);renderMetrics(rows);
 $('pa-table-body').innerHTML=rows.length?rows.map(r=>{const d=decision(r),s=r.stats||{};
  return '<tr><td class="pa-product"><strong>'+esc(r.name)+'</strong><small>'+esc(r.offerId)+' · SKU '+esc(r.sku)+'</small></td><td>'+esc(r.campaignTitle||'—')+'<div class="pa-subtle">'+esc(r.topPosition||r.autopilot||'')+'</div></td><td class="num">'+rub(d.currentBidRub)+'</td><td class="num">'+rub(d.competitiveBidRub)+'</td><td class="num">'+rub(r.minBidRub)+'</td><td class="num">'+num(s.views)+'</td><td class="num">'+num(s.clicks)+'</td><td class="num">'+percent(s.ctr)+'</td><td class="num">'+num(s.orders)+'</td><td class="num">'+percent(s.cvr)+'</td><td class="num">'+rub(s.expense)+'</td><td class="num">'+percent(s.drr)+'</td><td class="num">'+rub(d.profitAfterAdsPerOrder)+'</td><td class="num">'+rub(d.maxProfitableBidRub)+'</td><td class="num">'+rub(d.recommendedBidRub)+'</td><td><span class="pa-pill '+esc(d.status)+'">'+esc(actionLabel(d))+'</span></td><td class="pa-reason">'+esc(reason(r))+'</td></tr>';
 }).join(''):'<tr><td colspan="17" class="pa-empty">Нет рекламных данных. Подключите Performance API и обновите данные.</td></tr>';
}
function render(){
 if(!report)return;
 const c=report.config||{};$('pa-mode').value=c.mode||'observe';$('pa-kill').checked=c.killSwitch!==false;
 for(const id of ['priceWriteEnabled','bidWriteEnabled']){const el=$('pa-'+id);if(el)el.checked=c[id]===true}
 const s=c.settings||{};for(const key of ['priceStepPct','bidStepPct','targetProfitRub','targetProfitPct','externalReservePct','safetyFactor','minObservationMinutes','minStockUnits','maxDailyAdSpendRub','cycleMinutes','maxActionsPerCycle']){const el=$('pa-'+key);if(el)el.value=s[key]??''}
 if($('pa-performance'))$('pa-performance').innerHTML=status?.performance?.connected?'<span class="pa-connected">Performance API подключён · '+esc(status.performance.clientId)+'</span>':'<span class="pa-disconnected">Performance API не подключён</span>';
 view==='ads'?renderAds():renderPrices();
}
async function load(){
 if(!storeId)return;notice('Загружаю…');try{[status,report]=await Promise.all([api('/api/price-ads/status?store='+encodeURIComponent(storeId)),api('/api/price-ads/data?store='+encodeURIComponent(storeId))]);render();notice('')}catch(e){notice(e.message,'error')}
}
async function init(){
 try{stores=(await api('/api/stores')).filter(s=>!String(s.id).startsWith('wb-'));const sel=$('pa-store');sel.innerHTML=stores.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name)+'</option>').join('');const saved=localStorage.getItem('pult-price-ads-store');storeId=stores.some(s=>s.id===saved)?saved:stores[0]?.id||'';sel.value=storeId;sel.onchange=()=>{storeId=sel.value;localStorage.setItem('pult-price-ads-store',storeId);load()};await load()}catch(e){notice(e.message,'error')}
}
function configFromForm(){
 const current=report?.config||{},settings={...(current.settings||{})};for(const key of ['priceStepPct','bidStepPct','targetProfitRub','targetProfitPct','externalReservePct','safetyFactor','minObservationMinutes','minStockUnits','maxDailyAdSpendRub','cycleMinutes','maxActionsPerCycle']){const el=$('pa-'+key);if(el)settings[key]=el.value===''?null:Number(el.value)}
 return{...current,mode:$('pa-mode').value,killSwitch:$('pa-kill').checked,priceWriteEnabled:$('pa-priceWriteEnabled')?.checked===true,bidWriteEnabled:$('pa-bidWriteEnabled')?.checked===true,settings};
}
document.addEventListener('click',async e=>{
 const b=e.target.closest('[data-pa]');if(!b||!storeId)return;const a=b.dataset.pa;b.disabled=true;
 try{
  if(a==='refresh'){notice('Получаю цены, конкурентные ставки и статистику…');report=await api('/api/price-ads/refresh',{storeId});status=await api('/api/price-ads/status?store='+encodeURIComponent(storeId));render();notice('Данные обновлены','ok')}
  if(a==='run'){notice('Запускаю контрольный цикл…');report=await api('/api/price-ads/run',{storeId});status=await api('/api/price-ads/status?store='+encodeURIComponent(storeId));render();notice(report.config.mode==='auto'&&!report.config.killSwitch?'Цикл выполнен. Действия записаны в журнал.':'Цикл рассчитан без live-изменений.','ok')}
  if(a==='settings'){status=await api('/api/price-ads/settings',{storeId,config:configFromForm()});report=await api('/api/price-ads/data?store='+encodeURIComponent(storeId));render();notice('Настройки сохранены','ok')}
  if(a==='connect'){const id=$('pa-client-id').value.trim(),secret=$('pa-client-secret').value;status=await api('/api/price-ads/performance/connect',{storeId,clientId:id,clientSecret:secret});$('pa-client-secret').value='';await load();notice('Performance API подключён','ok')}
  if(a==='disconnect'){status=await api('/api/price-ads/performance/disconnect',{storeId});await load();notice('Performance API отключён','ok')}
 }catch(err){notice(err.message,'error')}finally{b.disabled=false}
});
document.addEventListener('input',e=>{if(e.target.id==='pa-search')view==='ads'?renderAds():renderPrices()});
document.addEventListener('change',e=>{if(e.target.id==='pa-only')view==='ads'?renderAds():renderPrices()});
init();
