'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { options, execute } = require('../scripts/collect-pult-postgres-buyers.cjs');
test('operator requires explicit stable date and command metadata', () => {
  const args = ['--date','2026-09-21','--command-id','11111111-1111-4111-8111-111111111111','--timestamp','2026-09-22T08:00:00.000Z','--expected-revision','0'];
  assert.deepEqual(options(args), { date:'2026-09-21',commandId:'11111111-1111-4111-8111-111111111111',timestamp:'2026-09-22T08:00:00.000Z',expectedRevision:'0' });
  assert.throws(() => options(args.slice(0,-2)), { code:'INVALID_OPTIONS' });
  assert.throws(() => options([...args,'--unknown','x']), { code:'INVALID_OPTIONS' });
});


test('execute learns the day path and writes through the native live state adapter', async () => {
  const pool={endCalls:0,async end(){this.endCalls++}},learned=[],liveState={learn:path=>learned.push(path),read(){},write(){},remove(){},readCommand(){}},calls=[];
  const result=await execute({date:'2026-09-24'}, {
    poolFactory:async options=>(calls.push(['pool',options.profile]),pool),
    compositionFactory:async options=>(assert.equal(options.pool,pool),calls.push(['composition']),{stateStore:liveState}),
    collectorFactory:options=>(calls.push(['collector',typeof options.api]),{collect(){}}),
    snapshotFactory:options=>{assert.equal(options.stateStore,liveState);assert.equal(typeof options.storesRepository.read,'function');assert.equal(typeof options.decrypt,'function');calls.push(['snapshot']);return{run:async input=>({input,stateStore:options.stateStore})}},
    protectFn:value=>'clear:'+value,
    fetchFn:async()=>{}
  });
  assert.deepEqual(learned,['buyer-order-segments-2026-09-24_2026-09-24.json']);assert.equal(result.stateStore,liveState);assert.deepEqual(result.input,{date:'2026-09-24'});assert.deepEqual(calls.map(row=>row[0]),['pool','composition','collector','snapshot']);assert.equal(pool.endCalls,1);
});
