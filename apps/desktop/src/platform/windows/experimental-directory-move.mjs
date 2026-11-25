// Explicit W1 namespace qualification only. The caller must quiesce writers
// and flush tree contents separately; this operation pins directory identities,
// never freezes descendants or grants production durability.
import {experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';

export async function moveExperimentalPrivateDirectory(root,source,destination,{
  expectedIdentity,signal,directorySync=lease=>lease.syncDirectory(),
}={}) {
  const from=experimentalPrivateDirectoryComponents(root,source),to=experimentalPrivateDirectoryComponents(root,destination);
  if(typeof expectedIdentity!=='string'||!/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(expectedIdentity))
    throw Object.assign(Error('Expected canonical source directory identity'),{code:'FS_IDENTITY_REJECTED'});
  if(typeof directorySync!=='function')throw new TypeError('Expected directorySync function');
  const checkAbort=()=>{if(signal?.aborted)throw Object.assign(Error('Directory move aborted before publication'),{code:'ABORT_ERR'});};
  checkAbort();
  let sourceParent,destinationParent,move,published=false,primaryError;
  const fact=()=>({source,destination,identity:expectedIdentity,moved:published});
  const annotate=error=>{
    if(error.committed)published=true;
    error.directoryMove=fact();
    if(published){error.committed=true;error.durability='uncertain';}
    return error;
  };
  try {
    sourceParent=openExperimentalPersistenceParent(root,from.join('/'));
    destinationParent=openExperimentalPersistenceParent(root,to.join('/'));
    move=sourceParent.beginPrivateDirectoryMove(from.at(-1),destinationParent,to.at(-1),expectedIdentity);
    await directorySync(move);checkAbort();move.verify();
    move.commit();published=true;
    // Finish barriers even if cancellation arrives after the namespace effect.
    await directorySync(move);await directorySync(sourceParent);await directorySync(destinationParent);
    move.verify();sourceParent.verify();destinationParent.verify();
    return {schema:1,platform:'win32',state:'barriers-completed',durability:'namespace-not-qualified',
      ...fact(),barriers:{directory:'flushed',sourceParent:'flushed',destinationParent:'flushed'}};
  } catch(cause) {
    primaryError=annotate(cause instanceof Error?cause:Object.assign(Error('Private directory move failed',{cause}),{code:'FS_DIRECTORY_MOVE_FAILED'}));
    throw primaryError;
  } finally {
    const cleanupErrors=[];
    for(const lease of [move,destinationParent,sourceParent])try{lease?.close();}catch(error){cleanupErrors.push(error);}
    if(cleanupErrors.length){if(primaryError)primaryError.cleanupErrors=cleanupErrors;else throw annotate(cleanupErrors[0]);}
  }
}
