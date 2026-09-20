const PULT_OVERVIEW_SECTIONS=[
 ['management-summary','Единые управленческие метрики'],
 ['net-profit-chart','Чистая прибыль'],
 ['executive','Управленческая сводка'],
 ['business-chart','Динамика бизнеса'],
 ['economics','Прибыль и экономика'],
 ['wb-economics','Wildberries: продажи и прибыль'],
 ['finance','Финансы по магазинам']
];
function pultOverviewItems(doc){return PULT_OVERVIEW_SECTIONS.filter(([id])=>doc.getElementById(id)).map(([id,label])=>({id,label,href:'#'+id}))}
if(typeof module!=='undefined'&&module.exports){module.exports={PULT_OVERVIEW_SECTIONS,pultOverviewItems}}else{(function(){
 'use strict';
 const KEY='pult-navigation-mode-v1',TREE_KEY='pult-overview-tree-open-v1',sidebar=document.querySelector('.sidebar');
 if(!sidebar)return;
 const modes=['top','left'];
 const saved=()=>{try{const value=localStorage.getItem(KEY);return modes.includes(value)?value:'top'}catch{return 'top'}};
 const controls=document.createElement('div');
 controls.className='pult-nav-mode';controls.setAttribute('role','group');controls.setAttribute('aria-label','Расположение меню');
 controls.innerHTML='<span>Меню</span><button type="button" data-nav-mode="top" aria-pressed="false" title="Показывать меню сверху">Сверху</button><button type="button" data-nav-mode="left" aria-pressed="false" title="Показывать меню слева">Слева</button>';
 const nav=sidebar.querySelector('nav'),brand=sidebar.querySelector('.brand');
 if(nav)for(const [href,label] of [['/partners.html','Партнёры'],['/charity.html','Благотворительность']]){
  if(!nav.querySelector('a[href="'+href+'"]')){const link=document.createElement('a');link.href=href;link.textContent=label;if(location.pathname===href)link.setAttribute('aria-current','page');nav.append(link);}
 }
 function setupOverviewTree(){
  const overview=nav?.querySelector('a[data-nav="overview"]'),items=pultOverviewItems(document);if(!overview||!items.length)return null;
  const branch=document.createElement('div'),toggle=document.createElement('button'),list=document.createElement('div'),listId='pult-overview-subnav';branch.className='pult-nav-branch';list.className='pult-overview-subnav';list.id=listId;list.setAttribute('role','group');list.setAttribute('aria-label','Разделы обзора бизнеса');
  toggle.type='button';toggle.className='pult-overview-toggle';toggle.setAttribute('aria-controls',listId);toggle.setAttribute('aria-label','Показать разделы обзора бизнеса');toggle.innerHTML='<span aria-hidden="true">⌄</span>';
  for(const item of items){const link=document.createElement('a');link.href=item.href;link.dataset.overviewTarget=item.id;link.textContent=item.label;list.append(link)}
  overview.before(branch);branch.append(overview,toggle,list);
  let open=false;
  function setOpen(value,{save=true,focusFirst=false}={}){open=Boolean(value);branch.classList.toggle('is-open',open);toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',(open?'Скрыть':'Показать')+' разделы обзора бизнеса');list.hidden=!open;if(save)try{localStorage.setItem(TREE_KEY,open?'1':'0')}catch{}if(focusFirst&&open)list.querySelector('a')?.focus()}
  function updateActive(){let id='';try{id=decodeURIComponent(location.hash.slice(1))}catch{id=location.hash.slice(1)}const links=[...list.querySelectorAll('[data-overview-target]')],active=links.find(link=>link.dataset.overviewTarget===id);links.forEach(link=>{const selected=link===active;link.classList.toggle('pult-sub-active',selected);if(selected)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current')});branch.classList.toggle('has-active-child',Boolean(active));if(active&&!open)setOpen(true,{save:false})}
  let remembered=false;try{remembered=localStorage.getItem(TREE_KEY)==='1'}catch{}setOpen(remembered,{save:false});updateActive();
  toggle.addEventListener('click',()=>setOpen(!open));toggle.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();setOpen(true,{focusFirst:true})}});list.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);toggle.focus()}});list.addEventListener('click',()=>setOpen(true));window.addEventListener('hashchange',updateActive);
  return {setOpen,updateActive,destroy(){window.removeEventListener('hashchange',updateActive);branch.replaceWith(overview)}};
 }
 const overviewTree=setupOverviewTree();
 if(nav)sidebar.insertBefore(controls,nav);else brand?.after(controls);
 let mode='top';
 function apply(value,{save=true}={}){
  mode=modes.includes(value)?value:'top';
  document.body.classList.toggle('pult-nav-top',mode==='top');document.body.classList.toggle('pult-nav-left',mode==='left');document.body.dataset.navigation=mode;
  controls.querySelectorAll('[data-nav-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.navMode===mode)));
  if(save)try{localStorage.setItem(KEY,mode)}catch{}
  window.dispatchEvent(new CustomEvent('pult:navigation-mode',{detail:{mode}}));
 }
 controls.addEventListener('click',event=>{const button=event.target.closest('[data-nav-mode]');if(button)apply(button.dataset.navMode)});
 const onStorage=event=>{if(event.key===KEY&&modes.includes(event.newValue))apply(event.newValue,{save:false})};window.addEventListener('storage',onStorage);
 apply(saved(),{save:false});
  window.PultNavigation={get mode(){return mode},setMode:apply,destroy(){window.removeEventListener('storage',onStorage);document.body.classList.remove('pult-nav-top','pult-nav-left');delete document.body.dataset.navigation;overviewTree?.destroy();controls.remove();delete window.PultNavigation}};
 })();
}
