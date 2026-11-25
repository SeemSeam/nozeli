import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createDesktopProfileIO} from '../src/main/desktop-profile-io.mjs';
import {DesktopHost} from '../src/main/host.mjs';
import {createGuidedDemo} from '../src/main/guided-demo.mjs';
import {security} from './fixtures/windows-security.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {resolveNozeliPaths,initializeNozeliConfiguration} from '../src/agents/managed/nozeli-config.mjs';
import {selectedWindowsInstallProfile,verifyWindowsInstallProfile} from '../src/platform/windows/install-profile.mjs';
import {randomUUID} from 'node:crypto';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t){const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-desktop-profile-')),root=path.join(base,'desktop'),databases=[];await ensureExperimentalPrivateDirectory(base,root);t.after(async()=>{for(const db of databases)await db.close();await fs.rm(base,{recursive:true,force:true});});return {root,io:createDesktopProfileIO(root),file:rel=>path.join(root,rel),hold(host){databases.push(host.storage.db);return host;}};}
const independent=(file,text)=>{const child=spawnSync(process.execPath,['--input-type=module','-e',"import fs from 'node:fs';fs.writeFileSync(process.argv[1],process.argv[2]);",file,text],{encoding:'utf8',windowsHide:true,timeout:10000});assert.ifError(child.error);assert.equal(child.status,0,child.stderr);};

test('desktop records use private native allocation, bounded verified reads and explicit observed-revision CAS',native,async t=>{
 const f=await fixture(t),file=f.file('private/中文 空格.json');await f.io.ensureDirectory(path.dirname(file));
 assert.deepEqual(await f.io.read(file),{bytes:null,sha256:null});
 await assert.rejects(f.io.write(file,Buffer.from('x')),{code:'PROFILE_REVISION_REQUIRED'});
 const bytes=Buffer.from('{"value":"中文 🧭"}'),receipt=await f.io.write(file,bytes,{expectedSha256:null});
 assert.equal(receipt.published,true);assert.equal(receipt.durability,'namespace-not-qualified');assert.deepEqual((await f.io.read(file)).bytes,bytes);
 const acl=security('inspect',file);assert.equal(acl.protected,true);assert.equal(acl.owner,acl.currentSid);assert.equal(acl.rules.length,1);
 await assert.rejects(f.io.read(file,{maxBytes:1}),{code:'PROFILE_RECORD_UNSAFE'});
 await assert.rejects(f.io.write(file,Buffer.from('late'),{expectedSha256:null}),{code:'FS_TARGET_EXISTS'});
 await f.io.write(file,Buffer.from('next'),{expectedSha256:receipt.sha256});assert.equal((await f.io.read(file)).bytes.toString(),'next');
 await assert.rejects(f.io.read(path.join(f.root,'../escape.json')),{code:'FS_PATH_REJECTED'});
});

test('DesktopHost preference save retains an independent winner and reads it on a fresh host',native,async t=>{
 const f=await fixture(t),host=new DesktopHost(f.root);t.after(()=>host.storage.db.close());
 assert.deepEqual(await host.viewAuthorship(),{visible:true});await host.viewAuthorship(false);
 const file=path.join(host.metaRoot,'view-preferences.json'),old=await host.readVersioned(file);
 independent(file,JSON.stringify({...old,authorshipVisible:true,external:'winner'}));
 await assert.rejects(host.writeAtomic(file,{...old,authorshipVisible:false}),{code:'FS_VERSION_CONFLICT'});
 await assert.rejects(host.writeVersioned(file,{...old,authorshipVisible:false}),{code:'FS_VERSION_CONFLICT'});
 assert.equal(JSON.parse(await fs.readFile(file,'utf8')).external,'winner');
 const cold=new DesktopHost(f.root);t.after(()=>cold.storage.db.close());assert.deepEqual(await cold.viewAuthorship(),{visible:true});
});

test('corrupt appearance and changed ACL stay intact and do not authorize a replacement',native,async t=>{
 const f=await fixture(t),host=new DesktopHost(f.root),file=f.file('appearance.json');t.after(()=>host.storage.db.close());
 await f.io.write(file,Buffer.from('{broken'),{expectedSha256:null});await assert.rejects(host.readProfileRecord(file),SyntaxError);
 await assert.rejects(host.writeProfileRecord(file,{theme:'light'}),{code:'PROFILE_REVISION_REQUIRED'});assert.equal(await fs.readFile(file,'utf8'),'{broken');
 security('add-write',file);const acl=security('inspect',file);await assert.rejects(f.io.read(file));assert.deepEqual(security('inspect',file),acl);assert.equal(await fs.readFile(file,'utf8'),'{broken');
});

test('guided registry startup and process-style reopen use native records and stale saves retain external data',native,async t=>{
 const f=await fixture(t),options={host:{},userDataDir:f.root,appRoot:path.resolve(import.meta.dirname,'..'),examplesRoot:f.root+'-examples'};
 const demo=await createGuidedDemo(options);assert.deepEqual(demo.data,{schemaVersion:1,projects:{}});
 const original=(await f.io.read(demo.file)).sha256,cold=await createGuidedDemo(options);assert.equal(cold.diskHash,original);
 independent(demo.file,JSON.stringify({schemaVersion:1,projects:{},external:'retained'}));
 await assert.rejects(cold.mutate(()=>{cold.data.extra='unacknowledged';}),{code:'FS_VERSION_CONFLICT'});
 assert.equal(cold.data.extra,undefined);assert.equal(JSON.parse(await fs.readFile(demo.file,'utf8')).external,'retained');
 const reopened=await createGuidedDemo(options);assert.equal(reopened.data.external,'retained');
 independent(demo.file,'{invalid');await assert.rejects(createGuidedDemo(options),SyntaxError);assert.equal(await fs.readFile(demo.file,'utf8'),'{invalid');
});

test('configuration creates private profile children before Chromium and preserves permissive existing directories on refusal',native,async t=>{
 const f=await fixture(t),paths=resolveNozeliPaths({home:f.root,env:{}});assert.equal((await initializeNozeliConfiguration(paths)).initialized,false);
 for(const directory of [paths.desktop,paths.omp,paths.migrations]){const acl=security('inspect',directory);assert.equal(acl.protected,true);assert.equal(acl.owner,acl.currentSid);assert.equal(acl.rules.length,1);}
 security('add-write',paths.desktop);const acl=security('inspect',paths.desktop);await fs.writeFile(path.join(paths.desktop,'retain.txt'),'existing');
 await assert.rejects(initializeNozeliConfiguration(paths));assert.deepEqual(security('inspect',paths.desktop),acl);assert.equal(await fs.readFile(path.join(paths.desktop,'retain.txt'),'utf8'),'existing');
});

test('DesktopHost selects native private catalog custody and refuses a project overlapping the profile before allocation',native,async t=>{
 const f=await fixture(t),host=f.hold(new DesktopHost(f.root));assert.deepEqual(await host.recent(),{projects:[]});assert.equal(host.storage.nativeRootForPath(host.storage.catalog),f.root);
 const acl=security('inspect',host.storage.catalog);assert.equal(acl.protected,true);assert.equal(acl.rules.length,1);
 const child=spawnSync(process.execPath,['--input-type=module','-e',"import fs from 'node:fs';fs.renameSync(process.argv[1],process.argv[1]+'.moved');",host.storage.catalog],{encoding:'utf8',windowsHide:true,timeout:10000});assert.ifError(child.error);assert.notEqual(child.status,0);
 const project=path.join(f.root,'source');await fs.mkdir(project);await fs.writeFile(path.join(project,'keep.md'),'source');await assert.rejects(host.registerDirectory(project),{code:'PROJECT_ROOT_OVERLAP'});assert.deepEqual(await fs.readdir(project),['keep.md']);
 await host.storage.db.close();const cold=f.hold(new DesktopHost(f.root));assert.deepEqual(await cold.recent(),{projects:[]});
});

test('isolated Windows installation binds its dedicated profile and rejects a changed ownership marker',native,async t=>{
 const f=await fixture(t),installRoot=path.join(f.root,'isolated-install'),profile=path.join(installRoot,'profile'),installationId=randomUUID();
 await ensureExperimentalPrivateDirectory(f.root,profile);
 const io=createDesktopProfileIO(installRoot),owner={schema:1,application:'Nozeli',kind:'windows-isolated-install',root:installRoot,profile,installationId};
 await io.write(path.join(installRoot,'WINDOWS-INSTALL.json'),Buffer.from(JSON.stringify(owner)),{expectedSha256:null});
 const marker=path.join(profile,'WINDOWS-PROFILE.json'),bytes=Buffer.from(JSON.stringify({schema:1,application:'Nozeli',kind:'windows-isolated-profile',installRoot,installationId}));
 const published=await io.write(marker,bytes,{expectedSha256:null});
 const env={NOZELI_WINDOWS_INSTALL_PROFILE:profile};
 assert.equal(selectedWindowsInstallProfile(env,f.root),profile);
 assert.equal(resolveNozeliPaths({env,home:f.root}).desktop,path.join(profile,'desktop'));
 assert.deepEqual(await verifyWindowsInstallProfile(profile),{profile,installRoot,installationId});
 await io.write(marker,Buffer.from(JSON.stringify({schema:1,application:'Nozeli',kind:'windows-isolated-profile',installRoot,installationId:randomUUID()})),{expectedSha256:published.sha256});
 await assert.rejects(verifyWindowsInstallProfile(profile),{code:'CONFIG_ROOT_INVALID'});
 assert.equal(JSON.parse((await io.read(marker)).bytes).installationId===installationId,false);
 await assert.rejects(fs.stat(path.join(f.root,'.Nozeli')),{code:'ENOENT'});
});

test('isolated installation profile refuses daily overlap, relative roots and test-mode conflicts before effects',native,async t=>{
 const f=await fixture(t),profile=path.join(f.root,'candidate','profile');
 for(const env of [
  {NOZELI_WINDOWS_INSTALL_PROFILE:'relative/profile'},
  {NOZELI_WINDOWS_INSTALL_PROFILE:path.join(f.root,'.Nozeli','profile')},
  {NOZELI_WINDOWS_INSTALL_PROFILE:profile,NOZELI_TEST_INSTANCE:'1'},
  {NOZELI_WINDOWS_INSTALL_PROFILE:profile,NOZELI_CONFIG_ROOT:path.join(f.root,'ignored')},
 ])assert.throws(()=>resolveNozeliPaths({env,home:f.root}),{code:'CONFIG_ROOT_INVALID'});
 await assert.rejects(fs.stat(path.join(f.root,'candidate')),{code:'ENOENT'});
});
