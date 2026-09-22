'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { gzipSync, gunzipSync } = require('node:zlib');
const { allowed, FACT_FILES } = require('../market-history-archive.cjs');
const { encodeJson } = require('./postgres-json-repository.cjs');
const { MAX_SOURCE_BYTES } = require('./postgres-archive-repository.cjs');

const MEDIA_TYPE = 'application/vnd.pult.archive-command+json';
const HASH = /^[a-f0-9]{64}$/u;
// Base64 raw bytes and gzip evidence must fit the durable state budget.
const MAX_ENVELOPE_BYTES = 480 * 1024 * 1024;
// pg text bytea doubles the encoded length; new commands stay below its string limit.
const MAX_STORED_ENVELOPE_BYTES = 240 * 1024 * 1024;

class JournaledArchiveError extends Error {
  constructor(code, message) { super(message); this.name = 'JournaledArchiveError'; this.code = code; }
}
const fail = (code, message) => { throw new JournaledArchiveError(code, message); };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceKey = sourceFile => `archive/${sha256(Buffer.from(sourceFile, 'utf8'))}`;

function dataProperty(input, name) {
  const property = Object.getOwnPropertyDescriptor(input, name);
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('INVALID_COMMAND', `Archive command ${name} must be a data value`);
  return property.value;
}
function canonical(value) {
  try { return encodeJson(value, MAX_ENVELOPE_BYTES); }
  catch { fail('INVALID_COMMAND', 'Archive command exceeds the strict JSON contract'); }
}
function canonicalTime(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    fail('INVALID_COMMAND', `Archive command ${label} must be canonical UTC`);
  return value;
}
function common(input, kind) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype)
    fail('INVALID_COMMAND', 'Archive command must be a plain object');
  if (dataProperty(input, 'schemaVersion') !== 1 || dataProperty(input, 'kind') !== kind)
    fail('UNSUPPORTED_COMMAND', 'Unsupported archive command kind or schema version');
  const sourceFile = dataProperty(input, 'sourceFile');
  if (!allowed(sourceFile)) fail('INVALID_COMMAND', 'Archive source is not allowed');
  return { sourceFile, commandId: dataProperty(input, 'commandId'), expectedRevision: dataProperty(input, 'expectedRevision'),
    commandCapturedAt: canonicalTime(dataProperty(input, 'capturedAt'), 'capturedAt') };
}
function strictFactJson(raw, sourceFile) {
  if (!FACT_FILES.test(sourceFile)) return;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/u, ''); }
  catch { fail('INVALID_FACT_JSON', 'Archive fact bytes are not valid UTF-8'); }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('root');
    canonical(data);
  } catch (error) {
    if (error instanceof JournaledArchiveError) throw error;
    fail('INVALID_FACT_JSON', 'Archive fact bytes are not valid JSON');
  }
}
function exactEvidence({ sourceFile, sourceMtime, capturedAt, raw, archivePayload, contentHash, gzipHash, factsStatus }) {
  if (!Buffer.isBuffer(raw) || !Buffer.isBuffer(archivePayload) || raw.length > MAX_SOURCE_BYTES || !Number.isFinite(sourceMtime) || sourceMtime < 0 ||
      !HASH.test(contentHash) || !HASH.test(gzipHash) || sha256(raw) !== contentHash || sha256(archivePayload) !== gzipHash)
    fail('EVIDENCE_MISMATCH', 'Archive evidence does not match its metadata');
  let unpacked;
  try { unpacked = gunzipSync(archivePayload, { maxOutputLength: MAX_SOURCE_BYTES }); }
  catch { fail('EVIDENCE_MISMATCH', 'Archive gzip evidence is corrupt'); }
  if (!unpacked.equals(raw)) fail('EVIDENCE_MISMATCH', 'Archive gzip and raw evidence differ');
  strictFactJson(raw, sourceFile);
  return { sourceFile, sourceMtime, archivedCapturedAt: capturedAt, contentHash, gzipHash, sourceBytes: raw.length,
    archiveBytes: archivePayload.length, factsStatus, gzipBase64: archivePayload.toString('base64') };
}

