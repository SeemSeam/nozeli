import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';
import {TreeRecovery} from '../src/main/tree-recovery.mjs';
import {FileTreeOps} from '../src/main/file-tree-ops.mjs';
import {createFileTreeIO} from '../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../src/platform/windows/desktop-file-tree.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {windowsClipboardSnapshot} from '../src/platform/windows/clipboard-source.mjs';
import {recoveryHeld} from '../src/main/workspace-recovery-state.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'},text='活源正文 中文😀\n',owner='synthetic-live-shell:1';
import {fixture} from './fixtures/windows-live-surface-host.mjs';


test('same-host published copy settlement releases only its own source hold and preserves the live dirty buffer/lease',native,async t=>{
  const f=await fixture(t),lease=f.workspace.leases.get(f.key);
  await assert.rejects(f.run('copy',f.published()));assert(recoveryHeld(f.surface));assert.throws(()=>f.writeAllowed(),{code:'TRANSFER_HELD'});
  assert.deepEqual((await f.settle()).surfaceRecovery,{resumed:1,moved:0,retained:0});assert(!recoveryHeld(f.surface));f.writeAllowed();
  assert.equal(f.workspace.buffers.get(f.key),f.buffer);assert.equal(f.workspace.leases.get(f.key),lease);assert.equal(f.buffer.text,'UNSAVED LATE BUFFER');assert.deepEqual(f.errors,[]);
});

test('published cut keeps the original reader and a foreign source-name winner, opens the verified destination only by explicit action',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('cut',f.published()));await fs.writeFile(path.join(f.a,'文件.txt'),'FOREIGN SOURCE');
  assert.deepEqual((await f.settle()).surfaceRecovery,{resumed:0,moved:1,retained:0});assert(recoveryHeld(f.surface));assert.equal(f.surface.relPath,'文件.txt');assert.equal(f.workspace.buffers.get(f.key),f.buffer);
  assert.equal(f.messages.filter(x=>x.shell).length,0);await f.workspace.invoke(f.surface,'workspace.openTreeDestination',f.input());
  assert.deepEqual(f.messages.at(-1).payload,{type:'open-file',projectId:f.target.id,relPath:'文件.txt',documentSource:{type:'project'}});
  assert.equal(await fs.readFile(path.join(f.a,'文件.txt'),'utf8'),'FOREIGN SOURCE');assert.throws(()=>f.writeAllowed(),{code:'TRANSFER_HELD'});
});

test('published recursive cut reconciles each live descendant independently and preserves original source document identities',native,async t=>{
  const f=await fixture(t,'目录/文件.txt');await fs.mkdir(path.join(f.a,'目录/空目录'));await fs.writeFile(path.join(f.a,'目录/另一个.txt'),'SECOND');const second=f.makeSurface('目录/另一个.txt');
  await assert.rejects(f.run('cut',f.published('目录'),'目录'));assert.deepEqual((await f.settle()).surfaceRecovery,{resumed:0,moved:2,retained:0});
  for(const r of [f.surface,second]){assert(recoveryHeld(r));await f.workspace.invoke(r,'workspace.openTreeDestination',f.input(r));assert.equal(f.messages.at(-1).payload.relPath,r.relPath);}
  assert.deepEqual(await fs.readdir(path.join(f.b,'目录/空目录')),[]);
});

test('unpublished same-host cut with explicit uncertainty resumes the exact original source after confirmation',native,async t=>{
  const f=await fixture(t),before=await windowsClipboardSnapshot(path.join(f.a,'文件.txt'));await assert.rejects(f.run('cut',f.aborted()));assert(recoveryHeld(f.surface));
  assert.deepEqual((await f.settle()).surfaceRecovery,{resumed:1,moved:0,retained:0});f.writeAllowed();assert.deepEqual(await windowsClipboardSnapshot(path.join(f.a,'文件.txt')),before);
});

test('unpublished copied directory stage is retained while the live original descendant resumes',native,async t=>{
  const f=await fixture(t,'目录/文件.txt');await assert.rejects(f.run('copy',f.aborted(),'目录'));const stage=(await fs.readdir(f.b)).find(name=>name.startsWith('.nozeli-tree-'));assert(stage);const before=await windowsClipboardSnapshot(path.join(f.b,stage));
  await f.settle();assert(!recoveryHeld(f.surface));assert.deepEqual(await windowsClipboardSnapshot(path.join(f.b,stage)),before);assert.equal(f.workspace.buffers.get(f.key),f.buffer);
});

test('an independent preview/browser recovery flag survives successful file receipt reconciliation',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('copy',f.published()));f.surface.recoveryHeld=true;f.surface.previewRecoveryFailed=true;
  await f.settle();assert.equal(f.surface.treeRecoveryHolds.size,0);assert.equal(f.surface.recoveryHeld,true);assert.equal(f.surface.held,true);assert.throws(()=>f.writeAllowed(),{code:'TRANSFER_HELD'});
});

test('same bytes with a new source File ID keep the live reader protected; explicit original-identity restoration can resume it',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('copy',f.published()));const original=path.join(f.a,'原对象保留.txt');await fs.rename(path.join(f.a,'文件.txt'),original);await fs.writeFile(path.join(f.a,'文件.txt'),text);
  assert.deepEqual((await f.settle()).surfaceRecovery,{resumed:0,moved:0,retained:1});assert.throws(()=>f.writeAllowed(),{code:'TRANSFER_HELD'});await assert.rejects(f.workspace.invoke(f.surface,'workspace.resumeTreeSource',f.input()),{code:'TREE_SURFACE_CHANGED'});
  await fs.rename(path.join(f.a,'文件.txt'),path.join(f.a,'新对象保留.txt'));await fs.rename(original,path.join(f.a,'文件.txt'));await f.workspace.invoke(f.surface,'workspace.resumeTreeSource',f.input());f.writeAllowed();
  assert.equal(await fs.readFile(path.join(f.a,'新对象保留.txt'),'utf8'),text);assert.equal(f.workspace.buffers.get(f.key),f.buffer);
});

