'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPerformanceAcquisition,mapLinks}=require('../storage/acquisition/postgres-performance-acquisition.cjs');
const COMMAND='11111111-1111-4111-8111-111111111111',VERSION='22222222-2222-4222-8222-222222222222';
function fixture(overrides={}){const calls=[],repository={getCredentials:async()=>({credentialVersion:VERSION}),beginRefresh:async value=>calls.push(['begin',value]),commitRefresh:async value=>(calls.push(['commit',value]),{committed:true,revision:'1',status:'done',count:value.products.length+value.statistics.length,errorCodes:[]}),resolveRefresh:async()=>null,failRefresh:async(...value)=>calls.push(['fail',...value])},transport={listCampaigns:async()=>[{id:'7',title:'Campaign',state:'CAMPAIGN_STATE_RUNNING',paymentType:'CPC',productAutopilotStrategy:'TARGET_BIDS',updatedAt:'2026-09-24T00:00:00Z'}],listCampaignProducts:async()=>[{sku:'101',bid:'12500000'}],getCompetitiveBids:async()=>[{sku:'101',bid:'13750000'}],getMinimumBids:async()=>[{sku:'101',bid:3.5}],getSkuStatistics:async(_store,input)=>{calls.push(['stats',input]);return[{campaignId:'7',sku:'101',date:'2026-09-23',views:'100',clicks:'10',orders:'2',expense:'25.50',sales:'200'}]}},api=createPerformanceAcquisition({repository:{...repository,...overrides.repository},transport:{...transport,...overrides.transport},storesRepository:{protectedStore:async()=>({market:'Ozon'})},sourceProviders:{getProducts:async()=>[{product_id:'42',sku:'101'}]},now:()=>new Date('2026-09-24T09:00:00Z')});return{api,calls}}
test('SKU links are store-local and ambiguity blocks automatic mapping',()=>{assert.deepEqual(mapLinks([{product_id:'1',sku:'10'},{product_id:'2',sources:[{sku:'10'}]}],['10','11']),[{sku:'10',product_id:null,status:'ambiguous'},{sku:'11',product_id:null,status:'unmapped'}])});
test('refresh preserves every undocumented bid unit as raw and blocks normalization',async()=>{const f=fixture(),result=await f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND});assert.equal(result.status,'done');const saved=f.calls.find(row=>row[0]==='commit')[1];assert.equal(saved.products[0].current_bid,null);assert.equal(saved.products[0].competitive_bid,null);assert.equal(saved.products[0].minimum_bid,null);assert.equal(saved.products[0].current_bid_raw,'12500000');assert.equal(saved.products[0].competitive_bid_raw,'13750000');assert.equal(saved.products[0].current_bid_raw_unit,'OZON_CPC_BID_UNSPECIFIED');assert.equal(saved.products[0].minimum_bid_raw,'3.5');assert.equal(saved.products[0].minimum_bid_raw_unit,'OZON_CPC_MIN_BID_UNSPECIFIED');assert.equal(saved.products[0].status,'unsupported_bid_unit');assert.equal(saved.products[0].product_id,'42');assert.deepEqual(saved.statistics[0],{campaign_id:'7',sku:'101',stat_date:'2026-09-23',impressions:'100',clicks:'10',orders:'2',spend:'25.50',revenue:'200',order_basis:'ATTRIBUTED_ORDERS',complete:true});assert.deepEqual(f.calls.find(row=>row[0]==='stats')[1],{campaignIds:['7'],from:'2026-09-10',to:'2026-09-23'})});
test('malformed store response fails one store with a safe code and never commits partial replacement',async()=>{const secret='upstream-secret',f=fixture({transport:{listCampaignProducts:async()=>{throw Object.assign(Error(secret),{code:'MALFORMED_RESPONSE'})}}});await assert.rejects(f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND}),error=>error.code==='PERFORMANCE_INVALID_RESPONSE'&&!error.message.includes(secret));assert.equal(f.calls.some(row=>row[0]==='commit'),false);assert.equal(f.calls.some(row=>row[0]==='fail'),true)});
test('missing credentials stops before external requests',async()=>{let external=0;const f=fixture({repository:{getCredentials:async()=>null},transport:{listCampaigns:async()=>{external++}}});await assert.rejects(f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND}),{code:'MISSING_CREDENTIALS'});assert.equal(external,0)});

