// Explicit host custody prerequisite. A released file HANDLE is not proof that
// an old Job drained. Cold acquisition requires the original one-shot issuer;
// ordinary restart requires the durable terminal normal-release publication.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openExperimentalPersistenceParent,createExperimentalWindowsPersistence} from './experimental-persistence.mjs';
import {managedStorageLocation} from './managed-storage-scope.mjs';
import {openExperimentalProcessIdentity} from './experimental-process-identity.mjs';
import {verifyExperimentalOwnerExitProof} from './experimental-owner-exit-proof.mjs';
import {startExperimentalProcessSupervisor,experimentalSupervisorShutdownObserved,createExperimentalHostLaunchSet} from './experimental-process-supervisor.mjs';
import {openExperimentalHostSources} from './experimental-host-sources.mjs';

const live=new WeakMap(),released=new WeakMap();
const fail=(code,message,extra={})=>Object.assign(Error(message),{code,...extra});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const frozen=value=>{for(const child of Object.values(value))if(child&&typeof child==='object')frozen(child);return Object.freeze(value);};
const collection='managed_host_leases',id='host',ownersCollection='managed_owner_launches',releasesCollection='managed_host_release_completions';
function state(lease){const value=live.get(lease);if(!value)throw fail('HOST_LEASE_INVALID','Expected the original host lease');return value;}
export function verifyExperimentalHostLease(lease,{storage,projectId,admission=false}={}){
  const value=state(lease);value.verify();
  if(storage!==value.storage||projectId!==value.projectId)throw fail('HOST_LEASE_BINDING_CHANGED','Host lease belongs to another storage/project');
  if(admission&&value.phase!=='active')throw fail('HOST_LEASE_STOPPING','Host admission is sealed');
  return value.record;
}
export async function verifyExperimentalHostRegistration(lease,binding){
  verifyExperimentalHostLease(lease,binding);await state(lease).checkRegistration();
}
// Authority stays in the original host's retained launch/retirement receipts.
// A matching serialized owner row alone cannot authorize Work disposal.
export async function verifyExperimentalHostWorkOwner(lease,{storage,projectId,target,home,record,registration,retired=false}={}){
  verifyExperimentalHostLease(lease,{storage,projectId});const value=state(lease);await value.checkRegistration();
  const current=await value.readOwner(target),receipt=value.retirements.get(target);
  if(retired){
    if(!current){if(receipt)throw fail('HOST_LEASE_OWNER_UNVERIFIED','Recorded Work retirement disappeared');if(value.claims.size)throw fail('HOST_LEASE_BUSY','Unretired launches remain');}
    else if(!receipt||current.revision!==receipt.revision||!same(current.value,receipt.record)||current.value.phase!=='retired'||current.value.home!==home)
      throw fail('HOST_LEASE_OWNER_UNVERIFIED','Original confirmed Work retirement required');
  }else{
    const owner=current?.value;
    if(!owner||owner.phase!=='prepared'||owner.target!==target||owner.home!==home||
       !registration||registration.revision!==current.revision||!same(registration.record,owner)||
       owner.hostLeaseId!==value.record.leaseId||owner.projectId!==projectId||
       ![...value.claims.values()].includes(owner.launchId)||!record||
       ['ownerId','generation','launchId','home'].some(key=>owner[key]!==record[key])||
       owner.identity?.pid!==record.pid||owner.identity?.stamp!==record.stamp)
      throw fail('HOST_LEASE_OWNER_UNVERIFIED','Original retained Work launch differs from its current registration');
  }
  await value.checkRegistration();value.verify();return current;
}
export function startExperimentalHostSupervisor(lease,binding,job){
  verifyExperimentalHostLease(lease,{...binding,admission:true});return state(lease).supervise(job,binding.launchId,binding.ownerHome);
}
export function verifyExperimentalHostSupervisor(lease,pin,launchId){
  const value=state(lease);value.verify();
  if(!value.supervisors.has(pin)||launchId!==undefined&&value.supervisorLaunches.get(pin)!==launchId)throw fail('HOST_LEASE_BINDING_CHANGED','Supervisor belongs to another host custody');
  if(!pin.snapshot().sourceCustodyVerified)throw fail('HOST_LEASE_BINDING_CHANGED','Complete supervisor source custody is unverified');
}
// Called synchronously before the registry's first await. Even an intent with
// a lost reply keeps this claim and prevents a clean host retirement.
export function retainExperimentalHostLaunch(lease,binding){
  const value=state(lease);verifyExperimentalHostLease(lease,{...binding,admission:true});
  const token=Object.freeze({});value.reserve(binding.launchId);value.claims.set(token,binding.launchId);return token;
}
export function completeExperimentalHostLaunch(lease,token,receipt,exitProof){
  const value=state(lease);value.verify();
  if(!value.claims.has(token)||value.claims.get(token)!==receipt?.record?.launchId||receipt.record.phase!=='retired')
    throw fail('HOST_LEASE_CLAIM_INVALID','Expected the retained launch and confirmed retirement');
  if(!same(verifyExperimentalOwnerExitProof(exitProof),receipt.record.exit))throw fail('HOST_LEASE_CLAIM_INVALID','Original native exit proof required');
  value.retirements.set(receipt.record.target,receipt);
  value.claims.delete(token);
}

