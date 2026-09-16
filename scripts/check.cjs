'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { secretFinding } = require('./sync-core.cjs');
const root = path.resolve(__dirname, '..');
const files = cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
let checked = 0;
for (const name of new Set(files)) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  if (/(^|\/)(\.private|data|node_modules|work|\.env[^/]*)(\/|$)|\.(pem|key|sqlite|db)$/i.test(name)) throw Error('Private file in publish set: ' + name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Non-regular file: ' + name);
  if (secretFinding(fs.readFileSync(file, 'utf8'))) throw Error('Possible secret in ' + name);
  if (/\.(js|cjs|mjs)$/.test(name)) {
    cp.execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    checked++;
  }
}
console.log('Syntax and secret-pattern checks passed: ' + checked + ' scripts.');
for (const [folder, pattern] of [['projects/marketplace-dashboard', 'test/*.test.cjs'], ['projects/project-center', 'test/*-tests.cjs'], ['.', 'scripts/*.test.cjs']]) {
  cp.execFileSync(process.execPath, ['--test', pattern], { cwd: path.join(root, folder), stdio: 'inherit', timeout: 120000 });
}
