// Manager-owned explicit cold recovery regression through the ordinary public
// ManagedProjects surface (no injected Controller adapter, no fixture connect
// options): an actual abrupt native host death from the shared business-host
// fixture (real registered supervisor helpers, real durable publication hold,
// real scripted local provider) stays fenced by the default production entry;
// status/startup never recover automatically; managed.recovery.prepare is
// read-only (zero business mutation, zero provider turns, no automatic
// prompt) and returns only the bounded public DTO; forged or stale challenges
// refuse without effects; one confirm activates exactly one successor
// generation with residents while drafts, the paused Work and the unknown
// original turn stay intact and unrepeated; duplicate/concurrent confirms
// never start a second chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {DesktopHost} from '../src/main/host.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {resolveBundledPiRuntime} from '../src/agents/managed/pi-runtime.mjs';
import {createNozeliPiSource} from '../src/agents/managed/pi-source.mjs';
import {ProviderSettings} from '../src/agents/managed/provider-settings.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {createExperimentalWindowsPersistence} from '../src/platform/windows/experimental-persistence.mjs';
import {connectExperimentalProcessSupervisor} from '../src/platform/windows/experimental-process-supervisor.mjs';
import {git,str,commitTree} from '../src/agents/managed/git-service.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:480000};
async function until(fn,diagnostic){const end=performance.now()+180000;for(;;){const r=await fn();if(r)return r;if(performance.now()>end)assert.fail('Managed cold recovery fixture timeout: '+diagnostic());await delay(10);}}

test('manager cold recovery: read-only prepare, forged challenges refuse, one confirm, never replays',native,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nz-cr-')),profile=path.join(root,'profile'),content=path.join(root,'project');await fs.mkdir(content);
 let manager=null,host=null,testFailed=false;
 const pins=new Map(),children=[];
 const provider=await serve((request,index)=>{
  if(index>3){assert.equal(index,4,'only one new explicit prompt may execute');assert(request.messages.some(row=>typeof row.content==='string'&&row.content==='CRASH_RECOVERY_NEW_INPUT'||Array.isArray(row.content)&&row.content.some(part=>part.text==='CRASH_RECOVERY_NEW_INPUT')));return {text:'新输入已处理；旧效果未重放。'};}
  if(index===1)return {id:'read',tool:'nozeli_document_read',args:{relPath:'正文.md'}};
  const tool=request.messages.filter(r=>r.role==='tool').at(-1),result=JSON.parse(typeof tool.content==='string'?tool.content:tool.content.map(r=>r.text??'').join(''));assert.equal(result.ok,true);
  if(index===2)return {id:'apply',tool:'nozeli_document_apply',args:{readHandle:result.value.readHandle,replacements:[{oldText:'baseline',newText:'cold receipt'}]}};
  assert.equal(index,3);return {id:'publish',tool:'nozeli_publish',args:{kind:'result',content:staticReport('管理器冷恢复合成候选'),files:['正文.md']}};
 });
 const capture=async(storage,projectId)=>{
  const database=path.join(await storage.localDirectory(projectId),'ui.sqlite');
  for(const row of await storage.db.request(database,'list',{collection:'managed_owner_launches'})){
   const endpoint=row.value.supervision;if(row.value.phase==='prepared'&&endpoint&&!pins.has(endpoint.supervisorPid))pins.set(endpoint.supervisorPid,connectExperimentalProcessSupervisor(endpoint));
  }
 };
 t.after(async()=>{
  let teardownOk=true;
  try{await Promise.race([manager?.stop?.(),new Promise((_,reject)=>setTimeout(()=>reject(Error('manager.stop timeout (fenced stop retained state)')),90000).unref?.())]);}
  catch(error){teardownOk=false;t.diagnostic('teardown bounded: '+error.message);}
  for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await child.closed;}
  for(const pin of pins.values()){try{await until(()=>pin.snapshot().jobEmptyObserved,()=>JSON.stringify(pin.snapshot()));pin.shutdown();}catch{t.diagnostic('crashed supervisor pin already quiescent');}pin.close();}
  await provider.close();
  try{await host?.storage.db.close();}catch{}
  if(teardownOk&&!testFailed)await fs.rm(root,{recursive:true,force:true});
  else t.diagnostic('root retained for inspection: '+root+(testFailed?' (test failed)':' (teardown bounded)'));
 });
