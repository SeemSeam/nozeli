import {createHash,randomUUID} from 'node:crypto';
import {renderArchifyDiagram} from './archify-diagram.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x1f]/.test(value);
const boundedCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value)?value:null;
const categories=new Set(['schema','layout','guided-view','relationship','engineering-profile','brand','type','spec','policy','render-output','output-size','validation']);
const ruleCode=value=>typeof value==='string'&&value.length<=96&&/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(value)?value:null;
const deny=(reason,message)=>{throw Object.assign(new Error(message??('图示恢复被拒绝：'+reason)),{code:'DIAGRAM_RECOVERY_DENIED',reason});};
const CONVERSATION_ROLES=['assistant','user','toolResult','tool'];
const textOf=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(block=>block?.type==='text').map(block=>block.text??'').join('\n'):'';
// 已知可自动恢复的遗留故障配方：runtime 阶段的宿主工具失败泛型码。
// 逐条枚举，绝不泛化到任意维修记录。
const LEGACY_RUNTIME_CODES=['HOST_TOOL_ERROR','PI_HOST_TOOL_FAILED'];
const DECISION_FENCES=['problem','merge-consent','merge-constraint','deviation','permission'];
// 终检窗口：同线程其后允许翻阅的原生记录上限，超出即拒绝而不是猜测。
const THREAD_WINDOW=512;

/**
 * Durable recovery for legacy diagram-validation failures.
 *
 * Safety is proven only from immutable native history plus a pure re-render of
 * the exact archived arguments: the final assistant tool call must be a single
 * nozeli_diagram call, its matching archived toolResult must be the terminal
 * conversation record of the original thread with isError, and re-running the
 * offline renderer must fail with the typed DIAGRAM_INPUT_INVALID validation
 * failure (closed vocabulary, effect none). Generic job.error text alone never
 * proves safety.
 */
