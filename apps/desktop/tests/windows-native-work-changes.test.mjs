import test,{describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {WorkChanges} from '../src/agents/managed/work-changes.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {git,str,commitTree} from '../src/agents/managed/git-service.mjs';
import {security} from './fixtures/windows-security.mjs';
import {createExperimentalWorkChangesIO} from '../src/platform/windows/experimental-work-changes.mjs';
import {openExperimentalPrivateTree} from '../src/platform/windows/experimental-private-tree.mjs';
import {randomUUID} from 'node:crypto';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {ExecutionWorkspace} from '../src/agents/managed/execution-workspace.mjs';
import {readManagedState} from '../src/agents/managed/managed-storage.mjs';
import {validateReport} from '../src/agents/managed/report-review.mjs';
import {experimentalWindowsVersionedFilesystem as filesystem} from '../src/platform/windows/experimental-filesystem.mjs';
import {SessionIndex} from '../src/agents/managed/session-index.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t,{format='sha1'}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-changes-')),projectRoot=path.join(root,'项目 空格'),runtimeRoot=path.join(root,'runtime');await fs.mkdir(projectRoot);
 const storage=new ProjectStorage(path.join(root,'profile'),{experimentalWindowsRoot:root,experimentalWindowsInitialization:true});
 t.after(async()=>{await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 const projectId=(await storage.register(projectRoot)).id;
 await git(projectRoot,['init','--initial-branch=main','--object-format='+format]);await git(projectRoot,['config','core.autocrlf','false']);
 for(const [name,bytes]of Object.entries({'正文.md':'before\n','delete.txt':'gone\n','old.txt':'unique rename\n','user.txt':'original'}))await fs.writeFile(path.join(projectRoot,name),bytes);
 await git(projectRoot,['add','--','正文.md','delete.txt','old.txt','user.txt']);const inputCommit=await commitTree(projectRoot,await str(projectRoot,['write-tree']),[],'synthetic input',path.join(root,'messages'));await git(projectRoot,['update-ref','refs/heads/main',inputCommit]);
 await fs.writeFile(path.join(projectRoot,'正文.md'),'after without newline');await fs.unlink(path.join(projectRoot,'delete.txt'));await fs.rename(path.join(projectRoot,'old.txt'),path.join(projectRoot,'重命名 空格.txt'));await fs.writeFile(path.join(projectRoot,'empty.txt'),'');await fs.writeFile(path.join(projectRoot,'binary.bin'),Buffer.from([0,1,255]));
 await git(projectRoot,['add','--','正文.md','delete.txt','old.txt','重命名 空格.txt','empty.txt','binary.bin']);const candidateCommit=await commitTree(projectRoot,await str(projectRoot,['write-tree']),[inputCommit],'synthetic candidate',path.join(root,'messages'));await git(projectRoot,['update-ref','refs/heads/main',candidateCommit,inputCommit]);
 await fs.writeFile(path.join(projectRoot,'user.txt'),'user staged');await git(projectRoot,['add','--','user.txt']);await fs.writeFile(path.join(projectRoot,'user.txt'),'user disk draft');await storage.putRecovery(projectId,'draft','unsent draft');
 const state={receipts:[]},options={runtimeRoot,storage,projectId,state,experimentalWindowsRoot:root},changes=new WorkChanges(options),input={projectId,workId:'work-a',revision:1,jobId:'job-a',receiptId:'receipt-a',repo:projectRoot,commonDir:path.join(projectRoot,'.git'),inputCommit,candidateCommit};
 return {root,projectRoot,runtimeRoot,storage,projectId,state,options,changes,input,cold:()=>new WorkChanges(options)};
}
async function userState(f){return {head:await str(f.projectRoot,['rev-parse','HEAD']),index:await fs.readFile(path.join(f.projectRoot,'.git','index')),draft:await fs.readFile(path.join(f.projectRoot,'user.txt')),recovery:await f.storage.getRecovery(f.projectId,'draft')};}
async function pruneSource(f){await git(f.projectRoot,['update-ref','refs/heads/main',f.input.inputCommit,f.input.candidateCommit]);await git(f.projectRoot,['reflog','expire','--expire=now','--all']);await git(f.projectRoot,['gc','--prune=now']);await assert.rejects(str(f.projectRoot,['cat-file','-t',f.input.candidateCommit]));}
async function exitArchive(f,phase){
 const script=path.join(f.root,'archive-child.mjs');await fs.writeFile(script,`import {ProjectStorage} from ${JSON.stringify(new URL('../src/main/project-storage.mjs',import.meta.url).href)};import {WorkChanges} from ${JSON.stringify(new URL('../src/agents/managed/work-changes.mjs',import.meta.url).href)};
 const input=JSON.parse(process.argv[2]),storage=new ProjectStorage(input.profile,{experimentalWindowsRoot:input.root,experimentalWindowsInitialization:true});await storage.requireRegistered(input.binding.projectId);const changes=new WorkChanges({runtimeRoot:input.runtimeRoot,storage,projectId:input.binding.projectId,experimentalWindowsRoot:input.root}),io=changes.io;
 changes.io={...io,async writeJson(file,value){const result=await io.writeJson(file,value);if(input.phase==='intent'&&value.status==='archiving'||input.phase==='manifest'&&value.status==='verified')process.exit(91);return result;}};
 const put=storage.putProject.bind(storage);storage.putProject=async(...args)=>{const result=await put(...args);if(input.phase==='receipt'&&args[1]==='managed_change_sets')process.exit(91);return result;};await changes.capture(input.binding);await storage.db.close();`);
 const result=spawnSync(process.execPath,[script,JSON.stringify({root:f.root,profile:path.join(f.root,'profile'),runtimeRoot:f.runtimeRoot,binding:f.input,phase})],{encoding:'utf8',windowsHide:true,timeout:60000});assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,91,result.stdout+result.stderr);
 return (await fs.readdir(path.join(f.changes.root,'intents')))[0].replace(/\.json$/,'');
}
// Exercise real shared business methods/SQLite, without claiming Workspace.open
// or inventing host/process ownership. W2 remains the admission prerequisite.
async function businessStore(f){
 await f.changes.io.ensureDirectory(f.runtimeRoot);const store=new Workspace(f.runtimeRoot,f.projectRoot,null,null,{filesystem});
 Object.assign(store,{storage:f.storage,projectId:f.projectId,offline:false,operationId:randomUUID(),checkpoint:async()=>{}});
 store.state=await readManagedState(f.storage,f.projectId,{offline:false,onCollections:collections=>{store.committedCollections=collections;}});await new SessionIndex(store).initialize();return store;
}

