import {openTestController} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {closeoutPresentation} from '../src/renderer/session-presentation.mjs';
import {managedWorkRecords} from '../src/domain/managed-work-records.mjs';


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

test('discussion task state exposes exact lineage and no other Work or provider secrets',async t=>{
  const {c,w,objectId}=await fixture(t);
  await c.store.mutate(()=>{
    w.sourceJob='intake-original';w.brief='mutable brief';
    c.store.state.jobs.push({id:'intake-original',type:'intake',target:'orchestrator',status:'completed',context:{boundWorkId:w.id,userGoal:'secret prompt',provider:{apiKey:'SECRET'}},routing:{action:'dispatch',workId:w.id}},
      {id:'unrelated',type:'intake',target:'orchestrator',status:'completed',context:{boundWorkId:'foreign-work',userGoal:'FOREIGN'}});
    c.store.state.messages.push({id:'request-original',target:'frontdesk',taskRequestId:'intake-original',jobId:'intake-original',speaker:'user',text:'原始请求'},
      {id:'foreign-message',target:'foreign-work',jobId:'unrelated',speaker:'user',text:'FOREIGN'});
  });
  const dto=await c.reviewDiscussionRead({objectId});
  assert.ok(dto.taskFrame.entries.some(entry=>entry.id==='request-original'));
  assert.deepEqual(dto.taskState.works.map(work=>work.id),[w.id]);
  assert.ok(dto.taskState.jobs.some(job=>job.id==='intake-original'));
  assert.equal(dto.taskState.jobs.some(job=>job.id==='unrelated'),false);
  assert.equal(JSON.stringify(dto).includes('SECRET'),false);assert.equal(JSON.stringify(dto).includes('FOREIGN'),false);
  assert.equal(JSON.stringify(dto).includes('mutable brief'),false);
  const version=await c.reviewRead({objectId});
  await c.store.mutate(()=>{w.revision=2;w.brief='another mutable brief';});
  const old=await c.reviewDiscussionRead({objectId});
  assert.equal(old.readingObject.objectId,objectId);assert.equal(old.readingObject.revision,1);
  assert.deepEqual(old.taskFrame,dto.taskFrame);assert.ok(old.reasons.includes('REVIEW_CANDIDATE_STALE'));
  assert.equal(version.objectId,objectId);
});

test('missing originals remain missing and large originals use the timeline field reader',async t=>{
  const {c,w,objectId}=await fixture(t);
  const empty=await c.reviewDiscussionRead({objectId});
  assert.equal(empty.taskFrame.entries.some(entry=>entry.id.startsWith('work-request:')||entry.id.startsWith('work-handoff:')),false);
  const text='原始长文😀'.repeat(50000);
  await c.store.mutate(()=>{c.store.state.messages.push({id:'large-original',target:w.id,speaker:'user',text});});
  const dto=await c.reviewDiscussionRead({objectId});
  assert.ok(Buffer.byteLength(JSON.stringify(dto.taskFrame))<1024*1024);
  const descriptor=await c.timeline.read('large-original');
  assert.ok(descriptor.read);
  let offset=0,actual='';
  do{
    const page=await c.timeline.read('large-original',{version:descriptor.read.version,field:'text',offset,limit:4096});
    actual+=page.content;offset=page.nextOffset;
  }while(offset!==null);
  assert.equal(actual,text);
});

test('oversized required ancestry fails explicitly instead of truncating the original lineage',async t=>{
  const {c,w,objectId}=await fixture(t);
  await c.store.mutate(()=>{
    let previous=null;
    for(let index=0;index<1300;index++){
      const id='ancestor-'+index+'-'+('x'.repeat(450));
      c.store.state.jobs.push({id,type:'intake',target:'orchestrator',status:'completed',context:{boundWorkId:w.id,...(previous?{retryOf:previous}:{})}});
      previous=id;
    }
    w.sourceJob=previous;
  });
  const jobIds=c.store.state.jobs.map(job=>job.id);
  await assert.rejects(c.reviewDiscussionRead({objectId,limit:1}),{code:'TASK_READING_STATE_LIMIT'});
  assert.deepEqual(c.store.state.jobs.map(job=>job.id),jobIds);
  assert.equal(w.result.objectId,objectId);
});

