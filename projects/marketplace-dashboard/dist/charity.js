'use strict';
const $ = id => document.getElementById(id);
const statusLabels = { completed: 'Завершено', executed: 'Исполнено', pending: 'Ожидает', cancelled: 'Отменено', refunded: 'Возвращено' };
const confirmedStatuses = new Set(['completed', 'executed']);
const knownStores = new Set();
let state = null;
let previewPayload = null;

async function api(url, body) {
  const options = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(url, options);
  let result = {};
  try { result = await response.json(); } catch { throw new Error('Сервер вернул непонятный ответ. Обновите страницу и повторите.'); }
  if (!response.ok) { const error = new Error(result.error || 'Не удалось выполнить запрос.'); error.status = response.status; throw error; }
  return result;
}
function node(tag, className, text) { const result = document.createElement(tag); if (className) result.className = className; if (text !== undefined) result.textContent = text; return result; }
function formatDate(value, withTime = false) {
  if (!value) return 'Не указано';
  const date = new Date(withTime ? value : `${value}T00:00:00`);
  if (Number.isNaN(date.valueOf())) return String(value);
  return date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'medium', ...(withTime ? { timeStyle: 'short' } : {}) }) + (withTime ? ' МСК' : '');
}
function formatAmount(value, currency) {
  const number = Number(value);
  if (!Number.isFinite(number)) return `${value} ${currency}`;
  try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency }).format(number); }
  catch { return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)} ${currency}`; }
}
function showNotice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; }
function queryUrl() {
  const params = new URLSearchParams();
  if ($('filter-from').value) params.set('from', $('filter-from').value);
  if ($('filter-to').value) params.set('to', $('filter-to').value);
  if ($('filter-store').value) params.set('store', $('filter-store').value);
  if ($('filter-status').value) params.set('status', $('filter-status').value);
  return `/api/charity${params.size ? `?${params}` : ''}`;
}
async function load({ quiet = false } = {}) {
  $('refresh').disabled = true; $('apply-filters').disabled = true;
  try { state = await api(queryUrl()); render(); if (!quiet) showNotice('История обновлена.'); return true; }
  catch (error) { showNotice(error.message, true); return false; }
  finally { $('refresh').disabled = false; $('apply-filters').disabled = false; }
}
function render() {
  for (const record of state.records || []) if (record.storeId) knownStores.add(record.storeId);
  document.querySelector('.import-panel').hidden = state.capabilities?.import !== true;
  renderStoreOptions(); renderScope(); renderCounts(); renderTotals(); renderHistory();
}
function renderStoreOptions() {
  const select = $('filter-store'); const selected = select.value; select.replaceChildren(new Option('Все магазины', ''));
  for (const store of [...knownStores].sort((a, b) => a.localeCompare(b, 'ru'))) select.append(new Option(store, store));
  select.value = selected;
}
function scopeItem(label, value, wide = false) { const item = node('div', `scope-item${wide ? ' wide' : ''}`); item.append(node('span', '', label), node('strong', '', value)); return item; }
function renderScope() {
  const target = $('scope-details'); target.replaceChildren(); const coverage = state.coverage || {}; const imports = coverage.imports || [];
  if (state.state === 'history-not-loaded') {
    target.append(scopeItem('Состояние', 'История ещё не загружена'), scopeItem('Охват', coverage.reason || 'Неизвестен'), scopeItem('Свежесть', 'Нет подтверждённой выгрузки'));
    return;
  }
  const latest = [...imports].sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')))[0];
  const complete = coverage.status === 'complete' ? 'Полный охват' : coverage.status === 'partial' ? 'Частичный охват' : 'Охват не определён';
  target.append(scopeItem('Состояние', complete), scopeItem('Данные на дату', latest?.asOf ? formatDate(latest.asOf) : 'Не указано'), scopeItem('Загружено', latest?.importedAt ? formatDate(latest.importedAt, true) : 'Не указано'));
  const coverageFrom = coverage.from || latest?.coverage?.from, coverageTo = coverage.to || latest?.coverage?.to;
  const period = coverageFrom || coverageTo ? `${formatDate(coverageFrom)} — ${formatDate(coverageTo)}` : 'Период не указан';
  target.append(scopeItem('Загруженные источники и период', `${imports.length} выгрузок · ${period} · последний источник: ${latest?.source || 'не указан'}`, true));
  if (coverage.reason) target.append(scopeItem('Ограничение', coverage.reason, true));
}
function totalCard(total) {
  const card = node('article', 'currency-total'); const header = node('header'); header.append(node('span', '', total.currency), node('small', '', 'Завершено + исполнено'));
  card.append(header, node('strong', '', formatAmount(total.confirmed, total.currency)));
  const breakdown = node('div', 'status-breakdown');
  for (const [key, label] of [['pending', 'Ожидает'], ['cancelled', 'Отменено'], ['refunded', 'Возвращено']]) { const item = node('div'); item.append(node('span', '', label), node('b', '', formatAmount(total[key] || '0.00', total.currency))); breakdown.append(item); }
  card.append(breakdown); return card;
}
function renderCounts() {
  const target = $('status-counts'); target.replaceChildren();
  if (!state.counts) return;
  for (const [key, label] of [['confirmed', 'Подтверждено'], ['pending', 'Ожидает'], ['cancelled', 'Отменено'], ['refunded', 'Возвращено']]) {
    const card = node('article', 'currency-total'); const header = node('header'); header.append(node('span', '', label)); card.append(header, node('strong', '', String(state.counts[key] || 0)), node('small', '', 'операций')); target.append(card);
  }
}
function renderTotals() {
  const target = $('totals'); target.replaceChildren();
  if (!(state.totalsByCurrency || []).length) { target.append(node('div', 'totals-empty', state.state === 'history-not-loaded' ? 'Итоги появятся после загрузки истории.' : 'Для выбранных условий подтверждённых сумм нет.')); return; }
  for (const total of state.totalsByCurrency) target.append(totalCard(total));
}
function sourceContent(record) {
  const wrapper = document.createDocumentFragment(); const documentInfo = record.sourceDocument || {}; const safeUrl = safeHttpUrl(documentInfo.url);
  if (safeUrl) { const link = node('a', '', documentInfo.label || 'Открыть документ'); link.href = safeUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; wrapper.append(link); }
  else wrapper.append(document.createTextNode(documentInfo.label || 'Документ не указан'));
  if (record.source) wrapper.append(node('small', '', record.source)); return wrapper;
}
function safeHttpUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password && !/[\s\\\u0000-\u001f\u007f]/.test(value) ? url.href : ''; } catch { return ''; } }
function renderHistory() {
  const tbody = $('history-rows'); const empty = $('history-empty'); const records = state.records || []; tbody.replaceChildren();
  $('record-count').textContent = state.counts ? `${state.counts.records} операций` : '';
  for (const record of records) {
    const row = document.createElement('tr'); const statusClass = confirmedStatuses.has(record.status) ? 'confirmed' : record.status;
    const amount = node('strong', 'amount', formatAmount(record.amount, record.currency));
    const amountCell = document.createElement('td'); amountCell.append(amount, node('small', '', record.currency));
    const cells = [document.createElement('td'), document.createElement('td'), amountCell, document.createElement('td'), document.createElement('td'), document.createElement('td')];
    cells[0].textContent = formatDate(record.date); cells[1].textContent = record.programOrRecipient; cells[3].append(node('span', `status-badge ${statusClass}`, statusLabels[record.status] || record.status)); cells[4].append(sourceContent(record)); cells[5].textContent = record.storeId || 'Не указан'; row.append(...cells); tbody.append(row);
  }
  empty.hidden = records.length > 0; document.querySelector('.history-panel .table-wrap').hidden = records.length === 0;
  if (!records.length) empty.textContent = state.state === 'history-not-loaded' ? 'История ещё не загружена' : 'По выбранным условиям операций нет.';
}
function invalidatePreview() { previewPayload = null; $('confirm-import').disabled = true; $('import-preview').hidden = true; $('import-message').textContent = ''; $('import-message').className = ''; }
function importMetadata() {
  const source = $('import-source').value.trim(), asOf = $('import-as-of').value, from = $('coverage-from').value, to = $('coverage-to').value;
  if (!source) throw new Error('Укажите источник выгрузки.');
  if (!asOf) throw new Error('Укажите дату снимка данных.');
  if (!from || !to) throw new Error('Укажите начало и конец охвата.');
  if (from > to) throw new Error('Начало охвата не может быть позже конца.');
  if (to > asOf) throw new Error('Конец охвата не может быть позже даты снимка.');
  return { source, asOf, coverage: { from, to, complete: $('coverage-complete').checked } };
}
function parseRecords() {
  let parsed; try { parsed = JSON.parse($('import-text').value); } catch { throw new Error('JSON не удалось прочитать. Проверьте кавычки, запятые и скобки.'); }
  const records = Array.isArray(parsed) ? parsed : parsed && parsed.records;
  if (!Array.isArray(records) || !records.length) throw new Error('В JSON нужен непустой массив records.');
  return records;
}
function validDay(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value; }
function currencyScale(currency) { try { if (Intl.supportedValuesOf && !Intl.supportedValuesOf('currency').includes(currency)) return null; return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch { return null; } }
function validateRecords(records, coverage) {
  const errors = [];
  if (records.length > 10000) errors.push('Одна выгрузка не может содержать более 10 000 записей.');
  records.forEach((record, index) => {
    const prefix = `Строка ${index + 1}`;
    if (!record || typeof record !== 'object' || Array.isArray(record)) { errors.push(`${prefix}: ожидается объект.`); return; }
    const allowed = ['date', 'programOrRecipient', 'amount', 'currency', 'status', 'sourceDocument', 'storeId', 'externalId'];
    if (Object.keys(record).some(key => !allowed.includes(key))) errors.push(`${prefix}: есть неподдерживаемые поля.`);
    if (!validDay(record.date)) errors.push(`${prefix}: дата должна быть существующей датой YYYY-MM-DD.`);
    else if (coverage && (record.date < coverage.from || record.date > coverage.to)) errors.push(`${prefix}: дата выходит за заявленный период выгрузки.`);
    if (typeof record.programOrRecipient !== 'string' || !record.programOrRecipient.trim()) errors.push(`${prefix}: укажите программу или получателя.`);
    const scale = typeof record.currency === 'string' && /^[A-Z]{3}$/.test(record.currency) ? currencyScale(record.currency) : null;
    if (scale === null) errors.push(`${prefix}: currency должен быть поддерживаемым трёхбуквенным кодом ISO 4217.`);
    if (typeof record.amount !== 'string' || !/^\d{1,15}(?:\.\d{1,4})?$/.test(record.amount) || Number(record.amount) <= 0 || scale !== null && (record.amount.split('.')[1] || '').length > scale) errors.push(`${prefix}: amount должен быть положительной десятичной строкой с допустимым числом знаков для валюты.`);
    if (!Object.hasOwn(statusLabels, record.status)) errors.push(`${prefix}: неизвестный статус.`);
    if (!record.sourceDocument || typeof record.sourceDocument !== 'object' || (!String(record.sourceDocument.label || '').trim() && !safeHttpUrl(record.sourceDocument.url))) errors.push(`${prefix}: укажите label или безопасную http(s)-ссылку документа.`);
    if (record.sourceDocument?.url && !safeHttpUrl(record.sourceDocument.url)) errors.push(`${prefix}: ссылка документа должна использовать http или https.`);
  });
  return errors;
}
function renderPreview(payload, errors = []) {
  const target = $('import-preview'); target.replaceChildren(); target.hidden = false;
  target.append(node('h3', '', errors.length ? 'JSON требует исправлений' : 'Выгрузка готова к импорту'));
  target.append(node('p', errors.length ? 'Запись не выполнялась.' : `${payload.records.length} записей · источник: ${payload.source} · данные на ${formatDate(payload.asOf)}`));
  if (errors.length) { const list = node('p', 'preview-errors', errors.slice(0, 8).join(' ')); target.append(list); if (errors.length > 8) target.append(node('p', 'preview-errors', `И ещё ошибок: ${errors.length - 8}.`)); return; }
  const totals = new Map(); for (const record of payload.records) totals.set(record.currency, (totals.get(record.currency) || 0) + Number(record.amount));
  target.append(node('p', '', `Период: ${formatDate(payload.coverage.from)} — ${formatDate(payload.coverage.to)} · ${payload.coverage.complete ? 'полная' : 'частичная'} выгрузка.`));
  const sample = node('div', 'preview-sample'); sample.append(node('strong', '', 'Контрольные суммы всех статусов в файле'));
  for (const [currency, amount] of totals) sample.append(node('span', '', `${currency}: ${formatAmount(amount.toFixed(2), currency)}`)); target.append(sample);
}
function previewImport() {
  $('import-message').textContent = ''; $('import-message').className = '';
  try {
    const metadata = importMetadata(), records = parseRecords(), payload = { version: state?.version, ...metadata, records }; const errors = validateRecords(records, metadata.coverage);
    renderPreview(payload, errors); previewPayload = errors.length ? null : payload; $('confirm-import').disabled = errors.length > 0;
  } catch (error) { previewPayload = null; $('confirm-import').disabled = true; renderPreview({ records: [], source: '' }, [error.message]); }
}
async function confirmImport() {
  if (!previewPayload) return; const button = $('confirm-import'); button.disabled = true; $('preview-import').disabled = true;
  try {
    const result = await api('/api/charity/import', previewPayload); previewPayload = null; state = result; render(); await load({ quiet: true }); $('import-message').textContent = `Импорт завершён: добавлено ${result.importResult?.inserted ?? 0}, дубликатов ${result.importResult?.duplicates ?? 0}.`; $('import-message').className = ''; $('import-preview').hidden = true; $('import-text').value = ''; $('import-file').value = '';
  } catch (error) { $('import-message').textContent = error.status === 409 ? `${error.message} Обновите историю, снова проверьте JSON и повторите импорт.` : error.message; $('import-message').className = 'error'; }
  finally { $('preview-import').disabled = false; $('confirm-import').disabled = true; }
}
$('refresh').onclick = () => load(); $('apply-filters').onclick = () => load();
$('reset-filters').onclick = () => { for (const id of ['filter-from', 'filter-to', 'filter-store', 'filter-status']) $(id).value = ''; load(); };
$('preview-import').onclick = previewImport; $('confirm-import').onclick = confirmImport;
$('import-file').onchange = async event => { invalidatePreview(); const file = event.target.files[0]; if (!file) return; if (file.size > 8 * 1024 * 1024) { $('import-message').textContent = 'JSON-файл превышает допустимые 8 МБ.'; $('import-message').className = 'error'; return; } try { $('import-text').value = await file.text(); } catch { $('import-message').textContent = 'Файл не удалось прочитать.'; $('import-message').className = 'error'; } };
for (const id of ['import-source', 'import-as-of', 'coverage-from', 'coverage-to', 'coverage-complete', 'import-text']) $(id).addEventListener(id === 'coverage-complete' ? 'change' : 'input', invalidatePreview);
window.CharityUI = { formatAmount, safeHttpUrl, validateRecords };
load({ quiet: true });
