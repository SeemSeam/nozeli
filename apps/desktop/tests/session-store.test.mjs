import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionStore,sessionMessages,groupSession,groupSessionWorkflows,followTranscriptTail,updateTranscriptTailLock} from '../src/renderer/session-store.mjs';
const entry=(id,extra={})=>({id,sequence:1,target:'frontdesk',speaker:'agent',text:'reply',source:'native',jobId:'job-1',...extra});
test('frontdesk groups tool events by task without merging user input or unknown history',()=>{
 const entries=[entry('user',{speaker:'user'}),entry('call',{sequence:2,toolCalls:[{id:'read'}]}),entry('result',{sequence:3,speaker:'tool',tool:{output:'source'}}),entry('answer',{sequence:4,text:'final'}),entry('other',{sequence:5,jobId:'job-2'}),entry('unknown',{sequence:6,jobId:null,requestId:null}),entry('host-failure',{sequence:7,speaker:'system',source:'host',text:'Original request failed; no automatic replay'})];
 const rows=groupSession({entries,deltas:[]});
 assert.deepEqual(rows.filter(row=>row.kind==='reply').map(row=>row.entries.map(item=>item.id)),[['call','result','answer','host-failure'],['other']]);
 assert.deepEqual(rows.filter(row=>row.kind==='message').map(row=>row.entry.id),['user','unknown']);
});
test('stream updates coalesce while durable settlement flushes and rejects late ghosts',()=>{
 let queued=null,cancelled=0,published=0;const store=createSessionStore({schedule:callback=>{queued=callback;return()=>cancelled++;}});store.reset('project');store.subscribe(()=>published++);
 store.apply('project',{version:1,entries:[entry('stream',{streaming:true,text:'one'})]});
 store.apply('project',{version:1,entries:[entry('stream',{streaming:true,text:'two'})]});assert.equal(published,0);assert.equal(typeof queued,'function');
 store.apply('project',{version:1,entries:[entry('durable',{replacesId:'stream',streaming:false,text:'complete'})]});
 assert.equal(published,1);assert.equal(cancelled,1);assert.deepEqual(store.getSnapshot().entries.map(e=>e.id),['durable']);
 store.apply('project',{version:1,entries:[entry('durable',{streaming:true,text:'late'})]},{replace:true});assert.equal(store.getSnapshot().entries[0].text,'complete');
});
test('project boundaries reject stale pages and bounded page replacement preserves pinned tag identity',()=>{
 const store=createSessionStore();store.reset('a');const reply=entry('reply');store.apply('a',{version:1,entries:[reply],hasMore:true,nextCursor:'opaque'});store.pin(reply);
 store.apply('a',{version:1,entries:[entry('older')],hasMore:false},{replace:true});assert.deepEqual(store.getSnapshot().entries.map(e=>e.id),['older']);assert.equal(sessionMessages(store.getLookupSnapshot()).find(e=>e.id==='reply').text,reply.text);
 store.reset('b');assert.equal(store.apply('a',{version:1,entries:[reply]}),false);assert.equal(store.has('reply'),false);assert.deepEqual(store.getLookupSnapshot().entries,[]);
});
test('intake cards group orchestrator records; worker rounds isolate by work/job/revision',()=>{
 const state={jobs:[
  {id:'intake-1',target:'orchestrator',type:'intake',status:'completed',routing:{action:'dispatch',intent:'i',workId:'work',name:'站点修复',at:'2026-01-01T00:00:00.000Z'}},
  {id:'backstage-1',target:'orchestrator',type:'backstage',status:'completed'},
 ],works:[{id:'work',sourceJob:'intake-1',revision:1,status:'review'}]};
 const entries=[entry('front'),entry('ask',{sequence:2,speaker:'user',source:'host',target:'orchestrator',jobId:'intake-1',text:'修复站点'}),entry('chat',{sequence:3,target:'orchestrator',jobId:'intake-1',text:'I plan to change files'}),entry('error',{sequence:4,target:'orchestrator',jobId:'intake-1',speaker:'system',source:'host',error:true,text:'routing failed'}),entry('internal',{sequence:5,target:'orchestrator',jobId:'backstage-1',text:'internal maintenance narration'}),entry('internal-error',{sequence:6,target:'orchestrator',jobId:'backstage-1',speaker:'system',source:'host',error:true,text:'backstage failed'}),entry('w1',{sequence:7,target:'work',workId:'work',jobId:'one',revision:1,text:'a'.repeat(50000)}),entry('w2',{sequence:8,target:'work',workId:'work',jobId:'two',revision:2})];
 const rows=groupSession({entries,deltas:[{id:'d-created',sequence:9,kind:'work-created',workId:'work',revision:1,text:'创建工作：站点修复'},{id:'d-created-other',sequence:10,kind:'work-created',workId:'other',revision:1,text:'创建工作：别的'},{id:'d-routing',sequence:11,kind:'routing',jobId:'intake-1',workId:'work',text:'工作路由已更新：dispatch'}]},[{id:'r1',workId:'work',jobId:'one',revision:1,changeSetId:'frozen'},{id:'unseen',workId:'other',jobId:'hidden'}],state);
 const card=rows.find(row=>row.kind==='orchestrator');assert.equal(card.jobId,'intake-1');assert.deepEqual(card.entries.map(item=>item.id),['ask','chat','error']);
 assert.equal(rows.some(row=>row.id==='internal'),false,'non-intake orchestrator narration stays internal');
 assert.deepEqual(rows.filter(row=>row.kind==='message').map(row=>row.entry.id),['internal-error'],'real internal errors stay readable message rows');
 const workers=rows.filter(row=>row.kind==='worker');assert.equal(workers.length,2);assert.equal(workers[0].entries[0].text.length,50000);assert.equal(workers[0].receipts[0].changeSetId,'frozen');assert.equal(workers[1].receipts.length,0);
 assert.deepEqual(rows.filter(row=>row.kind==='delta').map(row=>row.delta.id),['d-created-other'],'visible dispatch card represents its own work-created and routing facts only');
});
test('tail following respects user reading position',()=>{const lock={current:true},element={scrollTop:0,scrollHeight:1000,clientHeight:100};updateTranscriptTailLock(element,lock);followTranscriptTail(element,lock);assert.equal(element.scrollTop,0);element.scrollTop=880;updateTranscriptTailLock(element,lock);followTranscriptTail(element,lock);assert.equal(element.scrollTop,1000);});
test('incremental windows and label caches have explicit count and content budgets',()=>{
 const store=createSessionStore();store.reset('p');
 for(let i=0;i<1000;i++)store.apply('p',{version:1,entries:[entry('e'+i,{sequence:i})],deltas:[{id:'d'+i,sequence:i,text:'fact'}]});
 assert.equal(store.getSnapshot().entries.length,200);assert.equal(store.getSnapshot().deltas.length,200);assert.equal(store.getSnapshot().nextCursor,'before:800');
 for(let i=0;i<100;i++)store.pin(entry('pin'+i));
 assert.equal(store.getLookupSnapshot().entries.filter(e=>e.id.startsWith('pin')).length,64);assert.equal(store.has('pin0'),false);
 store.pin(entry('huge',{text:'x'.repeat(600000)}));assert.equal(store.getLookupSnapshot().entries.find(e=>e.id==='huge').availability,'read-required');
 store.apply('p',{version:1,entries:[entry('giant',{sequence:1001,text:'x'.repeat(3*1024*1024)})]});assert.equal(store.getSnapshot().entries.at(-1).availability,'read-required');
 store.dispose();
});
test('history replaces its window and ignores live incrementals until latest is selected',()=>{
 const store=createSessionStore();store.reset('p');store.apply('p',{version:1,entries:[entry('latest')]});store.setHistoryPage(true);
 store.apply('p',{version:1,entries:[entry('old')],hasMore:true,nextCursor:'before:1'},{replace:true});
 assert.equal(store.apply('p',{version:1,entries:[entry('live')]}),false);assert.deepEqual(store.getSnapshot().entries.map(e=>e.id),['old']);
 store.setHistoryPage(false);store.apply('p',{version:1,entries:[entry('latest-now')]},{replace:true});assert.deepEqual(store.getSnapshot().entries.map(e=>e.id),['latest-now']);store.dispose();
});
test('durable originals exceeding page or pin budgets retain readable success metadata',()=>{
 const store=createSessionStore();store.reset('p');
 const original=entry('long',{text:'界'.repeat(3*1024*1024),durable:true,complete:true,status:'complete',requestId:'native-request',entryId:'native-entry'});
 store.apply('p',{version:1,entries:[original]});
 const message=sessionMessages(store.getSnapshot())[0];
 assert.equal(message.availability,'read-required');assert.equal(message.text,'');assert.equal(message.streaming,false);assert.equal(message.durable,true);assert.equal(message.complete,true);assert.equal(message.status,'complete');assert.match(message.reason,/原文/);
 store.pin({...original,id:'pinned'});const pinned=store.getLookupSnapshot().entries.find(row=>row.id==='pinned');
 assert.equal(pinned.entryId,'native-entry');assert.equal(pinned.requestId,'native-request');assert.equal(pinned.durable,true);
 store.apply('p',{version:1,entries:[{...original,id:'failed-long',failed:true,status:'failed'}]},{replace:true});
 const failure=sessionMessages(store.getSnapshot())[0];
 assert.equal(failure.availability,'read-required');assert.equal(failure.failed,true);assert.equal(failure.status,'failed');
 store.dispose();
});

