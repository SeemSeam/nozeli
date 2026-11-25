import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {connectExperimentalProcessSupervisor} from '../src/platform/windows/experimental-process-supervisor.mjs';
import {openWindowsManagedColdInspection,commitWindowsManagedColdCheckpoint,holdWindowsManagedColdBusiness,claimWindowsManagedColdAnchor,retireWindowsManagedColdOwners,prepareWindowsManagedColdHandoff} from '../src/platform/windows/managed-cold-checkpoint.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {createWindowsDesktopWorkspaceIO} from '../src/platform/windows/experimental-workspace-io.mjs';
import {managedRuntime} from '../src/agents/managed/managed-storage.mjs';
import {createExperimentalPiOwnerLaunch} from '../src/platform/windows/experimental-pi-owner-launch.mjs';
import {createOwnerLaunchRegistry} from '../src/main/owner-launch-registry.mjs';
import {createHash} from 'node:crypto';
import {AgentProcessBudget} from '../src/agents/managed/agent-process-budget.mjs';
import {acquireExperimentalHostLease} from '../src/platform/windows/experimental-host-lease.mjs';
import {readExperimentalColdRegistrations} from '../src/platform/windows/experimental-host-sources.mjs';
import {readManagedState} from '../src/agents/managed/managed-storage.mjs';
import {restoreExecutionIntents} from '../src/agents/managed/restart-recovery.mjs';
import {git,str,commitTree} from '../src/agents/managed/git-service.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:240000};
async function until(fn,diagnostic=()=>'',timeout=150000){const end=performance.now()+timeout;for(;;){const value=await fn();if(value)return value;if(performance.now()>end)assert.fail('Cold business observation timeout: '+diagnostic());await delay(10);}}

