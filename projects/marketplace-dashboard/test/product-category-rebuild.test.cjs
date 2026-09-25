'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {rebuild}=require('../product-category-rebuild.cjs');
const {validate,classify}=require('../product-type-registry.cjs');
const {options}=require('../scripts/refine-product-categories.cjs');
const reviewedAt='2026-09-25T08:00:00Z';
const path=(r,key)=>{const map=new Map(r.types.map(t=>[t.id,t])),out=[];for(let t=map.get(r.assignments[key].typeId);t;t=map.get(t.parentId))out.unshift(t.name);return out};
function fixture(){return {schemaVersion:1,revision:'old',reviewedAt,types:[{id:'root',name:'Ленты',parentId:null},{id:'tapes',name:'Клейкие ленты',parentId:'root'},{id:'tape-clear',name:'Скотч прозрачный',parentId:'tapes'},{id:'attr-pack-six',name:'Упаковка: 6 шт.',parentId:'tape-clear'},{id:'attr-pack-one',name:'Упаковка: 1 шт.',parentId:'tape-clear'}],assignments:{'1:a':'attr-pack-six','1:b':'attr-pack-one','1:c':'attr-pack-six','1:historical':'attr-pack-one'},rules:[{id:'clear',leafTypeId:'attr-pack-one',includeAny:['скотч прозрачный']}]}}
const products=[{key:'1:a',name:'Скотч прозрачный 48 мм х 120 м 6 шт'},{key:'1:b',name:'Скотч прозрачный 48 мм х 120 м 1 шт'},{key:'1:c',name:'Скотч прозрачный 48 мм х 180 м 6 шт'}];
test('rebuilds old pack-first branches into product dimensions then packaging without losing historical assignments',()=>{
 const source=fixture(),r=rebuild(source,products,{reviewedAt}).registry;
 assert.equal(Object.keys(r.assignments).length,4);
 assert.deepEqual(path(r,'1:a').slice(0,-1),path(r,'1:b').slice(0,-1));
 assert.notEqual(path(r,'1:a')[3],path(r,'1:c')[3]);
 assert.match(path(r,'1:a')[3],/48 мм × 120 м/);assert.equal(path(r,'1:a')[4],'Упаковка: 6 шт.');
 assert.equal(path(r,'1:b')[4],'Упаковка: 1 шт.');assert.match(path(r,'1:historical')[3],/не указан/);
 assert.equal(source.assignments['1:a'],'attr-pack-six');assert.doesNotThrow(()=>validate(r));
 const future=classify(r,'1:future',{name:'Скотч прозрачный'});assert.equal(r.types.find(t=>t.id===future.typeId).name,'Характеристики не уточнены');
});
test('rebuild is idempotent and reacts to corrected product data instead of freezing generated leaves',()=>{
 const first=rebuild(fixture(),products,{reviewedAt});const second=rebuild(first.registry,products,{reviewedAt:'2026-09-26T00:00:00Z'});
 assert.equal(second.changed,false);assert.deepEqual(second.registry,first.registry);
 const corrected=products.map(p=>p.key==='1:c'?{...p,name:'Скотч прозрачный 48 мм х 120 м 6 шт'}:p);
 const third=rebuild(second.registry,corrected,{reviewedAt});assert.equal(third.changed,true);assert.equal(third.registry.assignments['1:a'].typeId,third.registry.assignments['1:c'].typeId);
});
test('deep navigation is shortened, product characteristics retained and pack is always last',()=>{
 const source={schemaVersion:1,revision:'screws',reviewedAt,types:[{id:'root',name:'Крепёж',parentId:null},{id:'navigation',name:'Резьбовой крепёж',parentId:'root'},{id:'screws',name:'Саморезы',parentId:'navigation'},{id:'wood',name:'Саморез по дереву',parentId:'screws'}],assignments:{'1:a':'wood','1:b':'wood'},rules:[]};
 const result=rebuild(source,[{key:'1:a',name:'Саморез по дереву чёрный 3,5х35 мм 100 шт'},{key:'1:b',name:'Саморез по дереву жёлтый 3,5х35 мм 200 шт'}],{reviewedAt});
 assert.equal(path(result.registry,'1:a').length,5);assert.equal(path(result.registry,'1:a')[3],'Цвет: чёрный');assert.match(path(result.registry,'1:a')[4],/3.5×35 мм/);assert.ok(result.registry.types.some(t=>t.id==='wood'));
});
test('missing packaging is explicit and never guessed as one piece; numeric pack ordering',()=>{
 const ps=[{key:'1:a',name:'Скотч прозрачный 48 мм х 120 м 24 шт'},{key:'1:b',name:'Скотч прозрачный 48 мм х 120 м 6 шт'},{key:'1:c',name:'Скотч прозрачный 48 мм х 120 м'}];
 const r=rebuild(fixture(),ps,{reviewedAt}).registry;assert.equal(path(r,'1:c').at(-1),'Упаковка: не указана');
 const parent=r.types.find(t=>t.id===r.assignments['1:a'].typeId).parentId;assert.deepEqual(r.types.filter(t=>t.parentId===parent).map(t=>t.name),['Упаковка: 6 шт.','Упаковка: 24 шт.','Упаковка: не указана']);
 assert.deepEqual(options(['--rebuild-product-pack']),{apply:false,mergeColors:false,rebuild:true});assert.throws(()=>options(['--rebuild-product-pack','--merge-cotton-pvc-colors']));
});