export async function acquireExperimentalHostLease({storage,projectId,previousRelease,previousColdHandoff}={}){
  if(process.platform!=='win32'||process.arch!=='x64'||!storage)
    throw fail('HOST_LEASE_UNSUPPORTED','Explicit native Windows x64 storage scope required');
  storage.assertLocalOpen(projectId);
  if(previousRelease&&previousColdHandoff)throw fail('HOST_LEASE_INVALID','Select exactly one original host handoff');
  const cold=previousColdHandoff&&await (await import('./managed-cold-checkpoint.mjs'))
    .consumeWindowsManagedColdHandoff(previousColdHandoff,{storage,projectId});
  let coldBorrowed=Boolean(cold);
  const project=structuredClone(await storage.requireOnline(projectId));
  const directory=await storage.localDirectory(projectId),database=path.join(directory,'ui.sqlite');
  const anchor=path.join(project.metadataRoot,'managed-host.lease');
  const location=managedStorageLocation(storage,anchor,{code:'HOST_LEASE_UNSUPPORTED'});
  const parent=openExperimentalPersistenceParent(location.root,location.relative);
  let file,dbParent,dbPin,processPin,sources,launchSet,record,revision,phase='acquiring',fence=null,releaseFlight;
  const claims=new Map(),nativeClaims=new Map(),retirements=new Map(),supervisors=new Set(),supervisorLaunches=new Map();let created=false;
  const closePins=()=>{launchSet?.close();for(const pin of [sources,processPin,dbPin,dbParent,...(coldBorrowed?[]:[file]),parent])pin?.close();};
  const verify=()=>{
    if(fence)throw fence;
    if(phase==='closed')throw fail('HOST_LEASE_CLOSED','Host custody pins closed');
    storage.assertLocalOpen(projectId);parent.verify();file.verify();dbParent.verify();dbPin.verify();
    sources?.verify();
    if(processPin.snapshot().state!=='running')throw fail('HOST_LEASE_IDENTITY_CHANGED','Original host process is no longer running');
  };
  const verifyBinding=async()=>{
    verify();await sources.check();const current=await storage.requireOnline(projectId);
    if(!same(current,project)||(await storage.localDirectory(projectId))!==directory)
      throw fail('HOST_LEASE_BINDING_CHANGED','Registered project/instance or database location changed');
    if(cold&&!same(await storage.db.request(database,'boundedList',{collection:'managed_cold_retirements',maxRecords:16384,maxBytes:16*1024*1024,mustExist:true}),cold.history))
      throw fail('HOST_LEASE_BINDING_CHANGED','Retained original cold generation history changed');
    verify();
  };
  const request=async(op,args)=>{
    await verifyBinding();let committed=false;
    try{
      const result=await storage.db.request(database,op,{collection,...args});committed=op==='put';
      await verifyBinding();return result;
    }catch(cause){
      if(committed||cause.code==='STORAGE_RESULT_UNKNOWN'||cause.commitUnknown){
        fence=fail('STORAGE_RESULT_UNKNOWN','Host custody commit needs explicit recovery; no replay',{
          cause,automaticReplay:false,commitUnknown:{projectId,database,operationId:args.operationId}});throw fence;
      }
      throw cause;
    }
  };
  // Multi-collection CAS submits the exact argument shape the storage worker
  // fingerprints; the generic request helper would inject an unrelated
  // collection key and silently rebind the durable receipt to another request.
  const cas=async(operationId,expectedCollections,records,unknown)=>{
    await verifyBinding();let committed=false;
    try{
      const result=await storage.db.request(database,'compareAndPut',{operationId,expectedCollections,records,mustExist:true});committed=true;
      await verifyBinding();return result;
    }catch(cause){
      if(committed||cause.code==='STORAGE_RESULT_UNKNOWN'||cause.commitUnknown){
        fence=fail('STORAGE_RESULT_UNKNOWN',unknown,{cause,automaticReplay:false,commitUnknown:{projectId,database,operationId}});throw fence;
      }
      throw cause;
    }
  };
  // Restart authority is the terminal durable normal-release publication,
  // never a serialized caller receipt. The original comparison is reconciled
  // read-only under the exclusive anchor: its fingerprint binds this exact
  // retired host, the complete owner set, this generation's exact completion
  // membership and the published evidence value itself.
  const verifyReleasedGeneration=async(old,anchorIdentity)=>{
    const refused=()=>fail('HOST_LEASE_RECOVERY_REQUIRED','Existing custody needs its durable normal-release completion verified; no cold handoff or file availability authorizes a new host',
      {automaticReplay:false,previousHost:old,anchorIdentity,coldRecoveryQualified:false});
    const value=old?.value;
    if(value?.schema!==1||value.scope!=='explicit-live-host-custody'||value.phase!=='retired'||value.coldRetirement||
       value.projectId!==projectId||value.instanceId!==project.instanceId||typeof value.leaseId!=='string'||!value.source)
      throw refused();
    // Stable physical identities: the exact anchor, metadata parent, local
    // directory, database entities and complete source observations this
    // generation was originally bound to must still be the current ones.
    if(value.anchorIdentity!==anchorIdentity||value.metadataIdentity!==parent.identity()||
       value.localDirectoryIdentity!==dbParent.identity()||value.databaseIdentity!==dbPin.identity()||!same(value.source,sources.record))
      throw refused();
    const owners=await request('list',{collection:ownersCollection});
    if(owners.some(row=>row.value?.phase!=='retired'))throw refused();
    const releaseId=value.leaseId+':normal-release',releasesName=releasesCollection+':'+value.leaseId,
      releases=await request('list',{collection:releasesName});
    const completionRow=releases.find(row=>row.id===releaseId),completion=completionRow?.value;
    if(!completion||completion.schema!==1||completion.scope!=='windows-managed-normal-release-completion'||
       completion.projectId!==projectId||completion.instanceId!==project.instanceId||completion.leaseId!==value.leaseId||
       completion.hostRevision!==old.revision||completion.durableRestartAuthority!==true||
       completion.anchorIdentity!==anchorIdentity||completion.metadataIdentity!==value.metadataIdentity||
       completion.localDirectoryIdentity!==value.localDirectoryIdentity||completion.databaseIdentity!==value.databaseIdentity||
       !same(completion.owners,owners.map(row=>({id:row.id,revision:row.revision}))))
      throw refused();
    try{
      const receipt=await request('compareAndPutReceipt',{operationId:releaseId,comparison:{
        expectedCollections:{[collection]:[{id,value,revision:old.revision}],
          [ownersCollection]:owners.map(row=>({id:row.id,value:row.value,revision:row.revision})),
          [releasesName]:releases.filter(row=>row.id!==releaseId)},
        records:[{collection:releasesName,id:releaseId,value:completion,expectedRevision:completionRow.revision-1}]}});
      if(!same(receipt,{committed:true,revisions:[{collection:releasesName,id:releaseId,revision:completionRow.revision}]}))throw refused();
    }catch(cause){
      if(cause.code==='STORAGE_OPERATION_CONFLICT')throw refused();
      throw cause;
    }
    return {owners,releases,releaseId,releasesName};
  };
  try{
    if(cold)file=cold.file;
    else {
    try{file=parent.openPrivateTreeFile(path.basename(anchor));}
    catch(error){
      // Share denial is not an absence verdict. The UI may offer explicit
      // inspection, which still verifies the original host/Jobs before mutation.
      if(error.code==='WIN32_IO_ERROR'&&error.win32Code===32){error.recoveryRequired=true;error.automaticReplay=false;}
      if(error.code!=='WIN32_IO_ERROR'||![2,3].includes(error.win32Code))throw error;
      // Create-only CAS; a competing winner or uncertain publication is never
      // overwritten or removed. The subsequent writable pin arbitrates custody.
      await createExperimentalWindowsPersistence(location.root).writeAtomic(location.relative,JSON.stringify({schema:1,scope:'explicit-host-custody-anchor',projectId}));
      created=true;file=parent.openPrivateTreeFile(path.basename(anchor));
    }
    }
    const stat=cold?{identity:cold.file.identity}:file.stat();
    if(!cold){
    if(stat.size>4096n||stat.size===0n)throw fail('HOST_LEASE_ANCHOR_INVALID','Invalid host custody anchor size');
    const content=file.readAt(0,Number(stat.size));
    if(content.toString('utf8')!==JSON.stringify({schema:1,scope:'explicit-host-custody-anchor',projectId}))
      throw fail('HOST_LEASE_ANCHOR_INVALID','Host custody anchor belongs to another project or format');
    }
    // Let the shared worker initialize its actual schema under its own native
    // database lease. Precreating an empty .sqlite would be an existing invalid
    // database to that worker and must not be mistaken for initialization.
    await storage.db.request(database,'record',{collection,id});
    const dbLocation=managedStorageLocation(storage,database,{code:'HOST_LEASE_UNSUPPORTED'});
    dbParent=openExperimentalPersistenceParent(dbLocation.root,dbLocation.relative);dbPin=dbParent.openPrivateDatabase('ui.sqlite',true);
    processPin=openExperimentalProcessIdentity(process.pid);
    sources=await openExperimentalHostSources({storage,project,...(cold?{expected:cold.source}:{})});verify();
    const old=await request('record',{id}),prior=previousRelease&&released.get(previousRelease);
    const anchorIdentity=stat.identity;
    let confirmedRelease=null;
    if(cold){await cold.check();if(!same(old,cold.host))throw fail('STORAGE_CONFLICT','Cold retired host has another winner');}
    else if(previousRelease||prior){
      if(!prior||prior.storage!==storage||prior.projectId!==projectId||prior.anchorIdentity!==anchorIdentity||
         prior.used||old?.revision!==prior.revision||!same(old?.value,prior.record))
        throw fail('HOST_LEASE_RECOVERY_REQUIRED','Existing custody needs cold source/Job recovery; file availability cannot authorize a new host',{
          automaticReplay:false,previousHost:old,anchorIdentity,coldRecoveryQualified:false});
      prior.used=true;
    }else if(!(created&&old===null)){
      if(created||old===null)
        throw fail('HOST_LEASE_RECOVERY_REQUIRED','Existing custody needs cold source/Job recovery; file availability cannot authorize a new host',{
          automaticReplay:false,previousHost:old,anchorIdentity,coldRecoveryQualified:false});
      // No retained receipt exists for a fresh process: only the terminal
      // durable normal-release publication of this exact generation, verified
      // under the exclusive anchor, may authorize one successor activation.
      confirmedRelease=await verifyReleasedGeneration(old,anchorIdentity);
    }
    const owners=await request('list',{collection:ownersCollection});
    if(owners.length&&!(cold?same(owners,cold.owners):prior?same(owners,prior.owners):confirmedRelease&&same(owners,confirmedRelease.owners)))throw fail('HOST_LEASE_RECOVERY_REQUIRED','Existing owner registrations need their original custody proof; no host activation',{automaticReplay:false});
    for(const row of owners)retirements.set(row.id,{record:row.value,revision:row.revision});
    const leaseId=randomUUID();launchSet=createExperimentalHostLaunchSet(leaseId,sources.record);
    record=frozen({schema:1,scope:'explicit-live-host-custody',projectId,instanceId:project.instanceId,leaseId,launchSet:{schema:1,id:launchSet.id,limit:launchSet.limit},
      anchorIdentity,metadataIdentity:parent.identity(),localDirectoryIdentity:dbParent.identity(),
      databaseIdentity:dbPin.identity(),source:sources.record,
      host:processPin.snapshot(),phase:'active',automaticReplay:false,createdAt:new Date().toISOString(),
      ...(cold?{coldPredecessor:{schema:1,retirementId:cold.retirementId,retirementOperationId:cold.host.value.coldRetirement.operationId}}:{})});
    // Validate the restricted original anchor's metadata/source binding before
    // any activation write. Closing this bundle never closes the original pin.
    if(cold){const bundle=sources.createCustody(file,dbPin,parent);bundle.close();}
    let result;
    if(cold)result=await cold.activate(record);
    else if(confirmedRelease){
      // One atomic full-set successor activation: the verified retired host,
      // the complete owner set and this generation's exact completion
      // membership are compared together, so exactly one successor can commit.
      const expected={committed:true,revisions:[{collection,id,revision:old.revision+1}]};
      let activated;
      try{
        activated=await cas(record.leaseId+':active',
          {[collection]:[{id,value:old.value,revision:old.revision}],
           [ownersCollection]:owners.map(row=>({id:row.id,value:row.value,revision:row.revision})),
           [confirmedRelease.releasesName]:confirmedRelease.releases},
          [{collection,id,value:record,expectedRevision:old.revision}],
          'Host successor activation needs explicit recovery; no replay');
      }catch(cause){
        if(cause.code==='STORAGE_CONFLICT')
          throw fail('HOST_LEASE_RECOVERY_REQUIRED','Confirmed normal release has another winner; successor activation refused',
            {cause,automaticReplay:false,previousHost:old,anchorIdentity,coldRecoveryQualified:false});
        throw cause;
      }
      if(!same(activated,expected))throw fail('HOST_LEASE_BINDING_CHANGED','Successor activation receipt differs from the verified retired generation');
      result={revision:expected.revisions[0].revision};
    }
    else result=await request('put',{id,value:record,expectedRevision:old?.revision??0,operationId:record.leaseId+':active'});
    revision=result.revision;phase='active';
  }catch(error){closePins();throw error;}
  const value={storage,projectId,record,claims,retirements,supervisors,supervisorLaunches,verify,get phase(){return phase;},
    reserve(launchId){
      verify();if(nativeClaims.has(launchId))throw fail('HOST_LAUNCH_SET_DUPLICATE','Launch already reserved');
      const claim=launchSet.reserve(launchId);nativeClaims.set(launchId,claim);
    },
    supervise(job,launchId,ownerHome){
      verify();
      // Direct component supervision is also recorded; without a corresponding
      // owner row it deliberately cannot qualify managed cold recovery.
      if(launchId===undefined){launchId=randomUUID();this.reserve(launchId);}
      const claim=nativeClaims.get(launchId);
      if(!claim)throw fail('HOST_LAUNCH_SET_INVALID','Launch must be natively reserved before Job allocation');
      const bundle=sources.createCustody(file,dbPin,cold?parent:undefined,ownerHome);
      try{const pin=startExperimentalProcessSupervisor(job,bundle,claim);supervisors.add(pin);supervisorLaunches.set(pin,launchId);return pin;}
      finally{bundle.close();}
    },
    async checkRegistration(){
      const current=await request('record',{id});
      if(current?.revision!==revision||!same(current.value,record))throw fail('HOST_LEASE_BINDING_CHANGED','Host custody record changed');
    },
    readOwner:target=>request('record',{collection:'managed_owner_launches',id:target}),
  };
  const lease=Object.freeze({
    facts(){verify();return frozen({...record,revision,state:phase,pendingLaunches:claims.size,coldRecoveryQualified:false});},
    verify(){verify();},
    release(){
      if(phase==='closed')return Promise.reject(fail('HOST_LEASE_CLOSED','Host custody pins closed'));
      // Seal admission before awaiting queued storage/projection work.
      phase='stopping';
      return releaseFlight??=(async()=>{
        verify();if(claims.size)throw fail('HOST_LEASE_BUSY','Retained launch claims have not retired');
        if([...supervisors].some(pin=>!experimentalSupervisorShutdownObserved(pin)))
          throw fail('HOST_LEASE_BUSY','Original custody supervisors have not confirmed shutdown');
        const owners=await request('list',{collection:'managed_owner_launches'});
        if(owners.length!==retirements.size||owners.some(row=>row.value.phase!=='retired'||
          row.revision!==retirements.get(row.id)?.revision||!same(row.value,retirements.get(row.id)?.record)))
          throw fail('HOST_LEASE_BUSY','Owner registrations differ from the retained confirmed retirements');
        const current=await request('record',{id});
        if(current?.revision!==revision||!same(current?.value,record))throw fail('STORAGE_CONFLICT','Host custody registration has another winner');
        const next=frozen({...record,phase:'retired',retiredAt:new Date().toISOString()});
        const result=await request('put',{id,value:next,expectedRevision:revision,operationId:record.leaseId+':retired'});
        try{
          const afterOwners=await request('list',{collection:'managed_owner_launches'}),after=await request('record',{id});
          if(!same(afterOwners,owners)||after?.revision!==result.revision||!same(after.value,next))
            throw fail('HOST_LEASE_BINDING_CHANGED','Custody or owner records changed during host retirement');
        }catch(cause){
          fence=fail('STORAGE_RESULT_UNKNOWN','Host retirement postcheck failed; custody retained',{cause,automaticReplay:false,
            commitUnknown:{projectId,database,operationId:record.leaseId+':retired'}});throw fence;
        }
        // Terminal durable normal-release publication. Issued strictly after
        // every prerequisite above — sealed admission, retired launch claims,
        // observed supervisor shutdown, exact owner retirements, the committed
        // retirement and its postcheck — it is the only restart authority, and
        // deliberately not the caller receipt below. Its comparison binds the
        // exact retired host, the complete owner set and this generation's
        // exact completion membership; a lost reply stays UNKNOWN to this
        // issuer, while a later opener reconciles it read-only without replay.
        const releaseId=record.leaseId+':normal-release',releasesName=releasesCollection+':'+record.leaseId;
        const releases=await request('list',{collection:releasesName});
        if(releases.length)
          throw fail('STORAGE_CONFLICT','Durable normal-release completion already exists for this host',{automaticReplay:false});
        const completion=frozen({schema:1,scope:'windows-managed-normal-release-completion',projectId,instanceId:project.instanceId,
          leaseId:record.leaseId,hostRevision:result.revision,retiredAt:next.retiredAt,
          anchorIdentity:record.anchorIdentity,metadataIdentity:record.metadataIdentity,
          localDirectoryIdentity:record.localDirectoryIdentity,databaseIdentity:record.databaseIdentity,
          owners:owners.map(row=>({id:row.id,revision:row.revision})),
          prerequisites:{admissionSealed:true,launchClaimsRetired:true,supervisorsShutdownObserved:true,
            ownerRetirementsExact:true,hostRetirementPostchecked:true},
          durableRestartAuthority:true,executionAcknowledged:false,
          ownerReleaseQualified:false,coldRecoveryQualified:false,automaticReplay:false});
        const publication=await cas(releaseId,
          {[collection]:[{id,value:next,revision:result.revision}],
           [ownersCollection]:owners.map(row=>({id:row.id,value:row.value,revision:row.revision})),
           [releasesName]:releases},
          [{collection:releasesName,id:releaseId,value:completion,expectedRevision:0}],
          'Host normal-release publication needs explicit recovery; no replay');
        if(!same(publication,{committed:true,revisions:[{collection:releasesName,id:releaseId,revision:1}]}))
          throw fail('HOST_LEASE_BINDING_CHANGED','Durable normal-release publication differs from the expected completion');
        // This is a disposal receipt, not cold-release or restart authority (the
        // durable completion above is). It proves only that the native handles
        // and supervised Jobs were postchecked before the lease pins closed;
        // owner homes and historical recovery records stay.
        const disposal=frozen({schema:1,scope:'windows-native-helper-and-host-custody-disposal-only',nativeSupervisorsShutdown:true,
          ownerLaunchClaimsRetired:true,hostRecordRetired:true,ownerHomesRetained:true,historicalRecoveryRecordsRetained:true,
          ownerReleaseQualified:false,coldRecoveryQualified:false,automaticReplay:false});
        const receipt=frozen({record:next,revision:result.revision,disposal,ownerReleaseQualified:false,coldRecoveryQualified:false,automaticReplay:false});
        released.set(receipt,{storage,projectId,anchorIdentity:record.anchorIdentity,record:next,revision:result.revision,owners,disposal,used:false});
        phase='closed';closePins();return receipt;
      })().finally(()=>{releaseFlight=undefined;});
    },
    // Explicit disposal has no successful retirement meaning. Persistent
    // markers/records remain for recovery, including an UNKNOWN outcome.
    abandon(){phase='closed';closePins();},
  });
  if(cold){try{await cold.finish(verify);coldBorrowed=false;}catch(error){closePins();throw error;}}
  live.set(lease,value);return lease;
}

