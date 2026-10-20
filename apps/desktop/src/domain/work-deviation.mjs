export const deviationHeld=work=>work?.status!=='ended'&&['pending','replanned'].includes(work?.deviation?.status);
export function deviationPresentation(work){
 const d=work?.deviation;if(!d)return null;
 return {held:deviationHeld(work),phase:d.status==='replanned'?'已交主控重规划 · 原工作仍暂停':d.status==='pending'?'任务偏离 · 等待用户决定':'用户已授权继续',
  original:work.request||'',sourceText:d.sourceText||'',provenance:JSON.stringify({sourceJobId:d.sourceJobId,admittedJobId:d.admittedJobId,source:d.source??null,sourceContext:d.sourceContext??null,provenance:d.provenance??null},null,2),
  changedGoal:d.changedGoal||'',reason:d.reason||'',progress:d.progress||'',
  notExecuted:d.status==='replanned'?'触发输入已交主控重新分类；原 Work 未执行该输入，也未结束或认可成果。恢复原任务不会再次执行已转交输入。':'触发输入的变更尚未获用户授权执行；已有部分工作、报告及原会话保留。后续输入只保存排队，不解除暂停。',
  continueLabel:d.status==='replanned'?'仅恢复原始任务（不重放转交输入）':'确认在此 Work 处理这条输入',canReplan:d.status==='pending'};
}
