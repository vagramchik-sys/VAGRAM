'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {analyze}=require('../dist/xway-opportunities.js');
const observedAt='2026-09-22T12:00:00+03:00',sourceUrl='https://am.xway.ru/campaigns';
const base={accountKey:'a',status:'active',strategy:'auto',type:'cpc',periodFrom:'2026-09-01',periodTo:'2026-09-15',observedAt,sourceUrl};
const run=(value,filters={})=>analyze(value,filters,{now:Date.parse('2026-09-23T09:00:00Z'),today:'2026-09-23'});

test('unknown metrics are not treated as zero and accounts do not bleed',()=>{
 const result=run({campaigns:[{...base,key:'one',name:'A',clicks:150,orders:null},{...base,accountKey:'b',key:'two',name:'B',clicks:200,orders:0}],products:[]},{account:'a'});
 assert.equal(result.problems.length,0);
 assert.equal(result.meta.campaignCount,1);
});

test('zero orders after enough clicks asks to verify attribution and labels name target as an orientation',()=>{
 const result=run({campaigns:[{...base,key:'one',name:'Поиск ДРР 12%',clicks:120,orders:0,spend:700,drr:null}],products:[]});
 assert.equal(result.problems.length,1);
 assert.equal(result.needsData.length,0);
 assert.match(result.problems[0].action,/атрибуц/u);
 assert.match(result.problems[0].fact,/ориентир в названии/iu);
 assert.doesNotMatch(result.problems[0].reason,/убыт/u);
});

test('growth requires five comparable sampled peers in the same account period and type',()=>{
 const campaigns=[10,20,22,24,26,28].map((drr,index)=>({...base,key:String(index),name:'C'+index,clicks:200,orders:40,drr}));
 campaigns.push({...base,key:'other',name:'Other account',accountKey:'b',clicks:300,orders:50,drr:40});
 const result=run({campaigns,products:[]},{account:'a'});
 assert.deepEqual(result.growth.map(row=>row.title),['C0']);
 assert.match(result.growth[0].action,/Кандидат на проверку/u);
});

test('incomplete and stale periods are gated into needs-data instead of growth',()=>{
 const incomplete=[10,20,22,24,26].map((drr,index)=>({...base,key:String(index),name:'C'+index,periodTo:'2026-10-01',clicks:200,orders:40,drr}));
 const stale={...base,key:'stale',name:'Stale',observedAt:'2026-09-01T00:00:00Z',clicks:200,orders:40,drr:8};
 const result=run({campaigns:[...incomplete,stale],products:[]});
 assert.equal(result.growth.length,0);
 assert.equal(result.needsData.length,6);
});

test('low stock is an estimate from a completed period and product search is independent of campaign status',()=>{
 const products=[{...base,key:'p',name:'Чайник',sku:'SKU-1',stock:5,orderedUnits:60}];
 const result=run({campaigns:[],products},{status:'active',query:'sku-1'});
 assert.equal(result.problems.length,1);
 assert.match(result.problems[0].fact,/оценка, не прогноз/u);
 assert.equal(result.meta.productFiltersIgnoreCampaignFields,true);
});

test('today, future observations and old periods are not eligible',()=>{
 const today={...base,key:'today',name:'Today',periodTo:'2026-09-23',clicks:200,orders:0};
 const future={...base,key:'future',name:'Future',observedAt:'2026-09-24T00:00:00+03:00',clicks:200,orders:0};
 const old={...base,key:'old',name:'Old',periodFrom:'2026-08-01',periodTo:'2026-08-30',clicks:200,orders:0};
 const result=run({campaigns:[today,future,old],products:[]});
 assert.equal(result.problems.length,0);
 assert.equal(result.needsData.length,3);
});

test('peer benchmark ignores search and produces relative high DRR signal',()=>{
 const campaigns=[10,11,12,13,14].map((drr,index)=>({...base,key:'peer'+index,name:'Peer '+index,clicks:200,orders:30,drr}));
 campaigns.push({...base,key:'high',name:'High ДРР до 10',clicks:250,orders:12,drr:30});
 const unfiltered=run({campaigns,products:[]});
 const searched=run({campaigns,products:[]},{query:'High'});
 assert.equal(unfiltered.problems.some(row=>row.title==='High ДРР до 10'),true);
 assert.equal(searched.problems.some(row=>row.title==='High ДРР до 10'),true);
 assert.match(searched.problems.find(row=>row.title==='High ДРР до 10').reason,/не порог прибыльности/u);
 assert.match(searched.problems.find(row=>row.title==='High ДРР до 10').fact,/Ориентир в названии: ДРР 10%/u);
});

test('target range uses upper bound only as a label',()=>{
 const campaigns=[10,11,12,13,14].map((drr,index)=>({...base,key:'peer'+index,name:'Peer '+index,clicks:200,orders:30,drr}));
 campaigns.push({...base,key:'high',name:'План ДРР 13-15',clicks:250,orders:12,drr:30});
 const result=run({campaigns,products:[]},{query:'План'});
 assert.match(result.problems[0].fact,/ДРР 15%/u);
});

test('weak peers do not form baseline and four-order campaign asks for more data',()=>{
 const campaigns=[10,11,12,13,14].map((drr,index)=>({...base,key:'weak'+index,name:'Weak '+index,clicks:200,orders:1,drr}));
 campaigns.push({...base,key:'candidate',name:'Candidate',clicks:200,orders:4,drr:40});
 const result=run({campaigns,products:[]},{query:'Candidate'});
 assert.equal(result.problems.length,0);
 assert.equal(result.growth.length,0);
 assert.equal(result.needsData.length,1);
 assert.match(result.needsData[0].reason,/недостаточно/u);
});
