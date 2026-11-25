import assert from 'node:assert/strict';
import path from 'node:path';
import {ProjectStorage} from '../../src/main/project-storage.mjs';
import {Workspace} from '../../src/agents/managed/workspace.mjs';
import {managedRuntime} from '../../src/agents/managed/managed-storage.mjs';
import {createWindowsDesktopWorkspaceIO} from '../../src/platform/windows/experimental-workspace-io.mjs';
const [profile,projectId,previousLeaseId]=process.argv.slice(2),storage=new ProjectStorage(profile,{windowsDesktopProjects:true});
try{
  const project=await storage.requireOnline(projectId);
  // Fresh process with no serialized receipt: only the durable terminal
  // normal-release publication of the exact retired generation may authorize
  // this reopen, with a fresh host lease and no draft/Work replay.
  const store=await Workspace.open(await managedRuntime(storage,projectId),project.root,{storage,projectId,workspaceIO:createWindowsDesktopWorkspaceIO({storage})});
  const facts=store.hostLease.facts();
  assert.notEqual(facts.leaseId,previousLeaseId);assert.equal(facts.phase,'active');assert.equal(facts.coldRecoveryQualified,false);
  const database=path.join(await storage.localDirectory(projectId),'ui.sqlite');
  const completion=await storage.db.request(database,'record',{collection:'managed_host_release_completions:'+previousLeaseId,id:previousLeaseId+':normal-release'});
  assert.equal(completion?.value.durableRestartAuthority,true);assert.equal(completion.value.automaticReplay,false);
  assert.equal(store.state.drafts.frontdesk,'冷启动必须保留的未发送草稿');
  assert.equal((store.state.jobs??[]).length,0);
  assert.equal((await store.close()).record.phase,'retired');
  console.log(JSON.stringify({durableRestart:true,freshHost:true,completionVerified:true,draftRetained:true,automaticReplay:false}));
}finally{
  assert(!(await storage.db.close()).some(value=>value?.closed===false),'Native workers must stop before fixture exit');
}
