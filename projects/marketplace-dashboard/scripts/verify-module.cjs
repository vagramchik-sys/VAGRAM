'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REQUIRED_FILES, assertModuleId } = require('./module-create.cjs');

const MANIFEST_KEYS = Object.freeze(['id', 'title', 'route', 'apiNamespace', 'permission', 'navigation', 'enabled', 'developmentOnly']);

function fail(message) {
  throw new Error(message);
}

function runNode(args, cwd, label) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${label} failed${detail ? `:\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function loadManifest(file) {
  const resolved = require.resolve(file);
  delete require.cache[resolved];
  const manifest = require(resolved);
  delete require.cache[resolved];
  return manifest;
}

function validateManifest(manifest, id) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('module.config.cjs must export an object.');
  const expected = {
    id,
    route: `/modules/${id}`,
    apiNamespace: `/api/modules/${id}`,
    permission: `${id}.read`
  };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) fail(`Invalid manifest field ${key}; expected ${JSON.stringify(value)}.`);
  }
  if (typeof manifest.title !== 'string' || !manifest.title.trim() || manifest.title.length > 80) fail('Manifest title must contain 1-80 characters.');
  for (const key of ['navigation', 'enabled', 'developmentOnly']) {
    if (typeof manifest[key] !== 'boolean') fail(`Manifest field ${key} must be boolean.`);
  }
  const unknown = Object.keys(manifest).filter(key => !MANIFEST_KEYS.includes(key));
  if (unknown.length) fail(`Unknown manifest fields: ${unknown.join(', ')}.`);
  const registryFile = path.resolve(__dirname, '../modules/module-registry.cjs');
  if (fs.existsSync(registryFile)) {
    try { require(registryFile).validateConfig(manifest, id); }
    catch { fail('Manifest is incompatible with the module registry.'); }
  }
}

function validateApiSchema(schema, id) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) fail('api.schema.json must contain a JSON object.');
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') fail('API schema must use JSON Schema draft 2020-12.');
  if (schema['x-endpoint']?.method !== 'GET' || schema['x-endpoint']?.path !== `/api/modules/${id}` || schema['x-endpoint']?.pagination !== false) fail('API schema must document its GET endpoint without pagination.');
  if (!Array.isArray(schema.oneOf) || schema.oneOf.length !== 2) fail('API schema must define success and error response envelopes.');
  if (schema.$defs?.success?.properties?.ok?.const !== true || schema.$defs?.success?.properties?.data?.properties?.module?.const !== id) fail('API schema success envelope is invalid.');
  if (schema.$defs?.error?.properties?.ok?.const !== false || schema.$defs?.error?.properties?.error?.properties?.code?.type !== 'string') fail('API schema error envelope is invalid.');
}

function validatePage(moduleRoot, manifest) {
  const html = fs.readFileSync(path.join(moduleRoot, 'page.html'), 'utf8');
  const page = fs.readFileSync(path.join(moduleRoot, 'page.js'), 'utf8');
  const cssPath = `${manifest.route}/page.css`;
  const jsPath = `${manifest.route}/page.js`;
  if (!html.includes(`href="${cssPath}"`)) fail(`page.html must load ${cssPath}.`);
  if (!html.includes(`src="${jsPath}"`)) fail(`page.html must load ${jsPath}.`);
  for (const asset of ['/seller-shell.css', '/module-ui.css', '/module-ui.js']) {
    if (!html.includes(`"${asset}"`)) fail(`page.html must load shared asset ${asset}.`);
  }
  if (!html.includes('data-component="PageHeader"') || !page.includes('function PageHeader')) fail('Module page must include an explicit PageHeader.');
  for (const state of ['loading', 'error', 'empty', 'content']) {
    if (!html.includes(`data-state="${state}"`)) fail(`Module page must include the ${state} state.`);
  }
  if (!page.includes('PultModuleUI.setState')) fail('Module page must reuse PultModuleUI when available.');
}

function validateRoute(moduleRoot, manifest) {
  const resolved = require.resolve(path.join(moduleRoot, 'route.cjs'));
  delete require.cache[resolved];
  const routeModule = require(resolved);
  delete require.cache[resolved];
  if (typeof routeModule.create !== 'function') fail('route.cjs must export create({ config, ctx }).');
  const route = routeModule.create({ config: manifest, ctx: {} });
  if (!route || typeof route.handle !== 'function') fail('Route create() must return an object with handle(req, res, url).');
}

async function verifyModule({ projectRoot = path.resolve(__dirname, '..'), id }) {
  assertModuleId(id);
  const modulesRoot = path.resolve(projectRoot, 'modules');
  const moduleRoot = path.resolve(modulesRoot, id);
  if (path.dirname(moduleRoot) !== modulesRoot) fail('Module path escaped the modules directory.');
  if (!fs.existsSync(moduleRoot) || !fs.statSync(moduleRoot).isDirectory()) fail(`Module does not exist: ${id}.`);

  const missing = REQUIRED_FILES.filter(relativePath => {
    const target = path.join(moduleRoot, relativePath);
    return !fs.existsSync(target) || !fs.statSync(target).isFile();
  });
  if (missing.length) fail(`Missing required files: ${missing.join(', ')}.`);

  const codeFiles = REQUIRED_FILES.filter(file => /\.(?:cjs|js)$/.test(file));
  for (const relativePath of codeFiles) runNode(['--check', path.join(moduleRoot, relativePath)], projectRoot, `Syntax check ${relativePath}`);

  const manifest = loadManifest(path.join(moduleRoot, 'module.config.cjs'));
  validateManifest(manifest, id);
  validatePage(moduleRoot, manifest);
  validateRoute(moduleRoot, manifest);

  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'api.schema.json'), 'utf8'));
  } catch (error) {
    fail(`Invalid api.schema.json: ${error.message}`);
  }
  validateApiSchema(schema, id);

  runNode(['--test', path.join(moduleRoot, 'test/module.test.cjs')], projectRoot, 'Module tests');
  const performanceOutput = runNode([path.join(moduleRoot, 'perf-smoke.cjs')], projectRoot, 'Performance smoke');
  let performance = performanceOutput || null;
  if (performanceOutput) {
    try { performance = JSON.parse(performanceOutput); } catch { /* A successful smoke script may emit human-readable output. */ }
  }
  return { id, title: manifest.title, files: REQUIRED_FILES.length, tests: 'passed', performance };
}

function discoverModules(projectRoot) {
  const root = path.resolve(projectRoot, 'modules');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'module.config.cjs')))
    .map(entry => entry.name)
    .sort();
}

function parseArguments(argv) {
  const values = argv.filter(value => value !== '--all');
  if (values[0] === '--id') values.shift();
  if (values.length > 1) throw new TypeError('Usage: node scripts/verify-module.cjs [<id>|--all]');
  return values[0] || null;
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const requested = parseArguments(process.argv.slice(2));
  const ids = requested ? [requested] : discoverModules(projectRoot);
  if (!ids.length) fail('No manifest-based modules found.');
  const results = [];
  for (const id of ids) results.push(await verifyModule({ projectRoot, id }));
  process.stdout.write(`${JSON.stringify({ ok: true, modules: results }, null, 2)}\n`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { discoverModules, loadManifest, runNode, validateApiSchema, validateManifest, validatePage, validateRoute, verifyModule };
