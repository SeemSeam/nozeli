import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ExecutionWorkspace} from '../src/agents/managed/execution-workspace.mjs';
import {git,str} from '../src/agents/managed/git-service.mjs';
import {openTestWorkspace} from './project-storage.fixture.mjs';

async function fixture(t,{plain=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-managed-tree-')),project=path.join(root,'project');await fs.mkdir(project);let store;t.after(async()=>{await store?.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(path.join(project,'worker.txt'),'base\n');await fs.writeFile(path.join(project,'user.txt'),'user base\n');await fs.writeFile(path.join(project,'.gitignore'),'ignored/\n.nozeli/\n');
 if(!plain){await git(project,['init','--initial-branch=main']);await git(project,['add','.']);await git(project,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','initial']);}
 store=await openTestWorkspace(path.join(root,'runtime'),project);
 const execution=new ExecutionWorkspace(store),work={id:'work-a',revision:1,threadId:'thread-a',result:{objectId:'fixture-report-a',revision:1}};store.state.works.push(work);
 return {root,project,store,execution,work,write:(rel,text)=>fs.writeFile(path.join(project,rel),text),read:rel=>fs.readFile(path.join(project,rel),'utf8')};
}
// 与生产一致的类型化合入授权：从清单与工作身份构造（接受路径强制授权，
// 无授权不合入）。测试用它模拟“与接受决定同事务落账”的授权记录。
const authorization=async(f,work)=>{
 const m=await f.execution.readManifest(work.id);
 return {schema:1,workId:work.id,revision:work.revision,objectId:work.result.objectId,candidateCommit:m.candidate.commit,reviewVersion:null,repo:m.repo,commonDir:m.commonDir,targetRef:m.targetRef,targetHead:m.targetHead,basis:'user-accept',consentRequired:false,at:new Date().toISOString()};
};
const finish=(f,decision='accept',options={})=>(async()=>{
 const args={decision,reportPersisted:true,isActive:()=>false,...options};
 if(decision==='accept'&&options.mergeAuthorization===undefined)args.mergeAuthorization=await authorization(f,options.work??f.work);
 return f.execution.finish(options.work??f.work,args);
})();
async function candidate(f,text='worker result\n'){await f.execution.prepare(f.work.id);await fs.writeFile(path.join(f.execution.directory(f.work.id),'worker.txt'),text);return f.execution.publish(f.work,{id:'job-1'},()=>true);}

test('creates a registered worktree, freezes actual user input and never publishes to original on report',async t=>{
 const f=await fixture(t);await f.write('user.txt','user disk input\n');await f.write('untracked.txt','input only\n');await fs.mkdir(path.join(f.project,'ignored'));await f.write('ignored/build.txt','generated');const head=await str(f.project,['rev-parse','HEAD']),index=await fs.readFile(path.join(f.project,'.git','index'));
 const m=await f.execution.prepare(f.work.id);assert.equal(m.schema,2);assert.equal(m.targetHead,head);assert.equal(await str(m.directory,['rev-parse','--git-common-dir']),m.commonDir);assert.equal(await fs.readFile(path.join(m.directory,'user.txt'),'utf8'),'user disk input\n');await assert.rejects(fs.stat(path.join(m.directory,'ignored')));
 const result=await candidate(f);assert.deepEqual(result.applied,[]);assert.equal(await f.read('worker.txt'),'base\n');assert.equal(await str(f.project,['rev-parse','HEAD']),head);assert.deepEqual(await fs.readFile(path.join(f.project,'.git','index')),index);assert.deepEqual(result.candidate.files,['worker.txt']);
 const reopened=new ExecutionWorkspace(f.store);assert.equal((await reopened.prepare(f.work.id)).candidate.commit,result.candidate.commit);assert.equal((await reopened.prepare(f.work.id)).directory,m.directory);
});
test('accept integrates only Worker delta and preserves unrelated staged dirty untracked material',async t=>{
 const f=await fixture(t);await f.write('user.txt','user staged\n');await git(f.project,['add','user.txt']);await f.write('user.txt','user dirty after staging\n');await f.write('untracked.txt','user input\n');await candidate(f);
 const receipt=await finish(f);assert.equal(receipt.status,'merged');assert.equal(await f.read('worker.txt'),'worker result\n');assert.equal(await f.read('user.txt'),'user dirty after staging\n');assert.equal(await str(f.project,['show',':user.txt']),'user staged');assert.equal(await str(f.project,['show','HEAD:user.txt']),'user base');assert.equal(await f.read('untracked.txt'),'user input\n');await assert.rejects(str(f.project,['show','HEAD:untracked.txt']));await assert.rejects(fs.stat(f.execution.directory(f.work.id)));assert.deepEqual(receipt.operations.map(o=>o.relPath),['worker.txt']);
 const count=await str(f.project,['rev-list','--count','HEAD']);assert.deepEqual(await new ExecutionWorkspace(f.store).finish(f.work,{decision:'accept',reportPersisted:true}),receipt);assert.equal(await str(f.project,['rev-list','--count','HEAD']),count);
});
test('blocks same-file user input overlays and later staging without changing target or deleting candidate',async t=>{
 const f=await fixture(t);await f.write('worker.txt','user overlay\n');await candidate(f);await assert.rejects(finish(f),{code:'INPUT_OVERLAP'});assert.equal(await f.read('worker.txt'),'user overlay\n');assert(await fs.stat(f.execution.directory(f.work.id)));
 const g=await fixture(t);await candidate(g);await g.write('worker.txt','new staged user\n');await git(g.project,['add','worker.txt']);await assert.rejects(finish(g),{code:'USER_STAGED'});assert.equal(await g.read('worker.txt'),'new staged user\n');
});
test('blocks external HEAD drift and dirty files without guessing current target',async t=>{
 const f=await fixture(t);await candidate(f);await f.write('user.txt','external commit');await git(f.project,['add','user.txt']);await git(f.project,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','external']);await assert.rejects(finish(f),{code:'HEAD_DRIFT'});assert.equal(await f.read('worker.txt'),'base\n');
 const g=await fixture(t);await candidate(g);await g.write('worker.txt','user concurrent');await assert.rejects(finish(g),{code:'USER_DIRTY'});assert.equal(await g.read('worker.txt'),'user concurrent');
});
test('disjoint works accepted concurrently serialize through known managed publication lineage',async t=>{
 const f=await fixture(t),b={id:'work-b',revision:1,result:{objectId:'fixture-report-b',revision:1}};f.store.state.works.push(b);await f.execution.prepare(f.work.id);await f.execution.prepare(b.id);await candidate(f);await fs.writeFile(path.join(f.execution.directory(b.id),'user.txt'),'worker B\n');await f.execution.publish(b,{id:'job-b'});
 await Promise.all([finish(f),finish(f,'accept',{work:b})]);assert.equal(await f.read('worker.txt'),'worker result\n');assert.equal(await f.read('user.txt'),'worker B\n');assert.equal(await str(f.project,['rev-list','--count','HEAD']),'3');
});
test('explicit discard alone deletes owned resources and never target or unrelated refs',async t=>{
 const f=await fixture(t);const {candidate:c}=await candidate(f),m=await f.execution.readManifest(f.work.id);await git(f.project,['branch','user-branch']);await assert.rejects(finish(f,'discard',{reportPersisted:false}),{code:'REPORT_REQUIRED'});await assert.rejects(finish(f,'discard',{isActive:()=>true}),{code:'WORK_ACTIVE'});assert.equal((await finish(f,'discard')).status,'discarded');assert.equal(await f.read('worker.txt'),'base\n');await assert.rejects(str(f.project,['rev-parse','--verify',m.branchRef]));assert(await str(f.project,['rev-parse','refs/heads/user-branch']));assert(await str(f.project,['cat-file','-t',c.commit]));
});
test('unsafe pointer, symlink, drafts, unpublished bytes and user hook policy block with resources intact',async t=>{
 const f=await fixture(t);await candidate(f);await assert.rejects(finish(f,'accept',{validateAcceptance:async()=>{throw Object.assign(Error('draft'),{code:'UNSAVED'});}}),{code:'UNSAVED'});assert.equal(await f.read('worker.txt'),'base\n');
 await fs.writeFile(path.join(f.execution.directory(f.work.id),'worker.txt'),'post-report');await assert.rejects(finish(f),{code:'UNPUBLISHED_CHANGES'});
 const g=await fixture(t);await candidate(g);await fs.writeFile(path.join(g.project,'.git','hooks','pre-commit'),'#!/bin/sh\necho rejection-evidence >&2\nexit 1\n',{mode:0o755});await assert.rejects(finish(g),error=>error.code==='HOOK_REJECTED'&&error.message.includes('rejection-evidence'));assert.equal(await g.read('worker.txt'),'base\n');
 const h=await fixture(t);await h.execution.prepare(h.work.id);await fs.unlink(path.join(h.execution.directory(h.work.id),'worker.txt'));await fs.symlink(path.join(h.project,'user.txt'),path.join(h.execution.directory(h.work.id),'worker.txt'));await assert.rejects(h.execution.publish(h.work,{id:'job'}));
 const k=await fixture(t);await candidate(k);await fs.writeFile(path.join(k.execution.directory(k.work.id),'.git'),'gitdir: /tmp/foreign\n');await assert.rejects(finish(k,'discard'),{code:'IDENTITY_CHANGED'});assert(await fs.stat(k.execution.directory(k.work.id)));
});
test('cold retry recovers published ref/index stage without duplicate adoption commit',async t=>{
 const f=await fixture(t);await candidate(f);const save=f.execution.save.bind(f.execution);let interrupted=false;f.execution.save=async m=>{await save(m);if(!interrupted&&m.finishIntent?.status==='ref-published'){interrupted=true;throw Error('simulated host interruption');}};
 await assert.rejects(finish(f),/simulated host interruption/);const head=await str(f.project,['rev-parse','HEAD']),count=await str(f.project,['rev-list','--count','HEAD']);f.execution=new ExecutionWorkspace(f.store);await f.execution.recoverOperations();const receipt=await finish(f);assert.equal(receipt.commit,head);assert.equal(await str(f.project,['rev-list','--count','HEAD']),count);assert.equal(await str(f.project,['show',':worker.txt']),'worker result');
});
test('uncertain external index change retains durable integration intent and worktree',async t=>{
 const f=await fixture(t);await candidate(f);const save=f.execution.save.bind(f.execution);let interrupted=false;f.execution.save=async m=>{await save(m);if(!interrupted&&m.finishIntent?.status==='prepared'){interrupted=true;throw Error('interrupted');}};await assert.rejects(finish(f),/interrupted/);await f.write('user.txt','external stage');await git(f.project,['add','user.txt']);f.execution=new ExecutionWorkspace(f.store);await assert.rejects(finish(f),{code:'INDEX_CHANGED'});assert((await f.execution.readManifest(f.work.id)).finishIntent);assert(await fs.stat(f.execution.directory(f.work.id)));assert.equal(await f.read('worker.txt'),'base\n');
});
test('plain project is provisioned automatically with safe baseline and secrets excluded',async t=>{
 const f=await fixture(t,{plain:true});await f.write('.env','secret');await fs.mkdir(path.join(f.project,'node_modules'));await f.write('node_modules/pkg','generated');await f.execution.prepare(f.work.id);assert(await str(f.project,['rev-parse','HEAD']));await assert.rejects(fs.stat(path.join(f.execution.directory(f.work.id),'.env')));await assert.rejects(fs.stat(path.join(f.execution.directory(f.work.id),'node_modules')));assert.equal(await f.read('.env'),'secret');
});
test('worktree document edits require own read handle and never touch original',async t=>{
 const f=await fixture(t),r=await f.execution.documentOperation({work:f.work,op:'read',arguments:{relPath:'worker.txt'}});assert(r.ok);const result=await f.execution.documentOperation({work:f.work,op:'apply',callId:'edit-1',arguments:{readHandle:r.value.readHandle,replacements:[{oldText:'base',newText:'changed'}]}});assert(result.ok,JSON.stringify(result));assert.equal(await f.read('worker.txt'),'base\n');assert.equal(await fs.readFile(path.join(f.execution.directory(f.work.id),'worker.txt'),'utf8'),'changed\n');
});

test('preparation and freeze intentions resume without duplicate worktrees or candidate loss',async t=>{
 const f=await fixture(t),save=f.execution.save.bind(f.execution);let failed=false;f.execution.save=async m=>{await save(m);if(!failed&&m.preparation==='input-frozen'){failed=true;throw Error('prepare interrupted');}};
 await assert.rejects(f.execution.prepare(f.work.id),/prepare interrupted/);const before=await f.execution.readManifest(f.work.id);f.execution=new ExecutionWorkspace(f.store);const resumed=await f.execution.prepare(f.work.id);assert.equal(resumed.branchRef,before.branchRef);assert.equal(resumed.inputCommit,before.inputCommit);assert.equal(resumed.preparation,'complete');
 const persist=f.execution.save.bind(f.execution);failed=false;f.execution.save=async m=>{await persist(m);if(!failed&&m.freezeIntent){failed=true;throw Error('freeze interrupted');}};await fs.writeFile(path.join(resumed.directory,'worker.txt'),'frozen result');await assert.rejects(f.execution.publish(f.work,{id:'job'}),/freeze interrupted/);const intended=(await f.execution.readManifest(f.work.id)).freezeIntent.commit;f.execution=new ExecutionWorkspace(f.store);assert.equal((await f.execution.prepare(f.work.id)).candidate.commit,intended);assert.equal(await f.read('worker.txt'),'base\n');
});
test('legacy copy migration preserves new files and evidence; old force is never deletion authority',async t=>{
 const f=await fixture(t),dir=f.execution.directory(f.work.id),manifest=f.execution.manifest(f.work.id);await fs.mkdir(dir,{recursive:true});await fs.mkdir(path.dirname(manifest),{recursive:true});await fs.writeFile(path.join(dir,'worker.txt'),'legacy candidate');await fs.writeFile(path.join(dir,'new.txt'),'legacy new file');await fs.writeFile(manifest,JSON.stringify({schema:1,workId:f.work.id,files:{'worker.txt':{digest:'old'}},operations:[]}));
 await assert.rejects(finish(f,'discard'),{code:'LEGACY_DISPOSITION'});const m=await f.execution.prepare(f.work.id);assert.equal(await fs.readFile(path.join(m.directory,'new.txt'),'utf8'),'legacy new file');assert.equal(await fs.readFile(path.join(m.legacy.directory,'worker.txt'),'utf8'),'legacy candidate');assert.equal(await f.read('worker.txt'),'base\n');await f.execution.publish(f.work,{id:'migration-report'});await finish(f,'discard');assert.equal(await fs.readFile(path.join(m.legacy.directory,'new.txt'),'utf8'),'legacy new file');
});
test('Worker deletions are accepted without staging unrelated input',async t=>{
 const f=await fixture(t);await f.execution.prepare(f.work.id);await fs.unlink(path.join(f.execution.directory(f.work.id),'worker.txt'));await f.execution.publish(f.work,{id:'delete'});await finish(f);await assert.rejects(fs.stat(path.join(f.project,'worker.txt')));await assert.rejects(str(f.project,['show','HEAD:worker.txt']));
});

test('successful hooks run against private integration index; hook changes never enter approved result',async t=>{
 const f=await fixture(t);await f.write('user.txt','user staged');await git(f.project,['add','user.txt']);await candidate(f);await fs.writeFile(path.join(f.project,'.git','hooks','pre-commit'),'#!/bin/sh\ntest "$(git show :user.txt)" = "user base" || exit 7\ntest "$(cat worker.txt)" = "worker result" || exit 8\n',{mode:0o755});await finish(f);assert.equal(await str(f.project,['show',':user.txt']),'user staged');
 const g=await fixture(t);await candidate(g);await fs.writeFile(path.join(g.project,'.git','hooks','pre-commit'),'#!/bin/sh\nprintf "hook change" > worker.txt\ngit add worker.txt\n',{mode:0o755});await assert.rejects(finish(g),{code:'HOOK_CHANGED'});assert.equal(await g.read('worker.txt'),'base\n');assert(await fs.stat(g.execution.directory(g.work.id)));
});

test('never-started queued discard records outcome without provisioning a worktree',async t=>{
 const f=await fixture(t);f.work.revision=0;const receipt=await finish(f,'discard');assert.deepEqual(receipt,{status:'discarded',cleaned:true,reason:'never-started'});await assert.rejects(fs.stat(f.execution.directory(f.work.id)));assert.equal((await f.execution.readManifest(f.work.id)).receipt.status,'discarded');
});

test('created repository resumes after init with populated index, not staged baseline deletions',async t=>{
 const f=await fixture(t,{plain:true});await git(f.project,['init','--initial-branch=main']);await fs.mkdir(path.join(f.store.root,'evidence'),{recursive:true});await fs.writeFile(path.join(f.store.root,'evidence','repository-init.json'),JSON.stringify({repo:f.project,created:true,status:'requested'}));await f.execution.prepare(f.work.id);assert.equal(await str(f.project,['status','--porcelain']),'');assert.equal(await str(f.project,['show',':worker.txt']),'base');
});
test('target ref lock failure never writes Worker bytes into original files',async t=>{
 const f=await fixture(t);await candidate(f);const refLock=path.join(f.project,'.git','refs','heads','main.lock');await fs.writeFile(refLock,'external lock');await assert.rejects(finish(f));assert.equal(await f.read('worker.txt'),'base\n');assert(await fs.stat(f.execution.directory(f.work.id)));await fs.unlink(refLock);await finish(f);assert.equal(await f.read('worker.txt'),'worker result\n');
});
test('snapshot hashes captured bytes rather than reopening mutable Worker pathname',async t=>{
 const f=await fixture(t);await f.execution.prepare(f.work.id);const dir=f.execution.directory(f.work.id);await fs.mkdir(path.join(dir,'nested'));await fs.writeFile(path.join(dir,'nested','out.txt'),'safe captured');const outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'out.txt'),'HOST SECRET');const blob=f.execution.blob.bind(f.execution);let changed=false;f.execution.blob=async(cwd,bytes)=>{if(bytes.toString()==='safe captured'&&!changed){changed=true;await fs.rename(path.join(dir,'nested'),path.join(dir,'nested-held'));await fs.symlink(outside,path.join(dir,'nested'));}return blob(cwd,bytes);};await assert.rejects(f.execution.publish(f.work,{id:'race'}));assert.equal(await f.read('worker.txt'),'base\n');assert.equal((await f.execution.readManifest(f.work.id)).candidate,undefined);
});
test('completed hook commit is recovered without executing hooks again',async t=>{
 const f=await fixture(t);await candidate(f);await fs.writeFile(path.join(f.project,'.git','hooks','pre-commit'),'#!/bin/sh\nprintf x >> .git/hook-count\n',{mode:0o755});const save=f.execution.save.bind(f.execution);let failed=false;f.execution.save=async m=>{if(!failed&&m.acceptancePreparation?.status==='complete'){failed=true;throw Error('crash after hook commit');}await save(m);};await assert.rejects(finish(f),/crash after hook commit/);const m=await f.execution.readManifest(f.work.id),shadow=m.acceptancePreparation.shadow;assert.equal(await fs.readFile(path.join(shadow,'.git','hook-count'),'utf8'),'x');f.execution=new ExecutionWorkspace(f.store);await finish(f);assert.equal(await fs.readFile(path.join(shadow,'.git','hook-count'),'utf8'),'x');assert.equal(await f.read('worker.txt'),'worker result\n');
});

test('exact target ref stays locked through file and index publication',async t=>{
 const f=await fixture(t);await candidate(f);const save=f.execution.save.bind(f.execution);let observed=false;f.execution.save=async m=>{await save(m);if(m.finishIntent?.status==='files-installed'&&!observed){observed=true;await assert.rejects(git(f.project,['update-ref','refs/heads/main',m.baseCommit]),error=>String(error.stderr||error.message).includes('lock'));assert.equal(await f.read('worker.txt'),'worker result\n');assert.equal(await str(f.project,['show',':worker.txt']),'worker result');}};await finish(f);assert(observed);assert.equal(await str(f.project,['show','HEAD:worker.txt']),'worker result');
});
test('failed ref publication rolls back original bytes and index while retaining intent',async t=>{
 const f=await fixture(t);await f.write('user.txt','unrelated staged');await git(f.project,['add','user.txt']);await candidate(f);const beforeIndex=await fs.readFile(path.join(f.project,'.git','index')),head=await str(f.project,['rev-parse','HEAD']),save=f.execution.save.bind(f.execution);let interrupted=false;f.execution.save=async m=>{await save(m);if(m.finishIntent?.status==='files-installed'&&!interrupted){interrupted=true;throw Error('publication interrupted');}};await assert.rejects(finish(f),/publication interrupted/);assert.equal(await f.read('worker.txt'),'base\n');assert.deepEqual(await fs.readFile(path.join(f.project,'.git','index')),beforeIndex);assert.equal(await str(f.project,['rev-parse','HEAD']),head);assert.equal((await f.execution.readManifest(f.work.id)).finishIntent.status,'prepared');f.execution=new ExecutionWorkspace(f.store);await finish(f);assert.equal(await f.read('worker.txt'),'worker result\n');
});
test('mode-only Worker change installs executable mode and matching Git tree',async t=>{
 const f=await fixture(t);await f.execution.prepare(f.work.id);await fs.chmod(path.join(f.execution.directory(f.work.id),'worker.txt'),0o755);const published=await f.execution.publish(f.work,{id:'mode'});assert.deepEqual(published.candidate.files,['worker.txt']);await finish(f);assert.equal((await fs.stat(path.join(f.project,'worker.txt'))).mode&0o111,0o111);assert.match(await str(f.project,['ls-tree','HEAD','worker.txt']),/^100755 /);assert.equal(await f.read('worker.txt'),'base\n');
});

test('document missing quotes and surrogate-splitting replacements preserve original and Worker bytes',async t=>{
 const f=await fixture(t);await f.execution.prepare(f.work.id);const file=path.join(f.execution.directory(f.work.id),'worker.txt');await fs.writeFile(file,'abc😀\n');const invoke=(op,args,callId)=>f.execution.documentOperation({work:f.work,op,arguments:args,callId}),read=await invoke('read',{relPath:'worker.txt'});assert(read.ok);let result=await invoke('apply',{readHandle:read.value.readHandle,replacements:[{oldText:'NOT-A',newText:'Z'}]},'expected-mismatch');assert.equal(result.error.code,'REPLACEMENT_NOT_FOUND');assert.equal(result.continueTurn,true);assert.equal(await fs.readFile(file,'utf8'),'abc😀\n');result=await invoke('apply',{readHandle:read.value.readHandle,replacements:[{oldText:'\uD83D',newText:'Z'}]},'surrogate-split');assert.equal(result.error.code,'INVALID_PAYLOAD');assert.equal(await fs.readFile(file,'utf8'),'abc😀\n');assert.equal(await f.read('worker.txt'),'base\n');
});
test('document text uses LF coordinates and rejects non-UTF8 or binary reads',async t=>{
 const f=await fixture(t);await f.execution.prepare(f.work.id);const file=path.join(f.execution.directory(f.work.id),'worker.txt'),invoke=(op,args)=>f.execution.documentOperation({work:f.work,op,arguments:args,callId:'lf'});await fs.writeFile(file,'a\r\nb\r\n');const read=await invoke('read',{relPath:'worker.txt'});assert.equal(read.value.text,'a\nb\n');const applied=await invoke('apply',{readHandle:read.value.readHandle,replacements:[{oldText:'b',newText:'B\r\nC'}]});assert(applied.ok,JSON.stringify(applied));assert.equal(await fs.readFile(file,'utf8'),'a\nB\nC\n');await fs.writeFile(file,Buffer.from([0xff,0xfe]));assert.equal((await invoke('read',{relPath:'worker.txt'})).error.code,'UNSUPPORTED');await fs.writeFile(file,Buffer.from([65,0,66]));assert.equal((await invoke('read',{relPath:'worker.txt'})).error.code,'UNSUPPORTED');
});
test('document parent substitution after durable staging cannot replace or create outside files',async t=>{
 const f=await fixture(t);await f.execution.prepare(f.work.id);const dir=f.execution.directory(f.work.id),nested=path.join(dir,'nested'),outside=path.join(f.root,'external');await fs.mkdir(nested);await fs.mkdir(outside);await fs.writeFile(path.join(nested,'file.txt'),'inside');await fs.writeFile(path.join(outside,'file.txt'),'outside sentinel');const read=await f.execution.documentOperation({work:f.work,op:'read',arguments:{relPath:'nested/file.txt'}});assert(read.ok);const save=f.execution.save.bind(f.execution);let swapped=false;f.execution.save=async m=>{await save(m);if(m.documentIntent&&!swapped){swapped=true;assert(await fs.stat(m.documentIntent.temp),'new bytes must be durably staged in the original directory before rename');assert.equal(path.dirname(m.documentIntent.temp),path.dirname(m.documentIntent.file));await fs.rename(nested,path.join(dir,'held-nested'));await fs.symlink(outside,nested);}};const result=await f.execution.documentOperation({work:f.work,op:'apply',callId:'parent-race',arguments:{readHandle:read.value.readHandle,replacements:[{oldText:'inside',newText:'replacement'}]}});assert.equal(result.ok,false);assert(swapped);assert.equal(await fs.readFile(path.join(outside,'file.txt'),'utf8'),'outside sentinel');assert.deepEqual(await fs.readdir(outside),['file.txt']);assert.equal(await fs.readFile(path.join(dir,'held-nested','file.txt'),'utf8'),'inside');assert.deepEqual(await fs.readdir(path.join(dir,'held-nested')),['file.txt']);
});
