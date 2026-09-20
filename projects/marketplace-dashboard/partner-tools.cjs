'use strict';

// Owner-only: the main server checks its session, Host and POST Origin first.
module.exports = function createPartnerTools({ workspace, getAvailability = () => false }) {
  const routes = new Map([
    ['/api/partners/save', 'savePartner'],
    ['/api/partners/issue-credential', 'issueCredential'],
    ['/api/partners/revoke-credential', 'revokeCredential']
  ]);
  const reply = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function handle(req, res, url) {
    if (url.pathname !== '/api/partners/state' && !routes.has(url.pathname)) return false;
    try {
      if (url.search) throw Object.assign(Error('Параметры запроса не поддерживаются.'), { public: true, status: 400 });
      if (req.method === 'GET' && url.pathname === '/api/partners/state') {
        const state = workspace.ownerState();
        reply(res, 200, { ...state, capabilities: { ...state.capabilities, localListenerAvailable: getAvailability() } });
      } else if (req.method === 'POST' && routes.has(url.pathname)) {
        let bytes = 0; const chunks = [];
        for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 1000000) throw Object.assign(Error('Запрос слишком большой.'), { public: true, status: 413 }); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || Array.isArray(body) || typeof body !== 'object') throw Error(); } catch { throw Object.assign(Error('Некорректный JSON.'), { public: true, status: 400 }); }
        const allowed = url.pathname.endsWith('/save') ? ['id', 'version', 'name', 'productKeys', 'active'] : ['id', 'version'];
        if (Object.keys(body).some(k => !allowed.includes(k))) throw Object.assign(Error('Неподдерживаемые поля.'), { public: true, status: 400 });
        reply(res, 200, workspace[routes.get(url.pathname)](body));
      } else reply(res, 405, { error: 'Метод не поддерживается.' });
    } catch (error) { reply(res, error.public ? error.status || 400 : 500, { error: error.public ? error.message : 'Не удалось выполнить операцию.' }); }
    return true;
  }
  return { handle };
};