export class DiagramRecovery{
  constructor(controller,{render=renderArchifyDiagram}={}){
    this.controller=controller;
    this.render=render;
  }
  /**
   * Recover one maintenance bug. The original job stays failed history; exactly
   * one bound supplement is queued in the original Work/thread/revision, and a
   * unique receipt is persisted on the original job before the kick. Repeat,
   * concurrent or cold recoveries read that receipt and never queue twice.
   */
  async recover(bugId,{expectedRevision,requestKey,explicit=false}={}){
    const controller=this.controller,store=controller.store;
    if(!identity(bugId))deny('unknown-bug');
    if(requestKey!=null&&!identity(requestKey))deny('invalid-request-key');
    if(expectedRevision!=null&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<1))deny('invalid-revision');
    const bug=(await controller.maintenance.read()).bugs.find(row=>row.id===bugId&&row.projectId===controller.projectId);
    if(!bug)deny('unknown-bug','未知或跨项目的维修记录');
    const priorJob=store.state.jobs.find(job=>job.id===bug.jobId),prior=priorJob?.diagramRecovery;
    if(prior?.bugId===bug.id){
      // 回执重放先核对原始身份：账本只能结算这份回执对应的原故障。
      if(prior.workId!==(bug.workId??null)||priorJob.target!==prior.workId||(prior.revision??null)!==(bug.revision??null)||(priorJob.revision??null)!==prior.revision)deny('receipt-stale');
      if(requestKey!=null&&prior.requestKey!=null&&prior.requestKey!==requestKey)deny('request-key-conflict');
      const settled=await this.#settle(bug,prior);
      return {recovered:true,alreadyRecovered:true,bugId:bug.id,jobId:prior.jobId,workId:prior.workId,revision:prior.revision,receiptId:prior.id,supplementJobId:prior.supplementJobId??null,...settled};
    }
    if(prior)deny('already-recovered','原任务已接受过一次图示恢复');
    if(['cancelled','human-boundary'].includes(bug.status))deny('bug-closed');
    if(bug.phase!=='runtime'||!LEGACY_RUNTIME_CODES.includes(String(bug.error?.code??'')))deny('unknown-recipe','仅恢复已知的遗留图示校验故障配方');
    try{store.storage?.assertActive?.(controller.projectId);}catch{deny('lifecycle-held');}
    const job=store.state.jobs.find(row=>row.id===bug.jobId);
    if(!job)deny('original-job-missing');
    if(job.status!=='failed')deny(job.status==='cancelled'?'original-job-changed':'original-job-not-failed');
    if(job.maintenanceBugId!==bug.id)deny('maintenance-binding','原任务未绑定该维修记录');
    const work=store.state.works.find(row=>row.id===job.target);
    if(!work)deny('original-work-missing');
    if(!identity(bug.workId)||bug.workId!==job.target||work.id!==job.target)deny('binding-mismatch','维修记录、原任务与 Work 身份不一致');
    if((job.revision??null)!==(bug.revision??null))deny('original-job-changed');
    if(expectedRevision!=null&&expectedRevision!==(job.revision??null))deny('stale-revision');
    if(controller.taskPermissions&&await controller.taskPermissions.heldFor(controller.projectId,job))deny('human-decision-required');
    const evidence=await this.#evidence(job,work);
    const rerun=await this.#rerun(evidence);
    const at=new Date().toISOString(),supplementKey='diagram-recovery:'+bug.id;
    const receipt={id:'diagram-recovery:'+randomUUID(),bugId:bug.id,requestKey:requestKey??null,explicit:explicit===true,at,jobId:job.id,workId:work.id,revision:bug.revision??null,threadId:evidence.sessionId,requestId:evidence.requestId,toolCallId:evidence.toolCallId,diagramType:evidence.type,assistantEntryId:evidence.assistantEntryId,toolResultEntryId:evidence.toolResultEntryId,assistantEntryDigest:evidence.assistantEntryDigest,toolResultEntryDigest:evidence.toolResultEntryDigest,specDigest:evidence.specDigest,originalErrorDigest:evidence.originalErrorDigest,originalErrorCode:evidence.originalErrorCode,rerun,supplementKey,supplementJobId:null,settledAt:null};
    const text=this.#supplementText(receipt);
    const current=await store.mutate(async()=>{
      const state=store.state,live=state.jobs.find(row=>row.id===bug.jobId),liveWork=state.works.find(row=>row.id===live?.target);
      const saved=live?.diagramRecovery;
      if(saved?.bugId===bug.id)return {receipt:saved};
      if(saved)deny('already-recovered');
      try{store.storage?.assertActive?.(controller.projectId);}catch{deny('lifecycle-held');}
      if(controller.stopping)deny('host-stopping');
      if(store.closed||store.lifecycleHold)deny('lifecycle-held');
      if(store.commitUnknown||store.nativeCommitUnknown)deny('storage-result-unknown');
      if(!live)deny('original-job-missing');
      if(live.status==='cancelled')deny('original-job-changed');
      if(live.status!=='failed')deny('original-job-not-failed');
      if((live.revision??null)!==(bug.revision??null))deny('original-job-changed');
      if(expectedRevision!=null&&expectedRevision!==(live.revision??null))deny('stale-revision');
      const attempts=live.collabAttempts??[],terminal=attempts.at(-1);
      if(attempts.some(attempt=>{
        if(!['unknown','transport-unknown','unresolved'].includes(attempt.status))return false;
        const last=attempt.facts?.at(-1);
        return !(attempt===terminal&&attempt.status==='unknown'&&attempt.recordConfirmed===true&&last?.status==='unknown'&&last.reason==='PI_HOST_TOOL_FAILED'&&live.errorCode==='PI_HOST_TOOL_FAILED'&&live.failureOrigin==='host'&&live.hostToolCode==='HOST_TOOL_ERROR'&&attempt.sessionId===evidence.sessionId&&attempt.requestId===evidence.requestId);
      }))deny('original-effect-unknown');
      // 冷启动的原失败任务只有在终次尝试已确认落档时才可恢复；效果未知一律拒绝。
      if(controller.coldJobs?.has(live.id)&&terminal?.recordConfirmed!==true)deny('original-effect-unknown');
      if(!liveWork)deny('original-work-missing');
      if(!identity(bug.workId)||bug.workId!==live.target||liveWork.id!==live.target)deny('binding-mismatch');
      if(liveWork.readOnly)deny('historical-read-only');
      if((liveWork.revision??null)!==(bug.revision??null))deny('original-work-changed');
      // 仅恢复被本故障维修暂停的 Work：标记与暂停状态必须同时精确成立。
      if(liveWork.maintenance?.bugId!==bug.id)deny('maintenance-binding','原 Work 未处于该维修记录造成的暂停');
      if(liveWork.status!=='paused')deny('work-not-paused');
      // 同 Work 不得有正在执行或排队的其他任务：恢复只接管静止的原线程。
      if(controller.current?.get(liveWork.id)||controller.running?.has(liveWork.id))deny('work-active');
      if(state.jobs.some(row=>row.target===liveWork.id&&row.id!==live.id&&['queued','running'].includes(row.status)))deny('work-active');
      // 原线程绑定：证据必须属于终次准入尝试与当前 Work 线程。
      if(!terminal||terminal.sessionId!==evidence.sessionId||terminal.requestId!==evidence.requestId||!attempts.some(attempt=>attempt.sessionId===evidence.sessionId&&attempt.requestId===evidence.requestId))deny('thread-mismatch');
      if(identity(liveWork.threadId)&&liveWork.threadId!==evidence.sessionId)deny('thread-mismatch');
      if(store.deviationHeld(liveWork.id))deny('deviation-held');
      if((state.todos??[]).some(todo=>todo.workId===liveWork.id&&todo.status==='open'&&DECISION_FENCES.includes(todo.kind)))deny('human-decision-required');
      if(liveWork.manualControl?.pause!=null||controller.workExecutionHeld(live))deny('manual-control-held');
      if(controller.handoffPreparing?.size||controller.residentHandoffs?.size||controller.handoffConfirmations?.size)deny('handoff-held');
      if(controller.taskPermissions&&await controller.taskPermissions.heldFor(controller.projectId,live))deny('human-decision-required');
      if(live.maintenanceBugId!==bug.id||controller.stopping||store.closed||store.lifecycleHold||store.commitUnknown||store.nativeCommitUnknown||liveWork.maintenance?.bugId!==bug.id||liveWork.status!=='paused')deny('maintenance-binding');
      // 回执先于入队落档：此后任何并发/重复/冷恢复都只读回执。
      live.diagramRecovery=receipt;
      const queued=controller.queueJob(liveWork.id,'supplement',text,{key:supplementKey,context:{sourceJobId:live.id,diagramRecoveryBugId:bug.id,diagramRecoveryReceiptId:receipt.id,diagramRecoveryRevision:receipt.revision,diagramRecoveryThreadId:receipt.threadId}});
      receipt.supplementJobId=queued.id;
      // 仅解除本故障造成的维修暂停：不递增 revision、不改线程、不结算任务成果。
      if(liveWork.maintenance?.bugId===bug.id){delete liveWork.maintenance;if(liveWork.status==='paused')liveWork.status='running';}
      for(const todo of state.todos??[])if(todo.sourceJobId===live.id&&todo.status==='open'&&['system','recovery'].includes(todo.kind)){todo.status='resolved';todo.resolution={kind:'diagram-recovery',bugId:bug.id,receiptId:receipt.id,at};}
      return {receipt};
    });
    const settled=await this.#settle(bug,current.receipt);
    controller.changed();controller.kick();
    return {recovered:true,bugId:bug.id,jobId:current.receipt.jobId,workId:current.receipt.workId,revision:current.receipt.revision,receiptId:current.receipt.id,supplementJobId:current.receipt.supplementJobId,...settled};
  }
  /** Auto-recover only the known legacy recipe; never a generic bug sweep. */
  async scan(){
    const controller=this.controller,ledger=await controller.maintenance.read(),recovered=[],denied=[];let considered=0;
    for(const bug of ledger.bugs){
      if(bug.projectId!==controller.projectId||bug.phase!=='runtime'||!LEGACY_RUNTIME_CODES.includes(String(bug.error?.code??'')))continue;
      const committed=controller.store.state.jobs.find(row=>row.id===bug.jobId)?.diagramRecovery;
      if(committed?.bugId===bug.id&&!committed.settledAt){
        considered++;
        try{const result=await this.recover(bug.id);recovered.push({bugId:bug.id,jobId:result.jobId,workId:result.workId,receiptId:result.receiptId,supplementJobId:result.supplementJobId,alreadyRecovered:true,settled:result.settled});}
        catch(error){denied.push({bugId:bug.id,reason:error.code==='DIAGRAM_RECOVERY_DENIED'?error.reason:'unproven',code:boundedCode(error.code)??'INTERNAL_FAILURE'});}
        continue;
      }
      if(['repaired','finalizing','repairing','cancelled','human-boundary'].includes(bug.status)||!bug.jobId)continue;
      const job=controller.store.state.jobs.find(row=>row.id===bug.jobId);
      if(!job||job.status!=='failed'||job.maintenanceBugId!==bug.id)continue;
      const work=controller.store.state.works.find(row=>row.id===job.target);
      if(!work||work.maintenance?.bugId!==bug.id)continue;
      if(job.diagramRecovery?.bugId===bug.id&&job.diagramRecovery.settledAt)continue;
      considered++;
      try{
        const result=await this.recover(bug.id,{explicit:false});
        recovered.push({bugId:bug.id,jobId:result.jobId,workId:result.workId,receiptId:result.receiptId,supplementJobId:result.supplementJobId,alreadyRecovered:result.alreadyRecovered===true,settled:result.settled});
      }catch(error){
        // 拒绝按封闭原因归档；意外异常只记录有界代码，绝不被吞掉后继续。
        denied.push({bugId:bug.id,...(error.code==='DIAGRAM_RECOVERY_DENIED'?{reason:error.reason}:{reason:'unproven',code:boundedCode(error?.code)??'INTERNAL_FAILURE'})});
      }
    }
    return {considered,recovered,denied};
  }
  // Verified immutable archived entries scoped to the original job: the digest
  // check and entry identity live inside SessionIndex.object.
  async #evidence(job,work){
    const timeline=this.controller.timeline;
    const rows=timeline.records().filter(record=>record.jobId===job.id).sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id));
    if(!rows.length)deny('no-history','原任务没有可核验的原生历史');
    const load=async record=>{try{return await timeline.object(record);}catch(error){if(error.code==='TIMELINE_BUDGET')deny('evidence-too-large');throw error;}};
    let tail=null;
    for(let i=rows.length-1;i>=0;i--){
      const entry=await load(rows[i]),message=entry?.type==='message'?entry.message:null;
      if(message&&CONVERSATION_ROLES.includes(message.role)){tail={record:rows[i],message};break;}
    }
    if(!tail)deny('no-history');
    if(tail.message.role!=='toolResult'||tail.message.isError!==true)deny('wrong-tail','原回合最后的原生记录不是失败的工具结果');
    const callId=tail.message.toolCallId;
    if(!identity(callId))deny('wrong-tail','失败工具结果缺少精确调用标识');
    // 原线程自最终记录起必须静止：其他任务在同一原生线程上的后续对话
    // （无论归属哪个 job）都说明历史已前进，恢复不得覆盖。
    const later=timeline.records().filter(record=>record.sessionId===tail.record.sessionId&&record.sequence>tail.record.sequence).sort((a,b)=>a.sequence-b.sequence);
    if(later.length>THREAD_WINDOW)deny('evidence-window','原线程后续记录超出核验窗口');
    for(const record of later){
      const entry=await load(record),message=entry?.type==='message'?entry.message:null;
      if(message&&CONVERSATION_ROLES.includes(message.role))deny('wrong-tail','原线程在失败工具结果之后已有新的对话回合');
    }
    let turn=null;
    for(let i=rows.indexOf(tail.record)-1;i>=0;i--){
      const entry=await load(rows[i]),message=entry?.type==='message'?entry.message:null;
      if(!message||!CONVERSATION_ROLES.includes(message.role))continue;
      if(message.role!=='assistant'&&message.role!=='toolResult')deny('wrong-tail','工具结果之后存在其他对话回合');
      if(message.role==='assistant'){
        const calls=(Array.isArray(message.content)?message.content:[]).filter(block=>block?.type==='toolCall');
        if(calls.some(block=>block.id===callId)){turn={record:rows[i],message,calls};break;}
        deny('wrong-tail','失败工具结果不属于最近的助手回合');
      }
    }
    if(!turn)deny('wrong-tail','未找到发起该图示调用的助手回合');
    // 该助手回合必须恰好包含这一个 nozeli_diagram 调用：并行的未知兄弟
    // 工具调用可能被最后的图示调用掩盖，一律拒绝。
    const call=turn.calls[0];
    if(turn.calls.length!==1||!call||call.id!==callId||call.name!=='nozeli_diagram')deny(turn.calls.length===1&&call?.name!=='nozeli_diagram'?'wrong-tool':'parallel-calls','最后的助手工具调用不是唯一的 nozeli_diagram');
    if(turn.record.sessionId!==tail.record.sessionId)deny('thread-mismatch');
    const sessionId=tail.record.sessionId;
    const attempt=(job.collabAttempts??[]).findLast(row=>row.sessionId===sessionId&&row.requestId===tail.record.requestId);
    if(!attempt)deny('thread-mismatch','原生证据线程与原任务绑定不一致');
    if(identity(work.threadId)&&work.threadId!==sessionId)deny('thread-mismatch','原生证据线程与原 Work 线程不一致');
    const arguments_=call.arguments;
    if(!arguments_||typeof arguments_!=='object'||Array.isArray(arguments_)||typeof arguments_.type!=='string'||arguments_.spec==null||typeof arguments_.spec!=='object'||Array.isArray(arguments_.spec))deny('arguments-unusable','归档调用参数不是可重放的图示规范');
    const originalText=textOf(tail.message.content);
    if(!originalText)deny('error-unreadable','失败工具结果未携带结构化错误');
    let parsed=null;try{const value=JSON.parse(originalText);if(value&&typeof value==='object'&&!Array.isArray(value))parsed=value;}catch{}
    return {sessionId,requestId:tail.record.requestId??null,toolCallId:callId,type:arguments_.type,spec:arguments_.spec,assistantEntryId:turn.record.entryId,toolResultEntryId:tail.record.entryId,assistantEntryDigest:turn.record.objectId,toolResultEntryDigest:tail.record.objectId,specDigest:sha(JSON.stringify({type:arguments_.type,spec:arguments_.spec})),originalErrorDigest:sha(originalText),originalErrorCode:boundedCode(parsed?.code)};
  }
  // Pure re-render of the exact archived arguments. Only the typed validation
  // failure with effect none proves "no diagram effect"; anything else is an
  // unswallowed exception carried through cause.
  async #rerun({type,spec}){
    let failure=null;
    try{await this.render({type,spec});}
    catch(error){failure=error;}
    if(!failure)deny('rerun-rendered','原始参数当前可以渲染，无法证明原失败仅为输入校验');
    if(failure.code!=='DIAGRAM_INPUT_INVALID')throw Object.assign(new Error('图示重放未复现类型化校验失败'),{code:'DIAGRAM_RECOVERY_UNPROVEN',reason:'rerun-untyped',cause:failure});
    const evidence=failure.diagramEvidence;
    if(!evidence||typeof evidence!=='object'||evidence.tool!=='nozeli_diagram'||evidence.stage!=='validation'||evidence.effect!=='none')deny('rerun-evidence','重放失败缺少封闭词表的效果证据');
    // 回执只保存固定词表代码：未知代码丢弃，绝不透传任意文本。
    const rules=(Array.isArray(evidence.rules)?evidence.rules:[]).slice(0,64).map(rule=>({code:ruleCode(rule?.code),count:Number.isSafeInteger(rule?.count)&&rule.count>0?rule.count:0})).filter(rule=>rule.code!=null&&rule.count>0);
    const rerun={code:'DIAGRAM_INPUT_INVALID',tool:'nozeli_diagram',stage:'validation',effect:'none',category:categories.has(evidence.category)?evidence.category:'validation',rules};
    return {...rerun,rerunDigest:sha(JSON.stringify(rerun))};
  }
  #supplementText(receipt){
    const facts=JSON.stringify({category:receipt.rerun.category,rules:receipt.rerun.rules}).slice(0,1200);
    return (receipt.explicit?'用户已明确请求恢复原任务。':'宿主后台已核实原故障。')+'宿主已修正图示渲染失败分类：原回合最后的 nozeli_diagram 调用（toolCallId '+receipt.toolCallId+'，类型 '+receipt.diagramType+'）经不可变原生历史与纯渲染重放核实为 DIAGRAM_INPUT_INVALID 输入校验失败（stage=validation，effect=none），未产生任何图示或项目效果。原任务、原始输入与已执行效果全部保留；本消息不是新的用户授权或范围扩展，不得重放原请求。请在原任务范围内：依据本线程该工具结果中的原始校验证据修正图示规范（封闭词表证据：'+facts+'），重新渲染图示并完成原任务的剩余交付。';
  }
  // Ledger settlement records ONLY the corrected failure classification; the
  // task itself stays open. Failures here never duplicate the queued
  // supplement: the durable receipt makes every retry idempotent.
  async #settle(bug,receipt){
    if(receipt.bugId!==bug.id||receipt.jobId!==bug.jobId||receipt.workId!==(bug.workId??null)||(receipt.revision??null)!==(bug.revision??null))return {settled:false,settleError:{code:'DIAGRAM_RECEIPT_STALE'}};
    let settled=true,error=null;
    try{
      const fresh=(await this.controller.maintenance.read()).bugs.find(row=>row.id===bug.id&&row.projectId===this.controller.projectId);
      if(fresh&&!['repaired','cancelled','human-boundary'].includes(fresh.status))await this.controller.maintenance.finish(bug.id,{verified:true,outcome:'diagram-classification-corrected'});
      await this.controller.settleMaintenanceEvents(fresh??bug,'diagram-classification-corrected');
      if(!receipt.settledAt)await this.controller.store.mutate(()=>{const saved=this.controller.store.state.jobs.find(job=>job.id===receipt.jobId);if(saved?.diagramRecovery?.id===receipt.id)saved.diagramRecovery.settledAt=new Date().toISOString();});
    }catch(failure){settled=false;error={code:boundedCode(failure?.code)??'INTERNAL_FAILURE'};}
    return {...(settled?{settled}:{settled:false,settleError:error})};
  }
}
