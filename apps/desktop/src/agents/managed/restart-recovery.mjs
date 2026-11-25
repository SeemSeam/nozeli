// Accepted input is not a draft. Restart can admit an unsent queue entry once.
// Admitted Work turns may use verified native continuation; business intake cannot.
import {ordinaryIntake,neverAdmitted,intakeAdmissionProven,intakeReceipt} from './intake-reconciliation.mjs';
export {neverAdmitted};
// A retained recovery decision gates the whole execution target, including a
// later queued input. Sending new text is not reconciliation of an old effect.
export function explicitRecoveryHeld(state,job){
 if(!job)return false;
 const bound=job.context?.boundWorkId??job.context?.workId??job.target;
 return job.recoveryRequiresExplicitInput===true||
  (state.works??[]).some(work=>(work.id===bound||work.id===job.target)&&work.recoveryRequiresExplicitInput===true)||
  (state.jobs??[]).some(other=>other.recoveryRequiresExplicitInput===true&&
   (other.target===job.target||other.target===bound||other.context?.boundWorkId===bound||other.context?.workId===bound));
}
export function holdInterruptedExecution(job,work,recovery){
 if(['queued','running','transferring','interrupted'].includes(job.status)){
  Object.assign(job,{status:'interrupted',recoveryRequiresExplicitInput:true,automaticReplay:false});
  if(recovery)job.restartRecovery={...job.restartRecovery,...recovery,kind:'needs-reconciliation'};
 }
 if(work){
  if(['queued','running'].includes(work.status))work.status='paused';
  Object.assign(work,{recoveryRequiresExplicitInput:true,automaticReplay:false});
 }
}
export function reconcileColdIntake(state,job){
 if(!ordinaryIntake(job)&&!(job.type==='intake'&&job.context?.restrictedMode==='handoff-dispatch'))return false;
 const receipt=intakeReceipt(state,job);
 if(receipt||job.intakeWithdrawal){
  if(['queued','running','transferring'].includes(job.status)||job.status==='interrupted'&&job.interruptionReason==='host-stopped'){
   job.status=receipt?'completed':'cancelled';job.finishedAt??=receipt?.at??job.intakeWithdrawal?.at;
   if(receipt)job.completion='host-route-reconciled';
  }
  return true;
 }
 if(job.status==='transferring')return true; // Source stop/settlement is owned by finalizeTransfers.
 if(['queued','running'].includes(job.status)||job.status==='interrupted'&&job.interruptionReason==='host-stopped'){
  if(!job.context?.retryOf&&intakeAdmissionProven(job)){
   job.status='queued';delete job.startedAt;
   job.restartRecovery={kind:'never-admitted',sourceJobId:job.id};
   return true;
  }
  job.status='interrupted';
 }
 if(!intakeAdmissionProven(job)&&['failed','interrupted','cancelled','unknown'].includes(job.status)){
  job.chatFault='CHAT_EFFECT_UNKNOWN';
  job.restartRecovery={...job.restartRecovery,kind:'needs-reconciliation',sourceJobId:job.id};
 }
 return true;
}
export function bindNativeUserEntries(state,records=state.sessionIndex?.entries??[]){
 for(const record of records){
  if(record.ownership!=='verified'||record.speaker!=='user'||typeof record.entryId!=='string'||!record.entryId)continue;
  const job=state.jobs?.find(j=>j.id===record.jobId&&j.target===record.target);
  const attempt=job?.collabAttempts?.find(a=>a.kind==='prompt'&&a.requestId===record.requestId&&a.sessionId===record.sessionId&&a.epoch===record.epoch);
  if(!attempt)continue;
  if(attempt.nativeEntryId&&attempt.nativeEntryId!==record.entryId){attempt.nativeEntryConflict=true;continue;}
  attempt.nativeEntryId=record.entryId;attempt.nativeUserEntryConfirmed=true;attempt.everAdmitted=true;
 }
}
export function restoreExecutionIntents(state){
 bindNativeUserEntries(state);
 for(const job of state.jobs??[]){
  if(explicitRecoveryHeld(state,job)){
   if(['queued','running','transferring'].includes(job.status))holdInterruptedExecution(job,null);
   continue;
  }
  if(reconcileColdIntake(state,job))continue;
  const hostInterrupted=job.status==='interrupted'&&(job.interruptionReason==='host-stopped'||job.restartRecovery?.kind==='needs-reconciliation'||job.error==='Cold start never replays accepted inputs'||job.error==='宿主退出，未自动重放');
  if(!['queued','running'].includes(job.status)&&!hostInterrupted||['git','curate'].includes(job.type))continue;
  const work=(state.works??[]).find(w=>w.id===job.target||w.id===job.context?.boundWorkId);
  const executionOwner=['frontdesk','orchestrator'].includes(job.target)?state.residents?.[job.target]:(state.works??[]).find(w=>w.id===job.target);
  if(job.chat&&!['closing','ended'].includes(work?.status)){
   // Reopen preserves the queue exactly; interrupted admission is not a new
   // send. Native evidence is still retained for explicit reconciliation.
   if(neverAdmitted(job)){job.status='queued';delete job.startedAt;continue;}
   job.status='interrupted';job.chatFault='CHAT_EFFECT_UNKNOWN';
   job.restartRecovery={kind:'needs-reconciliation',sourceJobId:job.id};
   if(work)work.restartRecovery=job.restartRecovery;
   continue;
  }
  if(work&&['review','closing','ended'].includes(work.status)){job.status='interrupted';continue;}
  if(neverAdmitted(job)){
   job.status='queued';delete job.startedAt;
   job.restartRecovery={kind:'never-admitted',sourceJobId:job.id};
  }else{
   job.status='queued';
   job.restartRecovery={...job.restartRecovery,kind:'native-continuation',sourceJobId:job.id,threadId:executionOwner?.threadId??null,revision:job.revision??null};
  }
 }
 for(const work of state.works??[]){
  if(work.status!=='running'||(state.jobs??[]).some(j=>j.target===work.id&&['queued','running'].includes(j.status)))continue;
  if(work.chatSettlementJobId&&(state.jobs??[]).some(j=>j.id===work.chatSettlementJobId&&j.target===work.id&&j.revision===work.revision&&j.status==='completed'))continue;
  work.restartRecovery={kind:'needs-reconciliation',reason:'No exact unfinished native job is recorded; progress and original status retained'};
 }
}
