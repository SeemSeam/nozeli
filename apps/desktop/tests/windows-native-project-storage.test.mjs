import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {createExperimentalProjectStorageIO} from '../src/platform/windows/experimental-project-storage.mjs';
import {openExperimentalPrivateTree} from '../src/platform/windows/experimental-private-tree.mjs';
import {security} from './fixtures/windows-security.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-project-storage-')),resources=[];
 t.after(async()=>{for(const value of resources.reverse())await (value.db??value).close();await fs.rm(root,{recursive:true,force:true});});
 return {root,file:relative=>path.join(root,relative),hold(value){resources.push(value);return value;},storage(profile='profile',options={}){return this.hold(new ProjectStorage(path.join(root,profile),{experimentalWindowsRoot:root,experimentalWindowsInitialization:true,...options}));},async project(relative='项目 空格'){const file=path.join(root,relative);await fs.mkdir(file);return file;}};
}
async function absent(file){await assert.rejects(fs.lstat(file),{code:'ENOENT'});}
function child(code,args=[]){const result=spawnSync(process.execPath,['--input-type=module','-e',code,...args],{encoding:'utf8',windowsHide:true,timeout:15000});assert.ifError(result.error);assert.equal(result.signal,null);return result;}
async function intent(storage){const rows=await storage.db.request(storage.catalog,'list',{collection:'initializations'});assert.equal(rows.length,1);return rows[0].value;}

test('actual shared initialization registers an empty Unicode project and cold reopens project, local and recovery SQLite state',native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage();await fs.writeFile(path.join(root,'未发送.md'),'original draft');const project=await storage.register(root);
 assert.equal(project.root,root);assert.equal(project.identity.kind,'windows-file-id-128');assert.match(project.metadataIdentity.ino,/^[a-f0-9]{32}$/);assert.equal(project.persistenceQualification.durability,'namespace-not-qualified');
 assert.equal((await intent(storage)).phase,'complete');assert.equal((await intent(storage)).candidateTree.identity,project.metadataIdentity.dev+':'+project.metadataIdentity.ino);assert.equal(await fs.readFile(path.join(root,'未发送.md'),'utf8'),'original draft');
 await storage.putProject(project.id,'drafts','draft',{text:'未发送',projectId:project.id},{operationId:'draft-seed'});await storage.putLocal(project.id,'view',{cursor:17});await storage.putRecovery(project.id,'recovery-draft',{text:'retained'});
 const repeated=await storage.register(root);assert.equal(repeated.id,project.id);assert.equal(repeated.instanceId,project.instanceId);await storage.db.close();
 const cold=f.storage(),reopened=await cold.register(root);assert.equal(reopened.id,project.id);assert.deepEqual(await cold.getProject(project.id,'drafts','draft'),{text:'未发送',projectId:project.id});assert.deepEqual(await cold.getLocal(project.id,'view'),{cursor:17});assert.deepEqual(await cold.getRecovery(project.id,'recovery-draft'),{text:'retained'});
 assert.deepEqual(await cold.db.request(path.join(project.metadataRoot,'project.sqlite'),'receipt',{operationId:'draft-seed'}),{revision:1});assert.deepEqual((await fs.readdir(root)).sort(),['.nozeli','未发送.md']);
});

for(const phase of ['prepared','staging','staged','source-preserved','published','complete'])test(`shared initialization cold resumes the actual ${phase} checkpoint with the same project and instance identities`,native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage();await fs.writeFile(path.join(root,'draft'),'retained');const request=storage.db.request.bind(storage.db);let interrupted=false;
 storage.db.request=async(file,op,args={})=>{const result=await request(file,op,args);if(!interrupted&&file===storage.catalog&&op==='put'&&args.collection==='initializations'&&args.value.phase===phase){interrupted=true;throw Error('checkpoint interruption');}return result;};
 await assert.rejects(storage.register(root),/checkpoint interruption/);const recorded=await intent(storage);assert.equal(recorded.phase,phase);await storage.db.close();
 const cold=f.storage(),project=await cold.register(root);assert.equal(project.id,recorded.id);assert.equal(project.instanceId,recorded.instanceId);assert.equal((await intent(cold)).phase,'complete');assert.equal(await fs.readFile(path.join(root,'draft'),'utf8'),'retained');assert.equal((await cold.requireOnline(project.id)).id,project.id);assert.deepEqual((await fs.readdir(root)).sort(),['.nozeli','draft']);
});