for(const mode of ['original','missing-operation','missing-publication','publication-intent-winner','pending-winner','projection-winner','object-changed','checkpoint-winner',
 'hold','hold-precommit-winner','hold-postcommit-winner','hold-pending-winner','hold-checkpoint-winner',
 'hold-anchor','hold-anchor-postclaim-winner','hold-anchor-competing-winner',
 'hold-retire','hold-retire-precommit-owner-winner','hold-retire-precommit-tool-winner','hold-retire-postcommit-owner-winner',
 'hold-retire-postcommit-business-winner','hold-retire-postcommit-pending-winner','hold-retire-postcommit-checkpoint-winner',
 'hold-retire-postcommit-history-winner','hold-retire-postcommit-tool-winner','hold-retire-postcommit-host-set-winner',
 'hold-retire-lost-reply','hold-retire-handoff','hold-retire-handoff-precommit-owner-winner','hold-retire-handoff-postcommit-history-winner',
 'hold-retire-handoff-postcommit-pending-winner','hold-retire-handoff-lost-reply'])test(`actual Controller publication before reply, host kill and ${mode} cold business receipt inspection never repeats effects`,native,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli cold business 中文 ')),profile=path.join(root,'profile'),content=path.join(root,'project');await fs.mkdir(content);
  const provider=await serve((request,index)=>{
    if(index===1)return {id:'read',tool:'nozeli_document_read',args:{relPath:'正文.md'}};
    const tool=request.messages.filter(row=>row.role==='tool').at(-1),result=JSON.parse(typeof tool.content==='string'?tool.content:tool.content.map(row=>row.text??'').join(''));assert.equal(result.ok,true);
    if(index===2)return {id:'apply',tool:'nozeli_document_apply',args:{readHandle:result.value.readHandle,replacements:[{oldText:'baseline',newText:'cold receipt'}]}};
    assert.equal(index,3);return {id:'publish',tool:'nozeli_publish',args:{kind:'result',content:staticReport('冷检查候选报告'),files:['正文.md']}};
  });
  const storage=new ProjectStorage(profile,{windowsDesktopProjects:true}),projectId=(await storage.register(content)).id;
  const supervisors=[],supervisorPids=new Set();let child,closed;
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill();await closed;
    // Startup/hold failures occur before the normal connection loop. Retire
    // only helpers bound to this synthetic profile's exact retained endpoint.
    const local=path.join(await storage.localDirectory(projectId),'ui.sqlite');
    for(const row of await storage.db.request(local,'list',{collection:'managed_owner_launches'})){
      const endpoint=row.value.supervision;
      if(endpoint&&row.value.phase!=='retired'&&!supervisorPids.has(endpoint.supervisorPid)){
        supervisors.push(connectExperimentalProcessSupervisor(endpoint));supervisorPids.add(endpoint.supervisorPid);
      }
    }
    for(const pin of supervisors){pin.shutdown();pin.close();}
    await provider.close();await storage.db.close();await fs.rm(root,{recursive:true,force:true});
  });
  await fs.writeFile(path.join(content,'正文.md'),'baseline');await fs.writeFile(path.join(content,'.gitignore'),'.nozeli/\nnode_modules/\n');
  await git(content,['init','--initial-branch=main']);await git(content,['config','core.autocrlf','false']);await git(content,['add','.']);
  const initial=await commitTree(content,await str(content,['write-tree']),[],'synthetic baseline',path.join(root,'seed'));await git(content,['update-ref','refs/heads/main',initial]);
  const ready=path.join(root,'ready.json'),input=path.join(root,'input.json');await fs.writeFile(input,JSON.stringify({root,profile,content,projectId,ready,provider:provider.url,piRoot:process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi')}));
  child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/windows-cold-business-host.mjs',import.meta.url)),input],{env:{SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let diagnostics='';child.stdout.on('data',bytes=>diagnostics+=bytes);child.stderr.on('data',bytes=>diagnostics+=bytes);closed=once(child,'close');
  const binding=await until(async()=>{try{return JSON.parse(await fs.readFile(ready,'utf8'));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;assert.equal(child.exitCode,null,diagnostics);}},()=>diagnostics);
  assert.equal(provider.requests.length,3);child.kill();await closed;
  const local=path.join(await storage.localDirectory(projectId),'ui.sqlite'),owners=await storage.db.request(local,'list',{collection:'managed_owner_launches'});
  assert.equal(owners.length,3);
  for(const row of owners){const pin=connectExperimentalProcessSupervisor(row.value.supervision);supervisors.push(pin);supervisorPids.add(row.value.supervision.supervisorPid);await until(()=>{const facts=pin.snapshot();return facts.hostExited&&facts.jobEmptyObserved&&facts.stdoutEOF&&facts.stderrEOF;});}
  const options={storage,projectId,inspectJournals:true,inspectBusinessReceipts:true};
  let inspection=await openWindowsManagedColdInspection(options);const facts=inspection.facts(),journal=facts.journals.find(row=>row.launchId===binding.launchId),business=journal.toolCustody.businessReceipts;
  assert.equal(facts.businessReceiptObservationsVerified,true);assert.equal(business.tools.length,3);
  assert.equal(business.tools.find(row=>row.id===journal.reconciliation.tools.find(tool=>tool.toolName==='nozeli_document_apply').id).state,'document-business-receipt-observed');
  const publication=business.tools.find(row=>row.state==='publication-business-receipt-observed');assert.ok(publication);assert.equal(publication.projectionRowsObserved,true);assert.ok(publication.objectDigestsVerified.length>=3);
  assert.equal(journal.toolCustody.tools.find(row=>row.id===publication.id).state,'handler-returned-reply-unobserved');
  assert.equal(journal.reconciliation.unresolvedToolIds.length,1);assert.equal(facts.coldRecoveryQualified,false);assert.equal(business.businessSettlementQualified,false);
  assert.equal(business.pendingReconciliationQualified,false);assert.ok(business.verifiedObjectBytes>0);assert.match(publication.publicationIntentSha256,/^[a-f0-9]{64}$/);
  assert.equal(await fs.readFile(path.join(content,'正文.md'),'utf8'),'baseline');
  const request=storage.db.request.bind(storage.db),project=await storage.requireOnline(projectId),database=path.join(project.metadataRoot,'project.sqlite');
  if(mode.startsWith('hold')){
    const initialJobs=await storage.projectRequest(projectId,'list',{collection:'managed_jobs'}),initialWorks=await storage.projectRequest(projectId,'list',{collection:'managed_works'});
    const job=initialJobs.find(row=>row.id===binding.jobId),work=initialWorks.find(row=>row.id===binding.workId);
    const witness={};for(const name of ['managed_fileOperations','managed_receipts','managed_messages','managed_todos'])witness[name]=await storage.projectRequest(projectId,'list',{collection:name});
    const winner={...job.value,text:'concurrent winner preserved'};let writes=0;
    storage.db.request=async(file,op,args)=>{
      if(op==='replace'&&args.collections.managed_jobs){
        writes++;
        if(mode==='hold-precommit-winner')await request(database,'put',{collection:'managed_jobs',id:job.id,value:winner,expectedRevision:job.revision});
        if(mode==='hold-pending-winner')await storage.putRecovery(projectId,'managed:pending:hold-race',{schema:1,kind:'business',projectId,status:'pending',collections:{},base:{}});
        const result=await request(file,op,args);
        if(mode==='hold-postcommit-winner')await request(database,'put',{collection:'managed_jobs',id:job.id,value:winner});
        if(mode==='hold-checkpoint-winner'){
          const checkpoint=(await request(local,'list',{collection:'managed_cold_checkpoints'}))[0];
          await request(local,'put',{collection:'managed_cold_checkpoints',id:checkpoint.id,value:checkpoint.value,expectedRevision:checkpoint.revision});
        }
        return result;
      }
      return request(file,op,args);
    };
    try{
      const a=holdWindowsManagedColdBusiness(inspection,{storage,projectId}),b=holdWindowsManagedColdBusiness(inspection,{storage,projectId});assert.equal(a,b);
      if(mode==='hold'||mode.startsWith('hold-anchor')||mode.startsWith('hold-retire')){
        const result=await a;assert.equal(result.businessHoldCommitted,true);assert.equal(result.ownerReleaseQualified,false);assert.equal(result.executionAcknowledged,false);
        assert.deepEqual(result.jobIds,[job.id]);assert.deepEqual(await b,result);
        const state=await readManagedState(storage,projectId),saved=state.jobs.find(row=>row.id===job.id),savedWork=state.works.find(row=>row.id===work.id);
        assert.equal(saved.status,'interrupted');assert.equal(saved.recoveryRequiresExplicitInput,true);
        assert.equal(saved.text,job.value.text);assert.equal(savedWork.status,work.value.status==='running'?'paused':work.value.status);
        assert.deepEqual(savedWork.result,work.value.result);assert.equal(savedWork.recoveryRequiresExplicitInput,true);
        restoreExecutionIntents(state);assert.equal(saved.status,'interrupted');assert.equal(saved.restartRecovery.kind,'needs-reconciliation');
        await inspection.check();
        if(mode.startsWith('hold-retire')){
          await claimWindowsManagedColdAnchor(inspection,{storage,projectId});
          const beforeHost=await request(local,'record',{collection:'managed_host_leases',id:'host'}),beforeOwners=await request(local,'list',{collection:'managed_owner_launches'}),
            beforeTools=await request(local,'list',{collection:'managed_owner_tools'}),beforeHistory=await request(local,'list',{collection:'managed_cold_retirements'});
          let retireWrites=0,retirementOperation;
          storage.db.request=async(file,op,args)=>{
            if(op!=='compareAndPut')return request(file,op,args);
            retireWrites++;retirementOperation=args.operationId;
            if(mode==='hold-retire-precommit-owner-winner'){
              const row=beforeOwners[0];await request(local,'put',{collection:'managed_owner_launches',id:row.id,value:row.value,expectedRevision:row.revision});
            }
            if(mode==='hold-retire-precommit-tool-winner'){
              const row=beforeTools[0];assert.ok(row);await request(local,'put',{collection:'managed_owner_tools',id:row.id,value:row.value,expectedRevision:row.revision});
            }
            const result=await request(file,op,args);
            if(mode==='hold-retire-postcommit-owner-winner'){
              const row=(await request(local,'list',{collection:'managed_owner_launches'}))[0];
              await request(local,'put',{collection:'managed_owner_launches',id:row.id,value:{...row.value,phase:'external-winner'},expectedRevision:row.revision});
            }
            if(mode==='hold-retire-postcommit-host-set-winner')await request(local,'put',{collection:'managed_host_leases',id:'external-extra-host',value:{phase:'external-winner'},expectedRevision:0});
            if(mode==='hold-retire-postcommit-tool-winner'){
              const row=beforeTools[0];await request(local,'put',{collection:'managed_owner_tools',id:row.id,value:row.value,expectedRevision:row.revision});
            }
            if(mode==='hold-retire-postcommit-business-winner'){
              const row=await request(database,'record',{collection:'managed_jobs',id:job.id});
              await request(database,'put',{collection:'managed_jobs',id:job.id,value:{...row.value,text:'post-retirement business winner'},expectedRevision:row.revision});
            }
            if(mode==='hold-retire-postcommit-pending-winner')await storage.putRecovery(projectId,'managed:pending:retirement-race',{schema:1,kind:'business',projectId,status:'pending',collections:{},base:{}});
            for(const [candidate,collection] of [['hold-retire-postcommit-checkpoint-winner','managed_cold_checkpoints'],['hold-retire-postcommit-history-winner','managed_cold_retirements']])if(mode===candidate){
              const row=(await request(local,'list',{collection}))[0];await request(local,'put',{collection,id:row.id,value:row.value,expectedRevision:row.revision});
            }
            if(mode==='hold-retire-lost-reply')throw Object.assign(Error('Controlled reply loss after actual multi-collection COMMIT'),{code:'STORAGE_RESULT_UNKNOWN'});
            return result;
          };
          try{
            await assert.rejects(retireWindowsManagedColdOwners({...inspection},{storage,projectId}),{code:'MANAGED_COLD_RECEIPT_INVALID'});
            await assert.rejects(retireWindowsManagedColdOwners(inspection,{storage:{...storage},projectId}),{code:'MANAGED_COLD_RECEIPT_INVALID'});
            const x=retireWindowsManagedColdOwners(inspection,{storage,projectId}),y=retireWindowsManagedColdOwners(inspection,{storage,projectId});assert.equal(x,y);
            if(mode==='hold-retire'||mode.startsWith('hold-retire-handoff')){
              let retired;try{retired=await x;}catch(error){t.diagnostic(JSON.stringify({code:error.code,cause:error.cause?.code,detail:error.cause?.message}));throw error;}
              assert.deepEqual(await y,retired);assert.equal(retired.hostRetired,true);assert.equal(retired.ownersRetired,true);
              assert.equal(retired.nextHostActivated,false);assert.equal(retired.ownerReleaseQualified,false);assert.equal(retired.automaticReplay,false);
              assert.equal(retired.hostRevision,beforeHost.revision+1);await inspection.check();assert.deepEqual(inspection.facts(),facts);
              const actualOwners=await request(local,'list',{collection:'managed_owner_launches'}),actualHost=await request(local,'record',{collection:'managed_host_leases',id:'host'});
              assert.equal(actualHost.value.phase,'retired');assert.equal(actualHost.revision,beforeHost.revision+1);
              for(const [index,row] of actualOwners.entries()){
                assert.equal(row.value.phase,'retired');assert.equal(row.revision,beforeOwners[index].revision+1);
                assert.equal(row.value.launchId,beforeOwners[index].value.launchId);assert.equal(row.value.home,beforeOwners[index].value.home);
                assert.equal(row.value.coldRetirement.originalRevision,beforeOwners[index].revision);
              }
              assert.deepEqual(await request(local,'list',{collection:'managed_owner_tools'}),beforeTools);
              const history=await request(local,'record',{collection:'managed_cold_retirements',id:retired.retirementId});
              assert.equal(history.revision,1);assert.deepEqual(history.value.host,beforeHost);assert.deepEqual(history.value.ownerRecords,beforeOwners);
              assert.deepEqual((await request(local,'receipt',{operationId:retired.operationId})).revisions.map(row=>row.revision),[beforeHost.revision+1,...beforeOwners.map(row=>row.revision+1),1]);
              await assert.rejects(openWindowsManagedColdInspection(options),{code:'MANAGED_COLD_BINDING_CHANGED'});
              await assert.rejects(acquireExperimentalHostLease({storage,projectId}),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===32);
              const readBinding={storage,projectId,target:beforeOwners[0].id,supervisor:supervisors[0]};
              await assert.rejects(readExperimentalColdRegistrations({...readBinding,originalInspection:{...inspection}}),{code:'MANAGED_COLD_RECEIPT_INVALID'});
              await assert.rejects(readExperimentalColdRegistrations({...readBinding,originalInspection:inspection}),{code:'MANAGED_COLD_RECEIPT_INVALID'});
              if(mode.startsWith('hold-retire-handoff')){
                storage.db.request=request;
                const token=await prepareWindowsManagedColdHandoff(inspection,{storage,projectId});
                assert.deepEqual(Object.keys(token),[]);assert.equal(JSON.stringify(token),'{}');
                await assert.rejects(acquireExperimentalHostLease({storage,projectId,previousColdHandoff:{...token}}),{code:'MANAGED_COLD_RECEIPT_INVALID'});
                if(mode!=='hold-retire-handoff'){
                  let activations=0,activationId;
                  storage.db.request=async(file,op,args)=>{
                    if(op!=='compareAndPut'||!args.operationId.endsWith(':cold-active'))return request(file,op,args);
                    activations++;activationId=args.operationId;
                    if(mode==='hold-retire-handoff-precommit-owner-winner'){
                      const row=actualOwners[0];await request(local,'put',{collection:'managed_owner_launches',id:row.id,value:row.value,expectedRevision:row.revision});
                    }
                    const result=await request(file,op,args);
                    if(mode==='hold-retire-handoff-postcommit-history-winner')await request(local,'put',{collection:'managed_cold_retirements',id:retired.retirementId,value:history.value,expectedRevision:history.revision});
                    if(mode==='hold-retire-handoff-postcommit-pending-winner')await storage.putRecovery(projectId,'managed:pending:cold-handoff-race',{schema:1,kind:'business',projectId,status:'pending',collections:{},base:{}});
                    if(mode==='hold-retire-handoff-lost-reply')throw Object.assign(Error('Lost actual cold activation COMMIT reply'),{code:'STORAGE_RESULT_UNKNOWN'});
                    return result;
                  };
                  try{
                    const expectedCode=mode.includes('precommit')?'STORAGE_CONFLICT':'STORAGE_RESULT_UNKNOWN';
                    await assert.rejects(acquireExperimentalHostLease({storage,projectId,previousColdHandoff:token}),{code:expectedCode});
                    await assert.rejects(acquireExperimentalHostLease({storage,projectId,previousColdHandoff:token}),{code:'MANAGED_COLD_HANDOFF_USED'});
                    assert.equal(activations,1);const current=await request(local,'record',{collection:'managed_host_leases',id:'host'});
                    if(mode.includes('precommit')){assert.deepEqual(current,actualHost);assert.equal(await request(local,'receipt',{operationId:activationId}),null);}
                    else{assert.equal(current.value.phase,'active');assert.equal(current.revision,actualHost.revision+1);assert.ok(await request(local,'receipt',{operationId:activationId}));}
                    for(const pin of supervisors)assert.equal(pin.snapshot().sourceCustodyVerified,true);
                    assert.equal(provider.requests.length,3);
                  }finally{storage.db.request=request;}
                }else{
                const runtime=await managedRuntime(storage,projectId);
                const piRoot=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');
                const piManifest=JSON.parse(await fs.readFile(path.join(piRoot,'runtime-manifest.json'),'utf8'));
                const base={command:process.execPath,commandSha256:createHash('sha256').update(await fs.readFile(process.execPath)).digest('hex'),
                  entry:path.join(piRoot,'src/owner.mjs'),entrySha256:piManifest.files['src/owner.mjs'],nativeTools:[]};
                const services=[],budget=new AgentProcessBudget({limit:3}),ownerLaunchFactory=spec=>{
                  const agentDir=path.join(spec.home,'config'),service=createExperimentalPiOwnerLaunch({...spec,root:profile,agentDir,runtime:{...base,agentDir},
                    registry:createOwnerLaunchRegistry(storage,projectId,{hostLease:spec.hostLease}),supervise:true});services.push(service);return service;
                };
                const controllerOptions={storage,projectId,runtimeRoot:runtime,contentRoot:content,processBudget:budget,ownerLaunchFactory,
                  piRuntime:{...base,roleDefaultsFor:async()=>({selector:'local-fixture/scripted',effort:'off'})}};
                const opened=Controller.open({...controllerOptions,
                  workspaceIO:createWindowsDesktopWorkspaceIO({storage,previousColdHandoff:token})});
                const contender=Controller.open({...controllerOptions,
                  workspaceIO:createWindowsDesktopWorkspaceIO({storage,previousColdHandoff:token})});
                const outcomes=await Promise.allSettled([opened,contender]),adopted=outcomes.find(row=>row.status==='fulfilled'),rejected=outcomes.find(row=>row.status==='rejected');
                assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1,JSON.stringify(outcomes.map(row=>({status:row.status,code:row.reason?.code,message:row.reason?.message}))));
                assert.equal(adopted.status,'fulfilled',adopted.reason?.stack);assert.equal(rejected.status,'rejected');assert.equal(rejected.reason.code,'MANAGED_COLD_HANDOFF_USED');
                const controller=adopted.value;
                try{
                  assert.equal(controller.store.state.jobs.find(row=>row.id===job.id).status,'interrupted');
                  assert.equal(controller.store.find(work.id).status,savedWork.status);
                  assert.equal(controller.store.state.drafts.frontdesk,'原始未发送草稿');assert.equal(controller.sessions.size,0);
                  const next=await request(local,'record',{collection:'managed_host_leases',id:'host'});
                  assert.equal(next.value.phase,'active');assert.equal(next.revision,beforeHost.revision+2);
                  assert.notEqual(next.value.leaseId,beforeHost.value.leaseId);assert.equal(next.value.coldPredecessor.retirementId,retired.retirementId);
                  assert.deepEqual(await request(local,'list',{collection:'managed_owner_launches'}),actualOwners);
                  assert.equal(provider.requests.length,3);
                  inspection.close();
                  await assert.rejects(acquireExperimentalHostLease({storage,projectId}),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===32);
                  await controller.start();
                  assert.equal(controller.sessions.size,2);assert.equal(budget.used,2);assert.equal(provider.requests.length,3);
                  assert.equal(controller.store.find(work.id).status,savedWork.status);
                  assert.equal(controller.store.state.jobs.find(row=>row.id===job.id).status,'interrupted');
                  const newOwners=await request(local,'list',{collection:'managed_owner_launches'});
                  for(const target of ['frontdesk','orchestrator']){
                    const current=newOwners.find(row=>row.id===target),previous=actualOwners.find(row=>row.id===target);
                    assert.equal(current.value.phase,'prepared');assert.equal(current.revision,previous.revision+2);
                    assert.notEqual(current.value.launchId,previous.value.launchId);assert.equal(current.value.hostLeaseId,next.value.leaseId);
                  }
                  assert.deepEqual(await request(local,'record',{collection:'managed_cold_retirements',id:retired.retirementId}),history);
                }finally{assert.equal((await controller.stop()).confirmationComplete,true);for(const service of services)service.close();}
                }
              }
            }else{
              const code=mode.startsWith('hold-retire-precommit')?'STORAGE_CONFLICT':'STORAGE_RESULT_UNKNOWN';
              for(const row of await Promise.allSettled([x,y])){assert.equal(row.status,'rejected');assert.equal(row.reason.code,code);}
              await assert.rejects(retireWindowsManagedColdOwners(inspection,{storage,projectId}),{code});
              if(mode.startsWith('hold-retire-precommit')){
                assert.deepEqual(await request(local,'record',{collection:'managed_host_leases',id:'host'}),beforeHost);
                assert.deepEqual(await request(local,'list',{collection:'managed_cold_retirements'}),beforeHistory);
                assert.equal(await request(local,'receipt',{operationId:retirementOperation}),null);
                if(mode==='hold-retire-precommit-tool-winner')assert.deepEqual(await request(local,'list',{collection:'managed_owner_launches'}),beforeOwners);
              }else{
                assert.equal((await request(local,'record',{collection:'managed_host_leases',id:'host'})).value.phase,'retired');
                assert.equal((await request(local,'list',{collection:'managed_cold_retirements'})).length,beforeHistory.length+1);
                await assert.rejects(inspection.check(),{code:'STORAGE_RESULT_UNKNOWN'});
              }
            }
            assert.equal(retireWrites,1);for(const pin of supervisors)assert.equal(pin.snapshot().sourceCustodyVerified,true);
            const held=await readManagedState(storage,projectId),heldJob=held.jobs.find(row=>row.id===job.id);
            assert.equal(heldJob.status,'interrupted');assert.equal(heldJob.recoveryRequiresExplicitInput,true);restoreExecutionIntents(held);assert.equal(heldJob.status,'interrupted');
          }finally{storage.db.request=request;}
        }
        if(mode.startsWith('hold-anchor')){
          const beforeHost=await request(local,'record',{collection:'managed_host_leases',id:'host'}),beforeOwners=await request(local,'list',{collection:'managed_owner_launches'});
          let checkpointReads=0,competing;
          if(mode==='hold-anchor-competing-winner')competing=supervisors[1].claimColdAnchor();
          storage.db.request=async(file,op,args)=>{
            if(mode==='hold-anchor-postclaim-winner'&&op==='record'&&args.collection==='managed_cold_checkpoints'&&++checkpointReads===3){
              const before=await request(file,op,args);
              await request(file,'put',{collection:args.collection,id:args.id,value:before.value,expectedRevision:before.revision});
            }
            return request(file,op,args);
          };
          try{
            const x=claimWindowsManagedColdAnchor(inspection,{storage,projectId}),y=claimWindowsManagedColdAnchor(inspection,{storage,projectId});assert.equal(x,y);
            if(mode==='hold-anchor'){
              const claimed=await x;assert.equal(claimed.claimPostchecked,true);assert.equal(claimed.originalFileObjectRetained,true);
              assert.equal(claimed.anchorIdentity,beforeHost.value.anchorIdentity);assert.equal(claimed.hostRetired,false);assert.equal(claimed.ownersRetired,false);
              assert.equal(claimed.coldRecoveryQualified,false);assert.equal(claimed.automaticReplay,false);assert.deepEqual(await y,claimed);await inspection.check();
              assert.throws(()=>supervisors[1].claimColdAnchor(),error=>error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===183);
            }else{
              const results=await Promise.allSettled([x,y]);for(const row of results){assert.equal(row.status,'rejected');assert.equal(row.reason.code,'STORAGE_RESULT_UNKNOWN');}
              await assert.rejects(claimWindowsManagedColdAnchor(inspection,{storage,projectId}),{code:'STORAGE_RESULT_UNKNOWN'});
              if(mode==='hold-anchor-postclaim-winner')assert.equal(checkpointReads,3);
            }
            assert.deepEqual(await request(local,'record',{collection:'managed_host_leases',id:'host'}),beforeHost);
            assert.deepEqual(await request(local,'list',{collection:'managed_owner_launches'}),beforeOwners);
          }finally{competing?.close();storage.db.request=request;}
        }
      }else{
        // Attach handlers together: both callers share the same rejected flight.
        const results=await Promise.allSettled([a,b]);
        for(const result of results){assert.equal(result.status,'rejected');assert.equal(result.reason.code,mode==='hold-precommit-winner'?'STORAGE_CONFLICT':'STORAGE_RESULT_UNKNOWN');}
        await assert.rejects(holdWindowsManagedColdBusiness(inspection,{storage,projectId}),{code:mode==='hold-precommit-winner'?'STORAGE_CONFLICT':'STORAGE_RESULT_UNKNOWN'});
        if(['hold-precommit-winner','hold-postcommit-winner'].includes(mode))assert.deepEqual((await request(database,'record',{collection:'managed_jobs',id:job.id})).value,winner);
        if(mode==='hold-precommit-winner')assert.deepEqual(await storage.projectRequest(projectId,'list',{collection:'managed_works'}),initialWorks);
      }
      assert.equal(writes,1);
      for(const [collection,rows] of Object.entries(witness))assert.deepEqual(await storage.projectRequest(projectId,'list',{collection}),rows);
      assert.equal((await request(local,'list',{collection:'managed_owner_launches'})).length,3);
    }finally{storage.db.request=request;inspection.close();}
    if(mode==='hold-anchor')await assert.rejects(claimWindowsManagedColdAnchor(inspection,{storage,projectId}),{code:'MANAGED_COLD_CLOSED'});
    if(mode==='hold-retire')await assert.rejects(retireWindowsManagedColdOwners(inspection,{storage,projectId}),{code:'MANAGED_COLD_CLOSED'});
  }else if(mode==='original'){
    try{const receipt=await commitWindowsManagedColdCheckpoint(inspection,{storage,projectId});assert.equal(receipt.businessReceiptObservationsVerified,true);}finally{inspection.close();}
  }else{
    if(!['checkpoint-winner','pending-winner'].includes(mode))inspection.close();
    const collection=mode==='missing-operation'?'managed_fileOperations':mode==='missing-publication'?'managed_receipts':'managed_messages';
    const rows=await storage.projectRequest(projectId,'list',{collection}),row=mode==='missing-operation'?rows[0]:rows.find(row=>row.value.objectId===publication.objectId);
    if(mode==='missing-operation')await request(database,'delete',{collection,id:row.id});
    else if(mode==='missing-publication')await request(database,'delete',{collection,id:row.id});
    else if(mode==='publication-intent-winner'){
      const id='managed:publication:'+publication.receiptId,original=await storage.getRecovery(projectId,id),winner={...original,objectId:'foreign-publication'};
      await storage.putRecovery(projectId,id,winner);assert.deepEqual(await storage.getRecovery(projectId,id),winner);
    }else if(mode==='pending-winner'){
      const id='managed:pending:synthetic-independent-winner',winner={schema:1,kind:'business',status:'pending',projectId,operationId:'synthetic-independent-winner',collections:{},base:{},automaticReplay:false};
      await storage.putRecovery(projectId,id,winner);assert.deepEqual(await storage.getRecovery(projectId,id),winner);
      // A changed pending set fences a previously retained inspection before
      // any checkpoint write, even if the project receipts still match.
      let writes=0;storage.db.request=async(file,op,args)=>{if(op==='put'&&args.collection==='managed_cold_checkpoints')writes++;return request(file,op,args);};
      try{await assert.rejects(commitWindowsManagedColdCheckpoint(inspection,{storage,projectId}),{code:'MANAGED_COLD_JOURNAL_CHANGED'});assert.equal(writes,0);}finally{storage.db.request=request;inspection.close();}
      const fresh=await openWindowsManagedColdInspection(options);try{
        assert.ok(fresh.facts().journals.every(row=>row.toolCustody.businessReceipts.pendingRecordsObserved>=1));
        const jobs=await storage.projectRequest(projectId,'list',{collection:'managed_jobs'});
        await assert.rejects(holdWindowsManagedColdBusiness(fresh,{storage,projectId}),{code:'MANAGED_COLD_PENDING_UNRESOLVED'});
        assert.deepEqual(await storage.projectRequest(projectId,'list',{collection:'managed_jobs'}),jobs);
      }finally{fresh.close();}
    }else if(mode==='object-changed'){
      const digest=publication.reportDigest,object=path.join(project.metadataRoot,'objects','sha256',digest);
      await fs.writeFile(object,'external report winner');
    }else{
      const winner={...row.value,target:'foreign-work'};
      if(mode==='checkpoint-winner'){
        let writes=0;storage.db.request=async(file,op,args)=>{const result=await request(file,op,args);if(op==='put'&&args.collection==='managed_cold_checkpoints'){writes++;await request(database,'put',{collection,id:row.id,value:winner,expectedRevision:row.revision});}return result;};
        try{await assert.rejects(commitWindowsManagedColdCheckpoint(inspection,{storage,projectId}),{code:'STORAGE_RESULT_UNKNOWN'});await assert.rejects(commitWindowsManagedColdCheckpoint(inspection,{storage,projectId}),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(writes,1);}finally{storage.db.request=request;inspection.close();}
      }else await request(database,'put',{collection,id:row.id,value:winner,expectedRevision:row.revision});
      assert.deepEqual((await request(database,'record',{collection,id:row.id})).value,winner);
    }
    if(mode!=='pending-winner')await assert.rejects(openWindowsManagedColdInspection(options),{code:mode==='object-changed'?'MATERIAL_CORRUPT':'HOST_BUSINESS_RECEIPT_CHANGED'});
  }
  assert.equal(provider.requests.length,3);assert.equal(provider.errors.length,0);assert.equal((await storage.getRecovery(projectId,'managed:drafts')).frontdesk,'原始未发送草稿');
});
