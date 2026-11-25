import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {DesktopHost} from '../src/main/host.mjs';
import {createDesktopProfileIO} from '../src/main/desktop-profile-io.mjs';
import {ensureWindowsDesktopProfileDirectory} from '../src/platform/windows/desktop-profile-directory.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {security} from './fixtures/windows-security.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-profile-bootstrap-')),profile=path.join(base,'全新 profile'),hosts=[];
 t.after(async()=>{for(const host of hosts){await host.settled();await host.storage.db.close();}await fs.rm(base,{recursive:true,force:true});});
 return {base,profile,host(){const host=new DesktopHost(profile);hosts.push(host);return host;}};
}

test('first catalog use provisions a missing private profile and preserves project drafts through a real cold process',native,async t=>{
 const f=await fixture(t),host=f.host(),root=path.join(f.base,'project');await fs.mkdir(root);
 assert.deepEqual(await host.recent(),{projects:[]});
 const project=(await host.pick(root)).project;await host.storage.putLocal(project.id,'draft',{text:'unsent 中文 🧭'});
 const acl=security('inspect',f.profile);assert.equal(acl.protected,true);assert.equal(acl.owner,acl.currentSid);assert.equal(acl.rules.length,1);
 await host.settled();await host.storage.db.close();
 const script=`import {DesktopHost} from ${JSON.stringify(new URL('../src/main/host.mjs',import.meta.url).href)};const host=new DesktopHost(process.argv[2]);try{console.log(JSON.stringify(await host.storage.getLocal(process.argv[3],'draft')));}finally{await host.storage.db.close();}`;
 const launcher=path.join(f.base,'cold-reader.mjs');await fs.writeFile(launcher,script);
 const cold=spawnSync(process.execPath,[launcher,f.profile,project.id],{encoding:'utf8',windowsHide:true,timeout:30000});assert.ifError(cold.error);assert.equal(cold.signal,null);assert.equal(cold.status,0,cold.stderr);assert.deepEqual(JSON.parse(cold.stdout),{text:'unsent 中文 🧭'});
});

test('preference first use prepares the same missing profile independently of project storage',native,async t=>{
 const f=await fixture(t),host=f.host();assert.deepEqual(await host.viewAuthorship(),{visible:true});await host.viewAuthorship(false);
 const cold=f.host();assert.deepEqual(await cold.viewAuthorship(),{visible:false});
 const acl=security('inspect',f.profile);assert.equal(acl.protected,true);assert.equal(acl.rules.length,1);
});

test('concurrent profile directory preparation retains one private root and distinct children',native,async t=>{
 const f=await fixture(t),io=createDesktopProfileIO(f.profile);
 const directories=['one','two','three'].map(name=>path.join(f.profile,name));
 await Promise.all(directories.map(dir=>io.ensureDirectory(dir)));
 for(const dir of directories)assert((await fs.stat(dir)).isDirectory());
 const acl=security('inspect',f.profile);assert.equal(acl.protected,true);assert.equal(acl.rules.length,1);
});

test('missing ancestors beyond the immediate profile parent remain absent',native,async t=>{
 const f=await fixture(t),parent=path.join(f.base,'unselected-missing'),profile=path.join(parent,'profile');
 await assert.rejects(ensureWindowsDesktopProfileDirectory(profile,path.join(profile,'records')),e=>e.code==='WIN32_IO_ERROR'&&[2,3].includes(e.win32Code));
 await assert.rejects(fs.lstat(parent),{code:'ENOENT'});
});

test('a regular file occupying the profile is retained without sibling or child effects',native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.profile,'foreign winner');
 await assert.rejects(createDesktopProfileIO(f.profile).ensureDirectory(path.join(f.profile,'records')));
 assert.equal(await fs.readFile(f.profile,'utf8'),'foreign winner');assert.deepEqual(await fs.readdir(f.base),[path.basename(f.profile)]);
});

test('a profile junction is refused and its outside target remains unchanged',native,async t=>{
 const f=await fixture(t),outside=path.join(f.base,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'keep'),'foreign');await fs.symlink(outside,f.profile,'junction');
 await assert.rejects(createDesktopProfileIO(f.profile).ensureDirectory(path.join(f.profile,'records')),{code:'FS_REPARSE_REJECTED'});
 assert.deepEqual(await fs.readdir(outside),['keep']);assert.equal(await fs.readFile(path.join(outside,'keep'),'utf8'),'foreign');assert((await fs.lstat(f.profile)).isSymbolicLink());
});

test('an independently created permissive profile wins the missing-anchor race without ACL repair',native,async t=>{
 const f=await fixture(t),pending=ensureWindowsDesktopProfileDirectory(f.profile,path.join(f.profile,'records'));
 // The initial native anchor open has failed synchronously; the awaiting
 // fallback has not run. An independent namespace winner now owns this name.
 mkdirSync(f.profile);const acl=security('inspect',f.profile);assert.equal(acl.protected,false);
 await assert.rejects(pending,{code:'FS_SECURITY_CHANGED'});
 assert.deepEqual(security('inspect',f.profile),acl);assert.deepEqual(await fs.readdir(f.profile),[]);
});

test('a missing-entry error from a directory barrier is not retried with a different anchor',native,async t=>{
 const f=await fixture(t),directory=path.join(f.profile,'records');await ensureExperimentalPrivateDirectory(f.base,directory);let calls=0;
 const failure=Object.assign(Error('synthetic failed barrier'),{code:'WIN32_IO_ERROR',win32Code:2});
 await assert.rejects(ensureWindowsDesktopProfileDirectory(f.profile,directory,{directorySync(){calls++;throw failure;}}),e=>e===failure);
 assert.equal(calls,1);assert.deepEqual(failure.createdDirectories,[]);
});

test('a failure after private allocation retains the created root and never claims no effect',native,async t=>{
 const f=await fixture(t);let calls=0;const failure=Object.assign(Error('synthetic flush failure'),{code:'FS_DIRECTORY_SYNC_FAILED'});
 await assert.rejects(ensureWindowsDesktopProfileDirectory(f.profile,path.join(f.profile,'records'),{directorySync(){calls++;throw failure;}}),e=>e===failure&&e.committed===true&&e.durability==='uncertain');
 assert.equal(calls,1);assert((await fs.stat(f.profile)).isDirectory());assert.deepEqual(await fs.readdir(f.profile),[]);assert.equal(failure.createdDirectories.length,1);
});

test('invalid destination plans are rejected before allocating a missing profile',native,async t=>{
 const f=await fixture(t);
 for(const directory of [path.join(f.profile,'CON.txt'),path.join(f.base,'escape'),f.profile])await assert.rejects(ensureWindowsDesktopProfileDirectory(f.profile,directory),{code:'FS_PATH_REJECTED'});
 await assert.rejects(fs.lstat(f.profile),{code:'ENOENT'});
});

test('a closed project scope refuses profile allocation before any native effects',native,async t=>{
 const f=await fixture(t),host=f.host();await host.storage.db.close();await assert.rejects(host.storage.ready(),{code:'STORAGE_CLOSED'});await assert.rejects(fs.lstat(f.profile),{code:'ENOENT'});
});
