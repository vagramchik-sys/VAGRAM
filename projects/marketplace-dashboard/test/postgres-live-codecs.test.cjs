'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encode, decode, decodeMetadata, parseSourcePath, isSupportedSourcePath, MAX_METADATA_BYTES } = require('../storage/postgres-live-codecs.cjs');

const DAY='2026-09-22',TIME=DAY+'T10:00:00.000Z';
const fixtures = [
  ['data-1.json',{clientId:'1',market:'Ozon',period:{from:DAY,to:DAY},products:[{product_id:1,name:'P',sources:[{sku:10}]}],stocks:[{product_id:1,stocks:[{sku:10}]}],operations:[{operation_id:'o1',date:DAY,total_amount:{amount:'1'}}],stockRows:[{product_id:1,warehouseId:'w'}],categoryTree:[{description_category_id:7,children:[]}],sections:{finance:{ok:true}}}],
  ['insights-1.json',{sections:{orders:{ok:true}},types:[{id:41,name:'Ads'}],orders:{period:{from:DAY,to:DAY},daily:[{date:DAY,revenue:10,units:1}],skuDaily:[{date:DAY,sku:'10',revenue:10,units:1}],skuCoverage:[DAY]},errors:[]}],
  ['costs-1.json',{importedAt:TIME,items:[{product_id:1,unitCost:5}]}],
  ['prices-wb-2.json',{importedAt:TIME,items:[{nmID:2,price:5}]}],
  ['ozon-funnel-1.json',{version:1,status:'ready',snapshot:{version:1,current:{from:DAY,to:DAY},previous:{from:'2026-09-15',to:'2026-09-21'},currentRows:[{sku:'10',orderedUnits:1}],previousRows:[{sku:'10',orderedUnits:2}],metrics:['ordered_units'],updatedAt:TIME}}],
  ['wb-orders-wb-2.json',{day:DAY,fetchedAt:TIME,complete:true,points:[{at:TIME,orderedRevenue:10,orderedUnits:1}],orders:[{at:TIME,amount:10,nmId:'2'}],attemptAt:TIME,error:null}],
  ['ledger-1.json',{stamp:TIME,source:{snapshotId:'s'},data:{version:3,period:{from:DAY,to:DAY},completedAt:TIME,currencies:['RUB'],daily:[{date:DAY,values:{net:10}}],skuDaily:[{date:DAY,sku:'10',values:{net:10}}],fees:[{date:DAY,typeId:1,group:'ads',values:{amount:1}}]}}],
  [`buyer-order-segments-${DAY}_${DAY}.partial.json`,{version:2,period:{from:DAY,to:DAY},scope:'all-ozon-stores',status:'collected',generatedAt:TIME,records:[{id:'r1',market:'Ozon',storeId:'1',scheme:'FBO',createdAt:TIME,units:1}],productOrders:[{market:'Ozon',storeId:'1',scheme:'FBO',orderId:'o1',postingId:'p1',productId:'10',orderedAt:TIME,units:1}],report:{status:'partial',byStore:[{storeId:'1'}],coverage:{complete:false,sources:[{market:'Ozon',storeId:'1',scheme:'FBO',available:true,complete:false}]},limitations:['partial']},errors:[]}],
  [`buyer-product-segments-${DAY}_${DAY}.partial.json`,{status:'partial',period:{from:DAY,to:DAY},products:[{market:'Ozon',storeId:'1',productId:'10',segments:{legal:{units:1}}}],coverage:{complete:false,sources:[{market:'Ozon',storeId:'1',available:true}]},limitations:['partial'],errors:[]}],
  ['order-category-catalog-1.json',{schemaVersion:2,stamp:'x',products:[{product_id:1,sku:10}],categoryTree:[{description_category_id:7}]}],
  ['intraday-1.json',{version:1,points:[{source:'orders',date:DAY,at:TIME,values:{orderedRevenue:10}}],commandResults:[{commandId:'11111111-1111-4111-8111-111111111111',timestamp:TIME,inputHash:'a'.repeat(64),changed:true,pointCount:1}]}],
  ['order-category-intraday.json',{version:2,points:[{date:DAY,at:TIME,taxonomyRevision:'r1',types:[{id:'a'}],values:{a:{orderedRevenue:10,orderedUnits:1}}}],commandResults:[]}]
];

test('actual-shaped live sources round-trip with array-free bounded metadata',()=>{
 for(const[sourcePath,value]of fixtures){const encoded=encode(sourcePath,value);assert.deepEqual(decode(sourcePath,encoded),value,sourcePath);assert.ok(Buffer.byteLength(JSON.stringify(encoded.metadata))<=MAX_METADATA_BYTES);assert.equal(findArray(encoded.metadata),null,sourcePath);for(const rows of Object.values(encoded.collections))for(let index=0;index<rows.length;index++)assert.deepEqual(Object.keys(rows[index]),['key','day','ordinal','value'])}
});