test('history model evidence survives page clipping and pinned lookup independently of live state',()=>{
 const store=createSessionStore();store.reset('p');
 const original=entry('historical',{provider:'provider-a',model:'model-a',modelStatus:'recorded',text:'x'.repeat(3*1024*1024)});
 store.apply('p',{version:1,entries:[original]});store.pin(original);
 const state={model:'current-model',jobs:[]};
 assert.equal(sessionMessages(store.getSnapshot(),state)[0].model,'model-a');assert.equal(store.getSnapshot().entries[0].provider,'provider-a');
 store.apply('p',{version:1,entries:[entry('new',{sequence:2,provider:'provider-b',model:'model-b',modelStatus:'recorded'})]},{replace:true});
 const pinned=sessionMessages(store.getLookupSnapshot(),state).find(e=>e.id==='historical');assert.equal(pinned.model,'model-a');assert.equal(pinned.provider,'provider-a');assert.equal(pinned.availability,'read-required');
 assert.equal(original.text.length,3*1024*1024);store.dispose();
});

test('clipped background input keeps its task identity in both the page and pinned history',()=>{
 const store=createSessionStore();store.reset('project');
 const input=entry('background-input',{speaker:'user',source:'host',jobId:'accepted-task',taskRequestId:'accepted-task',text:'html source '.repeat(300000)});
 store.apply('project',{version:1,entries:[input]});store.pin(input);
 const row=store.getSnapshot().entries[0];
 assert.equal(row.availability,'read-required');assert.equal(row.taskRequestId,'accepted-task');
 store.apply('project',{version:1,entries:[entry('new-input',{sequence:2,speaker:'user'})]},{replace:true});
 const pinned=store.getLookupSnapshot().entries.find(row=>row.id===input.id);
 assert.equal(pinned.taskRequestId,'accepted-task');assert.equal(pinned.jobId,'accepted-task');assert.equal(pinned.speaker,'user');
 store.dispose();
});

