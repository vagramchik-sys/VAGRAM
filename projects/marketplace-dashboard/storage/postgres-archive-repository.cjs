'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { gzipSync, gunzipSync } = require('node:zlib');
const { allowed, FACT_FILES } = require('../market-history-archive.cjs');
const { acquireMutationFence } = require('./postgres-write-fence.cjs');

// Existing archived snapshots exceed 64 MiB; keep a bounded raw budget.
const MAX_SOURCE_BYTES = 320 * 1024 * 1024;

class ArchiveRepositoryError extends Error {
  constructor(code, message) { super(message); this.name = 'ArchiveRepositoryError'; this.code = code; }
}

const databaseError = () => new ArchiveRepositoryError('DATABASE_ERROR', 'Архив истории временно недоступен. Повторите запрос позже.');
const outcomeUnknown = () => new ArchiveRepositoryError('OUTCOME_UNKNOWN', 'Результат фиксации архива неизвестен. Не запускайте автоматический повтор; для ручной сверки используйте те же sourceFile и содержимое.');
const corruptArchive = () => new ArchiveRepositoryError('ARCHIVE_CORRUPT', 'Сохранённая версия архива не прошла проверку целостности.');
const factImportError = () => new ArchiveRepositoryError('FACT_IMPORT_ERROR', 'Факты из сохранённой версии пока не импортированы; версия остаётся в статусе pending.');

async function connectDatabase(pool) { try { return await pool.connect(); } catch { throw databaseError(); } }
async function queryDatabase(target, sql, values, { commitOutcome = false } = {}) {
  try { return await target.query(sql, values); } catch { throw commitOutcome ? outcomeUnknown() : databaseError(); }
}
function releaseDatabase(client, destroy = false) { try { client.release(destroy); } catch {} }
const ident = value => {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new TypeError('schema must be a PostgreSQL identifier');
  return `"${value}"`;
};
function requiredTime(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw Error('Некорректное время ' + label);
  return value;
}
function requiredSourceFile(value) {
  if (!allowed(value)) throw Error('Неподдерживаемое имя файла источника');
  return value;
}
function requiredHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw Error('Некорректный хеш содержимого');
  return value;
}
function requiredRaw(value) {
  if (!Buffer.isBuffer(value)) throw Error('Содержимое архива должно быть Buffer');
  if (value.length > MAX_SOURCE_BYTES) throw Error('Снимок превышает допустимый размер');
  return Buffer.from(value);
}
function requiredMtime(value) {
  if (!Number.isFinite(value) || value < 0) throw Error('Некорректное время изменения источника');
  return value;
}
const sha256 = value => crypto.createHash('sha256').update(value).digest();
const safeCount = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw Error('Некорректный счётчик архива');
  return number;
};
const safeSize = value => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : String(value);
};

function unpackAndVerify(row) {
  const payload = row.archive_payload;
  if (!Buffer.isBuffer(payload) || !Buffer.isBuffer(row.archive_gzip_hash) || !sha256(payload).equals(row.archive_gzip_hash)) throw corruptArchive();
  let raw;
  try { raw = gunzipSync(payload, { maxOutputLength: MAX_SOURCE_BYTES }); } catch { throw corruptArchive(); }
  if (String(raw.length) !== String(row.source_bytes) || sha256(raw).toString('hex') !== row.content_hash) throw corruptArchive();
  return raw;
}

function parseFactData(raw) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/u, ''); }
  catch { throw factImportError(); }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('root');
    return value;
  } catch { throw factImportError(); }
}

function prepareAdd({ sourceFile, sourceMtime, raw, capturedAt }, history, now) {
  sourceFile = requiredSourceFile(sourceFile);
  sourceMtime = requiredMtime(sourceMtime);
  raw = requiredRaw(raw);
  capturedAt = requiredTime(capturedAt || new Date(now()).toISOString(), 'capturedAt');
  const contentHash = sha256(raw).toString('hex');
  const archivePayload = gzipSync(raw, { level: 1, mtime: 0 });
  const gzipHash = sha256(archivePayload);
  return { sourceFile, sourceMtime, raw, capturedAt, contentHash, archivePayload, gzipHash,
    stamp: raw.length + ':' + sourceMtime, factsStatus: history && FACT_FILES.test(sourceFile) ? 'pending' : 'not_applicable' };
}

