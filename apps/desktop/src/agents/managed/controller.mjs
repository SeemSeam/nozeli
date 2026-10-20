import {ExecutionWorkspace} from './execution-workspace.mjs';
import {intakeLineage} from '../../domain/managed-work-records.mjs';
import {runtimeFailureMessage} from '../../domain/runtime-failure-message.mjs';
import {MaterialStore} from '../../domain/material-store.mjs';
import {manageTodoState} from '../../domain/todo-management.mjs';
import {verifyProjectArtifacts} from './artifacts.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { Workspace } from './workspace.mjs';
import { OmpTuiSession } from './omp-tui-session.mjs';
import { prepareOmpPrivateHome } from './omp-provider-home.mjs';
import { recoverOmpProvider, pinSessionFileById } from './omp-process-ownership.mjs';
import { roles, rolePrompt, eventSkill, readRoleSkill, here } from './runtime.mjs';
import { processStamp, recoverProvider } from './process-ownership.mjs';
import {ContextReader,memoryContext} from './context-reader.mjs';
import {prepareDelivery,contextInstructions,residentBaseInstructions,workerTaskAnchor} from './context-delivery.mjs';
import {frontSource,frontReadLimits,readPage} from './frontdesk-read.mjs';
import {createWorkerTerminalLifecycle} from './worker-terminal-first-frame.mjs';
import {MemoryVersion} from './memory-version.mjs';
import {SessionIndex} from './session-index.mjs';
import {WorkChanges} from './work-changes.mjs';
import {TagMaterialDelivery} from './tag-material-delivery.mjs';
import {loadWorkerArchive,readWorkerArchive as readWorkerArchiveFile} from './worker-archive.mjs';

