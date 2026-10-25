import {openTestController,openTestWorkspace,readTestState,writeTestState,readTestObject} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Controller} from '../src/agents/managed/controller.mjs';

test('ending one Work retires only its exact actionable questions and recovery notices without erasing evidence',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'work-todo-lifecycle-'));
 const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),projectHome:async()=>{}});
 t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});
 const a=await c.store.submit('A request','brief',{name:'Alpha'}),b=await c.store.submit('B request','brief',{name:'Beta'});
 const ask=await c.enqueue('orchestrator','intake','Should Alpha be cancelled?');
 const source=c.store.state.jobs.find(j=>j.id===ask.jobId);
 await c.manageIntake(source,{action:'clarify',workName:'Alpha',text:'Cancel or retain Alpha?'});
 const question=c.store.state.todos.find(t=>t.kind==='routing'&&t.sourceJobId===source.id);
 assert.equal(question.workId,a.id);assert.equal(question.revision,0);
 const unrelated=await c.enqueue('orchestrator','intake','Which Work?');
 await c.manageIntake(c.store.state.jobs.find(j=>j.id===unrelated.jobId),{action:'clarify',workName:'',text:'Which one?'});
 await c.store.mutate(()=>c.store.state.todos.push({id:'old-recovery',kind:'recovery',workId:a.id,revision:0,sourceJobId:'failed-original',status:'open',text:'original connection error'},{id:'other-recovery',kind:'recovery',workId:b.id,status:'open',text:'B remains open'}));
 const bBefore=structuredClone(c.store.find(b.id));
 await c.endWork(a.id,{revision:0,decision:'discard'});
 const q=c.store.state.todos.find(t=>t.id===question.id),recovery=c.store.state.todos.find(t=>t.id==='old-recovery');
 for(const todo of [q,recovery]){assert.equal(todo.status,'cancelled');assert.equal(todo.resolution.status,'work-ended');assert.equal(todo.resolution.decision,'discard');}
 assert.equal(recovery.text,'original connection error');assert.equal(recovery.sourceJobId,'failed-original');
 assert.equal(c.store.state.todos.find(t=>t.sourceJobId===unrelated.jobId).status,'open');
 assert.equal(c.store.state.todos.find(t=>t.id==='other-recovery').status,'open');assert.deepEqual(c.store.find(b.id),bBefore);
 const persisted=await readTestState(c.store);assert.equal(persisted.todos.find(t=>t.id===question.id).status,'cancelled');assert.equal(persisted.todos.find(t=>t.id==='old-recovery').text,'original connection error');
});
