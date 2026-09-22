'use strict';

// Explicit one-time database/role provisioning. Does not import or switch Pult.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const ROOT = path.resolve(__dirname, '..');
const DIRECTORY = path.join(ROOT, '.private', 'postgres-setup');
const ROLES = ['pult_migrator', 'pult_importer', 'pult_app'];
const FILES = ['migrator.dpapi', 'importer.dpapi', 'application.dpapi'];
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function dpapi(bytes, decrypt = false) {
  if (process.platform !== 'win32') fail('DPAPI_UNAVAILABLE');
  return new Promise((resolve, reject) => {
    const operation = decrypt ? 'Unprotect' : 'Protect';
    const script = `Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $outputBytes=[Security.Cryptography.ProtectedData]::${operation}($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($outputBytes)); [Array]::Clear($inputBytes,0,$inputBytes.Length); [Array]::Clear($outputBytes,0,$outputBytes.Length)`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const error = () => Object.assign(new Error('DPAPI_FAILED'), { code: 'DPAPI_FAILED' });
    const timer = setTimeout(() => { child.kill(); finish(error()); }, 10000);
    child.on('error', () => finish(error())); child.stdin.on('error', () => finish(error()));
    child.stdout.on('data', value => { output += value.toString('ascii'); if (output.length > 128 * 1024) { child.kill(); finish(error()); } });
    child.on('close', code => {
      if (code || !/^[A-Za-z0-9+/]+={0,2}$/u.test(output)) return finish(error());
      const value = Buffer.from(output, 'base64'); output = ''; finish(null, value);
    });
    child.stdin.end(bytes.toString('base64'));
  });
}

