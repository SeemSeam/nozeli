import {openTestController} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {str} from '../src/agents/managed/git-service.mjs';
import {staticReport} from './static-report.fixture.mjs';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-report-candidate-'));const controller=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project')});t.after(async()=>{await controller.stop();await fs.rm(root,{recursive:true,force:true});});const work=await controller.store.submit('Candidate publication','Produce exact frozen evidence');await controller.store.activate(work.id);await controller.execution.prepare(work.id);const job={id:randomUUID(),target:work.id,revision:1,type:'initial',status:'running',context:{}};await controller.store.mutate(()=>controller.store.state.jobs.push(job));controller.current.set(work.id,job);const manifest=await controller.execution.readManifest(work.id);return {controller,work,job,manifest,root};}
async function evidenceSets(controller){try{return await fs.readdir(path.join(controller.changes.root,'sets'));}catch(error){if(error.code==='ENOENT')return [];throw error;}}
async function assertUnpublished(f){const {controller,work,manifest}=f,current=await controller.execution.readManifest(work.id);assert.equal(await str(manifest.repo,['rev-parse',manifest.branchRef]),manifest.inputCommit);assert.equal(current.candidate,undefined);assert.equal(current.publicationIntent,undefined);assert.equal(controller.store.find(work.id).execution.candidate,undefined);assert.equal(controller.store.state.receipts.length,0);assert.equal(controller.store.state.todos.filter(todo=>todo.kind==='result').length,0);assert.deepEqual(await evidenceSets(controller),[]);}
test('invalid HTML or undeclared report image rolls back candidate ref and never captures evidence',async t=>{const f=await fixture(t),{controller,work,manifest}=f;await fs.writeFile(path.join(manifest.directory,'candidate.txt'),'Candidate bytes');for(const html of ['<script>bad()</script>','<h1>Missing image</h1><img src="missing.svg" alt="missing">']){await assert.rejects(controller.onTool(work.id,{tool:'nozeli_publish',arguments:{kind:'result',html,files:[]},callId:randomUUID()}));await assertUnpublished(f);assert.equal(await fs.readFile(path.join(manifest.directory,'candidate.txt'),'utf8'),'Candidate bytes');}});
test('project transaction failure after capture removes unpublished evidence and restores exact candidate identity',async t=>{
 const f=await fixture(t),{controller,work,manifest}=f,{storage,projectId}=controller.store;
 await fs.writeFile(path.join(manifest.directory,'candidate.txt'),'Candidate bytes');
 const replace=storage.replaceProjectCollections.bind(storage);let failed=false;
 storage.replaceProjectCollections=async(id,collections,options)=>{
  if(collections.managed_receipts?.length&&!failed){failed=true;throw Object.assign(Error('Injected project transaction rejection'),{code:'INJECTED_PROJECT_COMMIT'});}
  return replace(id,collections,options);
 };
 try{await assert.rejects(controller.onTool(work.id,{tool:'nozeli_publish',arguments:{kind:'result',html:staticReport('Verified candidate'),files:['candidate.txt']},callId:'state-save-failure'}),error=>error.code==='INJECTED_PROJECT_COMMIT');}
 finally{storage.replaceProjectCollections=replace;}
 assert.equal(failed,true);await assertUnpublished(f);
 assert.deepEqual(await storage.listProject(projectId,'managed_receipts'),[]);
 const pending=(await controller.store.listPending()).find(row=>row.kind==='business'&&row.collections.managed_receipts?.length);
 assert(pending);assert.equal(pending.automaticReplay,false);assert.equal(pending.requiresConfirmation,true);
 const candidate=pending.collections.managed_receipts[0].value;
 assert((await storage.readObject(projectId,candidate.report.digest)).length);
 await controller.store.requireOnline();
 const saved=await controller.onTool(work.id,{tool:'nozeli_publish',arguments:{kind:'result',html:staticReport('Verified candidate'),files:['candidate.txt']},callId:'state-save-failure'});
 assert.equal(saved.saved,true);assert.equal(controller.store.state.receipts.length,1);assert.equal((await evidenceSets(controller)).length,1);
 const durable=await storage.getProject(projectId,'managed_receipts','state-save-failure');
 assert(durable);assert.equal(durable.report.digest,candidate.report.digest);
});
test('cancellation after candidate snapshot restores branch without deleting worktree edits',async t=>{const f=await fixture(t),{controller,work,manifest}=f;await fs.writeFile(path.join(manifest.directory,'candidate.txt'),'Keep unsaved candidate');const snapshot=controller.execution.snapshot.bind(controller.execution);controller.execution.snapshot=async(...args)=>{const value=await snapshot(...args);controller.current.delete(work.id);return value;};await assert.rejects(controller.onTool(work.id,{tool:'nozeli_publish',arguments:{kind:'result',html:staticReport('Cancelled candidate'),files:['candidate.txt']},callId:randomUUID()}),error=>error.code==='WORK_STOPPED');await assertUnpublished(f);assert.equal(await fs.readFile(path.join(manifest.directory,'candidate.txt'),'utf8'),'Keep unsaved candidate');});
test('unavailable project receipt authority preserves durable intent until a proven recovery decision',async t=>{
 const f=await fixture(t),{controller,work,job,manifest}=f,{storage,projectId}=controller.store;
 await fs.writeFile(path.join(manifest.directory,'candidate.txt'),'Preserved candidate');
 const get=storage.getProject.bind(storage);let unavailable=false;
 storage.getProject=async(id,collection,key)=>{
  if(unavailable&&id===projectId&&collection==='managed_receipts')throw Object.assign(Error('Injected unavailable receipt authority'),{code:'PROJECT_UNAVAILABLE'});
  return get(id,collection,key);
 };
 try{
  await assert.rejects(controller.execution.publish(controller.store.find(work.id),job,()=>true,async()=>{unavailable=true;throw Error('Injected callback failure');},{receiptId:'unknown-state'}),error=>error.code==='PUBLICATION_RECOVERY_HELD');
  const held=await controller.execution.readManifest(work.id);
  assert.equal(held.publicationIntent.receiptId,'unknown-state');
  assert.equal(await str(manifest.repo,['rev-parse',manifest.branchRef]),held.publicationIntent.candidate.commit);
  assert.equal(await fs.readFile(path.join(manifest.directory,'candidate.txt'),'utf8'),'Preserved candidate');
 }finally{storage.getProject=get;}
 assert.equal(await storage.getProject(projectId,'managed_receipts','unknown-state'),null);
 await controller.execution.prepare(work.id);await assertUnpublished(f);
});
test('failure after durable report commit retains candidate and recovers without replay',async t=>{
 const f=await fixture(t),{controller,work,job,manifest}=f,{storage,projectId}=controller.store;
 await fs.writeFile(path.join(manifest.directory,'candidate.txt'),'Published candidate');
 await assert.rejects(controller.execution.publish(controller.store.find(work.id),job,()=>true,async()=>{
  await controller.store.publish(work.id,1,'result',staticReport('Durably saved result'),'committed-report',{files:[{relPath:'candidate.txt'}]});
  throw Error('Injected post-commit failure');
 },{receiptId:'committed-report'}),error=>error.code==='PUBLICATION_COMMIT_UNKNOWN');
 const held=await controller.execution.readManifest(work.id),receipt=await storage.getProject(projectId,'managed_receipts','committed-report');
 assert(receipt);assert.equal(held.publicationIntent.candidate.commit,receipt.snapshot.candidate.commit);
 assert((await storage.readObject(projectId,receipt.report.digest)).length);
 await controller.execution.prepare(work.id);
 const recovered=await controller.execution.readManifest(work.id);
 assert.equal(recovered.publicationIntent,undefined);assert.equal(recovered.candidate.commit,receipt.snapshot.candidate.commit);
 assert.equal(await str(manifest.repo,['rev-parse',manifest.branchRef]),receipt.snapshot.candidate.commit);
 assert.equal((await storage.listProject(projectId,'managed_receipts')).length,1);
});
