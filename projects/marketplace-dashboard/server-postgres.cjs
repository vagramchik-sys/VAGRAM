'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { requestMetrics: defaultRequestMetrics } = require('./storage/postgres-request-metrics.cjs');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const STATIC_EXTENSIONS = new Set(Object.keys(MIME));
const FINANCE_UPLOAD_MEDIA = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg']);
// These reports read large historical sources. Keep their HTTP admission queue
// separate so one report cannot hold the slot needed by a small interactive GET.
const HEAVY_READ_ROUTES = new Set(['/api/buyer-order-segments', '/api/buyer-product-segments', '/api/b2b-radar', '/api/category-sales', '/api/order-category-daily', '/api/order-categories']);
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };

async function start({ pool, core, ownerRoutesFactory, otherHandlers = [], handlerFactories = [], background = [], staticDir, staticFiles, port = 0, readiness, apiGetWaitTimeoutMs = 30000, requestMetrics = defaultRequestMetrics } = {}) {
  if (!pool?.connect || !core || !['ready', 'publicStores', 'publicSnapshot', 'hasStore'].every(name => typeof core[name] === 'function')) throw new TypeError('SQL pool and core are required');
  if (typeof ownerRoutesFactory !== 'function' || !Array.isArray(otherHandlers) || !Array.isArray(handlerFactories) || !handlerFactories.every(value => typeof value === 'function') || !Array.isArray(background) || typeof readiness !== 'function') throw new TypeError('Explicit complete handler readiness is required');
  if (typeof staticDir !== 'string' || !path.isAbsolute(staticDir) || !Array.isArray(staticFiles) || !staticFiles.length || !Number.isSafeInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(apiGetWaitTimeoutMs) || apiGetWaitTimeoutMs < 1 || apiGetWaitTimeoutMs > 300000) throw new TypeError('staticDir, staticFiles, port and API queue timeout are invalid');
  const root = await fs.realpath(staticDir).catch(() => null);
  if (!root || !(await fs.stat(root).catch(() => null))?.isDirectory()) throw new TypeError('staticDir must be a real directory');
  const publicFiles = new Map();
  for (const name of staticFiles) {
    if (typeof name !== 'string' || !name || name.includes('\\') || path.posix.isAbsolute(name) || path.posix.normalize(name) !== name || name.startsWith('../') || !STATIC_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new TypeError('staticFiles contains an invalid path');
    publicFiles.set('/' + name, path.resolve(root, ...name.split('/')));
  }
  if (!publicFiles.has('/index.html')) throw new TypeError('staticFiles must include index.html');
  const state = await readiness();
  if (state?.ready !== true || !Array.isArray(state.missingAdapters) || state.missingAdapters.length) throw Object.assign(Error('PostgreSQL runtime wiring is incomplete'), { code: 'RUNTIME_NOT_READY', missingAdapters: state?.missingAdapters || ['readiness'] });

  let lease, server, healthy = true, closing = false, active = 0, settleDrain, closePromise;
  const apiGetLanes = { regular: { limit: 1, active: 0, queue: [] }, light: { limit: 2, active: 0, queue: [] }, heavy: { limit: 1, active: 0, queue: [] } };
  const unavailable = res => { if (!res.headersSent && !res.destroyed && !res.writableEnded) json(res, 503, { error: 'SQL runtime временно недоступен.' }); };
  const nextApiGet = lane => {
    if (lane.active >= lane.limit || closing || !healthy) return;
    let entry;
    while (lane.active < lane.limit && (entry = lane.queue.shift())) {
      if (entry.done || entry.req.aborted || entry.res.destroyed || entry.res.writableEnded) { entry.cancel(); continue; }
      lane.active++; entry.grant();
    }
  };
  const apiGetSlot = (lane, req, res) => {
    if (closing || !healthy || req.aborted || res.destroyed || res.writableEnded) return Promise.resolve(null);
    if (lane.active < lane.limit) { lane.active++; let released = false; return Promise.resolve(() => { if (released) return; released = true; lane.active--; nextApiGet(lane); }); }
    if (lane.queue.length >= 128) return Promise.resolve('busy');
    return new Promise(resolve => {
      const entry = { req, res, done: false };
      const cleanup = () => { clearTimeout(entry.timer); req.off('aborted', entry.cancel); res.off('close', entry.cancel); };
      entry.cancel = reason => { if (entry.done) return; entry.done = true; cleanup(); const index = lane.queue.indexOf(entry); if (index >= 0) lane.queue.splice(index, 1); resolve(reason === 'timeout' ? 'timeout' : null); };
      entry.grant = () => { if (entry.done) return; entry.done = true; cleanup(); let released = false; resolve(() => { if (released) return; released = true; lane.active--; nextApiGet(lane); }); };
      entry.timer = setTimeout(() => entry.cancel('timeout'), apiGetWaitTimeoutMs); entry.timer.unref?.();
      req.once('aborted', entry.cancel); res.once('close', entry.cancel); lane.queue.push(entry);
    });
  };
  const cancelQueuedApiGets = () => { for (const lane of Object.values(apiGetLanes)) for (const entry of lane.queue.splice(0)) entry.cancel(); };
  const startedBackground = [];
  const drained = () => active === 0 && settleDrain?.();
  try {
    lease = await pool.connect();
    const locked = await lease.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', ['pult:owner:runtime']);
    if (locked.rows?.[0]?.acquired !== true) throw Object.assign(Error('Owner runtime already active'), { code: 'RUNTIME_LEASE_BUSY' });
    const sessions = new Set();
    let origin;
    const token = req => (req.headers.cookie || '').match(/(?:^|; )pult_session=([a-f0-9]{64})(?:;|$)/u)?.[1];
    const authorize = async (req, url) => {
      if (!healthy || closing || req.headers.host !== new URL(origin).host || !sessions.has(token(req))) return false;
      if (req.method !== 'POST') return true;
      if (req.headers.origin !== origin) return false;
      const media = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      return media === 'application/json' || url?.pathname === '/api/finance/contracts' && FINANCE_UPLOAD_MEDIA.has(media);
    };
    const ownerRoutes = await ownerRoutesFactory({ authorize, core });
    if (!ownerRoutes?.handle) throw Object.assign(Error('Owner routes missing'), { code: 'RUNTIME_NOT_READY' });
    const boundHandlers = await Promise.all(handlerFactories.map(factory => factory({ authorize, core })));
    const handlers = [ownerRoutes, ...otherHandlers, ...boundHandlers].map(item => typeof item === 'function' ? { handle: item } : item);
    if (handlers.some(item => typeof item?.handle !== 'function')) throw new TypeError('Every handler must provide handle');
    server = http.createServer((req, res) => requestMetrics.run(req, res, async () => {
      let releaseApiGet = null;
      active++; res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
      try {
        if (!healthy || closing || req.headers.host !== new URL(origin).host) { res.writeHead(503).end(); return; }
        const url = new URL(req.url, origin);
        if (url.pathname.startsWith('/api/')) {
          if (!await authorize(req, url)) { json(res, 403, { error: 'Откройте страницу подключения' }); return; }
          if (url.pathname === '/api/runtime-metrics' && req.method === 'GET') { json(res, 200, requestMetrics.snapshot()); return; }
          if (url.pathname === '/api/stores' && req.method === 'GET') { if (typeof core.registryRevision === 'function') res.setHeader('X-Pult-Registry-Revision', await core.registryRevision()); json(res, 200, await core.publicStores()); return; }
          if (req.method === 'GET') {
            const lane = url.pathname === '/api/data' || url.pathname === '/api/insights' ? apiGetLanes.light : HEAVY_READ_ROUTES.has(url.pathname) ? apiGetLanes.heavy : apiGetLanes.regular;
            const slot = await apiGetSlot(lane, req, res);
            if (typeof slot !== 'function') { if (slot === 'timeout' || slot === 'busy') res.setHeader('Retry-After', '1'); unavailable(res); return; }
            releaseApiGet = slot;
            if (!healthy || closing || req.aborted || res.destroyed || res.writableEnded) { unavailable(res); return; }
          }
          if (url.pathname === '/api/data' && req.method === 'GET') {
            const id = url.searchParams.get('id'); if (!id) { json(res, 404, { error: 'Магазин не подключён' }); return; }
            const snapshot = await core.publicSnapshot(id);
            if (snapshot === null && !await core.hasStore(id)) { json(res, 404, { error: 'Магазин не подключён' }); return; }
            json(res, 200, snapshot); return;
          }
          if (['/api/market-history/report', '/api/stock-history/report', '/api/stock-history/export'].includes(url.pathname)) {
            const store = url.searchParams.get('store'); if (store && !await core.hasStore(store)) { json(res, 400, { error: 'Проверьте магазин.' }); return; }
          }
          for (const handler of handlers) if (await handler.handle(req, res, url)) return;
          json(res, 404, { error: 'Не найдено' }); return;
        }
        if (req.method !== 'GET') { res.writeHead(405).end(); return; }
        const pathname = url.pathname === '/' ? '/index.html' : url.pathname, declared = publicFiles.get(pathname), extension = path.extname(pathname).toLowerCase();
        if (!declared) { res.writeHead(404).end(); return; }
        let bytes;
        try {
          const file = await fs.realpath(declared), stat = await fs.stat(file);
          if (!stat.isFile() || file !== root && !file.startsWith(root + path.sep)) throw Error('outside public root');
          bytes = await fs.readFile(file);
        } catch { res.writeHead(404).end(); return; }
        if (!sessions.has(token(req)) && extension === '.html') { const value = crypto.randomBytes(32).toString('hex'); sessions.add(value); res.setHeader('Set-Cookie', `pult_session=${value}; HttpOnly; SameSite=Strict; Path=/`); }
        res.setHeader('Content-Type', MIME[extension]); res.setHeader('Cache-Control', 'no-store'); res.end(bytes);
      } catch { if (!res.headersSent) json(res, 503, { error: 'SQL runtime временно недоступен.' }); else res.destroy(); }
      finally { releaseApiGet?.(); active--; drained(); }
    }));
    let closeRuntime = async () => {};
    const invalidate = () => { healthy = false; void closeRuntime(true); };
    if (typeof lease.on === 'function') { lease.on('error', invalidate); lease.on('end', invalidate); }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    if (!healthy) throw Object.assign(Error('Owner runtime lease was lost'), { code: 'RUNTIME_LEASE_LOST' });
    origin = `http://127.0.0.1:${server.address().port}`;
    for (const task of background) {
      if (!healthy) throw Object.assign(Error('Owner runtime lease was lost'), { code: 'RUNTIME_LEASE_LOST' });
      if (typeof task?.start !== 'function' || typeof task?.close !== 'function') throw new TypeError('Background providers require start and close');
      startedBackground.push(task); await task.start();
    }
    if (!healthy) throw Object.assign(Error('Owner runtime lease was lost'), { code: 'RUNTIME_LEASE_LOST' });
    closeRuntime = async (leaseLost = false) => {
      if (closePromise) return closePromise;
      closing = true;
      cancelQueuedApiGets();
      if (leaseLost) healthy = false;
      closePromise = (async () => {
        await Promise.allSettled(startedBackground.map(task => task.close()));
        if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); });
        if (active) await new Promise(resolve => { settleDrain = resolve; });
        let destroy = !healthy;
        if (healthy) try { const unlocked = await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked', ['pult:owner:runtime']); if (unlocked.rows?.[0]?.unlocked !== true) destroy = true; } catch { destroy = true; }
        healthy = false; try { lease.release(destroy || undefined); } catch {}
      })();
      return closePromise;
    };
    const close = () => closeRuntime(false);
    return Object.freeze({ server, origin, core, close });
  } catch (error) {
    await Promise.allSettled(startedBackground.map(task => task.close()));
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); });
    if (lease) { try { lease.release(true); } catch {} }
    throw error;
  }
}

module.exports = { start };
