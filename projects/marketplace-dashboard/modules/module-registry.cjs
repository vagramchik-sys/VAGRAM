'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const ASSETS = Object.freeze({ 'page.html': 'text/html; charset=utf-8', 'page.js': 'application/javascript; charset=utf-8', 'page.css': 'text/css; charset=utf-8' });
const RESERVED = new Set(['navigation', 'registry']);

function validateConfig(config, folder) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || !ID.test(folder) || RESERVED.has(folder) || config.id !== folder ||
      typeof config.title !== 'string' || !config.title.trim() || config.title.length > 80 ||
      config.route !== `/modules/${folder}` || config.apiNamespace !== `/api/modules/${folder}` ||
      config.permission !== `${folder}.read` || typeof config.navigation !== 'boolean' ||
      typeof config.enabled !== 'boolean' || typeof config.developmentOnly !== 'boolean') {
    throw Object.assign(new Error('Invalid module configuration'), { code: 'MODULE_CONFIG_INVALID', moduleId: folder });
  }
  return Object.freeze({ id: folder, title: config.title.trim(), route: config.route, apiNamespace: config.apiNamespace,
    permission: config.permission, navigation: config.navigation, enabled: config.enabled, developmentOnly: config.developmentOnly });
}

function discoverModules({ modulesDir = __dirname, development = false, disabled = [] } = {}) {
  const excluded = new Set(disabled);
  const entries = [];
  if (!fs.existsSync(modulesDir)) return Object.freeze(entries);
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (!ID.test(entry.name) || RESERVED.has(entry.name)) continue;
    const directory = path.join(modulesDir, entry.name), configFile = path.join(directory, 'module.config.cjs');
    if (!fs.existsSync(configFile)) continue;
    const config = validateConfig(require(configFile), entry.name);
    const active = config.enabled && (!config.developmentOnly || development) && !excluded.has(config.id);
    entries.push(Object.freeze({ ...config, active, directory }));
  }
  return Object.freeze(entries);
}

function createModuleRegistry({ modulesDir = __dirname, development = false, disabled = [], ctx = {}, authorizePermission = () => true } = {}) {
  if (typeof authorizePermission !== 'function') throw new TypeError('authorizePermission must be a function');
  const modules = discoverModules({ modulesDir, development, disabled });
  const active = modules.filter(module => module.active);
  const handlers = new Map();
  for (const config of active) {
    const routeFile = path.join(config.directory, 'route.cjs');
    const factory = require(routeFile).create;
    if (typeof factory !== 'function') throw Object.assign(new Error('Module route contract is missing'), { code: 'MODULE_ROUTE_INVALID', moduleId: config.id });
    const route = factory({ config, ctx });
    if (typeof route?.handle !== 'function') throw Object.assign(new Error('Module handler contract is missing'), { code: 'MODULE_ROUTE_INVALID', moduleId: config.id });
    handlers.set(config.apiNamespace, route);
  }
  const publicModules = Object.freeze(active.map(({ id, title, route, apiNamespace, permission, navigation }) => Object.freeze({ id, title, route, apiNamespace, permission, navigation })));
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function handle(req, res, url) {
    if (url.pathname === '/api/modules') {
      if (req.method !== 'GET') json(res, 405, { error: 'Метод не поддерживается.' });
      else json(res, 200, { modules: publicModules });
      return true;
    }
    if (url.pathname === '/api/developer/modules' && development) {
      if (req.method !== 'GET') json(res, 405, { error: 'Метод не поддерживается.' });
      else json(res, 200, { modules: modules.map(({ directory, ...module }) => ({ ...module, routeReady: handlers.has(module.apiNamespace), backgroundJobs: [] })) });
      return true;
    }
    const route = handlers.get(url.pathname);
    if (!route) return false;
    const config = active.find(item => item.apiNamespace === url.pathname);
    if (!await authorizePermission(req, config.permission)) { json(res, 403, { error: 'Доступ запрещён.' }); return true; }
    return Boolean(await route.handle(req, res, url));
  }
  function navScript() {
    const items = JSON.stringify(publicModules.filter(module => module.navigation).map(({ id, title, route }) => ({ id, title, route })));
    return `(()=>{'use strict';const items=${items};if(!items.length)return;const add=()=>{const nav=document.querySelector('.sidebar nav'),seller=document.querySelector('.seller-navigation');for(const item of items){if(nav&&!nav.querySelector('[data-module-id="'+item.id+'"]')){const link=document.createElement('a');link.href=item.route;link.dataset.moduleId=item.id;link.dataset.nav='module-'+item.id;const label=document.createElement('span');label.textContent=item.title;link.append(label);nav.append(link)}if(seller&&!seller.querySelector('[data-module-id="'+item.id+'"]')){const link=document.createElement('a');link.className='seller-nav-link';link.href=item.route;link.dataset.moduleId=item.id;link.textContent=item.title;seller.append(link)}}};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',add,{once:true});else add()})();`;
  }
  function isPagePath(pathname) {
    return active.some(module => pathname === module.route || pathname === `${module.route}/page.html`);
  }
  async function serveAsset(req, res, url) {
    if (req.method !== 'GET') return false;
    if (url.pathname === '/modules/navigation.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(navScript()); return true;
    }
    const parts = url.pathname.split('/');
    if (parts.length < 3 || parts.length > 4 || parts[1] !== 'modules') return false;
    const module = active.find(item => item.id === parts[2]);
    if (!module || !await authorizePermission(req, module.permission)) return false;
    const file = parts.length === 3 ? 'page.html' : parts[3];
    if (!Object.hasOwn(ASSETS, file)) return false;
    const filename = path.join(module.directory, file);
    let bytes;
    try {
      const real = await fs.promises.realpath(filename);
      if (real !== filename || !real.startsWith(module.directory + path.sep)) return false;
      bytes = await fs.promises.readFile(real);
    } catch { return false; }
    res.writeHead(200, { 'Content-Type': ASSETS[file], 'Cache-Control': 'no-store' }); res.end(bytes); return true;
  }
  return Object.freeze({ modules, publicModules, handle, serveAsset, navScript, isPagePath });
}

module.exports = { ID, validateConfig, discoverModules, createModuleRegistry };
