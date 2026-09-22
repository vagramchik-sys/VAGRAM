'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BOOTSTRAP = path.join(ROOT, '.private', 'postgres-setup', 'admin.dpapi');
const TEST_SUITES = Object.freeze({
  xway: 'test/postgres-xway.test.cjs',
  'archive-repository': 'test/postgres-archive-repository.test.cjs',
  'history-import': 'test/postgres-history-import.test.cjs',
  'history-repository': 'test/postgres-history-repository.test.cjs',
  'history-parity': 'test/postgres-history-parity.test.cjs',
  'journaled-history': 'test/postgres-journaled-history.test.cjs',
  'journaled-archive': 'test/postgres-journaled-archive.test.cjs',
  'market-import': 'test/postgres-market-import.test.cjs',
  'market-writer': 'test/postgres-market-writer.test.cjs',
  'ledger-refresh': 'test/postgres-ledger-refresh.test.cjs',
  'status-readers': 'test/postgres-status-readers.test.cjs',
  'live-repository': 'test/postgres-live-repository.test.cjs',
  'live-scheduler': 'test/postgres-live-scheduler.test.cjs',
  'live-sources': 'test/postgres-live-sources.test.cjs',
  'live-state-store': 'test/postgres-live-state-store.test.cjs',
  'live-market': 'test/postgres-live-market.test.cjs',
  'live-ledger-refresh': 'test/postgres-live-ledger-refresh.test.cjs',
  'live-migration': 'test/postgres-live-migration.test.cjs',
  'live-history-capture': 'test/postgres-live-history-capture.test.cjs',
  state: 'test/postgres-state.test.cjs',
  'state-batch': 'test/postgres-state-batch.test.cjs',
  connection: 'test/postgres-connection.test.cjs',
  'json-repository': 'test/postgres-json-repository.test.cjs',
  'document-import': 'test/postgres-document-import.test.cjs',
  'write-fence': 'test/postgres-write-fence.test.cjs',
  'stock-repository': 'test/postgres-stock-repository.test.cjs',
  'market-repository': 'test/postgres-market-repository.test.cjs',
  'buyer-order-segments': 'test/postgres-buyer-order-segments.test.cjs',
  'buyer-product-segments': 'test/postgres-buyer-product-segments.test.cjs',
  'profit-series': 'test/postgres-profit-series.test.cjs',
  'wb-economics': 'test/postgres-wb-economics.test.cjs',
  conversion: 'test/postgres-conversion.test.cjs',
  truestats: 'test/postgres-truestats.test.cjs',
  'analytics-composition': 'test/postgres-analytics-composition.test.cjs',
  'report-routes': 'test/postgres-report-routes.test.cjs',
  'derived-capture': 'test/postgres-derived-capture.test.cjs',
  'derived-inputs': 'test/postgres-derived-inputs.test.cjs',
  'marketplace-transport': 'test/postgres-marketplace-transport.test.cjs',
  'order-category-capture': 'test/postgres-order-category-capture.test.cjs',
  'store-commands': 'test/postgres-store-commands.test.cjs',
  'store-routes': 'test/postgres-store-routes.test.cjs',
  'source-providers': 'test/postgres-source-providers.test.cjs',
  'stock-history-writer': 'test/postgres-stock-history-writer.test.cjs',
  'stock-history-parity': 'test/postgres-stock-history-parity.test.cjs',
  'document-journal': 'test/postgres-document-journal.test.cjs',
  'document-replay': 'test/postgres-document-replay.test.cjs',
  'runtime-journal': 'test/postgres-runtime-journal.test.cjs',
  'runtime-replay': 'test/postgres-runtime-replay.test.cjs',
  'b2b-queue': 'test/postgres-b2b-queue.test.cjs',
  'b2b-runner': 'test/postgres-b2b-runner.test.cjs',
  'b2b-server': 'test/postgres-b2b-server.test.cjs',
  ideas: 'test/postgres-ideas.test.cjs',
  procurement: 'test/postgres-procurement.test.cjs',
  'workspace-tools': 'test/postgres-workspace-tools.test.cjs',
  management: 'test/postgres-management.test.cjs',
  'finance-register': 'test/postgres-finance-register.test.cjs',
  'finance-documents': 'test/postgres-finance-documents.test.cjs',
  'finance-document-routes': 'test/postgres-finance-document-routes.test.cjs',
  'supplier-portals': 'test/postgres-supplier-portals.test.cjs',
  'partner-workspace': 'test/postgres-partner-workspace.test.cjs',
  'partner-tools': 'test/postgres-partner-tools.test.cjs',
  'partner-server': 'test/postgres-partner-server.test.cjs',
  'owner-routes': 'test/postgres-owner-routes.test.cjs',
  'charity-workspace': 'test/postgres-charity-workspace.test.cjs',
  'charity-tools': 'test/postgres-charity-tools.test.cjs',
  'product-type-registry': 'test/postgres-product-type-registry.test.cjs',
  intraday: 'test/postgres-intraday.test.cjs',
  'order-category-daily': 'test/postgres-order-category-daily.test.cjs',
  'category-sales': 'test/postgres-category-sales.test.cjs',
  'ozon-acquisition': 'test/postgres-ozon-snapshot.test.cjs',
  'wb-acquisition': 'test/postgres-wb-snapshot.test.cjs',
  'market-acquisition': 'test/postgres-market-acquisition.test.cjs',
  'acquisition-dispatcher': 'test/postgres-acquisition-dispatcher.test.cjs',
  'acquisition-routes': 'test/postgres-acquisition-routes.test.cjs',
  'info-routes': 'test/postgres-info-routes.test.cjs',
  'cadence-producer': 'test/postgres-cadence-producer.test.cjs',
  core: 'test/postgres-core.test.cjs',
  'server-postgres': 'test/postgres-server.test.cjs',
  'server-composition': 'test/postgres-server-composition.test.cjs',
  application: 'test/postgres-application.test.cjs',
  backup: 'test/postgres-backup.test.cjs'
});
const TEST_FILES = Object.values(TEST_SUITES);

