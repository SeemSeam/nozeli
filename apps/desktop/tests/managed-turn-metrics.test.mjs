import test from 'node:test';import assert from 'node:assert/strict';import {turnMetrics} from '../src/agents/managed/turn-metrics.mjs';
const count=(input,cached,output)=>({inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:0,outputTokens:output,reasoningOutputTokens:0,totalTokens:input+output});
const update=(total,last,turnId='turn')=>({method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId,tokenUsage:{total,last}}});
test('whole turn includes all requests and deduplicates cumulative updates',()=>{
 const baseline=count(100,50,10),end=count(350,200,40);
 const e=update(end,count(150,100,20));
 const metrics=turnMetrics([update(count(200,100,20),count(100,50,10)),e,e,update(count(10000,0,1),count(1,0,1),'foreign')],{threadId:'thread',turnId:'turn',baseline});
 assert.deepEqual(metrics.tokens,count(250,150,30));assert.equal(metrics.tokenSource,'provider-cumulative-delta');
});
test('missing provider usage and unobserved resumed baseline remain unknown',()=>{
 assert.equal(turnMetrics([],{threadId:'thread',turnId:'turn',fresh:true}).tokens,null);
 assert.equal(turnMetrics([update(count(250,150,30),count(50,0,1))],{threadId:'thread',turnId:'turn'}).tokens,null);
});
test('fresh thread usage and unique tool items remain scoped to their own turn',()=>{
 const item={method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'command',type:'commandExecution'}}};
 const m=turnMetrics([update(count(50,0,10),count(50,0,10)),item,item],{threadId:'thread',turnId:'turn',fresh:true});
 assert.deepEqual(m.tokens,count(50,0,10));assert.deepEqual(m.tools,{commandExecution:1});
});
test('decreasing counters cannot produce negative usage',()=>{
 assert.equal(turnMetrics([update(count(1,0,1),count(1,0,1))],{threadId:'thread',turnId:'turn',baseline:count(50,0,10)}).tokens,null);
});


test('unchanged counters at interruption are unavailable, never zero-cost success',()=>{
 const baseline=count(50,0,10);assert.equal(turnMetrics([update(baseline,baseline)],{threadId:'thread',turnId:'turn',baseline}).tokens,null);
});

