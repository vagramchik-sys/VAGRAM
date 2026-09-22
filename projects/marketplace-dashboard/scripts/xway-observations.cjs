'use strict';
// Explicit local maintenance only; no HTTP write endpoint and no XWAY requests.
const fs=require('node:fs/promises'),path=require('node:path'),{Pool}=require('pg');
const {protect}=require('../storage/windows-dpapi.cjs');
const {SCHEMA_SQL,normalize,importObservations}=require('../storage/postgres-xway.cjs');
async function main(){
 const [action,filename]=process.argv.slice(2);
 if(!['schema','import','validate'].includes(action)||action==='schema'&&filename||action!=='schema'&&!filename||process.argv.length>(action==='schema'?3:4))throw Error('USAGE');
 let input;
 if(filename){const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw Error('INVALID_XWAY_IMPORT');input=JSON.parse(await fs.readFile(filename,'utf8'));normalize(input);}
 if(action==='validate'){console.log(JSON.stringify({valid:true,...Object.fromEntries(['accounts','settings','campaigns'].map(key=>[key,input[key].length]))}));return;}
 const bootstrap=path.resolve(__dirname,'../.private/postgres-setup/migrator.dpapi'),stat=await fs.lstat(bootstrap);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('BOOTSTRAP_INVALID');
 const config=JSON.parse(await protect((await fs.readFile(bootstrap)).toString('base64'),true));
 if(config.host!=='127.0.0.1'||config.port!==5441||config.database!=='pult'||config.user!=='pult_migrator'||typeof config.password!=='string'||config.password.length<24)throw Error('BOOTSTRAP_INVALID');
 const pool=new Pool({...config,max:1,application_name:'pult_xway_maintenance',statement_timeout:60000});config.password='';
 try{
  const identity=(await pool.query('SELECT current_user AS role,current_database() AS db,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
  if(identity.role!=='pult_migrator'||identity.db!=='pult'||identity.rolsuper||identity.rolcreatedb||identity.rolcreaterole)throw Error('MIGRATOR_IDENTITY_INVALID');
  if(action==='schema'){
   await pool.query('BEGIN');
   try{await pool.query(SCHEMA_SQL);await pool.query('REVOKE ALL ON ALL TABLES IN SCHEMA pult_xway FROM pult_app; GRANT USAGE ON SCHEMA pult_xway TO pult_app; GRANT SELECT ON ALL TABLES IN SCHEMA pult_xway TO pult_app;');await pool.query('COMMIT');}catch(error){await pool.query('ROLLBACK');throw error;}
   console.log(JSON.stringify({schema:'pult_xway',runtimeAccess:'SELECT'}));
  }else console.log(JSON.stringify({imported:await importObservations(pool,input)}));
 }finally{await pool.end();}
}
main().catch(error=>{console.error(JSON.stringify({error:/^[A-Z_]+$/u.test(error.code||error.message||'')?error.code||error.message:'XWAY_MAINTENANCE_FAILED'}));process.exitCode=1;});
