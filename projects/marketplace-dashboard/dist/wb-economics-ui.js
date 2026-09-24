(function(){
 'use strict';
 const $=id=>document.getElementById(id);
 const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const amount=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
 const decimal=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
 const money=value=>Number.isFinite(value)?amount.format(value)+' ₽':'—';
 const currencyMoney=(value,currency)=>{
  if(!Number.isFinite(value)||typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency))return '—';
  try{return new Intl.NumberFormat('ru-RU',{style:'currency',currency,maximumFractionDigits:0}).format(value)}catch{return '—'}
 };
 const percent=value=>Number.isFinite(value)?decimal.format(value)+'%':'—';
 const integer=value=>Number.isFinite(value)?amount.format(value):'—';
 const date=value=>value?new Date(value+'T12:00:00Z').toLocaleDateString('ru-RU'):'—';
 const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

 window.createPultWBEconomics=function(){
  const executive=$('executive');
  if(!executive)return {render(){}};
  executive.insertAdjacentHTML('beforebegin',`<section class="wb-eco" id="wb-economics" hidden>
   <div class="wb-eco-head"><div><span class="wb-eco-kicker">TRUESTATS · WILDBERRIES</span><h2>Wildberries · продажи и прибыль</h2><p id="wb-eco-scope">Данные вашего кабинета за выбранный период</p></div><span class="wb-eco-status" id="wb-eco-status">Загрузка</span></div>
   <label class="wb-eco-range">Период WB <select id="wb-eco-range"><option value="today">Сегодня</option><option value="yesterday">Вчера</option><option value="7">7 завершённых дней</option><option value="14">14 завершённых дней</option><option value="30">30 дней по сегодня</option><option value="custom" disabled>Выбранные даты сводки</option></select></label><div class="wb-eco-message" id="wb-eco-message" role="status" aria-live="polite"></div>
   <button type="button" class="button wb-eco-period-button" id="wb-eco-seven" hidden>Последние 7 завершённых дней</button>
   <div class="wb-eco-kpis" id="wb-eco-kpis"></div>
   <div class="wb-eco-source"><b>Источник прибыли: TrueStats · управленческий отчёт WB</b><span>ROI = прибыль / себестоимость × 100%. Выплаты и перечисления площадки не считаются прибылью.</span></div>
   <details class="wb-eco-details"><summary>Расходы и состав прибыли</summary><div class="wb-eco-breakdown" id="wb-eco-breakdown"></div><p>Продажи, себестоимость, налоги, реклама, удержания площадки и внесённые операционные расходы учитываются по правилам TrueStats.</p></details>
   <div class="wb-eco-direct"><div class="wb-eco-subhead"><div><span class="wb-eco-kicker">ПРЯМОЙ ОТЧЁТ WB</span><h3>Продажи и возвраты площадки</h3></div><span id="wb-direct-state"></span></div><div class="wb-eco-direct-grid" id="wb-direct-grid"></div><p id="wb-direct-note"></p></div>
  </section>`);

  const panel=$('wb-economics');
  let controller=null,generation=0,lastReport=null,timer=null,retryTimer=null,intervalMinutes=30;const retryDelays=[500,1000,2000];
  const refreshing=value=>value?.status==='pending'&&value?.code==='refreshing';
  const waitRetry=(delay,signal)=>new Promise(resolve=>{let settled=false;const finish=ready=>{if(settled)return;settled=true;clearTimeout(retryTimer);retryTimer=null;signal?.removeEventListener?.('abort',cancel);resolve(ready)},cancel=()=>finish(false);retryTimer=setTimeout(()=>finish(true),delay);if(signal?.aborted)cancel();else signal?.addEventListener?.('abort',cancel,{once:true})});
  const metric=(label,value,note,tone='')=>'<article class="wb-eco-kpi '+tone+'"><span>'+label+'</span><strong>'+value+'</strong><small>'+note+'</small></article>';
  const selectedScope=()=>({market:$('market')?.value||'',store:$('store')?.value||''});
  const visibleFor=scope=>scope.market!=='Ozon'&&(!scope.store||scope.store.startsWith('wb-'));
  const sectionActive=()=>{const url=new URL(location.href),hash=location.hash.slice(1),view=document.body.dataset.pultView||url.searchParams.get('view')||'';return (hash?hash==='wb-economics':view==='wb-economics')&&!document.hidden};
  const accountMatches=(accounts,storeId)=>{
   const list=Array.isArray(accounts)?accounts:accounts?[accounts]:[];
   return list.length>0&&list.every(account=>String(account?.localStoreId||'')===String(storeId||''));
  };
  const exactScope=(data,from,to,requestedStore)=>data?.period?.from===from&&data?.period?.to===to&&(!requestedStore||String(data?.store?.id||'')===requestedStore);
  const resetValues=()=>{
   $('wb-eco-kpis').innerHTML=metric('Продажи','—','Ожидаем подтверждённый отчёт')+metric('Прибыль','—','Не заменяется выплатой WB')+metric('ROI','—','Прибыль / себестоимость')+metric('Себестоимость','—','По управленческому отчёту');
   $('wb-eco-breakdown').innerHTML=['Реализация','Реклама','Налоги','Операционные расходы','Удержания WB','Маржинальность'].map(label=>'<div><span>'+label+'</span><strong>—</strong></div>').join('');
   $('wb-direct-grid').innerHTML=metric('Продажи WB','—','По строкам прямого отчёта')+metric('Возвраты','—','По строкам прямого отчёта')+metric('Продажи за вычетом возвратов','—','Не является прибылью')+metric('Продано за вычетом возвратов','—','Единиц');
  };
  const schedule=()=>{
   clearTimeout(timer);
   if(!sectionActive())return;
   timer=setTimeout(()=>{if(sectionActive()&&lastReport&&visibleFor(selectedScope()))void load(lastReport);},Math.max(1,intervalMinutes)*60000);
  };
  const deactivate=()=>{clearTimeout(timer);clearTimeout(retryTimer);timer=null;retryTimer=null;controller?.abort();++generation};
  const setSevenDays=()=>{
   const select=$('ins-range');
   if(!select)return;
   select.value='7';
   select.dispatchEvent(new Event('change',{bubbles:true}));
  };
  $('wb-eco-seven').onclick=setSevenDays;
  $('wb-eco-range').onchange=()=>{const range=$('ins-range');range.value=$('wb-eco-range').value;range.dispatchEvent(new Event('change',{bubbles:true}))};
  document.querySelector('[data-nav="wb-economics"]')?.addEventListener('click',()=>{if(!visibleFor(selectedScope())){$('market').value='WB';$('market').dispatchEvent(new Event('change',{bubbles:true}));$('store').value='';$('store').dispatchEvent(new Event('change',{bubbles:true}))}});
  window.addEventListener('hashchange',()=>{if(!sectionActive())deactivate()});
  window.addEventListener('pult:view-change',()=>{if(!sectionActive())deactivate()});
  document.addEventListener('visibilitychange',()=>{if(!sectionActive())deactivate();else if(lastReport)void load(lastReport)});

  function paint(data,request){
   const {from,to,store:requestedStore}=request;
   const currentScope=selectedScope();
   if(!visibleFor(currentScope)||currentScope.market!==request.market||currentScope.store!==requestedStore)return;
   const periodOkay=exactScope(data,from,to,requestedStore);
   const storeId=data?.store?.id;
   const ts=data?.truestats||{};
   const tsPeriodOkay=ts?.period?.from===from&&ts?.period?.to===to;
   const tsScopeOkay=periodOkay&&tsPeriodOkay&&ts.scopeVerified===true&&accountMatches(ts.accounts,storeId);
   const ready=ts.status==='ready'&&tsScopeOkay;
   const isToday=from===today()&&to===today();
   const m=ready?(ts.metrics||{}):{};
   const storeName=data?.store?.name||'магазин Wildberries';
   $('wb-eco-scope').textContent=date(from)+' — '+date(to)+' · '+storeName;
   $('wb-eco-seven').hidden=ready||!isToday;
   $('wb-eco-status').className='wb-eco-status '+(ready?'is-ready':'is-waiting');
   $('wb-eco-status').textContent=ready?'Из TrueStats':ts.status==='pending'?'Данные формируются':!periodOkay||!tsScopeOkay?'Период не совпадает':'Нет отчёта';
   const fallback=!periodOkay||!tsScopeOkay?'Период или кабинет в ответе не совпадает с выбранным фильтром. Значения скрыты.':ts.reason||'TrueStats ещё не вернул подтверждённый отчёт за этот период.';
   $('wb-eco-message').textContent=ready?(ts.warnings||[]).filter(Boolean).join(' · ')||'Загружены продажи, прибыль и расходы из отчёта TrueStats за выбранный магазин и период.':isToday?'Сегодняшний отчёт WB ещё формируется. Нули не подставлены. Выберите последние 7 завершённых дней, чтобы увидеть экономику за полный период.':fallback;
   $('wb-eco-kpis').innerHTML=metric('Продажи',money(m.sales),ready?'TrueStats · продажи':'Нет подтверждённого значения')+metric('Прибыль',money(m.profit),ready?'После себестоимости и расходов':'Выплата WB не используется',ready&&Number.isFinite(m.profit)?(m.profit<0?'is-negative':'is-positive'):'')+metric('ROI',percent(m.roi),ready?'Прибыль / себестоимость × 100%':'Нет подтверждённого значения')+metric('Себестоимость',money(m.cogs),ready?'Себестоимость реализованного':'Нет подтверждённого значения');
   const rows=[['Реализация',m.realized],['Реклама',m.ads],['Налоги',m.tax],['Операционные расходы',m.operatingExpenses],['Удержания WB',m.marketplaceDeductions],['Маржинальность',m.margin,'percent']];
   $('wb-eco-breakdown').innerHTML=rows.map(([label,value,kind])=>'<div><span>'+label+'</span><strong>'+(ready?(kind==='percent'?percent(value):money(value)):'—')+'</strong></div>').join('');

   const direct=periodOkay?data?.direct:null;
   const complete=direct?.coverage?.complete===true;
   const known=direct?.financeAmountKnown===true;
   const hasRows=Number(direct?.coverage?.rows)>0;
   const directCurrency=typeof direct?.currency==='string'?direct.currency.toUpperCase():'';
   const showAmounts=known&&(complete||hasRows)&&/^[A-Z]{3}$/.test(directCurrency);
   const directMoney=value=>showAmounts?currencyMoney(value,directCurrency):'—';
   const qualifier=complete?'Полный период':'Частичные данные';
   $('wb-direct-state').className=complete?'is-complete':'is-partial';
   $('wb-direct-state').textContent=direct?(complete?'Полный период':'Период загружен частично'):'Нет данных';
   $('wb-direct-grid').innerHTML=metric('Продажи WB',directMoney(direct?.salesAmount),showAmounts?qualifier:'Сумма или валюта не подтверждены')+metric('Возвраты',directMoney(direct?.returnsAmount),showAmounts?qualifier:'Сумма или валюта не подтверждены')+metric('Продажи за вычетом возвратов',directMoney(direct?.netSalesAmount),showAmounts?'Продажи минус возвраты · '+qualifier.toLocaleLowerCase('ru-RU'):'Не является прибылью')+metric('Продано за вычетом возвратов',complete||hasRows?integer(direct?.netSalesUnits):'—',complete||hasRows?'Продажи минус возвраты · ед.':'Нет строк за период');
   const coverage=direct?.coverage||{};
   const observed=coverage.observed?.from&&coverage.observed?.to?' Доступные строки: '+date(coverage.observed.from)+' — '+date(coverage.observed.to)+'.':'';
   const missing=Array.isArray(coverage.missingDates)&&coverage.missingDates.length?' Не загружены даты: '+coverage.missingDates.map(date).join(', ')+'.':'';
   const limitations=Array.isArray(direct?.limitations)?direct.limitations.filter(Boolean).join(' · '):'';
   $('wb-direct-note').textContent=(complete?'Прямой отчёт WB покрывает выбранный период.':'Прямой отчёт WB пока не покрывает весь выбранный период; суммы выше являются частичными и не считаются итогом.')+observed+missing+(limitations?' '+limitations:'')+' Перечисления продавцу не являются прибылью.';
   intervalMinutes=Number(data?.refresh?.intervalMinutes)||30;
  }

  async function load(report){
   lastReport=report; $('wb-eco-range').value=$('ins-range')?.value||'custom';
   const scope=selectedScope();
   panel.hidden=!visibleFor(scope);
   if(panel.hidden){controller?.abort();clearTimeout(timer);return}
   if(!sectionActive()){deactivate();return}
   const from=report?.current?.from,to=report?.current?.to;
   if(!from||!to){resetValues();$('wb-eco-status').textContent='Нет периода';$('wb-eco-message').textContent='Выберите период управленческой сводки.';return}
   controller?.abort();const activeController=controller=new AbortController();
   const seq=++generation,request={from,to,store:scope.store,market:scope.market};
   $('wb-eco-scope').textContent=date(from)+' — '+date(to)+' · Wildberries';
   $('wb-eco-status').className='wb-eco-status is-loading';$('wb-eco-status').textContent='Загрузка';
   $('wb-eco-message').textContent='Читаем продажи WB и управленческий отчёт TrueStats отдельно от данных Ozon…';
   resetValues();
   try{
    const query=new URLSearchParams({from,to});if(scope.store)query.set('store',scope.store);
    let data;for(let attempt=0;;attempt++){const response=await fetch('/api/wb/economics?'+query,{signal:activeController.signal});data=await response.json();if(!response.ok)throw Error(data.error||'Не удалось загрузить экономику WB');if(seq!==generation||!sectionActive())return;if(!refreshing(data?.truestats)||attempt>=retryDelays.length)break;if(!await waitRetry(retryDelays[attempt],activeController.signal))return}
    paint(data,request);
   }catch(error){
    if(error.name==='AbortError'||seq!==generation)return;
    $('wb-eco-status').className='wb-eco-status is-waiting';$('wb-eco-status').textContent='Нет связи';
    $('wb-eco-message').textContent=error.message||'Не удалось загрузить экономику WB.';
   }finally{if(seq===generation)schedule()}
  }

  resetValues();
  return {render(report){void load(report)}};
 };
})();
