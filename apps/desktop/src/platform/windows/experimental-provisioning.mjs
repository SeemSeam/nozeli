// Filesystem effects for the shared dependency/prepared-resource engine. Public
// sources are read-only; exclusive private copies publish without replacement.
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {openExperimentalAnchoredRead} from './experimental-read.mjs';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';
import {experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';
import {openExperimentalPrivateTree,openExperimentalSourceTree} from './experimental-private-tree.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message)=>Object.assign(Error(message),{code});
const missing=error=>error.code==='WIN32_IO_ERROR'&&[2,3].includes(error.win32Code);
const full=(root,rel)=>path.join(root,...(rel?rel.split('/'):[]));
function readPin(pin){
 const stat=pin.stat();if(stat.size<0n||stat.size>16n*1024n*1024n)throw fail('FS_READ_LIMIT','Provisioning gate exceeds 16 MiB');
 const chunks=[];for(let offset=0;offset<Number(stat.size);){const bytes=pin.readAt(offset,Math.min(256*1024,Number(stat.size)-offset));if(!bytes.length)throw fail('FS_TREE_CHANGED','Provisioning gate truncated');chunks.push(bytes);offset+=bytes.length;}
 if(!pin.verify())throw fail('FS_TREE_CHANGED','Provisioning gate changed');return Buffer.concat(chunks);
}
export function createExperimentalWindowsProvisioning({beforeCopyEntry=()=>{},beforePublish=()=>{},afterPublish=()=>{},beforeCleanup=()=>{},afterCheckpoint=()=>{},afterCleanupEntry=()=>{}}={}){
 for(const hook of [beforeCopyEntry,beforePublish,afterPublish,beforeCleanup,afterCheckpoint,afterCleanupEntry])if(typeof hook!=='function')throw new TypeError('Expected provisioning hook');
 return Object.freeze({
  durable:true,
  async read(root,relative){let pin;try{pin=openExperimentalAnchoredRead(root,relative);return readPin(pin);}catch(error){if(missing(error))return null;throw error;}finally{pin?.close();}},
  async openTarget(root,dir){
   // Validate the complete Windows spelling before opening any write lease.
   const directory=full(root,dir);experimentalPrivateDirectoryComponents(path.dirname(root),directory);
   const parent=openExperimentalPersistenceParent(root,(dir?dir+'/':'')+'__provision_anchor__');
   let wrapper;const gates=new Map(),ownedStages=new Set(),retainedStages=[];
   const checkpoint=async(stage,phase,patch={})=>{
    if(!stage.checkpoint)return;
    stage.effect={...stage.effect,...patch};
    await stage.checkpoint({phase,effect:stage.effect});
    await afterCheckpoint({phase,effect:structuredClone(stage.effect)});
   };
   const sourceFact=stage=>({schema:1,stage:stage.directory,stageIdentity:stage.identity,sourceManifestSha256:stage.sourceManifestSha256,allocatedCount:stage.created.length,allocations:stage.created.slice(0,32),...(stage.partialCopy?{partialCopy:stage.partialCopy}:{}),...(stage.publication?{publication:stage.publication}:{})});
   const checkOwned=tree=>{
    const stage=tree.stage,actual=tree.capture.manifest,expected=stage.created;
    if(actual.rootIdentity!==stage.identity||actual.entries.length!==expected.length||actual.entries.some(entry=>!expected.some(row=>row.relative===entry.relative&&row.type===entry.type&&row.identity===entry.identity&&(!row.securitySha256||row.securitySha256===entry.securitySha256)&&(row.type==='directory'||row.sha256===entry.sha256&&row.byteLength===entry.byteLength))))
     throw fail('FS_TREE_CHANGED','Staging membership differs from original allocations; preserve all entries');
   };
   return {
    async readGate(gateRoot,rel){
     const key=full(gateRoot,rel);let pin=gates.get(key);
     if(!pin){try{pin=openExperimentalAnchoredRead(gateRoot,rel);}catch(error){if(missing(error))return null;throw error;}gates.set(key,pin);}
     return readPin(pin);
    },
    async prepare({workId}){
     const existing=parent.inspectEntry('.nozeli');if(!existing)return;
     if(existing.reparse||!existing.directory)throw fail('FS_REPARSE_REJECTED','Staging wrapper is not a real directory');
     wrapper=parent.openPrivateDirectory('.nozeli',false);
     // Prior-process stages have no retained allocation proof. Keep them for
     // explicit recovery; a workId marker alone grants no deletion authority.
     for(const row of wrapper.entries(10000)){
      if(!row.directory||!row.name.startsWith('deps-'))continue;
      let directory,marker;
      try{
       directory=wrapper.openPrivateDirectory(row.name,false);
       if(directory.identity()!==row.identity)throw fail('FS_TREE_CHANGED','Prior stage changed during inspection');
       try{marker=directory.openPrivateObjectRead('staging.json');}catch(error){if(missing(error))continue;throw error;}
       const stat=marker.stat();if(stat.size>4096n)continue;
       const bytes=stat.size?marker.readAt(0,Number(stat.size)):Buffer.alloc(0);marker.verify();directory.verify();
       let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{continue;}
       if(value?.workId===workId)retainedStages.push({name:row.name,identity:row.identity,markerIdentity:stat.identity,markerSha256:sha(bytes)});
      }finally{try{marker?.close();}finally{directory?.close();}}
     }
    },
    async existing(name){return parent.inspectEntry(name);},
    async source(sourceRoot,rel,missingCode,detail){
     try{const tree=await openExperimentalSourceTree(sourceRoot,full(sourceRoot,rel));return {tree,close:()=>tree.close()};}
     catch(error){
      if(missing(error))return {code:missingCode,detail};
      if(['FS_REPARSE_REJECTED','FS_ENTRY_REJECTED','FS_PATH_REJECTED','FS_TREE_LIMIT','FS_SECURITY_UNSUPPORTED'].includes(error.code))return {code:'unsupported-source',detail:'源负载包含当前未资格化的链接、别名、文件类型或超出读取界限；未复制、未修改源端。',reason:error.code};
      throw error;
     }
    },
    async stage(source,{workId,targetName,checkpoint:save}){
     let stage,lease,marker;
     try{
      if(retainedStages.length)throw Object.assign(fail('DEPENDENCY_RECOVERY_REQUIRED','Prior matching stages require explicit reconciliation before another copy'),{committed:true,provisioning:{schema:1,state:'retained-stages-require-recovery',stages:retainedStages}});
      if(!wrapper)wrapper=parent.openPrivateDirectory('.nozeli',true);
      const name='deps-'+randomUUID(),directory=path.join(root,...(dir?dir.split('/'):[]),'.nozeli',name);
      const effect={name,targetName,parentIdentity:parent.identity(),parentSecuritySha256:sha(parent.observedSecurityBytes()),wrapperIdentity:wrapper.identity(),wrapperSecuritySha256:sha(wrapper.privateSecurityBytes()),sourceManifestSha256:source.tree.manifest.sha256};
      // Persist the chosen namespace and parent identity before allocating it.
      if(save){await save({phase:'allocating',effect});await afterCheckpoint({phase:'allocating',effect:structuredClone(effect)});}
      lease=wrapper.createPrivateDirectoryExclusive(name);
      stage={name,directory,targetName,identity:lease.identity(),created:[{relative:'',type:'directory',identity:lease.identity(),securitySha256:sha(lease.privateSecurityBytes())}],sourceManifestSha256:source.tree.manifest.sha256,payload:path.join(directory,targetName),lease,checkpoint:save,effect};
      ownedStages.add(stage);lease.syncDirectory();wrapper.syncDirectory();parent.syncDirectory();
      await checkpoint(stage,'allocated',{identity:stage.identity});
      const bytes=Buffer.from(JSON.stringify({workId,at:new Date().toISOString()})+'\n');
      marker=lease.createPrivateExclusive('marker-'+randomUUID());marker.write(bytes);marker.sync();const identity=marker.identity();marker.publishNew('staging.json');
      stage.created.push({relative:'staging.json',type:'file',identity,sha256:sha(bytes),byteLength:bytes.length});marker.close();marker=undefined;lease.syncDirectory();
      const markerPin=lease.openPrivateObjectRead('staging.json');try{stage.created.at(-1).securitySha256=sha(markerPin.stat().security);}finally{markerPin.close();}
      const copy=await source.tree.copyTo(stage.payload,{destinationRoot:root,beforeEntry:beforeCopyEntry});
      stage.created.push(...copy.created.map(row=>({...row,relative:row.relative?targetName+'/'+row.relative:targetName})));
      stage.tree=await openExperimentalPrivateTree(root,stage.payload);
      stage.ctx={files:source.tree.manifest.entries.filter(row=>row.type==='file').length,bytes:source.tree.manifest.totalBytes,directories:source.tree.manifest.entries.filter(row=>row.type==='directory').length,skipped:[]};
      if(save){
       const payloadManifest=stage.tree.manifest;stage.tree.close();stage.tree=undefined;stage.lease.close();stage.lease=undefined;
       let captured;try{captured=await openExperimentalPrivateTree(root,stage.directory,{expectedIdentity:stage.identity});checkOwned({stage,capture:captured});stage.created=captured.manifest.entries.map(row=>({...row}));
        await checkpoint(stage,'copied',{payloadManifest,wrapperManifest:captured.manifest,ctx:stage.ctx});
       }finally{captured?.close();}
       stage.tree=await openExperimentalPrivateTree(root,stage.payload,{expectedIdentity:payloadManifest.rootIdentity});
       if(stage.tree.manifest.sha256!==payloadManifest.sha256)throw fail('FS_TREE_CHANGED','Copy changed after original complete-copy checkpoint');
      }
      return stage;
     }catch(error){if(stage){error.committed=true;if(error.privateTreeCopy)stage.partialCopy={createdCount:error.privateTreeCopy.created.length,created:error.privateTreeCopy.created.slice(0,32)};}error.provisioning??=stage?sourceFact(stage):{schema:1,state:'allocation-not-confirmed'};throw error;}
     finally{marker?.close();}
    },
    async restore(record,{checkpoint:save}){
     const effect=record.effect,held=message=>Object.assign(fail('DEPENDENCY_RECOVERY_REQUIRED',message),{committed:true});
     if(record.schema!==1||!effect||!['copied','publishing','published','cleaning'].includes(record.phase)||!effect.payloadManifest||!effect.wrapperManifest)
      throw held('The interrupted operation has no acknowledged complete-copy manifest; preserve partial allocations');
     if(!/^deps-[0-9a-f-]{36}$/.test(effect.name)||effect.targetName!==path.posix.basename(record.binding.payloadRel))throw held('Invalid original stage spelling');
     if(parent.identity()!==effect.parentIdentity||sha(parent.observedSecurityBytes())!==effect.parentSecuritySha256||!wrapper||wrapper.identity()!==effect.wrapperIdentity||sha(wrapper.privateSecurityBytes())!==effect.wrapperSecuritySha256)
      throw held('Original target parent or staging wrapper changed');
     const stage={name:effect.name,directory:full(root,(dir?dir+'/':'')+'.nozeli/'+effect.name),targetName:effect.targetName,identity:effect.identity,sourceManifestSha256:effect.sourceManifestSha256,ctx:effect.ctx,checkpoint:save,effect};
     stage.payload=path.join(stage.directory,stage.targetName);
     let captured;
     try{
      const target=parent.inspectEntry(stage.targetName);
      if(target?.identity===effect.payloadManifest.rootIdentity){
       if(!['publishing','published','cleaning'].includes(record.phase))throw held('Original payload appeared at target without an acknowledged publication intent');
       stage.tree=await openExperimentalPrivateTree(root,full(root,(dir?dir+'/':'')+stage.targetName),{expectedIdentity:effect.payloadManifest.rootIdentity});
       if(stage.tree.manifest.sha256!==effect.payloadManifest.sha256)throw held('Published target differs from original identity/content/ACL manifest');
       const receipt=await stage.tree.sync();stage.published=true;stage.publication={moved:true,identity:effect.payloadManifest.rootIdentity,manifestSha256:effect.payloadManifest.sha256};
       stage.evidence={schema:1,sourceManifestSha256:effect.sourceManifestSha256,...stage.publication,durability:receipt.durability,barriers:receipt.barriers,reconciled:true};
      }
      const allocated=wrapper.inspectEntry(stage.name),cleanup=effect.cleanup;
      if(!allocated){
       if(record.phase!=='cleaning'||!cleanup||!(cleanup.remaining.length===0||cleanup.pending===''&&cleanup.remaining.length===1&&cleanup.remaining[0].relative==='')||!record.result)throw held('Original stage missing without its exact final deletion intent');
       if(record.result.outcome==='provisioned'&&!stage.published)throw held('Original publication is missing');
       wrapper.syncDirectory();parent.syncDirectory();stage.tree?.close();stage.tree=undefined;stage.completed=true;return stage;
      }
      if(allocated.identity!==stage.identity||allocated.reparse||!allocated.directory)throw held('Original stage was replaced');
      captured=await openExperimentalPrivateTree(root,stage.directory,{expectedIdentity:stage.identity});
      let expected=cleanup?cleanup.remaining:effect.wrapperManifest.entries.filter(row=>!stage.published||row.relative!==stage.targetName&&!row.relative.startsWith(stage.targetName+'/'));
      if(cleanup?.pending!==undefined&&!captured.manifest.entries.some(row=>row.relative===cleanup.pending))expected=expected.filter(row=>row.relative!==cleanup.pending);
      if(JSON.stringify(captured.manifest.entries)!==JSON.stringify(expected))throw held('Stage differs from original remaining allocation manifest; preserve all winners');
      if(record.result?.outcome==='provisioned'&&!stage.published)throw held('Original publication is missing or replaced');
      stage.created=expected.map(row=>({...row}));
      captured.close();captured=undefined;
      if(!stage.published&&!cleanup){
       stage.tree=await openExperimentalPrivateTree(root,stage.payload,{expectedIdentity:effect.payloadManifest.rootIdentity});
       if(stage.tree.manifest.sha256!==effect.payloadManifest.sha256)throw held('Original complete copy changed');
      }
      if(cleanup){stage.cleanupOnly=true;stage.published=true;}
      ownedStages.add(stage);return stage;
     }catch(error){stage.tree?.close();throw Object.assign(error,{committed:true});}finally{captured?.close();}
    },
    async verifySource(source){try{await source.tree.verify();return true;}catch(error){if(['FS_TREE_CHANGED','FS_STAGE_CHANGED'].includes(error.code))return false;throw error;}},
    async publish(stage,{validate}){
     try{
      const receipt=await stage.tree.publishTo(full(root,(dir?dir+'/':'')+stage.targetName),{beforeCommit:async()=>{await beforePublish(sourceFact(stage));await validate();}});stage.publication=receipt;
      await checkpoint(stage,'published');
      // A lost callback after the real move must remain UNKNOWN, never be
      // reported as a failed no-op or automatically replayed.
      try{await afterPublish(receipt);}catch(error){error.committed=true;throw error;}
      return {present:false,evidence:{schema:1,sourceManifestSha256:stage.sourceManifestSha256,identity:receipt.identity,manifestSha256:receipt.manifestSha256,durability:receipt.durability,barriers:receipt.barriers}};
     }catch(error){
      if(!error.committed&&(error.code==='FS_TARGET_EXISTS'||error.code==='WIN32_IO_ERROR'&&[80,183,145].includes(error.win32Code)))return {present:true};
      if(error.privateTreePublication?.moved)stage.publication=error.privateTreePublication;
      error.provisioning=sourceFact(stage);throw error;
     }
    },
    async discard(stage){
     if(!ownedStages.has(stage))throw fail('FS_HANDLE_REJECTED','Staging allocation belongs to another operation');
     stage.tree?.close();stage.tree=undefined;
     // Remove only the original private IDs and bytes; an added/replaced entry
     // prevents cleanup. Publication removes just the payload from this plan.
     if(stage.publication)stage.created=stage.created.filter(row=>row.relative!==stage.targetName&&!row.relative.startsWith(stage.targetName+'/'));
     stage.lease?.close();stage.lease=undefined;
     let captured;
     try{
      captured=await openExperimentalPrivateTree(root,stage.directory,{deletion:true,expectedIdentity:stage.identity});
      checkOwned({stage,capture:captured});await beforeCleanup(sourceFact(stage));
      const remaining=captured.manifest.entries.map(row=>({...row}));
      await checkpoint(stage,'cleaning',{cleanup:{remaining}});
      await captured.remove({expectedManifestSha256:captured.manifest.sha256,
       beforeEntry:async row=>checkpoint(stage,'cleaning',{cleanup:{remaining:remaining.slice(),pending:row.relative}}),
       afterEntry:async(relative,fact)=>{remaining.splice(remaining.findIndex(row=>row.relative===relative),1);await afterCleanupEntry(relative,fact);await checkpoint(stage,'cleaning',{cleanup:{remaining:remaining.slice()}});},
      });ownedStages.delete(stage);
     }catch(error){error.provisioning=sourceFact(stage);throw error;}finally{captured?.close();}
    },
    async close(){
     const errors=[];
     for(const stage of ownedStages)for(const lease of [stage.tree,stage.lease])try{lease?.close();}catch(error){errors.push(error);}
     for(const lease of [...gates.values(),wrapper,parent])try{lease?.close();}catch(error){errors.push(error);}
     if(errors.length)throw Object.assign(errors[0],{cleanupErrors:errors});
    },
   };
  },
 });
}
