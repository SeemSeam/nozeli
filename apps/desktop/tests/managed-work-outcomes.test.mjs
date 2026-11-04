import {openTestController,openTestWorkspace,readTestState,writeTestState,readTestObject} from './project-storage.fixture.mjs';
import {dispositionIntent} from './disposition-intent.fixture.mjs';
import {staticReport,historicalMarkdownState} from './static-report.fixture.mjs';
import {readStoredReport} from '../src/agents/managed/report-descriptor.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Controller} from '../src/agents/managed/controller.mjs';
import {runGit} from '../src/agents/managed/git-runtime.mjs';
async function fixture(t,{report=true}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-outcome-')),content=path.join(root,'project');await fs.mkdir(content);await fs.writeFile(path.join(content,'result.txt'),'original bytes');
 const options={runtimeRoot:path.join(root,'runtime'),contentRoot:content};const c=await openTestController(options);const w=await c.store.submit('user task','worker brief',{name:'Alpha'});await c.store.activate(w.id);await c.execution.prepare(w.id);await fs.writeFile(path.join(c.execution.directory(w.id),'result.txt'),'candidate bytes');
 if(report){await c.execution.publish(c.store.find(w.id),{id:'report-job'},()=>true);await c.store.publish(w.id,1,'result',staticReport('## Summary\nWorker-owned exact final summary.\n\nSource: result.txt.'),'report',{jobId:'report-job',files:[{relPath:'result.txt'}]});await c.store.settle(w.id);await c.store.mutate(()=>c.store.state.jobs.push({id:'report-job',target:w.id,revision:1,status:'completed',type:'initial'}));}
 t.after(async()=>{if(!c.store.closed)await c.stop();await fs.rm(root,{recursive:true,force:true});});return {c,w:c.store.find(w.id),root,options,content};
}
for(const persistent of [false,true])test('accept once records real Git lock and repairs original closure; persistent='+persistent,async t=>{
 const {c,w,content}=await fixture(t),manifest=await c.execution.readManifest(w.id),lock=manifest.index+'.lock',businessJobs=structuredClone(c.store.state.jobs);
 const initialCount=Number((await runGit(content,['rev-list','--count','HEAD'])).toString());
 await fs.writeFile(lock,'fixture Git owner; secret-token');
 const event=c.maintenanceEvent.bind(c);let authorization,recorded;
 c.maintenanceEvent=async(bug,options)=>{
  recorded=(await c.maintenance.read()).bugs.find(row=>row.id===bug.id);
  authorization=structuredClone(w.closure);
  assert.equal(recorded.error.code,'GIT_LOCKED');assert(!JSON.stringify(recorded).includes('secret-token'));assert(!JSON.stringify(recorded).includes(content));
  await event(bug,options);
  if(!persistent)await fs.unlink(lock); // Only the fixture owner releases its lock.
 };
 await c.endWork(w.id,{revision:1,decision:'accept',requestKey:'original-accept-lock-'+persistent});
 if(persistent){
  assert.equal(w.status,'closing');assert.equal(w.closure.phase,'blocked');
  assert.equal(await fs.readFile(lock,'utf8'),'fixture Git owner; secret-token');
  assert.equal((await c.maintenance.read()).bugs[0].attempts.length,1);
  await fs.unlink(lock);
  await c.maintenanceRetry(recorded.id); // Existing system maintenance, not a user disposition.
 }
 assert.equal(w.status,'ended');assert.equal(w.closure.phase,'complete');assert.equal(w.closure.requestKey,authorization.requestKey);assert.deepEqual(w.closure.binding,authorization.binding);assert.deepEqual(w.closure.mergeAuthorization,authorization.mergeAuthorization);assert.equal(w.closure.retryRequests,undefined);
 const bug=(await c.maintenance.read()).bugs.find(row=>row.id===recorded.id);assert.equal(bug.status,'repaired');assert.equal(bug.lastOutcome.verified,true);assert.equal(bug.attempts.length,persistent?2:1);assert.equal(w.maintenance,undefined);
 const events=c.store.state.jobs.filter(job=>job.type==='maintenance');assert.equal(events.length,1);assert.equal(events[0].context.bugId,bug.id);assert.equal(events[0].status,'completed');assert.equal(events[0].hostResolved,true);
 assert.deepEqual(c.store.state.jobs.filter(job=>job.type!=='maintenance'),businessJobs);assert.equal(c.sessions.size,0);assert.equal(await fs.readFile(path.join(content,'result.txt'),'utf8'),'candidate bytes');
 assert.equal(Number((await runGit(content,['rev-list','--count','HEAD'])).toString()),initialCount+1);
 const head=(await runGit(content,['rev-parse','HEAD'])).toString();await c.maintenanceRetry(bug.id);assert.equal((await runGit(content,['rev-parse','HEAD'])).toString(),head);
});
test('technical filesystem closure fault records and automatically completes original discard',async t=>{
 const {c,w}=await fixture(t),archive=c.store.archiveReport.bind(c.store);let fail=true;
 c.store.archiveReport=async id=>{if(fail)throw Object.assign(Error('fixture private path secret-token'),{code:'EISDIR'});return archive(id);};
 const event=c.maintenanceEvent.bind(c);c.maintenanceEvent=async(bug,options)=>{assert.equal((await c.maintenance.read()).bugs[0].error.code,'EISDIR');await event(bug,options);fail=false;};
 await c.endWork(w.id,{revision:1,decision:'discard',requestKey:'original-discard-fs-fault'});
 assert.equal(w.status,'ended');assert.equal(w.closure.requestKey,'original-discard-fs-fault');assert.equal(w.closure.retryRequests,undefined);assert.equal((await c.maintenance.read()).bugs[0].status,'repaired');assert.equal(c.store.state.jobs.find(job=>job.type==='maintenance').status,'completed');assert.equal(c.sessions.size,0);
});
test('fault after real Git commit finalizes original acceptance without a second commit or Worker',async t=>{
 const {c,w,content}=await fixture(t),business=structuredClone(c.store.state.jobs),count=Number((await runGit(content,['rev-list','--count','HEAD'])).toString());let calls=0,commit,authorization;
 c.afterAdoption=async()=>{calls++;if(calls===1){commit=(await runGit(content,['rev-parse','HEAD'])).toString();authorization=structuredClone(w.closure.mergeAuthorization);throw Object.assign(Error('private fixture diagnosis secret-token'),{code:'HOST_INTERNAL_FAILURE'});}return {complete:true};};
 await c.endWork(w.id,{revision:1,decision:'accept',requestKey:'original-accept-after-commit'});
 assert.equal(w.status,'ended');assert.equal(w.closure.phase,'complete');assert.equal(w.closure.requestKey,'original-accept-after-commit');assert.deepEqual(w.closure.mergeAuthorization,authorization);assert.equal(w.closure.retryRequests,undefined);assert.equal(calls,2);
 assert.equal((await runGit(content,['rev-parse','HEAD'])).toString(),commit);assert.equal(Number((await runGit(content,['rev-list','--count','HEAD'])).toString()),count+1);
 assert.deepEqual(c.store.state.jobs.filter(job=>job.type!=='maintenance'),business);assert.equal(c.sessions.size,0);const bug=(await c.maintenance.read()).bugs[0];assert.equal(bug.status,'repaired');assert(!JSON.stringify(bug).includes('secret-token'));assert.equal(c.store.state.jobs.find(job=>job.context?.bugId===bug.id).status,'completed');
});
test('continue retains Work, Agent, thread and worktree identity',async t=>{
 const {c,w}=await fixture(t);await c.store.bind(w.id,'same-thread');const identity={id:w.id,agentId:w.agentId,threadId:w.threadId,directory:w.execution.directory};await c.store.continue(w.id);assert.deepEqual({id:w.id,agentId:w.agentId,threadId:w.threadId,directory:w.execution.directory},identity);assert.equal(w.revision,2);assert.equal(await fs.readFile(path.join(w.execution.directory,'result.txt'),'utf8'),'candidate bytes');
});
for(const decision of ['accept','discard'])test(decision+' performs real disposition and archives exact report without a model gate',async t=>{
 const {c,w,content}=await fixture(t),directory=w.execution.directory,branch=w.execution.branchRef,report=c.store.state.receipts[0],before=c.store.state.jobs.length;
 await c.endWork(w.id,{revision:1,decision});assert.equal(w.status,'ended');assert.equal(w.outcome,decision);assert.equal(w.closure.phase,'complete');assert.equal(c.store.used(),0);assert.equal(c.store.state.jobs.length,before);assert.equal(await fs.readFile(path.join(content,'result.txt'),'utf8'),decision==='accept'?'candidate bytes':'original bytes');await assert.rejects(fs.stat(directory),{code:'ENOENT'});await assert.rejects(runGit(content,['show-ref','--verify',branch]));
 assert.equal(await fs.readFile(path.join(path.dirname(c.store.plan),w.closure.report.relPath),'utf8'),(await readStoredReport(c.store,report)).toString());assert.equal(await c.store.readObject(report.snapshot.files.find(file=>file.relPath==='result.txt').digest).then(bytes=>bytes.toString('utf8')),'candidate bytes');const head=(await runGit(content,['rev-parse','HEAD'])).toString();await c.retryClosure(w.id);assert.equal((await runGit(content,['rev-parse','HEAD'])).toString(),head);assert.equal(c.store.state.jobs.length,before);
 const metadata=(await readTestState(c.store)).works.find(row=>row.id===w.id);assert.equal(metadata.name,'Alpha');assert.equal(metadata.request,'user task');assert.equal(metadata.outcome,decision);assert.equal(metadata.closure.git.status,decision==='accept'?'merged':'discarded');assert.match(await fs.readFile(c.store.plan,'utf8'),/Worker-owned exact final summary/);
});
test('real dirty-target blocker cannot reopen business and retry never runs Worker',async t=>{
 const {c,w,content}=await fixture(t);await fs.writeFile(path.join(content,'result.txt'),'user unsaved-on-disk change');await c.endWork(w.id,{revision:1,decision:'accept'});assert.equal(w.status,'closing');assert.equal(w.closure.phase,'blocked');assert.equal(c.store.used(),1,'blocked cleanup retains the activated Work slot');assert(w.closure.report);assert.equal(await fs.readFile(path.join(w.execution.directory,'result.txt'),'utf8'),'candidate bytes');assert.equal(await fs.readFile(path.join(content,'result.txt'),'utf8'),'user unsaved-on-disk change');await fs.writeFile(path.join(content,'result.txt'),'original bytes');await c.retryClosure(w.id);assert.equal(w.closure.phase,'complete');assert.equal(c.store.used(),0,'only full cleanup releases the Work slot');assert.equal(await fs.readFile(path.join(content,'result.txt'),'utf8'),'candidate bytes');assert.deepEqual(c.store.state.jobs.map(job=>({id:job.id,status:job.status})),[{id:'report-job',status:'completed'}]);
});
test('real archival filesystem blocker preserves candidate until retry',async t=>{
 const {c,w}=await fixture(t),savedPlan=c.store.plan+'.fixture-saved';await fs.rename(c.store.plan,savedPlan);await fs.mkdir(c.store.plan);
 const response=await c.endWork(w.id,{revision:1,decision:'discard'});assert.equal(response.status,'closing');assert.equal(response.closure.phase,'blocked');
 assert.equal(c.store.find(w.id).status,'closing');assert.equal(c.store.find(w.id).closure.phase,'blocked');assert.equal(await fs.readFile(path.join(w.execution.directory,'result.txt'),'utf8'),'candidate bytes');
 const persisted=await readTestState(c.store);assert.equal(persisted.works.find(row=>row.id===w.id).closure.phase,'blocked');
 const bug=(await c.maintenance.read()).bugs.find(row=>row.phase==='closure');assert.equal(bug.error.code,'EISDIR');assert.equal(bug.status,'needs-version-fix');assert.equal(bug.attempts.length,1);assert.equal(persisted.works.find(row=>row.id===w.id).maintenance.bugId,bug.id);
 await fs.rmdir(c.store.plan);await fs.rename(savedPlan,c.store.plan);await c.maintenanceRetry(bug.id);
 assert.equal(c.store.find(w.id).closure.phase,'complete');assert.equal((await c.maintenance.read()).bugs.find(row=>row.id===bug.id).status,'repaired');assert.equal(c.store.state.jobs.find(row=>row.context?.bugId===bug.id).status,'completed');await assert.rejects(fs.stat(w.execution.directory),{code:'ENOENT'});
});
test('missing report archives factual termination, never invented success',async t=>{
 const {c,w,content}=await fixture(t,{report:false});await c.endWork(w.id,{revision:1,decision:'discard'});assert.equal(w.closure.report.kind,'host-termination');const text=await fs.readFile(path.join(path.dirname(c.store.plan),w.closure.report.relPath),'utf8');assert.match(text,/No final Worker result report/);assert.match(text,/not a successful completion report/);assert.equal(await fs.readFile(path.join(content,'result.txt'),'utf8'),'original bytes');assert.equal(w.acceptance,undefined);
});
test('end cancels accepted queued inputs while preserving drafts and transcript',async t=>{
 const {c,w}=await fixture(t);await c.store.mutate(()=>{c.queueJob(w.id,'supplement','accepted exact old input');c.store.state.drafts[w.id]='unsent draft';});await c.endWork(w.id,{revision:1,decision:'discard'});assert.equal(c.store.state.jobs.find(job=>job.type==='supplement').status,'cancelled');assert.equal(c.store.state.jobs.find(job=>job.id==='report-job').status,'completed');assert.equal(c.store.state.drafts[w.id],'unsent draft');assert(c.store.state.messages.some(m=>m.text==='accepted exact old input'));
});
test('cold open resumes actual technical disposition without old input replay',async t=>{
 const {c,w,options}=await fixture(t);await c.store.mutate(()=>c.queueJob(w.id,'supplement','do not replay'));await c.store.end(w.id,dispositionIntent(w));await c.stop();const reopened=await openTestController(options);try{const ended=reopened.store.find(w.id);assert.equal(ended.status,'ended');assert.equal(ended.closure.phase,'complete');assert.equal(reopened.sessions.size,0);assert.equal(reopened.store.state.jobs.find(job=>job.type==='supplement').status,'cancelled');assert.equal(reopened.store.state.jobs.find(job=>job.id==='report-job').status,'completed');await assert.rejects(fs.stat(ended.execution.directory),{code:'ENOENT'});}finally{await reopened.stop();}
});
test('uncertain legacy end preserves resources until explicit same-API disposition',async t=>{
 const {c,w,options}=await fixture(t),at='2026-10-01T01:02:03.000Z';await c.store.mutate(()=>{w.status='closing';w.closure={phase:'requested',at};delete c.store.state.workOutcomeCutover;});await c.stop();const reopened=await openTestController(options);try{const ended=reopened.store.find(w.id);assert.equal(ended.status,'closing');assert.equal(ended.outcome,undefined);assert.equal(ended.closure.phase,'requested');assert.ok(ended.needsReconciliation);assert.equal(ended.endedAt,undefined);assert.equal(await fs.readFile(path.join(ended.execution.directory,'result.txt'),'utf8'),'candidate bytes');await reopened.endWork(w.id,{revision:1,decision:'discard'});assert.notEqual(ended.endedAt,at);assert.equal(ended.outcome,'discard');assert.equal(ended.closure.phase,'complete');await assert.rejects(fs.stat(ended.execution.directory),{code:'ENOENT'});}finally{await reopened.stop();}
});
test('successful cleanup retains session logs but removes all private home credentials',async t=>{
 const {c,w}=await fixture(t),home=c.store.agentHome(w.id);await fs.mkdir(path.join(home,'sessions'),{recursive:true});await fs.writeFile(path.join(home,'sessions','thread.jsonl'),'original native session log');await fs.writeFile(path.join(home,'auth.json'),'private credential');await fs.writeFile(path.join(home,'bridge-token'),'ephemeral bridge token');await c.endWork(w.id,{revision:1,decision:'accept'});assert.equal(w.closure.phase,'complete');assert.equal(await fs.readFile(path.join(w.closure.workerHome.historyPath,'sessions','thread.jsonl'),'utf8'),'original native session log');await assert.rejects(fs.stat(home),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(w.closure.workerHome.historyPath,'bridge-token')),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(w.closure.workerHome.historyPath,'auth.json')),{code:'ENOENT'});
});
test('incompatible historical Worker tool schema blocks native resume without losing thread',async t=>{
 const {c,w}=await fixture(t);await c.store.mutate(()=>{w.threadId='original-thread';w.zeroActivity=false;w.toolsDigest='old-tool-schema';w.binding={...c.store.state.bindings.worker,provider:'codex'};});let started=false;c.sessionFactory=spec=>({...spec,start:async()=>{started=true;},stop:async()=>{}});await assert.rejects(c.makeSession(w.id),error=>error.code === 'HISTORICAL_SESSION_READ_ONLY');assert.equal(started,false);assert.equal(w.threadId,'original-thread');assert.equal(w.toolsDigest,'old-tool-schema');assert.equal(await fs.readFile(path.join(w.execution.directory,'result.txt'),'utf8'),'candidate bytes');
});
test('explicit Worker schema handoff preserves source history and waits for a new user input',async t=>{
 const {c,w,options}=await fixture(t),identity={id:w.id,agentId:w.agentId,directory:w.execution.directory,branchRef:w.execution.branchRef};await c.store.mutate(()=>{w.threadId='old-native-thread';w.zeroActivity=false;w.toolsDigest='retired-schema';w.binding={...c.store.state.bindings.worker,provider:'codex'};w.inputs=[{text:'exact earlier user input'}];});
 const oldLog=path.join(c.store.agentHome(w.id),'sessions','old.jsonl');await fs.mkdir(path.dirname(oldLog),{recursive:true});await fs.writeFile(oldLog,'original native transcript');c.sessionFactory=spec=>({...spec,start:async function(id){this.threadId=id||'new-native-thread';return this;},stop:async function(){this.closed=true;}});await assert.rejects(c.makeSession(w.id),error=>error.code === 'HISTORICAL_SESSION_READ_ONLY');assert(w.contextRecovery);await assert.rejects(c.recoverWorkerContext(w.id,{revision:1,oldThreadId:'old-native-thread',confirmed:false}),/Explicit confirmation/);assert.equal(w.threadId,'old-native-thread');
 const accepted=await c.recoverWorkerContext(w.id,{revision:1,oldThreadId:'old-native-thread',confirmed:true});assert.deepEqual(c.store.state.jobs.map(job=>job.id),['report-job']);assert.equal(w.threadId,undefined);assert.deepEqual({id:w.id,agentId:w.agentId,directory:w.execution.directory,branchRef:w.execution.branchRef},identity);assert.equal(await fs.readFile(oldLog,'utf8'),'original native transcript');assert.equal((await c.recoverWorkerContext(w.id,{revision:1,oldThreadId:'old-native-thread',confirmed:true})).archiveId,accepted.archiveId);
 let offset=0,source='';for(;;){const page=await c.readWorkerArchive(w.id,{archiveId:accepted.archiveId,offset});assert.equal(page.readOnly,true);source+=page.text;if(page.nextOffset===null)break;offset=page.nextOffset;}const dossier=JSON.parse(source);assert.equal(dossier.oldThreadId,'old-native-thread');assert.equal(dossier.request,'user task');assert.equal(dossier.inputs[0].text,'exact earlier user input');assert.deepEqual(dossier.reports[0].report,c.store.state.receipts[0].report);await assert.rejects(c.readWorkerArchive(w.id,{archiveId:'foreign'}));
 await c.stop();const reopened=await openTestController(options);try{const recovered=reopened.store.find(w.id);assert.equal(recovered.threadId,undefined);assert.equal(recovered.contextHandoff.archiveId,accepted.archiveId);assert.equal(reopened.sessions.size,0);assert.deepEqual(reopened.store.state.jobs.map(job=>job.id),['report-job']);const job={},context=await reopened.workerRecoveryContext(recovered,job);assert.equal(job.reader.read(context.refs.request).text,'user task');assert.equal(await fs.readFile(path.join(recovered.execution.directory,'result.txt'),'utf8'),'candidate bytes');await reopened.send(w.id,'new explicit continuation');const queued=reopened.store.state.jobs.findLast(row=>row.target===w.id);assert.equal(queued.text,'new explicit continuation');assert.equal(queued.status,'queued');assert.equal(reopened.store.state.jobs.length,2);}finally{await reopened.stop();}
});
for(const alreadyNormalized of [false,true])test('old completed closure and retired Orchestrator skills migrate once without native choice loss; prior normalization='+alreadyNormalized,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-old-profile-')),options={runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project')};let c=await openTestController(options);t.after(async()=>{if(!c.store.closed)await c.stop();await fs.rm(root,{recursive:true,force:true});});const submitted=await c.store.submit('old user goal','old brief',{name:'Old completed Work'});await c.store.activate(submitted.id);const receipt=await c.store.publish(submitted.id,1,'result',staticReport('Exact historical Worker report.'),'legacy-report');await c.store.settle(submitted.id);
 const oldBinding={provider:'omp',model:'native/original-model',effort:'high',skills:['clarification.md','followup.md','git.md','handoff.md','plan-tree.md'],instructions:'Original host-owned curation instructions',instructionDigest:'old-role-digest'};const oldWorkerBinding={provider:'codex',model:'worker/original-model',effort:'low',skills:['report.md'],instructions:'Original Worker instructions',instructionDigest:'old-worker-digest'};const completed={phase:'ended',stopped:true,gitRequired:true,git:{status:'committed',complete:true,commit:'old-completed-commit'},maintenanceRequired:true,maintenance:{status:'complete'}};
 await c.store.mutate(()=>{const s=c.store.state,w=c.store.find(submitted.id);s.bindings.orchestrator=structuredClone(oldBinding);s.residents.orchestrator={threadId:'original-orchestrator-thread',provider:'omp',model:'native/original-model',effort:'high',toolsDigest:'original-native-schema',zeroActivity:false};w.binding=structuredClone(oldWorkerBinding);w.threadId='old-worker-thread';w.status='ended';w.endedBy='user';w.endedAt='2026-10-01T00:00:00.000Z';w.curated=true;w.curationText='Original sourced historical summary';w.closure=structuredClone(completed);s.memoryPending=[w.id];delete s.roleInstructionCutover;delete s.piHostCutover;if(alreadyNormalized){s.workOutcomeCutover=1;w.legacyClosure=structuredClone(completed);w.closure={phase:'blocked',revision:1,error:'Legacy outcome requires explicit user disposition'};s.todos.push({id:'bad-old-normalization',workId:w.id,kind:'closure',status:'open',text:'Legacy outcome is uncertain'});}else delete s.workOutcomeCutover;});await c.stop();
 // Explicitly recreate the persisted pre-reportStateVersion Markdown fixture.
 await historicalMarkdownState(c.store,new Map([[receipt.objectId,'Exact historical Worker report.']]));c=await openTestController(options);
 const s=c.store.state,w=c.store.find(submitted.id),binding=s.bindings.orchestrator;assert.equal(binding.skills.some(skill=>['git.md','plan-tree.md'].includes(skill)),false);assert.equal(binding.provider,'pi');assert.equal(binding.model,undefined);assert.equal(binding.effort,undefined);assert.notEqual(binding.instructions,oldBinding.instructions);assert.deepEqual(s.bindingArchive.find(row=>row.role==='orchestrator'&&!row.workId&&row.reason==='pi-host-cutover').binding,oldBinding);assert.deepEqual(s.bindingArchive.find(row=>row.workId===w.id).binding,oldWorkerBinding);assert.equal(w.binding.provider,oldWorkerBinding.provider);assert.equal(w.binding.model,oldWorkerBinding.model);assert.equal(w.binding.effort,oldWorkerBinding.effort);assert.equal(s.residents.orchestrator,undefined);assert.equal(s.residentArchive.orchestrator.omp.threadId,'original-orchestrator-thread');assert.equal(s.residentArchive.orchestrator.omp.readOnly,true);assert.equal(s.piHostCutover,1);
 const {rolePrompt}=await import('../src/agents/managed/runtime.mjs');assert.equal(typeof await rolePrompt('orchestrator',{skills:binding.skills}),'string');assert.equal(w.status,'ended');assert.equal(w.closure.phase,'complete');assert.equal(w.closure.historical,true);assert.equal(w.closure.legacyOutcomeUnknown,true);assert.equal(w.outcome,undefined);assert.equal(w.closure.decision,undefined);assert.equal(w.endedAt,'2026-10-01T00:00:00.000Z');assert.equal(w.curationText,'Original sourced historical summary');assert.deepEqual(w.legacyClosure,completed);assert.equal(s.memoryPending.includes(w.id),false);assert.equal(s.todos.some(todo=>todo.workId===w.id&&todo.kind==='closure'&&todo.status==='open'),false);assert.equal(s.jobs.length,0);assert.equal(c.sessions.size,0);assert.equal(c.store.used(),0);assert.equal(await readTestObject(c.store,receipt.objectId).then(bytes=>bytes.toString('utf8')),'Exact historical Worker report.');await assert.rejects(fs.stat(c.execution.directory(w.id)),{code:'ENOENT'});
 await c.store.mutate(()=>{s.residents.orchestrator={threadId:'original-orchestrator-thread',provider:'pi',toolsDigest:'original-native-schema',zeroActivity:false};});c.sessionFactory=spec=>({...spec,toolsDigest:'current-native-schema',preflightToolsDigest:async()=>{throw Object.assign(Error('Original native schema requires explicit handoff'),{code:'PI_TOOLS_DIGEST_MISMATCH'});},stop:async()=>{}});await assert.rejects(c.makeSession('orchestrator',{preflightOnly:true}),error=>error.code==='PI_TOOLS_DIGEST_MISMATCH');assert.equal(s.residents.orchestrator.threadId,'original-orchestrator-thread');const archives=s.bindingArchive.length;await c.stop();c=await openTestController(options);assert.equal(c.store.state.bindingArchive.length,archives);assert.equal(c.store.find(w.id).closure.phase,'complete');;assert.equal(c.store.state.roleInstructionCutover,1);
});

