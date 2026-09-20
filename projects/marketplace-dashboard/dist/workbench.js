(function () {
  'use strict';
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const home = location.pathname === '/' || location.pathname === '/index.html';
  const to = hash => (home ? '' : '/') + hash;
  const destinations = [
    ['◫', 'Обзор бизнеса', 'Показатели, заказы и реализация', to('#overview'), 'главная сводка оборот выручка сегодня'],
    ['◎', 'Приоритеты', 'Остатки, себестоимость и удержания', to('#focus-priorities'), 'риски проверить проблемы'],
    ['↗', 'Динамика бизнеса', 'Общий оборот и отдельные магазины', to('#business-chart'), 'график линии заказы динамика'],
    ['◩', 'Аналитика товаров', 'ABC-анализ и вклад SKU в реализацию', to('#ins-products-panel'), 'анализ abc абс лидеры'],
    ['▦', 'Товары и себестоимость', 'Каталог, цены и текущие остатки', to('#products'), 'каталог sku артикул наличие'],
    ['⇅', 'Управление товарами', 'Подготовка цен, заметки и заявки', '/manage.html', 'цена цены изменить редактировать заявки'],
    ['◈', 'Прибыль и экономика', 'Себестоимость продаж, маржа и результат по SKU', to('#economics'), 'прибыль рентабельность экономика маржа'],
    ['₽', 'Финансы', 'Начисления и полнота загруженных данных', to('#finance'), 'деньги расходы финансовый отчёт'],
    ['⇄', 'Магазины', 'Подключённые кабинеты и состояние импорта', to('#stores'), 'синхронизация импорт обновления'],
    ['✧', 'Реестр идей', 'Быстро записать мысль и вернуться к ней позже', '/ideas.html', 'идея мысль отложено в работу'],
    ['▤', 'Закупки B2B', 'Заявки, собственные прайсы и сравнение предложений', '/procurement.html', 'закупщик поставщики прайс поиск товар'],
    ['⚙', 'Подключения', 'Доступ Ozon и Wildberries', '/connections.html', 'api ключ подключить вб озон']
  ];
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const normalize = value => value.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
  const controls = document.createElement('div');
  controls.className = 'workbench-controls';
  controls.innerHTML = '<button class="quick-open" type="button" aria-haspopup="dialog" aria-controls="quick-nav"><span aria-hidden="true">⌕</span> Найти раздел <kbd>Ctrl K</kbd></button><button class="density-toggle" type="button" aria-pressed="false" title="Уменьшить высоту строк в таблицах">≡ <span>Компактные таблицы</span></button>';
  bar.insertBefore(controls, bar.lastElementChild);
  const searchButton = controls.querySelector('.quick-open');
  const densityButton = controls.querySelector('.density-toggle');
  const preference = 'pult-table-density-v1';
  function density(value) {
    const compact = value === 'compact';
    document.documentElement.dataset.density = compact ? 'compact' : 'comfortable';
    densityButton.setAttribute('aria-pressed', String(compact));
    densityButton.title = compact ? 'Вернуть обычную высоту строк' : 'Уменьшить высоту строк в таблицах';
  }
  try { density(localStorage.getItem(preference)); } catch { density('comfortable'); }
  densityButton.onclick = () => {
    const next = document.documentElement.dataset.density === 'compact' ? 'comfortable' : 'compact';
    density(next);
    try { localStorage.setItem(preference, next); } catch {}
  };
  window.addEventListener('storage', e => { if (e.key === preference) density(e.newValue); });

  const dialog = document.createElement('dialog');
  dialog.id = 'quick-nav';
  dialog.setAttribute('aria-labelledby', 'quick-nav-title');
  dialog.innerHTML = '<div class="quick-heading"><div><span class="eyebrow">БЫСТРЫЙ ПЕРЕХОД</span><h2 id="quick-nav-title">Куда перейти?</h2></div><button class="button secondary" type="button" aria-label="Закрыть поиск раздела">✕</button></div><label class="quick-search-label" for="quick-query">Название раздела или задача</label><input id="quick-query" type="search" placeholder="Например: цены, график, остатки…" autocomplete="off" aria-controls="quick-results"><div id="quick-result-count" class="quick-count" aria-live="polite"></div><nav id="quick-results" aria-label="Результаты поиска разделов"></nav><p class="quick-help"><kbd>↑</kbd> <kbd>↓</kbd> перейти к результату · <kbd>Enter</kbd> открыть · <kbd>Esc</kbd> закрыть</p>';
  document.body.append(dialog);
  const query = dialog.querySelector('input');
  const results = dialog.querySelector('#quick-results');
  let opener;
  function render() {
    const words = normalize(query.value).trim().split(/\s+/).filter(Boolean);
    const matched = destinations.filter(item => words.every(word => normalize(item.slice(1).join(' ')).includes(word)));
    results.innerHTML = matched.map(([icon, title, note, href]) => '<a href="'+escape(href)+'"><span class="quick-icon" aria-hidden="true">'+icon+'</span><span><b>'+title+'</b><small>'+note+'</small></span><span class="quick-arrow" aria-hidden="true">↗</span></a>').join('');
    dialog.querySelector('#quick-result-count').textContent = matched.length ? 'Найдено разделов: ' + matched.length : 'Нет такого раздела. Попробуйте «цены», «график» или «магазины».';
  }
  function open() {
    if (document.querySelector('dialog[open]')) return;
    opener = document.activeElement;
    query.value = '';
    render();
    dialog.showModal();
    query.focus();
  }
  searchButton.onclick = open;
  dialog.querySelector('button').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus({preventScroll:true}); });
  query.oninput = render;
  query.onkeydown = event => {
    const links = [...results.querySelectorAll('a')];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      (event.key === 'ArrowDown' ? links[0] : links.at(-1))?.focus();
    } else if (event.key === 'Enter' && links.length) { event.preventDefault(); links[0].click(); }
  };
  results.onclick = event => { if (event.target.closest('a')) dialog.close(); };
  results.onkeydown = event => {
    if (!['ArrowDown','ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const links = [...results.querySelectorAll('a')], index = links.indexOf(document.activeElement);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= links.length) query.focus(); else links[next].focus();
  };
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyK' && !event.altKey) {
      event.preventDefault();
      if (dialog.open) dialog.close(); else open();
    }
  });
})();
