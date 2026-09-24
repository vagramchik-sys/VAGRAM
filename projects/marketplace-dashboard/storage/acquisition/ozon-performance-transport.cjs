'use strict';

const crypto = require('node:crypto');

const HOST = 'https://api-performance.ozon.ru';
const MAX_COMPETITIVE_SKUS = 200;
const MAX_STAT_CAMPAIGNS = 10;
const PAGE_SIZE = 100;
const TOKEN_SKEW_MS = 60000;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

class OzonPerformanceError extends Error {
  constructor(code, message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = 'OzonPerformanceError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const textId = (value, name) => {
  const result = String(value ?? '');
  if (!/^[0-9]+$/u.test(result)) throw new OzonPerformanceError('INVALID_ARGUMENT', `${name} is invalid`);
  return result;
};
const credentials = value => {
  if (!object(value) || !/^[0-9]+$/u.test(String(value.storeId || '')) || typeof value.clientId !== 'string' || value.clientId.length < 3 || value.clientId.length > 512 || typeof value.clientSecret !== 'string' || value.clientSecret.length < 8 || value.clientSecret.length > 8192)
    throw new OzonPerformanceError('MISSING_CREDENTIALS', 'Ozon Performance credentials are missing');
  return { storeId: String(value.storeId), clientId: value.clientId, clientSecret: value.clientSecret };
};
const chunks = (values, size) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
function retryAfter(response, now) {
  const raw = response.headers?.get?.('Retry-After');
  if (raw === undefined || raw === null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(365 * 86400000, Math.ceil(seconds * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now()) : null;
}
async function json(response, maxBytes = 4 * 1024 * 1024) {
  try {
    if (Number(response.headers?.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new Error('response too large');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('response body missing');
    const parts = []; let size = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error('response too large'); }
        parts.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(parts, size).toString('utf8'));
  }
  catch { throw new OzonPerformanceError('MALFORMED_RESPONSE', 'Ozon Performance returned malformed JSON', { status: response.status }); }
}

function createOzonPerformanceTransport({ fetchFn = globalThis.fetch, sleep = sleepDefault, now = Date.now, host = HOST, maxAttempts = 3, timeoutMs = 120000, maxTokenEntries = 64 } = {}) {
  if (typeof fetchFn !== 'function' || typeof sleep !== 'function' || typeof now !== 'function' || !/^https:\/\//u.test(host) || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || !Number.isSafeInteger(maxTokenEntries) || maxTokenEntries < 1 || maxTokenEntries > 1024)
    throw new TypeError('Valid Ozon Performance transport options are required');
  const tokens = new Map();
  const cache = (key, value) => { tokens.delete(key); tokens.set(key, value); while (tokens.size > maxTokenEntries) tokens.delete(tokens.keys().next().value); };
  const fingerprint = value => crypto.createHash('sha256').update(`${value.clientId}\0${value.clientSecret}`).digest('hex');
  const invalidate = storeId => tokens.delete(String(storeId));

  async function acquireToken(input, force = false) {
    const value = credentials(input), key = value.storeId, mark = fingerprint(value), current = tokens.get(key);
    if (!force && current?.fingerprint === mark && current.token && current.expiresAt - TOKEN_SKEW_MS > now()) return current.token;
    if (!force && current?.fingerprint === mark && current.promise) return current.promise;
    const promise = (async () => {
      let response;
      try {
        response = await fetchFn(`${host}/api/client/token`, { method: 'POST', redirect: 'error', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: value.clientId, client_secret: value.clientSecret, grant_type: 'client_credentials' }), signal: AbortSignal.timeout(timeoutMs) });
      } catch { throw new OzonPerformanceError('NETWORK_ERROR', 'Ozon Performance authentication is temporarily unavailable'); }
      if (!response.ok) throw new OzonPerformanceError(response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', 'Ozon Performance authentication failed', { status: response.status, retryAfterMs: retryAfter(response, now) ?? undefined });
      const body = await json(response, 64 * 1024), expires = Number(body?.expires_in);
      if (!object(body) || typeof body.access_token !== 'string' || body.access_token.length < 16 || !Number.isFinite(expires) || expires <= 0) throw new OzonPerformanceError('MALFORMED_RESPONSE', 'Ozon Performance returned an invalid token response');
      const result = { fingerprint: mark, token: body.access_token, expiresAt: now() + expires * 1000 };
      if (tokens.get(key)?.promise === promise) cache(key, result);
      return result.token;
    })();
    cache(key, { fingerprint: mark, promise });
    try { return await promise; }
    catch (error) { if (tokens.get(key)?.promise === promise) tokens.delete(key); throw error; }
  }

  async function request(input, path, { method = 'GET', query, body } = {}) {
    const value = credentials(input);
    const allowed = method === 'GET' && (path === '/api/client/campaign' || /^\/api\/client\/campaign\/[0-9]+\/(?:v2\/products|products\/bids\/competitive)$/u.test(path)) || method === 'POST' && (path === '/api/client/min/sku' || path === '/api/client/statistics/products/sku');
    if (!allowed) throw new OzonPerformanceError('READ_ONLY_VIOLATION', 'Ozon Performance operation is not allowed');
    let authRetried = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const token = await acquireToken(value);
      const url = new URL(path, host);
      if (query) for (const [name, item] of Object.entries(query)) for (const element of Array.isArray(item) ? item : [item]) if (element !== undefined && element !== null) url.searchParams.append(name, String(element));
      let response;
      try {
        response = await fetchFn(url, { method, redirect: 'error', headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        if (attempt + 1 < maxAttempts) { await sleep(Math.min(1000 * 2 ** attempt, 5000)); continue; }
        throw new OzonPerformanceError('NETWORK_ERROR', 'Ozon Performance is temporarily unavailable');
      }
      if (response.status === 401 && !authRetried) { if (tokens.get(value.storeId)?.token === token) invalidate(value.storeId); authRetried = true; attempt--; continue; }
      if (response.status === 401 || response.status === 403) throw new OzonPerformanceError(response.status === 401 ? 'AUTH_FAILED' : 'AUTH_FORBIDDEN', 'Ozon Performance rejected the credentials', { status: response.status });
      if (response.status === 429 || response.status >= 500) {
        const wait = retryAfter(response, now) ?? Math.min(1000 * 2 ** attempt, 30000);
        if (wait > 5000) throw new OzonPerformanceError(response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', 'Ozon Performance retry is deferred', { status: response.status, retryAfterMs: wait });
        if (attempt + 1 < maxAttempts) { await sleep(wait); continue; }
        throw new OzonPerformanceError(response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', 'Ozon Performance is temporarily unavailable', { status: response.status, retryAfterMs: wait });
      }
      if (!response.ok) throw new OzonPerformanceError('UPSTREAM_ERROR', 'Ozon Performance request failed', { status: response.status });
      const result = await json(response);
      if (!object(result)) throw new OzonPerformanceError('MALFORMED_RESPONSE', 'Ozon Performance returned an unknown response shape');
      return result;
    }
    throw new OzonPerformanceError('UPSTREAM_ERROR', 'Ozon Performance request failed');
  }

  async function paginate(input, path, field, query = {}) {
    const result = [], seen = new Set(), byId = new Map();
    for (let page = 1; page <= 10000; page++) {
      const body = await request(input, path, { query: { ...query, page, pageSize: PAGE_SIZE } }), rows = body[field];
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new OzonPerformanceError('MALFORMED_RESPONSE', `Ozon Performance ${field} list is invalid`);
      for (const row of rows) {
        const id = textId(row?.[field === 'list' ? 'id' : 'sku'], field), encoded = JSON.stringify(row);
        if (byId.has(id)) {
          if (byId.get(id) !== encoded) throw new OzonPerformanceError('PAGINATION_FAILED', 'Ozon Performance pages contain conflicting records');
        } else { byId.set(id, encoded); result.push(row); }
      }
      if (rows.length < PAGE_SIZE) return result;
      const marker = crypto.createHash('sha256').update(JSON.stringify(rows.map(row => String(row[field === 'list' ? 'id' : 'sku'])).sort())).digest('hex');
      if (seen.has(marker)) throw new OzonPerformanceError('PAGINATION_FAILED', 'Ozon Performance pagination did not advance');
      seen.add(marker);
    }
    throw new OzonPerformanceError('PAGINATION_FAILED', 'Ozon Performance pagination did not complete');
  }

  async function listCampaigns(input) { return paginate(input, '/api/client/campaign', 'list', { advObjectType: 'SKU' }); }
  async function listCampaignProducts(input, campaignId) { return paginate(input, `/api/client/campaign/${textId(campaignId, 'campaignId')}/v2/products`, 'products'); }
  async function listCompetitiveBids(input, campaignId, skus) {
    campaignId = textId(campaignId, 'campaignId');
    if (!Array.isArray(skus)) throw new OzonPerformanceError('INVALID_ARGUMENT', 'skus are required');
    const unique = [...new Set(skus.map(value => textId(value, 'sku')))];
    const result = [];
    for (const part of chunks(unique, MAX_COMPETITIVE_SKUS)) {
      const body = await request(input, `/api/client/campaign/${campaignId}/products/bids/competitive`, { query: { skus: part } });
      if (!Array.isArray(body.bids)) throw new OzonPerformanceError('MALFORMED_RESPONSE', 'Ozon Performance competitive bids are invalid');
      result.push(...body.bids);
    }
    return result;
  }
  async function listMinimumBids(input, skus, { marketplaceId = 'MARKETPLACE_ID_RU', paymentType = 'CPC' } = {}) {
    if (!Array.isArray(skus)) throw new OzonPerformanceError('INVALID_ARGUMENT', 'skus are required');
    const unique = [...new Set(skus.map(value => textId(value, 'sku')))], result = [];
    for (const part of chunks(unique, MAX_COMPETITIVE_SKUS)) {
      const body = await request(input, '/api/client/min/sku', { method: 'POST', body: { marketplaceId, paymentType, sku: part } });
      if (!Array.isArray(body.minBids)) throw new OzonPerformanceError('MALFORMED_RESPONSE', 'Ozon Performance minimum bids are invalid');
      result.push(...body.minBids);
    }
    return result;
  }
  async function getSkuStatistics(input, campaignIds, { dateFrom, dateTo } = {}) {
    if (!Array.isArray(campaignIds) || !DAY.test(dateFrom || '') || !DAY.test(dateTo || '') || dateFrom > dateTo) throw new OzonPerformanceError('INVALID_ARGUMENT', 'Statistics period or campaigns are invalid');
    const unique = [...new Set(campaignIds.map(value => textId(value, 'campaignId')))];
    const result = [];
    for (const part of chunks(unique, MAX_STAT_CAMPAIGNS)) {
      const body = await request(input, '/api/client/statistics/products/sku', { method: 'POST', body: { campaignIds: part, dateFrom, dateTo } });
      if (!Array.isArray(body.rows)) throw new OzonPerformanceError('MALFORMED_RESPONSE', 'Ozon Performance statistics are invalid');
      result.push(...body.rows);
    }
    return result;
  }
  async function testCredentials(input) {
    const body = await request(input, '/api/client/campaign', { query: { advObjectType: 'SKU', page: 1, pageSize: 1 } });
    if (!Array.isArray(body.list)) throw new OzonPerformanceError('MALFORMED_RESPONSE', 'Ozon Performance campaigns are invalid');
    return { ok: true };
  }

  return Object.freeze({ acquireToken, invalidate, request, listCampaigns, listCampaignProducts, listCompetitiveBids, listMinimumBids, getSkuStatistics, testCredentials });
}

function createPerformanceTransport({ getCredentials, ...options } = {}) {
  if (typeof getCredentials !== 'function') throw new TypeError('getCredentials is required');
  const raw = createOzonPerformanceTransport(options);
  async function input(storeId) { const value = await getCredentials(String(storeId)); if (!value) throw new OzonPerformanceError('MISSING_CREDENTIALS', 'Ozon Performance credentials are missing'); return value; }
  return Object.freeze({
    testConnection: async storeId => raw.testCredentials(await input(storeId)),
    listCampaigns: async storeId => raw.listCampaigns(await input(storeId)),
    listCampaignProducts: async (storeId, campaignId) => raw.listCampaignProducts(await input(storeId), campaignId),
    getCompetitiveBids: async (storeId, campaignId, skus) => raw.listCompetitiveBids(await input(storeId), campaignId, skus),
    getMinimumBids: async (storeId, skus, context) => raw.listMinimumBids(await input(storeId), skus, context),
    getSkuStatistics: async (storeId, { campaignIds, from, to } = {}) => raw.getSkuStatistics(await input(storeId), campaignIds, { dateFrom: from, dateTo: to }),
    invalidateCredentials: raw.invalidate
  });
}

module.exports = { createPerformanceTransport, createOzonPerformanceTransport, OzonPerformanceError, HOST, MAX_COMPETITIVE_SKUS, MAX_STAT_CAMPAIGNS, PAGE_SIZE };
