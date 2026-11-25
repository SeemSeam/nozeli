// Observation only: retain exact source leases through the recovery receipt CAS.
// Namespace effects and cleanup never belong to a recovery acknowledgement.
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {openExperimentalSourceTree} from './experimental-private-tree.mjs';
const require=createRequire(import.meta.url);
const fail=(message)=>Object.assign(Error(message),{code:'TREE_RECOVERY_CHANGED'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=value=>typeof value==='string'&&/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export function openWindowsTreeRecoveryObservation(host,project,relative){
 const bridge=require('../../../native/windows/build/Release/nozeli_windows_read.node');
 const parent=bridge.openAnchoredSourceDirectory(project.root,relative),leases=[];
 let closed=false;
 const close=()=>{if(closed)return;closed=true;const errors=[];for(const held of leases.reverse()){try{held.tree?.close();}catch(error){errors.push(error);}try{held.entry.close();}catch(error){errors.push(error);}}try{parent.close();}catch(error){errors.push(error);}if(errors.length)throw Object.assign(errors[0],{cleanupErrors:errors});};
 const checkScope=()=>{host.storage.assertActive(project.id);host.storage.nativeRootForPath(path.join(project.root,relative));parent.verify();};
 const observe=(name,retain=false)=>{
  let entry,directory=false;
  try{entry=parent.openFile(name);}catch(error){if([2,3].includes(error.win32Code))return null;if(![5,267].includes(error.win32Code))throw error;entry=parent.openDirectory(name);directory=true;}
  try{const value={entry,directory,identity:directory?entry.identity():entry.stat().identity,tree:null};if(retain)leases.push(value);else entry.close();return value;}catch(error){entry.close();throw error;}
 };
 const capture=async(name,held)=>{
  const absolute=path.join(project.root,path.posix.dirname(relative),name);
  let contentDigest,byteLength;
  if(held.directory){held.tree=await openExperimentalSourceTree(project.root,absolute,{sourceLease:held.entry,expectedIdentity:held.identity,maxEntries:1024,maxBytes:512*1024*1024});contentDigest=held.tree.manifest.sha256;byteLength=held.tree.manifest.totalBytes;}
  else{
   const size=held.entry.stat().size;if(size<0n||size>512n*1024n*1024n)throw fail('文件超过本次核对上限，原资料保留。');
   byteLength=Number(size);const sum=createHash('sha256');
   for(let offset=0;offset<byteLength;){const bytes=held.entry.readAt(offset,Math.min(1024*1024,byteLength-offset));if(!bytes.length)throw fail('核对期间文件长度已变化。');sum.update(bytes);offset+=bytes.length;await new Promise(resolve=>setImmediate(resolve));}
   if(held.entry.readAt(byteLength,1).length)throw fail('核对期间文件长度已变化。');contentDigest=sum.digest('hex');
  }
  held.entry.verify();return {identity:held.identity,directory:held.directory,digest:contentDigest,byteLength};
 };
 return {observe,capture,verify:checkScope,verifyLeases:async()=>{checkScope();for(const held of leases){await held.tree?.verify();held.entry.verify();}},close};
}

export async function inspectWindowsCopyRecovery(host,project,record){
 if(process.platform!=='win32'||process.arch!=='x64')throw Object.assign(Error('此平台尚未支持复制恢复核对，原记录保留。'),{code:'TREE_RECOVERY_UNSUPPORTED'});
 const observation=openWindowsTreeRecoveryObservation(host,project,record.destination),{observe,capture,close}=observation;
 const checkScope=observation.verify;
 const destinationName=record.destination.split('/').at(-1),stageName='.nozeli-tree-'+record.operationId+'.pending',effect=record.effect;
 try{
  checkScope();
  if(effect!=null&&(effect.schema!==1||effect.action!=='copy'||effect.destination!==record.destination||effect.operationId!==record.operationId||effect.projectId!==project.id||effect.sourceProjectId!==null||effect.sourceIdentity!==record.sourceIdentity||effect.source!==path.basename(record.source)||!['file','directory'].includes(effect.kind)||effect.identity!==null&&!id(effect.identity)||effect.stagingName!==null&&effect.stagingName!==stageName||typeof effect.published!=='boolean'))throw fail('复制现场描述无法完整核验，请保留并导出记录。');
  if(['published','complete'].includes(record.phase)&&effect?.published!==true)throw fail('已发布记录缺少完整发布事实，未结算。');
  const destination=observe(destinationName,true),stage=observe(stageName,true);
  let decision,publicFile=null,retainedStage=null;
  if(destination&&id(effect?.identity)&&destination.identity===effect.identity){
   if(stage)throw fail('正式位置与暂存位置同时存在，需继续核查。');
   publicFile=await capture(destinationName,destination);
   const expected=effect.kind==='directory'?effect.stageManifest?.sha256:effect.digest;
   if(publicFile.directory!==(effect.kind==='directory')||!digest(expected)||publicFile.digest!==expected||publicFile.byteLength!==effect.byteLength)throw fail('复制结果的内容、类型或身份已变化，未结算。');
   decision='keep-published-copy';
  }else{
   if(effect?.published===true||record.phase==='complete')throw fail('无法找到原已发布副本，未将其当作未执行。');
   if(stage){
    if(!id(effect?.identity)||stage.identity!==effect.identity||stage.directory!==(effect.kind==='directory'))throw fail('暂存数据身份不明，未结算或清理。');
    retainedStage=await capture(stageName,stage);
   }
   // A foreign destination is retained as a winner, never attributed to this copy.
   if(destination)await capture(destinationName,destination);
   decision='retain-aborted-copy';
  }
  const proof={schema:1,decision,destinationIdentity:destination?.identity??null,destinationOwned:decision==='keep-published-copy',destinationDigest:publicFile?.digest??null,stageIdentity:retainedStage?.identity??null,stageDigest:retainedStage?.digest??null,stageRetained:Boolean(retainedStage),namespaceChanged:false};
  const verify=async()=>{checkScope();await observation.verifyLeases();const current=observe(destinationName),pending=observe(stageName);if(current?.identity!==destination?.identity||pending?.identity!==stage?.identity)throw fail('核对期间正式位置或暂存位置已变化。');};
  await verify();return {proof,proofDigest:hash(JSON.stringify(proof)),verify,close};
 }catch(error){try{close();}catch(cleanup){error.cleanupErrors=cleanup.cleanupErrors??[cleanup];}throw error;}
}
