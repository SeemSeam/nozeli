import {createHash} from 'node:crypto';
import {openWindowsTreeRecoveryObservation} from './tree-recovery.mjs';
const changed=message=>Object.assign(Error(message??'跨项目文件现场已变化，请重新核对。'),{code:'TREE_RECOVERY_CHANGED'});
const id=value=>typeof value==='string'&&/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Read-only observations share the same native leases as external-copy recovery.
// No source/target/stage namespace operation belongs to receipt acknowledgement.
export async function inspectWindowsCrossRecovery(host,sourceProject,project,record){
 if(process.platform!=='win32'||process.arch!=='x64')throw Object.assign(Error('此平台尚未支持跨项目恢复核对。'),{code:'TREE_RECOVERY_UNSUPPORTED'});
 const observations=[];
 const close=()=>{const errors=[];for(const observation of observations.reverse())try{observation.close();}catch(error){errors.push(error);}if(errors.length)throw Object.assign(errors[0],{cleanupErrors:errors});};
 try{
  const target=openWindowsTreeRecoveryObservation(host,project,record.destination);observations.push(target);
  const effect=record.effect,stageName='.nozeli-tree-'+record.operationId+'.pending';
  if(effect!=null&&(effect.schema!==1||effect.action!==record.action||effect.source!==record.source||effect.destination!==record.destination||effect.operationId!==record.operationId||effect.projectId!==project.id||effect.sourceProjectId!==sourceProject.id||!['file','directory'].includes(effect.kind)||effect.identity!==null&&!id(effect.identity)||effect.sourceIdentity!==null&&!id(effect.sourceIdentity)||typeof effect.published!=='boolean'||effect.stagingName!==null&&effect.stagingName!==stageName))throw changed('跨项目文件效果记录无法完整核验，未结算。');
  const destination=target.observe(record.destination.split('/').at(-1),true),stage=record.action==='copy'?target.observe(stageName,true):null;
  let original=null,source,decision,publishedFile=null,retainedStage=null,originalFile=null;
  if(record.action==='cut'){
   source=openWindowsTreeRecoveryObservation(host,sourceProject,record.source);observations.push(source);
   original=source.observe(record.source.split('/').at(-1),true);
   if(effect&&effect.identity!==effect.sourceIdentity)throw changed();
  }
  const owned=destination&&id(effect?.identity)&&destination.identity===effect.identity;
  const verifyOwned=async(observation,name,held,expected)=>{
   const captured=await observation.capture(name,held);
   if(captured.directory!==(effect.kind==='directory')||!digest(expected)||captured.digest!==expected||captured.byteLength!==effect.byteLength)throw changed('原对象的内容、类型或完整目录清单已变化，未结算。');
   return captured;
  };
  if(owned){
   if(stage||original?.identity===effect.identity)throw changed('同一操作出现多个原对象位置，需继续核查。');
   const expected=effect.kind==='directory'?(record.action==='copy'?effect.stageManifest?.sha256:effect.manifest?.sha256):effect.digest;
   publishedFile=await verifyOwned(target,record.destination.split('/').at(-1),destination,expected);
   if(original)await source.capture(record.source.split('/').at(-1),original);
   decision=record.action==='copy'?'keep-published-copy':'keep-published-move';
  }else{
   if(effect?.published===true)throw changed('无法找到原已发布对象，未将其当作未执行。');
   if(record.action==='cut'){
    if(!original||!id(effect?.sourceIdentity)||original.identity!==effect.sourceIdentity)throw changed('原剪切对象的位置无法核验，原记录保留。');
    originalFile=await verifyOwned(source,record.source.split('/').at(-1),original,effect.kind==='directory'?effect.manifest?.sha256:effect.digest);
   }
   if(stage){
    if(!id(effect?.identity)||stage.identity!==effect.identity||stage.directory!==(effect.kind==='directory'))throw changed('暂存对象身份不明，未结算或清理。');
    retainedStage=await target.capture(stageName,stage);
   }
   if(destination)await target.capture(record.destination.split('/').at(-1),destination);
   decision=record.action==='copy'?'retain-aborted-copy':'retain-aborted-move';
  }
  const proof={schema:1,decision,destinationIdentity:destination?.identity??null,destinationOwned:Boolean(owned),destinationDigest:publishedFile?.digest??null,sourceIdentity:original?.identity??null,sourceOwned:originalFile!==null,sourceDigest:originalFile?.digest??null,stageIdentity:retainedStage?.identity??null,stageDigest:retainedStage?.digest??null,stageRetained:Boolean(retainedStage),namespaceChanged:false};
  const verify=async()=>{
   for(const observation of observations)await observation.verifyLeases();
   if(target.observe(record.destination.split('/').at(-1))?.identity!==destination?.identity||(record.action==='copy'&&target.observe(stageName)?.identity!==stage?.identity)||(source&&source.observe(record.source.split('/').at(-1))?.identity!==original?.identity))throw changed();
  };
  await verify();return {proof,proofDigest:hash(proof),verify,close};
 }catch(error){try{close();}catch(cleanup){error.cleanupErrors=cleanup.cleanupErrors??[cleanup];}throw error;}
}
