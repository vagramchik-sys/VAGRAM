'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModule, REQUIRED_FILES } = require('../scripts/module-create.cjs');
const { discoverModules, validateManifest, verifyModule } = require('../scripts/verify-module.cjs');

function temporaryProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-module-tooling-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('generator creates a complete manifest-based module that verifies in isolation', async t => {
  const projectRoot = temporaryProject(t);
  const generated = createModule({ projectRoot, id: 'sales-forecast', title: 'Sales Forecast' });
  assert.deepEqual(generated.created.slice().sort(), REQUIRED_FILES.slice().sort());
  assert.deepEqual(generated.skipped, []);

  const manifest = require(path.join(generated.moduleRoot, 'module.config.cjs'));
  assert.deepEqual(manifest, {
    id: 'sales-forecast',
    title: 'Sales Forecast',
    route: '/modules/sales-forecast',
    apiNamespace: '/api/modules/sales-forecast',
    permission: 'sales-forecast.read',
    navigation: true,
    enabled: true,
    developmentOnly: false
  });
  const html = fs.readFileSync(path.join(generated.moduleRoot, 'page.html'), 'utf8');
  assert.match(html, /href="\/modules\/sales-forecast\/page\.css"/);
  assert.match(html, /src="\/modules\/sales-forecast\/page\.js"/);
  assert.match(html, /data-component="PageHeader"/);
  assert.match(html, /href="\/seller-shell\.css"/);
  assert.match(html, /href="\/module-ui\.css"/);
  assert.match(html, /src="\/module-ui\.js"/);
  assert.match(html, /<body class="module-page pult-static-shell">/);
  assert.doesNotMatch(html, /dashboard\.css/);
  for (const state of ['loading', 'error', 'empty', 'content']) assert.match(html, new RegExp(`data-state="${state}"`));
  const page = fs.readFileSync(path.join(generated.moduleRoot, 'page.js'), 'utf8');
  assert.match(page, /function PageHeader/);
  assert.match(page, /PultModuleUI\.setState/);
  const perf = fs.readFileSync(path.join(generated.moduleRoot, 'perf-smoke.cjs'), 'utf8');
  assert.doesNotMatch(perf, /elapsedMs\s*>/);
  assert.match(perf, /route\.handle/);
  assert.match(perf, /responseBytes/);
  assert.match(perf, /sqlQueries/);
  assert.match(fs.readFileSync(path.join(generated.moduleRoot, 'README.md'), 'utf8'), /update its expected query count/);
  assert.deepEqual(discoverModules(projectRoot), ['sales-forecast']);
  const verified = await verifyModule({ projectRoot, id: 'sales-forecast' });
  assert.equal(verified.tests, 'passed');
  assert.equal(verified.performance.module, 'sales-forecast');
  assert.equal(verified.performance.sqlQueries, 0);
  assert.equal(verified.performance.responseBytes > 0, true);
});

test('repeated generation preserves edited files and only fills missing files', t => {
  const projectRoot = temporaryProject(t);
  const first = createModule({ projectRoot, id: 'inventory' });
  const service = path.join(first.moduleRoot, 'service.cjs');
  fs.writeFileSync(service, '// user-owned implementation\n');
  fs.rmSync(path.join(first.moduleRoot, 'page.css'));

  const second = createModule({ projectRoot, id: 'inventory', title: 'Changed title' });
  assert.equal(fs.readFileSync(service, 'utf8'), '// user-owned implementation\n');
  assert.deepEqual(second.created, ['page.css']);
  assert.equal(second.skipped.includes('module.config.cjs'), true);
  assert.equal(require(path.join(first.moduleRoot, 'module.config.cjs')).title, 'Inventory');
});

test('generator quotes titles in code and HTML', async t => {
  const projectRoot = temporaryProject(t);
  const generated = createModule({ projectRoot, id: 'quoted-title', title: 'Sales <Forecast> & "Plan"' });
  const html = fs.readFileSync(path.join(generated.moduleRoot, 'page.html'), 'utf8');
  assert.match(html, /Sales &lt;Forecast&gt; &amp; &quot;Plan&quot;/);
  assert.equal(require(path.join(generated.moduleRoot, 'module.config.cjs')).title, 'Sales <Forecast> & "Plan"');
  await verifyModule({ projectRoot, id: 'quoted-title' });
});

test('generator rejects unsafe identifiers and verifier reports broken contracts', async t => {
  const projectRoot = temporaryProject(t);
  for (const id of ['', '../escape', 'UpperCase', 'two words', '-leading', 'navigation', 'registry']) {
    assert.throws(() => createModule({ projectRoot, id }), /kebab-case/);
  }

  const generated = createModule({ projectRoot, id: 'safe-module' });
  fs.writeFileSync(path.join(generated.moduleRoot, 'api.schema.json'), '{}\n');
  await assert.rejects(verifyModule({ projectRoot, id: 'safe-module' }), /JSON Schema draft 2020-12/);
});

test('manifest validation accepts boolean feature flag variants and rejects non-booleans', () => {
  const base = {
    id: 'feature-demo', title: 'Feature demo', route: '/modules/feature-demo',
    apiNamespace: '/api/modules/feature-demo', permission: 'feature-demo.read',
    navigation: false, enabled: false, developmentOnly: true
  };
  assert.doesNotThrow(() => validateManifest(base, base.id));
  for (const key of ['navigation', 'enabled', 'developmentOnly']) {
    assert.throws(() => validateManifest({ ...base, [key]: key === 'enabled' ? 0 : 'false' }, base.id), new RegExp(`${key} must be boolean`));
  }
  assert.throws(() => validateManifest({ ...base, title: 'x'.repeat(81) }, base.id), /1-80/);
});
