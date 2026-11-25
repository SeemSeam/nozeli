import test,{describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {ExecutionWorkspace} from '../src/agents/managed/execution-workspace.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ensureExperimentalPrivateDirectory as ensure} from '../src/platform/windows/experimental-directories.mjs';
import {experimentalWindowsVersionedFilesystem as filesystem} from '../src/platform/windows/experimental-filesystem.mjs';
import {git,str,commitTree} from '../src/agents/managed/git-service.mjs';
import {createExperimentalExecutionWorkspaceIO} from '../src/platform/windows/experimental-execution-workspace.mjs';
import {security} from './fixtures/windows-security.mjs';
import {createExperimentalWindowsPersistence} from '../src/platform/windows/experimental-persistence.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t,{existing=true,projectLength}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-work-')),resources=[];
 t.after(async()=>{for(const resource of resources.reverse())await (resource.db??resource).close();await fs.rm(root,{recursive:true,force:true});});
 const prefix=path.join(root,'项目 空格'+'中'.repeat(30)),projectRoot=projectLength?prefix+'x'.repeat(projectLength-prefix.length):path.join(root,'项目 空格');await fs.mkdir(projectRoot);const profile=path.join(root,'profile'),storage=new ProjectStorage(profile,{experimentalWindowsRoot:root,experimentalWindowsInitialization:true});resources.push(storage);const project=await storage.register(projectRoot);
 for(const [name,bytes]of Object.entries({'正文.md':'baseline','delete.txt':'delete baseline','staged.txt':'staged baseline','draft.txt':'original draft'}))await fs.writeFile(path.join(projectRoot,name),bytes);
 if(existing){await git(projectRoot,['init','--initial-branch=main']);await git(projectRoot,['config','core.autocrlf','false']);await git(projectRoot,['add','--','正文.md','delete.txt','staged.txt','draft.txt']);const tree=await str(projectRoot,['write-tree']),commit=await commitTree(projectRoot,tree,[],'synthetic baseline',path.join(root,'seed'));await git(projectRoot,['update-ref','refs/heads/main',commit,'0'.repeat(commit.length)]);}
 const runtime=path.join(root,'runtime');await ensure(root,runtime);const work={id:'synthetic-work',revision:1,result:{objectId:'synthetic-report'}},store={root:runtime,content:projectRoot,storage,projectId:project.id,state:{works:[work]}};
 const options={filesystem,experimentalWindowsRoot:root,publicDirectory:directory=>directory===projectRoot?projectRoot:false};
 const workspace=new ExecutionWorkspace(store,options);
 return {root,projectRoot,profile,project,storage,work,store,workspace,
  cold(){return new ExecutionWorkspace(store,options);},
  async candidate(){const m=await workspace.prepare(work.id);await fs.writeFile(path.join(m.directory,'正文.md'),'candidate');await fs.unlink(path.join(m.directory,'delete.txt'));await fs.writeFile(path.join(m.directory,'新增.txt'),'new material');const receiptId='report-receipt';await workspace.publish(work,{id:'synthetic-job'},()=>true,async(_m,candidate)=>{await storage.putProject(project.id,'managed_receipts',receiptId,{workId:work.id,revision:work.revision,snapshot:{candidate}});return {id:'synthetic-change-set'};},{receiptId});return workspace.readManifest(work.id);},
 };
}
const authorization=(f,m)=>({workId:f.work.id,revision:f.work.revision,objectId:f.work.result.objectId,candidateCommit:m.candidate.commit,reviewVersion:null,repo:m.repo,commonDir:m.commonDir,targetRef:m.targetRef,targetHead:m.targetHead});

