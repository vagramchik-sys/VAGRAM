'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createModuleRegistry } = require('../modules/module-registry.cjs');
const { start } = require('../server-postgres.cjs');

test('SQL owner runtime mounts a manifest API and page while preserving root session gate', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-module-http-'));
  assert.equal(path.dirname(root), os.tmpdir());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const staticDir = path.join(root, 'dist'), modulesDir = path.join(root, 'modules'), moduleDir = path.join(modulesDir, 'sample');
  await fs.mkdir(staticDir); await fs.mkdir(moduleDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Pult</title>');
  await fs.writeFile(path.join(moduleDir, 'module.config.cjs'), "module.exports={id:'sample',title:'Sample',route:'/modules/sample',apiNamespace:'/api/modules/sample',permission:'sample.read',navigation:true,enabled:true,developmentOnly:false}");
  await fs.writeFile(path.join(moduleDir, 'route.cjs'), "exports.create=({config})=>({handle(req,res,url){if(url.pathname!==config.apiNamespace)return false;res.writeHead(200,{'content-type':'application/json'});res.end('{\"status\":\"ok\"}');return true}})");
  for (const name of ['page.html', 'page.js', 'page.css']) await fs.writeFile(path.join(moduleDir, name), name);
  const modules = createModuleRegistry({ modulesDir });
  class Client extends EventEmitter {
    async query(sql) { return { rows: [{ [sql.includes('pg_try') ? 'acquired' : 'unlocked']: true }] }; }
    release() {}
  }
  const pool = { connect: async () => new Client() };
  const core = { ready: async () => ({ ready: true, missingAdapters: [] }), publicStores: async () => [], publicSnapshot: async () => null, hasStore: async () => false };
  const runtime = await start({ pool, core, staticDir, staticFiles: ['index.html'], moduleAssets: modules, otherHandlers: [modules],
    port: 0, readiness: async () => ({ ready: true, missingAdapters: [] }), ownerRoutesFactory: async () => ({ handle: async () => false }) });
  t.after(() => runtime.close());
  const page = await fetch(runtime.origin + '/modules/sample');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'page.html');
  const cookie = page.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  assert.equal((await fetch(runtime.origin + '/api/modules/sample')).status, 403);
  const api = await fetch(runtime.origin + '/api/modules/sample', { headers: { cookie } });
  assert.equal(api.status, 200);
  assert.deepEqual(await api.json(), { status: 'ok' });
  const home = await fetch(runtime.origin + '/');
  assert.equal(home.status, 200);
  const script = await fetch(runtime.origin + '/modules/navigation.js');
  assert.equal(script.status, 200);
  assert.match(await script.text(), /Sample/u);
  assert.equal((await fetch(runtime.origin + '/modules/sample/route.cjs')).status, 404);
  assert.equal((await fetch(runtime.origin + '/modules/missing')).status, 404);
  await runtime.close();
});
