(() => {
  'use strict';
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  const form = $('director-form'), input = form.elements.namedItem('message');
  const drafts = new Map(), conversations = new Map(), sending = new Set(), requestIds = new Map();
  const palette = new Set(['blue', 'violet', 'teal', 'amber', 'rose', 'slate']);
  const catalogColors = { '#8b5cf6': 'violet', '#3b82f6': 'blue', '#10b981': 'teal', '#ec4899': 'rose', '#f59e0b': 'amber', '#06b6d4': 'teal', '#6366f1': 'violet', '#14b8a6': 'teal', '#a855f7': 'violet', '#f97316': 'amber' };
  let directors = [], projects = [], connection = { available: false, message: 'Проверяем подключение…' };
  let selected = null, generation = 0, pollTimer = null, refreshing = false, user = null;
  let restoreButton = null;
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
  const uuid = () => globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = Math.floor(Math.random() * 16); return (c === 'x' ? n : (n & 3) | 8).toString(16); });
  function status(text, error = false) { $('directors-status').textContent = text; $('directors-status').classList.toggle('error', error); }
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    if (response.status === 401) { location.href = '/login.html'; throw new Error('Войдите снова.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || `Ошибка сервера: ${response.status}`); error.status = response.status; throw error; }
    return data;
  }
  function saveDraft() { if (selected) drafts.set(selected, { text: input.value, projectId: $('director-project').value }); }
  function stopPoll() { clearTimeout(pollTimer); pollTimer = null; }
  function controls() {
    const conversation = conversations.get(selected);
    if (restoreButton) restoreButton.disabled = !selected || user?.role === 'viewer' || sending.has(selected) || conversation?.busy === true || conversation?.loading === true;
    $('director-send').disabled = !selected || user?.role === 'viewer' || !connection.available || sending.has(selected) || !conversation || conversation.loading || conversation.busy || Boolean(conversation.error) || !input.value.trim();
    $('director-connection').textContent = (connection.message || (connection.available ? 'Подключение доступно.' : 'Провайдер не подключен.')) + (user?.role === 'viewer' ? ' Ваша роль разрешает только просмотр.' : '');
    if ($('director-advice')) $('director-advice').disabled = !user || user.role === 'viewer' || !connection.available || sending.has('general') || conversations.get('general')?.busy === true;
  }
  function projectOptions() {
    const select = $('director-project'), draft = drafts.get(selected);
    select.replaceChildren();
    const none = node('option', 'Без проекта'); none.value = ''; select.append(none);
    for (const project of projects) { const option = node('option', project.name); option.value = project.id; select.append(option); }
    if (draft?.projectId && !projects.some(project => project.id === draft.projectId)) { const option = node('option', 'Проект больше недоступен'); option.value = draft.projectId; select.append(option); }
    select.value = draft?.projectId || '';
  }
  function renderCards() {
    const grid = $('director-grid'); grid.replaceChildren();
    for (const director of directors) {
      const card = node('article', undefined, 'director-card');
      const color = palette.has(director.color) ? director.color : Object.hasOwn(catalogColors, director.color) ? catalogColors[director.color] : 'blue';
      const top = node('div', undefined, 'director-top'), title = node('div'); title.append(node('h3', director.label), node('p', director.title, 'director-role'));
      top.append(node('span', director.initials || 'ИИ', `director-avatar palette-${color}`), title); card.append(top, node('p', director.description));
      const tags = node('span', undefined, 'director-tags'); for (const tag of Array.isArray(director.tags) ? director.tags : []) tags.append(node('span', tag, 'director-tag')); card.append(tags);
      const button = node('button', 'Открыть диалог →', 'director-action'); button.type = 'button'; button.setAttribute('aria-label', `Открыть диалог: ${director.label}`);
      button.addEventListener('click', () => open(director.id)); card.append(button); grid.append(card);
    }
    if (!directors.length) grid.append(node('p', 'Директоры пока недоступны. Нажмите «Обновить».', 'empty-state'));
  }
  function renderConversation() {
    const container = $('director-messages'), conversation = conversations.get(selected);
    const nearEnd = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    container.replaceChildren();
    restoreButton = null;
    if (!conversation || conversation.loading) container.append(node('p', 'Загружаем историю…', 'empty-state'));
    else {
      if (!conversation.messages.length && !conversation.error) container.append(node('p', 'Диалог пока пуст. Опишите задачу директору.', 'empty-state'));
      for (const message of conversation.messages) {
        const role = ['user', 'assistant', 'error'].includes(message.role) ? message.role : 'system';
        const item = node('article', undefined, `director-message role-${role}`);
        const label = role === 'user' ? 'Вы' : role === 'assistant' ? 'Директор' : role === 'error' ? 'Ошибка' : 'Сервис';
        item.append(node('strong', label));
        const text = node('div', message.text); text.style.whiteSpace = 'pre-wrap'; item.append(text);
        if (message.projectId) item.append(node('small', 'Проект: ' + (projects.find(project => project.id === message.projectId)?.name || 'недоступен')));
        if (message.createdAt) { const date = new Date(message.createdAt); if (Number.isFinite(date.getTime())) item.append(node('time', date.toLocaleString('ru-RU'))); }
        container.append(item);
      }
      const last = conversation.messages.at(-1);
      const failed = !conversation.busy && ['system', 'error'].includes(last?.role);
      const outcome = conversation.error ? '' : conversation.busy ? 'Директор готовит ответ…' : failed ? 'Ответ не получен. Причина указана выше; вы можете отправить обращение повторно.' : last?.role === 'assistant' ? 'Ответ директора готов.' : '';
      if (outcome) { const indicator = node('p', outcome, failed ? 'error' : 'director-busy'); indicator.setAttribute('role', failed ? 'alert' : 'status'); container.append(indicator); }
      const previousRequest = failed ? [...conversation.messages].reverse().find(message => message.role === 'user') : null;
      if (previousRequest && user?.role !== 'viewer') {
        const restore = node('button', 'Вернуть текст обращения', 'director-action'); restore.type = 'button';
        restoreButton = restore;
        const directorId = selected;
        restore.addEventListener('click', () => {
          if (selected !== directorId || sending.has(directorId) || conversations.get(directorId)?.busy) return;
          if (input.value.trim() && input.value !== previousRequest.text && !confirm('Заменить текущий черновик текстом обращения, на которое не удалось получить ответ?')) return;
          drafts.set(directorId, { text: previousRequest.text, projectId: previousRequest.projectId || '' });
          input.value = previousRequest.text; projectOptions(); controls(); input.focus();
          status('Текст восстановлен. Проверьте его и нажмите «Отправить обращение».');
        });
        container.append(restore);
      }
      if (conversation.error) {
        container.append(node('p', conversation.error, 'error'));
        const retry = node('button', 'Повторить загрузку истории', 'director-action'); retry.type = 'button';
        const directorId = selected;
        retry.addEventListener('click', () => {
          if (selected !== directorId) return;
          saveDraft(); stopPoll(); generation++;
          conversations.set(directorId, { ...conversations.get(directorId), loading: true });
          renderConversation(); void readConversation(directorId, generation);
        });
        container.append(retry);
      }
    }
    if (nearEnd) container.scrollTop = container.scrollHeight;
    controls();
  }
  function schedule(id, token) {
    stopPoll();
    if (selected === id && token === generation && conversations.get(id)?.busy) pollTimer = setTimeout(() => readConversation(id, token), 2000);
  }
  async function readConversation(id, token) {
    if (id !== selected || token !== generation) return;
    try {
      const data = await api(`/api/directors/${encodeURIComponent(id)}`);
      if (id !== selected || token !== generation) return;
      conversations.set(id, { messages: Array.isArray(data.messages) ? data.messages : [], busy: data.busy === true, loading: false, error: data.error || '' });
      renderConversation();
    } catch (error) {
      if (id !== selected || token !== generation) return;
      const old = conversations.get(id) || { messages: [], busy: false };
      conversations.set(id, { ...old, loading: false, error: 'Не удалось обновить историю: ' + error.message }); renderConversation();
    }
    schedule(id, token);
  }
  async function open(id) {
    saveDraft(); stopPoll(); generation++; selected = id;
    const director = directors.find(item => item.id === id); if (!director) return;
    $('director-dialog').hidden = false; $('director-name').textContent = director.label; $('director-role').textContent = director.title; $('director-description').textContent = director.description;
    input.value = drafts.get(id)?.text || ''; projectOptions();
    conversations.set(id, { ...(conversations.get(id) || { messages: [], busy: false }), loading: true });
    renderConversation(); await readConversation(id, generation); if(selected===id) input.focus();
  }
  $('director-advice')?.addEventListener('click', async () => {
    if (!user || user.role === 'viewer' || !connection.available || sending.has('general')) return;
    saveDraft();
    if (drafts.get('general')?.text.trim() && !confirm('Заменить несохранённое обращение генеральному директору запросом рекомендаций?')) return;
    await open('general');
    if (selected !== 'general') return;
    if (conversations.get('general')?.busy || conversations.get('general')?.error) { status('Дождитесь завершения текущего ответа или обновите историю.', true); return; }
    input.value = 'Посоветуй, что мне как руководителю сделать дальше. Проанализируй переданный портфель проектов и открытые задачи. Выбери до трёх приоритетных действий: для каждого укажи причину, ожидаемый результат, подходящего ИИ-директора и конкретное поручение ему. В конце назови один первый шаг на ближайшие 30 минут. Отделяй факты из базы от предположений. Если проектов или задач недостаточно, не выдумывай их: предложи шаг для уточнения цели и задай один важный вопрос. Ничего автоматически не запускай.';
    $('director-project').value = ''; saveDraft(); controls();
    $('director-dialog').scrollIntoView({behavior:'smooth',block:'start'});
    form.requestSubmit();
  });
  async function refresh() {
    if (refreshing) return;
    refreshing = true; $('directors-refresh').disabled = true; saveDraft();
    try {
      const data = await api('/api/directors'); directors = data.directors || []; projects = data.projects || []; user = data.user; connection = data.connection || { available: false, message: 'Провайдер не подключен.' };
      renderCards(); controls(); if (selected && directors.some(item => item.id === selected)) { projectOptions(); stopPoll(); generation++; await readConversation(selected, generation); }
      status('Подключение и список директоров обновлены.');
    } catch (error) { status(error.message, true); }
    finally { refreshing = false; $('directors-refresh').disabled = false; }
  }
  input.addEventListener('input', () => { saveDraft(); controls(); });
  $('director-project').addEventListener('change', saveDraft);
  form.addEventListener('submit', async event => {
    event.preventDefault(); saveDraft(); const id = selected, draft = drafts.get(id), conversation = conversations.get(id);
    if (conversation?.error) { status('Сначала восстановите загрузку истории. Ваш черновик сохранён в этой вкладке.', true); return; }
    if (!id || user?.role === 'viewer' || !connection.available || sending.has(id) || !conversation || conversation.loading || conversation.busy) { status(user?.role === 'viewer' ? 'Ваша роль разрешает только просмотр.' : connection.message || 'Отправка пока недоступна.', true); return; }
    if (!draft.text.trim() || draft.text.length > 6000) { status('Введите сообщение от 1 до 6000 символов.', true); return; }
    if (draft.projectId && !projects.some(project => project.id === draft.projectId)) { status('Выбранный проект больше недоступен. Выберите другой проект.', true); return; }
    const fingerprint = JSON.stringify(draft); const previous = requestIds.get(id);
    const requestId = previous?.fingerprint === fingerprint ? previous.id : uuid(); requestIds.set(id, { fingerprint, id: requestId });
    sending.add(id); controls(); stopPoll(); generation++;
    try {
      const accepted = await api(`/api/directors/${encodeURIComponent(id)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: draft.text, projectId: draft.projectId, requestId }) });
      conversations.set(id, { ...conversation, busy: accepted.busy === true, loading: false });
      const current = drafts.get(id); if (current?.text === draft.text && current.projectId === draft.projectId) { drafts.set(id, { text: '', projectId: draft.projectId }); if (selected === id) input.value = ''; }
      requestIds.delete(id); if (selected === id) status('Обращение отправлено. Ход выполнения и результат показаны в диалоге.');
      if (selected === id) { stopPoll(); generation++; await readConversation(id, generation); }
    } catch (error) { status('Сообщение не подтверждено сервером: ' + error.message + '. Текст сохранен; можно повторить отправку.', true); if (selected === id) { stopPoll(); generation++; await readConversation(id, generation); } }
    finally { sending.delete(id); controls(); }
  });
  $('directors-refresh').addEventListener('click', refresh);
  $('director-close')?.addEventListener('click', () => { saveDraft(); stopPoll(); generation++; selected = null; $('director-dialog').hidden = true; });
  $('directors-logout').addEventListener('click', async () => { if ([...drafts.values()].some(draft => draft.text.trim()) && !confirm('Выйти? Несохраненные сообщения будут потеряны.')) return; try { await api('/api/logout', { method: 'POST' }); location.href = '/login.html'; } catch (error) { status(error.message, true); } });
  window.addEventListener('beforeunload', event => { if ([...drafts.values()].some(draft => draft.text.trim())) { event.preventDefault(); event.returnValue = ''; } });
  refresh();
})();
