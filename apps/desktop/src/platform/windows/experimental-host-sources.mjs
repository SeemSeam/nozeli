// Explicit source observations. File custody does not freeze SQLite rows, and
// matching source observations never authorize business adoption or replay.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';
import {managedStorageLocation} from './managed-storage-scope.mjs';
import {experimentalSupervisorEndpoint} from './experimental-process-supervisor.mjs';
const require=createRequire(import.meta.url);
const fail=(code,message,extra={})=>Object.assign(Error(message),{code,automaticReplay:false,...extra});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze=value=>{for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);return Object.freeze(value);};

export async function openExperimentalHostSources({storage,project,expected}={}){
  if(process.platform!=='win32'||process.arch!=='x64'||!project?.id)
    throw fail('HOST_SOURCE_UNSUPPORTED','Explicit native project storage required');
  const pins=[];
  const parentFor=file=>{const {root,relative}=managedStorageLocation(storage,file);return openExperimentalPersistenceParent(root,relative);};
  const database=file=>{
    const parent=parentFor(file);pins.push(parent);
    const pin=parent.openPrivateDatabase(path.basename(file),true);pins.push(pin);return pin;
  };
  let closed=false,fence=null,record;
  const close=()=>{if(closed)return;closed=true;for(const pin of pins.reverse())pin.close();};
  const verify=()=>{
    if(fence)throw fence;if(closed)throw fail('HOST_SOURCE_CLOSED','Source custody closed');
    storage.assertLocalOpen(project.id);
    try{for(const pin of pins)pin.verify();}
    catch(cause){fence=fail('HOST_SOURCE_CHANGED','Original source entity or access policy changed',{cause});throw fence;}
  };
  const rows=async()=>({
    catalog:await storage.db.request(storage.catalog,'record',{collection:'instances',id:project.id,mustExist:true}),
    identity:await storage.db.request(path.join(project.metadataRoot,'project.sqlite'),'record',{collection:'identity',id:'project',mustExist:true}),
  });
  try{
    const catalog=database(storage.catalog),projectDatabase=database(path.join(project.metadataRoot,'project.sqlite'));
    const manifestFile=path.join(project.metadataRoot,'project.json'),parent=parentFor(manifestFile);pins.push(parent);
    const manifest=parent.openPrivateObjectRead('project.json');pins.push(manifest);const stat=manifest.stat();
    if(stat.size<1n||stat.size>1048576n)throw fail('HOST_SOURCE_INVALID','Project manifest exceeds its bounded source scope');
    const bytes=manifest.readAt(0,Number(stat.size));
    if(bytes.length!==Number(stat.size))throw fail('HOST_SOURCE_INVALID','Project manifest was truncated');
    let content;try{content=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    catch(cause){throw fail('HOST_SOURCE_INVALID','Project manifest encoding or JSON is invalid',{cause});}
    const initial=await rows();verify();
    if(!initial.catalog||!same(initial.catalog.value,project)||content.schema!==1||content.projectId!==project.id||
       initial.identity?.value?.schema!==1||initial.identity.value.projectId!==project.id||
       parent.identity()!==`${project.metadataIdentity?.dev}:${project.metadataIdentity?.ino}`)
      throw fail('HOST_SOURCE_CHANGED','Actual catalog, project database or manifest differs from the registered project');
    record=freeze({schema:1,scope:'native-host-source-entities-and-records',projectId:project.id,instanceId:project.instanceId,
      catalog:{file:storage.catalog,entityIdentity:catalog.identity(),registration:initial.catalog},
      projectDatabase:{file:path.join(project.metadataRoot,'project.sqlite'),entityIdentity:projectDatabase.identity(),identity:initial.identity},
      manifest:{file:manifestFile,entityIdentity:stat.identity,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length},
      metadataIdentity:project.metadataIdentity,projectRootIdentity:project.identity,crossDatabaseAtomicityQualified:false});
    if(expected&&!same(record,expected))throw fail('HOST_SOURCE_CHANGED','Source entities or record revisions differ from retained host evidence');
    const check=async()=>{
      verify();try{
        const current=await rows();verify();
        if(!same(current.catalog,record.catalog.registration)||!same(current.identity,record.projectDatabase.identity))
          throw fail('HOST_SOURCE_CHANGED','Actual source record revision changed; cached bindings cannot authorize continuation');
        return record;
      }catch(cause){
        fence??=cause.code==='STORAGE_RESULT_UNKNOWN'||cause.commitUnknown?cause:
          fail('HOST_SOURCE_CHANGED','Source verification failed; evidence retained',{cause});throw fence;
      }
    };
    await check();
    return Object.freeze({record,verify,check,close,
      createCustody(anchor,localDatabase,coldMetadata,ownerHome){verify();return require('../../../native/windows/build/Release/nozeli_windows_read.node')
        .createSupervisorCustody(anchor,localDatabase,catalog,projectDatabase,manifest,digest(record),...(ownerHome?[coldMetadata,ownerHome]:coldMetadata?[coldMetadata]:[]));},
    });
  }catch(error){close();throw error;}
}

export async function readExperimentalColdRegistrations(binding){
  const {storage,projectId,target,originalInspection}=binding;
  if(originalInspection!==undefined){
    // Only the original checkpoint issuer can provide the immutable prepared
    // basis after its exact ledger transitions. No caller-supplied row override.
    const {readWindowsManagedColdOriginalRegistration}=await import('./managed-cold-checkpoint.mjs');
    return readWindowsManagedColdOriginalRegistration(originalInspection,binding);
  }
  const file=path.join(await storage.localDirectory(projectId),'ui.sqlite');
  return {host:await storage.db.request(file,'record',{collection:'managed_host_leases',id:'host',mustExist:true}),
    owner:await storage.db.request(file,'record',{collection:'managed_owner_launches',id:target,mustExist:true})};
}

export async function inspectExperimentalColdHostSources(binding={}){
  const {storage,projectId,target,supervisor}=binding;
  if(typeof target!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(target))throw fail('HOST_SOURCE_INVALID','Exact owner target required');
  const project=structuredClone(await storage.requireOnline(projectId)),directory=await storage.localDirectory(projectId),file=path.join(directory,'ui.sqlite');
  const {host,owner}=await readExperimentalColdRegistrations(binding);
  if(host?.value?.phase!=='active'||owner?.value?.phase!=='prepared'||!host.value.source||
     host.value.projectId!==projectId||owner.value.projectId!==projectId||host.value.instanceId!==project.instanceId||
     owner.value.instanceId!==project.instanceId||owner.value.hostLeaseId!==host.value.leaseId||
     !same(experimentalSupervisorEndpoint(supervisor),owner.value.supervision))
    throw fail('HOST_SOURCE_BINDING_CHANGED','Actual host and owner records do not bind this source supervisor');
  const kernel=()=>{
    const facts=supervisor.snapshot();
    if(facts.sourceSha256!==digest(host.value.source))
      throw fail('HOST_SOURCE_BINDING_CHANGED','Host source declaration differs from the original supervisor-held digest');
    if(!facts.hostExited||!facts.sourceCustodyVerified||facts.stamp!==owner.value.identity?.stamp||
       facts.hostPid!==host.value.host.pid||facts.hostCreationTime100ns!==host.value.host.creationTime100ns)
      throw fail('HOST_SOURCE_SUPERVISION_UNVERIFIED','Original exited host and complete retained source custody required');
    return facts;
  };
  kernel();let sources,parent,local;
  try{
    const location=managedStorageLocation(storage,file);parent=openExperimentalPersistenceParent(location.root,location.relative);
    local=parent.openPrivateDatabase('ui.sqlite',true);
    if(local.identity()!==host.value.databaseIdentity)throw fail('HOST_SOURCE_BINDING_CHANGED','Local database differs from the retained host entity');
    sources=await openExperimentalHostSources({storage,project,expected:host.value.source});
    const after=await readExperimentalColdRegistrations(binding);
    if(!same(after.host,host)||!same(after.owner,owner))
      throw fail('HOST_SOURCE_BINDING_CHANGED','Host or owner record changed during source inspection');
    await sources.check();parent.verify();local.verify();const facts=kernel();
    return freeze({schema:1,scope:'cold-host-source-observation-only',projectId,instanceId:project.instanceId,
      hostLeaseId:host.value.leaseId,hostRevision:host.revision,ownerRevision:owner.revision,source:sources.record,
      sourceRecordsVerified:true,jobEmptyObserved:facts.jobEmptyObserved,allProcessIncarnationsObserved:facts.allProcessIncarnationsObserved,
      crossDatabaseAtomicityQualified:false,coldRecoveryQualified:false,ownerReleaseQualified:false,automaticReplay:false});
  }finally{sources?.close();local?.close();parent?.close();}
}
