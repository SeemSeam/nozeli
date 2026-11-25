import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {platformPersistence} from '../platform/shared/persistence.mjs';
import {createWindowsRecoveryExportIO} from '../platform/windows/recovery-export.mjs';

const changed=()=>Object.assign(Error('恢复导出目标已变化，原始记录保留。'),{code:'RECOVERY_EXPORT_CHANGED'});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
export function createRecoveryExportIO(){
  if(process.platform==='win32')return createWindowsRecoveryExportIO();
  return {
    requireSupported:()=>platformPersistence.requireSupported(),
    async open(target){
      const directory=path.dirname(target),parent=await fs.lstat(directory);
      if(!parent.isDirectory()||parent.isSymbolicLink()||await fs.realpath(directory)!==directory)throw changed();
      const temporary=path.join(directory,'.nozeli-recovery-'+randomUUID()+'.tmp');
      let output=await fs.open(temporary,'wx',0o600),owned;
      try{owned=await output.stat();}catch(error){await output.close();throw error;}
      return {
        async write(bytes){let offset=0;while(offset<bytes.length){const {bytesWritten}=await output.write(bytes,offset,bytes.length-offset,null);if(!bytesWritten)throw changed();offset+=bytesWritten;}},
        sync:()=>platformPersistence.syncFileHandle(output),
        async publish({validate=()=>{}}={}){
          await output.close();output=null;
          const current=await fs.lstat(directory);
          if(!same(parent,current)||current.isSymbolicLink()||await fs.realpath(directory)!==directory)throw changed();
          validate();await fs.link(temporary,target);
          try{await platformPersistence.syncDirectory(directory);}catch(error){error.committed=true;error.durability='uncertain';throw error;}
          return {};
        },
        async close(){await output?.close();const current=await fs.lstat(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});if(current&&same(owned,current))await fs.unlink(temporary);},
      };
    },
  };
}
