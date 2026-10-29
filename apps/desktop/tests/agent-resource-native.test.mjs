import {pathToFileURL} from 'node:url';
const runtimeRoot=process.env.NOZELI_TEST_BUNDLE?path.join(process.env.NOZELI_TEST_BUNDLE,'Contents/Resources/app'):path.resolve(import.meta.dirname,'..');
const runtimeUrl=relative=>pathToFileURL(path.join(runtimeRoot,relative)).href;
const {resolveBundledOmpRuntime}=await import(runtimeUrl('src/agents/managed/omp-runtime.mjs'));
const bundledCommand=(await resolveBundledOmpRuntime({appRoot:runtimeRoot})).command;
// Actual private OMP processes and loopback HTTP; no remote model or credentials.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import http from 'node:http';
const {DesktopHost}=await import(runtimeUrl('src/main/host.mjs'));const {ManagedProjects}=await import(runtimeUrl('src/agents/managed-projects.mjs'));const {Controller}=await import(runtimeUrl('src/agents/managed/controller.mjs'));const {OmpTuiSession}=await import(runtimeUrl('src/agents/managed/omp-tui-session.mjs'));const {processStamp}=await import(runtimeUrl('src/agents/managed/process-ownership.mjs'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));async function wait(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const result=await fn();if(result)return result;await pause(50);}throw Error('Timeout '+label);}
async function fixture(t,limit){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-resource-native-')),seed=root+'/seed',profile=root+'/profile';await fs.mkdir(seed);const requests=[],owners=[];let hold=false,pending=[];
 const answer=res=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'local-native',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'Verified local native response.'},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({id:'local-native',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');};
 const server=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{requests.push(JSON.parse(body));if(hold)pending.push(res);else answer(res);});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await fs.writeFile(seed+'/config.yml','setupVersion: 2\nstartup:\n  checkUpdate: false\n  showSplash: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\nmodelRoles:\n  default: resource-local/scripted\ndefaultThinkingLevel: off\n');await fs.writeFile(seed+'/models.yml',`providers:\n  resource-local:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    auth: none\n    models:\n      - id: scripted\n        input: [text]\n`);
 const host=new DesktopHost(profile),manager=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map(),connectFlight:new Map()},ompCommand:bundledCommand,ompSystemSource:{private:true,root,agentDir:seed},openController:options=>Controller.open({...options,sessionFactory:(spec,target)=>new OmpTuiSession({...spec,onSpawn:async pid=>{const stamp=await processStamp(pid);assert(stamp);owners.push({pid,stamp,target});assert(manager.processBudget.used<=manager.processBudget.limit,'process is reserved before spawning');await spec.onSpawn?.(pid);}})})});
 t.after(async()=>{hold=false;for(const res of pending.splice(0))answer(res);try{await manager.stop();for(const owner of owners)assert.notEqual(await processStamp(owner.pid),owner.stamp,'owned process fully exited');}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}});
 await manager.saveResourceLimits({globalLimit:limit});const projects=[];for(const name of ['alpha','beta']){const dir=root+'/'+name;await fs.mkdir(dir);await fs.writeFile(dir+'/source.txt','KEEP_'+name);projects.push((await host.pick(dir)).project);}return {root,manager,projects,requests,owners,hold(){hold=true;},release(){hold=false;for(const res of pending.splice(0))answer(res);}};
}
async function send(c,key){const r=await c.send('frontdesk','仅回复确认，不使用工具。',{requestKey:key});await wait(()=>c.store.state.jobs.find(j=>j.id===r.jobId)?.status==='completed'&&!c.running.size,'native model job completion',60000);return r;}
test('project switching keeps idle resident processes while global capacity remains available',{timeout:180000},async t=>{
 const f=await fixture(t,6),{manager:m,projects:[a,b]}=f;await m.setActiveProject(a.id);await m.connect(a.id,{enable:true});const ca=m.controllers.get(a.id);await send(ca,'keep-alpha');const old=ca.sessions.get('frontdesk'),stamp=await processStamp(old.pid);await m.setActiveProject(b.id);await m.connect(b.id,{enable:true});assert.equal(await processStamp(old.pid),stamp,'switching with free slots must keep the idle resident alive');assert.equal(ca.sessions.get('frontdesk'),old);await m.setActiveProject(a.id);await m.connect(a.id);assert.equal(ca.sessions.get('frontdesk'),old);assert.equal((await m.resourceStatus()).globalUsed,4);assert.equal(f.owners.length,4,'switch back never respawns residents');assert.equal(f.requests.length,1,'switch never replays model input');t.diagnostic(JSON.stringify({root:f.root,scope:'real private OMP residents remain connected below global process limit'}));
});

