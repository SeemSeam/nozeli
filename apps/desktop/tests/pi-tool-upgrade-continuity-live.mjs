// Genuine cross-version Pi tool-upgrade continuity proof (script style, also
// runs under node --test): a real private Pi owner first runs a historical
// host tool manifest (nozeli_maintenance actions status/retry/scan only),
// records one real native conversation (prompt + real host tool result +
// reply — never fabricated JSON), exits, and is then reopened by a session
// whose manifest adds the current scoped DEBUG actions on the SAME tool.
// The exact original thread/file must resume with zero provider requests,
// original history bytes retained, and a later explicit input must call the
// NEW action through the real bridge and return an actual host effect/read.
// The production Controller resident-start path repeats the upgrade with the
// real DEBUG protocol. Boundaries that must still refuse (pinned-vs-requested
// thread id, journal identity tamper, uninterpretable persisted metadata) are
// proven at the end. No credentials, paid models, user profiles or installed
// state are touched; every run owns fresh private directories, so a fresh or
// reset workspace cannot mask the in-test manifest upgrade.
// Installed target: set NOZELI_TEST_APP_ROOT to the real resources/app; all
// production modules are then imported from that root and the bundled Pi
// runtime is resolved with {packaged:true} (test-only env option; the parent
// runner executes this script with the installed runtime node). The loopback
// HTTP fixture is the only repo-relative import.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {serve} from './pi-provider.fixture.mjs';

const appRoot=path.resolve(process.env.NOZELI_TEST_APP_ROOT||path.join(import.meta.dirname,'..'));
const production=rel=>import(pathToFileURL(path.join(appRoot,rel)).href);
const {PiSession}=await production('src/agents/managed/pi-session.mjs');
const {Controller}=await production('src/agents/managed/controller.mjs');
const {ProjectStorage}=await production('src/main/project-storage.mjs');
const {resolveBundledPiRuntime}=await production('src/agents/managed/pi-runtime.mjs');

