'use strict';
const {createStateStore} = require('./postgres-state.cjs');
const {createPostgresLiveRepository} = require('./postgres-live-repository.cjs');
const {createLiveSources} = require('./postgres-live-sources.cjs');
const {createLiveStateStore} = require('./postgres-live-state-store.cjs');
const {createLiveSourceProviders} = require('./postgres-live-source-providers.cjs');
const {createLiveMarketRepository, createLiveMarketWriter} = require('./postgres-live-market.cjs');
const {createPostgresLiveScheduler} = require('./acquisition/postgres-live-scheduler.cjs');
const {decodeMetadata} = require('./postgres-live-codecs.cjs');

async function createLiveComposition({pool, stateSchema = 'pult', marketSchema = 'pult_market'} = {}) {
  if (!pool?.query || !/^[a-z][a-z0-9_]{0,62}$/u.test(stateSchema)) throw new TypeError('Live composition dependencies are required');
  const legacyStateStore = createStateStore({pool, schema: stateSchema, marketSchema});
  const repository = createPostgresLiveRepository({pool});
  const sources = createLiveSources({repository});
  const paths = (await pool.query(`SELECT source_path FROM "${stateSchema}".source_files WHERE media_type='application/json'`)).rows.map(row => row.source_path);
  paths.push(...(await sources.listSources()).map(row => row.sourcePath));
  const stateStore = createLiveStateStore({legacyStateStore, sources, sourcePaths: [...new Set(paths)]});
  const sourceProviders = createLiveSourceProviders({sources});
  const marketRepository = createLiveMarketRepository({liveSources: sources,pool});
  const marketWriter = createLiveMarketWriter({liveSources: sources});
  const scheduler = createPostgresLiveScheduler({pool});
  const readMarketDocument = async storeId => {
    const head = await repository.getHead({storeId, domain: 'market'});
    return head ? {revision: String(head.revision), value: decodeMetadata(`data-${storeId}.json`,head.metadata), sha256: head.sourceMetadata.sourceSha256, deleted: false} : {revision:'0',value:null};
  };
  const readDocument = async sourcePath => {
    const head = await repository.getHead(sources.identity(sourcePath));
    return head ? {revision: String(head.revision), value: decodeMetadata(sourcePath,head.metadata), sha256: head.sourceMetadata.sourceSha256, deleted: false} : {revision:'0',value:null};
  };
  // Status pages need only the small head metadata. Read every requested source
  // from one heads query and never touch the fact rows behind a live document.
  const readSourceMetadata = async sourcePaths => {
    if (!Array.isArray(sourcePaths) || sourcePaths.length > 100) throw new TypeError('sourcePaths are required');
    const requested = [...new Set(sourcePaths)].map(sourcePath => ({sourcePath, identity: sources.identity(sourcePath)}));
    const heads = await repository.listHeads(), byIdentity = new Map(heads.map(head => [`${head.domain}\u0000${head.storeId}`, head]));
    return new Map(requested.map(({sourcePath,identity}) => {
      const head = byIdentity.get(`${identity.domain}\u0000${identity.storeId}`);
      return [sourcePath, head ? decodeMetadata(sourcePath,head.metadata) : null];
    }));
  };
  return Object.freeze({stateStore, repository, sources, sourceProviders, marketRepository, marketWriter, scheduler, readMarketDocument, readDocument, readSourceMetadata});
}
module.exports = {createLiveComposition};
