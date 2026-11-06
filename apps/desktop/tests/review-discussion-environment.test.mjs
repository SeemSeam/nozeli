import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeDiscussionEnvironment} from '../src/renderer/review-discussion-environment.mjs';
import {defaultLocalWindowView,localWindowRect} from '../src/renderer/local-window.mjs';
const geometry=(epoch=1)=>({epoch,bounds:{x:0,y:0,width:1000,height:800},origin:{x:0,y:0},zoomFactor:1});
const makeEnvironment=(scope,invoke)=>nativeDiscussionEnvironment({scope,invoke,defaultRect:()=>({x:20,y:20,width:420,height:460})});
test('native geometry has one in-flight and one latest pending, and deduplicates settled geometry',async()=>{
 const requests=[],releases=[],scope={generation:1,geometry:geometry()};
 const environment=makeEnvironment(scope,async(op,payload)=>{requests.push({op,payload});return new Promise(resolve=>releases.push(()=>resolve({ok:true,value:{sequence:payload.sequence}})));});
 const frame=environment.measure(),row=(sequence,x)=>({epoch:1,sequence,visible:true,rect:{x,y:20,width:400,height:420}});
 const first=environment.publishOcclusion(row(1,20),frame);
 const same=environment.publishOcclusion(row(2,20),frame);assert.equal(first,same);
 const replaced=environment.publishOcclusion(row(3,40),frame),latest=environment.publishOcclusion(row(4,80),frame);
 assert.equal(requests.length,1);await replaced;
 releases.shift()();await first;await Promise.resolve();assert.equal(requests.length,2);assert.equal(requests[1].payload.rect.x,80);
 releases.shift()();await latest;await environment.publishOcclusion(row(5,80),frame);assert.equal(requests.length,2);
});
test('stale native bounds receipts never become confirmed geometry',async()=>{
 const scope={generation:1,geometry:geometry()};let calls=0;
 const environment=makeEnvironment(scope,async()=>{calls++;return {ok:true,value:{stale:true}};});
 const frame=environment.measure(),row={epoch:1,sequence:1,visible:true,rect:{x:20,y:20,width:400,height:420}};
 await assert.rejects(environment.publishOcclusion(row,frame),{code:'REVIEW_GEOMETRY_STALE'});
 await assert.rejects(environment.publishOcclusion({...row,sequence:2},frame),{code:'REVIEW_GEOMETRY_STALE'});assert.equal(calls,2);
});
test('a new host geometry notification never relabels an already measured rectangle',async()=>{
 const previous=globalThis.window;let notify;globalThis.window={nozeli:{subscribe(_name,handler){notify=handler;return ()=>{};}}};
 try{
  const scope={generation:4,geometry:geometry()},requests=[];
  const environment=makeEnvironment(scope,async(_op,payload)=>{requests.push(payload);return {ok:true,value:{stale:true}};});
  const frame=environment.measure(),stop=environment.subscribe(()=>{});notify({type:'review-discussion-geometry',geometry:{...geometry(2),bounds:{x:0,y:0,width:320,height:480}}});
  assert.equal(environment.measure().epoch,2);
  await assert.rejects(environment.publishOcclusion({epoch:1,sequence:1,visible:true,rect:{x:600,y:20,width:400,height:420}},frame),{code:'REVIEW_GEOMETRY_STALE'});
  assert.equal(requests[0].epoch,1);assert.equal(requests[0].rect.x,600);stop();
 }finally{globalThis.window=previous;}
});
test('native driver maps the shared CSS rectangle and collapsed 36px to DIP exactly once',async()=>{
 const scope={generation:1,geometry:{...geometry(),origin:{x:-800,y:100},zoomFactor:1.25}},requests=[];
 const environment=makeEnvironment(scope,async(_op,payload)=>{requests.push(payload);return {ok:true,value:{sequence:payload.sequence}};});
 const frame=environment.measure(),view={...defaultLocalWindowView(),placement:{mode:'manual',x:60,y:40},size:{width:520,height:440}};
 const expanded=localWindowRect(view,frame),collapsed=localWindowRect({...view,collapsed:true},frame);
 assert.deepEqual(expanded,{x:60,y:40,width:520,height:440});assert.equal(collapsed.height,36);
 assert.deepEqual(environment.paintRect(expanded),{x:0,y:0,width:520,height:440});
 assert.deepEqual(environment.toLocal(999,999,{screenX:-725,screenY:150}),{x:60,y:40});
 await environment.publishOcclusion({epoch:1,sequence:1,visible:true,rect:expanded},frame);
 await environment.publishOcclusion({epoch:1,sequence:2,visible:true,rect:collapsed},frame);
 assert.deepEqual(requests.map(row=>row.rect),[{x:-725,y:150,width:650,height:550},{x:-725,y:150,width:650,height:45}]);
 assert.deepEqual(view.size,{width:520,height:440});
});
