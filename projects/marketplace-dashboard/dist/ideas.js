'use strict';
const $ = id => document.getElementById(id);
const labels = { deferred: 'Отложено', active: 'В работе', done: 'Готово' };
let state = { version: 0, ideas: [] };
let editing = null;
let quickAttempt = null;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const missingApi = response => response.status === 404 ? 'Нужен запуск обновлённой версии Пульта' : null;
async function api(url, body) {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = {}; try { data = await response.json(); } catch {}
  if (!response.ok) { const error = new Error(missingApi(response) || data.error || 'Не удалось обратиться к Пульту'); error.status = response.status; throw error; }
  return data;
}
function notice(message, error = false) { $('idea-notice').textContent = message; $('idea-notice').className = error ? 'error' : ''; }
function date(value) { try { return new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'medium', timeStyle: 'short' }); } catch { return ''; } }
function match(idea) {
  const query = $('idea-search').value.trim().toLocaleLowerCase('ru-RU');
  return (!query || `${idea.title} ${idea.description} ${idea.direction}`.toLocaleLowerCase('ru-RU').includes(query)) &&
    (!$('status-filter').value || idea.status === $('status-filter').value) && (!$('direction-filter').value || idea.direction === $('direction-filter').value);
}
function updateDirections() {
  const selected = $('direction-filter').value;
  const directions = [...new Set(state.ideas.map(idea => idea.direction))].sort((a, b) => a.localeCompare(b, 'ru'));
  $('direction-filter').innerHTML = '<option value="">Все направления</option>' + directions.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
  $('direction-filter').value = directions.includes(selected) ? selected : '';
}
function render() {
  const ideas = state.ideas.filter(match);
  $('idea-list').innerHTML = ideas.map(idea => `<article class="panel idea-card" data-card="${esc(idea.id)}"><div class="idea-card-head"><div><h2>${esc(idea.title)}</h2><div class="idea-meta"><span>${esc(idea.direction)}</span><span>Обновлено ${esc(date(idea.updatedAt))} МСК</span></div></div><span class="idea-status ${esc(idea.status)}">${labels[idea.status]}</span></div><p class="idea-description${idea.description ? '' : ' empty'}">${esc(idea.description || 'Описание пока не добавлено')}</p><div class="idea-card-actions"><button class="button secondary" type="button" data-edit="${esc(idea.id)}">Редактировать</button></div>${editing === idea.id ? editor(idea) : ''}</article>`).join('') || '<div class="panel idea-empty">По выбранным условиям идей нет.</div>';
}
function editor(idea) {
  return `<form class="idea-edit" data-form="${esc(idea.id)}"><label class="wide">Название<input name="title" maxlength="160" required value="${esc(idea.title)}"></label><label class="wide">Описание<textarea name="description" maxlength="4000" placeholder="Суть, ожидаемый эффект и следующий шаг">${esc(idea.description)}</textarea></label><label>Направление<input name="direction" maxlength="80" required value="${esc(idea.direction)}"></label><label>Статус<select name="status"><option value="deferred"${idea.status === 'deferred' ? ' selected' : ''}>Отложено</option><option value="active"${idea.status === 'active' ? ' selected' : ''}>В работе</option><option value="done"${idea.status === 'done' ? ' selected' : ''}>Готово</option></select></label><div class="idea-edit-buttons"><span class="idea-edit-error" role="alert"></span><button class="button secondary" type="button" data-cancel>Отмена</button><button class="button" type="submit">Сохранить</button></div></form>`;
}
async function load() {
  try { state = await api('/api/ideas'); updateDirections(); render(); return true; }
  catch (error) { notice(error.message, true); $('idea-list').innerHTML = '<div class="panel idea-empty">Реестр сейчас недоступен.</div>'; return false; }
}
$('quick-form').onsubmit = async event => {
  event.preventDefault(); const input = $('quick-title'), button = event.currentTarget.querySelector('button');
  $('quick-error').textContent = ''; button.disabled = true;
  const title = input.value;
  if (!quickAttempt || quickAttempt.signature !== title) quickAttempt = { signature: title, id: crypto.randomUUID() };
  try {
    const next = await api('/api/ideas/create', { version: state.version, title, clientRequestId: quickAttempt.id });
    state = next; quickAttempt = null; if (input.value === title) input.value = ''; updateDirections(); render(); notice('Идея добавлена в реестр.');
  } catch (error) {
    $('quick-error').textContent = error.message;
    if (error.status === 409) {
      try { state = await api('/api/ideas'); updateDirections(); render(); } catch {}
    }
  }
  finally { button.disabled = false; input.focus(); }
};
$('quick-title').addEventListener('input', event => { if (quickAttempt && event.target.value !== quickAttempt.signature) quickAttempt = null; });
$('idea-list').onclick = event => {
  const edit = event.target.closest('[data-edit]'), cancel = event.target.closest('[data-cancel]');
  if (edit) { editing = edit.dataset.edit; render(); document.querySelector(`[data-form="${CSS.escape(editing)}"] input`).focus(); }
  if (cancel) { editing = null; render(); }
};
$('idea-list').onsubmit = async event => {
  const form = event.target.closest('[data-form]'); if (!form) return; event.preventDefault();
  const button = form.querySelector('[type=submit]'), errorNode = form.querySelector('.idea-edit-error'); button.disabled = true; errorNode.textContent = '';
  try {
    const fields = new FormData(form);
    state = await api('/api/ideas/update', { version: state.version, id: form.dataset.form, title: fields.get('title'), description: fields.get('description'), direction: fields.get('direction'), status: fields.get('status') });
    editing = null; updateDirections(); render(); notice('Изменения сохранены.');
  } catch (error) { errorNode.textContent = error.message; button.disabled = false; }
};
for (const id of ['idea-search', 'status-filter', 'direction-filter']) $(id).addEventListener(id === 'idea-search' ? 'input' : 'change', render);
load();
