import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DesktopHost} from '../src/main/host.mjs';
import {FileTreeOps} from '../src/main/file-tree-ops.mjs';
import {TreeRecovery} from '../src/main/tree-recovery.mjs';
import {createFileTreeIO} from '../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../src/platform/windows/desktop-file-tree.mjs';
import {importClipboardFiles} from '../src/main/file-clipboard-import.mjs';
import {fileIdentity} from '../src/main/file-clipboard.mjs';
import {windowsClipboardIdentity,windowsClipboardSnapshot} from '../src/platform/windows/clipboard-source.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'},text='恢复核对 中文😀\n',owner='synthetic-shell:1';
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-tree-recovery-')),profile=path.join(base,'profile'),source=path.join(base,'外部源'),root=path.join(base,'项目'),hosts=[];
 await ensureExperimentalPrivateDirectory(base,profile);await fs.mkdir(source);await fs.mkdir(root);await fs.writeFile(path.join(source,'文件.txt'),text);await fs.mkdir(path.join(source,'目录/空目录'),{recursive:true});await fs.writeFile(path.join(source,'目录/正文.txt'),text);
 const make=()=>{const host=new DesktopHost(profile);hosts.push(host);return host;};let host=make();const project=await host.requireProject((await host.pick(root)).project.id);
 t.after(async()=>{for(const h of hosts)await h.storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 const ops=(options={},h=host)=>new FileTreeOps(h,{trash:()=>assert.fail('no trash'),io:{...createFileTreeIO(h),...createWindowsDesktopFileTreeIO(h,options)}});
 const copy=async(relative='文件.txt',options={})=>{const absolute=path.join(source,relative);return importClipboardFiles(ops(options),[{source:absolute,name:relative,identity:fileIdentity(await fs.lstat(absolute)),nativeIdentity:await windowsClipboardIdentity(absolute)}],{projectId:project.id});};
 const binding=async(h=host,id)=>{const page=await h.storage.recoveryPage(project.id,{prefixes:['tree-operation:'],pendingOnly:true,purpose:'recovery-ui',limit:50,maxBytes:64*1024}),row=id?page.entries.find(row=>row.id===id):page.entries[0];assert(row);return {projectId:project.id,id:row.id,revision:row.revision,version:page.version};};
 const pending=async(h=host)=>{const result=await h.storage.recoveryPage(project.id,{prefixes:['tree-operation:'],pendingOnly:true,purpose:'recovery-ui'});return result.entries;};
 const aborted=()=>({beforePublish:()=>{throw Object.assign(Error('synthetic stop before publication'),{code:'SYNTHETIC_STOP'});}});
 const published=relative=>({directorySync:async parent=>{if(await fs.stat(path.join(root,relative)).then(()=>true,()=>false)){parent.close();parent.syncDirectory();}else parent.syncDirectory();}});
 return {base,profile,source,root,get host(){return host;},project,make,reopen(){host=make();return host;},ops,copy,binding,pending,aborted,published};
}
async function retainedFile(f){await f.host.storage.db.close();const child=spawnSync(process.execPath,[path.join(import.meta.dirname,'fixtures/windows-tree-recovery-child.mjs'),f.profile,f.project.id,'copy-stage',path.join(f.source,'文件.txt')],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env},encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});assert.ifError(child.error);assert.equal(child.status,80,child.stdout+'\n'+child.stderr);f.reopen();}
async function held(f,h=f.host){await assert.rejects(f.ops({},h).run({projectId:f.project.id,action:'createFile',name:'不应重放.txt'}),{code:'TREE_RECOVERY_REQUIRED'});}
async function primary(f){return f.host.storage.readRecoveryRecord(f.project.id,(await f.binding()).id);}
async function holdFor(f,row){const id='tree-operation:'+randomUUID();await f.host.storage.putRecovery(f.project.id,id,{schema:1,kind:'record',clipboardImport:true,operationId:row.value.operationId,relatedRecoveryKey:row.id,projectId:f.project.id,destination:row.value.destination,relPath:row.value.destination,phase:'needs-attention',published:row.value.effect?.published===true,commitUnknown:true},{expectedRevision:0});return id;}

