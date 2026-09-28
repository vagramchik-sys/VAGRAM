'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ensurePostgresLiveSchema } = require('../storage/postgres-live-schema.cjs');
const { createPostgresLiveRepository, LiveRepositoryError } = require('../storage/postgres-live-repository.cjs');

const identity = () => ({ storeId: 'stopped-command:' + crypto.randomUUID(), domain: 'market' });
const code = expected => error => error instanceof LiveRepositoryError && error.code === expected && error.message === expected && !error.cause;

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');

function headRow(id, revision = 7) {
  const value = { storeId: id.storeId, domain: id.domain, revision, metadata: { source: 'fixture' }, sourceMetadata: {}, entityCounts: { operations: 1 } };
  return {
    revision: String(revision), metadata: value.metadata, source_metadata: value.sourceMetadata,
    entity_counts: value.entityCounts, head_sha256: digest(value), updated_at: '2026-09-28T12:00:00.000Z'
  };
}

function commandRow(revision = 7) {
  const intent = 'a'.repeat(64), receipt = { revision, intentFingerprint: intent, counts: { inserted: 1 } };
  return { intent_sha256: intent, receipt, receipt_sha256: digest(receipt) };
}

function fake({ head, command, failHead } = {}) {
  const statements = [];
  let headAcquired = false, connects = 0;
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes('FROM pult_live.heads')) {
        assert.match(sql, /FOR UPDATE$/u);
        if (failHead) throw failHead;
        headAcquired = true;
        return { rows: head ? [head] : [] };
      }
      if (sql.includes('FROM pult_live.commands')) {
        assert.equal(headAcquired, true, 'command receipt must be read only after the head lock is acquired');
        return { rows: command ? [command] : [] };
      }
      return { rows: [] };
    },
    release() { statements.push('release'); }
  };
  const repo = createPostgresLiveRepository({ pool: { async connect() { connects++; return client; } } });
  return { repo, statements, get connects() { return connects; } };
}

test('producer proof is mandatory and rejected before a connection is opened', async () => {
  const fixture = fake();
  await assert.rejects(fixture.repo.settleStoppedCommand({ ...identity(), commandId: 'pending' }), code('INVALID_ARGUMENT'));
  await assert.rejects(fixture.repo.settleStoppedCommand({ ...identity(), commandId: 'pending', producerStopped: false }), code('INVALID_ARGUMENT'));
  assert.equal(fixture.connects, 0);
});

