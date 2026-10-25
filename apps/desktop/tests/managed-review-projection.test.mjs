import test from 'node:test';
import assert from 'node:assert/strict';
import {managedReviewTodos,managedWorkRecords} from '../src/domain/managed-work-records.mjs';

const state=()=>({works:[],todos:[],jobs:[],receipts:[]});
const work=(id='w',extra={})=>({id,name:'核对文献',request:'核对引用并补全来源',status:'review',revision:2,...extra});
const todo=(id,extra={})=>({id,workId:'w',kind:'result',status:'open',revision:2,objectId:id+'-object',...extra});

test('review projection preserves backend identity, binding and fields without mutating history',()=>{
 const s=state();s.works.push(work('w',{result:{objectId:'new-object',revision:2}}));
 s.todos.push(todo('old',{revision:1}),todo('new',{agentId:'original-worker',readAt:'2026-10-13',custom:{source:'kept'}}));
 s.receipts.push({objectId:'new-object',report:{format:'html-static',excerpt:'完成 已核对 来源。'}});
 const before=structuredClone(s),rows=managedReviewTodos(s);
 assert.deepEqual(rows.map(t=>t.id),['new']);assert.equal(rows[0].agentId,'original-worker');assert.deepEqual(rows[0].custom,{source:'kept'});
 assert.equal(rows[0].kind,'result');assert.equal(rows[0].actionableKind,'result');
 assert.equal(rows[0].excerpt,'完成 已核对 来源。');assert(!rows[0].excerpt.includes('<'));
 assert.notEqual(rows[0],s.todos[1]);assert.deepEqual(s,before);
});

test('legacy same-work reports use highest revision then publication order, independently per work',()=>{
 const s=state();s.works.push(work(),work('other'));
 s.todos.push(todo('v2-first'),todo('v1-last',{revision:1}),todo('v2-latest'),todo('other',{workId:'other'}));
 assert.deepEqual(managedReviewTodos(s).map(t=>t.id),['v2-latest','other']);
 s.todos[2].status='superseded';assert.deepEqual(managedReviewTodos(s).map(t=>t.id),['other']);
});

test('authoritative report pointer rejects stale open todos even when current report has no todo',()=>{
 const s=state();s.works.push(work('w',{result:{objectId:'missing-current',revision:2}}));s.todos.push(todo('stale'));
 assert.deepEqual(managedReviewTodos(s),[]);assert.equal(s.todos[0].status,'open');
});

test('queue and non-open items are not actionable; independent exceptions survive report iteration and ending',()=>{
 const s=state();s.works.push(work());
 s.todos.push(todo('report'),todo('queue',{kind:'queue'}),todo('git',{kind:'git',text:'hook failed'}),todo('recovery',{kind:'recovery',text:'核对文件'}),todo('closure',{kind:'closure'}),todo('resolved',{kind:'system',status:'resolved'}),todo('system',{kind:'system',workId:undefined}));
 const ids=()=>managedReviewTodos(s).map(t=>t.id);
 assert.deepEqual(ids(),['report','git','recovery','closure','system']);
 s.works[0].status='running';s.works[0].revision=3;assert.deepEqual(ids(),['git','recovery','closure','system']);
 s.works[0].status='ended';assert.deepEqual(ids(),['git','recovery','closure','system']);
 assert.equal(s.todos.length,7);
});

test('accepted supplemental input suppresses report review until a current delivery',()=>{
 const s=state();s.works.push(work());s.todos.push(todo('report'));
 s.jobs.push({id:'input',type:'intake',context:{boundWorkId:'w'},status:'queued'});assert.deepEqual(managedReviewTodos(s),[]);
 s.jobs[0].status='completed';assert.equal(managedReviewTodos(s)[0].id,'report');
 s.jobs.push({id:'manual',target:'w',type:'manual',status:'running'});assert.deepEqual(managedReviewTodos(s),[]);
});

test('current paused problem and frontdesk clarification remain distinct with original fields',()=>{
 const s=state();s.works.push(work('w',{status:'paused',problem:{objectId:'problem-object',revision:2}}));
 s.todos.push(todo('old-problem',{kind:'problem',revision:1}),todo('problem',{kind:'problem',text:'请选择数据源'}),{id:'routing',kind:'routing',target:'frontdesk',sourceJobId:'intake',status:'open',text:'目标属于哪个项目？'});
 const rows=managedReviewTodos(s);assert.deepEqual(rows.map(t=>t.id),['problem','routing']);assert.equal(rows[0].phase,'等待回答');assert.equal(rows[1].phase,'需要明确目标');assert.equal(rows[1].target,'frontdesk');assert.equal(rows[1].sourceJobId,'intake');
 s.jobs.push({id:'answer',type:'intake',status:'queued',context:{routingQuestionId:'routing'}});assert.deepEqual(managedReviewTodos(s).map(t=>t.id),['problem']);
});

