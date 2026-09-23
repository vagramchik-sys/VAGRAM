(function(){'use strict';
 const $=id=>document.getElementById(id),model=window.PultDataUpdatesModel,POLL_MS=30000;
 const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const time=value=>model.validTime(value)?new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
 const cadence=value=>Number.isSafeInteger(value)&&value>0?'Каждые '+(value%3600000===0?value/3600000+' ч':value/60000+' мин'):null;
 let busy=false,destroyed=false,controller=null,last=null;
 function render(value){
  const rows=model.rows(value),counts={running:0,waiting:0,delayed:0,error:0,ready:0};for(const row of rows)if(Object.hasOwn(counts,row.view.key))counts[row.view.key]++;
  $('data-update-summary').innerHTML=[['В работе',counts.running],['Ожидают',counts.waiting],['С задержкой',counts.delayed],['С ошибкой',counts.error]].map(([label,count])=>'<article><span>'+label+'</span><strong>'+count+'</strong></article>').join('');
  $('data-update-rows').innerHTML=rows.length?rows.map(row=>'<tr><td><strong>'+esc(row.title)+'</strong><small>'+esc(row.kind)+'</small></td><td>'+esc(row.storeName||'Общие данные')+'<small>'+esc(row.market||'Служебный источник')+'</small></td><td><span class="status is-'+esc(row.view.key)+'">'+esc(row.view.label)+'</span></td><td>'+time(row.lastSuccessAt)+'</td><td>'+(row.nextDueKind==='manual'?'По запросу':time(row.nextDueAt)+(row.nextDueKind==='estimate'?'<small>Ориентир по регламенту</small>':'')+(cadence(row.intervalMs)?'<small>'+esc(cadence(row.intervalMs))+'</small>':''))+'</td><td>'+time(row.attemptAt)+'</td><td>'+((row.errorCodes||[]).length?'<code>'+esc(row.errorCodes.join(', '))+'</code>':'—')+'</td></tr>').join(''):'<tr><td colspan="7" class="empty">Регламентные источники ещё не зарегистрированы.</td></tr>';
  last=value;$('data-update-checked').textContent='Последняя проверка: '+time(value.checkedAt);$('data-update-state').textContent='Статусы получены. Страница ничего не запускает и не изменяет.';$('data-update-state').className='data-update-state';
 }
 async function load(force=false){
  if(destroyed||busy||document.hidden&&!force)return;busy=true;$('data-update-refresh').disabled=true;if(!last)$('data-update-state').textContent='Получаем статусы…';controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);
  try{const response=await fetch('/api/data-updates',{signal:controller.signal,headers:{Accept:'application/json'}}),value=await response.json();if(!response.ok)throw Error(value?.error||'Статусы недоступны');if(!value||!Array.isArray(value.jobs))throw Error('Некорректный ответ статусов');render(value)}catch(error){if(!destroyed){$('data-update-state').textContent=error?.name==='AbortError'?'Проверка заняла слишком много времени. Повторите запрос.':'Не удалось получить статусы обновлений.';$('data-update-state').className='data-update-state is-error'}}finally{clearTimeout(timeout);controller=null;busy=false;if(!destroyed)$('data-update-refresh').disabled=false}
 }
 $('data-update-refresh').onclick=()=>void load(true);
 const visibility=()=>{if(!document.hidden)void load()};document.addEventListener('visibilitychange',visibility);const timer=setInterval(()=>void load(),POLL_MS);void load(true);
 window.PultDataUpdates={refresh:()=>load(true),destroy(){destroyed=true;controller?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visibility)}};
})();
