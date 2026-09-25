'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createOptimizerRepository} = require('../storage/postgres-optimizer-repository.cjs');
const COMMAND = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-09-24T09:00:00Z';

// A transaction/lock protocol double, not a PostgreSQL SQL interpreter. It makes
// concurrent command interleavings deterministic and captures emitted SQL.
function database() {
  const state = {credentials: new Map(), settings: new Map(), refresh: new Map(), commands: new Map()};
  const locks = new Map(), queries = []; let failCommit = false;
  async function query(sql, args = [], held = []) {
    queries.push({sql, args});
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
      const prior = locks.get(args[0]) || Promise.resolve(); let unlock;
      const next = new Promise(resolve => {unlock = resolve;}); locks.set(args[0], next);
      await prior; held.push(() => {if (locks.get(args[0]) === next) locks.delete(args[0]); unlock();});
    } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      held.splice(0).reverse().forEach(unlock => unlock());
      if (sql === 'COMMIT' && failCommit) {failCommit = false; throw Error('socket lost after commit');}
    } else if (sql.startsWith('SELECT') && sql.includes('FROM "pult_optimizer"."commands"')) {
      const row = state.commands.get(args[0]); return {rows: row ? [row] : []};
    } else if (sql.startsWith('SELECT') && sql.includes('FROM "pult_optimizer"."credentials"')) {
      const row = state.credentials.get(args[0]); return {rows: row ? [row] : []};
    } else if (sql.startsWith('SELECT') && sql.includes('FROM "pult_optimizer"."settings"')) {
      const row = state.settings.get(args[0]); return {rows: row ? [row] : []};
    } else if (sql.startsWith('SELECT') && sql.includes('FROM "pult_optimizer"."refresh_state"')) {
      const row = state.refresh.get(args[0]); return {rows: row ? [row] : []};
    } else if (sql.startsWith('INSERT INTO "pult_optimizer"."credentials"')) {
      state.credentials.set(args[0], {credential_version: args[3], revision: args[4]});
    } else if (sql.startsWith('INSERT INTO "pult_optimizer"."settings"')) {
      state.settings.set(args[0], {revision: args[1], settings: JSON.parse(args[2])});
    } else if (sql.startsWith('INSERT INTO "pult_optimizer"."refresh_state"')) {
      const starting = sql.includes("'running'");
      state.refresh.set(args[0], {revision: starting ? (state.refresh.get(args[0])?.revision || '0') : args[1],
        credential_version: starting ? args[1] : args[2], status: starting ? 'running' : 'ready', last_command_id: starting ? args[3] : args[4]});
    } else if (sql.startsWith('INSERT INTO "pult_optimizer"."commands"')) {
      assert.equal(state.commands.has(args[0]), false, 'receipt must be immutable');
      state.commands.set(args[0], {kind: args[1], store_id: args[2], intent_hash: args[3], receipt: JSON.parse(args[4])});
    }
    return {rows: []};
  }
  const pool = {query, connect: async () => {const held = []; return {query: (sql, args) => query(sql, args, held), release() {held.splice(0).reverse().forEach(unlock => unlock());}};}};
  return {state, queries, pool, repository: createOptimizerRepository({pool}), loseNextCommit: () => {failCommit = true;}};
}
const command = (commandId = COMMAND, expectedRevision = '0') => ({commandId, expectedRevision, timestamp});
const protectedCredentials = {storeId: '1', clientIdCiphertext: 'protected-id', clientSecretCiphertext: 'protected-secret', credentialVersion: VERSION, intentHash: 'a'.repeat(64)};
const snapshot = (extra = {}) => ({storeId: '1', credentialVersion: VERSION, commandId: COMMAND, expectedRevision: '0', campaigns: [], products: [], statistics: [], links: [], observedAt: timestamp, ...extra});

