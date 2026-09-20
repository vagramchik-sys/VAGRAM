'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const createWorkspace = require('./partner-workspace.cjs');
const cookieName = 'pult_partner_session';
async function start({ privateDir, getProducts, getSales, workspace, port = 4319, host = '127.0.0.1', now = () => Date.now(), sessionTtlMs = 8 * 60 * 60 * 1000 }) {
  if (host !== '127.0.0.1') throw Error('Partner listener must remain on 127.0.0.1');
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1 || sessionTtlMs > 8 * 60 * 60 * 1000) throw Error('Invalid session expiry');
  workspace ||= createWorkspace({ privateDir, getProducts, getSales, now });
  const sessions = new Map(), attempts = new Map();
  const assets = new Map([['/', ['partner.html', 'text/html']], ['/partner', ['partner.html', 'text/html']], ['/partner.html', ['partner.html', 'text/html']], ['/partner.js', ['partner.js', 'application/javascript']], ['/partner.css', ['partner.css', 'text/css']]]);
  let origin;
  function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  function deny(res, code, message) { json(res, code, { error: message }); }
  function session(req) {
    const cookies = String(req.headers.cookie || '').split(';').map(p => p.trim()).filter(p => p.startsWith(cookieName + '='));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice(cookieName.length + 1), found = sessions.get(token);
    if (!found || found.expires <= now() || !workspace.authorizeSession(found)) { sessions.delete(token); return null; }
    return { ...found, token };
  }
  async function body(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(Error('Ожидается JSON.'), { status: 415 });
    let bytes = 0, chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) throw Object.assign(Error('Запрос слишком большой.'), { status: 413 }); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; } catch { throw Object.assign(Error('Некорректный JSON.'), { status: 400 }); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host) return deny(res, 403, 'Недопустимый адрес запроса.');
      if (req.headers['sec-fetch-site'] === 'cross-site') return deny(res, 403, 'Недопустимый источник запроса.');
      if (!req.url.startsWith('/') || req.url.startsWith('//')) return deny(res, 404, 'Не найдено.');
      const url = new URL(req.url, origin);
      if (url.search) return deny(res, 400, 'Параметры запроса не поддерживаются.');
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        const content = fs.readFileSync(path.join(__dirname, 'dist', file));
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); res.end(content); return;
      }
      if (req.method === 'POST' && ['/api/partner/login', '/api/partner/logout'].includes(url.pathname)) {
        if (req.headers.origin !== origin) return deny(res, 403, 'Недопустимый источник запроса.');
        if (url.pathname.endsWith('/logout')) {
          const current = session(req); if (current) sessions.delete(current.token);
          res.setHeader('Set-Cookie', cookieName + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true });
        }
        const key = req.socket.remoteAddress, time = now();
        for (const [key, a] of attempts) if (time >= a.until) attempts.delete(key);
        const a = attempts.get(key) || { count: 0, until: time + 15 * 60 * 1000 };
        if (a.count >= 10) { res.setHeader('Retry-After', String(Math.ceil((a.until - time) / 1000))); return deny(res, 429, 'Слишком много попыток. Повторите позже.'); }
        a.count++; attempts.set(key, a);
        const input = await body(req);
        if (Object.keys(input).some(k => k !== 'credential')) return deny(res, 400, 'Запрос содержит неподдерживаемые поля.');
        const auth = workspace.authenticateCredential(input.credential);
        if (!auth) return deny(res, 401, 'Неверный или отозванный код доступа.');
        for (const [token, s] of sessions) if (s.expires <= time) sessions.delete(token);
        if (sessions.size >= 1000) return deny(res, 503, 'Сервис временно занят.');
        const token = crypto.randomBytes(32).toString('base64url'); sessions.set(token, { ...auth, expires: time + sessionTtlMs });
        res.setHeader('Set-Cookie', cookieName + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + Math.floor(sessionTtlMs / 1000)); return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/partner/dashboard') {
        const current = session(req); if (!current) return deny(res, 401, 'Войдите в кабинет партнёра.');
        return json(res, 200, workspace.snapshotForPartner(current.partnerId));
      }
      return deny(res, 404, 'Не найдено.');
    } catch (error) {
      if (res.headersSent) return res.end();
      deny(res, error.status || 503, error.public || [400, 413, 415].includes(error.status) ? error.message : 'Кабинет временно недоступен.');
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  server.partnerOrigin = origin;
  return server;
}
module.exports = { start, cookieName };
