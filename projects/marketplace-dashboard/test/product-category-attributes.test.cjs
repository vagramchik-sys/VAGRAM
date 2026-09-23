'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {attributes}=require('../product-category-attributes.cjs');
const ids=value=>Object.fromEntries(Object.entries(attributes(value)).map(([key,item])=>[key,item?.id||null]));

test('screw colors and zinc coatings are separate explicit facets',()=>{
 assert.deepEqual(ids({name:'Саморезы кровельные, жёлтый цинк, 4,8×70 мм, 250 шт.'}),{color:'yellow',material:null,coating:'yellow-zinc',size:'size-4-8x70-mm',density:null,pack:'pack-250-pieces'});
 assert.deepEqual(ids({title:'Саморезы ЧЁРНЫЕ фосфатированные 3.5х35 мм'}),{color:'black',material:null,coating:'phosphate',size:'size-3-5x35-mm',density:null,pack:null});
 assert.equal(attributes({name:'Саморез оцинкованный 4,2х75 мм'}).color,null);
 assert.equal(attributes({name:'Саморез оцинкованный 4,2х75 мм'}).coating.id,'zinc');
 assert.deepEqual(ids({name:'Саморез из нержавеющей стали, белый'}),{color:'white',material:'stainless-steel',coating:null,size:null,density:null,pack:null});
});

test('glove base material stays distinct from coating',()=>{
 const mixed=attributes({title:'Перчатки ХБ с латексом, чёрные, размер L'});
 assert.equal(mixed.material.id,'cotton');assert.equal(mixed.coating.id,'latex');assert.equal(mixed.color.id,'black');assert.equal(mixed.size.id,'size-l');
 assert.deepEqual(ids({name:'Краги сварщика из спилка, серые'}),{color:'gray',material:'split-leather',coating:null,size:null,density:null,pack:null});
 assert.equal(attributes({name:'Перчатки нейлоновые с ПВХ точкой, синие'}).material.id,'nylon');
 assert.equal(attributes({name:'Перчатки нейлоновые с ПВХ точкой, синие'}).coating.id,'pvc');
 assert.equal(attributes({name:'Перчатки нитриловые голубые'}).material.id,'nitrile');assert.equal(attributes({name:'Перчатки нитриловые голубые'}).color.id,'light-blue');
 assert.equal(attributes({name:'Перчатки хлопчатобумажные Х/Б, 10 пар'}).material.id,'cotton');
 assert.deepEqual(attributes({name:'Перчатки хлопчатобумажные Х/Б, 10 пар'}).pack,{id:'pack-10-pairs',name:'10 пар',evidence:'Название: Перчатки хлопчатобумажные Х/Б, 10 пар'});
});

test('article words do not turn an explicitly coated glove into a latex base',()=>{
 const coated=attributes({title:'Перчатки рабочие строительные с двойным латексным обливом (300 пар) 13 класс (600 шт.)',offer_id:'300 пар перчатки латекс'});
 assert.equal(coated.material,null);assert.equal(coated.coating.id,'latex');
 const cotton=attributes({title:'Перчатки рабочие садовые прорезиненные ХБ с двойным латексным покрытием, 100 пар',offer_id:'100 пар перчатки латекс'});
 assert.equal(cotton.material.id,'cotton');assert.equal(cotton.coating.id,'latex');
});

test('named characteristics are accepted and keep readable evidence',()=>{
 const value=attributes({name:'Рабочие перчатки',characteristics:[{name:'Материал основы',values:['100% хлопок']},{name:'Материал покрытия',values:['нитрил']},{name:'Цвет товара',values:['оранжевый']},{name:'Размер',values:['XL']},{name:'Количество пар в упаковке',values:[12]}]});
 assert.deepEqual(ids({name:'Рабочие перчатки',characteristics:[{name:'Материал основы',values:['100% хлопок']},{name:'Материал покрытия',values:['нитрил']},{name:'Цвет товара',values:['оранжевый']},{name:'Размер',values:['XL']},{name:'Количество пар в упаковке',values:[12]}]}),{color:'orange',material:'cotton',coating:'nitrile',size:'size-xl',density:null,pack:'pack-12-pairs'});
 assert.equal(value.material.evidence,'Характеристика «Материал основы»: 100% хлопок');assert.match(value.coating.evidence,/Материал покрытия/u);
});

