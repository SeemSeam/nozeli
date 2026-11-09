import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {exportTimelineOriginal} from '../src/main/timeline-export.mjs';
import {SessionIndex} from '../src/agents/managed/session-index.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {DesktopHost} from '../src/main/host.mjs';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';
import {managedRuntime,readManagedState} from '../src/agents/managed/managed-storage.mjs';
import {GuidedDemo} from '../src/main/guided-demo.mjs';
import {openTestWorkspace} from './project-storage.fixture.mjs';
import {createLayout,reduceLayout,findView,layoutGroups,taskResourceId} from '../src/domain/workspace-layout.mjs';

function history(projectId='project-a') {
 const jobs=[
  {id:'origin',type:'intake',target:'orchestrator',context:{sourceMessageId:'original'}},
  {id:'clarified',type:'intake',target:'orchestrator',context:{retryOf:'origin'},routing:{workId:'work-a'}},
  {id:'continue',type:'intake',target:'orchestrator',context:{boundWorkId:'work-a'}},
  {id:'round-1',target:'work-a',revision:1,context:{sourceJobId:'clarified'}},
  {id:'round-2',target:'work-a',revision:2,context:{sourceJobId:'continue'}},
  {id:'pending',type:'intake',target:'orchestrator',context:{}},
  {id:'pending-answer',type:'intake',target:'orchestrator',context:{pendingIntakeId:'pending'}},
  {id:'other',type:'intake',target:'orchestrator',context:{},routing:{workId:'work-b'}}
 ];
 const messages=[{id:'original',target:'frontdesk',speaker:'agent',text:'Frozen original'},...jobs.map(job=>({id:'message-'+job.id,jobId:job.id,target:job.target,revision:job.revision,speaker:'agent',text:job.id}))];
 const state={jobs,works:[{id:'work-a',sourceJob:'clarified',revision:2,status:'review'},{id:'work-b',sourceJob:'other'}],messages,sessionIndex:{version:1,sequence:20,entries:[],messageSequences:Object.fromEntries(messages.map((row,i)=>[row.id,i+1])),deltas:[{id:'delta-a',sequence:15,workId:'work-a',kind:'work-created',text:'created'},{id:'delta-b',sequence:16,workId:'work-b',kind:'work-created',text:'other'}]},frontdeskContextEpoch:{sequence:20}};
 return {projectId,root:'/unused/'+projectId,state};
}

test('Work scope includes old/new rounds and exact origin/continuations across pages without changing current state',async()=>{
 const store=history(),index=new SessionIndex(store),before=JSON.stringify(store.state),entries=[],deltas=[];
 let cursor;
 do {const page=await index.page({workId:'work-a',sourceJobId:'origin',cursor,limit:2});entries.unshift(...page.entries);deltas.unshift(...page.deltas);cursor=page.nextCursor;}while(cursor);
 assert.deepEqual(entries.map(row=>row.id),['original','message-origin','message-clarified','message-continue','message-round-1','message-round-2']);
 assert.deepEqual(deltas.map(row=>row.id),['delta-a']);
 assert.equal(JSON.stringify(store.state),before);
 assert.deepEqual((await index.page()).entries,[],'ordinary current context boundary remains unchanged');
 assert.deepEqual((await index.page({sourceJobId:'pending'})).entries.map(row=>row.jobId),['pending','pending-answer']);
 assert.deepEqual((await index.page({sourceJobId:'origin'})).entries.map(row=>row.id),['original','message-origin','message-clarified']);
});

test('scope rejects unknown identities, conflicting lineage and every foreign cursor',async()=>{
 const store=history(),index=new SessionIndex(store),page=await index.page({workId:'work-a',limit:1});
 assert(page.nextCursor);
 for(const query of [{workId:'missing'},{sourceJobId:'missing'},{sourceJobId:'round-1'},{workId:'work-b',sourceJobId:'origin'},{workId:''}])await assert.rejects(index.page(query),{code:'TIMELINE_SCOPE'});
 for(const query of [{},{workId:'work-b'},{workId:'work-a',sourceJobId:'origin'}])await assert.rejects(index.page({...query,cursor:page.nextCursor}),{code:'TIMELINE_PAGE'});
 await assert.rejects(index.page({workId:'work-a',cursor:'before:100'}),{code:'TIMELINE_PAGE'});
 await assert.rejects(new SessionIndex(history('project-b')).page({workId:'work-a',cursor:page.nextCursor}),{code:'TIMELINE_PAGE'});
 store.state.works.push({id:'conflict',sourceJob:'origin'});
 await assert.rejects(index.page({workId:'work-a'}),{code:'TIMELINE_SCOPE'});
 await assert.rejects(index.page({sourceJobId:'origin'}),{code:'TIMELINE_SCOPE'});
});

