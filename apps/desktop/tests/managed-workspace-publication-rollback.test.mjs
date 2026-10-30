import {openTestWorkspace} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readManagedState} from '../src/agents/managed/managed-storage.mjs';
import {staticReport} from './static-report.fixture.mjs';

async function fixture(t,{job=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-workspace-rollback-'));
  const store=await openTestWorkspace(path.join(root,'runtime'),path.join(root,'content'));
  const work=await store.submit('原始请求','任务简报',{name:'回滚验证'});
  await store.activate(work.id);
  if(job)await store.mutate(()=>{store.state.jobs=[{id:'job-source',target:work.id,revision:1,status:'completed',text:'源任务文本',context:{}}];});
  t.after(async()=>{await store.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,store,work};
}
const durable=store=>readManagedState(store.storage,store.projectId,{offline:false});
const receipt=(store,id)=>store.storage.getProject(store.projectId,'managed_receipts',id);
async function failedTransaction(store,id){
  const rows=await store.listPending();
  const pending=rows.find(row=>row.kind==='business'&&row.collections.managed_receipts?.some(row=>row.id===id));
  assert.ok(pending,'failed transaction retains its complete candidate collections');
  assert.equal(pending.status,'pending');
  assert.equal(pending.automaticReplay,false);
  assert.equal(pending.requiresConfirmation,true);
  return pending;
}
async function assertStoredReport(store,row){
  assert.match(row.report.digest,/^[a-f0-9]{64}$/);
  const bytes=await store.storage.readObject(store.projectId,row.report.digest);
  assert.ok(bytes.length);
  if(row.report.manifestDigest)await store.storage.readObject(store.projectId,row.report.manifestDigest);
  if(row.snapshot){
    await store.storage.readObject(store.projectId,row.snapshot.manifestDigest);
    for(const file of row.snapshot.files)if(file.objectDigest)await store.storage.readObject(store.projectId,file.objectDigest);
  }
  return bytes;
}
function failCommit(t,store,{after=false,unknown=false}={}){
  const storage=store.storage,original=storage.replaceProjectCollections.bind(storage);
  storage.replaceProjectCollections=async(...args)=>{
    if(after)await original(...args);
    throw Object.assign(new Error('injected project transaction failure'),{
      code:unknown?'STORAGE_RESULT_UNKNOWN':'EINJECTED_COMMIT',
      ...(unknown?{commitUnknown:{projectId:store.projectId}}:{})
    });
  };
  const restore=()=>{storage.replaceProjectCollections=original;};
  t.after(restore);
  return restore;
}

test('publish: rejected project transaction restores state and retains immutable recovery evidence for explicit inspection',async t=>{
  const {store,work}=await fixture(t);
  await fs.writeFile(path.join(store.content,'note.txt'),'artifact bytes');
  const html=staticReport('transaction failure body'),priorState=structuredClone(store.state),priorDisk=await durable(store);
  const restore=failCommit(t,store);
  await assert.rejects(store.publish(work.id,1,'result',html,'receipt-save-fail',{files:[{relPath:'note.txt'}]}),{code:'EINJECTED_COMMIT'});
  restore();
  assert.deepEqual(store.state,priorState);
  assert.deepEqual(await durable(store),priorDisk,'project collections remain atomic');
  assert.equal(await receipt(store,'receipt-save-fail'),null);
  const pending=await failedTransaction(store,'receipt-save-fail');
  const candidate=pending.collections.managed_receipts.find(row=>row.id==='receipt-save-fail').value;
  await assertStoredReport(store,candidate);
  await store.requireOnline();
  const row=await store.publish(work.id,1,'result',html,'receipt-save-fail',{files:[{relPath:'note.txt'}]});
  assert.equal(row.report.digest,candidate.report.digest,'retry deduplicates immutable report bytes');
  const replay=await store.publish(work.id,1,'result',html,'receipt-save-fail',{files:[{relPath:'note.txt'}]});
  assert.equal(replay.objectId,row.objectId);
  assert.equal((await store.storage.listProject(store.projectId,'managed_receipts')).length,1);
  await assertStoredReport(store,row);
});

test('publish: unknown response after project commit retains committed receipt and immutable objects',async t=>{
  const {store,work}=await fixture(t);
  const restore=failCommit(t,store,{after:true,unknown:true});
  await assert.rejects(store.publish(work.id,1,'result',staticReport('committed body'),'receipt-unknown'),error=>error.code==='STORAGE_RESULT_UNKNOWN'&&Boolean(error.commitUnknown));
  restore();
  assert.ok(store.state.receipts.some(row=>row.id==='receipt-unknown'),'unknown acknowledgement must not blindly restore prior in-memory state');
  const row=await receipt(store,'receipt-unknown');
  assert.ok(row,'real transaction committed before the acknowledgement was lost');
  await assertStoredReport(store,row);
  await failedTransaction(store,'receipt-unknown');
  assert.equal((await durable(store)).works.find(row=>row.id===work.id).result.revision,1);
});

test('publish: unknown response without a committed receipt retains candidate evidence without automatic replay',async t=>{
  const {store,work}=await fixture(t);
  const restore=failCommit(t,store,{unknown:true});
  await assert.rejects(store.publish(work.id,1,'result',staticReport('unknown body'),'receipt-unreadable'),error=>error.code==='STORAGE_RESULT_UNKNOWN'&&Boolean(error.commitUnknown));
  restore();
  assert.ok(store.state.receipts.some(row=>row.id==='receipt-unreadable'),'unknown transaction retains the proposed receipt until reconciliation');
  assert.equal(await receipt(store,'receipt-unreadable'),null);
  const pending=await failedTransaction(store,'receipt-unreadable');
  await assertStoredReport(store,pending.collections.managed_receipts.find(row=>row.id==='receipt-unreadable').value);
});

test('deviation: recovery object write failure leaves no business changes or paused work',async t=>{
  const {store,work}=await fixture(t,{job:true});
  const priorState=structuredClone(store.state),priorDisk=await durable(store);
  const original=store.storage.putRecoveryObjectStream.bind(store.storage);
  store.storage.putRecoveryObjectStream=async()=>{throw Object.assign(new Error('injected object write failure'),{code:'EINJECTED_BODY'});};
  try{
    await assert.rejects(store.reportDeviation(work.id,{id:'job-report',revision:1,context:{sourceJobId:'job-source'}},{changedGoal:'新目标',reason:'偏离原因',progress:'已有进展'},'deviation-body'),{code:'EINJECTED_BODY'});
  }finally{store.storage.putRecoveryObjectStream=original;}
  assert.deepEqual(store.state,priorState);
  assert.deepEqual(await durable(store),priorDisk);
  assert.equal(store.deviationHeld(work.id),false);
  const event=await store.reportDeviation(work.id,{id:'job-report',revision:1,context:{sourceJobId:'job-source'}},{changedGoal:'新目标',reason:'偏离原因',progress:'已有进展'},'deviation-body');
  assert.equal(event.status,'pending');
  assert.equal(store.deviationHeld(work.id),true);
  const row=await receipt(store,'deviation-body');
  assert.equal(row.report.format,'markdown');
  assert.match((await assertStoredReport(store,row)).toString(),/偏离原因/);
  assert.equal(row.report.manifestDigest,null,'Markdown problems do not acquire an HTML manifest');
});

test('deviation: rejected project transaction restores state but retains pending problem bytes',async t=>{
  const {store,work}=await fixture(t,{job:true});
  const priorState=structuredClone(store.state),priorDisk=await durable(store),restore=failCommit(t,store);
  await assert.rejects(store.reportDeviation(work.id,{id:'job-report',revision:1,context:{sourceJobId:'job-source'}},{changedGoal:'新目标',reason:'偏离原因',progress:'已有进展'},'deviation-save'),{code:'EINJECTED_COMMIT'});
  restore();
  assert.deepEqual(store.state,priorState);
  assert.deepEqual(await durable(store),priorDisk);
  const pending=await failedTransaction(store,'deviation-save');
  await assertStoredReport(store,pending.collections.managed_receipts.find(row=>row.id==='deviation-save').value);
  assert.equal(store.find(work.id).status,'running');
});

test('retainCandidate: validation precedes capture, rejected transaction rolls back evidence, replay does not recapture',async t=>{
  const {store,work}=await fixture(t),html=staticReport('retain candidate body');
  let calls=0;const discarded=[];
  const retainCandidate=async()=>{calls++;return {changeSetId:'cs-retain-1',rollback:async()=>{discarded.push('cs-retain-1');}};};
  await assert.rejects(store.publish(work.id,1,'result','','receipt-invalid',{retainCandidate}),/invalid publication/);
  assert.equal(calls,0);
  const restore=failCommit(t,store);
  await assert.rejects(store.publish(work.id,1,'result',html,'receipt-retain',{retainCandidate}),{code:'EINJECTED_COMMIT'});
  restore();
  assert.deepEqual(discarded,['cs-retain-1']);
  await store.requireOnline();
  const row=await store.publish(work.id,1,'result',html,'receipt-retain',{retainCandidate});
  assert.equal(row.changeSetId,'cs-retain-1');
  const replay=await store.publish(work.id,1,'result',html,'receipt-retain',{retainCandidate});
  assert.equal(replay.objectId,row.objectId);
  assert.equal(calls,2);
  assert.deepEqual(discarded,['cs-retain-1']);
});

test('retainCandidate rollback is skipped when the project transaction outcome is unknown',async t=>{
  const {store,work}=await fixture(t),discarded=[];
  const restore=failCommit(t,store,{after:true,unknown:true});
  await assert.rejects(store.publish(work.id,1,'result',staticReport('unknown evidence'),'receipt-evidence-present',{retainCandidate:async()=>({changeSetId:'cs-present',rollback:async()=>{discarded.push('cs-present');}})}),error=>error.code==='STORAGE_RESULT_UNKNOWN'&&Boolean(error.commitUnknown));
  restore();
  assert.deepEqual(discarded,[],'possibly committed candidate evidence must never be discarded');
  const row=await receipt(store,'receipt-evidence-present');
  assert.equal(row.changeSetId,'cs-present');
  await assertStoredReport(store,row);
});

test('retainCandidate rollback failure remains attached to the original transaction error',async t=>{
  const {store,work}=await fixture(t),restore=failCommit(t,store);
  await assert.rejects(store.publish(work.id,1,'problem','# problem body\n\n等待用户决定。','receipt-evidence-fail',{retainCandidate:async()=>({rollback:async()=>{throw Object.assign(new Error('discard failed'),{code:'EINJECTED_DISCARD'});}})}),error=>{
    assert.equal(error.code,'EINJECTED_COMMIT');
    assert.equal(error.rollbackFailures?.length,1);
    assert.equal(error.rollbackFailures[0].code,'EINJECTED_DISCARD');
    return true;
  });
  restore();
  assert.equal(await receipt(store,'receipt-evidence-fail'),null);
  const pending=await failedTransaction(store,'receipt-evidence-fail');
  await assertStoredReport(store,pending.collections.managed_receipts.find(row=>row.id==='receipt-evidence-fail').value);
});

test('publish: artifact changed after freeze fails before object writes or candidate capture',async t=>{
  const {store,work}=await fixture(t);
  await fs.writeFile(path.join(store.content,'note.txt'),'frozen bytes');
  const priorDisk=await durable(store);
  let captures=0,activeCalls=0,writes=0;
  const original=store.storage.putObject.bind(store.storage);
  store.storage.putObject=async(...args)=>{writes++;return original(...args);};
  const isActive=async()=>{activeCalls++;if(activeCalls===2)await fs.writeFile(path.join(store.content,'note.txt'),'changed bytes');return true;};
  try{
    await assert.rejects(store.publish(work.id,1,'result',staticReport('artifact flip body'),'receipt-flip',{files:[{relPath:'note.txt'}],isActive,retainCandidate:async()=>{captures++;return {};}}),/artifact changed during publication/);
  }finally{store.storage.putObject=original;}
  assert.equal(captures,0);
  assert.equal(writes,0);
  assert.deepEqual(await durable(store),priorDisk);
});
