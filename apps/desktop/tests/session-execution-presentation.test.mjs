import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionStore,groupSession} from '../src/renderer/session-store.mjs';
import {replyPresentation,turnPresentation,processSummary,orchestratorPresentation} from '../src/renderer/session-presentation.mjs';
const base={target:'frontdesk',jobId:'one',sessionId:'session',requestId:'request',speaker:'agent',source:'native'};
const state=(status,extra={})=>({jobs:[{id:'one',target:'frontdesk',status,...extra}],agents:[]});
test('accepted input hides transient and durable native echoes by exact job, never repeated text',()=>{
 const store=createSessionStore();store.reset('p');
 const host={id:'host',target:'frontdesk',jobId:'one',speaker:'user',source:'host',text:'继续',sequence:1};
 const echo={...base,id:'echo',entryId:'native-user',speaker:'user',text:'expanded context, not equal text',sequence:2,streaming:true};
 store.apply('p',{version:1,entries:[host,echo]});
 assert.deepEqual(groupSession(store.getSnapshot()).map(row=>row.id),['host']);
 store.apply('p',{version:1,entries:[{...echo,streaming:false,durable:true}]});
 assert.deepEqual(groupSession(store.getSnapshot()).map(row=>row.id),['host']);
 store.apply('p',{version:1,entries:[{...host,id:'other',jobId:'two',sequence:3}]});
 assert.deepEqual(groupSession(store.getSnapshot()).map(row=>row.id),['host','other']);
 assert.equal(store.getSnapshot().entries.length,3,'projection does not delete original history');store.dispose();
});
test('unbound echoes require full native admission identity; conflicts remain separate',()=>{
 const host={id:'host',target:'frontdesk',jobId:'one',speaker:'user',source:'host',text:'继续'};
 const echo={...base,id:'echo',jobId:null,entryId:'native-user',speaker:'user',text:'继续'};
 const snapshot={entries:[host,echo],deltas:[]};
 const exact=state('running',{collabAttempts:[{sessionId:'session',requestId:'request',nativeEntryId:'native-user'}]});
 const users=rows=>new Set(rows.filter(row=>row.kind==='message'&&row.entry.speaker==='user').map(row=>row.entry.id));
 assert.deepEqual(users(groupSession(snapshot,[],exact)),new Set(['host']));
 assert.deepEqual(users(groupSession(snapshot)),new Set(['host','echo']));
 assert.deepEqual(users(groupSession({entries:[host,{...echo,requestId:'different'}],deltas:[]},[],exact)),new Set(['host','echo']));
 assert.deepEqual(users(groupSession({entries:[{...host,sessionId:'different'},{...echo,jobId:'one'}],deltas:[]},[],exact)),new Set(['host','echo']));
});
test('process-only round exposes running tool and same-turn model without an invented answer',()=>{
 const entries=[{...base,id:'call',text:'',model:'historical-model',provider:'historical-provider',toolCalls:[{id:'read',name:'nozeli_document_read'}]},{...base,id:'result',speaker:'tool',text:'',tool:{name:'other',status:'complete',toolCallId:'other'}}];
 const view=replyPresentation(entries,{...state('running'),model:'CURRENT-MUST-NOT-LEAK'});
 assert.equal(view.answer,null);assert.equal(view.entry.text,'');assert.equal(view.entry.model,'historical-model');assert.equal(view.entry.provider,'historical-provider');
 assert.equal(view.execution.status,'toolrunning');assert.match(processSummary(entries,view.execution),/nozeli_document_read.*1 项待完成/);
 assert.equal(replyPresentation([entries[1]],state('running')).entry.model,undefined);
 const settled=[...entries,{...base,id:'settled',speaker:'tool',tool:{name:'nozeli_document_read',status:'complete',toolCallId:'read'}}];
 assert.deepEqual(turnPresentation(settled,state('running')).pending,[]);
});
test('terminal old turns never inherit current agent activity or stale streaming',()=>{
 const entries=[{...base,id:'old',streaming:true,text:'old reply'}];
 const current={jobs:[{id:'one',target:'frontdesk',status:'completed'},{id:'two',target:'frontdesk',status:'running'}],agents:[{target:'frontdesk',busy:true,starting:true,interactions:[{}]}]};
 assert.equal(turnPresentation(entries,current).status,'completed');
 assert.deepEqual(turnPresentation(entries,current).pending,[]);
 for(const [status,wanted] of [['queued','queued'],['starting','starting'],['waiting','waiting'],['failed','failed'],['interrupted','interrupted'],['blocked','blocked']])assert.equal(turnPresentation([{...base,id:'x'}],state(status)).status,wanted);
 assert.equal(turnPresentation([{...base,id:'x',text:'',reasoning:'thinking',streaming:true}],state('running')).status,'thinking');
 assert.equal(turnPresentation(entries,state('running')).status,'output');
 assert.equal(turnPresentation([{...base,id:'x',text:''}],{}).status,'unknown');
});

