import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/agents/managed/controller.mjs';

const source={projectId:'project',workId:'past',objectId:'object',digest:'a'.repeat(64)};
test('clearing current sources preserves immutable per-input binding provenance',()=>{
  const host=Object.create(Controller.prototype),work={id:'work',revision:1,sourceJob:'original'};
  host.bindMemorySources(work,{id:'original'},[source],'dispatch');
  const initial=structuredClone(work.memorySourceBindings);
  host.bindMemorySources(work,{id:'supplement'},[],'continue');
  assert.deepEqual(work.memorySources,[]);
  assert.deepEqual(work.memorySourceBindings[0],initial[0]);
  assert.deepEqual(work.memorySourceBindings[1],{sourceJobId:'supplement',revision:1,action:'continue',sources:[]});
  assert.notEqual(work.memorySourceBindings[0].sources[0],source);
});
test('continuing an older Work retains its previously recorded sources before clearing',()=>{
  const host=Object.create(Controller.prototype),work={id:'work',revision:3,sourceJob:'original',memorySources:[source]};
  host.bindMemorySources(work,{id:'supplement'},[],'continue');
  assert.deepEqual(work.memorySourceBindings[0],{sourceJobId:'original',revision:3,action:'prior',sources:[source]});
  assert.deepEqual(work.memorySources,[]);
});
test('dispatch rechecks exact identity inside serialized mutation before creating Work',async()=>{
  const job={id:'intake',type:'intake',context:{}},state={jobs:[job],works:[]};
  let stable=true,submitted=false;
  const host=Object.assign(Object.create(Controller.prototype),{
    current:new Map([['orchestrator',job]]),stopping:false,
    store:{state,requireOnline:async()=>{},mutate:async fn=>{stable=false;return fn();},submitState(){submitted=true;}},
    intakeBoundWork:()=>null,intakeSource:()=>({request:'unchanged'}),
    assertDeviationReleased(){},
    resultMemory:{resolve:async()=>source,assertSource(){if(!stable)throw Object.assign(Error('source changed'),{code:'RESULT_MEMORY_SOURCE'});}}
  });
  await assert.rejects(host.handleTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'task',memorySources:[source]}}),{code:'RESULT_MEMORY_SOURCE'});
  assert.equal(submitted,false);assert.equal(job.routing,undefined);
});
