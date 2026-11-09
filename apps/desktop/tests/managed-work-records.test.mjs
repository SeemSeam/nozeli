import test from 'node:test';
import assert from 'node:assert/strict';
import {managedWorkRecords,intakeLineage,managedInboxTodos,publicationOrdinal} from '../src/domain/managed-work-records.mjs';
const base=()=>({jobs:[],works:[],todos:[],receipts:[],drafts:{}});
test('bounded receipt windows retain the host publication ordinal, not their array position',()=>{
 const state={receipts:[{id:'old',workId:'w',kind:'result',objectId:'object-37',publicationNumber:37},{id:'new',workId:'w',kind:'result',objectId:'object-41',publicationNumber:41},{id:'other',workId:'another',kind:'result',objectId:'object-42',publicationNumber:999}]};
 assert.equal(publicationOrdinal(state,'w','object-37'),37);assert.equal(publicationOrdinal(state,'w','object-41'),41);assert.equal(publicationOrdinal(state,'w','object-42'),null);
 assert.equal(publicationOrdinal({receipts:[{workId:'w',kind:'result',objectId:'a'},{workId:'w',kind:'result',objectId:'b'}]},'w','b'),2,'full main state still derives ordinals from its complete ledger');
});
const intake=(id,extra={})=>({id,target:'orchestrator',type:'intake',text:'做一项工作',status:'queued',context:{},at:'2026-10-12T08:00:00Z',...extra});
test('accepted request survives clarification and dispatch as one record',()=>{
 const s=base(),original=intake('one');s.jobs.push(original);const id=managedWorkRecords(s)[0].id;assert.equal(id,'request:one');assert.equal(managedWorkRecords(s)[0].workId,undefined);
 Object.assign(original,{status:'completed',routing:{action:'clarify'}});s.todos.push({id:'question',kind:'routing',sourceJobId:'one',status:'open',text:'选择格式'});s.backstageEvents=[{key:'todo:question',sourceJobId:'one',kind:'routing',status:'blocked',reason:'所需格式信息暂缺'}];const blocked=managedWorkRecords(s)[0];assert.equal(blocked.todoId,undefined);assert.equal(blocked.id,id);assert.equal(blocked.backstage.status,'blocked');assert.equal(blocked.phase,'后台受阻 · 进展已保留');assert.equal(s.todos[0].status,'open');
 const answer=intake('answer',{text:'1',context:{routingQuestionId:'question'}});s.jobs.push(answer);assert.equal(managedWorkRecords(s).length,1);assert.equal(managedWorkRecords(s)[0].todoId,undefined);
 Object.assign(answer,{status:'completed',routing:{action:'dispatch',workId:'w'}});s.todos[0].status='resolved';s.works.push({id:'w',name:'核对',status:'review',sourceJob:'answer',request:'原文+1'});const r=managedWorkRecords(s);assert.equal(r.length,1);assert.equal(r[0].id,id);assert.equal(r[0].workId,'w');assert.deepEqual(r[0].jobIds,['one','answer']);
});
test('same-text separate requests stay distinct; routed supplements merge into original work',()=>{
 const s=base();s.jobs.push(intake('one'),intake('two'));assert.equal(managedWorkRecords(s).length,2);
 s.jobs[0].routing={action:'dispatch',workId:'w'};s.jobs[1].routing={action:'continue',workId:'w'};s.works.push({id:'w',name:'核对',sourceJob:'one',status:'review'});assert.equal(managedWorkRecords(s).length,1);assert.deepEqual(managedWorkRecords(s)[0].jobIds,['one','two']);
});
test('status after clarification disappears instead of leaving a fake open task',()=>{
 const s=base();s.jobs.push(intake('one',{status:'completed',routing:{action:'clarify'}}));s.todos.push({id:'q',sourceJobId:'one',kind:'routing',status:'resolved'});s.jobs.push(intake('answer',{status:'completed',context:{routingQuestionId:'q'},routing:{action:'status'}}));assert.deepEqual(managedWorkRecords(s),[]);
});
test('historic explicit retry lineage keeps root without offering new technical retries',()=>{
 const s=base();s.jobs.push(intake('one',{status:'interrupted',error:'restart'}));assert.equal(managedWorkRecords(s)[0].retryJobId,undefined);
 s.jobs.push(intake('retry',{at:undefined,context:{retryOf:'one'}}));const r=managedWorkRecords(s)[0];assert.equal(r.id,'request:one');assert.equal(r.retryJobId,undefined);assert.equal(r.status,'pending');assert.ok(r.events.length);assert.equal(intakeLineage(s,s.jobs[1])[0].id,'one');
});
test('review occupies quota, pending supplements and closure failures remain understandable',()=>{
 const s=base();s.works.push({id:'w',name:'核对',status:'review'});assert.equal(managedWorkRecords(s)[0].phase,'结果待审查');s.jobs.push({id:'m',target:'w',type:'manual',status:'queued',text:'补充'});assert.equal(managedWorkRecords(s)[0].phase,'补充已接收，等待执行');s.works[0].status='ended';s.works[0].outcome='accept';s.works[0].closure={phase:'blocked',error:'CAS conflict'};s.jobs[0].status='cancelled';const record=managedWorkRecords(s)[0];assert.equal(record.status,'ended');assert.equal(record.closurePhase,'blocked');assert.equal(record.closureError,'CAS conflict');
});
test('lineage cycle fails explicitly',()=>{const s=base();s.jobs.push(intake('a',{context:{retryOf:'b'}}),intake('b',{context:{retryOf:'a'}}));assert.throws(()=>managedWorkRecords(s),/cycle/);});
test('known queued Work supplement merges before management decision',()=>{const s=base();s.works.push({id:'w',name:'Queued',status:'queued'});s.jobs.push(intake('supplement',{context:{boundWorkId:'w'}}));const r=managedWorkRecords(s);assert.equal(r.length,1);assert.equal(r[0].workId,'w');assert.match(r[0].phase,/排队第 1 位/);assert.match(r[0].phase,/补充/);});
test('historic failure without timestamp follows its accepted event',()=>{const s=base();s.jobs.push(intake('old',{status:'failed',error:'old error'}));assert.deepEqual(managedWorkRecords(s)[0].events.map(e=>e.id),['old:accepted','old:failed']);});
test('internal maintenance claims active fixing only from a live repair job',()=>{
 const s=base(),w={id:'w',name:'核对',status:'paused',revision:1,maintenance:{bugId:'bug1',status:'repairing',message:'进展保留'}};s.works.push(w);
 let record=managedWorkRecords(s)[0];assert.equal(record.status,'paused');assert.equal(record.todoId,undefined);assert.equal(record.description,'进展保留');
 assert.doesNotMatch(record.phase,/正在处理/,'durable repairing without a live repair job must not claim active fixing');
 s.jobs.push({id:'repair',type:'maintenance',target:'orchestrator',status:'running',context:{bugId:'bug1'}});
 record=managedWorkRecords(s)[0];assert.match(record.phase,/正在处理/);
 s.jobs.pop();w.maintenance.status='needs-version-fix';record=managedWorkRecords(s)[0];assert.doesNotMatch(record.phase,/正在处理/);assert.equal(record.maintenance.message,'进展保留');
 w.maintenance.status='human-boundary';record=managedWorkRecords(s)[0];assert.doesNotMatch(record.phase,/正在处理/);assert.match(record.phase,/人工核对/);
 w.status='ended';w.outcome='accept';w.closure={phase:'blocked',decision:'accept'};record=managedWorkRecords(s)[0];assert.equal(record.outcome,'accept');assert.match(record.phase,/已接受/);assert.doesNotMatch(record.phase,/正在处理/);
 w.closure.phase='complete';assert.equal(managedWorkRecords(s)[0].phase,'已接受并结束 · 技术收尾完成');
});
test('review revision four retains old failures only as history, without mutating durable facts',()=>{
 const s=base();s.works=[{id:'w',name:'Current report',status:'review',revision:4,result:{objectId:'result4',revision:4}}];
 s.jobs=[{id:'old429',target:'w',type:'initial',status:'failed',revision:1,error:'429'}, {id:'done2',target:'w',type:'supplement',status:'completed',revision:2}, {id:'oldAck',target:'w',type:'supplement',status:'failed',revision:3,error:'ack timeout'}, {id:'done4',target:'w',type:'supplement',status:'completed',revision:4}];
 s.receipts=[{id:'receipt4',kind:'result',workId:'w',objectId:'result4',revision:4,jobId:'done4'}];s.todos=[{id:'todo4',kind:'result',workId:'w',objectId:'result4',revision:4,status:'open'}];
 s.backstageEvents=[{workId:'w',sourceJobId:'oldAck',status:'blocked',kind:'native',reason:'old diagnostic'}];
 const before=structuredClone(s),record=managedWorkRecords(s)[0];
 assert.equal(record.status,'review');assert.equal(record.phase,'结果待审查');assert.equal(record.todoId,'todo4');assert.equal(record.settlementIssue,undefined);assert.equal(record.backstage,undefined);assert.deepEqual(record.supersededJobIds,['old429','done2','oldAck']);assert.deepEqual(s,before);
 s.jobs[3].status='failed';s.jobs[3].error='current settlement failed';const current=managedWorkRecords(s)[0];
 assert.equal(current.settlementIssue.jobId,'done4');assert.equal(current.settlementIssue.error,'current settlement failed');assert.equal(current.phase,'结果已保存 · 完成状态待核查');assert.equal(current.todoId,'todo4');
});
test('only proven older input failures and stops lose live precedence',()=>{
 const s=base();s.works=[{id:'w',status:'paused',revision:4}];s.jobs=[intake('old',{status:'failed',revision:3,context:{boundWorkId:'w'}}),{id:'oldStop',target:'w',revision:3,status:'interrupted',interruptionReason:'user-interrupted'}];
 let record=managedWorkRecords(s)[0];assert.equal(record.retryJobId,undefined);assert.doesNotMatch(record.phase,/处理中|执行中/);
 s.jobs[0].revision=4;record=managedWorkRecords(s)[0];assert.equal(record.retryJobId,'old');assert.equal(record.phase,'补充处理失败，待重试');
 delete s.jobs[0].revision;assert.equal(managedWorkRecords(s)[0].retryJobId,'old','unknown input version must not be silently discarded');
 s.jobs.shift();s.jobs[0].revision=4;assert.equal(managedWorkRecords(s)[0].phase,'本轮已停止 · 等待明确补充');
});

