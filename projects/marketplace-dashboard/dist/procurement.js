'use strict';
const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
let state = null;
let requestItems = [];
let editingRequestId = null;
let editVersion = null;

async function api(url, body) {
  const options = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(url, options);
  let result;
  try { result = await response.json(); } catch { throw new Error('Сервер вернул непонятный ответ. Обновите страницу и повторите.'); }
  if (!response.ok) {
    const error = new Error(result.message || result.error || 'Не удалось выполнить запрос.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function showNotice(message, isError = false) {
  $('notice').textContent = message;
  $('notice').className = isError ? 'error' : 'success';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDate(value) {
  if (!value) return 'Дата неизвестна';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК';
}

function setBusy(button, busy) { button.disabled = busy; button.setAttribute('aria-busy', String(busy)); }

async function load() {
  setBusy($('refresh'), true);
  try {
    state = await api('/api/procurement');
    renderSaved();
    $('save-request').disabled = false;
    $('import-price').disabled = false;
    return true;
  } catch (error) {
    showNotice(error.message, true);
    return false;
  } finally { setBusy($('refresh'), false); }
}

function empty(text) { return element('div', 'empty', text); }

function renderSaved() {
  const requests = $('request-list');
  const lists = $('price-list');
  requests.replaceChildren(); lists.replaceChildren();
  if (!state.requests.length) requests.append(empty('Пока нет заявок. Разберите список выше и сохраните первую.'));
  for (const request of state.requests) {
    const card = element('article', 'data-card');
    const copy = element('div');
    copy.append(element('strong', '', request.title), element('small', '', `${nf.format(request.items.length)} позиций · ${formatDate(request.updatedAt || request.createdAt)}`));
    const actions = element('div', 'actions');
    const edit = element('button', 'button secondary', 'Изменить'); edit.type = 'button'; edit.dataset.editRequest = request.id;
    const compare = element('button', 'button', 'Сравнить'); compare.type = 'button'; compare.dataset.compareRequest = request.id;
    actions.append(edit, compare); card.append(copy, actions); requests.append(card);
  }
  if (!state.priceLists.length) lists.append(empty('Импортированных прайсов пока нет. Загрузите CSV/TSV или вставьте таблицу.'));
  for (const priceList of state.priceLists) {
    const card = element('article', 'data-card');
    const copy = element('div');
    copy.append(element('strong', '', priceList.supplierName), element('small', '', `${priceList.sourceName} · ${priceList.rows.length} строк · цены: ${priceList.priceDate || 'дата неизвестна'} · НДС: ${vatLabel(priceList.vatBasis)}`));
    card.append(copy); lists.append(card);
  }
}

function vatLabel(value) {
  return ({ included: 'включён', excluded: 'сверх цены', 'no-vat': 'без НДС', unknown: 'неизвестно' })[value] || 'неизвестно';
}

function renderRequestItems() {
  const tbody = $('request-items'); tbody.replaceChildren();
  requestItems.forEach((item, index) => {
    const row = document.createElement('tr');
    for (const [field, type, placeholder] of [['name', 'text', 'Наименование'], ['article', 'text', 'Артикул'], ['quantity', 'number', '—'], ['unit', 'text', 'шт']]) {
      const td = document.createElement('td'); const input = document.createElement('input');
      input.type = type; input.placeholder = placeholder; input.dataset.index = index; input.dataset.field = field;
      if (type === 'number') { input.min = '0'; input.step = 'any'; }
      input.value = item[field] ?? ''; td.append(input); row.append(td);
    }
    const td = document.createElement('td'); const remove = element('button', 'icon-button', '×');
    remove.type = 'button'; remove.dataset.removeItem = index; remove.setAttribute('aria-label', `Удалить строку ${index + 1}`); td.append(remove); row.append(td); tbody.append(row);
  });
  $('request-table-wrap').hidden = !requestItems.length;
}

function syncItem(input) {
  const item = requestItems[Number(input.dataset.index)]; if (!item) return;
  item[input.dataset.field] = input.dataset.field === 'quantity' ? (input.value === '' ? null : Number(input.value)) : input.value;
}

function updateRequestMode() {
  const request = editingRequestId && state ? state.requests.find(item => item.id === editingRequestId) : null;
  $('request-mode').textContent = request ? `Редактирование: ${request.title}` : 'Новая заявка';
  $('new-request').hidden = !editingRequestId;
}

function newRequest() {
  editingRequestId = null;
  editVersion = state?.version ?? null;
  requestItems = [];
  $('request-title').value = '';
  $('request-text').value = '';
  $('parse-warnings').replaceChildren();
  renderRequestItems();
  updateRequestMode();
  showNotice('Подготовлена новая заявка.');
  $('request-title').focus();
}

async function parseRequest() {
  const button = $('parse-request');
  if (!$('request-text').value.trim()) return showNotice('Вставьте список товаров для разбора.', true);
  setBusy(button, true);
  try {
    const result = await api('/api/procurement/parse', { text: $('request-text').value });
    requestItems = result.items || []; renderRequestItems();
    const warnings = $('parse-warnings'); warnings.replaceChildren();
    for (const warning of result.warnings || []) warnings.append(element('p', '', warning));
    showNotice(requestItems.length ? `Разобрано позиций: ${requestItems.length}. Проверьте таблицу перед сохранением.` : 'Не удалось выделить позиции. Добавьте строки вручную.', !requestItems.length);
  } catch (error) { showNotice(error.message, true); }
  finally { setBusy(button, false); }
}

async function saveRequest() {
  document.querySelectorAll('#request-items input').forEach(syncItem);
  const title = $('request-title').value.trim();
  if (!title) return showNotice('Укажите название заявки.', true);
  if (!requestItems.length || requestItems.some(item => !String(item.name || '').trim())) return showNotice('Добавьте хотя бы одну строку и заполните наименования.', true);
  if (requestItems.some(item => item.quantity !== null && (!Number.isFinite(item.quantity) || item.quantity <= 0))) return showNotice('Количество должно быть положительным числом или оставаться пустым.', true);
  const button = $('save-request'); setBusy(button, true);
  try {
    state = await api('/api/procurement/request', { version: editingRequestId ? editVersion : state.version, id: editingRequestId || undefined, title, items: requestItems });
    editingRequestId = state.id;
    editVersion = state.version;
    renderSaved(); updateRequestMode();
    showNotice('Заявка сохранена локально. Данные поставщикам не отправлялись.');
  } catch (error) {
    if (error.status === 409) showNotice('Данные изменились в другой вкладке. Введённый текст сохранён на экране: обновите данные и повторите сохранение после проверки.', true);
    else showNotice(error.message, true);
  } finally { setBusy(button, false); }
}

function editRequest(id) {
  const request = state.requests.find(item => item.id === id); if (!request) return;
  editingRequestId = request.id; editVersion = state.version; $('request-title').value = request.title;
  requestItems = request.items.map(item => ({ ...item })); renderRequestItems();
  $('request-text').value = ''; $('parse-warnings').replaceChildren();
  updateRequestMode();
  document.querySelector('.procurement-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showNotice('Заявка открыта для изменения. Исходные данные не изменятся до сохранения.');
}

async function readPriceFile() {
  const file = $('price-file').files[0];
  if (!file) return $('price-text').value;
  if (/\.xlsx?$/i.test(file.name)) throw new Error('XLS/XLSX не поддерживается. Сохраните файл из Excel как CSV и загрузите снова.');
  const buffer = await file.arrayBuffer();
  return new TextDecoder($('encoding').value).decode(buffer);
}

async function importPrice() {
  const supplierName = $('supplier-name').value.trim();
  if (!supplierName) return showNotice('Укажите название поставщика.', true);
  const button = $('import-price'); setBusy(button, true);
  try {
    const text = await readPriceFile();
    if (!text.trim()) throw new Error('Выберите файл CSV/TSV или вставьте содержимое прайса.');
    const file = $('price-file').files[0];
    state = await api('/api/procurement/import', { version: state.version, supplierName, sourceName: file ? file.name : 'Вставленный текст', text, priceDate: $('price-date').value || undefined, currency: $('currency').value, vatBasis: $('vat-basis').value });
    renderSaved(); showNotice('Прайс импортирован локально. Цены не проверялись на сайте поставщика.');
  } catch (error) {
    if (error.status === 409) showNotice('Данные изменились в другой вкладке. Форма не очищена: обновите данные и повторите импорт после проверки.', true);
    else showNotice(error.message, true);
  } finally { setBusy(button, false); }
}

async function compareRequest(id) {
  const button = document.querySelector(`[data-compare-request="${CSS.escape(id)}"]`); if (button) setBusy(button, true);
  try {
    const result = await api('/api/procurement/compare?id=' + encodeURIComponent(id));
    const request = state.requests.find(item => item.id === id);
    $('compare-title').textContent = request ? `Предложения: ${request.title}` : 'Предложения поставщиков';
    $('compare-warning').textContent = result.warning || 'Рейтинг не строится: проверьте единицы измерения, НДС, остаток и дату каждого предложения.';
    renderComparison(result.items || []); $('compare-panel').hidden = false;
    $('compare-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { showNotice(error.message, true); }
  finally { if (button) setBusy(button, false); }
}

function renderComparison(items) {
  const container = $('comparison'); container.replaceChildren();
  if (!items.length) return container.append(empty('В заявке нет позиций для сравнения.'));
  for (const item of items) {
    const section = element('section', 'compare-item'); const head = element('div', 'compare-item-head');
    const title = element('div'); title.append(element('strong', '', item.name || 'Без названия'), element('small', '', `Артикул: ${item.article || '—'} · Нужно: ${item.quantity ?? 'не указано'} ${item.unit || 'единица не указана'}`));
    const count = element('small', '', `Предложений: ${(item.offers || []).length}`); head.append(title, count); section.append(head);
    if (item.mixedConditions) section.append(element('p', 'condition-warning', 'У предложений различаются валюта, НДС или его ставка. Их нельзя напрямую ранжировать между собой.'));
    if (item.reason) section.append(element('p', 'condition-warning', item.reason));
    if (!(item.offers || []).length) section.append(empty('Совпадений нет. Проверьте кандидатов ниже или выполните ручной поиск.'));
    for (const offer of item.offers || []) section.append(renderOffer(offer));
    if ((item.candidates || []).length) {
      section.append(element('p', 'help', 'Возможные совпадения — требуется ручная проверка. Сохранение ручного сопоставления пока не поддерживается.'));
      for (const offer of item.candidates) section.append(renderOffer({ ...offer, needsManualReview: true }));
    }
    container.append(section);
  }
}

function renderOffer(offer) {
  const row = element('div', 'offer' + (offer.comparable ? ' comparable' : ''));
  const supplier = element('div'); supplier.append(element('strong', '', offer.supplierName || 'Поставщик не указан'), element('small', '', `${offer.name || 'Без названия'} · арт. ${offer.article || '—'}`));
  const price = element('div'); price.append(element('small', '', 'Цена'), element('strong', '', offer.price == null ? 'Не указана' : `${nf.format(offer.price)} ${offer.currency || 'RUB'} / ${offer.unit || '?'}`));
  const vatValue = offer.vatText ? `${vatLabel(offer.vatBasis)} · ${offer.vatText}` : vatLabel(offer.vatBasis);
  const vat = element('div'); vat.append(element('small', '', 'НДС'), element('span', '', vatValue));
  const stock = element('div'); stock.append(element('small', '', 'Остаток'), element('span', '', offer.stock == null ? 'Неизвестен' : nf.format(offer.stock)));
  const priceDate = offer.source?.priceDate ? `цены от ${offer.source.priceDate}` : 'дата цен неизвестна';
  const importedAt = offer.source?.importedAt ? `импорт ${formatDate(offer.source.importedAt)}` : 'дата импорта неизвестна';
  const sourceRow = Number.isSafeInteger(offer.source?.row) ? `строка ${offer.source.row}` : 'строка источника неизвестна';
  const reason = offer.reason || (offer.needsManualReview ? 'Совпадение требует ручной проверки.' : !offer.comparable ? 'Условия не позволяют прямое сравнение.' : '');
  const status = element('div'); status.append(element('span', 'tag', offer.comparable && !offer.needsManualReview ? 'Сопоставимо' : 'Не ранжировать'), element('small', '', `${offer.source?.sourceName || 'источник не указан'} · ${sourceRow} · ${priceDate} · ${importedAt}`));
  if (reason) status.append(element('small', '', reason));
  row.append(supplier, price, vat, stock, status); return row;
}

$('parse-request').addEventListener('click', parseRequest);
$('save-request').addEventListener('click', saveRequest);
$('new-request').addEventListener('click', newRequest);
$('add-item').addEventListener('click', () => { requestItems.push({ name: '', article: '', quantity: null, unit: '' }); renderRequestItems(); });
$('request-items').addEventListener('input', event => { if (event.target.matches('input')) syncItem(event.target); });
$('request-items').addEventListener('click', event => { const button = event.target.closest('[data-remove-item]'); if (!button) return; requestItems.splice(Number(button.dataset.removeItem), 1); renderRequestItems(); });
$('request-list').addEventListener('click', event => { const edit = event.target.closest('[data-edit-request]'); const compare = event.target.closest('[data-compare-request]'); if (edit) editRequest(edit.dataset.editRequest); if (compare) compareRequest(compare.dataset.compareRequest); });
$('price-file').addEventListener('change', () => { const file = $('price-file').files[0]; if (file && /\.xlsx?$/i.test(file.name)) showNotice('XLS/XLSX не поддерживается. Экспортируйте файл из Excel в CSV.', true); });
$('import-price').addEventListener('click', importPrice);
$('close-compare').addEventListener('click', () => { $('compare-panel').hidden = true; });
$('refresh').addEventListener('click', async () => { if (await load()) { editVersion = state.version; showNotice('Локальные заявки и прайс-листы обновлены. Несохранённые поля формы оставлены без изменений.'); } });
$('copy-query').addEventListener('click', async () => { const value = $('external-query').value.trim(); if (!value) return showNotice('Введите название или артикул для копирования.', true); try { await navigator.clipboard.writeText(value); showNotice('Запрос скопирован. Вставьте его в поиск на открытом сайте.'); } catch { $('external-query').select(); showNotice('Не удалось обратиться к буферу. Запрос выделен — скопируйте его вручную.', true); } });
$('save-request').disabled = $('import-price').disabled = true;
load().then(ok => { $('save-request').disabled = $('import-price').disabled = !ok; if (ok) editVersion = state.version; });
