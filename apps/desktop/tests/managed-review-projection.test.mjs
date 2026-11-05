import test from 'node:test';
import assert from 'node:assert/strict';
import {managedReviewTodos,managedInboxTodos,managedWorkRecords,publicationOrdinal,publicationVersionLabel,publicationIsCurrent} from '../src/domain/managed-work-records.mjs';

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

test('ordinary backstage records remain durable without user inbox entries',()=>{
 const s=state();s.works.push(work());
 s.todos.push(todo('report'),todo('queue',{kind:'queue'}),todo('git',{kind:'git',text:'hook failed'}),todo('recovery',{kind:'recovery',text:'核对文件'}),todo('closure',{kind:'closure'}),todo('resolved',{kind:'system',status:'resolved'}),todo('system',{kind:'system',workId:undefined}));
 const ids=()=>managedReviewTodos(s).map(t=>t.id);
 assert.deepEqual(ids(),['report']);
 s.works[0].status='running';s.works[0].revision=3;assert.deepEqual(ids(),[]);
 s.works[0].status='ended';assert.deepEqual(ids(),[]);
 assert.equal(s.todos.length,7);
});

test('accepted supplemental input suppresses report review until a current delivery',()=>{
 const s=state();s.works.push(work());s.todos.push(todo('report'));
 s.jobs.push({id:'input',type:'intake',context:{boundWorkId:'w'},status:'queued'});assert.deepEqual(managedReviewTodos(s),[]);
 s.jobs[0].status='completed';assert.equal(managedReviewTodos(s)[0].id,'report');
 s.jobs.push({id:'manual',target:'w',type:'manual',status:'running'});assert.deepEqual(managedReviewTodos(s),[]);
});

