import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Controller} from '../src/agents/managed/controller.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {createExperimentalWindowsWorkspaceIO} from '../src/platform/windows/experimental-workspace-io.mjs';

test('bound explicit closure retry recovers after automatic maintenance meets a filesystem contender without replaying the decision',{skip:process.platform!=='win32'||process.arch!=='x64'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-explicit-closure-retry-'));
 const contentRoot=path.join(root,'project');await fs.mkdir(contentRoot);const storage=new ProjectStorage(path.join(root,'profile'),{experimentalWindowsRoot:root,experimentalWindowsInitialization:true}),projectId=(await storage.register(contentRoot)).id;
 const c=await Controller.open({storage,projectId,runtimeRoot:path.join(root,'runtime'),contentRoot,workspaceIO:createExperimentalWindowsWorkspaceIO({root})});
 t.after(async()=>{await c.stop();await storage.db.close();await fs.rm(root,{recursive:true,force:true});});c.kick=()=>{};
 const work=await c.store.submit('original request','original brief'),cleanup=c.store.cleanupWorkerHome.bind(c.store);let calls=0,contender=true;
 c.store.cleanupWorkerHome=async(...args)=>{calls++;if(calls===1)throw Error('lost cleanup acknowledgment');if(contender)throw Object.assign(Error('independent directory retained'),{code:'FS_DIRECTORY_CONFLICT'});return cleanup(...args);};
 await c.endWork(work.id,{revision:work.revision,decision:'discard'});
 const held=c.store.find(work.id),binding=structuredClone(held.closure.binding),authorization=held.closure.requestKey,bug=(await c.maintenance.read()).bugs.find(row=>row.phase==='closure');
 assert.equal(held.closure.phase,'blocked');assert.equal(bug.status,'human-boundary');assert.equal(calls,2);
 const requestKey='synthetic-explicit-closure-retry';await assert.rejects(c.retryClosure(work.id,{binding:{...binding,revision:binding.revision+1},requestKey}));assert.equal(calls,2);
 contender=false;const result=await c.retryClosure(work.id,{binding,requestKey});assert.equal(result.closure.phase,'complete');assert.equal(calls,3);assert.equal(result.closure.requestKey,authorization);assert.deepEqual(result.closure.binding,binding);assert.equal(c.store.find(work.id).outcome,'discard');assert.equal((await c.maintenance.read()).bugs.find(row=>row.id===bug.id).status,'repaired');
 assert.equal((await c.retryClosure(work.id,{binding,requestKey})).duplicate,true);assert.equal(calls,3);
});

