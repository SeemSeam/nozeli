import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ProjectLifecycle} from '../src/main/project-lifecycle.mjs';

// Real filesystem, real SQLite catalog/project databases and a real Git
// repository with a retained worktree. Stop/close receipts are wiring doubles
// exactly like project-lifecycle.test.mjs; trash must never run for a reset.
async function setup(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-project-reset-'));
  const root=path.join(directory,'project'),other=path.join(directory,'other');
  await fs.mkdir(root);await fs.mkdir(other);
  await fs.writeFile(path.join(root,'source.txt'),'original source\n');
  const storage=new ProjectStorage(path.join(directory,'profile'));
  const project=await storage.register(root);
  const neighbor=await storage.register(other);
  await storage.putLocal(project.id,'view',{scrollTop:42});
  await storage.putLocal(project.id,'managed:works:worker-1',{threadId:'worker-1'});
  await storage.putProject(project.id,'annotations','note-1',{text:'old annotation'});
  await storage.putRecovery(project.id,'document:test',{candidate:{text:'unsaved complete candidate'}});
  const run=promisify(execFile),git=async(...args)=>(await run('git',['-C',root,...args])).stdout;
  await git('init');await git('add','source.txt');
  await git('-c','user.name=Nozeli fixture','-c','user.email=fixture@nozeli.invalid','-c','core.hooksPath='+path.join(directory,'no-hooks'),'commit','-m','fixture baseline');
  const instanceDirectory=path.join(storage.root,'instances',project.instanceId);
  const worktree=path.join(instanceDirectory,'execution','worktrees','retained-worker');
  await fs.mkdir(path.dirname(worktree),{recursive:true});
  await git('worktree','add','--detach',worktree,'HEAD');
  await fs.writeFile(path.join(worktree,'source.txt'),'uncommitted worker result\n');
  const worktrees=await git('worktree','list','--porcelain'),status=await git('status','--porcelain');
  const instanceIdentity=await fs.lstat(instanceDirectory);
  const events=[];
  const host={storage,requireRegisteredProject:id=>storage.requireRegistered(id)};
  const workspace={layouts:new Map([[project.id,{projectId:project.id}]]),closeProject:async(id,{operationId})=>{events.push({kind:'close',id,operationId});return {closed:true,projectId:id,operationId};}};
  const managed={stopProject:async id=>{events.push({kind:'stop',id});return {projectId:id,confirmationComplete:true};}};
  const trashItem=async source=>{events.push({kind:'trash',source});throw Error('reset must never trash '+source);};
  const manager=new ProjectLifecycle({host,workspace,managed,trashItem});
  t.after(async()=>{await storage.db.close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,root,other,storage,project,neighbor,git,worktrees,status,worktree,instanceDirectory,instanceIdentity,events,host,workspace,managed,manager};
}
const exists=file=>fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const identityOf=stat=>({dev:String(stat.dev),ino:String(stat.ino)});


test('reset archives verified metadata, keeps instance and worktrees in place, and opens a fresh identity',async t=>{
  const f=await setup(t);
  await f.storage.putLocal(f.neighbor.id,'view',{scrollTop:7});
  const preview=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  const result=await f.manager.execute({token:preview.token});
  assert.equal(result.projectId,f.project.id);assert.equal(result.action,'reset-project');assert.equal(result.complete,true);
  assert.notEqual(result.newProjectId,f.project.id);
  assert.equal(result.backupPath,path.join(f.storage.root,'recovery',f.project.instanceId,'reset',preview.operationId));
  assert.equal(f.workspace.layouts.has(f.project.id),false);
  // Fresh identity opens at the same root with empty state.
  const opened=await f.storage.requireOnline(result.newProjectId);
  assert.equal(opened.root,f.root);assert.notEqual(opened.instanceId,f.project.instanceId);
  assert.equal(await f.storage.getLocal(result.newProjectId,'view'),null);
  assert.equal(await f.storage.getProject(result.newProjectId,'annotations','note-1'),null);
  const manifest=JSON.parse(await fs.readFile(path.join(f.root,'.nozeli','project.json'),'utf8'));
  assert.equal(manifest.projectId,result.newProjectId);
  // Old identity refuses; retained drafts and recovery stay readable under it.
  await assert.rejects(f.storage.requireOnline(f.project.id),{code:'PROJECT_IDENTITY_CONFLICT'});
  assert.equal((await f.storage.getRecovery(f.project.id,'document:test')).candidate.text,'unsaved complete candidate');
  assert.equal((await f.storage.getLocal(f.project.id,'managed:works:worker-1')).threadId,'worker-1');
  // Backup holds the complete old metadata; its manifest lists every retained path.
  const marker=JSON.parse(await fs.readFile(path.join(result.backupPath,'reset.json'),'utf8'));
  assert.equal(marker.phase,'complete');assert.equal(marker.projectId,f.project.id);assert.equal(marker.newProjectId,result.newProjectId);
  assert.equal(marker.paths.metadataArchive,path.join(result.backupPath,'metadata'));
  assert.equal(marker.paths.instanceDirectory,f.instanceDirectory);
  assert.equal(marker.paths.recoveryDirectory,path.join(f.storage.root,'recovery',f.project.instanceId));
  assert.equal(JSON.parse(await fs.readFile(path.join(result.backupPath,'metadata','project.json'),'utf8')).projectId,f.project.id);
  const identityRow=await f.storage.db.request(path.join(result.backupPath,'metadata','project.sqlite'),'get',{collection:'identity',id:'project'});
  assert.equal(identityRow.projectId,f.project.id);
  // The old local instance directory and its Git worktrees never move.
  assert.deepEqual(identityOf(await fs.lstat(f.instanceDirectory)),identityOf(f.instanceIdentity));
  assert.equal(await f.git('worktree','list','--porcelain'),f.worktrees);
  assert.equal(await fs.readFile(path.join(f.worktree,'source.txt'),'utf8'),'uncommitted worker result\n');
  // Source files and Git history are untouched.
  assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'original source\n');
  assert.equal((await f.git('log','-1','--pretty=%s')).trim(),'fixture baseline');
  assert.equal(await f.git('status','--porcelain'),f.status);
  assert.equal((await fs.readdir(f.root)).some(name=>name.startsWith('.nozeli-reset-')||name.startsWith('.nozeli-source-')),false);
  // Other projects keep their own state.
  assert.equal((await f.storage.requireOnline(f.neighbor.id)).id,f.neighbor.id);
  assert.equal((await f.storage.getLocal(f.neighbor.id,'view')).scrollTop,7);
  // Re-registering the same root returns the new identity, and the retired one is explicit.
  assert.equal((await f.storage.register(f.root)).id,result.newProjectId);
  assert.equal((await f.storage.requireRegistered(f.project.id)).removed,true);
  // A cold restart opens the new identity and inherits nothing.
  const cold=new ProjectStorage(path.join(f.directory,'profile'));t.after(()=>cold.db.close());
  assert.equal((await cold.register(f.root)).id,result.newProjectId);
  assert.equal(await cold.getLocal(result.newProjectId,'view'),null);
  await assert.rejects(cold.requireOnline(f.project.id),{code:'PROJECT_IDENTITY_CONFLICT'});
});

