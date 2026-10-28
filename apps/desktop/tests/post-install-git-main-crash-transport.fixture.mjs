#!/usr/bin/env node
// Model transport only. No managed IPC overrides, state mutation, Git calls or credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {staticReport} from './static-report.fixture.mjs';

export async function openTransportController(options){
 const {Controller}=await import('./src/agents/managed/controller.mjs');
 return Controller.open({...options,sessionFactory:(spec,target)=>new TransportSession(spec,target),projectHome:async home=>{
  await fs.mkdir(home,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(home,'config.toml'),'# Synthetic transport only; no authentication or user settings\ncheck_for_update_on_startup = false\n');
 }});
}
class TransportSession extends EventEmitter {
 constructor(spec,target){super();Object.assign(this,spec,{target,closed:false,busy:false});}
 async start(id){this.resumed=Boolean(id);this.threadId=id||randomUUID();this.initializeResult={userAgent:'nozeli-main-crash-test-transport'};this.startResult={thread:{id:this.threadId,turns:[]},model:this.model,reasoningEffort:this.effort,approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};return this;}
 async stop(){this.closed=true;}
 async rpc(method){
  if(method==='model/list')return {data:[{model:'gpt-6.1-sol',supportedReasoningEfforts:['low','high'].map(reasoningEffort=>({reasoningEffort}))}]};
  if(method==='thread/resume')return this.startResult;
  if(method==='thread/read')return {thread:this.startResult.thread};
  if(method==='thread/items/list'||method==='thread/turns/list')return {data:[],nextCursor:null};
  if(method==='config/read')return {config:{check_for_update_on_startup:false}};
  if(method==='skills/list')return {data:[]};
  throw Error('unsupported transport read '+method);
 }
 async prompt(prompt){
  this.busy=true;this.hasPrompted=true;
  const entry={at:new Date().toISOString(),target:this.target,threadId:this.threadId,prompt};
  await fs.appendFile(path.join(this.home,'transport-events.jsonl'),JSON.stringify(entry)+'\n');
  const call=(tool,arguments_)=>this.onTool({tool,arguments:arguments_,callId:randomUUID()});
  try{
   if(this.role==='orchestrator'){
    if(prompt.startsWith('主控Git事件'))await call('nozeli_git_checkpoint',{action:'commit',message:'Recovery transport verified owned result'});
    else {const name=prompt.split('原始请求:\n').at(-1).trim();if(!/^(GIT-A|GIT-B|FAIL-C|GIT-D)$/.test(name))throw Error('unexpected fixture task '+name);await call('nozeli_dispatch',{name,brief:'Transport fixture task '+name+'; update '+name+'.txt and report.'});}
   }else if(this.role==='worker'){
    const name=prompt.match(/(?:GIT-A|GIT-B|FAIL-C|GIT-D)/)?.[0];if(!name)throw Error('unbound transport worker prompt');
    if(name==='FAIL-C')throw Error('RECOVERY_TRANSPORT_WORKER_FAILED: no automatic replay allowed');
    const relPath=name+'.txt',read=await call('nozeli_document_read',{relPath});if(!read.ok)throw Error(read.error.message);
    const value=read.value,apply=await call('nozeli_document_apply',{readHandle:value.readHandle,replacements:[{oldText:value.text,newText:name+' result from real Host apply\n'}]});
    if(!apply.ok)throw Error(apply.error.message);
    await call('nozeli_publish',{kind:'result',html:staticReport('# '+name+'\nHost document apply succeeded; recovery transport, not a real model.'),files:[relPath]});
   }else throw Error('frontdesk model input not required by this harness');
   return {completion:'host-control',threadId:this.threadId,turnId:randomUUID(),providerStatus:'completed',text:''};
  }finally{this.busy=false;}
 }
}
// Real PTY client of the production facade; only CLI/model transport is synthetic.
if(process.argv.includes('--remote')){
 const WebSocket=createRequire(import.meta.url)('ws'),url=process.argv[process.argv.indexOf('--remote')+1];
 const socket=new WebSocket(url,{headers:{authorization:'Bearer '+process.env.NOZELI_NATIVE_TOKEN}});
 let next=0;const pending=new Map();
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 socket.on('message',bytes=>{const m=JSON.parse(bytes.toString()),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 socket.on('open',async()=>{try{await rpc('initialize');const threadId=process.argv[process.argv.indexOf('resume')+1];await rpc('thread/resume',{threadId});await rpc('thread/items/list',{threadId});process.stdout.write('Recovery transport native client ready\r\n');}catch(e){process.stderr.write(e.stack+'\n');process.exitCode=1;socket.close();}});
 socket.on('close',()=>process.exit(process.exitCode||0));socket.on('error',e=>{process.stderr.write(e.message+'\n');process.exit(1);});
 process.stdin.resume();process.on('SIGTERM',()=>{socket.close();setTimeout(()=>process.exit(0),100);});
}
