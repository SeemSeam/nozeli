import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {openTestController} from './project-storage.fixture.mjs';
import {TaskPermissions} from '../src/agents/managed/task-permissions.mjs';
import {randomUUID} from 'node:crypto';
const waitFor=async fn=>{const end=Date.now()+3000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('condition timeout');};
const memoryStorage=()=>{const map=new Map();return {async getLocal(id,key){return map.get(id+':'+key)??null;},async putLocal(id,key,value){map.set(id+':'+key,value);},async list(){return [];}};};
async function controllerFixture(t,{taskPermissions=null}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-attention-'));let c,resolve,reject;const events=[];
  class Session { async preflightToolsDigest() {} async assertToolsDigest() {} constructor(spec,target){Object.assign(this,spec,{target,busy:false,closed:false});}async start(id){this.threadId=id||randomUUID();return this;}async stop(){this.closed=true;reject?.(Error('stopped'));}async interrupt(){events.push('interrupt-requested');return {requested:true};}async prompt(){this.busy=true;events.push(this.target+':start');try{if(this.target==='frontdesk')return await new Promise((r,j)=>{resolve=r;reject=j;});await this.onTool({tool:'nozeli_manage',arguments:{action:'clarify',workName:'',text:'后台任务已接收；请补充验收标准'},callId:randomUUID()});return {text:'',completion:'host-control',threadId:this.threadId};}finally{this.busy=false;}}}
  const options={runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),projectHome:home=>fs.mkdir(home,{recursive:true}),sessionFactory:(spec,target)=>new Session(spec,target),...(taskPermissions?{taskPermissions}:{})};
  c=await openTestController(options);await c.start();t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});
  await c.send('frontdesk','整理项目资料并汇总');
  await waitFor(()=>c.sessions.get('frontdesk').busy);
  return {c,pid:c.projectId,events,front:()=>c.current.get('frontdesk'),finish:()=>resolve({text:'已处理',metrics:{tokens:null,tokenCompleteness:'unavailable'},threadId:c.sessions.get('frontdesk').threadId,completion:'stop',providerStatus:'ok'})};
}
async function managerFixture(t,controller,projectId,permissions=null){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-manager-'));
  const memory={};const memoryStorage2={async getLocal(id,key){return memory[id+':'+key]??null;},async putLocal(id,key,value){memory[id+':'+key]=value;},async list(){return [];}};
  const storage=permissions?permissions.storage:memoryStorage2;
  const host={storage,requireProject:async id=>({id,root:'/tmp/'+id}),requireRegisteredProject:async id=>({id,root:'/tmp/'+id}),recent:async()=>({projects:[]})};
  const manager=new ManagedProjects({userDataDir:root,host,legacy:{projects:new Map()},beforeDocumentOperation:null});
  manager.controllers.set(projectId,controller);
  t.after(async()=>{await manager.stop().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
  return manager;
}
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'attention-projection-'));const host=new DesktopHost(path.join(root,'profile'));await fs.mkdir(path.join(root,'project'));const project=(await host.pick(path.join(root,'project'))).project;const manager=new ManagedProjects({host,userDataDir:path.join(root,'profile'),legacy:{projects:new Map(),connectFlight:new Map()}});t.after(async()=>{await manager.stop();await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});return {manager,host,id:project.id};}
const empty=()=>({jobs:[],works:[],todos:[],receipts:[],agents:[],nativeDraftTargets:[],externalTerminalTargets:[]});
test('ordinary draft and open terminal are quiet; blocked work becomes one actionable reminder and resolves on release',async t=>{
 const {manager,id}=await fixture(t),state=empty();state.nativeDraftTargets=['frontdesk'];state.externalTerminalTargets=['orchestrator'];
 assert.equal((await manager.attentionState(id,state,{connected:true})).todos.length,0);
 state.jobs=[{id:'job',target:'frontdesk',status:'queued'}];const first=await manager.attentionState(id,state,{connected:true});assert.equal(first.todos.length,1);assert.equal(first.todos[0].destination.target,'frontdesk');
 const again=await manager.attentionState(id,state,{connected:true});assert.equal(again.todos[0].id,first.todos[0].id);
 state.nativeDraftTargets=[];assert.equal((await manager.attentionState(id,state,{connected:true})).todos[0].status,'resolved');
});
test('configuration blocker is readable without connecting and resolves only when initialization completes',async t=>{
 const {manager,id}=await fixture(t);await manager.reportConnectionError(id,Object.assign(Error('请完成配置'),{code:'CONFIG_SETUP_REQUIRED'}));
 const before=await manager.status(id);const todo=before.state.todos.find(t=>t.origin==='instance-attention');assert.equal(todo.destination.kind,'settings');assert.equal(manager.controllers.size,0);
 await manager.configurationReady();assert.equal((await manager.status(id)).state.todos.find(t=>t.id===todo.id).status,'resolved');assert.equal(manager.controllers.size,0);
});
test('a native question with a lost owner remains pending recovery across snapshot reload',async t=>{
 const {manager,id}=await fixture(t),state=empty();state.agents=[{target:'frontdesk',ownerId:'owner',threadId:'thread',interactions:[{id:'question',title:'请选择路线',detail:'A/B'}]}];
 const initial=await manager.attentionState(id,state,{connected:true});const todo=initial.todos[0];assert.equal(todo.status,'open');state.agents=[];
 const changed=await manager.attentionState(id,state,{connected:true});assert.equal(changed.todos[0].status,'open');assert.equal(changed.todos[0].destination.kind,'connection');
 assert.equal((await manager.status(id)).state.todos.find(t=>t.id===todo.id).status,'open');
});
test('unconfirmed native completion and pending receipts surface without treating an ordinary busy turn as blocked',async t=>{
 const {manager,id}=await fixture(t),state=empty();state.agents=[{target:'frontdesk',ownerId:'owner',phase:'prompt-inflight',busy:true}];
 assert.equal((await manager.attentionState(id,state,{connected:true})).todos.length,0);
 state.agents[0].phase='manual-unresolved';let projected=await manager.attentionState(id,state,{connected:true});const first=projected.todos.find(t=>t.status==='open');assert.equal(first.destination.kind,'connection');assert.match(first.title,/结束待核对/);
 assert.equal((await manager.attentionState(id,state,{connected:true})).todos.find(t=>t.status==='open').id,first.id);
 state.agents[0].phase='settlement-pending';projected=await manager.attentionState(id,state,{connected:true});assert.equal(projected.todos.find(t=>t.id===first.id).status,'resolved');assert.match(projected.todos.find(t=>t.status==='open').title,/回执落盘/);
 state.agents[0].phase='ready';assert((await manager.attentionState(id,state,{connected:true})).todos.every(t=>t.status==='resolved'));
});
test('only explicit storage, context-recovery and process-budget blockers produce reminders, each with its own destination',async t=>{
 const {manager,id}=await fixture(t),state=empty();state.jobs=[{id:'accepted',target:'frontdesk',status:'queued'}];
 assert.equal((await manager.attentionState(id,state,{connected:true})).todos.length,0,'normal queue is not a fault');
 state.storageBlocked=true;state.frontdeskContextClearFailed=true;state.jobs[0].resourceBlocked=true;
 let projected=await manager.attentionState(id,state,{connected:true});assert.equal(projected.todos.filter(t=>t.status==='open').length,3);
 assert(projected.todos.some(t=>t.destination?.section==='settings-recovery'));assert(projected.todos.some(t=>t.destination?.section==='settings-agents'));assert(projected.todos.some(t=>t.destination?.kind==='connection'));
 state.storageBlocked=false;state.frontdeskContextClearFailed=false;delete state.jobs[0].resourceBlocked;
 projected=await manager.attentionState(id,state,{connected:true});assert(projected.todos.every(t=>t.status==='resolved'));
});
test('workspace answer cannot be applied to an ended question or a replacement owner',async t=>{
 const {manager,id}=await fixture(t),state=empty();
 state.agents=[{target:'frontdesk',ownerId:'old-owner',threadId:'thread',interactions:[{id:'question',method:'confirm',title:'继续吗？'}]}];
 const initial=await manager.attentionState(id,state,{connected:true}),todo=initial.todos[0];
 let applied=false;const controller={snapshot:()=>state,stop:async()=>{},respondInteraction:async()=>{applied=true;}};
 manager.controllers.set(id,controller);t.after(()=>manager.controllers.delete(id));
 state.agents=[{target:'frontdesk',ownerId:'new-owner',threadId:'new-thread',interactions:[{id:'new-question',method:'confirm',title:'另一个问题'}]}];
 await assert.rejects(manager.respondAttention(id,{todoId:todo.id,answer:true}),e=>e.code==='ATTENTION_STALE');
 assert.equal(applied,false,'replacement owner never receives an old answer');
 const replacement=(await manager.attentionState(id,state,{connected:true})).todos.find(t=>t.destination?.ownerId==='new-owner');
 state.agents[0].interactions=[];
 await assert.rejects(manager.respondAttention(id,{todoId:replacement.id,answer:true}),e=>e.code==='ATTENTION_STALE');
 assert.equal(applied,false,'completed question cannot be answered twice');
});
test('native draft backup failure or concurrent edits cannot discard original text',async t=>{
 const {manager,host,id}=await fixture(t),state=empty();
 state.nativeDraftTargets=['frontdesk'];state.jobs=[{id:'job',target:'frontdesk',status:'queued'}];state.agents=[{target:'frontdesk',ownerId:'owner',threadId:'thread'}];
 let nativeText='original unsent';
 const controller={snapshot:()=>state,stop:async()=>{},readNativeDraft:async()=>({text:nativeText}),replaceNativeDraft:async(target,owner,expected,text)=>{assert.equal(nativeText,expected);nativeText=text;return {text};}};
 manager.controllers.set(id,controller);
 const todo=(await manager.attentionState(id,state,{connected:true})).todos.find(t=>t.destination?.kind==='native-draft');
 const put=host.storage.putLocal.bind(host.storage),backupKey='managed:attention-native-draft:'+todo.id;
 host.storage.putLocal=async(project,key,value)=>{if(key===backupKey)throw Error('backup write failed');return put(project,key,value);};
 await assert.rejects(manager.attentionDraft(id,{todoId:todo.id,expectedText:nativeText,text:''},true),/backup write failed/);
 assert.equal(nativeText,'original unsent');
 host.storage.putLocal=put;
 await assert.rejects(manager.attentionDraft(id,{todoId:todo.id,expectedText:'outdated',text:''},true),e=>e.code==='NATIVE_DRAFT_CHANGED');
 assert.equal(nativeText,'original unsent');
 await manager.attentionDraft(id,{todoId:todo.id,expectedText:nativeText,text:'edited'},true);
 assert.equal(nativeText,'edited');assert.equal((await host.storage.getLocal(id,backupKey)).text,'original unsent');
 await manager.attentionDraft(id,{todoId:todo.id,expectedText:nativeText,text:''},true);
 assert.equal(nativeText,'');assert.equal((await host.storage.getLocal(id,backupKey)).text,'original unsent','later edits never overwrite the first recoverable original');
});
test('explicit native draft rejection produces a reminder without pretending that the input was queued',async t=>{
 const {manager,id}=await fixture(t),state=empty();state.agents=[{target:'frontdesk',ownerId:'owner',threadId:'thread'}];state.nativeDraftTargets=['frontdesk'];
 assert.equal((await manager.attentionState(id,state,{connected:true})).todos.length,0,'ordinary unsent native text stays quiet');
 state.nativeDraftBlockedTargets=['frontdesk'];
 const first=await manager.attentionState(id,state,{connected:true}),todo=first.todos.find(t=>t.status==='open');assert.equal(todo.destination.kind,'native-draft');assert.equal(todo.destination.ownerId,'owner');assert.deepEqual(first.jobs,[],'rejected input is not an accepted job');
 state.nativeDraftTargets=[];state.nativeDraftBlockedTargets=[];
 assert.equal((await manager.attentionState(id,state,{connected:true})).todos.find(t=>t.id===todo.id).status,'resolved');assert.deepEqual(state.jobs,[],'clearing a blocker never invents or submits a job');
});
test('an open system terminal and ordinary queue do not invent a blocker',async t=>{
 const {manager,id}=await fixture(t),state=empty();state.externalTerminalTargets=['frontdesk'];state.agents=[{target:'frontdesk',ownerId:'owner'}];state.jobs=[{id:'accepted',target:'frontdesk',status:'queued'}];
 assert.deepEqual((await manager.attentionState(id,state,{connected:true})).todos,[]);
 state.jobs[0].status='running';assert.deepEqual((await manager.attentionState(id,state,{connected:true})).todos,[]);
 state.jobs[0].status='completed';assert.deepEqual((await manager.attentionState(id,state,{connected:true})).todos,[]);
});
test('phase-scoped acknowledgement is atomic across native asks and business report todos',async t=>{
 const {manager,id}=await fixture(t),state=empty();
 state.agents=[{target:'frontdesk',ownerId:'owner',threadId:'thread',interactions:[{id:'question',method:'askDialog',title:'请选择路线',detail:'A/B'}]}];
 state.works=[{id:'work',name:'业务报告样本',status:'review',revision:1}];
 state.todos=[{id:'biz-result',kind:'result',status:'open',workId:'work',revision:1,text:'业务结果待审查 · SEEDED_BUSINESS_RESULT'}];
 const controller={snapshot:()=>state,store:{state},stop:async()=>{}};
 manager.controllers.set(id,controller);t.after(()=>manager.controllers.delete(id));
 const initial=await manager.attentionState(id,state,{connected:true});
 const nativeTodo=initial.todos.find(todo=>todo.origin==='instance-attention'&&todo.destination?.kind==='conversation');
 assert(nativeTodo,'native ask todo exists');
 assert.equal(initial.todos.find(todo=>todo.id==='biz-result').status,'open','the business report todo reaches the notification projection');
 await manager.invoke('managed.attention.ack',{projectId:id,ids:[nativeTodo.id],occurrences:[{id:nativeTodo.id,interrupted:false}]});
 await manager.invoke('managed.attention.ack',{projectId:id,ids:['biz-result'],occurrences:[{id:'biz-result',interrupted:false}]});
 assert.deepEqual([...(await manager.status(id)).state.attentionNotified].sort(),[nativeTodo.id,'biz-result'].sort(),'native and business occurrences acknowledge');
 state.agents=[]; // the native owner is lost: the ask becomes recovery and re-notifies
 await manager.attentionState(id,state,{connected:true});
 const interrupted=(await manager.status(id)).state.todos.find(todo=>todo.id===nativeTodo.id);
 assert.equal(interrupted.interrupted,true,'native ask became a recovery occurrence');
 assert.deepEqual([...(await manager.status(id)).state.attentionNotified],['biz-result'],'the first interruption re-notifies: only the business acknowledgement remains');
 await assert.rejects(manager.invoke('managed.attention.ack',{projectId:id,ids:[nativeTodo.id,'biz-result'],occurrences:[{id:nativeTodo.id,interrupted:false},{id:'biz-result',interrupted:false}]}),error=>error.code==='ATTENTION_STALE','one stale occurrence rejects the whole acknowledgement');
 assert.deepEqual([...(await manager.status(id)).state.attentionNotified],['biz-result'],'the rejected acknowledgement applied nothing');
 await assert.rejects(manager.invoke('managed.attention.ack',{projectId:id,ids:['gone'],occurrences:[{id:'gone',interrupted:false}]}),error=>error.code==='ATTENTION_STALE','a todo absent from ledger and source rejects');
 await manager.invoke('managed.attention.ack',{projectId:id,ids:[nativeTodo.id],occurrences:[{id:nativeTodo.id,interrupted:true}]});
 assert.equal((await manager.status(id)).state.attentionNotified.includes(nativeTodo.id),true,'the interrupted occurrence acknowledges with its own phase');
 await manager.invoke('managed.attention.ack',{projectId:id,ids:[nativeTodo.id]});
 assert.equal((await manager.status(id)).state.attentionNotified.includes(nativeTodo.id),true,'legacy ids-only acknowledgement keeps working');
 state.todos[0].status='closed';
 await manager.attentionState(id,state,{connected:true});
 await assert.rejects(manager.invoke('managed.attention.ack',{projectId:id,ids:['biz-result'],occurrences:[{id:'biz-result',interrupted:false}]}),error=>error.code==='ATTENTION_STALE','a closed business todo rejects');
});

