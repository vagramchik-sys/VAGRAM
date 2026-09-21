'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=file=>fs.readFileSync(path.join(__dirname,'..','dist',file),'utf8');
const source=read('stock-history.js'),html=read('stock-history.html'),css=read('stock-history.css');
const ids=[...html.matchAll(/id="([^"]+)"/g)].map(match=>match[1]);
class Element{
 constructor(id){this.id=id;this.value='';this.textContent='';this.innerHTML='';this.className='';this.disabled=false;this.hidden=false;this.min='';this.max='';this.listeners={}}
 addEventListener(type,listener){this.listeners[type]=listener}
 click(){return this.listeners.click?.({preventDefault(){}})}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function response(value,{ok=true,status=200,type='json'}={}){return {ok,status,json:async()=>type==='json'?value:Promise.reject(Error('not json')),blob:async()=>value}}
function harness(fetchImpl,search=''){
 const nodes=Object.fromEntries(ids.map(id=>[id,new Element(id)]));
 const document={getElementById:id=>nodes[id]||(nodes[id]=new Element(id)),createElement:()=>({click(){this.clicked=true}})};
 const history={urls:[],replaceState(_a,_b,url){this.urls.push(url)}};
 const context={window:null,document,fetch:fetchImpl,location:{search,pathname:'/stock-history.html'},history,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},URLSearchParams,Intl,Date,Error,Number,String,globalThis:null,setTimeout:fn=>fn()};context.window=context;context.globalThis=context;
 vm.runInNewContext(source,context,{filename:'stock-history.js'});return {nodes,context,history};
}
const status={importedAt:'2026-09-21T10:00:00Z',from:'2026-08-01',to:'2026-09-20',records:1234,products:42,stores:[{id:'ozon-1',name:'Магазин <Один>'}],sources:[{id:'daily-total',label:'Суточный итог',records:1234,from:'2026-08-01',to:'2026-09-20'}],limitations:['Старые снимки могут быть неполными.']};
const report={rows:[{day:'2026-09-20',observedAt:'2026-09-20T22:10:00Z',source:'daily-total',sourceLabel:'Суточный <итог>',storeId:'ozon-1',storeName:'Магазин <Один>',sku:'123',article:'A&B',name:'Болт <M8>',warehouse:null,cluster:null,totalStock:0,available:null,inTransit:2,reserved:0,quality:'ok'}],total:1,limit:100,offset:0,source:'daily-total',from:'2026-08-01',to:'2026-09-20',limitations:[]};

test('страница честно описывает снимки, одиночный источник и отсутствие агрегации',()=>{
 assert.match(html,/Это не текущий остаток товара/);assert.match(html,/значения разных источников и строк не суммируются/);assert.match(html,/Количество строк, не сумма остатков/);
 for(const id of ['daily-total','daily-warehouse','audit-total','audit-warehouse','cabinet-total','cabinet-warehouse','seller-warehouse','cluster-warehouse'])assert.match(html,new RegExp('value="'+id+'"'));
 assert.match(html,/Дневные снимки — товары/);assert.match(html,/Внутридневная история — склады/);assert.match(html,/Дата дневной записи \/ наблюдение \(МСК\)/);assert.match(source,/timeZone:'Europe\/Moscow'/);
 assert.match(css,/@media\(max-width:700px\)/);assert.match(html,/id="stock-export"/);
});

test('ссылка из карточки товара передаёт магазин и SKU только для Ozon с SKU',()=>{
 const dashboard=read('dashboard.js');assert.match(dashboard,/p\.market==='Ozon'&&p\.sku/);assert.match(dashboard,/stock-history\.html\?store=/);assert.match(dashboard,/&sku=/);
});

test('рендер сохраняет настоящий ноль, неизвестное показывает тире и экранирует API',async()=>{
 const calls=[],app=harness(async url=>{calls.push(url);return response(url.includes('/status')?status:report)},'?store=ozon-1&sku=123');await tick();await tick();
 assert.match(calls[1],/source=daily-total/);assert.match(calls[1],/store=ozon-1/);assert.match(calls[1],/sku=123/);assert.match(calls[1],/limit=100&offset=0/);
 const rows=app.nodes['stock-rows'].innerHTML;assert.match(rows,/Болт &lt;M8&gt;/);assert.match(rows,/A&amp;B/);assert.match(rows,/Дневная запись:/);assert.match(rows,/Наблюдение: [^<]+ МСК/);assert.match(rows,/<td class="numeric">0<\/td><td class="numeric">—<\/td><td class="numeric">2<\/td><td class="numeric">0<\/td>/);assert.doesNotMatch(rows,/Магазин <Один>/);
 assert.equal(app.nodes['stock-from'].min,'2026-08-01');assert.equal(app.nodes['stock-to'].max,'2026-09-20');assert.match(app.nodes['stock-records'].textContent,/1[\s\u00a0]?234/);
});

test('устаревший ответ отчёта не перезаписывает новый',async()=>{
 const pending=[];const app=harness(async url=>url.includes('/status')?response(status):new Promise(resolve=>pending.push(resolve)));await tick();
 app.nodes['stock-query'].value='новый';app.nodes['stock-filters'].listeners.submit({preventDefault(){}});await tick();
 pending[1](response({...report,rows:[{...report.rows[0],name:'Новый ответ'}]}));await tick();pending[0](response({...report,rows:[{...report.rows[0],name:'Старый ответ'}]}));await tick();
 assert.match(app.nodes['stock-rows'].innerHTML,/Новый ответ/);assert.doesNotMatch(app.nodes['stock-rows'].innerHTML,/Старый ответ/);
});

test('404 сообщает об обновлении сервера и не превращается в пустой нулевой отчёт',async()=>{
 const app=harness(async()=>response({error:'not found'},{ok:false,status:404}));await tick();await tick();assert.match(app.nodes['stock-notice'].textContent,/ожидает обновления сервера/);assert.match(app.nodes['stock-rows'].innerHTML,/ожидает обновления сервера/);assert.doesNotMatch(app.nodes['stock-rows'].innerHTML,/нулевой остаток/i);
});

test('CSV использует те же фильтры и обрабатывает ошибку',async()=>{
 const calls=[];const app=harness(async url=>{calls.push(url);if(url.includes('/status'))return response(status);if(url.includes('/report'))return response(report);return response('fail',{ok:false,status:500,type:'text'})},'?sku=123');await tick();await tick();await app.nodes['stock-export'].click();
 const url=calls.find(item=>item.includes('/export'));assert.match(url,/source=daily-total/);assert.match(url,/sku=123/);assert.doesNotMatch(url,/offset=/);assert.match(app.nodes['stock-notice'].textContent,/Не удалось подготовить CSV/);
});
