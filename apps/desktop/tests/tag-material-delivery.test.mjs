import test from 'node:test';import assert from 'node:assert/strict';
import {readableTagMaterial,tagMaterialSnapshot,TagMaterialDelivery} from '../src/agents/managed/tag-material-delivery.mjs';
const packet=()=>({tagId:'tag-one',fileId:'file-one',relPath:'README.md',kind:'text-selection',note:'保留人的判断权。',origin:{materialDigest:'origin-version',anchor:{start:16,end:27,quote:'人可以随时介入工作。'}},currentSource:{digest:'origin-version'},resolution:{targetDigest:'origin-version',locationStatus:'exact',contentStatus:'unchanged',anchor:{quote:'人可以随时介入工作。'}},information:{location:{label:'第16–21行',context:{before:'背景材料。\n'.repeat(40),after:'后续限制。\n'.repeat(40)}},assets:[],limitations:[]},execution:{canAutoModify:false,reasons:[]}});
const makeJob=(p,extra={})=>{const s=tagMaterialSnapshot([p]);return{target:'frontdesk',text:'围绕人的主体性重新设计README。',context:{userInput:{text:'围绕人的主体性重新设计README。'},tagMaterial:{binding:s.binding,version:s.version,brief:s.brief,reusable:s.reusable},materials:[{id:'tag:'+p.tagId,version:s.version,title:p.relPath,kind:'tag-material'}],...extra}};};
test('readable material distinguishes quoted source, current version and safety without protocol fields',()=>{
 const p=packet(),body=readableTagMaterial(p);
 for(const value of ['README.md','第16–21行','人可以随时介入工作。','背景材料。','后续限制。','保留人的判断权。'])assert(body.includes(value),value);
 for(const value of ['schema','tag-one','file-one','origin-version'])assert(!body.includes(value),value);
 assert(body.includes('不是自动修改授权'));
 p.currentSource={digest:'changed'};p.resolution={targetDigest:'changed',locationStatus:'estimated',contentStatus:'modified',anchor:{quote:'新版本的另一段话。'}};
 const changed=readableTagMaterial(p);assert(changed.includes('当前文件已变化'));assert(changed.includes('人可以随时介入工作。'));assert(changed.includes('当前版本的对应文字'));
 p.currentSource=null;assert(readableTagMaterial(p).includes('当前原文件已不存在'));
});
test('brief mode requires native record confirmation in the same epoch — never turn success',()=>{
 const d=new TagMaterialDelivery(),session={threadId:'one',contextEpoch:'compaction:0:root'},job=makeJob(packet());
 const first=d.prepare(session,job);
 assert.equal(first.mode,'full');assert.equal(first.pointer,null,'no visibility claim before any record confirmation');
 first.commit(true);
 const next=d.prepare(session,job);
 assert.equal(next.mode,'brief');assert(next.pointer);assert(next.pointer.text.includes('README.md'));
 assert.equal(next.pointer.provenance.selector,'frontdesk-source:'+job.context.tagMaterial.version);
 assert(!next.pointer.text.includes('背景材料。'));assert(!next.pointer.text.includes('@read'));
 assert(next.pointer.text.length<readableTagMaterial(packet()).length);
 const fresh=new TagMaterialDelivery();
 fresh.prepare(session,job).commit(true);
 assert.equal(fresh.prepare(session,job).mode,'brief','a restarted host keeps epoch-keyed visibility only after its own confirmation path');
});
test('failed or unconfirmed turns never advance visibility',()=>{
 const d=new TagMaterialDelivery(),session={threadId:'one',contextEpoch:'e0'};
 const job=makeJob(packet());
 d.prepare(session,job).commit(false);
 assert.equal(d.prepare(session,job).mode,'full','turn success without record confirmation is not visibility');
 d.prepare(session,job); // never committed at all
 assert.equal(d.prepare(session,job).mode,'full');
});
test('compaction invalidates visibility claims; late completion cannot undo it; re-attach re-delivers in full',()=>{
 const d=new TagMaterialDelivery(),s={threadId:'one',contextEpoch:'e0'},job=makeJob(packet());
 d.prepare(s,job).commit(true);
 const prepared=d.prepare(s,job);
 d.invalidate(s); // confirmed native compaction epoch change
 prepared.commit(true);
 assert.equal(d.prepare(s,job).mode,'full','compaction while a turn is executing cannot be undone by its late completion');
 d.prepare(s,job).commit(true);
 s.threadId='new-thread';
 assert.equal(d.prepare(s,job).mode,'full','new native thread re-delivers the full frozen material');
 for(const change of [{tagId:'second'},{note:'新的明确备注'}])assert.equal(d.prepare({threadId:'one',contextEpoch:'e0'},makeJob({...packet(),...change})).mode,'full','changed identity or note is a new explicit input');
 assert.equal(d.prepare({threadId:'one',contextEpoch:'e0'},makeJob({...packet(),currentSource:{digest:'new-version'}})).mode,'full','changed source material must still be delivered, never replaced with a stale brief');
});
test('background routing and material-free input never use frontdesk visibility',()=>{
 const d=new TagMaterialDelivery();
 assert.equal(d.prepare({threadId:'one',contextEpoch:'e0'},{...makeJob(packet()),target:'orchestrator'}).mode,'full','explicit materials are delivered in full on any target');
 assert.equal(d.prepare({threadId:'one',contextEpoch:'e0'},{target:'frontdesk',text:'普通输入',context:{}}).mode,'none');
 assert.equal(d.prepare({threadId:'one',contextEpoch:'e0'},{target:'frontdesk',text:'x',context:{userInput:{text:'x'}}}).mode,'none');
 assert.equal(d.prepare({threadId:'one',contextEpoch:'e0'},{target:'frontdesk',text:'x',context:{userInput:{text:'x'},materials:[{id:'tag:t1',version:'f'.repeat(64)}],tagMaterial:{version:'v',binding:'b',brief:'短指针',reusable:false}}}).mode,'full','non-reusable packet (changed/deleted/draft) is never dropped');
 assert.equal(d.prepare({threadId:'one',contextEpoch:'e0'},{target:'frontdesk',text:'x',context:{materials:[{id:'tag:t1',version:'f'.repeat(64)}]}}).mode,'full','materials without userInput identity still deliver in full');
});
test('region material keeps page, coordinates, user drawing semantics and unavailable draft caution',()=>{

 const p=packet();p.kind='ppt-region';p.origin.anchor={page:3,rects:[[.1,.2,.3,.4]]};p.information.location={label:'第3页，选中区域'};p.information.drawing={strokes:[{}]};p.information.assets=[{role:'截图',mime:'image/png'}];p.draftStatus='unavailable';
 const text=readableTagMaterial(p);for(const required of ['第3页','0.1，0.2，0.3，0.4','用户笔迹仅用于标注','image/png','草稿已变化或不可读取'])assert(text.includes(required),required);
});

