import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DesktopHost} from '../src/main/host.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {ManagedReportExporter} from '../src/main/managed-report-export.mjs';
import {staticReport,historicalMarkdownState} from './static-report.fixture.mjs';
import {reportDescriptor,decodeReportState} from '../src/agents/managed/report-descriptor.mjs';
import {managedRuntime,readManagedState} from '../src/agents/managed/managed-storage.mjs';
import {writeTestState} from './project-storage.fixture.mjs';

async function setup(t,{html=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-offline-report-'));
  t.after(async()=>{await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
  const project=path.join(root,'项目');await fs.mkdir(project);
  const profile=path.join(root,'profile'),host=new DesktopHost(profile);
  const projectId=(await host.pick(project)).project.id;
  let opens=0,connects=0,starts=0,stops=0;
  const sourceRoot=path.join(root,'private-omp'),ompSystemSource={private:true,root:sourceRoot,agentDir:path.join(sourceRoot,'agent')};
  const managed=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},ompSystemSource,openController:async options=>{
    assert.equal(options.ompSystemSource,ompSystemSource);
    opens++;return {on(){},start:async()=>{starts++;throw Error('OMP native startup failed');},stop:async()=>{stops++;}};
  }});
  const connect=managed.connect.bind(managed);managed.connect=(...args)=>{connects++;return connect(...args);};
  const runtime=await managedRuntime(host.storage,projectId);
  const store=await Workspace.open(runtime,project,{storage:host.storage,projectId});
  const work=await store.submit('original','brief');await store.activate(work.id);
  const oldBody=html?staticReport('历史版本'):'# 历史版本\r\n\r\n历史 Markdown 原字节。\r\n',latestBody=html?staticReport('当前版本'):'# 当前版本\n';
  const old=await store.publish(work.id,1,'result',staticReport('历史版本'),'first');await store.settle(work.id);
  await store.continue(work.id);
  const latest=await store.publish(work.id,2,'result',staticReport('当前版本'),'second');await store.settle(work.id);
  if(html)await store.close();else await historicalMarkdownState(store,new Map([[old.objectId,oldBody],[latest.objectId,latestBody]]));
  const baseline=await readManagedState(host.storage,projectId),binding=await host.storage.requireRegistered(projectId);
  for(const row of baseline.receipts)await fs.unlink(path.join(await host.storage.recoveryDirectory(projectId),'objects','sha256',row.report.digest));
  const beforeTree=await fs.readdir(runtime,{recursive:true});
  const projectEntries=await fs.readdir(project);
  const exporter=new ManagedReportExporter({host,managedAgents:managed,beforeOperation:async()=>()=>{}});
  const input=(relPath=html?'copy.html':'copy.md',objectId=old.objectId)=>({projectId,objectId,relPath});
  const source=path.join(binding.metadataRoot,'objects','sha256',baseline.receipts[0].report.digest);
  const invariant=async()=>{
    assert.deepEqual(await readManagedState(host.storage,projectId),baseline);
    assert.deepEqual(await fs.readdir(runtime,{recursive:true}),beforeTree);
    assert.deepEqual({opens,connects,starts,stops},{opens:0,connects:0,starts:0,stops:0});
    await assert.rejects(fs.stat(sourceRoot),e=>e.code==='ENOENT');
  };
  return {root,profile,project,projectEntries,projectId,host,managed,runtime,store,old:baseline.receipts[0],latest:baseline.receipts[1],oldBody,latestBody,baseline,source,exporter,input,invariant,
    resetCalls:()=>{opens=connects=starts=stops=0;},calls:()=>({opens,connects,starts,stops}),
    rewrite:async fn=>{const state=structuredClone(baseline);fn(state);await writeTestState(store,state);}};
}

test('cold offline exports historical and current exact versions without starting provider or changing runtime',async t=>{
  const s=await setup(t);
  await s.exporter.export(s.input('历史.md'));await s.exporter.export(s.input('当前.md',s.latest.objectId));
  assert.equal(await fs.readFile(path.join(s.project,'历史.md'),'utf8'),s.oldBody);
  assert.equal(await fs.readFile(path.join(s.project,'当前.md'),'utf8'),s.latestBody);
  await s.invariant();
});

test('after a simulated native OMP startup failure export makes zero reconnect/open/start calls',async t=>{
  const s=await setup(t);await assert.rejects(s.managed.connect(s.projectId,{enable:true}),/OMP native startup failed/);
  assert.deepEqual(s.calls(),{opens:1,connects:1,starts:1,stops:1});assert.equal(s.managed.controllers.size,0);
  s.resetCalls();await s.exporter.export(s.input());
  assert.equal(await fs.readFile(path.join(s.project,'copy.md'),'utf8'),s.oldBody);await s.invariant();
});

