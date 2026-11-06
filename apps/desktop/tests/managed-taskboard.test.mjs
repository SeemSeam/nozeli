import {openTestController} from './project-storage.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
// P0 bounded taskboard: >100 works pagination with host cursors, explicit
// cursor invalidation, rename-safe workId+expectedRevision management with
// stale no-new-work semantics, frozen report association, and scoped
// read-only inspection for backstage/maintenance events. No model runs here.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
const wait=async fn=>{const end=Date.now()+30000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('condition timeout');};
class NoModelSession{constructor(spec,target){Object.assign(this,spec,{target,closed:false});}async start(id){throw Error('taskboard fixture must never start a model session');}async stop(){this.closed=true;}}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-taskboard-'));
 const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),projectHome:async home=>{await fs.mkdir(home,{recursive:true});},sessionFactory:(spec,target)=>new NoModelSession(spec,target)});
 t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});
 return c;
}
async function intakeFor(c,text){
 const accepted=await c.enqueue('orchestrator','intake',text);
 const job=c.store.state.jobs.find(j=>j.id===accepted.jobId);
 c.current.set('orchestrator',job);
 return job;
}
const inspect=(c,arguments_)=>c.onTool('orchestrator',{tool:'nozeli_inspect_work',arguments:arguments_,callId:randomUUID()});
const manage=(c,arguments_)=>c.onTool('orchestrator',{tool:'nozeli_manage',arguments:arguments_,callId:randomUUID()});
const boardPage=async(c,cursor)=>(await inspect(c,{workName:'@state',...(cursor?{cursor}:{})})).board;

test('taskboard pages 120 works with stable IDs, quota and true queue positions',async t=>{
 const c=await fixture(t);
 const submitted=[];
 for(let i=0;i<120;i++)submitted.push(await c.store.submit(`request ${i+1}`,`brief ${i+1}`,{name:'Task '+String(i+1).padStart(3,'0')}));
 const first=submitted[0];
 await c.store.activate(first.id); // project quota limit is 1: one running, 119 queued
 const job=await intakeFor(c,'查看当前任务板');
 const seen=[],pages=[];
 let cursor=null;
 for(;;){
  const board=await boardPage(c,cursor);
  pages.push(board);
  assert.ok(board.rows.length<=20,'page bounded');
  assert.ok(JSON.stringify(board).length<10000,'page bytes bounded');
  for(const row of board.rows)seen.push(row);
  if(!board.nextCursor)break;
  cursor=board.nextCursor;
 }
 assert.equal(pages.length,6);
 assert.equal(seen.length,120);
 assert.deepEqual(new Set(seen.map(r=>r.workId)),new Set(submitted.map(w=>w.id)),'stable host IDs cover every work exactly once');
 assert.deepEqual(seen.map(r=>r.workId),submitted.map(w=>w.id),'ledger order preserved across pages');
 const running=seen.find(r=>r.workId===first.id);
 assert.equal(running.status,'running');assert.equal(running.revision,1);assert.equal('queuePosition' in running,false,'running work has no queue position');
 const queued=seen.filter(r=>r.status==='queued');
 assert.equal(queued.length,119);
 assert.deepEqual(queued.map(r=>r.queuePosition),Array.from({length:119},(_,i)=>i+1),'queue positions follow activation order');
 assert.equal(pages[0].quota.used,1);assert.equal(pages[0].quota.limit,1);
 assert.equal(queued.every(r=>r.blockReason===null||typeof r.blockReason.code==='string'),true,'block reasons stay factual');
 c.current.delete('orchestrator');
});

