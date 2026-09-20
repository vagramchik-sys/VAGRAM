'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const MAX_ROWS = 10000, MAX_HISTORY = 100000, MAX_FILE_BYTES = 32 * 1024 * 1024;
const STATUSES = ['executed', 'completed', 'pending', 'cancelled', 'refunded'];
const currencies = new Set(Intl.supportedValuesOf('currency')), scales = new Map();
class CharityError extends Error { constructor(message, status = 400) { super(message); this.status = status; this.public = true; } }
const fail = (message, status) => { throw new CharityError(message, status); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function text(value, name, maximum = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail('Проверьте поле «' + name + '».');
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}
const optional = (value, name, maximum) => value === undefined || value === null || value === '' ? null : text(value, name, maximum);
function only(input, names) { if (!object(input) || Object.keys(input).some(key => !names.includes(key))) fail('Неподдерживаемые поля в выгрузке.'); }
function currencyScale(currency) {
  if (!currencies.has(currency)) fail('Укажите поддерживаемый код валюты ISO 4217.');
  if (!scales.has(currency)) scales.set(currency, new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits);
  return scales.get(currency);
}
function decimal(minor, scale) {
  const raw = minor.toString().padStart(scale + 1, '0');
  return scale ? raw.slice(0, -scale) + '.' + raw.slice(-scale) : raw;
}
function amountOf(value, currency) {
  const scale = currencyScale(currency);
  if (typeof value !== 'string' || !/^\d{1,15}(?:\.\d{1,4})?$/.test(value.trim())) fail('Сумма должна быть положительной десятичной строкой, например "1250.50".');
  const [major, fraction = ''] = value.trim().split('.');
  if (fraction.length > scale) fail('Слишком много знаков после запятой для валюты ' + currency + '.');
  const minor = BigInt(major) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
  if (minor <= 0n || minor > 999999999999999n * 10n ** BigInt(scale)) fail('Сумма должна быть больше нуля и не превышать допустимый предел.');
  return { amount: decimal(minor, scale), minor: minor.toString(), scale };
}
function documentOf(value) {
  if (typeof value === 'string') value = /^https?:\/\//i.test(value) ? { url: value } : { label: value };
  only(value, ['url', 'label']);
  const result = {};
  if (value.label !== undefined) result.label = text(value.label, 'документ', 500);
  if (value.url !== undefined) {
    if (typeof value.url !== 'string' || value.url.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value.url)) fail('Некорректная ссылка на документ.');
    let url; try { url = new URL(value.url); } catch { fail('Некорректная ссылка на документ.'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) fail('Ссылка на документ должна использовать HTTP или HTTPS без логина и пароля.');
    result.url = url.href;
  }
  if (!Object.keys(result).length) fail('Укажите ссылку или название исходного документа.');
  return result;
}
function normalizeRecord(input) {
  only(input, ['date', 'programOrRecipient', 'amount', 'currency', 'status', 'sourceDocument', 'storeId', 'externalId']);
  if (!day(input.date)) fail('Дата операции должна быть существующей датой YYYY-MM-DD.');
  if (!STATUSES.includes(input.status)) fail('Неизвестный статус операции.');
  if (typeof input.currency !== 'string') fail('Укажите код валюты.');
  const currency = input.currency.trim().toUpperCase(), money = amountOf(input.amount, currency);
  return { date: input.date, programOrRecipient: text(input.programOrRecipient, 'программа или получатель', 500), amount: money.amount, currency, status: input.status, sourceDocument: documentOf(input.sourceDocument), storeId: optional(input.storeId, 'магазин', 200), externalId: optional(input.externalId, 'идентификатор операции', 300), minor: money.minor, scale: money.scale };
}
function metadata(input) {
  const source = text(input.source, 'источник выгрузки', 300);
  if (!(day(input.asOf) || typeof input.asOf === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.asOf) && day(input.asOf.slice(0, 10)) && Number.isFinite(Date.parse(input.asOf)))) fail('Укажите корректную дату или время актуальности выгрузки.');
  only(input.coverage, ['from', 'to', 'complete']);
  const { from, to, complete } = input.coverage;
  if (!day(from) || !day(to) || from > to || typeof complete !== 'boolean' || to > input.asOf.slice(0, 10)) fail('Проверьте период покрытия, полноту и дату актуальности выгрузки.');
  return { source, asOf: input.asOf, coverage: { from, to, complete } };
}
function publicRecord(record) {
  return { id: record.id, date: record.date, programOrRecipient: record.programOrRecipient, amount: record.amount, currency: record.currency, status: record.status, sourceDocument: structuredClone(record.sourceDocument), storeId: record.storeId, externalId: record.externalId, source: record.source, importId: record.importId };
}
function publicImport(value) {
  return { id: value.id, source: value.source, asOf: value.asOf, coverage: { ...value.coverage }, importedAt: value.importedAt, rowCount: value.rowCount, inserted: value.inserted, duplicates: value.duplicates };
}
function normalizedIdentity(record) {
  return { date: record.date, programOrRecipient: record.programOrRecipient.toLocaleLowerCase('ru-RU'), amount: record.amount, currency: record.currency, status: record.status, sourceDocument: { label: record.sourceDocument.label?.toLocaleLowerCase('ru-RU') || null, url: record.sourceDocument.url || null }, storeId: record.storeId };
}
const sourceKey = source => source.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
const recordKey = (source, record) => record.externalId ? digest([sourceKey(source), 'external', record.externalId]) : digest([sourceKey(source), 'fingerprint', normalizedIdentity(record)]);
function filtersOf(input = {}) {
  only(input, ['from', 'to', 'storeId', 'status']);
  const from = input.from || null, to = input.to || null, storeId = optional(input.storeId, 'магазин', 200), status = input.status || null;
  if (from && !day(from) || to && !day(to) || from && to && from > to) fail('Проверьте период фильтра.');
  if (status && !STATUSES.includes(status)) fail('Неизвестный статус фильтра.');
  return { from, to, storeId, status };
}
function coverageOf(imports, filters) {
  if (!imports.length) return { status: 'history-not-loaded', reason: 'История не загружена. Это не означает отсутствие пожертвований.', from: filters.from, to: filters.to, imports: [] };
  let from = filters.from || imports.reduce((v, i) => v < i.coverage.from ? v : i.coverage.from, imports[0].coverage.from);
  let to = filters.to || imports.reduce((v, i) => v > i.coverage.to ? v : i.coverage.to, imports[0].coverage.to);
  // A one-sided filter outside loaded history describes an uncovered day, never an inverted range.
  if (from > to) { if (filters.from && !filters.to) to = from; else if (filters.to && !filters.from) from = to; }
  const sources = new Set(imports.map(i => sourceKey(i.source)));
  const complete = [...sources].every(source => {
    const spans = imports.filter(i => sourceKey(i.source) === source && i.coverage.complete).map(i => i.coverage).sort((a, b) => a.from.localeCompare(b.from));
    let next = Date.parse(from), end = Date.parse(to);
    for (const span of spans) { const begin = Date.parse(span.from), finish = Date.parse(span.to); if (finish < next) continue; if (begin > next) return false; next = Math.max(next, finish + 86400000); if (next > end) return true; }
    return false;
  });
  return { status: complete ? 'complete' : 'partial', reason: complete ? 'По заявлению импортированных выгрузок период покрыт полностью для загруженных источников. Это не проверка всей истории вне этих источников.' : 'Покрытие выбранного периода неполное или не подтверждено. Итоги относятся только к загруженным операциям.', from, to, imports: imports.map(publicImport) };
}
module.exports = function createCharityWorkspace({ privateDir, now = () => Date.now() }) {
  if (!privateDir) throw new TypeError('privateDir required');
  const file = path.join(privateDir, 'charity.json'), empty = () => ({ schema: 1, version: 0, imports: [], records: [] });
  function readState() {
    try {
      const stat = fs.statSync(file); if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw Error('Storage limit');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.schema !== 1 || !Number.isSafeInteger(state.version) || state.version < 0 || !Array.isArray(state.records) || state.records.length > MAX_HISTORY || !Array.isArray(state.imports) || state.imports.length > 1000 || (state.records.length && !state.imports.length)) throw Error('Storage schema');
      const ids = new Set(), importIds = new Set(), keys = new Set();
      for (const entry of state.imports) {
        metadata(entry);
        if (typeof entry.id !== 'string' || importIds.has(entry.id) || !Array.isArray(entry.input?.records) || !Number.isSafeInteger(entry.rowCount) || !Number.isSafeInteger(entry.inserted) || !Number.isSafeInteger(entry.duplicates) || entry.rowCount < 0 || entry.inserted < 0 || entry.duplicates < 0 || entry.rowCount !== entry.inserted + entry.duplicates || typeof entry.digest !== 'string') throw Error('Import schema');
        importIds.add(entry.id);
      }
      for (const record of state.records) {
        const normalized = normalizeRecord({ date: record.date, programOrRecipient: record.programOrRecipient, amount: record.amount, currency: record.currency, status: record.status, sourceDocument: record.sourceDocument, storeId: record.storeId, externalId: record.externalId });
        const key = recordKey(text(record.source, 'источник выгрузки'), record);
        if (typeof record.id !== 'string' || ids.has(record.id) || keys.has(key) || !importIds.has(record.importId) || record.minor !== normalized.minor || record.scale !== normalized.scale || record.amount !== normalized.amount) throw Error('Record schema');
        ids.add(record.id); keys.add(key);
      }
      return state;
    } catch (error) { if (error.code === 'ENOENT') return empty(); fail('Хранилище благотворительности повреждено или недоступно. Данные не заменены.', 503); }
  }
  function snapshot(state, input) {
    const filters = filtersOf(input), records = state.records.filter(r => (!filters.from || r.date >= filters.from) && (!filters.to || r.date <= filters.to) && (!filters.storeId || r.storeId === filters.storeId) && (!filters.status || r.status === filters.status)).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    const counts = state.imports.length ? { records: records.length, confirmed: 0, pending: 0, cancelled: 0, refunded: 0 } : null, sums = new Map();
    for (const r of records) {
      if (!sums.has(r.currency)) sums.set(r.currency, { scale: r.scale, executed: 0n, completed: 0n, confirmed: 0n, pending: 0n, cancelled: 0n, refunded: 0n });
      const sum = sums.get(r.currency), amount = BigInt(r.minor); sum[r.status] += amount;
      if (r.status === 'executed' || r.status === 'completed') { sum.confirmed += amount; counts.confirmed++; } else counts[r.status]++;
    }
    const totalsByCurrency = [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, sums]) => ({ currency, ...Object.fromEntries(Object.entries(sums).filter(([key]) => key !== 'scale').map(([key, minor]) => [key, decimal(minor, sums.scale)])) }));
    return { version: state.version, state: state.imports.length ? 'loaded' : 'history-not-loaded', coverage: coverageOf(state.imports, filters), records: records.map(publicRecord), totalsByCurrency, counts, filters, capabilities: { payments: false, externalSync: false, import: true } };
  }
  function read(filters = {}) { return snapshot(readState(), filters); }
  function importRecords(input) {
    only(input, ['version', 'source', 'asOf', 'coverage', 'records']);
    if (!Number.isSafeInteger(input.version) || input.version < 0) fail('Укажите текущую версию истории.', 409);
    const meta = metadata(input);
    if (!Array.isArray(input.records) || input.records.length > MAX_ROWS) fail('Одна выгрузка должна содержать не более ' + MAX_ROWS + ' записей.');
    const normalized = input.records.map(normalizeRecord);
    if (normalized.some(row => row.date < meta.coverage.from || row.date > meta.coverage.to)) fail('Дата операции выходит за заявленный период выгрузки.');
    const rawInput = { source: input.source, asOf: input.asOf, coverage: structuredClone(input.coverage), records: structuredClone(input.records) };
    const inputDigest = digest(rawInput);
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const lock = file + '.lock'; let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') fail('Историю уже сохраняют. Повторите импорт.', 409); throw error; }
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      const state = readState();
      if (input.version !== state.version) fail('История изменилась. Обновите страницу перед импортом.', 409);
      const prior = state.imports.find(entry => entry.digest === inputDigest);
      if (prior) return { ...snapshot(state), importResult: { id: prior.id, inserted: 0, duplicates: normalized.length } };
      if (state.imports.length >= 1000) fail('Достигнут предел числа выгрузок.');
      const id = crypto.randomUUID(), known = new Map(state.records.map(r => [recordKey(r.source, r), r]));
      let inserted = 0, duplicates = 0;
      for (const record of normalized) {
        const key = recordKey(meta.source, record), existing = known.get(key);
        if (existing) {
          if (digest(normalizedIdentity(existing)) !== digest(normalizedIdentity(record))) fail('Операция с этим источником и внешним идентификатором уже загружена с другими данными. Импорт целиком отменён.', 409);
          duplicates++; continue;
        }
        const row = { ...record, id: crypto.randomUUID(), source: meta.source, importId: id }; known.set(key, row); state.records.push(row); inserted++;
      }
      if (state.records.length > MAX_HISTORY) fail('Достигнут предел размера истории.');
      state.imports.push({ ...meta, id, importedAt: new Date(now()).toISOString(), rowCount: normalized.length, inserted, duplicates, digest: inputDigest, input: rawInput }); state.version++;
      const serialized = JSON.stringify(state, null, 2); if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) fail('История превышает допустимый размер.');
      const out = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(out, serialized); fs.fsyncSync(out); } finally { fs.closeSync(out); }
      fs.renameSync(temporary, file);
      return { ...snapshot(state), importResult: { id, inserted, duplicates } };
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  return { read, importRecords };
};
module.exports.CharityError = CharityError;
module.exports.STATUSES = [...STATUSES];
