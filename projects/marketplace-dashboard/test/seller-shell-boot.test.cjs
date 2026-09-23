'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');

test('seller shell hides legacy markup before first paint and fails open',()=>{
 const html=fs.readFileSync(path.join(root,'dist','index.html'),'utf8');
 const css=fs.readFileSync(path.join(root,'dist','seller-workspace.css'),'utf8');
 const boot=html.indexOf("document.documentElement.classList.add('pult-shell-boot')");
 assert.ok(boot>html.indexOf('<head>')&&boot>html.indexOf('<meta charset="UTF-8">'), 'boot must be inside head after charset');
 assert.ok(boot<html.indexOf('<body')&&boot<html.indexOf('<script src="dashboard.js">'), 'boot must run before content and application scripts');
 assert.match(css,/html\.pult-shell-boot body>\*\{visibility:hidden!important\}/);
 assert.match(html,/setTimeout\(function\(\)\{document\.documentElement\.classList\.remove\('pult-shell-boot'\)/);
 assert.match(html,/setAttribute\('role','alert'\)/);
 assert.match(html,/Доступна базовая навигация страницы/);
});

test('successful seller workspace initialization reveals the finished shell',()=>{
 const script=fs.readFileSync(path.join(root,'dist','seller-workspace.js'),'utf8');
 assert.match(script,/clearTimeout\(window\.__pultShellBootTimer\)/);
 assert.match(script,/document\.documentElement\.classList\.remove\('pult-shell-boot'\)/);
});

test('conversion request is tied to the funnel route and stopped on leave',()=>{
 const script=fs.readFileSync(path.join(root,'dist','conversion-ui.js'),'utf8');
 assert.match(script,/if\(!options\.api&&!sectionActive\(\)\)return null/);
 assert.match(script,/addEventListener\('pult:view-change',syncSection\)/);
 assert.match(script,/else window\.__pultConversion\?\.destroy\?\.\(\)/);
 assert.match(script,/controller\?\.abort\(\)/);
 let routeListener=null,destroyed=0;
 const context={URL,Intl,location:{href:'http://local/?view=overview',hash:''},document:{body:{dataset:{pultView:'overview'}}},window:{addEventListener(type,listener){if(type==='pult:view-change')routeListener=listener;}}};
 vm.runInNewContext(script,context);
 assert.equal(context.window.createPultConversion(),null,'overview must not initialize the funnel');
 context.window.__pultConversion={destroy(){destroyed++}};routeListener();
 assert.equal(destroyed,1,'leaving the funnel must stop its service');
});
