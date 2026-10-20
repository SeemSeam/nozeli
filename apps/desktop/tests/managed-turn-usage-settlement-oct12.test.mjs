import test from 'node:test';
import assert from 'node:assert/strict';
import {tokenBreakdown,tokenFields,turnMetrics} from '../src/agents/managed/turn-metrics.mjs';

const usage=(input=20,output=5)=>({inputTokens:input,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:output,reasoningOutputTokens:0,totalTokens:input+output});
const update=(total,{threadId='thread',turnId='turn',last=usage(999,999)}={})=>({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{total,last}}});
const completed=(status='completed',threadId='thread',turnId='turn')=>({method:'turn/completed',params:{threadId,turn:{id:turnId,status}}});
const options={threadId:'thread',turnId:'turn',fresh:true};
const measure=(events,extra={})=>turnMetrics(events,{...options,...extra});

test('complete settlement differences cumulative totals, not last requests or duplicate snapshots',()=>{
  const baseline=usage(100,20),end=usage(160,35),event=update(end);
  const metrics=measure([update(usage(130,25)),event,event,completed()],{baseline});
  assert.deepEqual(metrics.tokens,usage(60,15));
  assert.equal(metrics.tokenStatus,'complete');
  assert.equal(metrics.tokenSource,'provider-cumulative-delta');
  assert.deepEqual(metrics.tokenCoverage.knownFields,tokenFields);
  assert.deepEqual(metrics.tokenCoverage.unknownFields,[]);
  assert.equal(metrics.tokenCoverage.baselineSource,'observed');
  assert.equal(metrics.tokenCoverage.usageUpdates,3);
  assert.equal(metrics.tokenCoverage.settled,true);
});

test('missing required counters are null, with partial coverage even at successful completion',()=>{
  const total=usage();delete total.cachedInputTokens;delete total.reasoningOutputTokens;
  const metrics=measure([update(total),completed()]);
  assert.equal(metrics.tokenStatus,'partial');
  assert.equal(metrics.tokens.inputTokens,20);
  assert.equal(metrics.tokens.cachedInputTokens,null);
  assert.equal(metrics.tokens.reasoningOutputTokens,null);
  assert.deepEqual(metrics.tokenCoverage.unknownFields,['cachedInputTokens','reasoningOutputTokens']);
  assert.equal(tokenBreakdown(total).cachedInputTokens,null);
});

test('Codex optional cache-write schema default is distinct from missing required usage',()=>{
  const total=usage();delete total.cacheWriteInputTokens;
  const metrics=measure([update(total),completed()]);
  assert.equal(metrics.tokenStatus,'complete');
  assert.equal(metrics.tokens.cacheWriteInputTokens,0);
  assert.equal(metrics.tokenCoverage.cacheWriteDefaulted,true);
  assert.equal(tokenBreakdown({}),null);
  assert.equal(tokenBreakdown({cacheWriteInputTokens:null}),null);
});

test('missing usage, last-only usage, unknown resumed baseline and malformed baselines are unavailable',()=>{
  for(const events of [[],[completed()],[update(undefined),completed()]]){
    const metrics=measure(events);
    assert.equal(metrics.tokens,null);assert.equal(metrics.tokenStatus,'unavailable');
  }
  const resumed=measure([update(usage()),completed()],{fresh:false});
  assert.equal(resumed.tokens,null);assert.equal(resumed.tokenCoverage.baselineSource,'unavailable');
  assert.equal(measure([update(usage()),completed()],{baseline:{}}).tokens,null);
  assert.equal(measure([update(usage()),completed()],{baseline:'invalid'}).tokens,null);
});

test('partial cumulative baseline never becomes zero for unknown fields',()=>{
  const baseline=tokenBreakdown({inputTokens:10,outputTokens:2});
  const metrics=measure([update(usage(20,5)),completed()],{baseline});
  assert.equal(metrics.tokenStatus,'partial');
  assert.equal(metrics.tokens.inputTokens,10);assert.equal(metrics.tokens.outputTokens,3);
  assert.equal(metrics.tokens.totalTokens,null);assert.equal(metrics.tokens.cachedInputTokens,null);
  assert.deepEqual(metrics.tokenCoverage.invalidFields,[]);
});

