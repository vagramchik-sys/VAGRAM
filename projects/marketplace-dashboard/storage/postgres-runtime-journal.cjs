'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { gunzipSync } = require('node:zlib');
const { withWriteFence } = require('./postgres-write-fence.cjs');
const { encodeJson } = require('./postgres-json-repository.cjs');
const { MAX_SOURCE_BYTES } = require('./postgres-archive-repository.cjs');
const { summarizePostgresHistory } = require('./postgres-history-parity.cjs');
const { summarizePostgresStock } = require('./postgres-stock-history-parity.cjs');
const { validateEnvelope: validateStockEnvelope, MEDIA_TYPE: STOCK_MEDIA } = require('./postgres-stock-history-writer.cjs');

const INCOMPLETE_MARKER = 'RUNTIME_JOURNAL_INCOMPLETE.json';
const COMPLETE_MARKER = 'RUNTIME_JOURNAL_COMPLETE.json';
const MANIFEST_FILE = 'runtime-journal-manifest.json';
const BLOBS_DIRECTORY = 'blobs';
const DECIMAL = /^(0|[1-9]\d*)$/u, HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DOMAIN_MEDIA = Object.freeze({ history: 'application/vnd.pult.history-command+json', archive: 'application/vnd.pult.archive-command+json' });
const KINDS = new Set(['history.ingest', 'stock-history.ingest', 'archive.version-add', 'archive.process-exact-pending-version']);

class PostgresRuntimeJournalError extends Error {
  constructor(code, message) { super(message); this.name = 'PostgresRuntimeJournalError'; this.code = code; }
}
const fail = (code, message) => { throw new PostgresRuntimeJournalError(code, message); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function seq(value) { const result = typeof value === 'bigint' ? String(value) : value; if (typeof result !== 'string' || !DECIMAL.test(result)) fail('JOURNAL_INVALID', 'Invalid sequence'); return result; }
function portable(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.includes(':') || value.split('/').some(x => !x || x === '.' || x === '..')) fail('JOURNAL_INVALID', 'Unsafe path');
  for (const part of value.split('/')) { const folded = part.normalize('NFC').toLowerCase(), device = folded.split('.')[0]; if (part.endsWith('.') || part.endsWith(' ') || ['con','prn','aux','nul'].includes(device) || /^(?:com|lpt)[1-9]$/u.test(device)) fail('JOURNAL_INVALID', 'Unsafe Windows path'); }
  return value;
}
async function rootDirectory(value, empty = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('INVALID_ARGUMENT', 'Directory must be absolute');
  const stat = await fs.lstat(value).catch(() => null); if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('INVALID_ARGUMENT', 'Directory must be real');
  const root = await fs.realpath(value); if (empty && (await fs.readdir(root)).length) fail('DESTINATION_NOT_EMPTY', 'Destination must be empty'); return root;
}
async function safeFile(root, relative) {
  portable(relative); const file = path.join(root, ...relative.split('/')), stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail('JOURNAL_INVALID', 'Missing or unsafe journal file');
  const resolved = await fs.realpath(file), rel = path.relative(root, resolved); if (rel.startsWith('..'+path.sep) || path.isAbsolute(rel)) fail('JOURNAL_INVALID', 'Journal file escapes root'); return file;
}
async function fileDigest(file) { const hash = crypto.createHash('sha256'); let bytes = 0n; await new Promise((resolve,reject) => { const s=fsSync.createReadStream(file); s.on('data',c=>{bytes+=BigInt(c.length);hash.update(c)});s.on('error',reject);s.on('end',resolve); }); return { bytes:String(bytes), sha256:hash.digest('hex') }; }
async function writeJson(file, value) { const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'); const h=await fs.open(file,'wx');try{await h.writeFile(bytes);await h.sync()}finally{await h.close()}return bytes; }
async function writeBlob(root, bytes, blobs) { const hash=digest(bytes), metadata={sha256:hash,bytes:String(bytes.length),path:`${BLOBS_DIRECTORY}/${hash}.bin`}; if(!blobs.has(hash)){const h=await fs.open(path.join(root,BLOBS_DIRECTORY,hash+'.bin'),'wx');try{await h.writeFile(bytes);await h.sync()}finally{await h.close()}blobs.set(hash,metadata)} return metadata; }
function stateBlob(content, sha, deleted, revision) { if(deleted===null){if(revision!=='0'||content!=null||sha!=null)fail('JOURNAL_INVALID','Invalid absent state');return null} if(deleted===true){if(content!=null||sha!=null)fail('JOURNAL_INVALID','Invalid deleted state');return null} if(deleted!==false||!Buffer.isBuffer(content)||!Buffer.isBuffer(sha)||sha.length!==32||digest(content)!==sha.toString('hex'))fail('JOURNAL_INVALID','Invalid state bytes'); return content; }
function parseEnvelope(bytes, domain, mediaType) {
  let value;
  try { value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); if(!encodeJson(value,480*1024*1024).equals(bytes)) throw Error('canonical'); }
  catch { fail('JOURNAL_INVALID','Domain command envelope is invalid'); }
  const compactArchive=value?.schemaVersion===2&&domain==='archive'&&String(value.kind).startsWith('archive.');
  if(value?.schemaVersion!==1&&!compactArchive||!KINDS.has(value.kind)||domain==='history'&&!['history.ingest','stock-history.ingest'].includes(value.kind)||domain==='archive'&&!value.kind.startsWith('archive.')) fail('UNSUPPORTED_DOMAIN','Unsupported domain command');
  const expectedMedia=value.kind==='stock-history.ingest'?STOCK_MEDIA:DOMAIN_MEDIA[domain];
  if(mediaType!==expectedMedia)fail('UNSUPPORTED_DOMAIN','Unsupported domain media type');
  if(value.kind==='stock-history.ingest'){try{validateStockEnvelope(value)}catch{fail('JOURNAL_INVALID','Stock history envelope is invalid')}return value}
  const decode=name=>{if(typeof value[name]!=='string')fail('JOURNAL_INVALID','Domain evidence is incomplete');const result=Buffer.from(value[name],'base64');if(result.toString('base64')!==value[name])fail('JOURNAL_INVALID','Domain evidence base64 is invalid');return result};
  let raw;
  if(value.kind.startsWith('archive.')){
    const gzipName=value.kind==='archive.version-add'?'proposedGzipBase64':'gzipBase64',hashName=value.kind==='archive.version-add'?'proposedGzipHash':'gzipHash',gzip=decode(gzipName);
    let unpacked;try{unpacked=gunzipSync(gzip,{maxOutputLength:MAX_SOURCE_BYTES})}catch{fail('JOURNAL_INVALID','Archive gzip evidence is corrupt')}
    if(digest(gzip)!==value[hashName])fail('JOURNAL_INVALID','Archive gzip evidence hash differs');
    if(compactArchive){if(Object.hasOwn(value,'rawBase64')||value.sourceBytes!==unpacked.length||value.archiveBytes!==gzip.length)fail('JOURNAL_INVALID','Compact archive evidence sizes differ');raw=unpacked}
    else{raw=decode('rawBase64');if(!unpacked.equals(raw))fail('JOURNAL_INVALID','Archive gzip evidence differs from raw')}
  }else raw=decode('rawBase64');
  if(raw.length>MAX_SOURCE_BYTES||digest(raw)!==value.contentHash)fail('JOURNAL_INVALID','Domain raw evidence size or hash differs');
  return value;
}
function validateCommands(commands, baseline, upper) {
  let last=BigInt(baseline);const ids=new Set(),chains=new Map();
  for(const c of commands){const id=typeof c?.commandId==='string'?c.commandId.toLowerCase():'';if(!c||!DECIMAL.test(c.sequence)||BigInt(c.sequence)<=last||BigInt(c.sequence)>BigInt(upper)||!UUID.test(c.commandId)||ids.has(id)||typeof c.logicalKey!=='string'||!c.logicalKey)fail('JOURNAL_INVALID','Command order or identity invalid');last=BigInt(c.sequence);ids.add(id);
    if(!DECIMAL.test(c.beforeRevision)||!DECIMAL.test(c.afterRevision)||BigInt(c.afterRevision)!==BigInt(c.beforeRevision)+1n)fail('JOURNAL_INVALID','Revision step invalid');
    const prior=chains.get(c.logicalKey);if(prior&&(prior.afterRevision!==c.beforeRevision||!same(prior.after,c.before)))fail('JOURNAL_INVALID','Revision chain broken');chains.set(c.logicalKey,c);
  }
}

