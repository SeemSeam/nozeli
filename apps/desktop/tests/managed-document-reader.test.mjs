import test from 'node:test';
import assert from 'node:assert/strict';
import {DocumentReader} from '../src/agents/managed/document-reader.mjs';
import {openTestController} from './project-storage.fixture.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function controllerFixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-read-correction-'));
  const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),projectHome:home=>fs.mkdir(home,{recursive:true}),sessionFactory:()=>{throw Error('read correction must not start a model');}});
  t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});
  const work=await c.store.submit('original request','brief',{name:'Read correction'});
  await c.store.activate(work.id);
  const job={id:'read-job',target:work.id,type:'initial',revision:1,status:'running',documentReader:new DocumentReader()};
  // Reader registries are ephemeral native-turn objects, not durable job state.
  await c.store.mutate(()=>{c.store.state.jobs.push({id:job.id,target:work.id,type:'initial',revision:1,status:'running'});});
  c.current.set(work.id,job);
  const call=(tool,args)=>c.onTool(work.id,{tool,arguments:args,callId:'readonly-call'});
  return {c,job,work,call};
}

test('wrong history tool corrects exact document continuation in the same job with one sanitized repaired bug',async t=>{
  const {c,job,call}=await controllerFixture(t),text='PRIVATE_BODY🙂'.repeat(2500);
  const first=job.documentReader.read(job.documentReader.add({relPath:'PRIVATE_TITLE.txt',text,readHandle:'private-handle',version:'frozen-v1'}));
  const ref=first.value.nextReadRef;assert.ok(ref);assert.equal(first.value.nextTool,'nozeli_document_read');
  const rejected=await call('nozeli_history_read',{readRef:ref,offset:first.value.endOffset});
  assert.equal(rejected.error.code,'READ_TOOL_MISMATCH');assert.equal(rejected.error.nextTool,'nozeli_document_read');assert.equal(rejected.error.readRef,ref);assert.equal(rejected.continueTurn,true);assert.equal(rejected.value,undefined);
  await call('nozeli_history_read',{readRef:ref,offset:first.value.endOffset});
  let bugs=(await c.maintenance.read()).bugs;assert.equal(bugs.length,1);assert.equal(bugs[0].occurrences,2);assert.equal(bugs[0].capability,'same-turn-read-correction');assert.equal(bugs[0].status,'detected');
  const unrelated=job.documentReader.add({relPath:'other.txt',text:'unrelated',version:'v2'});
  await call('nozeli_document_read',{readRef:unrelated});
  assert.equal((await c.maintenance.read()).bugs[0].status,'detected');
  await c.settleReadProtocolFaults(job.target,{tool:'nozeli_document_read',arguments:{readRef:ref}},{ok:true});
  assert.equal((await c.maintenance.read()).bugs[0].status,'detected');
  const fixed=await call('nozeli_document_read',{readRef:ref});assert.equal(fixed.value.text,text.slice(first.value.endOffset,fixed.value.endOffset));
  bugs=(await c.maintenance.read()).bugs;assert.equal(bugs.length,1);assert.equal(bugs[0].status,'repaired');assert.equal(bugs[0].lastOutcome.outcome,'same-turn-read-corrected');assert.equal(bugs[0].attempts.length,0);
  const diagnostic=JSON.stringify([bugs,c.store.state.jobs[0].readProtocolFaults]);assert.doesNotMatch(diagnostic,/PRIVATE_BODY|PRIVATE_TITLE|private-handle/);assert.equal(c.store.state.jobs.length,1);assert.equal(c.sessions.size,0);
  await call('nozeli_history_read',{readRef:ref,offset:first.value.endOffset});assert.equal((await c.maintenance.read()).bugs[0].status,'detected');
  await call('nozeli_document_read',{readRef:ref});assert.equal((await c.maintenance.read()).bugs[0].status,'repaired');assert.equal((await c.maintenance.read()).bugs.length,1);
});

test('stale and foreign refs return logged rejection data without content or correction hints',async t=>{
  const {c,call}=await controllerFixture(t),foreign=new DocumentReader(),ref=foreign.add({relPath:'secret.txt',text:'FOREIGN_CONTENT',version:'private-version'});
  for(const readRef of [ref,'stale-ref'])for(const tool of ['nozeli_document_read','nozeli_history_read']){
    const rejected=await call(tool,{readRef});assert.equal(rejected.ok,false);assert.equal(rejected.continueTurn,true);assert.equal(rejected.error.code,'READ_REF_EXPIRED');assert.equal(rejected.error.readRef,undefined);assert.equal(rejected.error.nextTool,undefined);assert.equal(rejected.value,undefined);assert.equal(rejected.text,undefined);assert.doesNotMatch(JSON.stringify(rejected),/FOREIGN_CONTENT|private-version/);
  }
  assert.equal((await c.maintenance.read()).bugs.length,4);
});