const evidenceRoot=path.resolve(process.env.NOZELI_TEST_EVIDENCE_ROOT||await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-upgrade-proof-')));
await fs.mkdir(evidenceRoot,{recursive:true});
const out=await fs.mkdtemp(path.join(evidenceRoot,'pi-tool-upgrade-continuity-'));
const result={ok:false,out,appRoot,packaged:Boolean(process.env.NOZELI_TEST_APP_ROOT),checks:[],scope:'Real private Pi owner, genuine host tool-manifest upgrade (maintenance actions status/retry/scan -> +debug/debug.inspect/debug.report) on one exact native thread; production Controller resident resume with the real DEBUG protocol; loopback scripted provider only; identity/tamper/metadata refusals stay. Fresh private dirs per run; no credentials, paid models, user profiles, reset or install.'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digestTools=tools=>createHash('sha256').update(JSON.stringify(tools)).digest('hex');
const save=(name,value)=>fs.writeFile(path.join(out,name),JSON.stringify(value,null,2));
async function until(fn,label,timeout=60000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await fn();if(value)return value;await pause(50);}
  throw Error('Timed out: '+label);
}
function lastToolResult(request,callId){
  const row=request.messages.findLast(message=>message.role==='tool'&&(message.tool_call_id===callId||message.toolCallId===callId));
  assert(row,'real host tool result for '+callId+' must ride back inside the native conversation');
  const content=typeof row.content==='string'?row.content:row.content.map(part=>part.text??'').join('\n');
  const value=JSON.parse(content);
  assert.notEqual(value.ok,false,'host tool refused '+callId+': '+content);
  return value.value??value;
}
const actionEnum=request=>{
  const def=request.tools?.find(tool=>tool.function?.name==='nozeli_maintenance');
  assert(def,'nozeli_maintenance is registered in the native tool manifest');
  const action=def.function.parameters?.properties?.action;
  assert(Array.isArray(action?.enum),'maintenance action enum reaches the native model');
  return action.enum;
};
const maintenanceTool=actions=>({type:'function',name:'nozeli_maintenance',description:'Isolated proof host maintenance channel whose action set is upgraded between host generations.',inputSchema:{type:'object',properties:{action:{type:'string',enum:actions}},required:['action'],additionalProperties:false}});
const OLD_ACTIONS=['status','retry','scan'];
const CURRENT_ACTIONS=['status','retry','scan','debug','debug.inspect','debug.report'];
const OLD_TOOLS=[maintenanceTool(OLD_ACTIONS)];
const CURRENT_TOOLS=[maintenanceTool(CURRENT_ACTIONS)];
const MODEL='local-fixture/scripted';
const OLD_INPUT='UPGRADE_PROOF_OLD_INPUT: run the historical maintenance status action once, then answer briefly.';
const OLD_ACK='UPGRADE_PROOF_OLD_ACK: historical status observed.';
const NEW_INPUT='UPGRADE_PROOF_NEW_INPUT: activate the new debug action and report its actual host effect.';
const NEW_ACK='UPGRADE_PROOF_NEW_ACK: new debug action executed with real evidence.';
const modelsJson=url=>JSON.stringify({providers:{'local-fixture':{baseUrl:url,api:'openai-completions',apiKey:'local-nonsecret',models:[{id:'scripted',name:'Scripted Proof',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}]}}});
const live=[];
let failed,provider;

// ── Phase 1: raw session cross-version proof ──────────────────────────────
try{
  let stage=0,effect;
  provider=await serve(async request=>{
    assert(provider.requests.filter(row=>!row.listing).length<12,'bounded proof turn count');
    const enum_=actionEnum(request);
    if(stage<2){
      assert.deepEqual(enum_,OLD_ACTIONS,'generation one exposes only the historical maintenance actions');
      if(stage===0){stage=1;return {id:'old-status',tool:'nozeli_maintenance',args:{action:'status'}};}
      const status=lastToolResult(request,'old-status');
      assert.equal(status.ledger.note,'synthetic-upgrade-ledger','status returned the real host-side ledger read');
      stage=2;
      return {text:OLD_ACK};
    }
    if(stage===2)throw Error('no provider request is allowed while the owner is only being resumed');
    assert.deepEqual(enum_,CURRENT_ACTIONS,'the resumed session registers the upgraded manifest with the new DEBUG actions');
    if(stage===3){stage=4;return {id:'new-debug',tool:'nozeli_maintenance',args:{action:'debug'}};}
    const value=lastToolResult(request,'new-debug');
    // The tool receipt itself is appended to the journal after the read, so
    // verify the exact prefix the tool observed, not the post-append file.
    const current=await fs.readFile(value.sessionFile);
    assert(Number.isSafeInteger(value.journalBytes)&&value.journalBytes<=current.length&&value.journalBytes>0);
    assert.equal(value.journalSha256,sha(current.subarray(0,value.journalBytes)),'the new action returned an actual read of the journal prefix it observed, not a mock echo');
    assert.equal(value.threadId,result.threadId);
    effect=value;stage=5;
    return {text:NEW_ACK};
  });
  const requests=()=>provider.requests.filter(row=>!row.listing).length;
  const root=await fs.mkdtemp(path.join(out,'raw-'));
  const project=path.join(root,'project'),home=path.join(root,'agents','resident-orchestrator-pi'),agentDir=path.join(root,'pi-config');
  await fs.mkdir(project,{recursive:true});await fs.mkdir(agentDir,{recursive:true});
  await fs.writeFile(path.join(agentDir,'models.json'),modelsJson(provider.url),{mode:0o600});
  await fs.writeFile(path.join(project,'upgrade-proof-ledger.json'),JSON.stringify({note:'synthetic-upgrade-ledger',generation:'historical-manifest'}));
  const runtime=await resolveBundledPiRuntime({...(result.packaged?{appRoot,packaged:true}:{}),piHome:agentDir});
  result.runtime={command:runtime.command,args:runtime.args,entry:runtime.entry};
  const openSession=tools=>{
    const session=new PiSession({role:'orchestrator',cwd:project,home,piRuntime:runtime,model:MODEL,tools,
      instructions:'Isolated upgrade-continuity proof runner; use host tools exactly as scripted and never invent results.',
      onTool:async p=>{
        assert.equal(p.tool,'nozeli_maintenance');
        if(p.arguments.action==='status')return {readOnly:true,continueTurn:true,ledger:JSON.parse(await fs.readFile(path.join(project,'upgrade-proof-ledger.json'),'utf8'))};
        if(p.arguments.action==='debug'){
          assert(p.promptId,'the new action runs inside the real admitted turn');
          const bytes=await fs.readFile(session.sessionFile);
          const record={attemptId:randomUUID(),threadId:session.threadId,sessionFile:session.sessionFile,journalSha256:sha(bytes),journalBytes:bytes.length,effectFile:path.join(project,'debug-effect.json'),at:new Date().toISOString()};
          await fs.writeFile(record.effectFile,JSON.stringify(record,null,2)+'\n');
          return {readOnly:true,continueTurn:true,...record};
        }
        throw Error('unexpected proof action '+p.arguments.action);
      }});
    live.push(session);
    return session;
  };
  // Historical manifest records one genuine native conversation, then exits.
  let session=openSession(OLD_TOOLS);
  await session.start();
  const first=await session.prompt(OLD_INPUT,{job:{id:'upgrade-proof-old-turn',target:'orchestrator',type:'maintenance',revision:1}});
  assert.equal(first.text,OLD_ACK);
  assert.equal(requests(),2,'generation one made exactly its two scripted requests');
  const threadId=session.threadId,sessionFile=session.sessionFile,oldDigest=session.toolsDigest;
  assert.equal(oldDigest,digestTools(OLD_TOOLS));
  const journal1=await fs.readFile(sessionFile,'utf8');
  for(const marker of [OLD_INPUT,OLD_ACK,'nozeli_maintenance','status'])assert(journal1.includes(marker),'real native journal holds the seeded '+marker);
  const metadataFile=path.join(home,'nozeli-session-tools.json');
  const metadata1=JSON.parse(await fs.readFile(metadataFile,'utf8'));
  assert.deepEqual(metadata1,{schema:1,threadId,sessionFile,toolsDigest:oldDigest});
  assert.equal((await session.stop()).confirmationComplete,true,'historical owner exited cleanly');
  live.splice(live.indexOf(session),1);
  result.threadId=threadId;result.sessionFile=sessionFile;result.oldDigest=oldDigest;
  result.checks.push('generation one: real private owner ran the historical status/retry/scan manifest, recorded a genuine prompt+tool-result+reply journal and exited cleanly');

  // Upgraded manifest resumes the exact thread with zero provider calls.
  session=openSession(CURRENT_TOOLS);
  const preflight=await session.preflightToolsDigest(oldDigest);
  assert.equal(preflight.equivalent,false);
  assert.equal(preflight.toolsDigest,digestTools(CURRENT_TOOLS));
  assert.equal(preflight.expectedToolsDigest,oldDigest);
  assert.equal(preflight.pinnedToolsDigest,oldDigest);
  assert.equal(await fs.readFile(metadataFile,'utf8'),JSON.stringify(metadata1),'preflight is load-only; a changed digest never rewrites the pinned record');
  await session.start(threadId);
  assert.equal(session.threadId,threadId,'exact original native thread resumed');
  assert.equal(session.sessionFile,sessionFile,'exact original journal file resumed');
  assert.equal(requests(),2,'resume of the upgraded manifest made zero provider requests');
  assert.equal(await fs.readFile(sessionFile,'utf8'),journal1,'resume never rewrote native history');
  assert.deepEqual(JSON.parse(await fs.readFile(metadataFile,'utf8')),{schema:1,threadId,sessionFile,toolsDigest:digestTools(CURRENT_TOOLS)},'verified resume republishes the pinned record with the new digest and SAME thread');
  assert.deepEqual(session.assertToolsDigest(oldDigest),{equivalent:false,resumedWithChangedTools:true,toolsDigest:digestTools(CURRENT_TOOLS),expectedToolsDigest:oldDigest,pinnedToolsDigest:oldDigest},'a changed historical digest is lineage evidence, not a refusal');
  assert.throws(()=>session.assertToolsDigest('unknown-lineage-digest'),{code:'PI_TOOLS_DIGEST_MISMATCH'});
  await pause(400);
  assert.equal(requests(),2,'no deferred automatic model activity after resume');
  result.checks.push('upgrade resume: same thread/file, zero provider requests, original bytes retained, digest repinned as diagnostic only');

  // Explicit new input drives the NEW action through the real bridge.
  stage=3;
  const second=await session.prompt(NEW_INPUT,{job:{id:'upgrade-proof-new-turn',target:'orchestrator',type:'maintenance',revision:2}});
  assert.equal(second.text,NEW_ACK);
  assert.equal(requests(),4);
  // Independent durable-effect read: the file the host wrote must match the
  // record that traveled native tool -> journal -> provider verbatim.
  const effectRecord=JSON.parse(await fs.readFile(path.join(project,'debug-effect.json'),'utf8'));
  for(const key of Object.keys(effectRecord))assert.equal(effectRecord[key],effect[key],'durable effect file matches the tool result that reached the provider: '+key);
  assert(effectRecord.journalBytes>journal1.length,'the effect read observed the live journal after the new turn began');
  const journal2=await fs.readFile(sessionFile,'utf8');
  assert(journal2.startsWith(journal1),'original native history retained verbatim as a prefix after the new turn');
  assert(journal2.includes(NEW_INPUT)&&journal2.includes(NEW_ACK));
  for(const request of provider.requests.filter(row=>!row.listing))assert.equal(request.messages.filter(message=>message.role==='user'&&JSON.stringify(message.content).includes(OLD_INPUT)).length,1,'the original input is retained history exactly once, never replayed');
  assert.equal((await session.stop()).confirmationComplete,true);
  live.splice(live.indexOf(session),1);
  result.checks.push('new explicit input called the new debug action through the real bridge; the provider received the actual live-journal digest and a real durable effect file exists');

  // Genuine boundaries still refuse; nothing is silently replaced.
  const sessionsDir=path.dirname(sessionFile),sessionsBefore=(await fs.readdir(sessionsDir)).sort();
  const wrongThread=openSession(CURRENT_TOOLS);
  await wrongThread.preflightToolsDigest();
  await assert.rejects(wrongThread.start('not-the-pinned-thread'),{code:'PI_SESSION_IDENTITY'});
  assert.equal(wrongThread.pid,undefined,'identity refusal happens before any owner spawn');
  assert.equal(requests(),4);
  const metadata2=JSON.parse(await fs.readFile(metadataFile,'utf8'));
  const lines=journal2.split('\n');
  lines[0]=JSON.stringify({...JSON.parse(lines[0]),id:'tampered-session-id'});
  await fs.writeFile(sessionFile,lines.join('\n'));
  const tampered=openSession(CURRENT_TOOLS);
  await tampered.preflightToolsDigest();
  await assert.rejects(tampered.start(threadId),{code:'PI_SESSION_IDENTITY'},'a journal whose own session identity was tampered must refuse resume');
  await tampered.stop().catch(()=>{});
  live.splice(live.indexOf(tampered),1);
  assert.equal(requests(),4,'identity refusal never fell back to a provider call');
  assert.deepEqual((await fs.readdir(sessionsDir)).sort(),sessionsBefore,'no fresh replacement session file was created by any refusal');
  assert.equal(await fs.readFile(metadataFile,'utf8'),JSON.stringify(metadata2),'failed starts never republish the pinned record');
  await fs.writeFile(metadataFile,JSON.stringify({schema:99,threadId,sessionFile,toolsDigest:digestTools(CURRENT_TOOLS)}));
  await assert.rejects(openSession(CURRENT_TOOLS).preflightToolsDigest(),{code:'PI_TOOLS_METADATA_SCHEMA'},'an uninterpretable pinned record still refuses');
  result.checks.push('genuine boundaries refuse: pinned-vs-requested thread id, tampered journal identity, uninterpretable persisted metadata; zero provider fallback, no replacement session');
  assert.deepEqual(provider.errors.map(error=>error.message),[]);
  result.rawRequests=requests();
}catch(error){
  failed=error;
  result.providerErrors=provider.errors.map(row=>({message:row?.message,stack:row?.stack}));
  result.error={phase:'raw-session',message:error.message,stack:error.stack};
}finally{
  await provider?.close();
  for(const session of [...live]){try{await session.stop();}catch{}}
}

// ── Phase 2: production Controller resident path, real DEBUG protocol ─────
let controller=null,storage=null;
if(!failed)try{
  const root=await fs.mkdtemp(path.join(out,'controller-'));
  const project=path.join(root,'project'),agentDir=path.join(root,'pi-config');
  await fs.mkdir(project,{recursive:true});await fs.mkdir(agentDir,{recursive:true});
  let proofBugId=null,attemptId=null,stage=0,inspectVerified=false;
  const controllerJob=()=>[...(controller?.current.values()??[])].find(row=>row.target==='orchestrator')?.type;
  provider=await serve(async request=>{
    assert(provider.requests.filter(row=>!row.listing).length<12,'bounded controller turn count');
    const enum_=actionEnum(request);
    if(controllerJob()==='backstage')return {id:'ctl-backstage-preserve',tool:'nozeli_backstage_respond',args:{blocked:true,reason:'Keep the exact original clarification for the user without inventing a response or replaying input.'}};
    if(controllerJob()==='maintenance'){
      assert.deepEqual(enum_,CURRENT_ACTIONS,'the Controller-resumed orchestrator registers the full current manifest');
      if(stage===0){stage=1;return {id:'ctl-debug',tool:'nozeli_maintenance',args:{action:'debug',bugId:proofBugId}};}
      if(stage===1){
        const activation=lastToolResult(request,'ctl-debug');
        attemptId=activation.attemptId;
        assert(attemptId);assert(activation.evidence.sources.length>=1);
        const source=activation.evidence.sources.find(row=>row.path.endsWith('/pi-session.mjs'));
        assert(source,'host-selected evidence includes the real session source');
        stage=2;
        return {id:'ctl-inspect',tool:'nozeli_maintenance',args:{action:'debug.inspect',bugId:proofBugId,attemptId,sourceId:source.sourceId,startLine:1,lineCount:40}}};
      if(stage===2){
        const page=lastToolResult(request,'ctl-inspect');
        const real=(await fs.readFile(pathToFileURL(path.join(appRoot,'src/agents/managed/pi-session.mjs')),'utf8')).split('\n').slice(page.startLine-1,page.endLine).join('\n');
        assert.equal(page.text,real,'debug.inspect returned the actual current production source bytes');
        assert.equal(page.endLine-page.startLine+1,40);
        inspectVerified=true;stage=3;
        return {id:'ctl-report',tool:'nozeli_maintenance',args:{action:'debug.report',bugId:proofBugId,attemptId,diagnosis:'工具清单升级被误判为不兼容并强制交接。',rootCause:'历史宿主把工具摘要变化当作拒绝恢复的身份错误。',fixPlan:'以线程与属主身份为准恢复；摘要变化仅作诊断证据。'}}};
      // The report receipt without a continuation capability is an explicit
      // terminal host result: the native owner ends the turn without another
      // provider request, so the persisted report is asserted below from the
      // durable ledger.
      throw Error('Unexpected maintenance prompt after the terminal report');
    }
    assert.deepEqual(enum_,OLD_ACTIONS,'generation one Controller session exposes only the historical actions');
    if(stage===0){stage=1;return {id:'ctl-old-status',tool:'nozeli_maintenance',args:{action:'status'}};}
    if(stage===1){const status=lastToolResult(request,'ctl-old-status');assert(Array.isArray(status.bugs));stage=2;return {id:'ctl-old-clarify',tool:'nozeli_manage',args:{action:'clarify',text:'UPGRADE_PROOF_CLARIFY: 保留原请求边界，等待用户明确。'}};}
    const clarify=lastToolResult(request,'ctl-old-clarify');
    assert.equal(clarify.action,'clarify');assert.equal(clarify.needsAnswer,true);
    stage=3;
    return {text:OLD_ACK};
  });
  const requests=()=>provider.requests.filter(row=>!row.listing).length;
  await fs.writeFile(path.join(agentDir,'models.json'),modelsJson(provider.url),{mode:0o600});
  const runtime=await resolveBundledPiRuntime({...(result.packaged?{appRoot,packaged:true}:{}),piHome:agentDir});
  storage=new ProjectStorage(path.join(root,'.test-storage'));
  const registered=await storage.register(project);
  // The historical manifest differs from the current production build only in
  // the maintenance action set — exactly the real upgrade delta; no product
  // description text is pinned by any assertion.
  const legacyManifest=tools=>tools.map(def=>def.name==='nozeli_maintenance'
    ?{...def,inputSchema:{...def.inputSchema,properties:{...def.inputSchema.properties,action:{...def.inputSchema.properties.action,enum:OLD_ACTIONS}}}}
    :def);
  const options=legacy=>({storage,projectId:registered.id,runtimeRoot:path.join(root,'runtime'),contentRoot:project,
    sessionFactory:legacy?(spec,target)=>new PiSession({...spec,model:spec.model??MODEL,...(target==='orchestrator'?{tools:legacyManifest(spec.tools)}:{})})
      :spec=>new PiSession({...spec,model:spec.model??MODEL}),
    piRuntime:runtime,
    piSource:{modelFor:async()=>MODEL,roleDefaultsFor:async()=>({selector:MODEL,effort:null})},
    projectHome:async dir=>{await fs.mkdir(dir,{recursive:true});}});
  const waitForJob=jobId=>until(()=>{
    const job=controller.store.state.jobs.find(row=>row.id===jobId);
    if(job?.status==='completed')return job;
    if(job?.status==='failed')throw Error('controller job failed: '+JSON.stringify({error:job.error,errorCode:job.errorCode}));
    return null;
  },'controller job '+jobId,90000);
  // Generation one: the Controller itself runs with the historical manifest.
  controller=await Controller.open(options(true));
  await controller.start();
  const sent=await controller.send('orchestrator',OLD_INPUT,{requestKey:'upgrade-continuity-controller-old'});
  const oldJob=await waitForJob(sent.jobId);
  assert.equal(oldJob.routing.action,'clarify');
  await until(()=>!controller.running.size&&!controller.kicking&&controller.store.state.jobs.every(job=>!['queued','running','transferring'].includes(job.status)),'historical generation native and backstage settlement');
  assert.equal(controller.store.state.works.length,0,'harmless history never creates Work');
  const ctlRequestsBefore=requests();
  const resident=controller.store.state.residents.orchestrator;
  const ctlThread=resident.threadId,ctlDigest=resident.toolsDigest;
  const ctlFile=controller.sessions.get('orchestrator').sessionFile;
  const ctlJournal=await fs.readFile(ctlFile,'utf8');
  const ctlMetadataFile=path.join(controller.store.root,'agents','resident-orchestrator-pi','nozeli-session-tools.json');
  const ctlMetadata=JSON.parse(await fs.readFile(ctlMetadataFile,'utf8'));
  assert.equal(ctlMetadata.threadId,ctlThread);
  assert.equal(ctlMetadata.toolsDigest,ctlDigest);
  assert(ctlJournal.includes(OLD_INPUT)&&ctlJournal.includes('nozeli_maintenance'));
  const ctlState=structuredClone({jobs:controller.store.state.jobs,messages:controller.store.state.messages,works:controller.store.state.works,todos:controller.store.state.todos,drafts:controller.store.state.drafts});
  const ctlJobCount=controller.store.state.jobs.length;
  const ctlIndex=structuredClone(controller.store.state.sessionIndex??{entries:[]});
  await controller.stop();
  // Generation two: the current production manifest resumes the same thread.
  stage=0;
  controller=await Controller.open(options(false));
  assert.equal(controller.store.state.residents.orchestrator.toolsDigest,ctlDigest,'persisted resident row still names the historical manifest digest');
  await controller.makeSession('orchestrator',{preflightOnly:true});
  assert.deepEqual(JSON.parse(await fs.readFile(ctlMetadataFile,'utf8')),ctlMetadata,'controller preflight is load-only');
  await controller.start();
  assert.equal(requests(),ctlRequestsBefore,'controller resume made zero provider requests');
  const resumed=controller.sessions.get('orchestrator');
  assert.equal(resumed.threadId,ctlThread,'controller resumed the exact original orchestrator thread');
  assert.equal(resumed.sessionFile,ctlFile);
  assert.notEqual(resumed.toolsDigest,ctlDigest);
  assert.equal(controller.store.state.residents.orchestrator.threadId,ctlThread);
  assert.equal(controller.store.state.residents.orchestrator.toolsDigest,resumed.toolsDigest,'resident digest row advanced to the running manifest');
  assert.equal(await fs.readFile(ctlFile,'utf8'),ctlJournal,'controller resume never rewrote the native journal');
  assert.deepEqual({jobs:controller.store.state.jobs,messages:controller.store.state.messages,works:controller.store.state.works,todos:controller.store.state.todos,drafts:controller.store.state.drafts},ctlState,'no original job/message replay, replacement or business mutation on resume');
  const resumedIndex=controller.store.state.sessionIndex;
  for(const oldEntry of ctlIndex.entries)assert.deepEqual(resumedIndex.entries.find(entry=>entry.id===oldEntry.id),oldEntry,'original native history projection is unchanged');
  const originalIds=new Set(ctlIndex.entries.map(entry=>entry.id));
  assert(resumedIndex.entries.filter(entry=>!originalIds.has(entry.id)).every(entry=>entry.recordKind==='metadata'&&entry.requestId==null),'resume may append lifecycle metadata, never replay conversation input');
  assert.deepEqual((await controller.maintenance.read()).bugs,[],'an ordinary tool upgrade opens no maintenance bug');
  await pause(400);
  assert.equal(requests(),ctlRequestsBefore);
  result.checks.push('controller upgrade resume: exact thread/file, zero provider calls, resident digest row advanced, ledger/journal/index state retained without replay');
  // Explicit post-upgrade maintenance event completes the real DEBUG protocol.
  const bug=await controller.maintenance.record({phase:'tool-upgrade-continuity-proof',error:{code:'UPGRADE_DEBUG_PROOF_FAULT',message:'Synthetic loopback-only proof fault exercising the post-upgrade DEBUG action'}});
  proofBugId=bug.id;
  const event=await controller.maintenanceEvent(bug);
  assert(event?.eventJobId,'explicit maintenance event scheduled');
  await waitForJob(event.eventJobId);
  assert(inspectVerified,'the new debug.inspect returned real production source bytes through the bridge');
  const ledger=await controller.maintenance.read();
  const reloaded=ledger.bugs.find(row=>row.id===proofBugId);
  assert.equal(reloaded.debug.state,'awaiting-fix');
  assert.equal(reloaded.debug.inspections.length,1);
  assert(reloaded.debug.report.diagnosis);
  assert.equal(reloaded.debug.report.kind,'model-interpretation');assert.equal(reloaded.debug.report.verifiedFix,false);
  assert.deepEqual(await storage.getLocal(registered.id,'managed:maintenance'),ledger,'diagnosis durably persisted');
  const ctlJournal2=await fs.readFile(ctlFile,'utf8');
  assert(ctlJournal2.startsWith(ctlJournal),'controller original history retained as prefix after the new turn');
  assert.equal(controller.store.state.works.length,0);
  assert.equal(controller.store.state.jobs.length,ctlJobCount+1,'exactly one new maintenance job; no intake replay');
  assert.equal(controller.store.state.residents.orchestrator.threadId,ctlThread);
  await controller.stop();
  result.checks.push('post-upgrade maintenance event completed the real DEBUG protocol end to end: activation, genuine source read, durable model-interpretation report; no Work, no replay, thread unchanged');
  assert.deepEqual(provider.errors.map(error=>error.message),[]);
  result.controllerRequests=requests();
}catch(error){
  failed=error;
  result.providerErrors=provider.errors.map(row=>({message:row?.message,stack:row?.stack}));
  result.error={phase:'controller',message:error.message,stack:error.stack};
}finally{
  try{await controller?.stop();}catch{}
  await provider?.close();
  await storage?.db.close().catch(()=>{});
}
result.ok=!failed&&result.checks.length===6;
await save('result.json',result);
console.log(JSON.stringify({ok:result.ok,out,checks:result.checks,error:result.error,rawRequests:result.rawRequests,controllerRequests:result.controllerRequests}));
process.exitCode=result.ok?0:1;
