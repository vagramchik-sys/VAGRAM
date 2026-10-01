'use strict';

const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREVIEW_TTL = 2 * 60 * 1000;
// Runtime additionally owns the PostgreSQL singleton lease. This persisted
// delay protects recovery after a crash; the process-wide set also fences
// another service instance while a live request is still running.
const SETTLE_DELAY = 2 * 60 * 1000;
const ACTIVE_DISPATCHES = new Set();
const BID_REASON = 'Ozon предупреждает об удалении стоп-фраз при обновлении ставки. Запись ставок пока отключена.';
const SCHEDULE_NOTICE = 'Расписание запускает обратно только кампанию, которую Пульт сам остановил по этому расписанию. Изначально выключенная кампания автоматически не запускается.';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
class OzonAdControlError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'OzonAdControlError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new OzonAdControlError(code, message, status); };
function id(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,40}$/.test(value)) fail('INVALID_ARGUMENT', 'Некорректный идентификатор.');
  return value;
}
function strict(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_ARGUMENT', 'Неподдерживаемые поля запроса.');
}
const scheduleDefault = () => ({enabled: false, days: [1, 2, 3, 4, 5, 6, 7], start: '09:00', end: '21:00', timezone: 'Europe/Moscow', resumeAllowed: false});
function actionShape(input) {
  if (!object(input)) fail('INVALID_ARGUMENT', 'Укажите одно изменение.');
  if (input.kind === 'budget') {
    strict(input, ['kind', 'weeklyBudgetRub']);
    const value = input.weeklyBudgetRub;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100000000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) fail('INVALID_ARGUMENT', 'Недельный бюджет должен быть положительной суммой до 100 000 000 ₽ с точностью до копейки.');
    return {kind: input.kind, weeklyBudgetRub: value};
  }
  if (input.kind === 'bid') {
    strict(input, ['kind', 'sku', 'bidRub']);
    if (typeof input.bidRub !== 'number' || !Number.isFinite(input.bidRub) || input.bidRub <= 0) fail('INVALID_ARGUMENT', 'Некорректная ставка.');
    return {kind: input.kind, sku: id(input.sku), bidRub: input.bidRub};
  }
  if (input.kind === 'state') {
    strict(input, ['kind', 'active']);
    if (typeof input.active !== 'boolean') fail('INVALID_ARGUMENT', 'Укажите состояние кампании.');
    return {kind: input.kind, active: input.active};
  }
  if (input.kind === 'schedule') {
    strict(input, ['kind', 'enabled', 'days', 'start', 'end', 'timezone']);
    if (typeof input.enabled !== 'boolean' || !Array.isArray(input.days) || !input.days.length || input.days.length > 7 || input.days.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(input.days).size !== input.days.length || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(input.start || '') || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(input.end || '') || input.start >= input.end || input.timezone !== 'Europe/Moscow') fail('INVALID_ARGUMENT', 'Расписание: выберите дни 1–7 и время в пределах одного дня, начало раньше конца, часовой пояс Москва.');
    return {kind: input.kind, enabled: input.enabled, days: [...input.days].sort((a, b) => a - b), start: input.start, end: input.end, timezone: input.timezone};
  }
  fail('INVALID_ARGUMENT', 'Неизвестное изменение.');
}
function budgetRub(value) {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw) || BigInt(raw) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(raw) / 1e6;
}
function campaignShape(raw) {
  if (!object(raw)) fail('INVALID_UPSTREAM', 'Ozon вернул неизвестную кампанию.', 502);
  const campaignId = id(String(raw.id ?? ''));
  const state = typeof raw.state === 'string' ? raw.state : null;
  return {id: campaignId, name: typeof raw.title === 'string' ? raw.title : campaignId, title: typeof raw.title === 'string' ? raw.title : campaignId, state,
    active: state === 'CAMPAIGN_STATE_RUNNING' ? true : state === 'CAMPAIGN_STATE_INACTIVE' ? false : null,
    paymentType: raw.paymentType !== undefined && raw.PaymentType !== undefined && raw.paymentType !== raw.PaymentType ? null : typeof raw.paymentType === 'string' ? raw.paymentType : typeof raw.PaymentType === 'string' ? raw.PaymentType : null,
    strategy: typeof raw.productAutopilotStrategy === 'string' ? raw.productAutopilotStrategy : null,
    productAutopilotStrategy: typeof raw.productAutopilotStrategy === 'string' ? raw.productAutopilotStrategy : null,
    weeklyBudgetRub: budgetRub(raw.weeklyBudget), budgetType: typeof raw.budgetType === 'string' ? raw.budgetType : null, objectType: raw.advObjectType ?? null,
    updatedAt: typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : null};
}
function scheduleActive(schedule, at) {
  const date = new Date(at + 3 * 60 * 60 * 1000), day = date.getUTCDay() || 7;
  const time = date.toISOString().slice(11, 16);
  return schedule.enabled && schedule.days.includes(day) && time >= schedule.start && time < schedule.end;
}

