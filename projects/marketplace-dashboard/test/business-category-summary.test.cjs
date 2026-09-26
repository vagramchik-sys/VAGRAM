'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../business-category-summary.cjs');

test('category summary counts only roots once across markets and labels missing coverage', () => {
  const point = (value, complete = true) => ({ date: '2026-09-25', orderedRevenue: value, complete });
  const report = {
    types: [{id:'root-a',parentId:null,name:'Крепёж'}, {id:'child',parentId:'root-a',name:'Саморезы'}, {id:'root-b',parentId:null,name:'Ленты'}],
    series: [
      {typeId:'root-a',market:'Ozon',points:[point(100)]},
      {typeId:'root-a',market:'WB',points:[point(50)]},
      {typeId:'child',market:'Ozon',points:[point(100)]},
      {typeId:'root-b',market:'Ozon',points:[point(25,false)]},
      {typeId:'root-b',market:'WB',points:[point(null,false)]}
    ],
    byProduct: Array.from({length:1000},(_,i)=>({productKey:String(i)})),
    coverage: {complete:false,stores:[{source:'orders',observed:true},{source:'unavailable',observed:false}]}
  };
  const result = summarize(report, '2026-09-25');
  assert.equal(result.knownTotal,175);
  assert.equal(result.complete,false);
  assert.deepEqual(result.rows.map(({name,value})=>({name,value})),[{name:'Крепёж',value:150},{name:'Ленты',value:25}]);
  assert.equal(result.coverage.availableStores,1);
  assert.equal(result.coverage.selectedStores,2);
  assert.equal(result.rows[0].share,150/175*100);
  assert.equal(JSON.stringify(result).includes('productKey'),false);
});

test('missing category amounts stay null rather than zero', () => {
  const result = summarize({types:[{id:'x',parentId:null,name:'Неизвестно'}],series:[],coverage:{complete:false,stores:[]}},'2026-09-25');
  assert.equal(result.knownTotal,null);
  assert.deepEqual(result.rows,[]);
});
