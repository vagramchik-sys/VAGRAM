'use strict';
const fs = require('node:fs'), path = require('node:path');
const PAGE_SIZE = 1000, MAX_PAGES = 20, COOLDOWN = 30 * 60000;
const metrics = ['ordered_units', 'hits_view_pdp', 'hits_tocart_pdp'];
const shift = (day, n) => new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);
function periods(now) {
  const day = new Date(now + 3 * 3600000).toISOString().slice(0, 10);
  return { day, current: { from: shift(day, -7), to: shift(day, -1) }, previous: { from: shift(day, -14), to: shift(day, -8) } };
}
function create({ privateDir, now = Date.now }) {
  function file(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id))) throw Error('Некорректный магазин');
    return path.join(privateDir, 'ozon-funnel-' + id + '.json');
  }
  function state(id) { return fs.existsSync(file(id)) ? JSON.parse(fs.readFileSync(file(id), 'utf8')) : { version: 1, snapshot: null, status: 'pending' }; }
  function save(id, value) {
    fs.mkdirSync(privateDir, { recursive: true });
    fs.writeFileSync(file(id) + '.tmp', JSON.stringify(value));
    // Windows antivirus may briefly hold a read handle. The bounded wait totals
    // at most 375 ms; never remove the previous complete file to work around it.
    for (let attempt = 0; ; attempt++) try { fs.renameSync(file(id) + '.tmp', file(id)); break; } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * 2 ** attempt);
    }
  }
  function due(id) {
    const value = state(id), today = periods(now()).day;
    if (now() < (Date.parse(value.retryAt) || 0)) return false;
    return !!value.pending || !value.snapshot || value.snapshot.day !== today || now() - Date.parse(value.snapshot.updatedAt) >= COOLDOWN;
  }
  function request(id) {
    if (!due(id)) return null;
    const value = state(id), period = periods(now());
    if (!value.pending || value.pending.day !== period.day) value.pending = { ...period, window: 'previous', offset: 0, previousRows: [], currentRows: [] };
    value.status = 'pending'; value.lastAttemptAt = new Date(now()).toISOString();
    delete value.error; save(id, value);
    const cursor = value.pending, range = cursor[cursor.window];
    return { date_from: range.from, date_to: range.to, metrics: [...metrics], dimension: ['sku'], filters: [], sort: [{ key: 'ordered_units', order: 'DESC' }], limit: PAGE_SIZE, offset: cursor.offset };
  }
  function accept(id, response) {
    const value = state(id), cursor = value.pending;
    if (!cursor) throw Error('Нет ожидающего запроса воронки');
    // A response crossing Moscow midnight belongs to the old windows. Discard
    // the partial import rather than relabel it as the next day's comparison.
    if (cursor.day !== periods(now()).day) { delete value.pending; value.status = value.snapshot ? 'ready' : 'pending'; save(id, value); return; }
    const rows = response?.result?.data;
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw Error('Некорректная структура воронки Ozon');
    const key = cursor.window + 'Rows', seen = new Set(cursor[key].map(row => row.sku)), parsed = [];
    for (const row of rows) {
      const rawSku = row.dimensions?.[0]?.id;
      const sku = typeof rawSku === 'string' ? rawSku : Number.isSafeInteger(rawSku) ? String(rawSku) : '';
      if (!/^[1-9]\d*$/.test(sku) || row.dimensions.length !== 1 || seen.has(sku) || !Array.isArray(row.metrics) || row.metrics.length !== 3 || !row.metrics.every(v => Number.isSafeInteger(v) && v >= 0)) throw Error('Некорректные количества или повторные SKU воронки Ozon');
      seen.add(sku); parsed.push({ sku, orderedUnits: row.metrics[0], views: row.metrics[1], cartAdds: row.metrics[2] });
    }
    cursor[key].push(...parsed);
    if (rows.length === PAGE_SIZE) {
      cursor.offset += PAGE_SIZE;
      if (cursor.offset >= PAGE_SIZE * MAX_PAGES) throw Error('Воронка Ozon загружена не полностью');
    } else if (cursor.window === 'previous') { cursor.window = 'current'; cursor.offset = 0; }
    else {
      value.snapshot = { version: 1, complete: true, day: cursor.day, current: cursor.current, previous: cursor.previous, currentRows: cursor.currentRows, previousRows: cursor.previousRows, updatedAt: new Date(now()).toISOString(), source: '/v1/analytics/data', metrics: [...metrics] };
      value.status = 'ready'; delete value.pending; delete value.retryAt; delete value.error;
    }
    save(id, value);
  }
  function fail(id, reason = {}) {
    const value = state(id), unavailable = reason.status === 400 || reason.status === 403;
    const wait = reason.status === 403 ? 6 * 3600000 : COOLDOWN;
    // Persist only fixed messages; upstream bodies, credentials and exception
    // strings must never be written into this auxiliary snapshot.
    value.status = unavailable ? 'unavailable' : 'error';
    value.error = unavailable ? 'Метрики воронки недоступны для этого кабинета или запроса.' : reason.status === 429 ? 'Ozon ограничил частоту аналитики. Повтор после паузы.' : 'Не удалось получить полную воронку Ozon.';
    value.lastAttemptAt = new Date(now()).toISOString();
    value.retryAt = new Date(Math.max(now() + wait, now() + (Number(reason.retryAfterMs) || 0), Date.parse(reason.retryAt) || 0)).toISOString();
    delete value.pending; save(id, value);
  }
  function read(id) {
    const value = state(id);
    return { snapshot: value.snapshot || null, status: value.status, retryAt: value.retryAt || null, lastAttemptAt: value.lastAttemptAt || null, error: value.error || null };
  }
  return { due, request, accept, fail, read };
}
module.exports = { create, periods, metrics, PAGE_SIZE, MAX_PAGES };
