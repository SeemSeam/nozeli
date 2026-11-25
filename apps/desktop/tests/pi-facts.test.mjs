import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const integration=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');
const {createFactChannel}=await import(pathToFileURL(path.join(integration,'src/facts.mjs')));
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

const updateEvent=text=>({type:'message_update',message:{role:'assistant',content:[{type:'text',text}]}});
const updateFrames=frames=>frames.filter(frame=>frame.eventData?.type==='message_update');

test('large synthetic streamed code coalesces instead of amplifying the transport',()=>{
 const frames=[];let clock=1000;
 const facts=createFactChannel({send:frame=>frames.push(frame),now:()=>clock,schedule:()=>()=>{}});
 const ref={sessionId:'session'};
 facts.beginTurn({requestId:'request-stream',turnId:'turn-stream',sessionId:'session'});
 facts.onNativeSessionEvent(ref,{type:'message_start',message:{role:'assistant',content:[]}});
 const chunk='x'.repeat(256*1024);const TOTAL=1000;
 for(let i=0;i<TOTAL;i++)facts.onNativeSessionEvent(ref,updateEvent(chunk+'#'+i));
 facts.onNativeSessionEvent(ref,{type:'message_end',message:{role:'assistant',content:[{type:'text',text:chunk+'#'+(TOTAL-1)}]}});
 const updates=updateFrames(frames);
 assert.equal(updates.length,2,'one leading snapshot plus the boundary flush, regardless of stream volume');
 assert.equal(updates[0].eventData.message.content[0].text,chunk+'#0');
 assert.equal(updates[1].eventData.message.content[0].text,chunk+'#'+(TOTAL-1),'the latest update is the one preserved before message_end');
 assert.deepEqual(frames.map(frame=>frame.eventData?.type),['message_start','message_update','message_update','message_end']);
 const bytes=updates.reduce((sum,frame)=>sum+Buffer.byteLength(JSON.stringify(frame)),0);
 const naive=TOTAL*(chunk.length+64);
 assert.ok(naive>64*1024*1024,`fixture must exceed the 64MiB custody limit when forwarded naively (${naive} bytes)`);
 assert.ok(bytes<3*chunk.length&&bytes<64*1024*1024,`transport stayed bounded: ${bytes} bytes instead of ${naive}`);
 assert.ok(updates.every(frame=>!('assistantEvent' in frame.eventData)),'the duplicate-full-message assistantEvent field must not ride message_update frames');
});

test('coalescing forwards at most one snapshot per window and each sent snapshot is the then-latest',()=>{
 const frames=[];let clock=0;
 const facts=createFactChannel({send:frame=>frames.push(frame),now:()=>clock,schedule:()=>()=>{}});
 const ref={sessionId:'session'};
 facts.beginTurn({requestId:'request-cadence',turnId:'turn-cadence',sessionId:'session'});
 for(let i=0;i<10;i++){clock=i*25;facts.onNativeSessionEvent(ref,updateEvent('t'+i));}
 facts.onNativeSessionEvent(ref,{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'t9'}]}});
 assert.deepEqual(updateFrames(frames).map(frame=>frame.eventData.message.content[0].text),['t0','t2','t4','t6','t8','t9']);
});

test('pending snapshots flush before entry, tool, new-stream and agent_end boundaries with byte-exact durable entries',()=>{
 const frames=[];const facts=createFactChannel({send:frame=>frames.push(frame),now:()=>0,schedule:()=>()=>{}});
 const ref={sessionId:'session'};
 facts.beginTurn({requestId:'request-bounds',turnId:'turn-bounds',sessionId:'session'});
 facts.onNativeSessionEvent(ref,{type:'message_start',message:{role:'assistant',content:[]}});
 facts.onNativeSessionEvent(ref,updateEvent('a1'));
 facts.onNativeSessionEvent(ref,updateEvent('a2'));
 const entry={id:'entry-final',type:'message',message:{role:'assistant',content:[{type:'text',text:'Final'}],usage:{input:1,output:1}}};
 facts.onNativeSessionEvent(ref,{type:'entry_appended',entry});
 facts.onNativeSessionEvent(ref,updateEvent('b1'));
 facts.onNativeSessionEvent(ref,{type:'tool_execution_start',toolCallId:'call-1',toolName:'read',args:{path:'a.txt'}});
 facts.onNativeSessionEvent(ref,updateEvent('c1'));
 facts.onNativeSessionEvent(ref,{type:'message_start',message:{role:'assistant',content:[]}});
 facts.onNativeSessionEvent(ref,updateEvent('d1'));
 facts.onNativeSessionEvent(ref,{type:'agent_end',messages:[]});
 assert.deepEqual(frames.map(frame=>frame.event==='entry'?'entry':frame.eventData.type),['message_start','message_update','message_update','entry','message_update','toolExecutionStarted','message_update','message_start','message_update','agent_end']);
 assert.deepEqual(updateFrames(frames).map(frame=>frame.eventData.message.content[0].text),['a1','a2','b1','c1','d1']);
 const entryFrame=frames.find(frame=>frame.event==='entry');
 assert.equal(JSON.stringify(entryFrame.entry),JSON.stringify(entry),'durable entry bytes stay exact');
 assert.equal(entryFrame.seq,1);
 const newStreamIndex=frames.findIndex(frame=>frame.eventData?.type==='message_start'&&frame.eventData.streamId==='request-bounds:2');
 const flushedC1=updateFrames(frames)[3];
 assert.ok(newStreamIndex>0&&frames.indexOf(flushedC1)<newStreamIndex,'the closing stream\'s snapshot precedes the new stream');
 assert.equal(flushedC1.eventData.streamId,'request-bounds:1');
});

