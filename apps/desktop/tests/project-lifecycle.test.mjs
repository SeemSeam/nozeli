import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ProjectLifecycle} from '../src/main/project-lifecycle.mjs';

// Real filesystem and production SQLite storage. Stop/view receipts are wiring
// doubles; trash is a controlled rename, NOT platform trash/process acceptance.
async function setup(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-project-lifecycle-'));
  const root=path.join(directory,'project'),trash=path.join(directory,'controlled-trash');
  await fs.mkdir(root);await fs.mkdir(trash);await fs.writeFile(path.join(root,'source.txt'),'original source');
  const storage=new ProjectStorage(path.join(directory,'profile'));
  const project=await storage.register(root);
  await storage.putLocal(project.id,'view',{scrollTop:42});
  await storage.putRecovery(project.id,'document:test',{candidate:{text:'unsaved complete candidate'}});
  const events=[];
  const host={storage,requireRegisteredProject:id=>storage.requireRegistered(id)};
  const workspace={layouts:new Map([[project.id,{projectId:project.id}]]),closeProject:async(id,{operationId})=>{events.push({kind:'close',id,operationId});return {closed:true,projectId:id,operationId};}};
  const managed={stopProject:async id=>{events.push({kind:'stop',id});return {projectId:id,confirmationComplete:true};}};
  const trashItem=async source=>{events.push({kind:'trash',source});await fs.rename(source,path.join(trash,path.basename(source)));};
  const manager=new ProjectLifecycle({host,workspace,managed,trashItem});
  t.after(async()=>{await storage.db.close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,root,trash,storage,project,events,host,workspace,managed,trashItem,manager};
}
const exists=file=>fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});

test('confirmed delete journals before controlled trash, removes entry only after gone, retains recovery',async t=>{
  const f=await setup(t);
  const preview=await f.manager.preview({projectId:f.project.id,action:'delete-project'});
  assert.equal(preview.root,f.root);assert.deepEqual(preview.removeDirectories,[f.root]);assert.equal(preview.permanentDelete,false);
  f.manager.trashItem=async source=>{
    const journal=await f.storage.getRecovery(f.project.id,'lifecycle:'+preview.operationId);
    assert.equal(journal.phase,'trash-prepared');assert.notEqual((await f.storage.requireRegistered(f.project.id)).removed,true);
    await f.trashItem(source);
  };
  const result=await f.manager.execute({token:preview.token});
  assert.equal(result.complete,true);assert.equal(result.trashed,true);assert.equal(result.operationId,preview.operationId);
  assert.deepEqual(f.events.map(event=>event.kind),['stop','close','trash']);
  assert.equal(f.events[1].operationId,preview.operationId);
  assert.equal(await exists(f.root),false);assert.equal(await fs.readFile(path.join(f.trash,'project','source.txt'),'utf8'),'original source');
  assert.equal((await f.storage.requireRegistered(f.project.id)).removed,true);
  assert.equal((await f.storage.getRecovery(f.project.id,'document:test')).candidate.text,'unsaved complete candidate');
  assert.equal((await f.storage.getRecovery(f.project.id,'lifecycle:'+preview.operationId)).phase,'complete');
  await assert.rejects(f.manager.execute({token:preview.token}),{code:'LIFECYCLE_CONFIRMATION_EXPIRED'});
  assert.equal(f.events.filter(event=>event.kind==='trash').length,1);
});

test('local cleanup removes UI state while preserving actual execution sessions and Git worktrees',async t=>{
  const f=await setup(t),local=await f.storage.localDirectory(f.project.id);
  const session=path.join(local,'execution','agents','resident-frontdesk-omp','sessions','native.jsonl');
  await fs.mkdir(path.dirname(session),{recursive:true});await fs.writeFile(session,'native private journal');
  const worktree=path.join(local,'execution','worktrees','retained-worker');
  await fs.mkdir(path.dirname(worktree),{recursive:true});
  const run=promisify(execFile),git=async(...args)=>(await run('git',['-C',f.root,...args])).stdout;
  await git('init');await git('add','source.txt');
  await git('-c','user.name=Nozeli fixture','-c','user.email=fixture@nozeli.invalid','-c','core.hooksPath='+path.join(f.directory,'no-hooks'),'commit','-m','fixture baseline');
  await git('worktree','add','--detach',worktree,'HEAD');
  await fs.writeFile(path.join(worktree,'source.txt'),'uncommitted worker result');
  const registered=await git('worktree','list','--porcelain');
  await f.storage.putLocal(f.project.id,'managed:residents',{frontdesk:{threadId:'retained-native-thread'}});
  await f.storage.putLocal(f.project.id,'managed:works:retained-worker',{threadId:'retained-worker-thread',execution:{directory:worktree}});
  const account=path.join(f.directory,'profile','account-secret');await fs.writeFile(account,'keep account');
  const preview=await f.manager.preview({projectId:f.project.id,action:'clean-local'});
  assert.deepEqual(preview.removeDirectories,[]);assert(preview.removeRecords.includes('view'));assert.deepEqual(preview.removeFiles,[]);
  assert.equal(preview.sessionsRetained,true);
  await f.manager.execute({token:preview.token});
  assert.equal(await f.storage.getLocal(f.project.id,'view'),null);
  assert.equal((await f.storage.getLocal(f.project.id,'managed:residents')).frontdesk.threadId,'retained-native-thread');
  assert.equal((await f.storage.getLocal(f.project.id,'managed:works:retained-worker')).execution.directory,worktree);
  assert.equal((await f.storage.getRecovery(f.project.id,'workspace:local-clean:'+preview.operationId)).workspace.localRecords.find(row=>row.id==='view').value.scrollTop,42);
  assert.equal(await fs.readFile(session,'utf8'),'native private journal');
  assert.equal(await fs.readFile(path.join(worktree,'source.txt'),'utf8'),'uncommitted worker result');
  assert.equal(await git('worktree','list','--porcelain'),registered);
  assert.equal((await run('git',['-C',worktree,'status','--porcelain'])).stdout.trim(),'M source.txt');
  assert.equal(await fs.readFile(account,'utf8'),'keep account');assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'original source');
  assert.equal((await f.storage.getRecovery(f.project.id,'document:test')).candidate.text,'unsaved complete candidate');
  assert.notEqual((await f.storage.requireRegistered(f.project.id)).removed,true);assert.equal(f.workspace.layouts.has(f.project.id),false);
  assert.deepEqual(f.events.map(event=>event.kind),['stop','close']);
});

