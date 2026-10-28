import {openTestController} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

// 真实Git回归：结构化MergeAuthorization、no-auto-commit接受即本地合入、
// 显式never-commit一次性人工覆盖、旧阻断迁移恢复、不覆盖用户修改、
// 过期批准拒绝。全部走真实Controller + 真实worktree + 真实主仓库。
const run=promisify(execFile);
const page=body=>'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture report</title></head><body><main><h1>Fixture report</h1><p>'+body+'</p></main></body></html>';
const BASELINE_MD='# 阅读\n\n原始基线正文。\n';
const CANDIDATE_MD='# 阅读\n\nWorker 候选正文 v1。\n';
const BASELINE_NOTES='原始备注。\n';

async function fixture(t,{request='整理阅读笔记并产出markdown',noCommitInput=false,inputOverlay=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-merge-consent-')),content=path.join(root,'project');
  await fs.mkdir(content);
  await fs.writeFile(path.join(content,'reading.md'),BASELINE_MD);
  await fs.writeFile(path.join(content,'notes.md'),BASELINE_NOTES);
  const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:content});
  const submitted=await c.store.submit(request,'worker brief',{name:'MergeConsent'});
  if(noCommitInput)await c.store.mutate(()=>{c.store.find(submitted.id).inputs=[{sourceJobId:'input-job-1',sourceInputJobIds:[],text:'补充约束：这轮明确不要提交git。',context:{},at:new Date().toISOString(),userAction:'no-commit'}];});
  if(inputOverlay)await fs.writeFile(path.join(content,'reading.md'),BASELINE_MD+'\nExisting uncommitted input\n');
  await c.store.activate(submitted.id);await c.execution.prepare(submitted.id);
  const dir=c.execution.directory(submitted.id);
  await fs.writeFile(path.join(dir,'reading.md'),CANDIDATE_MD);
  const publishResult=retainCandidate=>c.store.publish(submitted.id,1,'result',page('Candidate v1'),'report-1',{jobId:'report-job',files:[{relPath:'reading.md'},{relPath:'notes.md'}],retainCandidate});
  await c.execution.publish(c.store.find(submitted.id),{id:'report-job'},()=>true,async(manifest,candidate)=>{
    const binding={projectId:c.store.projectId,workId:submitted.id,revision:1,jobId:'report-job',receiptId:'report-1',repo:manifest.repo,commonDir:manifest.commonDir,inputCommit:manifest.inputCommit,candidateCommit:candidate.commit};
    const receipt=await publishResult(async()=>{const retained=await c.changes.capture(binding);return {...retained,rollback:()=>c.changes.discardUnpublished(retained.changeSetId,binding)};});
    return {changeSetId:receipt.changeSetId};
  },{receiptId:'report-1'});
  await c.store.settle(submitted.id);
  await c.store.mutate(()=>{c.store.state.jobs.push({id:'report-job',target:submitted.id,revision:1,type:'initial',status:'completed'});});
  const headBefore=(await run('git',['rev-parse','HEAD'],{cwd:content})).stdout.trim();
  t.after(async()=>{if(!c.store.closed)await c.stop().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
  const w=c.store.find(submitted.id);
  const receipt=c.store.state.receipts.find(r=>r.kind==='result'&&r.workId===w.id);
  return {c,w,content,root,dir,receipt,objectId:receipt.objectId,headBefore};
}

async function acceptReviewed(c,{objectId,text,requestKey}){
  await c.reviewSave({objectId,relPath:'reading.md',text,expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  return c.reviewAccept({objectId,reviewVersion:fresh.reviewVersion,requestKey});
}

function consentBindingOf(w){
  const a=w.closure.mergeAuthorization;
  return {workId:w.id,revision:a.revision,objectId:a.objectId,candidateCommit:a.candidateCommit,reviewVersion:a.reviewVersion,repo:a.repo,targetRef:a.targetRef,targetHead:a.targetHead};
}

test('noautoacceptmerge: nothing merges without an explicit user accept, even across host restart',async t=>{
  const {c,w,content,root,headBefore}=await fixture(t);
  await c.stop();
  const c2=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:content});
  t.after(async()=>{if(!c2.store.closed)await c2.stop().catch(()=>{});});
  const w2=c2.store.find(w.id);
  assert.equal(w2.status,'review');
  assert.equal(w2.closure,undefined);
  assert.deepEqual(c2.store.state.mergeQueue??[],[]);
  const head=(await run('git',['rev-parse','HEAD'],{cwd:content})).stdout.trim();
  assert.equal(head,headBefore,'主分支未被自动合入');
  assert.equal((await run('git',['show','HEAD:reading.md'],{cwd:content})).stdout,BASELINE_MD);
});

test('explicitneverblocked: structured never-commit blocks the merge and exposes the one-time override todo',async t=>{
  const {c,w,objectId,content}=await fixture(t,{noCommitInput:true});
  const human='人工最终正文 never。\n';
  const outcome=await acceptReviewed(c,{objectId,text:human,requestKey:'accept-never-1'});
  assert.equal(outcome.accepted,true);
  assert.equal(outcome.merge.status,'blocked');
  assert.equal(outcome.merge.blockedCode,'MERGE_CONSENT_REQUIRED');
  assert.equal(outcome.merge.commit,null);
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),BASELINE_MD);
  const done=c.store.find(w.id);
  assert.equal(done.closure.mergeAuthorization.consentRequired,true);
  assert.ok(done.closure.mergeAuthorization.request.version>=1);
  assert.ok(c.store.state.todos.some(x=>x.workId===w.id&&x.kind==='merge-consent'&&x.status==='open'));
});

