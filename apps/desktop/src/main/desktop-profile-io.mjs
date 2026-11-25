// Effects for bounded desktop preference/registry records. This is deliberately
// separate from the global persistence capability and from project file IO.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {platformPersistence} from '../platform/shared/persistence.mjs';
import {createWindowsDesktopProfileIO} from '../platform/windows/desktop-profile.mjs';

export const profileDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function createDesktopProfileIO(root){
 root=path.resolve(root);
 if(process.platform==='win32')return createWindowsDesktopProfileIO(root);
 return Object.freeze({
  qualification:platformPersistence.capabilities,
  ensureDirectory:directory=>fs.mkdir(directory,{recursive:true,mode:0o700}),
  async read(file,{maxBytes=16*1024*1024}={}){
   let handle;
   try{
    const before=await fs.lstat(file);if(!before.isFile()||before.isSymbolicLink()||before.size>maxBytes)throw Object.assign(Error('Invalid desktop profile record'),{code:'PROFILE_RECORD_UNSAFE'});
    handle=await fs.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));const stat=await handle.stat();
    if(stat.dev!==before.dev||stat.ino!==before.ino||stat.size>maxBytes)throw Object.assign(Error('Desktop profile record changed'),{code:'PROFILE_RECORD_CHANGED'});
    const chunks=[];let used=0;
    for(;;){const bytes=Buffer.alloc(Math.min(256*1024,maxBytes+1-used));const {bytesRead}=await handle.read(bytes,0,bytes.length,used);if(!bytesRead)break;used+=bytesRead;if(used>maxBytes)throw Object.assign(Error('Desktop profile record exceeds limit'),{code:'PROFILE_RECORD_UNSAFE'});chunks.push(bytes.subarray(0,bytesRead));}
    const value=Buffer.concat(chunks,used);return {bytes:value,sha256:profileDigest(value)};
   }catch(error){if(error.code==='ENOENT')return {bytes:null,sha256:null};throw error;}
   finally{await handle?.close();}
  },
  async write(file,bytes){await platformPersistence.writeAtomic(file,bytes);return {sha256:profileDigest(bytes)};},
 });
}
