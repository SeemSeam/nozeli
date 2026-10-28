import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DesktopHost} from '../src/main/host.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {ManagedReportExporter} from '../src/main/managed-report-export.mjs';
import {staticReport,historicalMarkdownState} from './static-report.fixture.mjs';
import {managedRuntime} from '../src/agents/managed/managed-storage.mjs';
import {managedReportSource,managedArtifact,managedHistory} from '../src/agents/managed-report-source.mjs';

// Real Host registry/drafts/atomic writes and real Workspace publication/object.
// The binding lookup has no Provider; this is file safety, not CLI acceptance.
async function setup(t,{html=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-report-export-'));
  const project=path.join(root,'project');await fs.mkdir(project);
  const host=new DesktopHost(path.join(root,'profile')),projectId=(await host.pick(project)).project.id,storage=host.storage,binding=await storage.requireRegistered(projectId),runtime=await managedRuntime(storage,projectId);
  let store=await Workspace.open(runtime,project,{storage,projectId});
  const work=await store.submit('request','brief',{name:'真实报告'});await store.activate(work.id);
  let text=html?staticReport('Unicode 中文、空行与尾换行。'):'# 原始报告\r\n\r\nUnicode 中文、空行与尾换行。\r\n\r\n[原文件](source.md)\r\n';
  await fs.mkdir(path.join(project,'reports'));await fs.writeFile(path.join(project,'reports/generated.md'),'# Frozen artifact\n\n中文内容\n');
  let receipt=await store.publish(work.id,1,'result',html?text:staticReport('Historical seed'),'receipt-1',{files:[{relPath:'reports/generated.md'}]});await store.settle(work.id);
  if(!html){await historicalMarkdownState(store,new Map([[receipt.objectId,text]]));store=await Workspace.open(runtime,project,{storage,projectId});receipt=store.state.receipts[0];}
  if(html)text=(await store.readObject(receipt.report.digest)).toString('utf8');
  await fs.unlink(path.join(await storage.recoveryDirectory(projectId),'objects','sha256',receipt.report.digest));
  const projectEntries=await fs.readdir(project);
  const managedAgents={controller:id=>{assert.equal(id,projectId);return {store};},reportSource:async(id,objectId)=>managedReportSource({project:await storage.requireRegistered(id),storage,runtime,objectId,controller:{store}})};
  const artifactController={store};managedAgents.artifactRead=async(id,{objectId,relPath})=>managedArtifact({project:await storage.requireRegistered(id),storage,runtime,controller:artifactController,currentController:()=>artifactController},{objectId,relPath});
  let holds=0,releases=0;
  const exporter=new ManagedReportExporter({host,managedAgents,beforeOperation:async()=>{holds++;return ()=>{releases++;};}});
  t.after(async()=>{await store.close();await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
  const input=relPath=>({projectId,objectId:receipt.objectId,relPath});
  const noTemps=async()=>assert.equal((await fs.readdir(project)).some(n=>n.startsWith('.nozeli-tmp-')),false);
  const objectPath=receipt=>path.join(binding.metadataRoot,'objects','sha256',receipt.report.digest);
  return {root,project,projectEntries,host,projectId,store,receipt,text,managedAgents,exporter,input,noTemps,objectPath,counts:()=>({holds,releases})};
}

test('copies exact external report bytes, preserves original, registry and user edits',async t=>{
  const s=await setup(t);await fs.writeFile(path.join(s.project,'source.md'),'user original');
  const original=await s.host.readFile(s.projectId,'source.md');await s.host.draft(s.projectId,'source.md',original.digest,'user unsaved');
  const before=structuredClone(s.store.state),result=await s.exporter.export(s.input('阅读报告.md'));
  assert.equal(result.copied,true);assert.equal(result.byteLength,Buffer.byteLength(s.text));
  assert.equal(await fs.readFile(path.join(s.project,'阅读报告.md'),'utf8'),s.text);
  assert.equal((await s.store.readObject(s.receipt.report.digest)).toString('utf8'),s.text);
  assert.equal(await fs.readFile(path.join(s.project,'source.md'),'utf8'),'user original');
  assert.equal((await s.host.readDraftRecord(s.projectId,'source.md')).text,'user unsaved');
  assert.deepEqual(s.store.state,before);assert.deepEqual(s.counts(),{holds:1,releases:1});await s.noTemps();
});

test('older report object remains exportable after a newer revision is published',async t=>{
  const s=await setup(t),work=s.store.state.works[0];
  const revision=await s.store.continue(work.id),newText=staticReport('New revision');
  const latest=await s.store.publish(work.id,revision,'result',newText,'receipt-2');await s.store.settle(work.id);
  await s.exporter.export(s.input('旧版.md'));
  await s.exporter.export({...s.input('新版.html'),objectId:latest.objectId});
  assert.equal(await fs.readFile(path.join(s.project,'旧版.md'),'utf8'),s.text);
  assert.deepEqual(await fs.readFile(path.join(s.project,'新版.html')),await s.store.readObject(latest.report.digest));
  assert.equal(s.store.state.receipts.length,2);await s.noTemps();
});

test('refuses existing files, directories, links and unsafe portable names without touching them',async t=>{
  const s=await setup(t);await fs.writeFile(path.join(s.project,'existing.md'),'untouched');await fs.mkdir(path.join(s.project,'directory.md'));
  await fs.writeFile(path.join(s.root,'outside.md'),'outside');await fs.symlink(path.join(s.root,'outside.md'),path.join(s.project,'linked.md'));
  for(const name of ['existing.md','directory.md','linked.md','../outside.md','sub/report.md','C:\\report.md','.nozeli.md','CON.md','nul.more.md','bad?.md','bad\n.md','report.txt','space .md',''])
    await assert.rejects(()=>s.exporter.export(s.input(name)));
  assert.equal(await fs.readFile(path.join(s.project,'existing.md'),'utf8'),'untouched');assert.equal(await fs.readFile(path.join(s.root,'outside.md'),'utf8'),'outside');
  assert.equal((await fs.lstat(path.join(s.project,'linked.md'))).isSymbolicLink(),true);assert.deepEqual(s.counts(),{holds:0,releases:0});await s.noTemps();
});

test('twenty concurrent same-name copies create exactly one full file',async t=>{
  const s=await setup(t),results=await Promise.allSettled(Array.from({length:20},()=>s.exporter.export(s.input('并发.md'))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='CONFLICT'));
  assert.equal(await fs.readFile(path.join(s.project,'并发.md'),'utf8'),s.text);
  assert.equal(s.counts().holds,s.counts().releases);await s.noTemps();
});

test('external concurrent creation at final commit remains untouched',async t=>{
  const s=await setup(t),replace=s.host.replaceFile.bind(s.host);
  s.host.replaceFile=(abs,bytes,options)=>replace(abs,bytes,{...options,beforeCommit:async()=>{await options.beforeCommit();await fs.writeFile(abs,'external wins',{flag:'wx'});}});
  await assert.rejects(()=>s.exporter.export(s.input('race.md')),e=>e.code==='CONFLICT');
  assert.equal(await fs.readFile(path.join(s.project,'race.md'),'utf8'),'external wins');assert.deepEqual(s.counts(),{holds:1,releases:1});await s.noTemps();
});

test('retained missing-file draft and draft introduced during synchronization are preserved',async t=>{
  const s=await setup(t);await fs.writeFile(path.join(s.project,'draft.md'),'baseline');
  const read=await s.host.readFile(s.projectId,'draft.md');await s.host.draft(s.projectId,'draft.md',read.digest,'retained draft');await fs.unlink(path.join(s.project,'draft.md'));
  await assert.rejects(()=>s.exporter.export(s.input('draft.md')),e=>e.code==='UNSAVED');
  assert.equal((await s.host.readDraftRecord(s.projectId,'draft.md')).text,'retained draft');
  s.exporter.beforeOperation=async()=>{await s.host.draft(s.projectId,'late.md',read.digest,'late unpersisted user buffer');return ()=>{};};
  await assert.rejects(()=>s.exporter.export(s.input('late.md')),e=>e.code==='UNSAVED');
  assert.equal((await s.host.readDraftRecord(s.projectId,'late.md')).text,'late unpersisted user buffer');
  await assert.rejects(fs.stat(path.join(s.project,'draft.md')),e=>e.code==='ENOENT');await assert.rejects(fs.stat(path.join(s.project,'late.md')),e=>e.code==='ENOENT');await s.noTemps();
});

test('missing editing barrier, failed synchronization and staged source change publish no copy',async t=>{
  const s=await setup(t);
  const noBarrier=new ManagedReportExporter({host:s.host,managedAgents:s.managedAgents});
  await assert.rejects(()=>noBarrier.export(s.input('no-barrier.md')),e=>e.code==='NOT_READY');
  s.exporter.beforeOperation=async()=>{throw Object.assign(new Error('unsaved IME'),{code:'UNSAVED'});};
  await assert.rejects(()=>s.exporter.export(s.input('sync-failed.md')),e=>e.code==='UNSAVED');
  let released=false;s.exporter.beforeOperation=async()=>()=>{released=true;};
  const replace=s.host.replaceFile.bind(s.host),source=s.objectPath(s.receipt);
  s.host.replaceFile=(abs,bytes,options)=>replace(abs,bytes,{...options,beforeCommit:async()=>{await fs.writeFile(source,'changed original');await options.beforeCommit();}});
  await assert.rejects(()=>s.exporter.export(s.input('changed.md')),e=>/^(REPORT_CHANGED|MATERIAL_)/.test(e.code));assert.equal(released,true);
  assert.deepEqual(await fs.readdir(s.project),s.projectEntries);await s.noTemps();
});

test('rejects cross-project, forged text, absent/corrupt source and symlinked original',async t=>{
  const s=await setup(t),other=path.join(s.root,'other');await fs.mkdir(other);const otherId=(await s.host.pick(other)).project.id,otherEntries=await fs.readdir(other);
  const second=new ManagedReportExporter({host:s.host,managedAgents:{reportSource:async()=>{throw Object.assign(Error('missing'),{code:'REPORT_MISSING'});}},beforeOperation:async()=>()=>{}});
  await assert.rejects(()=>second.export({...s.input('cross.md'),projectId:otherId}),e=>e.code==='REPORT_MISSING');
  await assert.rejects(()=>s.exporter.export({...s.input('forged.md'),text:'fake'}),e=>e.code==='INVALID_PAYLOAD');
  const source=s.objectPath(s.receipt);await fs.unlink(source);
  await assert.rejects(()=>s.exporter.export(s.input('absent.md')),e=>/^(REPORT_|MATERIAL_)/.test(e.code));
  await fs.writeFile(source,'corrupt');await assert.rejects(()=>s.exporter.export(s.input('corrupt.md')),e=>/^(REPORT_|MATERIAL_)/.test(e.code));
  await fs.unlink(source);const external=path.join(s.root,'external-report.md');await fs.writeFile(external,s.text);await fs.symlink(external,source);
  await assert.rejects(()=>s.exporter.export(s.input('linked-source.md')),e=>/^(REPORT_|MATERIAL_|INVALID_MATERIAL$|INVALID_DIRECTORY$)/.test(e.code));
  assert.deepEqual(await fs.readdir(s.project),s.projectEntries);assert.deepEqual(await fs.readdir(other),otherEntries);await s.noTemps();
});

test('HTML export preserves frozen bytes and only permits html names',async t=>{
  const s=await setup(t,{html:true});
  const bytes=await s.store.readObject(s.receipt.report.digest),before=structuredClone(s.store.state);
  await assert.rejects(s.exporter.export(s.input('wrong.md')),e=>e.code==='BAD_PATH');
  const result=await s.exporter.export(s.input('报告.HTML'));
  assert.deepEqual(await fs.readFile(path.join(s.project,'报告.HTML')),bytes);
  assert.deepEqual(await s.store.readObject(s.receipt.report.digest),bytes);assert.deepEqual(s.store.state,before);
  assert.equal(result.digest,s.receipt.report.digest);assert.equal(result.byteLength,bytes.length);await s.noTemps();
});

test('HTML conflicts and final-commit races never overwrite existing content',async t=>{
  const s=await setup(t,{html:true});await fs.writeFile(path.join(s.project,'existing.html'),'user bytes');
  await assert.rejects(s.exporter.export(s.input('existing.html')),e=>e.code==='CONFLICT');
  const replace=s.host.replaceFile.bind(s.host);
  s.host.replaceFile=(abs,bytes,options)=>replace(abs,bytes,{...options,beforeCommit:async()=>{await options.beforeCommit();await fs.writeFile(abs,'external HTML race',{flag:'wx'});}});
  await assert.rejects(s.exporter.export(s.input('race.html')),e=>e.code==='CONFLICT');
  assert.equal(await fs.readFile(path.join(s.project,'existing.html'),'utf8'),'user bytes');
  assert.equal(await fs.readFile(path.join(s.project,'race.html'),'utf8'),'external HTML race');
  assert.deepEqual(s.counts(),{holds:1,releases:1});await s.noTemps();
});

test('legacy Markdown cannot be disguised as HTML',async t=>{
  const s=await setup(t);assert.equal(s.receipt.report.format,'markdown');
  await assert.rejects(s.exporter.export(s.input('legacy.html')),e=>e.code==='BAD_PATH');
  assert.deepEqual(s.counts(),{holds:0,releases:0});assert.deepEqual(await fs.readdir(s.project),s.projectEntries);
});

test('copies exact frozen Markdown artifact bytes without overwriting source files',async t=>{
  const s=await setup(t),payload={projectId:s.projectId,objectId:s.receipt.objectId,sourcePath:'reports/generated.md',relPath:'generated-copy.md'};
  await fs.writeFile(path.join(s.project,'reports/generated.md'),'new live version');
  const result=await s.exporter.exportArtifact(payload);
  assert.equal(result.copied,true);assert.equal(await fs.readFile(path.join(s.project,'generated-copy.md'),'utf8'),'# Frozen artifact\n\n中文内容\n');
  await assert.rejects(s.exporter.exportArtifact(payload),{code:'CONFLICT'});
  for(const relPath of ['../escape.md','CON.md','sub/copy.md','bad .md'])await assert.rejects(s.exporter.exportArtifact({...payload,relPath}),{code:'BAD_PATH'});
  assert.equal(await fs.readFile(path.join(s.project,'reports/generated.md'),'utf8'),'new live version');await s.noTemps();
});

test('Workspace rejects fresh Markdown publication without creating a receipt',async t=>{
  const s=await setup(t,{html:true}),work=s.store.state.works[0];
  const revision=await s.store.continue(work.id),before=structuredClone(s.store.state.receipts);
  await assert.rejects(s.store.publish(work.id,revision,'result','# New Markdown is not a publication format','rejected-markdown'));
  assert.deepEqual(s.store.state.receipts,before);
});

test('single-object history read pins receipt identity, not whole-state hash; versioned pages keep strict CAS',async t=>{
  const s=await setup(t);
  const project=await s.store.storage.requireRegistered(s.projectId);
  const controller={store:s.store};
  const opts=()=>({project,storage:s.store.storage,runtime:s.store.root,controller,currentController:()=>controller});
  const objectId=s.receipt.objectId;
  const pinned=(await managedHistory(opts(),{objectId})).version;
  // 无关后台状态变化（如审校草稿/runtime写入touching works/messages）：无version
  // 读取不受影响——正文不可变性由receipt身份/描述符/摘要CAS保证。
  await s.store.mutate(()=>{s.store.state.messages??=[];s.store.state.messages.push({id:'race-seed',target:'worker',speaker:'user',text:'unrelated background state change'});});
  const fresh=await managedHistory(opts(),{objectId});
  assert.equal(fresh.objectVerified,true);
  assert.notEqual(fresh.version,pinned);
  // 显式version分页仍严格CAS：state变化后旧version必须被拒，新version可复读。
  await assert.rejects(managedHistory(opts(),{objectId,version:pinned}),error=>error.code==='REPORT_CHANGED');
  await managedHistory(opts(),{objectId,version:fresh.version});
  // 竞态免疫：source.read()读取报告字节期间发生无关state变化，不再拒绝无version读取。
  const originalReadObject=s.store.storage.readObject.bind(s.store.storage);
  let injected=false;
  s.store.storage.readObject=(projectId,digest,...rest)=>{
    if(!injected&&digest===s.receipt.report.digest){
      injected=true;
      return s.store.mutate(()=>{s.store.state.messages.push({id:'race-window',target:'worker',speaker:'user',text:'mid-read background change'});}).then(()=>originalReadObject(projectId,digest,...rest));
    }
    return originalReadObject(projectId,digest,...rest);
  };
  try{
    injected=false;
    const raced=await managedHistory(opts(),{objectId});
    assert.equal(raced.objectVerified,true);
    injected=false;
    await assert.rejects(managedHistory(opts(),{objectId,version:raced.version}),error=>error.code==='REPORT_CHANGED');
  }finally{s.store.storage.readObject=originalReadObject;}
  // controller身份变化（如重启换实例）仍必须拒绝，绝不跨实例返回正文。
  await assert.rejects(managedHistory({...opts(),currentController:()=>({store:s.store})},{objectId}),error=>error.code==='REPORT_CHANGED');
});