async function exitDuringAcceptance(f,m,phase){
 const script=path.join(f.root,'finish-child.mjs');
 const source=`import {ProjectStorage} from ${JSON.stringify(new URL('../src/main/project-storage.mjs',import.meta.url).href)};
 import {ExecutionWorkspace} from ${JSON.stringify(new URL('../src/agents/managed/execution-workspace.mjs',import.meta.url).href)};
 import {experimentalWindowsVersionedFilesystem as filesystem} from ${JSON.stringify(new URL('../src/platform/windows/experimental-filesystem.mjs',import.meta.url).href)};
 const input=JSON.parse(process.argv[2]),storage=new ProjectStorage(input.profile,{experimentalWindowsRoot:input.root,experimentalWindowsInitialization:true});const project=await storage.register(input.projectRoot),store={root:input.runtime,content:input.projectRoot,storage,projectId:project.id,state:{works:[input.work]}},execution=new ExecutionWorkspace(store,{filesystem,experimentalWindowsRoot:input.root,publicDirectory:directory=>directory===input.projectRoot?input.projectRoot:false}),save=execution.save.bind(execution);
 execution.save=async manifest=>{await save(manifest);if(input.phase==='locks-held'?manifest.finishIntent?.status==='prepared'&&Object.keys(manifest.finishIntent.locks??{}).length===3:manifest.finishIntent?.status===input.phase)process.exit(91);};
 await execution.finish(input.work,{decision:'accept',reportPersisted:true,mergeAuthorization:input.authorization});await storage.db.close();`;
 await fs.writeFile(script,source);const child=spawnSync(process.execPath,[script,JSON.stringify({root:f.root,profile:f.profile,projectRoot:f.projectRoot,runtime:f.store.root,work:f.work,phase,authorization:authorization(f,m)})],{encoding:'utf8',windowsHide:true,timeout:90000});assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,91,child.stdout+child.stderr);
}

describe('native shared Work lifecycle',{concurrency:3},()=>{

for(const existing of [false,true])test(`long Worker root is rejected before Git or execution evidence effects (existing repository: ${existing})`,native,async t=>{
 const f=await fixture(t,{existing});
 const before=existing?await str(f.projectRoot,['show-ref']):null;
 // Each Windows component is legal; the complete UTF-8 .git path exceeds
 // MinGit's fixed buffer while the directory itself is not yet allocated.
 f.store.root=path.join(f.root,...Array.from({length:7},()=> '层级 中文 '+ 'x'.repeat(20)));
 await assert.rejects(f.workspace.prepare(f.work.id),error=>error.code==='UNSUPPORTED_GIT_WORKTREE_PATH'&&error.utf8Bytes>=260);
 await assert.rejects(fs.stat(f.store.root),{code:'ENOENT'});
 await assert.rejects(fs.stat(f.workspace.manifest(f.work.id)),{code:'ENOENT'});
 if(existing)assert.equal(await str(f.projectRoot,['show-ref']),before);
 else await assert.rejects(fs.stat(path.join(f.projectRoot,'.git')),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(f.projectRoot,'正文.md'),'utf8'),'baseline');
});

const adminWorkId='work-00000000-0000-4000-8000-000000000003';
const projectLengthForAdmin=length=>length-path.join('.git','worktrees',adminWorkId).length-1;
for(const layout of ['new','existing','linked'])test(`long Git admin path is rejected before source or evidence effects (${layout})`,native,async t=>{
 const f=await fixture(t,{existing:layout!=='new',projectLength:projectLengthForAdmin(250)});f.work.id=adminWorkId;
 if(layout==='linked'){
  const linked=path.join(f.root,'linked-project');await git(f.projectRoot,['worktree','add','-b','linked-source',linked]);f.store.content=linked;f.store.projectId=(await f.storage.register(linked)).id;
 }
 const common=path.join(f.projectRoot,'.git'),before=layout==='new'?null:{refs:await str(f.projectRoot,['show-ref']),config:await fs.readFile(path.join(common,'config')),index:await fs.readFile(path.join(common,'index')),trees:await fs.readdir(path.join(common,'worktrees')).catch(e=>{if(e.code==='ENOENT')return [];throw e;})};
 assert.equal(path.join(common,'worktrees',f.work.id).length,250);
 assert.ok(f.store.content.length<250);assert.ok(f.workspace.directory(f.work.id).length<250);
 await assert.rejects(f.workspace.prepare(f.work.id),error=>error.code==='UNSUPPORTED_GIT_WORKTREE_ADMIN_PATH'&&error.commonDir===common&&error.utf16Units===260);
 assert.deepEqual(await fs.readdir(f.store.root),[]);
 if(before){assert.equal(await str(f.projectRoot,['show-ref']),before.refs);assert.deepEqual(await fs.readFile(path.join(common,'config')),before.config);assert.deepEqual(await fs.readFile(path.join(common,'index')),before.index);assert.deepEqual(await fs.readdir(path.join(common,'worktrees')).catch(e=>{if(e.code==='ENOENT')return [];throw e;}),before.trees);}
 else await assert.rejects(fs.stat(common),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(f.store.content,'正文.md'),'utf8'),'baseline');
});

