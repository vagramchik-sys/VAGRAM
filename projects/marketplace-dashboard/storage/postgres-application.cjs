'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {execFile}=require('node:child_process');
const crypto=require('node:crypto');
const {protect:windowsProtect}=require('./windows-dpapi.cjs');
const {createLiveComposition}=require('./postgres-live-composition.cjs');
const {createLiveHistoryCapture}=require('./postgres-live-history-capture.cjs');
const {createStateBatch}=require('./postgres-state-batch.cjs');
const createStores=require('./domains/postgres-stores.cjs');
const createCore=require('./domains/postgres-core.cjs');
const createProductTypes=require('./domains/postgres-product-type-registry.cjs').create;
const createSupplierPortals=require('./domains/postgres-supplier-portals.cjs');
const createManagement=require('./domains/postgres-management.cjs');
const createFinanceRegister=require('./domains/postgres-finance-register.cjs');
const createWorkspaceTools=require('./domains/postgres-workspace-tools.cjs');
const createPartnerWorkspace=require('./domains/postgres-partner-workspace.cjs');
const createPartnerTools=require('./domains/postgres-partner-tools.cjs');
const createPartnerServer=require('./domains/postgres-partner-server.cjs');
const createCharityWorkspace=require('./domains/postgres-charity-workspace.cjs');
const createCharityTools=require('./domains/postgres-charity-tools.cjs');
const createTrueStats=require('./domains/postgres-truestats.cjs');
const createAnalytics=require('./domains/postgres-analytics-composition.cjs');
const createIntraday=require('./domains/postgres-intraday.cjs');
const createCategoryCapture=require('./domains/postgres-order-category-capture.cjs');
const createDerivedCapture=require('./domains/postgres-derived-capture.cjs');
const createReportRoutes=require('./domains/postgres-report-routes.cjs');
const {createBusinessDynamics}=require('./domains/postgres-business-dynamics.cjs');
const {createBusinessDynamicsRepository}=require('./postgres-business-dynamics-repository.cjs');
const createStoreRoutes=require('./domains/postgres-store-routes.cjs');
const {createPostgresStoreCommands}=require('./domains/postgres-store-commands.cjs');
const {createPostgresFinanceDocumentRoutes}=require('./domains/postgres-finance-document-routes.cjs');
const createAcquisitionRoutes=require('./domains/postgres-acquisition-routes.cjs');
const createInfoRoutes=require('./domains/postgres-info-routes.cjs');
const {createXwayReader,createXwayHandler}=require('./postgres-xway.cjs');
const {createFinanceDocumentStore}=require('./postgres-finance-documents.cjs');
const {createMarketHistoryRepository}=require('./postgres-history-repository.cjs');
const {createStockHistoryRepository}=require('./postgres-stock-repository.cjs');
const {createPostgresArchiveRepository}=require('./postgres-archive-repository.cjs');
const {createJournaledArchive}=require('./postgres-journaled-archive.cjs');
const {createSchedulerRunner}=require('./acquisition/postgres-scheduler-runner.cjs');
const {createCadenceProducer}=require('./acquisition/postgres-cadence-producer.cjs');
const {createAcquisitionDispatchers}=require('./acquisition/postgres-acquisition-dispatcher.cjs');
const {createPostgresDerivedInputs}=require('./acquisition/postgres-derived-inputs.cjs');
const {createWbApi}=require('./acquisition/postgres-marketplace-transport.cjs');
const {createPostgresOzonApi}=require('./acquisition/postgres-ozon-http.cjs');
const {createOzonSnapshotCollector}=require('./acquisition/postgres-ozon-snapshot.cjs');
const {createWbSnapshotCollector}=require('./acquisition/postgres-wb-snapshot.cjs');
const {createMarketAcquisition}=require('./acquisition/postgres-market-acquisition.cjs');
const {createPostgresLiveLedgerRefresh}=require('./acquisition/postgres-live-ledger-refresh.cjs');
const {createCostsPricesAcquisition}=require('./acquisition/postgres-costs-prices.cjs');
const {createOzonOrdersCollector}=require('./acquisition/postgres-ozon-orders-collector.cjs');
const {createOzonFunnelCollector}=require('./acquisition/postgres-ozon-funnel-collector.cjs');
const {createPostgresInsights}=require('./acquisition/postgres-insights.cjs');
const {createPostgresWbOrders}=require('./acquisition/postgres-wb-orders.cjs');
const {createPerformanceTransport}=require('./acquisition/ozon-performance-transport.cjs');
const {createPerformanceAcquisition}=require('./acquisition/postgres-performance-acquisition.cjs');
const {createOptimizerRepository}=require('./postgres-optimizer-repository.cjs');
const {createOptimizerExperiments}=require('./postgres-optimizer-experiments.cjs');
const {createPostgresOptimizer}=require('./domains/postgres-optimizer.cjs');
const {createOptimizerRoutes}=require('./domains/postgres-optimizer-routes.cjs');
const {optimizerRuntimeReadiness}=require('./postgres-optimizer-schema.cjs');
const {createPostgresServerComposition}=require('./postgres-server-composition.cjs');
const {buildForecasts}=require('../supplier-forecast.cjs');
const {buildPartnerSales}=require('../partner-data.cjs');
const {requestMetrics}=require('./postgres-request-metrics.cjs');