test('approveonce: one exact-candidate approval merges once; duplicates are idempotent and never replay the worker',async t=>{
  const {c,w,objectId,content}=await fixture(t,{noCommitInput:true});
  const human='人工最终正文 approve-once。\n';
  await acceptReviewed(c,{objectId,text:human,requestKey:'accept-once-1'});
  const done=c.store.find(w.id),jobsBefore=c.store.state.jobs.length,requestBefore=done.request;
  const approved=await c.resolveMergeConsent(w.id,{requestId:done.closure.mergeAuthorization.request.id,expectedVersion:done.closure.mergeAuthorization.request.version,action:'approve',requestKey:'consent-approve-1',binding:consentBindingOf(done)});
  assert.equal(approved.status,'approved');
  assert.equal(approved.duplicate,false);
  assert.equal(approved.merge.status,'merged');
  const head=(await run('git',['rev-parse','HEAD'],{cwd:content})).stdout.trim();
  assert.equal(head,approved.merge.commit);
  assert.equal((await run('git',['show','HEAD:reading.md'],{cwd:content})).stdout,human);
  const countBefore=(await run('git',['rev-list','--count','HEAD'],{cwd:content})).stdout.trim();
  // 同一requestKey重放：幂等回执，不产生第二次合入。
  const replay=await c.resolveMergeConsent(w.id,{requestId:done.closure.mergeAuthorization.request.id,expectedVersion:done.closure.mergeAuthorization.request.version,action:'approve',requestKey:'consent-approve-1',binding:consentBindingOf(done)});
  assert.equal(replay.duplicate,true);
  assert.equal(replay.status,'approved');
  // 已决定后的另一确认身份：拒绝（已完成决定不可换身份重做）。
  await assert.rejects(c.resolveMergeConsent(w.id,{requestId:done.closure.mergeAuthorization.request.id,expectedVersion:done.closure.mergeAuthorization.request.version,action:'approve',requestKey:'consent-approve-2',binding:consentBindingOf(done)}),error=>error.code==='REVIEW_REQUEST_COLLISION');
  const countAfter=(await run('git',['rev-list','--count','HEAD'],{cwd:content})).stdout.trim();
  assert.equal(countAfter,countBefore,'不重复合入');
  assert.equal(c.store.state.jobs.length,jobsBefore,'不重放Worker');
  assert.equal(c.store.find(w.id).request,requestBefore,'不改写原请求');
  const row=c.store.state.mergeQueue.find(e=>e.workId===w.id);
  assert.equal(row.status,'done');
});

