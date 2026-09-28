'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const v8 = require('node:v8');
const { launch: launchPostgres } = require('./start-pult-postgres.cjs');
const { createModuleRegistry } = require('../modules/module-registry.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BOOTSTRAP = path.join('.private', 'postgres-setup', 'application.dpapi');
const RESERVED_PORTS = new Set([4317, 4319]);
const PREVIEW_ASSETS = Object.freeze({
  '/module-ui.css': ['module-ui.css', 'text/css; charset=utf-8'],
  '/module-ui.js': ['module-ui.js', 'application/javascript; charset=utf-8'],
  '/seller-shell.css': ['seller-shell.css', 'text/css; charset=utf-8']
});
const fail = code => { throw Object.assign(new Error(code), { code }); };

function parsePort(value) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value || '')) fail('INVALID_DEV_PORT');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || (port > 0 && port < 1024) || RESERVED_PORTS.has(port)) fail('INVALID_DEV_PORT');
  return port;
}

function options(args) {
  const result = { port: 0, partnerPort: 0, mode: 'check', bootstrapFile: null, runtimeRoot: null };
  let selectedMode = false, partnerPortSelected = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--check', '--preview', '--run-shared-data'].includes(argument)) {
      if (selectedMode) fail('AMBIGUOUS_DEV_MODE');
      selectedMode = true;
      result.mode = argument === '--preview' ? 'preview' : argument === '--run-shared-data' ? 'shared' : 'check';
    }
    else if (argument === '--port') result.port = parsePort(args[++index]);
    else if (argument === '--partner-port') { partnerPortSelected = true; result.partnerPort = parsePort(args[++index]); }
    else if (argument === '--bootstrap-file') result.bootstrapFile = args[++index] || fail('INVALID_DEV_OPTIONS');
    else if (argument === '--runtime-root') result.runtimeRoot = args[++index] || fail('INVALID_DEV_OPTIONS');
    else fail('INVALID_DEV_OPTIONS');
  }
  if (result.port > 0 && result.port === result.partnerPort) fail('INVALID_DEV_PORT');
  if (result.bootstrapFile && result.runtimeRoot) fail('AMBIGUOUS_DEV_CONFIG');
  if (result.mode === 'preview' && (result.bootstrapFile || result.runtimeRoot || partnerPortSelected)) fail('PREVIEW_CONFIG_FORBIDDEN');
  return result;
}

function configCandidates(settings, env = process.env, projectRoot = ROOT) {
  const explicitBootstrap = settings.bootstrapFile || env.PULT_DEV_BOOTSTRAP_FILE;
  const runtimeRoot = settings.runtimeRoot || env.PULT_RUNTIME_ROOT;
  if (explicitBootstrap && runtimeRoot) fail('AMBIGUOUS_DEV_CONFIG');
  if (explicitBootstrap) return [path.resolve(explicitBootstrap)];
  if (runtimeRoot) return [path.resolve(runtimeRoot, DEFAULT_BOOTSTRAP)];
  return [path.resolve(projectRoot, DEFAULT_BOOTSTRAP)];
}

async function resolveBootstrap(settings, dependencies = {}) {
  const access = dependencies.lstat || fs.lstat;
  const candidates = configCandidates(settings, dependencies.env, dependencies.projectRoot);
  for (const candidate of candidates) {
    try {
      const stat = await access(candidate);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 64 * 1024) return candidate;
    } catch {}
  }
  fail('DEV_BOOTSTRAP_UNAVAILABLE');
}

function html(value) {
  return String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function launchPreview({ port = 0, modulesDir = path.join(ROOT, 'modules'), distDir = path.join(ROOT, 'dist'), registryFactory = createModuleRegistry } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || (port > 0 && port < 1024) || RESERVED_PORTS.has(port)) fail('INVALID_DEV_PORT');
  const registry = registryFactory({ modulesDir, development: true, ctx: {} });
  const page = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Developer modules</title>' +
    '<body><main><h1>Developer modules</h1><p>Preview без базы данных и фоновых задач.</p><ul>' +
    registry.publicModules.map(module => `<li><a href="${html(module.route)}">${html(module.title)}</a> <code>${html(module.id)}</code></li>`).join('') +
    '</ul><p><a href="/api/developer/modules">Registry API</a></p></main></body></html>';
  async function serveSharedAsset(req, res, url) {
    const asset = PREVIEW_ASSETS[url.pathname];
    if (!asset || req.method !== 'GET') return false;
    try {
      const rootStat = await fs.lstat(distDir);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
      const root = await fs.realpath(distDir), filename = path.join(root, asset[0]);
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return false;
      const real = await fs.realpath(filename);
      if (real !== filename || !real.startsWith(root + path.sep)) return false;
      const bytes = await fs.readFile(real);
      res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
      res.end(bytes); return true;
    } catch { return false; }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page); return;
      }
      if (await serveSharedAsset(req, res, url) || await registry.handle(req, res, url) || await registry.serveAsset(req, res, url)) return;
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('{"error":"Not found"}');
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('{"error":"Preview request failed"}');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string' || RESERVED_PORTS.has(address.port)) {
    await new Promise(resolve => server.close(resolve)); fail('INVALID_DEV_PORT');
  }
  let closePromise;
  return Object.freeze({
    origin: `http://127.0.0.1:${address.port}`,
    close() {
      if (!closePromise) closePromise = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      return closePromise;
    }
  });
}

async function withDevModules(operation, environment = process.env) {
  const present = Object.hasOwn(environment, 'PULT_DEV_MODULES'), previous = environment.PULT_DEV_MODULES;
  environment.PULT_DEV_MODULES = '1';
  try { return await operation(); }
  finally {
    if (present) environment.PULT_DEV_MODULES = previous;
    else delete environment.PULT_DEV_MODULES;
  }
}

async function execute(settings, dependencies = {}) {
  const environment = dependencies.processEnv || process.env;
  if (settings.mode === 'preview') return withDevModules(() => (dependencies.previewLaunch || launchPreview)({
    port: settings.port,
    modulesDir: dependencies.modulesDir,
    distDir: dependencies.distDir,
    registryFactory: dependencies.registryFactory
  }), environment);
  const bootstrapFile = await resolveBootstrap(settings, dependencies);
  if (settings.mode === 'shared' && (dependencies.heapLimit || v8.getHeapStatistics().heap_size_limit) < 6 * 1024 * 1024 * 1024) fail('HEAP_BUDGET_REQUIRED');
  const launch = dependencies.launch || launchPostgres;
  const start = () => launch({
    port: settings.port,
    partnerPort: settings.partnerPort,
    checkOnly: settings.mode !== 'shared',
    bootstrapFile
  });
  return settings.mode === 'shared' ? withDevModules(start, environment) : start();
}

async function main() {
  const settings = options(process.argv.slice(2));
  const app = await execute(settings);
  if (settings.mode === 'check') {
    console.log('Development runtime configuration verified; no listener was started.');
    return;
  }
  console.log(app.origin);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await app.close(); }
    catch { process.exitCode = 1; console.error('DEV_RUNTIME_SHUTDOWN_FAILED'); }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { configCandidates, execute, launchPreview, options, resolveBootstrap };
if (require.main === module) main().catch(error => {
  const code = /^[A-Z_]+$/u.test(error.code || '') ? error.code : 'DEV_RUNTIME_START_FAILED';
  console.error(code);
  process.exitCode = 1;
});