test('interrupted, failed and uncompleted turns retain positive observations only as partial',()=>{
  for(const status of ['interrupted','failed',null]){
    const metrics=measure([update(usage()),...(status?[completed(status)]:[])]);
    assert.equal(metrics.tokenStatus,'partial');assert.deepEqual(metrics.tokens,usage());
    assert.equal(metrics.tokenCoverage.turnStatus,status);
    assert.equal(metrics.tokenCoverage.settled,status!==null);
  }
});

test('unchanged interrupted or in-flight usage is not zero-cost success',()=>{
  for(const status of ['interrupted','failed',null]){
    const baseline=usage();
    const metrics=measure([update(baseline),...(status?[completed(status)]:[])],{baseline});
    assert.equal(metrics.tokens,null);assert.equal(metrics.tokenStatus,'unavailable');
    assert.equal(metrics.tokenCoverage.zeroConfirmed,false);
  }
});

test('genuine complete zero usage is retained on fresh and resumed threads',()=>{
  for(const baseline of [undefined,usage()]){
    const metrics=measure([update(baseline??usage(0,0)),completed()],{baseline});
    assert.deepEqual(metrics.tokens,usage(0,0));assert.equal(metrics.tokenStatus,'complete');
    assert.equal(metrics.tokenCoverage.zeroConfirmed,true);
  }
});

test('invalid counters are isolated and cannot be silently repaired by later snapshots',()=>{
  for(const invalid of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'20']){
    const total={...usage(),cacheWriteInputTokens:invalid};
    const metrics=measure([update(total),update(usage()),completed()]);
    assert.equal(metrics.tokenStatus,'partial');assert.equal(metrics.tokens.cacheWriteInputTokens,null);
    assert.deepEqual(metrics.tokenCoverage.invalidFields,['cacheWriteInputTokens']);
  }
  const metrics=measure([update(usage()),completed()],{baseline:{...usage(0,0),outputTokens:-1}});
  assert.equal(metrics.tokens.outputTokens,null);assert.equal(metrics.tokens.inputTokens,20);
});

test('decreasing counters from baseline or between snapshots remain unknown despite recovery',()=>{
  const metrics=measure([update(usage(30,8)),update(usage(20,8)),update(usage(40,10)),completed()]);
  assert.equal(metrics.tokenStatus,'partial');assert.equal(metrics.tokens.inputTokens,null);
  assert.equal(metrics.tokens.totalTokens,null);assert.equal(metrics.tokens.outputTokens,10);
  assert.deepEqual(metrics.tokenCoverage.decreasingFields,['inputTokens','totalTokens']);
  assert.equal(measure([update(usage(1,1))],{baseline:usage(50,10)}).tokens,null);
});

test('a missing final snapshot does not promote stale earlier usage to complete',()=>{
  const metrics=measure([update(usage()),update(undefined),completed()]);
  assert.equal(metrics.tokens,null);assert.equal(metrics.tokenStatus,'unavailable');
  const total=usage();delete total.outputTokens;
  const partial=measure([update(usage()),update(total),completed()]);
  assert.equal(partial.tokenStatus,'partial');assert.equal(partial.tokens.outputTokens,null);
});

test('foreign turns and threads cannot settle this turn or contribute tools and usage',()=>{
  const item=(threadId,turnId,id)=>({method:'item/completed',params:{threadId,turnId,item:{id,type:'commandExecution'}}});
  const own=item('thread','turn','one');
  const metrics=measure([update(usage()),update(usage(1000,1000),{threadId:'foreign'}),completed('completed','thread','foreign'),completed('completed','foreign'),own,own,item('thread','foreign','two')]);
  assert.equal(metrics.tokenStatus,'partial');assert.equal(metrics.tokenCoverage.settled,false);
  assert.deepEqual(metrics.tokens,usage());assert.deepEqual(metrics.tools,{commandExecution:1});
});
