'use strict';
const createWorkspace = require('./charity-workspace.cjs');
// Call only after the main server's owner-session and Origin guards.
// This module never performs payments, fetches remote data or initializes sample history.
module.exports = function createCharityTools({ privateDir, workspace }) {
  let instance = workspace;
  const charity = () => instance || (instance = createWorkspace({ privateDir }));
  const routes = new Set(['/api/charity', '/api/charity/import']);
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  async function body(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new createWorkspace.CharityError('Импорт поддерживает JSON.', 415);
    const chunks = []; let bytes = 0;
    for await (const part of req) { const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new createWorkspace.CharityError('Выгрузка превышает 8 МБ. Разделите её на части.', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new createWorkspace.CharityError('Некорректный JSON выгрузки.'); }
  }
  async function handle(req, res, url) {
    if (!routes.has(url.pathname)) return false;
    try {
      if (req.method === 'GET' && url.pathname === '/api/charity') {
        const filters = {};
        for (const [key, value] of url.searchParams) { if (!['from', 'to', 'store', 'status'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new createWorkspace.CharityError('Неизвестный или повторяющийся фильтр.'); filters[key === 'store' ? 'storeId' : key] = value; }
        reply(res, 200, charity().read(filters));
      } else if (req.method === 'POST' && url.pathname === '/api/charity/import') {
        if (url.search) throw new createWorkspace.CharityError('Параметры URL импорта не поддерживаются.');
        reply(res, 200, charity().importRecords(await body(req)));
      } else reply(res, 405, { error: 'Метод не поддерживается.' });
    } catch (error) { reply(res, error.public ? error.status || 400 : 503, { error: error.public ? error.message : 'История благотворительности временно недоступна. Импорт не выполнен.' }); }
    return true;
  }
  return { handle };
};
