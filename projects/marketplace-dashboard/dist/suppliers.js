'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('ru-RU');
const quantity = value => value === null ? 'Неизвестно' : nf.format(value);
const matches = (product, query) => [product.name, product.article, product.sku, product.storeName].join(' ').toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU'));
let data = null, categoryId, portalId, categoryVersion, portalVersion, selectedProducts = new Set(), selectedCategories = new Set(), targets = {}, categoryLimit = 80, previewLimit = 80, currentPreview = null, previewRequest = 0;
async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let result; try { result = await response.json(); } catch { throw Error('Сервер недоступен. Обновите страницу.'); }
  if (!response.ok) throw Error(result.error || 'Не удалось выполнить запрос');
  return result;
}
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : 'success'; }
function empty(message) { return '<div class="supplier-empty">' + esc(message) + '</div>'; }
function productLabel(p) { return `<span>${esc(p.name || 'Без названия')}<small>${esc(p.market)} · ${esc(p.storeName)} · артикул: ${esc(p.article || '—')} · SKU: ${esc(p.sku || '—')}</small></span>`; }
async function load() {
  $('refresh').disabled = true;
  try { data = await api('/api/suppliers'); render(); return true; }
  catch (error) { notice(error.message, true); return false; }
  finally { $('refresh').disabled = false; }
}
function render() {
  $('new-category').disabled = false;
  const available = new Set(data.products.map(p => p.key));
  $('categories').innerHTML = data.categories.map(c => `<article class="supplier-card"><div><strong>${esc(c.name)}</strong><small>${nf.format(c.productKeys.filter(k => available.has(k)).length)} товаров в текущем каталоге${c.productKeys.some(k => !available.has(k)) ? ' · часть товаров сейчас недоступна' : ''}</small></div><button class="button secondary" type="button" data-category="${esc(c.id)}">Изменить</button></article>`).join('') || empty('Создайте первую категорию и выберите её товары.');
  $('portals').innerHTML = data.portals.map(p => `<article class="supplier-card"><div><strong>${esc(p.name)}</strong><small>Локальный черновик · ${p.categoryIds.map(id => esc(data.categories.find(c => c.id === id)?.name || 'Категория недоступна')).join(', ')}</small></div><div class="supplier-card-actions"><button class="button secondary" type="button" data-portal="${esc(p.id)}">Настроить</button><button class="button" type="button" data-preview="${esc(p.id)}">Просмотр</button></div></article>`).join('') || empty('После назначения категорий создайте отдельный кабинет для поставщика.');
  $('new-portal').disabled = !data.categories.length;
}
function openCategory(id) {
  if (!data) return;
  const category = data.categories.find(c => c.id === id);
  categoryId = category?.id; categoryVersion = data.version; selectedProducts = new Set(category?.productKeys || []); categoryLimit = 80;
  $('category-title').textContent = category ? 'Изменить категорию' : 'Новая категория';
  $('category-name').value = category?.name || ''; $('category-search').value = ''; $('category-error').textContent = '';
  renderCategoryProducts(); $('category-editor').showModal();
}
function renderCategoryProducts() {
  const assigned = new Map(data.categories.filter(c => c.id !== categoryId).flatMap(c => c.productKeys.map(key => [key, c.name])));
  const products = data.products.filter(p => matches(p, $('category-search').value));
  $('category-products').innerHTML = products.slice(0, categoryLimit).map(p => `<label class="supplier-product"><input type="checkbox" data-product="${esc(p.key)}" ${selectedProducts.has(p.key) ? 'checked' : ''} ${assigned.has(p.key) ? 'disabled' : ''}>${productLabel(p)}${assigned.has(p.key) ? `<small>Категория: ${esc(assigned.get(p.key))}</small>` : ''}</label>`).join('') || empty('Товары не найдены.');
  $('category-count').textContent = `Выбрано: ${nf.format(selectedProducts.size)} · найдено: ${nf.format(products.length)}`;
  $('category-more').hidden = products.length <= categoryLimit;
}
function openPortal(id) {
  if (!data) return;
  const portal = data.portals.find(p => p.id === id);
  portalId = portal?.id; portalVersion = data.version; selectedCategories = new Set(portal?.categoryIds || []); targets = structuredClone(portal?.targets || {});
  $('portal-title').textContent = portal ? 'Настроить кабинет' : 'Новый кабинет'; $('portal-name').value = portal?.name || ''; $('portal-error').textContent = '';
  $('portal-categories').innerHTML = data.categories.map(c => `<label class="supplier-check"><input type="checkbox" data-scope="${esc(c.id)}" ${selectedCategories.has(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('');
  $('portal-editor').showModal();
}
async function submitForm(event, type) {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    let body;
    if (type === 'category') body = { version: categoryVersion, id: categoryId, name: $('category-name').value, productKeys: [...selectedProducts] };
    else {
      const allowed = new Set(data.categories.filter(c => selectedCategories.has(c.id)).flatMap(c => c.productKeys));
      body = { version: portalVersion, id: portalId, name: $('portal-name').value, categoryIds: [...selectedCategories], targets: Object.fromEntries(Object.entries(targets).filter(([key]) => allowed.has(key))) };
    }
    await api('/api/suppliers/' + type, body);
    $(type + '-editor').close(); currentPreview = null; $('preview-panel').hidden = true;
    notice(type === 'category' ? 'Категория сохранена. Изменения сразу учитываются в назначенных кабинетах.' : 'Кабинет сохранён локально. Проверьте его предварительный просмотр.');
    await load();
  } catch (error) { $(type + '-error').textContent = error.message; }
  finally { button.disabled = false; }
}
async function openPreview(id) {
  const request = ++previewRequest; currentPreview = null; $('preview-panel').hidden = true;
  try {
    const next = await api('/api/suppliers/preview?id=' + encodeURIComponent(id)); if(request !== previewRequest)return; currentPreview = next; previewLimit = 80;
    $('preview-heading').textContent = currentPreview.name; $('preview-search').value = ''; $('need-only').checked = false; $('stock-view').value = 'total';
    const missing = currentPreview.missingProducts ? ` Не найдены в текущем каталоге: ${nf.format(currentPreview.missingProducts)}. Их остатки и потребность неизвестны.` : '';
    $('preview-summary').textContent = `Локальный просмотр · ${currentPreview.categories.join(', ')} · ${nf.format(currentPreview.rows.length)} товарных строк. Остатки из кабинетов маркетплейсов; строки разных магазинов не объединяются.${missing}`;
    renderPreview(); $('preview-panel').hidden = false; $('preview-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { if(request === previewRequest)notice(error.message, true); }
}
function renderPreview() {
  if (!currentPreview) return;
  const rows = currentPreview.rows.filter(p => matches(p, $('preview-search').value) && (!$('need-only').checked || p.need > 0));
  $('preview-rows').innerHTML = rows.slice(0, previewLimit).map(p => `<tr><td>${productLabel(p)}${p.forecast.reason ? '<small>' + esc(p.forecast.reason) + '</small>' : '<small>История: ' + esc(p.forecast.historyStart) + ' — ' + esc(p.forecast.historyEnd) + '</small>'}</td><td>${esc(p.category)}</td><td class="numeric">${quantity(p.stock)}</td><td class="numeric">${p.forecast.projectedUnits === null ? 'Не рассчитано' : nf.format(p.forecast.projectedUnits)}</td><td class="numeric">${p.need === null ? 'Не рассчитано' : nf.format(p.need)}</td><td>${p.importedAt ? esc(new Date(p.importedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })) + ' МСК' : 'Дата неизвестна'}</td></tr>${$('stock-view').value === 'warehouses' ? warehouseDetails(p) : ''}`).join('') || '<tr><td colspan="6">Нет товаров по выбранным условиям. Проверьте категории или измените поиск.</td></tr>';
  $('preview-more').hidden = rows.length <= previewLimit;
}
function warehouseDetails(product) {
  const detail = product.warehouseBreakdown;
  if (!detail) return '<tr class="supplier-warehouse-row"><td colspan="6">Разбивка по складам не загружена.</td></tr>';
  return `<tr class="supplier-warehouse-row"><td colspan="6"><div class="supplier-warehouse-heading">${esc(detail.description)}</div><dl class="supplier-warehouse-list">${detail.rows.map(row => `<div><dt>${esc(row.name)}${row.kind === 'type' ? ' · тип склада' : ''}</dt><dd>${quantity(row.stock)}</dd></div>`).join('')}</dl><small>${detail.totalMatches === true ? 'Сумма разбивки совпадает с общим остатком. ' : ''}Прогноз по отдельным складам не рассчитывается.</small></td></tr>`;
}
$('new-category').onclick = () => openCategory(); $('new-portal').onclick = () => openPortal();
$('categories').onclick = event => { const button = event.target.closest('[data-category]'); if (button) openCategory(button.dataset.category); };
$('portals').onclick = event => { const edit = event.target.closest('[data-portal]'), preview = event.target.closest('[data-preview]'); if (edit) openPortal(edit.dataset.portal); if (preview) openPreview(preview.dataset.preview); };
$('category-products').onchange = event => { const key = event.target.dataset.product; if (!key) return; event.target.checked ? selectedProducts.add(key) : selectedProducts.delete(key); $('category-count').textContent = 'Выбрано: ' + nf.format(selectedProducts.size); };
$('portal-categories').onchange = event => { const id = event.target.dataset.scope; if (!id) return; event.target.checked ? selectedCategories.add(id) : selectedCategories.delete(id);  };
$('category-search').oninput = () => { categoryLimit = 80; renderCategoryProducts(); };
$('category-more').onclick = () => { categoryLimit += 80; renderCategoryProducts(); };
$('preview-more').onclick = () => { previewLimit += 80; renderPreview(); };
$('preview-search').oninput = $('need-only').onchange = () => { previewLimit = 80; renderPreview(); };
$('stock-view').onchange = renderPreview;
$('category-form').onsubmit = event => submitForm(event, 'category'); $('portal-form').onsubmit = event => submitForm(event, 'portal');
$('close-preview').onclick = () => { $('preview-panel').hidden = true; currentPreview = null; };
$('refresh').onclick = async () => { currentPreview = null; $('preview-panel').hidden = true; if (await load()) notice('Локальные снимки и настройки перечитаны. Импорт с площадок выполняется по обычному расписанию.'); };
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
$('new-category').disabled = $('new-portal').disabled = true;
load().then(ok => { if (ok) $('new-category').disabled = false; });
