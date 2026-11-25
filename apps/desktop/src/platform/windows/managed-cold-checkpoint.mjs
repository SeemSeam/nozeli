// Native stop evidence alone never retires owners or replays input. The exact
// business hold, record retirement and one-shot host handoff add their own CAS
// and postchecks while retaining original helper/source entities.
import path from 'node:path';
import {inspectExperimentalColdHostJournal} from './experimental-cold-journal.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {managedStorageLocation} from './managed-storage-scope.mjs';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';
import {openExperimentalHostSources} from './experimental-host-sources.mjs';
import {connectExperimentalProcessSupervisor} from './experimental-process-supervisor.mjs';
import {readColdBusinessCollections} from './cold-business-receipts.mjs';
import {holdInterruptedExecution} from '../../agents/managed/restart-recovery.mjs';
import {ownerToolCollection} from '../../main/owner-tool-custody.mjs';
import {readColdGenerationHistory} from './cold-generation-history.mjs';
import {preserveColdEvidence} from './cold-evidence-archive.mjs';
export {reconcileWindowsManagedColdArchive,prepareWindowsManagedColdDisposal,openWindowsReleasedColdArchiveReader} from './cold-archive-reconciliation.mjs';

const issued=new WeakMap(),handoffs=new WeakMap();
const fail=(code,message,extra={})=>Object.assign(Error(message),{code,automaticReplay:false,...extra});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const freeze=value=>{for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);return Object.freeze(value);};
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const collection='managed_cold_checkpoints',maxOwners=32,maxBytes=256*1024*1024;

