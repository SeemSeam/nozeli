import {openTestController} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const page=body=>'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture report</title></head><body><main><h1>Fixture report</h1><p>'+body+'</p></main></body></html>';
const BASELINE_MD='# 阅读\n\n原始基线正文。\n';
const CANDIDATE_MD='# 阅读\n\nWorker 候选正文 v1。\n';
const BASELINE_NOTES='原始备注。\n';

// 真实Controller + 真实执行worktree + 冻结候选 + 已发布结果报告（与
// managed-review-candidate 同构）；kick 打桩，测试只断言durable状态机。
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-discussion-')),content=path.join(root,'project');
  await fs.mkdir(content);
  await fs.writeFile(path.join(content,'reading.md'),BASELINE_MD);
  await fs.writeFile(path.join(content,'notes.md'),BASELINE_NOTES);
  const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:content});
  c.kick=()=>{};
  const submitted=await c.store.submit('整理阅读笔记并产出markdown','worker brief for discussion');
  await c.store.activate(submitted.id);await c.execution.prepare(submitted.id);
  const dir=c.execution.directory(submitted.id);
  await fs.writeFile(path.join(dir,'reading.md'),CANDIDATE_MD);
  const publishResult=(receiptId,jobId,retainCandidate)=>c.store.publish(submitted.id,1,'result',page('Candidate '+receiptId),receiptId,{jobId,files:[{relPath:'reading.md'},{relPath:'notes.md'}],retainCandidate});
  await c.execution.publish(c.store.find(submitted.id),{id:'report-job'},()=>true,async(manifest,candidate)=>{
    const binding={projectId:c.store.projectId,workId:submitted.id,revision:1,jobId:'report-job',receiptId:'report-1',repo:manifest.repo,commonDir:manifest.commonDir,inputCommit:manifest.inputCommit,candidateCommit:candidate.commit};
    const receipt=await publishResult('report-1','report-job',async()=>{const retained=await c.changes.capture(binding);return {...retained,rollback:()=>c.changes.discardUnpublished(retained.changeSetId,binding)};});
    return {changeSetId:receipt.changeSetId};
  },{receiptId:'report-1'});
  await c.store.settle(submitted.id);
  await c.store.mutate(()=>{c.store.state.jobs.push({id:'report-job',target:submitted.id,revision:1,type:'initial',status:'completed'});});
  t.after(async()=>{if(!c.store.closed)await c.stop().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
  const w=c.store.find(submitted.id);
  const receipt=c.store.state.receipts.find(r=>r.kind==='result'&&r.workId===w.id);
  return {c,w,content,dir,receipt,objectId:receipt.objectId,worksBefore:c.store.state.works.length};
}
async function versionOf(c,objectId){return (await c.reviewRead({objectId})).reviewVersion;}

test('discussion read exposes real host records with bounded ascending pagination and no provider startup',async t=>{
  const {c,w,objectId}=await fixture(t);
  const dto=await c.reviewDiscussionRead({objectId});
  assert.equal(dto.workId,w.id);assert.equal(dto.objectId,objectId);assert.equal(dto.latestObjectId,objectId);
  assert.equal(dto.canSend,true);assert.deepEqual(dto.reasons,[]);assert.equal(dto.active,false);assert.equal(dto.queued,0);
  assert.equal(dto.pageStart,0);assert.equal(dto.latestCursor,null);assert.ok(dto.total>=3);
  assert.equal(dto.entries[0].source,'work-request');assert.equal(dto.entries[0].text,'整理阅读笔记并产出markdown');
  assert.equal(dto.entries[1].source,'work-handoff');assert.equal(dto.entries[1].speaker,'orchestrator');assert.equal(dto.entries[1].text,'worker brief for discussion');
  const publication=dto.entries.find(e=>e.source==='publication');
  assert.ok(publication);assert.equal(publication.objectId,objectId);assert.equal(publication.publication,'result');assert.equal(publication.text,null);
  for(const [index,entry] of dto.entries.entries())assert.equal(entry.seq,index);
  // 有界分页：limit切片 + 稳定数值游标 + latestCursor 指向最后一页。
  const first=await c.reviewDiscussionRead({objectId,limit:2});
  assert.equal(first.entries[0].seq,0);
  assert.equal(typeof first.nextCursor,'string');assert.ok(first.latestCursor&&Number(first.latestCursor)>0);
  const second=await c.reviewDiscussionRead({objectId,limit:2,cursor:first.nextCursor});
  assert.equal(second.pageStart,2);assert.equal(second.entries[0].seq,2);
  const latest=await c.reviewDiscussionRead({objectId,limit:2,cursor:first.latestCursor});
  assert.equal(latest.pageStart,Number(first.latestCursor));assert.equal(latest.entries.at(-1).seq,dto.total-1);
  // 读取绝不初始化provider会话。
  assert.equal(c.sessions.size,0);
});

test('discussion read projects real native worker replies with identity-only dedup and host-role classification',async t=>{
  const {c,w,objectId}=await fixture(t);
  const reviewVersion=await versionOf(c,objectId);
  const sent=await c.reviewDiscussionSend({objectId,reviewVersion,requestKey:'discuss-native-01',text:'请核对第二节'});
  const job=c.store.state.jobs.find(j=>j.id===sent.jobId);
  // 原生timeline已接受可见回复：portableMessages=真实Pi记录投影（精确原文/
  // 原ID/原摘要；工具与元数据行已在timeline侧过滤，不进此通道）。
  await c.store.mutate(()=>{
    c.store.state.sessionIndex??={version:1,sequence:0,entries:[],messageSequences:{},deltas:[]};
    c.store.state.sessionIndex.entries.push({id:'native-abc',sessionId:'thread-1',entryId:'e-1',target:w.id,workId:w.id,revision:1,jobId:job.id,speaker:'agent',sequence:7,recordKind:'conversation',source:'native',at:new Date().toISOString()});
    c.store.state.sessionIndex.portableMessages??=[];
    c.store.state.sessionIndex.portableMessages.push({id:'native-abc',target:w.id,speaker:'agent',text:'已核对：第二节引用与冻结证据一致。',jobId:job.id,revision:1,at:new Date().toISOString(),status:'completed',nativeEntryDigest:'feedbeef'});
    // 同一原生身份的重录（不同行id、相同nativeEntryDigest）=同一记录，折叠。
    c.store.state.sessionIndex.portableMessages.push({id:'native-abc-replay',target:w.id,speaker:'agent',text:'已核对：第二节引用与冻结证据一致。',jobId:job.id,revision:1,status:'completed',nativeEntryDigest:'feedbeef'});
    // 相同正文的不同原生身份=两条真实回复，绝不按内容折叠。
    c.store.state.sessionIndex.portableMessages.push({id:'native-repeat-text',target:w.id,speaker:'agent',text:'已核对：第二节引用与冻结证据一致。',jobId:job.id,revision:1,status:'completed',nativeEntryDigest:'cafebabe'});
    c.store.state.sessionIndex.portableMessages.push({id:'native-other',target:'other-work',speaker:'agent',text:'别的工作的回复',jobId:null,status:'completed'});
    // 宿主代发的初始交接（user行绑定initial job）按messageRole显示为主控。
    c.store.state.messages.push({id:'initial-input',target:w.id,speaker:'user',text:'初始交接正文（宿主代发）',jobId:'report-job'});
  });
  const dto=await c.reviewDiscussionRead({objectId});
  const reply=dto.entries.find(e=>e.id==='native-abc');
  assert.ok(reply,'native worker reply must be projected from real records');
  assert.equal(reply.speaker,'worker');assert.equal(reply.text,'已核对：第二节引用与冻结证据一致。');
  assert.equal(reply.source,'review-discussion');assert.equal(reply.status,'completed');
  assert.equal(reply.nativeEntryDigest,'feedbeef');assert.equal(reply.jobId,job.id);
  assert.equal(reply.sessionId,'thread-1','read markers use the exact native session, not current Work identity');
  assert.equal(dto.entries.find(e=>e.id==='native-repeat-text').sessionId,undefined,'missing native ownership must not fabricate a read identity');
  assert.equal(dto.entries.some(e=>e.id==='native-abc-replay'),false,'same native identity (digest) collapses');
  const repeat=dto.entries.find(e=>e.id==='native-repeat-text');
  assert.ok(repeat,'same text with a different native identity stays a real separate reply');
  assert.equal(repeat.speaker,'worker');assert.equal(repeat.nativeEntryDigest,'cafebabe');
  assert.equal(dto.entries.some(e=>e.id==='native-other'),false);
  const handoff=dto.entries.find(e=>e.id==='initial-input');
  assert.equal(handoff.speaker,'orchestrator','host-authored initial handoff shows as 主控 per messageRole');
  assert.equal(handoff.source,'user-input');
  const mine=dto.entries.findIndex(e=>e.source==='review-discussion'&&e.speaker==='user');
  assert.ok(mine>=0&&dto.entries.findIndex(e=>e.id==='native-abc')>mine,'native reply follows the user message in timeline order');
  // 流式回复不投影：本读取只反映durable已接受事实（canonical替换身份就绪前）。
  c.timeline.streams.set('stream-1',{id:'stream-1',entryId:'e-2',sessionId:'thread-1',epoch:1,requestId:'r-1',jobId:job.id,target:w.id,entryType:'message',recordKind:'conversation',revision:1,workId:w.id,speaker:'agent',text:'正在核对第三节……',source:'native',streaming:true,sequence:Number.MAX_SAFE_INTEGER});
  try{
    const durableOnly=await c.reviewDiscussionRead({objectId});
    assert.equal(durableOnly.entries.some(e=>e.id==='stream-1'),false);
  }finally{c.timeline.streams.delete('stream-1');}
});

test('pure discussion send keeps one Work, one revision and never forces a new report for unchanged answers',async t=>{
  const {c,w,objectId,worksBefore,receipt}=await fixture(t);
  const reviewVersion=await versionOf(c,objectId);
  const sent=await c.reviewDiscussionSend({objectId,reviewVersion,requestKey:'discuss-pure-001',text:'请解释第二节的选择依据'});
  assert.equal(sent.accepted,true);assert.equal(sent.duplicate,undefined);
  assert.equal(c.store.state.works.length,worksBefore);assert.equal(w.revision,1);assert.equal(w.status,'running');
  const job=c.store.state.jobs.find(j=>j.id===sent.jobId);
  assert.equal(job.target,w.id);assert.equal(job.type,'manual');assert.equal(job.revision,1);assert.equal(job.explicitInput,true);
  assert.equal(job.context.userInput.text,'请解释第二节的选择依据');
  assert.equal(job.context.reviewDiscussion.requestKey,'discuss-pure-001');
  const userMessage=c.store.state.messages.find(m=>m.jobId===job.id&&m.speaker==='user');
  assert.equal(userMessage.text,'请解释第二节的选择依据');assert.equal(userMessage.reviewDiscussion,'discuss-pure-001');
  // 原发布未被stale、未产生新回执；runJob 结算面：无强制problem。
  const receiptsBefore=c.store.state.receipts.length;
  await c.ensureWorkerDelivery({id:job.id,target:w.id,revision:1});
  assert.equal(c.store.state.receipts.length,receiptsBefore);assert.equal(receipt.stale,undefined);
  await c.store.settle(w.id);
  assert.equal(w.status,'review');
  // 条目实时推导：讨论用户消息带queued/运行状态；worker回复按jobId归入讨论。
  const dto=await c.reviewDiscussionRead({objectId});
  const mine=dto.entries.find(e=>e.id===userMessage.id);
  assert.equal(mine.source,'review-discussion');assert.equal(mine.status,'queued');
  await c.store.mutate(()=>{
    const saved=c.store.state.jobs.find(j=>j.id===job.id);saved.status='completed';saved.finishedAt=new Date().toISOString();
    c.store.state.messages.push({id:'reply-1',target:w.id,speaker:'agent',text:'已解释：依据是原文第二节的对照实验。',jobId:job.id});
  });
  const after=await c.reviewDiscussionRead({objectId});
  const mineAfter=after.entries.find(e=>e.id===userMessage.id);
  assert.equal(mineAfter.status,'completed');
  const reply=after.entries.find(e=>e.id==='reply-1');
  assert.equal(reply.source,'review-discussion');assert.equal(reply.speaker,'worker');assert.equal(reply.status,'completed');
});

test('discussion send is idempotent by exact digest and the host receipt precheck replays the original acceptance',async t=>{
  const {c,w,objectId}=await fixture(t);
  const reviewVersion=await versionOf(c,objectId);
  const p={objectId,reviewVersion,requestKey:'discuss-idem-0001',text:'同一问题'};
  const first=await c.reviewDiscussionSend(p);
  const replay=await c.reviewDiscussionSend(p);
  assert.equal(replay.accepted,true);assert.equal(replay.duplicate,true);assert.equal(replay.jobId,first.jobId);assert.equal(replay.revision,first.revision);
  assert.equal(c.store.state.jobs.filter(j=>j.context?.reviewDiscussion).length,1);
  // 宿主决策屏障的回执查询：未接受=null，已接受=原回执，同键不同载荷=碰撞。
  const receiptCheck=await c.reviewDiscussionReceipt({...p,workId:w.id});
  assert.deepEqual(receiptCheck,{accepted:true,jobId:first.jobId,workId:w.id,revision:first.revision,duplicate:true});
  assert.equal(await c.reviewDiscussionReceipt({...p,workId:w.id,requestKey:'discuss-idem-9999'}),null);
  assert.throws(()=>c.reviewDiscussionReceipt({...p,workId:w.id,text:'不同正文'}),error=>error.code==='REVIEW_REQUEST_COLLISION');
  await assert.rejects(c.reviewDiscussionSend({...p,text:'不同正文'}),error=>error.code==='REVIEW_REQUEST_COLLISION');
});

test('stale reviewVersion binds the manual-draft baseline: reject, never silently ignore or overwrite drafts',async t=>{
  const {c,w,objectId}=await fixture(t);
  const stale=await versionOf(c,objectId);
  await c.reviewSave({objectId,relPath:'reading.md',text:'# 人工修订\n\n确认正文。\n',expectedDraftRevision:0});
  const draftBefore=structuredClone(w.review.drafts['reading.md']);
  await assert.rejects(c.reviewDiscussionSend({objectId,reviewVersion:stale,requestKey:'discuss-stale-01',text:'按我的修订继续核对'}),error=>error.code==='REVIEW_VERSION_STALE');
  assert.deepEqual(w.review.drafts['reading.md'],draftBefore);
  assert.equal(c.store.state.jobs.filter(j=>j.context?.reviewDiscussion).length,0);
});

test('discussion send with saved drafts applies them through the continuation machinery and requires a fresh matching publication',async t=>{
  const {c,w,objectId,dir}=await fixture(t);
  const human='# 人工修订\n\n确认正文 HUMAN-REVIEWED。\n';
  await c.reviewSave({objectId,relPath:'reading.md',text:human,expectedDraftRevision:0});
  const fresh=await versionOf(c,objectId);
  const sent=await c.reviewDiscussionSend({objectId,reviewVersion:fresh,requestKey:'discuss-draft-001',text:'请按我改的版本继续'});
  assert.equal(sent.accepted,true);
  assert.equal(await fs.readFile(path.join(dir,'reading.md'),'utf8'),human);
  assert.equal(w.revision,2);assert.equal(w.status,'running');
  assert.equal(w.review.drafts['reading.md'],undefined);            // 已消费进cursor
  assert.ok(w.review.history['reading.md'].some(h=>h.revision===1));
  const continuation=w.review.continuations.find(x=>x.requestKey==='discuss-draft-001');
  assert.equal(continuation.discussion,true);assert.equal(continuation.state,'queued');
  const job=c.store.state.jobs.find(j=>j.id===sent.jobId);
  assert.equal(job.context.reviewDiscussion.requestKey,'discuss-draft-001');
  assert.equal(job.context.userInput.text,'请按我改的版本继续');   // 原生用户条目=用户原文
  assert.ok(job.text.includes('请按我改的版本继续'));               // 宿主指令保留恢复材料
  const userMessage=c.store.state.messages.find(m=>m.jobId===job.id&&m.speaker==='user');
  assert.equal(userMessage.text,'请按我改的版本继续');assert.equal(userMessage.reviewDiscussion,'discuss-draft-001');
  // 旧发布全stale：接受保持阻断直到发布匹配新快照。
  assert.equal(c.store.state.receipts.find(r=>r.objectId===objectId).stale.code,'SUPERSEDED');
  await assert.rejects(c.reviewAccept({objectId,reviewVersion:fresh,requestKey:'accept-blocked-1'}),error=>error.code==='REVIEW_CANDIDATE_STALE');
  // 宿主幂等回执同样覆盖带草稿的讨论续作。
  const receipt=await c.reviewDiscussionReceipt({objectId,reviewVersion:fresh,requestKey:'discuss-draft-001',text:'请按我改的版本继续',workId:w.id});
  assert.equal(receipt.jobId,sent.jobId);assert.equal(receipt.duplicate,true);
  // Worker 在同一Work发布v2（同线程同Work，不新建Work）。
  const worksBefore=c.store.state.works.length;
  await c.execution.publish(w,{id:'report-job-2'},()=>true,async(manifest,candidate)=>{
    const binding={projectId:c.store.projectId,workId:w.id,revision:2,jobId:'report-job-2',receiptId:'report-2',repo:manifest.repo,commonDir:manifest.commonDir,inputCommit:manifest.inputCommit,candidateCommit:candidate.commit};
    const row=await c.store.publish(w.id,2,'result',page('Candidate v2 after human draft'),'report-2',{jobId:'report-job-2',files:[{relPath:'reading.md'},{relPath:'notes.md'}],retainCandidate:async()=>{const retained=await c.changes.capture(binding);return {...retained,rollback:()=>c.changes.discardUnpublished(retained.changeSetId,binding)};}});
    return {changeSetId:row.changeSetId};
  },{receiptId:'report-2'});
  await c.store.settle(w.id);
  await c.store.mutate(()=>{
    const saved=c.store.state.jobs.find(j=>j.id===job.id);saved.status='completed';saved.finishedAt=new Date().toISOString();
    c.store.state.jobs.push({id:'report-job-2',target:w.id,revision:2,type:'manual',status:'completed'});
  });
  assert.equal(c.store.state.works.length,worksBefore);
  const v2=c.store.state.receipts.find(r=>r.id==='report-2');
  assert.equal(w.result.objectId,v2.objectId);assert.equal(w.status,'review');
  // 旧对象读取=按对象stale（同修订连续发布可区分），接受走最新发布成功。
  const old=await c.reviewRead({objectId});
  assert.equal(old.stale.code,'SUPERSEDED');assert.equal(old.capabilities.canAccept,false);
  const now=await c.reviewRead({objectId:v2.objectId});
  assert.equal(now.capabilities.canAccept,true);
  await c.reviewAccept({objectId:v2.objectId,reviewVersion:now.reviewVersion,requestKey:'discuss-accept-01'});
  assert.equal(w.outcome,'accept');
});

test('accept is blocked by active discussion turns and by unpublished worktree drift, and recovers after matching publication',async t=>{
  const {c,w,objectId,dir,content}=await fixture(t);
  const reviewVersion=await versionOf(c,objectId);
  // 1) 活跃讨论回合阻断接受（含queued）。
  const sent=await c.reviewDiscussionSend({objectId,reviewVersion,requestKey:'discuss-gate-001',text:'确认验证方式'});
  const dto=await c.reviewDiscussionRead({objectId});
  assert.equal(dto.active,false);assert.equal(dto.queued,1);
  assert.equal(dto.canSend,true,'discussion-only busy allows durable queueing');assert.deepEqual(dto.reasons,[]);
  const capsBusy=await c.reviewRead({objectId});
  assert.equal(capsBusy.capabilities.canAccept,false);
  assert.ok(capsBusy.capabilities.reasons.some(r=>r.code==='DISCUSSION_ACTIVE'));
  await assert.rejects(c.reviewAccept({objectId,reviewVersion,requestKey:'accept-gate-1'}),error=>error.code==='DISCUSSION_ACTIVE');
  // 回合结算后解除。
  await c.store.mutate(()=>{const saved=c.store.state.jobs.find(j=>j.id===sent.jobId);saved.status='completed';saved.finishedAt=new Date().toISOString();});
  await c.store.settle(w.id);
  // 2) 未发布改动（新增/修改/删除）都构成漂移；旧报告对象本身不可改。
  await fs.writeFile(path.join(dir,'untracked.txt'),'未发布的改动');
  const drifted=await c.reviewRead({objectId});
  assert.ok(drifted.capabilities.reasons.some(r=>r.code==='CANDIDATE_DRIFT'));
  assert.equal(drifted.capabilities.canAccept,false);
  await assert.rejects(c.reviewAccept({objectId,reviewVersion,requestKey:'accept-gate-2'}),error=>error.code==='CANDIDATE_DRIFT');
  await fs.rm(path.join(dir,'untracked.txt'));
  await fs.writeFile(path.join(dir,'reading.md'),'直接改写候选');
  await assert.rejects(c.reviewAccept({objectId,reviewVersion,requestKey:'accept-gate-3'}),error=>error.code==='CANDIDATE_DRIFT');
  await fs.rm(path.join(dir,'notes.md'));
  await assert.rejects(c.reviewAccept({objectId,reviewVersion,requestKey:'accept-gate-4'}),error=>error.code==='CANDIDATE_DRIFT');
  await fs.writeFile(path.join(dir,'notes.md'),BASELINE_NOTES);await fs.writeFile(path.join(dir,'reading.md'),CANDIDATE_MD);
  // 3) 发布匹配快照后漂移消失，接受可用。
  const clean=await c.reviewRead({objectId});
  assert.equal(clean.capabilities.reasons.some(r=>r.code==='CANDIDATE_DRIFT'),false);
  assert.equal(clean.capabilities.canAccept,true);
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),BASELINE_MD);
});

