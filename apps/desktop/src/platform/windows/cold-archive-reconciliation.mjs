import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {managedStorageLocation} from './managed-storage-scope.mjs';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';
import {openExperimentalPrivateTree} from './experimental-private-tree.mjs';
import {inspectColdSettingsReads,readColdSettingsFrames} from './cold-settings-reads.mjs';
import {inspectColdMetadataReads} from './cold-metadata-reads.mjs';
import {inspectColdRoleReads} from './cold-role-reads.mjs';

const collection='managed_cold_archives';
const scope='complete-observed-cold-owner-homes-original-stdio-and-ledger-snapshot-only';
const collections=['managed_host_leases','managed_owner_launches','managed_cold_checkpoints','managed_owner_tools','managed_cold_retirements',collection];
const flags={originalHelpersRequired:true,ownerReleaseQualified:false,recoveryClosureQualified:false,automaticReplay:false};
const releaseBoundary=Object.freeze({schema:1,available:false,scope:'cold-archive-only-no-home-deletion-or-released-ancestor-reader',reason:'Exact-set archived-home disposal and released-ancestor reader are not qualified',automaticReplay:false});
const same=isDeepStrictEqual;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=value=>digest(JSON.stringify(value));
const expectedReceipt=(id,revision)=>({committed:true,revisions:[{collection,id,revision}]});

