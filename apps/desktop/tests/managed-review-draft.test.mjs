import test from 'node:test';
import assert from 'node:assert/strict';
import {createReviewDraft} from '../src/renderer/managed-review-draft.mjs';

test('draft CAS serializes edits arriving during a save without losing new text',async()=>{
 const calls=[];let finish;
 const draft=createReviewDraft({text:'published',revision:4,save:request=>{calls.push(request);return calls.length===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve({revision:6});}});
 draft.setText('human one');const saving=draft.flush();await Promise.resolve();draft.setText('human two');finish({revision:5});await saving;
 assert.deepEqual(calls,[{text:'human one',revision:4},{text:'human two',revision:5}]);assert.equal(draft.snapshot().text,'human two');assert.equal(draft.snapshot().dirty,false);
});
test('conflict preserves human draft and original CAS token; no automatic overwrite',async()=>{
 let calls=0;const conflict=Error('CAS changed');
 const draft=createReviewDraft({text:'frozen',revision:2,save:async()=>{calls++;throw conflict;}});
 draft.setText('human');await assert.rejects(draft.flush(),/CAS changed/);draft.setText('human recovered');await assert.rejects(draft.flush(),/CAS changed/);
 assert.equal(calls,1);assert.equal(draft.snapshot().revision,2);assert.equal(draft.snapshot().text,'human recovered');assert.equal(draft.snapshot().dirty,true);
});
test('independent project drafts do not share text or CAS identity',async()=>{
 const saved=[];const a=createReviewDraft({text:'a',revision:0,save:async r=>{saved.push(['project-a',r]);return {revision:1};}}),b=createReviewDraft({text:'b',revision:7,save:async r=>{saved.push(['project-b',r]);return {revision:8};}});
 a.setText('A');b.setText('B');await Promise.all([a.flush(),b.flush()]);assert.deepEqual(saved,[['project-a',{text:'A',revision:0}],['project-b',{text:'B',revision:7}]]);assert.equal(a.snapshot().revision,1);assert.equal(b.snapshot().revision,8);
});
test('undo back to persisted content needs no redundant save',async()=>{
 let calls=0;const draft=createReviewDraft({text:'original',revision:1,save:async()=>{calls++;return {revision:2};}});draft.setText('edit');draft.setText('original');await draft.flush();assert.equal(calls,0);
});
