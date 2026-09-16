(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const roles = { admin: 'Администратор', editor: 'Редактор', viewer: 'Наблюдатель' };
  let currentUser = null;
  function notice(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
  async function api(url, method = 'GET', body) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await r.json();
    if (r.status === 401) { location.href = '/login.html'; throw Error(data.error || 'Войдите снова.'); }
    if (!r.ok) throw Error(data.error || 'Не удалось выполнить действие.');
    return data;
  }
  async function loadUsers() {
    if (!currentUser || currentUser.role !== 'admin') { $('users-panel').hidden = true; return; }
    const data = await api('/api/users');
    $('users-panel').hidden = false;
    $('users-list').replaceChildren();
    for (const user of data.users) {
      const row = document.createElement('div'); row.className = 'user-row';
      const label = document.createElement('span'); label.textContent = user.username + (user.disabled ? ' · заблокирован' : '') + (user.username === currentUser.username ? ' · вы' : '');
      const select = document.createElement('select'); select.setAttribute('aria-label', 'Роль: ' + user.username);
      for (const [value, text] of Object.entries(roles)) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
      select.value = user.role;
      const save = document.createElement('button'); save.textContent = 'Сохранить роль'; save.className = 'secondary';
      const block = document.createElement('button'); block.textContent = user.disabled ? 'Разблокировать' : 'Заблокировать'; block.className = 'secondary';
      select.disabled = save.disabled = block.disabled = user.username === currentUser.username;
      async function update(patch) {
        save.disabled = block.disabled = true;
        try { await api('/api/users', 'PATCH', { username: user.username, ...patch }); await loadUsers(); notice('Права сотрудника обновлены. Его прежние сеансы завершены.'); }
        catch (error) { notice(error.message, true); save.disabled = block.disabled = false; }
      }
      save.onclick = () => update({ role: select.value });
      block.onclick = () => update({ disabled: !user.disabled });
      row.append(label, select, save, block); $('users-list').append(row);
    }
  }
  document.addEventListener('ozon-state', event => {
    const prior = currentUser; currentUser = event.detail.user;
    if (!prior || prior.role !== currentUser?.role) loadUsers().catch(e => notice(e.message, true));
  });
  api('/api/state').then(data => { currentUser = data.user; return loadUsers(); }).catch(e => notice(e.message, true));
  $('logout-button').onclick = async () => { try { await api('/api/logout', 'POST'); location.href = '/login.html'; } catch (e) { notice(e.message, true); } };
  $('user-form').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
    try { await api('/api/users', 'POST', Object.fromEntries(new FormData(form))); form.reset(); await loadUsers(); notice('Сотрудник добавлен.'); }
    catch (e) { notice(e.message, true); } finally { button.disabled = false; }
  };
  $('password-form').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
    try { await api('/api/password', 'POST', Object.fromEntries(new FormData(form))); form.reset(); location.href = '/login.html'; }
    catch (e) { notice(e.message, true); } finally { button.disabled = false; }
  };
})();
