'use strict';

const {createOzonPerformanceTransport, OzonPerformanceError, HOST} = require('./ozon-performance-transport.cjs');

// Reviewed against https://docs.ozon.ru/api/performance/ on 2026-10-01.
// UpdateProducts deletes existing stop words/phrases. Its bid unit is not
// explicit in the current schema. Do not enable it through a UI-only toggle.
const CAPABILITIES = Object.freeze({
  budgetWrite: true,
  stateWrite: true,
  bidWrite: false,
  bidReadUnit: null,
  bidBlockedReason: 'Ozon предупреждает об удалении стоп-фраз при обновлении ставки. Запись ставок пока отключена.'
});
const numericId = value => {
  const id = String(value ?? '');
  if (!/^[1-9][0-9]*$/u.test(id)) throw new OzonPerformanceError('INVALID_ARGUMENT', 'Некорректный идентификатор Ozon.');
  return id;
};
function toMicroRubles(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100000000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001)
    throw new OzonPerformanceError('INVALID_ARGUMENT', 'Укажите положительную сумму в рублях, не более двух знаков после запятой.');
  return String(BigInt(Math.round(value * 100)) * 10000n);
}

function createOzonAdManagementTransport({getCredentials, fetchFn = globalThis.fetch, now = Date.now, timeoutMs = 20000, host = HOST, ...options} = {}) {
  if (typeof getCredentials !== 'function') throw new TypeError('getCredentials is required');
  const reader = createOzonPerformanceTransport({fetchFn, now, timeoutMs, host, ...options});
  async function input(storeId) {
    storeId = numericId(storeId);
    const value = await getCredentials(storeId);
    if (!value || String(value.storeId) !== storeId) throw new OzonPerformanceError('MISSING_CREDENTIALS', 'Подключите Ozon Performance API для этого магазина.');
    return value;
  }
  async function mutate(storeId, campaignId, kind, body) {
    campaignId = numericId(campaignId);
    const value = await input(storeId);
    // A token failure happens before dispatch. Label it so the durable caller
    // can distinguish a rejected command from an uncertain network outcome.
    let token;
    try { token = await reader.acquireToken(value); }
    catch (error) { throw new OzonPerformanceError('MUTATION_REJECTED', 'Не удалось авторизовать изменение в Ozon.', {status: error?.status}); }
    const suffix = kind === 'budget' ? '' : kind === 'activate' ? '/activate' : '/deactivate';
    let response;
    try {
      response = await fetchFn(`${host}/api/client/campaign/${campaignId}${suffix}`, {
        method: kind === 'budget' ? 'PATCH' : 'POST', redirect: 'error',
        headers: {Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new OzonPerformanceError('WRITE_OUTCOME_UNKNOWN', 'Связь с Ozon прервалась. Сначала проверьте результат изменения.');
    }
    // No write retries, including 401, 429, 5xx. The caller re-reads the
    // campaign after success and persists uncertain outcomes before retrying.
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) reader.invalidate(value.storeId);
    if (response.status >= 500 || response.status === 408)
      throw new OzonPerformanceError('WRITE_OUTCOME_UNKNOWN', 'Ozon не подтвердил результат изменения. Нужна проверка.', {status: response.status});
    if (!response.ok)
      throw new OzonPerformanceError('MUTATION_REJECTED', 'Ozon отклонил изменение. Проверьте параметры и состояние кампании.', {status: response.status});
    return {accepted: true};
  }
  return Object.freeze({
    capabilities: CAPABILITIES,
    getManagementCapabilities: () => CAPABILITIES,
    listCampaigns: async storeId => reader.listCampaigns(await input(storeId)),
    listCampaignProducts: async (storeId, campaignId) => reader.listCampaignProducts(await input(storeId), numericId(campaignId)),
    updateWeeklyBudget: (storeId, campaignId, weeklyBudgetRub) => mutate(storeId, campaignId, 'budget', {weeklyBudget: toMicroRubles(weeklyBudgetRub)}),
    setCampaignActive: (storeId, campaignId, active) => {
      if (typeof active !== 'boolean') throw new OzonPerformanceError('INVALID_ARGUMENT', 'Укажите состояние кампании.');
      return mutate(storeId, campaignId, active ? 'activate' : 'deactivate', {});
    },
    updateProductBid: async () => { throw new OzonPerformanceError('BID_WRITE_DISABLED', CAPABILITIES.bidBlockedReason); }
  });
}

module.exports = {createOzonAdManagementTransport, CAPABILITIES, toMicroRubles};
