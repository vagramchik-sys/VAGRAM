'use strict';
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { requestMetrics } = require('./postgres-request-metrics.cjs');

const bootstrapError = () => Object.assign(new Error('Protected PostgreSQL bootstrap is unavailable or invalid'), { code: 'POSTGRES_BOOTSTRAP_INVALID' });

function unprotectWindows(ciphertext) {
  if (process.platform !== 'win32') return Promise.reject(bootstrapError());
  return new Promise((resolve, reject) => {
    const script = "Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $clear=[Security.Cryptography.ProtectedData]::Unprotect($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($clear))";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', finished = false;
    const timer = setTimeout(() => { child.kill(); finish(bootstrapError()); }, 10000);
    function finish(error, result) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    }
    child.on('error', () => finish(bootstrapError()));
    child.stdin.on('error', () => finish(bootstrapError()));
    child.stderr.on('data', () => {}); // DPAPI errors must never disclose input/config.
    child.stdout.on('data', chunk => {
      output += chunk.toString('ascii');
      if (output.length > 128 * 1024) { child.kill(); finish(bootstrapError()); }
    });
    child.on('close', code => {
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) return finish(bootstrapError());
      finish(null, Buffer.from(output, 'base64'));
    });
    child.stdin.end(ciphertext.toString('base64'));
  });
}

async function readApplicationBootstrap(file, { unprotect = unprotectWindows } = {}) {
  let plaintext;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024) throw bootstrapError();
    plaintext = await unprotect(await fs.readFile(file));
    if (!Buffer.isBuffer(plaintext) || plaintext.length > 64 * 1024) throw bootstrapError();
    const config = JSON.parse(plaintext.toString('utf8'));
    if (!config || config.host !== '127.0.0.1' || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
        config.user !== 'pult_app' || config.database !== 'pult' || typeof config.password !== 'string' || config.password.length < 24 || config.password.length > 1024) throw bootstrapError();
    return { host: config.host, port: config.port, user: config.user, database: config.database, password: config.password };
  } catch { throw bootstrapError(); }
  finally { if (Buffer.isBuffer(plaintext)) plaintext.fill(0); }
}

async function createApplicationPool({ bootstrapFile, unprotect, Pool, onUnavailable = () => {}, profile = 'runtime' } = {}) {
  if (!['runtime', 'ui', 'analytics', 'outbound'].includes(profile)) throw bootstrapError();
  const config = await readApplicationBootstrap(bootstrapFile, { unprotect });
  const PoolClass = Pool || require('pg').Pool;
  const settings = profile === 'ui'
    ? { application_name: 'pult_ui', max: 3, connectionTimeoutMillis: 15000 }
    : profile === 'analytics'
      ? { application_name: 'pult_analytics', max: 2, connectionTimeoutMillis: 15000 }
      : profile === 'outbound'
        ? { application_name: 'pult_ozon_http', max: 2, connectionTimeoutMillis: 15000 }
        : { application_name: 'pult', max: 10, connectionTimeoutMillis: 15000 };
  const pool = new PoolClass({ ...config, ...settings, idleTimeoutMillis: 10000, statement_timeout: profile === 'outbound' ? 125000 : 60000 });
  pool.on('error', () => { try { onUnavailable({ code: 'POSTGRES_UNAVAILABLE' }); } catch {} });
  try {
    const result = await pool.query('SELECT current_user AS role, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user');
    const role = result.rows?.[0];
    if (!role || role.role !== 'pult_app' || role.rolsuper || role.rolcreatedb || role.rolcreaterole) throw bootstrapError();
    return requestMetrics.instrumentPool(pool);
  } catch {
    await pool.end().catch(() => {});
    throw Object.assign(new Error('PostgreSQL application connection is unavailable or has excessive privileges'), { code: 'POSTGRES_UNAVAILABLE' });
  }
}

module.exports = { createApplicationPool, readApplicationBootstrap };
