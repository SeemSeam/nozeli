import {intakeRequestText,resultSettlementIssue,recordExcerpt,publicationIsCurrent,publicationOrdinal} from './managed-work-records.mjs';

// M3 查看保留进展：只读、有界的保留事实投影。它不是第二个生命周期或历史
// 存储——所有内容都来自 durable jobs/works/receipts/messages 账本，读取本
// 身不触发模型、不恢复、不重放。输出内容（报告正文/文件字节）绝不内嵌，
// 只给精确的既有只读 API 引用；截断一律显式标注，绝不静默吞掉。
export const WORK_PROGRESS_SCHEMA=1;
export const WORK_PROGRESS_BOUNDS={requestChars:6000,supplementChars:2000,errorChars:500,publications:8,supplements:10,files:12,excerptChars:160};

const statusLabels={queued:'排队中',running:'执行中',paused:'已暂停',review:'等待审阅',closing:'决定已记录 · 收尾未完成',ended:'已结束'};
const supplementStatusLabels={queued:'已接收，等待处理',running:'处理中',transferring:'转交中',failed:'处理失败',interrupted:'处理被中断',unknown:'完成状态待核查'};
const publicationKindLabels={result:'成果报告',problem:'问题报告',deviation:'偏离报告'};
const supplementStatuses=['queued','running','transferring','failed','interrupted','unknown'];

// 与 managed-work-records 相同的补充归属边界：目标是本 Work 的非首轮 job、
// 显式 boundWorkId、或路由为 continue 的输入。这是唯一归属判定，不建新账。
const supplementJob=(work,job)=>Boolean(job&&(job.target===work.id&&job.type!=='initial'||job.context?.boundWorkId===work.id||job.routing?.action==='continue'&&job.routing?.workId===work.id));
const supersededJob=(work,job)=>Number.isInteger(work.revision)&&Number.isInteger(job.revision)&&job.revision<work.revision;

const boundedText=(value,limit)=>{const text=String(value??'');return {text:text.slice(0,limit),truncated:text.length>limit};};

/**
 * Bounded retained-facts DTO for one Work. Pure projection of durable state:
 * never mutates its inputs, never infers success from transport errors, and
 * never claims unpreserved outputs are retained.
 */
