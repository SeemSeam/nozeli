import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openTestWorkspace} from './project-storage.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {HostContextBudget} from '../src/agents/managed/context-budget.mjs';
import {workerInitialHandoff,workerStateProjection} from '../src/agents/managed/context-delivery.mjs';

async function fixture(t){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-memory-integration-'));
  const store=await openTestWorkspace(path.join(base,'runtime'),path.join(base,'project'));
  t.after(async()=>{if(!store.closed)await store.close();await fs.rm(base,{recursive:true,force:true});});
  const prior=await store.submit('historical task','historical task');await store.activate(prior.id);
  const receipt=await store.publish(prior.id,store.find(prior.id).revision,'result',staticReport('Memory conclusion evidence limits '+('证据😀 '.repeat(1500))),randomUUID());
  await store.mutate(()=>Object.assign(store.find(prior.id),{status:'ended',outcome:'accept',closure:{phase:'complete',decision:'accept',report:{digest:receipt.report.digest,revision:receipt.revision}}}));
  const host=new Controller(store,{projectId:store.projectId});host.changed=()=>{};host.kick=()=>{};
  const intake={id:randomUUID(),type:'intake',target:'orchestrator',text:'Original unchanged request',context:{},status:'running'};
  await store.mutate(()=>{store.state.jobs??=[];store.state.jobs.push(intake);});host.current.set('orchestrator',intake);
  return {store,host,intake};
}
const call=(host,target,tool,args)=>host.onTool(target,{tool,arguments:args,callId:randomUUID()});

test('resident search -> dispatch -> exact Worker read and restart-safe projection',async t=>{
  const {host,store}=await fixture(t);
  const search=await call(host,'orchestrator','nozeli_memory_search',{query:'Memory'});
  assert.equal(search.readOnly,true);assert.equal(search.matches.length,1);
  const source=search.matches[0].source;
  const route=await call(host,'orchestrator','nozeli_dispatch',{name:'new task',memorySources:[source]});
  const work=store.find(route.workId);assert.equal(work.request,'Original unchanged request');assert.deepEqual(work.memorySources,[source]);
  const replay=await call(host,'orchestrator','nozeli_dispatch',{name:'new task',memorySources:[source]});assert.equal(replay.workId,route.workId);
  await assert.rejects(call(host,'orchestrator','nozeli_dispatch',{name:'new task'}),{code:'INTENT_MISMATCH'});
  const job={id:randomUUID(),target:work.id,type:'initial',revision:work.revision};host.current.set(work.id,job);
  const first=await call(host,work.id,'nozeli_memory_read',{source,maxBytes:1200});assert(first.text.includes('Memory'));assert(first.nextOffset>0);assert.deepEqual(first.source,source);
  const next=await call(host,work.id,'nozeli_memory_read',{source,offset:first.nextOffset,maxBytes:1200});assert.equal(next.offset,first.endOffset);
  const restored=structuredClone(work);assert.deepEqual(JSON.parse(workerStateProjection(restored).text).memorySources,[source]);assert(workerInitialHandoff(restored).includes(source.objectId));
  await assert.rejects(call(host,work.id,'nozeli_memory_search',{}),{code:'MEMORY_SOURCE_FORBIDDEN'});
  assert(Buffer.byteLength(JSON.stringify(first))<=1200,'maxBytes bounds the entire tool reply, including paging and host metadata');
  for(const changed of [{projectId:'other'},{digest:'0'.repeat(64)},{objectId:'not-bound'}])await assert.rejects(call(host,work.id,'nozeli_memory_read',{source:{...source,...changed}}),{code:'MEMORY_SOURCE_FORBIDDEN'});
});

test('memory replies charge entire serialized envelope and retain receipt reserve',async t=>{
  const {host}=await fixture(t);
  host.contextBudget=new HostContextBudget({runHostTextMaxBytes:2000,generationHostTextMaxBytes:4000,receiptReserveBytes:200});
  host.contextBudget.beginRun({target:'orchestrator',runId:'memory-run',epoch:'memory-epoch'});
  const result=await call(host,'orchestrator','nozeli_memory_search',{query:'Memory'});
  assert.equal(host.contextBudget.run('orchestrator').usedBytes,Buffer.byteLength(JSON.stringify(result)));
  const allowance=host.contextBudget.readAllowance('orchestrator');host.contextBudget.charge('orchestrator',allowance,{kind:'tool-read'});
  const denied=await call(host,'orchestrator','nozeli_memory_search',{});assert.equal(denied.ok,false);assert.equal(host.contextBudget.readAllowance('orchestrator'),0);
});

test('continue sources persist with intake mutation; stale CAS and cross-project sources write nothing',async t=>{
  const {host,store,intake}=await fixture(t);
  const source=(await call(host,'orchestrator','nozeli_memory_search',{query:'Memory'})).matches[0].source;
  const route=await call(host,'orchestrator','nozeli_dispatch',{name:'continue task'}),work=store.find(route.workId);
  const supplement={...intake,id:randomUUID(),text:'additional original input'};delete supplement.routing;
  await store.mutate(()=>store.state.jobs.push(supplement));host.current.set('orchestrator',supplement);
  await assert.rejects(call(host,'orchestrator','nozeli_manage',{action:'continue',workId:work.id,expectedRevision:work.revision+1,text:'remaining steps',memorySources:[source]}),{code:'STALE_WORK_REVISION'});
  assert.deepEqual(store.find(route.workId).memorySources,[]);
  await assert.rejects(call(host,'orchestrator','nozeli_manage',{action:'continue',workId:route.workId,expectedRevision:store.find(route.workId).revision,text:'remaining steps',memorySources:[{...source,projectId:'other'}]}));
  assert.deepEqual(store.find(route.workId).memorySources,[]);assert.equal(store.state.jobs.find(job=>job.id===supplement.id).routing,undefined);
  await call(host,'orchestrator','nozeli_manage',{action:'continue',workId:route.workId,expectedRevision:store.find(route.workId).revision,text:'remaining steps',memorySources:[source]});assert.deepEqual(store.find(route.workId).memorySources,[source]);assert.equal(store.find(route.workId).request,'Original unchanged request');
  await assert.rejects(host.resolveMemorySources(Array(5).fill(source)),{code:'INVALID_PAYLOAD'});
});
