// Cross-process custody oracle: a durably completed normal release authorizes
// a fresh host lease, while an abruptly abandoned active generation stays fenced.
import fs from 'node:fs/promises';
import {ProjectStorage} from '../../src/main/project-storage.mjs';
import {acquireExperimentalHostLease} from '../../src/platform/windows/experimental-host-lease.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {DesktopHost} from '../../src/main/host.mjs';
import {ManagedProjects} from '../../src/agents/managed-projects.mjs';
import {resolveBundledPiRuntime} from '../../src/agents/managed/pi-runtime.mjs';
import {createNozeliPiSource} from '../../src/agents/managed/pi-source.mjs';
import {ProviderSettings} from '../../src/agents/managed/provider-settings.mjs';

const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const storage=new ProjectStorage(input.profile,{windowsDesktopProjects:true});
if(input.retiredProjectId){
  const host=new DesktopHost(input.profile),piSource=createNozeliPiSource({root:input.nozeliRoot});
  const settings=new ProviderSettings({source:piSource});
  piSource.roleDefaultsFor=role=>settings.roleDefaultsFor(role);piSource.modelFor=role=>settings.modelFor(role);
  const resolved=await resolveBundledPiRuntime({packaged:process.env.NOZELI_TEST_PACKAGED_APP==='1',piHome:path.join(input.nozeliRoot,'pi'),...(process.env.NOZELI_TEST_PI_ROOT?{env:{...process.env,NOZELI_PI_INTEGRATION_ROOT:path.resolve(process.env.NOZELI_TEST_PI_ROOT)}}:{})});
  const manager=new ManagedProjects({userDataDir:input.profile,host,legacy:{projects:new Map()},piSource,piRuntime:{...resolved,args:resolved.args.filter(value=>value!==resolved.entry)},idleTimeoutMs:3600000});
  try{
    assert.equal((await manager.invoke('managed.enable',{projectId:input.retiredProjectId})).ready,true);
    const controller=manager.controllers.get(input.retiredProjectId),facts=controller.store.hostLease.facts();
    assert.equal(controller.store.state.drafts.frontdesk,'重启必须保留的未发送草稿');
    const before=controller.store.state.jobs.map(row=>({id:row.id,status:row.status}));
    await manager.invoke('managed.send',{projectId:input.retiredProjectId,target:'frontdesk',text:'WINDOWS_NORMAL_RESTART_NEW_INPUT',requestKey:'normal-restart-new-input'});
    const end=Date.now()+90000;let job;
    while(Date.now()<end){job=controller.store.state.jobs.find(row=>row.requestKey==='normal-restart-new-input'||row.text==='WINDOWS_NORMAL_RESTART_NEW_INPUT');if(job?.status==='failed')throw Error('New normal-restart input failed: '+job.errorCode);if(job?.status==='completed')break;await delay(25);}
    assert.equal(job?.status,'completed');
    for(const old of before)assert.equal(controller.store.state.jobs.find(row=>row.id===old.id)?.status,old.status);
    assert.equal((await manager.stopProject(input.retiredProjectId)).confirmationComplete,true);
    await fs.writeFile(input.retiredProof,JSON.stringify({normalRestart:true,phase:facts.phase,newInputCompleted:true,automaticReplay:false}));
  }finally{await manager.stop();await host.storage.db.close();}
}
const lease=await acquireExperimentalHostLease({storage,projectId:input.crashProjectId});
const facts=lease.facts();
await fs.writeFile(input.ready,JSON.stringify({leaseId:facts.leaseId,phase:facts.phase,projectId:input.crashProjectId}));
// Abrupt death without release: the active record, anchor and any retained
// custody stay exactly as the crashed host left them.
process.exit(87);
