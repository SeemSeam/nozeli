import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {DesktopHost} from '../src/main/host.mjs';
import {FileTreeOps} from '../src/main/file-tree-ops.mjs';
import {FileTags} from '../src/domain/file-tags.mjs';
import {FileChanges} from '../src/domain/file-changes.mjs';
import {createFileTreeIO} from '../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../src/platform/windows/desktop-file-tree.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {security} from './fixtures/windows-security.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'},bridge=createRequire(import.meta.url)('../native/windows/build/Release/nozeli_windows_read.node');
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-public-directory-')),profile=path.join(base,'profile'),root=path.join(base,'项目 空格'),hosts=[];
 await ensureExperimentalPrivateDirectory(base,profile);await fs.mkdir(root);await fs.mkdir(path.join(root,'目标 目录'));await fs.mkdir(path.join(root,'原始 目录/嵌套 空目录'),{recursive:true});
 await fs.writeFile(path.join(root,'原始 目录/中文😀.txt'),'原始正文\n');await fs.writeFile(path.join(root,'原始 目录/嵌套 空目录/empty.txt'),'');
 const make=()=>{const host=new DesktopHost(profile);hosts.push(host);return host;},host=make(),picked=await host.pick(root),project=await host.requireProject(picked.project.id);
 t.after(async()=>{for(const host of hosts)await host.storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 const ops=options=>new FileTreeOps(host,{trash:()=>assert.fail('directory transfer never uses path trash'),io:{...createFileTreeIO(host),...(options?createWindowsDesktopFileTreeIO(host,options):{})}});
 return {base,root,profile,host,project,make,ops,run:(input,options)=>ops(options).run({projectId:project.id,source:'原始 目录',...input})};
}
async function rows(f,host=f.host){const result=[];for await(const row of host.storage.recoveryRecords(f.project.id,{prefixes:['tree-operation:']}))result.push(row);return result;}
async function absent(file){await assert.rejects(fs.lstat(file),{code:'ENOENT'});}
function child(code,args,{script=false}={}){const result=spawnSync(process.execPath,script?[code,...args]:['--input-type=module','-e',code,...args],{env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},encoding:'utf8',windowsHide:true,timeout:20000});assert.ifError(result.error);assert.equal(result.signal,null);return result;}

test('nested Unicode directory rename and cut preserve all native identities and inherited ACLs after cold reopen',native,async t=>{
 const f=await fixture(t),names=['','/中文😀.txt','/嵌套 空目录','/嵌套 空目录/empty.txt'],original=[];
 for(const name of names)original.push({id:(await fs.stat(path.join(f.root,'原始 目录'+name),{bigint:true})).ino,acl:security('inspect',path.join(f.root,'原始 目录'+name))});
 const renamed=await f.run({action:'rename',name:'更名目录'});assert.equal(renamed.transfer.kind,'directory');assert.equal(renamed.transfer.manifest.entryCount,3);assert(renamed.transfer.rechecked);
 const moved=await f.run({action:'cut',source:'更名目录',target:'目标 目录'});assert.equal(moved.relPath,'目标 目录/更名目录');await absent(path.join(f.root,'原始 目录'));await absent(path.join(f.root,'更名目录'));
 for(let i=0;i<names.length;i++){const file=path.join(f.root,moved.relPath+names[i]);assert.equal((await fs.stat(file,{bigint:true})).ino,original[i].id);assert.deepEqual(security('inspect',file),original[i].acl);}
 await f.host.storage.db.close();const cold=f.make();assert.equal((await cold.readFile(f.project.id,moved.relPath+'/中文😀.txt')).text,'原始正文\n');assert((await rows(f,cold)).every(row=>row.value.phase==='complete'));
});

test('recursive copy includes empty directories and multichunk files with fresh IDs and inherited ACLs',native,async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(1024*1024+17,193);await fs.mkdir(path.join(f.root,'原始 目录/真正空目录'));await fs.writeFile(path.join(f.root,'原始 目录/large.bin'),bytes);
 const result=await f.run({action:'copy'});assert.equal(result.relPath,'原始 目录 副本');assert.notEqual(result.transfer.identity,result.transfer.sourceIdentity);assert.equal(result.transfer.manifest.entryCount,5);assert.equal(result.transfer.retainedStage,false);
 assert.deepEqual(await fs.readFile(path.join(f.root,result.relPath,'large.bin')),bytes);assert.equal((await fs.readdir(path.join(f.root,result.relPath,'真正空目录'))).length,0);
 for(const row of result.transfer.manifest.entries){const copied=result.transfer.stageManifest.entries.find(item=>item.relative===row.relative);assert(copied);assert.notEqual(row.identity,copied.identity);if(row.type==='file'){assert.equal(row.sha256,copied.sha256);assert.equal(row.byteLength,copied.byteLength);}assert.equal(security('inspect',path.join(f.root,result.relPath,row.relative)).protected,false);}
 assert(!(await fs.readdir(f.root)).some(name=>name.endsWith('.pending')));
});

