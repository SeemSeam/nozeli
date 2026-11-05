// Categories are a read-only projection of host facts, not additional task stages.
export function workRecordCategory(record,state,serviceState=null){
 const work=state.works?.find(w=>w.id===record.workId),jobs=state.jobs||[],job=jobs.findLast(j=>record.jobIds?.includes(j.id));
 if(work?.status==='ended')return 'ended';
 if(work?.status==='closing')return 'closing';
 if(serviceState||record.maintenance||record.backstage||record.settlementIssue||['failed','interrupted','unknown','blocked'].includes(record.status))return 'fault';
 if(work?.status==='review')return 'review';
 if(work?.status==='queued')return 'queued';
 if(work)return 'work';
 return job?.status==='running'?'orchestrating':'submitted';
}
export function workRecordControlTarget(record,state){
 if(record.workId)return {workId:record.workId,name:record.name};
 const job=state.jobs?.findLast(j=>record.jobIds?.includes(j.id));
 if(record.maintenance||['failed','interrupted','unknown','blocked'].includes(record.status))return null;
 return job?{jobId:job.id,name:record.name}:null;
}
// A service occurrence names the affected job, not every revision of its Work.
// Missing version evidence remains conservative; this never releases a fault.
export function workRecordServiceState(record,projectId,faults){
 const superseded=id=>record.supersededJobIds?.includes(id);
 for(const fault of faults){
  if(fault.state==='released')continue;
  const member=fault.projects?.find(p=>p.projectId===projectId);
  if(member&&(record.workId&&member.blockedWorks?.some(w=>w.workId===record.workId&&!superseded(w.jobId))||record.jobIds?.some(id=>!superseded(id)&&member.blockedJobs?.includes(id))))return fault.state==='releasing'?'恢复中':'等待服务';
 }
 return null;
}

// Queued Works wait for slots held by these exact Work states (domain facts).
export const workSlotCaptions = {
  running: '执行中',
  paused: '暂停',
  review: '待审',
  closing: '收尾未完成',
  'unverified-ended': '结束待核查',
  'unverified-running': '执行待核查',
};

// The end-Work confirmation must state the Work's real stage. A never-started
// queued Work has no Worker thread, worktree, report or results to discard.
export function workDispositionNotice({ work, binding, decision }) {
  const name = work?.name || binding?.workId || '任务';
  if (work?.status === 'queued' && Number(binding?.revision) === 0 && !work.threadId && !work.result?.objectId && !work.execution)
    return name + ' · 尚未开始执行，也没有生成成果。取消排队只撤销这次安排，不修改项目文件；原请求与历史记录保留。';
  return name + ' · 第 ' + binding.revision + ' 版：' + (decision === 'accept'
    ? '记录接受确切成果的决定，交由主控安全合入和清理。全部收尾确认完成后才结束；原报告、草稿和工作树保留。'
    : '记录丢弃未合入成果的决定，由主控清理专用工作树和分支，不能继续在原 Worker 修改；全部收尾确认完成后才结束。原项目文件、草稿与历史报告保留。');
}