export async function openWindowsManagedColdInspection({storage,projectId,inspectJournals=false,inspectBusinessReceipts=false}={}){
  if(typeof inspectJournals!=='boolean')throw fail('MANAGED_COLD_UNSUPPORTED','Journal inspection must be explicitly enabled with a boolean');
  if(typeof inspectBusinessReceipts!=='boolean'||inspectBusinessReceipts&&!inspectJournals)throw fail('MANAGED_COLD_UNSUPPORTED','Business receipt inspection requires explicit journal inspection');
  storage?.assertLocalOpen(projectId);
  const project=structuredClone(await storage.requireOnline(projectId));
  const directory=await storage.localDirectory(projectId),database=path.join(directory,'ui.sqlite');
  const location=managedStorageLocation(storage,database,{code:'MANAGED_COLD_UNSUPPORTED'});
  const parent=openExperimentalPersistenceParent(location.root,location.relative),supervisors=[];
  let local,sources,host,owners,summary,inspection,journals=null,closed=false,fence=null,flight=null,settlementFlight=null,checkpointRecord=null,anchorFlight=null,anchorPin=null;
  let expectedHost,expectedOwners,retirementFlight=null,retirementCollections=null,retirementReceipt=null;
  let handoffFlight=null,handoffUsed=false,activationReceipt=null;
  let generations,observed=[];
  let archiveFlight,archiveCheck,archiveActive=false;
  const journalReader=Object.freeze({});
  const close=()=>{if(closed)return;closed=true;anchorPin?.close();for(const pin of supervisors)pin.close();sources?.close();local?.close();parent.close();};
  const rows=async()=>({
    host:await storage.db.request(database,'record',{collection:'managed_host_leases',id:'host',mustExist:true}),
    owners:await storage.db.request(database,'list',{collection:'managed_owner_launches'}),
  });
  const launchHistory=(facts,group=generations.groups[0])=>{
    const indexes=observed.map((entry,index)=>entry.group===group?index:-1).filter(index=>index>=0);
    const sets=indexes.map(index=>facts[index].launchSet),expected=group.host.value.launchSet;
    if(!expected||expected.schema!==1||sets.some(value=>!value||value.id!==expected.id||value.leaseId!==group.host.value.leaseId)||
       !sets.length||sets.some(value=>!same(value,sets[0]))||sets[0].entries.length!==group.prepared.length)
      throw fail('MANAGED_COLD_LAUNCH_SET_UNVERIFIED','Original native host launch history differs from complete owner registrations');
    for(const entry of sets[0].entries){
      const owner=group.prepared.find(row=>row.value.launchId===entry.launchId)?.value,endpoint=owner?.supervision;
      if(!entry.prepared||!owner||!endpoint||entry.leaderPid!==owner.identity.pid||entry.leaderCreationTime100ns!==owner.identity.creationTime100ns||
         entry.supervisorPid!==endpoint.supervisorPid||entry.supervisorCreationTime100ns!==endpoint.supervisorCreationTime100ns)
        throw fail('MANAGED_COLD_LAUNCH_SET_UNVERIFIED','Unfinished, deleted or replaced native launch cannot qualify whole-host stop');
    }
    return sets[0];
  };
  const kernel=()=>{
    if(fence)throw fence;if(closed)throw fail('MANAGED_COLD_CLOSED','Cold inspection pins have closed');
    storage.assertLocalOpen(projectId);parent.verify();local.verify();sources.verify();anchorPin?.verify();
    const facts=supervisors.map((pin,index)=>{
      const facts=pin.snapshot(),{row,group}=observed[index],owner=row.value,originalHost=group.host.value;
      if(!facts.hostExited||!facts.sourceCustodyVerified||!facts.outputCustodyVerified||!facts.inputCustodyVerified||
         facts.hostPid!==originalHost.host.pid||facts.hostCreationTime100ns!==originalHost.host.creationTime100ns||
         facts.stamp!==owner.identity.stamp||facts.sourceSha256!==sha(originalHost.source))
        throw fail('MANAGED_COLD_CUSTODY_UNVERIFIED','Original exited host and complete source/stdio custody required');
      if(!facts.jobEmptyObserved||!facts.allProcessIncarnationsObserved||!facts.stdoutEOF||!facts.stderrEOF||
         facts.outputError!==0||!facts.inputClosed||facts.inputPending||facts.inputError!==0||facts.inputBytes!==facts.inputCompletedBytes)
        throw fail('MANAGED_COLD_STOP_UNCONFIRMED','Every original Job, both output EOFs and original stdin completion must be confirmed',{facts});
      return facts;
    });
    for(const group of generations.groups)launchHistory(facts,group);return facts;
  };
  const readLocalCollection=name=>storage.db.request(database,'boundedList',{collection:name,maxRecords:16384,maxBytes:16*1024*1024,mustExist:true});
  const checkLedger=async()=>{
    try{
      const facts=kernel();await sources.check();const current=await rows();
      await generations.verify(retirementCollections?.managed_cold_retirements);
      await archiveCheck?.();
      if(!same(current.host,expectedHost)||!same(current.owners,expectedOwners)||!same(await storage.requireOnline(projectId),project)||
         await storage.localDirectory(projectId)!==directory)
        throw fail('MANAGED_COLD_BINDING_CHANGED','Host, complete owner set or registered instance changed during cold inspection');
      if(checkpointRecord&&!same(await storage.db.request(database,'record',{collection,id:checkpointRecord.id,mustExist:true}),checkpointRecord.record))
        throw fail('MANAGED_COLD_BINDING_CHANGED','Original cold checkpoint record or revision changed');
      if(retirementCollections)for(const [name,expected] of Object.entries(retirementCollections))
        if(!same(await readLocalCollection(name),expected))throw fail('MANAGED_COLD_BINDING_CHANGED','Retirement comparison collection changed');
      if(retirementReceipt&&!same(await storage.db.request(database,'receipt',{operationId:retirementReceipt.operationId,mustExist:true}),retirementReceipt.result))
        throw fail('MANAGED_COLD_BINDING_CHANGED','Retirement operation receipt changed');
      if(activationReceipt&&!same(await storage.db.request(database,'receipt',{operationId:activationReceipt.operationId,mustExist:true}),activationReceipt.result))
        throw fail('MANAGED_COLD_BINDING_CHANGED','Cold activation operation receipt changed');
      kernel();return facts;
    }catch(cause){fence??=cause;throw fence;}
  };
  const originalBinding=({target,supervisor})=>{
    kernel();const index=observed.findIndex((entry,index)=>entry.row.id===target&&supervisors[index]===supervisor);
    if(index<0)throw fail('MANAGED_COLD_RECEIPT_INVALID','Exact retained generation supervisor required');
    return freeze(structuredClone({host:observed[index].group.host,owner:observed[index].row}));
  };
  // This private reader never leaves this module. The complete journal read
  // is bracketed by checkLedger; public original readers still recheck it.
  const readJournals=async()=>{const result=[];for(let index=0;index<observed.length;index++)result.push(await inspectExperimentalColdHostJournal({storage,projectId,target:observed[index].row.id,supervisor:supervisors[index],inspectBusinessReceipts,
    originalInspection:journalReader}));return result;};
  const check=async()=>{
    try{const facts=await checkLedger();
      if(journals&&!same(await readJournals(),journals))throw fail('MANAGED_COLD_JOURNAL_CHANGED','Original journal or request observations changed');
      await checkLedger();return facts;
    }catch(cause){fence??=cause;throw fence;}
  };
  try{
    local=parent.openPrivateDatabase('ui.sqlite',true);
    ({host,owners}=await rows());
    expectedHost=host;expectedOwners=owners;
    if(host?.value?.schema!==1||host.value.phase!=='active'||host.value.projectId!==projectId||host.value.instanceId!==project.instanceId||
       host.value.databaseIdentity!==local.identity()||host.value.localDirectoryIdentity!==parent.identity()||!host.value.source||!host.value.host)
      throw fail('MANAGED_COLD_BINDING_CHANGED','Exact active host, native local database and registered instance required');
    if(!owners.length||owners.length>maxOwners)
      throw fail('MANAGED_COLD_OWNER_SET_UNVERIFIED','A bounded nonempty complete set of original supervisors is required');
    sources=await openExperimentalHostSources({storage,project,expected:host.value.source});
    generations=await readColdGenerationHistory({storage,projectId,database,host,owners});
    observed=generations.groups.flatMap(group=>group.prepared.map(row=>({group,row})));
    for(const {row} of observed)supervisors.push(connectExperimentalProcessSupervisor(row.value.supervision));
    issued.set(journalReader,{storage,projectId,originalRows:async binding=>originalBinding(binding)});
    const facts=await check();let total=0;
    const streams=[];
    for(let index=0;index<supervisors.length;index++){
      const pin=supervisors[index],fact=facts[index],ownerStreams={};
      for(const [name,channel] of [['stdin',0],['stdout',1],['stderr',2]]){
        const prefix=channel===0?'input':name,size=fact[prefix+'Bytes'];
        if(!Number.isSafeInteger(size)||size<0||(total+=size)>maxBytes)
          throw fail('MANAGED_COLD_LIMIT','Retained cold streams exceed the bounded checkpoint budget');
        const hash=createHash('sha256');let offset=0;
        for(;;){
          kernel();const range=channel===0?pin.readInput(offset):pin.readOutput(channel,offset);
          if(range.state==='eof')break;
          if(range.state!=='data'||!range.bytes?.length||offset+range.bytes.length>size)
            throw fail('MANAGED_COLD_STREAM_CHANGED','Original retained stream is incomplete or changed');
          hash.update(range.bytes);offset+=range.bytes.length;await setImmediate();
        }
        const digest=hash.digest('hex');
        if(offset!==size||digest!==fact[prefix+'Sha256'])throw fail('MANAGED_COLD_STREAM_CHANGED','Retained stream bytes differ from native custody digest');
        ownerStreams[name]={bytes:size,sha256:digest};
      }
      const owner=observed[index].row;
      streams.push({target:owner.id,ownerRevision:owner.revision,launchId:owner.value.launchId,
        identity:owner.value.identity,members:fact.members,totalProcesses:fact.totalProcesses,streams:ownerStreams});
    }
    if(inspectJournals)journals=await readJournals();
    await check();
    summary=freeze({schema:1,scope:'windows-managed-cold-quiescence-checkpoint',projectId,instanceId:project.instanceId,
      hostLeaseId:host.value.leaseId,hostRevision:host.revision,source:host.value.source,owners:streams,
      // Exact native history is retained by original helpers after host exit.
      // Business adoption still requires original journal/tool reconciliation.
      launchSet:launchHistory(facts),registeredJobQuiescenceVerified:true,launchSetCompletenessVerified:true,processQuiescenceVerified:true,
      generationHistory:generations.groups.map(group=>({hostLeaseId:group.host.value.leaseId,hostRevision:group.host.revision,
        retirementId:group.history?.id??null,launchSet:launchHistory(facts,group)})),
      ...(journals?{journals,journalRequestObservationsVerified:true}:{journalRequestObservationsVerified:false}),
      businessReceiptObservationsVerified:inspectBusinessReceipts,
      retainedStreamBytes:total,inputDeliveryIsExecutionAcknowledgement:false,
      ownerReleaseQualified:false,coldRecoveryQualified:false,productionSelected:false,automaticReplay:false});
    const operationId=randomUUID(),id=host.value.leaseId+':'+operationId;
    const commit=()=>{
      if(fence)return Promise.reject(fence);
      return flight??=(async()=>{
        await check();const value={...summary,host,ownerRecords:owners,operationId,recordedAt:new Date().toISOString()};let committed=false;
        try{
          const result=await storage.db.request(database,'put',{collection,id,value,expectedRevision:0,operationId});committed=true;
          await check();const after=await storage.db.request(database,'record',{collection,id,mustExist:true});await check();
          if(after?.revision!==result.revision||!same(after.value,value))throw fail('MANAGED_COLD_BINDING_CHANGED','Cold checkpoint record has another winner');
          checkpointRecord={id,record:after};
          return freeze({id,revision:result.revision,...summary});
        }catch(cause){
          if(committed||cause.code==='STORAGE_RESULT_UNKNOWN'||cause.commitUnknown)
            fence=fail('STORAGE_RESULT_UNKNOWN','Cold checkpoint outcome needs explicit reconciliation; no retry or replay',{
              cause,commitUnknown:{projectId,database,operationId},checkpointId:id});
          throw fence??cause;
        }
      })();
    };
    inspection=Object.freeze({facts(){kernel();return summary;},helperExits(){
      if(this!==inspection)throw fail('MANAGED_COLD_RECEIPT_INVALID','Original inspection receiver required');
      if(closed)throw fail('MANAGED_COLD_CLOSED','Original inspection handles have closed');
      // This view remains available after a native helper loss fences check().
      // It observes every original HANDLE, never reopens an endpoint, touches
      // a ledger or substitutes archive/exit facts for retained kernel custody.
      const helpers=observed.map(({group,row},index)=>{
        const binding={hostLeaseId:group.host.value.leaseId,target:row.id,ownerRevision:row.revision,launchId:row.value.launchId,supervisorPid:row.value.supervision.supervisorPid,supervisorCreationTime100ns:row.value.supervision.supervisorCreationTime100ns};
        try{const fact=supervisors[index].observeExit();return {...binding,state:fact.supervisorExited?'exited':'running'};}
        catch(error){return {...binding,state:'unknown',error:{code:error.code??'SUPERVISOR_RESULT_UNKNOWN',win32Code:error.win32Code??null}};}
      });
      return freeze({schema:1,scope:'original-helper-exit-set-observation-only',projectId,instanceId:project.instanceId,helpers,ledgerRevalidated:false,shutdownAcknowledged:false,ownerReleaseQualified:false,coldRecoveryQualified:false,automaticReplay:false});
    },check(){
      if(archiveActive)return Promise.reject(fail('MANAGED_COLD_ARCHIVE_BUSY','Original files are pinned by the active archive; wait for its result'));
      return check();
    },close});
    const settle=()=>{
     if(fence)return Promise.reject(fence);
     return settlementFlight??=(async()=>{
      if(!inspectBusinessReceipts)throw fail('MANAGED_COLD_UNSUPPORTED','Original business receipt inspection is required');
      const checkpoint=await commit();await check();
      const before=await readColdBusinessCollections(storage,projectId),candidate=structuredClone(before),jobs=new Map(),inherited=new Set();
      for(const journal of journals){
        const business=journal.toolCustody.businessReceipts;
        if(business.pendingRecordsObserved!==0||business.collectionsSha256!==sha(before))
          throw fail('MANAGED_COLD_PENDING_UNRESOLVED','Only an unchanged ledger with no pending business intents can be held');
        for(const turn of journal.reconciliation.turns){
          const row=candidate.managed_jobs.find(row=>row.id===turn.jobId),work=candidate.managed_works.find(row=>row.id===journal.target);
          const ancestor=generations.groups.find(group=>group.host.value.leaseId===journal.hostLeaseId)?.history?.value.retirement;
          if(ancestor&&row?.value.status==='interrupted'&&row.value.recoveryRequiresExplicitInput===true&&
             row.value.automaticReplay===false&&work?.value.recoveryRequiresExplicitInput===true&&work.value.automaticReplay===false&&
             row.value.target===journal.target&&row.value.revision===work.value.revision&&['paused','review'].includes(work.value.status)&&
             row.value.restartRecovery?.kind==='needs-reconciliation'&&
             ['checkpointId','checkpointRevision','hostLeaseId','originalEvidenceSha256'].every(key=>row.value.restartRecovery[key]===ancestor[key])&&
             row.value.restartRecovery.operationId===ancestor.holdOperationId&&row.value.restartRecovery.sourceJobId===row.id){
            inherited.add(row.id);continue;
          }
          if(!row||!work||row.value.target!==journal.target||row.value.revision!==work.value.revision||
             !['queued','running'].includes(row.value.status)||!['running','paused','review'].includes(work.value.status)||jobs.has(row.id))
            throw fail('MANAGED_COLD_UNSUPPORTED','Exact unfinished Worker job/work required; resident and repeated turns remain unsupported');
          const tools=journal.reconciliation.tools.filter(tool=>tool.requestId===turn.requestId);
          if(!tools.length||tools.some(tool=>{
            const custody=journal.toolCustody.tools.find(row=>row.id===tool.id),receipt=business.tools.find(row=>row.id===tool.id);
            return !custody?.handlerResultRetained||
              (tool.toolName!=='nozeli_document_read'&&receipt?.businessReceiptObserved!==true);
          }))throw fail('MANAGED_COLD_UNSUPPORTED','Every original effect requires its exact committed business receipt');
          jobs.set(row.id,{row,work});
        }
      }
      if(candidate.managed_jobs.some(row=>row.value.status==='running'&&!jobs.has(row.id)))
        throw fail('MANAGED_COLD_UNSUPPORTED','An active job lacks its exact original native turn');
      const operationId=randomUUID();
      for(const {row,work} of jobs.values()){
        holdInterruptedExecution(row.value,work.value,{reason:'Original host exited; retained tool receipts require explicit reconciliation',
          checkpointId:checkpoint.id,checkpointRevision:checkpoint.revision,operationId,sourceJobId:row.id,
          hostLeaseId:host.value.leaseId,originalEvidenceSha256:sha(summary)});
      }
      // replace resets revisions only in the two written collections. The
      // other four collections are a compare set, never a rewrite.
      if(jobs.size)for(const name of ['managed_jobs','managed_works'])for(const row of candidate[name])row.revision=1;
      const expectedJournals=structuredClone(journals);
      for(const journal of expectedJournals){
        const business=journal.toolCustody.businessReceipts;business.collectionsSha256=sha(candidate);
        for(const observation of business.tools){
          const pair=jobs.get(observation.jobId);if(!pair)continue;
          observation.jobStatus=pair.row.value.status;observation.workStatus=pair.work.value.status;
          if('jobSha256' in observation)observation.jobSha256=sha(pair.row.value);
          if('workSha256' in observation)observation.workSha256=sha(pair.work.value);
        }
      }
      await check();let committed=false;
      try{
        await storage.projectRequest(projectId,'replace',{operationId,expectedCollections:before,
          collections:jobs.size?{managed_jobs:candidate.managed_jobs,managed_works:candidate.managed_works}:{}});committed=true;
        journals=expectedJournals;
        await check();
        if(!same(await readColdBusinessCollections(storage,projectId),candidate))
          throw fail('MANAGED_COLD_BINDING_CHANGED','Business hold has another winner');
        await check();
        return freeze({schema:1,scope:'windows-cold-interrupted-business-hold',operationId,checkpointId:checkpoint.id,
          jobIds:[...jobs.keys()],inheritedJobIds:[...inherited],businessHoldCommitted:true,executionAcknowledged:false,pendingReconciled:false,
          ownerReleaseQualified:false,coldRecoveryQualified:false,productionSelected:false,automaticReplay:false});
      }catch(cause){
        if(committed||cause.code==='STORAGE_RESULT_UNKNOWN'||cause.commitUnknown)
          fence=fail('STORAGE_RESULT_UNKNOWN','Business hold outcome needs explicit reconciliation; no retry or replay',
            {cause,commitUnknown:{projectId,operationId},checkpointId:checkpoint.id});
        throw fence??cause;
      }
     })();
    };
    const claimAnchor=()=>{
      if(fence)return Promise.reject(fence);
      if(closed)return Promise.reject(fail('MANAGED_COLD_CLOSED','Cold inspection pins have closed'));
      return anchorFlight??=(async()=>{
        const hold=await settle();await check();
        let attempted=false;
        try{
          // This native operation duplicates the original file object without
          // reopening its path. Native arbitration spans every original helper.
          attempted=true;anchorPin=supervisors[0].claimColdAnchor();
          if(anchorPin.identity!==host.value.anchorIdentity)
            throw fail('MANAGED_COLD_BINDING_CHANGED','Original anchor File ID differs from its retained host');
          await check();
          return freeze({schema:1,scope:'windows-cold-original-anchor-custody-only',
            checkpointId:hold.checkpointId,holdOperationId:hold.operationId,hostLeaseId:host.value.leaseId,
            anchorIdentity:anchorPin.identity,originalFileObjectRetained:true,claimPostchecked:true,
            hostRetired:false,ownersRetired:false,ownerReleaseQualified:false,coldRecoveryQualified:false,
            productionSelected:false,automaticReplay:false});
        }catch(cause){
          if(attempted)fence=fail('STORAGE_RESULT_UNKNOWN','Cold anchor claim needs explicit reconciliation; original custody retained, no retry',
            {cause,checkpointId:hold.checkpointId,automaticReplay:false});
          throw fence??cause;
        }
      })();
    };
    const retire=()=>{
      if(fence)return Promise.reject(fence);
      if(closed)return Promise.reject(fail('MANAGED_COLD_CLOSED','Cold inspection pins have closed'));
      return retirementFlight??=(async()=>{
        const claimed=await claimAnchor();await check();
        const historyCollection='managed_cold_retirements',before={};
        for(const name of ['managed_host_leases','managed_owner_launches',collection,ownerToolCollection,historyCollection])
          before[name]=await readLocalCollection(name);
        if(!same(before.managed_host_leases,[{id:'host',...host}])||!same(before.managed_owner_launches,owners)||
           before[historyCollection].some(row=>row.id===host.value.leaseId))
          throw fail('STORAGE_CONFLICT','Original complete host/owner generation or create-only retirement history changed');
        const operationId=randomUUID(),retiredAt=new Date().toISOString(),id=host.value.leaseId;
        const proof=freeze({schema:1,scope:'windows-cold-original-generation-record-retirement-only',operationId,
          checkpointId:claimed.checkpointId,checkpointRevision:checkpointRecord.record.revision,
          holdOperationId:claimed.holdOperationId,hostLeaseId:id,anchorIdentity:anchorPin.identity,
          originalEvidenceSha256:sha(summary),executionAcknowledged:false,pendingReconciled:false,
          nextHostAuthorized:false,automaticReplay:false});
        const nextHost={value:{...host.value,phase:'retired',retiredAt,coldRetirement:{...proof,originalRevision:host.revision}},revision:host.revision+1};
        const nextOwners=owners.map(row=>row.value.hostLeaseId!==host.value.leaseId?row:({id:row.id,
          value:{...row.value,phase:'retired',retiredAt,coldRetirement:{...proof,originalRevision:row.revision}},revision:row.revision+1}));
        const history=freeze({schema:1,scope:'original-cold-host-owner-generation-history',projectId,instanceId:project.instanceId,
          host,ownerRecords:owners,retirement:proof,retiredHost:nextHost,retiredOwners:nextOwners,retiredAt,
          originalCheckpointSha256:sha(checkpointRecord.record),source:host.value.source,
          ownerReleaseQualified:false,coldRecoveryQualified:false,productionSelected:false,automaticReplay:false});
        const records=[{collection:'managed_host_leases',id:'host',value:nextHost.value,expectedRevision:host.revision},
          ...nextOwners.filter(row=>row.value.hostLeaseId===host.value.leaseId).map(row=>({collection:'managed_owner_launches',id:row.id,value:row.value,expectedRevision:owners.find(old=>old.id===row.id).revision})),
          {collection:historyCollection,id,value:history,expectedRevision:0}];
        const expectedResult={committed:true,revisions:records.map(row=>({collection:row.collection,id:row.id,revision:row.expectedRevision+1}))};
        await check();let committed=false;
        try{
          const result=await storage.db.request(database,'compareAndPut',{operationId,expectedCollections:before,records,mustExist:true});committed=true;
          expectedHost=nextHost;expectedOwners=nextOwners;
          retirementCollections={
            managed_host_leases:[{id:'host',...nextHost}],
            [collection]:before[collection],[ownerToolCollection]:before[ownerToolCollection],
            [historyCollection]:[...before[historyCollection],{id,value:history,revision:1}]
              .sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id))),
          };
          retirementReceipt={operationId,result:expectedResult};
          if(!same(result,expectedResult))throw fail('MANAGED_COLD_BINDING_CHANGED','Retirement receipt revisions differ from the original compare set');
          await check();
          return freeze({schema:1,scope:'windows-cold-owner-record-retirement-only',operationId,retirementId:id,retirementRevision:1,
            checkpointId:claimed.checkpointId,hostLeaseId:id,hostRevision:nextHost.revision,
            owners:nextOwners.map(row=>({target:row.id,revision:row.revision,launchId:row.value.launchId})),
            hostRetired:true,ownersRetired:true,businessHoldCommitted:true,executionAcknowledged:false,pendingReconciled:false,
            nextHostActivated:false,ownerReleaseQualified:false,coldRecoveryQualified:false,productionSelected:false,automaticReplay:false});
        }catch(cause){
          if(committed||cause.code==='STORAGE_RESULT_UNKNOWN'||cause.commitUnknown)
            fence=fail('STORAGE_RESULT_UNKNOWN','Cold owner retirement requires explicit reconciliation; original custody retained, no retry',
              {cause,commitUnknown:{projectId,database,operationId},retirementId:id});
          throw fence??cause;
        }
      })();
    };
    const archive=()=>{
      if(fence)return Promise.reject(fence);
      if(closed)return Promise.reject(fail('MANAGED_COLD_CLOSED','Cold inspection pins have closed'));
      if(archiveFlight)return archiveFlight;
      if(handoffFlight)return Promise.reject(fail('MANAGED_COLD_ARCHIVE_BUSY','Cold handoff has already begun'));
      archiveActive=true;
      return archiveFlight=(async()=>{
        const retirement=await retire();await check();
        let completed;
        try{const result=await preserveColdEvidence({storage,projectId,directory,database,checkpoint:checkpointRecord,retirement,summary,
          observed,supervisors,journals,verify:check,verifyLedger:checkLedger,retainCheck:value=>{archiveCheck=value;}});
          completed=result;await check();return result;}
        catch(cause){if(completed)fence=fail('STORAGE_RESULT_UNKNOWN','Ready cold archive final journal/business postcheck failed; original custody retained',
          {cause,commitUnknown:{projectId,database,operationId:completed.operationId,stage:'final-journal-postcheck'},automaticReplay:false});
          else if(cause.code==='STORAGE_RESULT_UNKNOWN'||cause.commitUnknown)fence=cause;throw fence??cause;}
      })().finally(()=>{archiveActive=false;});
    };
    const originalRows=async({target,supervisor})=>{
      if(!retirementCollections)throw fail('MANAGED_COLD_RECEIPT_INVALID','Original registration scope is available only after this exact retirement commit');
      await checkLedger();return originalBinding({target,supervisor});
    };
    const prepareHandoff=()=>{
      if(fence)return Promise.reject(fence);
      if(closed)return Promise.reject(fail('MANAGED_COLD_CLOSED','Cold inspection pins have closed'));
      if(archiveActive)return Promise.reject(fail('MANAGED_COLD_ARCHIVE_BUSY','Complete the original archive before preparing host handoff'));
      return handoffFlight??=(async()=>{
        await retire();await check();const token=Object.freeze({});
        handoffs.set(token,{storage,projectId,async consume(){
          if(handoffUsed)throw fail('MANAGED_COLD_HANDOFF_USED','Original cold handoff has already been consumed');
          // Consume before the first await; no second contender can borrow the
          // pin even when the first request fails or loses its commit reply.
          handoffUsed=true;await check();let activationAttempted=false,activated=false,finished=false;
          const originalPin=anchorPin;
          return Object.freeze({file:originalPin,host:freeze(structuredClone(expectedHost)),owners:freeze(structuredClone(expectedOwners)),
            retirementId:host.value.leaseId,source:host.value.source,history:freeze(structuredClone(retirementCollections.managed_cold_retirements)),check,
            async activate(next){
              if(activationAttempted)throw fail('MANAGED_COLD_HANDOFF_USED','Cold activation cannot be retried');
              activationAttempted=true;await check();
              if(next?.schema!==1||next.phase!=='active'||next.projectId!==projectId||next.instanceId!==project.instanceId||
                 next.leaseId===host.value.leaseId||next.host?.pid!==process.pid||next.anchorIdentity!==originalPin.identity||
                 next.databaseIdentity!==host.value.databaseIdentity||next.localDirectoryIdentity!==host.value.localDirectoryIdentity||
                 next.metadataIdentity!==host.value.metadataIdentity||!same(next.source,host.value.source)||
                 next.coldPredecessor?.retirementId!==host.value.leaseId||next.coldPredecessor?.retirementOperationId!==retirementReceipt.operationId)
                throw fail('MANAGED_COLD_BINDING_CHANGED','Exact next host and original retired generation required');
              const operationId=next.leaseId+':cold-active',before={...retirementCollections,managed_owner_launches:expectedOwners};
              const expected={committed:true,revisions:[{collection:'managed_host_leases',id:'host',revision:expectedHost.revision+1}]};
              let committed=false;
              try{
                const result=await storage.db.request(database,'compareAndPut',{operationId,expectedCollections:before,
                  records:[{collection:'managed_host_leases',id:'host',value:next,expectedRevision:expectedHost.revision}],mustExist:true});committed=true;
                expectedHost={value:next,revision:expected.revisions[0].revision};
                retirementCollections.managed_host_leases=[{id:'host',...expectedHost}];activationReceipt={operationId,result:expected};
                if(!same(result,expected))throw fail('MANAGED_COLD_BINDING_CHANGED','Cold host receipt differs from original expected revision');
                await check();activated=true;return {revision:expectedHost.revision};
              }catch(cause){
                if(committed||cause.code==='STORAGE_RESULT_UNKNOWN'||cause.commitUnknown)
                  fence=fail('STORAGE_RESULT_UNKNOWN','Cold host activation needs explicit reconciliation; original custody retained',
                    {cause,commitUnknown:{projectId,database,operationId},automaticReplay:false});
                throw fence??cause;
              }
            },
            async finish(verifyNext){
              if(!activated||finished)throw fail('MANAGED_COLD_HANDOFF_USED','Exact postchecked cold activation required');
              try{
                if(typeof verifyNext!=='function')throw fail('MANAGED_COLD_HANDOFF_USED','Next native host verifier required');
                verifyNext();await check();verifyNext();originalPin.verify();finished=true;anchorPin=null;
                fence=fail('MANAGED_COLD_HANDOFF_USED','Original cold inspection custody transferred to the next host');
              }catch(cause){
                fence=fail('STORAGE_RESULT_UNKNOWN','Cold activation final postcheck failed; original custody retained',{cause,automaticReplay:false});throw fence;
              }
            },
          });
        }});return token;
      })();
    };
    issued.set(inspection,{storage,projectId,commit,settle,claimAnchor,retire,archive,originalRows,prepareHandoff});return inspection;
  }catch(error){close();throw error;}
}

