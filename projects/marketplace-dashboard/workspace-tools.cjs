'use strict';

// These routes share the main Pult server's session and origin checks.
module.exports=function createWorkspaceTools({privateDir}) {
  const ideas=require('./idea-registry.cjs')({privateDir});
  ideas.seedFirstIdea();
  let procurement;
  const purchases=()=>procurement||(procurement=require('./procurement.cjs')({privateDir}));
  const routes=new Set(['/api/ideas','/api/ideas/create','/api/ideas/update','/api/procurement','/api/procurement/parse','/api/procurement/request','/api/procurement/import','/api/procurement/compare']);
  const reply=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  async function body(req) {
    const chunks=[];let bytes=0;
    for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>1500000)throw Object.assign(Error('Слишком большой запрос. Разделите прайс на файлы меньшего размера.'),{public:true,status:413});chunks.push(chunk);}
    const raw=Buffer.concat(chunks).toString('utf8');
    try{return JSON.parse(raw||'{}');}catch{throw Object.assign(Error('Некорректный формат запроса'),{public:true,status:400});}
  }
  async function handle(req,res,url) {
    if(!routes.has(url.pathname))return false;
    try {
      const p=url.pathname;
      if(req.method==='GET'&&p==='/api/ideas')reply(res,200,ideas.read());
      else if(req.method==='POST'&&p==='/api/ideas/create')reply(res,200,ideas.create(await body(req)));
      else if(req.method==='POST'&&p==='/api/ideas/update')reply(res,200,ideas.update(await body(req)));
      else if(req.method==='GET'&&p==='/api/procurement')reply(res,200,purchases().read());
      else if(req.method==='GET'&&p==='/api/procurement/compare')reply(res,200,purchases().compare({requestId:url.searchParams.get('id')}));
      else if(req.method==='POST'&&p==='/api/procurement/parse')reply(res,200,purchases().parseRequest(await body(req)));
      else if(req.method==='POST'&&p==='/api/procurement/request')reply(res,200,purchases().saveRequest(await body(req)));
      else if(req.method==='POST'&&p==='/api/procurement/import')reply(res,200,purchases().importPriceList(await body(req)));
      else reply(res,405,{error:'Метод не поддерживается'});
    }catch(error){reply(res,error.public?error.status||400:500,{error:error.public?error.message:'Не удалось выполнить операцию. Введённые данные можно сохранить повторно после проверки.'});}
    return true;
  }
  return {handle};
};
