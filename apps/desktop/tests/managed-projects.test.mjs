import {openTestController,openTestWorkspace,testStorageOptions,writeTestState,readTestState} from './project-storage.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {createHash} from 'node:crypto';
import {reportDescriptor} from '../src/agents/managed/report-descriptor.mjs';
import {managedRuntime} from '../src/agents/managed/managed-storage.mjs';
async function storageHost(contentRoot,ids,extra={}){
 const {storage,projectId}=await testStorageOptions({contentRoot});
 const requireProject=async id=>{if(!ids.includes(id)&&id!==projectId)throw Error('unknown project');return storage.requireOnline(projectId);};
 const requireRegisteredProject=async id=>{if(!ids.includes(id)&&id!==projectId)throw Error('unknown project');return storage.requireRegistered(projectId);};
 const scoped=new Proxy(storage,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?((id,...args)=>value.call(target,ids.includes(id)?projectId:id,...args)):value;}});
 return {storage:scoped,requireProject,requireRegisteredProject,...extra};
}
// These IPC-only fixtures never open business state; storage is only the
// manager's unavailability callback sink.
const ipcHost=()=>({storage:{},requireProject:async()=>({}),requireRegisteredProject:async()=>({})});
test('project connection is explicit, single flight, external and rejects renderer command overrides',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-project-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const content=path.join(root,'content');await fs.mkdir(content);let opened=0,stopped=0;class Fake extends EventEmitter{constructor(){super();this.started=false;this.running=new Map();this.closures=new Map();}async start(){this.started=true;}snapshot(){return {works:[]};}async stop(){stopped++;}}
const m=new ManagedProjects({userDataDir:path.join(root,'profile'),host:await storageHost(content,['a']),legacy:{projects:new Map()},openController:async args=>{opened++;assert.ok(!args.runtimeRoot.startsWith(content+path.sep));await new Promise(r=>setTimeout(r,10));return new Fake();}});assert.equal((await m.connect('a')).enabled,false);assert.equal(opened,0);await Promise.all([m.connect('a',{enable:true}),m.connect('a',{enable:true})]);assert.equal(opened,1);await assert.rejects(m.invoke('managed.send',{projectId:'a',text:'hi',command:'evil'}),/payload/);await assert.rejects(m.invoke('managed.status',{projectId:'b'}),/unknown/);await m.stop();assert.equal(stopped,1);});

test('Provider-only IPC rejects old model authorities',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-provider-only-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const content=path.join(root,'content');await fs.mkdir(content);
  class Fake extends EventEmitter{
    constructor(){super();this.started=false;this.running=new Map();this.closures=new Map();this.store={state:{bindings:Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{provider:'omp'}])),works:[]}};}
    async start(){this.started=true;}
    snapshot(){return structuredClone(this.store.state);}
    async setBinding(role,value){assert.deepEqual(Object.keys(value),['provider']);this.store.state.bindings[role]={...value};return {saved:true};}
    async stop(){}
  }
  const m=new ManagedProjects({userDataDir:root,host:await storageHost(content,['a']),legacy:{projects:new Map()},openController:async()=>new Fake()});
  const result=await m.connect('a',{enable:true});assert.equal(result.ready,true);
  assert.deepEqual((await m.host.storage.getLocal('a','managed:binding')).roles.frontdesk,{provider:'omp'});
  for(const [op,payload] of [
    ['managed.models',{provider:'omp'}],
    ['managed.binding',{role:'frontdesk',provider:'omp',model:'zai/glm-4.7'}],
    ['managed.binding',{role:'frontdesk',provider:'omp',effort:'low'}],
    ['managed.enable',{provider:'omp',model:'zai/glm-4.7'}],
  ])await assert.rejects(m.invoke(op,{projectId:'a',...payload}),/invalid managed payload/);
  await m.stop();
});

