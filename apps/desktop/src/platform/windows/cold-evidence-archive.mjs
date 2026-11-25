// Preserve cold evidence before any resource-disposal decision. This module
// never stops a helper, removes an owner home, acknowledges a turn or replays.
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {openExperimentalPrivateTree} from './experimental-private-tree.mjs';
import {managedStorageLocation} from './managed-storage-scope.mjs';
import {openExperimentalPersistenceParent,createExperimentalWindowsPersistence} from './experimental-persistence.mjs';
import {ensureExperimentalPrivateDirectory} from './experimental-directories.mjs';
import {readColdBusinessCollections} from './cold-business-receipts.mjs';

const collection='managed_cold_archives';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code,message,extra={})=>Object.assign(Error(message),{code,automaticReplay:false,...extra});
const freeze=value=>{for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);return Object.freeze(value);};
const content=manifest=>manifest.entries.map(({relative,type,byteLength,sha256})=>({relative,type,...(type==='file'?{byteLength,sha256}:{})}));

// Only the original inspection supplies these bindings. Returned records are
// observations, never a token that can grant release or cold adoption.
export async function preserveColdEvidence({storage,projectId,directory,database,checkpoint,retirement,summary,observed,supervisors,journals,verify,verifyLedger,retainCheck}){
 const operationId=randomUUID(),trees=[],copies=[],owners=[];
 const base=path.join(directory,'cold-evidence'),destination=path.join(base,operationId);
 const location=managedStorageLocation(storage,destination),persistence=createExperimentalWindowsPersistence(location.root);
 const bounded=name=>storage.db.request(database,'boundedList',{collection:name,maxRecords:16384,maxBytes:16*1024*1024,mustExist:true});
 const receipts=[];
 let expectedArchives,committed=false,allocationStarted=false,stage='capturing',record,primaryError;
 const check=async()=>{
  if(!expectedArchives)return;
  if(!same(await bounded(collection),expectedArchives))
   throw fail('MANAGED_COLD_ARCHIVE_CHANGED','Complete archive ledger or exact operation receipt changed');
  for(const receipt of receipts)if(!same(await storage.db.request(database,'receipt',{operationId:receipt.id,mustExist:true}),receipt.value))
   throw fail('MANAGED_COLD_ARCHIVE_CHANGED','Original archive stage operation receipt changed');
 };
 const write=async(file,bytes)=>persistence.writeStream(path.relative(location.root,file).split(path.sep).join('/'),[Buffer.from(bytes)]);
 const close=()=>{for(const tree of [...copies,...trees].reverse())tree.close();};
 // Original journal verification deliberately opens writable flush handles.
 // Keep the source files read-locked during copying; compare business/pending
 // directly, then let the issuer run full journal checks after these close.
 const guard=async()=>{
  await verifyLedger();
  const business=await readColdBusinessCollections(storage,projectId);
  const pending=await storage.recoveryPage(projectId,{prefixes:['managed:pending:','managed:object-pending:','managed:publication:'],pendingOnly:true,
   purpose:'cold-business-receipts',limit:200,maxBytes:1024*1024});
  if(pending.nextCursor||journals.some(j=>j.toolCustody.businessReceipts.collectionsSha256!==sha(business)||
   j.toolCustody.businessReceipts.pendingRecoverySha256!==sha(pending)))
   throw fail('MANAGED_COLD_ARCHIVE_CHANGED','Original business or complete bounded pending page changed during archive');
  await verifyLedger();
 };
 try{
  await verify();
  let entries=0,total=0;
  for(let index=0;index<observed.length;index++){
   const {row,group}=observed[index],owner=row.value,journal=journals[index],homeLocation=managedStorageLocation(storage,owner.home);
   const tree=await openExperimentalPrivateTree(homeLocation.root,owner.home,{rootAccess:'readwrite',fileAccess:'read',maxEntries:10000-entries,maxBytes:512*1024*1024-total});trees.push(tree);
   const custody=supervisors[index].snapshot();
   if(!custody.ownerHomeDirectoryCustodyVerified||custody.ownerHomeIdentity!==tree.manifest.rootIdentity)
    throw fail('MANAGED_COLD_ARCHIVE_CHANGED','Observed home differs from the original helper-held directory');
   entries+=tree.manifest.entryCount;total+=tree.manifest.totalBytes;
   const relative=path.relative(owner.home,journal.sessionFile).split(path.sep).join('/');
   if(!tree.manifest.entries.some(e=>e.type==='file'&&e.relative===relative&&e.identity===journal.journalIdentity&&e.sha256===journal.journalSha256)||
    !tree.manifest.entries.some(e=>e.type==='file'&&e.relative==='nozeli-session-tools.json'&&e.identity===journal.metadataIdentity&&e.sha256===journal.metadataSha256))
    throw fail('MANAGED_COLD_ARCHIVE_CHANGED','Complete retained home lacks the exact original journal and metadata');
   for(const key of ['settingsReads','modelAuthReads','metadataReads','roleReads'])if(journal[key]){
    const expected=journal[key].observedEntries,prefix=path.relative(owner.home,journal[key].directory).split(path.sep).join('/');
    const actual=tree.manifest.entries.filter(e=>e.relative===prefix||e.relative.startsWith(prefix+'/'));
    if(!same(actual,expected))throw fail('MANAGED_COLD_ARCHIVE_CHANGED','Configuration evidence membership, original identities or bytes changed before archive');
   }
   owners.push({target:row.id,hostLeaseId:group.host.value.leaseId,launchId:owner.launchId,home:owner.home,
    sourceManifest:tree.manifest,homeIdentityObservedNow:true,originalHomeDirectoryCustodyQualified:true,originalHomeLifetimeCustodyQualified:false,
    archiveRelative:'owners/'+owner.launchId,streams:summary.owners[index].streams,journal});
  }
  await guard();
  const before={};for(const name of ['managed_host_leases','managed_owner_launches','managed_cold_checkpoints','managed_owner_tools','managed_cold_retirements',collection])before[name]=await bounded(name);
  const business=await readColdBusinessCollections(storage,projectId);
  const evidence={schema:1,scope:'complete-observed-cold-owner-homes-original-stdio-and-ledger-snapshot-only',projectId,
   instanceId:summary.instanceId,operationId,checkpoint,retirement,summary,owners:structuredClone(owners),localCollections:before,business,
   homeFiles:entries,homeBytes:total,originalHelpersRequired:true,ownerReleaseQualified:false,recoveryClosureQualified:false,automaticReplay:false};
  if(Buffer.byteLength(JSON.stringify(evidence))>64*1024*1024)throw fail('MANAGED_COLD_LIMIT','Cold archive evidence exceeds 64 MiB');
  const proof={schema:1,scope:evidence.scope,projectId,instanceId:summary.instanceId,operationId,destination,
   checkpointId:checkpoint.id,checkpointRevision:checkpoint.record.revision,retirementId:retirement.retirementId,
   sourceEvidenceSha256:sha(evidence),ownerLaunchIds:owners.map(o=>o.launchId),originalHelpersRequired:true,
   ownerReleaseQualified:false,recoveryClosureQualified:false,automaticReplay:false};
  record={...proof,phase:'intent'};
  const put=async(value,revision,comparison)=>{
   const id=operationId,op=operationId+':'+value.phase;
   const expected={committed:true,revisions:[{collection,id,revision:revision+1}]};
   const result=await storage.db.request(database,'compareAndPut',{operationId:op,expectedCollections:comparison,
    records:[{collection,id,value,expectedRevision:revision}],mustExist:true});
   committed=true;
   expectedArchives=[...comparison[collection].filter(row=>row.id!==id),{id,value,revision:revision+1}].sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
   receipts.push({id:op,value:expected});retainCheck(check);
   if(!same(result,expected))throw fail('MANAGED_COLD_ARCHIVE_CHANGED','Archive operation receipt differs from exact expected revision');
   await guard();await check();return result;
  };
  await guard();stage='intent';await put(record,0,before);
  stage='allocation';allocationStarted=true;
  await ensureExperimentalPrivateDirectory(location.root,base);await guard();
  const parent=openExperimentalPersistenceParent(location.root,location.relative);let pin;
  try{pin=parent.createPrivateDirectoryExclusive(operationId);pin.syncDirectory();parent.syncDirectory();pin.verify();parent.verify();}
  finally{pin?.close();parent.close();}
  await ensureExperimentalPrivateDirectory(location.root,path.join(destination,'owners'));
  await ensureExperimentalPrivateDirectory(location.root,path.join(destination,'streams'));
  stage='copy';
  for(let index=0;index<owners.length;index++){
   const owner=owners[index],target=path.join(destination,...owner.archiveRelative.split('/'));
   await guard();await trees[index].verify();
   await trees[index].copyTo(target,{destinationRoot:location.root,beforeEntry:()=>verifyLedger()});
   const copy=await openExperimentalPrivateTree(location.root,target,{rootAccess:'readwrite',fileAccess:'read'});copies.push(copy);
   if(!same(content(copy.manifest),content(trees[index].manifest)))throw fail('MANAGED_COLD_ARCHIVE_CHANGED','Independent owner archive differs from complete original file set');
   owner.archiveManifest=copy.manifest;
   const streamDirectory=path.join(destination,'streams',owner.launchId);await ensureExperimentalPrivateDirectory(location.root,streamDirectory);
   for(const [name,channel] of [['stdin',0],['stdout',1],['stderr',2]]){
    const expected=owner.streams[name],supervisor=supervisors[index];
    async function* bytes(){let offset=0;for(;;){await verifyLedger();const part=channel===0?supervisor.readInput(offset):supervisor.readOutput(channel,offset);
     if(part.state==='eof'){if(offset!==expected.bytes)throw fail('MANAGED_COLD_ARCHIVE_CHANGED','Original stream ended before its exact retained size');break;}
     if(part.state!=='data'||!part.bytes?.length||offset+part.bytes.length>expected.bytes)throw fail('MANAGED_COLD_ARCHIVE_CHANGED','Original archive stream changed');
     offset+=part.bytes.length;yield part.bytes;}}
    const file=path.join(streamDirectory,name+'.bin');
    await persistence.writeStream(path.relative(location.root,file).split(path.sep).join('/'),bytes(),{expectedNewSha256:expected.sha256});
   }
  }
  stage='manifest';
  const manifest={...evidence,archiveOwners:owners};await guard();
  if(Buffer.byteLength(JSON.stringify(manifest))>64*1024*1024)throw fail('MANAGED_COLD_LIMIT','Complete archive manifest exceeds 64 MiB');
  await write(path.join(destination,'manifest.json'),JSON.stringify(manifest));
  const archive=await openExperimentalPrivateTree(location.root,destination,{rootAccess:'readwrite',fileAccess:'read'});copies.push(archive);
  const manifestEntry=archive.manifest.entries.find(e=>e.relative==='manifest.json');
  if(!manifestEntry||manifestEntry.sha256!==createHash('sha256').update(JSON.stringify(manifest)).digest('hex'))throw fail('MANAGED_COLD_ARCHIVE_CHANGED','Persisted archive manifest differs');
  for(const owner of owners)for(const [name,expected] of Object.entries(owner.streams)){
   const entry=archive.manifest.entries.find(e=>e.relative==='streams/'+owner.launchId+'/'+name+'.bin');
   if(!entry||entry.byteLength!==expected.bytes||entry.sha256!==expected.sha256)throw fail('MANAGED_COLD_ARCHIVE_CHANGED','Independent archived stdio differs from original native digest');
  }
  await guard();for(const tree of trees)await tree.verify();await archive.verify();
  record={...proof,phase:'ready',archiveIdentity:archive.manifest.rootIdentity,archiveManifestSha256:archive.manifest.sha256,
   manifestSha256:manifestEntry.sha256,archiveEntries:archive.manifest.entryCount,archiveBytes:archive.manifest.totalBytes,
   barriers:{files:'flushed',directories:'flushed',namespace:'not-qualified'}};
  stage='ready';await put(record,1,{...before,[collection]:expectedArchives});
  await archive.verify();for(const tree of trees)await tree.verify();await guard();await check();
  return freeze({...record,revision:2});
 }catch(cause){
  primaryError=committed||allocationStarted||cause.committed||cause.code==='STORAGE_RESULT_UNKNOWN'||cause.commitUnknown?
   fail('STORAGE_RESULT_UNKNOWN','Cold archive requires explicit reconciliation; originals and partial destination retained, no retry',
    {cause,commitUnknown:{projectId,database,operationId,stage},archiveDestination:destination,ownerReleaseQualified:false}):cause;
  throw primaryError;
 }finally{
  try{close();}catch(cause){if(primaryError)primaryError.cleanupErrors=[...(primaryError.cleanupErrors??[]),cause];
   else throw fail('STORAGE_RESULT_UNKNOWN','Cold archive final pin closure needs explicit reconciliation',{cause,commitUnknown:{projectId,database,operationId,stage},archiveDestination:destination});}
 }
}