test('only selected native metadata hydrates; immutable original field protocol is retained',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-scoped-index-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=history();store.root=root;const index=new SessionIndex(store);await fs.mkdir(index.root,{recursive:true});
 for(const [i,jobId] of ['round-1','round-2','other'].entries()){
  const entry={id:'native-'+jobId,type:'message',message:{role:'assistant',content:'Immutable '+jobId}},bytes=Buffer.from(JSON.stringify(entry)),objectId=createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(index.root,objectId+'.json'),bytes);
  store.state.sessionIndex.entries.push({id:entry.id,entryId:entry.id,objectId,jobId,target:jobId==='other'?'orchestrator':'work-a',speaker:'agent',entryType:'message',recordKind:'conversation',sequence:30+i});
 }
 const page=await index.page({workId:'work-a',limit:1});assert.deepEqual(page.entries.map(row=>row.id),['native-round-2']);
 assert.deepEqual([...index.cache.keys()],['native-round-2']);
 const original=await index.read('native-round-2');
 const field=await index.read(original.id,{version:original.read.version,field:'text',offset:0,limit:9});assert.equal(field.content,'Immutable');
 await assert.rejects(index.read(original.id,{version:'forged',field:'text'}),{code:'TIMELINE_VERSION'});
 assert.equal(index.cache.has('native-other'),false);
});

