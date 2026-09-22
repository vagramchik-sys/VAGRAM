'use strict';

const { createPostgresIdeas } = require('./postgres-ideas.cjs');
const { createPostgresProcurement } = require('./postgres-procurement.cjs');

class WorkspaceToolsError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'WorkspaceToolsError'; this.status = status; this.public = true; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function createPostgresWorkspaceTools({ stateStore, ideas = createPostgresIdeas({ stateStore }), procurement = createPostgresProcurement({ stateStore }) } = {}) {
  const routes = new Set(['/api/ideas', '/api/ideas/create', '/api/ideas/update', '/api/procurement', '/api/procurement/parse', '/api/procurement/request', '/api/procurement/import', '/api/procurement/compare']);
  const reply = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function body(req) {
    const chunks = []; let bytes = 0;
    for await (const part of req) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length;
      if (bytes > 1500000) throw new WorkspaceToolsError('Слишком большой запрос. Разделите прайс на файлы меньшего размера.', 413);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw new WorkspaceToolsError('Некорректный формат запроса'); }
  }
  function command(req, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceToolsError('Некорректный формат команды');
    const headerId = req.headers?.['x-pult-command-id'], headerTime = req.headers?.['x-pult-command-timestamp'];
    if (headerId !== undefined && value.commandId !== undefined && headerId !== value.commandId) throw new WorkspaceToolsError('Идентификатор команды не совпадает');
    if (headerTime !== undefined && value.timestamp !== undefined && headerTime !== value.timestamp) throw new WorkspaceToolsError('Время команды не совпадает');
    const commandId = headerId ?? value.commandId, timestamp = headerTime ?? value.timestamp;
    if (typeof commandId !== 'string' || !UUID.test(commandId) || typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)))
      throw new WorkspaceToolsError('Для изменения нужны стабильные commandId и timestamp');
    return { commandId: commandId.toLowerCase(), timestamp };
  }
  async function handle(req, res, url) {
    if (!routes.has(url.pathname)) return false;
    try {
      const p = url.pathname;
      if (req.method === 'GET' && p === '/api/ideas') reply(res, 200, await ideas.read());
      else if (req.method === 'POST' && p === '/api/ideas/create') { const value = await body(req); reply(res, 200, await ideas.create(value, command(req, value))); }
      else if (req.method === 'POST' && p === '/api/ideas/update') { const value = await body(req); reply(res, 200, await ideas.update(value, command(req, value))); }
      else if (req.method === 'GET' && p === '/api/procurement') reply(res, 200, await procurement.read());
      else if (req.method === 'GET' && p === '/api/procurement/compare') reply(res, 200, await procurement.compare({ requestId: url.searchParams.get('id') }));
      else if (req.method === 'POST' && p === '/api/procurement/parse') reply(res, 200, procurement.parseRequest(await body(req)));
      else if (req.method === 'POST' && p === '/api/procurement/request') { const value = await body(req); reply(res, 200, await procurement.saveRequest(value, command(req, value))); }
      else if (req.method === 'POST' && p === '/api/procurement/import') { const value = await body(req); reply(res, 200, await procurement.importPriceList(value, command(req, value))); }
      else reply(res, 405, { error: 'Метод не поддерживается' });
    } catch (error) {
      reply(res, error.public ? error.status || 400 : 500, { error: error.public ? error.message : 'Не удалось выполнить операцию. Введённые данные можно сохранить повторно после проверки.' });
    }
    return true;
  }
  // Startup owns this stable envelope. Construction never performs a write.
  const seedIdeas = commandEnvelope => ideas.seedFirstIdea(commandEnvelope);
  return Object.freeze({ handle, seedIdeas });
}

module.exports = createPostgresWorkspaceTools;
module.exports.createPostgresWorkspaceTools = createPostgresWorkspaceTools;
module.exports.WorkspaceToolsError = WorkspaceToolsError;
