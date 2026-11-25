import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fork,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {ExternalOpenQueue} from '../src/main/external-open-queue.mjs';
import {OpenQueueStorage} from '../src/main/external-open-queue-storage.mjs';
import {openExperimentalProcessIdentity} from '../src/platform/windows/experimental-process-identity.mjs';
import {desktopHosts} from './fixtures/desktop-hosts.mjs';
import {security} from './fixtures/windows-security.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:45000};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-win-open-queue-')),profile=path.join(root,'profile'),hosts=desktopHosts();
 t.after(async()=>{await hosts.close();await fs.rm(root,{recursive:true,force:true});});
 return {root,profile,host:()=>hosts.create(profile),storage:()=>new OpenQueueStorage({userDataDir:profile})};
}
const code=value=>error=>error.code===value;
test('native queue cold child reads Unicode FIFO and requires explicit action without opening a project',native,async t=>{
 const f=await fixture(t),q=new ExternalOpenQueue({host:f.host()}),paths=['中文 空格.txt','second.md'].map(name=>path.join(f.root,name));
 for(const absolutePath of paths)await q.enqueue({absolutePath,source:'argv'});
 const script=`import {ExternalOpenQueue} from ${JSON.stringify(new URL('../src/main/external-open-queue.mjs',import.meta.url).href)};const q=new ExternalOpenQueue({host:{userDataDir:process.argv[1]}});console.log(JSON.stringify(await q.openQueue()));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script,f.profile],{encoding:'utf8',windowsHide:true,timeout:20000});
 assert.ifError(child.error);assert.equal(child.status,0,child.stderr);const restored=JSON.parse(child.stdout);
 assert.equal(restored.status,'ready');assert.deepEqual(restored.requests.map(r=>r.absolutePath),paths);assert(restored.requests.every(r=>r.requiresUserAction&&r.target===null));
 const acl=security('inspect',q.storage.dir);assert.equal(acl.protected,true);assert.equal(acl.owner,acl.currentSid);assert.equal(acl.rules.length,1);
});

test('native queue CAS retains an independent winner and create-only never replaces an existing queue',native,async t=>{
 const f=await fixture(t),a=f.storage(),b=f.storage();await a.write({winner:'first'},null);const first=await a.read();
 await b.write({winner:'foreign 中文'},first.hash);const winner=await b.read();
 await assert.rejects(a.write({stale:'unsent'},first.hash),code('OPEN_QUEUE_CHANGED'));
 await assert.rejects(a.write({new:'unsent'},null),code('OPEN_QUEUE_CHANGED'));assert.deepEqual(await a.read(),winner);
 // A winner arriving after the adapter's observed absence must also survive.
 await fs.unlink(a.file);let raced=false;
 a.fault=async stage=>{if(stage==='rename'&&!raced){raced=true;await fs.writeFile(a.file,'independent create winner',{flag:'wx'});}};
 await assert.rejects(a.write({candidate:'retained in caller'},null));assert.equal(await fs.readFile(a.file,'utf8'),'independent create winner');
});

test('native queue retained handles block external mutation and parent relocation across awaited publication hooks',native,async t=>{
 const f=await fixture(t),storage=f.storage();await storage.write({base:'source'},null);const first=await storage.read();
 const refused=(operation,...args)=>{
  const child=spawnSync(process.execPath,['-e',`try{require('node:fs')[process.argv[1]](...process.argv.slice(2));process.exitCode=9;}catch(error){console.log(error.code);}`,operation,...args],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.ifError(child.error);assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/EPERM|EACCES|EBUSY|UNKNOWN/);
 };
 storage.fault=async stage=>{if(stage==='rename'){refused('writeFileSync',storage.file,'racing overwrite');refused('renameSync',storage.dir,storage.dir+'.moved');}};
 await storage.write({next:'saved'},first.hash);assert.deepEqual(JSON.parse((await storage.read()).bytes),{next:'saved'});
 await fs.rename(storage.dir,storage.dir+'.released');assert.equal(await fs.readFile(path.join(storage.dir+'.released','queue.json'),'utf8'),JSON.stringify({next:'saved'}));
});

test('native queue sync confirms exact committed bytes and retains a changed version without rewriting',native,async t=>{
 const f=await fixture(t),storage=f.storage();await storage.write({commit:'approved'},null);const raw=await storage.read();
 await storage.sync(raw.hash);await fs.writeFile(storage.file,'foreign committed version');
 await assert.rejects(storage.sync(raw.hash),code('OPEN_QUEUE_CHANGED'));assert.equal(await fs.readFile(storage.file,'utf8'),'foreign committed version');
});

test('native queue post-publication missing-entry barrier failure retains committed uncertainty',native,async t=>{
 const f=await fixture(t),storage=f.storage(),value={commit:'already published'};
 storage.fault=async stage=>{if(stage==='directory-sync')throw Object.assign(Error('synthetic missing-entry barrier failure'),{code:'WIN32_IO_ERROR',win32Code:2});};
 await assert.rejects(storage.write(value,null),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===2&&error.committed===true&&error.durability==='uncertain');
 const raw=await storage.read();assert.deepEqual(JSON.parse(raw.bytes),value);
 storage.fault=async()=>{};await storage.sync(raw.hash);assert.deepEqual(await storage.read(),raw);
});

for(const kind of ['native-remnant','hardlink','acl','junction'])test(`native queue ${kind} refuses without repair or removal`,native,async t=>{
 const f=await fixture(t),storage=f.storage();await storage.write({original:'preserve'},null);const before=await fs.readFile(storage.file);
 if(kind==='native-remnant'){await fs.rename(storage.file,path.join(storage.dir,'.nozeli-abandoned.pending'));await assert.rejects(storage.read(),code('OPEN_QUEUE_CORRUPT'));assert.deepEqual(await fs.readFile(path.join(storage.dir,'.nozeli-abandoned.pending')),before);}
 if(kind==='hardlink'){const outside=path.join(f.root,'foreign-link');await fs.link(storage.file,outside);await assert.rejects(storage.read(),code('FS_ENTRY_REJECTED'));assert.deepEqual(await fs.readFile(outside),before);}
 if(kind==='acl'){security('add-write',storage.file);const acl=security('inspect',storage.file);await assert.rejects(storage.read(),code('FS_SECURITY_CHANGED'));assert.deepEqual(security('inspect',storage.file),acl);assert.deepEqual(await fs.readFile(storage.file),before);}
 if(kind==='junction'){await fs.rename(storage.dir,storage.dir+'.original');await fs.symlink(storage.dir+'.original',storage.dir,'junction');await assert.rejects(storage.read(),code('FS_REPARSE_REJECTED'));assert.deepEqual(await fs.readFile(storage.file),before);assert((await fs.lstat(storage.dir)).isSymbolicLink());}
});

for(const phase of ['claim','terminal'])test(`native identity verified own child stops after ${phase}; queue survives without replay`,native,async t=>{
 const f=await fixture(t),project=path.join(f.root,'project'),file=path.join(project,'A.txt');await fs.mkdir(project);await fs.writeFile(file,'Source original\n');
 const entry=path.join(import.meta.dirname,'external-open-queue-crash.fixture.mjs');
 const child=fork(entry,[f.root,phase],{cwd:f.root,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
 const exited=once(child,'exit');let log='',lease;
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;lease?.close();});
 const [row]=await Promise.race([once(child,'message'),exited.then(result=>{throw Error('Early child exit '+JSON.stringify(result)+' '+log);})]);
 assert.equal(row.pid,child.pid);lease=openExperimentalProcessIdentity(child.pid);const identity=lease.snapshot();
 assert.equal(identity.state,'running');assert.equal(identity.imagePath.toLowerCase(),process.execPath.toLowerCase());assert.equal(identity.pid,child.pid);assert.match(identity.stamp,/^win32:/);
 assert.equal(lease.snapshot().stamp,identity.stamp);assert(child.kill('SIGKILL'));await exited;
 const ended=lease.snapshot();assert.equal(ended.state,'exited');assert.equal(ended.stamp,identity.stamp);
 const host=f.host(),q=new ExternalOpenQueue({host}),restored=await q.openQueue();
 if(phase==='claim'){assert.equal(restored.requests.length,1);assert.equal(restored.requests[0].lastError.code,'OPEN_INTERRUPTED');assert.equal(restored.requests[0].requiresUserAction,true);}
 else{assert.equal(restored.requests.length,0);const disk=JSON.parse(await fs.readFile(q.storage.file));assert.equal(disk.receipts.length,1);assert.equal(disk.receipts[0].outcome,'opened');}
 const wc={},owner={bootId:q.bootId,window:{webContents:wc},webContents:wc,generation:0};
 const {requestId,attemptId,claimToken,generation}=row.claim;
 await assert.rejects(q.resolveOpen(owner,{requestId,attemptId,claimToken,generation,outcome:'opened'}));assert.equal(await fs.readFile(file,'utf8'),'Source original\n');
});