test('capacity demand reclaims idle processes and resumes original nonempty threads without replay',{timeout:180000},async t=>{
 const f=await fixture(t,2),{manager:m,projects:[a,b]}=f;await m.setActiveProject(a.id);await m.connect(a.id,{enable:true});const ca=m.controllers.get(a.id);await send(ca,'native-alpha-first');await ca.setDraft('frontdesk','PERSIST_GUI_DRAFT');const thread=ca.store.state.residents.frontdesk.threadId,old=ca.sessions.get('frontdesk'),stamp=await processStamp(old.pid),jobs=ca.store.state.jobs.length;
 await m.setActiveProject(b.id);await m.connect(b.id,{enable:true});assert.notEqual(await processStamp(old.pid),stamp,'inactive idle native process exited');assert.equal((await m.resourceStatus(b.id)).globalUsed,2);const before=f.requests.length;
 await m.setActiveProject(a.id);assert.equal(ca.sessions.size,0,'activation does not wake reclaimed sessions');assert.equal(m.processBudget.used,2,'navigation alone retains other project owners even at capacity');assert.equal(f.requests.length,before);const ownersBeforeResume=f.owners.length;await m.connect(a.id);await wait(()=>m.controllers.get(a.id).sessions.get('frontdesk')?.phase==='ready'||m.controllers.get(a.id).sessions.get('frontdesk')?.phase==='idle','explicit resident resume');assert(f.owners.length>ownersBeforeResume,'explicit connect restores native owners');assert.equal(ca.store.state.residents.frontdesk.threadId,thread);assert.equal(ca.store.state.jobs.length,jobs);assert.equal(ca.store.state.drafts.frontdesk,'PERSIST_GUI_DRAFT');await pause(300);assert.equal(f.requests.length,before,'explicit restoration does not issue a model request');assert.equal(await fs.readFile(a.rootDisplay+'/source.txt','utf8'),'KEEP_alpha');
 const resident=ca.sessions.get('frontdesk'),orchestratorSession=ca.sessions.get('orchestrator'),view=resident.terminalAttachment(ca,'frontdesk');view.input('NATIVE_DRAFT_DO_NOT_LOSE');await wait(()=>ca.nativeDraftTargets.has('frontdesk'),'actual native draft observed');
 const draftStamp=await processStamp(resident.pid),idleStamp=await processStamp(orchestratorSession.pid);assert.equal(m.processBudget.used,2,'process budget is full before the demand');
 await m.setActiveProject(b.id);await m.reclaimInactive(b.id,{target:'frontdesk'}); // real cross-project capacity demand under a full budget
 assert.equal(await processStamp(resident.pid),draftStamp,'real capacity demand cannot reclaim the owner of unsent native input');
 assert(ca.nativeDraftTargets.has('frontdesk'),'unsent native input is still pending after the demand');
 assert.equal(await processStamp(orchestratorSession.pid),null,'the same real demand honors the cap by reclaiming the unprotected idle owner');
 assert.equal(m.processBudget.used,1,'exactly one process slot was freed by the demand');assert.equal(f.requests.length,before,'capacity demand never replays model input');
 view.input('\x01\x0b');await wait(async()=>{await resident.refreshNativeDraft();return !ca.nativeDraftTargets.has('frontdesk');},'native draft clear');
 const ownersBeforeRefill=f.owners.length;
 await m.connect(b.id,{enable:true}); // real other-project demand: both B resident slots cannot fit while A holds one
 assert.equal(await processStamp(resident.pid),null,'cleared draft no longer protects the idle owner under the real capacity demand');
 const cb=m.controllers.get(b.id);
 await wait(()=>cb.sessions.get('frontdesk')&&!cb.sessions.get('frontdesk').closed&&cb.sessions.get('orchestrator')&&!cb.sessions.get('orchestrator').closed,'both demanding residents are live after the refill');
 assert(f.owners.length>ownersBeforeRefill,'the demanding project spawned its own native owners');
 assert.equal(m.processBudget.used,2,'the demanding project exactly refills the freed budget');
 assert.equal(f.requests.length,before,'capacity refill never replays model input');
 assert.equal(ca.store.state.drafts.frontdesk,'PERSIST_GUI_DRAFT','GUI draft survives every reclaim');
 t.diagnostic(JSON.stringify({root:f.root,requests:f.requests.length,owners:f.owners.length,scope:'actual private OMP sessions; local scripted model only'}));
});
test('background completion retains its native owner until capacity is demanded',{timeout:240000},async t=>{
 const f=await fixture(t,6),{manager:m,projects:[a,b]}=f;await m.setActiveProject(a.id);await m.connect(a.id,{enable:true});const ca=m.controllers.get(a.id);f.hold();const r=await ca.send('frontdesk','等待本地验收响应，不使用工具。',{requestKey:'native-held-round'});await wait(()=>f.requests.length===1,'actual native HTTP request');const owner=ca.sessions.get('frontdesk'),stamp=await processStamp(owner.pid);
 await m.setActiveProject(b.id);await m.connect(b.id,{enable:true});assert.equal(await processStamp(owner.pid),stamp);assert.equal(ca.store.state.jobs.find(j=>j.id===r.jobId).status,'running');assert((await m.resourceStatus()).globalUsed<=4);
 const holdMs=Number(process.env.NOZELI_RESOURCE_HOLD_MS??0);assert(Number.isSafeInteger(holdMs)&&holdMs>=0&&holdMs<=180000);const heldAt=Date.now();while(Date.now()-heldAt<holdMs){await pause(Math.min(1000,holdMs-(Date.now()-heldAt)));assert.equal(await processStamp(owner.pid),stamp,'background in-flight owner stays alive');assert.equal(ca.store.state.jobs.find(j=>j.id===r.jobId).status,'running');assert((await m.resourceStatus()).globalUsed<=4);}t.diagnostic(JSON.stringify({heldMs:Date.now()-heldAt,scope:'real admitted native request deliberately held by local HTTP endpoint; not a model-compute benchmark'}));
 f.release();await wait(()=>ca.store.state.jobs.find(j=>j.id===r.jobId).status==='completed'&&!ca.running.size,'background completion',60000);await m.attentionPublish?.get(a.id);await pause(500);assert.equal(await processStamp(owner.pid),stamp,'background completion must not disconnect idle owner');assert.equal(ca.store.state.jobs.length,1);assert.equal(f.requests.length,1);t.diagnostic(JSON.stringify({root:f.root,scope:'real in-flight native HTTP and process preservation after completion'}));
});
test('background completion wakes another projects capacity-blocked accepted input',{timeout:180000},async t=>{
 const f=await fixture(t,2),{manager:m,projects:[a,b]}=f;
 await m.setActiveProject(b.id);await m.connect(b.id,{enable:true});const cb=m.controllers.get(b.id);
 await m.setActiveProject(a.id);await m.connect(a.id,{enable:true});const ca=m.controllers.get(a.id);
 f.hold();await ca.send('frontdesk','Only reply confirmed.',{requestKey:'capacity-held-front'});await ca.send('orchestrator','Only reply confirmed.',{requestKey:'capacity-held-orchestrator'});
 await wait(()=>f.requests.length===2,'both native owners busy');
 await m.setActiveProject(b.id);const job=await cb.send('frontdesk','Only reply confirmed.',{requestKey:'capacity-waiting-project'});
 await wait(()=>!cb.kicking&&!cb.running.size,'other project waits for capacity');assert.equal(cb.store.state.jobs.find(j=>j.id===job.jobId).status,'queued');
 f.release();await wait(()=>cb.store.state.jobs.find(j=>j.id===job.jobId).status==='completed','queued other-project input wakes on background completion',60000);
 assert.equal(f.requests.length,3,'accepted queued input executes exactly once');t.diagnostic(JSON.stringify({root:f.root,scope:'real native global-capacity wait and cross-project completion wakeup'}));
});

