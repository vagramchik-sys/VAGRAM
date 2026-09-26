'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModuleRegistry, validateConfig } = require('../modules/module-registry.cjs');

function fixture(t, { id = 'reference', developmentOnly = false, enabled = true, navigation = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-module-registry-'));
  assert.equal(path.dirname(root), os.tmpdir());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, id);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'module.config.cjs'), `module.exports=${JSON.stringify({ id, title: 'Reference', route: `/modules/${id}`, apiNamespace: `/api/modules/${id}`, permission: `${id}.read`, navigation, enabled, developmentOnly })}`);
  fs.writeFileSync(path.join(folder, 'route.cjs'), `exports.create=({config,ctx})=>({handle(req,res,url){if(url.pathname!==config.apiNamespace)return false;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({module:config.id,db:!!ctx.db}));return true}})`);
  for (const name of ['page.html', 'page.js', 'page.css']) fs.writeFileSync(path.join(folder, name), name);
  return root;
}

function response() {
  const value = { status: null, headers: null, body: null };
  return { value, writeHead(status, headers) { value.status = status; value.headers = headers; return this; }, end(body) { value.body = body; return this; } };
}

test('manifest paths and permission metadata are constrained to the module id', () => {
  const base = { id: 'reference', title: 'Reference', route: '/modules/reference', apiNamespace: '/api/modules/reference', permission: 'reference.read', navigation: true, enabled: true, developmentOnly: false };
  assert.equal(validateConfig(base, 'reference').route, base.route);
  for (const wrong of [{ ...base, route: '/api/stores' }, { ...base, apiNamespace: '/api/stores' }, { ...base, permission: 'admin.write' }, { ...base, enabled: 'yes' }]) assert.throws(() => validateConfig(wrong, 'reference'), { code: 'MODULE_CONFIG_INVALID' });
});

test('development-only module is absent from production routes, assets and navigation', async t => {
  const modulesDir = fixture(t, { developmentOnly: true });
  const registry = createModuleRegistry({ modulesDir, development: false });
  assert.equal(registry.modules.length, 1);
  assert.equal(registry.publicModules.length, 0);
  const api = response();
  assert.equal(await registry.handle({ method: 'GET' }, api, new URL('http://localhost/api/modules/reference')), false);
  const page = response();
  assert.equal(await registry.serveAsset({ method: 'GET' }, page, new URL('http://localhost/modules/reference')), false);
  assert.doesNotMatch(registry.navScript(), /Reference/u);
});

test('development registry connects metadata, API and exact public assets without DB copies', async t => {
  const modulesDir = fixture(t, { developmentOnly: true });
  const registry = createModuleRegistry({ modulesDir, development: true, ctx: { db: {} } });
  assert.deepEqual(registry.publicModules.map(item => item.id), ['reference']);
  const list = response();
  assert.equal(await registry.handle({ method: 'GET' }, list, new URL('http://localhost/api/modules')), true);
  assert.equal(JSON.parse(list.value.body).modules[0].route, '/modules/reference');
  const api = response();
  assert.equal(await registry.handle({ method: 'GET' }, api, new URL('http://localhost/api/modules/reference')), true);
  assert.deepEqual(JSON.parse(api.value.body), { module: 'reference', db: true });
  const page = response();
  assert.equal(await registry.serveAsset({ method: 'GET' }, page, new URL('http://localhost/modules/reference')), true);
  assert.equal(page.value.body.toString(), 'page.html');
  assert.match(registry.navScript(), /Reference/u);
  assert.equal(await registry.serveAsset({ method: 'GET' }, response(), new URL('http://localhost/modules/reference/route.cjs')), false);
  assert.equal(await registry.serveAsset({ method: 'GET' }, response(), new URL('http://localhost/modules/reference/../route.cjs')), false);
});

test('environment disable and permission gate suppress module access', async t => {
  const modulesDir = fixture(t);
  const disabled = createModuleRegistry({ modulesDir, disabled: ['reference'] });
  assert.equal(disabled.publicModules.length, 0);
  const denied = createModuleRegistry({ modulesDir, authorizePermission: () => false });
  const api = response();
  assert.equal(await denied.handle({ method: 'GET' }, api, new URL('http://localhost/api/modules/reference')), true);
  assert.equal(api.value.status, 403);
  assert.equal(await denied.serveAsset({ method: 'GET' }, response(), new URL('http://localhost/modules/reference')), false);
});