test('scoped host page is available offline without configuration or provider/controller startup',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-scoped-host-')),projectRoot=path.join(root,'project');await fs.mkdir(projectRoot);
 const host=new DesktopHost(root),{project}=await host.pick(projectRoot),projectId=project.id;
 t.after(async()=>{await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 let starts=0;const manager=new ManagedProjects({userDataDir:root,host,legacy:{projects:new Map()},openController:async()=>{starts++;throw Error('provider must not start');}});
 const store=await openTestWorkspace(await managedRuntime(host.storage,projectId),projectRoot,{storage:host.storage,projectId});
 await store.mutate(()=>{const fixture=history(projectId).state;store.state.jobs=fixture.jobs;store.state.works=fixture.works;store.state.messages=fixture.messages;});await store.close();
 const before=await readManagedState(host.storage,projectId,{offline:true});
 const collect=async()=>{
  const pages=[],seen=new Set();let cursor;
  for(let i=0;i<16;i++){
   const frame=await manager.invoke('managed.timeline.page',{projectId,workId:'work-a',limit:2,...(cursor?{cursor}:{})});
   pages.push(frame);assert.equal(frame.hasMore,Boolean(frame.nextCursor));
   if(!frame.hasMore)return pages;
   assert.equal(seen.has(frame.nextCursor),false,'history cursor must advance');seen.add(frame.nextCursor);cursor=frame.nextCursor;
  }
  assert.fail('synthetic scoped history must finish within 16 pages');
 };
 const online=await collect(),bySequence=(a,b)=>a.sequence-b.sequence;
 const entries=online.flatMap(frame=>frame.entries).sort(bySequence),deltas=online.flatMap(frame=>frame.deltas).sort(bySequence);
 assert.deepEqual(entries.map(row=>({id:row.id,text:row.text})),[
  {id:'original',text:'Frozen original'},
  ...['origin','clarified','continue','round-1','round-2'].map(id=>({id:'message-'+id,text:id}))
 ]);
 assert.deepEqual(deltas.map(row=>({kind:row.kind,workId:row.workId,jobId:row.jobId??null})),[
  {kind:'work-created',workId:'work-a',jobId:null},
  {kind:'routing',workId:'work-a',jobId:'clarified'}
 ]);
 assert.deepEqual(await readManagedState(host.storage,projectId,{offline:true}),before,'online history read cannot mutate persisted state');
 host.storage.requireOnline=async()=>{throw Object.assign(Error('offline fixture'),{code:'PROJECT_OFFLINE'});};
 assert.deepEqual(await collect(),online,'every online/offline page, entry, delta and cursor must match');
 assert.deepEqual(await readManagedState(host.storage,projectId,{offline:true}),before,'offline history read cannot mutate persisted state');
 await assert.rejects(manager.invoke('managed.timeline.page',{projectId,workId:'foreign'}),{code:'TIMELINE_SCOPE'});
 const native=Object.create(WorkspaceNative.prototype);native.managedAgents=manager;native.layouts=new Map([[projectId,{views:{task:{viewState:{taskScope:{workId:'work-a'}}}}}]]);
 const task={role:'surface',kind:'task-process',projectId,viewId:'task'};
 await native.taskManagedRead(task,'managed.timeline.page',{projectId,workId:'work-a',limit:2});
 await native.taskManagedRead(task,'managed.timeline.read',{projectId,id:'message-round-1'});
 const status=await native.taskManagedRead(task,'managed.status',{projectId});assert.deepEqual(status.state.works.map(row=>row.id),['work-a']);
 assert.deepEqual(await readManagedState(host.storage,projectId,{offline:true}),before,'cold task reads do not execute or mutate the project');
 assert.equal(starts,0);assert.equal(manager.controllers.size,0);await manager.stop();
});

test('managed timeline locate resolves exact scoped cursors for inline disclosure without mutation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-locate-')),projectRoot=path.join(root,'project');await fs.mkdir(projectRoot);
 const host=new DesktopHost(root),{project}=await host.pick(projectRoot),projectId=project.id;
 t.after(async()=>{await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 const manager=new ManagedProjects({userDataDir:root,host,legacy:{projects:new Map()},openController:async()=>{throw Error('provider must not start');}});
 const store=await openTestWorkspace(await managedRuntime(host.storage,projectId),projectRoot,{storage:host.storage,projectId});
 await store.mutate(()=>{const fixture=history(projectId).state;store.state.jobs=fixture.jobs;store.state.works=fixture.works;store.state.messages=fixture.messages;});await store.close();
 const before=await readManagedState(host.storage,projectId,{offline:true});
 const located=await manager.invoke('managed.timeline.locate',{projectId,workId:'work-a',messageId:'message-round-2'});
 assert.equal(located.messageId,'message-round-2');assert.deepEqual(located.taskScope,{workId:'work-a'});assert(located.cursor.startsWith('scope:'));
 assert.equal((await manager.invoke('managed.timeline.page',{projectId,workId:'work-a',cursor:located.cursor,limit:50})).entries.at(-1).id,'message-round-2');
 // A source-only scope with no Work yet stays locatable for the main card.
 const source=await manager.invoke('managed.timeline.locate',{projectId,sourceJobId:'pending',messageId:'message-pending-answer'});
 assert.deepEqual(source.taskScope,{sourceJobId:'pending'});
 assert.equal((await manager.invoke('managed.timeline.page',{projectId,sourceJobId:'pending',cursor:source.cursor,limit:50})).entries.at(-1).id,'message-pending-answer');
 for(const bad of [{projectId,workId:'work-a',messageId:'message-other'},{projectId,workId:'work-b',messageId:'message-round-2'},{projectId,workId:'work-a',messageId:'delta-a'},{projectId,messageId:'message-round-2'},{projectId,workId:'work-a',messageId:'missing'},{projectId,workId:'work-a',messageId:'message-round-2',extra:1}])
  await assert.rejects(manager.invoke('managed.timeline.locate',bad),error=>['TIMELINE_SCOPE','INVALID_PAYLOAD'].includes(error.code)||error.message==='invalid managed payload');
 assert.deepEqual(await readManagedState(host.storage,projectId,{offline:true}),before,'locate never mutates persisted state');
 assert.equal(manager.controllers.size,0);await manager.stop();
});