test('preview alone never archives; the project keeps its identity until confirmation',async t=>{
  const f=await setup(t);
  const preview=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  assert.equal((await f.storage.requireOnline(f.project.id)).id,f.project.id);
  assert.equal((await f.storage.register(f.root)).id,f.project.id);
  assert.equal(await exists(path.join(await f.storage.recoveryDirectory(f.project.id),'reset',preview.operationId)),false);
  assert.equal((await f.storage.getProject(f.project.id,'annotations','note-1')).text,'old annotation');
  assert.equal(f.events.length,0);
});

test('manifest change after preview invalidates confirmation without moving metadata',async t=>{
  const f=await setup(t),preview=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  const manifestPath=path.join(f.root,'.nozeli','project.json'),manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  await fs.writeFile(manifestPath,JSON.stringify({...manifest,name:'changed after preview'}));
  await assert.rejects(f.manager.execute({token:preview.token}),{code:'PROJECT_IDENTITY_CONFLICT'});
  assert.equal(f.events.length,0);
  assert.equal((await f.storage.requireOnline(f.project.id)).id,f.project.id);
  assert.equal((await f.storage.getProject(f.project.id,'annotations','note-1')).text,'old annotation');
  assert.equal(await exists(path.join(await f.storage.recoveryDirectory(f.project.id),'reset')),false);
});