describe('native shared WorkChanges archive',{concurrency:3},()=>{
for(const format of ['sha1','sha256'])test(`actual ${format} archive publishes immutable text/binary/rename/deletion objects and preserves user drafts`,native,async t=>{
 const f=await fixture(t,{format}),before=await userState(f),captured=await f.changes.capture(f.input);assert.equal(captured.verified,true);assert.equal(captured.total,5);
 const listed=await f.changes.list({changeSetId:captured.changeSetId}),byName=new Map(listed.files.map(file=>[file.path,file]));assert.equal(byName.get('重命名 空格.txt').status,'R');assert.equal(byName.get('重命名 空格.txt').oldPath,'old.txt');assert.equal(byName.get('delete.txt').after,null);
 const changed=await f.changes.read({changeSetId:captured.changeSetId,fileId:byName.get('正文.md').fileId});assert.equal(changed.before.text,'before\n');assert.equal(changed.after.text,'after without newline');assert.equal(changed.after.noFinalNewline,true);
 assert.equal((await f.changes.read({changeSetId:captured.changeSetId,fileId:byName.get('binary.bin').fileId})).availability,'unsupported');assert.deepEqual(await f.cold().verify(captured.changeSetId),captured);assert.deepEqual(await userState(f),before);
});

test('native archive refuses a pre-existing unrecorded private Git repository without adopting its bytes',native,async t=>{
 const f=await fixture(t);await f.changes.io.ensureDirectory(f.changes.root);await fs.mkdir(f.changes.evidenceRepo);await fs.writeFile(path.join(f.changes.evidenceRepo,'winner'),'independent');await assert.rejects(f.changes.capture(f.input),{code:'CHANGES_REPOSITORY_UNVERIFIED'});assert.equal(await fs.readFile(path.join(f.changes.evidenceRepo,'winner'),'utf8'),'independent');
});

test('portable native change-set closure survives real source GC and loss of the entire local evidence cache',native,async t=>{
 const f=await fixture(t),capture=await f.changes.capture(f.input),listed=await f.changes.list({changeSetId:capture.changeSetId}),file=listed.files.find(row=>row.path==='正文.md'),expected=await f.changes.read({changeSetId:capture.changeSetId,fileId:file.fileId});await pruneSource(f);await fs.rm(f.runtimeRoot,{recursive:true,force:true});assert.deepEqual(await f.cold().verify(capture.changeSetId),capture);assert.deepEqual(await f.cold().read({changeSetId:capture.changeSetId,fileId:file.fileId}),expected);
});

test('copied archive bytes in a replacement directory cannot adopt the saved full native root identity',native,async t=>{
 const f=await fixture(t),capture=await f.changes.capture(f.input),directory=f.changes.evidenceRepo;await fs.rename(directory,directory+'-retained');await f.changes.io.ensureDirectory(directory);await fs.cp(directory+'-retained',directory,{recursive:true});const config=await fs.readFile(path.join(directory,'config'));await assert.rejects(f.cold().capture(f.input),{code:'CHANGES_IDENTITY'});assert.deepEqual(await fs.readFile(path.join(directory,'config')),config);assert.deepEqual(await f.cold().verify(capture.changeSetId),capture);
});

test('a refused project receipt leaves a complete local archive that cold recovers after source GC',native,async t=>{
 const f=await fixture(t),put=f.storage.putProject.bind(f.storage);f.storage.putProject=async(...args)=>{if(args[1]==='managed_change_sets')throw Object.assign(Error('controlled project refusal'),{code:'PROJECT_UNAVAILABLE'});return put(...args);};await assert.rejects(f.changes.capture(f.input),{code:'PROJECT_UNAVAILABLE'});const id=(await fs.readdir(path.join(f.changes.root,'intents')))[0].slice(0,-5);assert.equal(await f.storage.getProject(f.projectId,'managed_change_sets',id),null);await pruneSource(f);f.storage.putProject=put;assert.equal((await f.cold().recover(id)).verified,true);
});

test('an actual committed SQLite archive receipt followed by callback failure is verified without duplicate publication',native,async t=>{
 const f=await fixture(t),put=f.storage.putProject.bind(f.storage);f.storage.putProject=async(...args)=>{const result=await put(...args);if(args[1]==='managed_change_sets')throw Error('controlled callback after actual commit');return result;};await assert.rejects(f.changes.capture(f.input),/controlled callback/);const rows=await f.storage.listProject(f.projectId,'managed_change_sets');assert.equal(rows.length,1);f.storage.putProject=put;const cold=await f.cold().recover(rows[0].id);assert.equal(cold.verified,true);assert.deepEqual(await f.changes.capture(f.input),cold);assert.equal((await f.storage.listProject(f.projectId,'managed_change_sets')).length,1);
});

for(const phase of ['intent','manifest','receipt'])test(`actual archive host exit after ${phase} preserves an explicit cold recovery path`,native,async t=>{
 const f=await fixture(t),id=await exitArchive(f,phase);if(phase!=='intent')await pruneSource(f);const result=await f.cold().recover(id);assert.equal(result.verified,true);assert.equal(result.changeSetId,id);assert.equal((await f.storage.listProject(f.projectId,'managed_change_sets')).length,1);
});

test('referenced or unconfirmed publication state refuses local evidence cleanup',native,async t=>{
 const f=await fixture(t),{changeSetId}=await f.changes.capture(f.input),bytes=await fs.readFile(f.changes.file(changeSetId));f.state.receipts.push({changeSetId});await assert.rejects(f.changes.discardUnpublished(changeSetId,f.input),{code:'CHANGES_REFERENCED'});await assert.rejects(new WorkChanges({...f.options,state:undefined}).discardUnpublished(changeSetId),{code:'CHANGES_RECOVERY_HELD'});assert.deepEqual(await fs.readFile(f.changes.file(changeSetId)),bytes);
});

test('unpublished local cleanup deletes exact private HANDLEs and leaves portable objects and receipt intact',native,async t=>{
 const f=await fixture(t),capture=await f.changes.capture(f.input);assert.deepEqual(await f.changes.discardUnpublished(capture.changeSetId,f.input),{changeSetId:capture.changeSetId,discarded:true});await assert.rejects(fs.stat(f.changes.file(capture.changeSetId)),{code:'ENOENT'});await assert.rejects(fs.stat(f.changes.file(capture.changeSetId,true)),{code:'ENOENT'});assert.deepEqual(await f.cold().verify(capture.changeSetId),capture);
});

test('broad local manifest ACL is refused without permission repair or evidence deletion',native,async t=>{
 const f=await fixture(t),{changeSetId}=await f.changes.capture(f.input),file=f.changes.file(changeSetId),bytes=await fs.readFile(file);security('add-write',file);const acl=security('inspect',file);await assert.rejects(f.cold().discardUnpublished(changeSetId),{code:'FS_SECURITY_CHANGED'});assert.deepEqual(security('inspect',file),acl);assert.deepEqual(await fs.readFile(file),bytes);
});

test('actual post-delete parent HANDLE closure retains committed uncertainty and immutable portable evidence',native,async t=>{
 const f=await fixture(t),capture=await f.changes.capture(f.input);let closed=false;f.changes.io=createExperimentalWorkChangesIO(f.root,{directorySync:parent=>{if(!closed&&parent.path.endsWith('\\sets\\')){closed=true;parent.close();}parent.syncDirectory();}});await assert.rejects(f.changes.discardUnpublished(capture.changeSetId),error=>error.code==='FS_HANDLE_CLOSED'&&error.committed===true&&error.archiveRemoval.removed===true);await assert.rejects(fs.stat(f.changes.file(capture.changeSetId)),{code:'ENOENT'});assert.ok((await fs.stat(f.changes.file(capture.changeSetId,true))).isFile());assert.deepEqual(await f.cold().verify(capture.changeSetId),capture);
});

test('read-only Git packs retain their attributes and a read-only tree cannot claim native file flushes or root publication',native,async t=>{
 const f=await fixture(t),{changeSetId}=await f.changes.capture(f.input),intent=await f.changes.io.readJson(f.changes.file(changeSetId,true));assert.equal(intent.localQualification.barriers.files,'not-flushed-by-this-lease');assert.equal(intent.localQualification.barriers.directories,'flushed');const tree=await openExperimentalPrivateTree(f.root,f.changes.evidenceRepo,{rootAccess:'readwrite',fileAccess:'read'});try{const pack=tree.manifest.entries.find(row=>row.relative.endsWith('.pack'));assert.ok(pack.attributes&1);await assert.rejects(tree.sync(),{code:'FS_HANDLE_REJECTED'});await assert.rejects(tree.publishTo(f.changes.evidenceRepo+'-moved'),{code:'FS_HANDLE_REJECTED'});assert.equal((await tree.syncDirectories()).barriers.files,'not-flushed-by-this-lease');}finally{tree.close();}
});

test('corrupt immutable blob is retained and cannot produce a successful archive verification',native,async t=>{
 const f=await fixture(t),{changeSetId}=await f.changes.capture(f.input),rows=(await f.changes.list({changeSetId})).files,entry=rows.find(row=>row.path==='正文.md'),objects=await f.storage.objects(f.projectId),file=objects.location(entry.after.object.digest);await fs.writeFile(file,'corrupt winner');await assert.rejects(f.cold().verify(changeSetId));assert.equal(await fs.readFile(file,'utf8'),'corrupt winner');
});

test('33 MiB blobs stream into the portable archive while report text remains bounded',native,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.projectRoot,'large.txt'),Buffer.alloc(33*1024*1024,120));await git(f.projectRoot,['add','--','large.txt']);const next=await commitTree(f.projectRoot,await str(f.projectRoot,['write-tree']),[f.input.candidateCommit],'synthetic large candidate',path.join(f.root,'messages'));await git(f.projectRoot,['update-ref','refs/heads/main',next,f.input.candidateCommit]);f.input.candidateCommit=next;const {changeSetId}=await f.changes.capture(f.input),entry=(await f.changes.list({changeSetId})).files.find(row=>row.path==='large.txt');assert.equal(entry.after.bytes,33*1024*1024);const read=await f.changes.read({changeSetId,fileId:entry.fileId});assert.equal(read.availability,'unavailable');assert.equal(read.reason,'byte-budget');assert.equal((await f.cold().verify(changeSetId)).verified,true);
});

