'use strict';

// Additive migration for optional daily plans. Runtime never executes DDL.
const fs = require('node:fs/promises');
const path = require('node:path');
const { protect } = require('../storage/windows-dpapi.cjs');
const { DAILY_SALES_TARGET_SQL } = require('../storage/postgres-live-schema.cjs');

async function apply(pool) {
 const client = await pool.connect();
 try {
  await client.query('BEGIN');
  const before = (await client.query("SELECT to_regclass('pult_live.daily_sales_targets') IS NOT NULL AS present")).rows[0]?.present === true;
  await client.query(DAILY_SALES_TARGET_SQL);
  await client.query('REVOKE ALL ON pult_live.daily_sales_targets FROM PUBLIC');
  await client.query('GRANT SELECT ON pult_live.daily_sales_targets TO pult_app');
  await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON pult_live.daily_sales_targets TO pult_importer');
  const access = (await client.query("SELECT has_table_privilege('pult_app','pult_live.daily_sales_targets','SELECT') AS app_read, has_table_privilege('pult_importer','pult_live.daily_sales_targets','INSERT') AS importer_insert")).rows[0];
  if (!access?.app_read || !access.importer_insert) throw Error('TARGET_PRIVILEGES_INVALID');
  await client.query('COMMIT');
  return { table: 'pult_live.daily_sales_targets', created: !before, appRead: true };
 } catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
 } finally { client.release(); }
}

async function main() {
 if (process.argv.length !== 3 || process.argv[2] !== 'apply') throw Error('USAGE_APPLY');
 const bootstrap = path.resolve(__dirname, '../.private/postgres-setup/migrator.dpapi');
 const stat = await fs.lstat(bootstrap);
 if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 65536) throw Error('BOOTSTRAP_INVALID');
 const config = JSON.parse(await protect((await fs.readFile(bootstrap)).toString('base64'), true));
 if (config.host !== '127.0.0.1' || config.port !== 5441 || config.database !== 'pult' || config.user !== 'pult_migrator' || typeof config.password !== 'string' || config.password.length < 24) throw Error('BOOTSTRAP_INVALID');
 const { Pool } = require('pg');
 const pool = new Pool({ ...config, max: 1, application_name: 'pult_daily_target_migration', statement_timeout: 15000 });
 config.password = '';
 try {
  const identity = (await pool.query('SELECT current_user AS role, current_database() AS db, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
  if (identity?.role !== 'pult_migrator' || identity.db !== 'pult' || identity.rolsuper || identity.rolcreatedb || identity.rolcreaterole) throw Error('MIGRATOR_IDENTITY_INVALID');
  console.log(JSON.stringify(await apply(pool)));
 } finally { await pool.end(); }
}

if (require.main === module) main().catch(error => {
 console.error(JSON.stringify({ error: /^[A-Z0-9_]+$/u.test(error?.code || error?.message || '') ? error.code || error.message : 'TARGET_MIGRATION_FAILED' }));
 process.exitCode = 1;
});

module.exports = { apply };