test('task state preserves registered decisions and real closure steps without guessing completion',async t=>{
  const {c,w,objectId}=await fixture(t);
  await c.store.mutate(()=>{
    w.status='closing';w.outcome='accept';
    w.closure={decision:'accept',revision:w.revision,requestKey:'exact-decision-key',binding:{workId:w.id,objectId,revision:w.revision,candidateCommit:w.execution?.candidate?.commit??null},phase:'blocked',stopped:true,report:{digest:'a'.repeat(64)},git:{complete:false},workerHome:{cleaned:false}};
    w.closure.error='合入遇到已记录冲突';
  });
  const blocked=await c.reviewDiscussionRead({objectId});
  assert.deepEqual(closeoutPresentation(blocked.taskState.works[0],1),closeoutPresentation(w,1));
  assert.equal(closeoutPresentation(blocked.taskState.works[0],1).status,'blocked');
  await c.store.mutate(()=>{w.status='ended';w.closure.phase='complete';w.closure.completedAt='2026-11-09T00:00:00Z';w.closure.git.complete=true;w.closure.workerHome.cleaned=true;});
  const ended=await c.reviewDiscussionRead({objectId});
  assert.deepEqual(closeoutPresentation(ended.taskState.works[0],1),closeoutPresentation(w,1));
  assert.equal(closeoutPresentation(ended.taskState.works[0],1).status,'complete');
});

test('scoped task state matches main task deviation, maintenance and blocked presentation without provider context',async t=>{
  const {c,w,objectId}=await fixture(t);
  const phase=state=>managedWorkRecords(state).find(record=>record.workId===w.id).phase;
  await c.store.mutate(()=>{w.status='paused';w.deviation={status:'pending',todoId:'deviation-todo',sourceJobId:'source-job',sourceText:'触发范围确认',changedGoal:'变更目标',reason:'需要确认范围',progress:'已保存进展',sourceContext:{apiKey:'PRIVATE'}};});
  const deviation=await c.reviewDiscussionRead({objectId});
  assert.equal(phase(deviation.taskState),phase(c.store.state));
  assert.equal(deviation.taskState.works[0].deviation.reason,w.deviation.reason);
  assert.equal(JSON.stringify(deviation.taskState).includes('PRIVATE'),false);
  await c.store.mutate(()=>{
    delete w.deviation;w.maintenance={status:'repairing',bugId:'task-bug',debugState:'queued',message:'系统正在处理已记录故障'};
    c.store.state.jobs.push({id:'task-repair',type:'maintenance',target:'orchestrator',status:'running',context:{bugId:'task-bug',provider:{apiKey:'PRIVATE'}}});
  });
  const maintenance=await c.reviewDiscussionRead({objectId});
  assert.equal(phase(maintenance.taskState),phase(c.store.state));
  assert.ok(maintenance.taskState.jobs.some(job=>job.id==='task-repair'));
  assert.equal(JSON.stringify(maintenance.taskState).includes('PRIVATE'),false);
  await c.store.mutate(()=>{c.store.state.backstageEvents=[{id:'bound-block',workId:w.id,status:'blocked',revision:w.revision,kind:'recovery',reason:'宿主已记录阻断'},{id:'foreign-block',workId:'other-work',status:'blocked',reason:'FOREIGN'}];});
  const blocked=await c.reviewDiscussionRead({objectId});
  assert.equal(phase(blocked.taskState),phase(c.store.state));
  assert.equal(blocked.taskState.backstageEvents.some(event=>event.id==='foreign-block'),false);
});

test('old closure snapshots disclose missing decision history rather than inventing events',async t=>{
  const {c,w,objectId}=await fixture(t);
  await c.store.mutate(()=>{w.status='closing';w.outcome='accept';w.closure={phase:'blocked',decision:'accept',revision:w.revision,requestKey:'legacy-decide-key',binding:{workId:w.id,revision:w.revision,objectId,candidateCommit:w.execution?.candidate?.commit??null}};});
  await c.store.mutate(()=>{c.store.state.sessionIndex.deltas=c.store.state.sessionIndex.deltas.filter(delta=>!delta.kind.startsWith('review-'));});
  const dto=await c.reviewDiscussionRead({objectId});
  assert.equal(dto.taskState.projection.missingDecisionHistory,true);
  assert.equal(dto.taskState.projection.reviewFacts,'recorded-transitions-only');
  assert.equal(dto.taskFrame.deltas.some(delta=>delta.kind.startsWith('review-')),false);
});