test('abrupt host death is recovered before new admission and restores the original thread without replay',{timeout:180000},async t=>{
 const f=await fixture(t,2),{manager:m,projects:[a]}=f;
 const phase=path.join(f.root,'crash-phase.mjs'),receipt=path.join(f.root,'crash-receipt.json');
 t.after(()=>fs.rm(phase,{force:true}));
 await fs.writeFile(phase,`import fs from 'node:fs/promises';import {DesktopHost} from ${JSON.stringify(runtimeUrl('src/main/host.mjs'))};import {ManagedProjects} from ${JSON.stringify(runtimeUrl('src/agents/managed-projects.mjs'))};
 const profile=${JSON.stringify(path.join(f.root,'profile'))},id=${JSON.stringify(a.id)};const host=new DesktopHost(profile),m=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map(),connectFlight:new Map()},ompCommand:${JSON.stringify(bundledCommand)},ompSystemSource:{private:true,root:${JSON.stringify(f.root)},agentDir:${JSON.stringify(path.join(f.root,'seed'))}}});
 await m.setActiveProject(id);await m.connect(id,{enable:true});const c=m.controllers.get(id),result=await c.send('frontdesk','仅回复确认，不使用工具。',{requestKey:'before-host-crash'});for(let n=0;n<1200;n++){if(c.store.state.jobs.find(j=>j.id===result.jobId)?.status==='completed'&&!c.running.size)break;await new Promise(r=>setTimeout(r,50));}if(c.store.state.jobs.find(j=>j.id===result.jobId)?.status!=='completed')throw Error('crash prerequisite did not complete');await c.setDraft('frontdesk','KEEP_AFTER_HOST_CRASH');await fs.writeFile(${JSON.stringify(receipt)},JSON.stringify({thread:c.store.state.residents.frontdesk.threadId,jobs:c.store.state.jobs.length,owners:[...c.sessions.values()].map(s=>({pid:s.pid}))}));process.kill(process.pid,'SIGKILL');`);
 const {spawn}=await import('node:child_process');const child=spawn(process.execPath,[phase],{env:process.env,stdio:['ignore','pipe','pipe']});let diagnostic='';child.stderr.on('data',chunk=>diagnostic+=chunk);const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});const exit=await exited;assert.equal(exit.signal,'SIGKILL',diagnostic);
 const prior=JSON.parse(await fs.readFile(receipt));assert.equal(f.requests.length,1);await m.initializeResources();assert.equal(m.processBudget.used,0,'confirmed orphan exits are inventoried before new admission');
 await m.setActiveProject(a.id);await m.connect(a.id,{enable:true});const c=m.controllers.get(a.id);assert.equal(c.store.state.residents.frontdesk.threadId,prior.thread);assert.equal(c.store.state.jobs.length,prior.jobs);assert.equal(c.store.state.jobs[0].status,'completed');assert.equal(c.store.state.drafts.frontdesk,'KEEP_AFTER_HOST_CRASH');assert.equal(f.requests.length,1,'cold recovery does not replay the completed turn');assert.equal(m.processBudget.used,2);t.diagnostic(JSON.stringify({root:f.root,scope:'actual SIGKILL of owning host, cold inventory, original thread and persisted draft, no HTTP replay'}));
});

