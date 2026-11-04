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