test('contextEpoch finalizing after prepare (null placeholder → stable root) does not lose confirmation',()=>{
 const d=new TagMaterialDelivery(),session={threadId:'one',contextEpoch:null};
 const job=makeJob(packet());
 const prepared=d.prepare(session,job);
 assert.equal(prepared.mode,'full');
 session.contextEpoch='compaction:0:root'; // runtime sets the stable epoch at start()
 prepared.commit(true); // confirmation happens under the finalized epoch
 assert.equal(d.prepare(session,job).mode,'brief','visibility is recorded for the epoch in which confirmation actually happened');
 session.contextEpoch='compaction:1:confirmed';
 d.invalidate(session);
 assert.equal(d.prepare(session,job).mode,'full','a real compaction still invalidates');
});

test('confirmed explicit material seeds follow-up visibility but explicit reattachment remains full',()=>{
 const delivery=new TagMaterialDelivery(),session={threadId:'one',contextEpoch:'compaction:0:root'},job=makeJob(packet());
 const explicit={...job,context:{...job.context,materialsExplicit:true}};
 delivery.prepare(session,explicit).commit(true);
 assert.equal(delivery.prepare(session,job).mode,'brief');
 assert.equal(delivery.prepare(session,explicit).mode,'full');
});

test('late record confirmation cannot seed visibility in another thread or established epoch',()=>{
 for(const change of [{threadId:'different'},{contextEpoch:'compaction:1:other'}]){
  const delivery=new TagMaterialDelivery(),session={threadId:'one',contextEpoch:'compaction:0:root'},job=makeJob(packet());
  const prepared=delivery.prepare(session,job);Object.assign(session,change);prepared.commit(true);
  assert.equal(delivery.prepare(session,job).mode,'full');
 }
});

test('malformed selected material collection fails before it can become material-free input',()=>{
 const delivery=new TagMaterialDelivery();
 assert.throws(()=>delivery.prepare({threadId:'one'},{target:'frontdesk',context:{materials:{id:'selection'}}}),{code:'HOST_MATERIAL_REFERENCE_INVALID'});
});
