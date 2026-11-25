// Explicit W1 qualification entry. Creates private components through retained
// parent HANDLEs; no production persistence capability is granted here.
import path from 'node:path';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';

export function experimentalPrivateDirectoryComponents(root,directory) {
  if (typeof root!=='string'||typeof directory!=='string'||!path.isAbsolute(root)||!path.isAbsolute(directory)||
      root.length>32760||directory.length>32760||path.resolve(root)!==root||path.resolve(directory)!==directory)
    throw Object.assign(Error('Absolute root and private directory required'),{code:'FS_PATH_REJECTED'});
  const relative=path.relative(root,directory);
  if (!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))
    throw Object.assign(Error('Private directory must be below the explicit root'),{code:'FS_PATH_REJECTED'});
  const components=relative.split(path.sep);
  if (components.length>128) throw Object.assign(Error('Private directory chain exceeds 128 components'),{code:'FS_PATH_REJECTED'});
  // Validate the complete plan before creating the first component. Denial
  // comparison never rewrites the actual path used by the native bridge.
  for (const component of components) {
    const comparable=component.normalize('NFKC').toUpperCase().toLowerCase();
    if (!component||component.length>255||component==='.'||component==='..'||/[\x00-\x1f\\/:*?"<>|]/.test(component)||
        /[. ]$/.test(component)||comparable.includes('~')||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)$/.test(comparable.split('.')[0].trim()))
      throw Object.assign(Error('Unqualified private directory component'),{code:'FS_PATH_REJECTED'});
  }
  return components;
}

export async function ensureExperimentalPrivateDirectory(root,directory,{
  signal,directorySync=parent=>parent.syncDirectory(),
}={}) {
  const components=experimentalPrivateDirectoryComponents(root,directory),createdDirectories=[];
  if (typeof directorySync!=='function') throw new TypeError('Expected directorySync function');
  const checkAbort=()=>{if(signal?.aborted)throw Object.assign(Error('Private directory provisioning aborted'),{code:'ABORT_ERR'});};
  checkAbort();
  let cursor=openExperimentalPersistenceParent(root,'__private_directory_anchor__'),child,primaryError;
  try {
    for (let index=0;index<components.length;index++) {
      checkAbort();
      child=cursor.openPrivateDirectory(components[index],true);
      if (child.created) createdDirectories.push({relative:components.slice(0,index+1).join('/'),identity:child.identity()});
      await directorySync(child);await directorySync(cursor);
      child.verify();cursor.verify();
      cursor.close();cursor=child;child=undefined;
    }
    return {schema:1,platform:'win32',state:'barriers-completed',durability:'namespace-not-qualified',
      directory,identity:cursor.identity(),createdDirectories,barriers:{directories:'flushed'}};
  } catch (cause) {
    const error=cause instanceof Error?cause:Object.assign(Error('Private directory provisioning failed',{cause}),{code:'FS_DIRECTORY_FAILED'});
    primaryError=error;
    error.createdDirectories=createdDirectories;
    if (createdDirectories.length||error.committed) {error.committed=true;error.durability='uncertain';}
    throw error;
  } finally {
    const cleanupErrors=[];
    for (const lease of [child,cursor])try{lease?.close();}catch(error){cleanupErrors.push(error);}
    if (cleanupErrors.length) {
      if (primaryError) primaryError.cleanupErrors=cleanupErrors;
      else {const error=cleanupErrors[0];if(createdDirectories.length){error.committed=true;error.durability='uncertain';}throw error;}
    }
  }
}
