// Host state only: model prose is historical, never a completion receipt.
export function closurePresentation(work){
  if(!['closing','ended'].includes(work?.status))return null;
  const c=work.closure||{},g=c.git,complete=c.phase==='complete';
  const decision=work.outcome||c.decision;
  const rows=[
    {stage:'decision',text:decision==='accept'?'用户已接受成果并结束业务工作':decision==='discard'?'用户已丢弃成果并结束业务工作':'历史结束记录，成果处置未明确'},
    {stage:'report',text:c.report?'报告已持久保存，历史仍可阅读':'报告归档尚未确认'},
    {stage:'git',text:g?.status==='merged'?'成果已安全合入'+(g.commit?'：'+g.commit:''):g?.status==='discarded'?'成果已按用户决定丢弃':decision==='accept'?'成果合入尚未确认':decision==='discard'?'成果丢弃尚未确认':'保留现有成果，等待明确处置'},
    {stage:'cleanup',text:complete?'技术收尾已完成，专用资源已清理':'技术收尾'+(c.phase==='blocked'?'受阻':'尚未完成')+'；业务工作不会重开，名额已释放'}
  ];
  return {summary:c.phase==='blocked'?'工作已结束；技术收尾受阻：'+(c.error?.message||c.error||'请查看原事项并重试'):complete?'工作已结束，技术收尾已完成':'工作已结束，技术收尾进行中（不代表合入或清理成功）',rows};
}
export function curationPresentation(work){
  if(work?.status!=='ended'||!work.curated||!work.curationText)return null;
  return {conclusion:work.curationConclusion||'历史归纳记录，可展开查看保存时的依据、限制和未完成事项；不代表当前技术收尾状态。',evidence:work.curationText};
}
