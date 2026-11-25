// Actual shared Controller, paused after durable publication handler result
// but before delivery to the original Pi owner. Parent kills this host.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ProjectStorage} from '../../src/main/project-storage.mjs';
import {Controller} from '../../src/agents/managed/controller.mjs';
import {PiSession} from '../../src/agents/managed/pi-session.mjs';
import {AgentProcessBudget} from '../../src/agents/managed/agent-process-budget.mjs';
import {createOwnerLaunchRegistry} from '../../src/main/owner-launch-registry.mjs';
import {createWindowsDesktopWorkspaceIO} from '../../src/platform/windows/experimental-workspace-io.mjs';
import {managedRuntime} from '../../src/agents/managed/managed-storage.mjs';
import {createExperimentalPiOwnerLaunch} from '../../src/platform/windows/experimental-pi-owner-launch.mjs';
import {createExperimentalWindowsPersistence} from '../../src/platform/windows/experimental-persistence.mjs';
import {ensureExperimentalPrivateDirectory} from '../../src/platform/windows/experimental-directories.mjs';
import {windowsProductionManagedEntry} from '../../src/agents/managed/windows-production-entry.mjs';

const i=JSON.parse(await fs.readFile(process.argv[2],'utf8')),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const storage=new ProjectStorage(i.profile,{windowsDesktopProjects:true}),runtime=await managedRuntime(storage,i.projectId);
const manifest=JSON.parse(await fs.readFile(path.join(i.piRoot,'runtime-manifest.json'),'utf8'));
const base={command:process.execPath,commandSha256:sha(await fs.readFile(process.execPath)),entry:path.join(i.piRoot,'src/owner.mjs'),entrySha256:manifest.files['src/owner.mjs'],nativeTools:[]};
const budget=new AgentProcessBudget({limit:3});let controller,held=false,readyTask;
const production=i.productionAgentDir?await windowsProductionManagedEntry({storage,projectId:i.projectId,piRuntime:{...base,agentDir:i.productionAgentDir}}):null;
controller=await Controller.open({storage,projectId:i.projectId,runtimeRoot:runtime,contentRoot:i.content,
  workspaceIO:production?.workspaceIO??createWindowsDesktopWorkspaceIO({storage}),processBudget:budget,
  piRuntime:{...base,roleDefaultsFor:async()=>({selector:'local-fixture/scripted',effort:'off'})},
  ownerLaunchFactory:production?.ownerLaunchFactory??(spec=>{
    const agentDir=path.join(spec.home,'config');return createExperimentalPiOwnerLaunch({...spec,root:i.profile,agentDir,runtime:{...base,agentDir},
      registry:createOwnerLaunchRegistry(storage,i.projectId,{hostLease:spec.hostLease}),supervise:true});
  })});
await controller.store.setDraft('frontdesk','原始未发送草稿');await controller.store.setDraft('orchestrator','保留草稿，不派工');
const work=await controller.store.submit('将 baseline 改为 cold receipt，只发布候选','仅修改正文.md，原项目等待用户接受。');await controller.store.activate(work.id);
for(const target of (production?[]:['frontdesk','orchestrator',work.id])){
  const home=target===work.id?controller.store.agentHome(work.id):path.join(controller.store.root,'agents',`resident-${target}-pi`),config=path.join(home,'config');
  await ensureExperimentalPrivateDirectory(i.profile,config);
  await createExperimentalWindowsPersistence(i.profile).writeAtomic(path.relative(i.profile,path.join(config,'models.json')).split(path.sep).join('/'),JSON.stringify({providers:{'local-fixture':{baseUrl:i.provider,api:'openai-completions',apiKey:'synthetic-local-only',models:[{id:'scripted',name:'Scripted',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}]}}}));
}
try{await controller.start();}catch(error){
 console.error('Original Controller startup failure:',error);
 for(const [target,session] of controller.sessions){
  let supervisor;
  try{supervisor=session.child?.supervisor?.snapshot();}catch(error){supervisor={error:error.code??error.message};}
  console.error('Original owner launch failure:',target,session.launchError,session.startError,JSON.stringify({
   exit:session.exit,spawnError:session.spawnError?.code,protocolError:session.protocolError?.code,
   nativeError:session.nativeError?.code,diagnostics:session.diagnostics,supervisor,
  }));
 }
 throw error;
}
// Install on sessions before the scheduler's first actual tool result. This
// drops delivery only; real onTool and both durable custody writes still run.
const factory=controller.sessionFactory;
const prepare=controller.execution.prepare.bind(controller.execution);
controller.execution.prepare=async(...args)=>{
  try{return await prepare(...args);}
  catch(error){console.error('Synthetic Worker preparation failure:',error);throw error;}
};
controller.sessionFactory=(spec,target)=>{
  if(factory)throw Error('Unexpected fixture session factory');
  // The shared Controller already installed its registered owner service.
  const session=new PiSession(spec),write=session.write.bind(session);
  session.write=frame=>{
    if(target===work.id&&!frame.method&&frame.result?.saved===true){
      readyTask=fs.writeFile(i.ready,JSON.stringify({workId:work.id,jobId:session.current.job.id,launchId:session.launchRegistration.record.launchId,sessionId:session.threadId}));held=true;return;
    }
    return write(frame);
  };return session;
};
await controller.send(work.id,'执行并发布候选，等待人工审阅',{requestKey:'synthetic-cold-business'});
const deadline=performance.now()+120000;
while(!held){if(performance.now()>deadline)throw Error('Real Controller publication did not reach reply hold: '+JSON.stringify(controller.store.state.jobs));await delay(10);}
await readyTask;
for(;;)await delay(1000);