async function exportRuntimeJournal({ pool, checkpointSequence, destinationDir }={}) {
  if(!pool?.connect||!pool?.query)fail('INVALID_ARGUMENT','pool is required');const baseline=seq(checkpointSequence);const root=await rootDirectory(destinationDir,true),incomplete=path.join(root,INCOMPLETE_MARKER);await writeJson(incomplete,{schemaVersion:1,status:'incomplete'});await fs.mkdir(path.join(root,BLOBS_DIRECTORY));
  if(baseline!=='0')fail('BASELINE_UNSUPPORTED','Runtime journal requires checkpoint sequence zero');
  try{let upper=baseline,commands=[],baselineDocuments=[],expectedHistoryBusinessSummary=null,expectedStockHistorySummary=null;const blobs=new Map();await withWriteFence({pool,timeoutMs:30000},async client=>{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{
    upper=seq((await client.query('SELECT COALESCE(max(sequence),0)::text AS sequence FROM pult.commands')).rows[0].sequence);if(BigInt(baseline)>BigInt(upper))fail('INVALID_ARGUMENT','Checkpoint exceeds upper sequence');
    const base=await client.query('SELECT source_path,logical_key,domain,media_type,baseline_present,source_bytes::text,encode(source_sha256,\'hex\') sha256 FROM pult.source_files ORDER BY source_path COLLATE "C"');
    baselineDocuments=base.rows.map(r=>({sourcePath:portable(r.source_path),logicalKey:r.logical_key,domain:r.domain,mediaType:r.media_type,baselinePresent:r.baseline_present,bytes:String(r.source_bytes),sha256:r.sha256}));
    await client.query(`DECLARE pult_runtime_journal NO SCROLL CURSOR FOR SELECT c.sequence::text,c.command_id::text,c.operation,c.logical_key,c.before_revision::text,c.after_revision::text,c.before_content,c.before_sha256,c.before_deleted,c.after_content,c.after_sha256,c.after_deleted,c.media_type,c.before_media_type,c.result_json,s.source_path FROM pult.commands c LEFT JOIN pult.source_files s ON s.logical_key=c.logical_key WHERE c.sequence>$1::bigint AND c.sequence<=$2::bigint ORDER BY c.sequence`,[baseline,upper]);
    try{for(;;){const rows=await client.query('FETCH FORWARD 16 FROM pult_runtime_journal');if(!rows.rows.length)break;for(const r of rows.rows){const beforeRevision=String(r.before_revision),afterRevision=String(r.after_revision),beforeBytes=stateBlob(r.before_content,r.before_sha256,r.before_deleted,beforeRevision),afterBytes=stateBlob(r.after_content,r.after_sha256,r.after_deleted,afterRevision);const before=beforeBytes?await writeBlob(root,beforeBytes,blobs):null,after=afterBytes?await writeBlob(root,afterBytes,blobs):null;
      let domain,type,sourcePath=null,envelope=null,result=null;if(r.source_path!=null){domain='document';type='document';sourcePath=portable(r.source_path);if(!['write','delete'].includes(r.operation))fail('UNSUPPORTED_DOMAIN','Unsupported document operation');}
      else {domain=String(r.logical_key).split('/')[0];if(!DOMAIN_MEDIA[domain]||r.operation!=='write'||!afterBytes||r.result_json==null)fail('UNSUPPORTED_DOMAIN','Unsupported SQL domain command');envelope=parseEnvelope(afterBytes,domain,r.media_type);type=envelope.kind==='stock-history.ingest'?'stock-history':domain;try{result=JSON.parse(encodeJson(r.result_json,64*1024).toString())}catch{fail('JOURNAL_INVALID','Invalid durable command result')}}
      commands.push({sequence:String(r.sequence),commandId:String(r.command_id).toLowerCase(),type,operation:r.operation,logicalKey:r.logical_key,sourcePath,beforeRevision,afterRevision,beforeMediaType:r.before_media_type,mediaType:r.media_type,before:{deleted:r.before_deleted,blob:before},after:{deleted:r.after_deleted,blob:after},envelope,result});
    }}}finally{await client.query('CLOSE pult_runtime_journal').catch(()=>{})}validateCommands(commands,baseline,upper);expectedHistoryBusinessSummary=await summarizePostgresHistory(client);expectedStockHistorySummary=await summarizePostgresStock(client);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}});
    const manifest={schemaVersion:1,status:'complete',scope:'documents-history-archive',baselineSequence:baseline,upperSequence:upper,baselineDocuments,commands,blobs:[...blobs.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256)),expectedHistoryBusinessSummary,expectedStockHistorySummary,rollbackReady:false};const bytes=await writeJson(path.join(root,MANIFEST_FILE),manifest);await fs.unlink(incomplete);await writeJson(path.join(root,COMPLETE_MARKER),{schemaVersion:1,manifest:MANIFEST_FILE,manifestSha256:digest(bytes)});await verifyRuntimeJournal(root);return manifest;
  }catch(e){await fs.unlink(path.join(root,COMPLETE_MARKER)).catch(()=>{});await fs.writeFile(incomplete,JSON.stringify({schemaVersion:1,status:'incomplete',code:e?.code||'EXPORT_FAILED'})+'\n').catch(()=>{});if(e instanceof PostgresRuntimeJournalError)throw e;fail('EXPORT_FAILED','Runtime journal export failed')}
}

