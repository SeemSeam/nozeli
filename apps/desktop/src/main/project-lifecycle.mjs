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
    this.tokens=new Map();this.operations=new Map();this.removeAdmissions=new Map();
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
  async preview({projectId,action}) {
    if(!['clean-local','delete-project'].includes(action))throw fail('INVALID_LIFECYCLE_ACTION','未知项目清理操作。');
    if(this.operations.has(projectId))throw fail('PROJECT_LIFECYCLE_ACTIVE','该项目已有生命周期操作。');
    this.host.storage.assertActive(projectId);
    const project=await this.host.requireRegisteredProject(projectId),local=await this.localScope(project);
    const demoChanges=this.host.guidedDemo?.isDemo(projectId)?await this.host.guidedDemo.guardLifecycle(projectId,{allowChanged:true}):null;
    const source=action==='delete-project'?await this.checkDelete(project):null;
    const token=randomUUID(),operationId=randomUUID(),expiresAt=Date.now()+300000;
    const confirmation={token,operationId,projectId,instanceId:project.instanceId,action,root:project.root,
      identity:source?.identity??project.identity,source,local,expiresAt,
      removeDirectories:action==='clean-local'?[]:[project.root],
      removeFiles:[],removeRecords:action==='clean-local'?local.records:[],
      recoveryRetained:true,sessionsRetained:true,permanentDelete:false,accountsAffected:false};
    if(demoChanges){confirmation.demoChanges=demoChanges;confirmation.demoChangesDigest=demoChangesDigest(demoChanges);confirmation.preserveByDefault=demoChanges.length>0;}
    this.tokens.set(token,confirmation);
    return structuredClone(confirmation);
  }
  async journal(projectId,record) {
    await this.host.storage.putRecovery(projectId,'lifecycle:'+record.operationId,record);
  }
  async execute({token,allowDemoChanges=false}) {
    const confirmation=this.tokens.get(token);
    if(!confirmation || confirmation.expiresAt<Date.now())throw fail('LIFECYCLE_CONFIRMATION_EXPIRED','确认已失效，请重新查看范围。');
    this.tokens.delete(token);
    if(this.operations.has(confirmation.projectId))throw fail('PROJECT_LIFECYCLE_ACTIVE','该项目已有生命周期操作。');
    return this.run({...confirmation,allowDemoChanges:allowDemoChanges===true&&confirmation.preserveByDefault===true});
  }
  async run(confirmation) {
    const {projectId,operationId,instanceId,action}=confirmation;
    const hold=this.host.storage.holdProject(projectId,{operationId,instanceId,action});hold.pendingCount=0;
    const operation=(async()=>{await this.host.storage.persistProjectHold(projectId,hold);return this.host.storage.withLifecycleOwner(projectId,hold,()=>this.apply(confirmation,hold));})();this.operations.set(projectId,operation);
    try{return await operation;}catch(error){if(['PROJECT_STOP_TIMEOUT','OMP_EXIT_UNCONFIRMED','STORAGE_RESULT_UNKNOWN'].includes(error.code))hold.needsStopCheck=true;throw error;}finally{if(this.operations.get(projectId)===operation)this.operations.delete(projectId);if(!hold.pendingCount&&!hold.needsStopCheck)await this.host.storage.releaseProject(projectId,hold);}
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
    let record={schema:1,...confirmation,token:undefined,phase:'prepared',updatedAt:new Date().toISOString()};
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
      hold.needsStopCheck=true;
      const auxiliary=stage(Promise.resolve().then(()=>this.beforeStop(projectId)));
      const native=stage(Promise.resolve().then(()=>this.managed.stopProject(projectId,{lifecycleHold:hold})));
      const admitted=stage(this.host.storage.drainProjectOperations(projectId));
      const [,stopped]=await Promise.all([auxiliary,native,admitted]);
      if(stopped?.confirmationComplete!==true)throw fail('OMP_EXIT_UNCONFIRMED','项目写入者停稳未确认，保留所有目录。');
      hold.needsStopCheck=false;
      await stage(this.workspace.closeProject(projectId,{operationId}));
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
      await checkpoint({phase:'needs-attention',failedPhase:record.phase,error:{code:error.code||'ERROR',message:error.message}}).catch(()=>{});
      throw error;
    }
  }
  matchSource(expected,current) {
    if(expected.root!==current.root || !sameNullable(expected.identity,current.identity) || expected.manifestDigest!==current.manifestDigest)throw fail('PROJECT_IDENTITY_CONFLICT','目录实体或项目清单已变化，原确认已失效。');
  }
  async reconcile({projectId,operationId}) {
    await this.host.storage.reconcileLifecycleStorage(projectId);
    let record=await this.host.storage.getRecovery(projectId,'lifecycle:'+operationId);
    if(!record){const hold=this.host.storage.lifecycleHolds.get(projectId);if(hold?.operationId!==operationId)throw fail('LIFECYCLE_OPERATION_NOT_FOUND','操作记录不存在。');const project=await this.host.requireRegisteredProject(projectId);record={schema:1,projectId,operationId,action:hold.action,root:project.root,local:await this.localScope(project),source:{root:project.root,identity:project.identity},phase:'needs-attention'};}
    if(record.phase==='complete'){const hold=this.host.storage.lifecycleHolds.get(projectId);if(hold?.operationId===operationId)await this.host.storage.releaseProject(projectId,hold);return record;}
    // Observation only: never resume trash, rm, process termination or removal.
    const project=await this.host.requireRegisteredProject(projectId);
    const hold=this.host.storage.lifecycleHolds.get(projectId);
    if(hold?.operationId===operationId){
      if(hold.pendingCount||this.managed.projectStops?.has(projectId))throw fail('PROJECT_STOP_PENDING','原停稳操作仍未结束，未重新开放准入。');
      if(hold.needsStopCheck){
        const receipt=await boundedProjectWait(this.host.storage.withLifecycleOwner(projectId,hold,async()=>{
          const stopped=await this.managed.stopProject(projectId,{lifecycleHold:hold});
          await this.host.storage.drainProjectOperations(projectId);return stopped;
        }),{timeoutMs:this.timeoutMs});
        if(receipt?.confirmationComplete!==true)throw fail('OMP_EXIT_UNCONFIRMED','原生停稳未确认。');
      }
      await this.host.storage.releaseProject(projectId,hold);
    }
    let observation;
    try {
      if(record.action==='delete-project') {
        const current=await directorySnapshot(record.root);
        observation=!current?'gone':sameNullable(current,record.source.identity)?'original-present':'identity-conflict';
      } else if(record.action==='remove') {
        observation=project.removed?'removed':'registered';
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