test('oldendedrecover: legacy USER_NO_COMMIT block migrates to a one-time policy todo and never auto-authorizes',async t=>{
  const {c,w,objectId,content,root}=await fixture(t,{noCommitInput:true});
  await acceptReviewed(c,{objectId,text:'人工最终正文 legacy。\n',requestKey:'accept-legacy-1'});
  // 构造旧版现场：原始文本扫描时代的阻断标记，无结构化授权与策略记录。
  await c.store.mutate(()=>{
    const work=c.store.find(w.id);
    work.closure.merge.blockedCode='USER_NO_COMMIT';
    delete work.closure.merge.consentOrigin;
    delete work.closure.mergeAuthorization;
    delete work.mergeConstraint;
    work.inputs=work.inputs.map(({userAction,...input})=>input);
    const row=c.store.state.mergeQueue.find(e=>e.workId===w.id);
    row.status='blocked';row.lastError='此工作明确要求不提交Git；请先明确更新这一约束，再选择接受';
  });
  await c.stop();
  const c2=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:content});
  t.after(async()=>{if(!c2.store.closed)await c2.stop().catch(()=>{});});
  const w2=c2.store.find(w.id);
  // 迁移只重新归类：不解除阻断、不静默授权旧禁止；改为legacy-unresolved
  // 一次性策略待办，原请求文本不改写。
  assert.equal(w2.closure.merge.blockedCode,'MERGE_CONSENT_REQUIRED');
  assert.equal(w2.mergeConstraint.mode,'unresolved');
  assert.equal(w2.closure.mergeAuthorization.consentRequired,true);
  assert.equal(w2.closure.mergeAuthorization.candidateCommit,w2.execution.candidate.commit);
  const dto=await c2.reviewRead({objectId});
  assert.equal(dto.mergeConsent.required,true);
  assert.equal(dto.mergeConsent.status,'pending');
  assert.equal(dto.mergeConsent.reasonCode,'NO_COMMIT_LEGACY_UNTRUSTED');
  assert.equal(dto.mergeConsent.constraint.mode,'unresolved');
  assert.ok(c2.store.state.todos.some(x=>x.workId===w.id&&x.kind==='merge-constraint'&&x.status==='open'),'一次性策略待办已暴露');
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),BASELINE_MD,'迁移未合入');
  // 用户确认策略为临时暂缓：按原队列恢复收尾，不重放Worker、不改写原请求。
  const jobsBefore=c2.store.state.jobs.length;
  const policy=await c2.resolveMergeConstraint(w.id,{expectedVersion:1,choice:'hold',requestKey:'policy-legacy-1'});
  assert.equal(policy.status,'hold');
  assert.equal(policy.merge.status,'merged');
  assert.equal((await run('git',['show','HEAD:reading.md'],{cwd:content})).stdout,'人工最终正文 legacy。\n');
  assert.equal(c2.store.state.jobs.length,jobsBefore,'不重放Worker');
  assert.equal(c2.store.find(w.id).request,'整理阅读笔记并产出markdown','原请求未改写');
});
test('legacy accepted candidate with only closure.error exposes policy and resumes without Worker replay',async t=>{
  const {c,w,content,root}=await fixture(t,{noCommitInput:true});
  await c.endWork(w.id,{revision:1,decision:'accept'});
  await c.store.mutate(()=>{
    const work=c.store.find(w.id);
    delete work.closure.merge;
    delete work.closure.mergeAuthorization;
    delete work.closure.reviewedVersion;
    delete work.mergeConstraint;
    work.inputs=work.inputs.map(({userAction,...input})=>input);
    work.closure.phase='blocked';
    work.closure.error='此工作明确要求不提交Git；请先明确更新这一约束，再选择接受';
    c.store.state.mergeQueue=[];
  });
  await c.stop();
  const c2=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:content,localOnly:true,sessionFactory:()=>{throw Error('local policy recovery must not launch a model');}});
  t.after(async()=>{if(!c2.store.closed)await c2.stop().catch(()=>{});});
  const recovered=c2.store.find(w.id),jobsBefore=c2.store.state.jobs.length;
  assert.equal(recovered.mergeConstraint?.mode,'unresolved');
  assert.ok(c2.store.state.todos.some(todo=>todo.workId===w.id&&todo.kind==='merge-constraint'&&todo.status==='open'));
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),BASELINE_MD);
  await c2.resolveMergeConstraint(w.id,{expectedVersion:1,choice:'hold',requestKey:'legacy-error-policy-1'});
  assert.equal(c2.store.find(w.id).closure.phase,'complete');
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),CANDIDATE_MD);
  assert.equal(c2.store.state.jobs.length,jobsBefore);
});
for(const stale of [false,true])test('explicit accepted-file reconciliation preserves later target edits; stale='+stale,async t=>{
  const {c,w,content}=await fixture(t,{inputOverlay:true});
  const current=BASELINE_MD+'\nExisting uncommitted input\nLater user note\n',merged=CANDIDATE_MD+'\nExisting uncommitted input\nLater user note\n';
  await fs.writeFile(path.join(content,'reading.md'),current);
  await c.endWork(w.id,{revision:1,decision:'accept'});
  assert.equal(w.closure.phase,'blocked');
  const count=c.store.state.jobs.length;
  await c.reconcileAcceptedFiles(w.id,{requestKey:'explicit-reconciliation-1',files:[{relPath:'reading.md',text:merged,expectedDigest:createHash('sha256').update(current).digest('hex')}]});
  if(stale)await fs.writeFile(path.join(content,'reading.md'),current+'Concurrent note\n');
  await c.retryClosure(w.id);
  assert.equal(w.closure.phase,stale?'blocked':'complete');
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),stale?current+'Concurrent note\n':merged);
  if(!stale)assert.equal((await run('git',['show','main:reading.md'],{cwd:content})).stdout,merged);
  assert.equal(c.store.state.jobs.length,count);
});

