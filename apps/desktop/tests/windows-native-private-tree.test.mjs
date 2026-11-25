import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ensureExperimentalPrivateDirectory as ensure} from '../src/platform/windows/experimental-directories.mjs';
import {openExperimentalPersistenceParent as open} from '../src/platform/windows/experimental-persistence.mjs';
import {openExperimentalPrivateTree as tree} from '../src/platform/windows/experimental-private-tree.mjs';
import {StorageDatabase} from '../src/main/storage-database.mjs';
import {removalReceiptRequests} from '../src/main/windows-removal-inspection.mjs';
import {security} from './fixtures/windows-security.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'},sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function removalTree(f,relative,options={}){return f.tree(relative,{...options,deletion:true});}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-private-tree-')),resources=[];
 t.after(async()=>{for(const resource of resources.reverse())await resource.close();await fs.rm(root,{recursive:true,force:true});});
 return {root,file:relative=>path.join(root,relative),hold(value){resources.push(value);return value;},directory:relative=>ensure(root,path.join(root,relative)),async tree(relative,options){return this.hold(await tree(root,path.join(root,relative),options));}};
}
function child(code,args=[]){const result=spawnSync(process.execPath,['--input-type=module','-e',code,...args],{encoding:'utf8',windowsHide:true,timeout:15000});assert.ifError(result.error);assert.equal(result.signal,null);return result;}
async function absent(file){await assert.rejects(fs.lstat(file),{code:'ENOENT'});}

test('native relative tree files retain ancestor pins, enforce read bounds and flush the same private single-link HANDLE',native,async t=>{
 const f=await fixture(t);await f.directory('tree/child');await fs.writeFile(f.file('tree/child/正文.txt'),'0123456789');
 const parent=f.hold(open(f.root,'anchor')),root=f.hold(parent.openPrivateTreeRoot('tree')),directory=f.hold(root.openPrivateDirectory('child',false)),file=f.hold(directory.openPrivateTreeFile('正文.txt'));
 assert.throws(()=>parent.beginPrivateSelfMove(parent,'target',root.identity()),{code:'FS_HANDLE_REJECTED'});assert.throws(()=>root.beginPrivateSelfMove(parent,'TREE',root.identity()),{code:'FS_NAME_REJECTED'});
 assert.equal(directory.entries(10)[0].identity,file.stat().identity);assert.equal(file.stat().size,10n);assert.ok(Buffer.isBuffer(file.stat().security));
 parent.close();root.close();directory.close();file.verify();file.sync();assert.equal(file.readAt(5,3).toString(),'567');assert.equal(file.readAt(0,2).toString(),'01');assert.equal(file.readAt(10,1).length,0);
 for(const args of [[-1,1],[0,0],[1.1,2],[0,1048577],['0',1]])assert.throws(()=>file.readAt(...args),{code:'FS_READ_LIMIT'});
 assert.throws(()=>file.readAt.call({},0,1),{code:'FS_HANDLE_REJECTED'});file.close();file.close();assert.throws(()=>file.verify(),{code:'FS_HANDLE_CLOSED'});
 await fs.rename(f.file('tree'),f.file('released'));assert.equal(await fs.readFile(f.file('released/child/正文.txt'),'utf8'),'0123456789');
});

test('native directory enumeration spans multiple pages, is repeatable and checks its entry budget',native,async t=>{
 const f=await fixture(t);await f.directory('tree');const names=Array.from({length:420},(_,index)=>String(index).padStart(4,'0')+'-'+('文'.repeat(100))+'.txt');
 await Promise.all(names.map(name=>fs.writeFile(f.file('tree/'+name),'')));
 const parent=f.hold(open(f.root,'anchor')),root=f.hold(parent.openPrivateTreeRoot('tree')),first=root.entries(500);assert.deepEqual(first.map(row=>row.name),names);assert.deepEqual(root.entries(500),first);
 assert.throws(()=>root.entries(419),{code:'FS_TREE_LIMIT'});for(const limit of [0,10001,1.2,'10'])assert.throws(()=>root.entries(limit),{code:'FS_TREE_LIMIT'});
 root.close();parent.close();const captured=await f.tree('tree',{maxEntries:420,maxBytes:0});assert.equal(captured.manifest.entryCount,420);assert.equal(captured.manifest.entries.length,421);await captured.verify();
});

test('immutable tree manifests bind Unicode names, nested empty directories, byte counts, IDs, ACL digests and real 33 MiB content',native,async t=>{
 const f=await fixture(t);await f.directory('候选 空格/empty');await f.directory('候选 空格/nested');const bytes=Buffer.alloc(33*1024*1024,0x71);bytes.write('synthetic 中文');
 await fs.writeFile(f.file('候选 空格/nested/large.bin'),bytes);await fs.writeFile(f.file('候选 空格/empty.txt'),'');await fs.writeFile(f.file('候选 空格/draft.txt'),'未发送');
 const captured=await f.tree('候选 空格'),manifest=captured.manifest;assert.ok(Object.isFrozen(manifest));assert.ok(Object.isFrozen(manifest.entries));assert.ok(manifest.entries.every(Object.isFrozen));
 assert.equal(manifest.entryCount,5);assert.equal(manifest.totalBytes,bytes.length+Buffer.byteLength('未发送'));assert.match(manifest.sha256,/^[a-f0-9]{64}$/);assert.ok(manifest.entries.every(row=>/^[a-f0-9]{64}$/.test(row.securitySha256)));
 const large=manifest.entries.find(row=>row.relative==='nested/large.bin');assert.equal(large.sha256,sha(bytes));assert.equal(large.byteLength,bytes.length);assert.equal((await captured.readFile('draft.txt')).toString(),'未发送');assert.deepEqual(await captured.readFile('empty.txt'),Buffer.alloc(0));
 await assert.rejects(captured.readFile('nested/large.bin'),{code:'FS_READ_LIMIT'});let streamed=createHash('sha256'),count=0;for await(const chunk of captured.streamFile('nested/large.bin')){assert.ok(chunk.length<=256*1024);streamed.update(chunk);count+=chunk.length;}assert.equal(count,bytes.length);assert.equal(streamed.digest('hex'),large.sha256);
 const synced=await captured.sync();assert.equal(synced.files,3);assert.equal(synced.directories,3);assert.equal(synced.state,'barriers-completed');assert.equal(synced.durability,'namespace-not-qualified');assert.equal((await captured.verify()).manifestSha256,manifest.sha256);
});

test('unsafe junctions and hard links are refused while all external bytes and names remain intact',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.mkdir(f.file('outside'));await fs.writeFile(f.file('outside/keep'),'external');await fs.symlink(f.file('outside'),f.file('tree/junction'),'junction');
 await assert.rejects(tree(f.root,f.file('tree')),{code:'FS_REPARSE_REJECTED'});assert.equal(await fs.readFile(f.file('outside/keep'),'utf8'),'external');assert.equal((await fs.lstat(f.file('tree/junction'))).isSymbolicLink(),true);await fs.unlink(f.file('tree/junction'));
 await fs.writeFile(f.file('tree/file'),'source');await fs.link(f.file('tree/file'),f.file('alias'));
 await assert.rejects(tree(f.root,f.file('tree')),{code:'FS_ENTRY_REJECTED'});assert.equal(await fs.readFile(f.file('alias'),'utf8'),'source');assert.equal((await fs.stat(f.file('tree/file'))).nlink,2);
});

