// Scoped object-store qualification; production filesystem/persistence selectors
// remain disabled. Business hashing and CAS decisions stay in MaterialStore.
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import {experimentalPrivateDirectoryComponents,ensureExperimentalPrivateDirectory} from './experimental-directories.mjs';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';

const fail=(code,message)=>Object.assign(Error(message),{code});
const mapped=error=>{if(error.code==='WIN32_IO_ERROR'&&[2,3].includes(error.win32Code))error.code='ENOENT';return error;};
const chunkBytes=256*1024;

export function createExperimentalMaterialStoreIO(root,directory,{createDirectory}) {
 const components=experimentalPrivateDirectoryComponents(root,directory),relative=components.join('/');
 const open=()=>{
  const ancestor=openExperimentalPersistenceParent(root,relative);
  // Retain the directory's private policy snapshot in the chain used by stages,
  // rather than merely checking its current ACL before an asynchronous stream.
  try{return ancestor.openPrivateDirectory(components.at(-1),false);}finally{ancestor.close();}
 };
 return Object.freeze({
  qualification:Object.freeze({state:'barriers-completed',durability:'namespace-not-qualified',productionSelected:false}),
  async ensureDirectory(){
   if(createDirectory)await ensureExperimentalPrivateDirectory(root,directory);
   let parent;try{parent=open();parent.privateSecurityBytes();parent.verify();}catch(error){throw mapped(error);}finally{parent?.close();}
  },
  async openObject(digest){
   let parent,lease;
   try{
    parent=open();lease=parent.openPrivateObjectRead(digest);const nativeStat=lease.stat();
    if(nativeStat.size<0n||nativeStat.size>BigInt(Number.MAX_SAFE_INTEGER))throw fail('MATERIAL_TOO_LARGE','Material size is not representable.');
    const stat=Object.freeze({size:Number(nativeStat.size),identity:nativeStat.identity,attributes:nativeStat.attributes});let closed=false;
    const verify=()=>{if(closed)throw fail('FS_HANDLE_CLOSED','Material reader closed');lease.verify();parent.verify();return false;};
    const handle=Object.freeze({async read(buffer,offset,length,position){
     verify();if(!(buffer instanceof Uint8Array)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||offset+length>buffer.length||!Number.isSafeInteger(position)||position<0)throw fail('FS_READ_LIMIT','Invalid positional material read');
     const bytes=length?lease.readAt(position,Math.min(length,chunkBytes)):Buffer.alloc(0);buffer.set(bytes,offset);return {bytesRead:bytes.length,buffer};
    }});
    const stream=()=>Readable.from((async function*(){let offset=0;while(offset<stat.size){verify();const bytes=lease.readAt(offset,Math.min(chunkBytes,stat.size-offset));if(!bytes.length)throw fail('MATERIAL_CORRUPT','Material truncated.');offset+=bytes.length;yield bytes;await setImmediate();}verify();})(),{objectMode:false});
    return {handle,stat,stream,verify,close(){if(closed)return;closed=true;try{lease.close();}finally{parent.close();}}};
   }catch(error){try{lease?.close();}finally{parent?.close();}throw mapped(error);}
  },
  async createStage(){
   let parent,stage,facts;const temporaryName='.pending-'+randomUUID();
   try{parent=open();parent.privateSecurityBytes();stage=parent.createPrivateExclusive(temporaryName);facts=Object.freeze({temporaryName,identity:stage.identity()});}
   catch(error){try{stage?.close();}catch(cleanupError){error.cleanupErrors=[cleanupError];}finally{parent?.close();}throw mapped(error);}
   return {
    facts,
    async write(bytes){for(let offset=0;offset<bytes.length;offset+=chunkBytes){stage.write(bytes.subarray(offset,offset+chunkBytes));await setImmediate();}},
    sync:()=>stage.sync(),
    publish(digest){try{stage.publishNew(digest);return true;}catch(error){if(error.code!=='FS_TARGET_EXISTS')throw error;return false;}},
    releaseFile(){stage?.close();stage=null;},
    syncDirectory(){parent.syncDirectory();parent.verify();},
    close(){try{stage?.close();stage=null;}finally{parent.close();}},
   };
  },
 });
}
