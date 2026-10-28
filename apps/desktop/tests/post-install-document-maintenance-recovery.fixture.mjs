#!/usr/bin/env node
// Synthetic provider transport only; all lifecycle, approvals, writes and Git are production.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {staticReport} from './static-report.fixture.mjs';
export async function openRecoveryController(options){
 const {Controller}=await import('./src/agents/managed/controller.mjs');
 return Controller.open({...options,sessionFactory:(spec,target)=>new RecoverySession(spec,target),projectHome:async home=>{await fs.mkdir(home,{recursive:true});await fs.writeFile(path.join(home,'config.toml'),'check_for_update_on_startup = false\n');}});
}
class RecoverySession extends EventEmitter{
 constructor(spec,target){super();Object.assign(this,spec,{target,busy:false});}
 async start(id){this.threadId=id||randomUUID();this.initializeResult={userAgent:'nozeli-document-recovery-transport'};this.startResult={thread:{id:this.threadId,turns:[]},model:this.model,reasoningEffort:this.effort,approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};return this;}
 async stop(){}
 async rpc(method){if(method==='model/list')return {data:[{model:'gpt-6.1-sol',supportedReasoningEfforts:['low','high'].map(reasoningEffort=>({reasoningEffort}))}]};if(method==='thread/resume'||method==='thread/read')return this.startResult;if(method==='thread/items/list'||method==='thread/turns/list')return {data:[],nextCursor:null};if(method==='config/read')return {config:{check_for_update_on_startup:false}};if(method==='skills/list')return {data:[]};throw Error('Unexpected fixture RPC '+method);}
 async prompt(prompt){
  this.busy=true;const call=(tool,arguments_)=>this.onTool({tool,arguments:arguments_,callId:randomUUID()});await fs.appendFile(path.join(this.home,'recovery-fixture-events.jsonl'),JSON.stringify({role:this.role,prompt})+'\n');
  try{
   if(this.role==='worker'){
    const read=await call('nozeli_document_read',{relPath:'label.mjs'});if(!read.ok)throw Error(read.error.message);
    if(prompt.startsWith('执行已细化任务')){const text=await fs.readFile(path.join(this.cwd,'fixture-label-source.txt'),'utf8');const applied=await call('nozeli_document_apply',{readHandle:read.value.readHandle,replacements:[{oldText:read.value.text,newText:text}]});if(!applied.ok)throw Error(applied.error.message);}
    await call('nozeli_publish',{kind:'result',html:staticReport('已核查 label.mjs；恢复核查没有修改实现或文档。用户提供测试记录，非Host执行证明。文档维护待主控。'),files:['label.mjs']});
   }else if(this.role==='orchestrator'&&prompt.startsWith('用户已明确')){
    const context=JSON.parse(prompt.split('\n')[2]),recovered=context.revision===2;await call('nozeli_curate',{summary:'## 用户结论\n'+(recovered?'用户已认可第二版核查结果；依据显式测试记录维护文档。':'旧fixture归纳：尚未收到用户测试记录。')+'\n\n## 依据与限制\n用户提供的记录不等于Host执行证明。'});
    if(recovered)for(const [rel,sentinel] of [['README.md','KEEP_README_SENTINEL'],['docs/usage.md','KEEP_DOCS_SENTINEL']]){const read=await call('nozeli_maintenance_read',{scope:'project-document',path:rel});await call('nozeli_maintenance_write',{readHandle:read.readHandle,newMarkdown:read.text+'\n用户提供测试记录：运行 node verify.mjs；formatLabel(" Ada ") 返回 Result: Ada。\n',reason:'Maintain explicitly bound documentation from user-supplied test record; preserve '+sentinel});}
    await call('nozeli_maintenance_complete',{reason:recovered?'Both scoped usage documents maintained':'No user test record in initial fixture closure'});
   }else if(this.role==='orchestrator'&&prompt.startsWith('主控Git事件')){const context=JSON.parse(prompt.split('\n')[1]);await call('nozeli_git_checkpoint',{action:context.revision===2&&context.facts.reviewApproval.status==='accepted'?'commit':'skip',message:'Fixture event decision; final owned documentation checkpoint'});}
   else if(this.role==='orchestrator')await call('nozeli_dispatch',{name:'文档维护验收',brief:'Worker only label.mjs; after user acceptance Orchestrator maintains README.md and docs/usage.md.'});
   else throw Error('No frontdesk prompt allowed in recovery fixture');
   return {threadId:this.threadId,turnId:randomUUID(),completion:'host-control',providerStatus:'completed',text:''};
  }finally{this.busy=false;}
 }
}

if(process.argv.includes('--remote')){
 const WebSocket=createRequire(import.meta.url)('ws'),url=process.argv[process.argv.indexOf('--remote')+1],socket=new WebSocket(url,{headers:{authorization:'Bearer '+process.env.NOZELI_NATIVE_TOKEN}});let next=0;const pending=new Map();
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 socket.on('message',bytes=>{const m=JSON.parse(bytes.toString()),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 socket.on('open',async()=>{try{await rpc('initialize');const threadId=process.argv[process.argv.indexOf('resume')+1];await rpc('thread/resume',{threadId});await rpc('thread/items/list',{threadId});process.stdout.write('Recovery fixture native transport ready\r\n');}catch(e){process.stderr.write(e.stack+'\n');process.exitCode=1;socket.close();}});
 socket.on('close',()=>process.exit(process.exitCode||0));socket.on('error',e=>{process.stderr.write(e.message+'\n');process.exit(1);});process.stdin.resume();process.on('SIGTERM',()=>{socket.close();setTimeout(()=>process.exit(0),100);});
}
