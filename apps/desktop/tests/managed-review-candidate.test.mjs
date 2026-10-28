import {openTestController} from './project-storage.fixture.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const page=body=>'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture report</title></head><body><main><h1>Fixture report</h1><p>'+body+'</p></main></body></html>';
const BASELINE_MD='# 阅读\n\n原始基线正文。\n';
const CANDIDATE_MD='# 阅读\n\nWorker 候选正文 v1。\n';
const BASELINE_NOTES='原始备注。\n';

// 真实Controller + 真实执行worktree + 冻结候选 + 已发布结果报告（markdown工件）。
async function fixture(t,{request='整理阅读笔记并产出markdown',beforeAccept,prePublish,seed,noCommitInput=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-review-')),content=path.join(root,'project');
  await fs.mkdir(content);
  await fs.writeFile(path.join(content,'reading.md'),BASELINE_MD);
  await fs.writeFile(path.join(content,'notes.md'),BASELINE_NOTES);
  if(seed)await seed(content);
  const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:content,...(beforeAccept?{beforeAccept}:{})});
  const submitted=await c.store.submit(request,'worker brief',{name:'Review'});
  if(noCommitInput)await c.store.mutate(()=>{c.store.find(submitted.id).inputs=[{sourceJobId:'input-job-1',sourceInputJobIds:[],text:'补充约束：这轮明确不要提交git。',context:{},at:new Date().toISOString(),userAction:'no-commit'}];});
  await c.store.activate(submitted.id);await c.execution.prepare(submitted.id);
  const dir=c.execution.directory(submitted.id);
  await fs.writeFile(path.join(dir,'reading.md'),CANDIDATE_MD);
  if(prePublish)await prePublish(dir);
  // 与真实nozeli_publish一致：结果发布冻结完整变更集证据（WorkChanges），
  // 回执携带changeSetId，供冻结历史清单/固定计数使用。
  const publishResult=retainCandidate=>c.store.publish(submitted.id,1,'result',page('Candidate v1 with reading.md and notes.md'),'report-1',{jobId:'report-job',files:[{relPath:'reading.md'},{relPath:'notes.md'}],retainCandidate});
  await c.execution.publish(c.store.find(submitted.id),{id:'report-job'},()=>true,async(manifest,candidate)=>{
    const binding={projectId:c.store.projectId,workId:submitted.id,revision:1,jobId:'report-job',receiptId:'report-1',repo:manifest.repo,commonDir:manifest.commonDir,inputCommit:manifest.inputCommit,candidateCommit:candidate.commit};
    const receipt=await publishResult(async()=>{const retained=await c.changes.capture(binding);return {...retained,rollback:()=>c.changes.discardUnpublished(retained.changeSetId,binding)};});
    return {changeSetId:receipt.changeSetId};
  },{receiptId:'report-1'});
  await c.store.settle(submitted.id);
  await c.store.mutate(()=>{c.store.state.jobs.push({id:'report-job',target:submitted.id,revision:1,type:'initial',status:'completed'});});
  t.after(async()=>{if(!c.store.closed)await c.stop().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
  const w=c.store.find(submitted.id);
  const receipt=c.store.state.receipts.find(r=>r.kind==='result'&&r.workId===w.id);
  return {c,w,content,root,dir,receipt,objectId:receipt.objectId};
}

test('review read exposes baseline, candidate and durable draft versions',async t=>{
  const {c,objectId}=await fixture(t);
  const dto=await c.reviewRead({objectId});
  assert.equal(dto.status,'review');
  assert.equal(dto.candidate.targetRef,'refs/heads/main');
  assert.match(dto.candidate.commit,/^[a-f0-9]{40}$/);
  const reading=dto.files.find(f=>f.relPath==='reading.md');
  assert.equal(reading.change,'modified');
  assert.equal(reading.baselineText,BASELINE_MD);
  assert.equal(reading.candidateText,CANDIDATE_MD);
  assert.equal(reading.draft,null);
  assert.equal(sha256(Buffer.from(reading.candidateText)),reading.candidateDigest);
  const notes=dto.files.find(f=>f.relPath==='notes.md');
  assert.equal(notes.change,'unchanged');
  assert.equal(notes.candidateText,BASELINE_NOTES);
  assert.match(dto.reviewVersion,/^[a-f0-9]{64}$/);
  assert.deepEqual(dto.capabilities.reasons,[]);
  assert.equal(dto.merge,null);
});

test('staleaccept: outdated reviewVersion is rejected and nothing is merged',async t=>{
  const {c,w,objectId,content}=await fixture(t);
  const before=await c.reviewRead({objectId});
  await c.reviewSave({objectId,relPath:'reading.md',text:'# 阅读\n\n人工修订正文。\n',expectedDraftRevision:0});
  await assert.rejects(c.reviewAccept({objectId,reviewVersion:before.reviewVersion,requestKey:'stale-accept-1'}),error=>error.code==='REVIEW_VERSION_STALE');
  // 第二个文件的草稿同样使旧令牌失效：整Work绑定，不能只看单文件。
  const mid=await c.reviewRead({objectId});
  await c.reviewSave({objectId,relPath:'notes.md',text:'人工修订备注。\n',expectedDraftRevision:0});
  await assert.rejects(c.reviewAccept({objectId,reviewVersion:mid.reviewVersion,requestKey:'stale-accept-2'}),error=>error.code==='REVIEW_VERSION_STALE');
  const now=c.store.find(w.id);
  assert.equal(now.status,'review');
  assert.equal(now.closure,undefined);
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),BASELINE_MD);
});

