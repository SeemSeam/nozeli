// Platform file effects only; preparation/publication/integration and recovery
// decisions remain in the shared ExecutionWorkspace state machine.
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {experimentalPrivateDirectoryComponents,ensureExperimentalPrivateDirectory} from './experimental-directories.mjs';
import {openExperimentalPersistenceParent,createExperimentalWindowsPersistence} from './experimental-persistence.mjs';
import {experimentalWindowsReadFilesystem as reads} from './experimental-filesystem.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message)=>Object.assign(Error(message),{code});
const missing=error=>error.code==='WIN32_IO_ERROR'&&[2,3].includes(error.win32Code);
const require=createRequire(import.meta.url);

export function createExperimentalExecutionWorkspaceIO(root,{directorySync,publicDirectory}={}){
 const anchor=file=>typeof root==='function'?root(file):root;
 const relative=file=>experimentalPrivateDirectoryComponents(anchor(file),file).join('/'),versions=new Map(),uncertain=new Set();
 const persistenceFor=file=>createExperimentalWindowsPersistence(anchor(file),{directorySync});
 const capture=async(file,{maxBytes=16*1024*1024}={})=>{
  const name=relative(file),reader=await reads.openAnchoredFile(anchor(file),name);if(!reader)return null;
  try{if(reader.stat.size>BigInt(maxBytes))throw fail('EXECUTION_EVIDENCE_LIMIT','Execution evidence exceeds its bound');const chunks=[];for await(const chunk of reader.stream())chunks.push(chunk);if(!(await reader.verify()).stable)throw fail('EXECUTION_EVIDENCE_CHANGED','Execution evidence changed');return Buffer.concat(chunks);}
  finally{await reader.close();}
 };
 const streamFile=async function*(file,expected){
  const reader=await reads.openAnchoredFile(anchor(file),relative(file));if(!reader)throw fail('EXECUTION_EVIDENCE_MISSING','Execution evidence missing');
  try{const hash=createHash('sha256');for await(const chunk of reader.stream()){hash.update(chunk);yield chunk;}if(hash.digest('hex')!==expected||!(await reader.verify()).stable)throw fail('EXECUTION_EVIDENCE_CHANGED','Execution evidence changed');}
  finally{await reader.close();}
 };
 const fileDigest=async file=>{const reader=await reads.openAnchoredFile(anchor(file),relative(file));if(!reader)return null;try{const hash=createHash('sha256');for await(const chunk of reader.stream())hash.update(chunk);if(!(await reader.verify()).stable)throw fail('EXECUTION_EVIDENCE_CHANGED','Execution evidence changed');return hash.digest('hex');}finally{await reader.close();}};
 const ensureDirectory=async directory=>{
  relative(directory);const publicRoot=await publicDirectory?.(directory);
  if(!publicRoot)return ensureExperimentalPrivateDirectory(anchor(directory),directory);
  const parts=directory===publicRoot?[]:experimentalPrivateDirectoryComponents(publicRoot,directory),pins=[];
  const bridge=require('../../../native/windows/build/Release/nozeli_windows_read.node');
  let created=false;
  try{
   let parent=bridge.openAnchoredPublicMutationParent(publicRoot,'__integration_directory__');pins.push(parent);
   for(let i=0;i<parts.length;i++){
    let child;
    try{child=bridge.openAnchoredPublicMutationParent(publicRoot,parts.slice(0,i+1).join('/')+'/__integration_directory__');}
    catch(error){if(!missing(error))throw error;parent.verify();child=parent.createPublicDirectoryExclusive(parts[i]);created=true;child.syncDirectory();parent.syncDirectory();}
    pins.push(child);child.verify();parent.verify();parent=child;
   }
   for(const pin of pins)pin.verify();
  }catch(error){if(created){error.committed=true;error.durability='uncertain';}throw error;}
  finally{for(const pin of pins.reverse())pin.close();}
 };
 const readJson=async file=>{
  if(uncertain.has(file))throw fail('EXECUTION_COMMIT_UNKNOWN','Cold reconciliation required after an uncertain manifest publication');
  let parent,lease;
  try{
   parent=openExperimentalPersistenceParent(anchor(file),relative(file));lease=parent.openPrivateObjectRead(path.basename(file));const size=lease.stat().size;
   if(size>16n*1024n*1024n)throw fail('EXECUTION_EVIDENCE_LIMIT','Execution manifest exceeds its bound');
   const chunks=[];for(let offset=0;offset<Number(size);){const chunk=lease.readAt(offset,Math.min(256*1024,Number(size)-offset));if(!chunk.length)throw fail('EXECUTION_EVIDENCE_CHANGED','Execution manifest truncated');chunks.push(chunk);offset+=chunk.length;}
   lease.verify();parent.verify();const bytes=Buffer.concat(chunks);versions.set(file,sha(bytes));return JSON.parse(bytes.toString('utf8'));
  }catch(error){if(missing(error)){versions.set(file,null);return null;}throw error;}
  finally{try{lease?.close();}finally{parent?.close();}}
 };
 const writeJson=async(file,value)=>{
  relative(file);if(uncertain.has(file))throw fail('EXECUTION_COMMIT_UNKNOWN','Cold reconciliation required after an uncertain manifest publication');
  if(!versions.has(file))await readJson(file);const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');
  try{const result=await persistenceFor(file).writeStream(relative(file),[bytes],{expectedSha256:versions.get(file),expectedNewSha256:sha(bytes)});versions.set(file,sha(bytes));return result;}
  catch(error){if(error.committed)uncertain.add(file);throw error;}
 };
 const copyFile=async(source,destination)=>{
  const digest=await fileDigest(source);if(digest===null)throw fail('EXECUTION_EVIDENCE_MISSING','Source evidence missing');
  const old=await fileDigest(destination);if(old===digest)return;if(old!==null)throw fail('EXECUTION_EVIDENCE_CONFLICT','Existing execution evidence retained');
  return persistenceFor(destination).writeStream(relative(destination),streamFile(source,digest),{expectedSha256:null,expectedNewSha256:digest});
 };
 const acquireLock=async(file,token,saved,record)=>{
  const parent=openExperimentalPersistenceParent(anchor(file),relative(file)),name=path.basename(file);let stage,lease;
  try{
   try{lease=parent.openPrivateLockFile(name);}catch(error){if(!missing(error))throw error;}
   if(lease){const stat=lease.stat();if(!saved||saved.identity!==stat.identity)throw fail('GIT_LOCKED','Existing Git lock has no matching allocation File ID');}
   else{
    stage=parent.createPrivateExclusive('.nozeli-lock-'+randomUUID());stage.write(Buffer.from(token));stage.sync();const identity=stage.identity();stage.publishNew(name);
    // Persist the exact published allocation before releasing its writer HANDLE.
    await record({identity});stage.close();stage=null;parent.syncDirectory();lease=parent.openPrivateLockFile(name);
    if(lease.stat().identity!==identity)throw fail('GIT_LOCKED','Git lock was replaced after allocation');
   }
   const bytes=lease.readAt(0,4096);if(bytes.toString()!==token||lease.stat().size!==BigInt(Buffer.byteLength(token)))throw fail('GIT_LOCKED','Git lock token changed');lease.verify();
   return {file,identity:lease.stat().identity,verify:()=>lease.verify(),
    remove(){lease.verify();lease.remove();parent.syncDirectory();},close(){try{lease.close();}finally{parent.close();}}};
  }catch(error){try{lease?.close();}finally{try{stage?.close();}finally{parent.close();}}throw error;}
 };
 const acquireIntegrationLocks=async(m,intent,persist)=>{
  const refFile=path.join(m.commonDir,m.targetRef),files=[refFile+'.lock',m.index+'.lock',m.headFile+'.lock'],held=[];
  try{
   for(const file of files){const lease=await acquireLock(file,intent.token,intent.locks?.[file],async identity=>{intent.locks??={};intent.locks[file]=identity;await persist();});held.push(lease);}
  }catch(error){for(const item of held.reverse())item.close();throw error;}
  const verify=()=>{for(const lease of held)lease.verify();};
  return {
   async installIndex(source,expectedSha256,expectedNewSha256){verify();return persistenceFor(m.index).writeStream(relative(m.index),streamFile(source,expectedNewSha256),{expectedSha256,expectedNewSha256});},
   async publishRef(){
    verify();const bytes=await capture(refFile,{maxBytes:256}),next=Buffer.from(intent.commit+'\n');
    if(bytes&&bytes.toString()!==m.targetHead+'\n')throw fail('HEAD_DRIFT','Loose target ref changed before CAS publication');
    return persistenceFor(refFile).writeStream(relative(refFile),[next],{expectedSha256:bytes?sha(bytes):null,expectedNewSha256:sha(next)});
   },
   async close({retain=false}={}){
    const errors=[];for(const item of held.reverse())try{if(!retain){item.remove();delete intent.locks[item.file];}}catch(error){errors.push(error);}finally{try{item.close();}catch(error){errors.push(error);}}
    if(errors.length)throw Object.assign(errors[0],{cleanupErrors:errors});
   },
  };
 };
 return Object.freeze({readJson,writeJson,ensureDirectory,copyFile,acquireIntegrationLocks,
  directoryIdentity(directory,expected){
   const pin=require('../../../native/windows/build/Release/nozeli_windows_read.node').openAnchoredDirectoryIdentity(anchor(directory),relative(directory)+'/__work_identity__');
   try{pin.verify();const identity=pin.identity();if(expected!==undefined&&identity!==expected)throw fail('IDENTITY_CHANGED','Work directory File ID changed');return identity;}finally{pin.close();}
  },
  qualification:Object.freeze({state:'barriers-completed',durability:'namespace-not-qualified',productionSelected:false}),
  async initializeIndex(target,source){
   const token='nozeli-index-init:'+randomUUID(),lock=await acquireLock(target+'.lock',token,null,async()=>{});
   try{const digest=await fileDigest(source);if(digest===null)throw fail('EXECUTION_EVIDENCE_MISSING','Initial index missing');await persistenceFor(target).writeStream(relative(target),streamFile(source,digest),{expectedSha256:null,expectedNewSha256:digest});}
   finally{try{lock.remove();}finally{lock.close();}}
  },
 });
}
