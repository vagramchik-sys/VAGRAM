const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../dist/turnover-chart.js'),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(()=>setImmediate(resolve)));
function runtime(load,options={}){
 const nodes=new Map();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:id==='ins-chart-metric'?'orderedRevenue':'',checked:false,hidden:false,innerHTML:'',textContent:'',insertAdjacentHTML(){},setAttribute(){},removeAttribute(){},closest(){return this}});return nodes.get(id)};
 let calls=0;
 class Clock extends Date {constructor(...args){super(...(args.length?args:['2026-09-20T12:00:00Z']))}static now(){return Date.parse('2026-09-20T12:00:00Z')}}
 const context={document:{getElementById:node},window:{},Intl,Date:Clock,URLSearchParams,Promise,Map,Set,console};
 vm.runInNewContext(source,context);
 const chart=context.window.createPultStoreChart({api:url=>url==='/api/stores'?Promise.resolve([]):(calls++,load(url)),metricTitle:()=> 'Сумма'});
 if(options.from)node('ins-from').value=options.from;if(options.to)node('ins-to').value=options.to;
 if(options.categoryMode!==false)node('chart-mode-categories').onclick();
 return {chart,node,calls:()=>calls,update:date=>chart.update({days:1,current:{from:date,to:date}})};
}
const empty={categories:['Перчатки','Крепёж'],types:[{id:'Перчатки',parentId:null,name:'Перчатки'},{id:'Крепёж',parentId:null,name:'Крепёж'}],series:[],byStore:[],coverage:{complete:true},period:{days:1},limitations:[]};
test('checkboxes and metric changes reuse the loaded report; data refresh invalidates it',async()=>{
 const app=runtime(()=>Promise.resolve(empty));
 app.update('2026-09-19');await flush();assert.equal(app.calls(),1);
 app.node('chart-category-options').onchange({target:{type:'checkbox',value:'Перчатки',checked:true}});await flush();
 app.node('ins-chart-metric').value='orderedUnits';await app.chart.render();
 app.node('chart-category-options').onchange({target:{type:'checkbox',value:'Крепёж',checked:true}});await flush();
 assert.equal(app.calls(),1);
 app.update('2026-09-19');await flush();assert.equal(app.calls(),2);
 assert.match(app.node('chart-category-options').innerHTML,/value="Перчатки" checked/);
 app.update('2026-09-18');await flush();assert.equal(app.calls(),3);
});
test('concurrent renders share a request and a failed request can be retried',async()=>{
 let resolve,reject;
 const app=runtime(()=>new Promise((yes,no)=>{resolve=yes;reject=no}));
 app.update('2026-09-19');await flush();
 const second=app.chart.render(),third=app.chart.render();await flush();assert.equal(app.calls(),1);
 reject(Error('offline'));await Promise.all([second,third]);
 assert.match(app.node('chart-store-status').textContent,/Не удалось/);
 const retry=app.chart.render();await flush();assert.equal(app.calls(),2);
 resolve(empty);await retry;
 assert.match(app.node('chart-store-status').textContent,/Выберите категорию или товар/);
});
test('polling shares an unfinished request instead of restarting the loading state',async()=>{
 const pending=[];
 const app=runtime(()=>new Promise(resolve=>pending.push(resolve)));
 app.update('2026-09-19');await flush();
 app.update('2026-09-19');await flush();
 app.update('2026-09-19');await flush();
 assert.equal(app.calls(),1);
 pending[0](empty);await flush();
 assert.match(app.node('chart-store-status').textContent,/Выберите категорию или товар/);
 app.update('2026-09-19');await flush();assert.equal(app.calls(),2);
 pending[1](empty);await flush();
});