test('staleaccept: legacy endWork accept refuses while human drafts exist',async t=>{
  const {c,w,objectId}=await fixture(t);
  await c.reviewSave({objectId,relPath:'reading.md',text:'人工草稿正文。\n',expectedDraftRevision:0});
  await assert.rejects(c.endWork(w.id,{revision:w.revision,decision:'accept'}),error=>error.code==='REVIEW_DRAFT_EXISTS');
  assert.equal(c.store.find(w.id).status,'review');
});

test('draftrace: concurrent saves — exactly one CAS winner, loser keeps its input',async t=>{
  const {c,objectId}=await fixture(t);
  const results=await Promise.allSettled([
    c.reviewSave({objectId,relPath:'reading.md',text:'窗口A的正文。\n',expectedDraftRevision:0}),
    c.reviewSave({objectId,relPath:'reading.md',text:'窗口B的正文。\n',expectedDraftRevision:0}),
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const rejected=results.find(r=>r.status==='rejected');
  assert.equal(rejected.reason.code,'REVIEW_DRAFT_STALE');
  const dto=await c.reviewRead({objectId});
  const draft=dto.files.find(f=>f.relPath==='reading.md').draft;
  assert.equal(draft.revision,1);
  assert.ok(['窗口A的正文。\n','窗口B的正文。\n'].includes(draft.text));
  const record=await c.store.storage.getRecovery(c.store.projectId,'managed:review-drafts:'+dto.workId);
  assert.equal(record.files['reading.md'].text,draft.text);
  assert.equal(record.files['reading.md'].history.length,1);
});

test('originalunchanged: draft save writes no worktree, main repo, candidate or model source',async t=>{
  const {c,w,objectId,content,dir}=await fixture(t);
  const candidateBefore=w.execution.candidate.commit;
  const jobsBefore=c.store.state.jobs.length;
  const messagesBefore=c.store.state.messages.length;
  await c.reviewSave({objectId,relPath:'reading.md',text:'人工草稿正文。\n',expectedDraftRevision:0});
  assert.equal(c.store.find(w.id).execution.candidate.commit,candidateBefore);
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),BASELINE_MD);
  assert.equal(await fs.readFile(path.join(dir,'reading.md'),'utf8'),CANDIDATE_MD);
  assert.equal(c.store.state.jobs.length,jobsBefore);
  assert.equal(c.store.state.messages.length,messagesBefore);
  const dto=await c.reviewRead({objectId});
  assert.equal(dto.files.find(f=>f.relPath==='reading.md').candidateText,CANDIDATE_MD);
});