import {Controller,isExplicitWorkCancellation} from '../src/agents/managed/controller.mjs';
test('cancellation refuses questions, negations and conditional wording',()=>{for(const text of ['不能结束 Alpha，请继续','Alpha 是否结束？','不要取消 Alpha','如果取消 Alpha 会怎样','是否应该结束 Alpha','CANCEL Alpha do not cancel Alpha'])assert.equal(isExplicitWorkCancellation(text,'Alpha'),false,text);for(const text of ['请取消 Alpha','撤销尚未启动的 Alpha','CANCEL Alpha cancel Alpha'])assert.equal(isExplicitWorkCancellation(text,'Alpha'),true,text);});
test('continuation resolves only explicitly bound clarification',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-clarify-'));const c=await openTestController({runtimeRoot:path.join(root,'data'),contentRoot:path.join(root,'project'),projectHome:async()=>{}});t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});const w=await c.store.submit('first task','brief');await c.store.mutate(()=>{c.store.find(w.id).name='A';c.store.state.todos.push({id:'question-B',kind:'routing',status:'open',text:'Which B?'},{id:'question-A',kind:'routing',status:'open',text:'Which A?'});c.store.state.jobs.push({id:'follow-1',type:'intake',text:'A supplement',context:{},target:'orchestrator'});});await c.manageIntake(c.store.state.jobs.at(-1),{action:'continue',workName:'A',text:'detail'});assert.equal(c.store.state.todos.find(t=>t.id==='question-B').status,'open');assert.equal(c.store.state.todos.find(t=>t.id==='question-A').status,'open');await c.store.mutate(()=>c.store.state.jobs.push({id:'follow-2',type:'intake',text:'A answer',context:{routingQuestionId:'question-A'},target:'orchestrator'}));await c.manageIntake(c.store.state.jobs.at(-1),{action:'continue',workName:'A',text:'answer'});assert.equal(c.store.state.todos.find(t=>t.id==='question-B').status,'open');assert.equal(c.store.state.todos.find(t=>t.id==='question-A').status,'resolved');});

test('direct Orchestrator input enters intake so host management tools remain available',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-direct-main-'));const c=await openTestController({runtimeRoot:path.join(root,'data'),contentRoot:path.join(root,'project'),projectHome:async()=>{}});t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});await c.send('orchestrator','A new bounded task');assert.equal(c.store.state.jobs.at(-1).type,'intake');assert.equal(c.store.state.jobs.at(-1).target,'orchestrator');c.current.set('orchestrator',c.store.state.jobs.at(-1));const receipt=await c.onTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'Direct task',brief:'Bounded direct task'}});assert.equal(c.store.find(receipt.workId).status,'queued');assert.equal(c.store.state.works.length,1);});

import {verifyProjectArtifacts} from '../src/agents/managed/artifacts.mjs';
test('artifact publications verify real project files, deduplicate and survive reopen',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-artifacts-')),project=path.join(root,'project'),runtime=path.join(root,'runtime');await fs.mkdir(project);await fs.writeFile(path.join(project,'result.md'),'# Result');await fs.writeFile(path.join(root,'private.txt'),'private');await fs.symlink(path.join(root,'private.txt'),path.join(project,'escape.txt'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const verified=await verifyProjectArtifacts(project,['result.md',path.join(project,'result.md'),'missing.md','../private.txt','escape.txt','.']);assert.deepEqual(verified.files.map(f=>f.relPath),['result.md']);assert.equal(verified.rejected.length,4);
 await fs.unlink(path.join(project,'escape.txt'));const c=await openTestController({runtimeRoot:runtime,contentRoot:project,isolateProcesses:true,projectHome:async()=>{}}),events=[];c.on('files-changed',event=>events.push(event));const w=await c.store.submit('files','brief');await c.store.activate(w.id);await c.execution.prepare(w.id);await fs.writeFile(path.join(c.execution.directory(w.id),'result.md'),'# Candidate Result');const job={id:'file-job',target:w.id,revision:1};c.current.set(w.id,job);
 await assert.rejects(c.onTool(w.id,{tool:'nozeli_publish',callId:'bad',arguments:{kind: 'result', html: staticReport('Report'), files: ['result.md','missing.md']}}),/成果引用无法核验/);assert.equal(c.store.state.receipts.length,0);await c.onTool(w.id,{tool:'nozeli_publish',callId:'p1',arguments:{kind: 'result', html: staticReport('Report'), files: ['result.md']}});await c.recordArtifacts(job,['result.md']);assert.equal(c.snapshot().artifacts.length,1);assert.equal(events.length,1);assert.deepEqual(events[0],{jobId:'file-job',workId:w.id,reason:'artifact-verified'});assert.equal(c.snapshot().works[0].status,'running');const receipt=c.store.state.receipts[0];assert.equal(receipt.snapshot.reportDigest,receipt.report.digest);assert.equal(Object.hasOwn(receipt.snapshot,'directory'),false);assert.equal(receipt.snapshot.candidate.commit,c.store.find(w.id).execution.candidate.commit);const artifact=receipt.snapshot.files.find(file=>file.relPath==='result.md');assert.equal((await c.store.readObject(artifact.digest)).toString('utf8'),'# Candidate Result');assert.equal(await fs.readFile(path.join(project,'result.md'),'utf8'),'# Result');await c.stop();
 const reopened=await openTestController({runtimeRoot:runtime,contentRoot:project,projectHome:async()=>{}});assert.equal(reopened.snapshot().artifacts[0].relPath,'result.md');await reopened.stop();
});

test('terminal attach is single-flight and stale close/input cannot affect replacement',async()=>{
 let count=0,closed=0,release;
 const gate=new Promise(r=>release=r),c={started:true,store:{state:{works:[]}},terminals:new Map()};
 c.assertFrontdeskContextAdmission=Controller.prototype.assertFrontdeskContextAdmission;
 const m=new ManagedProjects({userDataDir:'/unused',host:ipcHost(),legacy:{},attachTerminal:async(_c,target,{terminalId})=>{count++;await gate;const t={terminalId,threadId:'thread',replay:'',seq:0,input(){},resize(){},async close(){closed++;c.terminals.delete(target);}};c.terminals.set(target,t);return t;}});
 m.controllers.set('p',c);
 const a=m.invoke('managed.terminal.attach',{projectId:'p',target:'frontdesk'}),b=m.invoke('managed.terminal.attach',{projectId:'p',target:'frontdesk'});await new Promise(r=>setImmediate(r));assert.equal(count,1);release();const [first,second]=await Promise.all([a,b]);assert.equal(first.terminalId,second.terminalId);
 await m.invoke('managed.terminal.close',{projectId:'p',target:'frontdesk',terminalId:first.terminalId});
 const next=await m.invoke('managed.terminal.attach',{projectId:'p',target:'frontdesk'});assert.notEqual(next.terminalId,first.terminalId);
 assert.equal((await m.invoke('managed.terminal.close',{projectId:'p',target:'frontdesk',terminalId:first.terminalId})).stale,true);assert.equal(closed,1);
 await assert.rejects(m.invoke('managed.terminal.input',{projectId:'p',target:'frontdesk',terminalId:first.terminalId,data:'x'}),/过期/);
 assert.equal(c.terminals.get('frontdesk').terminalId,next.terminalId);
});

test('owner-pinned attach refuses obsolete owner and late old exit cannot close replacement',async()=>{
 const old={viewOwnerId:'old'},next={viewOwnerId:'next'};let callbacks,entered=0;
 const c={started:true,store:{state:{works:[]}},sessions:new Map([['frontdesk',old]]),terminals:new Map()};
 c.assertFrontdeskContextAdmission=Controller.prototype.assertFrontdeskContextAdmission;
 const m=new ManagedProjects({userDataDir:'/unused',host:ipcHost(),legacy:{},attachTerminal:async(_c,target,options)=>{entered++;callbacks=options;const t={terminalId:options.terminalId,threadId:'history',replay:'',seq:0,input(){},resize(){},close:async()=>{if(c.terminals.get(target)===t)c.terminals.delete(target);}};c.terminals.set(target,t);return t;}});m.controllers.set('p',c);
 const events=[];m.onEvent(e=>events.push(e));
 const lease=await m.invoke('managed.terminal.attach',{projectId:'p',target:'frontdesk',ownerId:'old'});
 c.sessions.set('frontdesk',next);c.terminals.set('frontdesk',{terminalId:'new-view'});
 callbacks.onExit({exitCode:0});callbacks.onData('late-output',1);
 assert.equal(events.length,0);assert.equal(c.terminals.get('frontdesk').terminalId,'new-view');
 await assert.rejects(m.invoke('managed.terminal.attach',{projectId:'p',target:'frontdesk',ownerId:'old'}),e=>e.code==='TERMINAL_STALE');
 await assert.rejects(m.invoke('managed.terminal.input',{projectId:'p',target:'frontdesk',terminalId:lease.terminalId,data:'unsent'}),e=>e.code==='TERMINAL_STALE');
 assert.equal(entered,1);
});

test('Provider replaced while attach waits rejects old result without closing new view',async()=>{
 let release;const barrier=new Promise(r=>release=r);const old={viewOwnerId:'old'},next={viewOwnerId:'next'};
 const c={started:true,store:{state:{works:[]}},sessions:new Map([['frontdesk',old]]),terminals:new Map()};
 c.assertFrontdeskContextAdmission=Controller.prototype.assertFrontdeskContextAdmission;
 const m=new ManagedProjects({userDataDir:'/unused',host:ipcHost(),legacy:{},attachTerminal:async(_c,target,{terminalId})=>{await barrier;return {terminalId,threadId:'old-thread',close:async()=>{throw Error('must not close replacement');}};}});m.controllers.set('p',c);
 const pending=m.invoke('managed.terminal.attach',{projectId:'p',target:'frontdesk',ownerId:'old'});await new Promise(r=>setImmediate(r));
 c.sessions.set('frontdesk',next);c.terminals.set('frontdesk',{terminalId:'replacement'});release();
 await assert.rejects(pending,e=>e.code==='TERMINAL_STALE');assert.equal(c.terminals.get('frontdesk').terminalId,'replacement');assert.equal(m.terminalFlights.size,0);
});
test('automatic attachment waits for a racing model turn to finish',async()=>{
 let release,count=0;const busy=new Promise(r=>release=r),c={started:true,store:{state:{works:[]}},running:new Map([['worker',busy]]),terminals:new Map()};
 c.assertFrontdeskContextAdmission=Controller.prototype.assertFrontdeskContextAdmission;
 const m=new ManagedProjects({userDataDir:'/unused',host:ipcHost(),legacy:{},attachTerminal:async(_c,target,{terminalId})=>{count++;const t={terminalId,threadId:'same-thread',seq:0,replay:''};c.terminals.set(target,t);return t;}});m.controllers.set('p',c);
 const attached=m.invoke('managed.terminal.attach',{projectId:'p',target:'worker'});await new Promise(r=>setImmediate(r));assert.equal(count,0);c.running.delete('worker');release();assert.equal((await attached).threadId,'same-thread');assert.equal(count,1);
});

test('end IPC requires explicit user disposition and retry is technical only',async()=>{
 const calls=[],binding={workId:'w',revision:2,objectId:null,candidateCommit:null},requestKey='explicit-confirmation',c={started:true,endWork:async(...args)=>{calls.push(['end',...args]);return {ended:true};},retryClosure:async(...args)=>{calls.push(['retry',...args]);return {retrying:true};}};
 const m=new ManagedProjects({userDataDir:'/unused',host:ipcHost(),legacy:{}});m.controllers.set('p',c);m.loadLocal=async()=>c;
 for(const decision of ['accept','discard'])assert.deepEqual(await m.invoke('managed.end',{projectId:'p',workId:'w',revision:2,decision,binding,requestKey}),{ended:true});
 assert.deepEqual(calls[0],['end','w',{revision:2,decision:'accept',binding,requestKey}]);assert.deepEqual(calls[1],['end','w',{revision:2,decision:'discard',binding,requestKey}]);
 await assert.rejects(m.invoke('managed.end',{projectId:'p',workId:'w',revision:2}),e=>e.code==='INVALID_PAYLOAD');
 await assert.rejects(m.invoke('managed.end',{projectId:'p',workId:'w',revision:2,force:true}),/payload/);
 for(const op of ['managed.closure.resolve','managed.maintenance.require'])await assert.rejects(m.invoke(op,{projectId:'p',workId:'w'}),/payload/);
 assert.deepEqual(await m.invoke('managed.retry',{projectId:'p',workId:'w',binding,requestKey}),{retrying:true});assert.deepEqual(calls.at(-1),['retry','w',{binding,requestKey}]);
});
test('artifact read uses verified report bytes, never original-root lookalikes',async t=>{
 const {createHash}=await import('node:crypto'),root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-artifact-read-'));t.after(async()=>{try{await store.close();}finally{await fs.rm(root,{recursive:true,force:true});}});
 const objectId='00000000-0000-4000-8000-000000000001',workId='00000000-0000-4000-8000-000000000002',bytes=Buffer.from('candidate bytes'),digest=createHash('sha256').update(bytes).digest('hex');
 const host=await storageHost(path.join(root,'project'),['p']),project=await host.requireProject('p'),runtime=await managedRuntime(host.storage,'p');
 const store=await openTestWorkspace(runtime,project.root,{storage:host.storage,projectId:project.id});
 await host.storage.putObject('p',bytes);const reportBytes=Buffer.from('immutable report');await host.storage.putObject('p',reportBytes);
 const state={...store.state,works:[{id:workId,revision:1,status:'ended'}],receipts:[{id:'receipt',workId,objectId,kind:'result',revision:1,at:'2026-10-18T00:00:00Z',report:reportDescriptor(reportBytes,{format:'markdown',objectId}),snapshot:{files:[{relPath:'result.txt',digest,size:bytes.length}]}}]};store.state=state;
 const objects=await host.storage.objects('p'),directory=objects.directory,file=objects.location(digest);
 await fs.writeFile(path.join(project.root,'result.txt'),'original-root lookalike');
 const m=new ManagedProjects({userDataDir:root,host,legacy:{}});m.controllers.set('p',{store});
 const actual=await m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'result.txt'});assert.equal(actual.text,'candidate bytes');assert.equal(actual.readOnly,true);
 const originalWorkspaceId=state.workspaceId;state.workspaceId='foreign-project';await assert.rejects(m.invoke('managed.artifact.list',{projectId:'p',objectId}),e=>e.code==='REPORT_INVALID');state.workspaceId=originalWorkspaceId;
 state.receipts[0].snapshot.files.push({relPath:'removed.txt',digest:null,size:0});assert.equal((await m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'result.txt'})).text,'candidate bytes');const absent=await m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'removed.txt'});assert.equal(absent.availability,'absent');assert.equal(absent.base64,null);
 state.receipts[0].snapshot.files[1].size=1;await assert.rejects(m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'result.txt'}),e=>e.code==='REPORT_INVALID');state.receipts[0].snapshot.files[1].size=0;
 const emptyDigest=createHash('sha256').update('').digest('hex');await host.storage.putObject('p',Buffer.alloc(0));state.receipts[0].snapshot.files.push({relPath:'empty.txt',digest:emptyDigest,size:0});const empty=await m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'empty.txt'});assert.equal(empty.text,'');assert.equal(empty.base64,'');
 for(const bad of [{relPath:'bad.txt',digest:null,size:2},{relPath:'../bad',digest:null,size:0},{relPath:'result.txt',digest:null,size:0},{relPath:'bad.txt',size:0}]){state.receipts[0].snapshot.files.push(bad);await assert.rejects(m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'result.txt'}),e=>e.code==='REPORT_INVALID');state.receipts[0].snapshot.files.pop();}
 await assert.rejects(m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'../result.txt'}),e=>e.code==='INVALID_PAYLOAD');
 await assert.rejects(m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'unlisted.txt'}),e=>e.code==='ARTIFACT_UNAVAILABLE');
 await fs.writeFile(file,'changed');await assert.rejects(m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'result.txt'}),e=>e.code==='MATERIAL_CORRUPT');
 await fs.writeFile(file,bytes);
 const external=path.join(root,'external');await fs.mkdir(external);await fs.writeFile(path.join(external,digest),bytes);
 const retained=directory+'-retained';await fs.rename(directory,retained);await fs.symlink(external,directory);
 await assert.rejects(m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'result.txt'}),e=>e.code==='INVALID_DIRECTORY');
 await fs.unlink(directory);await fs.rename(retained,directory);
 await fs.unlink(file);await fs.symlink(path.join(external,digest),file);
 await assert.rejects(m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'result.txt'}),e=>e.code==='INVALID_MATERIAL');
 await fs.unlink(file);await fs.link(path.join(external,digest),file);await fs.writeFile(path.join(external,digest),'changed through hard link');
 await assert.rejects(m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'result.txt'}),e=>e.code==='MATERIAL_CORRUPT');
 await fs.unlink(file);await fs.writeFile(file,bytes);
 await writeTestState(store,state);m.controllers.delete('p');
 assert.equal((await m.invoke('managed.artifact.list',{projectId:'p',objectId})).files[0].relPath,'result.txt');
 assert.equal((await m.invoke('managed.artifact.read',{projectId:'p',objectId,relPath:'result.txt'})).text,'candidate bytes');
 await writeTestState(store,{...state,receipts:[{...state.receipts[0],report:{...state.receipts[0].report,objectId:workId}}]});
 await assert.rejects(m.invoke('managed.artifact.list',{projectId:'p',objectId}),error=>error.code==='REPORT_INVALID');
});
test('worker handoff requires explicit confirmation and forwards exact Work/thread revision',async()=>{
 const calls=[],controller={started:true,recoverWorkerContext:async(...args)=>{calls.push(args);return {confirmed:true,automaticReplay:false};}};
 const manager=new ManagedProjects({userDataDir:'/unused',host:ipcHost(),legacy:{}});manager.controllers.set('p',controller);
 for(const confirmed of [undefined,false,'true'])await assert.rejects(manager.invoke('managed.worker.handoff',{projectId:'p',workId:'w',revision:2,oldThreadId:'original',...(confirmed===undefined?{}:{confirmed})}),error=>error.code==='INVALID_PAYLOAD');
 const result=await manager.invoke('managed.worker.handoff',{projectId:'p',workId:'w',revision:2,oldThreadId:'original',confirmed:true});assert.equal(result.automaticReplay,false);assert.deepEqual(calls,[['w',{revision:2,oldThreadId:'original',confirmed:true}]]);
 await assert.rejects(manager.invoke('managed.worker.handoff',{projectId:'p',workId:'w',revision:2,oldThreadId:'original',confirmed:true,text:'replay me'}),/payload/);assert.equal(calls.length,1);
});
test('worker archive IPC binds Work/archive and rejects unbounded or path-based reads without native startup',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-worker-history-'));t.after(async()=>{try{await store.close();}finally{await fs.rm(root,{recursive:true,force:true});}});
 const {storage,projectId}=await testStorageOptions({contentRoot:path.join(root,'project')});
 const host={storage,requireProject:async id=>{if(id!==projectId)throw Error('unknown project');return storage.requireOnline(id);},requireRegisteredProject:async id=>{if(id!==projectId)throw Error('unknown project');return storage.requireRegistered(id);}},project=await host.requireProject(projectId);
 const manager=new ManagedProjects({userDataDir:root,host,legacy:{},openController:async()=>{throw Error('history must not open a controller');}});
 const runtime=await managedRuntime(storage,projectId),store=await openTestWorkspace(runtime,project.root,{storage,projectId});
 const dossier={workId:'w',archiveId:'archive',request:'original sources '.repeat(1000),home:'/private/native-home'},bytes=Buffer.from(JSON.stringify(dossier)),digest=createHash('sha256').update(bytes).digest('hex');
 const state={...store.state,works:[{id:'w',archives:[{id:'archive',dossierObjectId:digest,dossierDigest:digest}]},{id:'other',archives:[]}]};store.state=state;
 await writeTestState(store,state);await storage.putObject(projectId,bytes);const original=await readTestState(store);
 const query=extra=>manager.invoke('managed.worker.history',{projectId,workId:'w',archiveId:'archive',offset:0,...extra});
 const native=await storage.getRecovery(projectId,'managed:native-facts');assert.equal(native.projectId,projectId);
 await storage.putRecovery(projectId,'managed:native-facts',{...native,projectId:'other'});
 await assert.rejects(query(),error=>error.code==='NATIVE_FACT_BINDING_CONFLICT');
 await storage.putRecovery(projectId,'managed:native-facts',native);
 for(const active of [false,true]){
  if(active)manager.controllers.set(projectId,{started:false,store});
  const first=await query();assert.equal(first.readOnly,true);assert.equal(first.workId,'w');assert.equal(first.archiveId,'archive');assert.ok(first.text.length<=10000);assert.notEqual(first.nextOffset,null);
  const last=await query({offset:first.nextOffset,version:first.version});assert.equal(last.nextOffset,null);assert.deepEqual(JSON.parse(first.text+last.text),{workId:'w',archiveId:'archive',request:dossier.request});
  for(const offset of [-1,0.5,'0',first.totalChars+1])await assert.rejects(query({offset}),error=>error.code==='ARCHIVE_OFFSET');
  await assert.rejects(query({version:'stale'}),error=>error.code==='ARCHIVE_CHANGED');
  for(const extra of [{workId:'other'},{archiveId:'other'}])await assert.rejects(query(extra),error=>error.code==='ARCHIVE_IDENTITY');
  await assert.rejects(query({projectId:'other'}),/unknown project/);
  await assert.rejects(query({path:'/private/session.jsonl'}),/payload/);
 }
 assert.deepEqual(await storage.readObject(projectId,digest),bytes);assert.deepEqual(await readTestState(store),original);
});

