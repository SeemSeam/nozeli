import {openTestController} from './project-storage.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
const audit=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-post-install-recovery-'));
console.log('RECOVERY_AUDIT_ROOT='+audit);
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:10000}).trim();
const sources=['src/agents/managed/controller.mjs','src/agents/managed/workspace.mjs','src/agents/managed/git-service.mjs','src/agents/managed-projects.mjs','tests/managed-post-install-recovery.test.mjs'];
async function hashes(){const out={};for(const p of sources)out[p]=hash(await fs.readFile(new URL('../'+p,import.meta.url)));return out;}
await fs.writeFile(path.join(audit,'source-hashes.json'),JSON.stringify(await hashes(),null,2));
async function wait(c,p){const end=Date.now()+15000;while(Date.now()<end){if(p()&&!c.running.size)return;await new Promise(r=>setTimeout(r,10));}throw Error('queue timeout '+JSON.stringify(c.snapshot()));}
async function fixture(t,{failWorker=false,checkpoint=async()=>{}}={}){
 const root=await fs.mkdtemp(path.join(audit,'case-')),project=path.join(root,'project'),runtime=path.join(root,'runtime');await fs.mkdir(project);for(const p of ['A.txt','B.txt','user.txt'])await fs.writeFile(path.join(project,p),'baseline\n');git(project,'init','-q');git(project,'config','user.name','Recovery fixture');git(project,'config','user.email','fixture@example.invalid');git(project,'add','.');git(project,'commit','-qm','baseline');
 let c,manager;const calls=[];
 // Provider fixture only: routing/publication use production callbacks/queue. Files/Git/hooks/index are real.
 class Session{
  constructor(spec,target){Object.assign(this,spec,{target,closed:false});this.toolsDigest=hash(JSON.stringify(spec.tools));}
  async preflightToolsDigest(expected){assert.equal(expected,this.toolsDigest,'historical fixture tool schema');return {compatible:true,expectedDigest:expected,toolsDigest:this.toolsDigest};}
  async assertToolsDigest(expected){assert.equal(expected,this.toolsDigest,'registered fixture tool schema');}
  async start(id){this.threadId=id||randomUUID();this.sessionFile=path.join(this.home,'sessions',this.threadId+'.jsonl');await fs.mkdir(path.dirname(this.sessionFile),{recursive:true});if(!id)await fs.writeFile(this.sessionFile,JSON.stringify({type:'session',id:this.threadId})+'\n');else assert.equal(JSON.parse((await fs.readFile(this.sessionFile,'utf8')).split('\n')[0]).id,id);}
  async stop(){this.closed=true;return {exited:true,confirmationComplete:true};}
  async prompt(){
   this.hasPrompted=true;const job=c.current.get(this.target);calls.push({jobId:job.id,type:job.type,target:this.target});const call=(tool,arguments_)=>this.onTool({tool,arguments:arguments_,callId:randomUUID()});
   if(job.type==='intake')await call('nozeli_dispatch',{name:job.text,brief:'Change named file'});
   else {if(failWorker)throw Error('fixture interrupted after observable file write risk');const w=c.store.find(this.target),file=w.name+'.txt';const read=await call('nozeli_document_read',{relPath:file});assert.equal(read.ok,true);const edited=await call('nozeli_document_apply',{readHandle:read.value.readHandle,edits:[{from:0,to:read.value.text.length,insert:w.name+' result\n',expected:read.value.text}]});assert.equal(edited.ok,true);await call('nozeli_publish',{kind: 'result', html: staticReport('Verified fixture '+w.name+' result'), files: [file]});}
   return {completion:'host-control',threadId:this.threadId};
  }
 }
 const options={runtimeRoot:runtime,contentRoot:project,checkpoint,sessionFactory:(spec,target)=>new Session(spec,target)};
 async function open(){c=await openTestController(options);c.on('diagnostic',x=>calls.push({diagnostic:x}));await c.start();manager?.controllers.set(c.projectId,c);}
 await open();
 const projectId=c.projectId,storage=c.store.storage;
 const requireProject=async id=>{if(id!==projectId)throw Error('unknown project');return storage.requireOnline(id);};
 const host={storage,requireProject,requireRegisteredProject:async id=>{if(id!==projectId)throw Error('unknown project');return storage.requireRegistered(id);}};
 manager=new ManagedProjects({userDataDir:root,host,legacy:{projects:new Map()}});manager.controllers.set(projectId,c);
 async function save(label){await fs.mkdir(path.join(root,label),{recursive:true});await fs.writeFile(path.join(root,label,'state.json'),JSON.stringify(c.snapshot(),null,2));await fs.writeFile(path.join(root,label,'calls.json'),JSON.stringify(calls,null,2));await fs.writeFile(path.join(root,label,'git-log.txt'),git(project,'log','--format=fuller','--stat'));await fs.copyFile(path.join(project,'.git/index'),path.join(root,label,'index.bin'));}
 t.after(async()=>{await save('final');await c.stop();});
 console.log(JSON.stringify({test:t.name,root,provider:'fixture',git:'real'}));
 return {root,project,projectId,runtime,calls,manager,get c(){return c;},save,async work(name='A'){await c.submitTask(name,{requestKey:'task-'+randomUUID()});await wait(c,()=>c.store.state.works.some(w=>w.name===name&&['review','paused'].includes(w.status))&&!c.store.state.jobs.some(j=>['queued','running'].includes(j.status)));return c.store.state.works.find(w=>w.name===name);},todo(w,kind='recovery'){return c.store.state.todos.findLast(t=>t.workId===w.id&&t.kind===kind&&t.status==='open');},payload(w,todo,key=randomUUID()){return {projectId,todoId:todo.id,workId:w.id,revision:todo.revision,sourceJob:todo.sourceJobId,requestKey:key};},invoke(kind,p){assert.equal(kind,'recovery');return manager.invoke('managed.recovery.resolve',p);},async reopen(){await c.stop();await open();}};
}
const opts={timeout:30000};
// Compare persisted consumer facts, not optional in-memory keys lost in JSON storage.
const jobHistory=jobs=>JSON.stringify(jobs.map(({id,key,target,type,text,context,revision,status,threadId,routing,promptStartedAt,startedAt,finishedAt})=>({id,key,target,type,text,context,revision,status,threadId,routing,promptStartedAt,startedAt,finishedAt})));
const reportHistory=receipts=>JSON.stringify(receipts);
async function hook(f){await fs.writeFile(path.join(f.project,'.git/hooks/pre-commit'),'#!/bin/sh\necho RECOVERY_HOOK_DENIED >&2\nexit 7\n',{mode:0o755});}
test('recovery is explicit original-thread inspection, never replays original provider input',opts,async t=>{const f=await fixture(t,{failWorker:true}),w=await f.work(),todo=f.todo(w,'recovery'),p=f.payload(w,todo),before=f.calls.filter(x=>x.type==='initial').length;const result=await f.invoke('recovery',p);assert.equal(result.status,'inspection-required');assert.equal(result.threadId,w.threadId);assert.equal(result.automaticReplay,false);assert.equal(result.requiresExplicitSupplement,true);await f.reopen();assert.deepEqual(await f.invoke('recovery',p),result);assert.equal(f.calls.filter(x=>x.type==='initial').length,before);assert.equal(f.c.store.find(w.id).status,'paused');});
test('stale cross-project cross-Work missing-source closing ended busy draft and pending supplement refuse',opts,async t=>{
 const f=await fixture(t,{failWorker:true}),w=await f.work(),todo=f.todo(w,'recovery'),base=f.payload(w,todo);
 await assert.rejects(f.invoke('recovery',{...base,projectId:'other'}),/unknown project/);
 for(const patch of [{workId:'other'},{revision:0},{sourceJob:'missing'}])assert.equal((await f.invoke('recovery',{...base,...patch,requestKey:randomUUID()})).accepted,false);
 for(const status of ['closing','ended','running']){
  await f.c.store.mutate(()=>{f.c.store.find(w.id).status=status;});
  assert.equal((await f.invoke('recovery',{...base,requestKey:randomUUID()})).error.code,'BUSY');
 }
 await f.c.store.mutate(()=>{f.c.store.find(w.id).status='paused';});await f.c.setDraft(w.id,'unsent');
 assert.equal((await f.invoke('recovery',{...base,requestKey:randomUUID()})).error.code,'DRAFT_CONFLICT');await f.c.setDraft(w.id,'');
 await f.manager.markUnavailable(f.projectId,{code:'PROJECT_UNAVAILABLE',message:'fixture source unavailable'});
 assert.equal(f.manager.controllers.has(f.projectId),false,'unavailability disposes the controller');
 await f.reopen();assert.equal(f.manager.controller(f.projectId),f.c,'explicit reload restores the online controller');
 // Hold only queue scheduling: the online controller must still enforce pending-input admission.
 const kick=f.c.kick;f.c.kick=()=>{};
 try{
  await f.c.send(w.id,'explicit supplement');
  assert.equal((await f.invoke('recovery',{...base,requestKey:randomUUID()})).error.code,'BUSY');
  await f.c.store.mutate(()=>{for(const j of f.c.store.state.jobs)if(j.status==='queued')j.status='cancelled';delete f.c.store.state.todos.find(t=>t.id===todo.id).sourceJobId;});
  assert.equal((await f.invoke('recovery',{...base,requestKey:randomUUID()})).error.code,'MISSING_SOURCE');
  assert.equal(f.todo(w,'recovery').status,'open');
 }finally{f.c.kick=kick;}
});

