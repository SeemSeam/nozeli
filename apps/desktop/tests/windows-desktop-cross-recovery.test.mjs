import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DesktopHost} from '../src/main/host.mjs';
import {FileTreeOps} from '../src/main/file-tree-ops.mjs';
import {createFileTreeIO} from '../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../src/platform/windows/desktop-file-tree.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {windowsClipboardSnapshot} from '../src/platform/windows/clipboard-source.mjs';
import {TreeRecovery} from '../src/main/tree-recovery.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'},owner='synthetic-shell:cross:1',text='跨项目恢复 中文😀\n';
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-cross-recovery-')),profile=path.join(base,'profile'),a=path.join(base,'源 项目'),b=path.join(base,'目标 项目'),hosts=[];
 await ensureExperimentalPrivateDirectory(base,profile);await fs.mkdir(a);await fs.mkdir(b);await fs.writeFile(path.join(a,'文件.txt'),text);await fs.mkdir(path.join(a,'目录/空目录'),{recursive:true});await fs.writeFile(path.join(a,'目录/正文.txt'),text);
 const make=()=>{const host=new DesktopHost(profile);hosts.push(host);return host;};let host=make();const source=await host.requireProject((await host.pick(a)).project.id),target=await host.requireProject((await host.pick(b)).project.id);
 t.after(async()=>{for(const h of hosts)await h.storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 const ops=(options={},h=host)=>new FileTreeOps(h,{trash:()=>assert.fail('no trash'),io:{...createFileTreeIO(h),...createWindowsDesktopFileTreeIO(h,options)}});
 const run=(action='copy',relative='文件.txt',options={})=>ops(options).run({projectId:target.id,sourceProjectId:source.id,source:relative,action});
 const pending=async(id=target.id,h=host)=>h.storage.recoveryPage(id,{prefixes:['tree-operation:'],pendingOnly:true,purpose:'recovery-ui',limit:50,maxBytes:65536});
 const binding=async(id=target.id,h=host)=>{const page=await pending(id,h),row=page.entries[0];assert(row);return {projectId:id,id:row.id,revision:row.revision,version:page.version};};
 const row=async(id=target.id,h=host)=>h.storage.readRecoveryRecord(id,(await binding(id,h)).id);
 const published=relative=>({directorySync:async parent=>{if(await fs.stat(path.join(b,relative)).then(()=>true,()=>false)){parent.close();parent.syncDirectory();}else parent.syncDirectory();}});
 const aborted=()=>({beforePublish:()=>{throw Error('synthetic stop before publication');}});
 const reopen=()=>{host=make();return host;};
 return {base,profile,a,b,source,target,make,reopen,get host(){return host;},ops,run,pending,binding,row,published,aborted};
}
async function blocked(f,h=f.host){for(const p of [f.source,f.target])await assert.rejects(f.ops({},h).run({projectId:p.id,action:'createFile',name:'不能重放.txt'}),{code:'TREE_RECOVERY_REQUIRED'});}
async function released(f,h=f.host){for(const p of [f.source,f.target])assert.equal(await h.storage.pendingCrossTreeTransfer(p.id),null);assert.equal((await f.pending(f.source.id,h)).entries.length,0);assert.equal((await f.pending(f.target.id,h)).entries.length,0);}
async function crash(f,action,relative,checkpoint){await f.host.storage.db.close();const child=spawnSync(process.execPath,[path.join(import.meta.dirname,'fixtures/windows-cross-recovery-child.mjs'),f.profile,f.source.id,f.target.id,action,relative,checkpoint],{env:{...process.env},encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});assert.ifError(child.error);assert.equal(child.status,81,child.stdout+'\n'+child.stderr);f.reopen();}

for(const action of ['copy','cut'])for(const relative of ['文件.txt','目录'])test('explicit '+action+' recovery verifies published '+relative+' and preserves exact physical objects',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run(action,relative,f.published(relative)));await blocked(f);const before=await windowsClipboardSnapshot(path.join(f.b,relative)),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);
 assert.equal(plan.decision,action==='copy'?'keep-published-copy':'keep-published-move');assert.equal(plan.records,3);await service.settle({token:plan.token,confirmed:true},owner);await released(f);assert.deepEqual(await windowsClipboardSnapshot(path.join(f.b,relative)),before);
 if(action==='copy')assert.equal(await fs.readFile(path.join(f.a,relative==='目录'?'目录/正文.txt':relative),'utf8'),text);else await assert.rejects(fs.stat(path.join(f.a,relative)),{code:'ENOENT'});
 if(relative==='目录')assert.deepEqual(await fs.readdir(path.join(f.b,'目录/空目录')),[]);
});