test('controller acceptance ignores saved scratch history but protects every active or corrupt draft',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-accept-draft-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const content=path.join(root,'project');await fs.mkdir(content);
 let options,draft=null,file={text:'current disk',digest:'disk-version',draft:null},syncError=null;
 const syncs=[];
 class Fake extends EventEmitter{constructor(){super();this.started=false;this.running=new Map();this.closures=new Map();}async start(){this.started=true;}snapshot(){return {works:[]};}async stop(){}}
 const m=new ManagedProjects({userDataDir:root,host:await storageHost(content,['project-1'],{readDraftRecord:async()=>draft,readFile:async()=>file}),legacy:{projects:new Map()},beforeDocumentOperation:async request=>{syncs.push(request);if(syncError)throw syncError;return ()=>{};},openController:async args=>{options=args;return new Fake();}});t.after(()=>m.stop());await m.connect('project-1',{enable:true});
 const work={execution:{candidate:{files:['paper.md']}}};
 await options.beforeAccept(work);draft={status:'saved',text:'obsolete scratch'};await options.beforeAccept(work);
 for(const active of [{status:'dirty',text:'unsaved user text'},{status:'conflict',text:'conflicting user text'},{text:'legacy unsaved'},{status:'saved',draftError:{code:'METADATA_CORRUPT'}}]){draft=active;await assert.rejects(options.beforeAccept(work),error=>error.code==='DRAFT_CONFLICT');assert.equal(draft,active);}
 assert.ok(syncs.every(request=>request.projectId==='project-1'&&request.relPath==='paper.md'&&request.hold===false));
 assert.ok(syncs.some(request=>request.relPath==='paper.md'));
 // The admission set is the complete union passed by execution finish (worker-changed ∪ reviewed files),
 // not only candidate.files: an unsaved draft on an unreferenced admitted path must block too.
 draft=null;
 const union={execution:{candidate:{files:['paper.md']}}};
 await options.beforeAccept(union,['paper.md','appendix.md']);
 assert.ok(syncs.some(request=>request.relPath==='appendix.md'));
 draft={status:'dirty',text:'appendix unsaved'};
 await assert.rejects(options.beforeAccept(union,['paper.md','appendix.md']),error=>error.code==='DRAFT_CONFLICT');
 draft=null;
 draft={status:'saved'};syncError=Object.assign(Error('IME sync failed'),{code:'SYNC_FAILED'});await assert.rejects(options.beforeAccept(work),error=>error.code==='SYNC_FAILED');syncError=null;
 file={text:'current disk',digest:'disk-version',draft:{status:'saved',text:'obsolete scratch'}};assert.deepEqual(await options.readProjectText('paper.md'),{text:'current disk',buffer:false,diskVersion:'disk-version'});
 file={...file,draft:{status:'dirty',text:'active user text'}};assert.deepEqual(await options.readProjectText('paper.md'),{text:'active user text',buffer:true,diskVersion:'disk-version'});
 file={...file,draft:null,draftError:{code:'METADATA_CORRUPT',message:'draft unavailable'}};await assert.rejects(options.readProjectText('paper.md'),error=>error.code==='METADATA_CORRUPT');
});

