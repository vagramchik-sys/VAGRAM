'use strict';
const legacy = require('../../product-type-registry.cjs');
const { createJsonDocumentRepository } = require('../postgres-json-repository.cjs');
const { sourceKey } = require('../postgres-document-import.cjs');
const EMPTY = Object.freeze({ ...legacy.EMPTY, types: [], assignments: {}, rules: [] });
function valid(value) { try { legacy.validate(value); return true; } catch { return false; } }
function create({ stateStore } = {}) {
  if (!stateStore) throw new TypeError('stateStore is required');
  const repository = createJsonDocumentRepository({ stateStore, logicalKey: sourceKey('product-type-registry.json'), sourcePath: 'product-type-registry.json', validate: valid, maxBytes: 5 * 1024 * 1024 });
  async function read() { const record = await repository.read(); return !record || record.deleted ? structuredClone(EMPTY) : legacy.validate(record.value); }
  async function classify(productKey, product) { return legacy.classify(await read(), productKey, product); }
  return Object.freeze({ read, classify });
}
module.exports = { create, validate: legacy.validate, classify: legacy.classify, evidenceText: legacy.evidenceText, EMPTY };
