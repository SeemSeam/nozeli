export function dispositionBinding(work){return {workId:work.id,revision:work.revision,objectId:work.result?.objectId??null,candidateCommit:work.execution?.candidate?.commit??null};}
export function sameDispositionBinding(a,b){return Boolean(a&&b&&['workId','revision','objectId','candidateCommit'].every(key=>a[key]===b[key]));}
export function workDisposition(state,work,{localState='available',sessionState='notStarted'}={}){
 const binding=dispositionBinding(work),gate=(allowed,reasonCode,message)=>({allowed,reasonCode,message});
 const ended=work.status==='ended',blocked=work.readOnly===true;
 const jobs=(state.jobs??[]).filter(j=>j.target===work.id&&j.revision===work.revision),receipt=(state.receipts??[]).find(r=>r.workId===work.id&&r.revision===work.revision&&r.objectId===binding.objectId&&r.kind==='result');
 const sourceId=receipt?.sourceJobId??receipt?.jobId,source=jobs.find(job=>job.id===sourceId);
 const transportSettled=job=>(job.collabAttempts??[]).every(attempt=>attempt.definitiveRejection===true||attempt.status==='settled');
 const settled=Boolean(sourceId&&source?.status==='completed'&&receipt?.snapshot?.candidate?.jobId===sourceId&&jobs.every(j=>['completed','cancelled'].includes(j.status)&&transportSettled(j)));
 const accept=blocked?gate(false,'HISTORICAL_SESSION_READ_ONLY','历史执行资源只读'):ended?gate(false,'WORK_ENDED','决定已记录'):!receipt||!binding.candidateCommit||receipt.snapshot?.candidate?.commit!==binding.candidateCommit?gate(false,'RESULT_BINDING_REQUIRED','需要当前版本与冻结候选一致的结果报告'):!settled?gate(false,'TURN_UNSETTLED','执行回合尚未明确成功结算'):gate(true,'LOCAL_VERIFICATION_REQUIRED','可发起接受；宿主将核实来源、进程与Git');
 const discard=blocked?gate(false,'HISTORICAL_SESSION_READ_ONLY','历史执行资源只读'):ended?gate(false,'WORK_ENDED','决定已记录'):gate(true,'LOCAL_VERIFICATION_REQUIRED','可发起丢弃；宿主将核实资源身份与进程');
 const pending=ended&&['accept','discard'].includes(work.closure?.decision)&&work.closure.phase!=='complete';
 const retryClosure=pending&&!work.closure.binding?gate(false,'LEGACY_CONFIRMATION_UNVERIFIED','旧版决定缺少原始确认绑定；决定、证据和资源已保留，不能猜测当前报告后重试'):pending?gate(true,'LOCAL_VERIFICATION_REQUIRED','可重试原决定的技术收尾'):gate(false,'NO_RETRYABLE_CLOSURE','没有待收尾决定');
 return {localState,sessionState,binding,accept,discard,retryClosure};
}
