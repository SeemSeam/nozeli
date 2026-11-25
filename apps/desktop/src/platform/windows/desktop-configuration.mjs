// Windows file effects for the shared independent-configuration journal.
// A persistent native gate is locked by its original exclusive HANDLE, not a
// PID record. Process exit releases the gate; unknown legacy locks stay intact.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWindowsDesktopProfileIO} from './desktop-profile.mjs';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';
import {experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';

const fail=(code,message)=>Object.assign(Error(message),{code});
const missing=error=>error.code==='WIN32_IO_ERROR'&&[2,3].includes(error.win32Code);
const occupied=error=>error.code==='FS_TARGET_EXISTS'||error.code==='WIN32_IO_ERROR'&&[5,32,80,183].includes(error.win32Code);
const gateBytes=Buffer.from('{"schema":1,"kind":"nozeli-configuration-gate"}\n');

export function createWindowsConfigurationIO(paths){
 const records=createWindowsDesktopProfileIO(paths.root),versions=new Map(),stages=new Map();
 const relative=file=>experimentalPrivateDirectoryComponents(paths.root,file).join('/');
 const stage=(directory,expected)=>{
  if(typeof expected!=='string'||!/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(expected))throw fail('CONFIG_RECOVERY_REQUIRED','Configuration stage has no original directory identity');
  let entry=stages.get(directory);if(entry)return entry;
  const parent=openExperimentalPersistenceParent(paths.root,relative(directory));let lease;
  try{lease=parent.openPrivateDeleteDirectory(path.basename(directory));lease.verify();if(lease.identity()!==expected)throw fail('CONFIG_IMPORT_CONFLICT','Configuration stage directory was replaced; original journal retained');entry={parent,lease};stages.set(directory,entry);return entry;}
  catch(error){try{lease?.close();}finally{parent.close();}throw error;}
 };
 return Object.freeze({
  ensureDirectory:directory=>records.ensureDirectory(directory),
  async readJson(file){const record=await records.read(file,{maxBytes:65536});versions.set(file,record.sha256);return record.bytes===null?null:JSON.parse(record.bytes.toString('utf8'));},
  async write(file,bytes){if(!versions.has(file))throw fail('CONFIG_REVISION_REQUIRED','Configuration write requires its observed journal revision');const result=await records.write(file,bytes,{expectedSha256:versions.get(file)});versions.set(file,result.sha256);return result;},
  stageEntries(directory,expected){const {lease}=stage(directory,expected);const rows=lease.entries(128);lease.verify();return rows.map(row=>row.name);},
  removeStage(directory,expected){const entry=stage(directory,expected);entry.lease.verify();entry.lease.removePrivateEmptyDirectory();entry.parent.syncDirectory();entry.lease.close();entry.parent.close();stages.delete(directory);},
  close(){const errors=[];for(const entry of stages.values())for(const lease of [entry.lease,entry.parent])try{lease.close();}catch(error){errors.push(error);}stages.clear();if(errors.length)throw errors[0];},
 });
}

export async function withWindowsConfigurationLock(paths,fn){
 const io=createWindowsConfigurationIO(paths);await io.ensureDirectory(paths.migrations);
 const parent=openExperimentalPersistenceParent(paths.root,relativeGate(paths)),name='configuration-native.lock';let gate,pending;
 try{
  if(parent.inspectEntry('configuration.lock'))throw fail('CONFIG_RECOVERY_REQUIRED','Legacy configuration lock retained; explicit recovery is required');
  try{gate=parent.openPrivateLockFile(name);}catch(error){if(!missing(error))throw error;}
  if(!gate){
   pending=parent.createPrivateExclusive('.configuration-gate-'+randomUUID());pending.write(gateBytes);pending.sync();
   try{pending.publishNew(name);}catch(error){if(!occupied(error))throw error;}
   pending.close();pending=null;parent.syncDirectory();gate=parent.openPrivateLockFile(name);
  }
  if(gate.stat().size!==BigInt(gateBytes.length)||!gate.readAt(0,gateBytes.length).equals(gateBytes))throw fail('CONFIG_RECOVERY_REQUIRED','Unrecognized native configuration gate retained');
  gate.verify();const result=await fn(io);gate.verify();return result;
 }catch(error){if(!gate&&occupied(error))throw Object.assign(fail('CONFIG_BUSY','Another native configuration operation is active, or its gate is unavailable'),{cause:error});throw error;}
 finally{try{io.close();}finally{try{gate?.close();}finally{try{pending?.close();}finally{parent.close();}}}}
}
function relativeGate(paths){return experimentalPrivateDirectoryComponents(paths.root,path.join(paths.migrations,'configuration-native.lock')).join('/');}