export async function readExperimentalHostRetiredOwner(lease,{storage,projectId,target}={}){
  verifyExperimentalHostLease(lease,{storage,projectId});const held=state(lease);await held.checkRegistration();
  const original=held.retirements.get(target);if(!original)return null;
  const actual=await held.readOwner(target);
  if(actual?.revision!==original.revision||!same(actual.value,original.record)||actual.value.phase!=='retired')
    throw fail('HOST_LEASE_OWNER_UNVERIFIED','Exact retained retired owner changed before replacement');
  return original;
}

export async function recoverExperimentalColdProvider(lease,{storage,projectId,target,record}={}){
  const held=state(lease);
  if(!held.record.coldPredecessor)throw fail('HOST_LEASE_RECOVERY_REQUIRED','Original cold host handoff required for persisted provider recovery');
  const original=await readExperimentalHostRetiredOwner(lease,{storage,projectId,target}),owner=original?.record;
  const expected=owner&&{pid:owner.identity.pid,home:owner.home,ownerId:owner.ownerId,stamp:owner.identity.stamp,
    identity:owner.identity,generation:owner.generation,launchId:owner.launchId,kind:'pi-node'};
  const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  if(!owner?.coldRetirement||!same(canonical(record),canonical(expected)))
    throw fail('HOST_LEASE_OWNER_UNVERIFIED','Persisted provider differs from exact original cold owner');
  return frozen({verified:true,scope:'exact-cold-retired-process-registration-only',target,launchId:owner.launchId,
    retirementId:held.record.coldPredecessor.retirementId,executionAcknowledged:false,automaticReplay:false});
}