test('problems and routing retain original facts but are not reader questions',()=>{
 const s=state();s.works.push(work('w',{status:'paused',problem:{objectId:'problem-object',revision:2}}));
 s.todos.push(todo('old-problem',{kind:'problem',revision:1}),todo('problem',{kind:'problem',text:'请选择数据源'}),{id:'routing',kind:'routing',target:'frontdesk',sourceJobId:'intake',status:'open',text:'目标属于哪个项目？'});
 const before=structuredClone(s);assert.deepEqual(managedReviewTodos(s),[]);assert.deepEqual(s,before);
 s.jobs.push({id:'answer',type:'intake',status:'queued',context:{routingQuestionId:'routing'}});assert.deepEqual(managedReviewTodos(s),[]);
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

test('all user inbox views exclude internal records and keep reopened ended results as readable history',()=>{
 const s=state();s.works.push(work('ended',{status:'ended',outcome:'discard',revision:2,result:{objectId:'report-object',revision:2}}));
 s.todos.push(todo('report',{workId:'ended',status:'open',reopenedAt:'2026-11-02T12:00:00Z'}));
 for(const kind of ['system','recovery','queue','routing','attention'])for(const status of ['open','resolved','cancelled','closed'])s.todos.push({id:kind+status,kind,status,title:'Internal record',userActionable:false});
 s.receipts.push({objectId:'report-object',report:{title:'Original report',excerpt:'Preserved content'}});
 const before=structuredClone(s),rows=managedInboxTodos(s);
 assert.deepEqual(rows.map(t=>t.id),['report']);assert.equal(rows[0].pending,false);assert.equal(rows[0].historical,true);
 assert.equal(rows[0].objectId,'report-object');assert.equal(rows[0].revision,2);assert.equal(rows[0].hasReport,true);
 assert.match(rows[0].statusLabel,/已丢弃/);assert.match(rows[0].statusLabel,/历史提醒已重开/);assert.equal(rows[0].excerpt,'Preserved content');assert.deepEqual(s,before);
});

test('current reports, old versions and closed reminders retain distinct obligations and version identities',()=>{
 const s=state();s.works.push(work('w',{result:{objectId:'current-object',revision:2}}));
 s.todos.push(todo('old',{revision:1,status:'iterating'}),todo('current'),todo('closed',{revision:0,status:'closed'}));
 const rows=managedInboxTodos(s),pending=rows.filter(t=>t.pending),history=rows.filter(t=>t.historical);
 assert.deepEqual(pending.map(t=>t.id),['current']);assert.deepEqual(history.map(t=>t.id),['old','closed']);
 assert.deepEqual(history.map(t=>t.versionLabel),['第 1 版','第 0 版']);assert.match(history[0].statusLabel,/续改/);assert.match(history[1].statusLabel,/关闭/);
 assert.equal(history[0].objectId,'old-object');assert.equal(rows[1].objectId,'current-object');
});

test('queued supplement temporarily suppresses current review without turning it into removable history',()=>{
 const s=state();s.works.push(work('w',{result:{objectId:'current-object',revision:2}}));s.todos.push(todo('current'));s.jobs.push({id:'supplement',target:'orchestrator',status:'queued',context:{boundWorkId:'w'}});
 const row=managedInboxTodos(s)[0];assert.equal(row.pending,false);assert.equal(row.historical,false);assert.match(row.statusLabel,/处理中/);
 s.jobs[0].status='failed';const restored=managedInboxTodos(s)[0];assert.equal(restored.pending,true);assert.equal(restored.historical,false);
});

test('accepting the latest publication never labels an iterated older report as accepted',()=>{
 const s=state();s.works.push(work('w',{status:'ended',outcome:'accept',result:{objectId:'new-object',revision:2}}));s.todos.push(todo('old',{revision:1,status:'iterating'}),todo('new',{status:'cancelled'}));
 const rows=managedInboxTodos(s);assert.match(rows[0].statusLabel,/续改/);assert.doesNotMatch(rows[0].statusLabel,/已接受/);assert.match(rows[1].statusLabel,/已接受/);
});

test('same-revision republication numbers current and old entries by exact object on every surface',()=>{
 const s=state();
 s.works.push(work('w',{revision:1,result:{objectId:'v2-object',revision:1}}));
 s.receipts.push(
  {id:'r1',workId:'w',kind:'result',objectId:'v1-object',revision:1,at:'2026-11-05T09:00:00.000Z',report:{excerpt:'第一版结论'},snapshot:{files:[{relPath:'reading.md',digest:'digest-frozen'}]}},
  {id:'p1',workId:'w',kind:'problem',objectId:'p1-object',revision:1,at:'2026-11-05T09:02:00.000Z',report:{excerpt:'中途问题'}},
  {id:'r2',workId:'w',kind:'result',objectId:'v2-object',revision:1,at:'2026-11-05T09:05:00.000Z',report:{excerpt:'第二版结论'},snapshot:{files:[{relPath:'reading.md',digest:'digest-frozen'}]}});
 s.todos.push(todo('v1',{objectId:'v1-object',revision:1,status:'superseded'}),todo('v2',{objectId:'v2-object',revision:1}));
 const before=structuredClone(s);
 // 编号按同Work同kind的发布账本与确切objectId映射：问题与结果各自计数。
 assert.equal(publicationOrdinal(s,'w','v1-object','result'),1);
 // 当前/历史按确切objectId判定：同修订的旧对象是历史，指针不明时不是当前。
 assert.equal(publicationIsCurrent(s,'w','v2-object','result'),true);
 assert.equal(publicationIsCurrent(s,'w','v1-object','result'),false);
 assert.equal(publicationIsCurrent(s,'w','p1-object','problem'),false);
 assert.equal(publicationIsCurrent(s,'w','unknown-object','result'),false);
 assert.equal(publicationOrdinal(s,'w','v2-object','result'),2);
 assert.equal(publicationOrdinal(s,'w','p1-object','problem'),1);
 assert.equal(publicationOrdinal(s,'w','p1-object','result'),null);
 assert.equal(publicationOrdinal(s,'w','unknown-object','result'),null);
 // 账本缺项=历史不完整：不发明序号，保留已记录的修订事实。
 assert.equal(publicationVersionLabel(s,todo('orphan',{objectId:'orphan-object',revision:3,status:'closed'})),'第 3 版');
 assert.equal(publicationVersionLabel(s,{id:'x',workId:'w',kind:'routing',revision:3}),'第 3 版');
 const review=managedReviewTodos(s);
 assert.deepEqual(review.map(t=>t.id),['v2']);
 assert.match(review[0].title,/第 2 版/);assert.equal(review[0].publicationVersion,2);assert.equal(review[0].publicationLabel,'第 2 版');
 const inbox=managedInboxTodos(s),current=inbox.find(t=>t.id==='v2'),old=inbox.find(t=>t.id==='v1');
 assert.equal(current.versionLabel,'第 2 版');assert.equal(current.publicationVersion,2);assert.equal(current.humanEdited,false);assert.equal(current.editLabel,'');
 assert.equal(old.versionLabel,'第 1 版');assert.equal(old.statusLabel,'已被新版替代');
 assert.deepEqual(s,before);
 // 人工改稿只标记绑定同一objectId的当前入口；与冻结候选一致的内容不算修改。
 s.works[0].review={drafts:{'reading.md':{revision:1,textDigest:'digest-human',savedAt:'2026-11-05T10:00:00.000Z',objectId:'v2-object'}}};
 const edited=managedInboxTodos(s);
 assert.equal(edited.find(t=>t.id==='v2').editLabel,'已保存人工改稿');
 assert.equal(edited.find(t=>t.id==='v1').editLabel,'');
 s.works[0].review.drafts['reading.md'].textDigest='digest-frozen';
 assert.equal(managedInboxTodos(s).find(t=>t.id==='v2').editLabel,'');
});
