import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openTestController} from './project-storage.fixture.mjs';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'native-restart-'));
  const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'content'),projectHome:async()=>{}});
  const owners=[]; let live=0, fail=false, stopGate=null;
  c.store.state.bindings.frontdesk.provider='omp';
  c.sessionFactory=(spec,target)=>{
    const s=new EventEmitter();Object.assign(s,{closed:false,busy:false,model:'native/chosen',effort:'high',toolsDigest:'stable',hasPrompted:true,agentEnds:[],spec,target});
    s.preflightToolsDigest=async digest=>assert.equal(digest,s.toolsDigest,'fixture historical schema must remain identical');
    s.assertToolsDigest=async digest=>assert.equal(digest,s.toolsDigest,'fixture registered schema must remain identical');
    s.start=async id=>{if(fail){fail=false;throw Error('startup failure');}s.threadId=id??'historical-native-thread';live++;s.live=true;assert.equal(live,1,'old owner reaped before new owner');};
    s.stop=()=>s.stopPromise??=(async()=>{await stopGate;if(s.live){s.live=false;live--;}s.closed=true;return {exited:true,confirmationComplete:true};})();
    owners.push(s);return s;
  };
  t.after(async()=>{await c.stop();await rm(root,{recursive:true,force:true});});
  return {c,owners,fail:()=>{fail=true;},gate:p=>{stopGate=p;}};
}

test('restart is single flight, physically stops owner, preserves historical thread, draft and input',async t=>{
  const {c,owners,gate}=await fixture(t);const first=await c.session('frontdesk');
  c.store.state.drafts.frontdesk='unsent draft';
  const messages=structuredClone(c.store.state.messages),jobs=structuredClone(c.store.state.jobs);
  let release;gate(new Promise(r=>{release=r;}));
  const a=c.restart('frontdesk'),b=c.restart('frontdesk');assert.equal(a,b);
  await new Promise(r=>setImmediate(r));assert.equal(owners.length,1);
  release();const second=await a;assert.notEqual(first,second);assert.equal(second.threadId,first.threadId);
  assert.equal(c.store.state.drafts.frontdesk,'unsent draft');assert.deepEqual(c.store.state.jobs,jobs);assert.deepEqual(c.store.state.messages,messages);
  assert.equal(second.spec.model,null);assert.equal(second.spec.effort,null);
  first.emit('exit',{exitCode:1});assert.equal(c.sessions.get('frontdesk'),second);
});

for(const exitCode of [0,17])test(`natural PTY exit ${exitCode} remains retryable and renderer sees closed state`,async t=>{
  const {c}=await fixture(t);const first=await c.session('frontdesk');const states=[];c.on('state',s=>states.push(s));
  first.closed=true;first.emit('change');first.emit('exit',{exitCode});await first.stop();
  assert.ok(states.some(s=>s.agents.some(a=>a.target==='frontdesk'&&a.closed)));
  const next=await c.restart('frontdesk');assert.equal(next.threadId,first.threadId);assert.notEqual(next,first);
});

test('startup failure clears gates and allows exact historical retry',async t=>{
  const {c,fail}=await fixture(t);const original=await c.session('frontdesk');fail();
  await assert.rejects(c.restart('frontdesk'),/startup failure/);
  assert.equal(c.starting.size,0);assert.equal(c.restarting.size,0);
  const next=await c.restart('frontdesk');assert.equal(next.threadId,original.threadId);
});

test('ended and closing workers cannot restart or be reopened through preview',async t=>{
  const {c}=await fixture(t);
  for(const status of ['closing','ended']){
    const work={id:'worker-'+status,agentId:'agent-'+status,status};c.store.state.works.push(work);
    await assert.rejects(c.restart(work.id),/cannot restart/);await assert.rejects(c.session(work.id),/attachable/);
  }
});

test('legacy runtime binding is only a private migration seed, never executable model authority',async t=>{
  const {c}=await fixture(t);
  Object.assign(c.store.state.bindings.frontdesk,{model:'legacy/choice',effort:'low'});
  const s=await c.session('frontdesk');
  assert.equal(s.spec.model,null);assert.equal(s.spec.effort,null);
  assert.deepEqual(s.spec.legacyNativeSeed,{model:'legacy/choice',effort:'low'});
  s.model='native/new-choice';s.effort='high';
  const next=await c.restart('frontdesk');
  assert.equal(next.threadId,s.threadId);assert.equal(next.spec.model,null);assert.equal(next.spec.effort,null);
});

test('manual in-flight input fails durably on exit instead of becoming fake completed',async t=>{
  const {c}=await fixture(t);const s=await c.session('frontdesk');
  const opened=await c.openManualJob('frontdesk','manual-exit','historical human input');
  s.closed=true;s.emit('exit',{exitCode:19});await s.controllerExitCleanup;
  const job=c.store.state.jobs.find(j=>j.id===opened.jobId);
  assert.equal(job.status,'failed');assert.equal(job.text,'historical human input');
  assert.match(job.error,/exited/);assert.equal(c.current.has('frontdesk'),false);
  await c.restart('frontdesk');assert.equal(c.store.state.jobs.length,1);
});

test('binding-file migration seeds are idempotent and survive Provider-only projection',async t=>{
  const {c}=await fixture(t);
  await c.migrateNativeBinding('frontdesk',{model:'legacy/first',effort:'low'});
  await c.migrateNativeBinding('frontdesk',{model:'legacy/stale',effort:'high'});
  await c.setBinding('frontdesk',{provider:'omp'});
  const s=c.sessions.get('frontdesk');
  assert.deepEqual(s.spec.legacyNativeSeed,{model:'legacy/first',effort:'low'});
  assert.equal(s.spec.model,null);assert.equal(c.store.state.bindings.frontdesk.model,undefined);
});

test('Worker missing journal can renew only durable zero activity; accepted historical input forbids it',async t=>{
  const {c}=await fixture(t);c.store.state.bindings.worker.provider='omp';
  const w=await c.store.submit('zero activity','brief');await c.store.activate(w.id);
  const factory=c.sessionFactory;
  c.sessionFactory=(spec,target)=>{const s=factory(spec,target);s.hasPrompted=false;const start=s.start;s.start=async id=>{if(id)throw Error('OMP_SESSION_FILE_NOT_FOUND');return start(id);};return s;};
  const first=await c.session(w.id);assert.equal(c.store.find(w.id).zeroActivity,true);
  const next=await c.restart(w.id);assert.notEqual(next,first);
  assert.ok(c.store.state.recoveryEvents.some(e=>e.type==='omp-zero-activity-restarted'&&e.target===w.id));
  const opened=await c.openManualJob(w.id,'historical-manual','never replay');
  assert.equal(c.store.find(w.id).zeroActivity,false);
  await c.settleManualJob(w.id,{promptId:'historical-manual',jobId:opened.jobId,error:'transport lost'});
  await assert.rejects(c.restart(w.id),/OMP_SESSION_FILE_NOT_FOUND/);
  assert.equal(c.store.state.jobs.filter(j=>j.text==='never replay').length,1);
});
