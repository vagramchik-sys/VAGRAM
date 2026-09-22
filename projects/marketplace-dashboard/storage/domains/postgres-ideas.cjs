'use strict';

const { createJsonDocumentRepository } = require('../postgres-json-repository.cjs');
const { sourceKey } = require('../postgres-document-import.cjs');

class IdeaRegistryError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'IdeaRegistryError'; this.status = status; this.public = true; }
}
const fail = (message, status) => { throw new IdeaRegistryError(message, status); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const statuses = new Set(['deferred', 'active', 'done']);
const empty = () => ({ schema: 1, version: 0, seeded: false, ideas: [], requests: {} });
function validIdea(idea) {
  return object(idea) && UUID.test(idea.id) && typeof idea.title === 'string' && idea.title.length > 0 && idea.title.length <= 160 &&
    typeof idea.description === 'string' && idea.description.length <= 4000 && typeof idea.direction === 'string' && idea.direction.length > 0 && idea.direction.length <= 80 &&
    statuses.has(idea.status) && typeof idea.createdAt === 'string' && Number.isFinite(Date.parse(idea.createdAt)) &&
    typeof idea.updatedAt === 'string' && Number.isFinite(Date.parse(idea.updatedAt));
}
function validState(value) {
  return object(value) && value.schema === 1 && Number.isSafeInteger(value.version) && value.version >= 0 && typeof value.seeded === 'boolean' &&
    Array.isArray(value.ideas) && value.ideas.length <= 5000 && value.ideas.every(validIdea) && new Set(value.ideas.map(idea => idea.id)).size === value.ideas.length &&
    object(value.requests) && Object.keys(value.requests).length <= 10000 && Object.entries(value.requests).every(([key, id]) => UUID.test(key) && UUID.test(id));
}
function cleanText(value, name, maximum, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') fail(`Поле «${name}» должно быть текстом`);
  const result = value.trim();
  if (required && !result) fail(`Укажите ${name.toLocaleLowerCase('ru-RU')}`);
  if (result.length > maximum) fail(`Поле «${name}» не должно быть длиннее ${maximum} символов`);
  return result;
}
function command(value) {
  if (!object(value) || !UUID.test(value.commandId || '')) fail('Некорректный идентификатор команды');
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) fail('Не удалось определить время сохранения', 500);
  return { commandId: value.commandId.toLowerCase(), timestamp: value.timestamp };
}
function publicState(state) { return { version: state.version, ideas: structuredClone(state.ideas) }; }

