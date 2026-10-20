import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {turnMetrics,createTurnMetricsAccumulator} from '../src/agents/managed/turn-metrics.mjs';
import {createTokenUsageCheckpoint,readTokenUsageCheckpoint} from '../src/agents/managed/token-usage-checkpoint.mjs';
const total=n=>({inputTokens:n,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:n});
const usage=n=>({method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:'a',tokenUsage:{total:total(n)}}});
const end=status=>({method:'turn/completed',params:{threadId:'t',turn:{id:'a',status}}});
const options={threadId:'t',turnId:'a',baseline:total(10)};

test('duplicate usage and terminal notifications never double count',()=>{
 const u=usage(30),e=end('completed');
 const m=turnMetrics([u,u,e,e],options);
 assert.deepEqual(m.tokens,total(20));assert.equal(m.tokenStatus,'complete');assert.deepEqual(m.tokenCoverage.unknownReasons,[]);
});
test('out-of-order snapshots remain unknown rather than summing or choosing a guessed maximum',()=>{
 const m=turnMetrics([usage(30),usage(20),usage(40),end('completed')],options);
 assert.equal(m.tokens?.inputTokens??null,null);assert.equal(m.tokens?.totalTokens??null,null);
 assert(m.tokenCoverage.unknownReasons.includes('cumulative-decreased-or-out-of-order'));
});
test('conflicting terminal statuses cannot promote interrupted usage to complete in either order',()=>{
 for(const statuses of [['interrupted','completed'],['completed','interrupted']]){
  const m=turnMetrics([usage(30),...statuses.map(end),end('completed')],options);
  assert.deepEqual(m.tokens,total(20));assert.equal(m.tokenStatus,'partial');assert.equal(m.tokenCoverage.turnStatus,null);
  assert(m.tokenCoverage.unknownReasons.includes('conflicting-provider-terminal'));
 }
});
test('interrupted unchanged counters are unknown with an exact reason, not confirmed zero',()=>{
 const m=turnMetrics([usage(10),end('interrupted')],options);
 assert.equal(m.tokens,null);assert.equal(m.tokenCoverage.zeroConfirmed,false);
 assert.deepEqual(m.tokenCoverage.unknownReasons,['provider-turn-interrupted','unchanged-counters-without-successful-settlement']);
});
test('missing baseline and invalidated baseline have distinct reasons',()=>{
 const a=createTurnMetricsAccumulator({threadId:'t',turnId:'a'});a.observe(usage(30));a.observe(end('completed'));
 assert.equal(a.result().tokens,null);assert.deepEqual(a.result().tokenCoverage.unknownReasons,['baseline-unavailable']);
 a.invalidateBaseline();assert.deepEqual(a.result().tokenCoverage.unknownReasons,['baseline-invalidated']);
});
test('interrupted and failed persisted checkpoints report unverified terminal, never restorable',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-worker3-usage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const status of ['interrupted','failed']){
  const file=path.join(dir,status+'.json'),c=createTokenUsageCheckpoint({threadId:'t',providerVersion:'v',file});
  c.begin({turnId:'a'});c.observe(usage(30));c.observe(end(status));await c.stop({clean:true});
  const r=await readTokenUsageCheckpoint(file,{threadId:'t',providerVersion:'v'});
  assert.equal(r.checkpoint.boundary,'clean-stop-unverified');assert.equal(r.reason,'provider-turn-'+status);assert.equal(r.baseline,null);
 }
});
test('persisted invalid counters preserve precise refusal reason across restart',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-worker3-invalid-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'usage.json'),c=createTokenUsageCheckpoint({threadId:'t',providerVersion:'v',file});
 c.begin({turnId:'a'});c.observe({...usage(30),params:{...usage(30).params,tokenUsage:{total:{inputTokens:30}}}});c.observe(end('completed'));await c.stop({clean:true});
 const r=await readTokenUsageCheckpoint(file,{threadId:'t',providerVersion:'v'});
 assert.equal(r.baseline,null);assert.equal(r.reason,'checkpoint-invalidated:incomplete-or-invalid-usage');
});