export function prepareWindowsManagedColdHandoff(inspection,{storage,projectId}={}){
  const held=issued.get(inspection);
  if(!held||held.storage!==storage||held.projectId!==projectId)
    return Promise.reject(fail('MANAGED_COLD_RECEIPT_INVALID','Original retained inspection and exact storage/project required'));
  return held.prepareHandoff();
}

export function archiveWindowsManagedColdEvidence(inspection,{storage,projectId}={}){
  const held=issued.get(inspection);
  if(!held||held.storage!==storage||held.projectId!==projectId)
    return Promise.reject(fail('MANAGED_COLD_RECEIPT_INVALID','Original retained inspection and exact storage/project required'));
  return held.archive();
}

export function consumeWindowsManagedColdHandoff(token,{storage,projectId}={}){
  const held=handoffs.get(token);
  if(!held||held.storage!==storage||held.projectId!==projectId)
    return Promise.reject(fail('MANAGED_COLD_RECEIPT_INVALID','Original opaque cold handoff and exact storage/project required'));
  return held.consume();
}

export function readWindowsManagedColdOriginalRegistration(inspection,binding={}){
  const held=issued.get(inspection);
  if(!held||held.storage!==binding.storage||held.projectId!==binding.projectId)
    return Promise.reject(fail('MANAGED_COLD_RECEIPT_INVALID','Original retained inspection and exact storage/project required'));
  return held.originalRows(binding);
}

