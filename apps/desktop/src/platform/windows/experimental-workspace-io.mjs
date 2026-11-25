// Explicit integration into the shared open path; production selection remains
// disabled. The original host lease arbitrates every registered project writer.
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {defineWorkspaceIO} from '../../agents/managed/workspace-io.mjs';
import {experimentalWindowsVersionedFilesystem} from './experimental-filesystem.mjs';
import {ensureExperimentalPrivateDirectory,experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';
import {openExperimentalPersistenceParent,createExperimentalWindowsPersistence} from './experimental-persistence.mjs';
import {acquireExperimentalHostLease,verifyExperimentalHostRegistration,verifyExperimentalHostWorkOwner,recoverExperimentalColdProvider} from './experimental-host-lease.mjs';
import {openExperimentalPrivateTree} from './experimental-private-tree.mjs';
import {managedStorageLocation} from './managed-storage-scope.mjs';
const fail=(code,message)=>Object.assign(Error(message),{code});
const inside=(root,file)=>file===root||(!path.isAbsolute(path.relative(root,file))&&!path.relative(root,file).split(path.sep).includes('..'));
const mapped=error=>{if(error.code==='WIN32_IO_ERROR'&&[2,3].includes(error.win32Code))error.code='ENOENT';return error;};
export function createExperimentalWindowsWorkspaceIO({root,previousHostRelease,previousColdHandoff}={}){
  return createNativeWorkspaceIO({root,previousHostRelease,previousColdHandoff});
}
// Explicit qualification of the actual desktop layout. Selection by the
// production managed host waits for cold recovery qualification.
export function createWindowsDesktopWorkspaceIO({storage,previousHostRelease,previousColdHandoff}={}){
  if(storage?.experimentalWindowsRoot!==undefined||storage?.io?.qualification?.scope!=='profile-and-selected-projects')
    throw fail('WORKSPACE_IO_INVALID','Registered desktop project storage required');
  const {root}=managedStorageLocation(storage,storage.catalog,{code:'WORKSPACE_IO_INVALID'});
  return createNativeWorkspaceIO({root,boundStorage:storage,previousHostRelease,previousColdHandoff});
}
function createNativeWorkspaceIO({root,boundStorage,previousHostRelease,previousColdHandoff}){
  let attempted=false,context,lease,runtimePin,bindingPin,closed=false;
  const retiredHomes=new Map();
  const verify=()=>{if(!context||closed)throw fail('WORKSPACE_IO_CLOSED','Original workspace I/O is not active');lease.verify();runtimePin.verify();bindingPin?.verify();};
  const location=file=>{
    verify();const {project,runtime}=context;
    if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file)throw fail('FS_PATH_REJECTED','Absolute canonical workspace path required');
    const allowed=inside(project.metadataRoot,file)||inside(runtime,file);
    if(allowed&&boundStorage)managedStorageLocation(boundStorage,file);
    // The selected project itself may have ordinary user-directory policy.
    // Private provisioning starts below that retained project boundary.
    const anchor=allowed?(inside(project.metadataRoot,file)?project.root:root):null;
    if(!anchor)throw fail('FS_PATH_REJECTED','Workspace I/O is outside the original runtime/project metadata');
    return {anchor,relative:experimentalPrivateDirectoryComponents(anchor,file).join('/')};
  };
  const executionRoot=file=>{
    verify();
    if(!inside(context.project.root,file)&&!inside(context.runtime,file))throw fail('FS_PATH_REJECTED','Execution I/O is outside this project and runtime');
    if(boundStorage)return managedStorageLocation(boundStorage,file).root;
    return root;
  };
  const readFile=async(file,{maxBytes=64*1024*1024,limitCode='WORKSPACE_FILE_INVALID'}={})=>{
    if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>64*1024*1024)throw fail('WORKSPACE_FILE_INVALID','Invalid workspace read bound');
    const {anchor,relative}=location(file);let parent,pin;
    try{
      parent=openExperimentalPersistenceParent(anchor,relative);pin=parent.openPrivateObjectRead(path.basename(file));const size=pin.stat().size;
      if(size>BigInt(maxBytes))throw fail(limitCode,'Workspace file exceeds its byte bound');
      const chunks=[];let offset=0;
      while(offset<Number(size)){const bytes=pin.readAt(offset,Math.min(262144,Number(size)-offset));if(!bytes.length)throw fail('SOURCE_CHANGED','Workspace file truncated');chunks.push(bytes);offset+=bytes.length;await setImmediate();}
      pin.verify();parent.verify();verify();return Buffer.concat(chunks,offset);
    }catch(error){throw mapped(error);}finally{pin?.close();parent?.close();}
  };
  const ensureDirectory=async directory=>{const {anchor}=location(directory);await ensureExperimentalPrivateDirectory(anchor,directory);verify();};
  const writeImmutable=async(file,bytes)=>{
    const {anchor,relative}=location(file);
    try{await createExperimentalWindowsPersistence(anchor).writeStream(relative,[bytes]);verify();return true;}
    catch(error){if(error.code==='FS_TARGET_EXISTS')return false;throw error;}
  };
  return defineWorkspaceIO({
    filesystem:experimentalWindowsVersionedFilesystem,
    executionWorkspaceOptions:Object.freeze({filesystem:experimentalWindowsVersionedFilesystem,...(boundStorage?{windowsRootForPath:executionRoot,publicDirectory:directory=>{verify();return inside(context.project.root,directory)&&!inside(context.project.metadataRoot,directory)?context.project.root:false;}}:{experimentalWindowsRoot:root})}),
    workChangesOptions:Object.freeze({experimentalWindowsRoot:root}),
    qualification:Object.freeze({scope:boundStorage?'explicit-desktop-workspace-worker-warm-only':'explicit-shared-workspace-worker-warm-only',productionSelected:false,coldRecoveryQualified:false}),
    requirePersistence:verify,
    async recoverProvider({target,record}){
      verify();const result=await recoverExperimentalColdProvider(lease,{...context,target,record});verify();return result;
    },
    async validateWorkerOwner({workId,record,session,home}){
      verify();const snapshot=session?.child?.lease?.snapshot();
      if(!snapshot||snapshot.pid!==record.pid||snapshot.stamp!==record.stamp||session.home!==home||session.viewOwnerId!==record.ownerId)
        throw fail('HOST_LEASE_OWNER_UNVERIFIED','Original live session and kernel Job incarnation required');
      await verifyExperimentalHostWorkOwner(lease,{...context,target:workId,home,record,registration:session.launchRegistration});verify();
    },
    async verifyWorkerRetirement({workId,home}){
      verify();const owner=await verifyExperimentalHostWorkOwner(lease,{...context,target:workId,home,retired:true});verify();
      if(owner){
        const proof=owner.value.exit,identity=proof?.homeIdentity;
        if(typeof identity!=='string'||!/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(identity)||typeof proof.journalIdentity!=='string'||!/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(proof.journalIdentity)||typeof proof.journalSha256!=='string'||!/^[a-f0-9]{64}$/.test(proof.journalSha256)||typeof proof.journalRelative!=='string')throw fail('HOST_LEASE_OWNER_UNVERIFIED','Original Worker home and final journal identities are unavailable');
        retiredHomes.set(home,{identity,journalIdentity:proof.journalIdentity,journalSha256:proof.journalSha256,journalRelative:proof.journalRelative});
      }
      return owner;
    },
    async openWorkerHome(directory,{expectedIdentity}={}){
      const {anchor,relative}=location(directory);let parent,pin,identity;
      try{parent=openExperimentalPersistenceParent(anchor,relative);pin=parent.openPrivateDirectory(path.basename(directory),false);identity=pin.identity();pin.verify();}
      catch(error){if(mapped(error).code==='ENOENT')return null;throw error;}
      finally{pin?.close();parent?.close();}
      const owner=retiredHomes.get(directory);
      if(expectedIdentity&&owner&&expectedIdentity!==owner.identity)throw fail('HOST_LEASE_OWNER_UNVERIFIED','Worker archive intent differs from its original owner home');
      const tree=await openExperimentalPrivateTree(anchor,directory,{expectedIdentity:owner?.identity??expectedIdentity??identity});
      if(owner&&!tree.manifest.entries.some(entry=>entry.type==='file'&&entry.relative===owner.journalRelative&&entry.identity===owner.journalIdentity&&entry.sha256===owner.journalSha256)){
        tree.close();throw fail('WORKER_ARCHIVE_CHANGED','Worker home no longer contains its original acknowledged final journal');
      }
      return tree;
    },
    async acquire({storage,projectId,project,runtimeRoot}){
      if(attempted)throw fail('WORKSPACE_IO_INVALID','Workspace I/O acquisition is single use');attempted=true;
      if(process.platform!=='win32'||process.arch!=='x64'||(boundStorage?storage!==boundStorage:storage.experimentalWindowsRoot!==root))
        throw fail('WORKSPACE_IO_INVALID','Exact explicit native storage root required');
      experimentalPrivateDirectoryComponents(root,runtimeRoot);
      if(boundStorage&&runtimeRoot!==path.join(await storage.localDirectory(projectId),'execution'))
        throw fail('WORKSPACE_IO_INVALID','Desktop runtime must be the registered instance execution directory');
      try{
        lease=await acquireExperimentalHostLease({storage,projectId,previousRelease:previousHostRelease,previousColdHandoff});
        if(JSON.stringify(await storage.requireOnline(projectId))!==JSON.stringify(project))
          throw fail('HOST_LEASE_BINDING_CHANGED','Registered project changed during workspace acquisition');
        await ensureExperimentalPrivateDirectory(root,runtimeRoot);
        const parent=openExperimentalPersistenceParent(root,experimentalPrivateDirectoryComponents(root,runtimeRoot).join('/'));
        try{runtimePin=parent.openPrivateDirectory(path.basename(runtimeRoot),false);}finally{parent.close();}
        context={storage,projectId,project,runtime:runtimeRoot};verify();
        const bindingFile=path.join(runtimeRoot,'workspace-binding.json'),binding=Buffer.from(JSON.stringify({schema:1,scope:'explicit-native-workspace-binding',projectId,instanceId:project.instanceId,metadataRoot:project.metadataRoot,localDirectory:await storage.localDirectory(projectId),localDirectoryIdentity:lease.facts().localDirectoryIdentity}));
        if(!await writeImmutable(bindingFile,binding)&&!(await readFile(bindingFile,{maxBytes:4096})).equals(binding))
          throw fail('WORKSPACE_BINDING_CHANGED','Runtime belongs to another project or local database');
        const bindingParent=openExperimentalPersistenceParent(root,experimentalPrivateDirectoryComponents(root,bindingFile).join('/'));
        try{bindingPin=bindingParent.openPrivateObjectRead(path.basename(bindingFile));}finally{bindingParent.close();}
        if(bindingPin.stat().size!==BigInt(binding.length)||!bindingPin.readAt(0,binding.length).equals(binding))
          throw fail('WORKSPACE_BINDING_CHANGED','Runtime binding changed before pin acquisition');
        verify();
        return {runtime:runtimeRoot,content:project.root,lock:null,owner:null,hostLease:lease,
          verify,
          async check(){verify();await verifyExperimentalHostRegistration(lease,{storage,projectId});verify();},
          async release(){verify();const receipt=await lease.release();closed=true;bindingPin.close();runtimePin.close();return receipt;},
          abandon(){closed=true;bindingPin?.close();runtimePin?.close();lease.abandon();},
        };
      }catch(error){bindingPin?.close();runtimePin?.close();lease?.abandon();closed=true;throw error;}
    },
    ensureDirectory,readFile,writeImmutable,
    readMemoryFile:readFile,
    async ensurePlan(file,bytes){await ensureDirectory(path.dirname(file));if(!await writeImmutable(file,bytes))await readFile(file,{maxBytes:32*1024*1024});},
    async writeVersioned(file,bytes,{expectedSha256}){const {anchor,relative}=location(file);const result=await createExperimentalWindowsPersistence(anchor).writeStream(relative,[bytes],{expectedSha256});verify();return result;},
    async syncDirectory(directory){const {anchor,relative}=location(path.join(directory,'__workspace_barrier__')),parent=openExperimentalPersistenceParent(anchor,relative);try{parent.syncDirectory();parent.verify();verify();}finally{parent.close();}},
  });
}
