import {platformPersistence} from '../platform/shared/persistence.mjs';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createExperimentalMaterialStoreIO} from '../platform/windows/experimental-material-store.mjs';

// Publication links can change ctime while preserving this content identity.
const identity=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.mode,stat.uid,stat.gid].join(':');

export function createMaterialStoreIO(directory,{createDirectory,experimentalWindowsRoot,fail}) {
 if(experimentalWindowsRoot!==undefined)return createExperimentalMaterialStoreIO(experimentalWindowsRoot,directory,{createDirectory});
 return Object.freeze({
  async ensureDirectory(){
   if(createDirectory)await fs.mkdir(directory,{recursive:true,mode:0o700});
   const stat=await fs.lstat(directory);
   if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('INVALID_DIRECTORY','Material directory is not a regular directory.');
  },
  async openObject(digest){
   let handle;
   try{
    const dir=await fs.lstat(directory);
    if(!dir.isDirectory()||dir.isSymbolicLink())throw fail('INVALID_DIRECTORY','Material directory is not a regular directory.');
    const file=path.join(directory,digest),entry=await fs.lstat(file);
    if(!entry.isFile()||entry.isSymbolicLink())throw fail('INVALID_MATERIAL','Material is not a regular file.');
    handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const stat=await handle.stat();
    if(!stat.isFile()||identity(entry)!==identity(stat))throw fail('MATERIAL_CORRUPT','Material identity changed.');
    return {handle,stat,stream:()=>handle.createReadStream({start:0,autoClose:false}),
     async verify(){const now=await handle.stat();if(identity(now)!==identity(stat)||identity(await fs.lstat(file))!==identity(stat))throw fail('MATERIAL_CORRUPT','Material identity changed.');return now.ctimeMs!==stat.ctimeMs;},
     close:()=>handle.close()};
   }catch(error){await handle?.close();throw error;}
  },
  async createStage(){
   platformPersistence.requireSupported();
   const temporary=path.join(directory,'.pending-'+randomUUID());let handle=await fs.open(temporary,'wx',0o600),pending=true;
   const releaseFile=async()=>{await handle?.close();handle=null;if(pending){await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});pending=false;}};
   return {facts:Object.freeze({temporary}),write:chunk=>handle.writeFile(chunk),sync:()=>platformPersistence.syncFileHandle(handle),
    async publish(digest){await handle.close();handle=null;try{await fs.link(temporary,path.join(directory,digest));return true;}catch(error){if(error.code!=='EEXIST')throw error;return false;}},
    releaseFile,
    async syncDirectory(){await platformPersistence.syncDirectory(directory);},
    close:releaseFile};
  },
 });
}
