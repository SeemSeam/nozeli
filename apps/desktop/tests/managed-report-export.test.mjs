import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DesktopHost} from '../src/main/host.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {ManagedReportExporter} from '../src/main/managed-report-export.mjs';
import {staticReport,historicalMarkdownState} from './static-report.fixture.mjs';

// Real Host registry/drafts/atomic writes and real Workspace publication/object.
// The binding lookup has no Provider; this is file safety, not CLI acceptance.
async function setup(t,{html=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-report-export-'));
  const project=path.join(root,'project');await fs.mkdir(project);
  const host=new DesktopHost(path.join(root,'profile')),projectId=(await host.pick(project)).project.id;
  let store=await Workspace.open(path.join(root,'runtime'),project);
  const work=await store.submit('request','brief',{name:'真实报告'});await store.activate(work.id);
  let text=html?staticReport('Unicode 中文、空行与尾换行。'):'# 原始报告\r\n\r\nUnicode 中文、空行与尾换行。\r\n\r\n[原文件](source.md)\r\n';
  let receipt=await store.publish(work.id,1,'result',html?text:staticReport('Historical seed'),'receipt-1');await store.settle(work.id);
  if(!html){await historicalMarkdownState(store,new Map([[receipt.objectId,text]]));store=await Workspace.open(store.root,project);receipt=store.state.receipts[0];}
  if(html)text=await fs.readFile(path.join(store.root,'objects',receipt.objectId+'.html'),'utf8');
  const managedAgents={controller:id=>{assert.equal(id,projectId);return {store};}};
  let holds=0,releases=0;
  const exporter=new ManagedReportExporter({host,managedAgents,beforeOperation:async()=>{holds++;return ()=>{releases++;};}});
  t.after(async()=>{await store.close();await fs.rm(root,{recursive:true,force:true});});
  const input=relPath=>({projectId,objectId:receipt.objectId,relPath});
  const noTemps=async()=>assert.equal((await fs.readdir(project)).some(n=>n.startsWith('.nozeli-tmp-')),false);
  return {root,project,host,projectId,store,receipt,text,managedAgents,exporter,input,noTemps,counts:()=>({holds,releases})};
}

test('copies exact external report bytes, preserves original, registry and user edits',async t=>{
  const s=await setup(t);await fs.writeFile(path.join(s.project,'source.md'),'user original');
  const original=await s.host.readFile(s.projectId,'source.md');await s.host.draft(s.projectId,'source.md',original.digest,'user unsaved');
  const before=structuredClone(s.store.state),result=await s.exporter.export(s.input('阅读报告.md'));
  assert.equal(result.copied,true);assert.equal(result.byteLength,Buffer.byteLength(s.text));
  assert.equal(await fs.readFile(path.join(s.project,'阅读报告.md'),'utf8'),s.text);
  assert.equal(await fs.readFile(path.join(s.store.root,'objects',s.receipt.objectId+'.md'),'utf8'),s.text);
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
  assert.deepEqual(await fs.readFile(path.join(s.project,'新版.html')),await fs.readFile(path.join(s.store.root,'objects',latest.objectId+'.html')));
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
  const replace=s.host.replaceFile.bind(s.host),source=path.join(s.store.root,'objects',s.receipt.objectId+'.md');
  s.host.replaceFile=(abs,bytes,options)=>replace(abs,bytes,{...options,beforeCommit:async()=>{await fs.writeFile(source,'changed original');await options.beforeCommit();}});
  await assert.rejects(()=>s.exporter.export(s.input('changed.md')),e=>e.code==='REPORT_CHANGED');assert.equal(released,true);
  assert.deepEqual(await fs.readdir(s.project),[]);await s.noTemps();
});

test('rejects cross-project, forged text, absent/corrupt source and symlinked original',async t=>{
  const s=await setup(t),other=path.join(s.root,'other');await fs.mkdir(other);const otherId=(await s.host.pick(other)).project.id;
  const second=new ManagedReportExporter({host:s.host,managedAgents:{controller:()=>({store:{state:{receipts:[]}}})},beforeOperation:async()=>()=>{}});
  await assert.rejects(()=>second.export({...s.input('cross.md'),projectId:otherId}),e=>e.code==='REPORT_MISSING');
  await assert.rejects(()=>s.exporter.export({...s.input('forged.md'),text:'fake'}),e=>e.code==='INVALID_PAYLOAD');
  const source=path.join(s.store.root,'objects',s.receipt.objectId+'.md');await fs.unlink(source);
  await assert.rejects(()=>s.exporter.export(s.input('absent.md')),e=>e.code==='REPORT_UNAVAILABLE');
  await fs.writeFile(source,'corrupt');await assert.rejects(()=>s.exporter.export(s.input('corrupt.md')),e=>e.code==='REPORT_CHANGED');
  await fs.unlink(source);const external=path.join(s.root,'external-report.md');await fs.writeFile(external,s.text);await fs.symlink(external,source);
  await assert.rejects(()=>s.exporter.export(s.input('linked-source.md')),e=>e.code==='REPORT_UNAVAILABLE');
  assert.deepEqual(await fs.readdir(s.project),[]);assert.deepEqual(await fs.readdir(other),[]);await s.noTemps();
});

test('HTML export preserves frozen bytes and only permits html names',async t=>{
  const s=await setup(t,{html:true}),source=path.join(s.store.root,'objects',s.receipt.objectId+'.html');
  const bytes=await fs.readFile(source),before=structuredClone(s.store.state);
  await assert.rejects(s.exporter.export(s.input('wrong.md')),e=>e.code==='BAD_PATH');
  const result=await s.exporter.export(s.input('报告.HTML'));
  assert.deepEqual(await fs.readFile(path.join(s.project,'报告.HTML')),bytes);
  assert.deepEqual(await fs.readFile(source),bytes);assert.deepEqual(s.store.state,before);
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
  assert.deepEqual(s.counts(),{holds:0,releases:0});assert.deepEqual(await fs.readdir(s.project),[]);
});

test('Workspace rejects fresh Markdown publication without creating a receipt',async t=>{
  const s=await setup(t,{html:true}),work=s.store.state.works[0];
  const revision=await s.store.continue(work.id),before=structuredClone(s.store.state.receipts);
  await assert.rejects(s.store.publish(work.id,revision,'result','# New Markdown is not a publication format','rejected-markdown'));
  assert.deepEqual(s.store.state.receipts,before);
});