test('broad private descendants and files are refused without permission repair or payload cleanup',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.mkdir(f.file('tree/child'));security('add-write',f.file('tree/child'));const before=security('inspect',f.file('tree/child'));
 await assert.rejects(tree(f.root,f.file('tree')),{code:'FS_SECURITY_CHANGED'});assert.deepEqual(security('inspect',f.file('tree/child')),before);await fs.rmdir(f.file('tree/child'));
 await fs.writeFile(f.file('tree/file'),'external');security('add-write',f.file('tree/file'));const fileBefore=security('inspect',f.file('tree/file'));
 await assert.rejects(tree(f.root,f.file('tree')),{code:'FS_SECURITY_CHANGED'});assert.deepEqual(security('inspect',f.file('tree/file')),fileBefore);assert.equal(await fs.readFile(f.file('tree/file'),'utf8'),'external');
});

test('ambiguous enumerated aliases and invalid whole root plans fail before any flush or created entry',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/ALIAS~1'),'external');let barriers=0;
 await assert.rejects(tree(f.root,f.file('tree'),{fileSync:()=>{barriers++;},directorySync:()=>{barriers++;}}),{code:'FS_PATH_REJECTED'});assert.equal(barriers,0);assert.equal(await fs.readFile(f.file('tree/ALIAS~1'),'utf8'),'external');
 for(const directory of [f.root,f.file('new/late.'),f.root+'\\new\\..\\tree',path.join(f.root,'..','escape')])await assert.rejects(tree(f.root,directory),{code:'FS_PATH_REJECTED'});assert.deepEqual(await fs.readdir(f.root),['tree']);
});

test('entry and byte limits, invalid options and wrong expected root identity release all acquired pins',native,async t=>{
 const f=await fixture(t);await f.directory('tree/child');await fs.writeFile(f.file('tree/child/file'),'123456');
 for(const options of [{maxEntries:1},{maxBytes:5},{maxEntries:0},{maxEntries:10001},{maxBytes:-1},{maxBytes:NaN}])await assert.rejects(tree(f.root,f.file('tree'),options),{code:'FS_TREE_LIMIT'});
 await assert.rejects(tree(f.root,f.file('tree'),{expectedIdentity:'0'.repeat(16)+':'+('0'.repeat(32))}),{code:'FS_DIRECTORY_CONFLICT'});
 await assert.rejects(tree(f.root,f.file('tree'),{expectedIdentity:'invalid'}),{code:'FS_IDENTITY_REJECTED'});await assert.rejects(tree(f.root,f.file('tree'),{fileSync:null}),TypeError);
 await fs.rename(f.file('tree'),f.file('released'));assert.equal(await fs.readFile(f.file('released/child/file'),'utf8'),'123456');
});

test('held tree pins deny actual independent data writes, delete and ancestor rename, then release after close',native,async t=>{
 const f=await fixture(t);await f.directory('tree/child');await fs.writeFile(f.file('tree/child/draft'),'original');const captured=await f.tree('tree');
 const blocked=child(`import fs from 'node:fs';let denied=0;for(const operation of [()=>fs.writeFileSync(process.argv[1],'changed'),()=>fs.unlinkSync(process.argv[1]),()=>fs.renameSync(process.argv[2],process.argv[2]+'-moved')]){try{operation();}catch{denied++;}}console.log(denied);`,[f.file('tree/child/draft'),f.file('tree')]);assert.equal(blocked.status,0,blocked.stderr);assert.equal(blocked.stdout.trim(),'3');assert.equal((await captured.readFile('child/draft')).toString(),'original');
 await captured.verify();captured.close();const released=child(`import fs from 'node:fs';fs.writeFileSync(process.argv[1],'external after close');`,[f.file('tree/child/draft')]);assert.equal(released.status,0,released.stderr);assert.equal(await fs.readFile(f.file('tree/child/draft'),'utf8'),'external after close');
});

test('an active actual SQLite worker prevents tree qualification until it really closes, preserving drafts and receipts',native,async t=>{
 const f=await fixture(t);await f.directory('tree');const db=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root})),file=f.file('tree/project.sqlite');
 await db.request(file,'put',{collection:'drafts',id:'draft',value:'未发送',operationId:'seed'});await assert.rejects(tree(f.root,f.file('tree')),{code:'WIN32_IO_ERROR'});assert.equal(await db.request(file,'get',{collection:'drafts',id:'draft'}),'未发送');
 await db.close();const captured=await f.tree('tree');assert.ok(captured.manifest.entries.some(row=>row.relative==='project.sqlite'));await captured.sync();captured.close();const cold=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root}));assert.deepEqual(await cold.request(file,'receipt',{operationId:'seed'}),{revision:1});
});

test('new directory members after capture invalidate the tree before any barrier and preserve added content',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/draft'),'original');let barriers=0;
 const captured=await f.tree('tree',{fileSync:()=>{barriers++;},directorySync:()=>{barriers++;}});await fs.writeFile(f.file('tree/late'),'external');
 await assert.rejects(captured.verify(),{code:'FS_TREE_CHANGED'});await assert.rejects(captured.sync(),{code:'FS_TREE_CHANGED'});assert.equal(barriers,0);assert.equal(await fs.readFile(f.file('tree/late'),'utf8'),'external');assert.equal((await captured.readFile('draft')).toString(),'original');
});

test('file or private ancestor ACL drift is detected against retained snapshots without repair',native,async t=>{
 const f=await fixture(t);await f.directory('file-tree');await fs.writeFile(f.file('file-tree/draft'),'original');const fileTree=await f.tree('file-tree');security('add-write',f.file('file-tree/draft'));const changed=security('inspect',f.file('file-tree/draft'));
 await assert.rejects(fileTree.verify(),{code:'FS_STAGE_CHANGED'});assert.deepEqual(security('inspect',f.file('file-tree/draft')),changed);fileTree.close();
 await f.directory('parent-tree/child');await fs.writeFile(f.file('parent-tree/child/draft'),'retained');const parentTree=await f.tree('parent-tree');security('add-write',f.file('parent-tree'));
 await assert.rejects(parentTree.verify(),{code:'FS_STAGE_CHANGED'});assert.equal(await fs.readFile(f.file('parent-tree/child/draft'),'utf8'),'retained');
});

test('real file and directory barrier handle failures retain every byte and support explicit close/reopen verification',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/a'),'first');await fs.writeFile(f.file('tree/b'),'second');let flushed=0;
 const captured=await f.tree('tree',{fileSync:(file,{relative})=>{if(relative==='b')file.close();file.sync();flushed++;}}),manifest=captured.manifest;
 await assert.rejects(captured.sync(),error=>error.code==='FS_HANDLE_CLOSED'&&!error.committed);assert.equal(flushed,1);captured.close();
 const directoryFailure=await f.tree('tree',{directorySync:(directory,{phase,relative})=>{if(phase==='tree'&&relative==='')directory.close();directory.syncDirectory();}});await assert.rejects(directoryFailure.sync(),{code:'FS_HANDLE_CLOSED'});directoryFailure.close();
 const retry=await f.tree('tree');assert.deepEqual(retry.manifest,manifest);await retry.sync();assert.equal((await retry.readFile('b')).toString(),'second');
});

