import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import requireFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {processInfo,processQuery} from '../src/platform/process-query.mjs';
import {reapGroup,captureDirectChild} from '../src/platform/owned-processes.mjs';
import {withSafeFile,safeRelativePath} from '../src/agents/managed/file-stream.mjs';
import {assertUniqueTargets} from '../src/platform/filename-policy.mjs';
import {assertRecoverySourceStopped} from '../src/main/project-recovery-owner.mjs';
import {isolatedLaunch,optionalIsolatedLaunch} from '../src/agents/managed/process-isolation.mjs';
const mac={skip:process.platform!=='darwin'};
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-platform-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('reserved directory variants cannot enter managed material paths',()=>{for(const name of ['.GIT/config','.Nozeli/state.json','NODE_MODULES/pkg/a','.CcB/config'])assert.throws(()=>safeRelativePath(name),{code:'PATH_REJECTED'});});
test('APFS rejects case, Unicode and ancestor aliases before targets are written',mac,async t=>{
 const root=await fixture(t);
 for(const names of [['A.txt','a.txt'],['caf\u00e9.txt','cafe\u0301.txt'],['Dir/a','dir/b'],['file','file/child']])await assert.rejects(assertUniqueTargets(root,names),e=>['TARGET_NAME_CONFLICT','ENOTDIR'].includes(e.code));
 assert.deepEqual(await fs.readdir(root),['.nozeli']);
 await fs.writeFile(path.join(root,'Existing.txt'),'untouched');await assert.rejects(assertUniqueTargets(root,['existing.txt']),{code:'PATH_ALIAS'});assert.equal(await fs.readFile(path.join(root,'Existing.txt'),'utf8'),'untouched');
 await assertUniqueTargets(root,Array.from({length:1200},(_,i)=>'shared/sub/f'+i));assert.deepEqual((await fs.readdir(root)).sort(),['.nozeli','Existing.txt']);
});
test('safe reads reject links, hard links, ancestor swaps and in-place changes',mac,async t=>{
 const root=await fixture(t);await fs.mkdir(path.join(root,'dir'));await fs.writeFile(path.join(root,'dir/a'),'original');
 await fs.symlink('dir/a',path.join(root,'link'));await assert.rejects(withSafeFile(root,'link',()=>{}));
 await fs.link(path.join(root,'dir/a'),path.join(root,'hard'));await assert.rejects(withSafeFile(root,'hard',()=>{}),{code:'PATH_REJECTED'});await fs.unlink(path.join(root,'hard'));
 await assert.rejects(withSafeFile(root,'dir/a',async()=>{await fs.rename(path.join(root,'dir'),path.join(root,'old'));await fs.mkdir(path.join(root,'dir'));await fs.writeFile(path.join(root,'dir/a'),'other');}),{code:'SOURCE_CHANGED'});
 await assert.rejects(withSafeFile(root,'dir/a',()=>fs.writeFile(path.join(root,'dir/a'),'changed')),{code:'SOURCE_CHANGED'});
});
test('kernel query preserves argument/environment boundaries and detects exit',mac,async t=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','','two words','x=y'],{detached:true,env:{PATH:process.env.PATH,NOZELI_PROCESS_FIXTURE:'two words = value',NOZELI_EMPTY:''},stdio:'ignore'});
 t.after(()=>{try{child.kill('SIGKILL');}catch{}});await once(child,'spawn');
 const info=await processInfo(child.pid,{full:true});assert.deepEqual(info.argv.slice(-3),['','two words','x=y']);assert(info.environ.includes('NOZELI_PROCESS_FIXTURE=two words = value'));assert(info.environ.includes('NOZELI_EMPTY='));assert.equal(info.pgid,child.pid);assert.match(info.stamp,/^darwin:[\w-]+:\d+:\d+$/);
 child.kill('SIGTERM');await once(child,'exit');assert.equal(await processInfo(child.pid),null);
});
test('reaper confirms orphan descendants after the group leader exits',mac,async t=>{
 const root=await fixture(t);const code=`const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(p.pid);setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['-e',code],{detached:true,env:{PATH:process.env.PATH,NOZELI_AGENT_DIR:root},stdio:['ignore','pipe','ignore']});
 t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 const descendant=Number((await once(child.stdout,'data'))[0].toString().trim()),leader=await processInfo(child.pid);
 child.kill('SIGTERM');await once(child,'exit');assert(await processInfo(descendant));
 const result=await reapGroup({pid:child.pid,home:root,stamp:leader.stamp},['NOZELI_AGENT_DIR']);assert.equal(result.verified,true);assert.equal(result.descendantsReaped,1);
 for(let i=0;i<20&&await processInfo(descendant);i++)await pause(20);assert.equal(await processInfo(descendant),null);
});
test('uncertain scan and PID reuse never authorize signalling',mac,async()=>{
 const record={pid:12345,home:'/synthetic',stamp:'darwin:00000000-0000-0000-0000-000000000000:1:1'};let signals=0;
 const query={...processQuery,sameBoot:async()=>true,processInfo:async()=>null,listUserProcesses:async()=>{throw Object.assign(Error('synthetic denied scan'),{code:'EACCES'});}};
 await assert.rejects(reapGroup(record,['NOZELI_AGENT_DIR'],{query,signal:()=>signals++}),{code:'EACCES'});
 query.processInfo=async()=>({stamp:record.stamp+'1',pgid:record.pid});await assert.rejects(reapGroup(record,['NOZELI_AGENT_DIR'],{query,signal:()=>signals++}),/reused/);assert.equal(signals,0);
 query.sameBoot=async()=>false;assert.equal((await reapGroup(record,[],{query})).reason,'previous-boot');
 assert.equal((await reapGroup({...record,stamp:'old-unknown-format'},[],{query})).verified,false);
});
test('macOS ordinary execution remains available while isolation and special recovery refuse',mac,async()=>{
 const spec={command:'/usr/bin/true',args:[],cwd:'/tmp',home:'/tmp/nozeli-synthetic'};assert.equal((await optionalIsolatedLaunch(spec)).isolated,false);
 await assert.rejects(optionalIsolatedLaunch(spec,{probe:async()=>true}),/尚未/);await assert.rejects(isolatedLaunch(spec),/尚未/);
 await assert.rejects(assertRecoverySourceStopped('/synthetic'),{code:'RECOVERY_OWNER_UNVERIFIED'});
});

test('cleanup preserves a substituted directory and its user files',mac,async t=>{
 const {platformNative}=await import('../src/platform/native.mjs');const native=platformNative(),original=native.statAt;
 const root=await fixture(t);let swapped=false,originalName;
 t.mock.method(native,'statAt',function(fd,name){
  if(!swapped&&name==='file'){
   const names=requireFs.readdirSync(root);originalName=names.find(n=>n.startsWith('.nozeli-names-'));if(originalName){swapped=true;requireFs.renameSync(path.join(root,originalName),path.join(root,'retained-probe'));requireFs.mkdirSync(path.join(root,originalName));requireFs.writeFileSync(path.join(root,originalName,'user.txt'),'keep');}
  }
  return original.call(this,fd,name);
 });
 await assert.rejects(assertUniqueTargets(root,['file']),{code:'SOURCE_CHANGED'});assert.equal(await fs.readFile(path.join(root,originalName,'user.txt'),'utf8'),'keep');
});
test('publication preserves the concurrent edit and review candidate on the last rename race',mac,async t=>{
 const {platformNative}=await import('../src/platform/native.mjs');const {entry,openDirectoryChain}=await import('../src/platform/directory-fs.mjs');const {publishFileAt,deleteFileAt}=await import('../src/platform/file-publication.mjs');const {createHash}=await import('node:crypto');
 const root=await fixture(t),dir=await openDirectoryChain(root);t.after(()=>dir.close());
 await fs.writeFile(path.join(root,'file'),'baseline');await fs.writeFile(path.join(root,'candidate'),'reviewed');const digest=createHash('sha256').update('baseline').digest('hex');
 const native=platformNative(),rename=native.renameAt;let changed=false;
 t.mock.method(native,'renameAt',function(fromFd,from,toFd,to,mode){if(!changed&&to==='file'&&mode===2){changed=true;requireFs.writeFileSync(path.join(root,'file'),'concurrent user edit');}return rename.call(this,fromFd,from,toFd,to,mode);});
 await assert.rejects(publishFileAt(entry(dir.directory.fd,'candidate'),entry(dir.directory.fd,'file'),{expectedDigest:digest}),e=>e.code==='SOURCE_CHANGED'&&e.retainTemp);
 assert.equal(await fs.readFile(path.join(root,'file'),'utf8'),'concurrent user edit');assert.equal(await fs.readFile(path.join(root,'candidate'),'utf8'),'reviewed');
 await assert.rejects(deleteFileAt(entry(dir.directory.fd,'file'),{expectedDigest:digest}),{code:'SOURCE_CHANGED'});assert.equal(await fs.readFile(path.join(root,'file'),'utf8'),'concurrent user edit');
});

test('kernel query retains an empty argv zero without consuming environment entries',mac,async t=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{argv0:'',env:{NOZELI_QUERY_FIXTURE:'exact value'},stdio:'ignore'});
 t.after(()=>{try{child.kill('SIGKILL');}catch{}});await once(child,'spawn');
 const info=await processInfo(child.pid,{full:true});assert.deepEqual(info.argv,['','-e','setInterval(()=>{},1000)']);assert.deepEqual(info.environ,['NOZELI_QUERY_FIXTURE=exact value']);
});
test('Worker identity validation accepts this platform stamp',mac,async()=>{
 const {Controller}=await import('../src/agents/managed/controller.mjs');const info=await processInfo(process.pid);
 const context={starting:new Map(),sessions:new Map(),projectId:'synthetic',store:{find:()=>({revision:0}),state:{providers:{w:{pid:process.pid,stamp:info.stamp,home:'/synthetic'}}},agentHome:()=>'/synthetic'},execution:{serial:new Map(),readManifest:async()=>null}};
 await Controller.prototype.validateLocalIdentity.call(context,'w');
});

test('explicit isolation refuses at the real session entry before spawning',mac,async()=>{
 const {OmpTuiSession}=await import('../src/agents/managed/omp-tui-session.mjs');let spawned=false;
 const session=new OmpTuiSession({home:'/synthetic',cwd:'/synthetic',role:'frontdesk',isolation:{},tuiSpawn:{spawn:async()=>{spawned=true;throw Error('must not spawn');}}});
 await assert.rejects(session.start(),{code:'ISOLATION_UNAVAILABLE'});assert.equal(spawned,false);
});

test('interrupted swap recovery never deletes an unverified displaced user edit',mac,async t=>{
 const {ExecutionWorkspace}=await import('../src/agents/managed/execution-workspace.mjs');const {createHash}=await import('node:crypto');const digest=s=>createHash('sha256').update(s).digest('hex');
 const directory=await fixture(t);await fs.writeFile(path.join(directory,'file'),'candidate');await fs.writeFile(path.join(directory,'temporary'),'concurrent user edit');
 const manifest={directory,documentIntent:{callId:'synthetic',temp:path.join(directory,'temporary'),value:{relPath:'file',beforeDigest:digest('before'),digest:digest('candidate')}}};let saved=false;
 await assert.rejects(ExecutionWorkspace.prototype.reconcileDocument.call({save:async()=>{saved=true;}},manifest),{code:'DOCUMENT_RECOVERY'});
 assert.equal(await fs.readFile(path.join(directory,'temporary'),'utf8'),'concurrent user edit');assert(manifest.documentIntent);assert.equal(saved,false);
});

test('publication archives a last-moment replacement instead of unlinking it',mac,async t=>{
 const {platformNative}=await import('../src/platform/native.mjs');const {entry,openDirectoryChain}=await import('../src/platform/directory-fs.mjs');const {publishFileAt}=await import('../src/platform/file-publication.mjs');const {createHash}=await import('node:crypto');
 const root=await fixture(t),dir=await openDirectoryChain(root);t.after(()=>dir.close());await fs.writeFile(path.join(root,'file'),'baseline');await fs.writeFile(path.join(root,'candidate'),'reviewed');
 const native=platformNative(),rename=native.renameAt;let swapped=false;
 t.mock.method(native,'renameAt',function(fromFd,from,toFd,to,mode){if(from==='candidate'&&mode===1&&swapped)requireFs.writeFileSync(path.join(root,'candidate'),'late user edit');const result=rename.call(this,fromFd,from,toFd,to,mode);if(mode===2)swapped=true;return result;});
 await publishFileAt(entry(dir.directory.fd,'candidate'),entry(dir.directory.fd,'file'),{expectedDigest:createHash('sha256').update('baseline').digest('hex')});
 const names=await fs.readdir(path.join(root,'.nozeli/recovery'));assert.equal(names.length,1);assert.equal(await fs.readFile(path.join(root,'.nozeli/recovery',names[0]),'utf8'),'late user edit');
});

test('worktree cleanup transfers nested recovery storage out of the execution copy',mac,async t=>{
 const {ExecutionWorkspace}=await import('../src/agents/managed/execution-workspace.mjs');const root=await fixture(t),directory=path.join(root,'worktree'),storage=path.join(root,'runtime');
 for(const rel of ['.nozeli/recovery','nested/.nozeli/recovery','.nozeli/.nozeli/recovery','upper/.NOZELI/recovery']){await fs.mkdir(path.join(directory,rel),{recursive:true});await fs.writeFile(path.join(directory,rel,'user'),'keep '+rel);}
 const manifest={directory,workId:'w'};await ExecutionWorkspace.prototype.retainRecoveries.call({store:{root:storage},save:async()=>{}},manifest);
 assert.equal(manifest.retainedRecoveries.length,4);for(const r of manifest.retainedRecoveries){assert.equal(await fs.readFile(path.join(r.destination,'user'),'utf8'),'keep '+r.source);await assert.rejects(fs.stat(path.join(directory,r.source)),{code:'ENOENT'});}
});

test('kernel-redacted environment makes a runtime audit incomplete',mac,async t=>{
 const {platformNative}=await import('../src/platform/native.mjs');const {auditRuntime}=await import('../src/agents/managed/runtime-audit.mjs');
 const root=await fixture(t),child=spawn('/usr/bin/tail',['-f','/dev/null'],{env:{NOZELI_AGENT_DIR:root+'/agents/owned'},stdio:'ignore'});t.after(()=>{try{child.kill('SIGKILL');}catch{}});await once(child,'spawn');
 await assert.rejects(processInfo(child.pid,{full:true}),{code:'EACCES'});t.mock.method(platformNative(),'listProcesses',()=>[child.pid]);
 const empty=spawn('/bin/sleep',['20'],{argv0:'',env:{NOZELI_AGENT_DIR:root+'/agents/owned',SECOND_FIXTURE:'present'},stdio:'ignore'});t.after(()=>{try{empty.kill('SIGKILL');}catch{}});await once(empty,'spawn');await assert.rejects(processInfo(empty.pid,{full:true}),{code:'EACCES'});
 const result=await auditRuntime(root);assert.equal(result.complete,false);assert(result.unverified.some(row=>row.pid===child.pid&&row.code==='EACCES'));
});

test('aligned environments never include kernel auxiliary entries',mac,async t=>{
 for(let length=0;length<8;length++){
  const value='x'.repeat(length),child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{X:value},stdio:'ignore'});t.after(()=>{try{child.kill('SIGKILL');}catch{}});await once(child,'spawn');
  assert.deepEqual((await processInfo(child.pid,{full:true})).environ,['X='+value]);child.kill('SIGTERM');await once(child,'exit');
 }
});


test('only a live in-memory spawn capability authorizes an unreadable direct child',mac,async t=>{
 const child=spawn('/bin/sleep',['30'],{detached:true,env:{},stdio:'ignore'}),exited=once(child,'exit');
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});await once(child,'spawn');
 const fact=await processInfo(child.pid),record={pid:child.pid,stamp:fact.stamp,home:'/synthetic'};
 const directChild=await captureDirectChild(record,exited);let signals=0;
 await assert.rejects(reapGroup(record,['NOZELI_AGENT_DIR'],{directChild:{},signal:()=>signals++}),{code:'EACCES'});
 assert.equal(signals,0,'a reconstructed capability is not accepted');
 const result=await reapGroup(record,['NOZELI_AGENT_DIR'],{directChild});assert.equal(result.verified,true);await exited;
 assert.equal(await processInfo(child.pid),null);
});