// Model synchronization fixtures implement the native session contract explicitly.
function defaultsController(works=[]){
 const controller=Object.create(Controller.prototype);
 Object.assign(controller,{stopping:false,sessions:new Map(),store:{state:{works,jobs:[{id:'old-job',effective:{model:'original/model'}}]}},changed(){this.notifications=(this.notifications??0)+1;}});
 return controller;
}
function defaultsSession(calls,target,{busy=false,fail=false,closed=false}={}){
 return {closed,busy,threadId:'same-'+target,model:'original/model',effective:{model:'original/model'},async applyDefaultModel(selector){
  calls.push({target,selector});if(fail)throw Error('secret=PRIVATE /private/path');
  this.desiredModel=selector||null;this.pendingModel=busy&&selector?selector:null;
  if(!busy&&selector)this.model=selector;
  return {pending:busy&&!!selector,model:this.model};
 }};
}
test('saved defaults reach all live roles across projects without waking sleeping or historical Agents',async()=>{
 const manager=new ManagedProjects({userDataDir:'/unused',host:ipcHost(),legacy:{}}),calls=[],defaults={frontdesk:'new/front',orchestrator:'new/main',worker:'new/work'};
 for(const id of ['a','b']){
  const c=defaultsController([{id:'live',status:'review'},{id:'sleeping',status:'paused'},{id:'ended',status:'ended'},{id:'closing',status:'closing'},{id:'archive',status:'paused',readOnly:true}]);
  c.session=()=>{throw Error('must not wake');};c.start=c.session;c.processBudget={acquire:c.session};
  for(const target of ['frontdesk','orchestrator','live','ended','closing','archive'])c.sessions.set(target,defaultsSession(calls,id+':'+target));
  c.sessions.set('closed',defaultsSession(calls,id+':closed',{closed:true}));manager.controllers.set(id,c);
 }
 const histories=[...manager.controllers.values()].map(c=>structuredClone(c.store.state));
 assert.deepEqual(await manager.applyModelDefaults(defaults),{applied:6,pending:0,failed:[]});
 assert.deepEqual(calls.map(({target,selector})=>[target,selector]).sort(),['a','b'].flatMap(id=>[['frontdesk',defaults.frontdesk],['orchestrator',defaults.orchestrator],['live',defaults.worker]].map(([target,selector])=>[id+':'+target,selector])).sort());
 for(const [index,c] of [...manager.controllers.values()].entries()){
  assert.deepEqual(c.store.state,histories[index]);assert.equal(c.sessions.get('live').threadId,'same-'+['a','b'][index]+':live');
  assert.deepEqual(c.sessions.get('live').effective,{model:'original/model'});assert.equal(c.sessions.has('sleeping'),false);
 }
 assert.equal(manager.controllers.size,2);assert.equal(manager.processBudget.used,0);
});
test('busy owners report pending and failures never leak native diagnostics or claim success',async()=>{
 const c=defaultsController([{id:'worker',status:'running'}]),calls=[];
 c.sessions.set('frontdesk',defaultsSession(calls,'frontdesk',{busy:true}));
 c.sessions.set('orchestrator',defaultsSession(calls,'orchestrator',{fail:true}));
 c.sessions.set('worker',defaultsSession(calls,'worker'));
 const sync=await c.applyModelDefaults({frontdesk:'new/front',orchestrator:'new/main',worker:'new/work'});
 assert.equal(sync.applied,1);assert.equal(sync.pending,1);assert.equal(sync.failed.length,1);
 assert.ok(!JSON.stringify(sync).includes('PRIVATE'));assert.ok(!JSON.stringify(sync).includes('/private/path'));
 assert.equal(c.sessions.get('frontdesk').model,'original/model');assert.equal(c.sessions.get('frontdesk').pendingModel,'new/front');
 assert.deepEqual(c.store.state.jobs[0].effective,{model:'original/model'});
 const cleared=await c.applyModelDefaults({frontdesk:'',orchestrator:'',worker:''});assert.equal(cleared.pending,0);
 assert.equal(c.sessions.get('frontdesk').pendingModel,null);assert.equal(c.sessions.get('worker').model,'new/work');
});
test('missing native apply method is an explicit failure, not a production compatibility fallback',async()=>{
 const c=defaultsController();c.sessions.set('frontdesk',{closed:false});
 const sync=await c.applyModelDefaults({frontdesk:'new/front'});assert.equal(sync.applied,0);assert.equal(sync.failed.length,1);
});
test('manager serializes competing propagations so the newest desired model wins',async()=>{
 const manager=new ManagedProjects({userDataDir:'/unused',host:ipcHost(),legacy:{}}),calls=[];
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 manager.controllers.set('a',{async applyModelDefaults(defaults){calls.push(defaults.worker);if(calls.length===1){entered();await gate;}this.desired=defaults.worker;return {applied:1,pending:0,failed:[]};}});
 const a=manager.applyModelDefaults({worker:'first/model'});await started;
 const b=manager.applyModelDefaults({worker:'second/model'});assert.deepEqual(calls,['first/model']);release();await Promise.all([a,b]);
 assert.deepEqual(calls,['first/model','second/model']);assert.equal(manager.controllers.get('a').desired,'second/model');
});
test('modelSync refresh observes pending completion and retains redacted failures',async()=>{
 const manager=new ManagedProjects({userDataDir:'/unused',host:ipcHost(),legacy:{}}),c=defaultsController(),calls=[];
 manager.controllers.set('p',c);c.sessions.set('frontdesk',defaultsSession(calls,'frontdesk',{busy:true}));c.sessions.set('orchestrator',defaultsSession(calls,'orchestrator',{fail:true}));
 await manager.applyModelDefaults({frontdesk:'new/front',orchestrator:'new/main',worker:''});
 assert.equal(manager.modelSync().pending,1);assert.deepEqual(manager.modelSync().failed,[{role:'orchestrator',message:'Agent默认模型同步失败；配置已保存，可重试保存。'}]);
 c.sessions.get('frontdesk').pendingModel=null;c.sessions.get('frontdesk').model='new/front';
 assert.equal(manager.modelSync().pending,0);assert.equal(manager.modelSync().applied,1);
});
test('later project startup reads the current source defaults without connecting sleeping projects on save',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-model-start-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let value='first/model',opened=0;const source={modelFor:async role=>role==='frontdesk'?value:''};
 class Startup extends EventEmitter{
  constructor(options){super();this.options=options;this.store={state:{works:[]}};this.sessions=new Map();}
  async start(){this.model=await this.options.ompSystemSource.modelFor('frontdesk');this.started=true;}
  snapshot(){return {model:this.model};}async stop(){}
 }
 const manager=new ManagedProjects({userDataDir:root,ompSystemSource:source,host:await storageHost(path.join(root,'project'),['sleeping']),legacy:{projects:new Map()},openController:async options=>{opened++;return new Startup(options);}});
 value='latest/model';assert.deepEqual(await manager.applyModelDefaults({frontdesk:value,orchestrator:'',worker:''}),{applied:0,pending:0,failed:[]});assert.equal(opened,0);
 const result=await manager.connect('sleeping',{enable:true});assert.equal(opened,1);assert.equal(result.state.model,'latest/model');await manager.stop();
});