async function verifyRuntimeJournal(directory){const root=await rootDirectory(directory);if(await fs.access(path.join(root,INCOMPLETE_MARKER)).then(()=>true,()=>false))fail('JOURNAL_INCOMPLETE','Runtime journal incomplete');let manifest,bytes,marker;try{bytes=await fs.readFile(await safeFile(root,MANIFEST_FILE));marker=JSON.parse(await fs.readFile(await safeFile(root,COMPLETE_MARKER),'utf8'));manifest=JSON.parse(bytes)}catch(e){if(e instanceof PostgresRuntimeJournalError)throw e;fail('JOURNAL_INVALID','Runtime journal metadata invalid')}
  if(marker?.manifest!==MANIFEST_FILE||marker.manifestSha256!==digest(bytes)||manifest?.schemaVersion!==1||manifest.status!=='complete'||manifest.scope!=='documents-history-archive'||manifest.rollbackReady!==false||manifest.baselineSequence!=='0'||!DECIMAL.test(manifest.upperSequence)||!Array.isArray(manifest.commands)||!Array.isArray(manifest.blobs)||!Array.isArray(manifest.baselineDocuments)||!manifest.expectedHistoryBusinessSummary||typeof manifest.expectedHistoryBusinessSummary!=='object'||!manifest.expectedStockHistorySummary||typeof manifest.expectedStockHistorySummary!=='object')fail('JOURNAL_INVALID','Runtime manifest invalid');
  for(const summary of [manifest.expectedHistoryBusinessSummary,manifest.expectedStockHistorySummary])for(const value of Object.values(summary))if(!value||value.version!==2||!DECIMAL.test(value.count)||!HASH.test(value.sha256))fail('JOURNAL_INVALID','History business summary version is invalid');
  const paths=new Set(),keys=new Set();for(const b of manifest.baselineDocuments){const p=portable(b?.sourcePath),folded=p.normalize('NFC').toLowerCase();if(paths.has(folded)||keys.has(b.logicalKey)||typeof b.logicalKey!=='string'||!b.logicalKey||typeof b.domain!=='string'||typeof b.mediaType!=='string'||typeof b.baselinePresent!=='boolean'||!DECIMAL.test(b.bytes)||!HASH.test(b.sha256))fail('JOURNAL_INVALID','Baseline catalog invalid');paths.add(folded);keys.add(b.logicalKey)}
  const declared=new Map();for(const b of manifest.blobs){if(!b||!HASH.test(b.sha256)||!DECIMAL.test(b.bytes)||b.path!==`${BLOBS_DIRECTORY}/${b.sha256}.bin`||declared.has(b.sha256))fail('JOURNAL_INVALID','Blob metadata invalid');const actual=await fileDigest(await safeFile(root,b.path));if(!same(actual,{bytes:b.bytes,sha256:b.sha256}))fail('JOURNAL_INVALID','Blob corrupt');declared.set(b.sha256,b)}
  for(const c of manifest.commands){for(const s of [c.before,c.after]){if(!s||![true,false,null].includes(s.deleted)||s.blob!==null&&!same(s.blob,declared.get(s.blob?.sha256))||s.deleted===false&&s.blob===null||s.deleted!==false&&s.blob!==null)fail('JOURNAL_INVALID','Command blob invalid')}if(c.type==='document'){portable(c.sourcePath);if(c.envelope!==null||c.result!==null)fail('JOURNAL_INVALID','Document command shape invalid')}else{const domain=c.type==='stock-history'?'history':c.type;if(!DOMAIN_MEDIA[domain]||c.sourcePath!==null||c.operation!=='write'||c.after.deleted!==false||!c.after.blob||!same(parseEnvelope(await fs.readFile(await safeFile(root,c.after.blob.path)),domain,c.mediaType),c.envelope)||c.result==null)fail('JOURNAL_INVALID','Domain command shape invalid')}}validateCommands(manifest.commands,manifest.baselineSequence,manifest.upperSequence);
  const expected=new Set([COMPLETE_MARKER,MANIFEST_FILE,...manifest.blobs.map(b=>b.path)]),actual=[];async function walk(dir,p=''){for(const e of await fs.readdir(dir,{withFileTypes:true})){const r=p?`${p}/${e.name}`:e.name,f=path.join(dir,e.name);if(e.isSymbolicLink())fail('JOURNAL_INVALID','Link in journal');if(e.isDirectory())await walk(f,r);else if(e.isFile())actual.push(r);else fail('JOURNAL_INVALID','Unsupported journal entry')}}await walk(root);if(actual.length!==expected.size||actual.some(x=>!expected.has(x)))fail('JOURNAL_INVALID','Unexpected journal files');return manifest;}

module.exports={exportRuntimeJournal,verifyRuntimeJournal,PostgresRuntimeJournalError,INCOMPLETE_MARKER,COMPLETE_MARKER,MANIFEST_FILE,BLOBS_DIRECTORY};
