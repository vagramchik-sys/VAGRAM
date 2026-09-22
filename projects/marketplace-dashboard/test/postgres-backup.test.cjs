'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createBackup, verifyRestore, PostgresBackupError, INCOMPLETE_MARKER, _test
} = require('../storage/postgres-backup.cjs');
const {ensurePostgresLiveSchema}=require('../storage/postgres-live-schema.cjs');
const {createPostgresLiveRepository}=require('../storage/postgres-live-repository.cjs');
const {schemaSql:liveSchedulerSql}=require('../storage/acquisition/postgres-live-scheduler.cjs');

const BIN = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Pult', 'PostgreSQL', '18.6', 'bin')
  : null;
const TEST_DATABASE = /^pult_test_[a-f0-9]{8,64}(?:_[a-z0-9_]+)?$/u;

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-pg-backup-'));
  const backup = path.join(root, 'backup');
  await fs.mkdir(backup);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, backup };
}

test('rejects unsafe connection and incomplete backup before restore', async t => {
  const { backup } = await temporary(t);
  await fs.writeFile(path.join(backup, INCOMPLETE_MARKER), '{}');
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({}) };
  await assert.rejects(createBackup({ pool, connection: { host: 'remote', port: 5441 }, binaryDirectory: BIN || 'missing', destinationDir: backup }), error =>
    error instanceof PostgresBackupError && error.code === 'INVALID_ARGUMENT');
  await assert.rejects(verifyRestore({ pool, connection: {
    host: '127.0.0.1', port: 5441, user: 'tester', database: 'pult_test_12345678_restore', password: 'x'
  }, binaryDirectory: BIN || 'missing', backupDir: backup }), error => error.code === 'BACKUP_INCOMPLETE');
});

test('restore target name must be explicitly disposable', async t => {
  const { backup } = await temporary(t);
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({}) };
  await assert.rejects(verifyRestore({ pool, connection: {
    host: '127.0.0.1', port: 5441, user: 'tester', database: 'pult', password: 'x'
  }, binaryDirectory: BIN || 'missing', backupDir: backup }), error => error.code === 'RESTORE_TARGET_FORBIDDEN');
});

test('legacy manifests without a schema list retain the original three-schema scope',()=>{
  assert.deepEqual(_test.manifestSchemas({}),['pult','pult_history','pult_market']);
  assert.deepEqual(_test.manifestSchemas({schemas:['pult','pult_live']}),['pult','pult_live']);
  assert.throws(()=>_test.manifestSchemas({schemas:['pult','unknown']}),error=>error.code==='BACKUP_INVALID');
});

