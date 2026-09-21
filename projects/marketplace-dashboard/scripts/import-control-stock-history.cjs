'use strict';
// Explicit offline import: no network, source execution, current stock writes, or SQL restore.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {normalize}=require('../stock-history-import.cjs'),history=require('../stock-history.cjs');
const FILES=['ozon-product-daily-snapshots.json','ozon-cabinet-stock-core.json','ozon-seller-stock-core.json','cluster-supply-last-good.json'];
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function run({sourceDir,privateDir,storeMap,apply=false}){
 sourceDir=path.resolve(sourceDir);privateDir=path.resolve(privateDir);
 const files={},buffers={},manifest=[],names=[...FILES];
 for(const [folder,suffix] of [['stock-audit','.jsonl'],['stock-api-diagnostics','.json']]){
  const dir=path.join(sourceDir,folder);if(fs.existsSync(dir))for(const name of fs.readdirSync(dir).filter(name=>name.endsWith(suffix)).sort())names.push(folder+'/'+name);
 }
 for(const name of names){const bytes=fs.readFileSync(path.join(sourceDir,name)),text=bytes.toString('utf8').replace(/^\ufeff/,'');files[name]=name.endsWith('.jsonl')?text.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line)):JSON.parse(text);buffers[name]=bytes;manifest.push({file:name,sha256:sha(bytes),bytes:bytes.length})}
 const normalizerVersion=1,importId=sha(JSON.stringify({manifest,storeMap,normalizerVersion})),base=normalize({files,storeMap}),extra=require('../stock-history-audit-import.cjs').normalizeAudit({files,storeMap});
 const result={rows:[...base.rows,...extra.rows],issues:[...base.issues,...extra.issues],sourceStats:{base:base.sourceStats,audit:extra.sourceStats}};
 const stats={importId,normalizerVersion,rows:result.rows.length,issues:result.issues,sourceStats:result.sourceStats,manifest};
 if(!apply)return {...stats,applied:false};
 const folder=path.join(privateDir,'stock-history-imports',importId);fs.mkdirSync(folder,{recursive:true});
 for(const name of names){const dest=path.join(folder,name);fs.mkdirSync(path.dirname(dest),{recursive:true});if(fs.existsSync(dest)){if(sha(fs.readFileSync(dest))!==sha(buffers[name]))throw Error('Архив источника не совпадает; импорт остановлен')}else fs.writeFileSync(dest,buffers[name],{flag:'wx'})}
 const audit=path.join(folder,'manifest.json');if(!fs.existsSync(audit))fs.writeFileSync(audit,JSON.stringify({...stats,storeMap,sourceDir,archivedAt:new Date().toISOString()},null,2),{flag:'wx'});
 fs.mkdirSync(path.join(privateDir,'history'),{recursive:true});
 const imported=history.ingest({dbFile:path.join(privateDir,'history','stocks.sqlite'),importId,manifest,rows:result.rows,issues:result.issues});
 return {...stats,applied:true,imported};
}
if(require.main===module){
 try{const args=process.argv.slice(2),get=key=>args[args.indexOf(key)+1];for(const key of ['--source','--private','--mapping'])if(!args.includes(key)||!get(key)||get(key).startsWith('--'))throw Error('Нужны --source, --private и --mapping');const result=run({sourceDir:get('--source'),privateDir:get('--private'),storeMap:JSON.parse(fs.readFileSync(get('--mapping'),'utf8')),apply:args.includes('--apply')});console.log(JSON.stringify(result,null,2))}catch(error){console.error(error.message);process.exitCode=1}
}
module.exports={run,FILES};