function decodeCanonicalEnvelope(recorded, command, contentHash, kind = 'archive.process-exact-pending-version', sourceMtime) {
  const bytes = recorded?.after?.content, expectedSha = recorded?.after?.sha256;
  if (recorded.commandId !== command.commandId.toLowerCase() || recorded.logicalKey !== sourceKey(command.sourceFile) ||
      recorded.before?.revision !== command.expectedRevision || recorded.after?.mediaType !== MEDIA_TYPE || recorded.after?.deleted ||
      !Buffer.isBuffer(bytes) || !Buffer.isBuffer(expectedSha) || !crypto.createHash('sha256').update(bytes).digest().equals(expectedSha))
    fail('RECORDED_COMMAND_INVALID', 'Recorded archive command identity is invalid');
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('RECORDED_COMMAND_INVALID', 'Recorded archive command envelope is invalid'); }
  if (!canonical(envelope).equals(bytes) || ![1, 2].includes(envelope.schemaVersion))
    fail('RECORDED_COMMAND_INVALID', 'Recorded archive command is not canonical');
  if (envelope.kind !== kind || envelope.sourceFile !== command.sourceFile || envelope.contentHash !== contentHash || envelope.commandCapturedAt !== command.commandCapturedAt)
    fail(kind === 'archive.version-add' ? 'COMMAND_ID_REUSED' : 'RECORDED_COMMAND_INVALID', 'Recorded archive command does not match the retry');
  if (kind === 'archive.version-add' && envelope.sourceMtime !== sourceMtime)
    fail('COMMAND_ID_REUSED', 'Recorded archive source timestamp differs');
  let raw, archivePayload;
  try {
    const gzipText = kind === 'archive.version-add' ? envelope.proposedGzipBase64 : envelope.gzipBase64;
    archivePayload = Buffer.from(gzipText, 'base64');
    if (archivePayload.toString('base64') !== gzipText) throw Error('base64');
    raw = envelope.schemaVersion === 2 ? gunzipSync(archivePayload, { maxOutputLength: MAX_SOURCE_BYTES }) : Buffer.from(envelope.rawBase64, 'base64');
    if (envelope.schemaVersion === 1 && raw.toString('base64') !== envelope.rawBase64 || envelope.schemaVersion === 2 && Object.hasOwn(envelope, 'rawBase64')) throw Error('raw');
  } catch { fail('RECORDED_COMMAND_INVALID', 'Recorded archive evidence is invalid'); }
  const evidence = exactEvidence({ sourceFile: envelope.sourceFile, sourceMtime: envelope.sourceMtime,
    capturedAt: envelope.archivedCapturedAt, raw, archivePayload, contentHash: envelope.contentHash,
    gzipHash: kind === 'archive.version-add' ? envelope.proposedGzipHash : envelope.gzipHash, factsStatus: envelope.factsStatus });
  if (evidence.sourceBytes !== envelope.sourceBytes || evidence.archiveBytes !== envelope.archiveBytes)
    fail('RECORDED_COMMAND_INVALID', 'Recorded archive evidence sizes are invalid');
  return bytes;
}

