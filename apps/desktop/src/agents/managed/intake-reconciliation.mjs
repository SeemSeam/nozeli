import {intakeLineage} from '../../domain/managed-work-records.mjs';

export const ordinaryIntake=job=>job?.type==='intake'&&job.target==='orchestrator'&&!job.context?.restrictedMode;
export const neverAdmitted=job=>job.promptStartedAt==null&&job.delivery?.phase!=='native-record-confirmed'&&!(job.collabAttempts??[]).some(a=>a.kind!=='abort'&&(a.everAdmitted||a.recordConfirmed||a.nativeEntryId||!a.definitiveRejection));
export const intakeAdmissionProven=job=>job.restartRecovery?.kind!=='needs-reconciliation'&&job.chatFault!=='CHAT_EFFECT_UNKNOWN'&&job.recoveryRequiresExplicitInput!==true&&neverAdmitted(job)&&(job.promptStartedAt===null||job.collabAttempts?.some(a=>a.kind==='prompt'&&a.definitiveRejection&&a.requestId&&a.sessionId&&a.epoch));
export const activeIntake=job=>['running','transferring'].includes(job.status);

export function intakeReceipt(state,job){
 // A committed Work can outlive an old/incomplete job receipt. Read it back;
 // never infer a Work from a display name or a previously selected binding.
 const work=(state.works??[]).find(w=>w.sourceJob===job.id||w.sourceInputJobIds?.includes(job.id)||w.inputs?.some(input=>input.sourceJobId===job.id||input.sourceInputJobIds?.includes(job.id)));
 if(work&&(!job.routing||job.routing.action==='clarify'))return {action:work.sourceJob===job.id?'dispatch':'existing-work',workId:work.id};
 if(job.routing&&(job.routing.action!=='status'||job.status==='completed'))return job.routing;
 // Exact retry and approved-effect edges refer to this input, not unrelated new instructions.
 const related=new Map([[job.id,job]]);
 for(const other of state.jobs??[]){
  if(other.type!=='intake')continue;
  const source=related.get(other.context?.effectSourceJobId);
  const effect=source?.intakePermissionWait&&source.intakePermissionWait.requestId===other.context?.effectRequestId;
  if(!effect&&!related.has(other.context?.retryOf))continue;
  related.set(other.id,other);
  if(effect&&other.routing&&(other.routing.action!=='status'||other.status==='completed'))return other.routing;
  if(other.routing?.workId&&['dispatch','continue'].includes(other.routing.action))return other.routing;
  const existing=(state.works??[]).find(w=>w.sourceJob===other.id);
  if(existing)return {action:'existing-work',workId:existing.id};
 }
 return null;
}

export function assertUnroutedIntake(state,job,{dispatch=false}={}){
 if(job.intakeWithdrawal||job.context?.retryOf||job.restartRecovery?.kind==='needs-reconciliation'||intakeReceipt(state,job))throw Object.assign(Error('原请求已有处置或需要核对，未执行新的路由。'),{code:'INTAKE_RECONCILIATION_REQUIRED'});
 if(dispatch){
  const chain=intakeLineage(state,job),root=chain[0].id;
  for(const other of state.jobs){
   if(other.id===job.id||other.type!=='intake'||intakeLineage(state,other)[0].id!==root)continue;
   const prior=intakeReceipt(state,other);
   if(other.intakeWithdrawal||prior&&(prior.action!=='clarify'||!chain.some(ancestor=>ancestor.id===other.id)))throw Object.assign(Error('同一原请求已明确处置或已有工作，不再次派工。'),{code:'INTAKE_RECONCILIATION_REQUIRED'});
  }
 }
}

export function intakeReconciliation(state,jobId,{projectInstanceId,storageBlocked=false,readOnly=false,active=false}={}){
 const job=(state.jobs??[]).find(row=>row.id===jobId&&ordinaryIntake(row));
 if(!job)throw Object.assign(Error('当前项目没有此原请求。'),{code:'INTAKE_NOT_FOUND'});
 const receipt=storageBlocked?null:intakeReceipt(state,job),attempt=job.collabAttempts?.findLast(a=>a.kind==='prompt'&&!a.definitiveRejection),lastRequest=attempt??job.collabAttempts?.findLast(a=>a.kind==='prompt');
 const recorded=attempt&&(state.sessionIndex?.entries??[]).find(r=>r.ownership==='verified'&&r.speaker==='user'&&r.jobId===job.id&&r.target===job.target&&r.requestId===attempt.requestId&&r.sessionId===attempt.sessionId&&r.epoch===attempt.epoch);
 const entryId=attempt?.nativeEntryId??(job.delivery?.phase==='native-record-confirmed'&&job.delivery.requestId===attempt?.requestId?job.delivery.text?.entryId:null);
 const nativeEntryId=attempt?.nativeEntryConflict||entryId&&recorded?.entryId&&entryId!==recorded.entryId?null:entryId??recorded?.entryId??null;
 const effectUnknown=storageBlocked||job.intakeWithdrawal?.effectUnknown===true||job.chatFault==='CHAT_EFFECT_UNKNOWN'||(!receipt&&(!intakeAdmissionProven(job)||Boolean(nativeEntryId)));
 const status=storageBlocked?'needs-reconciliation':receipt?'routed':job.intakeWithdrawal?'withdrawn':(job.status==='queued'&&!effectUnknown&&!job.context?.retryOf||activeIntake(job)&&active)?'pending':'needs-reconciliation';
 const route=receipt?{action:receipt.action,workId:receipt.workId??null,at:receipt.at??null}:null;
 return {jobId:job.id,requestId:lastRequest?.requestId??job.delivery?.requestId??null,projectInstanceId,status,nativeEntryId,nativeSessionId:lastRequest?.sessionId??null,route,errorCode:storageBlocked?'STORAGE_RESULT_UNKNOWN':job.errorCode??(effectUnknown&&!receipt?'CHAT_EFFECT_UNKNOWN':null),effectUnknown,storageBlocked,canWithdraw:!receipt&&!job.intakeWithdrawal&&!storageBlocked&&!readOnly&&!active&&job.status!=='transferring'};
}

export function withdrawIntakeState(state,jobId,{projectInstanceId,active=false,storageBlocked=false}={}){
 const view=intakeReconciliation(state,jobId,{projectInstanceId,active,storageBlocked});
 if(view.status==='withdrawn')return view;
 if(!view.canWithdraw)throw Object.assign(Error('原请求仍在运行、已有路由或本机回执待核对，未撤回。'),{code:'INTAKE_WITHDRAWAL_BLOCKED'});
 const job=state.jobs.find(row=>row.id===jobId),at=new Date().toISOString();
 job.intakeWithdrawal={at,projectInstanceId,requestId:view.requestId,nativeEntryId:view.nativeEntryId,effectUnknown:view.effectUnknown};
 if(['queued','running'].includes(job.status))Object.assign(job,{status:'cancelled',interruptionReason:'intake-withdrawn',finishedAt:at});
 return intakeReconciliation(state,jobId,{projectInstanceId});
}