test('work summary stays the requested goal rather than report or error text',()=>{
 const s=state();s.works.push(work());s.todos.push(todo('report'));s.receipts.push({id:'receipt',workId:'w',kind:'result',objectId:'report-object',report:{format:'markdown',excerpt:'结果与目标不同'}});
 let record=managedWorkRecords(s)[0];assert.equal(record.description,'核对引用并补全来源');assert.equal(record.todoId,'report');
 s.works[0].status='ended';s.works[0].closure={phase:'blocked',decision:'accept',error:'hook rejected'};
 record=managedWorkRecords(s)[0];assert.equal(record.description,'核对引用并补全来源');assert.equal(record.closureError,'hook rejected');
});

test('summary falls back to original user goal when historic work lacks request',()=>{
 const s=state();s.jobs.push({id:'source',type:'intake',text:'expanded evidence',context:{userGoal:'用户原始目标'}});s.works.push(work('w',{request:undefined,sourceJob:'source'}));assert.equal(managedWorkRecords(s)[0].description,'用户原始目标');
});

test('user outcome ends business immediately while technical status remains visible',()=>{
 const s=state();s.works.push(work('w',{status:'ended',outcome:'accept',endedAt:'2026-10-13T08:00:00Z',closure:{decision:'accept',phase:'integrating'}}));
 let record=managedWorkRecords(s)[0];assert.equal(record.status,'ended');assert.equal(record.outcome,'accept');assert.equal(record.closurePhase,'integrating');assert.match(record.events[0].text,/用户接受/);
 s.works[0].closure={decision:'accept',phase:'blocked',error:'CAS changed'};
 record=managedWorkRecords(s)[0];assert.equal(record.status,'ended');assert.equal(record.closurePhase,'blocked');assert.equal(record.closureError,'CAS changed');
 s.works[0].closure={decision:'accept',phase:'complete'};assert.equal(managedWorkRecords(s)[0].closurePhase,'complete');
});

test('discard and historic unknown disposition preserve report entry without inventing success',()=>{
 const s=state();s.todos.push(todo('report'));s.works.push(work('w',{status:'ended',outcome:'discard',closure:{phase:'complete'}}));
 let record=managedWorkRecords(s)[0];assert.equal(record.outcome,'discard');assert.equal(record.todoId,'report');
 delete s.works[0].outcome;delete s.works[0].closure;record=managedWorkRecords(s)[0];assert.equal(record.outcome,undefined);assert.equal(record.todoId,'report');
});

test('empty legacy state has no synthetic actionable todos',()=>{assert.deepEqual(managedReviewTodos({}),[]);});

function failedPublication(){
 const s=state();s.works.push(work('w',{status:'paused',result:{objectId:'saved-object',revision:2}}));
 s.todos.push(todo('saved',{objectId:'saved-object'}));
 s.receipts.push({workId:'w',kind:'result',objectId:'saved-object',revision:2,jobId:'published-job',report:{format:'html-static',excerpt:'Saved candidate'}});
 s.jobs.push({id:'published-job',target:'w',revision:2,type:'initial',status:'failed',error:'collab-drain-timeout'});
 return s;
}
test('saved publication remains readable when its own round fails, without making Work successful',()=>{
 const s=failedPublication(),before=structuredClone(s),rows=managedReviewTodos(s),record=managedWorkRecords(s)[0];
 assert.deepEqual(rows.map(row=>row.id),['saved']);assert.equal(rows[0].settlementIssue.jobId,'published-job');assert.equal(rows[0].settlementIssue.status,'failed');
 assert.equal(record.settlementIssue.objectId,'saved-object');assert.equal(record.status,'paused');assert.deepEqual(s,before);
});
test('saved result failure binding rejects unrelated receipts, targets and revisions',()=>{
 for(const alter of [s=>{s.receipts[0].workId='other';},s=>{s.receipts[0].objectId='other';},s=>{s.receipts[0].revision=1;},s=>{s.jobs[0].target='other';},s=>{s.jobs[0].revision=1;},s=>{s.works[0].result.revision=1;},s=>{s.receipts=[];}]){
  const s=failedPublication();alter(s);assert.deepEqual(managedReviewTodos(s),[]);assert(!managedWorkRecords(s)[0].settlementIssue);
 }
});
test('saved failed report does not expose review during new active input or override ending',()=>{
 const s=failedPublication();s.jobs.push({id:'new-input',target:'w',type:'manual',revision:2,status:'queued'});assert.deepEqual(managedReviewTodos(s),[]);
 s.jobs.pop();s.jobs[0].status='completed';assert.deepEqual(managedReviewTodos(s),[]);
 s.jobs[0].status='interrupted';assert.equal(managedReviewTodos(s)[0].settlementIssue.status,'interrupted');
 s.works[0].status='ended';assert.deepEqual(managedReviewTodos(s),[]);assert.equal(managedWorkRecords(s)[0].status,'ended');
});