test('activating an enabled sleeping project leaves controller and provider startup to explicit connect',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-offline-active-'));let opened=0,starts=0;
 class Resident extends EventEmitter{
  constructor(){super();this.sessions=new Map();this.store={state:{works:[]}};}
  async start(){starts++;this.started=true;}
  snapshot(){return {works:[],agents:[],providers:{}};}
  async stop(){}
 }
 const manager=new ManagedProjects({userDataDir:root,host:await storageHost(path.join(root,'project'),['sleeping']),legacy:{projects:new Map()},openController:async()=>{opened++;return new Resident();}});
 t.after(async()=>{await manager.stop();await fs.rm(root,{recursive:true,force:true});});
 const binding={schema:1,enabled:true,roles:{frontdesk:{provider:'omp'},orchestrator:{provider:'omp'},worker:{provider:'omp'}}};await manager.host.storage.putLocal('sleeping','managed:binding',binding);
 await manager.setActiveProject('sleeping');assert.equal(manager.activeProjectId,'sleeping');assert.equal(opened,0,'enabled history alone cannot open Controller');assert.equal(starts,0,'local project activation cannot spawn providers');assert.equal(manager.controllers.size,0);assert.equal(manager.processBudget.used,0);assert.deepEqual(await manager.host.storage.getLocal('sleeping','managed:binding'),binding);
 const connected=await manager.invoke('managed.connect',{projectId:'sleeping'});assert.equal(connected.enabled,true);assert.equal(connected.ready,true);assert.equal(opened,1);assert.equal(starts,1,'only explicit connect starts residents');assert.equal(manager.controllers.has('sleeping'),true);
});
test('deferred model application errors refresh as redacted failures rather than success',async()=>{
 const c=defaultsController();c.sessions.set('frontdesk',{closed:false,desiredModel:'new/front',pendingModel:'new/front',model:'original/model',modelError:{code:'PRIVATE /private/path'}});
 const sync=c.modelSync();assert.equal(sync.applied,0);assert.equal(sync.failed.length,1);assert.equal(sync.failed[0].role,'frontdesk');assert.ok(!JSON.stringify(sync).includes('PRIVATE'));
 c.sessions.get('frontdesk').modelError=null;c.sessions.get('frontdesk').pendingModel=null;
 assert.equal(c.modelSync().applied,0);assert.equal(c.modelSync().failed.length,1);
});

