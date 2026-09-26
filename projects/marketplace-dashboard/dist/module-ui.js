// Small DOM primitives for new manifest-based modules. Existing dashboard components stay in place.
(function (scope) {
  'use strict';
  const doc = scope.document;
  function node(tag, className, value) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined && value !== null) element.textContent = String(value);
    return element;
  }
  function pageHeader(title, description) {
    const header = node('header', 'module-page-header');
    header.append(node('h1', '', title));
    if (description) header.append(node('p', '', description));
    return header;
  }
  function state(kind, message) {
    const element = node('div', `module-state module-state-${kind}`, message);
    element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    return element;
  }
  function setState(root, kind) {
    for (const element of root.querySelectorAll('[data-state]')) element.hidden = element.dataset.state !== kind;
    root.querySelector('.module-state')?.setAttribute('aria-busy', String(kind === 'loading'));
  }
  function kpiCard(label, value, note) {
    const card = node('article', 'module-kpi-card');
    card.append(node('span', 'module-kpi-label', label), node('strong', 'module-kpi-value', value));
    if (note) card.append(node('small', 'module-kpi-note', note));
    return card;
  }
  function dataTable(columns, rows) {
    const wrapper = node('div', 'module-table-wrap'), table = node('table', 'module-table');
    const head = node('thead'), heading = node('tr'), body = node('tbody');
    for (const column of columns) heading.append(node('th', '', column.label));
    head.append(heading);
    for (const row of rows) { const tr = node('tr'); for (const column of columns) tr.append(node('td', '', row[column.key] ?? '—')); body.append(tr); }
    table.append(head, body); wrapper.append(table);
    return wrapper;
  }
  scope.PultModuleUI = Object.freeze({ node, pageHeader, state, setState, kpiCard, dataTable });
})(window);
