// Scoped private archive effects. Shared WorkChanges owns report/receipt decisions.
import path from 'node:path';
import {experimentalPrivateDirectoryComponents,ensureExperimentalPrivateDirectory} from './experimental-directories.mjs';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';
import {createExperimentalExecutionWorkspaceIO} from './experimental-execution-workspace.mjs';
import {openExperimentalPrivateTree} from './experimental-private-tree.mjs';

const fail=(code,message)=>Object.assign(Error(message),{code});
const missing=error=>error.code==='WIN32_IO_ERROR'&&[2,3].includes(error.win32Code);
const layout=['branches','hooks','info','objects','objects/info','objects/pack','refs','refs/heads','refs/tags','refs/nozeli','refs/nozeli/changes'];

export function createExperimentalWorkChangesIO(root,{directorySync}={}){
 const json=createExperimentalExecutionWorkspaceIO(root,{directorySync});
 const flush=directorySync??(parent=>parent.syncDirectory());
 const relative=file=>experimentalPrivateDirectoryComponents(root,file).join('/');
 const parentFor=file=>openExperimentalPersistenceParent(root,relative(file));
 const pin=directory=>{const parent=parentFor(directory);let lease;try{lease=parent.openPrivateDirectory(path.basename(directory),false);return {lease,close(){try{lease.close();}finally{parent.close();}}};}catch(error){parent.close();throw error;}};
 const recordFile=directory=>path.join(path.dirname(directory),'archive-repository.json');
 const verifyRecord=(record,format)=>{if(!record||record.schema!==1||typeof record.identity!=='string'||!['allocated','ready'].includes(record.status)||!['sha1','sha256'].includes(record.objectFormat)||format&&record.objectFormat!==format)throw fail('CHANGES_IDENTITY','Private archive allocation record does not match');};
 const withRepository=async(directory,fn)=>{
  const record=await json.readJson(recordFile(directory));verifyRecord(record);const held=pin(directory);
  try{if(held.lease.identity()!==record.identity)throw fail('CHANGES_IDENTITY','Private archive directory File ID changed');held.lease.verify();const result=await fn();held.lease.verify();return result;}finally{held.close();}
 };
 return Object.freeze({
  ...json,
  async writeJson(file,value){await ensureExperimentalPrivateDirectory(root,path.dirname(file));return json.writeJson(file,value);},
  async ensureRepository(directory,format,initialize){
   const file=recordFile(directory);await ensureExperimentalPrivateDirectory(root,path.dirname(directory));let record=await json.readJson(file);
   if(!record){
    const parent=parentFor(directory);let lease;
    try{
     try{lease=parent.createPrivateDirectoryExclusive(path.basename(directory));}catch(cause){throw Object.assign(fail('CHANGES_REPOSITORY_UNVERIFIED','Existing or unconfirmed private archive retained; no allocation adoption'),{cause});}
     record={schema:1,identity:lease.identity(),objectFormat:format,status:'allocated'};
     await json.writeJson(file,record);lease.syncDirectory();parent.syncDirectory();
    }catch(error){if(lease){error.committed=true;error.durability='uncertain';error.archiveAllocation={directory,identity:lease.identity()};}throw error;
    }finally{try{lease?.close();}finally{parent.close();}}
   }
   verifyRecord(record,format);
   return withRepository(directory,async()=>{
    if(record.status==='allocated'){
     for(const name of layout)await ensureExperimentalPrivateDirectory(root,path.join(directory,...name.split('/')));
     await initialize();record.status='ready';await json.writeJson(file,record);
    }
    return record;
   });
  },
  withRepository,
  prepareRefs:(directory,id)=>withRepository(directory,()=>ensureExperimentalPrivateDirectory(root,path.join(directory,'refs','nozeli','changes',id))),
  // Git creates read-only packs. Its pinned writer uses core.fsync=all; this
  // lease verifies immutable bytes/policy and flushes directories only. It must
  // not claim native file flushes or change pack attributes to obtain them.
  syncRepository:directory=>withRepository(directory,async()=>{const tree=await openExperimentalPrivateTree(root,directory,{rootAccess:'readwrite',fileAccess:'read'});try{return {...await tree.syncDirectories(),writerFsync:'bundled Git core.fsync=all; no native file-flush claim'};}finally{tree.close();}}),
  async openRemoval(file,{optional=false}={}){
   let parent,lease;
   try{
    parent=parentFor(file);lease=parent.openPrivateDeleteFile(path.basename(file));const size=lease.stat().size;
    if(size>16n*1024n*1024n)throw fail('CHANGES_LIMIT','Private archive metadata exceeds 16 MiB');
    const chunks=[];for(let offset=0;offset<Number(size);){const bytes=lease.readAt(offset,Math.min(256*1024,Number(size)-offset));if(!bytes.length)throw fail('CHANGES_RECOVERY_HELD','Private archive metadata truncated');chunks.push(bytes);offset+=bytes.length;}
    const identity=lease.stat().identity;lease.verify();parent.verify();return {bytes:Buffer.concat(chunks),async remove(){let removed=false;try{lease.verify();lease.remove();removed=true;await flush(parent);}catch(error){if(removed){error.committed=true;error.durability='uncertain';error.archiveRemoval={file,identity,removed:true};}throw error;}},close(){try{lease.close();}finally{parent.close();}}};
   }catch(error){try{lease?.close();}finally{parent?.close();}if(optional&&missing(error))return null;throw error;}
  },
 });
}
