import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {ensureExperimentalPrivateDirectory as ensure} from '../src/platform/windows/experimental-directories.mjs';
import {openExperimentalPersistenceParent as open} from '../src/platform/windows/experimental-persistence.mjs';
import {StorageDatabase} from '../src/main/storage-database.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {security} from './fixtures/windows-security.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-directories-')),resources=[];
 t.after(async()=>{for(const resource of resources.reverse())await resource.close();await fs.rm(root,{recursive:true,force:true});});
 return {root,file:rel=>path.join(root,rel),hold(resource){resources.push(resource);return resource;}};
}
function child(code,args=[]){const result=spawnSync(process.execPath,['--input-type=module','-e',code,...args],{encoding:'utf8',windowsHide:true,timeout:10000});assert.ifError(result.error);assert.equal(result.signal,null);return result;}

test('nested private directory HANDLEs retain identity/security after their JS parents close and block independent ancestor rename',native,async t=>{
 const f=await fixture(t),root=f.hold(open(f.root,'anchor')),first=f.hold(root.openPrivateDirectory('private',true)),second=f.hold(first.openPrivateDirectory('child',true));
 assert.equal(first.created,true);assert.equal(second.created,true);const id=second.identity();assert.match(id,/^[a-f0-9]{16}:[a-f0-9]{32}$/);
 root.close();first.close();second.verify();second.syncDirectory();assert.equal(second.identity(),id);
 assert.throws(()=>second.openPrivateDirectory('missing',false),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===2);
 const contender=child(`import fs from 'node:fs';try{fs.renameSync(process.argv[1],process.argv[1]+'-moved');}catch(e){console.log(e.code);process.exitCode=7;}`,[f.file('private')]);
 assert.equal(contender.status,7,contender.stderr);assert.match(contender.stdout,/EPERM|EACCES|EBUSY|UNKNOWN/);
 assert.throws(()=>second.openPrivateDirectory.call({},'bad',true),{code:'FS_HANDLE_REJECTED'});
 second.close();await fs.rename(f.file('private'),f.file('released'));assert.throws(()=>second.identity(),{code:'FS_HANDLE_CLOSED'});
});

test('tree provisioning creates protected private components, flushes edges and retries idempotently with the same identities',native,async t=>{
 const f=await fixture(t),directory=f.file('中文 空格/state/recovery');
 const first=await ensure(f.root,directory);assert.equal(first.createdDirectories.length,3);assert.equal(first.state,'barriers-completed');assert.equal(first.durability,'namespace-not-qualified');
 for(const created of first.createdDirectories){const acl=security('inspect',f.file(created.relative));assert.equal(acl.protected,true);assert.equal(acl.owner,acl.currentSid);assert.equal(acl.rules.length,1);assert.equal(acl.rules[0].sid,acl.currentSid);}
 const second=await ensure(f.root,directory);assert.deepEqual(second.createdDirectories,[]);assert.equal(second.identity,first.identity);
 const database=f.hold(new StorageDatabase({experimentalWindowsRoot:f.root})),file=path.join(directory,'recovery.sqlite');
 await database.request(file,'put',{collection:'drafts',id:'draft',value:'未发送'});assert.equal(await database.request(file,'get',{collection:'drafts',id:'draft'}),'未发送');
});

test('the complete private path plan is refused before effects for traversal, DOS aliases and invalid later components',native,async t=>{
 const f=await fixture(t);
 for(const directory of [f.root,path.join(f.root,'..','escape'),f.file('new/late.'),f.file('new/ALIAS~1'),f.file('new/ＮＵＬ.txt'),f.file('new/a:b'),f.root+'\\new\\..\\other',f.file(Array(129).fill('a').join('/'))])await assert.rejects(ensure(f.root,directory),{code:'FS_PATH_REJECTED'});
 assert.deepEqual(await fs.readdir(f.root),[]);
});

