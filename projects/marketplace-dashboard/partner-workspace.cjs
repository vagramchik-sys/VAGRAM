'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

class PartnerError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.public = true; }
}
const fail = (message, status) => { throw new PartnerError(message, status); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 500) : null;
const units = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
// These are separate projections: internal commercial terms must never reach partner responses.
// Rates are stated by the owner, not fetched marketplace tariffs. No amount is calculated here.
const ownerCommercialModel = terms => ({ basis: 'commission-rate-difference', status: 'base-unconfirmed', ourCommissionPercent: terms.ourCommissionPercent, partnerCommissionPercent: terms.partnerCommissionPercent, advertisingPercent: null, targetDifferencePercentagePoints: terms.ourCommissionPercent !== null && terms.partnerCommissionPercent !== null ? Math.round((terms.partnerCommissionPercent - terms.ourCommissionPercent) * 10000) / 10000 : null, calculationBase: null, vatTreatment: null, expenseTreatment: null, source: 'owner-provided-not-api-verified', reason: 'Ставки указываются владельцем и не подтверждены API площадки. Общая база расчёта, НДС и учёт расходов не подтверждены. Разница комиссий не равна чистой прибыли.' });
const partnerCommercialModel = terms => ({ contractCommissionPercent: terms.partnerCommissionPercent, label: 'Комиссия по договору с нами', status: 'calculation-unconfirmed', calculationBase: null, vatTreatment: null, expenseTreatment: null, reason: 'Указана договорная ставка, а не тариф площадки. База расчёта, НДС и порядок учёта расходов не подтверждены; начисление не рассчитано.' });
const finance = () => ({ revenue: null, contractCommission: null, advertising: null, logistics: null, returns: null, settlement: null, reason: 'Нет подтверждённых финансовых данных, привязанных к назначенным SKU, и согласованной базы расчёта. Начисления и расходы не рассчитаны.' });
function publicProduct(p) {
  return { key: p.key, name: text(p.name), offer_id: text(p.offer_id), sku: text(p.sku), storeName: text(p.storeName), market: 'Ozon', quantity: units(p.quantity), salesStatus: text(p.salesStatus), importedAt: text(p.importedAt) };
}
function publicPartner(p) {
  return { id: p.id, name: p.name, productKeys: [...p.productKeys], active: p.active, version: p.version, hasCredential: !!p.credentialHash, createdAt: p.createdAt, updatedAt: p.updatedAt };
}
module.exports = function createPartnerWorkspace({ privateDir, getProducts, getSales, now = () => Date.now() }) {
  if (!privateDir || typeof getProducts !== 'function') throw new TypeError('privateDir and getProducts are required');
  const file = path.join(privateDir, 'partner-workspace.json');
  function commercialTerms() {
    const unknown = { ourCommissionPercent: null, partnerCommissionPercent: null };
    try {
      const source = JSON.parse(fs.readFileSync(path.join(privateDir, 'partner-commercial-model.json'), 'utf8'));
      const rate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
      return { ourCommissionPercent: rate(source.ourCommissionPercent), partnerCommissionPercent: rate(source.partnerCommissionPercent) };
    } catch { return unknown; }
  }
  function read() {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw Error('Invalid storage');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ids = new Set();
      if (state.schema !== 1 || !Array.isArray(state.partners) || state.partners.length > 1000) throw Error('Invalid schema');
      for (const p of state.partners) {
        if (!p || typeof p.id !== 'string' || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || typeof p.active !== 'boolean' || !Number.isSafeInteger(p.version) || p.version < 1 || !Number.isSafeInteger(p.credentialVersion) || p.credentialVersion < 0 || !Array.isArray(p.productKeys) || p.productKeys.some(k => typeof k !== 'string') || (p.credentialHash !== null && !/^[a-f0-9]{64}$/.test(p.credentialHash))) throw Error('Invalid partner');
        ids.add(p.id);
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { schema: 1, partners: [] };
      fail('Хранилище партнёров недоступно. Доступ закрыт до восстановления.', 503);
    }
  }
  function mutate(fn) {
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const lock = file + '.lock';
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') fail('Хранилище занято. Повторите действие.', 409); throw error; }
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      const state = read(), result = fn(state);
      const out = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(out, JSON.stringify(state, null, 2)); fs.fsyncSync(out); } finally { fs.closeSync(out); }
      fs.renameSync(temporary, file);
      return result;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      fs.closeSync(fd); fs.unlinkSync(lock);
    }
  }
  function products() {
    const source = getProducts();
    if (!Array.isArray(source)) fail('Каталог временно недоступен.', 503);
    const seen = new Set();
    return source.filter(p => p && p.market === 'Ozon' && typeof p.key === 'string' && !seen.has(p.key) && seen.add(p.key));
  }
  function find(state, id, version) {
    const p = state.partners.find(p => p.id === id);
    if (!p) fail('Партнёр не найден.', 404);
    if (p.version !== version) fail('Данные партнёра изменились. Обновите страницу.', 409);
    return p;
  }
  function validKeys(keys) {
    if (!Array.isArray(keys) || keys.length > 3000 || keys.some(k => typeof k !== 'string' || !k || k.length > 300) || new Set(keys).size !== keys.length) fail('Проверьте список назначенных SKU.');
    const available = new Set(products().map(p => p.key));
    if (keys.some(k => !available.has(k))) fail('Назначать можно только существующие товары Ozon.');
  }
  function touch(p) { p.version++; p.updatedAt = new Date(now()).toISOString(); }
  function ownerState() {
    return { partners: read().partners.map(publicPartner), assignableProducts: products().map(publicProduct), commercialModel: ownerCommercialModel(commercialTerms()), capabilities: { externalAccess: false, marketplaceWrite: false, financialCalculation: false } };
  }
  function savePartner(input) {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160 || (input.active !== undefined && typeof input.active !== 'boolean')) fail('Укажите название партнёра до 160 символов и корректный статус.');
    validKeys(input.productKeys);
    return mutate(state => {
      let p;
      if (input.id !== undefined) { p = find(state, input.id, input.version); touch(p); }
      else {
        if (state.partners.length >= 1000) fail('Достигнут лимит партнёров.');
        const at = new Date(now()).toISOString();
        p = { id: crypto.randomUUID(), version: 1, credentialHash: null, credentialVersion: 0, active: false, createdAt: at, updatedAt: at }; state.partners.push(p);
      }
      p.name = input.name.trim(); p.productKeys = [...input.productKeys];
      if (input.active !== undefined) p.active = input.active;
      if (!p.active || !p.productKeys.length) { p.credentialHash = null; p.credentialVersion++; }
      return publicPartner(p);
    });
  }
  function issueCredential(input) {
    return mutate(state => {
      const p = find(state, input.id, input.version);
      if (!p.active || !p.productKeys.length) fail('Сначала включите партнёра и явно назначьте ему SKU.');
      validKeys(p.productKeys);
      const credential = crypto.randomBytes(32).toString('base64url');
      p.credentialHash = hash(credential); p.credentialVersion++; touch(p);
      return { partner: publicPartner(p), credential };
    });
  }
  function revokeCredential(input) {
    return mutate(state => { const p = find(state, input.id, input.version); p.credentialHash = null; p.credentialVersion++; touch(p); return publicPartner(p); });
  }
  function authenticateCredential(credential) {
    if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)) return null;
    const digest = Buffer.from(hash(credential), 'hex');
    const p = read().partners.find(p => p.active && p.productKeys.length && p.credentialHash && crypto.timingSafeEqual(Buffer.from(p.credentialHash, 'hex'), digest));
    return p ? { partnerId: p.id, credentialVersion: p.credentialVersion } : null;
  }
  function authorizeSession(session) {
    const p = read().partners.find(p => p.id === session?.partnerId);
    return !!(p && p.active && p.productKeys.length && p.credentialHash && p.credentialVersion === session.credentialVersion);
  }
  function snapshotForPartner(id) {
    const p = read().partners.find(p => p.id === id);
    if (!p || !p.active) fail('Доступ недоступен.', 401);
    const allowed = new Set(p.productKeys), selected = products().filter(p => allowed.has(p.key));
    let sales = [];
    try { if (getSales) sales = getSales(selected.map(p => p.key)); } catch { /* Unavailable sources stay unknown. */ }
    if (!Array.isArray(sales)) sales = [];
    const byKey = new Map();
    for (const row of sales) if (row && allowed.has(row.productKey)) {
      if (byKey.has(row.productKey)) byKey.set(row.productKey, null); else byKey.set(row.productKey, row);
    }
    return { partner: { id: p.id, name: p.name }, products: selected.map(product => {
      const s = byKey.get(product.key), period = s?.period;
      const valid = period && day(period.from) && day(period.to) && period.from <= period.to && typeof s.source === 'string' && s.source.length > 0;
      return { ...publicProduct(product), sales: { sold: valid ? units(s.sold) : null, returned: valid ? units(s.returned) : null, period: valid ? { from: period.from, to: period.to } : null, source: valid ? text(s.source) : null, reason: valid && units(s.sold) !== null && units(s.returned) !== null ? null : 'Нет полных подтверждённых данных продаж по этому SKU за указанный период.' }, finance: finance() };
    }), commercialModel: partnerCommercialModel(commercialTerms()), capabilities: { readOnly: true, externalAccess: false }, generatedAt: new Date(now()).toISOString() };
  }
  return { ownerState, savePartner, issueCredential, revokeCredential, authenticateCredential, authorizeSession, snapshotForPartner };
};
module.exports.PartnerError = PartnerError;
