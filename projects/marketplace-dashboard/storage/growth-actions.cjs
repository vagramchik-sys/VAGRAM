'use strict';

const crypto = require('node:crypto');
const {createJsonDocumentRepository} = require('./postgres-json-repository.cjs');
const {money, OzonPriceWriteError} = require('./acquisition/ozon-price-write.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TTL = 120000, SETTLE = 600000;
const ACTIVE = new Set();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
class GrowthActionError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'GrowthActionError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new GrowthActionError(code, message, status); };
function strict(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_ARGUMENT', 'Неподдерживаемые поля запроса.');
}
function id(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,40}$/.test(value)) fail('INVALID_ARGUMENT', 'Проверьте магазин и товар.');
  return value;
}

// Explicit one-product manual commands only. Recommendations never call apply.
function createGrowthActions({stateStore, optimizer, storesRepository, getSellerCredentials, priceTransport, adControl, now = Date.now} = {}) {
  if (!stateStore || !optimizer?.sku || !storesRepository?.read || typeof getSellerCredentials !== 'function' || !priceTransport?.read || !priceTransport?.writeOnce || !adControl?.preview || !adControl?.apply || !adControl?.reconcile) throw new TypeError('Growth actions dependencies are required');
  const locks = new Map();
  const time = () => { const value = Number(now()); if (!Number.isFinite(value)) throw new TypeError('Invalid clock'); return value; };
  const iso = () => new Date(time()).toISOString();
  async function locked(key, fn) {
    const prior = locks.get(key) || Promise.resolve(); let release;
    const next = new Promise(resolve => { release = resolve; }); locks.set(key, next); await prior;
    try { return await fn(); } finally { release(); if (locks.get(key) === next) locks.delete(key); }
  }
  const key = (storeId, productId) => `growth-price/${id(storeId)}-${id(productId)}`;
  const commandKey = commandId => `growth-price-command/${commandId}`;
  const validPlan = p => p === null || object(p) && /^[a-f0-9]{64}$/.test(p.tokenHash || '') && typeof p.offerId === 'string' && !!p.offerId && money(p.before) === p.before && money(p.after) === p.after && Number.isFinite(Date.parse(p.expiresAt));
  function repository(logicalKey) {
    return createJsonDocumentRepository({stateStore, logicalKey, maxBytes: 256 * 1024, validate: value => {
      if (!object(value) || value.version !== 1) return false;
      if (logicalKey.startsWith('growth-ad-preview/')) return /^[a-f0-9]{64}$/.test(value.tokenHash || '') && ['budget', 'state'].includes(value.kind);
      if (logicalKey.startsWith('growth-price-command/')) return UUID.test(value.commandId || '') && /^[a-f0-9]{64}$/.test(value.tokenHash || '') && typeof value.storeId === 'string' && typeof value.productId === 'string' && validPlan(value.plan) && value.plan !== null && ['reserved', 'applied', 'rejected'].includes(value.status);
      return value.storeId + '-' + value.productId === logicalKey.slice('growth-price/'.length) && validPlan(value.preview) && (value.pending === null || object(value.pending) && UUID.test(value.pending.commandId || '')) && Array.isArray(value.audit) && value.audit.length <= 50;
    }});
  }
  async function read(logicalKey, fallback = null) { const row = await repository(logicalKey).read(); return {revision: row?.revision || '0', value: row?.value || fallback}; }
  async function write(logicalKey, state, value) {
    await repository(logicalKey).compareAndSet(value, {expectedRevision: state.revision, commandId: crypto.randomUUID()});
    return {revision: String(BigInt(state.revision) + 1n), value};
  }
  const readState = (storeId, productId) => read(key(storeId, productId), {version: 1, storeId, productId, preview: null, pending: null, audit: []});
  async function requireStore(storeId) {
    id(storeId); const stores = await storesRepository.read();
    if (!Object.hasOwn(stores || {}, storeId) || stores[storeId]?.market === 'WB') fail('STORE_NOT_FOUND', 'Магазин Ozon не найден.', 404);
  }
  async function product(storeId, productId) {
    await requireStore(storeId); id(productId);
    const detail = await optimizer.sku({storeId, productId}), p = detail?.item?.product;
    if (!p || p.active !== true || String(p.storeId) !== storeId || String(p.id) !== productId || typeof p.offerId !== 'string' || !p.offerId || p.offerId.length > 200) fail('PRODUCT_UNAVAILABLE', 'Активный товар и его артикул в этом магазине не подтверждены.', 409);
    return {storeId, id: productId, offerId: p.offerId, name: typeof p.name === 'string' ? p.name : p.offerId};
  }
  async function credentials(storeId) {
    const auth = await getSellerCredentials(storeId);
    if (!auth || String(auth.clientId) !== storeId || typeof auth.apiKey !== 'string' || !auth.apiKey) fail('CREDENTIAL_UNAVAILABLE', 'Ключ Seller API этого магазина недоступен.', 503);
    return auth;
  }
  async function pricePreview(input = {}) {
    strict(input, ['storeId', 'productId', 'desiredPrice', 'exclusiveControl']);
    const storeId = id(input.storeId), productId = id(input.productId), after = money(input.desiredPrice);
    if (!after) fail('INVALID_ARGUMENT', 'Цена должна быть положительной суммой с точностью до копейки.');
    if (input.exclusiveControl !== true) fail('EXCLUSIVE_CONTROL_REQUIRED', 'Подтвердите, что другие сервисы не изменяют цену этого товара.');
    return locked(key(storeId, productId), async () => {
      const p = await product(storeId, productId), state = await readState(storeId, productId);
      if (state.value.pending) fail('OUTCOME_UNKNOWN', 'Сначала сверьте результат предыдущего изменения.', 409);
      const observed = await priceTransport.read(await credentials(storeId), p.offerId);
      const before = money(observed.price);
      if (!before || observed.currency !== 'RUB' || observed.offerId !== p.offerId) fail('INVALID_UPSTREAM', 'Текущая цена товара не подтверждена.', 502);
      if (before === after) fail('NO_CHANGE', 'В Ozon уже установлена эта цена.');
      const token = `${storeId}.${productId}.${crypto.randomBytes(24).toString('base64url')}`, expiresAt = new Date(time() + TTL).toISOString();
      const plan = {tokenHash: hash(token), offerId: p.offerId, before, after, expiresAt};
      await write(key(storeId, productId), state, {...state.value, preview: plan});
      return {kind: 'price', token, expiresAt, product: p, changes: [{label: 'Цена продавца, ₽', before, after}], warnings: ['Изменяется только цена продавца этого артикула. Цена покупателя и объём продаж могут отличаться от плана.'], blockedReason: null};
    });
  }
  async function finalize(state, command, status, details = {}) {
    const c = command.value;
    const receipt = {ok: status === 'applied', status, commandId: c.commandId, applied: details.applied === true, ...details};
    await write(commandKey(c.commandId), command, {...c, status, phase: 'settled', result: receipt, completedAt: iso()});
    await finalizeState(state, c, receipt);
    return receipt;
  }
  async function finalizeState(state, c, receipt) {
    if (state.value.pending?.commandId !== c.commandId) return;
    const entry = {commandId: c.commandId, at: iso(), before: c.plan.before, after: c.plan.after, offerId: c.plan.offerId, ...receipt};
    await write(key(c.storeId, c.productId), state, {...state.value, pending: null, preview: null, audit: [...state.value.audit, entry].slice(-50)});
  }
  async function replay(c, allowRecovery = true) {
    if (allowRecovery && c.status === 'reserved' && c.phase === 'prepared' && !ACTIVE.has(c.commandId) && Number.isFinite(Date.parse(c.settleAfter)) && time() >= Date.parse(c.settleAfter)) {
      const current = await read(commandKey(c.commandId));
      if (current.value?.status !== 'reserved' || current.value?.phase !== 'prepared') return replay(current.value, false);
      // This CAS competes with the dispatch CAS. Only one may win: a delayed
      // original process cannot dispatch after this rejected receipt commits.
      const state = await readState(c.storeId, c.productId);
      try { return {...await finalize(state, current, 'rejected', {reason: 'PREPARATION_INTERRUPTED', applied: false}), replayed: true}; }
      catch (error) { if (error?.code !== 'REVISION_CONFLICT') throw error; return replay((await read(commandKey(c.commandId))).value, false); }
    }
    if (c.status === 'reserved') return {ok: false, status: 'unknown', commandId: c.commandId, applied: false, replayed: true, message: 'Повторная отправка запрещена. Сверьте состояние с Ozon.'};
    const state = await readState(c.storeId, c.productId); await finalizeState(state, c, c.result);
    return {...c.result, replayed: true};
  }
  async function priceApply(input = {}) {
    strict(input, ['token', 'commandId', 'confirmed']);
    if (input.confirmed !== true) fail('CONFIRMATION_REQUIRED', 'Подтвердите именно это изменение цены.');
    if (typeof input.token !== 'string' || !/^[0-9]{1,40}\.[0-9]{1,40}\.[A-Za-z0-9_-]{32}$/.test(input.token) || !UUID.test(input.commandId || '')) fail('INVALID_ARGUMENT', 'Нужны предварительный просмотр и UUID команды.');
    const [storeId, productId] = input.token.split('.'), commandId = input.commandId.toLowerCase(), tokenHash = hash(input.token);
    return locked(key(storeId, productId), async () => {
      await requireStore(storeId);
      const existing = await read(commandKey(commandId));
      if (existing.value) {
        if (existing.value.tokenHash !== tokenHash || existing.value.storeId !== storeId || existing.value.productId !== productId) fail('COMMAND_ID_REUSED', 'Идентификатор команды уже использован.', 409);
        return replay(existing.value);
      }
      let state = await readState(storeId, productId); const plan = state.value.preview;
      if (state.value.pending) fail('OUTCOME_UNKNOWN', 'Предыдущее изменение требует сверки.', 409);
      if (!plan || plan.tokenHash !== tokenHash || Date.parse(plan.expiresAt) <= time()) fail('PREVIEW_STALE', 'Предварительный просмотр устарел. Сформируйте новый.', 409);
      const p = await product(storeId, productId), auth = await credentials(storeId);
      if (p.offerId !== plan.offerId || Date.parse(plan.expiresAt) <= time()) fail('PREVIEW_STALE', 'Товар изменился или истёк срок просмотра.', 409);
      let command;
      try { command = await write(commandKey(commandId), existing, {version: 1, commandId, storeId, productId, tokenHash, plan, status: 'reserved', phase: 'prepared', startedAt: iso(), settleAfter: new Date(time() + SETTLE).toISOString()}); }
      catch (error) {
        if (error?.code !== 'REVISION_CONFLICT') throw error;
        const won = await read(commandKey(commandId));
        if (won.value?.tokenHash !== tokenHash) fail('COMMAND_ID_REUSED', 'Идентификатор команды уже использован.', 409);
        return replay(won.value);
      }
      ACTIVE.add(commandId);
      try {
        // The CAS fence and durable command always precede the external request.
        state = await write(key(storeId, productId), state, {...state.value, preview: null, pending: {commandId, startedAt: command.value.startedAt, before: plan.before, after: plan.after}});
        command = await write(commandKey(commandId), command, {...command.value, phase: 'dispatching', settleAfter: new Date(time() + SETTLE).toISOString()});
        let outcome;
        try { outcome = await priceTransport.writeOnce(auth, {offerId: plan.offerId, expectedPrice: plan.before, desiredPrice: plan.after, beforeWrite: () => Date.parse(plan.expiresAt) > time()}); }
        catch (error) {
          if (error instanceof OzonPriceWriteError && error.code === 'MUTATION_NOT_SENT') return finalize(state, command, 'rejected', {reason: error.reason === 'PREVIEW_STALE' ? 'PREVIEW_STALE' : 'INITIAL_READ_FAILED', applied: false});
          return {ok: false, status: 'unknown', commandId, applied: false, message: 'Результат не подтверждён. Повторная отправка заблокирована до сверки.'};
        }
        if (outcome?.status === 'VERIFIED' && outcome.offerId === plan.offerId && money(outcome.price) === plan.after) return finalize(state, command, 'applied', {applied: outcome.applied === true, price: plan.after});
        if (outcome?.status === 'HOLD') return finalize(state, command, 'rejected', {reason: 'PRICE_CHANGED'});
        return {ok: false, status: 'unknown', commandId, applied: false, message: 'Цена после запроса не подтверждена. Повторная отправка заблокирована до сверки.'};
      } finally { ACTIVE.delete(commandId); }
    });
  }
  async function priceStatus({storeId, productId} = {}) {
    await requireStore(storeId); const state = await readState(storeId, productId);
    return {pending: state.value.pending, audit: state.value.audit};
  }
  async function priceReconcile({storeId, productId} = {}) {
    id(storeId); id(productId);
    return locked(key(storeId, productId), async () => {
      await requireStore(storeId); const state = await readState(storeId, productId), pending = state.value.pending;
      if (!pending) return {ok: true, status: 'idle', applied: false};
      const command = await read(commandKey(pending.commandId)), c = command.value;
      if (!c || c.storeId !== storeId || c.productId !== productId) fail('STATE_INVALID', 'Сохранённая команда требует проверки.', 503);
      if (c.status !== 'reserved') return replay(c);
      if (ACTIVE.has(c.commandId) || !Number.isFinite(Date.parse(c.settleAfter)) || time() < Date.parse(c.settleAfter)) return {ok: false, status: 'unknown', commandId: c.commandId, applied: false, retryAt: c.settleAfter};
      if (c.phase === 'prepared') return replay(c);
      const observed = await priceTransport.read(await credentials(storeId), c.plan.offerId);
      if (observed.offerId === c.plan.offerId && observed.currency === 'RUB' && money(observed.price) === c.plan.after) return finalize(state, command, 'applied', {applied: false, reconciled: true, attributionUnknown: true, price: c.plan.after});
      return {ok: false, status: 'unknown', commandId: c.commandId, applied: false, message: 'Ожидаемая цена пока не подтверждена. Повторная отправка остаётся заблокированной.'};
    });
  }
  async function adPreview(input = {}) {
    strict(input, ['storeId', 'campaignId', 'action', 'exclusiveControl']);
    if (!['budget', 'state'].includes(input.action?.kind)) fail('ACTION_BLOCKED', 'Доступны разовые изменения бюджета и состояния кампании. Изменение ставок и расписаний здесь отключено.');
    const preview = await adControl.preview(input);
    if (preview.token) {
      const tokenHash = hash(preview.token), logicalKey = `growth-ad-preview/${tokenHash}`;
      await write(logicalKey, await read(logicalKey), {version: 1, tokenHash, kind: input.action.kind});
    }
    return {...preview, kind: 'advertising', warnings: [...(preview.warnings || []), 'Изменение действует на всю кампанию и все её товары.']};
  }
  async function adApply(input = {}) {
    strict(input, ['token', 'commandId', 'confirmed']);
    if (input.confirmed !== true) fail('CONFIRMATION_REQUIRED', 'Подтвердите именно это изменение рекламы.');
    if (typeof input.token !== 'string' || input.token.length > 200) fail('INVALID_ARGUMENT', 'Нужен предварительный просмотр изменения.');
    const preview = await read(`growth-ad-preview/${hash(input.token)}`);
    if (!preview.value) fail('PREVIEW_STALE', 'Сформируйте предварительный просмотр в центре роста.', 409);
    return adControl.apply({token: input.token, commandId: input.commandId});
  }
  return Object.freeze({pricePreview, priceApply, priceStatus, priceReconcile, adPreview, adApply, adReconcile: input => adControl.reconcile(input)});
}

module.exports = {createGrowthActions, GrowthActionError};
