import {projectAttentionSummary} from './project-attention-summary.mjs';
import {AttentionLedger} from './managed/attention-ledger.mjs';
import {TaskPermissions} from './managed/task-permissions.mjs';
import {workDisposition} from '../domain/work-disposition.mjs';
import {userTodoEligible} from '../domain/managed-work-records.mjs';
import {workProgressFacts} from '../domain/work-progress.mjs';
import {SystemTerminalBridge} from './managed/system-terminal-bridge.mjs';
import {fileURLToPath} from 'node:url';
import {preferredRegionAssets} from '../domain/region-drawing.mjs';
import {tagMaterialSnapshot,readableTagMaterial} from './managed/tag-material-delivery.mjs';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Controller} from './managed/controller.mjs';
import {createFrontdeskDocuments} from './managed/frontdesk-documents.mjs';
import {ShadowVersions} from './managed/shadow-versions.mjs';
import {attachNativeTerminal} from './managed/native-terminal.mjs';
import {managedReportSource,managedHistory,managedArtifact} from './managed-report-source.mjs';
import {HostError,OFFICE_EXT,isUtf8Text} from '../main/host.mjs';
import {imageExtension} from '../main/image-format.mjs';
import {recordAdoption} from './managed/adoption-history.mjs';
import {SessionIndex} from './managed/session-index.mjs';
import {WorkChanges} from './managed/work-changes.mjs';
import {THINKING_LEVELS} from './managed/provider-settings.mjs';
import {TargetModelIntents} from './managed/target-model-intent.mjs';
const MODEL_ERROR_MESSAGES={
 PI_NO_MODEL:'所选模型当前不可用或未配置；原会话保持原模型。',
 PI_BUSY:'当前回合执行中；模型设置将在回合结束后的空闲边界应用。',
 PI_PROVIDER_CONFLICT:'源配置冲突；原会话保持原模型。',
 PI_CREDENTIAL_ORIGIN_CHANGE:'API地址来源变化需明确确认或新密钥；原会话保持原模型。',
 PI_CREDENTIAL_KEEP_UNAVAILABLE:'没有已保存的密钥可保留；原会话保持原模型。',
 PI_SESSION_LEASED:'会话正被其他操作持有；原会话保持原模型。',
 PI_RUNTIME_EXITED:'Pi 运行环境已退出；原会话保持原模型。',
 PI_RUNTIME_UNAVAILABLE:'Nozeli 私有 Pi 运行环境不可用；原会话保持原模型。',
 PI_INVALID_PARAMS:'模型或思考档位选择无效；原会话保持原模型。'
};
// Sanitized error DTO: native text is not a credential-safe boundary.
const modelErrorDTO=error=>{
 if(!error)return null;
 const code=typeof error.code==='string'&&Object.keys(MODEL_ERROR_MESSAGES).includes(error.code)?error.code:'PI_MODEL_CHANGE_FAILED';
 return {code,message:MODEL_ERROR_MESSAGES[code]};
};
import {readWorkerArchive} from './managed/worker-archive.mjs';
import {decodeReportState} from './managed/report-descriptor.mjs';
import {residentHistoryPage} from './managed/resident-history.mjs';
import {AgentProcessBudget,validateAgentLimit} from './managed/agent-process-budget.mjs';
import {Workspace} from './managed/workspace.mjs';
import {recoverOmpProvider,pinSessionFileById} from './managed/omp-process-ownership.mjs';
import {recoverPiProvider} from './managed/pi-process-ownership.mjs';
import {recoverProvider} from './managed/process-ownership.mjs';
import {readManagedState,managedRuntime,readManagedObject} from './managed/managed-storage.mjs';
import {migrateReviewLifecycle,confirmedDisposition} from './managed/review-lifecycle.mjs';
import {boundedProjectWait} from '../domain/project-lifecycle-wait.mjs';
import {collaborationProjection} from './managed/collaboration-status.mjs';
import {maintenancePage,maintenanceLiveRevision,validateMaintenancePage} from './managed/maintenance-status.mjs';
import {AgentIdleLifecycle} from './managed/agent-idle-lifecycle.mjs';
import {ServiceFaults} from './managed/service-faults.mjs';
import {workSlotFacts} from './managed/workspace.mjs';
import {jobBoundWork,workControlHeldFor} from './managed/work-control.mjs';
import {neverAdmitted} from './managed/restart-recovery.mjs';
import {boundedMemoryFile} from './managed/project-initialization.mjs';
export class ManagedProjects {
 constructor({userDataDir,host,legacy,beforeDocumentOperation,piSource=null,piRuntime=null,piAuth=null,openController=Controller.open,attachTerminal=attachNativeTerminal,stopTimeoutMs=15000,privilegeBroker=null,modelCatalog=null,idleTimeoutMs=300000,idleClock,serviceFaultBackoffMs}){
  Object.assign(this,{host,legacy,beforeDocumentOperation,openController,attachTerminal,stopTimeoutMs,privilegeBroker,modelCatalog,piSource,piRuntime,piAuth});
  this.modelIntents=new TargetModelIntents(host.storage);
  this.attention=new AttentionLedger(host.storage);
  this.permissions=new TaskPermissions(host.storage);
  this.versions=new Map();   // ShadowVersions per project（connect 中 set 前必须初始化）
  this.connectionErrors=new Map();this.handoffFlights=new Map();
  this.root=path.join(userDataDir,'runtime','managed');this.controllers=new Map();this.flights=new Map();this.terminalFlights=new Map();this.listener=()=>{};this.stopping=false;const helper={command:process.execPath,args:[...(process.versions.electron&&process.platform==='linux'?['--ozone-platform=headless']:[]),...(!process.versions.electron||process.defaultApp?[fileURLToPath(new URL('../main/main.cjs',import.meta.url))]:[]),'--nozeli-terminal-client']};this.systemTerminals=new SystemTerminalBridge({root:path.join(this.root,'terminal-tickets'),helper});
  this.activeProjectId=null;this.projectActivity=new Map();this.resourceFlights=new Map();
  this.serviceRoleModels=new Map();
  this.processBudget=new AgentProcessBudget({file:path.join(userDataDir,'agent-resources.json'),onAvailable:()=>{for(const c of this.controllers.values())c.kick?.();}});
  this.processBudget.reclaim=(id,target)=>this.reclaimInactive(id,{target});
  // Service fault gateway: facts arrive only through the controller runJob
  // failure hook; reads/aggregates never create a Controller or owner.
  this.serviceFaults=new ServiceFaults({host,storage:host.storage,controllers:this.controllers,processBudget:this.processBudget,lifecycleHolds:id=>host.storage.lifecycleHolds?.get(id)===true,sourceRevisionOf:provider=>this.providerSourceRevision(provider),modelForTarget:(id,target)=>this.serviceModelForTarget(id,target),liveEvaluate:(projectId,fault)=>this.faultLiveEvaluate(projectId,fault),afterRelease:()=>{for(const controller of this.controllers.values())if(!controller.stopping)controller.kick();},retryExpired:(projectId,faultRef)=>this.faultRetryExpired(projectId,faultRef),backoffMs:serviceFaultBackoffMs,listener:event=>this.listener({projectId:null,kind:'managed-faults',...event})});
  this.idleLifecycle=new AgentIdleLifecycle({controllers:this.controllers,idleTimeoutMs,clock:idleClock,onError:(projectId,error)=>this.listener({projectId,kind:'managed-error',text:'空闲 Agent 回收未确认，名额保留：'+error.message})});
  this.host.storage.onUnavailable=(id,reason)=>{const pending=this.markUnavailable(id,reason);pending.catch(()=>{});return pending;};
 }
 onEvent(fn){this.listener=fn;}
 projectAttentionSummary(payload){return projectAttentionSummary(this,payload);}
 applyModelDefaults(defaults){
  const next=structuredClone(defaults);
  for(const [role,value] of Object.entries(next)){
   const selector=typeof value==='string'?value:value?.model?.mode==='explicit'?value.model.selector:null;
   if(selector)this.serviceRoleModels.set(role,selector);else this.serviceRoleModels.delete(role);
  }
  const operation=(this.modelDefaultsFlight??Promise.resolve()).catch(()=>{}).then(async()=>{
   const sync={applied:0,pending:0,failed:[],sessions:[]};
   this.modelDefaultFailures=new Map();
   if(this.stopping)return sync;
   await Promise.all([...this.controllers.values()].map(async controller=>{
    if(controller.stopping)return;
    try{const result=await controller.applyModelDefaults(next);sync.applied+=result.applied;sync.pending+=result.pending;sync.failed.push(...result.failed);sync.sessions.push(...(result.sessions??[]));}
    catch{const failure={message:'项目在线Agent默认模型同步失败；配置已保存，可重试保存。'};this.modelDefaultFailures.set(controller,failure);sync.failed.push(failure);}
   }));
   return sync;
  });
  this.modelDefaultsFlight=operation;return operation;
 }
 modelSync(){
  const sync={applied:0,pending:0,failed:[],sessions:[]};
  for(const controller of this.controllers.values()){
   if(controller.stopping)continue;
   const failure=this.modelDefaultFailures?.get(controller);if(failure){sync.failed.push(failure);continue;}
   const result=controller.modelSync();sync.applied+=result.applied;sync.pending+=result.pending;sync.failed.push(...result.failed);sync.sessions.push(...(result.sessions??[]));
  }
  return sync;
 }
 async applyProviderUpdate(provider,{revision}={}){
  const application={applied:0,pending:0,failed:[],sessions:[]};
  if(this.stopping||!provider)return application;
  this.serviceFaults.updateSourceRevision(provider,Number.isSafeInteger(revision)?revision:await this.providerSourceRevision(provider));
  await Promise.all([...this.controllers.values()].map(async controller=>{
   if(controller.stopping||typeof controller.applyProviderUpdate!=='function')return;
   try{
    const result=await controller.applyProviderUpdate(provider);
    application.applied+=result.applied;application.pending+=result.pending;application.failed.push(...result.failed);application.sessions.push(...(result.sessions??[]));
   }catch{application.failed.push({message:'源已保存，但一个项目未能刷新其在线Agent；原会话保持，可重试保存源。'});}
  }));
  return application;
 }
 async initializeResources(){
  if(this.resourceReady)return this.resourceReady;
  const flight=(async()=>{
   await this.processBudget.load();const records=[];
   for(const project of await this.host.storage.list()){
    // Retired instances retain provider ownership facts: reclaim only after
    // verification, without opening their former business metadata or absent UI.
    const providers=project.removed?(await this.host.storage.getLocalRecord(project.id,'managed:providers'))?.value??{}:await this.host.storage.getLocal(project.id,'managed:providers')??{};
    for(const [target,record] of Object.entries(providers)){
     const live=this.controllers.get(project.id)?.sessions?.get(target);if(live&&!live.closed)continue;
     const slot=[...this.processBudget.slots].find(slot=>slot.projectId===project.id&&slot.target===target)??this.processBudget.restoreSlot(project.id,target);
     records.push({runtime:await managedRuntime(this.host.storage,project.id),record,slot});
    }
   }
   for(const {runtime,record,slot} of records)try{
    const receipt=await (record.kind==='pi-node'?recoverPiProvider(record,runtime):['omp-rpc','omp-tui'].includes(record.kind)?recoverOmpProvider(record,runtime):recoverProvider(record,runtime));
    if(receipt.verified===true){const providers=await this.host.storage.getLocal(slot.projectId,'managed:providers')??{};if(JSON.stringify(providers[slot.target])===JSON.stringify(record)){delete providers[slot.target];await this.host.storage.putLocal(slot.projectId,'managed:providers',providers);this.processBudget.release(slot);}else slot.state='unconfirmed';}else slot.state='unconfirmed';
   }catch{slot.state='unconfirmed';}
  })();this.resourceReady=flight;try{return await flight;}catch(error){if(this.resourceReady===flight)this.resourceReady=null;throw error;}
 }
 validateResourceProject(id){if(id!==undefined&&id!==null&&(typeof id!=='string'||!id.trim()||id.trim()!==id||id.length>200))throw new HostError('INVALID_PAYLOAD','项目身份无效');}
 async resourceStatus(projectId){
  this.validateResourceProject(projectId);
  await this.initializeResources();let projectLimit=null,projectUsed=0,projectPendingVerification=0;
  if(projectId){
   await this.host.requireRegisteredProject(projectId);
   const state=this.controllers.get(projectId)?.store?.state;
   if(state){
    // Single quota authority (Workspace.workSlotFacts): activated non-ended
    // works occupy; ended works release only on a completed closure; ended
    // works without a recognizable closure stay pending verification.
    projectLimit=state.limit??1;const slots=workSlotFacts(state.works??[]);projectUsed=slots.used;projectPendingVerification=slots.pendingVerification?.length??0;
   }
   else {
    let offline=false;try{await this.host.storage.requireOnline(projectId);}catch{offline=true;}
    const summary=await this.host.storage.managedResourceSummary(projectId,{offline});
    projectLimit=summary.limit;projectUsed=summary.used;projectPendingVerification=summary.pendingVerification??0;
   }
  }
  const agents=this.processBudget.agents();
  for(const [id,c] of this.controllers){for(const target of ['frontdesk','orchestrator',...(c.store?.state?.works??[]).filter(w=>!['queued','closing','ended'].includes(w.status)).map(w=>w.id)]){
   const slot=agents.find(slot=>slot.projectId===id&&slot.target===target),session=c.sessions?.get(target);
   if(slot&&session){slot.state=slot.state==='unconfirmed'?'unconfirmed':session.busy||c.running?.has(target)?'running':slot.state==='starting'?'starting':'idle';slot.blockedReason=c.externalTerminalTargets?.has(target)?'系统终端正在使用':c.nativeDraftTargets?.has(target)?'原生终端有未发送草稿':session.busy||c.running?.has(target)?'任务执行中':c.terminals?.has(target)&&id===this.activeProjectId?'当前内置终端正在使用':null;}
   else if(!slot)agents.push({projectId:id,target,state:'sleeping'});
  }}
  const projectNames=new Map();for(const agent of agents){if(!projectNames.has(agent.projectId)){try{const project=await this.host.requireProject(agent.projectId);projectNames.set(agent.projectId,project.name??project.title??null);}catch{projectNames.set(agent.projectId,null);}}agent.projectName=projectNames.get(agent.projectId);const work=this.controllers.get(agent.projectId)?.store?.state?.works?.find(w=>w.id===agent.target);if(work?.name)agent.workName=work.name;}
  return {globalLimit:this.processBudget.limit,globalUsed:this.processBudget.used,projectLimit,projectUsed,projectPendingVerification,agents};
 }
 async saveResourceLimits(payload={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['globalLimit','projectId','projectLimit'].includes(key)))throw new HostError('INVALID_PAYLOAD','Agent 设置参数无效');
  const {globalLimit,projectId,projectLimit}=payload;validateAgentLimit(globalLimit);if(projectLimit!==undefined){validateAgentLimit(projectLimit,{project:true});if(!projectId)throw new HostError('INVALID_PAYLOAD','项目 Worker 设置需要当前项目');}
  this.validateResourceProject(projectId);
  const run=async()=>{
  await this.initializeResources();if(projectId)await this.host.requireProject(projectId);
  const prior=this.resourceFlights.get(projectId),connecting=this.flights.get(projectId);
  const operation=(async()=>{
   await prior?.catch(()=>{});await connecting;let store=this.controllers.get(projectId)?.store,owned=false;
   if(projectLimit!==undefined&&!store){const project=await this.host.requireProject(projectId);store=await Workspace.open(await managedRuntime(this.host.storage,projectId),project.root,{storage:this.host.storage,projectId,recoverStale:true});owned=true;}
   try{await this.processBudget.save(globalLimit,async()=>{if(projectLimit!==undefined)await store.mutate(()=>{const used=store.used();if(projectLimit<used)throw Object.assign(Error(`项目 Worker 数量不能低于当前占用 ${used}（包括暂停、待审阅与关闭中工作）`),{code:'AGENT_LIMIT_IN_USE'});store.state.limit=projectLimit;});});this.controllers.get(projectId)?.changed?.();}
   finally{if(owned)await store.close();}
  })();if(projectId)this.resourceFlights.set(projectId,operation);
  try{await operation;return this.resourceStatus(projectId);}finally{if(this.resourceFlights.get(projectId)===operation)this.resourceFlights.delete(projectId);}
  };return projectId?this.host.storage.withProjectOperation(projectId,run):run();
 }
 async setActiveProject(id){
  if(this.guidedDemo?.isDemo(id)){await this.guidedDemo.verify(id);this.activeProjectId=id;return {demo:true,source:'demo-fixture'};}
  this.validateResourceProject(id);if(id===undefined)throw new HostError('INVALID_PAYLOAD','项目身份无效');const epoch=this.activationEpoch=(this.activationEpoch??0)+1;
  if(id!==null)await this.host.requireRegisteredProject(id);if(epoch!==this.activationEpoch)return {superseded:true};this.activeProjectId=id;if(id)this.projectActivity.set(id,Date.now());
  await this.initializeResources();if(epoch!==this.activationEpoch)return {superseded:true};
  if(epoch!==this.activationEpoch)return {superseded:true};
  return this.resourceStatus(id??undefined);
 }
 reclaimInactive(requestingId,{target:requestedTarget}={}){
  const operation=(this.reclaimFlight??Promise.resolve()).catch(()=>{}).then(async()=>{
   const candidates=[...this.controllers.entries()].filter(([id])=>id!==this.activeProjectId&&id!==requestingId).sort(([a],[b])=>(this.projectActivity.get(a)??0)-(this.projectActivity.get(b)??0));
   for(const [id,c] of candidates){for(const target of c.sessions?.keys()??[]){if(this.processBudget.available)return;try{await c.reclaimIdle?.(target,{hiddenTerminal:true});}catch(error){this.listener({projectId:id,kind:'managed-error',text:'空闲 Agent 回收未确认，名额保留：'+error.message});}}}
   if(!this.processBudget.available&&requestedTarget){const c=this.controllers.get(requestingId),targets=['orchestrator','frontdesk',...(c?.sessions?.keys()??[])];for(const target of new Set(targets)){if(this.processBudget.available)break;if(target===requestedTarget)continue;try{await c?.reclaimIdle?.(target);}catch(error){this.listener({projectId:requestingId,kind:'managed-error',text:'空闲 Agent 回收未确认，名额保留：'+error.message});}}}
  });this.reclaimFlight=operation;return operation;
 }
 async diagnoseProject(id,error){
  const controller=this.controllers.get(id),code=error?.code;
  if(!['PROJECT_FLUSH_FAILED','PROJECT_RECOVERY_UNSAFE','SURFACE_NOT_READY','FLUSH_TIMEOUT'].includes(code))return {diagnosis:'unavailable',reason:'external-or-unsupported'};
  if(this.host.storage.lifecycleHolds?.has(id))return {diagnosis:'unavailable',reason:'project-held'};
  if(!controller||controller.stopping||controller.store.closed||!controller.started)return {diagnosis:'unavailable',reason:'no-controller'};
  try{this.host.storage.assertActive(id);}catch{return {diagnosis:'unavailable',reason:'project-held'};}
  const previous=(await controller.maintenance.read()).bugs.find(bug=>bug.phase==='project-lifecycle'&&bug.error?.code===code);
  if(previous)return {diagnosis:'recorded',bugId:previous.id,resetSuggested:previous.status!=='repaired'};
  const bug=await controller.maintenance.record({phase:'project-lifecycle',error:{code},identity:code});
  const queued=await controller.maintenanceEvent(bug);return {diagnosis:queued?'queued':'unavailable',bugId:bug.id,resetSuggested:true};
 }
 async initializationRead(id,{version,offset=0}={}){
  if(version!==undefined&&typeof version!=='string'||!Number.isSafeInteger(offset)||offset<0)throw new HostError('INVALID_PAYLOAD','项目地图分页参数无效。');
  const project=await this.host.requireRegisteredProject(id),map=await boundedMemoryFile(path.join(project.metadataRoot,'memory','plantree'),'topics/project-map.md');
  if(map.text===null)throw new HostError('PROJECT_MAP_UNAVAILABLE','项目地图尚未生成。');
  if(version!==undefined&&version!==map.digest)throw new HostError('PROJECT_INITIALIZATION_MAP_CONFLICT','项目地图已变化，请刷新。');
  const endOffset=Math.min(map.text.length,offset+12000);return {text:map.text.slice(offset,endOffset),version:map.digest,offset,endOffset,nextOffset:endOffset<map.text.length?endOffset:null,totalChars:map.text.length};
 }
 async initializationStatus(id){
  const project=await this.host.requireRegisteredProject(id),controller=this.controllers.get(id);
  if(controller)return controller.initializationStatus();
  const state=(await this.projectionSource(id)).state,job=state.jobs?.findLast(j=>j.type==='project-initialization'&&j.context?.projectInstanceId===project.instanceId);
  return {schema:1,projectId:id,projectInstanceId:project.instanceId,status:job?.status??'pending',jobId:job?.id??null,map:job?.projectMap??null,errorCode:job?.errorCode??null};
 }
 async initializeProject(id,{retry=false,expectedProjectInstanceId}={}){
  const project=await this.host.requireRegisteredProject(id);
  if(expectedProjectInstanceId!==undefined&&project.instanceId!==expectedProjectInstanceId)throw new HostError('PROJECT_INITIALIZATION_STALE','项目实例已变化。');
  if(!project.semanticInitializationEligible&&!retry||!(await this.config(id)).enabled||this.stopping)return this.initializationStatus(id);
  if(!retry&&(await this.initializationStatus(id)).status!=='pending')return this.initializationStatus(id);
  let controller=this.controllers.get(id);
  if(!controller?.started){await this.connect(id);controller=this.controllers.get(id);}
  if(!controller?.started)return this.initializationStatus(id);
  return controller.initializeProject({retry,expectedProjectInstanceId:project.instanceId});
 }
 async config(id){await this.host.requireRegisteredProject(id);return await this.host.storage.getLocal(id,'managed:binding')??{enabled:false};}
 // Ordinary directory access does not register projects or create metadata.
 async resolveRegisteredProject(currentId,value){
  if(typeof value!=='string'||!value.trim()||value.length>4096)throw new HostError('INVALID_PAYLOAD','projectPath 无效。');
  const trimmed=value.trim();
  const registry=await this.host.recent();
  const match=(registry?.projects??[]).find(project=>project.id===trimmed||project.rootDisplay===trimmed);
  if(match){
   if(match.available===false)throw new HostError('PROJECT_ROOT_MISSING','目标项目目录当前不可用。');
   return {projectId:match.id,name:match.name,root:match.rootDisplay};
  }
  if(trimmed===currentId){const project=await this.host.requireRegisteredProject(currentId);return {projectId:currentId,root:project.rootDisplay??project.root};}
  if(!path.isAbsolute(trimmed))throw new HostError('INVALID_PAYLOAD','未登记目录必须使用绝对路径。');
  let root;
  try{root=await fs.realpath(trimmed);if(!(await fs.stat(root)).isDirectory())throw Error('not directory');}
  catch{throw new HostError('PROJECT_ROOT_MISSING','目标目录不存在或不可读取。');}
  let registered=null,registeredRoot=null,prefix='';
  for(const project of registry?.projects??[]){
   if(typeof project.rootDisplay!=='string')continue;
   let candidate;try{candidate=await fs.realpath(project.rootDisplay);}catch{continue;}
   const relative=path.relative(candidate,root);
   if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))continue;
   if(!registeredRoot||candidate.length>registeredRoot.length){registered=project;registeredRoot=candidate;prefix=relative.split(path.sep).join('/');}
  }
  if(registered){if(registered.available===false)throw new HostError('PROJECT_ROOT_MISSING','目标项目目录当前不可用。');return {projectId:registered.id,name:registered.name,root:registeredRoot,relPathPrefix:prefix};}
  return {projectId:null,root,external:true};
 }
 async demoStatus(id){return this.guidedDemo?.isDemo(id)?this.guidedDemo.managed('managed.status',{projectId:id}):null;}
 // Host-side cwd gate for sensitive effects: the longest REGISTERED project
 // root containing the path, or null. Unregistered locations are never
 // admitted by model assertion.
 async resolveProjectRoot(absolutePath){
  if(typeof absolutePath!=='string'||!absolutePath.startsWith('/'))return null;
  const registry=(await this.host.recent())?.projects??[];
  const normalized=absolutePath.split('/').filter(Boolean);
  let best=null,bestDepth=-1;
  for(const project of registry){
   if(project.available===false||typeof project.rootDisplay!=='string')continue;
   const root=project.rootDisplay.split('/').filter(Boolean);
   if(root.length>normalized.length||root.some((part,index)=>normalized[index]!==part))continue;
   if(root.length>bestDepth){best=project;bestDepth=root.length;}
  }
  return best?{projectId:best.id,name:best.name??null,root:best.rootDisplay}:null;
 }
 async attentionState(id,state,{connected=false}={}){
  const controller=connected?this.controllers.get(id):null;
  if(controller?.processBackstage){await controller.processBackstage();state=controller.snapshot();}
  const facts=[];
  for(const agent of state?.agents??[]){
   for(const question of agent.interactions??[]){
    const payload={...(question.question??question),capability:question.capability},permission=payload.method==='approve';
    facts.push({key:agent.ownerId+':'+question.id,target:agent.target,workId:state.works?.some(w=>w.id===agent.target)?agent.target:undefined,title:(permission?'高危操作授权 · ':'后台核对 · ')+question.title,text:[question.title,question.detail,permission?'请核对具体对象、效果与风险后决定；查看不构成授权。':'原问题与会话已保留，由后台核对已有材料；缺少可靠信息时保持中性受阻，不编造答案或重放。'].filter(Boolean).join('\n'),destination:{kind:'conversation',target:agent.target,ownerId:agent.ownerId,threadId:agent.threadId,interactionId:question.id,question:payload}});
   }
  }
  const liveOwners=new Set((state?.agents??[]).filter(a=>!a.closed).map(a=>a.ownerId));
  await this.attention.observe(id,'native',facts,{interrupted:todo=>!connected||!liveOwners.has(todo?.destination?.ownerId)});
  const blockers=[];
  for(const target of state?.nativeDraftTargets??[])if(state.nativeDraftBlockedTargets?.includes(target)||state.jobs?.some(j=>j.target===target&&['queued','running'].includes(j.status))){const agent=state.agents?.find(a=>a.target===target);blockers.push({key:'draft:'+target,target,title:'原生草稿阻断待处理',text:'原生会话有未发送文字，已阻断此会话的执行或输入。可在工作区读取并明确修改原生文字草稿；不会自动发送。',destination:{kind:'native-draft',target,ownerId:agent?.ownerId,threadId:agent?.threadId}});}
  for(const agent of state?.agents??[])if(agent.modelError)blockers.push({key:'model:'+agent.target,target:agent.target,title:'模型配置待处理',text:agent.modelError.message||'模型切换失败',destination:{kind:'settings',target:agent.target}});
  for(const agent of state?.agents??[])if(!agent.closed&&['manual-unresolved','settlement-pending'].includes(agent.phase))blockers.push({key:'protocol:'+agent.ownerId+':'+agent.phase,target:agent.target,title:agent.phase==='manual-unresolved'?'原生回合结束待核对':'原生回执落盘受阻',text:agent.phase==='manual-unresolved'?'原生会话尚未确认本回合结束；执行身份与输入保留，请核对原会话，不会自动重放。':'原生执行已返回，但持久化回执尚未完成；原身份保留，请检查存储与恢复事项，不要重复提交。',destination:{kind:'connection',target:agent.target}});
  if(state?.storageBlocked)blockers.push({key:'storage-unknown',title:'存储提交结果待核对',text:'存储提交结果不确定，后台已暂停新执行。请在本机恢复中心核对原结果，不会自动重放。',destination:{kind:'settings',section:'settings-recovery'}});
  if(state?.frontdeskContextClearFailed)blockers.push({key:'frontdesk-context',target:'frontdesk',title:'前台上下文恢复受阻',text:'前台上下文清理或恢复未完成，原会话与输入保留，请核对连接与恢复操作。',destination:{kind:'connection',target:'frontdesk'}});
  for(const job of state?.jobs??[])if(job.resourceBlocked&&['queued','running'].includes(job.status))blockers.push({key:'resource:'+job.id,target:job.target,sourceJobId:job.id,title:'进程额度阻断待处理',text:'此输入已受理，但原生进程额度不足，尚未发送给模型。可等待名额释放，或在 Agent 设置中核对占用；不会重复提交。',destination:{kind:'settings',section:'settings-agents'}});
  if(connected)await this.attention.observe(id,'blocker',blockers);
  // Sensitive-effect requests are their own single attention todo per request
  // (permission boundary). Facts vanish once decided, so the ledger todo
  // resolves with the request; both persist across restarts. Live task-mode
  // grants and unknown execution results stay visible until revoked/resolved.
  const ledger=await this.permissions.read(id);
  const permissionFacts=[];
  for(const request of ledger.requests??[])if(request.kind==='effect'&&request.status==='pending'){
    const frozen=request.frozenEffect||{};
    const elevated=frozen.action==='admin';
    permissionFacts.push({key:'permission:'+request.id,target:request.role==='orchestrator'?'orchestrator':'frontdesk',sourceJobId:request.sourceJobId,title:(elevated?'提权执行授权':'敏感执行授权')+' · 等待你的决定',text:'请求执行：'+frozen.command+' '+(frozen.args||[]).map(v=>JSON.stringify(v)).join(' ')+'\n工作目录：'+frozen.cwd+'\n单次授权仅执行该冻结命令一次；任务授权仅允许原任务重复完全相同的命令、参数和工作目录，不覆盖其他管理命令。撤销不逆转既有效果。\n原任务：'+String(request.originalText??'').slice(0,200),destination:{kind:'effect-permission',requestId:request.id,expectedVersion:request.version,sourceJobId:request.sourceJobId,question:{method:'effect-permission',title:(elevated?'提权执行授权（root/管理员）':'敏感执行授权'),originalText:request.originalText??null,command:frozen.command,args:frozen.args??[],cwd:frozen.cwd,elevation:frozen.action??'user',purpose:request.reason??null,effectHash:request.effectHash,remainingActions:request.remainingActions??null,completedOperations:request.completedOperations??null,risk:elevated?'root/admin可读写全盘、安装/删除软件和修改系统配置；工作目录不是访问沙箱，不保证回滚。':'当前用户范围的敏感命令；显式批准才执行并保留回执。'}}});
  }
  for(const request of ledger.requests??[])if(request.status==='migrated')permissionFacts.push({key:'permission-migrated:'+request.id,target:'frontdesk',sourceJobId:request.sourceJobId,title:'跨项目授权待办已迁移关闭',text:'常规跨项目文档访问不再需要逐次授权，原“跨项目访问授权”待办已关闭。\n原请求未被自动继续，也未重放任何已完成输入；如仍需该访问，请在原任务中直接重试，或对敏感/提权执行使用'+String(request.action==='read'?'读取':'写入')+'（'+(request.targetProjectName||request.targetProjectId)+' / '+(request.relPath||'全部公共文件')+'）。',destination:{kind:'cross-project-migrated',requestId:request.id,sourceJobId:request.sourceJobId}});
  for(const grant of ledger.grants??[])if(grant.kind==='effect'&&grant.status==='granted'&&grant.mode==='task'&&grant.authority!=='default-yolo'){
    const frozen=grant.frozenEffect||{};
    permissionFacts.push({key:'effect-grant:'+grant.id,target:'frontdesk',sourceJobId:grant.sourceJobId,title:'本任务冻结命令授权生效中 · 可撤销',text:'本任务授权冻结命令：'+frozen.command+' '+(frozen.args||[]).map(v=>JSON.stringify(v)).join(' ')+'（cwd: '+frozen.cwd+'）。仅原任务可重复完全相同的命令、参数和工作目录，不覆盖其他管理命令。\n撤销关闭未来准入，不逆转既有效果。'+(grant.expiresAt?'到期时间 '+grant.expiresAt:''),destination:{kind:'effect-grant',grantId:grant.id,expectedVersion:grant.version??1,sourceJobId:grant.sourceJobId,question:{method:'effect-grant',title:'本任务冻结命令授权（可撤销）',command:frozen.command,args:frozen.args??[],cwd:frozen.cwd,elevation:frozen.action??'user',effectHash:grant.effectHash,grantedAt:grant.grantedAt,expiresAt:grant.expiresAt??null}}});
  }
  for(const execution of ledger.executions??[])if(execution.status==='unknown')permissionFacts.push({key:'effect-unknown:'+execution.id,target:'frontdesk',sourceJobId:null,title:'执行结果未知 · 需核对',text:'一项已批准的敏感/提权执行结果未知（'+execution.effectHash.slice(0,16)+'…）。为避免重复副作用，不会自动重放；请核对系统实际状态后，在原任务中重新申请。',destination:{kind:'connection',target:'frontdesk'}});
  for(const execution of ledger.executions??[])if(['auth-cancelled','auth-failed'].includes(execution.status))permissionFacts.push({key:'effect-auth:'+execution.id,target:'frontdesk',sourceJobId:null,title:'提权认证未完成 · 可再次处理',text:'用户已批准的敏感/提权执行因系统认证'+(execution.status==='auth-cancelled'?'被取消':'失败')+'未执行（'+execution.effectHash.slice(0,16)+'…）。不自动重试；可在原任务中重新发起同一命令，宿主会再次走真实系统认证。',destination:{kind:'connection',target:'frontdesk'}});
  await this.attention.observe(id,'permission',permissionFacts);
  const saved=await this.attention.read(id);
  return {...(state??{jobs:[],works:[],receipts:[],agents:[],drafts:{},busyTargets:[],nativeDraftTargets:[],externalTerminalTargets:[],configuringTargets:[]}),todos:[...(state?.todos??[]).filter(t=>t.origin!=='instance-attention'),...saved.todos],attentionNotified:saved.notified};
 }
 async respondAttention(id,p){
  if(p&&typeof p==='object'&&!Array.isArray(p)&&p.attentionKind!==undefined)return this.respondAttentionDecision(id,p);
  const {todoId,answer,cancel=false}=p??{};
  if(typeof todoId!=='string'||!todoId||todoId.length>160||typeof cancel!=='boolean')throw new HostError('INVALID_PAYLOAD','待办作答标识或动作无效。');
  let bytes;try{bytes=Buffer.byteLength(JSON.stringify(answer)??'');}catch{throw new HostError('INVALID_PAYLOAD','待办答案格式无效。');}
  if(bytes>65536)throw new HostError('INVALID_PAYLOAD','待办答案过长。');
  const controller=this.controllers.get(id);
  if(!controller||controller.stopping)throw new HostError('ATTENTION_OWNER_UNAVAILABLE','原会话不可用；保留答案，请先核对恢复状态。');
  const state=await this.attentionState(id,controller.snapshot(),{connected:true});
  const todo=state.todos.find(t=>t.id===todoId&&t.status==='open');
  const destination=todo?.destination;
  if(destination?.kind==='frontdesk-route'&&destination.proposalId){
   // Legacy todo-envelope answer for the single store routing todo.
   const routeAction=answer?.action;
   if(!['background','continue','cancel'].includes(routeAction))throw new HostError('INVALID_PAYLOAD','前台去向决定动作无效。');
   const route=controller.store.state.frontdeskRoutes?.find(r=>r.id===destination.proposalId&&r.sourceJobId===destination.sourceJobId);
   if(!route||route.status!=='pending')throw new HostError('ATTENTION_STALE','前台去向提议已结束，请刷新核对。');
   const result=await controller.resolveFrontdeskRoute({proposalId:destination.proposalId,expectedVersion:destination.expectedVersion,action:routeAction,requestKey:'attention:'+destination.proposalId+':'+destination.expectedVersion+':'+routeAction});
   const merged=await this.attentionState(id,controller.snapshot(),{connected:true});
   this.listener({projectId:id,kind:'managed-state',state:merged});
   return result;
  }
  if(todo?.origin!=='instance-attention'||!userTodoEligible(todo)||destination?.kind!=='conversation'||!destination.interactionId)throw new HostError('ATTENTION_STALE','原问题已结束或不接受作答；不会将答案发送到其他会话。');
  const result=await controller.respondInteraction(destination.target,destination.ownerId,destination.interactionId,answer,{cancel});
  const merged=await this.attentionState(id,controller.snapshot(),{connected:true});
  this.listener({projectId:id,kind:'managed-state',state:merged});
  return result;
 }
 // Flat decision envelope shared by the routing and permission surfaces:
 // identity + version + source-job binding are re-verified against the live
 // authority before the controller resolves anything; a deterministic
 // requestKey keeps real double-clicks idempotent.
 async respondAttentionDecision(id,{attentionKind,attentionId,expectedVersion,action,sourceJobId,requestKey}){
  if(!['frontdesk-route','effect-permission','effect-grant','cross-project-permission'].includes(attentionKind)||typeof attentionId!=='string'||!attentionId.trim()||attentionId.trim()!==attentionId||attentionId.length>200||typeof sourceJobId!=='string'||!sourceJobId.trim()||sourceJobId.trim()!==sourceJobId||sourceJobId.length>200||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new HostError('INVALID_PAYLOAD','待办决定的身份、版本或来源无效。');
  if(requestKey!==undefined&&requestKey!==null&&(typeof requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(requestKey)))throw new HostError('INVALID_PAYLOAD','待办决定键无效。');
  const controller=this.controllers.get(id);
  if(!controller||controller.stopping)throw new HostError('ATTENTION_OWNER_UNAVAILABLE','原会话不可用；保留决定，请先核对恢复状态。');
  const key=typeof requestKey==='string'&&requestKey?requestKey:'attention:'+attentionId+':'+expectedVersion+':'+action;
  let result;
  if(attentionKind==='frontdesk-route'){
   if(!['background','continue','cancel'].includes(action))throw new HostError('INVALID_PAYLOAD','前台去向决定动作无效。');
   const route=controller.store.state.frontdeskRoutes?.find(r=>r.id===attentionId);
   if(!route||route.sourceJobId!==sourceJobId)throw new HostError('ATTENTION_STALE','前台去向提议不存在或来源不符，请刷新核对。');
   result=await controller.resolveFrontdeskRoute({proposalId:attentionId,expectedVersion,action,requestKey:key});
  }else if(attentionKind==='effect-permission'){
   // The only decision channel for sensitive effects: identity + version +
   // source binding re-verified against the live ledger before anything
   // resolves; approve never implies OS authentication.
   if(!['approve-once','approve-task','deny','cancel'].includes(action))throw new HostError('INVALID_PAYLOAD','效果授权决定动作无效。');
   const request=(await this.permissions.read(id)).requests?.find(r=>r.id===attentionId);
   if(!request||request.kind!=='effect'||request.sourceJobId!==sourceJobId)throw new HostError('ATTENTION_STALE','效果授权请求不存在或来源不符，请刷新核对。');
   result=await controller.resolveEffectRequest({requestId:attentionId,expectedVersion,action,requestKey:key});
  }else if(attentionKind==='effect-grant'){
   if(action!=='revoke')throw new HostError('INVALID_PAYLOAD','任务授权待办仅接受撤销。');
   const grant=(await this.permissions.read(id)).grants?.find(g=>g.id===attentionId);
   if(!grant||grant.sourceJobId!==sourceJobId||grant.version!==expectedVersion)throw new HostError('ATTENTION_STALE','任务授权不存在或已变化，请刷新核对。');
   result=await this.permissions.revokeGrant(id,{grantId:attentionId});
   this.privilegeBroker?.revoke?.({grantId:attentionId});
   controller.changed?.();
  }else{
   // The ordinary cross-project gate is gone; a stale renderer tab may still
   // show an old todo. Never resolve it silently — the migration todo already
   // told the user ordinary access needs no approval now.
   throw new HostError('ATTENTION_STALE','常规跨项目授权待办已随权限迁移关闭；普通跨项目文档访问不再需要该决定，敏感/提权执行请使用新的授权待办。');
  }
  const merged=await this.attentionState(id,controller.snapshot(),{connected:true});
  this.listener({projectId:id,kind:'managed-state',state:merged});
  return result;
 }
 async attentionTarget(id,todoId,kind){
  const controller=this.controllers.get(id);
  if(!controller||controller.stopping)throw new HostError('ATTENTION_OWNER_UNAVAILABLE','原会话不可用；不会恢复或修改其他会话。');
  const state=await this.attentionState(id,controller.snapshot(),{connected:true});
  const todo=state.todos.find(t=>t.id===todoId&&t.origin==='instance-attention'&&t.status==='open');
  const destination=todo?.destination,agent=state.agents.find(a=>a.target===destination?.target);
  if(destination?.kind!==kind||!destination.ownerId||agent?.ownerId!==destination.ownerId||agent.closed)throw new HostError('ATTENTION_STALE','原待办或所属会话已变化，请刷新核对。');
  return {controller,destination};
 }
 async attentionDraft(id,{todoId,expectedText,text},write=false){
  if(typeof todoId!=='string'||!todoId||todoId.length>160)throw new HostError('INVALID_PAYLOAD','待办标识无效。');
  if(write&&([expectedText,text].some(v=>typeof v!=='string'||Buffer.byteLength(v)>65536)))throw new HostError('INVALID_PAYLOAD','草稿文字格式无效或过长。');
  const {controller,destination}=await this.attentionTarget(id,todoId,'native-draft');
  if(!write)return controller.readNativeDraft(destination.target,destination.ownerId);
  const original=await controller.readNativeDraft(destination.target,destination.ownerId);
  if(original.text!==expectedText)throw new HostError('NATIVE_DRAFT_CHANGED','原生草稿已被并发修改；工作区文字保留，请重新读取核对。');
  const backupKey='managed:attention-native-draft:'+todoId;
  if(!await this.host.storage.getLocal(id,backupKey))await this.host.storage.putLocal(id,backupKey,{ownerId:destination.ownerId,threadId:destination.threadId,text:original.text,updatedAt:new Date().toISOString()});
  return controller.replaceNativeDraft(destination.target,destination.ownerId,expectedText,text);
 }
 async reportConnectionError(id,error){
  await this.attention.observe(id,'connection',[{key:'connection',target:error.target||'frontdesk',title:error.code==='CONFIG_SETUP_REQUIRED'?'配置阻断待处理':'连接与恢复待处理',text:error.message,destination:{kind:error.code==='CONFIG_SETUP_REQUIRED'?'settings':'connection',target:error.target||'frontdesk'}}]);
  const status=await this.status(id);this.listener({projectId:id,kind:'managed-state',state:status.state});
 }
 async configurationReady(){
  for(const project of await this.host.storage.list()){
   if(project.removed)continue;
   const saved=await this.attention.read(project.id);
   if(!saved.todos.some(t=>t.status==='open'&&t.attentionKey==='connection:connection'&&t.destination?.kind==='settings'))continue;
   await this.attention.observe(project.id,'connection',[]);const status=await this.status(project.id);this.listener({projectId:project.id,kind:'managed-state',state:status.state});
  }
  for(const project of await this.host.storage.list())if(!project.removed&&project.semanticInitializationEligible)void this.initializeProject(project.id).catch(()=>{});
  if(!this.stopping)await this.resumeUnfinishedProjects();
 }
 async resumeUnfinishedProjects({hostOnly=false}={}){
  if(this.stopping)return {resumed:[],blocked:[]};
  if(this.restartRecoveryFlight)return this.restartRecoveryFlight;
  const operation=(async()=>{
   const result={resumed:[],blocked:[]};
   if(!hostOnly)await this.initializeResources();
   for(const project of await this.host.storage.list()){
    if(this.stopping)break;
    // Removal preserves history, not authorization to resume business or report
    // connection failures against a path that may now belong to a new instance.
    if(project.removed)continue;
    if(this.guidedDemo?.isDemo(project.id))continue;
    try{
     if(!(await this.config(project.id)).enabled)continue;
     if(!(await this.host.storage.managedExecutionSummary(project.id)).pending)continue;
     if(this.stopping||this.projectStops?.has(project.id))continue;
     if(hostOnly){
      // Startup owns this recovery, not a status/report read. A local controller
      // remains unstarted so closure kicks cannot admit queued business or Pi.
      const state=this.controllers.get(project.id)?.store.state??(await this.projectionSource(project.id)).state;
      const closing=state.works.filter(work=>work.status==='closing'&&!work.needsReconciliation&&work.closure?.phase!=='complete'&&confirmedDisposition(work));
      if(!closing.length)continue;
      const controller=await this.loadLocal(project.id);
      for(const work of closing){if(this.stopping)break;await controller.advanceClosure(work.id);}
     }else await this.connect(project.id);
     result.resumed.push(project.id);
    }catch(error){
     result.blocked.push({projectId:project.id,code:error.code??'RESTART_RECOVERY_BLOCKED'});
     if(!this.stopping)try{await this.reportConnectionError(project.id,error);}catch{}
    }
   }
   return result;
  })();
  this.restartRecoveryFlight=operation;
  try{return await operation;}finally{if(this.restartRecoveryFlight===operation)this.restartRecoveryFlight=null;}
 }
 async status(id){
  if(this.guidedDemo?.isDemo(id))return this.demoStatus(id);
  const binding=await this.config(id),controller=this.controllers.get(id),failure=this.connectionErrors.get(id);let state=controller?.snapshot()??null;
  if(!state&&binding.enabled){const source=await this.projectionSource(id);const timeline=await source.index.page();const {sessionIndex,messages,...business}=source.state;state={jobs:[],works:[],todos:[],receipts:[],drafts:{},limit:1,...business,messages:source.index.messages(),timeline,agents:[],quotaUsed:workSlotFacts(business.works??[]).used,configuringTargets:[],externalTerminalTargets:[],nativeDraftTargets:[],busyTargets:[],stopping:false};}
  state=await this.attentionState(id,state,{connected:!!controller});
  return {enabled:binding.enabled===true,ready:controller?.started===true,runtimeRoot:await managedRuntime(this.host.storage,id),state,connectionError:failure?.error??null,handoff:failure?.handoff??null};
 }
 async disposition(id,workId){
  await this.host.requireRegisteredProject(id);const c=this.controllers.get(id),state=c?.store?.state??(await this.projectionSource(id)).state;
  const work=state.works?.find(w=>w.id===workId);if(!work)throw new HostError('WORK_NOT_FOUND','工作不存在');
  const session=c?.sessions?.get(workId),failure=this.connectionErrors.get(id);
  const sessionState=c?.starting?.has(workId)?'starting':session&&!session.closed?'ready':failure?'failed':work.threadId?'sleeping':'notStarted';
  return workDisposition(state,work,{localState:this.flights.has(id)?'loading':c?'available':'unloaded',sessionState});
 }
 // M3 查看保留进展：冷读账本的只读事实投影（disposition 同款边界）。绝不
 // 为读取创建 Controller/Provider——打开视图不启动模型、不恢复、不重放。
 async workProgressRead(id,workId){
  await this.host.requireRegisteredProject(id);
  if(typeof workId!=='string'||!workId.trim()||workId.trim()!==workId||workId.length>200)throw new HostError('INVALID_PAYLOAD','工作身份无效。');
  const c=this.controllers.get(id),state=c&&!c.stopping?c.store.state:(await this.projectionSource(id)).state;
  const work=state.works?.find(w=>w.id===workId);
  if(!work)throw new HostError('WORK_NOT_FOUND','工作不存在');
  return workProgressFacts(state,work,{projectId:id});
 }
 async collaborationStatus(id,{cursor=null,limit=24}={}){
  const project=await this.host.requireRegisteredProject(id),controller=this.controllers.get(id),storage=this.host.storage;
  const binding=(await storage.getLocalRecord(id,'managed:binding'))?.value??{enabled:false};
  let wrapper=null;if(cursor){try{if(typeof cursor!=='string'||cursor.length>8192)throw Error();wrapper=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{throw new HostError('COLLABORATION_CURSOR_STALE','状态游标无效，请刷新。');}}
  if(wrapper&&wrapper.mode!==(controller?'live':'recorded'))throw new HostError('COLLABORATION_CURSOR_STALE','项目运行归属已改变，请刷新。');
  const cached=await storage.managedAgentPage(id,{limit,cursor:!controller?wrapper?.inner:null});
  if(controller&&wrapper?.metadataRevision!==undefined&&wrapper.metadataRevision!==cached.revision)throw new HostError('COLLABORATION_CURSOR_STALE','本机状态已变化，请刷新。');
  const base={projectId:id,instanceId:project.instanceId,controller,recorded:controller?null:cached,slots:[...this.processBudget.slots],capacityAvailable:this.resourceReady?this.processBudget.available:null,enabled:binding.enabled===true,connecting:this.flights.has(id),connectionError:this.connectionErrors.get(id)?.error,limit,cursor:controller?wrapper?.inner:null};
  const initial=collaborationProjection(base),modelOptions=new Map();
  for(const row of initial.agents){const details=await this.modelIntents.snapshot(id,row.target,controller?.sessions?.get(row.target),row.model.lastEffective);modelOptions.set(row.target,details);}
  if(this.controllers.get(id)!==controller)throw new HostError('COLLABORATION_CURSOR_STALE','项目归属已改变，请刷新。');
  const result=collaborationProjection({...base,modelOptions});
  const next=controller?result.nextCursor:cached.nextCursor;
  result.nextCursor=next?Buffer.from(JSON.stringify({mode:controller?'live':'recorded',metadataRevision:cached.revision,inner:next})).toString('base64url'):null;
  result.revision=createHash('sha256').update(result.revision+cached.revision).digest('hex');
  return result;
 }
 async maintenanceStatus(id,options={}){
  const {limit,cursor}=validateMaintenancePage(options),project=await this.host.requireRegisteredProject(id),controller=this.controllers.get(id),liveRevision=maintenanceLiveRevision(controller);
  let wrapper=null;if(cursor){try{wrapper=JSON.parse(Buffer.from(cursor,'base64url').toString());if(wrapper.projectId!==id||wrapper.instanceId!==project.instanceId||wrapper.liveRevision!==liveRevision||typeof wrapper.inner!=='string')throw Error();}catch{throw new HostError('MAINTENANCE_CURSOR_STALE','状态已变化，请刷新。');}}
  const facts=await this.host.storage.managedMaintenancePage(id,{limit,cursor:wrapper?.inner??null,liveFlights:controller&&!controller.stopping?[...(controller.maintenanceFlights?.keys?.()??[])]:[]});
  if(this.controllers.get(id)!==controller||maintenanceLiveRevision(controller)!==liveRevision)throw new HostError('MAINTENANCE_CURSOR_STALE','项目运行状态已变化，请刷新。');
  const revision=createHash('sha256').update(JSON.stringify([id,project.instanceId,facts.revision,liveRevision])).digest('hex');
  const nextCursor=facts.nextCursor?Buffer.from(JSON.stringify({projectId:id,instanceId:project.instanceId,liveRevision,inner:facts.nextCursor})).toString('base64url'):null;
  return maintenancePage({projectId:id,facts,controller,revision,nextCursor});
 }
 // Live per-project release evaluation. Reads controller PUBLIC state only:
 // no prompt synthesis, no owner creation, no re-send. Jobs whose input ever
 // reached the native side are reconciliation-only; only genuinely
 // unadmitted, non-cold, un-held queued work may resume through the ordinary
 // queue pump after the fault gate clears.
 async faultLiveEvaluate(projectId,{fault,batchRef=null,assertCurrent=async()=>true}){
  const controller=this.controllers.get(projectId);
  if(!controller||controller.stopping)return {outcome:'project-disconnected',reason:'项目未连接；未执行任何动作。',detail:[]};
  const rows=[];
  for(const affected of fault.affected??[]){
   const job=controller.store.state.jobs.find(row=>row.id===affected.jobId);
   const work=job?jobBoundWork(controller.store.state,job):null;
   const row={jobId:affected.jobId,...(work?{workId:work.id}:{})};
   if(!job){rows.push({...row,outcome:'stale',reason:'原输入不存在。'});continue;}
   if(!await assertCurrent()||this.controllers.get(projectId)!==controller||controller.stopping){rows.push({...row,outcome:'stale',reason:'项目或故障绑定已变化。'});continue;}
   if(affected.admitted||affected.recordConfirmed){rows.push({...row,outcome:'needs-reconciliation',reason:'原输入已准入；保留原会话和回执，未重放。'});continue;}
   try{
    const receipt=await controller.resumeServiceFaultInput({jobId:job.id,binding:{jobId:job.id,workId:work?.id??null,revision:job.revision??null},faultRef:fault.faultRef,generation:fault.generation,retryKey:batchRef});
    if(receipt.accepted){
     const owner=controller.sessions.get(job.target);
     rows.push({...row,outcome:(!owner||owner.closed)&&!this.processBudget.available?'waiting-capacity':'accepted'});
    }else{
     const outcome=receipt.reason==='cold-input'?'unsupported-cold-recovery':receipt.reason==='manual-held'?'manual-hold':receipt.reason==='fault-held'?'other-fault':receipt.reason==='work-ended'?'ended':'needs-reconciliation';
     rows.push({...row,outcome,reason:receipt.reason});
    }
   }catch(error){rows.push({...row,outcome:error.code==='STALE_SERVICE_FAULT_BINDING'?'stale':'needs-reconciliation',reason:error.code??'recovery-unavailable'});}
  }
  const accepted=rows.filter(row=>row.outcome==='accepted'),waiting=rows.filter(row=>row.outcome==='waiting-capacity');
  const first=accepted[0]??waiting[0]??rows[0]??{outcome:'ended',reason:'没有仍需恢复的输入。'};
  return {...first,acceptedJobs:[...accepted,...waiting].map(row=>row.jobId),detail:rows};
 }

 // Bounded safe-retry executor bridge: the controller transactionally requeues
 // precisely-proven unadmitted failed jobs (delivery identity preserved) and
 // records the attempt receipt; the gateway only schedules and reports.
 // ONE deadline wake per backoff window (event, never polling): expired
 // windows trigger the safe requeue executor + an ordinary pump kick.
 async faultRetryExpired(projectId,faultRef){
  const controller=this.controllers.get(projectId);
  if(!controller||controller.stopping)return;
  return this.serviceFaults.claimRetry(projectId,faultRef,async (generation,token)=>{
   const {record}=await this.serviceFaults.read(projectId);
   const fault=record.faults.find(row=>row.faultRef===faultRef&&row.generation===generation);
   if(!fault)throw new HostError('FAULT_VERSION_STALE','故障恢复代次已变化。');
   const jobIds=fault.retryClaim?.jobIds??[];
   if(!jobIds.length)throw new HostError('FAULT_NO_SAFE_INPUT','没有可安全恢复的原输入。');
   const refused=[];let retried=0;
   for(const jobId of jobIds){
    if(this.controllers.get(projectId)!==controller||controller.stopping)throw new HostError('PROJECT_STOPPING','项目已停止。');
    const job=controller.store.state.jobs.find(row=>row.id===jobId),work=job?jobBoundWork(controller.store.state,job):null;
    if(!job){refused.push({jobId,reason:'job-missing'});continue;}
    const receipt=await controller.resumeServiceFaultInput({jobId,binding:{jobId,workId:work?.id??null,revision:job.revision??null},faultRef,generation,retryKey:token});
    if(receipt.accepted)retried++;else refused.push({jobId,reason:receipt.reason});
   }
   if(!retried)throw new HostError('FAULT_RECOVERY_REFUSED','原输入不能安全重发，需核对。');
   controller.kick();
   return {retried,refused};
  });
 }
 // Credential-free account-config identity input: the nozeli source-config
 // revision per provider (bumped on every credential/config save) from the
 // SHARED private Pi config; key material is never read.
 async providerSourceRevision(provider){
  if(!provider||!this.piSource?.agentDir)return null;
  let raw;
  try{raw=JSON.parse(await fs.readFile(path.join(this.piSource.agentDir,'nozeli-source-revisions.json'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw new HostError('SERVICE_SOURCE_INVALID','服务配置版本无法核实。');}
  if(raw?.schema!==1||!raw.sources||typeof raw.sources!=='object'||Array.isArray(raw.sources))throw new HostError('SERVICE_SOURCE_INVALID','服务配置版本结构无法核实。');
  const revision=raw.sources[provider]?.revision;
  if(revision===undefined)return null;
  if(!Number.isSafeInteger(revision)||revision<0)throw new HostError('SERVICE_SOURCE_INVALID','服务配置版本无效。');
  return revision;
 }
 serviceModelForTarget(projectId,target){
  const choice=this.modelIntents.sourceSelections.get(projectId+':'+target);
  const role=['frontdesk','orchestrator'].includes(target)?target:'worker';
  return choice?.selected??this.serviceRoleModels.get(role)??choice?.recorded??null;
 }
 async prepareServiceSource(projectId,job){
  if(typeof job?.target!=='string')return;
  if(!this.modelIntents.sourceSelections.has(projectId+':'+job.target))await this.modelIntents.read(projectId,job.target);
  const model=this.serviceModelForTarget(projectId,job.target);
  if(typeof model==='string'&&model.includes('/')){
   const provider=model.slice(0,model.indexOf('/'));
   this.serviceFaults.updateSourceRevision(provider,await this.providerSourceRevision(provider));
  }
 }
 async primeServiceSources(){
  for(const role of ['frontdesk','orchestrator','worker']){
   const value=await this.piSource?.roleDefaultsFor?.(role);
   const selector=value?.selector??await this.piSource?.modelFor?.(role);
   if(typeof selector==='string'&&selector.includes('/')){
    this.serviceRoleModels.set(role,selector);
    const provider=selector.slice(0,selector.indexOf('/'));
    this.serviceFaults.updateSourceRevision(provider,await this.providerSourceRevision(provider));
   }
  }
 }
 async saveLocalDraft(id,target,value){
  if(typeof value!=='string'||value.length>32000||typeof target!=='string')throw new HostError('INVALID_PAYLOAD','本地草稿无效');
  if(this.stopping)throw new HostError('APP_CLOSING','应用正在关闭，草稿未覆盖');
  return this.host.storage.withProjectOperation(id,async()=>{
  const current=this.controllers.get(id);if(current)return current.setDraft(target,value);
  this.draftFlights??=new Map();const prior=this.draftFlights.get(id)??Promise.resolve(),connecting=this.flights.get(id);
  const operation=prior.catch(()=>{}).then(async()=>{
    if(connecting){await connecting;const connected=this.controllers.get(id);if(connected)return connected.setDraft(target,value);}
    await this.host.requireRegisteredProject(id);const state=(await this.projectionSource(id)).state;
    if(!['frontdesk','orchestrator'].includes(target)&&!state.works.some(work=>work.id===target&&!['closing','ended'].includes(work.status)))throw new HostError('INVALID_PAYLOAD','草稿所属工作无效');const drafts=await this.host.storage.getRecovery(id,'managed:drafts')??{};drafts[target]=value;await this.host.storage.putRecovery(id,'managed:drafts',drafts);
  }).finally(()=>{if(this.draftFlights.get(id)===operation)this.draftFlights.delete(id);});this.draftFlights.set(id,operation);return operation;
  });
 }
 async loadLocal(id,workId){
  await this.host.requireRegisteredProject(id);
  const state=(await this.projectionSource(id)).state;if(workId!==undefined&&!state.works.some(work=>work.id===workId))throw new HostError('WORK_NOT_FOUND','本地工作账本身份无效');
  await this.connect(id,{enable:true,startResidents:false,localOnly:true});const c=this.controllers.get(id);if(!c)throw new HostError('MANAGED_UNAVAILABLE','项目本地账本不可用');return c;
 }
  // 报告讨论幂等回执（宿主runReviewDecision屏障专用，非公开IPC操作）：
  // 已durable接受的输入按精确摘要返回原回执，未知键null，同键不同载荷抛
  // 碰撞。只读本地账本（controllers.get ?? loadLocal），绝不启动provider。
  async reviewDiscussionReceipt(p){
    if(this.guidedDemo?.isDemo(p?.projectId))return null;
    if(!p||typeof p!=='object'||Array.isArray(p)||typeof p.projectId!=='string'||!p.projectId||typeof p.workId!=='string'||!p.workId)throw new HostError('INVALID_PAYLOAD','报告讨论回执查询参数无效。');
    const c=this.controllers.get(p.projectId)??await this.loadLocal(p.projectId,p.workId);
    return c.reviewDiscussionReceipt(p);
  }
 // 问题决定回执后的续作处置：只读既有事实（job 状态、绑定Work版本、人工
 // 门、偏离、故障门、结算未知、会话生死），沿用 Work 控制既有的
 // {kind,reason,jobId} 词汇；不派工、不入队、不建 owner。
 problemContinuationDisposition(projectId,jobId,decisionRevision=null){
  const controller=this.controllers.get(projectId);
  if(!controller)return {kind:'stale',reason:'controller-missing',jobId};
  if(controller.stopping)return {kind:'connection-required',reason:'PROJECT_STOPPING',jobId};
  const state=controller.store.state;
  const job=(state.jobs??[]).find(j=>j.id===jobId);
  if(!job)return {kind:'stale',reason:'continuation-missing',jobId};
  if(['running','transferring'].includes(job.status))return {kind:'running',reason:'admitted',jobId};
  if(job.status==='completed')return {kind:'completed',reason:'job-completed',jobId};
  if(job.status!=='queued')return {kind:'needs-decision',reason:'job-'+job.status,jobId};
  const work=(state.works??[]).find(w=>w.id===job.target||w.id===job.context?.boundWorkId)??null;
  if(!work)return {kind:'stale',reason:'work-missing',jobId};
  if(['ended','closing'].includes(work.status))return {kind:'needs-decision',reason:'work-'+work.status,jobId};
  // 决定回执绑定的Work版本必须仍是当前版本：工作已前进（新决定、新续作或
  // 人工处置）即被取代，本决定不再唤醒该排队续作。
  const bound=Number.isSafeInteger(job.revision)?job.revision:Number.isSafeInteger(decisionRevision)?decisionRevision:null;
  if(bound!=null&&work.revision!==bound)return {kind:'stale',reason:'decision-binding-stale',jobId};
  if(workControlHeldFor(state,job))return {kind:'manual-held',reason:'manual-gate',jobId};
  if(controller.deviationHeld?.(job.target))return {kind:'needs-decision',reason:'deviation',jobId};
  // 已准入或结算未定的排队回合不得由决定唤醒自动续跑：只给出显式核对入口。
  const attempts=job.collabAttempts??[];
  const unsettled=attempts.some(a=>['unknown','transport-unknown','unresolved','submitted','admitted'].includes(a.status));
  if(unsettled||!neverAdmitted(job)){
   const recovery={op:'managed.recovery.resolve',workId:job.target,revision:job.revision??bound,sourceJob:jobId,todoId:(state.todos??[]).find(t=>t.kind==='recovery'&&t.sourceJobId===jobId&&t.status==='open')?.id??null,inspectOp:'managed.worker.history'};
   return {kind:'needs-reconciliation',reason:unsettled?'settlement-unknown':'admitted-requeue',jobId,recovery};
  }
  // 单job资格以控制器既有的公开评估为准（人工门、故障门、偏离、容量、
  // 存储未知、忙碌）；冷job（重启后从未准入）由唤醒连接的 restore 按原
  // 身份一次性处理，其余结果如实映射。
  let evaluation=null;
  try{evaluation=typeof controller.serviceFaultReleaseEvaluate==='function'?(controller.serviceFaultReleaseEvaluate({jobIds:[jobId]})[0]??null):null;}
  catch{/*评估失败不阻断回执；实际准入仍以泵的既有门为准 */}
  if(evaluation)switch(evaluation.outcome){
   case 'eligible':
   case 'unsupported-cold-recovery':return {kind:'eligible',reason:null,jobId};
   case 'held-manual':return {kind:'manual-held',reason:'manual-gate',jobId};
   case 'fault-held':return {kind:'needs-decision',reason:'service-fault-held',jobId};
   case 'deviation':return {kind:'needs-decision',reason:'deviation',jobId};
   case 'ended':return {kind:'needs-decision',reason:evaluation.reason??'work-ended',jobId};
   case 'busy':return {kind:'waiting-capacity',reason:'owner-busy',jobId};
   case 'waiting-capacity':return {kind:'waiting-capacity',reason:evaluation.reason??'quota-full',jobId};
   case 'needs-reconciliation':return {kind:'needs-reconciliation',reason:evaluation.reason??'storage-unknown',jobId};
   default:return {kind:'needs-decision',reason:evaluation.reason??evaluation.outcome,jobId};
  }
  return {kind:'eligible',reason:null,jobId};
 }
 // 用户对问题报告的显式决定（approve / reject+反馈原文）就是一次显式在线续作
 // 触发：resolveProblem 已在单事务内先落本地 durable CAS 与唯一续作 job（不
 // 依赖任何 provider 或会话）。随后仅当该精确 job 可准入而项目尚未在线时，
 // 走与用户手动连接完全相同的 connect 通道（enable 显式语义：居民启动、
 // prepareOnline 冷转在线、当前模型配置重激活）。不新增任何冷恢复自动唤
 // 醒：完成回放、冷读、无效决定不触发连接、不建 owner、不重放已准入业务；
 // 人工暂停门、结算未知、故障门一律不启动会话。启动/模型/离线失败不丢已
 // 存决定，也不谎报执行中：处置如实报告，后续显式连接按原身份只执行一次。
 async resolveProblemContinuation(p,c){
  const result=await c.resolveProblem(p);
  if(!result||result.accepted!==true||typeof result.jobId!=='string')return result;
  const cold=this.controllers.get(p.projectId)!==c||c.started!==true||c.stopping===true;
  const decisionRevision=Number.isSafeInteger(result.revision)?result.revision:null;
  let executionDisposition=this.problemContinuationDisposition(p.projectId,result.jobId,decisionRevision);
  if(cold&&executionDisposition.kind==='eligible'){
   if(this.stopping)return {...result,executionDisposition:{kind:'connection-required',reason:'APP_CLOSING',jobId:result.jobId}};
   try{await this.connect(p.projectId,{enable:true});}
   catch(error){return {...result,executionDisposition:{kind:'connection-required',reason:error.code??'CONNECT_FAILED',jobId:result.jobId,connection:{code:error.code??'CONNECT_FAILED',message:String(error.message).slice(0,300),target:typeof error.target==='string'?error.target:null}}};}
   const online=this.controllers.get(p.projectId);
   executionDisposition=online?.started===true?this.problemContinuationDisposition(p.projectId,result.jobId,decisionRevision):{kind:'connection-required',reason:'CONNECT_NOT_READY',jobId:result.jobId};
  }
  return {...result,executionDisposition};
 }
 async connect(id,options={}){
  return this.host.storage.withProjectOperation(id,async()=>{
   try{
    const result=await this.connectAttempt(id,options);
    if(result.ready){
     await this.attention.observe(id,'connection',[]);
     const controller=this.controllers.get(id);
     const project=await this.host.requireRegisteredProject(id);
     if(controller?.started&&project.semanticInitializationEligible&&(await this.config(id)).enabled)void controller.initializeProject({expectedProjectInstanceId:project.instanceId}).catch(error=>this.listener({projectId:id,kind:'managed-error',text:'项目整理未启动：'+error.message}));
     if(options.enable===true&&typeof controller?.reactivateModelUnavailableDebug==='function'){
      await controller.reactivateModelUnavailableDebug(null,{explicitReconnect:true});
      result.state=controller.snapshot();
     }
    }
    return {...result,state:await this.attentionState(id,result.state,{connected:!!this.controllers.get(id)})};
   }
   catch(error){await this.reportConnectionError(id,error);throw error;}
  });
 }
 async connectAttempt(id,{enable=false,startResidents=true,localOnly=false}={}){
  if(this.guidedDemo?.isDemo(id))return this.demoStatus(id);
  if(this.stopping)throw new Error('application closing');
  this.host.storage.assertActive(id);
  if(this.projectStops?.has(id))throw new HostError('PROJECT_STOPPING','项目正在停用，未启动新会话');
  if(!localOnly)await this.initializeResources();await this.resourceFlights.get(id);this.projectActivity.set(id,Date.now());
  this.host.storage.assertActive(id);
  const project=await (localOnly?this.host.requireRegisteredProject(id):this.host.requireProject(id));let offline=false;if(localOnly)try{await this.host.storage.requireOnline(id);}catch{offline=true;}if(!enable&&!(await this.config(id)).enabled)return this.status(id);
  if(this.flights.has(id)){await this.flights.get(id);return this.connect(id,{enable,startResidents,localOnly});}
  if(this.controllers.has(id)){
   if(!startResidents)return this.status(id);
   const retained=this.controllers.get(id);if(this.connectionErrors.get(id)?.handoff)return this.status(id);if(retained.started&&(!retained.sessions||['frontdesk','orchestrator'].every(target=>retained.sessions.get(target)&&!retained.sessions.get(target).closed)))return this.status(id);
   const restart=(async()=>{try{await retained.start();this.connectionErrors.delete(id);return this.status(id);}catch(error){let handoff=null,blocked=null;if(error.code==='PI_TOOLS_DIGEST_MISMATCH')try{handoff=await retained.prepareResidentHandoff(error.target);}catch(unsafe){blocked={code:unsafe.code??'HANDOFF_UNSAFE',message:unsafe.message};}this.connectionErrors.set(id,{error:{code:error.code??'RESIDENT_START_FAILED',message:error.message,role:error.target??null,blocked},handoff});throw error;}})().finally(()=>{if(this.flights.get(id)===restart)this.flights.delete(id);});this.flights.set(id,restart);return restart;
  }
  const flight=(async()=>{
   await this.draftFlights?.get(id);
   if(!localOnly){await this.legacy.connectFlight?.get(id);
   const old=this.legacy.projects.get(id);if(old&&this.legacy.roleBusy(old))throw new Error('旧 Agent 有进行中的输入，请先处理再启用三角色');if(old)await this.legacy.stopSlots(old);}
   const versions=new ShadowVersions({projectRoot:project.root,projectId:id,storage:this.host.storage});
   this.versions.set(id,versions);
   // Only adopted bytes belong to the original-root version history.
   const checkpointInFlight=new Set();
   const checkpointAdopted=async event=>{
     if(event.reason!=='accepted-integration')return;
     const workState=controller.store.state.works.find(w=>w.id===event.workId);
     if(!workState||workState.outcome!=='accept'||workState.closure?.git?.status!=='merged')return;
     const relPaths=[...new Set(event.relPaths||event.files||[])];if(!relPaths.length)return;
     const requestId=`work:${workState.id}:accepted:${workState.revision}`;
     if(checkpointInFlight.has(requestId))return;checkpointInFlight.add(requestId);
     try{await versions.checkpoint({requestId,workId:workState.id,workName:workState.name,relPaths});this.listener({projectId:id,kind:'checkpoint-updated',requestId,workId:workState.id});if(await versions.verifyCheckpointBacked(requestId))this.scheduleVersionsGc(id);}
     catch(error){this.listener({projectId:id,kind:'checkpoint-pending',requestId,workId:workState.id,text:'已接受成果的版本检查点未完成：'+error.message});}
     finally{checkpointInFlight.delete(requestId);}
   };
   const frontdeskDocuments=createFrontdeskDocuments({host:this.host,projectId:id,sync:this.beforeDocumentOperation});
   const controller=await this.openController({storage:this.host.storage,offline,localOnly:true,projectId:id,modelIntents:this.modelIntents,processBudget:this.processBudget,runtimeRoot:await managedRuntime(this.host.storage,id),contentRoot:project.root,piSource:this.piSource,piRuntime:this.piRuntime,piAuth:this.piAuth,taskPermissions:this.permissions,privilegeBroker:this.privilegeBroker,resolveRegisteredProject:value=>this.resolveRegisteredProject(id,value),resolveProjectRoot:value=>this.resolveProjectRoot(value),frontdeskDocuments,afterAdoption:(work,receipt)=>recordAdoption({host:this.host,projectId:id,work,receipt}),beforeAccept:async(work,admittedPaths)=>{const paths=Array.isArray(admittedPaths)&&admittedPaths.length?admittedPaths:work.execution?.candidate?.files||[];for(const relPath of paths){const release=await this.beforeDocumentOperation?.({projectId:id,relPath,hold:false});release?.();const draft=await this.host.readDraftRecord(id,relPath);if(draft?.draftError||draft&&draft.status!=='saved')throw new HostError('DRAFT_CONFLICT','成果合入受阻：请先保存或明确处理原项目草稿 '+relPath);}},isolateProcesses:false,readProjectText:async rel=>{const file=await this.host.readFile(id,rel);if(file.draftError)throw new HostError(file.draftError.code||'DRAFT_CONFLICT',file.draftError.message||'项目草稿无法读取。');const draft=file.draft&&file.draft.status!=='saved'?file.draft:null;return {text:draft?.text??file.text,buffer:Boolean(draft),diskVersion:file.digest};},
    // Service-fault integration (single authority: faults module). The hook
    // is fire-and-forget on the controller side; observation failures are
    // surfaced, never thrown into the failing run.
    onServiceFault:fact=>this.serviceFaults.observe(id,fact).catch(error=>{this.serviceFaults.markUnknown(id);this.listener({projectId:id,kind:'managed-error',text:'服务故障记账失败；新任务准入已保守阻断：'+error.message});}),
    serviceFaultGate:job=>this.serviceFaults.gateFor(id,job)});
   try{this.host.storage.assertActive(id);if(this.projectStops?.has(id))throw new HostError('PROJECT_STOPPING','项目正在停用。');}catch(error){controller.stopping=true;await boundedProjectWait(controller.stop(),{timeoutMs:this.stopTimeoutMs});throw error;}
   controller.on('state',state=>{const pending=(this.attentionPublish?.get(id)??Promise.resolve()).catch(()=>{}).then(async()=>{if(this.controllers.get(id)!==controller)return;const merged=await this.attentionState(id,state,{connected:true});this.listener({projectId:id,kind:'managed-state',state:merged});});this.attentionPublish??=new Map();this.attentionPublish.set(id,pending);pending.catch(error=>this.listener({projectId:id,kind:'managed-error',text:'待办持久化失败：'+error.message}));for(const other of this.controllers.values())if(other!==controller&&other.store.state.jobs.some(job=>job.status==='queued'&&(!other.sessions.get(job.target)||other.sessions.get(job.target).closed)))other.kick();});controller.on('diagnostic',text=>this.listener({projectId:id,kind:'managed-error',text}));
   controller.on('timeline',timeline=>this.listener({projectId:id,kind:'managed-timeline',timeline}));
   controller.on('activity',event=>{if(this.controllers.get(id)===controller)this.listener({projectId:id,kind:'managed-activity',revision:event.revision});});
   controller.on('files-changed',event=>{this.adoptionCheckpoints??=new Set();const pending=checkpointAdopted(event);this.adoptionCheckpoints.add(pending);void pending.finally(()=>this.adoptionCheckpoints.delete(pending));this.listener({...event,projectId:id,kind:'managed-files-changed'});});
   controller.on('native-terminal-event',event=>{const {target,screen,method,...payload}=event,terminalId=controller.terminals.get(target)?.terminalId,key=id+':'+target;if(screen)this.listener({projectId:id,kind:'managed-terminal-screen',target,terminalId,...screen});else if(method)this.listener({projectId:id,kind:'managed-terminal-diagnostic',target,terminalId,method});else{if(payload.ended)void this.systemTerminals.close(key);else this.systemTerminals.output(key,payload.data,payload.seq);this.listener({projectId:id,kind:'managed-terminal',target,terminalId,...payload});}});
   this.controllers.set(id,controller);
   // Collaboration aggregate reads the fault gate synchronously (Core-owned
   // DTO field serviceFault); the summary is served from the fault cache.
   controller.serviceFaultSummary=()=>this.serviceFaults.summaryFor(id);
   controller.serviceSourcePrepare=job=>this.prepareServiceSource(id,job);
   controller.serviceRetryRecord=fact=>this.serviceFaults.recordNativeRetry(id,fact).catch(error=>{this.serviceFaults.markUnknown(id);this.listener({projectId:id,kind:'managed-error',text:'原生恢复记录未确认：'+error.message});});
   // Prime the synchronous admission gate from durable state BEFORE any
   // pump can admit (controller.start() runs later in this same flight).
   try{await this.primeServiceSources();await this.serviceFaults.prime(id);}
   catch(error){this.serviceFaults.markUnknown(id);this.listener({projectId:id,kind:'managed-error',text:'故障门状态未能读取；新任务准入已保守阻断：'+error.message});}
   controller.on('state',state=>{if(this.controllers.get(id)===controller){this.serviceFaults.noteProjectState(id,state);this.idleLifecycle.observe();}});
   controller.on('state',state=>{if(this.controllers.get(id)!==controller)return;const job=state.jobs?.findLast(j=>j.type==='project-initialization'&&j.context?.projectInstanceId===project.instanceId),key=JSON.stringify([job?.id,job?.status,job?.projectMap?.version]);if(controller.initializationEventKey===key)return;controller.initializationEventKey=key;this.listener({projectId:id,kind:'initialization-status',status:{schema:1,projectId:id,projectInstanceId:project.instanceId,status:job?.status??'pending',jobId:job?.id??null,map:job?.projectMap??null,errorCode:job?.errorCode??null}});});
   controller.on('lifecycle',({target})=>{if(this.controllers.get(id)===controller)this.idleLifecycle.observeTarget(id,controller,target);});
   this.idleLifecycle.observe();
   if(localOnly)return this.status(id);
   try{
    if(startResidents)await controller.start();
    this.idleLifecycle.observe();
    // 不再独立发现模型：配置和选择全部由正在运行的原生 Agent 负责。
     if(controller.store?.state?.bindings){
       const roles=controller.store.state.bindings;
       const projection={schema:1,enabled:true,roles:{}};
       for(const role of ['frontdesk','orchestrator','worker'])projection.roles[role]={provider:'pi'};
       await this.host.storage.putLocal(id,'managed:binding',projection);
     }
     this.connectionErrors.delete(id);
     return this.status(id);}
   catch(e){if(e.code==='PI_TOOLS_DIGEST_MISMATCH'&&typeof controller.prepareResidentHandoff==='function'){
     let handoff=null,blocked=null;try{handoff=await controller.prepareResidentHandoff(e.target);}catch(error){blocked={code:error.code??'HANDOFF_UNSAFE',message:error.message};}
     this.connectionErrors.set(id,{error:{code:e.code,message:e.message,role:e.target??null,blocked},handoff});
     this.listener({projectId:id,kind:'managed-error',text:'Pi工具协议已变化，原会话保留；需要用户确认新会话接手。'});throw e;
    }if(e.code==='AGENT_PROCESS_LIMIT'){this.connectionErrors.set(id,{error:{code:e.code,message:e.message},handoff:null});throw e;}this.controllers.delete(id);this.idleLifecycle.forget(id);await controller.stop().catch(()=>{});throw e;}
  })().finally(()=>this.flights.delete(id));this.flights.set(id,flight);return flight;
 }
 async handoffResident(id,p){
  if(this.stopping)throw Error('application closing');await this.host.requireProject(id);
  const key=id+':'+p.role;const active=this.handoffFlights.get(key);if(active){if(active.token!==p.token||active.oldThreadId!==p.oldThreadId)throw Error('接手确认已变化，请重新查看当前项目提示');return active;}
  const c=this.controllers.get(id);if(!c||!this.connectionErrors.has(id))throw Error('没有需要确认接手的Pi协议故障');
  const flight=(async()=>{const result=await c.confirmResidentHandoff({role:p.role,token:p.token,oldThreadId:p.oldThreadId});
   this.connectionErrors.delete(id);
   try{await c.start();return {...result,projectId:id,status:await this.status(id)};}catch(error){if(error.code!=='PI_TOOLS_DIGEST_MISMATCH'){this.connectionErrors.set(id,{error:{code:error.code??'HANDOFF_START_FAILED',message:error.message,role:p.role},handoff:null});throw error;}let handoff=null,blocked=null;try{handoff=await c.prepareResidentHandoff(error.target);}catch(unsafe){blocked={code:unsafe.code??'HANDOFF_UNSAFE',message:unsafe.message};}this.connectionErrors.set(id,{error:{code:error.code,message:error.message,role:error.target,blocked},handoff});return {...result,projectId:id,status:await this.status(id)};}
  })().finally(()=>{if(this.handoffFlights.get(key)===flight)this.handoffFlights.delete(key);});flight.token=p.token;flight.oldThreadId=p.oldThreadId;this.handoffFlights.set(key,flight);return flight;
 }
 async residentHistory(id,{role,archiveId,offset=0,version}){
  await this.host.requireRegisteredProject(id);if(!['frontdesk','orchestrator'].includes(role))throw Error('仅支持居民归档历史');
  const c=this.controllers.get(id);const state=c?.store?.state??(await this.projectionSource(id)).state;
  if(['codex','claude','omp'].includes(archiveId)){
   const historical=state.residentArchive?.[role]?.[archiveId];if(!historical?.readOnly)throw Error('历史身份不属于当前项目角色');
   if(!Array.isArray(historical.messages))throw new HostError('HISTORY_UNVERIFIED','旧后端档案没有冻结消息边界；原记录保留，不混入当前Pi对话。');
   const messages=historical.messages;
   return {projectId:id,role,archiveId,provider:archiveId,threadId:historical.threadId,source:'host-message-ledger',...await residentHistoryPage({messages,offset,version})};
  }
  const record=state.residentArchive?.[role]?.handoffs?.find(r=>r.id===archiveId);if(!record||!['omp','pi'].includes(record.provider))throw Error('归档身份不属于当前项目角色');
  if(record.provider==='pi'){
   // Pi 归档：只读账本分页（消息边界已冻结），不解析原生 journal、不重放。
   const messages=(state.messages??[]).filter(message=>message.target===role);
   return {projectId:id,role,archiveId,provider:'pi',threadId:record.threadId,source:'host-message-ledger',...await residentHistoryPage({messages,offset,version})};
  }
  const home=path.join(await managedRuntime(this.host.storage,id),'agents',`resident-${role}-omp`),sessions=path.join(home,'sessions');
  const file=await pinSessionFileById(sessions,record.threadId);if(!file)throw Error('原归档会话文件缺失，未创建替代历史');
  const real=await fs.realpath(file),root=await fs.realpath(sessions);if(!real.startsWith(root+path.sep))throw Error('归档来源越界');
  return {projectId:id,role,archiveId,threadId:record.threadId,...await residentHistoryPage({file:real,offset,version})};
 }
 controller(id){const c=this.controllers.get(id);if(!c?.started||this.stopping)throw new Error('项目三角色尚未就绪');return c;}
 async artifactList(id,objectId){
  const project=await this.host.requireRegisteredProject(id),controller=this.controllers.get(id);
  const options={storage:this.host.storage,project,runtime:await managedRuntime(this.host.storage,id),controller,currentController:()=>this.controllers.get(id)};
  const result=await managedArtifact(options,{objectId});
  // Listing frozen artifacts must remain available even when this object's
  // report body/manifest cannot support a verified presentation appendix.
  try{
    const source=await managedReportSource({...options,objectId});
    return {...result,endMatter:await source.readEndMatter()};
  }catch(error){
    return {...result,endMatter:{projectId:id,objectId,metadataState:'unverified',metadataError:error.message,files:result.files.map(file=>({relPath:file.relPath,candidateDigest:file.digest,change:'unknown'}))}};
  }
 }
 async artifactRead(id,{objectId,relPath}){
  const project=await this.host.requireRegisteredProject(id),controller=this.controllers.get(id);
  if(typeof relPath!=='string')throw new HostError('INVALID_PAYLOAD','成果路径无效。');
  return managedArtifact({storage:this.host.storage,project,runtime:await managedRuntime(this.host.storage,id),controller,currentController:()=>this.controllers.get(id)},{objectId,relPath});
 }
 async reportSource(id,objectId){
  if(this.guidedDemo?.isDemo(id))return this.guidedDemo.reportSource(id,objectId);
  const project=await this.host.requireRegisteredProject(id);
  if(!/^[0-9a-f-]{36}$/i.test(id)||!/^[0-9a-f-]{36}$/i.test(objectId))throw new Error('报告身份无效，未另存。');
  const controller=this.controllers.get(id);
  return managedReportSource({storage:this.host.storage,project,runtime:await managedRuntime(this.host.storage,id),objectId,controller,currentController:()=>this.controllers.get(id)});
 }
 // 后台低优先级清理评估：仅由检查点成功路径触发，按项目去抖；失败只报
 // versions-gc-error，不阻断保存，不谎称成功。阈值经环境变量调（测试用
 // 隔离项目缩短窗口），默认 24h/近100批次保护并集。
 scheduleVersionsGc(id){
  this.versionGcState??={};
  const state=this.versionGcState[id]??={};
  if(state.timer)return;
  const minInterval=Math.max(0,Number(process.env.NOZELI_VERSIONS_GC_MIN_INTERVAL_MS)||0);
  const due=state.lastAt?Math.max(0,state.lastAt+minInterval-Date.now()):0;
  state.timer=setTimeout(()=>{state.timer=null;state.lastAt=Date.now();void this.runVersionsGc(id);},due);
  state.timer.unref?.();
 }
 async runVersionsGc(id){
  const versions=this.versions.get(id);if(!versions)return;
  const num=(k,d)=>{const v=Number(process.env[k]);return Number.isFinite(v)&&v>=0?v:d;};
  const config={
    keepAgeMs:num('NOZELI_VERSIONS_GC_KEEP_AGE_MS',24*60*60*1000),
    keepBatches:num('NOZELI_VERSIONS_GC_KEEP_BATCHES',100),
    maxFiles:num('NOZELI_VERSIONS_GC_MAX_FILES',200),
    maxBytes:num('NOZELI_VERSIONS_GC_MAX_BYTES',64*1024*1024),
    pressureHintBytes:num('NOZELI_VERSIONS_GC_PRESSURE_BYTES',512*1024*1024),
  };
  try{
    const report=await versions.collectGarbage(config);
    this.listener({projectId:id,kind:'versions-gc',report:{scanned:report.scanned,deleted:report.deleted.length,freedBytes:report.freedBytes,remainingBytes:report.remainingBytes,skipped:report.skipped.length,skippedReasons:report.skipped.slice(0,3),pressure:report.pressure,refStable:report.refBefore===report.refAfter}});
  }catch(error){
    this.listener({projectId:id,kind:'versions-gc-error',text:'版本冗余清理未完成（不影响保存与版本读取），将在下次检查点后重试：'+error.message});
  }
 }
 async projectionSource(id){
  await this.host.requireRegisteredProject(id);const storage=this.host.storage,controller=this.controllers.get(id),runtime=await managedRuntime(storage,id);
  if(controller)return {controller,store:controller.store,state:controller.store.state,index:controller.timeline,changes:controller.changes};
  let offline=false;try{await storage.requireOnline(id);}catch{offline=true;}
  const state=decodeReportState(await readManagedState(storage,id,{offline})),store={root:runtime,state,storage,projectId:id,offline,readObject:digest=>readManagedObject(storage,id,digest)};
  migrateReviewLifecycle(state);
  const index=new SessionIndex(store);return {store,state,index,changes:new WorkChanges({runtimeRoot:runtime,storage,projectId:id,readState:()=>state})};
 }
 async timelineQuery(id,action,p){
  if(action==='timeline.read'){
   this.timelineReadFlights??=new Map();
   const run=(this.timelineReadFlights.get(id)??Promise.resolve()).catch(()=>{}).then(async()=>{
    const {index}=await this.projectionSource(id);
    return {entry:await index.read(p.id,{version:p.version,field:p.field,offset:p.offset,limit:p.limit})};
   });
   this.timelineReadFlights.set(id,run);
   try{return await run;}finally{if(this.timelineReadFlights.get(id)===run)this.timelineReadFlights.delete(id);}
  }
  if(action==='timeline.locate'){
   // Read-only anchor resolution for inline task process disclosure: fixed
   // work/source scope, returns the original scoped cursor for timeline.page.
   if(Object.keys(p).some(key=>!['projectId','workId','sourceJobId','messageId'].includes(key))||typeof p.messageId!=='string'||!p.messageId||p.messageId.length>512)throw new HostError('INVALID_PAYLOAD','原记录定位参数无效');
   const {index}=await this.projectionSource(id);
   const scope=index.scope({workId:p.workId,sourceJobId:p.sourceJobId});
   if(!scope)throw new HostError('TIMELINE_SCOPE','任务历史范围无效');
   const row=index.ordered().find(row=>row.id===p.messageId);
   if(!row||row.delta||!scope.matches(row.native??row.legacy)||!Number.isSafeInteger(row.sequence+1))throw new HostError('TIMELINE_SCOPE','原记录不在当前任务范围内');
   const cursor='scope:'+scope.key+':before:'+(row.sequence+1);
   if(!index.select(cursor,1,scope).some(entry=>entry.id===p.messageId))throw new HostError('TIMELINE_SCOPE','原记录定位失败');
   return {messageId:p.messageId,cursor,taskScope:{...(p.workId!==undefined?{workId:p.workId}:{}),...(p.sourceJobId!==undefined?{sourceJobId:p.sourceJobId}:{})}};
  }
  const {index,state}=await this.projectionSource(id);
  if(action==='timeline.request'){
   if(typeof p.requestId!=='string'||!p.requestId||p.requestId.length>512||!Number.isSafeInteger(p.offset??0)||(p.offset??0)<0)throw new HostError('INVALID_PAYLOAD','讨论轮次查询无效');
   const rows=index.records().filter(row=>row.target==='frontdesk'&&row.jobId===p.requestId).sort((a,b)=>a.sequence-b.sequence),offset=p.offset??0;
   const ids=[];for(const row of rows.slice(offset,offset+100)){
    await index.hydrate([row]);let entry=index.nativeDTO(row);
    if(entry?.availability==='read-required')entry=(await this.timelineQuery(id,'timeline.read',{id:row.id})).entry;
    if(entry?.speaker==='agent'||entry?.availability==='unavailable'||entry?.read?.discoveryRequired)ids.push(row.id);
   }
   const job=state.jobs?.find(row=>row.id===p.requestId);
   return {ids,nextOffset:offset+100<rows.length?offset+100:null,...(job?{job:{id:job.id,status:job.status,...(typeof job.error==='string'?{error:job.error.slice(0,4096)}:{})}}:{})};
  }
  return index.page({cursor:p.cursor,limit:p.limit??100,workId:p.workId,sourceJobId:p.sourceJobId});
 }
 async changesQuery(id,action,p){
  if(typeof p.changeSetId!=='string')throw new HostError('INVALID_PAYLOAD','冻结差异身份无效');
  const {state,changes}=await this.projectionSource(id),receipt=state.receipts?.find(r=>r.changeSetId===p.changeSetId);
  if(!receipt)throw new HostError('CHANGES_BINDING','当前项目不存在此冻结结果');
  const expectedBinding={projectId:id,workId:receipt.workId,revision:receipt.revision,jobId:receipt.sourceJobId,receiptId:receipt.id};
  const result=await (action==='changes.list'?changes.list({changeSetId:p.changeSetId,offset:p.offset,limit:p.limit,expectedBinding}):changes.read({changeSetId:p.changeSetId,fileId:p.fileId,maxBytes:p.maxBytes,maxLines:p.maxLines,expectedBinding}));
  const {repo,commonDir,...binding}=result.binding;return {...result,binding};
 }
 async markUnavailable(id,reason){
  const controller=this.controllers.get(id);if(controller){controller.started=false;controller.stopping=true;controller.localOnly=true;controller.store.offline=true;controller.changed();}
  this.connectionErrors.set(id,{error:{code:reason?.code??'PROJECT_UNAVAILABLE',message:reason?.message??'项目不可用；原生执行停止结果待核查'},handoff:null});
  try{return await this.stopProject(id);}catch(error){this.connectionErrors.set(id,{error:{code:error.code??'PI_EXIT_UNCONFIRMED',message:'项目不可用且原生停稳尚未确认：'+error.message},handoff:null});throw error;}
 }
 async stopProject(id,{lifecycleHold,discardState=false}={}){
  this.projectStops??=new Map();if(this.projectStops.has(id))return boundedProjectWait(this.projectStops.get(id),{timeoutMs:this.stopTimeoutMs});
  const current=this.controllers.get(id);if(current){current.started=false;current.stopping=true;}
  this.idleLifecycle.forget(id);this.serviceFaults?.forget(id);
  const versionState=this.versionGcState?.[id];if(versionState?.timer){clearTimeout(versionState.timer);versionState.timer=null;}
  const earlyStop=current?.stop({lifecycleHold,discardState});earlyStop?.catch(()=>{});
  const operation=(async()=>{
   const flights=await Promise.allSettled([this.flights.get(id),this.draftFlights?.get(id),this.resourceFlights.get(id)]);
   const controller=this.controllers.get(id);if(controller){controller.started=false;const receipt=await (controller===current?earlyStop:controller.stop({lifecycleHold,discardState}));if(receipt?.confirmationComplete!==true)throw new HostError('PI_EXIT_UNCONFIRMED','项目进程停稳未确认；保留执行现场');}
   else{
    const providers=(discardState?(await this.host.storage.getLocalRecord(id,'managed:providers'))?.value:await this.host.storage.getLocal(id,'managed:providers'))??{};
    const project=await this.host.requireRegisteredProject(id),runtime=discardState?path.join(this.host.storage.root,'instances',project.instanceId,'execution'):await managedRuntime(this.host.storage,id);
    for(const [target,record] of Object.entries(providers)){
     const receipt=await (record.kind==='pi-node'?recoverPiProvider(record,runtime):['omp-rpc','omp-tui'].includes(record.kind)?recoverOmpProvider(record,runtime):recoverProvider(record,runtime));
     if(receipt?.verified!==true)throw new HostError('PI_EXIT_UNCONFIRMED','本机进程所有权未核实；保留登记和执行现场');
     for(const slot of this.processBudget.slots)if(slot.projectId===id&&slot.target===target)this.processBudget.release(slot);
     delete providers[target];await this.host.storage.putLocal(id,'managed:providers',providers);
    }
   }
   if(current&&current!==this.controllers.get(id))await earlyStop;
   const failed=flights.find(result=>result.status==='rejected'&&result.reason?.code!=='PROJECT_STOPPING');if(failed)throw failed.reason;
   await Promise.all([...this.terminalFlights.entries()].filter(([key])=>key.startsWith(id+':')).map(([,flight])=>flight));
   await Promise.all([...(controller?.sessions?.keys()??[])].map(target=>this.systemTerminals.close(id+':'+target)));
   await Promise.all([this.attentionPublish?.get(id),this.attention.flights.get(id),...(this.adoptionCheckpoints??[])]);
   await this.versions.get(id)?._serial;
   if([...this.processBudget.slots].some(slot=>slot.projectId===id))throw new HostError('PI_EXIT_UNCONFIRMED','项目仍有未核验进程名额；保留隔离');
   if(this.controllers.get(id)===controller)this.controllers.delete(id);this.connectionErrors.delete(id);this.versions.delete(id);
   this.projectActivity.delete(id);this.attentionPublish?.delete(id);if(this.versionGcState)delete this.versionGcState[id];
   if(this.activeProjectId===id)this.activeProjectId=null;return {projectId:id,confirmationComplete:true};
  })().finally(()=>{if(this.projectStops.get(id)===operation)this.projectStops.delete(id);});this.projectStops.set(id,operation);
  return boundedProjectWait(operation,{timeoutMs:this.stopTimeoutMs});
 }
 busy(){return this.flights.size>0||[...this.controllers.values()].some(c=>c.running.size>0||c.closures.size>0);}
 stopVersionsGc(){for(const state of Object.values(this.versionGcState??{})){if(state.timer){clearTimeout(state.timer);state.timer=null;}}}
 async stop(){this.stopping=true;this.idleLifecycle.stop();await this.serviceFaults.stop();this.stopVersionsGc();await this.systemTerminals.stop();await Promise.allSettled([...this.flights.values()]);const drafts=await Promise.allSettled([...(this.draftFlights?.values()??[])]);const results=await Promise.allSettled([...this.controllers.values()].map(c=>c.stop()));await Promise.allSettled([...this.terminalFlights.values()]);await Promise.allSettled([...(this.adoptionCheckpoints??[])]);const reminders=await Promise.allSettled([...(this.attentionPublish?.values()??[]),...this.attention.flights.values()]);this.stopVersionsGc();this.controllers.clear();const error=[...drafts,...results,...reminders].find(r=>r.status==='rejected');if(error)throw error.reason;}
 async invoke(op,p,sourceInput=null){
  if(this.guidedDemo?.isDemo(p?.projectId))return this.guidedDemo.managed(op,p);
  if(op==='managed.frontdesk.route.resolve'&&(!p||typeof p!=='object'||Array.isArray(p)))throw new HostError('INVALID_PAYLOAD','前台去向决定参数必须是对象。');
  const allowed={status:['projectId'],connect:['projectId'],enable:['projectId'],send:['projectId','target','text','relPath','materialText','tags','routingQuestionId','requestKey'],task:['projectId','text','relPath','materialText','tags','routingQuestionId','requestKey'],'intake.retry':['projectId','jobId','requestKey'],draft:['projectId','target','text'],end:['projectId','workId','revision','decision'],retry:['projectId','workId'],restart:['projectId','target'],binding:['projectId','role','skills'],limit:['projectId','limit'],'terminal.screen':['projectId','target'],'terminal.system':['projectId','target'],'terminal.return':['projectId','target'],'terminal.attach':['projectId','target'],'terminal.input':['projectId','target','terminalId','data'],'terminal.resize':['projectId','target','terminalId','cols','rows'],'terminal.close':['projectId','target','terminalId','detach']};
  allowed['terminal.attach']=['projectId','target','ownerId'];
  allowed.send=[...allowed.send,'imageAttachments','drawingSources','preserveDraft','textMaterials','fileAttachments'];allowed.task=[...allowed.task,'imageAttachments','drawingSources','preserveDraft','textMaterials','fileAttachments'];
  allowed.disposition=['projectId','workId'];allowed.end=['projectId','workId','revision','decision','binding','requestKey'];allowed.retry=['projectId','workId','binding','requestKey'];
  allowed['merge.constraint']=['projectId','workId','expectedVersion','decision','requestKey'];
  allowed['versions.list']=['projectId'];
  allowed['resident.handoff']=['projectId','role','token','oldThreadId'];allowed['resident.history']=['projectId','role','archiveId','offset','version'];
  allowed['worker.handoff']=['projectId','workId','revision','oldThreadId','confirmed'];
  allowed['worker.history']=['projectId','workId','archiveId','offset','version'];
  allowed['artifact.read']=['projectId','objectId','relPath'];
  allowed['artifact.list']=['projectId','objectId'];
  allowed['versions.diff']=['projectId','commit','relPath'];
  allowed['versions.restore']=['projectId','commit','relPaths','preps','operationId'];
  allowed['recovery.resolve']=['projectId','todoId','workId','revision','sourceJob','requestKey'];
  allowed['git.retry']=['projectId','todoId','workId','revision','sourceJob','requestKey'];
  allowed['message.task']=['projectId','messageId','text','requestKey'];
  allowed['history.list']=['projectId','version','offset','limit'];
  allowed['history.read']=['projectId','objectId','version'];
  allowed['todo.manage']=['projectId','todoId','expectedRevision','action','requestKey','reason'];
  allowed['deviation.resolve']=['projectId','workId','deviationId','expectedRevision','expectedVersion','action','requestKey'];
  allowed['problem.resolve']=['projectId','workId','objectId','revision','action','text','requestKey'];
  allowed['frontdesk.route.resolve']=['projectId','proposalId','expectedVersion','action','requestKey'];
  allowed['timeline.page']=['projectId','cursor','limit','workId','sourceJobId'];allowed['timeline.read']=['projectId','id','version','field','offset','limit'];
  allowed['timeline.locate']=['projectId','workId','sourceJobId','messageId'];
  allowed['timeline.request']=['projectId','requestId','offset'];
  allowed['attention.ack']=['projectId','ids','occurrences'];
  allowed['attention.respond']=['projectId','todoId','answer','cancel','attentionKind','attentionId','expectedVersion','action','sourceJobId','requestKey'];
  allowed['effect.response']=['projectId','attentionKind','attentionId','expectedVersion','action','sourceJobId','requestKey'];
  allowed['attention.draft.read']=['projectId','todoId'];allowed['attention.draft.write']=['projectId','todoId','expectedText','text'];
  allowed['changes.list']=['projectId','changeSetId','offset','limit'];allowed['changes.read']=['projectId','changeSetId','fileId','maxBytes','maxLines'];
  allowed['review.read']=['projectId','workId','objectId','relPath'];
  allowed['review.save']=['projectId','workId','objectId','relPath','text','restoreRevision','expectedDraftRevision'];
  allowed['review.continue']=['projectId','workId','objectId','reviewVersion','requestKey','instruction'];
  allowed['review.accept']=['projectId','workId','objectId','reviewVersion','requestKey'];
  allowed['review.instruction.read']=['projectId','workId','objectId'];
  allowed['review.instruction.save']=['projectId','workId','objectId','text','expectedRevision'];
  allowed['review.discussion.read']=['projectId','workId','objectId','cursor','limit'];
  allowed['review.discussion.send']=['projectId','workId','objectId','reviewVersion','requestKey','text','applyDrafts'];
  allowed['merge.consent']=['projectId','workId','requestId','expectedVersion','decision','requestKey','binding'];
  allowed['collaboration.status']=['projectId','cursor','limit'];
  allowed['maintenance.status']=['projectId','cursor','limit'];allowed['maintenance.retry']=['projectId','bugId','binding','expectedRetryMode'];allowed['maintenance.scan']=['projectId'];
  // Service faults + manual work control (fault release is app-level and
  // carries its own project membership snapshot; status may scope to one
  // project or aggregate read-only).
  allowed['fault.status']=['projectId','cursor','limit'];
  allowed['fault.release']=['faultRef','expectedVersion','scopeSnapshot','requestKey'];
  allowed['fault.results']=['batchRef','cursor','limit'];
  allowed['work.control']=['projectId','workId','jobId','action','expectedControlVersion','expectedWorkRevision','requestKey','ownerId','ownerGeneration','currentJobId','expectedProjectInstanceId'];
  allowed['work.control.status']=['projectId','workId','jobId'];
  allowed['model.options']=['projectId','target','cursor','limit'];
  allowed['work.progress.read']=['projectId','workId'];
  allowed['model.set']=['projectId','target','ownerId','model','effort','requestKey','expectedRevision','action','workRevision'];
  allowed['session.options']=['projectId','target','ownerId'];
  allowed['session.command']=['projectId','target','ownerId','command','requestKey','jobId'];
  const action=op.slice('managed.'.length);
  if(action.startsWith('initialization.')){
   const command=action.slice('initialization.'.length),keys=command==='status'?['projectId']:command==='read'?['projectId','version','offset']:['projectId','expectedProjectInstanceId'];
   if(!['status','read','retry','cancel'].includes(command)||!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(key=>!keys.includes(key))||typeof p.projectId!=='string'||['retry','cancel'].includes(command)&&typeof p.expectedProjectInstanceId!=='string')throw new HostError('INVALID_PAYLOAD','项目整理参数无效。');
   if(command==='status')return this.initializationStatus(p.projectId);
   if(command==='read')return this.initializationRead(p.projectId,p);
   const project=await this.host.requireRegisteredProject(p.projectId);if(project.instanceId!==p.expectedProjectInstanceId)throw new HostError('PROJECT_INITIALIZATION_STALE','项目实例已变化。');
   if(command==='retry')return this.initializeProject(p.projectId,{retry:true,expectedProjectInstanceId:p.expectedProjectInstanceId});
   const controller=this.controllers.get(p.projectId)??await this.loadLocal(p.projectId);return controller.cancelInitialization(p.expectedProjectInstanceId);
  }
  if(action==='frontdesk.context.clear'){
   if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==1||typeof p.projectId!=='string'||!p.projectId.trim())throw new HostError('INVALID_PAYLOAD','清除前台上下文仅接受 projectId');
   await this.host.requireProject(p.projectId);
   if(this.flights.has(p.projectId)||this.terminalFlights.has(p.projectId+':frontdesk'))throw new HostError('FRONTDESK_CONTEXT_CLEAR_BUSY','前台连接或终端操作尚未完成');
   if(!this.controllers.has(p.projectId))await this.connect(p.projectId,{startResidents:false});
   const controller=this.controllers.get(p.projectId);if(!controller)throw new HostError('FRONTDESK_CONTEXT_CLEAR_UNAVAILABLE','项目尚未启用前台');
   return controller.clearFrontdeskContext();
  }
  if(action==='frontdesk.route.resolve'&&(Object.keys(p).some(k=>!allowed[action].includes(k))||!['projectId','proposalId','requestKey'].every(k=>typeof p[k]==='string'&&p[k].trim()===p[k]&&p[k].length>0&&p[k].length<=200)||!Number.isSafeInteger(p.expectedVersion)||p.expectedVersion<1||!['continue','background','cancel'].includes(p.action)))throw new HostError('INVALID_PAYLOAD','前台去向决定的项目、提议、版本或动作无效。');
  if(action==='attention.respond'&&(!p||typeof p!=='object'||Array.isArray(p)||typeof p.projectId!=='string'||!p.projectId||p.projectId.trim()!==p.projectId||Object.keys(p).some(k=>!allowed[action].includes(k))))throw new HostError('INVALID_PAYLOAD','待办作答参数无效。');
  if(action==='deviation.resolve'&&(Object.keys(p).some(k=>!allowed[action].includes(k))||!['projectId','workId','deviationId','requestKey'].every(k=>typeof p[k]==='string'&&p[k].trim()===p[k]&&p[k].length>0&&p[k].length<=200)||!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<1||!Number.isSafeInteger(p.expectedVersion)||p.expectedVersion<1||!['continue','replan'].includes(p.action)))throw new HostError('INVALID_PAYLOAD','任务偏离决定的身份、版本或动作无效。');
  if(action==='problem.resolve'&&(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!allowed[action].includes(k))||!['projectId','workId','objectId'].every(k=>typeof p[k]==='string'&&p[k].trim()===p[k]&&p[k].length>0&&p[k].length<=200)||!Number.isSafeInteger(p.revision)||p.revision<1||!['approve','reject'].includes(p.action)||(p.text!==undefined&&(typeof p.text!=='string'||p.text.length>32000))||(p.action==='reject'&&!(typeof p.text==='string'&&p.text.trim()))||typeof p.requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(p.requestKey)))throw new HostError('INVALID_PAYLOAD','问题决定的项目、工作、报告、版本、反馈或动作无效。');
  if((action==='history.list'||action==='history.read')&&Object.keys(p).some(k=>!allowed[action].includes(k)))throw new HostError('INVALID_PAYLOAD','历史报告查询参数无效。');
  if(!allowed[action]||Object.keys(p).some(k=>!allowed[action].includes(k)))throw new Error('invalid managed payload');
  // Fault reads aggregate app-level (bounded, cold, zero Controller/owner);
  // release executes one bounded generation with durable per-project facts.
  if(action==='fault.status'){
   if(p.projectId!==undefined&&typeof p.projectId!=='string')throw new HostError('INVALID_PAYLOAD','故障状态范围无效。');
   if(p.projectId)await this.host.requireRegisteredProject(p.projectId);
   return this.serviceFaults.status(p);
  }
  if(action==='fault.release')return this.serviceFaults.release(p);
  if(action==='fault.results')return this.serviceFaults.results(p);
  if(action==='work.control'||action==='work.control.status'){
   // Manual work control delegates to the Core controller integration;
   // cold pure-pause never opens a Controller here.
   const {dispatchWorkControl,workControlCapabilitiesFromState}=await import('./managed/work-control.mjs');
   const project=await this.host.requireRegisteredProject(p.projectId);
   if(action==='work.control'){
    if((p.workId===undefined)===(p.jobId===undefined))throw new HostError('INVALID_PAYLOAD','需要 workId 或 jobId 之一。');
    if(!['pause','stop-current','resume'].includes(p.action))throw new HostError('INVALID_PAYLOAD','人工控制动作无效。');
    if(typeof p.requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(p.requestKey))throw new HostError('INVALID_PAYLOAD','人工控制请求键无效。');
    // Control CAS version is ALWAYS required (first version is 0); the work
    // revision is required whenever the target names an existing Work.
    if(!Number.isSafeInteger(p.expectedControlVersion)||p.expectedControlVersion<0)throw new HostError('INVALID_PAYLOAD','人工控制版本无效。');
    // Conditional revision CAS: workId targets REQUIRE a nonnegative int
    // (0 = queued Work before first activation); jobId targets must OMIT it
    // — the transactional resolver decides bound-Work vs receiving-job.
    if(p.workId!==undefined&&(!Number.isSafeInteger(p.expectedWorkRevision)||p.expectedWorkRevision<0))throw new HostError('INVALID_PAYLOAD','工作修订版本无效。');
    if(p.workId===undefined&&p.expectedWorkRevision!==undefined&&(!Number.isSafeInteger(p.expectedWorkRevision)||p.expectedWorkRevision<0))throw new HostError('INVALID_PAYLOAD','工作修订版本无效。');
    // Frame binding: a mutating control MUST carry the project instance the
    // user saw (exact spelling expectedProjectInstanceId). Verified BEFORE
    // the transaction and re-verified after the await, so a re-registered
    // project never receives a stale frame's control decision.
    if(typeof p.expectedProjectInstanceId!=='string'||!p.expectedProjectInstanceId||p.expectedProjectInstanceId.length>128)throw new HostError('WORK_CONTROL_INVALID','人工控制需要项目实例绑定。');
    if(p.expectedProjectInstanceId!==project.instanceId)throw new HostError('WORK_CONTROL_INSTANCE_STALE','项目实例已变化，请刷新后重试。');
    const result=await dispatchWorkControl(this,p);
    const current=(await this.host.requireRegisteredProject(p.projectId)).instanceId;
    if(current!==project.instanceId)throw new HostError('WORK_CONTROL_INSTANCE_STALE','项目实例在执行中变化；请核对当前状态。');
    return {...result,projectInstanceId:project.instanceId,workRevision:result?.workRevision??null};
   }
   if(p.workId===undefined&&p.jobId===undefined)throw new HostError('INVALID_PAYLOAD','需要 workId 或 jobId。');
   const target=p.workId!==undefined?{workId:p.workId}:{jobId:p.jobId},controller=this.controllers.get(p.projectId);
   // Live: the controller resolves exact owner/job bindings (async since the
   // instance-binding addendum). Cold: the pure projection helper only — no
   // Controller or owner is ever created for a status read.
   if(controller&&!controller.stopping){
    const capabilities=await controller.workControlCapabilities(target);
    return {...capabilities,schema:capabilities?.schema??1,projectId:p.projectId,projectInstanceId:project.instanceId,workRevision:capabilities?.workRevision??null};
   }
   const source=await this.projectionSource(p.projectId),record=source.state.works?.find(w=>w.id===(p.workId??p.jobId))??null;
   const capabilities=workControlCapabilitiesFromState({works:source.state.works??[],jobs:source.state.jobs??[]},target,{live:false,bindingProvider:record?.binding?.provider??record?.provider??null,projectInstanceId:project.instanceId});
   return {...capabilities,schema:capabilities?.schema??1,projectId:p.projectId,projectInstanceId:project.instanceId,workRevision:capabilities?.workRevision??null};
  }
  if(['collaboration.status','model.options','model.set','draft','status','maintenance.status','attention.ack','todo.manage','timeline.page','timeline.read','timeline.request','timeline.locate','resident.history','worker.history','disposition','work.progress.read','history.list','history.read','artifact.read','artifact.list','changes.list','changes.read','review.read','review.save','review.continue','review.accept','review.instruction.read','review.instruction.save','review.discussion.read','merge.consent','merge.constraint'].includes(action))await this.host.requireRegisteredProject(p.projectId);else await this.host.requireProject(p.projectId);
  if(action==='draft')return this.saveLocalDraft(p.projectId,p.target,p.text);
  if(action==='maintenance.status')return this.maintenanceStatus(p.projectId,p);
  if(action==='maintenance.retry'||action==='maintenance.scan'){
   const controller=this.controllers.get(p.projectId);if(!controller||controller.stopping)throw new HostError('MAINTENANCE_OWNER_UNAVAILABLE','项目尚未连接；不会恢复或重放旧任务。');
   if(action==='maintenance.retry'){
    const keys=['projectId','bugId','fingerprint','phase','jobId','workId','revision'],binding=p.binding;
    if(typeof p.bugId!=='string'||!p.bugId||p.bugId.length>256||!binding||typeof binding!=='object'||Array.isArray(binding)||Object.keys(binding).length!==keys.length||Object.keys(binding).some(key=>!keys.includes(key))||binding.projectId!==p.projectId||binding.bugId!==p.bugId||keys.filter(key=>key!=='revision').some(key=>binding[key]!==null&&(typeof binding[key]!=='string'||binding[key].length>256))||binding.revision!==null&&!Number.isSafeInteger(binding.revision))throw new HostError('MAINTENANCE_BINDING_INVALID','修复身份无效，请刷新状态。');
    // The expected mode only ever NARROWS what the button claimed: the host
    // still derives the real mode live and rejects drift (no capability is
    // granted by the expectation itself).
    if(p.expectedRetryMode!==undefined&&!['repair','finalize'].includes(p.expectedRetryMode))throw new HostError('INVALID_PAYLOAD','期望修复模式无效。');
    try{await controller.maintenanceRetry(p.bugId,{binding,...(p.expectedRetryMode!==undefined?{expectedRetryMode:p.expectedRetryMode}:{})});}
    catch(error){if(error?.code==='MAINTENANCE_RETRY_MODE_STALE')throw new HostError('MAINTENANCE_RETRY_MODE_STALE','修复模式已变化（repair/finalize），请刷新状态后重试。');throw error;}
   }else await controller.maintenanceScan();
   return this.maintenanceStatus(p.projectId);
  }
  if(action==='attention.ack'){if(!Array.isArray(p.ids)||p.ids.length>100||p.ids.some(id=>typeof id!=='string'||id.length>160))throw new HostError('INVALID_PAYLOAD','待办通知标识无效');if(p.occurrences!==undefined&&(!Array.isArray(p.occurrences)||p.occurrences.length>100||p.occurrences.some(item=>!item||typeof item!=='object'||typeof item.id!=='string'||item.id.length>160||typeof item.interrupted!=='boolean')))throw new HostError('INVALID_PAYLOAD','待办通知阶段无效');if(p.occurrences===undefined)return this.attention.acknowledge(p.projectId,p.ids);const source=this.controllers.get(p.projectId)?.store?.state??(await this.projectionSource(p.projectId)).state;try{return await this.attention.acknowledge(p.projectId,{ids:p.ids,occurrences:p.occurrences},(source?.todos??[]).map(todo=>({id:todo.id,status:todo.status,interrupted:todo.interrupted})));}catch(error){if(error?.code==='ATTENTION_STALE')throw new HostError('ATTENTION_STALE',error.message);throw error;}}
  if(action==='effect.response'){const q={...p};q.attentionKind=q.attentionKind??'effect-permission';return this.respondAttention(p.projectId,q);}
  if(action==='attention.respond')return this.respondAttention(p.projectId,p);
  if(action==='attention.draft.read'||action==='attention.draft.write')return this.attentionDraft(p.projectId,p,action==='attention.draft.write');
  if(action==='todo.manage'&&(await this.attention.read(p.projectId)).todos.some(t=>t.id===p.todoId)){const source=this.controllers.get(p.projectId)?.store?.state??(await this.projectionSource(p.projectId)).state;return this.attention.manage(p.projectId,p,source);}
  if(action==='collaboration.status')return this.collaborationStatus(p.projectId,p);
  if(action==='status')return this.status(p.projectId);if(action==='enable'||action==='connect')return this.connect(p.projectId,{enable:action==='enable'});
  if(action==='timeline.page'||action==='timeline.read'||action==='timeline.request'||action==='timeline.locate')return this.timelineQuery(p.projectId,action,p);
  if(action==='changes.list'||action==='changes.read')return this.changesQuery(p.projectId,action,p);
  if(action==='resident.handoff')return this.handoffResident(p.projectId,p);
  if(action==='resident.history')return this.residentHistory(p.projectId,p);
  if(action==='worker.history'){const source=await this.projectionSource(p.projectId),work=source.state.works?.find(w=>w.id===p.workId);return readWorkerArchive(source.store,work,{archiveId:p.archiveId,offset:p.offset??0,version:p.version});}
  if(action==='artifact.read')return this.artifactRead(p.projectId,p);
  if(action==='artifact.list')return this.artifactList(p.projectId,p.objectId);
  if(action==='history.list'||action==='history.read'){
   const project=await this.host.requireRegisteredProject(p.projectId),controller=this.controllers.get(p.projectId);
   if(action==='history.read'&&typeof p.objectId!=='string')throw new HostError('INVALID_PAYLOAD','历史报告查询参数无效。');
   const {projectId,...query}=p;
   return managedHistory({storage:this.host.storage,project,runtime:await managedRuntime(this.host.storage,projectId),controller,currentController:()=>this.controllers.get(projectId)},query);
  }
  if(action==='versions.list'||action==='versions.diff'||action==='versions.restore'){
   const versions=this.versions.get(p.projectId);
   if(!versions)return action==='versions.list'?{checkpoints:[],pending:[]}:null;
   if(action==='versions.list'){
     const [checkpoints,pending]=await Promise.all([versions.list(),versions.pending()]);
     return {checkpoints,pending};
   }
   if(action==='versions.diff'){
     if(typeof p.commit!=='string'||!/^[0-9a-f]{40}$/.test(p.commit))throw new HostError('INVALID_PAYLOAD','检查点提交无效。');
     // Sync the latest human buffer through the managed document-sync channel
     // BEFORE freezing what the user sees: the prep record fixes this view.
     const syncOp=this.beforeDocumentOperation??(async()=>()=>{});
     const release=await syncOp({projectId:p.projectId,relPath:p.relPath,hold:false});release?.();
     const bytes=await versions.readProjectBytes(p.relPath);
     let currentText;try{currentText=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{currentText=null;}
     const prep=await versions.prepare({commit:p.commit,relPath:p.relPath,currentDigest:createHash('sha256').update(bytes).digest('hex')});
     return {prepId:prep.prepId,at:prep.at,relPath:p.relPath,checkpointText:prep.checkpointText,checkpointDigest:prep.checkpointDigest,currentText,currentDigest:createHash('sha256').update(bytes).digest('hex')};
   }
   if(typeof p.commit!=='string'||!/^[0-9a-f]{40}$/.test(p.commit))throw new HostError('INVALID_PAYLOAD','检查点提交无效。');
   // Restore references the preps the user viewed; baselines are never
   // re-fixed here. sync() flushes the latest buffer before each managed save.
   return versions.restoreThroughManagedSave({
     host:this.host,projectId:p.projectId,commit:p.commit,relPaths:p.relPaths,preps:p.preps,
     actor:{id:'nozeli:restore',kind:'user',name:'版本恢复',mark:'R'},operationId:p.operationId,
     sync:async relPath=>{const syncOp=this.beforeDocumentOperation??(async()=>()=>{});const release=await syncOp({projectId:p.projectId,relPath,hold:false});release?.();},
   });
  }
  if(action==='todo.manage'){
    const controller=this.controllers.get(p.projectId);
    if(controller)return controller.manageTodo(p);
    // Local reminder management never requires starting a Provider.
    const {manageTodoState}=await import('../domain/todo-management.mjs');
    const project=await this.host.requireProject(p.projectId);
    const store=await Workspace.open(await managedRuntime(this.host.storage,p.projectId),project.root,{storage:this.host.storage,projectId:p.projectId,recoverStale:true});
    try{return await store.mutate(()=>manageTodoState(store.state,p));}finally{await store.close();}
  }
  if(action==='disposition')return this.disposition(p.projectId,p.workId);
  if(action==='work.progress.read')return this.workProgressRead(p.projectId,p.workId);
  if(action==='review.instruction.read'||action==='review.instruction.save'){
    // 指令草稿必须在review.*前匹配：否则坠入reviewAccept的令牌校验
    // （'审校版本令牌无效'），专用分支成为死代码。
    const c=this.controllers.get(p.projectId)??await this.loadLocal(p.projectId,p.workId);
    return action==='review.instruction.read'?c.reviewInstructionRead(p):c.reviewInstructionSave(p);
  }
  if(action==='review.discussion.read'||action==='review.discussion.send'){
    // 报告讨论：读取=纯历史本地（loadLocal，绝不启动provider）；发送=与
    // 续作/接受同级的本地决定（宿主runReviewDecision屏障先行），job由宿主
    // 调度到原Worker线程。
    const c=this.controllers.get(p.projectId)??await this.loadLocal(p.projectId,p.workId);
    return action==='review.discussion.read'?c.reviewDiscussionRead(p):c.reviewDiscussionSend(p);
  }
  if(action.startsWith('review.')){
    // 审校四操作都走本地账本：读取/保存随时可用；续作/接受与 managed.end
    // 同级（本地决定，宿主调度），不依赖前台或模型在线。
    const c=this.controllers.get(p.projectId)??await this.loadLocal(p.projectId,p.workId);
    if(action==='review.read')return c.reviewRead(p);
    if(action==='review.save')return c.reviewSave(p);
    if(action==='review.continue')return c.reviewContinue(p);
    return c.reviewAccept(p);
  }
  if(action==='model.options'||action==='model.set'){
   if(typeof p.target!=='string'||!p.target.trim()||p.target.length>200)throw new HostError('INVALID_PAYLOAD','需要原角色或工作身份');
   const controller=this.controllers.get(p.projectId),session=controller?.sessions?.get(p.target);
   const page=await this.host.storage.managedAgentPage(p.projectId,{limit:1,target:p.target});
   const targetKnown=['frontdesk','orchestrator'].includes(p.target)||(page.works??[]).some(w=>(w.target??w.id)===p.target);
   if(!['frontdesk','orchestrator'].includes(p.target)&&!controller?.store?.state?.works?.some(work=>work.id===p.target)&&!targetKnown)throw new HostError('MODEL_TARGET_UNKNOWN','目标Agent不存在；不会创建新工作');
   const record=controller?.store?.state?.works?.find(work=>work.id===p.target)??(page.works??[]).find(w=>(w.target??w.id)===p.target),resident=page.residents?.[p.target];
   const intent=await this.modelIntents.snapshot(p.projectId,p.target,session,resident?{model:resident.model??null,effort:resident.effort??null}:null);
   if(action==='model.options'){
    const catalog=this.modelCatalog?await this.modelCatalog():null;
    return {models:catalog??[],...intent,ownerId:session&&!session.closed?session.viewOwnerId:null,ownerGeneration:session&&!session.closed?session.epoch:null,workRevision:record?.revision??null,workName:record?.name??null,pending:['saved','pending','submitted'].includes(intent.state)?intent.desired:null,modelError:modelErrorDTO(session?.modelError),thinkingLevels:session?.thinkingLevels??null,available:!record?.readOnly&&!record?.contextRecovery&&(!record?.provider||record.provider==='pi')&&(!record?.binding?.provider||record.binding.provider==='pi')&&!['ended','closing'].includes(record?.status)&&session?.activitySnapshot?.().known!==false&&!controller?.stopping&&!controller?.store?.commitUnknown&&!controller?.store?.nativeCommitUnknown&&!['submitted','unknown'].includes(intent.state)&&!((!session||session.closed)&&(page.providers??[]).some(value=>value.target===p.target)),ownerAvailable:Boolean(session&&!session.closed)};
   }
   if(typeof p.requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(p.requestKey)||!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<0)throw new HostError('INVALID_PAYLOAD','模型选择需要请求键和配置版本');
   if(p.model!==undefined&&(typeof p.model!=='string'||!p.model.includes('/'))||p.effort!==undefined&&!THINKING_LEVELS.includes(p.effort))throw new HostError('INVALID_PAYLOAD','模型或思考档位选择无效');
   const actionName=p.action??'set';
   if(!['set','inherit','cancel'].includes(actionName)||(actionName==='set'&&p.model===undefined&&p.effort===undefined))throw new HostError('INVALID_PAYLOAD','模型动作无效');
   if(record?.readOnly||record?.contextRecovery||record?.provider&&record.provider!=='pi'||record?.binding?.provider&&record.binding.provider!=='pi'||['closing','ended'].includes(record?.status))throw new HostError('HISTORICAL_SESSION_READ_ONLY','历史会话仅可查看，不能覆盖模型');
   if(session&&!session.closed&&p.ownerId!==session.viewOwnerId)throw new HostError('INTERACTION_STALE','需要当前原生owner确认，请刷新模型菜单。');
   if(session&&!session.closed&&session.activitySnapshot?.().known===false)throw new HostError('PI_ACTIVITY_UNKNOWN','原生状态待核实，未覆盖模型。');
   if(controller?.store?.commitUnknown||controller?.store?.nativeCommitUnknown)throw new HostError('STORAGE_RESULT_UNKNOWN','宿主提交结果待核实，模型保持不变。');
   if((!session||session.closed)&&(page.providers??[]).some(value=>value.target===p.target)||[...this.processBudget.slots].some(value=>value.projectId===p.projectId&&value.target===p.target&&value.state==='unconfirmed'))throw new HostError('PI_OWNER_UNCONFIRMED','原执行进程尚未核实，未覆盖模型。');
   if(!['frontdesk','orchestrator'].includes(p.target)&&(!Number.isSafeInteger(p.workRevision)||p.workRevision!==record?.revision))throw new HostError('MODEL_TARGET_STALE','需要当前工作修订，模型选择未保存。');
   const role=['frontdesk','orchestrator'].includes(p.target)?p.target:'worker',defaults=actionName==='inherit'?await this.piSource?.roleDefaultsFor?.(role):null;
   const selected=actionName==='inherit'?(defaults?.selector?{model:defaults.selector,effort:defaults.effort??null}:null):{model:p.model??intent.desired?.model??intent.effective?.model??resident?.model,effort:p.effort??intent.desired?.effort??resident?.effort??null};
   if(actionName==='set'&&(!selected?.model||!selected.model.includes('/')))throw new HostError('INVALID_PAYLOAD','缺少模型选择');
   if(actionName==='set'&&this.modelCatalog){const catalog=await this.modelCatalog();if(!catalog.some(model=>model.selector===selected.model||model.provider+'/'+model.id===selected.model))throw new HostError('PI_MODEL_UNAVAILABLE','模型不在当前可用目录中，未保存选择。');}
   const assertCurrent=()=>{const latestController=this.controllers.get(p.projectId),latest=latestController?.sessions?.get(p.target);if(latestController?.stopping||this.host.storage.lifecycleHolds?.has(p.projectId))throw new HostError('PROJECT_STOPPING','项目正在停用，未修改模型。');if(latest&&!latest.closed&&p.ownerId!==latest.viewOwnerId||p.ownerId!==undefined&&(!latest||latest.closed||latest.viewOwnerId!==p.ownerId))throw new HostError('INTERACTION_STALE','模型菜单所属会话已变化');const latestWork=latestController?.store?.state?.works?.find(w=>w.id===p.target)??record;if(latestWork?.readOnly||latestWork?.contextRecovery||['ended','closing'].includes(latestWork?.status)||p.workRevision!=null&&latestWork?.revision!==p.workRevision)throw new HostError('MODEL_TARGET_STALE','目标工作已变化，请刷新。');};
   const result=await this.modelIntents.request(p.projectId,p.target,{...p,action:actionName},{session:session&&!session.closed?session:null,selection:selected,assertCurrent});
   controller?.changed?.();return result;
  }
  if(action==='terminal.screen'&&!this.controllers.has(p.projectId))return {available:false,reason:'Worker 终端尚未就绪或已断开；预览不会启动新会话。'};
  const localAction=['end','retry','merge.consent','merge.constraint','deviation.resolve','problem.resolve'].includes(action);
  if(localAction&&((['end','retry'].includes(action)&&!p.binding)||typeof p.requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(p.requestKey)))throw new HostError('INVALID_PAYLOAD','需要当前处置绑定和确认身份');
  const c=localAction?(this.controllers.get(p.projectId)??await this.loadLocal(p.projectId,p.workId)):this.controller(p.projectId);
  if(action==='session.options')return c.sessionOptions(p.target,p.ownerId);
  if(action==='session.command')return c.sessionCommand(p.target,p);
  if(action==='deviation.resolve')return c.resolveDeviation(p);
  if(action==='problem.resolve')return this.resolveProblemContinuation(p,c);
  if(action==='frontdesk.route.resolve')return c.resolveFrontdeskRoute(p);
  const assertNotHeld=()=>{const work=c.store.state.works.find(w=>w.id===p.target);if(work?.status!=='ended'&&['pending','replanned'].includes(work?.deviation?.status))throw new HostError('WORK_DEVIATION_HELD','此工作因任务偏离暂停；请使用任务偏离决定按钮明确授权。普通输入、重启或终端不能恢复执行。');};
  if(['restart','terminal.system','terminal.attach','terminal.input'].includes(action))assertNotHeld();
  if(['terminal.system','terminal.attach','terminal.input'].includes(action))c.assertFrontdeskContextAdmission(p.target);
  if(action==='worker.handoff'){if(p.confirmed!==true||typeof p.oldThreadId!=='string'||!p.oldThreadId||!Number.isInteger(p.revision))throw new HostError('INVALID_PAYLOAD','请明确确认原 Worker 会话接手。');return c.recoverWorkerContext(p.workId,{revision:p.revision,oldThreadId:p.oldThreadId,confirmed:true});}
  if(['task','intake.retry','message.task'].includes(action)&&!(typeof p.requestKey==='string'&&/^[a-zA-Z0-9:_-]{8,160}$/.test(p.requestKey)))throw Error('invalid submission key');
  if(action==='message.task')return c.convertMessage(p.messageId,p.text,{requestKey:p.requestKey});
  if(action==='intake.retry')return c.retryIntake(p.jobId,p.requestKey);
  if(action==='recovery.resolve'||action==='git.retry')return c.resolveOpenTodo(action==='git.retry'?'git':'recovery',p);
  if(action==='send'||action==='task'){
   if(p.requestKey!=null&&!(typeof p.requestKey==='string'&&/^[a-zA-Z0-9:_-]{8,160}$/.test(p.requestKey)))throw Error('invalid submission key');
   if(typeof p.text!=='string'||!p.text.trim())throw new Error('输入为空');
   const submissionDigest=createHash('sha256').update(JSON.stringify([p.target||'frontdesk',p.text,p.relPath,p.materialText,p.tags,p.routingQuestionId,p.imageAttachments,p.drawingSources,p.textMaterials,p.fileAttachments,...(sourceInput?[sourceInput]:[])])).digest('hex');
   const previous=p.requestKey&&c.store.state.jobs.find(j=>j.key===(action==='task'?'task:':'input:')+p.requestKey);
   if(previous){if(previous.context?.submissionDigest!==submissionDigest)throw Error('submission key collision');return {accepted:true,jobId:previous.id};}
   // Raw user text stays verbatim; every explicit material is frozen into a
   // versioned object at send time and travels as native material data in the
   // same transaction — never spliced into the user's text string.
   const text=p.text;const materials=[];const now=new Date().toISOString();
   if(p.textMaterials!=null){
    if(!Array.isArray(p.textMaterials)||p.textMaterials.length>20)throw new HostError('INVALID_PAYLOAD','显式文本材料最多20项。');
    for(const [index,item]of p.textMaterials.entries()){
     if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['kind','text','title'].includes(key))||!['reply-quote','drawing-question'].includes(item.kind)||typeof item.text!=='string'||!item.text.trim()||Buffer.byteLength(item.text,'utf8')>256*1024||item.title!==undefined&&(typeof item.title!=='string'||item.title.length>200))throw new HostError('INVALID_PAYLOAD','显式文本材料的类型、正文或大小无效，未发送。');
     const version=await c.store.putObject(Buffer.from(item.text,'utf8'));
     materials.push({id:'text:'+index+':'+item.kind,version,title:item.title||'用户选择的文本材料',kind:item.kind,provenance:{source:'explicit-'+item.kind,versionLabel:'frozen-at-send',fetchedAt:now}});
    }
   }
   if(p.relPath&&!p.tags?.length){const file=await this.host.readFile(p.projectId,p.relPath),material=p.materialText??file.draft?.text??file.text;if(typeof material!=='string')throw new Error('无法获取当前文本材料');const fromDraft=material===(file.draft?.text??null);const version=await c.store.putObject(Buffer.from(material,'utf8'));materials.push({id:'file:'+p.relPath,version,title:file.relPath,kind:'file-material',provenance:{source:file.relPath,versionLabel:fromDraft?'draft-at-send':'saved-at-send',fetchedAt:now}});}
   const packets=[];if(p.tags?.length){if(!Array.isArray(p.tags)||p.tags.length>20)throw Error('备注材料最多20项');for(const ref of p.tags)packets.push(await this.host.tagMaterial(p.projectId,ref));}
   const material=packets.length?tagMaterialSnapshot(packets):null;
   if(material){
    if(await c.store.putObject(Buffer.from(material.full))!==material.version)throw Error('冻结讨论材料摘要不一致');
    for(const packet of packets){const readable=readableTagMaterial(packet),version=await c.store.putObject(Buffer.from(readable,'utf8'));materials.push({id:'tag:'+packet.tagId,version,title:packet.relPath,kind:'tag-material',changed:packet.resolution?.targetDigest!==packet.origin?.materialDigest,notePresent:Boolean(packet.note?.trim()),provenance:{source:packet.relPath,versionLabel:'frozen-selection',fetchedAt:now}});}
   }
   if(p.imageAttachments!=null&&(!Array.isArray(p.imageAttachments)||p.imageAttachments.length>8))throw Error('每次最多8张图片');
   const drawingImages=[],drawingSources=[];let imageBytes=0;
   for(const ref of p.imageAttachments||[]){const sources=await this.host.drawingImageSources(p.projectId,ref),promoted=await this.host.attachments.promote(p.projectId,ref,{sources});if(promoted.mime!=='image/png'||promoted.source!=='drawing')throw Error('仅支持已登记的涂鸦 PNG');imageBytes+=promoted.size;drawingImages.push(promoted);drawingSources.push({digest:promoted.digest,sourceManifest:promoted.sourceManifest,sources});}
   const imageAttachments=[...preferredRegionAssets(packets).map(a=>({digest:a.digest,mime:'image/png',storage:'project',projectId:p.projectId})),...drawingImages];
   for(const ref of imageAttachments.filter(ref=>!drawingImages.includes(ref))){const bytes=await this.host.storage.readObject(p.projectId,ref.digest);if(bytes.length>8*1024*1024)throw Error('单张图片超过8MiB');imageBytes+=bytes.length;}
   if(imageAttachments.length>8||imageBytes>24*1024*1024)throw Error('图片超过8张或24MiB');
   // Registered non-drawing local text references ride their own channel: the
   // host re-verifies the ProjectAttachments registry (cross-project, forged,
   // stale-instance and corrupted refs all fail promote/readBytes), refuses
   // declared binary families regardless of decodable bytes, and freezes the
   // exact registered bytes as a file material. Drawings stay on the image
   // channel; acceptance is registry+content truth, never an HTML/extension
   // special case, and no PDF/Office parsing happens here.
   const fileAttachments=[];
   if(p.fileAttachments!=null){
    if(!Array.isArray(p.fileAttachments)||p.fileAttachments.length>20)throw new HostError('INVALID_PAYLOAD','文件附件最多20个。');
    const fileAttachmentKeys=['digest','mime','source','storage','projectId','instanceId'];
    for(const ref of p.fileAttachments)if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).some(key=>!fileAttachmentKeys.includes(key)))throw new HostError('INVALID_PAYLOAD','文件附件引用字段无效，未发送。');
    const binaryExtensions=new Set(['.pdf','.zip','.gz','.tgz','.bz2','.xz','.7z','.rar','.tar','.jar','.exe','.dll','.so','.dylib','.bin','.class']);
    const binaryMimes=/^(?:image|audio|video)\//;
    const officeMimes=/^application\/(?:pdf|zip|x-zip-compressed|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|java-archive|x-msdownload|x-executable|x-sharedlib|msword|vnd\.ms-(?:excel|powerpoint)|vnd\.openxmlformats-officedocument\.|x-ms-installer)/;
    let fileAttachmentBytes=0;
    for(const [index,ref] of p.fileAttachments.entries()){
     if(ref.source==='drawing')throw new HostError('INVALID_PAYLOAD','涂鸦材料须以图片附件发送，不能占用文件附件通道。');
     const promoted=await this.host.attachments.promote(p.projectId,ref);
     if(promoted.source==='drawing')throw new HostError('INVALID_PAYLOAD','涂鸦材料须以图片附件发送，不能占用文件附件通道。');
     const extension=path.posix.extname(promoted.name).toLowerCase();
     if(imageExtension.test(promoted.name)||OFFICE_EXT.has(extension)||binaryExtensions.has(extension)||binaryMimes.test(promoted.mime)||officeMimes.test(promoted.mime))throw new HostError('INVALID_PAYLOAD','文件附件 '+promoted.name+' 是声明的二进制格式，不能作为文本材料发送。');
     if(promoted.size>8*1024*1024)throw new HostError('INVALID_PAYLOAD','文件附件 '+promoted.name+' 超过8MiB。');
     fileAttachmentBytes+=promoted.size;
     if(fileAttachmentBytes>24*1024*1024)throw new HostError('INVALID_PAYLOAD','文件附件总量超过24MiB，未发送。');
     const bytes=await this.host.storage.readObject(p.projectId,promoted.digest);
     if(!isUtf8Text(bytes))throw new HostError('INVALID_PAYLOAD','文件附件 '+promoted.name+' 不是有效 UTF-8 文本（含 NUL 或非法字节），未发送。');
     const version=await c.store.putObject(bytes);
     if(version!==promoted.digest)throw new HostError('INVALID_PAYLOAD','文件附件 '+promoted.name+' 冻结内容与登记摘要不一致，未发送。');
     materials.push({id:'file-attachment:'+index+':'+promoted.digest,version,title:promoted.name,kind:'file-material',provenance:{source:'attachment:'+promoted.name,versionLabel:'frozen-at-send',fetchedAt:now}});
     fileAttachments.push({digest:promoted.digest,mime:promoted.mime,storage:'project',projectId:p.projectId,name:promoted.name,size:promoted.size,source:promoted.source,sourceManifest:promoted.sourceManifest});
    }
   }
   if(p.routingQuestionId&&!c.store.state.todos.some(t=>t.id===p.routingQuestionId&&t.kind==='routing'&&t.status==='open'))throw new Error('澄清问题已过期');
   const context={...(p.requestKey?{submissionDigest}:{}),...(p.routingQuestionId?{routingQuestionId:p.routingQuestionId}:{}),...(imageAttachments.length?{imageAttachments}:{}),...(fileAttachments.length?{fileAttachments}:{})};
   if(material)context.tagMaterial={version:material.version,binding:material.binding,brief:material.brief,reusable:material.reusable};
   if(drawingImages.length){context.drawingSources=drawingSources;const version=await c.store.putObject(Buffer.from(JSON.stringify(drawingSources),'utf8'));materials.push({id:'drawing-sources',version,title:'涂鸦截图来源（未锚定文件的画面仅作工作区素材）',kind:'drawing-sources',provenance:{source:'drawing-attachments',versionLabel:'frozen-at-send',fetchedAt:now}});}
   if(materials.length)context.materials=materials;
   if(p.tags?.length||p.textMaterials?.length||fileAttachments.length)context.materialsExplicit=true;
   if(packets.length)context.userInput={text:p.text,sources:packets.map(packet=>({relPath:packet.relPath,annotationId:packet.tagId,materialDigest:packet.origin?.materialDigest,quote:packet.origin?.anchor?.quote||'',location:packet.information?.location?.label||'',changed:packet.resolution?.targetDigest!==packet.origin?.materialDigest}))};
   if(sourceInput)context.userInput=structuredClone(sourceInput);
   return action==='task'?c.submitTask(text,{requestKey:p.requestKey,context,draftText:p.text,preserveDraft:p.preserveDraft===true}):c.send(p.target||'frontdesk',text,{requestKey:p.requestKey,context,draftText:p.text,preserveDraft:p.preserveDraft===true});
  }
  if(action==='end'){if(!['accept','discard'].includes(p.decision))throw new HostError('INVALID_PAYLOAD','请选择接受或丢弃成果。');return c.endWork(p.workId,{revision:p.revision,decision:p.decision,binding:p.binding,requestKey:p.requestKey});}
  if(action==='retry')return c.retryClosure(p.workId,{binding:p.binding,requestKey:p.requestKey});
  if(action==='merge.consent'){if(!['approve','deny'].includes(p.decision))throw new HostError('INVALID_PAYLOAD','请选择批准或拒绝合入覆盖。');return c.resolveMergeConsent(p.workId,{requestId:p.requestId,expectedVersion:p.expectedVersion,action:p.decision,requestKey:p.requestKey,binding:p.binding});}
  if(action==='merge.constraint'){if(!['never-commit','hold','none'].includes(p.decision))throw new HostError('INVALID_PAYLOAD','请选择有效的合入约束。');if(!Number.isSafeInteger(p.expectedVersion)||p.expectedVersion<0)throw new HostError('INVALID_PAYLOAD','合入约束版本无效。');return c.resolveMergeConstraint(p.workId,{expectedVersion:p.expectedVersion,choice:p.decision,requestKey:p.requestKey});}
  if(action==='restart'){await this.systemTerminals.close(p.projectId+':'+p.target);const session=await c.restart(p.target);return {restarted:true,target:p.target,threadId:session.threadId,closed:session.closed};}
  if(action==='binding'){const value=await c.setBinding(p.role,{skills:p.skills});
    // Provider selection and executable trust remain local to this instance.
    const roles=c.store.state.bindings;const projection={schema:1,enabled:true,roles:{}};
    for(const role of ['frontdesk','orchestrator','worker'])projection.roles[role]={provider:'pi'};
    await this.host.storage.putLocal(p.projectId,'managed:binding',projection);
    return value;}
  if(action==='limit'){if(!Number.isInteger(p.limit)||p.limit<1||p.limit>16||p.limit<c.store.used())throw new Error('额度须为1–16且不小于当前占用');await c.store.mutate(()=>{c.store.state.limit=p.limit;});c.changed();c.kick();return {saved:true};}
  if(action==='terminal.screen'){
   const work=c.store.state.works.find(w=>w.id===p.target);
   if(!work)throw Error('只能预览当前项目的工作Agent');
   if(['ended','closing'].includes(work.status))return {available:false,reason:'工作已结束或正在归档，不恢复终端。'};
   if(work.status==='queued')return {available:false,reason:'工作正在排队，Worker 尚未启动。'};
   const terminal=c.terminals.get(p.target);
   if(!terminal||terminal.closed||!terminal.snapshot)return {available:false,reason:'Worker 终端尚未就绪或已断开；预览不会启动新会话。'};
   const screen=await terminal.snapshot();
   if(c.terminals.get(p.target)!==terminal||terminal.closed||['ended','closing'].includes(c.store.state.works.find(w=>w.id===p.target)?.status))return {available:false,reason:'终端已断开或工作已结束。'};
   return {available:true,terminalId:terminal.terminalId,threadId:terminal.threadId,...screen};
  }
  const key=p.projectId+':'+p.target;
  if(action==='terminal.system'){
   const terminal=c.terminals.get(p.target);if(!terminal||terminal.closed)throw Error('请等待内置终端连接就绪，再打开系统终端。');
   return this.systemTerminals.open({key,terminal,cwd:terminal.cwd||c.store.state.contentRoot,onState:active=>{if(active)c.externalTerminalTargets.add(p.target);else c.externalTerminalTargets.delete(p.target);c.changed();}});
  }
  if(action==='terminal.return'){await this.systemTerminals.close(key);return {returned:true};}
  if(action==='terminal.close'&&p.detach===true)return {detached:true};
  if(action==='terminal.attach'){
   if(this.terminalFlights.has(key)){const pending=this.terminalFlights.get(key);if(pending.action==='attach'&&pending.ownerId===p.ownerId)return pending;await pending.catch(()=>{});return this.invoke(op,p);}
   const flight=(async()=>{
    const observed=c.sessions?.get(p.target);
    const assertOwner=()=>{if(p.ownerId&&c.sessions?.get(p.target)?.viewOwnerId!==p.ownerId)throw new HostError('TERMINAL_STALE','终端所属 Agent 已变化，请重新连接');};
    assertNotHeld();
    c.assertFrontdeskContextAdmission(p.target);
    assertOwner();
    let t=c.terminals.get(p.target);if(t?.closed){await t.close();t=null;}
    if(!t){
     if(!observed?.interactions?.length)await c.running?.get(p.target);assertNotHeld();assertOwner();if(this.stopping||c.stopping)throw Error('application closing');
     const terminalId=randomUUID();
     const sessionOwner=c.sessions?.get(p.target);
     const live=()=>c.terminals.get(p.target)?.terminalId===terminalId;
     t=await this.attachTerminal(c,p.target,{terminalId,
      onScreen:screen=>{if(live())this.listener({projectId:p.projectId,kind:'managed-terminal-screen',target:p.target,terminalId,...screen});},
      onMethod:method=>{if(live())this.listener({projectId:p.projectId,kind:'managed-terminal-diagnostic',target:p.target,terminalId,method});},
      onData:(data,seq)=>{if(live()){this.systemTerminals.output(key,data,seq);this.listener({projectId:p.projectId,kind:'managed-terminal',target:p.target,terminalId,data,seq});}},
      onExit:value=>{const current=c.terminals.get(p.target);if((sessionOwner&&c.sessions?.get(p.target)!==sessionOwner)||(current&&current.terminalId!==terminalId))return;void this.systemTerminals.close(key);this.listener({projectId:p.projectId,kind:'managed-terminal',target:p.target,terminalId,ended:true,exitCode:value?.exitCode});}});
    }
    assertNotHeld();
    c.assertFrontdeskContextAdmission(p.target);
    if(p.ownerId&&c.sessions?.get(p.target)?.viewOwnerId!==p.ownerId){if(c.terminals.get(p.target)===t)await t.close();throw new HostError('TERMINAL_STALE','终端所属 Agent 已变化，请重新连接');}
    return {terminalId:t.terminalId,ownerId:c.sessions?.get(p.target)?.viewOwnerId??observed?.viewOwnerId??null,threadId:t.threadId,replay:t.replay,replayFrames:t.replayFrames,seq:t.seq};
   })().finally(()=>{if(this.terminalFlights.get(key)===flight)this.terminalFlights.delete(key);});flight.action='attach';flight.ownerId=p.ownerId;this.terminalFlights.set(key,flight);return flight;
  }
  if(this.terminalFlights.has(key)&&!(action==='terminal.input'&&c.terminals.get(p.target)?.terminalId===p.terminalId))await this.terminalFlights.get(key).catch(()=>{});
  const terminal=c.terminals.get(p.target);
  if(!terminal||terminal.terminalId!==p.terminalId||terminal.closed){if(action==='terminal.close')return {closed:false,stale:true};throw new HostError('TERMINAL_STALE','终端连接已过期，请重新连接');}
  if(this.systemTerminals.owns(key)&&['terminal.input','terminal.resize'].includes(action))throw Error('系统终端正在接管输入，请先接回内置终端。');
  if(action==='terminal.input'){c.assertFrontdeskContextAdmission(p.target);assertNotHeld();if(typeof p.data!=='string'||p.data.length>10000)throw new Error('invalid terminal input');terminal.input(p.data);return {accepted:true};}
  if(action==='terminal.resize'){if(!Number.isInteger(p.cols)||!Number.isInteger(p.rows)||p.cols<2||p.cols>500||p.rows<2||p.rows>200)throw new Error('invalid terminal size');terminal.resize(p.cols,p.rows);return {accepted:true};}
  if(action==='terminal.close'){await this.systemTerminals.close(key);const flight=terminal.close().then(()=>({closed:true})).finally(()=>{if(this.terminalFlights.get(key)===flight)this.terminalFlights.delete(key);});flight.action='close';this.terminalFlights.set(key,flight);return flight;}
 }
}
