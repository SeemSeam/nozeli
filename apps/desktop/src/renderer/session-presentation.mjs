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
export const executionLabels=Object.freeze({queued:'排队中',starting:'启动中',thinking:'思考中',toolrunning:'工具执行中',waiting:'等待中',output:'输出中',completed:'已完成',failed:'失败',interrupted:'已中断',unknown:'状态未知',blocked:'受阻'});
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
export function turnPresentation(entries,state){
 const first=entries[0]||{},jobId=first.jobId;
 const job=state?.jobs?.find(job=>job.id===jobId||!jobId&&first.requestId&&job.collabAttempts?.some(attempt=>attempt.requestId===first.requestId&&attempt.sessionId===first.sessionId));
 const agent=job&&['running','transferring'].includes(job.status)?state?.agents?.find(agent=>agent.target===job.target&&(!first.sessionId||agent.threadId===first.sessionId)):null;
 let status='unknown';
 const deliveredWork=deliveredResultWork(first,job,state);
 const answered=job?.status==='completed'&&entries.some(entry=>entry.speaker==='agent'&&!entry.failed&&entry.status!=='failed'&&!entry.toolCalls?.length&&entry.complete&&hasReadableText(entry));
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
