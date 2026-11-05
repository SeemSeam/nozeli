import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {createNozeliPiSource} from '../src/agents/managed/pi-source.mjs';
import {resolveBundledPiRuntime} from '../src/agents/managed/pi-runtime.mjs';
import {createPrivilegeBroker} from '../src/main/privilege-broker.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';

// Real private Pi, Manager/Controller, user-identity broker and synthetic files.
// No paid service, installed-code patch, real elevation or replayed business input.
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-decision-continuation-live-'));
const checks=[],result={ok:false,out,checks,scope:'Real native Pi and actual synthetic file operations; explicit cold suggestion approval/rejection and sensitive current-user execution, deterministic local provider only'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let manager,host,projectId,phase='initial',workerCalls=0,dispatches=0,effectCalls=0;
const root=path.join(out,'project'),config=path.join(out,'private'),profile=path.join(config,'desktop');
await fs.mkdir(root);await fs.writeFile(path.join(root,'baseline.txt'),'original source\n');
const source=createNozeliPiSource({root:config});
const last=(request,id)=>{const row=request.messages.findLast(message=>message.role==='tool');assert.equal(row?.tool_call_id,id);const text=typeof row.content==='string'?row.content:row.content.map(part=>part.text??'').join('');return JSON.parse(text);};
const call=(id,tool,args)=>({id,tool,args});
const marker=path.join(out,'approved-effect.txt');
const frozenEffect={command:process.execPath,args:['-e',`require('node:fs').appendFileSync(${JSON.stringify(marker)},'APPROVED_ONCE\\n')`],cwd:root,elevation:'user',dangerousEffect:'Synthetic acceptance marks a declared sensitive effect; only an isolated marker is appended',purpose:'Execute the exact user-approved synthetic marker once'};
const provider=await serve(async request=>{
 const orchestratorJob=manager?.controllers.get(projectId)?.current.get('orchestrator');
 if(orchestratorJob?.type==='backstage')return call('preserve-user-decision-'+orchestratorJob.id,'nozeli_backstage_respond',{blocked:true,reason:'This synthetic problem requires the explicit original user decision; do not dispatch or continue independently.'});
 const names=request.tools?.map(tool=>tool.function?.name)??[];
 if(names.includes('nozeli_publish')){
  workerCalls++;
  if(phase==='initial')return call('initial-problem','nozeli_publish',{kind:'problem',content:'Proposed treatment: write only approved.txt in the original candidate, then verify. Preserve baseline.txt and completed work.',files:[]});
  if(phase==='approve'){
   if(!request.messages.some(message=>message.tool_call_id==='approved-write'))return call('approved-write','write',{path:'approved.txt',content:'APPROVED_PROPOSAL\n'});
   return call('second-problem','nozeli_publish',{kind:'problem',content:'Proposed additional treatment: replace approved.txt. Await the user decision before proceeding.',files:['approved.txt']});
  }
  if(phase==='reject'){
   if(!request.messages.some(message=>message.tool_call_id==='feedback-write'))return call('feedback-write','write',{path:'feedback.txt',content:'EXACT_USER_FEEDBACK_APPLIED\n'});
   return call('final-result','nozeli_publish',{kind:'result',content:staticReport('User rejection honored; approved.txt preserved and feedback.txt written. No task replacement or original input replay.'),files:['approved.txt','feedback.txt']});
  }
 }
 if(names.includes('nozeli_dispatch')){assert.equal(dispatches++,0,'one original business dispatch');return call('dispatch-original','nozeli_dispatch',{name:'Original suggestion task',brief:'Publish a problem and execute only the exact subsequent user decisions on this same Work.'});}
 if(names.includes('nozeli_privileged_execute')){
  effectCalls++;
  const id=phase==='effect-initial'?'effect-request':'effect-approved';
  if(!request.messages.some(message=>message.tool_call_id===id))return call(id,'nozeli_privileged_execute',frozenEffect);
  const receipt=last(request,id);assert.notEqual(receipt.ok,false,JSON.stringify(receipt));return {text:'Exact approved synthetic operation verified. No additional execution.'};
 }
 return {text:'No extra business operation.'};
});
async function until(fn,label,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){if(provider.errors.length)throw provider.errors[0];const value=await fn();if(value)return value;await pause(40);}throw Error('Timed out: '+label);}
const state=()=>manager.controllers.get(projectId)?.store.state;
const idle=()=>!manager.controllers.get(projectId)?.running.size&&!manager.controllers.get(projectId)?.kicking;
async function openManager(){manager=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},piSource:source,piRuntime:await resolveBundledPiRuntime({piHome:source.agentDir}),privilegeBroker:createPrivilegeBroker({interpreter:process.execPath}),idleTimeoutMs:60000});await manager.processBudget.save(3);return manager;}
try{
 await fs.mkdir(source.agentDir,{recursive:true});
 await fs.writeFile(path.join(source.agentDir,'models.json'),JSON.stringify({providers:{'decision-local':{baseUrl:provider.url,api:'openai-completions',apiKey:'local-nonsecret',models:[{id:'scripted',name:'Synthetic decision continuation',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:4096}]}}}),{mode:0o600});
 source.modelFor=async()=> 'decision-local/scripted';source.roleDefaultsFor=async()=>({selector:'decision-local/scripted',effort:'off'});
 host=new DesktopHost(profile);projectId=(await host.pick(root)).project.id;
 await openManager();await manager.connect(projectId,{enable:true});
 await manager.invoke('managed.task',{projectId,text:'Original user task; await explicit proposal decisions',requestKey:'decision-original-task'});
 await until(()=>state()?.works[0]?.status==='paused'&&idle(),'original actionable problem publication');
 let work=structuredClone(state().works[0]);const workId=work.id,thread=work.threadId,directory=work.execution.directory;
 const initialJob=state().jobs.find(job=>job.target===workId);assert.equal(initialJob.status,'completed');
 const approvedPayload={projectId,workId,objectId:work.problem.objectId,revision:work.revision,action:'approve',requestKey:'decision-cold-approve'};
 await manager.stop();await openManager();phase='approve';
 const approved=await manager.invoke('managed.problem.resolve',approvedPayload);result.approval=approved;
 await until(()=>state()?.works.find(row=>row.id===workId)?.status==='paused'&&state().jobs.find(job=>job.id===approved.jobId)?.status==='completed'&&idle(),'cold user approval actually executes without a second connect');
 work=structuredClone(state().works.find(row=>row.id===workId));assert.equal(work.threadId,thread);assert.equal(work.execution.directory,directory);assert.equal(await fs.readFile(path.join(directory,'approved.txt'),'utf8'),'APPROVED_PROPOSAL\n');assert.equal(await fs.readFile(path.join(root,'baseline.txt'),'utf8'),'original source\n');
 checks.push('cold explicit proposal approval starts the exact queued continuation and performs real candidate writes on the original Work/thread without a second connect');
 const rejectedPayload={projectId,workId,objectId:work.problem.objectId,revision:work.revision,action:'reject',text:'Do not replace approved.txt; preserve it and create feedback.txt with the exact feedback result.',requestKey:'decision-cold-reject'};
 await manager.stop();await openManager();phase='reject';
 const rejected=await manager.invoke('managed.problem.resolve',rejectedPayload);result.rejection=rejected;
 await until(()=>state()?.works.find(row=>row.id===workId)?.status==='review'&&idle(),'cold rejection feedback actually performs remaining work');
 assert.equal(await fs.readFile(path.join(directory,'approved.txt'),'utf8'),'APPROVED_PROPOSAL\n');assert.equal(await fs.readFile(path.join(directory,'feedback.txt'),'utf8'),'EXACT_USER_FEEDBACK_APPLIED\n');
 assert.equal(state().works.length,1);assert.equal(state().works[0].threadId,thread);assert.equal(state().jobs.filter(job=>job.target===workId).length,3);assert.equal(dispatches,1);
 const before=provider.requests.length;await manager.invoke('managed.problem.resolve',rejectedPayload);await pause(200);assert.equal(provider.requests.length,before,'completed decision replay never wakes another model turn');
 checks.push('cold reject+exact feedback preserves prior progress and publishes once; duplicate completed decision never replays the original task or starts another owner');
 phase='effect-initial';await manager.invoke('managed.send',{projectId,target:'frontdesk',text:'Execute the exact sensitive synthetic marker only after explicit authorization',requestKey:'decision-effect-original'});
 const request=await until(async()=>{const permissions=await manager.permissions.read(projectId);return permissions.requests.find(row=>row.kind==='effect'&&row.status==='pending')??null;},'actual native effect authorization request');
 await until(idle,'effect input stops at the real permission boundary');await assert.rejects(fs.stat(marker),{code:'ENOENT'});
 phase='effect-approved';const approvalPayload={projectId,attentionKind:'effect-permission',attentionId:request.id,sourceJobId:request.sourceJobId,expectedVersion:request.version,action:'approve-once',requestKey:'decision-effect-approve'};
 const decisions=await Promise.all([manager.invoke('managed.effect.response',approvalPayload),manager.invoke('managed.effect.response',approvalPayload)]);result.effect=decisions;
 await until(async()=>idle()&&await fs.readFile(marker,'utf8').catch(()=>null)==='APPROVED_ONCE\n','approved effect actually executes once');
 assert.equal(state().jobs.filter(job=>job.context?.effectRequestId===request.id).length,1,'concurrent approval creates one exact continuation');
 const after=provider.requests.length;await manager.invoke('managed.effect.response',approvalPayload);await pause(200);assert.equal(await fs.readFile(marker,'utf8'),'APPROVED_ONCE\n');assert.equal(provider.requests.length,after);
 checks.push('native sensitive request executes a real current-user command only after explicit approval; concurrent and repeated approvals produce one continuation and one effect');
 result.ok=true;result.workId=workId;result.threadId=thread;result.jobs=state().jobs.map(({id,type,target,status,revision})=>({id,type,target,status,revision}));result.requests=provider.requests.length;result.workerCalls=workerCalls;result.effectCalls=effectCalls;
}catch(error){result.error=error.stack;result.state=state();process.exitCode=1;}
finally{await manager?.stop().catch(()=>{});await host?.storage.db.close().catch(()=>{});await provider.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
