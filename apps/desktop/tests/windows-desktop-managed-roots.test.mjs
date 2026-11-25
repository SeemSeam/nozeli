import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {SessionIndex} from '../src/agents/managed/session-index.mjs';
import {managedRuntime} from '../src/agents/managed/managed-storage.mjs';
import {createExecutionWorkspaceIO} from '../src/agents/managed/execution-workspace-io.mjs';
import {WorkChanges} from '../src/agents/managed/work-changes.mjs';
import {git,str,commitTree} from '../src/agents/managed/git-service.mjs';
import {createWindowsDesktopWorkspaceIO} from '../src/platform/windows/experimental-workspace-io.mjs';
import {security} from './fixtures/windows-security.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:60000};
async function fixture(t,{profilePadding=0}={}){
  // No common fixture root is supplied as an access authority.
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli managed profile 中文 '+'deep-profile-'.repeat(profilePadding))),content=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli managed project 中文 '));
  const storage=new ProjectStorage(profile,{windowsDesktopProjects:true}),project=await storage.register(content),projectId=project.id,runtime=await managedRuntime(storage,projectId),stores=[];
  t.after(async()=>{
    for(const store of stores)if(!store.closed)store.custody.abandon();
    assert(!(await storage.db.close()).some(value=>value?.closed===false),'Native DB close must be confirmed before fixture removal');
    await fs.rm(profile,{recursive:true,force:true});await fs.rm(content,{recursive:true,force:true});
  });
  const io=previousHostRelease=>createWindowsDesktopWorkspaceIO({storage,previousHostRelease});
  const options={storage,projectId};
  return {profile,content,storage,project,projectId,runtime,io,options,
    async open(extra={}){const store=await Workspace.open(runtime,content,{...options,workspaceIO:io(),...extra});stores.push(store);return store;},
    async controller(extra={}){const c=await Controller.open({...options,runtimeRoot:runtime,contentRoot:content,workspaceIO:io(),...extra});stores.push(c.store);return c;},
  };
}

test('desktop native Workspace spans separately authorized profile/project sources and preserves drafts, Work and immutable history',native,async t=>{
  const f=await fixture(t),store=await f.open(),facts=store.hostLease.facts();
  assert.equal(f.storage.nativeRootForPath(facts.source.catalog.file),f.profile);
  assert.equal(f.storage.nativeRootForPath(facts.source.projectDatabase.file),path.dirname(f.content));
  assert.equal(facts.source.projectDatabase.identity.value.projectId,f.projectId);
  assert.equal(store.io.qualification.productionSelected,false);assert.equal(store.io.qualification.coldRecoveryQualified,false);
  await store.setDraft('frontdesk','未发送内容 😀');const work=await store.submit('合成任务','尚未发送');
  const index=new SessionIndex(store);await index.initialize();const entry={id:'desktop-entry',type:'custom',customType:'synthetic',data:{text:'保留历史'}};
  await index.recordBatch([{sessionId:'synthetic',entry}],'frontdesk');assert.deepEqual(await index.object(index.records()[0]),entry);
  const receipt=await store.close();
  const controller=await f.controller({workspaceIO:f.io(receipt)});
  assert.equal(controller.store.state.drafts.frontdesk,'未发送内容 😀');assert.equal(controller.store.find(work.id).status,'queued');
  assert.equal(controller.sessions.size,0);assert.equal(controller.started,false);assert.equal(controller.store.state.jobs.length,0);
  const nextIndex=new SessionIndex(controller.store);await nextIndex.initialize();assert.deepEqual(await nextIndex.object(nextIndex.records()[0]),entry);
  assert.equal((await controller.stop()).confirmationComplete,true);
});

test('desktop runtime is fixed to the registered local instance before acquiring host custody',native,async t=>{
  const f=await fixture(t),other=path.join(f.profile,'wrong-runtime');
  await assert.rejects(Workspace.open(other,f.content,{...f.options,workspaceIO:f.io()}),{code:'WORKSPACE_IO_INVALID'});
  await assert.rejects(fs.stat(other),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(f.project.metadataRoot,'managed-host.lease')),{code:'ENOENT'});
  await assert.rejects(f.open({workspaceIO:{acquire(){assert.fail('unissued adapter');}}}),{code:'WORKSPACE_IO_INVALID'});
});

