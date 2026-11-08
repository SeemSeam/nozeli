import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {boundedProjectWait} from '../domain/project-lifecycle-wait.mjs';

const fail = (code, message) => Object.assign(new Error(message), {code});
const inside = (parent, child) => {const relative=path.relative(parent,child);return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative));};
const identity = stat => ({dev:String(stat.dev),ino:String(stat.ino)});
const same = (a,b) => a?.dev===b?.dev && a?.ino===b?.ino;
const demoChangesDigest=changes=>createHash('sha256').update(JSON.stringify(changes)).digest('hex');
async function statOrMissing(directory) {try{return await fs.lstat(directory);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function directorySnapshot(directory) {
  const stat=await statOrMissing(directory);
  if(!stat)return null;
  if(!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory)!==directory)throw fail('PROJECT_IDENTITY_CONFLICT','目录实体或链接已变化，原确认已失效。');
  return identity(stat);
}

// Confirmation grants one attempt, not permission to replay destructive work.
export class ProjectLifecycle {
  constructor({host,workspace,managed,trashItem,beforeStop=async()=>{},reconcileManaged,protectedRoots=[],timeoutMs=15000}) {
    Object.assign(this,{host,workspace,managed,trashItem,beforeStop,reconcileManaged,timeoutMs});
    this.protectedRoots=[os.homedir(),host.storage.root,...protectedRoots].map(root=>path.resolve(root));
    this.tokens=new Map();this.operations=new Map();this.removeAdmissions=new Map();this.availability=new Map();
  }
  async localScope(project) {
    if(typeof project.instanceId!=='string' || !/^[a-f0-9-]{36}$/i.test(project.instanceId))throw fail('INVALID_INSTANCE','本机项目身份无效。');
    const directory=await this.host.storage.localDirectory(project.id);
    const records=await this.host.storage.listLocalViews(project.id);
    const parent=path.dirname(directory),parentStat=await directorySnapshot(parent);
    return {directory,parent,parentIdentity:parentStat,identity:await directorySnapshot(directory),records:records.map(row=>row.id)};
  }
  async checkDelete(project) {
    const root=path.resolve(project.root);
    if(root!==project.root || root===path.parse(root).root)throw fail('PROJECT_DELETE_PROTECTED','禁止删除文件系统根目录。');
    for(const protectedRoot of this.protectedRoots)if(inside(root,protectedRoot) || protectedRoot!==path.resolve(os.homedir()) && inside(protectedRoot,root))throw fail('PROJECT_DELETE_PROTECTED','删除范围包含用户目录、应用数据或受保护开发目录。');
    for(const other of await this.host.storage.list())if(other.id!==project.id && inside(root,path.resolve(other.root)))throw fail('PROJECT_DELETE_NESTED','删除范围包含其他登记项目，不能整体删除。');
    const current=await directorySnapshot(root);
    if(!current)return {root,identity:null,manifestDigest:null};
    const gitEntry=await statOrMissing(path.join(root,'.git'));
    if(gitEntry && (!gitEntry.isDirectory() || gitEntry.isSymbolicLink()))throw fail('PROJECT_DELETE_WORKTREE','项目使用外部 Git/worktree 元数据，需先解除执行现场依赖。');
    if(gitEntry && await statOrMissing(path.join(root,'.git','worktrees')))throw fail('PROJECT_DELETE_WORKTREE','项目仍有关联 Git worktree，不能删除其共同仓库。');
    if(!same(current,project.identity))throw fail('PROJECT_IDENTITY_CONFLICT','原路径已出现不同目录，不能删除。');
    const metadata=path.join(root,'.nozeli');
    if(!await directorySnapshot(metadata))throw fail('PROJECT_METADATA_MISSING','项目元数据不可用，不能核验删除范围。');
    const manifestPath=path.join(metadata,'project.json'),manifestStat=await fs.lstat(manifestPath);
    if(!manifestStat.isFile() || manifestStat.isSymbolicLink())throw fail('PROJECT_IDENTITY_CONFLICT','项目身份清单不是普通文件。');
    const bytes=await fs.readFile(manifestPath),manifest=JSON.parse(bytes.toString('utf8'));
    if(manifest.schema!==1 || manifest.projectId!==project.id)throw fail('PROJECT_IDENTITY_CONFLICT','项目身份清单不匹配。');
    return {root,identity:current,manifestDigest:createHash('sha256').update(bytes).digest('hex')};
  }
  // Reset never deletes source files: it verifies the exact registered root
  // and metadata entities so only the confirmed project can be re-identified.
  async checkReset(project) {
    const root=path.resolve(project.root);
    if(root!==project.root || root===path.parse(root).root)throw fail('PROJECT_RESET_PROTECTED','禁止重置文件系统根目录。');
    const metadata=path.join(root,'.nozeli');
    // Reset replaces only this project's metadata tree and never deletes
    // source files, so the whole-directory delete bans on home or development
    // folders do not apply. It must still never publish or archive inside
    // application data, protected install/config roots, or the project itself.
    const storageRoot=path.resolve(this.host.storage.root);
    for(const protectedRoot of this.protectedRoots){
      if(protectedRoot===path.resolve(os.homedir()))continue;
      if(inside(metadata,protectedRoot)||inside(protectedRoot,metadata))throw fail('PROJECT_RESET_PROTECTED','重置元数据与应用数据或受保护目录重叠。');
    }
    if(inside(storageRoot,root)||inside(root,storageRoot))throw fail('PROJECT_RESET_PROTECTED','应用数据目录与项目目录重叠，不能重置。');
    const current=await directorySnapshot(root);
    if(!current)throw fail('PROJECT_ROOT_MISSING','原项目目录不可用；无法核验重置范围。');
    if(!same(current,project.identity))throw fail('PROJECT_IDENTITY_CONFLICT','原路径已出现不同目录，不能重置。');
    if(!project.metadataIdentity)throw fail('PROJECT_METADATA_CONFLICT','项目元数据身份不可核验，不能重置。');
    const metadataStat=await directorySnapshot(metadata);
    if(!metadataStat)throw fail('PROJECT_METADATA_MISSING','项目元数据不可用，不能核验重置范围。');
    if(!same(metadataStat,project.metadataIdentity))throw fail('PROJECT_IDENTITY_CONFLICT','项目元数据实体已变化，不能重置。');
    const manifestPath=path.join(metadata,'project.json'),manifestStat=await fs.lstat(manifestPath);
    if(!manifestStat.isFile() || manifestStat.isSymbolicLink())throw fail('PROJECT_IDENTITY_CONFLICT','项目身份清单不是普通文件。');
    const bytes=await fs.readFile(manifestPath),manifest=JSON.parse(bytes.toString('utf8'));
    if(manifest.schema!==1 || manifest.projectId!==project.id)throw fail('PROJECT_IDENTITY_CONFLICT','项目身份清单不匹配。');
    return {root,identity:current,metadataRoot:metadata,metadataIdentity:metadataStat,manifestDigest:createHash('sha256').update(bytes).digest('hex'),manifestBytes:bytes.toString('utf8')};
  }
  async preview({projectId,action}) {
    if(!['clean-local','delete-project','reset-project'].includes(action))throw fail('INVALID_LIFECYCLE_ACTION','未知项目清理操作。');
    if(this.operations.has(projectId))throw fail('PROJECT_LIFECYCLE_ACTIVE','该项目已有生命周期操作。');
    if(action!=='reset-project')this.host.storage.assertActive(projectId);
    const project=await this.host.requireRegisteredProject(projectId);
    if(action==='reset-project')await this.prepareResetAdmission(projectId,project);
    const local=action==='reset-project'?null:await this.localScope(project);
    const demoChanges=this.host.guidedDemo?.isDemo(projectId)?await this.host.guidedDemo.guardLifecycle(projectId,{allowChanged:true}):null;
    const source=action==='delete-project'?await this.checkDelete(project):action==='reset-project'?await this.checkReset(project):null;
    const resetScope=action==='reset-project'?await this.host.storage.resetScope(projectId):null;
    const token=randomUUID(),operationId=randomUUID(),expiresAt=Date.now()+300000;
    const confirmation={token,operationId,projectId,instanceId:project.instanceId,action,root:project.root,
      identity:source?.identity??project.identity,source,local,expiresAt,
      removeDirectories:action==='delete-project'?[project.root]:[],
      removeFiles:[],removeRecords:action==='clean-local'?local.records:[],
      recoveryRetained:true,sessionsRetained:true,permanentDelete:false,accountsAffected:false,
      ...(resetScope?{newInstance:true,resetScope,relatedProjectIds:resetScope.relatedProjectIds,removeDirectories:resetScope.directories.map(d=>d.path),directoryCount:resetScope.directories.length,projectCount:resetScope.relatedProjectIds.length,recoveryRetained:false,sessionsRetained:false,permanentDelete:true}:{})};
    if(demoChanges){confirmation.demoChanges=demoChanges;confirmation.demoChangesDigest=demoChangesDigest(demoChanges);confirmation.preserveByDefault=demoChanges.length>0;}
    this.tokens.set(token,confirmation);
    return structuredClone(confirmation);
  }
  async journal(projectId,record) {
    if(record.action==='reset-project'){const {schema,projectId,operationId,action,root,phase,failedPhase,error,result,updatedAt}=record;await this.host.storage.db.request(this.host.storage.catalog,'put',{collection:'reset_lifecycle',id:record.operationId,value:{schema,projectId,operationId,action,root,phase,failedPhase,error,result,updatedAt}});return;}
    await this.host.storage.putRecovery(projectId,'lifecycle:'+record.operationId,record);
  }
  async execute({token,allowDemoChanges=false,confirmPermanentDelete=false}) {
    const confirmation=this.tokens.get(token);
    if(!confirmation || confirmation.expiresAt<Date.now())throw fail('LIFECYCLE_CONFIRMATION_EXPIRED','确认已失效，请重新查看范围。');
    if(confirmation.action==='reset-project'&&confirmPermanentDelete!==true)throw fail('PERMANENT_DELETE_CONFIRMATION_REQUIRED','永久清除需要明确勾选不可恢复确认。');
    this.tokens.delete(token);
    if(this.operations.has(confirmation.projectId))throw fail('PROJECT_LIFECYCLE_ACTIVE','该项目已有生命周期操作。');
    return this.run({...confirmation,allowDemoChanges:allowDemoChanges===true&&confirmation.preserveByDefault===true});
  }
  async prepareResetAdmission(projectId,project) {
    const hold=this.host.storage.lifecycleHolds.get(projectId);
    if(!hold)return;
    if(hold.instanceId!==project.instanceId)throw fail('PROJECT_IDENTITY_CONFLICT','旧围栏属于另一实例。');
    if(this.operations.has(projectId)||hold.pendingCount||this.managed.projectStops?.has(projectId))throw fail('PROJECT_STOP_PENDING','旧操作仍在运行，不能接管重置。');
    const receipt=await this.host.storage.db.request(this.host.storage.catalog,'get',{collection:'permanent_resets',id:hold.operationId});
    if(receipt&&receipt.phase!=='complete')throw fail('PROJECT_RESET_INCOMPLETE','已有确认的永久清除未完成，请先打开项目触发一次安全核查。');
    // Preview observes only. It neither stops writers nor releases the fence.
  }
  async ensureProjectAvailable(projectId) {
    await this.host.storage.ready();
    const hold=this.host.storage.lifecycleHolds.get(projectId);
    if(!hold)return {available:true,projectId};
    const key=hold.action==='reset-project'?'reset:'+hold.operationId:projectId+':'+hold.operationId;
    if(this.availability.has(key))return this.availability.get(key);
    const attempt=(async()=>{
      if(this.operations.has(projectId)||hold.pendingCount||this.managed.projectStops?.has(projectId))throw fail('PROJECT_STOP_PENDING','生命周期操作仍在运行。');
      const receipt=await this.host.storage.db.request(this.host.storage.catalog,'get',{collection:'permanent_resets',id:hold.operationId});
      if(receipt&&receipt.phase!=='complete') {
        if(receipt.projectId!==projectId&&!receipt.relatedProjectIds?.includes(projectId)&&receipt.newProjectId!==projectId)throw fail('PROJECT_IDENTITY_CONFLICT','永久清除回执身份不符。');
        const result=await this.resumeReset(receipt);
        return {available:true,projectId:result.newProjectId,result};
      }
      if(!receipt&&hold.action!=='reset-project'){
        const record=await this.host.storage.getRecovery(projectId,'lifecycle:'+hold.operationId);
        if(!['remove','clean-local'].includes(hold.action)||record&&record.phase!=='complete'&&record.phase!=='prepared'&&record.failedPhase!=='prepared')throw fail('PROJECT_RECOVERY_UNSAFE','原操作可能已有业务或删除效果；不会自动重放，请明确重置或核查外部状态。');
      }
      const observation=await this.reconcile({projectId,operationId:hold.operationId});
      if(hold.action==='reset-project'&&this.host.storage.lifecycleHolds.get(projectId)===hold)throw Object.assign(fail(observation.error?.code??'PROJECT_RESET_CONFIRMATION_REQUIRED',observation.error?.message??'原重置尚未取得可续做的清除回执；所有资料保留，请重新确认完全重置。'),{details:observation.error?.details,operationId:hold.operationId});
      this.host.storage.assertActive(projectId);
      return {available:true,projectId:receipt?.result?.newProjectId??projectId};
    })();
    this.availability.set(key,attempt);return attempt;
  }
  async resumeReset(receipt) {
    if(!receipt.scope||!receipt.expected)throw fail('PROJECT_RESET_OWNERSHIP_UNKNOWN','旧清除回执缺少原确认实体证据，不能继续删除。');
    const held=[];
    for(const project of receipt.scope.projects){
      let hold=this.host.storage.lifecycleHolds.get(project.id);
      if(!hold||hold.instanceId!==project.instanceId||hold.operationId!==receipt.operationId||hold.action!=='reset-project')throw fail('PROJECT_IDENTITY_CONFLICT','永久清除围栏与原实例不符。');
      if(this.operations.has(project.id)||hold.pendingCount||this.managed.projectStops?.has(project.id))throw fail('PROJECT_STOP_PENDING','清除写入者仍在运行。');
      hold.recoveringReset=true;
      try{await this.stopHeldProject(project.id,hold,{discardState:true});}finally{hold.recoveringReset=false;}
      held.push([project.id,hold]);
    }
    const result=await this.host.storage.resetProject(receipt.projectId,{operationId:receipt.operationId,expected:receipt.expected,scope:receipt.scope});
    const fresh=this.host.storage.lifecycleHolds.get(result.newProjectId);if(fresh)held.push([result.newProjectId,fresh]);
    for(const [id,hold] of held)await this.host.storage.releaseProject(id,hold);
    return result;
  }
  async stopHeldProject(projectId,hold,{discardState=false}={}) {
    if(hold.pendingCount||this.managed.projectStops?.has(projectId))throw fail('PROJECT_STOP_PENDING','原操作尚未停稳。');
    hold.needsStopCheck=true;hold.pendingCount=(hold.pendingCount??0)+1;
    const stopping=this.host.storage.withLifecycleOwner(projectId,hold,async()=>{
      await this.beforeStop(projectId);
      const stopped=await this.managed.stopProject(projectId,{lifecycleHold:hold,discardState});
      await this.host.storage.drainProjectOperations(projectId);
      if(stopped?.confirmationComplete!==true)throw fail('PI_EXIT_UNCONFIRMED','项目写入者停稳未确认。');
      await this.workspace.closeProject(projectId,{operationId:hold.operationId,strictStop:true,discardState});
      if(discardState){await this.host.storage.closeProjectHandles(projectId);this.host.storage.sealLocal(projectId,hold);}
      hold.needsStopCheck=false;
    });
    stopping.then(()=>{hold.pendingCount--;},()=>{hold.pendingCount--;});
    return boundedProjectWait(stopping,{timeoutMs:this.timeoutMs});
  }
  async run(confirmation) {
    const {projectId,operationId,instanceId,action}=confirmation;
    const previous=new Map();
    if(action==='reset-project')for(const id of confirmation.resetScope.relatedProjectIds){
      const old=this.host.storage.lifecycleHolds.get(id);if(!old)continue;
      await this.prepareResetAdmission(id,confirmation.resetScope.projects.find(p=>p.id===id));previous.set(id,old);
    }
    if(this.operations.has(projectId))throw fail('PROJECT_LIFECYCLE_ACTIVE','项目生命周期操作仍在运行。');
    const held=[];
    try{
      // No await between replacing the old fence and installing the new one.
      // The confirmed reset owner, not the old remove owner, stops/discards.
      for(const id of confirmation.resetScope?.relatedProjectIds??[projectId]){
        const old=previous.get(id);
        if(old){if(this.host.storage.lifecycleHolds.get(id)!==old||old.pendingCount||this.managed.projectStops?.has(id))throw fail('PROJECT_STOP_PENDING','原围栏或停稳状态已变化。');this.host.storage.lifecycleHolds.delete(id);}
        const p=confirmation.resetScope?.projects.find(p=>p.id===id),hold=this.host.storage.holdProject(id,{operationId,instanceId:p?.instanceId??instanceId,action,root:confirmation.root});hold.pendingCount=0;held.push([id,hold]);
      }
    }catch(error){for(const [id,hold] of held)if(this.host.storage.lifecycleHolds.get(id)===hold){if(previous.has(id))this.host.storage.lifecycleHolds.set(id,previous.get(id));else this.host.storage.lifecycleHolds.delete(id);}throw error;}
    const hold=held.find(([id])=>id===projectId)[1];confirmation.relatedHolds=held;
    const operation=(async()=>{for(const [id,h] of held)await this.host.storage.persistProjectHold(id,h);return this.host.storage.withLifecycleOwner(projectId,hold,()=>this.apply(confirmation,hold));})();this.operations.set(projectId,operation);
    let completed=false;
    try{const result=await operation;completed=true;return result;}catch(error){if(action==='reset-project'||['PROJECT_STOP_TIMEOUT','OMP_EXIT_UNCONFIRMED','PI_EXIT_UNCONFIRMED','STORAGE_RESULT_UNKNOWN'].includes(error.code))for(const [,h] of held)h.needsStopCheck=true;throw error;}finally{if(this.operations.get(projectId)===operation)this.operations.delete(projectId);for(const [id,h] of held)if(!h.pendingCount&&!h.needsStopCheck&&(action!=='reset-project'||completed))await this.host.storage.releaseProject(id,h);}
  }
  async removeProject(projectId,{operationId}={}) {
    if(typeof operationId!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(operationId))throw fail('INVALID_OPERATION_ID');
    // Remove admissions are serialized per project so a second click can
    // neither reconcile nor run concurrently with the first.
    const previous=this.removeAdmissions.get(projectId)??Promise.resolve();
    const admission=previous.catch(()=>{}).then(()=>this.admitRemove(projectId,operationId));
    this.removeAdmissions.set(projectId,admission);
    try{return await admission;}finally{if(this.removeAdmissions.get(projectId)===admission)this.removeAdmissions.delete(projectId);}
  }
  async admitRemove(projectId,operationId) {
    const receipt=await this.host.storage.getRecovery(projectId,'lifecycle:remove:'+operationId);
    if(receipt?.complete)return receipt.result;
    const project=await this.host.requireRegisteredProject(projectId);
    await this.retireHeldRemove(projectId,project);
    // A serialized second click has no open surface left to save. Record its
    // removal receipt without reopening or flushing the already retired id.
    if(project.removed)return this.host.storage.remove(projectId,{operationId});
    return this.run({projectId,operationId,instanceId:project.instanceId,action:'remove',root:project.root});
  }
  // A historical remove hold may be retired only by an explicit new remove
  // click on the same project/instance with nothing in flight, and only via
  // the observation-only reconcile proving the writers stopped first. Any
  // other hold action, unknown project, mismatched instance, active operation
  // or pending stop keeps the project locked. No unconditional release, no
  // lock or recovery-record deletion, no replay of pending work.
  async retireHeldRemove(projectId,project) {
    const hold=this.host.storage.lifecycleHolds.get(projectId);
    if(!hold)return;
    if(hold.action!=='remove')throw fail('PROJECT_LIFECYCLE_ACTIVE',`项目仍有 ${hold.action} 生命周期操作待核查（${hold.operationId}）；请先在恢复中心核验。`);
    if(hold.instanceId!==project.instanceId)throw fail('PROJECT_IDENTITY_CONFLICT','待核查移除操作属于另一项目实例；请先在恢复中心核验。');
    if(this.operations.has(projectId))throw fail('PROJECT_LIFECYCLE_ACTIVE','项目生命周期操作仍在进行，本次移除未放行。');
    if(hold.pendingCount||this.managed.projectStops?.has(projectId))throw fail('PROJECT_STOP_PENDING','原停稳操作仍未结束，本次移除未放行。');
    const record=await this.host.storage.getRecovery(projectId,'lifecycle:'+hold.operationId);
    if(record&&(record.projectId!==projectId||record.operationId!==hold.operationId||record.action!=='remove'||(record.instanceId!==undefined&&record.instanceId!==project.instanceId)))throw fail('PROJECT_IDENTITY_CONFLICT','待核查日志与原移除操作不匹配；保留项目及恢复记录。');
    // Re-verify after the recovery read: anything that started or changed
    // state during that await refuses instead of racing into reconcile.
    if(this.host.storage.lifecycleHolds.get(projectId)!==hold||this.operations.has(projectId))throw fail('PROJECT_LIFECYCLE_ACTIVE','原移除状态在核验期间发生变化；本次移除未放行。');
    if(hold.pendingCount||this.managed.projectStops?.has(projectId))throw fail('PROJECT_STOP_PENDING','原停稳操作仍未结束；本次移除未放行。');
    await this.reconcile({projectId,operationId:hold.operationId});
    if(this.host.storage.lifecycleHolds.get(projectId))throw fail('PROJECT_LIFECYCLE_ACTIVE','项目已进入新的生命周期操作，本次移除未放行。');
  }
  async settleManaged({projectId,pendingId,requestKey,confirmed}) {
    if(confirmed!==true||typeof requestKey!=='string'||requestKey.length<8||typeof pendingId!=='string')throw fail('INVALID_RECOVERY_CONFIRMATION','需要明确确认及稳定的结算请求身份。');
    const project=await this.host.requireRegisteredProject(projectId);
    return this.run({projectId,instanceId:project.instanceId,root:project.root,action:'settle-managed',operationId:'settle:'+requestKey,pendingId,requestKey,confirmed});
  }
  async apply(confirmation,hold) {
    const {projectId,operationId,action}=confirmation;
    let record={schema:1,...confirmation,relatedHolds:undefined,token:undefined,phase:'prepared',updatedAt:new Date().toISOString()};
    const checkpoint=async patch=>{record={...record,...patch,updatedAt:new Date().toISOString()};await this.journal(projectId,record);};
    const stage=async promise=>{hold.pendingCount++;const pending=Promise.resolve(promise);pending.then(()=>{hold.pendingCount--;},()=>{hold.pendingCount--;});return boundedProjectWait(pending,{timeoutMs:this.timeoutMs});};
    // The first journal commit also proves the catalog/recovery binding is readable.
    await this.host.storage.list();await checkpoint({});
    try {
      const project=await this.host.requireRegisteredProject(projectId);
      if(project.instanceId!==confirmation.instanceId || project.root!==confirmation.root)throw fail('PROJECT_IDENTITY_CONFLICT','本机绑定已变化。');
      if(this.host.guidedDemo?.isDemo(projectId)){
        const changes=await this.host.guidedDemo.guardLifecycle(projectId,{allowChanged:action!=='delete-project'||confirmation.allowDemoChanges===true,allowPending:action==='remove'});
        if(action==='delete-project'){
          if(changes.some(change=>change.kind==='uninspected'))throw fail('DEMO_INSPECTION_INCOMPLETE','示例目录未完整核验；保留所有文件，请先检查或导出。');
          if(demoChangesDigest(changes)!==confirmation.demoChangesDigest)throw fail('DEMO_CONTENT_CHANGED','确认后示例内容发生变化，未删除；请重新查看范围。');
        }
      }
      if(action==='delete-project')this.matchSource(confirmation.source,await this.checkDelete(project));
      if(action==='reset-project')this.matchSource(confirmation.source,await this.checkReset(project));
      for(const [id,h] of confirmation.relatedHolds??[[projectId,hold]])await this.host.storage.withLifecycleOwner(id,h,async()=>{
        h.needsStopCheck=true;
        const [,stopped]=await Promise.all([stage(Promise.resolve().then(()=>this.beforeStop(id))),stage(Promise.resolve().then(()=>this.managed.stopProject(id,{lifecycleHold:h,discardState:action==='reset-project'}))),stage(this.host.storage.drainProjectOperations(id))]);
        if(stopped?.confirmationComplete!==true)throw fail('PI_EXIT_UNCONFIRMED','项目写入者停稳未确认，保留所有目录。');
        await stage(this.workspace.closeProject(id,{operationId,strictStop:action==='reset-project',discardState:action==='reset-project'}));h.needsStopCheck=false;
      });
      const settled=await this.host.storage.getRecovery(projectId,'lifecycle:settle-managed:'+operationId);
      if(action==='settle-managed'&&settled?.complete){await checkpoint({phase:'complete',result:settled.result});return settled.result;}
      if(action==='remove'){const result=await this.host.storage.remove(projectId,{operationId});await checkpoint({phase:'complete',removed:true});await this.host.guidedDemo?.recordLifecycle(projectId,{...result,action,removed:true});return result;}
      if(action==='settle-managed'){const result=await stage(this.host.storage.withLifecycleOwner(projectId,hold,()=>this.reconcileManaged(projectId,confirmation)));await checkpoint({phase:'complete',result});await this.host.storage.putRecovery(projectId,'lifecycle:settle-managed:'+operationId,{projectId,operationId,pendingId:confirmation.pendingId,requestKey:confirmation.requestKey,complete:true,result}).catch(()=>{});if(!hold.pendingCount)this.host.storage.releaseProject(projectId,hold);return result;}
      this.host.storage.sealLocal(projectId,hold);
      if(action==='clean-local') {
        const local=await this.localScope(project);
        if(local.directory!==confirmation.local.directory || !sameNullable(local.identity,confirmation.local.identity) || !sameNullable(local.parentIdentity,confirmation.local.parentIdentity))throw fail('PROJECT_IDENTITY_CONFLICT','本机清理目录实体已变化。');
        await checkpoint({phase:'clean-prepared'});
        const cleaned=await this.host.storage.withLifecycleOwner(projectId,hold,()=>this.host.storage.clearLocalViews(projectId,{ids:confirmation.removeRecords,operationId}));
        this.workspace.layouts?.delete(projectId);
        await checkpoint({phase:'complete',cleaned:true});
        const cleanedResult={operationId,projectId,action,complete:true,recoveryRetained:true,...cleaned};
        await this.host.guidedDemo?.recordLifecycle(projectId,{operationId,projectId,action,complete:true,removed:false});
        return cleanedResult;
      }
      if(action==='reset-project') {
        await checkpoint({phase:'reset-prepared'});
        const current=await this.host.storage.resetScope(projectId);
        if(current.digest!==confirmation.resetScope.digest)throw fail('PROJECT_RESET_SCOPE_CHANGED','清除范围已变化，未删除。');
        for(const [id,h] of confirmation.relatedHolds){await this.host.storage.withLifecycleOwner(id,h,()=>this.host.storage.closeProjectHandles(id));this.host.storage.sealLocal(id,h);}
        const result=await this.host.storage.resetProject(projectId,{operationId,expected:confirmation.source,scope:confirmation.resetScope});
        const freshHold=this.host.storage.lifecycleHolds.get(result.newProjectId);if(freshHold)confirmation.relatedHolds.push([result.newProjectId,freshHold]);
        for(const id of confirmation.resetScope.relatedProjectIds)this.workspace.layouts?.delete(id);
        await checkpoint({phase:'complete',result});
        return result;
      }
      await this.host.storage.closeProjectHandles(projectId);
      const source=await this.checkDelete(project);this.matchSource(confirmation.source,source);
      await checkpoint({phase:'trash-prepared'});
      if(source.identity) {
        // The OS trash call and the source-gone verification share one bounded
        // stage: an unresponsive trash API must end in needs-attention with
        // the outcome unknown, never an unbounded lifecycle operation.
        await stage((async()=>{
          await this.trashItem(project.root);
          const remaining=await directorySnapshot(project.root);
          if(remaining)throw fail(same(remaining,source.identity)?'PROJECT_TRASH_INCOMPLETE':'PROJECT_IDENTITY_CONFLICT','原路径仍存在或已出现新实体；没有再次删除。');
        })());
        await checkpoint({phase:'source-gone',trashed:true});
      } else await checkpoint({phase:'source-gone',trashed:false,alreadyUnavailable:true});
      await this.host.storage.remove(projectId);
      await checkpoint({phase:'complete',removed:true});
      await this.host.guidedDemo?.recordLifecycle(projectId,{operationId,projectId,action,complete:true,removed:true,trashed:record.trashed});
      return {operationId,projectId,action,complete:true,trashed:record.trashed,alreadyUnavailable:record.alreadyUnavailable===true,recoveryRetained:true};
    } catch(error) {
      await checkpoint({phase:'needs-attention',failedPhase:record.phase,error:{code:error.code||'ERROR',message:error.message,details:error.details}}).catch(()=>{});
      throw error;
    }
  }
  matchSource(expected,current) {
    if(expected.root!==current.root || !sameNullable(expected.identity,current.identity) || expected.manifestDigest!==current.manifestDigest)throw fail('PROJECT_IDENTITY_CONFLICT','目录实体或项目清单已变化，原确认已失效。');
  }
  async reconcile({projectId,operationId}) {
    const permanent=await this.host.storage.db.request(this.host.storage.catalog,'get',{collection:'permanent_resets',id:operationId});
    const resetJournal=await this.host.storage.db.request(this.host.storage.catalog,'get',{collection:'reset_lifecycle',id:operationId});
    if(permanent||resetJournal){
      const record=permanent??resetJournal;if(record.projectId!==projectId&&!permanent?.relatedProjectIds?.includes(projectId)&&permanent?.result?.newProjectId!==projectId)throw fail('PROJECT_IDENTITY_CONFLICT','操作身份不匹配');
      if(permanent?.phase==='complete'){
        const fresh=await this.host.storage.requireRegistered(permanent.result.newProjectId);
        const root=await directorySnapshot(fresh.root),metadata=await directorySnapshot(fresh.metadataRoot);
        if(!same(root,fresh.identity)||!same(metadata,fresh.metadataIdentity)||JSON.parse(await fs.readFile(path.join(fresh.metadataRoot,'project.json'),'utf8')).projectId!==fresh.id)throw fail('PROJECT_IDENTITY_CONFLICT','新身份与完成回执不符');
        for(const directory of permanent.paths)if(directory!==fresh.metadataRoot&&await statOrMissing(directory))throw fail('PROJECT_RESET_OWNERSHIP_UNKNOWN','清除范围重新出现目录，未解除隔离');
        for(const [id,hold] of this.host.storage.lifecycleHolds)if(hold.operationId===operationId){
          const owner=id===fresh.id?fresh:permanent.retiredInstances?.find(row=>row.id===id);
          if(!owner||hold.instanceId!==owner.instanceId||hold.action!=='reset-project')throw fail('PROJECT_IDENTITY_CONFLICT','清除围栏归属不符');
          if(this.operations.has(id)||hold.pendingCount||this.managed.projectStops?.has(id))throw fail('PROJECT_STOP_PENDING','仍有操作未停稳');
        }
        await this.host.storage.resetProject(permanent.projectId,{operationId});
        for(const [id,hold] of this.host.storage.lifecycleHolds)if(hold.operationId===operationId)await this.host.storage.releaseProject(id,hold);
      }
      return {...record,observationOnly:true,blocked:record.phase!=='complete'};
    }
    const resetHold=this.host.storage.lifecycleHolds.get(projectId);
    if(resetHold?.action==='reset-project'&&resetHold.operationId===operationId)return {projectId,operationId,action:'reset-project',phase:'needs-attention',blocked:true,observationOnly:true};
    await this.host.storage.reconcileLifecycleStorage(projectId);
    let record=await this.host.storage.getRecovery(projectId,'lifecycle:'+operationId);
    if(!record){const hold=this.host.storage.lifecycleHolds.get(projectId);if(hold?.operationId!==operationId)throw fail('LIFECYCLE_OPERATION_NOT_FOUND','操作记录不存在。');const project=await this.host.requireRegisteredProject(projectId);record={schema:1,projectId,operationId,action:hold.action,root:project.root,local:await this.localScope(project),source:{root:project.root,identity:project.identity},phase:'needs-attention'};}
    // Observation only: never resume trash, rm, process termination or removal.
    const project=await this.host.requireRegisteredProject(projectId);
    const hold=this.host.storage.lifecycleHolds.get(projectId);
    if(hold&&(hold.instanceId!==project.instanceId||hold.operationId!==operationId||record.projectId!==projectId||record.operationId!==operationId||record.action!==hold.action||record.instanceId!==undefined&&record.instanceId!==project.instanceId))throw fail('PROJECT_IDENTITY_CONFLICT','生命周期围栏、日志与当前实例不一致。');
    if(this.operations.has(projectId))throw fail('PROJECT_LIFECYCLE_ACTIVE','生命周期操作仍在运行。');
    if(record.phase==='complete'&&!hold)return record;
    if(hold?.operationId===operationId){
      if(hold.pendingCount||this.managed.projectStops?.has(projectId))throw fail('PROJECT_STOP_PENDING','原停稳操作仍未结束，未重新开放准入。');
      if(hold.needsStopCheck){
        hold.pendingCount=(hold.pendingCount??0)+1;
        const stopping=this.host.storage.withLifecycleOwner(projectId,hold,async()=>{
          const stopped=await this.managed.stopProject(projectId,{lifecycleHold:hold});
          await this.host.storage.drainProjectOperations(projectId);return stopped;
        });
        stopping.then(()=>{hold.pendingCount--;},()=>{hold.pendingCount--;});
        const receipt=await boundedProjectWait(stopping,{timeoutMs:this.timeoutMs});
        if(receipt?.confirmationComplete!==true)throw fail('OMP_EXIT_UNCONFIRMED','原生停稳未确认。');
      }
      if(['remove','clean-local'].includes(hold.action)&&!project.removed)await this.host.storage.withLifecycleOwner(projectId,hold,()=>this.host.storage.requireOnline(projectId));
      await this.host.storage.releaseProject(projectId,hold);
    }
    let observation;
    try {
      if(record.action==='delete-project') {
        const current=await directorySnapshot(record.root);
        observation=!current?'gone':sameNullable(current,record.source.identity)?'original-present':'identity-conflict';
      } else if(record.action==='remove') {
        observation=project.removed?'removed':'registered';
      } else if(record.action==='reset-project') {
        // Observation only: never republish, re-archive or retire again. The
        // durable reset facts record exactly how far the operation got.
        const metadata=path.join(record.root,'.nozeli');
        const current=await statOrMissing(metadata);
        const retained=await statOrMissing(path.join(record.root,'.nozeli-source-'+operationId));
        const facts=await this.host.storage.getRecovery(projectId,'lifecycle:reset-facts:'+operationId);
        observation={metadata:!current?'missing':current.isSymbolicLink()||!current.isDirectory()?'invalid':record.source?.metadataIdentity?(sameNullable(identity(current),record.source.metadataIdentity)?'original':'replaced'):'unknown',retainedSource:Boolean(retained),registration:project.removed?'retired':'registered',facts:facts??null};
      } else {
        const current=await this.localScope(project);
        if(!sameNullable(current.identity,record.local.identity))observation='identity-conflict';
        else {
          const remaining=current.records.filter(id=>record.removeRecords.includes(id));
          observation=remaining.length?{state:'remaining',records:remaining}:'gone';
        }
      }
    }
    catch(error){observation=error.code==='PROJECT_IDENTITY_CONFLICT'?'identity-conflict':'unavailable';}
    const next={...record,phase:'needs-attention',observation,removed:project.removed===true,updatedAt:new Date().toISOString()};
    await this.journal(projectId,next);return next;
  }
}
function sameNullable(a,b){return a===null&&b===null || !!a&&!!b&&same(a,b);}
