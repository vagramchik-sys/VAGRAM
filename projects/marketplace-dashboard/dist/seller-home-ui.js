(function () {
  'use strict';
  if (!window.PultSellerHomeModel || !window.PultSellerHomeView) return;
  const host = document.createElement('section');
  host.id = 'seller-home'; host.className = 'seller-home';
  host.setAttribute('aria-label', 'Главная страница Пульта');
  document.querySelector('main').append(host);
  let lastReady = null;
  const scopeKey = input => [input.market, input.store, input.range, input.from, input.to, input.hideInactive].join('|');
  function update(input) {
    const refreshing = input.state === 'loading' && lastReady && scopeKey(input) === scopeKey(lastReady);
    if (input.state === 'ready') lastReady = input;
    else if (!refreshing) lastReady = null;
    // Restore keyboard focus after a report refresh replaces the card markup.
    const active = host.contains(document.activeElement) ? document.activeElement : null;
    const selector = active?.hasAttribute('data-home-period') ? '[data-home-period]' : active?.hasAttribute('data-home-refresh') ? '[data-home-refresh]' : null;
    host.innerHTML = window.PultSellerHomeView.render(window.PultSellerHomeModel.build(refreshing ? lastReady : input));
    host.setAttribute('aria-busy', String(input.state === 'loading'));
    const refresh = host.querySelector('[data-home-refresh]');
    if (refresh) refresh.disabled = input.state === 'loading';
    if (selector) host.querySelector(selector)?.focus({ preventScroll: true });
  }
  host.addEventListener('change', event => {
    if (!event.target.matches('[data-home-period]')) return;
    const period = document.getElementById('ins-range');
    if (!period) return;
    period.value = event.target.value;
    period.dispatchEvent(new Event('change'));
  });
  host.addEventListener('click', event => {
    if (event.target.closest('[data-home-refresh]')) {
      window.dispatchEvent(new Event('pult:home-refresh'));
      return;
    }
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== '/' || !window.PultPageLayout) return;
    event.preventDefault();
    const filter = link.dataset.homeFilter;
    if (link.hasAttribute('data-home-filter')) {
      const select = document.getElementById('ins-filter');
      document.getElementById('ins-search').value = '';
      select.value = filter; select.dispatchEvent(new Event('change'));
    }
    window.PultPageLayout.navigate(url.searchParams.get('view') || 'overview', { section: url.searchParams.get('section') || '' });
  });
  window.PultSellerHome = { update };
  update({ state: 'loading' });
})();
