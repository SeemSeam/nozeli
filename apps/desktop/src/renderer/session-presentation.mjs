// Display classification only: original records stay in the session store/read API.
export const hasReadableText=entry=>typeof entry?.text==='string'&&entry.text.trim().length>0;
export const isImportantEntry=entry=>Boolean(entry?.failed||entry?.error||entry?.question||entry?.status==='failed'||['error','failed'].includes(entry?.tool?.status));
export const isProcessEntry=entry=>!isImportantEntry(entry)&&(entry?.speaker==='tool'||Boolean(entry?.tool)||!hasReadableText(entry)&&entry?.availability!=='read-required'&&!entry?.attachments?.length);
export const hasProcessPayload=entry=>hasReadableText(entry)||entry?.availability==='read-required'||Boolean(entry?.reasoning)||Boolean(entry?.toolCalls?.length)||entry?.tool?.input!=null||entry?.tool?.output!=null;
export function processLabel(entry){
 const name=entry.tool?.name||entry.toolCalls?.map(call=>call.name||'工具').join('、')||(entry.reasoning?'推理记录':'执行记录');
 const state=entry.tool?.status||entry.status;
 return name+(state?' · '+({complete:'完成',completed:'完成',success:'完成',running:'执行中',pending:'等待',error:'失败',failed:'失败',cancelled:'已取消'}[state]||state):'');
}