// Shared by the independent receipt reader and native synthetic archive tests.
// The caller authenticates the archive tree and operation receipts separately.
export async function inspectArchivedColdOwnerMaterials(tree,owner,refused=message=>Object.assign(Error(message),{code:'MANAGED_COLD_ARCHIVE_UNVERIFIED',automaticReplay:false})){
 const stream=async name=>{
  const relative='streams/'+owner.launchId+'/'+name+'.bin',entry=tree.manifest.entries.find(e=>e.relative===relative),expected=owner.streams[name];
  if(!entry||entry.byteLength!==expected.bytes||entry.sha256!==expected.sha256)throw refused('Archived configuration stdio differs from original stream receipt');
  return readColdSettingsFrames(await tree.readFile(relative,{maxBytes:64*1024*1024}));
 };
 const requests=await stream('stdin'),transcript=await stream('stdout'),starts=transcript.filter(r=>r.method==='start'&&r.result);
 if(starts.length!==1||starts[0].ownerLaunch?.launchId!==owner.launchId||starts[0].ownerLaunch?.home!==owner.home)
  throw refused('Archived configuration stream has no unique bound original launch');
 // Original FileIDs bind SOURCE members; archive copies bind only bytes.
 const copyEntries=tree.manifest.entries.filter(e=>e.relative===owner.archiveRelative||e.relative.startsWith(owner.archiveRelative+'/'));
 const content=rows=>rows.map(e=>({relative:e.relative,type:e.type,...(e.type==='file'?{byteLength:e.byteLength,sha256:e.sha256}:{})}));
 const copied=copyEntries.map(e=>({...e,relative:e.relative===owner.archiveRelative?'':e.relative.slice(owner.archiveRelative.length+1)}));
 if(!same(content(copied),content(owner.sourceManifest.entries)))throw refused('Archived home content differs from the complete original source manifest');
 const materials={};
 for(const [kind,key,schema] of [['settings','settingsReads',2],['model-auth','modelAuthReads',1]]){
  const observed=await inspectColdSettingsReads({launch:starts[0].ownerLaunch,requests,transcript,manifest:owner.sourceManifest,kind,
   readFile:(relative,options)=>tree.readFile(owner.archiveRelative+'/'+relative,options)});
  const original=owner.journal[key];
  if(original?.schema===schema){
   if(!same(observed,original))throw refused('Independent configuration interpretation differs from the original cold observation');
   materials[key]={launchId:owner.launchId,...observed};
  }else{
   materials[key]={launchId:owner.launchId,...observed,state:'legacy-unverified',completeObservedSet:false,
    reason:original?'unsupported-original-material-schema':'missing-original-material-observation'};
  }
 }
 const metadata=owner.sourceManifest.entries.find(e=>e.relative==='nozeli-session-tools.json');
 const observed=await inspectColdMetadataReads({launch:starts[0].ownerLaunch,requests,transcript,manifest:owner.sourceManifest,
  current:metadata?{identity:metadata.identity,sha256:metadata.sha256,parentIdentity:owner.sourceManifest.rootIdentity}:undefined,
  readFile:(relative,options)=>tree.readFile(owner.archiveRelative+'/'+relative,options)});
 if(owner.journal.metadataReads?.schema===1){
  if(!same(observed,owner.journal.metadataReads))throw refused('Independent metadata interpretation differs from original cold observation');
  materials.metadataReads={launchId:owner.launchId,...observed};
 }else materials.metadataReads={launchId:owner.launchId,...observed,state:'legacy-unverified',completeObservedSet:false};
 const roleObserved=await inspectColdRoleReads({launch:starts[0].ownerLaunch,requests,transcript,manifest:owner.sourceManifest,
  readFile:(relative,options)=>tree.readFile(owner.archiveRelative+'/'+relative,options)});
 if(owner.journal.roleReads?.schema===2){
  if(!same(roleObserved,owner.journal.roleReads))throw refused('Independent role skill interpretation differs from the original cold observation');
  materials.roleReads={launchId:owner.launchId,...roleObserved};
 }else materials.roleReads={launchId:owner.launchId,...roleObserved,state:'legacy-unverified',completeObservedSet:false,
  reason:owner.journal.roleReads?'unsupported-original-material-schema':'missing-original-material-observation'};
 return materials;
}
// Observations do not grant adoption, release, or authority to replay an
// archive write. A fresh caller needs only the registered project and UUID.
export async function reconcileWindowsManagedColdArchive({storage,projectId,operationId}={}){
 if(typeof operationId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId))
  throw Object.assign(Error('Exact cold archive operation UUID required'),{code:'MANAGED_COLD_RECEIPT_INVALID',automaticReplay:false});
 const refused=(message,cause)=>Object.assign(Error(message,{cause}),{code:'MANAGED_COLD_ARCHIVE_UNVERIFIED',operationId,automaticReplay:false});
 storage.assertLocalOpen(projectId);
 const project=structuredClone(await storage.requireOnline(projectId));
 const directory=await storage.localDirectory(projectId,{create:false}),database=path.join(directory,'ui.sqlite');
 const {root,relative}=managedStorageLocation(storage,database,{code:'MANAGED_COLD_UNSUPPORTED'});
 const destination=path.join(directory,'cold-evidence',operationId);
 const request=(op,args)=>storage.db.request(database,op,{...args,mustExist:true});
 const record=(collection,id)=>request('boundedRecord',{collection,id,maxBytes:16*1024*1024});
 const receipt=phase=>request('receipt',{operationId:operationId+':'+phase});
 const observe=async()=>({row:await record(collection,operationId),intent:await receipt('intent'),ready:await receipt('ready')});
 const observation=(state,reason,extra)=>Object.freeze({schema:1,projectId,instanceId:project.instanceId,operationId,state,reason,...extra,...flags,release:releaseBoundary});
 let parent,local,tree;
 try{
  parent=openExperimentalPersistenceParent(root,relative);
  local=parent.openPrivateDatabase('ui.sqlite',true);
  const first=await observe(),{row,intent,ready}=first;
  const recheck=async()=>{
   if(!same(await storage.requireOnline(projectId),project)||await storage.localDirectory(projectId,{create:false})!==directory||
      !same(await observe(),first))throw refused('Archive row, receipts or registered instance changed during verification');
   storage.assertLocalOpen(projectId);parent.verify();local.verify();
  };
  if(!row){await recheck();return observation('unknown',intent||ready?'receipt-without-record':'no-record');}
  const value=row.value;
  if(value?.schema!==1||value.scope!==scope||value.projectId!==projectId||value.instanceId!==project.instanceId||
     value.operationId!==operationId||value.destination!==destination||
     Object.entries(flags).some(([key,expected])=>value[key]!==expected)||!same(intent,expectedReceipt(operationId,1)))
   throw refused('Archive row does not bind the registered operation, destination and intent receipt');
  if(row.revision===1&&value.phase==='intent'&&!ready){await recheck();return observation('unknown','intent-only',{revision:1});}
  if(row.revision!==2||value.phase!=='ready'||!same(ready,expectedReceipt(operationId,2)))
   throw refused('Ready row and original operation receipt disagree');
  tree=await openExperimentalPrivateTree(root,destination,{rootAccess:'readwrite',fileAccess:'read',expectedIdentity:value.archiveIdentity});
  const bytes=await tree.readFile('manifest.json',{maxBytes:64*1024*1024});
  if(tree.manifest.sha256!==value.archiveManifestSha256||tree.manifest.entryCount!==value.archiveEntries||
     tree.manifest.totalBytes!==value.archiveBytes||digest(bytes)!==value.manifestSha256)
   throw refused('Archive tree or manifest differs from the committed ready row');
  const {archiveOwners,...source}=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const before=source.localCollections;
  if(source.schema!==1||source.scope!==scope||source.projectId!==projectId||source.instanceId!==project.instanceId||
     source.operationId!==operationId||sha(source)!==value.sourceEvidenceSha256||
     !Array.isArray(source.owners)||!source.owners.length||source.owners.length>32||
     !same(source.owners.map(owner=>owner.launchId),value.ownerLaunchIds)||
     !Array.isArray(archiveOwners)||!same(archiveOwners.map(({archiveManifest,...owner})=>owner),source.owners)||
     !before||Object.keys(before).length!==collections.length||collections.some(name=>!Array.isArray(before[name]))||
     before[collection].some(row=>row.id===operationId))
   throw refused('Archive manifest does not match the original evidence and comparison set');
  const {checkpoint,retirement}=source,history=before.managed_cold_retirements.find(row=>row.id===value.retirementId);
  const savedCheckpoint=before.managed_cold_checkpoints.find(row=>row.id===value.checkpointId);
  if(!history||history.revision!==1||history.value.projectId!==projectId||history.value.instanceId!==project.instanceId||
     retirement?.retirementId!==value.retirementId||retirement.operationId!==history.value.retirement?.operationId||
     checkpoint?.id!==value.checkpointId||checkpoint.record?.revision!==value.checkpointRevision||
     !same(savedCheckpoint,{id:checkpoint.id,...checkpoint.record})||history.value.originalCheckpointSha256!==sha(checkpoint.record)||
     history.value.host?.value?.databaseIdentity!==local.identity()||history.value.host.value.localDirectoryIdentity!==parent.identity())
   throw refused('Archive does not bind the original database, checkpoint and retirement');
  const compareReceipt=async(phase,expectedCollections,recordValue,revision)=>{
   const committed=await request('compareAndPutReceipt',{operationId:operationId+':'+phase,
    comparison:{expectedCollections,records:[{collection,id:operationId,value:recordValue,expectedRevision:revision-1}]}});
   if(!same(committed,expectedReceipt(operationId,revision)))throw refused('Archive receipt does not bind the original comparison');
  };
  const {archiveIdentity,archiveManifestSha256,manifestSha256,archiveEntries,archiveBytes,barriers,...base}=value;
  const intentValue={...base,phase:'intent'};
  const archives=[...before[collection],{id:operationId,value:intentValue,revision:1}]
   .sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
  const checkHistory=async()=>{
   if(!same(await record('managed_cold_retirements',history.id),{value:history.value,revision:1})||
      !same(await record('managed_cold_checkpoints',checkpoint.id),checkpoint.record))
    throw refused('The original checkpoint or retirement row changed');
  };
  await checkHistory();
  await compareReceipt('intent',before,intentValue,1);
  await compareReceipt('ready',{...before,[collection]:archives},value,2);
  const settingsReads=[],modelAuthReads=[],metadataReads=[],roleReads=[];
  for(const owner of archiveOwners){
   const materials=await inspectArchivedColdOwnerMaterials(tree,owner,refused);
   settingsReads.push(materials.settingsReads);modelAuthReads.push(materials.modelAuthReads);metadataReads.push(materials.metadataReads);roleReads.push(materials.roleReads);
  }
  await tree.verify();await checkHistory();await recheck();
  await compareReceipt('intent',before,intentValue,1);
  await compareReceipt('ready',{...before,[collection]:archives},value,2);
  await recheck();
  return observation('ready-verified','original-commits-and-archive-observed',{revision:2,archiveIdentity,archiveManifestSha256,manifestSha256,archiveEntries,archiveBytes,settingsReads,modelAuthReads,metadataReads,roleReads});
 }catch(cause){
  if(cause.code==='MANAGED_COLD_ARCHIVE_UNVERIFIED')throw cause;
  throw refused('Cold archive could not be verified; preserve the original evidence',cause);
 }finally{try{tree?.close();}finally{try{local?.close();}finally{parent?.close();}}}
}