test('unconfirmed stop keeps every old state and never archives',async t=>{
  const f=await setup(t);
  f.managed.stopProject=async id=>({projectId:id,confirmationComplete:false});
  const preview=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  await assert.rejects(f.manager.execute({token:preview.token}),{code:'PI_EXIT_UNCONFIRMED'});
  await assert.rejects(f.storage.requireOnline(f.project.id),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  const journal=await f.storage.getRecovery(f.project.id,'lifecycle:'+preview.operationId);
  assert.equal(journal.phase,'needs-attention');assert.equal(journal.error.code,'PI_EXIT_UNCONFIRMED');
  f.managed.stopProject=async id=>{f.events.push({kind:'stop',id});return {projectId:id,confirmationComplete:true};};
  const observed=await f.manager.reconcile({projectId:f.project.id,operationId:preview.operationId});
  assert.deepEqual(observed.observation,{metadata:'original',retainedSource:false,registration:'registered',facts:null});
  assert.equal((await f.storage.requireOnline(f.project.id)).id,f.project.id);
  assert.equal((await f.storage.getLocal(f.project.id,'view')).scrollTop,42);
  assert.equal((await f.storage.getProject(f.project.id,'annotations','note-1')).text,'old annotation');
  assert.equal(await exists(path.join(await f.storage.recoveryDirectory(f.project.id),'reset')),false);
  assert.equal(f.events.filter(event=>event.kind==='trash').length,0);
});

test('unknown storage close aborts before any move and a new confirmation still succeeds',async t=>{
  const f=await setup(t);
  const original=f.storage.closeProjectHandles.bind(f.storage);
  f.storage.closeProjectHandles=async()=>{throw Object.assign(Error('存储线程停止未确认'),{code:'STORAGE_RESULT_UNKNOWN'});};
  const blocked=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  await assert.rejects(f.manager.execute({token:blocked.token}),{code:'STORAGE_RESULT_UNKNOWN'});
  const journal=await f.storage.getRecovery(f.project.id,'lifecycle:'+blocked.operationId);
  assert.equal(journal.phase,'needs-attention');assert.equal(journal.error.code,'STORAGE_RESULT_UNKNOWN');
  await assert.rejects(f.storage.requireOnline(f.project.id),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  f.storage.closeProjectHandles=original;
  await f.manager.reconcile({projectId:f.project.id,operationId:blocked.operationId});
  assert.equal((await f.storage.requireOnline(f.project.id)).id,f.project.id);
  assert.equal(await exists(path.join(await f.storage.recoveryDirectory(f.project.id),'reset',blocked.operationId)),false);
  const next=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  const result=await f.manager.execute({token:next.token});
  assert.equal(result.complete,true);
  assert.equal(await f.storage.getLocal(result.newProjectId,'view'),null);
  assert.equal((await f.storage.requireOnline(f.project.id).catch(error=>error.code)),'PROJECT_IDENTITY_CONFLICT');
});

test('reset receipt replays the completed result without archiving twice',async t=>{
  const f=await setup(t),preview=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  const result=await f.manager.execute({token:preview.token});
  const retired=await f.storage.requireRegistered(f.project.id);
  const manifestDigest=createHash('sha256').update(await fs.readFile(path.join(result.backupPath,'metadata','project.json'))).digest('hex');
  const replay=await f.storage.resetProject(f.project.id,{operationId:preview.operationId,expected:{root:retired.root,identity:retired.identity,metadataRoot:retired.metadataRoot,metadataIdentity:retired.metadataIdentity,manifestDigest}});
  assert.deepEqual(replay,result);
  assert.deepEqual((await fs.readdir(result.backupPath)).sort(),['metadata','reset.json']);
});

test('symlinked metadata entities refuse reset without touching targets',async t=>{
  const f=await setup(t);
  const external=path.join(f.directory,'external');await fs.mkdir(external);await fs.writeFile(path.join(external,'preserve'),'private');
  await fs.symlink(external,path.join(f.root,'.nozeli','objects','sha256','link'));
  const inner=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  await assert.rejects(f.manager.execute({token:inner.token}),{code:'PROJECT_METADATA_CONFLICT'});
  assert.equal(await fs.readFile(path.join(external,'preserve'),'utf8'),'private');
  await f.manager.reconcile({projectId:f.project.id,operationId:inner.operationId});
  assert.equal((await f.storage.requireOnline(f.project.id)).id,f.project.id);
  assert.equal(await exists(path.join(await f.storage.recoveryDirectory(f.project.id),'reset')),false);
  await f.storage.db.request(path.join(f.root,'.nozeli','project.sqlite'),'close');
  await fs.rm(path.join(f.root,'.nozeli','objects','sha256','link'));
  const moved=path.join(f.directory,'preserved-metadata');
  await fs.rename(path.join(f.root,'.nozeli'),moved);
  await fs.symlink(moved,path.join(f.root,'.nozeli'));
  await assert.rejects(f.manager.preview({projectId:f.project.id,action:'reset-project'}),{code:'PROJECT_IDENTITY_CONFLICT'});
  const preserved=JSON.parse(await fs.readFile(path.join(moved,'project.json'),'utf8'));
  assert.equal(preserved.projectId,f.project.id);
  assert.equal((await fs.lstat(path.join(f.root,'.nozeli'))).isSymbolicLink(),true);
});

test('registering a root whose metadata disappeared fails explicitly without recreating it',async t=>{
  const f=await setup(t);
  await f.storage.db.request(path.join(f.root,'.nozeli','project.sqlite'),'close');
  await fs.rm(path.join(f.root,'.nozeli'),{recursive:true});
  await assert.rejects(f.storage.register(f.root),{code:'PROJECT_METADATA_MISSING'});
  assert.equal(await exists(path.join(f.root,'.nozeli')),false);
  assert.equal((await f.storage.requireRegistered(f.project.id)).id,f.project.id);
});

test('in-flight reset fences project admission until the swap completes',async t=>{
  const f=await setup(t);
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;}),finish=new Promise(resolve=>{release=resolve;});
  const original=f.storage.resetProject.bind(f.storage);
  f.storage.resetProject=async(id,options)=>{entered();await finish;return original(id,options);};
  const preview=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  const operation=f.manager.execute({token:preview.token});await waiting;
  await assert.rejects(f.storage.requireOnline(f.project.id),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  await assert.rejects(f.storage.putProject(f.project.id,'annotations','late','not admitted'),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  await assert.rejects(f.storage.putLocal(f.project.id,'late','not admitted'),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  release();const result=await operation;
  assert.equal(result.complete,true);
  assert.equal((await f.storage.requireOnline(result.newProjectId)).id,result.newProjectId);
});

test('reset keeps home-ancestor development projects eligible but refuses app-data overlap',async t=>{
  const f=await setup(t);
  const home=path.join(f.directory,'fake-home'),devRoot=path.join(home,'dev','nozeli-like');
  await fs.mkdir(devRoot,{recursive:true});
  const dev=await f.storage.register(devRoot);
  const originalHomedir=os.homedir;
  os.homedir=()=>home;
  try{
    const manager=new ProjectLifecycle({host:f.host,workspace:f.workspace,managed:f.managed,trashItem:f.trashItem});
    const preview=await manager.preview({projectId:dev.id,action:'reset-project'});
    assert.equal(preview.newInstance,true);
    const strict=new ProjectLifecycle({host:f.host,workspace:f.workspace,managed:f.managed,trashItem:f.trashItem,protectedRoots:[f.directory]});
    await assert.rejects(strict.preview({projectId:dev.id,action:'reset-project'}),{code:'PROJECT_RESET_PROTECTED'});
    await assert.rejects(strict.preview({projectId:f.project.id,action:'reset-project'}),{code:'PROJECT_RESET_PROTECTED'});
  }finally{os.homedir=originalHomedir;}
  assert.equal((await f.storage.requireOnline(dev.id)).id,dev.id);
  assert.equal(await exists(path.join(await f.storage.recoveryDirectory(dev.id),'reset')),false);
});

test('metadata replaced between staging and publish refuses without renaming over it',async t=>{
  const f=await setup(t);
  const request=f.storage.db.request.bind(f.storage.db);
  const preview=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  const metadataIdentity=identityOf(await fs.lstat(path.join(f.root,'.nozeli')));
  f.storage.db.request=async(file,op,args={})=>{
    const result=await request(file,op,args);
    if(file.endsWith('project.sqlite')&&file.includes('.nozeli-reset-')&&op==='put'&&args.collection==='identity'){
      const manifestPath=path.join(f.root,'.nozeli','project.json'),manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
      await fs.writeFile(manifestPath,JSON.stringify({...manifest,name:'swapped during copy'}));
    }
    return result;
  };
  await assert.rejects(f.manager.execute({token:preview.token}),{code:'PROJECT_IDENTITY_CONFLICT'});
  f.storage.db.request=request;
  const manifest=JSON.parse(await fs.readFile(path.join(f.root,'.nozeli','project.json'),'utf8'));
  assert.equal(manifest.name,'swapped during copy');
  assert.equal(manifest.projectId,f.project.id);
  assert.deepEqual(identityOf(await fs.lstat(path.join(f.root,'.nozeli'))),metadataIdentity);
  assert.equal((await f.storage.requireOnline(f.project.id)).id,f.project.id);
  assert.equal(await exists(path.join(f.root,'.nozeli-reset-'+preview.operationId)),true);
  const facts=await f.storage.getRecovery(f.project.id,'lifecycle:reset-facts:'+preview.operationId);
  assert.equal(facts.phase,'staged');
  await assert.rejects(f.storage.resetProject(f.project.id,{operationId:preview.operationId,expected:preview.source}),{code:'PROJECT_RESET_PENDING'});
  assert.deepEqual(await f.storage.getRecovery(f.project.id,'lifecycle:reset-facts:'+preview.operationId),facts,'a repeated unfinished operation never overwrites its diagnostic stage');
});

test('an unfinished same-operation artifact is kept and demands verification, never rebuilt',async t=>{
  const f=await setup(t);
  const preview=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  const staging=path.join(f.root,'.nozeli-reset-'+preview.operationId);
  await fs.mkdir(staging);
  await fs.writeFile(path.join(staging,'initialization.json'),JSON.stringify({schema:1,kind:'reset',operationId:preview.operationId}));
  await fs.writeFile(path.join(staging,'witness'),'kept partial staging');
  await assert.rejects(f.manager.execute({token:preview.token}),{code:'PROJECT_RESET_PENDING'});
  assert.equal(await fs.readFile(path.join(staging,'witness'),'utf8'),'kept partial staging');
  assert.equal(JSON.parse(await fs.readFile(path.join(staging,'initialization.json'),'utf8')).operationId,preview.operationId);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'.nozeli','project.json'),'utf8')).projectId,f.project.id);
  assert.equal((await f.storage.requireOnline(f.project.id)).id,f.project.id);
  const archive=path.join(await f.storage.recoveryDirectory(f.project.id),'reset',preview.operationId);
  assert.equal(await exists(path.join(archive,'metadata','project.json')),true);
  const next=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  const witness=path.join(await f.storage.recoveryDirectory(f.project.id),'reset',next.operationId,'witness');
  await fs.mkdir(path.dirname(witness),{recursive:true});
  await fs.writeFile(path.join(path.dirname(witness),'reset.json'),JSON.stringify({schema:1,operationId:next.operationId,projectId:f.project.id,instanceId:f.project.instanceId}));
  await fs.writeFile(witness,'kept partial archive');
  await assert.rejects(f.manager.execute({token:next.token}),{code:'PROJECT_RESET_PENDING'});
  assert.equal(await fs.readFile(witness,'utf8'),'kept partial archive');
  assert.equal((await f.storage.requireOnline(f.project.id)).id,f.project.id);
  assert.equal((await f.storage.getRecovery(f.project.id,'lifecycle:reset-facts:'+next.operationId)).phase,'verified');
});