test('Git admin path accounts for an existing basename before another Work branch or manifest is written',native,async t=>{
 const f=await fixture(t,{projectLength:projectLengthForAdmin(249)});f.work.id=adminWorkId;
 const common=path.join(f.projectRoot,'.git'),external=path.join(f.root,'external',f.work.id);await git(f.projectRoot,['worktree','add','-b','external-winner',external]);
 const refs=await str(f.projectRoot,['show-ref']),registered=await fs.readFile(path.join(external,'.git')),admin=path.join(common,'worktrees',f.work.id);assert.equal(admin.length,249);
 await assert.rejects(f.workspace.prepare(f.work.id),error=>error.code==='UNSUPPORTED_GIT_WORKTREE_ADMIN_PATH'&&error.gitDir===admin+'1');
 assert.equal(await str(f.projectRoot,['show-ref']),refs);assert.deepEqual(await fs.readFile(path.join(external,'.git')),registered);assert.equal(await fs.readFile(path.join(external,'正文.md'),'utf8'),'baseline');assert.deepEqual(await fs.readdir(f.store.root),[]);await assert.rejects(fs.stat(admin+'1'),{code:'ENOENT'});
});

test('Git admin boundary permits Chinese paths above 260 UTF-8 bytes and cold reuses its original registration',native,async t=>{
 const f=await fixture(t,{projectLength:projectLengthForAdmin(249)});f.work.id=adminWorkId;
 const m=await f.workspace.prepare(f.work.id);assert.equal(m.workerGitDir.length,249);assert.ok(Buffer.byteLength(m.workerGitDir,'utf8')>260);
 assert.equal(m.preparation,'complete');assert.equal(await fs.readFile(path.join(m.directory,'正文.md'),'utf8'),'baseline');
 const cold=await f.cold().prepare(f.work.id);assert.equal(cold.workerGitDir,m.workerGitDir);assert.equal(cold.branchRef,m.branchRef);assert.deepEqual(await fs.readdir(path.join(m.commonDir,'worktrees')),[f.work.id]);
});

test('shared Worker document read/apply uses native version CAS and cold duplicate receipts without a second write',native,async t=>{
 const f=await fixture(t),read=await f.workspace.documentOperation({work:f.work,op:'read',arguments:{relPath:'正文.md'},callId:'read'});assert.equal(read.ok,true);assert.equal(read.value.text,'baseline');
 const input={work:f.work,op:'apply',arguments:{readHandle:read.value.readHandle,replacements:[{oldText:'baseline',newText:'精确修改 😀'}]},callId:'apply'},result=await f.workspace.documentOperation(input);assert.equal(result.ok,true);assert.equal(await fs.readFile(path.join(f.workspace.directory(f.work.id),'正文.md'),'utf8'),'精确修改 😀');assert.equal(await fs.readFile(path.join(f.projectRoot,'正文.md'),'utf8'),'baseline');
 const duplicate=await f.cold().documentOperation(input);assert.equal(duplicate.value.duplicate,true);assert.equal(duplicate.value.digest,result.value.digest);
});

test('an external Worker document winner is preserved when the original read handle becomes stale',native,async t=>{
 const f=await fixture(t),read=await f.workspace.documentOperation({work:f.work,op:'read',arguments:{relPath:'正文.md'},callId:'read'}),file=path.join(f.workspace.directory(f.work.id),'正文.md');await fs.writeFile(file,'external winner');
 const result=await f.workspace.documentOperation({work:f.work,op:'apply',arguments:{readHandle:read.value.readHandle,replacements:[{oldText:'baseline',newText:'must not win'}]},callId:'apply'});assert.equal(result.ok,false);assert.equal(result.error.code,'STALE_VERSION');assert.equal(await fs.readFile(file,'utf8'),'external winner');
});

