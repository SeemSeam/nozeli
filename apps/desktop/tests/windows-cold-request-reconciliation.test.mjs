import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reconcileColdRequests as reconcile} from '../src/platform/windows/cold-request-reconciliation.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const text='原始输入 😀',launch={schema:1,ownerId:'owner',generation:'epoch',launchId:'launch'};
 const entry={id:'user',parentId:null,type:'message',message:{role:'user',content:[{type:'text',text}]}};
 const request={id:'rpc',method:'prompt',params:{requestId:'request',job:{id:'job'},text}};
 const response={id:'rpc',method:'prompt',ownerLaunch:launch,result:{completion:'provider-completed',nativeEntry:{id:'user',contentDigest:sha(text),persisted:true},delivery:{requestId:'request',jobId:'job',sessionId:'session',phase:'native-record-confirmed',text:{entryId:'user',sha256:sha(text),bytes:Buffer.byteLength(text),verbatim:true}}}};
 const event={event:'entry',sessionId:'session',requestId:'request',jobId:'job',entry};
 return {requests:[request],transcript:[event,response],entries:[entry],sessionId:'session',launch};
}
test('a completed runtime result requires exact original Unicode bytes and the matching persisted user event',()=>{
 const f=fixture(),before=structuredClone(f),result=reconcile(f);assert.equal(result.turns[0].state,'native-result-confirmed');
 assert.equal(result.businessSettlementQualified,false);assert.equal(result.turns[0].businessSettlementQualified,false);assert.equal(result.automaticReplay,false);assert.deepEqual(f,before);
});
test('missing result after persisted input remains unknown and cannot authorize resend',()=>{
 const f=fixture();f.transcript.pop();const result=reconcile(f);assert.equal(result.turns[0].state,'execution-unknown');assert.deepEqual(result.unansweredRpcIds,['rpc']);assert.equal(result.turns[0].automaticReplay,false);
});
for(const change of ['digest','job','entry','method','launch','user-event'])test(`changed ${change} evidence refuses a completed original request`,()=>{
 const f=fixture(),response=f.transcript[1];
 if(change==='digest')response.result.delivery.text.sha256='0'.repeat(64);
 if(change==='job')response.result.delivery.jobId='other';
 if(change==='entry')response.result.nativeEntry.id='other';
 if(change==='method')response.method='recover';
 if(change==='launch')response.ownerLaunch={...f.launch,generation:'other'};
 if(change==='user-event')f.transcript[0].requestId='other';
 assert.throws(()=>reconcile(f),{code:'HOST_REQUEST_BINDING_CHANGED'});
});
test('unanswered host tools and delivered tool replies both retain business-effect uncertainty',()=>{
 for(const replied of [false,true]){
  const f=fixture();f.transcript.splice(1,0,{event:'tool',id:'tool-rpc',tool:'write',requestId:'request',arguments:{text:'synthetic'}});
  if(replied)f.requests.push({id:'tool-rpc',result:{ok:true}});
  const result=reconcile(f);assert.equal(result.turns[0].hostToolsRequireReconciliation,true);assert.equal(result.tools[0].replyObserved,replied);assert.equal(result.tools[0].businessEffectQualified,false);assert.deepEqual(result.unresolvedToolIds,replied?[]:['tool-rpc']);
 }
});
test('orphan and duplicated tool replies cannot be interpreted as original tool results',()=>{
 const f=fixture();f.requests.push({id:'foreign',result:{ok:true}});assert.throws(()=>reconcile(f),{code:'HOST_REQUEST_BINDING_CHANGED'});
 f.transcript.unshift({event:'tool',id:'foreign',tool:'write'});f.requests.push({id:'foreign',result:{ok:true}});assert.throws(()=>reconcile(f),{code:'HOST_REQUEST_BINDING_CHANGED'});
});
test('duplicate prompt identities or responses are rejected rather than selecting a winner',()=>{
 const f=fixture();f.requests.push({...f.requests[0],id:'second'});assert.throws(()=>reconcile(f),{code:'HOST_REQUEST_BINDING_CHANGED'});
 const g=fixture();g.transcript.push(g.transcript[1]);assert.throws(()=>reconcile(g),{code:'HOST_REQUEST_BINDING_CHANGED'});
});
test('materials, image annotations, projection and aborted turns do not inherit plain-input completion qualification',()=>{
 for(const mode of ['materials','images','projection','aborted']){
  const f=fixture();if(mode==='aborted')f.transcript[1].result.completion='aborted';else f.requests[0].params[mode]=mode==='images'?[{type:'image'}]:{};
  const result=reconcile(f);assert.notEqual(result.turns[0].state,'native-result-confirmed');assert.equal(result.turns[0].automaticReplay,false);
 }
});