test('bounded readers and early stream cancellation release reader admission without allowing concurrent publication',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/large'),Buffer.alloc(1024*1024,0x61));const captured=await f.tree('tree'),reader=captured.streamFile('large');assert.equal((await reader.next()).value.length,256*1024);
 await assert.rejects(captured.publishTo(f.file('target')),{code:'FS_TREE_BUSY'});await assert.rejects(captured.verify(),{code:'FS_TREE_BUSY'});await absent(f.file('target'));await reader.return();await captured.verify();
 await assert.rejects(captured.readFile('large',{maxBytes:3}),{code:'FS_READ_LIMIT'});await assert.rejects(captured.readFile('../outside'),{code:'FS_TREE_FILE_MISSING'});captured.close();await assert.rejects(captured.verify(),{code:'FS_HANDLE_CLOSED'});
});

test('verified tree publication keeps the root identity across release/reopen and cold SQLite receipts at a new parent',native,async t=>{
 const f=await fixture(t);await f.directory('stage/candidate/empty');await f.directory('published');await fs.writeFile(f.file('stage/candidate/project.json'),'{}');const db=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root}));
 await db.request(f.file('stage/candidate/project.sqlite'),'put',{collection:'drafts',id:'draft',value:'original candidate',operationId:'seed'});await db.close();const captured=await f.tree('stage/candidate'),manifest=captured.manifest;
 const result=await captured.publishTo(f.file('published/project'));assert.equal(result.moved,true);assert.equal(result.rechecked,true);assert.equal(result.manifestSha256,manifest.sha256);assert.equal(result.durability,'namespace-not-qualified');await absent(f.file('stage/candidate'));
 assert.equal((await captured.readFile('project.json')).toString(),'{}');assert.equal((await captured.verify()).manifestSha256,manifest.sha256);const resynced=await captured.sync();assert.equal(resynced.barriers.destinationParent,'flushed');assert.equal(resynced.publication.moved,true);
 await assert.rejects(captured.publishTo(f.file('another')),{code:'FS_MOVE_PUBLISHED'});captured.close();const reopened=await f.tree('published/project');assert.deepEqual(reopened.manifest,manifest);reopened.close();
 const cold=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root}));assert.equal(await cold.request(f.file('published/project/project.sqlite'),'get',{collection:'drafts',id:'draft'}),'original candidate');assert.deepEqual(await cold.request(f.file('published/project/project.sqlite'),'receipt',{operationId:'seed'}),{revision:1});
});

test('a fresh staged copy preserves a competing target and its publication receipt identifies only the exact cold tree',native,async t=>{
 const f=await fixture(t),loader=new URL('../src/platform/windows/experimental-private-tree.mjs',import.meta.url).href;
 await f.directory('source');await f.directory('published');await fs.writeFile(f.file('source/draft'),'未发送');
 const source=await f.tree('source'),copy=await source.copyTo(f.file('candidate'));
 const staged=await f.tree('candidate'),manifest=staged.manifest;
 assert.equal(manifest.rootIdentity,copy.created.find(row=>row.relative==='').identity);
 assert.notEqual(manifest.rootIdentity,source.manifest.rootIdentity);
 const winner=f.file('published/winner');
 await assert.rejects(staged.publishTo(winner,{beforeCommit:()=>{
  const contender=child(`import fs from 'node:fs';fs.mkdirSync(process.argv[1]);fs.writeFileSync(process.argv[1]+'/keep','external');`,[winner]);
  assert.equal(contender.status,0,contender.stderr);
 }}),error=>!error.committed&&error.privateTreePublication?.moved===false);
 assert.equal((await staged.verify()).manifestSha256,manifest.sha256);
 const destination=f.file('published/project'),receipt=await staged.publishTo(destination);
 assert.equal(receipt.state,'barriers-completed');assert.equal(receipt.destination,destination);assert.equal(receipt.moved,true);
 staged.close();source.close();await absent(f.file('candidate'));
 // Keep the SQLite receipt outside the published tree so recording it cannot change that manifest.
 await f.directory('journal');const journal=f.file('journal/publication.sqlite'),operationId='publish:project',collection='publications';
 const db=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root}));
 const committed=await db.request(journal,'put',{collection,id:'project',value:receipt,operationId});
 assert.equal((await db.close()).some(outcome=>outcome?.closed===false),false);
 assert.equal(await fs.readFile(path.join(winner,'keep'),'utf8'),'external');
 const reader=f.file('publication-reader.mjs'),database=new URL('../src/main/storage-database.mjs',import.meta.url).href;
 await fs.writeFile(reader,`import {StorageDatabase} from ${JSON.stringify(database)};
 import {openExperimentalPrivateTree as tree} from ${JSON.stringify(loader)};
 const [root,destination,journal,collection,operationId]=process.argv.slice(2),db=new StorageDatabase({experimentalWindowsRoot:root});
 let lease;
 try{
  const receipt=await db.request(journal,'get',{collection,id:'project',mustExist:true});
  const committed=await db.request(journal,'receipt',{operationId,mustExist:true});
  lease=await tree(root,destination,{rootAccess:'readwrite',fileAccess:'read'});
  console.log(JSON.stringify({receipt,committed,manifest:lease.manifest,draft:(await lease.readFile('draft')).toString()}));
 }finally{lease?.close();const outcomes=await db.close();if(outcomes.some(outcome=>outcome?.closed===false))throw Error('Cold journal close unconfirmed');}`);
 const observe=()=>{
  const out=spawnSync(process.execPath,[reader,f.root,destination,journal,collection,operationId],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.ifError(out.error);assert.equal(out.status,0,out.stderr);return JSON.parse(out.stdout);
 };
 const cold=observe();assert.deepEqual(cold,{receipt,committed,manifest,draft:'未发送'});
 assert.equal(cold.manifest.rootIdentity,cold.receipt.identity);assert.equal(cold.manifest.sha256,cold.receipt.manifestSha256);
 await fs.rename(path.join(destination,'draft'),f.file('retained-original'));
 await fs.writeFile(path.join(destination,'draft'),cold.draft,{flag:'wx'});
 const substitute=observe();assert.equal(substitute.draft,cold.draft);assert.equal(substitute.manifest.rootIdentity,receipt.identity);
 assert.deepEqual(substitute.receipt,cold.receipt);assert.deepEqual(substitute.committed,cold.committed);
 assert.notEqual(substitute.manifest.sha256,substitute.receipt.manifestSha256);
 assert.notEqual(substitute.manifest.entries.find(row=>row.relative==='draft').identity,cold.manifest.entries.find(row=>row.relative==='draft').identity);
});

