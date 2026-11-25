import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {ensureExperimentalPrivateDirectory as ensure} from '../src/platform/windows/experimental-directories.mjs';
import {moveExperimentalPrivateDirectory as move} from '../src/platform/windows/experimental-directory-move.mjs';
import {openExperimentalPersistenceParent as open} from '../src/platform/windows/experimental-persistence.mjs';
import {StorageDatabase} from '../src/main/storage-database.mjs';
import {security} from './fixtures/windows-security.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-directory-move-')),resources=[];
 t.after(async()=>{for(const resource of resources.reverse())await resource.close();await fs.rm(root,{recursive:true,force:true});});
 return {root,file:relative=>path.join(root,relative),hold(resource){resources.push(resource);return resource;},async directory(relative){return ensure(root,path.join(root,relative));}};
}
function child(code,args=[]){const result=spawnSync(process.execPath,['--input-type=module','-e',code,...args],{encoding:'utf8',windowsHide:true,timeout:10000});assert.ifError(result.error);assert.equal(result.signal,null);return result;}
async function absent(file){await assert.rejects(fs.lstat(file),{code:'ENOENT'});}
async function id(f,relative){return (await f.directory(relative)).identity;}

test('native directory publication retains both parent chains after close and preserves the directory ID and private ACL',native,async t=>{
 const f=await fixture(t),source=f.file('临时 目录'),destination=f.file('正式 目录'),expected=(await f.directory('临时 目录')).identity;
 await fs.mkdir(path.join(source,'nested'));await fs.writeFile(path.join(source,'nested','正文.txt'),'未发送草稿');
 const before=security('inspect',source),parent=f.hold(open(f.root,'anchor')),lease=f.hold(parent.beginPrivateDirectoryMove('临时 目录',parent,'正式 目录',expected));
 parent.close();lease.verify();lease.syncDirectory();
 assert.throws(()=>lease.commit.call({}),{code:'FS_HANDLE_REJECTED'});
 const blocked=child(`import fs from 'node:fs';try{fs.renameSync(process.argv[1],process.argv[1]+'-moved');}catch(e){console.log(e.code);process.exitCode=7;}`,[f.root]);assert.equal(blocked.status,7,blocked.stderr);
 lease.commit();lease.verify();lease.syncDirectory();assert.equal(lease.identity(),expected);
 assert.throws(()=>lease.commit(),{code:'FS_MOVE_PUBLISHED'});await absent(source);
 assert.equal(await fs.readFile(path.join(destination,'nested','正文.txt'),'utf8'),'未发送草稿');assert.deepEqual(security('inspect',destination),before);
 lease.close();lease.close();assert.throws(()=>lease.verify(),{code:'FS_HANDLE_CLOSED'});assert.equal(await id(f,'正式 目录'),expected);
});

test('cross-parent move completes all directory barriers and the actual SQLite worker reopens original receipts and drafts at the destination',native,async t=>{
 const f=await fixture(t),expected=(await f.directory('stage/candidate')).identity;await f.directory('published');
 const source=f.file('stage/candidate'),destination=f.file('published/project'),database=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root}));
 const receipt=await database.request(path.join(source,'project.sqlite'),'put',{collection:'drafts',id:'draft',value:'候选正文',operationId:'before-move'});await database.close();
 const result=await move(f.root,source,destination,{expectedIdentity:expected});
 assert.deepEqual(result,{schema:1,platform:'win32',state:'barriers-completed',durability:'namespace-not-qualified',source,destination,identity:expected,moved:true,barriers:{directory:'flushed',sourceParent:'flushed',destinationParent:'flushed'}});
 await absent(source);assert.equal(await id(f,'published/project'),expected);
 const cold=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root}));assert.equal(await cold.request(path.join(destination,'project.sqlite'),'get',{collection:'drafts',id:'draft'}),'候选正文');
 assert.deepEqual(await cold.request(path.join(destination,'project.sqlite'),'receipt',{operationId:'before-move'}),receipt);
});

