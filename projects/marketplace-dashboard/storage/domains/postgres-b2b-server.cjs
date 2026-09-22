'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { sourceKey } = require('../postgres-document-import.cjs');
const { encodeJson } = require('../postgres-json-repository.cjs');
const { classify } = require('../source-inventory.cjs');

const SOURCE_PATH = 'b2b-agent/connection.dpapi';
const LOGICAL_KEY = sourceKey(SOURCE_PATH);
const MEDIA_TYPE = 'application/vnd.pult.dpapi';
const classification = classify(SOURCE_PATH);
const SOURCE_MAPPING = Object.freeze({ sourcePath: SOURCE_PATH, logicalKey: LOGICAL_KEY, domain: classification.domain, mediaType: MEDIA_TYPE });
const DEFAULT_CONFIG = Object.freeze({ categoryId: '6', newStageId: '', newLeadStatusId: 'NEW', leadsEnabled: true, autoDraftEnabled: true, model: 'qwen3:4b', sendEnabled: false, pollEnabled: false, pollMinutes: 5 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class B2BServerError extends Error { constructor(code, message) { super(message); this.name = 'B2BServerError'; this.code = code; } }
const fail = (code, message) => { throw new B2BServerError(code, message); };
const publicError = error => error instanceof B2BServerError ? error.message : ['OUTCOME_UNKNOWN', 'DATABASE_ERROR', 'LEASE_ERROR'].includes(error?.code) ? 'Результат операции с хранилищем неизвестен. Повторите запрос с тем же идентификатором.' : 'Операция не выполнена';
const safeConfig = value => Object.fromEntries(Object.entries({ ...DEFAULT_CONFIG, ...value, sendEnabled: false }).filter(([, item]) => item !== undefined));
const event = (kind, message) => ({ kind, caseId: null, message, at: new Date().toISOString() });
function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !/^\d+$/u.test(String(value.categoryId || '')) ||
      !['newStageId', 'newLeadStatusId', 'model'].every(key => typeof value[key] === 'string') ||
      !['leadsEnabled', 'autoDraftEnabled', 'sendEnabled', 'pollEnabled'].every(key => typeof value[key] === 'boolean') ||
      !Number.isInteger(value.pollMinutes) || value.pollMinutes < 1 || value.pollMinutes > 1440 ||
      !['webhook', 'oneCUrl', 'oneCToken'].every(key => value[key] === undefined || typeof value[key] === 'string')) fail('INVALID_CONFIG', 'Защищённые настройки повреждены');
  return value;
}