for(const [name,mutate] of [
  ['wrong schema',s=>s.rewrite(v=>{v.schema=1;})],
  ['foreign work receipt',s=>s.rewrite(v=>{v.receipts[0].workId='foreign';})],
  ['future revision',s=>s.rewrite(v=>{v.receipts[0].revision=100;})],
  ['duplicate object ownership',s=>s.rewrite(v=>{v.receipts.push({...v.receipts[0],id:'duplicate-receipt'});})],
  ['missing object',s=>fs.unlink(s.source)],
  ['tampered object',s=>fs.writeFile(s.source,'tampered')],
  ['linked object',async s=>{const outside=path.join(s.root,'outside.md');await fs.writeFile(outside,s.oldBody);await fs.unlink(s.source);await fs.symlink(outside,s.source);}],
  ['oversize object',s=>fs.truncate(s.source,256*1024*1024+1)],
]) test(`offline rejects ${name} without publishing or repairing`,async t=>{
  const s=await setup(t);await mutate(s);
  const before=await readManagedState(s.host.storage,s.projectId);
  await assert.rejects(s.exporter.export(s.input()),e=>/^(REPORT_|MATERIAL_|INVALID_MATERIAL$|INVALID_DIRECTORY$)/.test(e.code));
  assert.deepEqual(await fs.readdir(s.project),s.projectEntries);assert.deepEqual(await readManagedState(s.host.storage,s.projectId),before);
  assert.deepEqual(s.calls(),{opens:0,connects:0,starts:0,stops:0});
});

test('unknown project and cross-project object cannot supply arbitrary runtime, text or object paths',async t=>{
  const s=await setup(t),other=path.join(s.root,'other');await fs.mkdir(other);const id=(await s.host.pick(other)).project.id,otherEntries=await fs.readdir(other);
  await assert.rejects(s.exporter.export({...s.input(),projectId:id}));
  await assert.rejects(s.exporter.export({...s.input(),projectId:'../foreign'}));
  for(const extra of [{runtimeRoot:s.runtime},{text:s.oldBody},{source:s.source}])await assert.rejects(s.exporter.export({...s.input(),...extra}),e=>e.code==='INVALID_PAYLOAD');
  await assert.rejects(s.exporter.export(s.input('copy.md','../state.json')),e=>e.code==='INVALID_PAYLOAD');
  await s.invariant();assert.deepEqual(await fs.readdir(other),otherEntries);
});

test('active unstarted controller is authoritative and corrupt memory never falls back to persisted report',async t=>{
  const s=await setup(t),state=decodeReportState(structuredClone(s.store.state));state.receipts[0].report={...state.receipts[0].report,byteLength:state.receipts[0].report.byteLength+1};
  delete state.receipts[0].snapshot; // Isolate object/memory mismatch from snapshot corruption.
  s.managed.controllers.set(s.projectId,{started:false,store:{root:s.runtime,state}});
  await assert.rejects(s.exporter.export(s.input()),e=>e.code==='REPORT_CHANGED');
  state.receipts=[];await assert.rejects(s.exporter.export(s.input()),e=>e.code==='REPORT_MISSING');await s.invariant();
});

for(const change of ['object','state','active source','project'])test(`staged offline export rejects concurrent ${change} change`,async t=>{
  const s=await setup(t),replace=s.host.replaceFile.bind(s.host);
  s.host.replaceFile=(abs,bytes,options)=>replace(abs,bytes,{...options,beforeCommit:async()=>{
    if(change==='object')await fs.writeFile(s.source,'external changed');
    if(change==='state')await s.rewrite(v=>{v.receipts[0].kind='problem';});
    if(change==='active source')s.managed.controllers.set(s.projectId,{store:{root:s.runtime,state:s.store.state}});
    if(change==='project') {const require=s.host.requireProject.bind(s.host);s.host.requireProject=async id=>({...await require(id),root:s.root});}
    await options.beforeCommit();
  }});
  await assert.rejects(s.exporter.export(s.input()),e=>change==='project'?e.code==='PROJECT_ROOT_MISSING':/^(REPORT_CHANGED|MATERIAL_)/.test(e.code));assert.deepEqual(await fs.readdir(s.project),s.projectEntries);
});

