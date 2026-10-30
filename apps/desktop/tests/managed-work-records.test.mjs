import test from 'node:test';
import assert from 'node:assert/strict';
import {managedWorkRecords,intakeLineage} from '../src/domain/managed-work-records.mjs';
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
test('explicit retry keeps root, clears stale retry and is compatible with missing historic dates',()=>{
 const s=base();s.jobs.push(intake('one',{status:'interrupted',error:'restart'}));assert.equal(managedWorkRecords(s)[0].retryJobId,'one');
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