const runnerError = code => Object.assign(new Error(code), { code });
const quoteIdentifier = value => `"${value}"`; // generated names contain only [a-z0-9_].

function unprotectWindows(ciphertext) {
  if (process.platform !== 'win32') return Promise.reject(runnerError('DPAPI_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    const script = "Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $clear=[Security.Cryptography.ProtectedData]::Unprotect($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($clear)); [Array]::Clear($clear,0,$clear.Length)";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(runnerError('DPAPI_TIMEOUT')); }, 10000);
    child.on('error', () => finish(runnerError('DPAPI_FAILED')));
    child.stdin.on('error', () => finish(runnerError('DPAPI_FAILED')));
    child.stdout.on('data', chunk => {
      output += chunk.toString('ascii');
      if (output.length > 128 * 1024) { child.kill(); finish(runnerError('DPAPI_OUTPUT_INVALID')); }
    });
    child.on('close', code => {
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(output)) return finish(runnerError('DPAPI_FAILED'));
      const plaintext = Buffer.from(output, 'base64'); output = '';
      finish(null, plaintext);
    });
    child.stdin.end(ciphertext.toString('base64'));
  });
}

async function readAdminBootstrap(filename) {
  let plaintext;
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024) throw runnerError('BOOTSTRAP_INVALID');
    plaintext = await unprotectWindows(await fs.readFile(filename));
    if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > 64 * 1024) throw runnerError('BOOTSTRAP_INVALID');
    const value = JSON.parse(plaintext.toString('utf8'));
    if (!value || !['127.0.0.1', 'localhost'].includes(value.host) || value.port !== 5441 || value.user !== 'pult_admin' || value.database !== 'postgres' || typeof value.password !== 'string' || value.password.length < 24 || value.password.length > 1024) throw runnerError('BOOTSTRAP_INVALID');
    return { host: value.host, port: value.port, user: value.user, database: value.database, password: value.password };
  } catch (error) {
    if (error?.code && /^[A-Z_]+$/u.test(error.code)) throw error;
    throw runnerError('BOOTSTRAP_INVALID');
  } finally { if (Buffer.isBuffer(plaintext)) plaintext.fill(0); }
}

function runTestFile(file, connectionUrl, restoreUrl, restrictedUrl) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PULT_TEST_DATABASE_URL: connectionUrl };
    delete env.PULT_TEST_RESTORE_DATABASE_URL;
    if (restoreUrl) env.PULT_TEST_RESTORE_DATABASE_URL = restoreUrl;
    if (restrictedUrl) env.PULT_TEST_RESTRICTED_DATABASE_URL = restrictedUrl;
    else delete env.PULT_TEST_RESTRICTED_DATABASE_URL;
    const child = spawn(process.execPath, ['--test', file], { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
    child.on('error', () => reject(runnerError('TEST_PROCESS_FAILED')));
    child.on('close', (code, signal) => resolve(code === 0 && !signal));
  });
}

async function writeCleanupRecord(invocationId, role, database, code, restoreDatabase) {
  const directory = path.join(ROOT, '.private', 'postgres-setup');
  const filename = path.join(directory, `test-cleanup-${invocationId}.json`);
  const record = { version: 1, invocationId, role, database, restoreDatabase, code, recordedAt: new Date().toISOString() };
  try { await fs.writeFile(filename, JSON.stringify(record) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); } catch {}
}