const terminal=new Set(['completed','complete','failed','cancelled','canceled','aborted','interrupted','blocked']);
export const executionLabels=Object.freeze({queued:'排队中',starting:'启动中',thinking:'思考中',toolrunning:'工具执行中',waiting:'等待中',output:'输出中',completed:'已完成',failed:'失败',interrupted:'已中断',unknown:'状态未知',blocked:'受阻',debugging:'系统处理中',debugPending:'系统处理待继续',awaitingFix:'诊断已保存 · 等待系统修复',continuing:'临时恢复中',continued:'已临时恢复 · 原任务继续',modelUnavailable:'模型不可用'});
export function pendingTools(entries){
 const settled=new Set(entries.filter(entry=>entry.tool&&!['running','pending'].includes(entry.tool.status)).map(entry=>entry.tool.toolCallId).filter(Boolean));
 const calls=new Map();
 for(const entry of entries){
  for(const call of entry.toolCalls||[])if(!settled.has(call.id))calls.set(call.id||entry.id+':'+call.name,call.name||'工具');
  if(entry.tool&&['running','pending'].includes(entry.tool.status))calls.set(entry.tool.toolCallId||entry.id,entry.tool.name||'工具');
 }
 return [...calls.values()];
}
function readBlocked(entries,job){
 if(job?.readBudget?.status==='exhausted'&&['completed','blocked'].includes(job.status)&&!entries.some(entry=>entry.speaker==='agent'&&entry.complete&&hasReadableText(entry)&&!entry.toolCalls?.length))return true;
 return entries.some(entry=>{
  if(entry.hostControl===true&&entry.error||entry.tool?.hostControl===true&&entry.tool?.error)return true;
  const output=entry.tool?.output;
  if(typeof output!=='string'||output.length>65536)return false;
  try{const value=JSON.parse(output);return value?.ok===false&&value.hostControl===true&&typeof value.error?.code==='string';}catch{return false;}
 });
}
function deliveredResultWork(first,job,state){
 if(!job||job.status!=='completed')return null;
 const work=state?.works?.find(work=>work.id===job.target&&(!first.workId||first.workId===work.id));
 if(!work||!Number.isInteger(work.revision)||!Number.isInteger(job.revision)||first.revision!=null&&first.revision!==job.revision)return null;
 const receipt=state.receipts?.find(receipt=>receipt.kind==='result'&&receipt.workId===work.id&&receipt.jobId===job.id&&receipt.revision===job.revision&&receipt.objectId);
 if(!receipt)return null;
 if(job.revision===work.revision)return work.result?.revision===job.revision&&work.result.objectId===receipt.objectId?work:null;
 // Continued rounds clear/replace work.result; immutable frozen reports retain
 // their original object and job binding, not the newer round's review state.
 return job.revision<work.revision&&receipt.report?.objectId===receipt.objectId&&typeof receipt.report.digest==='string'&&/^[a-f0-9]{64}$/.test(receipt.report.digest)&&receipt.snapshot?.reportDigest===receipt.report.digest?work:null;
}
// System-owned debug/recovery projection. The ledger state bound onto the job
// is a host fact, but "processing" additionally requires the registered debug
// event job to be queued/running right now — a stopped or cold event never
// shows active work. Continuation is claimed only from the durable host
// recovery receipt on this exact job, never from model prose, and stays
// distinct from both failure and whole-Work completion.
const debugTurnStates=new Set(['queued','running','awaiting-fix','pending','model-unavailable','continuing','continued-with-known-fault']);
function debugTurnStatus(job,state){
 if(!job?.maintenanceBugId||!job?.debugEventJobId||!debugTurnStates.has(job.debugState))return null;
 if(['cancelled','canceled','aborted','interrupted'].includes(job.status))return null;
 const event=state?.jobs?.find(item=>item.id===job.debugEventJobId&&item.type==='maintenance');
 const active=Boolean(event)&&['queued','running'].includes(event.status);
 const continued=job.routing?.hostContinuation?.bugId===job.maintenanceBugId;
 if(job.debugState==='continued-with-known-fault')return continued?{status:'continued',terminal:true}:{status:'awaitingFix',terminal:true};
 if(job.debugState==='continuing')return active?{status:'continuing',terminal:false}:continued?{status:'continued',terminal:true}:{status:'awaitingFix',terminal:true};
 if(['queued','running'].includes(job.debugState))return active?{status:'debugging',terminal:false}:{status:'debugPending',terminal:false};
 if(job.debugState==='pending')return {status:'debugPending',terminal:false};
 if(job.debugState==='model-unavailable')return {status:'modelUnavailable',terminal:true};
 return {status:'awaitingFix',terminal:true};
}
export function turnPresentation(entries,state){
 const first=entries[0]||{},jobId=first.jobId;
 const job=state?.jobs?.find(job=>job.id===jobId||!jobId&&first.requestId&&job.collabAttempts?.some(attempt=>attempt.requestId===first.requestId&&attempt.sessionId===first.sessionId));
 const agent=job&&['running','transferring'].includes(job.status)?state?.agents?.find(agent=>agent.target===job.target&&(!first.sessionId||agent.threadId===first.sessionId)):null;
 let status='unknown';
 const deliveredWork=deliveredResultWork(first,job,state);
 const answered=job?.status==='completed'&&entries.some(entry=>entry.speaker==='agent'&&!entry.failed&&entry.status!=='failed'&&!entry.toolCalls?.length&&entry.complete&&hasReadableText(entry));
 // A genuinely answered turn keeps its real completion even with a stale bound debug ledger.
 const systemDebug=!answered&&debugTurnStatus(job,state);
 if(systemDebug)return {status:systemDebug.status,label:executionLabels[systemDebug.status],terminal:systemDebug.terminal,pending:[]};
 if(job?.status==='failed')status='failed';
 else if(['cancelled','canceled','aborted','interrupted'].includes(job?.status))status='interrupted';
 else if(job?.status==='unknown')status='unknown';
 else if(!answered&&entries.some(entry=>isImportantEntry(entry)&&(!deliveredWork||!entry.tool)))status='failed';
 else if(readBlocked(entries,job))status='blocked';
 else if(job?.status==='blocked')status='blocked';
 else if(['completed','complete'].includes(job?.status))status='completed';
 else if(job?.status==='queued')status='queued';
 else if(agent?.starting||agent?.restarting||job?.status==='starting')status='starting';
 else if(agent?.interactions?.length||job?.status==='waiting')status='waiting';
 else if(pendingTools(entries).length&&(job?.status==='running'||entries.some(entry=>entry.streaming)))status='toolrunning';
 else if(entries.some(entry=>entry.speaker==='agent'&&entry.streaming&&hasReadableText(entry)))status='output';
 else if(job?.status==='running'||entries.some(entry=>entry.speaker==='agent'&&entry.streaming&&entry.reasoning))status='thinking';
 else if(job?.status==='transferring')status='waiting';
 else if(!job&&entries.some(entry=>entry.speaker==='agent'&&!entry.toolCalls?.length&&entry.complete&&hasReadableText(entry)))status='completed';
 return {status,label:status==='completed'&&deliveredWork?(deliveredWork.revision===job.revision&&deliveredWork.status==='review'?'已交付 · 待审核':'已交付'):executionLabels[status],terminal:terminal.has(status),pending:terminal.has(status)?[]:pendingTools(entries)};
}
export function replyPresentation(entries,state){
 let answer=null;
 for(let i=entries.length-1;i>=0;i--){const item=entries[i];if(item.speaker==='system'&&item.text||item.speaker==='agent'&&(item.failed||item.status==='failed'||!item.tool&&!item.toolCalls?.length&&(hasReadableText(item)||item.availability==='read-required'))){answer=item;break;}}
 const last=entries.at(-1),model=entries.findLast(item=>item.speaker==='agent'&&item.model),execution=turnPresentation(entries,state);
 // Process-only rounds remain inspectable, without inventing an assistant reply.
 const entry=answer||{...last,speaker:'agent',text:'',availability:'available',tool:null,toolCalls:[],reasoning:null,provider:model?.provider,model:model?.model,modelStatus:model?.modelStatus};
 return {answer,entry,execution};
}
export function processSummary(entries,execution){
 const pending=execution.pending;
 return '执行过程 · '+entries.length+' 条记录'+(pending.length?' · '+pending.join('、')+'（'+pending.length+' 项待完成）':'');
}

