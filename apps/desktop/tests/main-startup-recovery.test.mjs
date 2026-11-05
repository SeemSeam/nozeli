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
test('timeout stall keeps the original waiter; continue waiting resumes and the late ack closes',async()=>{
 const f=fixture();
 f.r.requestClose();const p=f.r.pending;
 f.expire();await tick();
 assert.equal(f.r.pending,p);assert.equal(f.r.pending.stage,'stalled');assert.equal(f.r.phase,'save-unconfirmed');
 f.dialogs[0].resolve({response:0});await tick();
 assert.equal(f.r.pending,p);assert.equal(f.r.pending.stage,'waiting');assert.equal(f.r.phase,'flush-pending');
 assert.deepEqual(await f.ack(),{accepted:true});assert.equal(f.counts().closed,1);
});
test('settlement delayed past the stall resumes and completes the original close',async()=>{
 const save=deferred(),f=fixture({settle:()=>save.promise});
 f.r.requestClose();const p=f.r.pending;const ack=f.ack();
 f.expire();await tick();assert.equal(f.r.pending.stage,'stalled');
 f.dialogs[0].resolve({response:0});await tick();
 assert.equal(f.r.pending,p);assert.equal(f.r.pending.stage,'settling');
 save.resolve();assert.deepEqual(await ack,{accepted:true});assert.equal(f.counts().closed,1);
});
test('navigation across a stall drops the waiter; a replacement close is unaffected',async()=>{
 const save=deferred(),f=fixture({settle:()=>save.promise});
 f.r.requestClose();const oldId=f.r.pending.id;const ack=f.ack();
 f.expire();await tick();f.r.navigation();f.r.loaded();
 f.dialogs[0].resolve({response:0});await tick();
 assert.equal(f.r.pending,null);
 save.resolve();assert.deepEqual(await ack,{accepted:false});assert.equal(f.counts().closed,0);
 f.r.requestClose();assert.notEqual(f.r.pending.id,oldId);
 assert.deepEqual(await f.ack(),{accepted:true});assert.equal(f.counts().closed,1);
});
test('timeout alone and default waiting never reload or close',async()=>{
 const f=fixture();f.r.requestClose();f.r.requestClose();assert.equal(f.sends.length,1);f.expire();await tick();assert.equal(f.dialogs.length,1);assert.equal(f.dialogs[0].opts.defaultId,0);assert.equal(f.dialogs[0].opts.cancelId,0);assert.match(f.dialogs[0].opts.detail,/可能仅在内存/);f.dialogs[0].resolve({response:0});await tick();assert.equal(f.r.pending.stage,'waiting');assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});
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
 const f=fixture({settle:async()=>{throw Error('Host fault');}});f.r.rendererGone({});f.dialogs[0].resolve({response:1});await tick();f.dialogs[1].resolve({response:1});await tick();assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});assert.equal(f.r.phase,'save-unconfirmed');f.dialogs[2].resolve({response:0});await tick();
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