test('task surfaces split beside existing chat, reuse fixed scope and retain layout/reading without admission',async()=>{
 const store=history('p'),index=new SessionIndex(store),controls=[],win={show(){},focus(){}},shell={role:'shell',windowId:'main',projectId:'p',generation:0,ready:true,win,wc:{id:1,focus(){},send:(channel,payload)=>controls.push(payload)}};
 const native=Object.create(WorkspaceNative.prototype);native.shell=shell;native.surfaces=new Map();native.windows=new Map([['main',shell]]);native.layouts=new Map();
 let layout=createLayout('p'),chat=Object.values(layout.views).find(view=>view.kind==='conversation');layout=reduceLayout(layout,{type:'activate',viewId:chat.id});
 const conversation={...shell,role:'surface',kind:'conversation',viewId:chat.id};native.surfaces.set(chat.id,conversation);native.layouts.set('p',layout);
 native.layout=async()=>layout;native.managedAgents={projectionSource:async()=>({index,state:store.state})};native.ensureConversation=()=>{throw Error('must not connect');};
 native.command=async(root,payload,options)=>{assert.equal(root,shell);if(payload.command.type==='openTask')assert.equal(options.taskOpen,true);layout=reduceLayout(layout,payload.command);native.layouts.set('p',layout);return {layout};};
 const control={type:'task-workspace',action:'process',projectId:'p',workId:'work-a'};
 const opened=await native.invoke(conversation,'workspace.control',control),view=layout.views[opened.viewId];assert.equal(view.kind,'task-process');assert.equal(view.readOnly,true);assert.equal(layout.mainRoot.kind,'split');assert(findView(layout,chat.id));assert.notEqual(findView(layout,chat.id).group.id,findView(layout,view.id).group.id);assert.equal(controls.length,0,'process never routes to shell sidebar');
 layout=reduceLayout(layout,{type:'restoreViewState',viewId:view.id,viewState:{...view.viewState,reading:{anchor:'message-round-1'}}});layout=reduceLayout(layout,{type:'resize',splitId:layout.mainRoot.id,ratio:.37});
 const reopened=await native.invoke(shell,'workspace.control',{...control,action:'overview'});assert.equal(reopened.viewId,view.id);assert.equal(layout.mainRoot.ratio,.37);assert.deepEqual(layout.views[view.id].viewState.reading,{anchor:'message-round-1'});assert.equal(layout.views[view.id].viewState.taskMode,'overview');
 const other=await native.invoke(shell,'workspace.control',{...control,workId:'work-b'});assert.notEqual(other.viewId,view.id);assert.deepEqual(layout.views[view.id].viewState.taskScope,{workId:'work-a'});
 await assert.rejects(native.invoke(shell,'workspace.control',{...control,workId:'missing'}),{code:'TIMELINE_SCOPE'});
 await native.invoke(shell,'workspace.control',{...control,action:'locate'});assert.equal(controls.at(-1).action,'locate');
 for(const role of [{role:'surface',kind:'web'},{role:'review-discussion'},{role:'detached'}])await assert.rejects(native.invoke({...role,projectId:'p'},'workspace.control',control),{code:'IPC_DENIED'});
 await assert.rejects(native.invoke(conversation,'workspace.control',{...control,projectId:'other'}),{code:'INVALID_COMMAND'});
 native.surfaces.clear();assert.deepEqual(await native.invoke(shell,'workspace.control',{...control,action:'locate'}),{routed:false});
 layout=reduceLayout(layout,{type:'closeContent',viewId:chat.id});const before=Object.values(layout.views).filter(view=>view.kind==='conversation').length;
 await native.invoke(shell,'workspace.control',{...control,sourceJobId:'origin'});assert.equal(Object.values(layout.views).filter(view=>view.kind==='conversation').length,before);assert.equal(findView(layout,chat.id),null);
});

test('task content lifecycle preserves fixed resource scope across split/detach/close/cold restore',()=>{
 let layout=createLayout('p',{workspace:{minimized:true}});layout=reduceLayout(layout,{type:'openTask',scope:{workId:'work-a'},mode:'process'});const view=Object.values(layout.views)[0];assert.equal(Object.values(layout.views).length,1);
 layout=reduceLayout(layout,{type:'splitOpen',viewId:view.id,groupId:layout.mainRoot.id,axis:'x'});assert.equal(layoutGroups(layout).length,2);
 layout=reduceLayout(layout,{type:'detach',viewId:view.id,windowId:'detached-task'});assert.equal(findView(layout,view.id).windowId,'detached-task');
 layout=JSON.parse(JSON.stringify(layout));assert.equal(layout.views[view.id].resourceId,taskResourceId('p',{workId:'work-a'}));
 assert.throws(()=>reduceLayout(layout,{type:'restoreViewState',viewId:view.id,viewState:{taskScope:{workId:'work-b'},taskMode:'process'}}),{code:'LAYOUT_INVALID'});
 layout=reduceLayout(layout,{type:'close',viewId:view.id});assert.equal(layout.views[view.id],undefined);
});

