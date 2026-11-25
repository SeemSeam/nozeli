import path from 'node:path';
import {createHash} from 'node:crypto';
import {experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';
import {ensureWindowsDesktopProfileDirectory} from './desktop-profile-directory.mjs';
import {createExperimentalWindowsPersistence,openExperimentalPersistenceParent} from './experimental-persistence.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
// Selected only for desktop-owned records below the resolved Electron profile.
// Existing directories/files must already satisfy the native private ACL rules;
// permission drift is rejected, never repaired by a preference write.
export function createWindowsDesktopProfileIO(root){
 if(process.platform!=='win32'||process.arch!=='x64')throw Object.assign(Error('Native Windows x64 profile IO required'),{code:'FS_PLATFORM_UNSUPPORTED'});
 const relative=file=>experimentalPrivateDirectoryComponents(root,file).join('/');
 const persistence=createExperimentalWindowsPersistence(root);
 return Object.freeze({
  qualification:Object.freeze({platform:'win32',scope:'desktop-profile-records',durability:'namespace-not-qualified'}),
  ensureDirectory(directory){relative(directory);return ensureWindowsDesktopProfileDirectory(root,directory);},
  async read(file,{maxBytes=16*1024*1024}={}){
   if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024)throw new TypeError('Invalid profile record limit');
   const name=relative(file);let parent,lease;
   try{
    parent=openExperimentalPersistenceParent(root,name);lease=parent.openPrivateObjectRead(path.basename(file));
    const stat=lease.stat();if(stat.size>BigInt(maxBytes))throw Object.assign(Error('Desktop profile record exceeds limit'),{code:'PROFILE_RECORD_UNSAFE'});
    const chunks=[];let used=0;
    while(used<Number(stat.size)){const bytes=lease.readAt(used,Math.min(256*1024,Number(stat.size)-used));if(!bytes.length)throw Object.assign(Error('Desktop profile record truncated'),{code:'PROFILE_RECORD_CHANGED'});chunks.push(bytes);used+=bytes.length;}
    lease.verify();parent.verify();const bytes=Buffer.concat(chunks,used);return {bytes,sha256:digest(bytes)};
   }catch(error){if(error.code==='WIN32_IO_ERROR'&&[2,3].includes(error.win32Code))return {bytes:null,sha256:null};throw error;}
   finally{lease?.close();parent?.close();}
  },
  async write(file,bytes,{expectedSha256}={}){
   if(expectedSha256===undefined)throw Object.assign(Error('Observed profile revision is required'),{code:'PROFILE_REVISION_REQUIRED'});
   if(!(bytes instanceof Uint8Array)||bytes.length>16*1024*1024)throw Object.assign(Error('Invalid desktop profile bytes'),{code:'PROFILE_RECORD_UNSAFE'});
   const sha256=digest(bytes),receipt=await persistence.writeStream(relative(file),[bytes],{expectedSha256,expectedNewSha256:sha256});
   return {...receipt,sha256};
  },
 });
}
