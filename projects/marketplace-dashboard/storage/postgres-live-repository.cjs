'use strict';

const crypto = require('node:crypto');
const {acquireMutationFence} = require('./postgres-write-fence.cjs');
const DOMAINS = Object.freeze(['market', 'insights', 'costs', 'prices', 'funnel', 'wb-orders', 'buyers', 'catalogs', 'ledger', 'intraday', 'category-intraday']);
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_SOURCE_METADATA_BYTES = 16 * 1024;
const ROW_COLUMNS = 'entity_type,entity_key,occurrence,business_day::text,source_order,value,row_sha256,revision';

class LiveRepositoryError extends Error {
  constructor(code) { super(code); this.name = 'LiveRepositoryError'; this.code = code; }
}
const fail = code => { throw new LiveRepositoryError(code); };
const safeError = error => error instanceof LiveRepositoryError ? error : new LiveRepositoryError('DATABASE_ERROR');
function textId(value, max, pattern) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/u.test(value) || pattern && !pattern.test(value)) fail('INVALID_ARGUMENT');
  return value;
}
function identity(input) {
  if (!input || typeof input !== 'object') fail('INVALID_ARGUMENT');
  const storeId = textId(input.storeId, 200), domain = input.domain;
  if (!DOMAINS.includes(domain)) fail('INVALID_ARGUMENT');
  return { storeId, domain };
}
const entityType = value => textId(value, 128, /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u);
function integer(value, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('INVALID_ARGUMENT');
  return value;
}
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail('INVALID_ARGUMENT');
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value || value < '0001-01-01') fail('INVALID_ARGUMENT');
  return value;
}
// Reject lossy JSON inputs (undefined, NaN, accessors, dates, sparse arrays) instead
// of silently dropping fields. Canonical serialization detaches and fingerprints
// intent synchronously, before the first asynchronous database operation.
function canonical(value, ancestors = new Set(), depth = 0, allowArrays = true) {
  if (depth > 80) fail('INVALID_ARGUMENT');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.includes('\u0000')) fail('INVALID_ARGUMENT');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') { if (!Number.isFinite(value) || Object.is(value, -0)) fail('INVALID_ARGUMENT'); return JSON.stringify(value); }
  if (!value || typeof value !== 'object' || ancestors.has(value)) fail('INVALID_ARGUMENT');
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (array ? !allowArrays : proto !== Object.prototype && proto !== null) fail('INVALID_ARGUMENT');
  ancestors.add(value);
  const keys = Object.keys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || keys.some(key => !Object.hasOwn(descriptors[key], 'value'))) fail('INVALID_ARGUMENT');
  let result;
  if (array) {
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) fail('INVALID_ARGUMENT');
    result = '[' + value.map(item => canonical(item, ancestors, depth + 1, allowArrays)).join(',') + ']';
  } else {
    result = '{' + keys.sort().map(key => JSON.stringify(key) + ':' + canonical(descriptors[key].value, ancestors, depth + 1, allowArrays)).join(',') + '}';
  }
  ancestors.delete(value);
  return result;
}
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT'); return value; }
function metadata(value, max) {
  const encoded = canonical(object(value), new Set(), 0, false);
  // PostgreSQL jsonb adds spaces. Reserve its exact worst-case separator overhead.
  const detached = JSON.parse(encoded), sqlBytes = Buffer.byteLength(JSON.stringify(detached, null, 0)) + (encoded.match(/[,:]/gu) || []).length;
  if (sqlBytes > max) fail('METADATA_TOO_LARGE');
  return detached;
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function rowEnvelope(id, row) {
  return { storeId: id.storeId, domain: id.domain, entityType: row.entityType, entityKey: row.entityKey, occurrence: row.occurrence, businessDay: row.businessDay, sourceOrder: row.sourceOrder, value: row.value };
}
function normalizeCommand(input, migration, maxMetadataBytes) {
  const id = identity(input), commandId = textId(input.commandId, 200), expectedRevision = integer(input.expectedRevision);
  if (migration && expectedRevision !== 0) fail('INVALID_MIGRATION');
  if (!Array.isArray(input.partitions) || input.partitions.length > 256) fail('INVALID_ARGUMENT');
  const types = new Set();
  const partitions = input.partitions.map(partition => {
    object(partition);
    const type = entityType(partition.entityType);
    if (types.has(type)) fail('DUPLICATE_PARTITION');
    types.add(type);
    const scopeInput = object(partition.scope);
    const scope = scopeInput.kind === 'all' ? { kind: 'all' } : scopeInput.kind === 'days' ? { kind: 'days', fromDay: day(scopeInput.fromDay), toDay: day(scopeInput.toDay) } : fail('INVALID_ARGUMENT');
    if (scope.kind === 'days' && (scope.fromDay > scope.toDay || migration)) fail('INVALID_ARGUMENT');
    if (!Array.isArray(partition.rows)) fail('INVALID_ARGUMENT');
    const used = new Map(), next = new Map(), orders = new Set();
    const rows = partition.rows.map((row, index) => {
      object(row);
      const key = textId(row.entityKey, 1024), ordinals = used.get(key) || new Set();
      let occurrence = row.occurrence;
      if (occurrence == null) { occurrence = next.get(key) || 0; while (ordinals.has(occurrence)) occurrence++; }
      integer(occurrence, 2147483647);
      if (ordinals.has(occurrence)) fail('DUPLICATE_ENTITY');
      ordinals.add(occurrence); used.set(key, ordinals); next.set(key, occurrence + 1);
      const businessDay = row.businessDay == null ? null : day(row.businessDay);
      if (scope.kind === 'days' && (!businessDay || businessDay < scope.fromDay || businessDay > scope.toDay)) fail('ROW_OUTSIDE_PARTITION');
      const sourceOrder = integer(row.sourceOrder ?? index);
      if (orders.has(sourceOrder)) fail('DUPLICATE_SOURCE_ORDER');
      orders.add(sourceOrder);
      const normalized = { entityType: type, entityKey: key, occurrence, businessDay, sourceOrder, value: JSON.parse(canonical(object(row.value))) };
      return { ...normalized, rowSha256: digest(rowEnvelope(id, normalized)) };
    });
    return { entityType: type, scope, rows };
  });
  return freeze({ ...id, commandId, expectedRevision, mode: migration ? 'migration' : 'publish', metadata: metadata(input.metadata ?? {}, maxMetadataBytes), sourceMetadata: metadata(input.sourceMetadata ?? {}, MAX_SOURCE_METADATA_BYTES), partitions });
}
function safeNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail('DATA_INTEGRITY');
  return number;
}
function verifyDigest(value, checksum) { if (digest(value) !== checksum) fail('DATA_INTEGRITY'); }
function headValue(id, row) {
  if (!row) return null;
  const value = { storeId: id.storeId, domain: id.domain, revision: safeNumber(row.revision), metadata: row.metadata, sourceMetadata: row.source_metadata, entityCounts: row.entity_counts };
  verifyDigest(value, row.head_sha256);
  return freeze({ ...value, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at });
}
function rowValue(id, row) {
  const value = { entityType: row.entity_type, entityKey: row.entity_key, occurrence: safeNumber(row.occurrence), businessDay: row.business_day, sourceOrder: safeNumber(row.source_order), value: row.value, revision: safeNumber(row.revision) };
  verifyDigest(rowEnvelope(id, value), row.row_sha256);
  return freeze(value);
}
function receiptValue(row) {
  if (!row) return null;
  verifyDigest(row.receipt, row.receipt_sha256);
  if (row.intent_sha256 && row.receipt.intentFingerprint !== row.intent_sha256) fail('DATA_INTEGRITY');
  return freeze(row.receipt);
}

