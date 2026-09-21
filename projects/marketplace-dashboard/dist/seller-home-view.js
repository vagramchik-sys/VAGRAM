(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PultSellerHomeView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var esc = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  };
  var finite = function (value) { return typeof value === 'number' && Number.isFinite(value); };
  var number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  var money = function (value) { return finite(value) ? number.format(value) + ' ₽' : '—'; };
  var metric = function (source) {
    var item = source && typeof source === 'object' ? source : {};
    return {
      value: finite(item.value) ? item.value : null,
      text: finite(item.value) && item.text ? String(item.text) : '—',
      comparison: finite(item.value) && item.comparison ? String(item.comparison) : '',
      tone: item.tone === 'up' || item.tone === 'down' ? item.tone : ''
    };
  };
  var dateText = function (value) {
    if (!value) return '—';
    var parsed = new Date(String(value).slice(0, 10) + 'T12:00:00Z');
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };
  var fullDateText = function (value) {
    if (!value) return '—';
    var parsed = new Date(String(value).slice(0, 10) + 'T12:00:00Z');
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  };

  function periodLabel(period) {
    if (!period || (!period.from && !period.to)) return 'Период не выбран';
    if (period.from === period.to) return fullDateText(period.from);
    return dateText(period.from) + ' — ' + fullDateText(period.to);
  }

  function comparison(item) {
    if (!item.comparison) return '';
    var icon = item.tone === 'up' ? '↑' : item.tone === 'down' ? '↓' : '';
    return '<span class="sh-comparison' + (item.tone ? ' is-' + item.tone : '') + '">' + icon + esc(item.comparison) + '</span>';
  }

  function metricBlock(label, item, extraClass) {
    return '<div class="sh-total ' + (extraClass || '') + '"><span>' + esc(label) + '</span><strong>' + esc(item.text) + '</strong>' + comparison(item) + '</div>';
  }

  function seriesRuns(points, key, x, y) {
    var runs = [], current = [];
    points.forEach(function (point, index) {
      if (finite(point[key])) current.push([x(index), y(point[key])]);
      else if (current.length) { runs.push(current); current = []; }
    });
    if (current.length) runs.push(current);
    return runs;
  }

  function chart(daily) {
    var points = Array.isArray(daily) ? daily.map(function (row) {
      return {
        date: row && row.date ? String(row.date) : '',
        orderedRevenue: finite(row && row.orderedRevenue) ? row.orderedRevenue : null,
        realized: finite(row && row.realized) ? row.realized : null
      };
    }) : [];
    var values = [];
    points.forEach(function (point) {
      if (finite(point.orderedRevenue)) values.push(point.orderedRevenue);
      if (finite(point.realized)) values.push(point.realized);
    });
    if (!points.length || !values.length) {
      return '<div class="sh-chart-empty">Нет данных по дням за выбранный период.</div>';
    }

    var width = 920, height = 286, left = 20, right = 80, top = 18, bottom = 38;
    var min = Math.min(0, Math.min.apply(Math, values));
    var max = Math.max(0, Math.max.apply(Math, values));
    if (min === max) { min -= 1; max += 1; }
    var spread = max - min;
    min -= spread * 0.08;
    max += spread * 0.08;
    var innerWidth = width - left - right, innerHeight = height - top - bottom;
    var x = function (index) { return left + (points.length === 1 ? innerWidth / 2 : index * innerWidth / (points.length - 1)); };
    var y = function (value) { return top + (max - value) * innerHeight / (max - min); };
    var zeroY = Math.max(top, Math.min(height - bottom, y(0)));
    var orderedRuns = seriesRuns(points, 'orderedRevenue', x, y);
    var realizedRuns = seriesRuns(points, 'realized', x, y);
    var linePath = function (run) { return run.map(function (point, index) { return (index ? 'L' : 'M') + point[0].toFixed(1) + ' ' + point[1].toFixed(1); }).join(' '); };
    var areas = orderedRuns.map(function (run) {
      var line = linePath(run);
      return '<path class="sh-chart-area" d="' + line + ' L' + run[run.length - 1][0].toFixed(1) + ' ' + zeroY.toFixed(1) + ' L' + run[0][0].toFixed(1) + ' ' + zeroY.toFixed(1) + ' Z"/>';
    }).join('');
    var orderedLines = orderedRuns.map(function (run) { return '<path class="sh-line sh-line-ordered" d="' + linePath(run) + '"/>'; }).join('');
    var realizedLines = realizedRuns.map(function (run) { return '<path class="sh-line sh-line-realized" d="' + linePath(run) + '"/>'; }).join('');
    var tickCount = Math.min(6, points.length);
    var tickIndexes = [];
    for (var tick = 0; tick < tickCount; tick += 1) {
      var tickIndex = Math.round(tick * (points.length - 1) / Math.max(1, tickCount - 1));
      if (tickIndexes.indexOf(tickIndex) === -1) tickIndexes.push(tickIndex);
    }
    var ticks = tickIndexes.map(function (index) {
      return '<text x="' + x(index).toFixed(1) + '" y="' + (height - 10) + '" text-anchor="middle">' + esc(dateText(points[index].date)) + '</text>';
    }).join('');
    var scaleLabel = function (value) { return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value); };
    var grid = [0.2, 0.5, 0.8].map(function (ratio) {
      var gy = top + innerHeight * ratio;
      return '<line x1="' + left + '" y1="' + gy.toFixed(1) + '" x2="' + (width - right) + '" y2="' + gy.toFixed(1) + '"/><text class="sh-scale" x="' + (width - right + 10) + '" y="' + (gy + 4).toFixed(1) + '">' + esc(scaleLabel(max - (max - min) * ratio)) + '</text>'; 
    }).join('');
    if (min < 0 && max > 0) grid += '<line class="sh-zero" x1="' + left + '" y1="' + zeroY.toFixed(1) + '" x2="' + (width - right) + '" y2="' + zeroY.toFixed(1) + '"/>';
    var pointMarkup = points.map(function (point, index) {
      return ['orderedRevenue', 'realized'].map(function (key) {
        if (!finite(point[key])) return '';
        var label = key === 'orderedRevenue' ? 'Заказано' : 'Реализовано';
        var css = key === 'orderedRevenue' ? 'sh-point-ordered' : 'sh-point-realized';
        return '<circle class="sh-point ' + css + '" cx="' + x(index).toFixed(1) + '" cy="' + y(point[key]).toFixed(1) + '" r="4" tabindex="0"><title>' + esc(fullDateText(point.date) + ' · ' + label + ': ' + money(point[key])) + '</title></circle>';
      }).join('');
    }).join('');
    var rows = points.map(function (point) {
      return '<tr><th scope="row">' + esc(fullDateText(point.date)) + '</th><td>' + esc(money(point.orderedRevenue)) + '</td><td>' + esc(money(point.realized)) + '</td></tr>';
    }).join('');
    return '<div class="sh-chart-wrap"><svg class="sh-chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-labelledby="sh-chart-title sh-chart-desc"><title id="sh-chart-title">Заказано и реализовано по дням</title><desc id="sh-chart-desc">Линейный график. Пропуски данных показаны разрывами.</desc><g class="sh-grid">' + grid + '</g>' + areas + orderedLines + realizedLines + pointMarkup + '<g class="sh-ticks">' + ticks + '</g></svg></div><details class="sh-data"><summary>Данные графика таблицей</summary><div><table><thead><tr><th>Дата</th><th>Заказано</th><th>Реализовано</th></tr></thead><tbody>' + rows + '</tbody></table></div></details>';
  }

  var ALERTS = {
    stockout: { label: 'Товары закончились', symbol: '!' },
    cost: { label: 'Не указана себестоимость', symbol: '₽' },
    negative: { label: 'Отрицательный результат', symbol: '−' },
    logistics: { label: 'Проверьте логистику', symbol: '↗' }
  };

  function alerts(items) {
    var source = Array.isArray(items) ? items : [];
    var normalized = source.filter(function (item) { return item && ALERTS[item.id]; }).map(function (item) {
      var preset = ALERTS[item.id];
      return {
        id: item.id,
        label: item.label ? String(item.label) : preset.label,
        symbol: preset.symbol,
        count: finite(item.count) ? item.count : null
      };
    });
    if (!normalized.length) return '<p class="sh-empty-note">Нет задач по доступным данным.</p>';
    return normalized.map(function (item) {
      return '<a class="sh-task" href="/?view=analytics" data-home-filter="' + esc(item.id) + '"><span class="sh-task-icon" aria-hidden="true">' + esc(item.symbol) + '</span><span>' + esc(item.label) + '</span><strong>' + (item.count == null ? '—' : esc(number.format(item.count))) + '</strong><span class="sh-arrow" aria-hidden="true">›</span></a>';
    }).join('');
  }

  function controls(model) {
    var range = ['today', 'yesterday', '7', '14', '28', '30', 'custom'].indexOf(model.range) >= 0 ? model.range : 'custom';
    var labels = {
      today: 'Сегодня', yesterday: 'Вчера', '7': '7 завершённых дней', '14': '14 завершённых дней', '28': '28 завершённых дней',
      '30': '30 дней, включая сегодня', custom: periodLabel(model.period)
    };
    var options = Object.keys(labels).filter(function (value) { return value !== 'custom' || range === 'custom'; }).map(function (value) {
      return '<option value="' + value + '"' + (value === range ? ' selected' : '') + '>' + esc(labels[value]) + '</option>';
    }).join('');
    return '<div class="sh-controls"><label><span>Период</span><select data-home-period aria-label="Период главной страницы">' + options + '</select></label><button class="sh-refresh" type="button" data-home-refresh aria-label="Обновить данные"><span aria-hidden="true">↻</span><span>Обновить</span></button></div>';
  }

  function stateView(model) {
    var state = model.state || 'loading';
    var defaults = {
      loading: ['Собираем главную страницу', 'Загружаем данные выбранного кабинета и периода.'],
      error: ['Не удалось загрузить данные', 'Повторите загрузку или откройте аналитику, чтобы проверить доступность отчётов.'],
      unsupported: ['Для выбранной площадки эта главная пока недоступна', 'Откройте экономику Wildberries или выберите кабинет Ozon в общих фильтрах.']
    };
    var copy = defaults[state] || defaults.error;
    var message = model.message ? String(model.message) : copy[1];
    var action = state === 'unsupported'
      ? '<a class="sh-primary-action" href="/?view=wb-economics">Открыть экономику Wildberries</a>'
      : state === 'error'
        ? '<button class="sh-primary-action" type="button" data-home-refresh>Повторить загрузку</button><a class="sh-secondary-action" href="/?view=analytics">Открыть аналитику</a>'
        : '<span class="sh-loader" aria-hidden="true"></span>';
    return '<div class="sh-content is-' + esc(state) + '" aria-live="polite" aria-busy="' + (state === 'loading' ? 'true' : 'false') + '"><div class="sh-state"><span class="sh-state-mark" aria-hidden="true">' + (state === 'error' ? '!' : state === 'unsupported' ? '↗' : '') + '</span><h1>' + esc(copy[0]) + '</h1><p>' + esc(message) + '</p><div class="sh-state-actions">' + action + '</div></div></div>';
  }

  function render(input) {
    var model = input && typeof input === 'object' ? input : { state: 'loading' };
    if (model.state !== 'ready') return stateView(model);
    var metrics = model.metrics && typeof model.metrics === 'object' ? model.metrics : {};
    var orderedRevenue = metric(metrics.orderedRevenue);
    var orderedUnits = metric(metrics.orderedUnits);
    var realized = metric(metrics.realized);
    var net = metric(metrics.net);
    var ads = metric(metrics.ads);
    var stocks = metric(metrics.stocks);
    var stores = finite(model.stores) ? Math.max(0, model.stores) : null;
    var supporting = [
      ['Реклама', ads, '/?view=economics'],
      ['Известные остатки', stocks, '/?view=products'],
      ['Магазины', { text: stores == null ? '—' : number.format(stores), comparison: '', tone: '' }, '/?view=stores']
    ].map(function (item) {
      return '<a class="sh-mini-metric" href="' + item[2] + '"><span>' + item[0] + '</span><strong>' + esc(item[1].text) + '</strong><i aria-hidden="true">›</i></a>';
    }).join('');
    var scope = model.scope ? String(model.scope) : 'Ozon';
    return '<div class="sh-content" aria-label="Главная продавца"><header class="sh-head"><div><span class="sh-kicker">ГЛАВНАЯ</span><h1>Пульс продаж</h1><p>' + esc(scope) + ' · ' + esc(periodLabel(model.period)) + '</p></div>' + controls(model) + '</header><div class="sh-layout"><article class="sh-card sh-sales"><div class="sh-card-cap"><div><span class="sh-card-label">Продажи</span><h2>Заказано и реализовано</h2></div><div class="sh-legend" aria-label="Легенда"><span><i class="is-ordered"></i>Заказано</span><span><i class="is-realized"></i>Реализовано</span></div></div>' + chart(model.daily) + '<div class="sh-totals">' + metricBlock('Заказано', orderedRevenue) + metricBlock('Товаров заказано', orderedUnits) + metricBlock('Реализовано', realized) + '</div></article><aside class="sh-side"><article class="sh-card sh-finance"><div class="sh-side-heading"><span class="sh-card-label">Финансы</span><a href="/?view=finance">Подробнее <span aria-hidden="true">›</span></a></div><h2>Итог начислений</h2><strong class="sh-finance-value">' + esc(net.text) + '</strong>' + comparison(net) + '<p>После удержаний Ozon · не чистая прибыль</p></article><article class="sh-card sh-tasks"><div class="sh-side-heading"><div><span class="sh-card-label">Задачи</span><h2>Требуют внимания</h2></div><a href="/?view=analytics" data-home-filter="">Все <span aria-hidden="true">›</span></a></div><div class="sh-task-list">' + alerts(model.alerts) + '</div></article></aside></div><nav class="sh-quick" aria-label="Быстрые переходы"><a href="/?view=overview&amp;section=business-chart"><span aria-hidden="true">⌁</span><strong>Графики бизнеса</strong><i aria-hidden="true">›</i></a><a href="/?view=economics"><span aria-hidden="true">₽</span><strong>Юнит-экономика</strong><i aria-hidden="true">›</i></a><a href="/?view=stores"><span aria-hidden="true">◇</span><strong>Магазины</strong><i aria-hidden="true">›</i></a><a href="/?view=wb-economics"><span aria-hidden="true">W</span><strong>Экономика WB</strong><i aria-hidden="true">›</i></a></nav><section class="sh-banner"><div><span class="sh-kicker">СВЕЖЕСТЬ ДАННЫХ</span><h2>Данные ваших магазинов</h2><p class="sh-freshness">' + esc(model.freshness || 'Время обновления уточняется') + '</p><p>' + esc(model.coverageNote || 'Полный период по всем выбранным магазинам Ozon. Заказы — до отмен и возвратов; реализация — по дате начисления.') + '</p></div><a href="/?view=finance">Проверить начисления <span aria-hidden="true">→</span></a></section><div class="sh-supporting" aria-label="Дополнительные показатели">' + supporting + '</div></div>';
  }

  return { render: render };
});