test('accepted background input anchors a pending orchestrator card before any native output',()=>{
 const state={jobs:[{id:'intake-1',target:'orchestrator',type:'intake',status:'queued'}],works:[]};
 const rows=groupSession({entries:[entry('ask',{sequence:5,speaker:'user',source:'host',target:'frontdesk',jobId:'intake-1',taskRequestId:'intake-1',text:'转后台处理'})],deltas:[]},[],state);
 assert.equal(rows.length,2);assert.equal(rows[0].kind,'message');assert.equal(rows[0].entry.text,'转后台处理');
 const card=rows[1];assert.equal(card.kind,'orchestrator');assert.equal(card.jobId,'intake-1');assert(card.sequence>rows[0].sequence);
 assert.deepEqual(card.entries.map(item=>item.id),['ask']);
 const after=groupSession({entries:[entry('ask',{sequence:5,speaker:'user',source:'host',target:'frontdesk',jobId:'intake-1',text:'转后台处理'}),entry('native',{sequence:6,target:'orchestrator',jobId:'intake-1',text:'正在核对任务板'})],deltas:[]},[],{jobs:[{id:'intake-1',target:'orchestrator',type:'intake',status:'running'}],works:[]});
 assert.equal(after.length,2);assert.equal(after[0].id,'ask');assert.equal(after[1].id,card.id);assert.equal(after[1].entries.length,2);assert(after[1].sequence>after[0].sequence&&after[1].sequence<6,'card remains between its accepted input and later native records');
});
test('late orchestrator native journal still orders the intake card before its bound Worker round',()=>{
 const state={jobs:[{id:'intake-1',target:'orchestrator',type:'intake',status:'completed',routing:{action:'dispatch',intent:'i',workId:'work',name:'站点修复',at:'2026-01-01T00:00:00.000Z'}}],works:[{id:'work',sourceJob:'intake-1',status:'running'}]};
 const entries=[entry('w-call',{sequence:10,target:'work',workId:'work',jobId:'worker-1',revision:1,toolCalls:[{id:'c1',name:'bash'}]}),entry('o-plan',{sequence:20,target:'orchestrator',jobId:'intake-1',text:'计划如下'}),entry('o-tool',{sequence:21,target:'orchestrator',jobId:'intake-1',tool:{name:'nozeli_inspect_work',status:'complete'}})];
 const rows=groupSession({entries,deltas:[{id:'d-created',sequence:15,kind:'work-created',workId:'work',revision:1,text:'创建工作：站点修复'}]},[],state);
 assert.deepEqual(rows.map(row=>row.kind),['orchestrator','worker']);assert(rows[0].sequence<rows[1].sequence,'the parent handoff must precede its bound child');
 assert.deepEqual(rows[0].entries.map(item=>item.id),['o-plan','o-tool']);
 assert.equal(rows.some(row=>row.kind==='delta'),false,'dispatch fact already represented by the visible card');
});
test('history pages never inject orchestrator cards for live jobs absent from the page',()=>{
 const state={jobs:[{id:'intake-live',target:'orchestrator',type:'intake',status:'running'},{id:'intake-old',target:'orchestrator',type:'intake',status:'completed'}],works:[]};
 const rows=groupSession({entries:[entry('old-talk',{sequence:1,speaker:'user',source:'native'}),entry('old-ask',{sequence:2,speaker:'user',source:'host',target:'orchestrator',jobId:'intake-old',text:'旧任务'})],deltas:[],hasMore:true,nextCursor:'before:1'},[],state);
 assert.deepEqual(rows.map(row=>row.kind),['message','orchestrator']);assert.equal(rows[1].jobId,'intake-old');
 assert.equal(rows.some(row=>row.jobId==='intake-live'),false,'running live job outside the window adds no card');
});
test('orchestrator grouping uses exact job identity across accepted inputs and native records',()=>{
 const state={jobs:[{id:'intake-a',target:'orchestrator',type:'intake',status:'completed'},{id:'intake-b',target:'orchestrator',type:'intake',status:'running'}],works:[]};
 const entries=[entry('a-ask',{sequence:1,speaker:'user',source:'host',target:'orchestrator',jobId:'intake-a',text:'A'}),entry('a-native',{sequence:2,target:'orchestrator',jobId:'intake-a',text:'A 计划'}),entry('b-ask',{sequence:3,speaker:'user',source:'host',target:'work',workId:'work',jobId:'intake-b',text:'B 补充'}),entry('b-native',{sequence:4,target:'orchestrator',jobId:'intake-b',text:'B 处理中'})];
 const rows=groupSession({entries,deltas:[]},[],state);
 const cards=rows.filter(row=>row.kind==='orchestrator');
 assert.deepEqual(cards.map(card=>card.jobId),['intake-a','intake-b']);
 assert.deepEqual(cards[0].entries.map(item=>item.id),['a-ask','a-native']);
 assert.deepEqual(cards[1].entries.map(item=>item.id),['b-ask','b-native']);
 assert.equal(rows.some(row=>row.kind==='message'&&['a-native','b-native'].includes(row.entry.id)),false);
});

