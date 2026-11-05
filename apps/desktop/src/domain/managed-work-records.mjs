import {deviationHeld,deviationPresentation} from './work-deviation.mjs';
// A projection of durable jobs/routes/Works/publications, never a second queue.
export function intakeLineage(state,job){
 const chain=[job],seen=new Set([job.id]);let cursor=job;
 while(cursor.context?.routingQuestionId||cursor.context?.retryOf||cursor.context?.pendingIntakeId){
  const sourceId=cursor.context.retryOf||cursor.context.pendingIntakeId||state.todos?.find(t=>t.id===cursor.context.routingQuestionId&&t.kind==='routing')?.sourceJobId;
  const source=state.jobs?.find(j=>j.id===sourceId&&j.type==='intake');if(!source)break;
  if(seen.has(source.id))throw Error('routing clarification lineage cycle');seen.add(source.id);chain.unshift(source);cursor=source;
 }
 return chain;
}
export const recordExcerpt=(value,size=120)=>String(value||'').replace(/\s+/g,' ').trim().slice(0,size);
const reviewExcerpt=value=>recordExcerpt(String(value||'').replace(/```[\s\S]*?```/g,' ').replace(/!?(\[([^\]]+)\])\([^)]*\)/g,'$2').replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/[*_`>]/g,''),180);
// The protocol envelope is execution evidence, not the user's request title.
export function intakeRequestText(state,job){
 const original=intakeLineage(state,job)[0],source=(state.messages||[]).find(message=>message.id===original.context?.sourceMessageId);
 return original.context?.userGoal||source?.text||original.text||'';
}
export const intakeSystemFault=job=>Boolean(job?.maintenanceBugId||job?.maintenanceFault);
const todoPhases={'frontdesk-route':'前台去向 · 等待用户决定',deviation:'任务偏离 · 等待用户决定',result:'报告待审查',problem:'等待回答',routing:'需要明确目标',recovery:'执行待恢复',git:'Git 待处理',closure:'收尾待处理','merge-constraint':'合并策略 · 等待用户决定',system:'系统异常待处理'};
// A publication and its round's settlement are independent durable facts.
// Only the exact current Work/receipt/job binding can expose this exception.
export function resultSettlementIssue(state,work){
 if(!work||work.readOnly||!['paused','review'].includes(work.status)||!Number.isInteger(work.revision)||work.result?.revision!==work.revision||!work.result?.objectId)return null;
 const receipt=state.receipts?.find(r=>r.kind==='result'&&r.workId===work.id&&r.objectId===work.result.objectId&&r.revision===work.revision);
 const job=receipt&&state.jobs?.find(j=>j.id===receipt.jobId&&j.target===work.id&&j.revision===work.revision);
 if(!job||!['failed','interrupted','unknown'].includes(job.status))return null;
 return {objectId:receipt.objectId,jobId:job.id,status:job.status,error:typeof job.error==='string'?job.error:''};
}
// Read-only publication numbering identity: one published report's ordinal
// among its Work's same-kind publication receipts, mapped by the exact
// objectId. Receipts are the durable publication ledger, so successive
// same-revision publications each keep their own number and nothing here
// rewrites persisted todos, objects, refs, raw report bytes or Work revision.
// A receipt absent from the ledger means incomplete history: no ordinal is
// invented and callers keep their recorded revision facts instead.
export function publicationOrdinal(state,workId,objectId,kind='result'){
 if(kind!=='result'&&kind!=='problem')return null;
 if(typeof workId!=='string'||typeof objectId!=='string'||!objectId)return null;
 const rows=(state?.receipts||[]).filter(row=>row?.workId===workId&&row.kind===kind);
 const index=rows.findIndex(row=>row.objectId===objectId);
 return index>=0?index+1:null;
}
// Human edits saved for this exact publication: review drafts bound to the
// same objectId and differing from its frozen candidate digest, mirroring the
// review surface's own outdated detection. Read-only like the numbering.
export function publicationHumanEdited(state,todo){
 if(todo?.kind!=='result'||typeof todo.objectId!=='string'||!todo.objectId)return false;
 const work=(state?.works||[]).find(work=>work.id===todo.workId);
 const drafts=work?.review?.drafts?Object.entries(work.review.drafts):[];
 if(!drafts.length)return false;
 const receipt=(state?.receipts||[]).find(row=>row?.objectId===todo.objectId&&row.kind==='result'&&row.workId===todo.workId);
 const files=new Map((receipt?.snapshot?.files||[]).map(file=>[file.relPath,file.digest??null]));
 return drafts.some(([relPath,draft])=>draft?.objectId===todo.objectId&&draft.textDigest!==files.get(relPath));
}
// One numbering identity for every entry surface (review DTO, review todos,
// inbox, notifications, immutable history labels). Result/problem publications
// carry their exact-object publication ordinal; other kinds keep the persisted
// Work revision round. Incomplete history keeps the recorded revision label
// rather than an invented ordinal.
export function publicationVersionLabel(state,todo){
 if(todo?.kind==='result'||todo?.kind==='problem'){
  const ordinal=publicationOrdinal(state,todo.workId,todo.objectId,todo.kind);
  return ordinal?'第 '+ordinal+' 版':todo.revision!=null?'第 '+todo.revision+' 版':'';
 }
 return todo?.revision!=null?'第 '+todo.revision+' 版':'';
}
// Current-publication identity, shared by every read-only surface: a report
// object is current only when the Work's active publication pointer names that
// exact objectId at the Work's current revision. Anything else — including an
// older object republished within the same revision — is history.
export function publicationIsCurrent(state,workId,objectId,kind='result'){
 if(kind!=='result'&&kind!=='problem')return false;
 if(typeof workId!=='string'||typeof objectId!=='string'||!objectId)return false;
 const work=(state?.works||[]).find(work=>work.id===workId);
 if(!work||!Number.isInteger(work.revision))return false;
 const publication=work[kind];
 return publication?.revision===work.revision&&publication.objectId===objectId;
}
// One eligibility boundary for list, badge, notifications and opening actions.
// Backstage records remain durable, but are not questions for the reader.
export function userTodoEligible(todo){
 if(!todo||todo.userActionable===false)return false;
 if(todo.kind==='result')return true;
 const destination=todo.destination;
 if(destination?.kind==='effect-permission')return true;
 if(todo.kind==='merge-consent'&&['merge-conflict-override','never-commit-override'].includes(todo.permissionPurpose))return true;
 return destination?.kind==='conversation'&&destination.question?.method==='approve';
}
// A read-only inbox: backend identities and lifecycle remain authoritative.
export function managedReviewTodos(state){
 const todos=state.todos||[],works=state.works||[],jobs=state.jobs||[],receipts=state.receipts||[];
 const currentPublication=(todo,work)=>{
  if(work&&todo.kind==='result'&&work.status!=='review'&&!(work.status==='paused'&&resultSettlementIssue(state,work)?.objectId===todo.objectId))return false;
  if(work&&(['queued','running','closing','ended'].includes(work.status)||work.revision!=null&&todo.revision!=null&&work.revision!==todo.revision))return false;
  if(jobs.some(j=>(j.target===todo.workId||j.context?.boundWorkId===todo.workId)&&['queued','running'].includes(j.status)))return false;
  const publication=work?.[todo.kind];
  if(publication?.objectId)return publication.objectId===todo.objectId;
  const latest=todos.filter(t=>t.workId===todo.workId&&t.kind===todo.kind).reduce((latest,t)=>!latest||Number(t.revision||0)>=Number(latest.revision||0)?t:latest,null);
  return latest===todo;
 };
 return todos.filter(todo=>{
  if(todo.status!=='open'||!userTodoEligible(todo))return false;
  const work=works.find(w=>w.id===todo.workId);
  if(todo.kind==='deviation')return deviationHeld(work)&&work.deviation.todoId===todo.id;
  if(['result','problem'].includes(todo.kind))return currentPublication(todo,work);
  if(todo.kind==='routing'&&jobs.some(j=>j.context?.routingQuestionId===todo.id&&['queued','running'].includes(j.status)))return false;
  return true;
 }).map(todo=>{
  const work=works.find(w=>w.id===todo.workId),receipt=receipts.find(r=>r.objectId===todo.objectId&&todo.objectId),settlementIssue=todo.kind==='result'?resultSettlementIssue(state,work):null;
  const label=settlementIssue?'已保存结果 · 完成状态待核查':todo.kind==='frontdesk-route'?'前台去向决定':todo.kind==='deviation'?'任务偏离决定':todo.kind==='result'?'完成报告':todo.kind==='problem'?'待回答问题':todo.kind==='routing'?'主控澄清':todo.kind==='git'?'Git 事项':todo.kind==='closure'?'收尾异常':todo.kind==='merge-constraint'?'合入策略决定':todo.kind==='recovery'?'执行恢复':'系统异常';
 const publicationLabel=publicationVersionLabel(state,todo);
 return {...todo,title:todo.title||[work?.name||recordExcerpt(work?.request,56),label,publicationLabel].filter(Boolean).join(' · '),excerpt:receipt?.report?.excerpt||reviewExcerpt(todo.text),phase:settlementIssue?'结果已保存 · 完成状态待核查':todoPhases[todo.kind]||'待处理',actionableKind:todo.kind,publicationVersion:todo.kind==='result'||todo.kind==='problem'?publicationOrdinal(state,todo.workId,todo.objectId,todo.kind):null,publicationLabel,humanEdited:publicationHumanEdited(state,todo),...(settlementIssue?{settlementIssue}:{})};
 });
}
export function historicalResultReminder(state,todo){
 if(todo?.kind!=='result')return false;
 const work=(state.works||[]).find(work=>work.id===todo.workId);
 if(!work)return todo.status!=='open'||Boolean(todo.reopenedAt);
 return work.status==='ended'||work.revision!=null&&todo.revision!=null&&work.revision!==todo.revision||Boolean(work.result?.objectId&&work.result.objectId!==todo.objectId)||['iterating','superseded'].includes(todo.status);
}
// Reminder history and current user duties share the same audience boundary.
// Reopening a reminder never revives an ended Work or makes its report current.
export function managedInboxTodos(state){
 const current=new Map(managedReviewTodos(state).map(todo=>[todo.id,todo]));
 const works=new Map((state.works||[]).map(work=>[work.id,work]));
 const receipts=new Map((state.receipts||[]).map(receipt=>[receipt.objectId,receipt]));
 return (state.todos||[]).filter(userTodoEligible).map(todo=>{
  const work=works.get(todo.workId),receipt=receipts.get(todo.objectId),live=current.get(todo.id),pending=Boolean(live);
  const report=todo.kind==='result',hasReport=Boolean(todo.objectId),ended=work?.status==='ended';
  const finalizing=report&&work?.status==='closing'&&work.revision===todo.revision&&(work.result?.objectId===todo.objectId||work.closure?.binding?.objectId===todo.objectId);
  const historical=!pending&&!finalizing&&(report?historicalResultReminder(state,todo)||todo.status!=='open':true);
  const finalPublication=ended&&(work.result?.objectId===todo.objectId||work.closure?.binding?.objectId===todo.objectId);
  let statusLabel;
  if(pending)statusLabel=report?(live.settlementIssue?'结果已保存 · 状态待核查':'待审阅'):'待授权';
  else if(finalizing)statusLabel=(work.outcome==='discard'?'已丢弃':work.outcome==='accept'?'已接受':'审核决定已记录')+(work.closure?.phase==='blocked'?' · 收尾受阻，尚未结束':' · 收尾未完成');
  else if(report&&todo.status==='iterating')statusLabel='已续改 · 原结果保留';
  else if(report&&todo.status==='superseded')statusLabel='已被新版替代';
  else if(report&&finalPublication)statusLabel=work.outcome==='accept'?'已接受并结束':work.outcome==='discard'?'已丢弃并结束':'任务已结束';
  else statusLabel=({closed:'提醒已关闭',resolved:'已处理',cancelled:'事项已取消'})[todo.status]||(historical?'历史结果':'处理中 · 结果已保存');
  if(todo.status==='closed'&&finalPublication)statusLabel+=' · 提醒已关闭';
  if(historical&&todo.status==='open'&&todo.reopenedAt)statusLabel+=' · 历史提醒已重开';
  const actionLabel=report?(hasReport?'查看报告':'报告暂不可读取'):pending?'查看授权详情':'查看处理记录';
 const humanEdited=report&&publicationHumanEdited(state,todo);
 return {...todo,title:report?(work?.name||receipt?.report?.title||todo.title||'结果报告'):(todo.title||live?.title||'操作授权'),excerpt:receipt?.report?.excerpt||reviewExcerpt(todo.text),pending,historical,statusLabel,actionLabel,versionLabel:report?publicationVersionLabel(state,todo):'',publicationVersion:report?publicationOrdinal(state,todo.workId,todo.objectId,'result'):null,publicationLabel:report?publicationVersionLabel(state,todo):'',humanEdited,editLabel:humanEdited?'已保存人工改稿':'',icon:report?'file-text':pending?'shield-check':'archive',hasReport};
 });
}
// Host-authored merge-constraint decision todos gate ended-Work closure retry.
export const openMergeConstraintTodo=(state,workId)=>(state?.todos||[]).findLast(todo=>todo.kind==='merge-constraint'&&todo.workId===workId&&todo.status==='open');
const phases={queued:'排队中',running:'执行中',paused:'已暂停 · 进展已保留',review:'结果待审查',closing:'决定已记录 · 等待收尾',ended:'已结束'};
// Same occupancy rule as agents/managed/workspace.mjs workSlotFacts: this only
// explains why a queued Work waits; it never changes quota or release facts.
const slotHeld=work=>{if(!work)return false;
 if(work.status!=='ended')return work.status!=='queued'&&Number(work.revision)>0;
 if(work.closure?.phase==='complete')return false;
 if(work.revision===0&&work.closure?.binding?.revision===0&&work.closure.binding.workId===work.id&&!work.threadId&&!work.execution)return false;
 if(work.closure&&typeof work.closure.phase==='string'&&work.closure.phase)return true;
 return Number(work.revision)>0;};
const slotLabels={running:'执行中',paused:'暂停',review:'待审',closing:'收尾未完成','unverified-ended':'结束待核查','unverified-running':'执行待核查'};
export function managedWorkRecords(state){
 const jobs=state.jobs||[],works=state.works||[],todos=state.todos||[],receipts=state.receipts||[],records=new Map(),roots=new Map();
 const reviewTodos=managedReviewTodos(state);
 const root=job=>intakeLineage(state,job)[0].id;
 for(const w of works){
  const source=jobs.find(j=>j.id===w.sourceJob),id=source?'request:'+root(source):'work:'+w.id;
  const record={id,workId:w.id,name:w.name||recordExcerpt(w.request),status:w.status,phase:phases[w.status],description:recordExcerpt(w.request||source?.context?.userGoal||source?.text||w.brief),events:[],jobIds:[],todoId:(w.status==='ended'?todos.filter(t=>t.workId===w.id&&t.kind==='result'):reviewTodos.filter(t=>t.workId===w.id)).at(-1)?.id};
  records.set(id,record);if(source)roots.set(root(source),record);
 }
 for(const job of jobs.filter(j=>j.type==='intake')){
  const rootId=root(job),workId=job.routing?.workId||job.context?.boundWorkId,routed=workId&&[...records.values()].find(r=>r.workId===workId);
  if(routed)roots.set(rootId,routed);
 }
 const latestByRoot=new Map();for(const j of jobs.filter(j=>j.type==='intake'))latestByRoot.set(root(j),j);
 for(const job of jobs.filter(j=>j.type==='intake')){
  const rootId=root(job);if(latestByRoot.get(rootId)?.routing?.action==='status'&&!roots.has(rootId))continue;let record=roots.get(rootId);
  if(!record){
   // Read-only status requests are not independent work after management decides.
   if(job.routing?.action==='status')continue;
   record={id:'request:'+rootId,name:recordExcerpt(intakeRequestText(state,job),56)||'待安排请求',request:intakeRequestText(state,job),status:'pending',phase:'等待主控安排',events:[],jobIds:[]};roots.set(rootId,record);records.set(record.id,record);
  }
  record.jobIds.push(job.id);record.events.push({id:job.id+':accepted',at:job.at,text:job.context?.retryOf?'已接受重试':job.context?.routingQuestionId?'已收到澄清回答':job.routing?.action==='continue'?'已接收任务补充':'已接收后台请求'});
  if(job.transfer?.settledAt)record.events.push({id:job.id+':settled',at:job.transfer.settledAt,text:'前台已停稳，转交主控'});
  if(job.startedAt)record.events.push({id:job.id+':started',at:job.startedAt,text:'主控开始整理'});
  if(job.routing)record.events.push({id:job.id+':routed',at:job.routing.at,text:{dispatch:'已安排工作',continue:'补充已交给原工作',clarify:'主控请求澄清',cancel:'已接受用户撤销',status:'已查询状态'}[job.routing.action]});
  if(['failed','interrupted'].includes(job.status))record.events.push({id:job.id+':failed',at:job.finishedAt,text:job.status==='interrupted'?'主控处理被中断，未自动重放':'主控处理失败',detail:recordExcerpt(job.error)});
  if(!record.workId){
   // Native host-control settlement is not business routing or task completion.
   if(!job.routing&&intakeSystemFault(job)){
    const repair=job.maintenanceBugId&&jobs.findLast(candidate=>candidate.type==='maintenance'&&candidate.context?.bugId===job.maintenanceBugId);
    record.status=['failed','interrupted','unknown'].includes(job.status)?job.status:'blocked';
    record.maintenance={bugId:job.maintenanceBugId,status:repair?.status||'pending'};
    record.phase=['queued','running'].includes(repair?.status)?'系统正在处理运行问题 · 原请求已保留':'系统问题待处理 · 原请求已保留';
    record.description=recordExcerpt(record.request);delete record.todoId;delete record.retryJobId;
    record.events.push({id:job.id+':maintenance',at:job.finishedAt,text:'内部运行问题已交由系统处理',detail:recordExcerpt(job.error||job.maintenanceFault?.symptom)});continue;
   }
   const waiting=job.status==='transferring'?job:jobs.find(j=>j.id===job.context?.pendingIntakeId&&j.status==='transferring');
   if(waiting){record.status='transferring';record.phase=waiting.transfer?.error?'转交待处理，前台尚未停稳':'正在转交，等待前台停稳';record.description=recordExcerpt(waiting.transfer?.error||job.context?.userGoal||job.text);if(waiting.transfer?.error)record.retryJobId=waiting.id;continue;}
   const q=todos.find(t=>t.sourceJobId===job.id&&t.kind==='routing'&&t.status==='open');
   const pending=jobs.some(j=>j.type==='intake'&&j.context?.routingQuestionId===q?.id&&['queued','running'].includes(j.status));
   if(q&&!pending){record.status='blocked';record.phase='后台核对中 · 原请求已保留';record.description=recordExcerpt(q.text);delete record.todoId;delete record.retryJobId;}
   else if(['failed','interrupted','unknown'].includes(job.status)&&!job.routing){
    record.status=job.status;record.description=recordExcerpt(record.request);delete record.todoId;delete record.retryJobId;
    record.phase=job.status==='failed'?'处理受阻 · 原请求已保留':job.status==='unknown'?'执行状态待核查 · 原请求已保留':'处理被中断 · 原请求已保留';
   }
   else if(['queued','running'].includes(job.status)){record.status='pending';record.phase=job.status==='running'?'主控正在整理':state.drafts?.orchestrator||state.nativeDraftTargets?.includes('orchestrator')?'等待主控未发送草稿处理':'等待主控安排';record.description=recordExcerpt(record.request);delete record.maintenance;delete record.retryJobId;delete record.todoId;}
  }
 }
 const queued=works.filter(w=>w.status==='queued');
 for(const record of records.values()){
  const w=works.find(w=>w.id===record.workId);if(!w)continue;
  // Older rounds remain evidence, but cannot become this round's live fault.
  record.supersededJobIds=jobs.filter(j=>(j.target===w.id||j.context?.boundWorkId===w.id)&&Number.isInteger(w.revision)&&Number.isInteger(j.revision)&&j.revision<w.revision).map(j=>j.id);
  for(const j of jobs.filter(j=>j.target===w.id)){
   if(j.type!=='initial')record.events.push({id:j.id+':accepted',at:j.at,text:'已接收补充/回答'});
   if(j.startedAt)record.events.push({id:j.id+':started',at:j.startedAt,text:j.type==='initial'?'Worker 开始执行':'Worker 开始处理补充'});
  }
  for(const r of receipts.filter(r=>r.workId===w.id)){record.events.push({id:r.id+':published',at:r.at,text:r.kind==='deviation'?'已发布偏离问题报告；未完成任务':r.kind==='problem'?'已发布待回答问题':'已发布结果，等待用户审查'});}
  if(w.endedAt)record.events.push({id:w.id+':ended',at:w.endedAt,text:w.outcome==='accept'?'用户接受成果并结束，已释放名额':w.outcome==='discard'?'用户丢弃成果并结束，已释放名额':'工作已结束，成果处置见历史记录'});
  if(w.closure?.completedAt)record.events.push({id:w.id+':cleanup',at:w.closure.completedAt,text:'技术收尾已完成'});
 if(w.status==='queued'){
  const position=`排队第 ${queued.findIndex(q=>q.id===w.id)+1} 位`;
  const holders=works.filter(other=>other.id!==w.id&&slotHeld(other)).map(other=>({workId:other.id,name:other.name||recordExcerpt(other.request),status:other.status==='ended'?(other.closure?'closing':'unverified-ended'):other.status==='running'&&!jobs.some(job=>job.target===other.id&&job.status==='running'&&(job.revision==null||job.revision===other.revision))?'unverified-running':other.status}));
  const counts=new Map();for(const holder of holders)counts.set(holder.status,(counts.get(holder.status)||0)+1);
  const waiting=[...counts].map(([status,count])=>(slotLabels[status]||status)+' '+count+' 项').join('、');
  record.waitingOn=holders;
  record.phase=w.manualControl?.pause!=null?position+' · 已暂停调度，等待恢复':position+(waiting?' · 等待名额：'+waiting:' · 等待工作名额');
 }
 // “执行中”只来自当前修订确切的在册 job；没有执行依据时按待核查保守呈现。
 const liveJobs=jobs.filter(j=>j.target===w.id&&!record.supersededJobIds.includes(j.id)&&['queued','running'].includes(j.status));
 const executing=liveJobs.some(j=>j.status==='running');
 const pending=jobs.findLast(j=>(j.target===w.id&&j.type!=='initial'||j.context?.boundWorkId===w.id)&&['queued','running'].includes(j.status));
 if(pending){
  if(pending.target===w.id&&pending.status==='running')record.phase='正在处理补充';
  else if(w.status==='running'&&!liveJobs.length)record.phase='执行状态待核查 · 原请求与已保存内容保留';
  else if(executing)record.phase='执行中 · 补充已保存，本轮结束后处理';
  else if(w.status==='queued')record.phase=record.phase.split(' · ')[0]+' · '+(pending.type==='intake'?'补充已接收，等待主控整理':'补充已接收，等待执行');
  else if(w.status==='running')record.phase='已接收，等待开始执行 · 补充已保存';
  else record.phase=pending.type==='intake'?'补充已接收，等待主控整理':'补充已接收，等待执行';
 }else if(w.status==='running'){
  if(!liveJobs.length)record.phase='执行状态待核查 · 原请求与已保存内容保留';
  else if(!executing)record.phase=liveJobs.some(j=>j.type==='initial')?'已接收，等待开始执行':'等待继续执行 · 进展已保留';
 }
 const latestWorkerJob=jobs.findLast(j=>j.target===w.id&&!record.supersededJobIds.includes(j.id));
 if(w.status==='paused'&&!pending){
  if(jobs.some(j=>j.target===w.id&&j.resumeRequeue&&j.resumeRequeue.workRevision===w.revision))record.phase='系统修复已完成 · 等待恢复执行，进展已保留';
  else if(latestWorkerJob?.interruptionReason==='user-interrupted')record.phase='本轮已停止 · 等待明确补充';
 }
  const settlementIssue=resultSettlementIssue(state,w);
  if(settlementIssue){record.settlementIssue=settlementIssue;if(!pending&&!jobs.some(j=>j.target===w.id&&['queued','running'].includes(j.status)))record.phase='结果已保存 · 完成状态待核查';}
  const failedIntake=jobs.findLast(j=>j.context?.boundWorkId===w.id&&!record.supersededJobIds.includes(j.id)&&['failed','interrupted'].includes(j.status)&&!j.routing);if(failedIntake&&!['closing','ended'].includes(w.status)&&!pending&&!jobs.some(j=>j.context?.retryOf===failedIntake.id&&j.routing)){record.retryJobId=failedIntake.id;record.phase='补充处理失败，待重试';}
  if(deviationHeld(w)){record.phase='后台核对任务范围 · 进展已保留';record.deviation=w.deviation;delete record.todoId;delete record.retryJobId;}
 if(['closing','ended'].includes(w.status)){
  const closure=w.closure||{},decision=w.outcome||closure.decision;
  record.outcome=decision;record.closurePhase=closure.phase;
  record.needsReconciliation=w.needsReconciliation??null;
  // An ended Work is never presented as complete unless the host recorded a
  // finished closure; a pending merge-constraint strategy is the live gate.
  const constraintTodo=todos.findLast(t=>t.workId===w.id&&t.kind==='merge-constraint'&&t.status==='open');
  const strategy=constraintTodo?' · 待选择合并策略':closure.phase==='blocked'?' · 技术收尾受阻':closure.phase==='complete'?' · 技术收尾完成':['stopping','integrating','cleanup'].includes(closure.phase)?' · 技术收尾中':' · 技术收尾未完成';
  record.phase=w.needsReconciliation?'历史处置待核查':(decision==='accept'?'已接受':decision==='discard'?'已丢弃':'处置待核查')+(w.status==='ended'?'并结束':' · 等待收尾')+strategy;
  const failure=closure.error?.message||closure.error;if(failure)record.closureError=recordExcerpt(failure);
  const closureTodo=todos.findLast(t=>t.workId===w.id&&t.kind==='closure'&&t.status==='open');
  if(constraintTodo){record.todoId=constraintTodo.id;record.mergeConstraintTodoId=constraintTodo.id;}
  else if(closureTodo)record.todoId=closureTodo.id;
 }
 if(w.maintenance&&!deviationHeld(w)&&w.maintenance.status!=='repaired'&&w.closure?.phase!=='complete'){
  record.maintenance={status:w.maintenance.status,message:w.maintenance.message};
 // 只在有确切在册维修 job 时声称系统正在处理；其余按事实保留故障与进展。
 const repairLive=jobs.some(j=>j.type==='maintenance'&&j.context?.bugId===w.maintenance.bugId&&['queued','running'].includes(j.status));
 const label=repairLive?'系统正在处理运行问题，进展已保留':w.maintenance.status==='finalizing'?'维修已验证 · 收尾待完成，进展已保留':w.maintenance.status==='human-boundary'?'系统无法自动修复 · 需人工核对，进展已保留':w.maintenance.status==='cancelled'?'系统维修已取消 · 等待你的下一步，进展已保留':'系统问题待修复，进展已保留';
 record.phase=(w.status==='ended'?(w.outcome==='accept'?'已接受 · ':'已结束 · '):'')+label;
  record.description=w.maintenance.message||'已有进展保留，无需回答内部技术问题。';delete record.retryJobId;
 }
 }
 for(const record of records.values()){
  const work=works.find(work=>work.id===record.workId);
  const event=state.backstageEvents?.findLast(event=>event.status==='blocked'&&!record.supersededJobIds?.includes(event.sourceJobId)&&(event.revision==null||!work||event.revision===work.revision)&&(event.workId===record.workId&&record.workId||event.target===record.workId&&record.workId||event.sourceJobId&&record.jobIds.includes(event.sourceJobId)));
  if(!event)continue;
  record.backstage={status:event.status,kind:event.kind,reason:event.reason,sourceJobId:event.sourceJobId};
  if(!work||work.status==='paused'){
   record.phase=record.maintenance&&!work?record.phase:'后台受阻 · 进展已保留';record.description=!work?recordExcerpt(record.request):recordExcerpt(event.reason)||record.description;delete record.retryJobId;
  }
 }
 for(const record of records.values()){if(record.todoId&&!userTodoEligible(todos.find(todo=>todo.id===record.todoId)))delete record.todoId;let prior='';record.events=record.events.map((event,index)=>{prior=event.at||prior;return {event,index,time:prior};}).sort((a,b)=>a.time.localeCompare(b.time)||a.index-b.index).map(row=>row.event);record.at=record.events.find(e=>e.at)?.at;}
 return [...records.values()];
}
