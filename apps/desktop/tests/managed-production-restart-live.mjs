// Production startup qualification: real ManagedProjects/local promotion, native
// private Pi owners, durable journals, real files/Git and a loopback provider.
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
import {controlApi} from './agent-control.fixture.mjs';

const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-managed-restart-live-'));
const root=path.join(out,'project'),config=path.join(out,'private'),profile=path.join(config,'desktop');
await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'source.txt'),'Original synthetic source.\n');
await fs.writeFile(path.join(root,'.gitignore'),'/.nozeli/\n');
for(const args of [['init','-b','main'],['config','user.name','Synthetic Restart'],['config','user.email','restart@localhost'],['add','--all'],['commit','-m','Synthetic baseline']])await runGit(root,args);
const host=new DesktopHost(profile),source=createNozeliPiSource({root:config});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;const failed=controller()?.store.state.jobs.find(job=>job.status==='failed');if(failed)throw Error('Actual production job failed while waiting for '+label+': '+failed.error);await pause(25);}throw Error('Timed out: '+label);}
function barrier(){let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};}
const orchGate=barrier(),workerGate=barrier();let orchHeld=false,workerHeld=false,manager,projectId,runtime;
const checks=[],diagnostics=[],result={ok:false,out,checks,scope:'Production ManagedProjects startup and localOnly promotion; real private native Pi/Git/files and scripted loopback provider only'};
const controller=()=>manager?.controllers.get(projectId);
function lastTool(request){return request.messages.findLast(row=>row.role==='tool');}
function toolOkay(request){const row=lastTool(request);assert(row);assert(!/nozeli host rejected|"isError":true/.test(JSON.stringify(row.content)),JSON.stringify(row));return row;}
const provider=await serve(async request=>{
 assert(provider.requests.length<30,'no runaway replay');
 const current=[...(controller()?.current.values()??[])].find(job=>!['frontdesk'].includes(job.target));
 const names=request.tools?.map(tool=>tool.function?.name)??[];
 if(names.includes('nozeli_publish')){
  const work=controller().store.find(current.target),queued=work.name==='Queued once',prefix=queued?'queue':'worker';
  const previous=lastTool(request);
  if(previous?.tool_call_id===prefix+'-write-once'){
   toolOkay(request);
   if(!queued&&!workerHeld){workerHeld=true;await workerGate.promise;return {text:'Fixture response after original owner has stopped.'};}
   return {id:prefix+'-publish-once',tool:'nozeli_publish',args:{kind:'result',content:'<h1>Restart-qualified result</h1><p>Original native tool result retained and no duplicate effect.</p>',files:['result.txt']}};
  }
  assert(names.includes('bash'),'actual native bash tool required');
  return {id:prefix+'-write-once',tool:'bash',args:{command:`printf '${prefix}-once\\n' >> '${path.join(out,prefix+'-effects.txt')}'\nprintf '${prefix} candidate\\n' > result.txt`}};
 }
 if(current?.target==='orchestrator'&&current.type==='intake'){
  const previous=lastTool(request);
  if(previous?.tool_call_id==='orch-write-once'){
   toolOkay(request);
   if(!orchHeld){orchHeld=true;await orchGate.promise;return {text:'Fixture response after original owner has stopped.'};}
   return {id:'orch-dispatch-once',tool:'nozeli_dispatch',args:{name:'Restart original Work',brief:'Write result.txt once, then publish the exact file in a final HTML report.'}};
  }
  assert(names.includes('bash'),'actual Orchestrator native bash required');
  return {id:'orch-write-once',tool:'bash',args:{command:`printf 'orchestrator-once\\n' >> '${path.join(out,'orch-effects.txt')}'`}};
 }
 return {text:'No new business input.'};
});
async function makeManager(){
 const value=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},piSource:source,piRuntime:runtime});
 value.onEvent(event=>{if(event.kind==='managed-error')diagnostics.push(event.text);});return value;
}
async function stop(){await manager.stop();}
function attemptFor(c,jobId){return c.store.state.jobs.find(job=>job.id===jobId)?.collabAttempts?.findLast(a=>a.kind==='prompt'&&!a.definitiveRejection);}
function users(c,sessionId){return (c.store.state.sessionIndex?.entries??[]).filter(row=>row.sessionId===sessionId&&row.speaker==='user');}
async function oneEffect(name){const text=await fs.readFile(path.join(out,name+'-effects.txt'),'utf8');assert.equal(text.trim().split('\n').length,1,text);}
try{
 await fs.mkdir(source.agentDir,{recursive:true});await fs.writeFile(path.join(source.agentDir,'models.json'),JSON.stringify({providers:{'restart-local':{baseUrl:provider.url,api:'openai-completions',apiKey:'local-nonsecret',models:[{id:'scripted',name:'Scripted Restart',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}]}}}),{mode:0o600});
 source.modelFor=async()=> 'restart-local/scripted';source.roleDefaultsFor=async()=>({selector:'restart-local/scripted',effort:'off'});
 runtime=await resolveBundledPiRuntime({piHome:source.agentDir});
 projectId=(await host.pick(root)).project.id;
 manager=await makeManager();await manager.processBudget.save(4);await manager.connect(projectId,{enable:true});
 const first=controller();await first.store.mutate(()=>{first.store.state.limit=2;});
 const intake=await first.enqueue('orchestrator','intake','Create the restart qualification task, preserving the original native turn and effect exactly once.');
 await until(()=>orchHeld&&attemptFor(first,intake.jobId)?.nativeEntryId,'Orchestrator durable user entry and tool result before Work exists');
 assert.equal(first.store.state.works.length,0);const orchThread=first.store.state.residents.orchestrator.threadId,orchEntry=attemptFor(first,intake.jobId).nativeEntryId;
 assert.equal(attemptFor(first,intake.jobId).nativeUserEntryConfirmed,true);assert.equal(users(first,orchThread).length,1);
 await stop();orchGate.open();await oneEffect('orch');
 manager=await makeManager();const resumedOrch=await manager.resumeUnfinishedProjects();assert(resumedOrch.resumed.includes(projectId),JSON.stringify(resumedOrch));
 await until(()=>workerHeld&&controller()?.store.state.works.length===1,'original Orchestrator continuation dispatches one Worker');
 const second=controller(),work=second.store.state.works[0],workerJob=second.store.state.jobs.find(job=>job.target===work.id&&job.type==='initial');
 await until(()=>attemptFor(second,workerJob.id)?.nativeEntryId,'Worker durable user entry before prompt return');
 assert.equal(second.store.state.residents.orchestrator.threadId,orchThread);assert.equal(attemptFor(second,intake.jobId).nativeEntryId,orchEntry);assert.equal(users(second,orchThread).length,1);await oneEffect('orch');
 const workerIdentity={id:work.id,jobId:workerJob.id,threadId:work.threadId,entryId:attemptFor(second,workerJob.id).nativeEntryId,revision:work.revision};
 checks.push('Production startup promotes a localOnly controller and resumes original Orchestrator before Work creation, with one original user entry and one real shell effect');
 await stop();workerGate.open();await oneEffect('worker');
 manager=await makeManager();const resumedWorker=await manager.resumeUnfinishedProjects();assert(resumedWorker.resumed.includes(projectId),JSON.stringify(resumedWorker));
 await until(()=>controller()?.store.find(workerIdentity.id).status==='review'&&!controller().running.size,'original Worker reaches review after restart');
 const third=controller(),review=third.store.find(workerIdentity.id);
 assert.equal(review.threadId,workerIdentity.threadId);assert.equal(review.revision,workerIdentity.revision);assert.equal(third.store.state.jobs.find(job=>job.id===workerIdentity.jobId).status,'completed');
 assert.equal(attemptFor(third,workerIdentity.jobId).nativeEntryId,workerIdentity.entryId);assert.equal(users(third,workerIdentity.threadId).length,1);assert.equal(third.store.state.receipts.filter(row=>row.workId===review.id&&row.kind==='result').length,1);await oneEffect('worker');
 checks.push('Production restart resumes the exact Worker job/thread/journal without another user prompt or shell effect, then publishes one durable review result');
 await stop();
 manager=await makeManager();const local=await manager.loadLocal(projectId),before=provider.requests.length;
 assert.equal(local.localOnly,true);assert.equal(local.started,false);
 const paused=await local.store.submit('Explicitly paused task','Pause must survive startup',{name:'Paused never run'});
 await controlApi.controllerControl(local,{workId:paused.id,action:'pause',requestKey:'restart-explicit-pause'});
 const cancelled=await local.store.submit('Explicitly deleted task','Delete before execution',{name:'Deleted never run'});
 const deletion=await manager.disposition(projectId,cancelled.id);
 await manager.invoke('managed.end',{projectId,workId:cancelled.id,revision:0,decision:'discard',binding:deletion.binding,requestKey:'restart-explicit-delete'});
 const queued=await local.store.submit('Never admitted queued task','Write result.txt once and publish it',{name:'Queued once'});
 await local.setDraft('frontdesk','UNSENT FRONTDESK DRAFT');assert.equal(provider.requests.length,before);
 await stop();manager=await makeManager();await manager.resumeUnfinishedProjects();
 await until(()=>controller()?.store.find(queued.id).status==='review'&&!controller().running.size,'never admitted queue runs once');
 const final=controller();assert.equal(final.store.find(paused.id).status,'queued');assert.ok(final.store.find(paused.id).manualControl.pause);assert.equal(final.store.find(cancelled.id).status,'ended');assert.equal(final.store.find(cancelled.id).outcome,'discard');assert.equal(final.store.state.jobs.filter(job=>[paused.id,cancelled.id].includes(job.target)).length,0);
 assert.equal(final.store.state.jobs.filter(job=>job.target===queued.id&&job.type==='initial').length,1);assert.equal(final.store.state.receipts.filter(row=>row.workId===queued.id&&row.kind==='result').length,1);assert.equal(final.store.state.drafts.frontdesk,'UNSENT FRONTDESK DRAFT');await oneEffect('queue');
 checks.push('A never-admitted queue activates exactly once through production startup; explicit pause/delete and unsent Frontdesk draft remain durable and undispatched');
 assert.equal(provider.errors.length,0,provider.errors.map(error=>error.stack).join('\n'));
 result.ok=true;result.identity={projectId,orchThread,orchEntry,workerIdentity,queuedId:queued.id,pausedId:paused.id,cancelledId:cancelled.id};result.requests=provider.requests.length;
}catch(error){result.error=error.stack;result.state=controller()?.snapshot();result.nativeEntries=controller()?.store.state.sessionIndex?.entries?.map(({sessionId,entryId,requestId,jobId,epoch,target,speaker,ownership})=>({sessionId,entryId,requestId,jobId,epoch,target,speaker,ownership}));result.providerErrors=provider.errors.map(error=>error.stack);process.exitCode=1;}
finally{
 orchGate.open();workerGate.open();await manager?.stop().catch(error=>{result.ok=false;result.cleanupError=error.stack;process.exitCode=1;});await provider.close();await host.storage.db.close();result.diagnostics=diagnostics;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