test('a late continuation card precedes only its exact supplemental Worker round',()=>{
 const state={jobs:[
  {id:'next-input',target:'orchestrator',type:'intake',status:'completed',routing:{action:'continue',workId:'work'}},
  {id:'initial',target:'work',type:'initial',context:{sourceInputJobIds:['original-input']}},
  {id:'supplement',target:'work',type:'supplement',context:{sourceJobId:'next-input'}},
 ],works:[{id:'work',sourceJob:'original-input',status:'running'}]};
 const entries=[entry('old-round',{sequence:1,target:'work',workId:'work',jobId:'initial'}),entry('new-round',{sequence:10,target:'work',workId:'work',jobId:'supplement'}),entry('late-controller',{sequence:20,target:'orchestrator',jobId:'next-input'})];
 const rows=groupSession({entries,deltas:[]},[],state);
 assert.deepEqual(rows.map(row=>row.kind),['worker','orchestrator','worker']);
 assert.equal(rows[0].jobId,'initial');assert.equal(rows[2].jobId,'supplement');
});

test('missing route evidence preserves host clarification facts and unknown failures remain readable',()=>{
 const state={jobs:[{id:'pending',target:'orchestrator',type:'intake',status:'running'}],works:[]};
 const entries=[entry('input',{sequence:1,speaker:'user',source:'host',jobId:'pending'}),entry('failed-legacy',{sequence:2,target:'orchestrator',jobId:'missing',failed:true,text:'原生主控失败记录'}),entry('private-note',{sequence:3,target:'orchestrator',jobId:'missing',text:'无绑定的内部叙述'})];
 const delta={id:'clarification',kind:'routing-clarification',sequence:4,jobId:'pending',text:'请明确范围'};
 const rows=groupSession({entries,deltas:[delta]},[],state);
 assert(rows.some(row=>row.kind==='message'&&row.entry.id==='failed-legacy'));
 assert(!rows.some(row=>row.id==='private-note'));
 assert(rows.some(row=>row.kind==='delta'&&row.delta.id===delta.id),'a card without the route cannot replace the host question');
});

test('workflow identity survives dispatch and preserves the original input exactly once',()=>{
 const input=entry('source',{sequence:1,target:'orchestrator',speaker:'user',source:'host',jobId:'intake',text:'原输入'});
 const job={id:'intake',target:'orchestrator',type:'intake',status:'queued'};
 const snapshot={entries:[input],deltas:[]};
 const before=groupSessionWorkflows(snapshot,[],{jobs:[job],works:[]});
 const after=groupSessionWorkflows(snapshot,[],{jobs:[{...job,routing:{action:'dispatch',workId:'work'}}],works:[{id:'work',sourceJob:'intake',revision:1,status:'queued'}]});
 assert.deepEqual(before.map(row=>row.kind),['workflow']);
 assert.equal(before[0].id,after[0].id);assert.equal(after[0].workId,'work');
 assert.equal(after[0].rows[0].entries[0],input,'the original is retained inside its task, not copied or rendered outside');
 assert.equal(after[0].sequence,input.sequence);
});

