import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {MaterialStore,digestBytes} from '../src/domain/material-store.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {openExperimentalPersistenceParent as open} from '../src/platform/windows/experimental-persistence.mjs';
import {security} from './fixtures/windows-security.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t,options={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-material-')),held=[];
 t.after(async()=>{for(const item of held.reverse())await (item.db??item).close();await fs.rm(root,{recursive:true,force:true});});
 const directory=path.join(root,'材料 空格','sha256'),store=new MaterialStore(directory,{experimentalWindowsRoot:root,...options});
 return {root,directory,store,hold(value){held.push(value);return value;},cold(extra={}){return new MaterialStore(directory,{experimentalWindowsRoot:root,...options,...extra});}};
}
function child(code,args=[]){const result=spawnSync(process.execPath,['--input-type=module','-e',code,...args],{encoding:'utf8',windowsHide:true,timeout:15000});assert.ifError(result.error);assert.equal(result.signal,null);return result;}

test('shared CAS stores exact empty, Unicode and binary bytes and cold reopens native private objects',native,async t=>{
 const f=await fixture(t);for(const bytes of [Buffer.alloc(0),Buffer.from('未发送材料\r\n正文'),Buffer.from([0,255,42])]){
  const ref=await f.store.put(bytes);assert.deepEqual(ref,{digest:digestBytes(bytes),byteLength:bytes.length});assert.deepEqual(await f.cold().get(ref.digest),bytes);assert.deepEqual(await f.cold().verify(ref.digest),ref);
 }
 assert.equal(f.store.qualification.productionSelected,false);assert.equal(f.store.qualification.durability,'namespace-not-qualified');
});

test('input is frozen before asynchronous native work and historical content identifiers remain readable',native,async t=>{
 const f=await fixture(t),bytes=Buffer.from('original'),pending=f.store.put(bytes);bytes.fill(120);const before=await pending,next=await f.store.put(Buffer.from('after'));
 assert.notEqual(before.digest,next.digest);assert.equal((await f.store.get(before.digest)).toString(),'original');assert.equal((await f.store.get(next.digest)).toString(),'after');
});

test('twelve concurrent publishers and readers converge without replacing or leaving pending files',native,async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(512*1024,157),refs=await Promise.all(Array.from({length:12},()=>f.cold().put(bytes)));
 assert.equal(new Set(refs.map(row=>row.digest)).size,1);assert.deepEqual(await fs.readdir(f.directory),[refs[0].digest]);
 const reads=await Promise.all(Array.from({length:12},()=>f.cold().get(refs[0].digest)));for(const read of reads)assert.deepEqual(read,bytes);
});

test('a held fixed read HANDLE admits independent readers while denying data writes, unlink and ancestor rename',native,async t=>{
 const f=await fixture(t),ref=await f.store.put(Buffer.from('original'));
 await f.store.withObject(ref.digest,async file=>{
  assert.match(file.stat.identity,/^[a-f0-9]{16}:[a-f0-9]{32}$/);
  const result=child(`import fs from 'node:fs';let denied=0;for(const run of [()=>fs.writeFileSync(process.argv[1],'changed'),()=>fs.unlinkSync(process.argv[1]),()=>fs.renameSync(process.argv[2],process.argv[2]+'-moved')])try{run();}catch{denied++;}console.log(denied);`,[f.store.location(ref.digest),f.directory]);
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'3');assert.equal((await f.cold().get(ref.digest)).toString(),'original');
  const parts=[];for await(const part of file.stream())parts.push(part);assert.equal(Buffer.concat(parts).toString(),'original');
 });
 await fs.rename(f.directory,f.directory+'-released');
});

test('native read-only object leases cannot flush or delete but compatible same-object readers coexist',native,async t=>{
 const f=await fixture(t),ref=await f.store.put(Buffer.from('data')),parent=f.hold(open(f.root,'材料 空格/sha256/anchor')),a=f.hold(parent.openPrivateObjectRead(ref.digest)),b=f.hold(parent.openPrivateObjectRead(ref.digest));
 assert.equal(a.readAt(0,4).toString(),'data');assert.equal(b.stat().identity,a.stat().identity);assert.throws(()=>a.sync(),{code:'FS_HANDLE_REJECTED'});assert.throws(()=>a.remove(),{code:'FS_HANDLE_REJECTED'});
});

