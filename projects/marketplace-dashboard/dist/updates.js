(function(){
 'use strict';
 const STORE_KEY='pult-updates-open-v1',POLL_MS=60000;
 const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const date=value=>{if(!value)return 'Дата не указана';const parsed=new Date(value);return Number.isFinite(parsed.getTime())?parsed.toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric'}):String(value)};
 const stamp=value=>{if(!value)return '';const parsed=new Date(value);return Number.isFinite(parsed.getTime())?parsed.toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' МСК':''};
 const root=document.createElement('div');root.className='pult-updates-root';
 root.innerHTML=`<button class="pult-updates-launch" type="button" aria-controls="pult-updates-drawer" aria-expanded="false"><span aria-hidden="true">✦</span> Что нового</button>
  <div class="pult-updates-backdrop" aria-hidden="true"></div>
  <aside class="pult-updates-drawer" id="pult-updates-drawer" aria-label="Что нового в Пульте" aria-hidden="true">
   <header class="pult-updates-head"><div><span>ЖУРНАЛ ПРОДУКТА</span><h2>Что нового</h2><p>Готовые изменения и текущая работа</p></div><button class="pult-updates-close" type="button" aria-label="Закрыть панель обновлений">×</button></header>
   <div class="pult-updates-state" role="status" aria-live="polite">Загружаем изменения…</div>
   <div class="pult-updates-list"></div>
   <footer class="pult-updates-foot"></footer>
  </aside>`;
 document.body.append(root);
 const drawer=root.querySelector('.pult-updates-drawer'),launch=root.querySelector('.pult-updates-launch'),close=root.querySelector('.pult-updates-close'),backdrop=root.querySelector('.pult-updates-backdrop'),state=root.querySelector('.pult-updates-state'),list=root.querySelector('.pult-updates-list'),foot=root.querySelector('.pult-updates-foot');
 let opened=false,lastFocus=null,busy=false,lastRequest=0,data=null,destroyed=false;
 function preference(){try{const saved=localStorage.getItem(STORE_KEY);return saved===null?true:saved==='true'}catch{return true}}
 function remember(value){try{localStorage.setItem(STORE_KEY,String(value))}catch{}}
 function setOpen(value,{focus=true,save=true}={}){
  opened=Boolean(value);root.classList.toggle('is-open',opened);document.body.classList.toggle('pult-updates-open',opened);drawer.setAttribute('aria-hidden',String(!opened));launch.setAttribute('aria-expanded',String(opened));launch.tabIndex=opened?-1:0;
  if(save)remember(opened);
  if(opened){lastFocus=document.activeElement;if(focus)close.focus({preventScroll:true})}
  else if(focus){const target=lastFocus instanceof HTMLElement&&lastFocus!==document.body&&document.contains(lastFocus)&&!root.contains(lastFocus)?lastFocus:launch;target.focus({preventScroll:true})}
 }
 function validate(value){return value&&typeof value==='object'&&Array.isArray(value.entries)&&value.entries.every(item=>item&&typeof item.id==='string'&&typeof item.title==='string'&&typeof item.details==='string'&&['ready','progress'].includes(item.status))}
 function render(){
  if(!data)return;
  const entries=[...data.entries].sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  list.innerHTML=entries.map(item=>`<article class="pult-update-card"><div class="pult-update-meta"><time datetime="${esc(item.date)}">${esc(date(item.date))}</time><span class="is-${item.status}">${item.status==='ready'?'Готово':'В работе'}</span></div><h3>${esc(item.title)}</h3><p>${esc(item.details)}</p></article>`).join('')||'<div class="pult-updates-empty">Пока нет опубликованных изменений.</div>';
  state.textContent='';state.className='pult-updates-state';foot.textContent=data.updatedAt?'Обновлено '+stamp(data.updatedAt):'';
 }
 async function refresh(force=false){
  if(destroyed||busy||document.hidden)return;
  if(!force&&Date.now()-lastRequest<POLL_MS-1000)return;
  busy=true;lastRequest=Date.now();
  if(!data){state.className='pult-updates-state';state.textContent='Загружаем изменения…'}
  try{
   const response=await fetch('/api/changes',{headers:{Accept:'application/json'},cache:'no-store'}),value=await response.json();
   if(!response.ok)throw Error(value?.error||'Не удалось загрузить изменения');
   if(!validate(value))throw Error('Сервер вернул неполный журнал изменений');
   data=value;render();
  }catch(error){
   state.className='pult-updates-state is-error';state.textContent=data?'Не удалось проверить новые записи. Ниже сохранён последний загруженный журнал.':(error?.message||'Не удалось загрузить изменения')+'. Повторим автоматически.';
  }finally{busy=false}
 }
 launch.addEventListener('click',()=>setOpen(true));close.addEventListener('click',()=>setOpen(false));backdrop.addEventListener('click',()=>setOpen(false));
 document.addEventListener('keydown',event=>{if(opened&&event.key==='Escape'){event.preventDefault();setOpen(false)}});
 const onVisibility=()=>{if(!document.hidden)void refresh()};document.addEventListener('visibilitychange',onVisibility);
 const timer=setInterval(()=>void refresh(),POLL_MS);
 setOpen(preference(),{focus:false,save:false});void refresh(true);
 window.PultUpdates={open:()=>setOpen(true),close:()=>setOpen(false),refresh:()=>refresh(true),destroy(){destroyed=true;clearInterval(timer);document.removeEventListener('visibilitychange',onVisibility);document.body.classList.remove('pult-updates-open');root.remove();delete window.PultUpdates}};
})();