test('protected roots and ancestors of other registered projects are refused before mutation',async t=>{
  const f=await setup(t);
  const protectedManager=new ProjectLifecycle({...f,protectedRoots:[f.root]});
  await assert.rejects(protectedManager.preview({projectId:f.project.id,action:'delete-project'}),{code:'PROJECT_DELETE_PROTECTED'});
  const nested=path.join(f.root,'nested');await fs.mkdir(nested);await f.storage.register(nested);
  await assert.rejects(f.manager.preview({projectId:f.project.id,action:'delete-project'}),{code:'PROJECT_DELETE_NESTED'});
  for(const root of [path.parse(f.root).root,os.homedir(),f.storage.root])await assert.rejects(f.manager.checkDelete({...f.project,root}),{code:'PROJECT_DELETE_PROTECTED'});
  assert.equal(f.events.length,0);assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'original source');
});

test('changed directory identity or manifest invalidates confirmation without trashing replacement',async t=>{
  const f=await setup(t),preview=await f.manager.preview({projectId:f.project.id,action:'delete-project'});
  const moved=path.join(f.directory,'original-moved');await fs.rename(f.root,moved);await fs.mkdir(f.root);await fs.writeFile(path.join(f.root,'replacement.txt'),'do not touch');
  await assert.rejects(f.manager.execute({token:preview.token}),{code:'PROJECT_IDENTITY_CONFLICT'});
  assert.equal(await fs.readFile(path.join(f.root,'replacement.txt'),'utf8'),'do not touch');assert.equal(f.events.length,0);
  await fs.rm(f.root,{recursive:true});await fs.rename(moved,f.root);
  const next=await f.manager.preview({projectId:f.project.id,action:'delete-project'});
  const manifestPath=path.join(f.root,'.nozeli','project.json'),manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  await fs.writeFile(manifestPath,JSON.stringify({...manifest,name:'changed after preview'}));
  await assert.rejects(f.manager.execute({token:next.token}),{code:'PROJECT_IDENTITY_CONFLICT'});assert.equal(f.events.length,0);
});

test('unconfirmed stop and unavailable trash never trigger permanent delete fallback',async t=>{
  const f=await setup(t);
  f.managed.stopProject=async()=>({confirmationComplete:false});
  const blocked=await f.manager.preview({projectId:f.project.id,action:'delete-project'});
  await assert.rejects(f.manager.execute({token:blocked.token}),{code:'OMP_EXIT_UNCONFIRMED'});assert.equal(f.events.length,0);
  f.managed.stopProject=async id=>({projectId:id,confirmationComplete:true});
  await f.manager.reconcile({projectId:f.project.id,operationId:blocked.operationId});
  const denied=await f.manager.preview({projectId:f.project.id,action:'delete-project'});
  let attempts=0;f.manager.trashItem=async()=>{attempts++;throw Object.assign(Error('OS trash unavailable'),{code:'EACCES'});};
  await assert.rejects(f.manager.execute({token:denied.token}),{code:'EACCES'});
  assert.equal(attempts,1);assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'original source');
  assert.notEqual((await f.storage.requireRegistered(f.project.id)).removed,true);
  assert.equal((await f.storage.getRecovery(f.project.id,'lifecycle:'+denied.operationId)).phase,'needs-attention');
  await f.manager.reconcile({projectId:f.project.id,operationId:denied.operationId});assert.equal(attempts,1);
});

