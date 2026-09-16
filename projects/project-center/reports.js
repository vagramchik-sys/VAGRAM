(function (root) {
  'use strict';

  function csvCell(value) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Отчет содержит некорректное число.');
      return String(value).replace('.', ',');
    }
    let text = String(value ?? '');
    // Spreadsheet applications can interpret text as formulas even after whitespace.
    if (/^[\s]*[=+\-@]|^[\t\r\n]/u.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function toCsv(rows) {
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
  }

  function buildReport(kind, state, from = '', to = '', model = root.OzonModel) {
    if (!model) throw new Error('Модуль расчетов не загружен.');
    const summary = model.summarize(state, from, to);
    const included = item => (!from || item.date >= from) && (!to || item.date <= to);
    const products = new Map(state.products.map(product => [product.id, product]));
    let rows;
    if (kind === 'products') {
      rows = [['id', 'sku', 'name', 'cost', 'price', 'stock'], ...state.products.map(p => [p.id, p.sku, p.name, p.cost, p.price, p.stock])];
    } else if (kind === 'sales') {
      rows = [['id', 'date', 'productId', 'sku', 'name', 'quantity', 'price', 'commission', 'logistics', 'revenue', 'current_cost_per_unit', 'cogs', 'profit_before_overhead_and_tax'],
        ...state.sales.filter(included).map(s => {
          const p = products.get(s.productId), revenue = s.quantity * s.price, cogs = s.quantity * p.cost;
          return [s.id, s.date, s.productId, p.sku, p.name, s.quantity, s.price, s.commission, s.logistics, Number(revenue.toFixed(2)), p.cost, Number(cogs.toFixed(2)), Number((revenue - cogs - s.commission - s.logistics).toFixed(2))];
        })];
    } else if (kind === 'expenses') {
      rows = [['id', 'date', 'category', 'amount', 'note'], ...state.expenses.filter(included).map(e => [e.id, e.date, e.category, e.amount, e.note])];
    } else if (kind === 'summary') {
      rows = [['productId', 'sku', 'name', 'units', 'revenue', 'profit_before_overhead_and_tax'], ...summary.byProduct.map(p => [p.id, p.sku, p.name, p.units, p.revenue, p.profit])];
    } else throw new Error('Неизвестный вид отчета.');
    return toCsv(rows);
  }

  const api = Object.freeze({ csvCell, toCsv, buildReport });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root.document) return;
  root.OzonReports = api;
  function mount() {
    const dashboard = root.document.getElementById('page-dashboard');
    if (!dashboard || root.document.getElementById('reports-panel')) return;
    const panel = root.document.createElement('div'); panel.id = 'reports-panel'; panel.className = 'panel';
    const heading = root.document.createElement('h3'); heading.textContent = 'Выгрузка аналитики';
    const info = root.document.createElement('p'); info.textContent = 'CSV для Excel: актуальные данные сервера. Продажи, расходы и сводка — за выбранный период; товары — текущий каталог. Прибыль по товарам — до общих расходов и налогов. Файлы отчетов не подходят для обратного импорта продаж.';
    const actions = root.document.createElement('div'); actions.className = 'actions';
    const status = root.document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const buttons = [];
    for (const [kind, label] of [['products', 'CSV товаров'], ['sales', 'CSV продаж'], ['expenses', 'CSV расходов'], ['summary', 'CSV сводки по товарам']]) {
      const button = root.document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = label;
      button.addEventListener('click', async () => {
        buttons.forEach(item => { item.disabled = true; }); status.classList.remove('error'); status.textContent = 'Подготовка отчета…';
        const from = root.document.getElementById('filter-from')?.value || '', to = root.document.getElementById('filter-to')?.value || '';
        try {
          const response = await root.fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' });
          if (response.status === 401) throw new Error('Сеанс завершен. Войдите снова, чтобы скачать отчет.');
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Не удалось получить данные сервера.');
          const csv = buildReport(kind, data.state, from, to);
          const url = root.URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
          const link = root.document.createElement('a'); link.href = url;
          link.download = kind === 'products' ? 'ozon-products-current.csv' : `ozon-${kind}-${from || 'all'}-${to || 'all'}.csv`;
          root.document.body.append(link); link.click(); link.remove(); root.setTimeout(() => root.URL.revokeObjectURL(url), 1000);
          status.textContent = 'Отчет подготовлен к скачиванию.';
        } catch (error) { status.classList.add('error'); status.textContent = error.message || 'Не удалось подготовить отчет.'; }
        finally { buttons.forEach(item => { item.disabled = false; }); }
      });
      buttons.push(button); actions.append(button);
    }
    panel.append(heading, info, actions, status); dashboard.append(panel);
  }
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})(typeof window !== 'undefined' ? window : globalThis);