function createOzonAdControl({stateStore, transport, storesRepository, now = Date.now} = {}) {
  if (!stateStore?.read || !stateStore?.write || !stateStore?.list || !transport?.listCampaigns || !transport?.listCampaignProducts || !storesRepository?.read || typeof now !== 'function') throw new TypeError('Ozon ad control dependencies are required');
  const locks = new Map();
  const campaignChecks = new Map();
  let timer = null, tickRunning = null, closing = false;
  let lastCheck = {lastCheckedAt: null, lastErrorCode: null, checked: 0, errors: 0};
  const available = () => { if (closing) fail('CONTROL_CLOSING', 'Управление рекламой останавливается.', 503); };
  const at = () => { const value = Number(now()); if (!Number.isFinite(value)) throw new TypeError('Invalid clock'); return value; };
  const iso = () => new Date(at()).toISOString();
  const schedulerStatus = () => ({running: timer !== null, ...lastCheck});
  const safeError = error => new Set(['AUTH_FAILED', 'AUTH_FORBIDDEN', 'MISSING_CREDENTIALS', 'RATE_LIMITED', 'OUTCOME_UNKNOWN', 'WRITE_OUTCOME_UNKNOWN', 'STATE_INVALID', 'STORE_NOT_FOUND', 'CAMPAIGN_NOT_FOUND', 'REVISION_CONFLICT']).has(error?.code) ? error.code : 'AD_CONTROL_UNAVAILABLE';
  const key = (storeId, campaignId) => `adcontrol/${id(storeId)}-${id(campaignId)}`;
  const commandKey = commandId => `adcontrol-command/${commandId}`;
  async function locked(name, run) {
    const before = locks.get(name) || Promise.resolve();
    let release; const current = new Promise(resolve => { release = resolve; });
    locks.set(name, current); await before;
    try { return await run(); } finally { release(); if (locks.get(name) === current) locks.delete(name); }
  }
  async function read(logicalKey, fallback = null) {
    const row = await stateStore.read(logicalKey, {includeDeleted: true});
    if (!row || row.deleted) return {revision: row ? String(row.revision) : '0', value: clone(fallback)};
    try {
      if (row.mediaType !== 'application/json' || !Buffer.isBuffer(row.content) || !/^[0-9]+$/.test(String(row.revision)) || row.sha256 && (!Buffer.isBuffer(row.sha256) || !crypto.createHash('sha256').update(row.content).digest().equals(row.sha256))) throw Error();
      const value = JSON.parse(row.content.toString('utf8'));
      if (!object(value)) throw Error();
      return {revision: String(row.revision), value};
    } catch { fail('STATE_INVALID', 'Локальное состояние требует проверки. Изменения заблокированы.', 503); }
  }
  async function write(logicalKey, snapshot, value) {
    await stateStore.write(logicalKey, Buffer.from(JSON.stringify(value)), {expectedRevision: snapshot.revision, commandId: crypto.randomUUID(), mediaType: 'application/json'});
    return {revision: String(BigInt(snapshot.revision) + 1n), value};
  }
  const initial = (storeId, campaignId) => ({version: 1, storeId, campaignId, schedule: scheduleDefault(), preview: null, pending: null, audit: []});
  async function campaignState(storeId, campaignId) {
    const value = await read(key(storeId, campaignId), initial(storeId, campaignId));
    const data = value.value;
    if (data.version !== 1 || data.storeId !== storeId || data.campaignId !== campaignId || !object(data.schedule) || !Array.isArray(data.audit)) fail('STATE_INVALID', 'Локальное состояние кампании требует проверки.', 503);
    // Revalidate stored scheduling rules before they can influence external state.
    actionShape({kind: 'schedule', enabled: data.schedule.enabled, days: data.schedule.days, start: data.schedule.start, end: data.schedule.end, timezone: data.schedule.timezone});
    return value;
  }
  async function stores() {
    const registry = await storesRepository.read();
    return Object.entries(registry || {}).filter(([storeId, row]) => /^[0-9]+$/.test(storeId) && row?.market !== 'WB').map(([storeId, row]) => ({id: storeId, name: typeof row.name === 'string' ? row.name : storeId}));
  }
  async function requireStore(storeId) { id(storeId); if (!(await stores()).some(row => row.id === storeId)) fail('STORE_NOT_FOUND', 'Магазин Ozon не найден.', 404); }
  async function capabilities() {
    const raw = typeof transport.getManagementCapabilities === 'function' ? await transport.getManagementCapabilities() : transport.capabilities || {};
    return {budgetWrite: raw.budgetWrite === true && typeof transport.updateWeeklyBudget === 'function', stateWrite: raw.stateWrite === true && typeof transport.setCampaignActive === 'function', scheduleWrite: raw.stateWrite === true && typeof transport.setCampaignActive === 'function', bidWrite: false, bidReadUnit: null, bidBlockedReason: BID_REASON};
  }
  async function campaigns({storeId} = {}) {
    await requireStore(storeId);
    const rows = await transport.listCampaigns(storeId);
    if (!Array.isArray(rows)) fail('INVALID_UPSTREAM', 'Список кампаний Ozon недоступен.', 502);
    return {campaigns: rows.map(campaignShape), observedAt: iso(), capabilities: await capabilities()};
  }
  async function observe(storeId, campaignId) {
    const result = await campaigns({storeId});
    const campaign = result.campaigns.find(row => row.id === campaignId);
    if (!campaign) fail('CAMPAIGN_NOT_FOUND', 'Кампания Ozon не найдена.', 404);
    return campaign;
  }
  async function campaign({storeId, campaignId} = {}) {
    id(campaignId);
    const observed = await observe(storeId, campaignId), state = await campaignState(storeId, campaignId);
    let products = [], productsError = null;
    try {
      const raw = await transport.listCampaignProducts(storeId, campaignId);
      if (!Array.isArray(raw)) throw Error();
      products = raw.map(row => { const name = typeof row.title === 'string' ? row.title : typeof row.name === 'string' ? row.name : String(row.sku); return {sku: id(String(row.sku ?? '')), name, title: name, currentBid: null, bidRub: null}; });
    } catch { productsError = 'Состав товаров временно недоступен. Настройки кампании и история остаются доступны.'; }
    return {campaign: observed, products, productsError, schedule: clone(state.value.schedule), audit: clone(state.value.audit), pending: state.value.pending ? {commandId: state.value.pending.commandId, status: 'unknown', action: state.value.pending.action, startedAt: state.value.pending.startedAt} : null, capabilities: await capabilities(), observedAt: iso(), notice: SCHEDULE_NOTICE, scheduler: {...schedulerStatus(), campaign: campaignChecks.get(key(storeId, campaignId)) || null}};
  }
  function policy(observed, action, caps) {
    if (action.kind === 'bid') return BID_REASON;
    if (action.kind === 'schedule' && !action.enabled) return null;
    if (observed.objectType !== 'SKU' || observed.paymentType !== 'CPC') return 'В этой версии доступно управление существующими CPC-кампаниями товаров.';
    if (observed.active === null) return 'Состояние кампании не позволяет безопасно изменить её настройки.';
    if (action.kind === 'budget' && (!caps.budgetWrite || observed.budgetType !== 'PRODUCT_CAMPAIGN_BUDGET_TYPE_WEEKLY' || !(observed.weeklyBudgetRub > 0))) return 'Изменение доступно только для кампании с уже включённым недельным бюджетом.';
    if ((action.kind === 'state' || action.kind === 'schedule') && !caps.stateWrite) return 'Управление состоянием кампании недоступно.';
    return null;
  }
  const fingerprint = observed => hash({id: observed.id, state: observed.state, paymentType: observed.paymentType, weeklyBudgetRub: observed.weeklyBudgetRub, budgetType: observed.budgetType, strategy: observed.strategy, objectType: observed.objectType, updatedAt: observed.updatedAt});
  function changes(action, observed, schedule) {
    if (action.kind === 'budget') return [{label: 'Недельный бюджет, ₽', before: observed.weeklyBudgetRub, after: action.weeklyBudgetRub}];
    if (action.kind === 'state') return [{label: 'Состояние', before: observed.active ? 'Включена' : 'Выключена', after: action.active ? 'Включена' : 'Выключена'}];
    if (action.kind === 'schedule') return [{label: 'Расписание, Москва', before: {enabled: schedule.enabled, days: schedule.days, start: schedule.start, end: schedule.end}, after: {enabled: action.enabled, days: action.days, start: action.start, end: action.end}}];
    return [];
  }
  async function preview(input = {}) {
    available();
    strict(input, ['storeId', 'campaignId', 'action', 'exclusiveControl']);
    const storeId = id(input.storeId), campaignId = id(input.campaignId), action = actionShape(input.action);
    if (input.exclusiveControl !== true) fail('EXCLUSIVE_CONTROL_REQUIRED', 'Подтвердите, что другие сервисы не управляют этой кампанией.');
    return locked(key(storeId, campaignId), async () => {
      const state = await campaignState(storeId, campaignId), observed = await observe(storeId, campaignId), caps = await capabilities();
      const blockedReason = state.value.pending ? 'Результат предыдущего изменения неизвестен. Сначала сверьте состояние с Ozon.' : policy(observed, action, caps);
      if (blockedReason) return {token: null, expiresAt: null, changes: [], warnings: [], blockedReason};
      const token = `${storeId}.${campaignId}.${crypto.randomBytes(24).toString('base64url')}`, expiresAt = new Date(at() + PREVIEW_TTL).toISOString();
      const value = {...state.value, preview: {tokenHash: hash(token), action, fingerprint: fingerprint(observed), expiresAt, revision: String(BigInt(state.revision) + 1n), exclusiveControl: true}};
      await write(key(storeId, campaignId), state, value);
      return {token, expiresAt, changes: changes(action, observed, state.value.schedule), warnings: action.kind === 'schedule' ? [SCHEDULE_NOTICE] : [], blockedReason: null};
    });
  }
  const addAudit = (value, entry) => [...value.audit, entry].slice(-50);
  const result = (commandId, status, extra = {}) => ({ok: status === 'applied', commandId, status, ...extra});
  function commandResult(command) {
    if (command.status === 'applied' || command.status === 'rejected') return {...command.result, replayed: true};
    fail('OUTCOME_UNKNOWN', 'Результат изменения пока неизвестен. Повторная отправка запрещена; выполните сверку с Ozon.', 503);
  }
  async function reserve(commandId, tokenHash, storeId, campaignId, action, source) {
    const logicalKey = commandKey(commandId), old = await read(logicalKey);
    if (old.value) {
      if (old.value.tokenHash !== tokenHash || old.value.storeId !== storeId || old.value.campaignId !== campaignId) fail('COMMAND_ID_REUSED', 'Идентификатор команды уже использован.', 409);
      return {replay: await replay(old.value)};
    }
    const value = {version: 1, commandId, tokenHash, storeId, campaignId, action, source, status: 'reserved', phase: 'prepared', settleAfter: new Date(at() + SETTLE_DELAY).toISOString(), startedAt: iso()};
    try { return {command: await write(logicalKey, old, value)}; }
    catch (error) {
      if (error?.code === 'REVISION_CONFLICT') {
        const existing = await read(logicalKey);
        if (existing.value?.tokenHash !== tokenHash) fail('COMMAND_ID_REUSED', 'Идентификатор команды уже использован.', 409);
        return {replay: await replay(existing.value)};
      }
      throw error;
    }
  }
  function matches(action, observed) {
    return action.kind === 'budget' ? observed.weeklyBudgetRub === action.weeklyBudgetRub : action.kind === 'state' ? observed.active === action.active : false;
  }
  function completedSchedule(schedule, command, observed) {
    if (command.action.kind === 'schedule') { const {kind, ...schedule} = command.action; return {...schedule, resumeAllowed: false}; }
    if (command.action.kind !== 'state') return schedule;
    return {...schedule, resumeAllowed: command.source === 'schedule' && command.action.active === false && !!observed?.updatedAt,
      pausedState: command.source === 'schedule' && command.action.active === false ? observed?.state || null : null,
      pausedUpdatedAt: command.source === 'schedule' && command.action.active === false ? observed?.updatedAt || null : null};
  }
  async function finalizeState(state, c, status, observed = null) {
    const schedule = status === 'applied' ? completedSchedule(state.value.schedule, c, observed) : state.value.schedule;
    const value = {...state.value, pending: null, preview: null, schedule, audit: addAudit(state.value, {commandId: c.commandId, action: c.action, source: c.source, status, at: iso()})};
    await write(key(c.storeId, c.campaignId), state, value);
  }
  async function finish(state, command, status, observed = null) {
    const c = command.value, receipt = result(c.commandId, status);
    const confirmation = observed ? {state: observed.state, updatedAt: observed.updatedAt} : null;
    await write(commandKey(c.commandId), command, {...c, status, phase: 'settled', result: receipt, confirmation, completedAt: iso()});
    await finalizeState(state, c, status, observed);
    return receipt;
  }
  async function replay(c) {
    const receipt = commandResult(c);
    const state = await campaignState(c.storeId, c.campaignId);
    if (state.value.pending?.commandId === c.commandId) await finalizeState(state, c, c.status, c.confirmation);
    return receipt;
  }
  async function unknown(state, command) {
    // The durable pending reservation is sufficient even if these diagnostic writes fail.
    const value = {...command.value, status: 'unknown', phase: 'settled', settleAfter: new Date(at() + SETTLE_DELAY).toISOString()};
    try { await write(commandKey(value.commandId), command, value); } catch {}
    fail('OUTCOME_UNKNOWN', 'Ozon мог принять изменение. Повторная отправка заблокирована до сверки состояния.', 503);
  }
  async function execute(state, command, before = null) {
    let c = command.value;
    ACTIVE_DISPATCHES.add(c.commandId);
    try {
      // This CAS is the campaign fence. No external mutation happens before it succeeds.
      state = await write(key(c.storeId, c.campaignId), state, {...state.value, preview: null, pending: {commandId: c.commandId, action: c.action, source: c.source, startedAt: c.startedAt}});
      if (c.action.kind === 'schedule') return await finish(state, command, 'applied');
      // Reapplying an observed value is entirely local; otherwise a slow no-op
      // request could overwrite a newer value after premature reconciliation.
      if (before && matches(c.action, before)) return await finish(state, command, 'applied', before);
      command = await write(commandKey(c.commandId), command, {...c, phase: 'dispatching', settleAfter: new Date(at() + SETTLE_DELAY).toISOString()});
      c = command.value;
      try {
        if (c.action.kind === 'budget') await transport.updateWeeklyBudget(c.storeId, c.campaignId, c.action.weeklyBudgetRub);
        else if (c.action.kind === 'state') await transport.setCampaignActive(c.storeId, c.campaignId, c.action.active);
        else fail('BID_DISABLED', BID_REASON);
      } catch (error) {
        if (error?.code === 'MUTATION_REJECTED' || error?.code === 'MUTATION_NOT_SENT') return await finish(state, command, 'rejected');
        return await unknown(state, command);
      }
      let observed;
      try { observed = await observe(c.storeId, c.campaignId); } catch { return await unknown(state, command); }
      if (!matches(c.action, observed)) return await unknown(state, command);
      return await finish(state, command, 'applied', observed);
    } finally { ACTIVE_DISPATCHES.delete(c.commandId); }
  }
  async function apply(input = {}) {
    available();
    strict(input, ['token', 'commandId']);
    if (typeof input.token !== 'string' || !/^[0-9]{1,40}\.[0-9]{1,40}\.[A-Za-z0-9_-]{32}$/.test(input.token) || !UUID.test(input.commandId || '')) fail('INVALID_ARGUMENT', 'Нужны предварительный просмотр и UUID команды.');
    const [storeId, campaignId] = input.token.split('.'), commandId = input.commandId.toLowerCase(), tokenHash = hash(input.token);
    return locked(key(storeId, campaignId), async () => {
      const existing = await read(commandKey(commandId));
      if (existing.value) {
        if (existing.value.tokenHash !== tokenHash || existing.value.storeId !== storeId || existing.value.campaignId !== campaignId) fail('COMMAND_ID_REUSED', 'Идентификатор команды уже использован.', 409);
        return replay(existing.value);
      }
      const state = await campaignState(storeId, campaignId), plan = state.value.preview;
      if (state.value.pending) fail('OUTCOME_UNKNOWN', 'Предыдущее изменение требует сверки с Ozon.', 503);
      if (!plan || plan.tokenHash !== tokenHash || plan.revision !== state.revision || Date.parse(plan.expiresAt) <= at()) fail('PREVIEW_STALE', 'Предварительный просмотр устарел. Сформируйте новый.', 409);
      const observed = await observe(storeId, campaignId), reason = policy(observed, plan.action, await capabilities());
      if (reason) fail('ACTION_BLOCKED', reason, 409);
      if (fingerprint(observed) !== plan.fingerprint || Date.parse(plan.expiresAt) <= at()) fail('PREVIEW_STALE', 'Кампания изменилась в Ozon или истекло время проверки. Сформируйте новый предварительный просмотр.', 409);
      const reservation = await reserve(commandId, tokenHash, storeId, campaignId, plan.action, 'manual');
      return reservation.replay || execute(state, reservation.command, observed);
    });
  }
  async function reconcile({storeId, campaignId} = {}) {
    available();
    id(storeId); id(campaignId);
    return locked(key(storeId, campaignId), async () => {
      await requireStore(storeId);
      const state = await campaignState(storeId, campaignId), pending = state.value.pending;
      if (!pending) return {ok: true, status: 'idle'};
      const command = await read(commandKey(pending.commandId));
      if (!command.value || command.value.storeId !== storeId || command.value.campaignId !== campaignId) fail('STATE_INVALID', 'Не найдена сохранённая команда. Изменения заблокированы.', 503);
      const c = command.value;
      const settleAfter = Date.parse(c.settleAfter || '') || Date.parse(c.startedAt || '') + SETTLE_DELAY;
      const finalized = c.status === 'rejected' || c.status === 'applied';
      if (ACTIVE_DISPATCHES.has(c.commandId) || !finalized && (!Number.isFinite(settleAfter) || at() < settleAfter)) return {ok: false, status: 'unknown', commandId: c.commandId, retryAt: Number.isFinite(settleAfter) ? new Date(settleAfter).toISOString() : null, message: 'Запрос ещё может выполняться. Сверьте состояние после завершения ожидания.'};
      if (c.status === 'rejected' || c.status === 'applied') return replay(c);
      if (c.action.kind === 'schedule') return finish(state, command, 'applied');
      const observed = await observe(storeId, campaignId);
      if (matches(c.action, observed)) return finish(state, command, 'applied', observed);
      return {ok: false, status: 'unknown', commandId: c.commandId, message: 'Ожидаемое значение пока не подтверждено. Повторная отправка заблокирована.'};
    });
  }
  async function tickCampaign(storeId, campaignId) {
    return locked(key(storeId, campaignId), async () => {
      let state = await campaignState(storeId, campaignId), schedule = state.value.schedule;
      if (!schedule.enabled || state.value.pending) return;
      const observed = await observe(storeId, campaignId), desired = scheduleActive(schedule, at());
      if (schedule.resumeAllowed && (observed.active !== false || !schedule.pausedUpdatedAt || schedule.pausedUpdatedAt !== observed.updatedAt || schedule.pausedState !== observed.state)) {
        schedule = {...schedule, resumeAllowed: false, pausedState: null, pausedUpdatedAt: null};
        state = await write(key(storeId, campaignId), state, {...state.value, schedule, preview: null});
      }
      if (observed.active === null || policy(observed, {kind: 'state', active: desired}, await capabilities())) return;
      if (observed.active === desired) return;
      if (desired && (schedule.resumeAllowed !== true || !schedule.pausedUpdatedAt || schedule.pausedState !== observed.state || schedule.pausedUpdatedAt !== observed.updatedAt)) return;
      const commandId = crypto.randomUUID(), action = {kind: 'state', active: desired};
      const reservation = await reserve(commandId, hash({commandId, source: 'schedule'}), storeId, campaignId, action, 'schedule');
      if (reservation.command) await execute(state, reservation.command, observed);
    });
  }
  function tick() {
    if (closing) return Promise.resolve({checked: 0, errors: 0});
    if (tickRunning) return tickRunning;
    tickRunning = (async () => {
      const rows = await stateStore.list({prefix: 'adcontrol/', includeContent: false});
      const summary = {checked: 0, errors: 0, lastErrorCode: null};
      for (const row of rows) {
        if (closing) break;
        const match = /^adcontrol\/([0-9]{1,40})-([0-9]{1,40})$/.exec(row.logicalKey || '');
        if (!match) continue;
        summary.checked++;
        try { await tickCampaign(match[1], match[2]); campaignChecks.set(row.logicalKey, {lastCheckedAt: iso(), lastErrorCode: null}); }
        catch (error) { summary.errors++; summary.lastErrorCode = safeError(error); campaignChecks.set(row.logicalKey, {lastCheckedAt: iso(), lastErrorCode: summary.lastErrorCode}); }
      }
      lastCheck = {...summary, lastCheckedAt: iso()};
      return summary;
    })().catch(error => { lastCheck = {lastCheckedAt: iso(), lastErrorCode: safeError(error), checked: 0, errors: 1}; throw error; }).finally(() => { tickRunning = null; });
    return tickRunning;
  }
  const background = Object.freeze({
    start() { closing = false; if (!timer) { timer = setInterval(() => { tick().catch(() => {}); }, 60000); timer.unref?.(); } },
    async stop() { closing = true; if (timer) { clearInterval(timer); timer = null; } if (tickRunning) await tickRunning.catch(() => {}); await Promise.all([...locks.values()]); }
  });
  return Object.freeze({overview: async () => ({stores: await stores(), capabilities: await capabilities(), notice: SCHEDULE_NOTICE, scheduler: schedulerStatus()}), campaigns, campaign, preview, apply, reconcile, tick, background, start: background.start, stop: background.stop, close: background.stop});
}

module.exports = {createOzonAdControl, OzonAdControlError, campaignShape, actionShape, scheduleActive};
