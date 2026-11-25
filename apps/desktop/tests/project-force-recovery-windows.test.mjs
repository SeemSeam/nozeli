import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProjectForceRecovery} from '../src/main/project-force-recovery.mjs';
import {assertRecoverySourceStopped} from '../src/main/project-recovery-owner.mjs';
import {capabilityStatus} from '../src/platform/platform-capabilities.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function tree(root){
  const entries=[];let stack=[root];
  while(stack.length){const dir=stack.pop();for(const name of await fs.readdir(dir).catch(()=>[])){const file=path.join(dir,name);const stat=await fs.lstat(file);entries.push(file+(stat.isDirectory()?'/':''));if(stat.isDirectory())stack.push(file);}}
  return entries.sort();
}

// The beta8 force-recovery service stays generic upstream code. On Windows it
// must refuse before any effect: the source-stop proof has no verified
// platform adapter (recovery-source-ownership is unsupported — the kernel
// prerequisite, a system-wide open-handle enumeration or an exclusive
// directory-oplock proof across the publication transaction, does not exist
// in the bundled natives), and the registered native FileID project identity
// never matches a Node stat identity, so the very first snapshot guard fails
// closed. This regression pins that no preview or execute attempt touches
// metadata, local drafts, the recovery catalog or the backup tree.
test('windows force recovery is declared unsupported by the capability matrix',native,()=>{
  const status=capabilityStatus('recovery-source-ownership');
  assert.equal(status.platformRaw,'win32');assert.equal(status.status,'unsupported');
});

async function fixture(t){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-force-unsupported-')),profile=path.join(base,'profile');
  await ensureExperimentalPrivateDirectory(base,profile);
  const storage=new ProjectStorage(profile,{windowsDesktopProjects:true});
  t.after(async()=>{await storage.db.close();await fs.rm(base,{recursive:true,force:true});});
  const root=path.join(base,'proj');await fs.mkdir(root,{recursive:true});
  const project=await storage.register(root);
  await storage.putLocal(project.id,'draft',{text:'untouched 中文'});
  const recovery=new ProjectForceRecovery({host:{storage},protectedRoots:[],prepareResetAdmission:async()=>{}});
  return {base,storage,root,project,recovery,metadata:path.join(root,'.nozeli'),before:await tree(path.join(root,'.nozeli')),draft:()=>storage.getLocal(project.id,'draft')};
}

test('windows unsupported stop proof refuses without side effects',native,async()=>{
  const root=path.resolve(process.cwd());
  await assert.rejects(assertRecoverySourceStopped(root),error=>
    error.code==='RECOVERY_OWNER_UNVERIFIED'&&error.platform==='windows'&&error.status==='unsupported');
});

test('windows force-recovery preview refuses at the identity guard and preserves all state',native,async t=>{
  const f=await fixture(t);
  const draftBefore=await f.draft();
  await assert.rejects(f.recovery.preview(f.project),error=>
    error.code==='RECOVERY_OWNER_UNVERIFIED'&&error.platform==='windows'&&error.status==='unsupported');
  assert.deepEqual(await f.draft(),draftBefore);
  assert.deepEqual(await tree(f.metadata),f.before);
  assert.equal(f.storage.lifecycleHolds.size,0);
  assert.deepEqual(await f.storage.db.request(f.storage.catalog,'list',{collection:'force_recovery'}).catch(()=>[]),[]);
  await assert.rejects(fs.stat(path.join(f.storage.root,'force-recovery')),{code:'ENOENT'});
});

test('windows force-recovery execute refuses before any effect or catalog record',native,async t=>{
  const f=await fixture(t),operationId=randomUUID();
  const confirmation={projectId:f.project.id,operationId,instanceId:f.project.instanceId,root:f.root,
    source:{root:f.root,identity:null,metadata:null,registration:'x'},
    forceRecovery:{backupDirectory:path.join(f.storage.root,'force-recovery',operationId)}};
  const draftBefore=await f.draft();
  await assert.rejects(f.recovery.execute(confirmation),error=>
    error.code==='RECOVERY_OWNER_UNVERIFIED'&&error.platform==='windows'&&error.status==='unsupported');
  assert.deepEqual(await f.draft(),draftBefore);
  assert.deepEqual(await tree(f.metadata),f.before);
  assert.equal(f.storage.lifecycleHolds.size,0);
  assert.deepEqual(await f.storage.db.request(f.storage.catalog,'list',{collection:'force_recovery'}).catch(()=>[]),[]);
  await assert.rejects(fs.stat(path.join(f.storage.root,'force-recovery')),{code:'ENOENT'});
});
