import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {serve} from './pi-provider.fixture.mjs';
import {recordedBugScenario,recordedBugTask,chaosDemoHtml} from './recorded-bug-scenario.fixture.mjs';

// Actual private Pi owners, production Controller/storage/Git and native write.
// Same recorded input/arguments; the repaired source must need no DEBUG event.
const app=path.resolve(process.env.NOZELI_TEST_APP_ROOT||path.join(import.meta.dirname,'..'));
const load=rel=>import(pathToFileURL(path.join(app,rel)).href);
const {DesktopHost}=await load('src/main/host.mjs');
const {ManagedProjects}=await load('src/agents/managed-projects.mjs');
const {createNozeliPiSource}=await load('src/agents/managed/pi-source.mjs');
const {resolveBundledPiRuntime}=await load('src/agents/managed/pi-runtime.mjs');
const {runGit}=await load('src/agents/managed/git-runtime.mjs');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-recorded-bug-fixed-live-')),root=path.join(out,'project'),config=path.join(out,'private'),profile=path.join(config,'desktop');
await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'1.md'),'# 混沌系统演示\n原项目材料保留。\n');await fs.writeFile(path.join(root,'.gitignore'),'/.nozeli/\n');
const git=async(...args)=>String(await runGit(root,args)).trim();await git('init','-b','main');await git('config','user.name','Nozeli Runtime Recovery Fixture');await git('config','user.email','runtime-recovery@localhost');await git('add','--all');await git('commit','-m','Synthetic runtime recovery baseline');const head=await git('rev-parse','HEAD');
const scenario=recordedBugScenario(),provider=await serve(scenario.handler),host=new DesktopHost(profile),source=createNozeliPiSource({root:config});
let manager,controller,projectId;const result={ok:false,out,app,checks:[],scope:'Exact recorded Chinese input, cursor="" repeated three times and dispatch brief=""; repaired source through actual private Pi with no DEBUG workaround, no host injection, no state mutation or user prompt replay; deterministic loopback provider and real candidate publication'};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+120000;while(Date.now()<end){if(provider.errors.length)throw provider.errors[0];const value=await fn();if(value)return value;await pause(25);}throw Error('Timed out: '+label);}
try{
 await fs.mkdir(source.agentDir,{recursive:true});await fs.writeFile(path.join(source.agentDir,'models.json'),JSON.stringify({providers:{'runtime-debug-local':{baseUrl:provider.url,api:'openai-completions',apiKey:'local-nonsecret',models:[{id:'scripted',name:'Runtime Debug Synthetic',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:4096}]}}}),{mode:0o600});
 source.modelFor=async()=> 'runtime-debug-local/scripted';source.roleDefaultsFor=async()=>({selector:'runtime-debug-local/scripted',effort:'off'});
 const runtime=await resolveBundledPiRuntime({piHome:source.agentDir});manager=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},piSource:source,piRuntime:runtime,idleTimeoutMs:60000});await manager.processBudget.save(3);
 projectId=(await host.pick(root)).project.id;await manager.connect(projectId,{enable:true});controller=manager.controllers.get(projectId);
 const submitted=await controller.enqueue('orchestrator','intake',recordedBugTask);
 await until(()=>controller.store.state.works.some(w=>w.result?.objectId)&&!controller.running.size&&!controller.kicking,'normal Worker publication after repaired parameter handling');
 const state=controller.store.state,original=state.jobs.find(j=>j.id===submitted.jobId),works=state.works,events=state.jobs.filter(j=>j.type==='maintenance');
 assert.equal(state.jobs.filter(j=>j.type==='intake').length,1);assert.equal(works.length,1);const work=works[0];assert.equal(work.sourceJob,original.id);assert.equal(work.request,recordedBugTask);assert.equal(work.brief,recordedBugTask);assert.equal(original.routing.workId,work.id);assert.equal(original.status,'completed');assert.equal(original.maintenanceBugId,undefined);assert.equal(original.routing.hostContinuation,undefined);assert.equal(events.length,0);
 assert.equal(state.jobs.filter(j=>j.target===work.id&&j.type==='initial').length,1);assert.equal(scenario.intakeRequests,5);assert.equal(scenario.debugRequests,0);assert.equal(scenario.workerRequests,2);
 assert.deepEqual((await controller.maintenance.read()).bugs,[],'neither recorded parameter bug recurs in a clean project');
 assert.equal(await fs.readFile(path.join(work.execution.directory,'chaos-demo.html'),'utf8'),chaosDemoHtml);assert.equal(state.receipts.filter(r=>r.kind==='result'&&r.workId===work.id).length,1);assert.equal(await git('rev-parse','HEAD'),head);await assert.rejects(fs.stat(path.join(root,'chaos-demo.html')),{code:'ENOENT'});
 result.checks.push('same three empty cursors return valid first-page taskboard facts');result.checks.push('same empty brief directly creates one Work using the original request under the repaired optional-field contract');result.checks.push('one original intake/Worker writes and publishes the real HTML candidate; zero maintenance jobs or new bug records');result.checks.push('no DEBUG workaround, prompt replay, auto-acceptance or source/Git overwrite');
 result.projectId=projectId;result.originalJobId=original.id;result.work=structuredClone(work);result.jobs=structuredClone(state.jobs);result.ledger=await controller.maintenance.read();result.scenario={...scenario,handler:undefined};
 const before=provider.requests.length;await manager.stop();assert.equal(manager.processBudget.used,0);assert.equal(provider.requests.length,before);result.checks.push('private owners stop and process capacity is fully released');result.ok=true;
}catch(error){result.error=error.stack;result.jobs=controller?.store.state.jobs;result.providerErrors=provider.errors.map(e=>e.stack);process.exitCode=1;}
finally{await manager?.stop().catch(error=>{result.cleanupError=error.message;process.exitCode=1;});await provider.close();await host.storage.db.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:result.ok,out,checks:result.checks,error:result.error}));}