test('pending frontdesk route projects exactly one store todo with decision-ready destination',async t=>{
  const {c,pid,front}=await controllerFixture(t);
  const proposalId=(await c.proposeFrontdeskRoute(front(),'需要后台执行脚本')).proposalId;
  const s=c.snapshot();
  const todos=s.todos.filter(todo=>todo.kind==='frontdesk-route');
  assert.equal(todos.length,1);
  const destination=todos[0].destination;
  assert.equal(destination.kind,'frontdesk-route');assert.equal(destination.proposalId,proposalId);assert.equal(destination.expectedVersion,1);assert.equal(destination.sourceJobId,front().id);
  assert.equal(destination.question.method,'frontdesk-route');assert.match(destination.question.title,/处理方式/);assert.match(destination.question.title,/非安全授权/);
  assert.equal(destination.question.originalText,'整理项目资料并汇总');assert.equal(destination.question.remainingActions,'需要后台执行脚本');
  assert.deepEqual(destination.question.completedOperations,[]);
  assert.equal(s.frontdeskRoutes.filter(route=>route.status==='pending').length,1);
  assert.ok(pid);
});
test('background decision dispatches only the original scope remainder once',async t=>{
  const {c,front}=await controllerFixture(t);
  const proposalId=(await c.proposeFrontdeskRoute(front(),'需要后台执行脚本')).proposalId;
  const result=await c.resolveFrontdeskRoute({proposalId,expectedVersion:1,action:'background',requestKey:'attention:'+proposalId+':1:background'});
  assert.equal(result.accepted,true);assert.equal(result.transferred,true);assert.equal(result.version,2);
  const intake=c.store.state.jobs.find(j=>j.type==='intake');
  assert.ok(intake);assert.match(intake.text,/送到后台/);assert.match(intake.text,/已完成操作是历史/);
  assert.equal(c.store.state.frontdeskRoutes.find(r=>r.id===proposalId).decision.authority,'user-choice');
  assert.equal(c.snapshot().todos.filter(todo=>todo.kind==='frontdesk-route'&&todo.status==='open').length,0);
  const again=await c.resolveFrontdeskRoute({proposalId,expectedVersion:1,action:'background',requestKey:'attention:'+proposalId+':1:background'});
  assert.equal(again.duplicate,true);
  assert.equal(c.store.state.jobs.filter(j=>j.type==='intake').length,1);
});
test('continue decision resumes the frontdesk goal without any shell or terminal',async t=>{
  const {c,front,events}=await controllerFixture(t);
  const proposalId=(await c.proposeFrontdeskRoute(front(),'需要后台执行脚本')).proposalId;
  const result=await c.resolveFrontdeskRoute({proposalId,expectedVersion:1,action:'continue',requestKey:'attention:'+proposalId+':1:continue'});
  assert.equal(result.transferred,false);
  const resume=c.store.state.jobs.find(j=>j.id===result.jobId);
  assert.equal(resume.target,'frontdesk');assert.equal(resume.type,'front');
  assert.equal(c.store.state.frontdeskRoutes.find(r=>r.id===proposalId).status,'continued');
  assert.equal(c.terminals.size,0);
  assert.ok(events.includes('frontdesk:start'));
});
test('cancel closes the proposal with no dispatch and keeps already saved operations',async t=>{
  const {c,front}=await controllerFixture(t);
  const job=front();
  await c.store.mutate(()=>{const saved=c.store.state.jobs.find(j=>j.id===job.id);saved.frontdeskOperations=[{operationId:'op1',callId:'call1',op:'apply',ok:true,at:new Date().toISOString(),value:{relPath:'summary.md',revision:3,digest:'abc'}}];});
  const proposalId=(await c.proposeFrontdeskRoute(job,'需要后台执行脚本')).proposalId;
  const jobsBefore=c.store.state.jobs.length;
  const result=await c.resolveFrontdeskRoute({proposalId,expectedVersion:1,action:'cancel',requestKey:'attention:'+proposalId+':1:cancel'});
  assert.equal(result.accepted,true);assert.equal(result.cancelled,true);assert.equal(result.jobId,null);assert.equal(result.transferred,false);
  assert.equal(c.store.state.jobs.length,jobsBefore);
  const route=c.store.state.frontdeskRoutes.find(r=>r.id===proposalId);
  assert.equal(route.status,'cancelled');assert.equal(route.version,2);
  assert.equal(route.completedOperations.length,1);assert.equal(route.completedOperations[0].value.relPath,'summary.md');
  assert.equal(c.snapshot().todos.filter(todo=>todo.kind==='frontdesk-route').every(todo=>todo.status==='resolved'),true);
  const again=await c.resolveFrontdeskRoute({proposalId,expectedVersion:1,action:'cancel',requestKey:'attention:'+proposalId+':1:cancel'});
  assert.equal(again.duplicate,true);
  assert.equal(c.store.state.jobs.length,jobsBefore);
});
test('stale version is rejected without side effects',async t=>{
  const {c,front}=await controllerFixture(t);
  const proposalId=(await c.proposeFrontdeskRoute(front(),'需要后台执行脚本')).proposalId;
  await assert.rejects(c.resolveFrontdeskRoute({proposalId,expectedVersion:2,action:'background',requestKey:'attention:'+proposalId+':2:background'}),error=>error.code==='STALE_FRONTDESK_ROUTE');
  assert.equal(c.store.state.frontdeskRoutes.find(r=>r.id===proposalId).status,'pending');
  assert.equal(c.store.state.jobs.filter(j=>j.type==='intake').length,0);
});
test('flat managed.attention.respond maps decisions after re-verifying identity and source',async t=>{
  const {c,pid,front}=await controllerFixture(t);
  const manager=await managerFixture(t,c,pid);
  const proposalId=(await c.proposeFrontdeskRoute(front(),'需要后台执行脚本')).proposalId;
  await assert.rejects(manager.invoke('managed.attention.respond',{projectId:pid,attentionKind:'frontdesk-route',attentionId:proposalId,expectedVersion:1,action:'background',sourceJobId:'foreign-job',requestKey:'attention:'+proposalId+':1:background'}),error=>error.code==='ATTENTION_STALE');
  await assert.rejects(manager.invoke('managed.attention.respond',{projectId:pid,attentionKind:'frontdesk-route',attentionId:proposalId,expectedVersion:1,action:'approve',sourceJobId:front().id,requestKey:'attention:'+proposalId+':1:approve'}),error=>error.code==='INVALID_PAYLOAD');
  const ok=await manager.invoke('managed.attention.respond',{projectId:pid,attentionKind:'frontdesk-route',attentionId:proposalId,expectedVersion:1,action:'background',sourceJobId:front().id,requestKey:'attention:'+proposalId+':1:background'});
  assert.equal(ok.accepted,true);assert.equal(ok.transferred,true);
  const duplicate=await manager.invoke('managed.attention.respond',{projectId:pid,attentionKind:'frontdesk-route',attentionId:proposalId,expectedVersion:1,action:'background',sourceJobId:front().id,requestKey:'attention:'+proposalId+':1:background'});
  assert.equal(duplicate.duplicate,true);
  assert.equal(c.store.state.jobs.filter(j=>j.type==='intake').length,1);
});
test('effect-permission decisions project one todo and stay version-bound; legacy cross-project decisions close as migrated',async t=>{
  const storage=memoryStorage();
  const permissions=new TaskPermissions(storage);
  const {c,pid,front}=await controllerFixture(t,{taskPermissions:permissions});
  const job=front();
  const prepared=await permissions.prepareEffect(pid,{sourceJobId:job.id,permissionTaskId:job.context.permissionTaskId,role:'frontdesk',effectType:'host-exec',frozenEffect:{version:1,command:'/usr/bin/marker',args:['--write'],cwd:'/tmp/a',scope:'host-exec',action:'user',elevation:'user',commandDigest:'0'.repeat(64)},originalText:'写入系统标记'});
  assert.equal(prepared.status,'required');assert.equal(prepared.request.version,1);
  const manager=await managerFixture(t,c,pid,permissions);
  const state=await manager.attentionState(pid,c.snapshot(),{connected:true});
  const todos=state.todos.filter(todo=>todo.destination?.kind==='effect-permission'&&todo.status==='open');
  assert.equal(todos.length,1);
  const question=todos[0].destination.question;
  assert.equal(question.command,'/usr/bin/marker');assert.deepEqual(question.args,['--write']);assert.equal(question.cwd,'/tmp/a');assert.equal(question.elevation,'user');assert.match(question.effectHash,/^[a-f0-9]{64}$/);
  assert.equal(todos[0].destination.expectedVersion,1);assert.equal(todos[0].destination.sourceJobId,job.id);
  const flat={projectId:pid,attentionKind:'effect-permission',attentionId:prepared.request.id,expectedVersion:1,sourceJobId:job.id};
  const denied=await manager.invoke('managed.attention.respond',{...flat,action:'deny',requestKey:'attention:'+prepared.request.id+':1:deny'});
  assert.equal(denied.accepted,true);assert.equal(denied.grantId,null);assert.equal(denied.continued,false);
  const duplicate=await manager.invoke('managed.attention.respond',{...flat,action:'deny',requestKey:'attention:'+prepared.request.id+':1:deny'});
  assert.equal(duplicate.duplicate,true);
  await assert.rejects(manager.invoke('managed.attention.respond',{...flat,action:'approve-once',requestKey:'attention:'+prepared.request.id+':1:approve-once'}),error=>error.code==='STALE_ATTENTION'||error.code==='PERMISSION_DECISION_COLLISION');
  const after=await manager.attentionState(pid,c.snapshot(),{connected:true});
  assert.equal(after.todos.filter(todo=>todo.destination?.kind==='effect-permission'&&todo.status==='open').length,0);
  // The ordinary cross-project gate is gone: a stale renderer decision on an
  // old todo closes explicitly (migration), never silently resolves.
  await assert.rejects(manager.invoke('managed.attention.respond',{projectId:pid,attentionKind:'cross-project-permission',attentionId:'legacy-request',expectedVersion:1,sourceJobId:job.id,action:'approve',requestKey:'attention:legacy-request:1:approve'}),error=>error.code==='ATTENTION_STALE');
});
