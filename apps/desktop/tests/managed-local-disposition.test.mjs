import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const runtimeRoot=process.env.NOZELI_TEST_BUNDLE?path.join(process.env.NOZELI_TEST_BUNDLE,'Contents/Resources/app'):path.resolve(import.meta.dirname,'..');
const load=relative=>import(pathToFileURL(path.join(runtimeRoot,relative)));
const {Controller}=await load('src/agents/managed/controller.mjs');
const {ManagedProjects}=await load('src/agents/managed-projects.mjs');
import {staticReport} from './static-report.fixture.mjs';
const {DesktopHost}=await load('src/main/host.mjs');
const {managedRuntime,readManagedState}=await load('src/agents/managed/managed-storage.mjs');
async function fixture(t,{report=true}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'local-disposition-')),content=path.join(root,'project');await fs.mkdir(content);await fs.writeFile(path.join(content,'result.txt'),'original');
 const host=new DesktopHost(root),id=(await host.pick(content)).project.id,storage=host.storage;
 const service=new ManagedProjects({userDataDir:root,host,legacy:{projects:new Map()}});const runtimeRoot=await managedRuntime(storage,id);
 const c=await Controller.open({runtimeRoot,contentRoot:content,storage,projectId:id});const submitted=await c.store.submit('isolated task','brief');await c.store.activate(submitted.id);const w=c.store.find(submitted.id);await c.execution.prepare(w.id);await fs.writeFile(path.join(c.execution.directory(w.id),'result.txt'),'candidate');
 if(report){await c.execution.publish(w,{id:'finished-job'},()=>true);await c.store.publish(w.id,w.revision,'result',staticReport('Frozen result'),'report',{jobId:'finished-job',files:[{relPath:'result.txt'}]});await c.store.settle(w.id);await c.store.mutate(()=>c.store.state.jobs.push({id:'finished-job',target:w.id,revision:w.revision,status:'completed',type:'initial'}));}
 const queued=await c.store.submit('never authorized cold queue','brief');await c.stop();await storage.putLocal(id,'managed:binding',{enabled:true});
 service.initializeResources=async()=>{throw Error('global resources forbidden');};service.openController=options=>Controller.open({...options,sessionFactory:()=>{throw Error('native session forbidden');}});
 t.after(async()=>{await service.stop();await storage.db.close();await fs.rm(root,{recursive:true,force:true});});return {service,id,workId:w.id,content,runtimeRoot,queuedId:queued.id,storage};
}
for(const decision of ['accept','discard'])test('cold '+decision+' uses real Git without OMP/provider and query is projection-only',async t=>{
 const f=await fixture(t),before=await readManagedState(f.storage,f.id);const capability=await f.service.invoke('managed.disposition',{projectId:f.id,workId:f.workId});assert.equal(capability[decision].allowed,true);assert.equal(f.service.controllers.size,0);assert.deepEqual(await readManagedState(f.storage,f.id),before);
 const result=await f.service.invoke('managed.end',{projectId:f.id,workId:f.workId,revision:capability.binding.revision,decision,binding:capability.binding,requestKey:'confirmation-'+decision});assert.equal(result.closure.phase,'complete',result.closure.error);assert.equal(await fs.readFile(path.join(f.content,'result.txt'),'utf8'),decision==='accept'?'candidate':'original');const c=f.service.controllers.get(f.id);assert.equal(c.sessions.size,0);assert.equal(c.started,false);assert.equal(c.store.find(f.queuedId).status,'queued');assert.equal(result.closure.stopReceipt.confirmed,undefined);
});
test('dirty target preserves ended blocked then technical retry completes',async t=>{const f=await fixture(t),cap=await f.service.disposition(f.id,f.workId);await fs.writeFile(path.join(f.content,'result.txt'),'dirty');const r=await f.service.invoke('managed.end',{projectId:f.id,workId:f.workId,revision:1,decision:'accept',binding:cap.binding,requestKey:'dirty-confirmation'});assert.equal(r.status,'ended');assert.equal(r.closure.phase,'blocked');await fs.writeFile(path.join(f.content,'result.txt'),'original');const retried=await f.service.invoke('managed.retry',{projectId:f.id,workId:f.workId,binding:cap.binding,requestKey:'technical-retry'});assert.equal(retried.closure.phase,'complete',retried.closure.error);});
test('explicit target reconciliation integrates user notes and completes host provenance without Worker replay',async t=>{
 const f=await fixture(t),c=await f.service.loadLocal(f.id),current='original\nLater user note\n',merged='candidate\nLater user note\n';
 await fs.writeFile(path.join(f.content,'result.txt'),current);
 await c.endWork(f.workId,{revision:1,decision:'accept'});
 assert.equal(c.store.find(f.workId).closure.phase,'blocked');
 const count=c.store.state.jobs.length;
 await c.reconcileAcceptedFiles(f.workId,{requestKey:'user-target-reconciliation',files:[{relPath:'result.txt',text:merged,expectedDigest:createHash('sha256').update(current).digest('hex')}]});
 await c.retryClosure(f.workId);
 const w=c.store.find(f.workId);
 assert.equal(w.closure.phase,'complete',w.closure.error);
 assert.equal(w.closure.provenance.complete,true);
 assert.equal(await fs.readFile(path.join(f.content,'result.txt'),'utf8'),merged);
 assert.equal(c.store.state.jobs.length,count);
 await assert.rejects(fs.stat(w.execution.directory),{code:'ENOENT'});
});
test('cold deviation decision durably resumes the original Work without requiring an active provider',async t=>{
 const f=await fixture(t),c=await f.service.loadLocal(f.id),w=c.store.find(f.workId);
 await c.store.continue(w.id);
 const job={id:'scope-change-input',target:w.id,revision:w.revision,type:'supplement',status:'completed',text:'Explicitly extend this same task',context:{}};
 await c.store.mutate(()=>c.store.state.jobs.push(job));
 await c.store.reportDeviation(w.id,job,{changedGoal:'Extension requested',reason:'Needs explicit user authorization',progress:'Candidate retained'},'scope-change-call');
 await c.stop();f.service.controllers.delete(f.id);
 const d=w.deviation,p={projectId:f.id,workId:w.id,deviationId:d.id,expectedRevision:w.revision,expectedVersion:d.version,action:'continue',requestKey:'cold-deviation-decision'};
 const first=await f.service.invoke('managed.deviation.resolve',p),second=await f.service.invoke('managed.deviation.resolve',p),restored=f.service.controllers.get(f.id);
 assert.equal(first.accepted,true);assert.equal(second.jobId,first.jobId);
 assert.equal(restored.sessions.size,0);assert.equal(restored.started,false);
 assert.equal(restored.store.state.jobs.filter(j=>j.type==='deviation-resume').length,1);
 assert.equal(restored.store.state.jobs.find(j=>j.id===first.jobId).target,w.id);
 assert.equal(restored.store.find(w.id).deviation.status,'continued');
 assert.equal(await fs.readFile(path.join(restored.execution.directory(w.id),'result.txt'),'utf8'),'candidate');
});
test('failed result does not authorize accept but discard without result works',async t=>{const f=await fixture(t,{report:false}),cap=await f.service.disposition(f.id,f.workId);assert.equal(cap.accept.allowed,false);assert.equal(cap.discard.allowed,true);const r=await f.service.invoke('managed.end',{projectId:f.id,workId:f.workId,revision:1,decision:'discard',binding:cap.binding,requestKey:'discard-no-result'});assert.equal(r.closure.phase,'complete');});
test('completed Worker turn with changed files but no final result remains incomplete and cannot be accepted',async t=>{
 const f=await fixture(t,{report:false}),c=await f.service.loadLocal(f.id),w=c.store.find(f.workId);
 await c.store.mutate(()=>c.store.state.jobs.push({id:'finished-without-result',target:w.id,revision:w.revision,type:'initial',status:'completed'}));
 await c.store.settle(w.id);
 assert.equal(w.status,'paused');
 const cap=await f.service.disposition(f.id,w.id);assert.equal(cap.accept.allowed,false);
 await assert.rejects(c.endWork(w.id,{revision:w.revision,decision:'accept'}));
 assert.equal(await fs.readFile(path.join(f.content,'result.txt'),'utf8'),'original');
 assert.equal(await fs.readFile(path.join(c.execution.directory(w.id),'result.txt'),'utf8'),'candidate');
 assert.notEqual(w.status,'ended');
});
test('old binding and unknown turn reject before recording a decision',async t=>{const f=await fixture(t),cap=await f.service.disposition(f.id,f.workId);await assert.rejects(f.service.invoke('managed.end',{projectId:f.id,workId:f.workId,revision:1,decision:'accept',binding:{...cap.binding,objectId:'old'},requestKey:'old-binding-key'}),/stale/);const c=f.service.controllers.get(f.id);await c.store.mutate(()=>c.store.state.jobs[0].status='unknown');await assert.rejects(c.endWork(f.workId,{revision:1,decision:'accept',binding:cap.binding,requestKey:'unknown-turn-key'}),/结算/);assert.notEqual(c.store.find(f.workId).status,'ended');});
test('wrong PID ownership and unknown budget fail closed before decision',async t=>{const f=await fixture(t),c=await f.service.loadLocal(f.id),w=c.store.find(f.workId);await c.store.mutate(()=>c.store.state.providers[w.id]={kind:'omp-tui',pid:process.pid,home:c.store.agentHome(w.id),stamp:process.platform==='darwin'?'darwin:00000000-0000-0000-0000-000000000000:1:1':'00000000-0000-0000-0000-000000000000:1'});await assert.rejects(c.endWork(w.id,{revision:1,decision:'discard'}),/identity reused/);await c.store.mutate(()=>delete c.store.state.providers[w.id]);const slot=c.processBudget.restoreSlot(f.id,w.id);await assert.rejects(c.endWork(w.id,{revision:1,decision:'discard'}),/identity is unknown/);c.processBudget.release(slot);assert.notEqual(w.status,'ended');});
test('corrupt frozen artifact retains the user decision but blocks acceptance and cleanup',async t=>{const f=await fixture(t),c=await f.service.loadLocal(f.id),receipt=c.store.state.receipts[0],digest=receipt.snapshot.files.find(file=>file.relPath==='result.txt').digest,binding=await f.storage.requireRegistered(f.id),candidate=structuredClone(c.store.find(f.workId).execution.candidate),directory=c.execution.directory(f.workId);await fs.writeFile(path.join(binding.metadataRoot,'objects','sha256',digest),'corrupt');await fs.writeFile(path.join(await f.storage.recoveryDirectory(f.id),'objects','sha256',digest),'corrupt');const result=await c.endWork(f.workId,{revision:1,decision:'accept'});assert.equal(result.status,'ended');assert.equal(result.outcome,'accept');assert.equal(result.closure.phase,'blocked');assert.ok(result.closure.error);assert.deepEqual(c.store.find(f.workId).execution.candidate,candidate);assert.equal(await fs.readFile(path.join(f.content,'result.txt'),'utf8'),'original');assert.equal(await fs.readFile(path.join(directory,'result.txt'),'utf8'),'candidate');});
test('competing decisions serialize and duplicate confirmation is idempotent',async t=>{const f=await fixture(t),cap=await f.service.disposition(f.id,f.workId),base={projectId:f.id,workId:f.workId,revision:1,binding:cap.binding};const offers=[['discard','winning-confirmation'],['accept','competing-confirmation']];const [a,b]=await Promise.allSettled(offers.map(([decision,requestKey])=>f.service.invoke('managed.end',{...base,decision,requestKey})));const settled=[a,b].filter(r=>r.status==='fulfilled'),rejected=[a,b].filter(r=>r.status==='rejected');assert.equal(settled.length,1);assert.equal(rejected.length,1);assert.equal(rejected[0].reason.message,'work already ended with another decision');const winner=settled[0].value;assert(['accept','discard'].includes(winner.outcome));const [winningDecision,winningKey]=offers.find(([,key])=>key===winner.closure.requestKey);assert.equal(winner.outcome,winningDecision);const repeat=await f.service.invoke('managed.end',{...base,decision:winningDecision,requestKey:winningKey});assert.equal(repeat.closure.phase,'complete');const c=f.service.controllers.get(f.id);assert.equal(c.store.find(f.workId).closure.decision,winningDecision);});
test('completed job with unresolved native prompt cannot authorize accept',async t=>{const f=await fixture(t),c=await f.service.loadLocal(f.id);await c.store.mutate(()=>c.store.state.jobs[0].collabAttempts=[{kind:'prompt',status:'unknown',everAdmitted:true}]);await assert.rejects(c.endWork(f.workId,{revision:1,decision:'accept'}),/结算/);assert.notEqual(c.store.find(f.workId).status,'ended');});
test('explicit upgrade retains Controller and original unended thread without releasing cold queue',async t=>{
 const f=await fixture(t),c=await f.service.loadLocal(f.id),starts=[];await c.store.mutate(()=>{c.store.state.residents.frontdesk={provider:'omp',threadId:'original-frontdesk'};});
 c.sessionFactory=(spec,target)=>({threadId:null,closed:false,toolsDigest:'fixture-tools',on(){},async start(id){this.threadId=id??'new-'+target;starts.push({target,id});return this;},async stop(){this.closed=true;return {confirmationComplete:true};}});
 f.service.initializeResources=async()=>{};const jobs=structuredClone(c.store.state.jobs);await f.service.connect(f.id);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.service.controllers.get(f.id),c);assert.equal(c.started,true);assert(starts.some(s=>s.target==='frontdesk'&&s.id==='original-frontdesk'));assert.equal(c.store.find(f.queuedId).status,'queued');assert.deepEqual(c.store.state.jobs,jobs);assert.equal(c.store.find(f.workId).status,'review');
});
for(const decision of ['accept','discard'])test('disabled Agent binding permits existing Work local '+decision+' without enabling sessions',async t=>{const f=await fixture(t),original={enabled:false};await f.storage.putLocal(f.id,'managed:binding',original);const cap=await f.service.disposition(f.id,f.workId);const result=await f.service.invoke('managed.end',{projectId:f.id,workId:f.workId,revision:1,decision,binding:cap.binding,requestKey:'disabled-'+decision});assert.equal(result.closure.phase,'complete',result.closure.error);assert.deepEqual(await f.storage.getLocal(f.id,'managed:binding'),original);assert.equal(f.service.controllers.get(f.id).sessions.size,0);});
test('local action rejects absent work without creating an execution ledger',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'missing-local-runtime-')),content=path.join(root,'project');await fs.mkdir(content);const host=new DesktopHost(root),id=(await host.pick(content)).project.id,service=new ManagedProjects({userDataDir:root,host,legacy:{projects:new Map()}}),runtime=await managedRuntime(host.storage,id);t.after(async()=>{await service.stop();await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});await assert.rejects(service.loadLocal(id,'no-work'),error=>error.code==='WORK_NOT_FOUND');await assert.rejects(fs.stat(runtime),{code:'ENOENT'});});
