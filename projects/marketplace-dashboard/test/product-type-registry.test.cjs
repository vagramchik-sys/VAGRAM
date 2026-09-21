'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create,validate,classify}=require('../product-type-registry.cjs');
const registry=()=>({schemaVersion:1,revision:'types-1',reviewedAt:'2026-09-20T11:00:00.000Z',types:[{id:'fasteners',parentId:null,name:'Крепёж'},{id:'beam-supports',parentId:'fasteners',name:'Опоры бруса'},{id:'beam-supports-open',parentId:'beam-supports',name:'Опоры бруса открытые'},{id:'beam-supports-closed',parentId:'beam-supports',name:'Опоры бруса закрытые'},{id:'mesh',parentId:null,name:'Сетки'},{id:'rodent-mesh',parentId:'mesh',name:'Сетка от грызунов'},{id:'plaster-mesh',parentId:'mesh',name:'Сетка штукатурная'}],assignments:{'ozon-1:101':{typeId:'rodent-mesh',source:'reviewed',evidence:'Карточка проверена'}},rules:[{id:'plaster-mesh-name',leafTypeId:'plaster-mesh',includeAny:['сетка штукатурная'],includeAll:[],excludeAny:[]}]});
test('validated hierarchy uses stable leaf assignments and checked final-product rules',()=>{
 const input=registry();input.assignments['wb-1:503']='rodent-mesh';const value=validate(input);assert.equal(classify(value,'ozon-1:101',{name:'Сетка строительная'}).typeId,'rodent-mesh');assert.deepEqual(classify(value,'wb-1:503',{title:'Не используется'}),{typeId:'rodent-mesh',source:'reviewed',evidence:null});assert.equal(classify(value,'wb-1:5',{title:'Сетка штукатурная 1×10 м'}).typeId,'plaster-mesh');assert.equal(classify(value,'wb-1:6',{category:'Сетка штукатурная'}),null);
});
test('parents, cycles, unknown leaves and size-only guesses are rejected or unresolved',()=>{
 const parent=registry();parent.assignments['ozon-1:102']={typeId:'beam-supports',source:'reviewed'};assert.throws(()=>validate(parent),/конечный тип/);
 const cycle=registry();cycle.types[0].parentId='beam-supports-open';assert.throws(()=>validate(cycle),/цикл/);
 const value=validate(registry());assert.equal(classify(value,'wb-1:7',{name:'100×100, чёрная, 20 шт'}),null);
});
test('read is cached by file stat and missing registry stays unavailable without creating a file',t=>{
 const privateDir=fs.mkdtempSync(path.join(os.tmpdir(),'product-types-'));t.after(()=>fs.rmSync(privateDir,{recursive:true,force:true}));const service=create({privateDir});assert.equal(service.read().available,false);assert.equal(fs.existsSync(service.file),false);
 fs.writeFileSync(service.file,JSON.stringify(registry()));const first=service.read(),second=service.read();assert.equal(first,second);assert.equal(first.revision,'types-1');
});