test('task IPC admits only bounded reads and prevents cross-task originals, receipts and writes',async()=>{
 const store=history('p'),index=new SessionIndex(store);store.state.receipts=[{id:'ra',workId:'work-a',objectId:'object-a',changeSetId:'change-a'},{id:'rb',workId:'work-b',objectId:'object-b',changeSetId:'change-b'}];
 const native=Object.create(WorkspaceNative.prototype),frame={url:'app://trusted/',parent:null},wc={id:1,mainFrame:frame},record={role:'surface',kind:'task-process',projectId:'p',viewId:'task',wc};native.origin=frame.url;native.senders=new Map([[1,record]]);native.layouts=new Map([['p',{views:{task:{resourceId:taskResourceId('p',{workId:'work-a'}),viewState:{taskScope:{workId:'work-a'}}}}}]]);native.lifecycle=new Map();
 native.managedAgents={projectionSource:async()=>({index,state:store.state}),invoke:async(op,p)=>({op,p})};const event={sender:wc,senderFrame:frame};
 for(const op of ['managed.send','managed.connect','managed.task','managed.review.accept','file.save','state.write','project-terminal.open','managed.history.list'])assert.throws(()=>native.authorize(event,op,{projectId:'p'}),{code:'IPC_DENIED'});
 assert.equal(native.authorize(event,'managed.timeline.read',{projectId:'p',id:'message-round-1'}),record);
 await native.taskManagedRead(record,'managed.timeline.page',{projectId:'p',workId:'work-a'});
 await native.taskManagedRead(record,'managed.timeline.read',{projectId:'p',id:'message-round-1'});
 for(const [op,p] of [['managed.timeline.page',{workId:'work-b'}],['managed.timeline.page',{}],['managed.timeline.read',{id:'message-other'}],['managed.history.read',{objectId:'object-b'}],['managed.artifact.read',{objectId:'object-b'}],['managed.changes.list',{changeSetId:'change-b'}]])await assert.rejects(native.taskManagedRead(record,op,{projectId:'p',...p}),{code:'TIMELINE_SCOPE'});
 const status=await native.taskManagedRead(record,'managed.status',{projectId:'p'});assert.deepEqual(status.state.works.map(row=>row.id),['work-a']);assert.equal(status.state.jobs.some(row=>row.id==='other'),false);assert.deepEqual(status.state.receipts.map(row=>row.id),['ra']);
 await assert.rejects(native.invoke(record,'workspace.control',{type:'task-workspace',action:'process',projectId:'p',workId:'work-b'}),{code:'TIMELINE_SCOPE'});
});

test('dispatch never broadens a source-only cursor and changing to Work requires a new first page',async()=>{
 const store=history(),index=new SessionIndex(store),first=await index.page({sourceJobId:'pending',limit:1});assert(first.nextCursor);
 store.state.works.push({id:'new-work',sourceJob:'pending-answer'});
 store.state.jobs.find(row=>row.id==='pending-answer').routing={workId:'new-work'};
 store.state.jobs.push({id:'new-round',target:'new-work',context:{sourceJobId:'pending-answer'}});
 store.state.messages.push({id:'new-native-answer',jobId:'new-round',target:'new-work',speaker:'agent',text:'Worker body'});
 store.state.sessionIndex.messageSequences['new-native-answer']=30;
 const continued=await index.page({sourceJobId:'pending',cursor:first.nextCursor,limit:1});assert.deepEqual(continued.entries.map(row=>row.jobId),['pending']);
 assert.equal((await index.page({sourceJobId:'pending'})).entries.some(row=>row.id==='new-native-answer'),false);
 for(const query of [{workId:'new-work'},{workId:'new-work',sourceJobId:'pending'}])await assert.rejects(index.page({...query,cursor:first.nextCursor}),{code:'TIMELINE_PAGE'});
 assert((await index.page({workId:'new-work',sourceJobId:'pending'})).entries.some(row=>row.id==='new-native-answer'));
});

