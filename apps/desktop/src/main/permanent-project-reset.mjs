import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ExecutionWorkspace} from '../agents/managed/execution-workspace.mjs';
import {str,gitRecords} from '../agents/managed/git-service.mjs';
import {platformPersistence} from '../platform/shared/persistence.mjs';
const fail=(code,message)=>Object.assign(Error(message),{code});
const same=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
const inside=(a,b)=>b===a||b.startsWith(a+path.sep);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function entity(file){try{const s=await fs.lstat(file);if(!s.isDirectory()||s.isSymbolicLink()||await fs.realpath(file)!==file)throw fail('PROJECT_IDENTITY_CONFLICT','清理目录不是原始真实目录');return {dev:String(s.dev),ino:String(s.ino)};}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function walk(root,visit){for(const entry of await fs.readdir(root,{withFileTypes:true})){const file=path.join(root,entry.name);const stat=await fs.lstat(file);if(stat.isSymbolicLink()||!stat.isDirectory()&&!stat.isFile())throw fail('PROJECT_METADATA_CONFLICT','清理范围含链接或特殊文件');if(stat.isDirectory())await walk(file,visit);else await visit(file);}}
export async function permanentResetScope(storage,id){
 const project=await storage.requireRegistered(id),all=await storage.list();
 if(project.removed)throw fail('PROJECT_IDENTITY_CONFLICT','不能重置退役身份');
 const related=all.filter(p=>p.root===project.root&&same(p.identity,project.identity)).sort((a,b)=>a.id.localeCompare(b.id));
 if(all.some(p=>p.root===project.root&&!same(p.identity,project.identity)))throw fail('PROJECT_IDENTITY_CONFLICT','历史根目录实体冲突');
 if(!same(await entity(project.root),project.identity))throw fail('PROJECT_IDENTITY_CONFLICT','根目录实体变化');
 await entity(storage.root);
 for(const name of ['instances','recovery']){const parent=path.join(storage.root,name);if(!await entity(parent))await fs.mkdir(parent,{mode:0o700});}
 const ids=new Set(related.map(p=>p.id)),directories=[];
 if(all.some(p=>!ids.has(p.id)&&related.some(owner=>owner.instanceId===p.instanceId)))throw fail('PROJECT_RESET_CONFLICT','本机实例仍被其他项目引用，禁止清除');
 const add=async directory=>{if(directories.some(d=>inside(d.path,directory)))return;const identity=await entity(directory),parentIdentity=await entity(path.dirname(directory));directories.push({path:directory,identity,parentIdentity});};
 await add(project.metadataRoot);
 for(const p of related){if(!/^[a-f0-9-]{36}$/i.test(p.instanceId))throw fail('INVALID_INSTANCE','本机身份无效');await add(await storage.localDirectory(p.id));await add(await storage.recoveryDirectory(p.id));}
 const initializations=(await storage.db.request(storage.catalog,'list',{collection:'initializations'})).filter(({value:v})=>v.root===project.root&&same(v.identity,project.identity));
 for(const {value:v} of initializations){for(const file of [v.backup])if(file){const expected=path.join(storage.root,'initialization',v.operationId,'source');if(file!==expected)throw fail('PROJECT_RESET_CONFLICT','初始化来源归属未知');await add(path.dirname(file));}for(const file of [v.temporary,v.swap])if(file&&await entity(file)){if(!inside(project.root,file)||path.dirname(file)!==project.root)throw fail('PROJECT_RESET_CONFLICT','初始化目录越界');await add(file);}}
 const initializationRoot=path.join(storage.root,'initialization');
 if(await entity(initializationRoot))for(const name of await fs.readdir(initializationRoot)){const directory=path.join(initializationRoot,name);await entity(directory);let source;try{source=JSON.parse(await fs.readFile(path.join(directory,'source','project.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}if(ids.has(source.projectId))await add(directory);}
 for(const name of await fs.readdir(project.root))if(/^\.nozeli-(source|reset|init)-/.test(name)){const file=path.join(project.root,name);if(directories.some(d=>d.path===file))continue;await entity(file);let manifest;try{manifest=JSON.parse(await fs.readFile(path.join(file,'project.json'),'utf8'));}catch{throw fail('PROJECT_RESET_CONFLICT','历史临时目录归属无法核验');}if(!ids.has(manifest.projectId))throw fail('PROJECT_RESET_CONFLICT','历史临时目录身份未知');await add(file);}
 const scope={projectId:id,root:project.root,identity:project.identity,relatedProjectIds:related.map(p=>p.id),projects:related,directories,initializations};return {...scope,digest:digest(scope)};
}
export async function permanentReset(storage,id,{operationId,expected,scope}){
 const prior=await storage.db.request(storage.catalog,'get',{collection:'permanent_resets',id:operationId});
 if(prior){if(prior.projectId!==id)throw fail('PROJECT_RESET_CONFLICT','操作身份冲突');if(prior.phase==='complete')return finishCompletedReset(storage,prior);return finishReset(storage,prior);}
 if(typeof operationId!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(operationId)||!scope||!expected)throw fail('INVALID_RESET_SCOPE','缺少永久清除授权范围');
 for(const old of scope.projects){const hold=storage.lifecycleHolds.get(old.id);if(hold?.action!=='reset-project'||hold.instanceId!==old.instanceId||hold.operationId!==operationId||!hold.localClosed||hold.needsStopCheck||hold.pendingCount)throw fail('PROJECT_LIFECYCLE_ACTIVE','永久清除必须先核验全部写入者');}
 const p=await storage.requireRegistered(id);
 const verify=async()=>{if(!same(await entity(p.root),expected.identity)||!same(await entity(p.metadataRoot),expected.metadataIdentity)||digest(JSON.parse(await fs.readFile(path.join(p.metadataRoot,'project.json'),'utf8')))!==digest(JSON.parse(expected.manifestBytes)))throw fail('PROJECT_IDENTITY_CONFLICT','确认后项目实体或清单变化');const current=await permanentResetScope(storage,id);if(current.digest!==scope.digest)throw fail('PROJECT_RESET_SCOPE_CHANGED','永久清除范围已变化，请重新确认');};
 await verify();
 const manifests=[];
 for(const d of scope.directories)if(d.identity)await walk(d.path,async file=>{if(path.basename(file).startsWith('execution-')&&file.endsWith('.json')){const m=JSON.parse(await fs.readFile(file,'utf8'));if(m.schema>=2&&m.branchRef){const owner=scope.projects.find(row=>inside(path.join(storage.root,'instances',row.instanceId),m.directory));if(!owner||m.repo!==p.root||!m.branchRef.startsWith('refs/heads/nozeli/work-'+m.workId+'-'))throw fail('PROJECT_RESET_CONFLICT','执行资源归属无法核验');manifests.push(m);}}});
 const unique=new Map();for(const m of manifests){const prior=unique.get(m.directory);const ownership=value=>[value.repo,value.commonDir,value.workerGitDir,value.gitPointer,value.branchRef,value.candidate?.commit||value.inputCommit||value.baseCommit];if(prior&&digest(ownership(prior))!==digest(ownership(m)))throw fail('PROJECT_RESET_CONFLICT','同一执行目录的历史归属证据冲突');unique.set(m.directory,m);}manifests.splice(0,manifests.length,...unique.values());
 const execution=new ExecutionWorkspace({root:'',content:p.root});
 for(const m of manifests){const exists=await entity(m.directory);if(exists)await execution.identity(m,{target:false});else {const ref=await str(m.repo,['rev-parse','--verify',m.branchRef]).catch(()=>null);if(ref&&ref!==(m.candidate?.commit||m.inputCommit||m.baseCommit))throw fail('WORKER_REF_CHANGED','执行分支已变化');}}
 const registered=await gitRecords(p.root,['worktree','list','--porcelain','-z']).catch(async error=>{if(await fs.lstat(path.join(p.root,'.git')).catch(()=>null))throw error;return [];});
 for(const record of registered)if(record.startsWith('worktree ')){const directory=record.slice(9);if(scope.projects.some(row=>inside(path.join(storage.root,'instances',row.instanceId),directory))&&!manifests.some(m=>m.directory===directory))throw fail('PROJECT_RESET_CONFLICT','存在未核验的执行worktree，未删除');}
 for(const row of scope.projects){await storage.closeProjectHandles(row.id);await storage.db.request(path.join(storage.root,'recovery',row.instanceId,'recovery.sqlite'),'close').then(result=>{if(result?.closed===false)throw fail('STORAGE_RESULT_UNKNOWN','恢复数据库关闭未确认');});}
 await verify();
 const receipt={schema:2,projectId:id,operationId,root:p.root,phase:'deleting',relatedProjectIds:scope.relatedProjectIds,paths:scope.directories.map(d=>d.path),scope,expected,manifests,newProjectId:randomUUID(),newInstanceId:randomUUID(),createdAt:new Date().toISOString()};
 await storage.db.request(storage.catalog,'put',{collection:'permanent_resets',id:operationId,value:receipt});
 return finishReset(storage,receipt);
}

// Only a previously confirmed, exact ownership snapshot is resumed. Missing
// old targets are successful deletion, never permission to widen the scope.
async function finishReset(storage,initial){
 let receipt=initial;
 const {scope,expected,operationId,projectId:id,newProjectId,newInstanceId}=receipt;
 if(receipt.schema!==2||!scope||!expected||!newProjectId||!newInstanceId)throw fail('PROJECT_RESET_OWNERSHIP_UNKNOWN','旧回执缺少清除归属证据，不能自动续做');
 const p=scope.projects.find(row=>row.id===id);
 if(!p||p.root!==receipt.root||scope.projectId!==id)throw fail('PROJECT_IDENTITY_CONFLICT','清除回执身份不符');
 for(const old of scope.projects){const hold=storage.lifecycleHolds.get(old.id);if(hold?.action!=='reset-project'||hold.instanceId!==old.instanceId||hold.operationId!==operationId||!hold.localClosed||hold.needsStopCheck||hold.pendingCount)throw fail('PROJECT_STOP_PENDING','原清除写入者尚未核验停稳');}
 const note=async patch=>{receipt={...receipt,...patch};await storage.db.request(storage.catalog,'put',{collection:'permanent_resets',id:operationId,value:receipt});};
 const checkRoot=async()=>{if(!same(await entity(p.root),scope.identity))throw fail('PROJECT_IDENTITY_CONFLICT','清除根目录实体已变化');};
 try{
  await checkRoot();
  for(const old of scope.projects){await storage.closeProjectHandles(old.id);await storage.db.request(path.join(storage.root,'recovery',old.instanceId,'recovery.sqlite'),'close').then(result=>{if(result?.closed===false)throw fail('STORAGE_RESULT_UNKNOWN','恢复数据库关闭未确认');});}
  if(receipt.phase==='deleting'){
   const execution=new ExecutionWorkspace({root:'',content:p.root});
   for(const m of receipt.manifests){await checkRoot();if(await entity(m.directory))await execution.identity(m,{target:false});await execution.removeOwned({...m,finishIntent:{decision:'discard'}});}
   const registered=await gitRecords(p.root,['worktree','list','--porcelain','-z']).catch(async error=>{if(await fs.lstat(path.join(p.root,'.git')).catch(()=>null))throw error;return [];});
   if(registered.some(record=>record.startsWith('worktree ')&&scope.projects.some(owner=>inside(path.join(storage.root,'instances',owner.instanceId),record.slice(9)))))throw fail('PROJECT_RESET_GIT_OWNERSHIP_UNCONFIRMED','执行目录已移除但Git登记仍存在；保留剩余范围，需先核验登记归属');
   for(const d of scope.directories){
    await checkRoot();if(!same(await entity(path.dirname(d.path)),d.parentIdentity))throw fail('PROJECT_IDENTITY_CONFLICT','清除父目录已变化');
    const current=await entity(d.path);
    if(current&&(!d.identity||!same(current,d.identity)))throw fail('PROJECT_IDENTITY_CONFLICT','清除实体已变化');
    if(current){await fs.rm(d.path,{recursive:true});await storage.constructor.syncResetDirectory(path.dirname(d.path));}
   }
   for(const {id:key} of scope.initializations)await storage.db.request(storage.catalog,'delete',{collection:'initializations',id:key});
   await note({phase:'cleared'});
  }
  if(receipt.phase==='cleared'){
   const current=await entity(p.metadataRoot);
   if(current&&!same(current,receipt.freshMetadataIdentity))throw fail('PROJECT_IDENTITY_CONFLICT','新元数据创建结果无法核验；保留目录');
   if(!current){await fs.mkdir(p.metadataRoot,{mode:0o700});await note({freshMetadataIdentity:await entity(p.metadataRoot)});}
   await walk(p.metadataRoot,async()=>{});
   await checkRoot();
   await fs.mkdir(path.join(p.metadataRoot,'objects','sha256'),{recursive:true});await fs.mkdir(path.join(p.metadataRoot,'memory','plantree'),{recursive:true});
   await fs.writeFile(path.join(p.metadataRoot,'memory','plantree','index.md'),'# Plan Tree\n');
   const dbfile=path.join(p.metadataRoot,'project.sqlite');await storage.db.request(dbfile,'put',{collection:'identity',id:'project',value:{schema:1,projectId:newProjectId}});await storage.db.request(dbfile,'close').then(result=>{if(result?.closed===false)throw fail('STORAGE_RESULT_UNKNOWN','新项目数据库关闭未确认');});
   const manifest=path.join(p.metadataRoot,'project.json');
   let existing;try{const stat=await fs.lstat(manifest);if(!stat.isFile()||stat.isSymbolicLink())throw fail('PROJECT_IDENTITY_CONFLICT','新身份清单实体异常');existing=JSON.parse(await fs.readFile(manifest,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
   if(existing&&(existing.projectId!==newProjectId||existing.operationId!==operationId))throw fail('PROJECT_IDENTITY_CONFLICT','新身份清单归属不符');
   if(!existing)await fs.writeFile(manifest,JSON.stringify({schema:1,projectId:newProjectId,operationId,lineage:null}),{flag:'wx',mode:0o600});
   // The manifest's file-data barrier goes through the shared persistence
   // contract: on macOS plain fsync is not a real drive barrier, so the
   // F_FULLFSYNC helper is required (and refuses loudly when missing) instead
   // of a silent weaker sync.
   const handle=await fs.open(manifest,'r');try{await platformPersistence.syncFileHandle(handle);}finally{await handle.close();}await storage.constructor.syncResetDirectory(p.metadataRoot);await storage.constructor.syncResetDirectory(p.root);
   await note({phase:'publishing'});
  }
  await checkRoot();if(!same(await entity(p.metadataRoot),receipt.freshMetadataIdentity))throw fail('PROJECT_IDENTITY_CONFLICT','新元数据实体已变化');
  const manifestStat=await fs.lstat(path.join(p.metadataRoot,'project.json'));
  if(!manifestStat.isFile()||manifestStat.isSymbolicLink())throw fail('PROJECT_IDENTITY_CONFLICT','发布清单不是普通文件');
  const publishedManifest=JSON.parse(await fs.readFile(path.join(p.metadataRoot,'project.json'),'utf8'));
  if(publishedManifest.projectId!==newProjectId||publishedManifest.operationId!==operationId)throw fail('PROJECT_IDENTITY_CONFLICT','发布清单身份不符');
  const fresh={id:newProjectId,instanceId:newInstanceId,semanticInitializationEligible:true,root:p.root,identity:p.identity,metadataRoot:p.metadataRoot,metadataIdentity:receipt.freshMetadataIdentity,lineage:null,name:p.name,openedAt:receipt.createdAt,lastOpenedAt:receipt.createdAt,removed:false};
  let freshHold=storage.lifecycleHolds.get(newProjectId);
  if(freshHold&&(freshHold.operationId!==operationId||freshHold.instanceId!==newInstanceId))throw fail('PROJECT_IDENTITY_CONFLICT','新实例围栏冲突');
  if(!freshHold)freshHold=storage.holdProject(newProjectId,{operationId,instanceId:newInstanceId,action:'reset-project',root:p.root});await storage.persistProjectHold(newProjectId,freshHold);
  await storage.db.request(storage.catalog,'put',{collection:'instances',id:newProjectId,value:fresh});storage.bindings.set(newProjectId,fresh);
  const result={operationId,projectId:id,action:'reset-project',complete:true,newProjectId,newInstanceId,permanentDelete:true,recoveryRetained:false,relatedProjectIds:scope.relatedProjectIds,retiredProjectIds:scope.relatedProjectIds};
  await note({phase:'complete',result,retiredInstances:scope.projects.map(old=>({id:old.id,instanceId:old.instanceId})),scope:undefined,expected:undefined,manifests:undefined});
  return await finishCompletedReset(storage,receipt);
 }catch(error){await note({blocked:true,error:{code:error.code||'ERROR',message:error.message}}).catch(()=>{});throw Object.assign(error,{resetPublished:true});}
}

// A completion receipt can precede the final catalog deletes. Every consumer
// of that receipt finishes these idempotent identity-checked deletes first.
async function finishCompletedReset(storage,receipt){
 const fresh=await storage.requireRegistered(receipt.result.newProjectId);
 if(fresh.instanceId!==receipt.result.newInstanceId||fresh.root!==receipt.root||!same(await entity(fresh.root),fresh.identity)||!same(await entity(fresh.metadataRoot),fresh.metadataIdentity))throw fail('PROJECT_IDENTITY_CONFLICT','完成回执与新实例实体不符');
 const manifest=path.join(fresh.metadataRoot,'project.json'),stat=await fs.lstat(manifest);
 if(!stat.isFile()||stat.isSymbolicLink())throw fail('PROJECT_IDENTITY_CONFLICT','完成回执清单实体不符');
 const value=JSON.parse(await fs.readFile(manifest,'utf8'));
 if(value.projectId!==fresh.id||value.operationId!==receipt.operationId)throw fail('PROJECT_IDENTITY_CONFLICT','完成回执清单归属不符');
 for(const directory of receipt.paths)if(directory!==fresh.metadataRoot&&await entity(directory))throw fail('PROJECT_RESET_OWNERSHIP_UNKNOWN','旧清除目录重新出现，保留隔离');
 for(const old of receipt.retiredInstances??[]){
  const registered=await storage.db.request(storage.catalog,'get',{collection:'instances',id:old.id});
  if(registered&&(registered.instanceId!==old.instanceId||registered.root!==receipt.root))throw fail('PROJECT_IDENTITY_CONFLICT','待退役登记已属于另一实例');
  const hold=storage.lifecycleHolds.get(old.id);
  if(registered&&(!hold||hold.operationId!==receipt.operationId||hold.instanceId!==old.instanceId||hold.action!=='reset-project'||hold.pendingCount))throw fail('PROJECT_STOP_PENDING','待退役登记缺少原清除围栏或仍有操作');
 }
 for(const old of receipt.retiredInstances??[]){await storage.db.request(storage.catalog,'delete',{collection:'instances',id:old.id});storage.bindings.delete(old.id);storage.generations.delete(old.id);storage.unavailable.delete(old.id);}
 return receipt.result;
}
