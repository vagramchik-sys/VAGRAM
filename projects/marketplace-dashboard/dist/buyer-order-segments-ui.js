(function(){'use strict';
 const integer=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}),percent=new Intl.NumberFormat('ru-RU',{style:'percent',maximumFractionDigits:1}),$=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const labels={legal:'Юрлица',individual:'Физлица',unknown:'Тип не указан'},keys=['legal','individual','unknown'];
 const moscowDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(value),shift=(date,days)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
 function createPultBuyerOrderSegments({api=async url=>{const response=await fetch(url,{headers:{Accept:'application/json'},cache:'no-store'}),value=await response.json();if(!response.ok)throw Error(value.error||'Не удалось загрузить данные о покупателях.');return value}}={}){
  if(!$('buyer-order-segments'))return {load:async()=>{},destroy(){}};let generation=0,timer=null;
  const scope=()=>({from:$('buyer-segment-from').value,to:$('buyer-segment-to').value,market:$('market')?.value||'',store:$('store')?.value||''});
  const same=request=>{const current=scope();return Object.keys(request).every(key=>current[key]===request[key])};
  function clear(message,kind='muted'){$('buyer-segment-cards').innerHTML=keys.map(key=>'<article><span>'+labels[key]+'</span><strong>—</strong><small>'+esc(message)+'</small></article>').join('');$('buyer-segment-markets').innerHTML='<tr><td colspan="5" class="empty">'+esc(message)+'</td></tr>';$('buyer-segment-state').className='mini-badge '+kind;$('buyer-segment-state').textContent=message;$('buyer-segment-source').textContent='';}
  function clearProducts(message,kind='muted'){$('buyer-product-rows').innerHTML='<tr><td colspan="5" class="empty">'+esc(message)+'</td></tr>';$('buyer-product-state').className='mini-badge '+kind;$('buyer-product-state').textContent=message;$('buyer-product-source').textContent='';}
  function marketTotals(data,market){const rows=(data.byStore||[]).filter(row=>row.market===market),totals=Object.fromEntries(keys.map(key=>[key,{units:0,orders:0,cancelledUnits:0}]));for(const row of rows)for(const key of keys){const value=row.totals?.[key];if(Number.isSafeInteger(value?.units)){totals[key].units+=value.units;totals[key].orders+=Number.isSafeInteger(value.orders)?value.orders:0;totals[key].cancelledUnits+=Number.isSafeInteger(value.cancelledUnits)?value.cancelledUnits:0}}return {rows,totals}}
  function render(data,request){
   const ready=data&&data.period?.from===request.from&&data.period?.to===request.to&&data.status!=='pending'&&data.status!=='error'&&data.status!=='unavailable'&&data.totals;if(!ready){clear(data?.error||'Данные за этот период ещё не готовы.','warn');return}
   const complete=data.coverage?.complete===true;
   $('buyer-segment-state').className='mini-badge '+(complete?'':'warn');$('buyer-segment-state').textContent=complete?'Покрытие подтверждено':'Покрытие неполное';
   $('buyer-segment-period').textContent=request.from+' — '+request.to;
   $('buyer-segment-cards').innerHTML=keys.map(key=>{const value=data.totals?.[key],known=complete&&Number.isSafeInteger(value?.units),note=known?integer.format(value.orders)+' заказов · отменено '+integer.format(value.cancelledUnits)+' ед.':'Общий итог скрыт до полного покрытия';return '<article><span>'+labels[key]+'</span><strong>'+(known?integer.format(value.units):'—')+'</strong><small>'+esc(note)+'</small></article>'}).join('');
   const sourceRows=Array.isArray(data.coverage?.sources)?data.coverage.sources:[],markets=['Ozon','WB'].filter(market=>!request.market||request.market===market);
   $('buyer-segment-markets').innerHTML=markets.map(market=>{const grouped=marketTotals(data,market),sources=sourceRows.filter(source=>source.market===market),marketComplete=sources.length>0&&sources.every(source=>source.complete===true),value=key=>marketComplete&&Number.isSafeInteger(grouped.totals[key].units)?integer.format(grouped.totals[key].units):'—',limitations=[...new Set(sources.map(source=>source.limitation).filter(Boolean))],stores=grouped.rows.map(row=>row.name).filter(Boolean);return '<tr><td><strong>'+market+'</strong><small>'+(stores.length?esc(stores.join(', ')):'Нет подтверждённого источника')+'</small></td><td class="numeric">'+value('legal')+'</td><td class="numeric">'+value('individual')+'</td><td class="numeric">'+value('unknown')+'</td><td><span class="pill '+(marketComplete?'':'warn')+'">'+(marketComplete?'Подтверждено':'Неполно')+'</span>'+(limitations.length?'<small>'+esc(limitations.join(' · '))+'</small>':'')+'</td></tr>'}).join('');
   const updated=data.source?.commonFreshnessAt;$('buyer-segment-source').textContent=['Заказанные единицы товара, не реализованные продажи. Отмены входят в исходное число и указаны отдельно.',updated?'Общие данные актуальны на: '+new Date(updated).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}):'',...(data.limitations||[]).slice(0,2)].filter(Boolean).join(' ');
  }
  function renderProducts(data,request){
   const ready=data&&data.period?.from===request.from&&data.period?.to===request.to&&['ready','partial'].includes(data.status)&&Array.isArray(data.products);if(!ready){clearProducts(data?.error||'Рейтинг товаров за этот период ещё не готов.','warn');return}
   const complete=data.coverage?.complete===true;
   $('buyer-product-state').className='mini-badge '+(complete?'':'warn');$('buyer-product-state').textContent=complete?'Покрытие подтверждено':'Частичные данные';
   if(!data.products.length)$('buyer-product-rows').innerHTML='<tr><td colspan="5" class="empty">Нет подтверждённых товарных строк за выбранный период.</td></tr>';
   else $('buyer-product-rows').innerHTML=data.products.map(product=>{const units=Number.isSafeInteger(product.legalUnits)?integer.format(product.legalUnits):'—',share=typeof product.legalShare==='number'?percent.format(product.legalShare):'—',cancelled=Number.isSafeInteger(product.cancelledUnits)?integer.format(product.cancelledUnits):'—',unknown=Number.isSafeInteger(product.cancellationUnknownUnits)&&product.cancellationUnknownUnits>0?' · ещё '+integer.format(product.cancellationUnknownUnits)+' ед. без статуса':'',place=[product.market,product.storeName].filter(Boolean).join(' · ');return '<tr><td><strong>'+esc(product.name||'Название не найдено')+'</strong><small>SKU '+esc(product.sku||product.productId||'—')+'</small></td><td>'+esc(place||'Источник не указан')+'</td><td class="numeric">'+units+'</td><td class="numeric">'+share+'</td><td class="numeric">'+cancelled+esc(unknown)+'</td></tr>'}).join('');
   $('buyer-product-source').textContent=complete?'Рейтинг по заказанным юрлицами единицам. Отмены показаны отдельно.':'Показаны только доступные источники. Частичные значения не являются полным итогом периода.';
  }
  async function load(){
   const request=scope(),seq=++generation;$('buyer-segment-period').textContent=request.from&&request.to?request.from+' — '+request.to:'';
   if(!/^\d{4}-\d{2}-\d{2}$/.test(request.from)||!/^\d{4}-\d{2}-\d{2}$/.test(request.to)||request.from>request.to){clear('Проверьте период.','warn');clearProducts('Проверьте период.','warn');return}
   clear('Загружаем…');clearProducts('Загружаем…');const query=new URLSearchParams({from:request.from,to:request.to,market:request.market||'all'});if(request.store)query.set('store',request.store);
   const [segments,products]=await Promise.allSettled([api('/api/buyer-order-segments?'+query),api('/api/buyer-product-segments?'+query)]);if(seq!==generation||!same(request))return;
   segments.status==='fulfilled'?render(segments.value,request):clear(segments.reason?.message||'Не удалось загрузить состав покупателей.','warn');
   products.status==='fulfilled'?renderProducts(products.value,request):clearProducts(products.reason?.message||'Не удалось загрузить рейтинг товаров.','warn');
  }
  function sharedPeriod(){const from=$('ins-from')?.value,to=$('ins-to')?.value;if(from&&to){$('buyer-segment-from').value=from;$('buyer-segment-to').value=to}}
  function publishPeriod(){if($('ins-from')&&$('ins-to')){$('ins-from').value=$('buyer-segment-from').value;$('ins-to').value=$('buyer-segment-to').value;if($('ins-range'))$('ins-range').value='custom';$('ins-to').dispatchEvent(new Event('change',{bubbles:true}))}else void load()}
  const today=moscowDay(new Date());sharedPeriod();if(!$('buyer-segment-from').value)$('buyer-segment-from').value=today;if(!$('buyer-segment-to').value)$('buyer-segment-to').value=today;
  $('buyer-segment-quick').onclick=event=>{const button=event.target.closest('[data-buyer-period]');if(!button)return;const value=button.dataset.buyerPeriod;$('buyer-segment-to').value=value==='today'?today:shift(today,-1);$('buyer-segment-from').value=value==='7'?shift($('buyer-segment-to').value,-6):$('buyer-segment-to').value;publishPeriod()};
  for(const id of ['buyer-segment-from','buyer-segment-to'])$(id).onchange=publishPeriod;
  for(const id of ['ins-from','ins-to'])$(id)?.addEventListener('change',()=>{sharedPeriod();void load()});
  for(const id of ['market','store'])$(id)?.addEventListener('change',()=>void load());$('refresh-view')?.addEventListener('click',()=>setTimeout(load,0));
  void load();timer=setInterval(()=>{if(!document.hidden)void load()},30000);return {load,destroy(){generation++;if(timer)clearInterval(timer)}};
 }
 window.createPultBuyerOrderSegments=createPultBuyerOrderSegments;window.pultBuyerOrderSegments=createPultBuyerOrderSegments();
})();