const tool=(name,description,properties,required=Object.keys(properties))=>({type:'function',name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const text={type:'string'};
export function isExplicitWorkCancellation(value,name){
 if(typeof value!=='string'||!name)return false;
 const text=value.trim(),end=text.search(/[。；;\n]/),command=end<0?text:text.slice(0,end),rest=end<0?'':text.slice(end+1);
 if(!command.includes(name)||/[?？]|是否|能否|可否|要不要|应不应该|需不需要|吗|不能|不可|不许|不得|不要|不必|别|do not|don't|not to|should|could|would|can we/i.test(command))return false;
 // A later instruction can retract cancellation, but unrelated no-Git/no-write
 // constraints must not revoke an explicit named command.
 if(/(?:不要|不许|不得|不必|别|do not|don't|not to)\s*(?:真的|实际|再|actually\s+)?(?:取消|撤销|终止|结束|停止|强制退出|cancel\b|stop\b|terminate\b)/i.test(rest))return false;
 return /^(?:请|麻烦|帮我|请帮我|现在|立即|确定|确认|please\s+)?\s*(?:撤销|取消|强制退出|终止|结束|停止|cancel\b|stop\b|terminate\b)/i.test(command);
}
export class Controller extends EventEmitter {
  static async open({projectId=null,runtimeRoot,contentRoot,sessionFactory,readProjectText,frontdeskDocuments,beforeAccept,afterAdoption,isolateProcesses=false,checkpoint=async()=>{},ompSystemSource=null,ompAuthBroker=null,ompCommand}={}){
    const store=await Workspace.open(runtimeRoot,contentRoot,{recoverStale:true,checkpoint});
    const controller=new Controller(store,{projectId,sessionFactory,readProjectText,frontdeskDocuments,beforeAccept,afterAdoption,isolateProcesses,checkpoint,ompSystemSource,ompAuthBroker,ompCommand});
    try{await controller.timeline.initialize();await controller.restore();return controller;}catch(e){await store.close();throw e;}
  }
  constructor(store,{projectId=null,frontdeskDocuments,sessionFactory,readProjectText,beforeAccept,afterAdoption,isolateProcesses,checkpoint=async()=>{},ompSystemSource=null,ompAuthBroker=null,ompCommand}={}){
    super();Object.assign(this,{frontdeskDocuments,store,sessionFactory,readProjectText,beforeAccept,afterAdoption,isolateProcesses,checkpoint,ompSystemSource,ompAuthBroker,ompCommand});this.execution=new ExecutionWorkspace(store);this.sessions=new Map();this.starting=new Map();this.running=new Map();this.current=new Map();this.pendingEnds=new Set();this.publicationSerial=new Map();this.intakeSerial=new Map();this.stopping=false;this.started=false;this.closures=new Map();this.configuring=new Set();this.nativeDraftTargets=new Set();this.externalTerminalTargets=new Set();this.terminals=new Map();
    this.workerTerminal=createWorkerTerminalLifecycle({getAttachment:target=>this.terminals.get(target),isAllowed:target=>!this.stopping&&!this.deviationHeld(target)&&!['queued','closing','ended'].includes(this.store.find(target).status),attach:async(target,options)=>{const {attachNativeTerminal}=await import('./native-terminal.mjs');return attachNativeTerminal(this,target,{executionJobId:options.executionJobId,onData:(data,seq)=>this.emit('native-terminal-event',{target,data,seq}),onScreen:screen=>this.emit('native-terminal-event',{target,screen}),onMethod:method=>this.emit('native-terminal-event',{target,method}),onExit:value=>this.emit('native-terminal-event',{target,ended:true,exitCode:value?.exitCode})});}});
    this.memoryVersion=new MemoryVersion(path.dirname(store.plan));
    this.projectId=projectId??store.state.workspaceId;
    this.timeline=new SessionIndex(store);
    this.changes=new WorkChanges(store.root);
  }
  async recordTransport(target,fact){
    const statuses=new Set(['prepared','submitted','pending','admitted','executed','rejected','unknown','settled']);
    if(!fact||!statuses.has(fact.status)||!['prompt','abort'].includes(fact.kind)||typeof fact.requestId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(fact.requestId)||typeof fact.sessionId!=='string'||typeof fact.epoch!=='string'||!Number.isSafeInteger(fact.attempt)||fact.attempt<1||!/^[a-f0-9]{64}$/.test(fact.contentDigest))throw Error('invalid transport fact');
    await this.store.mutate(()=>{
      const job=this.store.state.jobs.find(j=>j.id===fact.jobId&&j.target===target);if(!job)throw Error('transport must bind an existing accepted job');
      if(this.store.state.jobs.some(j=>j.id!==job.id&&j.collabAttempts?.some(a=>a.requestId===fact.requestId)))throw Error('transport request identity collision');
      job.collabAttempts??=[];let attempt=job.collabAttempts.find(a=>a.requestId===fact.requestId);
      if(!attempt){
        if(fact.status!=='prepared'||job.collabAttempts.length>=128)throw Error('unprepared or excessive transport attempt');
        if(fact.kind==='prompt'&&(job.status!=='running'||job.collabAttempts.some(old=>old.kind==='prompt'&&!old.definitiveRejection)))throw Error('completed or unresolved business input cannot be dispatched again');
        attempt={requestId:fact.requestId,sessionId:fact.sessionId,epoch:fact.epoch,attempt:fact.attempt,kind:fact.kind,contentDigest:fact.contentDigest,status:'prepared',facts:[],everAdmitted:false};job.collabAttempts.push(attempt);
      }
      for(const key of ['sessionId','epoch','attempt','kind','contentDigest'])if(attempt[key]!==fact[key])throw Error('transport immutable binding changed');
      const receipt={status:fact.status,...(fact.reason?{reason:String(fact.reason).slice(0,400)}:{}),...(Number.isSafeInteger(fact.seq)?{seq:fact.seq}:{}),at:new Date().toISOString()};
      if(!attempt.facts.some(old=>old.status===receipt.status&&old.seq===receipt.seq&&old.reason===receipt.reason))attempt.facts.push(receipt);
      if(attempt.status!=='settled'&&(!Number.isSafeInteger(fact.seq)||!Number.isSafeInteger(attempt.lastNativeSequence)||fact.seq>=attempt.lastNativeSequence)){attempt.status=fact.status;if(Number.isSafeInteger(fact.seq))attempt.lastNativeSequence=fact.seq;}if(fact.status==='admitted')attempt.everAdmitted=true;
      if(fact.status==='rejected'&&!attempt.everAdmitted)attempt.definitiveRejection=true;
    });
  }
  async recordNativeEntries(target,fact){
    const facts=Array.isArray(fact)?fact:Array.isArray(fact?.entries)?fact.entries.map(entry=>entry.entry?{sessionId:fact.sessionId,epoch:fact.epoch,...entry}:{sessionId:fact.sessionId,epoch:fact.epoch,entry}):[fact];
    if(facts.some(fact=>['compaction','branch'].includes(fact?.entry?.type)))this.tagMaterialDelivery?.invalidate(this.sessions.get(target));
    await this.timeline.recordBatch(facts,target);this.publishTimeline();
  }
  recordNativeEvent(target,fact){if(/compaction|branch/.test(fact?.event?.type||''))this.tagMaterialDelivery?.invalidate(this.sessions.get(target));this.timeline.event(fact,target);this.publishTimeline();}
  publishTimeline(){
    if(this.timelineTimer||this.store.closed)return;
    this.timelineTimer=setTimeout(()=>{this.timelineTimer=null;if(!this.store.closed)this.emit('timeline',this.timeline.frame());},25);
    this.timelineTimer.unref?.();
  }
  async timelinePage(query){return this.timeline.page(query);}
  async timelineRead(id,options){return {entry:await this.timeline.read(id,options)};}
  contextState(){return {...this.store.state,messages:this.timeline.messages()};}
  async restore(){
    const s=this.store.state;
    await this.initializeBindings();
    const recovered=[];for(const record of Object.values(s.providers||{}))recovered.push(await (['omp-rpc','omp-tui'].includes(record.kind)?recoverOmpProvider(record,this.store.root):recoverProvider(record,this.store.root)));
    await this.store.mutate(()=>{
      s.jobs??=[];s.messages??=[];s.drafts??={};s.residents??={};s.providers={};s.recoveryEvents??=[];
      s.frontdeskRoutes??=[];
      for(const receipt of s.receipts)this.store.projectReceipt(receipt,{jobId:s.jobs.find(j=>j.target===receipt.workId&&j.revision===receipt.revision)?.id});
      if(s.workOutcomeCutover!==2){
        for(const w of s.works)if(w.status==='closing'||w.status==='ended'&&!w.closure?.decision){
          const historical=w.legacyClosure??w.closure;
          if(w.status==='ended'&&historical?.phase==='ended'&&historical.stopped===true&&historical.git?.complete===true&&w.curated===true){
            w.legacyClosure??=structuredClone(historical);w.closure={...structuredClone(historical),phase:'complete',historical:true,legacyOutcomeUnknown:true,completedAt:historical.completedAt||w.endedAt};
            s.memoryPending=s.memoryPending.filter(id=>id!==w.id);for(const todo of s.todos)if(todo.workId===w.id&&todo.kind==='closure'&&todo.status==='open'){todo.status='resolved';todo.resolution={status:'historical-closure-complete',at:new Date().toISOString()};}
          }else{w.legacyClosure??=structuredClone(w.closure||null);if(w.status==='closing'){w.status='ended';w.endedBy='user';w.endedAt??=w.closure?.at||new Date().toISOString();}w.closure={phase:'blocked',at:w.endedAt,revision:w.revision,error:'Legacy outcome requires explicit user disposition; no automatic deletion'};}
        }
        s.workOutcomeCutover=2;
      }
      for(const job of s.jobs)if(job.status==='queued'){job.status='interrupted';job.error='Cold start never replays accepted inputs';const work=s.works.find(w=>w.id===job.target||w.id===job.context?.boundWorkId);if(work?.status!=='ended'&&!['git','curate'].includes(job.type)&&!s.todos.some(t=>t.sourceJobId===job.id&&t.status==='open'))s.todos.push({id:randomUUID(),...(work?{workId:work.id,revision:work.revision}:{}),kind:work?'recovery':'system',status:'open',sourceJobId:job.id,text:'宿主恢复时保留了未执行输入；请核对原记录后显式继续，不自动重放。'});}
      for(const job of s.jobs)if(['git','curate'].includes(job.type)&&['queued','running','interrupted'].includes(job.status)){job.status='cancelled';job.interruptionReason='work-outcome-cutover';}
      for(const job of s.jobs)if(job.status==='running'){job.status='interrupted';job.error='宿主退出，未自动重放';const w=s.works.find(w=>w.id===job.target);if(w?.status==='running')this.pauseState(w,'执行被中断；请核对文件后继续。');}
      for(const w of s.works)if(w.status==='running'&&!s.jobs.some(j=>j.target===w.id&&j.status==='queued'))this.pauseState(w,'执行状态待核对，未自动重放。');
      s.recoveryEvents.push({at:new Date().toISOString(),type:'host-opened',providers:recovered});
    });
    if(this.execution)await this.execution.recoverOperations();
    await this.finalizeTransfers({restoring:true});
    for(const w of this.store.state.works)if(w.status==='ended'&&w.closure?.phase!=='complete')await this.advanceClosure(w.id);
  }
  async start(){
    const residents=['frontdesk','orchestrator'];
    const preflight=await Promise.allSettled(residents.map(target=>this.makeSession(target,{preflightOnly:true})));
    const rejected=preflight.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
    const results=await Promise.allSettled(residents.map(target=>this.session(target)));const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    this.started=true;this.kick();return this.snapshot();
  }
  pauseState(w,reason){w.status='paused';const source=this.store.state.jobs.findLast(j=>j.target===w.id&&j.revision===w.revision);if(!this.store.state.todos.some(t=>t.workId===w.id&&t.kind==='recovery'&&t.status==='open'&&t.revision===w.revision))this.store.state.todos.push({id:randomUUID(),workId:w.id,revision:w.revision,...(source?{sourceJobId:source.id}:{}),kind:'recovery',status:'open',text:reason});}
  snapshot(){
    const agents=[...this.sessions.entries()].map(([target,s])=>({target,ownerId:s.viewOwnerId,terminalId:this.terminals.get(target)?.terminalId??null,provider:'omp',threadId:s.threadId||this.store.state.residents?.[target]?.threadId||this.store.state.works.find(w=>w.id===target)?.threadId,starting:this.starting.has(target),restarting:this.restarting?.has(target)??false,busy:s.busy,closed:s.closed,phase:s.phase??null,exit:s.exit&&typeof s.exit.then!=='function'?s.exit:null,model:s.model,effort:s.effort,...(s.effective?{effective:s.effective}:{}),configurationStatus:s.configurationStatus??null,capabilities:s.capabilities??null,cleanupEvidence:s.cleanupEvidence?.()??null}));
    for(const w of this.store.state.works)if(w.threadId&&!['ended','closing'].includes(w.status)&&!this.sessions.has(w.id))agents.push({target:w.id,provider:w.binding?.provider,threadId:w.threadId,busy:false,closed:true,resumable:w.binding?.provider==='omp'&&!w.readOnly,readOnly:w.readOnly===true,model:null,effort:null});
    const {sessionIndex,messages,...business}=this.store.state;
    return {...structuredClone(business),messages:this.timeline.messages(),timeline:this.timeline.frame(),quotaUsed:this.store.used(),agents,configuringTargets:[...(this.bindingTransitions??[])],...(this.ompSystemSource?{ompProviderStatus:this.#ompProviderStatus()}:{}),externalTerminalTargets:[...this.externalTerminalTargets],nativeDraftTargets:[...this.nativeDraftTargets],busyTargets:[...this.running.keys()],stopping:this.stopping};
  }
  // Nonsecret Nozeli-owned configuration and native role selection status.
  #ompProviderStatus(){
    const rolesStatus={};
    for(const role of ['frontdesk','orchestrator','worker']){
      const binding=this.store.state.bindings[role]||{};
      if(binding.provider!=='omp')continue;
      const session=this.sessions.get(role);
      rolesStatus[role]={selectionOwner:'native',configurationStatus:session?.configurationStatus??null,...(session?.effective?{effective:session.effective}:{})};
    }
    return {configRoot:this.ompSystemSource?.configRoot??null,authInheritance:this.ompAuthBroker?'nozeli-auth-broker':'none',roles:rolesStatus};
  }
  changed(){this.emit('state',this.snapshot());}
  async initializeBindings(){
    const skills={},defaults={};
    for(const role of Object.keys(roles)){
      skills[role]=(await fs.readdir(path.join(here,roles[role].package,'skills'))).filter(f=>f.endsWith('.md')).sort();
      const instructions=await rolePrompt(role,{skills:skills[role]});defaults[role]={provider:'omp',skills:skills[role],instructions,instructionDigest:createHash('sha256').update(instructions).digest('hex')};
    }
    await this.store.mutate(async()=>{
      const s=this.store.state;s.bindings??=structuredClone(defaults);s.roleSkills=skills;for(const role of Object.keys(roles))s.bindings[role]??=structuredClone(defaults[role]);
      for(const w of s.works)if(w.threadId&&!w.binding)w.binding={...structuredClone(defaults.worker),provider:'codex'};
      if(s.ompOnlyCutover!==1){
        s.residentArchive??={};s.bindingArchive??=[];
        for(const role of ['frontdesk','orchestrator'])if(s.residents?.[role]?.provider&&s.residents[role].provider!=='omp'){const record=s.residents[role],archive=s.residentArchive[role]??={};archive[record.provider]={...structuredClone(record),readOnly:true,messages:structuredClone((s.messages??[]).filter(message=>message.target===role)),archivedAt:new Date().toISOString()};delete s.residents[role];}
        for(const role of Object.keys(roles))if(s.bindings[role].provider!=='omp'){
          const previous=s.bindings[role];s.bindingArchive.push({role,reason:'omp-only-cutover',binding:structuredClone(previous)});
          if(role!=='worker'&&s.residents?.[role]){const archive=s.residentArchive[role]??={};archive[previous.provider||'codex']={...structuredClone(s.residents[role]),provider:previous.provider||'codex',readOnly:true,messages:structuredClone((s.messages??[]).filter(message=>message.target===role)),archivedAt:new Date().toISOString()};delete s.residents[role];}
          s.bindings[role]=structuredClone(defaults[role]);
        }
        for(const w of s.works)if(w.binding?.provider&&w.binding.provider!=='omp'){w.readOnly=true;w.contextRecovery={code:'HISTORICAL_SESSION_READ_ONLY',threadId:w.threadId,revision:w.revision,message:'Historical provider session retained read-only; never resumed by OMP'};if(!['ended','closing'].includes(w.status))w.status='paused';}
        s.ompOnlyCutover=1;
      }
      if(s.roleInstructionCutover!==1){
        const retired={orchestrator:new Set(['git.md','plan-tree.md'])};
        const migrate=async(role,binding,workId)=>{
          const selected=(binding.skills??skills[role]).filter(name=>!retired[role]?.has(name)),instructions=await rolePrompt(role,{skills:selected}),instructionDigest=createHash('sha256').update(instructions).digest('hex');
          if(JSON.stringify(binding.skills)!==JSON.stringify(selected)||binding.instructions!==instructions||binding.instructionDigest!==instructionDigest){s.bindingArchive??=[];s.bindingArchive.push({role,...(workId?{workId}:{}),at:new Date().toISOString(),reason:'work-outcome-role-instructions',binding:structuredClone(binding)});Object.assign(binding,{skills:selected,instructions,instructionDigest});}
        };
        for(const role of Object.keys(roles))await migrate(role,s.bindings[role]);for(const w of s.works)if(w.binding)await migrate('worker',w.binding,w.id);
        s.roleInstructionCutover=1;
      }
    });
  }
  async setBinding(role,{provider='omp',skills}={}){
    if(this.handoffPreparing?.size||this.residentHandoffs?.size||this.handoffConfirmations?.size)throw this.residentHandoffError('OMP_HANDOFF_CONFIRMATION_REQUIRED',role,'resident handoff blocks binding changes');
    if(!Object.hasOwn(roles,role))throw new Error('unknown role');
    if(provider!=='omp')throw Object.assign(new Error('Only the bundled OMP runtime is supported'),{code:'BACKEND_UNSUPPORTED'});
    const selected=skills??this.store.state.bindings[role].skills;
    if(!Array.isArray(selected)||new Set(selected).size!==selected.length||selected.some(s=>!this.store.state.roleSkills[role].includes(s)))throw new Error('unknown or duplicate role skill');
    if(this.configuring.has(role)||this.restarting?.has(role))throw new Error('role configuration in progress');
    if(role!=='worker'&&(this.nativeDraftTargets.has(role)||this.running.has(role)||this.store.state.jobs.some(j=>j.target===role&&j.status==='queued')))throw new Error('resident has accepted input; change settings when idle');
    this.configuring.add(role);const previous=structuredClone(this.store.state.bindings[role]);const previousResident=role!=='worker'?structuredClone(this.store.state.residents[role]??null):null;
    this.bindingTransitions??=new Set();this.bindingTransitions.add(role);
    this.changed();
    try{
      if(previous.provider==='omp'&&previous.model)await this.migrateNativeBinding(role,previous);
      const instructions=await rolePrompt(role,{skills:selected});const next={provider,skills:selected,instructions,instructionDigest:createHash('sha256').update(instructions).digest('hex')};
      await this.store.mutate(()=>{this.store.state.bindings[role]=next;});
      if(role!=='worker'){await this.terminals.get(role)?.close();await this.sessions.get(role)?.stop();this.sessions.delete(role);await this.session(role);}
      this.changed();return {saved:true,appliesTo:role==='worker'?'new-workers':'resident-same-thread'};
    }catch(error){
      await this.store.mutate(()=>{this.store.state.bindings[role]=previous;if(role!=='worker')this.store.state.residents[role]=previousResident??undefined;});
      if(role!=='worker'){await this.sessions.get(role)?.stop().catch(()=>{});this.sessions.delete(role);await this.session(role).catch(()=>{});}
      throw error;
    }finally{this.configuring.delete(role);this.bindingTransitions?.delete(role);this.changed();this.kick();}
  }
  async migrateNativeBinding(role,{model,effort=null}={}){
    if(!Object.hasOwn(roles,role))throw new Error('unknown role');
    if(typeof model!=='string'||!model.includes('/'))return {migrated:false};
    await this.store.mutate(()=>{this.store.state.legacyNativeSeeds??={};this.store.state.legacyNativeSeeds[role]??={model,effort};});
    return {migrated:true};
  }
  async setDraft(target,value){this.validateTarget(target);if(typeof value!=='string'||value.length>32000)throw new Error('invalid draft');await this.store.mutate(()=>{this.store.state.drafts[target]=value;});this.changed();this.kick();}
  validateTarget(target){if(!['frontdesk','orchestrator'].includes(target))this.store.find(target);}
  deviationHeld(target){return !['frontdesk','orchestrator'].includes(target)&&this.store.deviationHeld(target);}
  assertDeviationReleased(target){if(this.deviationHeld(target))throw Object.assign(Error('用户必须先处理任务偏离决定'),{code:'DEVIATION_HELD'});}
  async resolveDeviation({projectId,workId,deviationId,expectedRevision,expectedVersion,action,requestKey}={}){
    if(typeof projectId!=='string'||typeof workId!=='string'||typeof deviationId!=='string'||!Number.isInteger(expectedRevision)||!Number.isInteger(expectedVersion)||!['continue','replan'].includes(action)||typeof requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(requestKey))throw Error('invalid deviation decision');
    const identity=JSON.stringify([projectId,workId,deviationId,expectedRevision,expectedVersion,action]);
    const result=await this.store.mutate(()=>{
      const s=this.store.state;s.deviationActions??=[];
      const old=s.deviationActions.find(row=>row.requestKey===requestKey);
      if(old){if(old.identity!==identity)throw Object.assign(Error('deviation request key collision'),{code:'DEVIATION_REQUEST_COLLISION'});return structuredClone(old.result);}
      const w=this.store.find(workId),d=w.deviation;
      if(this.stopping||w.status!=='paused'||!d||d.id!==deviationId||w.revision!==expectedRevision||d.revision!==expectedRevision||d.version!==expectedVersion||!['pending','replanned'].includes(d.status)||action==='replan'&&d.status!=='pending')throw Object.assign(Error('stale deviation decision'),{code:'STALE_DEVIATION'});
      const at=new Date().toISOString(),resumeOriginal=d.status==='replanned';
      d.decisions??=[];d.decisions.push({action,from:d.status,version:d.version,requestKey,at});d.version++;d.status=action==='replan'?'replanned':'continued';
      let job;
      if(action==='replan'){
        job=this.queueJob('orchestrator','intake',d.sourceText,{key:`deviation-replan:${d.id}`,context:{manual:true,workHintId:w.id,deviationId:d.id,deviationSourceJobId:d.sourceJobId,progress:d.progress,problemObjectId:d.objectId,originalTask:w.request},priority:true});d.replanJobId=job.id;
      }else{
        if(!resumeOriginal){w.approvedScopes??=[];w.approvedScopes.push({deviationId:d.id,sourceJobId:d.sourceJobId,sourceText:d.sourceText,at,revision:w.revision});}
        const body=resumeOriginal?'用户明确决定恢复原始任务。已转交主控的偏离输入不是本轮命令，不得再次执行；仅继续原任务及此前明确批准的范围。':'用户明确授权在原Work处理下列原始触发输入（授权的是原文，不是模型改写的目标）：\n'+d.sourceText;
        job=this.queueJob(w.id,'deviation-resume',body,{key:`deviation-resume:${d.id}:${d.version}`,context:{deviationId:d.id,resumeOriginal,approvedSourceText:resumeOriginal?w.request:d.sourceText,sourceJobId:resumeOriginal?w.sourceJob:d.sourceJobId,imageAttachments:resumeOriginal?[]:d.sourceContext?.imageAttachments||[]},priority:true});d.resumeJobId=job.id;
      }
      const todo=s.todos.find(t=>t.id===d.todoId);if(todo){todo.status=action==='replan'?'open':'resolved';todo.expectedVersion=d.version;todo.resolution={action,resumeOriginal,at,version:d.version};}
      const value={accepted:true,workId,deviationId,version:d.version,status:d.status,action,jobId:job.id,resumeOriginal};s.deviationActions.push({requestKey,identity,result:structuredClone(value),at});return value;
    });this.changed();this.kick();return result;
  }
  async stopDeviationOwner(target){
    const session=this.sessions.get(target);if(!session)return;
    await this.terminals.get(target)?.close();
    const receipt=await session.stop();await session.controllerExitCleanup;
    if(session.pid&&(receipt?.confirmationComplete===false||this.store.find(target).binding?.provider==='omp'&&receipt?.confirmationComplete!==true))throw Error('Deviation Worker exit unconfirmed');
    if(this.sessions.get(target)===session)this.sessions.delete(target);
    await this.store.mutate(()=>{delete this.store.state.providers[target];});
  }
  async enqueue(target,type,value,{key=randomUUID(),context={},priority=false}={}){
    this.validateTarget(target);if(this.stopping)throw new Error('host stopping');if(typeof value!=='string'||!value.trim())throw new Error('invalid input');
    const job=await this.store.mutate(()=>this.queueJob(target,type,value,{key,context,priority}));
    this.changed();this.kick();return {accepted:true,jobId:job.id};
  }
  // Called only inside a store mutation so accepted input and its effects are durable together.
  queueJob(target,type,value,{key=randomUUID(),context={},priority=false}={}){
    if(this.handoffPreparing?.size||this.residentHandoffs?.size||this.handoffConfirmations?.size)throw this.residentHandoffError('OMP_HANDOFF_CONFIRMATION_REQUIRED',target,'resident handoff blocks new jobs');
    if(!['frontdesk','orchestrator'].includes(target)&&this.store.find(target).readOnly)throw Object.assign(new Error('Historical provider work is read-only'),{code:'HISTORICAL_SESSION_READ_ONLY'});
    if(this.stopping)throw new Error('host stopping');
    if(typeof value!=='string'||!value.trim())throw new Error('invalid input');
    if(type==='intake'&&context.routingQuestionId){const parent=this.store.state.jobs.find(j=>j.id===this.store.state.todos.find(q=>q.id===context.routingQuestionId)?.sourceJobId);if(parent?.context?.boundWorkId)context={...context,boundWorkId:parent.context.boundWorkId};}
    const old=this.store.state.jobs.find(j=>j.key===key);if(old){if(old.target!==target||old.type!==type||old.text!==value||JSON.stringify(old.context)!==JSON.stringify(context))throw Error('submission key collision');return structuredClone(old);}
    if(!['frontdesk','orchestrator'].includes(target)&&['queued','closing','ended'].includes(this.store.find(target).status))throw new Error('work cannot accept input in current state');
    const job={id:randomUUID(),key,target,type,text:value,context,status:'queued',promptStartedAt:null,at:new Date().toISOString()};
    // Priority may overtake other follow-ups, but never the worker's first input.
    const before=priority?this.store.state.jobs.findIndex(j=>j.target===target&&j.status==='queued'&&j.type!=='initial'):-1;
    if(before<0)this.store.state.jobs.push(job);else this.store.state.jobs.splice(before,0,job);
    this.store.state.messages.push({id:randomUUID(),target:type==='intake'&&context.boundWorkId?context.boundWorkId:type==='intake'&&context.manual?'frontdesk':target,speaker:'user',text:value,jobId:job.id,...(type==='intake'?{taskRequestId:intakeLineage(this.store.state,job)[0].id}:{})});
    if(type==='intake'&&context.frontJobId){const source=this.store.state.messages.find(m=>m.jobId===context.frontJobId&&m.speaker==='user');if(source)source.taskRequestId=intakeLineage(this.store.state,job)[0].id;}
    return structuredClone(job);
  }
  workContext(w,reader){
    const latest=kind=>this.store.state.receipts.filter(r=>r.workId===w.id&&r.kind===kind).at(-1)?.text;
    const closure=w.closure?{phase:w.closure.phase}:undefined;
    if(closure&&typeof w.closure.error==='string'){
      if(w.closure.error.length>1200&&reader){closure.error=w.closure.error.slice(0,1200);closure.errorTruncated=true;closure.errorReadRef=reader.add(w.closure.error,{title:'Work closure error',source:`state.json#work:${w.id}/closure.error`,kind:'work-closure'});}
      else closure.error=w.closure.error;
    }
    return {name:w.name||w.request,status:w.status,revision:w.revision,outcome:w.outcome,closure,request:w.request,brief:w.brief,inputs:w.inputs||[],approvedScopes:w.approvedScopes||[],deviation:w.deviation,problem:latest('problem'),result:latest('result')};
  }
  intakeBoundWork(job){if((job.context?.softWorkHint||job.context?.workHintId)&&!job.context?.boundWorkId)return undefined;const root=intakeLineage(this.store.state,job)[0].id;return this.store.state.works.find(w=>w.id===job.context?.boundWorkId||w.sourceJob!==job.id&&(w.sourceJob===root||w.sourceInputJobIds?.includes(root)));}
  intakeSource(job){
    const chain=intakeLineage(this.store.state,job);
    const inputs=job.context?.softWorkHint||job.context?.pendingIntakeId&&this.intakeBoundWork(job)?[job]:chain;
    return {request:inputs.filter((j,i)=>!j.context?.retryOf||j.text!==inputs[i-1]?.text).map((j,i)=>i?`用户澄清回答：\n${j.text}`:j.text).join('\n'),sourceInputJobIds:chain.map(j=>j.id),imageAttachments:[...new Map(chain.flatMap(j=>j.context?.imageAttachments||[]).map(ref=>[ref.digest,ref])).values()]};
  }
  routingContext({role='orchestrator'}={}){
    const preview=text=>typeof text==='string'?(text.length>480?text.slice(0,480)+'… [完整记录可用 nozeli_inspect_work 读取]':text):undefined;
    return JSON.stringify({quota:{used:this.store.used(),limit:this.store.state.limit},works:this.store.state.works.filter(w=>w.status!=='ended').map(w=>{
      const basic={name:w.name||w.request,status:w.status,revision:w.revision};
      if(role==='frontdesk')return basic;
      const detail=this.workContext(w);return {...basic,request:preview(detail.request),problem:preview(detail.problem),result:preview(detail.result)};
    }),questions:this.store.state.todos.filter(t=>t.kind==='routing'&&t.status==='open').map(t=>t.text)});
  }
  intakeHistory(frontJobId){
    const rows=this.store.state.messages.filter(m=>m.target==='frontdesk'||m.audience==='frontdesk');const at=rows.findIndex(m=>m.jobId===frontJobId);
    return rows.slice(Math.max(0,at-8),at).map(m=>`${m.speaker}: ${m.text.slice(0,1800)}`).join('\n');
  }
  routingMessage(route){
    const labels={queued:'排队中',running:'执行中',paused:'等待回答或处理',review:'结果待审查',closing:'正在结束归纳',ended:'已结束'};
    if(route.action==='clarify')return route.question||'需要明确任务，请查看待办。';
    if(route.action==='status'){const rows=route.facts?.works||[route.facts];return rows.filter(Boolean).map(w=>`${w.name}：${labels[w.status]||w.status}`).join('\n')||'当前没有开放任务。';}
    const name=route.workName||route.name;
    if(route.action==='cancel')return `已接受撤销“${name}”，正在归纳与清理。`;
    if(route.action==='continue')return route.status==='queued'?`补充已保存到“${name}”，等待名额后由原工作 Agent 一并接收。`:`补充已交给“${name}”，继续使用原工作 Agent。`;
    return `已建立“${name}”${this.store.find(route.workId).status==='queued'?'，等待工作名额':'，已开始调度'}。`;
  }
  async send(target,value,{priority=false,native=false,context={},requestKey,draftText}={}){
    this.validateTarget(target);
    if(!['frontdesk','orchestrator'].includes(target)&&this.store.find(target).readOnly)throw Object.assign(new Error('Historical provider work is read-only; confirm explicit context recovery before new input'),{code:'HISTORICAL_SESSION_READ_ONLY'});
    if(typeof value!=='string'||!value.trim()||value.length>32000)throw new Error('invalid input');
    if (!native) await this.sessions.get(target)?.refreshNativeDraft?.();
    const job=await this.store.mutate(()=>{
      const old=requestKey&&this.store.state.jobs.find(j=>j.key==='input:'+requestKey);
      if(!old&&!native&&this.nativeDraftTargets.has(target))throw Object.assign(new Error('原生终端仍有未发送文字。请在该Agent终端发送，或先保留内容再清空；对话草稿未丢失。'),{code:'NATIVE_DRAFT_PENDING'});
      const questionSource=this.store.state.jobs.find(j=>j.id===this.store.state.todos.find(q=>q.id===context.routingQuestionId)?.sourceJobId);
      const boundWorkId=context.boundWorkId||questionSource?.context?.boundWorkId;
      if(boundWorkId)context={...context,boundWorkId};
      context={...context};delete context.reviewReturn;
      const queued=!['frontdesk','orchestrator'].includes(target)&&(this.store.find(target).status==='queued'||old?.hostResolved);
      const job=this.queueJob(queued?'orchestrator':target,queued?'intake':target==='frontdesk'?'front':target==='orchestrator'?'intake':'manual',value,{priority,context:queued?{...context,boundWorkId:target}:context,...(requestKey?{key:'input:'+requestKey}:{})});
      // Explicitly accepted input is independent of other GUI composer drafts.
      // Keep this fact on this job only: automatic routing must retain its draft fence.
      if(!old)this.store.state.jobs.find(saved=>saved.id===job.id).explicitInput=true;
      if(queued&&!old){
        const work=this.store.find(target),saved=this.store.state.jobs.find(j=>j.id===job.id),at=new Date().toISOString();
        this.appendWorkInput(work,saved,{request:value,sourceInputJobIds:[job.id],imageAttachments:context.imageAttachments||[]});
        Object.assign(saved,{status:'completed',hostResolved:true,completion:'host-bound-input',finishedAt:at,routing:{action:'continue',workId:target,workName:work.name||work.request,status:'queued',queued:true,at}});
        Object.assign(job,structuredClone(saved));
      }
      if(!old&&this.store.state.drafts[target]===(draftText??value))this.store.state.drafts[target]='';return job;
    });this.changed();this.kick();return {accepted:true,jobId:job.id,...(job.hostResolved?{hostResolved:true}:{})};
  }
  // Keep exact user sources durable; routing notes are only delivered if they add information.
  workerInputText(original,note,label='主控补充说明'){
    return original+(typeof note==='string'&&note.trim()&&original.trim()!==note.trim()?`\n${label}：\n${note}`:'');
  }
  appendWorkInput(work,job,source,brief){
    work.inputs??=[];
    if(work.inputs.some(i=>i.sourceJobId===job.id))return;
    work.inputs.push({sourceJobId:job.id,sourceInputJobIds:source.sourceInputJobIds,text:source.request,...(brief!==undefined?{brief}:{}),context:structuredClone(job.context||{}),imageAttachments:structuredClone(source.imageAttachments),at:new Date().toISOString()});
    if(work.status==='queued'&&source.imageAttachments.length)work.imageAttachments=[...new Map([...(work.imageAttachments||this.store.state.jobs.find(j=>j.id===work.sourceJob)?.context?.imageAttachments||[]),...source.imageAttachments].map(ref=>[ref.digest+':'+ref.mime,ref])).values()];
  }
  initialWorkerText(work){
    const original=this.workerInputText(work.request,work.originalBrief??work.brief,'主控任务说明');
    const supplements=(work.inputs||[]).map(input=>'补充用户原文：\n'+this.workerInputText(input.text,input.brief));
    return [...(work.frontdeskTransfer?['前台已完成操作仅为历史，不得重放；只执行原范围内剩余步骤。当前执行目录为交接时真实项目版本。\n'+JSON.stringify(work.frontdeskTransfer)]:[]),'原始用户请求：\n'+original,...supplements,'项目目录中的文件是实际材料。缺信息就发布 problem 后结束当前回合，完成则发布 result；不要等待或结束 Work。'].join('\n');
  }
  async submitTask(value,{requestKey,context={},draftText=value}={}){
    if(typeof value!=='string'||!value.trim()||value.length>32000)throw Error('invalid input');
    const job=await this.store.mutate(()=>{
      const old=this.store.state.jobs.find(j=>j.key==='task:'+requestKey);
      const job=this.queueJob('orchestrator','intake',value,{key:'task:'+requestKey,context:{...context,manual:true}});
      if(!old&&this.store.state.drafts.frontdesk===draftText)this.store.state.drafts.frontdesk='';return job;
    });this.changed();this.kick();return {accepted:true,jobId:job.id};
  }
  frontGoal(job){return this.store.state.frontGoals?.find(g=>g.id===this.store.state.jobs.find(j=>j.id===job.id)?.context?.frontGoalId);}
  canReuseFrontGoal(value,goal){
    if(!goal)return false;
    const original=this.store.state.jobs.find(j=>j.id===goal.intakeJobId),bound=original&&(this.intakeBoundWork(original)||this.store.state.works.find(w=>w.sourceJob===original.id));
    if(bound&&['closing','ended'].includes(bound.status))return false;
    const text=value.trim();
    if(/^(?:请\s*)?(?:继续|补充|再来)?\s*(?:一个|另一个)?\s*(?:全新|新的)\s*独立(?:任务|目标|工作)/.test(text))return false;
    const named=text.match(/^(?:请(?:帮我)?|帮我|麻烦)?\s*(?:补充|继续|修改|重试|重做|不满意|对|关于)\s*(?:原|已有|当前|任务|工作)*\s*[“"「『]([^”"」』\n]+)[”"」』]/)?.[1]||text.match(/^(?:请(?:帮我)?|帮我|麻烦)?\s*(?:补充|继续|修改|重试|重做|不满意)\s*(?:(?:原|已有|当前)?(?:任务|工作)|原)\s*([^，,：:。\s“"「『]{1,100})/)?.[1];
    const mentions=name=>/^[A-Za-z0-9_]+$/.test(name)?new RegExp('(^|[^A-Za-z0-9_])'+name+'($|[^A-Za-z0-9_])').test(text):text.includes(name);
    const works=this.store.state.works.filter(w=>w.status!=='ended'&&w.name&&(named===w.name||mentions(w.name)));
    if(named&&!works.some(w=>w.name===named))return false;
    if(!works.length)return !named;
    // Names are only a reason to avoid inheriting a different goal. The model
    // still decides the target; ambiguous/unknown names never become host IDs.
    return works.length===1&&works[0].id===bound?.id;
  }
  async prepareFrontGoal(job){
    await this.store.mutate(()=>{
      const s=this.store.state;s.frontGoals??=[];const saved=s.jobs.find(j=>j.id===job.id);
      const previous=s.frontGoals.find(g=>g.id===s.activeFrontGoalId)||s.frontGoals.at(-1);
      let goal=s.frontGoals.find(g=>g.id===saved.context.frontGoalId)||(/^(继续|不满意|再来|重试|补充|修改|改成|换个|增加|再加|刚才|上面|上述|这个答案|1$|2$)/.test(job.text.trim())&&this.canReuseFrontGoal(job.text,previous)?previous:null);
      if(!goal){goal={id:randomUUID(),rootJobId:job.id,jobIds:[],reads:[],chars:0};s.frontGoals.push(goal);}
      if(!goal.jobIds.includes(job.id))goal.jobIds.push(job.id);saved.context.frontGoalId=goal.id;job.context.frontGoalId=goal.id;s.activeFrontGoalId=goal.id;
    });
  }
  async frontRead(job,selector,callId){
    return this.store.mutate(async()=>{
      const goal=this.frontGoal(job),saved=this.store.state.jobs.find(j=>j.id===job.id);
      if(goal.intakeJobId)return {readOnly:true,continueTurn:true,transferred:true,message:'此目标已交后台，停止前台执行。'};
      saved.readReceipts??=[];const old=saved.readReceipts.find(r=>r.callId===callId);if(old)return {...old.value,readOnly:true,continueTurn:true};
      const continuation=/^(.*)\s+@offset:(\d+)$/.exec(selector),base=continuation?continuation[1]:selector;
      const source=await frontSource(this,base,job);if(continuation)source.offset=Number(continuation[2]);
      const page=readPage(source,frontReadLimits.chars);
      const value={...page,...(page.truncated?{nextSelector:base+' @offset:'+(page.offset+page.text.length)}:{})};
      goal.reads.push({jobId:job.id,selector,...page});goal.chars+=page.text.length;
      saved.readReceipts.push({callId,value});return {...value,readOnly:true,continueTurn:true};
    });
  }
  frontEvidence(goal,currentText){
    const s=this.store.state,root=s.jobs.find(j=>j.id===goal.rootJobId),answer=s.messages.findLast(m=>goal.jobIds.includes(m.jobId)&&m.target==='frontdesk'&&m.speaker==='agent');
    const inputs=goal.jobIds.map(id=>s.jobs.find(j=>j.id===id)).filter(j=>j&&j.id!==goal.rootJobId&&j.text!==currentText);
    return [root?.text||currentText,...(inputs.length?['讨论补充原文：\n'+inputs.map(j=>j.text).join('\n')]:[]),...(root?.text!==currentText?['用户当前补充/反馈：\n'+currentText]:[]),...(answer?['前台上一答案（讨论材料，非已验证结论）：\n'+answer.text]:[]),...(goal.reads.length?['前台冻结读取证据（版本及原文）：\n'+JSON.stringify(goal.reads)]:[])].join('\n\n');
  }
  frontdeskCompleted(goal){return this.store.state.jobs.filter(j=>goal?.jobIds.includes(j.id)).flatMap(j=>(j.frontdeskOperations||[]).filter(r=>r.ok&&['apply','create'].includes(r.op)));}
  async proposeFrontdeskRoute(job,reason){
    const result=await this.store.mutate(()=>{
      const s=this.store.state;s.frontdeskRoutes??=[];
      const prior=job.context?.frontdeskResumeOf&&s.frontdeskRoutes.find(r=>r.id===job.context.frontdeskRouteId);
      if(prior?.status==='continued'&&prior.reason===reason)throw Object.assign(Error('用户已选择在前台继续；相同建议不再重复询问，继续原范围内剩余工作'),{code:'FRONTDESK_CONTINUE_SELECTED'});
      const old=s.frontdeskRoutes.find(r=>r.sourceJobId===job.id);if(old)return {...structuredClone(old),duplicate:true};
      const goal=this.frontGoal(job),proposal={id:randomUUID(),version:1,status:'pending',sourceJobId:job.id,goalId:goal?.id,reason,originalText:job.text,completedOperations:structuredClone(this.frontdeskCompleted(goal)),createdAt:new Date().toISOString()};
      s.frontdeskRoutes.push(proposal);s.todos.push({id:randomUUID(),kind:'frontdesk-route',status:'open',sourceJobId:job.id,proposalId:proposal.id,text:reason});return structuredClone(proposal);
    });this.changed();return {accepted:true,transferred:false,hostControl:true,userDecisionRequired:true,proposalId:result.id,version:result.version,status:result.status,...(result.duplicate?{duplicate:true}:{})};
  }
  async resolveFrontdeskRoute({proposalId,expectedVersion,action,requestKey}={}){
    if(typeof proposalId!=='string'||!Number.isInteger(expectedVersion)||!['continue','background'].includes(action)||typeof requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(requestKey))throw Error('invalid frontdesk route decision');
    const result=await this.store.mutate(async()=>{
      const s=this.store.state,identity=JSON.stringify([proposalId,expectedVersion,action]);s.frontdeskRouteDecisions??=[];
      const old=s.frontdeskRouteDecisions.find(r=>r.requestKey===requestKey);if(old){if(old.identity!==identity)throw Error('frontdesk route request key collision');return {...structuredClone(old.result),duplicate:true};}
      const route=s.frontdeskRoutes?.find(r=>r.id===proposalId),job=s.jobs.find(j=>j.id===route?.sourceJobId),goal=job&&this.frontGoal(job);
      if(!route||route.status!=='pending'||route.version!==expectedVersion||!job||goal?.id!==route.goalId||goal?.intakeJobId)throw Object.assign(Error('frontdesk route decision is stale'),{code:'STALE_FRONTDESK_ROUTE'});
      route.completedOperations=structuredClone(this.frontdeskCompleted(goal));
      const currentSources=[];for(const relPath of new Set(route.completedOperations.map(r=>r.value?.relPath).filter(Boolean))){
        const origin=route.completedOperations.find(r=>r.value?.relPath===relPath)?.actor;
        let source;
        if(this.frontdeskDocuments&&origin){const receipt=await this.frontdeskDocuments({op:'read',arguments:{relPath},actor:origin,operationId:createHash('sha256').update(proposalId+':decision-source:'+relPath).digest('hex'),isActive:()=>!this.stopping&&route.status==='pending'});if(!receipt.ok){currentSources.push({source:relPath,error:receipt.error});continue;}source=receipt.value;}
        else try{source=await frontSource(this,'file:'+relPath,job);}catch(error){currentSources.push({source:relPath,error:error.message});continue;}
        const body=String(source.text??''),snapshotDigest=createHash('sha256').update(body).digest('hex');
        await fs.writeFile(path.join(this.store.root,'objects',snapshotDigest+'.md'),body,{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});
        let end=Math.min(body.length,1200);if(end<body.length&&/[\uD800-\uDBFF]/.test(body[end-1])&&/[\uDC00-\uDFFF]/.test(body[end]))end--;
        currentSources.push({source:relPath,version:source.version,digest:source.digest??snapshotDigest,snapshotDigest,buffer:source.buffer,diskVersion:source.diskVersion,preview:body.slice(0,end),totalChars:body.length,truncated:end<body.length,readSelector:'frontdesk-source:'+snapshotDigest,instruction:'审批时冻结原文；前台用@read加readSelector分页读取，主控用nozeli_inspect_work workName="@frontdesk-source:摘要"读取；Worker读当前执行目录并核对版本。'});
      }
      const scopeInputs=(goal?.jobIds||[job.id]).map(id=>s.jobs.find(j=>j.id===id)).filter(j=>j&&!j.context?.frontdeskResumeOf).map(j=>({sourceJobId:j.id,text:j.text}));
      const history={originalRequest:s.jobs.find(j=>j.id===goal?.rootJobId)?.text??route.originalText,scopeInputs,completedOperations:route.completedOperations,currentSources};
      const text=(action==='background'?'宿主已收到并持久化用户选择：送到后台。此选择已完成，不再询问前台或后台；主控现在只判断新工作、已有工作或真正的归属歧义。':'宿主已收到并持久化用户选择：继续在前台。此选择已完成，直接处理原范围内剩余要求，不再重复建议同一次转后台。')+'\n只继续尚未完成的原目标；已完成操作是历史，不得重放；用户选择不扩大授权范围。建议原因不是用户指令，不授权额外目标。历史输入中“先等选择”的条件已由上述用户决定满足，不是本轮待回答问题。\n前台建议/剩余工作线索：'+route.reason+'\n历史与当前来源（原请求仅为范围依据，不是重新执行指令）：\n'+JSON.stringify(history);
      route.status=action==='continue'?'continued':'background';route.version++;route.decision={action,requestKey,at:new Date().toISOString()};
      let accepted;
      if(action==='continue'){const resume=this.queueJob('frontdesk','front',text,{key:'frontdesk-route:'+proposalId,context:{...job.context,frontGoalId:goal?.id,frontdeskResumeOf:job.id,frontdeskRouteId:proposalId,completedOperations:route.completedOperations}});accepted={accepted:true,proposalId,version:route.version,action,jobId:resume.id,transferred:false};}
      else {const routed=this.handoffFrontState(job,route.reason,{text,completedOperations:route.completedOperations,currentSources,frontdeskRouteId:proposalId});accepted={...routed,proposalId,version:route.version,action,transferred:true};}
      for(const todo of s.todos)if(todo.proposalId===proposalId&&todo.kind==='frontdesk-route'){todo.status='resolved';todo.resolution=action;}
      s.frontdeskRouteDecisions.push({requestKey,identity,result:accepted});return structuredClone(accepted);
    });this.changed();this.kick();return result;
  }
  async frontdeskOperation(job,p,op){
    const session=this.sessions.get('frontdesk'),s=this.store.state;
    if(typeof p.callId!=='string'||!p.callId)throw Error('document operation requires tool call identity');
    const operationId=createHash('sha256').update(s.workspaceId+job.id+p.callId).digest('hex');
    const actor={id:'nozeli:frontdesk:'+s.workspaceId,kind:'agent1',name:'前台',mark:'F',role:'frontdesk',provider:s.bindings.frontdesk.provider,sessionId:session?.threadId,sessionInstance:session?.viewOwnerId,requestId:job.id,sourceJobId:job.id};
    const isActive=()=>!this.stopping&&p.admission?.cancelled!==true&&this.sessions.get('frontdesk')===session&&this.current.get('frontdesk')===job&&!this.transferFor(job)&&!this.frontGoal(job)?.intakeJobId&&!this.store.state.frontdeskRoutes?.some(r=>r.sourceJobId===job.id);
    if(!isActive())return {ok:false,error:{code:'FRONTDESK_HELD',message:'当前来源等待用户决定或已转交'},continueTurn:true};
    if(!this.frontdeskDocuments)return {ok:false,error:{code:'CAPABILITY_UNAVAILABLE',message:'项目文档操作未接入；不能声称已读取或修改'},continueTurn:true};
    const value=await this.frontdeskDocuments({op,arguments:p.arguments,actor,operationId,isActive});
    await this.store.mutate(()=>{const saved=this.store.state.jobs.find(j=>j.id===job.id);saved.frontdeskOperations??=[];const index=saved.frontdeskOperations.findIndex(r=>r.operationId===operationId),receipt={operationId,callId:p.callId,op,actor,sourceJobId:job.id,at:new Date().toISOString(),...structuredClone(value)};if(index<0)saved.frontdeskOperations.push(receipt);else if(value.ok&&!saved.frontdeskOperations[index].ok)saved.frontdeskOperations[index]=receipt;});
    if(value.ok&&['apply','create'].includes(op))this.emit('files-changed',{jobId:job.id,reason:'frontdesk-document-applied',sourceChange:true});
    this.changed();return {...value,continueTurn:true};
  }
  async handoffFront(job,reason){
    const result=await this.store.mutate(()=>this.handoffFrontState(job,reason));this.changed();this.kick();return {...result,transferred:true};
  }
  handoffFrontState(job,reason,transfer={}){
      const goal=this.frontGoal(job);
      if(goal?.intakeJobId){
        const replay=this.store.state.jobs.find(j=>j.key===`handoff:${job.id}`);if(replay)return {accepted:true,jobId:replay.id,duplicate:true};
        const original=this.store.state.jobs.find(j=>j.id===goal.intakeJobId);
        if(original.context.frontJobId===job.id||original.transfer?.sourceJobIds.includes(job.id))return {accepted:true,jobId:original.id,duplicate:true};
        const work=this.intakeBoundWork(original)||this.store.state.works.find(w=>w.sourceJob===original.id);
        if(work&&['ended','closing'].includes(work.status))throw Error('原工作已结束；请明确重新开展独立任务');
        const question=this.store.state.todos.findLast(q=>q.kind==='routing'&&q.sourceJobId===original.id&&q.status==='open');
        const supplement=this.queueJob('orchestrator','intake',job.text,{key:`handoff:${job.id}`,context:{frontJobId:job.id,frontGoalId:goal.id,...(work?{workHintId:work.id}:{pendingIntakeId:original.id,softWorkHint:true}),...(question?{routingQuestionId:question.id}:{})}});
        return {accepted:true,jobId:supplement.id};
      }
      const text=transfer.text??(goal?this.frontEvidence(goal,job.text):job.text);
      const intake=this.queueJob('orchestrator','intake',text,{key:goal?`goal:${goal.id}`:`handoff:${job.id}`,context:{imageAttachments:job.context?.imageAttachments,frontJobId:job.id,handoffIntent:reason.slice(0,500),routingQuestionId:job.context?.routingQuestionId,...(goal?{frontGoalId:goal.id}:{}),...(transfer.frontdeskRouteId?{frontdeskRouteId:transfer.frontdeskRouteId,completedOperations:transfer.completedOperations,currentSources:transfer.currentSources}:{})}});
      if(goal){goal.intakeJobId=intake.id;for(const m of this.store.state.messages)if(goal.jobIds.includes(m.jobId))m.taskRequestId=intake.id;}
      this.prepareTransfer(intake.id,goal);
      return {accepted:true,jobId:intake.id};
  }
  async convertMessage(messageId,value,{requestKey}={}){
    if(typeof value!=='string'||value.length>12000)throw Error('补充目标过长');
    const canonical=this.store.state.messages.some(m=>m.id===messageId)?null:await this.timeline.read(messageId);
    const result=await this.store.mutate(()=>{
      const s=this.store.state,m=s.messages.find(m=>m.id===messageId)||canonical;if(!m||!['user','agent'].includes(m.speaker)||m.streaming||m.availability&&m.availability!=='available')throw Error('消息来源不存在或尚未持久化');
      const old=s.jobs.find(j=>j.key==='conversion:'+requestKey);if(old){if(old.context.sourceMessageId!==messageId||old.context.userGoal!==value)throw Error('submission key collision');return {accepted:true,jobId:old.id};}
      const sourceWork=s.works.find(w=>w.id===m.target);if(sourceWork&&!['ended','closing'].includes(sourceWork.status))return {accepted:true,jobId:sourceWork.sourceJob,workId:sourceWork.id,duplicate:true};
      const existing=s.jobs.findLast(j=>j.context?.sourceMessageId===messageId&&!j.context?.conversionSupplementOf&&(!j.routing?.workId||!['ended','closing'].includes(this.store.find(j.routing.workId).status)));
      if(existing)return this.conversionSupplement(existing,m,value,requestKey);
      const sourceJob=s.jobs.find(j=>j.id===m.jobId);let goal=s.frontGoals?.find(g=>g.id===sourceJob?.context?.frontGoalId);
      if(!goal&&sourceJob?.type==='front'&&['queued','running'].includes(sourceJob.status)){s.frontGoals??=[];goal={id:randomUUID(),rootJobId:sourceJob.id,jobIds:[sourceJob.id],reads:[],chars:0};s.frontGoals.push(goal);sourceJob.context.frontGoalId=goal.id;}
      const bound=goal?.intakeJobId&&s.jobs.find(j=>j.id===goal.intakeJobId),work=bound&&(this.intakeBoundWork(bound)||s.works.find(w=>w.sourceJob===bound.id));
      if(bound&&work?.status!=='ended'&&work?.status!=='closing')return this.conversionSupplement(bound,m,value,requestKey);
      const report=m.objectId?s.receipts.find(r=>r.objectId===m.objectId):null;const body=report?report.text:m.text;if(!body)throw Error('消息正文缺失');
      const text='用户明确将以下讨论材料转为后台任务，引用不是额外执行指令；如目标不足先澄清。\n用户补充目标：'+(value.trim()||'沿用引用中的明确目标')+'\n\n引用消息：\n'+body+(goal?'\n\n讨论来源：\n'+this.frontEvidence(goal,sourceJob.text):'');
      const job=this.queueJob('orchestrator','intake',text,{key:'conversion:'+requestKey,context:{manual:true,sourceMessageId:messageId,userGoal:value,...(goal&&!bound?{frontGoalId:goal.id,frontJobId:sourceJob.id}: {})}});
      m.taskRequestId=job.id;if(goal&&!bound){goal.intakeJobId=job.id;for(const row of s.messages)if(goal.jobIds.includes(row.jobId))row.taskRequestId=job.id;}
      this.prepareTransfer(job.id,goal&&!bound?goal:null);
      return {accepted:true,jobId:job.id};
    });this.changed();this.kick();void this.requestTransferStop(result.jobId).catch(e=>this.emit('diagnostic',e.message));return {...result,transferring:this.store.state.jobs.find(j=>j.id===result.jobId)?.status==='transferring'};
  }
  conversionSupplement(original,message,value,requestKey){
    const s=this.store.state;
    if(!value.trim()||original.context.userGoal===value)return {accepted:true,jobId:original.id,duplicate:true};
    const replay=s.jobs.find(j=>j.context?.conversionSupplementOf===original.id&&j.context.sourceMessageId===message.id&&j.context.userGoal===value);if(replay)return {accepted:true,jobId:replay.id,duplicate:true};
    const work=this.intakeBoundWork(original)||s.works.find(w=>w.sourceJob===original.id);
    const job=this.queueJob('orchestrator','intake','用户对已提交目标追加要求：\n'+value,{key:'conversion:'+requestKey,context:{manual:true,sourceMessageId:message.id,userGoal:value,conversionSupplementOf:original.id,...(work?{boundWorkId:work.id}:{pendingIntakeId:original.id})}});
    message.taskRequestId=original.id;return {accepted:true,jobId:job.id,supplement:true};
  }
  // All calls here occur in the existing state transaction; no provider calls.
  prepareTransfer(intakeId,goal){
    if(!goal)return;
    const s=this.store.state,intake=s.jobs.find(j=>j.id===intakeId);
    const sources=s.jobs.filter(j=>j.type==='front'&&j.context.frontGoalId===goal.id&&['queued','running'].includes(j.status));
    for(const j of sources)if(j.status==='queued'){j.status='cancelled';j.interruptionReason='user-transfer';j.finishedAt=new Date().toISOString();}
    const active=sources.filter(j=>j.status==='running');if(!active.length)return;
    intake.status='transferring';intake.transfer={status:'waiting',sourceJobIds:active.map(j=>j.id),at:new Date().toISOString()};
  }
  async requestTransferStop(intakeId){
    const intake=this.store.state.jobs.find(j=>j.id===intakeId);if(intake?.status!=='transferring')return;
    const active=this.current.get('frontdesk');if(!active||!intake.transfer.sourceJobIds.includes(active.id))return;
    const session=this.sessions.get('frontdesk');if(!session?.busy)return; // runJob's pre-prompt gate covers startup.
    try{if(typeof session.interrupt!=='function')throw Error('Provider不支持准确回合停稳');await session.interrupt();}
    catch(error){await this.store.mutate(()=>{const j=this.store.state.jobs.find(j=>j.id===intakeId);if(j.status==='transferring')j.transfer.error=error.message;});this.changed();}
  }
  transferFor(job){return this.store.state.jobs.find(j=>j.status==='transferring'&&j.transfer?.sourceJobIds.includes(job.id));}
  async finalizeTransfers({restoring=false}={}){
    if(!this.store.state.jobs.some(j=>j.status==='transferring'))return;
    await this.store.mutate(()=>{
      const s=this.store.state;
      for(const intake of s.jobs.filter(j=>j.status==='transferring')){
        const sources=intake.transfer.sourceJobIds.map(id=>s.jobs.find(j=>j.id===id));
        if(sources.some(j=>!j||['queued','running'].includes(j.status)))continue;
        for(const source of sources){
          const partial=s.messages.findLast(m=>m.jobId===source.id&&m.speaker==='agent');
          if(partial)intake.text+='\n\n转交前可观察输出（讨论材料，非最终成果）：\n'+partial.text;
        }
        intake.status=restoring?'interrupted':'queued';intake.transfer.status='settled';intake.transfer.settledAt=new Date().toISOString();if(restoring){intake.transfer.recovered=true;intake.error='Recovered transfer source evidence; explicit intake retry required';if(!s.todos.some(t=>t.sourceJobId===intake.id&&t.status==='open'))s.todos.push({id:randomUUID(),kind:'system',status:'open',sourceJobId:intake.id,text:'转交来源已停稳并保留；请显式重试已受理的主控输入，不自动重放前台或旧任务。'});}delete intake.transfer.error;
      }
    });
  }
  async resolveOpenTodo(kind,p){
    const {projectId,todoId,workId,revision=null,sourceJob=null,requestKey}=p;
    if(!['git','recovery'].includes(kind)||typeof requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(requestKey)||typeof projectId!=='string'||typeof todoId!=='string'||typeof workId!=='string')throw Error('invalid recovery payload');
    const identity=JSON.stringify([projectId,kind,todoId,workId,revision,sourceJob]);
    const result=await this.store.mutate(async()=>{
      const s=this.store.state;s.todoActions??=[];
      const old=s.todoActions.find(r=>r.requestKey===requestKey);
      if(old){if(old.identity!==identity)throw Error('recovery request key collision');if(old.result)return structuredClone(old.result);}
      const request=old||{requestKey,identity,at:new Date().toISOString()};
      if(!old){s.todoActions.push(request);await this.store.save();} // Claim identity durably before any Git publication.
      const deny=(code,message)=>({accepted:false,status:'blocked',error:{code,message},recoveryMode:'inspect-original-thread',workId,todoId,revision,sourceJob,requestKey});
      const todo=s.todos.find(t=>t.id===todoId&&t.workId===workId&&t.kind===kind&&t.status==='open'),w=s.works.find(w=>w.id===workId),job=s.jobs.find(j=>j.id===sourceJob);
      let value;
      if(!todo||!w)value=deny('STALE_TODO','事项已过期或不属于当前项目/工作');
      else if(kind==='recovery'&&(todo.origin==='closure-review'||w.closureHistory?.some(h=>h.reviewTodoId===todo.id)))value=deny('REVIEW_APPROVAL_REQUIRED','返回核查事项须由原工作显式核查、发布更新报告并获新认可后解决；只读查看不会完成核查');
      else if(todo.revision==null||!todo.sourceJobId||!job)value=deny('MISSING_SOURCE','历史事项缺少来源；请打开原线程核对文件，再显式提交新补充；不自动重放');
      else if(todo.revision!==revision||w.revision!==revision||todo.sourceJobId!==sourceJob||(kind==='git'?job.context?.workId!==workId:job.target!==workId||job.revision!==revision))value=deny('STALE_SOURCE','工作版本或执行来源已替代');
      else if(this.stopping||!['paused','review'].includes(w.status)||this.running.has(workId)||this.running.has('orchestrator')||this.starting.has(workId)||s.jobs.some(j=>['queued','running','transferring'].includes(j.status)&&(j.target===workId||j.context?.boundWorkId===workId||j.context?.workId===workId)))value=deny('BUSY','工作/主控忙、已结束或存在待执行补充；请停稳后核查');
      else if(s.drafts[workId]||s.drafts.orchestrator||this.nativeDraftTargets.has(workId)||this.nativeDraftTargets.has('orchestrator'))value=deny('DRAFT_CONFLICT','请先处理原工作或主控的未发送草稿');
      else if(kind==='recovery'){
        if(!w.threadId)value=deny('MISSING_THREAD','原线程缺失；保留材料，先核对现场再显式提交新补充');
        else value={accepted:true,status:'inspection-required',recoveryMode:'inspect-original-thread',requiresExplicitSupplement:true,automaticReplay:false,workId,threadId:w.threadId,todoId,revision,sourceJob,requestKey};
      }else value=deny('LEGACY_GIT_EVENT','旧Git模型事件只供历史核查；不会重放或提交');
      if(w&&this.deviationHeld(workId))throw Object.assign(Error('user deviation decision required'),{code:'DEVIATION_HELD'});
      if(value.accepted){todo.status='resolved';todo.resolution=structuredClone(value);if(value.git?.commit)todo.commit=value.git.commit;}
      if(!value.accepted&&todo)todo.lastRecoveryError=value.error;
      request.result=structuredClone(value);request.finishedAt=new Date().toISOString();return value;
    });this.changed();return result;
  }
  async manageTodo(payload){
    const result=await this.store.mutate(()=>manageTodoState(this.store.state,payload));
    this.changed();return result; // Reminder administration never kicks jobs or Git.
  }
  async retryIntake(jobId,requestKey){
    if(this.store.state.jobs.find(j=>j.id===jobId)?.status==='transferring'){await this.requestTransferStop(jobId);return {accepted:true,jobId,transferring:this.store.state.jobs.find(j=>j.id===jobId).status==='transferring'};}
    const job=await this.store.mutate(()=>{
      const original=this.store.state.jobs.find(j=>j.id===jobId&&j.type==='intake');
      if(original?.context?.boundWorkId&&['closing','ended'].includes(this.store.find(original.context.boundWorkId).status))throw Error('原工作已结束，不重试补充');
      if(!original||!['failed','interrupted'].includes(original.status)||original.routing||this.store.state.works.some(w=>w.sourceJob===original.id))throw Error('此提交不可重试，请查看已有工作或澄清待办');
      const root=intakeLineage(this.store.state,original)[0].id;
      const related=this.store.state.jobs.filter(j=>j.type==='intake'&&intakeLineage(this.store.state,j)[0].id===root);
      if(related.some(j=>j.routing?.workId))throw Error('已有工作已接收此提交，不重复派工');
      if(related.some(j=>j.routing))throw Error('主控已有处理结果，请查看现有记录或澄清待办');
      const pending=related.find(j=>['queued','running'].includes(j.status));if(pending)return structuredClone(pending);
      const retry=this.queueJob('orchestrator','intake',original.text,{key:'retry:'+requestKey,context:{...original.context,retryOf:original.id}});
      for(const todo of this.store.state.todos)if(todo.kind==='system'&&related.some(j=>j.id===todo.sourceJobId)&&todo.status==='open'){todo.status='resolved';todo.retryJobId=retry.id;}return retry;
    });this.changed();this.kick();return {accepted:true,jobId:job.id};
  }
  kick(){if(this.stopping||!this.started)return;if(this.kicking){this.again=true;return;}this.kicking=true;queueMicrotask(async()=>{try{do{this.again=false;await this.pump();}while(this.again&&!this.stopping);}catch(e){this.emit('diagnostic',e.message);}finally{this.kicking=false;}});}
  async pump(){
    while(!this.stopping && this.store.used()<this.store.state.limit){
      if(!this.store.state.works.some(w=>w.status==='queued'))break;
      const activated=await this.store.activateNext({initialize:w=>{w.binding=structuredClone(this.store.state.bindings.worker);this.queueJob(w.id,'initial',this.initialWorkerText(w),{key:`initial:${w.id}`,context:{sourceInputJobIds:[...new Set([...(w.sourceInputJobIds||[]),...(w.inputs||[]).flatMap(i=>i.sourceInputJobIds||[i.sourceJobId])])],imageAttachments:w.imageAttachments||this.store.state.jobs.find(j=>j.id===w.sourceJob)?.context?.imageAttachments}});}});
      if(!activated)break;this.changed();
    }
    for(const job of this.store.state.jobs){if(this.stopping)break;if(job.status!=='queued'||this.restarting?.has(job.target)||this.configuring.has(job.target)||this.running.has(job.target)||this.nativeDraftTargets.has(job.target)||(this.store.state.drafts[job.target]&&job.explicitInput!==true))continue;
      if(this.current.has(job.target))continue;
      if(this.deviationHeld(job.target))continue;
      if(job.context?.pendingIntakeId&&['transferring','queued','running'].includes(this.store.state.jobs.find(j=>j.id===job.context.pendingIntakeId)?.status))continue;
      const target=job.target;const promise=this.runJob(job).catch(e=>this.emit('diagnostic',e.message)).finally(()=>{this.running.delete(target);this.current.delete(target);this.changed();this.kick();});this.running.set(target,promise);
    }
  }
  session(target){
    this.validateTarget(target);
    if(this.deviationHeld(target))return Promise.reject(Object.assign(Error('用户必须先处理任务偏离决定'),{code:'DEVIATION_HELD'}));
    if(this.stopping)return Promise.reject(new Error('host stopping'));
    if(!['frontdesk','orchestrator'].includes(target)&&['queued','closing','ended'].includes(this.store.find(target).status))return Promise.reject(new Error('work has no attachable session'));
    if(this.restarting?.has(target))return this.restarting.get(target);
    return this.startSession(target);
  }
  startSession(target){
    if(this.deviationHeld(target))return Promise.reject(Object.assign(Error('用户必须先处理任务偏离决定'),{code:'DEVIATION_HELD'}));
    if((this.handoffPreparing?.size||this.handoffConfirmations?.size)&&!this.handoffAdmitting?.has(target))return Promise.reject(this.residentHandoffError('OMP_HANDOFF_BUSY',target,'resident handoff operation in progress'));
    if(this.getResidentHandoff(target)&&!this.handoffAdmitting?.has(target))return Promise.reject(this.residentHandoffError('OMP_HANDOFF_CONFIRMATION_REQUIRED',target,'explicit resident handoff confirmation required'));
    if(this.starting.has(target))return this.starting.get(target);
    const existing=this.sessions.get(target);if(existing&&!existing.closed)return Promise.resolve(existing);
    const promise=(async()=>{if(existing){const receipt=await existing.stop();await existing.controllerExitCleanup;if(receipt?.confirmationComplete===false&&existing.pid)throw new Error('old native owner exit unconfirmed');if(this.sessions.get(target)===existing)this.sessions.delete(target);}return this.makeSession(target);})().finally(()=>{if(this.starting.get(target)===promise)this.starting.delete(target);});
    this.starting.set(target,promise);return promise;
  }
  restart(target){
    this.validateTarget(target);
    if(this.deviationHeld(target))return Promise.reject(Object.assign(Error('用户必须先处理任务偏离决定'),{code:'DEVIATION_HELD'}));
    if(this.stopping)return Promise.reject(new Error('host stopping'));
    if(!['frontdesk','orchestrator'].includes(target)&&['queued','closing','ended'].includes(this.store.find(target).status))return Promise.reject(new Error('work cannot restart in current state'));
    if(this.configuring.has(target))return Promise.reject(new Error('role configuration in progress'));
    this.restarting??=new Map();if(this.restarting.has(target))return this.restarting.get(target);
    const promise=(async()=>{
      await this.starting.get(target)?.catch(()=>{});
      if(this.stopping)throw new Error('host stopping');
      const old=this.sessions.get(target);
      await this.terminals.get(target)?.close();
      if(old){let receipt;try{receipt=await old.stop({recover:true});}catch(error){error.details={...error.details,cleanupEvidence:old.cleanupEvidence?.()??null};throw error;}try{await old.controllerExitCleanup;}catch(error){if(!receipt?.recovered||error!==old.stopFailure){error.details={...error.details,cleanupEvidence:old.cleanupEvidence?.()??null};throw error;}}if(old.pid&&receipt?.confirmationComplete!==true)throw new Error('old native owner exit unconfirmed');if(this.sessions.get(target)===old)this.sessions.delete(target);}
      await this.running.get(target)?.catch(()=>{});
      if(this.stopping)throw new Error('host stopping');
      if(!['frontdesk','orchestrator'].includes(target)&&['queued','closing','ended'].includes(this.store.find(target).status))throw new Error('work cannot restart in current state');
      return this.startSession(target);
    })().finally(()=>{if(this.restarting.get(target)===promise)this.restarting.delete(target);this.changed();this.kick();});
    this.restarting.set(target,promise);this.changed();return promise;
  }
  async recoverWorkerContext(id,{revision,oldThreadId,confirmed}={}){
    if(confirmed!==true)throw Error('Explicit confirmation of a new native conversation is required');
    this.assertDeviationReleased(id);
    const w=this.store.find(id);if(w.contextHandoff?.oldThreadId===oldThreadId&&w.contextHandoff.revision===revision)return {accepted:true,duplicate:true,workId:id,archiveId:w.contextHandoff.archiveId,sameWork:true,sameWorktree:true,newConversation:true,automaticReplay:false,requiresExplicitInput:true};
    if(this.stopping||!['paused','review'].includes(w.status)||w.revision!==revision||w.threadId!==oldThreadId||!w.contextRecovery)throw Error('Worker context recovery is stale or unavailable');
    if(this.configuring.has(id)||this.running.has(id)||this.starting.has(id)||this.restarting?.has(id)||this.current.has(id)||this.store.state.jobs.some(j=>(j.target===id||j.context?.boundWorkId===id)&&['queued','running','transferring'].includes(j.status)))throw Error('Stop accepted Worker activity before context handoff; inputs will not be replayed');
    this.configuring.add(id);
    try{
      await this.terminals.get(id)?.close();const session=this.sessions.get(id);if(session){if(session.busy||session.currentTicket||session.blockedTicket||session.inFlightToolCalls?.size)throw Error('Native Worker activity must settle before schema handoff');const receipt=await session.stop();await session.controllerExitCleanup;if(session.pid&&(receipt?.confirmationComplete===false||(w.binding?.provider==='omp'&&receipt?.confirmationComplete!==true)))throw Error('Worker exit unconfirmed');this.sessions.delete(id);}
      const archiveId=randomUUID(),at=new Date().toISOString();
      const dossier={schema:1,workId:id,archiveId,oldThreadId,provider:w.binding?.provider,revision,request:w.request,brief:w.brief,inputs:structuredClone(w.inputs||[]),jobs:structuredClone(this.store.state.jobs.filter(j=>j.target===id||j.context?.boundWorkId===id)),reports:structuredClone(this.store.state.receipts.filter(r=>r.workId===id)),messages:structuredClone(this.store.state.messages.filter(m=>m.target===id)),source:`state.json#work:${id}`,at};
      const archiveBytes=Buffer.from(JSON.stringify(dossier)),objectId=createHash('sha256').update(archiveBytes).digest('hex');const file=path.join(this.store.root,'objects',objectId+'.json'),handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(archiveBytes);await handle.sync();}finally{await handle.close();}
      await this.store.mutate(()=>{
        if(w.threadId!==oldThreadId||w.revision!==revision||!w.contextRecovery||this.store.state.jobs.some(j=>(j.target===id||j.context?.boundWorkId===id)&&['queued','running','transferring'].includes(j.status)))throw Error('Worker context changed during confirmation');
        w.threadArchive??=[];w.threadArchive.push({id:archiveId,threadId:oldThreadId,provider:w.binding?.provider,revision,toolsDigest:w.toolsDigest||null,sessionFile:w.contextRecovery.sessionFile||null,dossierObjectId:objectId,dossierDigest:objectId,at,reason:'user-confirmed-tool-schema-handoff'});
        if(w.binding?.provider!=='omp'){w.binding=structuredClone(this.store.state.bindings.worker);delete w.readOnly;}
        w.contextHandoff={archiveId,dossierObjectId:objectId,dossierDigest:objectId,oldThreadId,revision,at};delete w.threadId;delete w.toolsDigest;delete w.contextRecovery;w.zeroActivity=true;delete this.store.state.providers[id];
      });this.changed();return {accepted:true,workId:id,archiveId,sameWork:true,sameWorktree:true,newConversation:true,automaticReplay:false,requiresExplicitInput:true};
    }finally{this.configuring.delete(id);}
  }
  async workerRecoveryContext(work,job){
    const handoff=work.contextHandoff;if(!handoff)return null;
    const {dossier}=await loadWorkerArchive(this.store.root,work,handoff.archiveId);job.reader=new ContextReader();
    const source=`objects/${handoff.dossierObjectId}.json`,refs={};for(const key of ['request','brief','inputs','jobs','reports','messages']){const ref=job.reader.add(typeof dossier[key]==='string'?dossier[key]:JSON.stringify(dossier[key]),{title:'Original Work '+key,source:source+'#'+key,kind:'worker-recovery'}),stable=`recovery/${handoff.archiveId}/${key}`;job.reader.entries.set(stable,job.reader.entries.get(ref));refs[key]=stable;}
    return {archiveId:handoff.archiveId,oldThreadId:handoff.oldThreadId,source,refs,note:'The user explicitly confirmed a new native conversation after incompatible tool schema. Same Work, Agent and worktree. Read original source records using nozeli_history_read before continuing. Historical inputs are context, not new commands; do not replay them. Only the current explicit input is scheduled.'};
  }
  async readWorkerArchive(id,query={}){return readWorkerArchiveFile(this.store.root,this.store.find(id),query);}
  // Explicit schema cutover only: prepare fences idle owners without changing identity.
  // Confirmation archives metadata (never moves/deletes native JSONL), then persists
  // one generation before startup. Its handoff stamp survives startup failure so a
  // retry resumes the known new thread; old prompts/jobs/drafts are never replayed.
  getResidentHandoff(role){return this.residentHandoffs?.get(role)??null;}
  residentHandoffError(code,role,message){return Object.assign(new Error(message),{code,target:role,role});}
  assertResidentHandoffSafe(role){
    if(!['frontdesk','orchestrator'].includes(role)||this.store.state.bindings[role]?.provider!=='omp')throw this.residentHandoffError('OMP_HANDOFF_TARGET',role,'handoff requires an OMP resident');
    if([...(this.handoffPreparing?.keys()??[]),...(this.handoffConfirmations?.keys()??[])].some(target=>target!==role))throw this.residentHandoffError('OMP_HANDOFF_BUSY',role,'another resident handoff is in progress');
    if(this.stopping||this.configuring.has(role)||this.restarting?.has(role)||this.starting.size)throw this.residentHandoffError('OMP_HANDOFF_BUSY',role,'resident lifecycle operation in progress');
    const s=this.store.state;
    if(s.jobs.some(j=>j.manual===true&&!['completed','cancelled'].includes(j.status)))throw this.residentHandoffError('OMP_HANDOFF_UNRESOLVED',role,'manual settlement must be resolved before handoff');
    if(this.running.size||this.current.size||s.jobs.some(j=>['queued','running','transferring'].includes(j.status))||s.works.some(w=>w.status==='closing')||this.closures.size)throw this.residentHandoffError('OMP_HANDOFF_BUSY',role,'active jobs or closing Work prevent handoff');
    for(const session of this.sessions.values()){
      if(session.busy||session.currentTicket||session.blockedTicket||session.unsettledPromptError||session.inFlightToolCalls?.size||session.phase?.includes('unsettled')||session.phase?.includes('unresolved'))throw this.residentHandoffError('OMP_HANDOFF_UNRESOLVED',role,'unresolved resident turn prevents handoff');
      if(session.sideEffectFacts?.length)throw this.residentHandoffError('OMP_HANDOFF_SIDE_EFFECTS_UNKNOWN',role,'unverified tool side effects prevent handoff');
    }
    if(this.residentHandoffFailures?.get(role)?.unsafe)throw this.residentHandoffError('OMP_HANDOFF_SIDE_EFFECTS_UNKNOWN',role,'unverified tool side effects prevent handoff');
  }
  async stopResidentHandoffOwners(role){
    for(const target of ['frontdesk','orchestrator']){
      const owner=this.sessions.get(target);await this.terminals.get(target)?.close();
      if(owner){const receipt=await owner.stop();await owner.controllerExitCleanup;if(owner.pid&&receipt?.confirmationComplete!==true)throw this.residentHandoffError('OMP_EXIT_UNCONFIRMED',role,'old native owner exit unconfirmed');if(this.sessions.get(target)===owner)this.sessions.delete(target);}
    }
    await this.store.mutate(()=>{for(const target of ['frontdesk','orchestrator'])delete this.store.state.providers[target];});
  }
  prepareResidentHandoff(role){
    this.handoffPreparing??=new Map();if(this.handoffPreparing.has(role))return this.handoffPreparing.get(role);
    const promise=(async()=>{
      this.assertResidentHandoffSafe(role);
      const existing=this.getResidentHandoff(role);if(existing)return existing;
      const failure=this.residentHandoffFailures?.get(role),resident=this.store.state.residents[role];
      if(!failure||!resident?.threadId||resident.threadId!==failure.oldThreadId)throw this.residentHandoffError('OMP_HANDOFF_NOT_REQUIRED',role,'no schema mismatch awaiting explicit handoff');
      await this.stopResidentHandoffOwners(role);this.assertResidentHandoffSafe(role);
      const challenge=Object.freeze({role,oldThreadId:resident.threadId,expectedToolsDigest:failure.expectedToolsDigest,newToolsDigest:failure.newToolsDigest,token:randomUUID(),reason:'OMP_TOOLS_DIGEST_MISMATCH'});
      this.residentHandoffs??=new Map();this.residentHandoffs.set(role,challenge);this.changed();return challenge;
    })().finally(()=>{if(this.handoffPreparing.get(role)===promise)this.handoffPreparing.delete(role);});
    this.handoffPreparing.set(role,promise);return promise;
  }
  confirmResidentHandoff({role,token,oldThreadId}={}){
    const challenge=this.getResidentHandoff(role),previousHandoff=this.store.state.residents[role]?.handoff;
    const saved=previousHandoff?.token===token&&previousHandoff?.oldThreadId===oldThreadId?previousHandoff:null;
    if(!challenge||challenge.token!==token||challenge.oldThreadId!==oldThreadId)return Promise.reject(this.residentHandoffError('OMP_HANDOFF_TOKEN_INVALID',role,'handoff confirmation does not match this resident'));
    this.handoffConfirmations??=new Map();if(this.handoffConfirmations.has(role))return this.handoffConfirmations.get(role);
    const promise=(async()=>{
      this.assertResidentHandoffSafe(role);await this.stopResidentHandoffOwners(role);this.assertResidentHandoffSafe(role);
      if(!saved){
        await this.store.mutate(()=>{
          const previous=this.store.state.residents[role];if(previous?.threadId!==oldThreadId)throw this.residentHandoffError('OMP_HANDOFF_STALE',role,'resident identity changed');
          const archiveId=randomUUID(),generation=(previous.generation??0)+1;
          this.store.state.residentArchive??={};const slot=this.store.state.residentArchive[role]??={};slot.handoffs??=[];
          slot.handoffs.push({...structuredClone(previous),id:archiveId,role,oldThreadId,sessionFile:this.residentHandoffFailures.get(role).sessionFile??null,archivedAt:new Date().toISOString(),generation:previous.generation??0,reason:challenge.reason});
          this.store.state.residents[role]={provider:'omp',generation,toolsDigest:challenge.newToolsDigest,zeroActivity:true,handoff:{archiveId,token,oldThreadId,generation,status:'confirmed'}};
          this.store.state.recoveryEvents.push({at:new Date().toISOString(),type:'resident-handoff-confirmed',target:role,archiveId,oldThreadId,generation,expectedToolsDigest:challenge.expectedToolsDigest,newToolsDigest:challenge.newToolsDigest});
        });
      }
      this.handoffAdmitting??=new Set();this.handoffAdmitting.add(role);
      try{const session=await this.startSession(role);this.residentHandoffs.delete(role);this.residentHandoffFailures.delete(role);this.changed();return {confirmed:true,role,threadId:session.threadId,archiveId:this.store.state.residents[role].handoff.archiveId};}
      finally{this.handoffAdmitting.delete(role);}
    })().finally(()=>{if(this.handoffConfirmations.get(role)===promise)this.handoffConfirmations.delete(role);});
    this.handoffConfirmations.set(role,promise);return promise;
  }
  observeSession(target,session){
    session.viewOwnerId??=randomUUID();
    session.on?.('diagnostic',message=>{if(this.sessions.get(target)===session)this.emit('diagnostic',`${target}: ${message}`);});
    session.on?.('change',()=>{if(this.sessions.get(target)===session)this.changed();});
    session.on?.('native-draft',hasText=>{
      if(this.sessions.get(target)!==session)return;
      const previous=this.nativeDraftTargets.has(target);
      if(hasText)this.nativeDraftTargets.add(target);else this.nativeDraftTargets.delete(target);
      if(previous!==hasText){this.changed();if(!hasText)this.kick();}
    });
    session.on?.('exit',exit=>{
      if(this.sessions.get(target)!==session)return;
      this.nativeDraftTargets.delete(target);this.emit('session-exit',{target,threadId:session.threadId,exit});this.changed();
      const cleanup=(async()=>{await session.manualOpenPromise;if(this.sessions.get(target)!==session)return;const job=this.current.get(target);if(job?.manual)await this.settleManualJob(target,{promptId:job.manualPromptId,jobId:job.id,error:`OMP terminal exited (${exit?.exitCode??exit?.code??exit?.signal??'unknown'})`});let stopError,receipt;try{receipt=await session.stop();}catch(error){stopError=error;receipt=session.lastExitReceipt;}if(this.sessions.get(target)!==session){if(stopError)throw stopError;return;}if(receipt?.confirmationComplete===true)await this.store.mutate(()=>{if(this.sessions.get(target)===session)delete this.store.state.providers[target];});this.changed();if(stopError)throw stopError;})();session.controllerExitCleanup=cleanup;void cleanup.catch(error=>this.emit('diagnostic',error.message));
    });
  }
  async makeSession(target,{preflightOnly=false}={}){
    const role=['frontdesk','orchestrator'].includes(target)?target:'worker';const workerBinding=role==='worker'?(this.store.find(target).binding||this.store.state.bindings.worker):null;
    if(role==='worker')this.assertDeviationReleased(target);
    const provider=workerBinding?.provider||this.store.state.bindings[role]?.provider||'omp';
    if(provider!=='omp'){
      if(role==='worker')await this.store.mutate(()=>{const work=this.store.find(target);work.readOnly=true;work.contextRecovery={code:'HISTORICAL_SESSION_READ_ONLY',threadId:work.threadId,revision:work.revision,message:'Original provider identity retained read-only; explicit context recovery required'};});
      throw Object.assign(new Error('Historical provider sessions are read-only; their identity cannot be resumed by OMP'),{code:'HISTORICAL_SESSION_READ_ONLY',target});
    }
    const home=role==='worker'?this.store.agentHome(target):path.join(this.store.root,'agents',`resident-${role}-omp`);
    const cwd=role==='worker'&&this.execution?(await this.execution.prepare(target),this.execution.directory(target)):this.store.content;
    const tools=role==='frontdesk'?[tool('nozeli_handoff','Propose background work with a concise remaining-work reason, then wait for the user decision; this does not dispatch. @read reads and @new/@continue select discussion context only.',{reason:text})]:role==='orchestrator'?[tool('nozeli_inspect_work','Read named Work or readRef. @memory:keywords searches Plan Tree; @conversation reads dialogue; @state returns open works. Read-only.',{workName:text}),tool('nozeli_dispatch','Create a named Worker only for an independent new task.',{name:text,brief:text}),tool('nozeli_manage','Continue the same named Work, query status or clarify routing. User end decisions belong to user controls.',{action:{type:'string',enum:['continue','status','clarify']},workName:text,text})]:[tool('nozeli_publish','Publish current problem/result and exact final report with concise sourced summary; then finish this turn. Work remains open.',{kind:{type:'string',enum:['problem','result']},text,files:{type:'array',items:{type:'string'},maxItems:256}})];
    const binding=role==='worker'?this.store.find(target).binding||this.store.state.bindings.worker:this.store.state.bindings[role];
    if(role==='frontdesk')tools.push(
      tool('nozeli_document_read','Read a project document and obtain the exact host version handle before editing.',{relPath:text}),
      tool('nozeli_document_apply','Apply precise UTF-16 edits with LF lines against a host readHandle; optional contexts protect source ranges. Preserve concurrent edits and authorship.',{readHandle:text,edits:{type:'array',minItems:1,maxItems:1000,items:{type:'object',properties:{from:{type:'integer',minimum:0},to:{type:'integer',minimum:0},insert:text,expected:text},required:['from','to','insert'],additionalProperties:false}},contexts:{type:'array',items:{type:'object',properties:{from:{type:'integer',minimum:0},to:{type:'integer',minimum:0}},required:['from','to'],additionalProperties:false}}},['readHandle','edits']),
      tool('nozeli_document_create','Create and save a new project text document without overwriting existing files or drafts.',{relPath:text,text}),
      tool('nozeli_project_list','List a project directory; empty relPath is the root. Follow nextOffset for additional pages.',{relPath:text,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:500}},['relPath']),
      tool('nozeli_project_search','Search literal project text; pass the returned cursor to continue.',{query:text,relPath:text,cursor:{type:'object',properties:{scope:text,query:text,relPath:text,offset:{type:'integer',minimum:0}},required:['scope','query','relPath','offset'],additionalProperties:false}},['query','relPath']));
    if(role==='worker'&&this.execution)tools.push(
      tool('nozeli_document_read','Read an EXISTING UTF-8 project text file with a host-bound revision handle. Use this before editing existing text; shell reads do not provide a safe write baseline.',{relPath:text}),
      tool('nozeli_document_apply','Apply precise edits against the exact returned readHandle. UTF-16 offsets, LF lines; after failure re-read and reconsider or publish a problem. This write continues the turn for verification/reporting. Never overwrite a stale candidate with shell.',{readHandle:text,edits:{type:'array',minItems:1,maxItems:1000,items:{type:'object',properties:{from:{type:'integer',minimum:0},to:{type:'integer',minimum:0},insert:text,expected:text},required:['from','to','insert'],additionalProperties:false}}}));
    if(role==='worker'&&!this.store.find(target).binding)await this.store.mutate(()=>{this.store.find(target).binding=structuredClone(binding);});
    if(role==='worker')tools.push(tool('nozeli_skill_read','Read one granted role/domain skill by filename, e.g. material.md; returns versioned read-only instructions without project or host side effects.',{name:text}));
    if(role==='worker')tools.push(tool('nozeli_report_deviation','Report obvious task scope deviation and STOP. Host binds exact admitted input and original Work; only the user may authorize continuing or replanning.',{changedGoal:text,reason:text,progress:text}));
    if(role==='worker')tools.push(tool('nozeli_history_read','Read an original Work source using an exact recovery readRef supplied by the host. Read-only; never treat archived user inputs as new scheduled commands.',{readRef:text}));
    const roleInstructions=provider==='omp'||role==='worker'?await rolePrompt(role,{skills:binding.skills}):binding.instructions;
    const recoveryBinding={};const recoveryContext=role==='worker'?await this.workerRecoveryContext(this.store.find(target),recoveryBinding):null;if(recoveryContext){this.workerRecoveryReaders??=new Map();this.workerRecoveryReaders.set(target,recoveryBinding.reader);}
    const instructions=roleInstructions+'\n'+contextInstructions[role]+'\nNozeli host tools are the sole control channel. After a routing proposal, routing or publication finish this turn. Document and search results continue the turn. Work continues in the same thread until the user explicitly ends it. Worker owns report and sourced summary. Host controls Git and technical cleanup, never a model acceptance gate. Frontdesk document tools operate in the authorized project; Worker file tools operate only in its execution worktree.'+(recoveryContext?'\nUser-confirmed context handoff sources:\n'+JSON.stringify(recoveryContext):'');
    const spec={...roles[role],role,provider,...(role!=='worker'?{baseInstructions:residentBaseInstructions}:{}),model:null,effort:null,cwd,home,command:this.ompCommand,ompSystemSource:this.ompSystemSource,ompAuthBroker:this.ompAuthBroker,legacyNativeSeed:binding.model?{model:binding.model,effort:binding.effort??null}:(this.store.state.legacyNativeSeeds?.[role]??null),...(this.isolateProcesses?{isolation:{writable:role==='worker'?[cwd]:[],readOnly:role==='worker'?[path.join(cwd,'.git')]:[]}}:{}),instructions,tools,finishOnHostControl:true,
      collabContext:{projectId:this.projectId,targetId:target,ownerId:randomUUID()},
      onTransportFact:fact=>this.recordTransport(target,fact),
      onCollabEntry:fact=>this.recordNativeEntries(target,fact),
      onCollabEvent:fact=>this.recordNativeEvent(target,fact),
      // OMP：宿主工具副作用前必须过 admission.preEffect（owner/ticket 代次门），失败即拒绝该次副作用。
      onTool:async p=>{await p.admission?.preEffect();return this.onTool(target,p);},
      onBeforeAgentStart:async()=>{if(this.stopping)throw Error('host stopping');this.assertDeviationReleased(target);const active=this.current.get(target);if(!active)throw Error('no admitted host job');if(role!=='worker')return {};const w=this.store.find(target);if(w.status!=='running'||active.revision!==w.revision)throw Error('stale Worker turn');active.reader??=new ContextReader();return {taskAnchor:workerTaskAnchor(w,active.reader)};},
      // OMP TUI 人工输入所有权（root）：人工提交接 durable job 链（唯一输入、回执、正常收尾），不二次派发模型输入。
      onManualInput:async ({promptId,text})=>this.openManualJob(target,promptId,text),
      onManualSettled:async settlement=>this.settleManualJob(target,settlement),
      onSpawn:async pid=>{const stamp=await processStamp(pid);await this.store.mutate(()=>{this.store.state.providers[target]={pid,stamp,home,kind:'omp-tui'};});}};
    // P4 路线（root 决策）：OMP 角色会话 = TUI-native（OmpTuiSession，唯一 PTY/session owner）。
    // 模型/思考档位由原生会话独占，桥只观察；同一角色不双 owner。
    let session=this.sessionFactory?this.sessionFactory(spec,target):new OmpTuiSession(spec);
    if(!preflightOnly){this.sessions.set(target,session);this.observeSession(target,session);}
    const toolsDigest=session.toolsDigest??createHash('sha256').update(JSON.stringify(tools)).digest('hex'),resident=this.store.state.residents[target];
    try{
      let resumeId=role==='worker'?this.store.find(target).threadId:resident?.threadId;
      const workOwner=role==='worker'?this.store.find(target):null;
      const workerHistory=Boolean(workOwner?.threadId&&workOwner.zeroActivity!==true);
      const workerExpected=workOwner?.toolsDigest;
      if(workerHistory&&provider==='omp'){
        session.sessionFile=await pinSessionFileById(path.join(home,'sessions'),workOwner.threadId);
        if(typeof session.preflightToolsDigest!=='function')throw Object.assign(Error('Worker historical schema preflight unavailable; original thread retained'),{code:'WORKER_CONTEXT_RECOVERY_REQUIRED',target});
        await session.preflightToolsDigest(workerExpected||toolsDigest);
      }
      // Reject non-equivalent historical schemas before native resume can append
      // model/session lifecycle records to the old read-only conversation log.
      if(provider==='omp'&&role!=='worker'&&resident?.threadId&&resident?.toolsDigest){
        session.sessionFile=await pinSessionFileById(path.join(home,'sessions'),resident.threadId);
        if(typeof session.preflightToolsDigest!=='function')throw Object.assign(new Error('OMP historical schema preflight unavailable'),{code:'OMP_TOOLS_DIGEST_MISMATCH'});
        try { await session.preflightToolsDigest(resident.toolsDigest); }
        catch(error) {
          const attempted=this.store.state.jobs.some(j=>j.target===target&&(j.manual===true||j.promptStartedAt!=null));
          const messages=this.store.state.messages.some(m=>m.target===target);
          let empty=resident.zeroActivity===true&&!attempted&&!messages&&!resident.handoff;
          if(empty&&session.sessionFile){
            try {
              const stat=await fs.lstat(session.sessionFile);
              if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)empty=false;
              else for(const line of (await fs.readFile(session.sessionFile,'utf8')).split('\n')){
                if(!line.trim())continue;
                const row=JSON.parse(line);
                if(!['session','title','model_change','thinking_level_change','session_info'].includes(row.type)){empty=false;break;}
              }
            } catch { empty=false; }
          }
          if(error.code!=='OMP_TOOLS_DIGEST_MISMATCH'||!empty)throw error;
          // No accepted input or native message exists. Keep the old identity as
          // startup metadata, never manufacture conversation history or replay.
          if(!preflightOnly){
            await this.store.mutate(()=>{
              this.store.state.recoveryEvents.push({at:new Date().toISOString(),type:'omp-empty-schema-updated',target,previousThreadId:resident.threadId,previousToolsDigest:resident.toolsDigest,newToolsDigest:toolsDigest});
              this.store.state.residents[target]={...resident,threadId:undefined,toolsDigest:undefined};
            });
          }
          resumeId=undefined;session.emptySchemaUpdated=true;
        }
      }
      if(preflightOnly)return {preflight:true,target};
    if(!preflightOnly&&provider==='omp'){
      // Seed private role configuration once from the independent Nozeli base.
      await prepareOmpPrivateHome(home,{system:this.ompSystemSource});
    }
      try{await session.start(resumeId);}catch(error){
        // 已派工/已发 prompt 的历史不可当空会话：promptStartedAt!=null 即有历史（含 cancelled——取消不消除已发 prompt/副作用）。
        const attempted=this.store.state.jobs.some(j=>j.target===target&&j.promptStartedAt!==null);
        if(provider==='omp'){
          // OMP 零活动恢复缺失：仅可证明从未 admitted（promptStartedAt 全空 + durable zeroActivity）时允许显式新代次；
          // 不伪造文件/不重放；新建 OMP 实例（不用 Codex），恢复后走同一持久化路径。
          if(resumeId&&!resident?.handoff&&(role==='worker'?this.store.find(target).zeroActivity:resident?.zeroActivity)===true&&!attempted&&String(error.message).includes('OMP_SESSION_FILE_NOT_FOUND')){
            await this.store.mutate(()=>{this.store.state.recoveryEvents.push({at:new Date().toISOString(),type:'omp-zero-activity-restarted',target,previousThreadId:resumeId});});
            await session.stop().catch(()=>{});
            session=this.sessionFactory?this.sessionFactory(spec,target):new OmpTuiSession(spec);   // P4：零活动重试同 dispatch（TUI-native），不混 RPC
            this.sessions.set(target,session);
            this.observeSession(target,session);
            await session.start();
            session.zeroActivityRestarted=true;
          }else throw error;   // OMP 任何其他恢复失败（有历史/未知/非缺失）不回退不重建
        }
      }
      if(provider==='omp'&&role!=='worker'&&resident?.threadId&&resident?.toolsDigest&&!session.emptySchemaUpdated){
        if(typeof session.assertToolsDigest!=='function')throw Object.assign(new Error('OMP historical schema equivalence cannot be established'),{code:'OMP_TOOLS_DIGEST_MISMATCH'});
        await session.assertToolsDigest(resident.toolsDigest);
      }
      if(workerHistory&&provider==='omp')await session.assertToolsDigest(workerExpected||toolsDigest);
      await this.store.mutate(()=>{
        if(role==='worker'){const work=this.store.find(target);work.threadId=session.threadId;work.toolsDigest=session.toolsDigest??toolsDigest;if(provider==='omp'&&work.zeroActivity!==false)work.zeroActivity=!session.hasPrompted&&!(session.agentEnds?.length>0);}
        else this.store.state.residents[target]={threadId:session.threadId,provider,model:provider==='omp'?(session.model??spec.model??null):spec.model,effort:provider==='omp'?(session.effort??spec.effort??null):spec.effort,toolsDigest:session.toolsDigest??toolsDigest,...(provider==='omp'?{zeroActivity:!session.hasPrompted&&!(session.agentEnds?.length>0)}:{}),...(resident?.zeroActivity===false?{zeroActivity:false}:{}),...(resident?.generation!=null?{generation:resident.generation}:{}),...(resident?.handoff?{handoff:{...resident.handoff,status:'ready'}}:{})};
      });this.changed();return session;
    }catch(e){
      if(role==='worker'&&['WORKER_CONTEXT_RECOVERY_REQUIRED','OMP_TOOLS_DIGEST_MISMATCH','OMP_SESSION_FILE_NOT_FOUND'].includes(e.code)){
        await this.store.mutate(()=>{const work=this.store.find(target);work.contextRecovery={threadId:work.threadId,revision:work.revision,code:e.code,message:e.message,expectedToolsDigest:work.toolsDigest||null,newToolsDigest:session.toolsDigest??toolsDigest,sessionFile:session.sessionFile||null};});this.changed();
      }
      if(e.code==='OMP_TOOLS_DIGEST_MISMATCH'&&provider==='omp'&&role!=='worker'&&resident?.threadId){
        Object.assign(e,{target,role,expectedToolsDigest:resident.toolsDigest,newToolsDigest:session.toolsDigest??toolsDigest,actualToolsDigest:session.toolsDigest??toolsDigest});
        this.residentHandoffFailures??=new Map();this.residentHandoffFailures.set(target,{...e,oldThreadId:resident.threadId,sessionFile:session.sessionFile??null,unsafe:Boolean(session.busy||session.currentTicket||session.blockedTicket||session.inFlightToolCalls?.size||session.sideEffectFacts?.length)});
      }
      if(preflightOnly)throw e;
      const receipt=await session.stop();await session.controllerExitCleanup;
      if(provider==='omp'&&role!=='worker'&&resident?.handoff&&session.threadId)await this.store.mutate(()=>{Object.assign(this.store.state.residents[target],{threadId:session.threadId,handoff:{...resident.handoff,status:'start-failed'}});});
      if(session.pid&&provider==='omp'&&receipt?.confirmationComplete!==true)throw Object.assign(e,{exitUnconfirmed:true});
      if(this.sessions.get(target)===session)this.sessions.delete(target);await this.store.mutate(()=>{delete this.store.state.providers[target];});throw e;
    }
  }

  // 人工回合 durable job（P4 输入所有权）：唯一输入身份；promptStartedAt 同事务落账（崩溃窗口可判定）；
  // 收尾按官方终态事实（错误不假成功）；材料/回执经既有 onTool/intake 链——不触发第二次模型输入。
  // 人工回合 durable job（P4 输入所有权，三角色）：唯一输入身份；promptStartedAt 同事务落账；
  // TUI 人工输入本身即模型输入——job 直接 running（kick 不再二次派发 prompt）。
  // 语义沿原合同：frontdesk→front；orchestrator→intake（dispatch/manage 可用）；
  // Worker→manual 绑定当前 Work/revision（续改/发布按既有 revision 规则，不伪装 front）。
  async openManualJob(target,promptId,text){
    if(this.handoffPreparing?.size||this.residentHandoffs?.size||this.handoffConfirmations?.size)throw this.residentHandoffError('OMP_HANDOFF_CONFIRMATION_REQUIRED',target,'resident handoff blocks manual input');
    if(typeof text!=='string'||!text.trim()||text.length>32000)throw Error('invalid manual input');
    const now=new Date().toISOString();
    // 单序列化事务内 CAS（root P5 边界1）：未收尾检查/同 promptId 幂等/Work 状态/建账 同一 mutate——
    // 并发 Promise.all 双调用串行执行，第二个在事务内看到已入账 job 即拒绝；不靠进程内 mutex 或外部快检。
    const outcome=await this.store.mutate(()=>{
      const state=this.store.state;
      const pending=state.jobs.find(j=>j.target===target&&j.manual===true&&j.status==='running');
      if(pending){
        if(pending.manualPromptId===promptId)return {jobId:pending.id,idempotent:true};   // 同 promptId 幂等：不新建、不重放输入
        throw Error('上一人工回合收尾未完成（settlement pending），拒绝新输入');
      }
      const base={status:'running',manual:true,manualPromptId:promptId,createdAt:now,promptStartedAt:now,requestKey:'manual:'+promptId};
      let job;
      if(target==='frontdesk')job={...base,id:randomUUID(),type:'front',target,text,context:{}};
      else if(target==='orchestrator')job={...base,id:randomUUID(),type:'intake',target,text,context:{manual:true}};
      else{
        const work=state.works.find(w=>w.id===target);
        this.assertDeviationReleased(target);
        if(!work)throw Error('worker manual input requires an active Work');
        if(['paused','review'].includes(work.status))this.store.continueState(target);   // 续改沿既有 continue 规则（running+revision++，同一事务内）
        else if(work.status!=='running')throw Error('worker manual input requires an active Work');
        job={...base,id:randomUUID(),type:'manual',target,text,revision:work.revision,context:{boundWorkId:target,manual:true}};
      }
      state.jobs.push(job);
      state.messages.push({id:randomUUID(),target,speaker:'user',text,jobId:job.id,manual:true});
      const owner=['frontdesk','orchestrator'].includes(target)?state.residents[target]:state.works.find(w=>w.id===target);if(owner)owner.zeroActivity=false;
      return {jobId:job.id,revision:job.revision??null,target};
    });
    // 事务提交后绑定 current（内存态）：同事务序列保证唯一入账者到达此处
    const adopted=structuredClone(this.store.state.jobs.find(j=>j.id===outcome.jobId));
    if(target==='frontdesk')await this.prepareFrontGoal(adopted);
    this.current.set(target,adopted);this.changed();
    if(!['frontdesk','orchestrator'].includes(target)){adopted.reader=new ContextReader();outcome.taskAnchor=workerTaskAnchor(this.store.find(target),adopted.reader);}
    return outcome;
  }
  async settleManualJob(target,{promptId,jobId,text,error}){
    const job=this.store.state.jobs.find(j=>j.id===jobId&&j.manualPromptId===promptId&&j.target===target);
    if(!job||job.status!=='running'||this.current.get(target)?.id!==job.id)return;
    const message=!error&&text&&!this.timeline.records().some(record=>record.jobId===job.id)?{id:randomUUID(),target,speaker:'agent',text,jobId:job.id,manual:true}:error?{id:randomUUID(),target,speaker:'system',text:'人工回合失败：'+String(error).slice(0,200),jobId:job.id,manual:true}:null;
    // Worker 人工收尾：settle 与 job 收尾单事务（root A：无"job completed 而 Work 仍 running"半状态）。
    if(job.type==='manual'&&!error){
      const workId=job.context?.boundWorkId??target;
      const work=this.store.find(workId);
      if(work&&work.status==='running'&&work.revision===job.revision)await this.store.settleWithManualJob(workId,job,{agentMessage:message?.speaker==='agent'?message:null,systemMessage:message?.speaker==='system'?message:null});
      else await this.store.mutate(()=>{if(message)this.store.state.messages.push(message);const saved=this.store.state.jobs.find(j=>j.id===job.id);saved.status='completed';saved.completedAt=new Date().toISOString();});
    }else{
      await this.store.mutate(()=>{const saved=this.store.state.jobs.find(j=>j.id===job.id);if(error){saved.status='failed';saved.error=String(error).slice(0,400);}else{saved.status='completed';saved.completedAt=new Date().toISOString();}if(message)this.store.state.messages.push(message);});
    }
    if(!['frontdesk','orchestrator'].includes(target)&&this.store.find(target).deviation?.admittedJobId===job.id)await this.stopDeviationOwner(target);
    if(this.current.get(target)?.id===job.id)this.current.delete(target);
    this.changed();this.kick();
  }
  async onTool(target,p){
    const job=this.current.get(target);if(!job)throw new Error('no active host job');
    if(job.type==='intake'&&['closing','ended'].includes(this.intakeBoundWork(job)?.status)&&['nozeli_dispatch','nozeli_manage'].includes(p.tool))return {cancelled:true,userEnded:true,message:'原工作已由用户结束，不再处理补充。'};
    if(this.stopping||(!['frontdesk','orchestrator'].includes(target)&&['closing','ended'].includes(this.store.find(target).status)))throw new Error('host or work closing');
    const a=p.arguments;
    if(p.tool==='nozeli_report_deviation'&&!['frontdesk','orchestrator'].includes(target)){
      const event=await this.store.reportDeviation(target,job,a,p.callId);this.workerTerminal.pause(target);this.changed();return {saved:true,hostControl:true,deviationId:event.id,version:event.version,status:event.status,workRemainsOpen:true,userDecisionRequired:true};
    }
    this.assertDeviationReleased(target);
    if(p.tool==='nozeli_history_read'&&!['frontdesk','orchestrator'].includes(target)){const reader=job.reader||this.workerRecoveryReaders?.get(target);if(!reader)throw Error('No explicit Worker recovery source is bound');return {...reader.read(a.readRef),readOnly:true};}
    if(p.tool==='nozeli_skill_read'){
      if(['frontdesk','orchestrator'].includes(target))throw Error('domain skills belong to the bound Worker');
      const binding=this.store.find(target).binding||this.store.state.bindings.worker;
      return readRoleSkill('worker',a.name,{skills:binding.skills});
    }
    if(target==='frontdesk'){
      const op={nozeli_document_read:'read',nozeli_document_apply:'apply',nozeli_document_create:'create',nozeli_project_list:'list',nozeli_project_search:'search'}[p.tool];
      if(op)return this.frontdeskOperation(job,p,op);
    }
    if(!['frontdesk','orchestrator'].includes(target)&&['nozeli_document_read','nozeli_document_apply'].includes(p.tool)&&this.execution){
      const value=await this.execution.documentOperation({work:this.store.find(target),op:p.tool==='nozeli_document_read'?'read':'apply',arguments:a,callId:p.callId,isActive:()=>!this.stopping&&this.current.get(target)===job&&this.store.find(target).status==='running'});
      await this.store.mutate(()=>{const saved=this.store.state.jobs.find(j=>j.id===job.id);saved.documentOperations??=[];saved.documentOperations.push({tool:p.tool,callId:p.callId,at:new Date().toISOString(),ok:value.ok,...(value.ok?{relPath:value.value.relPath,version:value.value.version,eventId:value.value.eventId,digest:value.value.digest}:{code:value.error.code,recoveryPath:value.error.details?.recoveryPath})});});
      if(value.ok&&p.tool==='nozeli_document_apply'&&!value.value.duplicate)await this.store.mutate(()=>{this.store.state.fileOperations??=[];this.store.state.fileOperations.push({id:p.callId,workId:target,jobId:job.id,relPath:value.value.relPath,beforeDigest:value.value.beforeDigest,afterDigest:value.value.digest,eventId:value.value.eventId,at:new Date().toISOString()});});
      if(value.ok&&p.tool==='nozeli_document_apply')this.emit('files-changed',{jobId:job.id,workId:target,reason:'managed-document-applied'});
      return value;
    }
    if(target==='frontdesk'&&p.tool==='nozeli_handoff'){
      const reason=typeof a.reason==='string'?a.reason.trim():'';
      if(this.transferFor(job))return {accepted:true,jobId:this.transferFor(job).id,readOnly:true,transferred:true,message:'此目标正在转交，停止前台操作。'};
      if(reason.startsWith('@read '))return this.frontRead(job,reason.slice(6).trim(),p.callId);
      if(reason.startsWith('@new ')){
        await this.store.mutate(()=>{const saved=this.store.state.jobs.find(j=>j.id===job.id),prior=this.frontGoal(job);if(this.transferFor(job)||this.store.state.frontdeskRoutes?.some(r=>r.sourceJobId===job.id&&r.status==='pending'))throw Error('此来源等待用户决定或正在转交');if(saved.newGoal||prior?.reads.some(r=>r.jobId===job.id))throw Error('当前回合已选择或读取目标');if(prior?.rootJobId===job.id){saved.newGoal=true;return;}const goal={id:randomUUID(),rootJobId:job.id,jobIds:[job.id],reads:[],chars:0};this.store.state.frontGoals.push(goal);saved.context.frontGoalId=goal.id;job.context.frontGoalId=goal.id;this.store.state.activeFrontGoalId=goal.id;saved.newGoal=true;});return {readOnly:true,continueTurn:true,newGoal:true,transferred:false,action:'discussion-selected',message:'仅选择讨论目标，尚未交接或派工。'};
      }
      if(reason==='@continue'){
        let workEnded=false;
        await this.store.mutate(()=>{const saved=this.store.state.jobs.find(j=>j.id===job.id),goal=this.frontGoal(job);if(this.transferFor(job)||this.store.state.frontdeskRoutes?.some(r=>r.sourceJobId===job.id))throw Error('此来源等待用户决定或已停止');if(saved.goalBound||goal.rootJobId!==job.id)return;if(goal.reads.some(r=>r.jobId===job.id))throw Error('已开始读取，不能改变目标');const previous=this.store.state.jobs.findLast(j=>j.target==='frontdesk'&&j.id!==job.id&&j.context.frontGoalId&&j.context.frontGoalId!==goal.id),prior=this.store.state.frontGoals.find(g=>g.id===previous?.context.frontGoalId);if(!prior)throw Error('没有可延续的讨论');const original=this.store.state.jobs.find(j=>j.id===prior.intakeJobId),bound=original&&(this.intakeBoundWork(original)||this.store.state.works.find(w=>w.sourceJob===original.id));if(bound&&['closing','ended'].includes(bound.status)){workEnded=true;return;}if(!this.canReuseFrontGoal(job.text,prior))throw Error('此输入明确引用其他或不明确工作，交主控判断，不继承上一目标');saved.context.frontGoalId=prior.id;job.context.frontGoalId=prior.id;this.store.state.activeFrontGoalId=prior.id;saved.goalBound=true;if(!prior.jobIds.includes(job.id))prior.jobIds.push(job.id);});return workEnded?{readOnly:true,continueTurn:true,continued:false,workEnded:true,message:'原Work已结束或在收尾；保留当前讨论，不会重启原Work。'}:{readOnly:true,continueTurn:true,continued:true};
      }
      if(!reason||reason.startsWith('@'))throw Error('交接需普通升级理由；@read/@new/@continue仅用于对应协议，不会作为交接执行');
      return this.frontGoal(job)?.intakeJobId?this.handoffFront(job,reason):this.proposeFrontdeskRoute(job,reason);
    }
    if(target==='orchestrator'&&p.tool==='nozeli_inspect_work'){
      if(job.type!=='intake')throw new Error('inspection requires an intake');
      const read=value=>({...value,readOnly:true,continueTurn:true});
      if(typeof a.workName==='string'&&a.workName.startsWith('@frontdesk-source:')){const source=await frontSource(this,a.workName.slice(1),job);job.reader??=new ContextReader();return read(job.reader.read(job.reader.add(source.text,{title:'审批时冻结来源',source:source.source,kind:'frontdesk-transfer'})));}
      if(job.reader?.entries.has(a.workName))return read(job.reader.read(a.workName));
      const id=typeof a.workName==='string'&&a.workName.startsWith('@work:')?a.workName.slice(6):a.workName;
      const exact=this.store.state.works.find(w=>w.id===id),named=this.store.state.works.filter(w=>(w.name||w.request)===a.workName),open=named.filter(w=>w.status!=='ended');
      const matches=exact?[exact]:open.length?open:named;
      if(!matches.length&&a.workName==='@state')return read(JSON.parse(this.routingContext({role:'frontdesk'})));
      if(!matches.length&&a.workName==='@conversation'){
        const text=this.store.state.messages.filter(m=>(m.target==='frontdesk'||m.audience==='frontdesk')&&m.text).map(m=>`${m.speaker}: ${m.text}`).join('\n');
        let offset=Math.max(0,text.length-10000);if(/[\uDC00-\uDFFF]/.test(text[offset]||''))offset++;
        const page=job.reader.read(job.reader.add(text,{title:'近期前台对话',source:'runtime/messages',kind:'conversation',offset}));
        return read({...page,...(offset?{earlierReadRef:job.reader.add(text,{title:'完整前台对话',source:'runtime/messages',kind:'conversation'})}:{})});
      }
      if(!matches.length&&typeof a.workName==='string'&&a.workName.startsWith('@memory:')){
        const query=a.workName.slice(8).trim();if(!query)throw Error('memory search query required');
        const memory=await this.memoryVersion.snapshot();
        const result=memoryContext(memory.root.text??'',query,job.reader,memory.topics);
        job.reader.reads.push({kind:'memory-index',source:'memory/plan-tree.md',chars:JSON.stringify(result).length});return read(result);
      }
      if(matches.length!==1)throw new Error('work name or supplied reference must identify one Work');
      job.reader??=new ContextReader();
      return read({workId:matches[0].id,workRef:'@work:'+matches[0].id,...this.workContext(matches[0],job.reader)});
    }
    if(target==='orchestrator'&&p.tool==='nozeli_dispatch'){
      if(job.type!=='intake')throw new Error('dispatch requires an intake');if(this.intakeBoundWork(job))throw Error('input belongs to existing Work; manage original Work');const source=this.intakeSource(job);
      const receipt=await this.store.mutate(()=>{
        const saved=this.store.state.jobs.find(j=>j.id===job.id);if(saved.routing){if(saved.routing.action!=='dispatch')throw Error('intake already routed');return saved.routing;}
        const w=this.store.submitState(source.request,a.brief,{name:a.name,sourceJob:job.id});
        Object.assign(this.store.find(w.id),{imageAttachments:source.imageAttachments,sourceInputJobIds:source.sourceInputJobIds,...(job.context?.frontdeskRouteId?{frontdeskTransfer:{proposalId:job.context.frontdeskRouteId,completedOperations:structuredClone(job.context.completedOperations),currentSources:structuredClone(job.context.currentSources)}}:{})});
        saved.routing={action:'dispatch',workId:w.id,name:w.name,at:new Date().toISOString()};this.resolveRoutingQuestion(job);return structuredClone(saved.routing);
      });
      this.changed();this.kick();return {...receipt,status:this.store.find(receipt.workId).status,quotaUsed:this.store.used(),quotaLimit:this.store.state.limit};
    }
    if(target==='orchestrator'&&p.tool==='nozeli_manage')return this.manageIntake(job,a);
    if(p.tool==='nozeli_publish'&&!['frontdesk','orchestrator'].includes(target)){
      const kind=a.kind,body=a.text;
      let frozen;
      if(this.execution&&kind==='result')frozen=await this.execution.publish(this.store.find(target),job,()=>!this.stopping&&this.current.get(target)===job&&this.store.find(target).status==='running',async(manifest,candidate)=>this.changes.capture({projectId:this.projectId,workId:target,revision:job.revision,jobId:job.id,receiptId:p.callId,repo:manifest.repo,commonDir:manifest.commonDir,inputCommit:manifest.inputCommit,candidateCommit:candidate.commit}));
      const candidates=(a.files||[]).map(file=>this.execution&&path.isAbsolute(file)&&file.startsWith(this.execution.directory(target)+path.sep)?path.relative(this.execution.directory(target),file):file);
      const artifacts=await this.recordArtifacts(job,candidates);if(kind==='result'&&artifacts.rejected.length)throw Error('成果引用无法核验，请修正报告文件路径');const receipt=await this.store.publish(target,job.revision,kind,body,p.callId,{jobId:job.id,files:artifacts.files,changeSetId:frozen?.changeSet?.changeSetId??null});
      this.changed();this.kick();return {saved:true,kind,object:receipt.objectId,files:artifacts.files,rejectedFiles:artifacts.rejected,...(frozen?{candidate:frozen.candidate}:{}),workRemainsOpen:true};
    }
    throw new Error('tool unavailable in this role/event');
  }
  async recordArtifacts(job,candidates){
    const verified=await verifyProjectArtifacts(this.execution&&!['frontdesk','orchestrator'].includes(job.target)?this.execution.directory(job.target):this.store.state.contentRoot,candidates);
    const added=await this.store.mutate(()=>{let count=0;this.store.state.artifacts??=[];for(const file of verified.files){const old=this.store.state.artifacts.find(a=>a.jobId===job.id&&a.relPath===file.relPath);if(old)continue;this.store.state.artifacts.push({id:randomUUID(),...file,workId:job.target,jobId:job.id,revision:job.revision,at:new Date().toISOString()});count++;}return count;});
    if(added)this.emit('files-changed',{jobId:job.id,workId:job.target,reason:'artifact-verified'});
    return verified;
  }
  resolveRoutingQuestion(job){
    const question=this.store.state.todos.find(t=>t.id===job.context?.routingQuestionId&&t.kind==='routing'&&t.status==='open');
    if(question)question.status='resolved';
  }
  async manageIntake(job,a){
    if(job.type!=='intake')throw new Error('management requires an intake');
    // Accept the read-only state selector as an all-work status query too;
    // never reinterpret it for mutation or when it names a real Work.
    if(a.action==='status'&&a.workName==='@state'&&!this.store.state.works.some(w=>(w.name||w.request)==='@state'&&w.status!=='ended'))a={...a,workName:''};
    const old=this.store.state.jobs.find(j=>j.id===job.id).routing;if(old){if(old.action!==a.action||old.workName!==a.workName)throw new Error('intake already routed');return old;}
    if(!['continue','status','cancel','clarify'].includes(a.action)||typeof a.text!=='string')throw new Error('invalid management action');
    const matches=this.store.state.works.filter(w=>(w.name||w.request)===a.workName&&w.status!=='ended');
    if(a.action!=='clarify'&&!(a.action==='status'&&!a.workName)&&matches.length!==1)throw new Error('work name must uniquely identify an open Work; ask clarification');
    const w=matches[0];if(this.intakeBoundWork(job)&&a.action!=='clarify'&&w?.id!==this.intakeBoundWork(job).id)throw Error('input belongs to the selected original Work');let detail={};
    if(a.action==='continue'){
      if(w.readOnly)throw Object.assign(new Error('Historical provider work requires explicit context recovery before continuation'),{code:'HISTORICAL_SESSION_READ_ONLY'});
      const source=this.intakeSource(job);
      const receipt=await this.store.mutate(()=>{
        const current=this.store.find(w.id);if(['closing','ended'].includes(current.status))throw new Error('work already closing');
        this.appendWorkInput(current,job,source,a.text);
        const transferredToOriginal=job.context?.workHintId===w.id&&Boolean(job.context?.deviationId),held=this.deviationHeld(w.id)||transferredToOriginal;
        if(current.status!=='queued'&&!held)this.queueJob(w.id,'supplement','用户对已有工作的补充/回答（保持原Work）：\n'+this.workerInputText(source.request,a.text),{key:`supplement:${job.id}`,context:{sourceJobId:job.id,imageAttachments:source.imageAttachments}});
        const receipt={action:a.action,workName:a.workName,at:new Date().toISOString(),workId:w.id,queued:!held,status:current.status,...(held?{requiresUserDecision:true,pendingRecommendation:true,deviationId:job.context?.deviationId||current.deviation?.id}:{})};
        this.store.state.jobs.find(j=>j.id===job.id).routing=receipt;this.resolveRoutingQuestion(job);return structuredClone(receipt);
      });this.changed();this.kick();return receipt;
    }else if(a.action==='cancel'){
      if(!isExplicitWorkCancellation(job.text,a.workName))throw new Error('cancellation requires an explicit user request naming the Work');
      throw Error('结束工作需要用户明确选择接受或丢弃；请在工作界面选择，不根据自然语言推断处置。');
    }else if(a.action==='clarify'){
      if(!a.text.trim())throw new Error('clarification question required');detail={needsAnswer:true,question:a.text};
    }else detail={facts:w?{name:w.name||w.request,status:w.status,revision:w.revision}:JSON.parse(this.routingContext()),noWorkerTurn:true};
    const receipt={action:a.action,workName:a.workName,at:new Date().toISOString(),...detail};
    await this.store.mutate(()=>{if(a.action==='clarify'&&!this.store.state.todos.some(t=>t.sourceJobId===job.id))this.store.state.todos.push({id:randomUUID(),kind:'routing',target:'frontdesk',...(matches.length===1?{workId:w.id,revision:w.revision}:{}),status:'open',text:a.text,sourceJobId:job.id});this.store.state.jobs.find(j=>j.id===job.id).routing=receipt;if(a.action!=='clarify')this.resolveRoutingQuestion(job);});this.changed();this.kick();return receipt;
  }
  async runJob(inputJob){
    const job=structuredClone(inputJob);
    let didStart=false;
    const savedJob=()=>this.store.state.jobs.find(j=>j.id===job.id);
    try{
      const started=await this.store.mutate(()=>{if(savedJob().status!=='queued'||this.deviationHeld(job.target))return false;savedJob().status='running';savedJob().startedAt=new Date().toISOString();return true;});if(!started)return;didStart=true;this.current.set(job.target,job);this.changed();
      if(job.context?.pendingIntakeId){const parent=this.store.state.jobs.find(j=>j.id===job.context.pendingIntakeId),work=parent&&(this.intakeBoundWork(parent)||this.store.state.works.find(w=>w.sourceJob===parent.id));if(work)await this.store.mutate(()=>{const field=job.context.softWorkHint?'workHintId':'boundWorkId';job.context[field]=work.id;savedJob().context[field]=work.id;});else {const question=parent&&this.store.state.todos.findLast(q=>q.kind==='routing'&&q.sourceJobId===parent.id&&q.status==='open');if(!question)throw Error('原目标尚未明确处理结果，请先核对已有提交');await this.store.mutate(()=>{job.context.routingQuestionId=question.id;savedJob().context.routingQuestionId=question.id;});}}
      const isWork=!['frontdesk','orchestrator'].includes(job.target);
      if(isWork){const w=this.store.find(job.target);if(job.type!=='initial')await this.store.continue(w.id);job.revision=w.revision;await this.store.mutate(()=>{savedJob().revision=job.revision;});}
      const session=await this.session(job.target);let prompt=job.text,delivery;
      this.tagMaterialDelivery??=new TagMaterialDelivery();
      const materialDelivery=this.tagMaterialDelivery.prepare(session,job);
      prompt=materialDelivery.text;
      const event=job.target==='orchestrator'?await eventSkill('orchestrator',job.type,{skills:this.store.state.bindings.orchestrator.skills,boundWork:job.type==='intake'&&Boolean(this.intakeBoundWork(job)),routingQuestion:job.type==='intake'&&Boolean(job.context?.routingQuestionId)}):'';
      if(isWork&&session.zeroActivityRestarted&&!session.hasPrompted&&job.type!=='initial'){const w=this.store.find(job.target);prompt='宿主已确认原线程尚未开始模型回合，已恢复同一Work的空线程。原任务要求：\n'+(w.originalBrief??w.brief)+'\n原始用户请求：\n'+w.request+'\n本次用户输入：\n'+prompt;}
      if(isWork){const recovery=await this.workerRecoveryContext(this.store.find(job.target),job);if(recovery)prompt='User-confirmed context handoff sources:\n'+JSON.stringify(recovery)+'\nCurrent explicit input (only scheduled instruction):\n'+prompt;}
      if(isWork){job.reader??=new ContextReader();prompt='当前任务锚点（原始任务不可变，只有列出的用户批准原文扩展范围）：\n'+workerTaskAnchor(this.store.find(job.target),job.reader)+'\n本轮明确输入：\n'+prompt;}
      if(this.stopping||(isWork&&(this.deviationHeld(job.target)||['closing','ended'].includes(this.store.find(job.target).status)))||(job.type==='intake'&&['closing','ended'].includes(this.intakeBoundWork(job)?.status)))throw new Error('execution interrupted before prompt');
      if(['front','intake'].includes(job.type)){
        if(job.type==='front'){
          await this.prepareFrontGoal(job);
          if(this.transferFor(job)){await this.saveTransferredFront(job);return;}
          if(this.frontGoal(job)?.intakeJobId){await this.handoffFront(job,'转交后的用户补充');await this.store.mutate(()=>{savedJob().status='completed';savedJob().finishedAt=new Date().toISOString();});return;}
        }
        const memory=job.type==='intake'?await this.memoryVersion.snapshot():null;
        delivery=prepareDelivery(this.contextState(),{target:job.target,threadId:session.threadId,generation:session.contextGeneration||0,job,used:this.store.used(),...(memory?{memoryVersion:memory.version}:{})});
        const parts=delivery.sections.map(([title,text])=>`${title}：\n${text}`);
        if(job.type==='front'){const g=this.frontGoal(job);parts.push('讨论来源：'+JSON.stringify({previousGoal:g.rootJobId!==job.id,transferred:Boolean(g.intakeJobId),perReadPageChars:frontReadLimits.chars}));}
        if(job.type==='intake'){
          job.reader=new ContextReader();parts.unshift('主控入口');
          if(this.intakeBoundWork(job)){const bound=this.intakeBoundWork(job);parts.push('程序已绑定原工作：'+bound.name+'；此输入为该工作的补充，只管理原Work，不新派工。');}
          if(job.context.handoffIntent&&job.context.handoffIntent!==job.text)parts.push('前台交接意图：'+job.context.handoffIntent);
        }
        parts.push((job.type==='front'?'用户本次原文：':'原始请求:')+'\n'+materialDelivery.text);prompt=parts.join('\n');
      }
      if(event)prompt='事件技能（仅本次宿主事件）：\n'+event+'\n\n'+prompt;
      const attachments=job.context?.imageAttachments||[];if(attachments.length>8)throw Error('区域图片超过8张');const images=[];let imageBytes=0;for(const ref of attachments){if(!/^[a-f0-9]{64}$/.test(ref.digest)||ref.mime!=='image/png')throw Error('区域附件引用无效');const bytes=await new MaterialStore(path.join(this.store.state.contentRoot,'.nozeli/materials')).get(ref.digest);imageBytes+=bytes.length;if(imageBytes>24*1024*1024)throw Error('区域附件超过24MB');images.push('data:image/png;base64,'+bytes.toString('base64'));}
      const requestContext={...(delivery?.stats||{}),eventChars:job.text.length,hostAddedChars:Math.max(0,prompt.length-job.text.length),instructionChars:session.instructions?.length||0,baseInstructionChars:session.baseInstructions?.length||0,dynamicToolChars:JSON.stringify(session.tools||[]).length,...(event?{eventSkill:{delivery:'message',chars:event.length,digest:createHash('sha256').update(event).digest('hex')}}:{})};
      await this.store.mutate(()=>{savedJob().requestContext={promptChars:prompt.length,...requestContext};});
      if(job.type==='front'&&this.transferFor(job)){await this.saveTransferredFront(job);return;}
      await this.store.mutate(()=>{if(isWork)this.assertDeviationReleased(job.target);savedJob().promptStartedAt=Date.now();const owner=isWork?this.store.find(job.target):this.store.state.residents[job.target];if(owner)owner.zeroActivity=false;});
      const response=await session.prompt(prompt,{timeout:session.settleTimeoutMs??600000,images,job:{id:job.id,target:job.target,revision:job.revision??null,type:job.type}});
      materialDelivery.commit();
      if(job.type==='front'&&this.transferFor(job)){await this.saveTransferredFront(job,response);return;}
      if(this.stopping||(isWork&&['closing','ended'].includes(this.store.find(job.target).status))||(job.type==='intake'&&['closing','ended'].includes(this.intakeBoundWork(job)?.status)))throw new Error('execution interrupted after prompt');
      if(isWork&&response.files?.length)await this.recordArtifacts(job,response.files);
      if(job.type==='intake'&&!savedJob().routing)throw new Error('orchestrator turn ended without a routing decision');
      if(response.metrics){
        if(job.reader)response.metrics.contextReads=job.reader.reads;
        if(job.type==='front')response.metrics.contextReads=(savedJob().readReceipts||[]).map(r=>({source:r.value.source,version:r.value.version,chars:r.value.text.length,offset:r.value.offset}));
        response.metrics.context=requestContext;
      }
      const agentBody=response.completion==='host-control'||response.collab?'':response.text;const body=agentBody||(!response.collab&&job.type==='intake'?this.routingMessage(savedJob().routing):'');
      await this.store.mutate(()=>{Object.assign(savedJob(),{status:'completed',finishedAt:new Date().toISOString(),threadId:response.threadId,turnId:response.turnId,providerStatus:response.providerStatus,completion:response.completion,metrics:response.metrics??null});if(delivery){this.store.state.contextDelivery??={};this.store.state.contextDelivery[job.target]=delivery.checkpoint;}if(body)this.store.state.messages.push({id:randomUUID(),target:job.target,speaker:agentBody?'agent':'system',text:body,jobId:job.id,...(job.type==='intake'&&(job.context.frontJobId||job.context.manual||job.context.boundWorkId)?{audience:'frontdesk',sourceJobId:job.context.frontJobId||job.id}:{})});this.store.state.modelObservations??={};this.store.state.modelObservations[`${session.model}:${session.effort}`]={status:'turn-completed',at:new Date().toISOString()};});
      if(isWork&&this.store.find(job.target).status==='running')await this.store.settle(job.target);
    }catch(e){
      if(e.metrics)await this.store.mutate(()=>{savedJob().metrics={...e.metrics,context:savedJob().requestContext||null};});
      const ending=this.store.state.works.find(w=>w.id===job.target)||(job.type==='intake'?this.intakeBoundWork(job):null);
      if(this.stopping||ending&&['closing','ended'].includes(ending.status)){
        await this.store.mutate(()=>{Object.assign(savedJob(),{status:ending&&['closing','ended'].includes(ending.status)?'cancelled':'interrupted',interruptionReason:ending&&['closing','ended'].includes(ending.status)?'user-ended':'host-stopped',finishedAt:new Date().toISOString()});});return;
      }
      if(job.type==='front'&&this.transferFor(job)){
        // Timeout/failure is not proof of a stopped provider turn. Reap first.
        await this.terminals.get(job.target)?.close();await this.sessions.get(job.target)?.stop();
        await this.store.mutate(()=>{delete this.store.state.providers[job.target];});
        await this.saveTransferredFront(job,{text:e.partialText,metrics:e.metrics,turnId:e.turnId,threadId:e.threadId,providerStatus:'interrupted'});return;
      }
      // Record the accepted input's failure before cleanup can reject or hang.
      // Native exit and durable turn failure are independent pieces of evidence.
      await this.store.mutate(()=>{
        const saved=savedJob(),w=this.store.state.works.find(w=>w.id===job.target);
        if(['cancelled','interrupted','completed'].includes(saved.status)||w&&['closing','ended'].includes(w.status))return;
        Object.assign(saved,{status:this.stopping?'interrupted':'failed',finishedAt:new Date().toISOString(),error:e.message});
        const binding=w?.binding||this.store.state.bindings[job.target];
        if(binding){this.store.state.modelObservations??={};this.store.state.modelObservations[`${binding.model}:${binding.effort}`]={status:'turn-failed',error:e.message,at:new Date().toISOString()};}
        this.store.state.messages.push({id:randomUUID(),target:job.target,speaker:'system',text:runtimeFailureMessage(e,{work:Boolean(ending)}).text,jobId:job.id,...(job.context?.frontJobId||job.context?.manual||job.context?.boundWorkId?{audience:'frontdesk'}:{})});
        if(w?.status==='running')this.pauseState(w,e.message);else if(!w)this.store.state.todos.push({id:randomUUID(),kind:'system',status:'open',target:job.target,sourceJobId:job.id,text:e.message});
      });
      const owner=this.sessions.get(job.target),cleanupFailures=[];
      let exitReceipt;
      try{await this.terminals.get(job.target)?.close();}catch(error){cleanupFailures.push({stage:'terminal-close',error});}
      try{exitReceipt=await owner?.stop();}catch(error){cleanupFailures.push({stage:'native-stop',error});exitReceipt=owner?.lastExitReceipt;}
      await this.store.mutate(()=>{
        const saved=savedJob();
        if(cleanupFailures.length)saved.cleanupFailure={at:new Date().toISOString(),stages:cleanupFailures.map(({stage,error})=>({stage,category:error.code==='OMP_COLLAB_HOLD'?'collab-hold':'cleanup-failed'})),exitConfirmed:exitReceipt?.confirmationComplete===true,evidence:owner?.cleanupEvidence?.()??null};
        const omp=(this.store.state.works.find(w=>w.id===job.target)?.binding||this.store.state.bindings[job.target])?.provider==='omp';
        if(this.sessions.get(job.target)===owner&&(exitReceipt?.confirmationComplete===true||!omp&&!cleanupFailures.length))delete this.store.state.providers[job.target];
      });
      if(cleanupFailures.length)throw Object.assign(new AggregateError(cleanupFailures.map(({error})=>error),'native cleanup failed after turn failure'),{code:'OMP_TURN_CLEANUP_FAILED',cause:e});
    }finally{if(!['frontdesk','orchestrator'].includes(job.target)){this.workerTerminal.pause(job.target);if(didStart&&this.store.find(job.target).deviation?.admittedJobId===job.id)await this.stopDeviationOwner(job.target);}await this.finalizeTransfers();this.changed();if(didStart&&!this.stopping&&!['frontdesk','orchestrator'].includes(job.target))this.emit('files-changed',{jobId:job.id,workId:job.target,reason:'worker-turn-settled'});}
  }
  async saveTransferredFront(job,response={}){
    await this.store.mutate(()=>{
      const saved=this.store.state.jobs.find(j=>j.id===job.id),manual=this.transferFor(job)?.context?.manual;
      Object.assign(saved,{status:manual?'interrupted':'completed',interruptionReason:'user-transfer',finishedAt:new Date().toISOString(),threadId:response.threadId,turnId:response.turnId,providerStatus:response.providerStatus,completion:'user-transfer'});
      if(response.metrics)saved.metrics={...response.metrics,context:saved.requestContext||null,contextReads:(saved.readReceipts||[]).map(r=>({source:r.value.source,version:r.value.version,chars:r.value.text.length,offset:r.value.offset}))};
      if(manual&&response.text&&!response.collab&&response.completion!=='host-control')this.store.state.messages.push({id:randomUUID(),target:'frontdesk',speaker:'agent',text:response.text,jobId:job.id,partial:true});
    });
  }
  async endWork(id,{revision,decision}={}){
    if(this.store.find(id).readOnly)throw Object.assign(new Error('Historical provider work is read-only; original outcomes and worktrees are retained'),{code:'HISTORICAL_SESSION_READ_ONLY'});
    await this.store.end(id,{by:'user',revision,decision});this.changed();this.kick();
    await this.advanceClosure(id);const w=this.store.find(id);return {accepted:true,status:'ended',outcome:w.outcome,closure:structuredClone(w.closure)};
  }
  async retryClosure(id){const w=this.store.find(id);if(w.status!=='ended'||!w.closure)throw Error('work has no ended closure');await this.advanceClosure(id);return {accepted:true,status:'ended',closure:structuredClone(w.closure)};}
  advanceClosure(id){
    if(this.closures.has(id))return this.closures.get(id);
    const promise=this.finishClosure(id).finally(()=>this.closures.delete(id));this.closures.set(id,promise);return promise;
  }
  async blockClosure(id,message){await this.store.mutate(()=>{const w=this.store.find(id);w.closure.phase='blocked';w.closure.error=message;const old=this.store.state.todos.find(t=>t.workId===id&&t.kind==='closure'&&t.status==='open');if(old)old.text=message;else this.store.state.todos.push({id:randomUUID(),workId:id,kind:'closure',status:'open',text:message});});try{await this.store.updateClosureArchive(id);}catch(error){this.emit('diagnostic','Closure metadata retained for retry: '+error.message);}this.changed();}
  async finishClosure(id){
    const w=this.store.find(id);if(w.status!=='ended'||!w.closure||w.closure.phase==='complete')return;
    try{
      if(!w.closure.stopped){
        await this.store.mutate(()=>{w.closure.phase='stopping';});this.workerTerminal.pause(id);
        await this.terminals.get(id)?.close();if(this.starting.has(id))await this.starting.get(id).catch(()=>{});
        const session=this.sessions.get(id),receipt=await session?.stop();
        if(receipt?.confirmationComplete===false||receipt?.confirmed===false||session?.pid&&(w.binding?.provider||this.store.state.bindings.worker?.provider)==='omp'&&receipt?.confirmationComplete!==true)throw Error('Worker process exit is not confirmed; resources retained');
        if(this.running.has(id))await this.running.get(id);
        await this.checkpoint('provider-stopped',{workId:id});
        await this.store.mutate(()=>{delete this.store.state.providers[id];});
        await this.store.markStopped(id,{at:new Date().toISOString(),confirmed:true,...(receipt?{provider:receipt}:{})});this.sessions.delete(id);
      }
      await this.store.archiveReport(id);await this.checkpoint('report-archived',{workId:id});
      await this.timeline.drain();
      for(const receipt of this.store.state.receipts.filter(r=>r.workId===id&&r.changeSetId))await this.changes.verify(receipt.changeSetId);
      if(w.closure.decision==='accept'&&this.execution){const receipt=this.store.state.receipts.find(r=>r.workId===id&&r.objectId===w.result?.objectId&&r.revision===w.revision&&r.kind==='result');if(!receipt?.snapshot?.candidate||receipt.snapshot.candidate.commit!==w.execution?.candidate?.commit)throw Error('Acceptance requires a final Worker report bound to the frozen candidate; resources retained');}
      if(!['accept','discard'].includes(w.closure.decision))throw Error('Legacy outcome is uncertain; explicit user disposition is required. Resources preserved.');
      if(!w.closure.git?.complete){
        await this.store.mutate(()=>{w.closure.phase='integrating';});
        const result=await this.execution.finish(w,{decision:w.closure.decision,reportPersisted:true,validateAcceptance:this.beforeAccept,isActive:()=>this.running.has(id)||this.starting.has(id)||this.sessions.has(id)});
        if(!result.cleaned)throw Error('Execution cleanup is incomplete; resources retained');
        await this.store.mutate(()=>{w.closure.git={...result,complete:true,at:new Date().toISOString()};w.closure.phase='cleanup';});
      }
      if(w.closure.git?.status==='merged'&&!w.closure.provenance){
        const receipt=await this.afterAdoption?.(w,w.closure.git);
        await this.store.mutate(()=>{w.closure.provenance={complete:true,at:new Date().toISOString(),...(receipt?{receipt}:{})};});
        this.emit('files-changed',{workId:id,reason:'accepted-integration',files:w.closure.git.files||[],operations:w.closure.git.operations||[],revision:w.revision});
      }
      await this.store.cleanupWorkerHome(id);
      await this.store.mutate(()=>{w.closure.phase='complete';w.closure.completedAt=new Date().toISOString();delete w.closure.error;this.store.state.memoryPending=this.store.state.memoryPending.filter(x=>x!==id);for(const t of this.store.state.todos)if(t.workId===id&&t.kind==='closure'&&t.status==='open')t.status='resolved';});await this.store.updateClosureArchive(id);this.changed();this.kick();
    }catch(error){await this.blockClosure(id,error.message);}
  }
  async stop(){
    if(this.stopPromise)return this.stopPromise;
    this.stopping=true;this.workerTerminal.stop();this.changed();
    clearTimeout(this.timelineTimer);this.timelineTimer=null;
    this.stopPromise=(async()=>{await Promise.all([...this.terminals.values()].map(t=>t.close()));await Promise.allSettled([...this.starting.values()]);await Promise.all([...this.sessions.values()].map(s=>s.stop()));await Promise.all([...this.running.values()]);await Promise.allSettled([...this.closures.values()]);await this.store.mutate(()=>{this.store.state.providers={};});const homes=[...['frontdesk','orchestrator'].map(role=>path.join(this.store.root,'agents',`resident-${role}`)),...this.store.state.works.map(w=>this.store.agentHome(w.id))];for(const home of homes)await fs.rm(path.join(home,'auth.json'),{force:true});await this.store.close();})();return this.stopPromise;
  }
}