for(const reason of ['save-failed','stop-failed'])for(const cancelAt of ['choice','confirmation'])test(reason+': explicit close retries after '+cancelAt+' cancellation; automatic repeats stay suppressed',async()=>{
 const fault=async()=>{throw Error('retry fixture');};
 const f=fixture(reason==='save-failed'?{settle:fault}:reason==='stop-failed'?{stop:fault}:{});
 let dialogs=0;const ids=new Set();
 for(let attempt=0;attempt<3;attempt++){
  f.r.requestClose();const p=f.r.pending;assert(p);assert(!ids.has(p.id));ids.add(p.id);
  f.r.requestClose();assert.equal(f.r.pending,p);assert.equal(f.sends.length,attempt+1);
  if(reason==='save-failed')await assert.rejects(f.ack(),/retry fixture/);else assert.deepEqual(await f.ack(),{accepted:true});
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
test('a late Host rejection across the stall parks its cause for the continue-wait choice',async()=>{
 const save=deferred(),f=fixture({settle:()=>save.promise});
 f.r.requestClose();const ack=f.ack();f.expire();await tick();
 assert.equal(f.r.pending.stage,'stalled');
 save.reject(Error('迟到主机故障'));await assert.rejects(ack,/迟到主机故障/);
 assert.equal(f.dialogs.length,1);assert.equal(f.counts().closed,0);assert.equal(f.r.pending.stage,'stalled');
 f.dialogs[0].resolve({response:0});await tick();
 assert.equal(f.dialogs.length,2);assert.equal(f.r.phase,'save-unconfirmed');
 assert.match(f.dialogs[1].opts.detail,/迟到主机故障/);
 assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});assert.equal(f.r.pending,null);
});
test('rejected stale native dialog cannot change replacement page or close request',async()=>{
 const f=fixture();f.r.rendererGone({});f.r.navigation();f.r.loaded();f.dialogs[0].reject(Error('native dialog closed with rejection'));await tick();f.r.requestClose();const p=f.r.pending;assert(p);assert.equal(f.r.phase,'flush-pending');assert.equal(f.counts().reloads,0);assert.deepEqual(await f.ack(),{accepted:true});assert.equal(f.counts().closed,1);
});

test('force quit confirmation defaults to cancel; cancellation keeps suppression and retry semantics',async()=>{
 let forced=0;const f=fixture({forceQuit:()=>forced++});
 f.r.rendererGone({reason:'killed'});await tick();
 f.dialogs[0].resolve({response:2});await tick();
 assert.equal(f.dialogs.length,2);assert.equal(f.dialogs[1].opts.defaultId,0);assert.equal(f.dialogs[1].opts.cancelId,0);
 f.dialogs[1].resolve({response:0});await tick();
 assert.equal(forced,0);assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});assert.equal(f.r.prompt,null);
 f.r.offer('gone');await tick();assert.equal(f.dialogs.length,2,'cancelled confirmation suppresses automatic repeats');
 f.r.requestClose();assert.equal(f.dialogs.length,3,'explicit close can offer recovery again');
});
test('confirmed force quit from an unresponsive save exits immediately without settlement or cleanup',async()=>{
 let forced=0,settles=0,stopsCalled=0;const f=fixture({forceQuit:()=>forced++,settle:async()=>{settles++;},stop:async()=>{stopsCalled++;}});
 f.r.requestClose();assert.equal(f.sends.length,1);f.expire();await tick();
 assert.equal(f.r.prompt.reason,'timeout');assert.equal(settles,0);
 f.dialogs[0].resolve({response:2});await tick();
 f.dialogs[1].resolve({response:1});await tick();
 assert.equal(forced,1);assert.equal(settles,0);assert.equal(stopsCalled,0);
 assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});
 assert.equal(f.r.phase,'force-quitting');assert.equal(f.r.pending,null);assert.equal(f.r.snapshot().forced,true);
});
test('confirmed force quit after a failed save never retries settlement or claims closure',async()=>{
 let forced=0,settles=0;const f=fixture({forceQuit:()=>forced++,settle:async()=>{settles++;}});
 f.r.requestClose();
 assert.deepEqual(await f.r.acknowledge(f.wc,{requestId:f.r.pending.id,ok:false,error:{message:'保存通道无响应'}}),{accepted:true});
 assert.equal(settles,1);assert.equal(f.r.phase,'save-unconfirmed');
 assert.match(f.dialogs[0].opts.message,/未能确认保存/);
 f.dialogs[0].resolve({response:2});await tick();
 f.dialogs[1].resolve({response:1});await tick();
 assert.equal(forced,1);assert.equal(settles,1);assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});
 assert.equal(f.r.snapshot().forced,true);
});
for(const stage of ['choice','confirmation'])test('stale '+stage+' force quit interaction cannot kill a replacement page',async()=>{
 let forced=0;const f=fixture({forceQuit:()=>forced++});
 f.r.rendererGone({reason:'killed'});await tick();
 if(stage==='choice'){f.r.navigation();f.r.loaded();f.dialogs[0].resolve({response:2});}
 else{f.dialogs[0].resolve({response:2});await tick();f.r.navigation();f.r.loaded();f.dialogs[1].resolve({response:1});}
 await tick();
 assert.equal(forced,0);assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});
});
test('destroyed window ignores a late force quit confirmation',async()=>{
 let forced=0;const f=fixture({forceQuit:()=>forced++});
 f.r.rendererGone({});f.dialogs[0].resolve({response:2});await tick();
 f.destroy();f.dialogs[1].resolve({response:1});await tick();
 assert.equal(forced,0);assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});
});
test('hanging cleanup is supervised and keeps native force quit reachable',async()=>{
 let forced=0;const f=fixture({forceQuit:()=>forced++,stop:()=>new Promise(()=>{})});
 f.r.requestClose();const ack=f.ack();await tick();
 assert.equal(f.r.pending.stage,'stopping');
 f.expire();await tick();
 assert.equal(f.r.phase,'stop-failed');assert.equal(f.r.prompt.reason,'stop-failed');assert.equal(f.r.pending,null);
 assert.deepEqual(f.dialogs[0].opts.buttons,['返回检查','重新加载工作区…','强制退出…']);
 f.dialogs[0].resolve({response:2});await tick();
 f.dialogs[1].resolve({response:1});await tick();
 assert.equal(forced,1);assert.equal(f.counts().closed,0);assert.equal(f.r.phase,'force-quitting');
 assert.equal(f.r.snapshot().pending,null);
 await Promise.race([ack.then(()=>{throw Error('supervised close must not settle');}),tick()]);
});
test('forced recovery is idempotent: later events neither re-prompt, re-close nor re-force',async()=>{
 let forced=0;const f=fixture({forceQuit:()=>forced++});
 f.r.requestClose();f.expire();await tick();
 f.dialogs[0].resolve({response:2});await tick();
 f.r.requestClose();f.r.requestClose();assert.equal(f.sends.length,1);
 f.dialogs[1].resolve({response:1});await tick();
 assert.equal(forced,1);assert.equal(f.r.phase,'force-quitting');
 f.r.requestClose();f.r.rendererGone({reason:'killed'});f.r.offer('timeout');f.expire();await tick();
 assert.equal(f.dialogs.length,2);assert.equal(f.sends.length,1);assert.equal(forced,1);
 assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});assert.deepEqual(f.r.snapshot().pending,null);
});

