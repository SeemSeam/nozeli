import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ProjectLifecycle} from '../src/main/project-lifecycle.mjs';
import {repository} from '../src/agents/managed/git-service.mjs';
const exec=promisify(execFile);
const exists=file=>fs.lstat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
async function setup(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-permanent-reset-')),root=path.join(directory,'project');await fs.mkdir(root);await fs.writeFile(path.join(root,'source.txt'),'user source\n');
 const storage=new ProjectStorage(path.join(directory,'profile'));const project=await storage.register(root);const otherRoot=path.join(directory,'other');await fs.mkdir(otherRoot);const other=await storage.register(otherRoot);
 const git=async(...args)=>(await exec('git',['-C',root,...args])).stdout;
 await git('init');await git('add','source.txt');await git('-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','core.hooksPath=/dev/null','commit','-m','user history');
 await storage.putLocal(project.id,'draft',{text:'unsaved'});await storage.putLocal(project.id,'workspace:layout',{tabs:['old']});await storage.putProject(project.id,'sessions','old',{body:'session'});await storage.putObject(project.id,Buffer.from('old material'));await storage.putRecovery(project.id,'draft:old',{text:'recovery'});await storage.putLocal(other.id,'view',{scroll:7});
 const global=path.join(directory,'profile','account.json');await fs.writeFile(global,'global-account-sentinel');
 const events=[],workspace={layouts:new Map([[project.id,{}]]),closeProject:async id=>{events.push(['close',id]);return {closed:true};}},managed={stopProject:async id=>{events.push(['stop',id]);return {confirmationComplete:true};}};
 const host={storage,requireRegisteredProject:id=>storage.requireRegistered(id)},manager=new ProjectLifecycle({host,workspace,managed,trashItem:async()=>{throw Error('must not trash');}});
 t.after(async()=>{await storage.db.close();await fs.rm(directory,{recursive:true,force:true});});
 return {directory,root,project,other,storage,git,global,events,workspace,managed,host,manager};
}
const preview=f=>f.manager.preview({projectId:f.project.id,action:'reset-project'});
const execute=(f,p)=>f.manager.execute({token:p.token,confirmPermanentDelete:true});
async function historical(f,next){
 const id=randomUUID(),instanceId=randomUUID(),old={...f.project,id,instanceId,removed:true,reset:{newProjectId:next,operationId:randomUUID()}};
 await f.storage.db.request(f.storage.catalog,'put',{collection:'instances',id,value:old});await f.storage.putLocal(id,'draft',{text:'historical draft'});await f.storage.putRecovery(id,'draft:old',{text:'historical recovery'});
 const archive=path.join(await f.storage.recoveryDirectory(id),'reset',randomUUID(),'metadata');await fs.mkdir(archive,{recursive:true});await fs.writeFile(path.join(archive,'project.json'),JSON.stringify({schema:1,projectId:id}));await fs.writeFile(path.join(archive,'old-object'),'secret old object');return old;
}
async function worktree(f,owner=f.project){
 const repo=await repository(f.root),workId='worker-'+randomUUID(),branchRef='refs/heads/nozeli/work-'+workId+'-'+randomUUID(),runtime=path.join(await f.storage.localDirectory(owner.id),'execution'),directory=path.join(runtime,'execution',workId);
 await fs.mkdir(path.dirname(directory),{recursive:true});await f.git('worktree','add','-b',branchRef.slice(11),directory,'HEAD');await fs.writeFile(path.join(directory,'source.txt'),'worker candidate\n');
 const workerGitDir=await fs.realpath((await exec('git',['-C',directory,'rev-parse','--absolute-git-dir'])).stdout.trim()),m={schema:2,workId,...repo,directory,branchRef,baseCommit:repo.targetHead,inputCommit:repo.targetHead,workerGitDir,gitPointer:await fs.readFile(path.join(directory,'.git'),'utf8')};await fs.mkdir(path.join(runtime,'evidence'),{recursive:true});await fs.writeFile(path.join(runtime,'evidence','execution-'+workId+'.json'),JSON.stringify(m));return m;
}
test('permanent reset removes all archived generations and owned Git resources, preserves source, global and neighbors',async t=>{
 const f=await setup(t),old=await historical(f,f.project.id),older=await historical(f,old.id),m=await worktree(f,old);
 const userTree=path.join(f.directory,'user-worktree');await f.git('worktree','add','--detach',userTree,'HEAD');await f.git('branch','user-kept');const head=(await f.git('rev-parse','HEAD')).trim();
 const p=await preview(f);assert.equal(p.permanentDelete,true);assert.equal(p.recoveryRetained,false);assert.deepEqual(new Set(p.relatedProjectIds),new Set([f.project.id,old.id,older.id]));assert.equal(p.accountsAffected,false);
 const result=await execute(f,p);assert.equal(result.complete,true);assert.notEqual(result.newProjectId,f.project.id);assert.notEqual(result.newInstanceId,f.project.instanceId);assert.equal(result.recoveryRetained,false);
 for(const row of [f.project,old,older]){await assert.rejects(f.storage.requireRegistered(row.id),{code:'UNKNOWN_PROJECT'});assert.equal(await exists(path.join(f.storage.root,'instances',row.instanceId)),false);assert.equal(await exists(path.join(f.storage.root,'recovery',row.instanceId)),false);assert(f.events.some(([kind,id])=>kind==='stop'&&id===row.id));}
 const fresh=await f.storage.requireOnline(result.newProjectId);assert.equal(fresh.lineage,null);assert.equal(await f.storage.getLocal(fresh.id,'draft'),null);assert.equal(await f.storage.getLocal(fresh.id,'workspace:layout'),null);assert.deepEqual(await f.storage.listProject(fresh.id,'sessions'),[]);assert.deepEqual(await fs.readdir(path.join(f.root,'.nozeli','objects','sha256')),[]);
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'user source\n');assert.equal((await f.git('rev-parse','HEAD')).trim(),head);assert.equal(await exists(userTree),true);assert.equal((await f.git('rev-parse','user-kept')).trim(),head);await assert.rejects(f.git('rev-parse','--verify',m.branchRef));assert(!(await f.git('worktree','list','--porcelain')).includes(m.directory));
 assert.equal(await fs.readFile(f.global,'utf8'),'global-account-sentinel');assert.deepEqual(await f.storage.getLocal(f.other.id,'view'),{scroll:7});assert.equal((await f.storage.register(f.root)).id,fresh.id);
 assert.deepEqual(await f.storage.resetProject(f.project.id,{operationId:p.operationId}),result);
 const cold=new ProjectStorage(path.join(f.directory,'profile'));t.after(()=>cold.db.close());assert.equal((await cold.register(f.root)).id,fresh.id);await assert.rejects(cold.requireRegistered(old.id),{code:'UNKNOWN_PROJECT'});
});
test('explicit permanent consent is required and preview is non-destructive',async t=>{const f=await setup(t),p=await preview(f);await assert.rejects(f.manager.execute({token:p.token}),{code:'PERMANENT_DELETE_CONFIRMATION_REQUIRED'});assert.equal(f.events.length,0);assert.equal((await f.storage.getLocal(f.project.id,'draft')).text,'unsaved');await execute(f,p);});
for(const kind of ['stop','save','close'])test(`${kind} failure retains project and persistent fence`,async t=>{const f=await setup(t);if(kind==='stop')f.managed.stopProject=async()=>({confirmationComplete:false});if(kind==='save')f.workspace.closeProject=async()=>{throw Object.assign(Error('save failed'),{code:'SAVE_FAILED'});};if(kind==='close')f.storage.closeProjectHandles=async()=>{throw Object.assign(Error('unknown close'),{code:'STORAGE_RESULT_UNKNOWN'});};const p=await preview(f);await assert.rejects(execute(f,p));assert.equal(await exists(path.join(f.root,'.nozeli')),true);assert(f.storage.lifecycleHolds.has(f.project.id));const receipt=await f.manager.reconcile({projectId:f.project.id,operationId:p.operationId});assert.equal(receipt.blocked,true);assert.equal(receipt.observationOnly,true);});
test('metadata symlink refuses without deleting external files',async t=>{const f=await setup(t),external=path.join(f.directory,'external');await fs.mkdir(external);await fs.writeFile(path.join(external,'keep'),'keep');await fs.symlink(external,path.join(f.root,'.nozeli','link'));const p=await preview(f);await assert.rejects(execute(f,p),{code:'PROJECT_METADATA_CONFLICT'});assert.equal(await fs.readFile(path.join(external,'keep'),'utf8'),'keep');});
test('confirmation binds history scope and root manifest',async t=>{const f=await setup(t),p=await preview(f);await historical(f,f.project.id);await assert.rejects(execute(f,p),{code:'PROJECT_RESET_SCOPE_CHANGED'});assert.equal((await f.storage.requireRegistered(f.project.id)).id,f.project.id);});
test('manifest mutation after preview refuses before stop',async t=>{const f=await setup(t),p=await preview(f),file=path.join(f.root,'.nozeli','project.json'),m=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...m,changed:true}));await assert.rejects(execute(f,p),{code:'PROJECT_IDENTITY_CONFLICT'});assert.equal(f.events.length,0);});
test('unknown local worktree ownership refuses instead of removing user Git registration',async t=>{const f=await setup(t),directory=path.join(await f.storage.localDirectory(f.project.id),'foreign-worktree');await f.git('worktree','add','--detach',directory,'HEAD');const p=await preview(f);await assert.rejects(execute(f,p),{code:'PROJECT_RESET_CONFLICT'});assert.equal(await exists(directory),true);assert((await f.git('worktree','list','--porcelain')).includes(directory));});
test('interrupted confirmed reset safely finishes its exact scope after cold restart without replaying business',async t=>{
 const f=await setup(t),p=await preview(f),request=f.storage.db.request.bind(f.storage.db);let interrupted=false;
 const head=(await f.git('rev-parse','HEAD')).trim();
 f.storage.db.request=async(file,op,args)=>{
  if(!interrupted&&file===f.storage.catalog&&op==='put'&&args?.collection==='permanent_resets'&&args.value.phase==='cleared'){interrupted=true;throw Object.assign(Error('phase persistence failure'),{code:'FIXTURE_PHASE_FAILURE'});}
  return request(file,op,args);
 };
 await assert.rejects(execute(f,p),{code:'FIXTURE_PHASE_FAILURE'});f.storage.db.request=request;
 const receipt=await f.manager.reconcile({projectId:f.project.id,operationId:p.operationId});assert.equal(receipt.blocked,true);
 assert.equal(await exists(path.join(f.root,'.nozeli')),false);
 await f.storage.db.close();
 const cold=new ProjectStorage(path.join(f.directory,'profile'));t.after(()=>cold.db.close());await cold.ready();
 assert(cold.lifecycleHolds.has(f.project.id));await assert.rejects(cold.register(f.root),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 const manager=new ProjectLifecycle({host:{storage:cold,requireRegisteredProject:id=>cold.requireRegistered(id)},workspace:f.workspace,managed:f.managed,trashItem:async()=>{throw Error('must not trash');}});
 const available=await manager.ensureProjectAvailable(f.project.id);assert.equal(available.available,true);assert.notEqual(available.projectId,f.project.id);
 const fresh=await cold.requireOnline(available.projectId);assert.equal(fresh.semanticInitializationEligible,true);
 assert.equal(await cold.getLocal(fresh.id,'draft'),null);assert.deepEqual(await cold.listProject(fresh.id,'sessions'),[]);
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'user source\n');assert.equal((await f.git('rev-parse','HEAD')).trim(),head);
 assert.deepEqual(await cold.getLocal(f.other.id,'view'),{scroll:7});assert.equal(cold.lifecycleHolds.size,0);
});
test('a different root sharing an instance refuses preview without clearing either project',async t=>{const f=await setup(t);const shared={...f.other,instanceId:f.project.instanceId};await f.storage.db.request(f.storage.catalog,'put',{collection:'instances',id:shared.id,value:shared});await assert.rejects(preview(f),{code:'PROJECT_RESET_CONFLICT'});assert.equal((await f.storage.getLocal(f.project.id,'draft')).text,'unsaved');assert.equal(await exists(path.join(f.root,'.nozeli')),true);});