test('default production and root-only injection still refuse initialization before project or profile effects',native,async t=>{
 const f=await fixture(t),root=await f.project(),defaults=f.hold(new ProjectStorage(f.file('default-profile'))),rootOnly=f.storage('root-only',{experimentalWindowsInitialization:false});
 for(const storage of [defaults,rootOnly])await assert.rejects(storage.register(root),{code:'PERSISTENCE_UNSUPPORTED'});assert.deepEqual(await fs.readdir(root),[]);await absent(f.file('default-profile'));await absent(f.file('root-only'));
 assert.throws(()=>new ProjectStorage(f.file('invalid'),{experimentalWindowsInitialization:true}),TypeError);
});

test('a public project root data-read identity pin denies independent rename and detects its actual ACL drift without repair',native,async t=>{
 const f=await fixture(t),root=await f.project(),io=createExperimentalProjectStorageIO(f.root,{initialization:true}),pin=f.hold(io.pinDirectory(root));const identity=await io.directoryIdentity(root);assert.match(identity.ino,/^[a-f0-9]{32}$/);
 const blocked=child(`import fs from 'node:fs';try{fs.renameSync(process.argv[1],process.argv[1]+'-moved');process.exit(2);}catch{}`, [root]);assert.equal(blocked.status,0,blocked.stderr);
 await io.privateDirectory(path.join(root,'private/child'),{anchor:root});assert.equal(security('inspect',path.join(root,'private/child')).protected,true);
 security('add-write',root);const changed=security('inspect',root);assert.throws(()=>pin.verify(),{code:'FS_STAGE_CHANGED'});assert.deepEqual(security('inspect',root),changed);pin.close();await fs.rename(root,root+'-moved');
});

test('retry retains a partially built candidate and independent late bytes before creating a fresh candidate under the same intent',native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage(),original=storage.io;let failOnce=true;
 storage.io={...original,async writeExclusive(...args){await original.writeExclusive(...args);if(failOnce){failOnce=false;throw Error('interrupted after index');}}};await assert.rejects(storage.register(root),/interrupted after index/);const before=await intent(storage),directory=before.temporary;
 await fs.writeFile(path.join(directory,'late'),'external retained');const snapshot=await openExperimentalPrivateTree(f.root,directory),manifest=snapshot.manifest;snapshot.close();await storage.db.close();
 const cold=f.storage(),project=await cold.register(root),after=await intent(cold);assert.equal(project.id,before.id);assert.equal(after.retainedCandidates.length,1);assert.equal(after.retainedCandidates[0].directory,directory);assert.equal(after.retainedCandidates[0].identity,manifest.rootIdentity);assert.equal(after.retainedCandidates[0].manifestSha256,manifest.sha256);assert.equal(await fs.readFile(path.join(directory,'late'),'utf8'),'external retained');assert.equal(await fs.readFile(path.join(directory,'memory/plantree/index.md'),'utf8'),'# Plan Tree\n');
 const check=await openExperimentalPrivateTree(f.root,directory);assert.deepEqual(check.manifest,manifest);check.close();
});

