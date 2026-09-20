const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','dist','turnover-chart.js'),'utf8');
test('category graph starts empty and requires an explicit choice',()=>{
 assert.match(source,/selectedCategories=new Set\(\)/);
 assert.doesNotMatch(source,/selectedCategories=new Set\(categoryReport\.categories\)/);
 assert.match(source,/Выберите хотя бы одну категорию/);
 assert.match(source,/chart-all-categories/);
});
test('category refresh preserves valid choices and drops missing categories',()=>{
 assert.match(source,/for\(const name of \[\.\.\.selectedCategories\]\)if\(!categoryReport\.categories\.includes\(name\)\)selectedCategories\.delete\(name\)/);
 assert.match(source,/\/api\/order-categories\?/);
 assert.match(source,/mode==='categories'/);
});
test('marketplaces remain separate and disclose different amount bases',()=>{
 assert.match(source,/item\.market\+'\:'\+item\.category/);
 assert.match(source,/item\.market==='WB'\?'6 4'/);
 assert.match(source,/Ozon использует revenue, WB — priceWithDisc/);
});

