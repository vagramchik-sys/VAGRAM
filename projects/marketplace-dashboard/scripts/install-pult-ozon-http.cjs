'use strict';
// Explicit privileged deployment. The running application never loads this file.
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { createApplicationPool } = require('../storage/postgres-connection.cjs');
const { buildPostgresOzonHttpSql, createPostgresOzonApi } = require('../storage/acquisition/postgres-ozon-http.cjs');

async function install(admin) {
  const identity = (await admin.query('SELECT current_user AS role,current_database() AS database,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
  if (identity?.role !== 'pult_admin' || identity.database !== 'pult' || identity.rolsuper !== true) throw Error('ADMIN_IDENTITY_INVALID');
  await admin.query('CREATE EXTENSION IF NOT EXISTS plpython3u');
  await admin.query(buildPostgresOzonHttpSql());
}

async function main() {
  if (process.argv.length !== 2) throw Error('USAGE');
  const file = path.resolve(__dirname, '..', '.private/postgres-setup/admin.dpapi');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('BOOTSTRAP_INVALID');
  const bytes = Buffer.from(await require('../storage/windows-dpapi.cjs').protect((await fs.readFile(file)).toString('base64'),true),'utf8');
  let config;
  try { config = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
  if (config.host !== '127.0.0.1' || config.port !== 5441 || config.user !== 'pult_admin' || config.database !== 'postgres' || typeof config.password !== 'string' || config.password.length < 24) throw Error('BOOTSTRAP_INVALID');
  const admin = new Pool({host:config.host,port:config.port,user:config.user,password:config.password,database:'pult',max:1,application_name:'pult_ozon_install',statement_timeout:30000});
  config.password = null;
  let app;
  try {
    await install(admin);
    app = await createApplicationPool({bootstrapFile:path.resolve(__dirname,'..','.private/postgres-setup/application.dpapi'),profile:'outbound'});
    const readiness = await createPostgresOzonApi({pool:app}).checkReadiness();
    console.log(JSON.stringify({installed:true,...readiness}));
  } finally { await admin.end(); if (app) await app.end(); }
}
if (require.main === module) main().catch(() => { console.error(JSON.stringify({code:'OZON_HTTP_INSTALL_FAILED'})); process.exitCode=1; });
module.exports={install};
