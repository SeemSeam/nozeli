import {dispositionBinding,sameDispositionBinding,workDisposition,mergeConsentState,explicitNeverCommitStatement,mergeConstraintChoices} from '../../domain/work-disposition.mjs';
import {deviationHeld} from '../../domain/work-deviation.mjs';
import {ExecutionWorkspace,safeBytes} from './execution-workspace.mjs';
import {intakeLineage} from '../../domain/managed-work-records.mjs';
import {runtimeFailureMessage} from '../../domain/runtime-failure-message.mjs';
import {manageTodoState} from '../../domain/todo-management.mjs';
import {verifyProjectArtifacts} from './artifacts.mjs';
import {normalizeExecutionEffect,executionDanger,effectHash as hashOf} from './task-permissions.mjs';
import {createExternalDocuments} from './external-documents.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { Workspace } from './workspace.mjs';
import { PiSession } from './pi-session.mjs';
import { recoverOmpProvider } from './omp-process-ownership.mjs';
import { recoverPiProvider } from './pi-process-ownership.mjs';
import { roles, rolePrompt, eventSkill, readRoleSkill, here } from './runtime.mjs';
import { processStamp, recoverProvider } from './process-ownership.mjs';
import {ContextReader,memoryContext} from './context-reader.mjs';
import {prepareDelivery,contextInstructions,residentBaseInstructions,workerTaskAnchor} from './context-delivery.mjs';
import {frontSource,frontReadLimits,readPage} from './frontdesk-read.mjs';
import {MemoryVersion} from './memory-version.mjs';
import {SessionIndex} from './session-index.mjs';
import {WorkChanges} from './work-changes.mjs';
import {TagMaterialDelivery} from './tag-material-delivery.mjs';
import {loadWorkerArchive,readWorkerArchive as readWorkerArchiveFile} from './worker-archive.mjs';
import {readStoredReport,reportSemanticText} from './report-descriptor.mjs';
import {resolveProblemDecision} from './problem-decisions.mjs';
import {renderArchifyDiagram} from './archify-diagram.mjs';
import {prepareHtmlReport} from './html-report.mjs';
import {activeDrafts,computeReviewVersion,decodeInline,draftTextFor,hasActiveDrafts,normalizeReviewText,readDraftRecord,reviewDraftBytes,reviewMergeProjection,writeDraftRecord,appendDraftEntry,REVIEW_HISTORY_LIMIT,REVIEW_REQUEST_KEY} from './review-candidate.mjs';
import {managedArtifact,managedReportSource} from '../managed-report-source.mjs';
import {MaintenanceLedger,maintenanceBoundary} from './maintenance-ledger.mjs';

