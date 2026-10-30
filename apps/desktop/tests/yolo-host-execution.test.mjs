import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {TaskPermissions} from '../src/agents/managed/task-permissions.mjs';

// The real controller resolves and hashes the current Node executable. The
// broker records the boundary only: these tests never launch an OS command or
// claim that fixture identity facts establish real administrator privileges.
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-yolo-host-execution-'));
  let controller;
  t.after(async()=>{try{await controller?.stop();}finally{await fs.rm(dir,{recursive:true,force:true});}});
  const root=path.join(dir,'project'),cwd=path.join(dir,'unregistered-cwd');
  await fs.mkdir(root);await fs.mkdir(cwd);
  const host=new DesktopHost(path.join(dir,'profile'));
  const project=(await host.pick(root)).project;
  const permissions=new TaskPermissions(host.storage);
  const calls={authenticate:[],execute:[]};
  const actualIdentity={uid:1000,source:'synthetic-broker-fixture'};
  const privilegeBroker={
    async capabilities(){return {platform:process.platform,elevationAvailable:true,authMethod:'fixture'};},
    async authenticate(input){calls.authenticate.push(input);return {status:'authenticated',sessionId:'synthetic-auth-session',actualIdentity};},
    async execute(input){calls.execute.push(input);return {status:'completed',exitCode:0,executionId:'synthetic-execution-'+calls.execute.length,actualIdentity};},
  };
  controller=await Controller.open({storage:host.storage,projectId:project.id,runtimeRoot:path.join(dir,'runtime'),contentRoot:root,localOnly:true,taskPermissions:permissions,privilegeBroker,resolveProjectRoot:async()=>null,sessionFactory:()=>{throw Error('execution boundary tests must not start a model');}});
  const job={id:randomUUID(),target:'frontdesk',type:'front',status:'running',text:'Run the requested current-user command in the external directory',context:{}};
  await controller.store.mutate(()=>controller.store.state.jobs.push(job));
  const execute=(callId,extra={})=>controller.privilegedExecute(job,'frontdesk',{tool:'nozeli_privileged_execute',callId,arguments:{command:process.execPath,args:['--version'],cwd,purpose:'Read the runtime version',...extra}});
  const ledger=()=>permissions.read(project.id);
  return {controller,permissions,project,cwd,job,calls,actualIdentity,execute,ledger};
}

const value=result=>{assert.equal(result.ok,true,JSON.stringify(result));return result.value;};

test('ordinary controller host execution uses explicit default-yolo authority without permission requests',async t=>{
  const f=await fixture(t);
  const result=value(await f.execute('ordinary-one'));
  assert.equal(result.executed,true);
  assert.equal(result.status,'completed');
  assert.equal(result.exitCode,0);
  assert.equal(result.root,false);
  assert.deepEqual(result.actualIdentity,f.actualIdentity);
  assert.equal(f.calls.authenticate.length,1);
  assert.equal(f.calls.authenticate[0].elevation,'user');
  assert.equal(f.calls.execute.length,1);
  const frozen=f.calls.execute[0].frozenEffect;
  assert.equal(frozen.command,process.execPath);
  assert.deepEqual(frozen.args,['--version']);
  assert.equal(frozen.cwd,f.cwd);
  assert.equal(frozen.elevation,'user');
  assert.match(frozen.commandDigest,/^[a-f0-9]{64}$/);
  assert.ok(frozen.cwdIdentity);
  const state=await f.ledger();
  assert.equal(state.requests.length,0);
  assert.equal(state.grants.length,1);
  assert.equal(state.grants[0].authority,'default-yolo');
  assert.equal(state.grants[0].permissionTaskId,f.job.id);
  assert.equal(state.grants[0].expiresAt,null);
  assert.equal(state.executions.length,1);
  assert.equal(state.executions[0].status,'completed');
  assert.equal(state.executions[0].operationKey,'ordinary-one');
  assert.equal(state.executions[0].effectHash,result.effectHash);
  assert.equal(f.controller.store.state.todos.filter(todo=>todo.kind==='effect-permission'&&todo.status==='open').length,0);
});

