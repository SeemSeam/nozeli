// Actual Pi SDK + shared PiSession.start. Explicit local launch qualification,
// no personal profile/credentials, paid model, host-lock or cold-release claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {readEvidenceFrames} from '../../../integrations/pi/src/read-evidence-journal.mjs';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {roleSkillCatalog} from '../src/agents/managed/runtime.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {inspectExperimentalColdHostSources} from '../src/platform/windows/experimental-host-sources.mjs';
import {inspectExperimentalColdHostOutput} from '../src/platform/windows/experimental-cold-output.mjs';
import {openWindowsManagedColdInspection,commitWindowsManagedColdCheckpoint} from '../src/platform/windows/managed-cold-checkpoint.mjs';
import {inspectExperimentalColdHostJournal} from '../src/platform/windows/experimental-cold-journal.mjs';
import {createOwnerLaunchRegistry} from '../src/main/owner-launch-registry.mjs';
import {createExperimentalPiOwnerLaunch} from '../src/platform/windows/experimental-pi-owner-launch.mjs';
import {createExperimentalWindowsPersistence} from '../src/platform/windows/experimental-persistence.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {createExperimentalWindowsWorkspaceIO} from '../src/platform/windows/experimental-workspace-io.mjs';
import {SessionIndex} from '../src/agents/managed/session-index.mjs';
import {AgentProcessBudget} from '../src/agents/managed/agent-process-budget.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {openExperimentalPrivateTree} from '../src/platform/windows/experimental-private-tree.mjs';
import {acquireExperimentalHostLease,readExperimentalHostRetiredOwner} from '../src/platform/windows/experimental-host-lease.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {openExperimentalProcessIdentity} from '../src/platform/windows/experimental-process-identity.mjs';
import {connectExperimentalProcessSupervisor} from '../src/platform/windows/experimental-process-supervisor.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:90000};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const runtimeRoot=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');
const commandSha256=sha(await fs.readFile(process.execPath));
async function fixture(t,{handler=()=>({text:'本地 Windows Pi 回复。'}),nativeTools='none',target='frontdesk',runtimeOverrides={},initialize=true,ownerWrapper=null,hostCustody=false,supervise=false,desktop=false,deepEnvironment=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli Pi 中文 ')),cwd=path.join(root,'project');let home=path.join(root,...(desktop?['profile','owners']:['owners']),target);await fs.mkdir(cwd);
  if(deepEnvironment){
    // Pad the owner home with Unicode + astral characters until
    // <home>/environment crosses libuv's 256 UTF-16 homedir buffer units:
    // the exact input that crashed unpatched SDK module loading.
    const need=258-path.join(home,'environment').length;
    assert.ok(need>0&&need<250,'deep home padding stays a single safe component');
    home=path.join(home,'深𝕏'.repeat(Math.ceil(need/3)+1).slice(0,need));
  }
  const agentDir=path.join(home,'config');
  const storage=new ProjectStorage(path.join(root,'profile'),desktop?{windowsDesktopProjects:true}:{experimentalWindowsRoot:root,experimentalWindowsInitialization:true}),projectId=(await storage.register(cwd)).id;
  const hostLease=hostCustody?await acquireExperimentalHostLease({storage,projectId}):undefined;
  const registry=createOwnerLaunchRegistry(storage,projectId,{hostLease}),provider=await serve(handler),sessions=[],services=[],finalizers=[];
  const entry=path.join(runtimeRoot,'src/owner.mjs'),manifest=JSON.parse(await fs.readFile(path.join(runtimeRoot,'runtime-manifest.json'),'utf8'));
  assert.equal(sha(await fs.readFile(entry)),manifest.files['src/owner.mjs']);
  const runtime={command:process.execPath,entry,commandSha256,entrySha256:manifest.files['src/owner.mjs'],agentDir,nativeTools,...runtimeOverrides};
  if(ownerWrapper){runtime.entry=path.join(root,'synthetic-owner-wrapper.mjs');await fs.writeFile(runtime.entry,ownerWrapper({root,entry}));runtime.entrySha256=sha(await fs.readFile(runtime.entry));}
  const privateRoot=desktop?path.join(root,'profile'):root;
  const service=createExperimentalPiOwnerLaunch({root:privateRoot,home,agentDir,runtime,registry,target,isCurrent:()=>true,supervise});services.push(service);
  const persistence=createExperimentalWindowsPersistence(privateRoot);
  t.after(async()=>{
    const failures=[];
    for(const finalize of finalizers)try{await finalize();}catch(error){failures.push(error);}
    for(const session of sessions)if(session.child)try{if(!session.child.lease.snapshot().jobEmptyObserved)session.child.terminate();await session.child.waitForJobEmpty();await session.exitPromise;session.child.close();await session.controllerExitCleanup?.catch(()=>{});}catch(error){if(error.code!=='PROCESS_JOB_CLOSED')failures.push(error);}
    for(const service of services)try{service.close();}catch(error){failures.push(error);}
    hostLease?.abandon();await provider.close();await storage.db.close();
    if(failures.length)throw new AggregateError(failures,'Keep Pi fixture on unconfirmed local cleanup');
    await fs.rm(root,{recursive:true,force:true});
  });
  const configure=async()=>{await ensureExperimentalPrivateDirectory(privateRoot,agentDir);await persistence.writeAtomic(path.relative(privateRoot,path.join(agentDir,'models.json')).split(path.sep).join('/'),JSON.stringify({providers:{'local-fixture':{baseUrl:provider.url,api:'openai-completions',apiKey:'synthetic-local-only',models:[{id:'scripted',name:'Scripted local fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}]}}}));};
  if(initialize){await service.initialize();await configure();}
  const session=(extra={})=>{const value=new PiSession({role:target,home,cwd,registeredOwnerLaunch:service,piRuntime:runtime,model:'local-fixture/scripted',tools:[],...extra});sessions.push(value);return value;};
  return {root,privateRoot,cwd,home,agentDir,storage,projectId,registry,provider,runtime,service,persistence,session,sessions,services,hostLease,finalizers,configure};
}

test('actual Pi retirement under native host custody drains its claim before host release; durable normal restart reacquires receipt-less without replay',native,async t=>{
  const f=await fixture(t,{hostCustody:true,supervise:true}),session=f.session(),budget=new AgentProcessBudget({limit:2}),slot=budget.reserve(f.projectId,'frontdesk');budget.bind(slot,session);
  await session.start();assert.equal(f.hostLease.facts().pendingLaunches,1);
  const answer=await session.prompt('仅执行一次的宿主租约输入',{job:{id:randomUUID(),target:'frontdesk',type:'front'}});
  assert.equal(answer.completion,'provider-completed');assert.equal(f.provider.requests.length,1);
  await assert.rejects(f.hostLease.release(),{code:'HOST_LEASE_BUSY'});
  await session.stop();assert.equal(budget.used,0);assert.equal(f.hostLease.facts().pendingLaunches,0);
  const originalLeaseId=f.hostLease.facts().leaseId;
  assert.equal((await f.registry.read('frontdesk')).value.hostLeaseId,originalLeaseId);
  const receipt=await f.hostLease.release();assert.equal(receipt.record.phase,'retired');
  // A fresh process holds no in-memory receipt: only the durable terminal
  // normal-release publication of this exact retired generation authorizes one
  // successor activation, which still retains the retired owner facts and
  // never replays the accepted input.
  const restarted=await acquireExperimentalHostLease({storage:f.storage,projectId:f.projectId}),facts=restarted.facts();
  assert.equal(facts.phase,'active');assert.notEqual(facts.leaseId,originalLeaseId);assert.equal(facts.coldRecoveryQualified,false);
  const retained=await readExperimentalHostRetiredOwner(restarted,{storage:f.storage,projectId:f.projectId,target:'frontdesk'});
  assert.equal(retained.record.phase,'retired');assert.equal(retained.record.hostLeaseId,originalLeaseId);
  assert.equal((await restarted.release()).record.phase,'retired');
  assert.equal(f.provider.requests.length,1);assert.equal(f.provider.errors.length,0);
});

for(const mode of ['normal','forced','abrupt-desktop','abrupt-tail','abrupt-no-prompt-response','abrupt-snapshot-digest','abrupt-host-tool-pending','abrupt-host-tool-returned','abrupt-host-tool-result-unknown','stopped-normal','stopped-forced','stopped-truncated','stopped-duplicate','stopped-launch-mismatch','stopped-session-mismatch','stopped-barrier-error','stopped-request-mismatch','stopped-desktop','stopped-no-prompt-response','stopped-delivery-mismatch','stopped-host-tool'])test(`actual ${mode} host death preserves original Pi output/journal bindings and refuses replay of the accepted input`,native,async t=>{
  const stopped=mode.startsWith('stopped-'),forced=mode!=='normal'&&mode!=='stopped-normal';
  const mutation=['abrupt-no-prompt-response','abrupt-snapshot-digest'].includes(mode)?mode:stopped&&!['stopped-normal','stopped-forced','stopped-desktop','stopped-host-tool'].includes(mode)?mode:null;
  const f=await fixture(t,{initialize:false,desktop:['stopped-desktop','abrupt-desktop'].includes(mode),...(['stopped-host-tool','abrupt-host-tool-pending','abrupt-host-tool-returned','abrupt-host-tool-result-unknown'].includes(mode)?{nativeTools:[],handler:(request,index)=>index===1?{id:'host-tool',tool:'synthetic_effect',args:{text:'one'}}:{text:'原工具已返回。'}}:{}),...(mutation?{ownerWrapper:({entry})=>`import {randomUUID} from 'node:crypto';
    const write=process.stdout.write.bind(process.stdout);process.stdout.write=function(bytes,...args){
      let frame;try{frame=JSON.parse(bytes.toString());}catch{return write(bytes,...args);}
      const mode=${JSON.stringify(mutation)};
      if(['stopped-no-prompt-response','abrupt-no-prompt-response'].includes(mode)&&frame.method==='prompt')return true;
      if(mode==='abrupt-snapshot-digest'&&frame.method==='prompt'){frame.result.journalSnapshot.sha256File='0'.repeat(64);return write(JSON.stringify(frame)+'\\n',...args);}
      if(mode==='stopped-delivery-mismatch'&&frame.method==='prompt'){frame.result.delivery.text.sha256='0'.repeat(64);return write(JSON.stringify(frame)+'\\n',...args);}
      if(frame.method!=='stop')return write(bytes,...args);
      if(mode==='stopped-truncated')return write(JSON.stringify(frame),...args);
      if(mode==='stopped-duplicate')return write(JSON.stringify(frame)+'\\n'+JSON.stringify(frame)+'\\n',...args);
      if(mode==='stopped-launch-mismatch')frame.ownerLaunch.generation=randomUUID();
      if(mode==='stopped-session-mismatch')frame.result.sessionId=randomUUID();
      if(mode==='stopped-barrier-error')frame.result.finalJournal.persistence.file='unconfirmed';
      if(mode==='stopped-request-mismatch')frame.id=randomUUID();
      return write(JSON.stringify(frame)+'\\n',...args);
    };await import(${JSON.stringify(pathToFileURL(entry).href)});`}:{})}),script=path.join(f.root,'synthetic-host.mjs'),ready=path.join(f.root,'host-ready.json'),exit=path.join(f.root,'host-exit');
  await f.configure();
  const module=relative=>new URL(relative,import.meta.url).href;
  await f.storage.putRecovery(f.projectId,'managed:drafts',{frontdesk:'宿主重启仍未发送'});
  await fs.writeFile(script,`import fs from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
    import {ProjectStorage} from ${JSON.stringify(module('../src/main/project-storage.mjs'))};
    import {createOwnerLaunchRegistry} from ${JSON.stringify(module('../src/main/owner-launch-registry.mjs'))};
    import {acquireExperimentalHostLease} from ${JSON.stringify(module('../src/platform/windows/experimental-host-lease.mjs'))};
    import {createExperimentalPiOwnerLaunch} from ${JSON.stringify(module('../src/platform/windows/experimental-pi-owner-launch.mjs'))};
    import {PiSession} from ${JSON.stringify(module('../src/agents/managed/pi-session.mjs'))};
    const i=JSON.parse(process.argv[2]),storage=new ProjectStorage(i.profile,i.desktop?{windowsDesktopProjects:true}:{experimentalWindowsRoot:i.root,experimentalWindowsInitialization:true});
    const hostLease=await acquireExperimentalHostLease({storage,projectId:i.projectId}),registry=createOwnerLaunchRegistry(storage,i.projectId,{hostLease});
    const service=createExperimentalPiOwnerLaunch({root:i.privateRoot,home:i.home,agentDir:i.agentDir,runtime:i.runtime,registry,target:'frontdesk',isCurrent:()=>true,supervise:true});
    const session=new PiSession({role:'frontdesk',home:i.home,cwd:i.cwd,registeredOwnerLaunch:service,piRuntime:i.runtime,model:'local-fixture/scripted',tools:i.hostTool?[{name:'synthetic_effect',description:'Synthetic local fixture effect',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}]:[],onTool:async call=>{await fs.appendFile(i.effect,call.arguments.text);if(i.pendingTool)await new Promise(()=>{});return {text:'synthetic committed reply',continueTurn:true};}});
    const write=session.write.bind(session);session.write=frame=>{if(i.holdReply&&!frame.method)return;return write(frame);};
    if(i.resultUnknown){const request=storage.db.request.bind(storage.db);storage.db.request=async(file,op,args)=>{const result=await request(file,op,args);if(op==='put'&&args.collection==='managed_owner_tools'&&args.value.phase==='handler-returned')throw Object.assign(Error('Controlled lost handler-result SQLite reply'),{code:'STORAGE_RESULT_UNKNOWN'});return result;};}
    await session.start();
    if(i.pendingTool||i.holdReply||i.resultUnknown){
      session.prompt('宿主终止前只接受一次',{job:{id:i.jobId,target:'frontdesk',type:'front'}}).catch(()=>{});
      const deadline=performance.now()+15000;for(;;){try{await fs.stat(i.effect);if(i.holdReply||i.resultUnknown){const rows=await storage.db.request((await storage.localDirectory(i.projectId))+'/ui.sqlite','list',{collection:'managed_owner_tools'});if(!rows.some(row=>row.value.phase==='handler-returned')||i.resultUnknown&&!session.transportError){await delay(5);continue;}}break;}catch(error){if(error.code!=='ENOENT')throw error;}if(performance.now()>deadline)throw Error('Pending tool never entered');await delay(5);}
    }else if(['stopped-no-prompt-response','abrupt-no-prompt-response'].includes(i.mutation)){
      const result=session.prompt('宿主终止前只接受一次',{job:{id:i.jobId,target:'frontdesk',type:'front'},timeout:100});result.catch(()=>{});
      const deadline=performance.now()+15000;while(!session.lastDelivery||session.lastDelivery.phase!=='native-record-confirmed'){if(performance.now()>deadline)throw Error('Missing-response fixture has no persisted delivery');await delay(5);}
      if(i.stopped)await session.request('flush');else await delay(1000);
    }else await session.prompt('宿主终止前只接受一次',{job:{id:i.jobId,target:'frontdesk',type:'front'}});
    if(i.stopped){const stop=session.request('stop',{},15000);stop.catch(()=>{});await session.exitPromise;await session.nativeDrain;if(!i.mutation)await stop;}
    await fs.writeFile(i.ready,JSON.stringify({host:hostLease.facts(),owner:session.launchRegistration}));
    for(;;){try{await fs.stat(i.exit);process.exit(91);}catch(e){if(e.code!=='ENOENT')throw e;}await delay(10);}`);
  const child=spawn(process.execPath,[script,JSON.stringify({root:f.root,privateRoot:f.privateRoot,hostTool:['stopped-host-tool','abrupt-host-tool-pending','abrupt-host-tool-returned','abrupt-host-tool-result-unknown'].includes(mode),pendingTool:mode==='abrupt-host-tool-pending',holdReply:mode==='abrupt-host-tool-returned',resultUnknown:mode==='abrupt-host-tool-result-unknown',effect:path.join(f.root,'effect'),desktop:['stopped-desktop','abrupt-desktop'].includes(mode),profile:path.join(f.root,'profile'),projectId:f.projectId,home:f.home,agentDir:f.agentDir,cwd:f.cwd,runtime:f.runtime,ready,exit,stopped,mutation,jobId:randomUUID()})],{
    env:{SystemRoot:process.env.SystemRoot,TEMP:f.root,TMP:f.root,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let diagnostics='';child.stderr.on('data',bytes=>diagnostics+=bytes);child.stdout.resume();let supervisor;
  const closed=once(child,'close');let hostPin,ownerPin;
  const until=async fn=>{const deadline=performance.now()+15000;for(;;){const result=await fn();if(result)return result;if(performance.now()>deadline)assert.fail('Pi host observation timeout: '+diagnostics);await delay(10);}};
  f.finalizers.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;if(ownerPin){await until(()=>ownerPin.snapshot().state==='exited');ownerPin.close();}hostPin?.close();if(supervisor){supervisor.shutdown();supervisor.close();}});
  const facts=await until(async()=>{try{return JSON.parse(await fs.readFile(ready,'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;assert.equal(child.exitCode,null,diagnostics);}});
  assert.equal(f.provider.requests.length,mode==='stopped-host-tool'?2:1);hostPin=openExperimentalProcessIdentity(child.pid);
  assert.equal(hostPin.snapshot().stamp,facts.host.host.stamp);
  if(!stopped){ownerPin=openExperimentalProcessIdentity(facts.owner.record.identity.pid);assert.equal(ownerPin.snapshot().state,'running');}
  const exited=once(child,'exit');if(!forced)await fs.writeFile(exit,'exit');else child.kill();const result=await exited;
  if(!forced)assert.equal(result[0],91);else assert.equal(result[1],'SIGTERM');
  if(ownerPin)await until(()=>ownerPin.snapshot().state==='exited');assert.equal(hostPin.snapshot().state,'exited');
  const retained=await f.registry.read('frontdesk');assert.deepEqual(retained.value.supervision,facts.owner.record.supervision);
  supervisor=connectExperimentalProcessSupervisor(retained.value.supervision);await until(()=>supervisor.snapshot().jobEmptyObserved);
  assert.equal(supervisor.snapshot().hostExited,true);assert.equal(supervisor.snapshot().stamp,facts.owner.record.identity.stamp);assert.equal(supervisor.snapshot().coldRecoveryQualified,false);
  assert.equal(supervisor.snapshot().custodyVerified,true);
  await until(()=>{const facts=supervisor.snapshot();return facts.stdoutEOF&&facts.stderrEOF;});
  const outputFacts=supervisor.snapshot();assert.equal(outputFacts.outputCustodyVerified,true);assert.equal(outputFacts.outputError,0);
  const hash=createHash('sha256');let offset=0;
  for(;;){const range=supervisor.readOutput(1,offset);if(range.state==='eof')break;assert.equal(range.state,'data');hash.update(range.bytes);offset+=range.bytes.length;}
  assert.equal(offset,outputFacts.stdoutBytes);assert.equal(hash.digest('hex'),outputFacts.stdoutSha256);
  assert.ok(offset>0); // Actual Pi protocol survives even after its host consumed it.
  const outputObservation=await inspectExperimentalColdHostOutput({storage:f.storage,projectId:f.projectId,target:'frontdesk',supervisor});
  assert.equal(outputObservation.outputDigestVerified,true);assert.equal(outputObservation.stdout.byteLength,offset);
  assert.equal(outputObservation.ownerReleaseQualified,false);assert.equal(outputObservation.automaticReplay,false);
  await assert.rejects(f.registry.retire(retained,outputObservation),{code:'OWNER_EXIT_INVALID'});
  const journalBinding={storage:f.storage,projectId:f.projectId,target:'frontdesk',supervisor};
  if(mutation&&!['stopped-no-prompt-response','abrupt-no-prompt-response'].includes(mutation)){
    const expected=mutation==='abrupt-snapshot-digest'?'HOST_JOURNAL_CHANGED':mutation==='stopped-delivery-mismatch'?'HOST_REQUEST_BINDING_CHANGED':mutation==='stopped-truncated'?'HOST_JOURNAL_PROTOCOL_INVALID':mutation==='stopped-launch-mismatch'?'HOST_JOURNAL_BINDING_CHANGED':mutation==='stopped-request-mismatch'?'HOST_JOURNAL_REQUEST_UNCONFIRMED':'HOST_JOURNAL_STOP_UNCONFIRMED';
    await assert.rejects(inspectExperimentalColdHostJournal(journalBinding),{code:expected});
  }else if(stopped){
    const journal=await inspectExperimentalColdHostJournal(journalBinding);
    if(mode==='stopped-normal'){
      assert.equal(journal.metadataReads.completeObservedSet,true);
      const published=journal.metadataReads.confirmedVersions.find(version=>version.phase==='published');
      assert.equal(published.sha256,sha(await fs.readFile(path.join(f.home,'nozeli-session-tools.json'))));
      // Actual child original stdio/cold authority for the trusted role
      // package: complete coverage of exactly the real frontdesk catalog at
      // the original start; still no release/recovery closure claim.
      assert.equal(journal.roleReads.completeObservedSet,true);
      assert.equal(journal.roleReads.catalogCovered,true);
      assert.equal(journal.roleReads.role,'frontdesk');
      assert.equal(journal.roleReads.confirmedReads,(await roleSkillCatalog('frontdesk')).length);
      assert.equal(journal.roleReads.ownerReleaseQualified,false);
      assert.equal(journal.roleReads.fullRecoveryClosureQualified,false);
    }
    assert.equal(journal.settingsReads.schema,3);assert.ok(journal.settingsReads.confirmedReads>0);
    assert.equal(journal.settingsReads.ownerReleaseQualified,false);
    if(mode==='stopped-forced'){
      const receipt=journal.settingsReads.journal;
      const receiptFile=path.join(f.home,...receipt.relative.split('/')),original=await fs.readFile(receiptFile);
      await fs.rename(receiptFile,receiptFile+'.retained');await fs.writeFile(receiptFile,original);
      await assert.rejects(inspectExperimentalColdHostJournal(journalBinding),{code:'HOST_SETTINGS_CHANGED'});
      await fs.unlink(receiptFile);await fs.rename(receiptFile+'.retained',receiptFile);
      const orphan=path.join(journal.settingsReads.directory,'orphan.bytes');await fs.writeFile(orphan,'lost publication reply');
      const unknown=await inspectExperimentalColdHostJournal(journalBinding);
      assert.equal(unknown.settingsReads.completeObservedSet,false);assert.ok(unknown.settingsReads.unknownFiles.some(p=>p.endsWith('/orphan.bytes')));
      assert.equal(unknown.ownerReleaseQualified,false);await fs.unlink(orphan);
      assert.deepEqual((await inspectExperimentalColdHostJournal(journalBinding)).settingsReads,journal.settingsReads);
    }
    assert.equal(journal.reconciliation.turns.length,1);
    const turn=journal.reconciliation.turns[0];assert.equal(turn.businessSettlementQualified,false);assert.equal(turn.automaticReplay,false);
    if(mutation==='stopped-no-prompt-response'){assert.equal(turn.state,'execution-unknown');assert.equal(turn.responseObserved,false);assert.ok(journal.reconciliation.unansweredRpcIds.includes(turn.rpcId));}
    else{assert.equal(turn.state,'native-result-confirmed');assert.equal(turn.nativeInputConfirmed,true);assert.equal(journal.reconciliation.unansweredRpcIds.length,0);}
    if(mode==='stopped-host-tool'){assert.equal(journal.toolCustody.tools[0].state,'handler-returned-reply-observed');assert.equal(journal.toolCustody.tools[0].businessEffectQualified,false);assert.equal(journal.reconciliation.tools.length,1);assert.equal(journal.reconciliation.tools[0].replyObserved,true);assert.equal(journal.reconciliation.tools[0].businessEffectQualified,false);assert.equal(turn.hostToolsRequireReconciliation,true);assert.equal(await fs.readFile(path.join(f.root,'effect'),'utf8'),'one');}
    if(mode==='stopped-desktop'){
      const inspection=await openWindowsManagedColdInspection({storage:f.storage,projectId:f.projectId,inspectJournals:true});
      try{const receipt=await commitWindowsManagedColdCheckpoint(inspection,{storage:f.storage,projectId:f.projectId});assert.equal(receipt.journalRequestObservationsVerified,true);assert.equal(receipt.journals[0].journalSha256,journal.journalSha256);assert.equal(receipt.coldRecoveryQualified,false);}
      finally{inspection.close();}
      const second=await openWindowsManagedColdInspection({storage:f.storage,projectId:f.projectId,inspectJournals:true});
      const request=f.storage.db.request.bind(f.storage.db),original=await fs.readFile(journal.sessionFile);let writes=0;
      f.storage.db.request=async(file,op,args)=>{const result=await request(file,op,args);if(op==='put'&&args.collection==='managed_cold_checkpoints'){writes++;await fs.appendFile(journal.sessionFile,'external journal winner');}return result;};
      try{
        await assert.rejects(commitWindowsManagedColdCheckpoint(second,{storage:f.storage,projectId:f.projectId}),{code:'STORAGE_RESULT_UNKNOWN'});
        await assert.rejects(commitWindowsManagedColdCheckpoint(second,{storage:f.storage,projectId:f.projectId}),{code:'STORAGE_RESULT_UNKNOWN'});
        assert.equal(writes,1);assert.equal((await fs.readFile(journal.sessionFile)).subarray(original.length).toString(),'external journal winner');
      }finally{second.close();f.storage.db.request=request;await fs.writeFile(journal.sessionFile,original);}
    }
    assert.equal(journal.journalDigestVerified,true);assert.equal(journal.nativeEntriesVerified,true);assert.equal(journal.launchIdentityVerified,true);
    assert.equal(journal.ownerId,retained.value.ownerId);assert.equal(journal.generation,retained.value.generation);assert.equal(journal.launchId,retained.value.launchId);
    assert.equal(journal.journalSha256,sha(await fs.readFile(journal.sessionFile)));assert.ok(journal.entryCount>0);
    assert.equal(journal.ownerReleaseQualified,false);assert.equal(journal.automaticReplay,false);assert.equal(journal.stopRequestAdmissionQualified,true);assert.equal(journal.originalHostStopRequestVerified,true);
    await assert.rejects(f.registry.retire(retained,journal),{code:'OWNER_EXIT_INVALID'});
    if(forced){
      const original=await fs.readFile(journal.sessionFile),metadataFile=path.join(f.home,'nozeli-session-tools.json'),metadata=await fs.readFile(metadataFile);
      await fs.appendFile(journal.sessionFile,'changed winner');
      await assert.rejects(inspectExperimentalColdHostJournal(journalBinding),{code:'HOST_JOURNAL_CHANGED'});
      assert.equal((await fs.readFile(journal.sessionFile)).subarray(original.length).toString(),'changed winner');await fs.writeFile(journal.sessionFile,original);
      await fs.rename(journal.sessionFile,journal.sessionFile+'.original');await fs.writeFile(journal.sessionFile,original);
      await assert.rejects(inspectExperimentalColdHostJournal(journalBinding),{code:'HOST_JOURNAL_CHANGED'});
      await fs.rm(journal.sessionFile);await fs.rename(journal.sessionFile+'.original',journal.sessionFile);
      const wrong=JSON.parse(metadata);wrong.threadId=randomUUID();await fs.writeFile(metadataFile,JSON.stringify(wrong));
      await assert.rejects(inspectExperimentalColdHostJournal(journalBinding),{code:'HOST_JOURNAL_BINDING_CHANGED'});
      assert.equal(JSON.parse(await fs.readFile(metadataFile,'utf8')).threadId,wrong.threadId);await fs.writeFile(metadataFile,metadata);
      await fs.rename(journal.sessionFile,journal.sessionFile+'.missing');
      await assert.rejects(inspectExperimentalColdHostJournal(journalBinding),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===2);
      await assert.rejects(fs.stat(journal.sessionFile),{code:'ENOENT'});await fs.rename(journal.sessionFile+'.missing',journal.sessionFile);
      const restored=await inspectExperimentalColdHostJournal(journalBinding);assert.equal(restored.journalSha256,journal.journalSha256);
      const database=path.join(await f.storage.localDirectory(f.projectId),'ui.sqlite'),winner=structuredClone(retained.value);winner.generation=randomUUID();
      await f.storage.db.request(database,'put',{collection:'managed_owner_launches',id:'frontdesk',value:winner,expectedRevision:retained.revision});
      await assert.rejects(inspectExperimentalColdHostJournal(journalBinding),{code:'HOST_JOURNAL_BINDING_CHANGED'});
      assert.deepEqual((await f.registry.read('frontdesk')).value,winner);
      const current=await f.registry.read('frontdesk');await f.storage.db.request(database,'put',{collection:'managed_owner_launches',id:'frontdesk',value:retained.value,expectedRevision:current.revision});
    }
  }else{
    const journal=await inspectExperimentalColdHostJournal(journalBinding);
    assert.equal(journal.originalStopAcknowledgementObserved,false);assert.equal(journal.finalJournalComplete,false);
    assert.equal(journal.stopRequestAdmissionQualified,false);assert.equal(journal.ownerReleaseQualified,false);assert.equal(journal.coldRecoveryQualified,false);
    assert.equal(journal.reconciliation.turns[0].state,mutation||mode.startsWith('abrupt-host-tool-')?'execution-unknown':'native-result-confirmed');
    if(mode.startsWith('abrupt-host-tool-')){
      assert.equal(journal.reconciliation.tools.length,1);assert.equal(journal.reconciliation.tools[0].replyObserved,false);assert.equal(journal.reconciliation.tools[0].businessEffectQualified,false);
      assert.equal(journal.reconciliation.unresolvedToolIds.length,1);assert.equal(await fs.readFile(path.join(f.root,'effect'),'utf8'),'one');
      const custody=journal.toolCustody.tools[0];assert.equal(custody.state,mode==='abrupt-host-tool-pending'?'handler-outcome-unknown':'handler-returned-reply-unobserved');
      assert.equal(custody.handlerResultRetained,mode!=='abrupt-host-tool-pending');assert.equal(custody.businessEffectQualified,false);
      const inspection=await openWindowsManagedColdInspection({storage:f.storage,projectId:f.projectId,inspectJournals:true});
      try{const receipt=await commitWindowsManagedColdCheckpoint(inspection,{storage:f.storage,projectId:f.projectId});assert.deepEqual(receipt.journals[0].toolCustody,journal.toolCustody);assert.equal(receipt.coldRecoveryQualified,false);}finally{inspection.close();}
      const database=path.join(await f.storage.localDirectory(f.projectId),'ui.sqlite'),row=await f.storage.db.request(database,'record',{collection:'managed_owner_tools',id:custody.custodyId});
      const changed=await openWindowsManagedColdInspection({storage:f.storage,projectId:f.projectId,inspectJournals:true});
      const winner={...row.value,callId:'foreign-winner'};
      const request=f.storage.db.request.bind(f.storage.db);let writes=0;
      f.storage.db.request=async(file,op,args)=>{const result=await request(file,op,args);if(op==='put'&&args.collection==='managed_cold_checkpoints'){writes++;await request(database,'put',{collection:'managed_owner_tools',id:row.id??custody.custodyId,value:winner,expectedRevision:row.revision});}return result;};
      try{
        await assert.rejects(commitWindowsManagedColdCheckpoint(changed,{storage:f.storage,projectId:f.projectId}),{code:'STORAGE_RESULT_UNKNOWN'});
        await assert.rejects(commitWindowsManagedColdCheckpoint(changed,{storage:f.storage,projectId:f.projectId}),{code:'STORAGE_RESULT_UNKNOWN'});
        assert.equal(writes,1);assert.deepEqual((await request(database,'record',{collection:'managed_owner_tools',id:custody.custodyId})).value,winner);
      }finally{changed.close();f.storage.db.request=request;}
      await request(database,'delete',{collection:'managed_owner_tools',id:custody.custodyId});
      await assert.rejects(inspectExperimentalColdHostJournal(journalBinding),{code:'HOST_TOOL_CUSTODY_CHANGED'});
      assert.equal(await request(database,'record',{collection:'managed_owner_tools',id:custody.custodyId}),null,'deleted admission is never interpreted as no effect');

    }
    assert.equal(journal.reconciliation.businessSettlementQualified,false);assert.equal(journal.automaticReplay,false);
    assert.ok(journal.verifiedSnapshots.length>0);assert.equal(journal.confirmedJournalSha256,sha((await fs.readFile(journal.sessionFile)).subarray(0,journal.confirmedJournalBytes)));
    await assert.rejects(f.registry.retire(retained,journal),{code:'OWNER_EXIT_INVALID'});
    if(mode==='abrupt-tail'){
      const original=await fs.readFile(journal.sessionFile),tail=Buffer.from('{"interrupted":"原始残留 😀');
      await fs.appendFile(journal.sessionFile,tail);
      const appended=await inspectExperimentalColdHostJournal(journalBinding);
      assert.equal(appended.confirmedJournalSha256,journal.confirmedJournalSha256);assert.equal(appended.unconfirmedTailBytes,tail.length);assert.equal(appended.unconfirmedTailSha256,sha(tail));
      assert.deepEqual(await fs.readFile(journal.sessionFile),Buffer.concat([original,tail]));
      await fs.writeFile(journal.sessionFile,Buffer.concat([Buffer.from('x'),original.subarray(1)]));
      await assert.rejects(inspectExperimentalColdHostJournal(journalBinding),{code:'HOST_JOURNAL_CHANGED'});
      await fs.writeFile(journal.sessionFile,original);
      await fs.rename(journal.sessionFile,journal.sessionFile+'.original');await fs.writeFile(journal.sessionFile,original);
      await assert.rejects(inspectExperimentalColdHostJournal(journalBinding),{code:'HOST_JOURNAL_CHANGED'});
      await fs.rm(journal.sessionFile);await fs.rename(journal.sessionFile+'.original',journal.sessionFile);
    }
    if(mode==='abrupt-desktop'){
      const inspection=await openWindowsManagedColdInspection({storage:f.storage,projectId:f.projectId,inspectJournals:true});
      try{const receipt=await commitWindowsManagedColdCheckpoint(inspection,{storage:f.storage,projectId:f.projectId});assert.equal(receipt.journalRequestObservationsVerified,true);assert.equal(receipt.journals[0].originalStopAcknowledgementObserved,false);assert.equal(receipt.coldRecoveryQualified,false);}
      finally{inspection.close();}
    }
  }
  const sourceObservation=await inspectExperimentalColdHostSources({storage:f.storage,projectId:f.projectId,target:'frontdesk',supervisor});
  assert.equal(sourceObservation.sourceRecordsVerified,true);assert.equal(sourceObservation.coldRecoveryQualified,false);assert.equal(sourceObservation.ownerReleaseQualified,false);
  await assert.rejects(acquireExperimentalHostLease({storage:f.storage,projectId:f.projectId}),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===32);
  const database=path.join(await f.storage.localDirectory(f.projectId),'ui.sqlite');
  assert.equal((await f.storage.db.request(database,'record',{collection:'managed_host_leases',id:'host'})).value.phase,'active');
  const owner=await f.registry.read('frontdesk');assert.equal(owner.value.phase,'prepared');assert.equal(owner.value.hostLeaseId,facts.host.leaseId);assert.equal(owner.value.launchId,facts.owner.record.launchId);
  assert.equal((await f.storage.getRecovery(f.projectId,'managed:drafts')).frontdesk,'宿主重启仍未发送');assert.equal(f.provider.requests.length,mode==='stopped-host-tool'?2:1);
});

for(const mode of ['admission-unknown','admission-failure','result-failure','result-winner','result-service-closed','duplicate','handler-error','handler-business-unknown','foreign-job'])test(`actual tool custody ${mode} preserves single execution and exact SQLite winner`,native,async t=>{
  const f=await fixture(t,{nativeTools:[],handler:(request,index)=>index===1?{id:'host-tool',tool:'synthetic_effect',args:{text:'one'}}:{text:'回合结束。'}});
  const effect=path.join(f.root,'custody-effect'),request=f.storage.db.request.bind(f.storage.db),database=path.join(await f.storage.localDirectory(f.projectId),'ui.sqlite');
  let effects=0,writes=0,winner=null,originalFrame=null;
  const session=f.session({tools:[{name:'synthetic_effect',description:'Synthetic single effect',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}],onTool:async call=>{
    effects++;await fs.appendFile(effect,call.arguments.text);
    if(mode==='handler-error')throw Object.assign(Error('synthetic handler error after effect'),{code:'SYNTHETIC_AFTER_EFFECT'});
    if(mode==='handler-business-unknown')throw Object.assign(Error('synthetic business commit uncertainty after effect'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:{synthetic:true}});
    if(mode==='duplicate')await session.handleTool(structuredClone(originalFrame));
    if(mode==='result-service-closed')f.service.close();
    if(mode==='result-winner'){
      const rows=await request(database,'list',{collection:'managed_owner_tools'});assert.equal(rows.length,1);
      winner={...rows[0].value,callId:'foreign-winner'};await request(database,'put',{collection:'managed_owner_tools',id:rows[0].id,value:winner,expectedRevision:rows[0].revision});
    }
    return {text:'synthetic effect returned',continueTurn:true};
  }});
  await session.start();
  const receive=session.handleTool.bind(session);session.handleTool=frame=>{originalFrame=structuredClone(frame);return receive(mode==='foreign-job'?{...frame,jobId:'foreign-job'}:frame);};
  f.storage.db.request=async(file,op,args)=>{
    if(op==='put'&&args.collection==='managed_owner_tools'){
      writes++;
      if(mode==='admission-failure'&&args.value.phase==='admitted'||mode==='result-failure'&&args.value.phase==='handler-returned')throw Object.assign(Error('Controlled SQLite rejection before write'),{code:'SYNTHETIC_WRITE_REJECTED'});
      const result=await request(file,op,args);
      if(mode==='admission-unknown'&&args.value.phase==='admitted')throw Object.assign(Error('Controlled reply loss after actual admission commit'),{code:'STORAGE_RESULT_UNKNOWN'});
      return result;
    }
    return request(file,op,args);
  };
  try{
    const prompt=session.prompt('工具效果不允许重复',{job:{id:randomUUID(),target:'frontdesk',type:'front'},timeout:15000});
    if(['admission-unknown','result-failure','result-winner','result-service-closed','duplicate','handler-business-unknown'].includes(mode))await assert.rejects(prompt,{code:mode==='duplicate'?'PI_TOOL_DUPLICATE':'STORAGE_RESULT_UNKNOWN'});
    else await assert.rejects(prompt,{code:'PI_HOST_TOOL_FAILED'});
    const deadline=performance.now()+10000;while(session.inFlightToolCalls.size){if(performance.now()>deadline)assert.fail('Tool custody did not drain');await delay(5);}
  }finally{f.storage.db.request=request;}
  const rows=await request(database,'list',{collection:'managed_owner_tools'});
  const expectedEffects=['admission-unknown','admission-failure','foreign-job'].includes(mode)?0:1;assert.equal(effects,expectedEffects);
  if(expectedEffects)assert.equal(await fs.readFile(effect,'utf8'),'one');else await assert.rejects(fs.stat(effect),{code:'ENOENT'});
  assert.equal(rows.length,['admission-failure','foreign-job'].includes(mode)?0:1);
  if(winner)assert.deepEqual(rows[0].value,winner);
  else if(rows.length){
    const row=rows[0];assert.equal(row.value.phase,['admission-unknown','result-failure','result-service-closed'].includes(mode)?'admitted':'handler-returned');
    assert.equal(row.value.businessEffectQualified,false);assert.equal(row.value.automaticReplay,false);
    if(['handler-error','handler-business-unknown'].includes(mode))assert.equal(row.value.reply.error.code,mode==='handler-error'?'SYNTHETIC_AFTER_EFFECT':'STORAGE_RESULT_UNKNOWN');
    await assert.rejects(f.registry.beginTool(structuredClone(session.launchRegistration),originalFrame,{sessionId:session.threadId,requestId:originalFrame.requestId,jobId:originalFrame.jobId}),error=>['PI_TOOL_RECEIPT_INVALID','STORAGE_RESULT_UNKNOWN'].includes(error.code));
  }
  if(['admission-unknown','result-failure','result-winner'].includes(mode)){
    const count=writes;await assert.rejects(f.registry.beginTool(session.launchRegistration,originalFrame,{sessionId:session.threadId,requestId:originalFrame.requestId,jobId:originalFrame.jobId}),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(writes,count);
  }
  assert.equal(f.provider.requests.length,1);
});

test('actual Pi owner starts through shared registered launch, saves private metadata and performs no model call at startup',native,async t=>{
  const f=await fixture(t),session=f.session();
  try{await session.start();}catch(error){t.diagnostic(session.diagnostics);throw error;}
  assert.equal(session.processTree.verified,false,'global Windows ownership is still unsupported');
  assert.equal((await f.registry.read('frontdesk')).value.identity.pid,session.pid);
  assert.equal((await session.request('status')).sessionId,session.threadId);assert.equal(f.provider.requests.length,0);
  const metadata=JSON.parse(await fs.readFile(session.metadataFile,'utf8'));assert.equal(metadata.threadId,session.threadId);assert.equal(metadata.sessionFile,session.sessionFile);
  assert.equal(path.relative(f.agentDir,session.sessionFile).startsWith('..'),false);
  const flushed=await session.request('flush');assert.equal(flushed.persistence.mechanism,'windows-private-file-handle');assert.equal(flushed.persistence.file,'flushed');assert.equal(flushed.persistence.namespace,'not-qualified');assert.equal(typeof flushed.persistence.identity,'string');
  const receipt=await session.stop();assert.equal(receipt.confirmationComplete,true);assert.equal(receipt.proof.coldRecoveryQualified,false);assert.equal((await f.registry.read('frontdesk')).value.phase,'retired');
});

test('actual Pi owner ignores project extensions through startup, provider reload and a real model turn',native,async t=>{
  const f=await fixture(t),marker=path.join(f.cwd,'untrusted-extension-executed.txt');
  await fs.mkdir(path.join(f.cwd,'.pi','extensions'),{recursive:true});
  await fs.writeFile(path.join(f.cwd,'.pi','extensions','synthetic.js'),`import {writeFileSync} from 'node:fs';export default function(){writeFileSync(${JSON.stringify(marker)},'executed');}`);
  const settings=path.join(f.cwd,'.pi','settings.json'),bytes=JSON.stringify({defaultProvider:'local-fixture',defaultModel:'scripted',defaultThinkingLevel:'off'});
  await fs.writeFile(settings,bytes);const session=f.session();
  await session.start();await assert.rejects(fs.stat(marker),{code:'ENOENT'});assert.equal(f.provider.requests.length,0);
  await session.request('providerList',{cwd:f.cwd});await session.request('reload');
  const answer=await session.prompt('项目扩展不得运行，保留项目模型设置。',{job:{id:randomUUID(),target:'frontdesk',type:'front'}});
  assert.equal(answer.text,'本地 Windows Pi 回复。');assert.equal(f.provider.requests.length,1);assert.equal(f.provider.errors.length,0);
  await assert.rejects(fs.stat(marker),{code:'ENOENT'});assert.equal(await fs.readFile(settings,'utf8'),bytes);
  assert.equal((await session.stop()).confirmationComplete,true);
});

test('actual Pi live journal custody refuses external corruption without migration, projection or replay',native,async t=>{
  const f=await fixture(t),entries=[],session=f.session({onNativeEntry:entry=>entries.push(entry)});
  await session.start();
  await session.prompt('仅一次的 journal 核对输入',{job:{id:randomUUID(),target:'frontdesk',type:'front'}});
  const original=await fs.readFile(session.sessionFile),count=entries.length;
  const damaged=[Buffer.concat([original,Buffer.from('{broken-json}\n')]),Buffer.concat([original,Buffer.from([0xff,10])])];
  for(const candidate of damaged){
    await assert.rejects(fs.writeFile(session.sessionFile,candidate),error=>error.code==='EBUSY'||error.code==='EPERM');
    assert.deepEqual(await fs.readFile(session.sessionFile),original);
    const flushed=await session.request('flush');assert.equal(flushed.sha256File,sha(original));assert.equal(entries.length,count);assert.equal(f.provider.requests.length,1);
  }
  const stopped=await session.stop();assert.equal(stopped.confirmationComplete,true);
});

test('actual Pi SDK receives one exact Unicode prompt and returns native journal and shared delivery facts',native,async t=>{
  const f=await fixture(t),facts=[],entries=[],session=f.session({onTransportFact:fact=>facts.push(fact),onNativeEntry:fact=>entries.push(fact)});
  try{await session.start();}catch(error){t.diagnostic(session.diagnostics);throw error;}
  const input='  原始输入 中文 😀\n保留空白  ',result=await session.prompt(input,{job:{id:randomUUID(),target:'frontdesk',type:'front'}});
  assert.equal(result.completion,'provider-completed');assert.equal(result.text,'本地 Windows Pi 回复。');assert.equal(f.provider.requests.length,1);assert.equal(f.provider.errors.length,0);
  const user=f.provider.requests[0].messages.filter(row=>row.role==='user').at(-1),text=typeof user.content==='string'?user.content:user.content.filter(row=>row.type==='text').map(row=>row.text).join('\n');assert.equal(text,input);
  const journal=(await fs.readFile(session.sessionFile,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(journal.some(row=>row.message?.role==='user'&&JSON.stringify(row.message.content).includes('原始输入')));assert.ok(entries.some(row=>row.entry?.message?.role==='assistant'));
  assert.deepEqual(facts.map(row=>row.status),['prepared','submitted','admitted','native-record-confirmed','settled']);
  for(const fact of facts){assert.equal(fact.requestId,facts[0].requestId);assert.equal(fact.epoch,session.epoch);assert.equal(fact.contentDigest,facts[0].contentDigest);}
  await session.request('stop',{},15000);await session.exitPromise;
});

for(const mode of ['complete','lost-reply'])test(`actual Pi explicit continuation ${mode} publishes native recovery fence and never replays original input`,native,async t=>{
  let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{handler:async(_request,index)=>{
    if(index===1){entered();await gate;return {text:'late cancelled answer'};}
    assert.equal(index,2);return {text:'显式续作完成。'};
  }}),session=f.session();t.after(()=>release());
  await session.start();const job={id:randomUUID(),target:'frontdesk',type:'front'};
  const prompt=session.prompt('原始输入必须只登记一次',{job});prompt.catch(()=>{});await ready;
  const requestId=session.current.requestId;await session.interrupt();release();await prompt;
  const rows=()=>fs.readFile(session.sessionFile,'utf8').then(text=>text.trimEnd().split('\n').map(JSON.parse));
  const user=(await rows()).find(row=>row.message?.role==='user');
  const identity={sessionId:session.threadId,requestId,jobId:job.id,userEntryId:user.id};
  const inspection=await session.inspectRecovery(identity);assert.equal(inspection.state,'resumable');
  await assert.rejects(session.recover({...identity,expectedLeafId:'stale-leaf',recoveryAttemptId:randomUUID(),job}),{code:'RESTART_RECONCILIATION_REQUIRED'});
  assert.equal(f.provider.requests.length,1);
  const attempt=randomUUID();
  if(mode==='lost-reply'){
    let lost=false;const receive=session.receiveFrame.bind(session);session.receiveFrame=frame=>{
      if(!lost&&frame.method==='recover'&&frame.result){lost=true;frame={...frame,error:{code:'PI_SETTLEMENT_UNKNOWN',message:'Synthetic lost original reply after actual continuation'}};delete frame.result;}
      return receive(frame);
    };
  }
  const recovering=session.recover({...identity,expectedLeafId:inspection.leafId,recoveryAttemptId:attempt,job});
  if(mode==='lost-reply')await assert.rejects(recovering,{code:'PI_SETTLEMENT_UNKNOWN'});
  else{const result=await recovering;assert.equal(result.text,'显式续作完成。');assert.equal(result.recovery.recoveryAttemptId,attempt);}
  assert.equal(f.provider.requests.length,2);assert.equal((await rows()).filter(row=>row.message?.role==='user').length,1);
  const intent=session.sessionFile+'.recovery-'+sha(String(inspection.leafId))+'.json';
  const fence=JSON.parse(await fs.readFile(intent,'utf8'));assert.equal(fence.recoveryAttemptId,attempt);assert.equal(fence.leafId,inspection.leafId);
  await assert.rejects(session.recover({...identity,expectedLeafId:inspection.leafId,recoveryAttemptId:randomUUID(),job}),{code:'RESTART_RECONCILIATION_REQUIRED'});
  assert.equal(f.provider.requests.length,2);
  const completed=await session.inspectRecovery(identity);assert.equal(completed.state,'completed');
  const observed=await session.recover({...identity,expectedLeafId:completed.leafId,recoveryAttemptId:randomUUID(),job});
  assert.equal(observed.text,'显式续作完成。');assert.equal(observed.recovery.nativeAdmitted,false);assert.equal(f.provider.requests.length,2);
  const stopped=await session.stop();assert.equal(stopped.confirmationComplete,true);
});

test('actual Pi cancellation at the loopback provider preserves one request and does not replay',native,async t=>{
  let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{handler:async()=>{entered();await gate;return {text:'late response after cancellation'};}}),session=f.session();t.after(()=>release());
  await session.start();const pending=session.prompt('取消此合成输入',{job:{id:randomUUID(),target:'frontdesk',type:'front'}});pending.catch(()=>{});
  await ready;try{const receipt=await session.interrupt();assert.equal(receipt.stopped,true);}finally{release();}
  const result=await pending;assert.equal(result.providerStatus,'cancelled');assert.notEqual(result.completion,'provider-completed');assert.equal(f.provider.requests.length,1);
  await session.request('stop',{},15000);await session.exitPromise;
});

for(const field of ['entrySha256','commandSha256'])test(`normal Pi start refuses ${field} mismatch before durable launch or execution`,native,async t=>{
  const f=await fixture(t,{initialize:false,runtimeOverrides:{[field]:'0'.repeat(64)}}),session=f.session();
  await assert.rejects(session.start(),{code:'PI_RUNTIME_IDENTITY_CHANGED'});
  assert.equal(session.child,undefined);assert.equal(session.launchAttempt,undefined);assert.equal(await f.registry.read('frontdesk'),null);assert.equal(f.provider.requests.length,0);
  assert.throws(()=>session.write({id:'forbidden',method:'prompt'}),{code:'PI_RUNTIME_IDENTITY_CHANGED'});
});

test('normal Pi startup preserves a concurrent metadata winner and fences later input',native,async t=>{
  const f=await fixture(t),session=f.session(),winner=JSON.stringify({schema:1,threadId:'external-winner',toolsDigest:'winner'}),relative=path.relative(f.root,session.metadataFile).split(path.sep).join('/');
  await f.persistence.writeAtomic(relative,winner,{expectedSha256:null});
  await assert.rejects(session.start());
  assert.equal(await fs.readFile(session.metadataFile,'utf8'),winner);assert.equal(f.provider.requests.length,0);
  assert.ok((await f.registry.read('frontdesk')).value.identity.pid);assert.ok(session.startError);
  assert.throws(()=>session.write({id:'forbidden',method:'prompt'}),session.startError);
});

test('actual Pi native read tool sees only the requested synthetic project bytes and completes through one tool continuation',native,async t=>{
  const contents='Windows 本地文件 😀\n完整读取。',f=await fixture(t,{nativeTools:['read'],handler:(request,index)=>index===1?{id:'native-read-1',tool:'read',args:{path:'合成 input.md'}}:{text:'已读取本地合成文件。'}}),session=f.session();
  await fs.writeFile(path.join(f.cwd,'合成 input.md'),contents);await session.start();
  const result=await session.prompt('读取合成 input.md',{job:{id:randomUUID(),target:'frontdesk',type:'front'}});
  assert.equal(result.completion,'provider-completed');assert.equal(result.text,'已读取本地合成文件。');assert.equal(f.provider.requests.length,2);assert.equal(f.provider.errors.length,0);
  const tool=f.provider.requests[1].messages.find(row=>row.role==='tool');assert.ok(tool);assert.ok(JSON.stringify(tool.content).includes('Windows 本地文件 😀'));assert.equal(await fs.readFile(path.join(f.cwd,'合成 input.md'),'utf8'),contents);
  await session.request('stop',{},15000);await session.exitPromise;
});

test('actual Pi start refuses an unprotected pre-existing session directory without repairing its ACL',native,async t=>{
  const f=await fixture(t),directory=path.join(f.agentDir,'sessions');await fs.mkdir(directory);const session=f.session();
  await assert.rejects(session.start(),{code:'FS_SECURITY_CHANGED'});assert.equal(f.provider.requests.length,0);
  assert.ok((await f.registry.read('frontdesk')).value.identity.pid);assert.ok(session.startError);assert.equal((await fs.readdir(directory)).length,0);
});

test('confirmed local stop is single-flight and the same live registry permits a new generation without replay',native,async t=>{
  const f=await fixture(t),first=f.session();await first.start();const identity=first.threadId,launch=first.launchRegistration.record.launchId;
  const a=first.stop(),b=first.stop();assert.equal(a,b);const retired=await a;assert.equal(retired.confirmationComplete,true);assert.equal(first.closed,true);assert.equal(retired.registration.revision,3);
  const service=createExperimentalPiOwnerLaunch({root:f.root,home:f.home,agentDir:f.agentDir,runtime:f.runtime,registry:f.registry,target:'frontdesk',isCurrent:()=>true});f.services.push(service);
  const second=f.session({registeredOwnerLaunch:service});await second.start();assert.notEqual(second.threadId,identity);assert.notEqual(second.launchRegistration.record.launchId,launch);assert.equal(second.launchRegistration.revision,5);assert.equal(f.provider.requests.length,0);
  assert.equal((await second.stop()).confirmationComplete,true);assert.equal((await f.registry.read('frontdesk')).revision,6);
  const cold=createOwnerLaunchRegistry(f.storage,f.projectId);await assert.rejects(cold.begin({target:'frontdesk',home:f.home,ownerId:randomUUID(),generation:randomUUID(),launchId:randomUUID()}),{code:'STORAGE_CONFLICT'});
  assert.equal((await f.registry.read('frontdesk')).value.phase,'retired');
});

test('actual owner crash without final journal acknowledgement retains registration and budget',native,async t=>{
  const f=await fixture(t),session=f.session(),budget=new AgentProcessBudget({limit:2}),slot=budget.reserve(f.projectId,'frontdesk');budget.bind(slot,session);await session.start();session.child.terminate();await session.exitPromise;
  await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});assert.equal(budget.used,1);assert.equal(slot.state,'unconfirmed');assert.equal((await f.registry.read('frontdesk')).value.phase,'prepared');
});

test('journal modification after the final actual stop acknowledgement refuses owner retirement',native,async t=>{
  const f=await fixture(t),session=f.session();await session.start();await session.request('stop',{},15000);await session.exitPromise;
  await fs.appendFile(session.sessionFile,'{"synthetic":"late-winner"}\n');await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});assert.equal((await f.registry.read('frontdesk')).value.phase,'prepared');
  assert.ok((await fs.readFile(session.sessionFile,'utf8')).includes('late-winner'));
});

test('failed host native projection after real Pi output prevents otherwise graceful release',native,async t=>{
  const f=await fixture(t),session=f.session({onNativeEntry:fact=>{if(fact.entry?.message?.role==='assistant')throw Object.assign(Error('synthetic projection failure'),{code:'SYNTHETIC_PROJECTION_FAILED'});}});await session.start();
  await session.prompt('生成原生日志',{job:{id:randomUUID(),target:'frontdesk',type:'front'}}).catch(()=>{});await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});
  assert.equal(session.nativeError.code,'SYNTHETIC_PROJECTION_FAILED');assert.equal((await f.registry.read('frontdesk')).value.phase,'prepared');assert.equal(f.provider.requests.length,1);
});

test('external registration winner after actual Pi stop is preserved by retirement CAS',native,async t=>{
  const f=await fixture(t),session=f.session();await session.start();await session.request('stop',{},15000);await session.exitPromise;
  const previous=await f.registry.read('frontdesk'),winner={...previous.value,launchId:randomUUID(),ownerId:randomUUID(),phase:'external-winner'},file=path.join(await f.storage.localDirectory(f.projectId),'ui.sqlite');
  await f.storage.db.request(file,'put',{collection:'managed_owner_launches',id:'frontdesk',value:winner,expectedRevision:previous.revision});
  await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});assert.deepEqual((await f.registry.read('frontdesk')).value,winner);
});

test('lost reply after actual SQLite retirement commit fences restart and retains the budget',native,async t=>{
  const f=await fixture(t),session=f.session(),budget=new AgentProcessBudget({limit:2}),slot=budget.reserve(f.projectId,'frontdesk');budget.bind(slot,session);await session.start();
  const request=f.storage.db.request.bind(f.storage.db);f.storage.db.request=async(...args)=>{const result=await request(...args);if(args[1]==='put'&&args[2]?.value?.phase==='retired')throw Object.assign(Error('controlled lost retirement reply'),{code:'STORAGE_RESULT_UNKNOWN'});return result;};
  await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});f.storage.db.request=request;assert.equal(budget.used,1);
  const current=await request(path.join(await f.storage.localDirectory(f.projectId),'ui.sqlite'),'record',{collection:'managed_owner_launches',id:'frontdesk'});assert.equal(current.value.phase,'retired');
  await assert.rejects(f.registry.read('frontdesk'),{code:'STORAGE_RESULT_UNKNOWN'});const next=f.session();await assert.rejects(next.start(),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(next.child,undefined);assert.equal(f.provider.requests.length,0);
});

test('a transient descendant remains verifiable while the host event loop is blocked and the owner retires',native,async t=>{
  const helper=fileURLToPath(new URL('../native/windows-process/build/Release/nozeli_process_fixture.exe',import.meta.url));
  const f=await fixture(t,{ownerWrapper:({root,entry})=>`import fs from 'node:fs';import {spawnSync} from 'node:child_process';
    const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(path.join(root,'launch-transient'))}))return;clearInterval(timer);const result=spawnSync(${JSON.stringify(helper)},[],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(path.join(root,'transient-result'))},JSON.stringify({status:result.status,error:result.error?.message}));},2);
    await import(${JSON.stringify(pathToFileURL(entry).href)});`}),session=f.session(),budget=new AgentProcessBudget({limit:2});budget.bind(budget.reserve(f.projectId,'frontdesk'),session);await session.start();
  const original=session.child.lease.snapshot();writeFileSync(path.join(f.root,'launch-transient'),'go');
  // Block the host observer until the independent helper acknowledges exit;
  // fixed sleeps race Windows startup and can accidentally observe the child.
  const transientResult=path.join(f.root,'transient-result'),deadline=Date.now()+15000;
  while(!existsSync(transientResult)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
  const result=JSON.parse(await fs.readFile(transientResult,'utf8'));assert.equal(result.status,90);assert.equal(result.error,undefined);
  const before=session.child.lease.snapshot();assert.ok(before.totalProcesses>original.totalProcesses);assert.equal(before.allProcessIncarnationsObserved,true);
  const receipt=await session.stop();assert.equal(receipt.confirmationComplete,true);assert.equal(session.ownerStopAck.confirmationComplete,true);assert.equal(budget.used,0);assert.equal((await f.registry.read('frontdesk')).value.phase,'retired');
});

test('retirement reconciles transiently unobserved job incarnations inside the same budget instead of refusing on first facts',native,async t=>{
  const f=await fixture(t),session=f.session();await session.start();
  // Job TotalProcesses accounting is monotonic while observed members
  // enumerate the live list: after churn the first post-exit facts can lag.
  // Deterministic admission: the drain result and the first two post-exit
  // snapshots report the lag, later snapshots the settled truth; retirement
  // must wait within its budget, not refuse on the first facts.
  const drainReal=session.child.waitForExitAndDrain.bind(session.child);
  session.child.waitForExitAndDrain=async options=>({...await drainReal(options),allProcessIncarnationsObserved:false});
  const leaseOriginal=session.child.lease,realSnapshot=leaseOriginal.snapshot.bind(leaseOriginal);let postExitLag=0;
  session.child.lease={...leaseOriginal,snapshot:()=>{const facts=realSnapshot();if(session.exit&&postExitLag<2){postExitLag++;return {...facts,allProcessIncarnationsObserved:false};}return facts;}};
  const receipt=await session.stop();
  assert.ok(postExitLag>=2,'the lagging facts were actually served');
  assert.equal(receipt.confirmationComplete,true);
  assert.equal((await f.registry.read('frontdesk')).value.phase,'retired');
});

test('immediate retirement after native bash child churn settles exactly at the incarnation reconciliation boundary',native,async t=>{
  const bashPath='C:\\Program Files\\Git\\bin\\bash.exe';
  if(!existsSync(bashPath))return t.skip('pinned git-bash unavailable');
  const calls=40,f=await fixture(t,{nativeTools:['read','bash','write'],runtimeOverrides:{shell:bashPath},handler:(request,index)=>{
    if(index===1)return {id:'c-read',tool:'read',args:{path:'input.md'}};
    if(index>=2&&index<2+calls)return {id:'c-bash-'+index,tool:'bash',args:{command:'cat big.txt'}};
    if(index===2+calls)return {id:'c-write',tool:'write',args:{path:'out.txt',content:'native write result'}};
    return {text:'报告完成。'};
  }}),session=f.session();
  await session.start();
  await fs.writeFile(path.join(f.cwd,'input.md'),'# 合成输入\n');
  await fs.writeFile(path.join(f.cwd,'big.txt'),'x'.repeat(48*1024)+'\n');
  const answer=await session.prompt('完成四文件工作',{job:{id:randomUUID(),target:'frontdesk',type:'front'}});
  assert.equal(answer.completion,'provider-completed');assert.equal(f.provider.errors.length,0);
  // Tool churn makes Job TotalProcesses race member enumeration: an
  // immediate stop either reconciles (retired) or keeps exactly the
  // incarnation refusal with a fully valid acknowledged stop — never an
  // earlier-stage release and never a lost registration.
  let receipt=null,refused=null;
  try{receipt=await session.stop();}catch(error){refused=error;}
  if(refused){
    assert.equal(refused.code,'PI_EXIT_UNCONFIRMED');assert.equal(refused.cause?.stage,'retire-owner-incarnations');
    const evidence=session.cleanupEvidence();
    assert.equal(evidence.stage,'retire-owner-incarnations');
    assert.equal(evidence.ack.received,true);assert.equal(evidence.ack.confirmationComplete,true);
    assert.equal(evidence.protocol.readerCompleted,true);assert.equal(evidence.exit.code,0);
    assert.equal((await f.registry.read('frontdesk')).value.phase,'prepared');
  }else{
    assert.equal(receipt.confirmationComplete,true);
    assert.equal((await f.registry.read('frontdesk')).value.phase,'retired');
  }
});

test('stop failure evidence is a strict cached stage projection without messages paths or content',native,async t=>{
  const f=await fixture(t),session=f.session();await session.start();
  await session.prompt('生成原生日志',{job:{id:randomUUID(),target:'frontdesk',type:'front'}});
  await session.request('stop',{},15000);await session.exitPromise;await session.nativeDrain;
  await fs.appendFile(session.sessionFile,'{"synthetic":"late-winner"}\n');
  await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});
  const evidence=session.cleanupEvidence();
  assert.deepEqual(Object.keys(evidence).sort(),['ack','busy','causeCode','closed','currentTurn','exit','phase','process','protocol','schema','stage','stopping','terminationErrorCode']);
  assert.equal(evidence.schema,1);assert.equal(evidence.phase,'stop-retirement');
  assert.equal(evidence.stage,'retire-owner-journal-proof');assert.equal(evidence.causeCode,'PI_EXIT_UNCONFIRMED');
  assert.equal(evidence.ack.received,true);assert.equal(evidence.ack.confirmationComplete,true);
  assert.equal(evidence.protocol.readerCompleted,true);assert.equal(evidence.protocol.pendingCount,0);
  assert.equal(evidence.exit.observed,true);assert.equal(evidence.exit.code,0);
  const serialized=JSON.stringify(evidence);
  assert.ok(!serialized.includes('synthetic')&&!serialized.includes('late-winner')&&!serialized.includes('\\')&&!serialized.includes(f.home),'evidence carries no messages, paths or journal content');
  const again=session.cleanupEvidence();assert.deepEqual(again,evidence);
  again.stage='mutated';assert.equal(session.cleanupEvidence().stage,'retire-owner-journal-proof');
  assert.equal(session.lastExitReceipt.causeStage,'retire-owner-journal-proof');assert.equal(session.lastExitReceipt.causeCode,'PI_EXIT_UNCONFIRMED');
  assert.equal((await f.registry.read('frontdesk')).value.phase,'prepared');
});

test('a failed retained-handle postcheck after actual retirement commit fences later launches',native,async t=>{
  const f=await fixture(t),session=f.session();await session.start();
  const request=f.storage.db.request.bind(f.storage.db);f.storage.db.request=async(...args)=>{const result=await request(...args);if(args[1]==='put'&&args[2]?.value?.phase==='retired')f.service.close();return result;};
  await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});f.storage.db.request=request;
  const current=await request(path.join(await f.storage.localDirectory(f.projectId),'ui.sqlite'),'record',{collection:'managed_owner_launches',id:'frontdesk'});assert.equal(current.value.phase,'retired');
  await assert.rejects(f.registry.read('frontdesk'),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(session.closed,false);
});

test('a forged serialized exit summary cannot retire an actual still-running registered Pi owner',native,async t=>{
  const f=await fixture(t),session=f.session();await session.start();
  const forged={scope:'same-host-exact-job-and-journal',identity:session.launchRegistration.record.identity,allProcessIncarnationsObserved:true,stdoutEOF:true,stderrEOF:true,protocolComplete:true,journalSha256:'a'.repeat(64)};
  await assert.rejects(f.registry.retire(session.launchRegistration,forged),{code:'OWNER_EXIT_UNVERIFIED'});
  await assert.rejects(f.registry.retire(structuredClone(session.launchRegistration),forged),{code:'OWNER_EXIT_INVALID'});
  assert.equal((await session.request('status')).started,true);assert.equal((await f.registry.read('frontdesk')).value.phase,'prepared');assert.equal((await session.stop()).confirmationComplete,true);
});

test('an unsettled actual native projection has a bounded stop refusal and preserves the original launch',native,async t=>{
  let release,entered;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
  const f=await fixture(t),session=f.session({onNativeEntry:async fact=>{if(fact.entry?.message?.role==='assistant'){entered();await gate;}}});await session.start();
  const pending=session.prompt('保留未完成的宿主投影',{job:{id:randomUUID(),target:'frontdesk',type:'front'}});pending.catch(()=>{});await ready;
  const started=performance.now();try{await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});assert.ok(performance.now()-started<12000);assert.equal((await f.registry.read('frontdesk')).value.phase,'prepared');assert.equal(f.provider.requests.length,1);}
  finally{release();await pending.catch(()=>{});await session.nativeDrain;}
});

test('real Controller.open runs one actual Pi turn and retires its original native host custody',native,async t=>{
  const f=await fixture(t),budget=new AgentProcessBudget({limit:2});let registry;
  const controller=await Controller.open({storage:f.storage,projectId:f.projectId,runtimeRoot:path.join(f.root,'runtime'),contentRoot:f.cwd,
    workspaceIO:createExperimentalWindowsWorkspaceIO({root:f.root}),processBudget:budget,
    piRuntime:{...f.runtime,roleDefaultsFor:async()=>({selector:'local-fixture/scripted',effort:'off'})},
    ownerLaunchFactory:spec=>{
      assert.equal(spec.hostLease,controller.store.hostLease);
      registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:spec.hostLease});
      // Reuse only the isolated fixture's explicit model config; cold source
      // recovery is outside this warm public-open case.
      const service=createExperimentalPiOwnerLaunch({...spec,root:f.root,agentDir:f.agentDir,runtime:f.runtime,registry});f.services.push(service);return service;
    }});
  f.finalizers.push(async()=>{if(!controller.store.closed)await controller.stop();});
  await controller.store.setDraft('frontdesk','仍未发送的下一条输入');
  const session=await controller.makeSession('frontdesk');f.sessions.push(session);assert.equal(budget.used,1);
  const job={id:randomUUID(),target:'frontdesk',type:'front',status:'running',text:'真实 public open 后只发送一次',createdAt:new Date().toISOString()};
  await controller.store.mutate(()=>controller.store.state.jobs.push(job));controller.current.set('frontdesk',job);
  const result=await session.prompt(job.text,{job});assert.equal(result.completion,'provider-completed');assert.equal(f.provider.requests.length,1);
  const saved=controller.store.state.jobs.find(row=>row.id===job.id);assert.equal(saved.collabAttempts[0].recordConfirmed,true);assert.equal(saved.collabAttempts[0].status,'settled');
  assert.ok(controller.timeline.records().some(row=>row.jobId===job.id));assert.equal(controller.store.state.drafts.frontdesk,'仍未发送的下一条输入');
  const stopped=await controller.stop();assert.equal(stopped.confirmationComplete,true);assert.equal(stopped.hostRelease.record.phase,'retired');assert.equal(budget.used,0);assert.equal((await f.registry.read('frontdesk')).value.phase,'retired');assert.equal(f.provider.errors.length,0);
});

test('actual Pi settings reads bind project versions across a real turn and SDK reload without replay',native,async t=>{
 const f=await fixture(t),file=path.join(f.cwd,'.pi','settings.json');await fs.mkdir(path.dirname(file));
 const original=Buffer.from(JSON.stringify({defaultModel:'scripted',defaultProvider:'local-fixture',customMarker:'original'}));await fs.writeFile(file,original);
 const session=f.session();await session.start();
 const first=await session.prompt('配置版本原生读取验证',{job:{id:randomUUID(),target:'frontdesk',type:'front'}});assert.equal(first.completion,'provider-completed');assert.equal(f.provider.requests.length,1);
 const before=await session.request('flush'),proof=before.settingsReads;assert.equal(proof.mechanism,'windows-native-settings-read-journal');assert.ok(proof.reads>0);assert.equal(proof.fullRecoveryClosureQualified,false);
 const changed=Buffer.from(JSON.stringify({defaultModel:'scripted',defaultProvider:'local-fixture',customMarker:'external-update'}));await fs.writeFile(file,changed);await session.request('reload');
 const after=await session.request('flush');assert.equal(after.settingsReads.streamId,proof.streamId);assert.ok(after.settingsReads.reads>proof.reads);assert.notEqual(after.settingsReads.headSha256,proof.headSha256);
 await session.stop();
 const journal=await fs.readFile(path.join(proof.directory,`${proof.streamId}.journal`));
 const frames=[...readEvidenceFrames(journal,after.settingsReads.headBytes,1024*1024)];
 assert.equal(frames.length,after.settingsReads.reads);
 assert.equal(frames[proof.reads-1].headSha256,proof.headSha256);
 assert.equal(frames.at(-1).headSha256,after.settingsReads.headSha256);
 for(const bytes of [original,changed])assert.ok(frames.some(({row,bytes:raw})=>row.scope==='project'&&raw?.equals(bytes)&&row.path===file&&typeof row.fileIdentity==='string'));
 assert.equal(f.provider.requests.length,1);assert.deepEqual(await fs.readFile(file),changed);
});

test('shared Controller registers before execution, persists Pi facts and releases only after confirmed local exit',native,async t=>{
  const f=await fixture(t),runtimeDirectory=path.join(f.root,'runtime');
  const store=await Workspace.open(runtimeDirectory,f.cwd,{storage:f.storage,projectId:f.projectId,workspaceIO:createExperimentalWindowsWorkspaceIO({root:f.root})});
  f.hostLease=store.hostLease;f.registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:store.hostLease});
  await new SessionIndex(store).initialize();
  Object.assign(store.state,{jobs:[],messages:[],drafts:{},residents:{},providers:{},frontdeskRoutes:[],recoveryEvents:[]});
  const budget=new AgentProcessBudget({limit:2}),controller=new Controller(store,{projectId:f.projectId,processBudget:budget,piRuntime:{...f.runtime,roleDefaultsFor:async()=>({selector:'local-fixture/scripted',effort:'off'})},ownerLaunchFactory:spec=>{
    const service=createExperimentalPiOwnerLaunch({...spec,root:f.root,agentDir:f.agentDir,runtime:f.runtime,registry:f.registry});f.services.push(service);return service;
  }});
  f.finalizers.push(async()=>{if(!store.closed)await controller.stop();});
  await controller.initializeBindings();
  let session;try{session=await controller.makeSession('frontdesk');}finally{for(const value of controller.sessions.values())if(!f.sessions.includes(value))f.sessions.push(value);}
  const registration=(await f.registry.read('frontdesk')).value,provider=store.state.providers.frontdesk;
  assert.equal(provider.launchId,registration.launchId);assert.equal(provider.ownerId,registration.ownerId);assert.equal(provider.pid,session.pid);assert.equal(budget.used,1);
  const job={id:randomUUID(),target:'frontdesk',type:'front',status:'running',text:'Controller 实际输入',createdAt:new Date().toISOString()};
  await store.mutate(()=>store.state.jobs.push(job));controller.current.set('frontdesk',job);
  const result=await session.prompt(job.text,{job});assert.equal(result.completion,'provider-completed');assert.equal(f.provider.requests.length,1);
  const saved=store.state.jobs.find(row=>row.id===job.id);assert.equal(saved.collabAttempts.length,1);assert.equal(saved.collabAttempts[0].recordConfirmed,true);assert.equal(saved.collabAttempts[0].status,'settled');
  await session.stop();await session.controllerExitCleanup;
  assert.equal(budget.used,0);assert.equal(store.state.providers.frontdesk,undefined);assert.equal((await f.registry.read('frontdesk')).value.phase,'retired');
  const resumed=await controller.makeSession('frontdesk');f.sessions.push(resumed);assert.equal(resumed.threadId,session.threadId);assert.equal(f.provider.requests.length,1,'resume must not replay the accepted input');assert.equal(budget.used,1);
  await resumed.stop();await resumed.controllerExitCleanup;assert.equal(budget.used,0);assert.equal((await f.registry.read('frontdesk')).revision,6);
  assert.equal(f.hostLease.facts().pendingLaunches,0);assert.equal((await store.close()).record.phase,'retired');
});

