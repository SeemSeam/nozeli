import test from 'node:test';
import assert from 'node:assert/strict';
import {managedWorkRecords} from '../src/domain/managed-work-records.mjs';
import {workRecordCategory,workRecordServiceState,workRecordControlTarget,workDispositionNotice,workSlotCaptions} from '../src/renderer/managed-work-directory.mjs';

const fixture=()=>({works:[{id:'w',status:'review',revision:4,result:{objectId:'r4',revision:4}}],jobs:[
 {id:'j1',target:'w',revision:1,status:'failed',error:'429'},
 {id:'j3',target:'w',revision:3,status:'failed',error:'ack timeout'},
 {id:'j4',target:'w',revision:4,status:'completed'}
],todos:[{id:'t4',workId:'w',kind:'result',objectId:'r4',revision:4,status:'open'}],receipts:[{id:'receipt4',workId:'w',kind:'result',revision:4,objectId:'r4',jobId:'j4'}]});
const fault=(jobId,state='active')=>({state,projects:[{projectId:'p',blockedJobs:[jobId],blockedWorks:[{workId:'w',jobId}]}]});

test('same Work old service occurrences cannot mask current review or rewrite history',()=>{
 const state=fixture(),record=managedWorkRecords(state)[0],faults=[fault('j1'),fault('j3')],before=structuredClone({state,faults});
 const service=workRecordServiceState(record,'p',faults.values());
 assert.equal(service,null);assert.equal(workRecordCategory(record,state,service),'review');assert.equal(record.todoId,'t4');
 assert.deepEqual({state,faults},before);
});

test('released quota fault is not evidence of a current failure even when the Work identity matches',()=>{
 const state=fixture(),record=managedWorkRecords(state)[0];
 assert.equal(workRecordServiceState(record,'p',[fault('j1','released')]),null);
 assert.equal(workRecordServiceState(record,'p',[fault('j4','released')]),null);
});

test('current, unknown and unversioned service evidence stays visible and project scoped',()=>{
 const state=fixture();state.jobs.push({id:'unversioned',target:'w',status:'failed'});const record=managedWorkRecords(state)[0];
 for(const jobId of ['j4','unversioned','unloaded',undefined]){
  const service=workRecordServiceState(record,'p',[fault('j1'),fault(jobId)]);
  assert.equal(service,'等待服务');assert.equal(workRecordCategory(record,state,service),'fault');
 }
 assert.equal(workRecordServiceState(record,'p',[fault('j4','releasing')]),'恢复中');
 assert.equal(workRecordServiceState(record,'other-project',[fault('j4')]),null);
});

test('failed current publication settlement remains a fault with its exact report todo',()=>{
 for(const status of ['failed','interrupted','unknown']){
  const state=fixture();state.jobs[2].status=status;state.jobs[2].error='current failure';const record=managedWorkRecords(state)[0];
  assert.equal(record.settlementIssue.jobId,'j4');assert.equal(record.todoId,'t4');assert.equal(record.phase,'结果已保存 · 完成状态待核查');
  assert.equal(workRecordCategory(record,state),'fault');
 }
});

test('intake-only service faults and explicit closure/maintenance gates retain precedence',()=>{
 const record={jobIds:['intake']},faults=[{state:'active',projects:[{projectId:'p',blockedJobs:['intake']}]}];
 assert.equal(workRecordServiceState(record,'p',faults),'等待服务');
 const state=fixture(),work=state.works[0],current=managedWorkRecords(state)[0];
 assert.equal(workRecordCategory({...current,maintenance:{status:'needs-version-fix'}},state),'fault');
 assert.equal(workRecordCategory({...current,backstage:{status:'blocked'}},state),'fault');
 work.status='closing';work.closure={phase:'blocked'};assert.equal(workRecordCategory(current,state,'等待服务'),'closing');
 work.closure.phase='complete';assert.equal(workRecordCategory(current,state,'等待服务'),'closing');
 work.status='ended';assert.equal(workRecordCategory(current,state,'等待服务'),'ended');
});

test('unrouted technical failures are read-only while genuine Work controls remain available',()=>{
 for(const status of ['failed','interrupted','unknown','blocked']){
  const state={works:[],jobs:[{id:'intake',type:'intake',status}]},record={name:'开始落盘',status,jobIds:['intake']};
  assert.equal(workRecordControlTarget(record,state),null);
  assert.deepEqual(workRecordControlTarget({...record,workId:'w',maintenance:{status:'needs-version-fix'}},state),{workId:'w',name:'开始落盘'});
 }
 const state={jobs:[{id:'queued',status:'queued'}]};assert.deepEqual(workRecordControlTarget({name:'待安排',jobIds:['queued']},state),{jobId:'queued',name:'待安排'});
});

test('cancelling a never-started queued Work states queue facts, not discard or cleanup',()=>{
 const notice=workDispositionNotice({work:{id:'w',name:'访谈摘要',status:'queued',revision:0},binding:{workId:'w',revision:0,objectId:null,candidateCommit:null},decision:'discard'});
 assert.match(notice,/访谈摘要/);assert.match(notice,/尚未开始执行/);assert.match(notice,/取消排队/);assert.match(notice,/原请求与历史记录保留/);
 assert.doesNotMatch(notice,/丢弃|第 0 版/);
});

test('started Works keep the exact-version discard danger confirmation',()=>{
 const notice=workDispositionNotice({work:{id:'w',name:'访谈摘要',status:'paused',revision:2,threadId:'t',execution:{}},binding:{workId:'w',revision:2,objectId:'o',candidateCommit:null},decision:'discard'});
 assert.match(notice,/第 2 版/);assert.match(notice,/丢弃未合入/);assert.match(notice,/工作树和分支/);
 const accept=workDispositionNotice({work:{id:'w',name:'访谈摘要',status:'review',revision:3,threadId:'t'},binding:{workId:'w',revision:3,objectId:'o',candidateCommit:null},decision:'accept'});
 assert.match(accept,/第 3 版/);assert.match(accept,/安全合入/);
});

test('slot captions cover every holder status the domain can report',()=>{
 for(const status of ['running','paused','review','closing','unverified-ended'])assert.equal(typeof workSlotCaptions[status],'string',status);
});
