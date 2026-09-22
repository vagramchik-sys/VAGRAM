(function () {
  'use strict';
  if (!window.PultSellerHomeModel || !window.PultSellerHomeView) return;
  const host = document.createElement('section');
  host.id = 'seller-home'; host.className = 'seller-home';
  host.setAttribute('aria-label', 'Главная страница Пульта');
  document.querySelector('main').append(host);
  let lastReady = null;
  let model = null, currentScope = '', loading = true, lastRender = '';
  const ui = { chartMode: 'amount', chartAggregation: 'daily', dayIndex: null };
  const scopeKey = input => [input.market, input.store, input.range, input.from, input.to, input.hideInactive].join('|');
  function draw({ preserveFocus = true } = {}) {
    const signature = JSON.stringify([model, ui]);
    if (signature === lastRender) { syncLoading(); return; }
    // Restore keyboard focus after a report refresh replaces the card markup.
    const active = preserveFocus && host.contains(document.activeElement) ? document.activeElement : null;
    const selector = active?.hasAttribute('data-home-period') ? '[data-home-period]' : active?.hasAttribute('data-home-refresh') ? '[data-home-refresh]' : active?.hasAttribute('data-home-day-slider') ? '[data-home-day-slider]' : active?.hasAttribute('data-home-chart-mode') ? '[data-home-chart-mode="' + ui.chartMode + '"]' : active?.hasAttribute('data-home-aggregation') ? '[data-home-aggregation="' + ui.chartAggregation + '"]' : null;
    const tableOpen = host.querySelector('.sh-data')?.open;
    host.innerHTML = window.PultSellerHomeView.render(model, ui);
    lastRender = signature;
    if (tableOpen && host.querySelector('.sh-data')) host.querySelector('.sh-data').open = true;
    syncLoading();
    if (selector) host.querySelector(selector)?.focus({ preventScroll: true });
  }
  function syncLoading() {
    host.setAttribute('aria-busy', String(loading));
    const refresh = host.querySelector('[data-home-refresh]');
    if (refresh) { refresh.disabled = loading; refresh.setAttribute('aria-label', loading ? 'Данные обновляются' : 'Обновить данные'); }
  }
  function update(input) {
    const nextScope = scopeKey(input);
    if (nextScope !== currentScope) { ui.dayIndex = null; currentScope = nextScope; }
    const refreshing = input.state === 'loading' && lastReady && nextScope === scopeKey(lastReady);
    if (input.state === 'ready') lastReady = input;
    else if (!refreshing) lastReady = null;
    loading = input.state === 'loading';
    model = window.PultSellerHomeModel.build(refreshing ? lastReady : input);
    draw();
  }
  function selectDay(value) {
    const index = Number(value);
    if (!Number.isInteger(index) || !model?.daily.length || index < 0 || index >= model.daily.length || index === ui.dayIndex) return;
    ui.dayIndex = index;
    // Keep the native slider attached during a drag; update only the readout and SVG.
    const next = document.createElement('div');
    next.innerHTML = window.PultSellerHomeView.render(model, ui);
    for (const selector of ['[data-home-chart-region]', '[data-home-readout]']) {
      const previous = host.querySelector(selector), replacement = next.querySelector(selector);
      if (previous && replacement) previous.replaceWith(replacement);
    }
    const slider = host.querySelector('[data-home-day-slider]'), nextSlider = next.querySelector('[data-home-day-slider]');
    if (slider && nextSlider) {
      slider.value = nextSlider.value;
      slider.setAttribute('aria-valuetext', nextSlider.getAttribute('aria-valuetext') || '');
    }
    lastRender = JSON.stringify([model, ui]);
  }
  function rememberDay() {
    const slider = host.querySelector('[data-home-day-slider]');
    if (slider) ui.dayIndex = Number(slider.value);
  }
  host.addEventListener('input', event => {
    if (event.target.matches('[data-home-day-slider]')) selectDay(event.target.value);
  });
  host.addEventListener('pointermove', event => {
    const day = event.target.closest('[data-home-day]');
    if (day && event.pointerType !== 'touch') selectDay(day.dataset.homeDay);
  });
  host.addEventListener('change', event => {
    if (!event.target.matches('[data-home-period]')) return;
    const period = document.getElementById('ins-range');
    if (!period) return;
    period.value = event.target.value;
    period.dispatchEvent(new Event('change'));
  });
  host.addEventListener('click', event => {
    const day = event.target.closest('[data-home-day]');
    if (day) { selectDay(day.dataset.homeDay); return; }
    const chartMode = event.target.closest('[data-home-chart-mode]');
    if (chartMode) {
      if (['amount', 'units'].includes(chartMode.dataset.homeChartMode)) { rememberDay(); ui.chartMode = chartMode.dataset.homeChartMode; draw(); }
      return;
    }
    const aggregation = event.target.closest('[data-home-aggregation]');
    if (aggregation) {
      if (['daily', 'cumulative'].includes(aggregation.dataset.homeAggregation)) { rememberDay(); ui.chartAggregation = aggregation.dataset.homeAggregation; draw(); }
      return;
    }
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
    if (link.hasAttribute('data-home-search')) {
      const search = document.getElementById('ins-search');
      document.getElementById('ins-filter').value = '';
      search.value = link.dataset.homeSearch; search.dispatchEvent(new Event('input'));
    }
    window.PultPageLayout.navigate(url.searchParams.get('view') || 'overview', { section: url.searchParams.get('section') || '' });
  });
  window.PultSellerHome = { update };
  update({ state: 'loading' });
})();
