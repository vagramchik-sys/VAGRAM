'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOzonBuyerOrdersCollector } = require('../storage/acquisition/postgres-buyer-orders-collector.cjs');

const DAY = '2026-09-21', TIME = '2026-09-22T08:00:00.000Z';
function posting(suffix = '') { return { posting_number: `posting-${suffix || '1'}`, order_number: `order-${suffix || '1'}`, created_at: DAY + 'T10:00:00Z', status: 'awaiting_deliver', analytics_data: { is_legal: true }, products: [{ sku: suffix === 'fbs' ? 2 : 1, quantity: 2, price: '10.50', currency: 'RUB' }] }; }

test('collector uses bounded Ozon FBO/FBS pagination and produces one complete legacy-shaped day', async () => {
  const calls = [], pages = new Map();
  const api = async (store, key, route, body) => {
    assert.equal(key, 'synthetic-key'); calls.push({ store, route, body: structuredClone(body) });
    const count = pages.get(route) || 0; pages.set(route, count + 1);
    if (count === 0) return { result: { postings: [posting(route.includes('fbs') ? 'fbs' : 'fbo')], has_next: true, cursor: 'next' } };
    return { result: { postings: [], has_next: false, cursor: '' } };
  };
  const collector = createOzonBuyerOrdersCollector({ api, now: () => new Date(TIME) });
  const result = await collector.collect({ date: DAY, timestamp: TIME, targets: [{ storeId: '1', clientId: '1', name: 'Synthetic', key: 'synthetic-key' }] });
  assert.equal(result.status, 'collected'); assert.equal(result.records.length, 2); assert.equal(result.productOrders.length, 2);
  assert.deepEqual(result.report.coverage.sources.map(value => [value.scheme, value.complete]), [['FBO', false], ['FBS', true]]);
  assert.equal(result.report.coverage.complete,false);assert.match(result.report.coverage.sources[0].limitation,/времени обработки/u);
  assert.deepEqual(new Set(calls.map(value => value.route)), new Set(['/v3/posting/fbo/list', '/v4/posting/fbs/list']));
  assert.ok(calls.every(value => value.body.filter.since === '2026-09-20T21:00:00.000Z' && value.body.filter.to === '2026-09-21T20:59:59.999Z'));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key/u);
});

test('FBO rows selected by in_process_at but created outside the day are safely omitted',async()=>{
  const target=[{storeId:'1',clientId:'1',name:'Synthetic',key:'synthetic-key'}],inside=posting('inside'),outside={...posting('outside'),created_at:'2026-09-23T10:00:00Z',in_process_at:DAY+'T10:00:00Z'};
  const collector=createOzonBuyerOrdersCollector({api:async(_store,_key,route)=>({result:{postings:route.includes('/fbo/')?[inside,outside]:[posting('fbs')],has_next:false}}),now:()=>new Date(TIME)});
  const result=await collector.collect({date:DAY,timestamp:TIME,targets:target}),fbo=result.report.coverage.sources.find(source=>source.scheme==='FBO');
  assert.equal(result.status,'collected');assert.equal(result.report.status,'partial');assert.equal(result.records.length,2);assert.equal(result.productOrders.length,2);
  assert.equal(fbo.available,true);assert.equal(fbo.complete,false);assert.match(fbo.limitation,/created_at вне выбранного дня/u);
  assert.ok(result.records.every(row=>row.createdAt.startsWith(DAY)));assert.ok(result.productOrders.every(row=>row.orderedAt.startsWith(DAY)));
});

test('collector rejects unstable pagination and out-of-period source rows without a partial success', async () => {
  const target = [{ storeId: '1', clientId: '1', name: 'Synthetic', key: 'synthetic-key' }];
  const repeated = createOzonBuyerOrdersCollector({ api: async () => ({ result: { postings: [posting()], has_next: true, cursor: 'same' } }), now: () => new Date(TIME) });
  await assert.rejects(repeated.collect({ date: DAY, timestamp: TIME, targets: target }), { code: 'SOURCE_PAGINATION' });
  const outside = createOzonBuyerOrdersCollector({ api: async () => ({ result: { postings: [{ ...posting(), created_at: '2026-09-19T10:00:00Z' }], has_next: false } }), now: () => new Date(TIME) });
  await assert.rejects(outside.collect({ date: DAY, timestamp: TIME, targets: target }), { code: 'OUT_OF_PERIOD' });
  const invalid = createOzonBuyerOrdersCollector({ api: async () => ({ result: { postings: [{ ...posting(), created_at: 'invalid', in_process_at: DAY+'T10:00:00Z' }], has_next: false } }), now: () => new Date(TIME) });
  await assert.rejects(invalid.collect({ date: DAY, timestamp: TIME, targets: target }), { code: 'SOURCE_SCHEMA' });
});