test('repaired acceptance hook retries once without jobs or changing original reports',opts,async t=>{
 const f=await fixture(t);await hook(f);const w=await f.work(),jobs=jobHistory(f.c.store.state.jobs),reports=reportHistory(f.c.store.state.receipts);
 const binding=(await f.manager.disposition(f.projectId,w.id)).binding,requestKey='accept-'+randomUUID();
 const first=await f.manager.invoke('managed.end',{projectId:f.projectId,workId:w.id,revision:w.revision,decision:'accept',binding,requestKey});
 assert.equal(first.closure.phase,'blocked');assert.match(first.closure.error,/RECOVERY_HOOK_DENIED/);assert.equal(git(f.project,'rev-list','--count','HEAD'),'1');
 const rejected=await f.c.execution.readManifest(w.id);assert.equal(rejected.acceptancePreparation.status,'rejected');
 await fs.unlink(path.join(f.project,'.git/hooks/pre-commit'));
 const retry={projectId:f.projectId,workId:w.id,binding,requestKey:'retry-'+randomUUID()};
 const [a,b]=await Promise.all([f.manager.invoke('managed.retry',retry),f.manager.invoke('managed.retry',retry)]);
 assert.equal(a.closure.phase,'complete');assert.deepEqual(a,b);const oid=a.closure.git.commit;assert.equal(git(f.project,'rev-parse','HEAD'),oid);assert.equal(git(f.project,'show','HEAD:A.txt'),'A result');assert.equal(git(f.project,'rev-list','--count','HEAD'),'2');
 assert.equal(jobHistory(f.c.store.state.jobs),jobs);assert.equal(reportHistory(f.c.store.state.receipts),reports);await f.reopen();assert.equal((await f.c.retryClosure(w.id)).closure.git.commit,oid);assert.equal(git(f.project,'rev-list','--count','HEAD'),'2');assert.equal(jobHistory(f.c.store.state.jobs),jobs);assert.equal(reportHistory(f.c.store.state.receipts),reports);
});