test('allocation checkpoint preserves a markerless candidate after a real checkpoint interruption and cold retry never deletes it',native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage(),request=storage.db.request.bind(storage.db);let interrupted=false;
 storage.db.request=async(file,op,args={})=>{const result=await request(file,op,args);if(!interrupted&&file===storage.catalog&&op==='put'&&args.collection==='initializations'&&args.value.candidateAllocation){interrupted=true;throw Error('allocated before marker');}return result;};
 await assert.rejects(storage.register(root),error=>error.message==='allocated before marker'&&error.committed&&Boolean(error.initializationCandidate.identity));const before=await intent(storage);assert.deepEqual(await fs.readdir(before.temporary),[]);await storage.db.close();
 const cold=f.storage(),project=await cold.register(root);assert.equal(project.id,before.id);assert.deepEqual(await fs.readdir(before.temporary),[]);assert.equal((await intent(cold)).retainedCandidates[0].identity,before.candidateAllocation.identity);
});

test('an independent target winner at publication preserves both the complete staged candidate and winner without replacement',native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage(),original=storage.io;storage.io={...original,async moveTree(source,destination,expected){const result=child(`import fs from 'node:fs';fs.mkdirSync(process.argv[1]);fs.writeFileSync(process.argv[1]+'/keep','external winner');`,[destination]);assert.equal(result.status,0,result.stderr);return original.moveTree(source,destination,expected);}};
 await assert.rejects(storage.register(root),error=>error.privateTreePublication?.moved===false);const before=await intent(storage);assert.equal(before.phase,'source-preserved');assert.equal(await fs.readFile(path.join(root,'.nozeli/keep'),'utf8'),'external winner');await original.assertTree(before.temporary,before.candidateTree);await storage.db.close();
 const cold=f.storage();await assert.rejects(cold.register(root));assert.equal(await fs.readFile(path.join(root,'.nozeli/keep'),'utf8'),'external winner');await original.assertTree(before.temporary,before.candidateTree);
});

test('a real closed-parent fault after publication retains moved facts and a cold retry reconciles the original candidate identity',native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage(),original=storage.io;storage.io={...original,async moveTree(source,destination,expected){const lease=await openExperimentalPrivateTree(f.root,source,{expectedIdentity:expected.identity,directorySync:(directory,{phase})=>{if(phase==='destination-parent')directory.close();directory.syncDirectory();}});try{return await lease.publishTo(destination);}finally{lease.close();}}};
 await assert.rejects(storage.register(root),error=>error.code==='FS_HANDLE_CLOSED'&&error.committed&&error.durability==='uncertain'&&error.privateTreePublication.moved);const before=await intent(storage);assert.equal(before.phase,'source-preserved');await absent(before.temporary);assert.ok(await fs.stat(path.join(root,'.nozeli/project.sqlite')));await storage.db.close();
 const cold=f.storage(),project=await cold.register(root);assert.equal(project.id,before.id);assert.equal(project.metadataIdentity.dev+':'+project.metadataIdentity.ino,before.candidateTree.identity);assert.equal((await intent(cold)).phase,'complete');
});

test('a changed staged candidate is rejected against its persisted full manifest and its external addition is retained',native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage(),request=storage.db.request.bind(storage.db);let interrupted=false;
 storage.db.request=async(file,op,args={})=>{const result=await request(file,op,args);if(!interrupted&&file===storage.catalog&&op==='put'&&args.collection==='initializations'&&args.value.phase==='staged'){interrupted=true;throw Error('staged boundary');}return result;};
 await assert.rejects(storage.register(root),/staged boundary/);const before=await intent(storage);await fs.writeFile(path.join(before.temporary,'late'),'external');await storage.db.close();const cold=f.storage();await assert.rejects(cold.register(root),{code:'PROJECT_INITIALIZATION_CONFLICT'});await absent(path.join(root,'.nozeli'));assert.equal(await fs.readFile(path.join(before.temporary,'late'),'utf8'),'external');assert.equal((await intent(cold)).candidateTree.manifestSha256,before.candidateTree.manifestSha256);
});