test('read-only file attributes allow fixed-HANDLE reads without granting object write access',native,async t=>{
 const f=await fixture(t),bytes=Buffer.from('readonly immutable material'),ref=await f.store.put(bytes),file=f.store.location(ref.digest);await fs.chmod(file,0o400);
 try{assert.deepEqual(await f.cold().get(ref.digest),bytes);assert.deepEqual(await f.cold().verify(ref.digest),ref);}finally{await fs.chmod(file,0o600);}
});

test('large streaming imports, bounded gets and repeated streams share one verified object without whole-object buffering',native,async t=>{
 const f=await fixture(t,{maxBytes:4}),chunk=Buffer.alloc(256*1024,37),count=129;
 const ref=await f.store.putStream((async function*(){for(let index=0;index<count;index++)yield chunk;})());
 assert.equal(ref.byteLength,chunk.length*count);await assert.rejects(f.store.get(ref.digest),{code:'MATERIAL_TOO_LARGE'});assert.deepEqual(await f.store.verify(ref.digest),ref);
 const copy=new MaterialStore(path.join(f.root,'copy'),{experimentalWindowsRoot:f.root,maxBytes:4});
 assert.deepEqual(await f.store.withObject(ref.digest,file=>copy.putStream(file.stream(),{digest:ref.digest})),ref);assert.deepEqual(await copy.verify(ref.digest),ref);
});

test('digest mismatches and producer failures discard only the owned pending HANDLE and preserve old references',native,async t=>{
 const f=await fixture(t),ref=await f.store.put(Buffer.from('original'));
 await assert.rejects(f.store.putStream([Buffer.from('wrong')],{digest:ref.digest}),{code:'MATERIAL_CORRUPT'});
 await assert.rejects(f.store.putStream((async function*(){yield Buffer.from('partial');throw Error('producer stopped');})()),/producer stopped/);
 assert.deepEqual(await fs.readdir(f.directory),[ref.digest]);assert.equal((await f.store.get(ref.digest)).toString(),'original');
});

test('corrupt existing digest winners are retained without repair or replacement',native,async t=>{
 const f=await fixture(t),bytes=Buffer.from('valid'),ref=await f.store.put(bytes);await fs.writeFile(f.store.location(ref.digest),'corrupt');const before=await fs.stat(f.store.location(ref.digest),{bigint:true});
 await assert.rejects(f.store.get(ref.digest),{code:'MATERIAL_CORRUPT'});await assert.rejects(f.store.put(bytes),{code:'MATERIAL_CORRUPT'});
 assert.equal(await fs.readFile(f.store.location(ref.digest),'utf8'),'corrupt');assert.equal((await fs.stat(f.store.location(ref.digest),{bigint:true})).ino,before.ino);assert.deepEqual(await fs.readdir(f.directory),[ref.digest]);
});

test('directory digest winners and junction directories are refused without modifying external content',native,async t=>{
 const f=await fixture(t),bytes=Buffer.from('content'),digest=digestBytes(bytes);await f.store.ensureDirectory();await fs.mkdir(f.store.location(digest));
 await assert.rejects(f.store.put(bytes));assert.equal((await fs.stat(f.store.location(digest))).isDirectory(),true);assert.deepEqual(await fs.readdir(f.directory),[digest]);
 const outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'keep'),'external');await fs.symlink(outside,path.join(f.root,'junction'),'junction');
 const linked=new MaterialStore(path.join(f.root,'junction','sha256'),{experimentalWindowsRoot:f.root});await assert.rejects(linked.put(bytes),{code:'FS_REPARSE_REJECTED'});assert.deepEqual(await fs.readdir(outside),['keep']);
});

test('object hard links are rejected and the external alias bytes and identity survive a duplicate put',native,async t=>{
 const f=await fixture(t),bytes=Buffer.from('linked'),ref=await f.store.put(bytes),alias=path.join(f.root,'alias');await fs.link(f.store.location(ref.digest),alias);
 await assert.rejects(f.store.get(ref.digest),{code:'FS_ENTRY_REJECTED'});await assert.rejects(f.store.put(bytes),{code:'FS_ENTRY_REJECTED'});assert.equal(await fs.readFile(alias,'utf8'),'linked');assert.equal((await fs.stat(alias)).nlink,2);
});