test('directory tags, change history and provenance follow moves; copied descendants get independent identities',native,async t=>{
 const f=await fixture(t),id=f.project.id,source='原始 目录/中文😀.txt',store=new FileTags({storage:f.host.storage,projectId:id,root:f.root}),ledger=new FileChanges({storage:f.host.storage,projectId:id,root:f.root}),read=await f.host.readFile(id,source);
 await f.host.addAnnotation(id,{relPath:source,materialDigest:read.materialDigest,kind:'text-selection',anchor:{start:0,end:4,quote:'原始正文'},note:'目录批注'});await ledger.observe(source,read.text,read.digest);await f.host.storage.putProject(id,'provenance',source,{relPath:source,origin:'fixture'});
 const original=await store.read(source),history=await ledger.read(source);await f.run({action:'rename',name:'移动'});
 assert.equal(await store.read(source),null);assert.equal((await store.read('移动/中文😀.txt')).file.fileId,original.file.fileId);assert.equal((await ledger.read('移动/中文😀.txt')).docId,history.docId);assert.equal((await f.host.storage.getProject(id,'provenance','移动/中文😀.txt')).origin,'fixture');
 await f.run({action:'copy',source:'移动'});const copied=await store.read('移动 副本/中文😀.txt');assert.notEqual(copied.file.fileId,original.file.fileId);assert.notEqual(copied.tags[0].id,original.tags[0].id);assert.equal(copied.tags[0].note,'目录批注');assert.notEqual((await ledger.read('移动 副本/中文😀.txt')).docId,history.docId);
});

test('nested unsaved drafts block copy and migrate by revision CAS on directory moves and cold reopen',native,async t=>{
 const f=await fixture(t),id=f.project.id,source='原始 目录/中文😀.txt',read=await f.host.readFile(id,source);await f.host.draft(id,source,read.digest,'未保存目录草稿');
 await assert.rejects(f.run({action:'copy'}),/未保存/);await absent(path.join(f.root,'原始 目录 副本'));
 await f.run({action:'rename',name:'草稿目录'});await f.host.storage.db.close();const cold=f.make();assert.equal(await cold.storage.getRecovery(id,'draft:'+hash(source)),null);assert.equal((await cold.storage.getRecovery(id,'draft:'+hash('草稿目录/中文😀.txt'))).text,'未保存目录草稿');assert.equal(await fs.readFile(path.join(f.root,'草稿目录/中文😀.txt'),'utf8'),'原始正文\n');
});

test('native capture refuses nested metadata, hardlinks, file and directory ADS and junctions without allocating a target',native,async t=>{
 for(const kind of ['metadata','case-metadata','hardlink','file-stream','directory-stream','junction']){
  const f=await fixture(t),src=path.join(f.root,'原始 目录');
  if(kind==='metadata'||kind==='case-metadata')await fs.mkdir(path.join(src,kind==='metadata'?'.nozeli':'.GIT'));
  if(kind==='hardlink')await fs.link(path.join(src,'中文😀.txt'),path.join(src,'alias'));
  if(kind==='file-stream')await fs.writeFile(path.join(src,'中文😀.txt:alternate'),'retained');
  if(kind==='directory-stream')await fs.writeFile(src+':alternate','retained');
  if(kind==='junction')await fs.symlink(path.join(f.root,'目标 目录'),path.join(src,'link'),'junction');
  await assert.rejects(f.run({action:'copy'}));await absent(path.join(f.root,'原始 目录 副本'));assert(!(await fs.readdir(f.root)).some(name=>name.endsWith('.pending')));assert.equal(await fs.readFile(path.join(src,'中文😀.txt'),'utf8'),'原始正文\n');
 }
});

test('late directory and case-alias file winners survive final no-replace publication; hidden copy stage is retained',native,async t=>{
 for(const action of ['rename','copy']){
  const f=await fixture(t),destination=action==='rename'?'winner':'目标 目录/原始 目录';
  await assert.rejects(f.run({action,name:'winner',target:'目标 目录'},{beforePublish:async()=>{await fs.writeFile(path.join(f.root,destination.toUpperCase()),'external winner',{flag:'wx'});}}));
  assert.equal(await fs.readFile(path.join(f.root,destination),'utf8'),'external winner');assert.equal(await fs.readFile(path.join(f.root,'原始 目录/中文😀.txt'),'utf8'),'原始正文\n');
  const row=(await rows(f)).at(-1);assert.equal(row.value.phase,action==='copy'?'needs-attention':'refused');if(action==='copy'){assert(row.value.effect.retainedStage);assert.equal(await fs.readFile(path.join(f.root,'目标 目录',row.value.effect.stagingName,'中文😀.txt'),'utf8'),'原始正文\n');}
 }
});