test('continuationlatest: continue needs the latest version, applies exact drafts to the same Work and stales old reports',async t=>{
  const {c,w,objectId,dir}=await fixture(t);
  const outdated=(await c.reviewRead({objectId})).reviewVersion;
  const human='# 阅读\n\n人工确认正文（含标记 HUMAN-REVIEWED）。\n';
  await c.reviewSave({objectId,relPath:'reading.md',text:human,expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  await assert.rejects(c.reviewContinue({objectId,reviewVersion:outdated,requestKey:'cont-stale-1'}),error=>error.code==='REVIEW_VERSION_STALE');
  const result=await c.reviewContinue({objectId,reviewVersion:fresh.reviewVersion,requestKey:'cont-latest-1',instruction:'补充要求：核对标记。'});
  assert.equal(result.accepted,true);
  const job=c.store.state.jobs.find(j=>j.id===result.jobId);
  assert.equal(job.target,w.id);
  assert.equal(job.type,'manual');
  assert.equal(job.context.reviewContinuation.requestKey,'cont-latest-1');
  const after=c.store.find(w.id);
  assert.equal(after.revision,2);
  assert.equal(after.status,'running');
  assert.equal(await fs.readFile(path.join(dir,'reading.md'),'utf8'),human);
  const old=await c.reviewRead({objectId});
  assert.equal(old.stale.code,'SUPERSEDED');
  assert.equal(old.capabilities.canAccept,false);
  assert.equal(old.capabilities.canSave,false);
  assert.equal(old.files.find(f=>f.relPath==='reading.md').editable,false);
  const current=await c.reviewRead({objectId:after.result.objectId});
  assert.equal(current.files.find(f=>f.relPath==='reading.md').draft,null);
  assert.equal(current.files.find(f=>f.relPath==='reading.md').history.length,1);
  const again=await c.reviewContinue({objectId,reviewVersion:fresh.reviewVersion,requestKey:'cont-latest-1',instruction:'补充要求：核对标记。'});
  assert.equal(again.duplicate,true);
  assert.equal(again.jobId,result.jobId);
  assert.equal(c.store.state.jobs.filter(j=>j.target===w.id&&j.type==='manual').length,1);
  assert.equal(await fs.readFile(path.join(dir,'reading.md'),'utf8'),human);
});

test('mergeexact: reviewed accept merges the exact human bytes host-only into the bound main',async t=>{
  const {c,w,objectId,content}=await fixture(t);
  const human='# 阅读\n\n人工最终确认正文 mergeexact。\n';
  await c.reviewSave({objectId,relPath:'reading.md',text:human,expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  const outcome=await c.reviewAccept({objectId,reviewVersion:fresh.reviewVersion,requestKey:'accept-exact-1'});
  assert.equal(outcome.accepted,true);
  assert.equal(outcome.merge.status,'merged');
  assert.equal(outcome.merge.targetRef,'refs/heads/main');
  assert.match(outcome.merge.commit,/^[a-f0-9]{40}$/);
  assert.equal(outcome.merge.actor,'orchestrator');
  assert.equal(outcome.merge.executor,'host');
  const queued=c.store.state.mergeQueue.find(e=>e.workId===w.id);
  assert.equal(queued.status,'done');
  assert.equal(queued.actor,'orchestrator');
  assert.equal(queued.executor,'host');
  assert.equal(queued.reviewVersion,fresh.reviewVersion);
  const done=c.store.find(w.id);
  assert.equal(done.status,'ended');
  assert.equal(done.closure.phase,'complete');
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),human);
  assert.equal(await fs.readFile(path.join(content,'notes.md'),'utf8'),BASELINE_NOTES);
  // 历史读取走完整冻结证据（变更集∪回执引用）：基线正文可用、计数固定，
  // 精确接受令牌与人工绑定精确保留，不依赖已清理的worktree/Git。
  const archived=await c.reviewRead({objectId});
  assert.equal(archived.frozen,true);
  assert.equal(archived.reviewVersion,fresh.reviewVersion);
  assert.equal(archived.accepted.reviewVersion,fresh.reviewVersion);
  const archivedReading=archived.files.find(f=>f.relPath==='reading.md');
  assert.equal(archivedReading.candidateText,CANDIDATE_MD);
  assert.equal(archivedReading.baselineText,BASELINE_MD);
  assert.equal(archivedReading.change,'modified');
  assert.equal(archivedReading.status,'modified');
  assert.equal(archivedReading.added,1);
  assert.equal(archivedReading.deleted,1);
  assert.equal(archivedReading.draft.revision,1);
  assert.equal(archivedReading.draft.text,human);
  assert.equal(archivedReading.humanEdited,true);
  assert.equal(archived.merge.status,'merged');
  const head=(await run('git',['rev-parse','HEAD'],{cwd:content})).stdout.trim();
  assert.equal(head,outcome.merge.commit);
  assert.equal((await run('git',['symbolic-ref','HEAD'],{cwd:content})).stdout.trim(),'refs/heads/main');
  assert.equal((await run('git',['show','HEAD:reading.md'],{cwd:content})).stdout,human);
  assert.match((await run('git',['show','HEAD^:reading.md'],{cwd:content})).stdout,/原始基线正文/);
  const replay=await c.reviewAccept({objectId,reviewVersion:fresh.reviewVersion,requestKey:'accept-exact-1'});
  assert.equal(replay.duplicate,true);
  assert.equal(replay.merge.status,'merged');
});

test('no-auto-commit hold: raw-text no-commit request no longer vetoes — explicit user accept authorizes the local merge',async t=>{
  const {c,w,objectId,content}=await fixture(t,{request:'整理reading.md成markdown，不要提交git'});
  const human='人工最终正文 no-commit。\n';
  await c.reviewSave({objectId,relPath:'reading.md',text:human,expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  // 临时“先不要提交”只是no-auto-commit暂缓：预暴露无结构化约束，接受即授权。
  assert.equal(fresh.mergeConsent.required,false);
  const outcome=await c.reviewAccept({objectId,reviewVersion:fresh.reviewVersion,requestKey:'accept-nocommit-1'});
  assert.equal(outcome.accepted,true);
  assert.equal(outcome.merge.status,'merged');
  const head=(await run('git',['rev-parse','HEAD'],{cwd:content})).stdout.trim();
  assert.equal(head,outcome.merge.commit);
  assert.equal((await run('git',['show','HEAD:reading.md'],{cwd:content})).stdout,human);
  assert.equal(c.store.state.todos.filter(x=>x.workId===w.id&&x.kind==='merge-consent').length,0);
});

test('explicit never-commit input blocks the merge pending a one-time version-bound override',async t=>{
  const {c,w,objectId,content}=await fixture(t,{noCommitInput:true});
  const human='人工最终正文 never-commit。\n';
  await c.reviewSave({objectId,relPath:'reading.md',text:human,expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  assert.equal(fresh.mergeConsent.required,true);
  assert.equal(fresh.mergeConsent.reasonCode,'NO_COMMIT_EXPLICIT');
  assert.equal(fresh.mergeConsent.status,null);
  assert.equal(fresh.capabilities.canAccept,true);
  const outcome=await c.reviewAccept({objectId,reviewVersion:fresh.reviewVersion,requestKey:'accept-never-1'});
  assert.equal(outcome.accepted,true);
  assert.equal(outcome.merge.status,'blocked');
  assert.equal(outcome.merge.blockedCode,'MERGE_CONSENT_REQUIRED');
  assert.equal(outcome.merge.commit,null);
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),BASELINE_MD);
  const done=c.store.find(w.id);
  assert.equal(done.status,'ended');
  assert.equal(done.closure.mergeAuthorization.consentRequired,true);
  assert.equal(done.closure.mergeAuthorization.candidateCommit,w.execution.candidate.commit);
  assert.ok(done.closure.mergeAuthorization.request,'覆盖请求已暴露');
  assert.ok(c.store.state.todos.some(x=>x.workId===w.id&&x.kind==='merge-consent'&&x.status==='open'));
  const row=c.store.state.mergeQueue.find(e=>e.workId===w.id);
  assert.equal(row.status,'blocked');
  assert.equal(row.consentRequired,true);
  // 拒绝路径：资源与决定保留，原请求未改写。
  const denied=await c.resolveMergeConsent(w.id,{requestId:done.closure.mergeAuthorization.request.id,expectedVersion:done.closure.mergeAuthorization.request.version,action:'deny',requestKey:'deny-never-1',binding:{workId:w.id,revision:done.revision,objectId:done.closure.binding.objectId,candidateCommit:done.closure.mergeAuthorization.candidateCommit,reviewVersion:done.closure.mergeAuthorization.reviewVersion,repo:done.closure.mergeAuthorization.repo,targetRef:done.closure.mergeAuthorization.targetRef,targetHead:done.closure.mergeAuthorization.targetHead}});
  assert.equal(denied.status,'denied');
  assert.equal(c.store.find(w.id).closure.merge.blockedCode,'MERGE_CONSENT_DENIED');
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),BASELINE_MD);
  assert.equal(done.request,'整理阅读笔记并产出markdown');
});

test('conflicts: unmanaged drift on the bound target blocks the merge without guessing',async t=>{
  const {c,w,objectId,content}=await fixture(t);
  await fs.writeFile(path.join(content,'notes.md'),'用户在主分支上的外部修改。\n');
  await run('git',['add','notes.md'],{cwd:content});
  await run('git',['-c','user.name=External','-c','user.email=e@x','-c','commit.gpgSign=false','commit','-m','external main change'],{cwd:content});
  await c.reviewSave({objectId,relPath:'reading.md',text:'人工正文 drift。\n',expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  const outcome=await c.reviewAccept({objectId,reviewVersion:fresh.reviewVersion,requestKey:'accept-drift-1'});
  assert.equal(outcome.merge.status,'blocked');
  assert.equal(outcome.merge.blockedCode,'HEAD_DRIFT');
  assert.equal(await fs.readFile(path.join(content,'notes.md'),'utf8'),'用户在主分支上的外部修改。\n');
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),BASELINE_MD);
});

test('merge orchestrator record is durable and re-driven after host restart',async t=>{
  const {c,w,objectId,content,root}=await fixture(t,{noCommitInput:true});
  await c.reviewSave({objectId,relPath:'reading.md',text:'人工正文 restart。\n',expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  const outcome=await c.reviewAccept({objectId,reviewVersion:fresh.reviewVersion,requestKey:'accept-restart-1'});
  assert.equal(outcome.merge.status,'blocked');
  assert.equal(outcome.merge.blockedCode,'MERGE_CONSENT_REQUIRED');
  const firstAttempts=outcome.merge.attempts.length;
  await c.stop();
  const c2=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:content});
  t.after(async()=>{if(!c2.store.closed)await c2.stop().catch(()=>{});});
  const w2=c2.store.find(w.id);
  assert.equal(w2.status,'ended');
  assert.equal(w2.closure.merge.status,'blocked');
  assert.equal(w2.closure.merge.blockedCode,'MERGE_CONSENT_REQUIRED');
  assert.ok(w2.closure.merge.attempts.length>firstAttempts,'重启后宿主续驱合入协调，尝试数递增');
  const queueRow=c2.store.state.mergeQueue.find(e=>e.workId===w.id);
  assert.equal(queueRow.status,'blocked');
  assert.equal(queueRow.executor,'host');
  assert.match(String(queueRow.lastError||''),/一次性批准/);
  const dto=await c2.reviewRead({objectId});
  assert.equal(dto.merge.status,'blocked');
  assert.equal(dto.merge.blockedCode,'MERGE_CONSENT_REQUIRED');
  assert.equal(dto.capabilities.canSave,false);
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),BASELINE_MD);
  assert.equal(dto.mergeConsent.status,'pending');
  assert.equal(dto.mergeConsent.reasonCode,'NO_COMMIT_EXPLICIT');
  await c2.stop();
});

