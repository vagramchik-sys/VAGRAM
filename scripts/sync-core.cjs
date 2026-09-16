'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ignored = new Set(['.git', '.private', '.openai', '.sites-runtime', '.vagram', 'node_modules', 'work', 'outputs', 'data']);
const extensions = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.md', '.ps1', '.csv', '.svg', '.yml', '.yaml', '.txt']);
const normalize = text => text.replace(/\r\n/g, '\n');
const digest = text => text === undefined ? null : crypto.createHash('sha256').update(normalize(text)).digest('hex');
function allowed(name, repoOnly = []) {
  const parts = name.split('/');
  return !parts.some(p => ignored.has(p) || p.startsWith('.env') || p === 'AGENTS.md' || p === 'AGENTS.override.md') &&
    !repoOnly.some(p => name === p || name.startsWith(p + '/')) &&
    (['.gitignore', '.gitattributes'].includes(parts.at(-1)) || extensions.has(path.extname(name).toLowerCase())) &&
    !/(?:^|\/)(?:credentials|secrets|cookies|store)(?:[.-]|$)/i.test(name);
}
function scan(root, repoOnly = []) {
  const files = {};
  function walk(dir, prefix = '') {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + item.name;
      if (item.isSymbolicLink()) throw Error('Symbolic link requires manual review: ' + rel);
      if (item.isDirectory()) {
        if (!ignored.has(item.name) && !repoOnly.includes(rel)) walk(path.join(dir, item.name), rel + '/');
      } else if (allowed(rel, repoOnly)) {
        const bytes = fs.readFileSync(path.join(dir, item.name));
        if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) throw Error('File requires manual review: ' + rel);
        files[rel] = normalize(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      }
    }
  }
  walk(root);
  return files;
}
function plan(base, local, remote) {
  const result = { outgoing: [], incoming: [], conflicts: [] };
  for (const name of [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort()) {
    const b = digest(base[name]), l = digest(local[name]), r = digest(remote[name]);
    if (l === r) continue;
    if (l !== b && r !== b) result.conflicts.push(name);
    else if (l !== b) result.outgoing.push(name);
    else result.incoming.push(name);
  }
  return result;
}
function safePath(root, relative) {
  if (!relative || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(relative)) throw Error('Unsafe relative path');
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw Error('Path escaped root');
  let cursor = path.resolve(root);
  if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw Error('Linked root refused');
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw Error('Linked path refused');
  }
  return target;
}
function secretFinding(text) {
  return /(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]+\.)/.test(text);
}
module.exports = { allowed, scan, plan, digest, normalize, safePath, secretFinding };