test('crash journal reconciliation observes gone/replaced paths without replay or auto removal',async t=>{
  const f=await setup(t),preview=await f.manager.preview({projectId:f.project.id,action:'delete-project'});
  await f.storage.putRecovery(f.project.id,'lifecycle:'+preview.operationId,{...preview,phase:'trash-prepared'});
  await fs.rename(f.root,path.join(f.trash,'project'));
  const first=await f.manager.reconcile({projectId:f.project.id,operationId:preview.operationId});
  assert.equal(first.observation,'gone');assert.equal(first.phase,'needs-attention');assert.equal(f.events.length,0);
  assert.notEqual((await f.storage.requireRegistered(f.project.id)).removed,true);
  await fs.mkdir(f.root);await fs.writeFile(path.join(f.root,'new.txt'),'replacement');
  const cold=new ProjectLifecycle({...f});
  const second=await cold.reconcile({projectId:f.project.id,operationId:preview.operationId});
  assert.equal(second.observation,'identity-conflict');assert.equal(f.events.length,0);assert.equal(await fs.readFile(path.join(f.root,'new.txt'),'utf8'),'replacement');
});

test('admission remains closed after owner and view stop until actual trash completes',async t=>{
  const f=await setup(t),preview=await f.manager.preview({projectId:f.project.id,action:'delete-project'});
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;}),finish=new Promise(resolve=>{release=resolve;});
  f.manager.trashItem=async root=>{entered();await finish;await f.trashItem(root);};
  const operation=f.manager.execute({token:preview.token});await waiting;
  await assert.rejects(f.storage.requireOnline(f.project.id),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  await assert.rejects(f.storage.putProject(f.project.id,'test','late','not admitted'),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  await assert.rejects(f.storage.putLocal(f.project.id,'late','not admitted'),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  await f.storage.putRecovery(f.project.id,'late-input',{text:'preserve while fenced'});
  assert.equal((await f.storage.getRecovery(f.project.id,'late-input')).text,'preserve while fenced');
  release();await operation;assert.equal(await exists(f.root),false);
});

test('timed out retention fences late work until explicit reconciliation without deleting source',{timeout:5000},async t=>{
  const f=await setup(t);f.manager.timeoutMs=25;
  let finish;const pending=new Promise(resolve=>{finish=resolve;});f.manager.beforeStop=()=>pending;
  const preview=await f.manager.preview({projectId:f.project.id,action:'delete-project'});
  await assert.rejects(f.manager.execute({token:preview.token}),{code:'PROJECT_STOP_TIMEOUT'});
  await assert.rejects(f.storage.requireOnline(f.project.id),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  await assert.rejects(f.manager.reconcile({projectId:f.project.id,operationId:preview.operationId}),{code:'PROJECT_STOP_PENDING'});
  assert.deepEqual(f.events.map(event=>event.kind),['stop']);finish();await new Promise(resolve=>setImmediate(resolve));
  await f.manager.reconcile({projectId:f.project.id,operationId:preview.operationId});
  assert.equal((await f.storage.requireOnline(f.project.id)).id,f.project.id);
  assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'original source');
  assert.equal(f.events.filter(event=>event.kind==='trash').length,0);
});

test('unresponsive OS trash ends bounded in needs-attention without unfencing or retry',{timeout:5000},async t=>{
  const f=await setup(t);f.manager.timeoutMs=25;
  let calls=0;f.manager.trashItem=async()=>{calls++;await new Promise(()=>{});};
  const preview=await f.manager.preview({projectId:f.project.id,action:'delete-project'});
  await assert.rejects(f.manager.execute({token:preview.token}),{code:'PROJECT_STOP_TIMEOUT'});
  assert.equal(calls,1);
  assert.equal((await f.storage.getRecovery(f.project.id,'lifecycle:'+preview.operationId)).phase,'needs-attention');
  await assert.rejects(f.storage.requireOnline(f.project.id),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  await assert.rejects(f.manager.reconcile({projectId:f.project.id,operationId:preview.operationId}),{code:'PROJECT_STOP_PENDING'});
  assert.equal(calls,1,'late reconciliation must not re-trash while the original call is unresolved');
  assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'original source');
});

test('cold reopen restores a prepared lifecycle hold and only explicit observation reopens admission',async t=>{
  const f=await setup(t),preview=await f.manager.preview({projectId:f.project.id,action:'delete-project'});
  const hold=f.storage.holdProject(f.project.id,preview);await f.storage.persistProjectHold(f.project.id,hold);
  await f.storage.putRecovery(f.project.id,'lifecycle:'+preview.operationId,{...preview,phase:'prepared'});
  await f.storage.db.close();
  const storage=new ProjectStorage(path.join(f.directory,'profile'));t.after(()=>storage.db.close());
  await assert.rejects(storage.requireOnline(f.project.id),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  const manager=new ProjectLifecycle({...f,host:{storage,requireRegisteredProject:id=>storage.requireRegistered(id)}});
  await manager.reconcile({projectId:f.project.id,operationId:preview.operationId});
  assert.equal((await storage.requireOnline(f.project.id)).id,f.project.id);
  assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'original source');
  assert.equal(f.events.filter(event=>event.kind==='trash').length,0);
});