test('release-window data edits and new members after publication are retained and reported committed/uncertain without replay',native,async t=>{
 const f=await fixture(t);
 for(const kind of ['edit','member','acl']){
  await f.directory(kind);await fs.writeFile(f.file(kind+'/draft'),'original');const captured=await f.tree(kind);
  await assert.rejects(captured.publishTo(f.file(kind+'-published'),{beforeCommit:async()=>{if(kind==='edit')await fs.writeFile(f.file(kind+'/draft'),'external edit');else if(kind==='member')await fs.writeFile(f.file(kind+'/late'),'external member');else security('protect-user-file',f.file(kind+'/draft'));}}),error=>error.code==='FS_TREE_CHANGED'&&error.committed===true&&error.durability==='uncertain'&&error.privateTreePublication.moved===true);
  await absent(f.file(kind));await assert.rejects(captured.publishTo(f.file(kind+'-replay')),{code:'FS_MOVE_PUBLISHED'});await assert.rejects(captured.verify(),{code:'FS_TREE_CHANGED'});await absent(f.file(kind+'-replay'));captured.close();
  assert.equal(await fs.readFile(f.file(kind+'-published/'+(kind==='member'?'late':'draft')),'utf8'),kind==='edit'?'external edit':kind==='member'?'external member':'original');
  if(kind==='acl')assert.equal(security('inspect',f.file(kind+'-published/draft')).protected,true);
 }
});

test('an independent late target winner refuses publication, preserves both trees and allows only explicit verified retry',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/draft'),'candidate');const captured=await f.tree('tree'),manifest=captured.manifest;
 await assert.rejects(captured.publishTo(f.file('winner'),{beforeCommit:()=>{const winner=child(`import fs from 'node:fs';fs.mkdirSync(process.argv[1]);fs.writeFileSync(process.argv[1]+'/keep','external');`,[f.file('winner')]);assert.equal(winner.status,0,winner.stderr);}}),error=>!error.committed&&error.privateTreePublication.moved===false);
 assert.equal(await fs.readFile(f.file('winner/keep'),'utf8'),'external');assert.equal(await fs.readFile(f.file('tree/draft'),'utf8'),'candidate');assert.equal((await captured.verify()).manifestSha256,manifest.sha256);
 const result=await captured.publishTo(f.file('explicit-retry'));assert.equal(result.moved,true);assert.equal(await fs.readFile(f.file('winner/keep'),'utf8'),'external');
});

test('cancellation before open or commit leaves source intact and postcommit cancellation completes all barriers',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/draft'),'candidate');const before=new AbortController();before.abort();await assert.rejects(tree(f.root,f.file('tree'),{signal:before.signal}),{code:'ABORT_ERR'});
 const during=new AbortController(),captured=await f.tree('tree');await assert.rejects(captured.publishTo(f.file('target'),{signal:during.signal,beforeCommit:()=>during.abort()}),error=>error.code==='ABORT_ERR'&&!error.committed);await absent(f.file('target'));await captured.verify();captured.close();
 const capturing=new AbortController(),pending=tree(f.root,f.file('tree'),{signal:capturing.signal});queueMicrotask(()=>capturing.abort());await assert.rejects(pending,{code:'ABORT_ERR'});await fs.rename(f.file('tree'),f.file('aborted-and-released'));await fs.rename(f.file('aborted-and-released'),f.file('tree'));
 const after=new AbortController();let published=0;const other=await f.tree('tree',{directorySync:(directory,{phase})=>{directory.syncDirectory();if(phase==='published'){published++;after.abort();}}});
 const result=await other.publishTo(f.file('target'),{signal:after.signal});assert.equal(result.moved,true);assert.equal(published,1);assert.equal(result.rechecked,true);await absent(f.file('tree'));
});

test('postpublication parent barrier faults retain moved identity facts and cannot be reported as successful reconciliation',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await f.directory('published');await fs.writeFile(f.file('tree/draft'),'candidate');const captured=await f.tree('tree',{directorySync:(directory,{phase})=>{if(phase==='destination-parent')directory.close();directory.syncDirectory();}}),manifest=captured.manifest;
 await assert.rejects(captured.publishTo(f.file('published/project')),error=>error.code==='FS_HANDLE_CLOSED'&&error.committed===true&&error.privateTreePublication.manifestSha256===manifest.sha256);await absent(f.file('tree'));
 await assert.rejects(captured.publishTo(f.file('replay')),{code:'FS_MOVE_PUBLISHED'});await assert.rejects(captured.sync(),{code:'FS_HANDLE_CLOSED'});captured.close();assert.equal(await fs.readFile(f.file('published/project/draft'),'utf8'),'candidate');
 const reopened=await f.tree('published/project');assert.deepEqual(reopened.manifest,manifest);await reopened.sync();
});

test('actual host exit before and after tree publication releases pins and cold reopens the observed namespace and manifest',native,async t=>{
 const f=await fixture(t),loader=new URL('../src/platform/windows/experimental-private-tree.mjs',import.meta.url).href;
 for(const after of [false,true]){
  const source='source-'+after,target='target-'+after;await f.directory(source+'/child');await fs.writeFile(f.file(source+'/child/draft'),'retained');const original=await f.tree(source),manifest=original.manifest;original.close();
  const exited=child(`import {openExperimentalPrivateTree as tree} from ${JSON.stringify(loader)};const after=process.argv[4]==='true';const lease=await tree(process.argv[1],process.argv[2],{directorySync:(directory,{phase})=>{directory.syncDirectory();if(after&&phase==='published')process.exit(0);}});await lease.publishTo(process.argv[3],{beforeCommit:()=>{if(!after)process.exit(0);}});throw Error('exit point not reached');`,[f.root,f.file(source),f.file(target),String(after)]);assert.equal(exited.status,0,exited.stderr);
  await absent(f.file(after?source:target));const cold=await f.tree(after?target:source);assert.deepEqual(cold.manifest,manifest);assert.equal((await cold.readFile('child/draft')).toString(),'retained');cold.close();
 }
});

test('readonly private files refuse writable sync qualification without changing attributes or contents',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/readonly'),'retained');await fs.chmod(f.file('tree/readonly'),0o444);const before=await fs.stat(f.file('tree/readonly'));
 await assert.rejects(tree(f.root,f.file('tree')),{code:'WIN32_IO_ERROR'});const after=await fs.stat(f.file('tree/readonly'));assert.equal(after.mode,before.mode);assert.equal(await fs.readFile(f.file('tree/readonly'),'utf8'),'retained');await fs.chmod(f.file('tree/readonly'),0o600);
});

test('exclusive native directory creation returns its original pinned identity and never adopts an existing contender',native,async t=>{
 const f=await fixture(t),parent=f.hold(open(f.root,'anchor')),root=f.hold(parent.createPrivateTreeRootExclusive('created'));
 assert.equal(root.created,true);assert.match(root.identity(),/^[a-f0-9]{16}:[a-f0-9]{32}$/);assert.equal(security('inspect',f.file('created')).protected,true);
 const nested=f.hold(root.createPrivateDirectoryExclusive('child'));assert.equal(nested.created,true);assert.equal(root.entries(10)[0].identity,nested.identity());
 assert.throws(()=>parent.createPrivateTreeRootExclusive('created'),{code:'WIN32_IO_ERROR'});assert.throws(()=>root.createPrivateDirectoryExclusive('child'),{code:'WIN32_IO_ERROR'});
 assert.throws(()=>nested.removePrivateEmptyDirectory(),{code:'FS_HANDLE_REJECTED'});assert.throws(()=>root.removePrivateEmptyDirectory(),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===145);
 const denied=child(`import fs from 'node:fs';try{fs.renameSync(process.argv[1],process.argv[1]+'-moved');process.exit(2);}catch{}`, [f.file('created')]);assert.equal(denied.status,0,denied.stderr);
});

