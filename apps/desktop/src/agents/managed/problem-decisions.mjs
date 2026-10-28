// 用户问题决定（managed.problem.resolve）：对最新 problem 报告的 approve/reject
// 都只是同一Work、同一线程、同一工作树上的续作准入——不是成果接受、结束、Git
// 或任何权限/管理员授予。经 managed.problem.resolve → loadLocal 的冷本地路径，
// 决定、审计与唯一续作队列先持久化，再由用户显式连接模型。
import {readStoredReport} from './report-descriptor.mjs';

const requestKeyPattern=/^[a-zA-Z0-9:_-]{8,160}$/;
const fail=(code,message,extra)=>{throw Object.assign(Error(message),{code,...extra});};
const identityString=({projectId,workId,objectId,revision,action,text})=>JSON.stringify([projectId,workId,objectId,revision,action,typeof text==='string'?text:'']);
// 授权口径：approve 把问题报告提出的方案（含其中明确写出的安装/命令等动作）
// 认定为用户已授权的本任务范围，同一已批准意图不再重复征询；操作系统级
// 凭据/提权认证是独立机制，不由本决定代替。reject 只承认反馈原文。
const approveNote='授权边界：用户已批准问题报告提出的处理方案，该方案（含其中明确写出的安装、命令等动作）即本任务内的用户授权范围，同一已批准意图不再重复征询；这不是全局、root 或所有命令的批准，操作系统级凭据/提权认证仍由宿主按真实机制独立执行。';
const rejectNote='授权边界：仅用户反馈原文是本轮新增授权来源；不因此授予全局、root 或所有命令权限，操作系统级凭据/提权认证仍由宿主按真实机制独立执行。';

export function validateProblemDecisionPayload(p){
  if(!p||typeof p!=='object'||Array.isArray(p))fail('INVALID_PROBLEM_DECISION','问题决定参数必须是对象');
  const word=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=200;
  if(!word(p.projectId)||!word(p.workId)||!word(p.objectId))fail('INVALID_PROBLEM_DECISION','问题决定的项目、工作或报告身份无效');
  if(!Number.isSafeInteger(p.revision)||p.revision<1)fail('INVALID_PROBLEM_DECISION','问题决定版本无效');
  if(!['approve','reject'].includes(p.action))fail('INVALID_PROBLEM_DECISION','问题决定动作必须是 approve 或 reject');
  if(p.text!==undefined&&typeof p.text!=='string')fail('INVALID_PROBLEM_DECISION','问题决定反馈必须是文本');
  if(typeof p.text==='string'&&p.text.length>32000)fail('INVALID_PROBLEM_DECISION','问题决定反馈过长');
  // 拒绝不是丢弃：必须携带用户反馈原文，作为续作的唯一新增授权来源。
  if(p.action==='reject'&&!(typeof p.text==='string'&&p.text.trim()))fail('INVALID_PROBLEM_DECISION','拒绝问题报告必须附带用户反馈原文');
  if(typeof p.requestKey!=='string'||!requestKeyPattern.test(p.requestKey))fail('INVALID_PROBLEM_DECISION','问题决定确认键无效');
}

