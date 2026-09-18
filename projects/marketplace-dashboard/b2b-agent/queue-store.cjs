'use strict';
// Queue persistence implementation only. Runtime records stay under .private.
const fs=require('node:fs');
const path=require('node:path');

function atomicWrite(file, text) {
  const tmp=file+'.tmp',fd=fs.openSync(tmp,'w',0o600);
  try {fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  // Windows scanners can briefly hold a renamed destination. Keep the previous
  // file intact and retry only transient sharing errors; never unlink it first.
  for(let attempt=0;;attempt++) {
    try{fs.renameSync(tmp,file);return;}catch(error){
      if(!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=5)throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20*(attempt+1));
    }
  }
}

class Store {
  constructor(dir) {
    this.dir=dir; fs.mkdirSync(dir,{recursive:true}); this.file=path.join(dir,'queue.json');
    this.data=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,cases:{},events:[],lastScan:null};
    if (this.data.version!==1 || !this.data.cases || !Array.isArray(this.data.events)) throw Error('Формат очереди не поддерживается');
    for(const row of Object.values(this.data.cases)) if(row.status==='sending') { row.status='uncertain'; row.reasons=['После остановки неизвестен результат отправки. Нужна сверка с почтой.']; }
    this.save();
  }
  save() { atomicWrite(this.file,JSON.stringify(this.data,null,2)); }
  event(kind,caseId,message) { this.data.events.unshift({kind,caseId,message,at:new Date().toISOString()}); this.data.events=this.data.events.slice(0,500); this.save(); }
}

module.exports={Store,atomicWrite};