test('streamed manifest copy preserves Unicode, empty directories, 33 MiB bytes and cold SQLite drafts and receipts',native,async t=>{
 const f=await fixture(t);await f.directory('source/空目录');await f.directory('target-parent');const bytes=Buffer.alloc(33*1024*1024,0x63);await fs.writeFile(f.file('source/正文.bin'),bytes);await fs.writeFile(f.file('source/empty'),'');
 const db=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root}));await db.request(f.file('source/project.sqlite'),'put',{collection:'drafts',id:'draft',value:'未发送',operationId:'seed'});await db.close();
 const captured=await f.tree('source'),original=captured.manifest,result=await captured.copyTo(f.file('target-parent/复制 空格'));assert.equal(result.rechecked,true);assert.equal(result.durability,'namespace-not-qualified');assert.equal(result.created.length,original.entries.length);
 assert.equal((await captured.verify()).manifestSha256,original.sha256);captured.close();const copied=await f.tree('target-parent/复制 空格');
 assert.deepEqual(copied.manifest.entries.map(({relative,type,sha256,byteLength})=>({relative,type,sha256,byteLength})),original.entries.map(({relative,type,sha256,byteLength})=>({relative,type,sha256,byteLength})));
 assert.ok(copied.manifest.entries.every(row=>row.identity!==original.entries.find(entry=>entry.relative===row.relative).identity));assert.equal(copied.manifest.rootIdentity,result.created[0].identity);
 assert.equal(copied.manifest.entries.find(row=>row.relative==='正文.bin').sha256,sha(bytes));await copied.sync();copied.close();
 const cold=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root}));for(const name of ['source','target-parent/复制 空格']){const file=f.file(name+'/project.sqlite');assert.equal(await cold.request(file,'get',{collection:'drafts',id:'draft'}),'未发送');assert.deepEqual(await cold.request(file,'receipt',{operationId:'seed'}),{revision:1});}
});

test('copy validates overlapping paths, aliases and all destination depths before any creation',native,async t=>{
 const f=await fixture(t);await f.directory('source/child');const captured=await f.tree('source');
 for(const target of ['source','SOURCE','source/late','CON.txt','ALIAS~1','new/late.'])await assert.rejects(captured.copyTo(f.file(target)),{code:'FS_PATH_REJECTED'});
 await assert.rejects(captured.copyTo(f.file('target'),{beforeEntry:null}),TypeError);assert.deepEqual(await fs.readdir(f.root),['source']);
 const reader=captured.streamFile('missing');await assert.rejects(reader.next(),{code:'FS_TREE_FILE_MISSING'});await captured.verify();
});

test('copy refuses changed source membership before target creation and preserves an existing independent target winner',native,async t=>{
 const f=await fixture(t);await f.directory('source');await fs.writeFile(f.file('source/draft'),'original');const captured=await f.tree('source');
 const winner=child(`import fs from 'node:fs';fs.mkdirSync(process.argv[1]);fs.writeFileSync(process.argv[1]+'/keep','external');`,[f.file('winner')]);assert.equal(winner.status,0,winner.stderr);
 await assert.rejects(captured.copyTo(f.file('winner')),error=>error.code==='WIN32_IO_ERROR'&&!error.committed&&error.privateTreeCopy.created.length===0);assert.equal(await fs.readFile(f.file('winner/keep'),'utf8'),'external');
 await fs.writeFile(f.file('source/late'),'external member');await assert.rejects(captured.copyTo(f.file('uncreated')),{code:'FS_TREE_CHANGED'});await absent(f.file('uncreated'));assert.equal((await captured.readFile('draft')).toString(),'original');
});

test('a late independent target file winner is preserved with exact partial copy facts and no name cleanup',native,async t=>{
 const f=await fixture(t);await f.directory('source');await fs.writeFile(f.file('source/a'),'first');await fs.writeFile(f.file('source/b'),'second');const captured=await f.tree('source');let facts;
 await assert.rejects(captured.copyTo(f.file('target'),{beforeEntry:entry=>{if(entry.relative==='b'){const winner=child(`import fs from 'node:fs';fs.writeFileSync(process.argv[1],'external');`,[f.file('target/b')]);assert.equal(winner.status,0,winner.stderr);}}}),error=>{facts=error.privateTreeCopy;return error.code==='FS_TARGET_EXISTS'&&error.committed&&error.durability==='uncertain';});
 assert.deepEqual(facts.created.map(row=>row.relative),['','a']);assert.deepEqual(await fs.readdir(f.file('target')),['a','b']);assert.equal(await fs.readFile(f.file('target/a'),'utf8'),'first');assert.equal(await fs.readFile(f.file('target/b'),'utf8'),'external');await captured.verify();
 const partial=await f.tree('target');assert.equal(partial.manifest.entries.find(row=>row.relative==='a').identity,facts.created[1].identity);partial.close();
 await assert.rejects(captured.copyTo(f.file('target')),error=>!error.committed&&error.privateTreeCopy.created.length===0);
});

test('copy detects source and destination late members while retaining verified files and independent bytes',native,async t=>{
 const f=await fixture(t);
 for(const kind of ['source','target']){await f.directory(kind+'-source');await fs.writeFile(f.file(kind+'-source/a'),'first');await fs.writeFile(f.file(kind+'-source/b'),'second');const captured=await f.tree(kind+'-source');
 await assert.rejects(captured.copyTo(f.file(kind+'-target'),{beforeEntry:async entry=>{if(entry.relative==='b'){await fs.writeFile(f.file(kind+'-'+kind+'/late'),'external');if(kind==='target'){const write=child(`import fs from 'node:fs';try{fs.writeFileSync(process.argv[1],'wrong');process.exit(2);}catch{}`, [f.file(kind+'-target/a')]);assert.equal(write.status,0,write.stderr);}}}}),error=>error.code==='FS_TREE_CHANGED'&&error.committed&&error.privateTreeCopy.created.length===3);
 assert.equal(await fs.readFile(f.file(kind+'-'+kind+'/late'),'utf8'),'external');assert.equal(await fs.readFile(f.file(kind+'-target/a'),'utf8'),'first');assert.equal(await fs.readFile(f.file(kind+'-source/b'),'utf8'),'second');}
});

test('copy cancellation retains created identities and real target barrier faults retain complete copied bytes',native,async t=>{
 const f=await fixture(t);await f.directory('source');await fs.writeFile(f.file('source/a'),'first');await fs.writeFile(f.file('source/b'),'second');const captured=await f.tree('source'),cancel=new AbortController();cancel.abort();
 await assert.rejects(captured.copyTo(f.file('before'),{signal:cancel.signal}),error=>error.code==='ABORT_ERR'&&!error.committed);await absent(f.file('before'));
 const during=new AbortController();await assert.rejects(captured.copyTo(f.file('partial'),{signal:during.signal,beforeEntry:entry=>{if(entry.relative==='b')during.abort();}}),error=>error.code==='ABORT_ERR'&&error.committed&&error.privateTreeCopy.created.length===2);assert.deepEqual(await fs.readdir(f.file('partial')),['a']);captured.close();
 const broken=await f.tree('source',{fileSync:(file,{phase})=>{if(phase==='copy')file.close();file.sync();}});await assert.rejects(broken.copyTo(f.file('fault')),error=>error.code==='FS_HANDLE_CLOSED'&&error.committed&&error.privateTreeCopy.created.length===3);await broken.verify();assert.equal(await fs.readFile(f.file('fault/b'),'utf8'),'second');
});

