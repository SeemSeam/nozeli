// Explicit live qualification: real private Pi owners, Git, files and host repair.
// Loopback scripted Provider only; no credentials, paid models or user projects.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {createNozeliPiSource} from '../src/agents/managed/pi-source.mjs';
import {resolveBundledPiRuntime} from '../src/agents/managed/pi-runtime.mjs';
import {runGit} from '../src/agents/managed/git-runtime.mjs';
import {serve} from './pi-provider.fixture.mjs';

const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-pi-repair-live-'));
const root=path.join(out,'project'),config=path.join(out,'private'),profile=path.join(config,'desktop');
await fs.mkdir(root,{recursive:true});
const original='Original synthetic repair source.\n',candidate='Verified repaired candidate.\n';
await fs.writeFile(path.join(root,'paper.txt'),original);
await fs.writeFile(path.join(root,'.gitignore'),'/.nozeli/\n/build/\n');
const git=async(...args)=>(await runGit(root,args)).toString().trim();
await git('init','-b','main');await git('config','user.name','Synthetic Repair');await git('config','user.email','repair@localhost');await git('add','--all');await git('commit','-m','Synthetic baseline');
const head=await git('rev-parse','HEAD');
const host=new DesktopHost(profile),source=createNozeliPiSource({root:config});
let manager,controller,projectId,lock=null,lockIdentity=null,workerStep=0,dispatches=0,maintenanceTurns=0;
const events=[],owners=new Set(),checks=[],toolReceipts=[],faults=[];
const result={ok:false,out,checks,faults,scope:'Actual DesktopHost/ManagedProjects, private native Pi processes, real Git ref locks and files; scripted loopback provider, no paid model or personal credentials',limitation:'The harness owns and removes the transient Git lock. The scripted Orchestrator only inspects host status and requests the exact captured transaction retry; this is not autonomous model diagnosis or Git repair.'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await pause(25);}throw Error('Timed out: '+label);}
function current(){return [...(controller?.current?.values()??[])].find(job=>job.target==='orchestrator');}
function lastTool(request){const row=request.messages.findLast(message=>message.role==='tool');assert(row,'actual tool response required');const content=typeof row.content==='string'?row.content:row.content.map(part=>part.text??'').join('\n');toolReceipts.push({callId:row.tool_call_id,content});assert(!/nozeli host rejected|"isError":true/.test(content),content);let value;try{value=JSON.parse(content);}catch{return content;}assert.notEqual(value.ok,false,content);return value.value??value;}
async function releaseLock(){if(!lock)return;const stat=await fs.lstat(lock);assert.equal(stat.ino,lockIdentity.ino);assert.equal(stat.dev,lockIdentity.dev);await fs.unlink(lock);lock=null;}
const provider=await serve(async request=>{
 assert(provider.requests.length<24,'no runaway model/repair loop');
 const names=request.tools?.map(tool=>tool.function?.name)??[];
 if(names.includes('nozeli_publish')){
  const step=workerStep++;
  if(step===0)return {id:'repair-read',tool:'nozeli_document_read',args:{relPath:'paper.txt'}};
  if(step===1){const read=lastTool(request);assert.equal(read.text,original);return {id:'repair-edit',tool:'nozeli_document_apply',args:{readHandle:read.readHandle,replacements:[{oldText:original,newText:candidate}]}};}
  if(step===2){lastTool(request);const work=controller.store.state.works[0];assert(work.execution.branchRef);const directory=controller.execution.directory(work.id);await fs.mkdir(path.join(directory,'build'));await fs.writeFile(path.join(directory,'build/delivery.sh'),'#!/bin/sh\nprintf "synthetic ignored output\\n"\n',{mode:0o755});await fs.writeFile(path.join(directory,'build/validation.json'),JSON.stringify({ok:true})+'\n');lock=path.join(work.execution.commonDir,work.execution.branchRef+'.lock');await fs.mkdir(path.dirname(lock),{recursive:true});await fs.writeFile(lock,'owned synthetic publication lock\n',{flag:'wx'});lockIdentity=await fs.lstat(lock);return {id:'repair-publish-once',tool:'nozeli_publish',args:{kind:'result',content:'<h1>Repair-qualified candidate</h1><p>Exact candidate retained; original source unchanged until explicit user acceptance.</p>',files:['paper.txt','build/delivery.sh','build/validation.json']}};}
  throw Error('Worker prompt replayed after publication');
 }
 const job=current();
 if(job?.type==='intake'){
  assert.equal(dispatches++,0,'only one business Work dispatch');
  return {id:'repair-dispatch',tool:'nozeli_dispatch',args:{name:'Real repair lifecycle',brief:'Change paper.txt to the exact candidate through host document tools, publish once and preserve original source until acceptance.'}};
 }
 if(job?.type==='maintenance'){
  maintenanceTurns++;
  const previous=request.messages.findLast(message=>message.role==='tool');
  if(previous?.tool_call_id==='repair-native-status-'+job.id){
   const ledger=lastTool(request),bug=ledger.bugs.find(row=>row.id===job.context.bugId);assert(bug);
   assert.equal(bug.attempts.length,1);assert.equal(bug.attempts[0].status,'unverified');
   if(bug.phase==='publication'){
    assert.equal(await fs.stat(lock).then(()=>true,()=>false),true);
    await releaseLock();
    faults.push({bugId:bug.id,phase:bug.phase,cause:'Real Git ref lock created by fixture',causeOwner:'test harness',action:'Harness removes only its inode-verified transient lock; native Orchestrator requests exact host retry',before:bug});
   }
   return {id:'repair-exact-host-retry-'+job.id,tool:'nozeli_maintenance',args:{action:'retry',bugId:bug.id}};
  }
  if(previous?.tool_call_id==='repair-exact-host-retry-'+job.id){
   const receipt=lastTool(request);assert.equal(receipt.status,job.context.bugId===faults.find(row=>row.phase==='publication')?.bugId?'repaired':'needs-version-fix');
   return {text:'Host receipt is authoritative; no business input or Worker replay. Unresolved internal faults require a version fix.'};
  }
  return {id:'repair-native-status-'+job.id,tool:'nozeli_maintenance',args:{action:'status'}};
 }
 return {text:'Original task and explicit user decisions remain unchanged.'};
});
try{
 await fs.mkdir(source.agentDir,{recursive:true});await fs.writeFile(path.join(source.agentDir,'models.json'),JSON.stringify({providers:{'repair-local':{baseUrl:provider.url,api:'openai-completions',apiKey:'local-nonsecret',models:[{id:'scripted',name:'Scripted Repair',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}]}}}),{mode:0o600});
 source.modelFor=async()=> 'repair-local/scripted';source.roleDefaultsFor=async()=>({selector:'repair-local/scripted',effort:'off'});
 const runtime=await resolveBundledPiRuntime({piHome:source.agentDir});
 manager=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},piSource:source,piRuntime:runtime,idleTimeoutMs:1200});manager.onEvent(event=>{if(event.kind==='managed-error')events.push(event.text);for(const c of manager.controllers.values())for(const session of c.sessions.values())if(session.pid)owners.add(session.pid);});
 await manager.processBudget.save(2);
 const project=(await host.pick(root)).project;projectId=project.id;
 const cold=await manager.invoke('managed.maintenance.status',{projectId});assert.equal(cold.rows.length,0);assert.equal(manager.controllers.size,0);assert.equal(provider.requests.length,0);checks.push('cold repair query uses real storage without creating controller or owner');
 await manager.connect(projectId,{enable:true});controller=manager.controllers.get(projectId);
 // A local original host transaction can recover before any model input. Its
 // exact queued verification must be settled rather than waking the model.
 let hostAttempts=0;const recovered=path.join(out,'host-recovered.txt');
 await controller.maintenanceTransaction(null,'synthetic-host-prepare',async()=>{if(++hostAttempts===1)throw Object.assign(Error('synthetic transient preparation fault'),{code:'SYNTHETIC_TRANSIENT'});await fs.writeFile(recovered,'verified\n',{flag:'wx'});return recovered;},async file=>await fs.readFile(file,'utf8')==='verified\n');
 await until(()=>!controller.kicking&&!controller.running.size,'host-only recovery settlement');assert.equal(provider.requests.length,0);const fast=(await controller.maintenanceStatus()).bugs.find(bug=>bug.phase==='synthetic-host-prepare');assert.equal(fast.status,'repaired');assert.equal(controller.store.state.jobs.filter(job=>job.type==='maintenance'&&job.context?.bugId===fast.id&&job.status==='queued').length,0);checks.push('verified host-first recovery settles exact unadmitted maintenance event with zero model requests');
 faults.push({bugId:fast.id,phase:fast.phase,cause:'Explicit synthetic transient preparation exception',causeOwner:'test harness',action:'Host reruns original callback before model admission',final:fast,executions:hostAttempts});
 const submitted=await controller.enqueue('orchestrator','intake','Real repair lifecycle request');
 await until(()=>controller.store.state.works[0]?.status==='review'&&!controller.running.size&&!controller.kicking,'same Worker publication repair');
 const work=controller.store.state.works[0],bugs=(await controller.maintenanceStatus()).bugs,publication=bugs.find(bug=>bug.phase==='publication');assert(publication);assert.equal(publication.status,'repaired');assert.deepEqual(publication.attempts.map(attempt=>attempt.status),['unverified','verified']);assert.equal(workerStep,3);assert.equal(dispatches,1);assert.equal(controller.store.state.works.length,1);assert.equal(controller.store.state.jobs.filter(job=>job.target===work.id&&job.type==='initial').length,1);assert.equal(controller.store.state.jobs.find(job=>job.id===submitted.jobId).status,'completed');assert.equal(await fs.readFile(path.join(root,'paper.txt'),'utf8'),original);assert.equal(await fs.readFile(path.join(controller.execution.directory(work.id),'paper.txt'),'utf8'),candidate);assert.equal(await git('rev-parse','HEAD'),head);checks.push('real Git ref-lock publication failure repairs exact transaction after one bounded retry without Worker or business replay');
 const page=await manager.invoke('managed.maintenance.status',{projectId,limit:1});assert.equal(page.rows.length,1);assert.equal(page.summary.repaired,2);assert(page.nextCursor);const next=await manager.invoke('managed.maintenance.status',{projectId,limit:1,cursor:page.nextCursor});assert.equal(next.rows.length,1);assert.notEqual(next.rows[0].id,page.rows[0].id);assert(next.rows.every(row=>row.capabilities.retry===false));checks.push('real repair metadata paginates with page-independent summaries and repaired actions disabled');
 const thread=work.threadId;await until(()=>!controller.sessions.has(work.id)&&!controller.reclaiming.has(work.id),'review Worker idle reclamation');assert.equal(controller.store.used(),1);assert.equal(controller.store.find(work.id).threadId,thread);assert.equal(controller.store.find(work.id).status,'review');checks.push('repaired review Worker unloads safely while original Work quota, thread and frozen result remain');
 // Keep a real ref lock present for both bounded repair attempts. This tests
 // escalation, not a production defect or a model-authored source-code fix.
 lock=path.join(work.execution.commonDir,work.execution.branchRef+'.lock');await fs.writeFile(lock,'owned permanent qualification lock\n',{flag:'wx'});lockIdentity=await fs.lstat(lock);
 let permanentExecutions=0;
 await assert.rejects(controller.maintenanceTransaction(null,'qualification-permanent-git-lock',async()=>{permanentExecutions++;return git('update-ref',work.execution.branchRef,head);}),error=>error.code==='MAINTENANCE_PENDING');
 await until(async()=>{const bug=(await controller.maintenanceStatus()).bugs.find(row=>row.phase==='qualification-permanent-git-lock');return bug?.attempts.length===2&&!controller.running.size&&!controller.kicking;},'permanent Git failure bounded escalation');
 const permanent=(await controller.maintenanceStatus()).bugs.find(row=>row.phase==='qualification-permanent-git-lock');assert.equal(permanent.status,'needs-version-fix');assert.deepEqual(permanent.attempts.map(row=>row.status),['unverified','unverified']);assert.equal(permanentExecutions,3);
 await controller.maintenanceRetry(permanent.id);assert.equal(permanentExecutions,3,'exhausted retries never execute again');
 assert.equal(controller.store.state.works.length,1);assert.equal(dispatches,1);assert.equal(workerStep,3);assert.equal(controller.store.state.receipts.filter(row=>row.workId===work.id&&row.kind==='result').length,1);assert.equal(await fs.readFile(path.join(root,'paper.txt'),'utf8'),original);assert.equal(await git('rev-parse','HEAD'),head);
 faults.push({bugId:permanent.id,phase:permanent.phase,cause:'Real Git ref lock deliberately remains present',causeOwner:'test harness',action:'Initial original transaction plus one host-first and one native Orchestrator retry; further retry has no effect',executions:permanentExecutions,final:permanent,limitation:'Injected persistent environmental obstruction exercises internal-failure escalation; no claim of a product defect or autonomous repair.'});
 checks.push('real persistent Git error stops after two failed repair attempts, escalates needs-version-fix and preserves one Work/publication/source');
 const durable=await host.storage.getLocal(projectId,'managed:maintenance');assert.deepEqual(durable,await controller.maintenance.read());for(const fault of faults)fault.final=durable.bugs.find(row=>row.id===fault.bugId);
 await fs.writeFile(path.join(out,'fault-report.json'),JSON.stringify({scope:result.scope,limitation:result.limitation,faults,ledger:durable,toolReceipts,identity:{projectId,workId:work.id,threadId:thread,originalRequestJobId:submitted.jobId,publicationJobId:publication.jobId},receipts:controller.store.state.receipts,jobs:controller.store.state.jobs},null,2));
 checks.push('durable SQLite maintenance ledger matches exact host receipts and saved fault report with original job/Work/thread identities');
 const before=provider.requests.length;await manager.stop();assert.equal(manager.processBudget.used,0);await pause(1400);assert.equal(provider.requests.length,before);for(const pid of owners){assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');}assert.equal(provider.errors.length,0);checks.push('confirmed native cleanup releases capacity with no surviving owned PID or delayed replay');
 result.ok=true;result.requests=provider.requests.length;result.workerRequests=workerStep;result.maintenanceTurns=maintenanceTurns;result.workId=work.id;result.threadId=thread;result.diagnostics=events;
}catch(error){result.error=error.stack;result.diagnostics=events;result.jobs=controller?.store?.state?.jobs?.map(({id,target,type,status,error,maintenanceBugId})=>({id,target,type,status,error,maintenanceBugId}));process.exitCode=1;}
finally{await releaseLock().catch(error=>{result.lockCleanupError=error.message;process.exitCode=1;});await manager?.stop().catch(error=>{result.cleanupError=error.message;process.exitCode=1;});await provider.close();await host.storage.db.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
