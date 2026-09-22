'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const STATIC_EXTENSIONS = new Set(Object.keys(MIME));
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };

async function start({ pool, core, ownerRoutesFactory, otherHandlers = [], background = [], staticDir, staticFiles, port = 0, readiness } = {}) {
  if (!pool?.connect || !core || !['ready', 'publicStores', 'publicSnapshot', 'hasStore'].every(name => typeof core[name] === 'function')) throw new TypeError('SQL pool and core are required');
  if (typeof ownerRoutesFactory !== 'function' || !Array.isArray(otherHandlers) || !Array.isArray(background) || typeof readiness !== 'function') throw new TypeError('Explicit complete handler readiness is required');
  if (typeof staticDir !== 'string' || !path.isAbsolute(staticDir) || !Array.isArray(staticFiles) || !staticFiles.length || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('staticDir, staticFiles and port are invalid');
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
  const startedBackground = [];
  const drained = () => active === 0 && settleDrain?.();
  try {
    lease = await pool.connect();
    const locked = await lease.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', ['pult:owner:runtime']);
    if (locked.rows?.[0]?.acquired !== true) throw Object.assign(Error('Owner runtime already active'), { code: 'RUNTIME_LEASE_BUSY' });
    const sessions = new Set();
    let origin;
    const token = req => (req.headers.cookie || '').match(/(?:^|; )pult_session=([a-f0-9]{64})(?:;|$)/u)?.[1];
    const authorize = async (req) => {
      if (!healthy || closing || req.headers.host !== new URL(origin).host || !sessions.has(token(req))) return false;
      return req.method !== 'POST' || req.headers.origin === origin && req.headers['content-type']?.startsWith('application/json');
    };
    const ownerRoutes = await ownerRoutesFactory({ authorize, core });
    if (!ownerRoutes?.handle) throw Object.assign(Error('Owner routes missing'), { code: 'RUNTIME_NOT_READY' });
    const handlers = [ownerRoutes, ...otherHandlers].map(item => typeof item === 'function' ? { handle: item } : item);
    if (handlers.some(item => typeof item?.handle !== 'function')) throw new TypeError('Every handler must provide handle');
    server = http.createServer(async (req, res) => {
      active++; res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
      try {
        if (!healthy || closing || req.headers.host !== new URL(origin).host) { res.writeHead(503).end(); return; }
        const url = new URL(req.url, origin);
        if (url.pathname.startsWith('/api/')) {
          if (!await authorize(req, url)) { json(res, 403, { error: 'Откройте страницу подключения' }); return; }
          if (url.pathname === '/api/stores' && req.method === 'GET') { json(res, 200, await core.publicStores()); return; }
          if (url.pathname === '/api/data' && req.method === 'GET') {
            const id = url.searchParams.get('id'); if (!id || !await core.hasStore(id)) { json(res, 404, { error: 'Магазин не подключён' }); return; }
            json(res, 200, await core.publicSnapshot(id)); return;
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
      finally { active--; drained(); }
    });
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