function createPostgresIdeas({ stateStore } = {}) {
  const repository = createJsonDocumentRepository({ stateStore, logicalKey: sourceKey('ideas.json'), sourcePath: 'ideas.json', validate: validState });
  async function load() {
    let record;
    try { record = await repository.read(); }
    catch (error) {
      if (error?.code === 'CORRUPT_DOCUMENT') fail('Файл реестра идей повреждён', 500);
      throw error;
    }
    return { record, state: record && !record.deleted ? record.value : empty() };
  }
  async function save(next, expectedRevision, commandId) {
    try { await repository.compareAndSet(next, { expectedRevision, commandId }); }
    catch (error) {
      if (error?.code === 'REVISION_CONFLICT') fail('Реестр изменился. Обновите страницу перед сохранением', 409);
      throw error;
    }
    return publicState(next);
  }
  function advance(next) {
    if (next.version >= Number.MAX_SAFE_INTEGER) fail('Достигнут предел версии реестра', 500);
    next.version++;
  }
  function requireInput(input) {
    if (!object(input)) fail('Некорректные данные');
    if (!Number.isSafeInteger(input.version) || input.version < 0) fail('Некорректная версия реестра');
  }
  const beforeState = journal => journal.before.absent || journal.before.deleted ? empty() : journal.before.value;
  async function recorded(op, transition) {
    const journal = await repository.readCommand(op.commandId);
    if (!journal) return null;
    const next = transition(structuredClone(beforeState(journal)), op);
    await save(next, journal.before.revision, op.commandId);
    return publicState(next);
  }
  function createNext(state, input, op) {
    requireInput(input);
    if (input.version !== state.version) fail('Реестр изменился. Обновите страницу перед сохранением', 409);
    const title = cleanText(input.title, 'Название', 160, { required: true });
    const description = cleanText(input.description ?? '', 'Описание', 4000);
    const direction = cleanText(input.direction ?? 'Общее', 'Направление', 80, { required: true });
    const status = input.status ?? 'deferred';
    if (!statuses.has(status)) fail('Некорректный статус идеи');
    if (state.ideas.length >= 5000) fail('Достигнут предел: 5000 идей');
    const idea = { id: op.commandId, title, description, direction, status, createdAt: op.timestamp, updatedAt: op.timestamp };
    const next = structuredClone(state); next.ideas.unshift(idea);
    if (input.clientRequestId) {
      if (Object.keys(next.requests).length >= 10000) delete next.requests[Object.keys(next.requests)[0]];
      Object.defineProperty(next.requests, input.clientRequestId, { value: idea.id, enumerable: true, writable: true, configurable: true });
    }
    advance(next); return next;
  }
  function updateNext(state, input, op) {
    requireInput(input);
    if (input.version !== state.version) fail('Реестр изменился. Обновите страницу перед сохранением', 409);
    if (!UUID.test(input.id || '')) fail('Некорректный идентификатор идеи');
    const allowed = ['title', 'description', 'direction', 'status'];
    if (!allowed.some(field => input[field] !== undefined)) fail('Нет изменений для сохранения');
    const current = state.ideas.find(idea => idea.id === input.id);
    if (!current) fail('Идея не найдена', 404);
    const nextIdea = { ...current };
    if (input.title !== undefined) nextIdea.title = cleanText(input.title, 'Название', 160, { required: true });
    if (input.description !== undefined) nextIdea.description = cleanText(input.description, 'Описание', 4000);
    if (input.direction !== undefined) nextIdea.direction = cleanText(input.direction, 'Направление', 80, { required: true });
    if (input.status !== undefined) { if (!statuses.has(input.status)) fail('Некорректный статус идеи'); nextIdea.status = input.status; }
    nextIdea.updatedAt = op.timestamp;
    const next = structuredClone(state); next.ideas[next.ideas.findIndex(idea => idea.id === input.id)] = nextIdea; advance(next); return next;
  }
  function seedNext(state, op) {
    const next = structuredClone(state); next.seeded = true;
    next.ideas.push({ id: op.commandId, title: 'Развитие B2B у наших поставщиков', description: 'Постепенно добиваться появления у поставщиков B2B-кабинетов и цифрового обмена ценами и остатками, чтобы позднее подключать их к закупкам. Будущее развитие, не действующая интеграция.', direction: 'Закупки', status: 'deferred', createdAt: op.timestamp, updatedAt: op.timestamp });
    advance(next); return next;
  }
  async function read() { return publicState((await load()).state); }
  async function create(input, commandInput) {
    if (!object(input)) fail('Некорректные данные');
    if (input.clientRequestId !== undefined && !UUID.test(input.clientRequestId)) fail('Некорректный идентификатор запроса');
    const op = command(commandInput), replay = await recorded(op, state => createNext(state, input, op));
    if (replay) return replay;
    const loaded = await load(), state = loaded.state;
    if (input.clientRequestId && Object.hasOwn(state.requests, input.clientRequestId)) return publicState(state);
    const next = createNext(state, input, op);
    return save(next, loaded.record?.revision || '0', op.commandId);
  }
  async function update(input, commandInput) {
    requireInput(input);
    const op = command(commandInput), replay = await recorded(op, state => updateNext(state, input, op));
    if (replay) return replay;
    const loaded = await load(), next = updateNext(loaded.state, input, op);
    return save(next, loaded.record?.revision || '0', op.commandId);
  }
  async function seedFirstIdea(commandInput) {
    if (!commandInput) { const current = (await load()).state; if (current.seeded) return publicState(current); }
    const op = command(commandInput), replay = await recorded(op, state => seedNext(state, op));
    if (replay) return replay;
    const loaded = await load();
    if (loaded.state.seeded) return publicState(loaded.state);
    const next = seedNext(loaded.state, op); return save(next, loaded.record?.revision || '0', op.commandId);
  }
  return Object.freeze({ read, create, update, seedFirstIdea });
}

module.exports = createPostgresIdeas;
module.exports.createPostgresIdeas = createPostgresIdeas;
module.exports.IdeaRegistryError = IdeaRegistryError;
