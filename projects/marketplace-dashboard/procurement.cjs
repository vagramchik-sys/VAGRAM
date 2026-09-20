'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class ProcurementError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.public = true; }
}
const fail = (message, status) => { throw new ProcurementError(message, status); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const normalized = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const articleKey = value => normalized(value); // Punctuation and internal spaces can distinguish real SKUs.
function bounded(value, label, max = 200, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label}: укажите текст длиной от 1 до ${max} символов`);
  return value.trim();
}
function inputText(value) {
  if (typeof value !== 'string' || !value.trim()) fail('Вставьте текст заявки или прайса');
  if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) fail('Текст превышает предел 1 МБ');
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}
function numberOf(value, label, nullable = false) {
  const raw = String(value ?? '').trim();
  if (nullable && (!raw || /^(?:—|-|нет данных|неизвестно|n\/a)$/i.test(raw))) return null;
  const clean = raw.replace(/[ \u00a0\u202f]/g, '');
  if (!/^\d+(?:[.,]\d+)?$/.test(clean)) fail(`${label}: ожидается неотрицательное число`);
  const number = Number(clean.replace(',', '.'));
  if (!Number.isFinite(number) || number > 1000000000000) fail(`${label}: число слишком велико`);
  return number;
}
function unitOf(value) {
  const raw = normalized(value).replace(/\.$/, '');
  const units = { штука: 'шт', штуки: 'шт', штук: 'шт', шт: 'шт', pcs: 'шт', метр: 'м', метры: 'м', метров: 'м', м: 'м', кг: 'кг', килограмм: 'кг', упаковка: 'уп', упаковки: 'уп', упак: 'уп', уп: 'уп', комплект: 'компл', компл: 'компл', литр: 'л', л: 'л' };
  return units[raw] || raw;
}
function vatOf(value) {
  const key = normalized(value);
  if (!key || ['unknown', 'неизвестно', 'не указан', 'не указано'].includes(key)) return 'unknown';
  if (['included', 'с ндс', 'включен', 'включён', 'ндс включен', 'ндс включён'].includes(key) || /^с ндс\s+\d+(?:[.,]\d+)?%$/.test(key)) return 'included';
  if (['excluded', 'ндс сверху', 'не включен', 'не включён', 'без учета ндс'].includes(key)) return 'excluded';
  if (['no-vat', 'без ндс', 'ндс не облагается', 'не облагается'].includes(key)) return 'no-vat';
  return 'unknown';
}
const HEADERS = {
  article: ['артикул', 'арт', 'sku', 'код', 'кодтовара', 'article'],
  name: ['наименование', 'наименованиетовара', 'товар', 'название', 'name', 'product'],
  price: ['цена', 'ценаед', 'ценазаединицу', 'price', 'ценаруб', 'ценарублей'],
  stock: ['остаток', 'наличие', 'склад', 'stock', 'остатокнаскладе'],
  quantity: ['количество', 'колво', 'кол', 'quantity', 'qty'],
  unit: ['едизм', 'единица', 'единицаизмерения', 'единицыизмерения', 'ед', 'unit'],
  vat: ['ндс', 'vat'], currency: ['валюта', 'currency']
};
const headerKey = value => normalized(value).replace(/[\s.()/_\-₽]/g, '');
function headers(cells) {
  const result = {};
  cells.forEach((cell, index) => {
    const field = Object.keys(HEADERS).find(key => HEADERS[key].includes(headerKey(cell)));
    if (field) { if (result[field] !== undefined) fail(`Повторяется столбец «${cell}»`); result[field] = index; }
  });
  return result;
}
// RFC-style quoted fields, including escaped quotes and multiline descriptions.
function delimited(text, delimiter) {
  const rows = []; let cells = [], cell = '', quoted = false, closed = false, line = 1, startLine = 1;
  const finishCell = () => { if (cell.length > 2000) fail(`Строка ${startLine}: ячейка длиннее 2000 символов`); cells.push(cell); cell = ''; closed = false; };
  const finishRow = () => { finishCell(); if (cells.some(value => value.trim())) rows.push({ cells, line: startLine }); cells = []; startLine = line + 1; if (rows.length > 5001) fail('В одном файле допускается не более 5000 товаров'); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else { cell += char; if (char === '\n') line++; }
    } else if (char === delimiter) finishCell();
    else if (char === '\n') { finishRow(); line++; }
    else if (char === '"' && cell === '' && !closed) quoted = true;
    else if (closed && /\s/.test(char)) continue;
    else if (closed) fail(`Строка ${line}: лишний текст после закрывающей кавычки`);
    else cell += char;
  }
  if (quoted) fail(`Строка ${startLine}: не закрыта кавычка`);
  if (cell || cells.length) finishRow();
  return rows;
}
function table(text) {
  const first = text.split('\n').find(line => line.trim()) || '';
  const scores = ['\t', ';', ','].map(delimiter => {
    try { const row = delimited(first, delimiter)[0]; return { delimiter, score: row ? Object.keys(headers(row.cells)).length * 100 + row.cells.length : 0 }; }
    catch { return { delimiter, score: 0 }; }
  }).sort((a, b) => b.score - a.score);
  const rows = delimited(text, scores[0].delimiter);
  return { rows, columns: rows.length ? headers(rows[0].cells) : {} };
}
function validatedItem(item) {
  if (!object(item)) fail('Некорректная строка заявки');
  const quantity = item.quantity === null || item.quantity === undefined || item.quantity === '' ? null : numberOf(item.quantity, 'Количество');
  if (quantity !== null && quantity <= 0) fail('Количество в заявке должно быть больше нуля');
  return { id: typeof item.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(item.id) ? item.id : crypto.randomUUID(), name: bounded(item.name, 'Наименование', 500), article: bounded(item.article, 'Артикул', 120, true), quantity, unit: unitOf(bounded(item.unit, 'Единица', 40, true)) };
}

module.exports = function createProcurement({ privateDir, now = () => new Date().toISOString() }) {
  const file = path.join(privateDir, 'procurement.json');
  const empty = () => ({ schema: 1, version: 0, requests: [], priceLists: [] });
  function load() {
    if (!fs.existsSync(file)) return empty();
    let saved;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('Файл закупок повреждён или недоступен', 500); }
    if (saved.schema !== 1 || !Number.isSafeInteger(saved.version) || saved.version < 0 || !Array.isArray(saved.requests) || !Array.isArray(saved.priceLists) || saved.requests.some(r => !object(r) || !Array.isArray(r.items)) || saved.priceLists.some(p => !object(p) || !Array.isArray(p.rows))) fail('Файл закупок повреждён', 500);
    return saved;
  }
  let state = load();
  function read() { state = load(); return { ...structuredClone(state), mode: 'local-draft' }; }
  function commit(input, change) {
    state = load();
    if (!object(input) || input.version !== state.version) fail('Данные закупок изменились. Обновите страницу перед сохранением', 409);
    const next = structuredClone(state), id = change(next);
    next.version++;
    fs.mkdirSync(privateDir, { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    state = next;
    return { ...structuredClone(state), mode: 'local-draft', id };
  }
  function parseRequest(input) {
    const text = inputText(input?.text), warnings = [], items = [];
    // A delimiter alone is not evidence of a table: require a recognized name header.
    const first = text.split('\n').find(line => line.trim()) || '';
    const looksLikeHeader = ['\t', ';', ','].some(d => first.split(d).some(cell => HEADERS.name.includes(headerKey(cell.replace(/^"|"$/g, '')))));
    if (looksLikeHeader) {
      const { rows, columns } = table(text);
      if (columns.name === undefined) fail('В таблице заявки нужен столбец «Наименование»');
      for (const row of rows.slice(1)) {
        const get = field => columns[field] === undefined ? '' : row.cells[columns[field]] || '';
        try {
          if (row.cells.length !== rows[0].cells.length) fail('число столбцов не совпадает с заголовком');
          items.push(validatedItem({ name: get('name'), article: get('article'), quantity: numberOf(get('quantity'), 'Количество', true), unit: get('unit') }));
        }
        catch (error) { fail(`Строка ${row.line}: ${error.message}`); }
      }
    } else {
      for (const raw of text.split('\n').filter(line => line.trim())) {
        let name = raw.trim().replace(/^\s*(?:[-•]|\d+[.)])\s+/, ''), article = '', quantity = null, unit = '';
        // Only explicit, separate labels: bare "арт деко" and unmarked codes are names.
        const skuLabel = /(?:^|[\s,;]+)(?:\(\s*)?(?:(?:артикул|sku)(?:\s*[:=]\s*|\s+)|арт(?:\.(?:\s*[:=]\s*|\s+)|\s*[:=]\s*))([^\s;,()[\]{}]+)(?:\s*\))?/giu;
        const skus = [...name.matchAll(skuLabel)];
        if (skus.length && new Set(skus.map(sku => articleKey(sku[1]))).size === 1) {
          article = skus[0][1]; name = name.replace(skuLabel, ' ').trim();
        } else if (skus.length) warnings.push(`Строка ${items.length + 1}: указано несколько артикулов. Выберите нужный вручную.`);
        const amount = name.match(/(?:^|\s|[;,:—–])([0-9]+(?:[.,][0-9]+)?)\s*(шт\.?|штук[аи]?|м\.?|метр(?:а|ов)?|кг\.?|уп\.?|упак\.?|упаков(?:ка|ки|ок)|компл\.?|л\.?)\s*$/iu);
        if (amount) { quantity = numberOf(amount[1], 'Количество'); unit = unitOf(amount[2]); name = name.slice(0, amount.index).replace(/[\s;,:—–-]+$/, ''); }
        name = name.replace(/^[\s,;]+|[\s,;]+$/g, '').replace(/\s+([,;])/g, '$1');
        items.push(validatedItem({ name, article, quantity, unit }));
      }
    }
    if (!items.length || items.length > 100) fail('В заявке должно быть от 1 до 100 позиций');
    if (items.some(item => item.quantity === null)) warnings.push('Для части позиций количество не распознано: заполните его вручную. Числа в размерах не считаются количеством.');
    if (items.some(item => !item.unit)) warnings.push('Для части позиций не указана единица измерения: сравнение цен требует проверки.');
    warnings.push('Проверьте названия, артикулы, количество и единицы перед сохранением.');
    return { items, warnings };
  }
  function saveRequest(input) {
    return commit(input, next => {
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) fail('В заявке должно быть от 1 до 100 позиций');
      const current = input.id === undefined ? null : next.requests.find(r => r.id === input.id);
      if (input.id !== undefined && !current) fail('Заявка не найдена', 404);
      if (!current && next.requests.length >= 100) fail('Достигнут предел: 100 заявок');
      const items = input.items.map(validatedItem);
      if (new Set(items.map(item => item.id)).size !== items.length) fail('В заявке повторяются идентификаторы строк');
      const request = { id: current?.id || crypto.randomUUID(), title: bounded(input.title, 'Название заявки'), items, createdAt: current?.createdAt || now(), updatedAt: now() };
      if (current) next.requests[next.requests.indexOf(current)] = request; else next.requests.push(request);
      return request.id;
    });
  }
  function importPriceList(input) {
    return commit(input, next => {
      const supplierName = bounded(input.supplierName, 'Поставщик'), sourceName = bounded(input.sourceName, 'Источник');
      const currency = input.currency || 'RUB';
      if (!['RUB', 'USD', 'EUR', 'CNY'].includes(currency)) fail('Поддерживаются валюты RUB, USD, EUR, CNY без конвертации');
      const vatBasis = input.vatBasis || 'unknown';
      if (!['unknown', 'included', 'excluded', 'no-vat'].includes(vatBasis)) fail('Некорректное условие НДС');
      const priceDate = input.priceDate || null;
      if (priceDate !== null && (typeof priceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(priceDate) || !Number.isFinite(Date.parse(priceDate)) || new Date(priceDate).toISOString().slice(0, 10) !== priceDate)) fail('Дата прайса должна иметь формат ГГГГ-ММ-ДД');
      const parsed = table(inputText(input.text));
      if (parsed.columns.name === undefined || parsed.columns.price === undefined) fail('В CSV/TSV нужны столбцы «Наименование» и «Цена»');
      if (parsed.rows.length < 2) fail('Прайс не содержит товаров');
      if (next.priceLists.length >= 50 || next.priceLists.reduce((sum, list) => sum + list.rows.length, 0) + parsed.rows.length - 1 > 50000) fail('Достигнут предел хранения: 50 прайсов или 50 000 строк');
      const rows = parsed.rows.slice(1).map(row => {
        const get = key => parsed.columns[key] === undefined ? '' : row.cells[parsed.columns[key]] || '';
        try {
          if (row.cells.length !== parsed.rows[0].cells.length) fail('число столбцов не совпадает с заголовком');
          const rowCurrency = get('currency').trim().toUpperCase() || currency;
          if (!['RUB', 'USD', 'EUR', 'CNY'].includes(rowCurrency)) fail('неизвестная валюта');
          const vatText = get('vat').trim();
          return { id: crypto.randomUUID(), name: bounded(get('name'), 'Наименование', 500), article: bounded(get('article'), 'Артикул', 120, true), price: numberOf(get('price'), 'Цена'), stock: numberOf(get('stock'), 'Остаток', true), unit: unitOf(bounded(get('unit'), 'Единица', 40, true)), currency: rowCurrency, vatBasis: vatText ? vatOf(vatText) : vatBasis, vatText, sourceRow: row.line };
        } catch (error) { fail(`Строка ${row.line}: ${error.message}. Прайс целиком не сохранён.`); }
      });
      const list = { id: crypto.randomUUID(), supplierName, sourceName, importedAt: now(), priceDate, currency, vatBasis, rows };
      next.priceLists.push(list); return list.id;
    });
  }
  function compare(input) {
    state = load();
    const request = state.requests.find(r => r.id === input?.requestId);
    if (!request) fail('Заявка не найдена', 404);
    const items = request.items.map(item => {
      const offers = [], candidates = [];
      const name = normalized(item.name), article = articleKey(item.article), unit = unitOf(item.unit);
      const tokens = name.split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1);
      for (const list of state.priceLists) {
        const sameArticle = article ? list.rows.filter(row => articleKey(row.article) === article) : [];
        const ambiguous = new Set(sameArticle.map(row => `${normalized(row.name)}|${unitOf(row.unit)}`)).size > 1;
        for (const row of list.rows) {
          const rowArticle = articleKey(row.article), rowName = normalized(row.name), rowUnit = unitOf(row.unit);
          const articleMatch = !!article && rowArticle === article;
          // A supplied, conflicting SKU must never be silently matched by name.
          const nameMatch = name === rowName && !!unit && unit === rowUnit && !(article && rowArticle && article !== rowArticle);
          const exact = articleMatch || nameMatch;
          const words = rowName.split(/[^\p{L}\p{N}]+/u);
          const shared = tokens.filter(token => words.includes(token)).length;
          const similar = name === rowName || (tokens.length > 0 && shared / tokens.length >= 0.6);
          if (!exact && !similar) continue;
          const needsManualReview = !exact || (articleMatch && ambiguous) || !unit || !rowUnit || unit !== rowUnit;
          const comparable = exact && !needsManualReview && row.vatBasis !== 'unknown';
          const offer = { ...structuredClone(row), supplierName: list.supplierName, match: exact ? articleMatch ? 'article' : 'name-unit' : 'candidate', needsManualReview, comparable, source: { priceListId: list.id, sourceName: list.sourceName, row: row.sourceRow, importedAt: list.importedAt, priceDate: list.priceDate, verification: 'user-provided-not-live-verified' } };
          if (exact) offers.push(offer); else if (candidates.length < 30) candidates.push(offer);
        }
      }
      // Comparability is per condition group, never a cheapest-offer recommendation.
      const groupOf = offer => `${offer.currency}|${offer.vatBasis}|${offer.unit}|${normalized(offer.vatText).match(/\d+(?:[.,]\d+)?\s*%/)?.[0] || 'rate-unspecified'}`;
      const groups = new Set(offers.filter(o => o.comparable).map(groupOf));
      for (const offer of offers) {
        offer.comparisonGroup = groupOf(offer);
        if (groups.size > 1) offer.comparable = false;
      }
      return { ...structuredClone(item), offers, candidates, mixedConditions: groups.size > 1 };
    });
    return { requestId: request.id, title: request.title, items, warning: 'Цены и остатки из файлов пользователя, не проверены у поставщиков в реальном времени. Сравнивайте только одинаковые единицы, валюту и условия НДС. Кандидаты требуют ручной проверки; поставщик автоматически не выбирается.' };
  }
  return { read, parseRequest, saveRequest, importPriceList, compare };
};
module.exports.ProcurementError = ProcurementError;
