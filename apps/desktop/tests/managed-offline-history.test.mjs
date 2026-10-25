import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {staticReport,historicalMarkdownState} from './static-report.fixture.mjs';
import {managedRuntime,readManagedState} from '../src/agents/managed/managed-storage.mjs';
import {writeTestState} from './project-storage.fixture.mjs';
import {reportDescriptor} from '../src/agents/managed/report-descriptor.mjs';

async function setup(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-offline-history-'));
  t.after(async()=>{await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
  const project=path.join(root,'project');await fs.mkdir(project);
  const profile=path.join(root,'profile'),host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;
  let opens=0,connects=0;
  const sourceRoot=path.join(root,'private-omp'),ompSystemSource={private:true,root:sourceRoot,agentDir:path.join(sourceRoot,'agent')};
  const managed=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},ompSystemSource,openController:async options=>{
    assert.equal(options.ompSystemSource,ompSystemSource);
    opens++;return {on(){},start:async()=>{throw Error('OMP native startup failed');},stop:async()=>{}};
  }});
  const connect=managed.connect.bind(managed);managed.connect=(...args)=>{connects++;return connect(...args);};
  const runtime=await managedRuntime(host.storage,projectId),store=await Workspace.open(runtime,project,{storage:host.storage,projectId});
  const work=await store.submit('request','brief',{name:'同名工作'});await store.activate(work.id);
  const oldBody='旧问题\r\n',latestBody='# 新报告\n',bodies=new Map();
  const old=await store.publish(work.id,1,'problem',oldBody,'old');await store.settle(work.id);
  await store.continue(work.id);const latest=await store.publish(work.id,2,'result',staticReport(latestBody),'latest');await store.settle(work.id);
  bodies.set(old.objectId,oldBody);bodies.set(latest.objectId,latestBody);await historicalMarkdownState(store,bodies);
  const baseline=await readManagedState(host.storage,projectId),binding=await host.storage.requireRegistered(projectId);
  for(const row of baseline.receipts)await fs.unlink(path.join(await host.storage.recoveryDirectory(projectId),'objects','sha256',row.report.digest));
  const tree=await fs.readdir(runtime,{recursive:true}),objectPath=row=>path.join(binding.metadataRoot,'objects','sha256',row.report.digest);
  const list=(query={})=>managed.invoke('managed.history.list',{projectId,...query});
  const read=(objectId=old.objectId,query={})=>managed.invoke('managed.history.read',{projectId,objectId,...query});
  return {root,host,projectId,managed,runtime,store,old:baseline.receipts[0],latest:baseline.receipts[1],oldBody,latestBody,bodies,objectPath,list,read,
    rewrite:async fn=>{const state=structuredClone(baseline);fn(state);await writeTestState(store,state);},
    reset:()=>{opens=connects=0;},calls:()=>({opens,connects}),
    invariant:async()=>{assert.deepEqual(await readManagedState(host.storage,projectId),baseline);assert.deepEqual(await fs.readdir(runtime,{recursive:true}),tree);assert.deepEqual({opens,connects},{opens:0,connects:0});await assert.rejects(fs.stat(sourceRoot),e=>e.code==='ENOENT');}
  };
}

test('cold Host history lists metadata and reads exact historical/current reports without connections or writes',async t=>{
  const s=await setup(t),page=await s.list();assert.equal(page.projectId,s.projectId);assert.equal(page.mode,'offline');assert.equal(page.total,2);
  assert.deepEqual(new Set(page.items.map(r=>r.kind)),new Set(['problem','result']));
  assert.ok(page.items.every(r=>r.objectVerified===false&&r.workName==='同名工作'));
  assert.equal(page.items.find(r=>r.objectId===s.old.objectId).revision,1);
  for(const row of [s.old,s.latest]) {const read=await s.read(row.objectId,{version:page.version});assert.equal(read.bodyAvailability,'inline');assert.equal(read.body,s.bodies.get(row.objectId));assert.equal(read.report.format,'markdown');assert.equal(Object.hasOwn(read,'text'),false);assert.equal(read.version,page.version);assert.equal(read.objectVerified,true);assert.equal(read.byteLength,Buffer.byteLength(s.bodies.get(row.objectId)));}
  assert.ok(!JSON.stringify(page).includes('workspaceId'));assert.equal(JSON.parse(JSON.stringify(page)).total,2);await s.invariant();
});