// 与 deviationActions 同级的本地决定账本语义：同键同参（含反馈原文）跨重启返回
// 原回执——即使工作版本已前进；同键换参为碰撞，拒绝。
export async function resolveProblemDecision(controller,payload){
  validateProblemDecisionPayload(payload);
  const {projectId,workId,objectId,revision,action,requestKey}=payload;
  const text=typeof payload.text==='string'?payload.text:'';
  const identity=identityString({projectId,workId,objectId,revision,action,text});
  const result=await controller.store.mutate(async()=>{
    const s=controller.store.state;
    s.problemActions??=[];
    const old=s.problemActions.find(row=>row.requestKey===requestKey);
    if(old){
      if(old.identity!==identity)fail('PROBLEM_REQUEST_COLLISION','问题决定参数与该确认键首次使用不一致');
      return structuredClone(old.result);
    }
    const w=controller.store.find(workId);
    if(controller.deviationHeld(workId))fail('DEVIATION_HELD','用户必须先处理任务偏离决定');
    const stale=()=>fail('STALE_PROBLEM','问题报告已过期或工作状态已变化，请刷新后再决定');
    if(controller.stopping||w.status!=='paused'||w.revision!==revision)stale();
    // 偏离报告复用 problem 收据通道；其决定入口是 deviation.resolve，不在此受理。
    const receipt=s.receipts.findLast(r=>r.workId===workId&&r.kind==='problem');
    if(!receipt||receipt.deviation||receipt.objectId!==objectId||receipt.stale||receipt.revision!==revision)stale();
    if(w.problem?.objectId!==objectId||w.problem?.revision!==w.revision)stale();
    const sourceJobId=receipt.jobId??receipt.sourceJobId??null;
    const sourceJob=sourceJobId?(s.jobs||[]).find(j=>j.id===sourceJobId):null;
    // 来源回合必须可核实地绑定本工作与问题版本；缺失/错位/版本不符不授权续作。
    if(!sourceJob||sourceJob.target!==workId||sourceJob.revision!==receipt.revision)fail('PROBLEM_SOURCE_MISSING','问题来源回合缺失或不属于当前工作版本，不能据此续作');
    // 结算未知（job/transport unknown、未决敏感效果授权）不自动续作：返回具体
    // 核对入口，而不是笼统的“不能”。
    const recoveryTodo=(s.todos||[]).find(t=>t.kind==='recovery'&&t.sourceJobId===sourceJobId&&t.status==='open');
    const recovery=()=>({op:'managed.recovery.resolve',workId,revision:w.revision,sourceJob:sourceJobId,todoId:recoveryTodo?.id??null,inspectOp:'managed.worker.history'});
    if(sourceJob.status==='unknown'||(sourceJob.collabAttempts||[]).some(a=>a.status==='unknown'))
      fail('PROBLEM_SOURCE_UNKNOWN','问题来源回合结算未知，不能自动续作；请先显式核对原线程后再决定',{recovery:recovery()});
    if(await controller.taskPermissions?.heldFor(controller.projectId,sourceJob))
      fail('PROBLEM_SOURCE_UNKNOWN','问题来源回合仍有未决的敏感效果授权，不能自动续作；请先按待办显式决定后再续作',{recovery:recovery()});
    // 存储层与内存层同时判忙：job 状态可能瞬时 completed，执行中的回合以
    // running/starting/current/session busy 为准。
    if(controller.running?.has(workId)||controller.starting?.has(workId)||controller.current?.get(workId)||controller.sessions?.get(workId)?.busy===true||(s.jobs||[]).some(j=>(j.target===workId||j.context?.boundWorkId===workId)&&['queued','running','transferring'].includes(j.status)))fail('WORK_BUSY','此工作有待执行输入或正在执行；不能同时续作');
    const problemText=(await readStoredReport(controller.store,receipt)).toString('utf8');
    const at=new Date().toISOString();
    // 单事务完成：continueState（running+revision++、问题待办转已解决）+ 唯一续作
    // job + approvedScopes/审计。原问题收据与正文永不改写。
    const newRevision=controller.store.continueState(workId);
    const decision=action==='approve'
      ?{deviationId:`problem:${objectId}:${revision}`,sourceJobId,sourceText:problemText+(text.trim()?`\n\n用户批准说明（原文）：\n${text}`:''),at,revision:newRevision,problemObjectId:objectId}
      :{deviationId:`problem-reject:${objectId}:${revision}`,sourceJobId,sourceText:`用户拒绝问题报告中的处置方案，明确反馈（原文）：\n${text}`,at,revision:newRevision,problemObjectId:objectId};
    const body=action==='approve'
      ?'用户已在待办中批准问题报告提出的处理方案，继续同一Work按该方案执行剩余步骤。\n'+approveNote+'\n本决定不是成果接受，Work 不会因此结束；已完成操作不得重放。\n'+(text.trim()?`用户批准说明（原文）：\n${text}\n`:'')+'\n用户批准的处理方案原文（与任务锚点“用户明确批准的来源输入”一致，在本任务内按此执行）：\n'+problemText
      :'用户已在待办中拒绝问题报告提出的处理方案并给出反馈；不得按原方案执行，也不得重放已完成操作，按反馈继续同一Work。\n'+rejectNote+'\n本决定不是成果接受，Work 不会因此结束；用户反馈是本轮唯一新增授权来源。\n\n用户反馈（原文）：\n'+text+'\n\n问题报告原文（仅对照，未被批准）：\n'+problemText;
    const job=controller.queueJob(workId,'problem-resume',body,{key:`problem-resume:${objectId}:${revision}`,context:{problemObjectId:objectId,problemRevision:revision,problemDecisionAction:action,sourceJobId,...(sourceJob.context?.permissionTaskId?{permissionTaskId:sourceJob.context.permissionTaskId}:{})},priority:true});
    // approvedScopes 与既有 workerTaskAnchor 格式兼容：deviationId/sourceJobId/
    // sourceText/at/revision，锚点把来源作为“用户明确批准的来源输入”交付 Worker。
    w.approvedScopes??=[];w.approvedScopes.push(decision);
    const todo=(s.todos||[]).find(t=>t.workId===workId&&t.kind==='problem'&&t.objectId===objectId);
    if(todo)todo.resolution={kind:'problem-decision',action,text,at,revision:newRevision,jobId:job.id,requestKey};
    w.problemDecisions??=[];
    w.problemDecisions.push({objectId,revision,newRevision,action,text,at,jobId:job.id,requestKey});
    const value={accepted:true,workId,objectId,revision:newRevision,action,jobId:job.id,status:w.status};
    s.problemActions.push({requestKey,identity,result:structuredClone(value),at});
    return value;
  });
  controller.changed();controller.kick();
  return result;
}
