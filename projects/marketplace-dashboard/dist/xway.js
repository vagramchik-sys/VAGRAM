(function(){
 'use strict';
 const $=id=>document.getElementById(id),number=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}),date=new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'});
 let data={accounts:[],settings:[],campaigns:[],products:[]};
 const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
 const fmt=(value,suffix='')=>value==null?'—':number.format(value)+suffix;
 const time=value=>value&&Number.isFinite(Date.parse(value))?date.format(new Date(value)):'Дата не указана';
 const empty=(target,text)=>target.append(el('p',text,'xway-empty'));
 function optionList(id,values){const target=$(id);for(const value of [...new Set(values.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'))){const option=el('option',value);option.value=value;target.append(option);}}
 function renderOpportunities(filters){
  const target=$('opportunities');target.replaceChildren();
  if(!globalThis.XwayOpportunities){empty(target,'Сигналы сейчас недоступны.');return;}
  const input=globalThis.XwayAdvisorView?globalThis.XwayAdvisorView.analysisInput(data,filters):data;
  const result=globalThis.XwayOpportunities.analyze(input,filters),groups=[['Проблемные места',result.problems,'problem'],['Кандидаты на рост',result.growth,'growth'],['Нужно проверить данные',result.needsData,'needs-data']];
  for(const [title,items,tone] of groups){
   const section=el('section',undefined,'xway-opportunity-group '+tone),heading=el('h3',title);heading.append(el('span',String(items.length),'xway-opportunity-count'));section.append(heading);
   const list=el('div',undefined,'xway-opportunity-list');
   const appendCard=(parent,item)=>{const article=el('article',undefined,'xway-opportunity-card'),top=el('div',undefined,'xway-opportunity-top');top.append(el('strong',item.title),el('span',item.entity==='product'?'Товар':'Кампания'));article.append(top,el('p',item.reason),el('p','Что сделать: '+item.action,'xway-action'),el('p',item.fact,'xway-fact'));const meta=el('div',undefined,'xway-opportunity-meta');meta.append(el('span',item.period),el('span','Проверено: '+time(item.observedAt)));if(item.sourceUrl){const link=el('a','Источник ↗');link.href=item.sourceUrl;link.target='_blank';link.rel='noopener noreferrer';meta.append(link);}article.append(meta);parent.append(article);};
   items.slice(0,3).forEach(item=>appendCard(list,item));section.append(list);
   if(items.length>3){const details=el('details',undefined,'xway-opportunity-more'),summary=el('summary','Показать ещё '+(items.length-3)),rest=el('div',undefined,'xway-opportunity-list');details.append(summary);items.slice(3).forEach(item=>appendCard(rest,item));details.append(rest);section.append(details);}
   if(!items.length)section.append(el('p','По выбранным условиям сигналов нет.','xway-empty xway-empty-compact'));target.append(section);
  }
  $('attention-note').textContent='В выборке кампаний: '+result.meta.campaignCount+', товаров: '+result.meta.productCount+'. Покрытие может быть частичным. Периоды до переноса и с неуточнённым переносом исключены из сигналов.'+(result.meta.productFiltersIgnoreCampaignFields?' Статус и стратегия относятся к кампаниям; товарные сигналы учитывают магазин и поиск.':'');
 }
 function render(){
  const account=$('account-filter').value,status=$('status-filter').value,strategy=$('strategy-filter').value,query=$('search').value.trim().toLocaleLowerCase('ru');
  const accounts=data.accounts.filter(row=>!account||row.key===account),campaigns=data.campaigns.filter(row=>(!account||row.accountKey===account)&&(!status||row.status===status)&&(!strategy||row.strategy===strategy)&&(!query||row.name.toLocaleLowerCase('ru').includes(query)));
  globalThis.XwayAdvisorView?.render(data,{account,status,strategy,query});
  renderOpportunities({account,status,strategy,query});
  const financialVisible={spend:data.campaigns.some(row=>(!account||row.accountKey===account)&&row.spend!==null),revenue:data.campaigns.some(row=>(!account||row.accountKey===account)&&row.revenue!==null)};
  const headers=document.querySelectorAll('.xway-table-scroll th');headers[9].hidden=!financialVisible.spend;headers[10].hidden=!financialVisible.revenue;
  $('accounts').replaceChildren();
  for(const row of accounts){
   const card=el('article',undefined,'xway-account');card.append(el('h2',row.name),el('small',row.marketplace+' · '+time(row.observedAt)));
   const metrics=el('div',undefined,'xway-account-metrics');
   for(const [label,value] of [['Товаров в кабинете',fmt(row.productsCount)],['Кампаний всего',fmt(row.campaignsCount)],['Подключено товаров',fmt(row.connectedProductsCount)],['Лимит тарифа',fmt(row.productLimit)]]){const metric=el('div',undefined,'xway-metric');metric.append(el('strong',value),el('span',label));metrics.append(metric);}
   const meta=el('div',undefined,'xway-account-meta');meta.append(el('span','Подключение: '+(row.connectionStatus||'Не проверено')),el('span','Тариф: '+(row.tariff||'Не проверен')));const source=el('a','Источник ↗');source.href=row.sourceUrl;source.target='_blank';source.rel='noopener noreferrer';meta.append(source);card.append(metrics,meta);$('accounts').append(card);
  }
  if(!accounts.length)empty($('accounts'),'Проверенных данных кабинета пока нет.');
  const inspected=data.campaigns.filter(row=>!account||row.accountKey===account).length,total=accounts.length&&accounts.every(row=>row.campaignsCount!==null)?accounts.reduce((sum,row)=>sum+row.campaignsCount,0):null;
  $('coverage').textContent='Проверено '+fmt(inspected)+(total===null?' кампаний.':' из '+fmt(total)+' кампаний.')+' Непросмотренные и архивные кампании могут отсутствовать.';
  $('campaign-count').textContent='Показано '+fmt(campaigns.length);
  $('campaign-rows').replaceChildren();
  for(const row of campaigns){
   const tr=el('tr'),name=el('td');name.append(el('strong',row.name),el('small',[row.strategy||row.type,row.schedule?'Показы: '+row.schedule:null].filter(Boolean).join(' · ')));tr.append(name);
   const state=el('td');state.append(el('span',row.status||'Не проверен','xway-status'));tr.append(state);
   const values=[fmt(row.productsCount)+' / '+fmt(row.productsTotalCount),fmt(row.impressions),fmt(row.clicks),fmt(row.ctr,'%'),fmt(row.carts),fmt(row.orders),fmt(row.clickToOrder,'%'),fmt(row.spend,' ₽'),fmt(row.revenue,' ₽'),fmt(row.drr,'%')];
   for(const value of values)tr.append(el('td',value));
   tr.children[9].hidden=!financialVisible.spend;tr.children[10].hidden=!financialVisible.revenue;
   const period=el('td',row.periodFrom&&row.periodTo?row.periodFrom+' — '+row.periodTo:'Период не указан');period.append(el('small',time(row.observedAt)));tr.append(period);$('campaign-rows').append(tr);
  }
  if(!campaigns.length){const tr=el('tr'),td=el('td','Кампаний по выбранным условиям нет.');td.colSpan=13-Number(!financialVisible.spend)-Number(!financialVisible.revenue);tr.append(td);$('campaign-rows').append(tr);}
  $('settings').replaceChildren();
  for(const row of data.settings.filter(row=>!account||row.accountKey===account)){const item=el('div',undefined,'xway-setting'),label=el('span',row.label),value=el('strong',row.value);value.append(el('small','Проверено '+time(row.observedAt)));item.append(label,value);$('settings').append(item);}
  if(!$('settings').childElementCount)empty($('settings'),'Настройки пока не проверены.');
  const times=[...accounts,...data.settings.filter(row=>!account||row.accountKey===account),...data.campaigns.filter(row=>!account||row.accountKey===account)].map(row=>Date.parse(row.observedAt)).filter(Number.isFinite);
  $('observed').textContent=times.length?'Последняя проверка: '+time(new Date(Math.max(...times)).toISOString())+'. Сохранённые наблюдения, без автоматической синхронизации.':'Дата проверки появится после импорта подтверждённых фактов.';
 }
 for(const id of ['account-filter','status-filter','strategy-filter'])$(id).addEventListener('change',render);$('search').addEventListener('input',render);
 document.addEventListener('xway-advisor-context',render);
 globalThis.XwayAdvisorView?.render(data,{});
 fetch('/api/xway',{credentials:'same-origin',cache:'no-store'}).then(async response=>{if(!response.ok)throw Error('unavailable');return response.json();}).then(value=>{
  if(value.mode!=='verified-observations'||!['accounts','settings','campaigns'].every(key=>Array.isArray(value[key])))throw Error('invalid');data={...value,products:Array.isArray(value.products)?value.products:[]};
  for(const row of data.accounts){const option=el('option',row.name+' · '+row.marketplace);option.value=row.key;$('account-filter').append(option);}
  if(data.accounts.length===1)$('account-filter').value=data.accounts[0].key;
  optionList('status-filter',data.campaigns.map(row=>row.status));optionList('strategy-filter',data.campaigns.map(row=>row.strategy));render();
 }).catch(()=>{$('notice').className='xway-error';$('notice').textContent='Не удалось загрузить проверенные данные XWAY. Попробуйте открыть страницу позже.';$('observed').textContent='Данные сейчас недоступны.';});
})();