export function workProgressFacts(state,work,{projectId=null}={}){
 const jobs=state.jobs||[],sourceJob=jobs.find(j=>j.id===work.sourceJob);
 // 原始请求以 durable 原文为准：Work 建账必存 request；缺失时回退到同一
 // 输入链的原文，绝不改写或概括后冒充原文。
 const requestRaw=typeof work.request==='string'&&work.request.trim()?work.request:sourceJob?intakeRequestText(state,sourceJob):'';
 const request=boundedText(requestRaw,WORK_PROGRESS_BOUNDS.requestChars);

 const publications=(state.receipts||[]).filter(r=>r.workId===work.id)
  .sort((a,b)=>(b.revision??0)-(a.revision??0)||String(b.at||'').localeCompare(String(a.at||'')))
  .slice(0,WORK_PROGRESS_BOUNDS.publications)
  .map(receipt=>{
   const current=publicationIsCurrent(state,work.id,receipt.objectId,receipt.kind);
   const historical=!current;
   const publicationNumber=publicationOrdinal(state,work.id,receipt.objectId,receipt.kind);
   const files=Array.isArray(receipt.snapshot?.files)?receipt.snapshot.files:[];
   const items=files.slice(0,WORK_PROGRESS_BOUNDS.files).map(file=>({relPath:file.relPath,size:file.size??null,open:{op:'artifact.read',args:{projectId,objectId:receipt.objectId,relPath:file.relPath}}}));
   return {
    receiptId:receipt.id,objectId:receipt.objectId,revision:receipt.revision??null,kind:receipt.kind,
    kindLabel:publicationKindLabels[receipt.kind]??receipt.kind,at:receipt.at??null,current,historical,publicationNumber,
    title:receipt.report?.title??null,excerpt:recordExcerpt(receipt.report?.excerpt??'',WORK_PROGRESS_BOUNDS.excerptChars),
    files:{items,total:files.length,omitted:Math.max(0,files.length-WORK_PROGRESS_BOUNDS.files),listOpen:{op:'artifact.list',args:{projectId,objectId:receipt.objectId}}},
    open:{op:'history.read',args:{projectId,objectId:receipt.objectId}},
    ...(receipt.kind==='result'?{reviewOpen:{op:'review.read',args:{projectId,workId:work.id,objectId:receipt.objectId}}}:{}),
   };
  });
 const publicationTotal=(state.receipts||[]).filter(r=>r.workId===work.id).length;

 const candidates=jobs.filter(job=>supplementJob(work,job)&&!supersededJob(work,job));
 const supplements=candidates.filter(job=>supplementStatuses.includes(job.status))
  .sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')))
  .slice(0,WORK_PROGRESS_BOUNDS.supplements)
  .map(job=>{
   const raw=job.type==='intake'||job.context?.userGoal||job.context?.sourceMessageId?intakeRequestText(state,job):job.text;
   const text=boundedText(raw,WORK_PROGRESS_BOUNDS.supplementChars);
   const retried=jobs.some(other=>other.context?.retryOf===job.id&&other.routing);
   const attempts=Array.isArray(job.collabAttempts)?job.collabAttempts:[];
   return {
    jobId:job.id,status:job.status,statusLabel:supplementStatusLabels[job.status]??job.status,
    kind:['failed','interrupted'].includes(job.status)?'failed':['queued','running','transferring'].includes(job.status)?'pending':'unconfirmed',
    at:job.at??null,finishedAt:job.finishedAt??null,
    text:text.text,truncated:text.truncated,
    error:typeof job.error==='string'&&job.error?boundedText(job.error,WORK_PROGRESS_BOUNDS.errorChars).text:null,
    interruptionReason:job.interruptionReason??null,
    ...(attempts.length?{transport:{attempts:attempts.length,lastStatus:attempts.at(-1)?.status??null,definitiveRejection:attempts.at(-1)?.definitiveRejection===true}}:{}),
    retried,
   };
  });
 const supplementTotal=candidates.filter(job=>supplementStatuses.includes(job.status)).length;

 // 未知效果只从 durable 事实推导，绝不预设“一切已保留”。首屏只用平实中文；
 // 内部状态码与原始错误串进 detail，由呈现层收进默认折叠的技术详情。
 const unverified=[];
 const settlement=resultSettlementIssue(state,work);
 if(settlement)unverified.push({code:'RESULT_SETTLEMENT_UNCONFIRMED',text:`最新报告已冻结保存，但发布这一轮的执行记录为${settlement.status==='unknown'?'未知':settlement.status==='failed'?'失败':'中断'}；完成状态待核查，未自动重放。`,...(settlement.error?{detail:boundedText(settlement.error,WORK_PROGRESS_BOUNDS.errorChars).text}:{})});
 const workJobs=jobs.filter(job=>job.target===work.id&&!supersededJob(work,job));
 const liveJobs=workJobs.filter(job=>['queued','running'].includes(job.status));
 const executing=liveJobs.some(job=>job.status==='running');
 if(work.status==='running'&&!liveJobs.length)unverified.push({code:'EXECUTION_UNCONFIRMED',text:'账面为执行中，但没有在册执行记录；实际是否仍在执行未确认。原请求与已发布内容保留，未发布的内容不作保留声明。'});
 // “执行中”只来自确切的在册 job；没有依据时按 managed-work-records 的保守
 // 措辞呈现，不把账面 running 当作真实执行。
 let statusLabel=statusLabels[work.status]??work.status;
 if(work.status==='running'&&!executing)statusLabel=!liveJobs.length?'执行状态待核查 · 原请求与已保存内容保留':liveJobs.some(job=>job.type==='initial')?'已接收，等待开始执行':'等待继续执行 · 进展已保留';
 if(work.execution?.candidate?.commit&&!(work.result?.objectId&&publications.some(p=>p.current&&p.kind==='result')))
  unverified.push({code:'UNPUBLISHED_CANDIDATE',text:'执行现场留有候选改动，尚未发布为报告；未经发布校验，不能视为已保留成果。',detail:'候选提交 '+String(work.execution.candidate.commit).slice(0,12)+'…'});
 if(work.needsReconciliation)unverified.push({code:'LEGACY_DISPOSITION_UNVERIFIED',text:'此工作带历史处置待核查标记；旧决定与证据保留，需核对后才能继续。'});
 const maintenanceOpen=Boolean(work.maintenance&&work.maintenance.status!=='repaired'&&work.closure?.phase!=='complete');
 const repairLive=maintenanceOpen&&jobs.some(j=>j.type==='maintenance'&&j.context?.bugId===work.maintenance.bugId&&['queued','running'].includes(j.status));
 if(maintenanceOpen)unverified.push({code:'MAINTENANCE_'+String(work.maintenance.status||'pending').toUpperCase().replace(/[^A-Z_]/g,'_'),text:(repairLive?'系统正在处理运行问题；':'系统运行问题待处理；')+'原请求与已发布内容保留，未确认的效果不自动修复。',detail:'维护状态 '+String(work.maintenance.status||'pending')});

 // U3-02 首屏“当前任务能否继续”：只由 durable 状态保守推导。维护未结束或
 // 任务暂停/已决定时，绝不承诺“采用或继续修改”——那些入口此刻不可用。
 const failedSupplement=supplements.find(s=>s.kind==='failed');
 const userInterrupted=candidates.some(j=>j.interruptionReason==='user-interrupted');
 let continuation;
 if(work.status==='ended')continuation={status:'ended',label:'任务已结束，不会再继续执行。'};
 else if(work.status==='closing')continuation={status:'decided',label:'任务已记录决定，正在收尾，不会再继续执行。'};
 else if(work.status==='review')continuation=settlement?{status:'verifying',label:'任务在等待你核对这一轮结果；完成状态待核查，核对前不要据此采用。'}
  :maintenanceOpen?{status:'held',label:'任务在等待审阅，但系统运行问题未处理完成；采用或发送以报告页实际状态为准。'}
  :{status:'reviewing',label:'任务在等待你审阅；请查看报告中的当前可用操作。'};
 else if(work.status==='queued')continuation={status:'queued',label:'任务在排队，尚未开始执行。'};
 else if(work.status==='paused')continuation=repairLive?{status:'system-handling',label:'当前任务暂不能继续处理；系统正在处理运行问题，但不代表任务会自动恢复。'}
  :maintenanceOpen?{status:'system-issue',label:'当前任务暂不能继续处理，也不会自动恢复。已有稿件可查看；你可以复制补充原文，或返回阅读。'}
  :userInterrupted?{status:'paused-by-user',label:'任务已按你的停止指令暂停，不会自动继续。'}
  :{status:'paused',label:'任务已暂停，不会自动继续。'};
 else if(work.status==='running'&&executing)continuation={status:'executing',label:'任务正在执行，当前回合尚未结束。'};
 else continuation={status:'unconfirmed',label:liveJobs.length?'任务等待继续执行，实际执行状态未确认。':'任务执行状态待核查；已保留内容不受影响。'};

 // 首屏平实要点：补充是否完成、哪些内容还在、任务能否继续；动作由呈现层
 // 就近给出（打开报告/文件、复制原文、返回阅读）。
 const currentPub=publications.find(p=>p.current);
 const notices=[];
 const failedCount=supplements.filter(s=>s.kind==='failed').length;
 if(failedCount)notices.push({key:'supplement',text:(failedCount===1?'这条补充未完成':'这 '+failedCount+' 条补充未完成')+'；原文已保留，可在此查看或复制。'});
 else if(supplements.some(s=>s.kind==='pending'))notices.push({key:'supplement',text:'有补充正在排队或处理，尚未完成。'});
 else if(supplements.some(s=>s.kind==='unconfirmed'))notices.push({key:'supplement',text:'有补充的完成状态待核查；未确认的效果不当作已完成。'});
 const retainedFiles=currentPub?.files?.total??0;
 if(currentPub)notices.push({key:'retained',text:'已发布的报告和文件仍可查看（当前版'+(currentPub.publicationNumber!=null?'：第 '+currentPub.publicationNumber+' 版':'')+(retainedFiles?' · '+retainedFiles+' 个文件':'')+'）。'});
 else if(publications.length)notices.push({key:'retained',text:'有 '+publications.length+' 份历史报告仍可查看；本轮还没有已发布的报告。'});
 else notices.push({key:'retained',text:'这项工作还没有已发布的报告；未列出的输出不作保留声明。'});
 notices.push({key:'continuation',text:continuation.label});

 // 安全、具体的下一步：只指向真实存在的入口，绝不提供无效“继续”。
 const steps=[];
 if(failedSupplement)steps.push('这条补充处理失败，失败原文收在该补充的“失败信息与传输记录”中；此入口不能自动核实或重启它。原文已保留，可在此查看或复制后回到阅读；是否重发由你决定，不会自动重放。');
 if(settlement)steps.push('先打开最新报告核对内容；这轮完成状态待核查，核查前不要据此采用。');
 const reviewAvailable=work.status==='review'&&work.readOnly!==true&&!settlement&&!maintenanceOpen;
 if(currentPub)steps.push(reviewAvailable?'打开最新报告与文件查看结论，再决定采用或继续修改。':'打开最新报告与文件查看已保留的结论；此入口只读，不提供采用或继续修改。');
 else if(publications.length)steps.push('打开已保留的历史报告核对内容；它们是旧一轮的冻结结果，不代表本轮最终交付。');
 if(work.status==='paused'&&userInterrupted&&!supplements.some(s=>s.kind==='pending')&&!maintenanceOpen)steps.push('本轮已按你的停止指令结束；查看或复制已保留材料后，发送新的补充再继续，或保持暂停。');
 if(work.status==='queued')steps.push('任务在排队，尚未开始执行；原请求已保留，开始后按顺序处理。');
 if(['closing','ended'].includes(work.status))steps.push('任务已记录决定'+(work.outcome==='accept'?'（已采用）':work.outcome==='discard'?'（已丢弃）':'（处置待核查）')+'；报告与证据保持可查看。');
 steps.push('此入口只读取已保留事实：不触发模型执行、不自动恢复、不重放。');
 const summary=failedSupplement?'这条补充未完成；原请求与已发布内容保留。'+continuation.label
  :settlement?'最新报告已保存；这一轮完成状态待核查。'
  :work.status==='review'?'成果报告待你审阅。'
  :publications.length?'已有保留的报告可查看。'
  :work.status==='queued'?'排队中，尚未开始执行；原请求已保留。'
  :'暂无已发布的报告；原请求已保留。';
 return {
  schema:WORK_PROGRESS_SCHEMA,projectId,workId:work.id,
  work:{name:work.name||recordExcerpt(requestRaw)||work.id,status:work.status,statusLabel,revision:Number.isSafeInteger(work.revision)?work.revision:null,readOnly:work.readOnly===true,outcome:work.outcome??null,endedAt:work.endedAt??null,threadId:work.threadId??null},
  request:{text:request.text,truncated:request.truncated,...(request.truncated?{note:`原文超过 ${WORK_PROGRESS_BOUNDS.requestChars} 字，此处截断显示；完整原文保留在任务记录中，可从原始任务或时间线打开。`}:{})},
  publications:{
   items:publications,total:publicationTotal,omitted:Math.max(0,publicationTotal-WORK_PROGRESS_BOUNDS.publications),
   note:publicationTotal?'以下为已冻结的发布内容：正文与文件不可变，可随时打开；未列出的输出不作保留声明。':'这项工作还没有已发布的报告。空列表不是丢失声明，也不能据此认为一切已保留。',
  },
  supplements:{items:supplements,total:supplementTotal,omitted:Math.max(0,supplementTotal-WORK_PROGRESS_BOUNDS.supplements)},
  unverified,
  next:{summary,notices,continuation,steps,autoResume:false},
  reads:{
   report:{op:'history.read',argsTemplate:{projectId,objectId:null}},
   currentReport:{op:'review.read',argsTemplate:{projectId,workId:work.id,objectId:null}},
   files:{op:'artifact.list',argsTemplate:{projectId,objectId:null}},
   file:{op:'artifact.read',argsTemplate:{projectId,objectId:null,relPath:null}},
  },
 };
}
