import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {FileTreeOps} from '../src/main/file-tree-ops.mjs';
import {TreeRecovery} from '../src/main/tree-recovery.mjs';
import {createFileTreeIO} from '../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../src/platform/windows/desktop-file-tree.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {savePptDraft,readPptDraft} from '../src/main/ppt-drafts.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'},hash=value=>createHash('sha256').update(value).digest('hex');
const index=rel=>'ppt-versions:'+hash(rel),key=(rel,digest)=>'ppt:'+hash(rel+'\0'+digest);
async function fixture(t,rel='slides.pptx'){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-office-rename-')),profile=path.join(base,'profile'),root=path.join(base,'项目'),hosts=[];await ensureExperimentalPrivateDirectory(base,profile);await fs.mkdir(root);await fs.mkdir(path.dirname(path.join(root,rel)),{recursive:true});await fs.copyFile(path.join(import.meta.dirname,'fixtures/ppt/compatibility.pptx'),path.join(root,rel));
 const make=()=>{const host=new DesktopHost(profile);hosts.push(host);return host;},host=make(),project=await host.requireProject((await host.pick(root)).project.id),file=await host.readFile(project.id,rel),model={title:'UNSENT PPT 中文',slides:[{id:'slide-original',elements:[{id:'text-original',type:'text',content:'Retained slide 中文'}]}]};
 t.after(async()=>{for(const h of hosts)await h.storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 await savePptDraft({host,projectId:project.id,relPath:rel,digest:file.digest,absolute:path.join(root,rel),model});
 const run=(input={},options={})=>new FileTreeOps(host,{trash:()=>assert.fail('no trash'),io:{...createFileTreeIO(host),...createWindowsDesktopFileTreeIO(host,options)}}).run({projectId:project.id,source:rel,action:'rename',name:'new.pptx',...input});
 const read=(h,relative)=>readPptDraft({host:h,projectId:project.id,relPath:relative,digest:file.digest,absolute:path.join(root,relative)});
 const selected=async()=>{const page=await host.storage.recoveryPage(project.id,{prefixes:['tree-operation:'],pendingOnly:true,purpose:'recovery-ui'});assert.equal(page.entries.length,1);return {projectId:project.id,id:page.entries[0].id,revision:page.entries[0].revision,version:page.version};};
 const settle=async()=>{const service=new TreeRecovery(host),plan=await service.preview(await selected(),'synthetic-office');return service.settle({token:plan.token,confirmed:true},'synthetic-office');};
 const published={onPublished:()=>{}};
 return {base,root,host,project,file,model,run,read,make,settle,selected,published,rel};
}
test('closed PPT normal rename migrates original model and version index; cold host reopens it',native,async t=>{
 const f=await fixture(t),original=await fs.readFile(path.join(f.root,f.rel));await f.run();assert.deepEqual((await f.read(f.host,'new.pptx')).model,f.model);assert.equal(await f.host.storage.getRecovery(f.project.id,index(f.rel)),null);await fs.writeFile(path.join(f.root,f.rel),'FOREIGN');await f.host.storage.db.close();assert.deepEqual((await f.read(f.make(),'new.pptx')).model,f.model);assert.deepEqual(await fs.readFile(path.join(f.root,'new.pptx')),original);assert.equal(await fs.readFile(path.join(f.root,f.rel),'utf8'),'FOREIGN');
});
test('directory rename migrates every indexed source version without rewriting model or source digest',native,async t=>{
 const f=await fixture(t,'folder/slides.pptx'),old='a'.repeat(64),prior={...f.model,title:'OLDER SOURCE VERSION'};await savePptDraft({host:f.host,projectId:f.project.id,relPath:f.rel,digest:old,absolute:path.join(f.root,f.rel),model:prior});await f.run({source:'folder',name:'new-folder'});const rel='new-folder/slides.pptx',versions=await f.host.storage.getRecovery(f.project.id,index(rel));assert.equal(versions.versions.length,2);assert.equal((await f.host.storage.getRecovery(f.project.id,key(rel,old))).sourceDigest,old);assert.deepEqual((await f.host.storage.getRecovery(f.project.id,key(rel,old))).model,prior);assert.deepEqual((await f.read(f.host,rel)).model,f.model);
});
test('same-project copy leaves source PPT drafts and allocates no target model identity',native,async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.root,'target'));await f.run({action:'copy',target:'target'});assert.deepEqual((await f.read(f.host,f.rel)).model,f.model);assert.equal((await f.read(f.host,'target/slides.pptx')).model,null);
});
test('an independent destination PPT index refuses rename before native effects',native,async t=>{
 const f=await fixture(t);await f.host.storage.putRecovery(f.project.id,index('new.pptx'),{schema:1,relPath:'new.pptx',versions:[{digest:f.file.digest}]});await assert.rejects(f.run(),{code:'TREE_RECOVERY_CHANGED'});assert(await fs.stat(path.join(f.root,f.rel)));await assert.rejects(fs.stat(path.join(f.root,'new.pptx')),{code:'ENOENT'});assert.deepEqual((await f.read(f.host,f.rel)).model,f.model);
});
test('published rename fault explicitly completes PPT index and model migration without repeating native rename',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run({}, {directorySync:parent=>{if(requireExists(path.join(f.root,'new.pptx')))parent.close();parent.syncDirectory();}}));const before=await fs.stat(path.join(f.root,'new.pptx'),{bigint:true});assert((await f.host.storage.getRecovery(f.project.id,index(f.rel))));await f.settle();assert.deepEqual((await f.read(f.host,'new.pptx')).model,f.model);assert.equal((await fs.stat(path.join(f.root,'new.pptx'),{bigint:true})).ino,before.ino);
});
test('a concurrent retained model after publication refuses atomic metadata settlement and preserves both sources',native,async t=>{
 const f=await fixture(t),row=await f.host.storage.readRecoveryRecord(f.project.id,key(f.rel,f.file.digest));await assert.rejects(f.run({}, {beforePublish:async()=>{await f.host.storage.putRecovery(f.project.id,row.id,{...row.value,model:{...f.model,title:'LATE WINNER'}},{expectedRevision:row.revision});}}));assert.equal((await f.host.storage.getRecovery(f.project.id,key(f.rel,f.file.digest))).model.title,'LATE WINNER');assert.equal(await f.host.storage.getRecovery(f.project.id,index('new.pptx')),null);await assert.rejects(f.settle(),{code:'TREE_RECOVERY_CHANGED'});assert(await fs.stat(path.join(f.root,'new.pptx')));
});
import {existsSync as requireExists} from 'node:fs';
