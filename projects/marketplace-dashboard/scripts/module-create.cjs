'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED_IDS = new Set(['navigation', 'registry']);
const REQUIRED_FILES = Object.freeze([
  'module.config.cjs',
  'page.html',
  'page.js',
  'page.css',
  'route.cjs',
  'service.cjs',
  'repository.cjs',
  'api.schema.json',
  'test/module.test.cjs',
  'README.md',
  'perf-smoke.cjs'
]);

function assertModuleId(id) {
  if (typeof id !== 'string' || !MODULE_ID.test(id) || RESERVED_IDS.has(id)) {
    throw new TypeError('Module id must be non-reserved lower-case kebab-case (for example: sales-forecast).');
  }
  return id;
}

function defaultTitle(id) {
  return id.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
}

function quote(value) {
  return JSON.stringify(value);
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function templates(id, title) {
  const qId = quote(id);
  const qTitle = quote(title);
  const htmlTitle = escapeHtml(title);
  return {
    'module.config.cjs': `'use strict';\n\nmodule.exports = {\n  id: ${qId},\n  title: ${qTitle},\n  route: ${quote(`/modules/${id}`)},\n  apiNamespace: ${quote(`/api/modules/${id}`)},\n  permission: ${quote(`${id}.read`)},\n  navigation: true,\n  enabled: true,\n  developmentOnly: false\n};\n`,
    'repository.cjs': `'use strict';\n\nfunction createRepository({ db = null } = {}) {\n  return {\n    db,\n    async read() {\n      return { module: ${qId}, status: 'ok', items: [] };\n    }\n  };\n}\n\nmodule.exports = { createRepository };\n`,
    'service.cjs': `'use strict';\n\nconst { createRepository } = require('./repository.cjs');\n\nfunction createService({ repository = createRepository() } = {}) {\n  return {\n    async getStatus() {\n      return repository.read();\n    }\n  };\n}\n\nmodule.exports = { createService };\n`,
    'route.cjs': `'use strict';\n\nconst { createRepository } = require('./repository.cjs');\nconst { createService } = require('./service.cjs');\n\nfunction sendJson(response, status, payload, extraHeaders = {}) {\n  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders };\n  if (typeof response.writeHead === 'function') response.writeHead(status, headers);\n  if (typeof response.end === 'function') response.end(JSON.stringify(payload));\n}\n\nfunction create({ config, ctx = {} }) {\n  if (!config || typeof config.apiNamespace !== 'string') throw new TypeError('Module config is required');\n  const service = ctx.service || createService({ repository: createRepository({ db: ctx.db }) });\n  return {\n    async handle(request, response, url) {\n      const pathname = url instanceof URL ? url.pathname : new URL(String(url), 'http://localhost').pathname;\n      if (pathname !== config.apiNamespace) return false;\n      if (request.method !== 'GET') {\n        sendJson(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported' } }, { allow: 'GET' });\n        return true;\n      }\n      const started = Date.now();\n      try {\n        const data = await service.getStatus();\n        sendJson(response, 200, { ok: true, data });\n      } catch {\n        if (ctx.logger && typeof ctx.logger.error === 'function') {\n          ctx.logger.error({ module: config.id, route: config.apiNamespace, operation: 'getStatus', duration: Date.now() - started }, 'Module request failed');\n        }\n        sendJson(response, 503, { ok: false, error: { code: 'MODULE_UNAVAILABLE', message: 'Module is temporarily unavailable' } });\n      }\n      return true;\n    }\n  };\n}\n\nmodule.exports = { create };\n`,
    'page.html': `<!doctype html>\n<html lang="ru">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${htmlTitle}</title>\n  <link rel="stylesheet" href="/seller-shell.css">\n  <link rel="stylesheet" href="/module-ui.css">\n  <link rel="stylesheet" href="/modules/${id}/page.css">\n</head>\n<body class="module-page pult-static-shell">\n  <main class="module-shell" data-module-root="${id}">\n    <header class="topbar"><a href="/">Пульт</a><span>${htmlTitle}</span></header>\n    <section class="module-content">\n      <header class="page-heading" data-component="PageHeader">\n        <div><div class="eyebrow">МОДУЛЬ</div><h1 data-page-title>${htmlTitle}</h1><p data-page-subtitle>Страница нового модуля</p></div>\n      </header>\n      <section class="panel module-state" aria-live="polite" aria-busy="true">\n        <p data-state="loading">Загружаем данные…</p>\n        <p data-state="error" role="alert" hidden>Не удалось загрузить данные. Обновите страницу, чтобы повторить.</p>\n        <p data-state="empty" hidden>Данных пока нет.</p>\n        <div data-state="content" hidden></div>\n      </section>\n    </section>\n  </main>\n  <script src="/module-ui.js" defer></script>\n  <script src="/modules/${id}/page.js" defer></script>\n</body>\n</html>\n`,
    'page.js': `'use strict';\n\n(function renderModulePage() {\n  const root = document.querySelector('[data-module-root=${quote(id)}]');\n  if (!root) return;\n  const states = Object.fromEntries([...root.querySelectorAll('[data-state]')].map(node => [node.dataset.state, node]));\n\n  function PageHeader({ title, subtitle }) {\n    root.querySelector('[data-page-title]').textContent = title;\n    root.querySelector('[data-page-subtitle]').textContent = subtitle;\n  }\n\n  function showState(name, payload) {\n    if (window.PultModuleUI && typeof window.PultModuleUI.setState === 'function') window.PultModuleUI.setState(root, name, payload);\n    for (const [key, node] of Object.entries(states)) node.hidden = key !== name;\n    root.querySelector('.module-state').setAttribute('aria-busy', String(name === 'loading'));\n  }\n\n  PageHeader({ title: ${qTitle}, subtitle: 'Страница нового модуля' });\n  showState('loading');\n  fetch(${quote(`/api/modules/${id}`)}, { headers: { accept: 'application/json' } })\n    .then(async response => {\n      const payload = await response.json();\n      if (!response.ok || payload.ok !== true) throw new Error('Module request failed');\n      return payload.data;\n    })\n    .then(data => {\n      if (!Array.isArray(data.items) || data.items.length === 0) return showState('empty');\n      states.content.textContent = data.module;\n      showState('content', data);\n    })\n    .catch(() => showState('error'));\n})();\n`,
    'page.css': `.module-shell { min-height: 100vh; }\n.module-content { max-width: 1180px; margin: 0 auto; padding: 0 28px 48px; }\n.module-state { min-height: 8rem; padding: 24px; }\n.module-state [data-state] { margin: 0; }\n.module-state [data-state="error"] { color: #b42318; }\n`,
    'api.schema.json': `${JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: `${title} API response`,
      description: `GET /api/modules/${id}; this starter endpoint accepts no query parameters and has no pagination.`,
      'x-endpoint': { method: 'GET', path: `/api/modules/${id}`, pagination: false },
      oneOf: [{ $ref: '#/$defs/success' }, { $ref: '#/$defs/error' }],
      $defs: {
        success: {
          type: 'object', additionalProperties: false, required: ['ok', 'data'],
          properties: {
            ok: { const: true },
            data: {
              type: 'object', additionalProperties: false, required: ['module', 'status', 'items'],
              properties: { module: { const: id }, status: { const: 'ok' }, items: { type: 'array' } }
            }
          }
        },
        error: {
          type: 'object', additionalProperties: false, required: ['ok', 'error'],
          properties: {
            ok: { const: false },
            error: {
              type: 'object', additionalProperties: false, required: ['code', 'message'],
              properties: { code: { type: 'string' }, message: { type: 'string' } }
            }
          }
        }
      }
    }, null, 2)}\n`,
    'test/module.test.cjs': `'use strict';\n\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { createRepository } = require('../repository.cjs');\nconst { createService } = require('../service.cjs');\nconst { create } = require('../route.cjs');\nconst config = require('../module.config.cjs');\n\nfunction responseCapture() {\n  return { status: null, headers: null, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };\n}\n\ntest(${quote(`${title} exposes its minimal API contract`)}, async () => {\n  const expected = { module: ${qId}, status: 'ok', items: [] };\n  assert.deepEqual(await createRepository().read(), expected);\n  assert.deepEqual(await createService().getStatus(), expected);\n  const route = create({ config, ctx: {} });\n  const response = responseCapture();\n  assert.equal(await route.handle({ method: 'GET' }, response, new URL('http://localhost' + config.apiNamespace)), true);\n  assert.equal(response.status, 200);\n  assert.match(response.headers['content-type'], /application\\/json/);\n  assert.equal(response.headers['cache-control'], 'no-store');\n  assert.deepEqual(JSON.parse(response.body), { ok: true, data: expected });\n  assert.equal(await route.handle({ method: 'GET' }, responseCapture(), new URL('http://localhost/api/other')), false);\n\n  const methodResponse = responseCapture();\n  assert.equal(await route.handle({ method: 'POST' }, methodResponse, new URL('http://localhost' + config.apiNamespace)), true);\n  assert.equal(methodResponse.status, 405);\n  assert.equal(methodResponse.headers.allow, 'GET');\n  assert.equal(methodResponse.headers['cache-control'], 'no-store');\n  assert.equal(JSON.parse(methodResponse.body).error.code, 'METHOD_NOT_ALLOWED');\n\n  const logs = [];\n  const failureRoute = create({ config, ctx: { service: { async getStatus() { throw new Error('synthetic secret'); } }, logger: { error(fields, message) { logs.push({ fields, message }); } } } });\n  const failureResponse = responseCapture();\n  assert.equal(await failureRoute.handle({ method: 'GET' }, failureResponse, new URL('http://localhost' + config.apiNamespace)), true);\n  assert.equal(failureResponse.status, 503);\n  assert.equal(failureResponse.headers['cache-control'], 'no-store');\n  assert.equal(JSON.parse(failureResponse.body).error.code, 'MODULE_UNAVAILABLE');\n  assert.equal(failureResponse.body.includes('synthetic secret'), false);\n  assert.equal(logs.length, 1);\n  assert.deepEqual({ module: logs[0].fields.module, route: logs[0].fields.route, operation: logs[0].fields.operation }, { module: config.id, route: config.apiNamespace, operation: 'getStatus' });\n  assert.equal(Number.isFinite(logs[0].fields.duration), true);\n  assert.equal(Object.hasOwn(logs[0].fields, 'stack'), false);\n});\n`,
    'README.md': `# ${title}\n\nManifest-based module at \`${`/modules/${id}`}\` with API namespace \`${`/api/modules/${id}`}\`. The starter API is one \`GET\` endpoint without query parameters or pagination. Responses use the success/error envelopes documented in \`api.schema.json\`.\n\nRun its isolated checks with:\n\n\`\`\`powershell\nnode scripts/verify-module.cjs ${id}\n\`\`\`\n\nThe starter performance smoke expects zero SQL queries. When repository logic starts querying the database, update its expected query count deliberately and keep response-byte reporting as the payload baseline.\n`,
    'perf-smoke.cjs': `'use strict';\n\nconst assert = require('node:assert/strict');\nconst { performance } = require('node:perf_hooks');\nconst { create } = require('./route.cjs');\nconst config = require('./module.config.cjs');\n\nasync function main() {\n  let sqlQueries = 0;\n  const db = { async query() { sqlQueries += 1; return { rows: [] }; } };\n  const route = create({ config, ctx: { db } });\n  const iterations = 1000;\n  let responseBytes = 0;\n  const started = performance.now();\n  for (let index = 0; index < iterations; index += 1) {\n    const response = { status: null, headers: null, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = String(body); } };\n    const handled = await route.handle({ method: 'GET' }, response, new URL('http://localhost' + config.apiNamespace));\n    assert.equal(handled, true);\n    assert.equal(response.status, 200);\n    assert.equal(response.headers['cache-control'], 'no-store');\n    const payload = JSON.parse(response.body);\n    assert.equal(payload.ok, true);\n    assert.equal(payload.data.module, ${qId});\n    assert.ok(Array.isArray(payload.data.items));\n    responseBytes += Buffer.byteLength(response.body);\n  }\n  const elapsedMs = performance.now() - started;\n  assert.equal(Number.isFinite(elapsedMs), true);\n  assert.equal(responseBytes > 0, true);\n  assert.equal(sqlQueries, 0);\n  process.stdout.write(JSON.stringify({ module: ${qId}, iterations, elapsedMs: Number(elapsedMs.toFixed(3)), responseBytes, sqlQueries }) + '\\n');\n}\n\nif (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });\nmodule.exports = { main };\n`
  };
}

function resolveModulesRoot(projectRoot) {
  return path.resolve(projectRoot, 'modules');
}

function createModule({ projectRoot = path.resolve(__dirname, '..'), id, title }) {
  assertModuleId(id);
  if (title === undefined) title = defaultTitle(id);
  if (typeof title !== 'string' || !title.trim()) throw new TypeError('Module title must not be empty.');
  title = title.trim();
  if (title.length > 80 || /[\u0000-\u001f\u007f]/.test(title)) throw new TypeError('Module title must be at most 80 characters without control characters.');

  const modulesRoot = resolveModulesRoot(projectRoot);
  const moduleRoot = path.resolve(modulesRoot, id);
  if (path.dirname(moduleRoot) !== modulesRoot) throw new Error('Module path escaped the modules directory.');

  const created = [];
  const skipped = [];
  fs.mkdirSync(moduleRoot, { recursive: true });
  for (const [relativePath, contents] of Object.entries(templates(id, title))) {
    const target = path.resolve(moduleRoot, relativePath);
    if (!target.startsWith(moduleRoot + path.sep)) throw new Error(`Unsafe template path: ${relativePath}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(target, contents, { encoding: 'utf8', flag: 'wx' });
      created.push(relativePath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      skipped.push(relativePath);
    }
  }
  return { id, title, moduleRoot, created, skipped };
}

function parseArguments(argv) {
  const args = [...argv];
  let id = null;
  let title = null;
  while (args.length) {
    const value = args.shift();
    if (value === '--id') id = args.shift();
    else if (value === '--title') title = args.shift();
    else if (!id) id = value;
    else title = [title, value].filter(Boolean).join(' ');
  }
  if (!id) throw new TypeError('Usage: node scripts/module-create.cjs <id> [title]');
  return { id, ...(title ? { title } : {}) };
}

if (require.main === module) {
  try {
    const result = createModule(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { MODULE_ID, RESERVED_IDS, REQUIRED_FILES, assertModuleId, createModule, defaultTitle, escapeHtml, templates };