export function retireWindowsManagedColdOwners(inspection,{storage,projectId}={}){
  const held=issued.get(inspection);
  if(!held||held.storage!==storage||held.projectId!==projectId)
    return Promise.reject(fail('MANAGED_COLD_RECEIPT_INVALID','Original retained inspection and exact storage/project required'));
  return held.retire();
}



export function claimWindowsManagedColdAnchor(inspection,{storage,projectId}={}){
  const held=issued.get(inspection);
  if(!held||held.storage!==storage||held.projectId!==projectId)
    return Promise.reject(fail('MANAGED_COLD_RECEIPT_INVALID','Original retained inspection and exact storage/project required'));
  return held.claimAnchor();
}

export function holdWindowsManagedColdBusiness(inspection,{storage,projectId}={}){
 const held=issued.get(inspection);
 if(!held||held.storage!==storage||held.projectId!==projectId)
  return Promise.reject(fail('MANAGED_COLD_RECEIPT_INVALID','Original retained inspection and exact storage/project required'));
 return held.settle();
}

export function commitWindowsManagedColdCheckpoint(inspection,{storage,projectId}={}){
  const held=issued.get(inspection);
  if(!held||held.storage!==storage||held.projectId!==projectId)
    return Promise.reject(fail('MANAGED_COLD_RECEIPT_INVALID','Original retained inspection and exact storage/project required'));
  return held.commit();
}
