// 人工任务控制（manual work control）：最小持久控制事实的纯状态层。
// 设计合同：docs/manual-task-control-repair-design.md §4-§6、§8-§9。
// 本模块只做 (a) 校验/去重身份，(b) 纯状态解析与迁移（调用方包在
// store.mutate 事务里），(c) 冷开纯暂停/恢复的分发（不创建 Controller）。
// 停止的精确 owner/退出确认由 Controller.workControl 负责；这里不碰原生进程。
import {createHash} from 'node:crypto';
import {Workspace} from './workspace.mjs';
import {managedRuntime} from './managed-storage.mjs';

export const WORK_CONTROL_ACTIONS = new Set(['pause', 'stop-current', 'resume']);
const REQUEST_KEY = /^[a-zA-Z0-9:_-]{8,160}$/;
const ID = /^[A-Za-z0-9-]{6,64}$/;
// 回执保留：完整响应快照只留最近若干条；更早的回执退化为持久墓碑
// （requestKey+意图摘要+结果），幂等证据永不静默丢弃。墓碑也满时对新
// 控制操作显式拒绝（fail-closed），不允许旧键在第16/第N次控制后重放执行。
const RECEIPT_LIMIT = 16;
const RETIRED_LIMIT = 256;
const fail = (code, message) => Object.assign(Error(message), {code});
const at = () => new Date().toISOString();

// ── 校验与意图身份 ───────────────────────────────────────────────
// CAS 必填：expectedControlVersion 恒必填（首次为0）；expectedWorkRevision
// 在目标是现有 Work 时必填（workId 载荷此处即可校验；jobId 绑定到 Work 时
// 由 applyWorkControlState 在解析后强制）。不允许调用方省略版本绕开CAS。
// requestKey 去重身份覆盖完整意图：项目+动作+目标+停止绑定+期望版本。
export function validateWorkControlPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('WORK_CONTROL_INVALID', '控制请求必须是对象');
  const {projectId, workId, jobId, action, expectedControlVersion, expectedWorkRevision, expectedProjectInstanceId, requestKey, ownerId, ownerGeneration, currentJobId} = payload;
  if (typeof projectId !== 'string' || !projectId.trim()) throw fail('WORK_CONTROL_INVALID', '缺少项目身份');
  if (workId === undefined && jobId === undefined) throw fail('WORK_CONTROL_INVALID', '需要 workId 或 jobId 之一');
  if (workId !== undefined && jobId !== undefined) throw fail('WORK_CONTROL_INVALID', 'workId 与 jobId 互斥');
  for(const [key,value] of [['workId',workId],['jobId',jobId],['currentJobId',currentJobId]])
    if(value!==undefined&&(typeof value!=='string'||!ID.test(value)))throw fail('WORK_CONTROL_INVALID', key+' 无效');
  for(const [key,value] of [['ownerId',ownerId],['ownerGeneration',ownerGeneration],['expectedProjectInstanceId',expectedProjectInstanceId]])
    if(value!==undefined&&(typeof value!=='string'||value.length>128||value.length<1))throw fail('WORK_CONTROL_INVALID', key+' 无效');
  if (!WORK_CONTROL_ACTIONS.has(action)) throw fail('WORK_CONTROL_INVALID', '控制动作无效');
  if (typeof requestKey !== 'string' || !REQUEST_KEY.test(requestKey)) throw fail('WORK_CONTROL_INVALID', '控制请求键无效');
  if (!Number.isSafeInteger(expectedControlVersion) || expectedControlVersion < 0) throw fail('WORK_CONTROL_INVALID', '必须携带当前人工控制版本 expectedControlVersion（首次为0）');
  if (expectedWorkRevision !== undefined && expectedWorkRevision !== null && (!Number.isSafeInteger(expectedWorkRevision) || expectedWorkRevision < 0)) throw fail('WORK_CONTROL_INVALID', '工作版本无效');
  if (workId !== undefined && (expectedWorkRevision === undefined || expectedWorkRevision === null)) throw fail('WORK_CONTROL_INVALID', '目标是现有 Work 时必须携带 expectedWorkRevision');
  // 变更操作必须绑定当前项目实例：同projectId重新登记（新instanceId）后，
  // 旧实例的请求零变更直接拒绝，不允许跨incarnation改动（P1审核项）。
  if (typeof expectedProjectInstanceId !== 'string' || !expectedProjectInstanceId.trim()) throw fail('WORK_CONTROL_INVALID', '必须携带 expectedProjectInstanceId（来自 work.control.status 的 projectInstanceId）');
  if (action === 'stop-current' && currentJobId !== undefined && ownerId === undefined) throw fail('WORK_CONTROL_INVALID', '停止当前执行需绑定 owner');
  const intent = {projectId, action, requestKey, expectedControlVersion, expectedWorkRevision: expectedWorkRevision ?? null, expectedProjectInstanceId,
    ...(workId !== undefined ? {workId} : {}), ...(jobId !== undefined ? {jobId} : {}),
    ...(ownerId !== undefined ? {ownerId} : {}), ...(ownerGeneration !== undefined ? {ownerGeneration} : {}), ...(currentJobId !== undefined ? {currentJobId} : {})};
  intent.intentDigest = controlIntentDigest(intent);
  return intent;
}
export function controlIntentDigest(intent) {
  return createHash('sha256').update(JSON.stringify([intent.projectId, intent.action, intent.workId ?? null, intent.jobId ?? null, intent.ownerId ?? null, intent.ownerGeneration ?? null, intent.currentJobId ?? null, intent.expectedControlVersion, intent.expectedWorkRevision, intent.expectedProjectInstanceId])).digest('hex');
}
export async function currentProjectInstanceId(getProjectRecord, projectId) {
  const record = await getProjectRecord(projectId);
  return record?.instanceId ?? null;
}
export function assertProjectInstance(expected, current) {
  if (expected !== current) throw fail('WORK_CONTROL_INSTANCE_STALE', '项目实例已变化（重新登记/替换）；本次控制零变更，请刷新后按当前实例重试');
}

