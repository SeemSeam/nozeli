import {createHash} from 'node:crypto';
import path from 'node:path';
import {ensureWindowsDesktopProfileDirectory} from './desktop-profile-directory.mjs';
import {createExperimentalWindowsPersistence,openExperimentalPersistenceParent} from './experimental-persistence.mjs';

const relative='nozeli/external-open-v1/queue.json',target='queue.json';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const missing=error=>error.code==='WIN32_IO_ERROR'&&[2,3].includes(error.win32Code);
const failure=(code,message)=>Object.assign(Error(message),{code});
function readLease(lease,parent,maxBytes){
 const {size}=lease.stat();
 if(size>BigInt(maxBytes))throw failure('OPEN_QUEUE_CORRUPT','Queue exceeds its bounded file format.');
 const chunks=[];let used=0;
 while(used<Number(size)){
  const chunk=lease.readAt(used,Math.min(256*1024,Number(size)-used));
  if(!chunk.length)throw failure('OPEN_QUEUE_CHANGED','Queue truncated during read.');
  chunks.push(chunk);used+=chunk.length;
 }
 lease.verify();parent.verify();const bytes=Buffer.concat(chunks,used);
 return {bytes,hash:digest(bytes)};
}

// Effects only: shared ExternalOpenQueue still owns claims, revisions and retry.
// Native barriers do not grant global Windows namespace durability qualification.
export function createWindowsOpenQueueIO(root,{maxBytes,fault}){
 const directory=path.join(root,'nozeli','external-open-v1');
 const directories=()=>ensureWindowsDesktopProfileDirectory(root,directory);
 const persistence=createExperimentalWindowsPersistence(root,{directorySync:async parent=>{
  await fault('directory-sync');parent.syncDirectory();
 }});
 return Object.freeze({
  directories,
  async read(){
   await directories();let parent,lease;
   try{
    parent=openExperimentalPersistenceParent(root,relative);
    try{lease=parent.openPrivateObjectRead(target);}catch(error){
     if(!missing(error))throw error;
     // Enumerate with the same retained parent. Unknown native/legacy stages
     // are recovery evidence, never garbage to remove on first use.
     const remnants=parent.entries(1024).filter(({name})=>{name=name.toLowerCase();return name.startsWith('.tmp-open-')||name.startsWith('queue.')||(name.startsWith('.nozeli-')&&name.endsWith('.pending'));});
     parent.verify();
     if(remnants.length)throw failure('OPEN_QUEUE_CORRUPT','Queue missing with retained recovery remnants.');
     return {bytes:null,hash:null};
    }
    return readLease(lease,parent,maxBytes);
   }finally{lease?.close();parent?.close();}
  },
  async write(bytes,expectedHash,beforePublish){
   await directories();
   try{
    await persistence.writeStream(relative,[bytes],{expectedSha256:expectedHash,expectedNewSha256:digest(bytes),checkpoint:fault,beforePublish});
    return digest(bytes);
   }catch(error){
    if(!error.committed&&(error.code==='FS_VERSION_CONFLICT'||(error.code==='WIN32_IO_ERROR'&&[2,3,80,183].includes(error.win32Code))))
     throw Object.assign(failure('OPEN_QUEUE_CHANGED','Queue changed before native publication; originals retained.'),{cause:error});
    throw error;
   }
  },
  async sync(expectedHash){
   let parent,lease;
   try{
    parent=openExperimentalPersistenceParent(root,relative);lease=parent.openPrivateTreeFile(target);
    await fault('file-sync');
    const raw=readLease(lease,parent,maxBytes);
    if(raw.hash!==expectedHash)throw failure('OPEN_QUEUE_CHANGED','Queue changed before persistence retry.');
    lease.sync();await fault('directory-sync');parent.syncDirectory();
   }finally{lease?.close();parent?.close();}
  },
 });
}
