'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const codecs = require('../storage/postgres-live-codecs.cjs');
const {encodeJson} = require('../storage/postgres-json-repository.cjs');
const {buildLedger} = require('../ledger.cjs');
const {summarize} = require('../summary.cjs');
const {createPostgresLiveLedgerRefresh} = require('../storage/acquisition/postgres-live-ledger-refresh.cjs');
const {createPostgresLiveRepository} = require('../storage/postgres-live-repository.cjs');
const {ensurePostgresLiveSchema} = require('../storage/postgres-live-schema.cjs');
const {createLiveSources} = require('../storage/postgres-live-sources.cjs');
const {createLiveMarketWriter,createLiveMarketRepository} = require('../storage/postgres-live-market.cjs');

const snapshot = () => ({clientId:'1',market:'Ozon',completedAt:'2026-09-22T10:00:00.000Z',period:{from:'2026-09-01',to:'2026-09-22'},sections:{finance:{ok:true}},products:[],stocks:[],operations:[{operation_id:'a',date:'2026-09-22',total_amount:{amount:'-5',currency:'RUB'},non_item_fee:{type_id:41,accrued:{amount:'-5',currency:'RUB'}}}],stockRows:[],categoryTree:[]});

function memorySources() {
  const states = new Map(), commands = new Map(); let rowReads = 0;
  function set(path, value) {
    const encoded = codecs.encode(path, value), previous = states.get(path), revision = (previous?.revision || 0) + 1, bytes = encodeJson(value, 480 * 1024 * 1024);
    states.set(path, {revision, encoded, sha256: crypto.createHash('sha256').update(bytes).digest('hex')}); return revision;
  }
  function asRecord(path, state, entities) {
    if (!state) return null; const collections = {};
    for (const name of entities ?? Object.keys(state.encoded.collections)) if (state.encoded.collections[name]) collections[name] = structuredClone(state.encoded.collections[name]);
    return {revision: String(state.revision), value: codecs.decode(path, {metadata: state.encoded.metadata, collections}, {partial: entities !== undefined}), sha256: state.sha256, head: {revision: state.revision, sourceMetadata: {sourceSha256: state.sha256}, entityCounts: Object.fromEntries(Object.entries(state.encoded.collections).map(([name, rows]) => [name, rows.length]))}};
  }
  const api = {
    set, get rowReads() { return rowReads; },
    async record(path, {entities} = {}) { return asRecord(path, states.get(path), entities); },
    repository: {async listRows({storeId, domain, entityType, expectedRevision, limit, after, includeTotal}) {
      assert.equal(domain, 'market'); const state = states.get(`data-${storeId}.json`); if (state.revision !== expectedRevision) throw Object.assign(Error('REVISION_CONFLICT'), {code:'REVISION_CONFLICT'});
      assert.equal(includeTotal,false);
      rowReads++; const rows = state.encoded.collections[entityType] || [], page = rows.filter(row=>!after||row.ordinal>after.sourceOrder).slice(0,limit).map(row => ({entityType,entityKey:row.key,occurrence:0,businessDay:row.day,sourceOrder:row.ordinal,value:structuredClone(row.value)}));
      return {rows: page, total: null};
    }},
    document(path, {validate}) { return {
      async read() { const state = states.get(path); if (!state) return null; const row = asRecord(path, state); if (!validate(row.value)) throw Object.assign(Error('CORRUPT_DOCUMENT'), {code:'CORRUPT_DOCUMENT'}); return row; },
      async readCommand(commandId) { return structuredClone(commands.get(path + ':' + commandId) || null); },
      async compareAndSet(value, {expectedRevision, commandId}) {
        const key = path + ':' + commandId; if (commands.has(key)) return {revision:String(commands.get(key).after.revision),replayed:true};
        if (!validate(value)) throw Object.assign(Error('INVALID_DOCUMENT'), {code:'INVALID_DOCUMENT'}); const beforeState = states.get(path), beforeRevision = String(beforeState?.revision || 0);
        if (beforeRevision !== String(expectedRevision)) throw Object.assign(Error('REVISION_CONFLICT'), {code:'REVISION_CONFLICT'});
        const before = beforeState ? asRecord(path, beforeState) : {revision:'0',value:null,sha256:null}; set(path, value); const after = asRecord(path, states.get(path)); commands.set(key, {before, after}); return {revision:after.revision,replayed:false};
      }
    }; }
  };
  return api;
}

test('live ledger refresh streams native operation rows, replays, and repairs A-B-A types', async () => {
  const sources = memorySources(), raw = snapshot(); sources.set('data-1.json', raw); sources.set('insights-1.json', {types:[],orders:{daily:[],skuDaily:[],skuCoverage:[]},errors:[]});
  sources.set('ledger-1.json',{stamp:raw.completedAt,source:{snapshotId:'old-snapshot',marketRevision:'1',marketSha256:'a'.repeat(64),typesSha256:'b'.repeat(64)},data:buildLedger(raw,[])});
  const refresh = createPostgresLiveLedgerRefresh({liveSources:sources,pageSize:1}), first = await refresh.ensure({storeId:'1'});
  assert.equal(first.replayed,false); assert.equal(sources.rowReads,2); assert.equal(first.source.sourceKind,'native-sql-rows');
  assert.deepEqual((await sources.record('ledger-1.json')).value.data,buildLedger(raw,[]));
  const replay = await refresh.ensure({storeId:'1'}); assert.equal(replay.replayed,true); assert.equal(replay.revision,first.revision);
  sources.set('insights-1.json',{types:[{id:41,name:'PayPerClick',description:'Ads'}],orders:{daily:[],skuDaily:[],skuCoverage:[]},errors:[]}); const second=await refresh.ensure({storeId:'1'}); assert.notEqual(second.revision,first.revision);
  sources.set('insights-1.json',{types:[],orders:{daily:[],skuDaily:[],skuCoverage:[]},errors:[]}); const third=await refresh.ensure({storeId:'1'}); assert.notEqual(third.revision,first.revision); assert.deepEqual((await sources.record('ledger-1.json')).value.data,buildLedger(raw,[]));
});

