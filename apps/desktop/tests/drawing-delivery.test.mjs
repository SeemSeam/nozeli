import test from 'node:test';
import assert from 'node:assert/strict';
import {appendDrawingMaterial, mergeDrawingMaterials} from '../src/domain/drawing-delivery.mjs';
const delivery={type:'drawing-material',projectId:'project-a',target:'frontdesk',deliveryId:'drawing-delivery-1',attachment:{projectId:'project-a',instanceId:'instance-a',storage:'recovery',name:'截图.png',mime:'image/png',size:123,digest:'a'.repeat(64),kind:'image',source:'drawing'},sources:[]};

test('delivery appends without replacing text, quote or existing immutable materials',()=>{
 const before={text:'new text',pending:[{key:'old',digest:'old'}],quote:{text:'original quote'}};
 const after=appendDrawingMaterial(before,delivery);
 assert.equal(after.text,before.text);assert.equal(after.quote,before.quote);assert.equal(after.pending[0],before.pending[0]);assert.equal(before.pending.length,1);
 assert.equal(after.pending[1].digest,delivery.attachment.digest);assert.equal(appendDrawingMaterial(after,delivery),after);
 assert.equal(after.pending[1].projectId,'project-a');assert.equal(after.pending[1].instanceId,'instance-a');assert.equal(after.pending[1].storage,'recovery');
});
test('removed or sent delivery is not resurrected by duplicate receipt or stale host snapshot',()=>{
 const saved=appendDrawingMaterial(null,delivery);
 const removed={...saved,pending:[],quote:{text:'new quote'}};
 assert.equal(appendDrawingMaterial(removed,delivery),removed);
 const merged=mergeDrawingMaterials(removed,saved);
 assert.deepEqual(merged.pending,[]);assert.equal(merged.quote,removed.quote);assert.deepEqual(merged.deliveredDrawingIds,[delivery.deliveryId]);
});
test('late host receipts survive stale renderer writes but never replace newer local input',()=>{
 const saved=appendDrawingMaterial(null,delivery),incoming={text:'latest',quote:{text:'latest quote'},pending:[{key:'local'}]};
 const merged=mergeDrawingMaterials(incoming,saved);
 assert.equal(merged.text,'latest');assert.equal(merged.quote,incoming.quote);assert.equal(merged.pending.length,2);
 assert.deepEqual(mergeDrawingMaterials(merged,saved),merged);
});
test('only project/frontdesk PNG drawing receipts can append',()=>{
 for(const bad of [{...delivery,target:'work'},{...delivery,deliveryId:''},{...delivery,attachment:{...delivery.attachment,mime:'application/octet-stream'}},{...delivery,attachment:{...delivery.attachment,size:8*1024*1024+1}}])assert.throws(()=>appendDrawingMaterial(null,bad));
});
