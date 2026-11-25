import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {createFrontdeskDocuments} from '../src/agents/managed/frontdesk-documents.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {windowsProductionManagedEntry} from '../src/agents/managed/windows-production-entry.mjs';
import {managedRuntime} from '../src/agents/managed/managed-storage.mjs';
import {ControlSession} from './agent-control.fixture.mjs';

// Windows resident work-control regression (unbound frontdesk job): the exact
// windows-tool-contract fixture — real registered Windows desktop storage plus
// the default native production managed entry — with only the model session
// scripted to hold its prompt in-flight, proving the live resident owner
// capability/stop contract deterministically (no timers).
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:120000};
const wait=async fn=>{const end=Date.now()+15000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('condition timeout');};
const drain=async controller=>{do{while(controller.kicking||controller.running.size||controller.starting.size)await new Promise(resolve=>setImmediate(resolve));}while(controller.kicking||controller.running.size);};

// Deterministic prompt-inflight resident owner: every prompt holds until
// cancelled (interrupt/stop) or released, through the real Controller.runJob.
class HeldSession extends ControlSession{
  constructor(spec,target){super(spec,target);this.script=()=>new Promise(resolve=>{
    if(this.cancelled||this.closed)resolve('held turn output');
    else this.releaseHeld=()=>{this.releaseHeld=null;resolve('held turn output');};
  });}
}

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-windows-resident-'));
  const profile=path.join(root,'profile'),content=path.join(root,'content');
  await fs.mkdir(content,{recursive:true});
  const host=new DesktopHost(profile),storage=host.storage;
  const projectId=(await host.pick(content)).project.id;
  const entry=await windowsProductionManagedEntry({storage,projectId});
  assert.equal(entry.native,true,'default Windows production entry selects the native adapters');
  const c=await Controller.open({storage,projectId,runtimeRoot:await managedRuntime(storage,projectId),contentRoot:content,
    workspaceIO:entry.workspaceIO,ownerLaunchFactory:entry.ownerLaunchFactory,
    frontdeskDocuments:createFrontdeskDocuments({host,projectId,sync:async()=>()=>{}}),
    sessionFactory:(spec,target)=>new HeldSession(spec,target)});
  t.after(async()=>{
    await c.stop();
    for(const service of entry.services)service.close();
    await storage.db.close();
    await fs.rm(root,{recursive:true,force:true});
  });
  await c.start();await wait(()=>!c.kicking);
  return {c,entry,host};
}

const stopIntent=(c,{jobId,requestKey,caps,ownerId,ownerGeneration,currentJobId})=>({projectId:c.projectId,jobId,action:'stop-current',requestKey,
  expectedControlVersion:caps.controlVersion,expectedProjectInstanceId:caps.projectInstanceId,ownerId,ownerGeneration,currentJobId});

