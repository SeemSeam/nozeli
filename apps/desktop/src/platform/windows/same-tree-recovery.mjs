import {createHash} from 'node:crypto';
import {inspectWindowsCrossRecovery} from './cross-tree-recovery.mjs';
import {openWindowsTreeRecoveryObservation} from './tree-recovery.mjs';
const changed=()=>Object.assign(Error('原文件操作的身份、内容或位置已变化，恢复资料保留。'),{code:'TREE_RECOVERY_CHANGED'});
const identity=value=>typeof value==='string'&&/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(value);
export async function inspectWindowsSameRecovery(host,project,record){
 if(record.transfer===true){
  // Rename and cut have the same no-replace native move contract. Preserve
  // original receipts; normalize only the read-only observation parameters.
  const action=record.action==='rename'?'cut':record.action;
  return inspectWindowsCrossRecovery(host,project,project,{...record,action,effect:record.effect?{...record.effect,action}:record.effect});
 }
 if(process.platform!=='win32'||process.arch!=='x64')throw Object.assign(Error('此平台尚未支持新建文件恢复核对。'),{code:'TREE_RECOVERY_UNSUPPORTED'});
 const observation=openWindowsTreeRecoveryObservation(host,project,record.destination),stageName='.nozeli-tree-'+record.operationId+'.pending';
 try{
  const effect=record.effect,kind=record.action==='createFolder'?'directory':'file';
  if(effect!=null&&(effect.schema!==1||effect.kind!==kind||effect.relative!==record.destination||effect.operationId!==record.operationId||effect.identity!==null&&!identity(effect.identity)||typeof effect.published!=='boolean'||effect.stagingName!==undefined&&effect.stagingName!==stageName))throw changed();
  const name=record.destination.split('/').at(-1),destination=observation.observe(name,true),stage=kind==='file'?observation.observe(stageName,true):null;
  const owned=Boolean(destination&&identity(effect?.identity)&&destination.identity===effect.identity);
  let captured=null,pending=null;
  if(owned){
   if(stage||destination.directory!==(kind==='directory'))throw changed();
   captured=await observation.capture(name,destination);
   // A creation starts empty. Subsequent contents are user work, not proof of
   // this operation's completion; leave them and the unresolved record intact.
   if(captured.byteLength!==0||destination.directory&&destination.tree.manifest.entries.some(row=>row.relative!==''))throw changed();
  }else{
   if(effect?.published===true)throw changed();
   if(destination&&!identity(effect?.identity))throw changed();
   if(stage){if(stage.directory||!identity(effect?.identity)||stage.identity!==effect.identity)throw changed();pending=await observation.capture(stageName,stage);}
  }
  const proof={schema:1,decision:owned?'keep-published-creation':'retain-aborted-creation',destinationIdentity:destination?.identity??null,destinationOwned:owned,destinationDigest:captured?.digest??null,stageIdentity:pending?.identity??null,stageDigest:pending?.digest??null,stageRetained:Boolean(pending),namespaceChanged:false};
  const verify=async()=>{await observation.verifyLeases();if(observation.observe(name)?.identity!==destination?.identity||(kind==='file'&&observation.observe(stageName)?.identity!==stage?.identity))throw changed();};
  await verify();return {proof,proofDigest:createHash('sha256').update(JSON.stringify(proof)).digest('hex'),verify,close:()=>observation.close()};
 }catch(error){try{observation.close();}catch(cleanup){error.cleanupErrors=cleanup.cleanupErrors??[cleanup];}throw error;}
}
