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
import {recoveryHeld} from '../src/main/workspace-recovery-state.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t){
 const f=await liveFixture(t,'目录/一.txt'),w=f.workspace;
 await fs.writeFile(path.join(f.a,'目录/二.txt'),'SECOND ORIGINAL\n');
 let layout=createLayout(f.source.id);layout=reduceLayout(layout,{type:'open',view:{kind:'document',relPath:'目录/一.txt',preview:false}});
 const first=Object.values(layout.views).find(v=>v.kind==='document'),old=f.surface.viewId;w.surfaces.delete(old);f.surface.viewId=first.id;w.surfaces.set(first.id,f.surface);f.buffer.sourceViewId=first.id;w.leases.get(f.key).viewId=first.id;
 layout=reduceLayout(layout,{type:'open',view:{kind:'document',relPath:'目录/二.txt',preview:false}});layout=reduceLayout(layout,{type:'duplicate',viewId:first.id});
 const records=[f.surface];
 for(const view of Object.values(layout.views).filter(v=>v.kind==='document'&&v.id!==first.id)){
  const r=f.makeSurface(view.relPath);w.surfaces.delete(r.viewId);r.viewId=view.id;r.readOnly=!!view.readOnly;r.sourceViewId=view.sourceViewId;w.surfaces.set(r.viewId,r);records.push(r);
 }
 for(const r of records){r.resourceId='document:'+r.relPath;if(!r.readOnly)w.leases.set(w.resourceOfRecord(r),{viewId:r.viewId,generation:1});}
 for(const r of records)layout.views[r.viewId].viewState={workspace:{draft:'NOTE '+r.viewId}};
 w.layouts.set(f.source.id,layout);w.reconcile=async()=>{};w.changed=()=>{};await w.persist(layout);
 for(const r of records.filter(r=>!r.readOnly))await w.saveRecovery(r,{projectId:r.projectId,viewId:r.viewId,relPath:r.relPath,generation:1,kind:'text',candidate:{text:'RETAINED '+r.relPath},workspace:{draft:'NOTE '+r.viewId}});
 const run=async()=>{const payload={projectId:f.source.id,source:'目录',action:'rename',name:'新目录'},ops=new FileTreeOps(f.host,{trash:()=>assert.fail('no trash'),io:createFileTreeIO(f.host)});return w.mutateTree(payload,context=>ops.run(payload,context));};
 const cold=async(r,relative)=>{
  const input=path.join(f.base,randomUUID()+'.json'),output=input+'.out';await fs.writeFile(input,JSON.stringify({profile:f.profile,projectId:f.source.id,viewId:r.viewId,relative}));
  const child=spawnSync(process.execPath,[path.join(import.meta.dirname,'fixtures/windows-cold-source-child.mjs'),input,output],{env:{...process.env},encoding:'utf8',windowsHide:true,timeout:60000});assert.ifError(child.error);assert.equal(child.signal,null);return JSON.parse(await fs.readFile(output,'utf8'));
 };
 return {...f,records,layout,run,cold};
}

test('partial release never lets a stale original view read a foreign old pathname after restart',native,async t=>{
 const f=await fixture(t),journal=f.workspace.treeRecovery.journal,release=journal.release.bind(journal);let calls=0;
 journal.release=async(...args)=>{if(++calls===2)throw Error('synthetic second release failed');return release(...args);};
 await assert.rejects(f.run(),/second release/);assert.equal(calls,2);for(const r of f.records)assert(recoveryHeld(r));
 await fs.mkdir(path.join(f.a,'目录'));for(const name of ['一.txt','二.txt'])await fs.writeFile(path.join(f.a,'目录',name),'FOREIGN '+name);
 // A late, old-generation layout write is a real admitted operation; its
 // content can arrive after the successful relocated-layout acknowledgement.
 await f.workspace.persist(f.layout);await f.host.settled();await f.host.storage.db.close();
 for(const r of f.records){const result=await f.cold(r,r.relPath);assert(result.ok,result.error?.message);assert(result.held,'old view must retain protection');assert.equal(result.before.text,r.relPath.endsWith('一.txt')?'活源正文 中文😀\n':'SECOND ORIGINAL\n');assert.equal(result.bootstrap.viewState.workspace.draft,'NOTE '+r.viewId);}
});