test('real child exit retains a copied file stage and cold confirmation releases both projects without cleanup',native,async t=>{
 const f=await fixture(t);await crash(f,'copy','文件.txt','before');await blocked(f);const row=await f.row(),stage=path.join(f.b,row.value.effect.stagingName),before=await windowsClipboardSnapshot(stage),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(f.source.id),owner);
 assert.equal(plan.decision,'retain-aborted-copy');assert(plan.stageRetained);await service.settle({token:plan.token,confirmed:true},owner);await released(f);assert.deepEqual(await windowsClipboardSnapshot(stage),before);assert.equal(await fs.readFile(path.join(f.a,'文件.txt'),'utf8'),text);
 await f.host.storage.db.close();const cold=f.make();await released(f,cold);await f.ops({},cold).run({projectId:f.target.id,action:'createFile',name:'明确的新操作.txt'});
});

test('unpublished recursive copy retains its full surviving stage and source tree',native,async t=>{
 const f=await fixture(t);await crash(f,'copy','目录','before');const row=await f.row(),stage=path.join(f.b,row.value.effect.stagingName),before=await windowsClipboardSnapshot(stage),source=await windowsClipboardSnapshot(path.join(f.a,'目录')),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);
 assert.equal(plan.decision,'retain-aborted-copy');await service.settle({token:plan.token,confirmed:true},owner);await released(f);assert.deepEqual(await windowsClipboardSnapshot(stage),before);assert.deepEqual(await windowsClipboardSnapshot(path.join(f.a,'目录')),source);
});

for(const relative of ['文件.txt','目录'])test('unpublished cut of '+relative+' preserves original identity and explicit abort receipts',native,async t=>{
 const f=await fixture(t);await crash(f,'cut',relative,'before');const before=await windowsClipboardSnapshot(path.join(f.a,relative)),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);
 assert.equal(plan.decision,'retain-aborted-move');await service.settle({token:plan.token,confirmed:true},owner);await released(f);assert.deepEqual(await windowsClipboardSnapshot(path.join(f.a,relative)),before);await assert.rejects(fs.stat(path.join(f.b,relative)),{code:'ENOENT'});
});

test('real exit just after native cut publication is identified from exact original ID without file replay',native,async t=>{
 const f=await fixture(t);await crash(f,'cut','目录','after');const before=await windowsClipboardSnapshot(path.join(f.b,'目录')),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);
 assert.equal(plan.decision,'keep-published-move');await service.settle({token:plan.token,confirmed:true},owner);await released(f);assert.deepEqual(await windowsClipboardSnapshot(path.join(f.b,'目录')),before);await assert.rejects(fs.stat(path.join(f.a,'目录')),{code:'ENOENT'});
});

test('same bytes under a new target native identity refuse and retain the independent winner',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run('copy','文件.txt',f.published('文件.txt')));const service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);await fs.rename(path.join(f.b,'文件.txt'),path.join(f.b,'文件.txt.retained'));await fs.writeFile(path.join(f.b,'文件.txt'),text);
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner),{code:'TREE_RECOVERY_CHANGED'});assert.equal(await fs.readFile(path.join(f.b,'文件.txt'),'utf8'),text);await blocked(f);
});

test('published cut preserves a new foreign source-name winner and independently updated metadata/drafts',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run('cut','文件.txt',f.published('文件.txt')));await fs.writeFile(path.join(f.a,'文件.txt'),'FOREIGN SOURCE WINNER');const service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);
 for(const p of [f.source,f.target]){await f.host.storage.putProject(p.id,'provenance','文件.txt',{winner:p.id});await f.host.storage.putRecovery(p.id,'draft:cross-preserved',{relPath:'文件.txt',text:'UNSAVED '+p.id},{expectedRevision:0});}
 await service.settle({token:plan.token,confirmed:true},owner);await released(f);assert.equal(await fs.readFile(path.join(f.a,'文件.txt'),'utf8'),'FOREIGN SOURCE WINNER');
 for(const p of [f.source,f.target]){assert.deepEqual(await f.host.storage.getProject(p.id,'provenance','文件.txt'),{winner:p.id});assert.equal((await f.host.storage.getRecovery(p.id,'draft:cross-preserved')).text,'UNSAVED '+p.id);}
});

