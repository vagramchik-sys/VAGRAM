'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {start}=require('../b2b-agent/server.cjs');
const {OneCClient}=require('../b2b-agent/onec.cjs');
const {buildDraft}=require('../b2b-agent/core.cjs');
async function unusedPort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
function removeTestDir(dir){const resolved=path.resolve(dir),base=path.resolve(os.tmpdir());assert.ok(resolved.startsWith(base+path.sep)&&path.basename(resolved).startsWith('b2b-server-test-'));fs.rmSync(resolved,{recursive:true,force:true});}
test('loopback console rejects cross-origin writes and contains no send or approval route',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'b2b-server-test-')),port=await unusedPort();let app;
 try{
  app=await start({dir,port});
  const response=await fetch(app.origin+'/api/state'),state=await response.json();assert.equal(state.config.sendEnabled,false);assert.equal(state.cases.length,0);assert.equal(state.connections.crm,false);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const cross=await fetch(app.origin+'/api/poll',{method:'POST',headers:{'content-type':'application/json',origin:'https://untrusted.example','x-b2b-token':state.nonce},body:'{"enabled":true}'});assert.equal(cross.status,403);
  const missing=await fetch(app.origin+'/api/poll',{method:'POST',headers:{origin:app.origin},body:'{}'});assert.equal(missing.status,403);
  const send=await fetch(app.origin+'/api/send',{method:'POST',headers:{origin:app.origin,'x-b2b-token':state.nonce},body:'{}'});assert.equal(send.status,404);
  const headers={origin:app.origin,'content-type':'application/json','x-b2b-token':state.nonce};
  for(const route of ['leads','processing']) {
    const invalid=await fetch(app.origin+'/api/'+route,{method:'POST',headers,body:'{"enabled":"true"}'});assert.equal(invalid.status,400);
    const disconnected=await fetch(app.origin+'/api/'+route,{method:'POST',headers,body:'{"enabled":true}'});assert.equal(disconnected.status,400);
  }
  const process=await fetch(app.origin+'/api/process',{method:'POST',headers,body:'{}'});assert.equal(process.status,400);
  assert.equal(state.config.leadsEnabled,true);assert.equal(state.config.autoDraftEnabled,true);assert.equal(state.config.pollEnabled,false);
  await assert.rejects(start({dir,port:await unusedPort()}),/Другой процесс/);
  const still=await fetch(app.origin+'/api/state');assert.equal(still.status,200);
 }finally{if(app)await new Promise(r=>app.server.close(r));removeTestDir(dir);}
});
test('1C request contains client binding and only quote item data; redirects disallowed',async()=>{
 let req;const c=new OneCClient({baseUrl:'http://127.0.0.1:9000/hs/agent',token:'synthetic',fetchImpl:async(url,opts)=>{req={url,opts};return {ok:true,json:async()=>({items:[]})};}});
 await c.facts([{article:'DEMO',quantity:2,private:'omit'}],{dealId:'12',companyId:'34'});
 assert.equal(req.opts.redirect,'error');assert.equal(req.url,'http://127.0.0.1:9000/hs/agent/quote');assert.deepEqual(JSON.parse(req.opts.body),{crm:{dealId:'12',companyId:'34',contactId:null},items:[{article:'DEMO',quantity:2}]});
 await assert.rejects(c.facts([{article:'DEMO',quantity:2}]),/привязка/);
});
test('quote cannot use another customer conditions even with fresh stock',()=>{
 const extraction={intent:'quote',items:[{article:'DEMO',description:'Учебный товар',quantity:2}],missing:[],needsHuman:false,summary:'Учебный запрос'};
 const now=Date.parse('2026-09-18T12:00:00Z'),fact={article:'DEMO',source:'1C',reference:'test',checkedAt:'2026-09-18T11:59:00Z',expiresAt:'2026-09-18T12:05:00Z',price:12,available:100,currency:'RUB',unit:'шт',vatLabel:'НДС включён',crmDealId:'99',customerRef:'c',priceType:'contract'};
 assert.equal(buildDraft(extraction,{facts:[fact],dealId:'12',now}).status,'needs_data');
});
