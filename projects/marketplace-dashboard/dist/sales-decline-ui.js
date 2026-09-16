(function(){
 'use strict';
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const n=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}),money=v=>Number.isFinite(v)?n.format(v)+' ₽':'—';
 window.createPultSalesDecline=function(){
  let model=null,page=1;const size=15;
  $('ins-products-panel').insertAdjacentHTML('beforebegin',`<section id="sales-decline" class="panel decline-panel"><div class="panel-heading"><div><span class="eyebrow">РАЗБОР ПО ТОВАРАМ</span><h2>Где падают продажи</h2><p>Снижение реализации Ozon: факты, возможные причины и действия</p></div><span id="decline-count" class="pill"></span></div><div class="decline-body"><p id="decline-period"></p><div id="decline-state" class="decline-note" role="status"></div><p class="decline-method">Сравниваем суммы реализации с учётом возвратов, а не количество заказов. Наличие сигнала не доказывает причину падения. Для проверки цены, показов и конверсии нужна их история; текущий остаток не показывает наличие в прошлом периоде.</p><div class="product-controls"><label class="search-label">Найти падающий товар<input id="decline-search" type="search" placeholder="Товар, артикул, SKU или магазин"></label><label>Сигнал<select id="decline-filter"><option value="">Все сигналы</option></select></label></div><div class="table-wrap"><table><thead><tr><th>Товар / магазин</th><th class="numeric">Было</th><th class="numeric">Стало</th><th class="numeric">Снижение</th><th>Что проверить</th></tr></thead><tbody id="decline-rows"></tbody></table></div><div class="pagination"><span id="decline-page"></span><div><button id="decline-prev" class="button secondary" aria-label="Предыдущая страница падений">←</button><button id="decline-next" class="button secondary" aria-label="Следующая страница падений">→</button></div></div></div></section>`);
  function paint(){
   const q=$('decline-search').value.trim().toLocaleLowerCase('ru'),filter=$('decline-filter').value;
   const rows=(model?.rows||[]).filter(r=>(!q||[r.name,r.offer_id,r.sku,r.storeName].join(' ').toLocaleLowerCase('ru').includes(q))&&(!filter||(r.signals||[]).some(s=>s.code===filter)));
   const pages=Math.max(1,Math.ceil(rows.length/size));page=Math.min(Math.max(1,page),pages);
   $('decline-rows').innerHTML=rows.slice((page-1)*size,page*size).map(r=>'<tr><td><strong>'+esc(r.name)+'</strong><span class="sub">'+esc(r.storeName)+' · '+esc(r.offer_id)+' · SKU '+esc(r.sku)+'</span>'+(r.key?'<a href="/manage.html?product='+encodeURIComponent(r.key)+'">Открыть товар →</a>':'')+'</td><td class="numeric">'+money(r.previous)+'</td><td class="numeric">'+money(r.current)+'</td><td class="numeric decline-drop">−'+money(r.drop)+'<span class="sub">−'+n.format(r.dropPercent)+'%</span></td><td><details><summary>'+esc((r.signals||[]).filter(s=>s.code!=='unverified'||(r.signals||[]).length===1).map(s=>s.title).join(' · ')||'Нужны дополнительные данные')+'</summary><div class="decline-signals">'+(r.signals||[]).map(s=>'<article><strong>'+esc(s.title)+'</strong><p>'+esc(s.evidence)+'</p><p><b>Проверить:</b> '+esc(s.action)+'</p></article>').join('')+'</div></details></td></tr>').join('')||'<tr><td colspan="5">'+(model?.status==='ready'?'Нет товаров со снижением по выбранным условиям.':'Сравнение недоступно: нужны полные данные обоих периодов.')+'</td></tr>';
   $('decline-page').textContent=rows.length+' товаров · страница '+page+' из '+pages;$('decline-prev').disabled=page===1;$('decline-next').disabled=page===pages;
  }
  $('decline-search').oninput=$('decline-filter').onchange=()=>{page=1;paint()};$('decline-prev').onclick=()=>{page--;paint()};$('decline-next').onclick=()=>{page++;paint()};
  return {render(report){
   model=report.declines;const rows=model?.rows||[],selected=$('decline-filter').value,signals=new Map(rows.flatMap(r=>(r.signals||[]).map(s=>[s.code,s.title])));
   $('decline-filter').innerHTML='<option value="">Все сигналы</option>'+[...signals].map(([code,title])=>'<option value="'+esc(code)+'">'+esc(title)+'</option>').join('');if(signals.has(selected))$('decline-filter').value=selected;
   $('decline-count').textContent=model?.status==='ready'?rows.length+' товаров со снижением':'Нет сравнения';
   $('decline-period').textContent=model?.current&&model?.previous?'Сейчас: '+model.current.from+' — '+model.current.to+' · Было: '+model.previous.from+' — '+model.previous.to:'';
   const skipped=(model?.excludedStores||[]).map(s=>typeof s==='string'?s:(s.name||s.storeName||s.id)+': '+s.reason);
   $('decline-state').textContent=[model?.reason,skipped.length?'Не включены: '+skipped.join('; '):''].filter(Boolean).join(' · ')||'Товары отсортированы по снижению суммы реализации. Это не сумма потерянной прибыли.';paint();
  }};
 };
})();
