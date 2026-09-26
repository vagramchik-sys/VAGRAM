'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createApplicationPool, readApplicationBootstrap } = require('../storage/postgres-connection.cjs');
const config = {host:'127.0.0.1',port:5441,user:'pult_app',database:'pult',password:'synthetic-password-only-for-contract-test'};

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-bootstrap-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const file = path.join(dir,'opaque.dpapi');
  await fs.writeFile(file,Buffer.from([3,7,9]));
  return file;
}

test('only a restricted local app role can be loaded; extra connection options are discarded', async t => {
  const file = await fixture(t);
  const plain = Buffer.from(JSON.stringify({...config,ssl:false,connectionString:'not-accepted'}));
  const result = await readApplicationBootstrap(file,{unprotect:async bytes => {assert.deepEqual(bytes,Buffer.from([3,7,9]));return plain;}});
  assert.deepEqual(result,config);
  assert.equal(plain.every(n=>n===0),true);
  for (const invalid of [{host:'remote.example'},{user:'pult_admin'},{database:'postgres'},{port:0},{password:'short'}]) {
    await assert.rejects(readApplicationBootstrap(file,{unprotect:async()=>Buffer.from(JSON.stringify({...config,...invalid}))}),e=>e.code==='POSTGRES_BOOTSTRAP_INVALID'&&!e.message.includes(config.password));
  }
});

test('connection failure is closed, redacted, and never falls back to files', async t => {
  const file = await fixture(t);
  let ended=0;
  class BrokenPool extends EventEmitter {
    async query(){throw Error(config.password);}
    async end(){ended++;}
  }
  await assert.rejects(createApplicationPool({bootstrapFile:file,unprotect:async()=>Buffer.from(JSON.stringify(config)),Pool:BrokenPool}),e=>e.code==='POSTGRES_UNAVAILABLE'&&!e.message.includes(config.password));
  assert.equal(ended,1);
});

test('actual SQL role privileges are checked, not merely the configured role name', async t => {
  const file = await fixture(t);
  let ended=0;
  class AdminPool extends EventEmitter {
    async query(){return {rows:[{role:'pult_app',rolsuper:true,rolcreatedb:false,rolcreaterole:false}]};}
    async end(){ended++;}
  }
  await assert.rejects(createApplicationPool({bootstrapFile:file,unprotect:async()=>Buffer.from(JSON.stringify(config)),Pool:AdminPool}),e=>e.code==='POSTGRES_UNAVAILABLE');
  assert.equal(ended,1);
});

test('UI pool has independent bounded capacity and a longer acquisition timeout', async t => {
  const file = await fixture(t), configurations = [];
  class CapturingPool extends EventEmitter {
    constructor(options) { super(); configurations.push(options); }
    async query(){return {rows:[{role:'pult_app',rolsuper:false,rolcreatedb:false,rolcreaterole:false}]};}
    async end(){}
  }
  const unprotect = async () => Buffer.from(JSON.stringify(config));
  const runtime = await createApplicationPool({bootstrapFile:file,unprotect,Pool:CapturingPool,profile:'runtime'});
  const ui = await createApplicationPool({bootstrapFile:file,unprotect,Pool:CapturingPool,profile:'ui'});
  const analytics = await createApplicationPool({bootstrapFile:file,unprotect,Pool:CapturingPool,profile:'analytics'});
  const outbound = await createApplicationPool({bootstrapFile:file,unprotect,Pool:CapturingPool,profile:'outbound'});
  await runtime.end(); await ui.end(); await analytics.end(); await outbound.end();
  assert.deepEqual(configurations.map(value => ({name:value.application_name,max:value.max,timeout:value.connectionTimeoutMillis})), [
    {name:'pult',max:10,timeout:15000},{name:'pult_ui',max:3,timeout:15000},{name:'pult_analytics',max:2,timeout:15000},{name:'pult_ozon_http',max:2,timeout:15000}
  ]);
  assert.equal(configurations[3].statement_timeout,125000);
  assert.equal(configurations.reduce((total, value) => total + value.max, 0), 17, 'analytics reserves capacity without increasing total pool size');
  await assert.rejects(createApplicationPool({bootstrapFile:file,unprotect,Pool:CapturingPool,profile:'unknown'}),error=>error.code==='POSTGRES_BOOTSTRAP_INVALID');
});