test('explicit aborted file recovery retains exact stage/source and permits a new operation after cold reopen',native,async t=>{
 const f=await fixture(t);await retainedFile(f);await held(f);
 const row=await primary(f),stage=path.join(f.root,row.value.effect.stagingName),before=await windowsClipboardSnapshot(stage),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);
 assert.equal(plan.decision,'retain-aborted-copy');assert.equal(plan.stageRetained,true);assert.equal((await primary(f)).revision,row.revision);
 assert.equal((await service.settle({token:plan.token,confirmed:true},owner)).namespaceChanged,false);assert.deepEqual(await windowsClipboardSnapshot(stage),before);assert.equal(await fs.readFile(path.join(f.source,'文件.txt'),'utf8'),text);
 await f.host.storage.db.close();const cold=f.make();assert.deepEqual(await f.pending(cold),[]);await f.ops({},cold).run({projectId:f.project.id,action:'createFile',name:'明确的新文件.txt'});assert.equal(await fs.readFile(stage,'utf8'),text);
});
test('actual post-publication barrier failure is settled by exact file identity/content without copying again',native,async t=>{
 const f=await fixture(t);assert.equal((await f.copy('文件.txt',f.published('文件.txt'))).items[0].ok,false);const before=await windowsClipboardSnapshot(path.join(f.root,'文件.txt')),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);
 assert.equal(plan.decision,'keep-published-copy');await service.settle({token:plan.token,confirmed:true},owner);assert.deepEqual(await windowsClipboardSnapshot(path.join(f.root,'文件.txt')),before);assert.deepEqual(await f.pending(),[]);assert.equal(await fs.readFile(path.join(f.source,'文件.txt'),'utf8'),text);
});
test('partial directory allocation recovery retains full remaining tree and original allocation identities',native,async t=>{
 const f=await fixture(t),put=f.host.storage.putRecovery.bind(f.host.storage);let injected=false;
 f.host.storage.putRecovery=async(...args)=>{const value=args[2];if(!injected&&value?.clipboardImport&&value.phase==='prepared'&&value.effect?.allocated?.length>=2){injected=true;throw Error('synthetic partial tree');}return put(...args);};
 assert.equal((await f.copy('目录')).items[0].ok,false);assert(injected);f.host.storage.putRecovery=put;
 const row=await primary(f),stage=path.join(f.root,row.value.effect.stagingName),before=await windowsClipboardSnapshot(stage),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);
 assert.equal(plan.stageRetained,true);await service.settle({token:plan.token,confirmed:true},owner);assert.deepEqual(await windowsClipboardSnapshot(stage),before);assert.equal(await fs.readFile(path.join(f.source,'目录/正文.txt'),'utf8'),text);assert.deepEqual(await f.pending(),[]);
});
test('published directory is verified against the retained destination manifest including empty directories',native,async t=>{
 const f=await fixture(t);assert.equal((await f.copy('目录',f.published('目录'))).items[0].ok,false);const before=await windowsClipboardSnapshot(path.join(f.root,'目录')),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);
 assert.equal(plan.decision,'keep-published-copy');await service.settle({token:plan.token,confirmed:true},owner);assert.deepEqual(await windowsClipboardSnapshot(path.join(f.root,'目录')),before);assert.deepEqual(await fs.readdir(path.join(f.root,'目录/空目录')),[]);
});
test('record CAS winner invalidates confirmation and remains intact',native,async t=>{
 const f=await fixture(t);await f.copy('文件.txt',f.aborted());const row=await primary(f),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner),winner={...row.value,operatorNote:'independent winner'};
 await f.host.storage.putRecovery(f.project.id,row.id,winner,{expectedRevision:row.revision});await assert.rejects(service.settle({token:plan.token,confirmed:true},owner),{code:'TREE_RECOVERY_CHANGED'});assert.deepEqual(await f.host.storage.getRecovery(f.project.id,row.id),winner);await held(f);
});
test('destination replacement with identical bytes does not inherit the original copy identity',native,async t=>{
 const f=await fixture(t);await f.copy('文件.txt',f.published('文件.txt'));const service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner),target=path.join(f.root,'文件.txt');await fs.rename(target,target+'.retained');await fs.writeFile(target,text);
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner),{code:'TREE_RECOVERY_CHANGED'});assert.equal(await fs.readFile(target,'utf8'),text);await held(f);
});
test('stage content changes between preview and acceptance preserve the changed bytes and hold',native,async t=>{
 const f=await fixture(t);await retainedFile(f);const row=await primary(f),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner),stage=path.join(f.root,row.value.effect.stagingName);await fs.writeFile(stage,'EXTERNAL STAGE WINNER');
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner),{code:'TREE_RECOVERY_CHANGED'});assert.equal(await fs.readFile(stage,'utf8'),'EXTERNAL STAGE WINNER');await held(f);
});
test('confirmation binds owner, expiry, affirmative consent and one use',native,async t=>{
 const f=await fixture(t);await f.copy('文件.txt',f.aborted());let now=Date.now();const service=new TreeRecovery(f.host,{now:()=>now}),plan=await service.preview(await f.binding(),owner);
 await assert.rejects(service.settle({token:plan.token,confirmed:false},owner),{code:'INVALID_RECOVERY_CONFIRMATION'});await assert.rejects(service.settle({token:plan.token,confirmed:true},'other-shell'),{code:'TREE_RECOVERY_EXPIRED'});
 now+=300001;await assert.rejects(service.settle({token:plan.token,confirmed:true},owner),{code:'TREE_RECOVERY_EXPIRED'});const next=await service.preview(await f.binding(),owner);await service.settle({token:next.token,confirmed:true},owner);await assert.rejects(service.settle({token:next.token,confirmed:true},owner),{code:'TREE_RECOVERY_EXPIRED'});
});
test('complete primary CAS winner is retained while independent uncertainty receipt is reconciled',native,async t=>{
 const f=await fixture(t);await f.copy('文件.txt',f.published('文件.txt'));const row=await primary(f),winner={...row.value,phase:'complete',winner:'already acknowledged'};await f.host.storage.putRecovery(f.project.id,row.id,winner,{expectedRevision:row.revision});const id=await holdFor(f,row),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(f.host,id),owner);
 assert.equal(plan.records,2);await service.settle({token:plan.token,confirmed:true},owner);assert.deepEqual(await f.host.storage.getRecovery(f.project.id,row.id),winner);assert.equal((await f.host.storage.getRecovery(f.project.id,id)).phase,'complete');assert.deepEqual(await f.pending(),[]);
});
test('new related hold or window generation change invalidates pending confirmation',native,async t=>{
 const f=await fixture(t);await f.copy('文件.txt',f.aborted());const row=await primary(f),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);await holdFor(f,row);
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner),{code:'TREE_RECOVERY_CHANGED'});const next=await service.preview(await f.binding(),owner);
 await assert.rejects(service.settle({token:next.token,confirmed:true},owner,()=>{throw Object.assign(Error('window changed'),{code:'IPC_DENIED'});}),{code:'IPC_DENIED'});await held(f);
});
test('partial receipt CAS failure keeps remaining cold hold and does not overwrite another writer',native,async t=>{
 const f=await fixture(t);await f.copy('文件.txt',f.published('文件.txt'));const row=await primary(f),id=await holdFor(f,row),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(f.host,id),owner),put=f.host.storage.putRecovery.bind(f.host.storage);
 f.host.storage.putRecovery=async(...args)=>{if(args[1]===id&&args[2]?.reconciliation){const current=await f.host.storage.readRecoveryRecord(f.project.id,id);await put(f.project.id,id,{...current.value,winner:'independent'},{expectedRevision:current.revision});}return put(...args);};
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner));f.host.storage.putRecovery=put;assert.equal((await f.host.storage.getRecovery(f.project.id,row.id)).phase,'complete');assert.equal((await f.host.storage.getRecovery(f.project.id,id)).winner,'independent');await held(f);
 await f.host.storage.db.close();const cold=f.make();await held(f,cold);const recovery=new TreeRecovery(cold),next=await recovery.preview(await f.binding(cold,id),owner);await recovery.settle({token:next.token,confirmed:true},owner);assert.deepEqual(await f.pending(cold),[]);
});
test('actual child exit between primary and hold acknowledgement preserves cold hold and zero file replay',native,async t=>{
 const f=await fixture(t);await f.copy('文件.txt',f.published('文件.txt'));const row=await primary(f),id=await holdFor(f,row),before=await windowsClipboardSnapshot(path.join(f.root,'文件.txt'));await f.host.storage.db.close();
 const child=spawnSync(process.execPath,[path.join(import.meta.dirname,'fixtures/windows-tree-recovery-child.mjs'),f.profile,f.project.id,id],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env},encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});assert.ifError(child.error);assert.equal(child.status,79,child.stdout+'\n'+child.stderr);
 const cold=f.make();await held(f,cold);assert.deepEqual(await windowsClipboardSnapshot(path.join(f.root,'文件.txt')),before);const recovery=new TreeRecovery(cold),plan=await recovery.preview(await f.binding(cold,id),owner);await recovery.settle({token:plan.token,confirmed:true},owner);assert.deepEqual(await f.pending(cold),[]);
});
test('unrecognized/cross/cut recovery cannot be acknowledged as an external copy',native,async t=>{
 const f=await fixture(t);await f.copy('文件.txt',f.aborted());const row=await primary(f),service=new TreeRecovery(f.host);
 for(const patch of [{action:'cut'},{crossTransfer:true},{clipboardImport:1},{schema:2},{metadataPolicy:'unknown'}]){const current=await f.host.storage.readRecoveryRecord(f.project.id,row.id);await f.host.storage.putRecovery(f.project.id,row.id,{...row.value,...patch},{expectedRevision:current.revision});await assert.rejects(service.preview(await f.binding(),owner));}
 await held(f);assert.equal(await fs.readFile(path.join(f.source,'文件.txt'),'utf8'),text);
});
test('aborted retained copy can acknowledge a foreign destination while preserving its latest bytes',native,async t=>{
 const f=await fixture(t);await retainedFile(f);const row=await primary(f),stage=path.join(f.root,row.value.effect.stagingName),before=await windowsClipboardSnapshot(stage),target=path.join(f.root,'文件.txt');await fs.writeFile(target,'FOREIGN WINNER');
 const service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);assert.equal(plan.decision,'retain-aborted-copy');await fs.writeFile(target,'LATEST FOREIGN WINNER');await service.settle({token:plan.token,confirmed:true},owner);
 assert.equal(await fs.readFile(target,'utf8'),'LATEST FOREIGN WINNER');assert.deepEqual(await windowsClipboardSnapshot(stage),before);assert.equal(await fs.readFile(path.join(f.source,'文件.txt'),'utf8'),text);
});
test('recovery receipt acknowledgement preserves independently updated provenance and draft records',native,async t=>{
 const f=await fixture(t);await f.copy('文件.txt',f.published('文件.txt'));await f.host.storage.putProject(f.project.id,'provenance','文件.txt',{note:'before'});const service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);
 await f.host.storage.putProject(f.project.id,'provenance','文件.txt',{note:'independent metadata winner'});const draft={relPath:'文件.txt',text:'UNSAVED WINNER'};await f.host.storage.putRecovery(f.project.id,'draft:synthetic-copy-recovery',draft,{expectedRevision:0});
 await service.settle({token:plan.token,confirmed:true},owner);assert.deepEqual(await f.host.storage.getProject(f.project.id,'provenance','文件.txt'),{note:'independent metadata winner'});assert.deepEqual(await f.host.storage.getRecovery(f.project.id,'draft:synthetic-copy-recovery'),draft);
});

