const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','dist','turnover-chart.js'),'utf8');
test('category graph starts empty and requires an explicit choice',()=>{
 assert.match(source,/selectedCategories=new Set\(\)/);
 assert.doesNotMatch(source,/selectedCategories=new Set\(categoryReport\.categories\)/);
 assert.match(source,/Выберите хотя бы одну категорию/);
 assert.match(source,/chart-all-categories/);
});
test('category refresh preserves valid choices and drops missing categories',()=>{
 assert.match(source,/const valid=new Set\(categoryReport\.types\?\.length\?categoryReport\.types\.map\(type=>type\.id\):categoryReport\.categories\)/);
 assert.match(source,/\/api\/order-categories\?/);
 assert.match(source,/mode==='categories'/);
});
test('hierarchy search and selection keep parent and child choices non-overlapping',()=>{
 assert.match(source,/function ancestors\(/);
 assert.match(source,/function descendants\(/);
 assert.match(source,/for\(const parent of ancestors\(id,map\)\)selectedCategories\.delete\(parent\)/);
 assert.match(source,/for\(const child of descendants\(id\)\)selectedCategories\.delete\(child\)/);
 assert.match(source,/chart-category-search/);
 assert.match(source,/types\.filter\(type=>type\.parentId===null\)/);
});
test('marketplaces remain separate and disclose different amount bases',()=>{
 assert.match(source,/item\.market\+'\:'\+id/);
 assert.match(source,/item\.market==='WB'\?'6 4'/);
 assert.match(source,/Ozon использует revenue, WB — priceWithDisc/);
});
