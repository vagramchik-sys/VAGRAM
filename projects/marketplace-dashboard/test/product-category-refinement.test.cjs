'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { refine, mergeCottonPvcGloveColors } = require('../product-category-refinement.cjs');
const { options: commandOptions } = require('../scripts/refine-product-categories.cjs');
const { validate, classify } = require('../product-type-registry.cjs');
const timestamp = '2026-09-23T10:00:00Z';
function fixture() {
  return { schemaVersion: 1, revision: 'reviewed-1', reviewedAt: timestamp, types: [
    { id: 'grp-fasteners', parentId: null, name: 'Крепёж' },
    { id: 'grp-threaded-fasteners', parentId: 'grp-fasteners', name: 'Резьбовой крепёж' },
    { id: 'typ-self-tapping', parentId: 'grp-threaded-fasteners', name: 'Саморезы' },
    { id: 'screw-wood', parentId: 'typ-self-tapping', name: 'Саморезы по дереву' },
    { id: 'typ-roof-screws', parentId: 'typ-self-tapping', name: 'Кровельные саморезы' },
    { id: 'screw-roof-wood', parentId: 'typ-roof-screws', name: 'Кровельные саморезы по дереву' },
    { id: 'ppe', parentId: null, name: 'Средства защиты' },
    { id: 'gloves', parentId: 'ppe', name: 'Перчатки' },
    { id: 'gloves-coated', parentId: 'gloves', name: 'Перчатки с обливом' }
  ], assignments: { '1:a': 'screw-wood', '1:b': 'screw-wood', '1:c': 'screw-wood', '1:roof': 'screw-roof-wood', '1:glove': 'gloves-coated', '1:historic': 'screw-wood' }, rules: [] };
}
const products = () => [
  { key: '1:a', name: 'Саморезы по дереву чёрные 3,5х35 мм 100 шт' },
  { key: '1:b', name: 'Саморезы по дереву жёлтые 3,5х35 мм 100 шт' },
  { key: '1:c', name: 'Саморезы по дереву 3,5х35 мм 100 шт' },
  { key: '1:roof', name: 'Саморез кровельный по дереву красный 4,8х70 мм' },
  { key: '1:glove', name: 'Перчатки ХБ с латексным покрытием синие 10 пар' }
];
function names(registry, key) {
  const map = new Map(registry.types.map(type => [type.id, type]));
  const path = [];
  for (let type = map.get(registry.assignments[key].typeId); type; type = map.get(type.parentId)) path.unshift(type.name);
  return path;
}
test('screws gain a real fifth color level; roof groups leave room for the same level', () => {
  const result = refine(fixture(), products(), { reviewedAt: timestamp });
  assert.deepEqual(names(result.registry, '1:a'), ['Крепёж', 'Резьбовой крепёж', 'Саморезы', 'Саморезы по дереву', 'Цвет: чёрный']);
  assert.equal(names(result.registry, '1:b').at(-1), 'Цвет: жёлтый');
  assert.equal(names(result.registry, '1:roof').length, 5);
  assert.equal(names(result.registry, '1:roof').at(-1), 'Цвет: красный');
});
test('gloves separate explicit base material and color without guessing the fabric from coating', () => {
  const result = refine(fixture(), products(), { reviewedAt: timestamp });
  assert.deepEqual(names(result.registry, '1:glove'), ['Средства защиты', 'Перчатки', 'Перчатки с обливом', 'Материал: хлопок', 'Цвет: синий']);
});
test('missing attributes and historical assignments remain valid without fabricated colors', () => {
  const result = refine(fixture(), products(), { reviewedAt: timestamp });
  assert.match(names(result.registry, '1:c').at(-1), /не указан/u);
  assert.match(names(result.registry, '1:historic').at(-1), /не указан/u);
  assert.equal(Object.keys(result.registry.assignments).length, Object.keys(fixture().assignments).length);
  assert.doesNotThrow(() => validate(result.registry));
  assert.deepEqual(fixture().assignments['1:a'], 'screw-wood');
});
test('refinement is idempotent and generated nodes keep stable IDs', () => {
  const first = refine(fixture(), products(), { reviewedAt: timestamp });
  const second = refine(first.registry, products(), { reviewedAt: '2026-09-24T10:00:00Z' });
  assert.equal(second.changed, false);
  assert.deepEqual(second.registry, first.registry);
  assert.deepEqual(refine(fixture(), products(), { reviewedAt: timestamp }).registry, first.registry);
});
test('only explicit family names classify a newly seen item', () => {
  const result = refine(fixture(), [...products(), { key: '1:new', name: 'Саморезы по дереву черные 41мм' }, { key: '1:unknown', name: '41мм чёрный товар' }], { reviewedAt: timestamp });
  assert.deepEqual(result.assignedNew, ['1:new']);
  assert.equal(names(result.registry, '1:new').at(-1), 'Цвет: чёрный');
  assert.equal(result.registry.assignments['1:unknown'], undefined);
});
test('an old broad matching rule remains a valid leaf without inventing attributes', () => {
  const source = fixture();
  source.rules.push({ id: 'wood', leafTypeId: 'screw-wood', includeAny: ['саморез по дереву'], includeAll: [], excludeAny: [] });
  const { registry } = refine(source, products(), { reviewedAt: timestamp });
  const classified = classify(registry, '2:new', { name: 'Саморез по дереву неизвестный' });
  assert.equal(registry.types.find(type => type.id === classified.typeId).name, 'Характеристики не уточнены');
});
test('without supported characteristics an existing leaf is preserved without filler levels', () => {
  const source = fixture();
  source.types = source.types.filter(type => !['typ-roof-screws', 'screw-roof-wood'].includes(type.id));
  delete source.assignments['1:roof'];
  const result = refine(source, [], { reviewedAt: timestamp });
  assert.equal(result.changed, false);
  assert.equal(result.addedTypes.length, 0);
});
test('cotton PVC gloves merge gray and unspecified color only under the reviewed parent', () => {
  const source={schemaVersion:1,revision:'gloves-1',reviewedAt:timestamp,types:[
   {id:'ppe',parentId:null,name:'Средства защиты'},{id:'cotton-pvc',parentId:'ppe',name:'Перчатки хлопчатобумажные с ПВХ'},
   {id:'gray',parentId:'cotton-pvc',name:'Цвет: серый'},{id:'unknown',parentId:'cotton-pvc',name:'Цвет: не указан'},
   {id:'white',parentId:'cotton-pvc',name:'Цвет: белый'},{id:'black',parentId:'cotton-pvc',name:'Цвет: чёрный'},
   {id:'other',parentId:'ppe',name:'Другие перчатки'},{id:'other-gray',parentId:'other',name:'Цвет: серый'},{id:'other-unknown',parentId:'other',name:'Цвет: не указан'}
  ],assignments:{'1:gray':'gray','1:unknown':'unknown','1:white':'white','1:black':'black','1:other-gray':'other-gray','1:other-unknown':'other-unknown'},rules:[]};
  const first=refine(source,[],{reviewedAt:timestamp}),merged=first.registry.types.find(type=>type.parentId==='cotton-pvc'&&type.name==='Цвет: серый / не указан');
  assert.ok(merged);assert.equal(first.registry.assignments['1:gray'].typeId,merged.id);assert.equal(first.registry.assignments['1:unknown'].typeId,merged.id);
  assert.equal(first.registry.assignments['1:white'].typeId,'white');assert.equal(first.registry.assignments['1:black'].typeId,'black');
  assert.ok(first.registry.types.some(type=>type.id==='other-gray'));assert.ok(first.registry.types.some(type=>type.id==='other-unknown'));
  assert.equal(first.registry.types.some(type=>type.id==='gray'||type.id==='unknown'),false);
  const second=refine(first.registry,[],{reviewedAt:'2026-09-24T10:00:00Z'});assert.equal(second.changed,false);assert.deepEqual(second.registry,first.registry);
 });
test('targeted glove merge and maintenance arguments do not require full catalog refinement',()=>{
 const source=fixture();source.types.push({id:'cotton-pvc',parentId:'ppe',name:'Перчатки хлопчатобумажные с ПВХ'},{id:'gray',parentId:'cotton-pvc',name:'Цвет: серый'},{id:'unknown',parentId:'cotton-pvc',name:'Цвет: не указан'});source.assignments['1:gray']='gray';source.assignments['1:unknown']='unknown';
 const result=mergeCottonPvcGloveColors(source,{reviewedAt:timestamp});assert.equal(result.changed,true);assert.equal(result.changes.length,2);assert.match(result.registry.revision,/^glove-colors-/u);
 assert.deepEqual(commandOptions(['--merge-cotton-pvc-colors']),{apply:false,mergeColors:true});assert.deepEqual(commandOptions(['--merge-cotton-pvc-colors','--apply']),{apply:true,mergeColors:true});assert.throws(()=>commandOptions(['--merge-cotton-pvc-colors','--merge-cotton-pvc-colors']));
});
