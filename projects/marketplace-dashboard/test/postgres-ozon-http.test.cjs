'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createPostgresOzonApi, buildPostgresOzonHttpSql, READ_ROUTES, MAX_REQUEST_BYTES } = require('../storage/acquisition/postgres-ozon-http.cjs');
const success = data => ({ rows: [{ response: { ok: true, status: 200, data } }] });
const rejected = (status, code, retryAfterMs) => ({ rows: [{ response: { ok: false, status, code, retryAfterMs } }] });

test('Ozon SQL adapter submits only IDs, exact read routes, JSON and bounded deadline', async () => {
  const calls = [], api = createPostgresOzonApi({ pool: { query: async (...args) => { calls.push(args); return success({ items: [{ id: 1 }] }); } } });
  assert.deepEqual(await api({ clientId: '123' }, 'plaintext-must-never-reach-sql', '/v3/product/list', { limit: 1 }), { items: [{ id: 1 }] });
  assert.match(calls[0][0], /^SELECT "pult_ozon_http"\.request\(\$1::text,\$2::text,\$3::jsonb,\$4::integer\) AS response$/u);
  assert.deepEqual(calls[0][1].slice(0, 3), ['123', '/v3/product/list', '{"limit":1}']);
  assert.ok(calls[0][1][3] > 0 && calls[0][1][3] <= 120000);
  assert.equal(JSON.stringify(calls).includes('plaintext'), false);
  assert.equal(api.usesDatabaseCredentials, true);
  for (const route of READ_ROUTES) await api({ clientId: '123' }, null, route, {});
});

test('Ozon SQL adapter rejects writes, arbitrary destinations and unsafe payloads before SQL', async () => {
  let count = 0;
  const api = createPostgresOzonApi({ pool: { query: async () => { count++; return success({}); } } });
  for (const route of ['/v1/product/import', '/v3/product/list?url=http://127.0.0.1', '//evil.test', 'https://api-seller.ozon.ru/v3/product/list', '/v3/product/list/../import', '/v3/product/list\r\nX: yes']) {
    await assert.rejects(api({ clientId: '1' }, null, route, {}), { code: 'INVALID_ARGUMENT' });
  }
  for (const clientId of ['1; SELECT secret', 'wb-1', '1\r\nHost: evil', '', '1'.repeat(33)]) await assert.rejects(api({ clientId }, null, READ_ROUTES[0], {}), { code: 'INVALID_ARGUMENT' });
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [[], null, cyclic, { bad: Infinity }, { large: 'x'.repeat(MAX_REQUEST_BYTES) }]) await assert.rejects(api({ clientId: '1' }, null, READ_ROUTES[0], value), { code: 'INVALID_ARGUMENT' });
  assert.equal(count, 0);
});

test('only known HTTP rate limits/server failures retry; remaining deadline covers retries', async () => {
  let now = 0;
  const calls = [], pauses = [];
  const api = createPostgresOzonApi({ now: () => now, sleep: async ms => { pauses.push(ms); now += ms; }, pool: { query: async (sql, values) => { calls.push(values); now += 10000; return calls.length === 1 ? rejected(503, 'HTTP_ERROR', 3000) : success({}); } } });
  await api({ clientId: '1' }, null, READ_ROUTES[0], {});
  assert.deepEqual(pauses, [3000]);
  assert.deepEqual(calls.map(row => row[3]), [120000, 107000]);
  const limited = createPostgresOzonApi({ now: () => 0, sleep: async () => assert.fail('cooldown exceeds deadline'), pool: { query: async () => rejected(429, 'RATE_LIMITED', 180000) } });
  await assert.rejects(limited({ clientId: '1' }, null, READ_ROUTES[0], {}), { code: 'RATE_LIMITED', status: 429, retryAfterMs: 180000 });
  const analytics = createPostgresOzonApi({ sleep: async () => assert.fail('analytics must cool down in scheduler'), pool: { query: async () => rejected(429, 'RATE_LIMITED', 1000) } });
  await assert.rejects(analytics({ clientId: '1' }, null, '/v1/analytics/data', {}), { code: 'RATE_LIMITED', status: 429, retryAfterMs: 300000 });
});