test('historical Worker text publication schema requires explicit same-Work handoff without replay',async t=>{
 const {c,w}=await fixture(t),threadId='old-text-publish-thread';
 const identity={id:w.id,agentId:w.agentId,directory:w.execution.directory,branchRef:w.execution.branchRef};
 const oldTools=[{name:'nozeli_publish',parameters:{type:'object',properties:{kind:{type:'string'},text:{type:'string'},files:{type:'array'}},required:['kind','text']}}];
 const file=path.join(c.store.agentHome(w.id),'sessions',threadId+'.jsonl');await fs.mkdir(path.dirname(file),{recursive:true});
 const transcript=JSON.stringify({type:'session',id:threadId})+'\n'+JSON.stringify({type:'tools',tools:oldTools})+'\n';await fs.writeFile(file,transcript);
 await c.store.mutate(()=>{w.threadId=threadId;w.zeroActivity=false;w.toolsDigest='old-text-publish-schema';w.binding={...c.store.state.bindings.worker,provider:'pi'};});
 let starts=0,prompts=0;
 c.sessionFactory=spec=>({...spec,toolsDigest:'html-publish-schema',preflightToolsDigest:async expected=>{assert.equal(expected,'old-text-publish-schema');throw Object.assign(Error('nozeli_publish text to html schema requires handoff'),{code:'PI_TOOLS_DIGEST_MISMATCH'});},start:async()=>{starts++;},prompt:async()=>{prompts++;},stop:async()=>{}});
 await assert.rejects(c.makeSession(w.id),e=>e.code==='PI_TOOLS_DIGEST_MISMATCH');
 assert.equal(w.threadId,threadId);assert.equal(w.toolsDigest,'old-text-publish-schema');assert.equal(starts,0);assert.equal(prompts,0);assert.deepEqual(c.store.state.jobs.map(job=>job.id),['report-job']);
 const handoff=await c.recoverWorkerContext(w.id,{revision:w.revision,oldThreadId:threadId,confirmed:true});
 assert.equal(handoff.automaticReplay,false);assert.equal(handoff.requiresExplicitInput,true);assert.equal(w.threadId,undefined);
 assert.deepEqual({id:w.id,agentId:w.agentId,directory:w.execution.directory,branchRef:w.execution.branchRef},identity);
 assert.equal(await fs.readFile(file,'utf8'),transcript);assert.equal(w.threadArchive.at(-1).toolsDigest,'old-text-publish-schema');assert.deepEqual(c.store.state.jobs.map(job=>job.id),['report-job']);assert.equal(starts,0);assert.equal(prompts,0);
});

test('completed source job with an unknown transport attempt cannot be accepted',async t=>{
 const {c,w,content}=await fixture(t);
 await c.store.mutate(()=>{c.store.state.jobs.find(job=>job.id==='report-job').collabAttempts=[{requestId:'unknown-report-attempt',kind:'prompt',status:'unknown',everAdmitted:true}];});
 await assert.rejects(c.endWork(w.id,{revision:1,decision:'accept'}));
 assert.equal(c.store.find(w.id).status,'review');assert.equal(c.store.find(w.id).closure,undefined);
 assert.equal(await fs.readFile(path.join(content,'result.txt'),'utf8'),'original bytes');
 assert.equal(await fs.readFile(path.join(w.execution.directory,'result.txt'),'utf8'),'candidate bytes');
 assert.equal(c.store.state.jobs.find(job=>job.id==='report-job').status,'completed');
});