function createPostgresLiveRepository({ pool, maxMetadataBytes = 64 * 1024, writeBatchBytes = 8 * 1024 * 1024 } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');
  if (!Number.isSafeInteger(maxMetadataBytes) || maxMetadataBytes < 1 || maxMetadataBytes > MAX_METADATA_BYTES) throw new TypeError('invalid metadata limit');
  if (!Number.isSafeInteger(writeBatchBytes) || writeBatchBytes < 1024 || writeBatchBytes > 16 * 1024 * 1024) throw new TypeError('invalid write batch limit');
  async function transaction(readOnly, work) {
    let client;
    try {
      client = await pool.connect();
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      if (!readOnly) await acquireMutationFence(client);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw safeError(error);
    } finally { if (client) { try { client.release(); } catch {} } }
  }
  async function current(client, id, lock = false) {
    const result = await client.query('SELECT revision,metadata,source_metadata,entity_counts,head_sha256,updated_at FROM pult_live.heads WHERE store_id=$1 AND domain=$2' + (lock ? ' FOR UPDATE' : ''), [id.storeId, id.domain]);
    return headValue(id, result.rows[0]);
  }
  async function command(client, id, commandId) {
    const result = await client.query('SELECT intent_sha256,receipt,receipt_sha256 FROM pult_live.commands WHERE store_id=$1 AND domain=$2 AND command_id=$3', [id.storeId, id.domain, commandId]);
    const row = result.rows[0];
    return row ? { intentSha256: row.intent_sha256, receipt: receiptValue(row) } : null;
  }
  function expected(head, revision) {
    if (revision !== undefined && (head?.revision ?? 0) !== integer(revision)) fail('REVISION_CONFLICT');
  }
  async function getHead(input) { const id = identity(input); return transaction(true, client => current(client, id)); }
  async function listHeads(input = {}) {
    const values = [];
    if (input.domain != null) {
      if (!DOMAINS.includes(input.domain)) fail('INVALID_ARGUMENT');
      values.push(input.domain);
    }
    return transaction(true, async client => {
      const result = await client.query('SELECT store_id,domain,revision,metadata,source_metadata,entity_counts,head_sha256,updated_at FROM pult_live.heads' + (values.length ? ' WHERE domain=$1' : '') + ' ORDER BY domain,store_id', values);
      return freeze(result.rows.map(row => headValue({ storeId: row.store_id, domain: row.domain }, row)));
    });
  }
  async function readCommand(input) {
    const id = identity(input), commandId = textId(input.commandId, 200);
    return transaction(true, async client => (await command(client, id, commandId))?.receipt ?? null);
  }
  async function listRows(input) {
    const id = identity(input), values = [id.storeId, id.domain], where = ['store_id=$1', 'domain=$2'];
    const limit = integer(input.limit ?? 1000, 10000), offset = integer(input.offset ?? 0);
    if (!limit) fail('INVALID_ARGUMENT');
    if (input.entityType != null) { values.push(entityType(input.entityType)); where.push('entity_type=$' + values.length); }
    if (input.fromDay != null) { values.push(day(input.fromDay)); where.push('business_day>=$' + values.length + '::date'); }
    if (input.toDay != null) { values.push(day(input.toDay)); where.push('business_day<=$' + values.length + '::date'); }
    if (input.fromDay && input.toDay && input.fromDay > input.toDay) fail('INVALID_ARGUMENT');
    const expectedRevision = input.expectedRevision == null ? undefined : integer(input.expectedRevision);
    // A cursor is the complete ordering tuple of the last returned row. Totals
    // retain their original meaning (all filtered rows, before the cursor).
    const includeTotal = input.includeTotal ?? true, countValues = [...values], countWhere = [...where];
    if (typeof includeTotal !== 'boolean') fail('INVALID_ARGUMENT');
    if (input.after != null) {
      const after = object(input.after);
      if (offset) fail('INVALID_ARGUMENT');
      const cursorType = entityType(after.entityType), cursor = [integer(after.sourceOrder), cursorType, textId(after.entityKey, 1024), integer(after.occurrence, 2147483647)];
      if (input.entityType != null && cursorType !== input.entityType) fail('INVALID_ARGUMENT');
      const columns = input.entityType == null ? ['source_order','entity_type','entity_key','occurrence'] : ['source_order','entity_key','occurrence'];
      if (input.entityType != null) cursor.splice(1,1);
      const placeholders = cursor.map(value => {values.push(value);return '$' + values.length;});
      where.push('(' + columns.join(',') + ')>(' + placeholders.join(',') + ')');
    }
    return transaction(true, async client => {
      const head = await current(client, id); expected(head, expectedRevision);
      const count = includeTotal ? await client.query('SELECT count(*) AS count FROM pult_live.facts WHERE ' + countWhere.join(' AND '), countValues) : null;
      const result = await client.query('SELECT ' + ROW_COLUMNS + ' FROM pult_live.facts WHERE ' + where.join(' AND ') + ' ORDER BY source_order,entity_type,entity_key,occurrence LIMIT $' + (values.length + 1) + (offset ? ' OFFSET $' + (values.length + 2) : ''), [...values, limit, ...(offset ? [offset] : [])]);
      return freeze({ head, rows: result.rows.map(row => rowValue(id, row)), total: count ? safeNumber(count.rows[0].count) : null, limit, offset });
    });
  }
  async function readCurrentCollections(input) {
    const id = identity(input);
    if (!Array.isArray(input.entityTypes) || input.entityTypes.length > 256) fail('INVALID_ARGUMENT');
    const types = input.entityTypes.map(entityType);
    if (new Set(types).size !== types.length) fail('INVALID_ARGUMENT');
    return transaction(true, async client => {
      const head = await current(client, id), collections = {};
      if (!head) return freeze({ head: null, collections });
      for (const type of types) {
        const expectedCount = head.entityCounts[type];
        // A projection may request a collection that this source schema does
        // not contain. The decoder decides presence from metadata.
        if (expectedCount === undefined) { collections[type] = []; continue; }
        const rows = [], values = [id.storeId, id.domain, type];
        let after;
        for (;;) {
          const pageValues = [...values], where = ['store_id=$1', 'domain=$2', 'entity_type=$3'];
          if (after) {
            const cursor = [after.sourceOrder, after.entityKey, after.occurrence];
            const placeholders = cursor.map(value => { pageValues.push(value); return '$' + pageValues.length; });
            where.push('(source_order,entity_key,occurrence)>(' + placeholders.join(',') + ')');
          }
          const result = await client.query('SELECT ' + ROW_COLUMNS + ' FROM pult_live.facts WHERE ' + where.join(' AND ') +
            ' ORDER BY source_order,entity_key,occurrence LIMIT $' + (pageValues.length + 1), [...pageValues, 10000]);
          const page = result.rows.map(row => rowValue(id, row));
          rows.push(...page);
          if (page.length < 10000) {
            break;
          }
          const last = page[page.length - 1];
          after = { sourceOrder: last.sourceOrder, entityKey: last.entityKey, occurrence: last.occurrence };
        }
        collections[type] = rows;
      }
      return freeze({ head, collections });
    });
  }
  async function listJournal(input) {
    const id = identity(input), values = [id.storeId, id.domain], where = ['store_id=$1', 'domain=$2'];
    const limit = integer(input.limit ?? 100, 10000);
    if (!limit) fail('INVALID_ARGUMENT');
    for (const [option, column, validate] of [['entityType', 'entity_type', entityType], ['entityKey', 'entity_key', value => textId(value, 1024)]]) {
      if (input[option] != null) { values.push(validate(input[option])); where.push(column + '=$' + values.length); }
    }
    if (input.afterRevision != null) { values.push(integer(input.afterRevision)); where.push('revision>$' + values.length); }
    if (input.afterEventId != null) { values.push(integer(input.afterEventId)); where.push('event_id>$' + values.length); }
    return transaction(true, async client => {
      const result = await client.query('SELECT event_id,action,command_id,recorded_at,' + ROW_COLUMNS + ' FROM pult_live.record_journal WHERE ' + where.join(' AND ') + ' ORDER BY event_id LIMIT $' + (values.length + 1), [...values, limit]);
      return freeze(result.rows.map(row => ({ ...rowValue(id, row), eventId: safeNumber(row.event_id), action: row.action, commandId: row.command_id, recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at })));
    });
  }
  async function readAtRevision(input) {
    const id = identity(input), revision = integer(input.revision), limit = integer(input.limit ?? 1000, 10000), offset = integer(input.offset ?? 0);
    if (!limit) fail('INVALID_ARGUMENT');
    const values = [id.storeId, id.domain, revision], where = ["action<>'delete'"];
    if (input.entityType != null) { values.push(entityType(input.entityType)); where.push('entity_type=$' + values.length); }
    if (input.fromDay != null) { values.push(day(input.fromDay)); where.push('business_day>=$' + values.length + '::date'); }
    if (input.toDay != null) { values.push(day(input.toDay)); where.push('business_day<=$' + values.length + '::date'); }
    if (input.fromDay && input.toDay && input.fromDay > input.toDay) fail('INVALID_ARGUMENT');
    return transaction(true, async client => {
      if (revision === 0) return freeze({ head: null, rows: [], total: 0, limit, offset });
      const result = await client.query('SELECT receipt,receipt_sha256 FROM pult_live.commands WHERE store_id=$1 AND domain=$2 AND revision=$3', [id.storeId, id.domain, revision]);
      const receipt = receiptValue(result.rows[0]);
      if (!receipt) fail('REVISION_NOT_FOUND');
      const cte = `WITH latest AS (SELECT DISTINCT ON(entity_type,entity_key,occurrence) * FROM pult_live.record_journal
        WHERE store_id=$1 AND domain=$2 AND revision<=$3 ORDER BY entity_type,entity_key,occurrence,revision DESC,event_id DESC)`;
      const count = await client.query(cte + ' SELECT count(*) AS count FROM latest WHERE ' + where.join(' AND '), values);
      const rows = await client.query(cte + ' SELECT ' + ROW_COLUMNS + ' FROM latest WHERE ' + where.join(' AND ') + ' ORDER BY source_order,entity_type,entity_key,occurrence LIMIT $' + (values.length + 1) + ' OFFSET $' + (values.length + 2), [...values, limit, offset]);
      return freeze({ head: receipt.afterHead, rows: rows.rows.map(row => rowValue(id, row)), total: safeNumber(count.rows[0].count), limit, offset });
    });
  }
  async function stagePartition(client, intent, partition) {
    const identityValues = [intent.storeId, intent.domain, intent.commandId, partition.entityType];
    let batch = [], bytes = 2;
    async function flush() {
      if (!batch.length) return;
      await client.query(`INSERT INTO pult_live.incoming_rows(store_id,domain,command_id,entity_type,entity_key,occurrence,business_day,source_order,value,row_sha256)
        SELECT $1,$2,$3,$4,i.entity_key,i.occurrence,i.business_day,i.source_order,i.value,i.row_sha256
        FROM jsonb_to_recordset($5::jsonb) AS i(entity_key text,occurrence integer,business_day date,source_order bigint,value jsonb,row_sha256 text)`, [...identityValues, '[' + batch.join(',') + ']']);
      batch = []; bytes = 2;
    }
    for (const row of partition.rows) {
      const encoded = JSON.stringify({ entity_key: row.entityKey, occurrence: row.occurrence, business_day: row.businessDay, source_order: row.sourceOrder, value: row.value, row_sha256: row.rowSha256 });
      const rowBytes = Buffer.byteLength(encoded);
      if (batch.length && (bytes + rowBytes + 1 > writeBatchBytes || batch.length >= 1000)) await flush();
      if (rowBytes + 2 > writeBatchBytes) {
        // A single large record is not an array of records. Send its value as a
        // standalone JSON object so the bounded array limit remains unconditional.
        await client.query(`INSERT INTO pult_live.incoming_rows(store_id,domain,command_id,entity_type,entity_key,occurrence,business_day,source_order,value,row_sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,$9::jsonb,$10)`, [...identityValues, row.entityKey, row.occurrence, row.businessDay, row.sourceOrder, JSON.stringify(row.value), row.rowSha256]);
      } else {
        bytes += rowBytes + (batch.length ? 1 : 0); batch.push(encoded);
      }
    }
    await flush();
  }
  async function write(input, migration, withStatus = false) {
    const intent = normalizeCommand(input, migration, maxMetadataBytes), fingerprint = digest(intent);
    return transaction(false, async client => {
      const replay = async () => {
        const previous = await command(client, intent, intent.commandId);
        if (previous && previous.intentSha256 !== fingerprint) fail('COMMAND_INTENT_CONFLICT');
        return previous?.receipt;
      };
      const first = await replay();
      if (first) return withStatus ? { receipt: first, replayed: true } : first;
      const initial = { storeId: intent.storeId, domain: intent.domain, revision: 0, metadata: {}, sourceMetadata: {}, entityCounts: {} };
      await client.query('INSERT INTO pult_live.heads(store_id,domain,revision,metadata,source_metadata,entity_counts,head_sha256) VALUES($1,$2,0,\'{}\',\'{}\',\'{}\',$3) ON CONFLICT DO NOTHING', [intent.storeId, intent.domain, digest(initial)]);
      const head = await current(client, intent, true);
      const second = await replay();
      if (second) return withStatus ? { receipt: second, replayed: true } : second;
      expected(head, intent.expectedRevision);
      const revision = integer(intent.expectedRevision + 1), counts = { inserted: 0, updated: 0, deleted: 0, unchanged: 0 };
      for (const partition of intent.partitions) {
        await stagePartition(client, intent, partition);
        const values = [intent.storeId, intent.domain, partition.entityType, revision, intent.commandId, partition.scope.kind === 'days' ? partition.scope.fromDay : null, partition.scope.kind === 'days' ? partition.scope.toDay : null];
        const scope = '($6::date IS NULL OR (f.business_day BETWEEN $6::date AND $7::date))';
        const incoming = 'SELECT entity_key,occurrence,business_day,source_order,value,row_sha256 FROM pult_live.incoming_rows WHERE store_id=$1 AND domain=$2 AND entity_type=$3 AND command_id=$5';
        // A caller must include business day in its natural identity when one
        // entity can occur on several days. Never move an outside-range record.
        if (partition.scope.kind === 'days') {
          const collision = await client.query(`WITH incoming AS (${incoming}) SELECT $4::bigint AS revision,$5::text AS command_id,EXISTS(SELECT 1 FROM pult_live.facts f JOIN incoming i USING(entity_key,occurrence) WHERE f.store_id=$1 AND f.domain=$2 AND f.entity_type=$3 AND NOT COALESCE(${scope},false)) AS conflict`, values);
          if (collision.rows[0].conflict) fail('ENTITY_OUTSIDE_PARTITION');
        }
        const result = await client.query(`WITH incoming AS MATERIALIZED (${incoming}),
          previous AS MATERIALIZED (SELECT entity_key,occurrence FROM pult_live.facts WHERE store_id=$1 AND domain=$2 AND entity_type=$3),
          removed AS (DELETE FROM pult_live.facts f WHERE f.store_id=$1 AND f.domain=$2 AND f.entity_type=$3 AND ${scope}
            AND NOT EXISTS(SELECT 1 FROM incoming i WHERE i.entity_key=f.entity_key AND i.occurrence=f.occurrence) RETURNING f.*),
          written AS (INSERT INTO pult_live.facts AS f(store_id,domain,entity_type,entity_key,occurrence,business_day,source_order,value,row_sha256,revision)
            SELECT $1,$2,$3,i.entity_key,i.occurrence,i.business_day,i.source_order,i.value,i.row_sha256,$4 FROM incoming i
            ON CONFLICT(store_id,domain,entity_type,entity_key,occurrence) DO UPDATE SET business_day=EXCLUDED.business_day,source_order=EXCLUDED.source_order,
              value=EXCLUDED.value,row_sha256=EXCLUDED.row_sha256,revision=EXCLUDED.revision,updated_at=clock_timestamp()
            WHERE f.row_sha256 IS DISTINCT FROM EXCLUDED.row_sha256 RETURNING f.*),
          events AS (INSERT INTO pult_live.record_journal(store_id,domain,command_id,revision,action,entity_type,entity_key,occurrence,business_day,source_order,value,row_sha256)
            SELECT $1,$2,$5,$4,'delete',entity_type,entity_key,occurrence,business_day,source_order,value,row_sha256 FROM removed
            UNION ALL SELECT $1,$2,$5,$4,CASE WHEN EXISTS(SELECT 1 FROM previous p WHERE p.entity_key=w.entity_key AND p.occurrence=w.occurrence) THEN 'update' ELSE 'insert' END,
              entity_type,entity_key,occurrence,business_day,source_order,value,row_sha256 FROM written w RETURNING action)
          SELECT action,count(*) AS count FROM events GROUP BY action`, values);
        await client.query('DELETE FROM pult_live.incoming_rows WHERE store_id=$1 AND domain=$2 AND command_id=$3 AND entity_type=$4', [intent.storeId, intent.domain, intent.commandId, partition.entityType]);
        const changes = { insert: 0, update: 0, delete: 0 };
        for (const row of result.rows) changes[row.action] = safeNumber(row.count);
        counts.inserted += changes.insert; counts.updated += changes.update; counts.deleted += changes.delete;
        counts.unchanged += partition.rows.length - changes.insert - changes.update;
      }
      const totals = await client.query('SELECT entity_type,count(*) AS count FROM pult_live.facts WHERE store_id=$1 AND domain=$2 GROUP BY entity_type', [intent.storeId, intent.domain]);
      const entityCounts = Object.fromEntries([...Object.keys(head.entityCounts).map(type => [type, 0]), ...intent.partitions.map(partition => [partition.entityType, 0]), ...totals.rows.map(row => [row.entity_type, safeNumber(row.count)])]);
      const next = { storeId: intent.storeId, domain: intent.domain, revision, metadata: intent.metadata, sourceMetadata: intent.sourceMetadata, entityCounts };
      const updated = await client.query('UPDATE pult_live.heads SET revision=$3,metadata=$4::jsonb,source_metadata=$5::jsonb,entity_counts=$6::jsonb,head_sha256=$7,updated_at=clock_timestamp() WHERE store_id=$1 AND domain=$2 RETURNING updated_at', [intent.storeId, intent.domain, revision, JSON.stringify(next.metadata), JSON.stringify(next.sourceMetadata), JSON.stringify(entityCounts), digest(next)]);
      const updatedAt = updated.rows[0].updated_at instanceof Date ? updated.rows[0].updated_at.toISOString() : updated.rows[0].updated_at;
      const receipt = freeze({ ...next, commandId: intent.commandId, intentFingerprint: fingerprint, previousRevision: intent.expectedRevision, mode: intent.mode, counts, updatedAt,
        beforeHead: head.revision ? head : null, afterHead: { ...next, updatedAt } });
      await client.query('INSERT INTO pult_live.commands(store_id,domain,command_id,intent_sha256,revision,receipt,receipt_sha256) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)', [intent.storeId, intent.domain, intent.commandId, fingerprint, revision, JSON.stringify(receipt), digest(receipt)]);
      return withStatus ? { receipt, replayed: false } : receipt;
    });
  }
  return Object.freeze({ getHead, listHeads, listRows, readCurrentCollections, listJournal, readAtRevision, readCommand, publish: input => write(input, false), publishWithStatus: input => write(input, false, true), importComplete: input => write(input, true) });
}

module.exports = { createPostgresLiveRepository, LiveRepositoryError, DOMAINS };
