'use strict';
const { summarize } = require('../../wb-report.cjs');
function period(from, to) { const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; if (!valid(from) || !valid(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 >= 90) throw Error('Проверьте даты периода WB (не больше 90 дней)'); return { from, to }; }
module.exports = function createPostgresWbEconomics({ getStores, getSnapshot, getWbLink, compare } = {}) {
  if ([getStores, getSnapshot, getWbLink, compare].some(value => typeof value !== 'function')) throw new TypeError('explicit SQL providers are required');
  async function read({ from, to, storeId } = {}) {
    const dates = period(from, to), [stores, link] = await Promise.all([getStores(), getWbLink()]); if (!stores || typeof stores !== 'object' || Array.isArray(stores)) throw Error('Некорректный каталог магазинов SQL');
    const selected = Object.entries(stores).filter(([id, store]) => store.market === 'WB' && (!storeId || id === storeId)); if (selected.length !== 1) throw Error('Выберите один подключённый магазин WB');
    const [id, store] = selected[0], raw = await getSnapshot(id), direct = raw ? summarize(raw, dates) : null, linked = link?.storeId === id && Number.isSafeInteger(link.accountId) && link.accountId > 0;
    const truestats = linked ? await compare({ period: dates, market: 'WB', stores: [{ id, name: store.name, market: 'WB', trueStatsAccountId: link.accountId }] }) : { status: 'unavailable', reason: 'Магазин WB ещё не сопоставлен с кабинетом TrueStats.', metrics: {} };
    return { store: { id, name: store.name }, period: dates, direct, truestats, refresh: { intervalMinutes: 30 }, job: store.job || null };
  }
  return Object.freeze({ read });
};
module.exports.period = period;
