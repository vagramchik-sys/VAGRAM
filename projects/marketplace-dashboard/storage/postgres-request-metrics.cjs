'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const PATCHED_POOL = Symbol('pult.metrics.pool');
const PATCHED_CLIENT = Symbol('pult.metrics.client');

function createRequestMetrics({ maxSeries = 96, maxRecent = 200, maxSamplesPerSeries = 128, now = () => process.hrtime.bigint() } = {}) {
  if (!Number.isSafeInteger(maxSeries) || maxSeries < 1 || maxSeries > 1024 || !Number.isSafeInteger(maxRecent) || maxRecent < 0 || maxRecent > 1000 || !Number.isSafeInteger(maxSamplesPerSeries) || maxSamplesPerSeries < 1 || maxSamplesPerSeries > 1000 || typeof now !== 'function') throw new TypeError('Invalid request metrics options');
  const storage = new AsyncLocalStorage(), series = new Map(), samples = new Map(), recent = [], pools = [];
  const elapsed = started => Number(now() - started) / 1e6;
  const current = () => storage.getStore();
  const add = (field, value) => { const state = current(); if (state && Number.isFinite(value) && value >= 0) state[field] += value; };
  const route = raw => {
    let pathname = '/invalid';
    try { pathname = new URL(String(raw || '/'), 'http://127.0.0.1').pathname; } catch {}
    pathname = pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ':id').replace(/\/[0-9]{3,}(?=\/|$)/gu, '/:id');
    if (pathname.startsWith('/api/partners/')) pathname = '/api/partners/*';
    return pathname.length <= 160 ? pathname : pathname.slice(0, 159) + '*';
  };
  const metric = (method, pathname, status) => {
    let key = `${method} ${pathname} ${status}`;
    if (!series.has(key) && series.size >= Math.max(0, maxSeries - 1)) key = 'OTHER';
    let value = series.get(key);
    if (!value) {
      value = { method: key === 'OTHER' ? 'OTHER' : method, route: key === 'OTHER' ? 'OTHER' : pathname, status: key === 'OTHER' ? 0 : status, count: 0, wallMs: 0, sqlCount: 0, sqlMs: 0, poolWaitMs: 0, externalCount: 0, externalMs: 0, responseBytes: 0, maxWallMs: 0 };
      series.set(key, value);
      samples.set(value, { wall: [], sql: [] });
    }
    return value;
  };
  function run(req, res, work) {
    const state = { started: now(), method: String(req.method || 'UNKNOWN').slice(0, 12), route: route(req.url), sqlCount: 0, sqlMs: 0, poolWaitMs: 0, externalCount: 0, externalMs: 0, responseBytes: 0, finished: false };
    const originalWrite = res.write, originalEnd = res.end;
    const bytes = (chunk, encoding) => chunk == null || typeof chunk === 'function' ? 0 : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : undefined);
    res.write = function (chunk, encoding, callback) { state.responseBytes += bytes(chunk, encoding); return originalWrite.call(this, chunk, encoding, callback); };
    res.end = function (chunk, encoding, callback) { state.responseBytes += bytes(chunk, encoding); return originalEnd.call(this, chunk, encoding, callback); };
    const finish = () => {
      if (state.finished) return;
      state.finished = true;
      if (state.route === '/api/runtime-metrics') return;
      const wallMs = elapsed(state.started), item = metric(state.method, state.route, Number(res.statusCode) || 0);
      item.count++; item.wallMs += wallMs; item.sqlCount += state.sqlCount; item.sqlMs += state.sqlMs; item.poolWaitMs += state.poolWaitMs; item.externalCount += state.externalCount; item.externalMs += state.externalMs; item.responseBytes += state.responseBytes; item.maxWallMs = Math.max(item.maxWallMs, wallMs);
      const sample = samples.get(item); sample.wall.push(wallMs); sample.sql.push(state.sqlMs);
      if (sample.wall.length > maxSamplesPerSeries) { sample.wall.shift(); sample.sql.shift(); }
      if (maxRecent) {
        recent.push({ at: new Date().toISOString(), method: state.method, route: state.route, status: Number(res.statusCode) || 0, wallMs: Number(wallMs.toFixed(3)), sqlCount: state.sqlCount, sqlMs: Number(state.sqlMs.toFixed(3)), poolWaitMs: Number(state.poolWaitMs.toFixed(3)), externalCount: state.externalCount, externalMs: Number(state.externalMs.toFixed(3)), responseBytes: state.responseBytes });
        if (recent.length > maxRecent) recent.shift();
      }
    };
    res.once('finish', finish); res.once('close', finish);
    return storage.run(state, work);
  }
  function wrapClient(client) {
    if (!client?.query || client[PATCHED_CLIENT]) return client;
    const query = client.query;
    Object.defineProperty(client, PATCHED_CLIENT, { value: true });
    client.query = function (...args) {
      const state = current(); if (!state) return query.apply(this, args);
      const started = now(); state.sqlCount++;
      let completed = false; const complete = () => { if (completed) return; completed = true; state.sqlMs += elapsed(started); };
      const callbackIndex = typeof args.at(-1) === 'function' ? args.length - 1 : -1;
      if (callbackIndex >= 0) { const callback = args[callbackIndex]; args[callbackIndex] = function (...values) { complete(); return callback.apply(this, values); }; return query.apply(this, args); }
      let result; try { result = query.apply(this, args); } catch (error) { complete(); throw error; }
      if (result?.then) return result.then(value => { complete(); return value; }, error => { complete(); throw error; });
      result?.once?.('end', complete); result?.once?.('error', complete); return result;
    };
    return client;
  }
  function instrumentPool(pool) {
    if (!pool?.connect || pool[PATCHED_POOL]) return pool;
    const connect = pool.connect;
    Object.defineProperty(pool, PATCHED_POOL, { value: true });
    pools.push(pool);
    pool.connect = function (...args) {
      const state = current(), started = state && now();
      const waited = () => { if (state) state.poolWaitMs += elapsed(started); };
      const complete = client => { waited(); return wrapClient(client); };
      const callbackIndex = typeof args.at(-1) === 'function' ? args.length - 1 : -1;
      if (callbackIndex >= 0) { const callback = args[callbackIndex]; args[callbackIndex] = function (error, client, release) { if (error) waited(); return callback.call(this, error, error ? client : complete(client), release); }; return connect.apply(this, args); }
      let result; try { result = connect.apply(this, args); } catch (error) { waited(); throw error; }
      return Promise.resolve(result).then(complete, error => { waited(); throw error; });
    };
    return pool;
  }
  const instrumentExternal = transport => {
    if (typeof transport !== 'function') throw new TypeError('External transport must be a function');
    return function (...args) {
      const state = current(); if (!state) return transport.apply(this, args);
      const started = now(); state.externalCount++;
      let result; try { result = transport.apply(this, args); } catch (error) { state.externalMs += elapsed(started); throw error; }
      return Promise.resolve(result).then(value => { state.externalMs += elapsed(started); return value; }, error => { state.externalMs += elapsed(started); throw error; });
    };
  };
  const percentile = (values, fraction) => { const sorted = [...values].sort((a, b) => a - b); return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(3)); };
  const snapshot = () => Object.freeze({ generatedAt: new Date().toISOString(), series: [...series.values()].map(value => { const sample = samples.get(value); return Object.freeze({ ...value, wallMs: Number(value.wallMs.toFixed(3)), sqlMs: Number(value.sqlMs.toFixed(3)), poolWaitMs: Number(value.poolWaitMs.toFixed(3)), externalMs: Number(value.externalMs.toFixed(3)), maxWallMs: Number(value.maxWallMs.toFixed(3)), sampleCount: sample.wall.length, p50Ms: percentile(sample.wall, .5), p95Ms: percentile(sample.wall, .95), p99Ms: percentile(sample.wall, .99), sqlRequestP95Ms: percentile(sample.sql, .95) }); }), recent: recent.map(value => Object.freeze({ ...value })), pools: pools.map((pool, index) => {
    const name = pool.options?.application_name;
    const total = Number(pool.totalCount) || 0, idle = Number(pool.idleCount) || 0;
    return Object.freeze({ name: ['pult', 'pult_ui', 'pult_ozon_http'].includes(name) ? name : `pool-${index + 1}`, max: Number(pool.options?.max) || null, total, idle, inUse: Math.max(0, total - idle), waiting: Number(pool.waitingCount) || 0 });
  }) });
  return Object.freeze({ run, instrumentPool, instrumentExternal, snapshot });
}

const requestMetrics = createRequestMetrics();
module.exports = { createRequestMetrics, requestMetrics };
