import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openTestWorkspace} from './project-storage.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {memorySourceManifest} from '../src/agents/managed/memory-source-manifest.mjs';
import {workerStateProjection} from '../src/agents/managed/context-delivery.mjs';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-source-manifest-'));
  const store=await openTestWorkspace(path.join(root,'runtime'),path.join(root,'project'));
  t.after(async()=>{try{await store.close();}finally{await fs.rm(root,{recursive:true,force:true});}});
  // Historical corpus setup follows managed-result-memory-integration. These
  // are archived report fixtures; scheduler/closure coverage lives in multitask.
  const sources=[];
  for(const [name,word,decision] of [['Earlier','RED','accept'],['Replacement','BLUE','discard']]){
    const work=await store.submit('Historical '+name,'Historical '+name,{name});
    await store.activate(work.id);
    const receipt=await store.publish(work.id,store.find(work.id).revision,'result',staticReport('Manifest evidence '+word),randomUUID());
    await store.mutate(()=>Object.assign(store.find(work.id),{status:'ended',outcome:decision,closure:{phase:'complete',decision,report:{objectId:receipt.objectId,digest:receipt.report.digest,revision:receipt.revision}}}));
    sources.push({projectId:store.projectId,workId:work.id,objectId:receipt.objectId,digest:receipt.report.digest});
  }
  const host=new Controller(store,{projectId:store.projectId});host.changed=()=>{};host.kick=()=>{};
  const work=await store.submit('Manifest consumer','Read original input evidence',{name:'Consumer'});
  // Enough real per-input bindings to force the normal 10k-char reader to page.
  // Each input selects one source; no input exceeds its four-source cap.
  await store.mutate(()=>{
    for(let index=0;index<65;index++)host.bindMemorySources(store.find(work.id),{id:'original-input-'+index},[sources[0]],index?'continue':'dispatch');
  });
  const enter=async(target=work.id,type='supplement')=>{
    const job={id:randomUUID(),target,type,revision:store.find(target).revision,status:'running',context:{}};
    await store.mutate(()=>{store.state.jobs??=[];store.state.jobs.push(job);});
    host.current.set(target,job);return job;
  };
  const call=(tool,args)=>host.onTool(work.id,{tool,arguments:args,callId:randomUUID()});
  const read=(readRef,offset)=>call('nozeli_history_read',{readRef,...(offset===undefined?{}:{offset})});
  await enter();
  return {host,store,work,sources,enter,call,read};
}

async function collect(read,readRef){
  let text='',offset=0,pages=0,version;
  for(let ref=readRef;ref;){
    const page=await read(ref);
    assert.notEqual(page.ok,false);
    assert.equal(page.offset,offset);assert(page.endOffset>offset);
    if(version!==undefined)assert.equal(page.version,version);
    version=page.version;text+=page.text;offset=page.endOffset;pages++;
    ref=page.nextReadRef;
  }
  return {text,pages,version};
}

const expired=value=>{
  assert.equal(value.ok,false);assert.equal(value.error.code,'READ_REF_EXPIRED');
  assert.equal(value.text,undefined,'never return new snapshot bytes at an old offset');
};

test('manifest identity versions current selection and complete provenance without truncating lifetime bindings',async t=>{
  const {host,store,work,sources}=await fixture(t);
  const before=memorySourceManifest(store.find(work.id));
  assert.deepEqual(memorySourceManifest(structuredClone(store.find(work.id))),before);
  assert.match(before.version,/^[a-f0-9]{64}$/);
  assert.equal(before.readRef,`读取 稳定/work/${work.id}/memory-sources/${before.version.slice(0,32)}`);
  assert.equal(JSON.parse(before.text).bindings.length,65);
  await store.mutate(()=>host.bindMemorySources(store.find(work.id),{id:'replacement-input'},[sources[1]],'continue'));
  const replaced=memorySourceManifest(store.find(work.id));
  assert.notEqual(replaced.readRef,before.readRef);assert.notEqual(replaced.version,before.version);
  assert.deepEqual(JSON.parse(replaced.text).current,[sources[1]]);
  assert.equal(JSON.parse(replaced.text).bindings.length,66);
  assert.deepEqual(JSON.parse(replaced.text).bindings[0].sources,[sources[0]]);
  await store.mutate(()=>host.bindMemorySources(store.find(work.id),{id:'clear-input'},[],'continue'));
  const cleared=memorySourceManifest(store.find(work.id));
  assert.notEqual(cleared.readRef,replaced.readRef);
  assert.deepEqual(JSON.parse(cleared.text).current,[]);
  assert.equal(JSON.parse(cleared.text).bindings.length,67);
  const projection=JSON.parse(workerStateProjection(store.find(work.id)).text);
  assert.deepEqual(projection.memorySources,[]);
  assert.deepEqual(projection.memorySourceManifest,{readRef:cleared.readRef,bindings:67});
});