test('refresh replay resolves the receipt before any external request and preserves expected revision', async () => {
  const receipt={committed:true,revision:'3',status:'done',count:1,errorCodes:[]};let external=0;
  const f=fixture({repository:{resolveRefresh:async input=>{assert.equal(input.expectedRevision,'2');return receipt}},transport:{listCampaigns:async()=>{external++;return[]}}});
  assert.deepEqual(await f.api.refresh({storeId:'1',expectedRevision:'2',commandId:COMMAND}),{...receipt,replayed:true});assert.equal(external,0);assert.deepEqual(f.calls,[]);
  const normal=fixture();await normal.api.refresh({storeId:'1',expectedRevision:'5',commandId:COMMAND});
  assert.equal(normal.calls.find(row=>row[0]==='begin')[1].expectedRevision,'5');assert.equal(normal.calls.find(row=>row[0]==='commit')[1].expectedRevision,'5');
});

test('incomplete, impossible, foreign and invalid-date statistics cannot replace a complete snapshot', async () => {
  const base={campaignId:'7',sku:'101',date:'2026-09-23',views:'100',clicks:'10',orders:'2',expense:'25.50',sales:'200'};
  for(const patch of [{expense:null},{orders:'11'},{campaignId:'999'},{date:'2026-09-31'},{date:'2026-09-24'}]){
    const f=fixture({transport:{getSkuStatistics:async()=>[{...base,...patch}]}});
    await assert.rejects(f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND}),{code:'PERFORMANCE_INVALID_RESPONSE'});assert.equal(f.calls.some(row=>row[0]==='commit'),false);
  }
});

test('uncertain COMMIT is resolved with the same command rather than marked as a failed refresh', async () => {
  const f=fixture({repository:{commitRefresh:async()=>{throw Object.assign(Error('connection lost'),{code:'OUTCOME_UNKNOWN'})}}});
  await assert.rejects(f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND}),{code:'OUTCOME_UNKNOWN'});
  assert.equal(f.calls.some(row=>row[0]==='fail'),false);
});


test('historical SKU statistics survive removal from the current campaign product list', async () => {
  const f=fixture({transport:{getSkuStatistics:async()=>[{campaignId:'7',sku:'999',date:'2026-09-23',views:'100',clicks:'10',orders:'2',expense:'25.50',sales:'200'}]}});
  await f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND});
  assert.equal(f.calls.find(row=>row[0]==='commit')[1].statistics[0].sku,'999');
});

test('live PascalCase and legacy camelCase campaign types acquire the same CPC products and statistics', async t => {
  for(const fields of [{PaymentType:'CPC',advObjectType:'SKU'},{paymentType:'CPC'},{paymentType:'CPC',PaymentType:'CPC',advObjectType:'SKU'},{paymentType:null,PaymentType:'CPC',advObjectType:'SKU'}]){
    await t.test(JSON.stringify(fields), async () => {
      const productRequests=[],competitiveRequests=[],minimumRequests=[];
      const f=fixture({transport:{
        listCampaigns:async()=>[{id:'7',title:'Campaign',state:'CAMPAIGN_STATE_RUNNING',...fields}],
        listCampaignProducts:async(storeId,campaignId)=>{productRequests.push({storeId,campaignId});return[{sku:'101',bid:'12500000'}]},
        getCompetitiveBids:async(storeId,campaignId,skus)=>{competitiveRequests.push({storeId,campaignId,skus});return[{sku:'101',bid:'13750000'}]},
        getMinimumBids:async(storeId,skus,options)=>{minimumRequests.push({storeId,skus,options});return[{sku:'101',bid:3.5}]}
      }});
      await f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND});
      const saved=f.calls.find(row=>row[0]==='commit')[1];
      assert.equal(saved.campaigns[0].payment_type,'CPC');
      assert.deepEqual(productRequests,[{storeId:'1',campaignId:'7'}]);
      assert.deepEqual(competitiveRequests,[{storeId:'1',campaignId:'7',skus:['101']}]);
      assert.deepEqual(minimumRequests,[{storeId:'1',skus:['101'],options:{marketplaceId:'MARKETPLACE_ID_RU',paymentType:'CPC'}}]);
      assert.equal(saved.products.length,1);assert.equal(saved.statistics.length,1);
      assert.equal(saved.products[0].product_id,'42');assert.equal(saved.products[0].current_bid_raw,'12500000');
      assert.equal(saved.products[0].current_bid,null);assert.equal(saved.products[0].status,'unsupported_bid_unit');
      assert.deepEqual(f.calls.find(row=>row[0]==='stats')[1].campaignIds,['7']);
    });
  }
});