test('one exact Work workflow contains original rounds and continuation before final closeout',()=>{
 const state={jobs:[
  {id:'root',target:'orchestrator',type:'intake'},
  {id:'next',target:'orchestrator',type:'intake',routing:{action:'continue',workId:'work'}},
  {id:'first',target:'work',context:{sourceJobId:'root'}},
  {id:'second',target:'work',context:{sourceJobId:'next'}},
 ],works:[{id:'work',sourceJob:'root',sourceInputJobIds:['root','next'],status:'ended',revision:2,name:'同名'}]};
 const entries=[
  entry('plan',{target:'orchestrator',jobId:'root',sequence:1}),
  entry('first-output',{target:'work',jobId:'first',revision:1,sequence:2}),
  entry('foreground',{sequence:3,jobId:'foreground'}),
  entry('second-output',{target:'work',jobId:'second',revision:2,sequence:10}),
  entry('late-plan',{target:'orchestrator',jobId:'next',sequence:20}),
  entry('last-tool',{target:'work',jobId:'second',revision:2,sequence:30,speaker:'tool',tool:{status:'complete',output:'synthetic result'}}),
 ];
 const snapshot={entries,deltas:[]},rows=groupSessionWorkflows(snapshot,[],state),block=rows.find(row=>row.kind==='workflow');
 assert.equal(rows.filter(row=>row.kind==='workflow').length,1);
 assert.deepEqual(block.rows.map(row=>row.kind),['orchestrator','worker','orchestrator','worker','closeout']);
 assert.deepEqual(block.rows.filter(row=>row.kind==='worker').map(row=>row.revision),[1,2]);
 assert.equal(rows.find(row=>row.kind==='reply').entries[0].id,'foreground');
 assert(block.rows.at(-1).sequence>30,'closeout follows the last bound record, not the round start');
 assert.deepEqual(block.rows[3].entries.map(row=>row.id),['second-output','last-tool']);
 const older=groupSessionWorkflows({entries:[entries[1]],deltas:[],hasMore:true,nextCursor:'older'},[],state);
 assert.equal(older.length,1);assert.equal(older[0].id,block.id);
 assert.deepEqual(older[0].rows.map(row=>row.kind),['worker'],'old page never pulls live closeout or absent intake into its bounded window');
 const unrelated=groupSessionWorkflows({entries:[...entries,entry('other-round',{target:'other',jobId:'other-job',revision:1,sequence:11})],deltas:[]},[],{...state,works:[...state.works,{id:'other',sourceJob:'other-root',name:'同名',status:'running',revision:1}]});
 assert.deepEqual(unrelated.filter(row=>row.kind==='workflow').map(row=>row.workId),['work','other']);
});

test('native metadata and unclassified records never become Worker rounds; unbound failures remain readable',()=>{
 const entries=[
  entry('metadata',{target:'work',recordKind:'metadata',entryType:'model_change',speaker:'system',jobId:null,sessionId:'native',availability:'not-loaded'}),
  entry('unclassified',{target:'work',recordKind:'unclassified',jobId:'known',speaker:'system',availability:'read-required'}),
  entry('unbound-error',{target:'work',recordKind:'conversation',jobId:null,requestId:'unbound-request',failed:true,text:'synthetic admission error'}),
  entry('old-unknown',{target:'work',jobId:null,speaker:undefined,availability:'read-required'}),
  entry('legacy-message',{target:'work',source:'legacy',jobId:'old',revision:null,text:'Original readable legacy result'}),
  entry('conversation',{target:'work',recordKind:'conversation',jobId:'real',revision:null,text:'Actual message without revision'}),
 ];
 const rows=groupSession({entries,deltas:[]});
 assert.deepEqual(rows.filter(row=>row.kind==='worker').map(row=>row.entries[0].id),['legacy-message','conversation']);
 assert(!rows.some(row=>row.id==='metadata'),'known session-control metadata stays archived instead of becoming a conversation row');
 for(const original of entries.slice(1,4)){const row=rows.find(row=>row.id===original.id);assert.equal(row.kind,'message');assert.equal(row.unbound,true);assert.equal(row.entry,original);}
});

test('classification and original-read identity survive renderer cache clipping',()=>{
 const store=createSessionStore();store.reset('p');
 store.apply('p',{version:1,entries:[entry('oversized',{target:'work',recordKind:'unclassified',entryType:'custom',text:'x'.repeat(3*1024*1024),read:{method:'session.read',entryId:'oversized'}})]},{replace:true});
 const clipped=store.getSnapshot().entries[0];assert.equal(clipped.recordKind,'unclassified');assert.equal(clipped.entryType,'custom');
 assert.equal(clipped.availability,'read-required');assert.equal(groupSession(store.getSnapshot())[0].unbound,true);store.dispose();
});