test('noauthbypass: accept without a recorded typed authorization never merges (zero writes)',async t=>{
  const {c,w,content,headBefore}=await fixture(t);
  // 绕过决定账本直接驱动执行层接受（无授权）：必须拒绝且零写入。
  await assert.rejects(c.execution.finish(c.store.find(w.id),{decision:'accept',reportPersisted:true,isActive:()=>false}),error=>error.code==='MERGE_AUTHORIZATION_REQUIRED');
  assert.equal((await run('git',['rev-parse','HEAD'],{cwd:content})).stdout.trim(),headBefore,'零写入');
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),BASELINE_MD);
});

test('tamperedauth: tampered targetHead/objectId/review token reject with zero writes',async t=>{
  const {c,w,objectId,content}=await fixture(t,{noCommitInput:true});
  const human='人工正文 tamper。\n';
  await acceptReviewed(c,{objectId,text:human,requestKey:'accept-tamper-1'});
  const done=c.store.find(w.id),request=done.closure.mergeAuthorization.request,base=consentBindingOf(done);
  const head=()=>run('git',['rev-parse','HEAD'],{cwd:content}).then(r=>r.stdout.trim());
  const mergeState=()=>c.store.find(w.id).closure.merge;
  const beforeHead=await head();
  // 篡改targetHead（无受管推进链）：一次性批准本身通过（绑定与落账一致），
  // 但整合的类型化授权校验必须拒绝且零写入。
  await c.store.mutate(()=>{c.store.find(w.id).closure.mergeAuthorization.targetHead='1'.repeat(40);});
  const tamperedHead=await c.resolveMergeConsent(w.id,{requestId:request.id,expectedVersion:request.version,action:'approve',requestKey:'consent-tamper-1',binding:{...base,targetHead:'1'.repeat(40)}});
  assert.equal(tamperedHead.status,'approved');
  assert.equal(mergeState().status,'blocked');
  assert.equal(mergeState().blockedCode,'MERGE_AUTHORIZATION_STALE');
  assert.equal(await head(),beforeHead,'targetHead篡改零写入');
  // 篡改objectId后重试收尾：拒绝。
  await c.store.mutate(()=>{const a=c.store.find(w.id).closure.mergeAuthorization;a.targetHead=base.targetHead;a.objectId='tampered-object';});
  await c.retryClosure(w.id,{requestKey:'accept-tamper-1'});
  assert.equal(mergeState().blockedCode,'MERGE_AUTHORIZATION_STALE');
  assert.equal(await head(),beforeHead,'objectId篡改零写入');
  // 篡改审校版本令牌后重试收尾：拒绝。
  await c.store.mutate(()=>{const a=c.store.find(w.id).closure.mergeAuthorization;a.objectId=base.objectId;a.reviewVersion='f'.repeat(64);});
  await c.retryClosure(w.id,{requestKey:'accept-tamper-1'});
  assert.equal(mergeState().blockedCode,'MERGE_AUTHORIZATION_STALE');
  assert.equal(await head(),beforeHead,'审校令牌篡改零写入');
  // 恢复真实值后重试：按原队列正常合入（恢复路径完好）。
  await c.store.mutate(()=>{const a=c.store.find(w.id).closure.mergeAuthorization;a.reviewVersion=base.reviewVersion;});
  await c.retryClosure(w.id,{requestKey:'accept-tamper-1'});
  assert.equal(mergeState().status,'merged');
  assert.equal((await run('git',['show','HEAD:reading.md'],{cwd:content})).stdout,human);
});