test('byte-limited scoped pages preserve the actual oldest retained boundary without loss or unrelated hydration',async()=>{
 const store=history(),index=new SessionIndex(store);
 store.state.messages=Array.from({length:40},(_,i)=>({id:'large-'+i,jobId:'round-1',target:'work-a',speaker:'agent',text:'x'.repeat(100000)}));
 store.state.sessionIndex.messageSequences=Object.fromEntries(store.state.messages.map((row,i)=>[row.id,i+1]));store.state.sessionIndex.deltas=[];
 const first=await index.page({workId:'work-a',limit:100});assert(first.entries.length<40);assert(first.hasMore);assert(first.nextCursor.endsWith(':before:'+first.entries[0].sequence));
 const all=[...first.entries];let cursor=first.nextCursor;
 while(cursor){const frame=await index.page({workId:'work-a',cursor,limit:100});all.unshift(...frame.entries);cursor=frame.nextCursor;}
 assert.deepEqual(all.map(row=>row.id),store.state.messages.map(row=>row.id));
});

test('guided demo rejects scoped history explicitly instead of returning its full fixed conversation',async()=>{
 const demo=Object.create(GuidedDemo.prototype);demo.verify=async()=>({row:{projection:{messages:[]}}});
 for(const scope of [{workId:'work'},{sourceJobId:'intake'},{workId:'work',sourceJobId:'intake'}])await assert.rejects(demo.managed('managed.timeline.page',{projectId:'demo',...scope}),{code:'DEMO_SCOPE_UNAVAILABLE'});
});

test('Work attribution matches durable workflow bindings, not status hints or arbitrary route text',async()=>{
 const store=history(),index=new SessionIndex(store);
 const add=(id,extra={})=>{
  store.state.jobs.push({id,type:'intake',target:'orchestrator',context:{},...extra});
  store.state.messages.push({id:'input-'+id,jobId:id,target:'orchestrator',speaker:'user',text:id});
  store.state.sessionIndex.messageSequences['input-'+id]=store.state.messages.length;
 };
 add('work-input-only');store.state.works[0].sourceInputJobIds=['work-input-only'];
 add('worker-input-only');store.state.jobs.find(row=>row.id==='round-1').context.sourceInputJobIds=['worker-input-only'];
 for(const action of ['dispatch','continue','cancel','status','clarify'])add('route-'+action,{routing:{action,workId:'work-a'}});
 add('not-orchestrator',{target:'frontdesk',routing:{action:'dispatch',workId:'work-a'}});
 const page=await index.page({workId:'work-a'}),ids=new Set(page.entries.map(row=>row.jobId));
 for(const id of ['work-input-only','worker-input-only','route-dispatch','route-continue','route-cancel']){
  assert(ids.has(id),id+' has durable Work binding');
  assert((await index.page({workId:'work-a',sourceJobId:id})).entries.length);
 }
 for(const id of ['route-status','route-clarify','not-orchestrator']){
  assert.equal(ids.has(id),false,id+' is not a dispatch/continuation binding');
  await assert.rejects(index.page({workId:'work-a',sourceJobId:id}),{code:'TIMELINE_SCOPE'});
 }
});

test('task material navigation admits only receipt-bound frozen paths and exact diff handles',async()=>{
 const store=history('p'),index=new SessionIndex(store);store.state.receipts=[{workId:'work-a',objectId:'oa',changeSetId:'ca'},{workId:'work-b',objectId:'ob',changeSetId:'cb'}];
 const native=Object.create(WorkspaceNative.prototype),messages=[],commands=[],root={projectId:'p',wc:{send:(channel,p)=>messages.push(p)}},record={kind:'task-process',role:'surface',projectId:'p',viewId:'task',windowId:'main',generation:0};
 native.windows=new Map([['main',root]]);native.layouts=new Map([['p',{projectId:'p',revision:0,views:{task:{viewState:{taskScope:{workId:'work-a'}}}}}]]);native.layout=async()=>native.layouts.get('p');native.command=async(r,p)=>{commands.push(p.command);return {opened:true};};
 native.managedAgents={projectionSource:async()=>({state:store.state,index}),invoke:async(op,p)=>{if(op==='managed.changes.list')return {files:[{path:'result.txt',oldPath:null}],nextOffset:null};if(p.fileId!=='file-a')throw Object.assign(Error('foreign file'),{code:'CHANGES_FILE'});return {file:{fileId:p.fileId}};}};
 const request={type:'open-file',projectId:'p',relPath:'result.txt',documentSource:{type:'review',workId:'work-a',objectId:'oa'}};
 await native.invoke(record,'workspace.control',request);assert.equal(commands[0].view.readOnly,true);assert.deepEqual(commands[0].view.documentSource,request.documentSource);
 for(const change of [{relPath:'unrelated.txt'},{relPath:'../result.txt'},{documentSource:{type:'project'}},{documentSource:{type:'review',workId:'work-b',objectId:'ob'}},{documentSource:{type:'review',workId:'work-a',objectId:'ob'}}])await assert.rejects(native.invoke(record,'workspace.control',{...request,...change}),{code:'TIMELINE_SCOPE'});
 const diff={type:'report',projectId:'p',report:{kind:'diff',target:{projectId:'p',changeSetId:'ca',fileId:'file-a'}}};await native.invoke(record,'workspace.control',diff);assert.deepEqual(messages,[diff]);
 await assert.rejects(native.invoke(record,'workspace.control',{...diff,report:{kind:'diff',target:{projectId:'p',changeSetId:'cb',fileId:'file-a'}}}),{code:'TIMELINE_SCOPE'});
 await assert.rejects(native.invoke(record,'workspace.control',{...diff,report:{kind:'diff',target:{projectId:'p',changeSetId:'ca',fileId:'foreign'}}}),{code:'CHANGES_FILE'});
 assert.equal(commands.length,1);assert.equal(messages.length,1);
});