test('partial final receipt failure keeps the source protected until a fresh paired confirmation finishes',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('copy',f.published()));const put=f.host.storage.putRecovery.bind(f.host.storage);let injected=false;
  f.host.storage.putRecovery=async(id,key,value,options)=>{if(!injected&&id===f.target.id&&value.reconciliation&&value.phase==='complete'){injected=true;throw Error('synthetic final acknowledgement failure');}return put(id,key,value,options);};
  await assert.rejects(f.settle());assert(injected);assert(recoveryHeld(f.surface));assert.equal(f.workspace.treeRecovery.current(f.surface).status,'pending');f.host.storage.putRecovery=put;
  await f.settle();assert(!recoveryHeld(f.surface));f.writeAllowed();
});

test('lost final acknowledgement after both terminal writes can be explicitly reconciled from the original live source without replay',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('copy',f.published()));const put=f.host.storage.putRecovery.bind(f.host.storage);let injected=false;
  f.host.storage.putRecovery=async(id,key,value,options)=>{const result=await put(id,key,value,options);if(!injected&&id===f.target.id&&value.reconciliation&&value.phase==='complete'){injected=true;throw Object.assign(Error('lost final response'),{code:'STORAGE_RESULT_UNKNOWN'});}return result;};
  await assert.rejects(f.settle());f.host.storage.putRecovery=put;assert(injected);assert(recoveryHeld(f.surface));assert.equal((await f.host.storage.recoveryPage(f.target.id,{prefixes:['tree-operation:'],pendingOnly:true})).entries.length,0);
  await f.workspace.invoke(f.surface,'workspace.resumeTreeSource',f.input());assert(!recoveryHeld(f.surface));assert.equal(await fs.readFile(path.join(f.b,'文件.txt'),'utf8'),text);
});

test('a reloaded generation stays protected until it explicitly verifies the original native file again',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('copy',f.published()));f.surface.generation++;
  assert.deepEqual((await f.settle()).surfaceRecovery,{resumed:0,moved:0,retained:1});assert(recoveryHeld(f.surface));
  await f.workspace.invoke(f.surface,'workspace.resumeTreeSource',f.input());assert(!recoveryHeld(f.surface));assert.equal(f.workspace.buffers.get(f.key),f.buffer);
});

test('another operation protection is never released by the selected receipt',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('copy',f.published()));const other=randomUUID(),existing=[...f.surface.treeRecoveryHolds.values()][0];f.surface.treeRecoveryHolds.set(other,{...existing,operationId:other});
  await f.settle();assert(recoveryHeld(f.surface));assert.equal(f.surface.treeRecoveryHolds.size,1);assert(f.surface.treeRecoveryHolds.has(other));assert.throws(()=>f.writeAllowed(),{code:'TRANSFER_HELD'});
});

test('surface actions reject guessed operations, other projects, shell scopes and a late target identity winner',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('cut',f.published()));await f.settle();const input=f.input();
  for(const patch of [{projectId:f.target.id},{operationId:randomUUID()},{relPath:'other.txt'},{extra:true}])await assert.rejects(f.workspace.invoke(f.surface,'workspace.openTreeDestination',{...input,...patch}));
  await assert.rejects(f.workspace.invoke({...f.surface,role:'shell'},'workspace.openTreeDestination',input));
  await fs.rename(path.join(f.b,'文件.txt'),path.join(f.b,'原目标保留.txt'));await fs.writeFile(path.join(f.b,'文件.txt'),text);await assert.rejects(f.workspace.invoke(f.surface,'workspace.openTreeDestination',input),{code:'TREE_SURFACE_CHANGED'});
  assert.equal(f.messages.filter(x=>x.shell).length,0);assert.equal(await fs.readFile(path.join(f.b,'文件.txt'),'utf8'),text);
});

test('workspace serialization completes the original mutation before starting paired recovery',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.run('copy',f.published()));let release,entered=false;const blocked=new Promise(resolve=>release=resolve),barrier=f.workspace.serial(f.source.id,()=>blocked);
  const preview=f.service.preview(await f.binding(),owner).then(value=>{entered=true;return value;});await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,false);release();await barrier;const plan=await preview;await f.service.settle({token:plan.token,confirmed:true},owner);assert(!recoveryHeld(f.surface));
});

test('ordinary successful native cut also retains the original reader and offers a separate verified target',native,async t=>{
  const f=await fixture(t);await f.run('cut');assert(recoveryHeld(f.surface));assert.equal(f.workspace.treeRecovery.current(f.surface).status,'moved');await f.workspace.invoke(f.surface,'workspace.openTreeDestination',f.input());assert(f.messages.at(-1).shell);assert.equal(f.workspace.buffers.get(f.key),f.buffer);
});

test('source observation failure before publication leaves every original file and buffer intact',native,async t=>{
  const f=await fixture(t);f.workspace.treeRecovery.observe=async()=>{throw Error('synthetic observation refused');};await assert.rejects(f.run('cut'));assert.equal(await fs.readFile(path.join(f.a,'文件.txt'),'utf8'),text);await assert.rejects(fs.stat(path.join(f.b,'文件.txt')),{code:'ENOENT'});assert(!recoveryHeld(f.surface));assert.equal(f.workspace.buffers.get(f.key),f.buffer);
});