test('a response for the old period cannot replace the selected period',async()=>{
 const pending=[];
 const app=runtime(()=>new Promise(resolve=>pending.push(resolve)));
 app.update('2026-09-18');await flush();
 app.update('2026-09-19');await flush();
 pending[1]({categories:['Новая категория'],series:[],limitations:[]});await flush();
 pending[0]({categories:['Старая категория'],series:[],limitations:[]});await flush();
 assert.match(app.node('chart-category-options').innerHTML,/Новая категория/);
 assert.doesNotMatch(app.node('chart-category-options').innerHTML,/Старая категория/);
});

test('background refresh preserves visible categories until the replacement is ready',async()=>{
 const pending=[];
 const app=runtime(()=>new Promise(resolve=>pending.push(resolve)));
 app.update('2026-09-19');await flush();pending[0](empty);await flush();
 assert.equal(app.node('chart-category-table').hidden,false);
 app.node('ins-chart').innerHTML='<svg>last successful graph</svg>';
 app.update('2026-09-19');await flush();
 assert.equal(app.node('chart-category-table').hidden,false);
 assert.match(app.node('ins-chart').innerHTML,/last successful/);
 assert.equal(app.node('chart-store-status').textContent,'Обновляем категории…');
 pending[1](empty);await flush();
 app.update('2026-09-18');await flush();
 assert.equal(app.node('chart-category-table').hidden,true);
 pending[2](empty);await flush();
});
test('choosing a child replaces its selected parent and search keeps the matching branch',async()=>{
 const hierarchy={categories:['Сетки','Сетка от грызунов','Сетка штукатурная'],types:[{id:'mesh',parentId:null,name:'Сетки'},{id:'rodent',parentId:'mesh',name:'Сетка от грызунов'},{id:'plaster',parentId:'mesh',name:'Сетка штукатурная'}],series:[],limitations:[]};
 const app=runtime(()=>Promise.resolve(hierarchy));app.update('2026-09-19');await flush();
 app.node('chart-category-options').onchange({target:{type:'checkbox',value:'mesh',checked:true}});await flush();assert.match(app.node('chart-category-options').innerHTML,/value="mesh" checked/);
 app.node('chart-category-options').onchange({target:{type:'checkbox',value:'rodent',checked:true}});await flush();assert.doesNotMatch(app.node('chart-category-options').innerHTML,/value="mesh" checked/);assert.match(app.node('chart-category-options').innerHTML,/value="rodent" checked/);
 app.node('chart-category-search').value='грызунов';app.node('chart-category-search').oninput();assert.match(app.node('chart-category-options').innerHTML,/Сетки/);assert.match(app.node('chart-category-options').innerHTML,/Сетка от грызунов/);assert.doesNotMatch(app.node('chart-category-options').innerHTML,/Сетка штукатурная/);
});

test('four category levels expand to separate product rows without inventing taxonomy nodes',async()=>{
 const types=[{id:'a',parentId:null,name:'Category 1'},{id:'b',parentId:'a',name:'Category 2'},{id:'c',parentId:'b',name:'Category 3'},{id:'d',parentId:'c',name:'Category 4'}];
 const report={...empty,types,byProduct:[{productKey:'s1:101',typeId:'d',productId:'101',sku:'201',offerId:'offer',name:'Product <A>',storeId:'s1',storeName:'Store',points:[]}]};
 const app=runtime(()=>Promise.resolve(report));app.update('2026-09-19');await flush();
 let html=app.node('chart-category-tables').innerHTML;
 assert.match(html,/data-category-depth="4"/);assert.doesNotMatch(html,/data-product-key=/);
 app.node('chart-category-tables').onclick({target:{closest:selector=>selector==='[data-expand]'?{dataset:{expand:'type:d'},getAttribute:()=> 'false'}:null}});
 html=app.node('chart-category-tables').innerHTML;
 assert.match(html,/data-product-key="s1:101"/);assert.match(html,/Product &lt;A&gt;/);assert.match(html,/data-category="product:s1:101"/);assert.match(html,/SKU 201/);
 app.node('chart-category-level').value='1';app.node('chart-category-level').onchange();
 assert.doesNotMatch(app.node('chart-category-tables').innerHTML,/data-category-depth="2"|data-product-key=/);
 app.node('chart-category-level').value='products';app.node('chart-category-level').onchange();
 assert.match(app.node('chart-category-tables').innerHTML,/data-product-key="s1:101"/);
});

