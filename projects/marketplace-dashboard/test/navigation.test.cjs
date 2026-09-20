const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),navigation=require('../dist/navigation.js');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('overview tree targets only existing real dashboard sections',()=>{
 const existing=new Set(['management-summary','net-profit-chart','executive','business-chart','economics','wb-economics','finance']);
 const items=navigation.pultOverviewItems({getElementById:id=>existing.has(id)?{id}:null});
 assert.deepEqual(items.map(item=>item.href),['#management-summary','#net-profit-chart','#executive','#business-chart','#economics','#wb-economics','#finance']);
 assert.match(items[0].label,/управленческие метрики/i);assert.match(items[1].label,/Чистая прибыль/);
 const sources=read('dist/index.html')+read('dist/insights-ui.js')+read('dist/net-profit-ui.js')+read('dist/economics-ui.js')+read('dist/wb-economics-ui.js')+read('dist/turnover-chart.js');
 const present=items.filter(({id})=>sources.includes(id)).map(({id})=>id),actual=navigation.pultOverviewItems({getElementById:id=>present.includes(id)?{id}:null});
 assert.deepEqual(actual.map(item=>item.id),present);
});

test('overview tree safely stays absent when its sections are unavailable',()=>{
 assert.deepEqual(navigation.pultOverviewItems({getElementById:()=>null}),[]);
});

test('tree supports persisted expansion, keyboard controls, active children and both menu modes',()=>{
 const js=read('dist/navigation.js'),css=read('dist/navigation.css');
 assert.match(js,/pult-overview-tree-open-v1/);assert.match(js,/aria-expanded/);assert.match(js,/ArrowDown/);assert.match(js,/Escape/);assert.match(js,/aria-current/);assert.match(js,/hashchange/);
 assert.match(css,/pult-nav-left|pult-nav-branch/);assert.match(css,/body\.pult-nav-top/);assert.match(css,/pult-sub-active/);assert.match(css,/@media\(max-width:850px\)/);
});
