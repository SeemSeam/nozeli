import fs from 'node:fs/promises';
import path from 'node:path';
import {atomicJson} from './workspace.mjs';

export function validateAgentLimit(value,{project=false}={}){
 const min=project?1:2,max=project?16:64;
 if(!Number.isSafeInteger(value)||value<min||value>max)throw Object.assign(Error(`${project?'项目 Worker':'全局 Agent'}数量必须为 ${min}–${max} 的整数`),{code:'INVALID_AGENT_LIMIT'});
 return value;
}

// Reservations are synchronous: no pair of project starts can observe the same slot.
// A slot describes a native owner, including its idle time and unconfirmed cleanup.
export class AgentProcessBudget {
 constructor({limit=8,file=null,onAvailable=()=>{},persist=atomicJson}={}){
  this.limit=validateAgentLimit(limit);this.file=file;this.onAvailable=onAvailable;this.persist=persist;this.slots=new Set();this.serial=Promise.resolve();
 }
 get used(){return this.slots.size;}
 get available(){return this.used<Math.min(this.limit,this.pendingLimit??this.limit);}
 restoreSlot(projectId,target){return [...this.slots].find(slot=>slot.projectId===projectId&&slot.target===target&&slot.restored)??Object.assign(this.reserve(projectId,target,{restored:true}),{restored:true});}
 reserve(projectId,target,{restored=false}={}){
  if(!restored&&!this.available)throw Object.assign(Error(`全局 Agent 进程名额已满（${this.used}/${this.limit}）；请结束其他 Agent 或提高统一设置中的全局数量，已接受工作保留排队。`),{code:'AGENT_PROCESS_LIMIT',target});
  const slot={projectId,target,state:restored?'unconfirmed':'starting'};this.slots.add(slot);return slot;
 }
 release(slot){if(this.slots.delete(slot))this.onAvailable();}
 bind(slot,session){
  const stop=session.stop.bind(session);let spawned=Boolean(session.pid);
  session.on?.('exit',()=>{slot.state='unconfirmed';});
  session.stop=async(...args)=>{
   try{const receipt=await stop(...args);if(receipt?.confirmationComplete===true||(!spawned&&!session.pid&&!session.groupRecord?.pid))this.release(slot);else slot.state='unconfirmed';return receipt;}
   catch(error){if(error.exitReceipt?.confirmationComplete===true||session.lastExitReceipt?.confirmationComplete===true||!spawned&&!session.pid&&!session.groupRecord?.pid)this.release(slot);else slot.state='unconfirmed';throw error;}
  };
  return {spawned:()=>{spawned=true;slot.state='live';},hasSpawned:()=>spawned||Boolean(session.pid||session.groupRecord?.pid),started:()=>{slot.state='live';}};
 }
 agents(){return [...this.slots].map(slot=>({...slot}));}
 async load(){
  if(!this.file)return;
  try{const value=JSON.parse(await fs.readFile(this.file,'utf8'));this.limit=validateAgentLimit(value.globalLimit);}
  catch(error){if(error.code!=='ENOENT')throw error;}
 }
 save(limit,apply=async()=>{},rollback=async()=>{}){
  validateAgentLimit(limit);
  const operation=this.serial.catch(()=>{}).then(async()=>{
   if(limit<this.used)throw Object.assign(Error(`全局数量不能低于当前占用 ${this.used}`),{code:'AGENT_LIMIT_IN_USE'});
   this.pendingLimit=limit;const previous=this.limit;let written=false;
   try{
    if(this.file){await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});await this.persist(this.file,{schema:1,globalLimit:limit});written=true;}
    await apply();this.limit=limit;
   }catch(error){await rollback();if(written)try{await this.persist(this.file,{schema:1,globalLimit:previous});}catch(restoreError){error.rollbackError=restoreError;this.limit=limit;}throw error;}
   finally{delete this.pendingLimit;this.onAvailable();}
  });this.serial=operation;return operation;
 }
}