test('confirmed zero orders on the other marketplace preserve the category amount',async()=>{
 const point={date:'2026-09-19',orderedUnits:1,orderedRevenue:100,complete:true,observed:true};
 const report={...empty,types:[{id:'a',parentId:null,name:'Only Ozon'}],series:[{typeId:'a',market:'Ozon',points:[point]}],coverage:{complete:true,missingProductUnits:0,stores:[{market:'Ozon',storeId:'s1',date:'2026-09-19',complete:true,observed:true,source:'canonical-orders'},{market:'WB',storeId:'wb-2',date:'2026-09-19',complete:true,observed:true,source:'canonical-orders'}]}};
 const app=runtime(()=>Promise.resolve(report));app.update('2026-09-19');await flush();
 const html=app.node('chart-category-tables').innerHTML;
 assert.match(html,/100 ₽/);assert.doesNotMatch(html,/Неполно|Нет данных/);
 report.coverage.stores[1].complete=false;report.coverage.stores[1].observed=false;
 app.update('2026-09-19');await flush();assert.match(app.node('chart-category-tables').innerHTML,/Неполно/);
});

test('today store filter does not request an unscoped intraday category report',async()=>{
 const urls=[],app=runtime(url=>{urls.push(url);return Promise.resolve(empty)});
 app.node('store').value='s1';app.update('2026-09-20');await flush();
 assert.equal(urls.length,1);assert.match(urls[0],/order-category-daily.*store=s1/);
});

test('opening categories starts SQL daily loading before the main report is ready and reuses it',async()=>{
 const urls=[],pending=[];
 const app=runtime(url=>{urls.push(url);return new Promise(resolve=>pending.push(resolve))},{categoryMode:false,from:'2026-09-20',to:'2026-09-20'});
 app.node('chart-mode-categories').onclick();await flush();
 assert.equal(urls.length,1);assert.match(urls[0],/order-category-daily/);
 assert.equal(app.node('chart-store-status').textContent,'Загружаем категории…');
 app.update('2026-09-20');await flush();assert.equal(urls.length,1,'initial report must reuse the prefetched category request');
 pending[0](empty);await flush();
 assert.match(app.node('chart-store-status').textContent,/Выберите категорию или товар/);
});

test('today category view uses the SQL daily report for selected lines without a second snapshot request',async()=>{
 const urls=[],app=runtime(url=>{urls.push(url);return Promise.resolve(empty)});
 app.update('2026-09-20');await flush();
 assert.equal(urls.length,1);assert.match(urls[0],/order-category-daily/);assert.doesNotMatch(urls[0],/order-categories\?/);
 app.node('chart-category-options').onchange({target:{type:'checkbox',value:'Перчатки',checked:true}});await flush();
 assert.equal(urls.length,1);assert.doesNotMatch(urls[0],/order-categories\?/);
});

test('overview polling keeps the category cache while the order source revision is unchanged',async()=>{
 const urls=[],source={id:'s1',ordersAt:'2026-09-20T09:00:00Z',ordersHistoryAt:'2026-09-20T09:00:00Z'},app=runtime(url=>{urls.push(url);return Promise.resolve(empty)}),report={days:1,current:{from:'2026-09-20',to:'2026-09-20'},sources:[source]};
 app.chart.update(report);await flush();assert.equal(urls.length,1);
 app.chart.update({...report,generatedAt:'2026-09-20T09:00:30Z'});await flush();assert.equal(urls.length,1,'timer refresh must not refetch unchanged category inputs');
 app.chart.update({...report,sources:[{...source,ordersAt:'2026-09-20T09:10:00Z'}]});await flush();assert.equal(urls.length,2,'new order data must invalidate category cache');
});