// ── 纯状态解析 ──────────────────────────────────────────────────
// jobId → 其绑定 Work：先 context.boundWorkId，再 sourceJob/inputs 来源。
// 不用空 Work ID 或任务名猜对象（§4.1）。
export function jobBoundWork(state, job) {
  if (!job) return null;
  const works = state.works ?? [];
  if (job.context?.boundWorkId) return works.find(w => w.id === job.context.boundWorkId) ?? null;
  // 普通 Worker job（initial/manual/补充）以 target=work.id 直接绑定；不先解析
  // target 会让已暂停 Work 的补充输入绕过人工门（P1审核项）。
  if (job.target && !['frontdesk', 'orchestrator'].includes(job.target)) {
    const direct = works.find(w => w.id === job.target);
    if (direct) return direct;
  }
  return works.find(w => w.sourceJob === job.id) ?? works.find(w => (w.inputs ?? []).some(i => i.sourceJobId === job.id)) ?? null;
}
export function resolveWorkControlTarget(state, {workId, jobId}) {
  if (workId !== undefined) {
    const work = (state.works ?? []).find(w => w.id === workId);
    if (!work) throw fail('WORK_CONTROL_TARGET_UNKNOWN', '目标工作不存在');
    return {work, job: null};
  }
  const job = (state.jobs ?? []).find(j => j.id === jobId);
  if (!job) throw fail('WORK_CONTROL_TARGET_UNKNOWN', '目标接收请求不存在');
  return {work: jobBoundWork(state, job), job};
}
// 人工执行门：只读布尔。true = 该 Work/接收 job 的人工暂停门生效。
export function workControlHeldFor(state, workOrJob) {
  if (workOrJob == null || typeof workOrJob !== 'object') return false;
  if ((state.works ?? []).includes(workOrJob)) return workOrJob.manualControl?.pause != null;
  const job = workOrJob;
  if (job.manualControl?.pause != null) return true;
  return jobBoundWork(state, job)?.manualControl?.pause != null;
}
// 闲owner回收区分（§9）：人工hold且从未准入的 queued job 不保护 owner。
export function heldNeverAdmitted(state, job) {
  if (!workControlHeldFor(state, job)) return false;
  return job.promptStartedAt == null && !(job.collabAttempts ?? []).some(a => a.everAdmitted || !a.definitiveRejection);
}
export function manualControlProjection(record) {
  const control = record?.manualControl;
  if (!control) return {controlVersion: 0, paused: false, stop: null};
  const stop = control.stop ? {state: control.stop.state, jobId: control.stop.jobId ?? null, ownerId: control.stop.ownerId ?? null, ownerGeneration: control.stop.ownerGeneration ?? null, at: control.stop.at ?? null, exit: control.stop.exit ?? null} : null;
  return {controlVersion: Number.isSafeInteger(control.version) ? control.version : 0, paused: control.pause != null, stop};
}

