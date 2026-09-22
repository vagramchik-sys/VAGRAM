'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

// Two fixed signed-int keys avoid relying on database-specific hash functions.
const FENCE_KEY_1 = 1347767372;
const FENCE_KEY_2 = 1465017934;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 60000;
const exclusiveContext = new AsyncLocalStorage();
const exclusiveClients = new WeakSet();

class PostgresWriteFenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PostgresWriteFenceError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new PostgresWriteFenceError(code, message); };
const databaseError = () => new PostgresWriteFenceError('FENCE_DATABASE_ERROR', 'PostgreSQL write fence operation failed');

function validClient(client) {
  return client && typeof client.query === 'function';
}

async function acquireMutationFence(client) {
  if (!validClient(client)) fail('INVALID_ARGUMENT', 'client must provide query');
  if (exclusiveContext.getStore() || exclusiveClients.has(client))
    fail('FENCE_NESTED', 'A mutation fence cannot be acquired inside an exclusive write fence');
  try {
    // SAVEPOINT makes using the transaction-level lock outside a transaction fail closed.
    await client.query('SAVEPOINT pult_write_fence_contract');
    await client.query('SELECT pg_advisory_xact_lock_shared($1::integer,$2::integer)', [FENCE_KEY_1, FENCE_KEY_2]);
    await client.query('RELEASE SAVEPOINT pult_write_fence_contract');
  } catch (error) {
    if (error instanceof PostgresWriteFenceError) throw error;
    if (error?.code === '40001')
      fail('40001', 'PostgreSQL serialization conflict while acquiring the mutation fence');
    if (error?.code === '25P01')
      fail('MUTATION_TRANSACTION_REQUIRED', 'A mutation fence requires an active transaction');
    throw databaseError();
  }
}

function timeout(value) {
  const result = value === undefined ? DEFAULT_TIMEOUT_MS : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_TIMEOUT_MS)
    fail('INVALID_ARGUMENT', `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  return result;
}

function releaseClient(client, destroy) {
  try { client.release(destroy || undefined); } catch {}
}

async function withWriteFence({ pool, timeoutMs } = {}, callback) {
  if (!pool || typeof pool.connect !== 'function' || typeof callback !== 'function')
    fail('INVALID_ARGUMENT', 'pool.connect and callback are required');
  const waitMs = timeout(timeoutMs);
  if (exclusiveContext.getStore()) fail('FENCE_NESTED', 'Exclusive write fences cannot be nested');

  let client;
  try { client = await pool.connect(); }
  catch { throw databaseError(); }
  if (!validClient(client) || typeof client.release !== 'function') {
    if (client?.release) releaseClient(client, true);
    fail('FENCE_DATABASE_ERROR', 'PostgreSQL write fence operation failed');
  }

  let locked = false;
  let destroy = false;
  let operationError = null;
  let result;
  try {
    let previousTimeout;
    let acquiring = false;
    try {
      // A pooled session must be idle so its MVCC snapshot cannot predate writer drain.
      await client.query('ROLLBACK');
      const shown = await client.query('SHOW lock_timeout');
      previousTimeout = shown.rows?.[0]?.lock_timeout;
      if (typeof previousTimeout !== 'string') throw databaseError();
      await client.query("SELECT set_config('lock_timeout',$1,false)", [`${waitMs}ms`]);
      try {
        acquiring = true;
        await client.query('SELECT pg_advisory_lock($1::integer,$2::integer)', [FENCE_KEY_1, FENCE_KEY_2]);
        locked = true;
        acquiring = false;
      } finally {
        try { await client.query("SELECT set_config('lock_timeout',$1,false)", [previousTimeout]); }
        catch { destroy = true; }
      }
    } catch (error) {
      if (error instanceof PostgresWriteFenceError) throw error;
      if (acquiring && error?.code === '55P03')
        fail('FENCE_TIMEOUT', 'Timed out waiting for PostgreSQL writers to drain');
      if (acquiring) destroy = true;
      throw databaseError();
    }
    if (destroy) throw databaseError();

    exclusiveClients.add(client);
    try { result = await exclusiveContext.run(true, () => callback(client)); }
    catch (error) { operationError = error; }
    finally { exclusiveClients.delete(client); }
  } catch (error) {
    operationError ||= error instanceof PostgresWriteFenceError ? error : databaseError();
  } finally {
    if (locked) {
      // End any callback transaction before returning the pooled session.
      try { await client.query('ROLLBACK'); } catch { destroy = true; }
      if (!destroy) {
        try {
          const unlocked = await client.query('SELECT pg_advisory_unlock($1::integer,$2::integer) AS unlocked', [FENCE_KEY_1, FENCE_KEY_2]);
          if (unlocked.rows?.[0]?.unlocked !== true) destroy = true;
        } catch { destroy = true; }
      }
    }
    releaseClient(client, destroy);
  }

  if (destroy && !operationError)
    fail('FENCE_RELEASE_FAILED', 'PostgreSQL write fence release was uncertain; the connection was destroyed');
  if (operationError) throw operationError;
  return result;
}

module.exports = { acquireMutationFence, withWriteFence, PostgresWriteFenceError };