test('lost first release acknowledgement restores new layout notes and candidates for every view',native,async t=>{
 const f=await fixture(t),journal=f.workspace.treeRecovery.journal,release=journal.release.bind(journal);let lost=false;
 journal.release=async(...args)=>{const value=await release(...args);if(!lost){lost=true;throw Error('synthetic release reply lost');}return value;};
 await assert.rejects(f.run(),/reply lost/);assert(lost);await f.host.settled();await f.host.storage.db.close();
 for(const r of f.records){const result=await f.cold(r,'新目录/'+path.posix.basename(r.relPath));assert(result.ok,result.error?.message);assert.equal(result.held,false);assert.equal(result.bootstrap.viewState.workspace.draft,'NOTE '+r.viewId);}
});

for(const boundary of ['before-first','lost-first','before-second','lost-second'])test(`multi-view relocation ${boundary} retains old readers and verifies every new view`,native,async t=>{
 const f=await fixture(t),journal=f.workspace.treeRecovery.journal,release=journal.release.bind(journal);let count=0;
 journal.release=async(...args)=>{count++;const selected=count===(boundary.endsWith('first')?1:2);if(selected&&boundary.startsWith('before'))throw Error('synthetic boundary');const value=await release(...args);if(selected)throw Error('synthetic boundary');return value;};
 await assert.rejects(f.run(),/synthetic boundary/);for(const r of f.records){assert(recoveryHeld(r));assert(r.relPath.startsWith('目录/'));}
 await fs.mkdir(path.join(f.a,'目录'));for(const name of ['一.txt','二.txt'])await fs.writeFile(path.join(f.a,'目录',name),'FOREIGN '+name);
 await f.host.settled();await f.host.storage.db.close();
 for(const r of f.records){
  const old=await f.cold(r,r.relPath);assert(old.ok,old.error?.message);assert(old.held);assert.equal(old.before.text,r.relPath.endsWith('一.txt')?'活源正文 中文😀\n':'SECOND ORIGINAL\n');assert.equal(old.bootstrap.viewState.workspace.draft,'NOTE '+r.viewId);
  const current=await f.cold(r,'新目录/'+path.posix.basename(r.relPath));assert(current.ok,current.error?.message);assert.equal(current.held,false);assert.equal(current.bootstrap.viewState.workspace.draft,'NOTE '+r.viewId);
 }
});

test('a same-byte replaced relocation target is refused before protection release',native,async t=>{
 const f=await fixture(t),journal=f.workspace.treeRecovery.journal;journal.release=async()=>{throw Error('synthetic boundary');};await assert.rejects(f.run(),/synthetic boundary/);
 await fs.rename(path.join(f.a,'新目录/一.txt'),path.join(f.a,'owned-original.txt'));await fs.writeFile(path.join(f.a,'新目录/一.txt'),'活源正文 中文😀\n');await f.host.settled();await f.host.storage.db.close();
 const result=await f.cold(f.surface,'新目录/一.txt');assert.equal(result.ok,false);assert.equal(result.error.code,'TREE_SURFACE_RECOVERY_CHANGED');assert.equal(await fs.readFile(path.join(f.a,'owned-original.txt'),'utf8'),'活源正文 中文😀\n');
});

test('repeated normal rename can cold-open the latest identity while original identities retain capsules',native,async t=>{
 const f=await fixture(t);await f.run();
 const payload={projectId:f.source.id,source:'新目录',action:'rename',name:'最终目录'},ops=new FileTreeOps(f.host,{trash:()=>assert.fail('no trash'),io:createFileTreeIO(f.host)});await f.workspace.mutateTree(payload,context=>ops.run(payload,context));
 await f.host.settled();await f.host.storage.db.close();for(const r of f.records){const result=await f.cold(r,r.relPath);assert(result.ok,result.error?.message);assert.equal(result.held,false);assert(r.relPath.startsWith('最终目录/'));}
});
