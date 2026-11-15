import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ProjectLifecycle} from '../src/main/project-lifecycle.mjs';

async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-force-recovery-')),storage=new ProjectStorage(path.join(base,'app'));
 const root=path.join(base,'project');await fs.mkdir(root);const project=await storage.register(root);
 const host={storage,requireRegisteredProject:id=>storage.requireRegistered(id),requireProject:id=>storage.requireOnline(id)};
 const lifecycle=new ProjectLifecycle({host,workspace:{},managed:{projectStops:new Map()},trashItem:async()=>{}});
 t.after(async()=>{await storage.db.close();await fs.rm(base,{recursive:true,force:true});});return {base,root,storage,project,lifecycle};
}

test('force preview freezes valid root and never writes source',async t=>{
 const {root,project,lifecycle}=await fixture(t),before=await fs.readFile(path.join(root,'.nozeli','project.json'));
 const preview=await lifecycle.preview({projectId:project.id,action:'force-recover'});
 assert.equal(preview.action,'force-recover');assert.equal(preview.recoveryRetained,true);assert.equal(preview.permanentDelete,false);assert.equal(preview.forceRecovery.automaticReplay,false);
 assert.deepEqual(await fs.readFile(path.join(root,'.nozeli','project.json')),before);
 await assert.rejects(lifecycle.execute({token:preview.token}),{code:'FORCE_RECOVERY_CONFIRMATION_REQUIRED'});
});

test('force preview rejects stale root identity and missing metadata without deleting source',async t=>{
 const {root,project,lifecycle}=await fixture(t);await fs.rename(root,root+'-moved');
 await assert.rejects(lifecycle.preview({projectId:project.id,action:'force-recover'}));
});

test('force preview tolerates corrupt metadata and freezes a fresh recovery token',async t=>{
 const {root,project,lifecycle}=await fixture(t);const file=path.join(root,'.nozeli','project.json');await fs.writeFile(file,'{corrupt');
 const preview=await lifecycle.preview({projectId:project.id,action:'force-recover'});
 assert.equal(preview.currentProjectId,null);assert.equal(preview.forceRecovery.semanticInitializationEligible,false);assert.equal(preview.forceRecovery.enabled,false);
 assert.notEqual(preview.token,'');
});

test('force preview rejects an active unrelated hold',async t=>{
 const {project,storage,lifecycle}=await fixture(t);const hold=storage.holdProject(project.id,{operationId:'hold',instanceId:project.instanceId,action:'clean-local',root:project.root});
 await assert.rejects(lifecycle.preview({projectId:project.id,action:'force-recover'}),{code:'PROJECT_STOP_PENDING'});
 storage.lifecycleHolds.delete(project.id);hold.pendingCount=0;
});

test('force preview token is one-shot when execution is attempted',async t=>{
 const {project,lifecycle}=await fixture(t);const preview=await lifecycle.preview({projectId:project.id,action:'force-recover'});
 const first=await lifecycle.execute({token:preview.token,confirmForceRecovery:true});assert.equal(first.recovered,false);
 await assert.rejects(lifecycle.execute({token:preview.token,confirmForceRecovery:true}),{code:'LIFECYCLE_CONFIRMATION_EXPIRED'});
});
