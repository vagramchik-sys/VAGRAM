const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../dist/index.html'),'utf8');
const js=fs.readFileSync(path.join(__dirname,'../dist/buyer-order-segments-ui.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../dist/buyer-order-segments.css'),'utf8');

test('corporate demand page exposes the complete analytical structure',()=>{
 for(const text of ['Корпоративный спрос','Карта корпоративного спроса','Найденные возможности','Динамика B2B','Найти точки роста','Товары','Категории'])assert.match(html,new RegExp(text));
 assert.match(js,/Сумма B2B-заказов/);
 for(const period of ['today','yesterday','1','7','14','28','90'])assert.match(html,new RegExp(`data-buyer-period="${period}"`));
 for(const zone of ['all','leaders','growth','opportunity','low'])assert.match(html,new RegExp(`data-zone="${zone}"`));
 assert.match(html,/id="b2b-drawer"/);assert.match(html,/id="b2b-compare"[^>]+checked/);
});

test('UI uses one bounded B2B endpoint and preserves unavailable semantics',()=>{
 assert.match(js,/\/api\/b2b-radar\?/);assert.doesNotMatch(js,/\/api\/buyer-(?:order|product)-segments/);
 assert.match(js,/requestSize=50/);assert.match(js,/limit:String\(requestSize\)/);assert.match(js,/b2bAmountRub/);
 assert.match(js,/slice\(0,200\)/);assert.match(js,/status\(value\)!==['"]unavailable['"]/);
 assert.match(js,/scoreStatus!=='LOW_DATA'/);assert.match(js,/Это не гарантированный прогноз/);
 assert.doesNotMatch(js,/mock|fixture|Math\.random/i);
});

test('table is sortable and paginated and product rows open a drawer',()=>{
 assert.match(js,/const pageSize=15/);assert.match(js,/data-sort=/);assert.match(js,/sort\.direction==='asc'/);
 assert.match(js,/b2b-prev/);assert.match(js,/b2b-next/);assert.match(js,/function openDrawer/);assert.match(js,/data-product=/);
 assert.match(js,/offset:String\(loaded\)/);assert.match(js,/products:\[\.\.\.model\.products,\.\.\.additional\]/);assert.match(js,/загружено/);
 assert.match(js,/meta\?\.analyzed/);assert.match(js,/loaded>=analyzed/);assert.match(js,/Показаны первые.*уточните период или магазин/);
});

test('loading, error, retry, empty and partial states are explicit',()=>{
 for(const value of ['loading','error','empty','partial'])assert.match(js,new RegExp(value));
 assert.match(js,/data-b2b-retry/);assert.match(js,/Недостаточно данных/);assert.match(js,/Частичные данные/);
 assert.match(css,/b2b-skeleton-grid/);assert.match(css,/is-partial/);assert.match(css,/is-unavailable/);
});

test('module is safe when the routed panel is absent',()=>{
 const context={Intl,URLSearchParams,window:{},document:{getElementById(){return null}}};context.globalThis=context;vm.runInNewContext(js,context);
 assert.equal(typeof context.window.createPultBuyerOrderSegments,'function');
 assert.equal(typeof context.window.pultBuyerOrderSegments.load,'function');
});

test('render uses legal-entity amounts and does not substitute the total order amount',()=>{
 const ids=['buyer-order-segments','buyer-segment-from','buyer-segment-to','market','store','b2b-content','b2b-page-state','buyer-segment-state','buyer-segment-period','b2b-compare','buyer-segment-cards','b2b-radar','b2b-opportunity-count','b2b-opportunity-list','b2b-trend','b2b-trend-note','b2b-table-wrap','b2b-table-count','b2b-page-info','b2b-prev','b2b-next','buyer-product-title','buyer-product-source','buyer-segment-source','buyer-segment-quick','buyer-segment-load','b2b-zone-filters','buyer-product-types','b2b-trend-modes','b2b-find-growth','b2b-drawer','b2b-drawer-backdrop','b2b-drawer-close','b2b-drawer-content'];
 const nodes=new Map(ids.map(id=>[id,{id,value:'',checked:true,hidden:false,disabled:false,innerHTML:'',textContent:'',className:'',dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},removeEventListener(){},querySelectorAll(){return[]},setAttribute(){},focus(){},scrollIntoView(){}}]));
 nodes.get('buyer-segment-from').value='2026-09-01';nodes.get('buyer-segment-to').value='2026-09-07';nodes.get('market').value='';nodes.get('store').value='';
 const context={Intl,URLSearchParams,Date,Math,Promise,Error,fetch:async()=>{},window:{location:{search:'',hash:''},addEventListener(){},removeEventListener(){}},document:{hidden:false,body:{dataset:{pultView:'overview'}},getElementById:id=>nodes.get(id)||null,querySelector(){return null},querySelectorAll(){return[]},addEventListener(){}}};context.globalThis=context;vm.runInNewContext(js,context);
 const available=value=>({value,status:'available'}),product={id:'Ozon|1|p1',market:'Ozon',storeId:'1',productId:'p1',sku:'SKU-1',name:'Товар',current:{totalUnits:available(10),b2bUnits:available(6),individualUnits:available(4),b2bShare:available(.6),avgOrderUnits:available(3),amountRub:available(999),b2bAmountRub:available(500)},growth:available(.2),score:88,scoreStatus:'ok',zone:'leaders',components:{share:24,growth:17,avgOrder:12,amountShare:16,stability:9,amount:8},potentialRub:available(100),flags:[]};
 const app=context.window.createPultBuyerOrderSegments({api:async()=>{throw Error('unexpected')}});app.render({status:'ready',periods:{current:{from:'2026-09-01',to:'2026-09-07'}},coverage:{complete:true},meta:{total:1},kpis:{b2bAmountRub:available(500),b2bShare:available(.6),b2bUnits:available(6),avgOrderUnits:available(3),b2bGrowth:available(.2),potentialRub:available(100),previousB2bShare:available(.4)},products:[product],categories:[],opportunities:[],zones:{thresholds:{share:{median:.6},growth:{median:.1}}},trend:[{date:'2026-09-01',b2bAmountRub:100,status:'available'},{date:'2026-09-02',b2bAmountRub:120,status:'available'}],quality:{rowCount:1,lowDataCount:0}});
 assert.match(nodes.get('buyer-segment-cards').innerHTML,/500[^<]*₽/);assert.doesNotMatch(nodes.get('buyer-segment-cards').innerHTML,/999/);
 assert.match(nodes.get('buyer-segment-cards').innerHTML,/было 40/);assert.match(nodes.get('b2b-table-wrap').innerHTML,/500[^<]*₽/);assert.match(nodes.get('b2b-radar').innerHTML,/Сумма B2B-заказов 500/);
 assert.match(nodes.get('b2b-radar').innerHTML,/b2b-axis is-x[^>]+--split:60%/);assert.match(nodes.get('b2b-radar').innerHTML,/B2B-хиты/);
 const low={...product,id:'low',name:'Низкая выборка',score:null,scoreStatus:'LOW_DATA',zone:'LOW_DATA',growth:{value:null,status:'unavailable'},current:{...product.current,b2bAmountRub:{value:null,status:'unavailable'},b2bUnits:{value:7,status:'partial'}}};app.render({status:'partial',periods:{current:{from:'2026-09-01',to:'2026-09-07'}},coverage:{currentComplete:false},meta:{total:1},kpis:{},products:[low],categories:[],opportunities:[],zones:{thresholds:{}},trend:[],quality:{rowCount:1,lowDataCount:1}});
 assert.match(nodes.get('buyer-product-source').textContent,/наблюдаемым B2B-единицам/);assert.doesNotMatch(nodes.get('b2b-radar').innerHTML,/B2B-хиты/);
});

test('radar geometry follows model thresholds rather than fixed halves',()=>{
 assert.match(js,/thresholds\?\.share\?\.median/);assert.match(js,/thresholds\?\.growth\?\.median/);assert.match(js,/hasThresholds\?/);
 assert.match(css,/b2b-axis\.is-x\{left:var\(--split\)/);assert.match(css,/z-growth\{left:0;top:0;width:var\(--sx\);height:var\(--sy\)/);
});

test('labels distinguish ordered amounts from realized revenue',()=>{
 assert.match(js,/Сумма B2B-заказов/);assert.match(js,/Заказанные единицы и суммы заказов/);assert.match(js,/выкуп и фактическая выручка не подтверждаются/);
 assert.doesNotMatch(html,/Продажи B2B/);assert.match(js,/не гарантированный прогноз/i);
});
