'use strict';

// Explicit local maintenance command. It changes only the Pult taxonomy, never
// marketplace cards, supplier groups, orders, prices or financial source rows.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { refine, mergeCottonPvcGloveColors } = require('../product-category-refinement.cjs');
const { validate } = require('../product-type-registry.cjs');
const { createApplicationPool } = require('../storage/postgres-connection.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');
const { createJsonDocumentRepository } = require('../storage/postgres-json-repository.cjs');
const { sourceKey } = require('../storage/postgres-document-import.cjs');
const { createPostgresLiveRepository } = require('../storage/postgres-live-repository.cjs');
const { createLiveSources } = require('../storage/postgres-live-sources.cjs');
const { createLiveSourceProviders } = require('../storage/postgres-live-source-providers.cjs');

function options(args) {
  if (!Array.isArray(args) || new Set(args).size !== args.length || args.some(arg => !['--apply','--merge-cotton-pvc-colors'].includes(arg))) throw Error('Use [--merge-cotton-pvc-colors] [--apply]');
  return { apply: args.includes('--apply'), mergeColors: args.includes('--merge-cotton-pvc-colors') };
}
async function run(args = process.argv.slice(2)) {
  const command = options(args);
  const root = path.resolve(__dirname, '..');
  const pool = await createApplicationPool({ bootstrapFile: path.join(root, '.private/postgres-setup/application.dpapi'), profile: 'ui' });
  try {
    const stateStore = createStateStore({ pool });
    const document = createJsonDocumentRepository({ stateStore, logicalKey: sourceKey('product-type-registry.json'), sourcePath: 'product-type-registry.json', validate: value => { validate(value); return true; }, maxBytes: 5 * 1024 * 1024 });
    const before = await document.read();
    if (!before || before.deleted) throw Error('PRODUCT_REGISTRY_MISSING');
    let result, report;
    if (command.mergeColors) {
      result = mergeCottonPvcGloveColors(before.value);
      report = { mode: command.apply ? 'apply' : 'preview', operation: 'merge-cotton-pvc-glove-colors', changed: result.changed, revision: result.registry.revision, assignmentsMoved: result.changes.length, addedTypes: result.addedTypes.length, removedTypes: before.value.types.length + result.addedTypes.length - result.registry.types.length };
    } else {
      const sources = createLiveSources({ repository: createPostgresLiveRepository({ pool }) });
      const catalogs = await createLiveSourceProviders({ sources }).getCatalogs();
      const products = catalogs.flatMap(catalog => catalog.products.map(product => ({ ...product, key: catalog.storeId + ':' + (product.product_id ?? product.nmID) })));
      result = refine(before.value, products);
      const byId = new Map(result.registry.types.map(type => [type.id, type]));
      const typePath = id => { const names = []; for (let type = byId.get(id); type; type = byId.get(type.parentId)) names.unshift(type.name); return names; };
      const depths = {};
      for (const product of products) { const assignment = result.registry.assignments[product.key]; const level = assignment ? typePath(assignment.typeId).length : 0; depths[level] = (depths[level] || 0) + 1; }
      report = { mode: command.apply ? 'apply' : 'preview', operation: 'full-refinement', changed: result.changed, revision: result.registry.revision, products: products.length, refinedAssignments: result.changes.length, newlyClassified: result.assignedNew.length, addedTypes: result.addedTypes.length, productsByDepth: depths,
        examples: [...new Map(products.filter(product => /саморез|перчатк/iu.test(product.name || '')).map(product => { const assignment = result.registry.assignments[product.key]; return [assignment?.typeId, assignment ? typePath(assignment.typeId) : null]; })).values()].filter(Boolean).slice(0, 30) };
    }
    if (command.apply && result.changed) {
      const backupDirectory = path.join(root, '.private/taxonomy-backups'); await fs.mkdir(backupDirectory, { recursive: true });
      const backup = path.join(backupDirectory, `registry-${Date.now()}.json`);
      await fs.writeFile(backup, JSON.stringify({ revision: before.revision, value: before.value }), { flag: 'wx' });
      await document.compareAndSet(result.registry, { expectedRevision: before.revision, commandId: crypto.randomUUID() });
      const after = await document.read();
      if (after.value.revision !== result.registry.revision) throw Error('PRODUCT_REGISTRY_VERIFICATION_FAILED');
      report.saved = true;
    }
    return report;
  } finally { await pool.end(); }
}
if (require.main === module) run().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { run, options };
