// Shared public Controller + actual Pi SDK + bundled Git, isolated local input.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {AgentProcessBudget} from '../src/agents/managed/agent-process-budget.mjs';
import {createOwnerLaunchRegistry} from '../src/main/owner-launch-registry.mjs';
import {createExperimentalWindowsWorkspaceIO,createWindowsDesktopWorkspaceIO} from '../src/platform/windows/experimental-workspace-io.mjs';
import {managedRuntime} from '../src/agents/managed/managed-storage.mjs';
import {createExperimentalPiOwnerLaunch} from '../src/platform/windows/experimental-pi-owner-launch.mjs';
import {createExperimentalWindowsPersistence} from '../src/platform/windows/experimental-persistence.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {git,str,commitTree} from '../src/agents/managed/git-service.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:180000};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const runtimeRoot=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');

for(const desktop of [false,true])test(`real public Controller scheduler drives Pi edit, exact human review/Git, interrupted owner-home archival and warm reopen while retaining drafts (${desktop?'desktop separate roots':'explicit single root'})`,{skip:process.platform!=='win32'||process.arch!=='x64'||!desktop?'Windows packaged main qualification covers the explicit desktop separate-root owner contract; the experimental single-root adapter remains unsupported':false,timeout:180000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli Worker 中文 ')),profile=path.join(root,'profile'),content=path.join(root,'project');await fs.mkdir(content);const services=[];
  const toolResult=request=>{const message=request.messages.filter(row=>row.role==='tool').at(-1);assert.ok(message,'real SDK tool response required');const text=typeof message.content==='string'?message.content:message.content.filter(row=>row.type==='text').map(row=>row.text).join('\n');return JSON.parse(text);};
  const provider=await serve((request,index)=>{
    if(index===1)return {id:'worker-read',tool:'nozeli_document_read',args:{relPath:'正文.md'}};
    const result=toolResult(request);assert.equal(result.ok,true,JSON.stringify(result));
    if(index===2)return {id:'worker-apply',tool:'nozeli_document_apply',args:{readHandle:result.value.readHandle,replacements:[{oldText:'baseline',newText:'Windows Worker 实际修改 😀'}]}};
    assert.equal(index,3,'publication must stop this original turn');return {id:'worker-publish',tool:'nozeli_publish',args:{kind:'result',content:staticReport('已通过宿主文档工具修改正文，候选等待审阅。'),files:['正文.md']}};
  });
  const storage=new ProjectStorage(profile,desktop?{windowsDesktopProjects:true}:{experimentalWindowsRoot:root,experimentalWindowsInitialization:true}),projectId=(await storage.register(content)).id;
  const runtime=desktop?await managedRuntime(storage,projectId):path.join(root,'runtime'),privateRoot=desktop?profile:root;
  const workspaceIO=previousHostRelease=>desktop?createWindowsDesktopWorkspaceIO({storage,previousHostRelease}):createExperimentalWindowsWorkspaceIO({root,previousHostRelease});
  await fs.writeFile(path.join(content,'正文.md'),'baseline');await fs.writeFile(path.join(content,'draft.md'),'user disk draft');
  await fs.writeFile(path.join(content,'package.json'),'{"name":"synthetic-worker","version":"1.0.0","type":"module"}\n');await fs.writeFile(path.join(content,'package-lock.json'),'{"lockfileVersion":3,"packages":{}}\n');await fs.writeFile(path.join(content,'.gitignore'),'node_modules/\n.nozeli/\ndist/\n');
  await fs.mkdir(path.join(content,'node_modules/probe'),{recursive:true});await fs.writeFile(path.join(content,'node_modules/probe/index.mjs'),'export const probe="real-worker-dependency";\n');
  await fs.mkdir(path.join(content,'vendor/engine/dist'),{recursive:true});await fs.writeFile(path.join(content,'vendor/engine/dist/index.html'),'real-worker-resource');await fs.writeFile(path.join(content,'vendor/engine/README.md'),'synthetic resource parent');await fs.writeFile(path.join(content,'vendor/prepared-resources.json'),'{"version":1,"resources":[{"path":"vendor/engine/dist"}]}\n');
  await git(content,['init','--initial-branch=main']);await git(content,['config','core.autocrlf','false']);await git(content,['add','.']);const initial=await commitTree(content,await str(content,['write-tree']),[],'synthetic baseline',path.join(root,'seed'));await git(content,['update-ref','refs/heads/main',initial]);
  const manifest=JSON.parse(await fs.readFile(path.join(runtimeRoot,'runtime-manifest.json'),'utf8')),entry=path.join(runtimeRoot,'src/owner.mjs'),baseRuntime={command:process.execPath,commandSha256:sha(await fs.readFile(process.execPath)),entry,entrySha256:manifest.files['src/owner.mjs'],nativeTools:[]},budget=new AgentProcessBudget({limit:3});let controller;
  const teardownPhase={current:'pending'};
  const teardownWatch=process.env.NOZELI_WORKER_DIAGNOSTIC?setTimeout(()=>{t.diagnostic(`teardown-suspended ${teardownPhase.current} ${JSON.stringify({budgetUsed:budget.used})}`);},100000):null;teardownWatch?.unref?.();
  t.after(async()=>{try{
    teardownPhase.current='controller-stop';if(controller&&!controller.store.closed)await controller.stop();
    teardownPhase.current='services-close';for(const service of services)service.close();
    teardownPhase.current='provider-close';await provider.close();
    teardownPhase.current='db-close';await storage.db.close();
    teardownPhase.current='rm-root';await fs.rm(root,{recursive:true,force:true});
  }finally{clearTimeout(teardownWatch);}});
  // DIAGNOSTIC SCAFFOLD (remove after the Electron desktop Worker stall is
  // root-fixed): with NOZELI_WORKER_DIAGNOSTIC set by the external harness,
  // each lifecycle await is watchdog-bounded well below the test timeout so a
  // stall fails fast naming the stage with live controller/session state.
  // Ordinary qualification runs never set it: they await the original work
  // under the original 180 s timeout with no extra deadline or failure path,
  // and only safe stage names are recorded (no stderr/model text retained).
  const diagnostic=Boolean(process.env.NOZELI_WORKER_DIAGNOSTIC);
  const stages=[];
  const evidence=()=>{try{
    return {desktop,providerRequests:provider.requests.length,providerErrors:provider.errors.length,
      jobs:controller?.store?.state?.jobs?.map(row=>({id:row.id,status:row.status})),
      running:controller?[...controller.running.keys()]:[],
      sessions:controller?[...controller.sessions.values()].map(session=>({role:session.role??session.spec?.role??null,phase:session.phase,pid:session.pid??null,threadId:session.threadId??null,stderrTail:String(session.diagnostics??'').slice(-400)})):[],
      budgetUsed:budget.used,stages:[...stages]};
  }catch(error){return {desktop,evidenceError:String(error&&error.message||error),stages:[...stages]}}};
  const stage=async(name,run,stageBudget=45000)=>{
    const started=Date.now();stages.push(name);t.diagnostic(`stage> ${name}`);
    if(!diagnostic){try{return await run();}finally{t.diagnostic(`stage< ${name} (${Date.now()-started}ms)`);}}
    let timer;
    try{
      const result=await Promise.race([Promise.resolve().then(run),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(`Worker lifecycle stage stalled: ${name} ${JSON.stringify(evidence())}`),{code:'WORKER_STAGE_STALLED',stage:name})),stageBudget);timer.unref?.();})]);
      t.diagnostic(`stage< ${name} (${Date.now()-started}ms)`);return result;
    }finally{clearTimeout(timer);}
  };
  controller=await stage('controller-open',()=>Controller.open({storage,projectId,runtimeRoot:runtime,contentRoot:content,workspaceIO:workspaceIO(),processBudget:budget,piRuntime:{...baseRuntime,roleDefaultsFor:async()=>({selector:'local-fixture/scripted',effort:'off'})},ownerLaunchFactory:spec=>{const agentDir=path.join(spec.home,'config'),service=createExperimentalPiOwnerLaunch({...spec,root:privateRoot,agentDir,runtime:{...baseRuntime,agentDir},registry:createOwnerLaunchRegistry(storage,projectId,{hostLease:spec.hostLease})});services.push(service);return service;}}));
  if(diagnostic){
    // DIAGNOSTIC SCAFFOLD: preserve each owner child's exit facts and failure
    // identity IMMEDIATELY per event to a safe JSONL file that survives a
    // later teardown suspension. Normal qualification never runs this.
    const exitEvidenceFile=path.join(root,'session-exit-evidence.jsonl');
    controller.on('session-exit',({target,exit})=>{
      const session=controller.sessions.get(target);
      const detail={at:new Date().toISOString(),target,exit,phase:session?.phase,pid:session?.pid??null,
        startError:session?.startError?{code:session.startError.code,message:session.startError.message}:null,
        launchError:session?.launchError?{code:session.launchError.code,message:session.launchError.message}:null,
        transportError:session?.transportError?{code:session.transportError.code,message:session.transportError.message}:null,
        stderrTail:String(session?.diagnostics??'').slice(-800),providerRequests:provider.requests.length,
        budgetUsed:budget.used};
      try{appendFileSync(exitEvidenceFile,JSON.stringify(detail)+'\n');}catch{}
      t.diagnostic(`session-exit-evidence ${JSON.stringify(detail)}`);
    });
  }
  controller.on('diagnostic',message=>t.diagnostic(message));
  await controller.store.setDraft('frontdesk','未发送草稿必须保留');await controller.store.setDraft('orchestrator','保留草稿，自动维护不派工');const work=await controller.store.submit('将正文的 baseline 改为 Windows Worker 实际修改 😀，形成报告等待用户接受。','只修改正文.md，不提交源项目。');await controller.store.activate(work.id);
  for(const target of ['frontdesk','orchestrator',work.id]){
    const home=target===work.id?controller.store.agentHome(work.id):path.join(controller.store.root,'agents',`resident-${target}-pi`),config=path.join(home,'config');await ensureExperimentalPrivateDirectory(privateRoot,config);
    await createExperimentalWindowsPersistence(privateRoot).writeAtomic(path.relative(privateRoot,path.join(config,'models.json')).split(path.sep).join('/'),JSON.stringify({providers:{'local-fixture':{baseUrl:provider.url,api:'openai-completions',apiKey:'synthetic-local-only',models:[{id:'scripted',name:'Scripted local fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}]}}}));
  }
  await stage('controller-start',()=>controller.start());
  const submitted=await stage('send-work-input',()=>controller.send(work.id,'按任务执行并发布候选报告。',{requestKey:'synthetic-worker-input'})),job=controller.store.state.jobs.find(row=>row.id===submitted.jobId);
  const deadline=Date.now()+30000;
  while(!controller.running.has(work.id)){assert.ok(Date.now()<deadline,'public scheduler must launch the queued Worker');await delay(10);}
  await stage('worker-run',()=>controller.running.get(work.id),60000);
  assert.equal(provider.errors.length,0,provider.errors.map(error=>error.stack).join('\n'));assert.equal(controller.store.state.jobs.find(row=>row.id===job.id).status,'completed',JSON.stringify(controller.store.state.jobs.find(row=>row.id===job.id)));assert.equal(provider.requests.length,3);
  const current=controller.store.find(work.id);assert.equal(current.status,'review',JSON.stringify({work:current,maintenance:current.status!=='review'?await controller.maintenance.read():undefined,messages:controller.store.state.messages?.filter(row=>row.target===work.id).slice(-5)}));assert.equal(await fs.readFile(path.join(content,'正文.md'),'utf8'),'baseline');assert.equal(await fs.readFile(path.join(controller.execution.directory(work.id),'正文.md'),'utf8'),'Windows Worker 实际修改 😀');
  const prepared=await controller.execution.readManifest(work.id);assert.equal(prepared.dependencies.entries.length,2);assert.ok(prepared.dependencies.entries.every(row=>row.outcome==='provisioned'||row.outcome==='present'),JSON.stringify(prepared.dependencies));
  const imported=spawnSync(process.execPath,['--input-type=module','-e','const {probe}=await import(process.argv[1]); const fs=await import("node:fs"); console.log(probe+":"+fs.readFileSync(process.argv[2],"utf8"));',pathToFileURL(path.join(prepared.directory,'node_modules/probe/index.mjs')).href,path.join(prepared.directory,'vendor/engine/dist/index.html')],{cwd:prepared.directory,encoding:'utf8',windowsHide:true,timeout:15000});assert.ifError(imported.error);assert.equal(imported.status,0,imported.stderr);assert.equal(imported.stdout.trim(),'real-worker-dependency:real-worker-resource');
  assert.deepEqual(prepared.candidate.files,['正文.md']);
  const receipt=controller.store.state.receipts.find(row=>row.workId===work.id&&row.kind==='result');assert.ok(receipt.changeSetId);assert.equal((await controller.changes.verify(receipt.changeSetId)).verified,true);
  const home=controller.store.agentHome(work.id),session=controller.sessions.get(work.id),record=controller.store.state.providers[work.id],journalRelative=path.relative(home,session.sessionFile);
  const toolDatabase=path.join(await storage.localDirectory(projectId),'ui.sqlite');
  const custody=await storage.db.request(toolDatabase,'list',{collection:'managed_owner_tools'}),workerCustody=custody.filter(row=>row.value.launchId===session.launchRegistration.record.launchId);
  assert.equal(workerCustody.length,3);assert.deepEqual(workerCustody.map(row=>row.value.tool).sort(),['nozeli_document_apply','nozeli_document_read','nozeli_publish']);
  for(const row of workerCustody){assert.equal(row.value.phase,'handler-returned');assert.equal(row.value.jobId,job.id);assert.equal(row.value.sessionId,session.threadId);assert.equal(row.value.businessEffectQualified,false);assert.equal(row.value.automaticReplay,false);assert.equal(row.value.replySha256,sha(JSON.stringify(row.value.reply)));assert.ok(row.value.reply.result&&typeof row.value.reply.result==='object');}
  const publication=workerCustody.find(row=>row.value.tool==='nozeli_publish').value.reply.result;
  assert.equal(workerCustody.find(row=>row.value.tool==='nozeli_publish').value.callId,receipt.id,'original call ID must bind the existing business receipt');
  assert.equal(publication.saved,true);assert.equal(publication.object,receipt.objectId,'durable handler result must retain the existing publication object identity');
  const apply=workerCustody.find(row=>row.value.tool==='nozeli_document_apply').value,operation=controller.store.state.fileOperations.find(row=>row.id===apply.callId);
  assert.equal(operation.jobId,job.id);assert.equal(operation.afterDigest,apply.reply.result.value.digest);assert.equal(operation.eventId,apply.reply.result.value.eventId);
  await controller.store.io.validateWorkerOwner({workId:work.id,home,session,record});
  for(const altered of [{...record,stamp:record.stamp+'1'},{...record,generation:'00000000-0000-4000-8000-000000000001'}])await assert.rejects(controller.store.io.validateWorkerOwner({workId:work.id,home,session,record:altered}),{code:'HOST_LEASE_OWNER_UNVERIFIED'});
  await assert.rejects(controller.store.io.verifyWorkerRetirement({workId:work.id,home}),{code:'HOST_LEASE_OWNER_UNVERIFIED'});
  const review=await stage('review-read',()=>controller.reviewRead({objectId:receipt.objectId,workId:work.id}));assert.ok(review.reviewVersion);
  const reviewedText='用户审校确认 Windows Worker 实际修改 😀',saved=await stage('review-save',()=>controller.reviewSave({objectId:receipt.objectId,workId:work.id,relPath:'正文.md',text:reviewedText,expectedDraftRevision:0}));assert.notEqual(saved.reviewVersion,review.reviewVersion);
  await stage('review-stale-reject',()=>assert.rejects(controller.reviewAccept({objectId:receipt.objectId,workId:work.id,reviewVersion:review.reviewVersion,requestKey:'synthetic-stale-review'}),{code:'REVIEW_VERSION_STALE'}));assert.equal(await fs.readFile(path.join(content,'正文.md'),'utf8'),'baseline');
  const io=controller.store.io;let moves=0,replacedBeforeIntent=false;
  controller.store.io={...io,async verifyWorkerRetirement(options){const owner=await io.verifyWorkerRetirement(options);if(!replacedBeforeIntent){replacedBeforeIntent=true;await fs.rename(home,home+'-original-owner');await ensureExperimentalPrivateDirectory(root,home);await io.writeImmutable(path.join(home,'independent'),Buffer.from('before-intent winner'));}return owner;},async openWorkerHome(directory,options){const tree=await io.openWorkerHome(directory,options);return tree&&{...tree,async publishTo(...args){await tree.publishTo(...args);moves++;await ensureExperimentalPrivateDirectory(root,home);await io.writeImmutable(path.join(home,'independent'),Buffer.from('after-publication winner'));throw Object.assign(Error('lost callback after actual Worker home publication'),{committed:true});}};}};
  const firstAcceptance=await stage('review-accept-blocked',()=>controller.reviewAccept({objectId:receipt.objectId,workId:work.id,reviewVersion:saved.reviewVersion,requestKey:'synthetic-worker-accept'}),60000);assert.equal(firstAcceptance.closure.phase,'blocked');assert.equal(firstAcceptance.closure.workerHomeIntent,undefined);assert.equal(moves,0);assert.equal(await fs.readFile(path.join(home,'independent'),'utf8'),'before-intent winner');
  await fs.rename(home,home+'-before-intent-winner');await fs.rename(home+'-original-owner',home);
  const originalJournal=path.join(home,journalRelative),originalJournalBytes=await fs.readFile(originalJournal);await fs.writeFile(originalJournal,'before-intent journal winner');await stage('cleanup-journal-winner-reject',()=>assert.rejects(controller.store.cleanupWorkerHome(work.id),{code:'WORKER_ARCHIVE_CHANGED'}));assert.equal(await fs.readFile(originalJournal,'utf8'),'before-intent journal winner');assert.equal(controller.store.find(work.id).closure.workerHomeIntent,undefined);await fs.writeFile(originalJournal,originalJournalBytes);
  await fs.rename(originalJournal,originalJournal+'.held');await stage('cleanup-journal-held-reject',()=>assert.rejects(controller.store.cleanupWorkerHome(work.id),{code:'WORKER_ARCHIVE_CHANGED'}));assert.deepEqual(await fs.readFile(originalJournal+'.held'),originalJournalBytes);await fs.rename(originalJournal+'.held',originalJournal);
  await stage('retry-closure-first',()=>controller.retryClosure(work.id),60000);const accepted={closure:structuredClone(controller.store.find(work.id).closure)};controller.store.io=io;
  assert.equal(accepted.closure.git.status,'merged');assert.equal(accepted.closure.phase,'blocked');assert.equal(accepted.closure.workerHome,undefined);assert.equal(moves,1);
  const archived=accepted.closure.workerHomeIntent.destination,journal=path.join(archived,journalRelative);assert.equal(await fs.readFile(path.join(home,'independent'),'utf8'),'after-publication winner');await fs.rename(home,home+'-after-publication-winner');assert.equal(sha(await fs.readFile(journal)),accepted.closure.stopReceipt.provider.proof.journalSha256);
  // These attempts retain independent contenders and exact original identities.
  await ensureExperimentalPrivateDirectory(root,home);await io.writeImmutable(path.join(home,'independent'),Buffer.from('winner'));await assert.rejects(controller.store.cleanupWorkerHome(work.id),{code:'FS_DIRECTORY_CONFLICT'});assert.equal(await fs.readFile(path.join(home,'independent'),'utf8'),'winner');await fs.rename(home,home+'-independent');
  const journalBytes=await fs.readFile(journal);await fs.writeFile(journal,'independent journal winner');await assert.rejects(controller.store.cleanupWorkerHome(work.id),{code:'WORKER_ARCHIVE_CHANGED'});assert.equal(await fs.readFile(journal,'utf8'),'independent journal winner');await fs.writeFile(journal,journalBytes);
  await fs.rename(archived,archived+'-original');await ensureExperimentalPrivateDirectory(root,archived);await io.writeImmutable(path.join(archived,'independent'),Buffer.from('replacement directory'));await assert.rejects(controller.store.cleanupWorkerHome(work.id),{code:'WORKER_ARCHIVE_CHANGED'});assert.equal(await fs.readFile(path.join(archived,'independent'),'utf8'),'replacement directory');await fs.rename(archived,archived+'-independent');await fs.rename(archived+'-original',archived);
  await stage('retry-closure-final',()=>controller.retryClosure(work.id),60000);const ended=controller.store.find(work.id);assert.equal(ended.closure.phase,'complete',JSON.stringify({closure:ended.closure,maintenance:await controller.maintenance.read()}));assert.equal(ended.closure.workerHome.scope,'complete-private-owner-home');assert.equal(moves,1);
  assert.equal(sha(await fs.readFile(journal)),ended.closure.stopReceipt.provider.proof.journalSha256);assert.equal(JSON.parse(await fs.readFile(path.join(archived,'config','models.json'),'utf8')).providers['local-fixture'].baseUrl,provider.url);
  assert.equal(await fs.readFile(path.join(content,'正文.md'),'utf8'),reviewedText);assert.equal(await fs.readFile(path.join(content,'draft.md'),'utf8'),'user disk draft');assert.equal(controller.store.state.drafts.frontdesk,'未发送草稿必须保留');assert.equal(budget.used,2,'only the two idle residents remain');
  assert.equal(await str(content,['rev-parse','main']),ended.closure.git.commit);const stopped=await stage('controller-stop',()=>controller.stop(),60000);assert.equal(stopped.confirmationComplete,true);assert.equal(budget.used,0);assert.equal(provider.requests.length,3);
  controller=await stage('controller-reopen',()=>Controller.open({storage,projectId,runtimeRoot:runtime,contentRoot:content,workspaceIO:workspaceIO(stopped.hostRelease),processBudget:budget}),60000);
  assert.deepEqual(await storage.db.request(toolDatabase,'list',{collection:'managed_owner_tools'}),custody,'warm reopen preserves the exact tool receipts without re-execution');
  assert.equal(controller.store.find(work.id).closure.phase,'complete');assert.equal(controller.store.find(work.id).closure.reviewedVersion.reviewVersion,saved.reviewVersion);assert.equal(controller.store.state.drafts.frontdesk,'未发送草稿必须保留');assert.equal(controller.sessions.size,0);assert.equal(await fs.readFile(path.join(content,'正文.md'),'utf8'),reviewedText);const reopened=await stage('controller-reopen-stop',()=>controller.stop(),60000);assert.equal(reopened.confirmationComplete,true);assert.equal(provider.requests.length,3);
});

test('failed-start owner cleanup stays bounded and retains registration identity and budget without fake release',native,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli Worker preack 中文 ')),profile=path.join(root,'profile'),content=path.join(root,'project');await fs.mkdir(content);
  const storage=new ProjectStorage(profile,{windowsDesktopProjects:true}),projectId=(await storage.register(content)).id;
  const home=path.join(root,'agents','resident-frontdesk-pi'),agentDir=path.join(home,'config');
  await ensureExperimentalPrivateDirectory(root,agentDir);
  await createExperimentalWindowsPersistence(root).writeAtomic(path.relative(root,path.join(agentDir,'models.json')).split(path.sep).join('/'),JSON.stringify({providers:{'local-fixture':{baseUrl:'http://127.0.0.1:9',api:'openai-completions',apiKey:'synthetic-local-only',models:[{id:'scripted',name:'Scripted',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}]}}}));
  // The approved owner entry exits before any acknowledgement: a failed start.
  const entry=path.join(root,'preack-exit-owner.mjs');await fs.writeFile(entry,'process.exit(7);\n');
  const runtime={command:process.execPath,commandSha256:sha(await fs.readFile(process.execPath)),entry,entrySha256:sha(await fs.readFile(entry)),agentDir,nativeTools:[]};
  const registry=createOwnerLaunchRegistry(storage,projectId,{});
  const service=createExperimentalPiOwnerLaunch({root,home,agentDir,runtime,registry,target:'frontdesk',isCurrent:()=>true});
  const budget=new AgentProcessBudget({limit:2});
  t.after(async()=>{try{await session.child?.waitForExitAndDrain?.({timeoutMs:1000});}catch{}try{session.child?.close?.();}catch{}try{service.close();}catch{}await storage.db.close();await fs.rm(root,{recursive:true,force:true}).catch(()=>{});});
  const session=new PiSession({role:'frontdesk',home,cwd:content,registeredOwnerLaunch:service,piRuntime:runtime,model:'local-fixture/scripted',tools:[]});
  budget.bind(budget.reserve(projectId,'frontdesk'),session);
  await assert.rejects(session.start(),error=>['PI_RUNTIME_EXITED','PI_RUNTIME_ERROR','PI_PROTOCOL_INVALID'].includes(error.code));
  // Install the unsettled projection before the single-flight stop begins.
  session.enqueueNative(()=>new Promise(()=>{}));
  assert.equal(budget.used,1,'unconfirmed slot is retained, never fake-released');
  const stuckBegan=Date.now();
  await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});
  const stuckElapsed=Date.now()-stuckBegan;
  assert.ok(stuckElapsed<40000,`stuck failed-start cleanup must stay within one deadline (took ${stuckElapsed}ms)`);
  assert.equal(session.lastExitReceipt.confirmationComplete,false);
  assert.equal(session.lastExitReceipt.projection,'unknown','unbounded projection outcome recorded on the exit receipt');
  assert.equal(budget.used,1,'unconfirmed slot is retained, never fake-released');
  const row=await registry.read('frontdesk');
  assert.ok(row&&row.value,'original owner registration identity survives until exact retirement');
  assert.equal(row.value.phase,'prepared');
});