test('existing file, directory, junction and case-equivalent destination winners are never replaced or cleaned up',native,async t=>{
 const f=await fixture(t);await fs.mkdir(f.file('outside'));await fs.writeFile(f.file('outside/keep'),'outside');
 await fs.writeFile(f.file('file'),'file winner');await fs.mkdir(f.file('directory'));await fs.writeFile(f.file('directory/keep'),'directory winner');await fs.symlink(f.file('outside'),f.file('junction'),'junction');await fs.mkdir(f.file('CASE'));await fs.writeFile(f.file('CASE/keep'),'case winner');
 for(const name of ['file','directory','junction','case']){
  const source='source-'+name,expected=(await f.directory(source)).identity;await fs.writeFile(f.file(source+'/draft'),'source retained');
  await assert.rejects(move(f.root,f.file(source),f.file(name),{expectedIdentity:expected}));assert.equal(await id(f,source),expected);assert.equal(await fs.readFile(f.file(source+'/draft'),'utf8'),'source retained');
 }
 assert.equal(await fs.readFile(f.file('file'),'utf8'),'file winner');assert.equal(await fs.readFile(f.file('directory/keep'),'utf8'),'directory winner');assert.equal(await fs.readFile(f.file('CASE/keep'),'utf8'),'case winner');assert.deepEqual(await fs.readdir(f.file('outside')),['keep']);assert.equal((await fs.lstat(f.file('junction'))).isSymbolicLink(),true);
});

test('wrong source identity, broad permissions, reparse and file sources refuse without source or target changes',native,async t=>{
 const f=await fixture(t),expected=(await f.directory('source')).identity;
 await assert.rejects(move(f.root,f.file('source'),f.file('target'),{expectedIdentity:'0000000000000000:'+('0'.repeat(32))}),{code:'FS_DIRECTORY_CONFLICT'});assert.equal(await id(f,'source'),expected);
 await fs.mkdir(f.file('broad'));const before=security('inspect',f.file('broad'));await assert.rejects(move(f.root,f.file('broad'),f.file('target'),{expectedIdentity:expected}),{code:'FS_DIRECTORY_CONFLICT'});
 const parent=f.hold(open(f.root,'anchor')),broad=await fs.stat(f.file('broad'),{bigint:true});assert.ok(broad.isDirectory());
 // Obtain the real directory ID without granting/repairing private permissions.
 const broadParent=f.hold(open(f.root,'broad/anchor')),broadIdentity=broadParent.identity();broadParent.close();
 await assert.rejects(move(f.root,f.file('broad'),f.file('target'),{expectedIdentity:broadIdentity}),{code:'FS_SECURITY_CHANGED'});
 assert.deepEqual(security('inspect',f.file('broad')),before);
 await fs.symlink(f.file('source'),f.file('junction'),'junction');await assert.rejects(move(f.root,f.file('junction'),f.file('target'),{expectedIdentity:expected}),{code:'FS_REPARSE_REJECTED'});
 await fs.writeFile(f.file('file'),'external');await assert.rejects(move(f.root,f.file('file'),f.file('target'),{expectedIdentity:expected}));assert.equal(await fs.readFile(f.file('file'),'utf8'),'external');await absent(f.file('target'));
 assert.throws(()=>parent.beginPrivateDirectoryMove('source',{},'target',expected),{code:'FS_HANDLE_REJECTED'});assert.throws(()=>parent.beginPrivateDirectoryMove('source',null,'target',expected));
 broadParent.close();parent.close();
});