test('same-turn old manifest pages remain frozen while fresh readers reject stale refs and offsets',async t=>{
  const f=await fixture(t),old=memorySourceManifest(f.store.find(f.work.id));
  const first=await f.read(old.readRef);
  assert.equal(first.version,old.version);assert.equal(first.offset,0);
  assert(first.nextReadRef,'fixture must exercise actual manifest pagination');
  assert.equal(first.text,old.text.slice(0,first.endOffset));
  await f.store.mutate(()=>f.host.bindMemorySources(f.store.find(f.work.id),{id:'replace-while-reading'},[f.sources[1]],'continue'));
  const current=memorySourceManifest(f.store.find(f.work.id));
  assert.notEqual(current.readRef,old.readRef);

  const resumed=await f.read(old.readRef,first.endOffset);
  assert.equal(resumed.version,old.version);assert.equal(resumed.offset,first.endOffset);
  assert.equal(resumed.text,old.text.slice(first.endOffset,resumed.endOffset));
  const next=await f.read(first.nextReadRef);
  assert.equal(next.version,old.version);assert.equal(next.text,resumed.text);
  const oldBody=await collect(f.read,old.readRef);
  assert.equal(oldBody.text,old.text);assert(oldBody.pages>1);
  const newBody=await collect(f.read,current.readRef);
  assert.equal(newBody.text,current.text);assert.equal(newBody.version,current.version);assert(newBody.pages>1);
  const manifest=JSON.parse(newBody.text);
  assert.deepEqual(manifest.current,[f.sources[1]]);
  const earlier=manifest.bindings[0].sources[0];
  const earlierRead=await f.call('nozeli_memory_read',{source:earlier});
  assert(earlierRead.text.includes('RED'),'discover and read earlier input evidence after selection replacement');
  const latestRead=await f.call('nozeli_memory_read',{source:manifest.current[0]});
  assert(latestRead.text.includes('BLUE'),'explicit discarded history binding remains exact-readable');

  await f.enter(); // New job, no inherited ContextReader or ephemeral page tickets.
  expired(await f.read(old.readRef));
  expired(await f.read(old.readRef,first.endOffset));
  expired(await f.read(first.nextReadRef));
  const freshFirst=await f.read(current.readRef);
  assert.equal(freshFirst.version,current.version);assert.equal(freshFirst.offset,0);
  const freshResume=await f.read(current.readRef,freshFirst.endOffset);
  assert.equal(freshResume.version,current.version);
  assert.equal(freshResume.text,current.text.slice(freshFirst.endOffset,freshResume.endOffset));
  const priorReadAfterNewTurn=await f.call('nozeli_memory_read',{source:earlier});
  assert(priorReadAfterNewTurn.text.includes('RED'));

  const other=await f.store.submit('Different consumer','No shared input binding',{name:'Other'});
  await f.enter(other.id,'initial');
  const cross=await f.host.onTool(other.id,{tool:'nozeli_history_read',arguments:{readRef:current.readRef},callId:randomUUID()});
  expired(cross);
  await assert.rejects(f.host.onTool(other.id,{tool:'nozeli_memory_read',arguments:{source:earlier},callId:randomUUID()}),{code:'MEMORY_SOURCE_FORBIDDEN'});
});