const disposalCollection='managed_cold_disposals';
const disposalScope='exact-archived-home-disposal-plan-no-deletion-until-released-reader-qualified';
export async function prepareWindowsManagedColdDisposal({storage,projectId,operationId}={}){
 const verified=await reconcileWindowsManagedColdArchive({storage,projectId,operationId});
 if(verified.state!=='ready-verified')throw Object.assign(Error('A ready verified archive is required before disposal planning'),{code:'MANAGED_COLD_DISPOSAL_UNQUALIFIED',automaticReplay:false});
 const directory=await storage.localDirectory(projectId,{create:false}),database=path.join(directory,'ui.sqlite');
 const {root,relative}=managedStorageLocation(storage,database,{code:'MANAGED_COLD_UNSUPPORTED'}),request=(op,args)=>storage.db.request(database,op,{...args,mustExist:true});
 const bounded=name=>request('boundedList',{collection:name,maxRecords:16384,maxBytes:16*1024*1024});
 const record=await request('boundedRecord',{collection, id:operationId,maxBytes:16*1024*1024}),archiveRow={id:operationId,...record},before=await bounded(disposalCollection);
 const parent=openExperimentalPersistenceParent(root,relative),tree=await openExperimentalPrivateTree(root,record.value.destination,{rootAccess:'readwrite',fileAccess:'read',expectedIdentity:record.value.archiveIdentity});
 try{
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await tree.readFile('manifest.json',{maxBytes:64*1024*1024}))),owners=manifest.archiveOwners?.map(owner=>({launchId:owner.launchId,home:owner.home,homeIdentity:owner.sourceManifest?.rootIdentity,sourceManifestSha256:owner.sourceManifest?.sha256,archiveRelative:owner.archiveRelative}))??[];
  if(!owners.length||owners.some(owner=>typeof owner.launchId!=='string'||typeof owner.home!=='string'||typeof owner.homeIdentity!=='string'||typeof owner.sourceManifestSha256!=='string'))throw Object.assign(Error('Archive lacks an exact owner-home disposal set'),{code:'MANAGED_COLD_DISPOSAL_UNQUALIFIED',automaticReplay:false});
  const prerequisites=Object.freeze({archiveVerified:true,exactOwnerHomeSet:true,originalHelpersReleased:false,releasedAncestorReaderQualified:false,namespaceDurabilityQualified:false,homeDeletionAuthorized:false,automaticReplay:false});
  const base={schema:1,scope:disposalScope,projectId,operationId,archiveOperationId:operationId,archiveRevision:record.revision,archiveManifestSha256:record.value.archiveManifestSha256,owners,prerequisites,release:releaseBoundary,deletionStarted:false,deletionCompleted:false,ownerReleaseQualified:false,recoveryClosureQualified:false,automaticReplay:false};
  const expectedIntent={committed:true,revisions:[{collection:disposalCollection,id:operationId,revision:1}]},intent={...base,phase:'intent'};
  const intentResult=await request('compareAndPut',{operationId:operationId+':disposal-intent',expectedCollections:{[collection]:[archiveRow],[disposalCollection]:before},records:[{collection:disposalCollection,id:operationId,value:intent,expectedRevision:0}]});
  if(!same(intentResult,expectedIntent))throw Object.assign(Error('Disposal intent receipt differs from the expected CAS result'),{code:'MANAGED_COLD_DISPOSAL_UNQUALIFIED',automaticReplay:false});
  const ready={...base,phase:'ready',intentReceipt:expectedIntent},expectedReady={committed:true,revisions:[{collection:disposalCollection,id:operationId,revision:2}]};
  const readyResult=await request('compareAndPut',{operationId:operationId+':disposal-ready',expectedCollections:{[collection]:[archiveRow],[disposalCollection]:[{id:operationId,value:intent,revision:1}]},records:[{collection:disposalCollection,id:operationId,value:ready,expectedRevision:1}]});
  if(!same(readyResult,expectedReady))throw Object.assign(Error('Disposal ready receipt differs from the expected CAS result'),{code:'MANAGED_COLD_DISPOSAL_UNQUALIFIED',automaticReplay:false});
  return Object.freeze({schema:1,state:'ready',available:false,operationId,owners,prerequisites,release:releaseBoundary,deletionStarted:false,deletionCompleted:false,ownerReleaseQualified:false,recoveryClosureQualified:false,automaticReplay:false});
 }catch(cause){if(cause.code==='MANAGED_COLD_DISPOSAL_UNQUALIFIED')throw cause;throw Object.assign(Error('Disposal plan outcome is unknown; retain every original home and archive',{cause}),{code:'STORAGE_RESULT_UNKNOWN',automaticReplay:false,commitUnknown:{projectId,database,operationId,stage:'disposal-plan'}});}
 finally{tree.close();parent.close();}
}

