import {createHash,randomUUID} from 'node:crypto';
const fail=code=>Object.assign(Error(code),{code});
const controllerIncarnations=new WeakMap();
const scalar=value=>typeof value==='string'&&value.length<=256?value:null;
const statuses=new Set(['detected','repairing','finalizing','repaired','needs-version-fix','interrupted','cancelled','queued','human-boundary']);
const debugStates=new Set(['queued','running','awaiting-fix','model-unavailable','pending','continuing','continued-with-known-fault']);
export function validateMaintenancePage({limit=24,cursor=null}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>50||cursor!==null&&(typeof cursor!=='string'||!cursor||cursor.length>8192))throw fail('MAINTENANCE_PAGE_INVALID');
 return {limit,cursor};
}
export function maintenanceBinding(projectId,bug){return {projectId:scalar(bug.projectId),bugId:scalar(bug.id),fingerprint:scalar(bug.fingerprint),phase:scalar(bug.phase),jobId:scalar(bug.jobId),workId:scalar(bug.workId),revision:Number.isSafeInteger(bug.revision)?bug.revision:null};}
export function maintenanceLiveRevision(controller){
 if(!controller)return 'cold';
 let incarnation=controllerIncarnations.get(controller);if(!incarnation)controllerIncarnations.set(controller,incarnation=randomUUID());
 const state=controller.store?.state??{};
 const ownerIdentity=JSON.stringify([incarnation,[...(controller.maintenanceVerified?.keys?.()??[])]]);
 return createHash('sha256').update(ownerIdentity).update(JSON.stringify({stopping:!!controller.stopping,closed:!!controller.store?.closed,lifecycleHold:!!controller.store?.lifecycleHold,activity:controller.activitySequence??0,unknown:!!controller.store?.commitUnknown||!!controller.store?.nativeCommitUnknown,actions:[...(controller.maintenanceActions?.keys?.()??[])],flights:[...(controller.maintenanceFlights?.keys?.()??[])],host:[...(controller.hostOperations?.values?.()??[])],works:(state.works??[]).map(w=>[w.id,w.revision,w.status,w.readOnly,w.deviation?.status,w.manualControl?.version??0,w.manualControl?.pause!=null,w.manualControl?.stop?.state??null]),jobs:(state.jobs??[]).map(j=>[j.id,j.revision,j.status,j.target,j.manualControl?.pause!=null,(j.collabAttempts??[]).map(a=>a.status)]),todos:(state.todos??[]).map(t=>[t.workId,t.status,t.kind]),cold:[...(controller.coldJobs??[])],holds:['pendingEnds','bindingTransitions','handoffPreparing','handoffConfirmations','residentHandoffs','starting','restarting','reclaiming','configuring','nativeDraftTargets','externalTerminalTargets','running','current'].map(key=>[key,[...(controller[key]?.keys?.()??controller[key]??[])]])})).digest('hex');
}
export function maintenancePage({projectId,facts,controller=null,revision=facts.revision,nextCursor=facts.nextCursor}){
 const rows=facts.bugs.map(bug=>{
  const binding=maintenanceBinding(projectId,bug),status=!bug.metadataUnknown&&statuses.has(bug.status)?bug.status:'unknown';
  const complete=bug.projectId===projectId&&binding.bugId!==null&&binding.fingerprint!==null&&binding.phase!==null&&status!=='unknown';
  const capability=complete&&controller&&!controller.stopping?controller.maintenanceCapability?.(bug):null;
  const retry=capability?.retry===true;
  const retryMode=retry?(capability.retryMode==='finalize'?'finalize':'repair'):null;
  const retryReason=retry?null:scalar(capability?.retryReason)??(!controller?'owner-unavailable':controller.stopping?'owner-stopping':'unknown-maintenance-state');
  const inFlight=complete&&controller&&!controller.stopping&&controller.maintenanceFlights?.has(bug.id);
 // Active-processing claims come only from the exact registered debug event job
 // being queued/running on a live owner; stopped or cold events never show active.
 const debugState=complete&&debugStates.has(bug.debugState)?bug.debugState:null;
 const debugEventActive=debugState&&controller&&!controller.stopping&&(controller.store?.state?.jobs??[]).some(job=>job.id===bug.debugEventJobId&&job.type==='maintenance'&&['queued','running'].includes(job.status))===true;
 const debugLabels={'queued':'已交主控debug','running':'主控正在debug','awaiting-fix':'debug诊断已保存，系统待修复','model-unavailable':'debug模型不可用','pending':'系统debug待继续','continuing':'系统临时恢复执行中','continued-with-known-fault':'已临时恢复 · 原任务继续，源码问题待修复'};
 const debugStateLabel=debugState?['queued','running','continuing'].includes(debugState)?debugEventActive?debugLabels[debugState]:'系统debug待继续':debugLabels[debugState]:null;
 return {id:binding.bugId,projectId,workId:binding.workId,workRevision:binding.revision,jobId:binding.jobId,phase:binding.phase,status,stateLabel:status==='repaired'?'已修复':debugStateLabel??(inFlight?'系统正在处理运行问题':status==='repairing'?'原修复结果待核对':status==='detected'||status==='queued'?'等待系统处理':'系统问题待修复，进展已保留'),reason:status==='repaired'?null:retryReason,attemptCount:bug.attemptCount??bug.attempts?.length??0,maxAttempts:2,binding,debug:debugState?{state:debugState,eventJobId:scalar(bug.debugEventJobId),attemptId:scalar(bug.debugAttemptId),verifiedFix:false,active:debugEventActive}:null,capabilities:{retry,retryReason,retryMode}};
 });
 const summary={...facts.summary};
 if(!controller||controller.stopping){summary.blocked+=summary.inFlight+summary.queued;summary.inFlight=0;summary.queued=0;}
 const result={schema:1,projectId,revision,rows,total:facts.total,nextCursor,summary};
 if(Buffer.byteLength(JSON.stringify(result))>64*1024)throw fail('MAINTENANCE_PAGE_TOO_LARGE');
 return result;
}