async function main() {
  let bootstrap = DEFAULT_BOOTSTRAP, selectedFiles = TEST_FILES;
  const selectedSuites = new Set();
  for (let index = 2; index < process.argv.length; index++) {
    const option = process.argv[index], value = process.argv[++index];
    if (!value || option === '--suite' && !TEST_SUITES[value] || !['--suite', '--bootstrap'].includes(option)) throw runnerError('USAGE');
    if (option === '--suite') selectedSuites.add(TEST_SUITES[value]);
    else bootstrap = path.resolve(value);
  }
  if (selectedSuites.size) selectedFiles = [...selectedSuites];
  const invocationId = crypto.randomBytes(12).toString('hex');
  const role = `pult_test_${invocationId}`;
  const appRole = `${role}_app`;
  const database = `pult_test_${invocationId}`;
  const restoreDatabase = `pult_test_${invocationId}_restore`;
  const needsRestore = selectedFiles.includes(TEST_SUITES.backup);
  const testPassword = crypto.randomBytes(36).toString('base64url');
  const appPassword = crypto.randomBytes(36).toString('base64url');
  let config = await readAdminBootstrap(bootstrap), adminPool, ownedRole = false, ownedAppRole = false, ownedDatabase = false, ownedRestore = false;
  let testsPassed = false, cleanupCode = null;
  try {
    adminPool = new Pool({ ...config, application_name: 'pult_test_runner', max: 1, connectionTimeoutMillis: 5000, statement_timeout: 60000 });
    const identity = await adminPool.query('SELECT current_user AS role,current_database() AS database,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');
    const current = identity.rows[0];
    if (!current || current.role !== 'pult_admin' || current.database !== 'postgres' || !current.rolsuper || !current.rolcreatedb || !current.rolcreaterole) throw runnerError('ADMIN_IDENTITY_INVALID');
    const collision = await adminPool.query('SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])) AS role_exists,EXISTS(SELECT 1 FROM pg_database WHERE datname=ANY($2::text[])) AS database_exists', [[role, appRole], [database, restoreDatabase]]);
    if (collision.rows[0].role_exists || collision.rows[0].database_exists) throw runnerError('GENERATED_NAME_COLLISION');
    await adminPool.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${testPassword}'`);
    ownedRole = true;
    await adminPool.query(`CREATE ROLE ${quoteIdentifier(appRole)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${appPassword}'`);
    ownedAppRole = true;
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)} OWNER ${quoteIdentifier(role)} TEMPLATE template0 ENCODING 'UTF8'`);
    ownedDatabase = true;
    if (needsRestore) {
      await adminPool.query(`CREATE DATABASE ${quoteIdentifier(restoreDatabase)} OWNER ${quoteIdentifier(role)} TEMPLATE template0 ENCODING 'UTF8'`);
      ownedRestore = true;
    }
    const connectionUrl = new URL('postgresql://127.0.0.1/');
    connectionUrl.port = String(config.port); connectionUrl.username = role; connectionUrl.password = testPassword; connectionUrl.pathname = '/' + database;
    const restoreUrl = new URL(connectionUrl); restoreUrl.pathname = '/' + restoreDatabase;
    const restrictedUrl = new URL(connectionUrl); restrictedUrl.username = appRole; restrictedUrl.password = appPassword;
    testsPassed = true;
    for (const file of selectedFiles) {
      const needsRestricted = [TEST_SUITES.xway, TEST_SUITES.state, TEST_SUITES['state-batch'], TEST_SUITES['market-writer'], TEST_SUITES['finance-documents'], TEST_SUITES['finance-document-routes'], TEST_SUITES['source-providers'], TEST_SUITES['store-commands'], TEST_SUITES['live-repository']].includes(file);
      if (!await runTestFile(file, connectionUrl.toString(), file === TEST_SUITES.backup ? restoreUrl.toString() : undefined, needsRestricted ? restrictedUrl.toString() : undefined)) testsPassed = false;
    }
  } finally {
    config = null;
    if (adminPool) {
      if (ownedRestore) {
        try {
          await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [restoreDatabase]);
          await adminPool.query(`DROP DATABASE ${quoteIdentifier(restoreDatabase)} WITH (FORCE)`);
          ownedRestore = false;
        } catch { cleanupCode = 'DROP_OWNED_RESTORE_DATABASE_FAILED'; }
      }
      if (ownedDatabase) {
        try {
          await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
          await adminPool.query(`DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)`);
          ownedDatabase = false;
        } catch { cleanupCode = 'DROP_OWNED_DATABASE_FAILED'; }
      }
      if (ownedAppRole && !ownedDatabase && !ownedRestore) {
        try { await adminPool.query(`DROP ROLE ${quoteIdentifier(appRole)}`); ownedAppRole = false; }
        catch { cleanupCode ||= 'DROP_OWNED_APP_ROLE_FAILED'; }
      }
      if (ownedRole && !ownedAppRole && !ownedDatabase && !ownedRestore) {
        try { await adminPool.query(`DROP ROLE ${quoteIdentifier(role)}`); ownedRole = false; }
        catch { cleanupCode ||= 'DROP_OWNED_ROLE_FAILED'; }
      }
      await adminPool.end().catch(() => { cleanupCode ||= 'ADMIN_POOL_CLOSE_FAILED'; });
    }
    if (cleanupCode) await writeCleanupRecord(invocationId, role, database, cleanupCode, needsRestore ? restoreDatabase : undefined);
  }
  if (cleanupCode) throw runnerError(cleanupCode);
  if (!testsPassed) throw runnerError('POSTGRES_TESTS_FAILED');
  console.log(`PostgreSQL integration tests passed: ${selectedFiles.length} files; disposable database removed.`);
}

main().catch(error => {
  const code = error?.code && /^[A-Z_]+$/u.test(error.code) ? error.code : 'TEST_RUNNER_FAILED';
  console.error(`PostgreSQL test runner failed: ${code}`);
  process.exitCode = 1;
});