test('native deletion leases remove exact file HANDLEs and refuse ordinary leases, wrong receivers and nonempty directories',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/draft'),'retained');const parent=f.hold(open(f.root,'anchor')),root=f.hold(parent.openPrivateTreeRoot('tree')),ordinary=f.hold(root.openPrivateTreeFile('draft'));
 assert.throws(()=>ordinary.remove(),{code:'FS_HANDLE_REJECTED'});assert.throws(()=>ordinary.remove.call({}),{code:'FS_HANDLE_REJECTED'});ordinary.close();
 const file=f.hold(root.openPrivateDeleteFile('draft'));assert.equal(file.readAt(0,8).toString(),'retained');assert.throws(()=>root.removePrivateEmptyDirectory(),error=>error.win32Code===145);file.remove();await absent(f.file('tree/draft'));assert.throws(()=>file.remove(),{code:'FS_HANDLE_CLOSED'});root.removePrivateEmptyDirectory();await absent(f.file('tree'));parent.syncDirectory();
});

test('manifest removal deletes nested files and empty directories in postorder with exact identity facts and no replay',native,async t=>{
 const f=await fixture(t);await f.directory('tree/child/empty');await fs.writeFile(f.file('tree/a'),'first');await fs.writeFile(f.file('tree/child/b'),'second');const captured=await removalTree(f,'tree'),manifest=captured.manifest;
 const result=await captured.remove({expectedManifestSha256:manifest.sha256});assert.equal(result.rootRemoved,true);assert.equal(result.removed.length,manifest.entries.length);assert.equal(result.removed.at(-1).relative,'');assert.equal(result.durability,'namespace-not-qualified');await absent(f.file('tree'));
 assert.ok(result.removed.every(row=>row.identity===manifest.entries.find(entry=>entry.relative===row.relative).identity));await assert.rejects(captured.remove({expectedManifestSha256:manifest.sha256}),{code:'FS_TREE_REMOVAL_ATTEMPTED'});await assert.rejects(captured.verify(),{code:'FS_TREE_REMOVAL_ATTEMPTED'});
});

test('removal requires explicit deletion mode and the complete expected content identity and ACL manifest',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/draft'),'original');const ordinary=await f.tree('tree'),manifest=ordinary.manifest;
 await assert.rejects(ordinary.remove({expectedManifestSha256:manifest.sha256}),{code:'FS_HANDLE_REJECTED'});ordinary.close();const captured=await removalTree(f,'tree');
 await assert.rejects(captured.remove(),{code:'FS_VERSION_REJECTED'});await assert.rejects(captured.remove({expectedManifestSha256:'0'.repeat(64)}),error=>error.code==='FS_TREE_CHANGED'&&!error.committed);await captured.verify();captured.close();
 await fs.writeFile(f.file('tree/draft'),'external edit');const changed=await removalTree(f,'tree');await assert.rejects(changed.remove({expectedManifestSha256:manifest.sha256}),{code:'FS_TREE_CHANGED'});changed.close();assert.equal(await fs.readFile(f.file('tree/draft'),'utf8'),'external edit');
 await fs.writeFile(f.file('tree/draft'),'original');const sameBytes=await removalTree(f,'tree');assert.equal(sameBytes.manifest.sha256,manifest.sha256);sameBytes.close();security('protect-user-file',f.file('tree/draft'));
 const acl=await removalTree(f,'tree');await assert.rejects(acl.remove({expectedManifestSha256:manifest.sha256}),{code:'FS_TREE_CHANGED'});acl.close();await fs.rename(f.file('tree'),f.file('old'));await f.directory('tree');await fs.writeFile(f.file('tree/draft'),'original');const replacement=await removalTree(f,'tree');await assert.rejects(replacement.remove({expectedManifestSha256:manifest.sha256}),{code:'FS_TREE_CHANGED'});assert.equal(await fs.readFile(f.file('old/draft'),'utf8'),'original');
});

test('late removal members stop before the next delete and preserve both the external entry and exact partial progress',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/a'),'first');await fs.writeFile(f.file('tree/b'),'second');const captured=await removalTree(f,'tree');let facts;
 await assert.rejects(captured.remove({expectedManifestSha256:captured.manifest.sha256,beforeEntry:async entry=>{if(entry.relative==='b')await fs.writeFile(f.file('tree/late'),'external');}}),error=>{facts=error.privateTreeRemoval;return error.code==='FS_TREE_CHANGED'&&error.committed&&error.durability==='uncertain';});
 assert.deepEqual(facts.removed.map(row=>row.relative),['a']);assert.equal(facts.rootRemoved,false);await absent(f.file('tree/a'));assert.equal(await fs.readFile(f.file('tree/b'),'utf8'),'second');assert.equal(await fs.readFile(f.file('tree/late'),'utf8'),'external');await assert.rejects(captured.sync(),{code:'FS_TREE_REMOVAL_ATTEMPTED'});
});

test('removal detects an unreviewed member before any mutation and never repairs changed security',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/draft'),'original');const captured=await removalTree(f,'tree');await fs.writeFile(f.file('tree/late'),'external');
 await assert.rejects(captured.remove({expectedManifestSha256:captured.manifest.sha256}),error=>error.code==='FS_TREE_CHANGED'&&!error.committed&&error.privateTreeRemoval.removed.length===0);captured.close();
 const acl=await removalTree(f,'tree');security('add-write',f.file('tree/draft'));const changed=security('inspect',f.file('tree/draft'));await assert.rejects(acl.remove({expectedManifestSha256:acl.manifest.sha256}),error=>error.code==='FS_STAGE_CHANGED'&&!error.committed);assert.deepEqual(security('inspect',f.file('tree/draft')),changed);assert.equal(await fs.readFile(f.file('tree/draft'),'utf8'),'original');
});

test('partial removal cancellation requires cold reconciliation and a new explicit manifest before deleting the remainder',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/a'),'first');await fs.writeFile(f.file('tree/b'),'second');const captured=await removalTree(f,'tree'),manifest=captured.manifest,before=new AbortController();before.abort();
 await assert.rejects(captured.remove({expectedManifestSha256:manifest.sha256,signal:before.signal}),error=>error.code==='ABORT_ERR'&&!error.committed);const during=new AbortController();
 await assert.rejects(captured.remove({expectedManifestSha256:manifest.sha256,signal:during.signal,beforeEntry:entry=>{if(entry.relative==='b')during.abort();}}),error=>error.code==='ABORT_ERR'&&error.committed&&error.privateTreeRemoval.removed.length===1);await assert.rejects(captured.remove({expectedManifestSha256:manifest.sha256}),{code:'FS_TREE_REMOVAL_ATTEMPTED'});captured.close();
 const cold=await removalTree(f,'tree');await assert.rejects(cold.remove({expectedManifestSha256:manifest.sha256}),{code:'FS_TREE_CHANGED'});assert.equal((await cold.readFile('b')).toString(),'second');await cold.remove({expectedManifestSha256:cold.manifest.sha256});await absent(f.file('tree'));
});

