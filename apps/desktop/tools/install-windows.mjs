import fs from 'node:fs/promises';
import path from 'node:path';
import {realUserHome} from '../src/agents/managed/omp-system-source.mjs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {absolute,exists,json,reject,sha256,writeRecord,windowsLauncher} from './windows-install-core.mjs';
import {validateWindowsCandidate} from './package-windows-candidate.mjs';
import {openExperimentalPersistenceParent} from '../src/platform/windows/experimental-persistence.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {authorizeWindowsUpdateRecovery,readWindowsInstallationRecords,windowsUpdaterCapability} from '../src/main/auto-update-windows-helper.mjs';
export {windowsLauncher};

const OWNER='WINDOWS-INSTALL.json',STATE='ACTIVE.json',PROFILE='WINDOWS-PROFILE.json';
const related=(a,b)=>{const rel=path.relative(a,b);return rel===''||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
function launchFailure(cause,notStarted){const error=reject(notStarted?'INSTALL_LAUNCH_NOT_STARTED':'INSTALL_LAUNCH_UNKNOWN',notStarted?'Windows did not start the application; the previous version and profile are retained':'Application launch outcome requires reconciliation');error.launchEffect=notStarted?'not-started':'unknown';if(typeof cause.code==='string'&&/^[A-Z0-9_]+$/.test(cause.code))error.spawnCode=cause.code;return error;}
const lockHeld=error=>error.code==='FS_TARGET_EXISTS'||error.code==='WIN32_IO_ERROR'&&[5,32,80,183].includes(error.win32Code);
function platform(){if(process.platform!=='win32'||process.arch!=='x64')throw reject('INSTALL_PLATFORM','Native Windows x64 required');}
function safeRoot(root){absolute(root);const home=realUserHome(),daily=path.join(home,'.Nozeli');if(related(root,daily)||related(daily,root)||related(root,home))throw reject('INSTALL_PATH_REJECTED','Dedicated non-daily installation root required');return root;}
async function owned(root){
 // Delegates to the shared updater records reader: identical ownership,
 // profile and known-launcher-digest checks. ACTIVE is read separately
 // under the existing installer lock before any activation effect.
 const records=await readWindowsInstallationRecords(root,{ownershipOnly:true});
 return records.owner;
}
async function state(root,owner){
 const records=await readWindowsInstallationRecords(root);
 if(records.installationId!==owner.installationId)throw reject('INSTALL_NOT_OWNED','Installation owner changed');
 return records.state??{value:null,digest:null};
}
async function lock(root,action){
 const acquire=()=>{const parent=openExperimentalPersistenceParent(root,'.install-lock');try{return {parent,held:parent.createPrivateTreeRootExclusive('.install-lock')};}catch(error){parent.close();throw error;}};
 let parent,held,success=false;
 try{
  try{({parent,held}=acquire());}
  catch(error){
   if(!lockHeld(error))throw error;
   // An exclusive lock that still carries an own update attempt is freed
   // only through launcher-side recovery authorization: every dead-attempt
   // proof is held, the journal is advanced by an exact digest CAS to
   // recoveryAuthorized while the kernel exclusion is still held, and only
   // then is the stale lock released for this launcher's own lock. Launcher
   // and foreign locks are never stolen or deleted here.
   const reconciled=await authorizeWindowsUpdateRecovery({root});
   if(reconciled?.state!=='authorized'){
    if(reconciled?.live)throw reject('INSTALL_UPDATE_ACTIVE','An automatic update is completing; retry shortly');
    throw error;
   }
   ({parent,held}=acquire());
  }
  try{const result=await action(held.identity());success=true;return result;}catch(error){error.installationRoot=root;success=error.code==='INSTALL_LAUNCH_NOT_STARTED'&&error.launchEffect==='not-started';error.reconciliationRequired=!success;throw error;}
 }
 finally{try{if(held&&success)held.removePrivateEmptyDirectory();}finally{try{held?.close();}finally{parent?.close();}}}
}
async function initialize(root,updater='unsupported'){
 safeRoot(root);if(await exists(root))throw reject('INSTALL_NOT_EMPTY','First install requires a nonexistent dedicated root; never adopts existing directories');
 const parent=openExperimentalPersistenceParent(path.dirname(root),path.basename(root));let directory;
 try{directory=parent.createPrivateTreeRootExclusive(path.basename(root));directory.syncDirectory();parent.syncDirectory();}finally{directory?.close();parent.close();}
 const installationId=randomUUID();await ensureExperimentalPrivateDirectory(root,path.join(root,'versions'));await ensureExperimentalPrivateDirectory(root,path.join(root,'profile'));
 await writeRecord(root,'profile/'+PROFILE,{schema:1,application:'Nozeli',kind:'windows-isolated-profile',installationId,installRoot:root});
 const launcher=openExperimentalPersistenceParent(root,'Launch-Nozeli.ps1');let stage;try{stage=launcher.createPrivateExclusive('.launcher');stage.write(Buffer.from(windowsLauncher));stage.sync();stage.publishNew('Launch-Nozeli.ps1');launcher.syncDirectory();}finally{stage?.close();launcher.close();}
 await writeRecord(root,OWNER,{schema:1,application:'Nozeli',kind:'windows-isolated-install',installationId,root,profile:path.join(root,'profile'),launcherSha256:sha256(windowsLauncher),automaticUpdater:updater});
}
async function version(root,id,expected){if(!/^[a-f0-9-]{36}$/.test(id??''))throw reject('INSTALL_STATE_REJECTED','Invalid version identifier');const checked=await validateWindowsCandidate(path.join(root,'versions',id));if(expected!==undefined&&checked.digest!==expected){checked.tree.close();throw reject('CANDIDATE_TAMPERED','Installed manifest differs from installation state');}return checked;}
export async function windowsInstall({root,command,candidate,version:target,args=[]}){
 platform();safeRoot(root);
 if(!['install','upgrade','rollback','status','list','launch'].includes(command))throw reject('INSTALL_COMMAND','Unknown command; use install/upgrade/rollback/status/list/launch');
 if(['install','upgrade'].includes(command)){absolute(candidate);if(related(root,candidate)||related(candidate,root))throw reject('INSTALL_PATH_REJECTED','Candidate and dedicated installation must be disjoint');}
 if(command==='install'){
  const checked=await validateWindowsCandidate(absolute(candidate));const updater=checked.manifest.automaticUpdater;checked.tree.close();await initialize(root,updater);
 }
 const owner=await owned(root);
 const action=async lockIdentity=>{
  const before=await state(root,owner);
  if(command==='status'||command==='list'){
   const versions=[];for(const id of (await fs.readdir(path.join(root,'versions'))).sort()){
    try{const expected=before.value?.versions?.[id];const checked=await version(root,id,expected);versions.push({id,version:checked.manifest.version,digest:checked.digest,automaticUpdater:checked.manifest.automaticUpdater,state:expected?'verified':'prepared-unactivated-retained'});checked.tree.close();}catch(error){versions.push({id,state:'unknown-retained',code:error.code??'INVALID'});}
   }
   const after=await state(root,owner);let active=null;
   if(before.value){try{active=await version(root,before.value.active,before.value.versions[before.value.active]);}catch{}}
   const result={root,profile:owner.profile,automaticUpdater:active?active.manifest.automaticUpdater:(owner.automaticUpdater??'unsupported'),updater:active?windowsUpdaterCapability(active.manifest):false,state:before.value,versions,installerLock:await exists(path.join(root,'.install-lock')),concurrentStateChange:before.digest!==after.digest};
   active?.tree.close();return result;
  }
  if(command==='install'||command==='upgrade'){
   if(command==='install'&&before.value||command==='upgrade'&&!before.value)throw reject('INSTALL_STATE_REJECTED','Install/upgrade does not match current state');
   const input=await validateWindowsCandidate(absolute(candidate));const id=randomUUID();
   try{
    await input.tree.copyTo(root,'versions/'+id);
    const copied=await version(root,id);try{if(copied.digest!==input.digest)throw reject('INSTALL_CHANGED','Prepared copy differs from candidate');await input.tree.verify();}finally{copied.tree.close();}
    await writeRecord(root,STATE,{schema:1,installationId:owner.installationId,generation:(before.value?.generation??0)+1,active:id,previous:before.value?.active??null,versions:{...before.value?.versions,[id]:input.digest}},before.digest);
    return {root,active:id,previous:before.value?.active??null,profile:owner.profile,automaticUpdater:input.manifest.automaticUpdater,updater:windowsUpdaterCapability(input.manifest),durability:'namespace-not-qualified'};
   }finally{input.tree.close();}
  }
  if(command==='rollback'){
   const id=target??before.value?.previous;if(!before.value||!id||id===before.value.active||!before.value.versions?.[id])throw reject('INSTALL_STATE_REJECTED','No different previously activated rollback version selected');
   const checked=await version(root,id,before.value.versions[id]);try{await checked.tree.verify();await writeRecord(root,STATE,{...before.value,generation:before.value.generation+1,active:id,previous:before.value.active},before.digest);}finally{checked.tree.close();}
   return {active:id,previous:before.value.active,profile:owner.profile,durability:'namespace-not-qualified'};
  }
  if(command==='launch'){
   if(!before.value)throw reject('INSTALL_STATE_REJECTED','No active version');
   const checked=await version(root,before.value.active,before.value.versions[before.value.active]);
   try{
    const env={...process.env,NOZELI_WINDOWS_INSTALL_PROFILE:owner.profile};for(const key of Object.keys(env))if(key.startsWith('NOZELI_TEST_')&&!key.startsWith('NOZELI_TEST_UPDATE_')&&!['NOZELI_TEST_PICK','NOZELI_SHOT_DIR'].includes(key)||['ELECTRON_RUN_AS_NODE','NOZELI_CONFIG_ROOT','NOZELI_USER_DATA'].includes(key))delete env[key];
    env.NOZELI_WINDOWS_LAUNCH_LOCK=lockIdentity;
    let child;try{child=spawn(path.join(root,'versions',before.value.active,'Nozeli.exe'),args,{env,cwd:root,stdio:'ignore',detached:false,shell:false,windowsHide:false});}catch(cause){throw launchFailure(cause,true);}
    const completion=new Promise((resolve,deny)=>{
     let admitted=false;child.once('spawn',()=>{admitted=true;});
     child.once('error',cause=>deny(launchFailure(cause,!admitted&&child.pid===undefined)));
     child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));
    });
    // Keep original payload HANDLEs and the installation lock until the actual
    // app exits. A successful spawn alone cannot release runtime custody.
    const exit=await completion;return {pid:child.pid,active:before.value.active,profile:owner.profile,...exit};
   }finally{checked.tree.close();}
  }
  throw reject('INSTALL_COMMAND','Supported commands: install, upgrade, rollback, status, list, launch.');
 };
 const guarded=async lockIdentity=>{
  const pins=[];
  try{
   const anchor=openExperimentalPersistenceParent(root,'__installation_identity__');pins.push(anchor);
   for(const name of [OWNER,'Launch-Nozeli.ps1'])pins.push(anchor.openPrivateObjectRead(name));
   const profile=anchor.openPrivateDirectory('profile',false);pins.push(profile);pins.push(profile.openPrivateObjectRead(PROFILE));pins.push(anchor.openPrivateDirectory('versions',false));
   const currentOwner=await owned(root);if(JSON.stringify(currentOwner)!==JSON.stringify(owner))throw reject('INSTALL_NOT_OWNED','Installation owner changed before lock');
   return await action(lockIdentity);
  }finally{for(const pin of pins.reverse())pin.close();}
 };
 return ['status','list'].includes(command)?guarded():lock(root,guarded);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const [command,...raw]=process.argv.slice(2),boundary=raw.indexOf('--'),launchArgs=boundary<0?[]:raw.slice(boundary+1),args=boundary<0?raw:raw.slice(0,boundary),options={};for(let i=0;i<args.length;i+=2){if(!['--root','--candidate','--version'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('usage: install-windows.mjs (install|upgrade|rollback|status|list|launch) --root ABS [--candidate ABS] [--version UUID] [-- launch arguments]');options[args[i]]=args[i+1];}
 const result=await windowsInstall({command,root:options['--root'],candidate:options['--candidate'],version:options['--version'],args:launchArgs});
 console.log(json(result));
 if(command==='launch')process.exitCode=result.exitCode??1;
}
