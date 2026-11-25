import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fixture as liveFixture} from './fixtures/windows-live-surface-host.mjs';
import {createLayout,reduceLayout} from '../src/domain/workspace-layout.mjs';
import {FileTreeOps} from '../src/main/file-tree-ops.mjs';
import {createFileTreeIO} from '../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../src/platform/windows/desktop-file-tree.mjs';
import {recoveryHeld} from '../src/main/workspace-recovery-state.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'},owner='same-surface:1',text='活源正文 中文😀\n';
async function fixture(t,relative='文件.txt'){
 const f=await liveFixture(t,relative),w=f.workspace;
 let layout=createLayout(f.source.id);layout=reduceLayout(layout,{type:'open',view:{kind:'document',relPath:relative}});
 const view=Object.values(layout.views).find(view=>view.relPath===relative),old=f.surface.viewId;
 w.surfaces.delete(old);f.surface.viewId=view.id;f.surface.resourceId=view.resourceId;w.surfaces.set(view.id,f.surface);f.buffer.sourceViewId=view.id;w.leases.get(f.key).viewId=view.id;
 w.layouts.set(f.source.id,layout);w.reconcile=async()=>{};w.changed=()=>{};
 const run=(input={},options={})=>{const payload={projectId:f.source.id,action:'rename',source:relative,name:'改名.txt',...input},ops=new FileTreeOps(f.host,{trash:()=>assert.fail('no trash'),io:{...createFileTreeIO(f.host),...createWindowsDesktopFileTreeIO(f.host,options)}});return w.mutateTree(payload,context=>ops.run(payload,context));};
 const published=rel=>({directorySync:parent=>{if(requireExists(path.join(f.a,rel)))parent.close();parent.syncDirectory();}});
 const binding=async()=>{const page=await f.host.storage.recoveryPage(f.source.id,{prefixes:['tree-operation:'],pendingOnly:true,purpose:'recovery-ui'});assert.equal(page.entries.length,1);const row=page.entries[0];return {projectId:f.source.id,id:row.id,revision:row.revision,version:page.version};};
 const settle=async()=>f.service.settle({token:(await f.service.preview(await binding(),owner)).token,confirmed:true},owner);
 return {...f,run,published,binding,settle};
}
import {existsSync as requireExists} from 'node:fs';
async function cold(f,{action,relative=f.surface.relPath}={}){
 await f.host.settled();await f.host.storage.db.close();
 const input=path.join(f.base,'cold-'+randomUUID()+'.json'),output=input+'.out';await fs.writeFile(input,JSON.stringify({profile:f.profile,projectId:f.source.id,relative,viewId:f.surface.viewId,action}));
 const result=spawnSync(process.execPath,[path.join(import.meta.dirname,'fixtures/windows-cold-source-child.mjs'),input,output],{env:{...process.env},encoding:'utf8',windowsHide:true,timeout:60000});assert.ifError(result.error);assert.equal(result.signal,null);return JSON.parse(await fs.readFile(output,'utf8'));
}
test('successful same-project rename migrates actual layout, buffer and lease with no old buffer key',native,async t=>{
 const f=await fixture(t),lease=f.workspace.leases.get(f.key);await f.run();const newKey=f.workspace.resource(f.source.id,'改名.txt');
 assert.equal(f.surface.relPath,'改名.txt');assert(!recoveryHeld(f.surface));assert.equal(f.workspace.buffers.has(f.key),false);assert.equal(f.workspace.buffers.get(newKey).text,f.buffer.text);assert.equal(f.workspace.leases.get(newKey),lease);assert.equal(f.workspace.layouts.get(f.source.id).views[f.surface.viewId].relPath,'改名.txt');f.writeAllowed();
 assert.equal((await f.workspace.documentExportRead(f.surface,{projectId:f.source.id,relPath:'改名.txt'})).text,f.buffer.text);assert.equal(await fs.readFile(path.join(f.a,'改名.txt'),'utf8'),text);
});
test('successful rename preserves the retained workspace candidate and unsent note through independent process restart',native,async t=>{
 const f=await fixture(t);await f.workspace.saveRecovery(f.surface,{projectId:f.source.id,viewId:f.surface.viewId,relPath:'文件.txt',generation:1,kind:'text',candidate:{text},workspace:{draft:'UNSENT SAME NOTE'}});await f.run();
 const record=await f.host.storage.getRecovery(f.source.id,'workspace:'+f.surface.viewId);assert.equal(record.relPath,'改名.txt');assert.equal(record.workspace.draft,'UNSENT SAME NOTE');const result=await cold(f);assert(result.ok,result.error?.message);assert.equal(result.held,false);assert.equal(result.before.text,text);assert.equal(result.bootstrap.viewState?.workspace?.draft,'UNSENT SAME NOTE');
});
test('published same-project rename settlement retains original live reader and opens verified target explicitly',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run({},f.published('改名.txt')));await fs.writeFile(path.join(f.a,'文件.txt'),'FOREIGN ORIGINAL NAME');assert(recoveryHeld(f.surface));assert.throws(()=>f.writeAllowed(),{code:'TRANSFER_HELD'});
 assert.deepEqual((await f.settle()).surfaceRecovery,{resumed:0,moved:1,retained:0});assert.equal(f.surface.relPath,'文件.txt');assert.equal((await f.workspace.readDocument(f.surface,{projectId:f.source.id,relPath:'文件.txt'})).text,text);assert.equal(f.workspace.buffers.get(f.key),f.buffer);
 await f.workspace.invoke(f.surface,'workspace.openTreeDestination',f.input());assert.equal(f.messages.at(-1).payload.projectId,f.source.id);assert.equal(f.messages.at(-1).payload.relPath,'改名.txt');assert.equal(await fs.readFile(path.join(f.a,'文件.txt'),'utf8'),'FOREIGN ORIGINAL NAME');
});
test('unpublished rename explicitly resumes only the original source with its buffer and lease intact',native,async t=>{
 const f=await fixture(t),lease=f.workspace.leases.get(f.key);await assert.rejects(f.run({},f.aborted()));assert(recoveryHeld(f.surface));assert.deepEqual((await f.settle()).surfaceRecovery,{resumed:1,moved:0,retained:0});assert(!recoveryHeld(f.surface));assert.equal(f.workspace.buffers.get(f.key),f.buffer);assert.equal(f.workspace.leases.get(f.key),lease);f.writeAllowed();
});
test('same-project published copy uses exact final duplicate name and releases its source after confirmation',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run({action:'copy'},f.published('文件 副本.txt')));const hold=[...f.surface.treeRecoveryHolds.values()][0];assert.equal(hold.destination,'文件 副本.txt');assert.deepEqual((await f.settle()).surfaceRecovery,{resumed:1,moved:0,retained:0});assert.equal(f.workspace.buffers.get(f.key),f.buffer);f.writeAllowed();
});
test('same-project moved reader and late unsent note survive whole process restart with foreign old path intact',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run({},f.published('改名.txt')));await f.settle();await f.workspace.saveRecovery(f.surface,{projectId:f.source.id,viewId:f.surface.viewId,relPath:'文件.txt',generation:2,kind:'text',candidate:{text:'LATE SAME INPUT'},workspace:{draft:'LATE UNSENT SAME NOTE'}});await fs.writeFile(path.join(f.a,'文件.txt'),'FOREIGN NAME');
 const result=await cold(f,{action:'destination'});assert(result.ok,result.error?.message);assert(result.held);assert.equal(result.state.status,'moved');assert.equal(result.before.text,text);assert.equal(result.before.draft.text,'LATE SAME INPUT');assert.equal(result.bootstrap.viewState.workspace.draft,'LATE UNSENT SAME NOTE');assert.equal(result.actionError,null);assert.equal(result.messages.at(-1).payload.relPath,'改名.txt');
});
test('a lost final complete response can reconcile its own source protection without replay',native,async t=>{
 const f=await fixture(t),batch=f.host.storage.putRecoveryRecords.bind(f.host.storage);let lost=false;f.host.storage.putRecoveryRecords=async(...args)=>{const r=await batch(...args);if(!lost){lost=true;throw Object.assign(Error('synthetic final reply lost'),{code:'STORAGE_RESULT_UNKNOWN'});}return r;};
 await assert.rejects(f.run());f.host.storage.putRecoveryRecords=batch;assert(recoveryHeld(f.surface));await f.workspace.invoke(f.surface,'workspace.resumeTreeSource',f.input());assert.equal(f.workspace.treeRecovery.current(f.surface).status,'moved');assert.equal(await fs.readFile(path.join(f.a,'改名.txt'),'utf8'),text);
});
test('late target identity replacement prevents explicit target opening and preserves both objects',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run({},f.published('改名.txt')));await f.settle();await fs.rename(path.join(f.a,'改名.txt'),path.join(f.a,'original-moved.txt'));await fs.writeFile(path.join(f.a,'改名.txt'),text);await assert.rejects(f.workspace.invoke(f.surface,'workspace.openTreeDestination',f.input()),{code:'TREE_SURFACE_CHANGED'});assert.equal(await fs.readFile(path.join(f.a,'original-moved.txt'),'utf8'),text);
});
test('an independent general recovery hold survives same-project aborted reconciliation',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run({},f.aborted()));f.surface.recoveryHeld=true;await f.settle();assert.equal(f.surface.treeRecoveryHolds.size,0);assert.equal(f.surface.recoveryHeld,true);assert.throws(()=>f.writeAllowed(),{code:'TRANSFER_HELD'});
});
test('same-project recovery queues behind the original workspace operation',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run({},f.published('改名.txt')));let release,started=false;const barrier=f.workspace.serial(f.source.id,()=>new Promise(resolve=>release=resolve));await new Promise(resolve=>setImmediate(resolve));const preview=f.service.preview(await f.binding(),owner).then(v=>{started=true;return v;});await new Promise(resolve=>setImmediate(resolve));assert.equal(started,false);release();await barrier;const plan=await preview;await f.service.settle({token:plan.token,confirmed:true},owner);
});
test('successful directory rename migrates each descendant buffer and a reading mirror without collision',native,async t=>{
 const f=await fixture(t,'目录/文件.txt'),w=f.workspace;await fs.mkdir(path.join(f.a,'目录/空目录'));await fs.writeFile(path.join(f.a,'目录/二.txt'),'SECOND');
 const second=f.makeSurface('目录/二.txt'),mirror=f.makeSurface('目录/文件.txt');mirror.readOnly=true;w.leases.get(f.key).viewId=f.surface.viewId;
 const layout=w.layouts.get(f.source.id);for(const r of [second,mirror])layout.views[r.viewId]={id:r.viewId,projectId:f.source.id,kind:'document',relPath:r.relPath,resourceId:'document:'+r.relPath,preview:false,viewState:{}};
 w.buffers.set(w.resource(f.source.id,'目录/二.txt'),{text:'SECOND BUFFER',sourceViewId:second.viewId});
 await f.run({source:'目录',name:'改名目录'});assert.equal(f.surface.relPath,'改名目录/文件.txt');assert.equal(second.relPath,'改名目录/二.txt');assert.equal(mirror.relPath,'改名目录/文件.txt');assert.equal(w.buffers.get(w.resource(f.source.id,second.relPath)).text,'SECOND BUFFER');assert(!w.buffers.has(f.key));assert.deepEqual(await fs.readdir(path.join(f.a,'改名目录/空目录')),[]);
});
test('failure to persist original protection refuses all file effects and terminal intent can explicitly resume',native,async t=>{
 const f=await fixture(t),put=f.host.storage.putRecovery.bind(f.host.storage);let injected=false;
 f.host.storage.putRecovery=async(id,key,value,options)=>{if(!injected&&key.startsWith('tree-surface:')){injected=true;throw Error('synthetic hold persistence refused');}return put(id,key,value,options);};
 await assert.rejects(f.run());f.host.storage.putRecovery=put;assert(injected);assert(recoveryHeld(f.surface));assert.equal(await fs.readFile(path.join(f.a,'文件.txt'),'utf8'),text);await assert.rejects(fs.stat(path.join(f.a,'改名.txt')),{code:'ENOENT'});await f.workspace.invoke(f.surface,'workspace.resumeTreeSource',f.input());assert(!recoveryHeld(f.surface));
});
test('layout acknowledgement loss cold-opens the verified relocated view without reading the old foreign name',native,async t=>{
 const f=await fixture(t),persist=f.workspace.persist.bind(f.workspace);let lost=false;f.workspace.persist=async layout=>{await persist(layout);if(!lost){lost=true;throw Error('synthetic layout reply lost');}};
 await assert.rejects(f.run());assert(lost);await fs.writeFile(path.join(f.a,'文件.txt'),'FOREIGN OLD NAME');const result=await cold(f,{relative:'改名.txt'});assert(result.ok,result.error?.message);assert.equal(result.before.text,text);assert.equal(result.held,false);assert.equal(await fs.readFile(path.join(f.a,'文件.txt'),'utf8'),'FOREIGN OLD NAME');
});
test('protected same-project capsule retains original annotations after live metadata migration and restart',native,async t=>{
 const f=await fixture(t),file=await f.host.readFile(f.source.id,'文件.txt');await f.host.addAnnotation(f.source.id,{relPath:'文件.txt',materialDigest:file.materialDigest,kind:'text-selection',anchor:{start:0,end:2,quote:text.slice(0,2)},note:'ORIGINAL SAME ANNOTATION'});
 await assert.rejects(f.run({},f.published('改名.txt')));await f.settle();const hold=[...f.surface.treeRecoveryHolds.values()][0];assert(JSON.stringify(hold.coldCapsule.annotations).includes('ORIGINAL SAME ANNOTATION'));assert.equal((await f.host.storage.getRecovery(f.source.id,'tree-operation:'+hold.operationId)).phase,'complete');const result=await cold(f);assert(result.ok,result.error?.message);assert.equal(result.before.text,text);
});
test('post-relocation reconcile failure preserves the committed new identity and does not recreate an old-path hold',native,async t=>{
 const f=await fixture(t);f.workspace.reconcile=async()=>{throw Error('synthetic final UI reconciliation failed');};
 await assert.rejects(f.run(),/final UI reconciliation/);assert.equal(f.surface.relPath,'改名.txt');assert.equal(f.workspace.layouts.get(f.source.id).views[f.surface.viewId].relPath,'改名.txt');assert(!recoveryHeld(f.surface));assert(f.workspace.buffers.has(f.workspace.resource(f.source.id,'改名.txt')));assert(!f.workspace.buffers.has(f.key));
 const result=await cold(f,{relative:'改名.txt'});assert(result.ok,result.error?.message);assert.equal(result.before.text,text);assert.equal(result.held,false);
});