test('online root replacement and a missing root remain unavailable while local and recovery drafts survive',native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage(),project=await storage.register(root);await storage.putLocal(project.id,'draft','local original');await storage.putRecovery(project.id,'draft','recovery original');await storage.closeProjectHandles(project.id);await fs.rename(root,root+'-old');
 await assert.rejects(storage.requireOnline(project.id),{code:'PROJECT_ROOT_MISSING'});await absent(root);assert.equal(await storage.getLocal(project.id,'draft'),'local original');assert.equal(await storage.getRecovery(project.id,'draft'),'recovery original');await fs.mkdir(root);await fs.writeFile(path.join(root,'winner'),'external root');await assert.rejects(storage.retry(project.id),{code:'PROJECT_IDENTITY_CONFLICT'});assert.equal(await fs.readFile(path.join(root,'winner'),'utf8'),'external root');assert.ok(await fs.stat(path.join(root+'-old','.nozeli/project.sqlite')));
});

test('an external metadata tree is refused by real recovery ownership selection before any initialization or source mutation',native,async t=>{
 const f=await fixture(t),root=await f.project(),first=f.storage(),project=await first.register(root);await first.putProject(project.id,'drafts','draft','original',{operationId:'seed'});await first.closeProjectHandles(project.id);const before=await openExperimentalPrivateTree(f.root,project.metadataRoot),manifest=before.manifest;before.close();
 const other=f.storage('other-profile');await assert.rejects(other.register(root),{code:'RECOVERY_OWNER_UNVERIFIED'});assert.deepEqual(await other.db.request(other.catalog,'list',{collection:'initializations'}),[]);const after=await openExperimentalPrivateTree(f.root,project.metadataRoot);assert.deepEqual(after.manifest,manifest);after.close();assert.equal(await first.getProject(project.id,'drafts','draft'),'original');
});

test('retry uses a real scoped private SQLite probe and reconciles an invalidated worker without losing its committed receipt',native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage(),project=await storage.register(root),file=path.join(project.metadataRoot,'project.sqlite');await storage.putProject(project.id,'drafts','draft','retained',{operationId:'seed'});await storage.db.invalidate(file);storage.unavailable.set(project.id,Object.assign(Error('needs explicit check'),{code:'PROJECT_METADATA_CONFLICT'}));
 const result=await storage.retry(project.id);assert.equal(result.available,true);assert.equal(storage.unavailable.has(project.id),false);assert.equal(await storage.getProject(project.id,'drafts','draft'),'retained');assert.deepEqual(await storage.db.request(file,'receipt',{operationId:'seed'}),{revision:1});
});

test('unconfirmed actual staging database close prevents publication and leaves both its intent and bytes intact',native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage(),original=storage.db.request.bind(storage.db);let blocked=false;
 storage.db.request=async(file,op,args)=>{if(!blocked&&op==='close'&&path.basename(file)==='project.sqlite'){blocked=true;return {closed:false,operationIds:['unknown-write']};}return original(file,op,args);};
 await assert.rejects(storage.register(root),{code:'STORAGE_RESULT_UNKNOWN'});const before=await intent(storage);await absent(path.join(root,'.nozeli'));assert.equal(before.phase,'staging');assert.ok(await fs.stat(path.join(before.temporary,'project.sqlite')));storage.db.request=original;await storage.db.close();const cold=f.storage(),project=await cold.register(root);assert.equal(project.id,before.id);assert.ok((await intent(cold)).retainedCandidates.some(row=>row.directory===before.temporary));
});