// 目标规范化：描述符 {workId}|{jobId}、字符串 id、或已存 Work/job 记录
// 统一转为描述符；job 记录/描述符保留原 job 身份（不折叠成 Work）。
export function workControlTargetDescriptor(state, workOrJob) {
  if(typeof workOrJob==='string'){
    if((state.works??[]).some(w=>w.id===workOrJob))return {workId:workOrJob};
    if((state.jobs??[]).some(j=>j.id===workOrJob))return {jobId:workOrJob};
    throw fail('WORK_CONTROL_TARGET_UNKNOWN', '控制目标不存在');
  }
  if(workOrJob&&typeof workOrJob==='object'&&!Array.isArray(workOrJob)){
    if((state.works??[]).includes(workOrJob))return {workId:workOrJob.id};
    if((state.jobs??[]).includes(workOrJob))return {jobId:workOrJob.id};
    if(typeof workOrJob.workId==='string'&&workOrJob.workId)return workOrJob.jobId?fail('WORK_CONTROL_INVALID','workId 与 jobId 互斥'):{workId:workOrJob.workId};
    if(typeof workOrJob.jobId==='string'&&workOrJob.jobId)return {jobId:workOrJob.jobId};
  }
  throw fail('WORK_CONTROL_TARGET_UNKNOWN', '控制目标不存在');
}
// ── 能力投影（纯读；冷开/离线安全，不建 Controller/owner） ─────────
// stopCurrent 语义：完整停止需 live owner 可核验（§8）；冷开（live=false）
// 不提供停止按钮——冷停止只保留安全暂停（dispatchWorkControl 对冷 stop-current
// 返回 WORK_CONTROL_OWNER_UNAVAILABLE，绝不为了按钮自动连接项目）。
export function workControlCapabilitiesFromState(state, workOrJob, {projectId = null, projectInstanceId = null, live = false, storageUnknown = false, lifecycleHeld = false, ownerBinding = null} = {}) {
  const target = resolveWorkControlTarget(state, workControlTargetDescriptor(state, workOrJob));
  const work = target.work, control = (work ?? target.job)?.manualControl ?? null;
  const paused = control?.pause != null;
  const version = Number.isSafeInteger(control?.version) ? control.version : 0;
  const workStatus = work?.status ?? null;
  const ended = workStatus === 'ended' || workStatus === 'closing';
  const readOnly = work?.readOnly === true || work?.readOnly === 1;
  const reason = (condition, code) => condition ? code : null;
  const pause = {allowed: !paused && !ended && !storageUnknown && !lifecycleHeld,
    reason: reason(paused, 'already-held') ?? reason(ended, workStatus === 'ended' ? 'work-ended' : 'work-closing') ?? reason(storageUnknown, 'storage-unknown') ?? reason(lifecycleHeld, 'lifecycle-held') ?? null};
  const stopCurrent = {allowed: !ended && !storageUnknown && !lifecycleHeld && live,
    reason: reason(ended, workStatus === 'ended' ? 'work-ended' : 'work-closing') ?? reason(storageUnknown, 'storage-unknown') ?? reason(lifecycleHeld, 'lifecycle-held') ?? reason(!live, 'owner-unavailable') ?? null};
  const resume = {allowed: paused && !ended && !storageUnknown && !lifecycleHeld && !readOnly,
    reason: reason(ended, 'work-ended') ?? reason(readOnly, 'read-only') ?? reason(storageUnknown, 'storage-unknown') ?? reason(lifecycleHeld, 'lifecycle-held') ?? reason(!paused, 'not-held') ?? null};
  return {schema: 1, projectId, projectInstanceId, workId: work?.id ?? null, jobId: target.job?.id ?? null, workRevision: work?.revision ?? null,
    controlVersion: version, paused, pause, stopCurrent, resume, stop: manualControlProjection(work ?? target.job).stop,
    binding: ownerBinding, live: Boolean(live)};
}

