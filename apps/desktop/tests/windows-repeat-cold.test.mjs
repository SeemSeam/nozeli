import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {git,str,commitTree} from '../src/agents/managed/git-service.mjs';
import {connectExperimentalProcessSupervisor} from '../src/platform/windows/experimental-process-supervisor.mjs';
import {openWindowsManagedColdInspection,prepareWindowsManagedColdHandoff} from '../src/platform/windows/managed-cold-checkpoint.mjs';
import {acquireExperimentalHostLease} from '../src/platform/windows/experimental-host-lease.mjs';
import {openColdController} from './fixtures/windows-cold-controller.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:480000};
async function until(fn,diagnostic){const end=performance.now()+180000;for(;;){const r=await fn();if(r)return r;if(performance.now()>end)assert.fail('Repeated cold fixture timeout: '+diagnostic());await delay(10);}}

for(const mode of ['normal','missing-history','history-revision','carryover-revision','missing-current-owner','postcheck-history','retirement-lost-reply','activation-pending'])
test(`two actual host deaths: ${mode} preserves exact generation custody and never replays old input`,native,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli repeat cold 中文 ')),profile=path.join(root,'profile'),content=path.join(root,'project');await fs.mkdir(content);
 const provider=await serve((request,index)=>{
  if(index===1)return {id:'read',tool:'nozeli_document_read',args:{relPath:'正文.md'}};
  const tool=request.messages.filter(r=>r.role==='tool').at(-1),result=JSON.parse(typeof tool.content==='string'?tool.content:tool.content.map(r=>r.text??'').join(''));assert.equal(result.ok,true);
  if(index===2)return {id:'apply',tool:'nozeli_document_apply',args:{readHandle:result.value.readHandle,replacements:[{oldText:'baseline',newText:'cold receipt'}]}};
  assert.equal(index,3);return {id:'publish',tool:'nozeli_publish',args:{kind:'result',content:staticReport('第二次冷接管合成候选'),files:['正文.md']}};
 });
 const storage=new ProjectStorage(profile,{windowsDesktopProjects:true}),projectId=(await storage.register(content)).id;
 const local=path.join(await storage.localDirectory(projectId),'ui.sqlite'),pins=new Map(),children=[],inspectors=[];let adopted;
 const request=(op,args)=>storage.db.request(local,op,args);
 const capture=async()=>{
  for(const row of await request('list',{collection:'managed_owner_launches'})){
   const endpoint=row.value.supervision;if(row.value.phase==='prepared'&&endpoint&&!pins.has(endpoint.supervisorPid))pins.set(endpoint.supervisorPid,connectExperimentalProcessSupervisor(endpoint));
  }
 };
 t.after(async()=>{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await child.closed;}
  for(const i of inspectors)i.close();
  if(adopted){assert.equal((await adopted.controller.stop()).confirmationComplete,true);for(const service of adopted.services)service.close();}
  await capture();for(const pin of pins.values()){await until(()=>pin.snapshot().jobEmptyObserved,()=>JSON.stringify(pin.snapshot()));pin.shutdown();pin.close();}
  await provider.close();await storage.db.close();await fs.rm(root,{recursive:true,force:true});
 });
 await fs.writeFile(path.join(content,'正文.md'),'baseline');await fs.writeFile(path.join(content,'.gitignore'),'.nozeli/\nnode_modules/\n');
 await git(content,['init','--initial-branch=main']);await git(content,['config','core.autocrlf','false']);await git(content,['add','.']);
 const initial=await commitTree(content,await str(content,['write-tree']),[],'synthetic baseline',path.join(root,'seed'));await git(content,['update-ref','refs/heads/main',initial]);
 const input=path.join(root,'input.json'),i={root,profile,content,projectId,ready:path.join(root,'ready.json'),adopterReady:path.join(root,'adopter-ready.json'),provider:provider.url,
  piRoot:process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi')};await fs.writeFile(input,JSON.stringify(i));
 const start=async(name,ready)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/'+name,import.meta.url)),input],{env:{SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let diagnostics='';child.stdout.on('data',b=>diagnostics+=b);child.stderr.on('data',b=>diagnostics+=b);child.closed=once(child,'close');children.push(child);
  const value=await until(async()=>{try{return JSON.parse(await fs.readFile(ready,'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;assert.equal(child.exitCode,null,diagnostics);}},()=>diagnostics);
  await capture();child.kill();await child.closed;
  for(const pin of pins.values())await until(()=>{const f=pin.snapshot();return f.hostExited&&f.jobEmptyObserved&&f.stdoutEOF&&f.stderrEOF;},()=>JSON.stringify(pin.snapshot()));
  return value;
 };
 const original=await start('windows-cold-business-host.mjs',i.ready),firstHost=await request('record',{collection:'managed_host_leases',id:'host'});
 assert.equal(provider.requests.length,3);await start('windows-cold-adopter.mjs',i.adopterReady);
 const secondHost=await request('record',{collection:'managed_host_leases',id:'host'}),secondOwners=await request('list',{collection:'managed_owner_launches'});
 const worker=secondOwners.find(r=>r.id===original.workId),history=await request('list',{collection:'managed_cold_retirements'});
 const retainedWork=(await storage.projectRequest(projectId,'record',{collection:'managed_works',id:original.workId})).value;
 assert.equal(history.length,1);assert.equal(worker.value.phase,'retired');assert.notEqual(firstHost.value.leaseId,secondHost.value.leaseId);assert.equal(pins.size,5);
 const beforeCheckpoints=await request('list',{collection:'managed_cold_checkpoints'});
 if(['missing-history','history-revision','carryover-revision','missing-current-owner'].includes(mode)){
  if(mode==='missing-history')await request('delete',{collection:'managed_cold_retirements',id:history[0].id});
  if(mode==='history-revision')await request('put',{collection:'managed_cold_retirements',id:history[0].id,value:history[0].value,expectedRevision:history[0].revision});
  if(mode==='carryover-revision')await request('put',{collection:'managed_owner_launches',id:worker.id,value:worker.value,expectedRevision:worker.revision});
  if(mode==='missing-current-owner')await request('delete',{collection:'managed_owner_launches',id:'frontdesk'});
  await assert.rejects(openWindowsManagedColdInspection({storage,projectId,inspectJournals:true,inspectBusinessReceipts:true}),
   {code:mode==='missing-current-owner'?'MANAGED_COLD_LAUNCH_SET_UNVERIFIED':'MANAGED_COLD_HISTORY_UNVERIFIED'});
  assert.deepEqual(await request('record',{collection:'managed_host_leases',id:'host'}),secondHost);
  assert.deepEqual(await request('list',{collection:'managed_cold_checkpoints'}),beforeCheckpoints);assert.equal(provider.requests.length,3);return;
 }
 const binding={storage,projectId,inspectJournals:true,inspectBusinessReceipts:true},inspection=await openWindowsManagedColdInspection(binding);inspectors.push(inspection);
 assert.equal(inspection.facts().generationHistory.length,2);assert.equal(inspection.facts().owners.length,5);
 if(mode==='postcheck-history'){
  await request('put',{collection:'managed_cold_retirements',id:history[0].id,value:history[0].value,expectedRevision:history[0].revision});
  await assert.rejects(inspection.check(),{code:'MANAGED_COLD_HISTORY_UNVERIFIED'});
  await assert.rejects(prepareWindowsManagedColdHandoff(inspection,binding),{code:'MANAGED_COLD_HISTORY_UNVERIFIED'});
  assert.deepEqual(await request('list',{collection:'managed_cold_checkpoints'}),beforeCheckpoints);assert.equal(provider.requests.length,3);return;
 }
 if(mode==='retirement-lost-reply'){
  const raw=storage.db.request.bind(storage.db);let writes=0;
  storage.db.request=async(file,op,args)=>{
   const result=await raw(file,op,args);
   if(op==='compareAndPut'&&args.records.some(r=>r.collection==='managed_cold_retirements'&&r.id===secondHost.value.leaseId)){
    writes++;throw Object.assign(Error('Lost second real generation retirement COMMIT reply'),{code:'STORAGE_RESULT_UNKNOWN'});
   }
   return result;
  };
  try{
   await assert.rejects(prepareWindowsManagedColdHandoff(inspection,binding),{code:'STORAGE_RESULT_UNKNOWN'});
   await assert.rejects(prepareWindowsManagedColdHandoff(inspection,binding),{code:'STORAGE_RESULT_UNKNOWN'});
   assert.equal(writes,1);assert.equal((await request('record',{collection:'managed_host_leases',id:'host'})).value.phase,'retired');
   assert.equal((await request('list',{collection:'managed_cold_retirements'})).length,2);
   for(const pin of pins.values())assert.equal(pin.snapshot().sourceCustodyVerified,true);
   assert.equal(provider.requests.length,3);
  }finally{storage.db.request=raw;}
  return;
 }
 const token=await prepareWindowsManagedColdHandoff(inspection,binding);
 if(mode==='activation-pending'){
  const raw=storage.db.request.bind(storage.db);let writes=0;
  storage.db.request=async(file,op,args)=>{
   const result=await raw(file,op,args);
   if(op==='compareAndPut'&&args.operationId.endsWith(':cold-active')){
    writes++;await storage.putRecovery(projectId,'managed:pending:repeat-cold-race',{schema:1,kind:'business',projectId,status:'pending',collections:{},base:{}});
   }
   return result;
  };
  try{
   await assert.rejects(acquireExperimentalHostLease({storage,projectId,previousColdHandoff:token}),{code:'STORAGE_RESULT_UNKNOWN'});
   await assert.rejects(acquireExperimentalHostLease({storage,projectId,previousColdHandoff:token}),{code:'MANAGED_COLD_HANDOFF_USED'});
   assert.equal(writes,1);assert.equal((await request('record',{collection:'managed_host_leases',id:'host'})).value.phase,'active');
   for(const pin of pins.values())assert.equal(pin.snapshot().sourceCustodyVerified,true);
   assert.equal(provider.requests.length,3);
  }finally{storage.db.request=raw;}
  return;
 }
 const outcomes=await Promise.allSettled([openColdController(i,storage,token),openColdController(i,storage,token)]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(outcomes.map(r=>({status:r.status,code:r.reason?.code,message:r.reason?.message}))));
 assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'MANAGED_COLD_HANDOFF_USED');adopted=outcomes.find(r=>r.status==='fulfilled').value;inspection.close();
 assert.equal((await request('list',{collection:'managed_cold_retirements'})).length,2);
 assert.deepEqual(await request('record',{collection:'managed_owner_launches',id:original.workId}),{value:worker.value,revision:worker.revision});
 assert.equal(adopted.controller.store.state.drafts.frontdesk,'原始未发送草稿');
 assert.equal(adopted.controller.store.state.jobs.find(r=>r.id===original.jobId).status,'interrupted');
 assert.equal(retainedWork.status,'paused');
 assert.equal(adopted.controller.store.find(original.workId).status,retainedWork.status);
 assert.deepEqual(adopted.controller.store.find(original.workId).result,retainedWork.result);
 assert.equal(adopted.controller.store.find(original.workId).recoveryRequiresExplicitInput,true);
 await adopted.controller.start();assert.equal(adopted.controller.sessions.size,2);assert.equal(adopted.budget.used,2);assert.equal(provider.requests.length,3);
 assert.equal(await fs.readFile(path.join(content,'正文.md'),'utf8'),'baseline');
});
