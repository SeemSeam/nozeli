// Opt-in execution qualification, not a green-only regression: records unmet
// product acceptance separately from harness failures. Real private Pi, Git,
// bash and loopback HTTP; scripted responses are NOT model reasoning evidence.
// Run: node tests/service-fault-native-live.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {resolveBundledPiRuntime} from '../src/agents/managed/pi-runtime.mjs';
import {createNozeliPiSource} from '../src/agents/managed/pi-source.mjs';
import {PiSettingsWorker} from '../src/agents/managed/pi-auth.mjs';
import {ProviderSettings} from '../src/agents/managed/provider-settings.mjs';
import {runGit} from '../src/agents/managed/git-runtime.mjs';
import {until} from './agent-control.fixture.mjs';
import {serve} from './pi-provider.fixture.mjs';

const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-service-fault-native-'));
const report={out,harnessOk:false,acceptancePassed:false,scope:'Real private native Pi + DesktopHost/ManagedProjects + Git/worktrees/bash + actual loopback HTTP errors. Scripted provider only; no paid model, personal credentials or reasoning claim.',scenarios:[]};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const textOf=request=>request.messages.map(message=>typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('\n')).join('\n');
const defaults=model=>Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{model:{mode:'explicit',selector:'fault-local/'+model},thinking:{mode:'native-default'}}]));
async function scenario(status,type){
  const dir=path.join(out,String(status)),root=path.join(dir,'project'),config=path.join(dir,'private'),profile=path.join(config,'desktop');
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'paper.txt'),'Synthetic source, never accepted automatically.\n');
  await fs.writeFile(path.join(root,'.gitignore'),'/.nozeli/\n/build/\n');
  for(const args of [['init','-b','main'],['config','user.name','Synthetic Fault'],['config','user.email','fault@localhost'],['add','--all'],['commit','-m','Synthetic baseline']])await runGit(root,args);
  const row={status,type,dir,http:[],acceptanceFailures:[],resolutionActor:'test harness simulating user via real ProviderSettings and managed fault/control APIs; NOT an Orchestrator repair'};
  report.scenarios.push(row);
  let recovered=false,effectIssued=false,manager,worker,settings;
  const provider=await serve(async request=>{
    assert(provider.requests.length<32,'bounded HTTP flow');
    const names=request.tools?.map(tool=>tool.function?.name)??[];
    if(names.includes('nozeli_dispatch')&&/SERVICE-FAULT/.test(textOf(request))){row.http.push({status:200,role:'orchestrator',model:request.model});return {id:'dispatch-'+status,tool:'nozeli_dispatch',args:{name:'Fault '+status,brief:'SERVICE-FAULT '+status+': append exactly one line to effect.log using native bash, then publish the result. Never replay a completed effect.'}};}
    if(names.includes('nozeli_publish')){
      if(!effectIssued){effectIssued=true;row.http.push({status:200,role:'worker',kind:'bash',model:request.model});return {id:'effect-'+status,tool:'bash',args:{command:"printf 'exactly-once\\n' >> effect.log"}};}
      if(!recovered){row.http.push({status,role:'worker',kind:'fault',model:request.model});return {status,error:{type,code:type,message:type}};}
      row.http.push({status:200,role:'worker',kind:'publish',model:request.model});return {id:'publish-'+status,tool:'nozeli_publish',args:{kind:'result',content:'<h1>Same task continued</h1><p>The prior effect was not repeated.</p>',files:[]}};
    }
    row.http.push({status:200,role:'other',model:request.model});return {text:'Host receipts remain authoritative.'};
  });
  const host=new DesktopHost(profile);
  try{
    const project=await host.requireRegisteredProject((await host.pick(root)).project.id);
    const source=createNozeliPiSource({root:config});
    const runtime=await resolveBundledPiRuntime({piHome:source.agentDir});
    worker=new PiSettingsWorker({runtime,source});
    settings=new ProviderSettings({source,worker,onDefaultsSaved:next=>manager?.applyModelDefaults(next),onSourceSaved:(provider,info)=>manager?.applyProviderUpdate(provider,info)});
    source.modelFor=role=>settings.modelFor(role);source.roleDefaultsFor=role=>settings.roleDefaultsFor(role);
    await settings.saveApi({operation:'create',provider:'fault-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'},{id:'recovered'}],credential:{action:'replace',value:'local-nonsecret'}});
    await settings.saveDefaults(defaults('scripted'));
    manager=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},piSource:source,piRuntime:runtime,piAuth:worker,serviceFaultBackoffMs:50});
    await manager.processBudget.save(4);await manager.connect(project.id,{enable:true});
    const input=await manager.invoke('managed.task',{projectId:project.id,text:'SERVICE-FAULT '+status+': perform the real exactly-once append, then publish.',requestKey:'service-fault-'+status});
    row.input=input;
    const state=async()=>(await manager.invoke('managed.status',{projectId:project.id})).state;
    const failed=await until(async()=>{const s=await state(),w=s.works.find(w=>w.name==='Fault '+status);const j=w&&s.jobs.find(j=>j.target===w.id&&j.status==='failed');return j?{work:w,job:j}:null;},'settled native HTTP '+status,120000);
    row.before=failed;row.faultBefore=await manager.invoke('managed.fault.status',{});
    row.durableFaultBefore=await host.storage.getLocal(project.id,'managed:service-faults');
    const effectFile=path.join(failed.work.execution.directory,'effect.log');
    const effectCount=async()=>(await fs.readFile(effectFile,'utf8')).trim().split('\n').filter(Boolean).length;
    row.effectsBefore=await effectCount();assert.equal(row.effectsBefore,1);
    const settledCount=provider.requests.length;await pause(500);assert.equal(provider.requests.length,settledCount,'no hot loop after settled refusal');
    row.retryCount=row.http.filter(h=>h.kind==='fault').length-1;
    row.recursiveOrchestratorSpawns=(await state()).jobs.filter(j=>j.target==='orchestrator').length-1;
    assert.equal(row.http.filter(h=>h.role==='orchestrator').length,1,'provider failure never recursively spawns Orchestrator');
    const fault=row.faultBefore.faults.find(f=>f.projects.some(p=>p.projectId===project.id));
    if(!fault)row.acceptanceFailures.push('HTTP '+status+' has no service fault card/report or resolution capability');
    else {row.classification=fault.category;assert.equal(fault.category,status===402?'balance':status===429?'quota':'service-transient');assert.equal(fault.userCritical,true,'post-entry fault requires user reconciliation');}
    // External cause removal is explicitly attributed to the simulated user.
    recovered=true;
    row.settingsResolution=await settings.saveApi({operation:'update',provider:'fault-local',expectedRevision:1,baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'},{id:'recovered'}],credential:{action:'replace',value:'local-recovered-nonsecret'}});
    if(status===404)row.modelResolution=await settings.saveDefaults(defaults('recovered'));
    if(fault?.release?.available){
      const fresh=(await manager.invoke('managed.fault.status',{})).faults.find(f=>f.faultRef===fault.faultRef);
      row.release=await manager.invoke('managed.fault.release',{faultRef:fresh.faultRef,expectedVersion:fresh.release.expectedVersion,scopeSnapshot:fresh.release.scopeSnapshot,requestKey:'service-release-'+status});
      row.releaseResults=await manager.invoke('managed.fault.results',{batchRef:row.release.batchRef});
    }
    const caps=await manager.invoke('managed.work.control.status',{projectId:project.id,workId:failed.work.id});
    row.controlCapabilities=caps;
    if(caps.resume.allowed)row.resume=await manager.invoke('managed.work.control',{projectId:project.id,workId:failed.work.id,action:'resume',requestKey:'service-resume-'+status,expectedProjectInstanceId:project.instanceId,expectedControlVersion:caps.controlVersion,expectedWorkRevision:caps.workRevision});
    await until(()=>!manager.busy(),'resolution settles');await pause(500);
    const after=await state();row.after={work:after.works.find(w=>w.id===failed.work.id),job:after.jobs.find(j=>j.id===failed.job.id)};
    row.effectsAfter=await effectCount();row.httpRequestCount=provider.requests.length;
    row.faultAfter=await manager.invoke('managed.fault.status',{});
    row.durableFaultAfter=await host.storage.getLocal(project.id,'managed:service-faults');
    assert.equal(row.effectsAfter,1,'no completed bash side-effect replay');
    assert.equal(row.after.work.threadId,failed.work.threadId,'native thread retained');
    assert.ok(failed.job.delivery?.requestId,'native request identity exists');
    assert.equal(row.after.job.delivery.requestId,failed.job.delivery.requestId,'native request identity retained');
    assert.deepEqual(row.after.job.collabAttempts,failed.job.collabAttempts,'no new native attempt or replay');
    row.identities={workId:failed.work.id,threadId:failed.work.threadId,jobId:failed.job.id,requestId:failed.job.delivery.requestId,inputJobId:input.jobId,inputRequestKey:'service-fault-'+status};
    row.sameTaskContinued=row.after.work.status==='review'&&row.after.job.status==='completed';
    if(!row.sameTaskContinued)row.acceptanceFailures.push('After actual provider/settings resolution, same admitted failed job does not continue: original work/thread/job/request preserved but no native continuation is exposed by the resolution API. For classified faults release returns needs-reconciliation; 404 has no fault release capability. No synthetic new input or replay attempted.');
    row.sourceUnchanged=(await fs.readFile(path.join(root,'paper.txt'),'utf8'))==='Synthetic source, never accepted automatically.\n';assert(row.sourceUnchanged);
    assert.deepEqual(provider.errors,[]);
    await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(after,null,2));
  }catch(error){row.harnessError=error.stack;throw error;}
  finally{await manager?.stop();await settings?.stop();await worker?.stop();await provider.close();await host.storage.db.close();await fs.writeFile(path.join(dir,'fault-report.json'),JSON.stringify(row,null,2));}
}
try{for(const [status,type]of [[404,'model_not_found'],[402,'insufficient_balance'],[429,'insufficient_quota'],[503,'service_unavailable']])await scenario(status,type);report.harnessOk=true;report.acceptancePassed=report.scenarios.every(row=>row.acceptanceFailures.length===0);if(!report.acceptancePassed)process.exitCode=1;}
catch(error){report.error=error.stack;process.exitCode=1;}
finally{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,harnessOk:report.harnessOk,acceptancePassed:report.acceptancePassed,scenarios:report.scenarios.map(row=>({status:row.status,httpRequestCount:row.httpRequestCount,retryCount:row.retryCount,effectsAfter:row.effectsAfter,sameTaskContinued:row.sameTaskContinued,acceptanceFailures:row.acceptanceFailures,harnessError:row.harnessError}))},null,2));}