test('send gates: non-discussion busy blocks, ended works refuse discussion, superseded objects rejected per object',async t=>{
  const {c,w,objectId}=await fixture(t);
  const reviewVersion=await versionOf(c,objectId);
  // 非讨论在飞输入（其他manual/续作/恢复）阻断发送与canSend。
  await c.store.mutate(()=>{c.store.state.jobs.push({id:'other-input',target:w.id,revision:w.revision,type:'manual',status:'queued',context:{boundWorkId:w.id}});});
  const blocked=await c.reviewDiscussionRead({objectId});
  assert.equal(blocked.canSend,false);assert.ok(blocked.reasons.includes('WORK_BUSY'));
  await assert.rejects(c.reviewDiscussionSend({objectId,reviewVersion,requestKey:'discuss-busy-001',text:'其他输入在飞'}),error=>error.code==='WORK_BUSY');
  await c.store.mutate(()=>{c.store.state.jobs.find(j=>j.id==='other-input').status='cancelled';});
  // 结束路径拒绝讨论。
  await c.store.end(w.id,{by:'user',revision:w.revision,decision:'discard',binding:{workId:w.id,revision:w.revision,objectId,candidateCommit:w.execution.candidate.commit},requestKey:'discuss-end-0001',validateAdmission:()=>{}});
  await assert.rejects(c.reviewDiscussionSend({objectId,reviewVersion,requestKey:'discuss-busy-002',text:'结束后的问题'}),error=>error.code==='WORK_ENDED');
  const dto=await c.reviewDiscussionRead({objectId});
  assert.equal(dto.canSend,false);assert.ok(dto.reasons.includes('WORK_ENDED'));
});

