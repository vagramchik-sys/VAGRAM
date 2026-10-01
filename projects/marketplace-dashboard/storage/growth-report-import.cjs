'use strict';
const path = require('node:path');
const {execFile} = require('node:child_process');
const {canonicalProductUrl} = require('./growth-watchlist.cjs');
class GrowthImportError extends Error { constructor(message) { super(message); this.code='INVALID_REPORT'; this.status=400; } }
const fail = text => { throw new GrowthImportError(text); };
const normalize = value => String(value??'').trim().toLowerCase().replace(/ё/g,'е').replace(/[\s\u00a0]+/g,' ');
function number(value) {
  const text=String(value??'').trim().replace(/[\s\u00a0₽%]/g,'').replace(',','.');
  if (!text || ['—','-','нетданных'].includes(text.toLowerCase())) return null;
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const result=Number(text); return Number.isFinite(result)&&result<=1e9?result:null;
}
function parseDelimited(text) {
  // Only unquoted separators in the first nonblank record determine the format.
  const separators={'\t':0,';':0,',':0};let inQuotes=false,hasValue=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(inQuotes&&text[i+1]==='"')i++;else inQuotes=!inQuotes;}else if(!inQuotes&&c==='\n'){if(hasValue)break;}else if(!inQuotes&&Object.hasOwn(separators,c)){separators[c]++;hasValue=true;}else if(c.trim())hasValue=true;}
  const delimiter=Object.keys(separators).sort((a,b)=>separators[b]-separators[a])[0];
  const rows=[], row=[]; let field='', quoted=false;
  for(let i=0;i<=text.length;i++) {
    const char=text[i];
    if(char==='"') { if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted; }
    else if(!quoted&&(char===delimiter||char==='\n'||char===undefined)) { row.push(field.replace(/\r$/,''));field='';if(char!==delimiter){rows.push(row.splice(0));if(rows.length>10020)fail('В отчёте слишком много строк.');} }
    else field+=char;
    if(field.length>12000||row.length>128)fail('Слишком большая ячейка или слишком много колонок.');
  }
  if(quoted)fail('В CSV не закрыты кавычки.');
  return rows;
}
function reportRows(sheets) {
  for(const rows of sheets) {
    const index=rows.findIndex(row=>row.some(c=>normalize(c)==='название товара')&&row.some(c=>normalize(c)==='ссылка на товар'));
    if(index<0)continue;
    const headers=rows[index].map(normalize), find=(...names)=>headers.findIndex(value=>names.includes(value));
    const name=find('название товара'), url=find('ссылка на товар'), seller=find('продавец'), brand=find('бренд');
    const avg=find('средняя цена, ₽','средняя цена'), min=find('минимальная цена, ₽','самая низкая цена','минимальная цена');
    const units=find('заказано, штуки','заказано товаров'), drr=find('доля рекламных расходов, %','дрр');
    const output=[],seen=new Set(); let skipped=0;
    for(const row of rows.slice(index+1)) {
      if(!String(row[url]||'').trim())continue;
      let canonical;try{canonical=canonicalProductUrl(String(row[url]).trim());}catch{skipped++;continue;}
      if(seen.has(canonical.id)){skipped++;continue;}seen.add(canonical.id);
      const title=String(row[name]||'').trim();if(!title||title.length>300){skipped++;continue;}
      const ordered=number(row[units]);
      output.push({...canonical,name:title,seller:String(row[seller]||'').slice(0,200),brand:String(row[brand]||'').slice(0,120),historical:{averagePrice:number(row[avg]),minimumPrice:number(row[min]),orderedUnits:Number.isSafeInteger(ordered)?ordered:null,drrPct:number(row[drr])}});
    }
    if(!output.length)fail('В таблице не найдены карточки Ozon.');
    return {rows:output,skipped,reportInfo:rows.slice(0,index).filter(row=>row.length).map(row=>row.slice(0,2)),requiresPeriod:true,message:'Цены и ДРР относятся к периоду отчёта. Это не текущая цена покупателя. Проверьте даты периода перед сохранением метрик.'};
  }
  fail('Не найдены колонки «Название товара» и «Ссылка на товар». Загрузите отчёт «Товары на Ozon».');
}
function readXlsx(buffer) {
  return new Promise((resolve,reject)=>{
    const python=process.env.PULT_PYTHON||(process.env.USERPROFILE&&path.join(process.env.USERPROFILE,'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe'))||'python';
    const child=execFile(python,[path.resolve(__dirname,'../scripts/growth-report-read.py')],{windowsHide:true,timeout:20000,maxBuffer:20*1024*1024,encoding:'utf8'},(error,stdout)=>{let value;try{value=JSON.parse(stdout);}catch{}if(error||value?.ok!==true)return reject(new GrowthImportError('Не удалось прочитать XLSX. Проверьте файл или сохраните таблицу в CSV.'));resolve(value.sheets);});
    child.stdin.on('error',()=>{});child.stdin.end(buffer);
  });
}
async function previewReport(value,{extract=readXlsx,now=Date.now}={}) {
  if(!value||!['xlsx','csv','tsv'].includes(value.format))fail('Поддерживаются XLSX, CSV и TSV.');
  let sheets;
  if(value.format==='xlsx') {
    if(typeof value.base64!=='string'||value.base64.length>12*1024*1024||value.base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64))fail('Некорректный XLSX.');
    const buffer=Buffer.from(value.base64,'base64');if(buffer.length>8*1024*1024)fail('Файл должен быть не более 8 МБ.');
    sheets=await extract(buffer);
  } else {if(typeof value.text!=='string'||Buffer.byteLength(value.text)>8*1024*1024)fail('Файл должен быть не более 8 МБ.');sheets=[parseDelimited(value.text.replace(/^\uFEFF/,''))];}
  return {...reportRows(sheets),observedAt:new Date(Number(now())).toISOString()};
}
module.exports={previewReport,reportRows,parseDelimited,GrowthImportError};