async function assertRealAncestors(file) {
  let cursor = file;
  while (true) {
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) fail('LINKED_SETUP_PATH');
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function main() {
  if (process.argv.length !== 2) fail('USAGE');
  const adminFile = path.join(DIRECTORY, 'admin.dpapi');
  await assertRealAncestors(adminFile);
  const stat = await fs.lstat(adminFile);
  if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) fail('BOOTSTRAP_INVALID');
  let plaintext = await dpapi(await fs.readFile(adminFile), true), config;
  try { config = JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); plaintext = null; }
  if (config.host !== '127.0.0.1' || config.port !== 5441 || config.user !== 'pult_admin' || config.database !== 'postgres' ||
      typeof config.password !== 'string' || config.password.length < 24 || config.password.length > 1024) fail('BOOTSTRAP_INVALID');
  for (const file of [...FILES, 'provisioning.json']) {
    const exists = await fs.lstat(path.join(DIRECTORY, file)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) fail('EXISTING_PROVISIONING_REQUIRES_INSPECTION');
  }
  const admin = new Pool({ ...config, max: 1, application_name: 'pult_provision', connectionTimeoutMillis: 5000, statement_timeout: 60000 });
  const markerFile = path.join(DIRECTORY, 'provisioning.json');
  const invocation = crypto.randomUUID();
  let markerCreated = false, owner;
  try {
    const identity = (await admin.query('SELECT current_user AS role,current_database() AS db,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
    if (identity?.role !== 'pult_admin' || identity.db !== 'postgres' || identity.rolsuper !== true) fail('ADMIN_IDENTITY_INVALID');
    // Held by the sole admin pool connection throughout provisioning.
    await admin.query("SELECT pg_advisory_lock(hashtextextended('pult-provision-v1',0))");
    const occupied = await admin.query('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS db, EXISTS(SELECT 1 FROM pg_roles WHERE rolname=ANY($2::text[])) AS roles', ['pult', ROLES]);
    if (occupied.rows[0].db || occupied.rows[0].roles) fail('EXISTING_DATABASE_OR_ROLE_REQUIRES_INSPECTION');
    const marker = await fs.open(markerFile, 'wx');
    try { await marker.writeFile(JSON.stringify({ version: 1, invocation, status: 'incomplete' }) + '\n'); await marker.sync(); } finally { await marker.close(); }
    markerCreated = true;
    const connections = ROLES.map(user => ({ host: config.host, port: config.port, database: 'pult', user, password: crypto.randomBytes(36).toString('base64url') }));
    // Persist all credentials before creating any object; interrupted provisioning remains recoverable.
    for (let index = 0; index < connections.length; index++) {
      const input = Buffer.from(JSON.stringify(connections[index]));
      let protectedBytes;
      try { protectedBytes = await dpapi(input); } finally { input.fill(0); }
      const handle = await fs.open(path.join(DIRECTORY, FILES[index]), 'wx');
      try { await handle.writeFile(protectedBytes); await handle.sync(); } finally { await handle.close(); }
    }
    await admin.query('BEGIN');
    try {
      for (const connection of connections) {
        // Fixed identifiers and generated base64url passwords cannot contain SQL quotes.
        await admin.query(`CREATE ROLE "${connection.user}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${connection.password}'`);
        await admin.query(`COMMENT ON ROLE "${connection.user}" IS 'pult-provision:${invocation}'`);
      }
      await admin.query('COMMIT');
    } catch (error) { await admin.query('ROLLBACK').catch(() => {}); throw error; }
    await admin.query('CREATE DATABASE pult OWNER pult_migrator TEMPLATE template0 ENCODING \'UTF8\'');
    await admin.query(`COMMENT ON DATABASE pult IS 'pult-provision:${invocation}'`);
    await admin.query('REVOKE ALL ON DATABASE pult FROM PUBLIC');
    await admin.query('GRANT CONNECT ON DATABASE pult TO pult_app,pult_importer');
    owner = new Pool({ ...connections[0], max: 1, application_name: 'pult_schema_provision', connectionTimeoutMillis: 5000, statement_timeout: 60000 });
    await owner.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    for (const moduleName of ['postgres-schema', 'postgres-document-schema', 'postgres-history-schema', 'postgres-market-schema']) {
      await owner.query(require(path.join(ROOT, 'storage', moduleName + '.cjs')));
    }
    for (const schema of ['pult', 'pult_history', 'pult_market']) {
      await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO pult_app,pult_importer`);
      await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO pult_app,pult_importer`);
      await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO pult_app,pult_importer`);
    }
    await owner.query('REVOKE UPDATE,DELETE ON pult.commands FROM pult_app');
    await owner.query('REVOKE INSERT,UPDATE,DELETE ON pult.schema_versions FROM pult_app');
    const privileges = await owner.query(`SELECT r.rolname,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
      has_schema_privilege(r.rolname,'pult','CREATE') OR has_schema_privilege(r.rolname,'pult_history','CREATE') OR has_schema_privilege(r.rolname,'pult_market','CREATE') AS can_ddl
      FROM pg_roles r WHERE r.rolname=ANY($1::text[])`, [['pult_app', 'pult_importer']]);
    if (privileges.rows.length !== 2 || privileges.rows.some(row => row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolreplication || row.rolbypassrls || row.can_ddl)) fail('EXCESSIVE_ROLE_PRIVILEGES');
    const app = await require('../storage/postgres-connection.cjs').createApplicationPool({ bootstrapFile: path.join(DIRECTORY, 'application.dpapi') });
    try {
      const checks = (await app.query("SELECT has_table_privilege(current_user,'pult.commands','UPDATE') AS can_rewrite_journal, has_table_privilege(current_user,'pult.document_states','INSERT') AS can_write_state")).rows[0];
      if (checks.can_rewrite_journal || !checks.can_write_state) fail('APPLICATION_PRIVILEGES_INVALID');
    } finally { await app.end(); }
    const record = await fs.open(markerFile, 'r+');
    try { await record.truncate(0); await record.writeFile(JSON.stringify({ version: 1, invocation, status: 'complete', imported: false, cutover: false }) + '\n'); await record.sync(); } finally { await record.close(); }
    console.log('PostgreSQL application database and restricted roles provisioned. No business import or application cutover performed.');
  } catch (error) {
    // Never drop potentially useful state after an uncertain outcome. DPAPI files remain for explicit recovery.
    if (markerCreated) console.error('Provisioning is incomplete; protected credentials and the database are preserved for inspection.');
    throw error;
  } finally { if (owner) await owner.end().catch(() => {}); await admin.end().catch(() => {}); config = null; }
}

main().catch(error => {
  const code = error?.code && /^[A-Z_]+$/u.test(error.code) ? error.code : 'POSTGRES_PROVISION_FAILED';
  console.error(`PostgreSQL provisioning failed: ${code}`); process.exitCode = 1;
});
