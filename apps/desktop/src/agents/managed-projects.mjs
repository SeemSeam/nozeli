import {SystemTerminalBridge} from './managed/system-terminal-bridge.mjs';
import {fileURLToPath} from 'node:url';
import {preferredRegionAssets} from '../domain/region-drawing.mjs';
import {tagMaterialSnapshot} from './managed/tag-material-delivery.mjs';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Controller} from './managed/controller.mjs';
import {createFrontdeskDocuments} from './managed/frontdesk-documents.mjs';
import {ShadowVersions} from './managed/shadow-versions.mjs';
import {atomicJson} from './managed/workspace.mjs';
import {attachNativeTerminal} from './managed/native-terminal.mjs';
import {managedReportSource,managedHistory,managedArtifact} from './managed-report-source.mjs';
import {HostError} from '../main/host.mjs';
import {recordAdoption} from './managed/adoption-history.mjs';
import {SessionIndex} from './managed/session-index.mjs';
import {WorkChanges} from './managed/work-changes.mjs';
import {readWorkerArchive} from './managed/worker-archive.mjs';
import {decodeReportState} from './managed/report-descriptor.mjs';
import {residentHistoryPage} from './managed/resident-history.mjs';
import {AgentProcessBudget,validateAgentLimit} from './managed/agent-process-budget.mjs';
import {Workspace} from './managed/workspace.mjs';
import {recoverOmpProvider} from './managed/omp-process-ownership.mjs';
import {recoverProvider} from './managed/process-ownership.mjs';
export class ManagedProjects {
 constructor({userDataDir,host,legacy,beforeDocumentOperation,ompSystemSource=null,ompAuthBroker=null,ompCommand,openController=Controller.open,attachTerminal=attachNativeTerminal}){
  Object.assign(this,{host,legacy,beforeDocumentOperation,openController,attachTerminal,ompOptions:{ompSystemSource,ompCommand,ompAuthBroker}});
  this.versions=new Map();   // ShadowVersions per project（connect 中 set 前必须初始化）
  this.connectionErrors=new Map();this.handoffFlights=new Map();
  this.root=path.join(userDataDir,'nozeli','managed-v1');this.controllers=new Map();this.flights=new Map();this.terminalFlights=new Map();this.listener=()=>{};this.stopping=false;const helper={command:process.execPath,args:[...(process.versions.electron&&process.platform==='linux'?['--ozone-platform=headless']:[]),...(!process.versions.electron||process.defaultApp?[fileURLToPath(new URL('../main/main.cjs',import.meta.url))]:[]),'--nozeli-terminal-client']};this.systemTerminals=new SystemTerminalBridge({root:path.join(this.root,'terminal-tickets'),helper});
  this.activeProjectId=null;this.projectActivity=new Map();this.resourceFlights=new Map();
  this.processBudget=new AgentProcessBudget({file:path.join(userDataDir,'agent-resources.json'),onAvailable:()=>{for(const c of this.controllers.values())c.kick?.();}});
  this.processBudget.reclaim=(id,target)=>this.reclaimInactive(id,{target});
 }
 onEvent(fn){this.listener=fn;}
 applyModelDefaults(defaults){
  const next=structuredClone(defaults);
  const operation=(this.modelDefaultsFlight??Promise.resolve()).catch(()=>{}).then(async()=>{
   const sync={applied:0,pending:0,failed:[]};
   this.modelDefaultFailures=new Map();
   if(this.stopping)return sync;
   await Promise.all([...this.controllers.values()].map(async controller=>{
    if(controller.stopping)return;
    try{const result=await controller.applyModelDefaults(next);sync.applied+=result.applied;sync.pending+=result.pending;sync.failed.push(...result.failed);}
    catch{const failure={message:'项目在线Agent默认模型同步失败；配置已保存，可重试保存。'};this.modelDefaultFailures.set(controller,failure);sync.failed.push(failure);}
   }));
   return sync;
  });
  this.modelDefaultsFlight=operation;return operation;
 }
 modelSync(){
  const sync={applied:0,pending:0,failed:[]};
  for(const controller of this.controllers.values()){
   if(controller.stopping)continue;
   const failure=this.modelDefaultFailures?.get(controller);if(failure){sync.failed.push(failure);continue;}
   const result=controller.modelSync();sync.applied+=result.applied;sync.pending+=result.pending;sync.failed.push(...result.failed);
  }
  return sync;
 }
 async initializeResources(){
  if(this.resourceReady)return this.resourceReady;
  const flight=(async()=>{
   await this.processBudget.load();let entries;try{entries=await fs.readdir(this.root,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
   const records=[];
   for(const entry of entries){if(!entry.isDirectory()||entry.name==='terminal-tickets')continue;const runtime=path.join(this.root,entry.name,'runtime');let state;try{state=JSON.parse(await fs.readFile(path.join(runtime,'state.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
    for(const [target,record] of Object.entries(state.providers??{}))records.push({runtime,record,slot:this.processBudget.restoreSlot(entry.name,target)});
   }
   for(const {runtime,record,slot} of records)try{const receipt=await (['omp-rpc','omp-tui'].includes(record.kind)?recoverOmpProvider(record,runtime):recoverProvider(record,runtime));if(receipt.verified===true)this.processBudget.release(slot);}catch{slot.state='unconfirmed';}
  })();this.resourceReady=flight;try{return await flight;}catch(error){if(this.resourceReady===flight)this.resourceReady=null;throw error;}
 }
 validateResourceProject(id){if(id!==undefined&&id!==null&&(typeof id!=='string'||!id.trim()||id.trim()!==id||id.length>200))throw new HostError('INVALID_PAYLOAD','项目身份无效');}
 async resourceStatus(projectId){
  this.validateResourceProject(projectId);
  await this.initializeResources();let projectLimit=null,projectUsed=0;
  if(projectId){await this.host.requireProject(projectId);const state=this.controllers.get(projectId)?.store?.state??(await this.projectionSource(projectId)).state;projectLimit=state.limit??1;projectUsed=(state.works??[]).filter(w=>!['queued','ended'].includes(w.status)&&w.revision>0).length;}
  const agents=this.processBudget.agents();
  for(const [id,c] of this.controllers){for(const target of ['frontdesk','orchestrator',...(c.store?.state?.works??[]).filter(w=>!['queued','closing','ended'].includes(w.status)).map(w=>w.id)]){
   const slot=agents.find(slot=>slot.projectId===id&&slot.target===target),session=c.sessions?.get(target);
   if(slot&&session){slot.state=slot.state==='unconfirmed'?'unconfirmed':session.busy||c.running?.has(target)?'running':slot.state==='starting'?'starting':'idle';slot.blockedReason=c.externalTerminalTargets?.has(target)?'系统终端正在使用':c.nativeDraftTargets?.has(target)?'原生终端有未发送草稿':session.busy||c.running?.has(target)?'任务执行中':c.terminals?.has(target)&&id===this.activeProjectId?'当前内置终端正在使用':null;}
   else if(!slot)agents.push({projectId:id,target,state:'sleeping'});
  }}
  const projectNames=new Map();for(const agent of agents){if(!projectNames.has(agent.projectId)){try{const project=await this.host.requireProject(agent.projectId);projectNames.set(agent.projectId,project.name??project.title??null);}catch{projectNames.set(agent.projectId,null);}}agent.projectName=projectNames.get(agent.projectId);const work=this.controllers.get(agent.projectId)?.store?.state?.works?.find(w=>w.id===agent.target);if(work?.name)agent.workName=work.name;}
  return {globalLimit:this.processBudget.limit,globalUsed:this.processBudget.used,projectLimit,projectUsed,agents};
 }
 async saveResourceLimits(payload={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['globalLimit','projectId','projectLimit'].includes(key)))throw new HostError('INVALID_PAYLOAD','Agent 设置参数无效');
  const {globalLimit,projectId,projectLimit}=payload;validateAgentLimit(globalLimit);if(projectLimit!==undefined){validateAgentLimit(projectLimit,{project:true});if(!projectId)throw new HostError('INVALID_PAYLOAD','项目 Worker 设置需要当前项目');}
  this.validateResourceProject(projectId);
  await this.initializeResources();if(projectId)await this.host.requireProject(projectId);
  const prior=this.resourceFlights.get(projectId),connecting=this.flights.get(projectId);
  const operation=(async()=>{
   await prior?.catch(()=>{});await connecting;let store=this.controllers.get(projectId)?.store,owned=false;
   if(projectLimit!==undefined&&!store){const project=await this.host.requireProject(projectId);store=await Workspace.open(path.join(this.root,projectId,'runtime'),project.root,{recoverStale:true});owned=true;}
   try{await this.processBudget.save(globalLimit,async()=>{if(projectLimit!==undefined)await store.mutate(()=>{const used=store.used();if(projectLimit<used)throw Object.assign(Error(`项目 Worker 数量不能低于当前占用 ${used}（包括暂停、待审阅与关闭中工作）`),{code:'AGENT_LIMIT_IN_USE'});store.state.limit=projectLimit;});});this.controllers.get(projectId)?.changed?.();}
   finally{if(owned)await store.close();}
  })();if(projectId)this.resourceFlights.set(projectId,operation);
  try{await operation;return this.resourceStatus(projectId);}finally{if(this.resourceFlights.get(projectId)===operation)this.resourceFlights.delete(projectId);}
 }
 async setActiveProject(id){
  this.validateResourceProject(id);if(id===undefined)throw new HostError('INVALID_PAYLOAD','项目身份无效');const epoch=this.activationEpoch=(this.activationEpoch??0)+1;
  if(id!==null)await this.host.requireProject(id);if(epoch!==this.activationEpoch)return {superseded:true};this.activeProjectId=id;if(id)this.projectActivity.set(id,Date.now());
  await this.initializeResources();if(epoch!==this.activationEpoch)return {superseded:true};await this.reclaimInactive(id,{all:true});
  if(epoch!==this.activationEpoch)return {superseded:true};
  if(id&&(this.controllers.has(id)||(await this.config(id)).enabled)){if(epoch!==this.activationEpoch)return {superseded:true};return this.connect(id);}
  return this.resourceStatus(id??undefined);
 }
 reclaimInactive(requestingId,{all=false,target:requestedTarget}={}){
  const operation=(this.reclaimFlight??Promise.resolve()).catch(()=>{}).then(async()=>{
   const candidates=[...this.controllers.entries()].filter(([id])=>id!==this.activeProjectId&&id!==requestingId).sort(([a],[b])=>(this.projectActivity.get(a)??0)-(this.projectActivity.get(b)??0));
   for(const [id,c] of candidates){for(const target of c.sessions?.keys()??[]){if(!all&&this.processBudget.available)return;try{await c.reclaimIdle?.(target,{hiddenTerminal:true});}catch(error){this.listener({projectId:id,kind:'managed-error',text:'空闲 Agent 回收未确认，名额保留：'+error.message});}}}
   if(!all&&!this.processBudget.available&&requestedTarget){const c=this.controllers.get(requestingId),targets=['orchestrator','frontdesk',...(c?.sessions?.keys()??[])];for(const target of new Set(targets)){if(this.processBudget.available)break;if(target===requestedTarget)continue;try{await c?.reclaimIdle?.(target);}catch(error){this.listener({projectId:requestingId,kind:'managed-error',text:'空闲 Agent 回收未确认，名额保留：'+error.message});}}}
  });this.reclaimFlight=operation;return operation;
 }
 async config(id){await this.host.requireProject(id);try{return JSON.parse(await fs.readFile(path.join(this.root,id,'binding.json')));}catch(e){if(e.code==='ENOENT')return {enabled:false};throw e;}}
 async status(id){
  const binding=await this.config(id),controller=this.controllers.get(id),failure=this.connectionErrors.get(id);let state=controller?.snapshot()??null;
  if(!state&&binding.enabled){const source=await this.projectionSource(id);const timeline=await source.index.page();const {sessionIndex,messages,...business}=source.state;state={jobs:[],works:[],todos:[],receipts:[],drafts:{},limit:1,...business,messages:source.index.messages(),timeline,agents:[],quotaUsed:(business.works??[]).filter(w=>!['queued','ended'].includes(w.status)).length,configuringTargets:[],externalTerminalTargets:[],nativeDraftTargets:[],busyTargets:[],stopping:false};}
  return {enabled:binding.enabled===true,ready:controller?.started===true,runtimeRoot:path.join(this.root,id,'runtime'),state,connectionError:failure?.error??null,handoff:failure?.handoff??null};
 }
 async saveLocalDraft(id,target,value){
  if(typeof value!=='string'||value.length>32000||typeof target!=='string')throw new HostError('INVALID_PAYLOAD','本地草稿无效');
  if(this.stopping)throw new HostError('APP_CLOSING','应用正在关闭，草稿未覆盖');
  const current=this.controllers.get(id);if(current)return current.setDraft(target,value);
  this.draftFlights??=new Map();const prior=this.draftFlights.get(id)??Promise.resolve(),connecting=this.flights.get(id);
  const operation=prior.catch(()=>{}).then(async()=>{
    if(connecting){await connecting;const connected=this.controllers.get(id);if(connected)return connected.setDraft(target,value);}
    const project=await this.host.requireProject(id);const {Workspace}=await import('./managed/workspace.mjs');const store=await Workspace.open(path.join(this.root,id,'runtime'),project.root,{recoverStale:true});
    try{await store.mutate(()=>{if(!['frontdesk','orchestrator'].includes(target)&&!store.state.works.some(work=>work.id===target&&work.status!=='ended'))throw new HostError('INVALID_PAYLOAD','草稿所属工作无效');store.state.drafts??={};store.state.drafts[target]=value;});}finally{await store.close();}
  }).finally(()=>{if(this.draftFlights.get(id)===operation)this.draftFlights.delete(id);});this.draftFlights.set(id,operation);return operation;
 }
 async connect(id,{enable=false,startResidents=true}={}){
  if(this.stopping)throw new Error('application closing');
  await this.initializeResources();await this.resourceFlights.get(id);this.projectActivity.set(id,Date.now());
  const project=await this.host.requireProject(id);if(!enable&&!(await this.config(id)).enabled)return this.status(id);
  if(this.flights.has(id))return this.flights.get(id);
  if(this.controllers.has(id)){
   if(!startResidents)return this.status(id);
   const retained=this.controllers.get(id);if(this.connectionErrors.get(id)?.handoff)return this.status(id);if(retained.started&&(!retained.sessions||['frontdesk','orchestrator'].every(target=>retained.sessions.get(target)&&!retained.sessions.get(target).closed)))return this.status(id);
   const restart=(async()=>{try{await retained.start();this.connectionErrors.delete(id);return this.status(id);}catch(error){let handoff=null,blocked=null;if(error.code==='OMP_TOOLS_DIGEST_MISMATCH')try{handoff=await retained.prepareResidentHandoff(error.target);}catch(unsafe){blocked={code:unsafe.code??'HANDOFF_UNSAFE',message:unsafe.message};}this.connectionErrors.set(id,{error:{code:error.code??'RESIDENT_START_FAILED',message:error.message,role:error.target??null,blocked},handoff});throw error;}})().finally(()=>{if(this.flights.get(id)===restart)this.flights.delete(id);});this.flights.set(id,restart);return restart;
  }
  const flight=(async()=>{
   await this.draftFlights?.get(id);
   await this.legacy.connectFlight?.get(id);
   const old=this.legacy.projects.get(id);if(old&&this.legacy.roleBusy(old))throw new Error('旧 Agent 有进行中的输入，请先处理再启用三角色');if(old)await this.legacy.stopSlots(old);
   const versions=new ShadowVersions({projectRoot:project.root});
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
   const controller=await this.openController({projectId:id,processBudget:this.processBudget,runtimeRoot:path.join(this.root,id,'runtime'),contentRoot:project.root,...this.ompOptions,frontdeskDocuments,afterAdoption:(work,receipt)=>recordAdoption({host:this.host,projectId:id,work,receipt}),beforeAccept:async work=>{for(const relPath of work.execution?.candidate?.files||[]){const release=await this.beforeDocumentOperation?.({projectId:id,relPath,hold:false});release?.();const draft=await this.host.readDraftRecord(id,relPath);if(draft?.draftError||draft&&draft.status!=='saved')throw new HostError('DRAFT_CONFLICT','成果合入受阻：请先保存或明确处理原项目草稿 '+relPath);}},isolateProcesses:true,readProjectText:async rel=>{const file=await this.host.readFile(id,rel);if(file.draftError)throw new HostError(file.draftError.code||'DRAFT_CONFLICT',file.draftError.message||'项目草稿无法读取。');const draft=file.draft&&file.draft.status!=='saved'?file.draft:null;return {text:draft?.text??file.text,buffer:Boolean(draft),diskVersion:file.digest};}});
   controller.on('state',state=>{this.listener({projectId:id,kind:'managed-state',state});if(this.activeProjectId!==null&&id!==this.activeProjectId&&!controller.stopping)queueMicrotask(()=>{void this.reclaimInactive(this.activeProjectId,{all:true});});});controller.on('diagnostic',text=>this.listener({projectId:id,kind:'managed-error',text}));
   controller.on('timeline',timeline=>this.listener({projectId:id,kind:'managed-timeline',timeline}));
   controller.on('files-changed',event=>{void checkpointAdopted(event);this.listener({...event,projectId:id,kind:'managed-files-changed'});});
   controller.on('native-terminal-event',event=>{const {target,screen,method,...payload}=event,terminalId=controller.terminals.get(target)?.terminalId,key=id+':'+target;if(screen)this.listener({projectId:id,kind:'managed-terminal-screen',target,terminalId,...screen});else if(method)this.listener({projectId:id,kind:'managed-terminal-diagnostic',target,terminalId,method});else{if(payload.ended)void this.systemTerminals.close(key);else this.systemTerminals.output(key,payload.data,payload.seq);this.listener({projectId:id,kind:'managed-terminal',target,terminalId,...payload});}});
   this.controllers.set(id,controller);
   try{
    // Native OMP alone owns model selection; saved bindings only seed old native selections.
    const persisted=await this.config(id);
    if(persisted.model||persisted.effort||Object.values(persisted.roles??{}).some(r=>r?.model||r?.effort)){
      const original=await fs.readFile(path.join(this.root,id,'binding.json'),'utf8');
      await fs.writeFile(path.join(this.root,id,'binding.before-native-selection.json'),original,{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    }
    const persistedRoles=persisted.roles&&typeof persisted.roles==='object'?persisted.roles:null;
    for(const role of ['frontdesk','orchestrator','worker']){
      const legacy=persistedRoles?.[role]??persisted;
      if(legacy?.provider==='omp'&&legacy.model&&typeof controller.migrateNativeBinding==='function')await controller.migrateNativeBinding(role,{model:legacy.model,effort:legacy.effort});
    }
    if(startResidents)await controller.start();
    // 不再独立发现模型：配置和选择全部由正在运行的原生 Agent 负责。
     if(controller.store?.state?.bindings){
       const roles=controller.store.state.bindings;
       const projection={schema:1,enabled:true,roles:{}};
       for(const role of ['frontdesk','orchestrator','worker'])projection.roles[role]={provider:'omp'};
       await atomicJson(path.join(this.root,id,'binding.json'),projection);
     }
     return this.status(id);}
   catch(e){if(e.code==='OMP_TOOLS_DIGEST_MISMATCH'&&typeof controller.prepareResidentHandoff==='function'){
     let handoff=null,blocked=null;try{handoff=await controller.prepareResidentHandoff(e.target);}catch(error){blocked={code:error.code??'HANDOFF_UNSAFE',message:error.message};}
     this.connectionErrors.set(id,{error:{code:e.code,message:e.message,role:e.target??null,blocked},handoff});
     this.listener({projectId:id,kind:'managed-error',text:'OMP工具协议已变化，原会话保留；需要用户确认新会话接手。'});throw e;
    }if(e.code==='AGENT_PROCESS_LIMIT'){this.connectionErrors.set(id,{error:{code:e.code,message:e.message},handoff:null});throw e;}this.controllers.delete(id);await controller.stop().catch(()=>{});throw e;}
  })().finally(()=>this.flights.delete(id));this.flights.set(id,flight);return flight;
 }
 async handoffResident(id,p){
  if(this.stopping)throw Error('application closing');await this.host.requireProject(id);
  const key=id+':'+p.role;const active=this.handoffFlights.get(key);if(active){if(active.token!==p.token||active.oldThreadId!==p.oldThreadId)throw Error('接手确认已变化，请重新查看当前项目提示');return active;}
  const c=this.controllers.get(id);if(!c||!this.connectionErrors.has(id))throw Error('没有需要确认接手的OMP协议故障');
  const flight=(async()=>{const result=await c.confirmResidentHandoff({role:p.role,token:p.token,oldThreadId:p.oldThreadId});
   this.connectionErrors.delete(id);
   try{await c.start();return {...result,projectId:id,status:await this.status(id)};}catch(error){if(error.code!=='OMP_TOOLS_DIGEST_MISMATCH'){this.connectionErrors.set(id,{error:{code:error.code??'HANDOFF_START_FAILED',message:error.message,role:p.role},handoff:null});throw error;}let handoff=null,blocked=null;try{handoff=await c.prepareResidentHandoff(error.target);}catch(unsafe){blocked={code:unsafe.code??'HANDOFF_UNSAFE',message:unsafe.message};}this.connectionErrors.set(id,{error:{code:error.code,message:error.message,role:error.target,blocked},handoff});return {...result,projectId:id,status:await this.status(id)};}
  })().finally(()=>{if(this.handoffFlights.get(key)===flight)this.handoffFlights.delete(key);});flight.token=p.token;flight.oldThreadId=p.oldThreadId;this.handoffFlights.set(key,flight);return flight;
 }
 async residentHistory(id,{role,archiveId,offset=0,version}){
  await this.host.requireProject(id);if(!['frontdesk','orchestrator'].includes(role))throw Error('仅支持居民归档历史');
  const c=this.controllers.get(id);const state=c?.store?.state??JSON.parse(await fs.readFile(path.join(this.root,id,'runtime','state.json'),'utf8'));
  if(['codex','claude'].includes(archiveId)){
   const historical=state.residentArchive?.[role]?.[archiveId];if(!historical?.readOnly)throw Error('历史身份不属于当前项目角色');
   if(!Array.isArray(historical.messages))throw new HostError('HISTORY_UNVERIFIED','旧后端档案没有冻结消息边界；原记录保留，不混入当前OMP对话。');
   const messages=historical.messages;
   return {projectId:id,role,archiveId,provider:archiveId,threadId:historical.threadId,source:'host-message-ledger',...await residentHistoryPage({messages,offset,version})};
  }
  const record=state.residentArchive?.[role]?.handoffs?.find(r=>r.id===archiveId);if(!record||record.provider!=='omp')throw Error('归档身份不属于当前项目角色');
  const home=path.join(this.root,id,'runtime','agents',`resident-${role}-omp`),sessions=path.join(home,'sessions');
  const {pinSessionFileById}=await import('./managed/omp-process-ownership.mjs');const file=await pinSessionFileById(sessions,record.threadId);if(!file)throw Error('原归档会话文件缺失，未创建替代历史');
  const real=await fs.realpath(file),root=await fs.realpath(sessions);if(!real.startsWith(root+path.sep))throw Error('归档来源越界');
  return {projectId:id,role,archiveId,threadId:record.threadId,...await residentHistoryPage({file:real,offset,version})};
 }
 controller(id){const c=this.controllers.get(id);if(!c?.started||this.stopping)throw new Error('项目三角色尚未就绪');return c;}
 async artifactList(id,objectId){
  const project=await this.host.requireProject(id),controller=this.controllers.get(id);
  return managedArtifact({project,runtime:path.join(this.root,id,'runtime'),controller,currentController:()=>this.controllers.get(id)},{objectId});
 }
 async artifactRead(id,{objectId,relPath}){
  const project=await this.host.requireProject(id),controller=this.controllers.get(id);
  if(typeof relPath!=='string')throw new HostError('INVALID_PAYLOAD','成果路径无效。');
  return managedArtifact({project,runtime:path.join(this.root,id,'runtime'),controller,currentController:()=>this.controllers.get(id)},{objectId,relPath});
 }
 async reportSource(id,objectId){
  const project=await this.host.requireProject(id);
  if(!/^[a-f0-9]{64}$/.test(id)||!/^[0-9a-f-]{36}$/i.test(objectId))throw new Error('报告身份无效，未另存。');
  const controller=this.controllers.get(id);
  return managedReportSource({project,runtime:path.join(this.root,id,'runtime'),objectId,controller,currentController:()=>this.controllers.get(id)});
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
  await this.host.requireProject(id);const controller=this.controllers.get(id),runtime=path.join(this.root,id,'runtime');
  if(controller)return {controller,state:controller.store.state,index:controller.timeline,changes:controller.changes};
  let state;try{state=JSON.parse(await fs.readFile(path.join(runtime,'state.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;state={messages:[],jobs:[],receipts:[],works:[]};}
  if(state.schema===2)state=decodeReportState(state);
  const index=new SessionIndex({root:runtime,state});return {state,index,changes:new WorkChanges(runtime)};
 }
 async timelineQuery(id,action,p){
  const {index}=await this.projectionSource(id);
  if(action==='timeline.read')return {entry:await index.read(p.id,{version:p.version,field:p.field,offset:p.offset,limit:p.limit})};
  if(action==='timeline.request'){
   if(typeof p.requestId!=='string'||!p.requestId||p.requestId.length>512||!Number.isSafeInteger(p.offset??0)||(p.offset??0)<0)throw new HostError('INVALID_PAYLOAD','讨论轮次查询无效');
   const rows=index.records().filter(row=>row.target==='frontdesk'&&row.jobId===p.requestId).sort((a,b)=>a.sequence-b.sequence),offset=p.offset??0;
   const ids=[];for(const row of rows.slice(offset,offset+100)){await index.hydrate([row]);const entry=index.nativeDTO(row);if(entry?.speaker==='agent'||entry?.availability==='unavailable')ids.push(row.id);}
   return {ids,nextOffset:offset+100<rows.length?offset+100:null};
  }
  return index.page({cursor:p.cursor,limit:p.limit??100});
 }
 async changesQuery(id,action,p){
  if(typeof p.changeSetId!=='string')throw new HostError('INVALID_PAYLOAD','冻结差异身份无效');
  const {state,changes}=await this.projectionSource(id),receipt=state.receipts?.find(r=>r.changeSetId===p.changeSetId);
  if(!receipt)throw new HostError('CHANGES_BINDING','当前项目不存在此冻结结果');
  const expectedBinding={projectId:id,workId:receipt.workId,revision:receipt.revision,jobId:receipt.sourceJobId,receiptId:receipt.id};
  const result=await (action==='changes.list'?changes.list({changeSetId:p.changeSetId,offset:p.offset,limit:p.limit,expectedBinding}):changes.read({changeSetId:p.changeSetId,fileId:p.fileId,maxBytes:p.maxBytes,maxLines:p.maxLines,expectedBinding}));
  const {repo,commonDir,...binding}=result.binding;return {...result,binding};
 }
 busy(){return this.flights.size>0||[...this.controllers.values()].some(c=>c.running.size>0||c.closures.size>0);}
 stopVersionsGc(){for(const state of Object.values(this.versionGcState??{})){if(state.timer){clearTimeout(state.timer);state.timer=null;}}}
 async stop(){this.stopping=true;this.stopVersionsGc();await this.systemTerminals.stop();await Promise.allSettled([...this.flights.values()]);const drafts=await Promise.allSettled([...(this.draftFlights?.values()??[])]);const results=await Promise.allSettled([...this.controllers.values()].map(c=>c.stop()));await Promise.allSettled([...this.terminalFlights.values()]);this.controllers.clear();const error=[...drafts,...results].find(r=>r.status==='rejected');if(error)throw error.reason;}
 async invoke(op,p){
  if(op==='managed.frontdesk.route.resolve'&&(!p||typeof p!=='object'||Array.isArray(p)))throw new HostError('INVALID_PAYLOAD','前台去向决定参数必须是对象。');
  const allowed={status:['projectId'],connect:['projectId'],enable:['projectId'],send:['projectId','target','text','relPath','materialText','tags','routingQuestionId','requestKey'],task:['projectId','text','relPath','materialText','tags','routingQuestionId','requestKey'],'intake.retry':['projectId','jobId','requestKey'],draft:['projectId','target','text'],end:['projectId','workId','revision','decision'],retry:['projectId','workId'],restart:['projectId','target'],binding:['projectId','role','skills'],limit:['projectId','limit'],'terminal.screen':['projectId','target'],'terminal.system':['projectId','target'],'terminal.return':['projectId','target'],'terminal.attach':['projectId','target'],'terminal.input':['projectId','target','terminalId','data'],'terminal.resize':['projectId','target','terminalId','cols','rows'],'terminal.close':['projectId','target','terminalId','detach']};
  allowed['terminal.attach']=['projectId','target','ownerId'];
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
  allowed['frontdesk.route.resolve']=['projectId','proposalId','expectedVersion','action','requestKey'];
  allowed['timeline.page']=['projectId','cursor','limit'];allowed['timeline.read']=['projectId','id','version','field','offset','limit'];
  allowed['timeline.request']=['projectId','requestId','offset'];
  allowed['changes.list']=['projectId','changeSetId','offset','limit'];allowed['changes.read']=['projectId','changeSetId','fileId','maxBytes','maxLines'];
  const action=op.slice('managed.'.length);
  if(action==='frontdesk.context.clear'){
   if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==1||typeof p.projectId!=='string'||!p.projectId.trim())throw new HostError('INVALID_PAYLOAD','清除前台上下文仅接受 projectId');
   await this.host.requireProject(p.projectId);
   if(this.flights.has(p.projectId)||this.terminalFlights.has(p.projectId+':frontdesk'))throw new HostError('FRONTDESK_CONTEXT_CLEAR_BUSY','前台连接或终端操作尚未完成');
   if(!this.controllers.has(p.projectId))await this.connect(p.projectId,{startResidents:false});
   const controller=this.controllers.get(p.projectId);if(!controller)throw new HostError('FRONTDESK_CONTEXT_CLEAR_UNAVAILABLE','项目尚未启用前台');
   return controller.clearFrontdeskContext();
  }
  if(action==='frontdesk.route.resolve'&&(Object.keys(p).some(k=>!allowed[action].includes(k))||!['projectId','proposalId','requestKey'].every(k=>typeof p[k]==='string'&&p[k].trim()===p[k]&&p[k].length>0&&p[k].length<=200)||!Number.isSafeInteger(p.expectedVersion)||p.expectedVersion<1||!['continue','background'].includes(p.action)))throw new HostError('INVALID_PAYLOAD','前台去向决定的项目、提议、版本或动作无效。');
  if(action==='deviation.resolve'&&(Object.keys(p).some(k=>!allowed[action].includes(k))||!['projectId','workId','deviationId','requestKey'].every(k=>typeof p[k]==='string'&&p[k].trim()===p[k]&&p[k].length>0&&p[k].length<=200)||!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<1||!Number.isSafeInteger(p.expectedVersion)||p.expectedVersion<1||!['continue','replan'].includes(p.action)))throw new HostError('INVALID_PAYLOAD','任务偏离决定的身份、版本或动作无效。');
  if((action==='history.list'||action==='history.read')&&Object.keys(p).some(k=>!allowed[action].includes(k)))throw new HostError('INVALID_PAYLOAD','历史报告查询参数无效。');
  if(!allowed[action]||Object.keys(p).some(k=>!allowed[action].includes(k)))throw new Error('invalid managed payload');await this.host.requireProject(p.projectId);
  if(action==='draft')return this.saveLocalDraft(p.projectId,p.target,p.text);
  if(action==='status')return this.status(p.projectId);if(action==='enable'||action==='connect')return this.connect(p.projectId,{enable:action==='enable'});
  if(action==='timeline.page'||action==='timeline.read'||action==='timeline.request')return this.timelineQuery(p.projectId,action,p);
  if(action==='changes.list'||action==='changes.read')return this.changesQuery(p.projectId,action,p);
  if(action==='resident.handoff')return this.handoffResident(p.projectId,p);
  if(action==='resident.history')return this.residentHistory(p.projectId,p);
  if(action==='worker.history'){const source=await this.projectionSource(p.projectId),work=source.state.works?.find(w=>w.id===p.workId);return readWorkerArchive(path.join(this.root,p.projectId,'runtime'),work,{archiveId:p.archiveId,offset:p.offset??0,version:p.version});}
  if(action==='artifact.read')return this.artifactRead(p.projectId,p);
  if(action==='artifact.list')return this.artifactList(p.projectId,p.objectId);
  if(action==='history.list'||action==='history.read'){
   const project=await this.host.requireProject(p.projectId),controller=this.controllers.get(p.projectId);
   if(action==='history.read'&&typeof p.objectId!=='string')throw new HostError('INVALID_PAYLOAD','历史报告查询参数无效。');
   const {projectId,...query}=p;
   return managedHistory({project,runtime:path.join(this.root,projectId,'runtime'),controller,currentController:()=>this.controllers.get(projectId)},query);
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
    const {Workspace}=await import('./managed/workspace.mjs');
    const {manageTodoState}=await import('../domain/todo-management.mjs');
    const project=await this.host.requireProject(p.projectId);
    const store=await Workspace.open(path.join(this.root,p.projectId,'runtime'),project.root,{recoverStale:true});
    try{return await store.mutate(()=>manageTodoState(store.state,p));}finally{await store.close();}
  }
  const c=this.controller(p.projectId);
  if(action==='deviation.resolve')return c.resolveDeviation(p);
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
   const submissionDigest=createHash('sha256').update(JSON.stringify([p.target||'frontdesk',p.text,p.relPath,p.materialText,p.tags,p.routingQuestionId])).digest('hex');
   const previous=p.requestKey&&c.store.state.jobs.find(j=>j.key===(action==='task'?'task:':'input:')+p.requestKey);
   if(previous){if(previous.context?.submissionDigest!==submissionDigest)throw Error('submission key collision');return {accepted:true,jobId:previous.id};}
   let text=p.text;
   if(p.relPath&&!p.tags?.length){const file=await this.host.readFile(p.projectId,p.relPath),material=p.materialText??file.draft?.text??file.text;if(typeof material!=='string')throw new Error('无法获取当前文本材料');text+='\n\n参考文件：'+file.relPath+'\n以下是用户附带的文本，可能包含尚未保存的编辑：\n\n'+material;}
   const packets=[];if(p.tags?.length){if(!Array.isArray(p.tags)||p.tags.length>20)throw Error('备注材料最多20项');for(const ref of p.tags)packets.push(await this.host.tagMaterial(p.projectId,ref));}
   const material=packets.length?tagMaterialSnapshot(packets):null;
   if(material){
    const file=path.join(c.store.root,'objects',material.version+'.md');
    try{await fs.writeFile(file,material.full,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;if(createHash('sha256').update(await fs.readFile(file)).digest('hex')!==material.version)throw Error('冻结讨论材料损坏，未发送');}
    text+='\n\n参考材料\n\n'+material.full;
   }
   const imageAttachments=preferredRegionAssets(packets).map(a=>({digest:a.digest,mime:'image/png'}));if(imageAttachments.length>8)throw Error('每次最多8个区域图片');
   if(p.routingQuestionId&&!c.store.state.todos.some(t=>t.id===p.routingQuestionId&&t.kind==='routing'&&t.status==='open'))throw new Error('澄清问题已过期');
   const context={...(p.requestKey?{submissionDigest}:{}),...(p.routingQuestionId?{routingQuestionId:p.routingQuestionId}:{}),...(imageAttachments.length?{imageAttachments}:{})};
   if(material)context.tagMaterial={version:material.version,binding:material.binding,brief:material.brief,reusable:material.reusable};
   if(packets.length)context.userInput={text:p.text,sources:packets.map(packet=>({relPath:packet.relPath,annotationId:packet.tagId,materialDigest:packet.origin?.materialDigest,quote:packet.origin?.anchor?.quote||'',location:packet.information?.location?.label||'',changed:packet.resolution?.targetDigest!==packet.origin?.materialDigest}))};
   return action==='task'?c.submitTask(text,{requestKey:p.requestKey,context,draftText:p.text}):c.send(p.target||'frontdesk',text,{requestKey:p.requestKey,context,draftText:p.text});
  }
  if(action==='end'){if(!['accept','discard'].includes(p.decision))throw new HostError('INVALID_PAYLOAD','请选择接受或丢弃成果。');return c.endWork(p.workId,{revision:p.revision,decision:p.decision});}
  if(action==='retry')return c.retryClosure(p.workId);
  if(action==='restart'){await this.systemTerminals.close(p.projectId+':'+p.target);const session=await c.restart(p.target);return {restarted:true,target:p.target,threadId:session.threadId,closed:session.closed};}
  if(action==='binding'){const value=await c.setBinding(p.role,{skills:p.skills});
    // 持久化失败必须上抛（不吞掉还回 saved）：binding.json 是重启逐角色恢复的依据。
    const roles=c.store.state.bindings;const projection={schema:1,enabled:true,roles:{}};
    for(const role of ['frontdesk','orchestrator','worker'])projection.roles[role]={provider:'omp'};
    await atomicJson(path.join(this.root,p.projectId,'binding.json'),projection);
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
    if(c.isolateProcesses&&c.current.has(p.target)&&c.store.state.works.some(w=>w.id===p.target))await c.workerTerminal.prepare(p.target,{executionJobId:c.current.get(p.target).id});
    let t=c.terminals.get(p.target);if(t?.closed){await t.close();t=null;}
    if(!t){
     await c.running?.get(p.target);assertNotHeld();assertOwner();if(this.stopping||c.stopping)throw Error('application closing');
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