for(const scope of ['source','destination','registry'])test(scope+' CAS winner after preview invalidates confirmation without overwriting it',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run('copy','文件.txt',f.published('文件.txt')));const service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner),id=(await f.row()).id;
 if(scope==='registry'){const row=await f.host.storage.readCrossTreeTransfer(id);await f.host.storage.putCrossTreeTransfer(id,{...row.value,winner:scope},{expectedRevision:row.revision});}
 else{const p=scope==='source'?f.source:f.target,row=await f.host.storage.readRecoveryRecord(p.id,id);await f.host.storage.putRecovery(p.id,id,{...row.value,winner:scope},{expectedRevision:row.revision});}
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner),{code:'TREE_RECOVERY_CHANGED'});await blocked(f);
 const current=scope==='registry'?await f.host.storage.readCrossTreeTransfer(id):await f.host.storage.readRecoveryRecord(scope==='source'?f.source.id:f.target.id,id);assert.equal(current.value.winner,scope);
});

for(const action of ['copy','cut'])test('partial '+action+' acknowledgement failure retains both-project admission until cold explicit retry',native,async t=>{
 const f=await fixture(t);if(action==='copy')await crash(f,'copy','文件.txt','before');else await assert.rejects(f.run('cut','文件.txt',f.published('文件.txt')));
 const service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner),id=(await f.row()).id,put=f.host.storage.putRecovery.bind(f.host.storage);let injected=false;
 f.host.storage.putRecovery=async(...args)=>{if(!injected&&args[0]===f.target.id&&args[2]?.reconciliation){injected=true;const row=await f.host.storage.readRecoveryRecord(f.target.id,id);await put(f.target.id,id,{...row.value,winner:'independent remaining hold'},{expectedRevision:row.revision});}return put(...args);};
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner));f.host.storage.putRecovery=put;assert(injected);const acknowledged=await f.host.storage.getRecovery(f.source.id,id);await blocked(f);
 await f.host.storage.db.close();const cold=f.make(),recovery=new TreeRecovery(cold),next=await recovery.preview(await f.binding(f.target.id,cold),owner);await recovery.settle({token:next.token,confirmed:true},owner);await released(f,cold);assert.deepEqual(await cold.storage.getRecovery(f.source.id,id),{...acknowledged,phase:action==='copy'?'refused':'complete'});
});

test('real child exit after one acknowledgement leaves cold joint hold and is recoverable with a fresh token',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run('cut','文件.txt',f.published('文件.txt')));const before=await windowsClipboardSnapshot(path.join(f.b,'文件.txt'));await crash(f,'settle','文件.txt','settle');await blocked(f);
 const service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);await service.settle({token:plan.token,confirmed:true},owner);await released(f);assert.deepEqual(await windowsClipboardSnapshot(path.join(f.b,'文件.txt')),before);
});

test('already completed original registry is kept byte-for-byte while remaining local receipts are confirmed',native,async t=>{
 const f=await fixture(t);await crash(f,'copy','目录','complete');const id=(await f.row()).id,original=await f.host.storage.readCrossTreeTransfer(id),service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner);
 assert.equal(original.value.phase,'complete');await service.settle({token:plan.token,confirmed:true},owner);await released(f);const current=await f.host.storage.readCrossTreeTransfer(id);assert.equal(current.revision,original.revision);assert.deepEqual(current.value,original.value);
});

test('registry final CAS failure preserves visible acknowledged local receipts and cold common hold until fresh verification',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run('copy','文件.txt',f.published('文件.txt')));const service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner),put=f.host.storage.putCrossTreeTransfer.bind(f.host.storage);let injected=false;
 f.host.storage.putCrossTreeTransfer=async(id,value,options)=>{if(!injected&&value.reconciliation){injected=true;const row=await f.host.storage.readCrossTreeTransfer(id);await put(id,{...row.value,winner:'catalog CAS winner'},{expectedRevision:row.revision});}return put(id,value,options);};
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner));f.host.storage.putCrossTreeTransfer=put;await blocked(f);await f.host.storage.db.close();const cold=f.make(),recovery=new TreeRecovery(cold);
 assert(injected);assert.equal((await cold.storage.crossTreeTransferPage()).entries.length,1);const next=await recovery.preview(await f.binding(f.target.id,cold),owner);await recovery.settle({token:next.token,confirmed:true},owner);await released(f,cold);
});

