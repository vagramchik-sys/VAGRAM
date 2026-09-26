'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configCandidates, execute, launchPreview, options, resolveBootstrap } = require('../scripts/dev-isolated.cjs');

const fileStat = { isFile: () => true, isSymbolicLink: () => false, size: 128 };

test('defaults to check-only on ephemeral ports and rejects production listeners', () => {
  assert.deepEqual(options([]), { port: 0, partnerPort: 0, mode: 'check', bootstrapFile: null, runtimeRoot: null });
  assert.equal(options(['--run-shared-data', '--port', '14317', '--partner-port', '14319']).mode, 'shared');
  for (const args of [['--port', '4317'], ['--partner-port', '4319'], ['--port', '80'], ['--port', '-1'], ['--port', '1234', '--partner-port', '1234']]) {
    assert.throws(() => options(args), { code: 'INVALID_DEV_PORT' });
  }
  assert.throws(() => options(['--preview', '--run-shared-data']), { code: 'AMBIGUOUS_DEV_MODE' });
  assert.throws(() => options(['--preview', '--bootstrap-file', 'unused']), { code: 'PREVIEW_CONFIG_FORBIDDEN' });
});

test('resolves an existing DPAPI bootstrap by reference without reading or copying it', async () => {
  const root = path.resolve('synthetic-runtime');
  const settings = options(['--runtime-root', root]);
  const expected = path.join(root, '.private', 'postgres-setup', 'application.dpapi');
  const touched = [];
  assert.deepEqual(configCandidates(settings, {}, path.resolve('unused')), [expected]);
  const resolved = await resolveBootstrap(settings, { env: {}, lstat: async file => { touched.push(file); return fileStat; } });
  assert.equal(resolved, expected);
  assert.deepEqual(touched, [expected]);
});

test('explicit bootstrap and environment resolution cannot be mixed ambiguously', async () => {
  assert.throws(() => options(['--runtime-root', 'one', '--bootstrap-file', 'two']), { code: 'AMBIGUOUS_DEV_CONFIG' });
  assert.throws(() => configCandidates(options([]), { PULT_RUNTIME_ROOT: 'one', PULT_DEV_BOOTSTRAP_FILE: 'two' }), { code: 'AMBIGUOUS_DEV_CONFIG' });
  await assert.rejects(resolveBootstrap(options(['--bootstrap-file', 'missing']), { env: {}, lstat: async () => { throw Object.assign(Error('secret path detail'), { code: 'ENOENT' }); } }), error => error.code === 'DEV_BOOTSTRAP_UNAVAILABLE' && !error.message.includes('secret'));
});

test('check mode passes only the protected file path and starts no listeners', async () => {
  const calls = [];
  const result = await execute(options(['--bootstrap-file', 'protected.dpapi']), {
    env: {}, lstat: async () => fileStat,
    launch: async input => { calls.push(input); return { checked: true }; }
  });
  assert.equal(result.checked, true);
  assert.equal(calls[0].checkOnly, true);
  assert.equal(calls[0].port, 0);
  assert.equal(calls[0].partnerPort, 0);
  assert.equal(Object.hasOwn(calls[0], 'password'), false);
});

test('shared-data launch is explicit and requires the established heap budget', async () => {
  const settings = options(['--run-shared-data', '--bootstrap-file', 'protected.dpapi']);
  const dependency = { env: {}, lstat: async () => fileStat, heapLimit: 1024, launch: async () => assert.fail('must not launch') };
  await assert.rejects(execute(settings, dependency), { code: 'HEAP_BUDGET_REQUIRED' });
  let launchInput;
  const app = await execute(settings, { ...dependency, heapLimit: 8 * 1024 ** 3, launch: async input => { launchInput = input; return { origin: 'http://127.0.0.1:54321', close() {} }; } });
  assert.equal(app.origin, 'http://127.0.0.1:54321');
  assert.equal(launchInput.checkOnly, false);
  assert.notEqual(launchInput.port, 4317);
});

function moduleFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-dev-preview-'));
  assert.equal(path.dirname(root), os.tmpdir());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'demo');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'module.config.cjs'), "module.exports={id:'demo',title:'Demo <safe>',route:'/modules/demo',apiNamespace:'/api/modules/demo',permission:'demo.read',navigation:true,enabled:true,developmentOnly:true}");
  fs.writeFileSync(path.join(folder, 'route.cjs'), "exports.create=({ctx})=>({handle(req,res){if(req.headers['x-preview-fail'])throw Error('canary-secret');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({preview:true,db:Object.hasOwn(ctx,'db')}));return true}})");
  fs.writeFileSync(path.join(folder, 'page.html'), '<h1>Demo module</h1>');
  fs.writeFileSync(path.join(folder, 'page.js'), "document.body.dataset.preview='true'");
  fs.writeFileSync(path.join(folder, 'page.css'), 'body{font-family:sans-serif}');
  return root;
}

function distFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-dev-preview-dist-'));
  assert.equal(path.dirname(root), os.tmpdir());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'module-ui.css'), '/* shared module UI */');
  fs.writeFileSync(path.join(root, 'module-ui.js'), "globalThis.moduleUi='preview'");
  fs.writeFileSync(path.join(root, 'seller-shell.css'), '/* seller shell */');
  fs.writeFileSync(path.join(root, 'private.txt'), 'must-not-be-served');
  return root;
}

test('preview serves development-only registry HTML and API without DB or production ports', async t => {
  const app = await launchPreview({ port: 0, modulesDir: moduleFixture(t), distDir: distFixture(t) });
  t.after(() => app.close());
  const actualPort = Number(new URL(app.origin).port);
  assert.notEqual(actualPort, 4317);
  assert.notEqual(actualPort, 4319);
  const home = await fetch(app.origin + '/');
  assert.equal(home.status, 200);
  const source = await home.text();
  assert.match(source, /Developer modules/u);
  assert.match(source, /Demo &lt;safe&gt;/u);
  const registry = await (await fetch(app.origin + '/api/developer/modules')).json();
  assert.equal(registry.modules[0].developmentOnly, true);
  assert.equal(registry.modules[0].active, true);
  const moduleApi = await (await fetch(app.origin + '/api/modules/demo')).json();
  assert.deepEqual(moduleApi, { preview: true, db: false });
  const failed = await fetch(app.origin + '/api/modules/demo', { headers: { 'x-preview-fail': '1' } });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /canary-secret/u);
  assert.equal((await fetch(app.origin + '/modules/demo')).status, 200);
  assert.equal((await fetch(app.origin + '/missing')).status, 404);
});

test('preview serves only allowlisted regular shared assets from dist', async t => {
  const distDir = distFixture(t);
  const app = await launchPreview({ port: 0, modulesDir: moduleFixture(t), distDir });
  t.after(() => app.close());
  for (const [name, type] of [['module-ui.css', 'text/css'], ['module-ui.js', 'application/javascript'], ['seller-shell.css', 'text/css']]) {
    const response = await fetch(`${app.origin}/${name}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), new RegExp(type, 'u'));
    assert.ok((await response.text()).length > 0);
  }
  assert.equal((await fetch(app.origin + '/private.txt')).status, 404);
  assert.equal((await fetch(app.origin + '/%2e%2e/private.txt')).status, 404);
  if (process.platform === 'win32') {
    fs.unlinkSync(path.join(distDir, 'module-ui.js'));
    try {
      fs.symlinkSync(path.join(distDir, 'private.txt'), path.join(distDir, 'module-ui.js'), 'file');
      assert.equal((await fetch(app.origin + '/module-ui.js')).status, 404);
    } catch (error) { assert.equal(error.code, 'EPERM'); }
  }
});

test('PULT_DEV_MODULES is scoped to preview and shared-data composition creation', async () => {
  const processEnv = { PULT_DEV_MODULES: 'previous' };
  await execute(options(['--preview']), { processEnv, previewLaunch: async () => {
    assert.equal(processEnv.PULT_DEV_MODULES, '1');
    return { origin: 'http://127.0.0.1:54322', close() {} };
  } });
  assert.equal(processEnv.PULT_DEV_MODULES, 'previous');
  const settings = options(['--run-shared-data', '--bootstrap-file', 'protected.dpapi']);
  await execute(settings, { processEnv, env: {}, lstat: async () => fileStat, heapLimit: 8 * 1024 ** 3, launch: async () => {
    assert.equal(processEnv.PULT_DEV_MODULES, '1');
    return { origin: 'http://127.0.0.1:54323', close() {} };
  } });
  assert.equal(processEnv.PULT_DEV_MODULES, 'previous');
});
