'use strict';

const { createRepository } = require('./repository.cjs');
const { createService } = require('./service.cjs');

function sendJson(response, status, payload, extraHeaders = {}) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders };
  if (typeof response.writeHead === 'function') response.writeHead(status, headers);
  if (typeof response.end === 'function') response.end(JSON.stringify(payload));
}

function create({ config, ctx = {} }) {
  if (!config || typeof config.apiNamespace !== 'string') throw new TypeError('Module config is required');
  const service = ctx.service || createService({ repository: createRepository({ db: ctx.db }) });
  return {
    async handle(request, response, url) {
      const pathname = url instanceof URL ? url.pathname : new URL(String(url), 'http://localhost').pathname;
      if (pathname !== config.apiNamespace) return false;
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported' } }, { allow: 'GET' });
        return true;
      }
      const started = Date.now();
      try {
        const data = await service.getStatus();
        sendJson(response, 200, { ok: true, data });
      } catch {
        if (ctx.logger && typeof ctx.logger.error === 'function') {
          ctx.logger.error({ module: config.id, route: config.apiNamespace, operation: 'getStatus', duration: Date.now() - started }, 'Module request failed');
        }
        sendJson(response, 503, { ok: false, error: { code: 'MODULE_UNAVAILABLE', message: 'Module is temporarily unavailable' } });
      }
      return true;
    }
  };
}

module.exports = { create };
