import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {WindowRecovery}=createRequire(import.meta.url)('../src/main/window-recovery.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture(options={}){
 const dialogs=[],sends=[],timers=new Set();let closed=0,reloads=0,stops=0,destroyed=false;
 const wc={isDestroyed:()=>destroyed,send:(...args)=>sends.push(args),reload:()=>reloads++};
 const win={webContents:wc,isDestroyed:()=>destroyed};
 const r=new WindowRecovery(win,{dialog:{showMessageBox:(w,opts)=>{assert.equal(w,win);const d=deferred();dialogs.push({opts,...d});return d.promise;}},settle:async()=>{},busy:()=>false,stop:async()=>{stops++;},onClose:()=>closed++,reveal:()=>{},report:()=>{},setTimer:fn=>{timers.add(fn);return fn;},clearTimer:t=>timers.delete(t),...options});
 return {r,wc,dialogs,sends,expire:()=>{for(const fn of [...timers])fn();},ack:()=>r.acknowledge(wc,{requestId:r.pending?.id,ok:true}),counts:()=>({closed,reloads,stops}),destroy:()=>{destroyed=true;r.destroyed();}};
}
test('normal close waits for authoritative Host settlement and cleanup',async()=>{
 const save=deferred(),f=fixture({settle:()=>save.promise});f.r.requestClose();const ack=f.ack();assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});save.resolve();assert.equal((await ack).accepted,true);assert.deepEqual(f.counts(),{closed:1,reloads:0,stops:1});
});
test('Host delay crossing timeout/new close cannot consume the new waiter',async()=>{
 const oldSave=deferred(),newSave=deferred();let n=0;const f=fixture({settle:()=>++n===1?oldSave.promise:newSave.promise});f.r.requestClose();const oldId=f.r.pending.id,oldAck=f.ack();f.expire();await tick();f.dialogs[0].resolve({response:0});await tick();f.r.requestClose();const next=f.r.pending;assert.notEqual(next.id,oldId);oldSave.resolve();assert.deepEqual(await oldAck,{accepted:false});assert.equal(f.r.pending,next);assert.equal(f.counts().closed,0);const ack=f.ack();newSave.resolve();assert.deepEqual(await ack,{accepted:true});assert.equal(f.counts().closed,1);
});
test('timeout alone and default waiting never reload or close',async()=>{
 const f=fixture();f.r.requestClose();f.r.requestClose();assert.equal(f.sends.length,1);f.expire();await tick();assert.equal(f.dialogs.length,1);assert.equal(f.dialogs[0].opts.defaultId,0);assert.equal(f.dialogs[0].opts.cancelId,0);assert.match(f.dialogs[0].opts.detail,/可能仅在内存/);f.dialogs[0].resolve({response:0});await tick();assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});
});
test('gone coalesces, cancellation does not repeatedly prompt; explicit close can retry',async()=>{
 const f=fixture();f.r.rendererGone({reason:'killed'});f.r.rendererGone({reason:'killed'});await tick();assert.equal(f.dialogs.length,1);f.dialogs[0].resolve({response:0});await tick();f.r.rendererGone({reason:'killed'});await tick();assert.equal(f.dialogs.length,1);f.r.requestClose();assert.equal(f.dialogs.length,2);
});
test('reload needs second explicit confirmation and waits Host',async()=>{
 const save=deferred(),f=fixture({settle:()=>save.promise});f.r.rendererGone({reason:'killed'});f.dialogs[0].resolve({response:1});await tick();assert.equal(f.dialogs[1].opts.defaultId,0);assert.match(f.dialogs[1].opts.message,/丢失未保存/);f.dialogs[1].resolve({response:1});await tick();assert.equal(f.counts().reloads,0);save.resolve();await tick();assert.deepEqual(f.counts(),{closed:0,reloads:1,stops:0});
});
test('second confirmation cancellation preserves window',async()=>{
 const f=fixture();f.r.rendererGone({});f.dialogs[0].resolve({response:1});await tick();f.dialogs[1].resolve({response:0});await tick();assert.equal(f.counts().reloads,0);
});
for(const phase of ['choice','confirmation','settlement'])test('stale '+phase+' dialog response cannot reload a new generation',async()=>{
 const save=deferred(),f=fixture({settle:()=>save.promise});f.r.rendererGone({});
 if(phase!=='choice'){f.dialogs[0].resolve({response:1});await tick();}
 if(phase==='settlement'){f.dialogs[1].resolve({response:1});await tick();}
 f.r.navigation();f.r.loaded();
 if(phase==='choice')f.dialogs[0].resolve({response:1});else if(phase==='confirmation')f.dialogs[1].resolve({response:1});else save.resolve();
 await tick();assert.equal(f.counts().reloads,0);
});
test('destroyed window ignores pending dialog return',async()=>{const f=fixture();f.r.rendererGone({});f.destroy();f.dialogs[0].resolve({response:1});await tick();assert.equal(f.dialogs.length,1);assert.equal(f.counts().reloads,0);});
test('reload settlement failure shows retained-window error without reload or stop',async()=>{
 const f=fixture({settle:async()=>{throw Error('Host fault');}});f.r.rendererGone({});f.dialogs[0].resolve({response:1});await tick();f.dialogs[1].resolve({response:1});await tick();assert.match(f.dialogs[2].opts.message,/未重新加载/);assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});f.dialogs[2].resolve({response:0});await tick();
});
test('late ack after navigation, wrong sender and duplicate ack are rejected',async()=>{
 const save=deferred(),f=fixture({settle:()=>save.promise});f.r.requestClose();const p={requestId:f.r.pending.id,ok:true};assert.deepEqual(await f.r.acknowledge({},p),{accepted:false});const ack=f.r.acknowledge(f.wc,p);assert.deepEqual(await f.r.acknowledge(f.wc,p),{accepted:false});f.r.navigation();save.resolve();assert.deepEqual(await ack,{accepted:false});assert.equal(f.counts().closed,0);
});
test('Host close failure leaves window and offers main recovery',async()=>{const f=fixture({settle:async()=>{throw Error('Host failed');}});f.r.requestClose();await assert.rejects(f.ack(),/Host failed/);assert.equal(f.counts().closed,0);assert.match(f.dialogs[0].opts.message,/未能确认保存/);});
test('busy Agent keeps existing quit confirmation gate and does not stop',async()=>{const f=fixture({busy:()=>true});f.r.requestClose();assert.deepEqual(await f.ack(),{accepted:true});assert.equal(f.sends.at(-1)[0],'nozeli:quit-confirm');assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});});
test('stop failure keeps window and does not claim saved closure',async()=>{const f=fixture({stop:async()=>{throw Error('cleanup denied');}});f.r.requestClose();assert.deepEqual(await f.ack(),{accepted:true});assert.equal(f.counts().closed,0);assert.equal(f.r.phase,'stop-failed');assert.match(f.dialogs[0].opts.message,/窗口已保留/);});
test('navigation during stop and repeated close cannot close a replacement page',async()=>{const stopped=deferred(),f=fixture({stop:()=>stopped.promise});f.r.requestClose();const ack=f.ack();await tick();f.r.requestClose();assert.equal(f.sends.length,1);f.r.navigation();stopped.resolve();assert.deepEqual(await ack,{accepted:false});assert.equal(f.counts().closed,0);});
test('renderer exits while Host is settling: old ack is not accepted',async()=>{const saved=deferred(),f=fixture({settle:()=>saved.promise});f.r.requestClose();const ack=f.ack();f.r.rendererGone({reason:'killed'});saved.resolve();assert.deepEqual(await ack,{accepted:false});assert.equal(f.r.pending,null);assert.equal(f.counts().closed,0);assert.equal(f.dialogs.length,1);});
test('renderer save refusal offers actionable recovery and retries without closing or stopping',async()=>{
 const f=fixture();
 for(let attempt=0;attempt<2;attempt++){
  f.r.requestClose();assert.deepEqual(await f.r.acknowledge(f.wc,{requestId:f.r.pending.id,ok:false,error:{code:'PROJECT_SCOPE_DENIED',message:'草稿未能保存，请检查项目归属后重试。'}}),{accepted:true});
  assert.equal(f.r.phase,'save-unconfirmed');assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});
  assert.equal(f.dialogs.length,attempt+1);const dialog=f.dialogs.at(-1);
  assert.match(dialog.opts.detail,/草稿未能保存/);assert.match(dialog.opts.detail,/内存|丢失/);
  dialog.resolve({response:0});await tick();
 }
 f.r.requestClose();await f.ack();assert.equal(f.counts().closed,1);
});

