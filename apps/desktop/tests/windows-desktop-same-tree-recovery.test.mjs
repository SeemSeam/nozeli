import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DesktopHost} from '../src/main/host.mjs';
import {FileTreeOps} from '../src/main/file-tree-ops.mjs';
import {TreeRecovery} from '../src/main/tree-recovery.mjs';
import {createFileTreeIO} from '../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../src/platform/windows/desktop-file-tree.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'},hash=value=>createHash('sha256').update(value).digest('hex'),owner='same-tree-synthetic:1';
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-same-tree-')),profile=path.join(base,'profile'),root=path.join(base,'项目 空格'),hosts=[];
 await ensureExperimentalPrivateDirectory(base,profile);await fs.mkdir(root);await fs.mkdir(path.join(root,'目标'));await fs.writeFile(path.join(root,'原文件.txt'),'原文 中文😀\n');
 const make=()=>{const h=new DesktopHost(profile);hosts.push(h);return h;},host=make(),project=await host.requireProject((await host.pick(root)).project.id);
 t.after(async()=>{for(const h of hosts)await h.storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 const run=(input,options={})=>new FileTreeOps(host,{trash:()=>assert.fail('no trash'),io:{...createFileTreeIO(host),...createWindowsDesktopFileTreeIO(host,options)}}).run({projectId:project.id,source:'原文件.txt',...input});
 const rows=async(h=host)=>{const page=await h.storage.recoveryPage(project.id,{prefixes:['tree-operation:'],pendingOnly:true});return page.entries;};
 const selected=async(h=host)=>{const page=await h.storage.recoveryPage(project.id,{prefixes:['tree-operation:'],pendingOnly:true,purpose:'recovery-ui'});assert.equal(page.entries.length,1);const row=page.entries[0];return {projectId:project.id,id:row.id,revision:row.revision,version:page.version};};
 const settle=async(h=host)=>{const service=new TreeRecovery(h),plan=await service.preview(await selected(h),owner);return {plan,result:await service.settle({token:plan.token,confirmed:true},owner)};};
 const published=relative=>({directorySync:parent=>{if(relative&&requireExists(path.join(root,relative)))parent.close();parent.syncDirectory();}});
 return {base,profile,root,host,project,make,run,rows,selected,settle,published};
}
import {existsSync as requireExists} from 'node:fs';
async function seed(f){
 const id=f.project.id,read=await f.host.readFile(id,'原文件.txt');await f.host.addAnnotation(id,{relPath:'原文件.txt',materialDigest:read.materialDigest,kind:'text-selection',anchor:{start:0,end:2,quote:'原文'},note:'保留原批注'});
 await f.host.storage.putProject(id,'provenance','原文件.txt',{relPath:'原文件.txt',origin:'synthetic'});await f.host.draft(id,'原文件.txt',read.digest,'尚未保存的人工草稿');
 return await f.host.storage.getRecovery(id,'draft:'+hash('原文件.txt'));
}
test('published same-project rename reconciles original metadata/draft plan after native barrier failure without replay',native,async t=>{
 const f=await fixture(t),draft=await seed(f);await assert.rejects(f.run({action:'rename',name:'改名.txt'},f.published('改名.txt')));const before=await fs.stat(path.join(f.root,'改名.txt'),{bigint:true});
 await f.host.storage.putProject(f.project.id,'provenance','无关.txt',{note:'unrelated winner'});
 const {plan}=await f.settle();assert.equal(plan.decision,'keep-published-move');assert.deepEqual(await f.rows(),[]);assert.equal((await fs.stat(path.join(f.root,'改名.txt'),{bigint:true})).ino,before.ino);
 assert.deepEqual(await f.host.storage.getRecovery(f.project.id,'draft:'+hash('改名.txt')),{...draft,relPath:'改名.txt'});assert.equal(await f.host.storage.getRecovery(f.project.id,'draft:'+hash('原文件.txt')),null);assert.equal((await f.host.storage.getProject(f.project.id,'provenance','改名.txt')).origin,'synthetic');assert.deepEqual(await f.host.storage.getProject(f.project.id,'provenance','无关.txt'),{note:'unrelated winner'});
 await assert.rejects(fs.stat(path.join(f.root,'原文件.txt')),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(f.root,'改名.txt'),'utf8'),'原文 中文😀\n');
});
test('published same-project copy completes original metadata identities and never moves source draft',native,async t=>{
 const f=await fixture(t);await seed(f);await f.host.storage.putRecovery(f.project.id,'draft:'+hash('原文件.txt'),null);await assert.rejects(f.run({action:'copy',target:'目标'},f.published('目标/原文件.txt')));
 await f.settle();const old=await f.host.storage.getProject(f.project.id,'file_tags',hash('原文件.txt')),copy=await f.host.storage.getProject(f.project.id,'file_tags',hash('目标/原文件.txt'));assert.notEqual(copy.file.fileId,old.file.fileId);assert.notEqual(copy.tags[0].id,old.tags[0].id);assert.equal(copy.tags[0].note,old.tags[0].note);assert.equal(await fs.readFile(path.join(f.root,'原文件.txt'),'utf8'),'原文 中文😀\n');
});
test('metadata response loss followed by independent process restart finishes exact original draft migration',native,async t=>{
 const f=await fixture(t),draft=await seed(f),replace=f.host.storage.replaceProjectCollections.bind(f.host.storage);let injected=false;
 f.host.storage.replaceProjectCollections=async(...args)=>{await replace(...args);injected=true;throw Object.assign(Error('metadata reply lost'),{code:'STORAGE_RESULT_UNKNOWN'});};
 await assert.rejects(f.run({action:'rename',name:'改名.txt'}));assert(injected);f.host.storage.replaceProjectCollections=replace;await f.host.storage.db.close();
 const input=path.join(f.base,'input.json'),out=path.join(f.base,'output.json');await fs.writeFile(input,JSON.stringify({profile:f.profile,projectId:f.project.id}));
 const child=spawnSync(process.execPath,[path.join(import.meta.dirname,'fixtures/windows-same-tree-child.mjs'),input,out],{env:{...process.env},encoding:'utf8',windowsHide:true,timeout:120000});assert.ifError(child.error);assert.equal(child.status,0,child.stderr);const result=JSON.parse(await fs.readFile(out,'utf8'));assert(result.ok);assert.notEqual(result.pid,process.pid);
 const cold=f.make();assert.deepEqual(await cold.storage.getRecovery(f.project.id,'draft:'+hash('改名.txt')),{...draft,relPath:'改名.txt'});assert.deepEqual(await f.rows(cold),[]);
});
test('partial draft migration with lost target reply is explicitly resumable without duplicate source effects',native,async t=>{
 const f=await fixture(t),draft=await seed(f),put=f.host.storage.putRecoveryRecords.bind(f.host.storage);let injected=false;
 // Reconstruct an older partial migration at the real storage boundary.
 f.host.storage.putRecoveryRecords=async(id,rows)=>{if(!injected){injected=true;const target=rows.find(row=>row.id==='draft:'+hash('改名.txt'));await f.host.storage.putRecovery(id,target.id,target.value,{expectedRevision:target.expectedRevision});throw Error('old target-only reply lost');}return put(id,rows);};
 await assert.rejects(f.run({action:'rename',name:'改名.txt'}));f.host.storage.putRecoveryRecords=put;assert(injected);await f.settle();assert.deepEqual(await f.host.storage.getRecovery(f.project.id,'draft:'+hash('改名.txt')),{...draft,relPath:'改名.txt'});assert.equal(await f.host.storage.getRecovery(f.project.id,'draft:'+hash('原文件.txt')),null);
});
test('recovery transaction reply loss leaves drafts and final receipt committed together',native,async t=>{
 const f=await fixture(t);await seed(f);await assert.rejects(f.run({action:'rename',name:'改名.txt'},f.published('改名.txt')));
 const service=new TreeRecovery(f.host),plan=await service.preview(await f.selected(),owner),put=f.host.storage.putRecoveryRecords.bind(f.host.storage);let injected=false;
 f.host.storage.putRecoveryRecords=async(...args)=>{const r=await put(...args);injected=true;throw Error('whole transaction reply lost');};
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner));f.host.storage.putRecoveryRecords=put;assert(injected);assert.deepEqual(await f.rows(),[]);assert.equal((await f.host.storage.getRecovery(f.project.id,'draft:'+hash('改名.txt'))).text,'尚未保存的人工草稿');assert.equal(await f.host.storage.getRecovery(f.project.id,'draft:'+hash('原文件.txt')),null);
});
test('final mutation receipt acknowledgement loss preserves the committed receipt and requires no replay',native,async t=>{
 const f=await fixture(t),put=f.host.storage.putRecoveryRecords.bind(f.host.storage);let injected=false,complete;
 f.host.storage.putRecoveryRecords=async(id,rows)=>{const result=await put(id,rows);if(!injected){injected=true;complete=rows.find(row=>row.id.startsWith('tree-operation:')).value;throw Object.assign(Error('complete reply lost'),{code:'STORAGE_RESULT_UNKNOWN'});}return result;};
 await assert.rejects(f.run({action:'rename',name:'改名.txt'}));f.host.storage.putRecoveryRecords=put;assert(injected);assert.deepEqual(await f.rows(),[]);assert.deepEqual(await f.host.storage.getRecovery(f.project.id,'tree-operation:'+complete.operationId),complete);assert.equal(await fs.readFile(path.join(f.root,'改名.txt'),'utf8'),'原文 中文😀\n');
});
test('same-byte draft rewritten by another writer cannot be silently cleared as original revision',native,async t=>{
 const f=await fixture(t),draft=await seed(f);await assert.rejects(f.run({action:'rename',name:'改名.txt'},f.published('改名.txt')));await f.host.storage.putRecovery(f.project.id,'draft:'+hash('原文件.txt'),draft);
 await assert.rejects(new TreeRecovery(f.host).preview(await f.selected(),owner),{code:'TREE_RECOVERY_CHANGED'});assert.deepEqual(await f.host.storage.getRecovery(f.project.id,'draft:'+hash('原文件.txt')),draft);
});
test('a target draft winner at the final transaction boundary keeps the original source draft and pending receipt',native,async t=>{
 const f=await fixture(t),draft=await seed(f);await assert.rejects(f.run({action:'rename',name:'改名.txt'},f.published('改名.txt')));
 const service=new TreeRecovery(f.host),plan=await service.preview(await f.selected(),owner),put=f.host.storage.putRecoveryRecords.bind(f.host.storage);
 f.host.storage.putRecoveryRecords=async(id,rows)=>{await f.host.storage.putRecovery(id,'draft:'+hash('改名.txt'),{relPath:'改名.txt',text:'CONCURRENT TARGET WINNER'},{expectedRevision:0});return put(id,rows);};
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner),{code:'STORAGE_CONFLICT'});f.host.storage.putRecoveryRecords=put;
 assert.deepEqual(await f.host.storage.getRecovery(f.project.id,'draft:'+hash('原文件.txt')),draft);assert.equal((await f.host.storage.getRecovery(f.project.id,'draft:'+hash('改名.txt'))).text,'CONCURRENT TARGET WINNER');assert.equal((await f.rows()).length,1);
});
test('published directory move recovers descendant drafts and full manifest including empty children',native,async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.root,'目录/空目录'),{recursive:true});await fs.writeFile(path.join(f.root,'目录/正文.txt'),'directory body');const read=await f.host.readFile(f.project.id,'目录/正文.txt');await f.host.draft(f.project.id,'目录/正文.txt',read.digest,'directory draft');
 await assert.rejects(f.run({action:'cut',source:'目录',target:'目标'},f.published('目标/目录')));await f.settle();assert.equal((await f.host.storage.getRecovery(f.project.id,'draft:'+hash('目标/目录/正文.txt'))).text,'directory draft');assert.deepEqual(await fs.readdir(path.join(f.root,'目标/目录/空目录')),[]);assert.equal(await fs.readFile(path.join(f.root,'目标/目录/正文.txt'),'utf8'),'directory body');
});
test('new user contents in an uncertain created object are preserved with its unresolved record',native,async t=>{
 for(const action of ['createFile','createFolder']){
  const f=await fixture(t);await assert.rejects(f.run({action,name:'新建'},f.published('新建')));const target=path.join(f.root,'新建',...(action==='createFolder'?['新增.txt']:[]));await fs.writeFile(target,'NEW USER CONTENT');
  await assert.rejects(new TreeRecovery(f.host).preview(await f.selected(),owner),{code:'TREE_RECOVERY_CHANGED'});assert.equal(await fs.readFile(target,'utf8'),'NEW USER CONTENT');assert.equal((await f.rows()).length,1);
 }
});
for(const kind of ['metadata','draft','file'])test('independent '+kind+' winner after preview invalidates settlement and is never overwritten',native,async t=>{
 const f=await fixture(t);await seed(f);await assert.rejects(f.run({action:'rename',name:'改名.txt'},f.published('改名.txt')));const service=new TreeRecovery(f.host),plan=await service.preview(await f.selected(),owner);
 if(kind==='metadata')await f.host.storage.putProject(f.project.id,'provenance','原文件.txt',{relPath:'原文件.txt',winner:'independent'});
 if(kind==='draft')await f.host.storage.putRecovery(f.project.id,'draft:'+hash('原文件.txt'),{relPath:'原文件.txt',text:'independent draft'});
 if(kind==='file'){await fs.rename(path.join(f.root,'改名.txt'),path.join(f.root,'原目标保留.txt'));await fs.writeFile(path.join(f.root,'改名.txt'),'原文 中文😀\n');}
 await assert.rejects(service.settle({token:plan.token,confirmed:true},owner),{code:'TREE_RECOVERY_CHANGED'});assert.equal((await f.rows()).length,1);
 if(kind==='metadata')assert.equal((await f.host.storage.getProject(f.project.id,'provenance','原文件.txt')).winner,'independent');if(kind==='draft')assert.equal((await f.host.storage.getRecovery(f.project.id,'draft:'+hash('原文件.txt'))).text,'independent draft');
});
test('concurrent operation receipt winner survives original mutation error handling',native,async t=>{
 const f=await fixture(t),put=f.host.storage.putRecovery.bind(f.host.storage);let winner;
 f.host.storage.putRecovery=async(id,key,value,options)=>{if(value?.sameProject&&value.phase==='prepared'&&!winner){const current=await f.host.storage.readRecoveryRecord(id,key);winner={...current.value,phase:'future-winner',note:'retain'};await put(id,key,winner,{expectedRevision:current.revision});}return put(id,key,value,options);};
 await assert.rejects(f.run({action:'rename',name:'改名.txt'}));f.host.storage.putRecovery=put;const page=await f.rows();assert.deepEqual(await f.host.storage.getRecovery(f.project.id,page[0].id),winner);assert.equal(await fs.readFile(path.join(f.root,'原文件.txt'),'utf8'),'原文 中文😀\n');
});
for(const action of ['createFile','createFolder'])test(action+' post-publication barrier failure is reconciled using exact empty object identity',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run({action,name:'新建'},f.published('新建')));const before=await fs.stat(path.join(f.root,'新建'),{bigint:true});const {plan}=await f.settle();assert.equal(plan.decision,'keep-published-creation');assert.equal((await fs.stat(path.join(f.root,'新建'),{bigint:true})).ino,before.ino);assert.deepEqual(await f.rows(),[]);
});
test('aborted same-project directory copy keeps stage and foreign destination without metadata effects',native,async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.root,'目录/空目录'),{recursive:true});await fs.writeFile(path.join(f.root,'目录/正文.txt'),'stage body');await assert.rejects(f.run({action:'copy',source:'目录',target:'目标'},{beforePublish:()=>{throw Object.assign(Error('aborted'),{commitUnknown:true});}}));await fs.writeFile(path.join(f.root,'目标/目录'),'FOREIGN');const stage=(await fs.readdir(path.join(f.root,'目标'))).find(n=>n.endsWith('.pending'));assert(stage);const before=await fs.readFile(path.join(f.root,'目标',stage,'正文.txt'));
 const {plan}=await f.settle();assert.equal(plan.decision,'retain-aborted-copy');assert.deepEqual(await fs.readFile(path.join(f.root,'目标',stage,'正文.txt')),before);assert.equal(await fs.readFile(path.join(f.root,'目标/目录'),'utf8'),'FOREIGN');assert.deepEqual(await f.rows(),[]);
});
test('aborted creation explicitly ends only its own record without allocating or publishing again',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run({action:'createFile',name:'新建'},{beforePublish:()=>{throw Object.assign(Error('aborted creation'),{commitUnknown:true});}}));const before=await fs.readdir(f.root);const {plan}=await f.settle();assert.equal(plan.decision,'retain-aborted-creation');assert.deepEqual(await fs.readdir(f.root),before);await assert.rejects(fs.stat(path.join(f.root,'新建')),{code:'ENOENT'});
});
