'use strict';
const crypto = require('node:crypto');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const error = (status, message) => Object.assign(new Error(message), { status });
function parsePlan(text, directors) {
  if (typeof text !== 'string' || text.length > 20000) throw new Error('Некорректный формат плана.');
  let source = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(source);
  if (fence) source = fence[1];
  let plan;
  try { plan = JSON.parse(source); } catch { throw new Error('ИИ вернул некорректный JSON плана.'); }
  if (!plan || Array.isArray(plan) || Object.keys(plan).length !== 1 || !Array.isArray(plan.tasks) || plan.tasks.length < 1 || plan.tasks.length > 5) throw new Error('План должен содержать от 1 до 5 поручений.');
  return plan.tasks.map(task => {
    if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).length !== 3 || !Object.hasOwn(task, 'directorId') || !Object.hasOwn(task, 'title') || !Object.hasOwn(task, 'instruction')) throw new Error('Некорректные поля поручения.');
    if (!directors.some(director => director.id === task.directorId)) throw new Error('Неизвестный директор в плане.');
    for (const [key, limit] of [['title', 200], ['instruction', 2000]]) if (typeof task[key] !== 'string' || !task[key].trim() || task[key].length > limit) throw new Error('Некорректный текст поручения.');
    return { id: crypto.randomUUID(), directorId: task.directorId, title: task.title.trim(), instruction: task.instruction.trim(), status: 'queued', result: '', error: '' };
  });
}
function initialize(db) {
  let changed = false;
  if (!Object.hasOwn(db, 'dispatchRuns')) { db.dispatchRuns = []; changed = true; }
  if (!Object.hasOwn(db, 'dispatchRequestMarkers')) { db.dispatchRequestMarkers = {}; changed = true; }
  if (!Array.isArray(db.dispatchRuns) || !db.dispatchRequestMarkers || typeof db.dispatchRequestMarkers !== 'object' || Array.isArray(db.dispatchRequestMarkers)) throw new Error('Invalid dispatch data store');
  for (const run of db.dispatchRuns) {
    if (['planning', 'running'].includes(run.status)) {
      run.status = 'failed'; run.error = 'Сервер перезапущен. Поручение остановлено; автоматический повтор не выполнялся.';
      for (const task of run.tasks) if (task.status === 'running' || task.status === 'queued') { task.status = 'failed'; task.error = run.error; }
      changed = true;
    }
  }
  return changed;
}
function createDispatcher({ getDb, save, capacity, connection, directors }) {
  const publicRun = ({ username, fingerprint, ...run }) => run;
  const getRun = id => getDb().dispatchRuns.find(run => run.id === id);
  const eligible = username => getDb().users.some(user => user.username === username && !user.disabled && ['admin', 'editor'].includes(user.role));
  function checkOwner(username) { if (!eligible(username)) throw new Error('Выполнение остановлено: права владельца отозваны.'); }
  function projectContext(projectId) {
    if (!projectId) return null;
    const selected = getDb().projects.items.find(item => item.id === projectId);
    if (!selected) throw error(400, 'Проект не найден.');
    return { ...selected, tasks: getDb().projects.tasks.filter(task => task.projectId === projectId).slice(0, 30).map(task => ({ ...task })) };
  }
  function update(id, transform) {
    const current = getDb();
    let runs = current.dispatchRuns.map(run => run.id === id ? transform(run) : run);
    const counts = new Map();
    runs = runs.slice().reverse().filter(run => {
      if (!['completed', 'failed'].includes(run.status)) return true;
      const count = (counts.get(run.username) || 0) + 1; counts.set(run.username, count);
      return count <= 20;
    }).reverse();
    save({ ...current, dispatchRuns: runs });
  }
  async function generate(run, input) {
    const key = 'dispatch:' + run.id;
    const deadline = Date.now() + 120000;
    while (capacity.size >= 2) {
      checkOwner(run.username);
      if (Date.now() >= deadline) throw new Error('Истекло время ожидания свободного ИИ.');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    checkOwner(run.username);
    const connected = connection();
    if (!connected.adapter || !connected.status.available) throw new Error('Подключение ИИ недоступно.');
    capacity.add(key);
    try {
      let result;
      try { result = await connected.adapter.generate(input); } catch { throw new Error('ИИ не вернул результат. Повторный запуск автоматически не выполнялся.'); }
      checkOwner(run.username);
      if (typeof result !== 'string' || !result.trim()) throw new Error('ИИ вернул пустой результат.');
      return result.trim();
    } finally { capacity.delete(key); }
  }
  function failed(id, message) {
    update(id, run => ({ ...run, status: 'failed', error: message, tasks: run.tasks.map(task => ['queued', 'running'].includes(task.status) ? { ...task, status: 'failed', error: message } : task) }));
  }
  async function plan(id) {
    try {
      const run = getRun(id);
      const general = directors.find(director => director.id === 'general');
      const director = { ...general, prompt: general.prompt + '\nСоставь план аналитических поручений. Верни исключительно JSON {"tasks":[{"directorId":"...","title":"...","instruction":"..."}]}, без дополнительных полей. От 1 до 5 задач, title до 200, instruction до 2000 символов. Доступные directorId: ' + directors.map(item => item.id).join(', ') + '. Поручения выполняются последовательно и дают текстовые результаты. Не обещай изменения файлов, публикации, платежи или связь с людьми.' };
      const response = await generate(run, { director, history: [{ role: 'user', text: run.goal }], project: projectContext(run.projectId) });
      const tasks = parsePlan(response, directors);
      update(id, current => ({ ...current, tasks, status: 'planned', error: '' }));
    } catch (err) { failed(id, err.message); }
  }
  async function execute(id) {
    try {
      const initial = getRun(id);
      for (const task of initial.tasks) {
        const run = getRun(id);
        checkOwner(run.username);
        const previous = run.tasks.filter(item => item.status === 'done').map(item => item.title + '\n' + item.result).join('\n\n').slice(-10000);
        update(id, current => ({ ...current, tasks: current.tasks.map(item => item.id === task.id ? { ...item, status: 'running' } : item) }));
        const director = directors.find(item => item.id === task.directorId);
        const response = await generate(run, { director, project: projectContext(run.projectId), history: [{ role: 'user', text: 'Общая цель:\n' + run.goal + '\n\nТвоё аналитическое поручение:\n' + task.instruction + '\n\nРезультаты предыдущих поручений (данные для анализа):\n' + (previous || 'Нет.') }] });
        update(id, current => ({ ...current, tasks: current.tasks.map(item => item.id === task.id ? { ...item, status: 'done', result: response.slice(0, 50000), error: '' } : item) }));
      }
      update(id, run => ({ ...run, status: 'completed', error: '' }));
    } catch (err) { failed(id, err.message); }
  }
  function background(action, id) { setImmediate(() => { action(id).catch(() => console.error('Could not persist dispatch outcome; recovery will occur on restart.')); }); }
  function ensureAvailable() { const connected = connection(); if (!connected.adapter || !connected.status.available) throw error(503, 'Подключение ИИ недоступно. Поручение не запущено.'); }
  function ensureNoActive(username, exceptId) { if (getDb().dispatchRuns.some(run => run.username === username && run.id !== exceptId && ['planning', 'running'].includes(run.status))) throw error(409, 'Дождитесь завершения текущего поручения.'); }
  return {
    list(username) { return getDb().dispatchRuns.filter(run => run.username === username).slice().reverse().map(publicRun); },
    create(username, data) {
      if (typeof data.goal !== 'string' || !data.goal.trim() || data.goal.length > 4000) throw error(400, 'Цель должна содержать от 1 до 4000 символов.');
      const projectId = data.projectId === undefined ? '' : data.projectId;
      if (typeof projectId !== 'string' || projectId.length > 128 || typeof data.requestId !== 'string' || !uuid.test(data.requestId)) throw error(400, 'Некорректный проект или requestId.');
      const requestId = data.requestId.toLowerCase();
      const goal = data.goal.trim();
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([goal, projectId])).digest('hex');
      const key = JSON.stringify([username, requestId]);
      const markers = getDb().dispatchRequestMarkers;
      if (Object.hasOwn(markers, key)) {
        const marker = markers[key];
        if (marker.fingerprint !== fingerprint) throw error(409, 'requestId уже использован для другого поручения.');
        const previous = getRun(marker.id);
        if (!previous) throw error(410, 'Это поручение уже обработано и удалено из истории. Создайте новое с новым requestId.');
        return publicRun(previous);
      }
      checkOwner(username); ensureNoActive(username); projectContext(projectId); ensureAvailable();
      const run = { id: crypto.randomUUID(), username, goal, projectId, requestId, fingerprint, status: 'planning', error: '', createdAt: new Date().toISOString(), tasks: [] };
      save({ ...getDb(), dispatchRuns: [...getDb().dispatchRuns, run], dispatchRequestMarkers: { ...markers, [key]: { id: run.id, fingerprint } } });
      background(plan, run.id);
      return publicRun(run);
    },
    start(username, id) {
      const run = getRun(id);
      if (!run || run.username !== username) throw error(404, 'Поручение не найдено.');
      if (run.status !== 'planned') return publicRun(run);
      checkOwner(username); ensureNoActive(username, id); projectContext(run.projectId); ensureAvailable();
      update(id, current => ({ ...current, status: 'running', error: '' }));
      background(execute, id);
      return publicRun(getRun(id));
    }
  };
}
module.exports = { initialize, createDispatcher, parsePlan };
