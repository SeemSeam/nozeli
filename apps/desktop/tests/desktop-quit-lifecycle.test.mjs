import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {staysResidentAfterLastWindow,quitIntentIsStale,resolveQuitVehicle,decideWindowAllClosed,retainedDuringHold,createCloseAdmission,createWindowCloseStop,requiresQuitWindow,createQuitCleanup}=require('../src/main/app-lifecycle.cjs');
const {WindowRecovery}=require('../src/main/window-recovery.cjs');

// Exercise the production policy and close barrier, not a second copy of main's
// state machine. These tests do not qualify native macOS controls or Dock UI.
test('last-window close is resident only on macOS without an explicit quit',()=>{
  assert.equal(staysResidentAfterLastWindow('darwin',{}),true);
  assert.deepEqual(decideWindowAllClosed({platform:'darwin'}),{resident:true,quit:false});
  for(const state of [{quitIntent:true},{quitting:true}]){
    assert.equal(staysResidentAfterLastWindow('darwin',state),false);
    assert.deepEqual(decideWindowAllClosed({platform:'darwin',state}),{resident:false,quit:true});
  }
  for(const platform of ['linux','win32'])assert.deepEqual(decideWindowAllClosed({platform}),{resident:false,quit:true});
  assert.deepEqual(decideWindowAllClosed({platform:'darwin',state:{forceQuitting:true}}),{resident:false,quit:false});
  assert.deepEqual(decideWindowAllClosed({platform:'linux',forceQuitting:true}),{resident:false,quit:false});
});

test('quit intent stays attached to a live barrier and can be reset after cancellation',()=>{

  assert.equal(quitIntentIsStale({quitIntent:true},{pending:true,prompt:false}),false);
  assert.equal(quitIntentIsStale({quitIntent:true},{pending:false,prompt:true}),false);
  assert.equal(quitIntentIsStale({quitIntent:true},{pending:false,prompt:false}),true);
  assert.equal(quitIntentIsStale({quitIntent:false},null),false);
});

test('windowless macOS quit restores a confirmation owner while background work is busy',()=>{
  assert.equal(requiresQuitWindow({platform:'darwin',hasLiveWindow:false,busy:true}),true);
  assert.equal(requiresQuitWindow({platform:'darwin',hasLiveWindow:false,busy:false}),false);
  assert.equal(requiresQuitWindow({platform:'darwin',hasLiveWindow:true,busy:true}),false);
  assert.equal(requiresQuitWindow({platform:'linux',hasLiveWindow:false,busy:true}),false);
});
test('a quit uses only a live recovery owner, including when the main window is already closed',()=>{
  const dead={win:{isDestroyed:()=>true}},stale={win:{isDestroyed:()=>false}},live={win:{isDestroyed:()=>false}};
  const recovery={alive:()=>true},recoveries=new Map([[stale.win,{alive:()=>false}],[live.win,recovery]]);
  assert.equal(resolveQuitVehicle([dead,stale,live],win=>recoveries.get(win)),recovery);
  assert.equal(resolveQuitVehicle([dead,stale],win=>recoveries.get(win)),null);
  assert.equal(resolveQuitVehicle([],()=>null),null);
});

test('close admission allows receipt-owned retention but not new work or arbitrary saves',()=>{
  const admission=createCloseAdmission();admission.hold();
  assert.equal(admission.held(),true);
  assert.equal(retainedDuringHold('managed.send',{},false),false);
  assert.equal(retainedDuringHold('managed.task',{},false),false);
  assert.equal(retainedDuringHold('file.save',{},false),false);
  assert.equal(retainedDuringHold('file.save',{},true),true);
  assert.equal(retainedDuringHold('session.flushed',{},false),true);
  assert.equal(retainedDuringHold('workspace.command',{command:{type:'restoreViewState'}},false),true);
  assert.equal(retainedDuringHold('workspace.command',{command:{type:'close'}},false),false);
  admission.release();assert.equal(admission.held(),false);
});