test('real deletion parent barrier faults report the already removed file and preserve all remaining entries',native,async t=>{
 const f=await fixture(t);await f.directory('tree');await fs.writeFile(f.file('tree/a'),'first');await fs.writeFile(f.file('tree/b'),'second');const captured=await removalTree(f,'tree',{directorySync:(directory,{phase})=>{if(phase==='remove-parent')directory.close();directory.syncDirectory();}});
 await assert.rejects(captured.remove({expectedManifestSha256:captured.manifest.sha256}),error=>error.code==='FS_HANDLE_CLOSED'&&error.committed&&error.privateTreeRemoval.removed[0].relative==='a'&&!error.privateTreeRemoval.rootRemoved);captured.close();await absent(f.file('tree/a'));assert.equal(await fs.readFile(f.file('tree/b'),'utf8'),'second');const cold=await removalTree(f,'tree');await cold.verify();
});

test('active SQLite refuses deletion lease capture and its actual close permits manifest-bound removal without touching the copied backup',native,async t=>{
 const f=await fixture(t);await f.directory('tree');const db=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root})),file=f.file('tree/project.sqlite');await db.request(file,'put',{collection:'drafts',id:'draft',value:'original',operationId:'seed'});
 await assert.rejects(tree(f.root,f.file('tree'),{deletion:true}),{code:'WIN32_IO_ERROR'});assert.equal(await db.request(file,'get',{collection:'drafts',id:'draft'}),'original');await db.close();const source=await f.tree('tree');await source.copyTo(f.file('backup'));source.close();
 const deleting=await removalTree(f,'tree');await deleting.remove({expectedManifestSha256:deleting.manifest.sha256});await absent(f.file('tree'));const cold=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root}));assert.deepEqual(await cold.request(f.file('backup/project.sqlite'),'receipt',{operationId:'seed'}),{revision:1});assert.equal(await cold.request(f.file('backup/project.sqlite'),'get',{collection:'drafts',id:'draft'}),'original');
});

test('abrupt real host exit during copy or deletion retains partial namespace facts for a cold manifest without automatic replay',native,async t=>{
 const f=await fixture(t),loader=new URL('../src/platform/windows/experimental-private-tree.mjs',import.meta.url).href;await f.directory('source');await fs.writeFile(f.file('source/a'),'first');await fs.writeFile(f.file('source/b'),'second');
 const copied=child(`import {openExperimentalPrivateTree as tree} from ${JSON.stringify(loader)};const lease=await tree(process.argv[1],process.argv[2]);await lease.copyTo(process.argv[3],{beforeEntry:entry=>{if(entry.relative==='b')process.exit(0);}});throw Error('exit point not reached');`,[f.root,f.file('source'),f.file('target')]);assert.equal(copied.status,0,copied.stderr);assert.deepEqual(await fs.readdir(f.file('target')),['a']);assert.equal(await fs.readFile(f.file('source/b'),'utf8'),'second');const cold=await f.tree('target');assert.equal((await cold.readFile('a')).toString(),'first');cold.close();
 const deleted=child(`import {openExperimentalPrivateTree as tree} from ${JSON.stringify(loader)};const lease=await tree(process.argv[1],process.argv[2],{deletion:true});await lease.remove({expectedManifestSha256:lease.manifest.sha256,beforeEntry:entry=>{if(entry.relative==='b')process.exit(0);}});throw Error('exit point not reached');`,[f.root,f.file('source')]);assert.equal(deleted.status,0,deleted.stderr);assert.deepEqual(await fs.readdir(f.file('source')),['b']);const rest=await removalTree(f,'source');assert.equal((await rest.readFile('b')).toString(),'second');await rest.verify();assert.equal(await fs.readFile(f.file('target/a'),'utf8'),'first');
});

test('cold partial removal inspects only original survivors and confirmed receipts',native,async t=>{
 const f=await fixture(t),loader=new URL('../src/platform/windows/experimental-private-tree.mjs',import.meta.url).href;
 await f.directory('parent/tree/nested');
 await fs.writeFile(f.file('parent/tree/a'),'removed');await fs.writeFile(f.file('parent/tree/nested/b'),'survivor');
 const directory=f.file('parent/tree'),lease=await removalTree(f,'parent/tree'),binding=lease.removalBinding(),controller=new AbortController();
 let confirmed;
 await assert.rejects(lease.remove({expectedManifestSha256:binding.manifest.sha256,signal:controller.signal,afterEntry(relative,fact){
  assert.equal(relative,'a');confirmed=fact.removed;controller.abort();
 }}),{code:'ABORT_ERR'});
 lease.close();
 const evidence=f.file('evidence.json');await fs.writeFile(evidence,JSON.stringify({binding,confirmed}));
 const inspect=mode=>{
  const result=child(`import {readFile} from 'node:fs/promises';import {openExperimentalPrivateTree as tree} from ${JSON.stringify(loader)};
   const [root,directory,evidence,mode]=process.argv.slice(1),{binding,confirmed}=JSON.parse(await readFile(evidence));
   const lease=await tree(root,directory,{rootAccess:'readwrite',fileAccess:'read'});
   try{console.log(JSON.stringify(await lease.inspectRemovalProgress(binding,mode==='unconfirmed'?[]:mode==='duplicate'?[...confirmed,...confirmed]:confirmed)));}
   catch(error){console.log(JSON.stringify({code:error.code}));}finally{lease.close();}`,[f.root,directory,evidence,mode]);
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
 };
 const observed=inspect('confirmed');
 assert.equal(observed.state,'survivors-verified');
 assert.equal(observed.originalManifestSha256,binding.manifest.sha256);
 assert.notEqual(observed.remainingManifestSha256,binding.manifest.sha256);
 assert.deepEqual(inspect('unconfirmed'),{code:'FS_TREE_CHANGED'});
 assert.deepEqual(inspect('duplicate'),{code:'FS_VERSION_REJECTED'});
 await fs.writeFile(f.file('parent/tree/a'),'removed');
 assert.deepEqual(inspect('confirmed'),{code:'FS_TREE_CHANGED'});
 await fs.unlink(f.file('parent/tree/a'));
 await fs.rename(f.file('parent'),f.file('old-parent'));await f.directory('parent');
 await fs.rename(f.file('old-parent/tree'),directory);
 assert.deepEqual(inspect('confirmed'),{code:'FS_TREE_CHANGED'});
 await fs.rename(directory,f.file('old-parent/tree'));await fs.rename(f.file('parent'),f.file('new-parent'));await fs.rename(f.file('old-parent'),f.file('parent'));
 assert.deepEqual(inspect('confirmed'),observed,'restoring the exact parent restores the verified observation');
 await fs.writeFile(f.file('parent/tree/nested/b'),'modified');
 assert.deepEqual(inspect('confirmed'),{code:'FS_TREE_CHANGED'});
 await fs.writeFile(f.file('parent/tree/nested/b'),'survivor');
 assert.deepEqual(inspect('confirmed'),observed,'restoring bytes of the same object restores the verified observation');
 await fs.rename(f.file('parent/tree/nested/b'),f.file('original-b'));await fs.writeFile(f.file('parent/tree/nested/b'),'survivor');
 assert.deepEqual(inspect('confirmed'),{code:'FS_TREE_CHANGED'});
 assert.equal(await fs.readFile(f.file('original-b'),'utf8'),'survivor');
 assert.equal(await fs.readFile(f.file('parent/tree/nested/b'),'utf8'),'survivor');
});