test('retained source root cannot be renamed independently while descendants are released',native,async t=>{
 const f=await fixture(t);await f.run({action:'rename',name:'result'},{beforePublish:async()=>{const result=child("import fs from 'node:fs';try{fs.renameSync(process.argv[1],process.argv[1]+'-external');}catch(e){process.exitCode=7;}",[path.join(f.root,'原始 目录')]);assert.equal(result.status,7,result.stderr);}});await absent(path.join(f.root,'原始 目录-external'));assert.equal(await fs.readFile(path.join(f.root,'result/中文😀.txt'),'utf8'),'原始正文\n');
});

test('member additions and byte changes in the descendant-release window are detected after move and preserved',native,async t=>{
 for(const change of ['new-member','bytes']){
  const f=await fixture(t);let error;
  await assert.rejects(f.run({action:'rename',name:'changed'},{beforePublish:async()=>{await fs.writeFile(path.join(f.root,'原始 目录',change==='new-member'?'external.txt':'中文😀.txt'),'external bytes');}}),failure=>{error=failure;return failure.committed===true&&failure.code==='FS_TREE_CHANGED';});
  await absent(path.join(f.root,'原始 目录'));assert.equal(await fs.readFile(path.join(f.root,'changed',change==='new-member'?'external.txt':'中文😀.txt'),'utf8'),'external bytes');assert.equal((await f.host.storage.getRecovery(f.project.id,error.details.recoveryKey)).phase,'needs-attention');
 }
});

test('late source metadata and hardlinks after descendant release remain visible in a held published directory',native,async t=>{
 for(const change of ['metadata','hardlink']){const f=await fixture(t);await assert.rejects(f.run({action:'rename',name:'held'},{beforePublish:async()=>{if(change==='metadata')await fs.mkdir(path.join(f.root,'原始 目录/.git'));else await fs.link(path.join(f.root,'原始 目录/中文😀.txt'),path.join(f.root,'原始 目录/alias'));}}),error=>error.committed===true);assert((await fs.stat(path.join(f.root,'held'))).isDirectory());assert.equal((await rows(f)).at(-1).value.phase,'needs-attention');}
});

test('real postpublication barrier failure retains the directory and blocks cold further mutations',native,async t=>{
 const f=await fixture(t);let failure;await assert.rejects(f.run({action:'rename',name:'uncertain'},{directorySync:parent=>{parent.close();parent.syncDirectory();}}),error=>{failure=error;return error.committed===true;});assert.equal(await fs.readFile(path.join(f.root,'uncertain/中文😀.txt'),'utf8'),'原始正文\n');await f.host.storage.db.close();const cold=f.make();assert.equal((await cold.storage.getRecovery(f.project.id,failure.details.recoveryKey)).phase,'needs-attention');await assert.rejects(new FileTreeOps(cold,{trash:()=>{}}).run({projectId:f.project.id,action:'createFolder',name:'no-replay'}),{code:'TREE_RECOVERY_REQUIRED'});
});

test('partial copied stage keeps allocation IDs and source manifest when journaling fails; cold never deletes or replays',native,async t=>{
 const f=await fixture(t),put=f.host.storage.putRecovery.bind(f.host.storage);let injected=false;
 f.host.storage.putRecovery=async(id,key,value,options)=>{if(!injected&&value?.effect?.allocated?.some(row=>row.type==='file')){injected=true;throw Object.assign(Error('Synthetic acknowledgement lost'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:true});}return put(id,key,value,options);};
 await assert.rejects(f.run({action:'copy'}),{code:'STORAGE_RESULT_UNKNOWN'});const row=(await rows(f)).at(-1);assert.equal(row.value.phase,'needs-attention');assert(row.value.effect.manifest.sha256);assert(row.value.effect.identity);assert(row.value.effect.retainedStage);await absent(path.join(f.root,'原始 目录 副本'));await f.host.storage.db.close();const cold=f.make();await assert.rejects(new FileTreeOps(cold,{trash:()=>{}}).run({projectId:f.project.id,action:'createFolder',name:'no-replay'}),{code:'TREE_RECOVERY_REQUIRED'});assert((await fs.stat(path.join(f.root,row.value.effect.stagingName))).isDirectory());
});

test('late unexpected stage members are retained after no-replace publication and postpublication mismatch',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.run({action:'copy'},{beforePublish:async facts=>{await fs.writeFile(path.join(f.root,facts.stagingName,'external-winner.txt'),'keep me');}}),error=>error.committed===true&&error.code==='FS_TREE_CHANGED');assert.equal(await fs.readFile(path.join(f.root,'原始 目录 副本/external-winner.txt'),'utf8'),'keep me');assert.equal((await rows(f)).at(-1).value.phase,'needs-attention');
});