test('task original export keeps the only full path for oversized native records scoped and immutable',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-task-export-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=history('p');store.root=root;const index=new SessionIndex(store);await fs.mkdir(index.root,{recursive:true});
 const bytes=Buffer.from(JSON.stringify({id:'large-task-original',type:'message',message:{role:'assistant',content:'START\n'+('界🙂'.repeat(1300000))+'\nEND'}})),objectId=createHash('sha256').update(bytes).digest('hex');
 await fs.writeFile(path.join(index.root,objectId+'.json'),bytes);
 store.state.sessionIndex.entries.push({id:'large-task-original',entryId:'large-task-original',objectId,jobId:'round-1',target:'work-a',speaker:'agent',entryType:'message',recordKind:'conversation',sequence:40});
 const descriptor=await index.read('large-task-original');assert.equal(descriptor.availability,'read-required');assert.equal(descriptor.read.originalExport.version,objectId);
 const native=Object.create(WorkspaceNative.prototype),frame={url:'app://trusted/',parent:null},wc={id:1,mainFrame:frame},record={role:'surface',kind:'task-process',projectId:'p',viewId:'task',generation:1,wc};native.origin=frame.url;native.senders=new Map([[1,record]]);native.layouts=new Map([['p',{views:{task:{viewState:{taskScope:{workId:'work-a'}}}}}]]);native.lifecycle=new Map();native.managedAgents={projectionSource:async()=>({index,state:store.state})};
 const request={projectId:'p',id:'large-task-original',version:objectId};assert.equal(native.authorize({sender:wc,senderFrame:frame},'managed.timeline.export',request),record);await native.authorizeTaskExport(record,request);
 await assert.rejects(native.authorizeTaskExport(record,{...request,id:'message-other'}),{code:'TIMELINE_SCOPE'});await assert.rejects(native.authorizeTaskExport(record,{...request,version:'0'.repeat(64)}),{code:'TIMELINE_VERSION'});await assert.rejects(native.authorizeTaskExport(record,{...request,projectId:'other'}),{code:'PROJECT_SCOPE_DENIED'});
 const target=path.join(root,'original-export.json');let dialogs=0;
 await exportTimelineOriginal({managed:native.managedAgents,scope:record,dialog:{showSaveDialog:async()=>{dialogs++;return {filePath:target,canceled:false};}},...request});
 assert.equal(dialogs,1);assert.equal(createHash('sha256').update(await fs.readFile(target)).digest('hex'),objectId);assert.equal(createHash('sha256').update(await fs.readFile(path.join(index.root,objectId+'.json'))).digest('hex'),objectId);
});

