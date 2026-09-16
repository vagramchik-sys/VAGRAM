'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element {
 constructor(){this.children=[];this.listeners={};this.value='';this.disabled=false;this.hidden=false;this.textContent='';this.style={};this.classList={toggle(){},add(){},remove(){}};this.scrollHeight=0;this.scrollTop=0;this.clientHeight=0;}
 append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}setAttribute(){}focus(){}addEventListener(type,fn){this.listeners[type]=fn;}
}
const ids=['director-form','director-grid','director-dialog','director-name','director-role','director-description','director-messages','director-project','director-connection','directors-status','directors-refresh','directors-logout','director-send','director-close'];
const els=Object.fromEntries(ids.map(id=>[id,new Element()]));const input=new Element();els['director-form'].elements={namedItem:()=>input};
let requests=[],timers=[];
const context={document:{getElementById:id=>els[id],createElement:()=>new Element()},fetch:(path,options)=>new Promise(resolve=>requests.push({path,options,resolve})),setTimeout:fn=>{timers.push(fn);return fn;},clearTimeout:fn=>{timers=timers.filter(t=>t!==fn);},location:{},confirm:()=>true,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},console};context.window={addEventListener(){}};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../directors.js'),'utf8'),context);
const flush=async()=>{for(let n=0;n<6;n++)await Promise.resolve();};
function reply(index,data,status=200){requests[index].resolve({ok:status<400,status,json:async()=>data});}
function director(id){return{id,label:id,title:'Роль',description:'Описание',initials:'ИИ',color:'evil;display:none',tags:['<script>']};}
(async()=>{
 reply(0,{directors:[director('a'),director('b')],projects:[],user:{role:'editor'},connection:{available:true,message:'Ready'}});await flush();
 assert.equal(els['director-grid'].children.length,2);assert.equal(els['director-grid'].children[0].children[0].children[0].className,'director-avatar palette-blue');
 els['director-grid'].children[0].children[3].listeners.click();assert.equal(requests[1].path,'/api/directors/a');
 input.value='Черновик А';input.listeners.input();
 els['director-grid'].children[1].children[3].listeners.click();reply(2,{messages:[{role:'assistant',text:'B',id:'b1'}],busy:false});await flush();
 reply(1,{messages:[{role:'assistant',text:'OLD A',id:'a1'}],busy:true});await flush();
 assert.equal(els['director-messages'].children.at(-1).textContent,'Ответ директора готов.');
 assert.equal(els['director-name'].textContent,'b');assert.equal(timers.length,0);assert.equal(els['director-messages'].children[0].children[1].textContent,'B');
 els['director-grid'].children[0].children[3].listeners.click();assert.equal(input.value,'Черновик А');reply(3,{messages:[],busy:true});await flush();assert.equal(timers.length,1);assert.equal(els['director-send'].disabled,true);
 els['director-close'].listeners.click();assert.equal(timers.length,0);
 els['director-grid'].children[0].children[3].listeners.click();reply(4,{messages:[],busy:false});await flush();assert.equal(els['director-send'].disabled,false);
 const submit=els['director-form'].listeners.submit({preventDefault(){}});reply(5,{error:'Temporary'},503);await flush();reply(6,{messages:[],busy:false});await submit;assert.equal(input.value,'Черновик А');
 const firstId=JSON.parse(requests[5].options.body).requestId;
 const retry=els['director-form'].listeners.submit({preventDefault(){}});assert.equal(JSON.parse(requests[7].options.body).requestId,firstId);reply(7,{busy:true},202);await flush();reply(8,{messages:[{role:'user',text:'Черновик А'}],busy:true});await retry;assert.equal(input.value,'');assert.equal(timers.length,1);
 const refresh=els['directors-refresh'].listeners.click();reply(9,{directors:[director('a'),director('b')],projects:[],user:{role:'viewer'},connection:{available:true,message:'Ready'}});await flush();reply(10,{messages:[],busy:false});await refresh;input.value='Viewer';input.listeners.input();assert.equal(els['director-send'].disabled,true);
 const before=requests.length;await els['director-form'].listeners.submit({preventDefault(){}});assert.equal(requests.length,before);
 els['director-grid'].children[1].children[3].listeners.click();reply(requests.length-1,{messages:[{role:'system',text:'Не удалось получить ответ. Код: AI_TIMEOUT.'}],busy:false});await flush();
 assert.match(els['director-messages'].children.at(-1).textContent,/Ответ не получен/);
 els['director-grid'].children[0].children[3].listeners.click();reply(requests.length-1,{messages:[{role:'system',text:'Old failure'},{role:'user',text:'Retry'}],busy:true});await flush();
 assert.equal(els['director-messages'].children.at(-1).textContent,'Директор готовит ответ…');
 const restoreRefresh=els['directors-refresh'].listeners.click();reply(requests.length-1,{directors:[director('a'),director('b')],projects:[],user:{role:'editor'},connection:{available:true,message:'Ready'}});await flush();
 reply(requests.length-1,{messages:[{role:'user',text:'Восстановить меня',projectId:'removed-project'},{role:'system',text:'Ошибка ИИ'}],busy:false});await restoreRefresh;
 const restore=els['director-messages'].children.at(-1);assert.equal(restore.textContent,'Вернуть текст обращения');
 input.value='Важный черновик';input.listeners.input();context.confirm=()=>false;const requestCount=requests.length;
 restore.listeners.click();assert.equal(input.value,'Важный черновик');
 context.confirm=()=>true;restore.listeners.click();assert.equal(input.value,'Восстановить меня');assert.equal(els['director-project'].value,'removed-project');assert.equal(requests.length,requestCount);
 assert.ok(els['director-project'].children.some(option=>option.textContent==='Проект больше недоступен'));
 els['director-project'].value='';els['director-project'].listeners.change();
 const immediateFailure=els['director-form'].listeners.submit({preventDefault(){}});
 reply(requests.length-1,{busy:false},202);await flush();
 reply(requests.length-1,{messages:[{role:'user',text:'Восстановить меня'},{role:'system',text:'Быстрый сбой ИИ'}],busy:false});await immediateFailure;
 const immediateRestore=els['director-messages'].children.at(-1);
 assert.equal(immediateRestore.textContent,'Вернуть текст обращения');
 assert.equal(immediateRestore.disabled,false,'Restore must unlock after POST completes');
 input.value='Черновик при разрыве связи';input.listeners.input();
 els['director-grid'].children[0].children[3].listeners.click();reply(requests.length-1,{error:'Connection interrupted'},503);await flush();
 assert.equal(els['director-send'].disabled,true);
 const beforeBlocked=requests.length;await els['director-form'].listeners.submit({preventDefault(){}});assert.equal(requests.length,beforeBlocked);
 const reloadHistory=els['director-messages'].children.at(-1);assert.equal(reloadHistory.textContent,'Повторить загрузку истории');
 reloadHistory.listeners.click();assert.equal(requests.at(-1).path,'/api/directors/a');
 reply(requests.length-1,{messages:[{role:'assistant',text:'Ответ после восстановления связи'}],busy:false});await flush();
 assert.equal(input.value,'Черновик при разрыве связи');assert.equal(els['director-send'].disabled,false);
 console.log('Director UI tests passed: stale responses, draft switching, busy polling, idempotent retry, viewer guard, safe palette/text.');
})().catch(e=>{console.error(e);process.exitCode=1;});

