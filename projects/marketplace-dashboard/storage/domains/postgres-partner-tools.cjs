'use strict';

const { PartnerError } = require('./postgres-partner-workspace.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROUTES = new Map([
  ['/api/partners/save', 'savePartner'],
  ['/api/partners/issue-credential', 'issueCredential'],
  ['/api/partners/revoke-credential', 'revokeCredential']
]);
class PartnerToolsError extends Error { constructor(message, status = 400) { super(message); this.status = status; this.public = true; } }
const invalid = (message, status) => { throw new PartnerToolsError(message, status); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

module.exports = function createPostgresPartnerTools({ workspace, authorize, getAvailability = async () => false } = {}) {
  for (const method of ['ownerState', 'savePartner', 'issueCredential', 'revokeCredential']) if (typeof workspace?.[method] !== 'function') throw new TypeError('workspace adapter is required');
  if (typeof authorize !== 'function') throw new TypeError('authorize is required');
  const reply = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function body(req) {
    let bytes = 0; const chunks = [];
    for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 1000000) invalid('Запрос слишком большой.', 413); chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { invalid('Некорректный JSON.'); }
    if (!object(value)) invalid('Некорректный JSON.'); return value;
  }
  function command(req, value) {
    const headerId = req.headers['x-pult-command-id'], headerTime = req.headers['x-pult-command-timestamp'];
    if (headerId !== undefined && value.commandId !== undefined && headerId !== value.commandId) invalid('Идентификатор команды не совпадает.');
    if (headerTime !== undefined && value.timestamp !== undefined && headerTime !== value.timestamp) invalid('Время команды не совпадает.');
    const commandId = headerId ?? value.commandId, timestamp = headerTime ?? value.timestamp;
    if (!UUID.test(commandId || '') || typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) invalid('Для изменения нужны стабильные commandId и timestamp.');
    return { commandId: commandId.toLowerCase(), timestamp };
  }
  function error(res, cause) {
    if (cause instanceof PartnerToolsError || cause instanceof PartnerError) return reply(res, cause.status || 400, { error: cause.message });
    if (cause?.code === 'REVISION_CONFLICT') return reply(res, 409, { error: 'Данные уже изменились. Обновите страницу.' });
    if (cause?.code === 'COMMAND_ID_REUSED') return reply(res, 409, { error: 'commandId уже использован для другого запроса.' });
    if (cause?.code === 'OUTCOME_UNKNOWN') return reply(res, 503, { error: 'Результат сохранения требует проверки. Повторите тот же запрос с теми же commandId и timestamp.' });
    return reply(res, 503, { error: 'SQL-хранилище временно недоступно.' });
  }
  async function handle(req, res, url) {
    if (url.pathname !== '/api/partners/state' && !ROUTES.has(url.pathname)) return false;
    try {
      if (await authorize(req, url) !== true) invalid('Доступ запрещён.', 403);
      if (url.search) invalid('Параметры запроса не поддерживаются.');
      if (req.method === 'GET' && url.pathname === '/api/partners/state') {
        const state = await workspace.ownerState(); reply(res, 200, { ...state, capabilities: { ...state.capabilities, localListenerAvailable: !!await getAvailability() } });
      } else if (req.method === 'POST' && ROUTES.has(url.pathname)) {
        const value = await body(req), op = command(req, value);
        const allowed = url.pathname.endsWith('/save') ? ['id', 'version', 'name', 'productKeys', 'active', 'commandId', 'timestamp'] : ['id', 'version', 'commandId', 'timestamp'];
        if (Object.keys(value).some(key => !allowed.includes(key))) invalid('Неподдерживаемые поля.');
        const input = Object.fromEntries(Object.entries(value).filter(([key]) => !['commandId', 'timestamp'].includes(key)));
        reply(res, 200, await workspace[ROUTES.get(url.pathname)](input, op));
      } else reply(res, 405, { error: 'Метод не поддерживается.' });
    } catch (cause) { error(res, cause); }
    return true;
  }
  return Object.freeze({ handle });
};
module.exports.PartnerToolsError = PartnerToolsError;
