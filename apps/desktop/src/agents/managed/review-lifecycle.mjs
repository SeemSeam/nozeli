import {dispositionBinding,sameDispositionBinding} from '../../domain/work-disposition.mjs';

// Labels (including endedBy:'user') are not evidence of a user decision. Only
// the durable exact-identity transaction can authorize closure resumption.
export function confirmedDisposition(work){
  const c=work?.closure;
  return Boolean(c&&['accept','discard'].includes(c.decision)&&work.outcome===c.decision&&c.revision===work.revision&&typeof c.requestKey==='string'&&/^[a-zA-Z0-9:_-]{8,160}$/.test(c.requestKey)&&c.binding&&sameDispositionBinding(c.binding,dispositionBinding(work)));
}
export function migrateReviewLifecycle(state){
  for(const work of state.works??[]){
    if(!['closing','ended'].includes(work.status))continue;
    const c=work.closure;
    const historical=work.legacyClosure??c;
    if(work.status==='ended'&&historical?.phase==='ended'&&historical.stopped===true&&historical.git?.complete===true&&work.curated===true){
      work.legacyClosure??=structuredClone(historical);
      work.closure={...structuredClone(historical),phase:'complete',historical:true,legacyOutcomeUnknown:true,completedAt:historical.completedAt??work.endedAt};
      state.memoryPending=(state.memoryPending??[]).filter(id=>id!==work.id);
      for(const todo of state.todos??[])if(todo.workId===work.id&&todo.kind==='closure'&&todo.status==='open'){todo.status='resolved';todo.resolution={status:'historical-closure-complete',at:work.closure.completedAt};}
      continue;
    }
    if(work.status==='ended'&&c?.phase==='complete')continue;
    if(confirmedDisposition(work)){
      if(work.status==='ended'){
        work.legacyEndedAt??=work.endedAt??null;
        work.status='closing';delete work.endedAt;
      }
      continue;
    }
    work.needsReconciliation??={code:'LEGACY_DISPOSITION_UNVERIFIED',message:'历史结束标签不证明人工决定；原报告、草稿、资源与事务证据保留，禁止自动重放或处置。'};
    state.todos??=[];
    if(!state.todos.some(t=>t.workId===work.id&&t.kind==='closure'&&t.status==='open'))state.todos.push({id:'closure-reconciliation:'+work.id,workId:work.id,revision:work.revision,kind:'closure',status:'open',text:work.needsReconciliation.message});
  }
}
