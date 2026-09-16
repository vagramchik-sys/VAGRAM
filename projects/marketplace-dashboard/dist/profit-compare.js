(function(){
 'use strict';
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
 const money=v=>Number.isFinite(v)?nf.format(v)+' ₽':'—';
 const percent=v=>Number.isFinite(v)?nf.format(v)+'%':'—';
 const stamp=v=>v?new Date(v).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})+' МСК':'нет загрузки';
 window.createPultProfitComparison=function(){
  const panel=$('economics');
  const local=document.createElement('div');local.id='profit-local-detail';
  while(panel.children.length>1)local.append(panel.children[1]);panel.append(local);
  local.insertAdjacentHTML('beforebegin',`<div class="profit-comparison" id="profit-comparison">
   <div class="profit-toolbar"><div class="profit-tabs" role="group" aria-label="Вариант расчёта прибыли"><button type="button" data-profit-mode="both" aria-pressed="true">Две версии</button><button type="button" data-profit-mode="ours" aria-pressed="false">Наш расчёт</button><button type="button" data-profit-mode="truestats" aria-pressed="false">TrueStats</button></div><button type="button" class="button secondary" id="profit-reload">↻ Проверить TrueStats</button></div>
   <p id="profit-scope" class="profit-muted"></p>
   <div class="profit-versions">
    <article class="profit-version profit-ours"><div class="profit-version-top"><span class="eyebrow">НАШ РАСЧЁТ</span><span class="pill" id="profit-ours-status">Ozon</span></div><h3>Прибыль до налогов</h3><strong class="profit-amount" id="profit-ours-value">—</strong><p id="profit-ours-caption">Текущая себестоимость · без внешних расходов</p><dl><div><dt>Учтено себестоимости</dt><dd id="profit-ours-cost">—</dd></div><div><dt>Маржинальность до налогов</dt><dd id="profit-ours-margin">—</dd></div></dl></article>
    <article class="profit-version profit-true"><div class="profit-version-top"><span class="eyebrow">TRUESTATS</span><span class="pill" id="profit-true-status">Подключение</span></div><h3>Чистая прибыль по TrueStats</h3><strong class="profit-amount" id="profit-true-value">—</strong><p id="profit-true-caption">Управленческая отчётность · данные кабинета</p><dl><div><dt>Себестоимость из отчёта</dt><dd id="profit-true-cost">—</dd></div><div><dt>Маржинальность TrueStats</dt><dd id="profit-true-margin">—</dd></div></dl></article>
   </div>
   <div id="profit-state" class="profit-state" role="status" aria-live="polite"></div>
   <div id="profit-difference" class="profit-difference"><span>Разница результатов · TrueStats − наш</span><strong id="profit-delta">—</strong><p id="profit-delta-note">Разные правила учёта: налоги и внешние расходы включены только в TrueStats.</p></div>
   <div class="table-wrap" id="profit-breakdown"><table><thead><tr><th>Что учитывается</th><th class="numeric">Наш расчёт</th><th class="numeric">TrueStats</th><th class="numeric">Разница, ₽</th></tr></thead><tbody id="profit-breakdown-rows"></tbody></table></div>
   <details class="profit-method"><summary>Почему результаты могут отличаться</summary><p>Наш вариант вычитает текущую себестоимость из начислений Ozon после удержаний. TrueStats возвращает свой готовый результат управленческого отчёта с исторической себестоимостью, налогами и внесёнными операционными расходами. Нулевые расходы в TrueStats означают значение в отчёте, а не подтверждение отсутствия расходов бизнеса.</p><p>Сравниваются только выбранные магазины Ozon и одинаковые даты. Разница не означает рост или падение бизнеса. Задержки отчётов, даты признания доходов, возвраты и корректировки могут давать дополнительные расхождения. Текущий день предварительный в обеих версиях. WB в сравнение не входит.</p><p><a href="https://truestats.usedocs.com/article/80130" target="_blank" rel="noreferrer">Формулы TrueStats ↗</a> · <a href="https://truestats.usedocs.com/article/74713" target="_blank" rel="noreferrer">Правила себестоимости ↗</a></p></details>
   <details class="profit-connection" id="profit-connection"><summary>Подключение TrueStats</summary><p>Ключ вводится один раз и хранится на этом компьютере в защищённом хранилище Windows. Приложение только читает отчёты TrueStats.</p><form id="profit-connect-form"><label for="profit-api-key">API-токен TrueStats</label><div class="profit-key-row"><input id="profit-api-key" type="password" autocomplete="off" spellcheck="false" required minlength="20" maxlength="500" placeholder="Вставьте токен из настроек TrueStats"><button type="submit" class="button" id="profit-connect-button">Подключить</button></div><p id="profit-connect-result" role="status"></p></form></details>
  </div>`);
  let report=null,result=null,version=0,abort=null,mode='both',busy=false;
  try{const saved=localStorage.getItem('pult-profit-mode-v1');if(['both','ours','truestats'].includes(saved))mode=saved}catch{}
  const modeButtons=[...panel.querySelectorAll('[data-profit-mode]')];
  function setMode(value){mode=value;panel.dataset.profitMode=mode;local.hidden=mode==='truestats';modeButtons.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.profitMode===mode)));try{localStorage.setItem('pult-profit-mode-v1',mode)}catch{}}
  modeButtons.forEach(b=>b.onclick=()=>setMode(b.dataset.profitMode));setMode(mode);
  function paint(){
   const e=report?.economics;if(!e)return;
   const t=result?.metrics||{},hasReport=['ready','partial'].includes(result?.status);
   const accountIds=(result?.accounts||[]).map(a=>String(a.localStoreId)).sort();
   const scopeMatches=result?.scopeVerified===true&&JSON.stringify(accountIds)===JSON.stringify(e.stores.map(s=>String(s.id)).sort());
   const periodMatches=result?.period?.from===report.current.from&&result?.period?.to===report.current.to;
   const available=hasReport&&scopeMatches&&periodMatches;
   $('profit-ours-value').textContent=money(e.profit);$('profit-ours-cost').textContent=money(e.knownCogs);$('profit-ours-margin').textContent=percent(e.margin);
   $('profit-ours-status').textContent=e.complete?'Рассчитано':'Неполные данные';
   $('profit-ours-status').className='pill'+(e.complete?'':' warn');
   $('profit-ours-caption').textContent=e.complete?'Текущая себестоимость · без налогов и внешних расходов':'Рассчитано '+e.calculatedSkus+' из '+e.totalSkus+' SKU · полный итог недоступен';
   $('profit-true-value').textContent=money(available?t.profit:null);$('profit-true-cost').textContent=money(available?t.cogs:null);$('profit-true-margin').textContent=percent(available?t.margin:null);
   $('profit-true-status').textContent=busy?'Загрузка':available?'Из TrueStats':result?.status==='not_connected'?'Не подключён':result?.status==='pending'?'Ожидаем данные':'Нет отчёта';
   $('profit-true-status').className='pill'+(available?'':' warn');
   $('profit-true-caption').textContent=available?'Управленческий отчёт · загружен '+stamp(result.fetchedAt):'Управленческая отчётность · данные кабинета';
   $('profit-scope').textContent=report.current.from+' — '+report.current.to+' · Ozon · '+e.stores.map(s=>s.name).join(', ');
   $('profit-state').textContent=busy?'Читаем отчёт TrueStats за выбранный период…':hasReport&&!available?'Состав магазинов или период изменился. Проверьте выбранные фильтры и обновите отчёт.':result?.reason||(!available?'Для второй версии подключите TrueStats. Наш расчёт продолжает работать.':(result.warnings||[]).join(' · ')||'Две версии за одинаковый период и по выбранным магазинам.');
   const lastDates=(result?.readiness||[]).map(item=>item.lastDataDate).filter(Boolean).sort();
   if(!busy&&result?.status==='pending'&&lastDates.length)$('profit-state').textContent+=' Последняя подтверждённая дата среди выбранных магазинов: '+lastDates[0]+'.';
   const comparable=available;
   const delta=(a,b)=>comparable&&Number.isFinite(a)&&Number.isFinite(b)?(Math.round(b*100)-Math.round(a*100))/100:null;
   $('profit-delta').textContent=money(delta(e.profit,t.profit));
   $('profit-delta-note').textContent=!comparable||!e.complete?'Разница прибыли появится, когда обе версии доступны за одинаковый период. Частичный результат по SKU не сравнивается с полной прибылью.':'TrueStats учитывает налоги и внесённые внешние расходы. Разница отражает правила расчёта и состав данных, а не изменение прибыли во времени.';
   const rows=[['Реализация',e.realized,t.realized],['Удержания и корректировки',e.ozonDeductions,t.marketplaceDeductions],['Себестоимость',e.cogs,t.cogs],['Налоги',null,t.tax,'Не учтены'],['Операционные расходы',null,t.operatingExpenses,'Не учтены'],['Результат',e.profit,t.profit],['Результат до налогов и опер. расходов',e.profit,t.profitBeforeTaxAndOpex]];
   $('profit-breakdown-rows').innerHTML=rows.map(([label,a,b,note])=>'<tr><td>'+esc(label)+'</td><td class="numeric">'+(note?esc(note):money(a))+'</td><td class="numeric">'+money(available?b:null)+'</td><td class="numeric">'+money(delta(a,b))+'</td></tr>').join('');
   $('profit-reload').disabled=busy||!e.stores.length;
  }
  async function load(){
   if(!report?.economics)return;const request=++version;abort?.abort();abort=new AbortController();result=null;busy=true;paint();
   const query=new URLSearchParams({from:report.current.from,to:report.current.to});
   if(report.economics.stores.length===1)query.set('store',report.economics.stores[0].id);
   if(!report.economics.stores.length){result={status:'unavailable',reason:'Выберите магазины Ozon для сравнения.'};busy=false;paint();return}
   try{const response=await fetch('/api/economics/compare?'+query,{signal:abort.signal});const data=await response.json();if(request!==version)return;if(!response.ok)throw Error(data.error||'Не удалось загрузить сравнение');result=data;}
   catch(error){if(request!==version)return;result={status:'unavailable',reason:error.name==='AbortError'?'Загрузка прервана':error.message};}
   finally{if(request===version){busy=false;paint()}}
  }
  $('profit-reload').onclick=load;
  $('profit-connect-form').onsubmit=async event=>{
   event.preventDefault();const button=$('profit-connect-button'),input=$('profit-api-key');button.disabled=true;$('profit-connect-result').textContent='Проверяем доступ к TrueStats…';
   try{const response=await fetch('/api/truestats/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:input.value.trim()})});input.value='';const data=await response.json();if(!response.ok)throw Error(data.error||'Не удалось подключить TrueStats');$('profit-connect-result').textContent='Подключено. Ключ сохранён в защищённом хранилище Windows.';await load();}
   catch(error){input.value='';$('profit-connect-result').textContent=error.message}
   finally{button.disabled=false}
  };
  return {render(value){report=value;void load()}};
 };
})();
