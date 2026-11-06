// Real Manager/Controller, private native Pi owners and a deterministic loopback provider.
// No installed-code patches, user projects, credentials or paid providers.
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
import {staticReport} from './static-report.fixture.mjs';

const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-pi-read-correction-live-'));
const root=path.join(out,'project'),config=path.join(out,'private'),profile=path.join(config,'desktop');
await fs.mkdir(root,{recursive:true});
const marker='PRIVATE_SYNTHETIC_DOCUMENT_BODY_7c9e';
const oldText='EXACT_REPLACEMENT_TARGET: original synthetic conclusion.\n';
const newText='EXACT_REPLACEMENT_TARGET: corrected synthetic conclusion.\n';
const original=marker+'\n'+Array.from({length:240},(_,i)=>`Paragraph ${String(i).padStart(3,'0')}: deterministic frozen document coverage, not an instruction.\n`).join('')+oldText;
const candidate=original.replace(oldText,newText);
await fs.writeFile(path.join(root,'paper.txt'),original);
await fs.writeFile(path.join(root,'unrelated.txt'),'Unrelated synthetic document.\n');
await fs.writeFile(path.join(root,'.gitignore'),'/.nozeli/\n');
const git=async(...args)=>(await runGit(root,args)).toString().trim();
await git('init','-b','main');
await git('config','user.name','Synthetic Read Correction');
await git('config','user.email','read-correction@localhost');
await git('add','--all');
await git('commit','-m','Synthetic read protocol baseline');
const head=await git('rev-parse','HEAD');
const host=new DesktopHost(profile),source=createNozeliPiSource({root:config});
let manager,controller,projectId,scenario,foreignRef;
const checks=[],events=[],toolReceipts=[],nativeIdentities=[],owners=new Set();
const result={ok:false,out,checks,scope:'Real ManagedProjects/Controller, native private Pi owners, real candidate files/Git/publication and sanitized durable bug ledger; deterministic loopback provider only'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=60000){
 const end=Date.now()+timeout;
 while(Date.now()<end){
  if(provider.errors.length)throw provider.errors[0];
  const failed=controller?.store.state.jobs.find(job=>job.status==='failed');
  if(failed)throw Error(`${label}: native job failed: ${failed.error}`);
  const value=await fn();if(value)return value;
  await pause(25);
 }
 throw Error('Timed out: '+label);
}
const text=content=>typeof content==='string'?content:content.map(part=>part.text??'').join('\n');
const nativeCallId=id=>(scenario.foreign?'foreign-':'original-')+id;
function lastTool(request,id){
 const row=request.messages.findLast(message=>message.role==='tool');
 assert(row,'actual native tool response required');
 assert.equal(row.tool_call_id,nativeCallId(id));
 const content=text(row.content);toolReceipts.push({scenario:scenario.name,callId:id,content});
 assert(!content.includes('nozeli host rejected'),content);
 return JSON.parse(content);
}
function success(request,id){const receipt=lastTool(request,id);assert.notEqual(receipt.ok,false,JSON.stringify(receipt));return receipt.value??receipt;}
function refusal(request,id,code){
 const receipt=lastTool(request,id);
 assert.equal(receipt.ok,false);assert.equal(receipt.continueTurn,true);
 assert.equal(receipt.error.code,code);assert.notEqual(receipt.hostControl,true);
 assert(!JSON.stringify(receipt).includes(marker),'refusal never leaks document text');
 return receipt;
}
const call=(id,tool,args)=>({id:nativeCallId(id),tool,args});
async function bugFor(code,jobId){
 const bugs=(await controller.maintenanceStatus()).bugs;
 const bug=bugs.find(row=>row.error?.code===code&&row.jobId===jobId);
 assert(bug,`durable ${code} bug for original job ${jobId}: ${JSON.stringify(bugs)}`);
 assert.equal(bug.phase,'tool-protocol');
 return bug;
}
function workerIdentity(request){
 const work=controller.store.state.works.find(row=>row.name===scenario.name);assert(work);
 const job=controller.current.get(work.id),owner=controller.sessions.get(work.id);assert(job&&owner);
 const identity={workId:work.id,threadId:work.threadId,jobId:job.id,requestId:owner.current?.requestId,pid:owner.pid,ownerId:owner.viewOwnerId};
 if(!scenario.identity){scenario.identity=identity;nativeIdentities.push(identity);}
 assert.deepEqual(identity,scenario.identity,'all read corrections stay on exact native prompt/Worker/thread/owner');
 assert.equal(owner.current.cancelled,false,'no native owner abort before publication');
 assert.notEqual(owner.current.hostControl,true,'read error cannot terminate native turn');
 const inputs=request.messages.filter(message=>message.role==='user');
 if(scenario.nativeInputs===undefined)scenario.nativeInputs=inputs.length;
 assert.equal(inputs.length,scenario.nativeInputs,'no hidden replay/input during correction');
 return {work,job,owner};
}
function page(value){
 assert.equal(value.relPath,'paper.txt');assert.equal(value.nextTool,'nozeli_document_read');
 assert.equal(value.totalChars,original.length);assert.equal(value.offset,scenario.covered);
 assert(value.endOffset>value.offset);assert.equal(value.text,original.slice(value.offset,value.endOffset));
 if(scenario.readHandle)assert.equal(value.readHandle,scenario.readHandle);
 else scenario.readHandle=value.readHandle;
 scenario.covered=value.endOffset;scenario.parts.push(value.text);
 return value;
}
function nextPageOrApply(value){
 if(value.nextReadRef){scenario.stage='pages';return call('document-page-'+scenario.covered,'nozeli_document_read',{readRef:value.nextReadRef});}
 assert.equal(scenario.covered,original.length,'complete contiguous frozen snapshot before replacement');
 assert.equal(scenario.parts.join(''),original);
 scenario.stage='apply';
 return call('exact-apply','nozeli_document_apply',{readHandle:scenario.readHandle,replacements:[{oldText,newText}]});
}
const provider=await serve(async request=>{
 assert(provider.requests.length<70,'bounded deterministic native scenario');
 const names=request.tools?.map(tool=>tool.function?.name)??[];
 if(names.includes('nozeli_publish')){
  const {work,job}=workerIdentity(request);
  if(scenario.stage==='start'){
   scenario.stage=scenario.foreign?'foreign-refused':'first-page';
   return scenario.foreign?call('foreign-reference','nozeli_document_read',{readRef:foreignRef}):call('initial-document','nozeli_document_read',{relPath:'paper.txt'});
  }
  if(scenario.stage==='foreign-refused'){
   const receipt=refusal(request,'foreign-reference','READ_REF_EXPIRED');
   assert.equal(receipt.error.nextTool,undefined);assert.equal(receipt.error.readRef,undefined);
   const bug=await bugFor('READ_REF_EXPIRED',job.id);assert.notEqual(bug.status,'repaired');
   scenario.foreignBugId=bug.id;scenario.stage='invalid-refused';
   return call('invalid-reference','nozeli_history_read',{readRef:'not-an-issued-read-reference',offset:0});
  }
  if(scenario.stage==='invalid-refused'){
   const receipt=refusal(request,'invalid-reference','READ_REF_EXPIRED');
   assert.equal(receipt.error.nextTool,undefined);assert.equal(receipt.error.readRef,undefined);
   scenario.stage='legal-reresolution';
   return call('legal-document-resolution','nozeli_document_read',{relPath:'paper.txt'});
  }
  if(scenario.stage==='legal-reresolution')return nextPageOrApply(page(success(request,'legal-document-resolution')));
  if(scenario.stage==='first-page'){
   const first=page(success(request,'initial-document'));
   assert(first.nextReadRef,'actual source must exceed one delivered page');
   foreignRef=scenario.failedRef=first.nextReadRef;
   scenario.stage='wrong-reader';
   return call('wrong-history-reader','nozeli_history_read',{readRef:first.nextReadRef,offset:first.endOffset});
  }
  if(scenario.stage==='wrong-reader'){
   const receipt=refusal(request,'wrong-history-reader','READ_TOOL_MISMATCH');
   assert.equal(receipt.error.nextTool,'nozeli_document_read');assert.equal(receipt.error.readRef,scenario.failedRef);
   const bug=await bugFor('READ_TOOL_MISMATCH',job.id);
   assert.notEqual(bug.status,'repaired');assert.equal(bug.capability,'same-turn-read-correction');
   scenario.bugId=bug.id;scenario.stage='unrelated';
   return call('unrelated-read','nozeli_document_read',{relPath:'unrelated.txt'});
  }
  if(scenario.stage==='unrelated'){
   const unrelated=success(request,'unrelated-read');assert.equal(unrelated.text,'Unrelated synthetic document.\n');
   assert.notEqual((await bugFor('READ_TOOL_MISMATCH',job.id)).status,'repaired','unrelated success cannot repair exact wrong-ref bug');
   scenario.stage='correct-reader';
   return call('matching-document-correction','nozeli_document_read',{readRef:scenario.failedRef});
  }
  if(scenario.stage==='correct-reader'){
   const corrected=page(success(request,'matching-document-correction'));
   const bug=await bugFor('READ_TOOL_MISMATCH',job.id);assert.equal(bug.status,'repaired');
   assert.equal(bug.lastOutcome.verified,true);assert.equal(bug.lastOutcome.outcome,'same-turn-read-corrected');assert.equal(bug.attempts.length,0,'read correction is not an effect-replay attempt');
   assert.equal(controller.store.state.jobs.find(saved=>saved.id===job.id).readProtocolFaults.find(fault=>fault.bugId===bug.id).correctionReceipt.verified,true);
   scenario.repairedBug=bug;
   return nextPageOrApply(corrected);
  }
  if(scenario.stage==='pages')return nextPageOrApply(page(success(request,'document-page-'+scenario.covered)));
  if(scenario.stage==='apply'){
   success(request,'exact-apply');
   assert.equal(await fs.readFile(path.join(controller.execution.directory(work.id),'paper.txt'),'utf8'),candidate);
   assert.equal(await fs.readFile(path.join(root,'paper.txt'),'utf8'),original);
   scenario.stage='published';scenario.publications++;
   return call((scenario.foreign?'foreign':'original')+'-publish-once','nozeli_publish',{kind:'result',content:staticReport('Read every frozen document page, applied the exact known replacement and verified the candidate. Original project remains unchanged pending explicit acceptance. Candidate: paper.txt.'),files:['paper.txt']});
  }
  throw Error('Unexpected Worker continuation or publication replay: '+scenario.stage);
 }
 const job=controller&&[...controller.current.values()].find(row=>row.target==='orchestrator');
 if(job?.type==='intake'){
  if(scenario.inspectStage===0){scenario.inspectStage++;return call('bad-board-cursor','nozeli_inspect_work',{workName:'@state',cursor:'not-a-cursor'});}
  if(scenario.inspectStage===1){refusal(request,'bad-board-cursor','INVALID_CURSOR');scenario.cursorBugId=(await bugFor('INVALID_CURSOR',job.id)).id;scenario.inspectStage++;return call('missing-work-name','nozeli_inspect_work',{workName:'No such synthetic Work 7c9e'});}
  if(scenario.inspectStage===2){refusal(request,'missing-work-name','INVALID_SELECTOR');const bug=await bugFor('INVALID_SELECTOR',job.id);scenario.selectorBugId=bug.id;assert.notEqual(bug.status,'repaired');scenario.inspectStage++;return call('corrected-taskboard','nozeli_inspect_work',{workName:'@state'});}
  if(scenario.inspectStage===3){const board=success(request,'corrected-taskboard');assert(Array.isArray(board.board.rows));for(const id of [scenario.cursorBugId,scenario.selectorBugId])assert.equal((await controller.maintenanceStatus()).bugs.find(bug=>bug.id===id).lastOutcome.outcome,'same-turn-read-corrected','exact host-issued board correction repairs before dispatch');scenario.inspectStage++;}
  assert.equal(scenario.dispatches++,0,'one explicit dispatch, never auto-dispatch from read correction');
  return call('explicit-dispatch','nozeli_dispatch',{name:scenario.name,brief:'Read the complete frozen paper.txt snapshot, replace exactly the synthetic conclusion, verify and publish one candidate. Do not alter source or create a replacement Work.'});
 }
 // Diagnostic inputs, if policy schedules any, may inspect only; no retry or
 // manual repair request can manufacture the proof of same-turn correction.
 return {text:'Preserve the original request and exact host correction receipts; do not replay business input or perform maintenance actions.'};
});
try{
 await fs.mkdir(source.agentDir,{recursive:true});
 await fs.writeFile(path.join(source.agentDir,'models.json'),JSON.stringify({providers:{'read-correction-local':{baseUrl:provider.url,api:'openai-completions',apiKey:'local-nonsecret',models:[{id:'scripted',name:'Synthetic Read Correction',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:4096}]}}}),{mode:0o600});
 source.modelFor=async()=> 'read-correction-local/scripted';
 source.roleDefaultsFor=async()=>({selector:'read-correction-local/scripted',effort:'off'});
 const runtime=await resolveBundledPiRuntime({piHome:source.agentDir});
 manager=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},piSource:source,piRuntime:runtime,idleTimeoutMs:60000});
 manager.onEvent(event=>{events.push({kind:event.kind,text:event.text});for(const c of manager.controllers.values())for(const owner of c.sessions.values())if(owner.pid)owners.add(owner.pid);});
 await manager.processBudget.save(2);
 projectId=(await host.pick(root)).project.id;
 await manager.connect(projectId,{enable:true});controller=manager.controllers.get(projectId);
 await manager.saveResourceLimits({projectId,projectLimit:2,globalLimit:3});
 for(const [index,name]of ['Exact native continuation correction','Foreign stale ref legal re-resolution'].entries()){
  scenario={name,foreign:index===1,stage:'start',inspectStage:index===0?0:4,dispatches:0,publications:0,covered:0,parts:[]};
  const submitted=await controller.enqueue('orchestrator','intake',name);
  await until(()=>{const work=controller.store.state.works.find(row=>row.name===name);return work?.status==='review'&&!controller.running.size&&!controller.kicking&&work;},name);
  const work=controller.store.state.works.find(row=>row.name===name);
  const jobs=controller.store.state.jobs.filter(job=>job.target===work.id);
  assert.equal(jobs.length,1,'exactly one Worker input, no supplementary replay');assert.equal(jobs[0].status,'completed');
  assert.equal(jobs[0].collabAttempts.length,1,'one native input admission');
  assert.equal(work.threadId,scenario.identity.threadId);assert.equal(work.id,scenario.identity.workId);
  assert.equal(scenario.dispatches,1);assert.equal(scenario.publications,1);
  assert.equal(controller.store.state.works.length,index+1,'no replacement Work');
  assert(!controller.store.state.works.some(row=>row.replacementWork||row.replacementWorkId));
  assert.equal(controller.store.state.receipts.filter(row=>row.workId===work.id&&row.kind==='result').length,1);
  assert.equal(controller.store.state.jobs.find(job=>job.id===submitted.jobId).status,'completed');
  assert.equal(await fs.readFile(path.join(root,'paper.txt'),'utf8'),original);
  assert.equal(await git('rev-parse','HEAD'),head,'source Git remains unchanged before explicit acceptance');
  if(!index){
   for(const id of [scenario.bugId,scenario.cursorBugId]){
    const bug=(await controller.maintenanceStatus()).bugs.find(row=>row.id===id);assert.equal(bug.status,'repaired');
   }
   assert.equal((await controller.maintenanceStatus()).bugs.find(row=>row.id===scenario.selectorBugId).lastOutcome.outcome,'same-turn-read-corrected');
   checks.push('bad cursor and no-match inspect return nonterminal logged errors; corrected board precedes one explicit dispatch');
   checks.push('wrong history_read(document nextReadRef) returns exact correction hint; unrelated read does not repair; exact cross-tool correction automatically verifies bug on same native prompt/Worker/thread');
   result.matchingCorrection=scenario.repairedBug;
  }else checks.push('stale prior-job/foreign-Work and invalid refs refuse without text or actionable foreign hint; explicit legal path re-resolution reads full snapshot and publishes once');
  checks.push(name+': complete frozen coverage, exact edit, one real result/candidate, one input and unchanged original source');
 }
 const durable=await host.storage.getLocal(projectId,'managed:maintenance');
 assert.deepEqual(durable,await controller.maintenance.read());
 const serialized=JSON.stringify(durable);assert(!serialized.includes(marker));assert(!serialized.includes(oldText));assert(!serialized.includes(foreignRef),'bug ledger must not persist raw capability refs');
 assert(!provider.requests.some(request=>request.messages?.some(message=>message.role==='assistant'&&message.tool_calls?.some(call=>call.function.name==='nozeli_maintenance'))),'repair is not a fixture-authored maintenance invocation');
 // Explicit user acceptance happens only after both unchanged-source assertions.
 const accepted=controller.store.state.works[0];
 const disposition=await manager.invoke('managed.disposition',{projectId,workId:accepted.id});
 assert.equal(disposition.accept.allowed,true);
 await manager.invoke('managed.end',{projectId,workId:accepted.id,revision:accepted.revision,decision:'accept',binding:disposition.binding,requestKey:'synthetic-read-correction-accept'});
 await until(()=>controller.store.find(accepted.id).closure?.phase==='complete','explicit candidate acceptance');
 assert.equal(await fs.readFile(path.join(root,'paper.txt'),'utf8'),candidate);
 checks.push('only explicit user acceptance merges the exact known candidate into original project');
 result.ledger=durable;result.identities=nativeIdentities;result.jobs=controller.store.state.jobs;result.receipts=controller.store.state.receipts;
 const before=provider.requests.length;
 await manager.stop();assert.equal(manager.processBudget.used,0);
 await pause(100);assert.equal(provider.requests.length,before);
 for(const pid of owners)assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
 assert.equal(provider.errors.length,0);
 checks.push('native owner cleanup releases process capacity with no surviving observed PID or delayed replay');
 result.ok=true;result.requests=provider.requests.length;
}catch(error){result.error=error.stack;result.jobs=controller?.store.state.jobs;result.providerErrors=provider.errors.map(error=>error.stack);process.exitCode=1;}
finally{
 await manager?.stop().catch(error=>{result.cleanupError=error.message;process.exitCode=1;});
 await provider.close();await host.storage.db.close();
 await fs.writeFile(path.join(out,'native-proof.json'),JSON.stringify({toolReceipts,nativeIdentities,events},null,2));
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
}
