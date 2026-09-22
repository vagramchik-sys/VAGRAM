(function (scope) {
  'use strict';
  const STORAGE_KEY = 'pult.pending-commands.v1';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const REVISION = /^(0|[1-9][0-9]*)$/;
  const STORE_ACTIONS = new Set(['/api/connect', '/api/connect-wb', '/api/disconnect', '/api/sync']);
  const pendingMessage = 'Предыдущее сохранение ещё не подтверждено. Повторите то же действие с прежними данными.';
  function createTransport({ fetch: nativeFetch, baseURL, crypto, storage, now = () => new Date(), enabled = null }) {
    const origin = new URL(baseURL).origin;
    const inFlight = new Map();
    let registryRevision = null;
    let protocolEnabled = enabled;
    function rememberRevision(response) {
      const value = response.headers.get('x-pult-registry-revision') ?? response.headers.get('x-pult-expected-revision');
      if (response.ok && REVISION.test(value || '')) { registryRevision = value; protocolEnabled = true; }
      return response;
    }
    async function readRegistry() {
      const response = await nativeFetch(new Request(origin + '/api/stores', { credentials: 'same-origin' }));
      if (!response.ok) throw Error('Не удалось загрузить магазины. Обновите страницу и повторите действие.');
      rememberRevision(response);
      if (protocolEnabled === null) protocolEnabled = registryRevision !== null;
    }
    function load() {
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return {};
        if (raw.length > 100000) throw Error();
        const values = JSON.parse(raw);
        if (!values || Array.isArray(values) || typeof values !== 'object') throw Error();
        for (const [key, value] of Object.entries(values)) {
          if (!key.startsWith('/api/') || !value || !UUID.test(value.commandId) ||
              !/^[a-f0-9]{64}$/.test(value.fingerprint) || !Number.isFinite(Date.parse(value.timestamp)) ||
              new Date(value.timestamp).toISOString() !== value.timestamp ||
              (value.expectedRevision !== null && (typeof value.expectedRevision !== 'string' || !REVISION.test(value.expectedRevision)))) throw Error();
        }
        return values;
      } catch { throw Error('Не удалось восстановить состояние сохранения. Не повторяйте изменение, пока его результат не проверен.'); }
    }
    function save(values) {
      try { storage.setItem(STORAGE_KEY, JSON.stringify(values)); }
      catch { throw Error('Браузер не смог запомнить состояние запроса. Проверьте результат сохранения перед повтором.'); }
    }
    function clear(action, commandId) {
      const values = load();
      if (values[action]?.commandId === commandId) { delete values[action]; save(values); }
    }
    async function fingerprint(request) {
      const body = new Uint8Array(await request.clone().arrayBuffer());
      const metadata = new TextEncoder().encode(JSON.stringify([
        request.method, request.url, request.headers.get('content-type'), request.headers.get('x-file-name'), body.byteLength
      ]) + '\n');
      const bytes = new Uint8Array(metadata.length + body.length);
      bytes.set(metadata); bytes.set(body, metadata.length);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    function uncertain(response) {
      return new Response(JSON.stringify({ error: pendingMessage }), {
        status: response?.status >= 500 ? response.status : 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
    return async function commandFetch(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), baseURL);
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.origin !== origin || !url.pathname.startsWith('/api/')) return nativeFetch(input, init);
      if (method !== 'POST') {
        const response = await nativeFetch(input, init);
        if (method === 'GET' && url.pathname === '/api/stores') rememberRevision(response);
        return response;
      }
      if (protocolEnabled === null) await readRegistry();
      // Keep the running legacy backend unchanged until PostgreSQL advertises its protocol.
      if (protocolEnabled !== true) return nativeFetch(input, init);
      const request = new Request(input instanceof Request ? input : url.href, init);
      if (request.signal.aborted) throw new DOMException('Запрос отменён', 'AbortError');
      const action = url.pathname + url.search;
      const hash = await fingerprint(request);
      let values = load(), command = values[action];
      if (command && command.fingerprint !== hash) throw Error(pendingMessage);
      if (!command) {
        if (Object.keys(values).length >= 64) throw Error(pendingMessage);
        if (STORE_ACTIONS.has(url.pathname) && registryRevision === null) {
          await readRegistry();
          if (registryRevision === null) throw Error('Не удалось проверить состояние магазинов. Обновите страницу.');
        }
        // Another pending request may have been saved while stores were loading.
        values = load(); command = values[action];
        if (command && command.fingerprint !== hash) throw Error(pendingMessage);
        if (!command) {
          const commandId = request.headers.get('x-pult-command-id') || crypto.randomUUID();
          const timestamp = request.headers.get('x-pult-command-timestamp') || now().toISOString();
          if (!UUID.test(commandId) || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw Error('Некорректные параметры сохранения.');
          const explicitRevision = request.headers.get('x-pult-expected-revision');
          if (explicitRevision !== null && !REVISION.test(explicitRevision)) throw Error('Некорректные параметры сохранения.');
          command = { commandId, timestamp, fingerprint: hash, expectedRevision: explicitRevision ?? (STORE_ACTIONS.has(url.pathname) ? registryRevision : null) };
          values[action] = command;
          // Only the digest and command identity survive reload, never request data or keys.
          save(values);
        }
      }
      const explicitId = request.headers.get('x-pult-command-id');
      const explicitTime = request.headers.get('x-pult-command-timestamp');
      const explicitRevision = request.headers.get('x-pult-expected-revision');
      if ((explicitId && explicitId !== command.commandId) || (explicitTime && explicitTime !== command.timestamp) ||
          (explicitRevision !== null && explicitRevision !== command.expectedRevision)) throw Error(pendingMessage);
      const running = inFlight.get(action);
      if (running) return (await running).clone();
      const headers = new Headers(request.headers);
      headers.set('x-pult-command-id', command.commandId);
      headers.set('x-pult-command-timestamp', command.timestamp);
      if (command.expectedRevision !== null) headers.set('x-pult-expected-revision', command.expectedRevision);
      const task = (async () => {
        let response;
        try { response = await nativeFetch(new Request(request, { headers })); }
        catch { return uncertain(); }
        if (response.status >= 500 || response.status === 408) return uncertain(response);
        if (response.ok) {
          try { await response.clone().json(); }
          catch { return uncertain(); }
        }
        // A clear success or a definitive rejection permits a new user action.
        clear(action, command.commandId);
        if (STORE_ACTIONS.has(url.pathname)) registryRevision = null;
        rememberRevision(response);
        return response;
      })();
      inFlight.set(action, task);
      try { return (await task).clone(); }
      finally { if (inFlight.get(action) === task) inFlight.delete(action); }
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createTransport, STORAGE_KEY };
  else if (scope && !scope.PultCommands) {
    // Lazily access storage: read-only pages still work if storage is unavailable.
    const storage = { getItem: key => scope.sessionStorage.getItem(key), setItem: (key, value) => scope.sessionStorage.setItem(key, value) };
    scope.fetch = createTransport({ fetch: scope.fetch.bind(scope), baseURL: scope.location.href, crypto: scope.crypto, storage });
    scope.PultCommands = Object.freeze({ installed: true });
  }
})(typeof window === 'undefined' ? null : window);