test('pure messages queue durably behind an active discussion round: FIFO single owner, settle only after the queue drains',async t=>{
  const {c,w,objectId,worksBefore}=await fixture(t);
  const reviewVersion=await versionOf(c,objectId);
  const first=await c.reviewDiscussionSend({objectId,reviewVersion,requestKey:'discuss-q-0001',text:'第一问'});
  const second=await c.reviewDiscussionSend({objectId,reviewVersion,requestKey:'discuss-q-0002',text:'第二问'});
  const third=await c.reviewDiscussionSend({objectId,reviewVersion,requestKey:'discuss-q-0003',text:'第三问'});
  assert.equal(second.duplicate,undefined);assert.equal(third.duplicate,undefined);
  const queue=c.store.state.jobs.filter(j=>j.context?.reviewDiscussion);
  assert.equal(queue.length,3);
  assert.deepEqual(queue.map(j=>j.id),[first.jobId,second.jobId,third.jobId]);  // FIFO=账本顺序
  assert.ok(queue.every(j=>j.target===w.id&&j.revision===w.revision));          // 同Work同修订，单owner串行
  assert.ok(queue.every(j=>j.context.reviewDiscussion.objectId===objectId));    // 绑定同一当前对象
  assert.equal(w.status,'running');assert.equal(w.revision,1);assert.equal(c.store.state.works.length,worksBefore);
  const dto=await c.reviewDiscussionRead({objectId});
  assert.equal(dto.canSend,true);assert.deepEqual(dto.reasons,[]);assert.equal(dto.queued,3);assert.equal(dto.active,false);
  // runJob结算面：模拟真实串行推进 queued→running→completed；任一时点仍
  // 有其他排队讨论回合即不收口，仅最后一回合（无其他排队）满足结算。
  assert.equal(c.discussionQueuedBehind(queue[0]),true);
  await c.store.mutate(()=>{Object.assign(queue[0],{status:'completed',finishedAt:new Date().toISOString()});Object.assign(queue[1],{status:'running'});});
  assert.equal(c.discussionQueuedBehind(queue[1]),true);
  await c.store.mutate(()=>{Object.assign(queue[1],{status:'completed',finishedAt:new Date().toISOString()});Object.assign(queue[2],{status:'running'});});
  assert.equal(c.discussionQueuedBehind(queue[2]),false);
  // 队列进行中拒绝并发草稿apply（显式安全边界），纯文本已排队不受影响。
  await c.reviewSave({objectId,relPath:'reading.md',text:'# 排队期间的草稿\n',expectedDraftRevision:0});
  const queuedVersion=await versionOf(c,objectId);
  await assert.rejects(c.reviewDiscussionSend({objectId,reviewVersion:queuedVersion,requestKey:'discuss-q-0004',text:'带草稿的排队'}),error=>error.code==='WORK_BUSY');
  // 队列在飞时接受保持阻断；全部结算后恢复review。
  await assert.rejects(c.reviewAccept({objectId,reviewVersion:queuedVersion,requestKey:'accept-q-0001'}),error=>error.code==='DISCUSSION_ACTIVE');
  await c.store.mutate(()=>{for(const j of queue){j.status='completed';j.finishedAt=new Date().toISOString();}});
  await c.store.settle(w.id);
  assert.equal(w.status,'review');
  const after=await c.reviewDiscussionRead({objectId});
  assert.equal(after.queued,0);assert.equal(after.canSend,true);
});

