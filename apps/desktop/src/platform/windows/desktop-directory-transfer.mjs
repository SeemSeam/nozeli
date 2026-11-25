// Effects only. Shared FileTreeOps owns metadata, drafts and recovery admission.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openExperimentalSourceTree} from './experimental-private-tree.mjs';
const fail=(code,message)=>Object.assign(Error(message),{code});
const fold=value=>value.normalize('NFKC').toUpperCase().toLowerCase();
const snapshotOptions={maxEntries:1024,maxBytes:512*1024*1024};

export async function transferWindowsDirectory({bridge,project,sourceProject=project,sourceLease,source,destination,expectedIdentity,action,operationId,onPrepared,onPublished,scope,beforePublish,directorySync}){
 let from,to,root,sourceTree,stage,stageTree,published=false,allocationAttempted=false,primaryError,identity;
 const stagingName=action==='copy'?'.nozeli-tree-'+operationId+'.pending':null;
 const allocated=[],builders=[],fileLeases=[];
 let manifest,stageManifest,allocationIntent;
 const facts=()=>({schema:1,kind:'directory',action,source,destination,operationId,sourceProjectId:sourceProject.id,projectId:project.id,sourceIdentity:manifest?.rootIdentity??expectedIdentity,
  identity:identity??null,manifest:manifest??null,stageManifest:stageManifest??null,stagingName,allocated:[...allocated],allocationIntent:allocationIntent??null,published,
  retainedStage:allocationAttempted&&!published,byteLength:manifest?.totalBytes??null,digest:manifest?.sha256??null});
 const capture=(owner,relative,lease,expected)=>openExperimentalSourceTree(owner.root,path.join(owner.root,relative),{
  ...snapshotOptions,sourceLease:sourceLease&&owner===sourceProject?lease:lease.sourceDirectory(),expectedIdentity:expected,
 });
 const safeManifest=tree=>{
  for(const row of tree.entries)if(row.relative.split('/').some(part=>['.git','.nozeli'].includes(fold(part))))
   throw fail('TREE_METADATA_REJECTED','目录包含独立项目元数据，原目录已保留。');
 };
 try{
  await scope(sourceProject,source);scope(project,destination);
  from=sourceLease?.parent??bridge.openAnchoredPublicMutationParent(sourceProject.root,source);to=bridge.openAnchoredPublicMutationParent(project.root,destination);
  root=sourceLease?.entry??from.openPublicTreeRoot(source.split('/').at(-1));
  sourceTree=await capture(sourceProject,source,root,expectedIdentity);manifest=sourceTree.manifest;safeManifest(manifest);
  if(manifest.entries.some(row=>row.type==='directory'&&row.identity===to.identity()))throw fail('FS_PATH_REJECTED','不能将目录转移到自身或子目录。');
  if(action==='copy'){
   // Record intent before allocation. Even a lost allocation acknowledgement
   // leaves an explicit stage name and complete source plan for inspection.
   await onPrepared(facts());allocationAttempted=true;allocationIntent={relative:'',type:'directory'};await onPrepared(facts());
   stage=to.createPublicTreeRootExclusive(stagingName);identity=stage.identity();
   allocated.push({relative:'',type:'directory',identity});allocationIntent=null;await onPrepared(facts());
   const directories=new Map([['',stage]]);
   for(const row of manifest.entries){
    if(!row.relative)continue;
    root.verify();
    const parentRelative=path.posix.dirname(row.relative),parent=directories.get(parentRelative==='.'?'':parentRelative),name=path.posix.basename(row.relative);
    if(row.type==='directory'){
     allocationIntent={relative:row.relative,type:'directory'};await onPrepared(facts());
     const child=parent.createPublicDirectoryExclusive(name);builders.push(child);directories.set(row.relative,child);
     allocated.push({relative:row.relative,type:'directory',identity:child.identity()});allocationIntent=null;await onPrepared(facts());
    }else{
     const temporary='.nozeli-copy-'+randomUUID()+'.pending';
     allocationIntent={relative:row.relative,type:'file',temporary};await onPrepared(facts());
     const file=parent.createPublicExclusive(temporary);fileLeases.push(file);
     allocated.push({relative:row.relative,type:'file',temporary,identity:file.identity(),byteLength:row.byteLength,sha256:row.sha256});allocationIntent=null;await onPrepared(facts());
     for await(const chunk of sourceTree.streamFile(row.relative))file.write(chunk);
     file.sync();file.publishNew(name);await directorySync(parent);
     file.close();fileLeases.pop();
    }
   }
   for(const child of [...builders].reverse())await directorySync(child);
   await directorySync(stage);await directorySync(to);
   for(const child of builders.reverse())child.close();builders.length=0;
   stageTree=await capture(project,[path.posix.dirname(destination),stagingName].filter(part=>part&&part!=='.').join('/'),stage,identity);
   stageManifest=stageTree.manifest;safeManifest(stageManifest);
   // Copies receive inherited ACLs/new IDs. Contents and membership must match.
   const payload=tree=>tree.entries.map(({relative,type,byteLength,sha256})=>({relative,type,...(type==='file'?{byteLength,sha256}:{})}));
   if(JSON.stringify(payload(manifest))!==JSON.stringify(payload(stageManifest)))throw fail('FS_TREE_CHANGED','暂存目录与固定源清单不一致，已保留现场。');
  }else identity=manifest.rootIdentity;
  await onPrepared(facts());await sourceTree.verify();
  const tree=stageTree??sourceTree,publishingRoot=stage??root;
  await tree.publishPinned({
   prepareMove:()=>publishingRoot.beginPublicSelfMove(to,destination.split('/').at(-1),identity),
   beforeCommit:async()=>{await beforePublish(facts());await scope(sourceProject,source);scope(project,destination);if(stageTree)await sourceTree.verify();},
   barriers:async()=>{published=true;await directorySync(publishingRoot);if(!sourceLease)await directorySync(from);await directorySync(to);},
  });
  published=true;await sourceTree.verify();
  const effect={...facts(),retainedStage:false,state:'barriers-completed',durability:'namespace-not-qualified',rechecked:true,
   barriers:{files:action==='copy'?'copied-files-flushed':'not-flushed-by-read-lease',directory:'flushed',sourceParent:sourceLease?'observed-read-only':'flushed',destinationParent:'flushed'}};
  await onPublished(effect);return effect;
 }catch(cause){
  const error=cause instanceof Error?cause:fail('TREE_TRANSFER_FAILED','目录传输失败，已保留现场。');primaryError=error;
  // Native allocation can take effect without publishing the final name.
  // Distinguish a retained hidden stage from a published public destination.
  if(!published&&error.committed&&allocationAttempted&&!stageTree){error.stageAllocationUncertain=true;delete error.committed;}
  if(published||error.committed){published=true;error.committed=true;error.durability='uncertain';}
  error.treeTransfer=facts();throw error;
 }finally{
  const errors=[];
  for(const lease of [...fileLeases,...builders.reverse(),stageTree,sourceTree,stage,root,to,from])try{lease?.close();}catch(error){errors.push(error);}
  if(errors.length){if(primaryError)primaryError.cleanupErrors=[...(primaryError.cleanupErrors??[]),...errors];else{const error=errors[0];error.treeTransfer=facts();error.cleanupErrors=errors;if(published){error.committed=true;error.durability='uncertain';}throw error;}}
 }
}
