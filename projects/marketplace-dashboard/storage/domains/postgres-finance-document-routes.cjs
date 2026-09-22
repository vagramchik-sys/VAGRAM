'use strict';

const crypto = require('node:crypto');
const { createFinanceDocumentStore, FinanceDocumentError, MAX_UPLOAD } = require('../postgres-finance-documents.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ALLOWED_MEDIA = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
]);

class FinanceDocumentRouteError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'FinanceDocumentRouteError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new FinanceDocumentRouteError(code, message, status); };
const reply = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};

function oneHeader(req, name, max) {
  const value = req.headers[name];
  if (Array.isArray(value) || typeof value !== 'string' || !value || value.length > max) fail('INVALID_HEADER', 'Проверьте заголовки загрузки.');
  return value;
}

async function readBounded(req) {
  const announced = req.headers['content-length'];
  if (announced !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(String(announced)) || BigInt(announced) > BigInt(MAX_UPLOAD))) {
    fail('FILE_TOO_LARGE', 'Файл больше 20 МБ.', 413);
  }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD) fail('FILE_TOO_LARGE', 'Файл больше 20 МБ.', 413);
    chunks.push(Buffer.from(chunk));
  }
  if (!size) fail('EMPTY_FILE', 'Файл пуст.');
  return Buffer.concat(chunks, size);
}

function mapError(error) {
  if (error instanceof FinanceDocumentRouteError) return [error.status, error.message];
  if (error?.code === 'OUTCOME_UNKNOWN') return [503, 'Результат загрузки требует проверки. Повторите тот же запрос с теми же commandId и timestamp.'];
  if (['COMMAND_ID_REUSED', 'REVISION_CONFLICT', 'IDENTITY_CONFLICT', 'SOURCE_MAPPING_CONFLICT'].includes(error?.code)) return [409, 'Команда загрузки конфликтует с ранее сохранённым результатом.'];
  if (error instanceof FinanceDocumentError) {
    if (error.code === 'FILE_TOO_LARGE') return [413, error.message];
    if (['MEDIA_MISMATCH', 'MAGIC_MISMATCH'].includes(error.code)) return [415, error.message];
    if (['CORRUPT_DOCUMENT', 'BATCH_INCOMPLETE'].includes(error.code)) return [503, 'SQL-хранилище документов требует проверки.'];
    if (error.code === 'EXTRACTION_FAILED') return [503, 'Локальный обработчик документа недоступен.'];
    return [400, error.message];
  }
  return [503, 'SQL-хранилище документов временно недоступно.'];
}

function createPostgresFinanceDocumentRoutes({ documents, stateStore, batch, extractFile, tempRoot, authorize } = {}) {
  if (typeof authorize !== 'function') throw new TypeError('authorize is required');
  if (!documents) documents = createFinanceDocumentStore({ stateStore, batch, extractFile, tempRoot });
  if (typeof documents?.upload !== 'function' || typeof documents?.drafts !== 'function') throw new TypeError('Finance document adapter is required');
  const inFlight = new Map();

  async function handle(req, res, url) {
    if (url.pathname !== '/api/finance/contracts') return false;
    try {
      if (await authorize(req, url) !== true) fail('FORBIDDEN', 'Доступ запрещён.', 403);
      if (req.method === 'GET') { reply(res, 200, { drafts: await documents.drafts() }); return true; }
      if (req.method !== 'POST') { reply(res, 405, { error: 'Метод не поддерживается.' }); return true; }
      const contentType = oneHeader(req, 'content-type', 160).split(';', 1)[0].trim().toLowerCase();
      if (!ALLOWED_MEDIA.has(contentType)) fail('UNSUPPORTED_MEDIA', 'Тип файла не поддерживается.', 415);
      const fileName = oneHeader(req, 'x-file-name', 540);
      const commandId = oneHeader(req, 'x-pult-command-id', 80);
      const capturedAt = oneHeader(req, 'x-pult-command-timestamp', 80);
      if (!UUID.test(commandId)) fail('INVALID_COMMAND', 'commandId должен быть UUID.');
      if (Number.isNaN(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) fail('INVALID_COMMAND', 'timestamp должен быть каноническим UTC.');
      const exactBytes = await readBounded(req);
      const fingerprint = crypto.createHash('sha256').update(fileName).update('\0').update(contentType).update('\0').update(capturedAt).update('\0').update(exactBytes).digest('hex');
      const key = commandId.toLowerCase(), current = inFlight.get(key);
      if (current && current.fingerprint !== fingerprint) fail('COMMAND_ID_REUSED', 'commandId уже используется другой загрузкой.', 409);
      let operation = current?.operation;
      if (!operation) {
        operation = documents.upload({ exactBytes, fileName, contentType, commandId, capturedAt });
        inFlight.set(key, { fingerprint, operation });
        operation.finally(() => { if (inFlight.get(key)?.operation === operation) inFlight.delete(key); }).catch(() => {});
      }
      reply(res, 200, await operation);
    } catch (error) {
      const [status, message] = mapError(error); reply(res, status, { error: message });
    }
    return true;
  }
  return Object.freeze({ handle });
}

module.exports = { createPostgresFinanceDocumentRoutes, FinanceDocumentRouteError, ALLOWED_MEDIA };