const workStateLabels=Object.freeze({queued:'排队中',starting:'启动中',running:'执行中',paused:'等待处理',review:'待审查',closing:'结束中',ended:'已结束'});
// Orchestrator card projection: execution keeps turn semantics, activity is the
// truthful short current main-controller work, and handoff comes exclusively
// from the host routing receipt (job.routing) — never from model prose.
export function orchestratorPresentation(entries,state){
 const first=entries[0]||{},execution=turnPresentation(entries,state);
 const job=first.jobId?state?.jobs?.find(item=>item.id===first.jobId):null;
 const generic={queued:'排队中，尚未开始',starting:'启动中',waiting:'等待回答或处理',transferring:'等待回答或处理',blocked:'受阻',failed:'失败',cancelled:'已中断',canceled:'已中断',aborted:'已中断',interrupted:'已中断',unknown:'状态未知'};
 // System-owned debug/recovery turns keep the internal fault out of the user's
 // failure vocabulary; the original job status never re-crushes a live receipt.
 const systemActivities={debugging:'系统正在处理内部故障 · 原请求已保留',debugPending:'系统处理待继续 · 原请求已保留',awaitingFix:'系统诊断已保存 · 等待修复，原请求已保留',continuing:'系统正在临时恢复原任务',continued:'已临时恢复 · 原任务继续，源码问题仍待修复',modelUnavailable:'debug 模型不可用 · 等待处理模型恢复'};
 let activity;
 if(systemActivities[execution.status])activity=systemActivities[execution.status];
 else if(job&&generic[job.status])activity=generic[job.status];
 else if(job&&['completed','complete'].includes(job.status))activity=execution.status==='failed'?'本次处理未完成；已有记录保留':({dispatch:'已完成任务调度',continue:'已登记原工作的补充输入',clarify:'已提出澄清问题',cancel:'已登记结束请求',status:'已查询工作状态'}[job.routing?.action]||'本轮已结束，尚无已确认的交接');
 else if(job?.status==='running')activity=execution.pending.length?'正在调用：'+execution.pending.join('、'):'正在处理后台请求';
 else if(!job&&!execution.terminal&&execution.status!=='unknown')activity=execution.pending.length?'执行中 · '+execution.pending.join('、'):'执行中';
 else activity='状态未知';
 let handoff=null;
 const route=job?.routing;
 if(route&&['dispatch','continue','clarify','cancel','status'].includes(route.action)){
  const work=route.workId?state?.works?.find(item=>item.id===route.workId):null;
  const name=route.name||route.workName||work?.name||work?.request||null;
  // Current Work state only: a queued Worker stays queued, a missing Work stays
  // unknown, and neither inherits this turn's original success.
  const status=work?(work.status||'unknown'):'unknown';
  const statusLabel=work?(workStateLabels[work.status]||String(work.status)):'状态未知';
  let text;
  if(route.action==='dispatch')text=route.hostContinuation?.bugId&&job?.maintenanceBugId===route.hostContinuation.bugId?'已通过系统临时恢复交接给 Worker · 源码问题仍待修复，后续执行以 Worker 记录为准。':'已交接给 Worker，后续执行以 Worker 记录为准。';
  else if(route.action==='continue')text=route.queued?'补充输入已登记到原工作，不另建任务。':'补充输入已交给原 Worker，继续原任务。';
  else if(route.action==='clarify'){
   const question=Array.isArray(state?.todos)?state.todos.find(todo=>todo.kind==='routing'&&todo.sourceJobId===job.id):null;
   text=(route.question||'主控已提出澄清问题')+(question?.status==='open'?'（待补充信息）':question?'（该问题已有后续处理）':'（回答状态未加载）');
  }
  else if(route.action==='cancel')text='已接受撤销请求'+(name?'：“'+name+'”':'')+'；实际终止与处置以该工作当前状态为准，不视为已完成。';
  else text='已执行任务板状态查询；本轮未派工。';
  handoff={action:route.action,workId:route.workId??null,name,text,status,statusLabel};
 }
 return {execution,activity,handoff};
}