test('existing broad directories, files and junctions are preserved without permission repair or traversal',native,async t=>{
 const f=await fixture(t);await fs.mkdir(f.file('broad'));await fs.writeFile(f.file('file'),'external winner');await fs.mkdir(f.file('external'));await fs.writeFile(f.file('external/keep'),'outside');await fs.symlink(f.file('external'),f.file('junction'),'junction');
 const before=security('inspect',f.file('broad'));
 await assert.rejects(ensure(f.root,f.file('broad/child')),{code:'FS_SECURITY_CHANGED'});
 await assert.rejects(ensure(f.root,f.file('file/child')));
 await assert.rejects(ensure(f.root,f.file('junction/child')),{code:'FS_REPARSE_REJECTED'});
 assert.deepEqual(security('inspect',f.file('broad')),before);assert.equal(await fs.readFile(f.file('file'),'utf8'),'external winner');assert.deepEqual(await fs.readdir(f.file('external')),['keep']);
});

test('a private-ancestor ACL change is detected through a descendant that retains the whole chain',native,async t=>{
 const f=await fixture(t),root=f.hold(open(f.root,'anchor')),first=f.hold(root.openPrivateDirectory('private',true)),second=f.hold(first.openPrivateDirectory('child',true));
 root.close();first.close();security('add-write',f.file('private'));
 assert.throws(()=>second.verify(),{code:'FS_STAGE_CHANGED'});assert.throws(()=>second.openPrivateDirectory('must-not-exist',true),{code:'FS_STAGE_CHANGED'});
 assert.deepEqual(await fs.readdir(f.file('private/child')),[]);
});

test('a real postcreation closed-handle barrier fault retains created identities and leaves a retryable private directory',native,async t=>{
 const f=await fixture(t);let failure;
 try{await ensure(f.root,f.file('private/child'),{directorySync:parent=>{parent.close();parent.syncDirectory();}});}catch(error){failure=error;}
 assert.equal(failure.code,'FS_HANDLE_CLOSED');assert.equal(failure.committed,true);assert.equal(failure.durability,'uncertain');assert.equal(failure.createdDirectories.length,1);
 const retry=await ensure(f.root,f.file('private/child'));assert.equal(retry.createdDirectories.length,1);assert.equal(retry.createdDirectories[0].relative,'private/child');
 const first=f.hold(open(f.root,'private/anchor'));assert.equal(first.identity(),failure.createdDirectories[0].identity);
});

test('a later broad-component conflict preserves both the created prefix and all external contents',native,async t=>{
 const f=await fixture(t);let injected=false;
 await assert.rejects(ensure(f.root,f.file('private/child'),{directorySync:async parent=>{parent.syncDirectory();if(!injected){injected=true;await fs.mkdir(f.file('private/child'));await fs.writeFile(f.file('private/child/keep'),'external');}}}),error=>error.code==='FS_SECURITY_CHANGED'&&error.committed===true&&error.createdDirectories.length===1);
 assert.equal(await fs.readFile(f.file('private/child/keep'),'utf8'),'external');
});

test('abort before effects and between components never removes previously created private directories',native,async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort();
 await assert.rejects(ensure(f.root,f.file('none'),{signal:controller.signal}),{code:'ABORT_ERR'});assert.deepEqual(await fs.readdir(f.root),[]);
 const during=new AbortController();await assert.rejects(ensure(f.root,f.file('private/child'),{signal:during.signal,directorySync:parent=>{parent.syncDirectory();during.abort();}}),error=>error.code==='ABORT_ERR'&&error.committed===true&&error.createdDirectories.length===1);
 assert.deepEqual(await fs.readdir(f.root),['private']);assert.deepEqual(await fs.readdir(f.file('private')),[]);
 await assert.rejects(ensure(f.root,f.file('other'),{directorySync:()=>{throw null;}}),error=>error.code==='FS_DIRECTORY_FAILED'&&error.cause===null&&error.committed===true);
});

test('ProjectStorage.ready creates its actual private catalog tree and cold-reopens lifecycle facts without registration',native,async t=>{
 const f=await fixture(t),profile=f.file('profile'),storage=new ProjectStorage(profile,{experimentalWindowsRoot:f.root});f.hold({close:()=>storage.db.close()});
 await storage.ready();assert.deepEqual(await storage.list(),[]);
 await storage.db.request(storage.catalog,'put',{collection:'lifecycle_holds',id:'synthetic',value:{operationId:'op',instanceId:'instance',action:'stop'}});
 await storage.db.close();
 const cold=new ProjectStorage(profile,{experimentalWindowsRoot:f.root});f.hold({close:()=>cold.db.close()});await cold.ready();
 assert.equal(cold.lifecycleHolds.get('synthetic').operationId,'op');assert.equal(cold.lifecycleHolds.get('synthetic').needsStopCheck,true);
 const acl=security('inspect',cold.root);assert.equal(acl.protected,true);assert.equal(acl.rules.length,1);
 const project=f.file('project');await fs.mkdir(project);await assert.rejects(cold.register(project),{code:'PERSISTENCE_UNSUPPORTED'});assert.deepEqual(await fs.readdir(project),[]);
});