test('shared business report and user decision ledger bind actual archive receipts to native Git acceptance across cold component reload',native,async t=>{
 const f=await fixture(t),store=await businessStore(f),submitted=await store.submit('synthetic request','synthetic brief');await store.activate(submitted.id);const work=store.find(submitted.id),execution=new ExecutionWorkspace(store,{filesystem,experimentalWindowsRoot:f.root}),m=await execution.prepare(work.id),job={id:'synthetic-job',target:work.id,revision:work.revision,status:'running'};await store.mutate(()=>{store.state.jobs=[job];});
 await fs.writeFile(path.join(m.directory,'正文.md'),'actual report candidate');const changes=new WorkChanges({...f.options,readState:()=>store.state}),receiptId='actual-report-receipt';let receipt;
 await execution.publish(work,job,()=>true,async(manifest,candidate)=>{
  const binding={projectId:f.projectId,workId:work.id,revision:work.revision,jobId:job.id,receiptId,repo:manifest.repo,commonDir:manifest.commonDir,inputCommit:manifest.inputCommit,candidateCommit:candidate.commit};
  receipt=await store.publish(work.id,work.revision,'result','<!doctype html><html><body><h1>Synthetic report</h1><p>Completed synthetic text edit.</p></body></html>',receiptId,{jobId:job.id,retainCandidate:async()=>{const retained=await changes.capture(binding);return {...retained,rollback:()=>changes.discardUnpublished(retained.changeSetId,binding)};}});return {changeSetId:receipt.changeSetId};
 },{receiptId});
 assert.equal((await validateReport(store,work)).reportObjectId,work.result.objectId);assert.equal((await f.storage.getProject(f.projectId,'managed_receipts',receiptId)).changeSetId,receipt.changeSetId);await store.setDraft('frontdesk','unsent business draft');await store.settle(work.id);
 const binding={workId:work.id,revision:work.revision,objectId:work.result.objectId,candidateCommit:work.execution.candidate.commit};await store.end(work.id,{by:'user',revision:work.revision,decision:'accept',binding,requestKey:'synthetic_accept_001'});
 const cold=await businessStore(f),saved=cold.find(work.id);assert.equal(saved.outcome,'accept');assert.equal(saved.closure.mergeAuthorization.objectId,receipt.objectId);assert.equal(saved.closure.mergeAuthorization.candidateCommit,binding.candidateCommit);const coldExecution=new ExecutionWorkspace(cold,{filesystem,experimentalWindowsRoot:f.root}),accepted=await coldExecution.finish(saved,{decision:saved.closure.decision,reportPersisted:true,mergeAuthorization:saved.closure.mergeAuthorization});
 assert.equal(accepted.status,'merged');await cold.mutate(()=>{saved.closure.git={...accepted,complete:true};});assert.equal(await fs.readFile(path.join(f.projectRoot,'正文.md'),'utf8'),'actual report candidate');const reopened=await businessStore(f);assert.equal(reopened.find(work.id).closure.git.commit,accepted.commit);assert.equal(reopened.state.drafts.frontdesk,'unsent business draft');assert.equal((await changes.verify(receipt.changeSetId)).verified,true);
});

