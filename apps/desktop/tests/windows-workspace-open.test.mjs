// Real shared public open path with explicit native Windows custody and storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {SessionIndex} from '../src/agents/managed/session-index.mjs';
import {MemoryVersion} from '../src/agents/managed/memory-version.mjs';
import {createExperimentalWindowsWorkspaceIO} from '../src/platform/windows/experimental-workspace-io.mjs';
import {security} from './fixtures/windows-security.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:45000};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli open 中文 ')),content=path.join(root,'project'),runtime=path.join(root,'runtime');await fs.mkdir(content);
  const storage=new ProjectStorage(path.join(root,'profile'),{experimentalWindowsRoot:root,experimentalWindowsInitialization:true}),projectId=(await storage.register(content)).id,stores=[];
  t.after(async()=>{for(const store of stores)if(!store.closed)store.custody.abandon();await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
  const options={storage,projectId};
  return {root,content,runtime,storage,projectId,stores,options,
    async open(extra={}){const store=await Workspace.open(runtime,content,{...options,workspaceIO:createExperimentalWindowsWorkspaceIO({root}),...extra});stores.push(store);return store;},
    async controller(extra={}){const controller=await Controller.open({...options,runtimeRoot:runtime,contentRoot:content,workspaceIO:createExperimentalWindowsWorkspaceIO({root}),...extra});stores.push(controller.store);return controller;},
  };
}

test('real Workspace.open persists drafts and Work activation, exact warm receipt reopens without replay',native,async t=>{
  const f=await fixture(t),store=await f.open();assert.equal(store.hostLease.facts().host.pid,process.pid);
  await assert.rejects(fs.stat(path.join(f.runtime,'host.lock')),{code:'ENOENT'});
  await store.setDraft('frontdesk','未发送草稿 😀');const work=await store.submit('合成任务','明确交接');await store.activate(work.id);
  assert.ok((await fs.stat(store.agentHome(work.id))).isDirectory());
  const receipt=await store.close();assert.equal(receipt.record.phase,'retired');
  const reopened=await f.open({workspaceIO:createExperimentalWindowsWorkspaceIO({root:f.root,previousHostRelease:receipt})});
  assert.equal(reopened.state.drafts.frontdesk,'未发送草稿 😀');assert.equal(reopened.find(work.id).status,'running');assert.equal((reopened.state.jobs??[]).length,0);await reopened.close();
});

test('default unsupported Windows open and unbranded adapters refuse before runtime creation',native,async t=>{
  const f=await fixture(t);await assert.rejects(Workspace.open(f.runtime,f.content,f.options),{code:'PROCESS_OWNERSHIP_UNSUPPORTED'});
  await assert.rejects(f.open({workspaceIO:{acquire(){assert.fail('unbranded acquisition');}}}),{code:'WORKSPACE_IO_INVALID'});
  await assert.rejects(fs.stat(f.runtime),{code:'ENOENT'});
});

test('overlapping runtime refuses before native host anchor acquisition',native,async t=>{
  const f=await fixture(t);await assert.rejects(Workspace.open(path.join(f.content,'runtime'),f.content,{...f.options,workspaceIO:createExperimentalWindowsWorkspaceIO({root:f.root})}),/overlap/);
  const binding=await f.storage.requireOnline(f.projectId);await assert.rejects(fs.stat(path.join(binding.metadataRoot,'managed-host.lease')),{code:'ENOENT'});
});

test('different runtime cannot bypass live project custody and retained runtime resists independent rename',native,async t=>{
  const f=await fixture(t),store=await f.open(),other=path.join(f.root,'other-runtime');
  await assert.rejects(Workspace.open(other,f.content,{...f.options,workspaceIO:createExperimentalWindowsWorkspaceIO({root:f.root})}),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===32);
  await assert.rejects(fs.stat(other),{code:'ENOENT'});
  const result=spawnSync(process.execPath,['-e',"try{require('fs').renameSync(process.argv[1],process.argv[2]);}catch(e){console.log(e.code);process.exitCode=7;}",f.runtime,f.runtime+'-moved'],{windowsHide:true,encoding:'utf8',timeout:10000,env:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}});
  assert.ifError(result.error);assert.equal(result.status,7);assert.match(result.stdout,/EPERM|EACCES|EBUSY|UNKNOWN/);await store.close();
});