test('missing, conflicting and malformed campaign types cannot replace a prior snapshot', async t => {
  const cases=[{}, {advObjectType:'SKU'}, {paymentType:null,PaymentType:null,advObjectType:'SKU'},
    {paymentType:'CPC',PaymentType:'CPM'}, {paymentType:'CPM',PaymentType:'CPC'},
    {paymentType:7,PaymentType:'CPC'}, {paymentType:'',PaymentType:'CPC'}, {PaymentType:'   '},
    {PaymentType:'CPC',advObjectType:'BANNER'}, {PaymentType:'CPC',advObjectType:null}];
  for(const fields of cases){
    await t.test(JSON.stringify(fields), async () => {
      let detailRequests=0;
      const unexpected=async()=>{detailRequests++;return[]};
      const f=fixture({transport:{listCampaigns:async()=>[{id:'7',PaymentType:'CPC',advObjectType:'SKU'},{id:'8',...fields}],listCampaignProducts:unexpected,getCompetitiveBids:unexpected,getMinimumBids:unexpected,getSkuStatistics:unexpected}});
      await assert.rejects(f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND}),{code:'PERFORMANCE_INVALID_RESPONSE'});
      assert.equal(detailRequests,0);assert.equal(f.calls.some(row=>row[0]==='commit'),false);
      assert.equal(f.calls.filter(row=>row[0]==='fail').length,1);
    });
  }
});

test('only normalized CPC campaigns enter product and statistics requests in a mixed response', async () => {
  const productRequests=[];
  const f=fixture({transport:{
    listCampaigns:async()=>[{id:'7',state:'CAMPAIGN_STATE_RUNNING',PaymentType:'CPC',advObjectType:'SKU'},{id:'8',state:'CAMPAIGN_STATE_RUNNING',paymentType:'CPM',advObjectType:'SKU'},{id:'9',state:'CAMPAIGN_STATE_RUNNING',PaymentType:'CPO',advObjectType:'SKU'}],
    listCampaignProducts:async(_store,campaignId)=>{productRequests.push(campaignId);return[{sku:'101',bid:'12500000'}]}
  }});
  await f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND});
  const saved=f.calls.find(row=>row[0]==='commit')[1];
  assert.deepEqual(saved.campaigns.map(row=>row.payment_type),['CPC','CPM','CPO']);
  assert.deepEqual(productRequests,['7']);assert.deepEqual(f.calls.find(row=>row[0]==='stats')[1].campaignIds,['7']);
  assert.deepEqual(saved.products.map(row=>row.campaign_id),['7']);assert.deepEqual(saved.statistics.map(row=>row.campaign_id),['7']);
});

test('running and inactive CPC campaigns are queried while archived campaigns only keep metadata', async () => {
  const productRequests=[],statisticsRequests=[];
  const f=fixture({transport:{
    listCampaigns:async()=>[
      {id:'7',title:'Running',state:'CAMPAIGN_STATE_RUNNING',PaymentType:'CPC',advObjectType:'SKU'},
      {id:'8',title:'Inactive',state:'CAMPAIGN_STATE_INACTIVE',PaymentType:'CPC',advObjectType:'SKU'},
      {id:'19581092',title:'Archived',state:'CAMPAIGN_STATE_ARCHIVED',PaymentType:'CPC',advObjectType:'SKU'}
    ],
    listCampaignProducts:async(_store,campaignId)=>{productRequests.push(campaignId);return[{sku:'101',bid:'12500000'}]},
    getSkuStatistics:async(_store,input)=>{statisticsRequests.push(input);return[{campaignId:'7',sku:'101',date:'2026-09-23',views:'100',clicks:'10',orders:'2',expense:'25.50',sales:'200'}]}
  }});
  await f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND});
  const saved=f.calls.find(row=>row[0]==='commit')[1];
  assert.deepEqual(saved.campaigns.map(row=>({id:row.campaign_id,state:row.state,active:row.active})),[
    {id:'7',state:'CAMPAIGN_STATE_RUNNING',active:true},
    {id:'8',state:'CAMPAIGN_STATE_INACTIVE',active:false},
    {id:'19581092',state:'CAMPAIGN_STATE_ARCHIVED',active:false}
  ]);
  assert.deepEqual(productRequests,['7','8']);
  assert.equal(statisticsRequests.length,1);assert.deepEqual(statisticsRequests[0].campaignIds,['7','8']);
  assert.deepEqual(saved.products.map(row=>row.campaign_id),['7','8']);assert.deepEqual(saved.statistics.map(row=>row.campaign_id),['7']);
});