function createPostgresArchiveRepository({ pool, history = null, schema = 'pult_history', now = Date.now } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') throw new TypeError('pool is required');
  if (history !== null && (!history || typeof history.ingestInTransaction !== 'function')) throw new TypeError('history.ingestInTransaction is required');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const prefix = ident(schema), table = name => `${prefix}."${name}"`;
  const factsStatusFor = sourceFile => history && FACT_FILES.test(requiredSourceFile(sourceFile)) ? 'pending' : 'not_applicable';

  async function addPreparedInTransaction(value, client) {
    const inserted = await queryDatabase(client, `INSERT INTO ${table('archive_versions')}(source_file,content_hash,captured_at,captured_at_text,source_mtime,source_bytes,archive_bytes,object_path,facts_status,archive_payload,archive_gzip_hash) VALUES($1,$2,$3::text::timestamptz,$3::text,$4,$5,$6,NULL,$7,$8,$9) ON CONFLICT(source_file,content_hash) DO NOTHING RETURNING source_file`, [value.sourceFile, value.contentHash, value.capturedAt, value.sourceMtime, value.raw.length, value.archivePayload.length, value.factsStatus, value.archivePayload, value.gzipHash]);
    let actualGzipHash = value.gzipHash, actualFactsStatus = value.factsStatus;
    if (!inserted.rowCount) {
      const existing = await queryDatabase(client, `SELECT content_hash,source_bytes,facts_status,archive_payload,archive_gzip_hash FROM ${table('archive_versions')} WHERE source_file=$1 AND content_hash=$2 FOR UPDATE`, [value.sourceFile, value.contentHash]);
      if (!existing.rowCount || !unpackAndVerify(existing.rows[0]).equals(value.raw)) throw corruptArchive();
      actualGzipHash = Buffer.from(existing.rows[0].archive_gzip_hash);
      actualFactsStatus = String(existing.rows[0].facts_status);
    }
    const latestResult = await queryDatabase(client, `INSERT INTO ${table('archive_latest')} AS current(source_file,stamp,content_hash) VALUES($1,$2,$3) ON CONFLICT(source_file) DO UPDATE SET stamp=EXCLUDED.stamp,content_hash=EXCLUDED.content_hash WHERE $4::double precision>=substring(current.stamp from position(':' in current.stamp)+1)::double precision RETURNING source_file`, [value.sourceFile, value.stamp, value.contentHash, value.sourceMtime]);
    return { changed: !!inserted.rowCount, latestUpdated: !!latestResult.rowCount, contentHash: value.contentHash,
      gzipHash: actualGzipHash.toString('hex'), factsStatus: actualFactsStatus };
  }

  async function addInTransaction(input = {}, client) {
    if (!client || typeof client.query !== 'function') throw new TypeError('transaction client is required');
    return addPreparedInTransaction(prepareAdd(input, history, now), client);
  }

  async function add(input = {}) {
    const prepared = prepareAdd(input, history, now);
    const client = await connectDatabase(pool);
    let transactionOpen = false, duringCommit = false, destroy = false;
    try {
      await queryDatabase(client, 'BEGIN'); transactionOpen = true;
      await acquireMutationFence(client);
      const result = await addPreparedInTransaction(prepared, client);
      duringCommit = true;
      await queryDatabase(client, 'COMMIT', undefined, { commitOutcome: true }); transactionOpen = false;
      return result;
    } catch (error) {
      destroy = duringCommit;
      if (transactionOpen) { try { await client.query('ROLLBACK'); } catch { destroy = true; } }
      throw error;
    } finally { releaseDatabase(client, destroy); }
  }

  async function versionEvidence(sourceFile, contentHash) {
    sourceFile = requiredSourceFile(sourceFile); contentHash = requiredHash(contentHash);
    const result = await queryDatabase(pool, `SELECT source_file,content_hash,captured_at_text,source_mtime,source_bytes,archive_bytes,facts_status,archive_payload,archive_gzip_hash FROM ${table('archive_versions')} WHERE source_file=$1 AND content_hash=$2`, [sourceFile, contentHash]);
    if (result.rowCount !== 1) throw corruptArchive();
    const row = result.rows[0], raw = unpackAndVerify(row);
    return { sourceFile: row.source_file, contentHash: row.content_hash, capturedAt: row.captured_at_text,
      sourceMtime: Number(row.source_mtime), sourceBytes: safeSize(row.source_bytes), archiveBytes: safeSize(row.archive_bytes),
      factsStatus: row.facts_status, raw: Buffer.from(raw), archivePayload: Buffer.from(row.archive_payload), gzipHash: Buffer.from(row.archive_gzip_hash).toString('hex') };
  }

  async function latest(sourceFile) {
    sourceFile = requiredSourceFile(sourceFile);
    const result = await queryDatabase(pool, `SELECT l.stamp,v.source_file,v.content_hash,v.captured_at_text,v.source_mtime,v.source_bytes,v.archive_bytes,v.facts_status,v.archive_payload,v.archive_gzip_hash FROM ${table('archive_latest')} l JOIN ${table('archive_versions')} v ON v.source_file=l.source_file AND v.content_hash=l.content_hash WHERE l.source_file=$1`, [sourceFile]);
    if (!result.rowCount) return null;
    const row = result.rows[0], raw = unpackAndVerify(row);
    return { sourceFile: row.source_file, contentHash: row.content_hash, stamp: row.stamp, capturedAt: row.captured_at_text, sourceMtime: Number(row.source_mtime), sourceBytes: safeSize(row.source_bytes), archiveBytes: safeSize(row.archive_bytes), factsStatus: row.facts_status, raw };
  }

  async function processRowInTransaction(row, client) {
    const raw = unpackAndVerify(row);
    if (row.facts_status === 'imported') return { imported: false, alreadyImported: true, contentHash: row.content_hash };
    if (row.facts_status !== 'pending' || !history || !FACT_FILES.test(row.source_file)) throw factImportError();
    const data = parseFactData(raw);
    let historyResult;
    try { historyResult = await history.ingestInTransaction({ sourceFile: row.source_file, contentHash: row.content_hash, data, capturedAt: row.captured_at_text }, client); }
    catch { throw factImportError(); }
    const updated = await queryDatabase(client, `UPDATE ${table('archive_versions')} SET facts_status='imported' WHERE source_file=$1 AND content_hash=$2 AND facts_status='pending'`, [row.source_file, row.content_hash]);
    if (updated.rowCount !== 1) throw databaseError();
    const duplicate = historyResult?.duplicate === true;
    return { imported: true, alreadyImported: false, contentHash: row.content_hash,
      historyDuplicate: duplicate, ingestionId: duplicate || historyResult?.ingestionId == null ? null : safeCount(historyResult.ingestionId),
      snapshotCount: duplicate ? 0 : safeCount(historyResult?.snapshotCount ?? 0), factCount: duplicate ? 0 : safeCount(historyResult?.factCount ?? 0) };
  }

  async function processVersionInTransaction({ sourceFile, contentHash } = {}, client) {
    if (!client || typeof client.query !== 'function') throw new TypeError('transaction client is required');
    sourceFile = requiredSourceFile(sourceFile); contentHash = requiredHash(contentHash);
    const selected = await queryDatabase(client, `SELECT source_file,content_hash,captured_at_text,source_bytes,facts_status,archive_payload,archive_gzip_hash FROM ${table('archive_versions')} WHERE source_file=$1 AND content_hash=$2 FOR UPDATE`, [sourceFile, contentHash]);
    if (selected.rowCount !== 1) throw corruptArchive();
    return processRowInTransaction(selected.rows[0], client);
  }

  async function processPendingFacts({ limit = 100 } = {}) {
    if (!history) return { imported: 0, remaining: (await status()).pendingFacts };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw Error('Некорректный лимит pending facts');
    let imported = 0;
    while (imported < limit) {
      const client = await connectDatabase(pool);
      let transactionOpen = false, duringCommit = false, destroy = false;
      try {
        await queryDatabase(client, 'BEGIN'); transactionOpen = true;
        await acquireMutationFence(client);
        const selected = await queryDatabase(client, `SELECT source_file,content_hash,captured_at_text,source_bytes,facts_status,archive_payload,archive_gzip_hash FROM ${table('archive_versions')} WHERE facts_status='pending' ORDER BY captured_at,source_file,content_hash FOR UPDATE SKIP LOCKED LIMIT 1`);
        if (!selected.rowCount) {
          duringCommit = true; await queryDatabase(client, 'COMMIT', undefined, { commitOutcome: true }); transactionOpen = false;
          break;
        }
        await processRowInTransaction(selected.rows[0], client);
        duringCommit = true; await queryDatabase(client, 'COMMIT', undefined, { commitOutcome: true }); transactionOpen = false;
        imported++;
      } catch (error) {
        destroy = duringCommit;
        if (transactionOpen) { try { await client.query('ROLLBACK'); } catch { destroy = true; } }
        throw error;
      } finally { releaseDatabase(client, destroy); }
    }
    const remainingResult = await queryDatabase(pool, `SELECT count(*) AS count FROM ${table('archive_versions')} WHERE facts_status='pending'`);
    return { imported, remaining: safeCount(remainingResult.rows[0].count) };
  }

  async function status() {
    const result = await queryDatabase(pool, `SELECT count(*) AS versions,count(DISTINCT source_file) AS sources,coalesce(sum(archive_bytes),0) AS version_bytes,min(captured_at_text) AS first_captured_at,max(captured_at_text) AS last_captured_at,count(*) FILTER(WHERE facts_status='pending') AS pending_facts FROM ${table('archive_versions')}`);
    const unique = await queryDatabase(pool, `SELECT coalesce(sum(archive_bytes),0) AS archive_bytes FROM (SELECT max(archive_bytes) AS archive_bytes FROM ${table('archive_versions')} GROUP BY content_hash) d`);
    const state = await queryDatabase(pool, `SELECT key,value FROM ${table('archive_state')} WHERE key=ANY($1::text[])`, [['lastScanAt', 'lastError']]);
    const values = Object.fromEntries(state.rows.map(row => [row.key, row.value]));
    const row = result.rows[0];
    return { versions: safeCount(row.versions), sources: safeCount(row.sources), versionBytes: safeSize(row.version_bytes), archiveBytes: safeSize(unique.rows[0].archive_bytes), firstCapturedAt: row.first_captured_at || null, lastCapturedAt: row.last_captured_at || null, retentionDays: null, running: false, lastScanAt: values.lastScanAt || null, lastError: values.lastError || null, pendingFacts: safeCount(row.pending_facts) };
  }

  return { add, addInTransaction, factsStatusFor, versionEvidence, latest, processPendingFacts, processVersionInTransaction, status };
}

module.exports = { createPostgresArchiveRepository, ArchiveRepositoryError, MAX_SOURCE_BYTES, _test: { unpackAndVerify, parseFactData } };
