import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectStorage} from '../src/main/project-storage.mjs';

async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-project-reload-'));
 const root=path.join(base,'project');await fs.mkdir(root);
 const storage=new ProjectStorage(path.join(base,'profile'));
 t.after(async()=>{await storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 return {base,root,storage};
}
async function replaceMetadata(f){
 const old=await f.storage.register(f.root);
 await f.storage.putRecovery(old.id,'unsent',{draft:'old local draft'});
 await f.storage.remove(old.id);
 await f.storage.closeProjectHandles(old.id);
 // A second profile attaching the same metadata now preserves its UUID. Use a
 // genuinely different project's metadata to exercise explicit identity recovery.
 const otherRoot=path.join(f.base,'other-project');await fs.mkdir(otherRoot);
 const other=new ProjectStorage(path.join(f.base,'other-profile'));
 let replacement;
 try{
  replacement=await other.register(otherRoot);
  await other.putProject(replacement.id,'reload-test','retained',{projectId:replacement.id,text:'source data'});
 }finally{await other.db.close();}
 await fs.rename(path.join(f.root,'.nozeli'),path.join(f.base,'old-metadata'));
 await fs.rename(path.join(otherRoot,'.nozeli'),path.join(f.root,'.nozeli'));
 return {old,replacement};
}

// The recovery reload flow must not depend on the machine's live process table:
// an unrelated Electron run started by a concurrently executing smoke suite has
// no catalog handle, and the real ownership probe correctly refuses to guess —
// which would surface RECOVERY_OWNER_UNVERIFIED before the recovery semantics
// under test are reached. Inject the same synthetic ownership probe used by
// project-recovery-owner.test.mjs: /proc lists no other same-user instance, and
// the actual guard code in project-recovery-owner.mjs keeps running unmodified.
function isolateRecoveryOwnerScan(t){
 const readdir=fs.readdir;
 t.mock.method(fs,'readdir',async(directory,options)=>directory==='/proc'?[]:readdir(directory,options));
}
test('same-identity removed reload preserves instance and recovery without special confirmation',async t=>{
 const f=await fixture(t),old=await f.storage.register(f.root);
 await f.storage.putRecovery(old.id,'unsent',{draft:'retained'});await f.storage.remove(old.id);
 const result=await f.storage.register(f.root,{confirmRecovery:()=>assert.fail('same identity needs no recovery confirmation')});
 assert.equal(result.id,old.id);assert.equal(result.instanceId,old.instanceId);assert.equal(result.removed,false);
 assert.deepEqual(await f.storage.getRecovery(old.id,'unsent'),{draft:'retained'});
});
test('another profile attachment preserves removed project identity and local recovery without confirmation',async t=>{
 const f=await fixture(t),old=await f.storage.register(f.root);
 await f.storage.putRecovery(old.id,'unsent',{draft:'old local draft'});
 await f.storage.remove(old.id);await f.storage.closeProjectHandles(old.id);
 const manifest=await fs.readFile(path.join(f.root,'.nozeli/project.json'),'utf8');
 const other=new ProjectStorage(path.join(f.base,'other-profile'));
 try{
  const attached=await other.register(f.root);
  assert.equal(attached.id,old.id);assert.notEqual(attached.instanceId,old.instanceId);
  await other.putRecovery(attached.id,'unsent',{draft:'other local draft'});
 }finally{await other.db.close();}
 const result=await f.storage.register(f.root,{confirmRecovery:()=>assert.fail('another profile must not fork project identity')});
 assert.equal(result.id,old.id);assert.equal(result.instanceId,old.instanceId);assert.equal(result.removed,false);
 assert.equal(await fs.readFile(path.join(f.root,'.nozeli/project.json'),'utf8'),manifest);
 assert.deepEqual(await f.storage.getRecovery(old.id,'unsent'),{draft:'old local draft'});
});
test('removed project with different metadata requires confirmation, preserves source identity and old recovery',{skip:process.platform!=='linux'},async t=>{
 isolateRecoveryOwnerScan(t);
 const f=await fixture(t),{old,replacement}=await replaceMetadata(f);
 assert.notEqual(replacement.id,old.id);
 const metadataIdentity=await fs.stat(path.join(f.root,'.nozeli'));
 const manifest=await fs.readFile(path.join(f.root,'.nozeli/project.json'),'utf8');
 await assert.rejects(f.storage.register(f.root),{code:'PROJECT_RECOVERY_CANCELLED'});
 assert.equal(await fs.readFile(path.join(f.root,'.nozeli/project.json'),'utf8'),manifest);
 assert.equal((await f.storage.requireRegistered(old.id)).removed,true);
 assert.deepEqual(await f.storage.getRecovery(old.id,'unsent'),{draft:'old local draft'});
 let snapshot;const result=await f.storage.register(f.root,{confirmRecovery:async value=>{snapshot=value;return true;}});
 assert.equal(snapshot.projectId,replacement.id);assert.equal(snapshot.previousId,old.id);
 assert.equal(result.id,replacement.id);assert.notEqual(result.instanceId,old.instanceId);assert.notEqual(result.instanceId,replacement.instanceId);
 assert.equal((await f.storage.requireRegistered(old.id)).removed,true);
 assert.deepEqual(await f.storage.getRecovery(old.id,'unsent'),{draft:'old local draft'});
 assert.equal(await f.storage.getRecovery(result.id,'unsent'),null);
 assert.equal(await fs.readFile(path.join(f.root,'.nozeli/project.json'),'utf8'),manifest);
 const currentIdentity=await fs.stat(path.join(f.root,'.nozeli'));
 assert.equal(currentIdentity.dev,metadataIdentity.dev);assert.equal(currentIdentity.ino,metadataIdentity.ino);
 assert.deepEqual(await f.storage.getProject(result.id,'reload-test','retained'),{projectId:replacement.id,text:'source data'});
 assert.equal((await f.storage.register(f.root)).id,result.id);
});
test('confirmation cannot authorize a metadata entity substituted while awaiting the user',{skip:process.platform!=='linux'},async t=>{
 isolateRecoveryOwnerScan(t);
 const f=await fixture(t),{old,replacement}=await replaceMetadata(f);
 await assert.rejects(f.storage.register(f.root,{confirmRecovery:async()=>{
  await f.storage.db.request(path.join(f.root,'.nozeli/project.sqlite'),'close');
  await fs.cp(path.join(f.root,'.nozeli'),path.join(f.base,'replacement'),{recursive:true});
  await fs.rename(path.join(f.root,'.nozeli'),path.join(f.base,'before'));
  await fs.rename(path.join(f.base,'replacement'),path.join(f.root,'.nozeli'));return true;
 }}),{code:'PROJECT_IDENTITY_CONFLICT'});
 assert.equal((await f.storage.requireRegistered(old.id)).removed,true);
 assert.deepEqual(await f.storage.getRecovery(old.id,'unsent'),{draft:'old local draft'});
 assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'.nozeli/project.json'))).projectId,replacement.id);
 assert.equal((await f.storage.list()).some(project=>project.id===replacement.id),false);
});