test('duplicate records never collapse and exact source order is restored',()=>{
 const value={version:2,period:{from:DAY,to:DAY},records:[{market:'Ozon',storeId:'1',scheme:'FBO',units:1},{market:'Ozon',storeId:'1',scheme:'FBO',units:1}],productOrders:[],report:{coverage:{sources:[]}},errors:[]},encoded=encode(`buyer-order-segments-${DAY}_${DAY}.json`,value),rows=encoded.collections.records;
 assert.equal(rows.length,2);assert.equal(rows[0].key,rows[1].key);assert.deepEqual(rows.map(row=>row.ordinal),[0,1]);assert.deepEqual(decode(`buyer-order-segments-${DAY}_${DAY}.json`,encoded),value);
});

test('decode detaches restored values without cloning or mutating row envelopes',()=>{
 const sourcePath=`buyer-order-segments-${DAY}_${DAY}.json`,value={records:[{id:'r1',market:'Ozon',storeId:'1',scheme:'FBO',nested:{count:1}}],productOrders:[],report:{coverage:{sources:[]}}},encoded=encode(sourcePath,value),before=structuredClone(encoded);
 const decoded=decode(sourcePath,encoded);decoded.records[0].nested.count=9;
 assert.deepEqual(encoded,before);assert.equal(encoded.collections.records[0].value.nested.count,1);
});

test('unknown arrays and oversized metadata fail closed with stable codes',()=>{
 assert.throws(()=>encode('costs-1.json',{importedAt:TIME,items:[],unknown:[]}),error=>error.code==='UNSUPPORTED_ARRAY_PATH');
 assert.throws(()=>encode('costs-1.json',{importedAt:'x'.repeat(MAX_METADATA_BYTES),items:[]}),error=>error.code==='METADATA_TOO_LARGE');
});

test('missing, null and present arrays remain distinct',()=>{
 for(const value of [{importedAt:TIME},{importedAt:TIME,items:null},{importedAt:TIME,items:[]}])assert.deepEqual(decode('costs-1.json',encode('costs-1.json',value)),value);
});

test('source paths produce strict repository scopes',()=>{
 assert.deepEqual(parseSourcePath(`buyer-order-segments-${DAY}_${DAY}-retry-2.partial.json`),{kind:'buyer-order-segments',scope:{domain:'buyers',storeId:`buyer-order-segments-${DAY}_${DAY}-retry-2.partial`,period:{from:DAY,to:DAY},retry:2,partial:true}});
 assert.deepEqual(parseSourcePath('intraday-wb-2.json'),{kind:'intraday',scope:{domain:'intraday',storeId:'wb-2'}});
 assert.equal(isSupportedSourcePath('buyer-product-segments-2026-09-01_2026-09-02.json'),true);
 assert.equal(isSupportedSourcePath('../data-1.json'),false);
});

test('decode rejects missing rows, reordered ordinals and source substitution',()=>{
 const value={importedAt:TIME,items:[{product_id:1},{product_id:2}]},encoded=encode('costs-1.json',value);
 encoded.collections.items[0].ordinal=1;
 assert.throws(()=>decode('costs-1.json',encoded),error=>error.code==='INVALID_ENCODED');
 const wrong=encode('costs-1.json',value);wrong.collections.unknown=[];assert.throws(()=>decode('costs-1.json',wrong),error=>error.code==='INVALID_ENCODED');
 const wrongKey=encode('costs-1.json',value);wrongKey.collections.items[0].key='product:other';assert.throws(()=>decode('costs-1.json',wrongKey),error=>error.code==='INVALID_ENCODED');
});

test('partial decode returns empty arrays only for present collection markers',()=>{
 const sourcePath='data-1.json',value={clientId:'1',products:[{product_id:1}],stocks:null},encoded=encode(sourcePath,value),partial=decode(sourcePath,{metadata:encoded.metadata,collections:{}},{partial:true});
 assert.deepEqual(partial,{clientId:'1',products:[],stocks:null});assert.deepEqual(decodeMetadata(sourcePath,encoded.metadata),partial);
 assert.throws(()=>decode(sourcePath,{metadata:encoded.metadata,collections:{}}),error=>error.code==='INVALID_ENCODED');
});

function findArray(value,path='$'){if(Array.isArray(value))return path;if(!value||typeof value!=='object')return null;for(const[key,child]of Object.entries(value)){const found=findArray(child,path+'.'+key);if(found)return found}return null}
