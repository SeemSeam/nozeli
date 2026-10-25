import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveConversationInput} from '../src/renderer/conversation-input-state.mjs';
import {bindComposerDrafts} from '../src/renderer/surface-identity-state.mjs';
const materials={pending:[{key:'w1',name:'worker.txt',status:'ok',digest:'immutable-worker'}],quote:{text:'original Worker quote'}};
const state={works:[{id:'work',status:'review'}],drafts:{frontdesk:'FRONT',work:'WORK'}};
const frame={conversationInput:{projectId:'a',target:'work'},workspace:{draft:'WORK'},conversationMaterials:{work:materials}};

test('reload recovers original Work text, immutable materials and quote without frontdesk fallback',()=>{
 const result=resolveConversationInput({projectId:'a',frame:JSON.parse(JSON.stringify(frame)),state});
 assert.equal(result.target,'work');assert.equal(result.text,'WORK');assert.deepEqual(result.materials,materials);assert.equal(result.reason,'');
});
test('newer captured draft and explicit empty canonical draft retain conflicting window text separately',()=>{
 const local=resolveConversationInput({projectId:'a',frame,state,local:'NEW WORK'});
 assert.equal(local.text,'NEW WORK');assert.equal(local.retained.text,'WORK');assert.equal(local.retained.target,'work');
 const empty=resolveConversationInput({projectId:'a',frame,state:{...state,drafts:{...state.drafts,work:''}}});
 assert.equal(empty.text,'');assert.equal(empty.retained.text,'WORK');
});
test('missing, ended, closing and read-only targets keep source text and materials blocked',()=>{
 for(const works of [[],[{id:'work',status:'ended'}],[{id:'work',status:'closing'}],[{id:'work',status:'review',readOnly:true}]]){
  const result=resolveConversationInput({projectId:'a',frame,state:{...state,works}});
  assert.equal(result.target,'work');assert.equal(result.text,'WORK');assert.deepEqual(result.materials,materials);assert(result.reason);
 }
});
test('cross-project identity and legacy unbound text never become sendable frontdesk input',()=>{
 for(const bad of [{...frame,conversationInput:{projectId:'b',target:'work'}},{workspace:{draft:'OLD WORK'},composerMaterials:materials}]){
  const result=resolveConversationInput({projectId:'a',frame:bad,state});assert(result.reason);assert.notEqual(result.text,'FRONT');
 }
 const fresh=resolveConversationInput({projectId:'a',frame:{conversationMaterials:{frontdesk:materials}},state});
 assert.equal(fresh.text,'FRONT');assert.equal(fresh.materials,undefined);
});
test('unknown input identity cannot persist; queued Work writes retain original target after selection changes',async()=>{
 const composer=new EventTarget();let identity=null;const persisted=[];
 const writer=bindComposerDrafts({composer,current:()=>identity,remember:()=>{},persist:async draft=>persisted.push(draft),onInput:()=>{},onError:error=>{throw error;}});
 composer.value='UNKNOWN';composer.dispatchEvent(new Event('input'));await writer.settled();assert.deepEqual(persisted,[]);
 identity={projectId:'a',target:'work'};composer.value='WORK UPDATE';composer.dispatchEvent(new Event('input'));
 identity={projectId:'a',target:'frontdesk'};composer.value='FRONT UPDATE';composer.dispatchEvent(new Event('input'));await writer.settled();
 assert.deepEqual(persisted,[{projectId:'a',target:'work',text:'WORK UPDATE'},{projectId:'a',target:'frontdesk',text:'FRONT UPDATE'}]);
});
