'use strict';

(function renderModulePage() {
  const root = document.querySelector('[data-module-root="developer-example"]');
  if (!root) return;
  const states = Object.fromEntries([...root.querySelectorAll('[data-state]')].map(node => [node.dataset.state, node]));

  function PageHeader({ title, subtitle }) {
    root.querySelector('[data-page-title]').textContent = title;
    root.querySelector('[data-page-subtitle]').textContent = subtitle;
  }

  function showState(name, payload) {
    if (window.PultModuleUI && typeof window.PultModuleUI.setState === 'function') window.PultModuleUI.setState(root, name, payload);
    for (const [key, node] of Object.entries(states)) node.hidden = key !== name;
    root.querySelector('.module-state').setAttribute('aria-busy', String(name === 'loading'));
  }

  PageHeader({ title: "Пример модуля", subtitle: 'Страница нового модуля' });
  showState('loading');
  fetch("/api/modules/developer-example", { headers: { accept: 'application/json' } })
    .then(async response => {
      const payload = await response.json();
      if (!response.ok || payload.ok !== true) throw new Error('Module request failed');
      return payload.data;
    })
    .then(data => {
      if (!Array.isArray(data.items) || data.items.length === 0) return showState('empty');
      states.content.textContent = data.module;
      showState('content', data);
    })
    .catch(() => showState('error'));
})();