test('pool queue time reduces the HTTP deadline and releases each checkout before retry sleep', async () => {
  let now = 0, checkedOut = 0, attempts = 0;
  const seen = [], api = createPostgresOzonApi({ now: () => now,
    sleep: async ms => { assert.equal(checkedOut, 0); now += ms; },
    pool: {
      query: async () => assert.fail('pool.query would hide queue time'),
      connect: async () => {
        now += 15000; checkedOut++;
        return { query: async (sql, values) => { seen.push(values); now += 10000; return ++attempts === 1 ? rejected(503, 'HTTP_ERROR', 3000) : success({}); }, release: () => { checkedOut--; } };
      }
    }
  });
  await api({ clientId: '1' }, null, READ_ROUTES[0], {});
  assert.deepEqual(seen.map(row => row[3]), [105000, 77000]);
  assert.equal(checkedOut, 0);
});

test('an expired queue budget issues no SQL and releases the acquired client', async () => {
  let now = 0, queries = 0, releases = 0;
  const api = createPostgresOzonApi({ now: () => now, pool: {
    query: async () => assert.fail('use checkout'),
    connect: async () => { now += 120001; return { query: async () => { queries++; return success({}); }, release: () => { releases++; } }; }
  } });
  await assert.rejects(api({ clientId: '1' }, null, READ_ROUTES[0], {}), { code: 'TIMEOUT' });
  assert.equal(queries, 0);
  assert.equal(releases, 1);
});

test('late successful SQL responses are rejected and failed SQL never leaks or retries its checkout', async () => {
  for (const failed of [false, true]) {
    let now = 0, connects = 0, releases = 0;
    const api = createPostgresOzonApi({ now: () => now, pool: {
      query: async () => assert.fail('use checkout'),
      connect: async () => { connects++; return {
        query: async () => { if (failed) throw Error('private server details'); now += 120001; return success({}); },
        release: () => { releases++; }
      }; }
    } });
    await assert.rejects(api({ clientId: '1' }, null, READ_ROUTES[0], {}), { code: failed ? 'NETWORK_ERROR' : 'TIMEOUT' });
    assert.equal(connects, 1);
    assert.equal(releases, 1);
  }
});

