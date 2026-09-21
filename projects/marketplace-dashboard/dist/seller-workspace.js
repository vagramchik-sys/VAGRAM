(function () {
  'use strict';
  if (document.body.classList.contains('pult-seller-workspace') || /(?:charity|demo|partner)\.html$/.test(location.pathname)) return;
  let sidebar = document.querySelector('body > .sidebar');
  if (!sidebar) {
    sidebar = document.createElement('aside'); sidebar.className = 'sidebar';
    sidebar.innerHTML = '<a class="brand" href="/">Пульт</a>';
    document.body.prepend(sidebar);
  }
  const groups = [
    ['overview', 'Обзор бизнеса', [
      ['Динамика бизнеса', '/?view=overview&section=business-chart'],
      ['Единые управленческие метрики', '/?view=overview&section=management-summary'],
      ['Управленческая сводка', '/?view=overview&section=executive'],
      ['Приоритеты', '/?view=priorities'],
      ['Требует внимания', '/?view=attention']
    ]],
    ['products', 'Товары', [
      ['Товары и себестоимость', '/?view=products'],
      ['Управление товарами', '/manage.html']
    ]],
    ['finance', 'Финансы', [
      ['Финансы по магазинам', '/?view=finance'],
      ['Платежи и обязательства', '/finance.html'],
      ['Прибыль и экономика', '/?view=economics'],
      ['Продажи и прибыль Wildberries', '/?view=wb-economics']
    ]],
    ['analytics', 'Аналитика', [
      ['Аналитика товаров', '/?view=analytics'],
      ['Воронка по товарам', '/?view=funnel'],
      ['Падение продаж', '/?view=sales-decline']
    ]],
    ['purchases', 'Закупки', [
      ['Закупки B2B', '/procurement.html'],
      ['Поставщики', '/suppliers.html']
    ]],
    ['stores', 'Магазины', [
      ['Подключённые магазины', '/?view=stores'],
      ['Подключения', '/connections.html']
    ]],
    ['more', 'Ещё', [
      ['Партнёры', '/partners.html'],
      ['Реестр идей', '/ideas.html'],
      ['Благотворительность', '/charity.html']
    ]]
  ];
  const originalNav = sidebar.querySelector('nav');
  document.body.classList.add('pult-seller-workspace', 'pult-seller-shell');
  if (!window.PultPageLayout) document.body.classList.add('pult-static-shell', 'pult-overview-light');
  originalNav?.classList.add('seller-original-nav');
  const brand = sidebar.querySelector('.brand');
  if (brand) {
    brand.href = '/';
    brand.setAttribute('aria-label', 'Пульт — главная');
    brand.innerHTML = '<span class="seller-wordmark">ПУЛЬТ</span><span class="seller-brand-caption">Seller</span>';
  }
  const controls = sidebar.querySelector('.pult-nav-mode');
  const customize = controls?.querySelector('.pult-nav-customize-button');
  if (customize) {
    customize.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8 3.5-2.1-1.2.1-2.4-2.4-2.4-2.4.1L12 4 10.8 6.1 8.4 6 6 8.4l.1 2.4L4 12l2.1 1.2L6 15.6 8.4 18l2.4-.1L12 20l1.2-2.1 2.4.1 2.4-2.4-.1-2.4L20 12Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><span class="seller-action-label">Настроить меню</span>';
    customize.setAttribute('aria-label', 'Настроить порядок разделов и блоков');
    customize.title = 'Настроить порядок разделов и блоков';
  }
  let actions = sidebar.querySelector('.pult-shell-actions');
  if (!actions) { actions = document.createElement('div'); actions.className = 'pult-shell-actions'; sidebar.append(actions); }
  if (!sidebar.querySelector('.pult-shell-search')) {
    const search = document.createElement('button'); search.type = 'button'; search.className = 'pult-shell-search';
    search.setAttribute('aria-label', 'Поиск по разделам Пульта');
    search.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><span>Поиск по Пульту</span><kbd>Ctrl K</kbd>';
    sidebar.insertBefore(search, actions);
    const dialog = document.createElement('dialog'); dialog.className = 'seller-search-dialog';
    dialog.innerHTML = '<div class="seller-search-heading"><label>Поиск по разделам<input type="search" placeholder="Название раздела" autocomplete="off"></label><button type="button" aria-label="Закрыть поиск">×</button></div><div class="seller-search-results"></div>';
    document.body.append(dialog);
    const input = dialog.querySelector('input'), results = dialog.querySelector('.seller-search-results');
    function renderSearch() {
      const query = input.value.trim().toLocaleLowerCase('ru');
      const matches = groups.flatMap(group => group[2]).filter(([label]) => label.toLocaleLowerCase('ru').includes(query));
      results.replaceChildren(...matches.map(([label, href]) => { const link = document.createElement('a'); link.href = href; link.textContent = label; return link; }));
      if (!matches.length) results.textContent = 'Раздел не найден';
    }
    function openSearch() { if (dialog.open) return; renderSearch(); dialog.showModal(); input.focus(); }
    search.addEventListener('click', openSearch); input.addEventListener('input', renderSearch);
    dialog.querySelector('button').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); } });
  }
  const shellSearch = sidebar.querySelector('.pult-shell-search');
  shellSearch?.setAttribute('aria-label', 'Поиск по Пульту');
  if (shellSearch && !shellSearch.querySelector('svg')) shellSearch.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><span>Поиск по Пульту</span><kbd>Ctrl K</kbd>';
  if (actions && !actions.querySelector('.seller-company')) {
    const company = document.createElement('a');
    company.className = 'seller-company'; company.href = '/?view=stores';
    company.innerHTML = '<span>Моя компания</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    company.setAttribute('aria-label', 'Моя компания — подключённые магазины');
    actions.prepend(company);
  }
  const navigation = document.createElement('div');
  navigation.className = 'seller-navigation';
  navigation.setAttribute('role', 'navigation');
  navigation.setAttribute('aria-label', 'Основные разделы Пульта');
  const homeLink = document.createElement('a');
  homeLink.className = 'seller-nav-link seller-home-link'; homeLink.href = '/'; homeLink.textContent = 'Главная';
  navigation.append(homeLink);
  let opened = null;
  let closeTimer = 0;
  function cancelClose() { window.clearTimeout(closeTimer); }
  function closeMenu({ focus = false } = {}) {
    if (!opened) return;
    const previous = opened; opened = null;
    previous.panel.hidden = true; previous.toggle.setAttribute('aria-expanded', 'false');
    previous.node.classList.remove('is-open');
    if (focus) previous.toggle.focus();
  }
  function placeMenu(item) {
    const rect = item.node.getBoundingClientRect();
    item.panel.style.left = Math.max(12, Math.min(rect.left, innerWidth - item.panel.offsetWidth - 12)) + 'px';
    item.panel.style.top = rect.bottom + 'px';
  }
  function openMenu(item, focus = false) {
    cancelClose();
    if (opened !== item) closeMenu();
    opened = item; item.panel.hidden = false; item.toggle.setAttribute('aria-expanded', 'true');
    item.node.classList.add('is-open'); placeMenu(item);
    if (focus) item.panel.querySelector('a')?.focus();
  }
  const items = groups.map(([id, label, links]) => {
    const node = document.createElement('div'); node.className = 'seller-nav-group'; node.dataset.sellerGroup = id;
    const link = document.createElement('a'); link.className = 'seller-nav-link'; link.href = links[0][1]; link.textContent = label;
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'seller-nav-toggle';
    toggle.setAttribute('aria-label', 'Разделы: ' + label); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'seller-menu-' + id);
    toggle.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    const panel = document.createElement('div'); panel.className = 'seller-nav-menu'; panel.id = 'seller-menu-' + id; panel.hidden = true;
    panel.setAttribute('aria-label', label);
    const title = document.createElement('strong'); title.className = 'seller-menu-title'; title.textContent = label; panel.append(title);
    for (const [text, href] of links) { const child = document.createElement('a'); child.textContent = text; child.href = href; panel.append(child); }
    node.append(link, toggle, panel); navigation.append(node);
    const item = { id, links, node, link, toggle, panel };
    toggle.addEventListener('click', () => opened === item ? closeMenu() : openMenu(item));
    link.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') openMenu(item); });
    node.addEventListener('pointerenter', cancelClose);
    node.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse' && !node.contains(document.activeElement)) closeTimer = window.setTimeout(() => closeMenu(), 140); });
    node.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu({ focus: true }); }
      if (event.key === 'ArrowDown' && event.target !== panel && !panel.contains(event.target)) { event.preventDefault(); openMenu(item, true); }
      if (panel.contains(event.target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const linksInMenu = [...panel.querySelectorAll('a')], current = linksInMenu.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? linksInMenu.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + linksInMenu.length) % linksInMenu.length;
        linksInMenu[next]?.focus();
      }
    });
    return item;
  });
  sidebar.append(navigation);
  // Keep routing, filters and data loaders in their existing application modules.
  function route(event) {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin && url.pathname === '/' && window.PultPageLayout) {
      event.preventDefault();
      window.PultPageLayout.navigate(url.searchParams.get('view') || 'overview', { section: url.searchParams.get('section') || '' });
    }
    closeMenu();
  }
  navigation.addEventListener('click', route);
  brand?.addEventListener('click', route);
  actions?.querySelector('.seller-company')?.addEventListener('click', route);
  document.addEventListener('click', event => { if (!navigation.contains(event.target)) closeMenu(); });
  document.addEventListener('focusin', event => { if (!navigation.contains(event.target)) closeMenu(); });
  window.addEventListener('resize', () => { if (opened) placeMenu(opened); });
  navigation.addEventListener('scroll', () => closeMenu());
  function syncActive() {
    const url = new URL(location.href), view = document.body.dataset.pultView || url.searchParams.get('view') || 'overview';
    const hashViews = { overview: 'overview', 'business-chart': 'overview', 'management-summary': 'overview', executive: 'overview', 'focus-priorities': 'priorities', 'ins-products-panel': 'analytics', products: 'products', finance: 'finance', economics: 'economics', 'wb-economics': 'wb-economics', 'sales-decline': 'sales-decline', stores: 'stores', 'conversion-panel': 'funnel', attention: 'attention' };
    const currentView = hashViews[url.hash.slice(1)] || view;
    const section = url.searchParams.get('section') || (['business-chart', 'executive', 'management-summary'].includes(url.hash.slice(1)) ? url.hash.slice(1) : '');
    const homeActive = (url.pathname === '/' || url.pathname === '/index.html') && currentView === 'overview' && !section;
    homeLink.classList.toggle('is-active', homeActive);
    if (homeActive) homeLink.setAttribute('aria-current', 'page'); else homeLink.removeAttribute('aria-current');
    for (const item of items) {
      let active = false;
      for (const child of item.panel.querySelectorAll('a')) {
        const target = new URL(child.href);
        const sameView = (url.pathname === '/' || url.pathname === '/index.html') && target.pathname === '/' && (target.searchParams.get('view') || 'overview') === currentView;
        const exact = sameView ? (target.searchParams.get('section') || '') === section : target.pathname !== '/' && target.pathname === url.pathname;
        if (exact) child.setAttribute('aria-current', 'page'); else child.removeAttribute('aria-current');
        active ||= !homeActive && (sameView || exact);
      }
      if (url.pathname === '/partner.html' && item.id === 'more') active = true;
      item.node.classList.toggle('is-active', active);
      if (active) item.link.setAttribute('aria-current', 'page'); else item.link.removeAttribute('aria-current');
    }
  }
  window.addEventListener('pult:view-change', syncActive);
  window.addEventListener('popstate', syncActive);
  window.addEventListener('hashchange', syncActive);
  syncActive();
})();
