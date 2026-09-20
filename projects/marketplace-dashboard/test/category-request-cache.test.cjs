const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../dist/turnover-chart.js'),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function runtime(load){
 const nodes=new Map();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:id==='ins-chart-metric'?'orderedRevenue':'',checked:false,hidden:false,innerHTML:'',textContent:'',insertAdjacentHTML(){},setAttribute(){},removeAttribute(){},querySelectorAll(){return []},closest(){return this}});return nodes.get(id)};
 let calls=0;
 class Clock extends Date {constructor(...args){super(...(args.length?args:['2026-09-20T12:00:00Z']))}static now(){return Date.parse('2026-09-20T12:00:00Z')}}
 const context={document:{getElementById:node},window:{},Intl,Date:Clock,URLSearchParams,Promise,Map,Set,console};
 vm.runInNewContext(source,context);
 const chart=context.window.createPultStoreChart({api:url=>url==='/api/stores'?Promise.resolve([]):(calls++,load(url)),metricTitle:()=> 'Сумма'});
 node('chart-mode').onclick({target:{closest:()=>({dataset:{mode:'categories'}})}});
 return {chart,node,calls:()=>calls,update:date=>chart.update({days:1,current:{from:date,to:date}})};
}
const empty={categories:['Перчатки','Крепёж'],series:[],limitations:[]};
test('checkboxes and metric changes reuse the loaded report; data refresh invalidates it',async()=>{
 const app=runtime(()=>Promise.resolve(empty));
 app.update('2026-09-20');await flush();assert.equal(app.calls(),1);
 app.node('chart-category-options').onchange({target:{type:'checkbox',value:'Перчатки',checked:true}});await flush();
 app.node('ins-chart-metric').value='orderedUnits';await app.chart.render();
 app.node('chart-category-options').onchange({target:{type:'checkbox',value:'Крепёж',checked:true}});await flush();
 assert.equal(app.calls(),1);
 app.update('2026-09-20');await flush();assert.equal(app.calls(),2);
 assert.match(app.node('chart-category-options').innerHTML,/value="Перчатки" checked/);
 app.update('2026-09-19');await flush();assert.equal(app.calls(),2);
});
test('concurrent renders share a request and a failed request can be retried',async()=>{
 let resolve,reject;
 const app=runtime(()=>new Promise((yes,no)=>{resolve=yes;reject=no}));
 app.update('2026-09-20');await flush();
 const second=app.chart.render(),third=app.chart.render();await flush();assert.equal(app.calls(),1);
 reject(Error('offline'));await Promise.all([second,third]);
 assert.match(app.node('chart-store-status').textContent,/Не удалось/);
 const retry=app.chart.render();await flush();assert.equal(app.calls(),2);
 resolve(empty);await retry;
 assert.match(app.node('chart-store-status').textContent,/Выберите хотя бы одну/);
});
test('old responses cannot replace a refreshed report',async()=>{
 const pending=[];
 const app=runtime(()=>new Promise(resolve=>pending.push(resolve)));
 app.update('2026-09-20');await flush();
 app.update('2026-09-20');await flush();
 pending[1]({categories:['Новая категория'],series:[],limitations:[]});await flush();
 pending[0]({categories:['Старая категория'],series:[],limitations:[]});await flush();
 assert.match(app.node('chart-category-options').innerHTML,/Новая категория/);
 assert.doesNotMatch(app.node('chart-category-options').innerHTML,/Старая категория/);
});