test('system debug keeps internal faults out of user-blocking states; active processing needs the live registered event job',()=>{
 const entries=[{...base,id:'read-fault',failed:true,tool:{name:'nozeli_history_read',status:'error'}}];
 const debugState=(state,eventStatus)=>({jobs:[{id:'one',target:'frontdesk',status:'failed',maintenanceBugId:'bug-1',debugEventJobId:'debug-1',debugState:state},...(eventStatus?[{id:'debug-1',type:'maintenance',target:'orchestrator',status:eventStatus,context:{bugId:'bug-1'}}]:[])],agents:[]});
 let view=turnPresentation(entries,debugState('running','running'));
 assert.equal(view.status,'debugging');assert.equal(view.terminal,false);assert.deepEqual(view.pending,[]);
 // Diagnosis saved settles the turn: waiting for the source repair, not "processing".
 view=turnPresentation(entries,debugState('awaiting-fix','completed'));
 assert.equal(view.status,'awaitingFix');assert.equal(view.terminal,true);assert.match(view.label,/等待系统修复/);
 // A stopped or cold event job never claims active debugging, whatever the ledger said.
 for(const setup of [['running','completed'],['queued','completed'],['pending','completed'],['queued'],['running']])
  assert.equal(turnPresentation(entries,debugState(...setup)).status,'debugPending','setup '+setup);
 assert.equal(turnPresentation(entries,debugState('model-unavailable','completed')).status,'modelUnavailable');
 assert.equal(turnPresentation(entries,state('failed',{debugState:'running'})).status,'failed','unbound model prose cannot authorize a debug state');
 assert.equal(turnPresentation(entries,state('interrupted',{maintenanceBugId:'bug-1',debugEventJobId:'debug-1',debugState:'running'})).status,'interrupted','explicit cancellation remains authoritative');
});
test('runtime continuation follows the durable host receipt, never model prose or the historical failure',()=>{
 const entries=[{...base,id:'empty-brief',failed:true,tool:{name:'nozeli_dispatch',status:'error'}},{...base,id:'host-fact',speaker:'system',source:'host',text:'宿主已确认临时续行回执'}];
 const routing={action:'dispatch',intent:'i',workId:'work-1',name:'混沌系统 HTML 演示',at:'2026-01-01T00:00:00.000Z',hostContinuation:{kind:'dispatch-empty-brief',bugId:'bug-1',attemptId:'attempt-1',originalIntent:'i'}};
 const continued=(jobStatus='completed')=>({jobs:[{id:'one',target:'orchestrator',type:'intake',status:jobStatus,maintenanceBugId:'bug-1',debugEventJobId:'debug-1',debugState:'continued-with-known-fault',routing:structuredClone(routing)},{id:'debug-1',type:'maintenance',target:'orchestrator',status:'completed',context:{bugId:'bug-1'}}],works:[{id:'work-1',sourceJob:'one',status:'running'}],agents:[]});
 let view=turnPresentation(entries,continued());
 assert.equal(view.status,'continued');assert.equal(view.terminal,true);assert.match(view.label,/临时恢复/);assert.doesNotMatch(view.label,/已完成/);
 // The still-failed original job and its historical error entries never crush a real receipt.
 assert.equal(turnPresentation(entries,continued('failed')).status,'continued');
 // Without the exact host receipt the continuation claim is not made.
 const noReceipt=continued();delete noReceipt.jobs[0].routing.hostContinuation;
 assert.equal(turnPresentation(entries,noReceipt).status,'awaitingFix');
 const foreignReceipt=continued();foreignReceipt.jobs[0].routing.hostContinuation.bugId='bug-other';
 assert.equal(turnPresentation(entries,foreignReceipt).status,'awaitingFix');
 // Explicit user cancellation stays authoritative over any recovery display.
 assert.equal(turnPresentation(entries,continued('interrupted')).status,'interrupted');
 // Model prose alone cannot claim a continuation.
 assert.equal(turnPresentation(entries,state('failed',{debugState:'continued-with-known-fault'})).status,'failed');
 // continuing: temporary recovery executing only while the event job is genuinely running.
 const continuing=(eventStatus,receipt=false)=>{const s=continued('failed');s.jobs[0].debugState='continuing';s.jobs[0].status='failed';if(!receipt)delete s.jobs[0].routing.hostContinuation;s.jobs[1].status=eventStatus;return s;};
 assert.equal(turnPresentation(entries,continuing('running')).status,'continuing');
 assert.equal(turnPresentation(entries,continuing('running')).terminal,false);
 assert.equal(turnPresentation(entries,continuing('completed')).status,'awaitingFix','stopped recovery without a receipt is not executing');
 assert.equal(turnPresentation(entries,continuing('completed',true)).status,'continued','a committed receipt outlives an interrupted recovery turn');
});
test('orchestrator continuation is not task completion and reports the routed Work state',()=>{
 const entries=[{...base,id:'ask',target:'orchestrator',type:'intake',jobId:'one',speaker:'user',source:'host',text:'我需要制作一个混沌系统的html演示'},{...base,id:'fault',target:'orchestrator',jobId:'one',speaker:'tool',tool:{name:'nozeli_dispatch',status:'error'}}];
 const routing={action:'dispatch',intent:'i',workId:'work-1',name:'混沌系统 HTML 演示',at:'2026-01-01T00:00:00.000Z',hostContinuation:{kind:'dispatch-empty-brief',bugId:'bug-1',attemptId:'attempt-1',originalIntent:'i'}};
 const stateFor=(work,jobStatus='completed')=>({jobs:[{id:'one',target:'orchestrator',type:'intake',status:jobStatus,maintenanceBugId:'bug-1',debugEventJobId:'debug-1',debugState:'continued-with-known-fault',routing},{id:'debug-1',type:'maintenance',target:'orchestrator',status:'completed',context:{bugId:'bug-1'}}],works:work?[{id:'work-1',sourceJob:'one',status:work}]:[],todos:[],agents:[]});
 for(const work of ['queued','running','review']){
  const view=orchestratorPresentation(entries,stateFor(work));
  assert.equal(view.execution.status,'continued','work '+work);
  assert.doesNotMatch(view.activity,/失败/);assert.match(view.activity,/临时恢复/);assert.match(view.activity,/待修复/);
  assert.equal(view.handoff.action,'dispatch');assert.equal(view.handoff.workId,'work-1');assert.equal(view.handoff.status,work);
  assert.match(view.handoff.text,/临时恢复/);
 }
 assert.equal(orchestratorPresentation(entries,stateFor(null)).handoff.status,'unknown','missing Work is never assumed started');
 const failedOriginal=orchestratorPresentation(entries,stateFor('running','failed'));
 assert.equal(failedOriginal.execution.status,'continued');assert.doesNotMatch(failedOriginal.activity,/失败/,'a real receipt is not crushed back to permanent failure');
});
test('actual read denial is visible but successful host-control handoffs are not mislabeled blocked',()=>{
 assert.equal(turnPresentation([{...base,id:'failed',failed:true}],state('completed')).status,'failed');
 const denied={...base,id:'tool',speaker:'tool',tool:{name:'read',status:'complete',output:JSON.stringify({ok:false,hostControl:true,error:{code:'HOST_CONTEXT_BUDGET_EXHAUSTED'}})},text:''};
 const view=replyPresentation([denied],state('completed',{completion:'host-control'}));
 assert.equal(view.execution.status,'blocked');assert.equal(view.entry.text,'');assert.equal(view.answer,null);
 assert.equal(turnPresentation([{...base,id:'dispatch',complete:true,text:'任务已交接'}],state('completed',{completion:'host-control'})).status,'completed');
 assert.equal(turnPresentation([{...base,id:'current',text:''}],state('running',{readBudget:{status:'exhausted'}})).status,'thinking');
 assert.equal(turnPresentation([{...base,id:'answer',text:'依据已读内容给出结论，未读范围明确保留。',complete:true}],state('completed',{readBudget:{status:'exhausted'}})).status,'completed');
 assert.equal(turnPresentation([{...base,id:'old-tool-error',speaker:'tool',tool:{name:'bash',status:'error'}},{...base,id:'recovered-answer',text:'已修正检查脚本并核对结果。',complete:true}],state('completed')).status,'completed');
});
test('accepted queued input has a status before native output, replaced by its exact real turn',()=>{
 const input={id:'accepted',target:'frontdesk',jobId:'one',speaker:'user',source:'host',text:'继续',sequence:3};
 const snapshot={entries:[input],deltas:[]},queued=state('queued');
 const rows=groupSession(snapshot,[],queued);assert.equal(rows[0].id,input.id);assert.equal(rows[1].kind,'reply');
 assert.equal(replyPresentation(rows[1].entries,queued).execution.status,'queued');assert.equal(replyPresentation(rows[1].entries,queued).entry.text,'');
 const real={...base,id:'native-call',sequence:4,text:'',toolCalls:[{id:'call',name:'read'}]};
 const active=groupSession({entries:[input,real],deltas:[]},[],state('running'));
 assert.equal(active.length,2);assert.equal(active[1].id,rows[1].id);assert.equal(active[1].entries[0].id,real.id);
 assert.equal(groupSession(snapshot,[],state('completed')).length,1,'old completed user inputs do not invent missing model answers');
});
test('current host result plus successful job settlement supersedes earlier tool errors only',()=>{
 const entries=[{...base,target:'work',workId:'work',revision:1,id:'error',speaker:'tool',tool:{name:'bash',status:'error'}},{...base,target:'work',workId:'work',revision:1,id:'publish',toolCalls:[{id:'publish',name:'nozeli_result_publish'}],text:'发布成果',complete:true},{...base,target:'work',workId:'work',revision:1,id:'receipt-message',speaker:'system',source:'host',text:'成果已保存'}];
 const current={jobs:[{id:'one',target:'work',revision:1,status:'completed',completion:'host-control'}],works:[{id:'work',revision:1,status:'review',result:{objectId:'result',revision:1}}],receipts:[{kind:'result',workId:'work',jobId:'one',revision:1,objectId:'result'}]};
 const view=turnPresentation(entries,current);
 assert.equal(view.status,'completed');assert.equal(view.label,'已交付 · 待审核');assert.deepEqual(view.pending,[]);
 assert.equal(replyPresentation(entries,{...current,model:'CURRENT-MUST-NOT-LEAK'}).entry.model,undefined);
 for(const status of ['failed','interrupted','unknown','running']){
  const actual=turnPresentation(entries,{...current,jobs:[{...current.jobs[0],status}]}).status;
  assert.equal(actual,status==='running'?'failed':status,'publication does not settle '+status+' job');
 }
 assert.equal(turnPresentation(entries,{...current,storageBlocked:true}).status,'completed','later unrelated storage state does not undo durable delivery');
 for(const patch of [{kind:'problem'},{workId:'other'},{jobId:'old'},{revision:0},{objectId:'old'}])assert.equal(turnPresentation(entries,{...current,receipts:[{...current.receipts[0],...patch}]}).status,'failed');
 for(const patch of [{revision:2},{result:{objectId:'old',revision:1}},{result:{objectId:'result',revision:0}}])assert.equal(turnPresentation(entries,{...current,works:[{...current.works[0],...patch}]}).status,'failed');
 assert.equal(turnPresentation(entries,{...current,receipts:[]}).status,'failed');
 assert.equal(turnPresentation([...entries,{...base,id:'assistant-fault',failed:true}],current).status,'failed','host publication does not erase an assistant failure');
 const frozen={...current.receipts[0],report:{objectId:'result',digest:'a'.repeat(64)},snapshot:{reportDigest:'a'.repeat(64)}};
 const continued={...current,works:[{...current.works[0],status:'running',revision:2,result:null}],receipts:[frozen],jobs:[...current.jobs,{id:'two',target:'work',revision:2,status:'running'}]};
 assert.equal(turnPresentation(entries,continued).status,'completed');assert.equal(turnPresentation(entries,continued).label,'已交付');
 assert.equal(turnPresentation(entries,{...continued,works:[{...continued.works[0],status:'review',result:{objectId:'new-result',revision:2}}]}).label,'已交付');
 assert.equal(turnPresentation(entries,{...continued,receipts:[{...frozen,report:{...frozen.report,objectId:'other'}}]}).status,'failed');
 assert.equal(turnPresentation(entries,{...continued,receipts:[{...frozen,snapshot:{reportDigest:'other'}}]}).status,'failed');
 for(const digest of [undefined,null,'',123,'not-a-digest'])assert.equal(turnPresentation(entries,{...continued,receipts:[{...frozen,report:{...frozen.report,digest},snapshot:{reportDigest:digest}}]}).status,'failed','matching invalid digests are not publication proof');
 const plain=[{...base,id:'plain',complete:true,text:'Historical completed answer'}];
 assert.equal(turnPresentation(plain,{}).status,'completed');
 assert.equal(turnPresentation(plain,{storageBlocked:true}).status,'completed','unrelated storage state does not rewrite historical answers');
 assert.equal(turnPresentation(plain,state('unknown')).status,'unknown');
});