test('actual shared business collection CAS retains an external winner, unsent draft and inspect-only reconciliation candidate',native,async t=>{
 const f=await fixture(t),store=await businessStore(f);await store.save();await store.setDraft('frontdesk','retained input');const other=await businessStore(f),winner=await other.submit('external request','external brief');await assert.rejects(store.submit('retained proposal','proposal brief'),{code:'STORAGE_CONFLICT'});const cold=await businessStore(f);assert.deepEqual(cold.state.works.map(work=>work.id),[winner.id]);assert.equal(cold.state.drafts.frontdesk,'retained input');const pending=(await store.listPending()).find(row=>row.kind==='business');assert.ok(pending);assert.equal(pending.automaticReplay,false);await assert.rejects(store.reconcilePending({pendingId:pending.id,requestKey:'synthetic_cas_reconcile'}),{code:'RECOVERY_CONFIRM_REQUIRED'});const result=await store.reconcilePending({pendingId:pending.id,requestKey:'synthetic_cas_reconcile',confirmed:true});assert.equal(result.accepted,true);const reconciled=await businessStore(f),proposal=reconciled.state.works.find(work=>work.id!==winner.id);assert.equal(reconciled.find(winner.id).request,'external request');assert.equal(proposal.status,'paused');assert.equal(proposal.automaticReplay,false);assert.equal(reconciled.state.drafts.frontdesk,'retained input');
});