test('live ledger refresh accepts already collected snapshot only with matching native evidence', async () => {
  const sources=memorySources(),raw=snapshot();sources.set('data-1.json',raw);sources.set('insights-1.json',{types:[],orders:{daily:[],skuDaily:[],skuCoverage:[]},errors:[]});
  const market=await sources.record('data-1.json'),expectedSource={snapshotId:'live:1:'+market.revision,marketRevision:market.revision,sourceSha256:market.sha256};
  const refresh=createPostgresLiveLedgerRefresh({liveSources:sources,pageSize:1}),result=await refresh.ensure({storeId:'1',snapshot:raw,expectedSource});
  assert.equal(result.replayed,false);assert.equal(sources.rowReads,0);assert.deepEqual((await sources.record('ledger-1.json')).value.data,buildLedger(raw,[]));
});

test('streaming rejects understated source counts at an exact page boundary', async () => {
  const sources=memorySources(),raw=snapshot();raw.operations=Array.from({length:4},()=>structuredClone(raw.operations[0]));sources.set('data-1.json',raw);
  const understated={...sources,async record(path,options){const row=await sources.record(path,options);if(path==='data-1.json')row.head.entityCounts.operations=2;return row}};
  await assert.rejects(createPostgresLiveLedgerRefresh({liveSources:understated,pageSize:2}).ensure({storeId:'1'}),{code:'SOURCE_INTEGRITY'});
  assert.equal(sources.rowReads,2);
  assert.equal(await sources.record('ledger-1.json'),null);
});

test('live market and ledger adapters persist and replay in disposable PostgreSQL', {skip:!process.env.PULT_TEST_DATABASE_URL}, async t => {
  assert.match(decodeURIComponent(new URL(process.env.PULT_TEST_DATABASE_URL).pathname.slice(1)),/test/iu);
  const {Pool}=require('pg'),pool=new Pool({connectionString:process.env.PULT_TEST_DATABASE_URL,max:4});t.after(()=>pool.end());
  await ensurePostgresLiveSchema(pool);const repository=createPostgresLiveRepository({pool}),liveSources=createLiveSources({repository}),writer=createLiveMarketWriter({liveSources}),raw=snapshot(),bytes=Buffer.from(JSON.stringify(raw));
  const published=await writer.publish({storeId:'1',exactBytes:bytes,expectedRevision:'0',commandId:'market-1'});assert.equal(published.snapshotId,'live:1:1');
  await liveSources.document('insights-1.json').compareAndSet({types:[],orders:{daily:[],skuDaily:[],skuCoverage:[]},errors:[]},{expectedRevision:'0',commandId:'insights-1'});
  const market=createLiveMarketRepository({liveSources,pool});assert.deepEqual(await market.getSnapshot('1'),raw);assert.deepEqual(summarize(await market.getSummarySnapshot('1')),summarize(raw));
  const refresh=createPostgresLiveLedgerRefresh({liveSources,pageSize:1}),first=await refresh.ensure({storeId:'1',snapshot:raw,expectedSource:published}),second=await refresh.ensure({storeId:'1'});
  assert.equal(first.replayed,false);assert.equal(second.replayed,true);assert.deepEqual((await liveSources.record('ledger-1.json')).value.data,buildLedger(raw,[]));
  const command=await writer.readCommand({storeId:'1',commandId:'market-1'});assert.equal(command.beforeRevision,'0');assert.deepEqual(JSON.parse(command.exactBytes),raw);
  const multiple=snapshot();multiple.operations=Array.from({length:5},()=>structuredClone(raw.operations[0]));
  await liveSources.document('data-2.json').compareAndSet(multiple,{expectedRevision:'0',commandId:'market-2'});
  const pages=[],tracedSources=createLiveSources({repository:{...repository,async listRows(input){if(input.domain==='market')pages.push(input);return repository.listRows(input)}}});
  await createPostgresLiveLedgerRefresh({liveSources:tracedSources,pageSize:2}).ensure({storeId:'2'});
  assert.deepEqual((await liveSources.record('ledger-2.json')).value.data,buildLedger(multiple,[]));
  assert.deepEqual(pages.map(page=>page.after?.sourceOrder),[undefined,1,3]);
  assert.ok(pages.every(page=>page.includeTotal===false&&page.offset===undefined&&page.expectedRevision===1));
  await liveSources.document('data-3.json').compareAndSet(multiple,{expectedRevision:'0',commandId:'market-3'});
  let readPages=0;
  const racingSources=createLiveSources({repository:{...repository,async listRows(input){const page=await repository.listRows(input);if(input.storeId==='3'&&input.domain==='market'&&++readPages===1)await liveSources.document('data-3.json').compareAndSet(multiple,{expectedRevision:'1',commandId:'market-3-changed'});return page}}});
  await assert.rejects(createPostgresLiveLedgerRefresh({liveSources:racingSources,pageSize:2}).ensure({storeId:'3'}),{code:'REVISION_CONFLICT'});
  assert.equal(await liveSources.record('ledger-3.json'),null);
});
