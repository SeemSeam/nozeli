import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {assertRecoverySourceStopped} from './project-recovery-owner.mjs';
import {platformPersistence} from '../platform/shared/persistence.mjs';
import {Worker} from 'node:worker_threads';

const fail=(code,message)=>Object.assign(Error(message),{code});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
async function entity(file){try{const s=await fs.lstat(file);if(s.isSymbolicLink()||!s.isDirectory()&&!s.isFile())throw fail('PROJECT_METADATA_CONFLICT','恢复范围包含链接或特殊文件。');return {dev:String(s.dev),ino:String(s.ino),directory:s.isDirectory()};}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function tree(file){const stat=await entity(file);if(!stat)return null;if(!stat.directory)return {...stat,digest:createHash('sha256').update(await fs.readFile(file)).digest('hex')};const children=[];for(const name of (await fs.readdir(file)).sort())children.push([name,await tree(path.join(file,name))]);return {...stat,children};}
async function syncTree(file){const s=await fs.lstat(file);if(s.isDirectory()){for(const name of await fs.readdir(file))await syncTree(path.join(file,name));await platformPersistence.syncDirectory(file);}else{const h=await fs.open(file,'r');try{await h.sync();}finally{await h.close();}}}
async function close(storage,file){const q=storage.db.quarantined.get(file);if(q?.operationIds?.length)throw fail('STORAGE_RESULT_UNKNOWN','存在结果未知的数据库写入，保留全部状态。');const r=await storage.db.request(file,'close');if(r?.closed===false)throw fail('STORAGE_RESULT_UNKNOWN','数据库关闭未确认，保留全部状态。');}

/** Explicit access recovery. No reset, local deletion, model activation or replay. */
export class ProjectForceRecovery {
 constructor(lifecycle){this.lifecycle=lifecycle;this.storage=lifecycle.host.storage;}
 async snapshot(project){
  const root=path.resolve(project.root),storageRoot=path.resolve(this.storage.root);
  if(root!==project.root||root===path.parse(root).root||root===storageRoot||root.startsWith(storageRoot+path.sep)||storageRoot.startsWith(root+path.sep))throw fail('PROJECT_RECOVERY_PROTECTED','恢复目录与应用存储重叠。');
  for(const protectedRoot of this.lifecycle.protectedRoots){const home=path.resolve(process.env.HOME??'');if(protectedRoot!==home&&(protectedRoot===root||root.startsWith(protectedRoot+path.sep)||protectedRoot.startsWith(root+path.sep)))throw fail('PROJECT_RECOVERY_PROTECTED','恢复目录受保护。');}
  const identity=await entity(root);
  if(!identity?.directory||await fs.realpath(root)!==root||identity.dev!==project.identity?.dev||identity.ino!==project.identity?.ino)throw fail('PROJECT_IDENTITY_CONFLICT','原项目根目录实体已变化，未恢复。');
  const metadata=await tree(path.join(root,'.nozeli'));
  if(metadata&&!metadata.directory)throw fail('PROJECT_METADATA_CONFLICT','元数据不是普通目录。');
  return {root,identity,metadata,registration:digest(project)};
 }
 async currentId(project){
  const directory=path.join(project.root,'.nozeli'),file=path.join(directory,'project.sqlite');
  try{
   const manifest=JSON.parse(await fs.readFile(path.join(directory,'project.json'),'utf8'));
   if(manifest.schema!==1||!uuid(manifest.projectId)||!(await entity(file))|| (await entity(file)).directory)return null;
   const row=await new Promise((resolve,reject)=>{const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');try{const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData,{readOnly:true});try{const row=db.prepare("SELECT value FROM records WHERE collection='identity' AND id='project'").get();parentPort.postMessage({value:row?JSON.parse(row.value):null});}finally{db.close();}}catch{parentPort.postMessage({value:null});}`,{eval:true,workerData:file});const timer=setTimeout(()=>{void worker.terminate();reject(fail('STORAGE_TIMEOUT','只读身份核查超时。'));},8000);worker.once('message',message=>{clearTimeout(timer);resolve(message.value);});worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.once('exit',code=>{clearTimeout(timer);if(code)reject(fail('STORAGE_RESULT_UNKNOWN','只读身份核查异常退出。'));});});
   if(row?.schema!==1||row.projectId!==manifest.projectId)return null;
   return manifest.projectId;
  }catch(error){if(['STORAGE_RESULT_UNKNOWN','STORAGE_TIMEOUT'].includes(error.code)||this.storage.db.quarantined.get(file)?.operationIds?.length)throw error;return null;}
 }
 async preview(project){
  if(this.storage.lifecycleHolds.has(project.id))throw fail('PROJECT_STOP_PENDING','项目已有生命周期围栏，未接管或重放。');
  await this.lifecycle.prepareResetAdmission(project.id,project);
  await this.snapshot(project);
  const currentProjectId=await this.currentId(project);
  const source=await this.snapshot(project),operationId=randomUUID(),token=randomUUID();
  if(currentProjectId){const other=(await this.storage.list()).find(p=>p.id===currentProjectId&&p.id!==project.id);if(other)throw fail('PROJECT_IDENTITY_CONFLICT','当前项目编号已登记到其他实例，保留所有状态。');}
  const backupDirectory=path.join(this.storage.root,'force-recovery',operationId);
  return {token,operationId,projectId:project.id,instanceId:project.instanceId,root:project.root,action:'force-recover',expiresAt:Date.now()+300000,source,currentProjectId,recoveryRetained:true,sessionsRetained:true,permanentDelete:false,removeDirectories:[],removeFiles:[],removeRecords:[],forceRecovery:{reason:currentProjectId?'当前元数据与旧本机登记不能安全接续；建立独立本机实例。':'当前元数据损坏或缺失；先完整保留，再建立新元数据。',currentProjectId,backupDirectory,oldInstanceRetained:true,automaticReplay:false,enabled:false,semanticInitializationEligible:false}};
 }
 async execute(c){
  const {storage,lifecycle}=this,{projectId,operationId}=c;
  const prior=await storage.db.request(storage.catalog,'get',{collection:'force_recovery',id:operationId});
  if(prior)return prior.result??{status:'unknown',recovered:null,projectId,operationId,backupDirectory:c.forceRecovery.backupDirectory,automaticReplay:false,message:'上次恢复结果未知；不会重放。'};
  const project=await lifecycle.host.requireRegisteredProject(projectId);
  if(!same(c.source,await this.snapshot(project)))throw fail('PROJECT_IDENTITY_CONFLICT','确认后恢复来源已变化，请重新预览。');
  if(storage.lifecycleHolds.has(projectId))throw fail('PROJECT_STOP_PENDING','项目已有生命周期围栏，未接管或重放。');
  await lifecycle.prepareResetAdmission(projectId,project);
  const hold=storage.holdProject(projectId,{operationId,instanceId:c.instanceId,action:'force-recover',root:c.root});hold.pendingCount=0;
  let record={schema:1,operationId,projectId,instanceId:c.instanceId,backupDirectory:c.forceRecovery.backupDirectory,phase:'backup-prepared'};
  const checkpoint=async patch=>{record={...record,...patch};await storage.db.request(storage.catalog,'put',{collection:'force_recovery',id:operationId,value:record});};
  let published=false,completed=false;
  try{
   await storage.persistProjectHold(projectId,hold);await checkpoint({});
   await lifecycle.stopHeldProject(projectId,hold);
   return await storage.withLifecycleOwner(projectId,hold,async()=>{
    const metadataFile=path.join(c.root,'.nozeli','project.sqlite');if(await entity(metadataFile))await close(storage,metadataFile);
    await assertRecoverySourceStopped(c.root);
    if(!same(c.source,await this.snapshot(project)))throw fail('PROJECT_IDENTITY_CONFLICT','停稳后恢复来源已变化，请重新预览。');
    const backup=c.forceRecovery.backupDirectory;
    await fs.mkdir(backup,{recursive:true,mode:0o700});
    await fs.writeFile(path.join(backup,'registration.json'),JSON.stringify({...project,oldInstanceId:project.instanceId}),{flag:'wx',mode:0o600});
    const oldLocal=await storage.localDirectory(projectId),oldLocalFile=path.join(oldLocal,'ui.sqlite');if(await entity(oldLocalFile))await close(storage,oldLocalFile);
    if(await entity(oldLocal))await fs.cp(oldLocal,path.join(backup,'old-instance'),{recursive:true,force:false,errorOnExist:true});
    await fs.writeFile(path.join(backup,'README.txt'),'Nozeli force-recovery retained snapshot.\nOld instance: '+project.instanceId+'\nOld local state, drafts, history and native objects are retained under old-instance/.\nThe new registration is disabled and semantic initialization is ineligible. No model activation or business replay occurred.\nThis directory is an exportable preservation copy; the original project source and old local registration are retained separately.\n',{flag:'wx',mode:0o600});
    if(c.source.metadata)await fs.cp(path.join(c.root,'.nozeli'),path.join(backup,'metadata'),{recursive:true,force:false,errorOnExist:true});
    await syncTree(backup);await platformPersistence.syncDirectory(path.dirname(backup));
    await checkpoint({phase:'preserved'});
    if(!same(c.source,await this.snapshot(project)))throw fail('PROJECT_IDENTITY_CONFLICT','备份期间来源已变化，未切换。');
    let newProjectId=c.currentProjectId;
    const metadataRoot=path.join(c.root,'.nozeli');
    if(!newProjectId){
     newProjectId=randomUUID();const staging=path.join(c.root,'.nozeli-force-'+operationId);
     await fs.mkdir(staging,{mode:0o700});
     await fs.mkdir(path.join(staging,'objects','sha256'),{recursive:true});await fs.mkdir(path.join(staging,'memory','plantree'),{recursive:true});
     await fs.writeFile(path.join(staging,'memory','plantree','index.md'),'# Plan Tree\n',{flag:'wx'});
     await fs.writeFile(path.join(staging,'project.json'),JSON.stringify({schema:1,projectId:newProjectId,operationId}),{flag:'wx'});
     const file=path.join(staging,'project.sqlite');await storage.db.request(file,'put',{collection:'identity',id:'project',value:{schema:1,projectId:newProjectId}});await close(storage,file);await syncTree(staging);
     await assertRecoverySourceStopped(c.root);
     if(!same(c.source,await this.snapshot(project)))throw fail('PROJECT_IDENTITY_CONFLICT','发布前来源已变化。');
     if(c.source.metadata)await fs.rename(metadataRoot,path.join(c.root,'.nozeli-retained-'+operationId));
     await fs.rename(staging,metadataRoot);await platformPersistence.syncDirectory(c.root);
    }
    const now=new Date().toISOString(),metadataIdentity=await entity(metadataRoot);
    const fresh={id:newProjectId,instanceId:randomUUID(),name:project.name,root:c.root,identity:project.identity,metadataRoot,metadataIdentity:{dev:metadataIdentity.dev,ino:metadataIdentity.ino},semanticInitializationEligible:false,recoveryRequiresConnection:true,enabled:false,openedAt:now,lastOpenedAt:now,removed:false,lineage:[]};
    await storage.db.request(storage.catalog,'put',{collection:'retained_instances',id:project.instanceId,value:{...project,removed:true,readOnly:true,retainedBy:operationId}});
    if(newProjectId!==projectId){const retired={...project,removed:true,readOnly:true,retainedBy:operationId};await storage.db.request(storage.catalog,'put',{collection:'instances',id:projectId,value:retired});storage.bindings.set(projectId,retired);}
    await storage.db.request(storage.catalog,'put',{collection:'instances',id:newProjectId,value:fresh});storage.bindings.set(newProjectId,fresh);storage.unavailable.delete(newProjectId);storage.generations.set(newProjectId,(storage.generations.get(newProjectId)??0)+1);published=true;
    await storage.putLocal(newProjectId,'managed:binding',{schema:1,enabled:false,recoveryRequiresConnection:true,roles:{}});
    await checkpoint({phase:'registration-published',newProjectId,newInstanceId:fresh.instanceId});
    await storage.releaseProject(projectId,hold);
    await storage.db.recover(metadataFile);
    await lifecycle.host.requireProject(newProjectId);
    await storage.requireOnline(newProjectId);
    const result={status:'recovered',recovered:true,message:'已恢复项目访问；旧本机状态和元数据已保留，未启用模型或重放业务。',operationId,projectId,newProjectId,backupDirectory:backup,automaticReplay:false};
    await checkpoint({phase:'complete',result});completed=true;return result;
   });
  }catch(error){
   const result={status:published?'unknown':'blocked',recovered:published?null:false,message:published?'恢复发布结果未能完整核验；不会重复执行。':error.message,operationId,projectId,backupDirectory:c.forceRecovery.backupDirectory,automaticReplay:false};
   await checkpoint({phase:'needs-attention',failedPhase:record.phase,errorCode:error.code??'UNKNOWN',result}).catch(()=>{});return result;
  }finally{
   if(!published&&!hold.pendingCount&&!hold.needsStopCheck)await storage.releaseProject(projectId,hold);
   if(!completed&&published)hold.needsStopCheck=true;
  }
 }
}