test('offline create-only, retained draft, IME synchronization and concurrent names preserve user content',async t=>{
  const s=await setup(t);await fs.writeFile(path.join(s.project,'existing.md'),'external');
  await assert.rejects(s.exporter.export(s.input('existing.md')),e=>e.code==='CONFLICT');
  const read=await s.host.readFile(s.projectId,'existing.md');await s.host.draft(s.projectId,'draft.md',read.digest,'retained');
  await assert.rejects(s.exporter.export(s.input('draft.md')),e=>e.code==='UNSAVED');
  s.exporter.beforeOperation=async()=>{await s.host.draft(s.projectId,'ime.md',read.digest,'IME buffer');return ()=>{};};
  await assert.rejects(s.exporter.export(s.input('ime.md')),e=>e.code==='UNSAVED');
  s.exporter.beforeOperation=async()=>()=>{};
  const results=await Promise.allSettled(Array.from({length:10},()=>s.exporter.export(s.input('parallel.md'))));
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1);assert.ok(results.filter(v=>v.status==='rejected').every(v=>v.reason.code==='CONFLICT'));
  const replace=s.host.replaceFile.bind(s.host);s.host.replaceFile=(abs,bytes,options)=>replace(abs,bytes,{...options,beforeCommit:async()=>{await options.beforeCommit();await fs.writeFile(abs,'external race',{flag:'wx'});}});
  await assert.rejects(s.exporter.export(s.input('race.md')),e=>e.code==='CONFLICT');
  assert.equal(await fs.readFile(path.join(s.project,'race.md'),'utf8'),'external race');
  assert.equal(await fs.readFile(path.join(s.project,'existing.md'),'utf8'),'external');
  assert.equal(await fs.readFile(path.join(s.project,'parallel.md'),'utf8'),s.oldBody);
  assert.equal((await s.host.readDraftRecord(s.projectId,'draft.md')).text,'retained');
  assert.equal((await s.host.readDraftRecord(s.projectId,'ime.md')).text,'IME buffer');await s.invariant();
});

test('active unstarted source ignores divergent persisted receipts, but not damaged report objects',async t=>{
  const s=await setup(t);
  s.managed.controllers.set(s.projectId,{started:false,store:{root:s.runtime,state:s.store.state}});
  await s.rewrite(state=>{state.receipts=[];});
  const source=await s.managed.reportSource(s.projectId,s.old.objectId);
  assert.equal(source.mode,'active');assert.equal((await source.read()).toString(),s.oldBody);
  await s.exporter.export(s.input());assert.equal(await fs.readFile(path.join(s.project,'copy.md'),'utf8'),s.oldBody);
  await fs.unlink(s.source);
  await assert.rejects(s.exporter.export(s.input('missing.md')),e=>/^(REPORT_|MATERIAL_)/.test(e.code));
  assert.deepEqual(s.calls(),{opens:0,connects:0,starts:0,stops:0});
});

test('unreadable live state is not replaced by offline history and reports survive execution removal',async t=>{
  const s=await setup(t);
  s.managed.controllers.set(s.projectId,{store:{root:s.runtime,state:null}});
  await assert.rejects(s.exporter.export(s.input()),e=>e.code==='REPORT_INVALID');
  s.managed.controllers.clear();await fs.rm(s.runtime,{recursive:true});
  await s.exporter.export(s.input());assert.equal(await fs.readFile(path.join(s.project,'copy.md'),'utf8'),s.oldBody);
  await assert.rejects(fs.stat(s.runtime),e=>e.code==='ENOENT');
  assert.deepEqual(s.calls(),{opens:0,connects:0,starts:0,stops:0});
});

test('cold offline HTML exports frozen self-contained bytes with no provider or state writes',async t=>{
  const s=await setup(t,{html:true}),original=await fs.readFile(s.source);
  await s.exporter.export(s.input());
  assert.deepEqual(await fs.readFile(path.join(s.project,'copy.html')),original);
  assert.deepEqual(await fs.readFile(s.source),original);
  await assert.rejects(s.exporter.export(s.input('wrong.md')),e=>e.code==='BAD_PATH');
  await s.invariant();
});

test('stored Markdown descriptors export exact historical CRLF bytes read-only',async t=>{
  const s=await setup(t),source=await s.managed.reportSource(s.projectId,s.old.objectId);
  assert.equal(source.report.format,'markdown');assert.equal(source.report.mediaType,'text/markdown');
  assert.deepEqual(await source.read(),Buffer.from(s.oldBody));
  await s.exporter.export(s.input());
  assert.deepEqual(await fs.readFile(path.join(s.project,'copy.md')),Buffer.from(s.oldBody));
  await s.invariant();
});

test('offline HTML export accepts canonical objects above the legacy eight MiB body cap',async t=>{
  const s=await setup(t,{html:true});
  // Host-produced data-image envelopes can exceed the author-input limit.
  const body='<!doctype html><html><head><title>Frozen envelope</title></head><body><p>Frozen report</p><!--'+'x'.repeat(9*1024*1024)+'--></body></html>';
  const bytes=Buffer.from(body),report=reportDescriptor(bytes,{format:'html-static',objectId:s.old.objectId});
  await s.host.storage.putObject(s.projectId,bytes);
  await s.rewrite(state=>{state.receipts[0].report=report;state.receipts[0].snapshot.reportDigest=report.digest;});
  const before=await readManagedState(s.host.storage,s.projectId);
  await s.exporter.export(s.input('large.html'));
  assert.deepEqual(await fs.readFile(path.join(s.project,'large.html')),bytes);assert.deepEqual(await s.host.storage.readObject(s.projectId,report.digest),bytes);
  assert.deepEqual(await readManagedState(s.host.storage,s.projectId),before);assert.deepEqual(s.calls(),{opens:0,connects:0,starts:0,stops:0});
});
