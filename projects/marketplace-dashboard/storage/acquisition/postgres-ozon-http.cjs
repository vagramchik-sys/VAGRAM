'use strict';

// Only the administrator runs the SQL installer. Runtime calls carry a store ID,
// a read operation and JSON parameters; DPAPI credentials never leave PostgreSQL.
const fs = require('node:fs');
const path = require('node:path');
const { encodeJson } = require('../postgres-json-repository.cjs');

const READ_ROUTES = Object.freeze([
  '/v3/product/list', '/v3/product/info/list', '/v1/description-category/tree',
  '/v4/product/info/stocks', '/v1/finance/accrual/by-day', '/v1/finance/accrual/types',
  '/v1/analytics/data', '/v5/product/info/prices', '/v3/posting/fbo/list', '/v4/posting/fbs/list'
]);
const ROUTES = new Set(READ_ROUTES);
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;
const CODES = new Set(['INVALID_ARGUMENT', 'STORE_MISSING', 'CREDENTIAL_UNAVAILABLE', 'NETWORK_ERROR', 'TIMEOUT',
  'TLS_ERROR', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE', 'AUTH_FAILED', 'RATE_LIMITED', 'HTTP_ERROR']);
const identifier = value => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new TypeError('Invalid SQL identifier');
  return `"${value}"`;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function error(code, status, retryAfterMs) {
  const result = Object.assign(new Error(`Ozon database transport failed (${code})`), { code });
  if (Number.isInteger(status) && status >= 100 && status <= 599) result.status = status;
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) result.retryAfterMs = retryAfterMs;
  return result;
}

function buildPostgresOzonHttpSql({ schema = 'pult_ozon_http', stateSchema = 'pult', ownerRole = 'pult_admin', runtimeRole = 'pult_app' } = {}) {
  const ns = identifier(schema), state = identifier(stateSchema), owner = identifier(ownerRole), runtime = identifier(runtimeRole);
  if (schema === stateSchema || ownerRole === runtimeRole) throw new TypeError('Dedicated HTTP schema and separate owner are required');
  const source = fs.readFileSync(path.join(__dirname, 'postgres-ozon-http.py'), 'utf8');
  if (source.includes('$pult_ozon_python$')) throw new Error('Unexpected Python source delimiter');
  // Fail closed if application privileges would allow replacing the privileged
  // function, creating arbitrary code, or switching into the administrator role.
  return `BEGIN;
DO $pult_ozon_guard$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${ownerRole}' AND rolsuper) THEN
  RAISE EXCEPTION 'Ozon HTTP function owner must be the installation administrator';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${runtimeRole}' AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls)
  OR pg_catalog.pg_has_role('${runtimeRole}','${ownerRole}','MEMBER')
  OR pg_catalog.has_database_privilege('${runtimeRole}',pg_catalog.current_database(),'CREATE') THEN
  RAISE EXCEPTION 'Ozon HTTP runtime role is not restricted';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='${schema}' AND nspowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${ownerRole}')) THEN
  RAISE EXCEPTION 'Ozon HTTP schema has an unexpected owner';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%' AND pg_catalog.has_schema_privilege('${runtimeRole}',oid,'CREATE')) THEN
  RAISE EXCEPTION 'Ozon HTTP runtime role must not have schema CREATE';
 END IF;
END
$pult_ozon_guard$;
CREATE SCHEMA IF NOT EXISTS ${ns} AUTHORIZATION ${owner};
REVOKE ALL ON SCHEMA ${ns} FROM PUBLIC,${runtime};
GRANT USAGE ON SCHEMA ${ns} TO ${runtime};
CREATE OR REPLACE FUNCTION ${ns}.request(store_id text, route text, payload jsonb, timeout_ms integer DEFAULT 120000)
RETURNS jsonb
LANGUAGE plpython3u VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $pult_ozon_python$
${source}
return execute(plpy, SD, store_id, route, payload, timeout_ms, '${state}')
$pult_ozon_python$;
ALTER FUNCTION ${ns}.request(text,text,jsonb,integer) OWNER TO ${owner};
REVOKE ALL ON FUNCTION ${ns}.request(text,text,jsonb,integer) FROM PUBLIC,${runtime};
GRANT EXECUTE ON FUNCTION ${ns}.request(text,text,jsonb,integer) TO ${runtime};
COMMENT ON FUNCTION ${ns}.request(text,text,jsonb,integer) IS 'Bounded read-only Ozon HTTPS in PostgreSQL; fixed host, TLS verification, DPAPI CurrentUser credentials from SQL registry, sanitized errors.';
CREATE OR REPLACE FUNCTION ${ns}.verify_connection(client_id text, protected_key text, timeout_ms integer DEFAULT 120000)
RETURNS jsonb
LANGUAGE plpython3u VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $pult_ozon_python$
${source}
return verify_connection(plpy, SD, client_id, protected_key, timeout_ms)
$pult_ozon_python$;
ALTER FUNCTION ${ns}.verify_connection(text,text,integer) OWNER TO ${owner};
REVOKE ALL ON FUNCTION ${ns}.verify_connection(text,text,integer) FROM PUBLIC,${runtime};
GRANT EXECUTE ON FUNCTION ${ns}.verify_connection(text,text,integer) TO ${runtime};
COMMENT ON FUNCTION ${ns}.verify_connection(text,text,integer) IS 'Provisional DPAPI credential check: fixed product/list limit 1, no product data returned.';
COMMIT;`;
}

function createPostgresOzonApi({ pool, schema = 'pult_ozon_http', ownerRole = 'pult_admin', sleep = wait, now = () => performance.now() } = {}) {
  if (typeof pool?.query !== 'function' || typeof sleep !== 'function' || typeof now !== 'function') throw new TypeError('Acquisition SQL pool and clock are required');
  const ns = identifier(schema);
  identifier(ownerRole);
  const sql = `SELECT ${ns}.request($1::text,$2::text,$3::jsonb,$4::integer) AS response`;
  async function acquire(deadline) {
    if (typeof pool.connect !== 'function') return pool;
    const remaining = Math.floor(deadline - now());
    if (remaining < 1) throw error('TIMEOUT');
    let expired = false, timer;
    const pending = Promise.resolve().then(() => pool.connect()).then(client => {
      // pg.Pool cannot cancel a queued connect. If our deadline wins, release
      // the eventual checkout without issuing SQL or opening an Ozon socket.
      if (expired) { try { client.release(); } catch {} return null; }
      return client;
    });
    try {
      return await Promise.race([pending, new Promise((resolve, reject) => {
        timer = setTimeout(() => { expired = true; reject(error('TIMEOUT')); }, remaining);
        timer.unref?.();
      })]);
    } catch { throw error(expired || now() >= deadline ? 'TIMEOUT' : 'NETWORK_ERROR'); }
    finally { clearTimeout(timer); }
  }
  async function run(statement, values, route, verify = false) {
    const deadline = now() + REQUEST_TIMEOUT_MS;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (deadline - now() < 1) throw error('TIMEOUT');
      let envelope;
      const client = await acquire(deadline);
      try {
        // Queueing and reconnect time consume the same overall budget as HTTP
        // and retries. Never pass the pre-checkout budget to PostgreSQL.
        const remaining = Math.floor(deadline - now());
        if (remaining < 1) throw error('TIMEOUT');
        let result;
        try { result = await client.query(statement, [...values, Math.min(REQUEST_TIMEOUT_MS, remaining)]); }
        catch { throw error(now() >= deadline ? 'TIMEOUT' : 'NETWORK_ERROR'); }
        if (now() >= deadline) throw error('TIMEOUT');
        envelope = result?.rows?.[0]?.response;
      } finally { if (client !== pool) { try { client.release(); } catch { throw error('NETWORK_ERROR'); } } }
      if (!envelope || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean' || !Number.isInteger(envelope.status)) throw error('INVALID_RESPONSE');
      if (envelope.ok) {
        if (envelope.status < 200 || envelope.status > 299 || !verify && !Object.hasOwn(envelope, 'data')) throw error('INVALID_RESPONSE');
        return verify ? true : envelope.data;
      }
      const code = CODES.has(envelope.code) ? envelope.code : 'INVALID_RESPONSE';
      const retryAfterMs = Number.isFinite(envelope.retryAfterMs) && envelope.retryAfterMs >= 0 ? Math.min(envelope.retryAfterMs, 86400000) : undefined;
      if (envelope.status === 429 && route === '/v1/analytics/data') throw error('RATE_LIMITED', 429, Math.max(300000, retryAfterMs || 0));
      if ((envelope.status === 429 || envelope.status >= 500 && envelope.status <= 599) && attempt < 2) {
        const pause = Math.max(2000, retryAfterMs ?? 2000 * (attempt + 1));
        if (pause < deadline - now()) { await sleep(pause); continue; }
      }
      throw error(code, envelope.status, retryAfterMs);
    }
    throw error('HTTP_ERROR');
  }
  async function api(store, ignoredKey, route, payload) {
    const storeId = String(store?.clientId ?? '');
    if (!/^[0-9]{1,32}$/u.test(storeId) || !ROUTES.has(route) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw error('INVALID_ARGUMENT');
    let encoded;
    try { encoded = encodeJson(payload, MAX_REQUEST_BYTES).toString('utf8'); } catch { throw error('INVALID_ARGUMENT'); }
    return run(sql, [storeId, route, encoded], route);
  }
  api.usesDatabaseCredentials = true;
  api.verifyConnection = async (store, protectedKey) => {
    const storeId = String(store?.clientId ?? '');
    if (!/^[0-9]{1,32}$/u.test(storeId) || typeof protectedKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(protectedKey) || protectedKey.length > 65536) throw error('INVALID_ARGUMENT');
    return run(`SELECT ${ns}.verify_connection($1::text,$2::text,$3::integer) AS response`, [storeId, protectedKey], '/v3/product/list', true);
  };
  api.checkReadiness = async () => {
    try {
      const result = await pool.query(`SELECT p.proname,p.prosecdef,p.provolatile,p.proparallel,p.proconfig,l.lanname,l.lanpltrusted,
        owner.rolname AS owner,owner.rolsuper AS owner_superuser,
        pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE') AS can_execute,
        pg_catalog.has_schema_privilege(current_user,p.pronamespace,'CREATE') AS can_create,
        EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%' AND pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE')) AS can_create_any_schema,
        pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CREATE') AS can_create_database,
        pg_catalog.pg_has_role(current_user,owner.oid,'MEMBER') AS owner_member,
        (runtime.rolsuper OR runtime.rolcreatedb OR runtime.rolcreaterole OR runtime.rolbypassrls) AS runtime_privileged,
        EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
        JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner
        JOIN pg_catalog.pg_roles runtime ON runtime.rolname=current_user
        WHERE p.oid IN (pg_catalog.to_regprocedure($1),pg_catalog.to_regprocedure($2))`,
      [`${ns}.request(text,text,jsonb,integer)`, `${ns}.verify_connection(text,text,integer)`]);
      if (result?.rows?.length !== 2 || result.rows.some(row => !row.prosecdef || row.provolatile !== 'v' || row.proparallel !== 'u' ||
        row.lanname !== 'plpython3u' || row.lanpltrusted || row.owner !== ownerRole || !row.owner_superuser || !row.can_execute ||
        row.can_create || row.can_create_any_schema || row.can_create_database || row.owner_member || row.runtime_privileged || row.public_execute ||
        !row.proconfig?.includes('search_path=pg_catalog, pg_temp'))) throw new Error();
      return Object.freeze({ ready: true, transport: 'postgres-plpython-https', host: 'api-seller.ozon.ru', timeoutMs: REQUEST_TIMEOUT_MS });
    } catch { throw Object.assign(new Error('PostgreSQL Ozon HTTP transport is not ready'), { code: 'OZON_SQL_NOT_READY' }); }
  };
  return Object.freeze(api);
}

module.exports = { createPostgresOzonApi, buildPostgresOzonHttpSql, READ_ROUTES, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS };
