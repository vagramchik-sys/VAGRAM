'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createApplicationPool } = require('../storage/postgres-connection.cjs');
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_EXTENSIONS = new Set(['.html', '.css', '.js', '.svg', '.png']);
const fail = code => { throw Object.assign(new Error(code), { code }); };

function options(args) {
  let port = 4317, partnerPort = 4319, checkOnly = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--check') checkOnly = true;
    else if (args[index] === '--port' && /^(0|[1-9][0-9]*)$/.test(args[index + 1] || '')) port = Number(args[++index]);
    else if (args[index] === '--partner-port' && /^(0|[1-9][0-9]*)$/.test(args[index + 1] || '')) partnerPort = Number(args[++index]);
    else fail('INVALID_OPTIONS');
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || (port > 0 && port < 1024)) fail('INVALID_PORT');
  if (!Number.isSafeInteger(partnerPort) || partnerPort < 0 || partnerPort > 65535 || (partnerPort > 0 && partnerPort < 1024)) fail('INVALID_PORT');
  return { port, partnerPort, checkOnly };
}

async function publicFiles(staticDir) {
  const stat = await fs.lstat(staticDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_STATIC_DIRECTORY');
  const root = await fs.realpath(staticDir), result = [];
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name), relative = prefix + entry.name;
      if (entry.isSymbolicLink()) fail('UNSAFE_STATIC_LINK');
      if (entry.isDirectory()) await visit(file, relative + '/');
      else if (entry.isFile() && PUBLIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const resolved = await fs.realpath(file);
        if (!resolved.startsWith(root + path.sep)) fail('UNSAFE_STATIC_PATH');
        result.push(relative);
      }
    }
  }
  await visit(root);
  if (!result.includes('index.html') || !result.includes('command-transport.js')) fail('STATIC_FILES_INCOMPLETE');
  return result.sort();
}

async function launch({ port = 4317, partnerPort = 4319, checkOnly = false,
  staticDir = path.join(ROOT, 'dist'),
  bootstrapFile = path.join(ROOT, '.private/postgres-setup/application.dpapi'),
  poolFactory = createApplicationPool,
  createApplication = value => require('../storage/postgres-application.cjs').createPostgresApplication(value)
} = {}) {
  const staticFiles = await publicFiles(staticDir);
  let pool, readPool, analyticsPool, ozonHttpPool, running, closePromise;
  function close() {
    if (!closePromise) closePromise = (async () => {
      try { await running?.close(); }
      finally {
        const pools = [...new Set([ozonHttpPool, analyticsPool, readPool, pool].filter(Boolean))];
        const results = await Promise.allSettled(pools.map(value => value.end()));
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      }
    })();
    return closePromise;
  }
  try {
    pool = await poolFactory({ bootstrapFile, profile: 'runtime' });
    readPool = await poolFactory({ bootstrapFile, profile: 'ui' });
    analyticsPool = await poolFactory({ bootstrapFile, profile: 'analytics' });
    ozonHttpPool = await poolFactory({ bootstrapFile, profile: 'outbound' });
    const app = await createApplication({ pool, readPool, analyticsPool, ozonHttpPool, staticDir, staticFiles, partnerPort });
    if (typeof app?.readiness !== 'function' || typeof app?.start !== 'function') fail('APPLICATION_CONTRACT_INVALID');
    const ready = await app.readiness();
    if (ready?.ready !== true || !Array.isArray(ready.missingAdapters) || ready.missingAdapters.length) fail('RUNTIME_NOT_READY');
    if (checkOnly) { await close(); return { checked: true, close }; }
    running = await app.start({ port });
    if (typeof running?.close !== 'function' || typeof running.origin !== 'string') fail('SERVER_CONTRACT_INVALID');
    return { origin: running.origin, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}

async function main() {
  const settings = options(process.argv.slice(2));
  // Large existing snapshots require the explicit heap budget in npm start:postgres.
  if (!settings.checkOnly && require('node:v8').getHeapStatistics().heap_size_limit < 6 * 1024 * 1024 * 1024) fail('HEAP_BUDGET_REQUIRED');
  const app = await launch(settings);
  if (settings.checkOnly) { console.log('PostgreSQL runtime readiness verified.'); return; }
  console.log(app.origin);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await app.close(); }
    catch { console.error('PULT_SHUTDOWN_FAILED'); process.exitCode = 1; }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { launch, publicFiles, options };
if (require.main === module) main().catch(error => {
  const code = /^[A-Z_]+$/.test(error.code || '') ? error.code : 'PULT_START_FAILED';
  console.error(code === 'HEAP_BUDGET_REQUIRED' ? 'Запустите Пульт командой npm run start:postgres.' : code);
  process.exitCode = 1;
});