export async function openWindowsReleasedColdArchiveReader({storage,projectId,operationId}={}){
 if(typeof operationId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId))throw Object.assign(Error('Exact disposal operation UUID required'),{code:'MANAGED_COLD_RECEIPT_INVALID',automaticReplay:false});
 const verified=await reconcileWindowsManagedColdArchive({storage,projectId,operationId});
 if(verified.state!=='ready-verified')throw Object.assign(Error('Original archive receipts and complete material evidence required'),{code:'MANAGED_COLD_DISPOSAL_UNQUALIFIED',automaticReplay:false});
 storage.assertLocalOpen(projectId);const directory=await storage.localDirectory(projectId,{create:false}),database=path.join(directory,'ui.sqlite');
 const {root}=managedStorageLocation(storage,database,{code:'MANAGED_COLD_UNSUPPORTED'}),request=(op,args)=>storage.db.request(database,op,{...args,mustExist:true});
 const plan=await request('boundedRecord',{collection:disposalCollection,id:operationId,maxBytes:16*1024*1024}),archive=await request('boundedRecord',{collection,id:operationId,maxBytes:16*1024*1024});
 const reject=message=>Object.assign(Error(message),{code:'MANAGED_COLD_DISPOSAL_UNQUALIFIED',automaticReplay:false});
 if(!plan||!archive)throw reject('Original disposal and archive records required');
 if(plan.revision!==2||plan.value?.schema!==1||plan.value.scope!==disposalScope||plan.value.phase!=='ready'||plan.value.available!==undefined&&plan.value.available!==false||plan.value.deletionStarted||plan.value.deletionCompleted||plan.value.ownerReleaseQualified||plan.value.recoveryClosureQualified||plan.value.projectId!==projectId||plan.value.operationId!==operationId||plan.value.archiveRevision!==archive.revision||plan.value.archiveManifestSha256!==archive.value.archiveManifestSha256||archive.value.originalHelpersRequired!==true||archive.revision!==verified.revision||archive.value.archiveIdentity!==verified.archiveIdentity||archive.value.archiveManifestSha256!==verified.archiveManifestSha256)
  throw reject('Exact original ready disposal plan and verified retained archive required');
 const expectedIntent={committed:true,revisions:[{collection:disposalCollection,id:operationId,revision:1}]},expectedReady={committed:true,revisions:[{collection:disposalCollection,id:operationId,revision:2}]};
 if(!same(plan.value.intentReceipt,expectedIntent))throw reject('Original disposal intent receipt differs');
 const {intentReceipt,...base}=plan.value,intent={...base,phase:'intent'};
 const comparison={expectedCollections:{[collection]:[{id:operationId,...archive}],[disposalCollection]:[{id:operationId,value:intent,revision:1}]},records:[{collection:disposalCollection,id:operationId,value:plan.value,expectedRevision:1}]};
 const tree=await openExperimentalPrivateTree(root,archive.value.destination,{rootAccess:'readwrite',fileAccess:'read',expectedIdentity:archive.value.archiveIdentity}),snapshot={plan,archive};let closed=false;
 const check=async()=>{
  if(closed)throw Object.assign(Error('Released archive reader is closed'),{code:'MANAGED_COLD_CLOSED',automaticReplay:false});
  const currentPlan=await request('boundedRecord',{collection:disposalCollection,id:operationId,maxBytes:16*1024*1024}),currentArchive=await request('boundedRecord',{collection,id:operationId,maxBytes:16*1024*1024});
  if(!same(currentPlan,snapshot.plan)||!same(currentArchive,snapshot.archive))throw Object.assign(Error('Released archive disposal or archive record changed'),{code:'MANAGED_COLD_DISPOSAL_CHANGED',automaticReplay:false});
  try{
   if(!same(await request('receipt',{operationId:operationId+':disposal-intent'}),expectedIntent)||!same(await request('compareAndPutReceipt',{operationId:operationId+':disposal-ready',comparison}),expectedReady))throw reject('Original disposal commit receipt required');
  }catch(cause){throw Object.assign(reject('Disposal plan differs from its original committed comparison'),{cause});}
  await tree.verify();
 };
 try{
  await check();
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await tree.readFile('manifest.json',{maxBytes:64*1024*1024})));
  const owners=manifest.archiveOwners?.map(owner=>({launchId:owner.launchId,home:owner.home,homeIdentity:owner.sourceManifest?.rootIdentity,sourceManifestSha256:owner.sourceManifest?.sha256,archiveRelative:owner.archiveRelative}));
  if(!Array.isArray(owners)||!same(owners,plan.value.owners))throw reject('Disposal owner set differs from the verified original archive');
  const ownerFor=launchId=>{const owner=owners.find(row=>row.launchId===launchId);if(!owner)throw reject('Archive owner is outside the exact disposal set');return owner;};
  const pathRelative=value=>{if(typeof value!=='string'||!value||value.includes('\\')||value.includes(':')||path.posix.isAbsolute(value)||path.posix.normalize(value)!==value||value==='.'||value.startsWith('../')||value.includes('/../'))throw Object.assign(Error('Archive relative path rejected'),{code:'MANAGED_COLD_ARCHIVE_UNVERIFIED',automaticReplay:false});return value;};
  const read=async(relative,options)=>{await check();const bytes=await tree.readFile(relative,options);await check();return bytes;};
  await check();
  return Object.freeze({schema:1,scope:'released-cold-archive-read-only-no-replay',operationId,projectId,available:false,automaticReplay:false,ownerReleaseQualified:false,recoveryClosureQualified:false,async readOwnerFile(launchId,member,options){return read(ownerFor(launchId).archiveRelative+'/'+pathRelative(member),options);},async readStream(launchId,name,options){ownerFor(launchId);if(!['stdin','stdout','stderr'].includes(name))throw Object.assign(Error('Archive stream name rejected'),{code:'MANAGED_COLD_ARCHIVE_UNVERIFIED',automaticReplay:false});return read('streams/'+launchId+'/'+name+'.bin',options);},verify:check,close(){if(!closed){closed=true;tree.close();}}});
 }catch(error){tree.close();throw error;}
}
