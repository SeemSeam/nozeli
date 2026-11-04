// Bounded activity and owner-generation regressions. No Pi process is spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createActivityState} from '../../../integrations/pi/src/activity.mjs';
import {PiSession} from '../src/agents/managed/pi-session.mjs';

const spec=()=>({role:'worker',home:'/tmp/nozeli-activity-test',cwd:'/tmp',tools:[]});

test('activity reducer represents overlapping tools, retry, and settlement without payloads',()=>{
 const a=createActivityState({ownerId:'owner-1',epoch:'epoch-1'});
 a.setSessionId('session-1');
 a.observe({event:'native',eventData:{type:'agent_start',sessionId:'session-1'}});
 a.observe({event:'native',eventData:{type:'toolExecutionStarted',sessionId:'session-1',callId:'a',tool:'read',arguments:{secret:'omit'}}});
 a.observe({event:'native',eventData:{type:'toolExecutionStarted',sessionId:'session-1',callId:'b',tool:'bash',arguments:{secret:'omit'}}});
 let snap=a.snapshot();
 assert.equal(snap.runActive,true); assert.equal(snap.toolCount,2); assert.deepEqual(snap.tools.map(x=>x.callId),['a','b']);
 assert.equal(JSON.stringify(snap).includes('secret'),false);
 a.observe({event:'native',eventData:{type:'agent_end',willRetry:true}});
 assert.equal(a.snapshot().retry,true);
 a.observe({event:'native',eventData:{type:'toolExecutionEnded',callId:'a'}});
 a.observe({event:'native',eventData:{type:'runSettled',aborted:false}});
 snap=a.snapshot(); assert.equal(snap.retry,false); assert.equal(snap.runActive,false); assert.equal(snap.toolCount,0);
});

test('PiSession rejects stale owner activity revisions and accepts only monotonic identity',()=>{
 const s=new PiSession(spec());
 const base={ownerId:s.viewOwnerId,ownerGeneration:'generation-1',sessionId:'session-1',activityRevision:2,known:true,busy:true};
 assert.equal(s.acceptActivity(base),true);
 assert.equal(s.acceptActivity({...base,activityRevision:1}),false);
 assert.equal(s.acceptActivity({...base,ownerGeneration:'generation-old',activityRevision:3}),false);
 assert.equal(s.acceptActivity({...base,activityRevision:3,busy:false}),true);
 assert.equal(s.activitySnapshot().busy,false);
 assert.equal(s.acceptActivity({...base,sessionId:'other',activityRevision:4}),false);
});

test('unknown activity cannot be reclaimed as safely idle',async()=>{
 const s=new PiSession(spec());
 s.threadId='session-1'; s.phase='idle';
 await assert.rejects(()=>s.stopIdle(),error=>error.code==='PI_BUSY');
});

test('deferred model failure remains observable with intent identity',async()=>{
 const s=new PiSession(spec()); s.model='p/current';
 s.phase='idle';s.threadId='model-session';s.acceptActivity({ownerId:s.viewOwnerId,ownerGeneration:'model-generation',sessionId:s.threadId,activityRevision:1,known:true,busy:false});
 s.request=async()=>{throw Object.assign(new Error('model refused'),{code:'PI_NO_MODEL'});};
 const events=[];s.on('model-error',error=>events.push(error));
 await assert.rejects(()=>s.applyDefaultModel({selector:'p/next',intentRevision:7,operationId:'op-7'}),error=>error.code==='PI_NO_MODEL');
 assert.equal(events.length,1); assert.equal(events[0].intentRevision,7); assert.equal(events[0].operationId,'op-7');
 assert.equal(s.activitySnapshot().modelError.code,'PI_NO_MODEL');
});

test('post-settlement failure is not confused with preparation or an unconfirmed live run',()=>{const a=createActivityState({ownerId:'o'});a.begin('start');a.end('start');a.begin('prompt');assert.equal(a.snapshot().promptPreparing,true);a.observe({event:'native',eventData:{type:'agent_start'}});assert.equal(a.snapshot().promptPreparing,false);a.observe({event:'native',eventData:{type:'runSettled'}});assert.equal(a.snapshot().settling,true);assert.equal(a.snapshot().promptPreparing,false);a.end('prompt',Error('confirmed provider failure'));assert.equal(a.snapshot().known,true);assert.equal(a.snapshot().busy,false);a.begin('prompt');a.end('prompt',Error('no settlement evidence'));assert.equal(a.snapshot().known,false);});