test('keeps the owners merged gray and unspecified glove group through rebuilding',()=>{
 const r={schemaVersion:1,revision:'gloves',reviewedAt,types:[{id:'ppe',parentId:null,name:'Средства защиты'},{id:'gloves',parentId:'ppe',name:'Перчатки'},{id:'cotton',parentId:'gloves',name:'Перчатки хлопчатобумажные с ПВХ'},{id:'attr-merged',parentId:'cotton',name:'Цвет: серый / не указан'}],assignments:{'1:a':'attr-merged','1:b':'attr-merged'},rules:[]};
 const ps=[{key:'1:a',name:'Перчатки хлопчатобумажные с ПВХ серые 100 пар'},{key:'1:b',name:'Перчатки хлопчатобумажные с ПВХ 100 пар'}];
 const result=rebuild(r,ps,{reviewedAt});assert.equal(result.registry.assignments['1:a'].typeId,result.registry.assignments['1:b'].typeId);assert.match(path(result.registry,'1:a')[3],/серый \/ не указан/);assert.equal(path(result.registry,'1:a')[4],'Упаковка: 100 пар');assert.equal(rebuild(result.registry,ps,{reviewedAt}).changed,false);
});

test('wood screws use colour at level four, product dimensions at five and retain every pack SKU',()=>{
 const r={schemaVersion:1,revision:'wood',reviewedAt,types:[{id:'fasteners',parentId:null,name:'Крепёж'},{id:'screws',parentId:'fasteners',name:'Саморезы'},{id:'wood',parentId:'screws',name:'Саморез по дереву'}],assignments:{'1:a':'wood','1:b':'wood','1:c':'wood','1:d':'wood','1:e':'wood'},rules:[]};
 const ps=[{key:'1:a',name:'Саморез по дереву чёрный 3,5х35 мм 100 шт'},{key:'1:b',name:'Саморез по дереву чёрный 3,5х35 мм 200 шт'},{key:'1:c',name:'Саморез по дереву жёлтый 3,5х35 мм 100 шт'},{key:'1:d',name:'Саморез по дереву чёрный 3,5х50 мм 100 шт'},{key:'1:e',name:'Саморез по дереву 3,5х35 мм 100 шт'}];
 const result=rebuild(r,ps,{reviewedAt}),out=result.registry;
 assert.deepEqual(path(out,'1:a'),['Крепёж','Саморезы','Саморез по дереву','Цвет: чёрный','Саморез по дереву · Размер: 3.5×35 мм']);
 assert.equal(out.assignments['1:a'].typeId,out.assignments['1:b'].typeId);
 assert.notEqual(out.assignments['1:a'].typeId,out.assignments['1:c'].typeId);
 assert.notEqual(out.assignments['1:a'].typeId,out.assignments['1:d'].typeId);
 assert.equal(path(out,'1:e')[3],'Цвет: не указан');
 assert.deepEqual(Object.keys(out.assignments),Object.keys(r.assignments));
 assert.equal(rebuild(out,ps,{reviewedAt}).changed,false);
});
