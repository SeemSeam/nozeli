import {open,rename,unlink} from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {syncDirectory} from '../linux/persistence.mjs';

export function createPersistenceAdapter({platform=process.platform,directorySync=syncDirectory}={}){
 const supported=platform==='linux';
 const requireSupported=()=>{if(!supported)throw Object.assign(new Error('Durable atomic replacement requires a verified platform persistence adapter'),{code:'PERSISTENCE_UNSUPPORTED',platform,capability:'durableAtomicReplace'});};
 return Object.freeze({
  schema:1,platform,capabilities:Object.freeze({durableAtomicReplace:supported,directorySync:supported}),
  requireSupported,
  async syncDirectory(directory){requireSupported();await directorySync(directory);return {schema:1,platform,state:'durable'};},
  async writeAtomic(file,bytes){
   // Reject before creating or replacing anything on an unverified platform.
   requireSupported();
   const temporary=join(dirname(file),`.${basename(file)}.${randomUUID()}.tmp`);
   let handle,published=false;
   try{
    handle=await open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=undefined;
    await rename(temporary,file);published=true;
    await directorySync(dirname(file));
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
