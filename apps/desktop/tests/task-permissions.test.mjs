import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {TaskPermissions,effectHash,normalizeExecutionEffect} from '../src/agents/managed/task-permissions.mjs';
import winPath from 'node:path/win32';
import posixPath from 'node:path/posix';
import {createFrontdeskDocuments} from '../src/agents/managed/frontdesk-documents.mjs';
import {createPrivilegeBroker} from '../src/main/privilege-broker.mjs';
const wait=async fn=>{const end=Date.now()+4000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('condition timeout');};
const readTool=(projectPath,relPath,callId)=>({tool:'nozeli_document_read',arguments:{relPath,projectPath},callId});
const REAL=process.execPath;
const execTool=(_command,args,cwd,purpose,elevation)=>({tool:'nozeli_privileged_execute',arguments:{command:REAL,args,cwd,purpose,...(elevation?{elevation}:{})},callId:randomUUID()});
// Broker fixture: records every authenticate/execute call; never performs real
// OS work. Identity facts are fixture facts, exactly like the adapter fixture
// of the live smoke — they prove plumbing, not real root.
function brokerFixture(behavior={}){
  const calls={authenticate:[],execute:[],capabilities:0};
  return {calls,broker:{
    capabilities:async()=>{calls.capabilities++;return {platform:process.platform,elevationAvailable:true,authMethod:'fixture',currentIdentity:{uid:1000,source:'fixture'}};},
    authenticate:async p=>{calls.authenticate.push(p);return behavior.authenticate?behavior.authenticate(p):{status:'authenticated',sessionId:'fixture-session',actualIdentity:{uid:1000,source:'fixture-probe'}};},
    execute:async p=>{calls.execute.push(p);return behavior.execute?behavior.execute(p):{executionId:'fx-'+(calls.execute.length),status:'completed',exitCode:0,actualIdentity:{uid:1000,source:'fixture-probe'}};},
  }};
}
async function fixture(t,{broker=null}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-effectperm-'));let c,settle,rejectTurn;
  const rootA=path.join(dir,'a'),rootB=path.join(dir,'b');
  await fs.mkdir(path.join(rootA,'sub'),{recursive:true});await fs.mkdir(path.join(rootB,'sub'),{recursive:true});
  await fs.writeFile(path.join(rootA,'calc.js'),'module.exports=1;\n');
  await fs.writeFile(path.join(rootB,'notes.txt'),'B 项目笔记：跨项目只读内容\n');
  await fs.writeFile(path.join(rootB,'sub','x.txt'),'子目录内容\n');
  const host=new DesktopHost(path.join(dir,'profile'));
  const A=(await host.pick(rootA)).project,B=(await host.pick(rootB)).project;
  const permissions=new TaskPermissions(host.storage);
  const registry=async()=>(await host.recent())?.projects??[];
  const resolveRegisteredProject=async value=>{
    const match=(await registry()).find(project=>project.id===value||project.rootDisplay===value);
    if(!match)throw Object.assign(new Error('目标项目未登记：请用户先在项目列表选择并注册该目录；不会自动注册未知目录。'),{code:'UNKNOWN_PROJECT'});
    if(match.available===false)throw Object.assign(new Error('目标项目目录当前不可用。'),{code:'PROJECT_ROOT_MISSING'});
    return {projectId:match.id,name:match.name,root:match.rootDisplay};
  };
  const resolveProjectRoot=async absolutePath=>{
    if(typeof absolutePath!=='string'||!absolutePath.startsWith('/'))return null;
    const normalized=absolutePath.split('/').filter(Boolean);let best=null,depth=-1;
    for(const project of await registry()){
      if(project.available===false)continue;
      const root=String(project.rootDisplay).split('/').filter(Boolean);
      if(root.length>normalized.length||root.some((part,index)=>normalized[index]!==part))continue;
      if(root.length>depth){best=project;depth=root.length;}
    }
    return best?{projectId:best.id,name:best.name,root:best.rootDisplay}:null;
  };
  class Session { async preflightToolsDigest() {} async assertToolsDigest() {} constructor(spec,target){Object.assign(this,spec,{target,busy:false,closed:false});}async start(id){this.threadId=id||randomUUID();return this;}async stop(){this.closed=true;rejectTurn?.(Error('stopped'));}async interrupt(){return {requested:true};}
    async prompt(){this.busy=true;try{
      if(this.target==='frontdesk')return await new Promise((resolve,reject)=>{settle=()=>resolve({text:'回合结束',metrics:{tokens:null,tokenCompleteness:'unavailable'},threadId:this.threadId,completion:'user-transfer',providerStatus:'interrupted'});rejectTurn=reject;});
      await this.onTool({tool:'nozeli_manage',arguments:{action:'clarify',workName:'',text:'后台任务已接收；请补充验收标准'},callId:randomUUID()});
      return {text:'',completion:'host-control',threadId:this.threadId};
    }finally{this.busy=false;}}}
  const options={storage:host.storage,projectId:A.id,runtimeRoot:path.join(dir,'runtime-a'),contentRoot:rootA,projectHome:home=>fs.mkdir(home,{recursive:true}),sessionFactory:(spec,target)=>new Session(spec,target),frontdeskDocuments:createFrontdeskDocuments({host,projectId:A.id,sync:async()=>()=>{}}),taskPermissions:permissions,resolveRegisteredProject,resolveProjectRoot,...(broker?{privilegeBroker:broker}:{})};
  c=await Controller.open(options);await c.start();
  t.after(async()=>{await c.stop().catch(()=>{});await fs.rm(dir,{recursive:true,force:true});});
  const endTurn=async()=>{const current=c.current.get('frontdesk');if(!current)return;settle();await wait(()=>c.current.get('frontdesk')!==current);};
  const openTurn=async text=>{await endTurn();const r=await c.send('frontdesk',text);await wait(()=>c.sessions.get('frontdesk').busy&&c.current.get('frontdesk'));return c.current.get('frontdesk');};
  const runApproved=async decision=>{await endTurn();await wait(()=>c.current.get('frontdesk')&&c.current.get('frontdesk').id===decision.jobId&&c.sessions.get('frontdesk').busy);return c.current.get('frontdesk');};
  return {c,host,A,B,permissions,rootA,rootB,openTurn,endTurn,runApproved};
}
test('ordinary cross-project document access runs directly with receipts, CAS and credential exclusions intact',async t=>{
  const {c,A,B,openTurn}=await fixture(t);
  await openTurn('整理B项目notes并新建summary');
  const read=await c.onTool('frontdesk',readTool(B.id,'notes.txt','call-1'));
  assert.equal(read.ok,true,JSON.stringify(read.error));
  assert.match(read.value.text,/跨项目只读内容/);
  const listing=await c.onTool('frontdesk',{tool:'nozeli_project_list',arguments:{relPath:'',projectPath:B.id},callId:'call-2'});
  assert.equal(listing.ok,true,JSON.stringify(listing.error));
  assert.ok(listing.value.entries.some(e=>e.name==='notes.txt'));
  const create=await c.onTool('frontdesk',{tool:'nozeli_document_create',arguments:{relPath:'summary.md',text:'交叉摘要\n',projectPath:B.id},callId:'call-3'});
  assert.equal(create.ok,true,JSON.stringify(create.error));
  assert.equal(await fs.readFile(path.join(B.rootDisplay,'summary.md'),'utf8'),'交叉摘要\n');
  // Receipts keep the registered-target provenance for cross-project writes.
  const receipt=c.store.state.jobs.flatMap(j=>j.frontdeskOperations||[]).find(r=>r.callId==='call-3');
  assert.equal(receipt.targetProjectId,B.id);
  // Credential/private exclusions still apply on the target project.
  const secret=await c.onTool('frontdesk',readTool(B.id,'secrets/key.pem','call-4'));
  assert.equal(secret.ok,false);assert.equal(secret.error.code,'PATH_REJECTED');
});
test('sensitive effect: approval before zero effect; deny is durable and executes nothing',async t=>{
  const fx=brokerFixture();
  const {c,openTurn,permissions,A}=await fixture(t,{broker:fx.broker});
  await openTurn('需要写入系统级marker文件');
  const first=await c.onTool('frontdesk',execTool(REAL,['--touch','/nozeli-fixture-marker'],A.rootDisplay,'原任务要求创建该标记'));
  assert.equal(first.ok,false);assert.equal(first.error.code,'PERMISSION_REQUIRED');
  assert.equal(first.error.attention.kind,'effect-permission');
  assert.equal(first.hostControl,true);assert.equal(first.userDecisionRequired,true);
  // Zero effect before any user choice.
  assert.equal(fx.calls.execute.length,0);assert.equal(fx.calls.authenticate.length,0);
  const requestId=first.error.requestId;
  const duplicate=await c.onTool('frontdesk',execTool(REAL,['--touch','/nozeli-fixture-marker'],A.rootDisplay,'原任务要求创建该标记'));
  assert.equal(duplicate.error.code,'PERMISSION_REQUIRED');assert.equal(duplicate.error.requestId,requestId);
  assert.equal((await permissions.read(A.id)).requests.length,1);
  const denied=await c.resolveEffectRequest({requestId,expectedVersion:1,action:'deny',requestKey:'attention:'+requestId+':1:deny'});
  assert.equal(denied.accepted,true);assert.equal(denied.continued,false);
  const retry=await c.onTool('frontdesk',execTool(REAL,['--touch','/nozeli-fixture-marker'],A.rootDisplay,'原任务要求创建该标记'));
  assert.equal(retry.ok,false);assert.equal(retry.error.code,'PERMISSION_DENIED');
  assert.equal(fx.calls.execute.length,0);
  assert.equal((await permissions.read(A.id)).requests.find(r=>r.id===requestId).status,'denied');
});
test('approve-once executes exactly once through the broker with the frozen effect',async t=>{
  const fx=brokerFixture();
  const {c,A,openTurn,runApproved,permissions}=await fixture(t,{broker:fx.broker});
  await openTurn('安装后写入配置marker');
  const blocked=await c.onTool('frontdesk',execTool(REAL,['--install','/etc/marker.conf'],A.rootDisplay,'原任务要求安装该配置','admin'));
  assert.equal(blocked.error.code,'PERMISSION_REQUIRED');
  assert.equal(fx.calls.execute.length,0);
  const requestId=blocked.error.requestId;
  const decision=await c.resolveEffectRequest({requestId,expectedVersion:1,action:'approve-once',requestKey:'attention:'+requestId+':1:approve-once'});
  assert.equal(decision.accepted,true);assert.equal(decision.continued,true);assert.ok(decision.grantId);
  await runApproved(decision);
  const run=await c.onTool('frontdesk',execTool(REAL,['--install','/etc/marker.conf'],A.rootDisplay,'原任务要求安装该配置','admin'));
  assert.equal(run.ok,true,JSON.stringify(run.error));
  assert.equal(run.value.executed,true);assert.equal(run.value.exitCode,0);assert.ok(run.value.actualIdentity);
  assert.equal(fx.calls.execute.length,1);
  assert.equal(fx.calls.execute[0].frozenEffect.command,process.execPath);assert.deepEqual(fx.calls.execute[0].frozenEffect.args,['--install','/etc/marker.conf']);assert.equal(fx.calls.execute[0].frozenEffect.action,'admin');assert.equal(fx.calls.execute[0].frozenEffect.elevation,'admin');assert.match(fx.calls.execute[0].frozenEffect.commandDigest,/^[a-f0-9]{64}$/);
  assert.equal(fx.calls.execute[0].grantId,decision.grantId);
  // Grant status is not fake OS root: the receipt's identity facts are the only root claim.
  const state=await permissions.read(A.id);
  const execution=state.executions.find(e=>e.requestId===requestId);
  assert.equal(execution.status,'completed');assert.deepEqual(execution.actualIdentity,{uid:1000,source:'fixture-probe'});
  assert.equal(state.grants.find(g=>g.id===decision.grantId).status,'used');
  // The once-grant is consumed: the same command needs a fresh user decision.
  const again=await c.onTool('frontdesk',execTool(REAL,['--install','/etc/marker.conf'],A.rootDisplay,'原任务要求安装该配置','admin'));
  assert.equal(again.error.code,'PERMISSION_REQUIRED');assert.notEqual(again.error.requestId,requestId);
  assert.equal(fx.calls.execute.length,1);
});
test('failed durable intent prevents an approved real command from creating its target',async t=>{
  const {c,A,rootA,openTurn,runApproved,permissions}=await fixture(t,{broker:createPrivilegeBroker({interpreter:process.execPath})});
  const marker=path.join(rootA,'must-not-exist.txt'),args=['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'unexpected effect')`];
  await openTurn('Create the requested marker only after approval');
  const blocked=await c.onTool('frontdesk',execTool(REAL,args,rootA,'requested marker'));
  const requestId=blocked.error.requestId;
  const decision=await c.resolveEffectRequest({requestId,expectedVersion:1,action:'approve-once',requestKey:'intent-failure:'+requestId});
  await runApproved(decision);
  const record=permissions.recordExecution.bind(permissions);
  permissions.recordExecution=async(...values)=>{if(values[1]?.result?.status==='started')throw Error('disk unavailable');return record(...values);};
  const result=await c.onTool('frontdesk',execTool(REAL,args,rootA,'requested marker'));
  assert.equal(result.error.code,'EFFECT_INTENT_UNAVAILABLE');
  assert.equal(await fs.access(marker).then(()=>true,()=>false),false);
  assert.equal((await permissions.read(A.id)).executions.some(e=>e.status==='completed'),false);
});
test('approve-task re-covers only the same frozen command; revoke closes future admission without reversing effects',async t=>{
  const fx=brokerFixture();
  const {c,A,openTurn,runApproved,permissions}=await fixture(t,{broker:fx.broker});
  await openTurn('重复同步系统状态文件');
  const blocked=await c.onTool('frontdesk',execTool(REAL,['--sync'],A.rootDisplay,'原任务要求多次同步'));
  const requestId=blocked.error.requestId;
  const decision=await c.resolveEffectRequest({requestId,expectedVersion:1,action:'approve-task',requestKey:'attention:'+requestId+':1:approve-task'});
  await runApproved(decision);
  const first=await c.onTool('frontdesk',execTool(REAL,['--sync'],A.rootDisplay,'原任务要求多次同步'));
  assert.equal(first.ok,true,JSON.stringify(first.error));
  const second=await c.onTool('frontdesk',execTool(REAL,['--sync'],A.rootDisplay,'原任务要求多次同步'));
  assert.equal(second.ok,true,JSON.stringify(second.error));
  assert.equal(fx.calls.execute.length,2);
  // A different command is NOT covered by the task grant.
  const other=await c.onTool('frontdesk',execTool(REAL,['--other'],A.rootDisplay,'另一个命令'));
  assert.equal(other.error.code,'PERMISSION_REQUIRED');
  // User revoke: future admission closed, executed effects untouched.
  const revoked=await permissions.revokeGrant(A.id,{grantId:decision.grantId});
  assert.equal(revoked.admissionRevoked,true);assert.deepEqual(revoked.unresolvedExecutionIds,[]);
  const after=await c.onTool('frontdesk',execTool(REAL,['--sync'],A.rootDisplay,'原任务要求多次同步'));
  assert.equal(after.ok,false);assert.equal(after.error.code,'EFFECT_REVOKED');
  assert.equal(fx.calls.execute.length,2);
});
test('settling the original task expires authority before a new input can append again',async t=>{
  const {c,A,rootA,openTurn,endTurn,runApproved,permissions}=await fixture(t,{broker:createPrivilegeBroker({interpreter:process.execPath})});
  const marker=path.join(rootA,'task-marker.txt'),args=['-e',`require('fs').appendFileSync(${JSON.stringify(marker)},${JSON.stringify('once\n')})`];
  await openTurn('Append one task marker');
  const blocked=await c.onTool('frontdesk',execTool(REAL,args,rootA,'task marker'));
  const requestId=blocked.error.requestId;
  const decision=await c.resolveEffectRequest({requestId,expectedVersion:1,action:'approve-task',requestKey:'task-expiry:'+requestId});
  await runApproved(decision);
  assert.equal((await c.onTool('frontdesk',execTool(REAL,args,rootA,'task marker'))).ok,true);
  await endTurn();
  assert.equal((await permissions.read(A.id)).grants.find(g=>g.id===decision.grantId).status,'task-ended');
  await openTurn('Separate new input with the same command');
  const next=await c.onTool('frontdesk',execTool(REAL,args,rootA,'new input'));
  assert.equal(next.error.code,'PERMISSION_REQUIRED');
  assert.equal(await fs.readFile(marker,'utf8'),'once\n');
});
test('stale version, tampered hash, task end and restart generation all fail closed',async t=>{
  const {broker}=brokerFixture();
  const {c,A,B,host,openTurn,runApproved,permissions}=await fixture(t,{broker});
  await openTurn('维护系统状态');
  const frozen=normalizeExecutionEffect({command:REAL,args:['--maintain'],cwd:A.rootDisplay});
  const blocked=await c.onTool('frontdesk',{tool:'nozeli_privileged_execute',arguments:{command:frozen.command,args:frozen.args,cwd:frozen.cwd,purpose:'维护'},callId:randomUUID()});
  const requestId=blocked.error.requestId;
  // Stale expectedVersion refuses the decision outright.
  await assert.rejects(c.resolveEffectRequest({requestId,expectedVersion:9,action:'approve-once',requestKey:'attention:'+requestId+':9:approve-once'}),/已过期/);
  const decision=await c.resolveEffectRequest({requestId,expectedVersion:1,action:'approve-once',requestKey:'attention:'+requestId+':1:approve-once'});
  await runApproved(decision);
  // Tampered hash: a different effect claiming the same grant is rejected.
  const tampered=await permissions.preEffect(A.id,{effectHash:effectHash(normalizeExecutionEffect({command:REAL,args:['--evil'],cwd:A.rootDisplay})),permissionTaskId:(await permissions.read(A.id)).grants.find(g=>g.id===decision.grantId).permissionTaskId,grantId:decision.grantId});
  assert.equal(tampered.ok,false);assert.equal(tampered.code,'EFFECT_HASH_MISMATCH');
  // Task end invalidates live grants of that admission identity.
  const taskEnded=await permissions.endTask(A.id,(await permissions.read(A.id)).grants.find(g=>g.id===decision.grantId).permissionTaskId);
  assert.equal(taskEnded.ended,1);
  const afterEnd=await permissions.preEffect(A.id,{effectHash:decision&& (await permissions.read(A.id)).grants.find(g=>g.id===decision.grantId).effectHash,permissionTaskId:(await permissions.read(A.id)).grants.find(g=>g.id===decision.grantId).permissionTaskId,grantId:decision.grantId});
  assert.equal(afterEnd.ok,false);assert.equal(afterEnd.code,'EFFECT_TASK_ENDED');
  // Restart (new ledger generation over the same storage) stales every grant.
  const decision2request=await permissions.prepareEffect(A.id,{sourceJobId:'job-2',permissionTaskId:'task-2',effectType:'host-exec',frozenEffect:normalizeExecutionEffect({command:REAL,args:['--second'],cwd:B.rootDisplay})});
  const second=await permissions.decideEffect(A.id,{requestId:decision2request.request.id,expectedVersion:1,action:'approve-task',requestKey:'attention:'+decision2request.request.id+':1:approve-task',binding:{sourceJobId:'job-2',taskCurrent:true}});
  const restarted=new TaskPermissions(host.storage);
  const state=await restarted.read(A.id);
  assert.equal(state.grants.find(g=>g.id===second.grant.id).status,'stale-generation');
  const stale=await restarted.preEffect(A.id,{effectHash:second.grant.effectHash,permissionTaskId:'task-2'});
  assert.equal(stale.ok,false);assert.equal(stale.code,'EFFECT_STALE_GENERATION');
});
test('decision replay with the same key is idempotent and queues exactly one continuation',async t=>{
  const {c,A,openTurn,permissions}=await fixture(t,{broker:brokerFixture().broker});
  await openTurn('一次性配置写入');
  const blocked=await c.onTool('frontdesk',execTool(REAL,['--configure','--write'],A.rootDisplay,'原任务要求写入配置'));
  const requestId=blocked.error.requestId;
  const first=await c.resolveEffectRequest({requestId,expectedVersion:1,action:'approve-once',requestKey:'attention:'+requestId+':1:approve-once'});
  const replay=await c.resolveEffectRequest({requestId,expectedVersion:1,action:'approve-once',requestKey:'attention:'+requestId+':1:approve-once'});
  assert.equal(replay.duplicate,true);assert.equal(replay.jobId,first.jobId);
  assert.equal(c.store.state.jobs.filter(j=>j.key==='effect-permission:'+requestId).length,1);
  assert.equal((await permissions.read(A.id)).requests.filter(r=>r.id===requestId).length,1);
  // A different action under the same key is a collision, not a re-decision.
  await assert.rejects(c.resolveEffectRequest({requestId,expectedVersion:1,action:'deny',requestKey:'attention:'+requestId+':1:approve-once'}),/冲突/);
});
test('unknown execution result is durable and never replayed automatically',async t=>{
  const {calls,broker}=brokerFixture({execute:async()=>({executionId:'fx-unknown',status:'unknown',reason:'control channel lost'})});
  const {c,A,openTurn,runApproved,permissions}=await fixture(t,{broker});
  await openTurn('写入结果不确定的配置');
  const blocked=await c.onTool('frontdesk',execTool(REAL,['--flaky'],A.rootDisplay,'原任务要求执行'));
  const requestId=blocked.error.requestId;
  await c.resolveEffectRequest({requestId,expectedVersion:1,action:'approve-once',requestKey:'attention:'+requestId+':1:approve-once'});
  await runApproved({jobId:c.store.state.jobs.find(j=>j.key==='effect-permission:'+requestId).id});
  const run=await c.onTool('frontdesk',execTool(REAL,['--flaky'],A.rootDisplay,'原任务要求执行'));
  assert.equal(run.ok,false);assert.equal(run.error.code,'EFFECT_RESULT_UNKNOWN');
  assert.equal(calls.execute.length,1);
  const state=await permissions.read(A.id);
  assert.equal(state.executions.find(e=>e.requestId===requestId).status,'unknown');
  // Even an approve-task style re-request of the same effect stays blocked.
  const originalFrozen=(await permissions.read(A.id)).requests.find(r=>r.id===requestId).frozenEffect;
  const again=await permissions.prepareEffect(A.id,{sourceJobId:'job-x',permissionTaskId:(await permissions.read(A.id)).requests.find(r=>r.id===requestId).permissionTaskId,effectType:'host-exec',frozenEffect:originalFrozen});
  assert.equal(again.status,'unknown');
});
test('OS authentication cancelled or failed records honestly; no fake root, no execution',async t=>{
  const cancelled=brokerFixture({authenticate:async()=>({status:'cancelled'})});
  const {c,A,openTurn,runApproved,permissions}=await fixture(t,{broker:cancelled.broker});
  await openTurn('提权安装一次');
  const blocked=await c.onTool('frontdesk',execTool(REAL,['--installer'],A.rootDisplay,'原任务要求安装','admin'));
  const requestId=blocked.error.requestId;
  await c.resolveEffectRequest({requestId,expectedVersion:1,action:'approve-once',requestKey:'attention:'+requestId+':1:approve-once'});
  await runApproved({jobId:c.store.state.jobs.find(j=>j.key==='effect-permission:'+requestId).id});
  const cancelledRun=await c.onTool('frontdesk',execTool(REAL,['--installer'],A.rootDisplay,'原任务要求安装','admin'));
  assert.equal(cancelledRun.ok,false);assert.equal(cancelledRun.error.code,'AUTH_CANCELLED');
  assert.equal(cancelled.calls.execute.length,0);
  assert.equal((await permissions.read(A.id)).executions.find(e=>e.requestId===requestId).status,'auth-cancelled');
  const failed=brokerFixture({authenticate:async()=>({status:'failed',reason:'auth daemon refused'})});
  const {c:c2,A:A2,openTurn:open2,runApproved:run2,permissions:p2}=await fixture(t,{broker:failed.broker});
  await open2('提权安装一次（失败路径）');
  const b2=await c2.onTool('frontdesk',execTool(REAL,['--installer'],A2.rootDisplay,'原任务要求安装','admin'));
  const r2=b2.error.requestId;
  await c2.resolveEffectRequest({requestId:r2,expectedVersion:1,action:'approve-once',requestKey:'attention:'+r2+':1:approve-once'});
  await run2({jobId:c2.store.state.jobs.find(j=>j.key==='effect-permission:'+r2).id});
  const failedRun=await c2.onTool('frontdesk',execTool(REAL,['--installer'],A2.rootDisplay,'原任务要求安装','admin'));
  assert.equal(failedRun.ok,false);assert.equal(failedRun.error.code,'AUTH_FAILED');
  assert.equal(failed.calls.execute.length,0);
  assert.equal((await p2.read(A2.id)).executions.find(e=>e.requestId===r2).status,'auth-failed');
});
test('without a wired broker the result is honest ELEVATION_UNAVAILABLE and nothing executes',async t=>{
  const {c,A,openTurn,runApproved}=await fixture(t);
  await openTurn('提权执行但宿主未接入代理');
  const blocked=await c.onTool('frontdesk',execTool(REAL,['--x'],A.rootDisplay,'原任务要求'));
  const requestId=blocked.error.requestId;
  await c.resolveEffectRequest({requestId,expectedVersion:1,action:'approve-once',requestKey:'attention:'+requestId+':1:approve-once'});
  await runApproved({jobId:c.store.state.jobs.find(j=>j.key==='effect-permission:'+requestId).id});
  const run=await c.onTool('frontdesk',execTool(REAL,['--x'],A.rootDisplay,'原任务要求'));
  assert.equal(run.ok,false);assert.equal(run.error.code,'ELEVATION_UNAVAILABLE');
  assert.match(run.error.message,/未接入提权执行代理/);
});
test('unregistered-but-existing cwd is approvable risk, not pre-rejected; nonexistent cwd is invalid',async t=>{
  const {fx}= {fx:brokerFixture()};
  const {c,A,openTurn,permissions}=await fixture(t,{broker:fx.broker});
  await openTurn('系统级维护');
  const osTmp=os.tmpdir();
  const asked=await c.onTool('frontdesk',execTool(REAL,['--x'],osTmp,'原任务要求系统维护'));
  assert.equal(asked.error.code,'PERMISSION_REQUIRED');
  assert.match(asked.error.message,/敏感/);
  assert.equal((await permissions.read(A.id)).requests.length,1);
  await assert.rejects(c.onTool('frontdesk',execTool(REAL,['--x'],'/nozeli-no-such-dir-xyz','原任务要求')),/现存的真实目录/);
});
test('durable started intent without receipt blocks automatic retry (crash after effect)',async t=>{
  const {calls,broker}=brokerFixture({execute:async()=>{throw new Error('crash after start');}});
  const {c,A,openTurn,runApproved,permissions}=await fixture(t,{broker});
  await openTurn('执行可能在回执前崩溃的命令');
  const blocked=await c.onTool('frontdesk',execTool(REAL,['--crashy'],A.rootDisplay,'原任务要求'));
  const requestId=blocked.error.requestId;
  await c.resolveEffectRequest({requestId,expectedVersion:1,action:'approve-task',requestKey:'attention:'+requestId+':1:approve-task'});
  await runApproved({jobId:c.store.state.jobs.find(j=>j.key==='effect-permission:'+requestId).id});
  const run=await c.onTool('frontdesk',execTool(REAL,['--crashy'],A.rootDisplay,'原任务要求'));
  assert.equal(run.ok,false);assert.equal(run.error.code,'EFFECT_RESULT_UNKNOWN');
  const state=await permissions.read(A.id);
  assert.equal(state.executions.find(e=>e.requestId===requestId).status,'unknown');
  assert.equal(calls.execute.length,1);
});
test('cwd validation follows the injected platform parser (win32 drive paths valid, posix rejects them)',async ()=>{
  const frozen=normalizeExecutionEffect({command:'C:\\tools\\marker.exe',args:['--write'],cwd:'C:\\work\\proj',elevation:'user'},winPath);
  assert.equal(frozen.cwd,'C:\\work\\proj');assert.equal(frozen.elevation,'user');
  assert.throws(()=>normalizeExecutionEffect({command:'/x',args:[],cwd:'C:\\work\\proj'},posixPath),/当前平台的绝对工作目录/);
  assert.equal(normalizeExecutionEffect({command:'/usr/bin/x',args:[],cwd:'/tmp'},posixPath).cwd,'/tmp');
  assert.equal(frozen.action,'user');
  // The single hash canon stays platform-neutral and array-correct.
  assert.match(effectHash(frozen),/^[a-f0-9]{64}$/);
});
test('cross-API regression: started blocks retries, completed replays receipt, new op allowed, root-task authority follows the persistent grant',async t=>{
  const fx=brokerFixture();
  const {c,A,openTurn,runApproved,permissions,host}=await fixture(t,{broker:fx.broker});
  await openTurn('跨接口回归');
  const blocked=await c.onTool('frontdesk',execTool(REAL,['--admincmd','--a'],A.rootDisplay,'管理','admin'));
  const requestId=blocked.error.requestId;
  const decision=await c.resolveEffectRequest({requestId,expectedVersion:1,action:'approve-task',requestKey:'attention:'+requestId+':1:approve-task'});
  await runApproved({jobId:c.store.state.jobs.find(j=>j.key==='effect-permission:'+requestId).id});
  // 1) durable started intent, then a NEW ledger generation (restart) retrying
  //    the same operation must land on unknown, never re-execute.
  const state0=await permissions.read(A.id);
  const grant0=state0.grants.find(g=>g.id===decision.grantId);
  await permissions.recordExecution(A.id,{requestId,grantId:grant0.id,effectHash:grant0.effectHash,operationKey:'op-1',result:{status:'started'}});
  const restarted=new TaskPermissions(host.storage);
  const retryPrep=await restarted.prepareEffect(A.id,{sourceJobId:'job-r',permissionTaskId:grant0.permissionTaskId,effectType:'host-exec',frozenEffect:state0.requests.find(r=>r.id===requestId).frozenEffect,operationKey:'op-1'});
  assert.equal(retryPrep.status,'unknown');
  // 2) complete the started intent; the same operation replays the receipt.
  await permissions.recordExecution(A.id,{requestId,grantId:grant0.id,effectHash:grant0.effectHash,operationKey:'op-1',result:{status:'completed',exitCode:0,actualIdentity:{uid:0,source:'fixture-probe'},receiptId:'fx-1'}});
  const replayPrep=await permissions.prepareEffect(A.id,{sourceJobId:'job-r',permissionTaskId:grant0.permissionTaskId,effectType:'host-exec',frozenEffect:state0.requests.find(r=>r.id===requestId).frozenEffect,operationKey:'op-1'});
  assert.equal(replayPrep.status,'executed');assert.equal(replayPrep.execution.receiptId,'fx-1');
  // 3) a NEW operation under the same task grant is allowed again.
  const newOp=await permissions.prepareEffect(A.id,{sourceJobId:'job-r',permissionTaskId:grant0.permissionTaskId,effectType:'host-exec',frozenEffect:state0.requests.find(r=>r.id===requestId).frozenEffect,operationKey:'op-2'});
  assert.equal(newOp.status,'allowed');
  // 4) root-task authority: a DIFFERENT admin command in the same root is
  //    authorized through preEffect's view of the persistent grant, and dies
  //    with that grant's revoke.
  const otherFrozen={...state0.requests.find(r=>r.id===requestId).frozenEffect,command:'/usr/bin/other-admin',args:[]};delete otherFrozen.commandDigest;
  const covered=await permissions.prepareEffect(A.id,{sourceJobId:'job-r',permissionTaskId:grant0.permissionTaskId,effectType:'host-exec',frozenEffect:otherFrozen,operationKey:'op-3'});
  assert.equal(covered.status,'allowed');assert.equal(covered.grant.coveredBy,grant0.id);
  const pre=await permissions.preEffect(A.id,{effectHash:covered.effectHash,permissionTaskId:grant0.permissionTaskId,grantId:grant0.id,frozenEffect:otherFrozen});
  assert.equal(pre.ok,true,JSON.stringify(pre.code));assert.equal(pre.grant.coveredBy,grant0.id);
  const outside={...otherFrozen,cwd:'/etc'};delete outside.commandDigest;
  const outsidePrep=await permissions.prepareEffect(A.id,{sourceJobId:'job-r',permissionTaskId:grant0.permissionTaskId,effectType:'host-exec',frozenEffect:outside,operationKey:'op-4'});
  assert.equal(outsidePrep.status,'required');
  await permissions.revokeGrant(A.id,{grantId:grant0.id});
  const afterRevoke=await permissions.preEffect(A.id,{effectHash:covered.effectHash,permissionTaskId:grant0.permissionTaskId,grantId:grant0.id,frozenEffect:otherFrozen});
  assert.equal(afterRevoke.ok,false);assert.equal(afterRevoke.code,'EFFECT_REVOKED');
});
test('legacy pending cross-project requests migrate explicitly and stop holding the frontdesk',async t=>{
  const {broker}=brokerFixture();
  const {c,A,B,host,permissions}=await fixture(t,{broker});
  // Seed a schema-1 ledger with a still-pending ordinary cross-project request.
  const legacyId=randomUUID();
  await host.storage.putLocal(A.id,'managed:task-permissions',{schema:1,requests:[{id:legacyId,version:1,status:'pending',sourceJobId:'legacy-job',permissionTaskId:'legacy-task',targetProjectId:B.id,targetProjectName:'B',action:'read',scopeType:'file',relPath:'notes.txt'}],grants:[],decisions:[]});
  const state=await permissions.read(A.id);
  const migrated=state.requests.find(r=>r.id===legacyId);
  assert.equal(migrated.status,'migrated');assert.ok(migrated.migratedAt);
  assert.equal(state.schema,2);
  // Not stranded: it no longer holds automatic background handoff, and no
  // continuation job was queued on its behalf.
  assert.equal(await permissions.heldFor(A.id,{id:'legacy-job',context:{permissionTaskId:'legacy-task'}}),false);
  assert.equal(c.store.state.jobs.filter(j=>j.key==='frontdesk-permission:'+legacyId).length,0);
});
