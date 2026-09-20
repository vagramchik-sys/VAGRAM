'use strict';
const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('ru-RU');
let state = null, editingId = null, editingVersion = null, selected = new Set();

async function api(url, body) {
  const options = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(url, options); let result;
  try { result = await response.json(); } catch { throw Error('Сервер вернул непонятный ответ. Обновите страницу.'); }
  if (!response.ok) { const error = Error(result.error || 'Не удалось выполнить запрос.'); error.status = response.status; throw error; }
  return result;
}
function node(tag, className, text) { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; }
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : 'success'; }
function busy(button, value) { button.disabled = value; button.setAttribute('aria-busy', String(value)); }
function date(value) { if (!value) return 'дата неизвестна'; const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? String(value) : parsed.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК'; }
function empty(text) { return node('div', 'empty', text); }

async function load() {
  busy($('refresh'), true);
  try { state = await api('/api/partners/state'); render(); $('new-partner').disabled = false; return true; }
  catch (error) { notice(error.message, true); return false; }
  finally { busy($('refresh'), false); }
}
function render() {
  const partnerRate = state.commercialModel?.partnerCommissionPercent;
  const ownerRate = state.commercialModel?.ourCommissionPercent;
  const target = state.commercialModel?.targetDifferencePercentagePoints;
  $('partner-rate').textContent = Number.isFinite(partnerRate) ? `${partnerRate}%` : 'не задано';
  $('owner-rate').textContent = Number.isFinite(ownerRate) ? `${ownerRate}%` : 'не задано';
  $('target-difference').textContent = Number.isFinite(target) ? `${target} п.п.` : 'не задан';
  if (state.commercialModel?.reason) $('model-missing').textContent = state.commercialModel.reason;
  const list = $('partner-list'); list.replaceChildren();
  if (!state.partners.length) return list.append(empty('Партнёры ещё не настроены. Создайте пустой кабинет и назначьте конкретные товары Ozon.'));
  for (const partner of state.partners) {
    const card = node('article', 'partner-card'); const info = node('div'); info.append(node('strong', '', partner.name));
    info.append(node('small', '', `${nf.format(partner.productKeys.length)} назначенных товаров · обновлено ${date(partner.updatedAt)}`));
    info.append(node('span', 'status-pill' + (partner.active ? ' active' : ''), partner.active ? 'Активен' : 'Выключен'));
    if (partner.hasCredential) info.append(node('span', 'status-pill credential', 'Доступ выпущен'));
    const actions = node('div', 'partner-actions');
    const edit = node('button', 'button secondary', 'Настроить'); edit.type = 'button'; edit.dataset.edit = partner.id; actions.append(edit);
    if (partner.hasCredential) { const revoke = node('button', 'button secondary', 'Отозвать доступ'); revoke.type = 'button'; revoke.dataset.revoke = partner.id; actions.append(revoke); }
    else { const issue = node('button', 'button', 'Создать код входа'); issue.type = 'button'; issue.dataset.issue = partner.id; issue.disabled = !partner.active || !partner.productKeys.length; actions.append(issue); }
    card.append(info, actions); list.append(card);
  }
}
function matches(product, query) { return [product.name, product.offer_id, product.sku, product.storeName].join(' ').toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU')); }
function renderProducts() {
  const list = $('product-list'), products = state.assignableProducts.filter(item => matches(item, $('product-search').value)); list.replaceChildren();
  for (const product of products) {
    const label = node('label', 'product-option'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(product.key); input.dataset.product = product.key;
    const copy = node('span'); copy.append(node('strong', '', product.name || 'Без названия'), node('small', '', `Ozon · ${product.storeName || 'магазин не указан'} · offer ID: ${product.offer_id || '—'} · SKU: ${product.sku || '—'} · остаток: ${product.quantity ?? 'неизвестен'}`));
    label.append(input, copy); list.append(label);
  }
  if (!products.length) list.append(empty(state.assignableProducts.length ? 'По выбранному запросу товары не найдены.' : 'Нет доступных товаров Ozon. Сначала загрузите каталог и остатки магазина.'));
  $('selection-count').textContent = `Выбрано: ${nf.format(selected.size)}`;
}
function openEditor(id) {
  const partner = id ? state.partners.find(item => item.id === id) : null;
  editingId = partner?.id || null; editingVersion = partner?.version; selected = new Set(partner?.productKeys || []);
  $('editor-title').textContent = partner ? 'Настроить кабинет' : 'Новый кабинет'; $('partner-name').value = partner?.name || ''; $('partner-active').checked = partner?.active || false; $('product-search').value = ''; $('editor-error').textContent = '';
  renderProducts(); $('partner-editor').showModal();
}
async function save(event) {
  event.preventDefault(); const button = event.currentTarget.querySelector('[type=submit]'); busy(button, true);
  try {
    const saved = await api('/api/partners/save', { id: editingId || undefined, version: editingVersion, name: $('partner-name').value, productKeys: [...selected], active: $('partner-active').checked });
    const index = state.partners.findIndex(item => item.id === saved.id); if (index < 0) state.partners.push(saved); else state.partners[index] = saved;
    $('partner-editor').close(); render(); notice('Настройки кабинета сохранены. Доступ партнёру не отправлялся.');
  } catch (error) { $('editor-error').textContent = error.status === 409 ? 'Кабинет изменился в другой вкладке. Закройте редактор, обновите данные и проверьте изменения.' : error.message; }
  finally { busy(button, false); }
}
async function issue(id, button) {
  const partner = state.partners.find(item => item.id === id); if (!partner) return; busy(button, true);
  try {
    const result = await api('/api/partners/issue-credential', { id, version: partner.version });
    state.partners[state.partners.indexOf(partner)] = result.partner; render();
    $('credential-value').textContent = result.credential; $('credential-dialog').showModal(); notice('Код входа создан. Он показан один раз и не отправлен автоматически.');
  } catch (error) { notice(error.status === 409 ? 'Кабинет изменился. Обновите данные перед созданием доступа.' : error.message, true); }
  finally { busy(button, false); }
}
async function revoke(id, button) {
  const partner = state.partners.find(item => item.id === id); if (!partner) return; busy(button, true);
  try { const saved = await api('/api/partners/revoke-credential', { id, version: partner.version }); state.partners[state.partners.indexOf(partner)] = saved; render(); notice('Доступ отозван. Активные сессии этого партнёра завершены.'); }
  catch (error) { notice(error.status === 409 ? 'Кабинет изменился. Обновите данные перед отзывом доступа.' : error.message, true); }
  finally { busy(button, false); }
}
$('new-partner').onclick = () => openEditor(); $('refresh').onclick = async () => { if (await load()) notice('Настройки партнёров обновлены.'); };
$('partner-form').onsubmit = save; $('product-search').oninput = renderProducts;
$('product-list').onchange = event => { const key = event.target.dataset.product; if (!key) return; event.target.checked ? selected.add(key) : selected.delete(key); $('selection-count').textContent = `Выбрано: ${nf.format(selected.size)}`; };
$('partner-list').onclick = event => { const edit = event.target.closest('[data-edit]'), issueButton = event.target.closest('[data-issue]'), revokeButton = event.target.closest('[data-revoke]'); if (edit) openEditor(edit.dataset.edit); if (issueButton) issue(issueButton.dataset.issue, issueButton); if (revokeButton) revoke(revokeButton.dataset.revoke, revokeButton); };
$('copy-credential').onclick = async () => { try { await navigator.clipboard.writeText($('credential-value').textContent); notice('Код входа скопирован.'); } catch { const range = document.createRange(); range.selectNodeContents($('credential-value')); getSelection().removeAllRanges(); getSelection().addRange(range); notice('Не удалось обратиться к буферу. Код выделен — скопируйте его вручную.', true); } };
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => { const dialog = $(button.dataset.close); if (dialog.id === 'credential-dialog') $('credential-value').textContent = ''; dialog.close(); };
$('credential-dialog').addEventListener('close', () => { $('credential-value').textContent = ''; });
$('new-partner').disabled = true; load();
