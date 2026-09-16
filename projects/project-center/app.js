(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const money = value => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(value || 0);
  const number = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value || 0);
  const empty = () => ({ products: [], sales: [], expenses: [] });
  let state = empty();
  let version = null, saving = false, ready = false, user = null, editingProductId = null;
  let writeEpoch = 0, inputEpoch = 0, refreshSequence = 0, refreshing = false, needsRefresh = false, lastSync = null;
  const dirtyForms = new Set();
  const dataForms = ['product-form', 'sale-form', 'expense-form'].map($);
  const hasDraft = () => editingProductId !== null || dirtyForms.size > 0;
  const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  function syncStatus(message) {
    if (!$('sync-status')) return;
    $('sync-status').textContent = message || (saving ? 'Сохранение…' : needsRefresh ? 'Требуется обновить данные' : hasDraft() ? 'Автообновление приостановлено: несохраненный ввод' : lastSync ? `Обновлено в ${lastSync.toLocaleTimeString('ru-RU')}` : 'Ожидание данных…');
  }
  for (const form of dataForms) {
    const markDirty = () => { dirtyForms.add(form.id); inputEpoch++; syncStatus(); };
    form.addEventListener('input', markDirty); form.addEventListener('change', markDirty);
    form.addEventListener('reset', () => { dirtyForms.delete(form.id); inputEpoch++; queueMicrotask(() => syncStatus()); });
  }
  const productSubmit = $('product-form').querySelector('[type="submit"]');
  const productSubmitLabel = productSubmit.textContent;
  const cancelEdit = document.createElement('button'); cancelEdit.type = 'reset'; cancelEdit.textContent = 'Отменить редактирование'; cancelEdit.hidden = true; $('product-form').append(cancelEdit);
  $('product-form').addEventListener('reset', () => { editingProductId = null; productSubmit.textContent = productSubmitLabel; cancelEdit.hidden = true; });
  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function notice(message, error = false) {
    $('status').textContent = message;
    $('status').classList.toggle('error', error);
  }
  function checked(candidate) {
    const result = window.OzonModel.validateState(candidate);
    if (result === false || result?.valid === false || result?.ok === false || (Array.isArray(result) && result.length)) {
      const errors = Array.isArray(result) ? result : result.errors;
      throw new Error(Array.isArray(errors) ? errors.join(' ') : String(errors || 'Некорректные данные.'));
    }
    window.OzonModel.summarize(candidate);
    return candidate;
  }
  async function request(method = 'GET', body) {
    const response = await fetch('/api/state', { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.href = '/login.html'; throw new Error('Войдите в учетную запись.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || `Ошибка сервера: ${response.status}`); error.status = response.status; throw error; }
    return data;
  }
  async function refresh({ background = false } = {}) {
    if (saving || hasDraft() || (background && (document.visibilityState !== 'visible' || typing() || refreshing))) return false;
    const sequence = ++refreshSequence, epoch = writeEpoch, draftEpoch = inputEpoch;
    refreshing = true; syncStatus('Обновление…');
    try {
      const data = await request();
      if (sequence !== refreshSequence || epoch !== writeEpoch || draftEpoch !== inputEpoch || saving || hasDraft() || (background && (document.visibilityState !== 'visible' || typing()))) return false;
      state = checked(data.state); version = data.version; user = data.user; ready = true; needsRefresh = false; lastSync = new Date(); render(); return true;
    } finally { if (sequence === refreshSequence) { refreshing = false; syncStatus(); } }
  }
  async function commit(next, message, formId = null) {
    if (!ready) throw new Error('Дождитесь загрузки данных с сервера.');
    if (user?.role === 'viewer') throw new Error('Ваша роль разрешает только просмотр.');
    if (saving) throw new Error('Дождитесь завершения предыдущего сохранения.');
    if (needsRefresh) throw new Error('Данные могли измениться. Нажмите «Обновить» и повторите действие.');
    if ((editingProductId && formId !== 'product-form') || [...dirtyForms].some(id => id !== formId)) throw new Error('Сначала сохраните или сбросьте ввод в других формах.');
    checked(next);
    if (new Blob([JSON.stringify({ state: next, version })]).size > 1900000) throw new Error('Общая база превысила лимит сервера 2 МБ. Уменьшите объем импортируемых данных.');
    saving = true; writeEpoch++; render(); syncStatus();
    try {
      const data = await request('PUT', { state: next, version });
      state = next; version = data.version; lastSync = new Date(); render(); notice(message);
    } catch (error) {
      needsRefresh = true;
      if (error.status === 409) throw new Error('Данные изменены другим сотрудником. Ваш ввод сохранен в форме. Нажмите «Обновить», чтобы загрузить актуальную базу перед повторным вводом.');
      throw error;
    } finally { saving = false; writeEpoch++; render(); syncStatus(); }
  }
  function formValues(form) { return Object.fromEntries(new FormData(form)); }
  function amount(value, label, integer = false) {
    if (String(value).trim() === '') throw new Error(`Заполните поле «${label}».`);
    const n = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || (integer && !Number.isSafeInteger(n))) throw new Error(`Некорректное значение поля «${label}».`);
    return n;
  }
  function validDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Укажите корректную дату в формате ГГГГ-ММ-ДД.');
    return date;
  }
  function saleFrom(values, productId) {
    if (!state.products.some(p => p.id === productId)) throw new Error('Выберите существующий товар.');
    const quantity = amount(values.quantity, 'Количество', true);
    if (quantity === 0) throw new Error('Количество должно быть больше нуля.');
    return { id: uid(), date: validDate(values.date), productId, quantity, price: amount(values.price, 'Цена'), commission: amount(values.commission, 'Комиссия'), logistics: amount(values.logistics, 'Логистика') };
  }
  function row(body, values, remove, edit) {
    const tr = document.createElement('tr');
    for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    if (remove) { const td = document.createElement('td'); if (edit) { const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Изменить'; button.addEventListener('click', edit); button.disabled = user?.role === 'viewer' || saving || !ready; td.append(button); } const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Удалить'; button.className = 'delete-button'; button.addEventListener('click', remove); button.disabled = user?.role === 'viewer' || saving || !ready; td.append(button); tr.append(td); }
    body.append(tr);
  }
  function guarded(fn) { return async (...args) => { try { return await fn(...args); } catch (error) { notice(error.message || 'Не удалось выполнить действие.', true); } }; }
  async function deleteItem(collection, id) {
    if (collection === 'products' && state.sales.some(s => s.productId === id)) throw new Error('Товар связан с продажами. Сначала удалите связанные продажи.');
    if (!confirm('Удалить запись? Это действие нельзя отменить.')) return;
    await commit({ ...state, [collection]: state[collection].filter(item => item.id !== id) }, 'Запись удалена.');
  }
  function emptyRow(body, columns, message) {
    if (body.children.length) return;
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = columns; td.className = 'empty-cell'; td.textContent = message; tr.append(td); body.append(tr);
  }
  function render() {
    const from = $('filter-from').value, to = $('filter-to').value;
    const summary = window.OzonModel.summarize(state, from, to);
    const kpis = { revenue: money(summary.revenue), profit: money(summary.profit), margin: `${number(summary.margin)} %`, units: number(summary.units), stock: number(state.products.reduce((sum, p) => sum + p.stock, 0)), expenses: money(summary.expenses) };
    for (const [key, value] of Object.entries(kpis)) $(`kpi-${key}`).textContent = value;
    const products = $('products-body'), sales = $('sales-body'), expenses = $('expenses-body'), analytics = $('analytics-body');
    for (const body of [products, sales, expenses, analytics]) body.replaceChildren();
    const search = ($('product-search')?.value || '').trim().toLocaleLowerCase('ru-RU');
    const thresholdValue = Number($('low-stock-threshold')?.value ?? 5);
    const threshold = Number.isSafeInteger(thresholdValue) && thresholdValue >= 0 ? thresholdValue : 5;
    const filtered = state.products.filter(p => (!search || `${p.sku} ${p.name}`.toLocaleLowerCase('ru-RU').includes(search)) && (!$('low-stock-only')?.checked || p.stock <= threshold));
    for (const p of filtered) row(products, [p.sku, p.name, money(p.cost), money(p.price), number(p.stock)], guarded(() => deleteItem('products', p.id)), () => {
      if ((editingProductId || dirtyForms.has('product-form')) && !confirm('Заменить несохраненный ввод данными выбранного товара?')) return;
      editingProductId = p.id; inputEpoch++; dirtyForms.add('product-form'); syncStatus();
      for (const key of ['sku', 'name', 'cost', 'stock', 'price']) $('product-form').elements.namedItem(key).value = p[key];
      productSubmit.textContent = 'Сохранить изменения'; cancelEdit.hidden = false; $('product-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
      notice('Редактирование товара. Изменение себестоимости пересчитает прибыль всех связанных продаж.');
    });
    const inRange = x => (!from || x.date >= from) && (!to || x.date <= to);
    for (const s of [...state.sales].filter(inRange).sort((a, b) => b.date.localeCompare(a.date))) {
      const p = state.products.find(p => p.id === s.productId);
      row(sales, [s.date, p?.name || 'Товар отсутствует', number(s.quantity), money(s.price), money(s.quantity * s.price), money(s.commission), money(s.logistics)], guarded(() => deleteItem('sales', s.id)));
    }
    for (const e of [...state.expenses].filter(inRange).sort((a, b) => b.date.localeCompare(a.date))) row(expenses, [e.date, e.category, money(e.amount), e.note], guarded(() => deleteItem('expenses', e.id)));
    for (const p of summary.byProduct) row(analytics, [p.sku, p.name, number(p.units), money(p.revenue), money(p.profit)]);
    emptyRow(products, 6, state.products.length ? 'По заданным фильтрам товары не найдены.' : 'Добавьте первый товар.'); emptyRow(sales, 8, 'Продаж за выбранный период нет.'); emptyRow(expenses, 5, 'Расходов за выбранный период нет.'); emptyRow(analytics, 5, 'Добавьте продажи, чтобы увидеть аналитику.');
    const lowStock = $('low-stock-summary');
    if (lowStock) {
      lowStock.replaceChildren();
      const items = state.products.filter(p => p.stock <= threshold).sort((a, b) => a.stock - b.stock || a.sku.localeCompare(b.sku));
      const title = document.createElement('p'); title.textContent = `Товаров с остатком до ${number(threshold)} шт. включительно: ${number(items.length)}`; lowStock.append(title);
      if (items.length) { const list = document.createElement('ul'); for (const p of items.slice(0, 5)) { const item = document.createElement('li'); item.textContent = `${p.sku} · ${p.name}: ${number(p.stock)} шт.`; list.append(item); } lowStock.append(list); }
    }
    const select = $('sale-product'), selected = select.value;
    select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Выберите товар'; select.append(placeholder);
    for (const p of state.products) { const option = document.createElement('option'); option.value = p.id; option.textContent = `${p.sku} · ${p.name}`; select.append(option); }
    select.value = selected;
    drawChart(summary.byDay);
    const readonly = user?.role === 'viewer' || !ready || saving;
    document.querySelectorAll('#product-form input, #product-form button, #sale-form input, #sale-form select, #sale-form button, #expense-form input, #expense-form select, #expense-form textarea, #expense-form button, #demo-button, #import-button, #csv-button, #import-file, #csv-file').forEach(element => { element.disabled = readonly; });
    let role = $('user-role');
    if (!role) { role = document.createElement('div'); role.id = 'user-role'; role.className = 'user-role'; $('status').before(role); }
    const roles = { admin: 'Администратор', editor: 'Редактор', operator: 'Оператор', viewer: 'Наблюдатель — только просмотр' };
    role.textContent = user ? `Пользователь: ${user.name || user.username || user.email || ''} · ${roles[user.role] || user.role}` : 'Подключение к серверу…';
    syncStatus();
    if (ready) document.dispatchEvent(new CustomEvent('ozon-state', { detail: structuredClone({ state, version, user }) }));
  }
  function drawChart(days) {
    const chart = $('chart'); chart.replaceChildren();
    if (!days.length) { const p = document.createElement('p'); p.className = 'empty-cell'; p.textContent = 'График появится после добавления операций.'; chart.append(p); return; }
    const latest = days.slice(-30), max = Math.max(1, ...latest.map(d => Math.max(d.revenue, Math.abs(d.profit))));
    const legend = document.createElement('p'); legend.className = 'chart-legend'; legend.textContent = 'Выручка / прибыль · последние 30 дней с операциями'; chart.append(legend);
    for (const day of latest) {
      const line = document.createElement('div'); line.className = 'chart-row';
      const label = document.createElement('span'); label.className = 'chart-date'; label.textContent = day.date.slice(5);
      const bars = document.createElement('div'); bars.className = 'chart-bars';
      for (const [key, title] of [['revenue', 'Выручка'], ['profit', 'Прибыль']]) { const bar = document.createElement('div'); bar.className = `chart-bar ${key}${day[key] < 0 ? ' negative' : ''}`; bar.style.width = `${Math.max(0, Math.abs(day[key]) / max * 100)}%`; bar.title = `${title}: ${money(day[key])}`; bars.append(bar); }
      const value = document.createElement('span'); value.className = 'chart-value'; value.textContent = `${money(day.revenue)} / ${money(day.profit)}`;
      line.append(label, bars, value); chart.append(line);
    }
  }
  $('product-form').addEventListener('submit', guarded(async event => {
    event.preventDefault(); const f = event.currentTarget, v = formValues(f);
    const sku = v.sku.trim(), name = v.name.trim();
    if (!sku || !name) throw new Error('Заполните артикул и название товара.');
    if (state.products.some(p => p.id !== editingProductId && p.sku.toLowerCase() === sku.toLowerCase())) throw new Error('Товар с таким артикулом уже существует.');
    if (editingProductId && !state.products.some(p => p.id === editingProductId)) throw new Error('Редактируемый товар удален другим сотрудником. Обновите страницу.');
    const product = { id: editingProductId || uid(), sku, name, cost: amount(v.cost, 'Себестоимость'), stock: amount(v.stock, 'Остаток', true), price: amount(v.price, 'Цена') };
    const products = editingProductId ? state.products.map(p => p.id === editingProductId ? product : p) : [...state.products, product];
    await commit({ ...state, products }, editingProductId ? 'Товар обновлен.' : 'Товар добавлен.', f.id); editingProductId = null; productSubmit.textContent = productSubmitLabel; f.reset();
  }));
  $('sale-form').addEventListener('submit', guarded(async event => {
    event.preventDefault(); const f = event.currentTarget, v = formValues(f);
    await commit({ ...state, sales: [...state.sales, saleFrom(v, v.productId)] }, 'Продажа добавлена. Текущий остаток не изменен.', f.id); f.reset(); setDates();
  }));
  $('expense-form').addEventListener('submit', guarded(async event => {
    event.preventDefault(); const f = event.currentTarget, v = formValues(f);
    if (!v.category.trim()) throw new Error('Укажите категорию расхода.');
    const expense = { id: uid(), date: validDate(v.date), category: v.category.trim(), amount: amount(v.amount, 'Сумма'), note: v.note.trim() };
    await commit({ ...state, expenses: [...state.expenses, expense] }, 'Расход добавлен.', f.id); f.reset(); setDates();
  }));
  $('sale-product').addEventListener('change', () => { const p = state.products.find(p => p.id === $('sale-product').value); if (p) $('sale-form').elements.price.value = p.price; });
  for (const id of ['filter-from', 'filter-to']) $(id).addEventListener('change', guarded(() => { if ($('filter-from').value && $('filter-to').value && $('filter-from').value > $('filter-to').value) { $(id).value = ''; render(); throw new Error('Начало периода должно быть раньше его окончания. Некорректная граница сброшена.'); } render(); }));
  document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[id^="page-"]').forEach(section => { section.hidden = section.id !== `page-${button.dataset.page}`; });
    document.querySelectorAll('[data-page]').forEach(other => { const active = other === button; other.classList.toggle('active', active); if (active) other.setAttribute('aria-current', 'page'); else other.removeAttribute('aria-current'); });
  }));
  $('export-button').addEventListener('click', guarded(async () => {
    if (saving) throw new Error('Дождитесь завершения сохранения.');
    const data = await request(); const backup = checked(data.state);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `ozon-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notice('Резервная копия подготовлена к скачиванию.');
  }));
  $('import-button').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Максимальный размер JSON-файла — 10 МБ.');
      const next = checked(JSON.parse(await file.text()));
      if ((state.products.length || state.sales.length || state.expenses.length) && !confirm('Импорт заменит все текущие данные. Продолжить?')) return;
      await commit(next, 'Резервная копия восстановлена.');
    } catch (error) { notice(`Импорт не выполнен: ${error.message}`, true); } finally { event.target.value = ''; }
  });
  function parseCsv(text) {
    const rows = []; let row = [], field = '', quoted = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
      else if (!quoted && ch === ';') { row.push(field.trim()); field = ''; }
      else if (!quoted && (ch === '\n' || ch === '\r')) { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field.trim()); if (row.some(Boolean)) rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    if (quoted) throw new Error('Незакрытые кавычки в CSV.');
    row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
    return rows;
  }
  $('csv-button').addEventListener('click', () => $('csv-file').click());
  $('csv-file').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('Максимальный размер импортируемого файла — 1 МБ.');
      const rows = parseCsv(await file.text()), header = ['date', 'sku', 'quantity', 'price', 'commission', 'logistics'];
      if (!rows.length || rows[0].join(';') !== header.join(';')) throw new Error('Ожидается заголовок: date;sku;quantity;price;commission;logistics');
      const imported = rows.slice(1).map((cells, index) => {
        try { if (cells.length !== header.length) throw new Error('Должно быть 6 столбцов.'); const values = Object.fromEntries(header.map((key, i) => [key, cells[i]])); const product = state.products.find(p => p.sku.toLowerCase() === values.sku.toLowerCase()); if (!product) throw new Error(`Неизвестный артикул: ${values.sku}`); return saleFrom(values, product.id); }
        catch (error) { throw new Error(`Строка ${index + 2}: ${error.message}`); }
      });
      if (!imported.length) throw new Error('В файле нет продаж.');
      if (!confirm(`Добавить продаж: ${imported.length}? Повторный импорт создаст дубликаты.`)) return;
      await commit({ ...state, sales: [...state.sales, ...imported] }, `Импортировано продаж: ${imported.length}.`);
    } catch (error) { notice(`CSV не импортирован: ${error.message}`, true); } finally { event.target.value = ''; }
  });
  $('demo-button').addEventListener('click', guarded(async () => {
    if ((state.products.length || state.sales.length || state.expenses.length) && !confirm('Демонстрация заменит текущие данные. Продолжить?')) return;
    const products = [{ id: uid(), sku: 'DEMO-001', name: 'Органайзер для рабочего стола', cost: 290, stock: 42, price: 890 }, { id: uid(), sku: 'DEMO-002', name: 'Термокружка 450 мл', cost: 420, stock: 28, price: 1290 }, { id: uid(), sku: 'DEMO-003', name: 'Набор контейнеров', cost: 350, stock: 65, price: 990 }];
    const sales = Array.from({ length: 18 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (17 - i)); const p = products[i % 3], quantity = i % 4 + 1; return { id: uid(), date: localDate(d), productId: p.id, quantity, price: p.price, commission: Math.round(p.price * quantity * 0.18), logistics: quantity * 65 }; });
    const expenses = [{ id: uid(), date: localDate(new Date()), category: 'Реклама', amount: 1500, note: 'Демонстрационные данные' }];
    $('filter-from').value = ''; $('filter-to').value = ''; await commit({ products, sales, expenses }, 'Загружены демонстрационные данные.');
  }));
  function localDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function setDates() { for (const id of ['sale-form', 'expense-form']) $(id).elements.date.value = localDate(new Date()); }
  for (const id of ['product-search', 'low-stock-only', 'low-stock-threshold']) $(id)?.addEventListener(id === 'low-stock-only' ? 'change' : 'input', guarded(render));
  $('refresh-button')?.addEventListener('click', guarded(async () => {
    if (saving) throw new Error('Дождитесь завершения сохранения.');
    if (hasDraft()) {
      if (!confirm('Обновление сбросит несохраненный ввод в формах. Продолжить?')) return;
      dataForms.forEach(form => form.reset()); setDates();
    }
    if (await refresh()) notice('Данные обновлены.');
    else notice('Обновление отложено: ввод продолжился во время загрузки.');
  }));
  setInterval(() => refresh({ background: true }).catch(() => syncStatus('Нет связи с сервером. Повторим обновление автоматически.')), 15000);
  setDates(); render();
  refresh().catch(error => notice(`Не удалось загрузить данные: ${error.message}`, true));
})();