for(const stopAt of ['register','initialization'])test(`a failure before ${stopAt} keeps the project root fenced until explicit verification`,async t=>{
  const f=await setup(t);
  const request=f.storage.db.request.bind(f.storage.db);let failed=false;
  f.storage.db.request=async(file,op,args={})=>{
    if(!failed&&file===f.storage.catalog&&op==='put'&&String(args.operationId||'').endsWith(':'+stopAt)){failed=true;throw Error('simulated catalog interruption');}
    return request(file,op,args);
  };
  const preview=await f.manager.preview({projectId:f.project.id,action:'reset-project'});
  await assert.rejects(f.manager.execute({token:preview.token}),/simulated catalog interruption/);
  f.storage.db.request=request;
  const facts=await f.storage.getRecovery(f.project.id,'lifecycle:reset-facts:'+preview.operationId);
  assert.equal(facts.phase,stopAt==='register'?'retired':'registered');assert.equal(typeof facts.newProjectId,'string');assert.equal(facts.swap,path.join(f.root,'.nozeli-source-'+preview.operationId));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'.nozeli','project.json'),'utf8')).projectId,facts.newProjectId);
  assert.equal(await exists(facts.swap),true);
  await assert.rejects(f.storage.requireOnline(f.project.id),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  assert.equal((await f.storage.getRecovery(f.project.id,'document:test')).candidate.text,'unsaved complete candidate');
  const cold=new ProjectStorage(path.join(f.directory,'profile'));t.after(()=>cold.db.close());
  await assert.rejects(cold.requireOnline(f.project.id),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  await assert.rejects(cold.register(f.root),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  const observed=await f.manager.reconcile({projectId:f.project.id,operationId:preview.operationId});
  assert.equal(observed.observation.facts.phase,facts.phase);
  assert.equal((await f.storage.requireRegistered(f.project.id)).removed,true);
  const coldTwo=new ProjectStorage(path.join(f.directory,'profile'));t.after(()=>coldTwo.db.close());
  if(stopAt==='register'){
    const registered=await coldTwo.list();
    // Native owner inspection may refuse before reaching the confirmation;
    // either refusal must leave the interrupted registration exactly intact.
    await assert.rejects(coldTwo.register(f.root),error=>['PROJECT_RECOVERY_CANCELLED','RECOVERY_OWNER_UNVERIFIED','RECOVERY_SOURCE_ACTIVE'].includes(error.code));
    assert.deepEqual(await coldTwo.list(),registered);
  }
  else assert.equal((await coldTwo.register(f.root)).id,facts.newProjectId,'explicit reconciliation may open the already committed fresh registration');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'.nozeli','project.json'),'utf8')).projectId,facts.newProjectId);
});
