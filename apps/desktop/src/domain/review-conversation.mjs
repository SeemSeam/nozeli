// 审核讨论对话投影（纯函数；renderer 与测试共用，无 renderer/main 依赖）。
// 输入 = managed.review.discussion.read 的原始行，由调用方按 transcript 顺序
// 传入（跨 numeric 页合并后按 seq 排序）；本函数不重排、不改写、不生成摘要。
// 输出 = 共享 tag transcript 契约（discussion-thread.mountThreadTranscript）：
//  - context: Work 原始请求/主控交接，原文逐字折叠（label 仅作导航，绝不用
//    摘要替换原文）；
//  - entries: 真实回合与发布事件。回合 = 一个真实 job/请求身份下的用户问题
//    + 同回合 Worker 多段回复（保留原消息 id，绝不按正文去重、绝不邻近猜
//    测归属）+ 过程/工具记录折叠；发布事件按序内联，不是 AI 答复。
// 身份只认行上已证实字段（requestId/jobId/消息id），缺身份的行独立呈现，
// 绝不与相邻回合合并；跨页分界的同回合分段凭同一身份自然合并。
const CONTEXT_LABELS={ 'work-request':'原始请求','work-handoff':'主控交接' };
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x1f]/.test(value);
const PUBLICATION_LABELS={result:'发布结果报告',problem:'发布问题报告','host-diagnostic':'宿主诊断记录'};

/**
 * Project discussion rows into the shared tag transcript shape.
 * Pure: same rows in, same projection out; caller-owned ordering is preserved.
 * @param {Array<object>} rows discussion.read rows in transcript order.
 * @returns {{context:Array<object>,entries:Array<object>}}
 */
export function projectReviewConversation(rows){
 const context=[],entries=[];
 if(!Array.isArray(rows))return {context,entries};
 const byAlias=new Map(); // Work/原修订/req或job → 已证实的同一回合
 const seen=new Set();    // 跨页合并防御：同一消息id只呈现一次（精确身份去重）
 const alias=(kind,value,row)=>identity(value)?JSON.stringify([row.workId??null,row.revision??null,kind,value]):null;
 // 回合身份在首次出现时钉住（跨页合并保持 DOM key 稳定）：行上已证实的
 // requestId 优先，其次绑定 jobId，否则该行自身消息 id。
 const roundFor=row=>{
  const req=alias('req',row.requestId,row),job=alias('job',row.jobId,row);
  const found=(req&&byAlias.get(req))||(job&&byAlias.get(job))||null;
  if(found){if(req)byAlias.set(req,found);if(job)byAlias.set(job,found);return found;}
  const round={key:req||job||JSON.stringify([row.workId??null,row.revision??null,'message',row.id]),requestId:identity(row.requestId)?row.requestId:identity(row.jobId)?row.jobId:row.id,jobId:identity(row.jobId)?row.jobId:null,revision:row.revision??null,replyEntries:[],replyLabel:'AI助手'};
  if(req)byAlias.set(req,round);
  if(job)byAlias.set(job,round);
  entries.push(round);
  return round;
 };
 for(const row of rows){
  if(!row||typeof row.id!=='string'||!row.id||seen.has(row.id))continue;
  seen.add(row.id);
  if(row.source==='work-request'||row.source==='work-handoff'||row.source==='user-input'&&row.speaker==='orchestrator'){
   context.push({...row,label:CONTEXT_LABELS[row.source]||'主控交接'});
   continue;
  }
  if(row.source==='publication'){
   entries.push({requestId:'event:'+row.id,event:{id:row.id,label:PUBLICATION_LABELS[row.publication]||'发布记录',text:row.text??null,...(identity(row.objectId)?{objectId:row.objectId}:{}),...(Number.isInteger(row.publicationNumber)?{publicationNumber:row.publicationNumber}:{})}});
   continue;
  }
  if(row.speaker==='user'||row.speaker==='orchestrator'){
   const round=roundFor(row);
   if(round.question==null){
    round.question=row.text??'';round.questionId=row.id;
    round.questionLabel=row.speaker==='orchestrator'?'主控':'你';
    if(round.jobId==null&&identity(row.jobId))round.jobId=row.jobId;
    if(round.revision==null&&row.revision!=null)round.revision=row.revision;
   }else{
    // 防御：同一身份下出现第二条问题行时不合并、不改写，独立成回合。
    entries.push({requestId:row.id,jobId:identity(row.jobId)?row.jobId:null,revision:row.revision??null,question:row.text??'',questionId:row.id,questionLabel:row.speaker==='orchestrator'?'主控':'你',replyEntries:[],replyLabel:'AI助手'});
   }
   continue;
  }
  if(row.speaker==='worker'){
   const round=roundFor(row);
   if(round.jobId==null&&identity(row.jobId))round.jobId=row.jobId;
   if(round.revision==null&&row.revision!=null)round.revision=row.revision;
   round.replyEntries.push({...row});
   continue;
  }
  // 过程/工具/系统记录：有身份则折进同回合 processEntries；无身份独立成
  // 过程回合，绝不并入相邻回合，也绝不升级为 AI 答复。
  const round=roundFor(row);
  (round.processEntries??=[]).push({...row});
 }
 return {context,entries};
}
