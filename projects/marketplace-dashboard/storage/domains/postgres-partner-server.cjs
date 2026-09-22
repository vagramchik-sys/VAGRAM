'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { PartnerError } = require('./postgres-partner-workspace.cjs');
const cookieName = 'pult_partner_session';
class PartnerServerError extends Error { constructor(message, status) { super(message); this.status = status; } }
const ASSETS = new Map([['/', ['partner.html', 'text/html']], ['/partner', ['partner.html', 'text/html']], ['/partner.html', ['partner.html', 'text/html']], ['/partner.js', ['partner.js', 'application/javascript']], ['/partner.css', ['partner.css', 'text/css']]]);
async function start({ workspace, staticDir = path.resolve(__dirname, '..', '..', 'dist'), port = 0, host = '127.0.0.1', now = () => Date.now(), sessionTtlMs = 8 * 60 * 60 * 1000 } = {}) {
  for (const method of ['authenticateCredential', 'authorizeSession', 'snapshotForPartner']) if (typeof workspace?.[method] !== 'function') throw new TypeError('workspace adapter is required');
  if (host !== '127.0.0.1') throw Error('Partner listener must remain on 127.0.0.1');
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1 || sessionTtlMs > 8 * 60 * 60 * 1000) throw Error('Invalid session expiry');
  const sessions = new Map(), attempts = new Map(); let origin;
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const deny = (res, status, message) => json(res, status, { error: message });
  async function currentSession(req) {
    const cookies = String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(cookieName + '='));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice(cookieName.length + 1), found = sessions.get(token);
    if (!found || found.expires <= now() || await workspace.authorizeSession(found) !== true) { sessions.delete(token); return null; }
    return { ...found, token };
  }
  async function body(req) {
    if (!/^application\/json(?:;|$)/iu.test(req.headers['content-type'] || '')) throw new PartnerServerError('Ожидается JSON.', 415);
    let bytes = 0; const chunks = []; for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 4096) throw new PartnerServerError('Запрос слишком большой.', 413); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; } catch { throw new PartnerServerError('Некорректный JSON.', 400); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host) return deny(res, 403, 'Недопустимый адрес запроса.');
      if (req.headers['sec-fetch-site'] === 'cross-site') return deny(res, 403, 'Недопустимый источник запроса.');
      if (!req.url.startsWith('/') || req.url.startsWith('//')) return deny(res, 404, 'Не найдено.');
      const url = new URL(req.url, origin); if (url.search) return deny(res, 400, 'Параметры запроса не поддерживаются.');
      if (req.method === 'GET' && ASSETS.has(url.pathname)) { const [file, type] = ASSETS.get(url.pathname), content = await fs.readFile(path.join(staticDir, file)); res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content); return; }
      if (req.method === 'POST' && ['/api/partner/login', '/api/partner/logout'].includes(url.pathname)) {
        if (req.headers.origin !== origin) return deny(res, 403, 'Недопустимый источник запроса.');
        if (url.pathname.endsWith('/logout')) { const active = await currentSession(req); if (active) sessions.delete(active.token); res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); return json(res, 200, { ok: true }); }
        const remote = req.socket.remoteAddress, time = now(); for (const [key, value] of attempts) if (time >= value.until) attempts.delete(key);
        const attempt = attempts.get(remote) || { count: 0, until: time + 15 * 60 * 1000 }; if (attempt.count >= 10) { res.setHeader('Retry-After', String(Math.ceil((attempt.until - time) / 1000))); return deny(res, 429, 'Слишком много попыток. Повторите позже.'); } attempt.count++; attempts.set(remote, attempt);
        const input = await body(req); if (Object.keys(input).some(key => key !== 'credential')) return deny(res, 400, 'Запрос содержит неподдерживаемые поля.');
        const auth = await workspace.authenticateCredential(input.credential); if (!auth) return deny(res, 401, 'Неверный или отозванный код доступа.');
        for (const [token, value] of sessions) if (value.expires <= time) sessions.delete(token); if (sessions.size >= 1000) return deny(res, 503, 'Сервис временно занят.');
        const token = crypto.randomBytes(32).toString('base64url'); sessions.set(token, { ...auth, expires: time + sessionTtlMs }); res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}`); return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/partner/dashboard') { const active = await currentSession(req); if (!active) return deny(res, 401, 'Войдите в кабинет партнёра.'); if (await workspace.authorizeSession(active) !== true) { sessions.delete(active.token); return deny(res, 401, 'Войдите в кабинет партнёра.'); } return json(res, 200, await workspace.snapshotForPartner(active.partnerId, active)); }
      return deny(res, 404, 'Не найдено.');
    } catch (error) { if (res.headersSent) return res.end(); const known = error instanceof PartnerServerError || error instanceof PartnerError; deny(res, known ? error.status : 503, known ? error.message : 'Кабинет временно недоступен.'); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); origin = `http://127.0.0.1:${server.address().port}`; server.partnerOrigin = origin; return server;
}
module.exports = { start, cookieName };