test('constraintadmission: explicit never-commit wording enters a version-bound policy todo; temporary wording does not',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-consent-admit-')),content=path.join(root,'project');
  await fs.mkdir(content);
  await fs.writeFile(path.join(content,'reading.md'),BASELINE_MD);
  await fs.writeFile(path.join(content,'notes.md'),BASELINE_NOTES);
  const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:content});
  t.after(async()=>{await c.stop().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
  const submitted=await c.store.submit('整理阅读笔记，永远不要提交git','brief',{name:'Admission'});
  const queued=c.store.find(submitted.id);
  assert.equal(queued.mergeConstraint.mode,'unresolved');
  assert.equal(queued.mergeConstraint.origin,'detected');
  assert.ok(c.store.state.todos.some(x=>x.workId===submitted.id&&x.kind==='merge-constraint'&&x.status==='open'),'策略待办已建');
  // 临时措辞不触发：宽泛“先不要提交”是no-auto-commit暂缓，接受即授权。
  const temp=await c.store.submit('整理reading.md，暂时别提交git','brief',{name:'Temporary'});
  assert.equal(c.store.find(temp.id).mergeConstraint,undefined);
  assert.equal(c.store.state.todos.some(x=>x.workId===temp.id&&x.kind==='merge-constraint'),false);
  await c.stop();
});

test('constraintresolve: hold resumes the exact queue without a second approval; never-commit needs the one-time override and is revocable',async t=>{
  const {c,w,objectId,content}=await fixture(t,{request:'整理阅读笔记，永远不要提交git'});
  const human='人工正文 policy。\n';
  const fresh0=await c.reviewRead({objectId});
  assert.equal(fresh0.mergeConsent.required,true);
  assert.equal(fresh0.mergeConsent.reasonCode,'NO_COMMIT_POLICY_UNRESOLVED');
  assert.equal(fresh0.mergeConsent.constraint.mode,'unresolved');
  const outcome=await acceptReviewed(c,{objectId,text:human,requestKey:'accept-policy-1'});
  assert.equal(outcome.merge.status,'blocked');
  assert.equal(outcome.merge.blockedCode,'MERGE_CONSENT_REQUIRED');
  assert.ok(c.store.state.todos.some(x=>x.workId===w.id&&x.kind==='merge-constraint'&&x.status==='open'));
  // 确认为临时暂缓：一次性决定，恢复原队列直接合入，无需第二次批准。
  const policy=await c.resolveMergeConstraint(w.id,{expectedVersion:1,choice:'hold',requestKey:'policy-hold-1'});
  assert.equal(policy.status,'hold');
  assert.equal(policy.merge.status,'merged');
  assert.equal((await run('git',['show','HEAD:reading.md'],{cwd:content})).stdout,human);
  const replay=await c.resolveMergeConstraint(w.id,{expectedVersion:1,choice:'hold',requestKey:'policy-hold-1'});
  assert.equal(replay.duplicate,true);
  await assert.rejects(c.resolveMergeConstraint(w.id,{expectedVersion:1,choice:'none',requestKey:'policy-hold-1'}),error=>error.code==='DECISION_CHANGED');

  // 第二件工作：确认never-commit后仍需一次性合入批准；撤回策略即可合入。
  const second=await fixture(t,{request:'整理notes.md，决不提交git'});
  const s2=await acceptReviewed(second.c,{objectId:second.objectId,text:'人工正文 never2。\n',requestKey:'accept-policy-2'});
  assert.equal(s2.merge.status,'blocked');
  const never=await second.c.resolveMergeConstraint(second.w.id,{expectedVersion:1,choice:'never-commit',requestKey:'policy-never-2'});
  assert.equal(never.status,'never-commit');
  assert.equal(never.merge.status,'blocked');
  assert.equal(never.mergeConsent.required,true);
  assert.equal(never.mergeConsent.status,'pending');
  assert.equal(never.mergeConsent.constraint.mode,'never-commit');
  const done2=second.c.store.find(second.w.id);
  const approved=await second.c.resolveMergeConsent(second.w.id,{requestId:done2.closure.mergeAuthorization.request.id,expectedVersion:done2.closure.mergeAuthorization.request.version,action:'approve',requestKey:'consent-never-2',binding:consentBindingOf(done2)});
  assert.equal(approved.merge.status,'merged');
  assert.equal((await run('git',['show','HEAD:reading.md'],{cwd:second.content})).stdout,'人工正文 never2。\n');
});

