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
  c.store.state.bindings.frontdesk.provider='pi';
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

test('native answers require exact current owner without starting or prompting a session',async t=>{
 const {c,owners}=await fixture(t);const first=await c.session('frontdesk'),calls=[];
 first.respondInteraction=async(...args)=>{calls.push(args);return {accepted:true};};
 const jobs=structuredClone(c.store.state.jobs);
 await assert.rejects(c.respondInteraction('frontdesk','wrong','q',true),{code:'INTERACTION_STALE'});
 await assert.rejects(c.respondInteraction('missing',first.viewOwnerId,'q',true),{code:'INTERACTION_STALE'});
 assert.deepEqual(await c.respondInteraction('frontdesk',first.viewOwnerId,'q',false,{cancel:true}),{accepted:true});
 assert.deepEqual(calls,[['q',false,{cancel:true}]]);assert.deepEqual(c.store.state.jobs,jobs);assert.equal(owners.length,1);
 const next=await c.restart('frontdesk');
 await assert.rejects(c.respondInteraction('frontdesk',first.viewOwnerId,'q',true),{code:'INTERACTION_STALE'});
 await assert.rejects(c.respondInteraction('frontdesk',next.viewOwnerId,'q',true),{code:'INTERACTION_CAPABILITY_UNAVAILABLE'});
 assert.equal(calls.length,1);
});

test('workspace draft controls are bound to current native owner and never open another session',async t=>{
 const {c,owners}=await fixture(t),session=await c.session('frontdesk'),calls=[];
 session.readNativeDraft=async()=>({text:'native draft'});session.replaceNativeDraft=async(...args)=>{calls.push(args);return {replaced:true};};
 await assert.rejects(c.readNativeDraft('frontdesk','old'),{code:'INTERACTION_STALE'});
 await assert.rejects(c.replaceNativeDraft('frontdesk','old','native draft',''),{code:'INTERACTION_STALE'});
 assert.deepEqual(await c.readNativeDraft('frontdesk',session.viewOwnerId),{text:'native draft'});
 assert.deepEqual(await c.replaceNativeDraft('frontdesk',session.viewOwnerId,'native draft',''),{replaced:true});assert.deepEqual(calls,[['native draft','']]);assert.equal(owners.length,1);
});

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

;

;

;

test('Worker missing journal can renew only durable zero activity; accepted historical input forbids it',async t=>{
  const {c}=await fixture(t);c.store.state.bindings.worker.provider='pi';
  const w=await c.store.submit('zero activity','brief');await c.store.activate(w.id);
  const factory=c.sessionFactory;
  c.sessionFactory=(spec,target)=>{const s=factory(spec,target);s.hasPrompted=false;const start=s.start;s.start=async id=>{if(id)throw Object.assign(Error('PI_SESSION_FILE_NOT_FOUND'),{code:'PI_SESSION_FILE_NOT_FOUND'});return start(id);};return s;};
  const first=await c.session(w.id);assert.equal(c.store.find(w.id).zeroActivity,true);
  const next=await c.restart(w.id);assert.notEqual(next,first);
  const admitted=await c.enqueue(w.id,'initial','never replay');
  await c.store.mutate(()=>{c.store.find(w.id).zeroActivity=false;const job=c.store.state.jobs.find(row=>row.id===admitted.jobId);Object.assign(job,{status:'cancelled',promptStartedAt:1,threadId:next.threadId});});
  await assert.rejects(c.restart(w.id),/PI_SESSION_FILE_NOT_FOUND/);
  assert.equal(c.store.state.jobs.filter(j=>j.text==='never replay').length,1);
});