// ── 纯状态迁移（调用方必须在 store.mutate 事务内调用） ─────────────
// 暂停只设置执行门，不改 Work 业务状态/revision（§4.1）。
// 回执带完整响应快照：同键同完整意图永远原样重放（崩溃后仍可读）。
export function applyWorkControlState(state, intent) {
  const target = resolveWorkControlTarget(state, intent);
  const holder = target.work ?? target.job;
  const existing = findControlReceipt(state, intent.requestKey);
  if (existing) {
    if (existing.intentDigest !== intent.intentDigest) throw fail('WORK_CONTROL_REQUEST_CONFLICT', '此控制请求键已按另一意图处理');
    return {deduped: existing, holder, target};
  }
  const work = target.work;
  if (work && ['ended', 'closing'].includes(work.status)) throw fail('WORK_ENDED', work.status === 'ended' ? '工作已结束，控制动作不再适用' : '工作正在收尾，控制动作不再适用');
  // jobId 绑定到现有 Work 时同样强制 workRevision CAS；无 Work 的接收 job
  // 不接受多余的 workRevision（防错绑）。
  if (work && intent.expectedWorkRevision == null) throw fail('WORK_CONTROL_INVALID', '目标已绑定 Work，必须携带 expectedWorkRevision');
  if (!work && intent.expectedWorkRevision != null) throw fail('WORK_CONTROL_INVALID', '接收请求尚未生成 Work，不能携带 expectedWorkRevision');
  const control = holder.manualControl ??= {version: 0, pause: null, stop: null, receipts: [], retired: []};
  if (intent.expectedControlVersion !== control.version) throw fail('STALE_CONTROL_VERSION', '人工控制版本已变化，请刷新核对（当前 ' + control.version + '）');
  if (work && intent.expectedWorkRevision !== work.revision) throw fail('STALE_WORK_REVISION', '工作 revision 已变化，请刷新核对');
  // 幂等证据容量：墓碑也满时拒绝新控制操作；既有键的重放不受影响。
  if ((control.retired?.length ?? 0) >= RETIRED_LIMIT && (control.receipts?.length ?? 0) >= RECEIPT_LIMIT) throw fail('WORK_CONTROL_RECEIPT_CAPACITY', '此目标的控制回执容量已满；请先归档清理后再发起新控制操作');
  const now = at();
  let outcome, paused, stop = null;
  if (intent.action === 'pause') {
    control.pause = {requestKey: intent.requestKey, at: now};control.version++;paused = true;outcome = 'held';
  } else if (intent.action === 'stop-current') {
    control.pause = {requestKey: intent.requestKey, at: now};
    // 新停止请求保留旧停止操作的最终事实（有界）：不凭空复造 requested，
    // 也不丢失已确认/未确认/过期结果（P2审核项）。
    if (control.stop) {
      control.stopHistory ??= [];
      control.stopHistory.push({requestKey: control.stop.requestKey, state: control.stop.state, jobId: control.stop.jobId ?? null, at: control.stop.at ?? null, exit: control.stop.exit ?? null});
      if (control.stopHistory.length > 8) control.stopHistory.splice(0, control.stopHistory.length - 8);
    }
    control.stop = {state: 'requested', requestKey: intent.requestKey, jobId: intent.currentJobId ?? target.job?.id ?? null, ownerId: intent.ownerId ?? null, ownerGeneration: intent.ownerGeneration ?? null, at: now, exit: null};
    control.version++;paused = true;outcome = 'stop-requested';
  } else {
    paused = false;
    // 恢复清除该 Work 的门，也清除“接收 job 先落门、Work 生成时继承”的
    // job 级门；否则旧接收 job 会继续挡住自己的准入。
    if (work) for (const j of state.jobs ?? []) {
      if (j.manualControl?.pause != null && jobBoundWork(state, j)?.id === work.id) {
        j.manualControl.pause = null;j.manualControl.version = (j.manualControl.version ?? 0) + 1;
      }
    }
    if (control.pause != null) {control.pause = null;control.version++;outcome = 'released';} else outcome = 'noop';
  }
  const receipt = {requestKey: intent.requestKey, action: intent.action, intentDigest: intent.intentDigest, at: now, controlVersion: control.version, outcome, workId: work?.id ?? null, jobId: target.job?.id ?? null, final: null, response: null};
  control.receipts ??= [];control.receipts.push(receipt);
  if (control.receipts.length > RECEIPT_LIMIT) {
    // 退化为持久墓碑：只留去重身份与结果（含最终处置事实），不留响应快照；
    // 证据不丢弃（P2审核项）。
    const evicted = control.receipts.splice(0, control.receipts.length - RECEIPT_LIMIT);
    control.retired ??= [];
    for(const old of evicted)control.retired.push({requestKey: old.requestKey, intentDigest: old.intentDigest, action: old.action, at: old.at, controlVersion: old.controlVersion, outcome: old.outcome, final: old.final ?? null, workId: old.workId ?? null, jobId: old.jobId ?? null});
  }
  return {applied: true, controlVersion: control.version, paused, stop: control.stop ? structuredClone(control.stop) : null, outcome, receipt, holder, target};
}
// 停止等异步收尾的最终事实写回回执/墓碑：同键重放按真实最终结果重建，
// 不完整的durable回执报告“未决”，绝不复造已完成的held/confirmed结果。
export function recordControlFinal(state, holder, requestKey, final) {
  const control = holder?.manualControl;
  if (!control) return;
  const receipt = [...(control.receipts ?? []), ...(control.retired ?? [])].find(r => r.requestKey === requestKey);
  if (receipt) receipt.final = structuredClone(final);
}
export function findControlReceipt(state, requestKey) {
  for (const w of state.works ?? []) {
    for (const r of w.manualControl?.receipts ?? []) if (r.requestKey === requestKey) return r;
    for (const r of w.manualControl?.retired ?? []) if (r.requestKey === requestKey) return r;
  }
  for (const j of state.jobs ?? []) {
    for (const r of j.manualControl?.receipts ?? []) if (r.requestKey === requestKey) return r;
    for (const r of j.manualControl?.retired ?? []) if (r.requestKey === requestKey) return r;
  }
  return null;
}
export function attachControlResponse(state, holder, requestKey, response) {
  const receipt = (holder?.manualControl?.receipts ?? []).find(r => r.requestKey === requestKey);
  if (receipt) receipt.response = structuredClone(response);
}
// 维修成功后不把人工暂停的 job 自行置回可执行（§6.3.3）：维修收尾只落
// resumeRequeue 标记；用户显式恢复时在同一事务里按原身份重新准入一次。
export function processResumeRequeueState(state, work) {
  if (!work || ['ended', 'closing'].includes(work.status)) return [];
  const requeued = [];
  for (const j of state.jobs ?? []) {
    const marker = j.resumeRequeue;
    if (!marker || j.status !== 'failed') continue;
    if (j.target !== work.id && j.context?.boundWorkId !== work.id) continue;
    if (j.promptStartedAt != null || (j.collabAttempts ?? []).some(a => a.everAdmitted || !a.definitiveRejection)) {delete j.resumeRequeue;continue;}
    if (marker.workRevision !== work.revision) {delete j.resumeRequeue;continue;}
    delete j.resumeRequeue;delete j.maintenanceBugId;delete j.error;j.status = 'queued';
    if (work.status === 'paused') work.status = 'running';
    requeued.push(j.id);
  }
  return requeued;
}
// 冷开（未连接项目）的恢复处置：不重放（§7.4），只报告需要打开项目核对。
export function coldResumeDisposition(state, work) {
  if (work && ['ended', 'closing'].includes(work.status)) return {kind: 'ended', reason: work.status, jobId: null};
  const pending = boundPendingJobs(state, work);
  if (pending.length) return {kind: 'unsupported-cold-recovery', reason: 'project-not-live', jobId: pending[0].id};
  return {kind: 'no-pending-input', reason: 'no-admissible-input', jobId: null};
}
export function boundPendingJobs(state, work) {
  if (!work) return [];
  return (state.jobs ?? []).filter(j => (j.target === work.id || j.context?.boundWorkId === work.id) && ['queued', 'running'].includes(j.status));
}

