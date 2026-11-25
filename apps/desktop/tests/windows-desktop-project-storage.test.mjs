import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {security} from './fixtures/windows-security.mjs';
import {fileURLToPath} from 'node:url';
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t){const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-scoped-projects-')),profile=path.join(base,'profile'),storage=[];await ensureExperimentalPrivateDirectory(base,profile);t.after(async()=>{for(const s of storage)await s.db.close();await fs.rm(base,{recursive:true,force:true});});return {base,profile,async project(name){const dir=path.join(base,name);await fs.mkdir(dir,{recursive:true});return dir;},storage(){const value=new ProjectStorage(profile,{windowsDesktopProjects:true});storage.push(value);return value;}};}
const child=(script,args)=>{const value=spawnSync(process.execPath,['--input-type=module','-e',script,...args],{encoding:'utf8',windowsHide:true,timeout:15000});assert.ifError(value.error);assert.equal(value.signal,null);return value;};
test('selected projects in disjoint directories use native identity, separate databases and immutable material stores across a cold reopen',native,async t=>{
 const f=await fixture(t),one=await f.project('documents/中文 项目'),two=await f.project('elsewhere/second'),s=f.storage();
 const a=await s.register(one),b=await s.register(two);assert.notEqual(a.id,b.id);assert.equal(a.identity.kind,'windows-file-id-128');
 await s.putLocal(a.id,'draft',{text:'unsent 中文'});await s.putProject(a.id,'notes','n',{text:'local note'});
 const material=await s.putObject(a.id,Buffer.from('original 中文 🧭'));await s.putRecoveryObject(a.id,Buffer.from('recovery'));
 assert.equal((await s.readObject(a.id,material.digest)).toString(),'original 中文 🧭');assert.equal(await s.getLocal(b.id,'draft'),null);
 assert.equal(s.nativeRootForPath(path.join(one,'.nozeli/project.sqlite')),path.dirname(one));assert.equal(s.nativeRootForPath(s.catalog),f.profile);
 await s.db.close();const cold=f.storage();assert.equal((await cold.list()).length,2);assert.equal((await cold.requireOnline(a.id)).root,one);assert.deepEqual(await cold.getLocal(a.id,'draft'),{text:'unsent 中文'});assert.deepEqual(await cold.getProject(a.id,'notes','n'),{text:'local note'});assert.equal((await cold.readObject(a.id,material.digest)).toString(),'original 中文 🧭');
});
test('unselected siblings and profile overlap are refused before metadata writes, and original project root remains pinned',native,async t=>{
 const f=await fixture(t),root=await f.project('project'),unknown=await f.project('sibling'),s=f.storage();await s.register(root);
 assert.throws(()=>s.io.directoryIdentity(unknown),{code:'PROJECT_SCOPE_REQUIRED'});await assert.rejects(s.db.request(path.join(unknown,'foreign.sqlite'),'list',{collection:'x'}),{code:'PROJECT_SCOPE_REQUIRED'});assert.deepEqual(await fs.readdir(unknown),[]);
 await assert.rejects(s.register(f.base),{code:'PROJECT_ROOT_OVERLAP'});assert.equal(await fs.stat(path.join(f.base,'.nozeli')).then(()=>true,e=>e.code==='ENOENT'?false:Promise.reject(e)),false);
 const moved=child("import fs from 'node:fs';fs.renameSync(process.argv[1],process.argv[1]+'-moved');",[root]);assert.notEqual(moved.status,0);await s.db.close();await fs.rename(root,root+'-moved');
});
test('cold registration identity replacement retains the foreign directory and original private draft',native,async t=>{
 const f=await fixture(t),root=await f.project('project'),s=f.storage(),p=await s.register(root);await s.putLocal(p.id,'draft',{text:'retained'});await s.db.close();await fs.rename(root,root+'-old');await fs.mkdir(root);await fs.writeFile(path.join(root,'winner'),'foreign');
 const cold=f.storage();await assert.rejects(cold.requireOnline(p.id),{code:'PROJECT_IDENTITY_CONFLICT'});assert.equal(await fs.readFile(path.join(root,'winner'),'utf8'),'foreign');assert.deepEqual(await cold.getLocal(p.id,'draft'),{text:'retained'});assert.deepEqual(await fs.readdir(root),['winner']);
});

test('independent processes recover the exact registered project, draft and immutable material',native,async t=>{
 const f=await fixture(t),root=await f.project('真实重启 项目'),script=fileURLToPath(new URL('./fixtures/windows-desktop-project-storage-child.mjs',import.meta.url)),results=[];
 for(const action of ['seed','read']){
  const result=spawnSync(process.execPath,[script,action,f.profile,root],{encoding:'utf8',windowsHide:true,timeout:30000});assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,result.stdout+'\n'+result.stderr);results.push(JSON.parse(result.stdout.trim()));
 }
 assert.equal(results[0].id,results[1].id);assert.deepEqual(results[0].identity,results[1].identity);assert.equal(results[1].recovered,true);
});

test('a selected root ACL drift stops project access while the independent private draft remains available',native,async t=>{
 const f=await fixture(t),root=await f.project('project'),s=f.storage(),p=await s.register(root);await s.putLocal(p.id,'draft',{text:'retained'});
 security('add-write',root);const changed=security('inspect',root);
 await assert.rejects(s.requireOnline(p.id),{code:'FS_STAGE_CHANGED'});assert.deepEqual(security('inspect',root),changed);assert.deepEqual(await s.getLocal(p.id,'draft'),{text:'retained'});
});