test('canonical clarification, pending intake and retry ancestry keep the predispatch workflow identity',()=>{
 for(const context of [{routingQuestionId:'question'},{pendingIntakeId:'root'},{retryOf:'root'}]){
  const root={id:'root',target:'orchestrator',type:'intake'},answer={id:'answer',target:'orchestrator',type:'intake',context};
  const todos=[{id:'question',kind:'routing',sourceJobId:'root'}];
  const input=entry('original',{sequence:1,target:'frontdesk',speaker:'user',source:'host',jobId:'root'});
  const before=groupSessionWorkflows({entries:[input],deltas:[]},[],{jobs:[root],todos,works:[]});
  const entries=[input,entry('clarified',{sequence:2,target:'frontdesk',speaker:'user',source:'host',jobId:'answer'}),entry('worker-output',{sequence:10,target:'work',jobId:'worker',revision:1})];
  const state={jobs:[root,answer,{id:'worker',target:'work',context:{sourceJobId:'answer'}}],todos,works:[{id:'work',sourceJob:'answer',revision:1,status:'running'}]};
  const after=groupSessionWorkflows({entries,deltas:[]},[],state),block=after.find(row=>row.kind==='workflow');
  assert.equal(after.filter(row=>row.kind==='workflow').length,1);
  assert.equal(block.id,before.find(row=>row.kind==='workflow').id);assert.equal(block.workId,'work');
  assert.deepEqual(block.rows.map(row=>row.jobId),['root','answer','worker']);
  assert.deepEqual(after.filter(row=>row.kind==='message'),[]);
  assert.deepEqual(block.rows.flatMap(row=>row.entries||[]).filter(entry=>entry.speaker==='user').map(entry=>entry.id),['original','clarified']);
  const late=groupSessionWorkflows({entries:[entry('root-plan',{target:'orchestrator',jobId:'root',sequence:30}),entry('answer-plan',{target:'orchestrator',jobId:'answer',sequence:40}),entries[2]],deltas:[]},[],state);
  assert.deepEqual(late[0].rows.map(row=>row.jobId),['root','answer','worker'],'late journal projection still puts the ancestor arrangement before its clarification and Worker');
  const history=groupSessionWorkflows({entries:[entries[2]],deltas:[],hasMore:true},[],state);
  assert.equal(history[0].id,block.id);assert.deepEqual(history[0].rows.map(row=>row.jobId),['worker']);
 }
});

test('conversion supplements require canonical ancestry or an explicit Work binding, never conversion reference alone',()=>{
 const root={id:'root',target:'orchestrator',type:'intake'},conversion={id:'conversion',target:'orchestrator',type:'intake',context:{conversionSupplementOf:'root'}};
 const entries=[entry('root-plan',{target:'orchestrator',jobId:'root',sequence:1}),entry('conversion-plan',{target:'orchestrator',jobId:'conversion',sequence:2})];
 const state={jobs:[root,conversion],works:[{id:'work',sourceJob:'root',status:'queued',revision:1}]};
 const unbound=groupSessionWorkflows({entries,deltas:[]},[],state);assert.equal(unbound.filter(row=>row.kind==='workflow').length,2);
 const bound=groupSessionWorkflows({entries,deltas:[]},[],{...state,jobs:[root,{...conversion,context:{...conversion.context,boundWorkId:'work'}}]});
 assert.equal(bound.length,1);assert.deepEqual(bound[0].rows.map(row=>row.jobId),['root','conversion']);
});

test('host originalTask input bound to a real Worker remains inside its round, not an extra source bubble',()=>{
 const initial=entry('initial-input',{target:'work',speaker:'user',source:'host',jobId:'initial',revision:1,text:'synthetic originalTask'});
 const output=entry('initial-output',{target:'work',jobId:'initial',revision:1,sequence:2});
 const state={jobs:[{id:'initial',target:'work',type:'initial'}],works:[{id:'work',sourceJob:'intake',revision:1,status:'running'}]};
 const rows=groupSessionWorkflows({entries:[initial,output],deltas:[]},[],state);
 assert.equal(rows.length,1);assert.equal(rows[0].kind,'workflow');assert.equal(rows[0].rows.length,1);
 assert.equal(rows[0].rows[0].kind,'worker');assert.deepEqual(rows[0].rows[0].entries,[initial,output]);
});

