import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';

const unavailable=(code,message)=>Object.assign(Error(message),{code});
const unknown=(file,operationIds,cause)=>Object.assign(Error('存储结果待核查；存储线程已隔离，禁止自动重投'),{code:'STORAGE_RESULT_UNKNOWN',cause,commitUnknown:{file},file,operationIds});

export class StorageDatabase {
 constructor({timeoutMs=8000,workerFactory=()=>new Worker(new URL('./storage-worker.mjs',import.meta.url))}={}){this.timeoutMs=timeoutMs;this.workerFactory=workerFactory;this.sequence=0;this.channels=new Map();this.quarantined=new Map();this.reconciliations=new Set();this.closed=false;}
 channel(file){
  if(this.closed)throw unavailable('STORAGE_CLOSED','存储已关闭');
  if(this.quarantined.has(file))throw this.quarantined.get(file);
  if(this.reconciliations.has(file))throw unavailable('STORAGE_RECONCILING','数据库正在核查');
  let channel=this.channels.get(file);
  if(channel){if(channel.closing)throw unavailable('STORAGE_CLOSING','存储正在关闭');return channel;}
  const worker=this.workerFactory();channel={worker,pending:new Map(),closing:false,exited:false};this.channels.set(file,channel);worker.unref();
  worker.on('message',m=>{if(channel.unknown)return;const p=channel.pending.get(m.id);if(!p)return;this.settle(channel,m.id,m.error?Object.assign(Error(m.error.message),{code:m.error.code,operationId:p.operationId}):null,m.value);});
  worker.on('error',error=>{void this.quarantine(file,channel,error);});
  worker.on('exit',code=>{channel.exited=true;if(!channel.stopping||channel.pending.size)void this.quarantine(file,channel,Error('存储线程退出: '+code));if(this.channels.get(file)===channel)this.channels.delete(file);});
  return channel;
 }
 settle(channel,id,error,value){const p=channel.pending.get(id);if(!p)return;channel.pending.delete(id);clearTimeout(p.timer);if(error)p.reject(error);else p.resolve(value);p.done();if(!channel.pending.size)channel.worker.unref();}
 stop(file,channel){
  if(channel.stopPromise)return channel.stopPromise;
  channel.stopping=true;
  const terminated=Promise.resolve().then(()=>channel.exited?undefined:channel.worker.terminate()).then(()=>{channel.exited=true;if(this.channels.get(file)===channel)this.channels.delete(file);});
  channel.stopPromise=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(unavailable('STORAGE_RESULT_UNKNOWN','存储线程停止未确认')),this.timeoutMs);terminated.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
  return channel.stopPromise;
 }
 quarantine(file,channel,cause){
  if(channel.exited&&this.channels.get(file)!==channel)return Promise.resolve();
  if(channel.quarantinePromise)return channel.quarantinePromise;
  channel.closing=true;channel.unknown=unknown(file,[...new Set([...channel.pending.values()].map(p=>p.operationId))],cause);
  this.quarantined.set(file,channel.unknown);
  // Settlement cannot depend on terminate completing; retain the fence until actual exit.
  channel.quarantinePromise=this.stop(file,channel).catch(()=>({closed:false,code:'STORAGE_RESULT_UNKNOWN',file,operationIds:channel.unknown.operationIds}));
  for(const [id,p]of channel.pending)this.settle(channel,id,Object.assign(Error(channel.unknown.message),{code:'STORAGE_RESULT_UNKNOWN',cause,commitUnknown:{file,operationId:p.operationId},operationId:p.operationId,file}));
  return channel.quarantinePromise;
 }
 request(file,op,args={}){
  if(op==='close')return this.closeFile(file);
  let channel;try{channel=this.channel(file);}catch(error){return Promise.reject(error);}
  const id=++this.sequence,operationId=args.operationId??randomUUID();
  return new Promise((resolve,reject)=>{
   let done;const settled=new Promise(finish=>{done=finish;});
   const timer=setTimeout(()=>void this.quarantine(file,channel,Error('deadline exceeded')),this.timeoutMs);
   channel.pending.set(id,{resolve,reject,timer,operationId,done,settled});
   try{channel.worker.ref();channel.worker.postMessage({id,file,op,args:{...args,operationId}});}catch(error){void this.quarantine(file,channel,error);}
  });
 }
 closeFile(file){
  const channel=this.channels.get(file);if(!channel)return Promise.resolve();
  if(channel.closePromise)return channel.closePromise;
  // Seal admission before the first await; accepted replies and deadlines remain active.
  channel.closing=true;
  channel.closePromise=Promise.all([...channel.pending.values()].map(p=>p.settled)).then(()=>channel.quarantinePromise??this.stop(file,channel).catch(error=>this.quarantine(file,channel,error)));
  return channel.closePromise;
 }
 invalidate(file){const channel=this.channels.get(file);if(channel)return this.quarantine(file,channel,Error('project generation invalidated'));if(!this.quarantined.has(file))this.quarantined.set(file,unknown(file,[],Error('project generation invalidated')));return Promise.resolve();}
 async reconcile(file,operationId){
  if(this.channels.has(file))throw Error('原存储线程尚未退出');
  if(this.reconciliations.has(file))throw unavailable('STORAGE_RECONCILING','数据库正在核查');
  this.reconciliations.add(file);
  let fresh;
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('数据库不可核查');fresh=new StorageDatabase({timeoutMs:this.timeoutMs,workerFactory:this.workerFactory});return await fresh.request(file,'receipt',{operationId,mustExist:true});}
  finally{try{await fresh?.close();}finally{const live=fresh?.channels.get(file);if(live&&!live.exited)live.worker.once('exit',()=>this.reconciliations.delete(file));else this.reconciliations.delete(file);}}
 }
 // Without a quarantine every accepted operation already settled with a known
 // outcome, so recovery is an idempotent no-op that must not fault a healthy
 // live worker; a quarantined file stays fenced until its generation truly exits.
 async recover(file){const quarantine=this.quarantined.get(file);if(!quarantine)return {recovered:false,operations:[]};if(this.channels.has(file))throw Error('原存储线程尚未退出');const before=await fs.lstat(file);if(!before.isFile()||before.isSymbolicLink())throw Error('数据库身份不可核查');const operations=[];for(const operationId of quarantine.operationIds??[])operations.push({operationId,receipt:await this.reconcile(file,operationId)});const after=await fs.lstat(file);if(before.dev!==after.dev||before.ino!==after.ino)throw Error('数据库身份在核查期间改变');if(this.quarantined.get(file)===quarantine)this.quarantined.delete(file);return {recovered:true,operations};}
 close(){this.closed=true;return Promise.all([...this.channels.keys()].map(file=>this.closeFile(file)));}
}