for(const action of ['copy','cut'])test('final '+action+' local CAS failure after catalog commit retains a selectable hold and original terminal winner',native,async t=>{
 const f=await fixture(t);if(action==='copy')await crash(f,'copy','文件.txt','before');else await assert.rejects(f.run('cut','文件.txt',f.published('文件.txt')));
 const service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner),id=(await f.row()).id,put=f.host.storage.putRecovery.bind(f.host.storage),phase=action==='copy'?'refused':'complete';let injected=false;
 f.host.storage.putRecovery=async(...args)=>{if(!injected&&args[0]===f.target.id&&args[2]?.reconciliation&&args[2].phase===phase){injected=true;const row=await f.host.storage.readRecoveryRecord(f.target.id,id);await put(f.target.id,id,{...row.value,winner:'terminal local contender'},{expectedRevision:row.revision});}return put(...args);};
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner));f.host.storage.putRecovery=put;assert(injected);const acknowledged=await f.host.storage.getRecovery(f.source.id,id),catalog=await f.host.storage.readCrossTreeTransfer(id);assert.equal(acknowledged.phase,phase);assert(catalog.value.settled);assert.equal((await f.pending()).entries.length,1);
 await f.host.storage.db.close();const cold=f.make(),recovery=new TreeRecovery(cold),next=await recovery.preview(await f.binding(f.target.id,cold),owner);await recovery.settle({token:next.token,confirmed:true},owner);await released(f,cold);assert.deepEqual(await cold.storage.getRecovery(f.source.id,id),acknowledged);const catalogAfter=await cold.storage.readCrossTreeTransfer(id);assert.deepEqual(catalogAfter.value,catalog.value);assert.equal(catalogAfter.revision,catalog.revision);
});

test('cross confirmation enforces owner, affirmative consent, expiry, generation and single use',native,async t=>{
 const f=await fixture(t);await crash(f,'cut','文件.txt','before');let now=Date.now();const service=new TreeRecovery(f.host,{now:()=>now}),plan=await service.preview(await f.binding(),owner);
 await assert.rejects(service.settle({token:plan.token,confirmed:false},owner),{code:'INVALID_RECOVERY_CONFIRMATION'});await assert.rejects(service.settle({token:plan.token,confirmed:true},'other-shell'),{code:'TREE_RECOVERY_EXPIRED'});now+=300001;await assert.rejects(service.settle({token:plan.token,confirmed:true},owner),{code:'TREE_RECOVERY_EXPIRED'});
 const stale=await service.preview(await f.binding(),owner);await assert.rejects(service.settle({token:stale.token,confirmed:true},owner,()=>{throw Object.assign(Error('window changed'),{code:'IPC_DENIED'});}),{code:'IPC_DENIED'});await blocked(f);
 const next=await service.preview(await f.binding(),owner);await service.settle({token:next.token,confirmed:true},owner);await assert.rejects(service.settle({token:next.token,confirmed:true},owner),{code:'TREE_RECOVERY_EXPIRED'});await released(f);
});

test('unrelated source recovery records survive confirmation and keep their independent mutation hold',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run('copy','文件.txt',f.published('文件.txt')));const service=new TreeRecovery(f.host),plan=await service.preview(await f.binding(),owner),id='tree-operation:00000000-0000-0000-0000-000000000001',winner={schema:73,phase:'future',winner:true};await f.host.storage.putRecovery(f.source.id,id,winner,{expectedRevision:0});
 await service.settle({token:plan.token,confirmed:true},owner);assert.deepEqual(await f.host.storage.getRecovery(f.source.id,id),winner);await assert.rejects(f.ops().run({projectId:f.source.id,action:'createFile',name:'仍应阻塞.txt'}),{code:'TREE_RECOVERY_REQUIRED'});await f.ops().run({projectId:f.target.id,action:'createFile',name:'目标独立操作.txt'});
});

test('malformed or mismatched counterpart and missing registry refuse without guessing ownership',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run('copy','文件.txt',f.published('文件.txt')));const selected=await f.binding(),row=await f.host.storage.readRecoveryRecord(f.source.id,selected.id),service=new TreeRecovery(f.host);
 for(const patch of [{schema:2},{role:'destination'},{action:'cut'},{crossTransfer:1},{sourceBinding:{instanceId:'unknown',identity:{}}}]){const current=await f.host.storage.readRecoveryRecord(f.source.id,selected.id);await f.host.storage.putRecovery(f.source.id,selected.id,{...row.value,...patch},{expectedRevision:current.revision});await assert.rejects(service.preview(await f.binding(),owner));}
 const current=await f.host.storage.readRecoveryRecord(f.source.id,selected.id);await f.host.storage.putRecovery(f.source.id,selected.id,row.value,{expectedRevision:current.revision});const registry=await f.host.storage.readCrossTreeTransfer(selected.id);await f.host.storage.putCrossTreeTransfer(selected.id,null,{expectedRevision:registry.revision});await assert.rejects(service.preview(await f.binding(),owner));await blocked(f);
});
