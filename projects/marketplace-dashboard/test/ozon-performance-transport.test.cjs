'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createOzonPerformanceTransport,createPerformanceTransport}=require('../storage/acquisition/ozon-performance-transport.cjs');
const creds=(storeId='1')=>({storeId,clientId:`client-${storeId}`,clientSecret:`secret-${storeId}-fixture`});
const token=(name='token')=>Response.json({access_token:`${name}-0123456789abcdef`,expires_in:1800,token_type:'Bearer'});
test('token acquisition is cached, single-flight, expires, and isolated per store',async()=>{let clock=0,calls=0;const api=createOzonPerformanceTransport({now:()=>clock,fetchFn:async url=>{assert.equal(new URL(url).pathname,'/api/client/token');calls++;await new Promise(r=>setImmediate(r));return token('t'+calls)}});const [a,b]=await Promise.all([api.acquireToken(creds('1')),api.acquireToken(creds('1'))]);assert.equal(a,b);assert.equal(calls,1);await api.acquireToken(creds('2'));assert.equal(calls,2);clock=1800*1000;await api.acquireToken(creds('1'));assert.equal(calls,3)});
test('one 401 invalidates token and retries the read once',async()=>{let tokens=0,reads=0;const api=createOzonPerformanceTransport({fetchFn:async(input,options)=>{const path=new URL(input).pathname;if(path==='/api/client/token'){tokens++;return token('t'+tokens)}reads++;assert.match(options.headers.Authorization,/^Bearer /u);return reads===1?new Response('{}',{status:401}):Response.json({list:[]})}});assert.deepEqual(await api.listCampaigns(creds()),[]);assert.equal(tokens,2);assert.equal(reads,2)});
test('403 is terminal and errors never include credentials',async()=>{const secret=creds().clientSecret,api=createOzonPerformanceTransport({fetchFn:async input=>new URL(input).pathname==='/api/client/token'?token():new Response(JSON.stringify({error:secret}),{status:403})});await assert.rejects(api.listCampaigns(creds()),error=>error.code==='AUTH_FORBIDDEN'&&!error.message.includes(secret))});
test('429 preserves Retry-After without sleeping a long-running scheduler job',async()=>{const waits=[],api=createOzonPerformanceTransport({sleep:async ms=>waits.push(ms),fetchFn:async input=>new URL(input).pathname==='/api/client/token'?token():new Response('{}',{status:429,headers:{'Retry-After':'120'}})});await assert.rejects(api.listCampaigns(creds()),error=>error.code==='RATE_LIMITED'&&error.retryAfterMs===120000);assert.deepEqual(waits,[])});
test('campaign and product pagination stop at the real short page',async()=>{const pages=[];const api=createOzonPerformanceTransport({fetchFn:async input=>{const u=new URL(input);if(u.pathname==='/api/client/token')return token();pages.push([u.pathname,u.searchParams.get('page')]);const field=u.pathname==='/api/client/campaign'?'list':'products',page=Number(u.searchParams.get('page'));return Response.json({[field]:page===1?Array.from({length:100},(_,i)=>({id:String(i+1),sku:String(i+1)})):[{id:'101',sku:'101'}]})}});assert.equal((await api.listCampaigns(creds())).length,101);assert.equal((await api.listCampaignProducts(creds(),'7')).length,101);assert.deepEqual(pages.map(x=>x[1]),['1','2','1','2'])});
test('competitive/minimum and statistics calls use documented batch bounds',async()=>{const seen=[];const api=createOzonPerformanceTransport({fetchFn:async(input,options)=>{const u=new URL(input);if(u.pathname==='/api/client/token')return token();seen.push({path:u.pathname,skus:u.searchParams.getAll('skus'),body:options.body&&JSON.parse(options.body)});if(u.pathname.endsWith('/competitive'))return Response.json({bids:u.searchParams.getAll('skus').map(sku=>({sku,bid:'1000000'}))});if(u.pathname==='/api/client/min/sku')return Response.json({minBids:JSON.parse(options.body).sku.map(sku=>({sku,bid:1}))});return Response.json({rows:[]})}}),skus=Array.from({length:450},(_,i)=>String(i+1)),campaigns=Array.from({length:21},(_,i)=>String(i+1));assert.equal((await api.listCompetitiveBids(creds(),'7',skus)).length,450);assert.equal((await api.listMinimumBids(creds(),skus)).length,450);await api.getSkuStatistics(creds(),campaigns,{dateFrom:'2026-09-01',dateTo:'2026-09-02'});assert.deepEqual(seen.filter(x=>x.path.endsWith('/competitive')).map(x=>x.skus.length),[200,200,50]);assert.deepEqual(seen.filter(x=>x.path==='/api/client/min/sku').map(x=>x.body.sku.length),[200,200,50]);const statistics=seen.filter(x=>x.path==='/api/client/statistics/products/sku').map(x=>x.body);assert.deepEqual(statistics.map(x=>x.campaignIds.length),[10,10,1,10,10,1]);assert.deepEqual(statistics.map(x=>[x.dateFrom,x.dateTo]),[['2026-09-01','2026-09-01'],['2026-09-01','2026-09-01'],['2026-09-01','2026-09-01'],['2026-09-02','2026-09-02'],['2026-09-02','2026-09-02'],['2026-09-02','2026-09-02']])});