test('returned payload faults log and diagnostic finish failure retains an exact no-replay receipt',async t=>{
  const {c,job,call}=await controllerFixture(t),ref=job.documentReader.add({relPath:'file.txt',text:'frozen body',version:'v1'});
  const rejected=await call('nozeli_document_read',{readRef:ref,relPath:'wrong.txt'});assert.equal(rejected.error.code,'INVALID_PAYLOAD');
  const finish=c.maintenance.finish.bind(c.maintenance);c.maintenance.finish=async()=>{throw Object.assign(Error('diagnostic only'),{code:'EIO'});};
  const fixed=await call('nozeli_document_read',{readRef:ref});assert.equal(fixed.ok,true);assert.equal(fixed.value.text,'frozen body');
  const saved=c.store.state.jobs.find(saved=>saved.id===job.id);assert.equal(saved.readProtocolFaults[0].correctionReceipt.verified,true);assert.equal(saved.readProtocolFaults[0].status,'awaiting-correction');
  c.maintenance.finish=finish;await c.finalizeReadProtocolReceipts(saved);assert.equal((await c.maintenance.read()).bugs[0].status,'repaired');assert.equal(c.store.state.jobs.length,1);
});

test('diagnostic recording storage failures are not disguised as recoverable tool faults',async t=>{
  const {c,call}=await controllerFixture(t);c.maintenance.record=async()=>{throw Object.assign(Error('storage failed'),{code:'EIO'});};
  await assert.rejects(call('nozeli_document_read',{}),{code:'EIO'});
});

test('three same-fault corrections are bounded; fourth logs and enters one technical DEBUG without replay',async t=>{
  const {c,job,call}=await controllerFixture(t);
  for(let attempt=0;attempt<3;attempt++){const rejected=await call('nozeli_history_read',{readRef:'unregistered'});assert.equal(rejected.error.code,'READ_REF_EXPIRED');assert.equal(rejected.continueTurn,true);}
  let exhausted;
  await assert.rejects(call('nozeli_history_read',{readRef:'unregistered'}),error=>{exhausted=error;return error.code==='INTERNAL_READ_CORRECTION_EXHAUSTED'&&error.failureOrigin==='host';});
  let bugs=(await c.maintenance.read()).bugs;assert.equal(bugs.length,1);assert.equal(bugs[0].occurrences,4);assert.equal(c.store.state.jobs.find(saved=>saved.id===job.id).maintenanceBugId,bugs[0].id);assert.equal(c.internalRuntimeFailure(exhausted),true);
  const adopted=await c.recordInternalFailure(job,exhausted);await c.maintenanceEvent(adopted,{schedule:false});await c.maintenanceEvent(adopted,{schedule:false});
  bugs=(await c.maintenance.read()).bugs;assert.equal(bugs.length,1);assert.equal(bugs[0].debug.state,'queued');assert.equal(c.store.state.jobs.filter(saved=>saved.type==='maintenance').length,1);assert.equal(c.store.state.jobs.filter(saved=>saved.target===job.target).length,1);assert.equal(c.sessions.size,0);
});

test('varying refs cannot grow an original job past sixteen faults or reuse an old repaired bug for overflow',async t=>{
  const {c,job,work,call}=await controllerFixture(t),ref=job.documentReader.add({relPath:'private-file.txt',text:'PRIVATE_BODY',version:'v1'});
  await call('nozeli_document_read',{readRef:ref,relPath:'invalid-extra'});await call('nozeli_document_read',{readRef:ref});
  const repaired=(await c.maintenance.read()).bugs[0];assert.equal(repaired.status,'repaired');
  await c.store.mutate(()=>{c.store.state.jobs.find(saved=>saved.id===job.id).maintenanceBugId=repaired.id;});
  for(let index=0;index<15;index++){const rejected=await call('nozeli_history_read',{readRef:'PRIVATE_REF_'+index});assert.equal(rejected.error.code,'READ_REF_EXPIRED');assert.equal(rejected.text,undefined);assert.equal(rejected.value,undefined);}
  assert.equal((await c.maintenance.read()).bugs.length,16);assert.equal(c.store.state.jobs.find(saved=>saved.id===job.id).readProtocolFaults.length,16);
  let overflow;await assert.rejects(call('nozeli_history_read',{readRef:'PRIVATE_REF_overflow'}),error=>{overflow=error;return error.code==='INTERNAL_READ_PROTOCOL_LIMIT'&&error.failureOrigin==='host';});
  assert.equal((await c.maintenance.read()).bugs.length,16);assert.equal(c.store.state.jobs.find(saved=>saved.id===job.id).readProtocolFaults.length,16);assert.equal(c.store.state.jobs.find(saved=>saved.id===job.id).maintenanceBugId,undefined);
  const adopted=await c.recordInternalFailure(job,overflow);assert.notEqual(adopted.id,repaired.id);assert.equal(adopted.error.code,'INTERNAL_READ_PROTOCOL_LIMIT');
  await c.maintenanceEvent(adopted,{schedule:false});await c.maintenanceEvent(adopted,{schedule:false});
  const bugs=(await c.maintenance.read()).bugs;assert.equal(bugs.length,17);assert.equal(bugs.filter(bug=>bug.status==='repaired').length,1);assert.equal(c.store.state.jobs.filter(saved=>saved.type==='maintenance').length,1);assert.equal(c.store.state.jobs.filter(saved=>saved.target===job.target).length,1);assert.equal(c.store.find(work.id).request,'original request');assert.equal(c.sessions.size,0);
  assert.doesNotMatch(JSON.stringify([bugs,c.store.state.jobs.find(saved=>saved.id===job.id).readProtocolFaults]),/PRIVATE_BODY|PRIVATE_REF|private-file/);
});