test('unbound frontdesk run binds its exact live owner; stop-current interrupts, confirms exit and never replays',native,async t=>{
  const {c}=await fixture(t);
  const session=c.sessions.get('frontdesk');
  const accepted=await c.enqueue('frontdesk','front','resident stop regression input');
  const jobId=accepted.jobId??accepted.id;
  await wait(()=>c.current.get('frontdesk')?.id===jobId&&session.busy);
  const job=()=>c.store.state.jobs.find(j=>j.id===jobId);
  assert.equal(job().status,'running');
  // ── capability: the prompt-inflight resident run exposes its exact owner ──
  const caps=await c.workControlCapabilities({jobId});
  assert.equal(caps.live,true);
  assert.equal(caps.workId,null);
  assert.equal(caps.jobId,jobId);
  assert.equal(caps.stopCurrent.allowed,true);
  assert.equal(caps.stopCurrent.reason,null);
  assert.equal(caps.binding.ownerId,session.viewOwnerId);
  assert.equal(caps.binding.ownerGeneration,session.epoch);
  assert.equal(caps.binding.currentJobId,jobId);
  assert.equal(caps.stop,null);
  // ── a queued resident job has no verifiable owner and must not borrow one ──
  const queued=await c.enqueue('frontdesk','front','second queued resident input');
  const queuedId=queued.jobId??queued.id;
  await wait(()=>c.store.state.jobs.some(j=>j.id===queuedId&&j.status==='queued'));
  const queuedCaps=await c.workControlCapabilities({jobId:queuedId});
  assert.equal(queuedCaps.live,false,'only the controller.current run binds the resident owner');
  assert.equal(queuedCaps.stopCurrent.allowed,false);
  assert.equal(queuedCaps.stopCurrent.reason,'owner-unavailable');
  assert.equal(queuedCaps.binding,null);
  const foreignStop=await c.workControl(stopIntent(c,{jobId:queuedId,requestKey:'resident-foreign-stop-1',caps:queuedCaps,ownerId:caps.binding.ownerId,ownerGeneration:caps.binding.ownerGeneration,currentJobId:queuedId}));
  assert.equal(foreignStop.executionDisposition.kind,'stale');
  assert.equal(foreignStop.executionDisposition.reason,'run-changed');
  assert.equal(foreignStop.executionDisposition.jobId,jobId);
  assert.equal(session.interrupts.length,0,'mismatched-job stop never interrupts the live run');
  assert.equal(c.current.get('frontdesk')?.id,jobId);
  // ── wrong owner / wrong run are rejected with zero effect on the owner ──
  const wrongOwner=await c.workControl(stopIntent(c,{jobId,requestKey:'resident-wrong-owner-1',caps,ownerId:'00000000-0000-0000-0000-000000000000',ownerGeneration:'not-the-live-generation',currentJobId:jobId}));
  assert.equal(wrongOwner.controlApplied.stop.state,'stale-owner');
  assert.equal(wrongOwner.executionDisposition.reason,'owner-changed');
  const refreshed=await c.workControlCapabilities({jobId});
  const wrongRun=await c.workControl(stopIntent(c,{jobId,requestKey:'resident-wrong-run-1',caps:refreshed,ownerId:caps.binding.ownerId,ownerGeneration:caps.binding.ownerGeneration,currentJobId:'forged-current-run-id'}));
  assert.equal(wrongRun.executionDisposition.kind,'stale');
  assert.equal(wrongRun.executionDisposition.reason,'run-changed');
  for(const rejected of [wrongOwner,wrongRun]){
    assert.equal(session.interrupts.length,0,'rejected stop never interrupts');
    assert.equal(session.stops.length,0,'rejected stop never exits the owner');
    assert.equal(session.closed,false);
    assert.equal(c.sessions.get('frontdesk'),session);
    assert.equal(c.current.get('frontdesk')?.id,jobId);
    assert.equal(session.busy,true);
  }
  // ── exact-owner stop: interrupt + confirmed exit (unchanged stop semantics) ──
  const exactIntent=stopIntent(c,{jobId,requestKey:'resident-stop-exact-1',caps:await c.workControlCapabilities({jobId}),ownerId:caps.binding.ownerId,ownerGeneration:caps.binding.ownerGeneration,currentJobId:jobId});
  const stop=await c.workControl(exactIntent);
  assert.equal(stop.controlApplied.stop.state,'confirmed');
  assert.equal(stop.controlApplied.stop.exit.confirmed,true);
  assert.equal(stop.controlApplied.stop.exit.pid,session.groupRecord.pid,'real owner pid evidence');
  assert.equal(stop.controlApplied.paused,true);
  assert.equal(stop.executionDisposition.kind,'held');
  assert.equal(stop.executionDisposition.reason,'manual-gate');
  assert.equal(session.interrupts.length,1,'exactly one interrupt before the confirmed exit');
  assert.equal(session.stops.length,1);
  assert.equal(c.sessions.has('frontdesk'),false,'confirmed resident owner exit releases the session');
  // ── final statuses: cancelled turn plus the persisted manual gate ──
  const settled=job();
  assert.equal(settled.status,'cancelled');
  assert.equal(settled.completion,'user-interrupted');
  assert.equal(settled.interruptionReason,'user-interrupted');
  assert.equal(settled.manualControl.pause?.requestKey,'resident-stop-exact-1');
  assert.equal(settled.manualControl.stop?.state,'confirmed');
  assert.equal(c.workExecutionHeld(jobId),true);
  // ── no replay: same key returns the original receipt, nothing re-prompts ──
  const replay=await c.workControl(exactIntent);
  assert.deepEqual(replay.receipt,stop.receipt);
  await drain(c);
  assert.equal(session.prompts.length,1,'the cancelled turn is never re-prompted');
  assert.equal(job().status,'cancelled');
  const stillQueued=c.store.state.jobs.filter(j=>j.target==='frontdesk'&&j.status==='queued');
  assert.deepEqual(stillQueued.map(j=>j.manualControl?.pause!=null),[true],'remaining resident queue stays behind the manual gate');
  assert.equal(c.sessions.has('frontdesk'),false,'gated queue never restarts an owner');
  // ── owner gone: projection is missing-owner false with the durable stop fact ──
  const after=await c.workControlCapabilities({jobId});
  assert.equal(after.live,false);
  assert.equal(after.stopCurrent.allowed,false);
  assert.equal(after.stopCurrent.reason,'owner-unavailable');
  assert.equal(after.binding,null);
  assert.equal(after.paused,true);
  assert.equal(after.stop?.state,'confirmed');
});
