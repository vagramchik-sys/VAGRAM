(function () {
  'use strict';

  var instances = new WeakMap();
  var number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  var integer = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function list(value) { return Array.isArray(value) ? value : []; }
  function dateValue(value) { var parsed = Date.parse(value || ''); return Number.isFinite(parsed) ? parsed : null; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function formatValue(value, unit) {
    if (!finite(value)) return '—';
    if (unit === 'rub') return integer.format(value) + '\u00a0₽';
    if (unit === 'percent') return (value > 0 ? '+' : '') + number.format(value) + '%';
    if (unit === 'orders') return integer.format(value) + '\u00a0заказов';
    if (unit === 'units') return integer.format(value) + '\u00a0шт.';
    return number.format(value);
  }

  function formatTime(value, timezone) {
    var timestamp = dateValue(value);
    if (timestamp == null) return '—';
    try {
      return new Intl.DateTimeFormat('ru-RU', {
        timeZone: timezone || 'Europe/Moscow', hour: '2-digit', minute: '2-digit'
      }).format(timestamp);
    } catch (_) { return '—'; }
  }

  function formatDate(value, timezone) {
    var timestamp = dateValue(value);
    if (timestamp == null) return '';
    try {
      return new Intl.DateTimeFormat('ru-RU', {
        timeZone: timezone || 'Europe/Moscow', day: 'numeric', month: 'long'
      }).format(timestamp);
    } catch (_) { return ''; }
  }

  function dayLabel(date, timezone) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? formatDate(date + 'T12:00:00+03:00', timezone) : '';
  }

  function dateKey(value, timezone) {
    var timestamp = typeof value === 'number' ? value : dateValue(value);
    if (timestamp == null) return '';
    try {
      var parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp);
      var result = {};
      parts.forEach(function (part) { result[part.type] = part.value; });
      return result.year + '-' + result.month + '-' + result.day;
    } catch (_) { return ''; }
  }

  function minuteOfDay(value, timezone) {
    var timestamp = dateValue(value);
    if (timestamp == null) return null;
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone || 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(timestamp);
      var values = {};
      parts.forEach(function (part) { values[part.type] = part.value; });
      return Number(values.hour) * 60 + Number(values.minute);
    } catch (_) { return null; }
  }

  function chartMinute(value, model) {
    var timestamp = dateValue(value), date = model && model.date;
    if (timestamp == null) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      var start = Date.parse(date + 'T00:00:00+03:00'), offset = (timestamp - start) / 60000;
      if (Number.isFinite(start) && offset >= 0 && offset <= 1440) return offset;
    }
    return minuteOfDay(value, model && model.timezone);
  }

  function destroy(host, empty) {
    var current = instances.get(host);
    if (current) {
      if (current.timer) clearInterval(current.timer);
      current.cleanups.forEach(function (cleanup) { cleanup(); });
      instances.delete(host);
    }
    if (empty) host.replaceChildren();
  }

  function stateMarkup(kind, title, message, action) {
    return '<section class="business-dynamics bd-state bd-state--' + kind + '" aria-live="polite">' +
      '<span class="bd-state__mark" aria-hidden="true"></span>' +
      '<div><strong>' + escapeHtml(title) + '</strong><p>' + escapeHtml(message) + '</p></div>' +
      (action ? '<button class="bd-retry" type="button">' + escapeHtml(action) + '</button>' : '') +
      '</section>';
  }

  function loading(host) {
    if (!host) return;
    destroy(host, false);
    host.innerHTML = '<section class="business-dynamics bd-loading" aria-busy="true" aria-live="polite">' +
      '<div class="bd-loading__head"><i></i><i></i></div><div class="bd-loading__kpis">' +
      '<i></i><i></i><i></i><i></i></div><div class="bd-loading__chart"></div>' +
      '<span class="bd-sr-only">Загружаем динамику бизнеса</span></section>';
  }

  function error(host, details) {
    if (!host) return;
    destroy(host, false);
    details = details || {};
    host.innerHTML = stateMarkup('error', 'Не удалось показать динамику', details.message || 'Обновите данные и попробуйте ещё раз.', details.retryLabel || 'Повторить');
    var retry = host.querySelector('.bd-retry');
    if (retry) retry.addEventListener('click', function () {
      host.dispatchEvent(new CustomEvent('business-dynamics:retry', { bubbles: true }));
    });
  }

  function normalizePoints(points, model, predicate) {
    return list(points).map(function (point, index) {
      return { point: point || {}, index: index, minute: chartMinute(point && point.at, model), timestamp: dateValue(point && point.at) };
    }).filter(function (entry) {
      return entry.minute != null && (!predicate || predicate(entry));
    }).sort(function (a, b) { return a.minute - b.minute; });
  }

  function segments(entries) {
    var result = [], current = [];
    entries.forEach(function (entry) {
      if (!finite(entry.point.cumulative)) {
        if (current.length) result.push(current);
        current = [];
      } else current.push(entry);
    });
    if (current.length) result.push(current);
    return result;
  }

  function chartMarkup(model, metric) {
    if (model.chartUnavailableReason) return '<div class="bd-chart-unavailable" role="status">' + escapeHtml(model.chartUnavailableReason) + '</div>';
    var timezone = model.timezone || 'Europe/Moscow';
    var asOf = dateValue(model.asOf);
    var today = normalizePoints(model.series && model.series.today, model, function (entry) {
      return asOf == null || entry.timestamp == null || entry.timestamp <= asOf;
    });
    var yesterday = normalizePoints(model.series && model.series.yesterday, model);
    var avg = model.historyAvailable === false ? [] : normalizePoints(model.series && model.series.avg7d, model);
    var forecast = normalizePoints(model.series && model.series.forecast, model, function (entry) {
      return asOf == null || entry.timestamp == null || entry.timestamp >= asOf;
    });
    var all = today.concat(yesterday, avg, forecast);
    var values = all.filter(function (entry) { return finite(entry.point.cumulative); }).map(function (entry) { return entry.point.cumulative; });
    var min = Math.min.apply(Math, values.concat([0])), max = Math.max.apply(Math, values.concat([0]));
    if (min === max) max = min + 1;
    var left = 62, top = 18, width = 910, height = 238, bottom = top + height;
    var finiteForecast = forecast.some(function (entry) { return finite(entry.point.cumulative); });
    var asOfMinute = chartMinute(model.asOf, model);
    var latestFactMinute = today.reduce(function (value, entry) { return finite(entry.point.cumulative) ? Math.max(value, entry.minute) : value; }, 0);
    var domain = finiteForecast ? 1440 : clamp(Math.max(asOfMinute || 0, latestFactMinute, 1), 1, 1440);
    var x = function (minute) { return left + clamp(minute, 0, domain) / domain * width; };
    var y = function (value) { return bottom - (value - min) / (max - min) * height; };
    function path(entries, step) {
      return segments(entries).map(function (part) {
        if (!part.length) return '';
        var d = 'M ' + x(part[0].minute).toFixed(2) + ' ' + y(part[0].point.cumulative).toFixed(2);
        for (var i = 1; i < part.length; i += 1) {
          var px = x(part[i].minute).toFixed(2), py = y(part[i].point.cumulative).toFixed(2);
          d += step ? ' H ' + px + ' V ' + py : ' L ' + px + ' ' + py;
        }
        return '<path d="' + d + '"></path>';
      }).join('');
    }
    var grid = [0, .25, .5, .75, 1].map(function (ratio) {
      var py = bottom - ratio * height, tick = min + (max - min) * ratio;
      return '<g><line x1="' + left + '" y1="' + py + '" x2="' + (left + width) + '" y2="' + py + '"></line>' +
        '<text x="' + (left - 10) + '" y="' + (py + 4) + '">' + escapeHtml(compact(tick)) + '</text></g>';
    }).join('');
    var tickStep = [15, 30, 60, 120, 180, 240, 360].find(function (step) { return step >= domain / 5; }) || 360;
    var tickMinutes = []; for (var tick = 0; tick <= domain; tick += tickStep) tickMinutes.push(tick);
    if (domain - tickMinutes[tickMinutes.length - 1] >= tickStep / 2) tickMinutes.push(Math.round(domain));
    var hours = tickMinutes.map(function (minute) {
      return '<text x="' + x(minute) + '" y="' + (bottom + 28) + '" text-anchor="middle">' +
        String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0') + '</text>';
    }).join('');
    var forecastBand = finiteForecast && asOfMinute != null ? '<rect class="bd-chart__forecast-band" x="' + x(asOfMinute) + '" y="' + top + '" width="' + Math.max(0, left + width - x(asOfMinute)) + '" height="' + height + '"><title>' + escapeHtml(model.forecastLabel || 'Прогноз до 24:00') + '</title></rect><text class="bd-chart__forecast-label" x="' + (x(asOfMinute) + 10) + '" y="' + (top + 16) + '">Прогноз</text>' : '';
    var eventMarkers = list(model.events).map(function (event, index) { return { event: event, index: index }; }).filter(function (entry) {
      var timestamp = dateValue(entry.event && entry.event.at);
      return timestamp != null && (asOf == null || timestamp <= asOf);
    }).slice(0, 48).map(function (entry) {
      var event = entry.event, index = entry.index;
      var minute = chartMinute(event && event.at, model);
      if (minute == null) return '';
      return '<g class="bd-event" tabindex="0" role="button" data-event-index="' + index + '" aria-label="Событие ' + escapeHtml(formatTime(event.at, timezone) + ': ' + (event.label || 'Без названия')) + '">' +
        '<line x1="' + x(minute) + '" y1="' + top + '" x2="' + x(minute) + '" y2="' + bottom + '"></line>' +
        '<circle cx="' + x(minute) + '" cy="' + (top + 7) + '" r="5"></circle></g>';
    }).join('');
    var incompleteNote = today.some(function (entry) { return finite(entry.point.cumulative) && entry.point.complete === false; }) ? '<p class="bd-chart__coverage">Известные значения · покрытие неполное</p>' : '';
    var historyNote = model.historyAvailable === false ? '<p class="bd-chart__history">Среднее за 7 дней пока недоступно.</p>' : '';
    return incompleteNote + '<div class="bd-chart-wrap"><svg class="bd-chart" viewBox="0 0 1000 304" role="img" tabindex="0" data-active-index="0" data-min="' + min + '" data-max="' + max + '" data-domain="' + domain + '" aria-label="Динамика ' + escapeHtml(metric.label || 'показателя') + ' в течение дня. Используйте стрелки для просмотра точек.">' +
      forecastBand + '<g class="bd-chart__grid">' + grid + hours + '</g>' +
      '<g class="bd-chart__line bd-chart__line--yesterday">' + path(yesterday, true) + '</g>' +
      '<g class="bd-chart__line bd-chart__line--average">' + path(avg, true) + '</g>' +
      '<g class="bd-chart__line bd-chart__line--forecast">' + path(forecast, false) + '</g>' +
      '<g class="bd-chart__line bd-chart__line--today">' + path(today, true) + '</g>' + eventMarkers +
      '<line class="bd-chart__cursor" x1="0" y1="' + top + '" x2="0" y2="' + bottom + '" hidden></line><circle class="bd-chart__focus" cx="0" cy="0" r="4" hidden></circle></svg>' +
      '<div class="bd-tooltip" role="status" hidden></div></div>' + historyNote +
      '<script type="application/json" class="bd-points">' + safeJson(today.filter(function (entry) { return finite(entry.point.cumulative); }).slice(-192).map(function (entry) { return entry.point; })) + '</script>';
  }

  function compact(value) {
    if (!finite(value)) return '—';
    if (Math.abs(value) >= 1000000) return number.format(value / 1000000) + 'м';
    if (Math.abs(value) >= 1000) return number.format(value / 1000) + 'к';
    return integer.format(value);
  }

  function safeJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  }

  function kpiMarkup(model, metric, currentDay, periodLabel) {
    var kpis = model.kpis || {};
    var entries = [
      [periodLabel || (currentDay ? 'Сегодня' : 'Выбранный день'), kpis.today, metric.unit],
      [currentDay ? 'Вчера к этому времени' : 'Предыдущий день к этому времени', kpis.yesterdayAtSameTime, metric.unit],
      ['Темп', kpis.pace, 'percent'],
      ['Прогноз', kpis.forecast, metric.unit]
    ];
    return entries.map(function (entry, index) {
      var data = entry[1] || {}, unavailable = !finite(data.value) || (index === 3 && data.available === false);
      return '<article class="bd-kpi' + (unavailable ? ' is-unavailable' : '') + '"><span>' + escapeHtml(entry[0]) + '</span>' +
        '<strong>' + escapeHtml(formatValue(unavailable ? null : data.value, entry[2])) + '</strong>' +
        '<small>' + escapeHtml(data.subtitle || data.reason || (unavailable ? 'Нет подтверждённых данных' : '')) + '</small></article>';
    }).join('');
  }

  function velocityMarkup(model, metric) {
    var asOf = dateValue(model.asOf);
    var values = list(model.velocity).filter(function (item) {
      var from = dateValue(item && item.from);
      return asOf == null || from == null || from <= asOf;
    }).slice(0, 96), known = values.filter(function (item) { return finite(item && item.value); });
    if (!values.length) return '<div class="bd-mini-empty">Нет данных по 15-минутным интервалам</div>';
    if (!known.length) return '<div class="bd-mini-empty">Нет данных по 15-минутным интервалам</div>' +
      '<p class="bd-velocity__comparison">' + escapeHtml((model.velocityComparison && model.velocityComparison.reason) || 'Сравнение недоступно') + '</p>';
    var max = known.reduce(function (result, item) { return Math.max(result, Math.abs(item.value)); }, 0) || 1;
    var bars = values.map(function (item, index) {
      var available = finite(item && item.value), size = available ? Math.max(3, Math.abs(item.value) / max * 100) : 0;
      var label = formatTime(item && item.from, model.timezone) + '–' + formatTime(item && item.to, model.timezone) + ': ' + formatValue(item && item.value, metric.unit);
      return '<i class="bd-velocity__bar' + (item && item.complete === false ? ' is-partial' : '') + (!available ? ' is-missing' : '') + '" data-velocity-index="' + index + '" style="--bar:' + size.toFixed(2) + '%" title="' + escapeHtml(label) + '"></i>';
    }).join('');
    var comparison = model.velocityComparison || {};
    return '<div class="bd-velocity" role="img" aria-label="Скорость за интервалы по 15 минут">' + bars + '</div>' +
      '<p class="bd-velocity__comparison">' + escapeHtml(finite(comparison.value) ? formatValue(comparison.value, 'percent') + ' ' + (model.comparisonLabel || 'к сравнению') : comparison.reason || 'Сравнение недоступно') + '</p>';
  }

  function storesMarkup(model, metric) {
    var stores = list(model.stores).slice(0, 40);
    if (!stores.length) return '';
    return '<section class="bd-stores" aria-label="Вклад магазинов"><div class="bd-section-title"><h3>Вклад магазинов</h3><span>' + escapeHtml(metric.label || '') + '</span></div><div class="bd-stores__list">' + stores.map(function (store) {
      var market = String(store && store.market || '').toUpperCase();
      return '<article class="bd-store' + (store && store.complete === false ? ' is-partial' : '') + '"><i class="bd-store__market bd-store__market--' + escapeHtml(market.toLowerCase()) + '">' + escapeHtml(market || '—') + '</i><div><strong>' + escapeHtml(store && store.name || 'Магазин') + '</strong><small>' + escapeHtml(store && store.complete === false ? 'Неполные данные' : formatTime(store && store.updatedAt, model.timezone)) + '</small></div><b>' + escapeHtml(formatValue(store && store.value, metric.unit)) + '</b></article>';
    }).join('') + '</div></section>';
  }

  function tooltipMarkup(point, model, metric) {
    var rows = [
      ['Накопительно', tooltipValue(point.cumulative, metric.unit)],
      ['Последние 15 минут', tooltipValue(point.last15, metric.unit)],
      ['Заказы с начала дня', tooltipValue(point.orders, 'orders')],
      ['Средний чек с начала дня', tooltipValue(point.avgCheck, 'rub')],
      ['Вчера', tooltipValue(point.yesterday, metric.unit)],
      ['Дельта', tooltipValue(point.vsYesterdayPct, 'percent')],
      ['Ozon', tooltipValue(point.ozon, metric.unit)],
      ['WB', tooltipValue(point.wb, metric.unit)]
    ];
    return '<strong>' + escapeHtml(formatTime(point.at, model.timezone)) + '</strong><dl>' + rows.map(function (row) {
      return '<div><dt>' + escapeHtml(row[0]) + '</dt><dd>' + escapeHtml(row[1]) + '</dd></div>';
    }).join('') + '</dl>' + (point.basis ? '<p>' + escapeHtml(basisLabel(point.basis)) + '</p>' : '');
  }

  function tooltipValue(value, unit) { return finite(value) ? formatValue(value, unit) : 'Нет данных'; }
  function basisLabel(value) {
    if (value === 'order-time') return 'Интервалы по времени заказа';
    if (value === 'observation') return 'Накопительный снимок на время загрузки';
    return String(value || '');
  }

  function detailMarkup(title, body) {
    return '<div class="bd-detail__head"><strong>' + escapeHtml(title) + '</strong><button type="button" data-detail-close aria-label="Закрыть подробности">×</button></div>' + body;
  }

  function noticesMarkup(notices) {
    if (!notices.length) return '';
    var rows = notices.map(function (notice) { return '<p>' + escapeHtml(notice) + '</p>'; }).join('');
    if (notices.length > 2) return '<details class="bd-notices"><summary>Ограничения данных · ' + notices.length + '</summary><div>' + rows + '</div></details>';
    return '<div class="bd-notices">' + rows + '</div>';
  }

  function render(host, model) {
    if (!host) throw new TypeError('PultBusinessDynamicsView.render: host is required');
    model = model || {};
    destroy(host, false);
    var metric = model.metric || { label: 'Оборот', unit: 'rub' };
    if (model.state === 'empty') {
      var emptyPeriod = model.periodLabel || dayLabel(model.date, model.timezone) || 'выбранный период';
      var emptyReasons = [model.chartUnavailableReason].concat(list(model.notices)).filter(Boolean);
      host.innerHTML = stateMarkup('empty', 'Нет данных: ' + emptyPeriod, emptyReasons.join(' ') || 'Показатели появятся после первого подтверждённого интервала.');
      return;
    }
    var partial = model.state === 'partial' || list(model.notices).length > 0;
    var currentDay = model.date === dateKey(Date.now(), model.timezone);
    var selectedDayLabel = dayLabel(model.date, model.timezone) || model.date || 'Выбранный день';
    var periodLabel = model.periodLabel || (currentDay ? 'Сегодня' : selectedDayLabel);
    var dateLabel = formatDate(model.asOf, model.timezone) || selectedDayLabel;
    var notices = list(model.notices);
    host.innerHTML = '<section class="business-dynamics' + (partial ? ' is-partial' : '') + '" data-updated-at="' + escapeHtml(model.updatedAt || '') + '">' +
      '<header class="bd-head"><div><span class="bd-eyebrow">Динамика бизнеса</span><h2>' + escapeHtml(metric.label || 'Оборот') + '</h2><p>' + escapeHtml(dateLabel) + ' · факты на <time>' + escapeHtml(formatTime(model.asOf, model.timezone)) + '</time></p></div>' +
      '<div class="bd-freshness" role="status"><i></i><span>Проверяем свежесть…</span></div></header>' +
      noticesMarkup(notices) +
      '<div class="bd-kpis">' + kpiMarkup(model, metric, currentDay, periodLabel) + '</div>' +
      '<section class="bd-main"><div class="bd-main__chart"><div class="bd-section-title"><div><h3>' + escapeHtml(model.chartUnavailableReason ? periodLabel : periodLabel + ' по времени') + '</h3><p>' + escapeHtml(model.chartUnavailableReason ? 'Доступен подтверждённый итог периода' : 'Факт показан только до общего среза данных') + '</p></div>' + (model.chartUnavailableReason ? '' : '<div class="bd-legend"><span class="is-today">' + escapeHtml(periodLabel) + '</span><span class="is-yesterday">Предыдущий день</span><span class="is-average">Среднее 7 дней</span><span class="is-forecast">Прогноз</span></div>') + '</div>' + chartMarkup(model, metric) + '</div>' +
      '<aside class="bd-side"><section><div class="bd-section-title"><div><h3>Скорость</h3><p>' + escapeHtml(metric.unit === 'rub' ? '₽ / 15 минут' : (metric.label || '') + ' / 15 минут') + '</p></div></div>' + velocityMarkup(model, metric) + '</section>' + storesMarkup(model, metric) + '</aside></section>' +
      '<section class="bd-detail" aria-live="polite" hidden></section></section>';

    var root = host.querySelector('.business-dynamics');
    var chart = root.querySelector('.bd-chart');
    var tooltip = root.querySelector('.bd-tooltip');
    var detail = root.querySelector('.bd-detail');
    var pointsScript = root.querySelector('.bd-points');
    var points = [];
    try { points = JSON.parse(pointsScript ? pointsScript.textContent : '[]'); } catch (_) { points = []; }
    if (pointsScript) pointsScript.remove();
    var cleanups = [];
    var pinned = false;

    function showPoint(index, pin) {
      if (!points.length || !chart || !tooltip) return;
      index = clamp(index, 0, points.length - 1);
      chart.dataset.activeIndex = String(index);
      var point = points[index], minute = chartMinute(point.at, model);
      var min = Number(chart.dataset.min), max = Number(chart.dataset.max), domain = Number(chart.dataset.domain);
      if (!finite(min)) min = 0;
      if (!finite(max) || max === min) max = min + 1;
      if (!finite(domain) || domain <= 0) domain = 1440;
      var cx = 62 + clamp(minute == null ? 0 : minute, 0, domain) / domain * 910;
      var cy = 256 - (point.cumulative - min) / (max - min) * 238;
      var cursor = chart.querySelector('.bd-chart__cursor'), focus = chart.querySelector('.bd-chart__focus');
      cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.removeAttribute('hidden');
      focus.setAttribute('cx', cx); focus.setAttribute('cy', cy); focus.removeAttribute('hidden');
      tooltip.innerHTML = tooltipMarkup(point, model, metric); tooltip.hidden = false;
      tooltip.style.left = clamp(cx / 10, 12, 88) + '%';
      if (pin) {
        pinned = true; detail.hidden = false;
        detail.innerHTML = detailMarkup('Точка ' + formatTime(point.at, model.timezone), tooltipMarkup(point, model, metric));
      }
    }

    function nearestPoint(clientX) {
      if (!chart || !points.length) return 0;
      var rect = chart.getBoundingClientRect(), viewX = (clientX - rect.left) / rect.width * 1000;
      var ratio = clamp((viewX - 62) / 910, 0, 1), target = ratio * (Number(chart.dataset.domain) || 1440);
      var result = 0, distance = Infinity;
      points.forEach(function (point, index) {
        var minute = chartMinute(point.at, model), next = Math.abs((minute == null ? 0 : minute) - target);
        if (next < distance) { result = index; distance = next; }
      });
      return result;
    }

    function onPointer(event) {
      if (event.target.closest && event.target.closest('[data-event-index]')) return;
      showPoint(nearestPoint(event.clientX), event.type === 'click');
    }
    function onChartFocus() { showPoint(Number(chart.dataset.activeIndex) || 0, false); }
    function onKey(event) {
      var eventMarker = event.target.closest && event.target.closest('[data-event-index]');
      if (eventMarker && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); showEvent(Number(eventMarker.dataset.eventIndex)); return;
      }
      if (event.target !== chart || !points.length) return;
      var index = Number(chart.dataset.activeIndex) || 0;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); showPoint(index + (event.key === 'ArrowLeft' ? -1 : 1), false);
      } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showPoint(index, true); }
    }
    function showEvent(index) {
      var event = list(model.events)[index];
      if (!event) return;
      pinned = true; detail.hidden = false;
      detail.innerHTML = detailMarkup(event.label || 'Событие', '<p class="bd-detail__meta">' + escapeHtml(formatTime(event.at, model.timezone) + (event.kind ? ' · ' + event.kind : '')) + '</p><p>' + escapeHtml(event.detail || 'Без дополнительных подробностей') + '</p>');
    }
    function onRootClick(event) {
      var marker = event.target.closest('[data-event-index]');
      if (marker) { showEvent(Number(marker.dataset.eventIndex)); return; }
      if (event.target.closest('[data-detail-close]')) { pinned = false; detail.hidden = true; detail.replaceChildren(); }
    }
    if (chart) {
      chart.addEventListener('pointermove', onPointer); chart.addEventListener('click', onPointer); chart.addEventListener('focus', onChartFocus);
      cleanups.push(function () { chart.removeEventListener('pointermove', onPointer); chart.removeEventListener('click', onPointer); chart.removeEventListener('focus', onChartFocus); });
    }
    root.addEventListener('click', onRootClick); root.addEventListener('keydown', onKey);
    cleanups.push(function () { root.removeEventListener('click', onRootClick); root.removeEventListener('keydown', onKey); });

    function updateFreshness() {
      var node = root.querySelector('.bd-freshness'), timestamp = dateValue(model.updatedAt);
      if (!node) return;
      if (timestamp == null) { node.className = 'bd-freshness is-stale'; node.querySelector('span').textContent = 'Свежесть источников неизвестна'; return; }
      var age = Date.now() - timestamp, minutes = Math.max(0, Math.floor(age / 60000)), stale = age > 5 * 60000;
      node.className = 'bd-freshness' + (stale ? ' is-stale' : '');
      node.querySelector('span').textContent = stale ? 'Данные устарели · ' + minutes + ' мин.' : 'Обновлено ' + (minutes < 1 ? 'только что' : minutes + ' мин. назад');
    }
    updateFreshness();
    var timer = setInterval(updateFreshness, 30000);
    instances.set(host, { timer: timer, cleanups: cleanups });
  }

  function clear(host) { if (host) destroy(host, true); }

  window.PultBusinessDynamicsView = { render: render, loading: loading, error: error, clear: clear };
}());