test('a prepared move denies independent source rename and delete but a late destination winner remains intact',native,async t=>{
 const f=await fixture(t),expected=(await f.directory('source')).identity,parent=f.hold(open(f.root,'anchor')),lease=f.hold(parent.beginPrivateDirectoryMove('source',parent,'target',expected));
 for(const operation of ['renameSync','rmdirSync']){
  const blocked=child(`import fs from 'node:fs';try{if(process.argv[1]==='renameSync')fs.renameSync(process.argv[2],process.argv[2]+'-external');else fs.rmdirSync(process.argv[2]);}catch(e){console.log(e.code);process.exitCode=7;}`,[operation,f.file('source')]);assert.equal(blocked.status,7,blocked.stderr);
 }
 const winner=child(`import fs from 'node:fs';fs.mkdirSync(process.argv[1]);fs.writeFileSync(process.argv[1]+'/keep','external');`,[f.file('target')]);assert.equal(winner.status,0,winner.stderr);
 assert.throws(()=>lease.commit());lease.close();assert.equal(await id(f,'source'),expected);assert.equal(await fs.readFile(f.file('target/keep'),'utf8'),'external');
});

test('source security changes after preparation refuse before publication and are not silently repaired',native,async t=>{
 const f=await fixture(t),expected=(await f.directory('source')).identity,parent=f.hold(open(f.root,'anchor')),lease=f.hold(parent.beginPrivateDirectoryMove('source',parent,'target',expected));
 security('add-write',f.file('source'));const changed=security('inspect',f.file('source'));assert.throws(()=>lease.commit(),{code:'FS_STAGE_CHANGED'});assert.throws(()=>lease.syncDirectory(),{code:'FS_STAGE_CHANGED'});await absent(f.file('target'));assert.deepEqual(security('inspect',f.file('source')),changed);
});

test('a move retains private parent policy snapshots and rejects a destination-ancestor ACL change',native,async t=>{
 const f=await fixture(t),expected=(await f.directory('stage/source')).identity;await f.directory('published');
 const root=f.hold(open(f.root,'anchor')),from=f.hold(root.openPrivateDirectory('stage',false)),to=f.hold(root.openPrivateDirectory('published',false)),lease=f.hold(from.beginPrivateDirectoryMove('source',to,'target',expected));
 root.close();from.close();to.close();security('add-write',f.file('published'));assert.throws(()=>lease.commit(),{code:'FS_STAGE_CHANGED'});await absent(f.file('published/target'));lease.close();assert.equal(await id(f,'stage/source'),expected);
 await f.directory('other');await assert.rejects(move(f.root,f.file('stage/source'),f.file('other/target'),{expectedIdentity:expected,directorySync:directory=>{directory.syncDirectory();security('add-write',f.file('other'));}}),{code:'FS_STAGE_CHANGED'});await absent(f.file('other/target'));assert.equal(await id(f,'stage/source'),expected);
});

test('real closed-handle faults before and after publication preserve the correct namespace and recovery identity',native,async t=>{
 const f=await fixture(t),expected=(await f.directory('source')).identity;
 await assert.rejects(move(f.root,f.file('source'),f.file('target'),{expectedIdentity:expected,directorySync:lease=>{lease.close();lease.syncDirectory();}}),error=>error.code==='FS_HANDLE_CLOSED'&&!error.committed&&error.directoryMove.moved===false);
 assert.equal(await id(f,'source'),expected);await absent(f.file('target'));let calls=0;
 await assert.rejects(move(f.root,f.file('source'),f.file('target'),{expectedIdentity:expected,directorySync:lease=>{if(++calls===2)lease.close();lease.syncDirectory();}}),error=>error.code==='FS_HANDLE_CLOSED'&&error.committed===true&&error.durability==='uncertain'&&error.directoryMove.identity===expected&&error.directoryMove.moved===true);
 await absent(f.file('source'));assert.equal(await id(f,'target'),expected);
 await assert.rejects(move(f.root,f.file('source'),f.file('target'),{expectedIdentity:expected}),error=>!error.committed);assert.equal(await id(f,'target'),expected);
 const other=(await f.directory('other')).identity;calls=0;
 await assert.rejects(move(f.root,f.file('other'),f.file('other-target'),{expectedIdentity:other,directorySync:lease=>{lease.syncDirectory();if(++calls===2)throw null;}}),error=>error.code==='FS_DIRECTORY_MOVE_FAILED'&&error.cause===null&&error.committed===true&&error.directoryMove.moved===true);
 await absent(f.file('other'));assert.equal(await id(f,'other-target'),other);
});