test('approved current publication is not historical merely because its old reminder was cancelled',()=>{
 const s=base();s.works.push({id:'w',revision:9,status:'closing',outcome:'accept',result:{objectId:'r9'},closure:{phase:'blocked',binding:{objectId:'r9'}}});
 s.todos.push({id:'current',workId:'w',kind:'result',revision:9,objectId:'r9',status:'cancelled'},{id:'older',workId:'w',kind:'result',revision:8,objectId:'r8',status:'superseded'});
 const records=managedInboxTodos(s);assert.equal(records.find(r=>r.id==='current').historical,false);assert.equal(records.find(r=>r.id==='current').pending,false);assert.equal(records.find(r=>r.id==='older').historical,true);
 s.works[0].status='ended';s.works[0].closure.phase='complete';assert.equal(managedInboxTodos(s).find(r=>r.id==='current').historical,true);
});

test('unrouted internal failure preserves exact user goal and diagnostics without offering repair',()=>{
 const s=base();s.jobs.push(intake('failed',{text:'[protocol wrapper] nozeli_inspect_work @state cursor=""',context:{userGoal:'开始落盘',sourceMessageId:'source'},status:'failed',error:'INVALID_CURSOR stack',maintenanceBugId:'bug-runtime',maintenanceFault:{phase:'runtime',code:'INVALID_CURSOR'}}));
 s.backstageEvents=[{sourceJobId:'failed',status:'blocked',kind:'runtime',reason:'INVALID_CURSOR stack'}];
 const before=structuredClone(s),record=managedWorkRecords(s)[0];
 assert.equal(record.name,'开始落盘');assert.equal(record.request,'开始落盘');assert.equal(record.description,'开始落盘');assert.equal(record.status,'failed');assert.equal(record.phase,'系统问题待处理 · 原请求已保留');
 assert.equal(record.maintenance.bugId,'bug-runtime');assert.equal(record.retryJobId,undefined);assert.equal(record.todoId,undefined);assert.equal(record.workId,undefined);assert.equal(record.events.at(-1).detail,'INVALID_CURSOR stack');assert.deepEqual(s,before);
 s.jobs.push({id:'repair',type:'maintenance',status:'running',context:{bugId:'bug-runtime'}});assert.equal(managedWorkRecords(s)[0].phase,'系统正在处理运行问题 · 原请求已保留');
 s.jobs[1].status='failed';assert.equal(managedWorkRecords(s)[0].phase,'系统问题待处理 · 原请求已保留');
});