test('two tasks contain their own human inputs while only ordinary frontdesk discussion remains outside',()=>{
 const jobs=[{id:'a-root',target:'orchestrator',type:'intake'},{id:'b-root',target:'orchestrator',type:'intake'},{id:'a-next',target:'orchestrator',type:'intake',routing:{action:'continue',workId:'a'}},{id:'a-job',target:'a',type:'initial',revision:1},{id:'a-revise',target:'a',type:'supplement',revision:2},{id:'b-job',target:'b',type:'initial',revision:1},{id:'plain',target:'frontdesk',type:'front'}];
 const state={jobs,works:[{id:'a',sourceJob:'a-root',sourceInputJobIds:['a-root','a-next'],revision:2,status:'review'},{id:'b',sourceJob:'b-root',revision:1,status:'review'}]};
 const human=(id,sequence,jobId,text)=>entry(id,{sequence,jobId,speaker:'user',source:'host',...(jobId==='plain'?{}:{taskRequestId:jobId}),text,at:'2026-11-08T00:00:0'+sequence+'Z'});
 const inputs=[human('a-input',1,'a-root','First task'),human('plain-input',3,'plain','Ordinary discussion'),human('b-input',5,'b-root','Second task'),human('a-followup',7,'a-next','Modify original A')];
 const entries=[...inputs,entry('a-one',{target:'a',jobId:'a-job',revision:1,sequence:2}),entry('plain-answer',{jobId:'plain',sequence:4}),entry('b-one',{target:'b',jobId:'b-job',revision:1,sequence:6}),entry('a-two',{target:'a',jobId:'a-revise',revision:2,sequence:8})];
 const rows=groupSessionWorkflows({entries,deltas:[]},[],state),cards=rows.filter(row=>row.kind==='workflow');
 assert.deepEqual(rows.map(row=>row.kind==='workflow'?row.workId:row.entry?.id||row.entries[0].id),['a','plain-input','plain-answer','b']);
 assert.deepEqual(cards.map(row=>row.sequence),[1,5]);
 const inside=cards.flatMap(card=>card.rows.flatMap(row=>row.entries||[row.entry]).filter(Boolean)).filter(entry=>entry.speaker==='user');
 assert.deepEqual(inside.map(row=>[row.id,row.sequence,row.at,row.text]),[inputs[0],inputs[3],inputs[2]].map(row=>[row.id,row.sequence,row.at,row.text]));
 assert.deepEqual(cards[0].rows.filter(row=>row.kind==='worker').map(row=>row.revision),[1,2]);
});

test('converted input, Worker discussion and bound diagnostics stay in the exact task without claiming unknown ownership',()=>{
 const original=entry('converted',{sequence:1,target:'frontdesk',speaker:'user',source:'host',jobId:'front',taskRequestId:'intake',text:'Original frozen request'});
 const question=entry('question',{sequence:3,target:'work',workId:'work',jobId:'discussion',speaker:'user',source:'host',text:'Why this change?'});
 const answer=entry('answer',{sequence:4,target:'work',workId:'work',jobId:'discussion',text:'The exact Worker explanation'});
 const diagnostic=entry('diagnostic',{sequence:5,target:'work',workId:'work',jobId:null,speaker:'system',recordKind:'unclassified',availability:'read-required'});
 const unknown=entry('unknown',{sequence:6,target:'orchestrator',jobId:null,speaker:'system',failed:true,text:'Unassociated diagnostic'});
 const state={jobs:[{id:'front',target:'frontdesk',type:'front'},{id:'intake',target:'orchestrator',type:'intake'},{id:'discussion',target:'work',type:'review-discussion'}],works:[{id:'work',sourceJob:'intake',revision:1,status:'review'}]};
 const rows=groupSessionWorkflows({entries:[original,question,answer,diagnostic,unknown],deltas:[{id:'bound-event',workId:'work',kind:'work-created',sequence:2,text:'Bound event'}]},[],state);
 assert.deepEqual(rows.map(row=>row.kind),['workflow','message']);assert.equal(rows[1].entry,unknown);
 const task=rows[0];assert.equal(task.workId,'work');assert.equal(task.sequence,1);
 assert.deepEqual(task.rows.flatMap(row=>row.entries||[row.entry]).filter(Boolean).map(row=>row.id),['converted','question','answer','diagnostic']);
 assert.equal(task.rows.find(row=>row.entry===diagnostic).unbound,true);
 assert.equal(task.rows.find(row=>row.kind==='delta').delta.id,'bound-event');
 const historical=groupSessionWorkflows({entries:[answer],deltas:[],hasMore:true},[],state);
 assert.deepEqual(historical[0].rows.flatMap(row=>row.entries).map(row=>row.id),['answer'],'a history page cannot manufacture its missing original or later discussion');
});

test('durable first-submission anchors keep task position when the original input left the page',()=>{
 const state={jobs:[
  {id:'a-root',target:'orchestrator',type:'intake'},
  {id:'a-next',target:'orchestrator',type:'intake',routing:{action:'continue',workId:'a'}},
  {id:'b-root',target:'orchestrator',type:'intake'},
  {id:'a-job',target:'a',type:'initial',revision:1},
 ],works:[{id:'a',sourceJob:'a-root',sourceInputJobIds:['a-root','a-next'],revision:1,status:'review'},{id:'b',sourceJob:'b-root',revision:1,status:'review'}]};
 // The original a-input (sequence 10) is absent: viewport eviction or an older
 // scoped page. Without the host anchor the block floated to min(page rows).
 const bInput=entry('b-input',{sequence:20,speaker:'user',source:'host',jobId:'b-root',taskRequestId:'b-root',text:'second task',firstSubmissionSequence:20});
 const aWorker=entry('a-round',{sequence:30,target:'a',workId:'a',jobId:'a-job',revision:1,firstSubmissionSequence:10});
 const aSupplement=entry('a-more',{sequence:50,speaker:'user',source:'host',jobId:'a-next',taskRequestId:'a-next',text:'补充',firstSubmissionSequence:10});
 const rows=groupSessionWorkflows({entries:[bInput,aWorker,aSupplement],deltas:[]},[],state);
 const cards=rows.filter(row=>row.kind==='workflow');
 assert.deepEqual(cards.map(card=>card.sequence),[10,20],'the task stays at its first submission while later tasks keep their own position');
 assert.deepEqual(cards.map(card=>card.workId),['a','b'],'independent tasks never merge');
 const workerOnly=groupSessionWorkflows({entries:[bInput,aWorker],deltas:[],hasMore:true},[],state);
 assert.deepEqual(workerOnly.filter(row=>row.kind==='workflow').map(card=>card.sequence),[10,20],'a worker-only page still pins the block at the original submission');
});

