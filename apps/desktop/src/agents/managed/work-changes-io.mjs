import fs from 'node:fs/promises';
import path from 'node:path';
import {platformPersistence} from '../../platform/shared/persistence.mjs';
import {createExperimentalWorkChangesIO} from '../../platform/windows/experimental-work-changes.mjs';

export function createWorkChangesIO({experimentalWindowsRoot}={}){
 if(experimentalWindowsRoot!==undefined)return createExperimentalWorkChangesIO(experimentalWindowsRoot);
 return Object.freeze({
  ensureDirectory:directory=>fs.mkdir(directory,{recursive:true,mode:0o700}),
  async readJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}},
  async writeJson(file,value){platformPersistence.requireSupported();await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await platformPersistence.writeAtomic(file,JSON.stringify(value));},
  async openRemoval(file,{optional=false}={}){
   let bytes;try{bytes=await fs.readFile(file);}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
   return {bytes,async remove(){if(!(await fs.readFile(file)).equals(bytes))throw Object.assign(Error('Evidence changed during cleanup; retained'),{code:'CHANGES_RECOVERY_HELD'});await fs.unlink(file);},close(){}};
  },
 });
}