test('production connect startup failure does not prevent readonly history or reconnect',async t=>{
  const s=await setup(t);await assert.rejects(s.managed.connect(s.projectId,{enable:true}),/OMP native startup failed/);assert.deepEqual(s.calls(),{opens:1,connects:1});assert.equal(s.managed.controllers.size,0);s.reset();
  assert.equal((await s.list()).total,2);assert.equal((await s.read()).body,s.oldBody);await s.invariant();
});

test('two registered projects isolate same-name reports and object IDs; unknown project rejects',async t=>{
  const s=await setup(t),other=path.join(s.root,'other');await fs.mkdir(other);const id=(await s.host.pick(other)).project.id;
  const runtime=await managedRuntime(s.host.storage,id),store=await Workspace.open(runtime,other,{storage:s.host.storage,projectId:id}),work=await store.submit('other','brief',{name:'同名工作'});await store.activate(work.id);
  const row=await store.publish(work.id,1,'result',staticReport('other body'),'other');await store.close();
  assert.equal((await s.managed.invoke('managed.history.list',{projectId:id})).items[0].workName,'同名工作');
  const detail=await s.managed.invoke('managed.history.read',{projectId:id,objectId:row.objectId});
  assert.equal(detail.report.format,'html-static');assert.equal(detail.bodyAvailability,'isolated-source-only');assert.equal(Object.hasOwn(detail,'body'),false);
  const source=await s.managed.reportSource(id,row.objectId),bytes=await source.read();
  assert.equal(bytes.byteLength,detail.byteLength);assert.equal(createHash('sha256').update(bytes).digest('hex'),detail.report.digest);assert.match(bytes.toString('utf8'),/other body/);
  await assert.rejects(s.managed.invoke('managed.history.read',{projectId:id,objectId:s.old.objectId}),e=>e.code==='REPORT_MISSING');
  await assert.rejects(s.read(row.objectId),e=>e.code==='REPORT_MISSING');await assert.rejects(s.list({projectId:'unknown'}),e=>e.code==='UNKNOWN_PROJECT');await s.invariant();
});

test('pagination is deterministic, bounded, version-bound and rejects changed snapshots',async t=>{
  const s=await setup(t);await s.rewrite(state=>{for(let i=0;i<103;i++){const objectId=randomUUID();state.receipts.push({...state.receipts[0],snapshot:undefined,id:'extra'+i,objectId,report:{...state.receipts[0].report,objectId,excerpt:'x'.repeat(512)}});}});
  const first=await s.list();assert.equal(first.items.length,50);assert.equal(first.nextOffset,50);assert.equal(first.limit,50);assert.ok(first.items.every(r=>r.excerpt.length<=512));
  const again=await s.list();assert.deepEqual(again,first);
  const second=await s.list({offset:50,version:first.version}),last=await s.list({offset:100,version:first.version});
  assert.equal(second.items.length,50);assert.equal(last.items.length,5);assert.equal(last.nextOffset,null);assert.equal(new Set([...first.items,...second.items,...last.items].map(r=>r.objectId)).size,105);
  assert.equal((await s.list({limit:100})).items.length,100);assert.equal((await s.list({offset:105,version:first.version})).items.length,0);
  for(const q of [{limit:101},{limit:0},{limit:1.5},{offset:-1},{offset:1},{offset:106,version:first.version},{version:'bad'}])await assert.rejects(s.list(q),e=>e.code==='INVALID_PAYLOAD');
  const state=await readManagedState(s.host.storage,s.projectId);state.limit++;await writeTestState(s.store,state);
  await assert.rejects(s.list({offset:50,version:first.version}),e=>e.code==='REPORT_CHANGED');await assert.rejects(s.read(s.old.objectId,{version:first.version}),e=>e.code==='REPORT_CHANGED');
  assert.notEqual((await s.list()).version,first.version);assert.deepEqual(s.calls(),{opens:0,connects:0});
});

