// Default production Windows managed entry regression: the ordinary public
// ManagedProjects surface (no injected Controller adapter, no fixture options)
// connects a registered desktop project through the native workspace I/O and
// the registered native owner-launch factory, runs one real Work with the
// actual Pi runtime against a scripted local provider (no model account, no
// network beyond loopback), preserves the immutable report candidate through
// human review/acceptance with real Git/history/checkpoint effects, stops and
// reconnects warm through the retained original host release receipt, and
// keeps a crashed (unknown) native host generation fenced with zero replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {DesktopHost} from '../src/main/host.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {resolveBundledPiRuntime} from '../src/agents/managed/pi-runtime.mjs';
import {createNozeliPiSource} from '../src/agents/managed/pi-source.mjs';
import {ProviderSettings} from '../src/agents/managed/provider-settings.mjs';
import {AgentProcessBudget} from '../src/agents/managed/agent-process-budget.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {createExperimentalWindowsPersistence} from '../src/platform/windows/experimental-persistence.mjs';
import {git,str,commitTree} from '../src/agents/managed/git-service.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:480000};
const WORKER_TEXT='Windows 生产默认 Worker 实际修改 😀';
const REVIEW_TEXT='用户审校确认 Windows 生产默认 Worker 实际修改 😀';

test('default production entry: native connect, ordinary Work, immutable review/Git/history, warm reopen, fenced unknown cold',native,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli 默认生产 Work 中文 ')),profile=path.join(root,'profile'),content=path.join(root,'project');
  await fs.mkdir(content,{recursive:true});
  const checkpointPending=[];
  // Sanitized stage evidence (structure only: roles, tool names, job/session
  // statuses — never model/auth/raw content), persisted before any teardown so
  // a failed stage names the actual routing instead of a bare timeout.
  const evidence={provider:[]};
  const parseToolPayload=message=>{
    let content=message?.content;
    if(Array.isArray(content))content=content.filter(row=>row?.type==='text').map(row=>row.text).join('\n');
    if(typeof content!=='string')return null;
    try{const value=JSON.parse(content);return typeof value==='string'?JSON.parse(value):value;}catch{return null;}
  };
  const lastToolResult=request=>{const message=request.messages.filter(row=>row.role==='tool').at(-1);return parseToolPayload(message);};
  let manager=null,host=null,testFailed=false;
  const dump=async label=>{
    try{
      const controller=projectId?manager?.controllers.get(projectId):null;
      await fs.writeFile(path.join(root,'stage-evidence.json'),JSON.stringify({
        label,provider:evidence.provider,providerRequests:provider.requests.length,
        providerErrors:provider.errors.map(error=>String(error?.message??error)),
        jobs:controller?.store?.state?.jobs?.map(job=>({id:job.id,target:job.target,type:job.type,status:job.status,manual:job.manual===true,error:job.error?String(job.error).slice(0,200):null})),
        works:controller?.store?.state?.works?.map(work=>({id:work.id,status:work.status,agentId:work.agentId??null})),
        sessions:controller?[...controller.sessions.entries()].map(([target,session])=>({target,phase:session.phase,busy:session.busy,model:session.model??null,stderrTail:String(session.diagnostics??'').slice(-300)})):[],
        starting:controller?[...controller.starting.keys()]:[],running:controller?[...controller.running.keys()]:[],
        connectionError:projectId?manager?.connectionErrors.get(projectId)?.error?.code??null:null,
        faults:await manager?.serviceFaults?.status?.({projectId}).catch(()=>null)??null,
        attention:projectId?(await manager?.attention?.read(projectId).catch(()=>null))?.todos?.map(todo=>({kind:todo.kind,status:todo.status,title:String(todo.title??'').slice(0,80)}))??null:null,
      },null,2));
    }catch(error){try{await fs.writeFile(path.join(root,'stage-evidence.failed'),String(error?.stack??error));}catch{}}
  };
  const stageUntil=async(fn,label,timeout=180000)=>{
    const end=performance.now()+timeout;
    for(;;){
      let value;try{value=await fn();}catch(error){testFailed=true;await dump(label);throw error;}
      if(value)return value;
      if(performance.now()>end){testFailed=true;await dump(label);assert.fail('managed production stage timeout: '+label);}
      await delay(25);
    }
  };
  const provider=await serve(async request=>{
    if(request.messages.some(row=>typeof row.content==='string'&&row.content==='WINDOWS_NORMAL_RESTART_NEW_INPUT'||Array.isArray(row.content)&&row.content.some(part=>part.text==='WINDOWS_NORMAL_RESTART_NEW_INPUT')))return {text:'WINDOWS_NORMAL_RESTART_NEW_REPLY'};
    const tool=lastToolResult(request);
    // Structural routing from each role's actual tool surface — never from
    // turn-count assumptions about the real SDK conversation shape.
    const advertised=new Set((request.tools??[]).map(row=>row.function?.name));
    const frontdeskTurn=advertised.has('nozeli_handoff');
    const orchestratorTurn=!frontdeskTurn&&advertised.has('nozeli_dispatch');
    evidence.provider.push({frontdeskTurn,orchestratorTurn,
      toolResultKeys:tool&&typeof tool==='object'?Object.keys(tool).sort():null,
      assistantToolNames:request.messages.filter(row=>row.role==='assistant').flatMap(row=>(row.tool_calls??[]).map(call=>call.function?.name??'unknown'))});
    if(tool?.ok===false)assert.fail('Scripted production tool refused: '+JSON.stringify(tool.error));
    if(tool?.ok===true&&typeof tool.value?.readHandle==='string'){assert.equal(tool.ok,true);return {id:'worker-apply',tool:'nozeli_document_apply',args:{readHandle:tool.value.readHandle,replacements:[{oldText:'baseline',newText:WORKER_TEXT}]}};}
    if(tool?.ok===true&&typeof tool.value?.eventId==='string'){assert.equal(tool.ok,true);return {id:'worker-publish',tool:'nozeli_publish',args:{kind:'result',content:staticReport('已通过宿主文档工具修改正文，候选等待审阅。'),files:['正文.md']}};}
    if(frontdeskTurn)return {id:'frontdesk-handoff',tool:'nozeli_handoff',args:{reason:'用户要求后台修改正文并形成审阅报告'}};
    if(orchestratorTurn)return {id:'orchestrator-dispatch',tool:'nozeli_dispatch',args:{name:'正文修改'}};
    return {id:'worker-read',tool:'nozeli_document_read',args:{relPath:'正文.md'}};
  });
  // The private profile must come from the native anchored creator (fixture
  // root convention), never a broad fs.mkdir the desktop registration would
  // then inherit or reject, before the budget record is seeded.
  await ensureExperimentalPrivateDirectory(root,profile);
  await fs.writeFile(path.join(profile,'agent-resources.json'),JSON.stringify({schema:1,globalLimit:2}));
  await fs.writeFile(path.join(content,'正文.md'),'baseline');
  await fs.writeFile(path.join(content,'draft.md'),'user disk draft');
  await fs.writeFile(path.join(content,'.gitignore'),'.nozeli/\n');
  await git(content,['init','--initial-branch=main']);await git(content,['config','core.autocrlf','false']);await git(content,['add','.']);
  const initial=await commitTree(content,await str(content,['write-tree']),[],'synthetic baseline',path.join(root,'seed'));await git(content,['update-ref','refs/heads/main',initial]);
  host=new DesktopHost(profile);
  // Actual default registration path: the seeded user repository is picked
  // and registered through the host itself — no injected binding or fixture
  // registration anywhere.
  let projectId;
  t.after(async()=>{
    await dump('teardown-start');
    let teardownOk=true;
    try{await Promise.race([manager?.stop?.(),new Promise((_,reject)=>setTimeout(()=>reject(Error('manager.stop timeout (fenced stop retained state)')),90000).unref?.())]);}
    catch(error){teardownOk=false;t.diagnostic('teardown bounded: '+error.message);}
    await provider.close();
    try{await host?.storage.db.close();}catch{}
    if(teardownOk&&!testFailed)await fs.rm(root,{recursive:true,force:true});
    else t.diagnostic('root retained for inspection: '+root+(testFailed?' (test failed)':' (teardown bounded)'));
  });
  projectId=(await host.pick(content)).project.id;
  const nozeliRoot=path.join(root,'nozeli');await fs.mkdir(nozeliRoot);await ensureExperimentalPrivateDirectory(nozeliRoot,path.join(nozeliRoot,'pi'));
  const piSource=createNozeliPiSource({root:nozeliRoot});
  const providerSettings=new ProviderSettings({source:piSource});
  piSource.roleDefaultsFor=role=>providerSettings.roleDefaultsFor(role);
  piSource.modelFor=role=>providerSettings.modelFor(role);
  const resolved=await resolveBundledPiRuntime({packaged:process.env.NOZELI_TEST_PACKAGED_APP==='1',piHome:path.join(nozeliRoot,'pi'),...(process.env.NOZELI_TEST_PI_ROOT?{env:{...process.env,NOZELI_PI_INTEGRATION_ROOT:path.resolve(process.env.NOZELI_TEST_PI_ROOT)}}:{})});
  // Production session runtime and actual persisted role-default source;
  // the scripted local provider needs no account or external discovery.
  // No explicit digests: the default entry binds owner-launch approval to the
  // resolver's own provenance (verified Pi manifest + dev-pinned executable),
  // exactly like an unpackaged source application run.
  const piRuntime={...resolved,args:resolved.args.filter(value=>value!==resolved.entry)};
  manager=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},piSource,piRuntime,idleTimeoutMs:3600000,beforeDocumentOperation:async({projectId,relPath})=>{await host.readFile(projectId,relPath);}});
  manager.onEvent(event=>{if(event.kind==='checkpoint-pending')checkpointPending.push(event.text);if(event.kind==='managed-error')t.diagnostic('managed-error: '+event.text);});
  const status=()=>manager.invoke('managed.status',{projectId});
  await createExperimentalWindowsPersistence(nozeliRoot).writeAtomic('pi/models.json',JSON.stringify({providers:{'local-fixture':{baseUrl:provider.url,api:'openai-completions',apiKey:'synthetic-local-only',models:[{id:'scripted',name:'Scripted local fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}]}}}));
  await providerSettings.defaults();
  await providerSettings.writeRecord(providerSettings.file,JSON.stringify({schema:2,roles:Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{model:{mode:'explicit',selector:'local-fixture/scripted'},thinking:{mode:'explicit',level:'off'}}]))}));

  // ── default connect: no flags, no fixture options ─────────────────────────
  const enabled=await stageUntil(()=>manager.invoke('managed.enable',{projectId}),'enable');
  assert.equal(enabled.ready,true);assert.equal(enabled.enabled,true);
  const controller=manager.controllers.get(projectId);
  assert.ok(controller,'connected controller');
  assert.equal(controller.store.hostLease.facts().scope,'explicit-live-host-custody');
  assert.equal(controller.store.io.qualification.productionSelected,true);
  assert.equal(controller.store.io.qualification.scope,'default-production-windows-managed');
  assert.equal(controller.store.io.qualification.coldRecoveryQualified,false);
  assert.equal(manager.processBudget.used,2);
  // Opening an already registered project is ordinary UI activity, not a
  // source-identity replacement. Exercise it while drafts are being saved;
  // the subsequent real Work must still run on the original live host.
  const reopenDraft='active-project reopen preserves the complete draft';
  await Promise.all([host.open(projectId),...Array.from(reopenDraft,(_,index)=>manager.saveLocalDraft(projectId,'frontdesk',reopenDraft.slice(0,index+1)))]);
  assert.equal((await host.pick(content)).project.id,projectId);
  await manager.saveLocalDraft(projectId,'frontdesk',reopenDraft);
  assert.equal((await host.storage.getRecovery(projectId,'managed:drafts')).frontdesk,reopenDraft);
  assert.equal((await status()).state.storageBlocked,false);
  // Real global-limit preference behavior through the default consumer: the
  // rejected invalid limit writes nothing; the successful save after stop goes
  // through the registered native profile record path.
  // Invalid global limit is a synchronous consumer contract (validateAgentLimit
  // throws before any write); the no-write oracle uses assert.throws.
  assert.throws(()=>manager.processBudget.save(1),error=>{assert.equal(error.code,'INVALID_AGENT_LIMIT');return true;});
  assert.equal(JSON.parse(await fs.readFile(path.join(profile,'agent-resources.json'),'utf8')).globalLimit,2,'rejected invalid limit wrote nothing');
  assert.equal(provider.requests.length,0);assert.equal(provider.errors.length,0);
  await manager.invoke('managed.draft',{projectId,target:'frontdesk',text:'重启必须保留的未发送草稿'});

  // ── ordinary Work through the public surface ──────────────────────────────
  await manager.invoke('managed.send',{projectId,target:'frontdesk',text:'把正文中的 baseline 改为 '+WORKER_TEXT+'，形成报告等待审阅。',requestKey:'dispatch-frontdesk-1'});
  const work=await stageUntil(async()=>(await status()).state.works[0],'host dispatch receipt');
  assert.ok(work.agentId,'activated work owns its private agent home');
  await stageUntil(async()=>{const state=(await status()).state;const failed=state.jobs.find(row=>row.target===work.id&&row.status==='failed');if(failed)throw Error('Worker failed: '+failed.error);return state.works.find(row=>row.id===work.id)?.status==='review';},'work reaches review');
  assert.equal(provider.errors.length,0,provider.errors.map(error=>error.stack).join('\n'));
  assert.equal(await fs.readFile(path.join(content,'正文.md'),'utf8'),'baseline');
  const completedProviderTurns=provider.requests.length;
  const reviewed=(await status()).state.works.find(row=>row.id===work.id);
  assert.equal(reviewed.status,'review');
  const toolDatabase=path.join(await host.storage.localDirectory(projectId),'ui.sqlite');
  const custody=await host.storage.db.request(toolDatabase,'list',{collection:'managed_owner_tools'});
  assert.deepEqual(custody.map(row=>row.value.tool).sort(),['nozeli_dispatch','nozeli_document_apply','nozeli_document_read','nozeli_handoff','nozeli_publish']);
  // Observed custody facts only: businessEffectQualified:false is the recorded
  // state of these receipts, never a release or effect-proof by itself.
  for(const row of custody){assert.equal(row.value.automaticReplay,false);assert.equal(row.value.businessEffectQualified,false);assert.equal(typeof row.value.launchId,'string');}

  // ── immutable candidate, human review, acceptance, real Git/history ───────
  const state=(await status()).state,receipt=state.receipts.find(row=>row.workId===work.id&&row.kind==='result');
  assert.ok(receipt?.objectId);assert.ok(receipt.changeSetId);
  const review=await manager.invoke('managed.review.read',{projectId,workId:work.id,objectId:receipt.objectId,relPath:'正文.md'});
  assert.ok(review.reviewVersion);assert.ok(review.files.find(row=>row.relPath==='正文.md').candidateText.includes(WORKER_TEXT));
  const candidate=path.join(controller.execution.directory(work.id),'正文.md');
  assert.equal(await fs.readFile(candidate,'utf8'),WORKER_TEXT);
  const saved=await manager.invoke('managed.review.save',{projectId,workId:work.id,objectId:receipt.objectId,relPath:'正文.md',text:REVIEW_TEXT,expectedDraftRevision:0});
  assert.notEqual(saved.reviewVersion,review.reviewVersion);
  assert.equal(await fs.readFile(candidate,'utf8'),WORKER_TEXT,'accepted candidate stays immutable after review edits');
  // A project editor refresh arrives after Git writes but before provenance.
  // Register outside the adoption async context, like a separate renderer IPC.
  let merged,observing;
  const mergeVisible=new Promise(resolve=>{merged=resolve;});
  const observerStarted=new Promise(resolve=>{observing=resolve;});
  const editorRefresh=mergeVisible.then(()=>{observing();return host.readFile(projectId,'正文.md');});
  const finishExecution=controller.execution.finish.bind(controller.execution);
  controller.execution.finish=async(...args)=>{const result=await finishExecution(...args);merged();await observerStarted;return result;};
  const accepted=await manager.invoke('managed.review.accept',{projectId,workId:work.id,objectId:receipt.objectId,reviewVersion:saved.reviewVersion,requestKey:'accept-production-1'});
  let closure=accepted.closure;
  if(closure?.git?.status!=='merged'){testFailed=true;await fs.writeFile(path.join(process.env.NOZELI_TEST_OUTPUT_ROOT??root,'acceptance-failure.json'),JSON.stringify({closure:controller.store.find(work.id).closure,maintenance:controller.store.find(work.id).maintenance},null,2));}
  assert.equal(closure?.git?.status,'merged','acceptance itself must reach the real Git merge');
  assert.equal((await editorRefresh).text,REVIEW_TEXT,'editor refresh sees the adopted bytes after history publication');
  if(closure.phase!=='complete'){
    // One named explicit user decision only — no automatic retry loop. Assert
    // the exact pending disposition and zero new provider turns first; an
    // outcome still unknown after this single action stays fenced and fails
    // with its facts rather than being retried away.
    const disposition=await manager.invoke('managed.disposition',{projectId,workId:work.id});
    assert.equal(disposition.retryClosure.allowed,true,JSON.stringify(disposition.retryClosure));
    assert.equal(provider.requests.length,completedProviderTurns,'closure finish adds no provider turn');
    await manager.invoke('managed.retry',{projectId,workId:work.id,binding:disposition.binding,requestKey:'explicit-closure-retry-1'});
    closure=(await status()).state.works.find(row=>row.id===work.id).closure;
  }
  assert.equal(closure.phase,'complete',JSON.stringify(closure));
  assert.equal(closure.git.status,'merged');assert.equal(closure.workerHome.scope,'complete-private-owner-home');
  assert.equal(await fs.readFile(path.join(content,'正文.md'),'utf8'),REVIEW_TEXT);
  assert.equal(await fs.readFile(path.join(content,'draft.md'),'utf8'),'user disk draft');
  assert.equal(await str(content,['rev-parse','main']),closure.git.commit);assert.notEqual(closure.git.commit,initial);
  // The accepted-version checkpoint is a real default-path caller: it runs the
  // scoped native project reads through the production entry adapter.
  const versions=await stageUntil(async()=>{const list=await manager.invoke('managed.versions.list',{projectId});return list.checkpoints.length?list:null;},'accepted checkpoint committed');
  assert.equal(versions.pending.length,0);assert.ok(versions.checkpoints[0].docs?.['正文.md']);
  assert.deepEqual(checkpointPending,[],'accepted-version checkpoint must not fail silently');
  assert.equal((await status()).state.drafts.frontdesk,'重启必须保留的未发送草稿');

  // ── normal stop and warm reopen through the retained release proof ───────
  const stopped=await manager.stopProject(projectId);
  assert.equal(stopped.confirmationComplete,true);assert.equal(stopped.projectId,projectId);
  assert.ok(manager.hostReleases.has(projectId),'original host release receipt retained');
  assert.equal(manager.processBudget.used,0);
  await manager.processBudget.save(3);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile,'agent-resources.json'),'utf8')),{schema:1,globalLimit:3});
  const reloadedBudget=new AgentProcessBudget({file:path.join(profile,'agent-resources.json')});
  await reloadedBudget.load();assert.equal(reloadedBudget.limit,3,'saved limit retained for the next process');
  const reopened=await stageUntil(()=>manager.invoke('managed.enable',{projectId}),'warm reconnect');
  assert.equal(reopened.ready,true);
  const reconnected=manager.controllers.get(projectId);
  assert.equal(reconnected.store.hostLease.facts().phase,'active');
  assert.equal(reconnected.store.io.qualification.productionSelected,true);
  assert.equal(manager.processBudget.used,2);
  assert.equal(provider.requests.length,completedProviderTurns,'warm reopen resumes residents without replaying any turn');
  const reopenedState=(await status()).state;
  assert.equal(reopenedState.works.find(row=>row.id===work.id).closure.phase,'complete');
  assert.equal(reopenedState.drafts.frontdesk,'重启必须保留的未发送草稿');
  assert.equal(await fs.readFile(path.join(content,'正文.md'),'utf8'),REVIEW_TEXT);
  await manager.stopProject(projectId);

  // ── unknown cold generation stays fenced with zero replay ────────────────
  const content2=path.join(root,'project-cold');await fs.mkdir(content2);await fs.writeFile(path.join(content2,'冷.md'),'cold');
  const project2=(await host.pick(content2)).project.id;
  const childInput=path.join(root,'cold-input.json'),ready=path.join(root,'cold-ready.json'),retiredProof=path.join(root,'retired-proof.json');
  await fs.writeFile(childInput,JSON.stringify({profile,nozeliRoot,retiredProjectId:projectId,retiredProof,crashProjectId:project2,ready}));
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/windows-desktop-managed-crash-host.mjs',import.meta.url)),childInput],{windowsHide:true});
  const childExit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  await stageUntil(async()=>{try{await fs.access(ready);return true;}catch{return false;}},'crashed host fixture ready');
  assert.deepEqual(await childExit,{code:87,signal:null});
  assert.deepEqual(JSON.parse(await fs.readFile(retiredProof,'utf8')),{normalRestart:true,phase:'active',newInputCompleted:true,automaticReplay:false});
  await assert.rejects(manager.invoke('managed.enable',{projectId:project2}),error=>{
    assert.equal(error.code,'HOST_LEASE_RECOVERY_REQUIRED');
    assert.equal(error.automaticReplay,false);
    assert.equal(error.coldRecoveryQualified,false);
    return true;
  });
  const cold=await manager.invoke('managed.status',{projectId:project2});
  assert.equal(cold.ready,false);assert.ok(Array.isArray(cold.state.works));
  assert.equal(manager.controllers.has(project2),false);
  assert.equal(provider.requests.length,completedProviderTurns+1,'only the explicit new normal-restart input may run; unknown cold generation never replays any turn');
  const attention=await manager.attention.read(project2);
  assert.ok(attention.todos.some(todo=>todo.status==='open'&&todo.attentionKey==='connection:connection'),'exact safe handoff state is surfaced to the user');
});