test('actual native document CAS followed by lost callback cold reconciles its retained intent and never applies twice',native,async t=>{
 const f=await fixture(t),read=await f.workspace.documentOperation({work:f.work,op:'read',arguments:{relPath:'正文.md'},callId:'read'}),write=f.workspace.files.writeVersioned.bind(f.workspace.files);let effects=0;
 f.workspace.files.writeVersioned=async(...args)=>{await write(...args);effects++;throw Object.assign(Error('lost callback after real document CAS'),{committed:true});};
 const input={work:f.work,op:'apply',arguments:{readHandle:read.value.readHandle,replacements:[{oldText:'baseline',newText:'baseline + once'}]},callId:'apply'};assert.equal((await f.workspace.documentOperation(input)).ok,false);assert.ok((await f.cold().readManifest(f.work.id)).documentIntent);
 const result=await f.cold().documentOperation(input);assert.equal(result.ok,true);assert.equal(result.value.duplicate,true);assert.equal(effects,1);assert.equal(await fs.readFile(path.join(f.workspace.directory(f.work.id),'正文.md'),'utf8'),'baseline + once');
});
test('shared Work preparation, report receipt, acceptance/index/ref and cleanup complete with actual native file effects',native,async t=>{
 const f=await fixture(t),m=await f.candidate(),head=m.targetHead;assert.equal(m.preparation,'complete');assert.equal((await f.storage.getProject(f.project.id,'managed_receipts','report-receipt')).snapshot.candidate.commit,m.candidate.commit);
 const receipt=await f.workspace.finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)});assert.equal(receipt.status,'merged');assert.equal(receipt.cleaned,true);assert.notEqual(receipt.commit,head);assert.equal(await str(f.projectRoot,['rev-parse','main']),receipt.commit);
 assert.equal(await fs.readFile(path.join(f.projectRoot,'正文.md'),'utf8'),'candidate');assert.equal(await fs.readFile(path.join(f.projectRoot,'新增.txt'),'utf8'),'new material');await assert.rejects(fs.lstat(path.join(f.projectRoot,'delete.txt')),{code:'ENOENT'});
 assert.equal(await str(f.projectRoot,['diff','--cached','--name-only']),'');assert.equal(await str(f.projectRoot,['diff','--name-only']),'');assert.deepEqual(await f.cold().finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)}),receipt);
 for(const file of [m.index+'.lock',m.headFile+'.lock',path.join(m.commonDir,m.targetRef)+'.lock'])await assert.rejects(fs.lstat(file),{code:'ENOENT'});
});

test('shared Work prepares a non-Git Unicode project using native no-replace initial index publication',native,async t=>{
 const f=await fixture(t,{existing:false}),m=await f.workspace.prepare(f.work.id);assert.equal(m.preparation,'complete');assert.equal(await str(f.projectRoot,['symbolic-ref','HEAD']),'refs/heads/main');assert.equal(await fs.readFile(path.join(m.directory,'正文.md'),'utf8'),'baseline');assert.equal(await str(f.projectRoot,['diff','--cached','--name-only']),'');
 assert.equal((await f.cold().prepare(f.work.id)).inputCommit,m.inputCommit);
});

test('shared Work preserves unrelated staged, disk and recovery drafts during preparation and acceptance',native,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.projectRoot,'staged.txt'),'user staged');await git(f.projectRoot,['add','--','staged.txt']);await fs.writeFile(path.join(f.projectRoot,'draft.txt'),'unsaved user disk');await f.storage.putRecovery(f.project.id,'draft',{text:'未发送'});const m=await f.candidate();
 await f.workspace.finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)});assert.equal(await fs.readFile(path.join(f.projectRoot,'draft.txt'),'utf8'),'unsaved user disk');assert.equal((await git(f.projectRoot,['show',':staged.txt'])).toString(),'user staged');assert.deepEqual(await f.storage.getRecovery(f.project.id,'draft'),{text:'未发送'});
});

test('the shared explicit discard removes only the registered Work tree and branch while source and recovery drafts remain',native,async t=>{
 const f=await fixture(t),m=await f.candidate(),index=await fs.readFile(m.index);await f.storage.putRecovery(f.project.id,'draft','retained');const receipt=await f.workspace.finish(f.work,{decision:'discard',reportPersisted:true});
 assert.equal(receipt.status,'discarded');assert.equal(await str(f.projectRoot,['rev-parse','main']),m.targetHead);assert.deepEqual(await fs.readFile(m.index),index);assert.equal(await fs.readFile(path.join(f.projectRoot,'正文.md'),'utf8'),'baseline');assert.equal(await f.storage.getRecovery(f.project.id,'draft'),'retained');await assert.rejects(fs.lstat(m.directory),{code:'ENOENT'});
});

