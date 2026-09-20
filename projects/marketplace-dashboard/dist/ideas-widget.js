'use strict';
(() => {
  const root = document.getElementById('ideas-widget');
  if (!root) return;
  if (!document.querySelector('link[href="/ideas.css"]')) {
    const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = '/ideas.css'; document.head.appendChild(stylesheet);
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const labels = { deferred: 'Отложено', active: 'В работе', done: 'Готово' };
  let state = null;
  let pendingAttempt = null;
  function draw(draft = '') {
    root.innerHTML = `<div class="ideas-widget-head"><div><span class="eyebrow">РАЗВИТИЕ</span><h2>Идеи</h2></div><a href="/ideas.html">Весь реестр →</a></div><form class="ideas-widget-form"><input maxlength="160" required aria-label="Название идеи" placeholder="Быстро записать идею"><button class="button" type="submit">Добавить</button></form><p class="ideas-widget-error" role="alert"></p><div class="ideas-widget-list">${state.ideas.slice(0, 3).map(idea => `<a href="/ideas.html"><strong>${esc(idea.title)}</strong><small>${esc(idea.direction)} · ${labels[idea.status]}</small></a>`).join('') || '<p>Пока нет идей. Запишите первую.</p>'}</div>`;
    const input = root.querySelector('input'); input.value = draft;
    input.oninput = () => { if (pendingAttempt && input.value !== pendingAttempt.signature) pendingAttempt = null; };
    root.querySelector('form').onsubmit = submit;
  }
  async function request(url, body) {
    const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {}; try { data = await response.json(); } catch {}
    if (!response.ok) { const error = new Error(response.status === 404 ? 'Нужен запуск обновлённой версии Пульта' : data.error || 'Не удалось сохранить идею'); error.status = response.status; throw error; }
    return data;
  }
  async function submit(event) {
    event.preventDefault(); const input = event.currentTarget.querySelector('input'), button = event.currentTarget.querySelector('button'), title = input.value; button.disabled = true;
    if (!pendingAttempt || pendingAttempt.signature !== title) pendingAttempt = { signature: title, id: crypto.randomUUID() };
    try {
      state = await request('/api/ideas/create', { version: state.version, title, clientRequestId: pendingAttempt.id });
      const draft = input.value === title ? '' : input.value; pendingAttempt = null; draw(draft);
    } catch (error) {
      if (error.status === 409) {
        try { state = await request('/api/ideas'); draw(title); } catch {}
      }
      const currentInput = root.querySelector('input'); root.querySelector('.ideas-widget-error').textContent = error.message; currentInput.disabled = false; root.querySelector('button').disabled = false; currentInput.focus();
    }
  }
  request('/api/ideas').then(value => { state = value; draw(); }).catch(error => { root.innerHTML = `<div class="ideas-widget-head"><div><span class="eyebrow">РАЗВИТИЕ</span><h2>Идеи</h2></div><a href="/ideas.html">Открыть реестр →</a></div><p class="ideas-widget-error" role="alert">${esc(error.message)}</p>`; });
})();