test('serialized release cannot authorize public reopen; the unused receipt then the durable normal-release publication each reopen once without replay',native,async t=>{
  const f=await fixture(t),store=await f.open();await store.setDraft('frontdesk','保留');const receipt=await store.close();
  await assert.rejects(f.open({workspaceIO:createExperimentalWindowsWorkspaceIO({root:f.root,previousHostRelease:structuredClone(receipt)})}),{code:'HOST_LEASE_RECOVERY_REQUIRED'});
  const next=await f.open({workspaceIO:createExperimentalWindowsWorkspaceIO({root:f.root,previousHostRelease:receipt})});assert.equal(next.state.drafts.frontdesk,'保留');const warmReceipt=await next.close();
  // Receipt-less fresh-process reopen: only the durable terminal normal-release
  // publication of the retired generation authorizes one successor activation
  // with a fresh host lease, retained drafts and no Work replay.
  const restarted=await f.open(),facts=restarted.hostLease.facts();
  assert.notEqual(facts.leaseId,warmReceipt.record.leaseId);assert.equal(facts.coldRecoveryQualified,false);
  assert.equal(restarted.state.drafts.frontdesk,'保留');assert.equal((restarted.state.jobs??[]).length,0);
  await restarted.close();
});

test('shared SessionIndex archives through native create-only writes and reloads exact immutable bytes',native,async t=>{
  const f=await fixture(t),store=await f.open(),index=new SessionIndex(store);await index.initialize();
  const fact={sessionId:'synthetic-session',epoch:'synthetic-epoch',entry:{id:'entry-1',type:'custom',customType:'synthetic',data:{text:'历史原文'}}};
  await index.recordBatch([fact],'frontdesk');const record=index.records()[0];assert.deepEqual(await new SessionIndex(store).object(record),fact.entry);
  await index.recordBatch([fact],'frontdesk');assert.equal(index.records().length,1);
  const receipt=await store.close(),next=await f.open({workspaceIO:createExperimentalWindowsWorkspaceIO({root:f.root,previousHostRelease:receipt})}),cold=new SessionIndex(next);await cold.initialize();assert.deepEqual(await cold.object(cold.records()[0]),fact.entry);await next.close();
});

test('corrupt preexisting SessionIndex object is retained and never enters durable projection',native,async t=>{
  const f=await fixture(t),store=await f.open(),index=new SessionIndex(store);await index.initialize();
  const entry={id:'entry-corrupt',type:'custom',customType:'synthetic'},file=path.join(index.root,sha(Buffer.from(JSON.stringify(entry)))+'.json');await store.io.writeImmutable(file,Buffer.from('independent corrupt winner'));
  await assert.rejects(index.recordBatch([{sessionId:'synthetic',entry}],'frontdesk'),{code:'TIMELINE_CORRUPT'});assert.equal(await fs.readFile(file,'utf8'),'independent corrupt winner');assert.equal(index.records().length,0);await store.close();
});

test('shared Plan Tree archive uses native SHA CAS and preserves a concurrent external winner',native,async t=>{
  const f=await fixture(t),store=await f.open(),work=await store.submit('归档任务','合成说明');
  await store.mutate(()=>{store.find(work.id).closure={phase:'complete',git:{status:'discarded'},report:{relPath:'reports/synthetic.md',kind:'markdown',source:'synthetic',summary:'合成结论'}};});
  await store.updateClosureArchive(work.id);const before=await fs.readFile(store.plan,'utf8');assert.match(before,new RegExp('report:'+work.id));
  const original=store.io;store.io={...original,async writeVersioned(file,bytes,options){await original.writeVersioned(file,Buffer.from('external winner\n'),{expectedSha256:sha(await original.readFile(file))});return original.writeVersioned(file,bytes,options);}};
  await store.mutate(()=>{store.find(work.id).closure.report.summary='新结论';});
  await assert.rejects(store.updateClosureArchive(work.id),{code:'FS_VERSION_CONFLICT'});assert.equal(await fs.readFile(store.plan,'utf8'),'external winner\n');await store.close();
});

test('native MemoryVersion reads linked topics and changes digest with actual content',native,async t=>{
  const f=await fixture(t),store=await f.open(),directory=path.dirname(store.plan),topic=path.join(directory,'topics','sample.md');await store.io.ensureDirectory(path.dirname(topic));await store.io.writeImmutable(topic,Buffer.from('主题 😀'));
  await store.io.writeVersioned(store.plan,Buffer.from('# Memory\n[topic](topics/sample.md)\n'),{expectedSha256:sha(await store.io.readFile(store.plan))});
  const memory=new MemoryVersion(directory,{readFile:store.io.readMemoryFile}),first=await memory.snapshot();assert.equal(first.topics[0].text,'主题 😀');
  await store.io.writeVersioned(topic,Buffer.from('新版本'),{expectedSha256:first.topics[0].digest});assert.notEqual((await memory.snapshot()).version,first.version);await store.close();
});

