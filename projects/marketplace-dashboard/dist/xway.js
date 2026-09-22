(function(){
 'use strict';
 const $=id=>document.getElementById(id),number=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}),date=new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'});
 let data={accounts:[],settings:[],campaigns:[]};
 const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
 const fmt=(value,suffix='')=>value==null?'—':number.format(value)+suffix;
 const time=value=>value&&Number.isFinite(Date.parse(value))?date.format(new Date(value)):'Дата не указана';
 const empty=(target,text)=>target.append(el('p',text,'xway-empty'));
 function optionList(id,values){const target=$(id);for(const value of [...new Set(values.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'))){const option=el('option',value);option.value=value;target.append(option);}}
 function render(){
  const account=$('account-filter').value,status=$('status-filter').value,strategy=$('strategy-filter').value,query=$('search').value.trim().toLocaleLowerCase('ru');
  const accounts=data.accounts.filter(row=>!account||row.key===account),campaigns=data.campaigns.filter(row=>(!account||row.accountKey===account)&&(!status||row.status===status)&&(!strategy||row.strategy===strategy)&&(!query||row.name.toLocaleLowerCase('ru').includes(query)));
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
 fetch('/api/xway',{credentials:'same-origin',cache:'no-store'}).then(async response=>{if(!response.ok)throw Error('unavailable');return response.json();}).then(value=>{
  if(value.mode!=='verified-observations'||!['accounts','settings','campaigns'].every(key=>Array.isArray(value[key])))throw Error('invalid');data=value;
  for(const row of data.accounts){const option=el('option',row.name+' · '+row.marketplace);option.value=row.key;$('account-filter').append(option);}
  optionList('status-filter',data.campaigns.map(row=>row.status));optionList('strategy-filter',data.campaigns.map(row=>row.strategy));render();
 }).catch(()=>{$('notice').className='xway-error';$('notice').textContent='Не удалось загрузить проверенные данные XWAY. Попробуйте открыть страницу позже.';$('observed').textContent='Данные сейчас недоступны.';});
})();
