(function () {
  'use strict';
  const panel = document.getElementById('category-sales-panel');
  if (!panel) return;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const number = new Intl.NumberFormat('ru-RU'), display = value => value === null || value === undefined ? '—' : number.format(value);
  const short = day => day.slice(8, 10) + '.' + day.slice(5, 7);
  const labels = { sold: 'Продано', returned: 'Возвраты / сторно', net: 'Продано минус возвраты' };
  const lines = [{ key: 'total', name: 'Всего', color: '#dfc384' }, { key: 'Ozon', name: 'Ozon', color: '#71a9fa' }, { key: 'WB', name: 'WB', color: '#df8bd3' }];
  let report = null, generation = 0, controller = null, stores = [];
  panel.classList.add('panel', 'category-sales');
  panel.innerHTML = `<div class="panel-heading"><div><h2>Продажи общих категорий</h2><p>Ozon и Wildberries · единицы финансовой реализации</p></div><a href="#supplier-categories">Настроить категории →</a></div><div class="category-sales-controls"><label>Площадка<select id="category-sales-market"><option value="all">Все площадки</option><option value="Ozon">Ozon</option><option value="WB">Wildberries</option></select></label><label>Магазин<select id="category-sales-store" disabled><option value="">Все магазины</option></select></label><label>Общая категория<select id="category-sales-category"><option value="">Все товары</option></select></label><label>Период<select id="category-sales-days"><option value="7">7 завершённых дней</option><option value="14" selected>14 завершённых дней</option><option value="30">30 завершённых дней</option></select></label><label>Показатель<select id="category-sales-metric"><option value="sold">Продано, шт.</option><option value="returned">Возвраты / сторно, шт.</option><option value="net">Продано минус возвраты, шт.</option></select></label></div><p id="category-sales-filter-state" role="status"></p><p id="category-sales-state" role="status" aria-live="polite">Загружаем категории…</p><div id="category-sales-results" hidden><div id="category-sales-totals" class="category-sales-totals"></div><div id="category-sales-chart" class="category-sales-chart"></div><div id="category-sales-legend" class="category-sales-legend"></div><p class="footnote">Разрывы — неподтверждённые дни. Ноль показан только внутри подтверждённого периода. График учитывает выбранные площадку и магазин, включая архивные товары категории.</p><details><summary>Значения по дням и источники</summary><div class="table-wrap"><table><caption id="category-sales-table-caption"></caption><thead><tr><th>Дата</th><th class="numeric">Ozon, шт.</th><th class="numeric">WB, шт.</th><th class="numeric">Всего, шт.</th></tr></thead><tbody id="category-sales-rows"></tbody></table></div><div id="category-sales-sources"></div></details></div><p class="footnote">Это финансовая реализация, а не заказы: дата начисления Ozon и дата отчёта WB. Автоматические группы по названию; ручные категории имеют приоритет. «Все товары» включает также исторические SKU вне каталога. Ozon определяет единицы по сумме и цене; отрицательная реализация включает сторно.</p>`;

  function chart(metric) {
    const available = lines.filter(line => report.sources.some(s => line.key === 'total' || s.market === line.key));
    const values = report.series.flatMap(day => available.map(line => day[line.key]?.[metric]).filter(Number.isFinite));
    if (!values.length) { $('category-sales-chart').innerHTML = '<p class="category-sales-empty">За этот период нет подтверждённых количеств. Подробности — в источниках ниже.</p>'; return; }
    const w = 960, h = 250, left = 62, right = 20, top = 18, bottom = 34;
    const low = Math.min(0, ...values), high = Math.max(1, ...values), range = high - low;
    const x = i => left + i / Math.max(1, report.series.length - 1) * (w - left - right);
    const y = v => top + (high - v) / range * (h - top - bottom);
    const grid = [0, .5, 1].map(f => { const v = low + range * f; return `<line x1="${left}" x2="${w - right}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line, #34363b)"/><text x="${left - 10}" y="${y(v) + 4}" text-anchor="end">${esc(number.format(Math.round(v)))}</text>`; }).join('');
    const paths = available.map(line => {
      let path = '', open = false;
      for (let i = 0; i < report.series.length; i++) { const v = report.series[i][line.key]?.[metric]; if (!Number.isFinite(v)) { open = false; continue; } path += `${open ? 'L' : 'M'}${x(i)},${y(v)} `; open = true; }
      return `<path d="${path}" fill="none" stroke="${line.color}" stroke-width="${line.key === 'total' ? 3 : 2}" ${line.key === 'total' ? 'stroke-dasharray="7 4"' : ''}/>` + report.series.map((day, i) => { const v = day[line.key]?.[metric]; return Number.isFinite(v) ? `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${line.color}"><title>${esc(day.date + ' · ' + line.name + ': ' + display(v) + ' шт.')}</title></circle>` : ''; }).join('');
    }).join('');
    const indexes = [...new Set([0, Math.floor((report.series.length - 1) / 2), report.series.length - 1])];
    $('category-sales-chart').innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(labels[metric])} по дням; точные значения в таблице ниже"><g>${grid}${paths}${indexes.map(i => `<text x="${x(i)}" y="${h - 9}" text-anchor="middle">${short(report.series[i].date)}</text>`).join('')}</g></svg>`;
  }
  function render() {
    if (!report) return;
    const metric = $('category-sales-metric').value;
    $('category-sales-totals').innerHTML = lines.map(line => `<div><span>${line.name} · ${esc(labels[metric])}</span><strong>${display(report.totals[line.key]?.[metric])}<small> шт.</small></strong></div>`).join('');
    $('category-sales-legend').innerHTML = lines.map(line => `<span><i style="background:${line.color}"></i>${line.name}${line.key === 'total' ? ' · пунктир' : ''}</span>`).join('');
    $('category-sales-table-caption').textContent = labels[metric] + ' · ' + report.period.from + ' — ' + report.period.to;
    $('category-sales-rows').innerHTML = report.series.map(day => `<tr><td>${esc(day.date)}</td>${['Ozon', 'WB', 'total'].map(key => `<td class="numeric">${display(day[key]?.[metric])}</td>`).join('')}</tr>`).join('');
    $('category-sales-sources').innerHTML = report.sources.map(source => {
      const stamp = source.updatedAt && Number.isFinite(Date.parse(source.updatedAt)) ? new Date(source.updatedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК' : 'неизвестно';
      return `<p><strong>${esc(source.name)} · ${source.market}</strong> — подтверждено ${source.coveredDays} из ${source.totalDays} дней. Снимок: ${esc(stamp)}.${source.observedTo ? ' Последний отчёт: ' + esc(source.observedTo) + '.' : ''}${source.reasons.length ? '<br>' + source.reasons.map(esc).join(' ') : ''}</p>`;
    }).join('') + report.limitations.map(text => `<p class="footnote">${esc(text)}</p>`).join('');
    chart(metric);
  }
  async function load({ categoryReset = false } = {}) {
    const seq = ++generation;
    panel.setAttribute('aria-busy','true'); $('category-sales-state').textContent='Загружаем выбранную категорию…'; $('category-sales-results').hidden=true;
    controller?.abort(); controller = new AbortController();
    const query = new URLSearchParams({ category: $('category-sales-category').value, days: $('category-sales-days').value, market: $('category-sales-market').value, store: $('category-sales-store').value });
    try {
      const response = await fetch('/api/category-sales?' + query, { signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      if (seq !== generation) return;
      if (!response.ok) {
        if (!categoryReset && response.status === 400 && data.error === 'Категория не найдена' && $('category-sales-category').value) {
          $('category-sales-category').value = '';
          return load({ categoryReset: true });
        }
        throw Error(data.error || 'Не удалось загрузить продажи категорий');
      }
      report = data; panel.setAttribute('aria-busy','false');
      const category = $('category-sales-category'), current = category.value;
      const options = '<option value="">Все товары</option>' + data.categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)} · ${c.productCount} товаров</option>`).join('');
      if (category.innerHTML !== options) { category.innerHTML = options; category.value = current; }
      $('category-sales-results').hidden = !data.sources.length;
      $('category-sales-state').textContent = !data.sources.length ? 'В выбранной категории нет товаров для этой площадки или магазина. Проверьте назначения и фильтры; ручные категории настраиваются на странице поставщиков.' : `${data.period.from} — ${data.period.to} · ${data.productCount} товаров в каталоге · подтверждено ${data.coverage.coveredDays} из ${data.coverage.totalDays} дней${data.coverage.complete ? '.' : '. Итог за весь период неизвестен при пропусках.'}`;
      if (categoryReset) $('category-sales-state').textContent = 'Состав категорий изменился. Показаны все товары. ' + $('category-sales-state').textContent;
      render();
    } catch (error) {
      if (seq !== generation || error.name === 'AbortError') return;
      report = null; panel.setAttribute('aria-busy','false'); $('category-sales-results').hidden = true;
      $('category-sales-state').textContent = error.message;
    }
  }
  function renderStores() {
    const select = $('category-sales-store'), current = select.value, market = $('category-sales-market').value;
    const available = stores.filter(store => market === 'all' || store.market === market);
    select.innerHTML = '<option value="">Все магазины</option>' + available.map(store => `<option value="${esc(store.id)}">${esc(store.name)} · ${esc(store.market)}</option>`).join('');
    select.value = available.some(store => store.id === current) ? current : '';
  }
  async function loadStores() {
    try {
      const response = await fetch('/api/stores', { cache: 'no-store' });
      if (!response.ok) throw Error('Магазины недоступны');
      const value = await response.json();
      if (!Array.isArray(value)) throw Error('Некорректный список магазинов');
      stores = value.map(store => ({ id: String(store.id), name: store.name, market: String(store.id).startsWith('wb-') ? 'WB' : 'Ozon' }));
      renderStores(); $('category-sales-store').disabled = false;
      $('category-sales-filter-state').textContent = '';
    } catch {
      $('category-sales-filter-state').textContent = 'Список магазинов пока недоступен. Можно выбрать площадку; повторите через «Обновить данные».';
    }
  }
  $('category-sales-market').addEventListener('change', () => { renderStores(); void load(); });
  for (const id of ['category-sales-store', 'category-sales-category', 'category-sales-days']) $(id).addEventListener('change', () => void load());
  $('category-sales-metric').addEventListener('change', render);
  $('refresh')?.addEventListener('click', () => { void loadStores(); void load(); });
  window.addEventListener('pult:supplier-categories-changed', () => void load());
  window.addEventListener('focus', () => void load());
  void loadStores(); void load();
  setInterval(() => { if (!document.hidden) void load(); }, 30000);
})();