function extractor(script=path.resolve(__dirname,'..','loan-contract-extract.py')){return(kind,target)=>new Promise((resolve,reject)=>{const bundled=process.env.USERPROFILE&&path.join(process.env.USERPROFILE,'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe'),python=process.env.PULT_PYTHON||bundled||'python';execFile(python,[script,kind,target],{windowsHide:true,timeout:35000,maxBuffer:3*1024*1024},(error,stdout)=>{let value;try{value=JSON.parse(String(stdout).trim())}catch{}if(error||!value?.ok)return reject(Object.assign(Error('Local document extraction failed'),{code:'EXTRACTION_FAILED'}));resolve(value)})})}
function createReleaseNotesLoader(file=path.resolve(__dirname,'..','release-notes.json')){let modified=-1,value=null;return async()=>{const stat=await fs.promises.stat(file);if(value&&stat.mtimeMs===modified)return value;const next=JSON.parse(await fs.promises.readFile(file,'utf8'));if(!next||typeof next!=='object'||Array.isArray(next)||!Array.isArray(next.entries))throw Error('INVALID_RELEASE_NOTES');value=next;modified=stat.mtimeMs;return value}}
function schedules(scheduler,runner,cadence){async function all(){return scheduler.statusJobs()}return Object.freeze({async schedule(id){const jobs=await all(),get=kind=>jobs[`${kind}:${id}`];return{orders:{nextAt:get('insights-today')?.nextDueAt||get('insights-full')?.nextDueAt||null},finance:{nextAt:get('market')?.nextDueAt||null},funnel:{nextAt:get('insights-funnel')?.nextDueAt||null}}},async status(){return Object.values(await all()).map(job=>({id:job.storeId,kind:job.kind,status:job.state,stage:job.stage,count:job.count,nextDueAt:job.nextDueAt}))},async job(id){return(await scheduler.jobsProvider())[id]||null},async historyError(){return runner.health().lastError?.code||cadence.health().lastError?.code||null}})}

