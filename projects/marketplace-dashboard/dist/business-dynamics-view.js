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
    if (unit === 'share') return number.format(value) + '%';
    if (unit === 'orders') return integer.format(value) + '\u00a0заказов';
    if (unit === 'units') return integer.format(value) + '\u00a0шт.';
    return number.format(value);
  }

  function signedMoney(value) {
    return finite(value) ? (value > 0 ? '+' : value < 0 ? '−' : '') + formatValue(Math.abs(value), 'rub') : '—';
  }

  function miniTrend(points, label, type) {
    var values = list(points).map(function (point) { return typeof point === 'number' ? point : point && point.cumulative; }).filter(finite).slice(-14);
    if (values.length < 2) return '';
    var low = Math.min.apply(Math, values), high = Math.max.apply(Math, values);
    if (low === high) high = low + 1;
    var coords = values.map(function (value, index) {
      return (index * 86 / (values.length - 1)).toFixed(1) + ',' + (27 - (value - low) / (high - low) * 22).toFixed(1);
    }).join(' ');
    return '<svg class="bd-mini-trend bd-mini-trend--' + escapeHtml(type || 'blue') + '" viewBox="0 0 88 30" role="img" aria-label="' + escapeHtml(label) + '"><polyline points="' + coords + '"></polyline></svg>';
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
      '<i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="bd-loading__chart"></div>' +
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
    var target = metric.unit === 'rub' && finite(model.executive && model.executive.target) ? model.executive.target : null;
    var values = all.filter(function (entry) { return finite(entry.point.cumulative); }).map(function (entry) { return entry.point.cumulative; });
    if (finite(target)) values.push(target);
    var min = Math.min.apply(Math, values.concat([0])), max = Math.max.apply(Math, values.concat([0]));
    if (min === max) max = min + 1;
    var left = 62, top = 24, width = 910, height = metric.key === 'orderedRevenue' ? 170 : 340, bottom = top + height;
    var finiteForecast = forecast.some(function (entry) { return finite(entry.point.cumulative); });
    var asOfMinute = chartMinute(model.asOf, model);
    var latestFact = today.filter(function (entry) { return finite(entry.point.cumulative); }).at(-1);
    var domain = 1440;
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
    var tickStep = metric.key === 'orderedRevenue' ? 180 : ([15, 30, 60, 120, 180, 240, 360].find(function (step) { return step >= domain / 5; }) || 360);
    var tickMinutes = []; for (var tick = 0; tick <= domain; tick += tickStep) tickMinutes.push(tick);
    if (domain - tickMinutes[tickMinutes.length - 1] >= tickStep / 2) tickMinutes.push(Math.round(domain));
    var hours = tickMinutes.map(function (minute) {
      return '<text x="' + x(minute) + '" y="' + (bottom + 28) + '" text-anchor="middle">' +
        String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0') + '</text>';
    }).join('');
    var forecastBand = finiteForecast && asOfMinute != null ? '<rect class="bd-chart__forecast-band" x="' + x(asOfMinute) + '" y="' + top + '" width="' + Math.max(0, left + width - x(asOfMinute)) + '" height="' + height + '"><title>' + escapeHtml(model.forecastLabel || 'Прогноз до 24:00') + '</title></rect><text class="bd-chart__forecast-label" x="' + (x(asOfMinute) + 10) + '" y="' + (top + 16) + '">Прогноз</text>' : '';
    var planLine = finite(target) ? '<g class="bd-chart__line bd-chart__line--plan"><path d="M ' + left + ' ' + y(target).toFixed(2) + ' H ' + (left + width) + '"></path><text x="' + (left + width - 4) + '" y="' + (y(target) - 7).toFixed(2) + '" text-anchor="end">План ' + escapeHtml(compact(target)) + '</text></g>' : '';
    var nowMarker = metric.key === 'orderedRevenue' && latestFact ? '<g class="bd-chart__now"><line x1="' + x(latestFact.minute) + '" y1="' + top + '" x2="' + x(latestFact.minute) + '" y2="' + bottom + '"></line><circle cx="' + x(latestFact.minute) + '" cy="' + y(latestFact.point.cumulative) + '" r="6"></circle><text x="' + (x(latestFact.minute) + (latestFact.minute > 1100 ? -10 : 10)) + '" y="' + (y(latestFact.point.cumulative) - 11) + '" text-anchor="' + (latestFact.minute > 1100 ? 'end' : 'start') + '">' + escapeHtml(compact(latestFact.point.cumulative)) + ' ₽</text><text class="bd-chart__now-time" x="' + x(latestFact.minute) + '" y="' + (bottom + 48) + '" text-anchor="middle">' + escapeHtml(formatTime(latestFact.point.at, timezone)) + '</text></g>' : '';
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
    return incompleteNote + '<div class="bd-chart-wrap"><svg class="bd-chart" viewBox="0 0 1000 ' + (bottom + 66) + '" role="img" tabindex="0" data-active-index="0" data-min="' + min + '" data-max="' + max + '" data-domain="' + domain + '" data-plot-top="' + top + '" data-plot-height="' + height + '" aria-label="Динамика ' + escapeHtml(metric.label || 'показателя') + ' в течение дня. Используйте стрелки для просмотра точек.">' +
      forecastBand + '<g class="bd-chart__grid">' + grid + hours + '</g>' +
      planLine +
      '<g class="bd-chart__line bd-chart__line--yesterday">' + path(yesterday, true) + '</g>' +
      '<g class="bd-chart__line bd-chart__line--average">' + path(avg, true) + '</g>' +
      '<g class="bd-chart__line bd-chart__line--forecast">' + path(forecast, false) + '</g>' +
      '<g class="bd-chart__line bd-chart__line--today">' + path(today, true) + '</g>' + nowMarker + eventMarkers +
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

  function executiveKpisMarkup(model, currentDay) {
    var data = model.executive || {}, forecast = model.kpis && model.kpis.forecast || {};
    var confidence = { high: 'высокая', medium: 'средняя', low: 'низкая' }[data.forecastConfidence] || 'не определена';
    var comparable = finite(data.comparisonToday) && finite(data.yesterdaySameTime) && finite(data.changePct);
    var difference = comparable ? data.comparisonToday - data.yesterdaySameTime : null;
    var comparisonTime = comparable ? formatTime(data.comparisonAsOf, model.timezone) : null;
    var completeToday = list(model.series && model.series.today).filter(function (row) { return row && row.complete === true; });
    var history = list(model.series && model.series.yesterday);
    var velocity = list(model.velocity).filter(function (row) { return row && row.complete === true; }).map(function (row) { return row.value; });
    var quality = data.dataQuality || {}, issues = list(quality.issues);
    var qualityScore = finite(quality.score) ? clamp(Math.round(quality.score), 0, 100) : null;
    var issueWord = issues.length % 10 === 1 && issues.length % 100 !== 11 ? 'ограничение' : issues.length % 10 >= 2 && issues.length % 10 <= 4 && (issues.length % 100 < 12 || issues.length % 100 > 14) ? 'ограничения' : 'ограничений';
    var rows = [
      { label: currentDay ? 'Сегодня' : 'Выбранный день', value: data.today, unit: 'rub', note: model.kpis && model.kpis.today && model.kpis.today.subtitle || 'По доступным данным', kind: 'today', trend: miniTrend(completeToday, 'Подтверждённая динамика сегодня', 'blue') },
      { label: currentDay ? 'Вчера к этому времени' : 'Предыдущий день к этому времени', value: data.yesterdaySameTime, unit: 'rub', note: comparisonTime ? 'Срез ' + comparisonTime + ' МСК' : 'Одинаковый момент МСК', kind: 'yesterday', trend: miniTrend(history, 'Динамика предыдущего дня', 'muted') },
      { label: 'Разница', value: difference, unit: 'signed', note: comparable ? formatValue(data.changePct, 'percent') + ' к вчера · ' + comparisonTime + ' МСК' : 'Нет сопоставимого среза', kind: 'difference', tone: comparable ? (difference < 0 ? 'is-down' : 'is-up') : '' },
      { label: 'Текущий темп', value: finite(data.last60m) ? data.last60m : data.currentPaceHourly, unit: 'hour', note: data.paceEstimated ? 'Оценка по разнице накопительных снимков' : finite(data.previousHourChange) ? formatValue(data.previousHourChange, 'percent') + ' к пред. часу' : finite(data.currentPaceHourly) ? 'Точные интервалы заказов' : 'Нет достаточных сопоставимых интервалов', kind: 'pace', trend: miniTrend(velocity, 'Скорость подтверждённых заказов', 'blue') },
      { label: 'Прогноз дня', value: forecast.available === false ? null : forecast.value, unit: 'rub', note: finite(data.targetCompletion) ? 'Выполнение прогноза ' + formatValue(data.targetCompletion, 'share') : forecast.available ? 'Уверенность ' + confidence + ' · ' + (forecast.sampleSize || 0) + ' дней' : 'Прогноз пока недоступен', kind: 'forecast' },
      { label: 'План дня', value: data.target, unit: 'rub', note: finite(data.target) ? 'Подтверждённая цель' : 'План не задан', kind: 'plan' }
    ];
    var cards = rows.map(function (row) {
      var formatted = row.unit === 'signed' ? signedMoney(row.value) : row.unit === 'hour' ? (finite(row.value) ? formatValue(row.value, 'rub') + '/ч' : '—') : formatValue(row.value, row.unit);
      return '<article class="bd-kpi bd-kpi--' + row.kind + (finite(row.value) ? '' : ' is-unavailable') + '"><span>' + escapeHtml(row.label) + '</span><strong class="' + (row.tone || '') + '">' + escapeHtml(formatted) + '</strong><small>' + escapeHtml(row.note) + '</small>' + (row.trend || '') + '</article>';
    }).join('');
    var qualityLabel = 'Качество данных' + (qualityScore === null ? '' : ' ' + qualityScore + '%') + ' · ' + issues.length + ' ' + issueWord;
    return cards + '<article class="bd-kpi bd-kpi--quality"><button type="button" data-quality-open aria-haspopup="dialog" aria-label="' + escapeHtml(qualityLabel) + '"><span>Качество данных</span><strong>' + (qualityScore === null ? '—' : qualityScore + '%') + '</strong><small>' + escapeHtml(issues.length + ' ' + issueWord) + '</small><i aria-hidden="true">›</i></button></article>';
  }

  function qualityMarkup(model) {
    var quality = model.executive && model.executive.dataQuality || {};
    var issues = list(quality.issues);
    var score = finite(quality.score) ? clamp(Math.round(quality.score), 0, 100) : null;
    var details = issues.map(function (issue) {
      var message = typeof issue === 'string' ? issue : issue && (issue.message || issue.label || issue.reason) || 'Ограничение данных';
      return '<li>' + escapeHtml(message) + '</li>';
    }).join('');
    var markets = quality.byMarket || {};
    var marketRows = ['Ozon', 'WB'].map(function (market) {
      var value = markets[market] && typeof markets[market] === 'object' ? markets[market].score : markets[market];
      return finite(value) ? '<span>' + market + ' <b>' + escapeHtml(Math.round(value)) + '%</b></span>' : '';
    }).join('');
    var sources = list(model.executive && model.executive.sourceStatus).map(function (source) {
      var basis = source.basis === 'order-time' ? 'полных интервалов' : 'снимков по 15-минутным слотам';
      var expected = finite(source.expectedIntervals) ? source.expectedIntervals : '—';
      var observed = finite(source.observedIntervals) ? source.observedIntervals : '—';
      var missing = finite(source.missingIntervals) ? source.missingIntervals : '—';
      return '<li><b>' + escapeHtml(source.name || source.id || 'Магазин') + '</b><small>' +
        escapeHtml(basis + ': ' + observed + '/' + expected + ' · без новых данных: ' + missing) + '</small><small>' +
        escapeHtml('Последний успешный сбор: ' + (source.lastSuccessAt ? formatTime(source.lastSuccessAt, model.timezone) + ' МСК' : 'нет данных') +
          (source.error ? ' · ошибка последнего обновления' : '') +
          ' · следующий по регламенту: ' + (source.expectedNextAt ? formatTime(source.expectedNextAt, model.timezone) + ' МСК' : 'неизвестен')) +
        '</small><small>' + escapeHtml('Вчера: ' + (source.yesterdayComparable ? 'сопоставимо' : 'нет сопоставимого среза') +
          ' · исторических дней с полным срезом: ' + (finite(source.historyCompleteDays) ? source.historyCompleteDays : '—') + '/28') + '</small></li>';
    }).join('');
    return '<div class="bd-quality-scrim" data-quality-close hidden></div>' +
      '<aside class="bd-quality-panel" role="dialog" aria-modal="true" aria-labelledby="bd-quality-title" hidden><div class="bd-quality-panel__head"><div><small>Проверка источников</small><h3 id="bd-quality-title">Качество данных</h3></div><button type="button" data-quality-close aria-label="Закрыть панель">×</button></div>' +
      '<strong class="bd-quality-panel__score">' + (score === null ? '—' : score + '%') + '</strong><div class="bd-quality-panel__markets">' + marketRows + '</div>' +
      '<h4>Источники</h4><ul class="bd-quality-panel__sources">' + (sources || '<li>Нет выбранных магазинов.</li>') + '</ul>' +
      '<h4>Ограничения</h4><ul>' + (details || '<li>Подтверждённых ограничений нет.</li>') + '</ul></aside>';
  }

  function liveMarkup(model) {
    var data = model.executive || {}, market = list(data.marketplaces);
    var updated = dateValue(model.updatedAt), fresh = updated !== null && Date.now() - updated <= 15 * 60000 && model.state === 'ready';
    var ozon = market.find(function (row) { return row.market === 'Ozon'; });
    var wb = market.find(function (row) { return row.market === 'WB'; });
    var shareKnown = market.length > 0 && market.every(function (row) { return finite(row.share) && finite(row.value); });
    var anyKnown = market.some(function (row) { return finite(row.value); });
    var partialMix = model.state !== 'ready' || market.some(function (row) { return row.partial; });
    var ozonShare = shareKnown && ozon ? clamp(ozon.share, 0, 100) : null;
    var marketRows = market.map(function (row) {
      return '<div class="bd-live__market-row"><span><i class="bd-live__market-dot bd-live__market-dot--' + escapeHtml(String(row.market).toLowerCase()) + '"></i>' + escapeHtml(row.market) + '</span><b>' + escapeHtml(formatValue(row.share, 'share')) + '</b><small>' + escapeHtml(formatValue(row.value, 'rub')) + '</small></div>';
    }).join('');
    var marketMix = anyKnown ? '<div class="bd-live__mix">' + (shareKnown ? '<div class="bd-live__donut" style="--ozon-share:' + (ozonShare === null ? 0 : ozonShare) + '%"><strong>' + escapeHtml(formatValue(data.today, 'rub')) + '</strong></div>' : '') + '<div class="bd-live__markets">' + marketRows + '</div></div>' + (partialMix ? '<small class="bd-live__mix-note">Доли от известной суммы; срезы магазинов могут различаться по времени.</small>' : '') :
      '<div class="bd-live__mix-empty">Данных по выбранным площадкам пока нет.</div>';
    var fifteen = finite(data.last15m) ? '<div class="bd-live__metric"><span>Продажи за 15 минут</span><strong>' + escapeHtml(formatValue(data.last15m, 'rub')) + '</strong></div>' :
      '<p class="bd-live__note">15-минутная детализация всех выбранных магазинов недоступна.</p>';
    return '<section class="bd-live" aria-label="Сейчас"><div class="bd-section-title"><h3>Сейчас</h3><span class="' + (fresh ? 'is-up' : '') + '">' + (fresh ? '● Данные поступают' : 'Последний доступный срез') + '</span></div>' +
      fifteen + '<div class="bd-live__metric"><span>' + (data.paceEstimated ? 'Оценка темпа за час' : 'За последний час') + '</span><strong>' + escapeHtml(finite(data.last60m) ? formatValue(data.last60m, 'rub') + '/ч' : finite(data.currentPaceHourly) ? '≈ ' + formatValue(data.currentPaceHourly, 'rub') + '/ч' : '—') + '</strong>' +
      (finite(data.previousHourChange) ? '<small class="' + (data.previousHourChange < 0 ? 'is-down' : 'is-up') + '">' + escapeHtml(formatValue(data.previousHourChange, 'percent')) + ' к пред. часу</small>' : '') + '</div>' +
      '<div class="bd-live__market"><span>Доля маркетплейсов</span>' + marketMix + '</div>' +
      '<div class="bd-live__foot"><div><span>До плана</span><strong>' + escapeHtml(formatValue(data.remaining, 'rub')) + '</strong></div><div><span>Нужный темп</span><strong>' + escapeHtml(finite(data.requiredHourly) ? formatValue(data.requiredHourly, 'rub') + '/ч' : '—') + '</strong></div></div></section>';
  }

  function contributionMarkup(model, metric) {
    var data = model.executive || {}, stores = list(data.stores).length ? data.stores : list(model.stores);
    if (!stores.length) return '<section class="bd-contribution"><div class="bd-section-title"><h3>Вклад магазинов</h3></div><p class="bd-empty-note">Нет подтверждённых данных по магазинам.</p></section>';
    var anyPartial = stores.some(function (store) { return store.staggered || store.complete === false; });
    return '<section class="bd-contribution" aria-label="Вклад магазинов"><div class="bd-section-title"><h3>Вклад магазинов</h3><span>' + (anyPartial ? 'Известная часть · срезы магазинов могут различаться' : 'На выбранное время МСК') + '</span></div>' +
      '<div class="bd-contribution__scroll"><table><thead><tr><th>Магазин</th><th>Сегодня</th><th>Вчера к этому времени</th><th>Δ</th><th>Доля</th><th>Темп · 60 мин</th></tr></thead><tbody>' + stores.slice(0, 40).map(function (store) {
        var delta = finite(store.changePct) ? store.changePct : null;
        var sourceNote = store.staggered || store.complete === false ? '<small class="bd-sr-only">Известная часть' + (store.asOf ? ' · ' + escapeHtml(formatTime(store.asOf, model.timezone)) + ' МСК' : '') + '</small>' : '';
        var value = store.value;
        var comparisonNote = finite(delta) && store.comparisonAsOf && store.comparisonAsOf !== store.asOf ? '<small>срез ' + escapeHtml(formatTime(store.comparisonAsOf, model.timezone)) + ' МСК</small>' : '';
        var share = finite(store.share) ? '<span class="bd-share"><span>' + escapeHtml(formatValue(store.share, 'share')) + '</span><i style="--share:' + clamp(store.share, 0, 100) + '%"></i></span>' : '—';
        return '<tr><th><button type="button" data-store-id="' + escapeHtml(store.id) + '"><i class="bd-store__avatar bd-store__avatar--' + escapeHtml(String(store.market || '').toLowerCase()) + '">' + escapeHtml(String(store.name || 'М').trim().charAt(0).toUpperCase()) + '</i><span>' + escapeHtml(store.name || 'Магазин') + '</span></button></th><td>' + escapeHtml(formatValue(value, metric.unit)) + sourceNote + '</td><td>' + escapeHtml(formatValue(store.yesterdaySameTime, metric.unit)) + '</td><td class="' + (delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : '') + '">' + escapeHtml(formatValue(delta, 'percent')) + comparisonNote + '</td><td>' + share + '</td><td>' + escapeHtml(finite(store.velocity) ? (store.velocityEstimate ? '≈ ' : '') + formatValue(store.velocity, metric.unit) + '/ч' : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';
  }

  function insightsMarkup(model) {
    var rows = list(model.executive && model.executive.insights);
    return '<section class="bd-insights" aria-label="Что происходит сейчас"><div class="bd-section-title"><h3>Что происходит сейчас</h3></div>' +
      (rows.length ? '<ul>' + rows.slice(0, 4).map(function (item) {
      var message = typeof item === 'string' ? item : item && (item.message || item.text) || '';
      var value = item && item.value, tone = finite(value) ? value < 0 ? 'is-down' : 'is-up' : '';
      return '<li class="' + tone + '"><i aria-hidden="true">' + (tone === 'is-down' ? '↓' : tone === 'is-up' ? '↑' : 'i') + '</i><span>' + escapeHtml(message) + '</span></li>';
    }).join('') + '</ul>' : '<p class="bd-empty-note">Сопоставимых изменений пока нет.</p>') + '</section>';
  }

  function categoriesMarkup() {
    return '<section class="bd-categories" aria-label="Продажи по категориям"><div class="bd-section-title"><h3>Продажи по категориям</h3></div>' +
      '<div class="bd-categories__content"><p class="bd-empty-note">Загружаем категории…</p></div>' +
      '<button type="button" class="bd-categories__open" data-open-categories>Все категории →</button></section>';
  }

  function updateCategories(host, summary, error) {
    var content = host && host.querySelector('.bd-categories__content');
    if (!content) return;
    if (error) { content.innerHTML = error.code === 'UNSUPPORTED_SCOPE'
      ? '<p class="bd-empty-note">Для выбранного набора магазинов категории пока не рассчитаны. Выберите площадку целиком или один магазин.</p>'
      : '<p class="bd-empty-note">Категории пока не загрузились. Откройте подробную таблицу или обновите экран.</p>'; return; }
    var rows = list(summary && summary.rows);
    if (!rows.length) { content.innerHTML = '<p class="bd-empty-note">Подтверждённых сумм по категориям за выбранный день пока нет.</p>'; return; }
    var total = finite(summary.knownTotal) ? '<strong class="bd-categories__total">' + escapeHtml(formatValue(summary.knownTotal, 'rub')) + '</strong>' : '';
    var note = summary.complete ? 'Подтверждённый итог' : 'Известная часть · данные по категориям неполные';
    content.innerHTML = '<div class="bd-categories__summary">' + total + '<small>' + note + '</small></div><div class="bd-categories__rows">' + rows.map(function (row) {
      return '<div><span>' + escapeHtml(row.name || 'Категория') + '</span><b>' + escapeHtml(formatValue(row.value, 'rub')) + '</b><small>' + escapeHtml(formatValue(row.share, 'share')) + '</small></div>';
    }).join('') + '</div>';
  }

  function recentMarkup(model) {
    var rows = list(model.stores).filter(function (store) { return dateValue(store && store.updatedAt) !== null; }).sort(function (a, b) { return dateValue(b.updatedAt) - dateValue(a.updatedAt); }).slice(0, 5);
    return '<section class="bd-recent" aria-label="Последние обновления"><div class="bd-section-title"><h3>Последние обновления</h3></div>' +
      (rows.length ? '<div class="bd-recent__rows">' + rows.map(function (store) {
        return '<div><time>' + escapeHtml(formatTime(store.updatedAt, model.timezone)) + '</time><span>Обновлены данные</span><b>' + escapeHtml(store.name || 'Магазин') + '</b><small>' + escapeHtml(store.market || '—') + '</small></div>';
      }).join('') + '</div>' : '<p class="bd-empty-note">События обновления пока недоступны.</p>') + '</section>';
  }

  function marketplacesMarkup(model) {
    var rows = list(model.executive && model.executive.marketplaces);
    return '<section class="bd-marketplaces" aria-label="Площадки"><div class="bd-section-title"><h3>Площадки</h3></div>' +
      (rows.length ? '<div class="bd-marketplaces__rows">' + rows.map(function (row) {
        return '<div><strong>' + escapeHtml(row.market || 'Площадка') + '</strong><b>' + escapeHtml(formatValue(row.value, 'rub')) + '</b><span>' + escapeHtml(formatValue(row.share, 'share')) + '</span>' +
          (finite(row.share) ? '<i style="--share:' + clamp(row.share, 0, 100) + '%"></i>' : '') + '</div>';
      }).join('') + '</div>' : '<p class="bd-empty-note">Нет подтверждённых данных по площадкам.</p>') +
      '<p class="bd-secondary-note">' + (model.state === 'ready' && rows.every(function (row) { return !row.partial; }) ? 'Доли рассчитаны по выбранным магазинам.' : 'Известные суммы; доли рассчитаны от известной части. Снимки магазинов могут различаться по времени.') + '</p></section>';
  }

  function productsMarkup() {
    return '<section class="bd-products" aria-label="Топ товаров"><div class="bd-section-title"><h3>Топ товаров</h3></div>' +
      '<div class="bd-secondary-empty"><strong>—</strong><p>Подтверждённый рейтинг товаров за выбранное время пока не рассчитан.</p><button type="button" data-open-categories>Открыть товары →</button></div></section>';
  }

  function executiveMarkup(model, metric, partial, periodLabel) {
    var data = model.executive || {};
    var subtitle = model.kpis && model.kpis.today && model.kpis.today.subtitle || 'По подтверждённым данным';
    return '<section class="business-dynamics bd-executive' + (partial ? ' is-partial' : '') + '" data-updated-at="' + escapeHtml(model.updatedAt || '') + '">' +
      '<header class="bd-head"><div class="bd-head__main"><span class="bd-eyebrow">ПУЛЬТ ПРОДАЖ · ' + escapeHtml(periodLabel) + '</span><h2>Динамика бизнеса</h2><p>Заказано на сумму <span>· ' + escapeHtml(subtitle) + '</span></p></div>' +
      '<div class="bd-head__status"><div class="bd-freshness" role="status"><i></i><span>Проверяем свежесть…</span></div><button type="button" class="bd-refresh" data-bd-refresh aria-label="Обновить данные">↻</button></div></header>' +
      '<div class="bd-kpis bd-kpis--executive">' + executiveKpisMarkup(model, model.date === dateKey(Date.now(), model.timezone)) + '</div>' +
      (model.canEditTarget ? '<form class="bd-target-form" data-target-form><label>План на сегодня <input name="amountRub" type="number" min="0.01" step="0.01" inputmode="decimal" required value="' + (finite(data.target) ? escapeHtml(String(data.target)) : '') + '" placeholder="Сумма в ₽"></label><button type="submit">Сохранить</button><small data-target-status aria-live="polite"></small></form>' : '') +
      '<section class="bd-main"><div class="bd-main__chart"><div class="bd-section-title"><div><h3>Динамика заказов (накопительно)</h3><p>' + escapeHtml(model.chartCaption || 'Накопительный итог · МСК') + '</p></div><div class="bd-legend"><span class="is-today">Сегодня</span><span class="is-yesterday">Вчера</span><span class="is-average">Среднее 7 дней</span><span class="is-forecast">Прогноз</span>' + (finite(data.target) ? '<span class="is-plan">План</span>' : '') + '</div></div>' + chartMarkup(model, metric) + '</div><aside class="bd-side">' + liveMarkup(model) + insightsMarkup(model) + '</aside></section>' +
      '<div class="bd-secondary-grid">' + contributionMarkup(model, metric) + categoriesMarkup() + '</div>' +
      '<div class="bd-tertiary-grid">' + recentMarkup(model) + marketplacesMarkup(model) + productsMarkup() + '</div>' +
      qualityMarkup(model) + '<section class="bd-detail" aria-live="polite" hidden></section></section>';
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
    var average = list(model.series && model.series.avg7d).find(function (row) { return dateValue(row && row.at) === dateValue(point.at); });
    var hourRows = list(model.velocity).filter(function (row) { return dateValue(row && row.to) <= dateValue(point.at); }).slice(-4);
    var hour = hourRows.length === 4 && hourRows.every(function (row, index) { return row.complete && finite(row.value) && (index === 0 || dateValue(hourRows[index - 1].to) === dateValue(row.from)); }) && dateValue(hourRows[3].to) === dateValue(point.at) ? hourRows.reduce(function (sum, row) { return sum + row.value; }, 0) : null;
    var rows = [
      ['Накопительно', tooltipValue(point.cumulative, metric.unit)],
      ['Вчера', tooltipValue(point.yesterday, metric.unit)],
      ['Среднее 7 дней', tooltipValue(average && average.cumulative, metric.unit)],
      ['Отклонение к вчера', tooltipValue(point.vsYesterdayPct, 'percent')],
      ['Темп · 60 минут', tooltipValue(hour, metric.unit)],
      ['Последние 15 минут', tooltipValue(point.last15, metric.unit)],
      ['Заказы с начала дня', tooltipValue(point.orders, 'orders')],
      ['Средний чек с начала дня', tooltipValue(point.avgCheck, 'rub')],
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
    if (model.state === 'empty' && !(model.executive && metric.key === 'orderedRevenue')) {
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
    host.innerHTML = model.executive && metric.key === 'orderedRevenue' ? executiveMarkup(model, metric, partial, periodLabel) : '<section class="business-dynamics' + (partial ? ' is-partial' : '') + '" data-updated-at="' + escapeHtml(model.updatedAt || '') + '">' +
      '<header class="bd-head"><div><span class="bd-eyebrow">Динамика бизнеса</span><h2>' + escapeHtml(metric.label || 'Оборот') + '</h2><p>' + escapeHtml(dateLabel) + ' · факты на <time>' + escapeHtml(formatTime(model.asOf, model.timezone)) + '</time></p></div>' +
      '<div class="bd-freshness" role="status"><i></i><span>Проверяем свежесть…</span></div></header>' +
      noticesMarkup(notices) +
      '<div class="bd-kpis">' + kpiMarkup(model, metric, currentDay, periodLabel) + '</div>' +
      '<section class="bd-main"><div class="bd-main__chart"><div class="bd-section-title"><div><h3>' + escapeHtml(model.chartUnavailableReason ? periodLabel : periodLabel + ' по времени') + '</h3><p>' + escapeHtml(model.chartUnavailableReason ? 'Доступен подтверждённый итог периода' : (model.chartCaption || 'Факт показан только до общего среза данных')) + '</p></div>' + (model.chartUnavailableReason ? '' : '<div class="bd-legend"><span class="is-today">' + escapeHtml(periodLabel) + '</span><span class="is-yesterday">Предыдущий день</span><span class="is-average">Среднее 7 дней</span><span class="is-forecast">Прогноз</span></div>') + '</div>' + chartMarkup(model, metric) + '</div>' +
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
      var plotTop = Number(chart.dataset.plotTop) || 24, plotHeight = Number(chart.dataset.plotHeight) || 340;
      var cy = plotTop + plotHeight - (point.cumulative - min) / (max - min) * plotHeight;
      var cursor = chart.querySelector('.bd-chart__cursor'), focus = chart.querySelector('.bd-chart__focus');
      cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.removeAttribute('hidden');
      focus.setAttribute('cx', cx); focus.setAttribute('cy', cy); focus.removeAttribute('hidden');
      tooltip.innerHTML = tooltipMarkup(point, model, metric); tooltip.hidden = false;
      var chartWidth = chart.getBoundingClientRect().width;
      var halfTooltip = tooltip.getBoundingClientRect().width / 2;
      // Clamp the rendered box, not a fixed percentage: edge points must fit at every width.
      var center = chartWidth > 0 ? clamp(cx / 1000 * chartWidth, halfTooltip + 8, chartWidth - halfTooltip - 8) : 0;
      tooltip.style.left = (chartWidth > 0 ? center / chartWidth * 100 : 50) + '%';
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
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); showPoint(event.key === 'Home' ? 0 : points.length - 1, false);
      } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showPoint(index, true); }
    }
    function showEvent(index) {
      var event = list(model.events)[index];
      if (!event) return;
      pinned = true; detail.hidden = false;
      detail.innerHTML = detailMarkup(event.label || 'Событие', '<p class="bd-detail__meta">' + escapeHtml(formatTime(event.at, model.timezone) + (event.kind ? ' · ' + event.kind : '')) + '</p><p>' + escapeHtml(event.detail || 'Без дополнительных подробностей') + '</p>');
    }
    function onRootClick(event) {
      if (event.target.closest('[data-bd-refresh]')) {
        host.dispatchEvent(new CustomEvent('business-dynamics:refresh', { bubbles: true })); return;
      }
      if (event.target.closest('[data-open-categories]')) {
        host.dispatchEvent(new CustomEvent('business-dynamics:categories', { bubbles: true })); return;
      }
      var qualityOpen = event.target.closest('[data-quality-open]'), qualityClose = event.target.closest('[data-quality-close]');
      if (qualityOpen || qualityClose) {
        var panel = root.querySelector('.bd-quality-panel'), scrim = root.querySelector('.bd-quality-scrim');
        if (panel && scrim) { panel.hidden = !qualityOpen; scrim.hidden = !qualityOpen; if (qualityOpen) panel.querySelector('[data-quality-close]')?.focus?.(); else root.querySelector('[data-quality-open]')?.focus?.(); }
        return;
      }
      var storeButton = event.target.closest('[data-store-id]');
      if (storeButton) { host.dispatchEvent(new CustomEvent('business-dynamics:store', { bubbles: true, detail: { storeId: storeButton.dataset.storeId } })); return; }
      var marker = event.target.closest('[data-event-index]');
      if (marker) { showEvent(Number(marker.dataset.eventIndex)); return; }
      if (event.target.closest('[data-detail-close]')) { pinned = false; detail.hidden = true; detail.replaceChildren(); }
    }
    function onTargetSubmit(event) {
      if (!event.target.matches?.('[data-target-form]')) return;
      event.preventDefault();
      var amount = event.target.querySelector('[name="amountRub"]')?.value?.trim().replace(',', '.');
      if (!amount) return;
      host.dispatchEvent(new CustomEvent('business-dynamics:target', { bubbles: true, detail: { date: model.date, amountRub: amount } }));
    }
    function onEscape(event) {
      if (event.key !== 'Escape') return;
      var panel = root.querySelector('.bd-quality-panel'), scrim = root.querySelector('.bd-quality-scrim');
      if (panel && !panel.hidden) { panel.hidden = true; if (scrim) scrim.hidden = true; root.querySelector('[data-quality-open]')?.focus?.(); event.preventDefault(); }
    }
    if (chart) {
      chart.addEventListener('pointermove', onPointer); chart.addEventListener('click', onPointer); chart.addEventListener('focus', onChartFocus);
      cleanups.push(function () { chart.removeEventListener('pointermove', onPointer); chart.removeEventListener('click', onPointer); chart.removeEventListener('focus', onChartFocus); });
    }
    root.addEventListener('click', onRootClick); root.addEventListener('keydown', onKey); root.addEventListener('keydown', onEscape); root.addEventListener('submit', onTargetSubmit);
    cleanups.push(function () { root.removeEventListener('click', onRootClick); root.removeEventListener('keydown', onKey); root.removeEventListener('keydown', onEscape); root.removeEventListener('submit', onTargetSubmit); });

    function updateFreshness() {
      var node = root.querySelector('.bd-freshness'), timestamp = dateValue(model.updatedAt);
      if (!node) return;
      if (timestamp == null) { node.className = 'bd-freshness is-stale'; node.querySelector('span').textContent = 'Свежесть неизвестна'; return; }
      var age = Date.now() - timestamp, minutes = Math.max(0, Math.floor(age / 60000));
      var label = minutes < 15 ? 'Актуально' : minutes < 30 ? 'Небольшая задержка' : minutes < 60 ? 'Данные задерживаются' : 'Данные устарели';
      node.className = 'bd-freshness' + (minutes >= 60 ? ' is-stale' : minutes >= 30 ? ' is-delayed' : '');
      node.querySelector('span').textContent = label + ' · ' + formatTime(model.updatedAt, model.timezone) + ' МСК · ' + minutes + ' мин. назад';
    }
    updateFreshness();
    var timer = setInterval(updateFreshness, 30000);
    instances.set(host, { timer: timer, cleanups: cleanups });
  }

  function clear(host) { if (host) destroy(host, true); }

  window.PultBusinessDynamicsView = { render: render, updateCategories: updateCategories, loading: loading, error: error, clear: clear };
}());
