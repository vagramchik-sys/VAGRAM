'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createMarketAcquisition } = require('../storage/acquisition/postgres-market-acquisition.cjs');
const COMMAND = '11111111-1111-4111-8111-111111111111';
function dependencies(overrides = {}) { const calls = []; return { calls, values: { storesRepository: { protectedStore: async id => ({ name: 'S', clientId: id, key: 'opaque-dpapi' }) }, marketRepository: { getSnapshot: async () => ({ categoryTree: [{ old: true }] }) }, decrypt: async value => { calls.push(['decrypt', value]); return 'plain'; }, ozonCollector: { collect: async input => { calls.push(['collect', input]); return { snapshot: { clientId: '1', completedAt: '2026-09-22T10:00:00Z', products: [], stocks: [], operations: [], stockRows: [], categoryTree: [] }, status: 'done', errors: [] }; } }, wbCollector: { collect: async () => { throw Error('unused'); } }, marketWriter: { readCommand: async () => null, publish: async input => { calls.push(['publish', input]); return { revision: '2', replayed: false, snapshotId: 'snap' }; } }, ...overrides } }; }

test('coordinator passes the caller command/CAS once and publishes only after collection', async () => {
  const d = dependencies(), api = createMarketAcquisition(d.values), progress = [];
  const result = await api.acquire({ storeId: '1', expectedRevision: '1', commandId: COMMAND, onProgress: value => progress.push(value) });
  assert.equal(result.snapshotId, 'snap'); const publish = d.calls.find(row => row[0] === 'publish')[1];
  assert.equal(publish.commandId, COMMAND); assert.equal(publish.expectedRevision, '1'); assert.equal(JSON.parse(publish.exactBytes).clientId, '1');
  assert.deepEqual(d.calls.map(row => row[0]), ['decrypt', 'collect', 'publish']);
});

test('collector/decrypt/write failures never trigger a hidden publish retry', async () => {
  let publishes = 0; const failed = dependencies({ ozonCollector: { collect: async () => { throw Object.assign(Error('safe'), { code: 'NETWORK_ERROR' }); } }, marketWriter: { readCommand: async () => null, publish: async () => { publishes++; } } });
  await assert.rejects(createMarketAcquisition(failed.values).acquire({ storeId: '1', expectedRevision: '1', commandId: COMMAND }), { code: 'NETWORK_ERROR' }); assert.equal(publishes, 0);
  const uncertain = dependencies({ marketWriter: { readCommand: async () => null, publish: async () => { publishes++; throw Object.assign(Error('safe'), { code: 'OUTCOME_UNKNOWN' }); } } });
  await assert.rejects(createMarketAcquisition(uncertain.values).acquire({ storeId: '1', expectedRevision: '1', commandId: COMMAND }), { code: 'OUTCOME_UNKNOWN' }); assert.equal(publishes, 1);
});
test('committed command replay is resolved before decrypt or external collection',async()=>{let touched=false;const api=createMarketAcquisition({storesRepository:{protectedStore:async()=>{touched=true}},marketRepository:{getSnapshot:async()=>{touched=true}},decrypt:async()=>{touched=true},ozonCollector:{collect:async()=>{touched=true}},wbCollector:{collect:async()=>{touched=true}},marketWriter:{readCommand:async()=>({revision:'4',snapshotId:'snap',exactBytes:Buffer.from('{"completedAt":"2026-09-22T10:00:00Z","sections":{"products":{"ok":true}}}')}),publish:async()=>{touched=true}}});const result=await api.acquire({storeId:'1',expectedRevision:'0',commandId:COMMAND});assert.equal(result.replayed,true);assert.equal(touched,false);});