// Provider-compatible object schemas; kind-dependent invariants stay host-enforced.
const tool=(name,description,properties,required=Object.keys(properties))=>({type:'function',name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const text={type:'string'};
const hashOfBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
export function isExplicitWorkCancellation(value,name){
 if(typeof value!=='string'||!name)return false;
 const text=value.trim(),end=text.search(/[。；;\n]/),command=end<0?text:text.slice(0,end),rest=end<0?'':text.slice(end+1);
 if(!command.includes(name)||/[?？]|是否|能否|可否|要不要|应不应该|需不需要|吗|不能|不可|不许|不得|不要|不必|别|do not|don't|not to|should|could|would|can we/i.test(command))return false;
 // A later instruction can retract cancellation, but unrelated no-Git/no-write
 // constraints must not revoke an explicit named command.
 if(/(?:不要|不许|不得|不必|别|do not|don't|not to)\s*(?:真的|实际|再|actually\s+)?(?:取消|撤销|终止|结束|停止|强制退出|cancel\b|stop\b|terminate\b)/i.test(rest))return false;
 return /^(?:请|麻烦|帮我|请帮我|现在|立即|确定|确认|please\s+)?\s*(?:撤销|取消|强制退出|终止|结束|停止|cancel\b|stop\b|terminate\b)/i.test(command);
}

// Allowlisted model-change failure codes: native errors are not a
// credential/path-safe boundary, so anything else is redacted away.
const SAFE_MODEL_CHANGE_CODES=['PI_NO_MODEL','PI_BUSY','PI_PROVIDER_CONFLICT','PI_CREDENTIAL_ORIGIN_CHANGE','PI_CREDENTIAL_KEEP_UNAVAILABLE','PI_SESSION_LEASED','PI_RUNTIME_EXITED','PI_RUNTIME_UNAVAILABLE','PI_INVALID_PARAMS','PI_MODEL_CHANGE_FAILED'];

export class Controller extends EventEmitter {
  static async open({storage,offline=false,localOnly=false,projectId=null,runtimeRoot,contentRoot,sessionFactory,readProjectText,frontdeskDocuments,beforeAccept,afterAdoption,isolateProcesses=false,checkpoint=async()=>{},piSource=null,piRuntime=null,piAuth=null,processBudget,taskPermissions=null,resolveRegisteredProject=null,resolveProjectRoot=null,privilegeBroker=null}={}){
    const store=await Workspace.open(runtimeRoot,contentRoot,{recoverStale:true,checkpoint,storage,projectId,offline});
    const controller=new Controller(store,{projectId,sessionFactory,readProjectText,frontdeskDocuments,beforeAccept,afterAdoption,isolateProcesses,checkpoint,piSource,piRuntime,piAuth,processBudget,taskPermissions,resolveRegisteredProject,resolveProjectRoot,privilegeBroker});
    try{await controller.timeline.initialize();const s=store.state;s.jobs??=[];s.messages??=[];s.drafts??={};s.residents??={};s.providers??={};s.frontdeskRoutes??=[];s.recoveryEvents??=[];controller.coldQueued=new Set(s.works.filter(w=>w.status==='queued').map(w=>w.id));controller.coldJobs=new Set(s.jobs.filter(j=>['queued','running'].includes(j.status)).map(j=>j.id));controller.localOnly=localOnly;if(localOnly){if(!offline)await controller.migrateLocalClosures();}else await controller.restore();return controller;}catch(e){await store.close();throw e;}
  }
  constructor(store,{projectId=null,frontdeskDocuments,sessionFactory,readProjectText,beforeAccept,afterAdoption,isolateProcesses=false,checkpoint=async()=>{},piSource=null,piRuntime=null,piAuth=null,processBudget,taskPermissions=null,resolveRegisteredProject=null,resolveProjectRoot=null,privilegeBroker=null}={}){
    super();Object.assign(this,{frontdeskDocuments,store,sessionFactory,readProjectText,beforeAccept,afterAdoption,isolateProcesses,checkpoint,piSource,piRuntime,piAuth,processBudget,taskPermissions,resolveRegisteredProject,resolveProjectRoot,privilegeBroker});this.execution=new ExecutionWorkspace(store);this.sessions=new Map();this.starting=new Map();this.running=new Map();this.current=new Map();this.pendingEnds=new Set();this.publicationSerial=new Map();this.intakeSerial=new Map();this.stopping=false;this.started=false;this.closures=new Map();this.configuring=new Set();this.nativeDraftTargets=new Set();this.externalTerminalTargets=new Set();this.terminals=new Map();
    // Worker progress is projected from session events (timeline), never a fake PTY.
    this.memoryVersion=new MemoryVersion(path.dirname(store.plan));
    this.projectId=projectId??store.state.workspaceId;
    this.maintenance=new MaintenanceLedger(store.storage,this.projectId);this.maintenanceActions=new Map();this.maintenanceFlights=new Map();
    this.processBudget=processBudget;this.reclaiming=new Map();this.mergeDrain=null;
    this.timeline=new SessionIndex(store);
    this.changes=new WorkChanges({runtimeRoot:store.root,storage:store.storage,projectId:store.projectId,readState:()=>store.state});
  }
  async maintenanceEvent(bug){
    await this.store.mutate(()=>{if(this.store.state.jobs.some(j=>j.type==='maintenance'&&j.context?.bugId===bug.id))return;this.store.state.jobs.unshift({id:randomUUID(),target:'orchestrator',type:'maintenance',status:'queued',text:'宿主自动维修事件。仅核对本机故障并调用 nozeli_maintenance；不得派业务Work、询问用户如何维修或重放原任务。bugId='+bug.id,context:{bugId:bug.id},createdAt:new Date().toISOString()});});this.changed();this.kick();
  }
  async maintenanceStatus(){
    const state=await this.maintenance.read();for(const bug of state.bugs)if(bug.status==='repairing'&&!this.maintenanceFlights.has(bug.id)){bug.status='needs-version-fix';bug.recoveryUnavailable='interrupted-host-attempt';}return state;
  }
  async maintenanceRetry(bugId){
    if(this.maintenanceFlights.has(bugId))return this.maintenanceFlights.get(bugId);
    const flight=(async()=>{const bug=(await this.maintenance.read()).bugs.find(b=>b.id===bugId&&b.projectId===this.projectId);if(!bug)throw Error('unknown maintenance bug');
      if(bug.status==='repaired')return bug;
      const action=this.maintenanceActions.get(bugId);if(!action){if(['cancelled','human-boundary'].includes(bug.status))return bug;return this.maintenance.finish(bugId,{outcome:'needs-version-fix'});}
      const live=this.store.state.jobs.find(j=>j.id===bug.jobId),work=this.store.state.works.find(w=>w.id===bug.workId);
      if(this.stopping||work&&(work.revision!==bug.revision||['closing','ended'].includes(work.status))&&bug.phase!=='closure'||live?.status==='cancelled')return this.maintenance.finish(bugId,{outcome:'cancelled'});
      if(!await this.maintenance.attempt(bugId))return (await this.maintenance.read()).bugs.find(b=>b.id===bugId);
      try{const verified=await action();const result=await this.maintenance.finish(bugId,{verified:verified===true,outcome:verified===true?'host-outcome-verified':'needs-version-fix'});if(verified&&work?.maintenance?.bugId===bugId){await this.store.mutate(()=>{delete work.maintenance;if(bug.phase==='publication'&&['paused','running'].includes(work.status)&&work.result?.revision===bug.revision)work.status='review';else if(['session-start','input-preparation'].includes(bug.phase)&&live?.status==='failed'&&!live.promptStartedAt&&!live.collabAttempts?.some(a=>a.everAdmitted)){live.status='queued';delete live.maintenanceBugId;work.status='running';}});this.kick();}return result;}catch(error){if(work?.maintenance?.bugId===bugId)await this.store.mutate(()=>{if(work.status==='running')work.status='paused';});return this.maintenance.finish(bugId,{outcome:maintenanceBoundary(error)?'human-boundary':'needs-version-fix'});}
    })();this.maintenanceFlights.set(bugId,flight);try{return await flight;}finally{this.maintenanceFlights.delete(bugId);const state=await this.maintenance.read();await this.store.mutate(()=>{for(const w of this.store.state.works){const bug=state.bugs.find(b=>b.id===w.maintenance?.bugId);if(bug)w.maintenance.status=bug.status;}});this.changed();}
  }
  async maintenanceTransaction(job,phase,run,verify=()=>true){
    try{return await run();}catch(error){if(maintenanceBoundary(error)||error.exitUnconfirmed||error.code==='MAINTENANCE_PENDING')throw error;
      try{this.store.storage?.assertActive?.(this.projectId);}catch{throw error;}
      const bug=await this.maintenance.record({phase,jobId:job?.id??null,workId:job&&!['frontdesk','orchestrator'].includes(job.target)?job.target:null,revision:job?.revision??null,error,capability:phase});
      // The scheduler is not running during resident bootstrap. Keep a bounded
      // fault record, but never queue a repair that needs this same controller.
      if(!job&&!this.started&&/^resident-(preflight|start)-/.test(phase)){await this.maintenance.finish(bug.id,{outcome:'needs-version-fix'});throw error;}
      if(job?.type==='maintenance'){await this.maintenance.finish(bug.id,{outcome:'needs-version-fix'});throw Object.assign(Error('Maintenance provider unavailable'),{code:'MAINTENANCE_PENDING',bugId:bug.id});}
      let value;this.maintenanceActions.set(bug.id,async()=>{value=await run();return await verify(value);});await this.maintenanceEvent(bug);
      const result=await this.maintenanceRetry(bug.id);if(result.lastOutcome?.verified)return value;
      if(job)await this.store.mutate(()=>{const saved=this.store.state.jobs.find(j=>j.id===job.id);if(saved){saved.maintenanceBugId=bug.id;saved.maintenanceFault={phase,code:bug.error.code,symptom:bug.error.symptom};}const w=this.store.state.works.find(w=>w.id===job.target);if(w&&w.status==='running'){w.status='paused';w.maintenance={bugId:bug.id,status:result.status,message:'系统故障已记录，原任务与改动保留；后台维修中，不重放已开始操作。'};}});
      throw Object.assign(Error('Internal maintenance pending'),{code:'MAINTENANCE_PENDING',bugId:bug.id});
    }
  }
  async maintenanceScan(){
    const adopted=[];for(const job of this.store.state.jobs.filter(j=>['failed','interrupted'].includes(j.status)&&!j.maintenanceBugId&&j.error)){
      if(!job.maintenanceFault||!['input-preparation','publication','session-start'].includes(job.maintenanceFault.phase))continue;
      const bug=await this.maintenance.record({phase:job.maintenanceFault.phase,jobId:job.id,workId:job.target,revision:job.revision,error:{code:job.maintenanceFault.code}});
      await this.maintenance.finish(bug.id,{outcome:'needs-version-fix'});await this.store.mutate(()=>{job.maintenanceBugId=bug.id;for(const todo of this.store.state.todos)if(todo.sourceJobId===job.id&&['system','recovery'].includes(todo.kind))todo.status='resolved';});await this.maintenanceEvent(bug);adopted.push(bug.id);
    }return {adopted,automaticReplay:false};
  }
  async recordTransport(target,fact){
    const statuses=new Set(['prepared','submitted','pending','admitted','executed','rejected','unknown','settled']);
    if(!fact||!statuses.has(fact.status)||!['prompt','abort'].includes(fact.kind)||typeof fact.requestId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(fact.requestId)||typeof fact.sessionId!=='string'||typeof fact.epoch!=='string'||!Number.isSafeInteger(fact.attempt)||fact.attempt<1||!/^[a-f0-9]{64}$/.test(fact.contentDigest))throw Error('invalid transport fact');
    if(fact.status==='prepared'&&fact.kind==='prompt')await this.store.requireOnline();
    await this.store.mutateNative(()=>{
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
  async migrateLocalClosures(){
    const s=this.store.state;
    await this.store.mutate(()=>{
      this.migrateClosureState(s);
    });
    for(const w of s.works)if(w.status==='ended'&&w.mergeConstraint?.mode==='unresolved'&&!w.closure?.git?.complete)await this.#ensureMergeConstraintTodo(w.id,w);
  }
  migrateClosureState(s){
      // 合入同意迁移（幂等，逐work自守卫，无一次性全局门）：旧版按原始请求
      // 文本扫描形成的永久veto已废除。只把既有的USER_NO_COMMIT阻断重新归类
      // 为可解析的合入同意/策略待办：不解除阻断、不静默授权任何旧禁止；
      // 已按人工审校接受但缺少结构化授权的闭包回填绑定证据（仅未完成整合
      // 的闭包；已合入的历史不复核）。
        for(const w of s.works){
          let merge=w.closure?.merge;
          // Pre-review releases persisted this exact host error without a merge record.
          // Recognize the historical record, never scan user prose into authority.
          const legacyError=w.status==='ended'&&w.closure?.decision==='accept'&&w.closure.phase==='blocked'&&!w.closure.git?.complete&&w.closure.error==='此工作明确要求不提交Git；请先明确更新这一约束，再选择接受';
          if(legacyError&&!merge)merge=w.closure.merge={status:'blocked',blockedCode:'USER_NO_COMMIT',targetRef:w.execution?.targetRef??null,attempts:[]};
          if(merge?.blockedCode==='USER_NO_COMMIT'||legacyError){
            merge.blockedCode='MERGE_CONSENT_REQUIRED';
            merge.consentOrigin=merge.consentOrigin??'legacy-untrusted';
            merge.message='旧版“不提交Git”限制无法溯源，未自动解除；请在待办中一次性确认合入约束策略（never-commit/hold/none），原请求未改写';
            if(w.closure.phase==='blocked')w.closure.error=merge.message;
            // 旧限制改为legacy-unresolved一次性策略待办：原请求文本不改写，
            // 不永久veto；用户选择后按原队列恢复或保持需另行一次性合入批准。
            w.mergeConstraint??={schema:1,version:1,mode:'unresolved',origin:'legacy-unresolved',detectedAt:new Date().toISOString()};
            const row=(s.mergeQueue||[]).find(e=>e.workId===w.id);
            if(row&&row.status!=='done'){row.status='blocked';row.lastError=merge.message;}
          }
          // 未完结的存量工作若原文/输入带明确“永不提交”永久表述，同样进入
          // legacy-unresolved一次性策略待办：不把明确永久禁令静默当作临时，
          // 也不改写原文；已完整合入的历史不复核。
          if(!w.mergeConstraint&&!(w.status==='ended'&&w.closure?.phase==='complete')&&(explicitNeverCommitStatement(w.request||'')||(w.inputs||[]).some(i=>explicitNeverCommitStatement(i?.text||''))))w.mergeConstraint={schema:1,version:1,mode:'unresolved',origin:'legacy-unresolved',detectedAt:new Date().toISOString()};
          if(w.status==='ended'&&w.closure?.decision==='accept'&&!w.closure.mergeAuthorization&&!w.closure.git?.complete){
            const constraintRequired=w.mergeConstraint?.mode==='unresolved'||w.mergeConstraint?.mode==='never-commit';
            w.closure.mergeAuthorization={schema:1,workId:w.id,revision:w.closure.revision??w.revision,objectId:w.closure.binding?.objectId??null,candidateCommit:w.closure.binding?.candidateCommit??null,reviewVersion:w.closure.reviewedVersion?.reviewVersion??null,repo:w.execution?.repo??null,commonDir:w.execution?.commonDir??null,targetRef:w.execution?.targetRef??merge?.targetRef??null,targetHead:w.execution?.targetHead??null,basis:'user-accept',consentRequired:merge?.blockedCode==='MERGE_CONSENT_REQUIRED'||constraintRequired,consentOrigin:(merge?.blockedCode==='MERGE_CONSENT_REQUIRED'||constraintRequired)?(merge?.consentOrigin??w.mergeConstraint?.origin??'legacy-untrusted'):null,at:w.closure.at??w.endedAt??new Date().toISOString(),migrated:true};
          }
        }
  }
  async restore(){
    const s=this.store.state;
    await this.initializeBindings();
    await this.migrateLocalClosures();
    const recovered=[];for(const [target,record] of Object.entries(s.providers||{})){
      const slot=this.processBudget?.restoreSlot(this.projectId,target);
      const result=await (record.kind==='pi-node'?recoverPiProvider(record,this.store.root):['omp-rpc','omp-tui'].includes(record.kind)?recoverOmpProvider(record,this.store.root):recoverProvider(record,this.store.root));recovered.push(result);
      if(result.verified===true)this.processBudget?.release(slot);
    }
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
    await this.resumeReviewContinuations();
    await this.finalizeTransfers({restoring:true});
    for(const w of this.store.state.works)if(w.status==='ended'&&w.closure?.phase!=='complete')await this.advanceClosure(w.id);
    await this.drainMergeQueue();
  }
  async prepareOnline(){
    if(!this.localOnly)return;
    if(!this.onlinePreparation)this.onlinePreparation=this.initializeBindings().then(()=>{this.localOnly=false;}).catch(error=>{this.onlinePreparation=null;throw error;});
    await this.onlinePreparation;
  }
  async reconcileResidentSchemaMaintenance(previousThreads){
    const roles=['frontdesk','orchestrator'];
    if(!roles.every(target=>{const session=this.sessions.get(target),resident=this.store.state.residents[target];return session&&!session.closed&&session.threadId&&session.threadId===resident?.threadId&&session.toolsDigest===resident?.toolsDigest;}))return;
    const state=await this.maintenance.read();
    for(const bug of state.bugs){
      const match=/^resident-(?:preflight|start)-(frontdesk|orchestrator)$/.exec(bug.phase);
      if(!match||!['OMP_TOOLS_DIGEST_MISMATCH','PI_TOOLS_DIGEST_MISMATCH'].includes(bug.error?.code)||bug.status==='repaired'||bug.jobId||bug.workId)continue;
      const target=match[1];if(!previousThreads[target]||this.sessions.get(target).threadId!==previousThreads[target])continue;
      const related=this.store.state.jobs.filter(job=>job.type==='maintenance'&&job.context?.bugId===bug.id);
      if(related.some(job=>job.status==='running'||job.promptStartedAt!=null||job.collabAttempts?.some(attempt=>attempt.everAdmitted)))continue;
      // Only never-admitted repair events settle; business input and unknown
      // effects stay intact. Save before the ledger receipt for idempotence.
      await this.store.mutate(()=>{for(const job of related)if(job.status==='queued')Object.assign(job,{status:'completed',hostResolved:true,completion:'current-schema-resumed',finishedAt:new Date().toISOString()});});
      await this.maintenance.finish(bug.id,{verified:true,outcome:'current-schema-resumed'});
      this.maintenanceActions.delete(bug.id);
    }
  }
  async start(){
    await this.store.requireOnline();
    await this.prepareOnline();
    this.assertFrontdeskContextAdmission('frontdesk');
    const residents=['frontdesk','orchestrator'].filter(target=>!this.sessions.get(target)||this.sessions.get(target).closed);
    const previousThreads=Object.fromEntries(['frontdesk','orchestrator'].map(target=>[target,this.store.state.residents[target]?.threadId]));
    const bootstrap=(target,phase,run)=>this.maintenanceTransaction(null,phase+'-'+target,async()=>{try{return await run();}catch(error){error.target??=target;error.role??=target;throw error;}});
    const preflight=await Promise.allSettled(residents.map(target=>bootstrap(target,'resident-preflight',()=>this.makeSession(target,{preflightOnly:true}))));
    const rejected=preflight.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
    const results=await Promise.allSettled(residents.map(target=>bootstrap(target,'resident-start',()=>this.session(target))));const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    await this.reconcileResidentSchemaMaintenance(previousThreads);
    this.started=true;this.changed();this.kick();return this.snapshot();
  }
  async applyModelDefaults(defaults){
    this.assertFrontdeskContextAdmission('frontdesk');
    const sync={applied:0,pending:0,failed:[],sessions:[]};
    this.modelDefaultFailures=new Map();
    if(this.stopping)return sync;
    this.modelDefaultsApplying=(this.modelDefaultsApplying??0)+1;
    const safeCode=code=>SAFE_MODEL_CHANGE_CODES.includes(code)?code:'PI_MODEL_CHANGE_FAILED';
    try{
      await Promise.all([...this.sessions].map(async([target,session])=>{
        if(session.closed)return;
        const role=['frontdesk','orchestrator'].includes(target)?target:'worker';
        if(role==='worker'){
          const work=this.store.state.works.find(work=>work.id===target);
          if(!work||work.readOnly||['closing','ended'].includes(work.status))return;
        }
        const entry=defaults?.[role]&&typeof defaults[role]==='object'?defaults[role]:{model:{mode:'native-default'},thinking:{mode:'native-default'}};
        const explicitModel=entry.model?.mode==='explicit'?entry.model.selector:null;
        const explicitThinking=entry.thinking?.mode==='explicit'?entry.thinking.level:null;
        const row={projectId:this.projectId,target,ownerId:session.viewOwnerId,sessionId:session.threadId??null};
        if(!explicitModel&&explicitThinking==null){
          // Both native-default: cancel queued overrides, claim no native change.
          // A failure here is an explicit row like any other — it must never
          // leak a raw native error into the propagation result.
          try{
            await session.applyDefaultModel({clear:true});
            sync.sessions.push({...row,state:'unchanged',cleared:true,effective:session.effective??{model:session.model,effort:session.effort}});
          }catch(error){
            const failure={role,message:'Agent默认模型同步失败；配置已保存，可重试保存。',...(error?.code?{code:safeCode(error.code)}:{})};
            this.modelDefaultFailures.set(target,{session,failure});
            sync.failed.push(failure);
            sync.sessions.push({...row,state:'failed',effective:session.effective??{model:session.model,effort:session.effort},error:{code:failure.code,message:failure.message}});
          }
          return;
        }
        const selector=explicitModel??session.model;
        if(!selector){sync.sessions.push({...row,state:'unchanged',effective:session.effective??{model:session.model,effort:session.effort}});return;}
        try{
          const result=await session.applyDefaultModel({selector,...(explicitThinking?{effort:explicitThinking}:{})});
          if(result.state==='pending')sync.pending++;
          else if(result.state==='applied')sync.applied++;
          sync.sessions.push({...row,state:result.state,desired:{model:selector,...(explicitThinking?{effort:explicitThinking}:{})},effective:session.effective??{model:session.model,effort:session.effort},...(result.clamped?{clamped:result.clamped}:{})});
        }catch(error){
          const failure={role,message:'Agent默认模型同步失败；配置已保存，可重试保存。',...(error?.code?{code:safeCode(error.code)}:{})};
          this.modelDefaultFailures.set(target,{session,failure});
          sync.failed.push(failure);
          sync.sessions.push({...row,state:'failed',desired:{model:selector,...(explicitThinking?{effort:explicitThinking}:{})},effective:session.effective??{model:session.model,effort:session.effort},error:{code:failure.code,message:failure.message}});
        }
      }));
    }finally{
      this.modelDefaultsApplying--;
    }
    this.changed();
    return sync;
  }
  modelSync(){
    const sync={applied:0,pending:0,failed:[],sessions:[]};
    for(const [target,session] of this.sessions){
      if(session.closed)continue;
      if(!['frontdesk','orchestrator'].includes(target)){
        const work=this.store.state.works.find(work=>work.id===target);
        if(!work||work.readOnly||['closing','ended'].includes(work.status))continue;
      }
      const role=['frontdesk','orchestrator'].includes(target)?target:'worker';
      const failed=this.modelDefaultFailures?.get(target);
      let state;
      if(failed?.session===session)state='failed';
      else if(session.modelError)state='failed';
      else if(session.pendingModel)state='pending';
      else if(session.desiredModel!=null)state=session.model===session.desiredModel?'applied':'failed';
      else state='unchanged';
      if(state==='applied')sync.applied++;
      else if(state==='pending')sync.pending++;
      else if(state==='failed'){
       // Redacted failure DTO: only allowlisted codes surface, so a native
       // error text/code can never leak paths or secrets.
       const known=SAFE_MODEL_CHANGE_CODES.includes(session.modelError?.code)?session.modelError.code:null;
       sync.failed.push({role,message:'Agent默认模型延后应用失败；原生当前选择已保留，请重试保存。',...(known?{code:known}:{})});
      }
      sync.sessions.push({projectId:this.projectId,target,ownerId:session.viewOwnerId,sessionId:session.threadId??null,desired:session.desiredModel!=null?{model:session.desiredModel,effort:session.pendingModel?.effort??session.effort}:null,effective:session.effective??{model:session.model,effort:session.effort},state});
    }
    return sync;
  }
  // Credential/source rotation: each online session of the provider re-applies
  // its own (possibly still pending) desired selector at its safe idle
  // boundary. Persistence already succeeded; these rows never fail the save.
  async applyProviderUpdate(provider){
    const application={applied:0,pending:0,failed:[],sessions:[]};
    if(this.stopping||!provider)return application;
    await Promise.all([...this.sessions].map(async([target,session])=>{
      if(session.closed)return;
      if(!['frontdesk','orchestrator'].includes(target)){
        const work=this.store.state.works.find(work=>work.id===target);
        if(!work||work.readOnly||['closing','ended'].includes(work.status))return;
      }
      const row={projectId:this.projectId,target,ownerId:session.viewOwnerId,sessionId:session.threadId??null};
      try{
        const result=await session.refreshProviderSource(provider);
        if(result.state==='applied')application.applied++;
        else if(result.state==='pending')application.pending++;
        application.sessions.push({...row,state:result.state,...(result.desired?{desired:{model:result.desired.selector,...(result.desired.effort?{effort:result.desired.effort}:{})}}:{}),effective:session.effective??{model:session.model,effort:session.effort}});
      }catch(error){
        const failure={role:['frontdesk','orchestrator'].includes(target)?target:'worker',message:'源已保存，但该Agent未能在空闲边界刷新凭据；原会话保持，可重试保存源。',code:error?.code??'PI_PROVIDER_REFRESH_FAILED'};
        application.failed.push(failure);
        application.sessions.push({...row,state:'failed',effective:session.effective??{model:session.model,effort:session.effort},error:{code:failure.code,message:failure.message}});
      }
    }));
    this.changed();
    return application;
  }
  pauseState(w,reason){w.status='paused';const source=this.store.state.jobs.findLast(j=>j.target===w.id&&j.revision===w.revision);if(!this.store.state.todos.some(t=>t.workId===w.id&&t.kind==='recovery'&&t.status==='open'&&t.revision===w.revision))this.store.state.todos.push({id:randomUUID(),workId:w.id,revision:w.revision,...(source?{sourceJobId:source.id}:{}),kind:'recovery',status:'open',text:reason});}
  snapshot(){
    const agents=[...this.sessions.entries()].map(([target,s])=>({target,ownerId:s.viewOwnerId,terminalId:this.terminals.get(target)?.terminalId??null,provider:'pi',threadId:s.threadId||this.store.state.residents?.[target]?.threadId||this.store.state.works.find(w=>w.id===target)?.threadId,starting:this.starting.has(target),restarting:this.restarting?.has(target)??false,busy:s.busy,closed:s.closed,phase:s.phase??null,exit:s.exit&&typeof s.exit.then!=='function'?s.exit:null,model:s.model,desiredModel:s.desiredModel??null,pendingModel:s.pendingModel??null,effort:s.effort,interactions:s.closed?[]:structuredClone(s.interactions??[]),modelError:s.modelError??null,...(s.effective?{effective:s.effective}:{}),configurationStatus:s.configurationStatus??null,capabilities:s.capabilities??null,cleanupEvidence:s.cleanupEvidence?.()??null}));
    for(const w of this.store.state.works)if(w.threadId&&!['ended','closing'].includes(w.status)&&!this.sessions.has(w.id))agents.push({target:w.id,provider:w.binding?.provider,threadId:w.threadId,busy:false,closed:true,resumable:w.binding?.provider==='pi'&&!w.readOnly,readOnly:w.readOnly===true,model:null,effort:null});
    const {sessionIndex,messages,...business}=this.store.state;
    const storageBlocked=Boolean(this.store.commitUnknown||this.store.nativeCommitUnknown);
    const nativeDraftBlockedTargets=[...(this.nativeDraftBlockedOwners??[])].filter(([target,ownerId])=>this.nativeDraftTargets.has(target)&&this.sessions.get(target)?.viewOwnerId===ownerId).map(([target])=>target);
    return {...structuredClone(business),messages:this.timeline.messages(),timeline:this.timeline.frame(),quotaUsed:this.store.used(),agents,storageBlocked,nativeDraftBlockedTargets,configuringTargets:[...new Set([...(this.configuring??[]),...(this.bindingTransitions??[]),...(this.frontdeskContextClear?['frontdesk']:[])])],frontdeskContextClearFailed:this.frontdeskContextClearFailed===true,externalTerminalTargets:[...this.externalTerminalTargets],nativeDraftTargets:[...this.nativeDraftTargets],busyTargets:[...this.running.keys()],stopping:this.stopping};
  }
  changed(){this.emit('state',this.snapshot());}
  async initializeBindings(){
    const skills={},defaults={};
    for(const role of Object.keys(roles)){
      skills[role]=(await fs.readdir(path.join(here,roles[role].package,'skills'))).filter(f=>f.endsWith('.md')).sort();
      const instructions=await rolePrompt(role,{skills:skills[role]});defaults[role]={provider:'pi',skills:skills[role],instructions,instructionDigest:createHash('sha256').update(instructions).digest('hex')};
    }
    await this.store.mutate(async()=>{
      const s=this.store.state;s.bindings??=structuredClone(defaults);s.roleSkills=skills;for(const role of Object.keys(roles))s.bindings[role]??=structuredClone(defaults[role]);
      for(const w of s.works)if(w.threadId&&!w.binding)w.binding={...structuredClone(defaults.worker),provider:'codex'};
      if(s.piHostCutover!==1){
        // Separate pi migration (never a naive rename): OMP identities become
        // read-only archives; only never-started works adopt pi defaults.
        s.residentArchive??={};s.bindingArchive??=[];
        for(const role of ['frontdesk','orchestrator'])if(s.residents?.[role]?.provider&&s.residents[role].provider!=='pi'){
          const record=s.residents[role],archive=s.residentArchive[role]??={};
          archive[record.provider]={...structuredClone(record),readOnly:true,messages:structuredClone((s.messages??[]).filter(message=>message.target===role)),archivedAt:new Date().toISOString()};
          delete s.residents[role];
        }
        for(const role of Object.keys(roles))if(s.bindings[role].provider!=='pi'){
          const previous=s.bindings[role];s.bindingArchive.push({role,reason:'pi-host-cutover',binding:structuredClone(previous)});
          if(role!=='worker'&&s.residents?.[role]){const archive=s.residentArchive[role]??={};archive[previous.provider||'omp']={...structuredClone(s.residents[role]),provider:previous.provider||'omp',readOnly:true,messages:structuredClone((s.messages??[]).filter(message=>message.target===role)),archivedAt:new Date().toISOString()};delete s.residents[role];}
          s.bindings[role]=structuredClone(defaults[role]);
        }
        for(const w of s.works){
          if(w.binding?.provider==='pi')continue;
          if(w.threadId){w.readOnly=true;w.contextRecovery={code:'WORKER_CONTEXT_RECOVERY_REQUIRED',threadId:w.threadId,revision:w.revision,message:'Original provider identity retained read-only; explicit same-Work context handoff required'};if(!['ended','closing','paused','review'].includes(w.status))w.status='paused';}
          else w.binding=structuredClone(defaults.worker);
        }
        s.piHostCutover=1;
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
  async setBinding(role,{provider='pi',skills}={}){
    this.assertFrontdeskContextAdmission(role);
    if(this.handoffPreparing?.size||this.residentHandoffs?.size||this.handoffConfirmations?.size)throw this.residentHandoffError('PI_HANDOFF_CONFIRMATION_REQUIRED',role,'resident handoff blocks binding changes');
    if(!Object.hasOwn(roles,role))throw new Error('unknown role');
    if(provider!=='pi')throw Object.assign(new Error('Only the bundled Pi runtime is supported'),{code:'BACKEND_UNSUPPORTED'});
    const selected=skills??this.store.state.bindings[role].skills;
    if(!Array.isArray(selected)||new Set(selected).size!==selected.length||selected.some(s=>!this.store.state.roleSkills[role].includes(s)))throw new Error('unknown or duplicate role skill');
    if(this.configuring.has(role)||this.restarting?.has(role))throw new Error('role configuration in progress');
    if(role!=='worker'&&(this.nativeDraftTargets.has(role)||this.running.has(role)||this.store.state.jobs.some(j=>j.target===role&&j.status==='queued')))throw new Error('resident has accepted input; change settings when idle');
    this.configuring.add(role);const previous=structuredClone(this.store.state.bindings[role]);const previousResident=role!=='worker'?structuredClone(this.store.state.residents[role]??null):null;
    this.bindingTransitions??=new Set();this.bindingTransitions.add(role);
    this.changed();
    try{
      if(previous.provider!=='pi'&&previous.model)await this.migrateNativeBinding(role,previous);
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
  async setDraft(target,value){this.validateTarget(target);if(typeof value!=='string'||value.length>32000)throw new Error('invalid draft');await this.store.setDraft(target,value);this.changed();}
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
  // 用户问题决定（approve/reject 均续作同一Work）：本地CAS账本先于任何模型连接。
  async resolveProblem(payload){return resolveProblemDecision(this,payload);}
  async stopDeviationOwner(target){
    const session=this.sessions.get(target);if(!session)return;
    await this.terminals.get(target)?.close();
    const receipt=await session.stop();await session.controllerExitCleanup;
    if(session.pid&&receipt?.confirmationComplete!==true)throw Error('Deviation Worker exit unconfirmed');
    if(this.sessions.get(target)===session)this.sessions.delete(target);
    await this.store.mutate(()=>{delete this.store.state.providers[target];});
  }
  async enqueue(target,type,value,{key=randomUUID(),context={},priority=false}={}){
    this.store.storage.assertActive(this.projectId);
    this.validateTarget(target);if(this.stopping)throw new Error('host stopping');if(typeof value!=='string'||!value.trim())throw new Error('invalid input');
    const job=await this.store.mutate(()=>this.queueJob(target,type,value,{key,context,priority}));
    this.changed();this.kick();return {accepted:true,jobId:job.id};
  }
  // Called only inside a store mutation so accepted input and its effects are durable together.
  queueJob(target,type,value,{key=randomUUID(),context={},priority=false}={}){
    this.assertFrontdeskContextAdmission(target);
    if(this.handoffPreparing?.size||this.residentHandoffs?.size||this.handoffConfirmations?.size)throw this.residentHandoffError('PI_HANDOFF_CONFIRMATION_REQUIRED',target,'resident handoff blocks new jobs');
    if(!['frontdesk','orchestrator'].includes(target)&&this.store.find(target).readOnly)throw Object.assign(new Error('Historical provider work is read-only'),{code:'HISTORICAL_SESSION_READ_ONLY'});
    if(this.stopping)throw new Error('host stopping');
    if(typeof value!=='string'||!value.trim())throw new Error('invalid input');
    // Immutable admission identity for cross-project permissions: assigned at
    // job creation (user admission), inherited only when a host continuation
    // spreads job.context. Discussion goal switching never changes it. A
    // same-key replay compares the caller's original context and reuses the
    // stored identity, so retries never collide on a freshly generated id.
    if(type==='intake'&&context.routingQuestionId){const parent=this.store.state.jobs.find(j=>j.id===this.store.state.todos.find(q=>q.id===context.routingQuestionId)?.sourceJobId);if(parent?.context?.boundWorkId)context={...context,boundWorkId:parent.context.boundWorkId};}
    const old=this.store.state.jobs.find(j=>j.key===key);
    if(old){const replayContext={...context,permissionTaskId:old.context.permissionTaskId};if(old.target!==target||old.type!==type||old.text!==value||JSON.stringify(old.context)!==JSON.stringify(replayContext))throw Error('submission key collision');return structuredClone(old);}
    context={...context,permissionTaskId:context.permissionTaskId??randomUUID()};
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
    const latest=kind=>this.store.state.receipts.filter(r=>r.workId===w.id&&r.kind===kind).at(-1)?.report.excerpt;
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
  async send(target,value,options={}){this.store.storage.assertActive(this.projectId);return ['frontdesk','orchestrator'].includes(target)?this.sendUnlocked(target,value,options):this.workLocked(target,()=>this.sendUnlocked(target,value,options));}
  async sendUnlocked(target,value,{priority=false,native=false,context={},requestKey,draftText,preserveDraft=false}={}){
    this.validateTarget(target);
    this.assertFrontdeskContextAdmission(target);
    if(!['frontdesk','orchestrator'].includes(target)&&this.store.find(target).readOnly)throw Object.assign(new Error('Historical provider work is read-only; confirm explicit context recovery before new input'),{code:'HISTORICAL_SESSION_READ_ONLY'});
    if(typeof value!=='string'||!value.trim()||value.length>32000)throw new Error('invalid input');
    if (!native) await this.sessions.get(target)?.refreshNativeDraft?.();
    const job=await this.store.mutate(tx=>{
      const old=requestKey&&this.store.state.jobs.find(j=>j.key==='input:'+requestKey);
      if(!old&&!native&&this.nativeDraftTargets.has(target)){
        this.nativeDraftBlockedOwners??=new Map();this.nativeDraftBlockedOwners.set(target,this.sessions.get(target)?.viewOwnerId);this.changed();
        throw Object.assign(new Error('原生会话仍有未发送文字，已阻断本次发送。请在工作区待办中保留并处理原生草稿；当前对话草稿未丢失，输入尚未受理。'),{code:'NATIVE_DRAFT_PENDING'});
      }
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
      if(!old&&!preserveDraft)tx.consumeDraft(target,draftText??value);return job;
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
    // merge-consent准入：补充输入里出现明确“永不提交”的永久表述时，进入
    // 版本绑定约束待办等用户显式选择；宽泛“先不要提交”不触发（临时暂缓，
    // 接受即本地合入授权）。原请求/输入文本永不改写。
    if(explicitNeverCommitStatement(source.request)&&!work.mergeConstraint){
      work.mergeConstraint={schema:1,version:1,mode:'unresolved',origin:'detected',detectedAt:new Date().toISOString()};
      if(!this.store.state.todos.some(t=>t.workId===work.id&&t.kind==='merge-constraint'&&t.status==='open'))this.store.state.todos.push({id:randomUUID(),workId:work.id,revision:work.revision,kind:'merge-constraint',status:'open',constraintVersion:1,text:'补充输入包含明确“永不提交”表述：请一次性确认这是“禁止合入直到另行授权”（永久，合入需另行一次性批准）还是临时暂缓/无约束。原输入不改写。'});
    }
    if(work.status==='queued'&&source.imageAttachments.length)work.imageAttachments=[...new Map([...(work.imageAttachments||this.store.state.jobs.find(j=>j.id===work.sourceJob)?.context?.imageAttachments||[]),...source.imageAttachments].map(ref=>[ref.digest+':'+ref.mime,ref])).values()];
  }
  initialWorkerText(work){
    const original=this.workerInputText(work.request,work.originalBrief??work.brief,'主控任务说明');
    const supplements=(work.inputs||[]).map(input=>'补充用户原文：\n'+this.workerInputText(input.text,input.brief));
    return [...(work.frontdeskTransfer?['前台已完成操作仅为历史，不得重放；只执行原范围内剩余步骤。当前执行目录为交接时真实项目版本。\n'+JSON.stringify(work.frontdeskTransfer)]:[]),'原始用户请求：\n'+original,...supplements,'项目目录中的文件是实际材料。缺信息就发布 problem 后结束当前回合，完成则发布 result；不要等待或结束 Work。'].join('\n');
  }
  async submitTask(value,{requestKey,context={},draftText=value,preserveDraft=false}={}){
    this.store.storage.assertActive(this.projectId);
    if(typeof value!=='string'||!value.trim()||value.length>32000)throw Error('invalid input');
    const job=await this.store.mutate(tx=>{
      const old=this.store.state.jobs.find(j=>j.key==='task:'+requestKey);
      const job=this.queueJob('orchestrator','intake',value,{key:'task:'+requestKey,context:{...context,manual:true}});
      if(!old&&!preserveDraft)tx.consumeDraft('frontdesk',draftText);return job;
    });this.changed();this.kick();return {accepted:true,jobId:job.id};
  }
  frontGoal(job){return this.store.state.frontGoals?.find(g=>g.id===this.store.state.jobs.find(j=>j.id===job.id)?.context?.frontGoalId);}
  canReuseFrontGoal(value,goal){
    if(!goal)return false;
    const boundary=this.store.state.frontdeskContextEpoch?.jobId;
    if(boundary&&this.store.state.jobs.findIndex(j=>j.id===goal.rootJobId)<=this.store.state.jobs.findIndex(j=>j.id===boundary))return false;
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
      // One store todo is the single routing authority; the destination block
      // projects the same proposal for the attention UI (handling decision,
      // never a security authorization).
      const rootText=goal?s.jobs.find(j=>j.id===goal.rootJobId)?.text??job.text:job.text;
      const question={method:'frontdesk-route',title:'处理方式决定（非安全授权）',originalText:rootText,reason,remainingActions:reason,completedOperations:proposal.completedOperations.map(r=>({op:r.op,relPath:r.value?.relPath??r.relPath??null,operationId:r.operationId,revision:r.value?.revision??r.revision??null,digest:r.value?.digest??r.digest??null,at:r.at}))};
      s.frontdeskRoutes.push(proposal);s.todos.push({id:randomUUID(),kind:'frontdesk-route',status:'open',sourceJobId:job.id,proposalId:proposal.id,text:reason,destination:{kind:'frontdesk-route',proposalId:proposal.id,expectedVersion:proposal.version,sourceJobId:job.id,question}});return structuredClone(proposal);
    });this.changed();return {accepted:true,transferred:false,hostControl:true,userDecisionRequired:true,proposalId:result.id,version:result.version,status:result.status,...(result.duplicate?{duplicate:true}:{})};
  }
  async resolveFrontdeskRoute({proposalId,expectedVersion,action,requestKey}={}){
    if(typeof proposalId!=='string'||!Number.isInteger(expectedVersion)||!['continue','background','cancel'].includes(action)||typeof requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(requestKey))throw Error('invalid frontdesk route decision');
    const result=await this.store.mutate(async()=>{
      const s=this.store.state,identity=JSON.stringify([proposalId,expectedVersion,action]);s.frontdeskRouteDecisions??=[];
      const old=s.frontdeskRouteDecisions.find(r=>r.requestKey===requestKey);if(old){if(old.identity!==identity)throw Error('frontdesk route request key collision');return {...structuredClone(old.result),duplicate:true};}
      const route=s.frontdeskRoutes?.find(r=>r.id===proposalId),job=s.jobs.find(j=>j.id===route?.sourceJobId),goal=job&&this.frontGoal(job);
      if(!route||route.status!=='pending'||route.version!==expectedVersion||!job||goal?.id!==route.goalId||goal?.intakeJobId)throw Object.assign(Error('frontdesk route decision is stale'),{code:'STALE_FRONTDESK_ROUTE'});
      if(action==='cancel'){
        // Cancel closes the proposal only: no dispatch, no revocation of the
        // operations the frontdesk already saved.
        route.status='cancelled';route.version++;route.decision={action,requestKey,at:new Date().toISOString(),authority:'user-choice'};
        for(const todo of s.todos)if(todo.proposalId===proposalId&&todo.kind==='frontdesk-route'){todo.status='resolved';todo.resolution='cancel';}
        const cancelled={accepted:true,proposalId,version:route.version,action,cancelled:true,transferred:false,jobId:null};
        s.frontdeskRouteDecisions.push({requestKey,identity,result:cancelled});return structuredClone(cancelled);
      }
      route.completedOperations=structuredClone(this.frontdeskCompleted(goal));
      const currentSources=[];for(const relPath of new Set(route.completedOperations.map(r=>r.value?.relPath).filter(Boolean))){
        const origin=route.completedOperations.find(r=>r.value?.relPath===relPath)?.actor;
        let source;
        if(this.frontdeskDocuments&&origin){const receipt=await this.frontdeskDocuments({op:'read',arguments:{relPath},actor:origin,operationId:createHash('sha256').update(proposalId+':decision-source:'+relPath).digest('hex'),isActive:()=>!this.stopping&&route.status==='pending'});if(!receipt.ok){currentSources.push({source:relPath,error:receipt.error});continue;}source=receipt.value;}
        else try{source=await frontSource(this,'file:'+relPath,job);}catch(error){currentSources.push({source:relPath,error:error.message});continue;}
        const body=String(source.text??''),snapshotDigest=createHash('sha256').update(body).digest('hex');
        await this.store.putObject(Buffer.from(body));
        let end=Math.min(body.length,1200);if(end<body.length&&/[\uD800-\uDBFF]/.test(body[end-1])&&/[\uDC00-\uDFFF]/.test(body[end]))end--;
        currentSources.push({source:relPath,version:source.version,digest:source.digest??snapshotDigest,snapshotDigest,buffer:source.buffer,diskVersion:source.diskVersion,preview:body.slice(0,end),totalChars:body.length,truncated:end<body.length,readSelector:'frontdesk-source:'+snapshotDigest,instruction:'审批时冻结原文；前台用@read加readSelector分页读取，主控用nozeli_inspect_work workName="@frontdesk-source:摘要"读取；Worker读当前执行目录并核对版本。'});
      }
      const scopeInputs=(goal?.jobIds||[job.id]).map(id=>s.jobs.find(j=>j.id===id)).filter(j=>j&&!j.context?.frontdeskResumeOf).map(j=>({sourceJobId:j.id,text:j.text}));
      const history={originalRequest:s.jobs.find(j=>j.id===goal?.rootJobId)?.text??route.originalText,scopeInputs,completedOperations:route.completedOperations,currentSources};
      const text=(action==='background'?'宿主已收到并持久化用户选择：送到后台。此选择已完成，不再询问前台或后台；主控现在只判断新工作、已有工作或真正的归属歧义。':'宿主已收到并持久化用户选择：继续在前台。此选择已完成，直接处理原范围内剩余要求，不再重复建议同一次转后台。')+'\n只继续尚未完成的原目标；已完成操作是历史，不得重放；用户选择不扩大授权范围。建议原因不是用户指令，不授权额外目标。历史输入中“先等选择”的条件已由上述用户决定满足，不是本轮待回答问题。\n前台建议/剩余工作线索：'+route.reason+'\n历史与当前来源（原请求仅为范围依据，不是重新执行指令）：\n'+JSON.stringify(history);
      route.status=action==='continue'?'continued':'background';route.version++;route.decision={action,requestKey,at:new Date().toISOString(),authority:'user-choice'};
      let accepted;
      if(action==='continue'){const resume=this.queueJob('frontdesk','front',text,{key:'frontdesk-route:'+proposalId,context:{...job.context,frontGoalId:goal?.id,frontdeskResumeOf:job.id,frontdeskRouteId:proposalId,completedOperations:route.completedOperations,routeAuthority:'user-choice'}});accepted={accepted:true,proposalId,version:route.version,action,jobId:resume.id,transferred:false};}
      else {const routed=this.handoffFrontState(job,route.reason,{text,completedOperations:route.completedOperations,currentSources,frontdeskRouteId:proposalId,authority:'user-choice'});accepted={...routed,proposalId,version:route.version,action,transferred:true};}
      for(const todo of s.todos)if(todo.proposalId===proposalId&&todo.kind==='frontdesk-route'){todo.status='resolved';todo.resolution=action;}
      s.frontdeskRouteDecisions.push({requestKey,identity,result:accepted});return structuredClone(accepted);
    });this.changed();this.kick();return result;
  }
  // Resolution discovers filesystem identity without registering a project.
  async crossProjectTarget(job,p,op){
    if(!['read','list','search','create','apply'].includes(op))return null;
    const args=p.arguments??{};
    if(op==='apply'){
      const operationId=createHash('sha256').update(this.store.state.workspaceId+job.id+p.callId).digest('hex');
      const receipt=await this.store.storage.getLocal(this.projectId,'managed:external-document:'+operationId);
      if(receipt)return {external:true,root:receipt.root,relPath:receipt.value?.relPath??path.relative(receipt.root,receipt.path)};
      const external=this.externalDocuments?.peek('apply',args);if(external)return external;
      const bound=this.frontdeskDocuments?.peek?.('apply',args);
      if(!bound||bound.projectId===this.projectId)return null;
      return this.resolveRegisteredProject(bound.projectId);
    }
    let candidate=args.projectPath,requestedAbsolute=null;
    if(path.isAbsolute(args.relPath??'')||path.isAbsolute(candidate??'')){
      const requested=path.isAbsolute(args.relPath??'')?args.relPath:path.resolve(candidate,args.relPath??'');
      requestedAbsolute=requested;
      const absolute=await fs.realpath(requested).catch(error=>{if(error.code==='ENOENT'&&op==='create')return requested;throw error;});
      candidate=op==='list'||op==='search'?absolute:path.dirname(absolute);
      p.arguments={...args,relPath:op==='list'||op==='search'?'':path.basename(absolute)};
    }
    if(candidate===undefined||candidate===null||candidate==='')return null;
    if(typeof candidate!=='string'||candidate.length>4096)throw Object.assign(new Error('projectPath 无效。'),{code:'INVALID_PAYLOAD'});
    if(typeof this.resolveRegisteredProject!=='function')throw Object.assign(new Error('文件路径解析未接入。'),{code:'CAPABILITY_UNAVAILABLE'});
    const resolved=await this.resolveRegisteredProject(candidate);
    if(resolved.external&&requestedAbsolute)p.arguments={...p.arguments,relPath:requestedAbsolute};
    if(resolved.relPathPrefix)p.arguments={...p.arguments,relPath:path.posix.join(resolved.relPathPrefix,p.arguments?.relPath??'')};
    return resolved.projectId===this.projectId?null:resolved;
  }
  // Host-managed execution: ordinary YOLO admission, or exact frozen
  // high-danger user authorization. Both retain durable intent and receipts.
  async privilegedExecute(job,target,p){
    if(!this.taskPermissions)throw Object.assign(new Error('效果授权台账未接入。'),{code:'CAPABILITY_UNAVAILABLE'});
    const a=p.arguments??{};
    let frozen;
    try{frozen=normalizeExecutionEffect(a);}catch(error){return {ok:false,error:{code:error.code||'INVALID_EFFECT',message:error.message},continueTurn:true};}
    // cwd is frozen and must EXIST (identity pinned at prepare). Root/system
    // maintenance legitimately uses /root, /etc… — an unregistered location is
    // not pre-rejected; it is shown as explicit risk in the approval todo.
    let cwdStat=null;
    try{cwdStat=await fs.lstat(frozen.cwd);}catch{}
    if(!cwdStat||!cwdStat.isDirectory()||cwdStat.isSymbolicLink())throw Object.assign(new Error('cwd 必须是现存的真实目录：'+frozen.cwd),{code:'INVALID_EFFECT'});
    // Pin the executable content at approval time: resolve the command through
    // the CURRENT platform's rules (absolute/relative path, else PATH lookup,
    // plus PATHEXT on win32) to the real binary and hash its bytes. An
    // unresolvable command is INVALID_EFFECT — never a literal-string digest
    // pretending to pin content. cwd identity (dev/ino/birth) is frozen too:
    // a replaced working directory can never ride an old approval.
    const resolveExecutable=async()=>{
      const segments=process.env.PATH??'';
      const candidates=[];
      const hasSep=frozen.command.includes('/')||frozen.command.includes('\\');
      if(hasSep||path.isAbsolute(frozen.command))candidates.push(path.resolve(frozen.cwd,frozen.command));
      else{
        candidates.push(path.resolve(frozen.cwd,frozen.command));
        for(const dir of segments.split(path.delimiter))if(dir)candidates.push(path.resolve(dir,frozen.command));
        if(process.platform==='win32')for(const ext of (process.env.PATHEXT||'.EXE;.CMD;.BAT').split(';'))if(ext)for(const base of [...candidates])candidates.push(base+ext.toLowerCase());
      }
      for(const candidate of [...new Set(candidates)]){try{const real=await fs.realpath(candidate),stat=await fs.stat(real);if(stat.isFile()){await fs.access(real,process.platform==='win32'?fs.constants.F_OK:fs.constants.X_OK);return real;}}catch{}}
      return null;
    };
    const executable=await resolveExecutable();
    if(!executable)throw Object.assign(new Error('无法在当前平台解析可执行文件（PATH/PATHEXT/绝对路径均未命中）：'+frozen.command+'；请提供可解析的命令路径后重试。'),{code:'INVALID_EFFECT'});
    let commandDigest;try{commandDigest=createHash('sha256').update(await fs.readFile(executable)).digest('hex');}catch(error){throw Object.assign(new Error('可执行文件无法读取以固化内容摘要：'+executable+'；'+error.message),{code:'INVALID_EFFECT'});}
    const cwdStatNow=await fs.lstat(frozen.cwd);
    const cwdIdentity={dev:cwdStatNow.dev,ino:cwdStatNow.ino,birth:cwdStatNow.birthtimeMs};
    frozen={...frozen,commandDigest,resolvedCommand:executable,cwdIdentity,...(a.dangerousEffect?{dangerousEffect:a.dangerousEffect}:{})};
    const goal=this.frontGoal(job);
    const originalText=goal?this.store.state.jobs.find(j=>j.id===goal.rootJobId)?.text??job.text:job.text;
    const prepare=executionDanger(frozen)?'prepareEffect':'prepareOrdinary';
    const gate=await this.taskPermissions[prepare](this.projectId,{sourceJobId:job.id,permissionTaskId:job.context?.permissionTaskId??job.id,role:['frontdesk','orchestrator'].includes(target)?target:'worker',effectType:'host-exec',frozenEffect:frozen,originalText,reason:executionDanger(frozen)??(typeof a.purpose==='string'?a.purpose:null),operationKey:String(p.callId??'')||null});
    if(gate.status==='executed')return {ok:true,value:{executed:true,status:gate.execution.status,exitCode:gate.execution.exitCode??null,actualIdentity:gate.execution.actualIdentity??null,receiptId:gate.execution.id,effectHash:gate.execution.effectHash,replayed:true,message:'同一效果已有持久回执；按原回执返回，不重复执行。如需再次真实执行请发起新的操作调用。'},continueTurn:true};
    if(gate.status==='unknown')return {ok:false,error:{code:'EFFECT_RESULT_UNKNOWN',message:'此命令上次执行结果未知（可能已在执行中或回执前中断），不自动重放；请在待办中核对实际结果后重新申请。'},continueTurn:true};
    if(gate.status==='denied')return {ok:false,error:{code:gate.reason==='revoked'?'EFFECT_REVOKED':'PERMISSION_DENIED',message:gate.reason==='revoked'?'此命令的任务授权已被用户撤销；未来准入已关闭，不自动重试。需用户重新明确授权。':'用户已拒绝此'+(frozen.action==='admin'?'提权':'敏感')+'执行（'+frozen.command+'）；不要重试同一命令，继续原范围内其他工作或向用户说明。',requestId:gate.request?.id??null},continueTurn:true};
    if(gate.status!=='allowed')return {ok:false,error:{code:'PERMISSION_REQUIRED',message:'等待用户批准'+(frozen.action==='admin'?'提权（root/管理员）':'敏感')+'执行：'+frozen.command+' '+(frozen.args||[]).map(v=>JSON.stringify(v)).join(' ')+'（cwd: '+frozen.cwd+'）。本回合已结束；批准后宿主会自动继续原任务，无需补充输入。',requestId:gate.request.id,attention:{kind:'effect-permission',id:gate.request.id,version:gate.request.version,sourceJobId:job.id}},hostControl:true,userDecisionRequired:true};
    const request=gate.request??{id:gate.grant.requestId,permissionTaskId:gate.grant.permissionTaskId};
    return this.#effectExecute(job,request,gate.grant,frozen,String(p.callId??'')||null);
  }
  // Broker execution retains actual OS identity; policy or user admission
  // never impersonates system authentication.
  async #effectExecute(job,request,grant,frozen,operationKey=null){
    const broker=this.privilegeBroker;
    if(!broker||typeof broker.authenticate!=='function'||typeof broker.execute!=='function')return {ok:false,error:{code:'ELEVATION_UNAVAILABLE',message:'宿主未接入提权执行代理；未执行，不伪造授权。'},continueTurn:true};
    let capabilities={};
    try{capabilities=await broker.capabilities()??{};}catch{}
    if(frozen.action==='admin'&&capabilities.elevationAvailable===false)return {ok:false,error:{code:'ELEVATION_UNAVAILABLE',message:'当前系统提权不可用：'+(capabilities.reason||'未知原因')+'；未执行。'},continueTurn:true};
    const pre=await this.taskPermissions.preEffect(this.projectId,{effectHash:grant.effectHash,permissionTaskId:request.permissionTaskId,sourceJobId:job.id,grantId:grant.id,...(grant.coveredBy?{frozenEffect:frozen}:{})});
    if(!pre.ok)return {ok:false,error:{code:pre.code,message:pre.message},continueTurn:true};
    const auth=await broker.authenticate({requestId:request.id,effectHash:grant.effectHash,grantId:grant.id,generation:grant.generation,expiresAt:grant.expiresAt,elevation:frozen.action}).catch(error=>({status:'unavailable',reason:error?.message}));
    if(auth.status!=='authenticated'){
      await this.taskPermissions.recordExecution(this.projectId,{requestId:request.id,grantId:grant.id,effectHash:grant.effectHash,result:{status:['cancelled','failed'].includes(auth.status)?'auth-'+auth.status:'unavailable',...(auth.actualIdentity&&typeof auth.actualIdentity==='object'?{actualIdentity:auth.actualIdentity}:{})}}).catch(()=>{});
      return {ok:false,error:{code:auth.status==='cancelled'?'AUTH_CANCELLED':auth.status==='failed'?'AUTH_FAILED':'ELEVATION_UNAVAILABLE',message:auth.status==='cancelled'?'系统认证被取消，未执行；用户可再次处理，不自动重试。':auth.status==='failed'?'系统认证失败，未执行；不伪造提权成功。':'提权认证不可用：'+(auth.reason||capabilities.reason||'未知原因'),requestId:request.id},continueTurn:true};
    }
    // Live context re-verification after the awaited authentication.
    const recheck=await this.taskPermissions.preEffect(this.projectId,{effectHash:grant.effectHash,permissionTaskId:request.permissionTaskId,sourceJobId:job.id,grantId:grant.id,...(grant.coveredBy?{frozenEffect:frozen}:{})});
    if(!recheck.ok)return {ok:false,error:{code:recheck.code,message:recheck.message},continueTurn:true};
    // Live cwd identity re-check: the frozen approval pins the working
    // directory's device/inode; a replaced directory never rides the grant.
    const approvedCwd=(pre.grant?.frozenEffect??frozen).cwdIdentity;
    if(approvedCwd){const liveStat=await fs.lstat(frozen.cwd).catch(()=>null);if(!liveStat||liveStat.dev!==approvedCwd.dev||liveStat.ino!==approvedCwd.ino){return {ok:false,error:{code:'EFFECT_SCOPE_CHANGED',message:'批准时的工作目录身份已变化（被替换或移除），未执行；请重新申请授权。'},continueTurn:true};}}
    // Durable execution intent BEFORE the side effect: a crash between effect
    // and receipt leaves 'started', which blocks automatic retry (unknown).
    const intent=await this.taskPermissions.recordExecution(this.projectId,{requestId:request.id,grantId:grant.id,effectHash:grant.effectHash,operationKey:pre.grant?.coveredBy?null:operationKey,result:{status:'started'}}).catch(()=>null);
    if(!intent)return {ok:false,error:{code:'EFFECT_INTENT_UNAVAILABLE',message:'执行意图未能持久化；未发射命令，请核对本地存储。'},continueTurn:true};
    if(intent.duplicate)return {ok:false,error:{code:'EFFECT_RESULT_UNKNOWN',message:'同一操作已准入或已有回执；本次不重复执行，请读取原操作结果。'},continueTurn:true};
    let result;
    try{result=await broker.execute({requestId:request.id,effectHash:grant.effectHash,grantId:grant.id,sessionId:auth.sessionId??null,frozenEffect:pre.grant?.frozenEffect??frozen});}
    catch(error){result={status:'unknown',reason:error?.message};}
    const recorded=await this.taskPermissions.recordExecution(this.projectId,{requestId:request.id,grantId:grant.id,effectHash:grant.effectHash,operationKey:intent?.execution?.operationKey??null,result:{status:['completed','failed','unknown','cancelled','unavailable'].includes(result.status)?result.status:'unknown',...(Number.isSafeInteger(result.exitCode)?{exitCode:result.exitCode}:{}),...(result.actualIdentity&&typeof result.actualIdentity==='object'?{actualIdentity:result.actualIdentity}:{}),...(typeof result.executionId==='string'?{receiptId:result.executionId}:{})}}).catch(()=>null);
    if(!recorded)return {ok:false,error:{code:'EFFECT_RECEIPT_UNAVAILABLE',message:'执行回执未能持久化；为避免重复执行，本回合不再重试，请核对实际结果。'},continueTurn:true};
    if(recorded.execution.status==='unknown')return {ok:false,error:{code:'EFFECT_RESULT_UNKNOWN',message:'执行结果未知（'+(result.reason||'代理中断')+'）；不自动重放。已在待办中标注，请核对实际效果后决定是否重新申请。',requestId:request.id},continueTurn:true};
    if(recorded.execution.status==='cancelled')return {ok:false,error:{code:'AUTH_CANCELLED',message:'系统认证或执行被取消，未完成执行。',requestId:request.id},continueTurn:true};
    if(recorded.execution.status==='unavailable')return {ok:false,error:{code:'ELEVATION_UNAVAILABLE',message:'提权执行代理不可用，未执行：'+(result.reason||''),requestId:request.id},continueTurn:true};
    if(recorded.execution.status==='failed')return {ok:false,error:{code:result.error?.code??'EFFECT_EXECUTION_FAILED',message:result.error?.message??result.reason??'执行代理拒绝或启动失败；不声称已执行命令。',requestId:request.id},continueTurn:true};
    return {ok:true,value:{executed:true,status:recorded.execution.status,exitCode:recorded.execution.exitCode??null,actualIdentity:recorded.execution.actualIdentity??null,receiptId:recorded.execution.id,effectHash:grant.effectHash,root:frozen.action==='admin'&&recorded.execution.status==='completed'&&Boolean(recorded.execution.actualIdentity&&(recorded.execution.actualIdentity.euid===0||recorded.execution.actualIdentity.uid===0||recorded.execution.actualIdentity.root===true||recorded.execution.actualIdentity.admin===true)),...(result.output?{stdout:Buffer.from(result.output.stdoutB64??'','base64').toString('utf8'),stderr:Buffer.from(result.output.stderrB64??'','base64').toString('utf8'),truncated:result.output.truncated===true}:{})},continueTurn:true};
  }
  async resolveEffectRequest({requestId,expectedVersion,action,requestKey}={}){
    if(typeof requestId!=='string'||!requestId.trim()||!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!['approve-once','approve-task','deny','cancel'].includes(action)||typeof requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(requestKey))throw Object.assign(new Error('效果授权决定的身份、版本或动作无效。'),{code:'INVALID_PAYLOAD'});
    if(!this.taskPermissions)throw Object.assign(new Error('效果授权台账未接入。'),{code:'CAPABILITY_UNAVAILABLE'});
    const request=await this.taskPermissions.effectRequest(this.projectId,requestId);
    if(!request||request.kind!=='effect')throw Object.assign(new Error('效果授权请求不存在，请刷新核对。'),{code:'STALE_ATTENTION'});
    const s=this.store.state,job=s.jobs.find(j=>j.id===request.sourceJobId);
    const goal=job&&this.frontGoal(job);
    // An approval may only grant while the source task is still current;
    // otherwise the decision closes as superseded — never a grant, never a
    // continuation for an ended task.
    const taskCurrent=Boolean(job&&job.status!=='cancelled'&&!goal?.intakeJobId);
    const decided=await this.taskPermissions.decideEffect(this.projectId,{requestId,expectedVersion,action,requestKey,binding:{sourceJobId:request.sourceJobId,taskCurrent}});
    if(decided.duplicate){
      const repair=decided.result.action.startsWith('approve')&&taskCurrent?await this.#effectContinuation(request,{grantId:decided.result.grantId,repair:true}):null;
      return {...decided.result,duplicate:true,...(repair?{jobId:repair.jobId,continued:true,repaired:repair.repaired}:{continued:false})};
    }
    let continuation=null;
    if(decided.result.action.startsWith('approve')&&taskCurrent)continuation=await this.#effectContinuation(request,{grantId:decided.result.grantId});
    this.changed();this.kick();
    return {...decided.result,...(continuation?{jobId:continuation.jobId,continued:true}:{continued:false})};
  }
  // Durable, deterministic approve-continuation: the queued job persists like
  // every other continuation; the key makes replay return the same job
  // instead of duplicating work. Only remaining steps continue — completed
  // operations are never replayed.
  async #effectContinuation(request,{grantId=null,repair=false}={}){
    const s=this.store.state,job=s.jobs.find(j=>j.id===request.sourceJobId);
    if(!job)return null;
    const frozen=request.frozenEffect;
    const text='用户已批准'+(frozen.action==='admin'?'提权（root/管理员）':'高危')+'执行：'+frozen.command+' '+(frozen.args||[]).map(v=>JSON.stringify(v)).join(' ')+'（cwd: '+frozen.cwd+'）。\n'+(request.decision?.action==='approve-task'?'仅该原任务可再次执行同一冻结效果，不覆盖其他命令、对象或目录。':'仅允许本次冻结效果一次。')+'授权可撤销、到期、任务结束或重启失效。仅继续原任务未完成部分，已完成操作不重放。';
    const key='effect-permission:'+request.id;
    const existing=s.jobs.find(j=>j.key===key);
    if(existing)return {jobId:existing.id,repaired:false};
    const type=job.target==='frontdesk'?'front':job.target==='orchestrator'?(job.type==='backstage'?'backstage':'intake'):'supplement';
    const queued=await this.store.mutate(()=>this.queueJob(job.target,type,text,{key,context:{...job.context,permissionTaskId:request.permissionTaskId??job.context?.permissionTaskId,effectRequestId:request.id,...(grantId?{effectGrantId:grantId}:{})}}));
    this.kick();
    return {jobId:queued.id,repaired:repair};
  }
  // Precise, provable worker read scope: the worktree's git common dir (for
  // worktree Git) plus an already-existing node_modules dependency directory.
  // Never the whole source root — .env/private source files stay outside these
  // mounts and the worktree baseline keeps its own exclusions.
  async workerReadableRoots(target){
    try{
      const manifest=this.execution?await this.execution.readManifest(target):null;
      if(!manifest?.commonDir)return [];
      const roots=[];
      if(await fs.realpath(manifest.commonDir)===manifest.commonDir)roots.push(manifest.commonDir);
      if(manifest.repo){
        const deps=path.join(manifest.repo,'node_modules');
        try{if(await fs.realpath(deps)===deps)roots.push(deps);}catch{}
      }
      return roots.filter(root=>root!==manifest.repo);
    }catch{return [];}
  }
  async processBackstage(){
    if(this.stopping||this.backstageFlight)return this.backstageFlight;
    this.backstageFlight=(async()=>{
      const s=this.store.state;
      const events=[];
      const permissions=await this.taskPermissions?.read(this.projectId);
      for(const request of permissions?.requests??[])if(request.status==='migrated')events.push({key:'migrated-permission:'+request.id,kind:'policy-migration',sourceJobId:request.sourceJobId,requestId:request.id,text:'旧的普通路径或命令授权已关闭；这不是用户授权，不重放原输入，核对原任务并保留进展。'});
      for(const receipt of s.receipts??[]){
        const w=s.works.find(w=>w.id===receipt.workId);
        if(s.jobs.find(job=>job.id===receipt.jobId)?.interruptionReason==='user-interrupted')continue;
        if(receipt.kind==='problem'&&w&&w.revision===receipt.revision&&!['closing','ended'].includes(w.status)&&!s.receipts.some(r=>r.workId===w.id&&r.revision===w.revision&&r.kind==='result'))events.push({key:'problem:'+receipt.objectId,kind:'problem',workId:w.id,revision:receipt.revision,objectId:receipt.objectId,sourceJobId:receipt.jobId});
      }
      for(const todo of s.todos??[]){
        const source=s.jobs.find(job=>job.id===todo.sourceJobId);
        if(source?.interruptionReason==='user-interrupted')continue;
        if(todo.status==='open'&&['routing','recovery','system'].includes(todo.kind)&&!['backstage','maintenance'].includes(source?.type))events.push({key:'todo:'+todo.id,kind:todo.kind,todoId:todo.id,sourceJobId:todo.sourceJobId,text:todo.text});
      }
      for(const [target,session] of this.sessions)for(const interaction of session.interactions??[]){
        const question=interaction.question??interaction;
        if(question.method!=='approve'){const work=s.works.find(w=>w.id===target);events.push({key:'native:'+session.viewOwnerId+':'+interaction.id,kind:'native',target,sourceJobId:this.current.get(target)?.id,...(work?{workId:work.id,revision:work.revision}:{}),interactionId:interaction.id,ownerId:session.viewOwnerId,question,capability:interaction.capability});}
      }
      if(!events.length)return;
      await this.store.mutate(()=>{
        s.backstageEvents??=[];
        for(const event of events){
          if(s.backstageEvents.some(e=>e.key===event.key))continue;
          const entry={...structuredClone(event),status:'queued',at:new Date().toISOString()};s.backstageEvents.push(entry);
          if(event.kind==='native'&&event.target==='orchestrator'){entry.status='blocked';entry.reason='主控自身原生问题待可靠信息；原会话与问题保留，未编造回答。';continue;}
          const queued=this.queueJob('orchestrator','backstage','后台事实核对，不是新业务请求或用户授权。核对原事件、已有材料和操作回执；只继续原范围内剩余可逆步骤，绝不重放已开始或未知效果。若缺少可靠业务事实，调用对应工具标记 blocked 并说明，不编造回答。问题报告使用 nozeli_problem_continue；原生问题使用 nozeli_backstage_respond。\n'+JSON.stringify(event),{key:'backstage:'+event.key,context:{backstageEventKey:event.key,...(event.kind==='problem'?{backstageProblem:{workId:event.workId,revision:event.revision,objectId:event.objectId}}:{})}});
          entry.jobId=queued.id;
        }
      });this.kick();
    })();
    try{return await this.backstageFlight;}finally{this.backstageFlight=null;}
  }
  async continueBackstageProblem(job,a){
    const binding=job.context?.backstageProblem;
    if(!binding||binding.workId!==a.workId||binding.revision!==a.revision||binding.objectId!==a.objectId)throw Error('backstage problem binding mismatch');
    const w=this.store.find(a.workId),entry=this.store.state.backstageEvents?.find(e=>e.key===job.context.backstageEventKey);
    const prior=this.store.state.jobs.find(j=>j.key==='backstage-continue:'+a.objectId);if(prior)return {accepted:true,duplicate:true,jobId:prior.id,workId:w.id};
    if(w.revision!==a.revision||['closing','ended'].includes(w.status)||this.deviationHeld(w.id))throw Error('original Work is no longer eligible');
    const source=this.store.state.jobs.find(j=>j.id===entry?.sourceJobId);
    if(source&&await this.taskPermissions?.heldFor(this.projectId,source))throw Error('original permission decision remains held');
    if(typeof a.text!=='string'||!a.text.trim()||a.text.length>16000)throw Error('remaining reversible steps required');
    const queued=await this.store.mutate(()=>{const next=this.queueJob(w.id,'supplement','后台已核对原问题。此输入不是新增用户授权或范围扩展；仅继续原任务剩余可逆步骤。已执行或效果未知的操作不得重放。\n'+a.text,{key:'backstage-continue:'+a.objectId,context:{backstageObjectId:a.objectId,sourceJobId:job.id}});if(entry){entry.status='continued';entry.continuationJobId=next.id;}return next;});this.changed();this.kick();return {accepted:true,workId:w.id,jobId:queued.id,hostControl:true};
  }
  async respondBackstage(job,a){
    const entry=this.store.state.backstageEvents?.find(e=>e.key===job.context?.backstageEventKey);if(!entry)throw Error('backstage event unavailable');
    if(a.blocked===true){await this.store.mutate(()=>{entry.status='blocked';entry.reason=String(a.reason??'缺少可靠信息，原进展保留。').slice(0,1000);});this.changed();return {blocked:true,hostControl:true};}
    if(entry.kind!=='native')throw Error('non-native event requires neutral blocked disposition');
    const session=this.sessions.get(entry.target),live=session?.interactions?.find(q=>q.id===entry.interactionId);
    if(!live||session.viewOwnerId!==entry.ownerId||(live.question??live).method==='approve')throw Error('native interaction owner changed or requires actual permission');
    if(entry.capability?.respond!==true||typeof session.respondInteraction!=='function')throw Error('native structured responder unavailable');
    const result=await session.respondInteraction(entry.interactionId,a.answer,{cancel:false});
    await this.store.mutate(()=>{entry.status='responded';entry.respondedAt=new Date().toISOString();});this.changed();return {...result,hostControl:true};
  }
  async frontdeskOperation(job,p,op){
    const sourceTarget=job.target,session=this.sessions.get(sourceTarget),s=this.store.state;
    if(typeof p.callId!=='string'||!p.callId)throw Error('document operation requires tool call identity');
    const operationId=createHash('sha256').update(s.workspaceId+job.id+p.callId).digest('hex');
    const role=['frontdesk','orchestrator'].includes(sourceTarget)?sourceTarget:'worker';
    const work=role==='worker'?this.store.find(sourceTarget):null;
    const actor={id:work?'nozeli:worker:'+work.id:'nozeli:'+role+':'+s.workspaceId,kind:work?'agent2':'agent1',name:work?.name||role,mark:work?'W':role==='frontdesk'?'F':'O',role,...(work?{workId:work.id,revision:work.revision}:{}),provider:(work?work.binding??s.bindings.worker:s.bindings[role]).provider,sessionId:session?.threadId,sessionInstance:session?.viewOwnerId,requestId:job.id,sourceJobId:job.id};
    const isActive=()=>!this.stopping&&p.admission?.cancelled!==true&&this.sessions.get(sourceTarget)===session&&this.current.get(sourceTarget)===job&&(role!=='frontdesk'||!this.transferFor(job)&&!this.frontGoal(job)?.intakeJobId&&!s.frontdeskRoutes?.some(r=>r.sourceJobId===job.id))&&(role!=='worker'||!['closing','ended'].includes(this.store.find(sourceTarget).status));
    if(!isActive())return {ok:false,error:{code:'FRONTDESK_HELD',message:'当前来源等待用户决定或已转交'},continueTurn:true};
    if(!this.frontdeskDocuments)return {ok:false,error:{code:'CAPABILITY_UNAVAILABLE',message:'项目文档操作未接入；不能声称已读取或修改'},continueTurn:true};
    // Registered targets retain host drafts/receipts; external targets use
    // instance-local receipts and bound filesystem CAS without registration.
    const cross=await this.crossProjectTarget(job,p,op);
    if(cross){
      const args=p.arguments??{};
      if(args.access!==undefined&&args.access!==null&&!['read','edit'].includes(args.access))return {ok:false,error:{code:'INVALID_PAYLOAD',message:'access 只能为 read 或 edit。'},continueTurn:true};
      const relPath=op==='apply'?(cross.external?cross.relPath:this.frontdeskDocuments.peek('apply',args)?.relPath):op==='list'||op==='search'?args.relPath??'':args.relPath;
      if(typeof relPath!=='string'||(!relPath.trim()&&!(op==='list'||op==='search')))return {ok:false,error:{code:'INVALID_PAYLOAD',message:'文件操作需要具体路径；list/search 可为空目录根。'},continueTurn:true};
    }
    this.externalDocuments??=createExternalDocuments({storage:this.store.storage,projectId:this.projectId});
    const executor=cross?.external?this.externalDocuments:this.frontdeskDocuments;
    const value=await executor({op,arguments:p.arguments,actor,operationId,isActive,...(cross?.external?{targetRoot:cross.root}:cross?{targetProjectId:cross.projectId}:{})});
    await this.store.mutate(()=>{const saved=this.store.state.jobs.find(j=>j.id===job.id);saved.frontdeskOperations??=[];const index=saved.frontdeskOperations.findIndex(r=>r.operationId===operationId),receipt={operationId,callId:p.callId,op,actor,sourceJobId:job.id,...(cross?{targetProjectId:cross.projectId}:{}),at:new Date().toISOString(),...structuredClone(value)};if(index<0)saved.frontdeskOperations.push(receipt);else if(value.ok&&!saved.frontdeskOperations[index].ok)saved.frontdeskOperations[index]=receipt;});
    if(value.ok&&['apply','create'].includes(op))this.emit('files-changed',{jobId:job.id,reason:'frontdesk-document-applied',sourceChange:!cross,...(cross?{targetProjectId:cross.projectId}:{})});
    this.changed();
    if(value.ok&&['apply','create'].includes(op)){
      // Full authorship and mapped edits stay in the durable operation record.
      // Returning the inserted/removed source again inflates every following
      // model turn without adding authority beyond this exact save receipt.
      const result=value.value??{},receipt={};
      for(const key of ['relPath','operationId','eventId','revision','digest','materialDigest','byteLength','duplicate','unchanged','rebased'])if(result[key]!==undefined)receipt[key]=result[key];
      return {ok:true,value:receipt,continueTurn:true};
    }
    return {...value,continueTurn:true};
  }
  async handoffFront(job,reason,transfer={}){
    const result=await this.store.mutate(()=>this.handoffFrontState(job,reason,transfer));this.changed();this.kick();return {...result,transferred:true};
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
        const supplement=this.queueJob('orchestrator','intake',job.text,{key:`handoff:${job.id}`,context:{frontJobId:job.id,frontGoalId:goal.id,...(transfer.authority?{handoffAuthority:transfer.authority}:{}),...(work?{workHintId:work.id}:{pendingIntakeId:original.id,softWorkHint:true}),...(question?{routingQuestionId:question.id}:{})}});
        return {accepted:true,jobId:supplement.id};
      }
      const text=transfer.text??(goal?this.frontEvidence(goal,job.text):job.text);
      const intake=this.queueJob('orchestrator','intake',text,{key:goal?`goal:${goal.id}`:`handoff:${job.id}`,context:{imageAttachments:job.context?.imageAttachments,frontJobId:job.id,handoffIntent:reason.slice(0,500),...(transfer.authority?{handoffAuthority:transfer.authority}:{}),routingQuestionId:job.context?.routingQuestionId,...(goal?{frontGoalId:goal.id}:{}),...(transfer.frontdeskRouteId?{frontdeskRouteId:transfer.frontdeskRouteId,completedOperations:transfer.completedOperations,currentSources:transfer.currentSources}:{})}});
      if(goal){goal.intakeJobId=intake.id;for(const m of this.store.state.messages)if(goal.jobIds.includes(m.jobId))m.taskRequestId=intake.id;}
      this.prepareTransfer(intake.id,goal);
      return {accepted:true,jobId:intake.id};
  }
  async convertMessage(messageId,value,{requestKey}={}){
    if(typeof value!=='string'||value.length>12000)throw Error('补充目标过长');
    const canonical=this.store.state.messages.some(m=>m.id===messageId)?null:await this.timeline.read(messageId);
    const result=await this.store.mutate(async()=>{
      const s=this.store.state,m=s.messages.find(m=>m.id===messageId)||canonical;if(!m||!['user','agent'].includes(m.speaker)||m.streaming||m.availability&&m.availability!=='available')throw Error('消息来源不存在或尚未持久化');
      const old=s.jobs.find(j=>j.key==='conversion:'+requestKey);if(old){if(old.context.sourceMessageId!==messageId||old.context.userGoal!==value)throw Error('submission key collision');return {accepted:true,jobId:old.id};}
      const sourceWork=s.works.find(w=>w.id===m.target);if(sourceWork&&!['ended','closing'].includes(sourceWork.status))return {accepted:true,jobId:sourceWork.sourceJob,workId:sourceWork.id,duplicate:true};
      const existing=s.jobs.findLast(j=>j.context?.sourceMessageId===messageId&&!j.context?.conversionSupplementOf&&(!j.routing?.workId||!['ended','closing'].includes(this.store.find(j.routing.workId).status)));
      if(existing)return this.conversionSupplement(existing,m,value,requestKey);
      const sourceJob=s.jobs.find(j=>j.id===m.jobId);let goal=s.frontGoals?.find(g=>g.id===sourceJob?.context?.frontGoalId);
      if(!goal&&sourceJob?.type==='front'&&['queued','running'].includes(sourceJob.status)){s.frontGoals??=[];goal={id:randomUUID(),rootJobId:sourceJob.id,jobIds:[sourceJob.id],reads:[],chars:0};s.frontGoals.push(goal);sourceJob.context.frontGoalId=goal.id;}
      const bound=goal?.intakeJobId&&s.jobs.find(j=>j.id===goal.intakeJobId),work=bound&&(this.intakeBoundWork(bound)||s.works.find(w=>w.sourceJob===bound.id));
      if(bound&&work?.status!=='ended'&&work?.status!=='closing')return this.conversionSupplement(bound,m,value,requestKey);
      const report=m.objectId?s.receipts.find(r=>r.objectId===m.objectId):null;const body=report?reportSemanticText(await readStoredReport(this.store,report),report.report):m.text;if(!body)throw Error('消息正文缺失');
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
  kick(){if(this.stopping||!this.started||this.store.commitUnknown)return;if(this.kicking){this.again=true;return;}this.kicking=true;queueMicrotask(async()=>{try{do{this.again=false;await this.pump();}while(this.again&&!this.stopping&&!this.store.commitUnknown);}catch(e){this.emit('diagnostic',e.message);}finally{this.kicking=false;}});}
  async pump(){
    await this.store.requireOnline();
    while(!this.stopping && this.store.used()<this.store.state.limit){
      if(!this.store.state.works.some(w=>w.status==='queued'&&!this.coldQueued?.has(w.id)))break;
      const activated=await this.store.activateNext({isEligible:w=>!this.coldQueued?.has(w.id),initialize:w=>{w.binding=structuredClone(this.store.state.bindings.worker);this.queueJob(w.id,'initial',this.initialWorkerText(w),{key:`initial:${w.id}`,context:{sourceInputJobIds:[...new Set([...(w.sourceInputJobIds||[]),...(w.inputs||[]).flatMap(i=>i.sourceInputJobIds||[i.sourceJobId])])],imageAttachments:w.imageAttachments||this.store.state.jobs.find(j=>j.id===w.sourceJob)?.context?.imageAttachments}});}});
      if(!activated)break;this.changed();
    }
    for(const job of this.store.state.jobs){if(this.stopping)break;if(job.status!=='queued'||this.restarting?.has(job.target)||this.configuring.has(job.target)||this.running.has(job.target)||this.nativeDraftTargets.has(job.target)||(this.store.state.drafts[job.target]&&job.explicitInput!==true))continue;
      if(this.current.has(job.target))continue;
      if(this.coldJobs?.has(job.id))continue;
      if(this.reclaiming.has(job.target))continue;
      if(this.processBudget&&(!this.sessions.get(job.target)||this.sessions.get(job.target).closed)&&!this.starting.has(job.target)&&!this.processBudget.available){await this.processBudget.reclaim?.(this.projectId,job.target);if(!this.processBudget.available)continue;}
      if(this.deviationHeld(job.target))continue;
      if(job.context?.pendingIntakeId&&['transferring','queued','running'].includes(this.store.state.jobs.find(j=>j.id===job.context.pendingIntakeId)?.status))continue;
      const target=job.target;const promise=this.runJob(job).catch(e=>this.emit('diagnostic',e.message)).finally(()=>{this.running.delete(target);this.current.delete(target);this.changed();this.kick();});this.running.set(target,promise);
    }
  }
  async session(target){
    await this.store.requireOnline();this.validateTarget(target);
    if(this.deviationHeld(target))return Promise.reject(Object.assign(Error('用户必须先处理任务偏离决定'),{code:'DEVIATION_HELD'}));
    if(this.stopping)return Promise.reject(new Error('host stopping'));
    if(!['frontdesk','orchestrator'].includes(target)&&['queued','closing','ended'].includes(this.store.find(target).status))return Promise.reject(new Error('work has no attachable session'));
    if(this.restarting?.has(target))return this.restarting.get(target);
    return this.startSession(target);
  }
  startSession(target,{contextClear=false}={}){
    if(this.stopping)return Promise.reject(Object.assign(Error('项目正在停用'),{code:'PROJECT_STOPPING'}));
    if(this.store.commitUnknown)return Promise.reject(Object.assign(Error('存储提交结果待核查，未启动会话。'),{code:'STORAGE_RESULT_UNKNOWN'}));
    this.store.storage.assertActive(this.projectId);
    if(!contextClear)this.assertFrontdeskContextAdmission(target);
    if(this.reclaiming.has(target))return this.reclaiming.get(target).then(()=>this.startSession(target));
    if(this.deviationHeld(target))return Promise.reject(Object.assign(Error('用户必须先处理任务偏离决定'),{code:'DEVIATION_HELD'}));
    if((this.handoffPreparing?.size||this.handoffConfirmations?.size)&&!this.handoffAdmitting?.has(target))return Promise.reject(this.residentHandoffError('PI_HANDOFF_BUSY',target,'resident handoff operation in progress'));
    if(this.getResidentHandoff(target)&&!this.handoffAdmitting?.has(target))return Promise.reject(this.residentHandoffError('PI_HANDOFF_CONFIRMATION_REQUIRED',target,'explicit resident handoff confirmation required'));
    if(this.starting.has(target))return this.starting.get(target);
    const existing=this.sessions.get(target);if(existing&&!existing.closed)return Promise.resolve(existing);
    const promise=(async()=>{if(existing){const receipt=await existing.stop();await existing.controllerExitCleanup;if(receipt?.confirmationComplete===false&&existing.pid)throw new Error('old native owner exit unconfirmed');if(this.sessions.get(target)===existing)this.sessions.delete(target);}return this.makeSession(target);})().finally(()=>{if(this.starting.get(target)===promise)this.starting.delete(target);});
    this.starting.set(target,promise);return promise;
  }
  restart(target){
    this.validateTarget(target);
    this.assertFrontdeskContextAdmission(target);
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
  assertFrontdeskContextAdmission(target){
    if(target==='frontdesk'&&(this.frontdeskContextClear||this.frontdeskContextClearFailed))throw Object.assign(Error('前台上下文正在清除或清除未完成，请重试清除；输入未接收'),{code:'FRONTDESK_CONTEXT_CLEAR_BUSY'});
  }
  assertFrontdeskContextClearSafe({clearing=false}={}){
    const target='frontdesk',session=this.sessions.get(target);
    if(this.modelDefaultsApplying||session?.pendingModel)throw Object.assign(Error('前台模型配置尚未完成'),{code:'FRONTDESK_CONTEXT_CLEAR_BUSY'});
    const busy=this.stopping||(!clearing&&this.configuring.has(target))||this.restarting?.has(target)||this.starting.has(target)||this.reclaiming.has(target)||this.handoffPreparing?.size||this.residentHandoffs?.size||this.handoffConfirmations?.size||this.running.has(target)||this.current.has(target)||this.externalTerminalTargets.has(target)||this.nativeDraftTargets.has(target)||this.store.state.jobs.some(j=>j.target===target&&(!['completed','cancelled'].includes(j.status)&&j.manual===true||['queued','running','transferring'].includes(j.status)))||session&&(session.busy||session.currentTicket||session.blockedTicket||session.unsettledPromptError||session.inFlightToolCalls?.size||session.sideEffectFacts?.length||session.phase?.includes('unsettled')||session.phase?.includes('unresolved'));
    if(busy)throw Object.assign(Error('前台有输入、工具、终端租约或配置操作尚未完成；上下文未清除'),{code:'FRONTDESK_CONTEXT_CLEAR_BUSY'});
    if(this.store.state.bindings.frontdesk?.provider!=='pi')throw Object.assign(Error('只能清除 Pi 前台上下文'),{code:'FRONTDESK_CONTEXT_CLEAR_UNAVAILABLE'});
  }
  clearFrontdeskContext(){
    if(this.frontdeskContextClear)return Promise.reject(Object.assign(Error('前台上下文正在清除'),{code:'FRONTDESK_CONTEXT_CLEAR_BUSY'}));
    try{this.assertFrontdeskContextClearSafe();}catch(error){return Promise.reject(error);}
    this.configuring.add('frontdesk');
    // Fence admissions synchronously, then drain earlier store transactions before
    // checking idleness. Nothing already accepted may be discarded by this cut.
    const operation=Promise.resolve().then(async()=>{
      await this.store.serial;
      const old=this.sessions.get('frontdesk');
      await old?.refreshNativeDraft?.();this.assertFrontdeskContextClearSafe({clearing:true});
      const previous=structuredClone(this.store.state.residents.frontdesk??{}),oldThreadId=previous.threadId??old?.threadId??null;
      const sessionFile=old?.sessionFile??null;   // Pi 会话文件由 owner 元数据绑定，归档只读保留
      this.frontdeskContextClearFailed=true;
      await this.terminals.get('frontdesk')?.close();
      if(old){
        const receipt=await old.stop();await old.controllerExitCleanup;
        if((old.pid||old.groupRecord?.pid)&&receipt?.confirmationComplete!==true)throw Object.assign(Error('原前台进程退出未确认，保留原上下文'),{code:'PI_EXIT_UNCONFIRMED'});
        if(this.sessions.get('frontdesk')===old)this.sessions.delete('frontdesk');
      }
      await this.timeline.drain();
      if(this.stopping)throw Error('host stopping');
      const archiveId=randomUUID(),at=new Date().toISOString();
      // The archive and epoch commit atomically before any fresh owner starts.
      // Failure leaves the old durable identity intact, never deletes its log.
      await this.store.mutate(()=>{
        if((this.store.state.residents.frontdesk?.threadId??null)!==(previous.threadId??null))throw Error('Frontdesk identity changed during context clear');
        const slot=(this.store.state.residentArchive??={}).frontdesk??={};slot.handoffs??=[];
        slot.handoffs.push({...previous,id:archiveId,role:'frontdesk',oldThreadId,sessionFile,archivedAt:at,reason:'user-frontdesk-context-clear'});
        this.store.state.frontdeskContextEpoch={archiveId,at,sequence:this.store.state.sessionIndex?.sequence??0,messageId:this.timeline.messages().at(-1)?.id??null,jobId:this.store.state.jobs.at(-1)?.id??null,jobCount:this.store.state.jobs.length};
        this.store.state.residents.frontdesk={provider:'pi',generation:(previous.generation??0)+1,zeroActivity:true,contextClear:{archiveId,oldThreadId,at,status:'archived'}};
        delete this.store.state.providers.frontdesk;
      });
      const session=await this.startSession('frontdesk',{contextClear:true});
      this.frontdeskContextClearFailed=false;
      this.started=true;
      return {cleared:true,oldThreadId,threadId:session.threadId,archiveId};
    }).finally(()=>{if(this.frontdeskContextClear===operation)this.frontdeskContextClear=null;this.configuring.delete('frontdesk');this.changed();});
    this.frontdeskContextClear=operation;this.changed();return operation;
  }
  async recoverWorkerContext(id,{revision,oldThreadId,confirmed}={}){
    if(confirmed!==true)throw Error('Explicit confirmation of a new native conversation is required');
    this.assertDeviationReleased(id);
    const w=this.store.find(id);if(w.contextHandoff?.oldThreadId===oldThreadId&&w.contextHandoff.revision===revision)return {accepted:true,duplicate:true,workId:id,archiveId:w.contextHandoff.archiveId,sameWork:true,sameWorktree:true,newConversation:true,automaticReplay:false,requiresExplicitInput:true};
    if(this.stopping||!['paused','review'].includes(w.status)||w.revision!==revision||w.threadId!==oldThreadId||!w.contextRecovery)throw Error('Worker context recovery is stale or unavailable');
    if(this.configuring.has(id)||this.running.has(id)||this.starting.has(id)||this.restarting?.has(id)||this.current.has(id)||this.store.state.jobs.some(j=>(j.target===id||j.context?.boundWorkId===id)&&['queued','running','transferring'].includes(j.status)))throw Error('Stop accepted Worker activity before context handoff; inputs will not be replayed');
    this.configuring.add(id);
    try{
      await this.terminals.get(id)?.close();const session=this.sessions.get(id);if(session){if(session.busy||session.currentTicket||session.blockedTicket||session.inFlightToolCalls?.size)throw Error('Native Worker activity must settle before schema handoff');const receipt=await session.stop();await session.controllerExitCleanup;if(session.pid&&receipt?.confirmationComplete!==true)throw Error('Worker exit unconfirmed');this.sessions.delete(id);}
      const archiveId=randomUUID(),at=new Date().toISOString();
      const dossier={schema:1,workId:id,archiveId,revision,oldThreadId,request:w.request,brief:w.brief,inputs:structuredClone(w.inputs||[]),jobs:this.store.state.jobs.filter(j=>j.target===id||j.context?.boundWorkId===id).map(j=>({id:j.id,text:j.text,type:j.type,status:j.status,revision:j.revision})),reports:structuredClone(this.store.state.receipts.filter(r=>r.workId===id)),messages:this.store.state.messages.filter(m=>m.target===id).map(m=>({id:m.id,text:m.text,speaker:m.speaker,objectId:m.objectId,objectDigest:m.objectDigest})),source:`project.sqlite#managed_works:${id}`,at};
      const archiveBytes=Buffer.from(JSON.stringify(dossier)),objectId=await this.store.putObject(archiveBytes);
      await this.store.mutate(()=>{
        if(w.threadId!==oldThreadId||w.revision!==revision||!w.contextRecovery||this.store.state.jobs.some(j=>(j.target===id||j.context?.boundWorkId===id)&&['queued','running','transferring'].includes(j.status)))throw Error('Worker context changed during confirmation');
        w.threadArchive??=[];w.threadArchive.push({id:archiveId,threadId:oldThreadId,provider:w.binding?.provider,revision,toolsDigest:w.toolsDigest||null,sessionFile:w.contextRecovery.sessionFile||null,dossierObjectId:objectId,dossierDigest:objectId,at,reason:'user-confirmed-tool-schema-handoff'});
        w.archives??=[];w.archives.push({id:archiveId,dossierObjectId:objectId,revision,at});
        if(w.binding?.provider!=='pi'){w.binding=structuredClone(this.store.state.bindings.worker);delete w.readOnly;}
        w.contextHandoff={archiveId,dossierObjectId:objectId,dossierDigest:objectId,oldThreadId,revision,at};delete w.threadId;delete w.toolsDigest;delete w.contextRecovery;w.zeroActivity=true;delete this.store.state.providers[id];
      });this.changed();return {accepted:true,workId:id,archiveId,sameWork:true,sameWorktree:true,newConversation:true,automaticReplay:false,requiresExplicitInput:true};
    }finally{this.configuring.delete(id);}
  }
  async workerRecoveryContext(work,job){
    const handoff=work.contextHandoff;if(!handoff)return null;
    const {dossier}=await loadWorkerArchive(this.store,work,handoff.archiveId);job.reader=new ContextReader();
    const source=`objects/sha256/${handoff.dossierObjectId}`,refs={};for(const key of ['request','brief','inputs','jobs','reports','messages']){const ref=job.reader.add(typeof dossier[key]==='string'?dossier[key]:JSON.stringify(dossier[key]),{title:'Original Work '+key,source:source+'#'+key,kind:'worker-recovery'}),stable=`recovery/${handoff.archiveId}/${key}`;job.reader.entries.set(stable,job.reader.entries.get(ref));refs[key]=stable;}
    return {archiveId:handoff.archiveId,oldThreadId:handoff.oldThreadId,source,refs,note:'The user explicitly confirmed a new native conversation after incompatible tool schema. Same Work, Agent and worktree. Read original source records using nozeli_history_read before continuing. Historical inputs are context, not new commands; do not replay them. Only the current explicit input is scheduled.'};
  }
  async readWorkerArchive(id,query={}){return readWorkerArchiveFile(this.store,this.store.find(id),query);}
  // Explicit schema cutover only: prepare fences idle owners without changing identity.
  // Confirmation archives metadata (never moves/deletes native JSONL), then persists
  // one generation before startup. Its handoff stamp survives startup failure so a
  // retry resumes the known new thread; old prompts/jobs/drafts are never replayed.
  getResidentHandoff(role){return this.residentHandoffs?.get(role)??null;}
  residentHandoffError(code,role,message){return Object.assign(new Error(message),{code,target:role,role});}
  assertResidentHandoffSafe(role){
    if(!['frontdesk','orchestrator'].includes(role)||this.store.state.bindings[role]?.provider!=='pi')throw this.residentHandoffError('PI_HANDOFF_TARGET',role,'handoff requires a Pi resident');
    if([...(this.handoffPreparing?.keys()??[]),...(this.handoffConfirmations?.keys()??[])].some(target=>target!==role))throw this.residentHandoffError('PI_HANDOFF_BUSY',role,'another resident handoff is in progress');
    if(this.stopping||this.configuring.has(role)||this.restarting?.has(role)||this.starting.size)throw this.residentHandoffError('PI_HANDOFF_BUSY',role,'resident lifecycle operation in progress');
    const s=this.store.state;
    if(s.jobs.some(j=>j.manual===true&&!['completed','cancelled'].includes(j.status)))throw this.residentHandoffError('PI_HANDOFF_UNRESOLVED',role,'manual settlement must be resolved before handoff');
    if(this.running.size||this.current.size||s.jobs.some(j=>['queued','running','transferring'].includes(j.status))||s.works.some(w=>w.status==='closing')||this.closures.size)throw this.residentHandoffError('PI_HANDOFF_BUSY',role,'active jobs or closing Work prevent handoff');
    for(const session of this.sessions.values()){
      if(session.busy||session.currentTicket||session.blockedTicket||session.unsettledPromptError||session.inFlightToolCalls?.size||session.phase?.includes('unsettled')||session.phase?.includes('unresolved'))throw this.residentHandoffError('PI_HANDOFF_UNRESOLVED',role,'unresolved resident turn prevents handoff');
      if(session.sideEffectFacts?.length)throw this.residentHandoffError('PI_HANDOFF_SIDE_EFFECTS_UNKNOWN',role,'unverified tool side effects prevent handoff');
    }
    if(this.residentHandoffFailures?.get(role)?.unsafe)throw this.residentHandoffError('PI_HANDOFF_SIDE_EFFECTS_UNKNOWN',role,'unverified tool side effects prevent handoff');
  }
  async stopResidentHandoffOwners(role){
    for(const target of ['frontdesk','orchestrator']){
      const owner=this.sessions.get(target);await this.terminals.get(target)?.close();
      if(owner){const receipt=await owner.stop();await owner.controllerExitCleanup;if(owner.pid&&receipt?.confirmationComplete!==true)throw this.residentHandoffError('PI_EXIT_UNCONFIRMED',role,'old native owner exit unconfirmed');if(this.sessions.get(target)===owner)this.sessions.delete(target);}
    }
    await this.store.mutate(()=>{for(const target of ['frontdesk','orchestrator'])delete this.store.state.providers[target];});
  }
  prepareResidentHandoff(role){
    this.handoffPreparing??=new Map();if(this.handoffPreparing.has(role))return this.handoffPreparing.get(role);
    const promise=(async()=>{
      this.assertResidentHandoffSafe(role);
      const existing=this.getResidentHandoff(role);if(existing)return existing;
      const failure=this.residentHandoffFailures?.get(role),resident=this.store.state.residents[role];
      if(!failure||!resident?.threadId||resident.threadId!==failure.oldThreadId)throw this.residentHandoffError('PI_HANDOFF_NOT_REQUIRED',role,'no schema mismatch awaiting explicit handoff');
      await this.stopResidentHandoffOwners(role);this.assertResidentHandoffSafe(role);
      const challenge=Object.freeze({role,oldThreadId:resident.threadId,expectedToolsDigest:failure.expectedToolsDigest,newToolsDigest:failure.newToolsDigest,token:randomUUID(),reason:'PI_TOOLS_DIGEST_MISMATCH'});
      this.residentHandoffs??=new Map();this.residentHandoffs.set(role,challenge);this.changed();return challenge;
    })().finally(()=>{if(this.handoffPreparing.get(role)===promise)this.handoffPreparing.delete(role);});
    this.handoffPreparing.set(role,promise);return promise;
  }
  confirmResidentHandoff({role,token,oldThreadId}={}){
    const challenge=this.getResidentHandoff(role),previousHandoff=this.store.state.residents[role]?.handoff;
    const saved=previousHandoff?.token===token&&previousHandoff?.oldThreadId===oldThreadId?previousHandoff:null;
    if(!challenge||challenge.token!==token||challenge.oldThreadId!==oldThreadId)return Promise.reject(this.residentHandoffError('PI_HANDOFF_TOKEN_INVALID',role,'handoff confirmation does not match this resident'));
    this.handoffConfirmations??=new Map();if(this.handoffConfirmations.has(role))return this.handoffConfirmations.get(role);
    const promise=(async()=>{
      this.assertResidentHandoffSafe(role);await this.stopResidentHandoffOwners(role);this.assertResidentHandoffSafe(role);
      if(!saved){
        await this.store.mutate(()=>{
          const previous=this.store.state.residents[role];if(previous?.threadId!==oldThreadId)throw this.residentHandoffError('PI_HANDOFF_STALE',role,'resident identity changed');
          const archiveId=randomUUID(),generation=(previous.generation??0)+1;
          this.store.state.residentArchive??={};const slot=this.store.state.residentArchive[role]??={};slot.handoffs??=[];
          slot.handoffs.push({...structuredClone(previous),id:archiveId,role,oldThreadId,sessionFile:this.residentHandoffFailures.get(role).sessionFile??null,archivedAt:new Date().toISOString(),generation:previous.generation??0,reason:challenge.reason});
          this.store.state.residents[role]={provider:'pi',generation,toolsDigest:challenge.newToolsDigest,zeroActivity:true,handoff:{archiveId,token,oldThreadId,generation,status:'confirmed'}};
          this.store.state.recoveryEvents.push({at:new Date().toISOString(),type:'resident-handoff-confirmed',target:role,archiveId,oldThreadId,generation,expectedToolsDigest:challenge.expectedToolsDigest,newToolsDigest:challenge.newToolsDigest});
        });
      }
      this.handoffAdmitting??=new Set();this.handoffAdmitting.add(role);
      try{const session=await this.startSession(role);this.residentHandoffs.delete(role);this.residentHandoffFailures.delete(role);this.changed();return {confirmed:true,role,threadId:session.threadId,archiveId:this.store.state.residents[role].handoff.archiveId};}
      finally{this.handoffAdmitting.delete(role);}
    })().finally(()=>{if(this.handoffConfirmations.get(role)===promise)this.handoffConfirmations.delete(role);});
    this.handoffConfirmations.set(role,promise);return promise;
  }
  async respondInteraction(target,ownerId,interactionId,answer,{cancel=false}={}){
    const session=this.sessions.get(target);
    if(this.stopping||!ownerId||!session||session.closed||session.viewOwnerId!==ownerId||this.restarting?.has(target))throw Object.assign(Error('原生问题所属会话已替换或关闭'),{code:'INTERACTION_STALE'});
    if(typeof session.respondInteraction!=='function')throw Object.assign(Error('当前原生会话不支持结构化问题回答'),{code:'INTERACTION_CAPABILITY_UNAVAILABLE'});
    return session.respondInteraction(interactionId,answer,{cancel});
  }

  sessionOptions(target,ownerId){
    this.validateTarget(target);
    const session=this.sessions.get(target);
    if(ownerId&&session?.viewOwnerId!==ownerId)throw Object.assign(Error('原会话已变化，请重新打开控制菜单'),{code:'INTERACTION_STALE'});
    if(!session)return {available:false,target,busy:false,capabilities:{compact:false,reload:false,diagnostics:false},reason:'原会话尚未连接；查看不会启动 Agent'};
    const busy=session.busy||this.running.has(target)||this.current.has(target)||this.configuring.has(target)||this.restarting?.has(target)||false;
    return {available:!session.closed,target,ownerId:session.viewOwnerId,threadId:session.threadId,busy,capabilities:{compact:typeof session.compact==='function'&&!session.closed,reload:typeof session.reload==='function'&&!session.closed,interrupt:typeof session.interrupt==='function'&&session.busy&&!session.closed,diagnostics:true},state:{phase:session.phase,busy,jobId:this.current.get(target)?.id??null,model:session.model,effort:session.effort,hasPrompted:session.hasPrompted,exit:session.exit??null},diagnostics:String(session.diagnostics??'').slice(-16384)};
  }
  async sessionCommand(target,{ownerId,command,requestKey,jobId}){
    if(!['compact','reload','interrupt'].includes(command)||typeof requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(requestKey))throw Object.assign(Error('无效的会话操作'),{code:'INVALID_PAYLOAD'});
    const options=this.sessionOptions(target,ownerId),session=this.sessions.get(target);
    if(!ownerId||!options.available||session?.viewOwnerId!==ownerId)throw Object.assign(Error('原会话已变化或关闭'),{code:'INTERACTION_STALE'});
    this.sessionCommands??=new Map();
    const key=ownerId+':'+requestKey,previous=this.sessionCommands.get(key);
    if(previous){if(previous.command!==command||previous.jobId!==jobId)throw Object.assign(Error('会话操作请求键冲突'),{code:'INVALID_PAYLOAD'});return previous.promise;}
    if(command==='interrupt'){
      if(!jobId||this.current.get(target)?.id!==jobId||!session.busy||this.configuring.has(target)||this.restarting?.has(target))throw Object.assign(Error('原回合已变化，未中断其他回合'),{code:'INTERACTION_STALE'});
    }else if(this.stopping||options.busy||this.starting.has(target)||this.reclaiming.has(target)||this.store.state.jobs.some(job=>job.target===target&&['queued','running','transferring'].includes(job.status)))throw Object.assign(Error('原会话有执行或排队输入，未执行会话操作'),{code:'PI_BUSY'});
    if(this.stopping||typeof session[command]!=='function')throw Object.assign(Error('原会话不支持此操作'),{code:'INTERACTION_CAPABILITY_UNAVAILABLE'});
    this.configuring.add(target);this.changed();
    const record={command,jobId,promise:null,settled:false,stopConfirmed:false};
    if(command==='interrupt'){this.interruptions??=new Map();this.interruptions.set(jobId,record);}
    const operation=(async()=>{
      if(this.sessions.get(target)!==session||session.closed)throw Object.assign(Error('原会话已变化'),{code:'INTERACTION_STALE'});
      const receipt=await session[command]();
      record.stopConfirmed=command==='interrupt'&&receipt?.stopped===true;
      return {accepted:command!=='interrupt'||record.stopConfirmed,ownerId,threadId:session.threadId,command,...(jobId?{jobId}:{})};
    })().finally(()=>{record.settled=true;this.configuring.delete(target);this.changed();this.kick();});
    record.promise=operation;this.sessionCommands.set(key,record);
    if(this.sessionCommands.size>64)for(const [oldKey,old]of this.sessionCommands){if(this.sessionCommands.size<=64)break;if(old.settled)this.sessionCommands.delete(oldKey);}
    return operation;
  }
  async settleUserInterruption(job){
    const pending=this.interruptions?.get(job.id);
    if(!pending)return false;
    await pending.promise.catch(()=>{});
    if(!pending.stopConfirmed)return false;
    await this.store.mutate(()=>{
      const saved=this.store.state.jobs.find(row=>row.id===job.id);
      if(saved)Object.assign(saved,{status:'cancelled',completion:'user-interrupted',providerStatus:'cancelled',interruptionReason:'user-interrupted',finishedAt:new Date().toISOString()});
      const work=this.store.state.works.find(row=>row.id===job.target);
      if(work?.status==='running')work.status='paused';
      this.store.state.messages.push({id:randomUUID(),target:job.target,speaker:'system',text:'本轮已停止；已完成修改保留，未结束工作。排队补充保持原顺序。',jobId:job.id});
    });return true;
  }

  async readNativeDraft(target,ownerId){
    const session=this.sessions.get(target);
    if(this.stopping||!ownerId||!session||session.closed||session.viewOwnerId!==ownerId||this.restarting?.has(target))throw Object.assign(Error('原生草稿所属会话已替换或关闭'),{code:'INTERACTION_STALE'});
    if(typeof session.readNativeDraft!=='function')throw Object.assign(Error('当前原生会话不支持读取草稿'),{code:'NATIVE_DRAFT_CAPABILITY_UNAVAILABLE'});
    return session.readNativeDraft();
  }

  async replaceNativeDraft(target,ownerId,expectedText,text){
    const session=this.sessions.get(target);
    if(this.stopping||!ownerId||!session||session.closed||session.viewOwnerId!==ownerId||this.restarting?.has(target))throw Object.assign(Error('原生草稿所属会话已替换或关闭'),{code:'INTERACTION_STALE'});
    if(typeof session.replaceNativeDraft!=='function')throw Object.assign(Error('当前原生会话不支持替换草稿'),{code:'NATIVE_DRAFT_CAPABILITY_UNAVAILABLE'});
    return session.replaceNativeDraft(expectedText,text);
  }

  observeSession(target,session){
    session.viewOwnerId??=randomUUID();
    session.on?.('diagnostic',message=>{if(this.sessions.get(target)===session)this.emit('diagnostic',`${target}: ${message}`);});
    session.on?.('change',()=>{if(this.sessions.get(target)===session)this.changed();});
    session.on?.('model-changed',()=>{if(this.sessions.get(target)===session)this.changed();});
    session.on?.('interaction',()=>{if(this.sessions.get(target)===session)this.changed();});
    session.on?.('native-draft',hasText=>{
      if(this.sessions.get(target)!==session)return;
      const previous=this.nativeDraftTargets.has(target);
      if(hasText)this.nativeDraftTargets.add(target);else{this.nativeDraftTargets.delete(target);this.nativeDraftBlockedOwners?.delete(target);}
      if(previous!==hasText){this.changed();if(!hasText)this.kick();}
    });
    session.on?.('exit',exit=>{
      if(this.sessions.get(target)!==session)return;
      this.nativeDraftTargets.delete(target);this.nativeDraftBlockedOwners?.delete(target);this.emit('session-exit',{target,threadId:session.threadId,exit});this.changed();
      const cleanup=(async()=>{await session.manualOpenPromise;if(this.sessions.get(target)!==session)return;const job=this.current.get(target);if(job?.manual)await this.settleManualJob(target,{promptId:job.manualPromptId,jobId:job.id,error:`Pi owner exited (${exit?.exitCode??exit?.code??exit?.signal??'unknown'})`});let stopError,receipt;try{receipt=await session.stop();}catch(error){stopError=error;receipt=session.lastExitReceipt;}if(this.sessions.get(target)!==session){if(stopError)throw stopError;return;}if(receipt?.confirmationComplete===true){delete this.store.state.providers[target];await this.store.storage.putLocal(this.projectId,'managed:providers',this.store.state.providers??{});}this.changed();if(stopError)throw stopError;})();session.controllerExitCleanup=cleanup;void cleanup.catch(error=>this.emit('diagnostic',error.message));
    });
  }
  async makeSession(target,{preflightOnly=false}={}){
    if(this.stopping)throw Object.assign(Error('项目正在停用'),{code:'PROJECT_STOPPING'});
    await this.store.requireOnline();
    const role=['frontdesk','orchestrator'].includes(target)?target:'worker';const workerBinding=role==='worker'?(this.store.find(target).binding||this.store.state.bindings.worker):null;
    if(role==='worker')this.assertDeviationReleased(target);
    const provider=workerBinding?.provider||this.store.state.bindings[role]?.provider||'pi';
    if(provider!=='pi'){
      if(role==='worker')await this.store.mutate(()=>{const work=this.store.find(target);work.readOnly=true;work.contextRecovery={code:'HISTORICAL_SESSION_READ_ONLY',threadId:work.threadId,revision:work.revision,message:'Original provider identity retained read-only; explicit context recovery required'};});
      throw Object.assign(new Error('Historical provider sessions are read-only; their identity cannot be resumed by Pi'),{code:'HISTORICAL_SESSION_READ_ONLY',target});
    }
    const home=role==='worker'?this.store.agentHome(target):path.join(this.store.root,'agents',`resident-${role}-pi`);
    const cwd=role==='worker'&&this.execution?(await this.maintenanceTransaction(this.current.get(target),'input-preparation',()=>this.execution.prepare(target)),this.execution.directory(target)):this.store.content;
    const tools=role==='frontdesk'?[tool('nozeli_handoff','Escalate the remaining original-task work to background execution with a concise reason. Ordinary reasons dispatch straight to the background under the original user request (no extra prompt); if the user explicitly chose to stay in the frontdesk, declined background earlier, or a decision is still pending, the host asks the user instead. @read reads and @new/@continue select discussion context only. This handoff never grants cross-project access, shell or credentials.',{reason:text})]:role==='orchestrator'?[tool('nozeli_inspect_work','Read named Work or readRef. @memory:keywords searches Plan Tree; @conversation reads dialogue; @state returns open works. Read-only.',{workName:text}),tool('nozeli_dispatch','Create a named Worker for a brand-new independent task. This is the required terminal decision when an explicit user task has no matching open Work.',{name:text,brief:text}),tool('nozeli_manage','Route this intake to exactly ONE terminal decision: continue an EXISTING open Work by its exact name, or clarify genuine ambiguity. status is a read-only query — it NEVER completes an intake turn: inspect/status first if needed, then always finish the turn with continue, clarify, or nozeli_dispatch. workName must be the exact name of an existing open Work — never the current request text; with no open Work at all, a continue is treated as the first background run of this new task. Ending a background intake after only status/inspect leaves the task unexecuted and violates the contract. User end decisions belong to user controls.',{action:{type:'string',enum:['continue','status','clarify']},workName:text,text})]:[tool('nozeli_publish','Publish the final result as one complete self-contained static HTML document, or a problem/question as concise Markdown text. Include every created/modified artifact in files. For result require html and forbid text; for problem require text and forbid html. Host validates the exact kind/body pairing. Work remains open; finish the turn after success.',{kind:{type:'string',enum:['problem','result']},html:{type:'string',description:'Self-contained static HTML result document; kind "result" only'},text:{type:'string',description:'Concise Markdown problem or question body; kind "problem" only'},files:{type:'array',items:{type:'string'},maxItems:256}},['kind','files']),tool('nozeli_diagram','Render an offline validated Archify typed JSON diagram and return the exact standalone SVG with alt text, caption and spec/generator digests for direct inline figure embedding in the report HTML; creates no project files.',{type:{type:'string',enum:['architecture','workflow','sequence','dataflow','lifecycle']},spec:{type:'object',additionalProperties:true}})];
    const binding=role==='worker'?this.store.find(target).binding||this.store.state.bindings.worker:this.store.state.bindings[role];
    if(role==='orchestrator')tools.push(tool('nozeli_maintenance','Inspect sanitized host bug ledger, scan proven historical internal faults without replay, or request bounded host recovery of the exact original transaction. Never marks repaired by assertion; no business Work or privileges granted.',{action:{type:'string',enum:['status','retry','scan']},bugId:text},['action']));
    if(role==='orchestrator')tools.push(
      tool('nozeli_problem_continue','Continue the exact original Work from context.backstageProblem after inspecting its frozen problem and receipts. Supply only remaining reversible steps; never replay unknown effects or infer new authorization.',{workId:text,revision:{type:'integer',minimum:1},objectId:text,text},['workId','revision','objectId','text']),
      tool('nozeli_backstage_respond','Resolve the current host-bound backstage native question from existing evidence, or explicitly preserve neutral blocked state when facts are missing. Never answer permission approval or invent business facts.',{answer:{anyOf:[text,{type:'boolean'},{type:'object'}]},blocked:{type:'boolean'},reason:text},[]));
    if(role==='worker')tools.push(tool('nozeli_report_bug','Report a suspected Nozeli program fault for host diagnosis, not a business question. No recovery is claimed from model text; preserves original Work and never replays effects.',{code:{type:'string',enum:['WORKER_SNAPSHOT_FAILED','PUBLICATION_FAILED','HOST_INTERNAL_FAILURE','UNKNOWN_PRODUCT_BUG']}}));
    if(role==='frontdesk'||role==='orchestrator')tools.push(
      tool('nozeli_document_read','Read a UTF-8 host document and obtain a session-bound version handle. Optional projectPath selects a registered id/root or any unregistered absolute directory; absolute relPath also works. Ordinary access requires no authorization or registration. Registered targets preserve unsaved drafts. Quote replacements from returned text; apply target follows its handle.',{relPath:text,projectPath:text,access:{type:'string',enum:['read','edit']}},['relPath']),
      tool('nozeli_document_apply','Replace exact text in a document read this session. The host locates each oldText inside the read snapshot — never send offsets or line numbers. Each oldText must match exactly one place: quote more surrounding text, or add contextBefore/contextAfter (exact neighbouring text from the read) when it occurs several times. newText uses LF newlines; CRLF is normalized. Concurrent edits, unsaved user drafts and authorship stay host-protected.',{readHandle:text,replacements:{type:'array',minItems:1,maxItems:1000,items:{type:'object',properties:{oldText:text,newText:text,contextBefore:text,contextAfter:text},required:['oldText','newText'],additionalProperties:false}}},['readHandle','replacements']),
      tool('nozeli_document_create','Create a host text document without overwriting files or drafts. Optional projectPath: registered id/root or ordinary unregistered directory; absolute relPath accepted.',{relPath:text,text,projectPath:text},['relPath','text']),
      tool('nozeli_project_list','List a host directory; empty relPath is the root. Follow nextOffset. Optional projectPath accepts registered ids/roots or unregistered directories; absolute relPath accepted.',{relPath:text,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:500},projectPath:text},['relPath']),
      tool('nozeli_project_search','Search literal host text. Omit cursor initially; reuse the returned cursor unchanged. Optional projectPath accepts registered ids/roots or unregistered directories; absolute relPath accepted.',{query:text,relPath:text,projectPath:text,cursor:{anyOf:[{type:'object',properties:{scope:text,query:text,relPath:text,offset:{type:'integer',minimum:0}},required:['scope','query','relPath','offset'],additionalProperties:false},{type:'null'}]}},['query','relPath']));
    if(role==='worker'&&this.execution)tools.push(
      tool('nozeli_document_read','Read candidate text by relative path; absolute relPath or projectPath selects an ordinary external/registered live document with its own host CAS handle. External writes are direct, not candidate adoption.',{relPath:text,projectPath:text},['relPath']),
      tool('nozeli_document_apply','Apply exact-text replacements against the text returned by nozeli_document_read. The host derives positions from oldText (must match exactly one place, or be disambiguated by contextBefore/contextAfter exact neighbouring text); never send offsets. newText uses LF; CRLF is normalized. After failure re-read and reconsider or publish a problem. This write continues the turn for verification/reporting. Never overwrite a stale candidate with shell.',{readHandle:text,replacements:{type:'array',minItems:1,maxItems:1000,items:{type:'object',properties:{oldText:text,newText:text,contextBefore:text,contextAfter:text},required:['oldText','newText'],additionalProperties:false}}},['readHandle','replacements']));
    if(role==='worker')tools.push(
      tool('nozeli_document_create','Create a live host document, optional projectPath or absolute relPath; this is not a Worker candidate artifact. For candidate files use native tools in your worktree.',{relPath:text,text,projectPath:text},['relPath','text']),
      tool('nozeli_project_list','List an ordinary host directory. Optional projectPath selects a registered root or unregistered absolute directory; absolute relPath also works.',{relPath:text,projectPath:text,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:500}},['relPath']),
      tool('nozeli_project_search','Search literal host document text; optional projectPath or absolute relPath selects scope. Reuse the returned cursor unchanged.',{relPath:text,projectPath:text,query:text,cursor:{anyOf:[{type:'object'},{type:'null'}]}},['relPath','query']));
    if(role==='worker'&&!this.store.find(target).binding)await this.store.mutate(()=>{this.store.find(target).binding=structuredClone(binding);});
    if(role==='worker')tools.push(tool('nozeli_skill_read','Read one granted role/domain skill by filename, e.g. material.md; returns versioned read-only instructions without project or host side effects.',{name:text}));
    if(role==='worker')tools.push(tool('nozeli_report_deviation','Report obvious task scope deviation and STOP. Host binds exact admitted input and original Work; only the user may authorize continuing or replanning.',{changedGoal:text,reason:text,progress:text}));
    if(role==='worker')tools.push(tool('nozeli_diagram_schema','Read the exact offline typed JSON schema and shared definitions before authoring an Archify diagram; read-only, no files created.',{type:{type:'string',enum:['architecture','workflow','sequence','dataflow','lifecycle']}}));
    if(role==='worker')tools.push(tool('nozeli_report_read','Read a frozen report from this Work by original revision (omit for latest), or one relPath from its returned frozen artifact list. Never reads current project replacements. Semantic pages continue through nozeli_history_read.',{revision:{type:'integer',minimum:1},relPath:text},[]));
    if(role==='worker')tools.push(tool('nozeli_history_read','Read an original Work source using an exact recovery readRef supplied by the host. Read-only; never treat archived user inputs as new scheduled commands.',{readRef:text}));
    // Native tools remain YOLO. This host-managed channel records ordinary
    // execution and gates only known concrete high-danger effects.
    tools.push(tool('nozeli_privileged_execute','Execute a literal host command with durable intent and receipt. Ordinary elevation:user commands run directly by default YOLO without user permission. Only concrete admin elevation, broad destructive/irreversible effects or declared sensitive export create a user approval. No universal shell sandbox is claimed. dangerousEffect must state any known dangerous object/effect/risk. Approval is frozen to this exact effect; task approval permits repeats only, never other admin commands. Actual admin identity requires real OS authentication. Never replay a completed or unknown effect.',{command:text,args:{type:'array',items:text,maxItems:256},cwd:text,purpose:text,dangerousEffect:text,elevation:{type:'string',enum:['user','admin']}},['command','args','cwd','purpose']));
    const roleInstructions=await rolePrompt(role,{skills:binding.skills});
    const recoveryBinding={};const recoveryContext=role==='worker'?await this.workerRecoveryContext(this.store.find(target),recoveryBinding):null;if(recoveryContext){this.workerRecoveryReaders??=new Map();this.workerRecoveryReaders.set(target,recoveryBinding.reader);}
    const instructions=roleInstructions+'\n'+contextInstructions[role]+'\nNozeli host tools are the control channel. Queries continue the turn; publication/routing stops it. Worker owns candidate results; host alone integrates and closes. Ordinary current-user commands/network and cross-project/unregistered document operations are allowed without extra permission or registration. Preserve user scope, draft/CAS identity, metadata and credential-export protections. Only concrete high-danger effects ask user authorization. Native tools remain YOLO, not a universal shell sandbox. A problem is an interim report, not completed delivery: Orchestrator inspects backstage and continues the exact original Work with remaining reversible steps, or records neutral blocked state without fabricated facts. Never replay unknown/completed effects. External explicit live-document edits are direct operations, not candidate adoption. Do not invent no-install/no-build constraints absent from user request.'+(recoveryContext?'\nUser-confirmed context handoff sources:\n'+JSON.stringify(recoveryContext):'');
    const readableRoots=role==='worker'?await this.workerReadableRoots(target):[];
    const piRuntime=this.piRuntime?{...this.piRuntime,...(this.piSource?.agentDir?{agentDir:this.piSource.agentDir}:{}),...(this.piSource?.modelFor?{modelFor:role=>this.piSource.modelFor(role)}:{}),...(this.piSource?.roleDefaultsFor?{roleDefaultsFor:async role=>{const saved=await this.piSource.roleDefaultsFor(role);return {selector:saved?.selector??null,effort:saved?.effort??roles[role]?.effort??null};}}:{})}:null;
    const spec={...roles[role],role,provider,...(role!=='worker'?{baseInstructions:residentBaseInstructions}:{}),model:null,effort:null,cwd,home,...(piRuntime?{piRuntime}:{}),...(this.piSource?{piSystemSource:this.piSource}:{}),...(this.piAuth?{piSettingsWorker:this.piAuth}:{}),...(this.isolateProcesses?{isolation:{writable:role==='worker'?[cwd]:[],readOnly:role==='worker'?[path.join(cwd,'.git')]:[],readable:readableRoots}}:{}),instructions,tools,finishOnHostControl:true,
      nativeContext:{projectId:this.projectId,targetId:target,ownerId:randomUUID()},
      onTransportFact:fact=>this.recordTransport(target,fact),
      onNativeEntry:fact=>this.recordNativeEntries(target,fact),
      onNativeEvent:fact=>this.recordNativeEvent(target,fact),
      // Pi：宿主工具副作用前必须过 admission.preEffect（owner/turn 代次门），失败即拒绝该次副作用。
      onTool:async p=>{await p.admission?.preEffect();return this.onTool(target,p);},
      onBeforeAgentStart:async()=>{await this.store.requireOnline();if(this.stopping)throw Error('host stopping');this.assertDeviationReleased(target);const active=this.current.get(target);if(!active)throw Error('no admitted host job');if(role!=='worker')return {};const w=this.store.find(target);if(w.status!=='running'||active.revision!==w.revision)throw Error('stale Worker turn');active.reader??=new ContextReader();return {taskAnchor:workerTaskAnchor(w,active.reader)};},
      onSpawn:async pid=>{const stamp=await processStamp(pid);await this.store.mutate(()=>{this.store.state.providers[target]={pid,stamp,home,kind:'pi-node',ownerId:spec.nativeContext.ownerId};});}};
    // Pi 路线（host cutover）：角色会话 = host-owned Pi owner（PiSession，唯一进程/session owner）。
    // 模型/effort 由 Pi 会话独占，宿主只观察；同一角色不双 owner。
    let slot;if(this.processBudget){if(!this.processBudget.available&&!(target==='frontdesk'&&this.frontdeskContextClear))await this.processBudget.reclaim?.(this.projectId,preflightOnly?null:target);slot=this.processBudget.reserve(this.projectId,target);}
    let ownership;const originalSpawn=spec.onSpawn;spec.onSpawn=async pid=>{ownership?.spawned();return originalSpawn(pid);};
    let session;try{session=this.sessionFactory?this.sessionFactory(spec,target):new PiSession(spec);}catch(error){this.processBudget?.release(slot);throw error;}
    if(slot)ownership=this.processBudget.bind(slot,session);
    if(!preflightOnly){this.sessions.set(target,session);this.observeSession(target,session);}
    const toolsDigest=session.toolsDigest??createHash('sha256').update(JSON.stringify(tools)).digest('hex'),resident=this.store.state.residents[target];
    try{
      let resumeId=role==='worker'?this.store.find(target).threadId:resident?.threadId;
      const workOwner=role==='worker'?this.store.find(target):null;
      const workerHistory=Boolean(workOwner?.threadId&&workOwner.zeroActivity!==true);
      const workerExpected=workOwner?.toolsDigest;
      if(workerHistory){
        if(typeof session.preflightToolsDigest!=='function')throw Object.assign(Error('Worker historical schema preflight unavailable; original thread retained'),{code:'WORKER_CONTEXT_RECOVERY_REQUIRED',target});
        await session.preflightToolsDigest(workerExpected||toolsDigest);
      }
      // Reject non-equivalent historical schemas before the Pi owner can append
      // lifecycle records to the original read-only conversation journal.
      if(role!=='worker'&&resumeId&&resident?.toolsDigest){
        if(typeof session.preflightToolsDigest!=='function')throw Object.assign(new Error('Pi historical schema preflight unavailable'),{code:'PI_TOOLS_DIGEST_MISMATCH'});
        try{await session.preflightToolsDigest(resident.toolsDigest);}
        catch(error){
          const attempted=this.store.state.jobs.some(j=>j.target===target&&(j.manual===true||j.promptStartedAt!=null));
          const messages=this.store.state.messages.some(m=>m.target===target);
          let empty=resident.zeroActivity===true&&!attempted&&!messages&&!resident.handoff&&typeof session.sessionFile==='string';
          if(empty){
            try{
              const stat=await fs.lstat(session.sessionFile);
              if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)empty=false;
              else for(const line of (await fs.readFile(session.sessionFile,'utf8')).split('\n')){
                if(!line.trim())continue;
                if(!['session','model_change','thinking_level_change','session_info','title'].includes(JSON.parse(line).type)){empty=false;break;}
              }
            }catch(error){if(error.code!=='ENOENT')empty=false;}
          }
          if(error.code!=='PI_TOOLS_DIGEST_MISMATCH'||!empty)throw error;
          // No accepted input or native message exists. Keep the old identity as
          // startup metadata, never manufacture conversation history or replay.
          if(!preflightOnly){
            await this.store.mutate(()=>{
              this.store.state.recoveryEvents.push({at:new Date().toISOString(),type:'pi-empty-schema-updated',target,previousThreadId:resident.threadId,previousToolsDigest:resident.toolsDigest,newToolsDigest:toolsDigest});
              this.store.state.residents[target]={...resident,threadId:undefined,toolsDigest:undefined};
            });
          }
          resumeId=undefined;session.emptySchemaUpdated=true;
        }
      }
      if(preflightOnly){if(!session.pid&&!session.groupRecord?.pid&&!ownership?.hasSpawned())this.processBudget?.release(slot);else await session.stop();return {preflight:true,target};}
      if(this.stopping)throw Object.assign(Error('项目正在停用'),{code:'PROJECT_STOPPING'});
      await this.store.requireOnline();
      try{await session.start(resumeId);}catch(error){
        // 已派工/已发 prompt 的历史不可当空会话：promptStartedAt!=null 即有历史（含 cancelled——取消不消除已发 prompt/副作用）。
        const attempted=this.store.state.jobs.some(j=>j.target===target&&j.promptStartedAt!==null&&(!j.threadId||j.threadId===resumeId));
        const uncreatedHandoff=resumeId&&resident?.handoff&&['start-failed','confirmed','ready'].includes(resident.handoff.status)&&!this.store.state.jobs.some(job=>job.threadId===resumeId)&&!this.store.state.messages.some(message=>message.sessionId===resumeId);
        // 仅检查当前线程；缺少线程归属的旧任务仍保守阻止恢复。不伪造会话/不重放；
        // 新建 Pi owner 实例，恢复后走同一持久化路径。
        const missing=error.code==='PI_SESSION_FILE_NOT_FOUND'&&resumeId&&!resident?.handoff&&(role==='worker'?this.store.find(target).zeroActivity:resident?.zeroActivity)===true&&!attempted;
        const uncreated=error.code==='PI_SESSION_FILE_NOT_FOUND'&&uncreatedHandoff;
        if(missing||uncreated){
          await this.store.mutate(()=>{this.store.state.recoveryEvents.push({at:new Date().toISOString(),type:uncreated?'resident-handoff-uncreated-thread-retried':'pi-zero-activity-restarted',target,previousThreadId:resumeId});if(uncreated){delete resident.threadId;resident.handoff.status='confirmed';}});
          const stopped=await session.stop();if(session.pid&&stopped?.confirmationComplete!==true)throw Object.assign(error,{exitUnconfirmed:true});
          if(this.processBudget){slot=this.processBudget.reserve(this.projectId,target);}
          try{session=this.sessionFactory?this.sessionFactory(spec,target):new PiSession(spec);}catch(error){this.processBudget?.release(slot);throw error;}
          if(slot)ownership=this.processBudget.bind(slot,session);
          this.sessions.set(target,session);
          this.observeSession(target,session);
          if(this.stopping)throw Object.assign(Error('项目正在停用'),{code:'PROJECT_STOPPING'});
          await this.store.requireOnline();
          await session.start();
          session.zeroActivityRestarted=true;
        }else throw error;   // Pi 任何其他恢复失败（有历史/未知/非缺失）不回退不重建
      }
      if(role!=='worker'&&resident?.threadId&&resident?.toolsDigest&&!session.emptySchemaUpdated){
        if(typeof session.assertToolsDigest!=='function')throw Object.assign(new Error('Pi historical schema equivalence cannot be established'),{code:'PI_TOOLS_DIGEST_MISMATCH'});
        await session.assertToolsDigest(resident.toolsDigest);
      }
      if(workerHistory)await session.assertToolsDigest(workerExpected||toolsDigest);
      await this.store.mutate(()=>{
        if(role==='worker'){const work=this.store.find(target);work.threadId=session.threadId;work.toolsDigest=session.toolsDigest??toolsDigest;if(work.zeroActivity!==false)work.zeroActivity=!session.hasPrompted&&!(session.agentEnds?.length>0);}
        else this.store.state.residents[target]={threadId:session.threadId,provider,model:session.model??spec.model??null,effort:session.effort??spec.effort??null,toolsDigest:session.toolsDigest??toolsDigest,zeroActivity:!session.hasPrompted&&!(session.agentEnds?.length>0),...(resident?.zeroActivity===false?{zeroActivity:false}:{}),...(resident?.generation!=null?{generation:resident.generation}:{}),...(resident?.handoff?{handoff:{...resident.handoff,status:'ready'}}:{})};
        if(role==='frontdesk'&&resident?.contextClear)this.store.state.residents[target].contextClear={...resident.contextClear,status:'ready'};
      ownership?.started();
      });this.changed();return session;
    }catch(e){
      e.target??=target;e.role??=role;
      if(role==='worker'&&['WORKER_CONTEXT_RECOVERY_REQUIRED','PI_TOOLS_DIGEST_MISMATCH','PI_SESSION_FILE_NOT_FOUND','PI_SESSION_IDENTITY'].includes(e.code)){
        await this.store.mutate(()=>{const work=this.store.find(target);work.contextRecovery={threadId:work.threadId,revision:work.revision,code:e.code,message:e.message,expectedToolsDigest:work.toolsDigest||null,newToolsDigest:session.toolsDigest??toolsDigest,sessionFile:session.sessionFile||null};});this.changed();
      }
      if(e.code==='PI_TOOLS_DIGEST_MISMATCH'&&role!=='worker'&&resident?.threadId){
        Object.assign(e,{target,role,expectedToolsDigest:resident.toolsDigest,newToolsDigest:session.toolsDigest??toolsDigest,actualToolsDigest:session.toolsDigest??toolsDigest});
        this.residentHandoffFailures??=new Map();this.residentHandoffFailures.set(target,{...e,oldThreadId:resident.threadId,sessionFile:session.sessionFile??null,unsafe:Boolean(session.busy||session.currentTicket||session.blockedTicket||session.inFlightToolCalls?.size||session.sideEffectFacts?.length)});
      }
      if(preflightOnly){try{if(!session.pid&&!session.groupRecord?.pid&&!ownership?.hasSpawned())this.processBudget?.release(slot);else await session.stop();}catch(cleanupError){e.cleanupError=cleanupError;}throw e;}
      const receipt=await session.stop();await session.controllerExitCleanup;
      if(role!=='worker'&&resident?.handoff&&session.threadId)await this.store.mutate(()=>{Object.assign(this.store.state.residents[target],{threadId:session.threadId,handoff:{...resident.handoff,status:'start-failed'}});});
      if(role==='frontdesk'&&resident?.contextClear&&session.threadId)await this.store.mutate(()=>{Object.assign(this.store.state.residents[target],{threadId:session.threadId,contextClear:{...resident.contextClear,status:'start-failed'}});});
      if(session.pid&&receipt?.confirmationComplete!==true)throw Object.assign(e,{exitUnconfirmed:true});
      if(this.sessions.get(target)===session)this.sessions.delete(target);await this.store.mutate(()=>{delete this.store.state.providers[target];});throw e;
    }
  }
  // 人工回合收尾（历史 TUI 人工输入链的 durable 结算面；Pi 输入一律经 runJob）。
  async settleManualJob(target,{promptId,jobId,text,error,effective}){
    const job=this.store.state.jobs.find(j=>j.id===jobId&&j.manualPromptId===promptId&&j.target===target);
    if(!job||job.status!=='running'||this.current.get(target)?.id!==job.id)return;
    await this.store.mutateNative(()=>{
      const index=this.store.state.sessionIndex??={};index.nativeSettlements??={};
      const prior=index.nativeSettlements[job.id];if(prior&&(prior.promptId!==promptId||prior.target!==target))throw Error('Native settlement identity changed');
      index.nativeSettlements[job.id]={jobId:job.id,promptId,target,status:error?'failed':'completed',text:text??'',error:error?String(error):null,effective:effective?structuredClone(effective):null,at:prior?.at??new Date().toISOString(),automaticReplay:false};
    });
    let projectionPending;
    try{
    if(effective)await this.store.mutate(()=>{const saved=this.store.state.jobs.find(j=>j.id===job.id);if(!saved.effective)saved.effective=structuredClone(effective);});
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
    }catch(failure){
      if(!failure.pendingId||failure.recoveryFailure)throw failure;
      projectionPending={pendingId:failure.pendingId,code:failure.code,message:failure.message};
      await this.store.mutateNative(()=>{this.store.state.sessionIndex.nativeSettlements[job.id].projectionPending=projectionPending;});
      this.emit('diagnostic','Native turn is durably settled; business projection retained for explicit recovery: '+failure.message);
    }
    if(!['frontdesk','orchestrator'].includes(target)&&this.store.find(target).deviation?.admittedJobId===job.id)await this.stopDeviationOwner(target);
    if(this.current.get(target)?.id===job.id)this.current.delete(target);
    this.changed();this.kick();
    return projectionPending?{settlementPending:true,automaticReplay:false,...projectionPending}:{settled:true};
  }
  async onTool(target,p){
    try{return await this.handleTool(target,p);}catch(error){
      if(maintenanceBoundary(error)||!/^INTERNAL_|^HOST_INTERNAL_/.test(String(error.code??'')))throw error;
      const job=this.current.get(target);if(!job||job.type==='maintenance')throw error;
      const bug=await this.maintenance.record({phase:'tool',jobId:job.id,workId:['frontdesk','orchestrator'].includes(target)?null:target,revision:job.revision??null,error});await this.maintenance.finish(bug.id,{outcome:'needs-version-fix'});
      await this.store.mutate(()=>{const saved=this.store.state.jobs.find(j=>j.id===job.id);if(saved)saved.maintenanceBugId=bug.id;const w=this.store.state.works.find(w=>w.id===target);if(w?.status==='running'){w.status='paused';w.maintenance={bugId:bug.id,status:'needs-version-fix',message:'系统工具故障待后台诊断，原任务与改动保留。'};}});await this.maintenanceEvent(bug);return {hostControl:true,maintenance:true,bugId:bug.id,workRemainsOpen:true};
    }
  }
  async handleTool(target,p){
    const job=this.current.get(target);if(!job)throw new Error('no active host job');
    if(job.type==='intake'&&['closing','ended'].includes(this.intakeBoundWork(job)?.status)&&['nozeli_dispatch','nozeli_manage'].includes(p.tool))return {cancelled:true,userEnded:true,message:'原工作已由用户结束，不再处理补充。'};
    if(this.stopping||(!['frontdesk','orchestrator'].includes(target)&&['closing','ended'].includes(this.store.find(target).status)))throw new Error('host or work closing');
    await this.store.requireOnline();
    if(this.stopping)throw Object.assign(Error('项目正在停用'),{code:'PROJECT_STOPPING'});
    const a=p.arguments;
    if(target==='orchestrator'&&p.tool==='nozeli_problem_continue')return this.continueBackstageProblem(job,a);
    if(target==='orchestrator'&&p.tool==='nozeli_backstage_respond')return this.respondBackstage(job,a);
    if(p.tool==='nozeli_report_bug'&&maintenanceBoundary({code:a.code}))return {ok:false,continueTurn:true,error:{code:'MAINTENANCE_HUMAN_BOUNDARY',message:'权限、冲突或未知效果不属于静默维修；保留原生决定与待办。'}};
    if(p.tool==='nozeli_report_bug'&&!['WORKER_SNAPSHOT_FAILED','PUBLICATION_FAILED','HOST_INTERNAL_FAILURE','UNKNOWN_PRODUCT_BUG'].includes(a.code))return {ok:false,continueTurn:true,error:{code:'INVALID_BUG_CATEGORY',message:'仅使用程序故障类别，不提交凭据、命令或用户全文。'}};
    if(target==='orchestrator'&&p.tool==='nozeli_maintenance'){if(a.action==='status')return {...await this.maintenanceStatus(),readOnly:true,continueTurn:true};if(a.action==='scan')return {...await this.maintenanceScan(),continueTurn:true};if(a.action==='retry')return {...await this.maintenanceRetry(a.bugId),continueTurn:true};throw Error('invalid maintenance action');}
    if(p.tool==='nozeli_report_bug'&&!['frontdesk','orchestrator'].includes(target)){const bug=await this.maintenance.record({phase:'diagnosis',jobId:job.id,workId:target,revision:job.revision,error:{code:a.code}});await this.maintenance.finish(bug.id,{outcome:'needs-version-fix'});await this.store.mutate(()=>{const saved=this.store.state.jobs.find(j=>j.id===job.id);saved.maintenanceBugId=bug.id;const w=this.store.find(target);if(w.status==='running'){w.status='paused';w.maintenance={bugId:bug.id,status:'needs-version-fix',message:'程序故障待后台诊断；原任务与改动保留。'};}});await this.maintenanceEvent(bug);return {maintenance:true,hostControl:true,bugId:bug.id,workRemainsOpen:true};}
    if(p.tool==='nozeli_report_deviation'&&!['frontdesk','orchestrator'].includes(target)){
      const event=await this.store.reportDeviation(target,job,a,p.callId);this.changed();return {saved:true,hostControl:true,deviationId:event.id,version:event.version,status:event.status,workRemainsOpen:true,userDecisionRequired:true};
    }
    this.assertDeviationReleased(target);
    // Sensitive-effect request is available to every role: an explicit model
    // request is the authorizer input — no pretending a universal classifier
    // exists — and the side effect is gated host-side before any broker call.
    if(p.tool==='nozeli_privileged_execute')return this.privilegedExecute(job,target,p);
    if(p.tool==='nozeli_report_read'&&!['frontdesk','orchestrator'].includes(target)){
      if(a.revision!==undefined&&(!Number.isInteger(a.revision)||a.revision<1))throw Error('Invalid report revision');
      const receipt=this.store.state.receipts.findLast(r=>r.workId===target&&(a.revision===undefined||r.revision===a.revision));if(!receipt)throw Error('No frozen report for this Work revision');
      if(a.relPath!==undefined)return managedArtifact({storage:this.store.storage,project:{id:this.projectId,root:this.store.content},runtime:this.store.root,controller:this,currentController:()=>this},{objectId:receipt.objectId,relPath:a.relPath});
      const bytes=await readStoredReport(this.store,receipt);job.reader??=new ContextReader();const readRef=job.reader.add(reportSemanticText(bytes,receipt.report),{title:receipt.report.title,source:'objects/'+receipt.objectId,kind:'frozen-report',objectId:receipt.objectId,revision:receipt.revision});
      return {...job.reader.read(readRef),report:receipt.report,revision:receipt.revision,files:(receipt.snapshot?.files||[]).map(({relPath,digest,size})=>({relPath,digest,size})),readOnly:true,continueTurn:true};
    }
    if(p.tool==='nozeli_diagram_schema'&&!['frontdesk','orchestrator'].includes(target)){
      if(!['architecture','workflow','sequence','dataflow','lifecycle'].includes(a.type))throw Error('Unknown diagram type');
      return {type:a.type,schema:JSON.parse(await fs.readFile(path.join(here,'archify-vendor','schemas',a.type+'.schema.json'),'utf8')),common:JSON.parse(await fs.readFile(path.join(here,'archify-vendor','schemas','common.schema.json'),'utf8')),readOnly:true,continueTurn:true};
    }
    if(p.tool==='nozeli_history_read'&&!['frontdesk','orchestrator'].includes(target)){const reader=job.reader||this.workerRecoveryReaders?.get(target);if(!reader)throw Error('No explicit Worker recovery source is bound');return {...reader.read(a.readRef),readOnly:true};}
    if(p.tool==='nozeli_diagram'&&!['frontdesk','orchestrator'].includes(target)){
      const isActive=()=>!this.stopping&&this.current.get(target)===job&&this.store.find(target).status==='running'&&this.store.find(target).revision===job.revision;
      if(!isActive())throw Object.assign(new Error('工作已停止'),{code:'WORK_STOPPED'});
      const rendered=await renderArchifyDiagram({type:a.type,spec:a.spec});
      // Diagrams exist only inside the immutable report object: validate the exact inline <figure> embedding the report will freeze, and create no project files.
      await prepareHtmlReport('<!doctype html><html><head><title>Diagram validation</title></head><body><figure>'+rendered.svg+'<figcaption>Diagram validation</figcaption></figure></body></html>');
      const fingerprint=createHash('sha256').update(JSON.stringify({type:a.type,specDigest:rendered.specDigest,generatorDigest:rendered.generatorDigest,svg:rendered.svg})).digest('hex');
      this.diagramCalls??=new Map();
      const prior=this.diagramCalls.get(p.callId);
      if(prior){
        if(prior.fingerprint!==fingerprint)throw Object.assign(new Error('图示调用身份冲突'),{code:'DIAGRAM_COLLISION'});
        return {...prior.value,duplicate:true,continueTurn:true};
      }
      if(!isActive())throw Object.assign(new Error('工作已停止'),{code:'WORK_STOPPED'});
      const value={type:a.type,svg:rendered.svg,alt:rendered.alt,caption:rendered.caption,specDigest:rendered.specDigest,generatorDigest:rendered.generatorDigest,validation:rendered.validation};
      this.diagramCalls.set(p.callId,{fingerprint,value});
      return {...value,continueTurn:true};
    }
    if(p.tool==='nozeli_skill_read'){
      if(['frontdesk','orchestrator'].includes(target))throw Error('domain skills belong to the bound Worker');
      const binding=this.store.find(target).binding||this.store.state.bindings.worker;
      return readRoleSkill('worker',a.name,{skills:binding.skills});
    }
    const externalDocumentTool={nozeli_document_read:'read',nozeli_document_apply:'apply',nozeli_document_create:'create',nozeli_project_list:'list',nozeli_project_search:'search'}[p.tool];
    const externalReceipt=p.tool==='nozeli_document_apply'?await this.store.storage.getLocal(this.projectId,'managed:external-document:'+createHash('sha256').update(this.store.state.workspaceId+job.id+p.callId).digest('hex')):null;
    if(target==='orchestrator'&&externalDocumentTool)return this.frontdeskOperation(job,p,externalDocumentTool);
    if(!['frontdesk','orchestrator'].includes(target)&&externalDocumentTool&&(a.projectPath||path.isAbsolute(a.relPath??'')||externalReceipt||['create','list','search'].includes(externalDocumentTool)||this.externalDocuments?.peek('apply',a)||this.frontdeskDocuments?.peek?.('apply',a)))return this.frontdeskOperation(job,p,externalDocumentTool);
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
      // Default background: an ordinary handoff of an explicitly submitted
      // original task dispatches directly under the original user request —
      // a handling decision, not a security authorization, and never a new
      // permission prompt. Standing user choices and pending decisions gate
      // this: the role boundary must not override an explicit user decision.
      const goal=this.frontGoal(job),routes=this.store.state.frontdeskRoutes??[];
      if(this.taskPermissions&&await this.taskPermissions.heldFor(this.projectId,job))return {ok:false,error:{code:'EFFECT_PERMISSION_PENDING',message:'敏感/提权执行授权仍等待用户决定；此期间不自动转后台，也不会绕过该授权。'},continueTurn:true};
      const prior=goal?routes.findLast(r=>r.goalId===goal.id):(job.context?.frontdeskRouteId?routes.find(r=>r.id===job.context.frontdeskRouteId)??routes.findLast(r=>r.sourceJobId===job.id):routes.findLast(r=>r.sourceJobId===job.id));
      if(routes.some(r=>r.sourceJobId===job.id&&r.status==='pending')||['continued','cancelled'].includes(prior?.status))return this.proposeFrontdeskRoute(job,reason);
      const result=await this.handoffFront(job,reason,{authority:'original-request'});
      return {...result,autoBackground:true,authority:'original-request'};
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
        job.reader.reads.push({kind:'memory-index',source:'memory/plantree/index.md',chars:JSON.stringify(result).length});return read(result);
      }
      if(matches.length!==1)throw new Error('work name or supplied reference must identify one Work');
      job.reader??=new ContextReader();
      const detail=this.workContext(matches[0],job.reader);
      for(const kind of ['problem','result']){const receipt=this.store.state.receipts.findLast(r=>r.workId===matches[0].id&&r.kind===kind);if(receipt){const body=reportSemanticText(await readStoredReport(this.store,receipt),receipt.report);detail[kind]={report:receipt.report,revision:receipt.revision,semanticText:body.slice(0,1200),readRef:job.reader.add(body,{title:receipt.report.title||kind,source:'objects/'+receipt.objectId+ (receipt.report.format==='html-static'?'.html':'.md'),kind:'report',objectId:receipt.objectId,revision:receipt.revision})};}}
      return read({workId:matches[0].id,workRef:'@work:'+matches[0].id,...detail});
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
      // kind 显式决定正文字段：result 只接受 html，problem 只接受 text；互斥，不做正文嗅探。
      const field=a.kind==='result'?'html':a.kind==='problem'?'text':null;
      if(!field||Object.keys(a).some(key=>!['kind',field,'files'].includes(key))||typeof a[field]!=='string'||!Array.isArray(a.files))throw Error(field?'publication requires kind with exactly its matching html/text field and files':'invalid publication kind');
      const kind=a.kind,body=a[field];
      const publicationInputDigest=createHash('sha256').update(JSON.stringify({kind,[field]:body,files:a.files})).digest('hex'),existing=this.store.state.receipts.find(row=>row.id===p.callId);
      if(existing){if(existing.workId!==target||existing.revision!==job.revision||existing.publicationInputDigest!==publicationInputDigest)throw Error('receipt collision');return {saved:true,kind,object:existing.objectId,report:existing.report,files:(existing.snapshot?.files||[]).map(({relPath,size})=>({relPath,size})),rejectedFiles:[],duplicate:true,workRemainsOpen:true};}
      let frozen,receipt;
      const isActive=()=>!this.stopping&&(this.current.get(target)===job||this.store.state.jobs.find(j=>j.id===job.id)?.maintenanceBugId)&&['running','paused'].includes(this.store.find(target).status)&&this.store.find(target).revision===job.revision&&(!this.store.state.jobs.find(j=>j.id===job.id)?.maintenanceBugId||!this.store.state.jobs.some(j=>j.id!==job.id&&j.target===target&&['queued','running'].includes(j.status)));
      const candidates=a.files.map(file=>this.execution&&path.isAbsolute(file)&&file.startsWith(this.execution.directory(target)+path.sep)?path.relative(this.execution.directory(target),file):file);
      const artifacts=await this.recordArtifacts(job,candidates);if(artifacts.rejected.length)throw Error('成果引用无法核验，请修正报告文件路径');
      const publish=retainCandidate=>this.store.publish(target,job.revision,kind,body,p.callId,{jobId:job.id,files:artifacts.files,publicationInputDigest,isActive,retainCandidate});
      try{await this.maintenanceTransaction(job,'publication',async()=>{
      const recovering=Boolean(this.store.find(target).maintenance?.bugId)&&this.store.find(target).maintenance.bugId===this.store.state.jobs.find(j=>j.id===job.id)?.maintenanceBugId;
      if(recovering)await this.store.mutate(()=>{if(this.store.find(target).status==='paused')this.store.find(target).status='running';});
      const current=await verifyProjectArtifacts(this.execution?this.execution.directory(target):this.store.state.contentRoot,candidates);
      if(current.rejected.length||JSON.stringify(current.files.map(f=>[f.relPath,f.digest]))!==JSON.stringify(artifacts.files.map(f=>[f.relPath,f.digest])))throw Object.assign(Error('Captured publication inputs changed'),{code:'PUBLICATION_STALE'});
      if(this.execution&&kind==='result')frozen=await this.execution.publish(this.store.find(target),job,isActive,async(manifest,candidate)=>{
        const binding={projectId:this.projectId,workId:target,revision:job.revision,jobId:job.id,receiptId:p.callId,repo:manifest.repo,commonDir:manifest.commonDir,inputCommit:manifest.inputCommit,candidateCommit:candidate.commit};
        receipt=await publish(async()=>{const retained=await this.changes.capture(binding);return {...retained,rollback:()=>this.changes.discardUnpublished(retained.changeSetId,binding)};});
        return {changeSetId:receipt.changeSetId};
      },{receiptId:p.callId,explicitFiles:artifacts.files.map(f=>f.relPath)});else receipt=await publish();
      return receipt;
      },()=>this.store.state.receipts.some(r=>r.id===p.callId&&r.workId===target&&r.publicationInputDigest===publicationInputDigest));
      }catch(error){if(error.code==='MAINTENANCE_PENDING')return {saved:false,hostControl:true,maintenance:true,bugId:error.bugId,workRemainsOpen:true,message:'宿主发布故障已交后台维修，不转换为业务问题，不重复Worker。'};throw error;}
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
    // Routing dedupe entry: a repeated identical request returns its original
    // receipt (including a first-run fallback recorded as dispatch); a
    // different request on an already-routed intake is rejected.
    const old=this.store.state.jobs.find(j=>j.id===job.id).routing;
    if(old){if(old.requestedAction===a.action&&old.requestedWorkName===a.workName)return old;if(old.action!==a.action||old.workName!==a.workName)throw new Error('intake already routed');return old;}
    if(!['continue','status','cancel','clarify'].includes(a.action)||typeof a.text!=='string')throw new Error('invalid management action');
    const matches=this.store.state.works.filter(w=>(w.name||w.request)===a.workName&&w.status!=='ended');
    // General routing decision: continue is only valid for an exactly matched
    // existing open Work. A first-run fallback dispatch is allowed ONLY when
    // NO open Work exists at all and this intake is not bound to an existing
    // Work chain — it is then the first background execution of a brand-new
    // user task. With any open Work unmatched by name, the orchestrator must
    // clarify or explicitly dispatch; a third Work is never fabricated
    // silently, and the task's natural language is never an existing Work name.
    if(a.action==='continue'&&matches.length===0&&this.store.state.works.every(w=>w.status==='ended')&&!this.intakeBoundWork(job)&&!job.context?.workHintId&&!job.context?.pendingIntakeId){
      const source=this.intakeSource(job);
      const receipt=await this.store.mutate(()=>{
        const saved=this.store.state.jobs.find(j=>j.id===job.id);
        if(saved.routing){if(saved.routing.requestedAction==='continue'&&saved.routing.requestedWorkName===a.workName)return saved.routing;throw new Error('intake already routed');}
        const created=this.store.submitState(source.request,source.request.slice(0,80),{name:source.request.slice(0,40),sourceJob:job.id});
        Object.assign(this.store.find(created.id),{imageAttachments:source.imageAttachments,sourceInputJobIds:source.sourceInputJobIds,...(job.context?.frontdeskRouteId?{frontdeskTransfer:{proposalId:job.context.frontdeskRouteId,completedOperations:structuredClone(job.context.completedOperations),currentSources:structuredClone(job.context.currentSources)}}:{})});
        saved.routing={action:'dispatch',requestedAction:'continue',requestedWorkName:a.workName,workId:created.id,name:created.name,at:new Date().toISOString(),firstRunFallback:true};this.resolveRoutingQuestion(job);return structuredClone(saved.routing);
      });
      this.changed();this.kick();return {...receipt,status:this.store.find(receipt.workId).status,quotaUsed:this.store.used(),quotaLimit:this.store.state.limit};
    }
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
    }else{
      // status is a read-only observation of current routing state: it never
      // persists a routing decision and never completes the intake turn — the
      // turn continues (document-tool pattern) until a terminal decision
      // (dispatch / continue / clarify). Ending a turn after only status is
      // rejected by runJob's routing guard as an explicit actionable failure.
      const receipt={action:'status',workName:a.workName,at:new Date().toISOString(),facts:w?{name:w.name||w.request,status:w.status,revision:w.revision}:JSON.parse(this.routingContext()),noWorkerTurn:true,continueTurn:true};
      return receipt;
    }
    const receipt={action:a.action,workName:a.workName,at:new Date().toISOString(),...detail};
    await this.store.mutate(()=>{if(a.action==='clarify'&&!this.store.state.todos.some(t=>t.sourceJobId===job.id))this.store.state.todos.push({id:randomUUID(),kind:'routing',target:'frontdesk',...(matches.length===1?{workId:w.id,revision:w.revision}:{}),status:'open',text:a.text,sourceJobId:job.id});this.store.state.jobs.find(j=>j.id===job.id).routing=receipt;if(a.action!=='clarify')this.resolveRoutingQuestion(job);});this.changed();this.kick();return receipt;
  }
  async ensureWorkerDelivery(job,error=null){
    const w=this.store.find(job.target);
    if(this.store.state.jobs.find(j=>j.id===job.id)?.maintenanceBugId||!['running','paused'].includes(w.status)||w.revision!==job.revision||w.problem?.revision===w.revision||w.result?.revision===w.revision||deviationHeld(w)||await this.taskPermissions?.heldFor(this.projectId,job))return;
    const text='## 宿主交付诊断：Worker 尚未交付最终报告\n\n'+(error?'本轮执行失败：'+String(error.message??error).slice(0,1500):'本回合已结束，但没有当前版本的最终成果或问题报告。')+'\n\n任务没有完成，不能冒称已交付。原任务、线程与工作树仍保留。\n\n建议处理：同意处理后让原 Worker 核对已完成操作、实际执行回执与现有改动，只执行剩余步骤、完成验证并发布最终结果；如不同意，请拒绝并写明替代要求。结果未知或原进程未确认退出时，先走明确恢复决定，不能自动重放。';
    await this.store.publish(w.id,w.revision,'problem',text,'host-missing-delivery:'+job.id,{jobId:job.id,files:[],hostDiagnostic:true,isActive:()=>!this.stopping&&['running','paused'].includes(w.status)&&w.revision===job.revision});
  }
  async runJob(inputJob){
    const job=structuredClone(inputJob);
    let didStart=false;
    const savedJob=()=>this.store.state.jobs.find(j=>j.id===job.id);
    try{
      const started=await this.store.mutate(()=>{if(savedJob().status!=='queued'||this.deviationHeld(job.target))return false;savedJob().status='running';savedJob().startedAt=new Date().toISOString();return true;});if(!started)return;didStart=true;this.current.set(job.target,job);this.changed();
      if(job.context?.pendingIntakeId){const parent=this.store.state.jobs.find(j=>j.id===job.context.pendingIntakeId),work=parent&&(this.intakeBoundWork(parent)||this.store.state.works.find(w=>w.sourceJob===parent.id));if(work)await this.store.mutate(()=>{const field=job.context.softWorkHint?'workHintId':'boundWorkId';job.context[field]=work.id;savedJob().context[field]=work.id;});else {const question=parent&&this.store.state.todos.findLast(q=>q.kind==='routing'&&q.sourceJobId===parent.id&&q.status==='open');if(!question)throw Error('原目标尚未明确处理结果，请先核对已有提交');await this.store.mutate(()=>{job.context.routingQuestionId=question.id;savedJob().context.routingQuestionId=question.id;});}}
      const isWork=!['frontdesk','orchestrator'].includes(job.target);
      if(isWork){const w=this.store.find(job.target);if(job.type!=='initial'&&w.status!=='running')await this.store.continue(w.id);job.revision=w.revision;await this.store.mutate(()=>{savedJob().revision=job.revision;});}
      const session=await this.maintenanceTransaction(job,'session-start',()=>this.session(job.target),s=>Boolean(s&&!s.closed));let prompt=job.text,delivery;
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
      const attachments=job.context?.imageAttachments||[];if(attachments.length>8)throw Error('图片超过8张');const images=[];let imageBytes=0;for(const ref of attachments){if(!/^[a-f0-9]{64}$/.test(ref.digest)||ref.mime!=='image/png'||ref.storage!=='project'||ref.projectId!==this.projectId)throw Error('图片附件引用无效');const bytes=await this.store.storage.readObject(this.projectId,ref.digest);imageBytes+=bytes.length;if(bytes.length>8*1024*1024||imageBytes>24*1024*1024)throw Error('图片附件超过大小上限');images.push('data:image/png;base64,'+bytes.toString('base64'));}
      const requestContext={...(delivery?.stats||{}),eventChars:job.text.length,hostAddedChars:Math.max(0,prompt.length-job.text.length),instructionChars:session.instructions?.length||0,baseInstructionChars:session.baseInstructions?.length||0,dynamicToolChars:JSON.stringify(session.tools||[]).length,...(event?{eventSkill:{delivery:'message',chars:event.length,digest:createHash('sha256').update(event).digest('hex')}}:{})};
      await this.store.mutate(()=>{savedJob().requestContext={promptChars:prompt.length,...requestContext};});
      if(job.type==='front'&&this.transferFor(job)){await this.saveTransferredFront(job);return;}
      await this.store.mutate(()=>{if(isWork)this.assertDeviationReleased(job.target);delete savedJob().resourceBlocked;savedJob().promptStartedAt=Date.now();const owner=isWork?this.store.find(job.target):this.store.state.residents[job.target];if(owner)owner.zeroActivity=false;});
      const response=await session.prompt(prompt,{timeout:session.settleTimeoutMs??600000,images,job:{id:job.id,target:job.target,revision:job.revision??null,type:job.type}});
      if(await this.settleUserInterruption(job))return;
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
      const agentBody=response.completion==='host-control'||response.projectedNative?'':response.text;const body=agentBody||(!response.projectedNative&&job.type==='intake'?this.routingMessage(savedJob().routing):'');
      await this.store.mutate(()=>{
        Object.assign(savedJob(),{status:'completed',finishedAt:new Date().toISOString(),threadId:response.threadId,turnId:response.turnId,providerStatus:response.providerStatus,completion:response.completion,metrics:response.metrics??null,...(response.effective?{effective:structuredClone(response.effective)}:{})});
        if(delivery){this.store.state.contextDelivery??={};this.store.state.contextDelivery[job.target]=delivery.checkpoint;}
        if(body)this.store.state.messages.push({id:randomUUID(),target:job.target,speaker:agentBody?'agent':'system',text:body,jobId:job.id,...(job.type==='intake'&&(job.context.frontJobId||job.context.manual||job.context.boundWorkId)?{audience:'frontdesk',sourceJobId:job.context.frontJobId||job.id}:{})});
        if(response.effective){this.store.state.modelObservations??={};this.store.state.modelObservations[`${response.effective.model}:${response.effective.effort}`]={status:'turn-completed',at:new Date().toISOString()};}
      });
      if(isWork&&this.store.find(job.target).status==='running'){await this.ensureWorkerDelivery(job);await this.store.settle(job.target);}
      if(this.taskPermissions&&!await this.taskPermissions.heldFor(this.projectId,job)){
        const permissionTaskId=job.context?.permissionTaskId??job.id;
        const continuing=this.store.state.jobs.some(next=>next.id!==job.id&&['queued','running'].includes(next.status)&&(next.context?.permissionTaskId??next.id)===permissionTaskId);
        if(!continuing){
          const ledger=await this.taskPermissions.read(this.projectId);
          await this.taskPermissions.endTask(this.projectId,permissionTaskId);
          for(const grant of ledger.grants??[])if(grant.permissionTaskId===permissionTaskId)this.privilegeBroker?.revoke?.({grantId:grant.id});
        }
      }
    }catch(e){
      if(await this.settleUserInterruption(job))return;
      if(e.code==='MAINTENANCE_PENDING'){await this.store.mutate(()=>{
        const saved=savedJob();if(saved&&!['cancelled','interrupted'].includes(saved.status)){saved.status='failed';saved.maintenanceBugId=e.bugId;}
        if(job.type==='backstage'){const entry=this.store.state.backstageEvents?.find(event=>event.key===job.context?.backstageEventKey),code=saved?.maintenanceFault?.code??e.code;if(entry){entry.status='blocked';entry.failureCode=/^[A-Z][A-Z0-9_]{0,79}$/.test(String(code))?code:'BACKSTAGE_PROCESSING_FAILED';entry.reason='后台核对失败（'+entry.failureCode+'）；原问题、进展与会话已保留，未重放未知效果。';}}
      });return;}
      if(e.code==='AGENT_PROCESS_LIMIT'&&!savedJob()?.promptStartedAt){await this.store.mutate(()=>{savedJob().status='queued';savedJob().resourceBlocked=true;delete savedJob().startedAt;});return;}
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
      if(job.type!=='maintenance'&&/^OMP_|^PI_|^NATIVE_|^HOST_INTERNAL_/.test(String(e.code??''))){const bug=await this.maintenance.record({phase:savedJob()?.promptStartedAt?'started-turn':'startup-diagnosis',jobId:job.id,workId:ending?.id??null,revision:job.revision??null,error:e});await this.maintenance.finish(bug.id,{outcome:savedJob()?.promptStartedAt?'human-boundary':'needs-version-fix'});await this.maintenanceEvent(bug);}
      // Record the accepted input's failure before cleanup can reject or hang.
      // Native exit and durable turn failure are independent pieces of evidence.
      await this.store.mutate(()=>{
        const saved=savedJob(),w=this.store.state.works.find(w=>w.id===job.target);
        if(['cancelled','interrupted','completed'].includes(saved.status)||w&&['closing','ended'].includes(w.status))return;
        Object.assign(saved,{status:this.stopping?'interrupted':'failed',finishedAt:new Date().toISOString(),error:e.message});
        if(job.type==='backstage'){
          const entry=this.store.state.backstageEvents?.find(event=>event.key===job.context?.backstageEventKey);
          if(entry){entry.status='blocked';entry.failureCode=/^[A-Z][A-Z0-9_]{0,79}$/.test(String(e.code??''))?e.code:'BACKSTAGE_PROCESSING_FAILED';entry.reason='后台核对失败（'+entry.failureCode+'）；原问题、进展与会话已保留，未重放未知效果。';}
        }
        const binding=w?.binding||this.store.state.bindings[job.target];
        if(binding){this.store.state.modelObservations??={};this.store.state.modelObservations[`${binding.model}:${binding.effort}`]={status:'turn-failed',error:e.message,at:new Date().toISOString()};}
        this.store.state.messages.push({id:randomUUID(),target:job.target,speaker:'system',text:runtimeFailureMessage(e,{work:Boolean(ending)}).text,jobId:job.id,...(job.context?.frontJobId||job.context?.manual||job.context?.boundWorkId?{audience:'frontdesk'}:{})});
        if(w?.status==='running')this.pauseState(w,e.message);else if(!w&&!['maintenance','backstage'].includes(job.type))this.store.state.todos.push({id:randomUUID(),kind:'system',status:'open',target:job.target,sourceJobId:job.id,text:e.message});
      });
      const owner=this.sessions.get(job.target),cleanupFailures=[];
      let exitReceipt;
      try{await this.terminals.get(job.target)?.close();}catch(error){cleanupFailures.push({stage:'terminal-close',error});}
      try{exitReceipt=await owner?.stop();}catch(error){cleanupFailures.push({stage:'native-stop',error});exitReceipt=owner?.lastExitReceipt;}
      await this.store.mutate(()=>{
        const saved=savedJob();
        if(cleanupFailures.length)saved.cleanupFailure={at:new Date().toISOString(),stages:cleanupFailures.map(({stage,error})=>({stage,category:error.code==='OMP_COLLAB_HOLD'||error.code==='PI_BUSY'?'native-hold':'cleanup-failed'})),exitConfirmed:exitReceipt?.confirmationComplete===true,evidence:owner?.cleanupEvidence?.()??null};
        // Pi 进程所有权严格确认：未确认退出绝不删除 provider 登记。
        if(this.sessions.get(job.target)===owner&&exitReceipt?.confirmationComplete===true)delete this.store.state.providers[job.target];
      });
      if(cleanupFailures.length)throw Object.assign(new AggregateError(cleanupFailures.map(({error})=>error),'native cleanup failed after turn failure'),{code:'PI_TURN_CLEANUP_FAILED',cause:e});
      if(!['frontdesk','orchestrator'].includes(job.target))await this.ensureWorkerDelivery(job,e);
    }finally{this.interruptions?.delete(job.id);if(!['frontdesk','orchestrator'].includes(job.target)){if(didStart&&this.store.find(job.target).deviation?.admittedJobId===job.id)await this.stopDeviationOwner(job.target);}await this.finalizeTransfers();
      if(job.type==='backstage')await this.store.mutate(()=>{const entry=this.store.state.backstageEvents?.find(e=>e.key===job.context?.backstageEventKey);if(entry?.status==='queued'){entry.status='blocked';entry.reason='后台回合未提供可靠处理；原问题与进展保留，未编造回答或执行未知效果。';}});
      await this.processBackstage();this.changed();if(didStart&&!this.stopping&&!['frontdesk','orchestrator'].includes(job.target))this.emit('files-changed',{jobId:job.id,workId:job.target,reason:'worker-turn-settled'});}
  }
  async saveTransferredFront(job,response={}){
    await this.store.mutate(()=>{
      const saved=this.store.state.jobs.find(j=>j.id===job.id),manual=this.transferFor(job)?.context?.manual;
      Object.assign(saved,{status:manual?'interrupted':'completed',interruptionReason:'user-transfer',finishedAt:new Date().toISOString(),threadId:response.threadId,turnId:response.turnId,providerStatus:response.providerStatus,completion:'user-transfer'});
      if(response.effective&&!saved.effective)saved.effective=structuredClone(response.effective);
      if(response.metrics)saved.metrics={...response.metrics,context:saved.requestContext||null,contextReads:(saved.readReceipts||[]).map(r=>({source:r.value.source,version:r.value.version,chars:r.value.text.length,offset:r.value.offset}))};
      if(manual&&response.text&&!response.projectedNative&&response.completion!=='host-control')this.store.state.messages.push({id:randomUUID(),target:'frontdesk',speaker:'agent',text:response.text,jobId:job.id,partial:true});
    });
  }
  workLocked(id,fn){this.workOperations??=new Map();const operation=(this.workOperations.get(id)??Promise.resolve()).catch(()=>{}).then(fn);this.workOperations.set(id,operation);return operation.finally(()=>{if(this.workOperations.get(id)===operation)this.workOperations.delete(id);});}
  async validateLocalIdentity(id){
    // Activation precedes asynchronous worktree preparation. Read ownership only
    // after that target's existing startup/evidence operation has settled.
    if(this.starting.has(id))await this.starting.get(id);
    await this.execution.serial.get(id);
    const w=this.store.find(id),manifest=await this.execution.readManifest(id);
    if(manifest){await this.execution.identity(manifest,{target:false});if(manifest.workId!==id)throw Error('Execution Work identity mismatch');if(manifest.candidate?.commit!==w.execution?.candidate?.commit)throw Error('Frozen candidate identity changed');}
    else if(w.revision!==0||w.execution)throw Error('Execution ownership evidence missing; resources retained');
    const record=this.store.state.providers?.[id];
    if(record){
      if(!Number.isSafeInteger(record.pid)||record.pid<=0||typeof record.home!=='string'||record.home!==this.store.agentHome(id)||typeof record.stamp!=='string'||!/^[a-f0-9-]{36}:\d+$/.test(record.stamp))throw Error('Worker process ownership identity is unverified');
      const stamp=await processStamp(record.pid);if(stamp&&stamp!==record.stamp)throw Error('Worker PID identity reused; resources retained');
    }
    if(!record&&!this.sessions.has(id)&&[...(this.processBudget?.slots??[])].some(slot=>slot.projectId===this.projectId&&slot.target===id))throw Error('Worker budget owner identity is unknown');
  }
  // ── 人工审校（managed.review.*）────────────────────────────────────────
  // 读取=不可变基线/冻结候选/durable人工草稿三版本；保存=CAS、零模型与源写入；
  // 续作=受控应用草稿到同一Work/线程；接受=人工审校精确版本经宿主Git合入。
  #reviewWork(objectId,workId){
    const works=this.store.state.works||[];
    if(workId!==undefined&&workId!==null){
      const work=works.find(w=>w.id===workId);
      if(!work)throw Object.assign(Error('未找到此工作'),{code:'WORK_NOT_FOUND'});
      if(objectId&&!this.store.state.receipts.some(r=>r.objectId===objectId&&r.workId===workId))throw Object.assign(Error('未找到此报告'),{code:'REVIEW_OBJECT_UNKNOWN'});
      return work;
    }
    if(typeof objectId!=='string'||!objectId)throw Object.assign(Error('需要报告objectId或workId'),{code:'INVALID_PAYLOAD'});
    const receipt=this.store.state.receipts.find(r=>r.objectId===objectId),work=receipt&&works.find(w=>w.id===receipt.workId);
    if(!work)throw Object.assign(Error('未找到此报告对应的工作'),{code:'REVIEW_OBJECT_UNKNOWN'});
    return work;
  }
  #reviewReceipt(work,objectId){
    const id=objectId??work.result?.objectId??null;
    const receipt=this.store.state.receipts.find(r=>r.objectId===id&&r.workId===work.id);
    if(!receipt)throw Object.assign(Error('未找到此报告'),{code:'REVIEW_OBJECT_UNKNOWN'});
    return receipt;
  }
  #reviewBusy(id){return (this.store.state.jobs||[]).some(j=>(j.target===id||j.context?.boundWorkId===id)&&['queued','running'].includes(j.status));}
  async #reviewManifest(work){
    const m=await this.execution.readManifest(work.id);
    if(m?.repo&&m.candidate)return m;
    const fallback=work.execution;
    return fallback?.repo&&fallback.candidate?.commit?{repo:fallback.repo,directory:fallback.directory,targetRef:fallback.targetRef,candidate:fallback.candidate}:null;
  }
  #reviewStale(work,receipt){
    if(work.status==='ended')return null;
    if(receipt.stale)return {code:receipt.stale.code||'SUPERSEDED',detail:receipt.stale};
    if((work.result?.objectId??null)!==receipt.objectId)return {code:'SUPERSEDED',detail:{reason:'newer-publication'}};
    if(work.status==='running')return {code:'RUNNING',detail:{reason:'worker-turn-active'}};
    return null;
  }
  #reviewCapabilities(work,receipt,stale){
    const reasons=[];
    if(work.status==='ended')reasons.push({code:'WORK_ENDED',message:'工作已结束；报告仅供查阅，版本不可再修改'});
    if(stale)reasons.push(stale.code==='RUNNING'?{code:'RUNNING',message:'工作正在执行；请等回合结束后再审校或决定'}:{code:stale.code,message:'此报告已被更新的发布取代；草稿与决定只针对最新候选'});
    const disposition=workDisposition(this.store.state,work);
    const candidateBound=Boolean(receipt.snapshot?.candidate?.commit&&receipt.snapshot.candidate.commit===(work.execution?.candidate?.commit??null));
    if(!candidateBound&&work.status!=='ended')reasons.push({code:'RESULT_BINDING_REQUIRED',message:disposition.accept.message||'需要当前版本与冻结候选一致的结果报告'});
    if(this.#reviewBusy(work.id)&&work.status!=='ended')reasons.push({code:'WORK_BUSY',message:'此工作有待执行的输入；请等待当前回合结算'});
    const blocked=reasons.length>0;
    return {canSave:!blocked,canContinue:!blocked,canAccept:!blocked&&disposition.accept.allowed===true,reasons};
  }
  async #reviewVersionNow(work,receipt){
    const m=await this.#reviewManifest(work);
    receipt??=this.#reviewReceipt(work);
    if(!m)return {version:null,snapshot:null,m:null,receipt};
    // 历史读取（已结束/对象可能被回收）用冻结证据：候选=回执冻结对象，
    // 基线=WorkChanges.before；缺基线证据时显式标缺失，绝不伪造空基线。
    let snapshot;
    if(work.status==='ended'){
      try{snapshot=await this.#frozenReviewSnapshot(work,receipt);}catch{snapshot=null;}
      if(!snapshot||!snapshot.files.length){try{snapshot=await this.execution.reviewSnapshot(m,receipt);}catch{snapshot=null;}}
    }else snapshot=await this.execution.reviewSnapshot(m,receipt);
    if(!snapshot)return {version:null,snapshot:null,m:null,receipt};
    const drafts=activeDrafts(work);
    const files=snapshot.files.map(f=>{const d=drafts[f.relPath]&&drafts[f.relPath].objectId===receipt.objectId?drafts[f.relPath]:null;return {relPath:f.relPath,candidateDigest:f.candidateDigest,draftRevision:d?.revision??0,draftDigest:d?.textDigest??null};});
    // 已按人工审校接受结束的Work：whole-work令牌以接受绑定精确保留，但只对
    // 接受所绑定的publication返回；同Work旧发布按自身文件集重算，绝不投新稿。
    const reviewedEnded=work.status==='ended'?work.closure?.reviewedVersion:null;
    const acceptedToken=reviewedEnded&&reviewedEnded.objectId===receipt.objectId&&typeof reviewedEnded.reviewVersion==='string'?reviewedEnded.reviewVersion:null;
    return {version:acceptedToken??computeReviewVersion({workId:work.id,revision:work.revision,candidateCommit:snapshot.candidateCommit,objectId:receipt.objectId,files}),snapshot,m,receipt};
  }
  // 冻结证据侧对象字节：WorkChanges归档对象按内容寻址存入项目存储；读取
  // 失败/损坏显式置null，绝不以源文件字节顶替。
  async #changeSideBytes(side){
    if(!side||side.type!=='blob'||!side.object?.digest||!Number.isSafeInteger(side.bytes)||side.bytes>2*1024*1024)return null;
    const bytes=await this.store.readObject(side.object.digest,{maxBytes:2*1024*1024}).catch(()=>null);
    return Buffer.isBuffer(bytes)&&bytes.length===side.bytes?bytes:null;
  }
  // 完整冻结变更集（分页取全）。任何缺失/失败都返回null：宁可显式unknown，
  // 也不用不完整子集冒充完整清单。
  async #changeSetFiles(changeSetId){
    if(!changeSetId)return null;
    try{
      const files=[];let offset=0;
      for(;;){
        const batch=await this.changes.list({changeSetId,offset,limit:200});
        files.push(...batch.files);
        if(batch.nextOffset===null)return files;
        offset=batch.nextOffset;
      }
    }catch{return null;}
  }
  async #frozenReviewSnapshot(work,receipt){
    // 完整历史清单 = 冻结变更集 ∪ 回执引用文件：报告未引用的修改、新增、
    // 删除、重命名与二进制文件全部保留，不缩水为报告引用子集。
    const changeFiles=await this.#changeSetFiles(receipt.changeSetId);
    const files=[];
    for(const change of changeFiles||[]){
      files.push({
        relPath:change.path,oldPath:change.oldPath??null,gitStatus:change.status,
        baselineDigest:change.before?.object?.digest??null,candidateDigest:change.after?.object?.digest??null,
        baselineMode:change.before?.mode??null,candidateMode:change.after?.mode??null,
        baselineSize:change.before?.bytes??0,candidateSize:change.after?.bytes??0,
        baselineBytes:null,candidateBytes:null,
        addedCount:change.added??null,deletedCount:change.deleted??null,binary:Boolean(change.binary),
        availability:change.availability,reason:change.reason??null,
        baselineUnavailable:!change.before&&change.status!=='A',
        added:change.status==='A',source:'frozen',
      });
    }
    const seen=new Set(files.map(f=>f.relPath));
    for(const entry of receipt.snapshot?.files||[]){
      if(seen.has(entry.relPath))continue;
      // 变更集完整时，未被diff列出的引用文件＝输入基线→候选未改：基线摘要
      // 即候选摘要（同一提交区间diff的完整性），不伪造缺失；无变更集证据时
      // 显式unknown（保持显式缺失，不猜）。
      const complete=changeFiles!==null;
      files.push({
        relPath:entry.relPath,oldPath:null,gitStatus:null,
        baselineDigest:complete?entry.digest??null:null,candidateDigest:entry.digest??null,
        baselineMode:null,candidateMode:null,baselineSize:complete?entry.size:0,candidateSize:entry.size,
        baselineBytes:null,candidateBytes:null,
        addedCount:complete?0:null,deletedCount:complete?0:null,binary:false,
        availability:'available',reason:null,
        baselineUnavailable:!complete,added:false,source:'frozen',
      });
    }
    files.sort((a,b)=>a.relPath<b.relPath?-1:a.relPath>b.relPath?1:0);
    return {baselineCommit:null,candidateCommit:receipt.snapshot?.candidate?.commit??null,targetRef:work.execution?.targetRef??null,files,source:'frozen'};
  }
  async reviewRead(p={}){
    if(!p||typeof p!=='object'||Array.isArray(p))throw Object.assign(Error('审校读取参数无效'),{code:'INVALID_PAYLOAD'});
    const work=this.#reviewWork(p.objectId,p.workId);
    return this.workLocked(work.id,()=>this.#reviewReadNow(p));
  }
  async #reviewReadNow(p){
    const work=this.#reviewWork(p.objectId,p.workId);
    const receipt=this.#reviewReceipt(work,p.objectId);
    const current=await this.#reviewVersionNow(work,receipt);
    const drafts=activeDrafts(work);
    const record=await readDraftRecord(this.store.storage,this.store.projectId,work.id);
    const stale=this.#reviewStale(work,receipt);
    const editable=!stale&&work.status!=='ended';
    // 接受投影只属于接受绑定的publication：同Work旧发布不得显示新发布的
    // 人工稿/接受绑定——历史读取回到自身candidate与重算令牌。
    const reviewedEnded=work.status==='ended'?work.closure?.reviewedVersion:null;
    const acceptedBinding=reviewedEnded&&reviewedEnded.objectId===receipt.objectId?reviewedEnded:null;
    const acceptedFiles=acceptedBinding?new Map((acceptedBinding.files||[]).map(f=>[f.relPath,f])):null;
    const files=[];
    if(current?.snapshot){
      // 基线→冻结候选固定计数（WorkChanges numstat），live与冻结历史同源；
      // status:'unchanged'+真实0/0即“引用未改”，不冒充改动。
      const changeFiles=await this.#changeSetFiles(receipt.changeSetId);
      const changeMap=new Map((changeFiles||[]).map(f=>[f.path,f]));
      const workerActor={kind:'worker',name:work.name||'Worker',workId:work.id};
      let previewBudget=16*1024*1024;
      for(const entry of current.snapshot.files){
        if(p.relPath&&entry.relPath!==p.relPath)continue;
        const frozen=current.snapshot.source==='frozen';
        const sideBytes=async(side)=>{
          const size=entry[side+'Size']??0;
          if(size>2*1024*1024||size>previewBudget)return null;
          previewBudget-=size;
          if(!frozen)return entry[side+'Digest']===null?null:this.execution.reviewBlob(current.m,side==='baseline'?current.snapshot.baselineCommit:current.snapshot.candidateCommit,entry.relPath);
          const change=changeMap.get(entry.relPath),metadata=change?.[side==='baseline'?'before':'after'];
          if(metadata)return this.#changeSideBytes(metadata);
          const artifact=receipt.snapshot?.files?.find(file=>file.relPath===entry.relPath);
          if(!artifact?.objectDigest||side==='baseline'&&entry.baselineUnavailable)return null;
          return this.store.readObject(artifact.objectDigest,{maxBytes:2*1024*1024}).catch(()=>null);
        };
        const baselineBytes=await sideBytes('baseline'),candidateBytes=await sideBytes('candidate');
        const baseline=baselineBytes===null&&entry.baselineDigest!==null?{text:null,omitted:'size'}:decodeInline(baselineBytes);
        const candidate=candidateBytes===null&&entry.candidateDigest!==null?{text:null,omitted:'size'}:decodeInline(candidateBytes);
        let draft=null;
        if(acceptedFiles){
          const a=acceptedFiles.get(entry.relPath);
          if(a&&a.draftRevision!=null){
            const text=draftTextFor(record,entry.relPath,a.draftRevision);
            const savedAt=(work.review?.history?.[entry.relPath]||[]).find(h=>h.revision===a.draftRevision)?.savedAt??null;
            // 历史只读：正文缺失如实标记，绝不回退候选正文冒充人工稿。
            draft={revision:a.draftRevision,textDigest:a.reviewedDigest,savedAt,...(text===null?{missing:true}:{text})};
          }
        }else{
          const active=drafts[entry.relPath]&&drafts[entry.relPath].objectId===receipt.objectId?drafts[entry.relPath]:null;
          if(active){
            const text=draftTextFor(record,entry.relPath,active.revision);
            if(text===null)throw Object.assign(Error('人工草稿正文缺失（保存中断）；请重新保存草稿恢复，勿回退为候选正文'),{code:'REVIEW_DRAFT_RECOVERY'});
            draft={revision:active.revision,textDigest:active.textDigest,savedAt:active.savedAt,text};
          }
        }
        const change=changeMap.get(entry.relPath)||null;
        // 固定计数语义：输入基线→Worker冻结候选；人工稿只另标humanEdited，
        // 不改变计数。二进制/缺证据＝null，绝不伪造+0/-0。
        let added=null,deleted=null,binary=false,unsupportedReason=null;
        if(change){added=change.added??null;deleted=change.deleted??null;binary=Boolean(change.binary);if(change.availability!=='available')unsupportedReason=change.reason||'unsupported';}
        else if(!entry.baselineUnavailable&&entry.baselineDigest!==null&&entry.baselineDigest===entry.candidateDigest){added=0;deleted=0;}
        else unsupportedReason=entry.baselineUnavailable?'baseline-unavailable':'change-set-unavailable';
        const gitStatus=entry.gitStatus??change?.status??null;
        let status;
        if(entry.baselineUnavailable)status='unknown';
        else if(gitStatus==='R')status='renamed';
        else if(gitStatus==='C')status='copied';
        else if(gitStatus==='T')status='type-changed';
        else if(gitStatus==='A'||gitStatus===null&&entry.baselineDigest===null&&entry.candidateDigest!==null)status='added';
        else if(gitStatus==='D'||gitStatus===null&&entry.candidateDigest===null&&entry.baselineDigest!==null)status='deleted';
        else if(entry.baselineDigest===null||entry.candidateDigest===null)status='unknown';
        else status=entry.baselineDigest===entry.candidateDigest?'unchanged':'modified';
        const textOmitted=candidate.omitted&&candidate.omitted!=='absent'?candidate.omitted:baseline.omitted&&baseline.omitted!=='absent'?baseline.omitted:null;
        const side=(digest,bytes,omitted,size)=>{
          if(digest===null)return {digest:null,bytes:null,available:false,reason:null};
          if(!Buffer.isBuffer(bytes))return {digest,bytes:size??null,available:false,reason:omitted==='size'?'size':'unavailable'};
          if(omitted==='size')return {digest,bytes:bytes.length,available:true,reason:'size'};
          if(omitted==='binary')return {digest,bytes:bytes.length,available:false,reason:'binary'};
          return {digest,bytes:bytes.length,available:true,reason:null};
        };
        files.push({
          relPath:entry.relPath,
          change:entry.baselineUnavailable&&entry.candidateDigest!==null?'unknown':entry.baselineDigest===null?'added':entry.candidateDigest===null?'removed':entry.baselineDigest===entry.candidateDigest?'unchanged':'modified',
          status,
          oldPath:entry.oldPath??change?.oldPath??null,
          added,deleted,binary,
          ...(unsupportedReason?{unsupportedReason}:{}),
          humanEdited:Boolean(draft&&draft.textDigest!==entry.candidateDigest),
          ...(change?{changeFileId:change.fileId}:{}),
          baselineDigest:entry.baselineDigest,candidateDigest:entry.candidateDigest,
          baselineText:baseline.text,candidateText:candidate.text,
          ...(entry.baselineUnavailable?{baselineUnavailable:true}:{}),
          ...(textOmitted?{textOmitted}:{}),
          material:{
            baseline:side(entry.baselineDigest,baselineBytes,baseline.omitted,entry.baselineSize),
            candidate:side(entry.candidateDigest,candidateBytes,candidate.omitted,entry.candidateSize),
          },
          draft,
          versions:[
            ...(entry.baselineDigest!==null?[{kind:'baseline',digest:entry.baselineDigest,savedAt:null,actor:workerActor}]:[]),
            ...(entry.candidateDigest!==null?[{kind:'candidate',digest:entry.candidateDigest,savedAt:receipt.at,actor:workerActor,commit:current.snapshot.candidateCommit}]:[]),
            ...(work.review?.history?.[entry.relPath]||[]).filter(h=>h.objectId===receipt.objectId).slice(-REVIEW_HISTORY_LIMIT).map(h=>({kind:'draft',revision:h.revision,digest:h.textDigest,savedAt:h.savedAt,actor:{kind:'user',name:'你'}})),
          ],
          history:(work.review?.history?.[entry.relPath]||[]).slice(-20),
          editable,
        });
      }
    }
    const lastContinuation=(work.review?.continuations||[]).at(-1)??null;
    return {
      workId:work.id,objectId:receipt.objectId,status:work.status,revision:work.revision,
      candidate:{
        commit:current?.snapshot.candidateCommit??work.execution?.candidate?.commit??null,
        jobId:receipt.snapshot?.candidate?.jobId??null,
        publishedAt:receipt.at,reportDigest:receipt.report?.digest??null,
        targetRef:current?.snapshot.targetRef??work.execution?.targetRef??null,
        files:(receipt.snapshot?.files||[]).map(f=>({relPath:f.relPath,digest:f.digest??null,bytes:f.size??null,objectDigest:f.objectDigest??null})),
      },
      baselineCommit:current?.snapshot.baselineCommit??null,
      frozen:current?.snapshot?.source==='frozen',
      changeSetId:receipt.changeSetId??null,
      stale,files,reviewVersion:current?.version??null,
      ...(acceptedBinding?{accepted:{reviewVersion:acceptedBinding.reviewVersion,at:acceptedBinding.at??null,files:(acceptedBinding.files||[]).map(f=>({relPath:f.relPath,candidateDigest:f.candidateDigest??null,reviewedDigest:f.reviewedDigest??null,draftRevision:f.draftRevision??null}))}}:{}),
      merge:reviewMergeProjection(work.closure),
      mergeConsent:mergeConsentState(work),
      ...(lastContinuation?{continuation:{state:lastContinuation.state,at:lastContinuation.at??null,revision:lastContinuation.revision??null,jobId:lastContinuation.jobId??null,...(lastContinuation.error?{error:{code:lastContinuation.error.code??null,message:lastContinuation.error.message??null}}:{})}}:{}),
      capabilities:this.#reviewCapabilities(work,receipt,stale),
    };
  }
  async reviewSave(p={}){
    if(!p||typeof p!=='object'||Array.isArray(p))throw Object.assign(Error('审校保存参数无效'),{code:'INVALID_PAYLOAD'});
    if(typeof p.objectId!=='string'||!p.objectId)throw Object.assign(Error('需要当前报告标识'),{code:'INVALID_PAYLOAD'});
    if(typeof p.relPath!=='string'||!p.relPath)throw Object.assign(Error('需要文件路径'),{code:'INVALID_PAYLOAD'});
    if(!Number.isSafeInteger(p.expectedDraftRevision)||p.expectedDraftRevision<0)throw Object.assign(Error('草稿版本号无效'),{code:'INVALID_PAYLOAD'});
    const restore=p.restoreRevision!==undefined&&p.restoreRevision!==null;
    if(restore&&(!Number.isSafeInteger(p.restoreRevision)||p.restoreRevision<1))throw Object.assign(Error('要恢复的历史版本无效'),{code:'INVALID_PAYLOAD'});
    if(!restore&&typeof p.text!=='string')throw Object.assign(Error('需要审校正文'),{code:'INVALID_PAYLOAD'});
    const work=this.#reviewWork(p.objectId,p.workId);
    return this.workLocked(work.id,async()=>{
      const w=this.store.find(work.id);
      const receipt=this.#reviewReceipt(w,p.objectId);
      if(w.status==='ended')throw Object.assign(Error('工作已结束；审校草稿不再修改'),{code:'WORK_ENDED'});
      if(w.readOnly)throw Object.assign(Error('历史执行资源只读'),{code:'HISTORICAL_SESSION_READ_ONLY'});
      if(p.objectId!==(w.result?.objectId??null)||receipt.stale)throw Object.assign(Error('此报告不是当前待审候选；草稿只属于最新发布'),{code:'REVIEW_CANDIDATE_STALE'});
      const current=await this.#reviewVersionNow(w,receipt);
      if(!current?.snapshot)throw Object.assign(Error('缺少冻结候选，无法保存草稿'),{code:'CANDIDATE_REQUIRED'});
      if(!current.snapshot.files.some(f=>f.relPath===p.relPath))throw Object.assign(Error('此文件不在候选审校清单中：'+p.relPath),{code:'REVIEW_FILE_UNKNOWN'});
      const held=w.review?.drafts?.[p.relPath];
      const active=held&&held.objectId===p.objectId?held.revision:0;
      if(p.expectedDraftRevision!==active)throw Object.assign(Error('草稿版本已变化，请重新读取后再保存；你的输入没有丢失'),{code:'REVIEW_DRAFT_STALE',currentDraftRevision:active});
      // 记录写入与账本同一revision推导（cursor单调）：消费后续号永不覆盖旧正文。
      const cursor=w.review?.revisionCursor?.[p.relPath]??0;
      const nextRevision=(held?.revision??cursor)+1;
      let text;
      if(restore){
        const history=await readDraftRecord(this.store.storage,this.store.projectId,work.id);
        text=draftTextFor(history,p.relPath,p.restoreRevision);
        if(text===null)throw Object.assign(Error('要恢复的草稿历史不存在或正文已过期'),{code:'REVIEW_REVISION_UNKNOWN'});
      }else text=normalizeReviewText(p.text);
      const {digest}=reviewDraftBytes(text),at=new Date().toISOString();
      // 字节先于账本版本落盘；账本事务内再做一次CAS复核。历史裁剪永不剥离
      // 账本active版本与未完成续作/接受仍引用的正文（失败写留下的orphan除外）。
      const keep=[active,...(w.review?.continuations||[]).filter(cn=>['applying','blocked','queued'].includes(cn.state)).flatMap(cn=>(cn.files||[]).filter(f=>f.relPath===p.relPath).map(f=>f.draftRevision))];
      const record=appendDraftEntry(await readDraftRecord(this.store.storage,this.store.projectId,work.id),p.relPath,{revision:nextRevision,text,textDigest:digest,savedAt:at},keep);
      await writeDraftRecord(this.store.storage,this.store.projectId,work.id,record);
      const saved=await this.store.reviewSaveState(work.id,{objectId:p.objectId,relPath:p.relPath,textDigest:digest,expectedDraftRevision:active});
      const version=await this.#reviewVersionNow(this.store.find(work.id));
      this.changed();
      return {accepted:true,workId:work.id,relPath:p.relPath,draftRevision:saved.draftRevision,savedAt:saved.savedAt,reviewVersion:version?.version??null};
    });
  }
  async reviewContinue(p={}){
    if(!p||typeof p!=='object'||Array.isArray(p))throw Object.assign(Error('审校续作参数无效'),{code:'INVALID_PAYLOAD'});
    if(typeof p.objectId!=='string'||!p.objectId)throw Object.assign(Error('需要当前报告标识'),{code:'INVALID_PAYLOAD'});
    if(typeof p.reviewVersion!=='string'||!/^[a-f0-9]{64}$/.test(p.reviewVersion))throw Object.assign(Error('审校版本令牌无效'),{code:'INVALID_PAYLOAD'});
    if(typeof p.requestKey!=='string'||!REVIEW_REQUEST_KEY.test(p.requestKey))throw Object.assign(Error('续作确认身份无效'),{code:'INVALID_PAYLOAD'});
    if(p.instruction!==undefined&&p.instruction!==null&&(typeof p.instruction!=='string'||p.instruction.length>4000))throw Object.assign(Error('续作补充要求无效'),{code:'INVALID_PAYLOAD'});
    const work=this.#reviewWork(p.objectId,p.workId);
    return this.workLocked(work.id,async()=>{
      const w=this.store.find(work.id);
      if(w.status==='ended')throw Object.assign(Error('工作已结束；不能续作'),{code:'WORK_ENDED'});
      if(w.readOnly)throw Object.assign(Error('历史执行资源只读'),{code:'HISTORICAL_SESSION_READ_ONLY'});
      // 幂等重放优先：已收口的requestKey直接回执，不因后续stale标记被拒。
      const payloadDigest=createHash('sha256').update(JSON.stringify({objectId:p.objectId,reviewVersion:p.reviewVersion,instruction:p.instruction??null})).digest('hex');
      const existing=w.review?.continuations?.find(c=>c.requestKey===p.requestKey);
      if(existing&&existing.payloadDigest&&existing.payloadDigest!==payloadDigest)throw Object.assign(Error('同一续作确认身份已用于不同请求'),{code:'REVIEW_REQUEST_COLLISION'});
      if(existing?.state==='queued')return {accepted:true,workId:work.id,revision:existing.revision,jobId:existing.jobId,duplicate:true};
      const receipt=this.#reviewReceipt(w,p.objectId);
      if(p.objectId!==(w.result?.objectId??null)||receipt.stale)throw Object.assign(Error('此报告已被取代；请在最新发布上继续'),{code:'REVIEW_CANDIDATE_STALE'});
      const current=await this.#reviewVersionNow(w,receipt);
      if(!current?.snapshot)throw Object.assign(Error('缺少冻结候选，不能续作'),{code:'CANDIDATE_REQUIRED'});
      if(p.reviewVersion!==current.version)throw Object.assign(Error('审校版本已变化（草稿或候选已更新）；请重新读取'),{code:'REVIEW_VERSION_STALE'});
      if(!['paused','review'].includes(w.status))throw Object.assign(Error(w.status==='running'?'工作正在执行；等待回合结束后再续作':'当前状态不能续作'),{code:w.status==='running'?'WORK_BUSY':'WORK_STATE'});
      if(this.#reviewBusy(work.id))throw Object.assign(Error('此工作有待执行输入；不能同时续作'),{code:'WORK_BUSY'});
      const m=await this.execution.prepare(work.id);
      const drafts=activeDrafts(w),record=await readDraftRecord(this.store.storage,this.store.projectId,work.id);
      const plan=[];
      for(const [relPath,draft] of Object.entries(drafts)){
        if(draft.objectId!==p.objectId)continue;   // 只应用本轮发布的草稿
        const entry=current.snapshot.files.find(f=>f.relPath===relPath);
        if(!entry)throw Object.assign(Error('草稿文件不在当前候选中：'+relPath),{code:'REVIEW_CANDIDATE_STALE'});
        if(draft.textDigest===entry.candidateDigest)continue;
        const text=draftTextFor(record,relPath,draft.revision);
        if(text===null)throw Object.assign(Error('草稿正文缺失（恢复材料不全）；请重新保存草稿后再试'),{code:'REVIEW_DRAFT_RECOVERY'});
        const {bytes,digest}=reviewDraftBytes(text);
        if(digest!==draft.textDigest)throw Object.assign(Error('草稿正文与账本摘要不一致；请重新保存草稿'),{code:'REVIEW_DRAFT_RECOVERY'});
        plan.push({relPath,fromDigest:entry.candidateDigest,toDigest:digest,draftRevision:draft.revision,bytes});
      }
      const filesList=plan.map(f=>'- '+f.relPath+'（人工审校后 sha256 '+f.toDigest+'）').join('\n')||'-（本轮无文本修改，仅要求继续）';
      const instruction='用户在报告审校中选择继续原工作。\n宿主已把下列人工确认版本准确写入执行目录（字节级一致）；请以此为当前事实继续原任务，核对这些文件的最终状态，完成后再发布一次结果报告：\n'+filesList+(typeof p.instruction==='string'&&p.instruction.trim()?'\n用户补充要求：\n'+p.instruction.trim().slice(0,4000):'');
      // 1) durable续作意图（同requestKey幂等复用）
      await this.store.mutate(()=>{
        const w2=this.store.find(work.id);
        w2.review??={drafts:{},history:{},continuations:[]};
        if(!w2.review.continuations.some(c=>c.requestKey===p.requestKey))w2.review.continuations.push({requestKey:p.requestKey,at:new Date().toISOString(),reviewVersion:p.reviewVersion,objectId:p.objectId,payloadDigest,state:'applying',instruction,files:plan.map(({bytes:dropped,...rest})=>rest)});
      });
      // 2) 受控应用（摘要幂等，drift即拒绝且零写入）
      try{await this.execution.applyReviewedFiles(m,plan);}
      catch(error){
        await this.store.mutate(()=>{const c=this.store.find(work.id).review?.continuations?.find(x=>x.requestKey===p.requestKey);if(c&&c.state==='applying'){c.state='blocked';c.error={code:error.code||null,message:error.message};}});
        throw error;
      }
      // 3) 单事务收口：同Work、同线程manual job，旧报告全部stale
      const result=await this.store.reviewContinueState(work.id,{requestKey:p.requestKey});
      if(result.abandoned)throw Object.assign(Error('工作已结束；续作未执行'),{code:'WORK_ENDED'});
      this.changed();this.kick();
      return {accepted:true,workId:work.id,revision:result.revision,jobId:result.jobId,...(result.duplicate?{duplicate:true}:{})};
    });
  }
  async reviewAccept(p={}){
    if(!p||typeof p!=='object'||Array.isArray(p))throw Object.assign(Error('审校接受参数无效'),{code:'INVALID_PAYLOAD'});
    if(typeof p.objectId!=='string'||!p.objectId)throw Object.assign(Error('需要当前报告标识'),{code:'INVALID_PAYLOAD'});
    if(typeof p.reviewVersion!=='string'||!/^[a-f0-9]{64}$/.test(p.reviewVersion))throw Object.assign(Error('审校版本令牌无效'),{code:'INVALID_PAYLOAD'});
    if(typeof p.requestKey!=='string'||!REVIEW_REQUEST_KEY.test(p.requestKey))throw Object.assign(Error('接受确认身份无效'),{code:'INVALID_PAYLOAD'});
    const work=this.#reviewWork(p.objectId,p.workId);
    return this.workLocked(work.id,async()=>{
      let w=this.store.find(work.id);
      const receipt=this.#reviewReceipt(w,p.objectId);
      if(w.status==='ended'){
        if(w.closure?.decision==='accept'&&w.closure.reviewedVersion){
          if(w.closure.reviewedVersion.reviewVersion!==p.reviewVersion)throw Object.assign(Error('此工作已按另一审校版本接受'),{code:'REVIEW_VERSION_STALE'});
          if(w.closure.requestKey!==p.requestKey)throw Object.assign(Error('此工作已按另一确认身份接受'),{code:'REVIEW_REQUEST_COLLISION'});
          return {accepted:true,workId:work.id,revision:w.revision,decision:'accept',merge:reviewMergeProjection(w.closure),mergeConsent:mergeConsentState(w),duplicate:true};
        }
        throw Object.assign(Error('工作已结束且非审校接受路径；请使用原有收尾重试'),{code:'WORK_ENDED'});
      }
      if(w.readOnly)throw Object.assign(Error('历史执行资源只读'),{code:'HISTORICAL_SESSION_READ_ONLY'});
      if(p.objectId!==(w.result?.objectId??null)||receipt.stale)throw Object.assign(Error('此报告已被取代；只能在最新发布上接受'),{code:'REVIEW_CANDIDATE_STALE'});
      const current=await this.#reviewVersionNow(w,receipt);
      if(!current?.snapshot)throw Object.assign(Error('缺少冻结候选，不能接受'),{code:'CANDIDATE_REQUIRED'});
      if(p.reviewVersion!==current.version)throw Object.assign(Error('审校版本已变化（草稿或候选已更新）；请重新读取后确认'),{code:'REVIEW_VERSION_STALE'});
      const capability=workDisposition(this.store.state,w).accept;
      if(!capability.allowed)throw Object.assign(Error(capability.message||'当前不可接受'),{code:capability.reasonCode||'ACCEPT_UNAVAILABLE'});
      await this.validateLocalIdentity(work.id);
      const drafts=activeDrafts(w);
      const reviewedFiles=current.snapshot.files.map(f=>{const d=drafts[f.relPath]&&drafts[f.relPath].objectId===receipt.objectId?drafts[f.relPath]:null;return {relPath:f.relPath,candidateDigest:f.candidateDigest,candidateMode:f.candidateMode,reviewedDigest:d?.textDigest??f.candidateDigest,draftRevision:d?.revision??null};});
      // P1原子性：决定、人工版本绑定、Orchestrator队列入账同一durable事务。
      await this.store.end(work.id,{by:'user',revision:w.revision,decision:'accept',binding:dispositionBinding(w),requestKey:p.requestKey,reviewed:{reviewVersion:p.reviewVersion,objectId:p.objectId,files:reviewedFiles},validateAdmission:()=>{const gate=workDisposition(this.store.state,this.store.find(work.id)).accept;if(!gate.allowed)throw Object.assign(Error(gate.message||'explicit decision required'),{code:gate.reasonCode||'ACCEPT_UNAVAILABLE'});}});
      this.changed();
      return null;
    }).then(async replay=>{
      if(replay)return replay;
      // drain在work锁之外驱动：队列自身按work串行，避免同work锁自等死锁。
      await this.drainMergeQueue();
      const w=this.store.find(work.id);
      return {accepted:true,workId:work.id,revision:w.revision,decision:'accept',merge:reviewMergeProjection(w.closure),mergeConsent:mergeConsentState(w),closure:structuredClone(w.closure)};
    });
  }
  async reconcileAcceptedFiles(id,{files,requestKey}={}){return this.workLocked(id,async()=>{
    const w=this.store.find(id),m=await this.execution.readManifest(id);
    if(w.status!=='ended'||w.closure?.decision!=='accept'||w.closure.git?.complete||!m?.candidate||m.finishIntent||m.acceptancePreparation||typeof requestKey!=='string'||!REVIEW_REQUEST_KEY.test(requestKey)||!Array.isArray(files)||!files.length||new Set(files.map(f=>f?.relPath)).size!==files.length)throw Error('明确接受的未合入候选与核对文件不可缺失，进行中的Git事务不得改写');
    await this.execution.identity(m);
    if(w.closure.reviewedVersion)throw Error('已有人工审校版本；不能由目标核对覆盖');
    const rows=[];
    for(const file of files){
      if(!m.candidate.files.includes(file.relPath)||typeof file.text!=='string'||Buffer.byteLength(file.text)>8*1024*1024)throw Error('核对仅限原候选文件');
      const target=await safeBytes(m.repo,file.relPath);if(target===null)throw Error('目标文件缺失，不能核对覆盖');const targetDigest=hashOfBytes(target);
      if(targetDigest!==file.expectedDigest)throw Error('核对期间目标正文变化，未授权覆盖');
      const bytes=Buffer.from(file.text,'utf8');
      rows.push({relPath:file.relPath,text:file.text,digest:hashOfBytes(bytes),targetDigest,candidateCommit:m.candidate.commit,inputCommit:m.inputCommit,targetHead:m.targetHead});
    }
    const version=hashOf(rows),key='managed:accepted-reconciliation:'+id+':'+version;
    await this.store.storage.putRecovery(this.projectId,key,{version,rows,requestKey});
    await this.store.mutate(()=>{w.closure.reconciledReview={version,key,requestKey};w.closure.mergeAuthorization.reviewVersion=version;});
    return {accepted:true,workId:id,version};
  });}
  // 人工审校覆盖层：durable草稿字节→Git blob。无模型参与，缺字节即拒绝合入。
  async #materializeReviewed(w){
    if(w.closure.reconciledReview){
      const saved=await this.store.storage.getRecovery(this.projectId,w.closure.reconciledReview.key);
      if(!saved||saved.version!==w.closure.reconciledReview.version||hashOf(saved.rows)!==saved.version)throw Error('核对正文恢复证据不一致');
      const manifest=await this.execution.readManifest(w.id),files=[];
      for(const row of saved.rows){const bytes=Buffer.from(row.text,'utf8');if(hashOfBytes(bytes)!==row.digest)throw Error('核对正文摘要不一致');files.push({relPath:row.relPath,oid:await this.execution.blob(manifest.repo,bytes),digest:row.digest,mode:'100644'});}
      return {version:saved.version,files,reconciliation:saved.rows.map(({text,...row})=>row)};
    }
    const m=await this.execution.readManifest(w.id);
    if(!m?.repo)throw Object.assign(Error('缺少执行清单；无法合入人工审校版本'),{code:'CANDIDATE_REQUIRED'});
    const reviewed=w.closure.reviewedVersion;
    const record=await readDraftRecord(this.store.storage,this.store.projectId,w.id);
    const files=[];
    for(const entry of reviewed.files||[]){
      if(entry.draftRevision==null)continue;
      const text=draftTextFor(record,entry.relPath,entry.draftRevision);
      if(text===null)throw Object.assign(Error('人工审校正文缺失；候选与决定已保留，不做猜测合入'),{code:'REVIEW_DRAFT_RECOVERY'});
      const {bytes,digest}=reviewDraftBytes(text);
      if(digest!==entry.reviewedDigest)throw Object.assign(Error('人工审校正文与接受绑定不一致；资源已保留'),{code:'REVIEW_VERSION_STALE'});
      files.push({relPath:entry.relPath,oid:await this.execution.blob(m.repo,bytes),digest,mode:entry.candidateMode??'100644'});
    }
    return {version:reviewed.reviewVersion,files};
  }
  // 崩溃恢复：未收口的续作意图按durable计划幂等重放（worktree摘要守卫）后走
  // 同一收口事务；失败保留blocked现场，绝不重复应用、绝不新建Work。
  async resumeReviewContinuations(){
    for(const snapshot of (this.store.state.works||[]).filter(w=>w.review?.continuations?.some(c=>['applying','blocked'].includes(c.state)))){
      await this.workLocked(snapshot.id,async()=>{
        const w=this.store.find(snapshot.id);
        for(const record of (w.review?.continuations||[]).filter(c=>['applying','blocked'].includes(c.state))){
          try{
            if(w.status==='ended'){await this.store.mutate(()=>{record.state='abandoned';record.error??={code:'WORK_ENDED',message:'工作已结束；续作意图保留为历史'};});continue;}
            if(!['paused','review'].includes(w.status))continue;
            const m=await this.execution.prepare(w.id);
            // 恢复前核对plan与账本草稿仍一致：新保存/轮换后的旧意图不自动
            // 套用（保持blocked待人工处理），绝不把别的版本悄悄写进worktree。
            for(const f of record.files||[]){
              const active=w.review?.drafts?.[f.relPath];
              if(active&&(active.objectId!==record.objectId||active.revision!==f.draftRevision))throw Object.assign(Error('续作计划与当前草稿不一致；保留阻断状态待人工处理'),{code:'REVIEW_CONTINUE_STALE'});
            }
            const draftRecord=await readDraftRecord(this.store.storage,this.store.projectId,w.id);
            const plan=[];
            for(const f of record.files||[]){
              const text=draftTextFor(draftRecord,f.relPath,f.draftRevision);
              if(text===null)throw Object.assign(Error('草稿正文缺失：'+f.relPath),{code:'REVIEW_DRAFT_RECOVERY'});
              plan.push({relPath:f.relPath,fromDigest:f.fromDigest,toDigest:f.toDigest,draftRevision:f.draftRevision,bytes:Buffer.from(text,'utf8')});
            }
            await this.execution.applyReviewedFiles(m,plan);
            const result=await this.store.reviewContinueState(w.id,{requestKey:record.requestKey});
            if(!result.duplicate&&!result.abandoned){this.changed();this.kick();}
          }catch(error){
            await this.store.mutate(()=>{record.state='blocked';record.error={code:error.code||null,message:error.message};});
            this.emit('diagnostic','审校续作恢复保留现场：'+error.message);
          }
        }
      });
    }
  }
  async validateAcceptSource(id){
    const w=this.store.find(id),receipt=this.store.state.receipts.find(r=>r.workId===id&&r.objectId===w.result?.objectId&&r.revision===w.revision&&r.kind==='result');
    if(!receipt?.snapshot?.candidate||receipt.snapshot.candidate.commit!==w.execution?.candidate?.commit)throw Error('Acceptance requires a final Worker report bound to the frozen candidate');
    const capability={project:{id:this.projectId,root:this.store.content},storage:this.store.storage,runtime:this.store.root,objectId:receipt.objectId,controller:this,currentController:()=>this};
    const source=await managedReportSource(capability),manifest=await source.readManifest();
    for(const file of receipt.snapshot.files||[])await managedArtifact(capability,{objectId:receipt.objectId,relPath:file.relPath});
    for(const reference of manifest.references||[])await source.readReference(reference.id);
  }
  async endWork(id,{revision,decision,binding,requestKey}={}){return this.workLocked(id,async()=>{
    const w=this.store.find(id);binding??=dispositionBinding(w);requestKey??=`internal:${id}:${revision}:${decision}`;
    if(!sameDispositionBinding(binding,dispositionBinding(w))||revision!==w.revision)throw Error('stale disposition binding');
    // 旧路径接受必须检测人工草稿：有人工审校版本时拒绝，避免漏合入（staleaccept）。
    if(decision==='accept'&&w.status!=='ended'&&hasActiveDrafts(w))throw Object.assign(Error('此工作有人工审校草稿；请在报告审校中接受以合入人工版本，或先续作后再决定'),{code:'REVIEW_DRAFT_EXISTS'});
    if(w.status!=='ended'){
      const capability=workDisposition(this.store.state,w)[decision];if(!capability?.allowed)throw Error(capability?.message??'explicit decision required');
      await this.validateLocalIdentity(id);
    }
    if(w.status==='ended'&&!w.closure?.decision)await this.validateLocalIdentity(id);
    await this.store.end(id,{by:'user',revision,decision,binding,requestKey,validateAdmission:()=>{const current=this.store.find(id);if(current.status==='ended'&&!current.closure?.decision&&decision==='discard')return;const capability=workDisposition(this.store.state,current)[decision];if(!capability?.allowed)throw Error(capability?.message??'explicit decision required');}});this.changed();
    await this.advanceClosure(id);return {accepted:true,status:'ended',outcome:w.outcome,closure:structuredClone(w.closure)};
  });}
  async retryClosure(id,{binding,requestKey}={}){return this.workLocked(id,async()=>{const w=this.store.find(id);binding??=dispositionBinding(w);requestKey??=w.closure?.requestKey;if(w.status!=='ended'||!['accept','discard'].includes(w.closure?.decision)||!w.closure.binding||!sameDispositionBinding(binding,w.closure.binding)||!sameDispositionBinding(binding,dispositionBinding(w))||typeof requestKey!=='string')throw Error('work has no matching immutable closure confirmation');await this.store.mutate(()=>{const row=(this.store.state.mergeQueue||[]).find(e=>e.workId===id);if(row&&row.status==='blocked'){row.status='pending';row.retriedAt=new Date().toISOString();}});await this.advanceClosure(id);return true;}).then(async()=>{await this.drainMergeQueue();return {accepted:true,status:'ended',closure:structuredClone(this.store.find(id).closure)};});}
  // Orchestrator合入协调器（P1）：持久mergeQueue的宿主驱动器。接受在
  // store.end 内原子登记exact reviewVersion；本方法串行、幂等地把队列交给
  // 既有host closure/Git整合（无模型批准门），冷启动与每次登记后重驱。
  drainMergeQueue(){
    if(this.mergeDrain)return this.mergeDrain;
    const operation=(async()=>{
      for(;;){
        const pending=(this.store.state.mergeQueue||[]).filter(e=>e.status==='pending');
        if(!pending.length)break;
        let progressed=false;
        for(const entry of pending){
          await this.workLocked(entry.workId,async()=>{
            const w=this.store.find(entry.workId);
            const row=(this.store.state.mergeQueue||[]).find(e=>e.workId===entry.workId);
            if(!row||row.status!=='pending')return;
            if(w.status!=='ended'||!w.closure?.reviewedVersion){await this.store.mutate(()=>{row.status='blocked';row.lastError='工作未按人工审校接受结束；队列保留待核对';});progressed=true;return;}
            if(w.closure.git?.complete||w.closure.merge?.status==='merged'){await this.store.mutate(()=>{Object.assign(row,{status:'done',actor:'orchestrator',executor:'host',drainedAt:new Date().toISOString()});});progressed=true;return;}
            // 合入同意前置检查：明确never-commit未获一次性人工覆盖时不驱动
            // 整合（零写入），直接保留可解析的阻断行；覆盖请求确保已暴露。
            const consent=mergeConsentState(w);
            if(consent.required&&consent.status!=='approved'){
              const unresolved=w.mergeConstraint?.mode==='unresolved';
              const code=consent.status==='denied'?'MERGE_CONSENT_DENIED':'MERGE_CONSENT_REQUIRED';
              const message=consent.status==='denied'?'用户已拒绝此工作的合入覆盖；决定、候选与人工审校版本完整保留':unresolved?'合入约束策略待确认（'+w.mergeConstraint.origin+'）；请在待办中一次性选择 never-commit/hold/none，原请求未改写':(consent.origin==='legacy-untrusted'?'旧版“不提交Git”限制无法溯源，未自动解除；':'此工作带有明确的“不提交Git”约束；')+'本地合入需在专门待办中一次性批准（绑定当前候选），原请求未改写';
              if(unresolved)await this.#ensureMergeConstraintTodo(entry.workId,w);
              else if(!consent.request)await this.#ensureMergeConsentRequest(entry.workId,w);
              await this.store.mutate(()=>{
                const work=this.store.find(entry.workId);
                if(work.closure?.merge&&work.closure.merge.status!=='merged'){work.closure.merge.status='blocked';work.closure.merge.blockedCode=code;work.closure.merge.message=message;}
                const current=(this.store.state.mergeQueue||[]).find(e=>e.workId===entry.workId);
                if(current){current.status='blocked';current.lastError=message;}
              });
              progressed=true;return;
            }
            // 驱动一开始就如实标注Orchestrator协调：驱动窗口内的任何读取都不得
            // 把真实宿主Git合入误显示为 actor:null（仅完成后补标）。
            await this.store.mutate(()=>{row.drains=(row.drains||0)+1;Object.assign(row,{actor:'orchestrator',executor:'host'});const work0=this.store.find(entry.workId);if(work0.closure?.merge){work0.closure.merge.actor='orchestrator';work0.closure.merge.executor='host';}});
            try{await this.advanceClosure(entry.workId);}
            finally{
              await this.store.mutate(()=>{
                const current=(this.store.state.mergeQueue||[]).find(e=>e.workId===entry.workId),work=this.store.find(entry.workId);
                if(!current)return;
                Object.assign(current,{actor:'orchestrator',executor:'host'});
                if(work.closure?.merge){work.closure.merge.actor='orchestrator';work.closure.merge.executor='host';}
                if(work.closure?.merge?.status==='merged')Object.assign(current,{status:'done',drainedAt:new Date().toISOString()});
                else if(work.closure?.merge?.status==='blocked')Object.assign(current,{status:'blocked',lastError:work.closure.merge.message});
                else if(current.drains>=3)Object.assign(current,{status:'blocked',lastError:'多次驱动后仍未落定；队列保留待核对'});
                progressed=true;
              }).catch(()=>{});
            }
          });
        }
        if(!progressed)break;
      }
    })().finally(()=>{this.mergeDrain=null;});
    this.mergeDrain=operation;
    return operation;
  }
  // 续作指令草稿（UI独立durable存储）：按objectId命名空间读取/CAS——新发布
  // 未写过就返回revision 0/空串（绝不把旧发布指令静默带给新报告）；旧发布
  // 自己的指令仍可读。正文按版本append进recovery记录，账本CAS失败不丢旧文。
  async #instructionRecord(workId){
    const record=await this.store.storage.getRecovery(this.store.projectId,'managed:review-instruction:'+workId);
    return record&&Array.isArray(record.entries)?record:{schema:1,workId,entries:[]};
  }
  async reviewInstructionRead(p={}){
    const work=this.#reviewWork(p.objectId,p.workId);
    const w=this.store.find(work.id);
    const mirror=w.review?.instruction;
    const requested=p.objectId??(w.result?.objectId??null);
    const record=await this.#instructionRecord(work.id);
    if(mirror&&mirror.objectId===requested){
      const hit=record.entries.find(e=>e.objectId===requested&&e.revision===mirror.revision);
      return {workId:work.id,objectId:requested,revision:mirror.revision,text:hit?.text??'',savedAt:mirror.savedAt??null};
    }
    // 非当前命名空间：返回该发布自己的最新可见版本；从未写过则为空。
    const seen=[...record.entries].reverse().find(e=>e.objectId===requested);
    return {workId:work.id,objectId:requested,revision:seen?.revision??0,text:seen?.text??'',savedAt:seen?.savedAt??null};
  }
  async reviewInstructionSave(p={}){
    if(typeof p.objectId!=='string'||!p.objectId)throw Object.assign(Error('需要当前报告标识'),{code:'INVALID_PAYLOAD'});
    if(typeof p.text!=='string'||p.text.length>8000)throw Object.assign(Error('指令草稿必须是≤8000字符的文本'),{code:'INVALID_PAYLOAD'});
    if(!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<0)throw Object.assign(Error('指令草稿版本号无效'),{code:'INVALID_PAYLOAD'});
    const work=this.#reviewWork(p.objectId,p.workId);
    return this.workLocked(work.id,async()=>{
      const w=this.store.find(work.id);
      if(w.status==='ended')throw Object.assign(Error('工作已结束；指令草稿不再修改'),{code:'WORK_ENDED'});
      if(w.readOnly)throw Object.assign(Error('历史执行资源只读'),{code:'HISTORICAL_SESSION_READ_ONLY'});
      // 只绑定该Work当前结果发布；忙碌回合与旧发布都不接受（防串写/伪装）。
      if(p.objectId!==(w.result?.objectId??null))throw Object.assign(Error('指令草稿只属于当前待审发布'),{code:'REVIEW_CANDIDATE_STALE'});
      if(w.status==='running'||this.#reviewBusy(work.id))throw Object.assign(Error('工作正在执行；请等回合结束后再保存续作指令'),{code:'WORK_BUSY'});
      const mirror=w.review?.instruction;
      const current=mirror&&mirror.objectId===p.objectId?mirror.revision:0;
      if(p.expectedRevision!==current)throw Object.assign(Error('指令草稿版本已变化，请重新读取'),{code:'REVIEW_INSTRUCTION_STALE',currentRevision:current});
      const {digest}=reviewDraftBytes(p.text),at=new Date().toISOString();
      // 字节先落：按版本append（上限40条），账本事务内CAS复核。
      const record=await this.#instructionRecord(work.id);
      record.entries.push({objectId:p.objectId,revision:current+1,text:p.text,textDigest:digest,savedAt:at});
      await this.store.storage.putRecovery(this.store.projectId,'managed:review-instruction:'+work.id,{schema:1,workId:work.id,entries:record.entries.slice(-40)});
      const saved=await this.store.reviewInstructionState(work.id,{objectId:p.objectId,textDigest:digest,expectedRevision:current});
      this.changed();
      return {accepted:true,workId:work.id,objectId:p.objectId,revision:saved.revision,savedAt:saved.savedAt};
    });
  }
  advanceClosure(id){
    if(this.closures.has(id))return this.closures.get(id);
    const promise=this.finishClosure(id).finally(()=>this.closures.delete(id));this.closures.set(id,promise);return promise;
  }
  async blockClosure(id,message){await this.store.mutate(()=>{const w=this.store.find(id);w.closure.phase='blocked';w.closure.error=message;const old=this.store.state.todos.find(t=>t.workId===id&&t.kind==='closure'&&t.status==='open');if(old)old.text=message;else this.store.state.todos.push({id:randomUUID(),workId:id,kind:'closure',status:'open',text:message});});try{await this.store.updateClosureArchive(id);}catch(error){this.emit('diagnostic','Closure metadata retained for retry: '+error.message);}this.changed();}
  async finishClosure(id){
    const w=this.store.find(id);if(w.status!=='ended'||!w.closure||w.closure.phase==='complete')return;
    try{
      if(!w.closure.binding||!sameDispositionBinding(w.closure.binding,dispositionBinding(w)))throw Error('Closure confirmation binding missing or changed; resources retained');
      if(!w.closure.stopped){
        await this.store.mutate(()=>{w.closure.phase='stopping';});
        await this.terminals.get(id)?.close();if(this.starting.has(id))await this.starting.get(id).catch(()=>{});
        const session=this.sessions.get(id),record=this.store.state.providers?.[id],slots=[...(this.processBudget?.slots??[])].filter(slot=>slot.projectId===this.projectId&&slot.target===id);
        let receipt;
        if(session){receipt=await session.stop();if((session.pid||session.groupRecord?.pid||record||slots.length)&&receipt?.confirmationComplete!==true)throw Error('Worker process exit is not confirmed; resources retained');}
        else if(record){const recovery=await (record.kind==='pi-node'?recoverPiProvider(record,this.store.root):['omp-rpc','omp-tui'].includes(record.kind)?recoverOmpProvider(record,this.store.root):recoverProvider(record,this.store.root));if(recovery.verified!==true)throw Error('Persisted Worker owner exit is not confirmed');receipt={confirmationComplete:true,recovery};}
        else if(slots.length)throw Error('Process budget owner lacks verifiable provider identity; resources retained');
        if(this.running.has(id))await this.running.get(id);
        if(this.starting.has(id)||this.current.has(id)||this.sessions.get(id)?.busy)throw Error('Worker execution remains in flight');
        await this.checkpoint('provider-stopped',{workId:id});
        await this.store.mutate(()=>{delete this.store.state.providers[id];});
        for(const slot of slots)this.processBudget?.release(slot);
        await this.store.markStopped(id,{at:new Date().toISOString(),...(receipt?{confirmed:true,provider:receipt}:{ownership:'no-recorded-native-owner'})});this.sessions.delete(id);
      }
      if(w.closure.decision==='accept')try{await this.validateAcceptSource(id);}catch(error){throw Error('Acceptance requires intact frozen report bytes; no current-file fallback ('+error.message+'); resources retained');}
      await this.store.archiveReport(id);await this.checkpoint('report-archived',{workId:id});
      await this.timeline.drain();
      for(const receipt of this.store.state.receipts.filter(r=>r.workId===id&&r.changeSetId))await this.changes.verify(receipt.changeSetId);
      if(!['accept','discard'].includes(w.closure.decision))throw Error('Legacy outcome is uncertain; explicit user disposition is required. Resources preserved.');
      if(!w.closure.git?.complete){
        await this.store.mutate(()=>{w.closure.phase='integrating';});
        // 结构化合入同意门（仅接受路径；丢弃不受影响）：明确never-commit在
        // 一次性人工覆盖批准前零写入阻断；未决策略（detected/legacy）以一次
        // 性约束选择待办为可解析出口，绝不误导“更新约束后再接受”。
        const consent=w.closure.decision==='accept'?mergeConsentState(w):{required:false,status:null,origin:null};
        if(consent.required&&consent.status!=='approved'){
          if(consent.status==='denied')throw Object.assign(Error('用户已拒绝此工作的合入覆盖；决定、候选与人工审校版本完整保留，原请求未改写'),{code:'MERGE_CONSENT_DENIED'});
          if(w.mergeConstraint?.mode==='unresolved'){
            await this.#ensureMergeConstraintTodo(id,w);
            throw Object.assign(Error('合入约束策略待确认（'+w.mergeConstraint.origin+'）；请在待办中一次性选择 never-commit/hold/none 后继续。决定、候选与人工审校版本完整保留，原请求未改写'),{code:'MERGE_CONSENT_REQUIRED'});
          }
          await this.#ensureMergeConsentRequest(id,w);
          throw Object.assign(Error('此工作带有明确的“不提交Git”约束'+(consent.origin==='legacy-untrusted'?'（旧限制无法溯源，未自动解除）':'')+'；本地合入需在专门待办中一次性批准（绑定当前候选），原请求未改写'),{code:'MERGE_CONSENT_REQUIRED'});
        }
        // Orchestrator协调：人工审校版本由宿主物化并交给仅宿主的Git整合；
        // 无模型批准门，无提示依赖；merge记录驱动 pending→merged|blocked。
        const reviewed=w.closure.reviewedVersion||w.closure.reconciledReview?await this.#materializeReviewed(w):null;
        const result=await this.execution.finish(w,{decision:w.closure.decision,reportPersisted:true,validateAcceptance:this.beforeAccept,isActive:()=>this.running.has(id)||this.starting.has(id)||this.sessions.has(id),...(reviewed?{reviewed}:{}),mergeAuthorization:w.closure?.mergeAuthorization??null});
        if(!result.cleaned)throw Error('Execution cleanup is incomplete; resources retained');
        await this.store.mutate(()=>{w.closure.git={...result,complete:true,at:new Date().toISOString()};w.closure.phase='cleanup';if(w.closure.merge&&w.closure.merge.status!=='merged'){w.closure.merge.status='merged';w.closure.merge.commit=result.commit??null;w.closure.merge.completedAt=new Date().toISOString();delete w.closure.merge.blockedCode;delete w.closure.merge.message;}});
      }
      if(w.closure.git?.status==='merged'&&!w.closure.provenance){
        const receipt=await this.afterAdoption?.(w,w.closure.git);
        await this.store.mutate(()=>{w.closure.provenance={complete:true,at:new Date().toISOString(),...(receipt?{receipt}:{})};});
        this.emit('files-changed',{workId:id,reason:'accepted-integration',files:w.closure.git.files||[],operations:w.closure.git.operations||[],revision:w.revision});
      }
      await this.store.cleanupWorkerHome(id);
      await this.store.mutate(()=>{w.closure.phase='complete';w.closure.completedAt=new Date().toISOString();delete w.closure.error;this.store.state.memoryPending=this.store.state.memoryPending.filter(x=>x!==id);for(const t of this.store.state.todos)if(t.workId===id&&t.kind==='closure'&&t.status==='open')t.status='resolved';});await this.store.updateClosureArchive(id);this.changed();this.kick();
    }catch(error){
      // 审校合入协调记录：失败可观测、可重试；绝不静默改口，绝不覆盖决定。
      try{await this.store.mutate(()=>{
        const work=this.store.find(id),merge=work.closure?.merge;
        if(merge&&merge.status!=='merged'){merge.status='blocked';merge.blockedCode=error.code||'CLOSURE_BLOCKED';const noConstraintHint=['MERGE_CONSENT_REQUIRED','MERGE_CONSENT_DENIED','MERGE_AUTHORIZATION_REQUIRED','MERGE_AUTHORIZATION_STALE'].includes(error.code);merge.message=String(error.message).slice(0,600)+(noConstraintHint?'':(work.closure.reviewedVersion?'（人工审校版本与候选已完整保留；未做任何Git合入，可在明确更新约束后重试）':''));merge.attempts.push({at:new Date().toISOString(),phase:'integration',code:error.code||null,error:String(error.message).slice(0,400)});}
      });}catch(recordError){this.emit('diagnostic','Merge record retention failed: '+recordError.message);}
      if(maintenanceBoundary(error)){await this.blockClosure(id,error.message);return;}
      const bug=await this.maintenance.record({phase:'closure',workId:id,revision:w.revision,error,capability:'closure'});
      const recoveryBinding=structuredClone(w.closure.binding),recoveryRequestKey=w.closure.requestKey;
      this.maintenanceActions.set(bug.id,async()=>{await this.retryClosure(id,{binding:recoveryBinding,requestKey:recoveryRequestKey});return this.store.find(id).closure?.phase==='complete';});
      await this.store.mutate(()=>{w.closure.phase='blocked';w.maintenance={bugId:bug.id,status:'detected',message:'技术收尾故障已交后台维修；原接受／丢弃决定保持。'};});await this.maintenanceEvent(bug);
    }
  }
  // 合入同意的一次性人工覆盖：待办暴露在workspace todos（kind 'merge-consent'），
  // 注意力/审计镜像进TaskPermissions效果台账（effectType 'merge-override'，
  // 冻结效果哈希绑定精确候选/审校版本集/仓库/目标ref）；台账缺失或形态不符
  // 只降级为诊断，绝不阻断收尾——持久权威在与决定同事务的闭包账本。
  async #ensureMergeConsentRequest(id,w){
    const authorization=w.closure?.mergeAuthorization;
    if(!authorization?.consentRequired||authorization.consent)return;
    const frozen={schema:1,effectType:'merge-override',workId:id,revision:authorization.revision,objectId:authorization.objectId??null,candidateCommit:authorization.candidateCommit??null,reviewVersion:authorization.reviewVersion??null,repo:authorization.repo??null,targetRef:authorization.targetRef??null,targetHead:authorization.targetHead??null};
    let requestId='merge-consent:'+id+':'+(authorization.candidateCommit??'none'),version=1,effectHash=hashOf(frozen);
    if(this.taskPermissions&&typeof this.taskPermissions.prepareEffect==='function'){
      try{
        const prepared=await this.taskPermissions.prepareEffect(this.projectId,{sourceJobId:null,permissionTaskId:'merge-consent:'+id,role:'host-closure',effectType:'merge-override',frozenEffect:frozen,ttlMs:null,reason:'一次性批准本地合入：候选 '+String(authorization.candidateCommit??'').slice(0,12)+(authorization.reviewVersion?'（人工审校版本已绑定）':'')});
        if(prepared?.request){requestId=prepared.request.id;version=prepared.request.version;effectHash=prepared.effectHash??effectHash;}
      }catch(error){this.emit('diagnostic','合入同意效果台账镜像失败：'+error.message);}
    }
    await this.store.ensureMergeConsentRequestState(id,{requestId,version,effectHash,at:new Date().toISOString()});
    const todo=this.store.state.todos.find(t=>t.kind==='merge-consent'&&t.workId===id&&t.status==='open');
    if(todo&&w.mergeConstraint?.classification==='never-commit')await this.store.mutate(()=>{todo.permissionPurpose='never-commit-override';});
  }
  // 用户决定端点：批准只恢复原closure/merge队列推进（不重放Worker、不改写
  // 原请求、不新建队列行）；拒绝保留阻断现场。requestKey幂等、版本绑定、
  // 绑定必须与落账授权完全一致（stale approval一律拒绝且零合入）。
  async resolveMergeConsent(id,{requestId,expectedVersion,action,requestKey,binding}={}){
    if(!['approve','deny'].includes(action))throw Object.assign(Error('合入同意决定动作无效'),{code:'INVALID_PAYLOAD'});
    if(typeof requestId!=='string'||!requestId||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw Object.assign(Error('合入同意请求身份无效'),{code:'INVALID_PAYLOAD'});
    if(typeof requestKey!=='string'||!REVIEW_REQUEST_KEY.test(requestKey))throw Object.assign(Error('合入同意确认身份无效'),{code:'INVALID_PAYLOAD'});
    if(!binding||typeof binding!=='object'||Array.isArray(binding))throw Object.assign(Error('合入同意绑定无效'),{code:'INVALID_PAYLOAD'});
    const result=await this.workLocked(id,async()=>{
      const resolved=await this.store.resolveMergeConsentState(id,{requestId,expectedVersion,action,requestKey,binding});
      const w=this.store.find(id),authorization=w.closure?.mergeAuthorization;
      if(this.taskPermissions&&typeof this.taskPermissions.decideEffect==='function'&&authorization?.request?.id===requestId){
        try{
          await this.taskPermissions.decideEffect(this.projectId,{requestId,expectedVersion,action:action==='approve'?'approve-once':'deny',requestKey,binding:{sourceJobId:null,taskCurrent:true}});
        }catch(error){this.emit('diagnostic','合入同意效果台账决定镜像失败：'+error.message);}
      }
      this.changed();
      return resolved;
    });
    if(result.status==='approved'&&!result.duplicate){await this.advanceClosure(id);await this.drainMergeQueue();}
    const w=this.store.find(id);
    return {...result,workId:id,action,merge:reviewMergeProjection(w.closure),closure:structuredClone(w.closure)};
  }
  // 约束策略待办确保存在（幂等）：未决策略（detected/legacy-unresolved）的
  // 合入阻断以一次性选择待办为可解析出口，绝不静默当作临时或永久。
  async #ensureMergeConstraintTodo(id,w){
    if(w.mergeConstraint?.mode!=='unresolved')return;
    await this.store.mutate(()=>{
      const work=this.store.find(id);
      if(work.mergeConstraint?.mode!=='unresolved')return;
      if(!this.store.state.todos.some(t=>t.workId===id&&t.kind==='merge-constraint'&&t.status==='open'))this.store.state.todos.push({id:randomUUID(),workId:id,revision:work.revision,kind:'merge-constraint',status:'open',constraintVersion:work.mergeConstraint.version,text:(work.mergeConstraint.origin==='legacy-unresolved'?'旧版“不提交Git”限制无法溯源；请一次性确认合入约束策略，原请求不改写。':'原文包含明确“永不提交”表述；请一次性确认这是“禁止合入直到另行授权”还是临时暂缓/无约束。')+'选项：never-commit（禁止合入直到另行授权）/ hold（临时暂缓，接受即本地合入）/ none（无约束）。'});
    });
  }
  // 用户约束策略端点：确认/设置/撤回（版本绑定CAS，requestKey幂等）。
  // hold/none 解除阻断并按原队列恢复合入；never-commit 保持合入需另经
  // 一次性merge-consent覆盖。绝不改写原请求，绝不重放Worker。
  async resolveMergeConstraint(id,{expectedVersion,choice,requestKey}={}){
    if(!mergeConstraintChoices.includes(choice))throw Object.assign(Error('合入约束选择无效'),{code:'INVALID_PAYLOAD'});
    if(typeof requestKey!=='string'||!REVIEW_REQUEST_KEY.test(requestKey))throw Object.assign(Error('合入约束确认身份无效'),{code:'INVALID_PAYLOAD'});
    const result=await this.workLocked(id,async()=>this.store.resolveMergeConstraintState(id,{expectedVersion,choice,requestKey}));
    this.changed();
    if(choice==='never-commit'&&!result.duplicate){const current=this.store.find(id);if(mergeConsentState(current).required&&!mergeConsentState(current).request)await this.#ensureMergeConsentRequest(id,current);}
    if(choice!=='never-commit'&&!result.duplicate){await this.advanceClosure(id);await this.drainMergeQueue();}
    const w=this.store.find(id);
    return {...result,workId:id,merge:reviewMergeProjection(w.closure),mergeConsent:mergeConsentState(w)};
  }
  canReclaimIdle(target,session,{hiddenTerminal=false}={}){
    return !this.stopping&&this.sessions.get(target)===session&&!this.running.has(target)&&!this.current.has(target)&&!this.starting.has(target)&&!this.restarting?.has(target)&&!this.configuring.has(target)&&!this.configuring.has('worker')&&!this.reclaiming.has(target)&&!this.nativeDraftTargets.has(target)&&!this.externalTerminalTargets.has(target)&&(hiddenTerminal||!this.terminals.has(target))&&!session.busy&&!session.currentTicket&&!session.blockedTicket&&!session.inFlightToolCalls?.size&&!this.store.state.jobs.some(job=>job.target===target&&['queued','running'].includes(job.status));
  }
  reclaimIdle(target,options){
    const session=this.sessions.get(target);if(!session||!this.canReclaimIdle(target,session,options))return Promise.resolve(false);
    const operation=(async()=>{
      await this.terminals.get(target)?.close();
      const receipt=await (session.stopIdle?session.stopIdle():session.stop());await session.controllerExitCleanup;
      if(session.pid&&receipt?.confirmationComplete!==true)throw Object.assign(Error('空闲 Agent 退出尚未确认，名额保留'),{code:'PI_EXIT_UNCONFIRMED'});
      if(this.sessions.get(target)===session)this.sessions.delete(target);
      await this.store.mutate(()=>{delete this.store.state.providers[target];});this.changed();return true;
    })().finally(()=>this.reclaiming.delete(target));this.reclaiming.set(target,operation);return operation;
  }
  async stop({lifecycleHold}={}){
    if(lifecycleHold){
      // Do not trust a project id or a serialized operation id as authority.
      this.store.storage.withLifecycleOwner(this.projectId,lifecycleHold,()=>{this.store.lifecycleHold=lifecycleHold;});
    }
    if(this.stopPromise)return this.stopPromise;
    this.stopping=true;this.changed();
    clearTimeout(this.timelineTimer);this.timelineTimer=null;
    const settled=async promises=>{const results=await Promise.allSettled(promises),failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;};
    const operation=(async()=>{
      if(this.taskPermissions){const ledger=await this.taskPermissions.read(this.projectId);for(const grant of ledger.grants??[])this.privilegeBroker?.revoke?.({grantId:grant.id});for(const taskId of new Set((ledger.grants??[]).map(grant=>grant.permissionTaskId)))await this.taskPermissions.endTask(this.projectId,taskId);}
      const stopped=new Set(),stopOwners=async()=>settled([...this.sessions.entries()].filter(([target])=>!stopped.has(target)).map(async([target,s])=>{const receipt=await s.stop();await s.controllerExitCleanup;if((s.pid||s.groupRecord?.pid)&&receipt?.confirmationComplete!==true)throw Object.assign(Error('Agent exit unconfirmed; provider ownership retained'),{code:'PI_EXIT_UNCONFIRMED',target});stopped.add(target);}));
      await settled([stopOwners(),settled([...this.terminals.values()].map(t=>t.close())),Promise.allSettled([...this.starting.values()]),settled([...this.reclaiming.values()])]);
      await stopOwners();
      await settled([...this.running.values()]);await Promise.allSettled([...this.closures.values()]);
      for(const target of stopped)delete this.store.state.providers[target];
      await this.store.storage.putLocal(this.projectId,'managed:providers',this.store.state.providers??{});
      if(Object.keys(this.store.state.providers??{}).length)throw Object.assign(Error('Unverified provider ownership retained'),{code:'PI_EXIT_UNCONFIRMED'});
      await this.store.close();this.store.lifecycleHold=null;return {stopped:[...stopped],confirmationComplete:true};
    })();this.stopPromise=operation;
    try{return await operation;}catch(error){if(this.stopPromise===operation)this.stopPromise=null;throw error;}
  }
}