async function createPostgresApplication({pool,readPool=pool,ozonHttpPool=pool,ozonApiFactory=createPostgresOzonApi,staticDir,staticFiles,stateSchema='pult',marketSchema='pult_market',historySchema='pult_history',partnerPort=4319,protect=windowsProtect,fetchFn=globalThis.fetch,now=()=>Date.now(),releaseNotes,loadReleaseNotes,extractFile=extractor(),verifyProviders}={}){
 if(!pool?.query||!pool?.connect||!readPool?.query||!readPool?.connect||typeof protect!=='function'||typeof fetchFn!=='function')throw new TypeError('runtime/read pools, DPAPI and fetch transport are required');
 fetchFn=requestMetrics.instrumentExternal(fetchFn);
 const live=await createLiveComposition({pool,stateSchema,marketSchema}),readLive=readPool===pool?live:await createLiveComposition({pool:readPool,stateSchema,marketSchema});
 const {stateStore,marketRepository,scheduler,marketWriter}=live,sourceProviders=readLive.sourceProviders,storesRepository=createStores({stateStore}),productTypes=createProductTypes({stateStore}),intraday=createIntraday({stateStore}),categoryCapture=createCategoryCapture({stateStore});
 const core=createCore({storesRepository,marketRepository,stateStore,jobsProvider:()=>scheduler.jobsProvider(),sourceRevisions:stateStore.revisions});
 async function salesStores(){const [publicRows,protectedRows,products]=await Promise.all([core.publicStores(),storesRepository.read(),core.supplierProducts()]);return Promise.all(publicRows.map(async store=>({...store,market:protectedRows[store.id]?.market==='WB'?'WB':'Ozon',products:products.filter(product=>product.storeId===store.id),ledger:protectedRows[store.id]?.market==='WB'?null:await core.ledgerFor(store.id)})))}
 let categorySalesReader=null;
 const supplierPortals=createSupplierPortals({stateStore,getProducts:()=>core.supplierProducts(),getForecasts:async()=>buildForecasts(await salesStores(),{horizonDays:45,historyDays:28,now:new Date(now())}),getCategorySales:options=>categorySalesReader.read(options),now:()=>new Date(now()).toISOString()}),management=createManagement({stateStore,catalog:()=>core.supplierProducts()}),financeRegister=createFinanceRegister({stateStore,getStores:()=>core.financeStores()}),workspaceTools=createWorkspaceTools({stateStore});
 const historyFacts=createMarketHistoryRepository({pool,schema:historySchema,now}),archive=createPostgresArchiveRepository({pool,schema:historySchema,history:historyFacts,now}),journaledArchive=createJournaledArchive({stateStore,archive}),history={status:async()=>({archive:await archive.status(),facts:await historyFacts.status()}),report:options=>historyFacts.report(options)},stockHistory=createStockHistoryRepository({pool,schema:historySchema});
 const trueStats=createTrueStats({stateStore,protect,transport:fetchFn,now,getProducts:sourceProviders.getProducts}),analytics=createAnalytics({pool,stateSchema,storesRepository,productTypes,supplierPortals,trueStats,now,sourceProviders});categorySalesReader=analytics.categorySales;
 const derivedInputs=createPostgresDerivedInputs({stateStore,storesRepository,productTypes,supplierPortals,liveSources:live.sources,now}),derivedCapture=createDerivedCapture({intraday,categoryCapture,journaledArchive,archiveRead:archive,stateStore,loadSource:derivedInputs.loadSource,loadDerived:derivedInputs.materialize,historyCapture:createLiveHistoryCapture({sources:live.sources,historyFacts})});
 const ozonApi=ozonApiFactory({pool:ozonHttpPool}),wbApi=createWbApi({fetchFn}),decrypt=value=>protect(value,true),optimizerRepository=createOptimizerRepository({pool,readPool,now:()=>new Date(now())}),optimizerExperiments=createOptimizerExperiments({pool,readPool,now:()=>new Date(now())}),performanceTransport=createPerformanceTransport({fetchFn,now,getCredentials:async storeId=>{const saved=await optimizerRepository.getCredentials(storeId);if(!saved)return null;let clientId,clientSecret;try{[clientId,clientSecret]=await Promise.all([protect(saved.clientIdCiphertext,true),protect(saved.clientSecretCiphertext,true)]);return{storeId,clientId,clientSecret,credentialVersion:saved.credentialVersion}}finally{clientId=null;clientSecret=null}}}),performance=createPerformanceAcquisition({repository:optimizerRepository,transport:performanceTransport,storesRepository,sourceProviders,now:()=>new Date(now())}),ledgerRefresh=createPostgresLiveLedgerRefresh({liveSources:live.sources}),market=createMarketAcquisition({storesRepository,marketRepository,marketWriter,ledgerRefresh,ozonCollector:createOzonSnapshotCollector({api:ozonApi,now:()=>new Date(now())}),wbCollector:createWbSnapshotCollector({fetchFn,now:()=>new Date(now())}),decrypt}),costsPrices=createCostsPricesAcquisition({stateStore,storesRepository,decrypt,ozonApi,fetchFn}),insights=createPostgresInsights({stateStore,storesRepository,marketRepository,ledgerRefresh,decrypt,ordersCollector:createOzonOrdersCollector({api:ozonApi,now:()=>new Date(now())}),funnelCollector:createOzonFunnelCollector({api:ozonApi,now})}),wbOrders=createPostgresWbOrders({stateStore,storesRepository,decrypt,fetchFn,now});
 const acquisition={market,costsPrices,insights,wbOrders,performance,derivedCapture},dispatchers=createAcquisitionDispatchers({stateStore,...acquisition}),runner=createSchedulerRunner({scheduler,dispatchers,runnerId:`runtime-${process.pid}`,uuid:crypto.randomUUID,now:()=>new Date(now())}),cadence=createCadenceProducer({scheduler,storesRepository,stateStore,readMarketDocument:live.readMarketDocument,readDocument:live.readDocument,readPerformanceState:optimizerRepository.readRefreshState,buildDerivedPayload:derivedInputs.build,now:()=>new Date(now())}),scheduleView=schedules(scheduler,runner,cadence);
 const storeCommands=createPostgresStoreCommands({stateStore,protect,ozonApi,wbApi,scheduleSync:async({storeId,commandId,timestamp})=>cadence.request({storeId,kinds:storeId.startsWith('wb-')?['market','costs-prices','wb-orders']:['market','costs-prices','insights-full'],commandId,timestamp})});
 const businessDynamics=createBusinessDynamics({repository:createBusinessDynamicsRepository({pool:readPool}),storesRepository,now});
 const reportRoutes=createReportRoutes({businessDynamics,storesRepository,sourceProviders,supplierPortals,productTypes,intraday,orderCategoryState:categoryCapture,trueStats,schedules:scheduleView,now}),financeDocuments=createFinanceDocumentStore({stateStore,batch:createStateBatch({pool,schema:stateSchema}),extractFile,tempRoot:require('node:os').tmpdir()}),partnerWorkspace=createPartnerWorkspace({stateStore,getProducts:()=>core.supplierProducts(),getSales:async productKeys=>buildPartnerSales(await salesStores(),{productKeys,now:new Date(now())}),getCategoryOverview:()=>supplierPortals.categorySalesOverview(),protect,now}),partnerServer=createPartnerServer({workspace:partnerWorkspace,staticDir,port:partnerPort,now}),charityWorkspace=createCharityWorkspace({stateStore}),infoRoutes=createInfoRoutes({stateStore,releaseNotes,loadReleaseNotes:loadReleaseNotes||(!releaseNotes?createReleaseNotesLoader():undefined),storesRepository,scheduler:readLive.scheduler,readSourceMetadata:readLive.readSourceMetadata,now});
 let optimizerFunctions={};try{optimizerFunctions={...require('../optimizer/economics.cjs'),...require('../optimizer/decision.cjs')}}catch(error){if(error?.code!=='MODULE_NOT_FOUND')throw error}const optimizerDomain=createPostgresOptimizer({repository:optimizerRepository,storesRepository,sourceProviders,optimizer:optimizerFunctions,now:()=>new Date(now())});
 const ownerAdapters={management,financeRegister,supplierPortals,history,stockHistory,workspaceTools,pricingStatus:async()=>scheduleView.status()};
 const defaultVerify=async()=>{const missing=[];const optimizerSchema=await optimizerRuntimeReadiness(readPool);if(!optimizerSchema.ready)missing.push(optimizerSchema.code);const registry=await storesRepository.record();if(!registry)missing.push('stores-import');else for(const id of Object.keys(registry.value))if(!await live.repository.getHead({storeId:id,domain:'market'}))missing.push(`market:${id}`);return{ready:missing.length===0,missingAdapters:missing}};
 return createPostgresServerComposition({pool,readPool,stateStore,stateSchema,marketSchema,protect,transport:fetchFn,now,ownerAdapters,scheduler,schedulerRunner:runner,cadenceProducer:cadence,acquisition,staticDir,staticFiles,sourceProviders,trueStats,analytics,verifyProviders:async()=>{await ozonApi.checkReadiness?.();return (verifyProviders||defaultVerify)()},capabilities:{productTypes},readAdapters:{stateStore:readLive.stateStore,marketRepository:readLive.marketRepository,scheduler:readLive.scheduler},background:[partnerServer],additionalHandlers:[{name:'xway-read',handle:createXwayHandler({reader:createXwayReader({pool:readPool})}).handle},{name:'report-routes',handle:reportRoutes.handle},{name:'info-routes',handle:infoRoutes.handle}],handlerFactories:{'store-commands':({authorize})=>createStoreRoutes({commands:storeCommands,authorize}),'finance-documents':({authorize})=>createPostgresFinanceDocumentRoutes({documents:financeDocuments,authorize}),'acquisition-routes':({authorize})=>createAcquisitionRoutes({producer:cadence,authorize}),'partner-tools':({authorize})=>createPartnerTools({workspace:partnerWorkspace,authorize,getAvailability:partnerServer.available}),'charity-tools':({authorize})=>createCharityTools({workspace:charityWorkspace,authorize}),'optimizer-routes':({authorize})=>createOptimizerRoutes({optimizer:optimizerDomain,repository:optimizerRepository,experiments:optimizerExperiments,transport:performanceTransport,producer:cadence,storesRepository,protect,authorize,now:()=>new Date(now())})}})
}
module.exports={createPostgresApplication,createReleaseNotesLoader};