test('broad object and object-directory ACLs are refused without permission repair',native,async t=>{
 const f=await fixture(t),ref=await f.store.put(Buffer.from('retained'));security('add-write',f.store.location(ref.digest));const before=security('inspect',f.store.location(ref.digest));
 await assert.rejects(f.store.get(ref.digest),{code:'FS_SECURITY_CHANGED'});assert.deepEqual(security('inspect',f.store.location(ref.digest)),before);
 security('add-write',f.directory);const directoryAcl=security('inspect',f.directory);await assert.rejects(f.store.put(Buffer.from('new')),{code:'FS_SECURITY_CHANGED'});assert.deepEqual(security('inspect',f.directory),directoryAcl);assert.deepEqual(await fs.readdir(f.directory),[ref.digest]);
});

test('ACL drift during a callback fails final verification and releases the actual read pins',native,async t=>{
 const f=await fixture(t),ref=await f.store.put(Buffer.from('retained'));
 await assert.rejects(f.store.withObject(ref.digest,async()=>{security('add-write',f.store.location(ref.digest));}),{code:'FS_STAGE_CHANGED'});
 await fs.rename(f.directory,f.directory+'-released');assert.equal(await fs.readFile(path.join(f.directory+'-released',ref.digest),'utf8'),'retained');
});

test('private parent ACL drift during streaming refuses publication and preserves all independent bytes',native,async t=>{
 const f=await fixture(t),bytes=Buffer.from('candidate'),digest=digestBytes(bytes);await f.store.ensureDirectory();await fs.writeFile(path.join(f.directory,'external'),'retained');
 await assert.rejects(f.store.putStream((async function*(){yield bytes;security('add-write',f.directory);})()),{code:'FS_STAGE_CHANGED'});
 assert.equal(await fs.readFile(path.join(f.directory,'external'),'utf8'),'retained');await assert.rejects(fs.lstat(f.store.location(digest)),{code:'ENOENT'});assert.deepEqual(await fs.readdir(f.directory),['external']);
});

test('missing material, invalid references and disabled directory creation fail without creating parents',native,async t=>{
 const f=await fixture(t,{createDirectory:false});await assert.rejects(f.store.get('a'.repeat(64)),{code:'MATERIAL_MISSING'});await assert.rejects(f.store.put(Buffer.from('new')));assert.deepEqual(await fs.readdir(f.root),[]);
 for(const digest of ['../private','A'.repeat(64),'',null])await assert.rejects(f.store.get(digest),{code:'INVALID_DIGEST'});
 assert.throws(()=>new MaterialStore(path.join(f.root,'..','escape'),{experimentalWindowsRoot:f.root}),{code:'FS_PATH_REJECTED'});
});

test('callback failure and early stream cancellation release leases and escaped streams cannot read after return',native,async t=>{
 const f=await fixture(t),ref=await f.store.put(Buffer.alloc(1024*1024,0x61));let escaped;
 await f.store.withObject(ref.digest,async file=>{escaped=file.stream();for await(const chunk of file.stream()){assert.ok(chunk.length>0);break;}});
 await assert.rejects(async()=>{for await(const _chunk of escaped){}},{code:'FS_HANDLE_CLOSED'});
 await assert.rejects(f.store.withObject(ref.digest,()=>{throw Error('consumer stopped');}),/consumer stopped/);await fs.rename(f.directory,f.directory+'-released');
});

test('mutable streaming chunks are copied before asynchronous native writes',native,async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(600*1024,0x41),expected=digestBytes(bytes);
 const ref=await f.store.putStream((async function*(){setImmediate(()=>bytes.fill(0x42));yield bytes;})(),{digest:expected});assert.equal(ref.digest,expected);assert.equal((await f.store.get(ref.digest))[bytes.length-1],0x41);
});

test('an actual closed parent after publication reports committed uncertainty and retains the cold-verifiable object',native,async t=>{
 const f=await fixture(t),original=f.store.io,bytes=Buffer.from('published despite barrier failure'),digest=digestBytes(bytes);
 f.store.io={...original,async createStage(){const stage=await original.createStage();return {...stage,async syncDirectory(){stage.close();stage.syncDirectory();}};}};
 await assert.rejects(f.store.put(bytes),error=>{assert.equal(error.code,'FS_HANDLE_CLOSED');assert.equal(error.committed,true);assert.equal(error.durability,'uncertain');assert.deepEqual({digest:error.materialPublication.digest,byteLength:error.materialPublication.byteLength,published:error.materialPublication.published},{digest,byteLength:bytes.length,published:true});assert.match(error.materialPublication.stage.identity,/^[a-f0-9]{16}:[a-f0-9]{32}$/);return true;});assert.deepEqual(await f.cold().get(digest),bytes);assert.deepEqual(await fs.readdir(f.directory),[digest]);
});