test('nooverwrites: approval never bypasses drift protection or overwrites user files',async t=>{
  const {c,w,objectId,content}=await fixture(t,{noCommitInput:true});
  await acceptReviewed(c,{objectId,text:'人工最终正文 overwrite。\n',requestKey:'accept-overwrite-1'});
  // 用户在主分支上的外部修改（非受管提交）。
  await fs.writeFile(path.join(content,'reading.md'),'用户在主分支上的外部修改。\n');
  await run('git',['add','reading.md'],{cwd:content});
  await run('git',['-c','user.name=External','-c','user.email=e@x','-c','commit.gpgSign=false','commit','-m','external main change'],{cwd:content});
  const externalHead=(await run('git',['rev-parse','HEAD'],{cwd:content})).stdout.trim();
  const done=c.store.find(w.id);
  const approved=await c.resolveMergeConsent(w.id,{requestId:done.closure.mergeAuthorization.request.id,expectedVersion:done.closure.mergeAuthorization.request.version,action:'approve',requestKey:'consent-overwrite-1',binding:consentBindingOf(done)});
  assert.equal(approved.status,'approved');
  assert.equal(approved.merge.status,'blocked');
  assert.equal(approved.merge.blockedCode,'HEAD_DRIFT');
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),'用户在主分支上的外部修改。\n','用户文件未被覆盖');
  assert.equal((await run('git',['rev-parse','HEAD'],{cwd:content})).stdout.trim(),externalHead);
});

test('staleapproval rejects: an approval bound to another candidate is refused with zero merges',async t=>{
  const {c,w,objectId,content,headBefore}=await fixture(t,{noCommitInput:true});
  await acceptReviewed(c,{objectId,text:'人工最终正文 stale。\n',requestKey:'accept-stale-1'});
  const done=c.store.find(w.id),request=done.closure.mergeAuthorization.request;
  const stale={...consentBindingOf(done),candidateCommit:'0'.repeat(40)};
  await assert.rejects(c.resolveMergeConsent(w.id,{requestId:request.id,expectedVersion:request.version,action:'approve',requestKey:'consent-stale-1',binding:stale}),error=>error.code==='STALE_APPROVAL');
  const staleVersion={...consentBindingOf(done)};
  await assert.rejects(c.resolveMergeConsent(w.id,{requestId:request.id,expectedVersion:request.version+5,action:'approve',requestKey:'consent-stale-2',binding:staleVersion}),error=>error.code==='STALE_ATTENTION');
  assert.equal(c.store.find(w.id).closure.merge.status,'blocked');
  assert.equal((await run('git',['rev-parse','HEAD'],{cwd:content})).stdout.trim(),headBefore,'零合入');
  // 请求与绑定仍完好，用户可按当前候选重新批准。
  const fresh=c.store.find(w.id);
  const approved=await c.resolveMergeConsent(w.id,{requestId:fresh.closure.mergeAuthorization.request.id,expectedVersion:fresh.closure.mergeAuthorization.request.version,action:'approve',requestKey:'consent-stale-3',binding:consentBindingOf(fresh)});
  assert.equal(approved.status,'approved');
  assert.equal(approved.merge.status,'merged');
});
