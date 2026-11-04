import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveConversationInput} from '../src/renderer/conversation-input-state.mjs';
import {bindComposerDrafts} from '../src/renderer/surface-identity-state.mjs';
const materials={pending:[{key:'w1',name:'worker.txt',status:'ok',digest:'immutable-worker'}],quote:{text:'original Worker quote'}};
const state={works:[{id:'work',status:'review'}],drafts:{frontdesk:'FRONT',work:'WORK'}};
const frame={conversationInput:{projectId:'a',target:'work'},workspace:{draft:'WORK'},conversationMaterials:{work:materials}};

test('restoring an old Worker recipient opens frontdesk and retains Worker text and materials separately',()=>{
 const before=structuredClone({frame,state}),result=resolveConversationInput({projectId:'a',frame:JSON.parse(JSON.stringify(frame)),state});
 assert.equal(result.target,'frontdesk');assert.equal(result.text,'FRONT');assert.equal(result.materials,undefined);assert.equal(result.reason,'');
 assert.equal(result.retained.target,'work');assert.equal(result.retained.projectId,'a');assert.equal(result.retained.text,'WORK');assert.deepEqual(result.retained.materials,materials);assert.deepEqual({frame,state},before);
});
test('frontdesk canonical empty or newer draft does not lose conflicting window text',()=>{
 const front={conversationInput:{projectId:'a',target:'frontdesk'},workspace:{draft:'WINDOW FRONT'}};
 const local=resolveConversationInput({projectId:'a',frame:front,state,local:'NEW FRONT'});
 assert.equal(local.text,'NEW FRONT');assert.equal(local.retained.text,'WINDOW FRONT');assert.equal(local.retained.target,'frontdesk');
 const empty=resolveConversationInput({projectId:'a',frame:front,state:{...state,drafts:{...state.drafts,frontdesk:''}}});
 assert.equal(empty.text,'');assert.equal(empty.retained.text,'WINDOW FRONT');
});
test('missing, ended, closing and read-only old Worker targets never redirect their draft to frontdesk',()=>{
 for(const works of [[],[{id:'work',status:'ended'}],[{id:'work',status:'closing'}],[{id:'work',status:'review',readOnly:true}]]){
  const result=resolveConversationInput({projectId:'a',frame,state:{...state,works}});
  assert.equal(result.target,'frontdesk');assert.equal(result.text,'FRONT');assert.equal(result.materials,undefined);assert.equal(result.retained.text,'WORK');assert.deepEqual(result.retained.materials,materials);
 }
});
test('cross-project and unbound old input are quarantined rather than copied to the current frontdesk',()=>{
 for(const bad of [{...frame,conversationInput:{projectId:'b',target:'work'}},{workspace:{draft:'OLD WORK'},composerMaterials:materials}]){
  const result=resolveConversationInput({projectId:'a',frame:bad,state});assert.equal(result.target,'frontdesk');assert.equal(result.text,'FRONT');assert.equal(result.materials,undefined);assert(result.retained);assert.equal(result.retained.projectId,bad.conversationInput?.projectId??null);
 }
 const fresh=resolveConversationInput({projectId:'a',frame:{conversationMaterials:{frontdesk:materials}},state});assert.equal(fresh.text,'FRONT');assert.equal(fresh.materials,undefined);
});
test('frontdesk-bound materials remain available independently of legacy Worker materials',()=>{
 const frontMaterials={pending:[{key:'front',name:'front.txt'}]},mixed={...frame,conversationMaterials:{work:materials,frontdesk:frontMaterials}};
 const result=resolveConversationInput({projectId:'a',frame:mixed,state});assert.deepEqual(result.materials,frontMaterials);assert.deepEqual(result.retained.materials,materials);
 const orchestrator=resolveConversationInput({projectId:'a',frame:{conversationInput:{projectId:'a',target:'orchestrator'},workspace:{draft:'ORCH'}},state});assert.equal(orchestrator.target,'frontdesk');assert.equal(orchestrator.text,'FRONT');assert.equal(orchestrator.retained.target,'orchestrator');assert.equal(orchestrator.retained.text,'ORCH');
});
test('unknown input identity cannot persist; queued Work writes retain original target after selection changes',async()=>{
 const composer=new EventTarget();let identity=null;const persisted=[];
 const writer=bindComposerDrafts({composer,current:()=>identity,remember:()=>{},persist:async draft=>persisted.push(draft),onInput:()=>{},onError:error=>{throw error;}});
 composer.value='UNKNOWN';composer.dispatchEvent(new Event('input'));await writer.settled();assert.deepEqual(persisted,[]);
 identity={projectId:'a',target:'work'};composer.value='WORK UPDATE';composer.dispatchEvent(new Event('input'));
 identity={projectId:'a',target:'frontdesk'};composer.value='FRONT UPDATE';composer.dispatchEvent(new Event('input'));await writer.settled();
 assert.deepEqual(persisted,[{projectId:'a',target:'work',text:'WORK UPDATE'},{projectId:'a',target:'frontdesk',text:'FRONT UPDATE'}]);
});