for(const reason of ['timeout','save-failed','stop-failed'])for(const cancelAt of ['choice','confirmation'])test(reason+': explicit close retries after '+cancelAt+' cancellation; automatic repeats stay suppressed',async()=>{
 const fault=async()=>{throw Error('retry fixture');};
 const f=fixture(reason==='save-failed'?{settle:fault}:reason==='stop-failed'?{stop:fault}:{});
 let dialogs=0;const ids=new Set();
 for(let attempt=0;attempt<3;attempt++){
  f.r.requestClose();const p=f.r.pending;assert(p);assert(!ids.has(p.id));ids.add(p.id);
  f.r.requestClose();assert.equal(f.r.pending,p);assert.equal(f.sends.length,attempt+1);
  if(reason==='timeout')f.expire();else if(reason==='save-failed')await assert.rejects(f.ack(),/retry fixture/);else assert.deepEqual(await f.ack(),{accepted:true});
  await tick();assert.equal(f.dialogs.length,dialogs+1,'new explicit close must offer recovery again');
  assert.equal(f.r.prompt.reason,reason);assert.equal(f.dialogs[dialogs].opts.defaultId,0);assert.equal(f.dialogs[dialogs].opts.cancelId,0);
  f.r.requestClose();f.r.offer(reason);assert.equal(f.dialogs.length,dialogs+1,'in-flight prompt merges repeated close/event');
  if(cancelAt==='confirmation'){
   f.dialogs[dialogs++].resolve({response:1});await tick();assert.equal(f.dialogs.length,dialogs+1);
   assert.equal(f.dialogs[dialogs].opts.defaultId,0);assert.equal(f.dialogs[dialogs].opts.cancelId,0);
  }
  f.dialogs[dialogs++].resolve({response:0});await tick();assert.equal(f.r.prompt,null);assert.equal(f.r.pending,null);
  f.r.offer(reason);f.expire();await tick();assert.equal(f.dialogs.length,dialogs,'cancelled automatic event must not reprompt');
  assert.equal(f.counts().closed,0);assert.equal(f.counts().reloads,0);
 }
});
test('old Host rejection after timeout/new close cannot consume or fail the new waiter',async()=>{
 const save=deferred(),f=fixture({settle:()=>save.promise});f.r.requestClose();const ack=f.ack();f.expire();f.dialogs[0].resolve({response:0});await tick();f.r.requestClose();const p=f.r.pending;save.reject(Error('old Host failure'));assert.deepEqual(await ack,{accepted:false});assert.equal(f.r.pending,p);assert.equal(f.dialogs.length,1);assert.equal(f.counts().closed,0);
});
test('rejected stale native dialog cannot change replacement page or close request',async()=>{
 const f=fixture();f.r.rendererGone({});f.r.navigation();f.r.loaded();f.dialogs[0].reject(Error('native dialog closed with rejection'));await tick();f.r.requestClose();const p=f.r.pending;assert(p);assert.equal(f.r.phase,'flush-pending');assert.equal(f.counts().reloads,0);assert.deepEqual(await f.ack(),{accepted:true});assert.equal(f.counts().closed,1);
});
