'use strict';

class OzonAcquisitionError extends Error { constructor(code, message, retryAfterMs) { super(message); this.name = 'OzonAcquisitionError'; this.code = code; if (retryAfterMs) this.retryAfterMs = retryAfterMs; } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const shift = (day, amount) => new Date(Date.parse(`${day}T00:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
const moscowDay = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
function clean(error) { return error instanceof OzonAcquisitionError ? error : new OzonAcquisitionError('SECTION_FAILED', 'Ozon section is temporarily unavailable'); }

function createOzonSnapshotCollector({ fetchFn = globalThis.fetch, api, sleep = delay, now = () => new Date() } = {}) {
  if (api !== undefined && typeof api !== 'function' || typeof fetchFn !== 'function' || typeof sleep !== 'function' || typeof now !== 'function') throw new TypeError('fetchFn, sleep and now are required');
  async function request(store, key, route, payload) {
    if (api) {
      try { return await api(store, key, route, payload); }
      catch (error) { throw new OzonAcquisitionError(error?.code || 'NETWORK_ERROR', 'Ozon section is temporarily unavailable', error?.retryAfterMs); }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let response; try { response = await fetchFn(`https://api-seller.ozon.ru${route}`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'Client-Id': store.clientId, 'Api-Key': key }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) }); }
      catch { if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; } throw new OzonAcquisitionError('NETWORK_ERROR', 'Ozon did not respond'); }
      if (response.status === 429 && route === '/v1/analytics/data') { const raw = response.headers.get('Retry-After'), seconds = Number(raw), date = Date.parse(raw), retryAfterMs = raw && Number.isFinite(seconds) ? Math.max(300000, seconds * 1000) : Number.isFinite(date) ? Math.max(300000, date - now().valueOf()) : 300000; throw new OzonAcquisitionError('RATE_LIMITED', 'Ozon rate limit requires a cooldown', retryAfterMs); }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      if (!response.ok) throw new OzonAcquisitionError(response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : 'HTTP_ERROR', `Ozon request failed (${response.status})`);
      try { return await response.json(); } catch { throw new OzonAcquisitionError('INVALID_RESPONSE', 'Ozon returned invalid JSON'); }
    }
    throw new OzonAcquisitionError('NETWORK_ERROR', 'Ozon did not respond');
  }
  async function collect({ store, key, previousSnapshot = null, onProgress } = {}) {
    if (!store || typeof store.name !== 'string' || !/^\d+$/u.test(String(store.clientId)) || typeof key !== 'string' || !key) throw new OzonAcquisitionError('INVALID_ARGUMENT', 'Ozon store credentials are invalid');
    const startedAt = now().toISOString(), today = moscowDay(now()), data = { store: store.name, clientId: String(store.clientId), startedAt, products: [], stocks: [], operations: [], sections: {}, period: { from: shift(today, -29), to: today } }, errors = [];
    const progress = (stage, count = 0) => onProgress?.(Object.freeze({ stage, count }));
    const section = async (name, run, prefix = '') => { try { await run(); } catch (error) { const safe = clean(error); data.sections[name] = { ok: false, error: safe.message }; errors.push(prefix + safe.message); } };
    await section('products', async () => { let last = ''; const seen = new Set(); for (let page = 0; page < 500; page++) { const response = await request(store, key, '/v3/product/list', { filter: { visibility: 'ALL' }, last_id: last, limit: 1000 }), value = response.result || response; if (!Array.isArray(value.items)) throw new OzonAcquisitionError('INVALID_RESPONSE', 'Ozon product list has an unknown shape'); data.products.push(...value.items); progress('products', data.products.length); if (!value.items.length || data.products.length >= value.total || !value.last_id) break; if (seen.has(value.last_id) || page === 499) throw new OzonAcquisitionError('PAGINATION_FAILED', 'Ozon product pagination did not complete'); seen.add(value.last_id); last = value.last_id; await sleep(1100); }
      const ids = data.products.map(row => String(row.product_id)); for (let index = 0; index < ids.length; index += 100) { const response = await request(store, key, '/v3/product/info/list', { product_id: ids.slice(index, index + 100) }); if (!Array.isArray(response.items)) throw new OzonAcquisitionError('INVALID_RESPONSE', 'Ozon product details have an unknown shape'); const byId = new Map(response.items.map(row => [String(row.id), row])); data.products = data.products.map(row => byId.has(String(row.product_id)) ? { ...row, ...byId.get(String(row.product_id)) } : row); await sleep(1100); } data.sections.products = { ok: true, count: data.products.length }; });
    await section('categories', async () => { const response = await request(store, key, '/v1/description-category/tree', { language: 'RU' }); if (!Array.isArray(response.result)) throw new OzonAcquisitionError('INVALID_RESPONSE', 'Ozon category tree has an unknown shape'); data.categoryTree = response.result; data.sections.categories = { ok: true, count: data.categoryTree.length }; }, 'Categories: ');
    if (!data.sections.categories.ok) data.categoryTree = Array.isArray(previousSnapshot?.categoryTree) ? structuredClone(previousSnapshot.categoryTree) : [];
    await section('stocks', async () => { let cursor = ''; const seen = new Set(); for (let page = 0; page < 500; page++) { const response = await request(store, key, '/v4/product/info/stocks', { filter: { visibility: 'ALL' }, cursor, limit: 1000 }), value = response.result || response; if (!Array.isArray(value.items)) throw new OzonAcquisitionError('INVALID_RESPONSE', 'Ozon stocks have an unknown shape'); data.stocks.push(...value.items); progress('stocks', data.stocks.length); if (!value.items.length || !value.cursor) break; if (seen.has(value.cursor) || page === 499) throw new OzonAcquisitionError('PAGINATION_FAILED', 'Ozon stock pagination did not complete'); seen.add(value.cursor); cursor = value.cursor; await sleep(1100); } data.sections.stocks = { ok: true, count: data.stocks.length }; });
    await section('finance', async () => { const end = Date.parse(`${data.period.to}T00:00:00Z`); for (let time = Date.parse(`${data.period.from}T00:00:00Z`); time <= end; time += 86400000) { const date = new Date(time).toISOString().slice(0, 10); let last = ''; const seen = new Set(); for (let page = 0; page < 1000; page++) { const value = await request(store, key, '/v1/finance/accrual/by-day', { date, last_id: last }); if (!Array.isArray(value.accruals)) throw new OzonAcquisitionError('INVALID_RESPONSE', 'Ozon finance has an unknown shape'); data.operations.push(...value.accruals.map(row => ({ ...row, operation_id: row.accrual_id, amount: Number(row.total_amount?.amount || 0), operation_type: row.accrued_category, operation_type_name: row.accrued_category }))); progress('finance', data.operations.length); if (!value.accruals.length || !value.last_id) break; if (seen.has(value.last_id) || page === 999) throw new OzonAcquisitionError('PAGINATION_FAILED', 'Ozon finance pagination did not complete'); seen.add(value.last_id); last = value.last_id; await sleep(1100); } await sleep(1100); } data.sections.finance = { ok: true, count: data.operations.length, source: '/v1/finance/accrual/by-day' }; });
    data.completedAt = now().toISOString(); return { snapshot: data, status: errors.length ? 'partial' : 'done', errors };
  }
  return Object.freeze({ collect, usesDatabaseCredentials: api?.usesDatabaseCredentials === true });
}
module.exports = { createOzonSnapshotCollector, OzonAcquisitionError };