test('real Controller.open restores shared state without launching or consuming pending input',native,async t=>{
  const f=await fixture(t),store=await f.open();await store.setDraft('frontdesk','不要发送');await store.submit('排队任务','尚未授权执行');const receipt=await store.close();
  const controller=await f.controller({workspaceIO:createExperimentalWindowsWorkspaceIO({root:f.root,previousHostRelease:receipt})});
  assert.equal(controller.store.state.drafts.frontdesk,'不要发送');assert.equal(controller.store.state.works[0].status,'queued');assert.equal(controller.sessions.size,0);assert.equal(controller.started,false);assert.equal(controller.running.size,0);assert.equal(controller.store.state.jobs.length,0);
  // alpha.5 keeps never-admitted work eligible after explicit Controller.start;
  // opening a workspace itself still neither consumes drafts nor starts owners.
  assert.equal(controller.coldQueued.size,0);
  const result=await controller.stop();assert.equal(result.confirmationComplete,true);assert.equal(result.hostRelease.record.phase,'retired');
});

test('runtime ACL drift refuses business mutation before callback effects and preserves draft',native,async t=>{
  const f=await fixture(t),store=await f.open();await store.setDraft('frontdesk','已有草稿');security('add-write',f.runtime);let called=false;
  await assert.rejects(store.mutate(()=>{called=true;}),{code:'FS_STAGE_CHANGED'});assert.equal(called,false);assert.deepEqual(await f.storage.getRecovery(f.projectId,'managed:drafts'),{frontdesk:'已有草稿'});
});

