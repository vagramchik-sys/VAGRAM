'use strict';
const {createJsonDocumentRepository}=require('../postgres-json-repository.cjs');
const {sourceKey}=require('../postgres-document-import.cjs');
const validImpact=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Number.isSafeInteger(value.donatedRub)&&value.donatedRub>=0&&Number.isSafeInteger(value.childrenHomes)&&value.childrenHomes>=0&&(value.updatedAt===undefined||typeof value.updatedAt==='string'&&Number.isFinite(Date.parse(value.updatedAt)));
module.exports=function createPostgresInfoRoutes({stateStore,releaseNotes}={}){
 if(!stateStore||!releaseNotes||typeof releaseNotes!=='object')throw new TypeError('stateStore and releaseNotes are required');const repo=createJsonDocumentRepository({stateStore,logicalKey:sourceKey('company-impact.json'),sourcePath:'company-impact.json',validate:validImpact});
 const reply=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
 async function handle(req,res,url){if(!['/api/impact','/api/changes'].includes(url.pathname))return false;if(req.method!=='GET'){reply(res,405,{error:'Метод не поддерживается.'});return true}if(url.pathname==='/api/changes')reply(res,200,structuredClone(releaseNotes));else{const row=await repo.read();reply(res,200,row&&!row.deleted?{donatedRub:row.value.donatedRub,childrenHomes:row.value.childrenHomes,updatedAt:row.value.updatedAt,source:'owner'}:null)}return true}
 return Object.freeze({handle});
};
