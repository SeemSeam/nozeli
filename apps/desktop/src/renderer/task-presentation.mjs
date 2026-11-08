import {managedWorkRecords} from '../domain/managed-work-records.mjs';
import {turnPresentation} from './session-presentation.mjs';
export function taskPresentation(row,state){
 const work=state?.works?.find(work=>work.id===row.workId);
 const records=managedWorkRecords(state||{});
 const record=records.find(record=>work?record.workId===work.id:record.jobIds?.includes(row.sourceJobId));
 const jobs=(state?.jobs||[]).filter(job=>work?job.target===work.id||record?.jobIds?.includes(job.id):record?.jobIds?.includes(job.id));
 const eligible=jobs.filter(job=>!record?.supersededJobIds?.includes(job.id)&&(!work||job.target!==work.id||job.revision==null||job.revision===work.revision));
 const latestRequest=eligible.at(-1);
 const activeJob=eligible.findLast(job=>job.status==='running'&&(!work||job.target===work.id)&&!job.context?.reviewDiscussion);
 const latest=activeJob||latestRequest;
 const turn=latest?turnPresentation([{jobId:latest.id}],state):null;
 const fault=!['closing','ended','review'].includes(work?.status)&&Boolean(record?.settlementIssue||!activeJob&&latest&&['failed','interrupted','unknown'].includes(latest.status)&&!latest.routing);
 const running=!fault&&!['queued','paused','review','closing','ended'].includes(work?.status)&&Boolean(activeJob)&&['thinking','toolrunning','output'].includes(turn?.status)&&!work?.manualControl?.pause;
 const revisions=[...new Set((state?.receipts||[]).filter(receipt=>receipt.workId===work?.id&&work).map(receipt=>receipt.revision).filter(revision=>revision!=null))].sort((a,b)=>a-b);
 const returns=jobs.filter(job=>job.routing?.action==='continue'||job.context?.reviewContinuation);
 const lastReturn=returns.at(-1);
 const publication=(state?.receipts||[]).findLast(receipt=>work&&receipt.workId===work.id&&receipt.kind==='result'&&receipt.objectId===work.result?.objectId)||(state?.receipts||[]).findLast(receipt=>work&&receipt.workId===work.id&&receipt.kind==='result')||null;
 return {name:record?.name||work?.name||'后台任务',label:record?.phase||'历史任务 · 当前状态不可用',latest:turn&&latest?.status==='running'?turn.label:record?.events?.at(-1)?.text||'尚无新的宿主事件',publication,status:fault?'error':work?.status||record?.status||'unknown',running,revision:work?.revision,trail:revisions.slice(-2).map(revision=>'修订 '+revision+' · 已发布'),returnKey:lastReturn?.id||null,returning:Boolean(lastReturn&&running),stage:work?.status==='review'?4:work?.status==='closing'||work?.status==='ended'?4:work?2:1};
}