test('report selector key order has one canonical fault identity without arbitrary deep payload hashing',async t=>{
  const {c,call}=await controllerFixture(t);
  for(const args of [{revision:99,objectId:'missing'},{objectId:'missing',revision:99}]){const rejected=await call('nozeli_report_read',args);assert.equal(rejected.error.code,'INVALID_SELECTOR');}
  const bugs=(await c.maintenance.read()).bugs;assert.equal(bugs.length,1);assert.equal(bugs[0].occurrences,2);assert.equal(bugs[0].status,'detected');
  assert.equal(c.readCorrectionIdentity('nozeli_report_read',{revision:1,objectId:'host-issued'}),c.readCorrectionIdentity('nozeli_report_read',{objectId:'host-issued',revision:1}));
});

test('concurrent invalid reads share the same sixteen-fault admission bound',async t=>{
  const {c,job,call}=await controllerFixture(t);
  const results=await Promise.allSettled(Array.from({length:17},(_,index)=>call('nozeli_history_read',{readRef:'concurrent-'+index})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,16);assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.code==='INTERNAL_READ_PROTOCOL_LIMIT').length,1);assert.equal((await c.maintenance.read()).bugs.length,16);assert.equal(c.store.state.jobs.find(saved=>saved.id===job.id).readProtocolFaults.length,16);assert.equal(c.sessions.size,0);
});

test('document pages bind exact edit identity, metadata and Unicode source positions within serialized allowance',()=>{
  const reader=new DocumentReader(),text=('轨道🙂 "quoted"\n').repeat(7000),version={docId:'draft-42',revision:9,digest:'frozen-digest'};
  const ref=reader.add({relPath:'binary-stars.html',text,readHandle:'opaque-handle',version,buffer:true,authorship:{body:'private ledger body'},changesSinceLastRead:{text:'not model context'}});
  let next=ref,joined='',offset=0;
  while(next){
    const page=reader.read(next,1100);
    assert.ok(Buffer.byteLength(JSON.stringify(page),'utf8')<=1100);
    assert.equal(page.value.offset,offset);assert.equal(page.value.text,text.slice(offset,page.value.endOffset));
    assert.deepEqual(page.value.version,version);assert.equal(page.value.readHandle,'opaque-handle');assert.equal(page.value.buffer,true);
    assert.equal(page.value.authorship,undefined);assert.equal(page.value.changesSinceLastRead,undefined);
    assert.equal(page.continueTurn,true);assert.equal(page.hostControl,undefined);
    assert.equal(page.value.nextTool,'nozeli_document_read');
    joined+=page.value.text;offset=page.value.endOffset;next=page.value.nextReadRef;
  }
  assert.equal(joined,text);assert.equal(offset,text.length);
  assert.throws(()=>new DocumentReader().read(ref,1100),{code:'READ_REF_EXPIRED'});
});

test('metadata alone cannot bypass allowance and denial retains unread position',()=>{
  const reader=new DocumentReader(),ref=reader.add({relPath:'file.txt',text:'🙂tail',readHandle:'h'.repeat(2000),version:'v'});
  assert.throws(()=>reader.read(ref,1000),{code:'HOST_CONTEXT_BUDGET_EXHAUSTED'});
  const page=reader.read(ref,3000);assert.equal(page.value.offset,0);assert.equal(page.value.text,'🙂tail');
});
