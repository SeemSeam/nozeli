import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionStore,sessionMessages,groupSession,followTranscriptTail,updateTranscriptTailLock} from '../src/renderer/session-store.mjs';
const entry=(id,extra={})=>({id,sequence:1,target:'frontdesk',speaker:'agent',text:'reply',source:'native',jobId:'job-1',...extra});
test('frontdesk groups tool events by task without merging user input or unknown history',()=>{
 const entries=[entry('user',{speaker:'user'}),entry('call',{sequence:2,toolCalls:[{id:'read'}]}),entry('result',{sequence:3,speaker:'tool',tool:{output:'source'}}),entry('answer',{sequence:4,text:'final'}),entry('other',{sequence:5,jobId:'job-2'}),entry('unknown',{sequence:6,jobId:null,requestId:null}),entry('host-failure',{sequence:7,speaker:'system',source:'host',text:'Original request failed; no automatic replay'})];
 const rows=groupSession({entries,deltas:[]});
 assert.deepEqual(rows.filter(row=>row.kind==='reply').map(row=>row.entries.map(item=>item.id)),[['call','result','answer','host-failure'],['other']]);
 assert.deepEqual(rows.filter(row=>row.kind==='message').map(row=>row.entry.id),['user','unknown']);
});
test('stream updates coalesce while durable settlement flushes and rejects late ghosts',()=>{
 let queued=null,cancelled=0,published=0;const store=createSessionStore({schedule:callback=>{queued=callback;return()=>cancelled++;}});store.reset('project');store.subscribe(()=>published++);
 store.apply('project',{version:1,entries:[entry('stream',{streaming:true,text:'one'})]});
 store.apply('project',{version:1,entries:[entry('stream',{streaming:true,text:'two'})]});assert.equal(published,0);assert.equal(typeof queued,'function');
 store.apply('project',{version:1,entries:[entry('durable',{replacesId:'stream',streaming:false,text:'complete'})]});
 assert.equal(published,1);assert.equal(cancelled,1);assert.deepEqual(store.getSnapshot().entries.map(e=>e.id),['durable']);
 store.apply('project',{version:1,entries:[entry('durable',{streaming:true,text:'late'})]},{replace:true});assert.equal(store.getSnapshot().entries[0].text,'complete');
});
test('project boundaries reject stale pages and bounded page replacement preserves pinned tag identity',()=>{
 const store=createSessionStore();store.reset('a');const reply=entry('reply');store.apply('a',{version:1,entries:[reply],hasMore:true,nextCursor:'opaque'});store.pin(reply);
 store.apply('a',{version:1,entries:[entry('older')],hasMore:false},{replace:true});assert.deepEqual(store.getSnapshot().entries.map(e=>e.id),['older']);assert.equal(sessionMessages(store.getLookupSnapshot()).find(e=>e.id==='reply').text,reply.text);
 store.reset('b');assert.equal(store.apply('a',{version:1,entries:[reply]}),false);assert.equal(store.has('reply'),false);assert.deepEqual(store.getLookupSnapshot().entries,[]);
});
test('work/job/revision isolates full native rounds; host deltas replace orchestrator narration',()=>{
 const entries=[entry('front'),entry('chat',{target:'orchestrator',text:'I plan to change files'}),entry('error',{target:'orchestrator',speaker:'system',source:'host',error:true,text:'routing failed'}),entry('w1',{target:'work',workId:'work',jobId:'one',revision:1,text:'a'.repeat(50000)}),entry('w2',{target:'work',workId:'work',jobId:'two',revision:2})];
 const rows=groupSession({entries,deltas:[{id:'delta',sequence:3,kind:'work-created',text:'actual host fact'}]},[{id:'r1',workId:'work',jobId:'one',revision:1,changeSetId:'frozen'},{id:'unseen',workId:'other',jobId:'hidden'}]);
 assert.equal(rows.some(row=>row.id==='chat'),false);assert.equal(rows.some(row=>row.id==='error'),true);const workers=rows.filter(row=>row.kind==='worker');assert.equal(workers.length,2);assert.equal(workers[0].entries[0].text.length,50000);assert.equal(workers[0].receipts[0].changeSetId,'frozen');assert.equal(workers[1].receipts.length,0);assert.equal(rows.filter(row=>row.kind==='delta').length,1);
});
test('tail following respects user reading position',()=>{const lock={current:true},element={scrollTop:0,scrollHeight:1000,clientHeight:100};updateTranscriptTailLock(element,lock);followTranscriptTail(element,lock);assert.equal(element.scrollTop,0);element.scrollTop=880;updateTranscriptTailLock(element,lock);followTranscriptTail(element,lock);assert.equal(element.scrollTop,1000);});
test('incremental windows and label caches have explicit count and content budgets',()=>{
 const store=createSessionStore();store.reset('p');
 for(let i=0;i<1000;i++)store.apply('p',{version:1,entries:[entry('e'+i,{sequence:i})],deltas:[{id:'d'+i,sequence:i,text:'fact'}]});
 assert.equal(store.getSnapshot().entries.length,200);assert.equal(store.getSnapshot().deltas.length,200);assert.equal(store.getSnapshot().nextCursor,'before:800');
 for(let i=0;i<100;i++)store.pin(entry('pin'+i));
 assert.equal(store.getLookupSnapshot().entries.filter(e=>e.id.startsWith('pin')).length,64);assert.equal(store.has('pin0'),false);
 store.pin(entry('huge',{text:'x'.repeat(600000)}));assert.equal(store.getLookupSnapshot().entries.find(e=>e.id==='huge').availability,'read-required');
 store.apply('p',{version:1,entries:[entry('giant',{sequence:1001,text:'x'.repeat(3*1024*1024)})]});assert.equal(store.getSnapshot().entries.at(-1).availability,'read-required');
 store.dispose();
});
test('history replaces its window and ignores live incrementals until latest is selected',()=>{
 const store=createSessionStore();store.reset('p');store.apply('p',{version:1,entries:[entry('latest')]});store.setHistoryPage(true);
 store.apply('p',{version:1,entries:[entry('old')],hasMore:true,nextCursor:'before:1'},{replace:true});
 assert.equal(store.apply('p',{version:1,entries:[entry('live')]}),false);assert.deepEqual(store.getSnapshot().entries.map(e=>e.id),['old']);
 store.setHistoryPage(false);store.apply('p',{version:1,entries:[entry('latest-now')]},{replace:true});assert.deepEqual(store.getSnapshot().entries.map(e=>e.id),['latest-now']);store.dispose();
});
test('durable originals exceeding page or pin budgets retain readable success metadata',()=>{
 const store=createSessionStore();store.reset('p');
 const original=entry('long',{text:'界'.repeat(3*1024*1024),durable:true,complete:true,status:'complete',requestId:'native-request',entryId:'native-entry'});
 store.apply('p',{version:1,entries:[original]});
 const message=sessionMessages(store.getSnapshot())[0];
 assert.equal(message.availability,'read-required');assert.equal(message.text,'');assert.equal(message.streaming,false);assert.equal(message.durable,true);assert.equal(message.complete,true);assert.equal(message.status,'complete');assert.match(message.reason,/原文/);
 store.pin({...original,id:'pinned'});const pinned=store.getLookupSnapshot().entries.find(row=>row.id==='pinned');
 assert.equal(pinned.entryId,'native-entry');assert.equal(pinned.requestId,'native-request');assert.equal(pinned.durable,true);
 store.apply('p',{version:1,entries:[{...original,id:'failed-long',failed:true,status:'failed'}]},{replace:true});
 const failure=sessionMessages(store.getSnapshot())[0];
 assert.equal(failure.availability,'read-required');assert.equal(failure.failed,true);assert.equal(failure.status,'failed');
 store.dispose();
});