const run=async()=>{
 // The private profile must come from the native anchored creator; the seeded
 // budget leaves headroom for both residents plus the retained crashed set.
 await ensureExperimentalPrivateDirectory(root,profile);
 await fs.writeFile(path.join(profile,'agent-resources.json'),JSON.stringify({schema:1,globalLimit:3}));
 await fs.writeFile(path.join(content,'正文.md'),'baseline');
 await fs.writeFile(path.join(content,'.gitignore'),'.nozeli/\nnode_modules/\n');
 await git(content,['init','--initial-branch=main']);await git(content,['config','core.autocrlf','false']);await git(content,['add','.']);
 const initial=await commitTree(content,await str(content,['write-tree']),[],'synthetic baseline',path.join(root,'seed'));await git(content,['update-ref','refs/heads/main',initial]);
 host=new DesktopHost(profile);
 const projectId=(await host.pick(content)).project.id;
 const nozeliRoot=path.join(root,'nozeli');await fs.mkdir(nozeliRoot);await ensureExperimentalPrivateDirectory(nozeliRoot,path.join(nozeliRoot,'pi'));
 const piSource=createNozeliPiSource({root:nozeliRoot});
 const providerSettings=new ProviderSettings({source:piSource});
 piSource.roleDefaultsFor=role=>providerSettings.roleDefaultsFor(role);
 piSource.modelFor=role=>providerSettings.modelFor(role);
 const resolved=await resolveBundledPiRuntime({packaged:process.env.NOZELI_TEST_PACKAGED_APP==='1',piHome:path.join(nozeliRoot,'pi'),...(process.env.NOZELI_TEST_PI_ROOT?{env:{...process.env,NOZELI_PI_INTEGRATION_ROOT:path.resolve(process.env.NOZELI_TEST_PI_ROOT)}}:{})});
 manager=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},piSource,piRuntime:{...resolved,args:resolved.args.filter(value=>value!==resolved.entry)},idleTimeoutMs:3600000});
 manager.onEvent(event=>{if(event.kind==='managed-error')t.diagnostic('managed-error: '+event.text);});
 await createExperimentalWindowsPersistence(nozeliRoot).writeAtomic('pi/models.json',JSON.stringify({providers:{'local-fixture':{baseUrl:provider.url,api:'openai-completions',apiKey:'synthetic-local-only',models:[{id:'scripted',name:'Scripted local fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}]}}}));
 await providerSettings.defaults();
 await providerSettings.writeRecord(providerSettings.file,JSON.stringify({schema:2,roles:Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{model:{mode:'explicit',selector:'local-fixture/scripted'},thinking:{mode:'explicit',level:'off'}}]))}));
 const status=()=>manager.invoke('managed.status',{projectId});

 // ── actual abrupt host death with a held durable publication ─────────────
 const input=path.join(root,'input.json'),ready=path.join(root,'ready.json');
 const fixture={root,profile,content,projectId,ready,provider:provider.url,productionAgentDir:path.join(nozeliRoot,'pi'),
  piRoot:process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi')};
 await fs.writeFile(input,JSON.stringify(fixture));
 const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/windows-cold-business-host.mjs',import.meta.url)),input],{env:{SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},windowsHide:true,stdio:['ignore','pipe','pipe']});
 let diagnostics='';child.stdout.on('data',bytes=>diagnostics+=bytes);child.stderr.on('data',bytes=>diagnostics+=bytes);child.closed=once(child,'close');children.push(child);
 const original=await until(async()=>{try{return JSON.parse(await fs.readFile(ready,'utf8'));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;assert.equal(child.exitCode,null,diagnostics);}},()=>diagnostics);
 await capture(host.storage,projectId);
 child.kill();await child.closed;
 for(const pin of pins.values())await until(()=>{const facts=pin.snapshot();return facts.hostExited&&facts.jobEmptyObserved&&facts.stdoutEOF&&facts.stderrEOF;},()=>JSON.stringify([...pins.values()].map(pin=>pin.snapshot())));
 const local=path.join(await host.storage.localDirectory(projectId),'ui.sqlite'),request=(op,args)=>host.storage.db.request(local,op,args);
 const crashedHost=await request('record',{collection:'managed_host_leases',id:'host'}),crashedOwners=await request('list',{collection:'managed_owner_launches'});
 const worksBefore=await host.storage.projectRequest(projectId,'list',{collection:'managed_works'}),jobsBefore=await host.storage.projectRequest(projectId,'list',{collection:'managed_jobs'});
 assert.equal(provider.requests.length,3);
 assert.equal(worksBefore.find(row=>row.id===original.workId).value.status,'running');

 // ── default connect/status/startup never recover automatically ───────────
 await assert.rejects(manager.invoke('managed.recovery.prepare',{projectId}),{code:'COLD_RECOVERY_UNAVAILABLE'});
 await assert.rejects(manager.invoke('managed.enable',{projectId}),error=>{assert.equal(error.code,'WIN32_IO_ERROR');assert.equal(error.win32Code,32);assert.equal(error.recoveryRequired,true);assert.equal(error.automaticReplay,false);return true;});
 assert.equal(manager.controllers.has(projectId),false);
 assert.equal(manager.coldRecovery.size,0);
 const fenced=await status();
 assert.equal(fenced.ready,false);assert.ok(Array.isArray(fenced.state.works));
 assert.equal(fenced.connectionError.code,'HOST_LEASE_RECOVERY_REQUIRED');
 assert.equal(fenced.coldRecovery,undefined);
 const resumed=await manager.resumeUnfinishedProjects();
 assert.equal(resumed.resumed.includes(projectId),false);
 assert.equal(manager.controllers.has(projectId),false);assert.equal(manager.coldRecovery.size,0);
 assert.equal(provider.requests.length,3);
 assert.deepEqual(await request('record',{collection:'managed_host_leases',id:'host'}),crashedHost);
 assert.deepEqual(await host.storage.projectRequest(projectId,'list',{collection:'managed_works'}),worksBefore);

 // ── prepare: read-only retained inspection, bounded public DTO ───────────
 let prepared=await manager.invoke('managed.recovery.prepare',{projectId});
 assert.deepEqual(Object.keys(prepared).sort(),['automaticReplay','available','hostLeaseId','hostRevision','token']);
 assert.equal(prepared.available,true);assert.equal(prepared.automaticReplay,false);
 assert.equal(prepared.hostLeaseId,crashedHost.value.leaseId);assert.equal(prepared.hostRevision,crashedHost.revision);
 assert.equal((await request('list',{collection:'managed_cold_checkpoints'})).length,0);
 assert.equal((await request('list',{collection:'managed_cold_retirements'})).length,0);
 assert.deepEqual(await request('record',{collection:'managed_host_leases',id:'host'}),crashedHost);
 assert.deepEqual(await request('list',{collection:'managed_owner_launches'}),crashedOwners);
 assert.deepEqual(await host.storage.projectRequest(projectId,'list',{collection:'managed_works'}),worksBefore);
 assert.deepEqual(await host.storage.projectRequest(projectId,'list',{collection:'managed_jobs'}),jobsBefore);
 assert.match(prepared.token,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
 assert.equal(provider.requests.length,3);
 const planned=await status();
 assert.deepEqual(planned.coldRecovery,prepared);
 assert.deepEqual(await manager.invoke('managed.recovery.prepare',{projectId}),prepared);
 // Prepare without an actual recorded failure refuses on an untouched project.
 const content2=path.join(root,'project-untouched');await fs.mkdir(content2);await fs.writeFile(path.join(content2,'plain.md'),'plain');
 await assert.rejects(manager.invoke('managed.recovery.prepare',{projectId:(await host.pick(content2)).project.id}),{code:'COLD_RECOVERY_UNAVAILABLE'});
 // ── stopProject drops the untouched prepared pin; Windows ownership refuse ──
 // The crashed host's real pi-node registrations survive in managed:providers,
 // and stopProject's no-controller branch must verify each before releasing:
 // win32 has no verified-process-ownership adapter, so the stop legitimately
 // refuses instead of claiming custody. The clean PREPARED pin is still
 // dropped (never retained across a stop) and every retained fact is intact.
 const firstToken=prepared.token;
 const stopOutcome=await manager.stopProject(projectId).then(()=>({refused:false}),error=>({refused:true,code:error.code}));
 assert.equal(stopOutcome.refused,true,'stopProject must refuse unverified Windows provider ownership, not report success');
 assert.ok(['PI_PROCESS_OWNERSHIP_UNSUPPORTED','PI_EXIT_UNCONFIRMED'].includes(stopOutcome.code),'unexpected stop refusal: '+stopOutcome.code);
 assert.equal(manager.coldRecovery.size,0);
 assert.equal(manager.controllers.has(projectId),false);
 assert.equal((await status()).coldRecovery,undefined);
 await assert.rejects(manager.invoke('managed.recovery.confirm',{projectId,token:firstToken,hostLeaseId:prepared.hostLeaseId,hostRevision:prepared.hostRevision}),{code:'COLD_RECOVERY_UNAVAILABLE'});
 assert.deepEqual(await request('record',{collection:'managed_host_leases',id:'host'}),crashedHost);
 assert.deepEqual(await request('list',{collection:'managed_owner_launches'}),crashedOwners);
 assert.deepEqual(await host.storage.projectRequest(projectId,'list',{collection:'managed_works'}),worksBefore);
 assert.deepEqual(await host.storage.projectRequest(projectId,'list',{collection:'managed_jobs'}),jobsBefore);
 assert.equal((await request('list',{collection:'managed_cold_checkpoints'})).length,0);
 assert.equal((await request('list',{collection:'managed_cold_retirements'})).length,0);
 assert.equal(provider.requests.length,3);
 assert.equal(await fs.readFile(path.join(content,'正文.md'),'utf8'),'baseline');
 // The fenced anchor still holds and re-anchors the explicit failure record;
 // a fresh preparation binds a new challenge to the same retained lease.
 await assert.rejects(manager.invoke('managed.enable',{projectId}),error=>{assert.equal(error.code,'WIN32_IO_ERROR');assert.equal(error.win32Code,32);assert.equal(error.recoveryRequired,true);assert.equal(error.automaticReplay,false);return true;});
 prepared=await manager.invoke('managed.recovery.prepare',{projectId});
 assert.equal(prepared.available,true);assert.equal(prepared.automaticReplay,false);
 assert.equal(prepared.hostLeaseId,crashedHost.value.leaseId);assert.equal(prepared.hostRevision,crashedHost.revision);
 assert.notEqual(prepared.token,firstToken);
 assert.match(prepared.token,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
 assert.deepEqual(Object.keys(prepared).sort(),['automaticReplay','available','hostLeaseId','hostRevision','token']);
 assert.equal(provider.requests.length,3);

 // ── forged and stale challenges refuse without any effect ────────────────
 const challenge={token:prepared.token,hostLeaseId:prepared.hostLeaseId,hostRevision:prepared.hostRevision};
 for(const forged of [
  {...challenge,hostRevision:challenge.hostRevision+1},
  {...challenge,hostLeaseId:'00000000-0000-0000-0000-000000000000'},
  {...challenge,token:'00000000-0000-0000-0000-000000000000'},
 ])await assert.rejects(manager.invoke('managed.recovery.confirm',{projectId,...forged}),{code:'COLD_RECOVERY_CHALLENGE_INVALID'});
 await assert.rejects(manager.invoke('managed.recovery.confirm',{projectId,...challenge,token:''}),{code:'INVALID_PAYLOAD'});
 assert.equal((await request('list',{collection:'managed_cold_checkpoints'})).length,0);
 assert.equal((await request('list',{collection:'managed_cold_retirements'})).length,0);
 assert.deepEqual(await request('record',{collection:'managed_host_leases',id:'host'}),crashedHost);
 assert.deepEqual((await status()).coldRecovery,prepared);
 assert.equal(provider.requests.length,3);

 // ── one confirm: concurrent duplicate + exact duplicate never re-chain ───
 const confirmFlight=manager.invoke('managed.recovery.confirm',{projectId,...challenge});
 const duplicateFlight=manager.invoke('managed.recovery.confirm',{projectId,...challenge});
 const outcomes=await Promise.allSettled([confirmFlight,duplicateFlight]);
 const fulfilled=outcomes.filter(row=>row.status==='fulfilled');
 assert.equal(fulfilled.length,1,JSON.stringify(outcomes.map(row=>({status:row.status,code:row.reason?.code,message:row.reason?.message}))));
 const rejected=outcomes.find(row=>row.status==='rejected');
 assert.ok(['COLD_RECOVERY_BUSY','COLD_RECOVERY_UNAVAILABLE'].includes(rejected.reason.code));
 const confirmed=fulfilled[0].value;
 assert.equal(confirmed.ready,true);assert.equal(confirmed.enabled,true);
 await assert.rejects(manager.invoke('managed.recovery.confirm',{projectId,...challenge}),{code:'COLD_RECOVERY_UNAVAILABLE'});
 assert.equal(manager.coldRecovery.size,0);

 // ── exactly one successor generation; residents; preserved originals ────
 const controller=manager.controllers.get(projectId);
 assert.ok(controller,'confirmed cold recovery owns the controller');
 assert.equal(controller.store.io.qualification.productionSelected,true);
 assert.equal(controller.store.io.qualification.scope,'default-production-windows-managed');
 assert.equal(controller.sessions.size,2);assert.equal(manager.processBudget.used,2);
 const activated=await request('record',{collection:'managed_host_leases',id:'host'});
 assert.equal(activated.value.phase,'active');
 assert.equal(activated.value.coldPredecessor.retirementId,prepared.hostLeaseId);
 assert.notEqual(activated.value.leaseId,crashedHost.value.leaseId);
 assert.equal((await request('list',{collection:'managed_cold_retirements'})).length,1);
 const workAfter=(await host.storage.projectRequest(projectId,'record',{collection:'managed_works',id:original.workId})).value;
 assert.equal(workAfter.status,'paused');assert.equal(workAfter.recoveryRequiresExplicitInput,true);assert.equal(workAfter.automaticReplay,false);
 assert.equal(controller.store.state.jobs.find(row=>row.id===original.jobId).status,'interrupted');
 const recovered=await status();
 assert.equal(recovered.ready,true);assert.equal(recovered.connectionError,null);assert.equal(recovered.coldRecovery,undefined);
 assert.equal(recovered.state.drafts.frontdesk,'原始未发送草稿');
 assert.equal(recovered.state.drafts.orchestrator,'保留草稿，不派工');
 assert.equal(recovered.state.works.find(row=>row.id===original.workId).status,'paused');
 // The original unknown turn never repeats: only the crashed host's three
 // scripted provider requests ever happened, and the worktree is untouched.
 assert.equal(provider.requests.length,3);
 assert.equal(provider.errors.length,0,provider.errors.map(error=>error.stack).join('\n'));
 assert.equal(await fs.readFile(path.join(content,'正文.md'),'utf8'),'baseline');
 const next=await manager.invoke('managed.send',{projectId,target:'frontdesk',text:'CRASH_RECOVERY_NEW_INPUT',requestKey:'crash-recovery-new-input'});
 await until(()=>{const job=controller.store.state.jobs.find(row=>row.id===next.jobId);if(job?.status==='failed')throw Error('New recovered input failed: '+job.errorCode);return job?.status==='completed';},()=>JSON.stringify(controller.store.state.jobs));
 assert.equal(provider.requests.length,4);assert.equal(provider.errors.length,0);
 assert.equal(controller.store.state.jobs.find(row=>row.id===original.jobId).status,'interrupted');
 assert.equal(controller.store.find(original.workId).recoveryRequiresExplicitInput,true);
 assert.equal(controller.store.state.drafts.frontdesk,'原始未发送草稿');
 await assert.rejects(manager.invoke('managed.recovery.prepare',{projectId}),{code:'COLD_RECOVERY_STATE_INVALID'});
};
try{await run();}catch(error){testFailed=true;throw error;}
});