test('late ack during the stall dialog parks without approving; continue waiting finishes the close',async()=>{
 const f=fixture();
 f.r.requestClose();const p=f.r.pending;f.expire();await tick();
 assert.deepEqual(await f.r.acknowledge(f.wc,{requestId:p.id,ok:true}),{accepted:false});
 assert.equal(f.counts().closed,0);assert.equal(f.r.pending.stage,'stalled');assert.equal(f.r.snapshot().pending.parked,true);
 f.dialogs[0].resolve({response:0});await tick();
 assert.equal(f.r.pending,null);assert.equal(f.counts().closed,1);
});
test('continuing a parked renderer acknowledgement still waits for host settlement',async()=>{
 const save=deferred();let settlements=0;
 const f=fixture({settle:()=>{settlements++;return save.promise;}});
 f.r.requestClose();const id=f.r.pending.id;f.expire();await tick();
 await f.r.acknowledge(f.wc,{requestId:id,ok:true});
 f.dialogs[0].resolve({response:0});await tick();
 assert.equal(settlements,1);assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});
 save.resolve();await tick();assert.deepEqual(f.counts(),{closed:1,reloads:0,stops:1});
});
test('parked late save refusal keeps the window and shows its specific error after continue waiting',async()=>{
 const f=fixture();
 f.r.requestClose();f.expire();await tick();
 assert.deepEqual(await f.r.acknowledge(f.wc,{requestId:f.r.pending.id,ok:false,error:{message:'保存通道迟到失败'}}),{accepted:false});
 assert.equal(f.counts().closed,0);assert.equal(f.dialogs.length,1);
 f.dialogs[0].resolve({response:0});await tick();
 assert.equal(f.dialogs.length,2);assert.match(f.dialogs[1].opts.detail,/保存通道迟到失败/);
 assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});assert.equal(f.r.pending,null);
});
test('resumed wait is re-supervised: a second stall re-offers recovery with force quit',async()=>{
 let forced=0;const f=fixture({forceQuit:()=>forced++});
 f.r.requestClose();const p=f.r.pending;f.expire();await tick();
 f.dialogs[0].resolve({response:0});await tick();
 assert.equal(f.r.pending,p);assert.equal(f.r.pending.stage,'waiting');assert.equal(f.r.phase,'flush-pending');
 f.expire();await tick();
 assert.equal(f.dialogs.length,2);assert.equal(f.r.pending.stage,'stalled');assert.equal(f.r.prompt.reason,'timeout');
 assert.deepEqual(f.dialogs[1].opts.buttons,['继续等待','重新加载工作区…','强制退出…']);
 f.dialogs[1].resolve({response:2});await tick();
 f.dialogs[2].resolve({response:1});await tick();
 assert.equal(forced,1);assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});
});
test('late completion during the force confirmation cancels cleanly and still closes',async()=>{
 let forced=0;const f=fixture({forceQuit:()=>forced++});
 f.r.requestClose();f.expire();await tick();
 f.dialogs[0].resolve({response:2});await tick();
 assert.deepEqual(await f.r.acknowledge(f.wc,{requestId:f.r.pending.id,ok:true}),{accepted:false});
 f.dialogs[1].resolve({response:0});await tick();
 assert.equal(forced,0);assert.equal(f.counts().closed,1);assert.equal(f.r.pending,null);
});
test('confirming force after a parked late ack still exits without closing',async()=>{
 let forced=0;const f=fixture({forceQuit:()=>forced++});
 f.r.requestClose();f.expire();await tick();
 f.dialogs[0].resolve({response:2});await tick();
 assert.deepEqual(await f.r.acknowledge(f.wc,{requestId:f.r.pending.id,ok:true}),{accepted:false});
 f.dialogs[1].resolve({response:1});await tick();
 assert.equal(forced,1);assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});assert.equal(f.r.pending,null);
});
test('prepareClose failure keeps the window and offers recovery with the specific cause',async()=>{
 let forced=0;const f=fixture({prepareClose:async()=>{throw Error('涂鸦收尾失败');},forceQuit:()=>forced++});
 f.r.requestClose();await tick();
 assert.equal(f.sends.length,0);assert.equal(f.r.phase,'prepare-failed');assert.equal(f.r.pending,null);
 assert.equal(f.dialogs[0].opts.buttons[0],'返回工作区');assert.match(f.dialogs[0].opts.message,/准备未完成/);
 assert.match(f.dialogs[0].opts.detail,/涂鸦收尾失败/);assert.match(f.dialogs[0].opts.detail,/强制退出/);
 f.dialogs[0].resolve({response:0});await tick();
 assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});
 f.r.requestClose();await tick();assert.equal(f.dialogs.length,2,'explicit close retries a failed prepare');
});
test('hanging prepareClose is supervised and force quit stays reachable',async()=>{
 let forced=0;const f=fixture({prepareClose:()=>new Promise(()=>{}),forceQuit:()=>forced++});
 f.r.requestClose();await tick();
 assert.equal(f.r.pending.stage,'preparing');assert.equal(f.sends.length,0);
 f.expire();await tick();
 assert.equal(f.r.pending.stage,'stalled');assert.equal(f.r.phase,'save-unconfirmed');assert.equal(f.sends.length,0);
 assert.deepEqual(f.dialogs[0].opts.buttons,['继续等待','重新加载工作区…','强制退出…']);
 f.dialogs[0].resolve({response:2});await tick();f.dialogs[1].resolve({response:1});await tick();
 assert.equal(forced,1);assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});assert.equal(f.r.pending,null);
});
test('late prepare completion parks; continue waiting sends the same flush request and closes',async()=>{
 const prep=deferred(),f=fixture({prepareClose:()=>prep.promise});
 f.r.requestClose();await tick();const id=f.r.pending.id;assert.equal(f.r.pending.stage,'preparing');assert.equal(f.sends.length,0);
 f.expire();await tick();assert.equal(f.r.pending.stage,'stalled');
 prep.resolve();await tick();
 assert.equal(f.sends.length,0);assert.equal(f.r.pending.stage,'stalled');assert.equal(f.r.snapshot().pending.parked,true);
 f.dialogs[0].resolve({response:0});await tick();
 assert.equal(f.r.pending.id,id);assert.equal(f.r.pending.stage,'waiting');assert.equal(f.sends.length,1);
 assert.deepEqual(await f.ack(),{accepted:true});assert.equal(f.counts().closed,1);
});
test('late prepare rejection parks its cause for the continue-wait choice',async()=>{
 const prep=deferred(),f=fixture({prepareClose:()=>prep.promise});
 f.r.requestClose();await tick();f.expire();await tick();
 prep.reject(Error('迟到准备失败'));await tick();
 assert.equal(f.dialogs.length,1);assert.equal(f.r.pending.stage,'stalled');assert.equal(f.counts().closed,0);
 f.dialogs[0].resolve({response:0});await tick();
 assert.equal(f.dialogs.length,2);assert.equal(f.r.phase,'prepare-failed');
 assert.match(f.dialogs[1].opts.detail,/迟到准备失败/);
 assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});assert.equal(f.r.pending,null);
});

test('a stalled reload settlement retains native force exit instead of hanging behind its confirmation',async()=>{
 let forced=0;const save=deferred(),f=fixture({forceQuit:()=>forced++,settle:()=>save.promise});
 f.r.rendererGone({reason:'crashed'});f.dialogs[0].resolve({response:1});await tick();
 f.dialogs[1].resolve({response:1});await tick();f.expire();await tick();
 f.dialogs[2].resolve({response:2});await tick();f.dialogs[3].resolve({response:1});await tick();
 assert.equal(forced,1);save.resolve();await tick();assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});
});
test('late reload settlement requires the current continue-waiting choice and never closes the app',async()=>{
 const save=deferred(),f=fixture({settle:()=>save.promise});
 f.r.rendererGone({reason:'crashed'});f.dialogs[0].resolve({response:1});await tick();
 f.dialogs[1].resolve({response:1});await tick();f.expire();await tick();save.resolve();await tick();
 assert.deepEqual(f.counts(),{closed:0,reloads:0,stops:0});f.dialogs[2].resolve({response:0});await tick();
 assert.deepEqual(f.counts(),{closed:0,reloads:1,stops:0});
});
