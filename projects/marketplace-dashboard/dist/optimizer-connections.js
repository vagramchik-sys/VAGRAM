(function (scope) {
  'use strict';
  const document = scope?.document;
  if (!document) return;
  const sellerPanel = document.getElementById('connect')?.closest('.panel');
  if (!sellerPanel || document.getElementById('performance')) return;
  const panel = document.createElement('section');
  panel.id = 'performance'; panel.className = 'panel optimizer-connect-panel';
  panel.innerHTML = '<div class="panel-title"><h2>Ozon Performance API</h2><span id="performance-status" class="optimizer-connect-status">Проверяем подключение</span></div>' +
    '<form id="performance-form" class="optimizer-connect-form" autocomplete="off">' +
    '<label>Магазин<select id="performance-store" required><option value="">Выберите магазин</option></select></label>' +
    '<label>Performance Client ID<input id="performance-client-id" type="text" required autocomplete="off" spellcheck="false"></label>' +
    '<label>Client Secret<input id="performance-client-secret" type="password" required autocomplete="new-password" spellcheck="false"></label>' +
    '<button type="submit" id="performance-save">Подключить</button><button type="button" id="performance-test">Проверить</button></form>' +
    '<p class="optimizer-connect-note">Отдельное подключение рекламы. Ключ защищается Windows DPAPI и после сохранения не показывается. Ставки и цены на Ozon не меняются.</p>' +
    '<p id="performance-message" class="optimizer-connect-message" role="status" aria-live="polite"></p>';
  sellerPanel.after(panel);
  const $ = id => document.getElementById(id);
  const select = $('performance-store');
  const statusBadge = $('performance-status');
  const message = $('performance-message');
  let statuses = [];
  function show(messageText, tone = 'info') { message.textContent = messageText; message.dataset.tone = tone; }
  async function api(url, options) {
    const response = await scope.fetch(url, { credentials: 'same-origin', ...options });
    let value;
    try { value = await response.json(); } catch { throw Error('Сервер вернул неполный ответ.'); }
    if (!response.ok) throw Error(typeof value?.error === 'string' && value.error.length < 300 ? value.error : 'Проверка не удалась.');
    return value;
  }
  function renderStatus() {
    const row = statuses.find(item => String(item.storeId) === select.value);
    if (!select.value) { statusBadge.textContent = 'Выберите магазин'; statusBadge.dataset.status = ''; }
    else if (!row?.configured) { statusBadge.textContent = 'Не подключён'; statusBadge.dataset.status = ''; }
    else if (row.status === 'error' || row.errorCode) { statusBadge.textContent = 'Требует проверки'; statusBadge.dataset.status = 'error'; }
    else { statusBadge.textContent = 'Подключён · ' + (row.status || 'ожидает обновления'); statusBadge.dataset.status = ''; }
    $('performance-test').disabled = !row?.configured;
  }
  async function load() {
    const [storesResult, statusesResult] = await Promise.allSettled([api('/api/stores'), api('/api/optimizer/performance/status')]);
    if (storesResult.status === 'fulfilled') {
      const stores = Array.isArray(storesResult.value) ? storesResult.value : storesResult.value?.stores || [];
      const selected = select.value;
      select.replaceChildren(new Option('Выберите магазин', ''));
      for (const store of stores) {
        if (!store?.id || store.market === 'WB' || String(store.id).startsWith('wb-')) continue;
        select.add(new Option(store.name || String(store.id), String(store.id)));
      }
      if (selected) select.value = selected;
    }
    if (statusesResult.status === 'fulfilled') statuses = Array.isArray(statusesResult.value?.stores) ? statusesResult.value.stores : [];
    else show('Статус Performance API пока недоступен. Проверьте, установлено ли обновление Пульта.', 'error');
    renderStatus();
  }
  select.addEventListener('change', () => { show(''); renderStatus(); });
  $('performance-form').addEventListener('submit', async event => {
    event.preventDefault();
    const storeId = select.value, clientId = $('performance-client-id').value.trim(), clientSecret = $('performance-client-secret').value.trim();
    if (!storeId || !clientId || !clientSecret) return show('Укажите магазин, Client ID и Client Secret.', 'error');
    const save = $('performance-save'); save.disabled = true; show('Сохраняем подключение…');
    try {
      const expectedRevision = statuses.find(item => String(item.storeId) === storeId)?.revision || '0';
      await api('/api/optimizer/performance/credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId, clientId, clientSecret, expectedRevision }) });
      $('performance-client-secret').value = ''; $('performance-client-id').value = '';
      show('Подключение сохранено. Рекламные данные обновляются отдельно по расписанию.');
      await load();
    } catch (error) { show(error?.message || 'Подключение не сохранено.', 'error'); }
    finally { save.disabled = false; }
  });
  $('performance-test').addEventListener('click', async () => {
    if (!select.value) return;
    const button = $('performance-test'); button.disabled = true; show('Проверяем сохранённое подключение…');
    try {
      const result = await api('/api/optimizer/performance/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: select.value }) });
      show(result?.ok === true ? 'Подключение работает.' : 'Проверка не подтвердила подключение.', result?.ok === true ? 'info' : 'error');
      await load();
    } catch (error) { show(error?.message || 'Проверка не удалась.', 'error'); }
    finally { button.disabled = false; renderStatus(); }
  });
  load().catch(() => show('Не удалось открыть настройки Performance API.', 'error'));
})(typeof window === 'undefined' ? null : window);
