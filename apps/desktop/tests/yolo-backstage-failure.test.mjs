import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openTestController} from './project-storage.fixture.mjs';
import {managedWorkRecords,managedReviewTodos} from '../src/domain/managed-work-records.mjs';

test('failed backstage provider preserves one neutral event without recursive system jobs',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-backstage-failure-'));
 const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'content')});
 t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});
 let source;
 await c.store.mutate(()=>{
  source=c.queueJob('orchestrator','intake','original accepted input',{key:'original-input'});
  c.store.state.jobs.find(job=>job.id===source.id).status='failed';
  c.store.state.todos.push({id:'original-fault',kind:'system',status:'open',target:'frontdesk',sourceJobId:source.id,text:'original connection fault'});
 });
 await c.processBackstage();
 const job=c.store.state.jobs.find(job=>job.type==='backstage');assert.ok(job);
 const secret='provider credential-like raw text must not enter neutral reason';
 c.session=async()=>{throw Object.assign(new Error(secret),{code:'EPIPE'});};
 await c.runJob(job);
 assert.equal(c.store.state.jobs.find(saved=>saved.id===job.id).status,'failed');
 const event=c.store.state.backstageEvents.find(event=>event.key==='todo:original-fault');
 assert.equal(event.status,'blocked');assert.equal(event.failureCode,'EPIPE');assert.ok(event.reason.includes('EPIPE'));assert.equal(event.reason.includes(secret),false);
 assert.equal(c.store.state.todos.some(todo=>todo.sourceJobId===job.id),false,'backstage failure never creates another source todo');
 // Also guard migrated historical recursive todos left by an earlier build.
 await c.store.mutate(()=>c.store.state.todos.push({id:'legacy-recursion',kind:'system',status:'open',target:'orchestrator',sourceJobId:job.id,text:'old backstage failure'}));
 await c.processBackstage();await c.processBackstage();
 assert.equal(c.store.state.jobs.filter(saved=>saved.type==='backstage').length,1);
 assert.equal(c.store.state.backstageEvents.length,1);
 assert.deepEqual(managedReviewTodos(c.store.state),[]);
 assert.equal(c.store.state.jobs.filter(saved=>saved.type==='intake').length,1,'the accepted input is not replayed');
 const original=managedWorkRecords(c.store.state).find(record=>record.jobIds?.includes(source.id));
 assert.equal(original.phase,'后台受阻 · 进展已保留');assert.equal(original.backstage.reason,event.reason);
});

test('backstage storage failure does not manufacture another fault source',async()=>{
 const {Controller}=await import('../src/agents/managed/controller.mjs');
 const c=Object.create(Controller.prototype),state={jobs:[{id:'source',type:'front'}],works:[],receipts:[],todos:[{id:'fault',kind:'system',status:'open',sourceJobId:'source',text:'original'}]};
 c.sessions=new Map();c.store={state,mutate:async()=>{throw new Error('storage unavailable');}};c.kick=()=>{throw new Error('must not queue');};
 const before=structuredClone(state);
 await assert.rejects(c.processBackstage(),/storage unavailable/);
 assert.deepEqual(state,before);assert.equal(c.backstageFlight,null);
});
