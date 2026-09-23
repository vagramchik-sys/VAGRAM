'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {SCHEMA_SQL,normalize,importObservations,createXwayReader,createXwayHandler}=require('../storage/postgres-xway.cjs');
const observation={sourceUrl:'https://am.xway.ru/',observedAt:'2026-09-22T12:00:00Z'};
function fixture(){return{version:1,accounts:[{key:'test-account',marketplace:'Ozon',name:'Synthetic account',productsCount:7,campaignsCount:3,...observation}],settings:[{accountKey:'test-account',key:'connection',label:'Connection',value:'Verified',...observation}],campaigns:[{accountKey:'test-account',key:'campaign-1',name:'Synthetic <campaign>',status:'Active',strategy:'Manual',productsCount:1,productsTotalCount:2,spend:12.5,orders:0,drr:0,periodFrom:'2026-09-16',periodTo:'2026-09-22',...observation}]};}
test('XWAY import validates facts without converting unknown metrics to zero',()=>{
 const value=normalize(fixture());assert.equal(value.campaigns[0].drr,null);assert.equal(value.campaigns[0].clicks,null);assert.equal(value.campaigns[0].spend,12.5);
 for(const mutate of [v=>v.accounts[0].apiToken='secret',v=>v.accounts[0].sourceUrl='https://evil.invalid/',v=>v.accounts[0].sourceUrl='https://am.xway.ru/?token=secret',v=>v.campaigns[0].orders=-1,v=>v.campaigns[0].periodFrom='2026-02-30',v=>v.accounts[0].observedAt='yesterday',v=>v.campaigns.push(v.campaigns[0])]){const input=fixture();mutate(input);assert.throws(()=>normalize(input),{code:'INVALID_XWAY_IMPORT'});}
});
test('XWAY HTTP handler permits GET only and sanitizes failures',async()=>{
 let reads=0,status,body;const res={writeHead(value){status=value;},end(value){body=JSON.parse(value);}};
 const handler=createXwayHandler({reader:{async read(){reads++;return{mode:'verified-observations'};}}});
 for(const method of ['POST','PUT','PATCH','DELETE']){assert.equal(await handler.handle({method},res,new URL('http://local/api/xway')),true);assert.equal(status,405);}
 assert.equal(reads,0);await handler.handle({method:'GET'},res,new URL('http://local/api/xway'));assert.equal(status,200);assert.equal(reads,1);
 const broken=createXwayHandler({reader:{async read(){throw Error('private database secret');}}});await broken.handle({method:'GET'},res,new URL('http://local/api/xway'));assert.equal(status,503);assert.ok(!JSON.stringify(body).includes('secret'));
 assert.equal(await handler.handle({method:'GET'},res,new URL('http://local/api/other')),false);
});
test('XWAY PostgreSQL stores individual observations atomically and runtime has SELECT only',{skip:!process.env.PULT_TEST_DATABASE_URL},async t=>{
 assert.match(new URL(process.env.PULT_TEST_DATABASE_URL).pathname,/^\/pult_test_/u);
 const {Pool}=require('pg'),pool=new Pool({connectionString:process.env.PULT_TEST_DATABASE_URL,max:2});t.after(()=>pool.end());
 await pool.query(SCHEMA_SQL);await pool.query(SCHEMA_SQL);
 const input=fixture();input.products=[{accountKey:'test-account',key:'product-1',name:'Synthetic product',sku:'123',stock:0,orderedUnits:14,orders:0,drr:0,periodFrom:'2026-09-16',periodTo:'2026-09-22',...observation}];assert.deepEqual(await importObservations(pool,input),{accounts:1,settings:1,campaigns:1,products:1});
 const reader=createXwayReader({pool}),saved=await reader.read();assert.equal(saved.accounts[0].name,'Synthetic account');assert.equal(saved.campaigns[0].name,'Synthetic <campaign>');assert.equal(saved.campaigns[0].periodFrom,'2026-09-16');assert.equal(saved.campaigns[0].spend,12.5);assert.equal(saved.campaigns[0].drr,null);assert.equal(saved.campaigns[0].impressions,null);
 assert.equal(saved.products[0].stock,0);assert.equal(saved.products[0].orderedUnits,14);assert.equal(saved.products[0].clicks,null);assert.equal(saved.products[0].drr,null);
 const changed=fixture();changed.accounts[0].name='Must roll back';changed.campaigns[0].observedAt='2026-09-21T12:00:00Z';await assert.rejects(importObservations(pool,changed),{code:'STALE_XWAY_OBSERVATION'});assert.equal((await reader.read()).accounts[0].name,'Synthetic account');
 const broken=fixture();broken.settings[0].accountKey='missing';await assert.rejects(importObservations(pool,broken));assert.equal((await reader.read()).settings.length,1);
 const columns=(await pool.query("SELECT data_type FROM information_schema.columns WHERE table_schema='pult_xway'")).rows;assert.ok(columns.every(row=>!['json','jsonb','bytea'].includes(row.data_type)));
 assert.ok(process.env.PULT_TEST_RESTRICTED_DATABASE_URL,'restricted test role must be provisioned');
 const role=new URL(process.env.PULT_TEST_RESTRICTED_DATABASE_URL).username;assert.match(role,/^pult_test_[a-f0-9]+_app$/u);
 await pool.query(`GRANT USAGE ON SCHEMA pult_xway TO "${role}";GRANT SELECT ON ALL TABLES IN SCHEMA pult_xway TO "${role}";`);
 const restricted=new Pool({connectionString:process.env.PULT_TEST_RESTRICTED_DATABASE_URL,max:1});t.after(()=>restricted.end());
 assert.equal((await createXwayReader({pool:restricted}).read()).campaigns.length,1);
 for(const sql of ["UPDATE pult_xway.accounts SET name='bad'","DELETE FROM pult_xway.campaigns","DELETE FROM pult_xway.products","INSERT INTO pult_xway.settings SELECT * FROM pult_xway.settings","CREATE TABLE pult_xway.forbidden(id int)"])await assert.rejects(restricted.query(sql),{code:'42501'});
});

test('XWAY optional product facts preserve zero stock and missing values',()=>{
 const input=fixture();assert.deepEqual(normalize(input).products,[]);
 input.products=[{accountKey:'test-account',key:'product-1',name:'Product',stock:0,orderedUnits:0,totalDrr:0,...observation}];
 const product=normalize(input).products[0];assert.equal(product.stock,0);assert.equal(product.orders,null);assert.equal(product.totalDrr,null);
 for(const mutate of [v=>v.products[0].stock=-1,v=>v.products[0].stock=0.5,v=>v.products[0].orderedUnits='12',v=>v.products[0].token='secret',v=>v.products.push(v.products[0]),v=>v.products=null]){const value=structuredClone(input);mutate(value);assert.throws(()=>normalize(value),{code:'INVALID_XWAY_IMPORT'});}
});
