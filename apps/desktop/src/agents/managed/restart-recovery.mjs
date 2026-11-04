// The original accepted input is not a draft. Restart can admit a never-sent
// queue entry once; an admitted turn can only resume through native journal recovery.
export const neverAdmitted=job=>job.promptStartedAt==null&&!(job.collabAttempts??[]).some(a=>a.everAdmitted||!a.definitiveRejection);
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
  const hostInterrupted=job.status==='interrupted'&&(job.interruptionReason==='host-stopped'||job.restartRecovery?.kind==='needs-reconciliation'||job.error==='Cold start never replays accepted inputs'||job.error==='宿主退出，未自动重放');
  if(!['queued','running'].includes(job.status)&&!hostInterrupted||['git','curate'].includes(job.type))continue;
  const work=(state.works??[]).find(w=>w.id===job.target||w.id===job.context?.boundWorkId);
  const executionOwner=['frontdesk','orchestrator'].includes(job.target)?state.residents?.[job.target]:(state.works??[]).find(w=>w.id===job.target);
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
  work.restartRecovery={kind:'needs-reconciliation',reason:'No exact unfinished native job is recorded; progress and original status retained'};
 }
}
