'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {previewReport,reportRows,parseDelimited}=require('../storage/growth-report-import.cjs');
const headers=['Название товара','Ссылка на товар','Продавец','Бренд','Средняя цена, ₽','Минимальная цена, ₽','Заказано, штуки','Доля рекламных расходов, %'];
const fixture=()=>[[['Дата формирования:','10.01.26'],['Период отчета:','7 дней'],headers,['Саморезы','https://www.ozon.ru/product/test-123/','Магазин','Марка','1 234,5','999','20','14,7'],['Среднее значение по товарам','','','','900','800','15','10']]];
test('Ozon report recognizes columns, preserves historical meaning and does not infer ambiguous dates',()=>{
 const result=reportRows(fixture());assert.equal(result.rows.length,1);assert.deepEqual(result.rows[0].historical,{averagePrice:1234.5,minimumPrice:999,orderedUnits:20,drrPct:14.7});
 assert.equal(result.rows[0].url,'https://www.ozon.ru/product/123/');assert.equal(result.rows[0].buyerPrice,undefined);assert.equal(result.periodFrom,undefined);assert.equal(result.requiresPeriod,true);
});
test('CSV supports quoted commas, multiline names and escaped quotes',()=>{
 assert.deepEqual(parseDelimited('a,b,c\n"Один, два","Имя\nстрока","""три"""'),[['a','b','c'],['Один, два','Имя\nстрока','"три"']]);assert.throws(()=>parseDelimited('a,b\n"unterminated'));
});
test('quoted semicolons and tabs do not change the CSV delimiter',async()=>{
 const result=await previewReport({format:'csv',text:'Название товара,Ссылка на товар\n"Изделие; набор\tдеталей",https://www.ozon.ru/product/123/'});
 assert.equal(result.rows[0].name,'Изделие; набор\tдеталей');
});
test('invalid links and duplicate aliases cannot be imported',()=>{
 const rows=fixture();rows[0].push(['Duplicate','https://ozon.ru/product/123/'],['Unsafe','https://ozon.ru.evil.test/product/456/']);const result=reportRows(rows);assert.equal(result.rows.length,1);assert.equal(result.skipped,2);
});
test('unavailable and fractional units remain unknown, rather than zero',()=>{
 const rows=fixture();rows[0][3][4]='—';rows[0][3][6]='1,5';assert.equal(reportRows(rows).rows[0].historical.averagePrice,null);assert.equal(reportRows(rows).rows[0].historical.orderedUnits,null);
});
test('preview handles actual extraction contract and strict upload limits',async()=>{
 const result=await previewReport({format:'xlsx',base64:Buffer.from('sample').toString('base64')},{extract:async buffer=>{assert.equal(buffer.toString(),'sample');return fixture();},now:()=>Date.parse('2026-10-01T09:00:00Z')});
 assert.equal(result.observedAt,'2026-10-01T09:00:00.000Z');
 await assert.rejects(previewReport({format:'xlsx',base64:'%%%='}),{code:'INVALID_REPORT'});await assert.rejects(previewReport({format:'exe',text:'x'}),{code:'INVALID_REPORT'});assert.throws(()=>reportRows([[['Unknown','columns']]]));
});
test('XLSX extraction preserves displayed percentages and rejects entities',t=>{
 const path=require('node:path'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
 const bundled=process.env.USERPROFILE&&path.join(process.env.USERPROFILE,'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe');
 const python=process.env.PULT_PYTHON||(bundled&&fs.existsSync(bundled)?bundled:'python');
 const result=spawnSync(python,['-B',path.join(__dirname,'growth-report-python.py')],{windowsHide:true,encoding:'utf8',timeout:10000});
 if(result.error?.code==='ENOENT')return t.skip('Python unavailable; XLSX requires the configured Python runtime.');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
