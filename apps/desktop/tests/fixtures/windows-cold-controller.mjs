// Shared real Controller harness for repeated abrupt-host recovery fixtures.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Controller} from '../../src/agents/managed/controller.mjs';
import {AgentProcessBudget} from '../../src/agents/managed/agent-process-budget.mjs';
import {windowsProductionManagedEntry} from '../../src/agents/managed/windows-production-entry.mjs';
import {managedRuntime} from '../../src/agents/managed/managed-storage.mjs';

export async function openColdController(i,storage,token){
 const manifest=JSON.parse(await fs.readFile(path.join(i.piRoot,'runtime-manifest.json'),'utf8'));
 const base={command:process.execPath,commandSha256:createHash('sha256').update(await fs.readFile(process.execPath)).digest('hex'),
  entry:path.join(i.piRoot,'src/owner.mjs'),entrySha256:manifest.files['src/owner.mjs'],nativeTools:[]};
 const entry=await windowsProductionManagedEntry({storage,projectId:i.projectId,piRuntime:base,previousColdHandoff:token});
 const services=entry.services,budget=new AgentProcessBudget({limit:3});
 try{
  const controller=await Controller.open({storage,projectId:i.projectId,runtimeRoot:await managedRuntime(storage,i.projectId),contentRoot:i.content,
   workspaceIO:entry.workspaceIO,processBudget:budget,
   piRuntime:{...base,roleDefaultsFor:async()=>({selector:'local-fixture/scripted',effort:'off'})},
   ownerLaunchFactory:entry.ownerLaunchFactory});
  return {controller,budget,services};
 }catch(error){for(const service of services)service.close();throw error;}
}