test('a competing manifest CAS writer wins without silent overwrite of its execution evidence',native,async t=>{
 const f=await fixture(t),m=await f.workspace.prepare(f.work.id),other=f.cold(),copy=await other.readManifest(f.work.id);await f.workspace.readManifest(f.work.id);copy.external='retained winner';await other.save(copy);m.external='loser';await assert.rejects(f.workspace.save(m),{code:'FS_VERSION_CONFLICT'});assert.equal((await f.cold().readManifest(f.work.id)).external,'retained winner');
});

test('missing merge authorization and a dirty touched source reject acceptance while retaining the candidate and index',native,async t=>{
 const f=await fixture(t),m=await f.candidate(),index=await fs.readFile(m.index);await assert.rejects(f.workspace.finish(f.work,{decision:'accept',reportPersisted:true}),{code:'MERGE_AUTHORIZATION_REQUIRED'});await fs.writeFile(path.join(f.projectRoot,'正文.md'),'external winner');
 await assert.rejects(f.workspace.finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)}),{code:'USER_DIRTY'});assert.equal(await fs.readFile(path.join(f.projectRoot,'正文.md'),'utf8'),'external winner');assert.deepEqual(await fs.readFile(m.index),index);assert.equal(await fs.readFile(path.join(m.directory,'正文.md'),'utf8'),'candidate');
});

for(const phase of ['registered','input-frozen'])test(`shared preparation cold resumes the persisted ${phase} checkpoint without creating another Work branch`,native,async t=>{
 const f=await fixture(t),save=f.workspace.save.bind(f.workspace);let interrupted=false;
 f.workspace.save=async m=>{await save(m);if(!interrupted&&m.preparation===phase){interrupted=true;throw Error('durable preparation checkpoint');}};
 await assert.rejects(f.workspace.prepare(f.work.id),/durable preparation checkpoint/);const recorded=await f.cold().readManifest(f.work.id),cold=await f.cold().prepare(f.work.id);assert.equal(cold.preparation,'complete');assert.equal(cold.branchRef,recorded.branchRef);assert.equal(cold.workerDirectoryIdentity,recorded.workerDirectoryIdentity);assert.equal((await str(f.projectRoot,['for-each-ref','--format=%(refname)','refs/heads/nozeli/work-'])).split('\n').length,1);
});

test('report publication cold reconciles an actual committed SQLite receipt after the callback reports failure',native,async t=>{
 const f=await fixture(t),m=await f.workspace.prepare(f.work.id);await fs.writeFile(path.join(m.directory,'正文.md'),'published with receipt');const receiptId='durable-publication';
 await assert.rejects(f.workspace.publish(f.work,{id:'job'},()=>true,async(_m,candidate)=>{await f.storage.putProject(f.project.id,'managed_receipts',receiptId,{workId:f.work.id,revision:f.work.revision,snapshot:{candidate}});throw Error('controlled callback failure after actual receipt');},{receiptId}),{code:'PUBLICATION_COMMIT_UNKNOWN'});
 const held=await f.cold().readManifest(f.work.id);assert.ok(held.publicationIntent);const cold=await f.cold().prepare(f.work.id);assert.equal(cold.publicationIntent,undefined);assert.equal(cold.candidate.commit,held.publicationIntent.candidate.commit);assert.equal(await str(f.projectRoot,['rev-parse',cold.branchRef]),cold.candidate.commit);
});

test('a pre-ref install failure rolls back exact file/index versions and an explicit retry can finish',native,async t=>{
 const f=await fixture(t),m=await f.candidate(),index=await fs.readFile(m.index),original=f.workspace.installFile.bind(f.workspace);let count=0;
 f.workspace.installFile=async(...args)=>{if(!args[2]&&++count===2)throw Error('controlled install interruption');return original(...args);};
 await assert.rejects(f.workspace.finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)}),/controlled install interruption/);assert.equal(await str(f.projectRoot,['rev-parse','main']),m.targetHead);assert.deepEqual(await fs.readFile(m.index),index);assert.equal(await fs.readFile(path.join(f.projectRoot,'正文.md'),'utf8'),'baseline');assert.equal((await f.cold().readManifest(f.work.id)).finishIntent.status,'prepared');
 const receipt=await f.cold().finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)});assert.equal(receipt.status,'merged');
});