test('shared offline local/recovery methods use real private directories and SQLite while retaining draft isolation across reopen',native,async t=>{
 const f=await fixture(t),profile=f.file('profile'),storage=new ProjectStorage(profile,{experimentalWindowsRoot:f.root});f.hold({close:()=>storage.db.close()});await storage.ready();
 // A persisted catalog binding represents an already registered, offline
 // synthetic instance. This does not claim registration/initialize passed.
 await storage.db.request(storage.catalog,'put',{collection:'instances',id:'synthetic',value:{id:'synthetic',instanceId:'instance'}});
 await storage.putLocal('synthetic','layout',{pane:'source'});await storage.putRecovery('synthetic','draft','未发送内容');
 await storage.db.close();const cold=new ProjectStorage(profile,{experimentalWindowsRoot:f.root});f.hold({close:()=>cold.db.close()});
 assert.deepEqual(await cold.getLocal('synthetic','layout'),{pane:'source'});assert.equal(await cold.getRecovery('synthetic','draft'),'未发送内容');
 for(const directory of [path.join(cold.root,'instances','instance'),path.join(cold.root,'recovery','instance')])assert.equal(security('inspect',directory).protected,true);
});

test('ProjectStorage refuses a broad existing profile and a configured root escape before catalog writes',native,async t=>{
 const f=await fixture(t),profile=f.file('profile');await fs.mkdir(profile);
 const storage=new ProjectStorage(profile,{experimentalWindowsRoot:f.root});f.hold({close:()=>storage.db.close()});await assert.rejects(storage.ready(),{code:'FS_SECURITY_CHANGED'});assert.deepEqual(await fs.readdir(profile),[]);
 const escaped=new ProjectStorage(path.join(f.root,'..','outside-profile'),{experimentalWindowsRoot:f.root});f.hold({close:()=>escaped.db.close()});await assert.rejects(escaped.ready(),{code:'FS_PATH_REJECTED'});
});

test('two independent processes provision the same private tree without replacing identities or granting broader ACLs',native,async t=>{
 const f=await fixture(t),directory=f.file('private/child/recovery'),loader=new URL('../src/platform/windows/experimental-directories.mjs',import.meta.url).href;
 const processes=[0,1].map(()=>{
  const process=spawn(globalThis.process.execPath,['--input-type=module','-e',`
   import {once} from 'node:events';import {ensureExperimentalPrivateDirectory as ensure} from ${JSON.stringify(loader)};
   process.send('ready');await once(process,'message');
   try{console.log(JSON.stringify(await ensure(process.argv[1],process.argv[2])));}finally{process.disconnect();}`,f.root,directory],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  let stdout='',stderr='';process.stdout.on('data',chunk=>{stdout+=chunk;});process.stderr.on('data',chunk=>{stderr+=chunk;});
  const ready=once(process,'message'),exited=once(process,'exit');
  const timer=setTimeout(()=>process.kill(),10000);
  f.hold({async close(){clearTimeout(timer);if(process.exitCode===null&&process.signalCode===null){process.kill();await exited;}}});
  return {process,ready,exited,result:()=>({stdout,stderr})};
 });
 await Promise.all(processes.map(row=>row.ready));for(const row of processes)row.process.send('go');
 const exits=await Promise.all(processes.map(row=>row.exited));for(let i=0;i<exits.length;i++)assert.equal(exits[i][0],0,processes[i].result().stderr);
 const results=processes.map(row=>JSON.parse(row.result().stdout));assert.equal(results[0].identity,results[1].identity);
 assert.equal(results.reduce((count,row)=>count+row.createdDirectories.length,0),3);
 assert.equal(security('inspect',directory).rules.length,1);assert.deepEqual(await fs.readdir(directory),[]);
});