for(const loss of ['root','metadata'])test('real native in-flight '+loss+' loss stops owned processes without request replay',{timeout:120000},async t=>{
 const f=await fixture(t,2),{manager:m,projects:[a]}=f;
 const projectRoot=(await m.host.requireRegisteredProject(a.id)).root;
 await m.setActiveProject(a.id);await m.connect(a.id,{enable:true});
 const c=m.controllers.get(a.id);await c.setDraft('frontdesk','KEEP_UNSENT_NATIVE_LOSS');
 f.hold();const sent=await c.send('frontdesk','等待本地验收响应，不使用工具。',{requestKey:'source-loss-'+loss});
 await wait(()=>f.requests.length===1,'real native HTTP admission');
 const owners=[...c.sessions.values()].map(session=>({pid:session.pid}));
 const source=loss==='root'?projectRoot:path.join(projectRoot,'.nozeli'),moved=source+'-offline';
 await fs.rename(source,moved);
 await assert.rejects(m.host.storage.requireOnline(a.id),{code:loss==='root'?'PROJECT_ROOT_MISSING':'PROJECT_METADATA_MISSING'});
 assert.equal(c.stopping,true);
 await assert.rejects(c.onTool('frontdesk',{tool:'nozeli_document_create',callId:'late-source-loss',arguments:{relPath:'late.txt',text:'must not write'}}));
 await wait(()=>!m.controllers.has(a.id),'managed stop completion',30000);
 for(const owner of owners)assert.equal(await processStamp(owner.pid),null,'actual owned CLI process exited');
 assert.equal(await fs.readFile(path.join(loss==='root'?moved:projectRoot,'source.txt'),'utf8'),'KEEP_alpha');
 assert.equal(await fs.stat(source).then(()=>true,()=>false),false,'missing source is never recreated');
 assert.equal(f.requests.length,1,'in-flight request was not replayed');
 assert.equal(c.store.state.jobs.filter(job=>job.id===sent.jobId).length,1);
 assert.equal((await m.host.storage.getRecovery(a.id,'managed:drafts')).frontdesk,'KEEP_UNSENT_NATIVE_LOSS');
 await fs.rename(moved,source);await m.host.storage.retry(a.id);await pause(250);
 assert.equal(f.requests.length,1,'source recovery does not replay accepted input');
 assert.equal(m.controllers.has(a.id),false,'retry does not restart native sessions');
 t.diagnostic(JSON.stringify({root:f.root,loss,requests:f.requests.length,owners:owners.length,scope:'actual private OMP CLI/native processes and held loopback model response; no remote provider, inference or user data'}));
});

