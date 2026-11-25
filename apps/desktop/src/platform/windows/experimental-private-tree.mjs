// Shared retained-tree state machine: private W1 consumers and the explicitly
// scoped desktop public-directory adapter use the same immutable manifest and
// relative directory/single-link file pins. This does not grant a global gate.
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';
import {openExperimentalSourceDirectory} from './experimental-source-directory.mjs';

const fail=(code,message)=>Object.assign(Error(message),{code});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fold=name=>name.normalize('NFKC').toUpperCase().toLowerCase();
const aborted=signal=>{if(signal?.aborted)throw fail('ABORT_ERR','Private tree operation aborted');};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const normalize=cause=>cause instanceof Error?cause:Object.assign(Error('Private tree operation failed',{cause}),{code:'FS_TREE_FAILED'});
const checkId=identity=>{if(typeof identity!=='string'||!/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(identity))throw fail('FS_IDENTITY_REJECTED','Expected canonical directory identity');};

export function openExperimentalPrivateTree(root,directory,options={}) {
  return openTree(root,directory,options,false);
}
export function openExperimentalSourceTree(root,directory,options={}) {
  return openTree(root,directory,options,true);
}
async function openTree(root,directory,{
  expectedIdentity,maxEntries=10000,maxBytes=1024*1024*1024,signal:baseSignal,
  fileSync=file=>file.sync(),directorySync=directory=>directory.syncDirectory(),deletion=false,rootAccess='move',fileAccess='readwrite',
  sourceLease,
}={},publicSource=false) {
  const components=experimentalPrivateDirectoryComponents(root,directory);
  if(expectedIdentity!==undefined)checkId(expectedIdentity);
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>10000||!Number.isSafeInteger(maxBytes)||maxBytes<0)
    throw fail('FS_TREE_LIMIT','Expected 1..10000 entries and a nonnegative safe byte limit');
  if(typeof fileSync!=='function'||typeof directorySync!=='function')throw new TypeError('Expected private tree barrier functions');
  if(typeof deletion!=='boolean')throw new TypeError('Expected explicit deletion lease boolean');
  if(!['move','readwrite'].includes(rootAccess)||deletion&&rootAccess!=='move')throw new TypeError('Expected move or readwrite root access; deletion requires move');
  if(!['readwrite','read'].includes(fileAccess)||deletion&&fileAccess!=='readwrite')throw new TypeError('Expected readwrite or read file access; deletion requires readwrite');
  aborted(baseSignal);
  let parent,rootLease,manifest,closed=false,busy=false,readers=0,needsReopen=false,publication,publicationTarget,removalAttempted=false;
  let directories=[],files=[],extraLeases=[];
  const requireOpen=()=>{if(closed)throw fail('FS_HANDLE_CLOSED','Private tree closed');};
  const exclusive=async run=>{
    requireOpen();if(removalAttempted)throw fail('FS_TREE_REMOVAL_ATTEMPTED','Reopen and reconcile the remaining tree before any further operation');
    if(busy||readers)throw fail('FS_TREE_BUSY','Private tree operation or reader still active');
    busy=true;
    try{return await run();}
    catch(cause){const error=normalize(cause);if(publication){error.committed=true;error.durability='uncertain';error.privateTreePublication??={...publication};}throw error;}
    finally{busy=false;}
  };
  const closeDescendants=()=>{
    const errors=[];
    for(const row of files)try{row.lease.close();}catch(error){errors.push(error);}
    for(const row of [...directories].reverse())if(row.lease!==rootLease)try{row.lease.close();}catch(error){errors.push(error);}
    files=[];directories=[];needsReopen=true;
    if(errors.length)throw Object.assign(errors[0],{cleanupErrors:errors});
  };
  const close=()=>{
    if(closed)return;closed=true;const errors=[];
    try{closeDescendants();}catch(error){errors.push(error);}
    for(const lease of [...extraLeases].reverse().concat([rootLease,parent]))try{lease?.close();}catch(error){errors.push(error);}
    extraLeases=[];if(errors.length)throw Object.assign(errors[0],{cleanupErrors:errors});
  };
  const hashFile=async(row,signal)=>{
    const hash=createHash('sha256');let offset=0;
    while(offset<row.entry.byteLength){
      requireOpen();aborted(signal);const bytes=row.lease.readAt(offset,Math.min(256*1024,row.entry.byteLength-offset));
      if(!bytes.length)throw fail('FS_TREE_CHANGED','Private tree file truncated');hash.update(bytes);offset+=bytes.length;await setImmediate();
    }
    row.lease.verify();return hash.digest('hex');
  };
  const readRows=lease=>lease.entries(maxEntries);
  const capture=async(signal)=>{
    let totalBytes=0,count=0;const entries=[];
    const walk=async(lease,relative,record)=>{
      if(!record){record={lease,relative,rows:[]};directories.push(record);}
      requireOpen();aborted(signal);const rows=readRows(lease),seen=new Set();record.rows=rows;
      entries.push({relative,type:'directory',identity:lease.identity(),securitySha256:digest(publicSource?lease.securityBytes():lease.privateSecurityBytes())});
      for(const row of rows){
        const childRelative=relative?relative+'/'+row.name:row.name;
        experimentalPrivateDirectoryComponents(root,path.join(directory,...childRelative.split('/')));
        if(!row.name.isWellFormed()||seen.has(fold(row.name)))throw fail('FS_PATH_REJECTED','Private tree contains ambiguous names');
        seen.add(fold(row.name));if(++count>maxEntries)throw fail('FS_TREE_LIMIT','Private tree exceeds entry limit');
      }
      for(const row of rows){
        requireOpen();aborted(signal);const childRelative=relative?relative+'/'+row.name:row.name;
        if(row.directory){
          const child=publicSource?lease.openDirectory(row.name):deletion?lease.openPrivateDeleteDirectory(row.name):lease.openPrivateDirectory(row.name,false);
          // Record immediately so a failed ID check cannot leak an ancestor pin.
          const marker={lease:child,relative:childRelative,rows:[]};directories.push(marker);
          if(child.identity()!==row.identity)throw fail('FS_TREE_CHANGED','Private directory changed after enumeration');
          await walk(child,childRelative,marker);
        }else{
          const child=publicSource?lease.openFile(row.name):deletion?lease.openPrivateDeleteFile(row.name):fileAccess==='read'?lease.openPrivateObjectRead(row.name):lease.openPrivateTreeFile(row.name),record={lease:child};files.push(record);
          const stat=child.stat();
          if(stat.identity!==row.identity||stat.attributes!==row.attributes)throw fail('FS_TREE_CHANGED','Private file changed after enumeration');
          if(stat.size<0n||stat.size>BigInt(maxBytes-totalBytes))throw fail('FS_TREE_LIMIT','Private tree exceeds byte limit');
          totalBytes+=Number(stat.size);record.entry={relative:childRelative,type:'file',identity:stat.identity,attributes:stat.attributes,byteLength:Number(stat.size),securitySha256:digest(stat.security)};
          record.entry.sha256=await hashFile(record,signal);entries.push(record.entry);
        }
      }
      lease.verify();if(!same(rows,readRows(lease)))throw fail('FS_TREE_CHANGED','Private directory membership changed during capture');
    };
    await walk(rootLease,'');
    entries.sort((a,b)=>a.relative<b.relative?-1:a.relative>b.relative?1:0);
    const value={schema:1,rootIdentity:rootLease.identity(),entries,entryCount:count,totalBytes};
    return {...value,sha256:digest(JSON.stringify(value))};
  };
  const verify=async(signal)=>{
    requireOpen();aborted(signal);
    if(needsReopen){
      try{
        const actual=await capture(signal);
        if(!same(actual,manifest))throw fail('FS_TREE_CHANGED','Private tree differs from the retained manifest after handle release');
        needsReopen=false;
      }catch(error){try{closeDescendants();}catch(cleanup){error.cleanupErrors=[cleanup];}throw error;}
    }
    for(const lease of extraLeases)lease.verify();
    for(const row of directories){requireOpen();aborted(signal);row.lease.verify();if(!same(row.rows,readRows(row.lease)))throw fail('FS_TREE_CHANGED','Private directory membership changed');}
    for(const row of files){if(await hashFile(row,signal)!==row.entry.sha256)throw fail('FS_TREE_CHANGED','Private file digest changed');}
    for(const row of directories)if(!same(row.rows,readRows(row.lease)))throw fail('FS_TREE_CHANGED','Private directory membership changed during verification');
    return {schema:1,state:'verified',identity:manifest.rootIdentity,manifestSha256:manifest.sha256};
  };
  const sync=async(signal)=>{
    if(fileAccess!=='readwrite')throw fail('FS_HANDLE_REJECTED','A read-only tree cannot claim file flushes');
    await verify(signal);
    for(const row of files){aborted(signal);await fileSync(row.lease,{relative:row.entry.relative,phase:'tree'});await setImmediate();}
    for(const row of [...directories].reverse()){aborted(signal);await directorySync(row.lease,{relative:row.relative,phase:'tree'});}
    aborted(signal);await directorySync(parent,{relative:null,phase:'parent'});
    if(publicationTarget)await directorySync(publicationTarget,{relative:null,phase:'destination-parent'});
    await verify(signal);
    return {schema:1,state:'barriers-completed',durability:'namespace-not-qualified',identity:manifest.rootIdentity,manifestSha256:manifest.sha256,
      files:files.length,directories:directories.length,...(publication?{publication:{...publication}}:{}),barriers:{files:'flushed',directories:'flushed',parent:'flushed',...(publicationTarget?{destinationParent:'flushed'}:{})}};
  };
  try{
    if(publicSource)rootLease=sourceLease??openExperimentalSourceDirectory(root,directory);
    else{parent=openExperimentalPersistenceParent(root,components.join('/'));rootLease=rootAccess==='move'?parent.openPrivateTreeRoot(components.at(-1)):parent.openPrivateDirectory(components.at(-1),false);}
    if(expectedIdentity!==undefined&&rootLease.identity()!==expectedIdentity)throw fail('FS_DIRECTORY_CONFLICT','Private tree root identity differs');
    manifest=await capture(baseSignal);needsReopen=false;
    for(const entry of manifest.entries)Object.freeze(entry);Object.freeze(manifest.entries);Object.freeze(manifest);
    await verify(baseSignal);
  }catch(cause){const error=normalize(cause);try{close();}catch(cleanup){error.cleanupErrors=[cleanup];}throw error;}

  const result={
    manifest,
    // Experimental observation only. The caller must supply independently
    // retained, authenticated post-barrier receipts, not infer them from absence.
    removalBinding(){
      requireOpen();
      if(!deletion)throw fail('FS_HANDLE_REJECTED','Expected an explicit deletion tree lease');
      parent.verify();
      return {directory,parentIdentity:parent.identity(),manifest};
    },
    inspectRemovalProgress(binding,confirmedRemoved,{signal=baseSignal}={}){
      return exclusive(async()=>{
        if(!parent||deletion||rootAccess!=='readwrite'||fileAccess!=='read')throw fail('FS_HANDLE_REJECTED','Expected a private observation lease without delete or move access and with read-only files');
        const original=binding?.manifest;
        if(original?.schema!==1||!Array.isArray(original.entries)||!Array.isArray(confirmedRemoved))throw fail('FS_VERSION_REJECTED','Expected the original manifest and confirmed member receipts');
        const {schema,rootIdentity,entries,entryCount,totalBytes,sha256:originalManifestSha256}=original;
        if(digest(JSON.stringify({schema,rootIdentity,entries,entryCount,totalBytes}))!==originalManifestSha256)throw fail('FS_VERSION_REJECTED','Original manifest digest mismatch');
        if(binding.directory!==directory||binding.parentIdentity!==parent.identity()||rootIdentity!==manifest.rootIdentity)throw fail('FS_TREE_CHANGED','Removal parent or tree root differs');
        const remaining=new Map(entries.map(entry=>[entry.relative,entry]));
        for(const receipt of confirmedRemoved){
          const row=remaining.get(receipt?.relative);
          if(!row?.relative||row.identity!==receipt.identity||row.type!==receipt.type)throw fail('FS_VERSION_REJECTED','Unexpected or duplicate confirmed member receipt');
          remaining.delete(row.relative);
        }
        if(!same([...remaining.values()],manifest.entries))throw fail('FS_TREE_CHANGED','Remaining members differ from the original manifest and confirmed receipts');
        await verify(signal);
        parent.verify();
        const directorySecurity=new Map(manifest.entries.filter(entry=>entry.type==='directory').map(entry=>[entry.relative,entry.securitySha256]));
        for(const row of directories)if(digest(row.lease.privateSecurityBytes())!==directorySecurity.get(row.relative))throw fail('FS_TREE_CHANGED','Remaining directory security changed');
        return {state:'survivors-verified',originalManifestSha256,remainingManifestSha256:manifest.sha256};
      });
    },
    // The caller supplies a typed native self-move from the retained root.
    // Preserve the existing capture/verify state machine across the Windows
    // descendant-release window; never reopen the public root by its old path.
    publishPinned({prepareMove,beforeCommit=async()=>{},barriers=async()=>{}}){
      return exclusive(async()=>{
        if(!publicSource||!sourceLease)throw fail('FS_HANDLE_REJECTED','An explicit retained public root is required');
        if(publication)throw fail('FS_MOVE_PUBLISHED','Reconcile a published tree instead of replaying');
        if(typeof prepareMove!=='function'||typeof beforeCommit!=='function'||typeof barriers!=='function')throw new TypeError('Expected publication callbacks');
        let move,moved=false,primaryError;
        try{
          await verify(baseSignal);move=prepareMove(manifest);closeDescendants();
          await beforeCommit(manifest);requireOpen();aborted(baseSignal);rootLease.verify();move.verify();
          move.commit();moved=true;publication={identity:manifest.rootIdentity,manifestSha256:manifest.sha256,moved:true};
          extraLeases.push(move);move=undefined;
          await barriers();await verify(undefined);
          return {...publication,rechecked:true,durability:'namespace-not-qualified'};
        }catch(cause){
          const error=normalize(cause);moved||=Boolean(error.committed);
          if(moved){publication={identity:manifest.rootIdentity,manifestSha256:manifest.sha256,moved:true};error.committed=true;error.durability='uncertain';}
          primaryError=error;throw error;
        }finally{
          try{move?.close();}catch(error){if(primaryError)primaryError.cleanupErrors=[...(primaryError.cleanupErrors??[]),error];else throw error;}
        }
      });
    },
    verify:({signal=baseSignal}={})=>exclusive(()=>verify(signal)),
    sync:({signal=baseSignal}={})=>exclusive(()=>sync(signal)),
    syncDirectories:({signal=baseSignal}={})=>exclusive(async()=>{
      await verify(signal);
      for(const row of [...directories].reverse()){aborted(signal);await directorySync(row.lease,{relative:row.relative,phase:'tree'});}
      await directorySync(parent,{relative:null,phase:'parent'});await verify(signal);
      return {schema:1,state:'directory-barriers-completed',durability:'namespace-not-qualified',identity:manifest.rootIdentity,manifestSha256:manifest.sha256,barriers:{files:'not-flushed-by-this-lease',directories:'flushed',parent:'flushed'}};
    }),
    async *streamFile(relative,{signal=baseSignal}={}){
      requireOpen();if(removalAttempted)throw fail('FS_TREE_REMOVAL_ATTEMPTED','Reconcile the remaining tree');
      if(busy||needsReopen)throw fail('FS_TREE_BUSY','Private tree requires verification or another operation is active');
      const row=files.find(row=>row.entry.relative===relative);if(!row)throw fail('FS_TREE_FILE_MISSING','File is outside the retained private tree');
      readers++;const hash=createHash('sha256');let offset=0;
      try{
        while(offset<row.entry.byteLength){requireOpen();aborted(signal);const bytes=row.lease.readAt(offset,Math.min(256*1024,row.entry.byteLength-offset));if(!bytes.length)throw fail('FS_TREE_CHANGED','Private tree file truncated');offset+=bytes.length;hash.update(bytes);yield bytes;}
        row.lease.verify();if(hash.digest('hex')!==row.entry.sha256)throw fail('FS_TREE_CHANGED','Private tree stream digest changed');
      }finally{readers--;}
    },
    async readFile(relative,{maxBytes=1024*1024,signal=baseSignal}={}){
      requireOpen();if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw fail('FS_READ_LIMIT','Expected nonnegative safe byte limit');
      const entry=manifest.entries.find(row=>row.type==='file'&&row.relative===relative);
      if(!entry)throw fail('FS_TREE_FILE_MISSING','File is outside the retained private tree');if(entry.byteLength>maxBytes)throw fail('FS_READ_LIMIT','Private tree file exceeds reader limit');
      const chunks=[];for await(const bytes of this.streamFile(relative,{signal}))chunks.push(bytes);return Buffer.concat(chunks,entry.byteLength);
    },
    copyTo(destination,{signal=baseSignal,beforeEntry=()=>{},destinationRoot=root}={}){
      return exclusive(async()=>{
        if(publication)throw fail('FS_MOVE_PUBLISHED','Reopen a published tree before copying');
        const to=experimentalPrivateDirectoryComponents(destinationRoot,destination);
        // Validate every destination path before creating any namespace entry.
        for(const entry of manifest.entries)experimentalPrivateDirectoryComponents(destinationRoot,path.join(destination,...entry.relative.split('/')));
        const fromFold=fold(directory),toFold=fold(destination);
        if(fromFold===toFold||toFold.startsWith(fromFold+path.sep)||fromFold.startsWith(toFold+path.sep))throw fail('FS_PATH_REJECTED','Copy trees must have disjoint paths');
        if(typeof beforeEntry!=='function')throw new TypeError('Expected copy precondition function');
        let targetParent,targetRoot,stage,activeFile,primaryError;
        const targetDirectories=new Map(),targetFiles=[],created=[];
        const fact=()=>({source:directory,destination,sourceManifestSha256:manifest.sha256,created:created.map(row=>({...row}))});
        const verifyTarget=async()=>{
          for(const [relative,lease] of targetDirectories){
            lease.verify();const expected=created.filter(row=>row.relative!==''&&path.posix.dirname(row.relative)===(relative||'.'));
            const actual=lease.entries(maxEntries);
            if(actual.length!==expected.length||actual.some(row=>!expected.some(entry=>entry.identity===row.identity&&path.posix.basename(entry.relative)===row.name&&row.directory===(entry.type==='directory'))))
              throw fail('FS_TREE_CHANGED','Copy destination membership differs from created identities');
          }
          for(const row of targetFiles)if(await hashFile(row,signal)!==row.entry.sha256)throw fail('FS_TREE_CHANGED','Copy destination differs from source content');
        };
        try{
          aborted(signal);await verify(signal);
          targetParent=openExperimentalPersistenceParent(destinationRoot,to.join('/'));
          targetRoot=targetParent.createPrivateTreeRootExclusive(to.at(-1));
          targetDirectories.set('',targetRoot);created.push({relative:'',type:'directory',identity:targetRoot.identity()});
          await directorySync(targetRoot,{relative:'',phase:'copy-create'});await directorySync(targetParent,{relative:null,phase:'copy-parent'});
          // Parents precede children independently of locale sorting.
          for(const entry of [...manifest.entries].filter(row=>row.relative).sort((a,b)=>a.relative.split('/').length-b.relative.split('/').length||(a.relative<b.relative?-1:1))){
            requireOpen();aborted(signal);await beforeEntry(Object.freeze({...entry}),fact());requireOpen();aborted(signal);
            const parentRelative=path.posix.dirname(entry.relative),lease=targetDirectories.get(parentRelative==='.'?'':parentRelative),name=path.posix.basename(entry.relative);
            if(entry.type==='directory'){
              const child=lease.createPrivateDirectoryExclusive(name);targetDirectories.set(entry.relative,child);
              created.push({relative:entry.relative,type:'directory',identity:child.identity()});
              await directorySync(child,{relative:entry.relative,phase:'copy-create'});await directorySync(lease,{relative:parentRelative,phase:'copy-entry-parent'});
            }else{
              const source=files.find(row=>row.entry.relative===entry.relative);source.lease.verify();
              stage=lease.createPrivateExclusive(`.nozeli-${randomUUID()}.pending`);const hash=createHash('sha256');let offset=0;
              while(offset<entry.byteLength){
                requireOpen();aborted(signal);const bytes=source.lease.readAt(offset,Math.min(256*1024,entry.byteLength-offset));
                if(!bytes.length)throw fail('FS_TREE_CHANGED','Copy source truncated');hash.update(bytes);stage.write(bytes);offset+=bytes.length;await setImmediate();
              }
              source.lease.verify();if(hash.digest('hex')!==entry.sha256)throw fail('FS_TREE_CHANGED','Copy source differs from retained digest');
              const createdFile={relative:entry.relative,type:'file',identity:stage.identity(),sha256:entry.sha256,byteLength:entry.byteLength};
              aborted(signal);stage.sync();
              try{stage.publishNew(name);}catch(error){if(error.committed)created.push(createdFile);throw error;}
              created.push(createdFile);stage.close();stage=undefined;
              activeFile=lease.openPrivateTreeFile(name);
              if(activeFile.stat().identity!==createdFile.identity)throw fail('FS_TREE_CHANGED','Published copy file was replaced before pinning');
              targetFiles.push({lease:activeFile,entry});activeFile=undefined;
              await directorySync(lease,{relative:parentRelative,phase:'copy-entry-parent'});
            }
          }
          await verify(signal);await verifyTarget();
          for(const row of targetFiles){aborted(signal);await fileSync(row.lease,{relative:row.entry.relative,phase:'copy'});}
          for(const [relative,lease] of [...targetDirectories].reverse()){aborted(signal);await directorySync(lease,{relative,phase:'copy'});}
          await directorySync(targetParent,{relative:null,phase:'copy-parent'});await verifyTarget();await verify(signal);
          return {schema:1,state:'barriers-completed',durability:'namespace-not-qualified',...fact(),rechecked:true,
            barriers:{files:'flushed',directories:'flushed',parent:'flushed'}};
        }catch(cause){
          const error=normalize(cause);error.privateTreeCopy=fact();if(created.length||error.committed){error.committed=true;error.durability='uncertain';}primaryError=error;throw error;
        }finally{
          const errors=[];for(const lease of [stage,activeFile,...targetFiles.map(row=>row.lease),...[...targetDirectories.values()].reverse(),targetParent])try{lease?.close();}catch(error){errors.push(error);}
          if(errors.length){if(primaryError)primaryError.cleanupErrors=errors;else throw Object.assign(normalize(errors[0]),{cleanupErrors:errors,committed:true,durability:'uncertain',privateTreeCopy:fact()});}
        }
      });
    },
    remove({expectedManifestSha256,signal=baseSignal,beforeEntry=()=>{},afterEntry=()=>{}}={}){
      return exclusive(async()=>{
        if(!deletion)throw fail('FS_HANDLE_REJECTED','Open an explicit deletion tree lease');
        if(publication)throw fail('FS_MOVE_PUBLISHED','Reopen a published tree before deletion');
        if(typeof expectedManifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedManifestSha256))throw fail('FS_VERSION_REJECTED','A complete expected tree manifest SHA-256 is required');
        if(expectedManifestSha256!==manifest.sha256)throw fail('FS_TREE_CHANGED','Tree differs from the expected removal manifest');
        if(typeof beforeEntry!=='function'||typeof afterEntry!=='function')throw new TypeError('Expected removal checkpoint functions');
        const removed=[],remaining=new Map(manifest.entries.map(row=>[row.relative,row]));
        const fact=()=>({directory,identity:manifest.rootIdentity,manifestSha256:manifest.sha256,removed:removed.map(row=>({...row})),rootRemoved:!remaining.has('')});
        const verifyRemaining=()=>{
          for(const row of directories){
            if(!remaining.has(row.relative))continue;row.lease.verify();
            const expected=row.rows.filter(child=>remaining.has(row.relative?row.relative+'/'+child.name:child.name));
            if(!same(expected,readRows(row.lease)))throw fail('FS_TREE_CHANGED','Unreviewed members appeared during removal');
          }
        };
        try{
          await sync(signal);aborted(signal);removalAttempted=true;
          const ordered=[...files.map(row=>({...row,relative:row.entry.relative,type:'file'})),...[...directories].reverse().map(row=>({...row,type:'directory'}))];
          for(const row of ordered){
            requireOpen();aborted(signal);await beforeEntry(remaining.get(row.relative),fact());requireOpen();aborted(signal);verifyRemaining();
            if(row.type==='file'){
              if(await hashFile(row,signal)!==row.entry.sha256)throw fail('FS_TREE_CHANGED','Removal file differs from approved digest');
              // No await between the final membership check and native deletion.
              verifyRemaining();row.lease.remove();
            }else row.lease.removePrivateEmptyDirectory();
            removed.push({relative:row.relative,type:row.type,identity:remaining.get(row.relative).identity});remaining.delete(row.relative);
            const parentRelative=path.posix.dirname(row.relative),parentDirectory=row.relative===''?parent:directories.find(entry=>entry.relative===(parentRelative==='.'?'':parentRelative)).lease;
            // Once an entry is deleted, finish its barrier even if abort arrives.
            await directorySync(parentDirectory,{relative:row.relative===''?null:parentRelative,phase:'remove-parent'});
            await afterEntry(row.relative,fact());
          }
          return {schema:1,state:'barriers-completed',durability:'namespace-not-qualified',...fact(),barriers:{parents:'flushed'}};
        }catch(cause){const error=normalize(cause);error.privateTreeRemoval=fact();if(removed.length){error.committed=true;error.durability='uncertain';}throw error;}
      });
    },
    publishTo(destination,{signal=baseSignal,beforeCommit=()=>{}}={}){
      return exclusive(async()=>{
        if(rootAccess!=='move'||fileAccess!=='readwrite')throw fail('FS_HANDLE_REJECTED','Publication requires the complete writable/move tree contract');
        const to=experimentalPrivateDirectoryComponents(root,destination);if(typeof beforeCommit!=='function')throw new TypeError('Expected publication precondition function');
        if(publication)throw fail('FS_MOVE_PUBLISHED','Private tree publication already attempted after commit; reconcile instead of replaying');
        if(fold(directory)===fold(destination))throw fail('FS_NAME_REJECTED','Private tree publication requires distinct names');
        aborted(signal);let target,move,moved=false,released=false,primaryError;
        const fact=()=>({source:directory,destination,identity:manifest.rootIdentity,manifestSha256:manifest.sha256,moved});
        try{
          target=openExperimentalPersistenceParent(root,to.join('/'));
          await sync(signal);aborted(signal);
          move=rootLease.beginPrivateSelfMove(target,to.at(-1),manifest.rootIdentity);
          // Windows refuses directory rename with strict descendant pins open.
          // Keep the exact root HANDLE while releasing descendants; afterward
          // reopen relative to that same root and compare the entire manifest.
          closeDescendants();released=true;
          await beforeCommit(manifest);requireOpen();aborted(signal);rootLease.verify();move.verify();move.commit();moved=true;
          publication=fact();publicationTarget=target;extraLeases.push(target,move);target=move=undefined;
          await directorySync(rootLease,{relative:'',phase:'published'});
          await directorySync(parent,{relative:null,phase:'source-parent'});
          await directorySync(extraLeases.at(-2),{relative:null,phase:'destination-parent'});
          await verify(undefined);
          return {schema:1,state:'barriers-completed',durability:'namespace-not-qualified',...publication,
            barriers:{tree:'flushed-before-publication',directory:'flushed',sourceParent:'flushed',destinationParent:'flushed'},rechecked:true};
        }catch(cause){
          const error=normalize(cause);moved||=Boolean(error.committed);
          if(moved){publication=fact();error.committed=true;error.durability='uncertain';if(target){publicationTarget=target;extraLeases.push(target);target=undefined;}if(move){extraLeases.push(move);move=undefined;}}
          error.privateTreePublication=fact();if(released)needsReopen=true;primaryError=error;throw error;
        }finally{
          const errors=[];for(const lease of [move,target])try{lease?.close();}catch(error){errors.push(error);}
          if(errors.length){if(primaryError)primaryError.cleanupErrors=errors;else{const error=normalize(errors[0]);error.privateTreePublication=fact();if(moved){error.committed=true;error.durability='uncertain';}throw error;}}
        }
      });
    },
    close,
  };
  if(publicSource)return Object.freeze({manifest:result.manifest,verify:result.verify,streamFile:result.streamFile,readFile:result.readFile,copyTo:result.copyTo,...(sourceLease?{publishPinned:result.publishPinned}:{}),close:result.close});
  return Object.freeze(result);
}
