import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileReportRecovery} from '../src/agents/managed/report-recovery.mjs';

function fixture(){
 const attempt={sessionId:'thread',requestId:'request',recordConfirmed:true,status:'unknown',facts:[{status:'unknown',reason:'PI_HOST_TOOL_FAILED'}]};
 const old={id:'old',target:'work',revision:1,status:'failed',errorCode:'PI_HOST_TOOL_FAILED',hostToolCode:'HTML_REPORT_INVALID',failureOrigin:'host',collabAttempts:[attempt]};
 const successor={id:'new',target:'work',revision:2,status:'completed',collabAttempts:[{sessionId:'thread',recordConfirmed:true}]};
 const work={id:'work',revision:2,status:'review',threadId:'thread',result:{objectId:'report'}};
 const result={id:'published',workId:'work',revision:2,objectId:'report',kind:'result',sourceJobId:'new',snapshot:{}};
 const todo={id:'recovery',workId:'work',sourceJobId:'old',revision:1,kind:'recovery',status:'open'};
 const entries=[{message:{role:'assistant',content:[{type:'toolCall',name:'nozeli_publish',id:'call',arguments:{kind:'result',content:'<!doctype html><html><body><p>broken</div></body></html>'}}]}},{message:{role:'toolResult',toolName:'nozeli_publish',toolCallId:'call',isError:true}}];
 const records=entries.map((e,i)=>({id:String(i),objectId:'digest'+i,jobId:'old',sequence:i,recordKind:'conversation',sessionId:'thread',requestId:'request'}));
 const c={store:{state:{jobs:[old,successor],works:[work],todos:[todo],receipts:[result]},mutate:async fn=>fn()},timeline:{records:()=>records,object:async r=>entries[Number(r.id)]},changed(){}};
 return {c,old,successor,work,result,todo,entries};
}

test('successful same-thread result settles only the proven older HTML recovery, preserving history and unrelated holds',async()=>{
 const f=fixture(),other={id:'other',kind:'recovery',status:'open',workId:'work',sourceJobId:'unknown',revision:1};f.c.store.state.todos.push(other);
 assert.deepEqual((await reconcileReportRecovery(f.c)).resolved,['recovery']);
 assert.equal(f.todo.status,'resolved');assert.equal(f.todo.resolution.objectId,'report');assert.equal(other.status,'open');assert.equal(f.old.status,'failed');assert.equal(f.work.status,'review');
 assert.deepEqual((await reconcileReportRecovery(f.c)).resolved,[]);
});
for(const [name,change] of [
 ['transport unknown',f=>f.old.collabAttempts[0].facts[0].reason='PI_OWNER_EXIT'],
 ['different native thread',f=>f.successor.collabAttempts[0].sessionId='other'],
 ['no actual result receipt',f=>f.c.store.state.receipts=[]],
 ['valid HTML with another publication failure',f=>f.entries[0].message.content[0].arguments.content='<!doctype html><html><body><p>valid</p></body></html>'],
 ['parallel unknown effect',f=>f.entries[0].message.content.push({type:'toolCall',name:'nozeli_document_apply',id:'write'})],
 ['wrong final tool',f=>f.entries[1].message.toolName='nozeli_document_apply'],
 ['wrong revision',f=>f.todo.revision=0],
 ['historical result',f=>f.work.result.objectId='newer'],
])test(name+' keeps recovery blocking',async()=>{const f=fixture();change(f);assert.deepEqual((await reconcileReportRecovery(f.c)).resolved,[]);assert.equal(f.todo.status,'open');});

test('publication change during evidence read cannot clear an old hold',async()=>{
 const f=fixture(),object=f.c.timeline.object;f.c.timeline.object=async r=>{const v=await object(r);if(r.id==='1')f.work.result.objectId='replacement';return v;};
 assert.deepEqual((await reconcileReportRecovery(f.c)).resolved,[]);assert.equal(f.todo.status,'open');
});
