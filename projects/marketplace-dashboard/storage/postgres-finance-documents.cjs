'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { extractDraft } = require('../finance-module.cjs');
const { sourceKey } = require('./postgres-document-import.cjs');
const { encodeJson } = require('./postgres-json-repository.cjs');

const MAX_UPLOAD = 20 * 1024 * 1024, MAX_STORAGE = 200 * 1024 * 1024;
const FORMATS = Object.freeze({ '.pdf': ['pdf','application/pdf'], '.docx': ['docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'], '.png': ['png','image/png'], '.jpg': ['jpg','image/jpeg'], '.jpeg': ['jpg','image/jpeg'] });
class FinanceDocumentError extends Error { constructor(code, message) { super(message); this.name = 'FinanceDocumentError'; this.code = code; } }
const fail = (code, message) => { throw new FinanceDocumentError(code, message); };
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
function uuidFromBytes(bytes) { const data = Buffer.from(bytes.subarray(0,16)); data[6] = (data[6] & 15) | 0x50; data[8] = (data[8] & 63) | 0x80; const h=data.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; }
const childId = (commandId, role) => uuidFromBytes(crypto.createHash('sha256').update(`pult-finance-upload-v1\0${commandId.toLowerCase()}\0${role}`).digest());
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function intentHash(values) { const hash=crypto.createHash('sha256'); for(const value of values){const bytes=Buffer.from(String(value),'utf8'),length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(bytes.length));hash.update(length).update(bytes);} return hash.digest('hex'); }
function detect(bytes) { const m=bytes.subarray(0,16); return m.subarray(0,5).toString()==='%PDF-'?'pdf':m.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':m[0]===255&&m[1]===216&&m[2]===255?'jpg':m[0]===80&&m[1]===75?'docx':null; }
function publicDraft(meta) { return Object.freeze({ id:meta.id,fileName:meta.fileName,format:meta.format,size:meta.size,createdAt:meta.createdAt,status:'draft',needsReview:true,fields:meta.fields,warnings:meta.warnings,suggestedSourceNote:meta.suggestedSourceNote }); }
function parseMeta(record, expectedId = null) {
  if (!record || record.deleted || record.mediaType !== 'application/json' || !Buffer.isBuffer(record.content) || !Buffer.isBuffer(record.sha256) || digest(record.content) !== record.sha256.toString('hex')) fail('CORRUPT_DOCUMENT','Stored contract metadata is invalid');
  let meta; try { meta=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.content)); } catch { fail('CORRUPT_DOCUMENT','Stored contract metadata is invalid'); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !isUuid(meta.id) || expectedId && meta.id !== expectedId || typeof meta.fileName !== 'string' || meta.fileName.length < 1 || meta.fileName.length > 180 ||
      !['pdf','docx','png','jpg'].includes(meta.format) || !Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > MAX_UPLOAD || !/^[a-f0-9]{64}$/.test(meta.hash) ||
      typeof meta.createdAt !== 'string' || Number.isNaN(Date.parse(meta.createdAt)) || new Date(meta.createdAt).toISOString() !== meta.createdAt || meta.needsReview !== true || !meta.fields || typeof meta.fields !== 'object' || !Array.isArray(meta.warnings) || typeof meta.suggestedSourceNote !== 'string')
    fail('CORRUPT_DOCUMENT','Stored contract metadata is invalid');
  return meta;
}