test('missing head returns null without querying a command receipt', async () => {
  const fixture = fake();
  assert.equal(await fixture.repo.settleStoppedCommand({ ...identity(), commandId: 'missing', producerStopped: true }), null);
  assert.equal(fixture.statements[0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.equal(fixture.statements.some(sql => sql.includes('FROM pult_live.commands')), false);
  assert.deepEqual(fixture.statements.slice(-2), ['COMMIT', 'release']);
});

test('head is locked before committed or absent receipt is classified', async () => {
  for (const saved of [commandRow(), null]) {
    const id = identity(), fixture = fake({ head: headRow(id), command: saved });
    const result = await fixture.repo.settleStoppedCommand({ ...id, commandId: 'candidate', producerStopped: true });
    assert.deepEqual(result, { committed: !!saved, revision: '7' });
    assert.equal(Object.isFrozen(result), true);
    const headIndex = fixture.statements.findIndex(sql => sql.includes('FROM pult_live.heads'));
    const commandIndex = fixture.statements.findIndex(sql => sql.includes('FROM pult_live.commands'));
    assert.ok(headIndex >= 0 && commandIndex > headIndex);
    assert.ok(fixture.statements.indexOf("SET LOCAL lock_timeout = '5s'") < headIndex);
    assert.ok(fixture.statements.indexOf("SET LOCAL statement_timeout = '10s'") < headIndex);
  }
});

test('corrupt head and receipt metadata fail closed and roll back', async () => {
  const id = identity(), corruptHead = headRow(id); corruptHead.head_sha256 = '0'.repeat(64);
  const badHead = fake({ head: corruptHead, command: commandRow() });
  await assert.rejects(badHead.repo.settleStoppedCommand({ ...id, commandId: 'candidate', producerStopped: true }), code('DATA_INTEGRITY'));
  assert.equal(badHead.statements.some(sql => sql.includes('FROM pult_live.commands')), false);
  assert.deepEqual(badHead.statements.slice(-2), ['ROLLBACK', 'release']);

  const corruptReceipt = commandRow(); corruptReceipt.receipt_sha256 = '0'.repeat(64);
  const badReceipt = fake({ head: headRow(id), command: corruptReceipt });
  await assert.rejects(badReceipt.repo.settleStoppedCommand({ ...id, commandId: 'candidate', producerStopped: true }), code('DATA_INTEGRITY'));
  assert.deepEqual(badReceipt.statements.slice(-2), ['ROLLBACK', 'release']);
});

test('head-lock timeout is sanitized and always rolls back and releases', async () => {
  const fixture = fake({ failHead: Object.assign(new Error('private lock detail'), { code: '55P03' }) });
  await assert.rejects(fixture.repo.settleStoppedCommand({ ...identity(), commandId: 'candidate', producerStopped: true }), code('DATABASE_ERROR'));
  assert.equal(fixture.statements.some(sql => sql.includes('FROM pult_live.commands')), false);
  assert.deepEqual(fixture.statements.slice(-2), ['ROLLBACK', 'release']);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: settlement waits for pending writer commit and rollback', { skip: !integrationUrl, timeout: 30000 }, async t => {
  const databaseName = decodeURIComponent(new URL(integrationUrl).pathname.slice(1));
  assert.match(databaseName, /^pult_test_[a-f0-9]+$/u);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 6 });
  t.after(() => pool.end());
  await ensurePostgresLiveSchema(pool);
  const repository = createPostgresLiveRepository({ pool });
  const all = rows => ({ entityType: 'operations', scope: { kind: 'all' }, rows });
  const record = amount => ({ entityKey: 'row', businessDay: null, value: { amount } });

  async function run(mode) {
    const id = identity();
    await repository.publish({ ...id, commandId: 'initial', expectedRevision: 0, partitions: [all([record(1)])] });
    let commitReached, releaseCommit;
    const atCommit = new Promise(resolve => { commitReached = resolve; });
    const commitGate = new Promise(resolve => { releaseCommit = resolve; });
    const writer = createPostgresLiveRepository({ pool: { async connect() {
      const client = await pool.connect();
      return { release: value => client.release(value), async query(sql, values) {
        if (sql === 'COMMIT') { commitReached(); await commitGate; if (mode === 'rollback') throw new Error('synthetic uncertain commit'); }
        return client.query(sql, values);
      } };
    } } });
    const publication = writer.publish({ ...id, commandId: 'pending-' + mode, expectedRevision: 1, partitions: [all([record(2)])] });
    await atCommit;

    let headAttempted, settled = false;
    const atHead = new Promise(resolve => { headAttempted = resolve; });
    const settler = createPostgresLiveRepository({ pool: { async connect() {
      const client = await pool.connect();
      return { release: value => client.release(value), async query(sql, values) {
        if (sql.includes('FROM pult_live.heads') && sql.endsWith(' FOR UPDATE')) headAttempted();
        return client.query(sql, values);
      } };
    } } });
    const settlement = settler.settleStoppedCommand({ ...id, commandId: 'pending-' + mode, producerStopped: true }).then(value => { settled = true; return value; });
    await atHead;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'head lock must wait while the writer outcome is pending');
    releaseCommit();

    if (mode === 'commit') {
      assert.equal((await publication).revision, 2);
      assert.deepEqual(await settlement, { committed: true, revision: '2' });
    } else {
      await assert.rejects(publication, code('DATABASE_ERROR'));
      assert.deepEqual(await settlement, { committed: false, revision: '1' });
    }
  }

  await t.test('commit becomes visible after the lock wait', () => run('commit'));
  await t.test('rollback leaves the old revision and no receipt', () => run('rollback'));
});
