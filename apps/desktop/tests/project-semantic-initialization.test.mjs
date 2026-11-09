import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectInitialization,INITIALIZATION_LIMITS,initializationPath} from '../src/agents/managed/project-initialization.mjs';
import {defaultFilesystemAdapter} from '../src/agents/managed/file-stream.mjs';
import {MemoryVersion} from '../src/agents/managed/memory-version.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-init-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const content=path.join(root,'project'),memory=path.join(content,'.nozeli','memory','plantree');await fs.mkdir(memory,{recursive:true});await fs.writeFile(path.join(memory,'index.md'),'# Plan Tree\n');
 const project={instanceId:'instance-a'},job={id:'job-a',target:'orchestrator',type:'project-initialization',status:'running',context:{projectInstanceId:'instance-a',restrictedMode:'project-initialization'}};
 const controller={projectId:'project-a',store:{content,plan:path.join(memory,'index.md'),state:{jobs:[job]},storage:{requireRegistered:async()=>project,assertActive(){}},mutate:async fn=>fn()},memoryVersion:new MemoryVersion(memory)};
 return {root,content,memory,project,job,controller,init:new ProjectInitialization(controller)};
}
test('inventory excludes credentials, generated directories and symbolic links; reads only own inventory',async t=>{
 const {content,job,init}=await fixture(t);await fs.writeFile(path.join(content,'README.md'),'# Project\nA local project\n');await fs.writeFile(path.join(content,'.env'),'TOKEN=private');await fs.mkdir(path.join(content,'node_modules'));await fs.writeFile(path.join(content,'node_modules','private.txt'),'private');await fs.symlink('/etc/passwd',path.join(content,'outside.txt'));
 const inventory=await init.tool(job,'nozeli_project_inventory');assert.deepEqual(inventory.files,['README.md']);assert(inventory.coverage.excludedEntries>=4);
 const read=await init.tool(job,'nozeli_project_read',{relPath:'README.md'});assert.match(read.text,/local project/);assert.equal(read.startLine,1);assert.match(read.version,/^[a-f0-9]{64}$/);
 for(const reply of [inventory,read]){assert.equal(reply.readOnly,true);assert.equal(reply.continueTurn,true);assert.equal(reply.hostControl,undefined);}
 for(const rel of ['../outside','https://example.org/a','.env','node_modules/private.txt','outside.txt'])await assert.rejects(init.tool(job,'nozeli_project_read',{relPath:rel}));
 await assert.rejects(init.tool(job,'nozeli_privileged_execute',{command:'true'}),{code:'PROJECT_INITIALIZATION_TOOL_REJECTED'});
});
test('single editable root-linked topic records host sources and refuses concurrent user edits',async t=>{
 const {content,memory,job,init,controller}=await fixture(t);await fs.writeFile(path.join(content,'README.md'),'# Purpose\nLocal notes\n');
 const inventory=await init.tool(job,'nozeli_project_inventory');await init.tool(job,'nozeli_project_read',{relPath:'README.md'});
 const published=await init.tool(job,'nozeli_project_map',{expectedVersion:inventory.map.expectedVersion,text:'Purpose: local notes. Unverified project understanding.'});assert.equal(published.saved,true);
 assert.equal(published.hostControl,true);assert.equal(published.saved,true);assert.notEqual(published.continueTurn,true);assert.equal(job.projectMapPublication.state,'durable');
 const snapshot=await controller.memoryVersion.snapshot();assert(snapshot.topics.some(topic=>topic.path==='topics/project-map.md'));assert.match(snapshot.topics[0].text,/bounded-prefix/);assert.equal(controller.store.state.jobs[0].projectMap.version,published.version);
 await fs.writeFile(path.join(memory,'topics','project-map.md'),'User correction must survive.');
 await assert.rejects(init.tool(job,'nozeli_project_map',{expectedVersion:published.version,text:'Replacement'}),{code:'PROJECT_INITIALIZATION_MAP_CONFLICT'});assert.equal(await fs.readFile(path.join(memory,'topics','project-map.md'),'utf8'),'User correction must survive.');
});
test('stale instance and cancellation refuse late map publication',async t=>{
 const {job,init,project,memory}=await fixture(t);const inventory=await init.tool(job,'nozeli_project_inventory');project.instanceId='instance-b';
 await assert.rejects(init.tool(job,'nozeli_project_map',{expectedVersion:inventory.map.expectedVersion,text:'late'}),{code:'PROJECT_INITIALIZATION_STALE'});
 project.instanceId='instance-a';job.context.cancelRequested=true;await assert.rejects(init.tool(job,'nozeli_project_inventory'),{code:'PROJECT_INITIALIZATION_CANCELLED'});
 await assert.rejects(fs.stat(path.join(memory,'topics','project-map.md')),{code:'ENOENT'});
});
test('traversal and read budgets report honest partial coverage without paging beyond the run budget',async t=>{
 const {content,job,init}=await fixture(t);await Promise.all(Array.from({length:INITIALIZATION_LIMITS.entries+10},(_,i)=>fs.writeFile(path.join(content,`file-${i}.txt`),'x'.repeat(20000))));
 const inventory=await init.tool(job,'nozeli_project_inventory');assert(inventory.coverage.inventoryTruncated);assert(inventory.coverage.visitedEntries<=INITIALIZATION_LIMITS.entries);
 let bytes=0;for(let i=0;i<8;i++){const read=await init.tool(job,'nozeli_project_read',{relPath:inventory.files[i]});bytes+=Math.min(read.size,INITIALIZATION_LIMITS.fileBytes);assert(read.truncated);}
 assert.equal(bytes,INITIALIZATION_LIMITS.bytes);await assert.rejects(init.tool(job,'nozeli_project_read',{relPath:inventory.files[8]}),{code:'PROJECT_INITIALIZATION_READ_BUDGET'});
});
test('program creates one serial job per instance; retry is explicit and never creates a Work',async()=>{
 const jobs=[],c={projectId:'p',store:{state:{jobs,works:[]},storage:{requireOnline:async()=>({instanceId:'i'}),requireRegistered:async()=>({instanceId:'i'})},mutate:async fn=>fn()},queueJob(target,type,text,{context}){jobs.push({id:'job-'+jobs.length,target,type,text,context,status:'queued'});},changed(){},kick(){},initializationStatus:Controller.prototype.initializationStatus};
 await Controller.prototype.initializeProject.call(c);await Controller.prototype.initializeProject.call(c);assert.equal(jobs.length,1);assert.equal(jobs[0].target,'orchestrator');assert.equal(jobs[0].type,'project-initialization');assert.equal(c.store.state.works.length,0);
 jobs[0].status='failed';await Controller.prototype.initializeProject.call(c);assert.equal(jobs.length,1);await Controller.prototype.initializeProject.call(c,{retry:true,expectedProjectInstanceId:'i'});assert.equal(jobs.length,2);
 await assert.rejects(Controller.prototype.initializeProject.call(c,{retry:true,expectedProjectInstanceId:'old'}),{code:'PROJECT_INITIALIZATION_STALE'});
});
test('legacy and AI-disabled local opens do not connect or initialize',async()=>{
 let connects=0;const project={instanceId:'i'},manager={host:{requireRegisteredProject:async()=>project},config:async()=>({enabled:true}),initializationStatus:async()=>({status:'pending'}),connect:async()=>{connects++;},controllers:new Map()};
 await ManagedProjects.prototype.initializeProject.call(manager,'p');assert.equal(connects,0);project.semanticInitializationEligible=true;manager.config=async()=>({enabled:false});await ManagedProjects.prototype.initializeProject.call(manager,'p');assert.equal(connects,0);
});
test('path exclusions reject known credential variants',()=>{for(const rel of ['.git/config','.nozeli/project.json','.env.local','x/secret.key','credentials.json','dist/app.js','vendor/module.js'])assert.throws(()=>initializationPath(rel));});
test('partial publication never claims initialized or leaves an orphan; explicit retry completes the linked topic',async t=>{
 const {job,init,memory,controller}=await fixture(t),inventory=await init.tool(job,'nozeli_project_inventory');
 // The publication rename is a pinned chain operation (native renameat on
 // macOS, /proc-pinned fs.rename on Linux); fs.renameSync is never on the
 // path. The fault is injected at that contract seam and only for the topic
 // publish itself — the link-first index rename, barriers, cleanup and retry
 // keep their real behavior.
 const chain=defaultFilesystemAdapter.chain,rename=chain.rename;chain.rename=async(fromDirectory,fromName,toDirectory,toName)=>{if(toName==='project-map.md')throw Object.assign(Error('injected publication failure'),{code:'EIO'});return rename(fromDirectory,fromName,toDirectory,toName);};
 try{await assert.rejects(init.tool(job,'nozeli_project_map',{expectedVersion:inventory.map.expectedVersion,text:'First attempt'}),{code:'EIO'});}finally{chain.rename=rename;}
 assert.equal(job.projectMap,undefined);assert.equal(job.projectMapPublication.state,'prepared');assert.match(await fs.readFile(path.join(memory,'index.md'),'utf8'),/topics\/project-map\.md/);await assert.rejects(fs.stat(path.join(memory,'topics','project-map.md')),{code:'ENOENT'});
 const retry=new ProjectInitialization(controller),current=await retry.tool(job,'nozeli_project_inventory');await retry.tool(job,'nozeli_project_map',{expectedVersion:current.map.expectedVersion,text:'Retry completed'});
 assert.equal(job.projectMapPublication.state,'durable');const snapshot=await controller.memoryVersion.snapshot();assert.match(snapshot.topics[0].text,/Retry completed/);
});

test('diagnostic admission excludes external refusal and held projects without creating owners',async()=>{
 let recorded=0;const c={started:true,store:{},maintenance:{read:async()=>({bugs:[]}),record:async()=>{recorded++;return {id:'b'};}},maintenanceEvent:async()=>({eventJobId:'e'})};
 const manager={controllers:new Map([['p',c]]),host:{storage:{lifecycleHolds:new Map(),assertActive(){}}}};
 for(const code of ['EACCES','AUTHORIZATION_FAILED','ENOSPC','STORAGE_RESULT_UNKNOWN'])assert.equal((await ManagedProjects.prototype.diagnoseProject.call(manager,'p',{code})).diagnosis,'unavailable');
 manager.host.storage.lifecycleHolds.set('p',{});assert.deepEqual(await ManagedProjects.prototype.diagnoseProject.call(manager,'p',{code:'PROJECT_FLUSH_FAILED'}),{diagnosis:'unavailable',reason:'project-held'});assert.equal(recorded,0);
 manager.host.storage.lifecycleHolds.clear();assert.equal((await ManagedProjects.prototype.diagnoseProject.call(manager,'p',{code:'PROJECT_FLUSH_FAILED'})).diagnosis,'queued');assert.equal(recorded,1);
});
