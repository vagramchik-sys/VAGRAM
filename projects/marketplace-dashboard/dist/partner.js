'use strict';
const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('ru-RU');
let dashboard = null;

async function api(url, body) {
  const options = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(url, options); let result;
  try { result = await response.json(); } catch { throw Error('Сервис вернул непонятный ответ. Попробуйте ещё раз.'); }
  if (!response.ok) { const error = Error(result.error || 'Не удалось выполнить запрос.'); error.status = response.status; throw error; }
  return result;
}
function node(tag, className, text) { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; }
function formatDate(value) { if (!value) return 'Неизвестно'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК'; }
function showLogin(message = '') { dashboard = null; $('login-view').hidden = false; $('dashboard-view').hidden = true; $('session-actions').hidden = true; $('login-error').textContent = message; }
function showDashboard() { $('login-view').hidden = true; $('dashboard-view').hidden = false; $('session-actions').hidden = false; render(); }
async function loadDashboard({ quiet = false } = {}) {
  const button = $('refresh-dashboard'); button.disabled = true;
  try { dashboard = await api('/api/partner/dashboard'); showDashboard(); if (!quiet) $('dashboard-notice').textContent = 'Данные обновлены.'; return true; }
  catch (error) { if (error.status === 401 || error.status === 403) showLogin(quiet ? '' : error.message); else if (!quiet) $('dashboard-notice').textContent = error.message; return false; }
  finally { button.disabled = false; }
}
function render() {
  $('partner-title').textContent = dashboard.partner?.name || 'Кабинет партнёра';
  const contractCommission = dashboard.commercialModel?.contractCommissionPercent;
  $('contract-commission').textContent = Number.isFinite(contractCommission) ? `${contractCommission}%` : 'Не задана';
  $('contract-label').textContent = dashboard.commercialModel?.label || 'Комиссия по договору с нами';
  if (dashboard.commercialModel?.reason) $('model-reason').textContent = dashboard.commercialModel.reason;
  renderProducts();
}
function searchable(product) { return [product.name, product.offer_id, product.sku, product.storeName].join(' ').toLocaleLowerCase('ru-RU'); }
function valueOrUnknown(value, suffix = '') { return value === null || value === undefined ? node('span', 'unknown', 'Неизвестно') : document.createTextNode(`${nf.format(value)}${suffix}`); }
function cell(...children) { const td = document.createElement('td'); td.append(...children); return td; }
function renderProducts() {
  const query = $('search').value.trim().toLocaleLowerCase('ru-RU'); const products = dashboard.products.filter(product => searchable(product).includes(query)); const tbody = $('products'); tbody.replaceChildren();
  for (const product of products) {
    const row = document.createElement('tr');
    const title = node('strong', '', product.name || 'Без названия'); title.append(node('small', '', `offer ID: ${product.offer_id || '—'} · SKU: ${product.sku || '—'}`));
    const sales = document.createDocumentFragment(); sales.append(valueOrUnknown(product.sales?.sold)); if (product.sales?.reason) sales.append(node('small', '', product.sales.reason));
    if(product.sales?.period)sales.append(node('small','',`${product.sales.period.from} — ${product.sales.period.to}`));
    const returned=node('small','','Возвраты, шт.: ');returned.append(valueOrUnknown(product.sales?.returned));sales.append(returned);
    const finance = document.createDocumentFragment(); finance.append(valueOrUnknown(product.finance?.settlement, ' ₽')); if (product.finance?.reason) finance.append(node('small', '', product.finance.reason));
    for(const [key,label] of [['revenue','Реализация'],['contractCommission','Комиссия по договору'],['logistics','Логистика'],['advertising','Реклама'],['returns','Возвраты']]){const detail=node('small','',label+': ');detail.append(valueOrUnknown(product.finance?.[key],' ₽'));finance.append(detail);}
    const status = node('span', 'status', product.salesStatus || 'Статус неизвестен');
    row.append(cell(title), cell(document.createTextNode(product.storeName || 'Не указан')), cell(valueOrUnknown(product.quantity)), cell(sales), cell(finance), cell(status), cell(document.createTextNode(formatDate(product.importedAt)))); tbody.append(row);
  }
  $('empty-products').hidden = products.length > 0; $('empty-products').textContent = dashboard.products.length ? 'По запросу ничего не найдено.' : 'Владелец пока не назначил товары этому кабинету.';
}
$('login-form').onsubmit = async event => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true; $('login-error').textContent = ''; try { await api('/api/partner/login', { credential: $('credential').value }); $('credential').value = ''; await loadDashboard({ quiet: true }); } catch (error) { $('login-error').textContent = error.message; } finally { button.disabled = false; } };
$('logout').onclick = async () => { try { await api('/api/partner/logout', {}); } finally { showLogin(); $('credential').value = ''; } };
$('refresh-dashboard').onclick = () => loadDashboard(); $('search').oninput = () => { if (dashboard) renderProducts(); };
loadDashboard({ quiet: true });