test('an external writer that blocks rollback is retained together with the candidate and exact Git lock identities',native,async t=>{
 const f=await fixture(t),m=await f.candidate(),original=f.workspace.installFile.bind(f.workspace);let touched;
 f.workspace.installFile=async(manifest,file,rollback)=>{if(!rollback&&touched){await fs.writeFile(path.join(f.projectRoot,touched),'independent winner');throw Error('controlled next-file failure');}const result=await original(manifest,file,rollback);if(!rollback)touched=file.rel;return result;};
 await assert.rejects(f.workspace.finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)}),{code:'ROLLBACK_BLOCKED'});assert.equal(await fs.readFile(path.join(f.projectRoot,touched),'utf8'),'independent winner');assert.equal(await str(f.projectRoot,['rev-parse','main']),m.targetHead);const held=await f.cold().readManifest(f.work.id);assert.equal(held.finishIntent.status,'rollback-blocked');assert.equal(Object.keys(held.finishIntent.locks).length,3);for(const lock of Object.values(held.finishIntent.locks))assert.match(lock.identity,/^[a-f0-9]{16}:[a-f0-9]{32}$/);assert.ok((await fs.stat(m.directory)).isDirectory());
});

for(const phase of ['locks-held','files-installed','ref-published'])test(`actual host exit at ${phase} cold resumes acceptance using saved native lock IDs and approved versions`,native,async t=>{
 const f=await fixture(t),m=await f.candidate();await exitDuringAcceptance(f,m,phase);
 const held=await f.cold().readManifest(f.work.id);assert.equal(held.finishIntent.status,phase==='locks-held'?'prepared':phase);assert.equal(Object.keys(held.finishIntent.locks).length,3);const before=await str(f.projectRoot,['rev-parse','main']);assert.equal(before,phase==='ref-published'?held.finishIntent.commit:m.targetHead);
 const receipt=await f.cold().finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)});assert.equal(receipt.status,'merged');assert.equal(receipt.commit,held.finishIntent.commit);assert.equal(await fs.readFile(path.join(f.projectRoot,'正文.md'),'utf8'),'candidate');
});

test('a copied Git pointer in a replacement worker directory cannot authorize discard cleanup',native,async t=>{
 const f=await fixture(t),m=await f.workspace.prepare(f.work.id);await fs.rename(m.directory,m.directory+'-retained');await fs.mkdir(m.directory);await fs.writeFile(path.join(m.directory,'.git'),m.gitPointer);await fs.writeFile(path.join(m.directory,'external'),'replacement winner');
 await assert.rejects(f.cold().finish(f.work,{decision:'discard',reportPersisted:true}),{code:'IDENTITY_CHANGED'});assert.equal(await fs.readFile(path.join(m.directory,'external'),'utf8'),'replacement winner');assert.equal(await fs.readFile(path.join(m.directory+'-retained','正文.md'),'utf8'),'baseline');
});

test('declared dependency payloads still refuse an unavailable native copy boundary without pretending modules were supplied',native,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.projectRoot,'package.json'),'{"name":"synthetic"}');await fs.writeFile(path.join(f.projectRoot,'package-lock.json'),'{"lockfileVersion":3}');await fs.mkdir(path.join(f.projectRoot,'node_modules'));await fs.writeFile(path.join(f.projectRoot,'node_modules','external'),'source modules');
 const unavailable=new ExecutionWorkspace(f.store,{filesystem:{...filesystem,provisioning:undefined},experimentalWindowsRoot:f.root});
 await assert.rejects(unavailable.prepare(f.work.id),{code:'DEPENDENCY_PLATFORM'});assert.equal(await fs.readFile(path.join(f.projectRoot,'node_modules','external'),'utf8'),'source modules');const m=await f.cold().readManifest(f.work.id);assert.notEqual(m.preparation,'complete');await assert.rejects(fs.stat(path.join(m.directory,'node_modules')),{code:'ENOENT'});
});

test('broad manifest ACL drift is refused without repairing or rewriting execution evidence',native,async t=>{
 const f=await fixture(t);await f.workspace.prepare(f.work.id);const file=f.workspace.manifest(f.work.id),bytes=await fs.readFile(file);security('add-write',file);const acl=security('inspect',file);await assert.rejects(f.cold().readManifest(f.work.id),{code:'FS_SECURITY_CHANGED'});assert.deepEqual(await fs.readFile(file),bytes);assert.deepEqual(security('inspect',file),acl);
});