test('both source and destination parent barrier failures after publication carry committed identity facts',native,async t=>{
 const f=await fixture(t);await f.directory('destination');
 for(const failAt of [3,4]){
  const source='source-'+failAt,target='destination/target-'+failAt,expected=(await f.directory(source)).identity;let calls=0;
  await assert.rejects(move(f.root,f.file(source),f.file(target),{expectedIdentity:expected,directorySync:lease=>{if(++calls===failAt)lease.close();lease.syncDirectory();}}),error=>error.code==='FS_HANDLE_CLOSED'&&error.committed===true&&error.directoryMove.moved===true);
  await absent(f.file(source));assert.equal(await id(f,target),expected);
 }
});

test('cancellation is honored before publication while postpublication cancellation still completes barriers',native,async t=>{
 const f=await fixture(t),expected=(await f.directory('source')).identity,before=new AbortController();before.abort();
 await assert.rejects(move(f.root,f.file('source'),f.file('target'),{expectedIdentity:expected,signal:before.signal}),{code:'ABORT_ERR'});
 const during=new AbortController();await assert.rejects(move(f.root,f.file('source'),f.file('target'),{expectedIdentity:expected,signal:during.signal,directorySync:lease=>{lease.syncDirectory();during.abort();}}),error=>error.code==='ABORT_ERR'&&!error.committed);assert.equal(await id(f,'source'),expected);await absent(f.file('target'));
 const after=new AbortController();let calls=0;const result=await move(f.root,f.file('source'),f.file('target'),{expectedIdentity:expected,signal:after.signal,directorySync:lease=>{lease.syncDirectory();if(++calls===2)after.abort();}});assert.equal(result.moved,true);assert.equal(calls,4);assert.equal(await id(f,'target'),expected);
});

test('invalid whole plans, identities, same-name operations and missing destination parents refuse before effects',native,async t=>{
 const f=await fixture(t),expected=(await f.directory('source')).identity;
 for(const target of [f.root,f.file('new/late.'),f.file('new/ALIAS~1'),f.file('new/ＮＵＬ.txt'),path.join(f.root,'..','outside'),f.root+'\\new\\..\\target'])await assert.rejects(move(f.root,f.file('source'),target,{expectedIdentity:expected}),{code:'FS_PATH_REJECTED'});
 for(const expectedIdentity of [undefined,'',1,'0'.repeat(49),'A'+expected.slice(1)])await assert.rejects(move(f.root,f.file('source'),f.file('target'),{expectedIdentity}),{code:'FS_IDENTITY_REJECTED'});
 await assert.rejects(move(f.root,f.file('source'),f.file('SOURCE'),{expectedIdentity:expected}),{code:'FS_NAME_REJECTED'});
 await assert.rejects(move(f.root,f.file('source'),f.file('missing/target'),{expectedIdentity:expected}));
 await assert.rejects(move(f.root,f.file('source'),f.file('source/child'),{expectedIdentity:expected}));assert.deepEqual(await fs.readdir(f.root),['source']);assert.equal(await id(f,'source'),expected);
});

test('ordinary or closed parents and source replacement do not silently obtain move rights',native,async t=>{
 const f=await fixture(t),expected=(await f.directory('source')).identity,parent=f.hold(open(f.root,'anchor'));
 const {openExperimentalWriteParent}=await import('../src/platform/windows/experimental-write.mjs'),ordinary=f.hold(openExperimentalWriteParent(f.root,'anchor'));
 assert.throws(()=>ordinary.beginPrivateDirectoryMove('source',parent,'target',expected),{code:'FS_DIRECTORY_SYNC_UNSUPPORTED'});ordinary.close();
 const closed=f.hold(open(f.root,'anchor'));closed.close();assert.throws(()=>parent.beginPrivateDirectoryMove('source',closed,'target',expected),{code:'FS_HANDLE_CLOSED'});
 await fs.rename(f.file('source'),f.file('original'));await f.directory('source');await fs.writeFile(f.file('source/winner'),'external');
 await assert.rejects(move(f.root,f.file('source'),f.file('target'),{expectedIdentity:expected}),{code:'FS_DIRECTORY_CONFLICT'});assert.equal(await id(f,'original'),expected);assert.equal(await fs.readFile(f.file('source/winner'),'utf8'),'external');await absent(f.file('target'));
});