test('explicit conflicts and negations fail closed',()=>{
 assert.equal(attributes({title:'Перчатки чёрные',characteristics:[{name:'Цвет',values:['белый']}]}).color,null);
 assert.equal(attributes({name:'Лента не чёрная'}).color,null);
 assert.equal(attributes({name:'Перчатки без латекса'}).material,null);
 assert.equal(attributes({name:'Саморез неоцинкованный'}).coating,null);
 assert.equal(attributes({title:'Перчатки хлопковые',characteristics:[{name:'Материал',values:['нейлон']}]}).material,null);
 assert.equal(attributes({name:'Перчатки хлопок/нейлон'}).material,null);
});

test('multiple explicit colors produce deterministic combinations',()=>{
 assert.deepEqual(attributes({name:'Саморезы чёрно-жёлтые'}).color,{id:'black-yellow',name:'чёрный + жёлтый',evidence:'Название: Саморезы чёрно-жёлтые'});
 assert.equal(attributes({name:'Стяжки разноцветные'}).color.id,'multicolor');
 assert.equal(attributes({characteristics:[{name:'Цвет',values:['белый, красный']}]}).color.id,'red-white');
});

test('film, tape, mesh, tarp and bag measurements require explicit units',()=>{
 assert.equal(attributes({name:'Плёнка полиэтиленовая 2×10 м, прозрачная'}).material.id,'polyethylene');
 assert.equal(attributes({name:'Плёнка полиэтиленовая 2×10 м, прозрачная'}).size.id,'size-2x10-m');
 assert.equal(attributes({name:'Сетка фасадная 1×50 м, плотность 160 г/м²'}).density.id,'density-160-g-m2');
 assert.equal(attributes({name:'Тент 3х5 м, плотность 120 гр/м2, синий'}).size.id,'size-3x5-m');
 assert.equal(attributes({name:'Мешки для мусора 120 л, 20 шт.'}).size.id,'volume-120-l');
 assert.deepEqual(attributes({name:'Мешки для мусора 120 л, 20 шт.'}).pack,{id:'pack-20-pieces',name:'20 шт.',evidence:'Название: Мешки для мусора 120 л, 20 шт.'});
 assert.equal(attributes({name:'Сетка модель 2026'}).size,null);
 const tape=attributes({name:'Лента армированная',characteristics:[{name:'Ширина',values:['50 мм']},{name:'Длина рулона',values:['25 м']}]});
 assert.deepEqual(tape.size,{id:'size-50-mmx25-m',name:'50 мм × 25 м',evidence:'Характеристика «Ширина»: 50 мм; Характеристика «Длина рулона»: 25 м'});
});

test('unknown characteristic names, opaque IDs and photos do not create facets',()=>{
 const value=attributes({name:'Саморезы универсальные',offer_id:'SKU_12345',categoryId:77,photo:'black.jpg',characteristics:[{id:999,name:'Модель',values:['Black 120']} ]});
 assert.deepEqual(value,{color:null,material:null,coating:null,size:null,density:null,pack:null});
});

test('color tokens do not match unrelated russian word stems',()=>{
 assert.equal(attributes({name:'Серпянка синтетическая белизна повышенная'}).color,null);
});

test('underscores, russian inflections and characteristic object values normalize safely',()=>{
 const value=attributes({vendorCode:'PERVATKI_БЕЛОГО_CVETA',characteristics:[{name:'Материал',values:[{value:'латексная'}]}]});
 assert.equal(value.color.id,'white');assert.equal(value.material.id,'latex');
 for(const item of Object.values(value).filter(Boolean))assert.match(item.id,/^[a-z0-9-]{1,40}$/u);
});
