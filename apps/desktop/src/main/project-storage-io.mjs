// File effects for the shared ProjectStorage initialization state machine.
// Production persistence selection is unchanged; Windows is explicit only.
import fs from 'node:fs/promises';
import path from 'node:path';
import {platformPersistence} from '../platform/shared/persistence.mjs';
import {createExperimentalProjectStorageIO} from '../platform/windows/experimental-project-storage.mjs';
const fail=(code,message)=>Object.assign(Error(message),{code});
const same=(a,b)=>a&&b&&a.dev===b.dev&&a.ino===b.ino;
async function present(file){try{return await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function directoryIdentity(root,expected){const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(root)!==root)throw fail('PROJECT_IDENTITY_CONFLICT','项目目录不是已登记的真实目录');const identity={dev:String(stat.dev),ino:String(stat.ino)};if(expected&&!same(expected,identity))throw fail('PROJECT_IDENTITY_CONFLICT','项目目录实体已变化');return identity;}
async function readJson(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function checkedMetadata(directory,db){
 const stat=await present(directory);if(!stat||!stat.isDirectory()||stat.isSymbolicLink())throw fail('PROJECT_METADATA_MISSING','项目元数据不可用，未自动重建');
 for(const file of ['project.json','project.sqlite','project.sqlite-journal','project.sqlite-wal','project.sqlite-shm']){const entry=await present(path.join(directory,file));if((!entry&&['project.json','project.sqlite'].includes(file))||(entry&&(!entry.isFile()||entry.isSymbolicLink())))throw fail('PROJECT_METADATA_CONFLICT','项目元数据不是普通文件');}
 let manifest;try{manifest=await readJson(path.join(directory,'project.json'));}catch{throw fail('PROJECT_METADATA_CONFLICT','项目身份清单损坏');}
 if(manifest.schema!==1||typeof manifest.projectId!=='string')throw fail('PROJECT_METADATA_CONFLICT','项目身份格式不符');
 const identity=await db.request(path.join(directory,'project.sqlite'),'get',{collection:'identity',id:'project',mustExist:true});
 if(identity?.schema!==1||identity.projectId!==manifest.projectId)throw fail('PROJECT_METADATA_CONFLICT','项目数据库与清单身份不符');return manifest;
}
async function rejectLinks(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const full=path.join(directory,entry.name),stat=await fs.lstat(full);if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))throw fail('PROJECT_METADATA_CONFLICT','项目元数据包含链接或特殊文件');if(stat.isDirectory())await rejectLinks(full);}}
async function writeJson(file,value){const handle=await fs.open(file,'w',0o600);try{await handle.writeFile(JSON.stringify(value));await platformPersistence.syncFileHandle(handle);}finally{await handle.close();}}
async function syncTree(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())await syncTree(file);else if(entry.isFile()){const handle=await fs.open(file,'r');try{await platformPersistence.syncFileHandle(handle);}finally{await handle.close();}}else throw fail('PROJECT_METADATA_CONFLICT','项目元数据包含链接或特殊文件');}await platformPersistence.syncDirectory(directory);return null;}

export function createProjectStorageIO({experimentalWindowsRoot,experimentalWindowsInitialization=false}={}){
 if(experimentalWindowsRoot!==undefined)return createExperimentalProjectStorageIO(experimentalWindowsRoot,{initialization:experimentalWindowsInitialization});
 if(experimentalWindowsInitialization)throw new TypeError('An explicit Windows root is required for experimental initialization');
 return Object.freeze({
  requireInitialization:()=>platformPersistence.requireSupported(),pinDirectory:()=>null,
  directoryIdentity,checkedMetadata,readJson,writeJson,rejectLinks,syncTree,
  privateDirectory:directory=>fs.mkdir(directory,{recursive:true,mode:0o700}),
  syncDirectory:directory=>platformPersistence.syncDirectory(directory),
  requireSourceStopped:async()=>{},
  async createStage(directory,{operationId,source}){
   await fs.mkdir(directory,{mode:0o700});await writeJson(path.join(directory,'initialization.json'),{operationId});
   if(source)for(const entry of await fs.readdir(source)){if(entry!=='initialization.json')await fs.cp(path.join(source,entry),path.join(directory,entry),{recursive:true,force:false,errorOnExist:true});}
   return null;
  },
  async retireStage(directory){await fs.rm(directory,{recursive:true});return null;},
  async writeExclusive(file,bytes){await fs.writeFile(file,bytes,{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});},
  async copyTree(source,destination){await fs.cp(source,destination,{recursive:true,errorOnExist:true,force:false});return null;},
  removeTree:directory=>fs.rm(directory,{recursive:true,force:true}),
  moveTree:(source,destination)=>fs.rename(source,destination),
  assertTree:async()=>{},
  retainsPartialTrees:false,qualification:null,
 });
}
