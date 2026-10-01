'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {start} = require('../server-postgres.cjs');

test('slow Ozon campaign and market reads do not block local reports, and external concurrency stays bounded', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-ad-http-'));
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>test</title>');
  const gates = []; let entered = 0;
  const pool = {connect: async () => ({query: async () => ({rows: [{acquired: true}]}), release() {}})};
  const core = {ready: async () => ({}), publicStores: async () => [], publicSnapshot: async () => ({}), hasStore: async () => true};
  const server = await start({pool, core, staticDir: root, staticFiles: ['index.html'], readiness: async () => ({ready: true, missingAdapters: []}),
    ownerRoutesFactory: async () => ({handle: async () => false}), otherHandlers: [{handle: async (req, res, url) => {
      if (url.pathname.startsWith('/api/ad-control/') || url.pathname === '/api/growth/market') {entered++; await new Promise(resolve => gates.push(resolve)); res.writeHead(200).end('{}'); return true;}
      if (url.pathname === '/api/local-report') {res.writeHead(200).end('ready'); return true;}
      return false;
    }}]});
  t.after(async () => {for (const release of gates) release(); await server.close(); await fs.rm(root, {recursive: true, force: true});});
  const home = await fetch(server.origin), cookie = home.headers.get('set-cookie').split(';')[0]; await home.text();
  const get = async endpoint => {const r = await fetch(server.origin+endpoint, {headers: {cookie}, signal: AbortSignal.timeout(2000)});return {status: r.status, body: await r.text()};};
  const a = get('/api/ad-control/campaigns?store=1'), b = get('/api/growth/market?store=1&product=2');
  while (entered < 2) await new Promise(resolve => setImmediate(resolve));
  const c = get('/api/ad-control/campaign?store=1&campaign=3');
  assert.equal((await get('/api/local-report')).body, 'ready');
  assert.equal(entered, 2);
  gates[0](); await a;
  while (entered < 3) await new Promise(resolve => setImmediate(resolve));
  gates[1](); gates[2](); await Promise.all([b,c]);
});