test('real host exit before or after commit releases pins and retains the actual namespace without replay or cleanup',native,async t=>{
 const f=await fixture(t),loader=new URL('../src/platform/windows/experimental-persistence.mjs',import.meta.url).href;
 for(const committed of [false,true]){
  const source='source-'+committed,target='target-'+committed,expected=(await f.directory(source)).identity;
  const exited=child(`import {openExperimentalPersistenceParent as open} from ${JSON.stringify(loader)};const parent=open(process.argv[1],'anchor');const lease=parent.beginPrivateDirectoryMove(process.argv[2],parent,process.argv[3],process.argv[4]);lease.syncDirectory();if(process.argv[5]==='true')lease.commit();process.exit(0);`,[f.root,source,target,expected,String(committed)]);assert.equal(exited.status,0,exited.stderr);
  assert.equal(await id(f,committed?target:source),expected);await absent(f.file(committed?source:target));await fs.rename(f.file(committed?target:source),f.file('released-'+committed));
 }
});

test('two real independent publishers race for one destination and preserve the losing source and winning identity',native,async t=>{
 const f=await fixture(t),sources=['first','second'],identities=await Promise.all(sources.map(name=>id(f,name))),loader=new URL('../src/platform/windows/experimental-directory-move.mjs',import.meta.url).href;
 for(const source of sources)await fs.writeFile(f.file(source+'/draft'),source);
 const rows=sources.map((source,index)=>{
  const process=spawn(globalThis.process.execPath,['--input-type=module','-e',`
   import {once} from 'node:events';import {moveExperimentalPrivateDirectory as move} from ${JSON.stringify(loader)};
   process.send('ready');await once(process,'message');
   try{console.log(JSON.stringify({ok:true,...await move(process.argv[1],process.argv[2],process.argv[3],{expectedIdentity:process.argv[4]})}));}
   catch(error){console.log(JSON.stringify({ok:false,code:error.code,committed:error.committed}));}finally{process.disconnect();}`,f.root,f.file(source),f.file('winner'),identities[index]],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  let stdout='',stderr='';process.stdout.on('data',value=>{stdout+=value;});process.stderr.on('data',value=>{stderr+=value;});const ready=once(process,'message'),exited=once(process,'exit'),timer=setTimeout(()=>process.kill(),10000);
  f.hold({async close(){clearTimeout(timer);if(process.exitCode===null&&process.signalCode===null){process.kill();await exited;}}});return {process,ready,exited,result:()=>({stdout,stderr})};
 });
 await Promise.all(rows.map(row=>row.ready));for(const row of rows)row.process.send('go');const exits=await Promise.all(rows.map(row=>row.exited));for(let index=0;index<exits.length;index++)assert.equal(exits[index][0],0,rows[index].result().stderr);
 const results=rows.map(row=>JSON.parse(row.result().stdout));assert.equal(results.filter(row=>row.ok).length,1);const winner=results.findIndex(row=>row.ok),loser=1-winner;
 assert.equal(results[loser].committed,undefined);assert.equal(await id(f,'winner'),identities[winner]);assert.equal(await fs.readFile(f.file('winner/draft'),'utf8'),sources[winner]);await absent(f.file(sources[winner]));assert.equal(await id(f,sources[loser]),identities[loser]);assert.equal(await fs.readFile(f.file(sources[loser]+'/draft'),'utf8'),sources[loser]);assert.equal(security('inspect',f.file('winner')).rules.length,1);
});