test('saved diagnosis states waiting-for-repair and live recovery says so, without inventing active fixing',()=>{
 const s=base();s.jobs.push(intake('faulted',{status:'failed',error:'task requires original request and brief',maintenanceBugId:'bug1',debugEventJobId:'debug-1',debugState:'awaiting-fix'}),{id:'debug-1',type:'maintenance',target:'orchestrator',status:'completed',context:{bugId:'bug1'},at:'2026-01-01T00:00:00Z'});
 let record=managedWorkRecords(s)[0];
 assert.equal(record.status,'failed');assert.doesNotMatch(record.phase,/正在处理/);assert.match(record.phase,/诊断已保存/);assert.match(record.phase,/等待修复/);
 s.jobs[1].status='running';s.jobs[0].debugState='continuing';
 assert.match(managedWorkRecords(s)[0].phase,/临时恢复/);
 s.jobs[0].debugState='running';
 assert.equal(managedWorkRecords(s)[0].phase,'系统正在处理运行问题 · 原请求已保留');
});
test('debug continuation routes the original request into its single Work while the fault stays unrepaired',()=>{
 const s=base();
 s.jobs.push(intake('one',{status:'completed',error:'task requires original request and brief',maintenanceBugId:'bug1',debugEventJobId:'debug-1',debugState:'continued-with-known-fault',routing:{action:'dispatch',intent:'i',workId:'w',name:'混沌系统 HTML 演示',at:'2026-01-02T00:00:00Z',hostContinuation:{kind:'dispatch-empty-brief',bugId:'bug1',attemptId:'a1',originalIntent:'i'}}}),{id:'debug-1',type:'maintenance',target:'orchestrator',status:'completed',context:{bugId:'bug1'},at:'2026-01-01T00:00:00Z'},{id:'initial',target:'w',type:'initial',status:'running',at:'2026-01-02T00:00:00Z'});
 s.works.push({id:'w',sourceJob:'one',name:'混沌系统 HTML 演示',status:'running',revision:0,request:'我需要制作一个混沌系统的html演示'});
 const records=managedWorkRecords(s);
 assert.equal(records.length,1,'one request, one recovered Work, no second task');
 const record=records[0];
 assert.equal(record.workId,'w');assert.equal(record.status,'running');assert.equal(record.phase,'执行中');
 const texts=record.events.map(event=>event.text).join('|');
 assert.match(texts,/临时恢复/);assert.match(texts,/待修复/);assert.equal(record.maintenance,undefined);
 // Queue and report phases keep deriving from the actual routed Work, never from the old failure.
 s.works[0].status='queued';assert.match(managedWorkRecords(s)[0].phase,/排队/);
 s.works[0].status='review';assert.equal(managedWorkRecords(s)[0].phase,'结果待审查');
});