test('viewport eviction keeps the anchored task position without renderer caches',()=>{
 const store=createSessionStore();store.reset('p');
 const state={jobs:[{id:'root',target:'orchestrator',type:'intake'},{id:'job',target:'w',type:'initial',revision:1}],works:[{id:'w',sourceJob:'root',revision:1,status:'review'}]};
 store.apply('p',{version:1,entries:[entry('a-input',{sequence:1,speaker:'user',source:'host',jobId:'root',taskRequestId:'root',text:'first task',firstSubmissionSequence:1})]});
 for(let i=0;i<250;i++)store.apply('p',{version:1,entries:[entry('noise-'+i,{sequence:2+i,speaker:'user',jobId:null,requestId:null})]});
 store.apply('p',{version:1,entries:[entry('a-round',{sequence:252,target:'w',workId:'w',jobId:'job',revision:1,text:'latest round',firstSubmissionSequence:1})]});
 const snapshot=store.getSnapshot();
 assert.equal(snapshot.entries.some(item=>item.id==='a-input'),false,'the original first input left the 200-entry window');
 assert.equal(snapshot.entries.find(item=>item.id==='a-round').firstSubmissionSequence,1);
 const card=groupSessionWorkflows(snapshot,[],state).find(row=>row.kind==='workflow');
 assert.equal(card.sequence,1,'the task block keeps its first-submission position after eviction');
 store.dispose();
});

test('streaming task output settles durably without jumping position',()=>{
 const state={jobs:[{id:'root',target:'orchestrator',type:'intake'},{id:'job',target:'w',type:'initial',revision:1}],works:[{id:'w',sourceJob:'root',revision:1,status:'running'}]};
 const store=createSessionStore();store.reset('p');
 store.apply('p',{version:1,entries:[
  entry('older',{sequence:2,speaker:'user',jobId:null,requestId:null}),
  entry('stream',{sequence:Number.MAX_SAFE_INTEGER-1,target:'w',workId:'w',jobId:'job',revision:1,streaming:true,text:'partial',firstSubmissionSequence:1}),
 ]});
 const during=groupSessionWorkflows(store.getSnapshot(),[],state).find(row=>row.kind==='workflow');
 assert.equal(during.sequence,1,'the live round already anchors at the first submission');
 store.apply('p',{version:1,entries:[entry('settled',{sequence:3,target:'w',workId:'w',jobId:'job',revision:1,replacesId:'stream',text:'final',firstSubmissionSequence:1})]});
 const snapshot=store.getSnapshot();
 assert.equal(snapshot.entries.some(item=>item.id==='stream'),false);
 const after=groupSessionWorkflows(snapshot,[],state).find(row=>row.kind==='workflow');
 assert.equal(after.sequence,1);
 assert.ok(after.rows.some(row=>row.entries?.some(item=>item.id==='settled')),'the durable round stays inside its task');
 store.dispose();
});

test('clarification answers keep the original task anchor on late pages',()=>{
 const root={id:'root',target:'orchestrator',type:'intake'},answer={id:'answer',target:'orchestrator',type:'intake',context:{routingQuestionId:'question'}};
 const todos=[{id:'question',kind:'routing',sourceJobId:'root'}];
 const state={jobs:[root,answer],todos,works:[]};
 const clarified=entry('clarified',{sequence:40,speaker:'user',source:'host',jobId:'answer',taskRequestId:'answer',text:'clarified',firstSubmissionSequence:10});
 const rows=groupSessionWorkflows({entries:[clarified],deltas:[],hasMore:true},[],state);
 assert.equal(rows.filter(row=>row.kind==='workflow').length,1);
 assert.equal(rows[0].sequence,10,'the clarification answer page anchors at the original submission, not the answer position');
});

test('bounded page entries retain the durable task anchor through cache clipping',()=>{
 const store=createSessionStore();store.reset('p');
 const input=entry('big-input',{speaker:'user',source:'host',jobId:'root',taskRequestId:'root',text:'x'.repeat(3*1024*1024),firstSubmissionSequence:9});
 store.apply('p',{version:1,entries:[input]});
 const clipped=store.getSnapshot().entries[0];
 assert.equal(clipped.availability,'read-required');
 assert.equal(clipped.firstSubmissionSequence,9,'the anchor survives the bounded cache projection');
 assert.equal(clipped.taskRequestId,'root');
 store.dispose();
});
