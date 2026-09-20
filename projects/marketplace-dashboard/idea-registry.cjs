'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class IdeaRegistryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.public = true;
  }
}

const fail = (message, status) => { throw new IdeaRegistryError(message, status); };
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const statuses = new Set(['deferred', 'active', 'done']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function cleanText(value, name, maximum, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') fail(`Поле «${name}» должно быть текстом`);
  const result = value.trim();
  if (required && !result) fail(`Укажите ${name.toLocaleLowerCase('ru-RU')}`);
  if (result.length > maximum) fail(`Поле «${name}» не должно быть длиннее ${maximum} символов`);
  return result;
}

module.exports = function createIdeaRegistry({ privateDir, now = () => new Date().toISOString() }) {
  if (typeof privateDir !== 'string' || !privateDir) throw new TypeError('privateDir is required');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const file = path.join(privateDir, 'ideas.json');
  const empty = () => ({ schema: 1, version: 0, seeded: false, ideas: [], requests: {} });

  function load() {
    if (!fs.existsSync(file)) return empty();
    if (fs.statSync(file).size > 25 * 1024 * 1024) fail('Файл реестра идей слишком большой', 500);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { fail('Файл реестра идей повреждён', 500); }
    const validIdea = idea => isObject(idea) && uuid(idea.id) && typeof idea.title === 'string' && idea.title.length > 0 && idea.title.length <= 160 &&
      typeof idea.description === 'string' && idea.description.length <= 4000 && typeof idea.direction === 'string' && idea.direction.length > 0 && idea.direction.length <= 80 &&
      statuses.has(idea.status) && typeof idea.createdAt === 'string' && Number.isFinite(Date.parse(idea.createdAt)) &&
      typeof idea.updatedAt === 'string' && Number.isFinite(Date.parse(idea.updatedAt));
    if (!isObject(parsed) || parsed.schema !== 1 || !Number.isSafeInteger(parsed.version) || parsed.version < 0 ||
      typeof parsed.seeded !== 'boolean' || !Array.isArray(parsed.ideas) || parsed.ideas.length > 5000 || !parsed.ideas.every(validIdea) ||
      !isObject(parsed.requests) || Object.keys(parsed.requests).length > 10000 || Object.entries(parsed.requests).some(([key, value]) => !uuid(key) || !uuid(value))) {
      fail('Файл реестра идей повреждён', 500);
    }
    if (new Set(parsed.ideas.map(idea => idea.id)).size !== parsed.ideas.length) fail('Файл реестра идей повреждён', 500);
    return parsed;
  }

  let state = load();
  const read = () => ({ version: state.version, ideas: structuredClone(state.ideas) });

  function save(next) {
    fs.mkdirSync(privateDir, { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      throw new IdeaRegistryError('Не удалось сохранить реестр идей', 500, { cause: error });
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    }
    state = next;
    return read();
  }

  function advance(next) {
    if (state.version >= Number.MAX_SAFE_INTEGER) fail('Достигнут предел версии реестра', 500);
    next.version++;
  }

  function requireVersion(input) {
    if (!isObject(input)) fail('Некорректные данные');
    if (!Number.isSafeInteger(input.version) || input.version < 0) fail('Некорректная версия реестра');
    if (input.version !== state.version) fail('Реестр изменился. Обновите страницу перед сохранением', 409);
  }

  function create(input) {
    if (!isObject(input)) fail('Некорректные данные');
    if (input.clientRequestId !== undefined && !uuid(input.clientRequestId)) fail('Некорректный идентификатор запроса');
    if (input.clientRequestId && Object.hasOwn(state.requests, input.clientRequestId)) return read();
    requireVersion(input);
    if (state.ideas.length >= 5000) fail('Достигнут предел: 5000 идей');
    const title = cleanText(input.title, 'Название', 160, { required: true });
    const description = cleanText(input.description ?? '', 'Описание', 4000);
    const direction = cleanText(input.direction ?? 'Общее', 'Направление', 80, { required: true });
    const status = input.status ?? 'deferred';
    if (!statuses.has(status)) fail('Некорректный статус идеи');
    const timestamp = now();
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) fail('Не удалось определить время сохранения', 500);
    const id = crypto.randomUUID();
    const next = structuredClone(state);
    next.ideas.unshift({ id, title, description, direction, status, createdAt: timestamp, updatedAt: timestamp });
    if (input.clientRequestId) {
      if (Object.keys(next.requests).length >= 10000) delete next.requests[Object.keys(next.requests)[0]];
      Object.defineProperty(next.requests, input.clientRequestId, { value: id, enumerable: true, writable: true, configurable: true });
    }
    advance(next);
    return save(next);
  }

  function update(input) {
    requireVersion(input);
    if (!uuid(input.id)) fail('Некорректный идентификатор идеи');
    const current = state.ideas.find(idea => idea.id === input.id);
    if (!current) fail('Идея не найдена', 404);
    const allowed = ['title', 'description', 'direction', 'status'];
    if (!allowed.some(field => input[field] !== undefined)) fail('Нет изменений для сохранения');
    const nextIdea = { ...current };
    if (input.title !== undefined) nextIdea.title = cleanText(input.title, 'Название', 160, { required: true });
    if (input.description !== undefined) nextIdea.description = cleanText(input.description, 'Описание', 4000);
    if (input.direction !== undefined) nextIdea.direction = cleanText(input.direction, 'Направление', 80, { required: true });
    if (input.status !== undefined) {
      if (!statuses.has(input.status)) fail('Некорректный статус идеи');
      nextIdea.status = input.status;
    }
    const timestamp = now();
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) fail('Не удалось определить время сохранения', 500);
    nextIdea.updatedAt = timestamp;
    const next = structuredClone(state);
    next.ideas[next.ideas.findIndex(idea => idea.id === input.id)] = nextIdea;
    advance(next);
    return save(next);
  }

  function seedFirstIdea() {
    if (state.seeded) return read();
    const next = structuredClone(state);
    next.seeded = true;
    const timestamp = now();
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) fail('Не удалось определить время сохранения', 500);
    next.ideas.push({
        id: crypto.randomUUID(),
        title: 'Развитие B2B у наших поставщиков',
        description: 'Постепенно добиваться появления у поставщиков B2B-кабинетов и цифрового обмена ценами и остатками, чтобы позднее подключать их к закупкам. Будущее развитие, не действующая интеграция.',
        direction: 'Закупки',
        status: 'deferred',
        createdAt: timestamp,
        updatedAt: timestamp
    });
    advance(next);
    return save(next);
  }

  return { read, create, update, seedFirstIdea };
};

module.exports.IdeaRegistryError = IdeaRegistryError;