test('source identity supplies request name and provider failures never claim automatic repair',()=>{
 const s=base();s.messages=[{id:'source',text:'原始引用材料'}];s.jobs.push(intake('provider',{text:'[protocol wrapper]',context:{sourceMessageId:'source'},status:'failed',diagnosticOnly:true,error:'provider refused'}));
 const record=managedWorkRecords(s)[0];assert.equal(record.name,'原始引用材料');assert.equal(record.description,'原始引用材料');assert.equal(record.maintenance,undefined);assert.equal(record.retryJobId,undefined);assert.doesNotMatch(record.phase,/系统正在|修复|完成/);
});

test('settled host-control turn with an unresolved internal fault is not a completed business request',()=>{
 const s=base();s.jobs.push(intake('settled',{status:'completed',completion:'host-control',context:{userGoal:'开始落盘'},maintenanceBugId:'bug-tool',maintenanceFault:{phase:'tool',code:'HOST_INTERNAL_FAILURE'}}));
 const before=structuredClone(s),record=managedWorkRecords(s)[0];
 assert.equal(record.name,'开始落盘');assert.equal(record.status,'blocked');assert.equal(record.maintenance.bugId,'bug-tool');assert.equal(record.retryJobId,undefined);assert.equal(record.workId,undefined);assert.deepEqual(s,before);
 s.jobs.push({id:'repair',type:'maintenance',status:'queued',context:{bugId:'bug-tool'}});
 assert.equal(managedWorkRecords(s)[0].maintenance.status,'queued');assert.equal(s.jobs[0].status,'completed');
});

