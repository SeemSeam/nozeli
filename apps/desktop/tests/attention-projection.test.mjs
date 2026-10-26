import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';import {ManagedProjects} from '../src/agents/managed-projects.mjs';
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
