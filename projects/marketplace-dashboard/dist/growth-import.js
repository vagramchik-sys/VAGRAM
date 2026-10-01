(function () {
'use strict';
const MAX_BYTES = 8 * 1024 * 1024, MAX_COMPETITORS = 50;
const clone = value => JSON.parse(JSON.stringify(value));
function captureContext(value) {
  const p = value?.selected?.product, watchlist = value?.watchlist || value?.selected?.watchlist;
  if (!p || !/^[0-9]{1,40}$/.test(String(p.storeId || '')) || !/^[0-9]{1,40}$/.test(String(p.id || '')) || !/^(0|[1-9][0-9]*)$/.test(watchlist?.revision || '') || !Array.isArray(watchlist?.competitors)) throw Error('Выберите товар и дождитесь загрузки списка конкурентов.');
  return {storeId: String(p.storeId), productId: String(p.id), name: String(p.name || p.id), revision: watchlist.revision,
    ownIds: [...new Set([p.id, p.sku, ...(Array.isArray(p.skus) ? p.skus : [])].filter(Boolean).map(String))], competitors: clone(watchlist.competitors)};
}
function sameContext(context, current) { return context.storeId === String(current?.selected?.product?.storeId) && context.productId === String(current?.selected?.product?.id); }
function confirmedPeriod({from = '', to = '', confirmed = false} = {}, observedAt) {
  if (!confirmed) return null;
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!date(from) || !date(to) || from > to || !Number.isFinite(Date.parse(observedAt)) || to > observedAt.slice(0, 10)) throw Error('Укажите и подтвердите точные даты периода отчёта; конец не может быть позже даты загрузки.');
  return {periodFrom: from, periodTo: to, observedAt: new Date(observedAt).toISOString()};
}
function canonicalRow(row) {
  let url; try { url = new URL(row.url); } catch { throw Error('В отчёте некорректная ссылка на товар.'); }
  const match = /^\/product\/(?:[^/]*-)?([0-9]{1,40})\/?$/.exec(url.pathname);
  if (!match || !['ozon.ru', 'www.ozon.ru'].includes(url.hostname) || url.protocol !== 'https:' || url.username || url.password || url.port || String(row.id) !== match[1]) throw Error('В отчёте некорректная карточка Ozon.');
  return {...row, id: match[1], url: `https://www.ozon.ru/product/${match[1]}/`};
}
function mergeRows(context, rows, selectedIds, period = null) {
  const selected = new Set(selectedIds.map(String)), own = new Set(context.ownIds), merged = new Map(context.competitors.filter(row => !own.has(String(row.id))).map(row => [String(row.id), clone(row)]));
  let included = 0;
  for (const raw of rows) {
    if (!selected.has(String(raw.id)) || own.has(String(raw.id))) continue;
    const row = canonicalRow(raw), prior = merged.get(row.id); included++;
    const value = prior || {id: row.id, name: String(row.name || '').trim(), url: row.url, matchStatus: 'candidate', matchNotes: '', unitCount: null, source: 'ozon_seller_analytics', metrics: null};
    if (!value.name || value.name.length > 300) throw Error('Название карточки пустое или слишком длинное.');
    if (period) {
      const h = row.historical || {}, nullable = (value, max, integer = false) => value === null || value === undefined ? null : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max && (!integer || Number.isSafeInteger(value)) ? value : null;
      value.metrics = {...period, averagePrice: nullable(h.averagePrice, 1e9), minimumPrice: nullable(h.minimumPrice, 1e9), orderedUnits: nullable(h.orderedUnits, 1e9, true), drrPct: nullable(h.drrPct, 10000)};
    }
    merged.set(row.id, value);
  }
  if (!included) throw Error('Выберите хотя бы одну карточку из отчёта, кроме своего товара.');
  if (merged.size > MAX_COMPETITORS) throw Error(`После объединения получится ${merged.size} карточек. Допустимо не более ${MAX_COMPETITORS}; снимите лишние отметки.`);
  return [...merged.values()];
}
function makePayload(context, rows, selectedIds, periodFields, observedAt, commandId) {
  return {storeId: context.storeId, productId: context.productId, expectedRevision: context.revision, commandId,
    competitors: mergeRows(context, rows, selectedIds, confirmedPeriod(periodFields, observedAt))};
}
function stableSubmission(holder, create) { if (!holder.payload) holder.payload = clone(create()); return clone(holder.payload); }
const exported = {captureContext, sameContext, confirmedPeriod, mergeRows, makePayload, stableSubmission, MAX_BYTES};
if (typeof module !== 'undefined' && module.exports) module.exports = exported;
if (typeof window === 'undefined' || typeof document === 'undefined') return;
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const button = (text, css = 'secondary') => { const node = el('button', 'growth-button ' + css, text); node.type = 'button'; return node; };
const field = (text, input) => { const label = el('label', '', text); label.append(input); return label; };
async function api(path, payload) {
  const response = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'}, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000)});
  let value; try { value = await response.json(); } catch { throw Error('Ответ неполный. Повторите сохранение с теми же данными.'); }
  if (!response.ok) throw Error(value?.error || value?.message || `Ошибка ${response.status}`);
  return value;
}
let activeDialog = null;
function openImport() {
  if (activeDialog) { activeDialog.focus(); return; }
  let context;
  try { context = captureContext(window.PultGrowth?.getContext?.()); }
  catch (error) { window.alert(error.message); return; }
  const dialog = el('dialog', 'evidence-dialog'), form = el('form'), header = el('header'), heading = el('div');
  dialog.setAttribute('aria-labelledby', 'growth-import-title');
  const title = el('h2', '', 'Импорт отчёта Ozon'); title.id = 'growth-import-title';
  heading.append(title, el('p', '', `${context.name} · магазин ${context.storeId} · товар ${context.productId}`));
  const close = button('Закрыть'); header.append(heading, close);
  const note = el('p', 'evidence-note', 'Карточки добавляются только в локальный список сравнения. Выберите аналоги вручную; новые карточки будут кандидатами, без подтверждения сопоставимости.');
  const fields = el('div', 'evidence-fields'), file = el('input'); file.type = 'file'; file.accept = '.xlsx,.csv,.tsv';
  const fileLabel = field('Отчёт «Товары на Ozon», до 8 МБ', file); fileLabel.className = 'wide'; fields.append(fileLabel);
  const previewButton = button('Прочитать отчёт'); fields.append(previewButton);
  const report = el('div', 'growth-observations'), periodFields = el('div', 'evidence-fields'), from = el('input'), to = el('input'); from.type = to.type = 'date';
  periodFields.append(field('Начало периода отчёта', from), field('Конец периода отчёта', to));
  const confirm = el('input'); confirm.type = 'checkbox';
  const confirmation = field('Подтверждаю точные даты отчёта и сохранение исторических метрик за этот период', confirm); confirmation.className = 'evidence-confirm';
  confirmation.prepend(confirm);
  const periodNote = el('p', 'evidence-note', 'Даты не определяются автоматически. Без подтверждённого периода добавятся только карточки; ранее сохранённые метрики останутся прежними. Цены отчёта не являются текущими ценами покупателей.');
  const search = el('input'); search.type = 'search'; search.placeholder = 'Название, SKU, продавец или бренд';
  const searchFields = el('div', 'evidence-fields'); const searchLabel = field('Найти карточки в отчёте', search); searchLabel.className = 'wide'; searchFields.append(searchLabel);
  const count = el('p', 'evidence-note'), tableWrap = el('div'); tableWrap.style.overflow = 'auto'; tableWrap.style.maxHeight = '360px';
  const table = el('table'); table.style.width = '100%'; table.style.fontSize = '12px'; table.style.borderCollapse = 'collapse'; const thead = el('thead'), tr = el('tr');
  for (const name of ['Выбор', 'Товар / SKU', 'Продавец / бренд', 'Средняя цена', 'Заказано', 'ДРР']) { const th = el('th', '', name); th.style.textAlign = 'left'; th.style.padding = '8px'; tr.append(th); }
  thead.append(tr); const tbody = el('tbody'); table.append(thead, tbody); tableWrap.append(table);
  const error = el('p', 'evidence-error'); error.setAttribute('role', 'status'); error.setAttribute('aria-live', 'polite');
  const footer = el('footer'), cancel = button('Отмена'), save = button('Добавить выбранные карточки', 'primary'); save.disabled = true;
  footer.append(cancel, save); form.append(header, note, fields, report, periodFields, confirmation, periodNote, searchFields, count, tableWrap, error, footer); dialog.append(form); document.body.append(dialog); activeDialog = dialog;
  let result = null, selected = new Set(), reading = false, saving = false, generation = 0;
  const submission = {};
  const stillCurrent = () => { if (!sameContext(context, window.PultGrowth?.getContext?.())) throw Error('Выбран другой товар или магазин. Закройте импорт и откройте его для нужного товара.'); };
  const closeDialog = () => { if (!saving) dialog.close(); };
  close.addEventListener('click', closeDialog); cancel.addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => { generation++; activeDialog = null; dialog.remove(); });
  form.addEventListener('submit', event => event.preventDefault());
  function render() {
    tbody.replaceChildren(); const query = search.value.trim().toLocaleLowerCase('ru'), rows = result?.rows || [], own = new Set(context.ownIds);
    const filtered = rows.filter(row => [row.name, row.id, row.seller, row.brand].some(value => String(value || '').toLocaleLowerCase('ru').includes(query)));
    count.textContent = `Выбрано: ${selected.size}. Найдено: ${filtered.length} из ${rows.length}. Показаны первые 100; уточните поиск для остальных.`;
    for (const row of filtered.slice(0, 100)) {
      const line = el('tr'), choice = el('input'); choice.type = 'checkbox'; choice.checked = selected.has(String(row.id)); choice.disabled = own.has(String(row.id)) || !!submission.payload;
      choice.setAttribute('aria-label', `Выбрать ${row.name}`); choice.addEventListener('change', () => { choice.checked ? selected.add(String(row.id)) : selected.delete(String(row.id)); render(); });
      const choose = el('td'); choose.append(choice); line.append(choose);
      const values = [`${row.name} · SKU ${row.id}${own.has(String(row.id)) ? ' · свой товар, исключён' : ''}`, [row.seller, row.brand].filter(Boolean).join(' / '), row.historical?.averagePrice ?? '—', row.historical?.orderedUnits ?? '—', row.historical?.drrPct ?? '—'];
      for (const value of values) line.append(el('td', '', String(value)));
      for (const cell of line.children) { cell.style.padding = '8px'; cell.style.borderBottom = '1px solid #e4e9f0'; }
      tbody.append(line);
    }
    save.disabled = !result || selected.size === 0 || saving || reading;
  }
  search.addEventListener('input', render);
  file.addEventListener('change', () => { if (submission.payload) return; generation++; result = null; selected.clear(); report.replaceChildren(); error.textContent = ''; render(); });
  previewButton.addEventListener('click', async () => {
    if (reading || submission.payload) return;
    error.textContent = '';
    try {
      stillCurrent(); const chosen = file.files?.[0], format = chosen?.name.split('.').pop().toLowerCase();
      if (!chosen || !['xlsx', 'csv', 'tsv'].includes(format)) throw Error('Выберите XLSX, CSV или TSV.');
      if (chosen.size > MAX_BYTES) throw Error('Файл должен быть не более 8 МБ.');
      reading = true; previewButton.disabled = true; render(); const token = ++generation;
      let payload;
      if (format === 'xlsx') { const bytes = new Uint8Array(await chosen.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768)); payload = {format, base64: btoa(binary)}; }
      else payload = {format, text: await chosen.text()};
      const response = await api('/api/growth/import/preview', payload);
      if (token !== generation || activeDialog !== dialog) return;
      stillCurrent(); result = response; const existing = new Set(context.competitors.map(row => String(row.id))), own = new Set(context.ownIds);
      selected = new Set(response.rows.filter(row => existing.has(String(row.id)) && !own.has(String(row.id))).map(row => String(row.id)));
      report.replaceChildren(); for (const row of Array.isArray(response.reportInfo) ? response.reportInfo : []) report.append(el('p', '', row.map(String).join(' · ')));
      report.append(el('p', 'evidence-note', response.message || 'Проверьте период отчёта вручную.')); from.value = ''; to.value = ''; confirm.checked = false; render();
    } catch (failure) { error.textContent = failure.message; }
    finally { reading = false; previewButton.disabled = !!submission.payload; render(); }
  });
  save.addEventListener('click', async () => {
    if (saving || !result) return;
    error.textContent = '';
    try {
      stillCurrent();
      const payload = stableSubmission(submission, () => makePayload(context, result.rows, [...selected], {from: from.value, to: to.value, confirmed: confirm.checked}, result.observedAt, crypto.randomUUID()));
      saving = true; for (const input of [file, from, to, confirm, previewButton, close, cancel]) input.disabled = true; render();
      await api('/api/growth/watchlist', payload);
      saving = false; dialog.close(); await window.PultGrowth?.reload?.();
    } catch (failure) { error.textContent = `${failure.message} При конфликте версии закройте импорт, обновите список и повторите выбор.`; }
    finally { saving = false; close.disabled = false; cancel.disabled = false; save.textContent = submission.payload ? 'Повторить то же сохранение' : 'Добавить выбранные карточки'; render(); }
  });
  render(); dialog.showModal();
}
document.addEventListener('click', event => { if (event.target.closest?.('#growth-import')) openImport(); });
window.PultGrowthImport = Object.freeze({open: openImport});
})();