test('endTurn flushes the closing turn snapshot with its own identity and nothing leaks across turns',()=>{
 const frames=[];const facts=createFactChannel({send:frame=>frames.push(frame),now:()=>0,schedule:()=>()=>{}});
 const ref={sessionId:'session'};
 facts.beginTurn({requestId:'ra',turnId:'ta',sessionId:'session'});
 facts.onNativeSessionEvent(ref,{type:'message_start',message:{role:'assistant',content:[]}});
 facts.onNativeSessionEvent(ref,updateEvent('one'));
 facts.onNativeSessionEvent(ref,updateEvent('two'));
 facts.endTurn();
 const afterFirst=frames.length;
 facts.endTurn();
 assert.equal(frames.length,afterFirst,'endTurn with nothing pending emits nothing');
 facts.beginTurn({requestId:'rb2',turnId:'tb',sessionId:'session'});
 facts.onNativeSessionEvent(ref,{type:'message_start',message:{role:'assistant',content:[]}});
 facts.onNativeSessionEvent(ref,updateEvent('n1'));
 facts.onNativeSessionEvent(ref,updateEvent('n2'));
 facts.endTurn();
 const updates=updateFrames(frames);
 assert.deepEqual(updates.map(frame=>frame.eventData.message.content[0].text),['one','two','n1','n2']);
 assert.deepEqual(updates.map(frame=>[frame.eventData.streamId,frame.eventData.turnId]),[['ra:1','ta'],['ra:1','ta'],['rb2:1','tb'],['rb2:1','tb']]);
 const firstNextTurn=frames.findIndex(frame=>frame.eventData?.turnId==='tb');
 assert.ok(frames.slice(firstNextTurn).every(frame=>frame.eventData?.turnId!=='ta'&&frame.eventData?.streamId!=='ra:1'),'no closing-turn frame may appear after the next turn begins');
});

test('a coalesced snapshot self-flushes within one window via a cancellable timer',()=>{
 const frames=[];let clock=0;const timers=[];let handles=0;
 const schedule=(run,ms)=>{const handle={id:++handles,run,ms,cancelled:false};timers.push(handle);return()=>{handle.cancelled=true;};};
 const facts=createFactChannel({send:frame=>frames.push(frame),now:()=>clock,schedule});
 const ref={sessionId:'session'};
 facts.beginTurn({requestId:'request-timer',turnId:'turn-timer',sessionId:'session'});
 facts.onNativeSessionEvent(ref,{type:'message_start',message:{role:'assistant',content:[]}});
 facts.onNativeSessionEvent(ref,updateEvent('u1'));
 facts.onNativeSessionEvent(ref,updateEvent('u2'));
 assert.equal(timers.length,1,'exactly one window timer regardless of coalesced volume');
 assert.equal(timers[0].ms,50,'staleness is bounded to one window');
 assert.equal(timers[0].cancelled,false);
 facts.onNativeSessionEvent(ref,updateEvent('u3'));
 assert.equal(timers.length,1,'replacing the pending snapshot does not reschedule the window');
 clock=50;timers[0].run();
 assert.deepEqual(updateFrames(frames).map(frame=>frame.eventData.message.content[0].text),['u1','u3'],'the timer flush carries the newest snapshot');
 facts.onNativeSessionEvent(ref,updateEvent('u4'));
 assert.equal(timers.length,2,'the timer flush counts as a send, so the next update coalesces again');
 assert.equal(updateFrames(frames).length,2);
 facts.onNativeSessionEvent(ref,{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'u4'}]}});
 assert.equal(timers[1].cancelled,true,'a boundary flush cancels the window timer');
 timers[1].run();
 assert.deepEqual(updateFrames(frames).map(frame=>frame.eventData.message.content[0].text),['u1','u3','u4']);
 assert.equal(frames.at(-1).eventData.type,'message_end','a cancelled late fire stays inert');
});

test('streaming plus endTurn leaves no timers pending with the production scheduler',()=>{
 const facts=createFactChannel({send(){}});
 facts.beginTurn({requestId:'request-timers',turnId:'turn-timers',sessionId:'session'});
 facts.onNativeSessionEvent({sessionId:'session'},{type:'message_start',message:{role:'assistant',content:[]}});
 facts.onNativeSessionEvent({sessionId:'session'},updateEvent('partial'));
 facts.onNativeSessionEvent({sessionId:'session'},updateEvent('more'));
 facts.endTurn();
 assert.equal(typeof process.getActiveResourcesInfo,'function');
 assert.equal(process.getActiveResourcesInfo().filter(kind=>kind==='Timeout').length,0,'endTurn must cancel the pending window timer');
});
