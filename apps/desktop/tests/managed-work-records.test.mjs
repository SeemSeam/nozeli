import test from 'node:test';
import assert from 'node:assert/strict';
import {managedWorkRecords,intakeLineage,managedInboxTodos} from '../src/domain/managed-work-records.mjs';
const base=()=>({jobs:[],works:[],todos:[],receipts:[],drafts:{}});
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
test('known queued Work supplement merges before management decision',()=>{const s=base();s.works.push({id:'w',name:'Queued',status:'queued'});s.jobs.push(intake('supplement',{context:{boundWorkId:'w'}}));const r=managedWorkRecords(s);assert.equal(r.length,1);assert.equal(r[0].workId,'w');assert.equal(r[0].phase,'补充已接收，主控整理中');});
test('historic failure without timestamp follows its accepted event',()=>{const s=base();s.jobs.push(intake('old',{status:'failed',error:'old error'}));assert.deepEqual(managedWorkRecords(s)[0].events.map(e=>e.id),['old:accepted','old:failed']);});
test('internal maintenance is not waiting for user answer and preserves accepted outcome',()=>{
 const s=base(),w={id:'w',name:'核对',status:'paused',revision:1,maintenance:{status:'repairing',message:'进展保留'}};s.works.push(w);
 let record=managedWorkRecords(s)[0];assert.equal(record.status,'paused');assert.equal(record.phase,'系统正在处理运行问题');assert.equal(record.todoId,undefined);
 w.maintenance.status='needs-version-fix';record=managedWorkRecords(s)[0];assert.equal(record.phase,'系统问题待修复，进展已保留');
 w.status='ended';w.outcome='accept';w.closure={phase:'blocked',decision:'accept'};record=managedWorkRecords(s)[0];assert.equal(record.outcome,'accept');assert.equal(record.phase,'已接受 · 系统问题待修复，进展已保留');
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
 let record=managedWorkRecords(s)[0];assert.equal(record.retryJobId,undefined);assert.equal(record.phase,'后台处理中 · 进展已保留');
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