test('running claims require a live current job; interrupted rounds stay conservative',()=>{
 const s=base();s.works=[{id:'w',name:'汇总',status:'running',revision:2,request:'原始请求',result:{objectId:'r1',revision:1}}];
 s.jobs=[{id:'old',target:'w',type:'initial',status:'interrupted',revision:2,error:'宿主退出，未自动重放'}];
 let record=managedWorkRecords(s)[0];
 assert.doesNotMatch(record.phase,/执行中/,'interrupted round without a live job must not claim execution');
 assert.match(record.phase,/待核查/);assert.equal(record.description,'原始请求');
 s.jobs.push({id:'live',target:'w',type:'initial',status:'running',revision:2,startedAt:'2026-11-05T00:00:00Z'});
 assert.match(managedWorkRecords(s)[0].phase,/执行中/);
 s.jobs[1].status='completed';s.jobs.push({id:'next',target:'w',type:'supplement',status:'queued'});
 const waiting=managedWorkRecords(s)[0];assert.doesNotMatch(waiting.phase,/执行中/);assert.match(waiting.phase,/等待开始执行/);assert.match(waiting.phase,/补充/);
});

test('a running round keeps execution visible beside a queued supplement',()=>{
 const s=base();s.works=[{id:'w',name:'访谈',status:'running',revision:1}];
 s.jobs=[{id:'run',target:'w',type:'initial',status:'running',revision:1},intake('sup',{context:{boundWorkId:'w'}})];
 const record=managedWorkRecords(s)[0];
 assert.match(record.phase,/执行中/);assert.match(record.phase,/补充/);
 s.jobs[0].status='completed';s.jobs.push({id:'sup2',target:'w',type:'supplement',status:'running',revision:1});
 assert.match(managedWorkRecords(s)[0].phase,/正在处理补充/);
});

test('queued Work names the exact slot holders without changing quota facts',()=>{
 const s=base();s.works=[
  {id:'run',name:'执行中的任务',status:'running',revision:1},
  {id:'rev',name:'待审的任务',status:'review',revision:1},
  {id:'pa',name:'暂停的任务',status:'paused',revision:1},
  {id:'q',name:'排队的任务',status:'queued',revision:0,request:'排队请求'}];
 s.jobs.push({id:'live',target:'run',revision:1,status:'running'});
 const before=structuredClone(s),record=managedWorkRecords(s).find(r=>r.workId==='q');
 assert.deepEqual(record.waitingOn.map(h=>h.workId).sort(),['pa','rev','run']);
 assert.deepEqual(record.waitingOn.map(h=>h.status).sort(),['paused','review','running']);
 assert.deepEqual(s,before);
});

test('manually paused scheduling explains the queued Work is held, not forgotten',()=>{
 const s=base();s.works=[{id:'q',status:'queued',revision:0,manualControl:{pause:2}}];
 const record=managedWorkRecords(s)[0];assert.match(record.phase,/排队第 1 位/);assert.match(record.phase,/已暂停调度/);
});

test('finished repair under manual pause waits for explicit resume without replay claims',()=>{
 const s=base();s.works=[{id:'w',status:'paused',revision:1}];s.jobs=[{id:'j',target:'w',type:'initial',status:'failed',revision:1,resumeRequeue:{workRevision:1}}];
 const record=managedWorkRecords(s)[0];assert.match(record.phase,/修复已完成/);assert.match(record.phase,/恢复/);assert.doesNotMatch(record.phase,/正在处理/);
});

test('an interrupted slot holder remains retained but is never described as executing',()=>{
 const s=base();s.works=[{id:'held',name:'旧轮待核对',revision:1,status:'running'},{id:'queue',name:'下一项',revision:0,status:'queued'}];s.jobs=[{id:'stopped',target:'held',revision:1,status:'interrupted'}];
 const before=structuredClone(s),record=managedWorkRecords(s).find(row=>row.workId==='queue');
 assert.deepEqual(record.waitingOn,[{workId:'held',name:'旧轮待核对',status:'unverified-running'}]);assert.deepEqual(s,before);
 s.jobs.push({id:'current',target:'held',revision:1,status:'running'});
 assert.equal(managedWorkRecords(s).find(row=>row.workId==='queue').waitingOn[0].status,'running');
});