test('SIGKILL after acceptance ref publication inherits original decision and OID without replay',opts,async t=>{
 const f=await fixture(t),w=await f.work(),jobs=jobHistory(f.c.store.state.jobs),reports=reportHistory(f.c.store.state.receipts);
 await fs.writeFile(path.join(f.project,'.git/index.lock'),'user-owned-lock');await f.c.endWork(w.id,{revision:w.revision,decision:'accept'});assert.equal(f.c.store.find(w.id).closure.phase,'blocked');await f.c.stop();await fs.unlink(path.join(f.project,'.git/index.lock'));
 const code=`import {ExecutionWorkspace} from ${JSON.stringify(new URL('../src/agents/managed/execution-workspace.mjs',import.meta.url).href)};import {openTestController} from ${JSON.stringify(new URL('./project-storage.fixture.mjs',import.meta.url).href)};const save=ExecutionWorkspace.prototype.save;ExecutionWorkspace.prototype.save=async function(m){await save.call(this,m);if(m.finishIntent?.status==='ref-published')process.kill(process.pid,'SIGKILL');};await openTestController({runtimeRoot:${JSON.stringify(f.runtime)},contentRoot:${JSON.stringify(f.project)}});throw Error('expected SIGKILL');`;
 const child=path.join(f.root,'crash-after-ref-publication.mjs');await fs.writeFile(child,code);
 let signal;try{execFileSync(process.execPath,[child],{encoding:'utf8',timeout:15000});}catch(error){signal=error.signal;await fs.writeFile(path.join(f.root,'crash-output.txt'),String(error.stderr||'')+'\nsignal='+signal);}assert.equal(signal,'SIGKILL');
 const manifest=JSON.parse(await fs.readFile(path.join(f.runtime,'evidence','execution-'+w.id+'.json'),'utf8')),oid=git(f.project,'rev-parse','HEAD');assert.equal(manifest.finishIntent.status,'ref-published');assert.equal(manifest.finishIntent.commit,oid);assert.equal(git(f.project,'rev-list','--count','HEAD'),'2');
 const before=f.calls.length;await f.reopen();const recovered=f.c.store.find(w.id);assert.equal(recovered.outcome,'accept');assert.equal(recovered.closure.phase,'complete');assert.equal(recovered.closure.git.commit,oid);assert.equal(f.calls.length,before);assert.equal(jobHistory(f.c.store.state.jobs),jobs);assert.equal(reportHistory(f.c.store.state.receipts),reports);
 assert.equal((await f.c.retryClosure(w.id)).closure.git.commit,oid);assert.equal(git(f.project,'rev-list','--count','HEAD'),'2');
});