test('desktop Workspace adapter remains bound to its original storage authority',native,async t=>{
  const f=await fixture(t),other=new ProjectStorage(f.profile,{windowsDesktopProjects:true});
  try{
    await assert.rejects(Workspace.open(f.runtime,f.content,{storage:other,projectId:f.projectId,workspaceIO:f.io()}),{code:'WORKSPACE_IO_INVALID'});
    await assert.rejects(fs.stat(path.join(f.project.metadataRoot,'managed-host.lease')),{code:'ENOENT'});
  }finally{assert(!(await other.db.close()).some(value=>value?.closed===false));}
});

test('desktop execution evidence routes across profile/project and rejects another selected project or unrelated profile path',native,async t=>{
  const f=await fixture(t),store=await f.open(),io=createExecutionWorkspaceIO(store.io.executionWorkspaceOptions),manifest=path.join(f.runtime,'evidence','synthetic.json');
  await io.writeJson(manifest,{retained:'原件'});
  const projectEvidence=path.join(f.project.metadataRoot,'synthetic-execution.json');await io.copyFile(manifest,projectEvidence);
  assert.deepEqual(await io.readJson(projectEvidence),{retained:'原件'});
  await store.io.writeImmutable(path.join(f.runtime,'evidence','second.json'),Buffer.from('independent winner'));
  await assert.rejects(io.copyFile(path.join(f.runtime,'evidence','second.json'),projectEvidence),{code:'EXECUTION_EVIDENCE_CONFLICT'});
  assert.deepEqual(await io.readJson(projectEvidence),{retained:'原件'});
  const sibling=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli other managed project '));
  try{
    const other=await f.storage.register(sibling);
    for(const file of [path.join(other.metadataRoot,'foreign.json'),path.join(f.profile,'foreign.json')]){
      await assert.rejects(io.writeJson(file,{foreign:true}),{code:'FS_PATH_REJECTED'});await assert.rejects(fs.stat(file),{code:'ENOENT'});
    }
  }finally{await store.close();await f.storage.db.close();await fs.rm(sibling,{recursive:true,force:true});}
  await assert.rejects(io.readJson(manifest),{code:'WORKSPACE_IO_CLOSED'});
});

test('real catalog revision winner fences desktop managed mutations before their callback',native,async t=>{
  const f=await fixture(t),store=await f.open();await store.setDraft('frontdesk','竞争前草稿');
  const row=await f.storage.db.request(f.storage.catalog,'record',{collection:'instances',id:f.projectId,mustExist:true});
  await f.storage.db.request(f.storage.catalog,'put',{collection:'instances',id:f.projectId,value:row.value,expectedRevision:row.revision});
  let called=false;await assert.rejects(store.mutate(()=>{called=true;}),{code:'HOST_SOURCE_CHANGED'});
  assert.equal(called,false);assert.deepEqual(await f.storage.getRecovery(f.projectId,'managed:drafts'),{frontdesk:'竞争前草稿'});
});

test('desktop profile runtime ACL drift refuses mutations and retains recovery drafts',native,async t=>{
  const f=await fixture(t),store=await f.open();await store.setDraft('frontdesk','ACL 前草稿');security('add-write',f.runtime);let called=false;
  await assert.rejects(store.mutate(()=>{called=true;}),{code:'FS_STAGE_CHANGED'});assert.equal(called,false);
  assert.deepEqual(await f.storage.getRecovery(f.projectId,'managed:drafts'),{frontdesk:'ACL 前草稿'});
});