test('a controlled lost callback after actual business SQLite commit fences the live instance and cold reconciliation never resumes the queued Work',native,async t=>{
 const f=await fixture(t),store=await businessStore(f);await store.save();await store.setDraft('frontdesk','unsent after unknown');const replace=f.storage.replaceProjectCollections.bind(f.storage);let once=true;f.storage.replaceProjectCollections=async(...args)=>{const result=await replace(...args);if(once){once=false;throw Object.assign(Error('controlled lost acknowledgment after actual SQLite commit'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:{source:'controlled-callback-after-commit'}});}return result;};
 await assert.rejects(store.submit('committed request','committed brief'),{code:'STORAGE_RESULT_UNKNOWN'});await assert.rejects(store.submit('must not replay','must not run'),{code:'STORAGE_RESULT_UNKNOWN'});f.storage.replaceProjectCollections=replace;const cold=await businessStore(f);assert.equal(cold.state.works.length,1);assert.equal(cold.state.works[0].request,'committed request');const page=await f.storage.recoveryPage(f.projectId,{prefixes:['managed:pending:'],pendingOnly:true,limit:200,maxBytes:1024*1024,purpose:'managed-pending'}),entry=page.entries.find(row=>row.id.startsWith('managed:pending:'));assert.ok(entry);const pending=(await f.storage.readRecoveryRecord(f.projectId,entry.id,{revision:entry.revision,version:page.version,purpose:'managed-pending'})).value;assert.ok(pending.commitUnknown);pending.id=entry.id;assert.equal(pending.automaticReplay,false);assert.equal((await cold.reconcilePending({pendingId:pending.id,requestKey:'synthetic_unknown_reconcile',confirmed:true})).accepted,true);const reopened=await businessStore(f);assert.equal(reopened.state.works.length,1);assert.equal(reopened.state.works[0].status,'paused');assert.equal(reopened.state.works[0].recoveryRequiresExplicitInput,true);assert.equal(reopened.state.drafts.frontdesk,'unsent after unknown');
});
});
