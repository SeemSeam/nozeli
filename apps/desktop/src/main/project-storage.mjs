import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {StorageDatabase} from './storage-database.mjs';
import {MaterialStore} from '../domain/material-store.mjs';
import {assertRecoverySourceStopped} from './project-recovery-owner.mjs';
const fail=(code,message)=>Object.assign(Error(message),{code});
async function checkedClose(db,file){const outcome=await db.request(file,'close');if(outcome?.closed===false)throw Object.assign(fail('STORAGE_RESULT_UNKNOWN','存储线程停止未确认；禁止清理或移动数据库'),{file,operationIds:outcome.operationIds??[],commitUnknown:{file},closeOutcome:outcome});}
const same=(a,b)=>a&&b&&a.dev===b.dev&&a.ino===b.ino;
async function present(file){try{return await fs.lstat(file)}catch(e){if(e.code==='ENOENT')return null;throw e}}
async function directoryIdentity(root,expected){const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(root)!==root)throw fail('PROJECT_IDENTITY_CONFLICT','项目目录不是已登记的真实目录');const identity={dev:String(stat.dev),ino:String(stat.ino)};if(expected&&!same(expected,identity))throw fail('PROJECT_IDENTITY_CONFLICT','项目目录实体已变化');return identity;}
async function checkedMetadata(directory,db){const stat=await present(directory);if(!stat||!stat.isDirectory()||stat.isSymbolicLink())throw fail('PROJECT_METADATA_MISSING','项目元数据不可用，未自动重建');for(const file of ['project.json','project.sqlite','project.sqlite-journal','project.sqlite-wal','project.sqlite-shm']){const entry=await present(path.join(directory,file));if((!entry&&['project.json','project.sqlite'].includes(file))||(entry&&(!entry.isFile()||entry.isSymbolicLink())))throw fail('PROJECT_METADATA_CONFLICT','项目元数据不是普通文件');}let manifest;try{manifest=JSON.parse(await fs.readFile(path.join(directory,'project.json'),'utf8'))}catch{throw fail('PROJECT_METADATA_CONFLICT','项目身份清单损坏');}if(manifest.schema!==1||typeof manifest.projectId!=='string')throw fail('PROJECT_METADATA_CONFLICT','项目身份格式不符');const identity=await db.request(path.join(directory,'project.sqlite'),'get',{collection:'identity',id:'project',mustExist:true});if(identity?.schema!==1||identity.projectId!==manifest.projectId)throw fail('PROJECT_METADATA_CONFLICT','项目数据库与清单身份不符');return manifest;}
async function rejectLinks(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const full=path.join(directory,entry.name),stat=await fs.lstat(full);if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))throw fail('PROJECT_METADATA_CONFLICT','项目元数据包含链接或特殊文件');if(stat.isDirectory())await rejectLinks(full);}}
async function durableJson(file,value){const handle=await fs.open(file,'w',0o600);try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}}
async function syncTree(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())await syncTree(file);else if(entry.isFile()){const handle=await fs.open(file,'r');try{await handle.sync();}finally{await handle.close();}}else throw fail('PROJECT_METADATA_CONFLICT','项目元数据包含链接或特殊文件');}await syncDirectory(directory);}
async function syncDirectory(directory){if(process.platform!=='win32'){const handle=await fs.open(directory,'r');try{await handle.sync();}finally{await handle.close();}}}
export class ProjectStorage {
 constructor(userDataDir){this.root=path.join(userDataDir,'nozeli','storage-v2');this.catalog=path.join(this.root,'catalog.sqlite');this.db=new StorageDatabase();this.bindings=new Map();this.initFlight=null;this.registrations=new Map();this.generations=new Map();this.unavailable=new Map();this.lifecycleHolds=new Map();}
 lifecycleOwner=new AsyncLocalStorage();
 operationOwner=new AsyncLocalStorage();
 projectOperations=new Map();
 async withProjectOperation(id,run){
  await this.ready();
  this.assertActive(id);
  const inherited=this.operationOwner.getStore();
  if(inherited?.projectId===id&&inherited.active)return run();
  if(this.lifecycleOwner.getStore()===this.lifecycleHolds.get(id)&&this.lifecycleHolds.has(id))return run();
  const operations=this.projectOperations.get(id)??new Set();this.projectOperations.set(id,operations);
  let settle;const operation={projectId:id,active:true,settled:new Promise(resolve=>{settle=resolve;})};operations.add(operation);
  try{return await this.operationOwner.run(operation,run);}
  finally{operation.active=false;operations.delete(operation);if(!operations.size)this.projectOperations.delete(id);settle();}
 }
 async drainProjectOperations(id){await Promise.all([...(this.projectOperations.get(id)??[])].map(operation=>operation.settled));}
 assertActive(id){const hold=this.lifecycleHolds.get(id),operation=this.operationOwner.getStore();if(hold&&this.lifecycleOwner.getStore()!==hold&&!(operation?.projectId===id&&operation.active&&this.projectOperations.get(id)?.has(operation)))throw Object.assign(fail('PROJECT_LIFECYCLE_ACTIVE','项目正在停用或等待停稳核查；未接受新操作。'),{operationId:hold.operationId});}
 holdProject(id,{operationId,instanceId,action}){const prior=this.lifecycleHolds.get(id);if(prior)throw fail('PROJECT_LIFECYCLE_ACTIVE','项目已有待核查生命周期操作。');const hold={operationId,instanceId,action,localClosed:false};this.lifecycleHolds.set(id,hold);return hold;}
 async releaseProject(id,hold){if(this.lifecycleHolds.get(id)!==hold)return;await this.db.request(this.catalog,'delete',{collection:'lifecycle_holds',id});if(this.lifecycleHolds.get(id)===hold)this.lifecycleHolds.delete(id);}
 sealLocal(id,hold){if(this.lifecycleHolds.get(id)!==hold)throw fail('PROJECT_LIFECYCLE_ACTIVE','生命周期令牌不匹配。');hold.localClosed=true;}
 assertLocalOpen(id){if(this.lifecycleHolds.get(id)?.localClosed)throw fail('PROJECT_LIFECYCLE_ACTIVE','本机状态已经封闭；仅可保留独立恢复内容。');}
 withLifecycleOwner(id,hold,run){if(this.lifecycleHolds.get(id)!==hold)throw fail('PROJECT_LIFECYCLE_ACTIVE','生命周期令牌不匹配。');return this.lifecycleOwner.run(hold,run);}
 async persistProjectHold(id,hold){await this.db.request(this.catalog,'put',{collection:'lifecycle_holds',id,value:{operationId:hold.operationId,instanceId:hold.instanceId,action:hold.action}});}
 async ready(){this.initFlight??=(async()=>{await fs.mkdir(this.root,{recursive:true,mode:0o700});for(const {id,value} of await this.db.request(this.catalog,'list',{collection:'lifecycle_holds'}))this.lifecycleHolds.set(id,{...value,pendingCount:0,needsStopCheck:true,localClosed:false});})();await this.initFlight;}
 async requireRegistered(id){await this.ready();const p=this.bindings.get(id)??await this.db.request(this.catalog,'get',{collection:'instances',id});if(!p)throw fail('UNKNOWN_PROJECT','项目未登记');this.bindings.set(id,p);return p;}
 async list(){await this.ready();return (await this.db.request(this.catalog,'list',{collection:'instances'})).map(r=>r.value);}
 async requireOnline(id){this.assertActive(id);const p=await this.requireRegistered(id);this.assertActive(id);if(this.unavailable.has(id))throw this.unavailable.get(id);try{try{await directoryIdentity(p.root,p.identity);}catch(e){if(e.code==='ENOENT')throw fail('PROJECT_ROOT_MISSING','原项目目录不可用；草稿仍可保留在本机');throw e;}if(!p.metadataIdentity)throw fail('PROJECT_METADATA_CONFLICT','缺少已核验的元数据实体身份');try{await directoryIdentity(p.metadataRoot,p.metadataIdentity);}catch(e){if(e.code==='ENOENT')throw fail('PROJECT_METADATA_MISSING','项目元数据不可用，未自动重建');throw e;}const manifest=await checkedMetadata(p.metadataRoot,this.db);if(manifest.projectId!==p.id)throw fail('PROJECT_IDENTITY_CONFLICT','项目身份或格式不符');this.assertActive(id);return p;}catch(error){if(error.code==='PROJECT_LIFECYCLE_ACTIVE')throw error;this.generations.set(id,(this.generations.get(id)??0)+1);this.unavailable.set(id,error);this.onUnavailable?.(id,error);await this.db.invalidate(path.join(p.metadataRoot,'project.sqlite'));throw error;}}
 async register(input,options={}){const root=await fs.realpath(input),previous=this.registrations.get(root)??Promise.resolve();const run=previous.catch(()=>{}).then(()=>this.initialize(root,options));this.registrations.set(root,run);try{return await run;}finally{if(this.registrations.get(root)===run)this.registrations.delete(root);}}
 async initialize(input,{confirmRecovery}={}){
  await this.ready();const root=await fs.realpath(input),identity=await directoryIdentity(root),all=await this.list();
  let existing=all.filter(p=>p.root===root&&same(p.identity,identity)).sort((a,b)=>Number(a.removed)-Number(b.removed)||String(b.openedAt).localeCompare(String(a.openedAt)))[0];
  const key=createHash('sha256').update(JSON.stringify([root,identity.dev,identity.ino])).digest('hex'),metadataRoot=path.join(root,'.nozeli');
  let intent=await this.db.request(this.catalog,'get',{collection:'initializations',id:key});
  let recoverySource=null;
  if(existing&&(!intent||intent.phase==='complete')){
   this.assertActive(existing.id);
   const actual=await directoryIdentity(metadataRoot);
   if(existing.removed){
    if(!same(actual,existing.metadataIdentity))await assertRecoverySourceStopped(root);
    await checkedClose(this.db,path.join(metadataRoot,'project.sqlite'));
   }
   const manifest=await checkedMetadata(metadataRoot,this.db);
   if(existing.removed&&(!same(actual,existing.metadataIdentity)||manifest.projectId!==existing.id)){
    const frozen={root,identity,metadataIdentity:actual,projectId:manifest.projectId,schema:manifest.schema,previousId:existing.id};
    await assertRecoverySourceStopped(root);
    if(!confirmRecovery||await confirmRecovery(frozen)!==true)throw fail('PROJECT_RECOVERY_CANCELLED','项目身份恢复已取消，目录及旧恢复记录保持不变。');
    await directoryIdentity(root,identity);await directoryIdentity(metadataRoot,actual);
    const confirmed=await checkedMetadata(metadataRoot,this.db);
    if(confirmed.schema!==frozen.schema||confirmed.projectId!==frozen.projectId)throw fail('PROJECT_IDENTITY_CONFLICT','确认后项目身份已变化，未恢复。');
    await assertRecoverySourceStopped(root);this.assertActive(existing.id);
    recoverySource=frozen;intent=null;existing=null;
   }else{
    await this.requireOnline(existing.id);const value={...existing,removed:false,lastOpenedAt:new Date().toISOString()};await this.db.request(this.catalog,'put',{collection:'instances',id:value.id,value});this.bindings.set(value.id,value);return value;
   }
  }
  if(all.some(p=>p.root===root&&!same(p.identity,identity)))throw fail('PROJECT_IDENTITY_CONFLICT','原路径出现不同目录，需明确创建新项目');
  if(existing&&existing.id!==intent?.id&&!(existing.removed&&existing.id===intent?.recoverySource?.previousId))throw fail('PROJECT_INITIALIZATION_CONFLICT','初始化记录与登记身份冲突');
  const checkpoint=async patch=>{const next={...intent,...patch};await this.db.request(this.catalog,'put',{collection:'initializations',id:key,value:next});intent=next;};
  if(!intent){
   let source=null;if(await present(metadataRoot))source=await checkedMetadata(metadataRoot,this.db);
   const id=randomUUID(),instanceId=randomUUID(),operationId=randomUUID(),now=new Date().toISOString();
   await checkpoint({version:1,key,root,identity,id,instanceId,operationId,now,source,recoverySource,phase:'prepared',temporary:path.join(root,'.nozeli-init-'+operationId),swap:path.join(root,'.nozeli-source-'+operationId),backup:path.join(this.root,'initialization',operationId,'source')});
  }
  if(intent.version!==1||intent.root!==root||!same(intent.identity,identity))throw fail('PROJECT_INITIALIZATION_CONFLICT','初始化记录身份冲突');
  const verify=()=>directoryIdentity(root,identity);
  const candidate=async directory=>{const manifest=await checkedMetadata(directory,this.db);if(manifest.projectId!==intent.id||manifest.operationId!==intent.operationId)throw fail('PROJECT_INITIALIZATION_CONFLICT','初始化内容不属于本操作');return manifest;};
  if(intent.phase==='prepared'||intent.phase==='staging'){
   await verify();
   if(await present(intent.temporary)){
    const tempStat=await fs.lstat(intent.temporary);if(!tempStat.isDirectory()||tempStat.isSymbolicLink())throw fail('PROJECT_INITIALIZATION_CONFLICT','临时元数据不是本操作目录');
    const markerStat=await present(path.join(intent.temporary,'initialization.json'));if(!markerStat?.isFile()||markerStat.isSymbolicLink())throw fail('PROJECT_INITIALIZATION_PENDING','临时元数据归属未知，需要明确恢复');
    const marker=path.join(intent.temporary,'initialization.json');let owned;try{owned=JSON.parse(await fs.readFile(marker,'utf8'))}catch{throw fail('PROJECT_INITIALIZATION_PENDING','临时元数据归属未知，需要明确恢复');}
    if(owned.operationId!==intent.operationId)throw fail('PROJECT_INITIALIZATION_CONFLICT','临时元数据归属冲突');
    await checkedClose(this.db,path.join(intent.temporary,'project.sqlite'));await fs.rm(intent.temporary,{recursive:true});
   }
   await checkpoint({phase:'staging'});await fs.mkdir(intent.temporary,{mode:0o700});await durableJson(path.join(intent.temporary,'initialization.json'),{operationId:intent.operationId});
   if(intent.source){
    const source=await checkedMetadata(metadataRoot,this.db);if(source.projectId!==intent.source.projectId)throw fail('PROJECT_INITIALIZATION_CONFLICT','来源身份已变化');
    await rejectLinks(metadataRoot);await checkedClose(this.db,path.join(metadataRoot,'project.sqlite'));
    for(const suffix of ['-journal','-wal','-shm'])if(await present(path.join(metadataRoot,'project.sqlite'+suffix)))throw fail('PROJECT_INITIALIZATION_PENDING','来源数据库尚有事务文件，需停止来源写入后重试');
    for(const entry of await fs.readdir(metadataRoot)){if(entry==='initialization.json')continue;await fs.cp(path.join(metadataRoot,entry),path.join(intent.temporary,entry),{recursive:true,force:false,errorOnExist:true});}
    const rows=await this.db.request(path.join(intent.temporary,'project.sqlite'),'all'),collections={};
    // Remap only live structured project ownership. Immutable historical facts
    // and object bytes keep their source identity and digest unchanged.
    const remap=value=>{if(Array.isArray(value))return value.map(remap);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='projectId'&&v===intent.source.projectId?intent.id:['lineage','history','manifest','sourceManifest','receipt','provenance','snapshot','frozen','source'].includes(k)?v:remap(v)]));return value;};
    for(const row of rows){if(row.collection==='identity')continue;(collections[row.collection]??=[]).push({id:row.id,value:remap(row.value)});}
    await this.db.request(path.join(intent.temporary,'project.sqlite'),'replace',{collections});
   }
   await fs.mkdir(path.join(intent.temporary,'objects','sha256'),{recursive:true});await fs.mkdir(path.join(intent.temporary,'memory','plantree'),{recursive:true});await fs.writeFile(path.join(intent.temporary,'memory','plantree','index.md'),'# Plan Tree\n',{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
   await this.db.request(path.join(intent.temporary,'project.sqlite'),'put',{collection:'identity',id:'project',value:{projectId:intent.id,schema:1}});await checkedClose(this.db,path.join(intent.temporary,'project.sqlite'));
   await durableJson(path.join(intent.temporary,'project.json'),{schema:1,projectId:intent.id,operationId:intent.operationId,lineage:intent.source?.projectId??null});await candidate(intent.temporary);await checkedClose(this.db,path.join(intent.temporary,'project.sqlite'));
   await rejectLinks(intent.temporary);await syncTree(intent.temporary);await syncDirectory(root);
   await checkpoint({phase:'staged'});
  }
  if(intent.phase==='staged'){
   await verify();await candidate(intent.temporary);await checkedClose(this.db,path.join(intent.temporary,'project.sqlite'));
   if(intent.source){
    if(intent.recoverySource){await assertRecoverySourceStopped(root);await directoryIdentity(root,intent.recoverySource.identity);const location=await present(intent.swap)?intent.swap:metadataRoot;await directoryIdentity(location,intent.recoverySource.metadataIdentity);const source=await checkedMetadata(location,this.db);if(source.projectId!==intent.recoverySource.projectId||source.schema!==intent.recoverySource.schema)throw fail('PROJECT_IDENTITY_CONFLICT','恢复发布前来源身份已变化。');}
    if(!await present(intent.swap)){const source=await checkedMetadata(metadataRoot,this.db);if(source.projectId!==intent.source.projectId)throw fail('PROJECT_INITIALIZATION_CONFLICT','来源身份已变化');await checkedClose(this.db,path.join(metadataRoot,'project.sqlite'));await fs.rename(metadataRoot,intent.swap);}
    const source=await checkedMetadata(intent.swap,this.db);if(source.projectId!==intent.source.projectId)throw fail('PROJECT_INITIALIZATION_CONFLICT','保留来源身份冲突');await checkedClose(this.db,path.join(intent.swap,'project.sqlite'));
    // Source remains intact beside the project until its independent app-local
    // preservation copy is complete. Interrupted copies are rebuilt on retry.
    await checkedClose(this.db,path.join(intent.backup,'project.sqlite'));
    await rejectLinks(intent.swap);await fs.mkdir(path.dirname(intent.backup),{recursive:true,mode:0o700});await fs.rm(intent.backup,{recursive:true,force:true});await fs.cp(intent.swap,intent.backup,{recursive:true,errorOnExist:true,force:false});await checkedMetadata(intent.backup,this.db);await checkedClose(this.db,path.join(intent.backup,'project.sqlite'));
    await syncTree(intent.backup);await syncDirectory(path.dirname(intent.backup));await syncDirectory(root);
   }
   await checkpoint({phase:'source-preserved'});
  }
  if(intent.phase==='source-preserved'){
   if(intent.recoverySource){await assertRecoverySourceStopped(root);await directoryIdentity(root,intent.recoverySource.identity);await directoryIdentity(intent.swap,intent.recoverySource.metadataIdentity);const source=await checkedMetadata(intent.swap,this.db);if(source.projectId!==intent.recoverySource.projectId||source.schema!==intent.recoverySource.schema)throw fail('PROJECT_IDENTITY_CONFLICT','恢复发布前来源身份已变化。');}
   await verify();if(await present(metadataRoot)){await candidate(metadataRoot);}else{await candidate(intent.temporary);await checkedClose(this.db,path.join(intent.temporary,'project.sqlite'));await fs.rename(intent.temporary,metadataRoot);}await syncDirectory(root);await checkpoint({phase:'published'});
  }
  if(!['published','source-cleanup','complete'].includes(intent.phase))throw fail('PROJECT_INITIALIZATION_PENDING','初始化需要用户明确重试');
  await verify();await candidate(metadataRoot);
  const metadataIdentity=await directoryIdentity(metadataRoot);
  const p={id:intent.id,instanceId:intent.instanceId,root,metadataRoot,identity,metadataIdentity,lineage:[...new Set([intent.source?.projectId,...(Array.isArray(intent.source?.lineage)?intent.source.lineage:[intent.source?.lineage])].filter(Boolean))],name:path.basename(root),openedAt:intent.now,lastOpenedAt:new Date().toISOString(),removed:false};
  await this.db.request(this.catalog,'put',{collection:'instances',id:p.id,value:p});
  if(intent.source&&await present(intent.swap)){
   const backup=await checkedMetadata(intent.backup,this.db);if(backup.projectId!==intent.source.projectId)throw fail('PROJECT_INITIALIZATION_CONFLICT','来源保留副本身份冲突');await checkedClose(this.db,path.join(intent.backup,'project.sqlite'));
   const swapIdentity=await directoryIdentity(intent.swap);
   if(intent.phase!=='source-cleanup'){
    const source=await checkedMetadata(intent.swap,this.db);if(source.projectId!==intent.source.projectId)throw fail('PROJECT_INITIALIZATION_CONFLICT','来源身份冲突');await checkedClose(this.db,path.join(intent.swap,'project.sqlite'));
    await checkpoint({phase:'source-cleanup',swapIdentity});
   }else if(!same(swapIdentity,intent.swapIdentity))throw fail('PROJECT_INITIALIZATION_CONFLICT','来源临时目录实体已变化');
   await verify();await directoryIdentity(intent.swap,intent.swapIdentity);await fs.rm(intent.swap,{recursive:true});await syncDirectory(root);
  }
  await checkpoint({phase:'complete'});this.bindings.set(p.id,p);return p;
 }
 async localDirectory(id){const p=await this.requireRegistered(id);const dir=path.join(this.root,'instances',p.instanceId);await fs.mkdir(dir,{recursive:true,mode:0o700});return dir;}
 async recoveryDirectory(id){const p=await this.requireRegistered(id);const dir=path.join(this.root,'recovery',p.instanceId);await fs.mkdir(dir,{recursive:true,mode:0o700});return dir;}
 async projectDirectory(id){return (await this.requireOnline(id)).metadataRoot;}
 async getLocal(id,key){this.assertLocalOpen(id);const directory=await this.localDirectory(id);this.assertLocalOpen(id);return this.db.request(path.join(directory,'ui.sqlite'),'get',{collection:'ui',id:key});}
 async putLocal(id,key,value){this.assertLocalOpen(id);const directory=await this.localDirectory(id);this.assertLocalOpen(id);return this.db.request(path.join(directory,'ui.sqlite'),'put',{collection:'ui',id:key,value});}
 async projectRequest(id,op,args){const p=await this.requireOnline(id),generation=this.generations.get(id)??0;const result=await this.db.request(path.join(p.metadataRoot,'project.sqlite'),op,{...args,generation,mustExist:true});try{await this.requireOnline(id);if(generation!==(this.generations.get(id)??0))throw fail('PROJECT_IDENTITY_CONFLICT','项目代际改变');}catch(cause){if(['put','replace','delete'].includes(op))throw Object.assign(fail('STORAGE_RESULT_UNKNOWN','项目提交后身份失效，结果待核查'),{cause,commitUnknown:{projectId:id,generation}});throw cause;}return result;}
 async getProject(id,table,key){return this.projectRequest(id,'get',{collection:table,id:key});}
 async putProject(id,table,key,value,{expectedRevision,operationId}={}){return this.projectRequest(id,'put',{collection:table,id:key,value,expectedRevision,operationId});}
 async getRecovery(id,key){return this.db.request(path.join(await this.recoveryDirectory(id),'recovery.sqlite'),'get',{collection:'recovery',id:key});}
 async putRecovery(id,key,value){return this.db.request(path.join(await this.recoveryDirectory(id),'recovery.sqlite'),'put',{collection:'recovery',id:key,value});}
 async listLocalViews(id){const directory=await this.localDirectory(id);const rows=await this.db.request(path.join(directory,'ui.sqlite'),'list',{collection:'ui'});return rows.filter(row=>['view','workspace:layout','file-tree-view'].includes(row.id)||row.id.startsWith('tex:view:'));}
 async clearLocalViews(id,{ids,operationId}){
  const hold=this.lifecycleHolds.get(id);if(hold?.action!=='clean-local'||this.lifecycleOwner.getStore()!==hold)throw fail('PROJECT_LIFECYCLE_ACTIVE','需要本机清理操作的唯一令牌。');
  const directory=await this.localDirectory(id),file=path.join(directory,'ui.sqlite'),rows=(await this.db.request(file,'list',{collection:'ui'})).map(({id,value})=>({id,value}));
  const selected=new Set(ids);if([...selected].some(key=>!['view','workspace:layout','file-tree-view'].includes(key)&&!key.startsWith('tex:view:')))throw fail('INVALID_LOCAL_CLEAN_SCOPE','仅允许重置已确认的视图记录。');
  const removed=rows.filter(row=>selected.has(row.id));
  await this.putRecovery(id,'workspace:local-clean:'+operationId,{projectId:id,kind:'local-view-backup',operationId,workspace:{localRecords:removed},retainedAt:new Date().toISOString()});
  await this.db.request(file,'replace',{collections:{ui:rows.filter(row=>!selected.has(row.id))},expectedCollections:{ui:rows},operationId});
  return {removedRecords:removed.map(row=>row.id)};
 }
 async remove(id,{operationId}={}){const p=await this.requireRegistered(id),key=operationId?'lifecycle:remove:'+operationId:null;if(key){const receipt=await this.getRecovery(id,key);if(receipt?.complete)return receipt.result;}const next={...p,removed:true};await this.db.request(this.catalog,'put',{collection:'instances',id,value:next,operationId});this.bindings.set(id,next);const result={removed:true,projectId:id,operationId};if(key)await this.putRecovery(id,key,{complete:true,result});return result;}
 async objects(id){return new MaterialStore(path.join(await this.projectDirectory(id),'objects','sha256'),{createDirectory:false});}
 async listProject(id,collection){return this.projectRequest(id,'list',{collection});}
 async replaceProjectCollections(id,collections,{expectedCollections}={}){return this.projectRequest(id,'replace',{collections,expectedCollections});}
 async putObject(id,bytes){return (await this.objects(id)).put(bytes);}
 async readObject(id,digest,options){return (await this.objects(id)).get(digest,options);}
 async putObjectStream(id,input,options){return (await this.objects(id)).putStream(input,options);}
 async withObject(id,digest,fn){return (await this.objects(id)).withObject(digest,fn);}
 async verifyObject(id,digest){return (await this.objects(id)).verify(digest);}
 async listRecovery(id){return this.db.request(path.join(await this.recoveryDirectory(id),'recovery.sqlite'),'list',{collection:'recovery'});}
 async getProjectRecord(id,collection,key){return this.projectRequest(id,'record',{collection,id:key});}
 async putRecoveryObject(id,bytes){return new MaterialStore(path.join(await this.recoveryDirectory(id),'objects','sha256'),{maxBytes:256*1024*1024}).put(bytes);}
 async readRecoveryObject(id,digest,options){return new MaterialStore(path.join(await this.recoveryDirectory(id),'objects','sha256'),{maxBytes:256*1024*1024}).get(digest,options);}
 async recoveryObjects(id){return new MaterialStore(path.join(await this.recoveryDirectory(id),'objects','sha256'),{maxBytes:256*1024*1024});}
 async putRecoveryObjectStream(id,input,options){return (await this.recoveryObjects(id)).putStream(input,options);}
 async withRecoveryObject(id,digest,fn){return (await this.recoveryObjects(id)).withObject(digest,fn);}
 async promoteRecoveryObject(id,digest){
  try{return await this.withRecoveryObject(id,digest,file=>this.putObjectStream(id,file.stream(),{digest}));}
  catch(error){if(error.code!=='MATERIAL_MISSING')throw error;return this.verifyObject(id,digest);}
 }
 async closeLocalHandles(id){const p=await this.requireRegistered(id);await checkedClose(this.db,path.join(this.root,'instances',p.instanceId,'ui.sqlite'));}
 async closeProjectHandles(id){const p=await this.requireRegistered(id);await checkedClose(this.db,path.join(p.metadataRoot,'project.sqlite'));await this.closeLocalHandles(id);}
 async reconcileLifecycleStorage(id){const p=await this.requireRegistered(id),outcomes=[];for(const file of [this.catalog,path.join(this.root,'instances',p.instanceId,'ui.sqlite')])if(this.db.quarantined.has(file))outcomes.push({file,...await this.db.recover(file)});return outcomes;}
 async retry(id){this.assertActive(id);const p=await this.requireRegistered(id);await directoryIdentity(p.root,p.identity);if(!p.metadataIdentity)throw fail('PROJECT_METADATA_CONFLICT','元数据身份不可核验');await directoryIdentity(p.metadataRoot,p.metadataIdentity);const probe=new StorageDatabase();try{const manifest=await checkedMetadata(p.metadataRoot,probe);if(manifest.projectId!==p.id)throw fail('PROJECT_IDENTITY_CONFLICT','原项目身份不匹配');}finally{await probe.close();}const outcome=await this.db.recover(path.join(p.metadataRoot,'project.sqlite'));this.assertActive(id);this.unavailable.delete(id);return {available:true,projectId:id,operations:outcome.operations};}
}
