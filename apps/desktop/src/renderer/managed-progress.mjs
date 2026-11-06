const phases={queued:'等待工作名额',running:'执行中',paused:'等待回答或处理',review:'等待结果审查',closing:'审核已决定 · 收尾未完成'};
export function managedProgress(state,target='frontdesk'){
  const jobs=state.jobs||[],works=(state.works||[]).filter(w=>w.status!=='ended'),draft=t=>Boolean(state.drafts?.[t]||state.nativeDraftTargets?.includes(t));
  const requests=jobs.filter(j=>['queued','running','transferring'].includes(j.status)&&(j.target===target||(target==='frontdesk'&&j.type==='intake'&&j.context?.frontJobId))).map(j=>{
    const text=j.status==='transferring'?'已接收转交，等待前台停稳':j.status==='queued'?(draft(j.target)?'已接收，等待未发送草稿处理':j.target==='frontdesk'?'已接收，等待前一条输入处理':j.target==='orchestrator'?'已接收，等待整理任务':'补充已接收，等待当前回合完成'):j.target==='frontdesk'?'已接收，正在理解请求':j.target==='orchestrator'?'正在整理任务':'执行中';
    return {id:j.id,text};
  });
  const queue=works.filter(w=>w.status==='queued');
  const visible=target==='frontdesk'?works:works.filter(w=>w.id===target);
  const rows=visible.map(w=>{
    const occupies=w.status!=='queued'&&w.revision>0;
    let phase=phases[w.status]||w.status;
    if(w.status==='queued')phase=`排队第 ${queue.findIndex(q=>q.id===w.id)+1} 位，等待工作名额`;
    else if(jobs.some(j=>j.target===w.id&&j.status==='queued'&&j.type!=='initial'))phase=draft(w.id)?'补充已接收，等待未发送草稿处理':w.status==='running'?'执行中，补充已排队':'补充已接收，等待执行';
    return {id:w.id,text:`${w.name||'工作'} · ${phase}${occupies?' · 占用名额':''}`,status:w.status};
  });
  const knownQuota=Number.isFinite(state.quotaUsed)&&Number.isFinite(state.limit);
  const summary=`${knownQuota?`工作名额 ${state.quotaUsed}/${state.limit}`:'工作名额未确认'}${queue.length?` · 排队 ${queue.length} 项`:''}${knownQuota&&state.quotaUsed>=state.limit?' · 新任务将排队':''}`;
  return {summary,requests,works:rows};
}
