'use strict';

// This transport is deliberately separate from the read-only Seller adapter.
// It performs one price write at most and never retries an uncertain outcome.
const HOST = 'https://api-seller.ozon.ru';
const READ_PATH = '/v5/product/info/prices';
const WRITE_PATH = '/v1/product/import/prices';

class OzonPriceWriteError extends Error {
  constructor(code, message) { super(message); this.name = 'OzonPriceWriteError'; this.code = code; }
}
const fail = (code, message) => { throw new OzonPriceWriteError(code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function money(value) {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?$/u.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  return cents > 0n ? `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}` : null;
}
function createOzonPriceWriteTransport({fetchFn = globalThis.fetch, timeoutMs = 30000, host = HOST} = {}) {
  if (typeof fetchFn !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000 || host !== HOST) throw new TypeError('Valid Ozon price transport options are required');
  async function request(auth, path, payload) {
    if (!object(auth) || !/^[0-9]+$/u.test(String(auth.clientId ?? '')) || typeof auth.apiKey !== 'string' || !auth.apiKey || ![READ_PATH, WRITE_PATH].includes(path)) fail('INVALID_ARGUMENT', 'Ozon price request is invalid');
    let response;
    try {
      response = await fetchFn(`${host}${path}`, {method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/json', 'Client-Id': String(auth.clientId), 'Api-Key': auth.apiKey}, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs)});
    } catch { fail('OUTCOME_UNKNOWN', 'Ozon price request outcome is unknown'); }
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', 'Ozon price request failed');
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > 262144) fail('INVALID_RESPONSE', 'Ozon price response is too large');
    let text;
    try { text = await response.text(); } catch { fail('OUTCOME_UNKNOWN', 'Ozon price response could not be read'); }
    if (Buffer.byteLength(text) > 262144) fail('INVALID_RESPONSE', 'Ozon price response is too large');
    try { const value = JSON.parse(text); if (object(value)) return value; } catch {}
    fail('INVALID_RESPONSE', 'Ozon price response is invalid');
  }
  async function read(auth, offerId) {
    if (typeof offerId !== 'string' || !offerId || offerId.length > 200) fail('INVALID_ARGUMENT', 'Offer identifier is invalid');
    const payload = {cursor: '', filter: {offer_id: [offerId], visibility: 'ALL'}, limit: 100};
    const value = await request(auth, READ_PATH, payload);
    if (!Array.isArray(value.items) || value.items.length !== 1 || String(value.items[0]?.offer_id ?? '') !== offerId || Number(value.total) !== 1) fail('INVALID_RESPONSE', 'Ozon returned an ambiguous price');
    const item = value.items[0], price = money(item?.price?.price), currency = item?.price?.currency_code;
    if (!price || currency !== 'RUB') fail('INVALID_RESPONSE', 'Ozon returned an unsupported price');
    return {offerId, price, currency};
  }
  async function writeOnce(auth, {offerId, expectedPrice, desiredPrice} = {}) {
    if (typeof offerId !== 'string' || !offerId || offerId.length > 200 || !money(expectedPrice) || !money(desiredPrice) || money(expectedPrice) === money(desiredPrice)) fail('INVALID_ARGUMENT', 'Price change is invalid');
    const before = await read(auth, offerId);
    if (before.price === money(desiredPrice)) return {status: 'VERIFIED', applied: false, offerId, price: before.price};
    if (before.price !== money(expectedPrice)) return {status: 'HOLD', reason: 'PRICE_CHANGED', offerId, price: before.price};
    let response;
    try { response = await request(auth, WRITE_PATH, {prices: [{offer_id: offerId, price: money(desiredPrice), currency_code: 'RUB'}]}); }
    catch (error) {
      // A timeout, 5xx, or unreadable response may have applied the write.
      // Read back once, then leave uncertainty for the durable action record.
      // A caller must never blindly retry this non-idempotent command.
      try {
        const after = await read(auth, offerId);
        if (after.price === money(desiredPrice)) return {status: 'VERIFIED', applied: true, offerId, price: after.price};
      } catch {}
      return {status: 'UNKNOWN', reason: error?.code || 'OUTCOME_UNKNOWN', offerId};
    }
    const row = Array.isArray(response.result) && response.result.length === 1 ? response.result[0] : null;
    if (!row || String(row.offer_id ?? '') !== offerId || row.updated !== true || !Array.isArray(row.errors) || row.errors.length) return {status: 'UNKNOWN', reason: 'WRITE_UNCONFIRMED', offerId};
    try {
      const after = await read(auth, offerId);
      return after.price === money(desiredPrice) ? {status: 'VERIFIED', applied: true, offerId, price: after.price} : {status: 'UNKNOWN', reason: 'READBACK_PENDING', offerId};
    } catch { return {status: 'UNKNOWN', reason: 'READBACK_UNAVAILABLE', offerId}; }
  }
  return Object.freeze({read, writeOnce});
}
module.exports = {createOzonPriceWriteTransport, OzonPriceWriteError, money, HOST, READ_PATH, WRITE_PATH};
