'use strict';

const {OzonAdControlError} = require('../ozon-ad-control.cjs');
const reply = (res, status, value) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value)); };
async function body(req) {
  let bytes = 0; const parts = [];
  for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 16384) throw new OzonAdControlError('BODY_TOO_LARGE', 'Запрос слишком большой.', 413); parts.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(parts).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
  catch { throw new OzonAdControlError('INVALID_ARGUMENT', 'Некорректный JSON.'); }
}
function createOzonAdControlRoutes({control, authorize} = {}) {
  if (!control?.overview || !control?.campaigns || !control?.campaign || !control?.preview || !control?.apply || !control?.reconcile || typeof authorize !== 'function') throw new TypeError('Ozon ad control routes dependencies are required');
  async function handle(req, res, url) {
    if (url.pathname !== '/api/ad-control' && !url.pathname.startsWith('/api/ad-control/')) return false;
    try {
      if (await authorize(req, url) !== true) throw new OzonAdControlError('FORBIDDEN', 'Доступ запрещён.', 403);
      const path = url.pathname, ids = {storeId: url.searchParams.get('store'), campaignId: url.searchParams.get('campaign')};
      if (req.method === 'GET' && path === '/api/ad-control') reply(res, 200, await control.overview());
      else if (req.method === 'GET' && path === '/api/ad-control/campaigns') reply(res, 200, await control.campaigns({storeId: ids.storeId}));
      else if (req.method === 'GET' && path === '/api/ad-control/campaign') reply(res, 200, await control.campaign(ids));
      else if (req.method === 'POST' && ['/api/ad-control/preview', '/api/ad-control/apply', '/api/ad-control/reconcile'].includes(path)) {
        const value = await body(req), method = path.slice(path.lastIndexOf('/') + 1);
        if (method === 'apply' && req.headers?.['x-pult-command-id'] && req.headers['x-pult-command-id'] !== value.commandId) throw new OzonAdControlError('INVALID_ARGUMENT', 'Идентификаторы команды не совпадают.');
        reply(res, 200, await control[method](value));
      } else reply(res, 405, {error: 'Метод не поддерживается.', code: 'METHOD_NOT_ALLOWED'});
    } catch (error) {
      if (error instanceof OzonAdControlError) reply(res, error.status, {error: error.message, code: error.code});
      else if (error?.code === 'REVISION_CONFLICT') reply(res, 409, {error: 'Настройки уже изменились. Обновите экран.', code: 'REVISION_CONFLICT'});
      else if (error?.code === 'OUTCOME_UNKNOWN') reply(res, 503, {error: 'Результат сохранения неизвестен. Сверьте состояние перед дальнейшими изменениями.', code: 'OUTCOME_UNKNOWN'});
      else reply(res, 503, {error: 'Управление рекламой временно недоступно.', code: 'AD_CONTROL_UNAVAILABLE'});
    }
    return true;
  }
  return Object.freeze({handle});
}
module.exports = {createOzonAdControlRoutes};