test('aborted copy primary acknowledgement survives a later hold CAS failure and cold explicit retry',native,async t=>{
 const f=await fixture(t);await retainedFile(f);const row=await primary(f),id=await holdFor(f,row),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(f.host,id),owner),put=f.host.storage.putRecovery.bind(f.host.storage),stage=path.join(f.root,row.value.effect.stagingName),before=await windowsClipboardSnapshot(stage);
 f.host.storage.putRecovery=async(...args)=>{if(args[1]===id&&args[2]?.reconciliation){const current=await f.host.storage.readRecoveryRecord(f.project.id,id);await put(f.project.id,id,{...current.value,winner:'independent aborted hold'},{expectedRevision:current.revision});}return put(...args);};
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner));f.host.storage.putRecovery=put;const acknowledged=await f.host.storage.getRecovery(f.project.id,row.id);assert.equal(acknowledged.phase,'refused');assert.equal((await f.host.storage.getRecovery(f.project.id,id)).winner,'independent aborted hold');await held(f);
 await f.host.storage.db.close();const cold=f.make();await held(f,cold);const recovery=new TreeRecovery(cold),next=await recovery.preview(await f.binding(cold,id),owner);assert.equal(next.decision,'retain-aborted-copy');await recovery.settle({token:next.token,confirmed:true},owner);assert.deepEqual(await cold.storage.getRecovery(f.project.id,row.id),acknowledged);assert.deepEqual(await f.pending(cold),[]);assert.deepEqual(await windowsClipboardSnapshot(stage),before);assert.equal(await fs.readFile(path.join(f.source,'文件.txt'),'utf8'),text);
});