test('desktop managed storage lost postcommit custody retains UNKNOWN without replay or fabricated retirement',native,async t=>{
  const f=await fixture(t),store=await f.open(),put=f.storage.putRecovery.bind(f.storage);let commits=0;
  f.storage.putRecovery=async(...args)=>{const result=await put(...args);if(args[1]==='managed:drafts'){commits++;store.custody.abandon();}return result;};
  await assert.rejects(store.setDraft('frontdesk','已提交未确认'),{code:'STORAGE_RESULT_UNKNOWN'});
  assert.equal(commits,1);assert.ok(store.commitUnknown);assert.deepEqual(await f.storage.getRecovery(f.projectId,'managed:drafts'),{frontdesk:'已提交未确认'});
  await assert.rejects(store.close(),{code:'STORAGE_RESULT_UNKNOWN'});await assert.rejects(f.open(),{code:'HOST_LEASE_RECOVERY_REQUIRED'});
  assert.equal(commits,1);
});

test('whole-process desktop durable normal restart reacquires receipt-less custody, retains the exact unsent draft and never replays; serialized receipts still refuse',native,async t=>{
  const f=await fixture(t),store=await f.open();await store.setDraft('frontdesk','冷启动必须保留的未发送草稿');const receipt=await store.close();
  await assert.rejects(f.open({workspaceIO:f.io(structuredClone(receipt))}),{code:'HOST_LEASE_RECOVERY_REQUIRED'});
  await f.storage.db.close();
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/windows-desktop-managed-child.mjs',import.meta.url)),f.profile,f.projectId,receipt.record.leaseId],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()),{durableRestart:true,freshHost:true,completionVerified:true,draftRetained:true,automaticReplay:false});
});

test('desktop native archive publishes real refs beyond MAX_PATH without writing Git long-path configuration',native,async t=>{
  const f=await fixture(t,{profilePadding:2}),file=path.join(f.content,'正文.md');
  await fs.writeFile(file,'before');await git(f.content,['init','--initial-branch=main']);await git(f.content,['add','--','正文.md']);
  const inputCommit=await commitTree(f.content,await str(f.content,['write-tree']),[],'synthetic input',path.join(f.content,'.git','messages'));await git(f.content,['update-ref','refs/heads/main',inputCommit]);
  await fs.writeFile(file,'after');await git(f.content,['add','--','正文.md']);const candidateCommit=await commitTree(f.content,await str(f.content,['write-tree']),[inputCommit],'synthetic candidate',path.join(f.content,'.git','messages'));await git(f.content,['update-ref','refs/heads/main',candidateCommit]);
  const changes=new WorkChanges({runtimeRoot:f.runtime,storage:f.storage,projectId:f.projectId,experimentalWindowsRoot:f.profile});
  assert.ok(path.join(changes.evidenceRepo,'refs','nozeli','changes','cs_'+'0'.repeat(64),'candidate.lock').length>260,'real ref lock must exceed MAX_PATH');
  const captured=await changes.capture({projectId:f.projectId,workId:'synthetic-work',revision:1,jobId:'synthetic-job',receiptId:'synthetic-report',repo:f.content,commonDir:path.join(f.content,'.git'),inputCommit,candidateCommit});
  assert.equal(captured.verified,true);assert.equal((await changes.verify(captured.changeSetId)).verified,true);
  assert.equal(await changes.evidenceText(['rev-parse','refs/nozeli/changes/'+captured.changeSetId+'/candidate']),candidateCommit);
  for(const config of [path.join(f.content,'.git','config'),path.join(changes.evidenceRepo,'config')])assert.doesNotMatch(await fs.readFile(config,'utf8'),/longpaths/i);
  assert.equal(await fs.readFile(file,'utf8'),'after');
});

test('overlong bare archive directory refuses before allocating archive files or altering retained project input',native,async t=>{
  const f=await fixture(t,{profilePadding:7}),changes=new WorkChanges({runtimeRoot:f.runtime,storage:f.storage,projectId:f.projectId,experimentalWindowsRoot:f.profile});
  assert.ok(Buffer.byteLength(changes.evidenceRepo,'utf8')>=248);
  await f.storage.putRecovery(f.projectId,'draft',{text:'保留原输入'});
  await assert.rejects(changes.initialize('sha1'),{code:'CHANGES_PATH_UNSUPPORTED'});
  await assert.rejects(fs.stat(changes.root),{code:'ENOENT'});
  assert.deepEqual(await f.storage.getRecovery(f.projectId,'draft'),{text:'保留原输入'});
});