test('duplicate ordinary callId returns the persisted execution receipt without authenticating or executing again',async t=>{
  const f=await fixture(t);
  const first=value(await f.execute('ordinary-duplicate'));
  const replay=value(await f.execute('ordinary-duplicate'));
  assert.equal(replay.replayed,true);
  assert.equal(replay.receiptId,first.receiptId);
  assert.equal(replay.effectHash,first.effectHash);
  assert.equal(replay.exitCode,first.exitCode);
  assert.deepEqual(replay.actualIdentity,first.actualIdentity);
  assert.equal(f.calls.authenticate.length,1);
  assert.equal(f.calls.execute.length,1);
  const state=await f.ledger();
  assert.equal(state.requests.length,0);
  assert.equal(state.executions.length,1);
  // A deliberately new host operation is not a duplicate, even with the same argv.
  value(await f.execute('ordinary-deliberate-rerun'));
  assert.equal(f.calls.execute.length,2);
  assert.equal((await f.ledger()).executions.length,2);
});

test('admin execution mints a permission request before any broker effect and a denial remains binding',async t=>{
  const f=await fixture(t);
  const pending=await f.execute('admin-pending',{elevation:'admin'});
  assert.equal(pending.ok,false);
  assert.equal(pending.error.code,'PERMISSION_REQUIRED');
  assert.equal(pending.userDecisionRequired,true);
  assert.equal(pending.error.attention.kind,'effect-permission');
  assert.equal(f.calls.authenticate.length,0);
  assert.equal(f.calls.execute.length,0);
  let state=await f.ledger();
  assert.equal(state.requests.length,1);
  assert.equal(state.requests[0].status,'pending');
  assert.equal(state.requests[0].frozenEffect.elevation,'admin');
  assert.equal(state.grants.length,0);
  assert.equal(state.executions.length,0);
  const denied=await f.controller.resolveEffectRequest({requestId:pending.error.requestId,expectedVersion:pending.error.attention.version,action:'deny',requestKey:'yolo-admin-deny'});
  assert.equal(denied.accepted,true);
  assert.equal(denied.continued,false);
  const retry=await f.execute('admin-after-denial',{elevation:'admin'});
  assert.equal(retry.ok,false);
  assert.equal(retry.error.code,'PERMISSION_DENIED');
  assert.equal(f.calls.authenticate.length,0);
  assert.equal(f.calls.execute.length,0);
  state=await f.ledger();
  assert.equal(state.requests.length,1);
  assert.equal(state.requests[0].status,'denied');
  assert.equal(state.executions.length,0);
});

test('revoking a default-yolo grant closes new ordinary admission without undoing or repeating completed effects',async t=>{
  const f=await fixture(t);
  const first=value(await f.execute('ordinary-before-revoke'));
  const before=await f.ledger();
  const grant=before.grants.find(item=>item.authority==='default-yolo');
  assert.ok(grant);
  const revoked=await f.permissions.revokeGrant(f.project.id,{grantId:grant.id});
  assert.equal(revoked.admissionRevoked,true);
  const retry=await f.execute('ordinary-after-revoke');
  assert.equal(retry.ok,false);
  assert.equal(retry.error.code,'EFFECT_REVOKED');
  assert.equal(f.calls.authenticate.length,1);
  assert.equal(f.calls.execute.length,1);
  const replay=value(await f.execute('ordinary-before-revoke'));
  assert.equal(replay.replayed,true);
  assert.equal(replay.receiptId,first.receiptId);
  const after=await f.ledger();
  assert.equal(after.requests.length,0);
  assert.equal(after.grants.length,1);
  assert.equal(after.grants[0].status,'revoked');
  assert.equal(after.executions.length,1);
  assert.equal(after.executions[0].status,'completed');
});