test('real Worker keeps its process and thread across project switch; explicit stop then connect continues the original thread under a new owner',{timeout:240000},async t=>{
 const f=await fixture(t,6),{manager:m,projects:[a,b]}=f;
 await m.setActiveProject(a.id);await m.connect(a.id,{enable:true});const ca=m.controllers.get(a.id);
 const work=await ca.store.submit('真实 Worker 生命周期：切换保持，显式停用后续接','生命周期验证');
 if(ca.store.find(work.id).status==='queued')await ca.store.activate(work.id,{initialize:w=>{w.binding=structuredClone(ca.store.state.bindings.worker);}});
 await ca.session(work.id); // real native Worker process, no model round yet
 const first=await ca.send(work.id,'仅回复确认，不使用工具。',{requestKey:'worker-history-first'});
 await wait(()=>ca.store.state.jobs.find(j=>j.id===first.jobId)?.status==='completed'&&!ca.running.size,'worker first non-empty turn completes',60000);
 const worker=ca.sessions.get(work.id);assert(worker?.pid,'real worker process must exist');
 const stamp=await processStamp(worker.pid),thread=ca.store.find(work.id).threadId,jobs=ca.store.state.jobs.length,requests=f.requests.length;
 assert(thread,'non-empty worker turn binds durable thread history');
 assert.equal((await m.resourceStatus()).globalUsed,3,'residents plus worker below the global capacity');
 await m.setActiveProject(b.id);await m.connect(b.id,{enable:true});
 assert.equal(await processStamp(worker.pid),stamp,'switching projects below capacity keeps the real Worker process');
 assert.equal(ca.sessions.get(work.id),worker,'worker session object is retained across the switch');
 assert.equal(ca.store.find(work.id).threadId,thread,'worker thread identity is retained across the switch');
 assert.equal(f.requests.length,requests,'switching never replays worker input');
 assert.equal((await m.resourceStatus()).globalUsed,5,'both projects residents plus worker stay below capacity');
 await m.stopProject(a.id); // explicit project stop, not a crash
 assert.equal(await processStamp(worker.pid),null,'explicit stop exits the owned worker process');
 await m.setActiveProject(a.id);await m.connect(a.id,{enable:true});
 const ca2=m.controllers.get(a.id);assert.notEqual(ca2,ca,'reconnect builds a fresh controller');
 const kept=ca2.store.find(work.id);assert.equal(kept.threadId,thread,'work keeps the original worker thread after explicit stop');
 assert(['paused','running','review'].includes(kept.status),'work remains continuable, never auto-ended');
 assert.equal(ca2.store.state.jobs.length,jobs,'completed jobs are retained without replay');assert.equal(f.requests.length,requests,'reconnect does not replay completed input');
 const second=await ca2.send(work.id,'继续同一工作：仅回复确认，不使用工具。',{requestKey:'worker-continue-after-stop'});
 await wait(()=>ca2.store.state.jobs.find(j=>j.id===second.jobId)?.status==='completed'&&!ca2.running.size,'worker continuation completes on the resumed thread',60000);
 const resumed=ca2.sessions.get(work.id);assert(resumed?.pid&&resumed.pid!==worker.pid,'continuation runs under a new owner process after the intentional stop');
 assert.equal(resumed.threadId,thread,'continuation resumes the original worker thread');
 assert.equal(ca2.store.find(work.id).threadId,thread,'thread identity survives the stop-and-continue cycle');
 assert.equal(f.requests.length,requests+1,'exactly one new model round serves the continuation');
 t.diagnostic(JSON.stringify({root:f.root,workId:work.id,thread,owners:f.owners.length,requests:f.requests.length,scope:'actual private OMP Worker process; local scripted model only; app-restart worker coverage lives in tests/desktop-project-switch-residents-live.mjs'}));
});

