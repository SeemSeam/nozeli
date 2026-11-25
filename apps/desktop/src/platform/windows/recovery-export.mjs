// Only a trusted native Save dialog supplies the destination. No renderer path
// authority, automatic retry, overwrite or path-based temporary cleanup.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
export function createWindowsRecoveryExportIO({directorySync=parent=>parent.syncDirectory()}={}){
  let bridge;
  return {
    requireSupported(){
      if(process.platform!=='win32'||process.arch!=='x64')throw Object.assign(Error('Windows x64 recovery export is unavailable'),{code:'RECOVERY_EXPORT_UNSUPPORTED'});
      bridge??=require('../../../native/windows/build/Release/nozeli_windows_read.node');
    },
    async open(target){
      this.requireSupported();
      const name=path.basename(target),parent=bridge.openAnchoredPublicMutationParent(path.dirname(target),name);
      let stage,published=false,primaryError;
      try{stage=parent.createPrivateExclusive('.nozeli-recovery-'+randomUUID()+'.pending');}
      catch(error){parent.close();throw error;}
      const retain=error=>{primaryError=error;if(error.code==='FS_TARGET_EXISTS')error.code='EEXIST';if(published||error.committed){error.committed=true;error.durability='uncertain';}return error;};
      return {
        async write(bytes){try{parent.verify();stage.write(bytes);}catch(error){throw retain(error);}},
        async sync(){try{parent.verify();stage.sync();}catch(error){throw retain(error);}},
        async publish({validate=()=>{}}={}){try{parent.verify();validate();stage.publishNew(name);published=true;await directorySync(parent);parent.verify();if(stage.verify()===false)throw Object.assign(Error('Export identity changed'),{code:'RECOVERY_EXPORT_CHANGED'});return {durability:'namespace-not-qualified'};}catch(error){throw retain(error);}},
        async close(){
          const errors=[];for(const resource of [stage,parent])try{resource.close();}catch(error){errors.push(error);}
          if(errors.length){if(primaryError)primaryError.cleanupErrors=errors;else throw retain(errors[0]);}
        },
      };
    },
  };
}
