'use strict';

const { ManagementError } = require('./postgres-management.cjs');
const { FinanceRegisterError } = require('./postgres-finance-register.cjs');
const { SupplierPortalError } = require('./postgres-supplier-portals.cjs');
const { StockRepositoryError } = require('../postgres-stock-repository.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const HISTORY_METRICS = new Set(['units', 'revenue', 'soldUnits', 'returnedUnits', 'realized', 'ads']);
const WORKSPACE_ROUTES = new Set(['/api/ideas', '/api/ideas/create', '/api/ideas/update', '/api/procurement', '/api/procurement/parse', '/api/procurement/request', '/api/procurement/import', '/api/procurement/compare']);
const ROUTES = new Set(['/api/manage', '/api/manage/preview', '/api/manage/drafts', '/api/manage/transition', '/api/manage/note', '/api/finance', '/api/finance/loans', '/api/finance/payments', '/api/suppliers', '/api/suppliers/preview', '/api/suppliers/category', '/api/suppliers/portal', '/api/market-history/status', '/api/market-history/report', '/api/stock-history/status', '/api/stock-history/report', '/api/stock-history/export']);

class OwnerRoutesError extends Error { constructor(message, status = 400) { super(message); this.name = 'OwnerRoutesError'; this.status = status; this.public = true; } }
const invalid = (message, status) => { throw new OwnerRoutesError(message, status); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validDay = value => DAY.test(value || '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function createPostgresOwnerRoutes({ authorize, management, financeRegister, supplierPortals, history, stockHistory, workspaceTools = null, pricingStatus = async () => ({}) } = {}) {
  if (typeof authorize !== 'function') throw new TypeError('authorize is required');
  for (const [name, value, methods] of [['management', management, ['products', 'state', 'preview', 'create', 'transition', 'note']], ['financeRegister', financeRegister, ['report', 'saveLoan', 'savePayment']], ['supplierPortals', supplierPortals, ['read', 'preview', 'saveCategory', 'savePortal']], ['history', history, ['status', 'report']], ['stockHistory', stockHistory, ['status', 'report', 'csv']]])
    if (!value || methods.some(method => typeof value[method] !== 'function')) throw new TypeError(`${name} adapter is required`);
  if (workspaceTools !== null && typeof workspaceTools?.handle !== 'function') throw new TypeError('workspaceTools must provide handle');
  if (typeof pricingStatus !== 'function') throw new TypeError('pricingStatus must be a function');

  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function body(req) {
    const chunks = []; let bytes = 0;
    for await (const part of req) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length;
      if (bytes > 1500000) invalid('Слишком большой запрос', 413);
      chunks.push(chunk);
    }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { invalid('Некорректный формат запроса'); }
    if (!object(value)) invalid('Некорректный формат запроса');
    return value;
  }
  function command(req, value) {
    const headerId = req.headers?.['x-pult-command-id'], headerTime = req.headers?.['x-pult-command-timestamp'];
    if (headerId !== undefined && value.commandId !== undefined && headerId !== value.commandId) invalid('Идентификатор команды не совпадает');
    if (headerTime !== undefined && value.timestamp !== undefined && headerTime !== value.timestamp) invalid('Время команды не совпадает');
    const commandId = headerId ?? value.commandId, timestamp = headerTime ?? value.timestamp;
    if (typeof commandId !== 'string' || !UUID.test(commandId) || typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) invalid('Для изменения нужны стабильные commandId и timestamp');
    return { commandId: commandId.toLowerCase(), timestamp };
  }
  function historyOptions(params) {
    const from = params.get('from'), to = params.get('to'), market = params.get('market') || 'all', storeId = params.get('store') || undefined, productId = params.get('product') || undefined, metric = params.get('metric') || 'revenue';
    if (!validDay(from) || !validDay(to) || from > to) invalid('Проверьте период истории.');
    if (!['all', 'Ozon', 'WB'].includes(market)) invalid('Проверьте площадку.');
    if (storeId && storeId.length > 200) invalid('Проверьте магазин.');
    if (productId && productId.length > 200) invalid('Проверьте товар.');
    if (!HISTORY_METRICS.has(metric)) invalid('Проверьте показатель истории.');
    return { from, to, market, storeId, productId, metric };
  }
  function replyError(res, error) {
    if (error?.public === true && [OwnerRoutesError, ManagementError, FinanceRegisterError, SupplierPortalError, StockRepositoryError].some(Type => error instanceof Type)) return json(res, error.status || 400, { error: error.message });
    if (['REVISION_CONFLICT', 'COMMAND_ID_REUSED'].includes(error?.code)) return json(res, 409, { error: error.code === 'REVISION_CONFLICT' ? 'Данные уже изменились. Обновите страницу и повторите действие с новой командой.' : 'commandId уже использован для другого запроса. Повторите исходный запрос без изменений.' });
    if (['OUTCOME_UNKNOWN', 'SERIALIZATION_RETRY'].includes(error?.code)) return json(res, 503, { error: 'Результат сохранения требует проверки. Повторите тот же запрос с теми же commandId и timestamp; не создавайте новую команду.' });
    return json(res, 503, { error: 'SQL-хранилище временно недоступно. Повторите запрос позже.' });
  }
  async function handle(req, res, url) {
    const workspace = workspaceTools && WORKSPACE_ROUTES.has(url.pathname);
    if (!ROUTES.has(url.pathname) && !workspace) return false;
    try {
      if (await authorize(req, url) !== true) invalid('Доступ запрещён', 403);
      if (workspace) return await workspaceTools.handle(req, res, url);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/api/manage') {
        const [products, state, priceJobs] = await Promise.all([management.products(), management.state(), pricingStatus()]);
        json(res, 200, { products, ...state, priceJobs });
      } else if (req.method === 'GET' && path === '/api/finance') json(res, 200, await financeRegister.report({ from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
      else if (req.method === 'GET' && path === '/api/suppliers') json(res, 200, await supplierPortals.read());
      else if (req.method === 'GET' && path === '/api/suppliers/preview') json(res, 200, await supplierPortals.preview(url.searchParams.get('id')));
      else if (req.method === 'GET' && path === '/api/market-history/status') {
        const status = await history.status();
        if (!object(status?.archive) || !object(status?.facts)) throw Error('Invalid history status contract');
        json(res, 200, status);
      }
      else if (req.method === 'GET' && path === '/api/market-history/report') json(res, 200, await history.report(historyOptions(url.searchParams)));
      else if (req.method === 'GET' && path === '/api/stock-history/status') json(res, 200, await stockHistory.status());
      else if (req.method === 'GET' && path === '/api/stock-history/report') json(res, 200, await stockHistory.report(Object.fromEntries(url.searchParams)));
      else if (req.method === 'GET' && path === '/api/stock-history/export') {
        const content = await stockHistory.csv(Object.fromEntries(url.searchParams));
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="pult-stock-history.csv"', 'Cache-Control': 'no-store' }); res.end(content);
      } else if (req.method === 'POST') {
        const value = await body(req);
        if (path === '/api/manage/preview') json(res, 200, await management.preview(value));
        else if (path === '/api/manage/drafts') json(res, 200, await management.create(value, command(req, value)));
        else if (path === '/api/manage/transition') json(res, 200, await management.transition(value, command(req, value)));
        else if (path === '/api/manage/note') json(res, 200, await management.note(value, command(req, value)));
        else if (path === '/api/finance/loans') json(res, 200, { ok: true, item: await financeRegister.saveLoan(value, command(req, value)) });
        else if (path === '/api/finance/payments') json(res, 200, { ok: true, item: await financeRegister.savePayment(value, command(req, value)) });
        else if (path === '/api/suppliers/category') json(res, 200, await supplierPortals.saveCategory(value, command(req, value)));
        else if (path === '/api/suppliers/portal') json(res, 200, await supplierPortals.savePortal(value, command(req, value)));
        else json(res, 405, { error: 'Метод не поддерживается' });
      } else json(res, 405, { error: 'Метод не поддерживается' });
    } catch (error) { replyError(res, error); }
    return true;
  }
  return Object.freeze({ handle });
}

module.exports = createPostgresOwnerRoutes;
module.exports.createPostgresOwnerRoutes = createPostgresOwnerRoutes;
module.exports.OwnerRoutesError = OwnerRoutesError;
