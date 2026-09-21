const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),navigation=require('../dist/navigation.js');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('overview tree targets only existing real dashboard sections',()=>{
 const existing=new Set(['management-summary','executive','business-chart','economics','wb-economics','finance']);
 const items=navigation.pultOverviewItems({getElementById:id=>existing.has(id)?{id}:null});
 assert.deepEqual(items.map(item=>item.href),['#management-summary','#executive','#business-chart','#economics','#wb-economics','#finance']);
 assert.match(items[0].label,/управленческие метрики/i);assert.match(items[2].label,/Динамика бизнеса/);
 const sources=read('dist/index.html')+read('dist/insights-ui.js')+read('dist/net-profit-ui.js')+read('dist/economics-ui.js')+read('dist/wb-economics-ui.js')+read('dist/turnover-chart.js');
 for(const {id} of items)assert.match(sources,new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('overview tree safely stays absent when its sections are unavailable',()=>{
 assert.deepEqual(navigation.pultOverviewItems({getElementById:()=>null}),[]);
});

test('saved order keeps known ids, drops stale ids and appends newly added sections',()=>{
 assert.deepEqual(navigation.reconcileOrder(['analytics','missing','overview','analytics'],['overview','priorities','analytics','finance']),['analytics','overview','priorities','finance']);
 assert.deepEqual(navigation.reconcileOrder(null,['overview','priorities']),['overview','priorities']);
});

test('moving items is bounded and operates on one supplied level only',()=>{
 const main=['overview','priorities','analytics'],children=['management-summary','business-chart'];
 assert.deepEqual(navigation.moveOrder(main,'analytics','up'),['overview','analytics','priorities']);
 assert.deepEqual(navigation.moveOrder(main,'overview','up'),main);
 assert.deepEqual(navigation.moveOrder(children,'business-chart','up'),['business-chart','management-summary']);
 assert.deepEqual(main,['overview','priorities','analytics']);
});

test('static pages keep the full saved menu when reordering only visible sections',()=>{
 const saved=['/ideas.html','overview','finance','/manage.html','stores'];
 assert.deepEqual(navigation.mergeVisibleOrder(saved,['/manage.html','/#overview']),['/ideas.html','/manage.html','finance','overview','stores']);
 assert.deepEqual(navigation.reconcileOrder(saved,['overview','/manage.html']),['overview','/manage.html']);
 assert.deepEqual(saved,['/ideas.html','overview','finance','/manage.html','stores']);
 assert.equal(navigation.canonicalNavId('/#finance'),'finance');
});

test('tree supports persisted expansion, keyboard controls, active children and both menu modes',()=>{
 const js=read('dist/navigation.js'),css=read('dist/navigation.css');
 assert.match(js,/pult-overview-tree-open-v1/);assert.match(js,/aria-expanded/);assert.match(js,/ArrowDown/);assert.match(js,/Escape/);assert.match(js,/aria-current/);assert.match(js,/hashchange/);
 assert.match(js,/pult-navigation-main-order-v1/);assert.match(js,/pult-navigation-overview-order-v1/);assert.match(js,/dragstart/);assert.match(js,/data-reset-order/);assert.match(js,/removeItem\(PULT_NAV_ORDER_KEY\)/);
 assert.match(css,/pult-nav-left|pult-nav-branch/);assert.match(css,/body\.pult-nav-top/);assert.match(css,/pult-sub-active/);assert.match(css,/@media\(max-width:850px\)/);
 assert.match(css,/pult-nav-sort-row/);assert.match(css,/pult-nav-customize-button/);
});
