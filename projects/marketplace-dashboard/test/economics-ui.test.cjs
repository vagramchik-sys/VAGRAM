'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../dist/economics-ui.js'),'utf8');
function runtime(){
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',textContent:'',innerHTML:'',disabled:false,className:'',addEventListener(){}});return nodes.get(id)};
 const seed={insertAdjacentHTML(_position,html){for(const match of html.matchAll(/id="([^"]+)"/g))node(match[1])}};
 const context={window:{},document:{getElementById:node,querySelector:selector=>selector==='.ins-two'?seed:null},Intl,Date,console};
 vm.runInNewContext(source,context,{filename:'economics-ui.js'});return {view:context.window.createPultEconomics(),node};
}
test('economics labels only a period that includes the Moscow current day as preliminary',()=>{
 const app=runtime(),base={generatedAt:'2026-09-21T12:00:00.000Z',economics:null};
 app.view.render({...base,current:{from:'2026-09-14',to:'2026-09-20'}});assert.match(app.node('eco-period').textContent,/завершённый период$/);assert.doesNotMatch(app.node('eco-period').textContent,/текущего дня/);
 app.view.render({...base,current:{from:'2026-09-21',to:'2026-09-21'}});assert.match(app.node('eco-period').textContent,/показатели текущего дня предварительные$/);
});
