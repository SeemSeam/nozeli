import test from 'node:test';
import assert from 'node:assert/strict';
import {createFactChannel} from '../../../integrations/pi/src/facts.mjs';
const assistant=(id,text,usage,error)=>({type:'entry_appended',entry:{id,type:'message',message:{role:'assistant',content:[{type:'text',text}],usage,...(error?{stopReason:'error',errorMessage:error}:{stopReason:'stop'})}}});
test('successful native retry supersedes the failed assistant outcome without losing usage',()=>{
 const facts=createFactChannel({send(){}});facts.beginTurn({requestId:'request',turnId:'turn',sessionId:'session'});
 facts.onNativeSessionEvent({sessionId:'session'},assistant('failed','',{input:5,output:1,totalTokens:6},'upstream overloaded'));
 assert.equal(facts.state.turnErrorMessage,'upstream overloaded');
 facts.onNativeSessionEvent({sessionId:'session'},assistant('recovered','Final successful answer',{input:10,output:3,totalTokens:13}));
 assert.equal(facts.state.turnErrorMessage,null);assert.equal(facts.state.lastAssistantText,'Final successful answer');assert.equal(facts.state.turnUsage.input,15);assert.equal(facts.state.turnUsage.output,4);
});
test('durable entry identity prevents usage double counting and next turns reset the accounting',()=>{
 const facts=createFactChannel({send(){}}),ref={sessionId:'session'};facts.beginTurn({requestId:'first'});
 const first=assistant('one','Tools requested',{input:11,output:2,cost:{input:0.11,output:0.02,total:0.13}});facts.onNativeSessionEvent(ref,first);facts.onNativeSessionEvent(ref,first);
 facts.onNativeSessionEvent(ref,assistant('two','Verified answer',{input:7,output:3,cost:{input:0.07,output:0.03,total:0.1}}));
 assert.equal(facts.state.turnUsage.input,18);assert.equal(facts.state.turnUsage.output,5);assert.equal(facts.state.turnUsage.cost.total,0.23);
 facts.endTurn();facts.beginTurn({requestId:'second'});facts.onNativeSessionEvent(ref,assistant('three','New answer',{input:2,output:1}));assert.equal(facts.state.turnUsage.input,2);
 facts.failTurn('terminal storage failure');assert.equal(facts.state.turnErrorMessage,'terminal storage failure');
});
test('delivery facts carry redacted metadata only and bind to the active turn',()=>{
 const frames=[];const facts=createFactChannel({send:frame=>frames.push(frame)});
 facts.setSessionId('session');
 facts.beginTurn({requestId:'request-delivery',turnId:'turn-delivery',sessionId:'session'});
 facts.delivery({type:'nozeliDelivery',phase:'prepared',text:{bytes:5,sha256:'abc',entryId:null,verbatim:null},projection:{bytes:9,sha256:'def',llmCalls:0,persisted:false}});
 facts.endTurn();
 facts.delivery({type:'nozeliCompaction',contextEpoch:'compaction:1:e1',compactionEntryId:'e1'});
 const delivery=frames.find(frame=>frame.eventData?.type==='nozeliDelivery');
 assert.equal(delivery.eventData.phase,'prepared');
 assert.equal(delivery.eventData.requestId,'request-delivery');
 assert.equal(delivery.eventData.turnId,'turn-delivery');
 assert.equal(delivery.eventData.sessionId,'session');
 assert.equal(JSON.stringify(delivery.eventData).includes('user text'),false,'no user text may ride delivery facts');
 const compaction=frames.find(frame=>frame.eventData?.type==='nozeliCompaction');
 assert.equal(compaction.eventData.sessionId,'session');
 assert.equal(compaction.eventData.requestId,undefined,'compaction facts are turn-independent');
});