test('drift on any planned file rejects the whole apply with zero writes',async t=>{
  const {c,w,objectId,dir}=await fixture(t);
  await c.reviewSave({objectId,relPath:'reading.md',text:'人工A。\n',expectedDraftRevision:0});
  await c.reviewSave({objectId,relPath:'notes.md',text:'人工B。\n',expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  await fs.writeFile(path.join(dir,'notes.md'),'外部篡改。\n');
  await assert.rejects(c.reviewContinue({objectId,reviewVersion:fresh.reviewVersion,requestKey:'cont-drift-1'}),error=>error.code==='WORKTREE_DRIFT');
  assert.equal(await fs.readFile(path.join(dir,'reading.md'),'utf8'),CANDIDATE_MD);
  assert.equal(await fs.readFile(path.join(dir,'notes.md'),'utf8'),'外部篡改。\n');
  assert.equal(c.store.find(w.id).status,'review');
  assert.equal(c.store.state.jobs.filter(j=>j.target===w.id&&j.type==='manual').length,0);
});

test('symlinked parent directory is rejected without writing outside; pending intent blocks new drafts',async t=>{
  const escape=path.join(os.tmpdir(),'nozeli-review-escape-'+Date.now());
  await fs.mkdir(escape);await fs.writeFile(path.join(escape,'nested.md'),'外部哨兵内容。\n');
  const {c,objectId,dir}=await fixture(t,{prePublish:async workdir=>{await fs.mkdir(path.join(workdir,'docs'),{recursive:true});await fs.writeFile(path.join(workdir,'docs','nested.md'),'嵌套候选正文。\n');}});
  await c.reviewSave({objectId,relPath:'docs/nested.md',text:'人工嵌套修订。\n',expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  await fs.rename(path.join(dir,'docs'),path.join(dir,'docs.real'));
  await fs.symlink(escape,path.join(dir,'docs'));
  await assert.rejects(c.reviewContinue({objectId,reviewVersion:fresh.reviewVersion,requestKey:'cont-symdir-1'}),error=>error.code==='WORKTREE_DRIFT');
  assert.equal(await fs.readFile(path.join(escape,'nested.md'),'utf8'),'外部哨兵内容。\n');
  // 保守契约：存在未收口续作意图时新草稿保存被拒，不暗中改写旧plan语义。
  await assert.rejects(c.reviewSave({objectId,relPath:'reading.md',text:'新草稿。\n',expectedDraftRevision:0}),error=>error.code==='REVIEW_CONTINUE_PENDING');
  await fs.rm(escape,{recursive:true,force:true});
});

test('symlinked file is rejected without writing outside the worktree',async t=>{
  const escape=path.join(os.tmpdir(),'nozeli-review-escape-'+Date.now());
  await fs.mkdir(escape);await fs.writeFile(path.join(escape,'nested.md'),'外部哨兵内容。\n');
  const {c,objectId,dir}=await fixture(t);
  await c.reviewSave({objectId,relPath:'reading.md',text:'人工正文。\n',expectedDraftRevision:0});
  const next=await c.reviewRead({objectId});
  await fs.unlink(path.join(dir,'reading.md'));
  await fs.symlink(path.join(escape,'nested.md'),path.join(dir,'reading.md'));
  await assert.rejects(c.reviewContinue({objectId,reviewVersion:next.reviewVersion,requestKey:'cont-symfile-1'}),error=>error.code==='WORKTREE_DRIFT');
  assert.equal(await fs.readFile(path.join(escape,'nested.md'),'utf8'),'外部哨兵内容。\n');
  await fs.rm(escape,{recursive:true,force:true});
});

test('repeated failed ledger commits never evict the active draft body',async t=>{
  const {c,objectId}=await fixture(t);
  const first='# 阅读\n\n人工确认正文 round1-a。\n';
  await c.reviewSave({objectId,relPath:'reading.md',text:first,expectedDraftRevision:0});
  const original=c.store.reviewSaveState.bind(c.store);
  let fails=0;
  c.store.reviewSaveState=(...args)=>{if(fails++<21)throw Object.assign(Error('injected ledger failure'),{code:'INJECTED'});return original(...args);};
  for(let i=0;i<21;i++)await assert.rejects(c.reviewSave({objectId,relPath:'reading.md',text:'orphan '+i+'\n',expectedDraftRevision:1}),error=>error.code==='INJECTED');
  c.store.reviewSaveState=original;
  const dto=await c.reviewRead({objectId});
  assert.equal(dto.files.find(f=>f.relPath==='reading.md').draft.text,first);
  const after=await c.reviewSave({objectId,relPath:'reading.md',text:'第二次保存。\n',expectedDraftRevision:1});
  assert.equal(after.draftRevision,2);
});

test('continue requestKey replay with a different payload is rejected',async t=>{
  const {c,objectId}=await fixture(t);
  await c.reviewSave({objectId,relPath:'reading.md',text:'人工正文 payload。\n',expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  const first=await c.reviewContinue({objectId,reviewVersion:fresh.reviewVersion,requestKey:'cont-payload-1',instruction:'第一份补充要求。'});
  assert.equal(first.accepted,true);
  await assert.rejects(c.reviewContinue({objectId,reviewVersion:fresh.reviewVersion,requestKey:'cont-payload-1',instruction:'另一份补充要求。'}),error=>error.code==='REVIEW_REQUEST_COLLISION');
});

test('second publication rotates the review namespace and keeps old receipts immutable',async t=>{
  const {c,w,objectId,dir}=await fixture(t);
  const round1='# 阅读\n\n人工确认正文（含标记 HUMAN-REVIEWED）。\n';
  await c.reviewSave({objectId,relPath:'reading.md',text:round1,expectedDraftRevision:0});
  await c.reviewInstructionSave({objectId,text:'第一轮指令草稿。',expectedRevision:0});
  const fresh=await c.reviewRead({objectId});
  const continued=await c.reviewContinue({objectId,reviewVersion:fresh.reviewVersion,requestKey:'cont-round-1'});
  // 真实链路里续作manual回合由Worker执行并在发布下一份报告时收口；
  // fixture直接模拟发布，须同样收口queued job，否则忙碌回合拦截后续指令保存。
  await c.store.mutate(()=>{const job=c.store.state.jobs.find(j=>j.id===continued.jobId);job.status='completed';job.completedAt=new Date().toISOString();});
  const v2='# 阅读\n\nWorker 候选正文 v2（含 HUMAN-REVIEWED）。\n';
  await fs.writeFile(path.join(dir,'reading.md'),v2);
  await c.execution.publish(c.store.find(w.id),{id:'report-job-2'},()=>true);
  await c.store.publish(w.id,2,'result',page('Candidate v2'),'report-2',{jobId:'report-job-2',files:[{relPath:'reading.md'},{relPath:'notes.md'}]});
  await c.store.settle(w.id);
  const receipt2=c.store.state.receipts.find(r=>r.id==='report-2');
  await c.reviewSave({objectId:receipt2.objectId,relPath:'reading.md',text:'第二轮人工草稿。\n',expectedDraftRevision:0});
  const oldDto=await c.reviewRead({objectId});
  assert.equal(oldDto.stale.code,'SUPERSEDED');
  assert.equal(oldDto.files.find(f=>f.relPath==='reading.md').draft,null);
  assert.equal(oldDto.files.find(f=>f.relPath==='reading.md').candidateText,CANDIDATE_MD);
  const newDto=await c.reviewRead({objectId:receipt2.objectId});
  assert.equal(newDto.files.find(f=>f.relPath==='reading.md').draft.text,'第二轮人工草稿。\n');
  assert.equal(newDto.files.find(f=>f.relPath==='reading.md').draft.revision,2);
  assert.equal(newDto.files.find(f=>f.relPath==='reading.md').candidateText,v2);
  const oldInstruction=await c.reviewInstructionRead({objectId});
  assert.equal(oldInstruction.text,'第一轮指令草稿。');
  assert.equal(oldInstruction.revision,1);
  const newInstruction=await c.reviewInstructionRead({objectId:receipt2.objectId});
  assert.equal(newInstruction.revision,0);
  assert.equal(newInstruction.text,'');
  const secondRound=await c.reviewInstructionSave({objectId:receipt2.objectId,text:'第二轮指令草稿。',expectedRevision:0});
  assert.equal(secondRound.revision,1);
  const record=await c.store.storage.getRecovery(c.store.projectId,'managed:review-drafts:'+w.id);
  assert.equal(record.files['reading.md'].history.find(entry=>entry.revision===1).text,round1);
  await assert.rejects(c.reviewInstructionSave({objectId,text:'x',expectedRevision:0}),error=>error.code==='REVIEW_CANDIDATE_STALE');
});

test('human edits to an unchanged file pass through beforeAccept sync and are blocked on unsaved editor changes',async t=>{
  const {c,w,objectId,content}=await fixture(t,{beforeAccept:async(work,files)=>{if(files.includes('notes.md'))throw Object.assign(Error('notes.md 有未保存的编辑器改动，先保存再接受'),{code:'DRAFT_PENDING'});}});
  await c.reviewSave({objectId,relPath:'notes.md',text:'人工修订备注。\n',expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  const outcome=await c.reviewAccept({objectId,reviewVersion:fresh.reviewVersion,requestKey:'accept-union-1'});
  assert.equal(outcome.merge.status,'blocked');
  assert.equal(outcome.merge.blockedCode,'DRAFT_PENDING');
  assert.equal(await fs.readFile(path.join(content,'notes.md'),'utf8'),BASELINE_NOTES);
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),BASELINE_MD);
});

test('human-edited unchanged file is merged and reported in the full file set',async t=>{
  const {c,w,objectId,content}=await fixture(t);
  const humanNotes='人工修订备注 merged。\n';
  await c.reviewSave({objectId,relPath:'notes.md',text:humanNotes,expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  const outcome=await c.reviewAccept({objectId,reviewVersion:fresh.reviewVersion,requestKey:'accept-union-2'});
  assert.equal(outcome.merge.status,'merged');
  const done=c.store.find(w.id);
  assert.deepEqual([...done.closure.git.files].sort(),['notes.md','reading.md']);
  const notesOp=done.closure.git.operations.find(op=>op.relPath==='notes.md');
  assert.equal(notesOp.afterDigest,sha256(Buffer.from(humanNotes)));
  assert.equal(await fs.readFile(path.join(content,'notes.md'),'utf8'),humanNotes);
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),CANDIDATE_MD);
});

test('review instruction drafts are durable, CAS-guarded and scope-validated',async t=>{
  const {c,objectId}=await fixture(t);
  const empty=await c.reviewInstructionRead({objectId});
  assert.equal(empty.revision,0);assert.equal(empty.text,'');
  const saved=await c.reviewInstructionSave({objectId,text:'请补充采样时段说明。',expectedRevision:0});
  assert.equal(saved.revision,1);
  const reread=await c.reviewInstructionRead({objectId});
  assert.equal(reread.text,'请补充采样时段说明。');
  assert.equal(reread.revision,1);
  const originalState=c.store.reviewInstructionState.bind(c.store);
  let injected=0;
  c.store.reviewInstructionState=(...args)=>{if(injected++<1)throw Object.assign(Error('injected'),{code:'INJECTED'});return originalState(...args);};
  await assert.rejects(c.reviewInstructionSave({objectId,text:'失败写入。',expectedRevision:1}),error=>error.code==='INJECTED');
  c.store.reviewInstructionState=originalState;
  const survived=await c.reviewInstructionRead({objectId});
  assert.equal(survived.revision,1);
  assert.equal(survived.text,'请补充采样时段说明。');
  await assert.rejects(c.reviewInstructionSave({objectId,text:'并发覆盖。',expectedRevision:0}),error=>error.code==='REVIEW_INSTRUCTION_STALE');
  const other=await c.store.submit('另一个任务','brief',{name:'Other'});
  await assert.rejects(c.reviewInstructionSave({objectId,text:'伪装。',expectedRevision:0,workId:other.id}),error=>error.code==='REVIEW_OBJECT_UNKNOWN');
  await c.reviewSave({objectId,relPath:'reading.md',text:'人工正文 busy。\n',expectedDraftRevision:0});
  const busyVersion=await c.reviewRead({objectId});
  await c.reviewContinue({objectId,reviewVersion:busyVersion.reviewVersion,requestKey:'cont-busy-1'});
  await assert.rejects(c.reviewInstructionSave({objectId,text:'忙碌期写入。',expectedRevision:1}),error=>error.code==='WORK_BUSY');
});

test('fullunion: complete change set with fixed counts, exact accepted token and archived history',async t=>{
  const admitted=[];
  const binaryFinal=Buffer.from([0,1,2,255]);
  const {c,w,objectId,content}=await fixture(t,{
    seed:async seedRoot=>{await fs.writeFile(path.join(seedRoot,'gone.md'),'即将删除的行1\n即将删除的行2\n');await fs.writeFile(path.join(seedRoot,'img.bin'),Buffer.from([1,2,3]));},
    prePublish:async dir=>{
      await fs.writeFile(path.join(dir,'extra.md'),'新增文件\n第二行\n');   // 未被报告引用的新增
      await fs.rm(path.join(dir,'gone.md'));                              // 未被报告引用的删除
      await fs.writeFile(path.join(dir,'img.bin'),binaryFinal);            // 二进制修改
    },
    beforeAccept:async(work,paths)=>{admitted.push(...paths);},
  });
  const dto=await c.reviewRead({objectId});
  assert.deepEqual(dto.files.map(f=>f.relPath),['extra.md','gone.md','img.bin','notes.md','reading.md']);
  assert.ok(dto.changeSetId&&/^cs_[0-9a-f]{64}$/.test(dto.changeSetId));
  const list=Object.fromEntries(dto.files.map(f=>[f.relPath,f]));
  // 固定计数＝输入基线→冻结候选（numstat）；引用未改如实标0/0，不冒充改动。
  assert.equal(list['reading.md'].status,'modified');
  assert.equal(list['reading.md'].added,1);
  assert.equal(list['reading.md'].deleted,1);
  assert.equal(list['extra.md'].status,'added');
  assert.equal(list['extra.md'].added,2);
  assert.equal(list['extra.md'].deleted,0);
  assert.equal(list['extra.md'].baselineText,null);
  assert.equal(list['extra.md'].candidateText,'新增文件\n第二行\n');
  assert.equal(list['gone.md'].status,'deleted');
  assert.equal(list['gone.md'].change,'removed');
  assert.equal(list['gone.md'].added,0);
  assert.equal(list['gone.md'].deleted,2);
  assert.equal(list['gone.md'].candidateText,null);
  assert.equal(list['gone.md'].baselineText,'即将删除的行1\n即将删除的行2\n');
  // 二进制不给伪造±计数，只给真实原因。
  assert.equal(list['img.bin'].binary,true);
  assert.equal(list['img.bin'].added,null);
  assert.equal(list['img.bin'].deleted,null);
  assert.equal(list['img.bin'].unsupportedReason,'binary');
  assert.equal(list['img.bin'].textOmitted,'binary');
  assert.equal(list['img.bin'].material.candidate.available,false);
  assert.equal(list['img.bin'].material.candidate.reason,'binary');
  assert.equal(list['notes.md'].status,'unchanged');
  assert.equal(list['notes.md'].added,0);
  assert.equal(list['notes.md'].deleted,0);
  assert.equal(list['reading.md'].versions.map(v=>v.kind).join(','),'baseline,candidate');
  // 人工稿另标：计数不随草稿漂移。
  const humanExtra='# 人工新增终稿\n';
  await c.reviewSave({objectId,relPath:'extra.md',text:humanExtra,expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  const freshExtra=fresh.files.find(f=>f.relPath==='extra.md');
  assert.equal(freshExtra.humanEdited,true);
  assert.equal(freshExtra.added,2);
  assert.equal(freshExtra.deleted,0);
  assert.deepEqual(freshExtra.versions.map(v=>v.kind),['candidate','draft']);   // 新增文件无基线版本
  assert.equal(freshExtra.versions.at(-1).actor.kind,'user');
  // 接受：beforeAccept收到的是完整准入并集（含未引用的新增/删除/二进制）。
  const outcome=await c.reviewAccept({objectId,reviewVersion:fresh.reviewVersion,requestKey:'accept-full-union'});
  assert.equal(outcome.merge.status,'merged');
  assert.deepEqual([...new Set(admitted)].sort(),['extra.md','gone.md','img.bin','reading.md']);   // 准入并集=worker改动∪人工草稿；未改未草稿文件不进入整合
  // 冻结历史：完整清单、精确令牌与接受绑定精确保留。
  const archived=await c.reviewRead({objectId});
  assert.equal(archived.frozen,true);
  assert.equal(archived.reviewVersion,fresh.reviewVersion);
  assert.equal(archived.accepted.reviewVersion,fresh.reviewVersion);
  assert.deepEqual(archived.accepted.files.map(f=>f.relPath).sort(),['extra.md','gone.md','img.bin','notes.md','reading.md']);
  const archivedList=Object.fromEntries(archived.files.map(f=>[f.relPath,f]));
  assert.equal(archivedList['gone.md'].status,'deleted');
  assert.equal(archivedList['gone.md'].deleted,2);
  assert.equal(archivedList['gone.md'].baselineText,'即将删除的行1\n即将删除的行2\n');
  assert.equal(archivedList['img.bin'].unsupportedReason,'binary');
  assert.equal(archivedList['extra.md'].draft.revision,1);
  assert.equal(archivedList['extra.md'].draft.text,humanExtra);
  assert.equal(archivedList['extra.md'].humanEdited,true);
  assert.equal(archivedList['reading.md'].baselineText,BASELINE_MD);
  // 磁盘终态：人工新增终稿合入，删除文件不复活。
  assert.equal(await fs.readFile(path.join(content,'extra.md'),'utf8'),humanExtra);
  assert.equal(await fs.readFile(path.join(content,'gone.md'),'utf8').then(()=>true,()=>false),false);
});

test('accepted projection binds to its own publication: accepting B never pollutes historical A',async t=>{
  const {c,w,objectId,dir}=await fixture(t);
  // A轮：人工稿→续作（消费A稿）→Worker发布B。
  await c.reviewSave({objectId,relPath:'reading.md',text:'# 阅读\n\nA轮人工确认正文。\n',expectedDraftRevision:0});
  const aRead=await c.reviewRead({objectId});
  await c.reviewContinue({objectId,reviewVersion:aRead.reviewVersion,requestKey:'cont-accept-b-1'});
  await c.store.mutate(()=>{const job=c.store.state.jobs.find(j=>j.key==='review-continue:cont-accept-b-1');job.status='completed';job.completedAt=new Date().toISOString();});
  const v2='# 阅读\n\nWorker 候选正文 v2。\n';
  await fs.writeFile(path.join(dir,'reading.md'),v2);
  await c.execution.publish(c.store.find(w.id),{id:'report-job-2'},()=>true);
  await c.store.publish(w.id,2,'result',page('Candidate v2'),'report-2',{jobId:'report-job-2',files:[{relPath:'reading.md'},{relPath:'notes.md'}]});
  await c.store.settle(w.id);
  await c.store.mutate(()=>{c.store.state.jobs.push({id:'report-job-2',target:w.id,revision:2,type:'manual',status:'completed'});});
  const receipt2=c.store.state.receipts.find(r=>r.id==='report-2');
  // B轮：人工终稿→接受。
  const humanB='# 阅读\n\nB轮人工终稿。\n';
  await c.reviewSave({objectId:receipt2.objectId,relPath:'reading.md',text:humanB,expectedDraftRevision:0});
  const bRead=await c.reviewRead({objectId:receipt2.objectId});
  const outcome=await c.reviewAccept({objectId:receipt2.objectId,reviewVersion:bRead.reviewVersion,requestKey:'accept-on-b-1'});
  assert.equal(outcome.merge.status,'merged');
  // B：接受投影完整（精确令牌+人工稿）。
  const archivedB=await c.reviewRead({objectId:receipt2.objectId});
  assert.equal(archivedB.reviewVersion,bRead.reviewVersion);
  assert.equal(archivedB.accepted.reviewVersion,bRead.reviewVersion);
  assert.equal(archivedB.files.find(f=>f.relPath==='reading.md').draft.text,humanB);
  // A：历史读取绝不投B的人工稿/B的接受令牌——回到A自身candidate字节与重算令牌。
  const oldA=await c.reviewRead({objectId});
  assert.equal(oldA.accepted,undefined);
  assert.notEqual(oldA.reviewVersion,bRead.reviewVersion);
  const oldAReading=oldA.files.find(f=>f.relPath==='reading.md');
  assert.equal(oldAReading.draft,null);
  assert.equal(oldAReading.candidateText,CANDIDATE_MD);
  assert.equal(oldAReading.humanEdited,false);
  assert.equal(oldA.stale,null);   // 已结束Work不再标stale；隔离由accepted门禁保证
});

test('managed.invoke review.accept dispatches the real orchestrator drain with actor recorded end-to-end',async t=>{
  const {c,w,objectId,content,root}=await fixture(t);
  const human='# 阅读\n\n人工终稿 invoke。\n';
  await c.reviewSave({objectId,relPath:'reading.md',text:human,expectedDraftRevision:0});
  const fresh=await c.reviewRead({objectId});
  const m=new ManagedProjects({userDataDir:path.join(root,'profile'),host:{storage:c.store.storage,requireProject:async()=>({}),requireRegisteredProject:async()=>({})},legacy:{projects:new Map()},openController:async()=>{throw Error('must dispatch to the live controller');}});
  t.after(()=>m.stop().catch(()=>{}));
  m.controllers.set(c.store.projectId,c);
  const outcome=await m.invoke('managed.review.accept',{projectId:c.store.projectId,workId:w.id,objectId,reviewVersion:fresh.reviewVersion,requestKey:'accept-invoke-1'});
  assert.equal(outcome.accepted,true);
  assert.equal(outcome.merge.status,'merged');
  assert.equal(outcome.merge.actor,'orchestrator');
  assert.equal(outcome.merge.executor,'host');
  const row=c.store.state.mergeQueue.find(e=>e.workId===w.id);
  assert.equal(row.status,'done');
  assert.equal(row.actor,'orchestrator');
  assert.equal(row.executor,'host');
  assert.equal(c.store.find(w.id).closure.merge.actor,'orchestrator');
  assert.equal(await fs.readFile(path.join(content,'reading.md'),'utf8'),human);
});