test('cursor invalidates explicitly on ledger change; renames never break ID paging',async t=>{
 const c=await fixture(t);
 const submitted=[];
 for(let i=0;i<30;i++)submitted.push(await c.store.submit('request '+i,'brief',{name:'N'+i}));
 await intakeFor(c,'读取分页');
 const page1=await boardPage(c,null);
 assert.equal(page1.rows.length,20);assert.ok(page1.nextCursor);
 const page2=await boardPage(c,page1.nextCursor);
 assert.equal(page2.offset,20);assert.equal(page2.rows.length,10);assert.equal(page2.nextCursor,null);assert.equal(page2.resyncRequired,undefined);
 // A revision/status change (activation) changes the fingerprint: the old
 // cursor is explicitly invalid and the host returns a fresh first page.
 await c.store.activate(submitted[5].id);
 const stale=await boardPage(c,page1.nextCursor);
 assert.equal(stale.resyncRequired,true);assert.equal(stale.cursorInvalid,true);assert.equal(stale.offset,0);assert.equal(stale.rows.length,20);assert.ok(stale.reason);
 // Display-name renames are not pagination state: a cursor taken before the
 // rename still pages consistently and shows the current display name.
 await c.store.mutate(()=>{c.store.find(submitted[25].id).name='已改名';});
 const fresh1=await boardPage(c,null);
 const fresh2=await boardPage(c,fresh1.nextCursor);
 assert.equal(fresh2.resyncRequired,undefined);
 assert.ok(fresh2.rows.some(r=>r.workId===submitted[25].id&&r.name==='已改名'));
 assert.ok(!fresh2.rows.some(r=>r.name==='N25'));
 // Malformed/model-constructed cursors are rejected instead of paged.
 for(const cursor of ['not-a-cursor',JSON.stringify({schema:1,filter:'open',fingerprint:'0'.repeat(64),offset:5})]){
  const rejected=await inspect(c,{workName:'@state',cursor});assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'INVALID_CURSOR');assert.equal(rejected.continueTurn,true);assert.equal(rejected.hostControl,undefined);
 }
 c.current.delete('orchestrator');
});

test('omitted, null, empty and blank cursors are equivalent first-page reads; forged tokens stay rejected',async t=>{
 const c=await fixture(t);
 const submitted=[];
 for(let i=0;i<25;i++)submitted.push(await c.store.submit('首页请求 '+i,'brief '+i,{name:'W'+i}));
 await intakeFor(c,'查看任务板');
 const omitted=(await inspect(c,{workName:'@state'})).board;
 assert.equal(omitted.offset,0);assert.equal(omitted.rows.length,20);
 for(const cursor of [null,'','   ','\t\n']){
  const page=(await inspect(c,{workName:'@state',cursor})).board;
  assert.equal(page.offset,0);assert.equal(page.resyncRequired,undefined);
  assert.deepEqual(page.rows.map(r=>r.workId),omitted.rows.map(r=>r.workId),'every empty cursor representation reads the same first page');
 }
 // 真实续页沿宿主 nextCursor 原样翻完整板：不丢项、不重复、保序。
 const seen=[];let cursor=null;
 for(;;){const board=await boardPage(c,cursor);seen.push(...board.rows.map(r=>r.workId));if(!board.nextCursor)break;cursor=board.nextCursor;}
 assert.deepEqual(seen,submitted.map(w=>w.id),'full paging keeps ledger order without loss or duplication');
 // 非空坏/伪造 token 仍显式拒绝为可纠正读取错误，绝不静默重置首页吞错。
 for(const bad of ['not-a-cursor',JSON.stringify({schema:1,filter:'open',fingerprint:'0'.repeat(64),offset:5}),7,{offset:20}]){
  const rejected=await inspect(c,{workName:'@state',cursor:bad});
  assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'INVALID_CURSOR');assert.equal(rejected.continueTurn,true);
 }
 c.current.delete('orchestrator');
});

test('manage continue binds workId+expectedRevision: stale creates nothing, replay is idempotent, rename-safe',async t=>{
 const c=await fixture(t);
 const w=await c.store.submit('original request','brief',{name:'Alpha'});
 const job=await intakeFor(c,'补充原任务');
 const before=structuredClone({works:c.store.state.works.length,jobs:c.store.state.jobs.length,todos:c.store.state.todos.length});
 // Missing identity contract is rejected before any lookup.
 await assert.rejects(manage(c,{action:'continue',text:'name-only'}),error=>error.code==='INVALID_PAYLOAD');
 await assert.rejects(manage(c,{action:'continue',workId:w.id,text:'missing revision'}),error=>error.code==='INVALID_PAYLOAD');
 // Stale expectedRevision: no supplement, no input, no routing receipt, no new Work.
 await assert.rejects(manage(c,{action:'continue',workId:w.id,expectedRevision:7,text:'late revision'}),error=>error.code==='STALE_WORK_REVISION'&&error.currentRevision===0);
 assert.equal(c.store.state.works.length,before.works);
 assert.equal(c.store.find(w.id).inputs,undefined);
 assert.equal(c.store.state.jobs.find(j=>j.id===job.id).routing,undefined);
 assert.equal(c.store.state.jobs.filter(j=>j.target===w.id).length,0);
 // Rename between read and mutation: the stable ID still continues the same Work.
 await c.store.mutate(()=>{c.store.find(w.id).name='Beta';});
 const detail=await inspect(c,{workName:'@work:'+w.id});
 assert.equal(detail.workId,w.id);assert.equal(detail.name,'Beta');assert.equal(detail.baseline.sourceJob,null);assert.equal(detail.frozen.result,null);
 const receipt=await manage(c,{action:'continue',workId:w.id,expectedRevision:0,text:'extra constraint'});
 assert.equal(receipt.action,'continue');assert.equal(receipt.workId,w.id);assert.equal(receipt.queued,true);assert.equal(receipt.workName,'Beta');
 assert.equal(c.store.find(w.id).inputs.length,1);assert.equal(c.store.state.works.length,1);
 // Identical retry replays the original receipt (idempotence).
 const replay=await manage(c,{action:'continue',workId:w.id,expectedRevision:0,text:'extra constraint'});
 assert.equal(replay.at,receipt.at);assert.equal(c.store.find(w.id).inputs.length,1);
 // Changed text on the same intake can never inherit the prior receipt.
 await assert.rejects(manage(c,{action:'continue',workId:w.id,expectedRevision:0,text:'different text'}),error=>error.code==='INTENT_MISMATCH');
 assert.equal(c.store.find(w.id).inputs.length,1);assert.equal(c.store.state.works.length,1);
 c.current.delete('orchestrator');
});

test('frozen report association: board reference, immutable receipt candidate and closure archive linkage',async t=>{
 const c=await fixture(t);
 const w=await c.store.submit('deliver request','brief',{name:'Frozen'});
 await c.store.activate(w.id);
 await c.store.mutate(()=>{c.store.find(w.id).execution={repo:'/repos/origin.git',commonDir:'/repos/origin.git/.git',directory:'/runtime/execution/frozen',branchRef:'refs/heads/nozeli/work-frozen',baseCommit:'base-1',targetRef:'refs/heads/main',targetHead:'head-1',candidate:{commit:'deadbeef123',tree:'tree-1',jobId:'job-c'}};});
 await c.store.publish(w.id,c.store.find(w.id).revision,'result',staticReport('Frozen body'),'frozen-receipt-1');
 await c.store.settle(w.id);
 const job=await intakeFor(c,'核对报告关联');
 const board=await boardPage(c,null);
 const row=board.rows.find(r=>r.workId===w.id);
 assert.deepEqual(row.report,{kind:'result',revision:1,current:true});
 const receipt=c.store.state.receipts.find(r=>r.id==='frozen-receipt-1');
 const detail=await inspect(c,{workName:'@work:'+w.id});
 assert.equal(detail.frozen.result.objectId,receipt.objectId);
 assert.equal(detail.frozen.result.current,true);
 assert.equal(detail.frozen.receipts.result,1);
 assert.equal(detail.result.revision,1);assert.ok(detail.result.readRef);
 assert.equal(detail.execution.owner,null,'absent live owner stays unknown, not fabricated');
 // Immutable per-receipt candidate linkage (independent of w.execution) plus
 // the stored worktree/input baseline fields, absent ones as null.
 await c.store.mutate(()=>{
  c.store.find(w.id).execution.candidate={commit:'cur-1',tree:'cur-tree',jobId:'job-cur'};
 });
 const linked=await inspect(c,{workName:'@work:'+w.id});
 assert.deepEqual(linked.frozen.candidates,[{receiptId:'frozen-receipt-1',revision:1,kind:'result',commit:'deadbeef123',tree:'tree-1',jobId:'job-c'}]);
 assert.deepEqual(linked.baseline.worktree,{repo:'/repos/origin.git',commonDir:'/repos/origin.git/.git',directory:'/runtime/execution/frozen',branchRef:'refs/heads/nozeli/work-frozen',baseCommit:'base-1',inputCommit:null,targetRef:'refs/heads/main',targetHead:'head-1',candidate:{commit:'cur-1',tree:'cur-tree',jobId:'job-cur'}});
 // Ledger-level user disposition (unit fixture has no real worktree, so the
 // controller accept gate with its candidate verification is not exercised
 // here): the closure archive still links back to the frozen report object.
 const revision=c.store.find(w.id).revision;
 await c.store.end(w.id,{by:'user',revision,decision:'discard',binding:{workId:w.id,revision,objectId:c.store.find(w.id).result.objectId,candidateCommit:'cur-1'},requestKey:'frozen-end-key'});
 await wait(()=>c.store.find(w.id).status==='closing');
 const ended=c.store.find(w.id);
 if(!ended.closure.stopped)await c.store.markStopped(w.id,{at:new Date().toISOString(),confirmed:true});
 await c.store.archiveReport(w.id);
 const closed=await inspect(c,{workName:'@work:'+w.id});
 assert.equal(closed.frozen.closure.reportDigest,c.store.find(w.id).closure.report.digest);
 assert.equal(closed.frozen.closure.decision,'discard');
 const plan=await fs.readFile(c.store.plan,'utf8');
 assert.ok(plan.includes(`<!-- report:${w.id} -->`),'plan tree history marker references the archived report');
 c.current.delete('orchestrator');
});

test('backstage and maintenance events get scoped read-only board access without effects',async t=>{
 const c=await fixture(t);
 const w=await c.store.submit('observed work','brief',{name:'Observed'});
 c.current.set('orchestrator',{id:'backstage-1',target:'orchestrator',type:'backstage',status:'running',context:{backstageEventKey:'event-key'}});
 const board=await inspect(c,{workName:'@state'});
 assert.equal(board.scopedReadonly,true);assert.equal(board.readOnly,true);assert.equal(board.board.total,1);
 const detail=await inspect(c,{workName:'@work:'+w.id});
 assert.equal(detail.workId,w.id);assert.equal(detail.scopedReadonly,true);
 await assert.rejects(inspect(c,{workName:'@conversation'}),error=>error.code==='INSPECT_SCOPE_READONLY');
 await assert.rejects(inspect(c,{workName:'@memory:rule'}),error=>error.code==='INSPECT_SCOPE_READONLY');
 await assert.rejects(manage(c,{action:'continue',workId:w.id,expectedRevision:0,text:'x'}),/management requires an intake/);
 await assert.rejects(c.onTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'X',brief:'B'},callId:randomUUID()}),/dispatch requires an intake/);
 assert.equal(c.store.state.works.length,1);assert.equal(c.store.find(w.id).status,'queued');
 c.current.set('orchestrator',{id:'maintenance-1',target:'orchestrator',type:'maintenance',status:'running',context:{bugId:'bug-1'}});
 const maintained=await inspect(c,{workName:'@state'});
 assert.equal(maintained.scopedReadonly,true);assert.equal(maintained.board.rows[0].workId,w.id);
 c.current.delete('orchestrator');
});

test('manage status returns the bounded board, never routes and stays repeatable',async t=>{
 const c=await fixture(t);
 await c.store.submit('status request','brief',{name:'S1'});
 const job=await intakeFor(c,'查看状态');
 for(const callId of ['s1','s2']){
  const observed=await manage(c,{action:'status',text:''});
  assert.equal(observed.action,'status');assert.equal(observed.continueTurn,true);assert.equal(observed.noWorkerTurn,true);
  assert.ok(observed.board);assert.ok(Array.isArray(observed.facts.works));assert.equal(observed.facts.works[0].name,'S1');
  assert.equal(c.store.state.jobs.find(j=>j.id===job.id).routing,undefined);
 }
 assert.equal(c.store.state.works.length,1);
 c.current.delete('orchestrator');
});

test('board labels stay byte-bounded for huge multibyte names and the text projection carries full IDs',async t=>{
 const c=await fixture(t);
 const request='🚀超长任务名称边界测试。'.repeat(2000);
 const w=await c.store.submit(request,'brief'); // no display name: falls back to the request
 await intakeFor(c,'读取任务板');
 const board=await boardPage(c,null);
 const row=board.rows[0];
 assert.equal(row.workId,w.id);
 assert.ok(Buffer.byteLength(row.name,'utf8')<=200,'label is byte-bounded even for 4-byte fallback text');
 assert.ok(row.name.endsWith('…'),'explicit truncation marker');
 assert.ok(JSON.stringify(board).length<10000,'worst-case page JSON stays bounded');
 const detail=await inspect(c,{workName:'@work:'+w.id});
 assert.ok(Buffer.byteLength(detail.name,'utf8')<=200,'detail label bounded');
 const text=c.taskboardText();
 assert.ok(text.includes('@work:'+w.id),'frontdesk projection carries the FULL stable ID');
 assert.ok(Buffer.byteLength(text,'utf8')<2500,'text projection bounded for a single work');
 c.current.delete('orchestrator');
});

test('routingMessage renders board status rows and an explicitly empty board',async t=>{
 const c=await fixture(t);
 assert.equal(c.routingMessage({action:'status',facts:{works:[]}}),'当前没有开放任务。');
 await c.store.submit('status request','brief',{name:'S1'});
 const job=await intakeFor(c,'查看状态');
 const receipt=await manage(c,{action:'status',text:''});
 assert.equal(c.routingMessage(receipt),'S1：排队中');
 assert.equal(c.store.state.jobs.find(j=>j.id===job.id).routing,undefined);
 c.current.delete('orchestrator');
});

test('detail keeps long originals/inputs behind paged readRefs; scoped events consume only their own refs',async t=>{
 const c=await fixture(t);
 const longRequest='原请求正文边界。'.repeat(2000);
 const supplement='补充输入正文🎯'.repeat(600);
 const w=await c.store.submit(longRequest,'brief',{name:'Long'});
 const job=await intakeFor(c,'补充长输入');
 await manage(c,{action:'continue',workId:w.id,expectedRevision:0,text:supplement});
 const detail=await inspect(c,{workName:'@work:'+w.id});
 assert.ok(detail.request.length<=920&&detail.request.includes('[已截断'));
 assert.ok(detail.requestReadRef);
 assert.equal(detail.inputs.total,1);
 const input=detail.inputs.recent[0];
 assert.ok(input.brief.length<=920&&input.brief.includes('[已截断'));
 assert.ok(input.briefReadRef);
 const reassemble=async first=>{let page=await inspect(c,{workName:first}),body=page.text;while(page.nextReadRef){page=await inspect(c,{workName:page.nextReadRef});body+=page.text;}return body;};
 assert.equal(await reassemble(detail.requestReadRef),longRequest,'paged readRef returns the exact immutable original');
 assert.equal(await reassemble(input.briefReadRef),supplement,'paged input ref returns the exact supplement');
 c.current.delete('orchestrator');
 // A scoped backstage event pages refs issued for ITS scoped Work detail,
 // but never reaches intake-only selectors.
 c.current.set('orchestrator',{id:'backstage-2',target:'orchestrator',type:'backstage',status:'running',context:{backstageEventKey:'event-2'}});
 const scoped=await inspect(c,{workName:'@work:'+w.id});
 assert.ok(scoped.requestReadRef);
 assert.equal(await reassemble(scoped.requestReadRef),longRequest);
 await assert.rejects(inspect(c,{workName:'@conversation'}),error=>error.code==='INSPECT_SCOPE_READONLY');
 c.current.delete('orchestrator');
});

test('invalid read-only cursor is repaired in the same intake without a user retry or extra model job',async t=>{
 const c=await fixture(t),job=await intakeFor(c,'执行原用户已明确提交的任务');
 const rejected=await inspect(c,{workName:'@state',cursor:'not-a-cursor'});
 assert.equal(rejected.ok,false);assert.equal(rejected.continueTurn,true);assert.equal(rejected.hostControl,undefined);assert.equal(rejected.error.code,'INVALID_CURSOR');
 assert.equal(c.store.state.works.length,0);assert.equal(c.store.state.jobs.length,1);assert.equal(c.store.state.jobs[0].id,job.id);
 const fault=(await c.maintenance.read()).bugs[0];assert.equal(fault.phase,'tool-protocol');assert.equal(fault.jobId,job.id);assert.notEqual(fault.status,'repaired');
 assert.equal(c.store.state.jobs[0].readProtocolFaults[0].status,'awaiting-correction');
 const fixed=await inspect(c,{workName:'@state'});assert.ok(fixed.board);
 assert.equal((await c.maintenance.read()).bugs.find(b=>b.id===fault.id).status,'repaired');
 assert.equal(c.store.state.jobs[0].readProtocolFaults[0].status,'repaired');
 const routed=await c.onTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'原任务',brief:'保留原要求并开始执行'},callId:randomUUID()});
 assert.equal(c.store.state.works.length,1);assert.equal(routed.workId,c.store.state.works[0].id);assert.equal(c.store.state.jobs.filter(j=>j.type==='intake').length,1);
 assert.equal(c.store.state.jobs.filter(j=>j.type==='maintenance'||j.type==='backstage').length,0);assert.equal(c.store.state.todos.some(todo=>todo.sourceJobId===job.id&&todo.kind==='system'),false);
 c.current.delete('orchestrator');
});

test('dispatch without a corrected read never verifies or repairs the rejected read',async t=>{
 const c=await fixture(t),job=await intakeFor(c,'保留原任务');
 const rejected=await inspect(c,{workName:'@state',cursor:'not-a-cursor'});assert.equal(rejected.error.code,'INVALID_CURSOR');
 const bugId=(await c.maintenance.read()).bugs[0].id;
 const routed=await c.onTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'原目标',brief:'仅派发原目标'},callId:randomUUID()});
 assert.equal(routed.action,'dispatch');assert.equal(c.store.state.works.length,1);assert.equal(c.store.state.works[0].sourceJob,job.id);
 const bug=(await c.maintenance.read()).bugs.find(bug=>bug.id===bugId),fault=c.store.state.jobs.find(saved=>saved.id===job.id).readProtocolFaults[0];
 assert.equal(bug.status,'detected');assert.notEqual(bug.lastOutcome?.verified,true);assert.equal(fault.status,'awaiting-correction');assert.equal(fault.correctionReceipt,undefined);c.current.delete('orchestrator');
});

test('verified read receipt save failure preserves committed dispatch and cold open only finalizes the exact read diagnostics',async t=>{
 const c=await fixture(t),job=await intakeFor(c,'开始落盘');
 await inspect(c,{workName:'@state',cursor:'not-a-cursor'});const bugId=(await c.maintenance.read()).bugs[0].id;
 c.maintenance.finish=async()=>{throw Object.assign(Error('synthetic diagnostic receipt failure'),{code:'EIO'});};
 const fixed=await inspect(c,{workName:'@state'});assert.ok(fixed.board);assert.equal(c.store.state.jobs.find(saved=>saved.id===job.id).readProtocolFaults[0].correctionReceipt.verified,true);
 const routed=await c.onTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'已派工原目标',brief:'保留原目标'},callId:randomUUID()});
 assert.equal(routed.action,'dispatch');assert.equal(c.store.state.works.length,1);assert.equal((await c.maintenance.read()).bugs[0].status,'detected');
 await c.store.mutate(()=>{c.store.state.jobs.find(saved=>saved.id===job.id).status='completed';});c.current.delete('orchestrator');
 const ids=c.store.state.jobs.map(saved=>saved.id),runtimeRoot=c.store.root,contentRoot=c.store.content,storage=c.store.storage,projectId=c.projectId;await c.stop();
 const cold=await openTestController({storage,projectId,runtimeRoot,contentRoot,localOnly:true,sessionFactory:()=>{throw Error('diagnostic finalization must not start a model');}});
 try{
  assert.equal(cold.store.state.works.length,1);assert.equal(cold.store.state.works[0].id,routed.workId);assert.deepEqual(cold.store.state.jobs.map(saved=>saved.id),ids);
  assert.equal((await cold.maintenance.read()).bugs.find(bug=>bug.id===bugId).status,'repaired');assert.equal(cold.store.state.jobs.find(saved=>saved.id===job.id).readProtocolFaults[0].status,'repaired');assert.equal(cold.sessions.size,0);
 }finally{await cold.stop();}
});


test('missing and ambiguous inspect names correct through the board without dispatch',async t=>{
 const c=await fixture(t),job=await intakeFor(c,'查看工作');
 await c.store.submit('one','brief',{name:'duplicate'});await c.store.submit('two','brief',{name:'duplicate'});
 // Normal submission uniquifies names; historical state can still contain collisions.
 await c.store.mutate(()=>{for(const work of c.store.state.works)work.name='duplicate';});
 for(const args of [{},{workName:''},{workName:'duplicate'}]){
  const rejected=await inspect(c,args);assert.equal(rejected.ok,false);assert.equal(rejected.continueTurn,true);assert.equal(rejected.error.code,'INVALID_SELECTOR');assert.equal(rejected.hostControl,undefined);
 }
 const bugs=(await c.maintenance.read()).bugs;assert.equal(bugs.length,3);assert.ok(bugs.every(bug=>bug.status==='detected'&&bug.capability==='same-turn-read-correction'));
 const board=await inspect(c,{workName:'@state'});assert.equal(board.board.rows.length,2);assert.ok((await c.maintenance.read()).bugs.every(bug=>bug.status==='repaired'));assert.equal(c.store.state.jobs.length,1);assert.equal(c.store.state.jobs[0].id,job.id);assert.equal(c.sessions.size,0);c.current.delete('orchestrator');
});
