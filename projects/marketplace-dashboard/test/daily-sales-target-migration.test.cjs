'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { apply } = require('../scripts/migrate-daily-sales-targets.cjs');
const { DAILY_SALES_TARGET_SQL } = require('../storage/postgres-live-schema.cjs');

test('daily target migration is additive, transactional and grants bounded access', async () => {
 const statements = [];
 const client = { async query(sql) {
  statements.push(sql);
  if (sql.includes('to_regclass')) return { rows: [{ present: false }] };
  if (sql.includes('has_table_privilege')) return { rows: [{ app_read: true, importer_insert: true }] };
  return { rows: [] };
 }, release() { statements.push('RELEASE'); } };
 assert.deepEqual(await apply({ async connect() { return client; } }), { table: 'pult_live.daily_sales_targets', created: true, appRead: true });
 assert.equal(statements[0], 'BEGIN');
 assert.ok(statements.includes(DAILY_SALES_TARGET_SQL));
 assert.ok(statements.includes('GRANT SELECT ON pult_live.daily_sales_targets TO pult_app'));
 assert.ok(statements.includes('COMMIT'));
 assert.equal(statements.at(-1), 'RELEASE');
 assert.ok(statements.every(sql => !/DROP|TRUNCATE|DELETE FROM/iu.test(sql)));
});

test('daily target migration rolls back on failed privilege verification', async () => {
 const statements = [];
 const client = { async query(sql) {
  statements.push(sql);
  if (sql.includes('to_regclass')) return { rows: [{ present: true }] };
  if (sql.includes('has_table_privilege')) return { rows: [{ app_read: false, importer_insert: true }] };
  return { rows: [] };
 }, release() { statements.push('RELEASE'); } };
 await assert.rejects(apply({ async connect() { return client; } }), { message: 'TARGET_PRIVILEGES_INVALID' });
 assert.ok(statements.includes('ROLLBACK'));
 assert.ok(!statements.includes('COMMIT'));
 assert.equal(statements.at(-1), 'RELEASE');
});