test('actual host exit at allocation and after native publication cold resumes without repeating an unknown namespace operation',native,async t=>{
 const f=await fixture(t),loader=new URL('../src/main/project-storage.mjs',import.meta.url).href;
 for(const phase of ['allocation','publication']){
  const root=await f.project(phase),profile='profile-'+phase;
  const script=f.file('exit-'+phase+'.mjs');await fs.writeFile(script,`import {ProjectStorage} from ${JSON.stringify(loader)};const [scope,profile,root,phase]=process.argv.slice(2);const storage=new ProjectStorage(profile,{experimentalWindowsRoot:scope,experimentalWindowsInitialization:true});if(phase==='allocation'){const request=storage.db.request.bind(storage.db);storage.db.request=async(file,op,args)=>{const value=await request(file,op,args);if(file===storage.catalog&&op==='put'&&args.collection==='initializations'&&args.value.candidateAllocation)process.exit(0);return value;};}else{const io=storage.io;storage.io={...io,async moveTree(...args){await io.moveTree(...args);process.exit(0);}};}await storage.register(root);throw Error('exit point not reached');`);
  const exited=spawnSync(process.execPath,[script,f.root,f.file(profile),root,phase],{encoding:'utf8',windowsHide:true,timeout:15000});assert.ifError(exited.error);assert.equal(exited.signal,null);assert.equal(exited.status,0,exited.stderr);
  const cold=f.storage(profile);await cold.ready();const before=await intent(cold),project=await cold.register(root);assert.equal(project.id,before.id);assert.equal((await intent(cold)).phase,'complete');if(phase==='allocation')assert.deepEqual(await fs.readdir(before.temporary),[]);else{await absent(before.temporary);assert.equal(project.metadataIdentity.dev+':'+project.metadataIdentity.ino,before.candidateTree.identity);}
 }
});

test('private metadata ACL and hardlink drift refuse online access without repairing permissions or deleting external links',native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage(),project=await storage.register(root);await storage.closeProjectHandles(project.id);const manifest=path.join(project.metadataRoot,'project.json'),external=f.file('external-link');await fs.link(manifest,external);
 await assert.rejects(storage.requireOnline(project.id),{code:'FS_ENTRY_REJECTED'});assert.equal((await fs.stat(external)).nlink,2);await fs.unlink(external);await storage.retry(project.id);await storage.closeProjectHandles(project.id);security('add-write',manifest);const changed=security('inspect',manifest);await assert.rejects(storage.requireOnline(project.id),{code:'FS_SECURITY_CHANGED'});assert.deepEqual(security('inspect',manifest),changed);
});

test('root ACL drift during staging invalidates the retained root policy before publication without permission repair',native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage(),original=storage.io;let changed;
 storage.io={...original,async writeExclusive(...args){await original.writeExclusive(...args);security('add-write',root);changed=security('inspect',root);}};
 await assert.rejects(storage.register(root),{code:'FS_STAGE_CHANGED'});await absent(path.join(root,'.nozeli'));assert.deepEqual(security('inspect',root),changed);const recorded=await intent(storage);assert.ok(await fs.stat(recorded.temporary));
});

test('a replacement metadata root after a recorded publication checkpoint cannot be adopted merely by copying its marker and database',native,async t=>{
 const f=await fixture(t),root=await f.project(),storage=f.storage(),request=storage.db.request.bind(storage.db);let interrupted=false;
 storage.db.request=async(file,op,args={})=>{const result=await request(file,op,args);if(!interrupted&&file===storage.catalog&&op==='put'&&args.collection==='initializations'&&args.value.phase==='published'){interrupted=true;throw Error('published boundary');}return result;};
 await assert.rejects(storage.register(root),/published boundary/);const before=await intent(storage);await storage.db.close();const metadata=path.join(root,'.nozeli'),retained=path.join(root,'original-metadata');await fs.rename(metadata,retained);await storage.io.privateDirectory(metadata,{anchor:root});await fs.cp(retained,metadata,{recursive:true});await fs.writeFile(path.join(metadata,'external'),'replacement');
 const cold=f.storage();await assert.rejects(cold.register(root),error=>['FS_DIRECTORY_CONFLICT','PROJECT_INITIALIZATION_CONFLICT'].includes(error.code));assert.deepEqual(await cold.list(),[]);assert.equal(await fs.readFile(path.join(metadata,'external'),'utf8'),'replacement');const original=await openExperimentalPrivateTree(f.root,retained);assert.equal(original.manifest.sha256,before.candidateTree.manifestSha256);original.close();
});
