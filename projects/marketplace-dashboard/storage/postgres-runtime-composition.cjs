'use strict';
const createStores=require('./domains/postgres-stores.cjs');const createCore=require('./domains/postgres-core.cjs');const{createMarketRepository}=require('./postgres-market-repository.cjs');const createOwnerRoutes=require('./domains/postgres-owner-routes.cjs');const server=require('../server-postgres.cjs');
function createPostgresRuntime({pool,stateStore,scheduler,schedulerRunner,ownerAdapters,acquisition,otherHandlers=[],background=[],staticDir,staticFiles,startServer=server.start,ownerRoutesBuilder=createOwnerRoutes}={}){
 if(!pool||!stateStore||!scheduler?.load||!scheduler?.jobsProvider||!schedulerRunner?.start||!schedulerRunner?.close||!ownerAdapters||!acquisition?.market?.acquire||!acquisition?.costsPrices?.refresh||!acquisition?.insights?.refreshOrders||!acquisition?.insights?.refreshFunnel)throw new TypeError('Complete PostgreSQL runtime adapters are required');
 const storesRepository=createStores({stateStore}),marketRepository=createMarketRepository({pool}),core=createCore({storesRepository,marketRepository,stateStore,jobsProvider:()=>scheduler.jobsProvider()});
 ownerRoutesBuilder({...ownerAdapters,authorize:async()=>false});
 const ownerRoutesFactory=({authorize})=>ownerRoutesBuilder({...ownerAdapters,authorize});
 async function readiness(){const passive=await core.ready();await scheduler.load();const missing=['runtime-composition'];if(passive.coreReady!==true)missing.push('core');for(const[name,value,method]of[['market-acquisition',acquisition.market,'acquire'],['costs-prices',acquisition.costsPrices,'refresh'],['insights-orders',acquisition.insights,'refreshOrders'],['insights-funnel',acquisition.insights,'refreshFunnel']])if(typeof value?.[method]!=='function')missing.push(name);return{ready:false,missingAdapters:missing,passive:false};}
 return Object.freeze({core,storesRepository,marketRepository,readiness,start:({port=0}={})=>startServer({pool,core,ownerRoutesFactory,otherHandlers,background:[schedulerRunner,...background],staticDir,staticFiles,port,readiness})});
}
module.exports={createPostgresRuntime};
