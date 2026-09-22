'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const {createLiveMigration} = require('../storage/postgres-live-migration.cjs');
const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('migration preserves individual rows, absent fields, duplicate order, and is restartable', {skip:!integrationUrl}, async () => {
  assert.match(new URL(integrationUrl).pathname,/^\/pult_test_/u);
  const {Pool} = require('pg'), pool = new Pool({connectionString:integrationUrl,max:2}), schema = 'mig_' + crypto.randomBytes(5).toString('hex');
  try {
    await pool.query(`CREATE SCHEMA ${schema};CREATE TABLE ${schema}.source_files(source_path text,logical_key text,media_type text);CREATE TABLE ${schema}.document_states(logical_key text,revision bigint,sha256 bytea,content bytea,deleted boolean);`);
    await require('../storage/postgres-live-schema.cjs').ensurePostgresLiveSchema(pool);
    const value = {products:[{product_id:1,name:'First'},{product_id:1,name:'Second'}],stocks:null,operations:[],store:'Synthetic'}, bytes = Buffer.from(JSON.stringify(value));
    await pool.query(`INSERT INTO ${schema}.source_files VALUES('data-91.json','k','application/json');INSERT INTO ${schema}.source_files VALUES('stores.json','secret','application/json')`);
    await pool.query(`INSERT INTO ${schema}.document_states VALUES('k',7,$1,$2,false)`,[crypto.createHash('sha256').update(bytes).digest(),bytes]);
    const sources = require('../storage/postgres-live-sources.cjs').createLiveSources({repository:require('../storage/postgres-live-repository.cjs').createPostgresLiveRepository({pool})});
    const migration = createLiveMigration({pool,sources,stateSchema:schema});
    const first = await migration.migrate(), again = await migration.migrate();
    assert.equal(first.sources.length,1);assert.equal(first.sources[0].legacyRevision,'7');assert.equal(first.sources[0].rows,2);assert.equal(first.sources[0].sourceStable,true);
    assert.equal(again.sources[0].reused,true);assert.equal(again.sources[0].revision,first.sources[0].revision);
    assert.deepEqual((await sources.record('data-91.json')).value,value);
    assert.equal((await pool.query('SELECT count(*)::int n FROM pult_live.record_journal')).rows[0].n,2);
  } finally {await pool.query(`DROP SCHEMA IF EXISTS pult_live CASCADE;DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
});

async function migrationFixture(run) {
  assert.match(new URL(integrationUrl).pathname,/^\/pult_test_/u);
  const {Pool} = require('pg'), pool = new Pool({connectionString:integrationUrl,max:2}), schema = 'mig_' + crypto.randomBytes(5).toString('hex');
  try {
    await pool.query(`CREATE SCHEMA ${schema};CREATE TABLE ${schema}.source_files(source_path text,logical_key text,media_type text);CREATE TABLE ${schema}.document_states(logical_key text,revision bigint,sha256 bytea,content bytea,deleted boolean);`);
    await require('../storage/postgres-live-schema.cjs').ensurePostgresLiveSchema(pool);
    await pool.query(`INSERT INTO ${schema}.source_files VALUES('data-92.json','k','application/json')`);
    async function setLegacy(value, revision) {
      const bytes = Buffer.from(JSON.stringify(value));
      await pool.query(`DELETE FROM ${schema}.document_states WHERE logical_key='k'`);
      await pool.query(`INSERT INTO ${schema}.document_states VALUES('k',$1,$2,$3,false)`,[revision,crypto.createHash('sha256').update(bytes).digest(),bytes]);
    }
    const sources = require('../storage/postgres-live-sources.cjs').createLiveSources({repository:require('../storage/postgres-live-repository.cjs').createPostgresLiveRepository({pool})});
    await run({pool,schema,sources,setLegacy,path:'data-92.json'});
  } finally {await pool.query(`DROP SCHEMA IF EXISTS pult_live CASCADE;DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
}

test('verified checkpoint avoids reconstruction only for the matching canonical hash and native revision', {skip:!integrationUrl}, async () => {
  await migrationFixture(async ({pool,schema,sources,setLegacy,path}) => {
    const value = {products:[{product_id:2,name:'Checkpoint'}],operations:[]};
    await setLegacy(value,1);
    let reads = 0;
    const migration = createLiveMigration({pool,stateSchema:schema,sources:{...sources,record:async (...args) => { reads++;return sources.record(...args); }}});
    const first = await migration.migrate();
    assert.equal(reads,1);
    const proof = first.sources[0];
    const resumed = await migration.migrate({verifiedSources:[proof]});
    assert.equal(resumed.sources[0].verificationReused,true);
    assert.equal(reads,1);
    for (const invalidProof of [{...proof,revision:'999'},{...proof,sourceSha256:'0'.repeat(64)},{...proof,verified:false},{...proof,sourcePath:'data-93.json'}]) {
      const before = reads;
      const checked = await migration.migrate({verifiedSources:[invalidProof]});
      assert.equal(checked.sources[0].verificationReused,false);
      assert.equal(reads,before+1);
    }
    await sources.document(path).compareAndSet(value,{expectedRevision:proof.revision,commandId:'api:same-content'});
    const before = reads;
    const advanced = await migration.migrate({verifiedSources:[proof]});
    assert.equal(advanced.sources[0].reused,true);
    assert.equal(advanced.sources[0].verificationReused,false);
    assert.notEqual(advanced.sources[0].revision,proof.revision);
    assert.equal(reads,before+1);
    const filtered = await migration.migrate({sourcePaths:['data-93.json']});
    assert.deepEqual(filtered.sources,[]);
    assert.equal(reads,before+1);
  });
});

test('migration never overwrites newer API facts even when the legacy source changes', {skip:!integrationUrl}, async () => {
  await migrationFixture(async ({pool,schema,sources,setLegacy,path}) => {
    const original = {products:[{product_id:2,name:'Imported'}]}, native = {products:[{product_id:2,name:'API change'}]}, legacy = {products:[{product_id:2,name:'Later legacy change'}]};
    await setLegacy(original,1);
    const migration = createLiveMigration({pool,stateSchema:schema,sources});
    const first = await migration.migrate();
    const written = await sources.document(path).compareAndSet(native,{expectedRevision:first.sources[0].revision,commandId:'api:refresh'});
    await setLegacy(legacy,2);
    const commandsBefore = (await pool.query('SELECT count(*)::int n FROM pult_live.commands')).rows[0].n;
    await assert.rejects(migration.migrate({verifiedSources:first.sources}),{code:'MIGRATION_TARGET_ADVANCED'});
    const current = await sources.record(path);
    assert.deepEqual(current.value,native);
    assert.equal(current.revision,written.revision);
    assert.equal((await pool.query('SELECT count(*)::int n FROM pult_live.commands')).rows[0].n,commandsBefore);
  });
});

test('migration can advance imported sources but cannot replay an older import over a newer one', {skip:!integrationUrl}, async () => {
  await migrationFixture(async ({pool,schema,sources,setLegacy,path}) => {
    const original = {products:[{product_id:2,name:'First import'}]}, changed = {products:[{product_id:2,name:'Second import'}]};
    await setLegacy(original,1);
    const migration = createLiveMigration({pool,stateSchema:schema,sources});
    const first = await migration.migrate();
    await setLegacy(changed,2);
    const second = await migration.migrate({verifiedSources:first.sources});
    assert.equal(second.sources[0].reused,false);
    assert.equal(second.sources[0].verificationReused,false);
    assert.notEqual(second.sources[0].revision,first.sources[0].revision);
    await setLegacy(original,1);
    await assert.rejects(migration.migrate({verifiedSources:first.sources}),{code:'MIGRATION_TARGET_ADVANCED'});
    const current = await sources.record(path);
    assert.deepEqual(current.value,changed);
    assert.equal(current.revision,second.sources[0].revision);
  });
});
