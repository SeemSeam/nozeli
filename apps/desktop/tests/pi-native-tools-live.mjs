import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {DesktopHost} from '../src/main/host.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {createFrontdeskDocuments} from '../src/agents/managed/frontdesk-documents.mjs';
import {staticReport} from './static-report.fixture.mjs';
import {dispositionIntent} from './disposition-intent.fixture.mjs';
import {serve,prepare} from './pi-provider.fixture.mjs';


test('real Pi owner executes native file write and durably projects original journal entries',{timeout:120000},async t=>{
 const provider=await serve((request,round)=>{
  if(round===1){assert.ok(request.tools.some(tool=>tool.function?.name==='write'));return {tool:'write',id:'write-native-1',args:{path:'native-proof.txt',content:'actual Pi native write\n'}};}
  assert.equal(round,2);assert.ok(request.messages.some(message=>message.role==='tool'&&message.tool_call_id==='write-native-1'));return {text:'Native write verified.'};
 });
 t.after(()=>provider.close());
 const dirs=await prepare(provider.url),entries=[],facts=[];
 const session=new PiSession({role:'worker',...dirs,piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[],isolation:{writable:[dirs.cwd]},instructions:'Perform the local native write then report.',onNativeEntry:fact=>entries.push(fact),onTransportFact:fact=>facts.push(fact)});
 t.diagnostic('Self-owned evidence: '+dirs.root);
 t.after(async()=>{try{await session.stop();}finally{await provider.close();await fs.writeFile(path.join(dirs.root,'evidence.json'),JSON.stringify({facts,entries,requests:provider.requests,errors:provider.errors.map(e=>e.message)},null,2));}});
 await session.start();
 const result=await session.prompt('Write the supplied content to native-proof.txt.',{job:{id:'pi-real-write-job',target:'worker',revision:1,type:'work'}});
 assert.equal(await fs.readFile(path.join(dirs.cwd,'native-proof.txt'),'utf8'),'actual Pi native write\n');
 assert.equal(result.text,'Native write verified.');assert.equal(result.completion,'provider-completed');assert.deepEqual(provider.errors,[]);
 const persisted=(await fs.readFile(session.sessionFile,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const projected=entries.find(fact=>fact.entry?.message?.role==='toolResult'&&fact.entry.message.toolCallId==='write-native-1');
 assert.ok(projected,'native tool result must be projected under its original ID');assert.ok(persisted.some(row=>row.id===projected.entry.id&&row.message?.toolCallId==='write-native-1'));
 assert.equal(projected.requestId,result.turnId);assert.equal(projected.jobId,'pi-real-write-job');assert.ok(facts.some(row=>row.status==='settled'));assert.equal(facts.some(row=>row.status==='unknown'),false);
});

test('real three-role Pi handoff publishes a frozen candidate and user discard preserves source',{timeout:120000},async t=>{
 const calls=[];
 const provider=await serve(request=>{
  const names=request.tools.map(tool=>tool.function?.name),last=request.messages.at(-1);
  if(names.includes('nozeli_handoff')){calls.push('frontdesk');return {tool:'nozeli_handoff',id:'handoff-1',args:{reason:'Execute the explicitly requested candidate in background.'}};}
  if(names.includes('nozeli_dispatch')){calls.push('orchestrator');return {tool:'nozeli_dispatch',id:'dispatch-1',args:{name:'Pi Work regression',brief:'Create candidate.txt and publish its frozen HTML result.'}};}
  calls.push('worker');
  if(!request.messages.some(message=>message.tool_call_id==='candidate-write-1'))return {tool:'write',id:'candidate-write-1',args:{path:'candidate.txt',content:'Pi candidate artifact\n'}};
  if(last.role==='tool'&&last.tool_call_id==='publish-1')throw Error('Host-controlled publication must not call the model again');
  return {tool:'nozeli_publish',id:'publish-1',args:{kind:'result',html:staticReport('Candidate verified and ready for explicit user review.'),files:['candidate.txt']}};
 });
 t.after(()=>provider.close());
 const dirs=await prepare(provider.url),host=new DesktopHost(path.join(dirs.root,'profile'));
 await fs.writeFile(path.join(dirs.cwd,'source.txt'),'Human source unchanged\n');
 const project=(await host.pick(dirs.cwd)).project;
 const documents=createFrontdeskDocuments({host,projectId:project.id,sync:async()=>()=>{}});
 const options={storage:host.storage,projectId:project.id,runtimeRoot:path.join(dirs.root,'runtime'),contentRoot:dirs.cwd,frontdeskDocuments:documents,piSource:{agentDir:dirs.agentDir,modelFor:async()=>'local-fixture/scripted'},piRuntime:{agentDir:dirs.agentDir}};
 let controller=await Controller.open(options);
 t.diagnostic('Three-role evidence: '+dirs.root);
 t.after(async()=>{try{await controller.stop();}finally{await provider.close();await fs.writeFile(path.join(dirs.root,'work-evidence.json'),JSON.stringify({calls,requests:provider.requests,state:controller.store.state,errors:provider.errors.map(e=>e.message)},null,2));await host.storage.db.close();}});
 await controller.start();
 await controller.send('frontdesk','Create candidate.txt and publish the result for review.',{requestKey:'pi-three-role-original'});
 const deadline=Date.now()+45000;
 while(Date.now()<deadline&&!(controller.store.state.works[0]?.status==='review'&&!controller.running.size)){
  const failed=controller.store.state.jobs.find(job=>job.status==='failed');if(failed)throw Error(JSON.stringify(failed));
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 const work=controller.store.state.works[0];assert.equal(work?.status,'review');assert.equal(work.binding.provider,'pi');assert.deepEqual(provider.errors,[]);
 assert.deepEqual(calls,['frontdesk','orchestrator','worker','worker']);
 assert.equal(await fs.readFile(path.join(work.execution.directory,'candidate.txt'),'utf8'),'Pi candidate artifact\n');
 await assert.rejects(fs.stat(path.join(dirs.cwd,'candidate.txt')),{code:'ENOENT'});
 assert.equal(controller.store.state.receipts.filter(row=>row.workId===work.id&&row.kind==='result').length,1);
 assert.ok(controller.timeline.records().some(row=>row.target===work.id&&row.jobId));
 const before=provider.requests.length,thread=work.threadId;
 await controller.endWork(work.id,dispositionIntent(work));
 assert.equal(controller.store.find(work.id).status,'ended');assert.equal(controller.store.find(work.id).outcome,'discard');assert.equal(await fs.readFile(path.join(dirs.cwd,'source.txt'),'utf8'),'Human source unchanged\n');
 await controller.stop();controller=await Controller.open({...options,localOnly:true});
 assert.equal(controller.store.find(work.id).threadId,thread);assert.equal(controller.store.find(work.id).status,'ended');assert.equal(provider.requests.length,before,'cold local history must not replay model inputs');
});

for(const mode of ['success','draft','conflict'])test('real Pi host document tools preserve '+mode+' semantics',{timeout:120000},async t=>{
 let host,project,dirs;
 const provider=await serve(async(request,round)=>{
  if(round===1)return {tool:'nozeli_document_read',id:'host-read',args:{relPath:'notes.txt',access:'edit'}};
  const read=JSON.parse(request.messages.find(message=>message.tool_call_id==='host-read').content);
  assert.equal(read.ok,true,JSON.stringify(read));
  if(round===2){
   if(mode==='draft')await host.draft(project.id,'notes.txt',read.value.version.digest,'Human unsaved draft');
   if(mode==='conflict')await fs.writeFile(path.join(dirs.cwd,'notes.txt'),'Concurrent human source');
   return {tool:'nozeli_document_apply',id:'host-apply',args:{readHandle:read.value.readHandle,replacements:[{oldText:'baseline',newText:'Agent edited'}]}};
  }
  assert.equal(round,3);
  const applied=JSON.parse(request.messages.find(message=>message.tool_call_id==='host-apply').content);
  assert.equal(applied.ok,mode==='success',JSON.stringify(applied));
  if(mode!=='success')assert.equal(applied.error.code,mode==='draft'?'UNSAVED':'STALE_VERSION');
  return {text:'Host document operation inspected.'};
 });
 t.after(()=>provider.close());
 dirs=await prepare(provider.url);await fs.writeFile(path.join(dirs.cwd,'notes.txt'),'baseline');
 host=new DesktopHost(path.join(dirs.root,'profile'));project=(await host.pick(dirs.cwd)).project;
 const controller=await Controller.open({storage:host.storage,projectId:project.id,runtimeRoot:path.join(dirs.root,'runtime'),contentRoot:dirs.cwd,frontdeskDocuments:createFrontdeskDocuments({host,projectId:project.id,sync:async()=>()=>{}}),piSource:{agentDir:dirs.agentDir,modelFor:async()=>'local-fixture/scripted'},piRuntime:{agentDir:dirs.agentDir}});
 t.after(async()=>{try{await controller.stop();}finally{await provider.close();await fs.writeFile(path.join(dirs.root,'document-evidence.json'),JSON.stringify({mode,state:controller.store.state,requests:provider.requests,errors:provider.errors.map(error=>error.message)},null,2));await host.storage.db.close();}});
 await controller.start();
 if(mode==='success')await controller.sessions.get('frontdesk').reload();
 if(mode==='conflict')await controller.restart('frontdesk');
 const accepted=await controller.send('frontdesk','Read notes.txt then replace baseline with Agent edited.',{requestKey:'pi-document-'+mode});
 const deadline=Date.now()+30000;
 while(Date.now()<deadline&&['queued','running'].includes(controller.store.state.jobs.find(job=>job.id===accepted.jobId).status))await new Promise(resolve=>setTimeout(resolve,50));
 const job=controller.store.state.jobs.find(row=>row.id===accepted.jobId);assert.equal(job.status,'completed',JSON.stringify(job));assert.deepEqual(provider.errors,[]);
 assert.equal(await fs.readFile(path.join(dirs.cwd,'notes.txt'),'utf8'),mode==='success'?'Agent edited':mode==='conflict'?'Concurrent human source':'baseline');
 if(mode==='draft')assert.equal((await host.readDraftRecord(project.id,'notes.txt')).text,'Human unsaved draft');
 t.diagnostic('Document evidence: '+dirs.root);
});

for(const first of ['read','query_host'])test('mixed '+first+' batch stops at host control without later native writes',{timeout:90000},async t=>{
 let controls=0,queries=0;
 const provider=await serve((request,round)=>{
  assert.equal(round,1,'host control must not issue another model request');
  return {tools:[{tool:first,id:'before-control',args:first==='read'?{path:'README.md'}:{}},{tool:'stop_host',id:'host-control',args:{}},{tool:'write',id:'must-not-run',args:{path:'after-control.txt',content:'unauthorized after host control'}}]};
 });
 const dirs=await prepare(provider.url);await fs.writeFile(path.join(dirs.cwd,'README.md'),'Existing source stays intact.\n');
 const parameters={type:'object',properties:{},additionalProperties:false};
 const session=new PiSession({...dirs,role:'worker',model:'local-fixture/scripted',piRuntime:{agentDir:dirs.agentDir},finishOnHostControl:true,tools:[{name:'stop_host',description:'Commit the host control decision and stop this turn',parameters},{name:'query_host',description:'Read host state',parameters}],onTool:async call=>{await call.admission.preEffect();if(call.tool==='query_host'){queries++;return {readOnly:true,text:'Host state inspected'};}controls++;return {accepted:true};}});
 t.after(async()=>{await session.stop();await provider.close();});await session.start();
 const result=await session.prompt('Execute this exact mixed batch once.',{job:{id:'mixed-'+first,target:'worker',revision:1,type:'work'}});
 assert.equal(result.completion,'host-control');assert.equal(controls,1);assert.equal(queries,first==='query_host'?1:0);assert.equal(provider.requests.length,1);
 await assert.rejects(fs.stat(path.join(dirs.cwd,'after-control.txt')),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(dirs.cwd,'README.md'),'utf8'),'Existing source stays intact.\n');
});

test('native ask returns typed GUI answers to the original tool after rejecting an invalid answer',{timeout:90000},async t=>{
 const questions=[{id:'scope',question:'Which scope?',options:[{label:'Section'},{label:'Whole file'}]},{id:'formats',question:'Which formats?',multi:true,options:[{label:'PDF'},{label:'HTML'}]}];
 const provider=await serve((request,round)=>{
  if(round===1)return {tool:'ask',id:'ask-original',args:{i:'Confirm scope',questions}};
  assert.equal(round,2);const answer=JSON.parse(request.messages.find(message=>message.tool_call_id==='ask-original').content);
  assert.equal(answer.kind,'submit');assert.deepEqual(answer.results.map(row=>row.selectedOptions),[['Section'],['PDF','HTML']]);assert.equal(answer.results[0].note,'Keep original');
  return {text:'Scope and formats confirmed.'};
 });
 const dirs=await prepare(provider.url),session=new PiSession({...dirs,role:'frontdesk',model:'local-fixture/scripted',piRuntime:{agentDir:dirs.agentDir},tools:[]});
 t.after(async()=>{await session.stop();await provider.close();});
 let accept,reject;const answered=new Promise((resolve,fail)=>{accept=resolve;reject=fail;});
 session.on('interaction',question=>{void(async()=>{
  assert.equal(question.capability.respond,true);assert.equal(question.jobId,'ask-job');
  await assert.rejects(session.respondInteraction(question.id,{kind:'submit',results:[]}),{code:'INTERACTION_ANSWER_INVALID'});
  assert.equal(session.interactions.some(row=>row.id===question.id),true);
  await session.respondInteraction(question.id,{kind:'submit',results:[{id:'scope',selectedOptions:['Section'],note:'Keep original'},{id:'formats',selectedOptions:['PDF','HTML']}]});accept();
 })().catch(reject);});
 await session.start();const result=await session.prompt('Ask for exact scope and formats.',{job:{id:'ask-job',target:'frontdesk',type:'front'}});await answered;
 assert.equal(result.text,'Scope and formats confirmed.');assert.deepEqual(session.interactions,[]);assert.equal(provider.requests.length,2);assert.deepEqual(provider.errors,[]);
});

for(const afterEffect of [false,true])test('cancel '+(afterEffect?'after':'before')+' host effect preserves exact effect boundary',{timeout:90000},async t=>{
 let entered,release,calls=0;const enteredPromise=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const provider=await serve(()=>({tool:'boundary_write',id:'boundary-call',args:{}})),dirs=await prepare(provider.url);
 const output=path.join(dirs.cwd,'effect.txt');
 const session=new PiSession({...dirs,role:'worker',model:'local-fixture/scripted',piRuntime:{agentDir:dirs.agentDir},tools:[{name:'boundary_write',description:'Write a scoped effect once',parameters:{type:'object',properties:{},additionalProperties:false}}],onTool:async call=>{
  calls++;if(afterEffect){await call.admission.preEffect();await fs.writeFile(output,'committed once');}entered();await gate;await call.admission.preEffect();if(!afterEffect)await fs.writeFile(output,'must not happen');return {continueTurn:true};
 }});
 t.after(async()=>{release();await session.stop();await provider.close();});await session.start();
 const pending=session.prompt('Execute the scoped effect.',{job:{id:'boundary-'+afterEffect,target:'worker',revision:1,type:'work'}});pending.catch(()=>{});await enteredPromise;
 const cancelled=session.interrupt();release();await cancelled;await pending;
 assert.equal(calls,1);assert.equal(provider.requests.length,1);
 if(afterEffect)assert.equal(await fs.readFile(output,'utf8'),'committed once');else await assert.rejects(fs.stat(output),{code:'ENOENT'});
});

test('host failure after a committed effect stops the rest of a mixed batch',{timeout:90000},async t=>{
 const provider=await serve((request,round)=>round===1?{tools:[{tool:'read',id:'initial-read',args:{path:'README.md'}},{tool:'fail_host',id:'failed-control',args:{}},{tool:'write',id:'late-write',args:{path:'late.txt',content:'must not execute'}}]}:{text:'Unexpected follow-up after host failure'});
 const dirs=await prepare(provider.url);await fs.writeFile(path.join(dirs.cwd,'README.md'),'Source');let effects=0;
 const session=new PiSession({...dirs,role:'worker',model:'local-fixture/scripted',piRuntime:{agentDir:dirs.agentDir},finishOnHostControl:true,tools:[{name:'fail_host',description:'Commit then report a host failure',parameters:{type:'object',properties:{},additionalProperties:false}}],onTool:async call=>{await call.admission.preEffect();effects++;await fs.writeFile(path.join(dirs.cwd,'committed.txt'),'committed once');throw Object.assign(Error('controlled post-effect failure'),{code:'HOST_INTERNAL_FAILURE'});}});
 t.after(async()=>{await session.stop();await provider.close();});await session.start();
 await assert.rejects(session.prompt('Execute this exact batch.',{job:{id:'host-failure-boundary',target:'worker',revision:1,type:'work'}}),{code:'PI_HOST_TOOL_FAILED'});
 assert.equal(effects,1);assert.equal(await fs.readFile(path.join(dirs.cwd,'committed.txt'),'utf8'),'committed once');assert.equal(provider.requests.length,1);await assert.rejects(fs.stat(path.join(dirs.cwd,'late.txt')),{code:'ENOENT'});
});

test('GUI session stop binds one real job and queued explicit input continues once',{timeout:90000},async t=>{
 let entered,release,frontRequests=0;const entering=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const provider=await serve(async request=>{
  if(!request.tools.some(tool=>tool.function?.name==='nozeli_handoff'))return {text:'No maintenance action needed.'};
  frontRequests++;if(frontRequests===1){entered();await gate;return {text:'Cancelled first response'};}return {text:'Explicit second input completed'};
 });
 const dirs=await prepare(provider.url),host=new DesktopHost(path.join(dirs.root,'profile')),project=(await host.pick(dirs.cwd)).project;
 const controller=await Controller.open({storage:host.storage,projectId:project.id,runtimeRoot:path.join(dirs.root,'runtime'),contentRoot:dirs.cwd,frontdeskDocuments:createFrontdeskDocuments({host,projectId:project.id,sync:async()=>()=>{}}),piSource:{agentDir:dirs.agentDir,modelFor:async()=>'local-fixture/scripted'},piRuntime:{agentDir:dirs.agentDir}});
 t.after(async()=>{release();await controller.stop();await provider.close();await host.storage.db.close();});await controller.start();
 const first=await controller.send('frontdesk','Hold this first response.',{requestKey:'native-gui-stop-first'});await entering;
 const options=controller.sessionOptions('frontdesk'),thread=options.threadId;
 const second=await controller.send('frontdesk','An explicit next-round input.',{requestKey:'native-gui-stop-next'});
 assert.equal(controller.store.state.jobs.find(job=>job.id===second.jobId).status,'queued');
 await assert.rejects(controller.sessionCommand('frontdesk',{ownerId:options.ownerId,command:'interrupt',jobId:second.jobId,requestKey:'native-gui-stop-stale'}),{code:'INTERACTION_STALE'});
 const receipt=await controller.sessionCommand('frontdesk',{ownerId:options.ownerId,command:'interrupt',jobId:first.jobId,requestKey:'native-gui-stop-exact'});assert.equal(receipt.accepted,true);release();
 const deadline=Date.now()+30000;while(Date.now()<deadline&&controller.store.state.jobs.find(job=>job.id===second.jobId).status!=='completed')await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(controller.store.state.jobs.find(job=>job.id===first.jobId).status,'cancelled');assert.equal(controller.store.state.jobs.find(job=>job.id===second.jobId).status,'completed');assert.equal(frontRequests,2);assert.equal(controller.sessions.get('frontdesk').threadId,thread);
 assert.equal(controller.store.state.jobs.some(job=>job.type==='backstage'),false);assert.equal(controller.store.state.todos.some(todo=>todo.sourceJobId===first.jobId&&todo.kind==='recovery'),false);
 assert.equal((await controller.sessionCommand('frontdesk',{ownerId:options.ownerId,command:'interrupt',jobId:first.jobId,requestKey:'native-gui-stop-exact'})).accepted,true,'duplicate stop returns its original receipt, never stops the next turn');
});

export {serve,prepare};
