import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createSaveDrain} from '../src/renderer/save-drain.mjs';

// Execute the real preload with the sandbox's require whitelist. A local-module
// require here must fail just as it would in every production content surface.
const sandbox={require(name){assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld(){}},ipcRenderer:{on(){},invoke(){return Promise.resolve();}}};}};
vm.runInNewContext(fs.readFileSync(new URL('../src/preload/preload.cjs',import.meta.url),'utf8'),sandbox);
const {createFlushQueue}=sandbox;

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=async(times=12)=>{for(let i=0;i<times;i++)await Promise.resolve();};


// Missing handler results previously collapsed to a bare {ok:false} with no
// error, which the host can only describe as an unexplained "工作区未确认保存".
test('flush queue names a missing handler result instead of an unexplained refusal',async()=>{
  const acks=[];
  const queue=createFlushQueue({ack:async payload=>acks.push(payload),getHandler:()=>async()=>undefined});
  queue.enqueue('close-2');
  await tick();
  assert.equal(acks.length,1);
  assert.equal(acks[0].ok,false);
  assert.equal(acks[0].requestId,'close-2');
  assert.equal(acks[0].error.code,'NO_FLUSH_RESULT');
});

test('flush queue surfaces handler failures with their message, including non-Error throws',async()=>{
  const acks=[];
  const queue=createFlushQueue({ack:async payload=>acks.push(payload),getHandler:()=>async()=>{throw Error('保存队列被占用');}});
  queue.enqueue('close-3');
  await tick();
  assert.equal(acks[0].ok,false);
  assert.equal(acks[0].error.code,'FLUSH_FAILED');
  assert.equal(acks[0].error.message,'保存队列被占用');
  acks.length=0;
  const throwingString=createFlushQueue({ack:async payload=>acks.push(payload),getHandler:()=>async()=>{throw 'busy';}});
  throwingString.enqueue('close-4');
  await tick();
  assert.equal(acks[0].error.code,'FLUSH_FAILED');
  assert.equal(acks[0].error.message,'busy');
});

// One flush at a time: a queued close must never consume another waiter's
// receipt, and the scoped-invoke view must only see the running receipt.
test('flush queue serializes flushes and exposes the active receipt only while running',async()=>{
  const started=[];const release=deferred();
  const queue=createFlushQueue({ack:async()=>{},getHandler:()=>async detail=>{started.push({requestId:queue.activeRequest(),detail});if(started.length===1)await release.promise;return {ok:true};}});
  assert.equal(queue.activeRequest(),null);
  queue.enqueue('a');
  queue.enqueue({requestId:'b',reviewBarrier:true,workId:'w1'});
  await tick();
  assert.deepEqual(started.map(entry=>entry.requestId),['a']);
  assert.equal(queue.activeRequest(),'a');
  release.resolve();
  await tick();
  assert.deepEqual(started.map(entry=>entry.requestId),['a','b']);
  assert.deepEqual(started[1].detail,{requestId:'b',reviewBarrier:true,workId:'w1'});
  assert.equal(queue.activeRequest(),null);
});

// A rejected ack used to leak an unhandled rejection from the fallback ack;
// it must surface the failure once and never re-ack from the same queue.
test('rejected ack surfaces exactly once without an unhandled rejection',async()=>{
  const acks=[];
  const queue=createFlushQueue({
    ack:payload=>{acks.push(payload);throw Error('settle failed upstream');},
    getHandler:()=>async()=>({ok:true}),
  });
  let unhandled=null;
  const capture=rejection=>{unhandled=rejection;};
  process.once('unhandledRejection',capture);
  queue.enqueue('c');
  await tick();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(acks.length,2);
  assert.equal(acks[1].ok,false);
  assert.equal(acks[1].requestId,'c');
  assert.equal(acks[1].error.code,'FLUSH_FAILED');
  assert.equal(acks[1].error.message,'settle failed upstream');
  assert.equal(unhandled,null);
  process.off('unhandledRejection',capture);
});

test('malformed flush requests are never acked against a guessed receipt',async()=>{
  const acks=[];
  const queue=createFlushQueue({ack:async payload=>acks.push(payload),getHandler:()=>async()=>({ok:true})});
  queue.enqueue(undefined);
  queue.enqueue({});
  queue.enqueue({requestId:42});
  queue.enqueue(null);
  await tick();
  assert.equal(acks.length,0);
});

// Retention must wait for in-flight autosaves: a racing save flips digests
// and dirty flags mid-retention and reads as RECOVERY_CHANGED, blocking exit
// behind a save that actually succeeded.
test('save drain waits for every in-flight save, including saves started during the drain',async()=>{
  const drain=createSaveDrain();
  const order=[];
  const first=deferred(),second=deferred();
  drain.track(first.promise.then(()=>order.push('first')));
  const drained=drain.drain().then(()=>order.push('drained'));
  await tick();
  drain.track(second.promise.then(()=>order.push('second')));
  first.resolve();
  await tick();
  assert.deepEqual(order,['first'],'drain must keep waiting for the save started during the drain');
  second.resolve();
  await tick();
  await tick();
  assert.deepEqual(order,['first','second','drained']);
});

test('save drain survives rejected saves and clears tracking',async()=>{
  const drain=createSaveDrain();
  const run=drain.track(Promise.reject(Error('save failed')));
  await assert.rejects(()=>run,/save failed/);
  await drain.drain();
  assert.equal(drain.size(),0);
});

test('save drain resolves immediately when no save is in flight',async()=>{
  const drain=createSaveDrain();
  let settled=false;
  await drain.drain().then(()=>{settled=true;});
  assert.equal(settled,true);
  assert.equal(drain.size(),0);
});