test('directory copy entry limit refuses before allocation without truncating the source plan',native,async t=>{
 const f=await fixture(t);for(let i=0;i<1025;i++)await fs.writeFile(path.join(f.root,'原始 目录','file-'+i),'');await assert.rejects(f.run({action:'copy'}),{code:'FS_TREE_LIMIT'});await absent(path.join(f.root,'原始 目录 副本'));assert(!(await fs.readdir(f.root)).some(name=>name.endsWith('.pending')));
});

test('read-only source views cannot borrow parent mutation methods and retain the original root independently',native,async t=>{
 const f=await fixture(t),parent=bridge.openAnchoredPublicMutationParent(f.root,'原始 目录'),root=parent.openPublicTreeRoot('原始 目录'),view=root.sourceDirectory();
 try{assert.equal(view.beginPublicSelfMove,undefined);assert.throws(()=>parent.createPublicExclusive.call(view,'forged'),{code:'FS_HANDLE_REJECTED'});assert.throws(()=>parent.beginPrivateSelfMove.call(root,parent,'private-bypass',root.identity()),{code:'FS_HANDLE_REJECTED'});parent.close();root.close();view.verify();assert.equal(view.entries(10).length,2);}finally{view.close();root.close();parent.close();}
});

test('concurrent metadata collection winner survives published directory move and retains both recovery plans',native,async t=>{
 const f=await fixture(t),replace=f.host.storage.replaceProjectCollections.bind(f.host.storage);f.host.storage.replaceProjectCollections=async(id,collections,options)=>{await f.host.storage.putProject(id,'provenance','external',{winner:true});return replace(id,collections,options);};
 await assert.rejects(f.run({action:'rename',name:'metadata-held'}),error=>error.committed===true);assert.deepEqual(await f.host.storage.getProject(f.project.id,'provenance','external'),{winner:true});const row=(await rows(f)).at(-1);assert.equal(row.value.phase,'needs-attention');assert(row.value.metadata.before&&row.value.metadata.after);assert.equal(await fs.readFile(path.join(f.root,'metadata-held/中文😀.txt'),'utf8'),'原始正文\n');
});

test('real child exit before and after directory publication keeps prepared facts and cold admission never replays',native,async t=>{
 const modules=Object.fromEntries(['host','file-tree-ops','file-tree-io'].map(name=>[name,new URL('../src/main/'+name+'.mjs',import.meta.url).href]));const nativeModule=new URL('../src/platform/windows/desktop-file-tree.mjs',import.meta.url).href;
 for(const action of ['rename','copy'])for(const when of ['before','after']){
  const f=await fixture(t);await f.host.storage.db.close();const script=path.join(f.base,'crash.mjs');await fs.writeFile(script,`import {DesktopHost} from ${JSON.stringify(modules.host)};import {FileTreeOps} from ${JSON.stringify(modules['file-tree-ops'])};import {createFileTreeIO} from ${JSON.stringify(modules['file-tree-io'])};import {createWindowsDesktopFileTreeIO} from ${JSON.stringify(nativeModule)};const [profile,id,when]=process.argv.slice(2),host=new DesktopHost(profile),native=createWindowsDesktopFileTreeIO(host,{beforePublish:async()=>{if(when==='before')process.exit(23);}}),io={...createFileTreeIO(host),...native,transferEntry:(p,s,d,o)=>native.transferEntry(p,s,d,{...o,onPublished:async facts=>{if(when==='after')process.exit(23);return o.onPublished(facts);}})};await new FileTreeOps(host,{trash:()=>{},io}).run({projectId:id,action:'rename',source:'原始 目录',name:'crashed'});`);
  if(action==='copy')await fs.writeFile(script,(await fs.readFile(script,'utf8')).replace("action:'rename'","action:'copy'"));
  const result=child(script,[f.profile,f.project.id,when],{script:true});assert.equal(result.status,23,result.stderr);const cold=f.make(),row=(await rows(f,cold)).at(-1);assert.equal(row.value.phase,'prepared');assert(row.value.effect.manifest.sha256);const expected=when==='after'?(action==='copy'?'原始 目录 副本':'crashed'):'原始 目录';assert.equal(await fs.readFile(path.join(f.root,expected,'中文😀.txt'),'utf8'),'原始正文\n');if(action==='copy'){assert.equal(await fs.readFile(path.join(f.root,'原始 目录/中文😀.txt'),'utf8'),'原始正文\n');if(when==='before')assert.equal(await fs.readFile(path.join(f.root,row.value.effect.stagingName,'中文😀.txt'),'utf8'),'原始正文\n');}await assert.rejects(new FileTreeOps(cold,{trash:()=>{}}).run({projectId:f.project.id,action:'createFolder',name:'replay'}),{code:'TREE_RECOVERY_REQUIRED'});
 }
});
