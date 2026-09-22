'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acquireMutationFence, withWriteFence, PostgresWriteFenceError
} = require('../storage/postgres-write-fence.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const pendingAfter = async (promise, milliseconds = 80) => {
  const marker = Symbol('pending');
  assert.equal(await Promise.race([promise, delay(milliseconds).then(() => marker)]), marker);
};

function fakePool(handler = async () => ({ rows: [] })) {
  const calls = [];
  const client = {
    async query(text, values) { calls.push({ text, values }); return handler(text, values, calls); },
    release(destroy) { calls.push({ release: true, destroy: destroy === true }); }
  };
  return { calls, client, async connect() { calls.push({ connect: true }); return client; } };
}

test('mutation fence requires a transaction and uses the fixed shared transaction lock', async () => {
  const pool = fakePool();
  await acquireMutationFence(pool.client);
  assert.deepEqual(pool.calls.map(call => call.text), [
    'SAVEPOINT pult_write_fence_contract',
    'SELECT pg_advisory_xact_lock_shared($1::integer,$2::integer)',
    'RELEASE SAVEPOINT pult_write_fence_contract'
  ]);
  assert.deepEqual(pool.calls[1].values, [1347767372, 1465017934]);

  const outsideTransaction = fakePool(async text => {
    if (text.startsWith('SAVEPOINT')) throw Object.assign(new Error('not in transaction'), { code: '25P01' });
    return { rows: [] };
  });
  await assert.rejects(acquireMutationFence(outsideTransaction.client), error =>
    error.code === 'MUTATION_TRANSACTION_REQUIRED' && !error.message.includes('not in transaction'));
});

test('exclusive callback rejects nested shared and exclusive fences and releases after callback error', async () => {
  const pool = fakePool(async text => {
    if (text === 'SHOW lock_timeout') return { rows: [{ lock_timeout: '0' }] };
    if (text.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    return { rows: [] };
  });
  const callbackError = new Error('callback failure');
  await assert.rejects(withWriteFence({ pool, timeoutMs: 25 }, async client => {
    await assert.rejects(acquireMutationFence(client), error => error.code === 'FENCE_NESTED');
    await assert.rejects(withWriteFence({ pool }, async () => {}), error => error.code === 'FENCE_NESTED');
    throw callbackError;
  }), error => error === callbackError);
  assert.equal(pool.calls.findIndex(call => call.text === 'ROLLBACK') < pool.calls.findIndex(call => call.text?.includes('pg_advisory_lock(')), true);
  assert.equal(pool.calls.some(call => call.text === 'ROLLBACK'), true);
  assert.equal(pool.calls.some(call => call.text?.includes('pg_advisory_unlock')), true);
  assert.deepEqual(pool.calls.at(-1), { release: true, destroy: false });
});

test('lock timeout and database failures are bounded and sanitized', async () => {
  const secret = 'private-value';
  const timedOut = fakePool(async text => {
    if (text === 'SHOW lock_timeout') return { rows: [{ lock_timeout: '0' }] };
    if (text.includes('pg_advisory_lock(')) throw Object.assign(new Error(secret), { code: '55P03' });
    return { rows: [] };
  });
  await assert.rejects(withWriteFence({ pool: timedOut, timeoutMs: 10 }, async () => {}), error =>
    error instanceof PostgresWriteFenceError && error.code === 'FENCE_TIMEOUT' && !error.message.includes(secret));

  const broken = fakePool(async text => {
    if (text === 'SHOW lock_timeout') throw new Error(secret);
    return { rows: [] };
  });
  await assert.rejects(withWriteFence({ pool: broken }, async () => {}), error =>
    error.code === 'FENCE_DATABASE_ERROR' && !error.message.includes(secret));

  const serialization = fakePool(async text => {
    if (text.includes('pg_advisory_xact_lock_shared'))
      throw Object.assign(new Error(secret), { code: '40001' });
    return { rows: [] };
  });
  await assert.rejects(acquireMutationFence(serialization.client), error =>
    error instanceof PostgresWriteFenceError && error.code === '40001' && !error.message.includes(secret));
});

test('ambiguous unlock destroys the dedicated connection', async () => {
  const pool = fakePool(async text => {
    if (text === 'SHOW lock_timeout') return { rows: [{ lock_timeout: '0' }] };
    if (text.includes('pg_advisory_unlock')) throw new Error('connection lost');
    return { rows: [] };
  });
  await assert.rejects(withWriteFence({ pool }, async () => 'done'), error => error.code === 'FENCE_RELEASE_FAILED');
  assert.deepEqual(pool.calls.at(-1), { release: true, destroy: true });
});

test('ambiguous exclusive-lock acquisition destroys the dedicated connection', async () => {
  const pool = fakePool(async text => {
    if (text === 'SHOW lock_timeout') return { rows: [{ lock_timeout: '0' }] };
    if (text.includes('pg_advisory_lock(')) throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
    return { rows: [] };
  });
  await assert.rejects(withWriteFence({ pool }, async () => {}), error => error.code === 'FENCE_DATABASE_ERROR');
  assert.deepEqual(pool.calls.at(-1), { release: true, destroy: true });
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: exclusive fence drains an early writer and blocks a new writer', { skip: !integrationUrl, timeout: 20000 }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: integrationUrl, max: 3 });
  const early = await pool.connect();
  const late = await pool.connect();
  let releaseExclusive;
  const holdExclusive = new Promise(resolve => { releaseExclusive = resolve; });
  try {
    await pool.query('CREATE TABLE fence_probe(sequence bigint GENERATED ALWAYS AS IDENTITY, value text)');
    await early.query('BEGIN');
    await acquireMutationFence(early);
    await early.query("INSERT INTO fence_probe(value) VALUES('early')");

    let exclusiveEntered;
    const entered = new Promise(resolve => { exclusiveEntered = resolve; });
    const exclusive = withWriteFence({ pool, timeoutMs: 5000 }, async client => {
      const visible = await client.query('SELECT max(sequence)::text AS sequence FROM fence_probe');
      exclusiveEntered(visible.rows[0].sequence);
      await holdExclusive;
    });
    await pendingAfter(entered);
    await early.query('COMMIT');
    assert.equal(await entered, '1');

    await late.query('BEGIN');
    const lateFence = acquireMutationFence(late);
    await pendingAfter(lateFence);
    releaseExclusive();
    await exclusive;
    await lateFence;
    await late.query("INSERT INTO fence_probe(value) VALUES('late')");
    await late.query('COMMIT');
    assert.deepEqual((await pool.query('SELECT value FROM fence_probe ORDER BY sequence')).rows.map(row => row.value), ['early', 'late']);

    const callbackError = new Error('synthetic callback error');
    await assert.rejects(withWriteFence({ pool }, async () => { throw callbackError; }), error => error === callbackError);
    await late.query('BEGIN');
    await acquireMutationFence(late);
    await late.query('ROLLBACK');
  } finally {
    releaseExclusive?.();
    await early.query('ROLLBACK').catch(() => {});
    await late.query('ROLLBACK').catch(() => {});
    early.release();
    late.release();
    await pool.end();
  }
});
