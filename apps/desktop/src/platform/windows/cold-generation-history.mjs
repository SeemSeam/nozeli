// Resolve complete cold generations from retained records. Records only bind
// the proof: the caller must still retain every generation's native helpers.
import {createHash} from 'node:crypto';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=message=>Object.assign(Error(message),{code:'MANAGED_COLD_HISTORY_UNVERIFIED',automaticReplay:false});
const collection='managed_cold_retirements',maxGenerations=16,maxOwners=32;
export async function readColdGenerationHistory({storage,projectId,database,host,owners}){
 const bounded=name=>storage.db.request(database,'boundedList',{collection:name,maxRecords:16384,maxBytes:16*1024*1024,mustExist:true});
 const history=await bounded(collection),groups=[],visited=new Set(),retained=[];
 let current={host,owners,history:null};
 for(;;){
  const h=current.host?.value;
  if(!h||h.phase!=='active'||h.projectId!==projectId||h.instanceId!==host.value.instanceId||!h.leaseId||visited.has(h.leaseId)||
   groups.length>=maxGenerations||!same(h.source,host.value.source)||
   ['anchorIdentity','databaseIdentity','localDirectoryIdentity','metadataIdentity'].some(key=>h[key]!==host.value[key]))
   throw fail('Cold generation chain has a missing, repeated or replaced host/source');
  visited.add(h.leaseId);groups.push(current);
  const edge=h.coldPredecessor;
  if(!edge)break;
  const row=history.find(r=>r.id===edge.retirementId),v=row?.value,proof=v?.retirement;
  if(edge.schema!==1||!row||row.revision!==1||v.schema!==1||v.scope!=='original-cold-host-owner-generation-history'||
   v.projectId!==projectId||v.instanceId!==h.instanceId||v.host?.value?.leaseId!==row.id||
   !proof||proof.schema!==1||proof.scope!=='windows-cold-original-generation-record-retirement-only'||
   proof.hostLeaseId!==row.id||proof.anchorIdentity!==h.anchorIdentity||proof.operationId!==edge.retirementOperationId||
   proof.executionAcknowledged!==false||proof.pendingReconciled!==false||proof.automaticReplay!==false||
   !Array.isArray(v.ownerRecords)||!v.ownerRecords.length||!same(v.source,v.host.value.source))
   throw fail('Exact create-only predecessor retirement and complete owner ledger required');
  const expectedHost={value:{...v.host.value,phase:'retired',retiredAt:v.retiredAt,
   coldRetirement:{...proof,originalRevision:v.host.revision}},revision:v.host.revision+1};
  const expectedOwners=v.ownerRecords.map(owner=>owner.value.hostLeaseId===row.id?
   {id:owner.id,value:{...owner.value,phase:'retired',retiredAt:v.retiredAt,coldRetirement:{...proof,originalRevision:owner.revision}},revision:owner.revision+1}:owner);
  if(!same(v.retiredHost,expectedHost)||!same(v.retiredOwners,expectedOwners)||current.host.revision!==expectedHost.revision+1)
   throw fail('Retirement or subsequent activation revisions differ from original generation');
  const checkpoint=await storage.db.request(database,'record',{collection:'managed_cold_checkpoints',id:proof.checkpointId,mustExist:true});
  const summary=checkpoint?.value&&(({host,ownerRecords,operationId,recordedAt,...value})=>value)(checkpoint.value);
  if(!checkpoint||checkpoint.revision!==proof.checkpointRevision||sha(checkpoint)!==v.originalCheckpointSha256||
   !same(checkpoint.value.host,v.host)||!same(checkpoint.value.ownerRecords,v.ownerRecords)||
   proof.originalEvidenceSha256!==sha(summary)||checkpoint.value.hostLeaseId!==row.id||
   proof.checkpointId!==row.id+':'+checkpoint.value.operationId)
   throw fail('Original generation checkpoint, owner snapshots or evidence digest changed');
  const revisions=[{collection:'managed_host_leases',id:'host',revision:expectedHost.revision},
   ...expectedOwners.filter(owner=>owner.value.hostLeaseId===row.id).map(owner=>({collection:'managed_owner_launches',id:owner.id,revision:owner.revision})),
   {collection,id:row.id,revision:1}];
  const receipt=await storage.db.request(database,'receipt',{operationId:proof.operationId,mustExist:true});
  const hold=await storage.projectRequest(projectId,'receipt',{operationId:proof.holdOperationId});
  if(!same(receipt,{committed:true,revisions})||!same(hold,{committed:true}))
   throw fail('Original retirement or business hold operation receipt changed');
  const activation=await storage.db.request(database,'receipt',{operationId:h.leaseId+':cold-active',mustExist:true});
  if(!same(activation,{committed:true,revisions:[{collection:'managed_host_leases',id:'host',revision:current.host.revision}]}))
   throw fail('Exact next-host cold activation receipt required');
  retained.push({checkpointId:proof.checkpointId,checkpoint,operationId:proof.operationId,receipt,holdOperationId:proof.holdOperationId,hold,
   activationId:h.leaseId+':cold-active',activation});
  current={host:v.host,owners:v.ownerRecords,history:row};
 }
 if(history.length!==groups.length-1||history.some(row=>!visited.has(row.id)))
  throw fail('Full generation history contains an unexplained or missing generation');
 const ownerFail=message=>history.length?fail(message):Object.assign(fail(message),{code:'MANAGED_COLD_OWNER_SET_UNVERIFIED'});
 const launches=new Set(),endpoints=new Set();let total=0;
 for(const group of groups){
  const leaseId=group.host.value.leaseId;
  if(!Array.isArray(group.owners)||!group.owners.length||group.owners.length>maxOwners||new Set(group.owners.map(r=>r.id)).size!==group.owners.length)
   throw ownerFail('Bounded complete generation owner ledger required');
  group.prepared=[];
  for(const row of group.owners){
   const owner=row.value;
   if(!owner||owner.schema!==1||owner.target!==row.id||owner.projectId!==projectId||owner.instanceId!==host.value.instanceId)
    throw ownerFail('Generation owner does not match the exact project and instance');
   if(owner.hostLeaseId!==leaseId){
    const ancestor=groups.find(g=>g.host.value.leaseId===owner.hostLeaseId)?.history;
    if(owner.phase!=='retired'||!ancestor||!same(ancestor.value.retiredOwners.find(r=>r.id===row.id),row))
     throw ownerFail('Retired carryover lacks its exact retained ancestor revision');
    continue;
   }
   if(owner.phase!=='prepared'||!owner.identity||!owner.supervision||launches.has(owner.launchId)||
    !Number.isSafeInteger(row.revision)||row.revision<1)
    throw ownerFail('An intent, current retired row or duplicated launch cannot prove complete native history');
   const endpoint=owner.supervision.supervisorPid+':'+owner.supervision.supervisorCreationTime100ns;
   if(endpoints.has(endpoint)||++total>maxOwners)throw ownerFail('Historical native helper set is duplicated or exceeds its bound');
   launches.add(owner.launchId);endpoints.add(endpoint);group.prepared.push(row);
  }
  if(!group.prepared.length)throw ownerFail('Original native generation must have a nonempty complete Job set');
 }
 const verify=async(expected=history)=>{
  if(!same(await bounded(collection),expected))throw fail('Complete create-only generation history changed');
  for(const original of retained){
   if(!same(await storage.db.request(database,'record',{collection:'managed_cold_checkpoints',id:original.checkpointId,mustExist:true}),original.checkpoint)||
    !same(await storage.db.request(database,'receipt',{operationId:original.operationId,mustExist:true}),original.receipt)||
    !same(await storage.db.request(database,'receipt',{operationId:original.activationId,mustExist:true}),original.activation)||
    !same(await storage.projectRequest(projectId,'receipt',{operationId:original.holdOperationId}),original.hold))
    throw fail('Retained generation checkpoint or operation receipt changed');
  }
 };
 await verify();return {groups,history,verify};
}