test('review instruction read/save route through ManagedProjects.invoke to the instruction ledger, never reviewAccept',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-review-route-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const content=path.join(root,'project');await fs.mkdir(content);
 const calls=[];
 class Fake extends EventEmitter{
   constructor(){super();this.started=false;}
   async start(){this.started=true;}
   snapshot(){return {works:[]};}
   async stop(){}
   async reviewInstructionRead(p){calls.push(['instruction.read',p]);return {workId:p.workId,objectId:p.objectId,revision:0,text:'',savedAt:null};}
   async reviewInstructionSave(p){calls.push(['instruction.save',p]);return {accepted:true,workId:p.workId,objectId:p.objectId,revision:1,savedAt:'2026-10-28T00:00:00.000Z'};}
   async reviewAccept(){calls.push(['accept']);throw Object.assign(Error('instruction action must never fall through to reviewAccept'),{code:'ROUTE_BUG'});}
   async reviewRead(){calls.push(['read']);throw Object.assign(Error('unexpected dispatch'),{code:'ROUTE_BUG'});}
 }
 const fake=new Fake();
 const m=new ManagedProjects({userDataDir:root,host:await storageHost(content,['project-1']),legacy:{projects:new Map()},openController:async()=>fake});
 t.after(()=>m.stop());
 m.controllers.set('project-1',fake);
 // 真实IPC入口（非controller直调）：指令载荷没有reviewVersion，误入reviewAccept必报
 // ‘审校版本令牌无效’（现场9Fj4Op）——必须精确落到指令账本分支。
 const read=await m.invoke('managed.review.instruction.read',{projectId:'project-1',workId:'w-1',objectId:'00000000-0000-4000-8000-000000000001'});
 assert.equal(read.revision,0);
 const saved=await m.invoke('managed.review.instruction.save',{projectId:'project-1',workId:'w-1',objectId:'00000000-0000-4000-8000-000000000001',text:'续作指令草稿。',expectedRevision:0});
 assert.equal(saved.revision,1);
 assert.deepEqual(calls.map(entry=>entry[0]),['instruction.read','instruction.save']);
});