const sourceUrl = process.env.PULT_TEST_DATABASE_URL;
const restoreUrl = process.env.PULT_TEST_RESTORE_DATABASE_URL;
test('PostgreSQL integration: custom dump restores with exact rows, keys and catalog metadata', {
  skip: !sourceUrl || !restoreUrl, timeout: 240000
}, async t => {
  const { Pool } = require('pg');
  const sourceParsed = new URL(sourceUrl), restoreParsed = new URL(restoreUrl);
  const connection = parsed => ({
    host: parsed.hostname, port: Number(parsed.port), user: decodeURIComponent(parsed.username),
    database: decodeURIComponent(parsed.pathname.slice(1)), password: decodeURIComponent(parsed.password)
  });
  const source = connection(sourceParsed), target = connection(restoreParsed);
  assert.ok(BIN, 'LOCALAPPDATA is required for PostgreSQL integration tests');
  assert.match(source.database, TEST_DATABASE, 'source must be an explicitly disposable test database');
  assert.match(target.database, TEST_DATABASE, 'restore target must be an explicitly disposable test database');
  assert.notEqual(source.database, target.database, 'source and restore target must be distinct');
  const sourcePool = new Pool({ connectionString: sourceUrl, max: 4 });
  const restorePool = new Pool({ connectionString: restoreUrl, max: 2 });
  let sourceCleanupAuthorized = false, targetCleanupAuthorized = false;
  const { backup } = await temporary(t);
  try {
    const schemaCount = async pool => Number((await pool.query(
      'SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname=ANY($1::text[])',
      [['pult', 'pult_history', 'pult_market','pult_live']]
    )).rows[0].count);
    assert.equal(await schemaCount(sourcePool), 0, 'source test database must not contain Pult schemas');
    assert.equal(await schemaCount(restorePool), 0, 'restore test database must not contain Pult schemas');
    sourceCleanupAuthorized = true;
    targetCleanupAuthorized = true;
    await sourcePool.query(`CREATE SCHEMA pult; CREATE SCHEMA pult_history; CREATE SCHEMA pult_market;
      CREATE TABLE pult.commands(sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,payload bytea NOT NULL);
      CREATE TABLE pult_history.parent("camelCaseId" bigint PRIMARY KEY,amount numeric(40,12) NOT NULL);
      CREATE TABLE pult_history.child(id bigint PRIMARY KEY,parent_id bigint NOT NULL REFERENCES pult_history.parent("camelCaseId"),note text);
      CREATE INDEX child_note_idx ON pult_history.child(note);
      CREATE TABLE pult_market.duplicates(value text NOT NULL);
      CREATE TABLE pult_market.large_payloads(id bigint PRIMARY KEY,payload bytea,optional_payload bytea);
      INSERT INTO pult.commands(payload) VALUES(decode('00ff10','hex'));
      INSERT INTO pult_history.parent VALUES(1,12345678901234567890.123456789012);
      INSERT INTO pult_history.child VALUES(2,1,'synthetic');
      INSERT INTO pult_market.duplicates VALUES('same'),('same');`);
    await ensurePostgresLiveSchema(sourcePool);await sourcePool.query(liveSchedulerSql());
    const live=createPostgresLiveRepository({pool:sourcePool});await live.publish({storeId:'backup-test',domain:'market',commandId:'backup-live-command',expectedRevision:0,metadata:{status:'ready'},sourceMetadata:{sourcePath:'data-1.json'},partitions:[{entityType:'operations',scope:{kind:'all'},rows:[{entityKey:'operation:1',businessDay:'2026-09-22',sourceOrder:0,value:{amount:1}}]}]});
    await sourcePool.query(`UPDATE pult_live.scheduler_head SET revision=2;
      INSERT INTO pult_live.scheduler_jobs(kind,store_id,attempt_id,command_id,timestamp_text,next_due_at_text,state,stage,count_value,error_codes,document_revision,runner_id,resolution,payload,payload_hash,updated_revision)
      VALUES('market','1','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','2026-09-22T00:00:00.000Z','2026-09-22T01:00:00.000Z','done',NULL,1,'[]','1',NULL,NULL,NULL,NULL,1);
      INSERT INTO pult_live.scheduler_commands(command_id,kind,store_id,before_revision,after_revision,before_job,after_job) VALUES('22222222-2222-4222-8222-222222222222','market','1',0,1,NULL,'{}');
      INSERT INTO pult_live.scheduler_requests(command_id,timestamp_text,kind,targets,captured_revision) VALUES('33333333-3333-4333-8333-333333333333','2026-09-22T00:00:00.000Z','insights-full','[]',2)`);
    const largePayload = Buffer.alloc(129 * 1024 * 1024, 0x5a);
    largePayload[0] = 0x00; largePayload[largePayload.length - 1] = 0xff;
    const largePayloadSha256 = require('node:crypto').createHash('sha256').update(largePayload).digest('hex');
    await sourcePool.query('INSERT INTO pult_market.large_payloads(id,payload,optional_payload) VALUES($1,$2,$3)', ['1', largePayload, null]);
    const manifest = await createBackup({ pool: sourcePool, connection: source, binaryDirectory: BIN, destinationDir: backup });
    assert.equal(manifest.rollbackReady, false);
    assert.equal(manifest.upperSequence, '1');
    assert.equal(manifest.digestFormatVersion, _test.DIGEST_FORMAT_VERSION);
    assert.deepEqual(manifest.schemas,['pult','pult_history','pult_market','pult_live']);
    const liveTables=['commands','facts','heads','incoming_rows','record_journal','scheduler_commands','scheduler_head','scheduler_jobs','scheduler_requests'];
    assert.deepEqual(manifest.tables.filter(table=>table.schema==='pult_live').map(table=>table.table),liveTables);
    assert.ok(manifest.constraints.some(item=>item.schema==='pult_live'&&item.table==='facts'));
    const largeTable = manifest.tables.find(table => table.schema === 'pult_market' && table.table === 'large_payloads');
    assert.equal(largeTable.columns.find(column => column.name === 'payload').bytea, true);
    assert.equal(largeTable.columns.find(column => column.name === 'optional_payload').bytea, true);

    const truncated = path.join(path.dirname(backup), 'truncated');
    await fs.cp(backup, truncated, { recursive: true });
    await fs.truncate(path.join(truncated, 'database.dump'), 16);
    await assert.rejects(verifyRestore({ pool: restorePool, connection: target, binaryDirectory: BIN, backupDir: truncated }),
      error => error.code === 'BACKUP_INVALID');
    assert.equal(await schemaCount(restorePool), 0);

    const corrupted = path.join(path.dirname(backup), 'corrupted');
    await fs.cp(backup, corrupted, { recursive: true });
    const corruptedDump = await fs.open(path.join(corrupted, 'database.dump'), 'r+');
    try {
      const byte = Buffer.alloc(1);
      await corruptedDump.read(byte, 0, 1, 0);
      byte[0] ^= 0xff;
      await corruptedDump.write(byte, 0, 1, 0);
    } finally { await corruptedDump.close(); }
    await assert.rejects(verifyRestore({ pool: restorePool, connection: target, binaryDirectory: BIN, backupDir: corrupted }),
      error => error.code === 'BACKUP_INVALID');
    assert.equal(await schemaCount(restorePool), 0);

    const result = await verifyRestore({ pool: restorePool, connection: target, binaryDirectory: BIN, backupDir: backup });
    assert.equal(result.verified, true);
    assert.equal(result.rollbackReady, false);
    assert.equal((await restorePool.query('SELECT count(*)::text AS count FROM pult_market.duplicates')).rows[0].count, '2');
    assert.equal((await restorePool.query('SELECT count(*)::text AS count FROM pult_live.facts')).rows[0].count,'1');
    assert.equal((await restorePool.query('SELECT count(*)::text AS count FROM pult_live.record_journal')).rows[0].count,'1');
    assert.equal((await restorePool.query('SELECT count(*)::text AS count FROM pult_live.scheduler_jobs')).rows[0].count,'1');
    assert.equal((await restorePool.query('SELECT count(*)::text AS count FROM pult_live.scheduler_commands')).rows[0].count,'1');
    assert.equal((await restorePool.query('SELECT count(*)::text AS count FROM pult_live.scheduler_requests')).rows[0].count,'1');
    const restoredLarge = await restorePool.query("SELECT octet_length(payload)::text AS bytes,encode(sha256(payload),'hex') AS sha256,optional_payload IS NULL AS optional_null FROM pult_market.large_payloads WHERE id=1");
    assert.deepEqual(restoredLarge.rows[0], { bytes: String(largePayload.length), sha256: largePayloadSha256, optional_null: true });
    const restoredClient = await restorePool.connect();
    try {
      await restoredClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const beforeCorruption = await _test.databaseInventory(restoredClient);
      await restoredClient.query('COMMIT');
      assert.deepEqual(beforeCorruption.tables, manifest.tables);
    } finally { restoredClient.release(); }
    await restorePool.query('UPDATE pult_market.large_payloads SET payload=set_byte(payload,67108864,get_byte(payload,67108864) # 1) WHERE id=1');
    const corruptedClient = await restorePool.connect();
    try {
      await corruptedClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const afterCorruption = await _test.databaseInventory(corruptedClient);
      await corruptedClient.query('COMMIT');
      const changed = afterCorruption.tables.find(table => table.schema === 'pult_market' && table.table === 'large_payloads');
      assert.notEqual(changed.rowSha256, largeTable.rowSha256, 'large bytea corruption must change the row digest');
      assert.equal(changed.keySha256, largeTable.keySha256, 'non-corrupted primary key digest must remain stable');
    } finally { corruptedClient.release(); }
  } finally {
    if (sourceCleanupAuthorized) await sourcePool.query('DROP SCHEMA IF EXISTS pult_live,pult_market,pult_history,pult CASCADE').catch(() => {});
    if (targetCleanupAuthorized) await restorePool.query('DROP SCHEMA IF EXISTS pult_live,pult_market,pult_history,pult CASCADE').catch(() => {});
    await sourcePool.end();
    await restorePool.end();
  }
});
