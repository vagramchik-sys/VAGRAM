(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const projectLabels = {planned:'Запланирован',active:'В работе',paused:'Приостановлен',done:'Завершён'};
  const taskLabels = {todo:'К выполнению',doing:'В работе',done:'Готово'};
  const priorities = {low:'Низкий',medium:'Средний',high:'Высокий'};
  let state = {items:[],tasks:[]}, version = null, user = null, saving = false, stale = false, loading = false;
  let selected = null, editingProject = null, editingTask = null;
  const forms = [$('project-form'), $('task-form')];
  const dirty = new Set();
  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const today = () => {const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  const overdue = task => task.status !== 'done' && task.dueDate && task.dueDate < today();
  const canWrite = () => user && user.role !== 'viewer' && !saving && !stale && !loading;
  const node = (tag,text,className) => {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
  function notice(message,error=false){$('hub-status').textContent=message;$('hub-status').classList.toggle('error',error);}
  function guard(fn){return async(...args)=>{try{await fn(...args);}catch(e){notice(e.message,true);}};}
  function button(text,fn,className='secondary small-button',write=false){const b=node('button',text,className);b.type='button';b.disabled=write&&!canWrite();b.onclick=guard(fn);return b;}
  async function api(path,method='GET',body){const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(r.status===401){location.href='/login.html';throw Error('Войдите снова.');}const data=await r.json();if(!r.ok){const e=Error(data.error||'Ошибка сервера');e.status=r.status;throw e;}return data;}
  async function load(){if(loading||saving)return;loading=true;render();try{const data=await api('/api/projects');state=data.state;version=data.version;user=data.user;stale=false;if(selected&&!state.items.some(p=>p.id===selected))selected=null;}finally{loading=false;render();}}
  async function commit(next,message){
    if(!canWrite())throw Error(stale?'Обновите данные перед продолжением.':'Изменения недоступны.');
    saving=true;render();
    try{const data=await api('/api/projects','PUT',{state:next,version});state=next;version=data.version;notice(message);}
    catch(e){stale=true;if(e.status===409)throw Error('Другой сотрудник изменил проекты. Ваш ввод остался в форме. Обновите данные и повторите действие.');throw e;}
    finally{saving=false;render();}
  }
  function formData(form){return Object.fromEntries(new FormData(form));}
  function badge(text,status){return node('span',text,'badge '+status);}
  function resetProject(){editingProject=null;$('project-submit').textContent='Создать проект';$('project-cancel').hidden=false;$('project-form-title').textContent='Новый проект';}
  function resetTask(){editingTask=null;$('task-submit').textContent='Добавить задачу';$('task-cancel').hidden=false;$('task-form-title').textContent='Новая задача';}
  forms.forEach(form=>{form.addEventListener('input',()=>dirty.add(form.id));form.addEventListener('change',()=>dirty.add(form.id));form.addEventListener('reset',()=>{dirty.delete(form.id);if(form.id==='project-form')resetProject();else resetTask();});});
  function discardTask(){if(dirty.has('task-form')&&!confirm('Сбросить несохранённую задачу?'))return false;$('task-form').reset();return true;}
  function openProject(id){if(selected!==id&&!discardTask())return;selected=id;render();$('task-section').scrollIntoView({behavior:'smooth',block:'start'});}
  function editProject(project){if(dirty.has('project-form')&&!confirm('Заменить несохранённый ввод проекта?'))return;editingProject=project.id;dirty.add('project-form');for(const key of ['name','description','status','owner','dueDate'])$('project-form').elements.namedItem(key).value=project[key];$('project-submit').textContent='Сохранить проект';$('project-cancel').hidden=false;$('project-form').scrollIntoView({behavior:'smooth',block:'center'});}
  function editTask(task){if(dirty.has('task-form')&&!confirm('Заменить несохранённый ввод задачи?'))return;editingTask=task.id;dirty.add('task-form');for(const key of ['title','owner','status','priority','dueDate'])$('task-form').elements.namedItem(key).value=task[key];$('task-submit').textContent='Сохранить задачу';$('task-cancel').hidden=false;$('task-form').scrollIntoView({behavior:'smooth',block:'center'});}
  function noDrafts(){if(dirty.size)throw Error('Сначала сохраните или отмените ввод в формах.');}
  function render(){
    $('hub-total').textContent=state.items.length;
    $('hub-active').textContent=state.items.filter(p=>p.status==='active').length;
    $('hub-tasks').textContent=state.tasks.filter(t=>t.status!=='done').length;
    $('hub-overdue').textContent=state.tasks.filter(overdue).length;
    const query=$('project-search').value.trim().toLocaleLowerCase('ru-RU'),filter=$('project-status-filter').value;
    const items=state.items.filter(p=>(!query||`${p.name} ${p.description} ${p.owner}`.toLocaleLowerCase('ru-RU').includes(query))&&(!filter||filter==='all'||p.status===filter));
    const list=$('project-list');list.replaceChildren();
    if(!items.length)list.append(node('div',state.items.length?'По выбранным условиям проектов нет.':'Создайте первый проект: магазин, разработку, маркетинг или другое направление.','empty-state'));
    for(const p of items){
      const card=node('article',undefined,'project-card'+(selected===p.id?' selected':''));
      const top=node('div',undefined,'card-top');top.append(node('h3',p.name),badge(projectLabels[p.status],p.status));card.append(top,node('p',p.description||'Описание пока не добавлено.'));
      const tasks=state.tasks.filter(t=>t.projectId===p.id),done=tasks.filter(t=>t.status==='done').length;
      const meta=node('div',undefined,'project-meta');meta.append(node('span','Ответственный: '+(p.owner||'не назначен')),node('span','Срок: '+(p.dueDate||'не задан')),node('span',`Задачи: ${done} из ${tasks.length} выполнено`));card.append(meta);
      const track=node('div',undefined,'progress-track'),fill=node('div',undefined,'progress-fill');fill.style.width=(tasks.length?done/tasks.length*100:0)+'%';track.append(fill);card.append(track);
      const actions=node('div',undefined,'card-actions');actions.append(button('Открыть задачи',()=>openProject(p.id)),button('Изменить',()=>editProject(p),'secondary small-button',true),button('Удалить',async()=>{noDrafts();if(!confirm(`Удалить проект «${p.name}» и его задачи (${tasks.length})?`))return;await commit({items:state.items.filter(x=>x.id!==p.id),tasks:state.tasks.filter(t=>t.projectId!==p.id)},'Проект удалён.');if(selected===p.id){selected=null;render();}},'danger small-button',true));card.append(actions);list.append(card);
    }
    const project=state.items.find(p=>p.id===selected);$('task-section').hidden=!project;$('task-board').replaceChildren();$('selected-project').replaceChildren();
    if(project){$('selected-project').append(node('h2',project.name),node('p','Задачи проекта · '+(project.owner||'ответственный не назначен')));
      for(const [status,label] of Object.entries(taskLabels)){
        const column=node('div',undefined,'task-column');const tasks=state.tasks.filter(t=>t.projectId===selected&&t.status===status);column.append(node('h3',`${label} · ${tasks.length}`));
        if(!tasks.length)column.append(node('p','Задач нет.','empty-state'));
        for(const task of tasks){const card=node('article',undefined,'task-card');card.append(node('h4',task.title),badge(priorities[task.priority],task.priority));const meta=node('div',undefined,'task-meta');meta.append(node('span','Ответственный: '+(task.owner||'не назначен')),node('span',(overdue(task)?'Просрочено: ':'Срок: ')+(task.dueDate||'не задан'),overdue(task)?'overdue':''));card.append(meta);
          const select=node('select');select.setAttribute('aria-label','Статус задачи: '+task.title);for(const [value,text]of Object.entries(taskLabels)){const option=node('option',text);option.value=value;select.append(option);}select.value=task.status;select.disabled=!canWrite();select.onchange=guard(async()=>{try{noDrafts();await commit({...state,tasks:state.tasks.map(t=>t.id===task.id?{...t,status:select.value}:t)},'Статус задачи обновлён.');}finally{render();}});card.append(select);
          const actions=node('div',undefined,'task-actions');actions.append(button('Изменить',()=>editTask(task),'secondary small-button',true),button('Удалить',async()=>{noDrafts();if(confirm('Удалить задачу «'+task.title+'»?'))await commit({...state,tasks:state.tasks.filter(t=>t.id!==task.id)},'Задача удалена.');},'danger small-button',true));card.append(actions);column.append(card);
        }$('task-board').append(column);
      }
    }
    for(const form of forms)for(const el of form.elements)el.disabled=!canWrite();
    // Reset remains available when a conflict requires refreshing the database.
    if(!saving&&!loading&&user?.role!=='viewer')for(const form of forms){const reset=form.querySelector('[type=reset]');if(reset)reset.disabled=false;}
    $('hub-refresh').disabled=saving||loading;
    $('hub-logout').disabled=saving;
  }
  $('project-form').addEventListener('submit',guard(async e=>{e.preventDefault();const form=e.currentTarget;if(dirty.has('task-form'))throw Error('Сначала сохраните или отмените ввод задачи.');const v=formData(form);const project={id:editingProject||uid(),name:v.name.trim(),description:v.description.trim(),status:v.status,owner:v.owner.trim(),dueDate:v.dueDate};if(!project.name)throw Error('Укажите название проекта.');if(editingProject&&!state.items.some(p=>p.id===editingProject))throw Error('Проект уже удалён.');const items=editingProject?state.items.map(p=>p.id===editingProject?project:p):[...state.items,project];await commit({...state,items},editingProject?'Проект обновлён.':'Проект создан.');selected=project.id;form.reset();render();}));
  $('task-form').addEventListener('submit',guard(async e=>{e.preventDefault();const form=e.currentTarget;if(!selected)throw Error('Выберите проект.');if(dirty.has('project-form'))throw Error('Сначала сохраните или отмените ввод проекта.');const v=formData(form);const task={id:editingTask||uid(),projectId:selected,title:v.title.trim(),owner:v.owner.trim(),status:v.status,priority:v.priority,dueDate:v.dueDate};if(!task.title)throw Error('Укажите название задачи.');if(editingTask&&!state.tasks.some(t=>t.id===editingTask))throw Error('Задача уже удалена.');await commit({...state,tasks:editingTask?state.tasks.map(t=>t.id===editingTask?task:t):[...state.tasks,task]},editingTask?'Задача обновлена.':'Задача добавлена.');form.reset();render();}));
  $('project-search').addEventListener('input',render);$('project-status-filter').addEventListener('change',render);
  $('hub-refresh').onclick=guard(async()=>{if(loading||saving)return;if(dirty.size&&!confirm('После успешного обновления несохранённый ввод будет сброшен. Продолжить?'))return;await load();forms.forEach(f=>f.reset());render();notice('Портфель обновлён.');});
  $('hub-logout').onclick=guard(async()=>{if(saving){notice('Дождитесь завершения сохранения перед выходом.',true);return;}if(dirty.size&&!confirm('Выйти без сохранения ввода?'))return;await api('/api/logout','POST');location.href='/login.html';});
  window.addEventListener('beforeunload',e=>{if(dirty.size||saving){e.preventDefault();e.returnValue='';}});
  render();load().catch(e=>notice(e.message,true));
})();