test('timed-out pool acquisition releases a late checkout without querying', async () => {
  let clockCalls = 0, finishConnect, releases = 0, queries = 0;
  const api = createPostgresOzonApi({ now: () => ++clockCalls <= 2 ? 0 : 119999, pool: {
    query: async () => assert.fail('use checkout'),
    connect: () => new Promise(resolve => { finishConnect = resolve; })
  } });
  // Keep the test loop alive while the production timeout is unref'ed.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(api({ clientId: '1' }, null, READ_ROUTES[0], {}), { code: 'TIMEOUT' });
    finishConnect({ query: async () => { queries++; return success({}); }, release: () => { releases++; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queries, 0);
    assert.equal(releases, 1);
  } finally { clearTimeout(keepAlive); }
});

test('SQL failures and HTTP error bodies never expose credentials and never retry unknown outcomes', async () => {
  let count = 0;
  const api = createPostgresOzonApi({ pool: { query: async () => { count++; throw Error('Api-Key: never-show-me; password=private'); } } });
  await assert.rejects(api({ clientId: '1' }, 'never-show-me', READ_ROUTES[0], {}), error => error.code === 'NETWORK_ERROR' && !String(error).includes('never-show-me') && !String(error).includes('private'));
  assert.equal(count, 1);
  const bad = createPostgresOzonApi({ pool: { query: async () => ({ rows: [{ response: { ok: false, status: 401, code: 'upstream secret', message: 'Api-Key: private' } }] }) } });
  await assert.rejects(bad({ clientId: '1' }, null, READ_ROUTES[0], {}), error => error.code === 'INVALID_RESPONSE' && error.status === 401 && !String(error).includes('private'));
});

test('provisional connection receives ciphertext and cannot select a route or return products', async () => {
  const seen = [], api = createPostgresOzonApi({ pool: { query: async (...args) => { seen.push(args); return success({ privateProduct: true }); } } });
  assert.equal(await api.verifyConnection({ clientId: '1' }, 'ZW5jcnlwdGVkLWtleQ=='), true);
  assert.match(seen[0][0], /verify_connection\(\$1::text,\$2::text,\$3::integer\)/u);
  assert.equal(seen[0][1][1], 'ZW5jcnlwdGVkLWtleQ==');
  assert.equal(seen[0][1].length, 3);
  await assert.rejects(api.verifyConnection({ clientId: '1' }, 'clear-text-key'), { code: 'INVALID_ARGUMENT' });
});

test('installer uses fixed definer code with restricted roles and no public function EXECUTE', () => {
  const sql = buildPostgresOzonHttpSql();
  assert.match(sql, /^BEGIN;/u);
  assert.match(sql, /LANGUAGE plpython3u VOLATILE PARALLEL UNSAFE SECURITY DEFINER/gu);
  assert.match(sql, /SET search_path = pg_catalog, pg_temp/gu);
  assert.match(sql, /REVOKE ALL ON FUNCTION "pult_ozon_http"\.request\(text,text,jsonb,integer\) FROM PUBLIC,"pult_app"/u);
  assert.match(sql, /ALTER FUNCTION "pult_ozon_http"\.request\(text,text,jsonb,integer\) OWNER TO "pult_admin"/u);
  assert.match(sql, /must not have schema CREATE/u);
  assert.match(sql, /return execute\(plpy, SD, store_id, route, payload, timeout_ms, '"pult"'\)/u);
  assert.match(sql, /return verify_connection\(plpy, SD, client_id, protected_key, timeout_ms\)/u);
  assert.doesNotMatch(sql, /GRANT (?:CREATE|USAGE ON LANGUAGE)/u);
  for (const options of [{ schema: 'public;DROP' }, { stateSchema: "pult'" }, { ownerRole: 'pult_app' }, { schema: 'pult' }]) assert.throws(() => buildPostgresOzonHttpSql(options), TypeError);
});

test('readiness fails closed on missing functions, public EXECUTE or privileged application', async () => {
  const safe = { prosecdef: true, provolatile: 'v', proparallel: 'u', proconfig: ['search_path=pg_catalog, pg_temp'], lanname: 'plpython3u', lanpltrusted: false, owner: 'pult_admin', owner_superuser: true, can_execute: true, can_create: false, can_create_database: false, owner_member: false, runtime_privileged: false, public_execute: false };
  for (const unsafe of [null, { public_execute: true }, { can_create: true }, { can_create_any_schema: true }, { owner_member: true }, { runtime_privileged: true }, { lanpltrusted: true }, { proconfig: ['search_path=public'] }, { prosecdef: false }]) {
    const api = createPostgresOzonApi({ pool: { query: async () => ({ rows: unsafe ? [{ ...safe, ...unsafe }, safe] : [] }) } });
    await assert.rejects(api.checkReadiness(), { code: 'OZON_SQL_NOT_READY' });
  }
  const api = createPostgresOzonApi({ pool: { query: async () => ({ rows: [safe, safe] }) } });
  assert.equal((await api.checkReadiness()).ready, true);
});

test('Python backend transport security and deadline tests', t => {
  const bundled = process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  const python = process.env.PULT_PYTHON || (bundled && fs.existsSync(bundled) ? bundled : 'python');
  const result = spawnSync(python, ['-B', path.join(__dirname, 'postgres-ozon-http-python.py')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.error?.code === 'ENOENT') return t.skip('Python runtime unavailable; installer must run these tests before enabling transport');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
