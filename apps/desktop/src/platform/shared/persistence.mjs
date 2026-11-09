// Durable persistence contract (durable-persistence capability): atomic
// publish (write → platform file barrier → rename → platform directory
// barrier) with honest failure semantics — an unverified platform refuses
// BEFORE creating or replacing anything, and a failure after publication
// reports committed=true / durability='uncertain' instead of pretending the
// new content is durable.
//
// Platform barrier dispatch:
//  - linux: fsync(2) on the file and directory descriptors is a real storage
//    barrier there (platform/linux/persistence.mjs, unchanged).
//  - darwin: Apple's fsync does not force the drive write cache, so both
//    barriers run fcntl(fd, F_FULLFSYNC) through the native helper
//    (platform/darwin/persistence.mjs). Without the built helper every
//    operation rejects with PERSISTENCE_HELPER_UNAVAILABLE before any side
//    effect — never a silent plain-fsync downgrade.
//  - anything else: PERSISTENCE_UNSUPPORTED before any side effect.
import {open,rename,unlink} from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {syncDirectory as linuxSyncDirectory} from '../linux/persistence.mjs';
import {syncFileBarrier as darwinFileBarrier,syncDirectory as darwinSyncDirectory,fullSyncAvailability as darwinFullSyncAvailability,requireFullSyncHelper as requireDarwinFullSync} from '../darwin/persistence.mjs';

const PLATFORM_BARRIERS={
 linux:{fileSync:handle=>handle.sync(),directorySync:linuxSyncDirectory,available:()=>true,requireReady(){}},
 darwin:{fileSync:darwinFileBarrier,directorySync:darwinSyncDirectory,available:()=>darwinFullSyncAvailability().available,requireReady:requireDarwinFullSync},
};

export function createPersistenceAdapter({platform=process.platform,directorySync,fileSync}={}){
 const barriers=PLATFORM_BARRIERS[platform];
 const supported=Boolean(barriers);
 const ready=supported&&barriers.available();
 const requireSupported=()=>{
  if(!barriers)throw Object.assign(new Error('Durable atomic replacement requires a verified platform persistence adapter'),{code:'PERSISTENCE_UNSUPPORTED',platform,capability:'durableAtomicReplace'});
  // darwin: refuse before any side effect when the real F_FULLFSYNC barrier is not loadable.
  barriers.requireReady();
 };
 const fileBarrier=fileSync??barriers?.fileSync;
 const directoryBarrier=directorySync??barriers?.directorySync;
 return Object.freeze({
  schema:1,platform,capabilities:Object.freeze({durableAtomicReplace:ready,directorySync:ready}),
  requireSupported,
  // File-data barrier for writers that publish through their own transaction
  // (rename/hardlink moves): the same durability primitive writeAtomic uses,
  // so custom publishers cannot end up on a weaker fsync-class barrier.
  async syncFileHandle(handle){requireSupported();await fileBarrier(handle);},
  async syncDirectory(directory){requireSupported();await directoryBarrier(directory);return {schema:1,platform,state:'durable'};},
  async writeAtomic(file,bytes){
   // Reject before creating or replacing anything on an unverified platform or
   // a macOS host whose native F_FULLFSYNC helper is unavailable.
   requireSupported();
   const temporary=join(dirname(file),`.${basename(file)}.${randomUUID()}.tmp`);
   let handle,published=false;
   try{
    handle=await open(temporary,'wx',0o600);await handle.writeFile(bytes);await fileBarrier(handle);await handle.close();handle=undefined;
    await rename(temporary,file);published=true;
    await directoryBarrier(dirname(file));
    return {schema:1,platform,state:'durable',published:true};
   }catch(error){
    if(published){error.committed=true;error.durability='uncertain';}
    throw error;
   }finally{
    if(handle)await handle.close();
    if(!published)await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
   }
  },
 });
}

export const platformPersistence=createPersistenceAdapter();