function createJournaledArchive({ stateStore, archive } = {}) {
  if (!stateStore || typeof stateStore.writeWithEffect !== 'function' || typeof stateStore.readCommand !== 'function') throw new TypeError('stateStore writeWithEffect/readCommand are required');
  if (!archive || typeof archive.addInTransaction !== 'function' || typeof archive.processVersionInTransaction !== 'function' ||
      typeof archive.versionEvidence !== 'function' || typeof archive.factsStatusFor !== 'function') throw new TypeError('transactional archive repository is required');

  async function addVersion(input) {
    const command = common(input, 'archive.version-add');
    const sourceMtime = dataProperty(input, 'sourceMtime');
    const suppliedRaw = dataProperty(input, 'raw');
    if (!Buffer.isBuffer(suppliedRaw) || suppliedRaw.length > MAX_SOURCE_BYTES || !Number.isFinite(sourceMtime) || sourceMtime < 0)
      fail('INVALID_COMMAND', 'Archive raw input or sourceMtime is invalid');
    const raw = Buffer.from(suppliedRaw);
    strictFactJson(raw, command.sourceFile);
    const contentHash = sha256(raw);
    const recorded = await stateStore.readCommand(sourceKey(command.sourceFile), command.commandId, { operation: 'write' });
    if (recorded) {
      const envelope = decodeCanonicalEnvelope(recorded, command, contentHash, 'archive.version-add', sourceMtime);
      return stateStore.writeWithEffect(sourceKey(command.sourceFile), envelope, {
        expectedRevision: command.expectedRevision, commandId: command.commandId, mediaType: MEDIA_TYPE
      }, () => { throw Error('recorded archive effect must not rerun'); });
    }
    const archivePayload = gzipSync(raw, { level: 1, mtime: 0 });
    const gzipHash = sha256(archivePayload);
    const factsStatus = archive.factsStatusFor(command.sourceFile);
    const evidence = exactEvidence({ sourceFile: command.sourceFile, sourceMtime, capturedAt: command.commandCapturedAt,
      raw, archivePayload, contentHash, gzipHash, factsStatus });
    const { gzipHash: proposedGzipHash, gzipBase64: proposedGzipBase64, ...rawEvidence } = evidence;
    const envelope = canonical({ schemaVersion: 2, kind: 'archive.version-add', commandCapturedAt: command.commandCapturedAt,
      ...rawEvidence, proposedGzipHash, proposedGzipBase64 });
    if (envelope.length > MAX_STORED_ENVELOPE_BYTES) fail('INVALID_COMMAND', 'Compressed archive command exceeds the supported byte limit');
    return stateStore.writeWithEffect(sourceKey(command.sourceFile), envelope, {
      expectedRevision: command.expectedRevision, commandId: command.commandId, mediaType: MEDIA_TYPE
    }, client => archive.addInTransaction({ sourceFile: command.sourceFile, sourceMtime, capturedAt: command.commandCapturedAt, raw }, client));
  }

  async function processVersion(input) {
    const command = common(input, 'archive.process-exact-pending-version');
    const contentHash = dataProperty(input, 'contentHash');
    if (typeof contentHash !== 'string' || !HASH.test(contentHash)) fail('INVALID_COMMAND', 'Archive contentHash is invalid');
    const key = sourceKey(command.sourceFile);
    const recorded = await stateStore.readCommand(key, command.commandId, { operation: 'write' });
    if (recorded) {
      const envelope = decodeCanonicalEnvelope(recorded, command, contentHash);
      return stateStore.writeWithEffect(key, envelope, {
        expectedRevision: command.expectedRevision, commandId: command.commandId, mediaType: MEDIA_TYPE
      }, () => { throw Error('recorded archive effect must not rerun'); });
    }
    const found = await archive.versionEvidence(command.sourceFile, contentHash);
    const raw = Buffer.from(found.raw), archivePayload = Buffer.from(found.archivePayload);
    const evidence = exactEvidence({ ...found, raw, archivePayload });
    const envelope = canonical({ schemaVersion: 2, kind: 'archive.process-exact-pending-version', commandCapturedAt: command.commandCapturedAt, ...evidence });
    if (envelope.length > MAX_STORED_ENVELOPE_BYTES) fail('INVALID_COMMAND', 'Compressed archive command exceeds the supported byte limit');
    return stateStore.writeWithEffect(key, envelope, {
      expectedRevision: command.expectedRevision, commandId: command.commandId, mediaType: MEDIA_TYPE
    }, client => archive.processVersionInTransaction({ sourceFile: command.sourceFile, contentHash }, client));
  }

  return Object.freeze({ addVersion, processVersion });
}

module.exports = { createJournaledArchive, JournaledArchiveError, MEDIA_TYPE };
