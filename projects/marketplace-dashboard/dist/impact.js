(function(){
 'use strict';
 const sidebar=document.querySelector('aside.sidebar');
 if(!sidebar||document.getElementById('pult-impact-card'))return;
 const card=document.createElement('section'),toggle=document.createElement('button');
 card.id='pult-impact-card';card.className='pult-impact-card';card.hidden=true;card.tabIndex=-1;card.setAttribute('aria-labelledby','pult-impact-title');
 card.innerHTML='<div class="pult-impact-cloud" aria-hidden="true"></div><div class="pult-impact-heading"><span class="pult-impact-heart" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M20.3 5.5a5 5 0 0 0-7.1 0L12 6.7l-1.2-1.2a5 5 0 0 0-7.1 7.1L12 21l8.3-8.4a5 5 0 0 0 0-7.1Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span><h3 id="pult-impact-title">Помогаем фондам</h3><button type="button" class="pult-impact-close" aria-label="Закрыть карточку помощи">×</button></div><p class="pult-impact-amount"><strong></strong><span>руб. помощи</span></p><p class="pult-impact-homes"></p><small class="pult-impact-source">По данным компании</small>';
 toggle.type='button';toggle.className='pult-impact-toggle';toggle.hidden=true;toggle.setAttribute('aria-label','Помогаем фондам — показать помощь компании');toggle.setAttribute('aria-controls',card.id);toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-haspopup','dialog');toggle.innerHTML='<span aria-hidden="true">♡</span><span class="pult-impact-toggle-label">Помогаем</span>';
 const brand=sidebar.querySelector('.brand');brand?brand.after(toggle):sidebar.prepend(toggle);
 const closeButton=card.querySelector('.pult-impact-close');let ready=false,open=false;
 const topMode=()=>document.body.classList.contains('pult-nav-top');
 function place(){if(!open)return;const box=toggle.getBoundingClientRect(),width=Math.min(264,window.innerWidth-24),left=Math.max(12,Math.min(box.left,window.innerWidth-width-12));card.style.width=width+'px';card.style.left=left+'px';card.style.top=Math.max(8,Math.min(box.bottom+10,window.innerHeight-card.offsetHeight-12))+'px';}
 function close(returnFocus=false){open=false;toggle.setAttribute('aria-expanded','false');if(topMode())card.hidden=true;if(returnFocus&&!toggle.hidden)toggle.focus();}
 function layout(){
  close();const top=topMode();card.dataset.mode=top?'top':'left';card.setAttribute('role',top?'dialog':'region');
  if(top){document.body.append(card);card.hidden=true;toggle.hidden=!ready;}
  else{const profile=sidebar.querySelector('.profile');profile?sidebar.insertBefore(card,profile):sidebar.append(card);card.style.removeProperty('left');card.style.removeProperty('top');card.style.removeProperty('width');card.hidden=!ready;toggle.hidden=true;}
 }
 toggle.addEventListener('click',()=>{if(!ready||!topMode())return;if(open){close(true);return;}open=true;card.hidden=false;toggle.setAttribute('aria-expanded','true');place();card.focus({preventScroll:true});});
 closeButton.addEventListener('click',()=>close(true));
 document.addEventListener('pointerdown',event=>{if(open&&!card.contains(event.target)&&!toggle.contains(event.target))close();});
 document.addEventListener('keydown',event=>{if(open&&event.key==='Escape'){event.preventDefault();close(true);}});
 document.addEventListener('focusin',event=>{if(open&&!card.contains(event.target)&&!toggle.contains(event.target))close();});
 window.addEventListener('pult:navigation-mode',layout);window.addEventListener('resize',place);
 layout();
 fetch('/api/impact',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)}).then(async response=>{
  if(!response.ok)return null;return response.json();
 }).then(value=>{
  if(!value||value.source!=='owner'||!Number.isFinite(value.donatedRub)||value.donatedRub<0||value.donatedRub>Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(value.childrenHomes)||value.childrenHomes<0)return;
  card.querySelector('.pult-impact-amount strong').textContent=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value.donatedRub);
  const count=value.childrenHomes,last=count%10,lastTwo=count%100,singular=last===1&&lastTwo!==11;
  card.querySelector('.pult-impact-homes').textContent='Помогли '+new Intl.NumberFormat('ru-RU').format(count)+(singular?' детскому дому':' детским домам');
  ready=true;layout();
 }).catch(()=>{ready=false;open=false;card.hidden=true;toggle.hidden=true;toggle.setAttribute('aria-expanded','false');});
})();
