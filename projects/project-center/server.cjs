'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const os = require('node:os');
const projectsModel = require('./projects-model.cjs');
const directors = require('./directors-catalog.cjs');
const dispatchModule = require('./dispatcher.cjs');
const { publicMessage } = require('./ai-errors.cjs');
const root = __dirname;
const dataDir = path.resolve(process.env.OZON_DATA_DIR || path.join(root, 'data'));
const storeFile = path.join(dataDir, 'store.json');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'model.js'), 'utf8'), sandbox);
const model = sandbox.window.OzonModel;
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
let db = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : {
  users: [], state: { products: [], sales: [], expenses: [] }, version: 0
};
if (!Array.isArray(db.users) || !Number.isSafeInteger(db.version) || db.version < 0 || !model.validateState(db.state).ok) throw new Error('Invalid data store');
model.summarize(db.state);
const needsProjectsMigration = !Object.hasOwn(db, 'projects') || !Object.hasOwn(db, 'projectsVersion');
if (!Object.hasOwn(db, 'projects')) db.projects = { items: [], tasks: [] };
if (!Object.hasOwn(db, 'projectsVersion')) db.projectsVersion = 0;
if (!Number.isSafeInteger(db.projectsVersion) || db.projectsVersion < 0 || !projectsModel.validateState(db.projects).ok) throw new Error('Invalid projects data store');
function save(next) {
  const tmp = storeFile + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, storeFile);
    db = next;
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
let needsDirectorMigration = !Object.hasOwn(db, 'directorConversations');
if (needsDirectorMigration) db.directorConversations = {};
if (!db.directorConversations || typeof db.directorConversations !== 'object' || Array.isArray(db.directorConversations)) throw new Error('Invalid director conversations store');
for (const conversation of Object.values(db.directorConversations)) {
  if (!conversation || !Array.isArray(conversation.messages) || !Array.isArray(conversation.requests)) throw new Error('Invalid director conversation');
  for (const marker of conversation.requests) if (marker.status === 'pending') {
    marker.status = 'failed';
    conversation.messages.push({ id: crypto.randomUUID(), role: 'system', text: 'Сервер был перезапущен до завершения ответа. Ответ не получен. Отправьте сообщение ещё раз.', createdAt: new Date().toISOString(), projectId: marker.projectId || '' });
    needsDirectorMigration = true;
  }
  conversation.messages = conversation.messages.slice(-200);
  conversation.requests = conversation.requests.slice(-200);
}
const needsDispatchMigration = dispatchModule.initialize(db);
if ((needsProjectsMigration || needsDirectorMigration || needsDispatchMigration) && fs.existsSync(storeFile)) save(db);
const activeDirectorConversations = new Set();
const dispatcher = dispatchModule.createDispatcher({ getDb: () => db, save, capacity: activeDirectorConversations, connection: directorConnection, directors });
function directorConnection() {
  try {
    const adapter = require('./ai-directors.cjs');
    const status = adapter.getStatus();
    return { adapter, status };
  } catch {
    return { adapter: null, status: { available: false, provider: 'local-codex', message: 'Подключение ИИ пока недоступно.' } };
  }
}
function conversationFor(key) {
  return Object.hasOwn(db.directorConversations, key) ? db.directorConversations[key] : { messages: [], requests: [] };
}
function saveConversation(key, conversation) {
  save({ ...db, directorConversations: { ...db.directorConversations, [key]: conversation } });
}
async function generateDirectorReply(key, requestId, adapter, input) {
  let role = 'assistant';
  let text;
  try {
    text = await adapter.generate(input);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Empty AI response');
    text = text.trim().slice(0, 50000);
  } catch (error) {
    role = 'system';
    text = publicMessage(error);
  }
  try {
    const current = conversationFor(key);
    const marker = current.requests.find(item => item.requestId === requestId);
    if (!marker || marker.status !== 'pending') return;
    const message = { id: crypto.randomUUID(), role, text, createdAt: new Date().toISOString(), projectId: marker.projectId };
    saveConversation(key, {
      messages: [...current.messages, message].slice(-200),
      requests: current.requests.map(item => item.requestId === requestId ? { ...item, status: role === 'assistant' ? 'done' : 'failed' } : item).slice(-200)
    });
  } catch {
    console.error('Could not persist director reply; pending request will recover on restart.');
  } finally { activeDirectorConversations.delete(key); }
}
function passwordHash(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function credentials(body) {
  if (!body || typeof body.username !== 'string' || !/^[\p{L}\p{N}_.@-]{3,64}$/u.test(body.username)) throw fail(400, 'Имя: 3–64 буквы, цифры или символы _.@-');
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 1024) throw fail(400, 'Пароль должен содержать от 12 до 1024 символов.');
}
function makeUser(body, role) {
  credentials(body);
  const salt = crypto.randomBytes(16).toString('hex');
  return { username: body.username, role, disabled: false, salt, hash: passwordHash(body.password, salt) };
}
function publicUser(user) { return { username: user.username, role: user.role, disabled: Boolean(user.disabled) }; }
function fail(status, message) { return Object.assign(new Error(message), { status }); }
const sessions = new Map();
const attempts = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
function sweep() {
  const now = Date.now();
  for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
  for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key);
}
setInterval(sweep, 60000).unref();
function throttle(req, scope = 'login') {
  sweep();
  const key = scope + ':' + req.socket.remoteAddress;
  let value = attempts.get(key);
  if (!value) {
    if (attempts.size >= 10000) throw fail(429, 'Слишком много попыток. Попробуйте позже.');
    attempts.set(key, value = { count: 0, expires: Date.now() + LOGIN_WINDOW });
  }
  if (++value.count > 10) throw fail(429, 'Слишком много попыток. Повторите через 15 минут.');
}
function tokenFrom(req) {
  const match = /(?:^|;\s*)ozon_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  return match ? match[1] : '';
}
function currentUser(req) {
  const token = tokenFrom(req);
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires <= Date.now()) { sessions.delete(token); return null; }
  return db.users.find(user => user.username === session.username && !user.disabled) || null;
}
function requireUser(req, role) {
  const user = currentUser(req);
  if (!user) throw fail(401, 'Необходимо войти.');
  if (role && user.role !== role) throw fail(403, 'Требуются права администратора.');
  return user;
}
function invalidateSessions(username) {
  for (const [token, session] of sessions) if (session.username === username) sessions.delete(token);
}
function login(req, res, user) {
  sweep();
  if (sessions.size >= 10000) throw fail(503, 'Слишком много активных сеансов.');
  sessions.delete(tokenFrom(req));
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: user.username, expires: Date.now() + SESSION_TTL });
  res.setHeader('Set-Cookie', 'ozon_session=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200');
}
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  const limit = 2 * 1024 * 1024;
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'Ожидается application/json.');
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw fail(413, 'Размер запроса превышает 2 МБ.'); }
  let size = 0;
  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        reject(fail(413, 'Размер запроса превышает 2 МБ.'));
      } else chunks.push(chunk);
    });
    req.once('end', resolve);
    req.once('error', reject);
    req.once('aborted', () => reject(fail(400, 'Передача запроса прервана.')));
  });
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail(400, 'Некорректный JSON.'); }
}
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', os.hostname().toLowerCase(), host.toLowerCase()]);
if (host === '0.0.0.0' || host === '::') {
  for (const list of Object.values(os.networkInterfaces())) for (const item of list || []) allowedHosts.add(item.family === 'IPv6' ? '[' + item.address.toLowerCase() + ']' : item.address);
}
const staticFiles = { '/index.html': 'text/html', '/style.css': 'text/css', '/app.js': 'text/javascript', '/admin.js': 'text/javascript', '/model.js': 'text/javascript', '/reports.js': 'text/javascript', '/login.html': 'text/html', '/sales-template.csv': 'text/csv' };
Object.assign(staticFiles, { '/projects.html': 'text/html', '/projects.js': 'text/javascript', '/projects.css': 'text/css' });
Object.assign(staticFiles, { '/directors.html': 'text/html', '/directors.js': 'text/javascript', '/directors.css': 'text/css' });
staticFiles['/dispatcher.js'] = 'text/javascript';
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  try {
    let url;
    try { url = new URL(req.url, 'http://' + req.headers.host); } catch { throw fail(400, 'Некорректный адрес.'); }
    if (!allowedHosts.has(url.hostname.toLowerCase()) || url.host !== req.headers.host || url.protocol !== 'http:') throw fail(403, 'Недопустимый адрес сервера.');
    const writing = !['GET', 'HEAD'].includes(req.method);
    if (writing && req.headers.origin !== url.origin) throw fail(403, 'Запрос должен поступать с этой страницы сервиса.');
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/api/setup-status') return send(res, 200, { needsSetup: db.users.length === 0 });
    if (req.method === 'POST' && (pathname === '/api/setup' || pathname === '/api/login')) {
      throttle(req);
      const data = await body(req);
      if (pathname === '/api/setup') {
        if (db.users.length) throw fail(409, 'Администратор уже создан.');
        const user = makeUser(data, 'admin');
        save({ ...db, users: [user] });
        login(req, res, user);
        return send(res, 201, { user: publicUser(user) });
      }
      credentials(data);
      const user = db.users.find(item => item.username === data.username);
      const hash = passwordHash(data.password, user ? user.salt : 'not-a-user-random-salt');
      if (!user || user.disabled || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'))) throw fail(401, 'Неверное имя пользователя или пароль.');
      login(req, res, user);
      return send(res, 200, { user: publicUser(user) });
    }
    const user = currentUser(req);
    if (pathname.startsWith('/api/')) {
      if (!user) throw fail(401, 'Необходимо войти.');
      if (req.method === 'GET' && pathname === '/api/dispatch') return send(res, 200, { runs: dispatcher.list(user.username) });
      const dispatchStart = /^\/api\/dispatch\/([0-9a-f-]{36})\/start$/i.exec(pathname);
      if (req.method === 'POST' && (pathname === '/api/dispatch' || dispatchStart)) {
        if (!['admin', 'editor'].includes(user.role)) throw fail(403, 'Доступ только для просмотра.');
        const data = await body(req);
        const actor = requireUser(req);
        if (!['admin', 'editor'].includes(actor.role)) throw fail(403, 'Доступ только для просмотра.');
        const run = dispatchStart ? dispatcher.start(actor.username, dispatchStart[1]) : dispatcher.create(actor.username, data);
        return send(res, 202, { run });
      }
      if (req.method === 'GET' && pathname === '/api/directors') {
        return send(res, 200, { directors: directors.map(({ prompt, ...publicDirector }) => publicDirector), user: publicUser(user), connection: directorConnection().status, projects: db.projects.items.map(({ id, name }) => ({ id, name })) });
      }
      const directorMatch = /^\/api\/directors\/([a-z]+)(\/messages)?$/.exec(pathname);
      if (directorMatch) {
        const director = directors.find(item => item.id === directorMatch[1]);
        if (!director) throw fail(404, 'Директор не найден.');
        const key = JSON.stringify([user.username, director.id]);
        if (req.method === 'GET' && !directorMatch[2]) {
          return send(res, 200, { messages: conversationFor(key).messages.map(({ id, role, text, createdAt, projectId }) => ({ id, role, text, createdAt, projectId })), busy: activeDirectorConversations.has(key) });
        }
        if (req.method === 'POST' && directorMatch[2]) {
          if (!['admin', 'editor'].includes(user.role)) throw fail(403, 'Доступ только для просмотра.');
          const data = await body(req);
          if (!['admin', 'editor'].includes(requireUser(req).role)) throw fail(403, 'Доступ только для просмотра.');
          if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 6000) throw fail(400, 'Сообщение должно содержать от 1 до 6000 символов.');
          if (typeof data.projectId !== 'string' || data.projectId.length > 128) throw fail(400, 'Некорректный проект.');
          if (typeof data.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.requestId)) throw fail(400, 'Требуется уникальный requestId в формате UUID.');
          const requestId = data.requestId.toLowerCase();
          const text = data.text.trim();
          const fingerprint = crypto.createHash('sha256').update(JSON.stringify([text, data.projectId])).digest('hex');
          const conversation = conversationFor(key);
          const prior = conversation.requests.find(item => item.requestId === requestId);
          if (prior) {
            if (prior.fingerprint !== fingerprint) throw fail(409, 'Этот requestId уже использован для другого сообщения.');
            return send(res, 202, { requestId, busy: activeDirectorConversations.has(key) });
          }
          const selected = data.projectId ? db.projects.items.find(item => item.id === data.projectId) : null;
          if (data.projectId && !selected) throw fail(400, 'Проект не найден.');
          if (activeDirectorConversations.has(key)) throw fail(409, 'Дождитесь ответа директора на предыдущее сообщение.');
          if (activeDirectorConversations.size >= 2) throw fail(429, 'Сейчас формируются два ответа. Повторите чуть позже.');
          const connection = directorConnection();
          if (!connection.adapter || !connection.status.available) throw fail(503, 'Подключение ИИ недоступно. Сообщение не отправлено.');
          const project = selected ? { ...selected, tasks: db.projects.tasks.filter(item => item.projectId === selected.id).slice(0, 30).map(item => ({ ...item })) } : director.id === 'general' ? {
            scope: 'portfolio', asOf: new Date().toISOString(),
            totals: { projects: db.projects.items.length, activeProjects: db.projects.items.filter(p => p.status === 'active').length, openTasks: db.projects.tasks.filter(t => t.status !== 'done').length },
            projects: db.projects.items.filter(p => p.status !== 'done').slice(0, 20).map(p => ({ ...p, description: p.description.slice(0, 800) })),
            tasks: db.projects.tasks.filter(t => t.status !== 'done').sort((a,b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')).slice(0, 60).map(t => ({ ...t })),
            coverage: 'Контекст ограничен первыми 20 незавершёнными проектами и 60 открытыми задачами, сначала с ближайшими сроками. Это снимок учётных записей, не подтверждение фактического выполнения.'
          } : null;
          const message = { id: crypto.randomUUID(), role: 'user', text, createdAt: new Date().toISOString(), projectId: data.projectId };
          const next = { messages: [...conversation.messages, message].slice(-200), requests: [...conversation.requests, { requestId, fingerprint, projectId: data.projectId, status: 'pending' }].slice(-200) };
          saveConversation(key, next);
          activeDirectorConversations.add(key);
          const input = { director, history: next.messages.slice(-20).map(item => ({ ...item })), project };
          setImmediate(() => { void generateDirectorReply(key, requestId, connection.adapter, input); });
          return send(res, 202, { requestId, busy: true });
        }
        throw fail(405, 'Метод не поддерживается.');
      }
      if (req.method === 'POST' && pathname === '/api/logout') {
        sessions.delete(tokenFrom(req));
        res.setHeader('Set-Cookie', 'ozon_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, { state: db.state, version: db.version, user: publicUser(user) });
      if (req.method === 'GET' && pathname === '/api/projects') return send(res, 200, { state: db.projects, version: db.projectsVersion, user: publicUser(user) });
      if (req.method === 'PUT' && pathname === '/api/projects') {
        if (!['admin', 'editor'].includes(user.role)) throw fail(403, 'Доступ только для просмотра.');
        const data = await body(req);
        if (!['admin', 'editor'].includes(requireUser(req).role)) throw fail(403, 'Доступ только для просмотра.');
        if (!Number.isSafeInteger(data.version) || data.version < 0) throw fail(400, 'Некорректная версия проектов.');
        if (data.version !== db.projectsVersion) throw fail(409, 'Проекты изменены другим сотрудником. Обновите страницу и повторите изменения.');
        const checked = projectsModel.validateState(data.state);
        if (!checked.ok) throw fail(400, checked.errors.slice(0, 10).join('\n'));
        if (db.projectsVersion >= Number.MAX_SAFE_INTEGER) throw fail(409, 'Лимит версий проектов.');
        save({ ...db, projects: data.state, projectsVersion: db.projectsVersion + 1 });
        return send(res, 200, { version: db.projectsVersion });
      }
      if (req.method === 'POST' && pathname === '/api/password') {
        throttle(req, 'password');
        const data = await body(req);
        const freshUser = requireUser(req);
        if (typeof data.currentPassword !== 'string' || data.currentPassword.length > 1024) throw fail(400, 'Некорректный текущий пароль.');
        credentials({ username: freshUser.username, password: data.newPassword });
        const hash = passwordHash(data.currentPassword, freshUser.salt);
        if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(freshUser.hash, 'hex'))) throw fail(401, 'Неверный текущий пароль.');
        const salt = crypto.randomBytes(16).toString('hex');
        const updated = { ...freshUser, salt, hash: passwordHash(data.newPassword, salt) };
        save({ ...db, users: db.users.map(item => item.username === freshUser.username ? updated : item) });
        invalidateSessions(freshUser.username);
        res.setHeader('Set-Cookie', 'ozon_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return send(res, 200, { ok: true });
      }
      if (req.method === 'PUT' && pathname === '/api/state') {
        if (user.role === 'viewer') throw fail(403, 'Доступ только для просмотра.');
        const data = await body(req);
        if (requireUser(req).role === 'viewer') throw fail(403, 'Доступ только для просмотра.');
        if (!Number.isSafeInteger(data.version) || data.version < 0) throw fail(400, 'Некорректная версия.');
        if (data.version !== db.version) throw fail(409, 'Данные изменены другим сотрудником. Обновите страницу и повторите изменения.');
        const checked = model.validateState(data.state);
        if (!checked.ok) throw fail(400, checked.errors.slice(0, 10).join('\n'));
        try { model.summarize(data.state); } catch (error) { throw fail(400, error.message); }
        if (db.version >= Number.MAX_SAFE_INTEGER) throw fail(409, 'Лимит версий данных.');
        save({ ...db, state: data.state, version: db.version + 1 });
        return send(res, 200, { version: db.version });
      }
      if (pathname === '/api/users') {
        if (user.role !== 'admin') throw fail(403, 'Требуются права администратора.');
        if (req.method === 'GET') return send(res, 200, { users: db.users.map(publicUser) });
        if (req.method === 'POST') {
          const data = await body(req);
          requireUser(req, 'admin');
          if (!['admin', 'editor', 'viewer'].includes(data.role)) throw fail(400, 'Некорректная роль.');
          credentials(data);
          if (db.users.some(item => item.username === data.username)) throw fail(409, 'Такое имя уже занято.');
          const created = makeUser(data, data.role);
          save({ ...db, users: [...db.users, created] });
          return send(res, 201, { user: publicUser(created) });
        }
        if (req.method === 'PATCH') {
          const data = await body(req);
          const actor = requireUser(req, 'admin');
          const hasRole = Object.hasOwn(data, 'role');
          const hasDisabled = Object.hasOwn(data, 'disabled');
          if (typeof data.username !== 'string' || !data.username || (!hasRole && !hasDisabled)) throw fail(400, 'Укажите имя пользователя и роль или статус блокировки.');
          if (hasRole && !['admin', 'editor', 'viewer'].includes(data.role)) throw fail(400, 'Некорректная роль.');
          if (hasDisabled && typeof data.disabled !== 'boolean') throw fail(400, 'Статус блокировки должен быть логическим значением.');
          const target = db.users.find(item => item.username === data.username);
          if (!target) throw fail(404, 'Пользователь не найден.');
          const updated = { ...target, role: hasRole ? data.role : target.role, disabled: hasDisabled ? data.disabled : Boolean(target.disabled) };
          if (actor.username === target.username && (updated.disabled || updated.role !== 'admin')) throw fail(403, 'Нельзя заблокировать себя или понизить собственную роль.');
          const nextUsers = db.users.map(item => item.username === target.username ? updated : item);
          if (!nextUsers.some(item => item.role === 'admin' && !item.disabled)) throw fail(409, 'Нельзя отключить последнего активного администратора.');
          if (updated.role !== target.role || updated.disabled !== Boolean(target.disabled)) {
            save({ ...db, users: nextUsers });
            invalidateSessions(target.username);
          }
          return send(res, 200, { user: publicUser(updated) });
        }
      }
      throw fail(404, 'API не найден.');
    }
    if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'Метод не поддерживается.');
    if (pathname === '/') { res.writeHead(302, { Location: user ? '/projects.html' : '/login.html' }); return res.end(); }
    const filePath = pathname;
    if (!Object.hasOwn(staticFiles, filePath)) throw fail(404, 'Файл не найден.');
    if (!user && !['/login.html', '/style.css'].includes(filePath)) {
      if (filePath === '/index.html' || filePath === '/projects.html' || filePath === '/directors.html') { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
      throw fail(401, 'Необходимо войти.');
    }
    const file = path.join(root, filePath.slice(1));
    if (!fs.existsSync(file)) throw fail(404, 'Файл не найден.');
    res.writeHead(200, { 'Content-Type': staticFiles[filePath] + '; charset=utf-8' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    if (!error.status) console.error('Request failed:', error.message);
    if (!res.headersSent && !res.destroyed) send(res, error.status || 500, { error: error.status ? error.message : 'Ошибка сервера. Данные не сохранены.' });
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(port, host, () => console.log('Ozon Manager: http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + server.address().port));
