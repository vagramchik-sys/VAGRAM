(function(){
'use strict';
const $=id=>document.getElementById(id);
const storeSelect=$('store-select'),stateFilter=$('state-filter'),searchInput=$('campaign-search');
const rows=$('campaign-rows'),detail=$('campaign-detail'),notice=$('page-notice'),journalList=$('journal-list');
const model={stores:[],campaigns:[],storeId:'',campaignId:'',detail:null,journal:[],listController:null,detailController:null,listRequest:0,detailRequest:0};
const stateLabels={RUNNING:'Активна',INACTIVE:'Остановлена владельцем',STOPPED:'Недостаточно бюджета',PLANNED:'Запланирована Ozon',FINISHED:'Завершена',ARCHIVED:'В архиве',MODERATION_DRAFT:'Черновик модерации',MODERATION_IN_PROGRESS:'На модерации',MODERATION_FAILED:'Модерация не пройдена'};
const paymentLabels={CPC:'За клик',CPM:'За показы',CPO:'За заказ'};
const strategyLabels={TARGET_BIDS:'Целевые ставки',MAX_CLICKS:'Максимум кликов',MAX_ORDERS:'Максимум заказов',AUTO:'Автоматическая'};
const days=[['Пн',1],['Вт',2],['Ср',3],['Чт',4],['Пт',5],['Сб',6],['Вс',7]];
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node};
const value=(item,...keys)=>{for(const key of keys)if(item&&item[key]!==undefined&&item[key]!==null&&item[key]!=='')return item[key];return null};
const campaignName=item=>value(item,'title','name')||('Кампания '+String(value(item,'id')||'—'));
const money=n=>n!==null&&n!==undefined&&n!==''&&Number.isFinite(Number(n))?new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',minimumFractionDigits:Number(n)%1?2:0,maximumFractionDigits:2}).format(Number(n)):'Не подтверждён';
const dateTime=iso=>{if(!iso)return 'время не указано';const date=new Date(iso);return Number.isNaN(date.getTime())?'время не указано':date.toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'})};
function setNotice(message,error=false){notice.textContent=message||'';notice.classList.toggle('is-error',error)}
async function api(url,options){
 const response=await fetch(url,{headers:{'Accept':'application/json','Content-Type':'application/json'},...options});
 let body={};try{body=await response.json()}catch(error){const invalid=new Error('Сервер вернул неполный ответ.');invalid.status=response.status;invalid.body={code:'INVALID_RESPONSE'};invalid.invalidResponse=true;throw invalid}
 if(!response.ok){const err=new Error(body.error||body.blockedReason||('Ошибка '+response.status));err.status=response.status;err.body=body;throw err}
 return body;
}
function stateInfo(campaign){const state=String(value(campaign,'state')||'').toUpperCase().replace(/^CAMPAIGN_STATE_/,'');const active=state==='RUNNING'||(!state&&campaign.active===true);return {state,active,label:stateLabels[state]||(active?'Активна':state||'Неактивна')}}
function strategy(campaign){const raw=value(campaign,'productAutopilotStrategy','strategy');return raw===null?'Не указана Ozon':strategyLabels[String(raw).toUpperCase()]||String(raw)}
function statusBadge(campaign){const info=stateInfo(campaign),badge=el('span','ad-state',info.label);if(info.active)badge.classList.add('is-active');if(['STOPPED','MODERATION_FAILED'].includes(info.state))badge.classList.add('is-warning');return badge}
function campaignMatches(campaign){
 const query=searchInput.value.trim().toLocaleLowerCase('ru');const filter=stateFilter.value;const active=stateInfo(campaign).active;
 return (!query||(campaignName(campaign)+' '+String(campaign.id||'')).toLocaleLowerCase('ru').includes(query))&&(!filter||(filter==='active')===active);
}
function renderCampaigns(){
 rows.replaceChildren();const visible=model.campaigns.filter(campaignMatches);$('campaign-count').textContent=visible.length+' из '+model.campaigns.length;
 if(!visible.length){const tr=el('tr');const td=el('td','ad-empty',model.campaigns.length?'По фильтрам ничего не найдено.':'У магазина нет доступных кампаний.');td.colSpan=5;tr.append(td);rows.append(tr);return}
 for(const campaign of visible){
  const tr=el('tr','ad-campaign-row');tr.tabIndex=0;tr.setAttribute('role','button');tr.setAttribute('aria-label','Открыть кампанию '+campaignName(campaign));tr.dataset.id=String(campaign.id);tr.classList.toggle('is-selected',String(campaign.id)===model.campaignId);
  const nameCell=el('td');nameCell.append(el('strong','ad-campaign-name',campaignName(campaign)),el('small','ad-subtle','ID '+String(campaign.id||'—')));
  const stateCell=el('td');stateCell.append(statusBadge(campaign));
  const payment=el('td','',paymentLabels[String(value(campaign,'paymentType')||'').toUpperCase()]||value(campaign,'paymentType')||'Не указан');
  const strategyCell=el('td','',strategy(campaign));const budget=el('td','ad-money',money(value(campaign,'weeklyBudgetRub')));
  tr.append(nameCell,stateCell,payment,strategyCell,budget);tr.addEventListener('click',()=>selectCampaign(campaign.id));tr.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectCampaign(campaign.id)}});rows.append(tr);
 }
}
async function loadStores(){
 setNotice('');try{const data=await api('/api/ad-control');model.stores=Array.isArray(data.stores)?data.stores:[];storeSelect.replaceChildren();
  if(!model.stores.length){storeSelect.append(new Option('Нет доступных магазинов',''));storeSelect.disabled=true;$('campaign-meta').textContent='Подключите магазин Ozon, чтобы увидеть кампании';renderCampaigns();return}
  for(const store of model.stores)storeSelect.append(new Option(value(store,'name')||('Магазин '+store.id),store.id));const queryStore=new URLSearchParams(location.search).get('store'),savedStore=localStorage.getItem('pult.adControl.store');const preferred=[queryStore,savedStore].find(id=>id&&model.stores.some(store=>String(store.id)===String(id)));if(preferred)storeSelect.value=preferred;model.storeId=String(storeSelect.value);await loadCampaigns();
 }catch(error){storeSelect.replaceChildren(new Option('Не удалось загрузить магазины',''));storeSelect.disabled=true;setNotice('Не удалось загрузить магазины: '+error.message,true);rows.replaceChildren();const tr=el('tr'),td=el('td','ad-empty','Проверьте подключение и обновите страницу.');td.colSpan=5;tr.append(td);rows.append(tr)}
}
async function loadCampaigns(){
 model.listController?.abort();model.detailController?.abort();model.detailRequest++;const controller=new AbortController();model.listController=controller;const request=++model.listRequest;model.storeId=String(storeSelect.value||'');localStorage.setItem('pult.adControl.store',model.storeId);model.campaignId='';model.detail=null;model.campaigns=[];$('campaign-count').textContent='';renderDetailEmpty('Выберите кампанию слева. Данные загрузятся без изменения настроек в Ozon.');
 rows.replaceChildren();const tr=el('tr'),td=el('td','ad-empty','Загружаем кампании…');td.colSpan=5;tr.append(td);rows.append(tr);$('campaign-meta').textContent='Получаем актуальный список напрямую из Ozon';
 try{const data=await api('/api/ad-control/campaigns?store='+encodeURIComponent(model.storeId),{signal:controller.signal});if(request!==model.listRequest)return;model.campaigns=Array.isArray(data.campaigns)?data.campaigns:[];$('campaign-meta').textContent=data.observedAt?'Получено из Ozon '+dateTime(data.observedAt):'Получено напрямую из Ozon';renderCampaigns()}
 catch(error){if(error.name==='AbortError')return;model.campaigns=[];$('campaign-meta').textContent='Список не загружен';renderCampaigns();setNotice('Не удалось загрузить кампании: '+error.message,true)}
}
function renderDetailEmpty(text){detail.replaceChildren();const box=el('div','ad-detail-empty');box.append(el('h2','', 'Настройки кампании'),el('p','',text));detail.append(box)}
async function selectCampaign(id){
 const campaignId=String(id);if(model.campaignId===campaignId&&model.detail)return;model.campaignId=campaignId;renderCampaigns();model.detailController?.abort();const controller=new AbortController();model.detailController=controller;const request=++model.detailRequest;renderDetailEmpty('Загружаем актуальные настройки…');
 try{const data=await api('/api/ad-control/campaign?store='+encodeURIComponent(model.storeId)+'&campaign='+encodeURIComponent(campaignId),{signal:controller.signal});if(request!==model.detailRequest||campaignId!==model.campaignId)return;model.detail=data;renderDetail(data)}
 catch(error){if(error.name==='AbortError')return;if(request===model.detailRequest)renderDetailEmpty('Не удалось загрузить кампанию: '+error.message)}
}
function fact(label,text){const box=el('div','ad-fact');box.append(el('span','',label),el('strong','',text));return box}
function actionCard(title,description){const card=el('section','ad-card');card.append(el('h3','',title),el('p','',description));return card}
function button(text,className='ad-button'){const node=el('button',className,text);node.type='button';return node}
function labelled(labelText,input){const label=el('label','',labelText);label.append(input);return label}
function renderDetail(data){
 const campaign=data.campaign||{},cap=data.capabilities||{},schedule=data.schedule||{};detail.replaceChildren();
 mergePersistedJournal(data,model.storeId,String(campaign.id||model.campaignId));
 const head=el('div','ad-detail-head'),titleLine=el('div','ad-detail-title'),titleBox=el('div');titleBox.append(el('h2','',campaignName(campaign)),el('span','ad-detail-id','ID '+String(campaign.id||model.campaignId)));titleLine.append(titleBox,statusBadge(campaign));head.append(titleLine);
 const facts=el('div','ad-detail-facts');facts.append(fact('Тип оплаты',paymentLabels[String(value(campaign,'paymentType')||'').toUpperCase()]||value(campaign,'paymentType')||'Не указан'),fact('Стратегия Ozon',strategy(campaign)),fact('Бюджет в неделю',money(value(campaign,'weeklyBudgetRub'))),fact('Часовой пояс','Москва'));head.append(facts);detail.append(head);
 const exclusive=el('label','ad-exclusive'),exclusiveInput=document.createElement('input');exclusiveInput.type='checkbox';exclusiveInput.id='exclusive-control';exclusive.append(exclusiveInput,document.createTextNode('Для этой кампании отключено управление в XWAY и других сервисах'));detail.append(exclusive);
 const actions=el('div','ad-actions');actions.append(renderBudget(campaign,cap,exclusiveInput),renderState(campaign,cap,exclusiveInput),renderSchedule(schedule,cap,exclusiveInput,data.notice,data.scheduler),renderBid(data.products||[],cap,exclusiveInput,data.productsError));detail.append(actions);
}
function renderBudget(campaign,cap,exclusive){
 const card=actionCard('Недельный бюджет','Изменение применяется только после отдельного подтверждения.');const input=document.createElement('input');input.type='number';input.min='1';input.step='1';input.value=value(campaign,'weeklyBudgetRub')??'';input.inputMode='numeric';const fields=el('div','ad-fields');fields.append(labelled('Бюджет, ₽ в неделю',input));card.append(fields);const preview=button('Проверить изменение');preview.disabled=cap.budgetWrite===false;preview.addEventListener('click',()=>previewAction(card,{kind:'budget',weeklyBudgetRub:Number(input.value)},exclusive,'budget'));card.append(actionsRow(preview));if(cap.budgetWrite===false)card.append(el('p','ad-blocked','Изменение бюджета недоступно для этой кампании.'));return card;
}
function renderState(campaign,cap,exclusive){
 const info=stateInfo(campaign),allowed=['RUNNING','INACTIVE'].includes(info.state);const card=actionCard('Состояние кампании',allowed?'Можно отдельно остановить или запустить кампанию.':'Ozon не разрешает менять этот статус вручную.');const row=el('div','ad-card-actions');const target=!info.active;const change=button(target?'Проверить запуск':'Проверить остановку',target?'ad-button primary':'ad-button danger');change.disabled=cap.stateWrite===false||!allowed;change.addEventListener('click',()=>previewAction(card,{kind:'state',active:target},exclusive,'state'));row.append(change);card.append(row);return card;
}
function renderSchedule(schedule,cap,exclusive,detailNotice,scheduler){
 const card=actionCard('Расписание','Пульт запускает обратно только кампанию, которую сам остановил по этому расписанию. Исходно выключенную кампанию можно запустить вручную после настройки.');
 const fields=el('div','ad-fields'),enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=Boolean(schedule.enabled);const enabledLabel=el('label','ad-check');enabledLabel.append(enabled,document.createTextNode('Расписание включено'));
 const dayBox=el('div','ad-days');for(const [name,num] of days){const label=el('label','ad-day'),input=document.createElement('input');input.type='checkbox';input.value=String(num);input.checked=Array.isArray(schedule.days)&&schedule.days.map(Number).includes(num);label.append(input,el('span','',name));dayBox.append(label)}
 const start=document.createElement('input'),end=document.createElement('input');start.type=end.type='time';start.value=schedule.start||'09:00';end.value=schedule.end||'21:00';fields.append(enabledLabel,dayBox,labelled('Начало, Москва',start),labelled('Окончание, Москва',end));card.append(fields);
 const save=button('Проверить расписание');save.disabled=cap.scheduleWrite===false;save.addEventListener('click',()=>previewAction(card,{kind:'schedule',enabled:enabled.checked,days:[...dayBox.querySelectorAll('input:checked')].map(item=>Number(item.value)),start:start.value,end:end.value,timezone:'Europe/Moscow'},exclusive,'schedule'));card.append(actionsRow(save));
 if(detailNotice)card.append(el('p','',detailNotice));card.append(el('p','','Расписание выполняется, пока работает сервер Пульта.'));if(schedule.resumeAllowed===false&&schedule.enabled)card.append(el('p','ad-blocked','Автозапуск пока не разрешён: Пульт не останавливал эту кампанию по расписанию.'));
 const schedulerError=value(scheduler,'lastErrorCode')||value(scheduler&&scheduler.campaign,'lastErrorCode');if(schedulerError)card.append(el('p','ad-blocked','Расписание требует внимания: '+String(schedulerError)+'. Проверьте доступ к Ozon.'));else if(scheduler&&scheduler.running===false)card.append(el('p','ad-blocked','Обработчик расписания сейчас не работает. Изменения времени сохранены, но не будут выполняться до запуска сервера.'));return card;
}
function renderBid(products,cap,exclusive,productsError){
 const reason=cap.bidBlockedReason||'Ставки пока недоступны: Ozon может удалить стоп-слова и фразы кампании, а единицы текущей ставки не подтверждены.';const card=actionCard('Ставка по товару',cap.bidWrite? 'Выберите SKU и укажите новую ставку.':reason);const select=document.createElement('select');select.append(new Option(products.length?'Выберите товар':'Товары не получены',''));for(const product of products){const title=value(product,'title','name')||('SKU '+product.sku);select.append(new Option(title+' · SKU '+product.sku+' · ставка: '+(value(product,'bidRub','currentBid')===null?'Не подтверждена':money(value(product,'bidRub','currentBid'))),product.sku))}const input=document.createElement('input');input.type='number';input.min='0.01';input.step='0.01';input.placeholder='₽';const fields=el('div','ad-fields');fields.append(labelled('Товар / текущая ставка',select),labelled('Новая ставка, ₽',input));card.append(fields);const preview=button('Проверить ставку');preview.disabled=!cap.bidWrite;preview.addEventListener('click',()=>previewAction(card,{kind:'bid',sku:select.value,bidRub:Number(input.value)},exclusive,'bid'));card.append(actionsRow(preview));if(!cap.bidWrite)card.append(el('p','ad-blocked','Текущая ставка: Не подтверждена. '+reason));if(productsError)card.append(el('p','ad-blocked','Товары не загружены: '+String(productsError)));return card;
}
function actionsRow(...nodes){const row=el('div','ad-card-actions');row.append(...nodes);return row}
function validateAction(action){if(action.kind==='budget'&&!(action.weeklyBudgetRub>0))return 'Укажите бюджет больше нуля.';if(action.kind==='bid'&&(!action.sku||!(action.bidRub>0)))return 'Выберите товар и укажите ставку больше нуля.';if(action.kind==='schedule'){if(action.enabled&&!action.days.length)return 'Выберите хотя бы один день.';if(!action.start||!action.end)return 'Укажите начало и окончание.';if(action.start>=action.end)return 'Окончание должно быть позже начала.'}return ''}
async function previewAction(card,action,exclusive,kind){
 const invalid=validateAction(action);if(invalid){setNotice(invalid,true);return}if(!exclusive.checked){setNotice('Подтвердите, что для кампании отключено управление в XWAY и других сервисах.',true);exclusive.focus();return}setNotice('');detail.querySelectorAll('.ad-preview').forEach(node=>node.remove());const busy=el('div','ad-preview','Проверяем изменение в Ozon…');card.append(busy);
 const scope={storeId:model.storeId,campaignId:model.campaignId,campaignName:campaignName(model.detail&&model.detail.campaign)};
 try{const data=await api('/api/ad-control/preview',{method:'POST',body:JSON.stringify({storeId:scope.storeId,campaignId:scope.campaignId,action,exclusiveControl:true})});busy.remove();if(scope.storeId!==model.storeId||scope.campaignId!==model.campaignId||!card.isConnected)return;renderPreview(card,data,action,kind,scope)}catch(error){busy.remove();if(scope.storeId===model.storeId&&scope.campaignId===model.campaignId)setNotice('Не удалось проверить изменение: '+error.message,true)}
}
function changeValue(raw,kind){if(raw===null||raw===undefined||raw==='')return'—';if(typeof raw!=='object')return String(raw);if(kind==='schedule'){const dayNames={1:'Пн',2:'Вт',3:'Ср',4:'Чт',5:'Пт',6:'Сб',7:'Вс'},selected=Array.isArray(raw.days)?raw.days.map(day=>dayNames[Number(day)]||day).join(', '):'дни не указаны';return raw.enabled===false?'Выключено':'Включено: '+selected+', '+String(raw.start||'—')+'–'+String(raw.end||'—')+' (Москва)'}return Object.entries(raw).map(([key,val])=>key+': '+String(val)).join(', ')}
function renderPreview(card,data,action,kind,scope){
 const box=el('div','ad-preview');box.append(el('h4','',data.blockedReason?'Изменение недоступно':'Подтвердите изменение'));
 if(data.blockedReason){box.append(el('p','ad-warning',data.blockedReason));card.append(box);return}
 const list=el('ul','ad-changes');for(const change of Array.isArray(data.changes)?data.changes:[]){const item=el('li');item.append(document.createTextNode(String(change.label||'Изменение')+': '),el('strong','',changeValue(change.before,kind)+' → '+changeValue(change.after,kind)));list.append(item)}box.append(list);
 for(const warning of Array.isArray(data.warnings)?data.warnings:[])box.append(el('p','ad-warning',warning));box.append(el('p','ad-preview-meta','Подтверждение действует до '+dateTime(data.expiresAt)+'.'));
 const apply=button(kind==='schedule'?'Сохранить расписание':'Применить в Ozon','ad-button primary');const cancel=button('Отмена');const command={token:data.token,commandId:crypto.randomUUID(),action,campaignName:scope.campaignName,storeId:scope.storeId,campaignId:scope.campaignId,kind};apply.addEventListener('click',()=>applyPreview(command,apply,box));cancel.addEventListener('click',()=>box.remove());box.append(actionsRow(apply,cancel));card.append(box);
}
async function applyPreview(command,applyButton,previewBox){
 applyButton.disabled=true;const entry={id:command.commandId,status:'pending',label:actionLabel(command),campaignName:command.campaignName,time:new Date().toISOString(),storeId:command.storeId,campaignId:command.campaignId,kind:command.kind,detail:'Отправлено в Ozon'};model.journal.unshift(entry);renderJournal();
 try{const data=await api('/api/ad-control/apply',{method:'POST',body:JSON.stringify({token:command.token,commandId:command.commandId})});entry.status=data.commandId===command.commandId?normalizeResult(data.status,data.ok):'unknown';entry.detail=data.message||resultText(entry.status,command.kind);if(entry.status==='applied'){previewBox.remove();await refreshAfterMutation(entry)}else if(entry.status==='unknown')entry.detail=data.error||'Результат не подтверждён. Сверьте фактическое состояние.';renderJournal()}
 catch(error){const definitive=Number.isInteger(error.status)&&error.status>=400&&error.status<500&&![408,425,429].includes(error.status)&&!(error.body&&error.body.code==='OUTCOME_UNKNOWN');entry.status=definitive?'failed':'unknown';entry.detail=definitive?error.message:(error.message||'Ответ не получен. Сверьте фактическое состояние перед новым изменением.');renderJournal()}
}
function normalizeResult(status,ok){if(status==='applied'&&ok===true)return'applied';if(status==='rejected'||status==='failed')return'failed';return'unknown'}
function actionLabel(command){return {budget:'Изменение бюджета',state:command.action.active?'Запуск кампании':'Остановка кампании',schedule:'Сохранение расписания',bid:'Изменение ставки'}[command.kind]||'Изменение кампании'}
function resultText(status,kind){return status==='applied'?(kind==='schedule'?'Расписание сохранено в Пульте':'Применено в Ozon'):status==='unknown'?'Результат неизвестен':'Не применено'}
async function refreshAfterMutation(entry){renderJournal();if(entry.storeId===model.storeId&&entry.campaignId===model.campaignId){model.detail=null;await selectCampaign(entry.campaignId)}const storeId=model.storeId;model.listController?.abort();const controller=new AbortController();model.listController=controller;const request=++model.listRequest;try{const data=await api('/api/ad-control/campaigns?store='+encodeURIComponent(storeId),{signal:controller.signal});if(request!==model.listRequest||storeId!==model.storeId)return;model.campaigns=Array.isArray(data.campaigns)?data.campaigns:[];renderCampaigns()}catch(error){if(error.name!=='AbortError'&&storeId===model.storeId)setNotice('Изменение применено, но список пока не обновился.',false)}}
function actionLabelFrom(action){if(!action)return'Изменение кампании';return {budget:'Изменение бюджета',state:action.active?'Запуск кампании':'Остановка кампании',schedule:'Сохранение расписания',bid:'Изменение ставки'}[action.kind]||'Изменение кампании'}
function mergePersistedJournal(data,storeId,campaignId){
 const campaign=campaignName(data.campaign||{}),records=Array.isArray(data.audit)?data.audit:[];if(data.pending)records.unshift({...data.pending,status:'unknown'});
 let seen=false;
 for(const record of records){if(!record||!record.commandId)continue;let entry=model.journal.find(item=>item.id===record.commandId);const status=record.status==='pending'?'unknown':record.status==='rejected'?'failed':record.status;if(!entry){entry={id:record.commandId,storeId:String(storeId),campaignId:String(campaignId),campaignName:campaign,label:actionLabelFrom(record.action),time:record.at||record.startedAt||new Date().toISOString(),status,kind:record.action&&record.action.kind,detail:''};model.journal.push(entry)}entry.kind=entry.kind||(record.action&&record.action.kind);entry.status=status;entry.detail=status==='unknown'?'Результат не подтверждён. Сверьте фактическое состояние.':record.source==='schedule'&&status==='applied'?'Выполнено расписанием':resultText(status,entry.kind)}
 for(const record of records)if(record&&record.commandId)seen=true;
 model.journal.sort((a,b)=>String(b.time).localeCompare(String(a.time)));renderJournal();
 return seen;
}
function renderJournal(){
 journalList.replaceChildren();if(!model.journal.length){journalList.append(el('p','ad-empty','Изменений пока нет.'));return}
 const labels={pending:'Ожидает',applied:'Применено',unknown:'Неизвестно',failed:'Ошибка'};for(const entry of model.journal){const item=el('article','ad-journal-item'),badge=el('span','ad-journal-status '+entry.status,labels[entry.status]||entry.status),body=el('div');body.append(el('strong','',entry.label+' · '+entry.campaignName),el('small','',entry.detail+' · '+dateTime(entry.time)));item.append(badge,body);if(entry.status==='unknown'){const reconcile=button('Сверить с Ozon','ad-button ad-reconcile');reconcile.addEventListener('click',()=>reconcileEntry(entry,reconcile));item.append(reconcile)}journalList.append(item)}
}
async function reconcileEntry(entry,buttonNode){
 buttonNode.disabled=true;entry.detail='Сверяем фактическое состояние…';renderJournal();try{const data=await api('/api/ad-control/reconcile',{method:'POST',body:JSON.stringify({storeId:entry.storeId,campaignId:entry.campaignId})});if(data.commandId===entry.id&&data.status!=='idle'){entry.status=normalizeResult(data.status,data.ok);entry.detail=data.message||resultText(entry.status,entry.kind);if(entry.status==='unknown')entry.detail=data.message||'Ozon пока не подтвердил результат. Повторно применять изменение автоматически нельзя.'}else if(!await loadPersistedJournal(entry.storeId,entry.campaignId,entry.id)){entry.status='unknown';entry.detail='Результат этой команды не найден. Обновите данные перед новым изменением.'}}catch(error){entry.status='unknown';entry.detail='Не удалось сверить: '+error.message}renderJournal();if(entry.storeId===model.storeId&&entry.campaignId===model.campaignId&&entry.status==='applied')refreshAfterMutation(entry)
}
async function loadPersistedJournal(storeId,campaignId,commandId){const data=await api('/api/ad-control/campaign?store='+encodeURIComponent(storeId)+'&campaign='+encodeURIComponent(campaignId));mergePersistedJournal(data,String(storeId),String(campaignId));return Boolean((data.pending&&data.pending.commandId===commandId)||(Array.isArray(data.audit)&&data.audit.some(item=>item.commandId===commandId)))}
storeSelect.addEventListener('change',()=>loadCampaigns());stateFilter.addEventListener('change',renderCampaigns);searchInput.addEventListener('input',renderCampaigns);loadStores();
})();
