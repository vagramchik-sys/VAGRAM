(function(){
 'use strict';
 const $=id=>document.getElementById(id),num=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
 const fields={migrationStatus:'migration-status',migrationDate:'migration-date',oldStore:'old-store',skuChanged:'sku-changed',adTarget:'ad-target',cpoRate:'cpo-rate',commission:'commission',skuTransferDates:'sku-transfer-dates',migrationNotes:'migration-notes',termsConfirmed:'terms-confirmed'};
 const defaults={migrationStatus:'unknown',migrationDate:'',oldStore:'',skuChanged:'unknown',adTarget:'',cpoRate:'',commission:'',skuTransferDates:'',migrationNotes:'',termsConfirmed:false};
 const contexts=new Map(),drafts=new Map();
 let currentScope=null,context={...defaults},latest={data:{accounts:[],products:[],campaigns:[]},filters:{}},advice=null,generated='',edited=false;
 const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
 const storageKey=scope=>'pult.xway.advisor.v1:'+encodeURIComponent(scope||'all');
 function readContext(scope){
  if(contexts.has(scope))return contexts.get(scope);
  let saved={};try{saved=JSON.parse(localStorage.getItem(storageKey(scope))||'{}');}catch{}
  const result={...defaults};for(const key of Object.keys(defaults))if(saved&&Object.hasOwn(saved,key))result[key]=saved[key];
  contexts.set(scope,result);return result;
 }
 function saveContext(){
  contexts.set(currentScope,{...context});
  try{localStorage.setItem(storageKey(currentScope),JSON.stringify(context));$('advisor-context-status').textContent='Сохранено в этом браузере для выбранного магазина. Настройки XWAY не меняются.';}
  catch{$('advisor-context-status').textContent='Браузер не сохранил вводные. Они действуют до закрытия страницы.';}
 }
 function loadFields(){for(const [key,id] of Object.entries(fields)){const node=$('advisor-'+id);if(node.type==='checkbox')node.checked=context[key]===true;else node.value=context[key]??'';}}
 function sourceLink(url){try{const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.hostname!=='am.xway.ru'||parsed.username||parsed.password)return null;const link=el('a','Открыть товар ↗');link.href=parsed.href;link.target='_blank';link.rel='noopener noreferrer';return link;}catch{return null;}}
 const period=row=>row.periodFrom&&row.periodTo?row.periodFrom+' — '+row.periodTo:'Период не подтверждён';
 const stages={historical:'До переноса',transition:'Переходный период','verify-migration':'Уточнить перенос','unknown-date':'Уточнить дату для SKU','needs-update':'Обновить данные','post-migration-sample':'Мало дней после переноса','post-migration':'После переноса',current:'Завершённый период'};
 function resetPrice(){for(const id of ['seller-price','buyer-price','peer-price'])$('advisor-'+id).value='';$('advisor-price-match').checked=false;$('advisor-price-margin').checked=false;}
 function priceResult(){
  const idea=advice?.priceIdeas[Number($('advisor-price-product').value)],selected=$('advisor-price-product').value!=='';
  const result=globalThis.XwayAdvisor.calculatePriceTrial({sellerPrice:Number($('advisor-seller-price').value),buyerPrice:Number($('advisor-buyer-price').value),peerBuyerPrice:Number($('advisor-peer-price').value),matchVerified:$('advisor-price-match').checked,marginVerified:$('advisor-price-margin').checked},selected?idea:undefined);
  const target=$('advisor-price-result');target.classList.toggle('is-ready',result.ready);
  target.textContent=result.ready?'Предварительная цена продавца для теста: '+num.format(result.proposedSellerPrice)+' ₽ (+'+num.format(result.stepPercent)+'%). '+result.reason:result.reason;
 }
 function updateDraft(force=false){
  const next=advice.supportDraft,target=$('advisor-support-draft');
  if(force||!edited){target.value=next;generated=next;edited=false;}
  const stale=edited&&generated!==next;
  $('advisor-draft-stale').hidden=!stale;$('advisor-copy').disabled=stale;
  $('advisor-copy-status').textContent=stale?'Черновик сохранён. Обновите его после изменения условий.':'Отправка — только вручную в чате XWAY.';
 }
 function render(data,filters){
  if(!globalThis.XwayAdvisor)return;
  latest={data,filters};const scope=filters.account||'';
  if(currentScope!==scope){
   if(currentScope!==null)drafts.set(currentScope,{text:$('advisor-support-draft').value,generated,edited});
   currentScope=scope;context=readContext(scope);loadFields();resetPrice();
   const draft=drafts.get(scope);generated=draft?.generated||'';edited=draft?.edited||false;$('advisor-support-draft').value=draft?.text||'';
   $('advisor-context-status').textContent='Вводные хранятся в этом браузере отдельно для каждого выбранного магазина.';
  }
  $('advisor-context-scope').textContent=scope?(data.accounts.find(row=>row.key===scope)?.name||'Выбранный магазин'):'Все магазины';
  advice=globalThis.XwayAdvisor.buildAdvice(data,context,filters);
  $('advisor-migration-summary').textContent=advice.migrationSummary;
  const cards=$('advisor-cards');cards.replaceChildren();
  for(const item of advice.cards){const card=el('article',undefined,'xway-advice-card '+item.tone);card.append(el('h3',item.title),el('p',item.reason),el('p',item.action,'xway-advice-action'));cards.append(card);}
  const findings=$('advisor-findings');findings.replaceChildren();$('advisor-finding-count').textContent=String(advice.findings.length);
  for(const item of advice.findings){const row=el('article',undefined,'xway-finding');row.append(el('strong',item.name),el('span',[item.accountName,'SKU '+item.sku,period(item),stages[item.stage]||'Проверить'].join(' · ')),el('p','Общий ДРР: '+(item.totalDrr===null?'нет данных':num.format(item.totalDrr)+'%')+' · Рекламные заказы: '+(item.orders===null?'нет данных':num.format(item.orders))+' · Клики: '+(item.clicks===null?'нет данных':num.format(item.clicks))));const link=sourceLink(item.sourceUrl);if(link)row.append(link);findings.append(row);}
  if(!advice.findings.length)findings.append(el('p','Товарных данных по выбранным условиям пока нет.','xway-empty'));
  const ideas=$('advisor-price-ideas'),select=$('advisor-price-product'),oldIdentity=select.selectedOptions[0]?.dataset.identity;ideas.replaceChildren();select.replaceChildren();const placeholder=el('option','Выберите товар');placeholder.value='';select.append(placeholder);
  advice.priceIdeas.forEach((item,index)=>{
   const card=el('article',undefined,'xway-price-idea '+item.status),heading=el('div',undefined,'xway-price-top');heading.append(el('strong',item.name),el('span',item.status==='check'?'Проверить цену':'Пока рано','xway-advice-badge'));card.append(heading,el('small','SKU '+item.sku+' · '+item.accountName+' · '+period(item)),el('p',item.reason),el('p',item.action,'xway-advice-action'));const link=sourceLink(item.sourceUrl);if(link)card.append(link);ideas.append(card);
   const option=el('option',item.name+' · '+item.sku);option.value=String(index);option.dataset.identity=item.accountName+':'+item.sku;select.append(option);if(option.dataset.identity===oldIdentity)select.value=String(index);
  });
  if(!advice.priceIdeas.length)ideas.append(el('p','Пока нет товарных данных для оценки повышения цены. Текст запроса в поддержку доступен ниже.','xway-empty'));
  if(select.value==='')resetPrice();priceResult();updateDraft();
 }
 // Existing campaign signals must use the same store/transfer boundary as the advisor.
 function analysisInput(data,filters){
  const scope=filters.account||'',ctx=readContext(scope);
  const allow=row=>{
   const resolved=globalThis.XwayAdvisor.resolveMigrationContext(row,ctx),migration=resolved.migrationDate;
   const validMigration=/^\d{4}-\d{2}-\d{2}$/.test(migration)&&Number.isFinite(Date.parse(migration))&&new Date(migration).toISOString().slice(0,10)===migration;
   return (!scope||row.accountKey===scope)&&(resolved.migrationStatus==='none'||resolved.migrationStatus==='recent'&&validMigration&&row.periodFrom>migration);
  };
  const campaigns=(data.campaigns||[]).filter(allow),products=(data.products||[]).filter(allow);
  const mixed=!scope&&new Set([...(data.campaigns||[]),...(data.products||[])].map(row=>row.accountKey)).size>1;
  return {...data,campaigns:mixed?[]:campaigns,products:mixed?[]:products};
 }
 for(const [key,id] of Object.entries(fields))$('advisor-'+id).addEventListener($('advisor-'+id).tagName==='SELECT'?'change':'input',()=>{
  const node=$('advisor-'+id);context[key]=node.type==='checkbox'?node.checked:node.type==='number'?(node.value===''?'':Number(node.value)):node.value;
  saveContext();resetPrice();document.dispatchEvent(new Event('xway-advisor-context'));
 });
 $('advisor-support-draft').addEventListener('input',()=>{edited=$('advisor-support-draft').value!==generated;});
 $('advisor-regenerate').addEventListener('click',()=>updateDraft(true));
 $('advisor-copy').addEventListener('click',async()=>{
  const target=$('advisor-support-draft');if($('advisor-copy').disabled)return;
  try{await navigator.clipboard.writeText(target.value);$('advisor-copy-status').textContent='Скопировано. Вставьте сообщение в чат поддержки XWAY.';}
  catch{target.focus();target.select();$('advisor-copy-status').textContent='Автокопирование недоступно. Текст выделен — нажмите Ctrl+C.';}
 });
 $('advisor-price-product').addEventListener('change',()=>{resetPrice();priceResult();});
 for(const id of ['seller-price','buyer-price','peer-price','price-match','price-margin'])$('advisor-'+id).addEventListener('input',priceResult);
 globalThis.XwayAdvisorView=Object.freeze({render,analysisInput});
})();