test('host loss after actual recovery commit retains UNKNOWN and refuses host retirement or replay',native,async t=>{
  const f=await fixture(t),store=await f.open(),original=f.storage.putRecovery.bind(f.storage);let effect=false;
  f.storage.putRecovery=async(...args)=>{const result=await original(...args);if(args[1]==='managed:drafts'){effect=true;store.custody.abandon();}return result;};
  await assert.rejects(store.setDraft('frontdesk','已落盘但结果未知'),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(effect,true);assert.ok(store.commitUnknown);
  assert.deepEqual(await f.storage.getRecovery(f.projectId,'managed:drafts'),{frontdesk:'已落盘但结果未知'});await assert.rejects(store.close(),{code:'STORAGE_RESULT_UNKNOWN'});
  await assert.rejects(f.open(),{code:'HOST_LEASE_RECOVERY_REQUIRED'});
});

test('an actual SQLite host-record winner fences shared mutations before business effects',native,async t=>{
  const f=await fixture(t),store=await f.open();await store.setDraft('frontdesk','赢家竞争前的草稿');
  const database=path.join(await f.storage.localDirectory(f.projectId),'ui.sqlite'),before=await f.storage.db.request(database,'record',{collection:'managed_host_leases',id:'host'}),winner={...before.value,external:'independent winner'};
  await f.storage.db.request(database,'put',{collection:'managed_host_leases',id:'host',value:winner,expectedRevision:before.revision,operationId:'synthetic-external-winner'});let called=false;
  await assert.rejects(store.mutate(()=>{called=true;}),{code:'HOST_LEASE_BINDING_CHANGED'});assert.equal(called,false);
  assert.deepEqual((await f.storage.db.request(database,'record',{collection:'managed_host_leases',id:'host'})).value,winner);assert.deepEqual(await f.storage.getRecovery(f.projectId,'managed:drafts'),{frontdesk:'赢家竞争前的草稿'});
});

test('native Worker home archival requires completed shared closure before touching active session history',native,async t=>{
  const f=await fixture(t),store=await f.open(),work=await store.submit('待归档','合成');await store.activate(work.id);const file=path.join(store.agentHome(work.id),'history.jsonl');await store.io.writeImmutable(file,Buffer.from('retained history'));
  await assert.rejects(store.cleanupWorkerHome(work.id),/cleanup prerequisites missing/);assert.equal(await fs.readFile(file,'utf8'),'retained history');await store.close();
});

test('shared Worker home opener preserves replacement roots and requires the retained native directory File ID',native,async t=>{
  const f=await fixture(t),store=await f.open(),work=await store.submit('归档身份','合成');await store.activate(work.id);const home=store.agentHome(work.id);
  await store.io.writeImmutable(path.join(home,'journal'),Buffer.from('original bytes'));const tree=await store.io.openWorkerHome(home),identity=tree.manifest.rootIdentity;tree.close();
  await fs.rename(home,home+'-original');await store.io.ensureDirectory(home);await store.io.writeImmutable(path.join(home,'journal'),Buffer.from('original bytes'));
  await assert.rejects(store.io.openWorkerHome(home,{expectedIdentity:identity}),{code:'FS_DIRECTORY_CONFLICT'});assert.equal(await fs.readFile(path.join(home,'journal'),'utf8'),'original bytes');assert.equal(await fs.readFile(path.join(home+'-original','journal'),'utf8'),'original bytes');
  assert.equal(await store.io.openWorkerHome(path.join(store.root,'agents','absent')),null);await store.close();
});

test('serialized retired Worker owner rows never authorize shared home archival',native,async t=>{
  const f=await fixture(t),store=await f.open(),work=await store.submit('未证明的退休','合成');await store.activate(work.id);const home=store.agentHome(work.id),database=path.join(await f.storage.localDirectory(f.projectId),'ui.sqlite');
  await store.io.writeImmutable(path.join(home,'journal'),Buffer.from('retained'));
  await f.storage.db.request(database,'put',{collection:'managed_owner_launches',id:work.id,value:{target:work.id,home,phase:'retired',exit:{confirmationComplete:true}}});
  await assert.rejects(store.io.verifyWorkerRetirement({workId:work.id,home}),{code:'HOST_LEASE_OWNER_UNVERIFIED'});assert.equal(await fs.readFile(path.join(home,'journal'),'utf8'),'retained');
});

test('another registered project cannot reuse the original runtime or overwrite its immutable binding',native,async t=>{
  const f=await fixture(t),store=await f.open(),file=path.join(f.runtime,'workspace-binding.json'),before=await fs.readFile(file),other=path.join(f.root,'other-project');await fs.mkdir(other);const projectId=(await f.storage.register(other)).id;
  await assert.rejects(Workspace.open(f.runtime,other,{storage:f.storage,projectId,workspaceIO:createExperimentalWindowsWorkspaceIO({root:f.root})}),{code:'WORKSPACE_BINDING_CHANGED'});
  assert.deepEqual(await fs.readFile(file),before);await store.setDraft('frontdesk','原项目不受影响');await store.close();
});

test('actual public-open host exit preserves durable draft and active marker; cold reopen refuses replay',native,async t=>{
  const f=await fixture(t),script=`import {ProjectStorage} from ${JSON.stringify(new URL('../src/main/project-storage.mjs',import.meta.url).href)};
    import {Workspace} from ${JSON.stringify(new URL('../src/agents/managed/workspace.mjs',import.meta.url).href)};
    import {createExperimentalWindowsWorkspaceIO} from ${JSON.stringify(new URL('../src/platform/windows/experimental-workspace-io.mjs',import.meta.url).href)};
    const i=JSON.parse(process.argv[2]),storage=new ProjectStorage(i.profile,{experimentalWindowsRoot:i.root,experimentalWindowsInitialization:true});
    const store=await Workspace.open(i.runtime,i.content,{storage,projectId:i.projectId,workspaceIO:createExperimentalWindowsWorkspaceIO({root:i.root})});
    await store.setDraft('frontdesk','进程已退出，草稿未发送');process.exit(23);`;
  const scriptFile=path.join(f.root,'synthetic-public-open.mjs');await fs.writeFile(scriptFile,script);
  const result=spawnSync(process.execPath,[scriptFile,JSON.stringify({root:f.root,profile:path.join(f.root,'profile'),runtime:f.runtime,content:f.content,projectId:f.projectId})],{windowsHide:true,encoding:'utf8',timeout:30000,env:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}});
  assert.ifError(result.error);assert.equal(result.status,23,result.stderr);assert.deepEqual(await f.storage.getRecovery(f.projectId,'managed:drafts'),{frontdesk:'进程已退出，草稿未发送'});
  await assert.rejects(f.open(),{code:'HOST_LEASE_RECOVERY_REQUIRED'});const database=path.join(await f.storage.localDirectory(f.projectId),'ui.sqlite');assert.equal((await f.storage.db.request(database,'record',{collection:'managed_host_leases',id:'host'})).value.phase,'active');
});
