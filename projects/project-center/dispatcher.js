(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const form = $('dispatch-form'); if (!form) return;
  const labels = {planning:'Распределяет задачи',planned:'План готов к запуску',running:'Директора работают',completed:'Ответы собраны',failed:'Требует внимания',queued:'Ожидает очереди',done:'Ответ готов'};
  let runs = [], directors = [], user = null, timer = null, loading = false, sending = false, pending = null;
  let epoch=0, refreshAgain=false, providerAvailable=false;
  const starting = new Set();
  const uuid = () => globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=Math.random()*16|0;return(c==='x'?n:(n&3)|8).toString(16);});
  const node = (tag,text,cls) => {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  function status(text,error=false){$('dispatch-status').textContent=text;$('dispatch-status').classList.toggle('error',error);}
  async function api(path,method='GET',body){const r=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(r.status===401){location.href='/login.html';throw Error('Войдите снова.');}const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(Error(data.error||'Не удалось выполнить запрос.'),{status:r.status});return data;}
  const active = () => runs.some(r=>['planning','running'].includes(r.status));
  function controls(){const disabled=!user||user.role==='viewer'||!providerAvailable||sending||starting.size>0||active();$('dispatch-create').disabled=disabled;$('dispatch-goal').disabled=sending;$('dispatch-project').disabled=sending;}
  function acceptRun(run){if(!run)return;epoch++;runs=[run,...runs.filter(item=>item.id!==run.id)];render();schedule();}
  function render(){
    const container=$('dispatch-runs');
    const openDetails=new Set([...container.querySelectorAll('details[open]')].map(x=>x.dataset.task));
    container.replaceChildren();
    if(!runs.length)container.append(node('p','Задайте общую цель — генеральный директор подготовит план и выберет исполнителей.','dispatch-empty'));
    for(const run of [...runs].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))){
      const card=node('article',undefined,'dispatch-run');
      const top=node('div',undefined,'dispatch-header');top.append(node('h3',run.goal),node('span',labels[run.status]||run.status,'dispatch-badge '+run.status));card.append(top);
      const date=new Date(run.createdAt);if(Number.isFinite(date.getTime()))card.append(node('p',date.toLocaleString('ru-RU'),'dispatch-date'));
      if(run.error)card.append(node('p',run.error,'error'));
      if(run.status==='planning')card.append(node('p','Генеральный директор разбирает цель и назначает ответственных.','dispatch-progress'));
      for(const task of run.tasks||[]){
        const item=node('section',undefined,'dispatch-task');
        const title=node('div',undefined,'dispatch-header');title.append(node('strong',task.title),node('span',labels[task.status]||task.status,'dispatch-badge '+task.status));item.append(title);
        const director=directors.find(d=>d.id===task.directorId);item.append(node('p',director?.title||task.directorId,'dispatch-owner'),node('p',task.instruction,'dispatch-instruction'));
        if(task.result){const details=node('details',undefined,'dispatch-results');details.dataset.task=task.id;details.open=openDetails.has(task.id);details.append(node('summary','Прочитать результат'),node('div',task.result));item.append(details);}
        if(task.error)item.append(node('p',task.error,'error'));
        card.append(item);
      }
      if(run.status==='planned'){
        const actions=node('div',undefined,'dispatch-actions');const start=node('button',starting.has(run.id)?'Запуск…':'Назначить и запустить директоров');start.type='button';start.disabled=!user||user.role==='viewer'||!providerAvailable||starting.size>0||active();
        start.onclick=async()=>{if(starting.size||active()||!providerAvailable)return;starting.add(run.id);epoch++;render();try{const data=await api('/api/dispatch/'+encodeURIComponent(run.id)+'/start','POST',{});acceptRun(data.run);status('Поручения назначены. Директора готовят результаты.');await refresh();}catch(e){status(e.message,true);await refresh().catch(()=>{});}finally{starting.delete(run.id);render();}};
        actions.append(start,node('small','Запуск использует лимит Codex. Результат — ответы и материалы директоров.'));card.append(actions);
      }
      if(run.status==='completed')card.append(node('p','Все поручения обработаны. Раскройте результаты под задачами.','dispatch-complete'));
      container.append(card);
    }controls();
  }
  function schedule(){clearTimeout(timer);timer=null;if(active())timer=setTimeout(()=>refresh().catch(e=>{status(e.message,true);schedule();}),2500);}
  async function refresh(){if(loading){refreshAgain=true;return;}loading=true;const requestEpoch=epoch;try{const data=await api('/api/dispatch');if(requestEpoch===epoch){runs=data.runs;render();}else refreshAgain=true;}finally{loading=false;if(refreshAgain){refreshAgain=false;clearTimeout(timer);timer=setTimeout(()=>refresh().catch(e=>{status(e.message,true);schedule();}),0);}else schedule();}}
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(sending||starting.size||!providerAvailable||!user||user.role==='viewer'||active())return;
    const goal=$('dispatch-goal').value.trim(),projectId=$('dispatch-project').value;if(!goal){status('Опишите общую цель.',true);return;}
    const fingerprint=JSON.stringify([goal,projectId]);if(!pending||pending.fingerprint!==fingerprint)pending={fingerprint,requestId:uuid()};
    sending=true;epoch++;controls();
    try{const data=await api('/api/dispatch','POST',{goal,projectId,requestId:pending.requestId});acceptRun(data.run);pending=null;form.reset();status('Цель передана генеральному директору. План появится здесь.');await refresh();}
    catch(error){status(error.message,true);if(error.status&&error.status<500)pending=null;}
    finally{sending=false;controls();}
  });
  async function init(){controls();try{const data=await api('/api/directors');directors=data.directors;user=data.user;providerAvailable=data.connection.available;const select=$('dispatch-project');for(const project of data.projects){const option=node('option',project.name);option.value=project.id;select.append(option);}await refresh();if(!data.connection.available)status(data.connection.message,true);if(user.role==='viewer')status('Наблюдатель может просматривать свои поручения, но не запускать их.');}catch(e){status(e.message,true);}}
  $('directors-refresh')?.addEventListener('click',()=>refresh().catch(e=>status(e.message,true)));
  init();
})();
