'use strict';
// Per-project synchronization. Credentials are never read or stored by this tool.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { allowed, scan, plan, digest, normalize, safePath, secretFinding } = require('./sync-core.cjs');
const root = path.resolve(__dirname, '..');
function git(args, cwd = root) { return cp.execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(); }
const privateDir = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'vagram');
const configFile = path.join(privateDir, 'links.json');
function save(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp-' + crypto.randomUUID(); fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }
function remoteFiles(sha, link) {
  const names = git(['ls-tree', '-r', '--name-only', '-z', sha, '--', link.prefix]).split('\0').filter(Boolean);
  const result = {};
  for (const full of names) {
    const relative = full.slice(link.prefix.length + 1);
    if (allowed(relative, link.repoOnly || [])) result[relative] = normalize(cp.execFileSync('git', ['show', sha + ':' + full], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
  }
  return result;
}
function refresh() {
  if (git(['remote', 'get-url', 'origin']) !== 'https://github.com/vagramchik-sys/VAGRAM.git') throw Error('Unexpected origin');
  git(['fetch', 'origin', 'main']);
  return git(['rev-parse', 'origin/main']);
}
function state(link, sha) {
  if (!fs.existsSync(link.source)) throw Error('Source folder missing: ' + link.source);
  const base = remoteFiles(link.baseline, link), local = scan(link.source, link.repoOnly || []), remote = remoteFiles(sha, link);
  return { base, local, remote, ...plan(base, local, remote) };
}
function main() {
  const [command = 'status', id, argument] = process.argv.slice(2);
  if (!['status', 'update', 'prepare', 'ack'].includes(command)) throw Error('Usage: node scripts/vagram.cjs status | update PROJECT | prepare PROJECT | ack PROJECT COMMIT');
  if (!fs.existsSync(configFile)) throw Error('Local links are not configured. See docs/workflow/README.md.');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const sha = refresh();
  if (command === 'status') {
    for (const [key, link] of Object.entries(config.projects)) {
      const s = state(link, sha);
      console.log(JSON.stringify({ project: key, localChanges: s.outgoing, githubChanges: s.incoming, conflicts: s.conflicts }));
    }
    return;
  }
  const link = config.projects[id];
  if (!link) throw Error('Unknown project');
  const s = state(link, sha);
  if (command === 'ack') {
    if (!argument || !/^[a-f0-9]{40}$/.test(argument)) throw Error('Expected full published commit SHA');
    const pendingFile = path.join(privateDir, 'pending-' + id + '.json');
    const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    git(['merge-base', '--is-ancestor', argument, sha]);
    const published = remoteFiles(argument, link);
    for (const name of new Set([...Object.keys(pending.source), ...Object.keys(published)])) {
      if (digest(pending.source[name]) !== digest(published[name])) throw Error('Published project does not match prepared snapshot: ' + name);
    }
    link.baseline = argument;
    save(configFile, config);
    console.log('Verified on GitHub; baseline updated. Newer local edits were preserved.');
    return;
  }
  if (s.conflicts.length) throw Error('Conflicting local/GitHub edits; resolve manually: ' + s.conflicts.join(', '));
  if (command === 'update') {
    const backup = path.join(privateDir, 'backups', id + '-' + Date.now());
    // Validate all targets and save a recoverable snapshot before modifying any source.
    for (const name of s.incoming) safePath(link.source, name);
    if (s.incoming.length) save(path.join(backup, 'before.json'), { source: link.source, baseline: link.baseline, files: Object.fromEntries(s.incoming.map(n => [n, s.local[n] ?? null])) });
    for (const name of s.incoming) {
      const file = safePath(link.source, name);
      const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
      if (digest(now) !== digest(s.local[name])) throw Error('Source changed during update: ' + name);
      if (s.remote[name] === undefined) fs.unlinkSync(file);
      else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, s.remote[name]); }
    }
    link.baseline = sha; save(configFile, config);
    console.log(JSON.stringify({ updatedFiles: s.incoming, preservedLocalChanges: s.outgoing, backup: s.incoming.length ? backup : null }));
    return;
  }
  if (s.incoming.length) throw Error('Run update for this project before preparing; incoming files: ' + s.incoming.join(', '));
  if (!s.outgoing.length) { link.baseline = sha; save(configFile, config); console.log('Already synchronized.'); return; }
  for (const name of s.outgoing) if (s.local[name] !== undefined && secretFinding(s.local[name])) throw Error('Possible secret: ' + name);
  const stamp = id + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const candidate = path.join(root, 'work', 'candidates', stamp);
  git(['worktree', 'add', '--detach', candidate, sha]);
  for (const name of s.outgoing) {
    const target = safePath(candidate, link.prefix + '/' + name);
    if (s.local[name] === undefined) fs.unlinkSync(target);
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, s.local[name]); }
  }
  cp.execFileSync(process.execPath, [path.join(candidate, 'scripts/check.cjs')], { cwd: candidate, stdio: 'inherit', timeout: 180000 });
  const elements = s.outgoing.map(name => s.local[name] === undefined ? { path: link.prefix + '/' + name, mode: '100644', type: 'blob', sha: null } : { path: link.prefix + '/' + name, mode: '100644', type: 'blob', content: s.local[name] });
  const payload = path.join(privateDir, 'publish-' + stamp + '.json');
  save(payload, { repository_full_name: 'vagramchik-sys/VAGRAM', branch_name: 'main', base_commit_sha: sha, base_tree_sha: git(['rev-parse', sha + '^{tree}']), tree_elements: elements });
  save(path.join(privateDir, 'pending-' + id + '.json'), { source: s.local, payload, candidate, base: sha });
  console.log(JSON.stringify({ ready: true, project: id, files: s.outgoing, payload, candidate }));
  console.log('Publish this payload through the GitHub plugin using base_tree_sha, parent=base_commit_sha and force=false; then run ack PROJECT COMMIT.');
}
fs.mkdirSync(privateDir, { recursive: true });
const lock = path.join(privateDir, 'sync.lock');
let fd;
try { fd = fs.openSync(lock, 'wx'); fs.writeSync(fd, String(process.pid)); main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } }
