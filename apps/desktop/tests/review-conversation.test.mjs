import {openTestController} from './project-storage.fixture.mjs';
import {projectReviewConversation} from '../src/domain/review-conversation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 审核讨论对话投影的行为边界：只断言消费方可见的身份/顺序/去重/分页语义。
// 纯helper部分不依赖宿主；controller部分用真实账本/回执核对行级事实字段。

const row=(over={})=>({id:'m-0',speaker:'user',target:'work-a',text:'',jobId:null,source:'user-input',workId:'work-a',requestId:null,revision:1,sequence:1,...over});

test('context folds the original request and handoff verbatim with navigation labels',()=>{
  const request=row({id:'work-request:work-a',source:'work-request',speaker:'user',text:'整理销售数据并按首次订单去重',sequence:null,requestId:null});
  const handoff=row({id:'work-handoff:work-a',source:'work-handoff',speaker:'orchestrator',text:'请以冻结基线为准执行；完成后发布结果报告。',sequence:null,requestId:null});
  const {context,entries}=projectReviewConversation([request,handoff]);
  assert.equal(context.length,2);
  assert.equal(context[0].label,'原始请求');assert.equal(context[0].text,'整理销售数据并按首次订单去重');
  assert.equal(context[1].label,'主控交接');assert.equal(context[1].text,'请以冻结基线为准执行；完成后发布结果报告。');
  assert.equal(entries.length,0);
});

test('real orchestrator handoff stays in original context rather than duplicating a user question',()=>{
  const handoff=row({id:'host-initial-input',speaker:'orchestrator',source:'user-input',jobId:'initial-job',text:'执行已交接的材料任务'});
  const reply=row({id:'native-initial-reply',speaker:'worker',source:'worker-reply',jobId:'initial-job',text:'根据原材料完成第一步'});
  const projected=projectReviewConversation([handoff,reply]);
  assert.deepEqual(projected.context.map(entry=>entry.id),[handoff.id]);
  assert.equal(projected.entries[0].question,undefined);
  assert.deepEqual(projected.entries[0].replyEntries.map(entry=>entry.id),[reply.id]);
});

test('one round per proven identity: same-job multi-part replies keep message ids and identical text is never deduped',()=>{
  const {context,entries}=projectReviewConversation([
    row({id:'q-1',speaker:'user',source:'review-discussion',text:'请核对第二节',requestId:'rk-1',jobId:'job-a',sequence:10}),
    row({id:'seg-1',speaker:'worker',source:'review-discussion',text:'已核对：第二节引用与冻结证据一致。',jobId:'job-a',requestId:'req-9',sequence:11}),
    row({id:'seg-2',speaker:'worker',source:'review-discussion',text:'已核对：第二节引用与冻结证据一致。',jobId:'job-a',requestId:'req-9',sequence:12}),
  ]);
  assert.equal(context.length,0);
  assert.equal(entries.length,1,'same proven job/request identity is ONE round');
  const round=entries[0];
  assert.equal(round.requestId,'rk-1','question identity wins when seen first');
  assert.equal(round.question,'请核对第二节');assert.equal(round.questionId,'q-1');assert.equal(round.questionLabel,'你');
  assert.deepEqual(round.replyEntries.map(reply=>reply.id),['seg-1','seg-2'],'message ids retained in transcript order');
  assert.equal(round.replyEntries[0].text,round.replyEntries[1].text,'identical text with different identities both stay');
});

test('round requestId derivation: proven requestId, else bound jobId, else the question message id',()=>{
  const byJob=projectReviewConversation([
    row({id:'q-a',speaker:'user',text:'第一问',jobId:'job-a',sequence:1}),
    row({id:'r-a',speaker:'worker',text:'答',jobId:'job-a',sequence:2}),
  ]);
  assert.equal(byJob.entries.length,1);assert.equal(byJob.entries[0].requestId,'job-a');
  assert.equal(byJob.entries[0].jobId,'job-a');assert.equal(byJob.entries[0].revision,1);

  const byRequest=projectReviewConversation([row({id:'q-b',speaker:'user',text:'第二问',jobId:'job-b',requestId:'req-1',sequence:1})]);
  assert.equal(byRequest.entries[0].requestId,'req-1');

  const byMessage=projectReviewConversation([row({id:'q-c',speaker:'user',text:'第三问',jobId:null,requestId:null,sequence:1})]);
  assert.equal(byMessage.entries[0].requestId,'q-c');
});

test('publications are inline ordered events, never AI replies and never moved to the bottom',()=>{
  const {entries}=projectReviewConversation([
    row({id:'q-1',speaker:'user',text:'第一问',jobId:'job-a',sequence:1}),
    row({id:'r-1',speaker:'worker',text:'第一答',jobId:'job-a',sequence:2}),
    row({id:'pub-1',speaker:'agent',source:'publication',text:null,jobId:'job-a',objectId:'obj-1',publication:'result',publicationNumber:2,revision:1,sequence:3}),
    row({id:'q-2',speaker:'user',text:'第二问',jobId:'job-b',sequence:4}),
  ]);
  assert.equal(entries.length,3);
  assert.equal(entries[0].requestId,'job-a');
  assert.equal(entries[1].requestId,'event:pub-1');
  assert.equal(entries[1].event.id,'pub-1');assert.equal(entries[1].event.label,'发布结果报告');
  assert.equal(entries[1].event.objectId,'obj-1');assert.equal(entries[1].event.publicationNumber,2);
  assert.equal(entries[1].event.text,null,'publication rows keep their recorded null text verbatim');
  assert.equal('replyEntries' in entries[1],false,'events are not AI reply rounds');
  assert.equal(entries[2].question,'第二问');
});

test('numeric page boundaries: same-job segments split across pages merge by identity; identity-less rows never merge with neighbors',()=>{
  const q1=row({id:'q-1',speaker:'user',text:'请继续核对',requestId:'rk-1',jobId:'job-a',sequence:10});
  const seg1=row({id:'seg-1',speaker:'worker',text:'第一段',jobId:'job-a',requestId:'req-9',sequence:11});
  const pageOne=[q1,seg1];
  const seg2=row({id:'seg-2',speaker:'worker',text:'第二段',jobId:null,requestId:'req-9',sequence:12});
  const loose=row({id:'loose-1',speaker:'worker',text:'无身份回复',jobId:null,requestId:null,sequence:13});
  const q2=row({id:'q-2',speaker:'user',text:'下一问',jobId:'job-b',sequence:14});
  const merged=[...pageOne,seg2,loose,q2];
  const first=projectReviewConversation(pageOne);
  const full=projectReviewConversation(merged);
  assert.equal(first.entries[0].requestId,'rk-1');assert.equal(first.entries[0].replyEntries.length,1);
  assert.equal(full.entries.length,3,'job-a round + identity-less reply round + job-b round');
  const round=full.entries[0];
  assert.equal(round.requestId,'rk-1','pinned identity is stable across page merges');
  assert.deepEqual(round.replyEntries.map(reply=>reply.id),['seg-1','seg-2']);
  const orphan=full.entries.find(entry=>entry.requestId==='loose-1');
  assert.ok(orphan,'identity-less reply stays its own round');
  assert.deepEqual(orphan.replyEntries.map(reply=>reply.id),['loose-1']);
  assert.equal(orphan.question,undefined,'never guesses a question by adjacency');
  assert.equal(full.entries.at(-1).questionId,q2.id);
});

test('reused job/request aliases never merge different Work revisions or replace their bubbles',()=>{
  const {entries}=projectReviewConversation([
    row({id:'revision-one',speaker:'worker',jobId:'same-job',requestId:'same-request',revision:1,text:'旧回合'}),
    row({id:'revision-two',speaker:'worker',jobId:'same-job',requestId:'same-request',revision:2,text:'新回合'}),
  ]);
  assert.deepEqual(entries.map(entry=>entry.replyEntries.map(message=>message.id)),[['revision-one'],['revision-two']]);
  assert.notEqual(entries[0].key,entries[1].key);
});

test('process/tool rows fold into their round; identity-less process rows stand alone and never become AI replies',()=>{
  const {entries}=projectReviewConversation([
    row({id:'q-1',speaker:'user',text:'请执行',jobId:'job-a',sequence:1}),
    row({id:'tool-1',speaker:'tool',source:'native-tool',text:null,jobId:'job-a',availability:'read-required',sequence:2}),
    row({id:'r-1',speaker:'worker',text:'已完成',jobId:'job-a',sequence:3}),
    row({id:'sys-1',speaker:'system',source:'system',text:'独立系统记录',jobId:null,requestId:null,sequence:4}),
  ]);
  assert.equal(entries.length,2);
  const round=entries[0];
  assert.deepEqual(round.processEntries.map(item=>item.id),['tool-1']);
  assert.equal(round.processEntries[0].availability,'read-required');
  assert.deepEqual(round.replyEntries.map(reply=>reply.id),['r-1'],'process rows never enter replyEntries');
  const standalone=entries[1];
  assert.equal(standalone.requestId,'sys-1');
  assert.deepEqual(standalone.processEntries.map(item=>item.id),['sys-1']);
  assert.equal(standalone.replyEntries.length,0);
});

test('defensive boundaries: exact-id duplicates across merged pages collapse; malformed input yields an empty projection',()=>{
  const q=row({id:'q-1',speaker:'user',text:'问题',jobId:'job-a',sequence:1});
  const {entries}=projectReviewConversation([q,{...q,seq:99}]);
  assert.equal(entries.length,1);assert.equal(entries[0].questionId,'q-1');
  assert.deepEqual(projectReviewConversation([]),{context:[],entries:[]});
  assert.deepEqual(projectReviewConversation(null),{context:[],entries:[]});
  const hostile=projectReviewConversation([null,{},'x',{id:'',text:'无id'},{id:'ok-1',speaker:'user',text:'有效行',jobId:'job-a',sequence:1}]);
  assert.equal(hostile.entries.length,1);assert.equal(hostile.entries[0].questionId,'ok-1');
});

const page=body=>'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture report</title></head><body><main><h1>Fixture report</h1><p>'+body+'</p></main></body></html>';
const BASELINE_MD='# 阅读\n\n原始基线正文。\n';
const CANDIDATE_MD='# 阅读\n\nWorker 候选正文 v1。\n';
const BASELINE_NOTES='原始备注。\n';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-review-conversation-')),content=path.join(root,'project');
  await fs.mkdir(content);
  await fs.writeFile(path.join(content,'reading.md'),BASELINE_MD);
  await fs.writeFile(path.join(content,'notes.md'),BASELINE_NOTES);
  const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:content});
  c.kick=()=>{};
  const submitted=await c.store.submit('整理阅读笔记并产出markdown','worker brief for conversation');
  await c.store.activate(submitted.id);await c.execution.prepare(submitted.id);
  const dir=c.execution.directory(submitted.id);
  await fs.writeFile(path.join(dir,'reading.md'),CANDIDATE_MD);
  await c.execution.publish(c.store.find(submitted.id),{id:'report-job'},()=>true,async(manifest,candidate)=>{
    const binding={projectId:c.store.projectId,workId:submitted.id,revision:1,jobId:'report-job',receiptId:'report-1',repo:manifest.repo,commonDir:manifest.commonDir,inputCommit:manifest.inputCommit,candidateCommit:candidate.commit};
    const receipt=await c.store.publish(submitted.id,1,'result',page('Candidate report-1'),'report-1',{jobId:'report-job',files:[{relPath:'reading.md'},{relPath:'notes.md'}],retainCandidate:async()=>{const retained=await c.changes.capture(binding);return {...retained,rollback:()=>c.changes.discardUnpublished(retained.changeSetId,binding)};}});
    return {changeSetId:receipt.changeSetId};
  },{receiptId:'report-1'});
  await c.store.settle(submitted.id);
  await c.store.mutate(()=>{c.store.state.jobs.push({id:'report-job',target:submitted.id,revision:1,type:'initial',status:'completed'});});
  t.after(async()=>{if(!c.store.closed)await c.stop().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
  const w=c.store.find(submitted.id);
  const receipt=c.store.state.receipts.find(r=>r.kind==='result'&&r.workId===w.id);
  return {c,w,receipt,objectId:receipt.objectId};
}

test('discussion read rows carry actual work/job/request/revision/sequence facts and never the current report revision',async t=>{
  const {c,w,objectId}=await fixture(t);
  const reviewVersion=(await c.reviewRead({objectId})).reviewVersion;
  const sent=await c.reviewDiscussionSend({objectId,reviewVersion,requestKey:'conv-fields-01',text:'请核对第二节'});
  const userMessage=c.store.state.messages.find(m=>m.jobId===sent.jobId&&m.speaker==='user');
  await c.store.mutate(()=>{
    c.store.state.sessionIndex??={version:1,sequence:0,entries:[],messageSequences:{},deltas:[]};
    // verified原生输入绑定=canonical echo抑制证据：initial回合的真实请求身份。
    c.store.state.sessionIndex.entries.push({id:'native-in-0',sessionId:'thread-1',entryId:'e-in-0',target:w.id,workId:w.id,revision:1,jobId:'report-job',requestId:'native-initial-9',speaker:'user',ownership:'verified',recordKind:'conversation',sequence:4,at:new Date().toISOString()});
    c.store.state.sessionIndex.portableMessages??=[];
  });
  let dto=await c.reviewDiscussionRead({objectId});
  for(const entry of dto.entries)assert.equal(entry.workId,w.id,'every row carries the actual Work identity');
  const mine=dto.entries.find(e=>e.id===userMessage.id);
  assert.equal(mine.requestId,'conv-fields-01','discussion rows keep their durable requestKey identity');
  assert.equal(mine.jobId,sent.jobId);assert.equal(mine.revision,1);assert.ok(Number.isInteger(mine.sequence));
  const handoff=dto.entries.find(e=>e.id==='work-request:'+w.id);
  assert.equal(handoff.revision,null);assert.equal(handoff.sequence,null);assert.equal(handoff.requestId,null);
  const publication=dto.entries.find(e=>e.source==='publication');
  assert.equal(publication.revision,1);assert.equal(publication.publicationNumber,1,'publication ordinal comes from the real receipt');
  assert.equal(publication.text,null);assert.equal(publication.requestId,null);
  // 旧记录绝不回填当前Work修订：模拟已发布更新的修订后再读。
  await c.store.mutate(()=>{c.store.find(w.id).revision=2;});
  dto=await c.reviewDiscussionRead({objectId});
  const mineAfter=dto.entries.find(e=>e.id===userMessage.id);
  const publicationAfter=dto.entries.find(e=>e.source==='publication');
  assert.equal(mineAfter.revision,1,'old rows keep their own recorded revision');
  assert.equal(publicationAfter.revision,1);
  assert.equal(publicationAfter.publicationNumber,1);
  assert.equal(dto.entries.some(e=>e.revision===2),false,'current Work revision never backfills history');
  // 逐字保留：正文与账本原文一致，不被摘要替换。
  assert.equal(mineAfter.text,'请核对第二节');
});

test('native segments and tool records project with proven identities: one AI round, process folded, requestKey precedence over native binding',async t=>{
  const {c,w,objectId}=await fixture(t);
  const reviewVersion=(await c.reviewRead({objectId})).reviewVersion;
  const sent=await c.reviewDiscussionSend({objectId,reviewVersion,requestKey:'conv-native-01',text:'请逐段核对'});
  const job=c.store.state.jobs.find(j=>j.id===sent.jobId);
  const at=new Date().toISOString();
  await c.store.mutate(()=>{
    c.store.state.sessionIndex??={version:1,sequence:0,entries:[],messageSequences:{},deltas:[]};
    const entries=c.store.state.sessionIndex.entries,portable=c.store.state.sessionIndex.portableMessages??=[];
    // 同一原生job的两段真实assistant文本（write前/publish前各一段）。
    for(const [id,seq,digest,text] of [['native-seg-1',8,'d-1','第一段：已按冻结基线写入。'],['native-seg-2',9,'d-2','第二段：发布前复核一致。']]){
      entries.push({id,sessionId:'thread-1',entryId:'e-'+id,target:w.id,workId:w.id,revision:1,jobId:job.id,requestId:'native-req-42',speaker:'agent',ownership:'verified',recordKind:'conversation',sequence:seq,at});
      portable.push({id,target:w.id,speaker:'agent',text,jobId:job.id,revision:1,at,status:'completed',nativeEntryDigest:digest});
    }
    // 真实工具记录：折进回合process，正文按页有界装载（此处无归档对象→保留
    // read-required原文入口，不伪造正文）。
    entries.push({id:'native-tool-1',sessionId:'thread-1',entryId:'e-tool-1',target:w.id,workId:w.id,revision:1,jobId:job.id,requestId:'native-req-42',speaker:'tool',ownership:'verified',recordKind:'conversation',sequence:10,at});
    // 其他Work的原生记录不得进入本Work讨论。
    entries.push({id:'native-other-work',sessionId:'thread-2',entryId:'e-x',target:'other-work',workId:'other-work',revision:1,jobId:null,speaker:'agent',recordKind:'conversation',sequence:11,at});
    portable.push({id:'native-other-work',target:'other-work',speaker:'agent',text:'别的工作',jobId:null,status:'completed'});
    // 宿主代发initial交接（user行绑定initial job）＋其verified原生输入身份。
    c.store.state.messages.push({id:'initial-input',target:w.id,speaker:'user',text:'初始交接正文（宿主代发）',jobId:'report-job'});
    entries.push({id:'native-in-1',sessionId:'thread-1',entryId:'e-in-1',target:w.id,workId:w.id,revision:1,jobId:'report-job',requestId:'native-initial-9',speaker:'user',ownership:'verified',recordKind:'conversation',sequence:5,at});
  });
  const dto=await c.reviewDiscussionRead({objectId});
  const seg1=dto.entries.find(e=>e.id==='native-seg-1'),seg2=dto.entries.find(e=>e.id==='native-seg-2');
  assert.ok(seg1&&seg2);
  assert.equal(seg1.speaker,'worker');assert.equal(seg1.requestId,'native-req-42','portable rows carry the canonical record identity');
  assert.equal(seg1.revision,1);assert.equal(seg1.sequence,8);assert.equal(seg2.sequence,9);
  assert.equal(dto.entries.some(e=>e.id==='native-other-work'),false,'no other-Work leakage');
  const tool=dto.entries.find(e=>e.id==='native-tool-1');
  assert.ok(tool,'real tool records are kept, not dropped');
  assert.equal(tool.speaker,'tool');assert.equal(tool.source,'native-tool');assert.equal(tool.text,null);
  assert.equal(tool.availability,'read-required');
  const handoff=dto.entries.find(e=>e.id==='initial-input');
  assert.equal(handoff.speaker,'orchestrator');
  assert.equal(handoff.requestId,'native-initial-9','verified native binding gives ledger rows their proven request identity');
  const mine=dto.entries.find(e=>e.source==='review-discussion'&&e.speaker==='user');
  assert.equal(mine.requestId,'conv-native-01','row-level requestKey wins over the native binding for its own round');
  // 共享transcript投影：一个AI回合（两段保留原id）＋process折叠＋发布事件内联。
  const {entries}=projectReviewConversation(dto.entries);
  const round=entries.find(entry=>entry.requestId==='conv-native-01');
  assert.ok(round,'one round for the whole discussion job');
  assert.equal(entries.filter(entry=>entry.requestId==='conv-native-01').length,1);
  assert.deepEqual(round.replyEntries.map(reply=>reply.id),['native-seg-1','native-seg-2']);
  assert.deepEqual(round.replyEntries.map(reply=>reply.text),['第一段：已按冻结基线写入。','第二段：发布前复核一致。']);
  assert.deepEqual(round.processEntries.map(item=>item.id),['native-tool-1']);
  const event=entries.find(entry=>entry.requestId.startsWith('event:'));
  assert.ok(event,'the real publication surfaces as an inline event');
  assert.equal(event.event.publicationNumber,1);assert.equal(event.event.objectId,objectId);
});