function barrier({resident=true,cleanup=async()=>{}}={}){
  const admission=createCloseAdmission(),events=[],timers=new Map();let timerId=0,closes=0,heldAtClose=false;
  const wc={isDestroyed:()=>false,send:(...args)=>events.push(args)},win={webContents:wc,isDestroyed:()=>false};
  const stop=createWindowCloseStop({residentClose:()=>resident,closeOnlineBrowsers:cleanup,stopManaged:async()=>{events.push('managed-stop');},stopIdle:async()=>{events.push('idle-stop');},admission});
  const recovery=new WindowRecovery(win,{dialog:{showMessageBox:async()=>({response:0})},settle:async()=>{},busy:()=>false,stop,
    onClose:()=>{heldAtClose=admission.held();admission.release();closes++;},reveal:()=>{},report:()=>{},
    setTimer:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearTimer:id=>timers.delete(id)});
  return {admission,events,recovery,wc,timers,get closes(){return closes;},get heldAtClose(){return heldAtClose;}};
}

test('resident close preserves reusable services only after the real save barrier confirms',async()=>{
  const b=barrier();b.recovery.requestClose();
  assert.equal(b.closes,0);
  const request=b.recovery.snapshot().pending.id;
  await b.recovery.acknowledge(b.wc,{requestId:request,ok:true});
  assert.equal(b.closes,1);assert.equal(b.heldAtClose,true);assert.equal(b.admission.held(),false);
  assert.equal(b.events.includes('managed-stop'),false);assert.equal(b.events.includes('idle-stop'),false);
});

test('explicit quit stops services through the same confirmed barrier',async()=>{
  const b=barrier({resident:false});b.recovery.requestClose();
  await b.recovery.acknowledge(b.wc,{requestId:b.recovery.snapshot().pending.id,ok:true});
  assert.deepEqual(b.events.filter(event=>typeof event==='string'),['managed-stop','idle-stop']);
  assert.equal(b.closes,1);assert.equal(b.admission.held(),false);
});

test('a failed save never reaches resident cleanup or closes the window',async()=>{
  let cleaned=false;const b=barrier({cleanup:async()=>{cleaned=true;}});b.recovery.requestClose();
  await b.recovery.acknowledge(b.wc,{requestId:b.recovery.snapshot().pending.id,ok:false,error:{message:'save refused'}});
  assert.equal(cleaned,false);assert.equal(b.closes,0);assert.equal(b.admission.held(),false);
});

test('late cleanup from a timed-out close cannot freeze or close the retained window',async()=>{
  let enter,finish;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{finish=resolve;});
  const b=barrier({cleanup:async()=>{enter();await gate;}});b.recovery.requestClose();
  const ack=b.recovery.acknowledge(b.wc,{requestId:b.recovery.snapshot().pending.id,ok:true});await entered;
  const timeout=[...b.timers.values()].at(-1);assert.equal(typeof timeout,'function');timeout();
  finish();await ack;
  assert.equal(b.closes,0);assert.equal(b.admission.held(),false);
  assert.equal(b.recovery.snapshot().phase,'stop-failed');
});

test('native close failure remains recoverable instead of authorizing an unguarded close',async()=>{
  const b=barrier();const close=b.recovery.onClose;let attempts=0;
  b.recovery.onClose=()=>{attempts++;if(attempts===1){b.admission.release();throw Error('native close refused');}close();};
  b.recovery.requestClose();await b.recovery.acknowledge(b.wc,{requestId:b.recovery.snapshot().pending.id,ok:true});
  await Promise.resolve();await Promise.resolve();
  assert.equal(b.closes,0);assert.equal(b.admission.held(),false);assert.equal(b.recovery.snapshot().phase,'stop-failed');
  b.recovery.requestClose();const pending=b.recovery.snapshot().pending;assert.ok(pending);
  await b.recovery.acknowledge(b.wc,{requestId:pending.id,ok:true});assert.equal(b.closes,1);
});

test('repeated quit remains blocked until the single cleanup flight finishes',async()=>{
  let finish,starts=0,cleanups=0,quits=0;const gate=new Promise(resolve=>{finish=resolve;});
  const handle=createQuitCleanup({cleanup:async()=>{cleanups++;await gate;},quit:()=>{quits++;},onStart:()=>{starts++;}});
  const first={prevented:false,preventDefault(){this.prevented=true;}},again={prevented:false,preventDefault(){this.prevented=true;}};
  const one=handle(first);const two=handle(again);assert.equal(one,two);await Promise.resolve();
  assert.equal(first.prevented,true);assert.equal(again.prevented,true);assert.equal(starts,1);assert.equal(cleanups,1);assert.equal(quits,0);
  finish();await one;assert.equal(quits,1);
  const final={prevented:false,preventDefault(){this.prevented=true;}};handle(final);assert.equal(final.prevented,false);assert.equal(cleanups,1);
});
