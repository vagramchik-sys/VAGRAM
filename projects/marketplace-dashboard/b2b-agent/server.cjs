'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {Store,atomicWrite}=require('./queue-store.cjs');
const {Runner}=require('./runner.cjs');
const {OneCClient}=require('./onec.cjs');
const {modelStatus,extract}=require('./model.cjs');
const {buildDraft}=require('./core.cjs');

function protect(text,decrypt=false) {
  return new Promise((resolve,reject)=>{
    const command=decrypt?"Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))":"Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',()=>{});child.once('error',()=>reject(Error('Хранилище Windows недоступно')));child.once('close',code=>code?reject(Error('Не удалось сохранить защищённые настройки')):resolve(out));child.stdin.end(text);
  });
}

async function start({port=Number(process.env.B2B_AGENT_PORT||4330),dir=path.join(__dirname,'..','.private','b2b-agent')}={}) {
  fs.mkdirSync(dir,{recursive:true});
  const lockFile=path.join(dir,'process.lock');
  if(fs.existsSync(lockFile)) {
    const pid=Number(fs.readFileSync(lockFile,'utf8'));
    if(!Number.isInteger(pid)||pid<=0)throw Error('Нужна проверка блокировки очереди');
    let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(alive)throw Error('Другой процесс уже использует очередь');
    fs.unlinkSync(lockFile);
  }
  fs.writeFileSync(lockFile,String(process.pid),{flag:'wx',mode:0o600});
  const unlock=()=>{try{if(fs.readFileSync(lockFile,'utf8')===String(process.pid))fs.unlinkSync(lockFile);}catch{}};
  try {
  const store=new Store(dir),configFile=path.join(dir,'connection.dpapi');
  let config={categoryId:'6',newStageId:'',newLeadStatusId:'NEW',leadsEnabled:true,autoDraftEnabled:true,model:'qwen3:4b',sendEnabled:false,pollEnabled:false,pollMinutes:5};
  if(fs.existsSync(configFile))config={...config,...JSON.parse(await protect(fs.readFileSync(configFile,'utf8'),true)),sendEnabled:false,pollEnabled:false};
  let runner;
  function configure(){const {BitrixClient}=require('./bitrix.cjs');runner=new Runner({store,config,crm:config.webhook?new BitrixClient({webhook:config.webhook}):null,oneC:config.oneCUrl?new OneCClient({baseUrl:config.oneCUrl,token:config.oneCToken}):null});}
  configure();
  const origin=`http://127.0.0.1:${port}`,nonce=crypto.randomBytes(32).toString('hex');
  async function save(value=config){atomicWrite(configFile,await protect(JSON.stringify(value)));}
  const server=http.createServer(async(req,res)=>{
    const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
    const json=(status,data)=>{res.writeHead(status,{...headers,'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    if(req.headers.host!==`127.0.0.1:${port}`)return json(403,{error:'Недопустимый адрес'});
    let requestUrl;try{requestUrl=new URL(req.url,origin);}catch{return json(400,{error:'Неверный запрос'});}
    if(req.headers.origin&&req.headers.origin!==origin)return json(403,{error:'Запрос с другой страницы запрещён'});
    if(req.headers['sec-fetch-site']==='cross-site')return json(403,{error:'Запрос с другой страницы запрещён'});
    try {
      const route=requestUrl.pathname;
      if(req.method==='GET'&&['/','/ui.js','/ui.css'].includes(route)) {const file=route==='/'?'index.html':route.slice(1);res.writeHead(200,{...headers,'content-type':route.endsWith('.js')?'text/javascript':route.endsWith('.css')?'text/css':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,'web',file)));}
      if(req.method==='GET'&&route==='/api/state') {
        return json(200,{nonce,busy:runner.busy,config:{categoryId:config.categoryId,newStageId:config.newStageId,newLeadStatusId:config.newLeadStatusId,leadsEnabled:config.leadsEnabled,autoDraftEnabled:config.autoDraftEnabled,model:config.model,pollEnabled:config.pollEnabled,pollMinutes:config.pollMinutes,sendEnabled:false},connections:{crm:!!config.webhook,oneC:!!config.oneCUrl},model:await modelStatus(),cases:Object.values(store.data.cases).map(({body,...r})=>r),events:store.data.events.slice(0,50),lastScan:store.data.lastScan,lastProcess:store.data.lastProcess,blockers:['Автоотправка не включена: нужны доступный почтовый отправитель и проверенная связь CRM с исходными письмами',...(!config.oneCUrl?['Не подключён сервис 1С с ценами, остатками и условиями']:['Адрес 1С сохранён. Данные проверяются при подготовке каждого предложения'])]});
      }
      if(req.method!=='POST')return json(404,{error:'Страница не найдена'});
      if(req.headers['x-b2b-token']!==nonce||req.headers.origin!==origin)return json(403,{error:'Обновите страницу управления'});
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536)return json(413,{error:'Слишком большой запрос'});}
      let data;try{data=JSON.parse(raw||'{}');}catch{return json(400,{error:'Неверный формат запроса'});}
      if(route==='/api/connect') {
        if(runner.busy)throw Error('Дождитесь завершения текущей операции');
        const proposed={...config,webhook:data.webhook||config.webhook,categoryId:String(data.categoryId||config.categoryId),oneCUrl:data.oneCUrl||config.oneCUrl,oneCToken:data.oneCToken||config.oneCToken,model:String(data.model||config.model),sendEnabled:false,pollEnabled:false};
        if(!/^\d+$/.test(proposed.categoryId))throw Error('Неверная воронка');
        const {BitrixClient}=require('./bitrix.cjs');
        if(!proposed.webhook)throw Error('Нужен доступ к Битрикс24 через REST');
        const client=new BitrixClient({webhook:proposed.webhook});
        const stages=await client.listDealStages(proposed.categoryId);
        const stage=stages.find(s=>s.STATUS_ID===data.newStageId);
        if(data.newStageId&&!stage)throw Error('Выбранная стадия отсутствует в воронке');
        proposed.newStageId=stage?stage.STATUS_ID:(proposed.categoryId===config.categoryId&&stages.some(s=>s.STATUS_ID===config.newStageId)?config.newStageId:'');
        if(proposed.oneCUrl)new OneCClient({baseUrl:proposed.oneCUrl,token:proposed.oneCToken});
        await save(proposed);config=proposed;configure();return json(200,{ok:true,stages:stages.map(s=>({id:s.STATUS_ID,name:s.NAME}))});
      }
      if(route==='/api/scan'){return json(200,await runner.scan());}
      if(route==='/api/draft'){await runner.draft(String(data.id));return json(200,{ok:true});}
      if(route==='/api/process'){return json(200,await runner.processBatch({limit:3}));}
      if(route==='/api/leads'||route==='/api/processing') {
        if(runner.busy)throw Error('Дождитесь завершения текущей операции');
        if(typeof data.enabled!=='boolean')throw Error('Нужен режим включено или выключено');
        if(data.enabled&&!config.webhook)throw Error('Сначала подключите CRM');
        const key=route==='/api/leads'?'leadsEnabled':'autoDraftEnabled';
        const proposed={...config,[key]:data.enabled};await save(proposed);config=proposed;configure();return json(200,{ok:true});
      }
      if(route==='/api/demo') {
        const started=Date.now();const extraction=await extract({subject:'Учебный запрос',body:'Здравствуйте! Нужны болты М8х40, оцинкованные. Подскажите наличие. Количество уточню позже.'},config.model);
        return json(200,{synthetic:true,extraction,draft:buildDraft(extraction),elapsedMs:Date.now()-started});
      }
      if(route==='/api/poll') {
        if(runner.busy)throw Error('Дождитесь завершения текущей операции');
        if(data.enabled&&(!config.webhook||!config.newStageId))throw Error('Сначала подключите CRM и выберите стадию');
        const proposed={...config,pollEnabled:data.enabled===true};await save(proposed);config=proposed;configure();return json(200,{ok:true});
      }
      return json(404,{error:'Операция не найдена'});
    }catch(error){json(400,{error:error.message?.includes('http')?'Ошибка подключения. Проверьте настройки.':String(error.message||'Операция не выполнена').slice(0,250)});}
  });
  let timer;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  // Startup is passive; processing creates local drafts, never outgoing mail.
  let cycleRunning=false;
  timer=setInterval(async()=>{
    if(!config.pollEnabled||runner.busy||cycleRunning)return;
    cycleRunning=true;
    try{await runner.scan();if(config.autoDraftEnabled)await runner.processBatch({limit:3});}
    catch{store.event('error',null,'Обновление или разбор очереди не удалось. Проверьте журнал.');}
    finally{cycleRunning=false;}
  },300000);timer.unref();
  server.on('close',()=>{clearInterval(timer);unlock();});
  return {server,store,origin};
  }catch(error){unlock();throw error;}
}
if(require.main===module)start().then(({origin})=>console.log('B2B agent console: '+origin)).catch(()=>{console.error('Не удалось запустить B2B-агента: проверьте порт и защищённые настройки.');process.exitCode=1;});
module.exports={start,protect};
