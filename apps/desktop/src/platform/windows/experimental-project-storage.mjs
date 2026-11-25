// Scoped qualification only. No production selector or durability grant.
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {experimentalPrivateDirectoryComponents,ensureExperimentalPrivateDirectory} from './experimental-directories.mjs';
import {createExperimentalWindowsPersistence,openExperimentalPersistenceParent} from './experimental-persistence.mjs';
import {openExperimentalPrivateTree} from './experimental-private-tree.mjs';
import {platformPersistence} from '../shared/persistence.mjs';
import {assertRecoverySourceStopped} from '../../main/project-recovery-owner.mjs';
const require=createRequire(import.meta.url),fail=(code,message)=>Object.assign(Error(message),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const proof=manifest=>({identity:manifest.rootIdentity,manifestSha256:manifest.sha256});
const same=(a,b)=>a&&b&&a.dev===b.dev&&a.ino===b.ino;

export function createExperimentalProjectStorageIO(root,{initialization=false}={}){
 if(typeof initialization!=='boolean')throw new TypeError('Expected explicit Windows initialization option');
 const relative=file=>experimentalPrivateDirectoryComponents(root,file).join('/');
 const persistence=createExperimentalWindowsPersistence(root);
 const mapped=error=>{if(error.code==='WIN32_IO_ERROR'&&[2,3].includes(error.win32Code))error.code='ENOENT';return error;};
 const pinDirectory=directory=>{
  const name=relative(directory);let lease;
  try{lease=require('../../../native/windows/build/Release/nozeli_windows_read.node').openAnchoredDirectoryIdentity(root,name+'/__project_identity__');}
  catch(error){throw mapped(error);}
  return lease;
 };
 const directoryIdentity=async(directory,expected)=>{
  const lease=pinDirectory(directory);
  try{lease.verify();const [dev,ino]=lease.identity().split(':'),identity={dev,ino,kind:'windows-file-id-128'};
   if(expected&&!same(expected,identity))throw fail('PROJECT_IDENTITY_CONFLICT','项目目录实体已变化');return identity;
  }finally{lease.close();}
 };
 const withJson=async(file,fn)=>{
  let parent,lease;
  try{
   parent=openExperimentalPersistenceParent(root,relative(file));lease=parent.openPrivateObjectRead(path.basename(file));const stat=lease.stat();
   if(stat.size<1n||stat.size>1048576n)throw fail('PROJECT_METADATA_CONFLICT','项目清单大小不符');
   const bytes=lease.readAt(0,Number(stat.size));if(bytes.length!==Number(stat.size))throw fail('PROJECT_METADATA_CONFLICT','项目清单被截断');
   let value;try{value=JSON.parse(bytes.toString('utf8'));}catch(cause){throw Object.assign(fail('PROJECT_METADATA_CONFLICT','项目身份清单损坏'),{cause});}
   const result=await fn(value,bytes);lease.verify();parent.verify();return result;
  }catch(error){throw mapped(error);}finally{lease?.close();parent?.close();}
 };
 const readJson=file=>withJson(file,value=>value);
 const checkedMetadata=(directory,db)=>withJson(path.join(directory,'project.json'),async manifest=>{
  if(manifest.schema!==1||typeof manifest.projectId!=='string')throw fail('PROJECT_METADATA_CONFLICT','项目身份格式不符');
  const identity=await db.request(path.join(directory,'project.sqlite'),'get',{collection:'identity',id:'project',mustExist:true});
  if(identity?.schema!==1||identity.projectId!==manifest.projectId)throw fail('PROJECT_METADATA_CONFLICT','项目数据库与清单身份不符');return manifest;
 });
 const writeJson=(file,value,{expectedSha256=null}={})=>{
  const bytes=Buffer.from(JSON.stringify(value));return persistence.writeStream(relative(file),[bytes],{expectedSha256,expectedNewSha256:sha(bytes)});
 };
 const withTree=async(directory,expected,fn,{deletion=false}={})=>{
  if(expected&&(!/^[a-f0-9]{64}$/.test(expected.manifestSha256)||typeof expected.identity!=='string'))throw fail('PROJECT_INITIALIZATION_CONFLICT','完整树身份清单不可核验');
  const lease=await openExperimentalPrivateTree(root,directory,{expectedIdentity:expected?.identity,deletion});
  try{if(expected&&lease.manifest.sha256!==expected.manifestSha256)throw fail('PROJECT_INITIALIZATION_CONFLICT','目录树与已记录清单不符');return await fn(lease);}
  finally{lease.close();}
 };
 const syncTree=directory=>withTree(directory,null,async lease=>{await lease.sync();return proof(lease.manifest);});
 const assertTree=(directory,expected)=>{if(!expected)throw fail('PROJECT_INITIALIZATION_CONFLICT','缺少已记录树身份清单');return withTree(directory,expected,lease=>lease.verify());};
 const copyTree=(source,destination)=>withTree(source,null,async lease=>({sourceTree:proof(lease.manifest),copy:await lease.copyTo(destination)}));
 return Object.freeze({
  requireInitialization(){if(!initialization)platformPersistence.requireSupported();if(process.platform!=='win32'||process.arch!=='x64')throw fail('FS_PLATFORM_UNSUPPORTED','Native Windows x64 required');},
  pinDirectory,directoryIdentity,checkedMetadata,readJson,writeJson,syncTree,assertTree,
  qualification:Object.freeze({state:'barriers-completed',durability:'namespace-not-qualified',productionSelected:false}),
  retainsPartialTrees:true,
  privateDirectory(directory,{anchor=root}={}){relative(directory);if(anchor!==root)relative(anchor);return ensureExperimentalPrivateDirectory(anchor,directory);},
  async syncDirectory(directory){const lease=openExperimentalPersistenceParent(root,relative(directory)+'/__directory_barrier__');try{lease.syncDirectory();}finally{lease.close();}},
  requireSourceStopped:directory=>assertRecoverySourceStopped(directory),
  rejectLinks:directory=>withTree(directory,null,lease=>lease.verify()),
  async createStage(directory,{operationId,source,onCreated=async()=>{}}){
   let copied,allocation;
   if(source)copied=await copyTree(source,directory);
   else{
    const parent=openExperimentalPersistenceParent(root,relative(directory));let lease;
    try{lease=parent.createPrivateTreeRootExclusive(path.basename(directory));allocation={directory,identity:lease.identity()};lease.syncDirectory();parent.syncDirectory();await onCreated(allocation);}
    catch(error){if(lease){error.committed=true;error.durability='uncertain';error.initializationCandidate=allocation;}throw error;}
    finally{lease?.close();parent.close();}
   }
   const oldMarker=copied?.copy.created.find(row=>row.relative==='initialization.json');
   try{await writeJson(path.join(directory,'initialization.json'),{operationId},{expectedSha256:oldMarker?.sha256??null});return copied;}
   catch(error){error.committed=true;error.durability='uncertain';error.initializationCandidate=allocation??{directory,identity:copied.copy.created[0].identity};throw error;}
  },
  async retireStage(directory,{operationId,allocation}){
   return withTree(directory,null,async lease=>{
    if(allocation&&(allocation.directory!==directory||allocation.identity!==lease.manifest.rootIdentity))throw fail('PROJECT_INITIALIZATION_CONFLICT','临时元数据实体已变化');
    let marker;try{marker=JSON.parse((await lease.readFile('initialization.json')).toString('utf8'));}catch(cause){if(cause.code!=='FS_TREE_FILE_MISSING'||!allocation)throw Object.assign(fail('PROJECT_INITIALIZATION_PENDING','临时元数据归属未知，已保留现场'),{cause});}
    if(marker&&marker.operationId!==operationId)throw fail('PROJECT_INITIALIZATION_CONFLICT','临时元数据归属冲突');
    return {directory,...proof(lease.manifest),reason:'incomplete-candidate-retained'};
   });
  },
  async writeExclusive(file,bytes){try{return await persistence.writeStream(relative(file),[Buffer.from(bytes)]);}catch(error){if(error.code!=='FS_TARGET_EXISTS')throw error;}},
  copyTree,
  moveTree:(source,destination,expected)=>{if(!expected)throw fail('PROJECT_INITIALIZATION_CONFLICT','移动缺少已记录树身份清单');return withTree(source,expected,lease=>lease.publishTo(destination));},
  removeTree:(directory,expected)=>{if(!expected)throw fail('PROJECT_INITIALIZATION_CONFLICT','删除缺少已记录树身份清单');return withTree(directory,expected,lease=>lease.remove({expectedManifestSha256:expected.manifestSha256}),{deletion:true});},
 });
}