// ── 冷开纯暂停/恢复分发：合法离线存储上的持久控制（§8），零 Controller ──
export async function dispatchWorkControl(manager, payload) {
  const intent = validateWorkControlPayload(payload);
  const controller = manager.controllers?.get(intent.projectId);
  if (controller) {
    if (controller.stopping) throw fail('WORK_CONTROL_LIFECYCLE', '项目正在停用，控制动作稍后再试');
    return controller.workControl(intent);
  }
  if (intent.action === 'stop-current') throw fail('WORK_CONTROL_OWNER_UNAVAILABLE', '项目未连接，无法核验当前 owner；可先暂停（pause），停止需连接后执行');
  const host = manager.host;
  const project = await host.requireRegisteredProject(intent.projectId); // 只要求已登记，不连接
  // 实例闸门（P1）：变更前核当前登记实例；open 有 await，事务前再核一次。
  assertProjectInstance(intent.expectedProjectInstanceId, project?.instanceId ?? null);
  const store = await Workspace.open(await managedRuntime(host.storage, intent.projectId), project.root, {recoverStale: true, storage: host.storage, projectId: intent.projectId});
  try {
    const current = await host.requireRegisteredProject(intent.projectId);
    assertProjectInstance(intent.expectedProjectInstanceId, current?.instanceId ?? null);
    return await store.mutate(() => {
      const result = applyWorkControlState(store.state, intent);
      if (result.deduped) return result.deduped.response ?? null;
      // 冷恢复不处理 resumeRequeue 标记（标记只在 live 恢复里按原身份准入），
      // 也不重放任何排队输入；处置如实报告 project-not-live。
      const work = result.target.work;
      const disposition = intent.action === 'pause' ? {kind: 'held', reason: 'manual-gate', jobId: null} : coldResumeDisposition(store.state, work);
      const response = buildControlResponse(intent, result, null, disposition, work);
      attachControlResponse(store.state, result.holder, intent.requestKey, response);
      return response;
    }) ?? replayFallback(intent, store.state);
  } finally {await store.close();}
}
// 极端窗口（回执已落、响应快照未落且进程退出）后的同键重放：从持久回执
// 重建等价响应；仅当墓碑/回执已不存在时为 null（调用方按新意图处理）。
function replayFallback(intent, state) {
  const receipt = findControlReceipt(state, intent.requestKey);
  if (!receipt) throw fail('WORK_CONTROL_REQUEST_CONFLICT', '此控制请求键的处理记录已不存在，请用新请求键重试');
  return receiptResponse(receipt, intent);
}
export function receiptResponse(receipt, intent) {
  const final = receipt.final ?? null;
  // 未决回执（final缺失）：门事实为真，但停止结果未落定 → 如实报告未确认；
  // 不复造 held/confirmed。resume 的门已释放是durable事实。
  let disposition, stop = null;
  if (final) {
    disposition = {kind: final.kind, reason: final.reason ?? null, jobId: final.jobId ?? null};
    if (final.stop) stop = structuredClone(final.stop);
  } else if (receipt.action === 'stop-current') {
    disposition = {kind: 'stopped-unconfirmed', reason: 'receipt-incomplete', jobId: null};
    stop = {state: 'unknown', jobId: null, ownerId: intent.ownerId ?? null, ownerGeneration: intent.ownerGeneration ?? null, at: receipt.at ?? null, exit: null};
  } else if (receipt.action === 'resume') disposition = {kind: 'no-pending-input', reason: 'receipt-recovered', jobId: null};
  else disposition = {kind: 'held', reason: 'receipt-recovered', jobId: null};
  return {schema: 1, projectId: intent.projectId, projectInstanceId: intent.expectedProjectInstanceId ?? null, workId: receipt.workId ?? intent.workId ?? null, jobId: receipt.jobId ?? intent.jobId ?? null, action: receipt.action, requestKey: intent.requestKey, controlVersion: receipt.controlVersion, workRevision: null,
    controlApplied: {applied: true, controlVersion: receipt.controlVersion, paused: receipt.action !== 'resume', stop},
    executionDisposition: disposition,
    receipt: {requestKey: receipt.requestKey, action: receipt.action, at: receipt.at ?? null, controlVersion: receipt.controlVersion, outcome: receipt.outcome ?? null, intentDigest: receipt.intentDigest ?? null}};
}
export function buildControlResponse(intent, result, stop, disposition, work) {
  return {schema: 1, projectId: intent.projectId, projectInstanceId: intent.expectedProjectInstanceId, workId: result.target.work?.id ?? null, jobId: result.target.job?.id ?? null,
    action: intent.action, requestKey: intent.requestKey,
    controlVersion: result.controlVersion, workRevision: work?.revision ?? null,
    controlApplied: {applied: true, controlVersion: result.controlVersion, paused: result.paused, stop},
    executionDisposition: disposition,
    receipt: {requestKey: intent.requestKey, action: intent.action, at: result.receipt?.at ?? null, controlVersion: result.controlVersion, outcome: result.outcome, intentDigest: intent.intentDigest}};
}