test('statistics split calendar boundaries into ordered one-day requests and preserve row order',async()=>{const requests=[];const api=createOzonPerformanceTransport({fetchFn:async(input,options)=>{if(new URL(input).pathname==='/api/client/token')return token();const body=JSON.parse(options.body);requests.push(body);return Response.json({rows:[{date:body.dateFrom,campaignId:body.campaignIds[0]}]})}});const rows=await api.getSkuStatistics(creds(),['2','1','2'],{dateFrom:'2024-02-28',dateTo:'2024-03-01'});assert.deepEqual(requests.map(x=>[x.dateFrom,x.dateTo,x.campaignIds]),[['2024-02-28','2024-02-28',['2','1']],['2024-02-29','2024-02-29',['2','1']],['2024-03-01','2024-03-01',['2','1']]]);assert.deepEqual(rows.map(x=>x.date),['2024-02-28','2024-02-29','2024-03-01'])});

test('statistics reject invalid calendar dates and reversed ranges before network access',async()=>{let calls=0;const api=createOzonPerformanceTransport({fetchFn:async()=>{calls++;return token()}});for(const period of [{dateFrom:'2026-02-29',dateTo:'2026-03-01'},{dateFrom:'2026-01-01',dateTo:'2025-12-31'},{dateFrom:'2026-1-01',dateTo:'2026-01-01'}])await assert.rejects(api.getSkuStatistics(creds(),['1'],period),{code:'INVALID_ARGUMENT'});assert.equal(calls,0)});

test('statistics fail closed when any daily response is incomplete or rejected',async()=>{for(const failure of ['malformed','upstream']){let reads=0;const api=createOzonPerformanceTransport({fetchFn:async input=>{if(new URL(input).pathname==='/api/client/token')return token();reads++;if(reads===2)return failure==='malformed'?Response.json({}):new Response('{}',{status:400});return Response.json({rows:[{day:reads}]})}});await assert.rejects(api.getSkuStatistics(creds(),['1'],{dateFrom:'2026-09-01',dateTo:'2026-09-02'}),failure==='malformed'?{code:'MALFORMED_RESPONSE'}:error=>error.code==='UPSTREAM_ERROR'&&error.status===400);assert.equal(reads,2)}});
test('malformed response and write-like paths fail closed',async()=>{const api=createOzonPerformanceTransport({fetchFn:async input=>new URL(input).pathname==='/api/client/token'?token():Response.json({unknown:[]})});await assert.rejects(api.listCampaigns(creds()),{code:'MALFORMED_RESPONSE'});await assert.rejects(api.request(creds(),'/api/client/campaign/1/products',{method:'POST',body:{bids:[]}}),{code:'READ_ONLY_VIOLATION'})});
test('credential-provider facade rejects missing credentials and exposes no raw request method',async()=>{const api=createPerformanceTransport({getCredentials:async()=>null,fetchFn:async()=>assert.fail('network must not run')});await assert.rejects(api.listCampaigns('1'),{code:'MISSING_CREDENTIALS'});assert.equal(api.request,undefined)});

test('401 followed by 5xx reuses the refreshed token during bounded retries', async () => {
  let tokens = 0, reads = 0; const waits = [];
  const api = createOzonPerformanceTransport({sleep: async ms => waits.push(ms), fetchFn: async input => {
    if (new URL(input).pathname === '/api/client/token') { tokens++; return token('t' + tokens); }
    reads++; return reads === 1 ? new Response('{}', {status: 401}) : reads === 2 ? new Response('{}', {status: 503}) : Response.json({list: []});
  }});
  assert.deepEqual(await api.listCampaigns(creds()), []);
  assert.equal(tokens, 2); assert.equal(reads, 3); assert.deepEqual(waits, [1000]);
});

test('long 503 Retry-After yields the job without blocking other stores', async () => {
  const waits = [];
  const api = createOzonPerformanceTransport({now: () => Date.parse('2026-09-24T09:00:00Z'), sleep: async ms => waits.push(ms), fetchFn: async input =>
    new URL(input).pathname === '/api/client/token' ? token() : new Response('{}', {status: 503, headers: {'Retry-After': 'Thu, 24 Sep 2026 09:30:00 GMT'}})});
  await assert.rejects(api.listCampaigns(creds()), error => error.code === 'UPSTREAM_ERROR' && error.retryAfterMs === 1800000);
  assert.deepEqual(waits, []);
});

test('oversized streaming responses are cancelled even without Content-Length', async () => {
  let cancelled = false;
  const api = createOzonPerformanceTransport({fetchFn: async input => {
    if (new URL(input).pathname === '/api/client/token') return token();
    return new Response(new ReadableStream({pull(controller) {controller.enqueue(new Uint8Array(1024 * 1024));}, cancel() {cancelled = true;}}));
  }});
  await assert.rejects(api.listCampaigns(creds()), {code: 'MALFORMED_RESPONSE'});
  assert.equal(cancelled, true);
});

test('overlapping pages deduplicate identities and conflicting records reject the whole snapshot', async () => {
  for (const conflict of [false, true]) {
    const api = createOzonPerformanceTransport({fetchFn: async input => {
      const url = new URL(input); if (url.pathname === '/api/client/token') return token();
      return Response.json({list: url.searchParams.get('page') === '1' ? Array.from({length: 100}, (_, i) => ({id: String(i + 1)})) : [{id: '100', ...(conflict ? {title: 'changed'} : {})}, {id: '101'}]});
    }});
    if (conflict) await assert.rejects(api.listCampaigns(creds()), {code: 'PAGINATION_FAILED'});
    else assert.equal((await api.listCampaigns(creds())).length, 101);
  }
});

test('reordered repeated full pages fail without exhausting the page bound', async () => {
  let pages = 0;
  const api = createOzonPerformanceTransport({fetchFn: async input => {
    if (new URL(input).pathname === '/api/client/token') return token();
    const list = Array.from({length: 100}, (_, i) => ({id: String(i + 1)})); pages++;
    return Response.json({list: pages === 1 ? list : list.reverse()});
  }});
  await assert.rejects(api.listCampaigns(creds()), {code: 'PAGINATION_FAILED'}); assert.equal(pages, 2);
});