test('an archived-only snapshot commits campaign metadata without detail or statistics requests', async () => {
  let detailRequests=0,statisticsRequests=0;
  const f=fixture({transport:{
    listCampaigns:async()=>[
      {id:'19581092',title:'Archived CPC',state:'CAMPAIGN_STATE_ARCHIVED',PaymentType:'CPC',advObjectType:'SKU'},
      {id:'19581093',title:'Archived CPM',state:'CAMPAIGN_STATE_ARCHIVED',PaymentType:'CPM',advObjectType:'SKU'}
    ],
    listCampaignProducts:async()=>{detailRequests++;throw Error('archived detail must not be requested')},
    getSkuStatistics:async()=>{statisticsRequests++;throw Error('archived statistics must not be requested')}
  }});
  await f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND});
  const saved=f.calls.find(row=>row[0]==='commit')[1];
  assert.equal(detailRequests,0);assert.equal(statisticsRequests,0);
  assert.deepEqual(saved.campaigns.map(row=>row.campaign_id),['19581092','19581093']);
  assert.deepEqual(saved.products,[]);assert.deepEqual(saved.statistics,[]);assert.deepEqual(saved.links,[]);
});

test('unknown campaign states keep metadata and make no detail or statistics requests', async () => {
  let detailRequests=0,statisticsRequests=0;
  const f=fixture({transport:{
    listCampaigns:async()=>[{id:'10',title:'Future state',state:'CAMPAIGN_STATE_FUTURE',PaymentType:'CPC',advObjectType:'SKU'}],
    listCampaignProducts:async()=>{detailRequests++;return[]},
    getSkuStatistics:async()=>{statisticsRequests++;return[]}
  }});
  await f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND});
  const saved=f.calls.find(row=>row[0]==='commit')[1];
  assert.equal(detailRequests,0);assert.equal(statisticsRequests,0);
  assert.deepEqual(saved.campaigns.map(row=>({id:row.campaign_id,state:row.state})),[{id:'10',state:'CAMPAIGN_STATE_FUTURE'}]);
  assert.deepEqual(saved.products,[]);assert.deepEqual(saved.statistics,[]);
});

test('empty and explicitly non-CPC campaign lists make no CPC detail or statistics requests', async () => {
  for(const campaigns of [[],[{id:'8',PaymentType:'CPM',advObjectType:'SKU'},{id:'9',paymentType:'CPO'}]]){
    let detailRequests=0;
    const unexpected=async()=>{detailRequests++;return[]};
    const f=fixture({transport:{listCampaigns:async()=>campaigns,listCampaignProducts:unexpected,getCompetitiveBids:unexpected,getMinimumBids:unexpected,getSkuStatistics:unexpected}});
    await f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND});
    const saved=f.calls.find(row=>row[0]==='commit')[1];
    assert.equal(detailRequests,0);assert.equal(saved.campaigns.length,campaigns.length);
    assert.deepEqual(saved.products,[]);assert.deepEqual(saved.statistics,[]);
  }
});

test('statistics from an excluded non-CPC campaign fail the normalized scope check', async () => {
  const f=fixture({transport:{
    listCampaigns:async()=>[{id:'7',state:'CAMPAIGN_STATE_RUNNING',PaymentType:'CPC',advObjectType:'SKU'},{id:'8',state:'CAMPAIGN_STATE_RUNNING',PaymentType:'CPM',advObjectType:'SKU'}],
    getSkuStatistics:async()=>[{campaignId:'8',sku:'101',date:'2026-09-23',views:'100',clicks:'10',orders:'2',expense:'25.50',sales:'200'}]
  }});
  await assert.rejects(f.api.refresh({storeId:'1',expectedRevision:'0',commandId:COMMAND}),{code:'PERFORMANCE_INVALID_RESPONSE'});
  assert.equal(f.calls.some(row=>row[0]==='commit'),false);
});