test('process location survives bootstrap probes with one request identity and explicit overview or cold reopen never replays it',async()=>{
 const store=history(),index=new SessionIndex(store),scope={workId:'work-a'};
 const native=Object.create(WorkspaceNative.prototype),root={projectId:store.projectId},record={projectId:store.projectId,windowId:'detached',generation:1};
 let layout={projectId:store.projectId,revision:1,views:{}},controls=[],contentReady=true;
 native.managedAgents={projectionSource:async()=>({index,state:store.state})};
 native.windows=new Map([['detached',root]]);native.surfaces=new Map();native.layout=async()=>layout;native.layouts=new Map();
 native.command=async(sender,payload,options)=>{
  assert.equal(sender,root);
  if(payload.command.type==='openTask'){
   assert.equal(options.taskOpen,true);assert.deepEqual(payload.command.scope,scope);
   const viewState={...layout.views.task?.viewState,taskScope:scope,taskMode:payload.command.mode};delete viewState.taskLocate;
   layout={...layout,revision:layout.revision+1,views:{task:{id:'task',kind:'task-process',resourceId:taskResourceId(store.projectId,scope),viewState}}};
   native.surfaces.set('task',{role:'surface',kind:'task-process',viewId:'task',projectId:store.projectId,ready:contentReady,wc:{send:(...args)=>controls.push(args),focus(){}},win:{show(){},focus(){}}});
  }else layout={...layout,views:{task:{...layout.views.task,viewState:payload.command.viewState}}};
  native.layouts.set(store.projectId,layout);
  return {layout};
 };
 const result=await native.openTaskProcess(record,scope,'message-round-1');
 assert.equal(result.locationSupported,true);
 assert.equal(result.taskLocate.messageId,'message-round-1');
 const frame=await index.page({...scope,cursor:result.taskLocate.cursor});
 assert.equal(frame.entries.at(-1).id,'message-round-1');
 assert.equal(frame.entries.some(entry=>entry.id==='message-round-2'),false);
 assert.deepEqual(controls[0][1].viewState.taskLocate,result.taskLocate);
 assert.equal(layout.views.task.viewState.taskLocate,undefined,'location is not persisted');
 assert.deepEqual(native.bootstrap(native.surfaces.get('task')).viewState.taskLocate,result.taskLocate,'metadata bootstrap cannot consume delivery');
 assert.deepEqual(native.bootstrap(native.surfaces.get('task')).viewState.taskLocate,result.taskLocate,'repeated host metadata keeps the same deduplication request identity');
 await native.openTaskProcess(record,scope,undefined,'overview');
 assert.equal(layout.views.task.viewState.taskMode,'overview');
 assert.equal(controls.at(-1)[1].viewState.taskLocate,undefined);
 const cold=Object.create(WorkspaceNative.prototype);cold.layouts=new Map([[store.projectId,JSON.parse(JSON.stringify(layout))]]);
 assert.equal(cold.bootstrap(native.surfaces.get('task')).viewState.taskLocate,undefined,'cold reopen retains overview without jumping');
 assert.equal(cold.bootstrap(native.surfaces.get('task')).viewState.taskMode,'overview');
 contentReady=false;const delivered=controls.length;
 const pending=await native.openTaskProcess(record,scope,'message-round-1');
 assert.notEqual(pending.taskLocate.requestId,result.taskLocate.requestId,'a later explicit locate is a new request even for the same message');
 assert.equal(controls.length,delivered,'not-ready content waits for its initial bootstrap');
 const initial=native.bootstrap(native.surfaces.get('task'));
 assert.deepEqual(initial.viewState.taskLocate,pending.taskLocate);
 assert.deepEqual(native.bootstrap(native.surfaces.get('task')).viewState.taskLocate,pending.taskLocate,'an earlier metadata read cannot lose the initial location');
 const located=await index.page({...scope,cursor:initial.viewState.taskLocate.cursor});assert.equal(located.entries.at(-1).id,'message-round-1');
 await assert.rejects(native.openTaskProcess(record,scope,'message-other'),{code:'TIMELINE_SCOPE'});
 await assert.rejects(native.openTaskProcess(record,scope,'missing'),{code:'TIMELINE_SCOPE'});
});

test('explicit task modes retire legacy persisted location without replacing reading choices',()=>{
 let layout=reduceLayout(createLayout('p'),{type:'openTask',scope:{workId:'work-a'},mode:'process'});
 const view=Object.values(layout.views).find(view=>view.kind==='task-process');
 layout=reduceLayout(layout,{type:'restoreViewState',viewId:view.id,viewState:{...view.viewState,taskLocate:{messageId:'old',cursor:'old-cursor'},reading:{anchor:'kept'}}});
 layout=reduceLayout(layout,{type:'openTask',scope:{workId:'work-a'},mode:'overview'});
 assert.equal(layout.views[view.id].viewState.taskMode,'overview');assert.equal(layout.views[view.id].viewState.taskLocate,undefined);
 assert.deepEqual(layout.views[view.id].viewState.reading,{anchor:'kept'});
});
