// Ordinary selected-project content: inherited ACLs, exclusive allocation and
// no-replace publication. Shared FileTreeOps owns journals and metadata policy.
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {transferWindowsDirectory} from './desktop-directory-transfer.mjs';
const require=createRequire(import.meta.url);
const fail=(code,message)=>Object.assign(Error(message),{code});
export function createWindowsDesktopFileTreeIO(host,{directorySync=parent=>parent.syncDirectory(),beforePublish=async()=>{}}={}) {
 const scope=(project,relative)=>{
  if(typeof relative!=='string'||!relative||relative.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.'))||/[\\:\x00-\x1f]/.test(relative))throw fail('FS_PATH_REJECTED','Expected a visible project-relative path');
  host.storage.nativeRootForPath(path.join(project.root,relative));
 };
 return Object.freeze({
  recoverableCreation:true,
  recoverableTransfer:true,
  recoverableCrossTransfer:true,
  requireTransferKind(stat){if(!stat.isFile()&&!stat.isDirectory())throw fail('TREE_ENTRY_UNSUPPORTED','Windows 仅支持普通文件和目录，原项已保留。');},
  async transferEntry(project,source,destination,{sourceProject=project,sourceLease,action,operationId,onPrepared=async()=>{},onPublished=async()=>{},beforeCommit=async()=>{}}){
   if(sourceLease&&action!=='copy')throw fail('FS_HANDLE_REJECTED','External source custody is read-only');
   const transferScope=(owner,relative)=>{if(sourceLease&&owner===sourceProject){if(relative!==sourceLease.relative||owner.root!==sourceLease.root)throw fail('FS_PATH_REJECTED','Clipboard source scope changed');return sourceLease.verify();}return scope(owner,relative);};
   await transferScope(sourceProject,source);scope(project,destination);
   if(!['copy','cut','rename'].includes(action)||!/^[a-f0-9-]{36}$/.test(operationId))throw fail('INVALID_PAYLOAD','Invalid transfer identity');
   const bridge=require('../../../native/windows/build/Release/nozeli_windows_read.node');
   let observed;
   if(sourceLease)observed={directory:sourceLease.directory,identity:sourceLease.identity};
   else{const inspector=bridge.openAnchoredPublicMutationParent(sourceProject.root,source);try{observed=inspector.inspectEntry(source.split('/').at(-1));}finally{inspector.close();}}
   if(observed?.directory)return transferWindowsDirectory({bridge,project,sourceProject,sourceLease,source,destination,expectedIdentity:observed.identity,action,operationId,onPrepared,onPublished,scope:transferScope,beforePublish:async facts=>{await beforePublish(facts);await beforeCommit(facts);},directorySync});
   let from,to,lease,stage,published=false,sourceIdentity,identity,byteLength,digest,primaryError,stagingName;
   const facts=()=>({schema:1,kind:'file',action,source,destination,operationId,sourceProjectId:sourceProject.id,projectId:project.id,sourceIdentity:sourceIdentity??null,identity:identity??null,byteLength:byteLength??null,digest:digest??null,stagingName:stagingName??null,published});
   try{
    from=sourceLease?.parent??bridge.openAnchoredPublicMutationParent(sourceProject.root,source);to=bridge.openAnchoredPublicMutationParent(project.root,destination);
    lease=sourceLease?.entry??from.beginPublicFileTransfer(source.split('/').at(-1),to,destination.split('/').at(-1),action!=='copy');
    const stat=lease.stat();sourceIdentity=stat.identity;
    if(stat.size<0n||stat.size>512n*1024n*1024n)throw fail('TREE_FILE_LIMIT','当前 Windows 文件传输上限为 512 MiB，源文件未修改。');
    byteLength=Number(stat.size);
    if(action==='copy'){
     stagingName='.nozeli-tree-'+operationId+'.pending';stage=to.createPublicExclusive(stagingName);identity=stage.identity();
    }else identity=sourceIdentity;
    await onPrepared(facts());
    const hash=createHash('sha256');let offset=0;
    while(offset<byteLength){
     const bytes=lease.readAt(offset,Math.min(1024*1024,byteLength-offset));
     if(!bytes.length)throw fail('FS_STAGE_CHANGED','Source ended before the pinned length');
     hash.update(bytes);if(stage)stage.write(bytes);offset+=bytes.length;
     // Yield between bounded chunks so large copies do not monopolize main.
     await new Promise(resolve=>setImmediate(resolve));
    }
    if(lease.readAt(byteLength,1).length)throw fail('FS_STAGE_CHANGED','Source exceeds pinned length');
    digest=hash.digest('hex');if(stage)stage.sync();lease.verify();
    await onPrepared(facts());await beforePublish(facts());await beforeCommit(facts());await transferScope(sourceProject,source);scope(project,destination);lease.verify();
    if(stage)stage.publishNew(destination.split('/').at(-1));else lease.commit();published=true;
    if(!sourceLease)await directorySync(from);await directorySync(to);lease.verify();if(stage&&stage.verify()===false)throw fail('FS_STAGE_CHANGED','Published copy changed');
    const effect={...facts(),state:'barriers-completed',durability:'namespace-not-qualified',barriers:{file:'flushed',sourceParent:sourceLease?'observed-read-only':'flushed',destinationParent:'flushed'}};
    await onPublished(effect);
    return effect;
   }catch(cause){
    const error=cause instanceof Error?cause:fail('TREE_TRANSFER_FAILED','Project file transfer failed');primaryError=error;
    if(published||error.committed){published=true;error.committed=true;error.durability='uncertain';}
    error.treeTransfer=facts();throw error;
   }finally{
    const errors=[];for(const item of [stage,lease,to,from])try{item?.close();}catch(error){errors.push(error);}
    if(errors.length){if(primaryError)primaryError.cleanupErrors=errors;else{const error=errors[0];error.treeTransfer=facts();if(published){error.committed=true;error.durability='uncertain';}throw error;}}
   }
  },
  async createEntry(project,relative,{kind,operationId,onPrepared=async()=>{}}){
   scope(project,relative);if(!['file','directory'].includes(kind)||!/^[a-f0-9-]{36}$/.test(operationId))throw fail('INVALID_PAYLOAD','Invalid creation identity');
   const bridge=require('../../../native/windows/build/Release/nozeli_windows_read.node');
   const parent=bridge.openAnchoredPublicMutationParent(project.root,relative);
   let entry,published=false,identity,primaryError;
   const facts=()=>({schema:1,kind,relative,identity:identity??null,published,operationId});
   try{
    scope(project,relative);parent.verify();
    const name=relative.split('/').at(-1);
    if(kind==='directory'){
     await beforePublish(facts());scope(project,relative);parent.verify();
     entry=parent.createPublicDirectoryExclusive(name);published=true;identity=entry.identity();
     await onPrepared(facts());await directorySync(entry);
    }else{
     const stagingName='.nozeli-tree-'+operationId+'.pending';
     entry=parent.createPublicExclusive(stagingName);identity=entry.identity();entry.sync();
     await onPrepared({...facts(),stagingName});
     await beforePublish(facts());scope(project,relative);parent.verify();
     entry.publishNew(name);published=true;
    }
    await directorySync(parent);scope(project,relative);parent.verify();if(entry.verify()===false)throw fail('FS_STAGE_CHANGED','Created entry identity or permissions changed');
    return {...facts(),state:'barriers-completed',durability:'namespace-not-qualified',barriers:{entry:'flushed',parent:'flushed'}};
   }catch(cause){
    const error=cause instanceof Error?cause:fail('TREE_CREATE_FAILED','Project entry creation failed');primaryError=error;
    if(!published&&!error.committed&&(error.code==='FS_TARGET_EXISTS'||[80,183].includes(error.win32Code))){error.code='FS_TARGET_EXISTS';error.message='目标已存在，未覆盖。请先重命名。';}
    if(published||error.committed){published=true;error.committed=true;error.durability='uncertain';}
    error.treeCreation=facts();throw error;
   }finally{
    const errors=[];for(const item of [entry,parent])try{item?.close();}catch(error){errors.push(error);}
    if(errors.length){if(primaryError)primaryError.cleanupErrors=errors;else{const error=errors[0];error.treeCreation=facts();if(published){error.committed=true;error.durability='uncertain';}throw error;}}
   }
  },
 });
}
