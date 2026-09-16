(function (root) {
  'use strict';

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function validateState(state) {
    var errors = [];
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return { ok: false, errors: ['Данные должны быть объектом.'] };
    }
    var productIds = new Set();
    var productSkus = new Set();
    ['products', 'sales', 'expenses'].forEach(function (collection) {
      if (!Array.isArray(state[collection])) {
        errors.push(collection + ': ожидается массив.');
        return;
      }
      var ids = new Set();
      state[collection].forEach(function (item, index) {
        var path = collection + '[' + index + ']';
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(path + ': ожидается объект.');
          return;
        }
        function string(field, required) {
          if (typeof item[field] !== 'string' || (required && !item[field].trim())) {
            errors.push(path + '.' + field + ': ожидается ' + (required ? 'непустая строка.' : 'строка.'));
          }
        }
        function money(field) {
          if (typeof item[field] !== 'number' || !Number.isFinite(item[field]) || item[field] < 0) {
            errors.push(path + '.' + field + ': ожидается конечное неотрицательное число.');
          }
        }
        string('id', true);
        if (ids.has(item.id)) errors.push(path + '.id: повторяющийся идентификатор.');
        ids.add(item.id);
        if (collection === 'products') {
          productIds.add(item.id);
          string('sku', true);
          if (typeof item.sku === 'string') {
            var sku = item.sku.trim().toLowerCase();
            if (productSkus.has(sku)) errors.push(path + '.sku: повторяющийся артикул.');
            productSkus.add(sku);
          }
          string('name', true);
          ['cost', 'price', 'stock'].forEach(money);
          if (!Number.isSafeInteger(item.stock)) errors.push(path + '.stock: ожидается целое безопасное число.');
        } else {
          if (!validDate(item.date)) errors.push(path + '.date: ожидается реальная дата YYYY-MM-DD.');
          if (collection === 'sales') {
            string('productId', true);
            if (!productIds.has(item.productId)) errors.push(path + '.productId: товар не найден.');
            if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
              errors.push(path + '.quantity: ожидается положительное целое безопасное число.');
            }
            ['price', 'commission', 'logistics'].forEach(money);
          } else {
            string('category', true);
            string('note', false);
            money('amount');
          }
        }
      });
    });
    return { ok: errors.length === 0, errors: errors };
  }

  function summarize(state, from, to) {
    var validation = validateState(state);
    if (!validation.ok) throw new Error(validation.errors.join('\n'));
    if (from && !validDate(from)) throw new Error('Некорректная начальная дата.');
    if (to && !validDate(to)) throw new Error('Некорректная конечная дата.');
    if (from && to && from > to) throw new Error('Начальная дата позже конечной.');
    var result = { revenue: 0, cogs: 0, commission: 0, logistics: 0, expenses: 0, profit: 0, units: 0, margin: 0, byProduct: [], byDay: [] };
    var products = new Map(state.products.map(function (product) { return [product.id, product]; }));
    var byProduct = new Map();
    var byDay = new Map();
    function included(date) { return (!from || date >= from) && (!to || date <= to); }
    function day(date) {
      if (!byDay.has(date)) byDay.set(date, { date: date, revenue: 0, profit: 0 });
      return byDay.get(date);
    }
    state.sales.forEach(function (sale) {
      if (!included(sale.date)) return;
      var product = products.get(sale.productId);
      var revenue = sale.quantity * sale.price;
      var cogs = sale.quantity * product.cost;
      var profit = revenue - cogs - sale.commission - sale.logistics;
      result.revenue += revenue;
      result.cogs += cogs;
      result.commission += sale.commission;
      result.logistics += sale.logistics;
      result.units += sale.quantity;
      if (!byProduct.has(product.id)) byProduct.set(product.id, { id: product.id, name: product.name, sku: product.sku, units: 0, revenue: 0, profit: 0 });
      var row = byProduct.get(product.id);
      row.units += sale.quantity;
      row.revenue += revenue;
      row.profit += profit;
      day(sale.date).revenue += revenue;
      day(sale.date).profit += profit;
    });
    state.expenses.forEach(function (expense) {
      if (!included(expense.date)) return;
      result.expenses += expense.amount;
      day(expense.date).profit -= expense.amount;
    });
    result.profit = result.revenue - result.cogs - result.commission - result.logistics - result.expenses;
    result.margin = result.revenue === 0 ? 0 : result.profit / result.revenue * 100;
    function round(value) {
      if (!Number.isFinite(value)) throw new Error('Слишком большие значения для расчёта.');
      return Number(value.toFixed(2));
    }
    ['revenue', 'cogs', 'commission', 'logistics', 'expenses', 'profit', 'margin'].forEach(function (key) { result[key] = round(result[key]); });
    if (!Number.isSafeInteger(result.units)) throw new Error('Слишком большое количество единиц для расчёта.');
    result.byProduct = Array.from(byProduct.values()).map(function (row) {
      row.revenue = round(row.revenue);
      row.profit = round(row.profit);
      return row;
    }).sort(function (a, b) { return b.revenue - a.revenue || a.id.localeCompare(b.id); });
    result.byDay = Array.from(byDay.values()).map(function (row) {
      row.revenue = round(row.revenue);
      row.profit = round(row.profit);
      return row;
    }).sort(function (a, b) { return a.date.localeCompare(b.date); });
    return result;
  }

  root.OzonModel = Object.freeze({ summarize: summarize, validateState: validateState });
})(typeof window !== 'undefined' ? window : globalThis);
