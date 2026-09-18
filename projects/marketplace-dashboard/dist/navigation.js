(function(){
 'use strict';
 const KEY='pult-navigation-mode-v1',sidebar=document.querySelector('.sidebar');
 if(!sidebar)return;
 const modes=['top','left'];
 const saved=()=>{try{const value=localStorage.getItem(KEY);return modes.includes(value)?value:'top'}catch{return 'top'}};
 const controls=document.createElement('div');
 controls.className='pult-nav-mode';controls.setAttribute('role','group');controls.setAttribute('aria-label','Расположение меню');
 controls.innerHTML='<span>Меню</span><button type="button" data-nav-mode="top" aria-pressed="false" title="Показывать меню сверху">Сверху</button><button type="button" data-nav-mode="left" aria-pressed="false" title="Показывать меню слева">Слева</button>';
 const nav=sidebar.querySelector('nav'),brand=sidebar.querySelector('.brand');
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
 window.PultNavigation={get mode(){return mode},setMode:apply,destroy(){window.removeEventListener('storage',onStorage);document.body.classList.remove('pult-nav-top','pult-nav-left');delete document.body.dataset.navigation;controls.remove();delete window.PultNavigation}};
})();