function createFinanceDocumentStore({ stateStore, batch, extractFile, tempRoot = os.tmpdir() } = {}) {
  if (!stateStore || typeof stateStore.read !== 'function' || !batch || typeof batch.writeDocuments !== 'function' || typeof batch.readReceipt !== 'function' || typeof batch.listDocuments !== 'function' || typeof extractFile !== 'function')
    throw new TypeError('SQL state, batch, and extraction adapters are required');
  if (typeof tempRoot !== 'string' || !path.isAbsolute(tempRoot)) throw new TypeError('An absolute disposable temp root is required');

  async function existing(id, expectedHash = null) {
    const metadataPath=`loan-contracts/${id}.json`, record=await stateStore.read(sourceKey(metadataPath),{includeDeleted:true});
    if (!record) return null;
    const meta=parseMeta(record,id); if (expectedHash && meta.hash !== expectedHash) fail('IDENTITY_CONFLICT','Contract identity conflicts with stored content');
    const binaryPath=`loan-contracts/${id}.${meta.format}`, binary=await stateStore.read(sourceKey(binaryPath),{includeDeleted:true});
    if (!binary || binary.deleted || binary.mediaType !== FORMATS['.'+meta.format][1] || !Buffer.isBuffer(binary.content) || binary.content.length !== meta.size || digest(binary.content) !== meta.hash || !Buffer.isBuffer(binary.sha256) || binary.sha256.toString('hex') !== meta.hash)
      fail('CORRUPT_DOCUMENT','Stored contract binary is invalid');
    return { meta, metadata:record, binary, binaryPath, result:publicDraft(meta) };
  }
  async function findByHash(hash) {
    const matches=[];
    for(const record of await batch.listDocuments({prefix:'loan-contracts/',suffix:'.json'})) {
      if(record.deleted)continue;const meta=parseMeta(record);if(meta.hash===hash)matches.push(meta.id);
    }
    if(matches.length>1)fail('CORRUPT_DOCUMENT','Contract hash maps to more than one stored draft');
    return matches.length ? existing(matches[0],hash) : null;
  }
  function receiptId(receipt) {
    const metadata=receipt.members.filter(x=>/^loan-contracts\/[0-9a-f-]+\.json$/u.test(x.sourcePath));
    if(metadata.length!==1)fail('BATCH_INCOMPLETE','Durable finance receipt has invalid document paths');
    const id=metadata[0].sourcePath.slice('loan-contracts/'.length,-'.json'.length);
    if(!isUuid(id)||metadata[0].logicalKey!==sourceKey(metadata[0].sourcePath)||metadata[0].mediaType!=='application/json')fail('BATCH_INCOMPLETE','Durable finance receipt has invalid document identity');
    return id;
  }

  async function upload({ exactBytes, fileName, contentType, commandId, capturedAt } = {}) {
    if (!Buffer.isBuffer(exactBytes)) fail('INVALID_ARGUMENT','exactBytes must be a Buffer');
    const bytes=Buffer.from(exactBytes);
    if (!bytes.length) fail('EMPTY_FILE','File is empty'); if(bytes.length>MAX_UPLOAD) fail('FILE_TOO_LARGE','File exceeds 20 MiB');
    if (!isUuid(commandId)) fail('INVALID_ARGUMENT','commandId must be a UUID');
    if (typeof capturedAt !== 'string' || Number.isNaN(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) fail('INVALID_ARGUMENT','capturedAt must be canonical UTC');
    try { fileName=decodeURIComponent(String(fileName||'')); } catch { fail('INVALID_FILE','File name is invalid'); }
    const ext=path.extname(fileName).toLowerCase(), spec=FORMATS[ext];
    if (!spec || path.basename(fileName)!==fileName || fileName.length>180) fail('INVALID_FILE','Supported files are PDF, DOCX, JPG, and PNG');
    const declared=String(contentType||'').split(';')[0].toLowerCase(); if(declared!==spec[1]) fail('MEDIA_MISMATCH','Declared media type does not match extension');
    if(detect(bytes)!==spec[0]) fail('MAGIC_MISMATCH','File content does not match extension');
    const hash=digest(bytes), derivedId=uuidFromBytes(Buffer.from(hash,'hex')), commands=[childId(commandId,'binary'),childId(commandId,'metadata')];
    const intent=intentHash([hash,fileName,declared,capturedAt]);
    const receipt=await batch.readReceipt({batchId:commandId,commandIds:commands,intentSha256:intent});
    if(receipt){const committed=await existing(receiptId(receipt),hash);if(!committed||!receipt.members.some(x=>x.sourcePath===committed.binaryPath&&x.logicalKey===sourceKey(committed.binaryPath)&&x.mediaType===committed.binary.mediaType))fail('BATCH_INCOMPLETE','Durable finance receipt has no matching documents');return Object.freeze({...committed.result,duplicate:receipt.duplicate,replayed:true});}
    const found=await findByHash(hash);
    if(found){
      await batch.writeDocuments({batchId:commandId,intentSha256:intent,duplicate:true,writes:[
        {commandId:commands[0],logicalKey:sourceKey(found.binaryPath),sourceMapping:{sourcePath:found.binaryPath,logicalKey:sourceKey(found.binaryPath),domain:'documents',mediaType:found.binary.mediaType},mediaType:found.binary.mediaType,content:found.binary.content,expectedRevision:found.binary.revision},
        {commandId:commands[1],logicalKey:sourceKey(`loan-contracts/${found.meta.id}.json`),sourceMapping:{sourcePath:`loan-contracts/${found.meta.id}.json`,logicalKey:sourceKey(`loan-contracts/${found.meta.id}.json`),domain:'documents',mediaType:'application/json'},mediaType:'application/json',content:found.metadata.content,expectedRevision:found.metadata.revision}
      ],capacity:{prefix:'loan-contracts/',maxBytes:MAX_STORAGE}});
      return Object.freeze({...found.result,duplicate:true,replayed:false});
    }
    const dir=await fs.mkdtemp(path.join(tempRoot,'pult-finance-extract-')), temporary=path.join(dir,`input.${spec[0]}`);
    try {
      await fs.writeFile(temporary,bytes,{mode:0o600,flag:'wx'});
      let extracted; try { extracted=await extractFile(spec[0],temporary); } catch(error) { if(error instanceof FinanceDocumentError)throw error;fail('EXTRACTION_FAILED','Local document extraction failed'); }
      if (!extracted || Object.getPrototypeOf(extracted)!==Object.prototype || !Array.isArray(extracted.pages) || !Array.isArray(extracted.warnings) || extracted.pages.length>10 || extracted.warnings.length>50 || extracted.warnings.some(x=>typeof x!=='string'||x.length>500)) fail('EXTRACTION_INVALID','Extractor returned an invalid review result');
      let extractedBytes=0;
      for(const page of extracted.pages){
        if(!page||Object.getPrototypeOf(page)!==Object.prototype||Object.getOwnPropertySymbols(page).length||Object.keys(page).some(x=>!['page','text'].includes(x)))fail('EXTRACTION_INVALID','Extractor returned an invalid review result');
        for(const key of Object.keys(page)){const descriptor=Object.getOwnPropertyDescriptor(page,key);if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))fail('EXTRACTION_INVALID','Extractor returned an invalid review result');}
        if(typeof page.text!=='string'||!(page.page===null||Number.isSafeInteger(page.page)&&page.page>=1&&page.page<=10))fail('EXTRACTION_INVALID','Extractor returned an invalid review result');
        extractedBytes+=Buffer.byteLength(page.text,'utf8');if(extractedBytes>3*1024*1024)fail('EXTRACTION_INVALID','Extracted review text exceeds the supported limit');
      }
      const id=derivedId,draft=extractDraft(extracted.pages,fileName,hash,extracted.warnings), meta={id,fileName,format:spec[0],size:bytes.length,hash,createdAt:capturedAt,...draft};
      const metadata=encodeJson(meta,2*1024*1024), binaryPath=`loan-contracts/${id}.${spec[0]}`, metadataPath=`loan-contracts/${id}.json`;
      const mapping=(sourcePath,mediaType)=>({sourcePath,logicalKey:sourceKey(sourcePath),domain:'documents',mediaType});
      try {
        const saved=await batch.writeDocuments({batchId:commandId,intentSha256:intent,duplicate:false,writes:[
          {commandId:commands[0],logicalKey:sourceKey(binaryPath),sourceMapping:mapping(binaryPath,spec[1]),mediaType:spec[1],content:bytes,expectedRevision:'0'},
          {commandId:commands[1],logicalKey:sourceKey(metadataPath),sourceMapping:mapping(metadataPath,'application/json'),mediaType:'application/json',content:metadata,expectedRevision:'0'}
        ],capacity:{prefix:'loan-contracts/',maxBytes:MAX_STORAGE}});
        return Object.freeze({...publicDraft(meta),duplicate:false,replayed:saved.replayed});
      } catch(error) {
        if (!['REVISION_CONFLICT','SOURCE_MAPPING_CONFLICT','OUTCOME_UNKNOWN'].includes(error?.code)) throw error;
        const durable=await batch.readReceipt({batchId:commandId,commandIds:commands,intentSha256:intent});
        if(durable){const committed=await existing(receiptId(durable),hash);if(!committed)fail('BATCH_INCOMPLETE','Durable finance receipt has no documents');return Object.freeze({...committed.result,duplicate:durable.duplicate,replayed:true});}
        const committed=await existing(id,hash); if (!committed || error.code==='OUTCOME_UNKNOWN') throw error;
        await batch.writeDocuments({batchId:commandId,intentSha256:intent,duplicate:true,writes:[
          {commandId:commands[0],logicalKey:sourceKey(committed.binaryPath),sourceMapping:mapping(committed.binaryPath,committed.binary.mediaType),mediaType:committed.binary.mediaType,content:committed.binary.content,expectedRevision:committed.binary.revision},
          {commandId:commands[1],logicalKey:sourceKey(metadataPath),sourceMapping:mapping(metadataPath,'application/json'),mediaType:'application/json',content:committed.metadata.content,expectedRevision:committed.metadata.revision}
        ],capacity:{prefix:'loan-contracts/',maxBytes:MAX_STORAGE}});
        return Object.freeze({...committed.result,duplicate:true,replayed:false});
      }
    } finally { await fs.rm(dir,{recursive:true,force:true}); }
  }

  async function drafts() {
    const records=await batch.listDocuments({prefix:'loan-contracts/',suffix:'.json'}), result=[];
    for(const record of records) if(!record.deleted) result.push(publicDraft(parseMeta(record)));
    return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
  }
  return Object.freeze({ upload, drafts });
}

module.exports={ createFinanceDocumentStore, FinanceDocumentError, MAX_UPLOAD, MAX_STORAGE };
