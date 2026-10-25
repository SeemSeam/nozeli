import {openTestController,openTestWorkspace,readTestState,writeTestState,readTestObject} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {dispositionIntent} from './disposition-intent.fixture.mjs';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-disposition-'));
  const runtime=path.join(root,'runtime'),content=path.join(root,'content');
  const store=await openTestWorkspace(runtime,content);
  const submitted=await store.submit('original request','brief',{name:'Bound work'});
  await store.activate(submitted.id);const work=store.find(submitted.id);
  await store.mutate(()=>{work.result={objectId:'report-original',revision:work.revision};work.execution={candidate:{commit:'candidate-original'}};});
  t.after(async()=>{await store.close();await fs.rm(root,{recursive:true,force:true});});
  return {store,work,runtime,content};
}

for(const decision of ['accept','discard'])test(`${decision} stores exact binding/key and replays only the closure identity`,async t=>{
  const {store,work,runtime,content}=await fixture(t),intent=dispositionIntent(work,decision);
  await store.mutate(()=>{
    store.state.todos.push({id:'todo',workId:work.id,kind:'result',status:'open'});
    store.state.jobs=[{id:'job',target:work.id,status:'queued'}];
    store.state.drafts={[work.id]:'unsent text'};
  });
  await store.end(work.id,intent);
  const closure=structuredClone(store.find(work.id).closure),saved=await readTestState(store);
  assert.deepEqual(closure.binding,intent.binding);assert.equal(closure.requestKey,intent.requestKey);
  assert.deepEqual(saved.works[0].closure,closure);
  assert.equal(store.state.todos.find(todo=>todo.id==='todo').status,'cancelled');assert.equal(store.state.jobs[0].status,'cancelled');
  assert.equal(store.state.drafts[work.id],'unsent text');
  intent.binding.objectId='caller mutation';assert.equal(store.find(work.id).closure.binding.objectId,'report-original');
  const replay=dispositionIntent(store.find(work.id),decision);
  await store.end(work.id,replay);assert.deepEqual(store.find(work.id).closure,closure);
  await assert.rejects(store.end(work.id,{...replay,decision:decision==='accept'?'discard':'accept'}),/another decision/);
  await assert.rejects(store.end(work.id,{...replay,requestKey:'different-key'}),/another disposition request key/);
  await store.close();const reopened=await openTestWorkspace(runtime,content);
  try{await reopened.end(work.id,replay);assert.deepEqual(reopened.find(work.id).closure,closure);}finally{await reopened.close();}
});

for(const field of ['workId','revision','objectId','candidateCommit'])test(`validates current ${field} before duplicate recognition`,async t=>{
  const {store,work}=await fixture(t),intent=dispositionIntent(work);
  await store.end(work.id,intent);
  const wrong={...intent,binding:{...intent.binding,[field]:field==='revision'?9:'changed'}};
  await assert.rejects(store.end(work.id,wrong),/binding/);
  if(field==='workId')return;
  await store.mutate(()=>{
    const current=store.find(work.id);
    if(field==='revision')current.revision++;
    else if(field==='objectId')current.result.objectId='changed';
    else current.execution.candidate.commit='changed';
  });
  await assert.rejects(store.end(work.id,intent),field==='revision'?/stale work revision/:/binding/);
});

test('rejects missing or malformed identities without recording any disposition',async t=>{
  const {store,work}=await fixture(t),intent=dispositionIntent(work),before=structuredClone(store.state);
  for(const patch of [{binding:undefined},{binding:{...intent.binding,extra:true}},{binding:{workId:work.id,revision:1}},{requestKey:undefined},{requestKey:'bad key'},{revision:0},{by:'worker'},{decision:'done'}]){
    await assert.rejects(store.end(work.id,{...intent,...patch}));assert.deepEqual(store.state,before);
  }
});

test('request keys cannot cross works; competing same-binding requests cannot replace closure',async t=>{
  const {store,work}=await fixture(t),other=await store.submit('second request','brief',{name:'Other work'}),intent=dispositionIntent(work);
  await store.end(work.id,intent);
  await assert.rejects(store.end(other.id,dispositionIntent(other,'discard',intent.requestKey)),/request key collision/);
  assert.equal(store.find(other.id).status,'queued');
  await assert.rejects(store.end(work.id,{...intent,binding:{...intent.binding,objectId:null}}),/binding/);
  assert.deepEqual(store.find(work.id).closure.binding,intent.binding);
});

test('null report/candidate binding is explicit and persists for queued work',async t=>{
  const {store}=await fixture(t),work=await store.submit('queued request','brief',{name:'Queued'}),intent=dispositionIntent(work);
  assert.equal(intent.binding.objectId,null);assert.equal(intent.binding.candidateCommit,null);
  await store.end(work.id,intent);assert.deepEqual(store.find(work.id).closure.binding,intent.binding);
});

test('legacy decided closure never gains an inferred binding or request key',async t=>{
  const {store,work}=await fixture(t);
  await store.mutate(()=>{work.status='ended';work.outcome='discard';work.closure={decision:'discard',phase:'blocked',revision:1};});
  const before=structuredClone(store.state);
  await assert.rejects(store.end(work.id,dispositionIntent(work)),/without matching disposition binding/);
  assert.deepEqual(store.state,before);
});

test('legacy unknown outcome requires explicit current binding and preserves end time',async t=>{
  const {store,work}=await fixture(t),at='2026-01-01T00:00:00.000Z';
  await store.mutate(()=>{work.status='ended';work.endedAt=at;work.closure={phase:'blocked',revision:1,at};});
  const intent=dispositionIntent(work);
  await assert.rejects(store.end(work.id,{by:'user',revision:1,decision:'discard'}),/binding/);
  await store.end(work.id,intent);
  assert.equal(store.find(work.id).endedAt,at);assert.deepEqual(store.find(work.id).closure.binding,intent.binding);
});

test('activateNext skips ineligible cold queued work and retains initialization',async t=>{
  const {store}=await fixture(t);
  await store.mutate(()=>{store.state.limit=3;});
  const cold=await store.submit('cold','brief',{name:'Cold'}),fresh=await store.submit('fresh','brief',{name:'Fresh'}),initialized=[];
  const options={isEligible:work=>work.id!==cold.id,initialize:work=>{initialized.push(work.id);work.initialized=true;}};
  assert.equal((await store.activateNext(options)).id,fresh.id);
  assert.deepEqual(initialized,[fresh.id]);assert.equal(store.find(fresh.id).initialized,true);
  assert.equal(await store.activateNext(options),null);assert.equal(store.find(cold.id).status,'queued');
  assert.equal((await store.activateNext()).id,cold.id);
});
