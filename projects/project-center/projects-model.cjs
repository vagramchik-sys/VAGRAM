'use strict';
function validateState(state) {
  const errors = [];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function exactKeys(value, keys, label) {
    for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(label + '.' + key + ': неизвестное поле.');
    for (const key of keys) if (!Object.hasOwn(value, key)) errors.push(label + '.' + key + ': обязательное поле.');
  }
  function text(value, max, required, label) {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) errors.push(label + ': ожидается ' + (required ? 'непустая ' : '') + 'строка до ' + max + ' символов.');
  }
  function date(value, label) {
    if (value === '') return;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) { errors.push(label + ': некорректная дата.'); return; }
    const parsed = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) errors.push(label + ': дата не существует.');
  }
  if (!object(state)) return { ok: false, errors: ['Данные проектов должны быть объектом.'] };
  exactKeys(state, ['items', 'tasks'], 'state');
  const projectIds = new Set();
  for (const collection of ['items', 'tasks']) {
    if (!Array.isArray(state[collection])) { errors.push(collection + ': ожидается массив.'); continue; }
    const max = collection === 'items' ? 5000 : 20000;
    if (state[collection].length > max) { errors.push(collection + ': допускается до ' + max + ' записей.'); continue; }
    const ids = new Set();
    for (let index = 0; index < state[collection].length; index++) {
      const entry = state[collection][index];
      const label = collection + '[' + index + ']';
      if (!object(entry)) { errors.push(label + ': ожидается объект.'); continue; }
      const project = collection === 'items';
      exactKeys(entry, project ? ['id', 'name', 'description', 'status', 'owner', 'dueDate'] : ['id', 'projectId', 'title', 'owner', 'status', 'priority', 'dueDate'], label);
      text(entry.id, 128, true, label + '.id');
      if (typeof entry.id === 'string' && entry.id !== entry.id.trim()) errors.push(label + '.id: пробелы по краям не допускаются.');
      if (ids.has(entry.id)) errors.push(label + '.id: повторяющийся идентификатор.');
      ids.add(entry.id);
      text(entry.owner, 120, false, label + '.owner');
      date(entry.dueDate, label + '.dueDate');
      if (project) {
        projectIds.add(entry.id);
        text(entry.name, 200, true, label + '.name');
        text(entry.description, 5000, false, label + '.description');
        if (!['planned', 'active', 'paused', 'done'].includes(entry.status)) errors.push(label + '.status: неизвестный статус проекта.');
      } else {
        text(entry.projectId, 128, true, label + '.projectId');
        if (!projectIds.has(entry.projectId)) errors.push(label + '.projectId: проект не найден.');
        text(entry.title, 200, true, label + '.title');
        if (!['todo', 'doing', 'done'].includes(entry.status)) errors.push(label + '.status: неизвестный статус задачи.');
        if (!['low', 'medium', 'high'].includes(entry.priority)) errors.push(label + '.priority: неизвестный приоритет.');
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
module.exports = Object.freeze({ validateState });