test('cold removal observation requires original SQLite receipts for an absent member',native,async t=>{
 const f=await fixture(t),inspector=new URL('../src/main/windows-removal-inspection.mjs',import.meta.url).href;
 await f.directory('journal');await f.directory('tree');
 await fs.writeFile(f.file('tree/a'),'first');await fs.writeFile(f.file('tree/b'),'retained');
 const lease=await removalTree(f,'tree'),binding=lease.removalBinding();lease.close();
 // Simulate absence without invoking the deletion writer or injecting a crash.
 await fs.rename(f.file('tree/a'),f.file('journal/retained-a'));
 const file=f.file('journal/receipt.sqlite'),removalId='synthetic-removal',requests=removalReceiptRequests(removalId,binding);
 const {intent,confirmation}=requests.members.find(({member})=>member.relative==='a');
 const write=async(...records)=>{
  const db=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root}));
  try{for(const args of records)assert.deepEqual(await db.request(file,'put',args),{revision:1});}
  finally{assert.equal((await db.close()).some(result=>result?.closed===false),false);}
 };
 await write(requests.binding,intent);
 const parent=open(f.root,'journal/receipt.sqlite');
 let databaseIdentity;
 try{databaseIdentity=parent.inspectEntry('receipt.sqlite').identity;}finally{parent.close();}
 const observe=async()=>{
  const bytes=await fs.readFile(file),names=await fs.readdir(f.file('journal'));
  const result=child(`import {inspectWindowsRemovalProgress as inspect} from ${JSON.stringify(inspector)};
   const [root,file,binding,removalId,databaseIdentity]=process.argv.slice(1);
   try{console.log(JSON.stringify(await inspect(root,file,{binding:JSON.parse(binding),removalId,databaseIdentity})));}
   catch(error){if(!error.code)throw error;console.log(JSON.stringify({code:error.code}));}`,
   [f.root,file,JSON.stringify(binding),removalId,databaseIdentity]);
  assert.equal(result.status,0,result.stderr);assert.deepEqual(await fs.readFile(file),bytes);
  assert.deepEqual(await fs.readdir(f.file('journal')),names);
  assert.deepEqual(await fs.readdir(f.file('tree')),['b']);
  assert.equal(await fs.readFile(f.file('tree/b'),'utf8'),'retained');
  assert.equal(await fs.readFile(f.file('journal/retained-a'),'utf8'),'first');
  return JSON.parse(result.stdout);
 };
 assert.deepEqual(await observe(),{code:'FS_TREE_CHANGED'});
 await write(confirmation);
 const observed=await observe();
 assert.equal(observed.state,'survivors-verified');assert.equal(observed.observationOnly,true);assert.equal(observed.confirmedCount,1);
 const {confirmation:other}=requests.members.find(({member})=>member.relative==='b');
 await write({...other,value:{...other.value,member:{...other.value.member,identity:'different'}}});
 assert.deepEqual(await observe(),{code:'STORAGE_OPERATION_CONFLICT'});
 await fs.writeFile(file+'-journal','synthetic rollback journal');
 assert.deepEqual(await observe(),{code:'STORAGE_RECEIPT_UNVERIFIABLE'});
});

test('cancelling a large copy between chunks discards only its exact unpublished stage and retains the created root',native,async t=>{
 const f=await fixture(t);await f.directory('source');await fs.writeFile(f.file('source/large'),Buffer.alloc(33*1024*1024,0x61));const captured=await f.tree('source'),cancel=new AbortController();
 await assert.rejects(captured.copyTo(f.file('target'),{signal:cancel.signal,beforeEntry:()=>{setImmediate(()=>cancel.abort());}}),error=>error.code==='ABORT_ERR'&&error.committed&&error.privateTreeCopy.created.length===1);
 assert.deepEqual(await fs.readdir(f.file('target')),[]);assert.equal((await fs.stat(f.file('source/large'))).size,33*1024*1024);await captured.verify();await captured.copyTo(f.file('retry'));assert.equal((await fs.stat(f.file('retry/large'))).size,33*1024*1024);
});

test('copy and removal exclude active readers and mutation callbacks cannot run a second tree operation',native,async t=>{
 const f=await fixture(t);await f.directory('source');await fs.writeFile(f.file('source/a'),'first');const captured=await removalTree(f,'source'),reader=captured.streamFile('a');await reader.next();
 await assert.rejects(captured.copyTo(f.file('target')),{code:'FS_TREE_BUSY'});await assert.rejects(captured.remove({expectedManifestSha256:captured.manifest.sha256}),{code:'FS_TREE_BUSY'});await reader.return();
 await captured.copyTo(f.file('target'),{beforeEntry:async()=>{await assert.rejects(captured.verify(),{code:'FS_TREE_BUSY'});}});await captured.remove({expectedManifestSha256:captured.manifest.sha256});assert.equal(await fs.readFile(f.file('target/a'),'utf8'),'first');
});

test('root deletion barrier failure and cancellation retain the completed root removal fact',native,async t=>{
 const f=await fixture(t);await f.directory('fault');const broken=await removalTree(f,'fault',{directorySync:(directory,{phase})=>{if(phase==='remove-parent')directory.close();directory.syncDirectory();}});
 await assert.rejects(broken.remove({expectedManifestSha256:broken.manifest.sha256}),error=>error.code==='FS_HANDLE_CLOSED'&&error.committed&&error.privateTreeRemoval.rootRemoved&&error.privateTreeRemoval.removed.length===1);await absent(f.file('fault'));broken.close();
 await f.directory('cancel');const cancel=new AbortController(),captured=await removalTree(f,'cancel',{directorySync:(directory,{phase})=>{directory.syncDirectory();if(phase==='remove-parent')cancel.abort();}});const result=await captured.remove({expectedManifestSha256:captured.manifest.sha256,signal:cancel.signal});assert.equal(result.rootRemoved,true);assert.equal(result.state,'barriers-completed');await absent(f.file('cancel'));
});

test('single-character directory publication uses the full native rename structure and retains the original identity',native,async t=>{
 const f=await fixture(t);await f.directory('source');await fs.writeFile(f.file('source/a'),'original');const captured=await f.tree('source'),identity=captured.manifest.rootIdentity,result=await captured.publishTo(f.file('x'));assert.equal(result.identity,identity);assert.equal((await captured.readFile('a')).toString(),'original');await assert.rejects(captured.copyTo(f.file('copy')),{code:'FS_MOVE_PUBLISHED'});await absent(f.file('copy'));captured.close();const cold=await f.tree('x');assert.equal(cold.manifest.rootIdentity,identity);await cold.copyTo(f.file('copy'));assert.equal(await fs.readFile(f.file('copy/a'),'utf8'),'original');await absent(f.file('source'));
});