test('shared ProjectStorage object methods cold reopen and promote offline recovery bytes with the same digest',native,async t=>{
 const f=await fixture(t),root=path.join(f.root,'项目 空格');await fs.mkdir(root);const profile=path.join(f.root,'profile'),options={experimentalWindowsRoot:f.root,experimentalWindowsInitialization:true},storage=f.hold(new ProjectStorage(profile,options)),project=await storage.register(root);
 const a=await storage.putObject(project.id,Buffer.from('project material')),b=await storage.putRecoveryObject(project.id,Buffer.from('offline recovery'));
 assert.deepEqual(await storage.verifyObject(project.id,a.digest),a);assert.deepEqual(await storage.promoteRecoveryObject(project.id,b.digest),b);assert.equal((await storage.readObject(project.id,b.digest)).toString(),'offline recovery');await storage.db.close();
 const cold=f.hold(new ProjectStorage(profile,options)),reopened=await cold.register(root);assert.equal(reopened.id,project.id);assert.equal((await cold.readObject(project.id,a.digest)).toString(),'project material');
 await cold.closeProjectHandles(project.id);await fs.rename(root,root+'-offline');await assert.rejects(cold.readObject(project.id,a.digest));assert.equal((await cold.readRecoveryObject(project.id,b.digest)).toString(),'offline recovery');assert.deepEqual(await cold.withRecoveryObject(project.id,b.digest,file=>({digest:b.digest,byteLength:file.stat.size})),b);
});

test('an independent process publishes the winning object while the original stream is still staged',native,async t=>{
 const f=await fixture(t),bytes=Buffer.from('same independently published material');let winner;
 const ref=await f.store.putStream((async function*(){yield bytes;const result=child(`import {MaterialStore} from ${JSON.stringify(new URL('../src/domain/material-store.mjs',import.meta.url).href)};const store=new MaterialStore(process.argv[2],{experimentalWindowsRoot:process.argv[1]});console.log(JSON.stringify(await store.put(Buffer.from(process.argv[3],'base64'))));`,[f.root,f.directory,bytes.toString('base64')]);assert.equal(result.status,0,result.stderr);winner=JSON.parse(result.stdout);})());
 assert.deepEqual(ref,winner);assert.deepEqual(await fs.readdir(f.directory),[ref.digest]);assert.deepEqual(await f.store.get(ref.digest),bytes);
});

for(const checkpoint of ['staged','published'])test(`actual host exit at ${checkpoint} retains exact recovery facts without deleting or adopting unknown pending files`,native,async t=>{
 const f=await fixture(t),bytes=Buffer.from('abrupt synthetic material'),digest=digestBytes(bytes);
 const result=child(`import {MaterialStore} from ${JSON.stringify(new URL('../src/domain/material-store.mjs',import.meta.url).href)};
 const store=new MaterialStore(process.argv[2],{experimentalWindowsRoot:process.argv[1]}),io=store.io,checkpoint=process.argv[3];
 store.io={...io,async createStage(){const stage=await io.createStage();return {...stage,sync(){stage.sync();if(checkpoint==='staged')process.exit(81);},publish(digest){const published=stage.publish(digest);if(checkpoint==='published')process.exit(82);return published;}};}};
 await store.put(Buffer.from(process.argv[4],'base64'));`,[f.root,f.directory,checkpoint,bytes.toString('base64')]);
 assert.equal(result.status,checkpoint==='staged'?81:82,result.stderr);const before=await fs.readdir(f.directory);
 if(checkpoint==='staged'){
  assert.equal(before.length,1);assert.match(before[0],/^\.pending-/);assert.deepEqual(await fs.readFile(path.join(f.directory,before[0])),bytes);await assert.rejects(f.cold().get(digest),{code:'MATERIAL_MISSING'});
  assert.deepEqual(await f.cold().put(bytes),{digest,byteLength:bytes.length});assert.deepEqual((await fs.readdir(f.directory)).sort(),[...before,digest].sort());assert.deepEqual(await fs.readFile(path.join(f.directory,before[0])),bytes);
 }else{assert.deepEqual(before,[digest]);assert.deepEqual(await f.cold().get(digest),bytes);}
});