async function startPostgresB2BServer(options = {}) {
  const { pool, stateStore, queue, createRunner, protect, createCrm, createOneC, modelStatus, extract, buildDraft } = options;
  if (!pool?.connect || !stateStore || !queue || typeof createRunner !== 'function' || typeof protect !== 'function') throw new TypeError('PostgreSQL server dependencies are required');
  let lease, leaseHeld = false, server, timer, closed = false, healthy = true, serialTail = Promise.resolve(), cancelTimer = clearInterval;
  const serial = callback => { const result = serialTail.then(() => { if (!healthy || closed) fail('LEASE_ERROR', 'Служба потеряла блокировку SQL'); return callback(); }); serialTail = result.catch(() => {}); return result; };
  const invalidateLease = () => { healthy = false; if (timer) cancelTimer(timer); if (server?.listening) server.close(); };
  try {
    lease = await pool.connect();
    const lock = await lease.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', ['pult:b2b-agent:runtime']);
    if (lock.rows?.[0]?.acquired !== true) fail('ALREADY_RUNNING', 'Другой процесс уже использует очередь');
    leaseHeld = true;
    if (typeof lease.on === 'function') { lease.on('error', invalidateLease); lease.on('end', invalidateLease); }

    async function decodeRecord(record, { passive = false } = {}) {
      if (!record) return { config: { ...DEFAULT_CONFIG }, revision: '0' };
      if (record.deleted === true) return { config: { ...DEFAULT_CONFIG }, revision: record.revision };
      if (record.mediaType !== MEDIA_TYPE || !Buffer.isBuffer(record.content) || record.content.length > 65536 || !Buffer.isBuffer(record.sha256) || record.sha256.length !== 32 || !crypto.createHash('sha256').update(record.content).digest().equals(record.sha256)) fail('INVALID_CONFIG', 'Защищённые настройки повреждены');
      let parsed;
      try { const ciphertext = new TextDecoder('utf-8', { fatal: true }).decode(record.content); parsed = JSON.parse(await protect(ciphertext, true)); } catch { fail('INVALID_CONFIG', 'Защищённые настройки недоступны'); }
      const config = validateConfig(safeConfig(parsed)); if (passive) config.pollEnabled = false;
      return { config, revision: record.revision };
    }
    const initial = await decodeRecord(await stateStore.read(LOGICAL_KEY, { includeDeleted: true }), { passive: true });
    let config = initial.config;
    let runner = await createRunner(config);
    let pollExplicit = false;

    async function saveSettings(commandId, derive, validateProposed, allowPoll = pollExplicit) {
      if (!UUID.test(commandId || '')) fail('INVALID_COMMAND', 'Нужен стабильный идентификатор изменения');
      const recorded = await stateStore.readCommand(LOGICAL_KEY, commandId, { operation: 'write', sourceMapping: SOURCE_MAPPING });
      if (recorded) {
        const before = await decodeRecord(recorded.before.deleted === null ? null : recorded.before);
        const after = await decodeRecord(recorded.after);
        const expected = validateConfig(safeConfig(derive(before.config)));
        if (!encodeJson(expected).equals(encodeJson(after.config))) fail('COMMAND_ID_REUSED', 'Идентификатор уже использован для другого изменения');
        const fresh = await decodeRecord(await stateStore.read(LOGICAL_KEY, { includeDeleted: true }));
        return { responseConfig: after.config, activeConfig: { ...fresh.config, pollEnabled: allowPoll ? fresh.config.pollEnabled : false }, replayed: true };
      }
      const currentRecord = await stateStore.read(LOGICAL_KEY, { includeDeleted: true }), current = await decodeRecord(currentRecord);
      const proposed = validateConfig(safeConfig(derive(current.config)));
      await validateProposed?.(proposed);
      const ciphertext = Buffer.from(await protect(JSON.stringify(proposed)), 'utf8');
      if (!healthy) fail('LEASE_ERROR', 'Служба потеряла блокировку SQL');
      await stateStore.write(LOGICAL_KEY, ciphertext, { expectedRevision: current.revision, commandId, mediaType: MEDIA_TYPE, sourceMapping: SOURCE_MAPPING });
      return { responseConfig: proposed, activeConfig: { ...proposed, pollEnabled: allowPoll ? proposed.pollEnabled : false }, replayed: false };
    }
    async function activate(proposed) {
      if (!healthy) fail('LEASE_ERROR', 'Служба потеряла блокировку SQL');
      const next = await createRunner(proposed);
      if (!healthy) fail('LEASE_ERROR', 'Служба потеряла блокировку SQL');
      config = proposed; runner = next;
    }

    const staticDir = options.staticDir || path.join(__dirname, '..', '..', 'b2b-agent', 'web');
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    const nonce = crypto.randomBytes(32).toString('hex');
    let origin, expectedHost;
    server = http.createServer(async (req, res) => {
      const json = (status, data) => { res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
      if (req.headers.host !== expectedHost) return json(403, { error: 'Недопустимый адрес' });
      let requestUrl; try { requestUrl = new URL(req.url, origin); } catch { return json(400, { error: 'Неверный запрос' }); }
      if (req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Запрос с другой страницы запрещён' });
      try {
        const route = requestUrl.pathname;
        if (req.method === 'GET' && ['/', '/ui.js', '/ui.css'].includes(route)) {
          const file = route === '/' ? 'index.html' : route.slice(1);
          res.writeHead(200, { ...headers, 'content-type': route.endsWith('.js') ? 'text/javascript' : route.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
          return res.end(fs.readFileSync(path.join(staticDir, file)));
        }
        if (req.method === 'GET' && route === '/api/state') {
          const snapshot = await queue.load(); queue.assertReady(snapshot);
          return json(200, { nonce, busy: runner.busy, config: { categoryId: config.categoryId, newStageId: config.newStageId, newLeadStatusId: config.newLeadStatusId, leadsEnabled: config.leadsEnabled, autoDraftEnabled: config.autoDraftEnabled, model: config.model, pollEnabled: config.pollEnabled, pollMinutes: config.pollMinutes, sendEnabled: false }, connections: { crm: !!config.webhook, oneC: !!config.oneCUrl }, model: await modelStatus(), cases: Object.values(snapshot.value.cases).map(({ body, ...row }) => row), events: snapshot.value.events.slice(0, 50), lastScan: snapshot.value.lastScan, lastProcess: snapshot.value.lastProcess });
        }
        if (req.method !== 'POST') return json(404, { error: 'Страница не найдена' });
        if (req.headers['x-b2b-token'] !== nonce || req.headers.origin !== origin) return json(403, { error: 'Обновите страницу управления' });
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return json(413, { error: 'Слишком большой запрос' }); }
        let data; try { data = JSON.parse(raw || '{}'); } catch { return json(400, { error: 'Неверный формат запроса' }); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return json(400, { error: 'Неверный формат запроса' });
        const commandId = req.headers['x-b2b-command-id'];
        if (route === '/api/connect') {
          return json(200, await serial(async () => {
            if (runner.busy) fail('BUSY', 'Дождитесь завершения текущей операции');
            const derive = current => safeConfig({ ...current, webhook: data.webhook || current.webhook, categoryId: String(data.categoryId || current.categoryId), oneCUrl: data.oneCUrl || current.oneCUrl, oneCToken: data.oneCToken || current.oneCToken, model: String(data.model || current.model), newStageId: data.newStageId || (String(data.categoryId || current.categoryId) === current.categoryId ? current.newStageId : ''), pollEnabled: false });
            let stages = [];
            const outcome = await saveSettings(commandId, derive, async proposed => {
              if (!/^\d+$/u.test(proposed.categoryId) || !proposed.webhook) fail('INVALID_CONFIG', 'Неверные параметры подключения');
              const crm = createCrm(proposed.webhook); stages = await crm.listDealStages(proposed.categoryId);
              if (data.newStageId && !stages.some(item => item.STATUS_ID === data.newStageId)) fail('INVALID_STAGE', 'Выбранная стадия отсутствует в воронке');
              if (proposed.oneCUrl) createOneC(proposed.oneCUrl, proposed.oneCToken);
            }, false);
            await activate(outcome.activeConfig);
            return { ok: true, replayed: outcome.replayed, stages: stages.map(item => ({ id: item.STATUS_ID, name: item.NAME })) };
          }));
        }
        if (route === '/api/scan') return json(200, await serial(() => runner.scan()));
        if (route === '/api/draft') { await serial(() => runner.draft(String(data.id))); return json(200, { ok: true }); }
        if (route === '/api/process') return json(200, await serial(() => runner.processBatch({ limit: 3 })));
        if (route === '/api/leads' || route === '/api/processing' || route === '/api/poll') {
          return json(200, await serial(async () => {
            if (runner.busy || typeof data.enabled !== 'boolean') fail('INVALID_SETTING', 'Настройка недоступна');
            if (data.enabled && !config.webhook) fail('CRM_REQUIRED', 'Сначала подключите CRM');
            if (route === '/api/poll' && data.enabled && !config.newStageId) fail('STAGE_REQUIRED', 'Сначала выберите стадию');
            const key = route === '/api/leads' ? 'leadsEnabled' : route === '/api/processing' ? 'autoDraftEnabled' : 'pollEnabled';
            const explicitPoll = route === '/api/poll';
            const outcome = await saveSettings(commandId, current => ({ ...current, [key]: data.enabled }), null, pollExplicit || explicitPoll);
            if (explicitPoll) pollExplicit = true;
            await activate(outcome.activeConfig);
            return { ok: true, replayed: outcome.replayed };
          }));
        }
        if (route === '/api/demo') return json(200, await serial(async () => { const started = Date.now(), extraction = await extract({ subject: 'Учебный запрос', body: 'Синтетический запрос' }, config.model); return { synthetic: true, extraction, draft: buildDraft(extraction), elapsedMs: Date.now() - started }; }));
        return json(404, { error: 'Операция не найдена' });
      } catch (error) { return json(400, { error: publicError(error) }); }
    });
    const requestedPort = Number.isInteger(options.port) ? options.port : 4330;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', resolve); });
    const address = server.address(); expectedHost = `127.0.0.1:${address.port}`; origin = `http://${expectedHost}`;
    let cycleRunning = false;
    const schedule = options.setInterval || setInterval;
    const cancel = options.clearInterval || clearInterval;
    cancelTimer = cancel;
    timer = schedule(async () => {
      if (!config.pollEnabled || runner.busy || cycleRunning) return;
      cycleRunning = true;
      try { await serial(async () => {
        try { await runner.scan(); if (!healthy || closed) return; if (config.autoDraftEnabled) await runner.processBatch({ limit: 3 }); }
        catch { if (healthy && !closed) { const snapshot = await queue.load(); if (healthy && !closed) await queue.updateEvent(snapshot, { event: event('error', 'Обновление или разбор очереди не удалось. Проверьте журнал.'), commandId: crypto.randomUUID() }); } }
      }); } catch {}
      finally { cycleRunning = false; }
    }, 300000); timer.unref?.();
    async function close() {
      if (closed) return; closed = true; cancel(timer);
      await new Promise(resolve => server.listening ? server.close(resolve) : resolve());
      await serialTail;
      let destroy = !healthy;
      if (leaseHeld && healthy) try { const result = await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked', ['pult:b2b-agent:runtime']); if (result.rows?.[0]?.unlocked !== true) destroy = true; } catch { destroy = true; }
      leaseHeld = false; try { lease.release(destroy || undefined); } catch {}
    }
    return Object.freeze({ server, origin, nonce, close, get runner() { return runner; } });
  } catch (error) {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (lease) { try { lease.release(true); } catch {} }
    throw error;
  }
}

module.exports = { startPostgresB2BServer, B2BServerError, LOGICAL_KEY, SOURCE_MAPPING, MEDIA_TYPE };
