'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {summarize} = require('../summary.cjs');
const {encodeJson} = require('../storage/postgres-json-repository.cjs');
const {createLiveMarketRepository, createLiveMarketWriter} = require('../storage/postgres-live-market.cjs');

const source = {
  clientId: '1', market: 'Ozon', store: 'One', completedAt: '2026-09-22T10:00:00Z', period: {from: '2026-09-01', to: '2026-09-22'}, sections: {finance: {ok: true}},
  products: [{product_id: 10, sku: 20, offer_id: 'A', name: 'P'}], stocks: [{product_id: 10, offer_id: 'A', stocks: [{sku: 20, warehouse: 'W'}]}],
  operations: [{operation_id: 1, date: '2026-09-22', operation_type: 'Sale', amount: 1.25, total_amount: {currency: 'RUB', amount: '1.25'}, posting: {products: [{sku: 20}]}, privateNested: {large: true}},{operation_id:2,sellerOperName:'Return',amount:0,currency:null,rrDate:'2026-09-21',total_amount:null},{operation_id:3,docTypeName:'WB sale',amount:-2.345,saleDt:'2026-09-20'}],
  stockRows: [{sku: 20}], categoryTree: [{description_category_id: 1}]
};

test('live market repository reconstructs full data and projects summary finance fields', async () => {
  const calls = [], rows = Object.fromEntries(['products','stocks','operations'].map(name => [name, source[name].map(value => ({value}))]));
  const liveSources = {
    async record(path, options) {
      calls.push({path, options});
      if (!options) return {value: structuredClone(source)};
      const value = Object.fromEntries(Object.entries(source).filter(([, child]) => !Array.isArray(child)));
      for (const name of options.entities) value[name] = structuredClone(source[name]);
      return {value};
    },
    repository: {
      async getHead() { return {revision: 1, entityCounts: {products: 1, stocks: 1, operations: 3}}; },
      async listRows({entityType}) { return {rows: rows[entityType], total: rows[entityType].length}; }
    }
  };
  const repository = createLiveMarketRepository({liveSources});
  assert.deepEqual(await repository.getSnapshot('1'), source);
  const summary = await repository.getSummarySnapshot('1');
  assert.equal(summary.operations[0].privateNested, undefined);
  assert.deepEqual(summary.operations[0].total_amount, {currency: 'RUB'});
  assert.deepEqual(summarize(summary), summarize(source));
  assert.deepEqual(calls[1].options.entities, ['products','stocks','operations']);
  assert.deepEqual((await repository.products({storeId: '1', sku: '20'})).rows, source.products);
  assert.deepEqual((await repository.operations({storeId: '1', from: '2026-09-22', to: '2026-09-22', sku: '20'})).rows, [source.operations[0]]);
});

test('SQL summary reads a consistent head and projects operations before PostgreSQL transfer',async()=>{
  const metadata=require('../storage/postgres-live-codecs.cjs').encode('data-1.json',source).metadata,statements=[],client={async query(sql,args){statements.push(sql);if(sql.startsWith('BEGIN')||sql==='COMMIT')return{rows:[]};if(sql.includes('FROM pult_live.heads'))return{rows:[{revision:1,metadata,entity_counts:{products:1,stocks:1,operations:3}}]};if(sql.includes("entity_type=ANY"))return{rows:[{entity_type:'products',value:source.products[0]},{entity_type:'stocks',value:source.stocks[0]}]};if(sql.includes("entity_type='operations'"))return{rows:[{value:{date:'2026-09-22',operation_type:'Sale',amount:1.25,total_amount:{currency:'RUB'}}},{value:{sellerOperName:'Return',amount:0,currency:null,rrDate:'2026-09-21',total_amount:null}},{value:{docTypeName:'WB sale',amount:-2.345,saleDt:'2026-09-20'}}]};throw Error(String(args))},release(){statements.push('release')}};
  const liveSources={record:async()=>({value:source}),repository:{listRows(){},getHead(){}}},repo=createLiveMarketRepository({liveSources,pool:{async connect(){return client}}}),value=await repo.getSummarySnapshot('1');
  assert.deepEqual(summarize(value),summarize(source));assert.equal(value.operations[0].privateNested,undefined);assert.ok(statements.some(sql=>sql.includes("value->'amount'")));assert.equal(statements.includes('COMMIT'),true);assert.equal(statements.at(-1),'release');
});

test('live market writer preserves CAS receipts, source evidence and acquisition replay shape', async () => {
  let current = null, revision = 0,documentReceiptReads=0; const commands = new Map();
  const liveSources = {repository:{async readCommand({commandId}){const row=commands.get(commandId);return row?{afterHead:{revision:Number(row.after.revision),sourceMetadata:{sourceSha256:row.after.sha256}}}:null}},document() { return {
    async compareAndSet(value, {expectedRevision, commandId}) {
      if (commands.has(commandId)) return {revision: commands.get(commandId).after.revision, replayed: true};
      assert.equal(String(expectedRevision), String(revision));
      const before = current ? {revision: String(revision), value: structuredClone(current.value), sha256: current.sha256} : {revision: '0', value: null, sha256: null};
      revision++; const bytes = encodeJson(value, 480 * 1024 * 1024), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      current = {revision: String(revision), value: structuredClone(value), sha256}; const receipt = {before, after: structuredClone(current)}; commands.set(commandId, receipt);
      return {revision: String(revision), replayed: false};
    },
    async readCommand(commandId) { documentReceiptReads++;return structuredClone(commands.get(commandId) || null); }
  }; }};
  const writer = createLiveMarketWriter({liveSources}), input = Buffer.from('  ' + JSON.stringify(source) + '\n'), commandId = 'market-command';
  const first = await writer.publish({storeId: '1', exactBytes: input, expectedRevision: '0', commandId});
  assert.equal(documentReceiptReads,0);
  assert.deepEqual(first, {revision: '1', replayed: false, snapshotId: 'live:1:1', sha256: crypto.createHash('sha256').update(input).digest('hex'), sourceSha256: current.sha256});
  const replay = await writer.publish({storeId: '1', exactBytes: input, expectedRevision: '0', commandId});
  assert.equal(replay.replayed, true); assert.equal(replay.sourceSha256, first.sourceSha256);assert.equal(documentReceiptReads,0);
  const receipt = await writer.readCommand({storeId: '1', commandId});
  assert.equal(receipt.beforeRevision, '0'); assert.equal(receipt.snapshotId, 'live:1:1'); assert.deepEqual(JSON.parse(receipt.exactBytes), source);
  assert.equal(crypto.createHash('sha256').update(receipt.exactBytes).digest('hex'), receipt.sourceSha256);
  await assert.rejects(writer.publish({storeId: '2', exactBytes: Buffer.from(JSON.stringify(source)), expectedRevision: '0', commandId: 'other'}), {code: 'STORE_MISMATCH'});
});
