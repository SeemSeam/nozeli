import test from 'node:test';
import assert from 'node:assert/strict';
import {NotificationDiagnostics,TurnNotifications} from '../src/agents/managed/notification-retention.mjs';
import {turnMetrics} from '../src/agents/managed/turn-metrics.mjs';

const threadId='thread',turnId='turn';
const delta=(text,id='message',tid=turnId)=>({method:'item/agentMessage/delta',params:{threadId,turnId:tid,itemId:id,delta:text}});
const item=(value,tid=turnId)=>({method:'item/completed',params:{threadId,turnId:tid,item:value}});
const terminal=(status='completed',tid=turnId)=>({method:'turn/completed',params:{threadId,turn:{id:tid,status,items:[]}}});
const usage=(total,tid=turnId)=>({method:'thread/tokenUsage/updated',params:{threadId,turnId:tid,tokenUsage:{total}}});
const count=input=>({inputTokens:input,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:input+2});
test('diagnostics use count and bytes caps, including oversized untrusted identity',()=>{
 const d=new NotificationDiagnostics({maxEvents:3,maxBytes:256});
 for(let i=0;i<30;i++)d.push(delta(String(i)));
 assert(d.length<=3);assert(d.bytes<=256);assert(d.dropped>0);
 const giant={method:'x'.repeat(5000),params:{threadId:'t'.repeat(5000),turnId:'r'.repeat(5000),body:'b'.repeat(10000)}};
 d.push(giant);assert(d.bytes<=256);assert(d.values().at(-1).truncated);assert(d.values().at(-1).originalBytes>20000);
 assert.throws(()=>new NotificationDiagnostics({maxEvents:0}));
});
test('semantic metrics match original batch on invalid/regressing fields and duplicate items',()=>{
 const baseline=count(20),events=[usage(count(25)),usage({...count(30),inputTokens:-1}),usage(count(22)),item({id:'c',type:'commandExecution'}),item({id:'c',type:'commandExecution'}),terminal('failed')];
 const turn=new TurnNotifications({threadId,baseline});turn.confirm(turnId);events.forEach(event=>turn.observe(event));
 assert.deepEqual(turn.metrics.result(),turnMetrics(events,{threadId,turnId,baseline}));assert.equal(turn.metrics.result().tools.commandExecution,1);
});
