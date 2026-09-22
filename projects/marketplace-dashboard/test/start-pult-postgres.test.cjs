'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { launch, publicFiles, options } = require('../scripts/start-pult-postgres.cjs');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-cli-static-'));
  t.after(async () => { const real = await fs.realpath(directory); assert.equal(path.dirname(real), await fs.realpath(os.tmpdir())); await fs.rm(real, { recursive: true }); });
  for (const name of ['index.html','command-transport.js','ignored.json','.secret.js']) await fs.writeFile(path.join(directory, name), 'test');
  return directory;
}
test('check mode verifies actual composition, includes command transport and never starts listeners', async t => {
  const staticDir = await fixture(t); let started = 0, ended = 0; const profiles = [];
  const result = await launch({ staticDir, checkOnly: true, poolFactory: async options => { profiles.push(options.profile); return { profile: options.profile, end: async () => { ended++; } }; }, createApplication: async value => {
    assert.deepEqual(value.staticFiles, ['command-transport.js','index.html']);
    assert.equal(value.pool.profile, 'runtime'); assert.equal(value.readPool.profile, 'ui'); assert.notEqual(value.pool, value.readPool);
    return { readiness: async () => ({ ready: true, missingAdapters: [] }), start: async () => { started++; } };
  } });
  assert.equal(result.checked, true); assert.equal(started, 0); assert.equal(ended, 2); assert.deepEqual(profiles, ['runtime','ui']);
});
test('runtime drains before pool close and repeated close is harmless', async t => {
  const order = [], staticDir = await fixture(t);
  let finishDrain;
  const drain = new Promise(resolve => { finishDrain = resolve; });
  const app = await launch({ staticDir, port: 4318, poolFactory: async ({ profile }) => ({ end: async () => order.push(profile) }), createApplication: async () => ({
    readiness: async () => ({ ready: true, missingAdapters: [] }), start: async ({ port }) => {
      assert.equal(port, 4318); return { origin: 'http://127.0.0.1:4318', close: async () => { order.push('server'); await drain; } };
    }
  }) });
  const first = app.close(), second = app.close();
  assert.equal(first, second); assert.deepEqual(order, ['server']);
  finishDrain(); await first; await second; assert.deepEqual(order, ['server','ui','runtime']);
});
test('incomplete wiring and startup failure release the application pool', async t => {
  const staticDir = await fixture(t); let ended = 0;
  const poolFactory = async () => ({ end: async () => { ended++; } });
  await assert.rejects(launch({ staticDir, poolFactory, createApplication: async () => ({ readiness: async () => ({ ready: false, missingAdapters: ['unfinished'] }), start() { throw Error('must not start'); } }) }), { code: 'RUNTIME_NOT_READY' });
  await assert.rejects(launch({ staticDir, poolFactory, createApplication: async () => ({ readiness: async () => ({ ready: true, missingAdapters: [] }), start() { throw Object.assign(Error('port busy'), { code: 'EADDRINUSE' }); } }) }), { code: 'EADDRINUSE' });
  assert.equal(ended, 4);
});
test('CLI rejects ambiguous options and requires complete public assets', async t => {
  assert.deepEqual(options(['--check','--port','0','--partner-port','0']), { checkOnly: true, port: 0, partnerPort: 0 });
  assert.equal(options([]).partnerPort, 4319);
  for (const args of [['--port','80'],['--port','-1'],['--port','1.5'],['--secret','value']]) assert.throws(() => options(args));
  const staticDir = await fixture(t);
  await fs.unlink(path.join(staticDir, 'command-transport.js'));
  await assert.rejects(publicFiles(staticDir), { code: 'STATIC_FILES_INCOMPLETE' });
});
