import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {ShadowVersions} from '../src/agents/managed/shadow-versions.mjs';
import {selectFilesystemAdapter} from '../src/platform/shared/filesystem.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {ProjectLifecycle} from '../src/main/project-lifecycle.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};

test('alpha6 unsupported Windows synchronous chain operations throw before publication can continue',()=>{
 const adapter=selectFilesystemAdapter({platform:'win32'});
 assert.equal(adapter.supported,false);
 for(const operation of ['openFileSync','renameSync','syncSync']){
  let continued=false;
  assert.throws(()=>{adapter.chain[operation]();continued=true;},error=>
   error.code==='FS_PLATFORM_UNSUPPORTED'&&error.details.operation==='chain.'+operation);
  assert.equal(continued,false);
 }
});
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-alpha6-boundary-'));
 const profile=path.join(root,'profile'),projectRoot=path.join(root,'project');
 await ensureExperimentalPrivateDirectory(root,profile);await fs.mkdir(projectRoot);
 await fs.writeFile(path.join(projectRoot,'source.txt'),'original 中文 🧭');
 const storage=new ProjectStorage(profile,{windowsDesktopProjects:true});
 t.after(async()=>{await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 const project=await storage.register(projectRoot);
 return {root,profile,projectRoot,storage,project};
}

test('alpha6 Windows re-registration preserves native project identity and its draft',native,async t=>{
 const f=await fixture(t);await f.storage.putLocal(f.project.id,'draft',{text:'unsent'});
 const reopened=await f.storage.register(f.projectRoot);
 assert.equal(reopened.id,f.project.id);assert.equal(reopened.instanceId,f.project.instanceId);
 assert.deepEqual(await f.storage.getLocal(reopened.id,'draft'),{text:'unsent'});
 assert.equal((await f.storage.requireOnline(reopened.id)).id,reopened.id);
});

test('alpha6 Windows semantic initialization refuses before configuration, Controller connection or job mutation',native,async t=>{
 const f=await fixture(t);let effects=0;
 const forbidden=()=>{effects++;throw Error('must refuse before runtime effects');};
 const controller={projectId:f.project.id,store:{storage:f.storage,state:{jobs:[]},mutate:forbidden},queueJob:forbidden,changed:forbidden,kick:forbidden};
 const managed={host:{requireRegisteredProject:id=>f.storage.requireRegistered(id)},config:forbidden,connect:forbidden};
 for(const retry of [false,true]){
  await assert.rejects(Controller.prototype.initializeProject.call(controller,{retry}),{code:'PROJECT_INITIALIZATION_UNSUPPORTED'});
  await assert.rejects(ManagedProjects.prototype.initializeProject.call(managed,f.project.id,{retry}),{code:'PROJECT_INITIALIZATION_UNSUPPORTED'});
 }
 assert.equal(effects,0);assert.deepEqual(controller.store.state.jobs,[]);
 const status=await Controller.prototype.initializationStatus.call(controller);
 assert.equal(status.status,'unsupported');assert.equal(status.errorCode,'PROJECT_INITIALIZATION_UNSUPPORTED');
 assert.equal(await fs.readFile(path.join(f.projectRoot,'source.txt'),'utf8'),'original 中文 🧭');
});

test('alpha6 Windows permanent reset refuses before scope enumeration and leaves registered data and drafts intact',native,async t=>{
 const f=await fixture(t);await f.storage.putLocal(f.project.id,'draft',{text:'keep me'});
 const before=await fs.readFile(path.join(f.projectRoot,'.nozeli','project.json'));
 await assert.rejects(f.storage.resetScope(f.project.id),{code:'PERSISTENCE_UNSUPPORTED'});
 await assert.rejects(f.storage.resetProject(f.project.id,{operationId:'never-started'}),{code:'PERSISTENCE_UNSUPPORTED'});
 assert.deepEqual(await fs.readFile(path.join(f.projectRoot,'.nozeli','project.json')),before);
 assert.deepEqual(await f.storage.getLocal(f.project.id,'draft'),{text:'keep me'});
 assert.equal((await f.storage.requireOnline(f.project.id)).removed,false);
 assert.equal(f.storage.lifecycleHolds.size,0);
 assert.equal(await fs.readFile(path.join(f.projectRoot,'source.txt'),'utf8'),'original 中文 🧭');
});

test('alpha6 Windows incomplete reset recovery refuses before stop, discard, hold mutation or writes',native,async t=>{
 const f=await fixture(t);await f.storage.putLocal(f.project.id,'draft',{text:'retain reset draft'});
 const operationId=randomUUID(),hold={projectId:f.project.id,instanceId:f.project.instanceId,operationId,action:'reset-project',pendingCount:0};
 const receipt={phase:'deleting',projectId:f.project.id,operationId,scope:{projects:[{id:f.project.id,instanceId:f.project.instanceId}]},expected:{instanceId:f.project.instanceId}};
 f.storage.lifecycleHolds.set(f.project.id,hold);const originalHold=structuredClone(hold),manifest=await fs.readFile(path.join(f.projectRoot,'.nozeli','project.json'));
 let effects=0;const forbidden=()=>{effects++;throw Error('reset effect forbidden');};
 const storage={root:f.profile,lifecycleHolds:f.storage.lifecycleHolds,ready:async()=>{},catalog:'synthetic-catalog',db:{request:async(file,op,payload)=>{assert.equal(op,'get');assert.equal(payload.collection,'permanent_resets');return receipt;}},resetProject:forbidden,releaseProject:forbidden};
 const lifecycle=new ProjectLifecycle({host:{storage},workspace:{closeProject:forbidden},managed:{projectStops:new Map(),stopProject:forbidden},beforeStop:forbidden});
 lifecycle.stopHeldProject=forbidden;
 await assert.rejects(lifecycle.ensureProjectAvailable(f.project.id),{code:'PERSISTENCE_UNSUPPORTED'});
 assert.equal(effects,0);assert.equal(lifecycle.tokens.size,0);assert.equal(lifecycle.operations.size,0);assert.equal(storage.lifecycleHolds.size,1);assert.equal(storage.lifecycleHolds.get(f.project.id),hold);assert.deepEqual(hold,originalHold);
 assert.deepEqual(await fs.readFile(path.join(f.projectRoot,'.nozeli','project.json')),manifest);
 assert.deepEqual(await f.storage.getLocal(f.project.id,'draft'),{text:'retain reset draft'});
 assert.equal(await fs.readFile(path.join(f.projectRoot,'source.txt'),'utf8'),'original 中文 🧭');
});

test('alpha6 Windows initialization status retains historical maps without advertising readable or retryable support',native,async t=>{
 const f=await fixture(t),map={version:'synthetic-retained-version',path:'topics/project-map.md'},job={id:'retained-init',type:'project-initialization',status:'failed',errorCode:'HISTORICAL_FAILURE',projectMap:map,context:{projectInstanceId:f.project.instanceId}},state={jobs:[job]},before=structuredClone(state);
 const mapFile=path.join(f.projectRoot,'.nozeli','memory','plantree','topics','project-map.md'),mapBytes=Buffer.from('# Retained synthetic map\r\n历史资料 🧭\r\n');await fs.mkdir(path.dirname(mapFile),{recursive:true});await fs.writeFile(mapFile,mapBytes);
 const controller={projectId:f.project.id,store:{storage:f.storage,state}};
 const managed={host:{requireRegisteredProject:id=>f.storage.requireRegistered(id)},controllers:new Map(),projectionSource:async()=>({state})};
 for(const connected of [false,true]){
  if(connected)managed.controllers.set(f.project.id,controller);
  const status=await ManagedProjects.prototype.initializationStatus.call(managed,f.project.id);
  assert.equal(status.status,'unsupported');assert.equal(status.errorCode,'PROJECT_INITIALIZATION_UNSUPPORTED');assert.equal(status.mapReadable,false);assert.equal(status.retainedStatus,'failed');assert.equal(status.retainedErrorCode,'HISTORICAL_FAILURE');assert.equal(status.jobId,job.id);assert.deepEqual(status.map,map);
 }
 const status=await Controller.prototype.initializationStatus.call(controller);assert.equal(status.status,'unsupported');assert.equal(status.mapReadable,false);assert.deepEqual(status.map,map);assert.equal(status.retainedStatus,'failed');
 await assert.rejects(ManagedProjects.prototype.initializationRead.call(managed,f.project.id),{code:'PROJECT_INITIALIZATION_UNSUPPORTED'});
 assert.deepEqual(state,before);
 assert.deepEqual(await fs.readFile(mapFile),mapBytes);
});

// This exercises the frozen-object staging boundary, not Windows checkpoint
// admission/provenance or project semantic initialization, which remain gated.
for(const requestId of ['r'.repeat(200),'checkpoint:windows:1'])test(`alpha6 Windows frozen checkpoint staging keeps request identity out of scratch names (${requestId.length} chars)`,native,async t=>{
 const f=await fixture(t),versions=new ShadowVersions({projectRoot:f.projectRoot,projectId:f.project.id,storage:f.storage});
 const bytes=Buffer.from('Frozen checkpoint 中文 🧭\r\n'),digest=createHash('sha256').update(bytes).digest('hex');
 await f.storage.putObject(f.project.id,bytes);
 await versions.ensureRepo();
 const entry={relPath:'source.txt',digest,docId:randomUUID(),revision:1,bytesLength:bytes.length};
 const meta={checkpointRequestId:requestId,workId:'synthetic-frozen-staging',docs:{'source.txt':entry}};
 const staging=path.join(await f.storage.localDirectory(f.project.id),'versions-staging');
 await fs.mkdir(staging,{recursive:true});
 await fs.writeFile(path.join(staging,'unrelated.txt'),'retained foreign scratch');
 const tree=await versions.stageEntries([entry],meta);
 assert.match(tree,/^[a-f0-9]{40}$/);
 assert.deepEqual(await versions.git(['show',`${tree}:source.txt`]),bytes);
 assert.deepEqual(JSON.parse(await versions.git(['show',`${tree}:.nozeli-meta/checkpoint.json`])),meta);
 assert.deepEqual(await fs.readdir(staging),['unrelated.txt']);
 assert.equal(await fs.readFile(path.join(staging,'unrelated.txt'),'utf8'),'retained foreign scratch');
 assert.equal(await fs.readFile(path.join(f.projectRoot,'source.txt'),'utf8'),'original 中文 🧭');
});
