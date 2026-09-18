'use strict';
const $=id=>document.getElementById(id);
let state=null,working=false;
const names={queued:'Ожидает разбора',draft:'Черновик готов к проверке',needs_data:'Нужны данные сотрудника',skipped:'Пропущено',answered:'После обращения уже есть исходящее письмо',converted:'Лид преобразован в сделку',duplicate:'Дубликат, повторная обработка не нужна',sending:'Отправка начата, результат не подтверждён',sent:'Почтовый сервис принял ответ, доставка не подтверждена',uncertain:'Результат отправки нужно проверить',closed:'Сделка закрыта'};
const entityNames={lead:'Лид',deal:'Сделка'};
function message(text,error=false){$('message').textContent=text;$('message').className=error?'error':'';}
function node(tag,text,cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
async function api(route,data){const r=await fetch('/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-b2b-token':state.nonce},body:JSON.stringify(data)});const v=await r.json();if(!r.ok)throw Error(v.error||'Операция не выполнена');return v;}
function render(){
  const newApi=typeof state.config.leadsEnabled==='boolean'&&typeof state.config.autoDraftEnabled==='boolean';
  $('version-note').hidden=newApi;
  $('crm').textContent=state.connections.crm?(state.config.newStageId?'Подключён':'Выберите стадию'):'Не подключён';
  $('onec').textContent=state.connections.oneC?'Адрес настроен':'Не подключена';
  $('model').textContent=state.model.models.includes(state.config.model)?'Готова к проверке':state.model.available?'Модель не загружена':'Нет соединения';
  $('total').textContent=state.cases.length;
  const scan=state.lastScan,dealRead=scan?.dealRead??scan?.read??0,leadRead=scan?.leadRead;
  $('scan-time').textContent=scan?`Обновление: ${new Date(scan.at).toLocaleString('ru-RU')} · сделок ${dealRead} · ${leadRead===undefined?'лиды не проверялись':'лидов '+leadRead}${scan.failed?' · ошибок '+scan.failed:''}`:'Загрузка CRM ещё не выполнялась';
  const process=state.lastProcess;
  $('processed').textContent=process?process.processed:'—';
  $('process-time').textContent=process?`Запуск: ${new Date(process.at).toLocaleString('ru-RU')}${process.failed?' · ошибок '+process.failed:''}`:'Письма ещё не разбирались';
  $('poll').textContent='Чтение раз в 5 минут: '+(state.config.pollEnabled?'вкл.':'выкл.');
  $('leads').textContent=newApi?'Новые лиды: '+(state.config.leadsEnabled?'вкл.':'выкл.'):'Новые лиды: нужен перезапуск';
  $('processing').textContent=newApi?'Подготовка ответов: '+(state.config.autoDraftEnabled?'вкл.':'выкл.'):'Подготовка ответов: нужен перезапуск';
  $('scan').disabled=!state.connections.crm||!state.config.newStageId||state.busy||working;
  $('poll').disabled=!state.connections.crm||!state.config.newStageId||working;
  $('leads').disabled=!newApi||!state.connections.crm||state.busy||working;
  $('processing').disabled=!newApi||!state.connections.crm||state.busy||working;
  $('process').disabled=!newApi||!state.connections.crm||state.busy||working;
  const holder=$('cases');holder.replaceChildren();
  if(!state.cases.length)holder.append(node('div','Подключите Битрикс24, чтобы увидеть реальные обращения. Демонстрационные сделки сюда не добавляются.','empty'));
  for(const row of state.cases){const item=node('article',undefined,'case'),head=node('div',undefined,'case-head'),label=node('div'),type=row.entityType||'deal',entityId=row.entityId??String(row.id||'').replace(/^lead:/,'');
    const meta=node('div',undefined,'case-meta');meta.append(node('span',entityNames[type]||'Обращение','entity '+type));if(entityId)meta.append(node('span','№ '+entityId));
    label.append(meta,node('h3',row.title||'Без названия'),node('small',row.status==='closed'&&type==='lead'?'Лид завершён или преобразован':names[row.status]||row.status));head.append(label);
    if(['queued','needs_data','draft'].includes(row.status)&&row.recipient){const b=node('button',row.processedFingerprint?'Повторить подготовку':'Подготовить черновик','secondary');b.disabled=state.busy||working||row.readFailed===true||(newApi&&type==='lead'&&!state.config.leadsEnabled);b.addEventListener('click',()=>act(()=>api('draft',{id:row.id}),'Подготовка завершена. Проверьте результат в карточке.'));head.append(b);}item.append(head);
    for(const reason of row.reasons||[])item.append(node('p',reason,'reason'));if(row.recipient)item.append(node('p','Обратный адрес: '+row.recipient));
    if(row.draft)item.append(node('div',['sent','sending','uncertain'].includes(row.status)?'Текст ответа · результат отправки указан в статусе':'Черновик для проверки сотрудником · клиенту не отправлен','draft-label'),node('pre',row.draft.body));holder.append(item);
  }
  const journal=$('events');journal.replaceChildren();if(!state.events.length)journal.append(node('p','Событий пока нет.'));for(const ev of state.events){const el=node('div',ev.message,'event');el.prepend(node('time',new Date(ev.at).toLocaleString('ru-RU')));journal.append(el);}
}
async function refresh(){const r=await fetch('/api/state');if(!r.ok)throw Error('Консоль недоступна');state=await r.json();render();}
async function act(fn,success){if(working)return;working=true;if(state)render();try{const value=await fn();message(success||'Готово');return value;}catch(e){message(e.message,true);}finally{working=false;await refresh().catch(e=>message(e.message,true));}}
$('connect').addEventListener('submit',e=>{e.preventDefault();const form=Object.fromEntries(new FormData(e.currentTarget));act(async()=>{const data=await api('connect',form);const select=$('newStageId'),before=select.value;select.replaceChildren(node('option','Выберите стадию'));select.firstChild.value='';for(const stage of data.stages){const opt=node('option',stage.name);opt.value=stage.id;select.append(opt);}select.value=before;$('webhook').value='';$('oneCToken').value='';},'Доступ проверен. Выберите начальную стадию и сохраните настройки.');});
$('scan').addEventListener('click',()=>act(()=>api('scan',{}),'Очередь обновлена'));
$('poll').addEventListener('click',()=>act(()=>api('poll',{enabled:!state.config.pollEnabled}),'Режим чтения изменён'));
$('leads').addEventListener('click',()=>act(()=>api('leads',{enabled:!state.config.leadsEnabled}),'Чтение новых лидов изменено'));
$('processing').addEventListener('click',()=>act(()=>api('processing',{enabled:!state.config.autoDraftEnabled}),'Автоподготовка черновиков изменена'));
$('process').addEventListener('click',()=>act(()=>api('process',{}),'Очередь обработана: не более 3 писем'));
$('demo').addEventListener('click',()=>act(async()=>{const b=$('demo');b.disabled=true;message('Локальная модель разбирает учебное письмо…');try{const d=await api('demo',{});$('demo-result').hidden=false;$('demo-result').textContent=`Учебная проверка · ${(d.elapsedMs/1000).toFixed(1)} сек.\n\n${d.extraction.summary}\n\n${d.draft.body}\n${d.draft.reasons.join('\n')}\n\nКлиентам ничего не отправлено.`;}finally{b.disabled=false;}},'Учебная проверка завершена'));
refresh().catch(e=>message(e.message,true));setInterval(()=>{if(!working)refresh().catch(e=>message(e.message,true));},15000);