test('instruction draft is Work-scoped: retained across publication changes, savable during discussion flight, CAS intact',async t=>{
  const {c,w,objectId}=await fixture(t);
  await c.reviewInstructionSave({objectId,text:'作曲框文本 v1',expectedRevision:0});
  const reviewVersion=await versionOf(c,objectId);
  await c.reviewDiscussionSend({objectId,reviewVersion,requestKey:'discuss-inst-0001',text:'讨论中'});
  // 讨论回合进行中允许保存（UI发送后清理作曲框）。
  const cleared=await c.reviewInstructionSave({objectId,text:'',expectedRevision:1});
  assert.equal(cleared.accepted,true);
  await c.reviewInstructionSave({objectId,text:'作曲框文本 v2',expectedRevision:2});
  // 新发布（同Work）后草稿保留：按workId读取仍是当前文本与revision。
  await c.store.mutate(()=>{w.status='running';});
  await c.store.publish(w.id,1,'result',page('Candidate v2 same revision'),'report-2',{jobId:'report-job-files',files:[{relPath:'reading.md'},{relPath:'notes.md'}]});
  await c.store.settle(w.id);
  const v2ObjectId=w.result.objectId;
  assert.notEqual(v2ObjectId,objectId);
  const kept=await c.reviewInstructionRead({workId:w.id});
  assert.equal(kept.text,'作曲框文本 v2');assert.equal(kept.revision,3);assert.equal(kept.objectId,v2ObjectId);
  // 旧objectId保存不再被REVIEW_CANDIDATE_STALE拒绝；CAS仍按Work单调版本。
  const saved=await c.reviewInstructionSave({objectId,text:'作曲框文本 v3',expectedRevision:3});
  assert.equal(saved.revision,4);
  await assert.rejects(c.reviewInstructionSave({objectId,text:'过期版本',expectedRevision:3}),error=>error.code==='REVIEW_INSTRUCTION_STALE');
});
