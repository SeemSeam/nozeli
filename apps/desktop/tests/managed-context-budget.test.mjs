import test from 'node:test';import assert from 'node:assert/strict';
import {HostContextBudget} from '../src/agents/managed/context-budget.mjs';
const nearFull=(bytes)=>Buffer.from('x'.repeat(bytes),'utf8');
test('run budget resets only on a newly admitted run; generation budget persists across runs',()=>{
  const b=new HostContextBudget({runHostTextMaxBytes:1000,generationHostTextMaxBytes:1500,receiptReserveBytes:200});
  b.beginRun({target:'w',runId:'r1',epoch:'e1'});
  assert.equal(b.charge('w',900,{kind:'host-text'}).ok,true);
  b.endRun('w');
  b.beginRun({target:'w',runId:'r2',epoch:'e1'});
  assert.equal(b.run('w').usedBytes,0,'new admitted run resets the run scope');
  assert.equal(b.epochUsed('e1'),900,'generation scope keeps accumulating');
  const refused=b.charge('w',700,{kind:'host-text'});
  assert.equal(refused.ok,false,'run scope refuses beyond its own cap');
  assert.equal(refused.remainingRun,1000);
  assert.equal(b.charge('w',700,{kind:'host-text'}).ok,false,'an ended run keeps its cap; only a newly admitted run resets it');
});
test('generation cap binds across runs and a new compaction epoch starts fresh',()=>{
  const b=new HostContextBudget({runHostTextMaxBytes:100000,generationHostTextMaxBytes:1000,receiptReserveBytes:100});
  b.beginRun({target:'w',runId:'r1',epoch:'e1'});b.charge('w',600,{kind:'host-text'});b.endRun('w');
  b.beginRun({target:'w',runId:'r2',epoch:'e1'});
  assert.equal(b.charge('w',500,{kind:'host-text'}).ok,false,'generation cap refuses even in a fresh run');
  b.endRun('w');
  b.beginRun({target:'w',runId:'r3',epoch:'e2'});
  assert.equal(b.charge('w',500,{kind:'host-text'}).ok,true,'confirmed compaction epoch resets the generation scope');
  assert.equal(b.snapshot('w').epoch.epoch,'e2');
});
test('read allowance always keeps the receipt reserve and refuses at exhaustion',()=>{
  const b=new HostContextBudget({runHostTextMaxBytes:1000,generationHostTextMaxBytes:100000,receiptReserveBytes:200});
  b.beginRun({target:'w',runId:'r1',epoch:'e1'});
  assert.equal(b.readAllowance('w'),800);
  b.charge('w',700,{kind:'host-text'});
  assert.equal(b.readAllowance('w'),100);
  b.charge('w',100,{kind:'tool-read'});
  assert.equal(b.readAllowance('w'),0,'no more body reads once only the reserve remains');
});
test('effect receipt reservation refuses rather than execute unreceiptable effects',()=>{
  const b=new HostContextBudget({runHostTextMaxBytes:1000,generationHostTextMaxBytes:100000,receiptReserveBytes:200});
  b.beginRun({target:'w',runId:'r1',epoch:'e1'});
  b.charge('w',900,{kind:'host-text'});
  assert.equal(b.reserveReceipt('w'),false,'700+200 would exceed the 1000 run cap');
  b.endRun('w');b.beginRun({target:'w',runId:'r2',epoch:'e1'});
  assert.equal(b.reserveReceipt('w'),true);
  assert.equal(b.run('w').usedBytes,200);
  assert.equal(b.reserveReceipt('w'),true,'each effect reserves its own receipt space');
  assert.equal(b.run('w').usedBytes,400);
});
test('epoch usage hydrates from durable state and persists back for restart continuity',()=>{
  const persisted={'e1':500};
  const b=new HostContextBudget({runHostTextMaxBytes:100000,generationHostTextMaxBytes:1000},persisted);
  assert.equal(b.epochUsed('e1'),500);
  b.beginRun({target:'w',runId:'r1',epoch:'e1'});b.charge('w',100,{kind:'host-text'});
  assert.deepEqual(b.persistedEpochs(),{'e1':600});
});
test('mid-run compaction rotation keeps the run scope and starts a fresh generation',()=>{
  const b=new HostContextBudget({runHostTextMaxBytes:2000,generationHostTextMaxBytes:1000,receiptReserveBytes:100});
  b.beginRun({target:'w',runId:'r1',epoch:'proj:thread-1:gen0'});
  b.charge('w',800,{kind:'host-text'});
  assert.equal(b.remainingGeneration('proj:thread-1:gen0'),200);
  assert.equal(b.rotateEpoch('w','proj:thread-1:gen1'),true);
  assert.equal(b.rotateEpoch('w','proj:thread-1:gen1'),false,'rotation is idempotent');
  assert.equal(b.run('w').epoch,'proj:thread-1:gen1');
  assert.equal(b.run('w').usedBytes,800,'run usage survives rotation');
  assert.equal(b.remainingGeneration('proj:thread-1:gen1'),1000,'fresh generation allowance');
  assert.equal(b.remainingGeneration('proj:thread-1:gen0'),200,'the superseded epoch keeps its recorded usage');
  assert.equal(b.charge('w',900,{kind:'host-text'}).ok,true,'later charges are never capped by the superseded epoch');
});
test('unrelated threads and new native sessions never share a generation scope',()=>{
  const b=new HostContextBudget({runHostTextMaxBytes:100000,generationHostTextMaxBytes:1000,receiptReserveBytes:100});
  // Exhaust the frontdesk thread's own generation scope.
  b.beginRun({target:'frontdesk',runId:'r1',epoch:'proj:thread-frontdesk:gen0'});
  assert.equal(b.charge('frontdesk',1000,{kind:'host-text'}).ok,true);
  b.endRun('frontdesk');
  b.beginRun({target:'frontdesk',runId:'r2',epoch:'proj:thread-frontdesk:gen0'});
  assert.equal(b.charge('frontdesk',200,{kind:'host-text'}).ok,false,'the same thread keeps its generation total across runs');
  b.endRun('frontdesk');
  // A different native thread has a completely independent allowance.
  b.beginRun({target:'orchestrator',runId:'r1',epoch:'proj:thread-orchestrator:gen0'});
  assert.equal(b.charge('orchestrator',900,{kind:'host-text'}).ok,true,'a different thread has an independent scope');
  b.endRun('orchestrator');
  // A new native session of the same role (new thread identity) starts fresh.
  b.beginRun({target:'frontdesk',runId:'r3',epoch:'proj:thread-frontdesk-2:gen0'});
  assert.equal(b.charge('frontdesk',900,{kind:'host-text'}).ok,true,'a new native session starts a fresh generation scope');
});
