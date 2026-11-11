import {validateHtmlReportSyntax} from './html-report.mjs';

// Reconcile only a proven pre-publication syntax rejection superseded by a
// successful result in the same native thread. Never infer safety from age.
export async function reconcileReportRecovery(controller){
 const {store,timeline}=controller,resolutions=[];
 for(const todo of store.state.todos??[]){
  if(todo.kind!=='recovery'||todo.status!=='open')continue;
  const work=store.state.works.find(w=>w.id===todo.workId),old=store.state.jobs.find(j=>j.id===todo.sourceJobId);
  if(!work||work.status!=='review'||!old||old.target!==work.id||old.status!=='failed'||old.revision!==todo.revision||old.errorCode!=='PI_HOST_TOOL_FAILED'||old.hostToolCode!=='HTML_REPORT_INVALID'||old.failureOrigin!=='host')continue;
  const result=store.state.receipts.find(r=>r.objectId===work.result?.objectId&&r.workId===work.id&&r.kind==='result'&&r.revision===work.revision&&r.snapshot&&r.origin!=='host-diagnostic');
  const successor=result&&store.state.jobs.find(j=>j.id===(result.sourceJobId??result.jobId));
  if(!successor||successor.id===old.id||successor.target!==work.id||result.revision<=old.revision||store.state.receipts.some(r=>r.sourceJobId===old.id&&r.kind==='result'))continue;
  const attempt=old.collabAttempts?.at(-1),later=successor.collabAttempts?.at(-1);
  if(!attempt?.recordConfirmed||!later?.recordConfirmed||!work.threadId||attempt.sessionId!==work.threadId||later.sessionId!==work.threadId)continue;
  if((old.collabAttempts??[]).some(a=>['unknown','transport-unknown','unresolved'].includes(a.status)&&!(a===attempt&&a.status==='unknown'&&a.facts?.at(-1)?.reason==='PI_HOST_TOOL_FAILED')))continue;
  const records=timeline.records().filter(r=>r.jobId===old.id&&r.recordKind==='conversation').sort((a,b)=>a.sequence-b.sequence);
  if(records.length<2)continue;
  const end=records.at(-1),previous=records.at(-2);
  if(end.sessionId!==attempt.sessionId||end.requestId!==attempt.requestId||previous.sessionId!==end.sessionId||previous.requestId!==end.requestId)continue;
  const tail=(await timeline.object(end))?.message,assistant=(await timeline.object(previous))?.message;
  const calls=assistant?.content?.filter(b=>b.type==='toolCall');
  if(tail?.role!=='toolResult'||!tail.isError||tail.toolName!=='nozeli_publish'||assistant?.role!=='assistant'||calls?.length!==1||calls[0].name!=='nozeli_publish'||calls[0].id!==tail.toolCallId||calls[0].arguments?.kind!=='result')continue;
  let rejected=false;
  try{validateHtmlReportSyntax(calls[0].arguments.content);}catch(error){if(error.code!=='HTML_REPORT_INVALID')throw error;rejected=true;}
  if(!rejected)continue;
  resolutions.push({todo,old,work,result,successor,end});
 }
 if(!resolutions.length)return {resolved:[]};
 const resolved=await store.mutate(()=>{
  const ids=[];
  for(const {todo,old,work,result,successor,end} of resolutions){
   if(controller.stopping||store.closed||store.lifecycleHold||store.commitUnknown||store.nativeCommitUnknown)continue;
   if(todo.status!=='open'||todo.sourceJobId!==old.id||todo.workId!==work.id||work.status!=='review'||work.result?.objectId!==result.objectId||work.revision!==result.revision||old.status!=='failed'||old.revision!==todo.revision||!store.state.receipts.includes(result)||work.threadId!==old.collabAttempts?.at(-1)?.sessionId||work.threadId!==successor.collabAttempts?.at(-1)?.sessionId)continue;
   todo.status='resolved';todo.resolution={kind:'report-syntax-corrected',sourceJobId:old.id,successorJobId:successor.id,objectId:result.objectId,revision:result.revision,evidenceDigest:end.objectId,at:new Date().toISOString()};ids.push(todo.id);
  }
  return ids;
 });
 if(resolved.length)controller.changed();
 return {resolved};
}