test('actual owner starts, serves and retains original material under an over-long Unicode home environment',native,async t=>{
  // Before the SDK paths.js lazy-home patch, the owner child died pre-ack at
  // module load with ERR_SYSTEM_ERROR ENOBUFS (uv_os_homedir) as soon as
  // <home>/environment crossed libuv's 256 UTF-16 buffer units. The home and
  // its per-child environment stay under the original home; only the SDK's
  // unconditional homedir dependency on absolute paths is gone.
  const f=await fixture(t,{supervise:true,deepEnvironment:true});
  assert.ok(path.join(f.home,'environment').length>=258,'padded home crosses the libuv homedir buffer');
  const session=f.session();
  const started=await session.start();
  assert.ok(started.threadId);assert.ok(started.sessionFile);
  const answer=await session.prompt('深层主目录下的真实启动',{job:{id:randomUUID(),target:'frontdesk',type:'front'}});
  assert.equal(answer.completion,'provider-completed');assert.equal(f.provider.requests.length,1);
  let stopped;try{stopped=await session.stop();}catch(error){await fs.writeFile(path.join(process.env.NOZELI_TEST_OUTPUT_ROOT??f.root,'deep-home-stop-facts.json'),JSON.stringify({code:error.code,causeCode:error.cause?.code,causeMessage:error.cause?.message,exit:session.exit,ackComplete:session.ownerStopAck?.confirmationComplete,protocolComplete:session.protocolReader?.completed,pending:session.pending.size,nativeErrorCode:session.nativeError?.code,transportErrors:session.child?.errors?.map(row=>({channel:row.channel,code:row.error?.code}))},null,2));throw error;}
  assert.equal(stopped.confirmationComplete,true);
  // Original-environment identity: the per-child environment remains inside
  // the original owner home and appears in the complete home manifest.
  const tree=await openExperimentalPrivateTree(f.root,f.home,{rootAccess:'readwrite',fileAccess:'read'});
  try{
    assert.ok(tree.manifest.entries.some(entry=>entry.type==='directory'&&entry.relative==='environment'),'environment directory retained under the original home');
    assert.ok(tree.manifest.entries.some(entry=>entry.relative.startsWith('config/role-reads/')),'role skill evidence retained under the deep agent directory');
  }finally{tree.close();}
});