test('concurrent first credential writes serialize an absent row and only one expected revision wins', async () => {
  const db = database();
  const results = await Promise.allSettled([
    db.repository.saveCredentials(protectedCredentials, command()),
    db.repository.saveCredentials({...protectedCredentials, intentHash: 'b'.repeat(64)}, command(OTHER)),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.equal(db.state.credentials.get('1').revision, '1');
  assert.equal(db.state.commands.size, 1);
});

test('concurrent repeated command returns one immutable receipt', async () => {
  const db = database();
  const results = await Promise.all([
    db.repository.saveCredentials(protectedCredentials, command()),
    db.repository.saveCredentials(protectedCredentials, command()),
  ]);
  assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
  assert.equal(db.state.commands.size, 1);
  await assert.rejects(db.repository.saveCredentials({...protectedCredentials, intentHash: 'c'.repeat(64)}, command()), {code: 'COMMAND_ID_REUSED'});
});

test('concurrent first store settings cannot silently replace each other at revision one', async () => {
  const db = database();
  const settings = {mode: 'OBSERVE', killSwitch: false};
  const results = await Promise.allSettled([
    db.repository.saveSettings({storeId: '1', settings}, command()),
    db.repository.saveSettings({storeId: '1', settings: {...settings, mode: 'RECOMMEND'}}, command(OTHER)),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
});

test('stale refresh revision and rotated credentials reject before any snapshot mutation', async () => {
  const db = database(); db.state.credentials.set('1', {credential_version: VERSION}); db.state.refresh.set('1', {revision: '1'});
  await assert.rejects(db.repository.commitRefresh(snapshot()), {code: 'REVISION_CONFLICT'});
  await assert.rejects(db.repository.commitRefresh(snapshot({expectedRevision: '1', credentialVersion: OTHER})), {code: 'STALE_CREDENTIALS'});
  assert.equal(db.queries.some(query => /^(INSERT|DELETE|UPDATE)/.test(query.sql)), false);
});

test('refresh replay depends on stable command intent rather than changing fetched data', async () => {
  const db = database(); db.state.credentials.set('1', {credential_version: VERSION});
  const result = await db.repository.commitRefresh(snapshot());
  assert.equal(result.revision, '1');
  const replay = await db.repository.commitRefresh(snapshot({campaigns: [{campaign_id: '999'}]}));
  assert.equal(replay.replayed, true); assert.equal(replay.revision, '1');
  assert.deepEqual(await db.repository.resolveRefresh({storeId: '1', commandId: COMMAND, expectedRevision: '0'}), {committed: true, revision: '1', status: 'done', count: 0, errorCodes: []});
  await assert.rejects(db.repository.resolveRefresh({storeId: '1', commandId: COMMAND, expectedRevision: '1'}), {code: 'COMMAND_ID_REUSED'});
  await assert.rejects(db.repository.resolveRefresh({storeId: '2', commandId: COMMAND}), {code: 'COMMAND_ID_REUSED'});
});

test('a lost COMMIT acknowledgment leaves an explicit unknown outcome that the receipt resolves', async () => {
  const db = database(); db.state.credentials.set('1', {credential_version: VERSION}); db.loseNextCommit();
  await assert.rejects(db.repository.commitRefresh(snapshot()), {code: 'OUTCOME_UNKNOWN'});
  const receipt = await db.repository.resolveRefresh({storeId: '1', commandId: COMMAND, expectedRevision: '0'});
  assert.equal(receipt.committed, true); assert.equal(receipt.revision, '1');
});

test('begin fences overlapping refreshes and failure metadata is tied to command, revision and credentials', async () => {
  const db = database(); db.state.credentials.set('1', {credential_version: VERSION});
  await db.repository.beginRefresh({...snapshot(), at: timestamp});
  await assert.rejects(db.repository.beginRefresh({...snapshot({commandId: OTHER}), at: timestamp}), {code: 'REVISION_CONFLICT'});
  await db.repository.failRefresh('1', {code: 'RATE_LIMITED', retryAfterMs: 30000}, timestamp, snapshot());
  const update = db.queries.find(query => query.sql.startsWith('UPDATE "pult_optimizer"."refresh_state"'));
  assert.match(update.sql, /last_command_id=\$5 AND revision=\$6 AND credential_version=\$7/);
  assert.match(update.sql, /c\.credential_version=\$7/);
  assert.deepEqual(update.args.slice(4), [COMMAND, '0', VERSION]);
});

test('all statistics reads preserve unknown sums and require explicit daily coverage', async () => {
  const db = database(); const options = {storeId: '1', from: '2026-09-10', to: '2026-09-23'};
  await db.repository.readAds(options);
  await db.repository.readAdsForProducts([{storeId: '1', productId: '42'}], options);
  await db.repository.readSkuAds({...options, productId: '42'});
  const reads = db.queries.filter(query => query.sql.startsWith('WITH'));
  assert.equal(reads.length, 3);
  for (const {sql, args} of reads) {
    assert.match(sql, /MIN\(stat_date\)::text AS period_from,MAX\(stat_date\)::text AS period_to/);
    if (sql === reads[0].sql) assert.match(sql, /SUM\(spend\) spend/);
    else assert.match(sql, /CASE WHEN COUNT\(spend\)=COUNT\(\*\) THEN SUM\(spend\) END spend/);
    assert.match(sql, /MIN\(observed_at\) statistics_observed_at/);
    assert.match(sql, /COUNT\(\*\)=\(\$\d+::date-\$\d+::date\+1\)/);
    assert.match(sql, /FROM "pult_optimizer"\."statistics_coverage" cv/);
    assert.match(sql, /cv\.status='complete'/);
    assert.doesNotMatch(sql, /MIN\(source_revision\)=MAX\(source_revision\)/);
    assert.match(sql, /WHERE .*store_id(?:=| IN)/);
    assert.ok(args.includes(options.from)); assert.ok(args.includes(options.to));
  }
  assert.match(reads[0].sql, /p\.current_bid_raw,p\.competitive_bid_raw,p\.minimum_bid_raw/);
  assert.match(reads[0].sql, /FROM q GROUP BY store_id,sku/);
  assert.match(reads[0].sql, /SUM\(spend::numeric\)::text summary_spend/);
  assert.match(reads[0].sql, /LEFT JOIN LATERAL/);
});

test('refresh stores explicit daily coverage and never prunes acquired statistics history', async () => {
  const db = database(); db.state.credentials.set('1', {credential_version: VERSION});
  await db.repository.commitRefresh(snapshot({
    statistics: [{campaign_id: '7', sku: '101', stat_date: '2024-01-01', impressions: '1', clicks: '1', orders: '1', spend: '1', revenue: '1', order_basis: 'ATTRIBUTED_ORDERS', complete: true}],
    statisticsCoverage: [{date: '2026-09-23', status: 'complete'}],
  }));
  const coverage = db.queries.find(query => query.sql.startsWith('INSERT INTO "pult_optimizer"."statistics_coverage"'));
  assert.ok(coverage); assert.deepEqual(JSON.parse(coverage.args[1]), [{date: '2026-09-23', status: 'complete', error_code: null}]);
  assert.match(coverage.sql, /ON CONFLICT\(store_id,stat_date\)/);
  assert.equal(db.queries.some(query => query.sql.startsWith('DELETE FROM "pult_optimizer"."statistics"')), false);
});

test('daily coverage rejects malformed or duplicate dates before writing', async () => {
  for (const statisticsCoverage of [[{date: '2026-02-30', status: 'complete'}], [{date: '2026-09-23', status: 'missing'}], [{date: '2026-09-23', status: 'complete'}, {date: '2026-09-23', status: 'complete'}]]) {
    const db = database();
    await assert.rejects(db.repository.commitRefresh(snapshot({statisticsCoverage})), {code: 'INVALID_ARGUMENT'});
    assert.equal(db.queries.length, 0);
  }
});

test('batched live reads carry actual ledger source period without changing the live schema', async () => {
  const db = database();
  await db.repository.readPriceInputs({storeId: '1', from: '2026-09-10', to: '2026-09-23'});
  await db.repository.readProductInputs([{storeId: '1', productId: '42'}]);
  assert.equal(db.queries.length, 2);
  for (const {sql} of db.queries) {
    assert.match(sql, /entity_type='products'/); assert.match(sql, /entity_type='items'/); assert.match(sql, /entity_type='data\.skuDaily'/);
    assert.match(sql, /s\.entity_key=\('stock:'\|\|\(p\.product->>'product_id'\)/);
    assert.match(sql, /c\.entity_key=p\.entity_key/);
    assert.doesNotMatch(sql, /x\.product_id=s\.value->>'product_id'/);
    assert.match(sql, /metadata#>>'\{data,period,from\}' AS finance_source_from/);
    assert.match(sql, /metadata#>>'\{data,period,to\}' AS finance_source_to/);
    assert.match(sql, /metadata#>>'\{data,unallocatedCents\}' AS finance_unallocated_cents/);
    assert.doesNotMatch(sql, /CREATE INDEX|ALTER TABLE/);
  }
});

test('price campaign filter selects only store-matched product membership and parameterizes the campaign', async () => {
  const db = database();
  await db.repository.readPriceInputs({storeId: '1', campaignId: '7', from: '2026-09-10', to: '2026-09-23'});
  const {sql,args}=db.queries[0];
  assert.match(sql,/EXISTS\(SELECT 1 FROM "pult_optimizer"\."campaign_products" cp WHERE cp.store_id=p.store_id AND cp.product_id=p.value->>'product_id' AND cp.campaign_id=\$2\)/);
  assert.equal(args[1],'7');
});

test('credential rotation permits a new refresh while fencing the stale running command', async () => {
  const db = database();db.state.credentials.set('1',{credential_version:VERSION});
  db.state.refresh.set('1',{revision:'0',status:'running',last_command_id:OTHER,credential_version:OTHER});
  await db.repository.beginRefresh({...snapshot(),at:timestamp});
  assert.equal(db.state.refresh.get('1').last_command_id,COMMAND);
  await assert.rejects(db.repository.commitRefresh(snapshot({commandId:OTHER,credentialVersion:OTHER})),{code:'STALE_CREDENTIALS'});
});

test('batched product ad join disambiguates requested and campaign product store columns', async () => {
  const db=database();await db.repository.readAdsForProducts([{storeId:'1',productId:'42'}],{from:'2026-09-10',to:'2026-09-23'});
  const {sql}=db.queries[0];
  assert.match(sql,/JOIN "pult_optimizer"\."campaigns"c ON c.store_id=p.store_id AND c.campaign_id=p.campaign_id/);
  assert.doesNotMatch(sql,/USING\(store_id/);
});

test('recent experiments are fetched with one bounded indexed query for a page', async () => {
  const db = database();
  await db.repository.readRecentExperiments([{storeId: '1', productId: '42'}, {storeId: '1', productId: '42'}, {storeId: '2', productId: '8'}]);
  assert.equal(db.queries.length, 1);
  assert.deepEqual(JSON.parse(db.queries[0].args[0]), [{store_id: '1', product_id: '42'}, {store_id: '2', product_id: '8'}]);
  assert.match(db.queries[0].sql, /JOIN LATERAL\(SELECT \* FROM "pult_optimizer"\."experiments" e WHERE e\.store_id=r\.store_id AND e\.product_id=r\.product_id ORDER BY e\.started_at DESC LIMIT 1\)/);
  await assert.rejects(db.repository.readRecentExperiments(Array.from({length: 201}, (_, index) => ({storeId: '1', productId: String(index)}))), {code: 'INVALID_ARGUMENT'});
});