test('interrupted acceptance hook stays uncertain and is never replayed on restart',opts,async t=>{
 const f=await fixture(t),w=await f.work(),marker=path.join(f.root,'hook-ran');await fs.writeFile(path.join(f.project,'.git/hooks/pre-commit'),'#!/bin/sh\nprintf ran > '+JSON.stringify(marker)+'\n',{mode:0o755});
 const save=f.c.execution.save.bind(f.c.execution);let interrupted=false;f.c.execution.save=async m=>{await save(m);if(!interrupted&&m.acceptancePreparation?.status==='running'){interrupted=true;throw Error('fixture interrupted before hook completion evidence');}};
 await f.c.endWork(w.id,{revision:w.revision,decision:'accept'});assert.equal(f.c.store.find(w.id).closure.phase,'blocked');assert.equal((await f.c.execution.readManifest(w.id)).acceptancePreparation.status,'running');await f.reopen();
 assert.equal(f.c.store.find(w.id).closure.phase,'blocked');assert.equal((await f.c.execution.readManifest(w.id)).acceptancePreparation.status,'running');await assert.rejects(fs.stat(marker),{code:'ENOENT'});assert.equal(git(f.project,'rev-list','--count','HEAD'),'1');assert.equal(await fs.readFile(path.join(f.c.execution.directory(w.id),'A.txt'),'utf8'),'A result\n');
});
