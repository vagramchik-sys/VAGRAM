'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BOOTSTRAP = path.join(ROOT, '.private', 'postgres-setup', 'admin.dpapi');
const TEST_SUITES = Object.freeze({
  'archive-repository': 'test/postgres-archive-repository.test.cjs',
  'history-import': 'test/postgres-history-import.test.cjs',
  'history-repository': 'test/postgres-history-repository.test.cjs',
  'market-import': 'test/postgres-market-import.test.cjs',
  state: 'test/postgres-state.test.cjs',
  connection: 'test/postgres-connection.test.cjs',
  'json-repository': 'test/postgres-json-repository.test.cjs',
  'document-import': 'test/postgres-document-import.test.cjs',
  'write-fence': 'test/postgres-write-fence.test.cjs',
  'stock-repository': 'test/postgres-stock-repository.test.cjs'
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

function runTestFile(file, connectionUrl) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PULT_TEST_DATABASE_URL: connectionUrl };
    const child = spawn(process.execPath, ['--test', file], { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
    child.on('error', () => reject(runnerError('TEST_PROCESS_FAILED')));
    child.on('close', (code, signal) => resolve(code === 0 && !signal));
  });
}

async function writeCleanupRecord(invocationId, role, database, code) {
  const directory = path.join(ROOT, '.private', 'postgres-setup');
  const filename = path.join(directory, `test-cleanup-${invocationId}.json`);
  const record = { version: 1, invocationId, role, database, code, recordedAt: new Date().toISOString() };
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
  const database = `pult_test_${invocationId}`;
  const testPassword = crypto.randomBytes(36).toString('base64url');
  let config = await readAdminBootstrap(bootstrap), adminPool, ownedRole = false, ownedDatabase = false;
  let testsPassed = false, cleanupCode = null;
  try {
    adminPool = new Pool({ ...config, application_name: 'pult_test_runner', max: 1, connectionTimeoutMillis: 5000, statement_timeout: 60000 });
    const identity = await adminPool.query('SELECT current_user AS role,current_database() AS database,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');
    const current = identity.rows[0];
    if (!current || current.role !== 'pult_admin' || current.database !== 'postgres' || !current.rolsuper || !current.rolcreatedb || !current.rolcreaterole) throw runnerError('ADMIN_IDENTITY_INVALID');
    const collision = await adminPool.query('SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS role_exists,EXISTS(SELECT 1 FROM pg_database WHERE datname=$2) AS database_exists', [role, database]);
    if (collision.rows[0].role_exists || collision.rows[0].database_exists) throw runnerError('GENERATED_NAME_COLLISION');
    await adminPool.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${testPassword}'`);
    ownedRole = true;
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)} OWNER ${quoteIdentifier(role)} TEMPLATE template0 ENCODING 'UTF8'`);
    ownedDatabase = true;
    const connectionUrl = new URL('postgresql://127.0.0.1/');
    connectionUrl.port = String(config.port); connectionUrl.username = role; connectionUrl.password = testPassword; connectionUrl.pathname = '/' + database;
    testsPassed = true;
    for (const file of selectedFiles) {
      if (!await runTestFile(file, connectionUrl.toString())) testsPassed = false;
    }
  } finally {
    config = null;
    if (adminPool) {
      if (ownedDatabase) {
        try {
          await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
          await adminPool.query(`DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)`);
          ownedDatabase = false;
        } catch { cleanupCode = 'DROP_OWNED_DATABASE_FAILED'; }
      }
      if (ownedRole && !ownedDatabase) {
        try { await adminPool.query(`DROP ROLE ${quoteIdentifier(role)}`); ownedRole = false; }
        catch { cleanupCode ||= 'DROP_OWNED_ROLE_FAILED'; }
      }
      await adminPool.end().catch(() => { cleanupCode ||= 'ADMIN_POOL_CLOSE_FAILED'; });
    }
    if (cleanupCode) await writeCleanupRecord(invocationId, role, database, cleanupCode);
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
