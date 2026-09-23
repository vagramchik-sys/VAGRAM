'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const read=file=>fs.readFileSync(require.resolve('../'+file),'utf8');
test('business chart offers TrueStats net profit and removes the duplicate standalone panel',()=>{
 const insights=read('dist/insights-ui.js'),chart=read('dist/turnover-chart.js'),index=read('dist/index.html'),navigation=read('dist/navigation.js');
 assert.match(insights,/<option value="netProfit">Чистая прибыль<\/option>/);
 assert.match(chart,/\/api\/profit-series\?/);
 assert.match(chart,/TrueStats не распределяет её по категориям товаров/);
 assert.match(chart,/point\.complete===true&&Number\.isFinite\(point\.profit\)\?point\.profit:null/);
 assert.match(chart,/point\.status==='ready'&&Number\.isFinite\(point\.profit\)\?point\.profit:null/);
 assert.doesNotMatch(insights,/createPultNetProfit/);
 assert.doesNotMatch(index,/net-profit-ui\.js|net-profit\.css/);
 assert.doesNotMatch(navigation,/net-profit-chart/);
});
test('category mode supports daily periods, combined roots and store lines without false zeros',()=>{
 const chart=read('dist/turnover-chart.js'),server=read('server.cjs');
 assert.match(chart,/\/api\/order-category-daily\?/);
 assert.doesNotMatch(chart,/\/api\/order-categories\?/);
 assert.match(chart,/<option value="5" selected>5 уровней категорий<\/option>/);
 assert.match(chart,/<option value="products">До товаров<\/option>/);
 assert.match(chart,/все выбранные площадки/);
 assert.match(chart,/daily\.byStore/);
 assert.match(chart,/store:'\+item\.storeId\+':'\+item\.typeId/);
 assert.match(chart,/categoryMarketItems\(daily,id\)/);
 assert.match(chart,/История загружена не полностью/);
 assert.match(server,/\/api\/order-category-daily/);
});