test('live private OMP supports cold ownership recovery after Bun consumes auxiliary strings',{skip:process.platform!=='darwin',timeout:30000},async t=>{
 const {resolveBundledOmpRuntime}=await import(runtimeUrl('src/agents/managed/omp-runtime.mjs'));
 const {recoverOmpProvider}=await import(runtimeUrl('src/agents/managed/omp-process-ownership.mjs'));
 const {processInfo}=await import(runtimeUrl('src/platform/process-query.mjs'));const {once}=await import('node:events');const {spawn}=await import('node:child_process');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-omp-cold-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const home=path.join(root,'agents/owned');await fs.mkdir(home,{recursive:true});
 const runtime=await resolveBundledOmpRuntime({appRoot:runtimeRoot});
 const child=spawn(runtime.command,['--mode','rpc','--session-dir',path.join(home,'sessions')],{detached:true,env:{HOME:home,NOZELI_AGENT_DIR:home,PI_CODING_AGENT_DIR:home},stdio:['pipe','ignore','ignore']}),exited=once(child,'exit');
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});await once(child,'spawn');await new Promise(r=>setTimeout(r,1000));
 const info=await processInfo(child.pid,{ownership:true});assert(info);assert.equal(info.environmentScope,'ownership-only');assert.equal(info.environ,undefined);
 assert.deepEqual(new Set(info.ownershipEnviron),new Set(['NOZELI_AGENT_DIR='+home,'PI_CODING_AGENT_DIR='+home]));assert(info.argv.includes('--session-dir'));
 const result=await recoverOmpProvider({pid:child.pid,stamp:info.stamp,home,kind:'omp-rpc'},root);
 assert.equal(result.verified,true);await exited;assert.equal(await processInfo(child.pid),null);
});