test('active unstarted memory is authoritative; unreadable memory never falls back',async t=>{
  const s=await setup(t),state=structuredClone(s.store.state);state.works[0].name='memory';s.managed.controllers.set(s.projectId,{started:false,store:{root:s.runtime,state}});
  await s.rewrite(persisted=>{persisted.receipts=[];});const page=await s.list();assert.equal(page.mode,'active');assert.equal(page.items[0].workName,'memory');assert.equal((await s.read()).body,s.oldBody);
  state.works[0].name='changed';await assert.rejects(s.read(s.old.objectId,{version:page.version}),e=>e.code==='REPORT_CHANGED');
  s.managed.controllers.get(s.projectId).store.state=null;await assert.rejects(s.list(),e=>e.code==='REPORT_INVALID');await assert.rejects(s.read(),e=>e.code==='REPORT_INVALID');assert.deepEqual(s.calls(),{opens:0,connects:0});
});

for(const [name,mutate] of [
  ['duplicate object',s=>s.rewrite(v=>{v.receipts.push({...v.receipts[0],id:'dup'});})],
  ['array object identity',s=>s.rewrite(v=>{v.receipts[0].objectId=[v.receipts[0].objectId];})],
  ['foreign work',s=>s.rewrite(v=>{v.receipts[0].workId='foreign';})],
  ['future revision',s=>s.rewrite(v=>{v.receipts[0].revision=100;})],
  ['digest',s=>s.rewrite(v=>{v.receipts[1].snapshot.reportDigest='bad';})],
])test(`list/read reject ${name} without repairing state`,async t=>{
  const s=await setup(t);await mutate(s);const before=await readManagedState(s.host.storage,s.projectId);
  await assert.rejects(s.list(),e=>/^REPORT_/.test(e.code));await assert.rejects(s.read(),e=>/^REPORT_/.test(e.code));
  assert.deepEqual(await readManagedState(s.host.storage,s.projectId),before);assert.deepEqual(s.calls(),{opens:0,connects:0});
});

for(const [name,mutate] of [
  ['missing',file=>fs.unlink(file)],['tampered',file=>fs.writeFile(file,'tampered')],['oversize',file=>fs.truncate(file,256*1024*1024+1)],
  ['symlink',async(file,s)=>{const dest=path.join(s.root,'object');await fs.rename(file,dest);await fs.symlink(dest,file);}],
  ['parent symlink',async(file,s)=>{const dir=path.dirname(file),dest=path.join(s.root,'objects');await fs.rename(dir,dest);await fs.symlink(dest,dir);}],
])test(`list does not claim verification; read rejects ${name} object`,async t=>{
  const s=await setup(t);await mutate(s.objectPath(s.old),s);
  const page=await s.list();assert.equal(page.total,2);assert.ok(page.items.every(r=>r.objectVerified===false));await assert.rejects(s.read(),e=>/^(REPORT_|MATERIAL_|INVALID_MATERIAL$|INVALID_DIRECTORY$)/.test(e.code));assert.deepEqual(s.calls(),{opens:0,connects:0});
});

test('removed execution runtime does not remove project-owned report history or initialize execution',async t=>{
  const s=await setup(t);await fs.rm(s.runtime,{recursive:true});const page=await s.list();assert.equal(page.total,2);
  assert.equal((await s.read()).body,s.oldBody);await assert.rejects(fs.stat(s.runtime),e=>e.code==='ENOENT');assert.deepEqual(s.calls(),{opens:0,connects:0});
});

test('history cannot accept paths, text, controls or executable capabilities',async t=>{
  const s=await setup(t);
  for(const extra of [{path:s.objectPath(s.old)},{text:'fake'},{runtime:s.runtime},{workId:'x'},{action:'resolve'}])await assert.rejects(s.list(extra),e=>e.code==='INVALID_PAYLOAD');
  for(const objectId of ['../state.json','not-uuid',null])await assert.rejects(s.read(objectId));
  const read=await s.read();assert.equal('read' in read,false);assert.equal('state' in read,false);await s.invariant();
});

test('read accepts a canonical eight MiB Markdown object without inline receipt text',async t=>{
  const s=await setup(t),text='x'.repeat(8*1024*1024),report=reportDescriptor(Buffer.from(text),{format:'markdown',objectId:s.old.objectId});
  await s.host.storage.putObject(s.projectId,Buffer.from(text));await s.rewrite(state=>{state.receipts[0].report=report;state.receipts[0].snapshot.reportDigest=report.digest;});
  const page=await s.list({limit:1});assert.equal(page.items.length,1);
  const result=await s.read(s.old.objectId,{version:page.version});assert.equal(result.body,text);assert.equal(result.byteLength,8*1024*1024);
});