test('actual index parent closure after CAS publication holds recovery and all locks until explicit cold retry',native,async t=>{
 const f=await fixture(t),m=await f.candidate();let failed=false;
 f.workspace.io=createExperimentalExecutionWorkspaceIO(f.root,{directorySync:parent=>{if(!failed&&parent.path.endsWith('\\.git\\')){failed=true;parent.close();}parent.syncDirectory();}});
 await assert.rejects(f.workspace.finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)}),error=>error.code==='FS_HANDLE_CLOSED'&&error.committed===true&&error.executionRecovery.status==='recovery-held');
 const held=await f.cold().readManifest(f.work.id);assert.equal(held.finishIntent.status,'recovery-held');assert.equal(Object.keys(held.finishIntent.locks).length,3);assert.equal(await str(f.projectRoot,['rev-parse','main']),m.targetHead);assert.equal(await f.workspace.indexDigest(m.index),held.finishIntent.afterIndexDigest);
 const receipt=await f.cold().finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)});assert.equal(receipt.status,'merged');
});

test('a foreign existing Git lock is retained before managed file, index or ref changes',native,async t=>{
 const f=await fixture(t),m=await f.candidate(),index=await fs.readFile(m.index),foreign=m.index+'.lock';await fs.writeFile(foreign,'independent Git lock');
 await assert.rejects(f.workspace.finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)}));assert.equal(await fs.readFile(foreign,'utf8'),'independent Git lock');assert.deepEqual(await fs.readFile(m.index),index);assert.equal(await str(f.projectRoot,['rev-parse','main']),m.targetHead);assert.equal(await fs.readFile(path.join(f.projectRoot,'正文.md'),'utf8'),'baseline');
});

test('matching copied lock tokens cannot adopt a replacement File ID during explicit acceptance recovery',native,async t=>{
 const f=await fixture(t),m=await f.candidate(),save=f.workspace.save.bind(f.workspace);let stopped=false;
 f.workspace.save=async manifest=>{await save(manifest);if(!stopped&&manifest.finishIntent?.status==='prepared'&&Object.keys(manifest.finishIntent.locks??{}).length===3){stopped=true;throw Error('controlled allocation checkpoint');}};
 await assert.rejects(f.workspace.finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)}),/controlled allocation checkpoint/);const held=await f.cold().readManifest(f.work.id),file=m.index+'.lock';await fs.unlink(file);await createExperimentalWindowsPersistence(f.root).writeAtomic(path.relative(f.root,file).split(path.sep).join('/'),held.finishIntent.token);
 await assert.rejects(f.cold().finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)}),{code:'GIT_LOCKED'});assert.equal(await fs.readFile(file,'utf8'),held.finishIntent.token);assert.equal(await str(f.projectRoot,['rev-parse','main']),m.targetHead);
});

test('cold recovery with installed files and a replaced lock performs no rollback without all owned Git locks',native,async t=>{
 const f=await fixture(t),m=await f.candidate();await exitDuringAcceptance(f,m,'files-installed');
 const held=await f.cold().readManifest(f.work.id),file=m.index+'.lock',index=await fs.readFile(m.index),evidence=await fs.readFile(f.workspace.manifest(f.work.id));
 await fs.unlink(file);await createExperimentalWindowsPersistence(f.root).writeAtomic(path.relative(f.root,file).split(path.sep).join('/'),held.finishIntent.token);
 await assert.rejects(f.cold().finish(f.work,{decision:'accept',reportPersisted:true,mergeAuthorization:authorization(f,m)}),{code:'GIT_LOCKED'});
 assert.deepEqual(await fs.readFile(m.index),index);assert.equal(await fs.readFile(path.join(f.projectRoot,'正文.md'),'utf8'),'candidate');assert.equal(await fs.readFile(path.join(f.projectRoot,'新增.txt'),'utf8'),'new material');await assert.rejects(fs.stat(path.join(f.projectRoot,'delete.txt')),{code:'ENOENT'});
 assert.equal(await str(f.projectRoot,['rev-parse','main']),m.targetHead);assert.equal(await fs.readFile(file,'utf8'),held.finishIntent.token);assert.deepEqual(await fs.readFile(f.workspace.manifest(f.work.id)),evidence);assert.ok((await fs.stat(m.directory)).isDirectory());
});
});
